from __future__ import annotations

import cv2
import numpy as np
import pytest

from geometry import rank_line as rl
from geometry.shape_match import ShapeTemplate
from geometry.zones import Badge

BADGE = Badge(.4958, .4289, .2194, .1484)        # own battle, 9:16 (owner recordings)
RECT = (0, 0, 1080, 1920)


@pytest.mark.parametrize("medal,league,line", [
    (0.85, 0.55, "medal"), (0.70, 0.66, "medal"), (0.45, 0.83, "league"), (0.66, 0.72, "league"),
    (0.52, 0.48, "empty"), (0.30, 0.20, "empty"), (0.63, 0.40, "unknown"), (0.40, 0.58, "unknown"),
    (0.69, 0.78, "league"),                        # both high: the league badge wins only by the margin
])
def test_line_classes(medal: float, league: float, line: str) -> None:
    assert rl.classify(medal, league) == line


def test_zones_are_mirrored_about_the_badge() -> None:
    zones = rl.zones(BADGE, RECT[2] / RECT[3])
    opponent, own = zones["opponent"], zones["own"]
    assert opponent[0] + own[1] == pytest.approx(2 * BADGE.cx, abs=1e-6)
    assert opponent[1] + own[0] == pytest.approx(2 * BADGE.cx, abs=1e-6)
    assert opponent[3] < BADGE.cy - BADGE.height / 2 + 0.05 < own[2]
    # Under the opponent name (top-left), never the banner corners on the right.
    assert opponent[1] < 0.35 and own[0] > 0.65


def shield(size: int = 60) -> np.ndarray:
    image = np.full((size, size, 3), 128, np.uint8)
    points = np.array([[8, 6], [52, 6], [52, 34], [30, 56], [8, 34]], np.int32) * size // 60
    cv2.fillPoly(image, [points], (40, 60, 200))
    cv2.polylines(image, [points], True, (240, 240, 240), 3)
    return image


def medal(size: int = 60) -> np.ndarray:
    image = np.full((size, size, 3), 128, np.uint8)
    cv2.fillPoly(image, [np.array([[22, 34], [38, 34], [42, 58], [30, 50], [18, 58]]) * size // 60], (150, 40, 150))
    cv2.circle(image, (size // 2, size // 3), size // 4, (30, 180, 220), -1)
    cv2.circle(image, (size // 2, size // 3), size // 4, (250, 250, 250), 2)
    return image


def templates() -> rl.RankTemplates:
    def build(image, name):
        height = rl.RANK_TEMPLATE_HEIGHTS["league" if name == "league" else "medal"]
        return ShapeTemplate.build(cv2.resize(image, (height, height)), name)
    return rl.RankTemplates(build(medal(), "medal"), tuple(build(shield(), "league") for _ in range(6)))


def frame_with(icons: dict[str, np.ndarray | None]) -> np.ndarray:
    rng = np.random.default_rng(5)
    frame = cv2.resize(rng.integers(90, 110, (60, 34, 3), dtype=np.uint8), (1080, 1920),
                       interpolation=cv2.INTER_LINEAR)
    for side, zone in rl.zones(BADGE, RECT[2] / RECT[3]).items():
        icon = icons.get(side)
        if icon is None:
            continue
        x0, x1, y0, y1 = zone
        height = round(rl.RANK_TEMPLATE_HEIGHTS["medal"] * 1920 / rl.RANK_PX * 1.0)
        big = cv2.resize(icon, (height, height))
        top = round((y0 + y1) / 2 * 1920) - height // 2
        left = round((x0 + 0.25 * (x1 - x0)) * 1080) - height // 2
        frame[top:top + height, left:left + height] = big
    return frame


def test_check_rank_reads_both_lines() -> None:
    result = rl.check_rank(frame_with({"opponent": medal(), "own": shield()}), RECT, BADGE, templates())
    assert result == {"rank": "pol", "rankEvidence": {"opponent": "medal", "own": "league"}}


def test_empty_lines_are_not_pol() -> None:
    result = rl.check_rank(frame_with({}), RECT, BADGE, templates())
    assert result == {"rank": "not_pol", "rankEvidence": {"opponent": "empty", "own": "empty"}}


def test_zone_outside_the_frame_is_unknown() -> None:
    result = rl.check_rank(np.zeros((40, 40, 3), np.uint8), (0, 0, 40, 40), Badge(.5, .43, .22, .15), templates())
    assert result["rank"] == "unknown"
