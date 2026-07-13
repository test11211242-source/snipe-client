"""Isolated Windows adapter for persistent windows-capture 2.0.0 sessions."""

from __future__ import annotations

import sys
from typing import Any, Callable

from capture.backend import CaptureBackendError, monitor_index_for_device, parse_window_hwnd


class WindowsMonitorBackend:
    def __init__(self, selector: dict[str, Any]):
        if sys.platform != "win32":
            raise CaptureBackendError("PLATFORM_UNAVAILABLE", "Capture is available on Windows only")
        from windows_capture import WindowsCapture

        if selector.get("kind") == "window" and set(selector) == {"kind", "windowHwnd"}:
            self.capture = WindowsCapture(
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
            self.capture = WindowsCapture(
                cursor_capture=False,
                draw_border=None,
                monitor_index=monitor_index_for_device(selector["displayDeviceName"]),
                window_name=None,
                window_hwnd=None,
            )
        else:
            raise CaptureBackendError("INVALID_CAPTURE_SELECTOR", "Capture selector is invalid")
        self.control = None

    def start(
        self, frame_callback: Callable[[Any], None], closed_callback: Callable[[], None]
    ) -> None:
        @self.capture.event
        def on_frame_arrived(frame, _capture_control):
            frame_callback(frame.frame_buffer)

        @self.capture.event
        def on_closed():
            closed_callback()

        self.control = self.capture.start_free_threaded()

    def stop(self) -> None:
        if self.control is not None:
            self.control.stop()
            self.control.wait()
            self.control = None
