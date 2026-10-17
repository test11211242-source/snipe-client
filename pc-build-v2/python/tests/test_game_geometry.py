import uuid

import cv2
import numpy as np
import pytest

from game_geometry import GameGeometry, phantom_chrome
from geometry.aspect import ASPECT_MATCH_TOL, aspect_gap, aspects_overlap
from geometry.game_rect import detect
from geometry.vs_orient_trigger import OrientationTrigger
from geometry.zones import regions
from synthetic_frames import (F11_BAR, F11_GAME, F11_WIDTH, NO_CHROME, arena, f11_frame, framed, moving_noise,
                              phantom_band_menu, pre_battle)
from test_trigger_engine import payload, profile_for, trigger_image
from trigger_engine import TriggerEngine


def game_layout(width=360, height=640, *, source="setup", calibrated_at="2026-10-13T12:00:00Z", chrome=None, cy=0.429):
    frame, badge = arena(width, height, cy=cy)
    zones = regions(badge, width / height)
    return {"layoutId": str(uuid.uuid4()), "layoutSource": source, "calibratedAt": calibrated_at,
            "gameAspect": width / height, "windowChrome": chrome or detect([frame]).chrome,
            "regions": {"trigger": zones["trigger"].to_dict(), "nicknameRegion": zones["nickname"].to_dict(),
                        "topLeftEvidenceRegion": zones["topLeftEvidence"].to_dict()},
            "trigger": OrientationTrigger.build(frame, (0, 0, width, height), badge).to_dict(),
            "badge": badge.to_dict(), "zonesOrigin": {"nickname": "auto", "topLeftEvidence": "auto"}}


def game_payload(layouts=None, *, learning=True):
    result = payload(profile_for(trigger_image((20, 80, 140))))
    result["selector"] = {"kind": "window", "windowHwnd": "123"}
    result["primary"] = {"kind": "game_relative", "profileCalibrationId": str(uuid.uuid4()),
                         "layouts": layouts or [game_layout()], "learning": {"enabled": learning, "maxLayouts": 4}}
    return result


def test_locating_provisional_armed_union_and_resize():
    geometry = GameGeometry([game_layout()])
    assert geometry.state == "locating"
    frame, _ = framed(arena(badge=False)[0])
    geometry.process(frame, 0)
    assert geometry.state == "armed_provisional"
    assert geometry.frames == 1
    for index in range(1, 20):
        geometry.process(frame, index * 0.1)
    assert geometry.state == "armed"
    assert geometry.rect == (40, 24, 360, 640)
    resized = cv2.resize(frame, None, fx=0.75, fy=0.75)
    geometry.process(resized, 2)
    assert geometry.state == "armed_provisional"
    assert geometry.frames == 1
    assert abs(geometry.aspect / (360 / 640) - 1) < 0.01


def test_aspect_unknown_after_twenty_mismatches_and_no_game():
    geometry = GameGeometry([game_layout()])
    frame = arena(480, 640, badge=False)[0]
    for index in range(19):
        geometry.process(frame, index * 0.1)
        assert geometry.state == "aspect_mismatch"
    geometry.process(frame, 1.9)
    assert geometry.state == "aspect_unknown"
    geometry.process(np.zeros_like(frame), 2)
    # One dark recheck is harmless; two consecutive missing rechecks drop it.
    for index in range(21, 40):
        geometry.process(np.zeros_like(frame), index * 0.1)
        if index == 29:
            assert geometry.rect is not None
    assert geometry.rect is None
    assert geometry.state == "no_game"
    assert geometry.mismatch_frames == 0


def test_obs_shrink_without_frame_resize_starts_new_union():
    geometry = GameGeometry([game_layout()])
    frame, _ = framed(arena(badge=False)[0], borders=(100, 100, 100, 100))
    for index in range(20):
        geometry.process(frame, index * 0.1)
    smaller = np.zeros_like(frame)
    smaller[180:660, 145:415] = cv2.resize(arena(badge=False)[0], (270, 480))
    for index in range(20, 30):
        geometry.process(smaller, index * 0.1)
    assert geometry.rect == (145, 180, 270, 480)
    assert geometry.frames == 1


