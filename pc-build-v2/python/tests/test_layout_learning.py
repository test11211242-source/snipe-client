import cv2
from types import SimpleNamespace
import numpy as np
import pytest

from game_geometry import GameGeometry
from geometry.vs_finder import Candidate, NORM_C, NORM_W
from geometry.vs_orient_trigger import OrientationTrigger
from geometry.zones import Badge, layout_kind
from layout_learning import LayoutLearning, transfer_corner_zone, transfer_zone
from synthetic_frames import arena
from test_game_geometry import game_layout, game_payload
from test_trigger_engine import profile_for, trigger_image
from trigger_engine import TriggerEngine


def run_new_format(engine, *, cy=0.429, begin=0, count=70, onset=45, data_pixel=False):
    output, events = [], []
    for index in range(count):
        frame, badge = arena(480, 640, seed=index, badge=index >= onset, cy=cy)
        if data_pixel and index >= onset:
            # Record each source frame with an identifiable pixel safely above the badge.
            frame[190, 200] = (index, 200, 11)
        action = engine.process(frame, begin + index * 0.1)
        new_events = engine.take_events()
        if action is not None:
            assert engine.triggered_kind == layout_kind(badge)
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


def test_no_learning_while_the_rect_is_trimmed_by_an_inferred_band(monkeypatch):
    # A phantom band from a still menu strip trimmed the owner's F11 game to an
    # unknown aspect on 14.10, and that rect was learned as a new layout.
    monkeypatch.setattr(GameGeometry, "inferred_band", property(lambda self: True))
    engine = TriggerEngine(game_payload())
    output, events = run_new_format(engine)
    assert output == []
    assert not any(kind == "layout_learned" for _, kind, _ in events)
    assert not any(kind == "learning" and value["status"] in ("rejected", "failed") for _, kind, value in events)
    assert engine.learner.rejected_count == 0
    assert len(engine.geometry.layouts) == 1


def test_own_battle_profile_ignores_spectate_vs_without_failing():
    # Owner decision (field test 1): never cross-learn between own battles and spectating.
    engine = TriggerEngine(game_payload())
    first_output, first_events = run_new_format(engine, cy=0.523)
    second_output, second_events = run_new_format(engine, cy=0.523, begin=7)
    assert first_output == second_output == []
    statuses = [value["status"] for _, kind, value in first_events + second_events if kind == "learning"]
    assert "rejected" not in statuses and "failed" not in statuses
    assert not any(kind == "layout_learned" for _, kind, _ in first_events + second_events)


@pytest.mark.parametrize(("widths", "learned_on"), [
    # Gap 1.028–1.031 (MuMu F11 is 1.030): always the setup layout, never learned.
    ((370, 371, 369, 370), []),
    # Gap 1.047–1.053, just beyond the match band: learned once, then reused.
    ((378, 379, 377, 378), [0]),
])
def test_pixel_jitter_across_restarts_never_flips_or_learns_twice(widths, learned_on):
    engine = TriggerEngine(game_payload())
    fires, learned, layouts = [], [], []
    for battle, width in enumerate(widths):
        for index in range(70):
            frame, _ = arena(width, 640, seed=index, badge=index >= 45)
            if engine.process(frame, battle * 20 + index * 0.1) is not None:
                fires.append(battle)
                layouts.append(engine.geometry.layout["layoutSource"])
            learned += [battle for kind, _ in engine.take_events() if kind == "layout_learned"]
    assert fires == [0, 1, 2, 3]
    assert learned == learned_on
    assert layouts == ["learned" if learned_on else "setup"] * 4


def test_spectate_profile_learns_only_from_spectate_vs():
    spectate = game_layout(cy=0.523)
    engine = TriggerEngine(game_payload([spectate]))
    output, events = run_new_format(engine)
    assert output == []
    assert not any(kind == "layout_learned" for _, kind, _ in events)
    engine = TriggerEngine(game_payload([game_layout(cy=0.523)]))
    output, events = run_new_format(engine, cy=0.523)
    assert len(output) == 1
    assert sum(kind == "layout_learned" for _, kind, _ in events) == 1


