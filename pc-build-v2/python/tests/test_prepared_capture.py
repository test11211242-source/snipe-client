from __future__ import annotations

import pytest

from prepared_capture import LatestFrameStore, validate_command
from protocol.framing import ProtocolError


class FakeFrame:
    shape = (720, 1280, 4)

    def __init__(self, token: str) -> None:
        self.token = token

    def copy(self) -> "FakeFrame":
        return FakeFrame(f"copy:{self.token}")


def test_latest_frame_store_freezes_the_last_published_copy() -> None:
    store = LatestFrameStore()
    assert store.publish(FakeFrame("first")) == (True, 1, 1280, 720)
    assert store.publish(FakeFrame("second")) == (False, 2, 1280, 720)

    frozen, sequence = store.freeze()
    assert sequence == 2
    assert frozen.token == "copy:second"
    assert store.publish(FakeFrame("late"))[0] is False


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
