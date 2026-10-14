"""Intermittent-miss diagnostics: one compact record per VS candidate."""
from synthetic_frames import arena
from test_game_geometry import game_layout, game_payload
from test_layout_learning import run_new_format
from trigger_engine import TriggerEngine, VsCandidateLog


def battle(engine, start, *, onset=10, length=19, width=360, cy=0.429, count=45):
    records = []
    for index in range(count):
        frame, _ = arena(width, 640, seed=index, badge=onset <= index < onset + length, cy=cy)
        engine.process(frame, start + index * 0.1)
        records += [payload for kind, payload in engine.take_events() if kind == "vs_candidate"]
    return records


def test_back_to_back_battle_inside_the_cooldown_is_recorded_as_cooldown():
    engine = TriggerEngine(game_payload())
    first = battle(engine, 0)
    second = battle(engine, 10)
    third = battle(engine, 30)
    assert [record["reason"] for record in first + second + third] == ["fired", "cooldown", "fired"]
    assert first[0]["sinceFireS"] is None
    assert second[0]["sinceFireS"] == 9.9
    assert second[0] | {"reason": None, "sinceFireS": None} == first[0] | {"reason": None, "sinceFireS": None}
    record = first[0]
    assert record["state"] == "armed" and record["kind"] == "battle" and not record["learnedLayout"]
    assert record["score"] > 0.9 and record["frames"] == record["matchedFrames"] == 19
    assert record["gameRect"] == {"x": 0, "y": 0, "width": 360, "height": 640}
    assert (record["gameAspect"], record["layoutAspect"]) == (0.5625, 0.5625)


def test_single_matched_frame_is_recorded_as_unconfirmed():
    engine = TriggerEngine(game_payload())
    records = battle(engine, 0, length=1)
    assert [(record["reason"], record["matchedFrames"]) for record in records] == [("confirm", 1)]


def test_menu_without_vs_writes_no_record():
    engine = TriggerEngine(game_payload())
    assert battle(engine, 0, length=0, count=60) == []


def test_vs_on_a_mismatched_game_is_recorded_with_its_shadow_score():
    engine = TriggerEngine(game_payload(learning=False))
    records = battle(engine, 0, onset=3, length=10, width=380)
    assert len(records) == 1
    record = records[0]
    assert (record["reason"], record["state"], record["matchedFrames"]) == ("aspect", "aspect_mismatch", 0)
    assert record["score"] > 0.5
    assert (record["gameAspect"], record["layoutAspect"]) == (0.5938, 0.5625)


def test_other_layout_kind_ignored_by_learning_is_recorded_as_kind():
    engine = TriggerEngine(game_payload())
    _, events = run_new_format(engine, cy=0.523)
    records = [value for _, kind, value in events if kind == "vs_candidate"]
    assert [(record["reason"], record["state"]) for record in records] == [("kind", "aspect_unknown")]


def test_learned_fire_is_recorded_with_its_learning_code():
    engine = TriggerEngine(game_payload())
    _, events = run_new_format(engine)
    records = [value for _, kind, value in events if kind == "vs_candidate"]
    records += battle(engine, 7, length=0, count=5)
    assert [(record["reason"], record["code"]) for record in records] == [("fired", "LAYOUT_LEARNED")]


def test_mismatched_game_with_learning_off_is_recorded_as_aspect_after_twenty_frames():
    engine = TriggerEngine(game_payload(learning=False))
    records = battle(engine, 0, onset=25, length=10, width=380)
    assert [(record["reason"], record["state"]) for record in records] == [("aspect", "aspect_unknown")]


def sample(score):
    return {"state": "armed", "score": score, "matched": False, "fired": False, "blocked": None,
            "kindIgnored": False, "code": None, "sinceFireS": None, "frameWidth": 1, "frameHeight": 1,
            "gameRect": None, "gameAspect": None, "layoutAspect": None, "kind": None, "learnedLayout": False,
            "learningEnabled": True}


def test_records_are_rate_limited_and_count_what_they_dropped():
    log = VsCandidateLog()
    emitted = []
    for index in range(120):
        now = index * 0.1
        # A two-frame near miss every 0.5 s.
        record = log.observe(now, sample(0.4) if index % 5 < 2 else None)
        if record is not None:
            emitted.append((round(now, 1), record["suppressed"]))
    assert [moment for moment, _ in emitted] == [0.4, 1.4, 2.4, 3.4, 4.4, 5.4, 6.4, 7.4, 8.4, 9.4, 10.4, 11.4]
    assert all(suppressed == 1 for _, suppressed in emitted[1:])
    # Twenty records per minute at most.
    log = VsCandidateLog()
    count = sum(log.observe(index * 0.1, sample(0.4) if index % 20 < 2 else None) is not None for index in range(600))
    assert count == 20


def test_long_episode_is_closed_after_four_seconds():
    log = VsCandidateLog()
    records = [log.observe(index * 0.1, sample(0.4)) for index in range(45)]
    assert [index for index, record in enumerate(records) if record is not None] == [40]
