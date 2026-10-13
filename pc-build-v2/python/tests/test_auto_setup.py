from __future__ import annotations

from dataclasses import replace
import os
from pathlib import Path
import threading
import time

import cv2
import numpy as np
import pytest

import auto_setup
from auto_setup import AutoSetupEngine, DEADLINE_MS, LiveAnalysis, encode_preview
from geometry.game_rect import RectResult
from geometry.vs_orient_trigger import OrientationTrigger
from prepared_capture import LatestFrameStore, validate_command
from protocol.framing import ProtocolError
from synthetic_frames import arena, framed


def feed_vs(engine, *, cy=.429, following=True):
    frames = []
    for index in range(40):
        image, _ = arena(seed=index, badge=False)
        frame, _ = framed(image, mixed=True)
        assert engine.process(frame, index / 10) is None
    outcome = None
    for index in range(40, 44 if following else 43):
        image, _ = arena(seed=index, cy=cy)
        frame, _ = framed(image, mixed=True)
        frames.append(frame)
        outcome = engine.process(frame, index / 10)
        if outcome is not None:
            break
    return outcome, frames


def test_actual_finder_acceptance_success_keeps_confirmation_not_following_frame():
    engine = AutoSetupEngine(0)
    outcome, frames = feed_vs(engine)
    assert outcome is not None and outcome.result["ok"]
    result = outcome.result
    assert result["timings"] == {"onsetMs": 4000, "confirmMs": 4200}
    assert outcome.frame is frames[2]
    assert not np.array_equal(outcome.frame, frames[3])
    assert result["frameWidth"] == outcome.frame.shape[1]
    assert result["frameHeight"] == outcome.frame.shape[0]
    assert result["selfCheck"]["minVs"] >= .5
    assert result["selfCheck"]["maxBefore"] < .3
    assert result["selfCheck"]["frames"] >= 3
    assert 0 <= result["confidence"] <= 1
    assert set(result["regions"]) == {"trigger", "nickname", "topLeftEvidence"}
    # Nickname bytes are extracted only from this retained confirmation frame.
    zone, rect = result["regions"]["nickname"], result["game"]["rect"]
    x, y = rect["x"] + round(zone["x"] * rect["width"]), rect["y"] + round(zone["y"] * rect["height"])
    w, h = round(zone["width"] * rect["width"]), round(zone["height"] * rect["height"])
    assert np.array_equal(outcome.frame[y:y+h, x:x+w], frames[2][y:y+h, x:x+w])


def test_confirmation_waits_for_following_frame():
    engine = AutoSetupEngine(0)
    outcome, _ = feed_vs(engine, following=False)
    assert outcome is None
    assert engine.phase == "verifying"
    assert engine.outcome is None


def test_spectate_rejection_preserves_candidate_frame_geometry_and_zones():
    engine = AutoSetupEngine(0)
    outcome, frames = feed_vs(engine, cy=.523)
    assert outcome.result["code"] == "AUTO_SPECTATE_LIKE"
    assert not outcome.result["ok"]
    assert outcome.frame is frames[2]
    assert outcome.result["game"]["rect"] == {"x": 40, "y": 24, "width": 360, "height": 640}
    assert outcome.result["badge"]["cy"] >= .46
    assert outcome.result["regions"]["nickname"]["height"] > 0


@pytest.mark.parametrize("failure", ["AUTO_TRIGGER_WEAK", "AUTO_SELF_CHECK_FAILED"])
def test_shared_acceptance_failures_keep_confirmation(monkeypatch, failure):
    original = OrientationTrigger.build.__func__

    def build(cls, frame, rect, badge):
        trigger = original(cls, frame, rect, badge)
        if failure == "AUTO_TRIGGER_WEAK":
            return replace(trigger, mask_area_ratio=.1)
        trigger.score = lambda *_args: .4
        return trigger

    monkeypatch.setattr(OrientationTrigger, "build", classmethod(build))
    outcome, frames = feed_vs(AutoSetupEngine(0))
    assert outcome.result["code"] == failure
    assert outcome.frame is frames[2]


