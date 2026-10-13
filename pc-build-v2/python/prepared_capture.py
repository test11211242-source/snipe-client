"""Keep one selected Windows source warm and freeze its latest frame on command."""

from __future__ import annotations

from collections import deque
import ctypes
from ctypes import wintypes
import time
import sys
import threading
from typing import Any, Callable

from capture.backend import CaptureBackendError
from capture.monitor_backend import WindowsMonitorBackend
from protocol.framing import ProtocolError, read_stream_envelope, write_envelope
from geometry.game_rect import detect, pixel_rect
from auto_setup import DEADLINE_MS, TARGET_FPS, LiveAnalysis, encode_png

MAX_PIXELS = 20_000_000
MAX_PNG_BYTES = 32 * 1024 * 1024

HISTORY_FRAMES = 8
HISTORY_INTERVAL = 0.3
HISTORY_WAIT_SECONDS = 2.5

class LatestFrameStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._source_closed = False
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
        copied = frame[:, :, :3].copy()
        with self._lock:
            if self._frozen:
                return False, self._sequence, width, height
            first = self._latest is None
            if self._latest is not None and self._latest.shape[:2] != frame.shape[:2]:
                self._history.clear()
                self._last_sample = float("-inf")
            self._sequence += 1
            self._latest = copied
            now = time.monotonic() if timestamp is None else timestamp
            if now - self._last_sample >= HISTORY_INTERVAL:
                self._history.append((self._sequence, copied))
                self._last_sample = now
            self._condition.notify_all()
            return first, self._sequence, width, height

    def snapshot(self) -> tuple[Any, int, bool]:
        """Published frames are immutable; analysis holds references without copying."""
        with self._lock:
            return self._latest, self._sequence, self._source_closed

    def close_source(self) -> None:
        with self._condition:
            self._source_closed = True
            self._condition.notify_all()

    def wait_for_history(self, timeout: float = HISTORY_WAIT_SECONDS) -> None:
        """Wait for real, spaced samples; never duplicate a static source's frame."""
        with self._condition:
            self._condition.wait_for(
                lambda: self._source_closed or len(self._history) >= HISTORY_FRAMES,
                timeout=timeout,
            )
            if self._source_closed:
                raise CaptureBackendError("CAPTURE_SOURCE_STALE", "Capture source closed")

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
        last = detect([frozen_frame], trim_chrome=False)
        if last.rect is None:
            return {"rect": None, "reason": "unstable"}
        # The single-frame probe cannot discover static chrome. Subtract the
        # temporal result's same strips before comparing game aspects.
        width = last.rect[2] - result.chrome["left"] - result.chrome["right"]
        height = last.rect[3] - result.chrome["top"] - result.chrome["bottom"]
        if width <= 0 or height <= 0 or abs((width / height) / result.aspect - 1) > 0.01:
            return {"rect": None, "reason": "unstable"}
        return {"rect": pixel_rect(result.rect), "aspect": result.aspect,
                "chrome": result.chrome, "frames": len(samples)}


def validate_command(metadata: dict[str, Any], expected_type: str | None = None) -> tuple[str, str]:
    base = {"protocolVersion", "sessionId", "type"}
    command_type = metadata.get("type")
    fields = {"start": base | {"selector"}, "analyze": base | {"deadlineMs", "targetFps"},
              "freeze": base, "stop": base, "analyze_cancel": base}
    if not isinstance(command_type, str) or command_type not in fields or set(metadata) != fields[command_type]:
        raise ProtocolError("prepared capture command fields are invalid")
    if type(metadata.get("protocolVersion")) is not int or metadata["protocolVersion"] != 2:
        raise ProtocolError("prepared capture protocol version is invalid")
    session_id = metadata.get("sessionId")
    if not isinstance(session_id, str) or not 1 <= len(session_id) <= 128:
        raise ProtocolError("prepared capture command identity is invalid")
    if command_type == "analyze" and (type(metadata["deadlineMs"]) is not int or metadata["deadlineMs"] != DEADLINE_MS
            or type(metadata["targetFps"]) is not int or metadata["targetFps"] != TARGET_FPS):
        raise ProtocolError("prepared capture analysis limits are invalid")
    if command_type == "start":
        selector = metadata["selector"]
        if not isinstance(selector, dict):
            raise ProtocolError("prepared capture selector is invalid")
        if selector.get("kind") == "window" and set(selector) == {"kind", "windowHwnd"}:
            from capture.backend import parse_window_hwnd
            parse_window_hwnd(selector["windowHwnd"])
        elif selector.get("kind") == "display" and set(selector) == {"kind", "displayDeviceName", "electronDisplayId"}:
            device, display_id = selector["displayDeviceName"], selector["electronDisplayId"]
            if (not isinstance(device, str) or not device.startswith(r"\\.\DISPLAY") or len(device) > 32
                    or not isinstance(display_id, str) or not 1 <= len(display_id) <= 128):
                raise ProtocolError("prepared capture display selector is invalid")
        else:
            raise ProtocolError("prepared capture selector is invalid")
    if expected_type is not None and command_type != expected_type:
        raise ProtocolError("prepared capture command order is invalid")
    return session_id, command_type