def test_structural_profile_unknown_format_reports_honest_failure():
    layout = game_layout()
    layout["trigger"] = {"kind": "structural", "profile": profile_for(trigger_image((20, 80, 140)))}
    layout["badge"] = None
    engine = TriggerEngine(game_payload([layout]))
    output, events = run_new_format(engine)
    assert output == []
    assert [(kind, value["reason"]) for _, kind, value in events if kind == "learning"] == [("learning", "LEARN_STRUCTURAL_TRIGGER")]


def test_no_game_waits_without_entering_learning_or_counting_mismatch():
    engine = TriggerEngine(game_payload())
    events = []
    for index in range(30):
        assert engine.process(np.zeros((640, 480, 3), np.uint8), index * 0.1) is None
        events.extend(engine.take_events())
    assert engine.geometry.state == "no_game"
    assert engine.geometry.mismatch_frames == 0
    assert not engine.learner.active
    assert engine.learner.rejected_count == 0
    assert not any(kind in ("learning", "layout_learned") for kind, _ in events)
    # Empty source frames do not count toward the 20-frame aspect mismatch.
    for index in range(19):
        frame = arena(480, 640, seed=index, badge=False)[0]
        assert engine.process(frame, 3 + index * 0.1) is None
        assert engine.geometry.state == "aspect_mismatch"
        assert not engine.learner.active


@pytest.mark.parametrize("episode", ["inactive", "waiting", "failed"])
def test_no_game_clears_evidence_without_resetting_learning_episode(episode):
    engine = TriggerEngine(game_payload())
    if episode == "failed":
        run_new_format(engine, cy=0.39)
        run_new_format(engine, cy=0.39, begin=7)
        begin = 14
        assert engine.learner.failed
        assert engine.learner.rejected_count == 2
    else:
        count = 16 if episode == "inactive" else 25
        run_new_format(engine, count=count, onset=1000)
        begin = count / 10
        assert engine.learner.active == (episode == "waiting")
    learner = engine.learner
    assert learner._history
    assert learner._last_history_sample != -float("inf")
    episode_state = (learner.active, learner.failed, learner.rejected_count)
    events = []
    for index in range(20):
        assert engine.process(np.zeros((640, 480, 3), np.uint8), begin + index / 10) is None
        events.extend(engine.take_events())
    assert engine.geometry.state == "no_game"
    assert not learner._history
    assert learner._last_history_sample == -float("inf")
    assert learner._pending is None
    assert learner._onset is None
    assert (learner.active, learner.failed, learner.rejected_count) == episode_state
    assert not any(kind in ("learning", "layout_learned") for kind, _ in events)
    output, resumed_events = run_new_format(engine, begin=begin + 2,
                                             cy=0.39 if episode == "failed" else 0.429)
    if episode == "failed":
        assert output == []
        assert learner.failed
        assert learner.rejected_count == 3
        assert any(kind == "learning" and value["status"] == "rejected" and value["rejectedCount"] == 3
                   for _, kind, value in resumed_events)
        assert not any(kind == "learning" and value["status"] in ("waiting_vs", "failed")
                       for _, kind, value in resumed_events)
    else:
        assert len(output) == 1
        assert sum(kind == "layout_learned" for _, kind, _ in resumed_events) == 1


