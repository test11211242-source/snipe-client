"""Bounded game rectangle tracking and window-chrome subtraction (§3.5)."""
from __future__ import annotations

import base64
import math
from typing import Any

import cv2
import numpy as np

from geometry.aspect import ASPECT_MAX, ASPECT_MIN, ASPECT_TOL
from geometry.game_rect import COARSE, MAX_TOOLBAR, MIN_TOOLBAR, STATIC_TOL, RectResult, _uniform, detect, pixel_rect
from geometry.vs_orient_trigger import MAX_SHIFT, orientation_field

DETECT_FRAMES = 20
RECHECK_EVERY = 10
NEEDS_RECAL_FRAMES = 20
# Window chrome (an emulator title bar or side toolbar) keeps its pixel
# thickness while the window is resized, but its fixed-size icons move
# relative to its length, so the saved length-normalized template stops
# matching. The band is then inferred from the layout aspect and confirmed by
# the saved thickness or by being static while the game below it moves.
CHROME_HISTORY = 4
CHROME_SPACING = 0.4
CHROME_MOTION = 0.03
CHROME_STATIC = 0.97
CHROME_EDGE = 8


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
        self.raw_rect = None
        self._detected_raw_rect = None
        self.aspect = None
        self.layout = None
        self.state = "locating"
        self.frames = 0
        self.mismatch_frames = 0
        self.reason = "too_small"
        self.chrome = None
        self.tick = 0
        self._aspect_change_checks = 0
        self._missing_checks = 0
        self._last_event = None
        self._last_event_time = -float("inf")
        self._trimmed = False
        self._history: list[tuple[float, np.ndarray]] = []
        self._band = None

    def _remember(self, frame, now):
        if self._history and now - self._history[-1][0] < CHROME_SPACING:
            return
        height, width = frame.shape[:2]
        scale = min(1.0, COARSE / max(height, width))
        size = (max(1, round(width * scale)), max(1, round(height * scale)))
        gray = cv2.cvtColor(cv2.resize(frame[:, :, :3], size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        self._history = (self._history + [(now, gray)])[-CHROME_HISTORY:]

    def _band_static(self, raw, side, size) -> bool:
        """The band stays identical across spaced frames while the game moves."""
        if len(self._history) < 3 or self._history[-1][0] - self._history[0][0] < 0.8:
            return False
        stack = np.stack([gray for _, gray in self._history]).astype(np.int16)
        difference = stack.max(axis=0) - stack.min(axis=0)
        scale = difference.shape[1] / self.shape[1]
        x, y, w, h = raw
        band = {"top": (x, y, w, size), "bottom": (x, y + h - size, w, size),
                "left": (x, y, size, h), "right": (x + w - size, y, size, h)}[side]
        game = {"top": (x, y + size, w, h - size), "bottom": (x, y, w, h - size),
                "left": (x + size, y, w - size, h), "right": (x, y, w - size, h)}[side]

        def inner(rect, quarter=False):
            rx, ry, rw, rh = rect
            if quarter:
                rx, ry, rw, rh = rx + rw / 4, ry + rh / 4, rw / 2, rh / 2
            x0, y0 = math.ceil(rx * scale) + 1, math.ceil(ry * scale) + 1
            x1, y1 = math.floor((rx + rw) * scale) - 1, math.floor((ry + rh) * scale) - 1
            return difference[y0:y1, x0:x1] if x1 > x0 and y1 > y0 else None

        band_diff, game_diff = inner(band), inner(game, quarter=True)
        if band_diff is None or game_diff is None:
            return False
        return (float((game_diff > 30).mean()) >= CHROME_MOTION
                and float((band_diff <= STATIC_TOL).mean()) >= CHROME_STATIC)

    def _infer_band(self, frame, raw, layout):
        """Return (side, absolute game edge) of a chrome band the layout aspect implies."""
        x, y, w, h = raw
        extra_v, extra_h = h - w / layout["gameAspect"], w - h * layout["gameAspect"]
        sides, extra, length = (("top", "bottom"), extra_v, h) if extra_v > 0 else (("left", "right"), extra_h, w)
        if not max(8, MIN_TOOLBAR * length) <= extra <= MAX_TOOLBAR * length:
            return None
        saved = layout["windowChrome"]
        delta = max(3, math.ceil(0.006 * length))
        source = frame[y:y + h, x:x + w, :3].astype(np.int16)
        for side in sorted(sides, key=lambda item: not saved.get(item)):
            lines = source if side in ("top", "bottom") else source.transpose(1, 0, 2)
            if side in ("bottom", "right"):
                lines = lines[::-1]
            # The aspect fixes the thickness to a few pixels; snap to the line
            # step that stands out most from its neighbours there. Chrome
            # content (tab titles, icons) is deliberately not compared: it
            # changes with the window.
            first, last = max(2, round(extra) - 2), min(len(lines) - 2, round(extra) + 2)
            if first > last:
                continue
            steps = np.abs(lines[first - 1:last + 2] - lines[first - 2:last + 1]).max(axis=2).mean(axis=1)
            contrast = steps[1:-1] - (steps[:-2] + steps[2:]) / 2
            index = int(np.argmax(contrast))
            size = first + index
            if steps[index + 1] < CHROME_EDGE or contrast[index] <= 0:
                continue
            if (saved.get(side) and abs(saved[side] - size) <= delta) or self._band_static(raw, side, size):
                edge = {"top": y + size, "bottom": y + h - size, "left": x + size, "right": x + w - size}[side]
                return side, edge
        return None

    def _apply_band(self, raw):
        side, edge = self._band
        x, y, w, h = raw
        rect = {"top": (x, edge, w, y + h - edge), "bottom": (x, y, w, edge - y),
                "left": (edge, y, x + w - edge, h), "right": (x, y, edge - x, h)}[side]
        size = {"top": edge - y, "bottom": y + h - edge, "left": edge - x, "right": x + w - edge}[side]
        length = h if side in ("top", "bottom") else w
        if not 0 < size <= MAX_TOOLBAR * length:
            return None
        chrome: dict[str, Any] = {key: 0 for key in ("top", "bottom", "left", "right")}
        chrome.update({key + "Edges": None for key in ("top", "bottom", "left", "right")})
        chrome[side] = size
        aspect = rect[2] / rect[3]
        return RectResult(rect, aspect, "ok" if ASPECT_MIN <= aspect <= ASPECT_MAX else "aspect_out_of_range", chrome)

    def _detect(self, frame):
        result = detect([frame], trim_chrome=False)
        self._detected_raw_rect = result.rect
        if result.rect is None:
            return result
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
        if self._band is None:
            self._band = next((band for band in (self._infer_band(frame, result.rect, layout) for layout in self.layouts)
                               if band is not None), None)
        if self._band is not None:
            # Chrome is fixed to the window: its game edge stays put while the
            # peeled game bounds vary with dark first/last rows.
            trimmed = self._apply_band(result.rect)
            if trimmed is not None:
                return trimmed
            self._band = None
        return result

    def process(self, frame, now):
        shape = frame.shape[:2]
        self.tick += 1
        if self.shape != shape:
            self.shape, self.rect, self.raw_rect, self.aspect, self.layout = shape, None, None, None, None
            self.frames, self.mismatch_frames = 0, 0
            self._aspect_change_checks = 0
            self._missing_checks = 0
            self._history, self._band = [], None
            self.state = "locating"
        self._remember(frame, now)
        if self.frames < DETECT_FRAMES or self.tick % RECHECK_EVERY == 0:
            result = self._detect(frame)
            if result.rect is None:
                self._aspect_change_checks = 0
                self._missing_checks += 1
                # One dark/loading recheck must not discard established geometry.
                # A second consecutive missing recheck recognizes a vanished game.
                if self.frames < DETECT_FRAMES or self._missing_checks >= 2:
                    self.reason, self.chrome = result.reason, result.chrome
                    self.rect, self.raw_rect, self.frames = None, None, 0
            else:
                self.reason, self.chrome = result.reason, result.chrome
                self._missing_checks = 0
                found = result.rect
                raw_found = self._detected_raw_rect
                trimmed = found != raw_found
                # A newly recognized (or lost) chrome band must not be unioned
                # with or hidden inside the previously tracked rectangle.
                restart = self.rect is None or trimmed != self._trimmed
                if not restart and self.frames >= DETECT_FRAMES:
                    old = self.rect
                    changed_aspect = result.reason == "ok" and abs((found[2] / found[3]) / (old[2] / old[3]) - 1) > ASPECT_TOL
                    self._aspect_change_checks = self._aspect_change_checks + 1 if changed_aspect else 0
                    grew = (found[0] < old[0] - 3 or found[1] < old[1] - 3 or
                            found[0] + found[2] > old[0] + old[2] + 3 or found[1] + found[3] > old[1] + old[3] + 3)
                    shrank = (abs((found[2] / found[3]) / (old[2] / old[3]) - 1) < 0.01 and
                              found[2] < old[2] * 0.97 and found[3] < old[3] * 0.97)
                    # Saved chrome is inside the peeled bounds, not outside the game.
                    restart = grew or shrank or not outside_uniform(frame, self.raw_rect) or self._aspect_change_checks >= 2
                if restart:
                    self.rect, self.raw_rect, self.frames = found, raw_found, 1
                    self._trimmed = trimmed
                    self._aspect_change_checks = 0
                elif self.frames < DETECT_FRAMES:
                    self.rect = union(self.rect, found)
                    self.raw_rect = union(self.raw_rect, raw_found)
                    self.frames += 1
        if self.rect is None:
            self.aspect, self.layout, self.state = None, None, "no_game"
            self.mismatch_frames = 0
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
