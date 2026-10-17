"""Name-free deterministic arenas, real shipped badge, borders and static chrome."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from geometry.zones import Badge

ASSETS = Path(__file__).resolve().parents[1] / "assets"


def arena(width: int = 360, height: int = 640, *, seed: int = 0, badge: bool = True,
          k: float = 0.21, cy: float = 0.429) -> tuple[np.ndarray, Badge]:
    rng = np.random.default_rng(seed)
    noise = rng.integers(15, 80, (height, width, 3), dtype=np.uint8)
    image = cv2.GaussianBlur(noise, (5, 5), 0)
    yy, xx = np.indices((height, width))
    cells = (((xx // 31 + yy // 29) % 2) * 18).astype(np.uint8)
    image = np.clip(image.astype(np.int16) + cells[:, :, None], 0, 255).astype(np.uint8)
    bw = round(k * width)
    bh = round(bw * 159 / 132)
    geometry = Badge(0.496, cy, bw / width, bh / height)
    if badge:
        resource = cv2.imread(str(ASSETS / "vs_badge_v1.png"))
        mask = cv2.imread(str(ASSETS / "vs_badge_v1_mask.png"), cv2.IMREAD_GRAYSCALE)
        # Preserve the metallic outer rim that the finder includes in its dilated silhouette.
        mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=2)
        sprite_size = (round(resource.shape[1] * bw / 132), round(resource.shape[0] * bw / 132))
        source = cv2.resize(resource, sprite_size, interpolation=cv2.INTER_AREA)
        alpha = cv2.resize(mask, sprite_size, interpolation=cv2.INTER_AREA).astype(np.float32)[:, :, None] / 255
        x, y = round(geometry.cx * width - sprite_size[0] / 2), round(geometry.cy * height - sprite_size[1] / 2)
        roi = image[y:y + sprite_size[1], x:x + sprite_size[0]]
        roi[:] = np.rint(source * alpha + roi * (1 - alpha)).astype(np.uint8)
        geometry = Badge((x + sprite_size[0] / 2) / width, (y + sprite_size[1] / 2) / height, bw / width, bh / height)
    return image, geometry


def framed(image: np.ndarray, *, borders: tuple[int, int, int, int] = (40, 24, 40, 24),
           mixed: bool = False, cursor: bool = False, toolbar: int = 0) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    left, top, right, bottom = borders
    height, width = image.shape[:2]
    result = np.zeros((height + top + bottom + toolbar, width + left + right, 3), np.uint8)
    if mixed:
        result[:] = (160, 65, 30)
        result[:top] = (0, 0, 0)
        result[-bottom:] = (50, 100, 180)
        result[:, :left] = (220, 155, 80)
    result[top + toolbar:top + toolbar + height, left:left + width] = image
    if toolbar:
        strip = result[top:top + toolbar, left:left + width]
        strip[:] = np.random.default_rng(1729).integers(25, 140, strip.shape, dtype=np.uint8)
        cv2.putText(strip, "Synthetic toolbar", (5, max(12, toolbar - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (180, 180, 180), 1)
    if cursor and left:
        n = int(height * 0.07)
        result[top + toolbar + height // 3:top + toolbar + height // 3 + n, :left] = 255
    return result, (left, top + toolbar, width, height)


def variants(image: np.ndarray) -> dict[str, np.ndarray]:
    gray = cv2.cvtColor(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hsv[:, :, 0] = (hsv[:, :, 0].astype(np.int16) + 10) % 180
    return {"original": image, "gray": gray, "hue": cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR),
            "inverse": 255 - image, "dark": np.clip(image.astype(np.float32) * 0.7, 0, 255).astype(np.uint8),
            "bright": np.clip(image.astype(np.float32) * 1.3, 0, 255).astype(np.uint8),
            "gamma": np.round((image.astype(np.float32) / 255) ** 1.3 * 255).astype(np.uint8)}


# Owner MuMu F11 portrait (17.10.2026) at one third of 1080×1920: the game is
# stretched to 621 of 641 rows between black bars (aspect 0.5797).
F11_WIDTH, F11_GAME, F11_BAR = 360, 621, 10
PHANTOM_STRIP = cv2.blur(np.random.default_rng(5).integers(20, 120, (F11_GAME, 40, 3), dtype=np.uint8), (31, 1))
NO_CHROME = {"top": 0, "bottom": 0, "left": 0, "right": 0,
             "topEdges": None, "bottomEdges": None, "leftEdges": None, "rightEdges": None}


def moving_noise(index: int, width: int = F11_WIDTH, height: int = F11_GAME) -> np.ndarray:
    noise = np.random.default_rng(index).integers(0, 256, (height, width, 3), dtype=np.uint8)
    return cv2.GaussianBlur(noise, (3, 3), 0)


def f11_frame(game: np.ndarray) -> np.ndarray:
    frame = np.zeros((F11_GAME + 2 * F11_BAR, F11_WIDTH, 3), np.uint8)
    frame[F11_BAR:F11_BAR + F11_GAME] = game
    return frame


def phantom_band_menu(index: int, edge: int = 32) -> np.ndarray:
    """The 03:57 screen, synthetic: uniform dark left inset, right margin and
    bottom rows (the peel removes them), a still strip with a vertical border up
    to `edge` and an animated middle. A phantom left band from a layout aspect
    passes as chrome here, because the inset raw rect skips the letterbox test."""
    game = moving_noise(index)
    game[:, 7:edge] = PHANTOM_STRIP[:, 7:edge]
    game[:, edge - 2:edge] = 230
    game[:, :7] = 0
    game[:, F11_WIDTH - 14:] = 0
    game[F11_GAME - 51:] = 0
    return f11_frame(game)


def pre_battle(index: int) -> np.ndarray:
    """The matchmaking screen before a VS: uniform rows above and below (0.68)."""
    game = moving_noise(500 + index)
    game[:49] = 0
    game[F11_GAME - 42:] = 0
    return f11_frame(game)
