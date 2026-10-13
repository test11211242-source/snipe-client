from __future__ import annotations

import pytest

from geometry.zones import Badge, layout_rejection, regions


@pytest.mark.parametrize("badge,aspect,expected", [
    (Badge(.493, .429, .22, .149), .565, ((.350, .336, .285, .186), (.054, .268, .921, .121), (0, .095, .405, .173))),
    (Badge(.496, .429, .22, .148), .5625, ((.353, .336, .285, .185), (.057, .268, .921, .121), (0, .096, .408, .173))),
    (Badge(.496, .421, .22, .119), .452, ((.353, .347, .285, .149), (.057, .292, .921, .097), (0, .154, .408, .139))),
    (Badge(.497, .430, .20, .15), .625, ((.367, .335, .260, .188), (.097, .267, .840, .122), (.037, .092, .380, .175))),
    (Badge(.497, .429, .161, .146), .75, ((.392, .338, .209, .182), (.175, .272, .677, .118), (.127, .103, .306, .169))),
    (Badge(.496, .523, .22, .148), .5625, ((.353, .430, .285, .185), (.057, .362, .921, .121), (0, .189, .408, .173))),
])
def test_report_4_3_numeric_regions(badge: Badge, aspect: float, expected: tuple) -> None:
    actual = regions(badge, aspect)
    for rect, values in zip(actual.values(), expected):
        assert tuple(rect.to_dict().values()) == pytest.approx(values, abs=.005)


@pytest.mark.parametrize("badge,code", [
    (Badge(.496, .523, .22, .148), "SPECTATE_LIKE"),
    (Badge(.496, .46, .22, .148), "SPECTATE_LIKE"),
    (Badge(.45, .429, .22, .148), "LAYOUT_UNEXPECTED"),
    (Badge(.496, .39, .22, .148), "LAYOUT_UNEXPECTED"),
    (Badge(.496, .429, .30, .20), "NICKNAME_ZONE_CLIPPED"),
    (Badge(.496, .429, .22, .148), None),
])
def test_layout_refusals(badge: Badge, code: str | None) -> None:
    assert layout_rejection(badge, .5625) == code
