"""Strict bounded JSON-lines protocol for the persistent monitor worker."""

from __future__ import annotations

import json
import math
import uuid
from typing import Any, BinaryIO

PROTOCOL_VERSION = 2
MAX_COMMAND_BYTES = 128 * 1024


class MonitorProtocolError(ValueError):
    pass


def _exact(value: Any, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise MonitorProtocolError(f"{name} fields are invalid")
    return value


def validate_ratio(value: Any, name: str) -> dict[str, float]:
    ratio = _exact(value, {"x", "y", "width", "height"}, name)
    result: dict[str, float] = {}
    for key in ("x", "y", "width", "height"):
        number = ratio[key]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
            raise MonitorProtocolError(f"{name}.{key} is invalid")
        result[key] = float(number)
    if result["x"] < 0 or result["y"] < 0 or result["width"] <= 0 or result["height"] <= 0:
        raise MonitorProtocolError(f"{name} dimensions are invalid")
    if result["x"] + result["width"] > 1.0 + 1e-9 or result["y"] + result["height"] > 1.0 + 1e-9:
        raise MonitorProtocolError(f"{name} exceeds bounds")
    return result


def _positive_int(value: Any, maximum: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > maximum:
        raise MonitorProtocolError(f"{name} is invalid")
    return value


def validate_start_payload(value: Any) -> dict[str, Any]:
    payload = _exact(
        value,
        {
            "selector",
            "configuredFrameSize",
            "regions",
            "triggerProfile",
            "searchMode",
            "captureDelaySeconds",
            "limits",
            "prediction",
        },
        "start payload",
    )
    selector = payload["selector"]
    if not isinstance(selector, dict):
        raise MonitorProtocolError("selector is invalid")
    if selector.get("kind") == "window":
        _exact(selector, {"kind", "windowHwnd"}, "window selector")
        hwnd = selector["windowHwnd"]
        if not isinstance(hwnd, str) or not hwnd.isascii() or not hwnd.isdecimal() or int(hwnd) <= 0:
            raise MonitorProtocolError("window selector is invalid")
    elif selector.get("kind") == "display":
        _exact(selector, {"kind", "displayDeviceName", "electronDisplayId"}, "display selector")
        device = selector["displayDeviceName"]
        if not isinstance(device, str) or not device.startswith(r"\\.\DISPLAY") or len(device) > 32:
            raise MonitorProtocolError("display selector is invalid")
        display_id = selector["electronDisplayId"]
        if not isinstance(display_id, str) or not 1 <= len(display_id) <= 128:
            raise MonitorProtocolError("display id is invalid")
    else:
        raise MonitorProtocolError("selector kind is invalid")

    frame_size = _exact(payload["configuredFrameSize"], {"width", "height"}, "frame size")
    _positive_int(frame_size["width"], 16384, "frame width")
    _positive_int(frame_size["height"], 16384, "frame height")
    regions = _exact(payload["regions"], {"trigger", "normal", "precise"}, "regions")
    for name in ("trigger", "normal", "precise"):
        regions[name] = validate_ratio(regions[name], f"regions.{name}")
    if payload["searchMode"] not in ("fast", "precise"):
        raise MonitorProtocolError("search mode is invalid")
    delay = payload["captureDelaySeconds"]
    if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not math.isfinite(delay):
        raise MonitorProtocolError("capture delay is invalid")
    if not 0 <= delay <= 5:
        raise MonitorProtocolError("capture delay is invalid")
    payload["captureDelaySeconds"] = float(delay)
    limits = _exact(
        payload["limits"],
        {
            "fps",
            "maxImageBytes",
            "maxImagePixels",
            "maxImageWidth",
            "maxImageHeight",
            "confirmationsNeeded",
            "confirmationDecay",
            "cooldownSeconds",
        },
        "limits",
    )
    expected_limits = {
        "fps": 10,
        "maxImageBytes": 10 * 1024 * 1024,
        "maxImagePixels": 20_000_000,
        "maxImageWidth": 8192,
        "maxImageHeight": 8192,
        "confirmationsNeeded": 2,
        "confirmationDecay": 0.5,
        "cooldownSeconds": 15,
    }
    if limits != expected_limits:
        raise MonitorProtocolError("monitor limits are invalid")
    if not isinstance(payload["triggerProfile"], dict):
        raise MonitorProtocolError("trigger profile is invalid")
    prediction = payload["prediction"]
    if prediction is not None:
        prediction = _exact(
            prediction,
            {"configuredFrameSize", "trigger", "data", "triggerProfile"},
            "prediction profile",
        )
        prediction_size = _exact(prediction["configuredFrameSize"], {"width", "height"}, "prediction frame size")
        _positive_int(prediction_size["width"], 16384, "prediction frame width")
        _positive_int(prediction_size["height"], 16384, "prediction frame height")
        prediction["trigger"] = validate_ratio(prediction["trigger"], "prediction trigger")
        prediction["data"] = validate_ratio(prediction["data"], "prediction data")
        if not isinstance(prediction["triggerProfile"], dict):
            raise MonitorProtocolError("prediction trigger profile is invalid")
    return payload


def read_command(stream: BinaryIO, expected_session_id: str | None = None) -> dict[str, Any]:
    line = stream.readline(MAX_COMMAND_BYTES + 1)
    if not line or len(line) > MAX_COMMAND_BYTES or not line.endswith(b"\n"):
        raise MonitorProtocolError("command line is missing or oversized")
    try:
        command = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MonitorProtocolError("command JSON is invalid") from error
    command = _exact(command, {"protocolVersion", "sessionId", "sequence", "type", "payload"}, "command")
    if command["protocolVersion"] != PROTOCOL_VERSION:
        raise MonitorProtocolError("protocol version is invalid")
    try:
        uuid.UUID(command["sessionId"])
    except (TypeError, ValueError, AttributeError) as error:
        raise MonitorProtocolError("session id is invalid") from error
    if expected_session_id is not None and command["sessionId"] != expected_session_id:
        raise MonitorProtocolError("session id is stale")
    sequence = command["sequence"]
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
        raise MonitorProtocolError("sequence is invalid")
    if command["type"] == "start":
        if sequence != 0:
            raise MonitorProtocolError("start sequence is invalid")
        command["payload"] = validate_start_payload(command["payload"])
    elif command["type"] == "stop":
        _exact(command["payload"], set(), "stop payload")
        if sequence <= 0:
            raise MonitorProtocolError("stop sequence is invalid")
    else:
        raise MonitorProtocolError("command type is invalid")
    return command


def encode_event(session_id: str, sequence: int, event_type: str, payload: dict[str, Any]) -> bytes:
    event = {
        "protocolVersion": PROTOCOL_VERSION,
        "sessionId": session_id,
        "sequence": sequence,
        "type": event_type,
        "payload": payload,
    }
    return (json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
