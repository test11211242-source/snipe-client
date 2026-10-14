from __future__ import annotations

import base64

import numpy as np
import pytest

import capture_sources
from capture_sources import RequestError, encode_preview, executable_label, fit_size, parse_request, run


class FakeNative:
    def __init__(self) -> None:
        self.captured: list[str] = []

    def displays(self):
        return [{"deviceName": "\\\\.\\DISPLAY1", "bounds": {"x": 0, "y": 0, "width": 10, "height": 10}}]

    def process_image_names(self):
        return {10: "Game.exe", 11: "Registry", 12: "TOOL.EXE"}

    def window_process_id(self, handle: str) -> int:
        return {"1": 10, "2": 11, "3": 12, "4": 99}.get(handle, 0)

    def window_title(self, handle: str) -> str:
        return f"Window {handle}"

    def window_state(self, handle: str) -> str:
        return {"1": "ok", "2": "unavailable", "3": "failed"}.get(handle, "ok")

    def capture_window(self, handle: str):
        self.captured.append(handle)
        if handle == "5":
            raise OSError("PrintWindow crashed")
        if handle == "6":
            return None
        frame = np.zeros((400, 800, 4), dtype=np.uint8)
        frame[:, :, 2] = 200
        return frame


def collect(request):
    records = []
    native = FakeNative()
    run(parse_request(request), native, records.append)
    return records, native


def test_parse_request_accepts_only_exact_operations():
    assert parse_request({"op": "displays"}) == {"op": "displays"}
    assert parse_request({"op": "windows", "handles": ["1", "9223372036854775807"]})["handles"] == [
        "1",
        "9223372036854775807",
    ]
    for bad in (
        {"op": "displays", "extra": 1},
        {"op": "windows", "handles": ["01"]},
        {"op": "windows", "handles": ["9223372036854775808"]},
        {"op": "windows", "handles": ["1; exit"]},
        {"op": "windows", "handles": [1]},
        {"op": "windows", "handles": ["1"] * 513},
        {"op": "previews", "handles": ["1"], "maxWidth": 0, "maxHeight": 10},
        {"op": "previews", "handles": ["1"], "maxWidth": True, "maxHeight": 10},
        {"op": "shell"},
        [],
    ):
        with pytest.raises(RequestError):
            parse_request(bad)


def test_executable_label_matches_the_former_powershell_process_name_label():
    assert executable_label("Game.exe") == "Game.exe"
    assert executable_label("TOOL.EXE") == "TOOL.exe"
    assert executable_label("Registry") == "Registry.exe"
    assert executable_label("") is None
    assert executable_label(None) is None
    assert len(executable_label("x" * 300 + ".exe") or "") == 120


def test_window_metadata_reports_process_identity_and_skips_dead_windows():
    records, _ = collect({"op": "windows", "handles": ["1", "2", "3", "4", "7"]})
    assert records == [
        {
            "windows": [
                {"windowHwnd": "1", "ownerProcessId": 10, "executableLabel": "Game.exe"},
                {"windowHwnd": "2", "ownerProcessId": 11, "executableLabel": "Registry.exe"},
                {"windowHwnd": "3", "ownerProcessId": 12, "executableLabel": "TOOL.exe"},
                {"windowHwnd": "4", "ownerProcessId": 99, "executableLabel": None},
            ]
        }
    ]


def test_metadata_requests_do_not_import_image_libraries(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("metadata must not encode images")

    monkeypatch.setattr(capture_sources, "encode_preview", forbidden)
    records, native = collect({"op": "displays"})
    assert records[0]["displays"][0]["deviceName"] == "\\\\.\\DISPLAY1"
    assert native.captured == []


def test_previews_stream_one_record_per_window_in_request_order():
    records, native = collect(
        {"op": "previews", "handles": ["1", "2", "3", "5", "6"], "maxWidth": 360, "maxHeight": 203}
    )
    assert [(record["windowHwnd"], record["status"]) for record in records] == [
        ("1", "ok"),
        ("2", "unavailable"),
        ("3", "failed"),
        ("5", "failed"),
        ("6", "failed"),
    ]
    assert native.captured == ["1", "5", "6"]
    first = records[0]
    assert (first["width"], first["height"], first["title"]) == (360, 180, "Window 1")
    assert base64.b64decode(first["jpeg"])[:3] == b"\xff\xd8\xff"
    assert set(records[1]) == {"windowHwnd", "status"}


def test_fit_size_keeps_aspect_and_never_upscales():
    assert fit_size(1920, 1080, 360, 203) == (360, 202)
    assert fit_size(1080, 1920, 360, 203) == (114, 203)
    assert fit_size(100, 50, 360, 203) == (100, 50)


def test_encode_preview_returns_jpeg_within_bounds():
    data, width, height = encode_preview(np.full((1000, 500, 4), 90, dtype=np.uint8), 360, 203) or (b"", 0, 0)
    assert (width, height) == (102, 203)
    assert data[:3] == b"\xff\xd8\xff"
