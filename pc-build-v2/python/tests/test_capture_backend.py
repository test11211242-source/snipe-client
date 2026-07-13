import sys
from types import SimpleNamespace

import pytest

from capture.backend import CaptureBackendError, parse_window_hwnd
from capture.monitor_backend import WindowsMonitorBackend


def test_hwnd_is_parsed_as_bounded_decimal_string() -> None:
    assert parse_window_hwnd("9007199254740993") == 9007199254740993
    assert parse_window_hwnd(str(2**63 - 1)) == 2**63 - 1
    for invalid in (1, "0", "-1", "1e3", " 12", str(2**63)):
        with pytest.raises(CaptureBackendError):
            parse_window_hwnd(invalid)


def test_monitor_backend_registers_exact_windows_capture_event_names(monkeypatch) -> None:
    events = {}

    class FakeCapture:
        def __init__(self, **_options):
            pass

        def event(self, callback):
            events[callback.__name__] = callback
            return callback

        def start_free_threaded(self):
            return SimpleNamespace(stop=lambda: None, wait=lambda: None)

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "windows_capture", SimpleNamespace(WindowsCapture=FakeCapture))
    frames = []
    closed = []
    backend = WindowsMonitorBackend({"kind": "window", "windowHwnd": "123"})
    backend.start(frames.append, lambda: closed.append(True))

    assert set(events) == {"on_frame_arrived", "on_closed"}
    events["on_frame_arrived"](SimpleNamespace(frame_buffer="frame"), object())
    events["on_closed"]()
    assert frames == ["frame"]
    assert closed == [True]
