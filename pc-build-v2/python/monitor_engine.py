#!/usr/bin/env python3
"""Persistent CR Tools monitor worker. Private images exist only in action events."""

from __future__ import annotations

import base64
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any

from capture.monitor_backend import WindowsMonitorBackend
from monitor_protocol import MonitorProtocolError, encode_event, read_command
from trigger_engine import PredictionTriggerEngine, TriggerEngine, ensure_bgr


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
    engine = TriggerEngine(payload)
    prediction_engine = (
        PredictionTriggerEngine(payload["prediction"], payload["limits"])
        if payload["prediction"] is not None
        else None
    )
    backend = WindowsMonitorBackend(payload["selector"])

    def fail(code: str, message: str) -> None:
        if terminal.is_set():
            return
        terminal.set()
        writer.emit("fatal", {"code": code[:64], "message": message[:300]})

    def on_frame(frame) -> None:
        if terminal.is_set() or stopping.is_set():
            return
        try:
            bgr = ensure_bgr(frame)
            height, width = bgr.shape[:2]
            if width <= 0 or height <= 0 or width * height > payload["limits"]["maxImagePixels"]:
                raise RuntimeError("capture frame dimensions are invalid")
            if not ready.is_set():
                writer.emit("ready", {"frameWidth": width, "frameHeight": height})
                ready.set()
            now = time.monotonic()
            action = engine.process(bgr, now)
            if action is not None:
                image, image_width, image_height = action
                writer.emit(
                    "action",
                    {
                        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "width": image_width,
                        "height": image_height,
                        "byteLength": len(image),
                        "imageBase64": base64.b64encode(image).decode("ascii"),
                    },
                )
            prediction_result = prediction_engine.process(bgr, now) if prediction_engine else None
            if prediction_result is not None:
                image, image_width, image_height = prediction_result
                writer.emit(
                    "prediction_result",
                    {
                        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "width": image_width,
                        "height": image_height,
                        "byteLength": len(image),
                        "imageBase64": base64.b64encode(image).decode("ascii"),
                    },
                )
        except Exception:
            fail("MONITOR_FRAME_FAILED", "The capture frame could not be processed")

    def on_closed() -> None:
        if not stopping.is_set():
            fail("CAPTURE_SOURCE_CLOSED", "The configured capture source closed")
        terminal.set()

    def read_stop() -> None:
        try:
            command = read_command(sys.stdin.buffer, expected_session_id=session_id)
            if command["type"] != "stop":
                raise MonitorProtocolError("only a stop command is allowed after start")
            stopping.set()
            terminal.set()
        except Exception:
            fail("MONITOR_PROTOCOL_INVALID", "The monitor stop command was invalid")

    stop_reader = threading.Thread(target=read_stop, name="monitor-stop-reader", daemon=True)
    stop_reader.start()
    try:
        if not terminal.is_set():
            backend.start(on_frame, on_closed)
        terminal.wait()
    except Exception:
        fail("CAPTURE_START_FAILED", "The configured capture source could not be started")
    finally:
        stopping.set()
        try:
            backend.stop()
        except Exception:
            pass
    if ready.is_set() and writer.sequence > 0:
        writer.emit("stopped", {})
    return 0


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