def window_iconic_probe(selector: dict[str, Any]) -> Callable[[], bool] | None:
    if selector["kind"] != "window":
        return None
    from capture.backend import parse_window_hwnd

    hwnd = parse_window_hwnd(selector["windowHwnd"])
    is_iconic = ctypes.WinDLL("user32", use_last_error=True).IsIconic
    is_iconic.argtypes = [wintypes.HWND]
    is_iconic.restype = wintypes.BOOL
    return lambda: bool(is_iconic(hwnd))


def main() -> None:
    output_lock = threading.Lock()
    backend: WindowsMonitorBackend | None = None
    session_id = "unknown"
    event_sequence = 0
    analysis: LiveAnalysis | None = None

    def emit(event_type: str, payload: dict[str, Any], binary: bytes = b"") -> None:
        nonlocal event_sequence
        with output_lock:
            event_sequence += 1
            write_envelope(
                sys.stdout.buffer,
                {
                    "protocolVersion": 2,
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
            store.close_source()
            if analysis is None or (analysis.thread.ident is not None and not analysis.thread.is_alive()):
                emit(
                    "fatal",
                    {"code": "CAPTURE_SOURCE_STALE", "message": "Capture source closed"},
                )

        backend = WindowsMonitorBackend(selector)
        backend.start(on_frame, on_closed)
        while True:
            command = read_stream_envelope(sys.stdin.buffer, max_binary_bytes=0)
            if command.binary:
                raise ProtocolError("prepared capture command must not contain binary data")
            command_session_id, command_type = validate_command(command.metadata)
            if command_session_id != session_id:
                raise ProtocolError("prepared capture session is stale")
            if command_type == "analyze":
                if analysis is not None and analysis.thread.is_alive():
                    if not analysis.finishing.is_set():
                        raise ProtocolError("prepared capture analysis is already running")
                    analysis.thread.join()
                analysis = LiveAnalysis(store, emit, is_iconic=window_iconic_probe(selector))
                analysis.start()
                continue
            if command_type == "analyze_cancel":
                if analysis is not None:
                    analysis.cancel()
                    analysis = None
                emit("analysis_cancelled", {})
                continue
            if analysis is not None:
                analysis.cancel()
                analysis = None
            if command_type == "stop":
                stopping.set()
                backend.stop()
                backend = None
                emit("stopped", {})
                return
            if command_type != "freeze" or source_closed.is_set():
                raise ProtocolError("prepared capture command order is invalid")
            store.wait_for_history()
            frame, frame_sequence = store.freeze()
            stopping.set()
            backend.stop()
            backend = None
            png_bytes = encode_png(frame)
            height, width = frame.shape[:2]
            emit(
                "frozen",
                {"frameSequence": frame_sequence, "width": int(width), "height": int(height),
                 "mimeType": "image/png", "byteLength": len(png_bytes), "game": store.game(frame)},
                png_bytes,
            )
            return
    except (ProtocolError, CaptureBackendError, Exception) as error:
        code = getattr(error, "code", "PREPARED_CAPTURE_FAILED")
        try:
            emit("fatal", {"code": code, "message": str(error)[:300]})
        except Exception:
            pass
    finally:
        if analysis is not None:
            analysis.cancel()
        if backend is not None:
            try:
                backend.stop()
            except Exception:
                pass


if __name__ == "__main__":
    main()
