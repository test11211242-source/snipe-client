"""Bounded game rectangle tracking and saved-chrome subtraction (§3.5)."""
from __future__ import annotations

import base64
from typing import Any

import cv2
import numpy as np

from geometry.game_rect import ASPECT_MAX, ASPECT_MIN, RectResult, detect, pixel_rect, _uniform
from geometry.vs_orient_trigger import MAX_SHIFT, orientation_field

ASPECT_TOL = 0.03
DETECT_FRAMES = 20
RECHECK_EVERY = 10
NEEDS_RECAL_FRAMES = 20


def union(left, right):
    x, y = min(left[0], right[0]), min(left[1], right[1])
    return x, y, max(left[0] + left[2], right[0] + right[2]) - x, max(left[1] + left[3], right[1] + right[3]) - y


def outside_uniform(frame: np.ndarray, rect) -> bool:
    x, y, w, h = rect
    # The boundary-adjacent rows/columns are sufficient for the cheap sentinel.
    lines = (frame[y - 1:y, x:x + w] if y else None,
             frame[y + h:y + h + 1, x:x + w] if y + h < frame.shape[0] else None,
             frame[y:y + h, x - 1:x].transpose(1, 0, 2) if x else None,
             frame[y:y + h, x + w:x + w + 1].transpose(1, 0, 2) if x + w < frame.shape[1] else None)
    return all(line is None or _uniform(line.astype(np.int16)) for line in lines)


def chrome_score(strip: np.ndarray, template: dict[str, Any], vertical: bool) -> float:
    if vertical:
        strip = strip.transpose(1, 0, 2)
    width, height = template["length"], template["thickness"]
    resized = cv2.resize(strip, (width, height), interpolation=cv2.INTER_AREA)
    patch = cv2.copyMakeBorder(resized, MAX_SHIFT, MAX_SHIFT, MAX_SHIFT, MAX_SHIFT, cv2.BORDER_REPLICATE)
    fc, fs = orientation_field(patch)
    angle = np.frombuffer(base64.b64decode(template["angleQ8Base64"]), np.uint8).reshape(height, width).astype(np.float32) * (2 * np.pi / 256)
    weight = np.frombuffer(base64.b64decode(template["weightQ8Base64"]), np.uint8).reshape(height, width).astype(np.float32)
    total = float(weight.sum())
    if total <= 0:
        return -1.0
    scores = cv2.matchTemplate(fc, weight * np.cos(angle), cv2.TM_CCORR) + cv2.matchTemplate(fs, weight * np.sin(angle), cv2.TM_CCORR)
    return float(scores.max() / total)


class GameGeometry:
    def __init__(self, layouts: list[dict[str, Any]]):
        self.layouts = layouts
        self.shape = None
        self.rect = None
        self.aspect = None
        self.layout = None
        self.state = "locating"
        self.frames = 0
        self.mismatch_frames = 0
        self.reason = "too_small"
        self.chrome = None
        self.tick = 0
        self._aspect_change_checks = 0
        self._last_event = None
        self._last_event_time = -float("inf")

    def _detect(self, frame):
        result = detect([frame], trim_chrome=False)
        if result.rect is None:
            return result
        best = result
        for layout in self.layouts:
            chrome = layout["windowChrome"]
            x, y, w, h = result.rect
            matched = {}
            for side in ("top", "bottom", "left", "right"):
                size, template = chrome[side], chrome[side + "Edges"]
                if not size or template is None or size >= (h if side in ("top", "bottom") else w):
                    matched[side] = 0
                    continue
                source = frame[y:y + h, x:x + w, :3]
                strip = {"top": source[:size], "bottom": source[-size:], "left": source[:, :size], "right": source[:, -size:]}[side]
                matched[side] = size if chrome_score(strip, template, side in ("left", "right")) >= 0.50 else 0
            nw, nh = w - matched["left"] - matched["right"], h - matched["top"] - matched["bottom"]
            aspect = nw / nh
            if any(matched.values()) and abs(aspect / layout["gameAspect"] - 1) <= ASPECT_TOL:
                return RectResult((x + matched["left"], y + matched["top"], nw, nh), aspect, "ok", chrome)
        return best

    def process(self, frame, now):
        shape = frame.shape[:2]
        self.tick += 1
        if self.shape != shape:
            self.shape, self.rect, self.aspect, self.layout = shape, None, None, None
            self.frames, self.mismatch_frames = 0, 0
            self._aspect_change_checks = 0
            self.state = "locating"
        if self.frames < DETECT_FRAMES or self.tick % RECHECK_EVERY == 0:
            result = self._detect(frame)
            self.reason, self.chrome = result.reason, result.chrome
            if result.rect is None:
                self.rect = None
                self.frames = 0
            else:
                found = result.rect
                restart = self.rect is None
                if self.rect is not None and self.frames >= DETECT_FRAMES:
                    old = self.rect
                    changed_aspect = result.reason == "ok" and abs((found[2] / found[3]) / (old[2] / old[3]) - 1) > ASPECT_TOL
                    self._aspect_change_checks = self._aspect_change_checks + 1 if changed_aspect else 0
                    grew = (found[0] < old[0] - 3 or found[1] < old[1] - 3 or
                            found[0] + found[2] > old[0] + old[2] + 3 or found[1] + found[3] > old[1] + old[3] + 3)
                    shrank = (abs((found[2] / found[3]) / (old[2] / old[3]) - 1) < 0.01 and
                              found[2] < old[2] * 0.97 and found[3] < old[3] * 0.97)
                    restart = grew or shrank or not outside_uniform(frame, old) or self._aspect_change_checks >= 2
                if restart:
                    self.rect, self.frames = found, 1
                    self._aspect_change_checks = 0
                elif self.frames < DETECT_FRAMES:
                    self.rect = union(self.rect, found)
                    self.frames += 1
        if self.rect is None:
            self.aspect, self.layout, self.state = None, None, "no_game"
            self.mismatch_frames += 1
            return
        self.aspect = self.rect[2] / self.rect[3]
        self.reason = "ok" if ASPECT_MIN <= self.aspect <= ASPECT_MAX else "aspect_out_of_range"
        matching = [layout for layout in self.layouts if abs(self.aspect / layout["gameAspect"] - 1) <= ASPECT_TOL]
        self.layout = min(matching, key=lambda layout: abs(self.aspect / layout["gameAspect"] - 1)) if matching else None
        if self.layout is not None and self.reason == "ok":
            self.state = "armed" if self.frames >= DETECT_FRAMES else "armed_provisional"
            self.mismatch_frames = 0
        else:
            self.mismatch_frames += 1
            self.state = "aspect_unknown" if self.mismatch_frames >= NEEDS_RECAL_FRAMES else "aspect_mismatch"

    def event(self, now):
        state = "armed" if self.state == "armed_provisional" else self.state
        snapshot = (state, self.layout["layoutId"] if self.layout else None, self.rect)
        changed = self._last_event is None or snapshot[:2] != self._last_event[:2]
        if not changed and snapshot[2] != self._last_event[2]:
            changed = snapshot[2] is None or self._last_event[2] is None or max(abs(a - b) for a, b in zip(snapshot[2], self._last_event[2])) > 2
        if not changed or now - self._last_event_time < 0.5:
            return None
        self._last_event, self._last_event_time = snapshot, now
        return {"state": state, "frameWidth": self.shape[1], "frameHeight": self.shape[0],
                "gameRect": pixel_rect(self.rect) if self.rect else None, "gameAspect": self.aspect,
                "layoutId": self.layout["layoutId"] if self.layout else None}
