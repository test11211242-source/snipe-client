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
