from __future__ import annotations

import io
import threading
import time
from types import SimpleNamespace
import pytest
import numpy as np

from capture.backend import CaptureBackendError
import prepared_capture
from prepared_capture import LatestFrameStore, validate_command
from protocol.framing import ProtocolError, read_stream_envelope, write_envelope




def test_latest_frame_store_freezes_the_last_published_copy() -> None:
    store = LatestFrameStore()
    first = np.full((720, 1280, 4), 1, np.uint8)
    second = np.full((720, 1280, 4), 2, np.uint8)
    assert store.publish(first) == (True, 1, 1280, 720)
    assert store.publish(second) == (False, 2, 1280, 720)
    second[:] = 9

    frozen, sequence = store.freeze()
    assert sequence == 2
    assert frozen.shape == (720, 1280, 3)
    assert np.all(frozen == 2)
    assert store.publish(first)[0] is False


def test_prepared_capture_commands_are_strict() -> None:
    session_id, command_type = validate_command(
        {
            "protocolVersion": 2,
            "sessionId": "session",
            "type": "start",
            "selector": {"kind": "window", "windowHwnd": "123"},
        },
        "start",
    )
    assert (session_id, command_type) == ("session", "start")
    with pytest.raises(ProtocolError):
        validate_command(
            {
                "protocolVersion": 2,
                "sessionId": "session",
                "type": "freeze",
                "unexpected": True,
            }
        )


def test_freeze_geometry_history_is_bounded_and_time_spread() -> None:
    from synthetic_frames import arena, framed

    store = LatestFrameStore()
    for index in range(40):
        image, _ = arena(seed=index, badge=False)
        frame, expected = framed(image, mixed=True)
        store.publish(frame, timestamp=index * .1)
    frame, _ = store.freeze()
    game = store.game(frame)
    assert game["rect"] == dict(zip(("x", "y", "width", "height"), expected))
    assert 8 <= game["frames"] <= 9
    assert len(store._history) == 8
    assert game["chrome"]["top"] == 0


def test_freeze_rejects_insufficient_and_changed_size_history() -> None:
    from synthetic_frames import arena

    store = LatestFrameStore()
    image, _ = arena(badge=False)
    for index in range(20):
        store.publish(image, timestamp=index * .01)
    frame, _ = store.freeze()
    assert store.game(frame) == {"rect": None, "reason": "insufficient_frames"}
    store = LatestFrameStore()
    for index in range(8):
        store.publish(image, timestamp=index * .31)
    smaller, _ = arena(180, 320, badge=False)
    store.publish(smaller, timestamp=3)
    frame, _ = store.freeze()
    assert store.game(frame)["reason"] == "insufficient_frames"


def test_freeze_rejects_unstable_geometry() -> None:
    from synthetic_frames import arena, framed

    store = LatestFrameStore()
    image, _ = arena(badge=False)
    frame, _ = framed(image)
    for index in range(8):
        store.publish(frame, timestamp=index * .31)
    changed = frame.copy()
    changed[24:64] = 0  # Last frame appears shorter; the temporal union still contains it.
    store.publish(changed, timestamp=2.3)
    frozen, _ = store.freeze()
    assert store.game(frozen) == {"rect": None, "reason": "unstable"}


def test_freeze_compares_like_geometry_with_trimmed_chrome() -> None:
    from synthetic_frames import arena, framed
    from geometry.game_rect import detect, pixel_rect

    store = LatestFrameStore()
    frames = []
    for index in range(9):
        image, _ = arena(seed=index, badge=False)
        # Ensure temporal motion reaches the documented chrome threshold.
        image = np.clip(image.astype(np.int16) + (index % 2) * 80, 0, 255).astype(np.uint8)
        frame, expected = framed(image, toolbar=24)
        frames.append(frame)
        store.publish(frame, timestamp=index * .31)
    frozen, _ = store.freeze()
    game = store.game(frozen)
    assert expected == (40, 48, 360, 640)
    assert game["rect"] == pixel_rect(expected)
    reference = detect(frames[-8:])
    assert game["aspect"] == reference.aspect
    assert game["chrome"] == reference.chrome


def test_history_drops_alpha_without_losing_temporal_geometry() -> None:
    store = LatestFrameStore()
    frame = np.zeros((2160, 3840, 4), np.uint8)
    for index in range(9):
        store.publish(frame, timestamp=index * .31)
    assert store._latest.shape == (2160, 3840, 3)
    assert len(store._history) == 8
    assert all(sample.shape == (2160, 3840, 3) for _, sample in store._history)
    assert sum(sample.nbytes for _, sample in store._history) == 8 * 2160 * 3840 * 3
    assert store._history[-1][1] is store._latest