def test_geometry_requires_eight_genuine_spaced_frames():
    engine = AutoSetupEngine(0)
    image, _ = arena(badge=False)
    for index in range(40):
        engine.process(image, index / 1000)
    assert len(engine._geometry) == 1
    assert engine.deadline().result == {"ok": False, "code": "AUTO_GAME_NOT_FOUND"}


def test_no_vs_deadline_is_elapsed_time_not_frame_count():
    engine = AutoSetupEngine(10)
    for index in range(30):
        image, _ = arena(seed=index, badge=False)
        assert engine.process(image, 10 + index / 10) is None
    assert engine.process(image, 69.99) is None
    outcome = engine.process(image, 70)
    assert outcome.result == {"ok": False, "code": "AUTO_VS_TIMEOUT"}
    assert outcome.frame is None
    assert engine.progress(100)["elapsedMs"] == DEADLINE_MS


def test_unsupported_aspect_deadline():
    engine = AutoSetupEngine(0)
    image, _ = arena(360, 360, badge=False)
    for index in range(30):
        engine.process(image, index / 10)
    assert engine.deadline().result["code"] == "AUTO_ASPECT_UNSUPPORTED"


def test_changed_frame_size_discards_geometry_evidence():
    engine = AutoSetupEngine(0)
    for index in range(30):
        image, _ = arena(seed=index, badge=False)
        engine.process(image, index / 10)
    image, _ = arena(180, 320, badge=False)
    engine.process(image, 3)
    assert len(engine._geometry) == 1
    assert engine.deadline().result["code"] == "AUTO_GAME_NOT_FOUND"


def test_worker_deadline_with_no_new_frame():
    ticks = iter((0, 0, 60))
    events = []
    worker = LiveAnalysis(LatestFrameStore(), lambda *event: events.append(event), clock=lambda: next(ticks, 60))
    worker.start()
    worker.thread.join(timeout=1)
    assert not worker.thread.is_alive()
    assert events[-1] == ("analysis_result", {"ok": False, "code": "AUTO_GAME_NOT_FOUND"}, b"")


def test_source_lost_returns_named_result_without_stopping_store():
    store = LatestFrameStore()
    store.close_source()
    events = []
    worker = LiveAnalysis(store, lambda *event: events.append(event))
    worker.start()
    worker.thread.join(timeout=1)
    assert events == [("analysis_result", {"ok": False, "code": "AUTO_SOURCE_LOST"}, b"")]



def test_transient_minimizes_reset_the_iconic_grace_period():
    ticks = iter([0, *[index / 8 for index in range(24)], 60])
    now = [0.0]
    polls, events = [], []

    def clock():
        now[0] = next(ticks, 60)
        return now[0]

    def is_iconic():
        polls.append(now[0])
        return now[0] < .75 or 1 <= now[0] < 1.75

    worker = LiveAnalysis(LatestFrameStore(), lambda *event: events.append(event),
                          clock=clock, is_iconic=is_iconic)
    worker.start()
    worker.thread.join(timeout=1)
    assert not worker.thread.is_alive()
    assert events[-1] == ("analysis_result", {"ok": False, "code": "AUTO_GAME_NOT_FOUND"}, b"")
    assert polls[:8] == [index / 4 for index in range(8)]
    assert all(b - a >= .25 for a, b in zip(polls, polls[1:]))


def test_persistent_minimize_reports_source_lost_after_one_second_without_frames():
    ticks = iter([0, *[index / 8 for index in range(16)]])
    now = [0.0]
    polls, events = [], []

    def clock():
        now[0] = next(ticks, 2)
        return now[0]

    def is_iconic():
        polls.append(now[0])
        return True

    worker = LiveAnalysis(LatestFrameStore(), lambda *event: events.append(event),
                          clock=clock, is_iconic=is_iconic)
    worker.start()
    worker.thread.join(timeout=1)
    assert not worker.thread.is_alive()
    assert polls == [0, .25, .5, .75, 1]
    assert events[-1] == ("analysis_result", {"ok": False, "code": "AUTO_SOURCE_LOST"}, b"")
    assert worker.store.snapshot()[2] is False


