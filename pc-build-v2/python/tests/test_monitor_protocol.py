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
            "nicknameRegion": {"x": 0, "y": 0, "width": 0.5, "height": 0.5},
            "topLeftEvidenceRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
        },
        "triggerProfile": {},
        "capturePolicy": "immediate_nickname",
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
        "protocolVersion": 3,
        "sessionId": session_id,
        "sequence": 0,
        "type": "start",
        "payload": payload(),
    }
    assert read_command(line(start))["payload"]["capturePolicy"] == "immediate_nickname"
    stop = {
        "protocolVersion": 3,
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
            {"timestamp": "2026-07-12T12:00:00.000Z", "triggerId": str(uuid.uuid4())},
        )
    )
    assert triggered["protocolVersion"] == 3
    assert triggered["type"] == "triggered"


def test_rejects_unknown_fields_stale_session_and_oversized_line() -> None:
    session_id = str(uuid.uuid4())
    command = {
        "protocolVersion": 3,
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
        read_command(io.BytesIO(b"x" * (256 * 1024 + 1)))


def test_rejects_non_exact_limits_and_invalid_ratios() -> None:
    command = {
        "protocolVersion": 3,
        "sessionId": str(uuid.uuid4()),
        "sequence": 0,
        "type": "start",
        "payload": payload(),
    }
    command["payload"]["limits"]["fps"] = 30
    with pytest.raises(MonitorProtocolError, match="limits"):
        read_command(line(command))
    command["payload"] = payload()
    command["payload"]["regions"]["nicknameRegion"]["x"] = 0.8
    with pytest.raises(MonitorProtocolError, match="bounds"):
        read_command(line(command))


def test_rejects_obsolete_capture_delay_and_search_mode() -> None:
    command = {
        "protocolVersion": 3,
        "sessionId": str(uuid.uuid4()),
        "sequence": 0,
        "type": "start",
        "payload": payload(),
    }
    assert read_command(line(command))["payload"]["capturePolicy"] == "immediate_nickname"
    for obsolete in ({"captureDelaySeconds": 2.2}, {"searchMode": "fast"}):
        command["payload"] = {**payload(), **obsolete}
        with pytest.raises(MonitorProtocolError, match="fields"):
            read_command(line(command))
