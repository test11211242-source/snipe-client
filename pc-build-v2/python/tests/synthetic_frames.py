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
