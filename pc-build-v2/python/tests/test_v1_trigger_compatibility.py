import importlib.util
import sys
import types
from pathlib import Path

import cv2
import numpy as np
import pytest

from analyze_trigger import analyze_result
from protocol.framing import ProtocolError


def _load_v1_monitor():
    module_path = (
        Path(__file__).resolve().parents[3]
        / "pc-build"
        / "python_scripts"
        / "screen_monitor.py"
    )
    sys.modules.setdefault("windows_capture", types.ModuleType("windows_capture"))
    spec = importlib.util.spec_from_file_location("v1_screen_monitor", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _encode(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def _source_for(mode: str) -> np.ndarray:
    if mode == "orb":
        random = np.random.default_rng(91)
        return random.integers(0, 256, (128, 128, 3), dtype=np.uint8)
    image = np.full((128, 128, 3), 35, dtype=np.uint8)
    cv2.circle(image, (64, 64), 32, (230, 230, 230), 4)
    return image


@pytest.mark.parametrize("expected_mode", ["ncc", "orb"])
def test_transient_projection_matches_original_frame_with_v1_semantics(
    expected_mode: str,
) -> None:
    v1 = _load_v1_monitor()
    selected = _source_for(expected_mode)
    image = np.full((181, 223, 3), 17, dtype=np.uint8)
    outer_pixels = {"x": 41, "y": 27, "width": 128, "height": 128}
    image[27:155, 41:169] = selected
    profile, legacy = analyze_result(
        _encode(image), outer_pixels
    )
    assert legacy["featureMode"] == expected_mode

    outer_ratio = {
        "x": outer_pixels["x"] / image.shape[1],
        "y": outer_pixels["y"] / image.shape[0],
        "width": outer_pixels["width"] / image.shape[1],
        "height": outer_pixels["height"] / image.shape[0],
    }
    outer_rect = v1.ratio_to_rect(outer_ratio, image.shape[1], image.shape[0])
    inner_rect = v1.ratio_to_rect(
        profile["innerRect"], image.shape[1], image.shape[0], outer_rect
    )
    normalized = v1.normalize_grayscale(
        v1.crop_rect(image, inner_rect), legacy["normalizedTemplateSize"]
    )
    template = v1.decode_gray_template(legacy["templateGrayBase64"])
    assert np.array_equal(template, normalized)
    assert v1.compute_ahash(normalized) == legacy["thumbnailHash"]
    assert v1.hamming_distance(
        v1.compute_ahash(normalized), legacy["thumbnailHash"]
    ) == 0

    trigger = v1.TriggerProfile(
        {
            "id": "compatibility-test",
            "outer_ratio": outer_ratio,
            "inner_ratio": profile["innerRect"],
            "data_capture_ratio": outer_ratio,
            "feature_mode": legacy["featureMode"],
            "template_gray_base64": legacy["templateGrayBase64"],
            "thumbnail_hash": legacy["thumbnailHash"],
            "hash_max_distance": legacy["hashThreshold"],
            "orb_distance_threshold": legacy["orbDistanceThreshold"],
            "orb_min_good_matches": legacy["orbMinGoodMatches"],
            "ncc_min_score": legacy["nccThreshold"],
            "keypoints_count": legacy["keypointsCount"],
            "normalized_template_size": legacy["normalizedTemplateSize"],
        }
    )
    monitor = object.__new__(v1.ScreenMonitor)
    monitor.orb = cv2.ORB_create(nfeatures=400)
    monitor.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    evaluation = (
        monitor._evaluate_orb(normalized, trigger)
        if expected_mode == "orb"
        else monitor._evaluate_ncc(normalized, trigger)
    )
    assert evaluation["passed"] is True


def test_projection_rejects_a_color_only_trigger_that_is_constant_in_grayscale() -> None:
    image = np.zeros((128, 128, 3), dtype=np.uint8)
    image[:, :64] = (0, 0, 255)
    image[:, 64:] = (0, 130, 0)

    with pytest.raises(ProtocolError, match="luminance contrast"):
        analyze_result(
            _encode(image), {"x": 0, "y": 0, "width": 128, "height": 128}
        )


def test_projection_hash_threshold_uses_v1_hex_character_distance() -> None:
    v1 = _load_v1_monitor()
    _, legacy = analyze_result(
        _encode(_source_for("ncc")),
        {"x": 0, "y": 0, "width": 128, "height": 128},
    )

    distance = v1.hamming_distance("0000000000000000", "ffffffffffffffff")
    assert legacy["hashThreshold"] == 5
    assert distance == 16
    assert distance > legacy["hashThreshold"]