def test_saved_chrome_is_subtracted_by_template_or_by_thickness_restoring_the_game_aspect():
    frames = [framed(np.random.default_rng(i).integers(0, 256, (640, 360, 3), dtype=np.uint8), toolbar=32)[0] for i in range(8)]
    calibration = detect(frames)
    assert calibration.chrome["top"] == 32
    geometry = GameGeometry([game_layout(chrome=calibration.chrome)])
    geometry.process(frames[-1], 0)
    assert geometry.rect == (40, 56, 360, 640)
    # Tab titles and icons change; the saved thickness that restores the game
    # aspect at a full-width line step still identifies the chrome.
    modified = frames[-1].copy()
    modified[24:56, 40:400] = (70, 74, 78)
    modified[28:52, 60:200] = np.random.default_rng(73).integers(150, 255, (24, 140, 3), dtype=np.uint8)
    other = GameGeometry([game_layout(chrome=calibration.chrome)])
    other.process(modified, 0)
    assert other.rect == (40, 56, 360, 640)
    # A band of a different thickness is not the saved chrome.
    taller = np.zeros((736, 440, 3), np.uint8)
    taller[24:712, 40:400] = np.random.default_rng(74).integers(0, 255, (688, 360, 3), dtype=np.uint8)
    third = GameGeometry([game_layout(chrome=calibration.chrome)])
    third.process(taller, 0)
    assert third.rect == (40, 24, 360, 688)


def test_geometry_events_are_change_driven_and_limited_to_two_per_second():
    geometry = GameGeometry([game_layout()])
    frame = arena(badge=False)[0]
    geometry.process(frame, 0)
    event = geometry.event(0)
    assert event["state"] == "armed"
    assert geometry.event(0.5) is None
    geometry.process(arena(480, 640, badge=False)[0], 0.1)
    assert geometry.event(0.1) is None
    event = geometry.event(0.5)
    assert event["state"] == "aspect_mismatch"
    assert event["layoutId"] is None


def test_game_relative_confirmation_uses_current_nickname_frame_and_no_fatal_resize():
    layout = game_layout()
    engine = TriggerEngine(game_payload([layout]))
    first, _ = arena()
    confirmed = first.copy()
    # A single distinctive pixel inside the nickname zone survives lossless encoding.
    zone = layout["regions"]["nicknameRegion"]
    x, y = round((zone["x"] + zone["width"] / 2) * 360), round((zone["y"] + zone["height"] / 2) * 640)
    confirmed[y, x] = (7, 211, 33)
    assert engine.process(first, 0) is None
    action = engine.process(confirmed, 0.1)
    assert action is not None
    image = cv2.imdecode(np.frombuffer(action[0], np.uint8), cv2.IMREAD_COLOR)
    assert ((image == (7, 211, 33)).all(axis=2)).any()
    assert engine.take_triggered()
    assert engine.last_match.matcher == "vs_orientation"
    assert engine.last_match.support is None
    assert engine.process(arena(480, 640, badge=False)[0], 0.2) is None


@pytest.mark.parametrize("cy,kind", [(0.429, "battle"), (0.52, "spectate")])
def test_trigger_records_the_fired_layout_kind(cy, kind):
    frame, _ = arena(cy=cy)
    engine = TriggerEngine(game_payload([game_layout(cy=cy)]))
    assert engine.process(frame, 0) is None
    assert engine.process(frame, 0.1) is not None
    assert engine.take_triggered()
    assert engine.triggered_kind == kind
    # Own battles get the rank check (no rank icons here: empty lines) and arm
    # the result reader; spectated battles never do.
    if kind == "battle":
        assert engine.triggered_rank == {"rank": "not_pol", "rankEvidence": {"opponent": "empty", "own": "empty"}}
    else:
        assert engine.triggered_rank == {"rank": "unknown", "rankEvidence": None}
    assert engine.result_reader.armed is (kind == "battle")
    assert engine.process(frame, 0.2) is None
    assert engine.triggered_kind is None
    assert engine.triggered_rank == {"rank": "unknown", "rankEvidence": None}


