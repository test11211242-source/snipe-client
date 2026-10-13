import base64

import cv2
import numpy as np
import pytest

from analyze_trigger import analyze, structure_hash64, validate_pixel_rect
from protocol.framing import ProtocolError


def encode(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def coarse_selection() -> tuple[np.ndarray, dict[str, int]]:
    image = np.full((240, 320, 3), (24, 38, 62), dtype=np.uint8)
    cv2.rectangle(image, (122, 78), (202, 162), (235, 235, 235), 3)
    cv2.line(image, (132, 92), (192, 148), (235, 235, 235), 5)
    cv2.circle(image, (176, 112), 13, (20, 20, 20), 3)
    return image, {"x": 40, "y": 30, "width": 240, "height": 180}


def decode_map(value: str) -> np.ndarray:
    decoded = cv2.imdecode(
        np.frombuffer(base64.b64decode(value, validate=True), dtype=np.uint8),
        cv2.IMREAD_GRAYSCALE,
    )
    assert decoded is not None
    return decoded


def test_builds_compact_colorless_structural_profile_from_coarse_selection() -> None:
    image, outer = coarse_selection()
    profile = analyze(encode(image), outer)

    assert profile["schemaVersion"] == 3
    assert profile["structureAlgorithm"] == "max-channel-scharr-v1"
    assert profile["matcherMode"] in ("edge", "edge_orb")
    assert profile["quality"]["grade"] in ("high", "medium")
    assert profile["quality"]["cropAreaRatio"] < 0.5
    assert profile["quality"]["cropConfidence"] >= 0.4
    assert profile["innerRect"]["width"] < 0.7
    assert profile["innerRect"]["height"] < 0.8

    structure = decode_map(profile["structureTemplateBase64"])
    edges = decode_map(profile["edgeTemplateBase64"])
    orientation = decode_map(profile["orientationTemplateBase64"])
    assert structure.shape == edges.shape == orientation.shape == (128, 128)
    assert np.count_nonzero(edges) == profile["quality"]["edgePixelCount"]
    assert structure_hash64(structure) == profile["structureHash64"]


def test_keeps_disconnected_ui_parts_in_the_same_inner_crop() -> None:
    image = np.full((180, 260, 3), 35, dtype=np.uint8)
    cv2.putText(image, "A", (75, 110), cv2.FONT_HERSHEY_SIMPLEX, 1.7, (230, 230, 230), 5)
    cv2.putText(image, "B", (145, 110), cv2.FONT_HERSHEY_SIMPLEX, 1.7, (230, 230, 230), 5)
    profile = analyze(
        encode(image), {"x": 20, "y": 15, "width": 220, "height": 150}
    )
    inner = profile["innerRect"]
    assert inner["x"] < 0.3
    assert inner["x"] + inner["width"] > 0.75
    assert profile["quality"]["cropAreaRatio"] < 0.65


def test_rejects_flat_regions_that_cannot_be_identified_without_color() -> None:
    image = np.full((120, 200, 3), (10, 40, 220), dtype=np.uint8)
    with pytest.raises(ProtocolError, match="too little stable structure"):
        analyze(encode(image), {"x": 20, "y": 20, "width": 160, "height": 80})


def test_rect_must_be_inside_actual_frame() -> None:
    with pytest.raises(ProtocolError, match="exceeds"):
        validate_pixel_rect({"x": 190, "y": 0, "width": 20, "height": 20}, 200, 120)


def test_manual_vs_is_recognized_only_inside_marked_area() -> None:
    from analyze_trigger import analyze_vs
    from synthetic_frames import arena

    image, badge = arena()
    game = {"x": 0, "y": 0, "width": 360, "height": 640}
    outer = {"x": 120, "y": 215, "width": 120, "height": 120}
    trigger, found = analyze_vs(encode(image), outer, game)
    assert trigger is not None
    assert trigger["algorithm"] == "vs-orient-1"
    assert found["cx"] == pytest.approx(badge.cx, abs=.006)
    assert analyze_vs(encode(image), {"x": 5, "y": 5, "width": 80, "height": 80}, game) == (None, None)
    assert analyze_vs(encode(image), outer, None) == (None, None)
    # The structural and legacy profiles remain built even for a recognized VS.
    from analyze_trigger import analyze_result
    profile, legacy = analyze_result(encode(image), outer)
    assert profile["schemaVersion"] == 3
    assert legacy is not None


def test_analyzer_protocol_two_returns_new_nullable_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    import io
    import analyze_trigger
    from protocol.framing import read_envelope, write_envelope

    image, outer = coarse_selection()
    incoming = io.BytesIO()
    write_envelope(incoming, {"protocolVersion": 2, "requestId": "unit", "operation": "analyze_trigger",
                              "outerRect": outer, "gameRect": None}, encode(image))
    incoming.seek(0)
    outgoing = io.BytesIO()
    monkeypatch.setenv("CR_TOOLS_REQUEST_ID", "unit")
    monkeypatch.setattr(analyze_trigger.sys, "stdin", type("Stream", (), {"buffer": incoming})())
    monkeypatch.setattr(analyze_trigger.sys, "stdout", type("Stream", (), {"buffer": outgoing})())
    analyze_trigger.main()
    outgoing.seek(0)
    response = read_envelope(outgoing, max_binary_bytes=0)
    assert response.metadata["protocolVersion"] == 2
    assert response.metadata["ok"]
    assert response.metadata["vsOrientation"] is None
    assert response.metadata["vsBadge"] is None
    assert response.metadata["profile"]["schemaVersion"] == 3
    assert response.metadata["legacyProfile"] is not None


@pytest.mark.parametrize("stage", ["search", "build"])
def test_optional_vs_geometry_failure_preserves_structural_profiles(monkeypatch, stage) -> None:
    import io
    import analyze_trigger
    from protocol.framing import read_envelope, write_envelope
    from synthetic_frames import arena

    image, _ = arena()
    outer = {"x": 120, "y": 215, "width": 120, "height": 120}
    game = {"x": 0, "y": 0, "width": 360, "height": 640}

    def fail(*args, **kwargs):
        raise ValueError("Orientation crop height outside 64..160")

    if stage == "search":
        monkeypatch.setattr(analyze_trigger, "search", fail)
    else:
        monkeypatch.setattr(analyze_trigger.OrientationTrigger, "build", fail)
    incoming, outgoing = io.BytesIO(), io.BytesIO()
    write_envelope(incoming, {"protocolVersion": 2, "requestId": "unit", "operation": "analyze_trigger",
                              "outerRect": outer, "gameRect": game}, encode(image))
    incoming.seek(0)
    monkeypatch.setenv("CR_TOOLS_REQUEST_ID", "unit")
    monkeypatch.setattr(analyze_trigger.sys, "stdin", type("Stream", (), {"buffer": incoming})())
    monkeypatch.setattr(analyze_trigger.sys, "stdout", type("Stream", (), {"buffer": outgoing})())
    analyze_trigger.main()
    outgoing.seek(0)
    response = read_envelope(outgoing, max_binary_bytes=0).metadata
    assert response["ok"]
    assert response["profile"]["schemaVersion"] == 3
    assert response["legacyProfile"] is not None
    assert response["vsOrientation"] is None
    assert response["vsBadge"] is None


def test_optional_vs_classification_does_not_hide_protocol_errors() -> None:
    from analyze_trigger import analyze_vs

    image, outer = coarse_selection()
    with pytest.raises(ProtocolError):
        analyze_vs(encode(image), outer, {"x": -1, "y": 0, "width": 100, "height": 100})


def test_crop_region_losslessly_preserves_selected_confirmation_pixels():
    from analyze_trigger import crop_region
    image = np.random.default_rng(19).integers(0, 256, (80, 120, 4), dtype=np.uint8)
    png, width, height = crop_region(encode(image), {"x": 13, "y": 21, "width": 57, "height": 32})
    crop = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_UNCHANGED)
    assert (width, height) == (57, 32)
    assert np.array_equal(crop, image[21:53, 13:70])


