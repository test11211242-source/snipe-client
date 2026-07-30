"""Pure trigger matching and bounded action-image preparation."""

from __future__ import annotations

import base64
import binascii
import math
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from analyze_trigger import ANALYZER_VERSION, structural_maps
from monitor_protocol import MonitorProtocolError, validate_ratio
from trigger_matching import create_orb, create_orb_matcher, score_orb_alignment

NORMALIZED_SIZE = 128


def ratio_rect(ratio: dict[str, float], frame_width: int, frame_height: int, parent=None):
    if parent is None:
        base_x, base_y, base_width, base_height = 0, 0, frame_width, frame_height
    else:
        base_x, base_y, base_width, base_height = parent
    x = base_x + int(round(ratio["x"] * base_width))
    y = base_y + int(round(ratio["y"] * base_height))
    right = base_x + int(round((ratio["x"] + ratio["width"]) * base_width))
    bottom = base_y + int(round((ratio["y"] + ratio["height"]) * base_height))
    x = min(max(base_x, x), base_x + base_width - 1)
    y = min(max(base_y, y), base_y + base_height - 1)
    right = min(max(x + 1, right), base_x + base_width)
    bottom = min(max(y + 1, bottom), base_y + base_height)
    width = right - x
    height = bottom - y
    if x < 0 or y < 0 or right > frame_width or bottom > frame_height:
        raise RuntimeError("configured region exceeds the current source frame")
    return x, y, width, height


def crop(image: np.ndarray, rect):
    x, y, width, height = rect
    return image[y : y + height, x : x + width]


def ensure_bgr(image: np.ndarray) -> np.ndarray:
    if not isinstance(image, np.ndarray) or image.ndim != 3 or image.shape[2] not in (3, 4):
        raise RuntimeError("capture frame format is invalid")
    return image[:, :, :3]


