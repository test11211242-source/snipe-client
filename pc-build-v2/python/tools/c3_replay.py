"""Offline replay of the predictions C3 detectors on owner recordings.

    m9_replay.py c3 --manifest <external c3 manifest.json> --out <external dir>

Manifest (paths relative to it, never committed):
    {"results": [{"key": "end_1", "path": "end/1.mp4", "outcome": "loss",
                  "crowns": [1, 0], "sign": "-"}],
     "vsManifest": "manifest-a1.json",          # M9 VS recordings (kinds, badges, rects)
     "vsExpected": {"spectate_1": {"opponent": "medal", "own": "medal"}, ...},
     "stills": [{"key": "still_win", "path": "4.png", "sign": "+"}],
     "scales": [1.0, 0.5]}                    # optional: also replay as a smaller capture

Every end clip is decoded once at its native rate and replayed at 10 FPS in
all six sampling phases (the production tick). Ground truth for the «vs»
onset and the shift comes from an independent 60 FPS pass. Results contain
numbers and codes only, never pixels, names or paths.
"""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
import json
from pathlib import Path
import statistics
import sys
import time
from typing import Any

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geometry.game_rect import detect
from geometry.rank_line import RankTemplates, check_rank, read_line, zones
from geometry.result_screen import (VS_FIRE_T, ResultTemplates, count_crowns, crown_scores, find_vs, read_pill)
from geometry.shape_match import ui_unit
from geometry.vs_finder import MATCH_T, search
from geometry.vs_orient_trigger import ORIENT_T, OrientationTrigger
from geometry.zones import Badge, layout_kind, regions
from prediction_values import rank_from_lines
from result_reader import ResultReader

TICK = 0.1
PHASES = 6
# Ground-truth shift: the «vs» moved up this far (units) on 3 consecutive
# 60 FPS frames, or vanished for 40 frames (crowns cover it for up to ~0.4 s).
GT_SHIFT_UNITS = 0.003


def _frames(path: Path):
    """Stream (index, frame) at the native rate; never holds the recording."""
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened() or capture.get(cv2.CAP_PROP_FPS) <= 0:
            raise ValueError("Recording cannot be decoded")
        index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            yield index, frame
            index += 1
    finally:
        capture.release()


def _info(path: Path) -> tuple[float, int, Any]:
    capture = cv2.VideoCapture(str(path))
    try:
        fps, count = capture.get(cv2.CAP_PROP_FPS), int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        sampled = []
        for index in np.linspace(0, count - 2, 8).round().astype(int):
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, frame = capture.read()
            if ok:
                sampled.append(frame)
    finally:
        capture.release()
    if fps <= 0 or len(sampled) < 4:
        raise ValueError("Recording cannot be decoded")
    if path.suffix.lower() in (".png", ".jpg"):
        raise ValueError("Not a recording")
    return fps, count, _rect(sampled)


def _rect(frames: list[np.ndarray]):
    game = detect(frames)
    if game.rect is None or game.reason != "ok":
        raise ValueError("No game rectangle")
    return game.rect


def _ground_truth(scores: list[float], uys: list[float], fps: float) -> dict[str, Any]:
    onset = next((i for i, s in enumerate(scores) if s >= VS_FIRE_T), None)
    if onset is None:
        return {"onset": None}
    home = float(np.median([uys[i] for i in range(onset, min(len(scores), onset + 30)) if scores[i] >= VS_FIRE_T]))
    shift = None
    for i in range(onset, len(scores) - 6):
        moved = all(scores[j] >= 0.5 and uys[j] < home - GT_SHIFT_UNITS for j in range(i, i + 3))
        lost = all(scores[j] < 0.5 for j in range(i, min(len(scores), i + 40)))
        if moved or lost:
            shift = i
            break
    return _with_outside(scores, onset, shift, fps)


def _with_outside(scores: list[float], onset: int, shift: int | None, fps: float) -> dict[str, Any]:
    outside = [s for i, s in enumerate(scores) if i < onset - 12 or (shift is not None and i >= shift + 60)]
    return {"onset": onset / fps, "shift": None if shift is None else shift / fps,
            "nonResultMax": round(max(outside, default=-1.0), 3), "nonResultFrames": len(outside),
            "nonResultFires": sum(s >= VS_FIRE_T for s in outside)}


