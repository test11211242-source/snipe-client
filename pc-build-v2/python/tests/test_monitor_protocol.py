import io
import json
import math
import uuid

import pytest

from geometry.aspect import ASPECT_MIN, ASPECT_MAX, aspects_overlap
from monitor_protocol import MonitorProtocolError, encode_event, read_command


def payload():
    return {
        "selector": {"kind": "window", "windowHwnd": "123"},
        "primary": {
            "kind": "full_frame",
            "configuredFrameSize": {"width": 1920, "height": 1080},
            "regions": {
                "trigger": {"x": 0, "y": 0, "width": 0.2, "height": 0.2},
                "nicknameRegion": {"x": 0, "y": 0, "width": 0.5, "height": 0.5},
                "topLeftEvidenceRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
            },
            "triggerProfile": {},
        },
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
        "protocolVersion": 4,
        "sessionId": session_id,
        "sequence": 0,
        "type": "start",
        "payload": payload(),
    }
    assert read_command(line(start))["payload"]["capturePolicy"] == "immediate_nickname"
    stop = {
        "protocolVersion": 4,
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
    assert triggered["protocolVersion"] == 4
    assert triggered["type"] == "triggered"


def test_rejects_unknown_fields_stale_session_and_oversized_line() -> None:
    session_id = str(uuid.uuid4())
    command = {
        "protocolVersion": 4,
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
        read_command(io.BytesIO(b"x" * (1024 * 1024 + 1)))


def test_rejects_non_exact_limits_and_invalid_ratios() -> None:
    command = {
        "protocolVersion": 4,
        "sessionId": str(uuid.uuid4()),
        "sequence": 0,
        "type": "start",
        "payload": payload(),
    }
    command["payload"]["limits"]["fps"] = 30
    with pytest.raises(MonitorProtocolError, match="limits"):
        read_command(line(command))
    command["payload"] = payload()
    command["payload"]["primary"]["regions"]["nicknameRegion"]["x"] = 0.8
    with pytest.raises(MonitorProtocolError, match="bounds"):
        read_command(line(command))


def test_rejects_obsolete_capture_delay_and_search_mode() -> None:
    command = {
        "protocolVersion": 4,
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


def test_game_relative_strict_roundtrip_and_amended_metadata():
    from test_game_geometry import game_payload

    command = {"protocolVersion": 4, "sessionId": str(uuid.uuid4()), "sequence": 0, "type": "start", "payload": game_payload()}
    parsed = read_command(line(command))
    layout = parsed["payload"]["primary"]["layouts"][0]
    assert layout["layoutSource"] == "setup"
    assert layout["calibratedAt"].endswith("Z")
    assert parsed["payload"]["primary"]["learning"] == {"enabled": True, "maxLayouts": 4}


def test_game_aspect_bounds_preserve_detector_algorithm_constants():
    from geometry.game_rect import ASPECT_MIN as DETECTOR_ASPECT_MIN, ASPECT_MAX as DETECTOR_ASPECT_MAX

    assert ASPECT_MIN == DETECTOR_ASPECT_MIN == 9 / 22 * 0.97
    assert ASPECT_MAX == DETECTOR_ASPECT_MAX == 3 / 4 * 1.03


@pytest.mark.parametrize("aspect", [ASPECT_MIN, ASPECT_MAX, (ASPECT_MIN + 0.397) / 2])
def test_game_aspect_exact_detector_bounds_roundtrip(aspect):
    from test_game_geometry import game_payload

    value = game_payload()
    value["primary"]["layouts"][0]["gameAspect"] = aspect
    command = {"protocolVersion": 4, "sessionId": str(uuid.uuid4()), "sequence": 0, "type": "start", "payload": value}
    assert read_command(line(command))["payload"]["primary"]["layouts"][0]["gameAspect"] == aspect


@pytest.mark.parametrize("aspect", [
    math.nextafter(ASPECT_MIN, -math.inf),
    math.nextafter(ASPECT_MAX, math.inf),
])
def test_game_aspect_rejects_values_outside_exact_detector_bounds(aspect):
    from test_game_geometry import game_payload

    value = game_payload()
    value["primary"]["layouts"][0]["gameAspect"] = aspect
    command = {"protocolVersion": 4, "sessionId": str(uuid.uuid4()), "sequence": 0, "type": "start", "payload": value}
    with pytest.raises(MonitorProtocolError, match="game aspect"):
        read_command(line(command))


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("factor, overlaps", [(1.0305, False), (1.0299, True)])
def test_game_aspect_overlap_is_symmetric_on_restart(reverse, factor, overlaps):
    from copy import deepcopy
    from test_game_geometry import game_payload

    value = game_payload()
    setup = value["primary"]["layouts"][0]
    setup["gameAspect"] = 0.5625
    learned = deepcopy(setup)
    learned.update(layoutId=str(uuid.uuid4()), layoutSource="learned", gameAspect=0.5625 * factor)
    layouts = [setup, learned]
    value["primary"]["layouts"] = layouts[::-1] if reverse else layouts
    assert aspects_overlap(setup["gameAspect"], learned["gameAspect"]) is overlaps
    assert aspects_overlap(learned["gameAspect"], setup["gameAspect"]) is overlaps
    command = {"protocolVersion": 4, "sessionId": str(uuid.uuid4()), "sequence": 0, "type": "start", "payload": value}
    if overlaps:
        with pytest.raises(MonitorProtocolError, match="overlap"):
            read_command(line(command))
    else:
        assert read_command(line(command))["payload"]["primary"]["layouts"] == value["primary"]["layouts"]


@pytest.mark.parametrize("change", [
    "extra_primary", "missing_source", "missing_date", "bad_date", "extra_layout", "bad_kind", "bad_base64",
    "short_base64", "bad_constant", "bad_chrome", "bad_origin", "duplicate_layout", "no_setup",
])
def test_rejects_malformed_game_relative_wire(change):
    from copy import deepcopy
    from test_game_geometry import game_payload

    value = game_payload()
    primary = value["primary"]
    layout = primary["layouts"][0]
    if change == "extra_primary":
        primary["obsolete"] = True
    elif change == "missing_source":
        del layout["layoutSource"]
    elif change == "missing_date":
        del layout["calibratedAt"]
    elif change == "bad_date":
        layout["calibratedAt"] = "yesterday"
    elif change == "extra_layout":
        layout["obsolete"] = True
    elif change == "bad_kind":
        layout["trigger"]["kind"] = "other"
    elif change == "bad_base64":
        layout["trigger"]["angleQ8Base64"] = "!" * len(layout["trigger"]["angleQ8Base64"])
    elif change == "short_base64":
        layout["trigger"]["angleQ8Base64"] = "AAAA"
    elif change == "bad_constant":
        layout["trigger"]["threshold"] = 0.3
    elif change == "bad_chrome":
        layout["windowChrome"]["top"] = -1
    elif change == "bad_origin":
        layout["zonesOrigin"]["nickname"] = "learned"
    elif change == "duplicate_layout":
        primary["layouts"].append(deepcopy(layout))
    elif change == "no_setup":
        layout["layoutSource"] = "learned"
    command = {"protocolVersion": 4, "sessionId": str(uuid.uuid4()), "sequence": 0, "type": "start", "payload": value}
    with pytest.raises(MonitorProtocolError):
        read_command(line(command))


def test_command_limit_accepts_more_than_old_256_kib():
    command = {"protocolVersion": 4, "sessionId": str(uuid.uuid4()), "sequence": 0, "type": "start", "payload": payload()}
    # Legal JSON whitespace consumes bounded wire bytes without changing the payload.
    encoded = (" " * (256 * 1024) + json.dumps(command) + "\n").encode()
    assert read_command(io.BytesIO(encoded))["protocolVersion"] == 4
