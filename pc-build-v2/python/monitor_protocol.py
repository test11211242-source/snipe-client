"""Strict bounded JSON-lines protocol for the persistent monitor worker."""

from __future__ import annotations

import base64
import binascii
from datetime import datetime
import json
import math
import uuid
from typing import Any, BinaryIO

from geometry.aspect import ASPECT_MIN, ASPECT_MAX, aspects_overlap

PROTOCOL_VERSION = 4
MAX_COMMAND_BYTES = 1024 * 1024


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


def _number(value, minimum, maximum, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise MonitorProtocolError(f"{name} is invalid")
    return value


def _integer(value, minimum, maximum, name):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise MonitorProtocolError(f"{name} is invalid")
    return value


def _uuid(value, name):
    try:
        uuid.UUID(value)
    except (TypeError, ValueError, AttributeError) as error:
        raise MonitorProtocolError(f"{name} is invalid") from error


def _size(value, name):
    value = _exact(value, {"width", "height"}, name)
    _positive_int(value["width"], 16384, name + " width")
    _positive_int(value["height"], 16384, name + " height")


def _base64(value, length, name):
    if not isinstance(value, str) or len(value) != 4 * ((length + 2) // 3):
        raise MonitorProtocolError(f"{name} length is invalid")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise MonitorProtocolError(f"{name} encoding is invalid") from error
    if len(decoded) != length or base64.b64encode(decoded).decode("ascii") != value:
        raise MonitorProtocolError(f"{name} bytes are invalid")


def _badge(value):
    value = _exact(value, {"cx", "cy", "width", "height"}, "badge")
    for name, number in value.items():
        _number(number, 0.000000001, 1, "badge " + name)


def _chrome(value):
    sides = ("top", "bottom", "left", "right")
    value = _exact(value, set(sides) | {side + "Edges" for side in sides}, "window chrome")
    for side in sides:
        _integer(value[side], 0, 2048, "chrome " + side)
        template = value[side + "Edges"]
        if template is not None:
            _exact(template, {"length", "thickness", "angleQ8Base64", "weightQ8Base64"}, "strip edges")
            if template["length"] != 256:
                raise MonitorProtocolError("strip length is invalid")
            thickness = _integer(template["thickness"], 1, 256, "strip thickness")
            _base64(template["angleQ8Base64"], 256 * thickness, "strip angles")
            _base64(template["weightQ8Base64"], 256 * thickness, "strip weights")


def _regions(value):
    value = _exact(value, {"trigger", "nicknameRegion", "topLeftEvidenceRegion"}, "regions")
    for name in value:
        value[name] = validate_ratio(value[name], "regions." + name)


def _orientation(value):
    _exact(value, {"kind", "algorithm", "badge", "normalizedSize", "cropMargin", "padding", "maxShift",
                   "threshold", "angleQ8Base64", "weightQ8Base64", "templateHash64", "maskAreaRatio"}, "orientation trigger")
    if (value["kind"] != "vs_edge_orientation" or value["algorithm"] != "vs-orient-1" or
            value["cropMargin"] != 0.08 or value["padding"] != 4 or value["maxShift"] != 3 or value["threshold"] != 0.5):
        raise MonitorProtocolError("orientation constants are invalid")
    _badge(value["badge"])
    size = _exact(value["normalizedSize"], {"width", "height"}, "orientation size")
    if size["width"] != 96:
        raise MonitorProtocolError("orientation width is invalid")
    height = _integer(size["height"], 64, 160, "orientation height")
    _base64(value["angleQ8Base64"], 96 * height, "orientation angles")
    _base64(value["weightQ8Base64"], 96 * height, "orientation weights")
    digest = value["templateHash64"]
    if not isinstance(digest, str) or len(digest) != 16 or any(c not in "0123456789abcdef" for c in digest):
        raise MonitorProtocolError("orientation hash is invalid")
    _number(value["maskAreaRatio"], 0, 1, "mask area")


def _primary(value):
    if not isinstance(value, dict):
        raise MonitorProtocolError("primary is invalid")
    if value.get("kind") == "full_frame":
        _exact(value, {"kind", "configuredFrameSize", "regions", "triggerProfile"}, "full frame primary")
        _size(value["configuredFrameSize"], "frame size")
        _regions(value["regions"])
        if not isinstance(value["triggerProfile"], dict):
            raise MonitorProtocolError("trigger profile is invalid")
        return
    _exact(value, {"kind", "profileCalibrationId", "layouts", "learning"}, "game relative primary")
    if value["kind"] != "game_relative":
        raise MonitorProtocolError("primary kind is invalid")
    _uuid(value["profileCalibrationId"], "calibration id")
    learning = _exact(value["learning"], {"enabled", "maxLayouts"}, "learning")
    if not isinstance(learning["enabled"], bool) or learning["maxLayouts"] != 4:
        raise MonitorProtocolError("learning settings are invalid")
    layouts = value["layouts"]
    if not isinstance(layouts, list) or not 1 <= len(layouts) <= 4:
        raise MonitorProtocolError("layouts count is invalid")
    ids = set()
    aspects = []
    for layout in layouts:
        _exact(layout, {"layoutId", "layoutSource", "calibratedAt", "gameAspect", "windowChrome", "regions", "trigger", "badge", "zonesOrigin"}, "layout")
        _uuid(layout["layoutId"], "layout id")
        if layout["layoutId"] in ids:
            raise MonitorProtocolError("layout ids are not unique")
        ids.add(layout["layoutId"])
        if layout["layoutSource"] not in ("setup", "learned"):
            raise MonitorProtocolError("layout source is invalid")
        date = layout["calibratedAt"]
        try:
            if not isinstance(date, str) or not date.endswith("Z"):
                raise ValueError()
            datetime.fromisoformat(date.replace("Z", "+00:00"))
        except ValueError as error:
            raise MonitorProtocolError("layout calibratedAt is invalid") from error
        aspect = _number(layout["gameAspect"], ASPECT_MIN, ASPECT_MAX, "game aspect")
        if any(aspects_overlap(other, aspect) for other in aspects):
            raise MonitorProtocolError("layout aspects overlap")
        aspects.append(aspect)
        _chrome(layout["windowChrome"])
        _regions(layout["regions"])
        if layout["badge"] is not None:
            _badge(layout["badge"])
        origins = _exact(layout["zonesOrigin"], {"nickname", "topLeftEvidence"}, "zone origins")
        if any(origin not in ("auto", "manual") for origin in origins.values()):
            raise MonitorProtocolError("zone origins are invalid")
        trigger = layout["trigger"]
        if not isinstance(trigger, dict):
            raise MonitorProtocolError("layout trigger is invalid")
        if trigger.get("kind") == "vs_edge_orientation":
            _orientation(trigger)
        else:
            _exact(trigger, {"kind", "profile"}, "structural trigger")
            if trigger["kind"] != "structural" or not isinstance(trigger["profile"], dict):
                raise MonitorProtocolError("structural trigger is invalid")
    if not any(layout["layoutSource"] == "setup" for layout in layouts):
        raise MonitorProtocolError("setup layout is required")


def validate_start_payload(value: Any) -> dict[str, Any]:
    payload = _exact(
        value,
        {
            "selector",
            "primary",
            "capturePolicy",
            "limits",
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

    _primary(payload["primary"])
    if payload["capturePolicy"] != "immediate_nickname":
        raise MonitorProtocolError("capture policy is invalid")
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


def validate_prediction_result(value: Any) -> dict[str, Any]:
    """Future C3 report: metadata only; C1 never produces these events."""
    payload = _exact(value, {"battleId", "gap", "outcome", "evidence"}, "prediction result")
    if payload["battleId"] is not None:
        _uuid(payload["battleId"], "battle id")
    if not isinstance(payload["gap"], bool):
        raise MonitorProtocolError("prediction gap is invalid")
    if payload["outcome"] not in ("win", "loss", "draw", "unknown"):
        raise MonitorProtocolError("prediction outcome is invalid")
    evidence = _exact(payload["evidence"], {"crowns", "deltaSign", "deltaIcon"}, "prediction evidence")
    crowns = _exact(evidence["crowns"], {"top", "bottom"}, "prediction crowns")
    for side, count in crowns.items():
        if count is not None:
            _integer(count, 0, 3, "prediction crowns." + side)
    if (evidence["deltaSign"] not in ("+", "-", None) or
            evidence["deltaIcon"] not in ("pol", "trophy", "absent", "unreadable")):
        raise MonitorProtocolError("prediction evidence is invalid")
    return payload


def encode_event(session_id: str, sequence: int, event_type: str, payload: dict[str, Any]) -> bytes:
    if event_type == "prediction_result":
        validate_prediction_result(payload)
    elif event_type == "prediction_state":
        raise MonitorProtocolError("prediction state events are no longer supported")
    elif event_type == "triggered":
        _exact(payload, {"timestamp", "triggerId", "kind", "rank", "rankEvidence"}, "triggered")
        _uuid(payload["triggerId"], "trigger id")
        timestamp = payload["timestamp"]
        try:
            if not isinstance(timestamp, str) or "T" not in timestamp or not timestamp.endswith("Z"):
                raise ValueError()
            datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError as error:
            raise MonitorProtocolError("triggered timestamp is invalid") from error
        if payload["kind"] not in ("battle", "spectate", None) or payload["rank"] not in ("pol", "not_pol", "unknown"):
            raise MonitorProtocolError("triggered kind or rank is invalid")
        if payload["rankEvidence"] is not None:
            evidence = _exact(payload["rankEvidence"], {"opponent", "own"}, "rank evidence")
            if any(line not in ("medal", "league", "trophy", "empty", "other", "unknown") for line in evidence.values()):
                raise MonitorProtocolError("rank evidence is invalid")
    event = {
        "protocolVersion": PROTOCOL_VERSION,
        "sessionId": session_id,
        "sequence": sequence,
        "type": event_type,
        "payload": payload,
    }
    return (json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