def test_short_mismatch_rearm_cannot_supply_empty_evidence_to_next_immediate_vs():
    engine = TriggerEngine(game_payload())
    # Keep one source canvas throughout: a shape reset must not hide stale evidence.
    def canvas(index, *, badge):
        frame = np.zeros((640, 360, 3), np.uint8)
        frame[:, 36:324] = arena(288, 640, seed=index, badge=badge)[0]
        return frame

    for index in range(16):
        assert engine.process(canvas(index, badge=False), index / 10) is None
        assert engine.geometry.state == "aspect_mismatch"
        assert not engine.learner.active
    assert engine.learner._history
    assert engine.process(arena(badge=False)[0], 1.6) is None
    assert engine.geometry.state == "armed_provisional"
    assert not engine.learner.active
    assert not engine.learner._history
    assert engine.learner._last_history_sample == -float("inf")
    engine.take_events()
    events = []
    for index in range(70):
        # VS is already present on every frame of the new format; there is no
        # empty pre-VS frame in this episode to certify confirmation/self-check.
        assert engine.process(canvas(index, badge=True), 1.7 + index / 10) is None
        events.extend(engine.take_events())
    assert engine.geometry.state == "aspect_unknown"
    assert engine.learner.active
    assert engine.learner._history
    assert all(timestamp >= 1.7 for timestamp, _ in engine.learner._history)
    assert engine.learner._pending is None
    assert len(engine.geometry.layouts) == 1
    assert not any(kind == "layout_learned" for kind, _ in events)


def test_unsupported_format_fails_without_null_reason():
    engine = TriggerEngine(game_payload())
    events = []
    for index in range(25):
        frame = np.random.default_rng(index).integers(0, 256, (300, 500, 3), np.uint8)
        assert engine.process(frame, index * 0.1) is None
        events.extend(engine.take_events())
    assert ("learning", {"status": "failed", "reason": "LEARN_ASPECT_UNSUPPORTED", "rejectedCount": 0}) in events


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
    wire = next(value["layout"] for _, kind, value in events if kind == "layout_learned")
    assert wire["zonesOrigin"] == layout["zonesOrigin"]


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


@pytest.mark.parametrize("onset", [21, 23])
def test_vs_soon_after_aspect_unknown_learns_and_fires_first_battle(onset):
    engine = TriggerEngine(game_payload())
    output, events = run_new_format(engine, count=45, onset=onset)
    unknown = next(index for index, kind, value in events
                   if kind == "geometry" and value["state"] == "aspect_unknown")
    assert (onset - unknown) / 10 == pytest.approx(0.2 if onset == 21 else 0.4)
    assert len(output) == 1
    assert onset <= output[0][0] <= onset + 8
    assert sum(kind == "layout_learned" for _, kind, _ in events) == 1
    assert not any(kind == "learning" and value["status"] in ("rejected", "failed") for _, kind, value in events)


def test_saved_layout_rearm_resets_consecutive_rejections_and_failed_state():
    engine = TriggerEngine(game_payload())
    _, first_events = run_new_format(engine, cy=0.39)
    _, second_events = run_new_format(engine, cy=0.39, begin=7)
    assert engine.learner.rejected_count == 2
    assert engine.learner.failed
    assert any(kind == "learning" and value["status"] == "failed" for _, kind, value in second_events)
    # Return to a saved format, then encounter another unsupported battle format.
    engine.process(arena(badge=False)[0], 14)
    engine.take_events()
    assert not engine.learner.active
    assert engine.learner.rejected_count == 0
    assert not engine.learner.failed
    assert engine.learner._last_sample == -float("inf")
    _, third_events = run_new_format(engine, cy=0.39, begin=14.1)
    rejected = [value for _, kind, value in third_events if kind == "learning" and value["status"] == "rejected"]
    assert [value["rejectedCount"] for value in rejected] == [1]
    assert not any(kind == "learning" and value["status"] == "failed" for _, kind, value in third_events)
    _, fourth_events = run_new_format(engine, cy=0.39, begin=21.1)
    assert any(kind == "learning" and value["status"] == "failed" and value["rejectedCount"] == 2
               for _, kind, value in fourth_events)
    assert any(kind == "learning" and value["status"] == "rejected" for _, kind, value in first_events)