def test_result_screen_is_read_only_after_an_own_battle_and_never_on_a_fire_tick(monkeypatch):
    frame, _ = arena(cy=0.429)
    engine = TriggerEngine(game_payload([game_layout(cy=0.429)]))
    calls = []
    report = {"outcome": "win", "evidence": {"crowns": {"top": 0, "bottom": 1}, "deltaSign": "+",
                                             "deltaIcon": "pol"}}

    def process(_frame, rect, now):
        calls.append(now)
        engine.result_reader.diagnostics = {"endReason": "shift"}
        return report if now >= 25 else None

    monkeypatch.setattr(engine.result_reader, "process", process)
    blank = arena(badge=False)[0]
    assert engine.process(blank, 0) is None and engine.take_prediction_result() is None
    assert calls == []                                    # never armed: nothing is read
    engine.process(frame, 1.0)
    engine.process(frame, 1.1)
    assert engine.take_triggered() and engine.result_reader.armed
    assert calls == []                                    # not on the fire tick
    engine.process(blank, 1.2)
    assert calls == [1.2] and engine.take_prediction_result() is None
    engine.process(blank, 25.0)
    assert engine.take_prediction_result() == (report, "shift")
    assert engine.take_prediction_result() is None


def test_a_spectate_fire_drops_the_pending_own_battle_result():
    # Review m-13: own result missed, then a spectated battle (a layout learned
    # from a spectate VS at another window aspect); its result screen must not
    # be reported under the own battle's id.
    own, spectate = game_layout(cy=0.429), game_layout(400, 640, cy=0.52)
    engine = TriggerEngine(game_payload([own, spectate]))
    battle_frame, spectate_frame = arena(cy=0.429)[0], arena(400, 640, cy=0.52)[0]
    engine.process(battle_frame, 0)
    engine.process(battle_frame, 0.1)
    assert engine.take_triggered() and engine.triggered_kind == "battle" and engine.result_reader.armed
    for now in (59.8, 59.9):                                             # the battle, then a spectated VS
        engine.process(arena(400, 640, badge=False)[0], now)
    kinds = []
    for tick in range(20):
        engine.process(spectate_frame, 60 + tick / 10)
        if engine.take_triggered():
            kinds.append(engine.triggered_kind)
    assert kinds == ["spectate"]
    assert not engine.result_reader.armed


@pytest.mark.parametrize("broken", ["rank", "result", "both"])
def test_a_missing_or_corrupt_c3_asset_never_stops_the_opponent_monitor(monkeypatch, capsys, broken):
    # Review m-15: the asset loads used to raise in TriggerEngine.__init__
    # (MONITOR_INTERNAL_FAILED), taking the M9 nickname search down.
    def missing(*_args, **_kwargs):
        raise FileNotFoundError("pol_rank_v1.json")

    def corrupt(*_args, **_kwargs):
        raise ValueError("template hash mismatch")

    if broken in ("rank", "both"):
        monkeypatch.setattr("trigger_engine.RankTemplates.load", missing)
    if broken in ("result", "both"):
        monkeypatch.setattr("trigger_engine.ResultReader", corrupt)
    frame, _ = arena(cy=0.429)
    engine = TriggerEngine(game_payload([game_layout(cy=0.429)]))
    assert capsys.readouterr().err.count("PREDICTION_ASSET_UNAVAILABLE") == (2 if broken == "both" else 1)
    engine.process(frame, 0)
    assert engine.process(frame, 0.1) is not None                       # the nickname action still goes out
    assert engine.take_triggered() and engine.triggered_kind == "battle"
    if broken == "result":
        assert engine.triggered_rank["rank"] == "not_pol" and engine.result_reader is None
    else:
        assert engine.triggered_rank == {"rank": "unknown", "rankEvidence": None}
    assert (engine.result_reader is not None and engine.result_reader.armed) is (broken == "rank")
    assert engine.process(arena(badge=False)[0], 30) is None and engine.take_prediction_result() is None


def test_prediction_failures_never_stop_the_monitor(monkeypatch):
    frame, _ = arena(cy=0.429)
    engine = TriggerEngine(game_payload([game_layout(cy=0.429)]))
    monkeypatch.setattr("trigger_engine.check_rank", lambda *_args: 1 / 0)
    engine.process(frame, 0)
    assert engine.process(frame, 0.1) is not None
    assert engine.triggered_rank == {"rank": "unknown", "rankEvidence": None}
    monkeypatch.setattr(engine.result_reader, "process", lambda *_args: 1 / 0)
    assert engine.process(arena(badge=False)[0], 30) is None
    assert not engine.result_reader.armed and engine.take_prediction_result() is None


