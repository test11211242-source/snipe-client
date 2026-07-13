"""Windows-only windows-capture adapter. Importing this module is cross-platform safe."""

from __future__ import annotations

import ctypes
import sys
import threading
import time
from ctypes import wintypes
from typing import Any

MAX_PIXELS = 20_000_000


class CaptureBackendError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def parse_window_hwnd(value: Any) -> int:
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise CaptureBackendError("INVALID_WINDOW_HANDLE", "Window handle is invalid")
    hwnd = int(value, 10)
    if hwnd <= 0 or hwnd > 0x7FFFFFFFFFFFFFFF:
        raise CaptureBackendError("INVALID_WINDOW_HANDLE", "Window handle is out of range")
    return hwnd


def monitor_index_for_device(device_name: str) -> int:
    if sys.platform != "win32":
        raise CaptureBackendError("PLATFORM_UNAVAILABLE", "Capture is available on Windows only")
    if not isinstance(device_name, str) or not device_name.startswith(r"\\.\DISPLAY"):
        raise CaptureBackendError("INVALID_DISPLAY_SELECTOR", "Display device name is invalid")

    class MonitorInfoEx(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
            ("szDevice", wintypes.WCHAR * 32),
        ]

    devices: list[str] = []
    callback_type = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM
    )

    def callback(monitor: int, _dc: int, _rect: Any, _data: int) -> bool:
        info = MonitorInfoEx()
        info.cbSize = ctypes.sizeof(info)
        if not ctypes.windll.user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            raise CaptureBackendError("DISPLAY_ENUMERATION_FAILED", "Cannot inspect display")
        devices.append(info.szDevice)
        return True

    if not ctypes.windll.user32.EnumDisplayMonitors(None, None, callback_type(callback), 0):
        raise CaptureBackendError("DISPLAY_ENUMERATION_FAILED", "Cannot enumerate displays")
    try:
        return devices.index(device_name) + 1
    except ValueError as error:
        raise CaptureBackendError("CAPTURE_SOURCE_STALE", "Display is no longer available") from error


def capture_once(selector: dict[str, Any]) -> tuple[bytes, int, int]:
    if sys.platform != "win32":
        raise CaptureBackendError("PLATFORM_UNAVAILABLE", "Capture is available on Windows only")

    import cv2
    from windows_capture import Frame, InternalCaptureControl, WindowsCapture

    if selector.get("kind") == "window" and set(selector) == {"kind", "windowHwnd"}:
        capture = WindowsCapture(
            cursor_capture=False,
            draw_border=None,
            monitor_index=None,
            window_name=None,
            window_hwnd=parse_window_hwnd(selector["windowHwnd"]),
        )
    elif selector.get("kind") == "display" and set(selector) == {
        "kind",
        "displayDeviceName",
        "electronDisplayId",
    }:
        capture = WindowsCapture(
            cursor_capture=False,
            draw_border=None,
            monitor_index=monitor_index_for_device(selector["displayDeviceName"]),
            window_name=None,
            window_hwnd=None,
        )
    else:
        raise CaptureBackendError("INVALID_CAPTURE_SELECTOR", "Capture selector is invalid")

    result: dict[str, Any] = {}
    first_frame = threading.Event()
    source_closed = threading.Event()
    result_lock = threading.Lock()

    @capture.event
    def on_frame_arrived(frame: Frame, control: InternalCaptureControl) -> None:
        size = (int(frame.width), int(frame.height))
        if size[0] <= 0 or size[1] <= 0 or size[0] * size[1] > MAX_PIXELS:
            with result_lock:
                result["error"] = CaptureBackendError("FRAME_SIZE_INVALID", "Captured frame size is invalid")
            first_frame.set()
            return
        encoded, png = cv2.imencode(".png", frame.frame_buffer, [cv2.IMWRITE_PNG_COMPRESSION, 3])
        with result_lock:
            if not encoded:
                result["error"] = CaptureBackendError("PNG_ENCODE_FAILED", "Could not encode capture")
            else:
                result.update(png=png.tobytes(), width=size[0], height=size[1])
        first_frame.set()

    @capture.event
    def on_closed() -> None:
        with result_lock:
            if "png" not in result:
                result["error"] = CaptureBackendError("CAPTURE_SOURCE_STALE", "Capture source closed")
        source_closed.set()
        first_frame.set()

    control = capture.start_free_threaded()
    if not first_frame.wait(timeout=5.0):
        control.stop()
        control.wait()
        raise CaptureBackendError("CAPTURE_TIMEOUT", "Capture source did not produce a frame")
    if not source_closed.is_set():
        time.sleep(0.15)
    control.stop()
    control.wait()
    if "error" in result:
        raise result["error"]
    if "png" not in result:
        raise CaptureBackendError("CAPTURE_NO_FRAME", "Capture ended without a frame")
    return result["png"], result["width"], result["height"]
