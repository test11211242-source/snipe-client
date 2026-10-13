"""Offline A1 replay: setup search and fixed-badge rule (c), no owner data in git.

Usage: m9_replay.py {setup|orient} --manifest <external.json> --out <external-dir>
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
Runtime/autosetup modes belong to later milestone sessions, not A1.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import sys
import time
from typing import Any, Callable

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geometry.acceptance import accept
from geometry.game_rect import PixelRect, RectResult, detect
from geometry.vs_finder import MATCH_T, Candidate, VSConfirmer, search
from geometry.vs_orient_trigger import ORIENT_T, OrientationTrigger
from geometry.zones import regions
from trigger_engine import TemporalGate


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
           overlays: bool = False, prototype_jpeg92: bool = False) -> dict[str, Any]:
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("setup", "orient"))
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--distortions", choices=("all", "none"), default="all")
    parser.add_argument("--overlays", action="store_true")
    parser.add_argument("--prototype-jpeg92", action="store_true")
    args = parser.parse_args()
    result = replay(args.mode, args.manifest, args.out, all_distortions=args.distortions == "all",
                    overlays=args.overlays, prototype_jpeg92=args.prototype_jpeg92)
    raise SystemExit(0 if result["acceptance"]["passed"] else 1)
