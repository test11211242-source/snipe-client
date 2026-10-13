import cv2
import numpy as np
import pytest

from game_geometry import GameGeometry
from geometry.vs_orient_trigger import OrientationTrigger
from geometry.zones import Badge
from layout_learning import LayoutLearning, transfer_zone
from synthetic_frames import arena
from test_game_geometry import game_layout, game_payload
from test_trigger_engine import profile_for, trigger_image
from trigger_engine import TriggerEngine


def run_new_format(engine, *, cy=0.429, begin=0, count=70, onset=45, data_pixel=False):
    output, events = [], []
    for index in range(count):
        frame, _ = arena(480, 640, seed=index, badge=index >= onset, cy=cy)
        if data_pixel and index >= onset:
            # Record each source frame with an identifiable pixel safely above the badge.
            frame[190, 200] = (index, 200, 11)
        action = engine.process(frame, begin + index * 0.1)
        new_events = engine.take_events()
        if action is not None:
            output.append((index, action))
        events.extend((index, kind, value) for kind, value in new_events)
    return output, events


def test_auto_learning_appends_and_fires_on_confirmation_frame_after_selfcheck():
    engine = TriggerEngine(game_payload())
    output, events = run_new_format(engine, data_pixel=True)
    assert len(output) == 1
    learned = [(index, value) for index, kind, value in events if kind == "layout_learned"]
    assert len(learned) == 1
    fire_index, action = output[0]
    learned_index, value = learned[0]
    assert learned_index == fire_index
    assert value["layout"]["layoutSource"] == "learned"
    assert value["layout"]["calibratedAt"].endswith("Z")
    assert len(engine.geometry.layouts) == 2
    assert engine.geometry.state == "armed"
    # Learning sampled at5Hz: third confirmation then following-frame selfcheck.
    confirmation_index = fire_index - 2
    image = cv2.imdecode(np.frombuffer(action[0], np.uint8), cv2.IMREAD_COLOR)
    assert (image == (confirmation_index, 200, 11)).all(axis=2).any()
    assert not (image == (fire_index, 200, 11)).all(axis=2).any()
    assert any(kind == "learning" and value["status"] == "waiting_vs" for _, kind, value in events)


def test_spectate_rejected_once_per_vs_and_two_failures_show_failed():
    engine = TriggerEngine(game_payload())
    first_output, first_events = run_new_format(engine, cy=0.523)
    second_output, second_events = run_new_format(engine, cy=0.523, begin=7)
    assert first_output == second_output == []
    rejected = [value for _, kind, value in first_events + second_events if kind == "learning" and value["status"] == "rejected"]
    assert [value["reason"] for value in rejected] == ["LEARN_SPECTATE_LIKE"] * 2
    assert [value["rejectedCount"] for value in rejected] == [1, 2]
    failed = [value for _, kind, value in second_events if kind == "learning" and value["status"] == "failed"]
    assert failed == [{"status": "failed", "reason": "LEARN_SPECTATE_LIKE", "rejectedCount": 2}]


def test_structural_profile_unknown_format_reports_honest_failure():
    layout = game_layout()
    layout["trigger"] = {"kind": "structural", "profile": profile_for(trigger_image((20, 80, 140)))}
    layout["badge"] = None
    engine = TriggerEngine(game_payload([layout]))
    output, events = run_new_format(engine)
    assert output == []
    assert [(kind, value["reason"]) for _, kind, value in events if kind == "learning"] == [("learning", "LEARN_STRUCTURAL_TRIGGER")]


@pytest.mark.parametrize("shape,reason", [((640, 480), "LEARN_GAME_NOT_FOUND"), ((300, 500), "LEARN_ASPECT_UNSUPPORTED")])
def test_no_game_or_unsupported_format_fails_without_null_reason(shape, reason):
    engine = TriggerEngine(game_payload())
    events = []
    for index in range(25):
        frame = np.zeros((*shape, 3), np.uint8) if reason == "LEARN_GAME_NOT_FOUND" else np.random.default_rng(index).integers(0, 256, (*shape, 3), np.uint8)
        assert engine.process(frame, index * 0.1) is None
        events.extend(engine.take_events())
    assert ("learning", {"status": "failed", "reason": reason, "rejectedCount": 0}) in events


def test_menu_without_vs_never_counts_as_rejection():
    engine = TriggerEngine(game_payload())
    output, events = run_new_format(engine, count=70, onset=1000)
    assert output == []
    assert [value["status"] for _, kind, value in events if kind == "learning"] == ["waiting_vs"]
    assert engine.learner.rejected_count == 0
    assert len(engine.learner._history) <= 15