def _anchored_truth(scores: list[float], fps: float, base: dict[str, Any]) -> dict[str, Any]:
    """A scaled replay is judged on the full-size clip's onset and shift, so a
    later onset on the smaller capture shows up as fire delay, not as truth."""
    if base["onset"] is None:
        return {"onset": None}
    shift = None if base["shift"] is None else round(base["shift"] * fps)
    return _with_outside(scores, round(base["onset"] * fps), shift, fps)


def _battle_triggers(vs_manifest: Path) -> list[tuple[str, str, OrientationTrigger, dict[str, float]]]:
    """Battle-VS rule-(c) triggers of the M9 recordings, badge kept in units."""
    document = json.loads(vs_manifest.read_text(encoding="utf-8"))
    triggers = []
    for record in document["recordings"]:
        capture = cv2.VideoCapture(str(vs_manifest.parent / record["path"]))
        capture.set(cv2.CAP_PROP_POS_MSEC, (record["vsOnsets"][0] + 1.0) * 1000)
        ok, frame = capture.read()
        capture.release()
        if not ok:
            continue
        rect = tuple(record["expectedRect"])
        badge = Badge(**record["referenceBadge"])
        trigger = OrientationTrigger.build(frame, rect, badge)
        unit = ui_unit(rect)
        units = {"dx": (badge.cx - 0.5) * rect[2] / unit, "dy": (badge.cy - 0.5) * rect[3] / unit,
                 "w": badge.width * rect[2] / unit, "h": badge.height * rect[3] / unit}
        triggers.append((record["key"], layout_kind(badge) or "none", trigger, units))
    return triggers


def _transplant(trigger: OrientationTrigger, units: dict[str, float], rect) -> OrientationTrigger:
    unit = ui_unit(rect)
    badge = Badge(0.5 + units["dx"] * unit / rect[2], 0.5 + units["dy"] * unit / rect[3],
                  units["w"] * unit / rect[2], units["h"] * unit / rect[3])
    return OrientationTrigger(badge, trigger.cos2, trigger.sin2, trigger.weight, trigger.mask_area_ratio,
                              trigger.contains_center)


def replay_end_clip(path: Path, vs_manifest: Path | None, scale: float = 1.0) -> dict[str, Any]:
    """`scale` < 1 replays the clip as a smaller capture (whole frame resized)."""
    templates = ResultTemplates.load()
    fps, count, rect = _info(path)
    if scale != 1.0:
        rect = tuple(round(value * scale) for value in rect)
    step = round(fps * TICK)
    triggers = [(key, kind, _transplant(trigger, units, rect))
                for key, kind, trigger, units in (_battle_triggers(vs_manifest) if vs_manifest else [])]
    battle = {key: {"kind": kind, "scores": []} for key, kind, _ in triggers}
    finder: list = []
    readers = []
    for _ in range(PHASES):
        reader = ResultReader(templates)
        reader.arm(0.0, delay=0)
        readers.append({"reader": reader, "reports": [], "ms": 0.0})
    scores, uys, idle_ms, burst_ms = [], [], [], []
    for index, frame in _frames(path):
        if scale != 1.0:
            frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        hit = find_vs(frame, rect, templates)
        scores.append(hit.score if hit else -1.0)
        uys.append(hit.uy if hit else 0.0)
        if index % step == 0:
            for key, _, trigger in triggers:
                try:
                    battle[key]["scores"].append(trigger.score(frame, rect))
                except ValueError:
                    battle[key]["scores"].append(-1.0)
            if vs_manifest is not None:
                finder.append(search(frame, rect))
        phase = index % step
        if phase >= PHASES:
            continue
        state = readers[phase]
        reader, now = state["reader"], index / fps
        started = time.perf_counter()
        in_burst = reader.burst is not None
        report = reader.process(frame, rect, now)
        elapsed = (time.perf_counter() - started) * 1000
        if in_burst or reader.burst is not None or report is not None:
            state["ms"] += elapsed
        else:
            idle_ms.append(elapsed)
        if report is not None:
            diag = reader.diagnostics
            state["reports"].append({"report": report, "startS": round(now - diag["elapsedS"], 3),
                                     "endS": round(now, 3), "endReason": diag["endReason"], "trace": diag["trace"]})
            burst_ms.append(state["ms"])
            state["ms"] = 0.0
            reader.arm(now, delay=0)   # stay armed: any later fire is a false report
    runs = []
    for phase, state in enumerate(readers):
        reports, reader = state["reports"], state["reader"]
        if reader.burst is not None:
            end = (len(scores) - 1) / fps
            report = reader.finish(end)
            diag = reader.diagnostics
            reports.append({"report": report, "startS": round(end - diag["elapsedS"], 3), "endS": round(end, 3),
                            "endReason": diag["endReason"], "trace": diag["trace"]})
        runs.append({"phase": phase, "reports": reports})
    trigger_cells = {key: {"kind": cell["kind"], "max": round(max(cell["scores"]), 3),
                           "fires": sum(s >= ORIENT_T for s in cell["scores"])} for key, cell in battle.items()}
    if vs_manifest is not None:
        trigger_cells["vsFinder"] = {
            "maxScore": round(max((c.score for c in finder if c), default=-1.0), 3),
            "candidates": sum(c is not None and c.score >= MATCH_T for c in finder),
            "kinds": sorted({layout_kind(c.badge) or "none" for c in finder if c is not None and c.score >= MATCH_T})}
    return {"frames": len(scores), "fps": fps, "gameAspect": round(rect[2] / rect[3], 4),
            "truth": _ground_truth(scores, uys, fps), "scores": scores, "runs": runs,
            "idleMs": [round(float(np.median(idle_ms)), 2), round(float(np.percentile(idle_ms, 95)), 2)]
            if idle_ms else None, "burstMs": [round(v, 1) for v in burst_ms],
            "battleTrigger": trigger_cells if vs_manifest is not None else None}


