from __future__ import annotations

import pytest

from prediction_values import (DELTA_ICONS, DELTA_SIGNS, OUTCOMES, RANK_LINES, RANKS, outcome_from_evidence,
                               rank_from_lines)


def test_wire_values_match_the_server_validation() -> None:
    # server/routers/streamer_predictions.py RankEvidence / ResultEvidence / BattleResultRequest
    assert RANK_LINES == ("medal", "league", "trophy", "empty", "other", "unknown")
    assert RANKS == ("pol", "not_pol", "unknown")
    assert OUTCOMES == ("win", "loss", "draw", "unknown")
    assert DELTA_SIGNS == ("+", "-", None)
    assert DELTA_ICONS == ("pol", "trophy", "absent", "unreadable")


@pytest.mark.parametrize("opponent,own,rank", [
    ("medal", "medal", "pol"), ("league", "unknown", "pol"), ("unknown", "medal", "pol"),
    ("unknown", "unknown", "unknown"), ("empty", "empty", "not_pol"), ("trophy", "empty", "not_pol"),
    ("trophy", "trophy", "not_pol"), ("league", "trophy", "unknown"), ("empty", "unknown", "unknown"),
    ("other", "empty", "unknown"), ("other", "other", "unknown"), ("medal", "other", "unknown"),
])
def test_rank_combination_equals_server_classify_rank_evidence(opponent: str, own: str, rank: str) -> None:
    assert rank_from_lines(opponent, own) == rank


@pytest.mark.parametrize("top,bottom,sign,outcome", [
    (1, 2, "+", "win"), (3, 1, "-", "loss"), (None, None, "+", "win"), (None, None, "-", "loss"),
    (2, 1, "+", "unknown"), (0, 3, "-", "unknown"),            # crowns contradict the pill
    (1, 1, "-", "draw"), (0, 0, None, "draw"), (1, 1, "+", "unknown"),
    (0, 3, None, "unknown"), (None, None, None, "unknown"),   # unreadable sign never falls back
    (None, 2, "+", "win"),                                       # one row unreadable = unreadable counts
])
def test_outcome_mirrors_server_classify_battle(top, bottom, sign, outcome) -> None:
    assert outcome_from_evidence(top, bottom, sign) == outcome
