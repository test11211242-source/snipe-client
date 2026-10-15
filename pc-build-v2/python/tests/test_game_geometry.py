import uuid

import cv2
import numpy as np
import pytest

from game_geometry import GameGeometry
from geometry.aspect import ASPECT_MATCH_TOL, aspect_gap, aspects_overlap
from geometry.game_rect import detect
from geometry.vs_orient_trigger import OrientationTrigger
from geometry.zones import regions
from synthetic_frames import arena, framed
from test_trigger_engine import payload, profile_for, trigger_image
from trigger_engine import PredictionTriggerEngine, TriggerEngine


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
    result["prediction"] = None
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


def test_prediction_aspect_mismatch_pauses_and_resumes_without_fatal():
    configured = payload(profile_for(trigger_image((60, 30, 160))))
    primary = configured["primary"]
    engine = PredictionTriggerEngine({"configuredFrameSize": primary["configuredFrameSize"], "trigger": primary["regions"]["trigger"],
                                      "data": primary["regions"]["nicknameRegion"], "triggerProfile": primary["triggerProfile"]}, configured["limits"])
    assert engine.process(np.zeros((256, 256, 3), np.uint8), 0) is None
    assert engine.take_events() == [("prediction_state", {"state": "aspect_mismatch"})]
    assert engine.process(np.zeros((256, 256, 3), np.uint8), 0.11) is None
    assert engine.take_events() == []
    assert engine.process(np.zeros((128, 256, 3), np.uint8), 0.22) is None
    assert engine.take_events() == [("prediction_state", {"state": "active"})]


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
