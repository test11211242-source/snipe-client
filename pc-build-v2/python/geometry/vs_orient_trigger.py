"""Rule (c): polarity-invariant maximum-channel edge directions in the VS silhouette."""
from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from geometry.game_rect import PixelRect
from geometry.zones import Badge

ALGORITHM = "vs-orient-1"
NW = 96
P = 4
CROP_MARGIN = 0.08
MAX_SHIFT = 3
ORIENT_T = 0.50


def gradient(bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    # Blur uint8 before converting, as in the measured reference implementation.
    blurred = cv2.GaussianBlur(bgr[:, :, :3], (0, 0), 1.0).astype(np.float32)
    gx = np.stack([cv2.Scharr(blurred[:, :, c], cv2.CV_32F, 1, 0) for c in range(3)])
    gy = np.stack([cv2.Scharr(blurred[:, :, c], cv2.CV_32F, 0, 1) for c in range(3)])
    squared = gx * gx + gy * gy
    index = np.argmax(squared, axis=0)[None]
    return (np.take_along_axis(gx, index, 0)[0], np.take_along_axis(gy, index, 0)[0],
            np.sqrt(np.take_along_axis(squared, index, 0)[0]))


def orientation_field(bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    gx, gy, mag = gradient(bgr)
    angle = 2 * np.arctan2(gy, gx)
    strength = np.minimum(1.0, mag / (0.25 * float(np.percentile(mag, 90)) + 1e-3))
    return (strength * np.cos(angle)).astype(np.float32), (strength * np.sin(angle)).astype(np.float32)


def silhouette(core: np.ndarray) -> tuple[np.ndarray, bool]:
    _, _, mag = gradient(core)
    edges = (mag >= np.percentile(mag, 72)).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)
    height, width = edges.shape
    filled = edges.copy()
    for x, y in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        if filled[y, x] == 0:
            cv2.floodFill(filled, np.zeros((height + 2, width + 2), np.uint8), (x, y), 128)
    count, labels, stats, _ = cv2.connectedComponentsWithStats((filled != 128).astype(np.uint8))
    label = int(labels[height // 2, width // 2])
    contains_center = label != 0
    if label == 0:
        if count <= 1:
            return np.zeros((height, width), np.uint8), False
        label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (labels == label).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    return mask, contains_center and bool(mask[height // 2, width // 2])


def crop_geometry(badge: Badge, rect: PixelRect) -> tuple[tuple[float, float, float, float], tuple[int, int]]:
    gx, gy, gw, gh = rect
    bw = badge.width * gw * (1 + 2 * CROP_MARGIN)
    bh = badge.height * gh + 2 * CROP_MARGIN * badge.width * gw
    height = round(NW * bh / bw)
    if not 64 <= height <= 160:
        raise ValueError("Badge crop height is outside 64..160")
    cx, cy = gx + badge.cx * gw, gy + badge.cy * gh
    padding = P * bw / NW
    return (cx - bw / 2 - padding, cy - bh / 2 - padding, bw + 2 * padding, bh + 2 * padding), (NW, height)


def extract(frame: np.ndarray, badge: Badge, rect: PixelRect, *, normalized_size: tuple[int, int] | None = None) -> np.ndarray:
    (x, y, width, height), size = crop_geometry(badge, rect)
    nw, nh = normalized_size or size
    x0, y0, x1, y1 = round(x), round(y), round(x + width), round(y + height)
    ih, iw = frame.shape[:2]
    sub = frame[max(0, y0):min(ih, y1), max(0, x0):min(iw, x1), :3]
    if sub.size == 0:
        raise ValueError("Badge crop does not intersect the frame")
    borders = max(0, -y0), max(0, y1 - ih), max(0, -x0), max(0, x1 - iw)
    if any(borders):
        sub = cv2.copyMakeBorder(sub, *borders, cv2.BORDER_REPLICATE)
    out = (nw + 2 * P, nh + 2 * P)
    interpolation = cv2.INTER_AREA if sub.shape[1] > out[0] else cv2.INTER_LINEAR
    return cv2.resize(sub, out, interpolation=interpolation)


def _quantize(angle: np.ndarray, weight: np.ndarray) -> tuple[bytes, bytes]:
    angles = (np.rint(np.mod(angle, 2 * np.pi) * (256 / (2 * np.pi))).astype(np.int32) % 256).astype(np.uint8)
    maximum = float(weight.max())
    weights = np.rint(weight * (255 / maximum)).astype(np.uint8) if maximum > 0 else np.zeros_like(angles)
    return angles.tobytes(), weights.tobytes()


@dataclass
class OrientationTrigger:
    badge: Badge
    cos2: np.ndarray
    sin2: np.ndarray
    weight: np.ndarray
    mask_area_ratio: float
    contains_center: bool

    @classmethod
    def build(cls, frame: np.ndarray, rect: PixelRect, badge: Badge) -> "OrientationTrigger":
        patch = extract(frame, badge, rect)
        core = patch[P:-P, P:-P]
        mask, contains_center = silhouette(core)
        expanded = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=2) > 0
        gx, gy, mag = gradient(core)
        selected = expanded & (mag >= np.percentile(mag[expanded], 60)) if expanded.any() else expanded
        angle = 2 * np.arctan2(gy, gx)
        return cls(badge, np.cos(angle), np.sin(angle), (mag * selected).astype(np.float32),
                   float((mask > 0).mean()), contains_center)

    def score_patch(self, patch: np.ndarray) -> float:
        height, width = self.weight.shape
        if patch.shape[:2] != (height + 2 * P, width + 2 * P):
            raise ValueError("Trigger patch dimensions do not match the template")
        total = float(self.weight.sum())
        if total <= 0:
            return -1.0
        fc, fs = orientation_field(patch)
        tc, ts = (self.weight * self.cos2).astype(np.float32), (self.weight * self.sin2).astype(np.float32)
        scores = cv2.matchTemplate(fc, tc, cv2.TM_CCORR) + cv2.matchTemplate(fs, ts, cv2.TM_CCORR)
        # P=4 but the accepted displacement is only ±3, not ±4.
        return float(np.clip(scores[P - MAX_SHIFT:P + MAX_SHIFT + 1, P - MAX_SHIFT:P + MAX_SHIFT + 1].max() / total, -1, 1))

    def score(self, frame: np.ndarray, rect: PixelRect) -> float:
        height, width = self.weight.shape
        return self.score_patch(extract(frame, self.badge, rect, normalized_size=(width, height)))

    def to_dict(self) -> dict[str, Any]:
        angle = np.arctan2(self.sin2, self.cos2)
        angles, weights = _quantize(angle, self.weight)
        height, width = self.weight.shape
        digest = hashlib.sha256(width.to_bytes(2, "big") + height.to_bytes(2, "big") + angles + weights).hexdigest()[:16]
        return {"kind": "vs_edge_orientation", "algorithm": ALGORITHM, "badge": self.badge.to_dict(),
                "normalizedSize": {"width": width, "height": height}, "cropMargin": CROP_MARGIN,
                "padding": P, "maxShift": MAX_SHIFT, "threshold": ORIENT_T,
                "angleQ8Base64": base64.b64encode(angles).decode("ascii"),
                "weightQ8Base64": base64.b64encode(weights).decode("ascii"),
                "templateHash64": digest, "maskAreaRatio": self.mask_area_ratio}

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "OrientationTrigger":
        if value["algorithm"] != ALGORITHM or value["kind"] != "vs_edge_orientation":
            raise ValueError("Unsupported orientation trigger")
        width, height = value["normalizedSize"]["width"], value["normalizedSize"]["height"]
        if width != NW or not 64 <= height <= 160:
            raise ValueError("Invalid normalized trigger size")
        angles = np.frombuffer(base64.b64decode(value["angleQ8Base64"], validate=True), np.uint8).reshape(height, width)
        weights = np.frombuffer(base64.b64decode(value["weightQ8Base64"], validate=True), np.uint8).reshape(height, width).astype(np.float32)
        angle = angles.astype(np.float32) * (2 * np.pi / 256)
        trigger = cls(Badge(**value["badge"]), np.cos(angle), np.sin(angle), weights, value["maskAreaRatio"], True)
        if trigger.to_dict()["templateHash64"] != value["templateHash64"]:
            raise ValueError("Trigger template hash mismatch")
        return trigger


def strip_edges(strip: np.ndarray, *, vertical: bool = False) -> dict[str, Any]:
    """Normalize chrome along its long axis; never retain its colour."""
    if vertical:
        strip = np.transpose(strip, (1, 0, 2))
    height = max(1, min(256, round(strip.shape[0] * 256 / strip.shape[1])))
    resized = cv2.resize(strip, (256, height), interpolation=cv2.INTER_AREA)
    gx, gy, mag = gradient(resized)
    weight = mag * (mag >= np.percentile(mag, 60))
    angles, weights = _quantize(2 * np.arctan2(gy, gx), weight)
    return {"length": 256, "thickness": height,
            "angleQ8Base64": base64.b64encode(angles).decode("ascii"),
            "weightQ8Base64": base64.b64encode(weights).decode("ascii")}