@pytest.mark.parametrize("is_iconic", [None, lambda: False], ids=["display", "restored-window"])
def test_static_capture_without_new_frames_is_not_source_loss(is_iconic):
    ticks = iter((0, 0, .5, 1, 1.5, 60))
    events = []
    worker = LiveAnalysis(LatestFrameStore(), lambda *event: events.append(event),
                          clock=lambda: next(ticks, 60), is_iconic=is_iconic)
    worker.start()
    worker.thread.join(timeout=1)
    assert not worker.thread.is_alive()
    assert events[-1] == ("analysis_result", {"ok": False, "code": "AUTO_GAME_NOT_FOUND"}, b"")


def test_cancel_then_retry_leaves_capture_live():
    store = LatestFrameStore()
    image = np.zeros((32, 32, 3), np.uint8)
    store.publish(image)
    started = threading.Event()
    events = []

    def emit(*event):
        events.append(event)
        started.set()

    worker = LiveAnalysis(store, emit)
    worker.start()
    assert started.wait(1)
    worker.cancel()
    count = len(events)
    store.publish(image + 1)
    time.sleep(.03)
    assert len(events) == count
    assert not worker.thread.is_alive()
    assert store.snapshot()[1:] == (2, False)
    retry = LiveAnalysis(store, emit)
    retry.start()
    retry.cancel()
    frozen, sequence = store.freeze()
    assert sequence == 2 and np.all(frozen == 1)
    assert not any(event[0] == "analysis_result" for event in events)


def test_progress_and_preview_are_throttled(monkeypatch):
    clock_value = [0.0]
    sequence = [0]
    image = np.zeros((32, 32, 3), np.uint8)

    class Store:
        def snapshot(self):
            sequence[0] += 1
            clock_value[0] += .1
            return image, sequence[0], sequence[0] >= 31

    monkeypatch.setattr(AutoSetupEngine, "process", lambda *_args: None)
    events = []
    worker = LiveAnalysis(Store(), lambda *event: events.append((clock_value[0], event)), clock=lambda: clock_value[0])
    worker.start()
    worker.thread.join(timeout=2)
    assert not worker.thread.is_alive()
    for kind, interval in (("analysis_progress", .5), ("analysis_preview", 1.0)):
        timestamps = [timestamp for timestamp, event in events if event[0] == kind]
        assert len(timestamps) >= 2
        assert all(b - a >= interval - 1e-9 for a, b in zip(timestamps, timestamps[1:]))


def test_preview_is_bounded_jpeg():
    payload, binary = encode_preview(np.zeros((1920, 1080, 3), np.uint8))
    decoded = cv2.imdecode(np.frombuffer(binary, np.uint8), cv2.IMREAD_COLOR)
    assert max(decoded.shape[:2]) == 640
    assert payload == {"width": 360, "height": 640, "mimeType": "image/jpeg", "byteLength": len(binary)}


@pytest.mark.parametrize("changes", [
    {"protocolVersion": 1}, {"protocolVersion": True}, {"deadlineMs": 5000}, {"targetFps": 5},
    {"deadlineMs": 60000.0}, {"targetFps": 10.0}, {"payload": {}}, {"selector": {}},
])
def test_strict_protocol2_analysis_commands(changes):
    command = {"protocolVersion": 2, "sessionId": "session", "type": "analyze", "deadlineMs": 60000, "targetFps": 10}
    assert validate_command(command) == ("session", "analyze")
    with pytest.raises(ProtocolError):
        validate_command({**command, **changes})


@pytest.mark.parametrize("kind", ["freeze", "stop", "analyze_cancel"])
def test_no_payload_commands_are_strict(kind):
    command = {"protocolVersion": 2, "sessionId": "session", "type": kind}
    assert validate_command(command) == ("session", kind)
    with pytest.raises(ProtocolError):
        validate_command({**command, "payload": {}})


@pytest.mark.replay
def test_autosetup_owner_replay(tmp_path):
    from tools.m9_replay import autosetup_replay
    manifest = os.environ.get("CR_M9_REPLAY_MANIFEST")
    if not manifest:
        pytest.skip("Set CR_M9_REPLAY_MANIFEST to the external recording manifest")
    assert autosetup_replay(Path(manifest), tmp_path)["acceptance"]["passed"]
