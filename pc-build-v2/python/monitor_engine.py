#!/usr/bin/env python3
"""Persistent CR Tools monitor worker. Private images exist only in action events."""

from __future__ import annotations

import base64
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from capture.monitor_backend import WindowsMonitorBackend
from capture.backend import CaptureBackendError
from monitor_protocol import MonitorProtocolError, encode_event, read_command
from trigger_engine import GeometryChangedError, InvalidFrameError, PredictionTriggerEngine, TriggerEngine, ensure_bgr


class EventWriter:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.sequence = 0
        self.lock = threading.Lock()

    def emit(self, event_type: str, payload: dict[str, Any]) -> None:
        with self.lock:
            self.sequence += 1
            sys.stdout.buffer.write(encode_event(self.session_id, self.sequence, event_type, payload))
            sys.stdout.buffer.flush()


def run(start: dict[str, Any]) -> int:
    session_id = start["sessionId"]
    payload = start["payload"]
    writer = EventWriter(session_id)
    terminal = threading.Event()
    stopping = threading.Event()
    ready = threading.Event()
    failure_lock = threading.Lock()
    engine = None
    prediction_engine = None
    backend = None
    diagnostic_times = {"primary": -float("inf"), "prediction": -float("inf")}
    writer_failed = False

    def fail(code: str, message: str, stage: str = "initialize", error: Exception | None = None) -> None:
        nonlocal writer_failed
        with failure_lock:
            if terminal.is_set():
                return
            terminal.set()
            try:
                details = {"code": code, "message": message, "stage": stage}
                if error is not None:
                    name = type(error).__name__
                    details["errorClass"] = name if name.isascii() and name.replace("_", "").isalnum() and len(name) <= 64 else "Exception"
                writer.emit("fatal", details)
            except Exception:
                writer_failed = True

    def emit_diagnostic(profile: str, match, now: float) -> None:
        if match is None or now - diagnostic_times[profile] < 1.0:
            return
        diagnostic_times[profile] = now
        writer.emit(
            "diagnostic",
            {
                "profile": profile,
                "matched": match.matched,
                "score": round(match.score, 4),
                "support": round(match.support, 4),
                "orientation": round(match.orientation, 4),
                "correlation": round(match.correlation, 4),
                "orbInliers": match.orb_inliers,
                "reason": match.reason,
            },
        )

    def on_frame(frame) -> None:
        if terminal.is_set() or stopping.is_set():
            return
        try:
            bgr = ensure_bgr(frame)
            height, width = bgr.shape[:2]
            if width <= 0 or height <= 0 or width * height > payload["limits"]["maxImagePixels"]:
                raise InvalidFrameError("capture frame dimensions are invalid")
            if not ready.is_set():
                writer.emit("ready", {"frameWidth": width, "frameHeight": height})
                ready.set()
            now = time.monotonic()
            action = engine.process(bgr, now)
            emit_diagnostic("primary", engine.last_match, now)
            trigger_id = str(uuid.uuid4())
            timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            if engine.take_triggered():
                writer.emit(
                    "triggered",
                    {
                        "timestamp": timestamp,
                        "triggerId": trigger_id,
                    },
                )
            if action is not None:
                image, image_width, image_height = action
                writer.emit(
                    "action",
                    {
                        "timestamp": timestamp,
                        "triggerId": trigger_id,
                        "width": image_width,
                        "height": image_height,
                        "byteLength": len(image),
                        "imageBase64": base64.b64encode(image).decode("ascii"),
                    },
                )
            prediction_result = prediction_engine.process(bgr, now) if prediction_engine else None
            if prediction_engine is not None:
                emit_diagnostic("prediction", prediction_engine.last_match, now)
            if prediction_result is not None:
                image, image_width, image_height = prediction_result
                writer.emit(
                    "prediction_result",
                    {
                        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "triggerId": str(uuid.uuid4()),
                        "width": image_width,
                        "height": image_height,
                        "byteLength": len(image),
                        "imageBase64": base64.b64encode(image).decode("ascii"),
                    },
                )
        except GeometryChangedError as error:
            fail("CAPTURE_GEOMETRY_CHANGED", "The capture geometry changed", "frame", error)
        except InvalidFrameError as error:
            fail("CAPTURE_FRAME_INVALID", "The capture frame is invalid", "frame", error)
        except Exception as error:
            fail("MONITOR_INTERNAL_FAILED", "The monitor could not process a frame", "frame", error)

    def on_closed() -> None:
        if not stopping.is_set():
            fail("CAPTURE_SOURCE_CLOSED", "The configured capture source closed", "source")
        terminal.set()

    def read_stop() -> None:
        try:
            command = read_command(sys.stdin.buffer, expected_session_id=session_id)
            if command["type"] != "stop":
                raise MonitorProtocolError("only a stop command is allowed after start")
            stopping.set()
            terminal.set()
        except Exception as error:
            fail("MONITOR_PROTOCOL_INVALID", "The monitor stop command was invalid", "stop", error)

    stage = "initialize"
    try:
        stop_reader = threading.Thread(target=read_stop, name="monitor-stop-reader", daemon=True)
        stop_reader.start()
        if not terminal.is_set():
            engine = TriggerEngine(payload)
        if not terminal.is_set() and payload["prediction"] is not None:
            prediction_engine = PredictionTriggerEngine(payload["prediction"], payload["limits"])
        if not terminal.is_set():
            stage = "start"
            backend = WindowsMonitorBackend(payload["selector"])
            if not terminal.is_set():
                backend.start(on_frame, on_closed)
        deadline = time.monotonic() + 7.0
        while not terminal.wait(0.05):
            if not ready.is_set() and time.monotonic() >= deadline:
                fail("CAPTURE_NO_FRAME", "The capture source did not provide a frame", "start")
    except CaptureBackendError as error:
        fail(
            "CAPTURE_SOURCE_CLOSED" if error.code == "CAPTURE_SOURCE_STALE" else "CAPTURE_START_FAILED",
            "The capture source is unavailable" if error.code == "CAPTURE_SOURCE_STALE" else "The capture could not start",
            stage, error,
        )
    except Exception as error:
        fail(
            "CAPTURE_START_FAILED" if stage == "start" else "MONITOR_INTERNAL_FAILED",
            "The capture could not start" if stage == "start" else "The monitor could not initialize",
            stage, error,
        )
    finally:
        stopping.set()
        try:
            if backend is not None:
                backend.stop()
        except Exception:
            pass
    if ready.is_set() and writer.sequence > 0 and not writer_failed:
        try:
            writer.emit("stopped", {})
        except Exception:
            writer_failed = True
    return 2 if writer_failed else 0


def main() -> int:
    try:
        command = read_command(sys.stdin.buffer)
        if command["type"] != "start":
            return 2
        return run(command)
    except Exception:
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