def test_structural_game_relative_uses_existing_matcher():
    frame = arena(badge=False)[0]
    frame[200:328, 100:228] = trigger_image((60, 30, 160))
    layout = game_layout()
    layout["trigger"] = {"kind": "structural", "profile": profile_for(trigger_image((60, 30, 160)))}
    layout["regions"]["trigger"] = {"x": 100 / 360, "y": 200 / 640, "width": 128 / 360, "height": 128 / 640}
    engine = TriggerEngine(game_payload([layout]))
    assert engine.process(frame, 0) is None
    assert engine.process(frame, 0.1) is not None
    assert engine.last_match.matcher == "structural"


def test_orientation_runtime_keeps_saved_normalized_height_during_rect_drift():
    frame, badge = arena()
    trigger = OrientationTrigger.build(frame, (0, 0, 360, 640), badge)
    assert trigger.score(frame, (0, 0, 360, 636)) >= 0.7
    assert trigger.score(frame, (0, 0, 360, 640)) >= 0.9


def test_same_canvas_aspect_change_requires_two_rechecks_then_unknown_within_45_frames():
    geometry = GameGeometry([game_layout()])
    original = arena(badge=False)[0]
    for index in range(20):
        geometry.process(original, index / 10)
    changed = np.zeros_like(original)
    changed[:, 36:324] = arena(288, 640, badge=False)[0]
    unknown = None
    for index in range(45):
        geometry.process(changed, (20 + index) / 10)
        if index == 9:
            assert geometry.rect == (0, 0, 360, 640)
        if index == 19:
            assert geometry.rect == (36, 0, 288, 640)
            assert geometry.state == "aspect_mismatch"
        if geometry.state == "aspect_unknown" and unknown is None:
            unknown = index
    assert unknown is not None and unknown <= 45


def test_same_canvas_change_never_produces_false_fire():
    engine = TriggerEngine(game_payload())
    original = arena(badge=False)[0]
    for index in range(20):
        assert engine.process(original, index / 10) is None
    changed = np.zeros_like(original)
    changed[:, 36:324] = arena(288, 640, badge=False)[0]
    for index in range(45):
        assert engine.process(changed, (20 + index) / 10) is None
        assert not engine.take_triggered()
    assert engine.geometry.state == "aspect_unknown"


def test_same_canvas_aspect_rechecks_must_be_consecutive():
    geometry = GameGeometry([game_layout()])
    original = arena(badge=False)[0]
    changed = np.zeros_like(original)
    changed[:, 36:324] = arena(288, 640, badge=False)[0]
    for index in range(20):
        geometry.process(original, index / 10)
    for block, frame in enumerate((changed, original, changed, changed)):
        for index in range(10):
            geometry.process(frame, 2 + block + index / 10)
        assert geometry.rect == ((36, 0, 288, 640) if block == 3 else (0, 0, 360, 640))


@pytest.mark.parametrize("ticks", [60, 80])
def test_saved_toolbar_stays_armed_with_only_periodic_full_frame_detection(monkeypatch, ticks):
    import game_geometry

    frames = [framed(np.random.default_rng(i).integers(0, 256, (640, 360, 3), dtype=np.uint8), toolbar=24)[0]
              for i in range(8)]
    chrome = detect(frames).chrome
    assert chrome["top"] == 24
    geometry = GameGeometry([game_layout(chrome=chrome)])
    original_detect = game_geometry.detect
    calls = []

    def counted_detect(*args, **kwargs):
        calls.append(1)
        return original_detect(*args, **kwargs)

    monkeypatch.setattr(game_geometry, "detect", counted_detect)
    for index in range(ticks):
        geometry.process(frames[index % len(frames)], index / 10)
        assert geometry.rect == (40, 48, 360, 640)
        assert geometry.raw_rect == (40, 24, 360, 664)
        if index >= 19:
            assert geometry.state == "armed"
            assert geometry.frames == 20
    assert len(calls) == 20 + (ticks - 20) // 10


def test_black_periodic_recheck_keeps_established_rect_and_detection_budget(monkeypatch):
    import game_geometry

    geometry = GameGeometry([game_layout()])
    frame, _ = framed(arena(badge=False)[0])
    for index in range(20):
        geometry.process(frame, index / 10)
    original_detect = game_geometry.detect
    calls = []

    def counted_detect(*args, **kwargs):
        calls.append(1)
        return original_detect(*args, **kwargs)

    monkeypatch.setattr(game_geometry, "detect", counted_detect)
    for index in range(20, 40):
        geometry.process(np.zeros_like(frame) if index == 29 else frame, index / 10)
        assert geometry.state == "armed"
        assert geometry.rect == (40, 24, 360, 640)
        assert geometry.frames == 20
    assert len(calls) == 2
    assert geometry._missing_checks == 0


