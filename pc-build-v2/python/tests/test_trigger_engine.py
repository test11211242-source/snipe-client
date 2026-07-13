import base64

import cv2
import numpy as np
import pytest

from trigger_engine import PredictionTriggerEngine, TriggerEngine, ahash64, hamming64


def profile(template: np.ndarray, mode="ncc"):
    ok, encoded = cv2.imencode(".png", template)
    assert ok
    return {
        "schemaVersion": 2,
        "analyzer": {"name": "cr-tools-trigger-analyzer", "version": "1.0.0"},
        "hashAlgorithm": "ahash64-bitwise-v1",
        "ahash64": ahash64(template),
        "innerRect": {"x": 0, "y": 0, "width": 1, "height": 1},
        "featureMode": mode,
        "keypointsCount": 0,
        "normalizedTemplateSize": {"width": 128, "height": 128},
        "templateGrayBase64": base64.b64encode(encoded.tobytes()).decode(),
        "hashMaxDistance": 18,
        "orbDistanceThreshold": 55,
        "orbMinGoodMatches": 10,
        "nccMinScore": 0.72,
    }


def payload(template: np.ndarray, search_mode="fast", feature_mode="ncc"):
    return {
        "configuredFrameSize": {"width": 256, "height": 128},
        "triggerProfile": profile(template, feature_mode),
        "regions": {
            "trigger": {"x": 0, "y": 0, "width": 0.5, "height": 1},
            "normal": {"x": 0.5, "y": 0, "width": 0.25, "height": 1},
            "precise": {"x": 0.5, "y": 0, "width": 0.5, "height": 1},
        },
        "searchMode": search_mode,
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


def synthetic_template():
    image = np.zeros((128, 128), dtype=np.uint8)
    cv2.rectangle(image, (12, 18), (110, 100), 220, -1)
    cv2.line(image, (15, 20), (108, 98), 30, 5)
    cv2.circle(image, (70, 45), 14, 80, -1)
    return image


def frame_for(template: np.ndarray):
    frame = np.zeros((128, 256, 3), dtype=np.uint8)
    frame[:, :128] = cv2.cvtColor(template, cv2.COLOR_GRAY2BGR)
    frame[:, 128:] = (20, 100, 220)
    return frame


def test_bitwise_hamming_not_hex_character_distance() -> None:
    assert hamming64("0000000000000000", "ffffffffffffffff") == 64
    assert hamming64("0f00000000000000", "f000000000000000") == 8


def test_ncc_requires_two_confirmations_uses_fast_crop_and_cooldown() -> None:
    template = synthetic_template()
    engine = TriggerEngine(payload(template, "fast"))
    frame = frame_for(template)
    assert engine.process(frame, 0.0) is None
    action = engine.process(frame, 0.11)
    assert action is not None
    encoded, width, height = action
    assert (width, height) == (64, 128)
    assert encoded.startswith(b"\x89PNG\r\n\x1a\n")
    assert engine.process(frame, 1.0) is None
    assert engine.process(frame, 15.2) is None
    assert engine.process(frame, 15.31) is not None


def test_precise_crop_and_confirmation_decay() -> None:
    template = synthetic_template()
    engine = TriggerEngine(payload(template, "precise"))
    matching = frame_for(template)
    wrong = np.zeros_like(matching)
    assert engine.process(matching, 0.0) is None
    assert engine.process(wrong, 0.11) is None
    assert engine.process(matching, 0.22) is None
    action = engine.process(matching, 0.33)
    assert action is not None
    _, width, height = action
    assert (width, height) == (128, 128)


def test_orb_bf_hamming_crosscheck_thresholds_on_synthetic_frame() -> None:
    template = synthetic_template()
    configured = payload(template, feature_mode="orb")
    engine = TriggerEngine(configured)
    frame = frame_for(template)
    assert engine.process(frame, 0.0) is None
    assert engine.process(frame, 0.11) is not None


def test_source_aspect_ratio_change_requires_new_setup() -> None:
    template = synthetic_template()
    engine = TriggerEngine(payload(template))
    changed = np.zeros((256, 256, 3), dtype=np.uint8)
    with pytest.raises(RuntimeError, match="aspect ratio changed"):
        engine.process(changed, 0.0)


def test_prediction_result_uses_one_confirmation_private_crop_and_60_second_cooldown() -> None:
    template = synthetic_template()
    configured = payload(template)
    engine = PredictionTriggerEngine(
        {
            "configuredFrameSize": configured["configuredFrameSize"],
            "trigger": configured["regions"]["trigger"],
            "data": configured["regions"]["normal"],
            "triggerProfile": configured["triggerProfile"],
        },
        configured["limits"],
    )
    frame = frame_for(template)
    result = engine.process(frame, 0.0)
    assert result is not None
    encoded, width, height = result
    assert encoded.startswith(b"\x89PNG\r\n\x1a\n")
    assert (width, height) == (64, 128)
    assert engine.process(frame, 59.99) is None
    assert engine.process(frame, 60.1) is not None