def replay_vs_clip(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    """Rank lines and result-«vs» silence on one M9 VS recording."""
    templates, rank_templates = ResultTemplates.load(), RankTemplates.load()
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS)
    capture.release()
    rect = tuple(record["expectedRect"])
    badge = Badge(**record["referenceBadge"])
    step = round(fps * TICK)
    onset = round(record["vsOnsets"][0] * 10)
    reader = ResultReader(templates)
    reader.arm(0.0, delay=0)
    fires, scores, lines, ms = 0, [], [], []
    for index, frame in _frames(path):
        if index % step:
            continue
        tick = index // step
        hit = find_vs(frame, rect, templates)
        scores.append(hit.score if hit else -1.0)
        idle = reader.burst is None
        report = reader.process(frame, rect, tick * TICK)
        fires += idle and (reader.burst is not None or report is not None)
        if report is not None:
            reader.arm(tick * TICK, delay=0)
        if onset + 1 <= tick < onset + 11:
            started = time.perf_counter()
            result = check_rank(frame, rect, badge, rank_templates)
            ms.append((time.perf_counter() - started) * 1000)
            side_scores = {}
            for side, zone in zones(badge, rect[2] / rect[3]).items():
                reading = read_line(frame, rect, zone, rank_templates)
                side_scores[side] = [round(reading.medal, 3), round(reading.league, 3)]
            lines.append({"t": round((tick - onset) * TICK, 1), "rank": result["rank"],
                          "lines": result["rankEvidence"], "scores": side_scores})
    return {"resultVsMax": round(max(scores), 3), "resultVsFires": fires, "rank": lines,
            "rankMs": [round(float(np.median(ms)), 2), round(max(ms), 2)] if ms else None}


def replay_still(path: Path) -> dict[str, Any]:
    templates = ResultTemplates.load()
    image = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
    rect = _rect([image])
    hit = find_vs(image, rect, templates)
    if hit is None:
        return {"vs": None}
    pill = read_pill(image, rect, (hit.x, hit.y), templates)
    crowns = count_crowns(crown_scores(image, rect, (hit.x, hit.y), templates))
    return {"vs": round(hit.score, 3), "icon": pill.icon, "iconScore": round(pill.icon_score, 3), "sign": pill.sign,
            "ratio": None if pill.ratio is None else round(pill.ratio, 2), "crowns": crowns}


