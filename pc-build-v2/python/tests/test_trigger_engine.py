import cv2
import numpy as np
import pytest

from analyze_trigger import analyze
from monitor_protocol import MonitorProtocolError
from trigger_engine import (
    PredictionTriggerEngine,
    TriggerEngine,
    TriggerProfile,
    encode_action_png,
)


def trigger_image(
    background: tuple[int, int, int],
    *,
    include_ui: bool = True,
    texture_seed: int | None = None,
    label: str = "GO",
) -> np.ndarray:
    if texture_seed is None:
        image = np.empty((128, 128, 3), dtype=np.uint8)
        image[:] = background
    else:
        random = np.random.default_rng(texture_seed)
        texture = random.integers(0, 100, (128, 128, 3), dtype=np.uint8)
        image = np.clip(texture + np.array(background, dtype=np.uint8), 0, 255).astype(
            np.uint8
        )
    if include_ui:
        cv2.rectangle(image, (18, 22), (108, 100), (245, 245, 245), 3)
        cv2.putText(
            image,
            label,
            (28, 78),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.55,
            (245, 245, 245),
            4,
        )
    return image


def frame_for(trigger: np.ndarray, data_color=(20, 100, 220)) -> np.ndarray:
    frame = np.zeros((128, 256, 3), dtype=np.uint8)
    frame[:, :128] = trigger
    frame[:, 128:] = data_color
    return frame


def profile_for(trigger: np.ndarray) -> dict:
    frame = frame_for(trigger)
    ok, encoded = cv2.imencode(".png", frame)
    assert ok
    return analyze(
        encoded.tobytes(), {"x": 0, "y": 0, "width": 128, "height": 128}
    )


def payload(profile: dict, search_mode="fast", capture_delay=0):
    return {
        "configuredFrameSize": {"width": 256, "height": 128},
        "triggerProfile": profile,
        "regions": {
            "trigger": {"x": 0, "y": 0, "width": 0.5, "height": 1},
            "normal": {"x": 0.5, "y": 0, "width": 0.25, "height": 1},
            "precise": {"x": 0.5, "y": 0, "width": 0.5, "height": 1},
        },
        "searchMode": search_mode,
        "captureDelaySeconds": capture_delay,
        "limits": {
            "fps": 10,
            "maxImageBytes": 10 * 1024 * 1024,
            "maxImagePixels": 20_000_000,
            "maxImageWidth": 8192,
            "maxImageHeight": 8192,
            "confirmationsNeeded": 2,
            "confirmationDecay": 0.5,
            "cooldownSeconds": 15,
        },
    }


@pytest.mark.parametrize(
    "background",
    [(180, 60, 20), (20, 160, 220), (30, 200, 30), (220, 220, 30)],
)
def test_same_arbitrary_ui_matches_across_background_colors(background) -> None:
    configured = trigger_image((180, 60, 20))
    engine = TriggerEngine(payload(profile_for(configured)))
    candidate = frame_for(trigger_image(background))
    assert engine.process(candidate, 0.0) is None
    assert engine.process(candidate, 0.11) is not None
    assert engine.last_match is not None
    assert engine.last_match.matched is True


def test_textured_background_requires_verified_ui_geometry() -> None:
    configured = trigger_image((20, 20, 20), texture_seed=4)
    profile = profile_for(configured)
    assert profile["matcherMode"] == "edge_orb"
    engine = TriggerEngine(payload(profile))
    changed_arena = frame_for(trigger_image((80, 80, 80), texture_seed=8))
    assert engine.process(changed_arena, 0.0) is None
    assert engine.process(changed_arena, 0.11) is not None

    negative = TriggerEngine(payload(profile))
    texture_only = frame_for(
        trigger_image((80, 80, 80), include_ui=False, texture_seed=12)
    )
    assert negative.process(texture_only, 0.0) is None
    assert negative.process(texture_only, 0.11) is None
    assert negative.last_match is not None
    assert negative.last_match.matched is False


def test_low_feature_icon_uses_edge_shape_without_color() -> None:
    configured = np.full((128, 128, 3), (180, 40, 30), dtype=np.uint8)
    cv2.circle(configured, (64, 64), 32, (245, 245, 245), 4)
    profile = profile_for(configured)
    assert profile["matcherMode"] == "edge"

    candidate = np.full((128, 128, 3), (20, 190, 210), dtype=np.uint8)
    cv2.circle(candidate, (64, 64), 32, (245, 245, 245), 4)
    engine = TriggerEngine(payload(profile))
    assert engine.process(frame_for(candidate), 0.0) is None
    assert engine.process(frame_for(candidate), 0.11) is not None

    negative = TriggerEngine(payload(profile))
    square = np.full((128, 128, 3), (20, 190, 210), dtype=np.uint8)
    cv2.rectangle(square, (32, 32), (96, 96), (245, 245, 245), 4)
    assert negative.process(frame_for(square), 0.0) is None
    assert negative.process(frame_for(square), 0.11) is None