def moving_game(index: int) -> np.ndarray:
    noise = np.random.default_rng(index).integers(0, 256, (640, 360, 3), dtype=np.uint8)
    return cv2.GaussianBlur(noise, (3, 3), 0)


def emulator_window(game: np.ndarray, width: int, toolbar: int = 32) -> np.ndarray:
    """An emulator window: four uniform border rows, then a title bar of fixed
    pixel height whose icons keep their pixel size at the ends, above the game
    scaled to the window width."""
    height = round(game.shape[0] * width / game.shape[1])
    frame = np.empty((toolbar + height, width, 3), np.uint8)
    frame[:toolbar] = (92, 88, 84)
    icons = np.random.default_rng(4242).integers(140, 255, (toolbar - 8, 96, 3), dtype=np.uint8)
    frame[4:toolbar - 4, 6:102] = icons
    frame[4:toolbar - 4, width - 102:width - 6] = icons[:, ::-1]
    frame[toolbar:] = cv2.resize(game, (width, height), interpolation=cv2.INTER_AREA)
    return frame


def test_fullscreen_profile_finds_the_game_below_a_title_bar_after_leaving_fullscreen():
    # Field test 1: a profile set up in fullscreen saved no chrome. In a window
    # the title bar used to stay inside the game rect, so the badge crop moved
    # off the shield (or the aspect no longer matched) and nothing ever fired.
    geometry = GameGeometry([game_layout()])
    for index in range(12):
        geometry.process(emulator_window(moving_game(index), 270), index / 10)
    assert geometry.rect == (0, 32, 270, 480)
    assert geometry.state == "armed_provisional"
    assert geometry.chrome["top"] == 28


@pytest.mark.parametrize("width", [240, 540, 720])
def test_saved_title_bar_thickness_survives_window_resize(width):
    # Field test 1: the saved length-normalized title-bar template no longer
    # matches once the window width changes, because the icons do not stretch.
    setup = [emulator_window(moving_game(index), 360) for index in range(8)]
    chrome = detect(setup).chrome
    assert chrome["top"] == 28
    geometry = GameGeometry([game_layout(chrome=chrome)])
    frame = emulator_window(moving_game(99), width)
    geometry.process(frame, 0)
    assert geometry.rect == (0, 32, width, frame.shape[0] - 32)
    assert geometry.state == "armed_provisional"


def test_saved_title_bar_is_not_invented_in_fullscreen_or_on_a_static_screen():
    setup = [emulator_window(moving_game(index), 360) for index in range(8)]
    fullscreen = GameGeometry([game_layout(chrome=detect(setup).chrome)])
    fullscreen.process(cv2.resize(moving_game(5), (540, 960)), 0)
    assert fullscreen.rect == (0, 0, 540, 960)
    # Without saved chrome a band needs a moving game below a static band.
    static = GameGeometry([game_layout()])
    frame = emulator_window(moving_game(5), 270)
    for index in range(12):
        static.process(frame, index / 10)
    assert static.rect == (0, 4, 270, 508)


STATIC_COLUMN = np.random.default_rng(77).integers(20, 50, (621, 12, 3), dtype=np.uint8)


def stretched_fullscreen(index: int) -> np.ndarray:
    """Owner F11 portrait (MuMu): the game is stretched to 0.579 between black
    top/bottom bars, and a menu keeps its right-hand column still while the
    middle animates."""
    game = cv2.resize(moving_game(index), (360, 621), interpolation=cv2.INTER_AREA)
    game[:, -12:] = STATIC_COLUMN
    frame = np.zeros((641, 360, 3), np.uint8)
    frame[10:631] = game
    return frame


def test_static_game_column_inside_letterbox_is_not_trimmed_as_a_toolbar():
    # Intermittent miss (owner, F11 portrait): the windowed profile was armed on
    # a game rect cut by a phantom right "toolbar", so VS scores fell to the
    # 0.5 threshold. The stretched game (gap 1.031) arms the layout whole.
    layout = game_layout()
    geometry = GameGeometry([layout])
    for index in range(40):
        geometry.process(stretched_fullscreen(index), index / 10)
        assert geometry._band is None
        assert geometry.layout is layout
    assert geometry.rect == (0, 10, 360, 621)
    assert geometry.state == "armed"