class TriggerProfile:
    def __init__(self, value: Any):
        required = {
            "schemaVersion",
            "analyzer",
            "innerRect",
            "structureAlgorithm",
            "structureHash64",
            "matcherMode",
            "normalizedTemplateSize",
            "structureTemplateBase64",
            "edgeTemplateBase64",
            "orientationTemplateBase64",
            "quality",
        }
        if not isinstance(value, dict) or set(value) != required:
            raise MonitorProtocolError("trigger profile fields are invalid")
        analyzer = value["analyzer"]
        if (
            not isinstance(analyzer, dict)
            or set(analyzer) != {"name", "version"}
            or analyzer["name"] != "cr-tools-trigger-analyzer"
            or not isinstance(analyzer["version"], str)
        ):
            raise MonitorProtocolError("trigger analyzer is invalid")
        if analyzer["version"] != ANALYZER_VERSION:
            raise MonitorProtocolError("trigger profile must be re-analyzed")
        if value["schemaVersion"] != 3 or value["structureAlgorithm"] != "max-channel-scharr-v1":
            raise MonitorProtocolError("trigger profile version is invalid")
        structure_hash = value["structureHash64"]
        if not isinstance(structure_hash, str) or len(structure_hash) != 16:
            raise MonitorProtocolError("trigger structure hash is invalid")
        try:
            int(structure_hash, 16)
        except ValueError as error:
            raise MonitorProtocolError("trigger structure hash is invalid") from error
        self.inner_ratio = validate_ratio(value["innerRect"], "trigger inner rect")
        self.matcher_mode = value["matcherMode"]
        if self.matcher_mode not in ("edge", "edge_orb"):
            raise MonitorProtocolError("trigger matcher mode is invalid")
        size = value["normalizedTemplateSize"]
        if size != {"width": NORMALIZED_SIZE, "height": NORMALIZED_SIZE}:
            raise MonitorProtocolError("trigger normalized size must be 128x128")
        self.template_structure = _decode_template(
            value["structureTemplateBase64"], "structure"
        )
        self.template_edges = _decode_template(value["edgeTemplateBase64"], "edge")
        self.template_orientation = _decode_template(
            value["orientationTemplateBase64"], "orientation"
        )
        self.template_edges = np.where(self.template_edges > 0, 255, 0).astype(np.uint8)
        quality = value["quality"]
        if not isinstance(quality, dict) or set(quality) != {
            "grade",
            "score",
            "edgePixelCount",
            "edgeCoverage",
            "keypointsCount",
            "cropConfidence",
            "cropAreaRatio",
        }:
            raise MonitorProtocolError("trigger quality fields are invalid")
        self.quality_grade = quality["grade"]
        if self.quality_grade not in ("high", "medium"):
            raise MonitorProtocolError("trigger quality grade is invalid")
        _bounded_float(quality["score"], 0, 1, "trigger quality score")
        _bounded_int(quality["edgePixelCount"], 1, NORMALIZED_SIZE**2, "edge count")
        _bounded_float(quality["edgeCoverage"], 0, 1, "edge coverage")
        _bounded_int(quality["keypointsCount"], 0, 10000, "keypoints count")
        _bounded_float(quality["cropConfidence"], 0, 1, "crop confidence")
        _bounded_float(quality["cropAreaRatio"], 0.000001, 1, "crop area ratio")
        self.template_weights = np.maximum(
            self.template_structure.astype(np.float32) / 255.0, 0.2
        )
        self.template_edge_mask = self.template_edges > 0
        if int(np.count_nonzero(self.template_edge_mask)) < 80:
            raise MonitorProtocolError("trigger template has insufficient structure")
        self.template_orientation_descriptor = _orientation_descriptor(
            self.template_edges,
            self.template_orientation,
            self.template_structure,
        )
        self.template_edge_neighborhood = cv2.dilate(
            self.template_edges, np.ones((5, 5), np.uint8)
        )
        self.template_correlation_mask = cv2.dilate(
            self.template_edges, np.ones((7, 7), np.uint8)
        ) > 0
        self.orb = create_orb()
        self.matcher = create_orb_matcher()
        self.template_keypoints, self.template_descriptors = self.orb.detectAndCompute(
            self.template_structure, None
        )

    def evaluate(self, image: np.ndarray) -> "MatchResult":
        structure, edges, orientation = structural_maps(
            image, (NORMALIZED_SIZE, NORMALIZED_SIZE)
        )
        best: MatchResult | None = None
        best_maps: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
        transforms = [(1.0, x, y) for x in (-3, 0, 3) for y in (-3, 0, 3)]
        transforms.extend(((0.97, 0, 0), (1.03, 0, 0)))
        for scale, offset_x, offset_y in transforms:
            candidate = _transform_maps(
                structure, edges, orientation, scale, offset_x, offset_y
            )
            result = self._score_structure(*candidate)
            if best is None or result.score > best.score:
                best = result
                best_maps = candidate
        if best is None or best_maps is None:
            return MatchResult(False, 0.0, 0.0, 0.0, 0.0, 0, "no_candidate")

        orb_inliers = 0
        orb_score = 0.0
        orb_viable = False
        if self.matcher_mode == "edge_orb":
            alignment = score_orb_alignment(
                self.template_keypoints,
                self.template_descriptors,
                best_maps[0],
                orb=self.orb,
                matcher=self.matcher,
            )
            orb_inliers = alignment.inliers
            orb_score = alignment.score
            orb_viable = alignment.viable
        support_floor = 0.62 if self.quality_grade == "high" else 0.66
        score_floor = 0.69 if self.quality_grade == "high" else 0.73
        if self.matcher_mode == "edge_orb" and orb_viable:
            final_score = min(1.0, best.score * 0.85 + orb_score * 0.15)
            matched = best.support >= support_floor and final_score >= score_floor
        elif self.matcher_mode == "edge_orb":
            final_score = best.score
            matched = False
        else:
            final_score = best.score
            matched = best.support >= support_floor and final_score >= score_floor
        return MatchResult(
            matched,
            final_score,
            best.support,
            best.orientation,
            best.correlation,
            orb_inliers,
            "pass" if matched else "structure_below_threshold",
        )

    def matches(self, image: np.ndarray) -> bool:
        return self.evaluate(image).matched

    def _score_structure(
        self, structure: np.ndarray, edges: np.ndarray, orientation: np.ndarray
    ) -> "MatchResult":
        candidate_edges = edges > 0
        distance = cv2.distanceTransform(
            np.where(candidate_edges, 0, 1).astype(np.uint8), cv2.DIST_L2, 3
        )
        support_values = np.exp(-np.square(distance[self.template_edge_mask] / 2.2))
        weights = self.template_weights[self.template_edge_mask]
        support = float(np.average(support_values, weights=weights))
        relevant_candidate = np.where(
            self.template_edge_neighborhood > 0, edges, 0
        ).astype(np.uint8)
        candidate_descriptor = _orientation_descriptor(
            relevant_candidate, orientation, structure
        )
        orientation_score = float(
            np.clip(
                np.dot(self.template_orientation_descriptor, candidate_descriptor), 0, 1
            )
        )
        correlation = _masked_correlation(
            self.template_structure.astype(np.float32),
            structure.astype(np.float32),
            self.template_correlation_mask,
        )
        score = 0.58 * support + 0.27 * orientation_score + 0.15 * max(0.0, correlation)
        return MatchResult(
            False, score, support, orientation_score, correlation, 0, "scored"
        )


