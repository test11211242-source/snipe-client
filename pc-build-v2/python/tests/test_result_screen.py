from __future__ import annotations

import json

import cv2
import numpy as np
import pytest

from geometry import result_screen as rs
from geometry.rank_line import RankTemplates
from geometry.shape_match import ShapeTemplate


def test_bundled_templates_load_and_carry_no_pixels() -> None:
    result = rs.ResultTemplates.load()
    assert len(result.leagues) == 6
    assert result.vs.size[0] < 64 and result.crown.size[0] < 64
    rank = RankTemplates.load()
    assert len(rank.leagues) == 6
    document = json.loads(rs.ASSET.read_text(encoding="utf-8"))
    for item in document["templates"]:
        assert item["algorithm"] == "orient2-q8-v1"
        assert set(item["source"]) <= {"sha256", "gameAspect", "frame", "box", "file", "height"}


def mask_with(sign: str, height: int = 20) -> np.ndarray:
    """Bright glyph mask: a sign, then two digit-height blocks."""
    mask = np.zeros((height + 8, 70), bool)
    top, mid = 4, 4 + height // 2
    if sign == "+":
        mask[mid - 1:mid + 2, 2:12] = True                    # arm
        mask[mid - 6:mid + 6, 6:9] = True                     # vertical stroke (0.6 of digits)
    elif sign == "-":
        mask[mid - 2:mid + 2, 2:11] = True                    # 0.2 of digits
    elif sign == "?":
        mask[mid - 4:mid + 4, 2:11] = True                    # 0.4: neither
    for x in (16, 34):
        mask[top:top + height, x:x + 12] = True
    return mask


@pytest.mark.parametrize("sign,expected", [("+", "+"), ("-", "-"), ("?", None), ("", None)])
def test_sign_from_glyph_heights(sign: str, expected) -> None:
    assert rs.sign_from_mask(mask_with(sign))[0] == expected


def test_sign_touching_the_first_digit() -> None:
    mask = mask_with("-")
    mask[13:17, 11:16] = True                                 # dash merged into the digit
    assert rs.sign_from_mask(mask)[0] == "-"
    plus = mask_with("+")
    plus[13:16, 12:16] = True
    assert rs.sign_from_mask(plus)[0] == "+"


def test_border_parts_are_icon_remnants() -> None:
    mask = mask_with("-")
    mask[:, 0:2] = True
    assert rs.sign_from_mask(rs._drop_border(mask, "left"))[0] is None   # the touching dash is dropped too
    clean = mask_with("-")
    assert rs.sign_from_mask(rs._drop_border(clean, "left"))[0] == "-"


def vs_patch() -> np.ndarray:
    image = np.full((40, 56, 3), 60, np.uint8)
    cv2.putText(image, "vs", (6, 30), cv2.FONT_HERSHEY_DUPLEX, 1.0, (250, 250, 250), 3, cv2.LINE_AA)
    return image


def synthetic_templates() -> rs.ResultTemplates:
    vs = ShapeTemplate.build(vs_patch(), "result-vs")
    dummy = ShapeTemplate.build(np.full((20, 20, 3), 90, np.uint8), "dummy")
    return rs.ResultTemplates(vs, dummy, dummy, (dummy,))


def game_frame(*, vs_at: float | None = 0.024, colour=(250, 250, 250)) -> tuple[np.ndarray, tuple]:
    """1080×1520 game (U = 1520), the result vs drawn at VS_PX scale."""
    rng = np.random.default_rng(3)
    frame = cv2.resize(rng.integers(70, 130, (40, 28, 3), dtype=np.uint8), (1080, 1520),
                       interpolation=cv2.INTER_NEAREST)
    rect = (0, 0, 1080, 1520)
    if vs_at is not None:
        patch = vs_patch()
        patch[patch > 200] = 0
        cv2.putText(patch, "vs", (6, 30), cv2.FONT_HERSHEY_DUPLEX, 1.0, colour, 3, cv2.LINE_AA)
        scale = 1520 / rs.VS_PX
        big = cv2.resize(patch, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
        cy = round(760 + vs_at * 1520)
        y0, x0 = cy - big.shape[0] // 2, 540 - big.shape[1] // 2
        frame[y0:y0 + big.shape[0], x0:x0 + big.shape[1]] = big
    return frame, rect


@pytest.mark.parametrize("colour", [(250, 250, 250), (40, 190, 230), (150, 150, 150)])
def test_find_vs_by_shape_in_any_colour(colour) -> None:
    frame, rect = game_frame(colour=colour)
    hit = rs.find_vs(frame, rect, synthetic_templates())
    assert hit.score >= rs.VS_FIRE_T
    assert hit.uy == pytest.approx(0.024, abs=0.004) and hit.ux == pytest.approx(0, abs=0.004)


def test_no_vs_scores_below_the_trigger() -> None:
    frame, rect = game_frame(vs_at=None)
    assert rs.find_vs(frame, rect, synthetic_templates()).score < rs.VS_FIRE_T


def test_crown_counts_use_the_slot_threshold() -> None:
    scores = {"top": [0.7, 0.2, 0.46], "bottom": [0.1, 0.44, 0.3]}
    assert rs.count_crowns(scores) == {"top": 2, "bottom": 0}