@pytest.mark.parametrize("rect", [
    {"x": -1, "y": 0, "width": 5, "height": 5},
    {"x": 0, "y": 0, "width": 321, "height": 1},
    {"x": 0, "y": 0, "width": 0, "height": 5},
    {"x": 0, "y": 0, "width": True, "height": 5},
    {"x": 0, "y": 0, "width": 5, "height": 5, "extra": 1},
])
def test_crop_region_rejects_invalid_rectangles(rect):
    from analyze_trigger import crop_region
    image, _ = coarse_selection()
    with pytest.raises(ProtocolError):
        crop_region(encode(image), rect)


def test_crop_region_rejects_non_png_input():
    from analyze_trigger import crop_region
    image, outer = coarse_selection()
    ok, jpeg = cv2.imencode(".jpg", image)
    assert ok
    with pytest.raises(ProtocolError):
        crop_region(jpeg.tobytes(), outer)


@pytest.mark.parametrize("changes", [{}, {"gameRect": None}, {"protocolVersion": 1}, {"unexpected": True}])
def test_crop_region_protocol_is_strict_and_returns_png(monkeypatch, changes):
    import io
    import analyze_trigger
    from protocol.framing import read_envelope, write_envelope
    image, outer = coarse_selection()
    incoming, outgoing = io.BytesIO(), io.BytesIO()
    metadata = {"protocolVersion": 2, "requestId": "crop", "operation": "crop_region", "outerRect": outer}
    write_envelope(incoming, {**metadata, **changes}, encode(image))
    incoming.seek(0)
    monkeypatch.setenv("CR_TOOLS_REQUEST_ID", "crop")
    monkeypatch.setattr(analyze_trigger.sys, "stdin", type("Stream", (), {"buffer": incoming})())
    monkeypatch.setattr(analyze_trigger.sys, "stdout", type("Stream", (), {"buffer": outgoing})())
    analyze_trigger.main()
    outgoing.seek(0)
    response = read_envelope(outgoing, max_binary_bytes=analyze_trigger.MAX_PNG_BYTES)
    if changes:
        assert not response.metadata["ok"]
        assert response.metadata["error"]["code"] == "ANALYSIS_FAILED"
        assert not response.binary
    else:
        assert response.metadata == {"protocolVersion": 2, "requestId": "crop", "ok": True,
                                     "width": 240, "height": 180, "mimeType": "image/png",
                                     "byteLength": len(response.binary)}
        crop = cv2.imdecode(np.frombuffer(response.binary, np.uint8), cv2.IMREAD_UNCHANGED)
        assert np.array_equal(crop, image[30:210, 40:280])
