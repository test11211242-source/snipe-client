"""Colour-free shape matching for the C3 prediction detectors.

Every comparison uses the doubled-angle edge-orientation field
`(m·cos2θ, m·sin2θ)` of the maximum-gradient channel, with the magnitude
normalised by the crop's own 90th percentile. It ignores hue, brightness and
contrast polarity, so a gold, white or dimmed glyph scores the same.

Geometry is in interface units: `U = min(gameHeight, gameWidth·16/9)` pixels
of the M9 game rectangle (the in-game interface scales with the height down
to 9:16 and with the width below it). Crops are resized to a fixed number of
pixels per unit, so one template serves every capture size.
"""
from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from geometry.vs_orient_trigger import gradient

UI_ASPECT = 9 / 16
FIELD_ALGORITHM = "orient2-q8-v1"
MIN_EDGE = 1e-3


def ui_unit(rect) -> float:
    _, _, width, height = rect
    return float(min(height, width / UI_ASPECT))


def game_center(rect) -> tuple[float, float]:
    x, y, width, height = rect
    return x + width / 2, y + height / 2


def orientation_field(bgr: np.ndarray) -> np.ndarray:
    gx, gy, mag = gradient(bgr)
    angle = 2 * np.arctan2(gy, gx)
    strength = np.minimum(1.0, mag / (0.25 * float(np.percentile(mag, 90)) + MIN_EDGE))
    return np.dstack([strength * np.cos(angle), strength * np.sin(angle)]).astype(np.float32)


@dataclass(frozen=True)
class Crop:
    """A unit-scaled crop and the frame position of its top-left pixel."""
    image: np.ndarray
    x0: float
    y0: float
    px_per_unit: float
    unit: float

    def to_frame(self, x: float, y: float) -> tuple[float, float]:
        scale = self.unit / self.px_per_unit
        return self.x0 + x * scale, self.y0 + y * scale


def crop_units(frame: np.ndarray, rect, origin: tuple[float, float],
               box: tuple[float, float, float, float], px_per_unit: float) -> Crop | None:
    """Crop `box = (dx0, dx1, dy0, dy1)` units around `origin` (frame pixels),
    clipped to the game rectangle, resized to `px_per_unit` pixels per unit."""
    unit = ui_unit(rect)
    gx, gy, gw, gh = rect
    ox, oy = origin
    x0, x1 = max(gx, round(ox + box[0] * unit)), min(gx + gw, round(ox + box[1] * unit))
    y0, y1 = max(gy, round(oy + box[2] * unit)), min(gy + gh, round(oy + box[3] * unit))
    height, width = frame.shape[:2]
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    sub = frame[y0:y1, x0:x1, :3]
    scale = px_per_unit / unit
    size = (max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    return Crop(cv2.resize(sub, size, interpolation=interpolation), x0, y0, px_per_unit, unit)


def _quantize(values: np.ndarray) -> tuple[bytes, bytes]:
    angle = np.arctan2(values[:, :, 1], values[:, :, 0])
    strength = np.hypot(values[:, :, 0], values[:, :, 1])
    angles = (np.rint(np.mod(angle, 2 * np.pi) * (256 / (2 * np.pi))).astype(np.int32) % 256).astype(np.uint8)
    strengths = np.rint(np.clip(strength, 0, 1) * 255).astype(np.uint8)
    return angles.tobytes(), strengths.tobytes()


@dataclass
class ShapeTemplate:
    """A quantised orientation field; carries no pixels or colour."""
    name: str
    values: np.ndarray
    source: dict[str, Any] = field(default_factory=dict)
    _scaled: dict[float, np.ndarray] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def build(cls, bgr: np.ndarray, name: str, *, weight: np.ndarray | None = None,
              source: dict[str, Any] | None = None) -> "ShapeTemplate":
        values = orientation_field(bgr)
        if weight is not None:
            values = values * weight[:, :, None].astype(np.float32)
        return cls.from_values(name, values, source or {})

    @classmethod
    def from_values(cls, name: str, values: np.ndarray, source: dict[str, Any]) -> "ShapeTemplate":
        # Round-trip through the stored form so runtime and authoring agree.
        return cls.from_dict(cls(name, values, source).to_dict())

    @property
    def size(self) -> tuple[int, int]:
        height, width = self.values.shape[:2]
        return width, height

    def scaled(self, scale: float) -> np.ndarray:
        key = round(scale, 4)
        if key not in self._scaled:
            width, height = self.size
            size = (max(3, round(width * scale)), max(3, round(height * scale)))
            self._scaled[key] = (self.values if key == 1.0 else
                                 cv2.resize(self.values, size, interpolation=cv2.INTER_LINEAR))
        return self._scaled[key]

    def to_dict(self) -> dict[str, Any]:
        width, height = self.size
        angles, strengths = _quantize(self.values)
        digest = hashlib.sha256(width.to_bytes(2, "big") + height.to_bytes(2, "big") + angles + strengths).hexdigest()[:16]
        return {"name": self.name, "algorithm": FIELD_ALGORITHM, "width": width, "height": height,
                "angleQ8Base64": base64.b64encode(angles).decode("ascii"),
                "strengthQ8Base64": base64.b64encode(strengths).decode("ascii"),
                "templateHash64": digest, "source": self.source}

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ShapeTemplate":
        if value.get("algorithm") != FIELD_ALGORITHM:
            raise ValueError("Unsupported shape template")
        width, height = int(value["width"]), int(value["height"])
        if not (3 <= width <= 512 and 3 <= height <= 512):
            raise ValueError("Invalid shape template size")
        angles = np.frombuffer(base64.b64decode(value["angleQ8Base64"], validate=True), np.uint8)
        strengths = np.frombuffer(base64.b64decode(value["strengthQ8Base64"], validate=True), np.uint8)
        if angles.size != width * height or strengths.size != width * height:
            raise ValueError("Shape template size mismatch")
        angle = angles.reshape(height, width).astype(np.float32) * (2 * np.pi / 256)
        strength = strengths.reshape(height, width).astype(np.float32) / 255
        template = cls(value["name"], np.dstack([strength * np.cos(angle), strength * np.sin(angle)]).astype(np.float32),
                       dict(value.get("source", {})))
        digest = hashlib.sha256(width.to_bytes(2, "big") + height.to_bytes(2, "big") + angles.tobytes()
                                + strengths.tobytes()).hexdigest()[:16]
        if digest != value["templateHash64"]:
            raise ValueError("Shape template hash mismatch")
        return template


@dataclass(frozen=True)
class Match:
    score: float
    x: float          # template centre in crop pixels
    y: float
    scale: float
    width: float      # matched template size in crop pixels
    height: float


NO_MATCH = Match(-1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def best_match(values: np.ndarray, template: ShapeTemplate, scales=(1.0,)) -> Match:
    """Best `TM_CCOEFF_NORMED` position over the scales; -1 if nothing fits."""
    best = NO_MATCH
    for scale in scales:
        scaled = template.scaled(scale)
        height, width = scaled.shape[:2]
        if height > values.shape[0] or width > values.shape[1]:
            continue
        result = cv2.matchTemplate(values, scaled, cv2.TM_CCOEFF_NORMED)
        _, score, _, location = cv2.minMaxLoc(result)
        if np.isfinite(score) and score > best.score:
            best = Match(float(score), location[0] + width / 2, location[1] + height / 2, scale, width, height)
    return best
