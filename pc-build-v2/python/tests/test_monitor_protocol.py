import io
import json
import uuid

import pytest

from monitor_protocol import MonitorProtocolError, encode_event, read_command


def payload():
    return {
        "selector": {"kind": "window", "windowHwnd": "123"},
        "configuredFrameSize": {"width": 1920, "height": 1080},
        "regions": {
            "trigger": {"x": 0, "y": 0, "width": 0.2, "height": 0.2},
            "normal": {"x": 0, "y": 0, "width": 0.5, "height": 0.5},
            "precise": {"x": 0, "y": 0, "width": 1, "height": 1},
        },
        "triggerProfile": {},
        "searchMode": "fast",
        "captureDelaySeconds": 0,
        "limits": {
            "fps": 10,
            "maxImageBytes": 10 * 1024 * 1024,
            "maxImagePixels": 20_000_000,
            "maxImageWidth": 8192,
            "maxImageHeight": 8192,
            "confirmationsNeeded": 2,
            "confirmationDecay": 0.5,
            "cooldownSeconds": 15,
        },
        "prediction": None,
    }


def line(command):
    return io.BytesIO((json.dumps(command) + "\n").encode())


def test_strict_versioned_start_and_stop() -> None:
    session_id = str(uuid.uuid4())
    start = {
        "protocolVersion": 2,
        "sessionId": session_id,
        "sequence": 0,
        "type": "start",
        "payload": payload(),
    }
    assert read_command(line(start))["payload"]["searchMode"] == "fast"
    stop = {
        "protocolVersion": 2,
        "sessionId": session_id,
        "sequence": 3,
        "type": "stop",
        "payload": {},
    }
    assert read_command(line(stop), expected_session_id=session_id)["type"] == "stop"
    triggered = json.loads(
        encode_event(
            session_id,
            2,
            "triggered",
            {"timestamp": "2026-07-12T12:00:00.000Z"},
        )
    )
    assert triggered["protocolVersion"] == 2
    assert triggered["type"] == "triggered"


def test_rejects_unknown_fields_stale_session_and_oversized_line() -> None:
    session_id = str(uuid.uuid4())
    command = {
        "protocolVersion": 2,
        "sessionId": session_id,
        "sequence": 0,
        "type": "start",
        "payload": payload(),
        "token": "secret",
    }
    with pytest.raises(MonitorProtocolError, match="fields"):
        read_command(line(command))
    command.pop("token")
    with pytest.raises(MonitorProtocolError, match="stale"):
        read_command(line(command), expected_session_id=str(uuid.uuid4()))
    with pytest.raises(MonitorProtocolError, match="oversized"):
        read_command(io.BytesIO(b"x" * (128 * 1024 + 1)))


def test_rejects_non_exact_limits_and_invalid_ratios() -> None:
    command = {
        "protocolVersion": 2,
        "sessionId": str(uuid.uuid4()),
        "sequence": 0,
        "type": "start",
        "payload": payload(),
    }
    command["payload"]["limits"]["fps"] = 30
    with pytest.raises(MonitorProtocolError, match="limits"):
        read_command(line(command))
    command["payload"] = payload()
    command["payload"]["regions"]["normal"]["x"] = 0.8
    with pytest.raises(MonitorProtocolError, match="bounds"):
        read_command(line(command))


def test_accepts_only_bounded_finite_capture_delay() -> None:
    command = {
        "protocolVersion": 2,
        "sessionId": str(uuid.uuid4()),
        "sequence": 0,
        "type": "start",
        "payload": payload(),
    }
    command["payload"]["captureDelaySeconds"] = 2.2
    assert read_command(line(command))["payload"]["captureDelaySeconds"] == 2.2
    for invalid in (-0.1, 5.1, True, float("inf")):
        command["payload"] = payload()
        command["payload"]["captureDelaySeconds"] = invalid
        with pytest.raises(MonitorProtocolError, match="capture delay"):
            read_command(line(command))