@dataclass(frozen=True)
class MatchResult:
    matched: bool
    score: float
    support: float
    orientation: float
    correlation: float
    orb_inliers: int
    reason: str


def _decode_template(encoded: Any, name: str) -> np.ndarray:
    if not isinstance(encoded, str) or not 1 <= len(encoded) <= 32 * 1024:
        raise MonitorProtocolError(f"trigger {name} template is invalid")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise MonitorProtocolError(f"trigger {name} template encoding is invalid") from error
    template = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if template is None or template.shape != (NORMALIZED_SIZE, NORMALIZED_SIZE):
        raise MonitorProtocolError(f"trigger {name} template image is invalid")
    return template


def _transform_maps(
    structure: np.ndarray,
    edges: np.ndarray,
    orientation: np.ndarray,
    scale: float,
    offset_x: int,
    offset_y: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    center = (NORMALIZED_SIZE - 1) / 2.0
    matrix = np.array(
        [
            [scale, 0.0, offset_x + center * (1.0 - scale)],
            [0.0, scale, offset_y + center * (1.0 - scale)],
        ],
        dtype=np.float32,
    )
    linear = cv2.warpAffine(
        structure, matrix, (NORMALIZED_SIZE, NORMALIZED_SIZE), flags=cv2.INTER_LINEAR
    )
    edge = cv2.warpAffine(
        edges, matrix, (NORMALIZED_SIZE, NORMALIZED_SIZE), flags=cv2.INTER_NEAREST
    )
    angle = cv2.warpAffine(
        orientation, matrix, (NORMALIZED_SIZE, NORMALIZED_SIZE), flags=cv2.INTER_NEAREST
    )
    return linear, edge, angle


def _orientation_descriptor(
    edges: np.ndarray, orientation: np.ndarray, weights: np.ndarray
) -> np.ndarray:
    descriptor = np.zeros((4, 4, 9), dtype=np.float32)
    for row in range(4):
        for column in range(4):
            row_slice = slice(row * 32, (row + 1) * 32)
            column_slice = slice(column * 32, (column + 1) * 32)
            mask = edges[row_slice, column_slice] > 0
            if not np.any(mask):
                continue
            angles = orientation[row_slice, column_slice][mask].astype(np.float32)
            values = weights[row_slice, column_slice][mask].astype(np.float32) / 255.0
            bins = np.minimum(8, (angles / 20.0).astype(np.int32))
            descriptor[row, column] = np.bincount(bins, weights=values, minlength=9)
    flattened = descriptor.reshape(-1)
    norm = float(np.linalg.norm(flattened))
    return flattened / norm if norm > 0 else flattened


def _masked_correlation(left: np.ndarray, right: np.ndarray, mask: np.ndarray) -> float:
    left_values = left[mask]
    right_values = right[mask]
    left_values = left_values - float(left_values.mean())
    right_values = right_values - float(right_values.mean())
    denominator = float(np.linalg.norm(left_values) * np.linalg.norm(right_values))
    if denominator <= 1e-6:
        return 0.0
    return float(np.clip(np.dot(left_values, right_values) / denominator, -1, 1))


class TemporalGate:
    def __init__(self, confirmations_needed: int, cooldown_seconds: float):
        self.confirmations_needed = confirmations_needed
        self.cooldown_seconds = cooldown_seconds
        self.confirmations = 0
        self.release_frames = 0
        self.armed = True
        self.last_trigger_time = -math.inf

    def observe(self, matched: bool, now: float) -> bool:
        if not matched:
            self.confirmations = 0
            if not self.armed:
                self.release_frames += 1
                if self.release_frames >= 2:
                    self.armed = True
            return False
        self.release_frames = 0
        if not self.armed or now - self.last_trigger_time < self.cooldown_seconds:
            self.confirmations = 0
            return False
        self.confirmations += 1
        if self.confirmations < self.confirmations_needed:
            return False
        self.confirmations = 0
        self.armed = False
        self.last_trigger_time = now
        return True


def _bounded_int(value: Any, minimum: int, maximum: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise MonitorProtocolError(f"{name} is invalid")
    return value


def _bounded_float(value: Any, minimum: float, maximum: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise MonitorProtocolError(f"{name} is invalid")
    result = float(value)
    if not minimum <= result <= maximum:
        raise MonitorProtocolError(f"{name} is invalid")
    return result


def encode_action_png(image: np.ndarray, limits: dict[str, Any]) -> tuple[bytes, int, int]:
    bgr = ensure_bgr(image)
    height, width = bgr.shape[:2]
    scale = min(
        1.0,
        limits["maxImageWidth"] / width,
        limits["maxImageHeight"] / height,
        math.sqrt(limits["maxImagePixels"] / (width * height)),
    )
    if scale < 1.0:
        width = max(1, int(width * scale))
        height = max(1, int(height * scale))
        bgr = cv2.resize(bgr, (width, height), interpolation=cv2.INTER_AREA)
    source = bgr
    max_bytes = limits["maxImageBytes"]
    upper_scale = 1.0
    lower_scale = 0.0
    best: tuple[bytes, int, int] | None = None
    candidate_scale = 1.0
    for _ in range(8):
        candidate_width = max(1, int(width * candidate_scale))
        candidate_height = max(1, int(height * candidate_scale))
        candidate = (
            source
            if candidate_width == width and candidate_height == height
            else cv2.resize(
                source,
                (candidate_width, candidate_height),
                interpolation=cv2.INTER_AREA,
            )
        )
        ok, encoded = cv2.imencode(
            ".png", candidate, [cv2.IMWRITE_PNG_COMPRESSION, 9]
        )
        if not ok:
            raise RuntimeError("action image could not be encoded")
        output = encoded.tobytes()
        if not output:
            raise RuntimeError("action image could not be encoded")
        if len(output) <= max_bytes:
            best = (output, candidate_width, candidate_height)
            lower_scale = candidate_scale
            if len(output) >= int(max_bytes * 0.98) or upper_scale - lower_scale < 0.005:
                break
            candidate_scale = (lower_scale + upper_scale) / 2.0
        else:
            upper_scale = candidate_scale
            if lower_scale > 0:
                candidate_scale = (lower_scale + upper_scale) / 2.0
            else:
                candidate_scale *= min(
                    0.95, math.sqrt(max_bytes / len(output)) * 0.98
                )
    if best is None:
        raise RuntimeError("action image exceeds the byte limit")
    return best


class TriggerEngine:
    def __init__(self, payload: dict[str, Any]):
        self.profile = TriggerProfile(payload["triggerProfile"])
        self.trigger_ratio = payload["regions"]["trigger"]
        self.data_ratio = payload["regions"]["normal" if payload["searchMode"] == "fast" else "precise"]
        self.capture_delay = float(payload["captureDelaySeconds"])
        self.limits = payload["limits"]
        self.frame_interval = 1.0 / self.limits["fps"]
        self.last_frame_time = -math.inf
        self.gate = TemporalGate(
            self.limits["confirmationsNeeded"], self.limits["cooldownSeconds"]
        )
        self.capture_due_at: float | None = None
        self.triggered = False
        self.last_match: MatchResult | None = None
        self.configured_aspect = (
            payload["configuredFrameSize"]["width"]
            / payload["configuredFrameSize"]["height"]
        )

    def process(self, frame: np.ndarray, now: float) -> tuple[bytes, int, int] | None:
        self.triggered = False
        if now - self.last_frame_time < self.frame_interval:
            return None
        self.last_frame_time = now
        bgr = ensure_bgr(frame)
        frame_height, frame_width = bgr.shape[:2]
        if frame_width <= 0 or frame_height <= 0 or frame_width * frame_height > 20_000_000:
            raise RuntimeError("capture frame dimensions are invalid")
        actual_aspect = frame_width / frame_height
        if abs(actual_aspect / self.configured_aspect - 1.0) > 0.02:
            raise RuntimeError("capture source aspect ratio changed; configure capture again")
        if self.capture_due_at is not None:
            if now < self.capture_due_at:
                return None
            self.capture_due_at = None
            data_rect = ratio_rect(self.data_ratio, frame_width, frame_height)
            return encode_action_png(crop(bgr, data_rect), self.limits)
        outer = ratio_rect(self.trigger_ratio, frame_width, frame_height)
        inner = ratio_rect(self.profile.inner_ratio, frame_width, frame_height, outer)
        self.last_match = self.profile.evaluate(crop(bgr, inner))
        if not self.gate.observe(self.last_match.matched, now):
            return None
        self.triggered = True
        if self.capture_delay > 0:
            self.capture_due_at = now + self.capture_delay
            return None
        data_rect = ratio_rect(self.data_ratio, frame_width, frame_height)
        return encode_action_png(crop(bgr, data_rect), self.limits)

    def take_triggered(self) -> bool:
        triggered = self.triggered
        self.triggered = False
        return triggered


class PredictionTriggerEngine:
    """Independent result trigger sharing the monitor frame and process."""

    def __init__(self, value: dict[str, Any], limits: dict[str, Any]):
        self.profile = TriggerProfile(value["triggerProfile"])
        self.trigger_ratio = value["trigger"]
        self.data_ratio = value["data"]
        self.limits = limits
        self.frame_interval = 1.0 / limits["fps"]
        self.last_frame_time = -math.inf
        self.gate = TemporalGate(2, 60.0)
        self.last_match: MatchResult | None = None
        self.configured_aspect = value["configuredFrameSize"]["width"] / value["configuredFrameSize"]["height"]

    def process(self, frame: np.ndarray, now: float) -> tuple[bytes, int, int] | None:
        if now - self.last_frame_time < self.frame_interval:
            return None
        self.last_frame_time = now
        bgr = ensure_bgr(frame)
        frame_height, frame_width = bgr.shape[:2]
        actual_aspect = frame_width / frame_height
        if abs(actual_aspect / self.configured_aspect - 1.0) > 0.02:
            raise RuntimeError("prediction capture aspect ratio changed")
        outer = ratio_rect(self.trigger_ratio, frame_width, frame_height)
        inner = ratio_rect(self.profile.inner_ratio, frame_width, frame_height, outer)
        self.last_match = self.profile.evaluate(crop(bgr, inner))
        if not self.gate.observe(self.last_match.matched, now):
            return None
        data_rect = ratio_rect(self.data_ratio, frame_width, frame_height)
        return encode_action_png(crop(bgr, data_rect), self.limits)
