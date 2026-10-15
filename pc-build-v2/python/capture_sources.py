"""Capture-source metadata and window previews for the source picker (Windows only).

One JSON request on stdin, JSON lines on stdout:

- ``{"op": "displays"}`` -> ``{"displays": [{deviceName, bounds}]}`` in physical pixels.
- ``{"op": "windows", "handles": [...]}`` -> ``{"windows": [{windowHwnd, ownerProcessId,
  executableLabel}]}``.
- ``{"op": "previews", "handles": [...], "maxWidth": w, "maxHeight": h}`` -> one line per
  handle, in request order, written as soon as that window is captured.

Plain ctypes calls only: no PowerShell, no compiled helper. Metadata requests do not import
numpy or OpenCV. Importing this module is cross-platform safe.
"""

from __future__ import annotations

import base64
import ctypes
import json
import sys
from ctypes import wintypes
from typing import Any, Callable

MAX_HANDLES = 512
MAX_PREVIEW_SIDE = 1024
MAX_WINDOW_PIXELS = 40_000_000
MAX_PREVIEW_BYTES = 512 * 1024
PREVIEW_JPEG_QUALITY = 76
PW_RENDERFULLCONTENT = 0x00000002
TH32CS_SNAPPROCESS = 0x00000002
DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4


class RequestError(ValueError):
    pass


def parse_handle(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value.isascii()
        or not value.isdecimal()
        or value.startswith("0")
        or len(value) > 19
        or int(value, 10) > 0x7FFFFFFFFFFFFFFF
    ):
        raise RequestError("Window handle is invalid")
    return value


def parse_request(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise RequestError("Request must be an object")
    op = raw.get("op")
    if op == "displays":
        if set(raw) != {"op"}:
            raise RequestError("Unexpected request fields")
        return {"op": op}
    if op not in ("windows", "previews"):
        raise RequestError("Unknown operation")
    expected = {"op", "handles"} if op == "windows" else {"op", "handles", "maxWidth", "maxHeight"}
    if set(raw) != expected:
        raise RequestError("Unexpected request fields")
    handles = raw["handles"]
    if not isinstance(handles, list) or len(handles) > MAX_HANDLES:
        raise RequestError("Window handles are invalid")
    request: dict[str, Any] = {"op": op, "handles": [parse_handle(handle) for handle in handles]}
    if op == "previews":
        for key in ("maxWidth", "maxHeight"):
            value = raw[key]
            if type(value) is not int or not 1 <= value <= MAX_PREVIEW_SIDE:
                raise RequestError("Preview size is invalid")
            request[key] = value
    return request


def executable_label(image_name: str | None) -> str | None:
    """Same label the former PowerShell helper produced: ``<ProcessName>.exe``."""
    if not image_name:
        return None
    stem = image_name[:-4] if image_name.lower().endswith(".exe") else image_name
    if not stem:
        return None
    return f"{stem}.exe"[:120]


def fit_size(width: int, height: int, max_width: int, max_height: int) -> tuple[int, int]:
    scale = min(max_width / width, max_height / height, 1.0)
    return max(1, min(max_width, round(width * scale))), max(1, min(max_height, round(height * scale)))


def encode_preview(bgra: Any, max_width: int, max_height: int) -> tuple[bytes, int, int] | None:
    import cv2

    height, width = bgra.shape[:2]
    target_width, target_height = fit_size(width, height, max_width, max_height)
    bgr = bgra[:, :, :3]
    if (target_width, target_height) != (width, height):
        bgr = cv2.resize(bgr, (target_width, target_height), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, PREVIEW_JPEG_QUALITY])
    if not ok:
        return None
    data = encoded.tobytes()
    if not data or len(data) > MAX_PREVIEW_BYTES:
        return None
    return data, target_width, target_height


