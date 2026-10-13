from __future__ import annotations

import pytest
import numpy as np

from prepared_capture import LatestFrameStore, validate_command
from protocol.framing import ProtocolError




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
            "protocolVersion": 1,
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
                "protocolVersion": 1,
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
