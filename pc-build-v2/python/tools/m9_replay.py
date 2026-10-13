"""Offline M9 replay: setup, fixed-badge rule (c), and the actual runtime.

Usage: m9_replay.py {setup|orient|runtime|autosetup} --manifest <external.json> --out <external-dir>
Manifest JSON: {"recordings": [{"key": "sample1", "path": "video.mp4",
"kind": "cheddar|ranked|spectate|long|language|toolbar|titlebar",
"vsOnsets": [4.6], "vsDuration": 1.9, "gameAspect": 0.5625,
"allowTrigger": true, "referenceBadge": {"cx": .493, "cy": .429,
"width": .22, "height": .149}, "referenceRegions": {"nickname":
[.054,.268,.921,.121]}, "expectedRect": [655,0,610,1080]}]}.
Paths are relative to the manifest. Reference badge/regions/rect are optional.
Sampling uses OpenCV at 0.1 s, not ffmpeg. --prototype-jpeg92 reproduces the
reference's in-memory JPEG q92 extraction without ever writing those frames.
All 17 measured distortions run by default (--distortions none for a quick run).
Results contain only numeric measurements and codes, never paths or pixels.
Only --overlays writes annotated frames, and only into the external output dir.
Runtime reproduces REPORT §8.5's 22 positive, six spectate and four blocked
aspect cases, then concatenates four source/target recordings with learning
enabled and checks cross-aspect spectate rejection. It requires the eight
REPORT recording keys and an external titlebar image. Pass --titlebar-image and
--titlebar-rect X Y WIDTH HEIGHT, or supply manifest runtime.titlebarImage and
runtime.titlebarRect. Titlebar crop coordinates are caller-owned evidence.
Runtime does not run the 17 fixed-badge distortions; it uses the REPORT resize,
border, same-canvas shrink and titlebar matrix instead. Autosetup uses the live engine.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
from itertools import chain
import json
from pathlib import Path
import sys
import time
from typing import Any, Callable
import uuid

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geometry.acceptance import accept
from geometry.game_rect import PixelRect, RectResult, detect
from geometry.vs_finder import MATCH_T, Candidate, VSConfirmer, search
from geometry.vs_orient_trigger import ORIENT_T, OrientationTrigger
from geometry.zones import Badge, regions
from trigger_engine import TemporalGate, TriggerEngine
from monitor_protocol import validate_start_payload
from auto_setup import AutoSetupEngine, DEADLINE_MS


def _hsv(image: np.ndarray, dh: int = 0, saturation: float = 1.0) -> np.ndarray:
    value = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    value[:, :, 0] = ((value[:, :, 0].astype(np.int16) + dh) % 180).astype(np.uint8)
    value[:, :, 1] = np.clip(value[:, :, 1].astype(np.float32) * saturation, 0, 255).astype(np.uint8)
    return cv2.cvtColor(value, cv2.COLOR_HSV2BGR)


def _channels(image: np.ndarray, blue: float, red: float) -> np.ndarray:
    value = image.astype(np.float32)
    value[:, :, 0] *= blue
    value[:, :, 2] *= red
    return np.clip(value, 0, 255).astype(np.uint8)


def _jpeg(image: np.ndarray, quality: int) -> np.ndarray:
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("Replay JPEG encoding failed")
    return cv2.imdecode(encoded, cv2.IMREAD_COLOR)


def distortions() -> dict[str, tuple[Callable[[np.ndarray], np.ndarray], float]]:
    def lut(fn: Callable[[float], float]) -> Callable[[np.ndarray], np.ndarray]:
        table = np.clip([fn(v) for v in range(256)], 0, 255).astype(np.uint8)
        return lambda image: cv2.LUT(image, table)
    return {
        "none": (lambda image: image, 1.0),
        "bright0.7": (lut(lambda v: v * .7), 1.0),
        "bright1.3": (lut(lambda v: v * 1.3), 1.0),
        "contrast0.7": (lut(lambda v: (v - 128) * .7 + 128), 1.0),
        "contrast1.3": (lut(lambda v: (v - 128) * 1.3 + 128), 1.0),
        "gamma0.7": (lut(lambda v: 255 * (v / 255) ** .7), 1.0),
        "gamma1.4": (lut(lambda v: 255 * (v / 255) ** 1.4), 1.0),
        "sat0": (lambda image: _hsv(image, saturation=0), 1.0),
        "sat1.5": (lambda image: _hsv(image, saturation=1.5), 1.0),
        "hue+20": (lambda image: _hsv(image, dh=10), 1.0),
        "hue-20": (lambda image: _hsv(image, dh=-10), 1.0),
        "warm": (lambda image: _channels(image, .8, 1.15), 1.0),
        "cool": (lambda image: _channels(image, 1.15, .8), 1.0),
        "jpeg30": (lambda image: _jpeg(image, 30), 1.0),
        "blur1.5": (lambda image: cv2.GaussianBlur(image, (0, 0), 1.5), 1.0),
        "scale0.5": (lambda image: cv2.resize(image, None, fx=.5, fy=.5, interpolation=cv2.INTER_AREA), .5),
        "scale1.5": (lambda image: cv2.resize(image, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_LINEAR), 1.5),
    }


def decode(path: Path, *, prototype_jpeg92: bool = False) -> list[np.ndarray]:
    capture = cv2.VideoCapture(str(path))
    frames: list[np.ndarray] = []
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not capture.isOpened() or fps <= 0:
            raise ValueError("Recording cannot be decoded")
        index, next_time = 0, 0.0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if index / fps + 1e-6 >= next_time:
                frames.append(_jpeg(frame, 92) if prototype_jpeg92 else frame)
                next_time += .1
            index += 1
    finally:
        capture.release()
    if len(frames) < 8:
        raise ValueError("Recording has fewer than eight sampled frames")
    if any(frame.shape != frames[0].shape for frame in frames):
        raise ValueError("A1 replay requires a fixed recording frame size")
    return frames


def _labels(record: dict[str, Any], count: int) -> tuple[set[int], set[int]]:
    starts = [round(onset * 10) for onset in record["vsOnsets"]]
    duration = round(record.get("vsDuration", 1.9) * 10)
    vs = {index for start in starts for index in range(start, min(count, start + duration))}
    transition = {index for start in starts for index in range(max(0, start - 2), min(count, start + duration + 4))}
    return vs, set(range(count)) - transition


def _geometry(frames: list[np.ndarray]) -> tuple[RectResult, dict[str, Any]]:
    sampled = np.linspace(0, len(frames) - 1, 8).round().astype(int)
    game = detect([frames[index] for index in sampled])
    singles = [detect([frame], trim_chrome=False).rect for frame in frames]
    errors, aspect_errors = [], []
    if game.rect is not None:
        for start in range(len(singles) - 19):
            window = [rect for rect in singles[start:start + 20] if rect is not None]
            if not window:
                continue
            x0, y0 = min(r[0] for r in window), min(r[1] for r in window)
            x1, y1 = max(r[0] + r[2] for r in window), max(r[1] + r[3] for r in window)
            union = x0, y0, x1 - x0, y1 - y0
            errors.append(max(abs(a - b) for a, b in zip(union, game.rect)))
            aspect_errors.append(abs((union[2] / union[3]) / game.aspect - 1) * 100)
    return game, {"rect": game.rect, "aspect": game.aspect, "reason": game.reason,
                  "union20MaxPx": max(errors, default=0), "union20MaxAspectErrorPct": max(aspect_errors, default=0)}


def _search_run(frames: list[np.ndarray], rect: PixelRect, transform: Callable,
                scale: float) -> tuple[list[Candidate | None], int | None, list[float]]:
    scaled_rect = tuple(round(v * scale) for v in rect)
    confirmer = VSConfirmer()
    candidates, timings = [], []
    confirmation = None
    for index, original in enumerate(frames):
        frame = transform(original)
        started = time.perf_counter()
        candidate = search(frame, scaled_rect)
        found = confirmer.update(frame, scaled_rect, candidate)
        timings.append((time.perf_counter() - started) * 1000)
        candidates.append(candidate)
        if found and confirmation is None:
            confirmation = index
    return candidates, confirmation, timings


def _result(frames: list[np.ndarray], record: dict[str, Any], game: RectResult,
            candidates: list[Candidate | None], confirmation: int | None,
            transform: Callable, scale: float) -> dict[str, Any]:
    vs, non = _labels(record, len(frames))
    starts = [round(value * 10) for value in record["vsOnsets"]]
    # R§9 excludes only the pop-in frame immediately before onset and 22 following frames.
    non = {index for index in range(len(frames)) if not any(start - 1 <= index <= start + 22 for start in starts)}
    # R§9.2's first three are +0.1…+0.3 s; the onset itself is the pop-in transition.
    early = {index for start in starts for index in range(start + 1, min(start + 4, len(frames)))}
    result: dict[str, Any] = {
        "confirmation": confirmation, "delayS": None if confirmation is None else round(confirmation / 10 - record["vsOnsets"][0], 1),
        "falseCandidates": sum(candidates[i] is not None and candidates[i].score >= MATCH_T for i in non),
        "earlyConfirm": confirmation is not None and confirmation < starts[0],
        "vsMin": min((candidates[i].score for i in vs if candidates[i]), default=0),
        "firstThreeVsMin": min((candidates[i].score for i in early if candidates[i]), default=0),
        "nonMax": max((candidates[i].score for i in non if candidates[i]), default=0),
    }
    if confirmation is None or candidates[confirmation] is None:
        result["code"] = "VS_NOT_FOUND"
        return result
    candidate = candidates[confirmation]
    badge = candidate.badge
    rect = tuple(round(v * scale) for v in game.rect)
    transformed_game = RectResult(rect, game.aspect, game.reason, game.chrome)
    trigger = OrientationTrigger.build(transform(frames[confirmation]), rect, badge)
    before = [trigger.score(transform(frame), rect) for index, frame in enumerate(frames) if index <= starts[0] - 10]
    following = frames[confirmation:confirmation + 2]
    vs_scores = [trigger.score(transform(frame), rect) for frame in following]
    acceptance = accept(transformed_game, geometry_frames=8, confirmed=True, badge=badge, trigger=trigger,
                        before_scores=before, vs_scores=vs_scores)
    result.update({"badge": badge.to_dict(), "regions": {key: value.to_dict() for key, value in regions(badge, game.aspect).items()},
                   "code": acceptance.code, "confidence": acceptance.confidence,
                   "selfCheck": asdict(acceptance.self_check) if acceptance.self_check else None})
    reference = record.get("referenceBadge")
    if reference:
        result["badgeError"] = {key: badge.to_dict()[key] - reference[key] for key in reference}
    if record.get("referenceRegions"):
        result["regionMaxError"] = max(abs(a - b) for key, values in record["referenceRegions"].items()
                                       for a, b in zip(result["regions"][key].values(), values))
    return result


def _overlay(frame: np.ndarray, game: RectResult, candidate: Candidate, path: Path) -> None:
    output = frame.copy()
    gx, gy, gw, gh = game.rect
    cv2.rectangle(output, (gx, gy), (gx + gw, gy + gh), (255, 255, 255), 2)
    for zone in regions(candidate.badge, game.aspect).values():
        cv2.rectangle(output, (round(gx + zone.x * gw), round(gy + zone.y * gh)),
                      (round(gx + (zone.x + zone.width) * gw), round(gy + (zone.y + zone.height) * gh)), (255, 255, 255), 2)
    ok, encoded = cv2.imencode(".png", output)
    if not ok:
        raise ValueError("Overlay encoding failed")
    path.write_bytes(encoded.tobytes())


def evaluate_replay(result: dict[str, Any], *, expected_cells: int, spectate_keys: set[str]) -> dict[str, Any]:
    """Director-approved replay bounds; production ORIENT_T/self-checks stay unchanged."""
    totals = result["totals"]
    spectate_cells = [cell for key, cell in result["cells"].items() if key.split("|", 1)[0] in spectate_keys]
    seen_spectate = {key.split("|", 1)[0] for key in result["cells"] if key.split("|", 1)[0] in spectate_keys}
    rejected = seen_spectate == spectate_keys and all(cell.get("code") == "SPECTATE_LIKE" for cell in spectate_cells)
    complete = totals["cells"] == expected_cells and totals["confirmed"] == expected_cells
    normal_accepted = all(cell.get("code") is None for key, cell in result["cells"].items()
                          if key.split("|", 1)[0] not in spectate_keys)
    setup_ok = complete and totals["falseCandidates"] == 0 and totals["earlyConfirms"] == 0 and rejected and normal_accepted
    orientation_ok = result["mode"] != "orient" or (
        totals["orientVsMin"] >= 0.70 and totals["orientNonMax"] <= 0.30 and totals["crossFires"] == 0
        and all(len(cell.get("orient", {}).get("fires", [])) == 1 for cell in result["cells"].values()))
    return {"passed": bool(setup_ok and orientation_ok), "minVsRequired": 0.70, "maxNonVsAllowed": 0.30,
            "spectateLayoutRejected": rejected, "spectateCases": len(spectate_cells),
            "expectedCases": expected_cells}


def replay(mode: str, manifest: Path, output: Path, *, all_distortions: bool = True,
           overlays: bool = False, prototype_jpeg92: bool = False,
           titlebar_image: Path | None = None) -> dict[str, Any]:
    if mode == "runtime":
        return runtime_replay(manifest, output, overlays=overlays,
                              prototype_jpeg92=prototype_jpeg92, titlebar_image=titlebar_image)
    if mode not in ("setup", "orient"):
        raise ValueError("Unsupported replay mode")
    output = output.resolve()
    if any((parent / ".git").exists() for parent in (output, *output.parents)):
        raise ValueError("Replay output must be outside a Git repository")
    records = json.loads(manifest.read_text(encoding="utf-8"))["recordings"]
    output.mkdir(parents=True, exist_ok=True)
    transforms = distortions()
    if not all_distortions:
        transforms = {"none": transforms["none"]}
    result: dict[str, Any] = {"mode": mode, "sampling": "prototype-jpeg92" if prototype_jpeg92 else "direct-video",
                              "geometry": {}, "cells": {}, "cross": {}}
    templates: dict[str, OrientationTrigger] = {}
    for record in records:
        key = record["key"]
        frames = decode(manifest.parent / record["path"], prototype_jpeg92=prototype_jpeg92)
        game, geometry = _geometry(frames)
        if game.rect is not None and record.get("expectedRect"):
            geometry["referenceMaxPx"] = max(abs(a - b) for a, b in zip(game.rect, record["expectedRect"]))
        if record.get("gameAspect"):
            geometry["referenceAspectErrorPct"] = abs(game.aspect / record["gameAspect"] - 1) * 100
        result["geometry"][key] = geometry
        if game.reason != "ok" or game.rect is None:
            result["cells"][key + "|none"] = {"code": "GAME_NOT_FOUND"}
            continue
        candidates, confirmation, timings = _search_run(frames, game.rect, transforms["none"][0], 1)
        if confirmation is not None and candidates[confirmation]:
            templates[key] = OrientationTrigger.build(frames[confirmation], game.rect, candidates[confirmation].badge)
            if overlays:
                _overlay(frames[confirmation], game, candidates[confirmation], output / f"overlay-{len(templates)}.png")
        for name, (transform, scale) in transforms.items():
            if name != "none":
                candidates, confirmation, timings = _search_run(frames, game.rect, transform, scale)
            cell = _result(frames, record, game, candidates, confirmation, transform, scale)
            cell.update({"msMedian": float(np.median(timings)), "msP95": float(np.percentile(timings, 95))})
            result["cells"][key + "|" + name] = cell
            if mode == "orient" and key in templates:
                rect = tuple(round(v * scale) for v in game.rect)
                scores = [templates[key].score(transform(frame), rect) for frame in frames]
                vs, non = _labels(record, len(frames))
                # R§8.3 measures the stable firing window, +0.1 through +0.8 s.
                stable_vs = {index for start in record["vsOnsets"]
                             for index in range(round(start * 10) + 1, min(len(frames), round(start * 10) + 9))}
                gate = TemporalGate(2, 15)
                fires = [index / 10 for index, score in enumerate(scores) if gate.observe(score >= ORIENT_T, index / 10)]
                cell["orient"] = {"vsMin": min((scores[i] for i in stable_vs), default=0),
                                  "nonMax": max((scores[i] for i in non), default=0), "fires": fires}
        print(f"{len(result['geometry'])}/{len(records)} geometry={geometry['aspect']:.5f} confirm={result['cells'][key + '|none']['confirmation']} code={result['cells'][key + '|none']['code']}", flush=True)
    if mode == "orient":
        normal = [record for record in records if record["kind"] != "spectate"][:2]
        for record in records:
            if record["kind"] != "spectate":
                continue
            frames = decode(manifest.parent / record["path"], prototype_jpeg92=prototype_jpeg92)
            rect = tuple(result["geometry"][record["key"]]["rect"])
            for source in normal:
                if source["key"] not in templates:
                    continue
                for name, (transform, scale) in transforms.items():
                    scaled = tuple(round(v * scale) for v in rect)
                    scores = [templates[source["key"]].score(transform(frame), scaled) for frame in frames]
                    gate = TemporalGate(2, 15)
                    fires = [index / 10 for index, score in enumerate(scores) if gate.observe(score >= ORIENT_T, index / 10)]
                    result["cross"][source["key"] + "|" + record["key"] + "|" + name] = {"nonMax": max(scores), "fires": fires}
    cells = [cell for cell in result["cells"].values() if "confirmation" in cell]
    result["totals"] = {"cells": len(cells), "confirmed": sum(cell["confirmation"] is not None for cell in cells),
                        "falseCandidates": sum(cell["falseCandidates"] for cell in cells),
                        "earlyConfirms": sum(cell["earlyConfirm"] for cell in cells),
                        "delayS": sorted({cell["delayS"] for cell in cells if cell["delayS"] is not None}),
                        "firstThreeVsMin": min((cell["firstThreeVsMin"] for cell in cells), default=0),
                        "nonMax": max((cell["nonMax"] for cell in cells), default=0)}
    result["totals"].update({
        "accepted": sum(cell.get("code") is None for cell in cells),
        "spectateRejected": sum(cell.get("code") == "SPECTATE_LIKE" for cell in cells),
        "regionMaxError": max((cell.get("regionMaxError", 0) for cell in cells), default=0),
        "centerMaxError": max((abs(error) for cell in cells for key, error in cell.get("badgeError", {}).items()
                               if key in ("cx", "cy")), default=0),
        "gameRectReferenceMaxPx": max((g.get("referenceMaxPx", 0) for g in result["geometry"].values()), default=0),
        "union20MaxPx": max((g["union20MaxPx"] for g in result["geometry"].values()), default=0),
        "union20MaxAspectErrorPct": max((g["union20MaxAspectErrorPct"] for g in result["geometry"].values()), default=0),
    })
    if mode == "orient":
        own = [cell["orient"] for cell in cells if "orient" in cell]
        cross = list(result["cross"].values())
        result["totals"].update({"orientVsMin": min((cell["vsMin"] for cell in own), default=0),
                                 "orientNonMax": max((cell["nonMax"] for cell in own + cross), default=0),
                                 "crossFires": sum(len(cell["fires"]) for cell in cross)})
    result["acceptance"] = evaluate_replay(result, expected_cells=len(records) * len(transforms),
                                          spectate_keys={record["key"] for record in records if record["kind"] == "spectate"})
    (output / "results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result["totals"], sort_keys=True))
    return result


_RUNTIME_NORMAL = ("bars_1080x1920", "windowed_1080x1920", "obs_1080x2400",
                   "obs_1200x1920", "obs_1536x2048")
_RUNTIME_SPECTATE = ("spectate_1", "spectate_2", "spectate_3_leagues")
_RUNTIME_VARIANTS = {
    "x0.5_black": (0.5, (300, 0, 300, 0), (0, 0, 0)),
    "x0.75_darkblue": (0.75, (200, 30, 200, 30), (60, 20, 8)),
    "x1.5_none": (1.5, (0, 0, 0, 0), (0, 0, 0)),
    "x0.75_blue_bright": (0.75, (120, 0, 120, 0), (200, 120, 40)),
}


def _runtime_variant(frame: np.ndarray, rect: PixelRect, scale: float = 1.0,
                     pad: tuple[int, int, int, int] = (0, 0, 0, 0),
                     colour: tuple[int, int, int] = (0, 0, 0),
                     titlebar: np.ndarray | None = None) -> np.ndarray:
    """REPORT's capture transforms, performed in memory on the detected game."""
    x, y, width, height = rect
    game = cv2.resize(frame[y:y + height, x:x + width],
                      (max(1, round(width * scale)), max(1, round(height * scale))),
                      interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    left, top, right, bottom = pad
    output = np.empty((game.shape[0] + top + bottom, game.shape[1] + left + right, 3), np.uint8)
    output[:] = colour
    output[top:top + game.shape[0], left:left + game.shape[1]] = game
    if titlebar is not None:
        strip = cv2.resize(titlebar, (output.shape[1], titlebar.shape[0]), interpolation=cv2.INTER_AREA)
        output = np.vstack((strip, output))
    return output


def _runtime_profile(frames: list[np.ndarray], record: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    game, geometry = _geometry(frames)
    if game.reason != "ok" or game.rect is None:
        return None, {"code": "GAME_NOT_FOUND", "geometry": geometry}
    candidates, confirmation, _ = _search_run(frames, game.rect, lambda frame: frame, 1)
    setup = _result(frames, record, game, candidates, confirmation, lambda frame: frame, 1)
    setup["geometry"] = geometry
    if setup["code"] is not None:
        return None, setup
    badge = candidates[confirmation].badge
    zones = regions(badge, game.aspect)
    identity = str(uuid.uuid5(uuid.NAMESPACE_URL, "cr-tools-m9-replay:" + record["key"]))
    layout = {
        "layoutId": identity, "layoutSource": "setup", "calibratedAt": "2026-10-13T00:00:00Z",
        "gameAspect": game.aspect, "windowChrome": game.chrome,
        "regions": {"trigger": zones["trigger"].to_dict(), "nicknameRegion": zones["nickname"].to_dict(),
                    "topLeftEvidenceRegion": zones["topLeftEvidence"].to_dict()},
        "trigger": OrientationTrigger.build(frames[confirmation], game.rect, badge).to_dict(),
        "badge": badge.to_dict(), "zonesOrigin": {"nickname": "auto", "topLeftEvidence": "auto"},
    }
    return layout, setup


def _runtime_payload(layout: dict[str, Any], *, learning: bool) -> dict[str, Any]:
    return validate_start_payload({
        "selector": {"kind": "window", "windowHwnd": "1"}, "capturePolicy": "immediate_nickname",
        "limits": {"fps": 10, "maxImageBytes": 10 * 1024 * 1024, "maxImagePixels": 20_000_000,
                   "maxImageWidth": 8192, "maxImageHeight": 8192, "confirmationsNeeded": 2,
                   "confirmationDecay": 0.5, "cooldownSeconds": 15},
        "prediction": None,
        "primary": {"kind": "game_relative", "profileCalibrationId": layout["layoutId"],
                    "layouts": [layout], "learning": {"enabled": learning, "maxLayouts": 4}},
    })


def _runtime_windows(record: dict[str, Any], offset: int = 0) -> list[tuple[int, int]]:
    duration = round(record.get("vsDuration", 1.9) * 10)
    return [(offset + round(onset * 10), offset + round(onset * 10) + duration)
            for onset in record["vsOnsets"]]


def _runtime_run(layout: dict[str, Any], frames, windows: list[tuple[int, int]], *,
                 learning: bool = False, output: Path | None = None,
                 overlay_number: int = 0, gap_at: int | None = None) -> dict[str, Any]:
    """Only TriggerEngine decides geometry, learning, firing and action pixels."""
    engine = TriggerEngine(_runtime_payload(layout, learning=learning))
    fires, actions, states, events, timings = [], [], {}, [], []
    scores: dict[int, float] = {}
    episode_gate = TemporalGate(2, 0)
    episodes, blocked_fires, unknown_at, mismatch_at = [], [], None, None
    for index, frame in enumerate(frames):
        started = time.perf_counter()
        now = index / 10 + (16.0 if gap_at is not None and index >= gap_at else 0.0)
        action = engine.process(frame, now)
        timings.append((time.perf_counter() - started) * 1000)
        fired = engine.take_triggered()
        geometry = engine.geometry
        state = geometry.state
        states[state] = states.get(state, 0) + 1
        if state == "aspect_mismatch" and mismatch_at is None:
            mismatch_at = index
        if state == "aspect_unknown" and unknown_at is None:
            unknown_at = index
        match = engine.last_match
        evaluated = geometry.layout is not None and geometry.rect is not None and match is not None
        if evaluated:
            scores[index] = match.score
        if episode_gate.observe(bool(evaluated and match.matched), now):
            episodes.append(index)
        for event_type, payload in engine.take_events():
            event = {"frame": index, "type": event_type}
            if event_type == "geometry":
                event.update({key: payload[key] for key in ("state", "gameAspect")})
            elif event_type == "learning":
                event.update({key: payload[key] for key in ("status", "reason", "rejectedCount")})
            elif event_type == "layout_learned":
                learned = payload["layout"]
                event.update({"gameAspect": learned["gameAspect"], "confidence": learned["confidence"]})
            events.append(event)
        if fired:
            fires.append(index)
            if state not in ("armed", "armed_provisional"):
                blocked_fires.append(index)
            if output is not None and geometry.rect is not None:
                active = geometry.layout
                badge = active["badge"]
                if badge is not None:
                    _overlay(frame, RectResult(geometry.rect, geometry.aspect, "ok"),
                             Candidate(1.0, badge["width"], Badge(**badge)),
                             output / f"runtime-{overlay_number}-{len(fires)}.png")
        if action is not None:
            png, width, height = action
            actions.append({"frame": index, "bytes": len(png), "width": width, "height": height})
    stable = {index for onset, end in windows for index in range(onset + 1, min(end, onset + 9))}
    # Score extrema omit pop-in/fade, but EVERY frame is passed to the engine.
    non = {index for index in scores if not any(onset - 2 <= index < end + 4 for onset, end in windows)}
    counts = [sum(onset <= index < end for index in fires) for onset, end in windows]
    false = [index for index in fires if not any(onset <= index < end for onset, end in windows)]
    return {
        "fires": fires, "fireSeconds": [index / 10 + (16.0 if gap_at is not None and index >= gap_at else 0.0) for index in fires],
        "vsFireCounts": counts, "simulatedGap": {"beforeFrame": gap_at, "seconds": 16} if gap_at is not None else None,
        "delayS": [round((index - onset) / 10, 1) for onset, end in windows
                   for index in fires if onset <= index < end],
        "falseFires": len(false), "blockedFires": blocked_fires, "actions": actions,
        "episodes": episodes, "states": states, "events": events,
        "firstMismatchFrame": mismatch_at, "firstUnknownFrame": unknown_at,
        "nonMax": max((scores[index] for index in non), default=None),
        "stableVsMin": min((scores[index] for index in stable if index in scores), default=None),
        "processMsMedian": float(np.median(timings)), "processMsP95": float(np.percentile(timings, 95)),
    }


def evaluate_runtime(result: dict[str, Any]) -> dict[str, Any]:
    """Named A2 acceptance; a missing case or event cannot silently pass."""
    positive = list(result["positive"].values())
    cross = list(result["cross"].values())
    blocked = list(result["aspectBlocked"].values())
    learning = list(result["learning"].values())
    rejections = list(result["learningSpectate"].values())
    positive_ok = len(positive) == 22 and all(
        cell["vsFireCounts"] and all(count == 1 for count in cell["vsFireCounts"])
        and len(cell["fires"]) == len(cell["vsFireCounts"]) and cell["falseFires"] == 0
        and not cell["blockedFires"] and max(cell["delayS"], default=1) <= 0.2
        and [action["frame"] for action in cell["actions"]] == cell["fires"]
        and len(cell["episodes"]) == len(cell["vsFireCounts"]) for cell in positive)
    cross_ok = len(cross) == 6 and all(not cell["fires"] and not cell["actions"] for cell in cross)
    blocked_ok = len(blocked) == 4 and all(
        not cell["fires"] and not cell["actions"] and cell["firstUnknownFrame"] is not None
        and 0 <= cell["firstUnknownFrame"] <= 20 and cell["firstMismatchFrame"] is not None
        and not any(event["type"] == "layout_learned" for event in cell["events"]) for cell in blocked)
    learning_ok = len(learning) == 4 and all(
        cell["vsFireCounts"] and all(count == 1 for count in cell["vsFireCounts"])
        and cell["falseFires"] == 0 and not cell["blockedFires"]
        and cell["targetUnknownFrame"] is not None and 0 <= cell["targetUnknownFrame"] <= cell["maxTargetUnknownFrame"]
        and sum(event["type"] == "layout_learned" for event in cell["events"]) == 1
        and any(event["type"] == "layout_learned" and event["frame"] in cell["fires"]
                for event in cell["events"])
        and [action["frame"] for action in cell["actions"]] == cell["fires"] for cell in learning)
    rejection_ok = len(rejections) == 3 and all(
        cell["targetFireCount"] == 0 and cell["falseFires"] == 0
        and not any(event["type"] == "layout_learned" for event in cell["events"])
        and any(event["type"] == "learning" and event.get("status") == "rejected"
                and event.get("reason") == "LEARN_SPECTATE_LIKE" for event in cell["events"])
        for cell in rejections)
    setup_ok = len(result["setups"]) == 6 and all(
        setup.get("code") is None for setup in result["setups"].values())
    checks = {"setupAccepted": setup_ok, "runtime22OneFirePerVs": positive_ok,
              "crossSpectateZeroOf6": cross_ok, "aspectBlocked4Within2S": blocked_ok,
              "secondRecordingLearned4WithSameVsFire": learning_ok,
              "crossAspectSpectateRejected3": rejection_ok}
    return {"passed": all(checks.values()), "checks": checks, "positiveRequired": 22,
            "crossRequired": 6, "aspectRequired": 4, "learningRequired": 4,
            "learningSpectateRequired": 3, "maxPositiveDelayS": 0.2,
            "maxSameCanvasUnknownFrames": 45, "maxNewFrameUnknownFrames": 20}


def runtime_replay(manifest: Path, output: Path, *, overlays: bool = False,
                   prototype_jpeg92: bool = False, titlebar_image: Path | None = None,
                   titlebar_rect: list[int] | None = None) -> dict[str, Any]:
    output = output.resolve()
    if any((parent / ".git").exists() for parent in (output, *output.parents)):
        raise ValueError("Replay output must be outside a Git repository")
    document = json.loads(manifest.read_text(encoding="utf-8"))
    records = {record["key"]: record for record in document["recordings"]}
    if not set(_RUNTIME_NORMAL + _RUNTIME_SPECTATE) <= records.keys():
        raise ValueError("Runtime requires the eight REPORT recording keys")
    runtime_options = document.get("runtime", {})
    if titlebar_image is None:
        if not runtime_options.get("titlebarImage"):
            raise ValueError("Runtime requires --titlebar-image or manifest runtime.titlebarImage")
        titlebar_image = manifest.parent / runtime_options["titlebarImage"]
    title = cv2.imdecode(np.fromfile(str(titlebar_image), np.uint8), cv2.IMREAD_COLOR)
    if title is None:
        raise ValueError("Titlebar reference cannot be decoded")
    strip_rect = titlebar_rect if titlebar_rect is not None else runtime_options.get("titlebarRect")
    if not isinstance(strip_rect, list) or len(strip_rect) != 4 or any(type(value) is not int for value in strip_rect):
        raise ValueError("Runtime requires --titlebar-rect X Y WIDTH HEIGHT or manifest runtime.titlebarRect")
    tx, ty, tw, th = strip_rect
    if min(tx, ty) < 0 or min(tw, th) <= 0 or tx + tw > title.shape[1] or ty + th > title.shape[0]:
        raise ValueError("Titlebar reference rectangle is invalid")
    titlebar = title[ty:ty + th, tx:tx + tw].copy()
    del title
    output.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {
        "mode": "runtime", "sampling": "prototype-jpeg92" if prototype_jpeg92 else "direct-video",
        "setups": {}, "positive": {}, "cross": {}, "aspectBlocked": {}, "learning": {}, "learningSpectate": {},
    }
    profiles: dict[str, dict[str, Any]] = {}
    rects: dict[str, PixelRect] = {}
    run_number = 0

    def load(key: str) -> list[np.ndarray]:
        return decode(manifest.parent / records[key]["path"], prototype_jpeg92=prototype_jpeg92)

    def run(group: str, name: str, source: str, frames, windows, *, learn: bool = False, gap_at: int | None = None) -> dict[str, Any]:
        nonlocal run_number
        run_number += 1
        if source not in profiles:
            return {}
        cell = _runtime_run(profiles[source], frames, windows, learning=learn,
                            output=output if overlays else None, overlay_number=run_number, gap_at=gap_at)
        result[group][name] = cell
        print(f"{group}/{name} fires={len(cell['fires'])} false={cell['falseFires']} "
              f"delay={cell['delayS']} unknown={cell['firstUnknownFrame']}", flush=True)
        return cell

    for key in _RUNTIME_NORMAL:
        frames = load(key)
        profile, setup = _runtime_profile(frames, records[key])
        result["setups"][key] = setup
        if profile is not None:
            profiles[key] = profile
            rects[key] = tuple(setup["geometry"]["rect"])
            run("positive", "self_" + key, key, frames, _runtime_windows(records[key]))
        del frames
    for source, target in ((_RUNTIME_NORMAL[0], _RUNTIME_NORMAL[1]), (_RUNTIME_NORMAL[1], _RUNTIME_NORMAL[0])):
        frames = load(target)
        run("positive", source + "_on_" + target, source, frames, _runtime_windows(records[target]))
        del frames
    for target in _RUNTIME_SPECTATE:
        frames = load(target)
        for source in _RUNTIME_NORMAL[:2]:
            run("cross", source + "_on_" + target, source, frames, [])
        del frames
    for source in _RUNTIME_NORMAL[:2]:
        if source not in profiles:
            continue
        frames = load(source)
        rect = rects[source]
        windows = _runtime_windows(records[source])
        for name, (scale, pad, colour) in _RUNTIME_VARIANTS.items():
            run("positive", source + "_" + name, source,
                (_runtime_variant(frame, rect, scale, pad, colour) for frame in frames), windows)
        run("positive", source + "_midstream_resize", source,
            (_runtime_variant(frame, rect, *( (1.0, (0, 0, 0, 0), (0, 0, 0)) if index < 30
                                                else _RUNTIME_VARIANTS["x0.75_darkblue"]))
             for index, frame in enumerate(frames)), windows)
        canvas_width, canvas_height = int(rect[2] * .8) + 200, int(rect[3] * .8)

        def canvas_frames():
            for index, frame in enumerate(frames):
                game = _runtime_variant(frame, rect, .8 if index < 30 else .6)
                canvas = np.zeros((canvas_height, canvas_width, 3), np.uint8)
                x, y = (canvas_width - game.shape[1]) // 2, (canvas_height - game.shape[0]) // 2
                canvas[y:y + game.shape[0], x:x + game.shape[1]] = game
                yield canvas

        run("positive", source + "_same_canvas_shrink", source, canvas_frames(), windows)
        del frames
    source = "windowed_1080x1920"
    if source in profiles:
        frames = load(source)
        rect = rects[source]
        titled = [_runtime_variant(frame, rect, 574 / 1080, titlebar=titlebar) for frame in frames]
        profile, setup = _runtime_profile(titled, {**records[source], "key": "titlebar_setup"})
        result["setups"]["titlebar_setup"] = setup
        del titled
        if profile is not None:
            profiles["titlebar_setup"] = profile
            for scale in (.4, .8):
                run("positive", "titlebar_x" + str(scale), "titlebar_setup",
                    (_runtime_variant(frame, rect, scale, titlebar=titlebar) for frame in frames),
                    _runtime_windows(records[source]))
            run("positive", "titlebar_profile_without_titlebar", "titlebar_setup",
                (_runtime_variant(frame, rect, .6) for frame in frames), _runtime_windows(records[source]))
        del frames
    pairs = [("windowed_1080x1920", target) for target in _RUNTIME_NORMAL[2:]]
    pairs.append(("obs_1536x2048", "windowed_1080x1920"))
    for source, target in pairs:
        frames = load(target)
        run("aspectBlocked", source + "_on_" + target, source, frames, _runtime_windows(records[target]))
        previous = load(source)
        offset = len(previous)
        cell = run("learning", source + "_then_" + target, source, chain(previous, frames),
                   _runtime_windows(records[source]) + _runtime_windows(records[target], offset), learn=True, gap_at=offset)
        if cell:
            cell["maxTargetUnknownFrame"] = 45 if previous[0].shape == frames[0].shape else 20
            cell["targetUnknownFrame"] = (None if cell["firstUnknownFrame"] is None
                                          else cell["firstUnknownFrame"] - offset)
        del previous, frames
    for target in _RUNTIME_SPECTATE:
        source = "obs_1536x2048"
        previous, frames = load(source), load(target)
        offset = len(previous)
        cell = run("learningSpectate", source + "_then_" + target, source, chain(previous, frames),
                   _runtime_windows(records[source]), learn=True, gap_at=offset)
        if cell:
            cell["targetFireCount"] = sum(index >= offset for index in cell["fires"])
        del previous, frames
    positive, cross = list(result["positive"].values()), list(result["cross"].values())
    result["totals"] = {
        "positiveCases": len(positive), "positiveFires": sum(len(cell["fires"]) for cell in positive),
        "falseFires": sum(cell["falseFires"] for group in ("positive", "cross", "aspectBlocked", "learning", "learningSpectate")
                          for cell in result[group].values()),
        "crossCases": len(cross), "crossFires": sum(len(cell["fires"]) for cell in cross),
        "aspectBlockedCases": len(result["aspectBlocked"]), "learningCases": len(result["learning"]),
        "learnedLayouts": sum(event["type"] == "layout_learned" for cell in result["learning"].values()
                              for event in cell["events"]),
        "learningSpectateCases": len(result["learningSpectate"]),
        "delayS": sorted({delay for cell in positive for delay in cell["delayS"]}),
        "nonMax": max((cell["nonMax"] for cell in positive if cell["nonMax"] is not None), default=None),
        "stableVsMin": min((cell["stableVsMin"] for cell in positive if cell["stableVsMin"] is not None), default=None),
    }
    result["acceptance"] = evaluate_runtime(result)
    (output / "results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"totals": result["totals"], "acceptance": result["acceptance"]}, sort_keys=True))
    return result


def autosetup_replay(manifest: Path, output: Path, *, overlays: bool = False,
                     prototype_jpeg92: bool = False) -> dict[str, Any]:
    """Feed real recordings through the production engine, with disclosed replay time."""
    output = output.resolve()
    if output.is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError("Replay output must be outside the repository")
    output.mkdir(parents=True, exist_ok=True)
    records = json.loads(manifest.read_text(encoding="utf-8"))["recordings"]
    normal, spectate, timeout = {}, {}, {}
    for record in records:
        if record["key"] not in _RUNTIME_NORMAL + _RUNTIME_SPECTATE:
            continue
        frames = decode(manifest.parent / record["path"], prototype_jpeg92=prototype_jpeg92)
        engine = AutoSetupEngine(0.0)
        outcome = None
        for index, frame in enumerate(frames):
            outcome = engine.process(frame, index / 10)
            if outcome is not None:
                break
        if outcome is None:
            outcome = engine.deadline()
        payload = outcome.result
        cell = {"ok": payload["ok"], "code": payload.get("code"), "framesAnalyzed": engine.frames_analyzed,
                "elapsedS": round(index / 10, 1), "confirmationFrame": None, "zoneErrors": {},
                "maxZoneError": None, "zonesWithinTolerance": False}
        if payload["ok"]:
            cell["confirmationFrame"] = round(payload["timings"]["confirmMs"] / 100)
            cell["confidence"] = payload["confidence"]
            cell["selfCheck"] = payload["selfCheck"]
            cell["timings"] = payload["timings"]
            cell["regions"] = payload["regions"]
            reference = record.get("referenceBadge")
            expected = ({key: value.to_dict() for key, value in regions(Badge(**reference), record["gameAspect"]).items()}
                        if reference else {})
            for key, values in record.get("referenceRegions", {}).items():
                expected[key] = dict(zip(("x", "y", "width", "height"), values))
            for key, zone in expected.items():
                cell["zoneErrors"][key] = {coordinate: round(abs(payload["regions"][key][coordinate] - value), 6)
                                          for coordinate, value in zone.items()}
            cell["maxZoneError"] = max((value for zone in cell["zoneErrors"].values() for value in zone.values()), default=None)
            cell["zonesWithinTolerance"] = cell["maxZoneError"] is not None and cell["maxZoneError"] <= .005
        if overlays and outcome.frame is not None:
            image = outcome.frame.copy()
            game = payload["game"]["rect"]
            for zone in payload["regions"].values():
                x = game["x"] + round(zone["x"] * game["width"])
                y = game["y"] + round(zone["y"] * game["height"])
                w, h = round(zone["width"] * game["width"]), round(zone["height"] * game["height"])
                cv2.rectangle(image, (x, y), (x + w, y + h), (255, 255, 255), 2)
            cv2.imwrite(str(output / (record["key"] + ".png")), image)
        (spectate if record["kind"] == "spectate" else normal)[record["key"]] = cell
        if record["kind"] == "cheddar":
            # Only decode the genuine pre-VS segment: no repeated final frames.
            stop = max(0, round(min(record["vsOnsets"]) * 10) - 2)
            no_vs = AutoSetupEngine(0.0)
            early = None
            for sample, frame in enumerate(frames[:stop]):
                early = no_vs.process(frame, sample / 10)
                if early is not None:
                    break
            timed_out = early if early is not None else no_vs.process(frames[0], DEADLINE_MS / 1000)
            timeout[record["key"]] = {"ok": timed_out.result["ok"], "code": timed_out.result.get("code"),
                                      "deadlineMs": DEADLINE_MS, "earlyResult": early is not None,
                                      "framesAnalyzed": no_vs.frames_analyzed}
        del frames
    checks = {"fiveNormalSuccess": len(normal) == 5 and all(cell["ok"] for cell in normal.values()),
              "threeSpectateRejected": len(spectate) == 3 and all(not cell["ok"] and cell["code"] == "AUTO_SPECTATE_LIKE"
                                                                  for cell in spectate.values()),
              "zonesWithin005": len(normal) == 5 and all(cell["zonesWithinTolerance"] for cell in normal.values()),
              "noVsTimeout": len(timeout) == 5 and all(not cell["ok"] and cell["code"] == "AUTO_VS_TIMEOUT"
                                                       and not cell["earlyResult"] for cell in timeout.values())}
    result = {"mode": "autosetup", "timeBasis": "0.1-second decoded samples; deadline advanced to 60s without fabricated frames",
              "normal": normal, "spectate": spectate, "noVs": timeout,
              "acceptance": {"passed": all(checks.values()), "checks": checks}}
    (output / "results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"acceptance": result["acceptance"]}, sort_keys=True))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("setup", "orient", "runtime", "autosetup"))
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--distortions", choices=("all", "none"), default="all")
    parser.add_argument("--overlays", action="store_true")
    parser.add_argument("--prototype-jpeg92", action="store_true")
    parser.add_argument("--titlebar-image", type=Path)
    parser.add_argument("--titlebar-rect", nargs=4, type=int, metavar=("X", "Y", "WIDTH", "HEIGHT"))
    args = parser.parse_args()
    if args.mode == "autosetup":
        result = autosetup_replay(args.manifest, args.out, overlays=args.overlays,
                                 prototype_jpeg92=args.prototype_jpeg92)
    elif args.mode == "runtime":
        result = runtime_replay(args.manifest, args.out, overlays=args.overlays,
                                prototype_jpeg92=args.prototype_jpeg92, titlebar_image=args.titlebar_image,
                                titlebar_rect=args.titlebar_rect)
    else:
        result = replay(args.mode, args.manifest, args.out, all_distortions=args.distortions == "all",
                        overlays=args.overlays, prototype_jpeg92=args.prototype_jpeg92)
    raise SystemExit(0 if result["acceptance"]["passed"] else 1)
