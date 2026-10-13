from __future__ import annotations

import cv2
import numpy as np
import pytest

from geometry.game_rect import detect
from synthetic_frames import arena, framed


@pytest.mark.parametrize("scale", [0.5, 0.75, 1.0, 1.5])
@pytest.mark.parametrize("mixed,cursor", [(False, False), (True, False), (True, True)])
def test_uniform_borders_of_any_colour(scale: float, mixed: bool, cursor: bool) -> None:
    image, _ = arena()
    image = cv2.resize(image, None, fx=scale, fy=scale)
    frame, expected = framed(image, mixed=mixed, cursor=cursor)
    result = detect([frame])
    assert result.reason == "ok"
    assert result.rect == expected


@pytest.mark.parametrize("side", ["top", "bottom", "left", "right"])
def test_temporal_chrome_has_orientation_templates(side: str) -> None:
    frames = []
    for seed in range(8):
        image, _ = arena(seed=seed)
        # Temporal noise must exceed the 30-gray-level interior activity gate.
        image = np.random.default_rng(seed).integers(0, 256, image.shape, dtype=np.uint8)
        frame, _ = framed(image, toolbar=24)
        if side == "bottom":
            frame = frame[::-1].copy()
        elif side in ("left", "right"):
            # Keep the game portrait after transposition by using a landscape source.
            image = cv2.resize(image, (640, 360))
            frame, _ = framed(image, toolbar=24)
            frame = np.transpose(frame, (1, 0, 2)).copy()
            if side == "right":
                frame = frame[:, ::-1].copy()
        frames.append(frame)
    result = detect(frames)
    assert result.reason == "ok"
    assert result.chrome[side] == 24
    edges = result.chrome[side + "Edges"]
    assert edges["length"] == 256
    assert edges["thickness"] >= 1
    assert "colour" not in edges


def test_static_interior_cannot_certify_a_toolbar() -> None:
    image, _ = arena()
    frame, _ = framed(image, toolbar=24)
    result = detect([frame] * 8)
    assert result.chrome["top"] == 0


@pytest.mark.parametrize("size,reason", [((40, 80), "too_small"), ((400, 400), "aspect_out_of_range")])
def test_geometry_rejection(size: tuple[int, int], reason: str) -> None:
    image, _ = arena(*size, badge=False)
    assert detect([image]).reason == reason


def test_empty_or_mixed_size_input_is_invalid() -> None:
    with pytest.raises(ValueError):
        detect([])
    image, _ = arena()
    with pytest.raises(ValueError):
        detect([image, image[:-1]])