@pytest.mark.parametrize("height", range(608, 626))
def test_aspect_band_is_deterministic_around_the_old_three_percent_edge(height):
    # 360 / (640 / gap) for gaps 1.024–1.053: one pixel either way never flips
    # between arming the layout and treating the game as a new layout.
    layout = game_layout()
    geometry = GameGeometry([layout])
    frame = np.zeros((height + 20, 360, 3), np.uint8)
    for index in range(25):
        frame[10:10 + height] = cv2.resize(moving_game(index), (360, height), interpolation=cv2.INTER_AREA)
        geometry.process(frame, index / 10)
    gap = aspect_gap(360 / height, layout["gameAspect"])
    assert geometry.rect == (0, 10, 360, height)
    if gap <= ASPECT_MATCH_TOL:
        assert (geometry.state, geometry.layout) == ("armed", layout)
    else:
        assert (geometry.state, geometry.layout) == ("aspect_unknown", None)
        # Learning beyond the band can never be refused as an overlap.
        assert not aspects_overlap(360 / height, layout["gameAspect"])


def test_armed_layout_is_held_when_the_peel_regains_uniform_rows():
    # Gap 1.050 is outside the match band. A menu whose top and bottom rows are
    # uniform peels to gap 1.040 and arms the layout; when the battle fills
    # those rows the rectangle grows, and the same layout stays armed.
    def frame(index, rows):
        canvas = np.zeros((692, 360, 3), np.uint8)
        canvas[10:682] = (40, 40, 40)
        top = 10 + (672 - rows) // 2
        canvas[top:top + rows] = cv2.resize(moving_game(index), (360, rows), interpolation=cv2.INTER_AREA)
        return canvas

    layout = game_layout()
    geometry = GameGeometry([layout])
    for index in range(60):
        geometry.process(frame(index, 666 if index < 30 else 672), index / 10)
        assert geometry.layout is layout and geometry.state in ("armed", "armed_provisional")
    assert geometry.rect == (0, 10, 360, 672)
    fresh = GameGeometry([layout])
    for index in range(25):
        fresh.process(frame(index, 672), index / 10)
    assert (fresh.state, fresh.layout) == ("aspect_unknown", None)



def test_side_toolbar_spanning_the_letterboxed_window_is_still_trimmed():
    def window(index):
        game = cv2.resize(moving_game(index), (348, 619), interpolation=cv2.INTER_AREA)
        frame = np.zeros((639, 360, 3), np.uint8)
        frame[:, -12:] = (92, 88, 84)
        frame[20:120, -12:] = 220
        frame[10:629, :348] = game
        return frame

    geometry = GameGeometry([game_layout()])
    for index in range(12):
        geometry.process(window(index), index / 10)
    assert geometry._band == ("right", 348)
    assert geometry.rect == (0, 10, 348, 619)
    assert geometry.state == "armed_provisional"


def owner_f11_layouts():
    """The owner's `ranked` profile: the F11 setup layout and the layout learned
    on 14.10 through a phantom 57-px left band (one third scale: 19 px)."""
    setup = game_layout(F11_WIDTH, F11_GAME)
    phantom = game_layout(F11_WIDTH - 19, F11_GAME, source="learned", chrome={**NO_CHROME, "left": 19})
    return setup, phantom


def test_phantom_chrome_is_template_less_chrome_of_a_learned_layout():
    setup, phantom = owner_f11_layouts()
    assert phantom_chrome(phantom)
    assert not phantom_chrome(setup)
    assert not phantom_chrome({**setup, "windowChrome": {**NO_CHROME, "left": 19}})
    templated = detect([emulator_window(moving_game(index), 360) for index in range(8)]).chrome
    assert not phantom_chrome({**phantom, "windowChrome": templated})


def test_learned_phantom_chrome_layout_never_seeds_a_band():
    # 03:57 on 17.10: the 0.5488 layout learned through a phantom band implied a
    # 96-px left "toolbar" on a menu whose dark left margin had been peeled.
    geometry = GameGeometry(list(owner_f11_layouts()))
    for index in range(40):
        geometry.process(phantom_band_menu(index), index / 10)
        assert geometry._band is None
    assert geometry.rect == (7, F11_BAR, 339, F11_GAME - 51)