@pytest.mark.parametrize("cell_size", [8, 16])
def test_repetitive_checkerboard_profile_matches_its_source(cell_size: int) -> None:
    y, x = np.indices((128, 128))
    gray = (((x // cell_size + y // cell_size) % 2) * 255).astype(np.uint8)
    configured = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    profile = profile_for(configured)

    assert profile["quality"]["keypointsCount"] >= 20
    assert profile["matcherMode"] == "edge"
    result = TriggerProfile(profile).evaluate(configured)
    assert result.matched is True


def test_rejects_profiles_that_predate_orb_viability_checks() -> None:
    profile = profile_for(trigger_image((20, 20, 20), texture_seed=4))
    profile["analyzer"]["version"] = "2.0.0"

    with pytest.raises(MonitorProtocolError, match="re-analyzed"):
        TriggerProfile(profile)


def test_noisy_4k_action_is_adaptively_encoded_within_byte_limit() -> None:
    random = np.random.default_rng(20260729)
    image = random.integers(0, 256, (2160, 3840, 3), dtype=np.uint8)
    limits = payload(profile_for(trigger_image((20, 20, 20))))["limits"]

    encoded, width, height = encode_action_png(image, limits)

    assert len(encoded) <= 10 * 1024 * 1024
    assert len(encoded) >= int(9.5 * 1024 * 1024)
    assert 1 < width < 3840
    assert 1 < height < 2160
    decoded = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert decoded is not None
    assert decoded.shape[:2] == (height, width)


def test_main_trigger_requires_consecutive_frames_and_release_before_rearm() -> None:
    trigger = trigger_image((30, 100, 180))
    engine = TriggerEngine(payload(profile_for(trigger)))
    matching = frame_for(trigger)
    wrong = frame_for(trigger_image((30, 100, 180), include_ui=False))

    assert engine.process(matching, 0.0) is None
    assert engine.process(wrong, 0.11) is None
    assert engine.process(matching, 0.22) is None
    action = engine.process(matching, 0.33)
    assert action is not None
    assert engine.take_triggered() is True
    assert engine.take_triggered() is False
    _, width, height = action
    assert (width, height) == (64, 128)

    assert engine.process(matching, 15.5) is None
    assert engine.process(matching, 15.61) is None
    assert engine.process(wrong, 15.72) is None
    assert engine.process(wrong, 15.83) is None
    assert engine.process(matching, 15.94) is None
    assert engine.process(matching, 16.05) is not None


def test_precise_capture_uses_a_later_data_frame() -> None:
    trigger = trigger_image((120, 40, 80))
    engine = TriggerEngine(payload(profile_for(trigger), "precise", capture_delay=2.2))
    matching = frame_for(trigger)
    assert engine.process(matching, 0.0) is None
    assert engine.process(matching, 0.11) is None
    assert engine.take_triggered() is True

    later = frame_for(trigger, (7, 211, 33))
    assert engine.process(later, 2.2) is None
    action = engine.process(later, 2.31)
    assert action is not None
    encoded, width, height = action
    decoded = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert (width, height) == (128, 128)
    assert decoded is not None
    assert tuple(int(value) for value in decoded[64, 64]) == (7, 211, 33)


def test_prediction_result_uses_shared_matcher_and_two_confirmations() -> None:
    trigger = trigger_image((60, 30, 160), label="END")
    configured = payload(profile_for(trigger))
    engine = PredictionTriggerEngine(
        {
            "configuredFrameSize": configured["configuredFrameSize"],
            "trigger": configured["regions"]["trigger"],
            "data": configured["regions"]["normal"],
            "triggerProfile": configured["triggerProfile"],
        },
        configured["limits"],
    )
    frame = frame_for(trigger)
    assert engine.process(frame, 0.0) is None
    result = engine.process(frame, 0.11)
    assert result is not None
    _, width, height = result
    assert (width, height) == (64, 128)


def test_source_aspect_ratio_change_requires_new_setup() -> None:
    trigger = trigger_image((20, 80, 140))
    engine = TriggerEngine(payload(profile_for(trigger)))
    changed = np.zeros((256, 256, 3), dtype=np.uint8)
    with pytest.raises(RuntimeError, match="aspect ratio changed"):
        engine.process(changed, 0.0)
