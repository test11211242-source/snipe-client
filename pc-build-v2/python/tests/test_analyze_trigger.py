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
