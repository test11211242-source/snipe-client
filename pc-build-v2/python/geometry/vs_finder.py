"""Colour-free coarse/fine VS search and three-frame confirmation (§3.2)."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from geometry.game_rect import PixelRect
from geometry.vs_orient_trigger import gradient, orientation_field
from geometry.zones import Badge

NORM_W = 360
NORM_C = 160
BAND_X = (0.15, 0.85)
BAND_Y = (0.15, 0.80)
SCALES = tuple(round(0.14 + index * 0.01, 2) for index in range(17))
MATCH_T = 0.68
EMPTY_T = 0.45
CONFIRM_N = 3
EXPECTED_K = (0.16, 0.26)
MARGIN = 0.12
HISTORY_FRAMES = 30
ASSET_DIR = Path(__file__).resolve().parent.parent / "assets"
BADGE_WIDTH = 132
BADGE_HEIGHT = 159


@dataclass(frozen=True)
class Candidate:
    score: float
    k: float
    badge: Badge

    @property
    def cx(self) -> float:
        return self.badge.cx

    @property
    def cy(self) -> float:
        return self.badge.cy


@dataclass(frozen=True)
class _Template:
    k: float
    tc: np.ndarray
    ts: np.ndarray
    weight_sum: float
    width: int
    height: int


@lru_cache(maxsize=1)
def _assets() -> tuple[np.ndarray, np.ndarray]:
    image = cv2.imdecode(np.fromfile(ASSET_DIR / "vs_badge_v1.png", dtype=np.uint8), cv2.IMREAD_COLOR)
    mask = cv2.imdecode(np.fromfile(ASSET_DIR / "vs_badge_v1_mask.png", dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None or mask is None or image.shape[:2] != mask.shape:
        raise ValueError("VS badge assets are missing or invalid")
    return image, cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=2)


@lru_cache(maxsize=34)
def _template(k: float, norm: int) -> _Template:
    image, mask = _assets()
    bw = max(8, round(k * norm))
    scale = bw / BADGE_WIDTH
    size = (max(8, round(image.shape[1] * scale)), max(8, round(image.shape[0] * scale)))
    crop = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    inside = cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST) > 0
    gx, gy, mag = gradient(crop)
    weight = (mag * (inside & (mag >= np.percentile(mag[inside], 60)))).astype(np.float32)
    angle = 2 * np.arctan2(gy, gx)
    return _Template(k, (weight * np.cos(angle)).astype(np.float32), (weight * np.sin(angle)).astype(np.float32),
                     float(weight.sum()), bw, round(BADGE_HEIGHT * scale))


def normalize_game(frame: np.ndarray, rect: PixelRect, width: int = NORM_W) -> np.ndarray:
    x, y, rw, rh = rect
    return cv2.resize(frame[y:y + rh, x:x + rw, :3], (width, round(rh * width / rw)), interpolation=cv2.INTER_AREA)


def _score_map(fc: np.ndarray, fs: np.ndarray, template: _Template) -> np.ndarray:
    return (cv2.matchTemplate(fc, template.tc, cv2.TM_CCORR)
            + cv2.matchTemplate(fs, template.ts, cv2.TM_CCORR)) / template.weight_sum


def _peak(fc: np.ndarray, fs: np.ndarray, template: _Template, x0: int, y0: int,
          norm: int, nh: int, rect: PixelRect, region: PixelRect | None) -> tuple[float, tuple[int, int]]:
    scores = _score_map(fc, fs, template)
    if region is not None:
        gx, gy, gw, gh = rect
        rx, ry, rw, rh = region
        left, right = (rx - 0.1 * rw - gx) * norm / gw, (rx + 1.1 * rw - gx) * norm / gw
        top, bottom = (ry - 0.1 * rh - gy) * nh / gh, (ry + 1.1 * rh - gy) * nh / gh
        th, tw = template.tc.shape
        cx = np.arange(scores.shape[1]) + x0 + tw / 2
        cy = np.arange(scores.shape[0]) + y0 + th / 2
        ix = np.maximum(0, np.minimum(cx + template.width / 2, right) - np.maximum(cx - template.width / 2, left))
        iy = np.maximum(0, np.minimum(cy + template.height / 2, bottom) - np.maximum(cy - template.height / 2, top))
        scores[iy[:, None] * ix[None, :] < 0.70 * template.width * template.height] = -1
    _, score, _, location = cv2.minMaxLoc(scores)
    return float(score), location


def search(frame: np.ndarray, rect: PixelRect, *, region: PixelRect | None = None) -> Candidate | None:
    small = normalize_game(frame, rect, NORM_C)
    nh_c = small.shape[0]
    bx0, bx1 = (int(v * NORM_C) for v in BAND_X)
    by0, by1 = (int(v * nh_c) for v in BAND_Y)
    fc, fs = orientation_field(small[by0:by1, bx0:bx1])
    peaks: list[tuple[float, float, float, float]] = []
    for k in SCALES:
        template = _template(k, NORM_C)
        th, tw = template.tc.shape
        if th >= fc.shape[0] or tw >= fc.shape[1]:
            continue
        score, (lx, ly) = _peak(fc, fs, template, bx0, by0, NORM_C, nh_c, rect, region)
        peaks.append((score, k, (bx0 + lx + tw / 2) / NORM_C, (by0 + ly + th / 2) / nh_c))
    chosen: list[tuple[float, float, float, float]] = []
    for peak in sorted(peaks, reverse=True):
        if all(abs(peak[2] - other[2]) > 0.05 or abs(peak[3] - other[3]) > 0.03 for other in chosen):
            chosen.append(peak)
        if len(chosen) == 2:
            break
    if not chosen:
        return None
    game = normalize_game(frame, rect)
    nh = game.shape[0]
    best = None
    for _, k0, cx, cy in chosen:
        templates = [_template(k, NORM_W) for k in SCALES if abs(k - k0) <= 0.025 + 1e-9]
        big = max(templates, key=lambda t: t.tc.shape[1])
        half_w, half_h = big.tc.shape[1] / 2 + 8, big.tc.shape[0] / 2 + 8
        x0, y0 = max(0, int(cx * NORM_W - half_w)), max(0, int(cy * nh - half_h))
        x1, y1 = min(NORM_W, int(cx * NORM_W + half_w) + 1), min(nh, int(cy * nh + half_h) + 1)
        fc, fs = orientation_field(game[y0:y1, x0:x1])
        for template in templates:
            th, tw = template.tc.shape
            if th >= fc.shape[0] or tw >= fc.shape[1]:
                continue
            score, (lx, ly) = _peak(fc, fs, template, x0, y0, NORM_W, nh, rect, region)
            if best is None or score > best.score:
                best = Candidate(float(score), template.k, Badge((x0 + lx + tw / 2) / NORM_W,
                                 (y0 + ly + th / 2) / nh, template.width / NORM_W, template.height / nh))
    return best


def score_at_game(game: np.ndarray, candidate: Candidate) -> float:
    template = _template(candidate.k, NORM_W)
    th, tw = template.tc.shape
    x, y = round(candidate.cx * NORM_W - tw / 2), round(candidate.cy * game.shape[0] - th / 2)
    window = game[max(0, y - 3):y + th + 3, max(0, x - 3):x + tw + 3]
    if window.shape[0] < th or window.shape[1] < tw:
        return -1.0
    fc, fs = orientation_field(window)
    return float(_score_map(fc, fs, template).max())


class VSConfirmer:
    """A bounded ring excludes the current consecutive candidate series from empty checks."""

    def __init__(self, history_frames: int = HISTORY_FRAMES) -> None:
        self._history: deque[tuple[int, np.ndarray]] = deque(maxlen=history_frames)
        self._run: list[tuple[int, Candidate]] = []
        self._sequence = 0
        self._shape: tuple[int, ...] | None = None

    def update(self, frame: np.ndarray, rect: PixelRect, candidate: Candidate | None) -> bool:
        game = normalize_game(frame, rect)
        if self._shape != game.shape:
            self._history.clear()
            self._run.clear()
            self._shape = game.shape
        self._sequence += 1
        if candidate is None or candidate.score < MATCH_T:
            self._run.clear()
        else:
            if self._run:
                previous = self._run[-1][1]
                if not (abs(candidate.cx - previous.cx) <= 0.02 and abs(candidate.cy - previous.cy) <= 0.012
                        and abs(candidate.k - previous.k) <= 0.011):
                    self._run.clear()
            self._run.append((self._sequence, candidate))
        confirmed = False
        if len(self._run) >= CONFIRM_N and candidate is not None:
            start = self._run[0][0]
            confirmed = EXPECTED_K[0] <= candidate.k <= EXPECTED_K[1] and any(
                score_at_game(previous, candidate) < EMPTY_T for sequence, previous in self._history if sequence < start)
            if not confirmed:
                self._run.pop(0)
        self._history.append((self._sequence, game))
        return confirmed
