"""Keep one selected Windows source warm and freeze its latest frame on command."""

from __future__ import annotations

from collections import deque
import time
import sys
import threading
from typing import Any

from capture.backend import CaptureBackendError
from capture.monitor_backend import WindowsMonitorBackend
from protocol.framing import ProtocolError, read_stream_envelope, write_envelope
from geometry.game_rect import detect, pixel_rect

MAX_PIXELS = 20_000_000
MAX_PNG_BYTES = 32 * 1024 * 1024

HISTORY_FRAMES = 8
HISTORY_INTERVAL = 0.3

class LatestFrameStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latest = None
        self._sequence = 0
        self._frozen = False
        self._history: deque[tuple[int, Any]] = deque(maxlen=HISTORY_FRAMES)
        self._last_sample = float("-inf")

    def publish(self, frame: Any, *, timestamp: float | None = None) -> tuple[bool, int, int, int]:
        if not hasattr(frame, "shape") or len(frame.shape) != 3:
            raise CaptureBackendError("FRAME_SIZE_INVALID", "Captured frame shape is invalid")
        height, width, channels = (int(value) for value in frame.shape)
        if width <= 0 or height <= 0 or channels not in (3, 4) or width * height > MAX_PIXELS:
            raise CaptureBackendError("FRAME_SIZE_INVALID", "Captured frame size is invalid")
        copied = frame.copy()
        with self._lock:
            if self._frozen:
                return False, self._sequence, width, height
            first = self._latest is None
            if self._latest is not None and self._latest.shape != frame.shape:
                self._history.clear()
                self._last_sample = float("-inf")
            self._sequence += 1
            self._latest = copied
            now = time.monotonic() if timestamp is None else timestamp
            if now - self._last_sample >= HISTORY_INTERVAL:
                self._history.append((self._sequence, copied))
                self._last_sample = now
            return first, self._sequence, width, height

    def freeze(self) -> tuple[Any, int]:
        with self._lock:
            if self._latest is None:
                raise CaptureBackendError("CAPTURE_NO_FRAME", "Capture source has no ready frame")
            self._frozen = True
            frame = self._latest
            self._latest = None
            return frame, self._sequence

    def game(self, frozen_frame: Any) -> dict[str, Any]:
        """Called only after freeze, once publication has stopped."""
        with self._lock:
            samples = list(self._history)
            if not samples or samples[-1][0] != self._sequence:
                samples.append((self._sequence, frozen_frame))
        if len(samples) < HISTORY_FRAMES:
            return {"rect": None, "reason": "insufficient_frames"}
        result = detect([frame for _, frame in samples])
        if result.reason != "ok" or result.rect is None:
            return {"rect": None, "reason": result.reason}
        last = detect([frozen_frame])
        if last.rect is None or abs(last.aspect / result.aspect - 1) > 0.01:
            return {"rect": None, "reason": "unstable"}
        return {"rect": pixel_rect(result.rect), "aspect": result.aspect,
                "chrome": result.chrome, "frames": len(samples)}


def validate_command(metadata: dict[str, Any], expected_type: str | None = None) -> tuple[str, str]:
    if set(metadata) not in ({"protocolVersion", "sessionId", "type", "selector"}, {"protocolVersion", "sessionId", "type"}):
        raise ProtocolError("prepared capture command fields are invalid")
    if metadata.get("protocolVersion") != 1:
        raise ProtocolError("prepared capture protocol version is invalid")
    session_id = metadata.get("sessionId")
    command_type = metadata.get("type")
    if not isinstance(session_id, str) or not isinstance(command_type, str):
        raise ProtocolError("prepared capture command identity is invalid")
    if expected_type is not None and command_type != expected_type:
        raise ProtocolError("prepared capture command order is invalid")
    return session_id, command_type


def main() -> None:
    output_lock = threading.Lock()
    backend: WindowsMonitorBackend | None = None
    session_id = "unknown"
    event_sequence = 0

    def emit(event_type: str, payload: dict[str, Any], binary: bytes = b"") -> None:
        nonlocal event_sequence
        with output_lock:
            event_sequence += 1
            write_envelope(
                sys.stdout.buffer,
                {
                    "protocolVersion": 1,
                    "sessionId": session_id,
                    "sequence": event_sequence,
                    "type": event_type,
                    "payload": payload,
                },
                binary,
            )

    try:
        start = read_stream_envelope(sys.stdin.buffer, max_binary_bytes=0)
        if start.binary:
            raise ProtocolError("prepared capture command must not contain binary data")
        session_id, _ = validate_command(start.metadata, "start")
        selector = start.metadata.get("selector")
        if not isinstance(selector, dict):
            raise ProtocolError("prepared capture selector is invalid")

        store = LatestFrameStore()
        ready_sent = threading.Event()
        source_closed = threading.Event()
        stopping = threading.Event()

        def on_frame(frame: Any) -> None:
            try:
                first, sequence, width, height = store.publish(frame)
                if first and not ready_sent.is_set():
                    ready_sent.set()
                    emit(
                        "ready",
                        {
                            "frameSequence": sequence,
                            "width": width,
                            "height": height,
                        },
                    )
            except CaptureBackendError as error:
                emit("fatal", {"code": error.code, "message": str(error)[:300]})

        def on_closed() -> None:
            if stopping.is_set():
                return
            source_closed.set()
            emit(
                "fatal",
                {"code": "CAPTURE_SOURCE_STALE", "message": "Capture source closed"},
            )

        backend = WindowsMonitorBackend(selector)
        backend.start(on_frame, on_closed)
        command = read_stream_envelope(sys.stdin.buffer, max_binary_bytes=0)
        if command.binary:
            raise ProtocolError("prepared capture command must not contain binary data")
        command_session_id, command_type = validate_command(command.metadata)
        if command_session_id != session_id:
            raise ProtocolError("prepared capture session is stale")

        if command_type == "stop":
            stopping.set()
            backend.stop()
            emit("stopped", {})
            return
        if command_type != "freeze" or source_closed.is_set():
            raise ProtocolError("prepared capture command order is invalid")

        frame, frame_sequence = store.freeze()
        stopping.set()
        backend.stop()
        backend = None
        import cv2

        encoded, png = cv2.imencode(".png", frame, [cv2.IMWRITE_PNG_COMPRESSION, 3])
        if not encoded:
            raise CaptureBackendError("PNG_ENCODE_FAILED", "Could not encode capture")
        png_bytes = png.tobytes()
        height, width = frame.shape[:2]
        if len(png_bytes) == 0 or len(png_bytes) > MAX_PNG_BYTES:
            raise CaptureBackendError("PNG_INVALID", "Capture PNG is invalid or too large")
        emit(
            "frozen",
            {
                "frameSequence": frame_sequence,
                "width": int(width),
                "height": int(height),
                "mimeType": "image/png",
                "byteLength": len(png_bytes),
                "game": store.game(frame),
            },
            png_bytes,
        )
    except (ProtocolError, CaptureBackendError, Exception) as error:
        code = getattr(error, "code", "PREPARED_CAPTURE_FAILED")
        try:
            emit("fatal", {"code": code, "message": str(error)[:300]})
        except Exception:
            pass
    finally:
        if backend is not None:
            try:
                backend.stop()
            except Exception:
                pass


if __name__ == "__main__":
    main()
