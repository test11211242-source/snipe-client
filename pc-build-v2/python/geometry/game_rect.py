"""Peel uniform borders of any colour and temporally static window chrome (§3.1)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal, Sequence

import cv2
import numpy as np

PixelRect = tuple[int, int, int, int]
TOL = 12
UNIFORM_FRAC = 0.93
COLOUR_DRIFT = 10
COARSE = 480
ASPECT_MIN = 9 / 22 * 0.97
ASPECT_MAX = 3 / 4 * 1.03
STATIC_TOL = 6
MAX_TOOLBAR = 0.10
MIN_TOOLBAR = 0.015


@dataclass(frozen=True)
class RectResult:
    rect: PixelRect | None
    aspect: float
    reason: Literal["ok", "too_small", "aspect_out_of_range"]
    chrome: dict[str, Any] = field(default_factory=dict)


def pixel_rect(rect: PixelRect) -> dict[str, int]:
    return dict(zip(("x", "y", "width", "height"), rect))


def _uniform(lines: np.ndarray) -> bool:
    median = np.median(lines, axis=1)
    deviation = np.abs(lines - median[:, None, :]).max(axis=2)
    return bool(((deviation <= TOL).mean(axis=1) >= UNIFORM_FRAC).all()
                and np.abs(median - median[0]).max() <= COLOUR_DRIFT)


def _peel(stack: np.ndarray, bounds: PixelRect) -> PixelRect:
    x0, y0, x1, y1 = bounds
    changed = True
    while changed and x1 - x0 > 4 and y1 - y0 > 4:
        changed = False
        while y1 - y0 > 4 and _uniform(stack[:, y0, x0:x1]):
            y0 += 1
            changed = True
        while y1 - y0 > 4 and _uniform(stack[:, y1 - 1, x0:x1]):
            y1 -= 1
            changed = True
        while x1 - x0 > 4 and _uniform(stack[:, y0:y1, x0]):
            x0 += 1
            changed = True
        while x1 - x0 > 4 and _uniform(stack[:, y0:y1, x1 - 1]):
            x1 -= 1
            changed = True
    return x0, y0, x1, y1


def _static_run(mask: np.ndarray) -> int:
    moving = np.flatnonzero(~mask)
    return int(moving[0]) if moving.size else len(mask)


def _trim_chrome(frames: Sequence[np.ndarray], bounds: PixelRect) -> tuple[PixelRect, dict[str, Any]]:
    from geometry.vs_orient_trigger import strip_edges

    x0, y0, x1, y1 = bounds
    gray = np.stack([cv2.cvtColor(f[y0:y1, x0:x1, :3], cv2.COLOR_BGR2GRAY).astype(np.int16) for f in frames])
    difference = gray.max(axis=0) - gray.min(axis=0)
    height, width = difference.shape
    chrome: dict[str, Any] = {side: 0 for side in ("top", "bottom", "left", "right")}
    chrome.update({side + "Edges": None for side in ("top", "bottom", "left", "right")})
    if float((difference[height // 4:3 * height // 4, width // 4:3 * width // 4] > 30).mean()) < 0.2:
        return bounds, chrome
    rows = (difference <= STATIC_TOL).mean(axis=1) >= 0.97
    cols = (difference <= STATIC_TOL).mean(axis=0) >= 0.97
    runs = {"top": _static_run(rows), "bottom": _static_run(rows[::-1]),
            "left": _static_run(cols), "right": _static_run(cols[::-1])}
    for side, size in runs.items():
        length = height if side in ("top", "bottom") else width
        if max(8, MIN_TOOLBAR * length) <= size <= MAX_TOOLBAR * length:
            chrome[side] = size
            source = frames[-1][y0:y1, x0:x1, :3]
            strip = {"top": source[:size], "bottom": source[-size:],
                     "left": source[:, :size], "right": source[:, -size:]}[side]
            chrome[side + "Edges"] = strip_edges(strip, vertical=side in ("left", "right"))
    return (x0 + chrome["left"], y0 + chrome["top"],
            x1 - chrome["right"], y1 - chrome["bottom"]), chrome


def detect(frames: Sequence[np.ndarray], *, trim_chrome: bool = True) -> RectResult:
    """Input frames are BGR uint8 of identical dimensions; no saved colour is matched."""
    if not frames:
        raise ValueError("At least one frame is required")
    shape = frames[0].shape
    if len(shape) != 3 or shape[2] not in (3, 4) or any(f.shape != shape or f.dtype != np.uint8 for f in frames):
        raise ValueError("Frames must have identical uint8 BGR dimensions")
    height, width = shape[:2]
    scale = min(1.0, COARSE / max(height, width))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    small = np.stack([cv2.resize(f[:, :, :3], size, interpolation=cv2.INTER_NEAREST).astype(np.int16) for f in frames])
    bounds = _peel(small, (0, 0, size[0], size[1]))
    if scale < 1:
        x0, y0, x1, y1 = (round(value / scale) for value in bounds)
        pad = math.ceil(2 / scale) + 2
        sx0, sy0 = max(0, x0 - pad), max(0, y0 - pad)
        sx1, sy1 = min(width, x1 + pad), min(height, y1 + pad)
        stack = np.stack([f[sy0:sy1, sx0:sx1, :3].astype(np.int16) for f in frames])
        rx0, ry0, rx1, ry1 = _peel(stack, (0, 0, sx1 - sx0, sy1 - sy0))
        bounds = (sx0 + rx0, sy0 + ry0, sx0 + rx1, sy0 + ry1)
    chrome: dict[str, Any] = {side: 0 for side in ("top", "bottom", "left", "right")}
    chrome.update({side + "Edges": None for side in ("top", "bottom", "left", "right")})
    if trim_chrome and len(frames) >= 3:
        bounds, chrome = _trim_chrome(frames, bounds)
    x0, y0, x1, y1 = bounds
    rw, rh = x1 - x0, y1 - y0
    if rw < 50 or rh < 50:
        return RectResult(None, 0.0, "too_small", chrome)
    aspect = rw / rh
    return RectResult((x0, y0, rw, rh), aspect,
                      "ok" if ASPECT_MIN <= aspect <= ASPECT_MAX else "aspect_out_of_range", chrome)