@pytest.mark.parametrize("edge, seeds", [(32, "owner"), (17, "setup")])
def test_phantom_band_from_a_peeled_dark_margin_is_dropped_once_the_game_fills_the_frame(edge, seeds):
    # The band's raw outer edge sat on the peeled margin (x = 7). When the game
    # fills the frame the edge moves to x = 0 and the band would now have to
    # cross MuMu's black bars, which it does not: it was game content.
    setup, phantom = owner_f11_layouts()
    geometry = GameGeometry([setup, phantom] if seeds == "owner" else [setup])
    for index in range(40):
        geometry.process(phantom_band_menu(index, edge), index / 10)
    if seeds == "setup":
        assert geometry._band == ("left", 15)
    for index in range(40, 80):
        geometry.process(f11_frame(moving_noise(index)), index / 10)
    assert geometry._band is None
    assert geometry.rect == (0, F11_BAR, F11_WIDTH, F11_GAME)
    assert (geometry.state, geometry.layout) == ("armed", setup)


STILL_COLUMN = np.random.default_rng(91).integers(20, 120, (640, 12, 3), dtype=np.uint8)


def column_window(index: int, *, moving: bool = False, dark_rows: int = 0, toolbar: bool = False) -> np.ndarray:
    """A plain window capture (no letterbox): the game and a 12-px right column
    that is either a still game column or a real toolbar."""
    frame = np.empty((640, 372, 3), np.uint8)
    frame[:, :360] = moving_game(index)
    frame[:, 360:] = moving_game(5000 + index)[:, :12] if moving else STILL_COLUMN
    if toolbar:
        frame[:, 360:] = (92, 88, 84)
        frame[100:200, 360:] = 220
    if dark_rows:
        # Dark first game rows; a real toolbar continues beside them.
        frame[:dark_rows, :360 if toolbar else 372] = 0
    return frame


def test_inferred_band_is_dropped_after_game_motion_on_rechecks_a_second_apart():
    geometry = GameGeometry([game_layout()])
    for index in range(30):
        geometry.process(column_window(index), index / 10)
    assert geometry._band == ("right", 360)
    history = []
    for index in range(30, 70):
        geometry.process(column_window(index, moving=True), index / 10)
        history.append(geometry._band)
    # One moving recheck is not enough; the next one, a second later, is.
    assert history[9] == ("right", 360) and history[-1] is None
    assert geometry.rect == (0, 0, 372, 640)


def test_inferred_band_is_dropped_when_dark_game_rows_cover_it_too():
    geometry = GameGeometry([game_layout()])
    for index in range(30):
        geometry.process(column_window(index), index / 10)
    assert geometry._band == ("right", 360)
    for index in range(30, 50):
        geometry.process(column_window(index, dark_rows=40), index / 10)
    assert geometry._band is None
    assert geometry.rect == (0, 40, 372, 600)


def test_real_side_toolbar_band_survives_rechecks_and_dark_game_rows():
    geometry = GameGeometry([game_layout()])
    for index in range(120):
        geometry.process(column_window(index, toolbar=True, dark_rows=40 if (index // 15) % 2 else 0), index / 10)
        if index >= 8:
            assert geometry._band == ("right", 360)


def test_owner_f11_phantom_band_menu_then_every_vs_fires_on_the_setup_layout():
    # 03:57–04:13 on 17.10, synthetic: after the menu every VS ended `confirm`
    # on the phantom layout, 21 px off the badge, and no deck was requested.
    setup, phantom = owner_f11_layouts()

    def battle(seed):
        return ([phantom_band_menu(index) for index in range(40)] + [pre_battle(index) for index in range(30)]
                + [f11_frame(moving_noise(800 + index)) for index in range(30)]
                + [f11_frame(arena(F11_WIDTH, F11_GAME, seed=seed + index)[0]) for index in range(20)]
                + [f11_frame(moving_noise(700 + index)) for index in range(30)])

    first, second = battle(0), battle(100)
    engine = TriggerEngine(game_payload([setup, phantom]))
    fires, records, learned = [], [], []
    for index, frame in enumerate(first + second):
        engine.process(frame, index / 10 + (16 if index >= len(first) else 0))
        if engine.take_triggered():
            fires.append(index)
        for kind, value in engine.take_events():
            if kind == "vs_candidate":
                records.append((value["reason"], value["learnedLayout"]))
            learned += [value] if kind == "layout_learned" else []
    assert fires == [101, len(first) + 101]
    assert records == [("fired", False), ("fired", False)]
    assert learned == []
