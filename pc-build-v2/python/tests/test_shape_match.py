from __future__ import annotations

import cv2
import numpy as np
import pytest

from geometry.shape_match import ShapeTemplate, best_match, crop_units, orientation_field, ui_unit


def glyph(text: str = "vs", *, fg=(255, 255, 255), bg=(40, 40, 40), size=(60, 40)) -> np.ndarray:
    image = np.full((size[1], size[0], 3), bg, np.uint8)
    cv2.putText(image, text, (4, size[1] - 10), cv2.FONT_HERSHEY_DUPLEX, 1.0, fg, 3, cv2.LINE_AA)
    return image


def textured(height: int, width: int, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = cv2.resize(rng.integers(60, 120, (height // 8 + 1, width // 8 + 1, 3), dtype=np.uint8), (width, height),
                      interpolation=cv2.INTER_NEAREST)
    return base


def test_unit_follows_the_interface_scaling() -> None:
    assert ui_unit((0, 0, 1080, 1920)) == 1920
    assert ui_unit((0, 0, 1546, 2128)) == 2128            # wider than 9:16: height
    assert ui_unit((0, 0, 1080, 2400)) == pytest.approx(1920)  # taller: width × 16/9


def test_template_round_trip_and_hash() -> None:
    template = ShapeTemplate.build(glyph(), "vs", source={"sha256": "0" * 64})
    restored = ShapeTemplate.from_dict(template.to_dict())
    assert restored.size == template.size
    assert np.allclose(restored.values, template.values, atol=0.03)
    broken = template.to_dict()
    broken["templateHash64"] = "0" * 16
    with pytest.raises(ValueError):
        ShapeTemplate.from_dict(broken)


@pytest.mark.parametrize("fg,bg", [((255, 255, 255), (40, 40, 40)), ((40, 200, 230), (90, 60, 30)),
                                   ((120, 120, 120), (100, 100, 100)), ((30, 30, 30), (220, 220, 220))])
def test_shape_score_ignores_colour_brightness_and_polarity(fg, bg) -> None:
    template = ShapeTemplate.build(glyph(), "vs")
    frame = textured(120, 160)
    frame[50:90, 70:130] = glyph(fg=fg, bg=bg)
    match = best_match(orientation_field(frame), template)
    assert match.score >= 0.65       # the result-vs trigger fires from 0.60
    assert (match.x, match.y) == pytest.approx((100, 70), abs=2)


def test_other_shapes_score_low() -> None:
    template = ShapeTemplate.build(glyph("vs"), "vs")
    frame = textured(120, 160)
    frame[50:90, 70:130] = glyph("OK")
    assert best_match(orientation_field(frame), template).score < 0.6


def test_crop_units_scales_to_pixels_per_unit_and_clips_to_the_game() -> None:
    frame = np.zeros((1000, 800, 3), np.uint8)
    rect = (100, 0, 562, 1000)                       # U = 1000
    crop = crop_units(frame, rect, (381, 500), (-0.1, 0.1, -0.05, 0.05), 500)
    assert crop.image.shape[:2] == (50, 100)
    assert crop.to_frame(0, 0) == pytest.approx((281, 450))
    edge = crop_units(frame, rect, (110, 500), (-0.1, 0.1, -0.05, 0.05), 500)
    assert edge.x0 == 100                            # never outside the game rectangle
    assert crop_units(frame, rect, (2000, 500), (0, 0.01, 0, 0.01), 500) is None