def test_transferred_manual_evidence_is_clipped_but_nickname_is_not():
    layout = game_layout()
    layout["regions"]["topLeftEvidenceRegion"] = {"x": 0.05, "y": 0.8, "width": 0.3, "height": 0.3}
    layout["zonesOrigin"]["topLeftEvidence"] = "manual"
    engine = TriggerEngine(game_payload([layout]))
    output, events = run_new_format(engine)
    assert len(output) == 1
    learned = engine.geometry.layouts[-1]
    # The corner-anchored zone scales with the interface, not with the badge.
    transferred = transfer_corner_zone(layout["regions"]["topLeftEvidenceRegion"], layout["gameAspect"],
                                       learned["gameAspect"])
    assert transferred["y"] + transferred["height"] > 1
    evidence = learned["regions"]["topLeftEvidenceRegion"]
    assert evidence["y"] == pytest.approx(transferred["y"])
    assert evidence["height"] == pytest.approx(1 - transferred["y"])
    assert evidence["x"] == pytest.approx(transferred["x"])
    assert evidence["width"] == pytest.approx(transferred["width"])
    wire = next(value["layout"] for _, kind, value in events if kind == "layout_learned")
    assert wire["topLeftEvidenceRegion"] == evidence
    assert wire["zonesOrigin"]["topLeftEvidence"] == "manual"

    layout = game_layout()
    layout["regions"]["nicknameRegion"] = {"x": 0.2, "y": 0, "width": 0.6, "height": 0.3}
    layout["zonesOrigin"]["nickname"] = "manual"
    engine = TriggerEngine(game_payload([layout]))
    output, events = run_new_format(engine)
    assert output == []
    assert len(engine.geometry.layouts) == 1
    assert any(kind == "learning" and value["reason"] == "LEARN_NICKNAME_ZONE_CLIPPED" for _, kind, value in events)


@pytest.mark.parametrize("source_ratio,accepted", [(1.0305, True), (1.0299, False)])
def test_learning_acceptance_uses_symmetric_wire_aspect_overlap(monkeypatch, source_ratio, accepted):
    import layout_learning

    frame, badge = arena(480, 640)
    rect = (0, 0, 480, 640)
    source = game_layout()
    source["gameAspect"] = (480 / 640) / source_ratio
    layouts = [source]
    learner = LayoutLearning(layouts, True)
    trigger = OrientationTrigger.build(frame, rect, badge)
    candidate = Candidate(0.9, badge.width, badge)
    geometry = SimpleNamespace(rect=rect, aspect=480 / 640, reason="ok", frames=20, chrome=source["windowChrome"],
                               inferred_band=False)
    learner.buffer(frame, 0, geometry)
    learner._pending = (trigger, candidate, frame.copy(), rect, source, 1.0)
    # This test isolates the post-self-check layout contract admission.
    monkeypatch.setattr(layout_learning, "accept", lambda *_args, **_kwargs: SimpleNamespace(ok=True, confidence=0.9))
    learned = learner.process(frame, 2, geometry)
    assert (learned is not None) == accepted
    assert len(layouts) == (2 if accepted else 1)
    if accepted:
        assert learned[1]["gameAspect"] == 480 / 640
    else:
        assert ("learning", {"status": "rejected", "reason": "LEARN_LAYOUT_OVERLAP", "rejectedCount": 1}) in learner.take_events()


def test_learning_sample_shares_normalized_game_between_buffer_search_and_confirmer(monkeypatch):
    import geometry.vs_finder as finder
    import layout_learning

    layouts = [game_layout()]
    learner = LayoutLearning(layouts, True)
    frame = arena(480, 640, badge=False)[0]
    geometry = GameGeometry(layouts)
    geometry.process(frame, 0)
    geometry.frames = 20
    original_normalize = finder.normalize_game
    widths = []

    def counted_normalize(image, rect, width=NORM_W):
        widths.append(width)
        return original_normalize(image, rect, width)

    monkeypatch.setattr(finder, "normalize_game", counted_normalize)
    monkeypatch.setattr(layout_learning, "normalize_game", counted_normalize)
    learner.buffer(frame, 0, geometry)
    learner.process(frame, 0, geometry)
    assert widths == [NORM_W, NORM_C]
    assert len(learner._history) == 1