class _Rect(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _MonitorInfoEx(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", _Rect),
        ("rcWork", _Rect),
        ("dwFlags", wintypes.DWORD),
        ("szDevice", wintypes.WCHAR * 32),
    ]


class _ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


class _BitmapInfoHeader(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class WindowsNative:
    """Typed user32/gdi32/kernel32 calls; 64-bit handles keep pointer-sized prototypes."""

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("Capture sources are available on Windows only")
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        u, g, k = self.user32, self.gdi32, self.kernel32
        u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        u.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        u.GetWindowThreadProcessId.restype = wintypes.DWORD
        for name in ("IsWindow", "IsIconic", "IsHungAppWindow"):
            getattr(u, name).argtypes = [wintypes.HWND]
            getattr(u, name).restype = wintypes.BOOL
        u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(_Rect)]
        u.GetWindowRect.restype = wintypes.BOOL
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        u.GetWindowTextLengthW.restype = ctypes.c_int
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetWindowTextW.restype = ctypes.c_int
        u.GetWindowDC.argtypes = [wintypes.HWND]
        u.GetWindowDC.restype = wintypes.HDC
        u.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        u.ReleaseDC.restype = ctypes.c_int
        u.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
        u.PrintWindow.restype = wintypes.BOOL
        u.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(_MonitorInfoEx)]
        u.GetMonitorInfoW.restype = wintypes.BOOL
        g.CreateCompatibleDC.argtypes = [wintypes.HDC]
        g.CreateCompatibleDC.restype = wintypes.HDC
        g.CreateDIBSection.argtypes = [
            wintypes.HDC,
            ctypes.POINTER(_BitmapInfoHeader),
            wintypes.UINT,
            ctypes.POINTER(ctypes.c_void_p),
            wintypes.HANDLE,
            wintypes.DWORD,
        ]
        g.CreateDIBSection.restype = wintypes.HBITMAP
        g.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
        g.SelectObject.restype = wintypes.HGDIOBJ
        g.DeleteObject.argtypes = [wintypes.HGDIOBJ]
        g.DeleteObject.restype = wintypes.BOOL
        g.DeleteDC.argtypes = [wintypes.HDC]
        g.DeleteDC.restype = wintypes.BOOL
        k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry)]
        k.Process32FirstW.restype = wintypes.BOOL
        k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry)]
        k.Process32NextW.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        if not u.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2):
            raise RuntimeError("DPI awareness failed")

    def displays(self) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        failed: list[bool] = []
        callback_type = ctypes.WINFUNCTYPE(
            wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(_Rect), wintypes.LPARAM
        )

        def callback(monitor: int, _dc: int, _rect: Any, _data: int) -> bool:
            info = _MonitorInfoEx()
            info.cbSize = ctypes.sizeof(info)
            if not self.user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
                failed.append(True)  # an exception cannot cross the ctypes callback boundary
                return False
            rect = info.rcMonitor
            found.append(
                {
                    "deviceName": info.szDevice,
                    "bounds": {
                        "x": rect.left,
                        "y": rect.top,
                        "width": rect.right - rect.left,
                        "height": rect.bottom - rect.top,
                    },
                }
            )
            return True

        if not self.user32.EnumDisplayMonitors(None, None, callback_type(callback), 0) or failed:
            raise RuntimeError("Cannot enumerate displays")
        return found

    def process_image_names(self) -> dict[int, str]:
        snapshot = self.kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snapshot is None or snapshot == wintypes.HANDLE(-1).value:
            raise RuntimeError("Cannot list processes")
        names: dict[int, str] = {}
        try:
            entry = _ProcessEntry()
            entry.dwSize = ctypes.sizeof(entry)
            more = self.kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
            while more:
                names[int(entry.th32ProcessID)] = entry.szExeFile
                more = self.kernel32.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            self.kernel32.CloseHandle(snapshot)
        return names

    def window_process_id(self, handle: str) -> int:
        process_id = wintypes.DWORD(0)
        self.user32.GetWindowThreadProcessId(int(handle), ctypes.byref(process_id))
        return int(process_id.value)

    def window_title(self, handle: str) -> str:
        length = self.user32.GetWindowTextLengthW(int(handle))
        if length <= 0:
            return ""
        buffer = ctypes.create_unicode_buffer(min(length, 4096) + 1)
        self.user32.GetWindowTextW(int(handle), buffer, len(buffer))
        return buffer.value

    def window_state(self, handle: str) -> str:
        hwnd = int(handle)
        if not self.user32.IsWindow(hwnd) or self.user32.IsIconic(hwnd):
            return "unavailable"
        if self.user32.IsHungAppWindow(hwnd):
            return "failed"
        return "ok"

    def capture_window(self, handle: str) -> Any:
        """Full window through DWM (``PW_RENDERFULLCONTENT``): BGRA array or None."""
        import numpy as np

        hwnd = int(handle)
        rect = _Rect()
        if not self.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if width <= 0 or height <= 0 or width * height > MAX_WINDOW_PIXELS:
            return None
        window_dc = self.user32.GetWindowDC(hwnd)
        if not window_dc:
            return None
        memory_dc = self.gdi32.CreateCompatibleDC(window_dc)
        header = _BitmapInfoHeader()
        header.biSize = ctypes.sizeof(header)
        header.biWidth = width
        header.biHeight = -height
        header.biPlanes = 1
        header.biBitCount = 32
        bits = ctypes.c_void_p()
        bitmap = self.gdi32.CreateDIBSection(window_dc, ctypes.byref(header), 0, ctypes.byref(bits), None, 0)
        try:
            if not memory_dc or not bitmap or not bits.value:
                return None
            previous = self.gdi32.SelectObject(memory_dc, bitmap)
            try:
                if not self.user32.PrintWindow(hwnd, memory_dc, PW_RENDERFULLCONTENT):
                    return None
                pixels = ctypes.cast(bits, ctypes.POINTER(ctypes.c_uint8))
                return np.ctypeslib.as_array(pixels, shape=(height, width, 4)).copy()
            finally:
                self.gdi32.SelectObject(memory_dc, previous)
        finally:
            if bitmap:
                self.gdi32.DeleteObject(bitmap)
            if memory_dc:
                self.gdi32.DeleteDC(memory_dc)
            self.user32.ReleaseDC(hwnd, window_dc)


