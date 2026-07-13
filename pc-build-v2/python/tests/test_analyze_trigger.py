import base64

import cv2
import numpy as np
import pytest

from analyze_trigger import ahash64, analyze, hamming64, validate_pixel_rect
from protocol.framing import ProtocolError


def synthetic_png() -> bytes:
    image = np.zeros((120, 200, 3), dtype=np.uint8)
    image[20:100, 40:160] = (220, 220, 220)
    cv2.line(image, (40, 20), (159, 99), (20, 20, 20), 4)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def test_golden_synthetic_profile_and_bitwise_hamming() -> None:
    profile = analyze(synthetic_png(), {"x": 20, "y": 10, "width": 160, "height": 100})
    assert profile["hashAlgorithm"] == "ahash64-bitwise-v1"
    assert profile["ahash64"] == "003fdfeff7fbfc00"
    assert hamming64("0000000000000000", "ffffffffffffffff") == 64
    assert hamming64(profile["ahash64"], profile["ahash64"]) == 0
    assert len(profile["templateGrayBase64"]) > 1000
    encoded_template = base64.b64decode(profile["templateGrayBase64"], validate=True)
    assert encoded_template.startswith(b"\x89PNG\r\n\x1a\n")
    template = cv2.imdecode(np.frombuffer(encoded_template, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    assert template is not None
    assert template.shape == (128, 128)


def test_ahash_uses_bits_not_hex_character_distance() -> None:
    dark = np.zeros((128, 128), dtype=np.uint8)
    light = dark.copy()
    light[:, 64:] = 255
    assert ahash64(dark) == "ffffffffffffffff"
    assert hamming64(ahash64(dark), ahash64(light)) == 32


def test_rect_must_be_inside_actual_frame() -> None:
    with pytest.raises(ProtocolError, match="exceeds"):
        validate_pixel_rect({"x": 190, "y": 0, "width": 20, "height": 20}, 200, 120)