def _evaluate_end(item: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
    truth = item["truth"]
    onset, shift = truth["onset"], truth["shift"]
    wrong, unknown, false, late, delays, sign_margins, last_reads = 0, 0, 0, 0, [], [], []
    for run in item["runs"]:
        # A burst that starts while the result screen is shown (onset .. shift)
        # is the real one; anything else fired on a non-result screen.
        real = [r for r in run["reports"] if onset is not None and onset - 0.1 <= r["startS"] <= shift]
        false += len(run["reports"]) - len(real)
        if len(real) != 1 or real[0]["report"] is None:
            unknown += 1
            continue
        report = real[0]["report"]
        delays.append(round(real[0]["startS"] - onset, 3))
        outcome = report["outcome"]
        if outcome == "unknown":
            unknown += 1
        elif outcome != expected["outcome"]:
            wrong += 1
        evidence = report["evidence"]
        if evidence["deltaSign"] is not None and evidence["deltaSign"] != expected["sign"]:
            wrong += 1
        crowns = evidence["crowns"]
        if crowns["top"] is not None and [crowns["top"], crowns["bottom"]] != expected["crowns"]:
            wrong += 1
        trace = real[0]["trace"]
        # Read before the shift: no sample is taken once the screen moves.
        if shift is None or not trace or real[0]["startS"] + trace[-1][0] > shift + 1e-6:
            late += 1
        else:
            last_reads.append(round(shift - real[0]["startS"] - trace[-1][0], 3))
        confirm = next((b[0] for a, b in zip(trace, trace[1:])
                        if a[3] and b[3] and a[4] is not None and a[4] == b[4]), None)
        if confirm is not None and shift is not None:
            sign_margins.append(round(shift - (real[0]["startS"] + confirm), 3))
    return {"wrong": wrong, "unknown": unknown, "falseReports": false, "readAfterShift": late,
            "lastReadBeforeShiftS": [min(last_reads), max(last_reads)] if last_reads else None,
            "fireDelayS": [min(delays), max(delays)] if delays else None,
            "signToShiftS": [min(sign_margins), max(sign_margins)] if sign_margins else None}


# Wired runtime: a profile with the VS recording's setup layout plus a layout
# transplanted (in interface units) to the end clip's game; the VS recording,
# then the end clip 40 s later, run through the worker's FrameEvents.
WIRED_PREFIX = {"own": "windowed_1080x1920", "spectate": "spectate_1"}
WIRED_END_START_S = 40.0
WIRED_HOLD_S = 1.0


def _units_badge(badge: dict[str, float], aspect: float, target: float) -> dict[str, float]:
    """The same badge in interface units, expressed in another game aspect."""
    unit, target_unit = min(1.0, aspect * 16 / 9), min(1.0, target * 16 / 9)
    return Badge(0.5 + (badge["cx"] - 0.5) * aspect / unit * target_unit / target,
                 0.5 + (badge["cy"] - 0.5) / unit * target_unit,
                 badge["width"] * aspect / unit * target_unit / target,
                 badge["height"] / unit * target_unit).to_dict()


def _transplanted_layout(layout: dict[str, Any], game, key: str) -> dict[str, Any]:
    import uuid
    badge = _units_badge(layout["badge"], layout["gameAspect"], game.aspect)
    trigger = OrientationTrigger.from_dict(layout["trigger"])
    trigger.badge = Badge(**badge)
    zones = regions(Badge(**badge), game.aspect)
    return {**layout, "layoutId": str(uuid.uuid5(uuid.NAMESPACE_URL, "cr-tools-c3-wired:" + key)),
            "layoutSource": "learned", "gameAspect": game.aspect, "windowChrome": game.chrome,
            "regions": {"trigger": zones["trigger"].to_dict(), "nicknameRegion": zones["nickname"].to_dict(),
                        "topLeftEvidenceRegion": zones["topLeftEvidence"].to_dict()},
            "trigger": trigger.to_dict(), "badge": badge}


def wired_prefixes(vs_manifest: Path, keys: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Setup layouts of the prefix VS recordings (M9 replay setup path)."""
    from tools.m9_replay import _runtime_profile, decode
    records = {r["key"]: r for r in json.loads(vs_manifest.read_text(encoding="utf-8"))["recordings"]}
    prefixes = {}
    for role, key in keys.items():
        path = vs_manifest.parent / records[key]["path"]
        layout, setup = _runtime_profile(decode(path), records[key])
        if layout is None:
            raise ValueError(f"Wired prefix setup failed: {setup.get('code')}")
        prefixes[role] = {"key": key, "path": str(path), "layout": layout}
    return prefixes


def _ticks(path: Path):
    """(time, frame) at the production 0.1 s sampling, streamed."""
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS)
    try:
        index, next_time = 0, 0.0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if index / fps + 1e-6 >= next_time:
                yield round(next_time, 1), frame
                next_time += TICK
            index += 1
    finally:
        capture.release()


def replay_wired_end_clip(path: Path, record: dict[str, Any], prefixes: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Own and spectate prefixes × six phases through TriggerEngine + FrameEvents;
    every event passes `encode_event`; image-free events are returned whole."""
    import uuid
    from tools.m9_replay import REPLAY_TIMESTAMP, _runtime_payload
    from monitor_engine import FrameEvents
    from monitor_protocol import encode_event, validate_start_payload
    from trigger_engine import TriggerEngine
    fps, _, _ = _info(path)
    capture = cv2.VideoCapture(str(path))
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    sampled = []
    for index in np.linspace(0, count - 2, 8).round().astype(int):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
        ok, frame = capture.read()
        if ok:
            sampled.append(frame)
    capture.release()
    game = detect(sampled)
    runs: dict[tuple[str, int], dict[str, Any]] = {}
    for role, prefix in prefixes.items():
        payload = _runtime_payload(prefix["layout"], learning=False)
        payload["primary"]["layouts"].append(_transplanted_layout(prefix["layout"], game, record["key"] + role))
        payload = validate_start_payload(payload)
        for phase in range(PHASES):
            runs[(role, phase)] = {"frames": FrameEvents(TriggerEngine(payload)), "events": [], "sequence": 0,
                                   "session": str(uuid.uuid4()), "ms": []}

    def feed(run, frame, now, segment):
        started = time.perf_counter()
        emitted = run["frames"].process(frame, now, REPLAY_TIMESTAMP, str(uuid.uuid4()))
        run["ms"].append((time.perf_counter() - started) * 1000)
        for event_type, event_payload in emitted:
            run["sequence"] += 1
            line = encode_event(run["session"], run["sequence"], event_type, event_payload)
            if event_type in ("triggered", "prediction_result"):
                entry = {"segment": segment, "t": round(now, 3), "event": json.loads(line)}
                if event_type == "prediction_result":
                    diagnostics = run["frames"].engine.result_reader.diagnostics
                    trace = diagnostics["trace"]
                    entry["diagnostics"] = {
                        "endReason": diagnostics["endReason"],
                        "startS": round(diagnostics["startS"] - WIRED_END_START_S, 3),
                        "lastReadS": round(diagnostics["startS"] - WIRED_END_START_S + trace[-1][0], 3)
                        if trace else None}
                run["events"].append(entry)

    for role, prefix in prefixes.items():
        for now, frame in _ticks(Path(prefix["path"])):
            for phase in range(PHASES):
                feed(runs[(role, phase)], frame, now, "vs")
    step = round(fps * TICK)
    last = None
    for index, frame in _frames(path):
        phase = index % step
        last = frame
        if phase < PHASES:
            for role in prefixes:
                feed(runs[(role, phase)], frame, WIRED_END_START_S + index / fps, "end")
                runs[(role, phase)]["last"] = WIRED_END_START_S + index / fps
    # Some clips stop < 0.6 s after the shift; the real screen stays, so the
    # last frame is held for WIRED_HOLD_S (the worker sends no report on stop).
    for run in runs.values():
        for tick in range(1, round(WIRED_HOLD_S / TICK) + 1):
            feed(run, last, run["last"] + tick * TICK, "end")
    cells = []
    for (role, phase), run in runs.items():
        events = run["events"]
        battle = [e["event"]["payload"] for e in events if e["segment"] == "vs" and e["event"]["type"] == "triggered"]
        results = [e for e in events if e["event"]["type"] == "prediction_result"]
        cells.append({
            "role": role, "phase": phase, "gameAspect": round(game.aspect, 4),
            "vsFires": [{"kind": p["kind"], "rank": p["rank"], "rankEvidence": p["rankEvidence"]} for p in battle],
            "endFires": sum(e["segment"] == "end" and e["event"]["type"] == "triggered" for e in events),
            "results": [{**e["diagnostics"],
                         "battleIdIsOwnVs": e["event"]["payload"]["battleId"] in
                         [p["triggerId"] for p in battle if p["kind"] == "battle"],
                         **{k: e["event"]["payload"][k] for k in ("gap", "outcome", "evidence")}} for e in results],
            "msMedian": round(float(np.median(run["ms"])), 2), "msP95": round(float(np.percentile(run["ms"], 95)), 2),
            "protocolEvents": [e["event"] for e in events],
        })
    return {"cells": cells}


def _evaluate_wired(item: dict[str, Any], expected: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    """Truth (onset/shift) comes from the independent 60 FPS pass of the clip."""
    own = [cell for cell in item["cells"] if cell["role"] == "own"]
    spectate = [cell for cell in item["cells"] if cell["role"] == "spectate"]
    onset, shift = truth["onset"], truth["shift"]
    ok_own = sum(
        len(cell["results"]) == 1 and cell["results"][0]["outcome"] == expected["outcome"]
        and cell["results"][0]["battleIdIsOwnVs"] and cell["results"][0]["gap"] is False
        and cell["results"][0]["evidence"]["crowns"]["top"] in (None, expected["crowns"][0])
        and cell["results"][0]["evidence"]["crowns"]["bottom"] in (None, expected["crowns"][1])
        and onset - 0.1 <= cell["results"][0]["startS"] <= shift
        and any(fire["kind"] == "battle" and fire["rankEvidence"] is not None for fire in cell["vsFires"])
        for cell in own)
    reads = [r for cell in own for r in cell["results"] if r["lastReadS"] is not None]
    return {"ownCorrect": ok_own, "ownRuns": len(own),
            "readAfterShift": sum(r["lastReadS"] > shift + 1e-6 for r in reads),
            "lastReadBeforeShiftS": [round(min(shift - r["lastReadS"] for r in reads), 3),
                                     round(max(shift - r["lastReadS"] for r in reads), 3)] if reads else None,
            "fireDelayS": [round(min(r["startS"] for r in reads) - onset, 3),
                           round(max(r["startS"] for r in reads) - onset, 3)] if reads else None,
            "spectateResults": sum(len(cell["results"]) for cell in spectate),
            "spectateRanked": sum(fire["rankEvidence"] is not None for cell in spectate for fire in cell["vsFires"]),
            "spectateVsFires": sum(len(cell["vsFires"]) for cell in spectate),
            "endFires": sum(cell["endFires"] for cell in item["cells"]),
            "endReasons": sorted({r["endReason"] for cell in own for r in cell["results"]}),
            "tickMsP95Max": max(cell["msP95"] for cell in item["cells"])}


def c3_replay(manifest: Path, output: Path) -> dict[str, Any]:
    output = output.resolve()
    if any((parent / ".git").exists() for parent in (output, *output.parents)):
        raise ValueError("Replay output must be outside a Git repository")
    document = json.loads(manifest.read_text(encoding="utf-8"))
    base = manifest.parent
    vs_manifest = base / document["vsManifest"] if document.get("vsManifest") else None
    vs_records = json.loads(vs_manifest.read_text(encoding="utf-8"))["recordings"] if vs_manifest else []
    result: dict[str, Any] = {"mode": "c3", "tickS": TICK, "phases": PHASES, "results": {}, "vs": {}, "stills": {},
                              "wired": {}}
    prefixes = wired_prefixes(vs_manifest, document.get("wired", WIRED_PREFIX)) if vs_manifest else {}
    protocol_events: list[dict[str, Any]] = []
    with ProcessPoolExecutor(max_workers=6) as pool:
        scales = sorted(document.get("scales", [1.0]), key=lambda value: value != 1.0)
        if scales[0] != 1.0:
            raise ValueError("scales must include 1.0")
        ends = {(r["key"], scale): pool.submit(replay_end_clip, base / r["path"], vs_manifest if scale == 1.0 else None,
                                               scale)
                for r in document["results"] for scale in scales}
        vss = {r["key"]: pool.submit(replay_vs_clip, vs_manifest.parent / r["path"], r) for r in vs_records}
        wired = {r["key"]: pool.submit(replay_wired_end_clip, base / r["path"], r, prefixes)
                 for r in document["results"]} if prefixes else {}
        for record in document["results"]:
            for scale in scales:
                key = record["key"] if scale == 1.0 else f"{record['key']}@{scale:g}"
                item = ends[(record["key"], scale)].result()
                item["scale"] = scale
                scores = item.pop("scores")
                if scale != 1.0:
                    item["selfOnsetS"] = item["truth"]["onset"]
                    item["truth"] = _anchored_truth(scores, item["fps"], result["results"][record["key"]]["truth"])
                item["evaluation"] = _evaluate_end(item, record)
                result["results"][key] = item
                print(key, json.dumps(item["evaluation"]), flush=True)
        for record in vs_records:
            result["vs"][record["key"]] = vss[record["key"]].result()
        for record in document["results"]:
            if record["key"] not in wired:
                continue
            item = wired[record["key"]].result()
            for cell in item["cells"]:
                protocol_events += cell.pop("protocolEvents")
            item["evaluation"] = _evaluate_wired(item, record, result["results"][record["key"]]["truth"])
            result["wired"][record["key"]] = item
            print("wired", record["key"], json.dumps(item["evaluation"]), flush=True)
    for still in document.get("stills", []):
        cell = replay_still(base / still["path"])
        # Stills are single mid-animation frames: only the pill is judged.
        cell["signCorrect"] = cell.get("sign") == still.get("sign")
        result["stills"][still["key"]] = cell
    result["acceptance"] = _acceptance(result, document)
    output.mkdir(parents=True, exist_ok=True)
    (output / "results.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    # Image-free protocol events of the wired runs, for the TypeScript contract check.
    (output / "wired-events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in protocol_events),
                                               encoding="utf-8")
    print(json.dumps(result["acceptance"], indent=1))
    return result


def _acceptance(result: dict[str, Any], document: dict[str, Any]) -> dict[str, Any]:
    ends = result["results"].values()
    evaluation = [item["evaluation"] for item in ends]
    battle_fires = sum(cell["fires"] for item in ends if item["battleTrigger"]
                       for key, cell in item["battleTrigger"].items() if key != "vsFinder" and cell["kind"] == "battle")
    spectate_fires = sum(cell["fires"] for item in ends if item["battleTrigger"]
                         for key, cell in item["battleTrigger"].items() if key != "vsFinder" and cell["kind"] == "spectate")
    rank_wrong, rank_unknown, rank_total = 0, 0, 0
    for key, item in result["vs"].items():
        expected = document.get("vsExpected", {}).get(key)
        if expected is None:
            continue
        want = rank_from_lines(expected["opponent"], expected["own"])
        for sample in item["rank"]:
            rank_total += 1
            if sample["rank"] == "unknown":
                rank_unknown += 1
            elif sample["rank"] != want:
                rank_wrong += 1
    checks = {
        "noWrongOutcome": sum(e["wrong"] for e in evaluation) == 0,
        "noFalseReports": sum(e["falseReports"] for e in evaluation) == 0
        and all(item["truth"].get("nonResultFires", 0) == 0 for item in ends),
        "readBeforeShift": sum(e["readAfterShift"] for e in evaluation) == 0,
        "resultVsSilentOnBattleVs": all(item["resultVsFires"] == 0 for item in result["vs"].values()),
        "battleTriggerSilentOnResults": battle_fires == 0,
        "rankNoWrong": rank_wrong == 0,
        "rankUnknownAtMost10Pct": rank_total > 0 and rank_unknown <= 0.10 * rank_total,
        "burstCpuUnder1500Ms": all(max(item["burstMs"], default=0) <= 1500 for item in ends),
        "stillsPill": all(cell["signCorrect"] for cell in result["stills"].values()),
        "stillsVsSilent": all(still.get("sign") or (result["stills"][still["key"]]["vs"] or 0) < VS_FIRE_T
                              for still in document.get("stills", [])),
    }
    wired = [item["evaluation"] for item in result["wired"].values()]
    if document.get("vsManifest"):
        checks.update({
            "wiredOwnResultCorrect": len(wired) == len(document["results"])
            and all(e["ownCorrect"] == e["ownRuns"] == PHASES for e in wired),
            "wiredSpectateNeverArmsOrRanks": all(e["spectateResults"] == 0 and e["spectateRanked"] == 0
                                                 and e["spectateVsFires"] > 0 for e in wired),
            "wiredNoVsFireOnResults": all(e["endFires"] == 0 for e in wired),
            "wiredReadBeforeShift": all(e["readAfterShift"] == 0 for e in wired),
        })
    return {"passed": all(checks.values()), "checks": checks,
            "unknownRuns": sum(e["unknown"] for e in evaluation), "runs": PHASES * len(evaluation),
            "spectateProfileFiresOnResults": spectate_fires,
            "rank": {"samples": rank_total, "wrong": rank_wrong, "unknown": rank_unknown},
            "wiredRuns": sum(e["ownRuns"] * 2 for e in wired)}
