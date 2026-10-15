from __future__ import annotations

import cv2
import numpy as np
import pytest

from geometry.vs_orient_trigger import OrientationTrigger, extract
from synthetic_frames import arena, variants


@pytest.mark.parametrize("variant", ["original", "inverse", "gray", "dark", "bright", "gamma", "hue"])
def test_rule_c_robustness(variant: str) -> None:
    image, badge = arena()
    rect = (0, 0, 360, 640)
    trigger = OrientationTrigger.build(image, rect, badge)
    assert trigger.contains_center
    assert .45 <= trigger.mask_area_ratio <= .70
    score = trigger.score(variants(image)[variant], rect)
    assert score >= (.9 if variant == "original" else .7)


@pytest.mark.parametrize("scale", [.5, .75, 1.5])
def test_trigger_follows_physical_game_scale(scale: float) -> None:
    image, badge = arena(width=720, height=1280)
    trigger = OrientationTrigger.build(image, (0, 0, 720, 1280), badge)
    resized = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    h, w = resized.shape[:2]
    assert trigger.score(resized, (0, 0, w, h)) >= .7


@pytest.mark.parametrize("dx,dy", [(-3, -3), (3, 3), (-3, 3), (3, -3)])
def test_normalized_shift_search(dx: int, dy: int) -> None:
    image, badge = arena()
    rect = (0, 0, 360, 640)
    trigger = OrientationTrigger.build(image, rect, badge)
    patch = extract(image, badge, rect)
    shifted = cv2.warpAffine(patch, np.float32([[1, 0, dx], [0, 1, dy]]),
                             (patch.shape[1], patch.shape[0]), borderMode=cv2.BORDER_REPLICATE)
    assert trigger.score_patch(shifted) >= .7


def test_random_texture_and_q8_round_trip() -> None:
    image, badge = arena()
    rect = (0, 0, 360, 640)
    trigger = OrientationTrigger.build(image, rect, badge)
    random, _ = arena(seed=11, badge=False)
    assert trigger.score(random, rect) <= .3
    encoded = trigger.to_dict()
    restored = OrientationTrigger.from_dict(encoded)
    assert encoded == trigger.to_dict()
    assert len(encoded["templateHash64"]) == 16
    for frame in variants(image).values():
        assert abs(trigger.score(frame, rect) - restored.score(frame, rect)) < .01
    encoded["templateHash64"] = "0" * 16
    with pytest.raises(ValueError):
        OrientationTrigger.from_dict(encoded)
