"""Pure trigger matching and bounded action-image preparation."""

from __future__ import annotations

import base64
import binascii
import math
from typing import Any

import cv2
import numpy as np

from monitor_protocol import MonitorProtocolError, validate_ratio


def ahash64(gray: np.ndarray) -> str:
    tiny = cv2.resize(gray, (8, 8), interpolation=cv2.INTER_AREA)
    bits = tiny >= float(tiny.mean())
    value = 0
    for bit in bits.reshape(-1):
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def hamming64(left: str, right: str) -> int:
    if len(left) != 16 or len(right) != 16:
        raise ValueError("ahash values must be 64-bit hexadecimal strings")
    return (int(left, 16) ^ int(right, 16)).bit_count()


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
            "hashAlgorithm",
            "ahash64",
            "innerRect",
            "featureMode",
            "keypointsCount",
            "normalizedTemplateSize",
            "templateGrayBase64",
            "hashMaxDistance",
            "orbDistanceThreshold",
            "orbMinGoodMatches",
            "nccMinScore",
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
        if not 1 <= len(analyzer["version"]) <= 32:
            raise MonitorProtocolError("trigger analyzer version is invalid")
        if value["schemaVersion"] != 2 or value["hashAlgorithm"] != "ahash64-bitwise-v1":
            raise MonitorProtocolError("trigger profile version is invalid")
        self.hash = value["ahash64"]
        if not isinstance(self.hash, str) or len(self.hash) != 16:
            raise MonitorProtocolError("trigger hash is invalid")
        try:
            int(self.hash, 16)
        except ValueError as error:
            raise MonitorProtocolError("trigger hash is invalid") from error
        self.inner_ratio = validate_ratio(value["innerRect"], "trigger inner rect")
        self.feature_mode = value["featureMode"]
        if self.feature_mode not in ("orb", "ncc"):
            raise MonitorProtocolError("trigger feature mode is invalid")
        size = value["normalizedTemplateSize"]
        if size != {"width": 128, "height": 128}:
            raise MonitorProtocolError("trigger normalized size must be 128x128")
        encoded = value["templateGrayBase64"]
        if not isinstance(encoded, str) or not 1 <= len(encoded) <= 32768:
            raise MonitorProtocolError("trigger template is invalid")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise MonitorProtocolError("trigger template encoding is invalid") from error
        self.template = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        if self.template is None or self.template.shape != (128, 128):
            raise MonitorProtocolError("trigger template image is invalid")
        self.hash_max_distance = _bounded_int(value["hashMaxDistance"], 0, 64, "hash distance")
        self.orb_distance = _bounded_int(value["orbDistanceThreshold"], 1, 256, "ORB distance")
        self.orb_min_matches = _bounded_int(value["orbMinGoodMatches"], 0, 10000, "ORB matches")
        self.ncc_min_score = _bounded_float(value["nccMinScore"], -1, 1, "NCC score")
        _bounded_int(value["keypointsCount"], 0, 100000, "keypoints count")
        if (
            self.hash_max_distance != 18
            or self.orb_distance != 55
            or self.orb_min_matches != 10
            or self.ncc_min_score != 0.72
        ):
            raise MonitorProtocolError("trigger thresholds are invalid")
        self.orb = cv2.ORB_create(nfeatures=400)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        _, self.template_descriptors = self.orb.detectAndCompute(self.template, None)

    def matches(self, gray: np.ndarray) -> bool:
        if hamming64(ahash64(gray), self.hash) > self.hash_max_distance:
            return False
        if self.feature_mode == "ncc":
            score = float(cv2.matchTemplate(gray, self.template, cv2.TM_CCOEFF_NORMED)[0][0])
            return math.isfinite(score) and score >= self.ncc_min_score
        _, descriptors = self.orb.detectAndCompute(gray, None)
        if self.template_descriptors is None or descriptors is None:
            return False
        matches = self.matcher.match(self.template_descriptors, descriptors)
        return sum(match.distance <= self.orb_distance for match in matches) >= self.orb_min_matches


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
    ok, encoded = cv2.imencode(".png", bgr, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError("action image could not be encoded")
    output = encoded.tobytes()
    if not output or len(output) > limits["maxImageBytes"]:
        raise RuntimeError("action image exceeds the byte limit")
    return output, width, height


class TriggerEngine:
    def __init__(self, payload: dict[str, Any]):
        self.profile = TriggerProfile(payload["triggerProfile"])
        self.trigger_ratio = payload["regions"]["trigger"]
        self.data_ratio = payload["regions"]["normal" if payload["searchMode"] == "fast" else "precise"]
        self.limits = payload["limits"]
        self.frame_interval = 1.0 / self.limits["fps"]
        self.last_frame_time = -math.inf
        self.last_trigger_time = -math.inf
        self.confirmations = 0.0
        self.configured_aspect = (
            payload["configuredFrameSize"]["width"]
            / payload["configuredFrameSize"]["height"]
        )
        self.frame_geometry_validated = False

    def process(self, frame: np.ndarray, now: float) -> tuple[bytes, int, int] | None:
        if now - self.last_frame_time < self.frame_interval:
            return None
        self.last_frame_time = now
        bgr = ensure_bgr(frame)
        frame_height, frame_width = bgr.shape[:2]
        if frame_width <= 0 or frame_height <= 0 or frame_width * frame_height > 20_000_000:
            raise RuntimeError("capture frame dimensions are invalid")
        if not self.frame_geometry_validated:
            actual_aspect = frame_width / frame_height
            if abs(actual_aspect / self.configured_aspect - 1.0) > 0.02:
                raise RuntimeError("capture source aspect ratio changed; configure capture again")
            self.frame_geometry_validated = True
        if now - self.last_trigger_time < self.limits["cooldownSeconds"]:
            return None
        outer = ratio_rect(self.trigger_ratio, frame_width, frame_height)
        inner = ratio_rect(self.profile.inner_ratio, frame_width, frame_height, outer)
        gray = cv2.cvtColor(crop(bgr, inner), cv2.COLOR_BGR2GRAY)
        normalized = cv2.resize(gray, (128, 128), interpolation=cv2.INTER_AREA)
        if self.profile.matches(normalized):
            self.confirmations = min(
                float(self.limits["confirmationsNeeded"]), self.confirmations + 1.0
            )
        else:
            self.confirmations = max(0.0, self.confirmations - self.limits["confirmationDecay"])
            return None
        if self.confirmations < self.limits["confirmationsNeeded"]:
            return None
        self.confirmations = 0.0
        self.last_trigger_time = now
        data_rect = ratio_rect(self.data_ratio, frame_width, frame_height)
        return encode_action_png(crop(bgr, data_rect), self.limits)


class PredictionTriggerEngine:
    """Independent result trigger sharing the monitor frame and process."""

    def __init__(self, value: dict[str, Any], limits: dict[str, Any]):
        self.profile = TriggerProfile(value["triggerProfile"])
        self.trigger_ratio = value["trigger"]
        self.data_ratio = value["data"]
        self.limits = limits
        self.frame_interval = 1.0 / limits["fps"]
        self.last_frame_time = -math.inf
        self.last_trigger_time = -math.inf
        self.configured_aspect = value["configuredFrameSize"]["width"] / value["configuredFrameSize"]["height"]
        self.frame_geometry_validated = False

    def process(self, frame: np.ndarray, now: float) -> tuple[bytes, int, int] | None:
        if now - self.last_frame_time < self.frame_interval:
            return None
        self.last_frame_time = now
        bgr = ensure_bgr(frame)
        frame_height, frame_width = bgr.shape[:2]
        if not self.frame_geometry_validated:
            actual_aspect = frame_width / frame_height
            if abs(actual_aspect / self.configured_aspect - 1.0) > 0.02:
                raise RuntimeError("prediction capture aspect ratio changed")
            self.frame_geometry_validated = True
        if now - self.last_trigger_time < 60.0:
            return None
        outer = ratio_rect(self.trigger_ratio, frame_width, frame_height)
        inner = ratio_rect(self.profile.inner_ratio, frame_width, frame_height, outer)
        gray = cv2.cvtColor(crop(bgr, inner), cv2.COLOR_BGR2GRAY)
        normalized = cv2.resize(gray, (128, 128), interpolation=cv2.INTER_AREA)
        if not self.profile.matches(normalized):
            return None
        self.last_trigger_time = now
        data_rect = ratio_rect(self.data_ratio, frame_width, frame_height)
        return encode_action_png(crop(bgr, data_rect), self.limits)
