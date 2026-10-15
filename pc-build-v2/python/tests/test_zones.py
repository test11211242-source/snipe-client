from __future__ import annotations

import pytest

from geometry.zones import Badge, layout_rejection, regions


# Triggers are REPORT §4.3. Field test 1 (owner screenshots 3/4) replaced the
# nickname (−2.25u…+0.87u, −1.50u…−0.27u) and the top-left zone (the game's
# top-left corner, 0.28×0.105 interface units; below the card strip on
# spectate), verified on in-battle frames of all eight recordings.
@pytest.mark.parametrize("badge,aspect,expected", [
    (Badge(.493, .429, .22, .149), .565, ((.350, .336, .285, .186), (0, .243, .684, .153), (0, 0, .496, .105))),
    (Badge(.496, .429, .22, .148), .5625, ((.353, .336, .285, .185), (.001, .243, .686, .152), (0, 0, .498, .105))),
    (Badge(.496, .421, .22, .119), .452, ((.353, .347, .285, .149), (.001, .272, .686, .122), (0, 0, .498, .084))),
    (Badge(.497, .430, .20, .15), .625, ((.367, .335, .260, .188), (.047, .242, .624, .154), (0, 0, .448, .105))),
    (Badge(.497, .429, .161, .146), .75, ((.392, .338, .209, .182), (.135, .248, .502, .149), (0, 0, .373, .105))),
    (Badge(.496, .523, .22, .148), .5625, ((.353, .430, .285, .185), (.001, .337, .686, .152), (0, .135, .498, .105))),
])
def test_field_test_1_numeric_regions(badge: Badge, aspect: float, expected: tuple) -> None:
    actual = regions(badge, aspect)
    for rect, values in zip(actual.values(), expected):
        assert tuple(rect.to_dict().values()) == pytest.approx(values, abs=.005)


@pytest.mark.parametrize("badge,code", [
    (Badge(.496, .523, .22, .148), None),
    (Badge(.496, .60, .22, .148), "LAYOUT_UNEXPECTED"),
    (Badge(.45, .429, .22, .148), "LAYOUT_UNEXPECTED"),
    (Badge(.496, .39, .22, .148), "LAYOUT_UNEXPECTED"),
    (Badge(.496, .429, .30, .20), "NICKNAME_ZONE_CLIPPED"),
    (Badge(.496, .429, .22, .148), None),
])
def test_layout_refusals(badge: Badge, code: str | None) -> None:
    assert layout_rejection(badge, .5625) == code