def test_fifth_layout_evicts_oldest_learned_not_setup():
    layouts = [game_layout(360, 640), game_layout(300, 640, source="learned", calibrated_at="2026-10-12T00:00:00Z"),
               game_layout(400, 640, source="learned", calibrated_at="2026-10-13T00:00:00Z"),
               game_layout(280, 640, source="setup", calibrated_at="2026-10-11T00:00:00Z")]
    removed_id, setup_id = layouts[1]["layoutId"], layouts[3]["layoutId"]
    engine = TriggerEngine(game_payload(layouts))
    output, events = run_new_format(engine)
    assert len(output) == 1
    assert len(engine.geometry.layouts) == 4
    assert removed_id not in {layout["layoutId"] for layout in engine.geometry.layouts}
    assert setup_id in {layout["layoutId"] for layout in engine.geometry.layouts}


def test_four_setup_layouts_cannot_be_evicted():
    layouts = [game_layout(width, 640) for width in (360, 300, 400, 280)]
    engine = TriggerEngine(game_payload(layouts))
    output, events = run_new_format(engine)
    assert output == []
    assert len(engine.geometry.layouts) == 4
    assert not any(kind == "layout_learned" for _, kind, _ in events)
    assert any(kind == "learning" and value["reason"] == "LAYOUT_LIMIT" for _, kind, value in events)


def test_manual_zones_transfer_in_physical_badge_units():
    old, new = Badge(0.5, 0.429, 0.2, 0.14), Badge(0.49, 0.423, 0.25, 0.2)
    zone = {"x": 0.1, "y": 0.2, "width": 0.7, "height": 0.1}
    actual = transfer_zone(zone, old, new, 0.5625, 0.75)
    assert actual == pytest.approx({"x": -0.01, "y": 0.423 + (0.2 - 0.429) / (0.2 * 0.5625) * 0.25 * 0.75,
                                    "width": 0.875, "height": 0.1 / (0.2 * 0.5625) * 0.25 * 0.75})


def test_learned_manual_zones_are_transferred_not_replaced():
    layout = game_layout()
    layout["regions"]["nicknameRegion"] = {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.1}
    layout["zonesOrigin"] = {"nickname": "manual", "topLeftEvidence": "manual"}
    engine = TriggerEngine(game_payload([layout]))
    output, events = run_new_format(engine)
    assert len(output) == 1
    learned = engine.geometry.layouts[-1]
    expected = transfer_zone(layout["regions"]["nicknameRegion"], Badge(**layout["badge"]), Badge(**learned["badge"]), layout["gameAspect"], learned["gameAspect"])
    assert learned["regions"]["nicknameRegion"] == pytest.approx(expected)
    assert learned["zonesOrigin"] == layout["zonesOrigin"]


@pytest.mark.parametrize("weak,code", [("mask", "LEARN_TRIGGER_WEAK"), ("before", "LEARN_SELF_CHECK_FAILED")])
def test_learning_acceptance_refusals_are_not_silent(monkeypatch, weak, code):
    original = OrientationTrigger.build.__func__

    def build(cls, frame, rect, badge):
        trigger = original(cls, frame, rect, badge)
        if weak == "mask":
            trigger.mask_area_ratio = 0.1
        else:
            trigger.score = lambda *_: 0.9
        return trigger

    monkeypatch.setattr(OrientationTrigger, "build", classmethod(build))
    # Build setup layout before altered runtime constructor is relevant; wire restores scorer.
    engine = TriggerEngine(game_payload())
    output, events = run_new_format(engine)
    assert output == []
    assert any(kind == "learning" and value["reason"] == code for _, kind, value in events)


def test_learning_disabled_never_mutates_layouts():
    engine = TriggerEngine(game_payload(learning=False))
    output, events = run_new_format(engine)
    assert output == []
    assert not any(kind in ("learning", "layout_learned") for _, kind, _ in events)
    assert len(engine.geometry.layouts) == 1


def test_learning_history_survives_normalized_height_drift_on_same_source_canvas():
    layouts = [game_layout()]
    learner = LayoutLearning(layouts, True)
    geometry = GameGeometry(layouts)
    frame = arena(480, 640, badge=False)[0]
    geometry.process(frame, 0)
    geometry.frames = 20
    learner.process(frame, 0, geometry)
    assert len(learner._history) == 1
    geometry.rect = (0, 0, 480, 639)
    geometry.aspect = 480 / 639
    learner.process(frame, 0.2, geometry)
    assert len(learner._history) == 2
    assert learner._history[0][1].shape != learner._history[1][1].shape


def test_same_canvas_late_unknown_keeps_pre_vs_history_and_learns_first_battle():
    engine = TriggerEngine(game_payload())
    for index in range(20):
        assert engine.process(arena(badge=False)[0], index / 10) is None
    fires, events = [], []
    for index in range(70):
        game = arena(288, 640, seed=index, badge=index >= 45)[0]
        canvas = np.zeros((640, 360, 3), np.uint8)
        canvas[:, 36:324] = game
        action = engine.process(canvas, (20 + index) / 10)
        if action is not None:
            fires.append(index)
        events.extend(engine.take_events())
    assert len(fires) == 1
    assert 45 <= fires[0] <= 55
    assert len(engine.geometry.layouts) == 2
    assert sum(kind == "layout_learned" for kind, _ in events) == 1
    assert not any(kind == "learning" and value["status"] == "rejected" for kind, value in events)