def test_history_wait_deadline_keeps_static_source_insufficient() -> None:
    store = LatestFrameStore()
    store.publish(np.zeros((32, 32, 3), np.uint8))
    started = time.monotonic()
    store.wait_for_history(timeout=0.03)
    assert 0.025 <= time.monotonic() - started < 0.5
    frame, _ = store.freeze()
    assert store.game(frame) == {"rect": None, "reason": "insufficient_frames"}
    assert len(store._history) == 1


def test_source_closing_wakes_history_wait_without_a_frame() -> None:
    store = LatestFrameStore()
    closer = threading.Timer(0.03, store.close_source)
    closer.start()
    started = time.monotonic()
    try:
        with pytest.raises(CaptureBackendError) as error:
            store.wait_for_history()
        assert error.value.code == "CAPTURE_SOURCE_STALE"
        assert time.monotonic() - started < 0.5
    finally:
        closer.join()


def test_prepare_then_immediate_freeze_live_backend_real_clock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from setup_contract_harness import run_prepared

    commands = io.BytesIO()
    session_id = "real-clock-retake"
    write_envelope(commands, {
        "protocolVersion": 2, "sessionId": session_id, "type": "start",
        "selector": {"kind": "window", "windowHwnd": "123"},
    })
    write_envelope(commands, {
        "protocolVersion": 2, "sessionId": session_id, "type": "freeze",
    })
    commands.seek(0)
    events = io.BytesIO()
    monkeypatch.setattr(prepared_capture.sys, "stdin", SimpleNamespace(buffer=commands))
    monkeypatch.setattr(prepared_capture.sys, "stdout", SimpleNamespace(buffer=events))
    # The harness replaces only capture IO; restore its backend after the test.
    monkeypatch.setattr(prepared_capture, "WindowsMonitorBackend", prepared_capture.WindowsMonitorBackend)
    started = time.monotonic()
    run_prepared("prepared-real-clock")
    elapsed = time.monotonic() - started
    events.seek(0)
    ready = read_stream_envelope(events, max_binary_bytes=0)
    frozen = read_stream_envelope(events, max_binary_bytes=prepared_capture.MAX_PNG_BYTES)
    assert ready.metadata["type"] == "ready"
    assert frozen.metadata["type"] == "frozen"
    assert ready.metadata["payload"]["frameSequence"] == 1
    assert frozen.metadata["payload"]["game"]["rect"] == {
        "x": 40, "y": 48, "width": 180, "height": 320,
    }
    assert frozen.metadata["payload"]["game"]["frames"] >= 8
    assert 2.1 <= elapsed <= 3


def test_protocol_two_cancel_fence_and_retry_keep_backend_alive(monkeypatch):
    commands, events = io.BytesIO(), io.BytesIO()
    session = "live-retry"
    for command in (
        {"type": "start", "selector": {"kind": "window", "windowHwnd": "123"}},
        {"type": "analyze", "deadlineMs": 60000, "targetFps": 10},
        {"type": "analyze_cancel"},
        {"type": "analyze", "deadlineMs": 60000, "targetFps": 10},
        {"type": "analyze_cancel"},
        {"type": "stop"},
    ):
        write_envelope(commands, {"protocolVersion": 2, "sessionId": session, **command})
    commands.seek(0)
    stopped = []

    class Backend:
        def __init__(self, selector):
            assert selector == {"kind": "window", "windowHwnd": "123"}

        def start(self, on_frame, _on_closed):
            on_frame(np.zeros((32, 32, 3), np.uint8))

        def stop(self):
            stopped.append(True)

    monkeypatch.setattr(prepared_capture, "WindowsMonitorBackend", Backend)
    monkeypatch.setattr(prepared_capture.sys, "stdin", SimpleNamespace(buffer=commands))
    monkeypatch.setattr(prepared_capture.sys, "stdout", SimpleNamespace(buffer=events))
    prepared_capture.main()
    events.seek(0)
    envelopes = []
    while events.tell() < len(events.getvalue()):
        envelopes.append(read_stream_envelope(events, max_binary_bytes=prepared_capture.MAX_PNG_BYTES))
    types = [envelope.metadata["type"] for envelope in envelopes]
    assert types[0] == "ready"
    assert types[-2:] == ["analysis_cancelled", "stopped"]
    assert types.count("analysis_cancelled") == 2
    assert "analysis_result" not in types and "fatal" not in types
    assert stopped == [True]
    assert all(envelope.metadata["protocolVersion"] == 2 for envelope in envelopes)
    assert [envelope.metadata["sequence"] for envelope in envelopes] == list(range(1, len(envelopes) + 1))