def window_metadata(native: Any, handles: list[str]) -> list[dict[str, Any]]:
    names = native.process_image_names()
    items = []
    for handle in handles:
        process_id = native.window_process_id(handle)
        if process_id <= 0:
            continue
        items.append(
            {
                "windowHwnd": handle,
                "ownerProcessId": process_id,
                "executableLabel": executable_label(names.get(process_id)),
            }
        )
    return items


def window_previews(native: Any, request: dict[str, Any], emit: Callable[[dict[str, Any]], None]) -> None:
    for handle in request["handles"]:
        record: dict[str, Any] = {"windowHwnd": handle, "status": native.window_state(handle)}
        if record["status"] == "ok":
            try:
                pixels = native.capture_window(handle)
                encoded = None if pixels is None else encode_preview(pixels, request["maxWidth"], request["maxHeight"])
            except Exception:  # one broken window must not cost the others their previews
                encoded = None
            if encoded is None:
                record["status"] = "failed"
            else:
                data, width, height = encoded
                record.update(
                    title=native.window_title(handle)[:300],
                    width=width,
                    height=height,
                    jpeg=base64.b64encode(data).decode("ascii"),
                )
        emit(record)


def run(request: dict[str, Any], native: Any, emit: Callable[[dict[str, Any]], None]) -> None:
    if request["op"] == "displays":
        emit({"displays": native.displays()})
    elif request["op"] == "windows":
        emit({"windows": window_metadata(native, request["handles"])})
    else:
        window_previews(native, request, emit)


def main() -> int:
    try:
        request = parse_request(json.loads(sys.stdin.buffer.read(1024 * 1024).decode("utf-8")))
    except (ValueError, UnicodeDecodeError):
        return 2

    def emit(record: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    try:
        run(request, WindowsNative(), emit)
    except Exception:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
