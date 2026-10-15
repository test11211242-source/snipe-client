from __future__ import annotations

from dataclasses import replace

import pytest

from geometry.acceptance import accept
from geometry.game_rect import RectResult
from geometry.vs_orient_trigger import OrientationTrigger
from geometry.zones import Badge
from synthetic_frames import arena


def inputs() -> dict:
    image, badge = arena()
    game = RectResult((0, 0, 360, 640), .5625, "ok")
    return dict(game=game, geometry_frames=8, confirmed=True, badge=badge,
                trigger=OrientationTrigger.build(image, game.rect, badge),
                before_scores=[.17, .22], vs_scores=[.79, .82])


def test_success_margin_is_measured() -> None:
    result = accept(**inputs())
    assert result.ok
    assert result.confidence == .95
    assert result.self_check.min_vs == .79
    assert result.self_check.max_before == .22
    assert result.self_check.frames == 4


@pytest.mark.parametrize("change,code", [
    ({"game": RectResult(None, 0, "too_small")}, "GAME_NOT_FOUND"),
    ({"game": RectResult((0, 0, 800, 800), 1, "aspect_out_of_range")}, "ASPECT_UNSUPPORTED"),
    ({"geometry_frames": 7}, "GAME_NOT_FOUND"),
    ({"confirmed": False}, "VS_NOT_FOUND"),
    ({"badge": Badge(.496, .60, .22, .148)}, "LAYOUT_UNEXPECTED"),
    ({"badge": Badge(.4, .429, .22, .148)}, "LAYOUT_UNEXPECTED"),
    ({"badge": Badge(.496, .429, .30, .20)}, "NICKNAME_ZONE_CLIPPED"),
    ({"trigger": None}, "TRIGGER_WEAK"),
    ({"before_scores": [.3]}, "SELF_CHECK_FAILED"),
    ({"before_scores": []}, "SELF_CHECK_FAILED"),
    ({"vs_scores": [.49, .8]}, "SELF_CHECK_FAILED"),
    ({"vs_scores": [.9]}, "SELF_CHECK_FAILED"),
])
def test_all_acceptance_rejection_codes(change: dict, code: str) -> None:
    parameters = inputs()
    parameters.update(change)
    assert accept(**parameters).code == code


@pytest.mark.parametrize("ratio,center", [(.44, True), (.71, True), (.6, False)])
def test_mask_acceptance_bounds(ratio: float, center: bool) -> None:
    parameters = inputs()
    parameters["trigger"] = replace(parameters["trigger"], mask_area_ratio=ratio, contains_center=center)
    assert accept(**parameters).code == "TRIGGER_WEAK"


@pytest.mark.replay
def test_owner_recording_replay(tmp_path) -> None:
    import os
    from pathlib import Path
    from tools.m9_replay import replay

    manifest = os.environ.get("CR_M9_REPLAY_MANIFEST")
    if not manifest:
        pytest.skip("Set CR_M9_REPLAY_MANIFEST to the external recording manifest")
    result = replay("orient", Path(manifest), tmp_path)
    totals = result["totals"]
    assert totals["confirmed"] == totals["cells"]
    assert totals["falseCandidates"] == totals["earlyConfirms"] == totals["crossFires"] == 0
    assert max(totals["delayS"]) <= .3
    assert totals["firstThreeVsMin"] >= .68
    assert totals["orientVsMin"] >= .70
    assert totals["orientNonMax"] <= .30
    assert result["acceptance"]["passed"]


@pytest.mark.parametrize("minimum,maximum,code,expected", [
    (.70, .30, None, True),
    (.732733846, .207509414, None, True),
    (.699, .20, None, False),
    (.80, .301, None, False),
    (.80, .20, "LAYOUT_UNEXPECTED", False),
])
def test_director_approved_replay_bounds(minimum: float, maximum: float, code: str | None, expected: bool) -> None:
    from tools.m9_replay import evaluate_replay

    result = {"mode": "orient", "totals": {"cells": 2, "confirmed": 2, "falseCandidates": 0, "earlyConfirms": 0,
              "orientVsMin": minimum, "orientNonMax": maximum, "crossFires": 0},
              "cells": {"normal|none": {"code": None, "orient": {"fires": [.1]}},
                        "spectate|none": {"code": code, "orient": {"fires": [.1]}}}}
    acceptance = evaluate_replay(result, expected_cells=2, spectate_keys={"spectate"})
    assert acceptance["passed"] is expected
    assert acceptance["minVsRequired"] == .70
    assert acceptance["maxNonVsAllowed"] == .30
