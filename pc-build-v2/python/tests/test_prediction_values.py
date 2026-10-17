from __future__ import annotations

import pytest

from monitor_protocol import MonitorProtocolError, encode_event
from prediction_values import (DELTA_ICONS, DELTA_SIGNS, OUTCOMES, RANK_LINES, RANKS, outcome_from_evidence,
                               rank_from_lines)

TRIGGER_ID = "00000000-0000-4000-8000-000000000001"


def triggered(rank: str, line: str) -> dict:
    return {"timestamp": "2026-10-15T12:00:00Z", "triggerId": TRIGGER_ID, "kind": "battle", "rank": rank,
            "rankEvidence": {"opponent": line, "own": line}}


def result(outcome: str, sign, icon: str) -> dict:
    return {"battleId": TRIGGER_ID, "gap": False, "outcome": outcome,
            "evidence": {"crowns": {"top": None, "bottom": None}, "deltaSign": sign, "deltaIcon": icon}}


# Review n-1: the boundary is the worker's protocol encoder (the TypeScript
# schema is checked against replay output in tests/monitor-events-replay.test.ts).
@pytest.mark.parametrize("rank", RANKS)
@pytest.mark.parametrize("line", RANK_LINES)
def test_every_rank_value_passes_the_worker_protocol(rank: str, line: str) -> None:
    encode_event("s", 1, "triggered", triggered(rank, line))


@pytest.mark.parametrize("outcome", OUTCOMES)
@pytest.mark.parametrize("sign", DELTA_SIGNS)
@pytest.mark.parametrize("icon", DELTA_ICONS)
def test_every_result_value_passes_the_worker_protocol(outcome: str, sign, icon: str) -> None:
    encode_event("s", 1, "prediction_result", result(outcome, sign, icon))


@pytest.mark.parametrize("event_type,payload", [
    ("triggered", triggered("trophy", "empty")), ("triggered", triggered("pol", "crown")),
    ("prediction_result", result("not_ranked", "-", "pol")), ("prediction_result", result("loss", "\u2212", "pol")),
    ("prediction_result", result("loss", "-", "cup")),
])
def test_values_outside_the_contract_are_rejected(event_type: str, payload: dict) -> None:
    with pytest.raises(MonitorProtocolError):
        encode_event("s", 1, event_type, payload)


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
    (0, 3, None, "unknown"), (None, None, None, "unknown"),   # no fallback without the PoL rank and icon
    (None, 2, "+", "win"),                                       # one row unreadable = unreadable counts
])
def test_outcome_mirrors_server_classify_battle(top, bottom, sign, outcome) -> None:
    assert outcome_from_evidence(top, bottom, sign) == outcome


# Owner rule (prediction 29): no read sign, iconless pill, PoL VS -> different
# final crowns decide; the streamer is the bottom row.
@pytest.mark.parametrize("top,bottom,sign,icon,rank,outcome", [
    (0, 1, None, "absent", "pol", "win"), (2, 1, None, "absent", "pol", "loss"),           # absent + final + different
    (1, 3, None, "unreadable", "pol", "win"), (3, 0, None, "unreadable", "pol", "loss"),   # unreadable + final + different
    (1, 1, None, "absent", "pol", "draw"), (0, 0, None, "unreadable", "pol", "draw"),      # equal: never win/loss
    (None, None, None, "absent", "pol", "unknown"), (None, 1, None, "unreadable", "pol", "unknown"),  # not final
    (0, 1, None, "absent", "not_pol", "unknown"), (0, 1, None, "unreadable", "unknown", "unknown"),  # not ranked
    (0, 1, None, "pol", "pol", "win"), (0, 1, None, "trophy", "pol", "unknown"),          # unread sign / contradictory trophy
    (0, 1, "-", "absent", "pol", "unknown"), (2, 1, "-", "unreadable", "pol", "loss"),     # a read sign still decides
])
def test_unread_sign_falls_back_to_final_crowns_only_for_pol(top, bottom, sign, icon, rank, outcome) -> None:
    assert outcome_from_evidence(top, bottom, sign, icon=icon, rank=rank) == outcome
