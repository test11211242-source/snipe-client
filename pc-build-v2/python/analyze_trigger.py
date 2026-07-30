"""Build a color-independent structural trigger profile from a canonical PNG."""

from __future__ import annotations

import base64
import os
import sys
from typing import Any

import cv2
import numpy as np

from protocol.framing import ProtocolError, read_envelope, write_envelope
from trigger_matching import create_orb, score_orb_alignment

ANALYZER_VERSION = "2.1.0"
MAX_PNG_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 20_000_000
NORMALIZED_SIZE = 128
LEGACY_KEYPOINT_THRESHOLD = 18
LEGACY_HASH_THRESHOLD = 5
LEGACY_ORB_DISTANCE_THRESHOLD = 55
LEGACY_ORB_MIN_GOOD_MATCHES = 10
LEGACY_NCC_THRESHOLD = 0.72
LEGACY_MIN_GRAYSCALE_DEVIATION = 4.0


def validate_pixel_rect(value: Any, width: int, height: int) -> tuple[int, int, int, int]:
    if not isinstance(value, dict) or set(value) != {"x", "y", "width", "height"}:
        raise ProtocolError("outer rect is invalid")
    numbers = [value[key] for key in ("x", "y", "width", "height")]
    if any(isinstance(number, bool) or not isinstance(number, int) for number in numbers):
        raise ProtocolError("outer rect values must be integers")
    x, y, rect_width, rect_height = numbers
    if x < 0 or y < 0 or rect_width <= 0 or rect_height <= 0:
        raise ProtocolError("outer rect dimensions are invalid")
    if x + rect_width > width or y + rect_height > height:
        raise ProtocolError("outer rect exceeds image bounds")
    return x, y, rect_width, rect_height


def _local_normalize(channel: np.ndarray) -> np.ndarray:
    source = channel.astype(np.float32)
    mean = cv2.GaussianBlur(source, (0, 0), 3.0)
    squared_mean = cv2.GaussianBlur(source * source, (0, 0), 3.0)
    deviation = np.sqrt(np.maximum(squared_mean - mean * mean, 0.0))
    normalized = np.clip((source - mean) / (deviation + 4.0), -2.5, 2.5)
    return np.clip((normalized + 2.5) * 51.0, 0, 255).astype(np.uint8)


def _remove_edge_specks(edges: np.ndarray, minimum_area: int) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(edges, 8)
    cleaned = np.zeros_like(edges)
    for label in range(1, count):
        if int(stats[label, cv2.CC_STAT_AREA]) >= minimum_area:
            cleaned[labels == label] = 255
    return cleaned


def structural_maps(
    image: np.ndarray, size: tuple[int, int]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if image.ndim != 3 or image.shape[2] not in (3, 4):
        raise ProtocolError("trigger image format is invalid")
    resized = cv2.resize(image[:, :, :3], size, interpolation=cv2.INTER_AREA)
    channels = [_local_normalize(resized[:, :, index]) for index in range(3)]
    gradients = []
    edge_maps = []
    for channel in channels:
        gx = cv2.Scharr(channel, cv2.CV_32F, 1, 0)
        gy = cv2.Scharr(channel, cv2.CV_32F, 0, 1)
        gradients.append((gx, gy, cv2.magnitude(gx, gy)))
        edge_maps.append(cv2.Canny(channel, 55, 125, L2gradient=True))

    magnitudes = np.stack([gradient[2] for gradient in gradients], axis=0)
    strongest = np.argmax(magnitudes, axis=0)
    magnitude = np.max(magnitudes, axis=0)
    gx = np.choose(strongest, [gradient[0] for gradient in gradients])
    gy = np.choose(strongest, [gradient[1] for gradient in gradients])
    nonzero = magnitude[magnitude > 0]
    scale = float(np.percentile(nonzero, 95)) if nonzero.size else 1.0
    structure = np.clip(magnitude * (255.0 / max(scale, 1.0)), 0, 255).astype(np.uint8)
    edges = np.maximum.reduce(edge_maps)
    edges[structure < 32] = 0
    minimum_area = max(2, int(round(size[0] * size[1] * 0.00012)))
    edges = _remove_edge_specks(edges, minimum_area)
    orientation = np.mod(cv2.phase(gx, gy, angleInDegrees=True), 180.0).astype(np.uint8)
    orientation[edges == 0] = 0
    return structure, edges, orientation


def _padded_rect(
    x: int, y: int, width: int, height: int, frame_width: int, frame_height: int
) -> tuple[int, int, int, int]:
    padding = max(4, int(round(max(width, height) * 0.1)))
    left = max(0, x - padding)
    top = max(0, y - padding)
    right = min(frame_width, x + width + padding)
    bottom = min(frame_height, y + height + padding)
    return left, top, right - left, bottom - top


def propose_inner_rect(image: np.ndarray) -> tuple[tuple[float, float, float, float], float]:
    original_height, original_width = image.shape[:2]
    scale = min(1.0, 512.0 / max(original_width, original_height))
    width = max(1, int(round(original_width * scale)))
    height = max(1, int(round(original_height * scale)))
    structure, edges, _ = structural_maps(image, (width, height))
    edge_count = int(np.count_nonzero(edges))
    if edge_count < 40:
        return (0.0, 0.0, 1.0, 1.0), 0.0

    # A trigger can be composed of disconnected glyphs or icons; group nearby parts before scoring.
    radius = max(4, int(round(min(width, height) * 0.12)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    grouped = cv2.dilate(edges, kernel, iterations=1)
    grouped = cv2.morphologyEx(grouped, cv2.MORPH_CLOSE, kernel, iterations=1)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(grouped, 8)
    total_mass = float(structure[edges > 0].sum())
    frame_area = float(width * height)
    frame_center = np.array([width / 2.0, height / 2.0])
    diagonal = max(float(np.hypot(width, height)) / 2.0, 1.0)
    candidates: list[tuple[float, tuple[int, int, int, int], float]] = []

    for label in range(1, count):
        group_mask = labels == label
        selected = np.logical_and(group_mask, edges > 0)
        selected_count = int(np.count_nonzero(selected))
        if selected_count < max(24, int(edge_count * 0.03)):
            continue
        points = cv2.findNonZero(selected.astype(np.uint8))
        if points is None:
            continue
        x, y, box_width, box_height = cv2.boundingRect(points)
        x, y, box_width, box_height = _padded_rect(
            x, y, box_width, box_height, width, height
        )
        area_ratio = box_width * box_height / frame_area
        if area_ratio > 0.94:
            continue
        mass = float(structure[selected].sum()) / max(total_mass, 1.0)
        center_distance = float(np.linalg.norm(centroids[label] - frame_center)) / diagonal
        centrality = max(0.0, 1.0 - center_distance)
        density = min(1.0, selected_count / max(box_width * box_height * 0.12, 1.0))
        reduction = 1.0 - area_ratio
        border_margin = max(2, int(round(min(width, height) * 0.015)))
        touches_border = (
            x <= border_margin
            or y <= border_margin
            or x + box_width >= width - border_margin
            or y + box_height >= height - border_margin
        )
        score = 0.38 * mass + 0.3 * centrality + 0.2 * density + 0.12 * reduction
        if touches_border:
            score -= 0.14
        candidates.append((score, (x, y, box_width, box_height), area_ratio))

    if not candidates:
        return (0.0, 0.0, 1.0, 1.0), 0.0
    candidates.sort(key=lambda candidate: candidate[0], reverse=True)
    best_score, (x, y, box_width, box_height), area_ratio = candidates[0]
    second_score = candidates[1][0] if len(candidates) > 1 else 0.0
    margin = max(0.0, best_score - second_score)
    confidence = float(np.clip(0.65 * best_score + 0.35 * min(1.0, margin * 4.0), 0, 1))
    if best_score < 0.46 or confidence < 0.4 or area_ratio > 0.88:
        return (0.0, 0.0, 1.0, 1.0), confidence
    return (x / width, y / height, box_width / width, box_height / height), confidence


def _crop_ratio(
    image: np.ndarray, ratio: tuple[float, float, float, float]
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    height, width = image.shape[:2]
    x = min(width - 1, max(0, int(round(ratio[0] * width))))
    y = min(height - 1, max(0, int(round(ratio[1] * height))))
    right = min(width, max(x + 1, int(round((ratio[0] + ratio[2]) * width))))
    bottom = min(height, max(y + 1, int(round((ratio[1] + ratio[3]) * height))))
    canonical = (
        x / width,
        y / height,
        (right - x) / width,
        (bottom - y) / height,
    )
    return image[y:bottom, x:right], canonical


def _encode_map(image: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", image, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise ProtocolError("structural template cannot be encoded")
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def structure_hash64(structure: np.ndarray) -> str:
    small = cv2.resize(structure, (9, 8), interpolation=cv2.INTER_AREA)
    bits = small[:, 1:] >= small[:, :-1]
    value = 0
    for bit in bits.reshape(-1):
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def _average_hash64(gray: np.ndarray) -> str:
    tiny = cv2.resize(gray, (8, 8), interpolation=cv2.INTER_AREA)
    average = float(np.mean(tiny))
    value = 0
    for pixel in tiny.reshape(-1):
        value = (value << 1) | int(pixel >= average)
    return f"{value:016x}"


def _legacy_profile(inner: np.ndarray) -> dict[str, Any]:
    gray = cv2.cvtColor(inner, cv2.COLOR_BGR2GRAY)
    normalized = cv2.resize(
        gray, (NORMALIZED_SIZE, NORMALIZED_SIZE), interpolation=cv2.INTER_AREA
    )
    if float(np.std(normalized)) < LEGACY_MIN_GRAYSCALE_DEVIATION:
        raise ProtocolError(
            "Selected trigger has too little luminance contrast for V1 compatibility"
        )
    mode_detector = cv2.ORB_create(nfeatures=300)
    mode_keypoints, _ = mode_detector.detectAndCompute(normalized, None)
    keypoints_count = len(mode_keypoints or [])

    runtime_orb = cv2.ORB_create(nfeatures=400)
    _, descriptors = runtime_orb.detectAndCompute(normalized, None)
    good_matches = 0
    if descriptors is not None:
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        matches = matcher.match(descriptors, descriptors)
        good_matches = sum(
            match.distance <= LEGACY_ORB_DISTANCE_THRESHOLD for match in matches
        )
    feature_mode = (
        "orb"
        if keypoints_count >= LEGACY_KEYPOINT_THRESHOLD
        and good_matches >= LEGACY_ORB_MIN_GOOD_MATCHES
        else "ncc"
    )
    return {
        "templateGrayBase64": _encode_map(normalized),
        "thumbnailHash": _average_hash64(normalized),
        "featureMode": feature_mode,
        "keypointsCount": keypoints_count,
        "normalizedTemplateSize": {
            "width": NORMALIZED_SIZE,
            "height": NORMALIZED_SIZE,
        },
        "hashThreshold": LEGACY_HASH_THRESHOLD,
        "orbDistanceThreshold": LEGACY_ORB_DISTANCE_THRESHOLD,
        "orbMinGoodMatches": LEGACY_ORB_MIN_GOOD_MATCHES,
        "nccThreshold": LEGACY_NCC_THRESHOLD,
        "analyzerVersion": "trigger-profile-v2",
    }


def _edge_coverage(edges: np.ndarray) -> float:
    covered = 0
    for row in range(4):
        for column in range(4):
            tile = edges[
                row * NORMALIZED_SIZE // 4 : (row + 1) * NORMALIZED_SIZE // 4,
                column * NORMALIZED_SIZE // 4 : (column + 1) * NORMALIZED_SIZE // 4,
            ]
            if np.count_nonzero(tile) >= 5:
                covered += 1
    return covered / 16.0


def analyze_result(png: bytes, outer_rect: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    image = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ProtocolError("PNG cannot be decoded")
    height, width = image.shape[:2]
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        raise ProtocolError("image dimensions exceed limits")
    x, y, rect_width, rect_height = validate_pixel_rect(outer_rect, width, height)
    outer = image[y : y + rect_height, x : x + rect_width]
    inner_ratio, crop_confidence = propose_inner_rect(outer)
    inner, inner_ratio = _crop_ratio(outer, inner_ratio)
    structure, edges, orientation = structural_maps(
        inner, (NORMALIZED_SIZE, NORMALIZED_SIZE)
    )
    edge_pixel_count = int(np.count_nonzero(edges))
    edge_coverage = _edge_coverage(edges)
    if edge_pixel_count < 80 or edge_coverage < 0.125:
        raise ProtocolError(
            "Selected trigger region has too little stable structure; include a border or surrounding UI"
        )

    orb = create_orb()
    keypoints, descriptors = orb.detectAndCompute(structure, None)
    quadrants = {
        (int(point.pt[0] >= NORMALIZED_SIZE / 2), int(point.pt[1] >= NORMALIZED_SIZE / 2))
        for point in keypoints
    }
    self_alignment = score_orb_alignment(
        keypoints, descriptors, structure, orb=orb
    )
    matcher_mode = (
        "edge_orb"
        if len(keypoints) >= 20 and len(quadrants) >= 3 and self_alignment.viable
        else "edge"
    )
    density_score = min(1.0, edge_pixel_count / 420.0)
    score = float(
        np.clip(0.52 * density_score + 0.33 * edge_coverage + 0.15 * crop_confidence, 0, 1)
    )
    grade = "high" if score >= 0.7 else "medium"
    crop_area_ratio = float(inner_ratio[2] * inner_ratio[3])

    profile = {
        "schemaVersion": 3,
        "analyzer": {"name": "cr-tools-trigger-analyzer", "version": ANALYZER_VERSION},
        "innerRect": {
            "x": inner_ratio[0],
            "y": inner_ratio[1],
            "width": inner_ratio[2],
            "height": inner_ratio[3],
        },
        "structureAlgorithm": "max-channel-scharr-v1",
        "structureHash64": structure_hash64(structure),
        "matcherMode": matcher_mode,
        "normalizedTemplateSize": {"width": NORMALIZED_SIZE, "height": NORMALIZED_SIZE},
        "structureTemplateBase64": _encode_map(structure),
        "edgeTemplateBase64": _encode_map(edges),
        "orientationTemplateBase64": _encode_map(orientation),
        "quality": {
            "grade": grade,
            "score": score,
            "edgePixelCount": edge_pixel_count,
            "edgeCoverage": edge_coverage,
            "keypointsCount": len(keypoints),
            "cropConfidence": crop_confidence,
            "cropAreaRatio": crop_area_ratio,
        },
    }
    return profile, _legacy_profile(inner)


def analyze(png: bytes, outer_rect: Any) -> dict[str, Any]:
    profile, _ = analyze_result(png, outer_rect)
    return profile


def main() -> None:
    request_id = os.environ.get("CR_TOOLS_REQUEST_ID", "unknown")
    try:
        envelope = read_envelope(sys.stdin.buffer, max_binary_bytes=MAX_PNG_BYTES)
        metadata = envelope.metadata
        if set(metadata) != {"protocolVersion", "requestId", "operation", "outerRect"}:
            raise ProtocolError("analyzer request fields are invalid")
        if metadata["protocolVersion"] != 1 or metadata["operation"] != "analyze_trigger":
            raise ProtocolError("analyzer request version or operation is invalid")
        if metadata["requestId"] != request_id:
            raise ProtocolError("analyzer request id is invalid")
        profile, legacy_profile = analyze_result(
            envelope.binary, metadata["outerRect"]
        )
        write_envelope(
            sys.stdout.buffer,
            {
                "protocolVersion": 1,
                "requestId": request_id,
                "ok": True,
                "profile": profile,
                "legacyProfile": legacy_profile,
            },
        )
    except Exception as error:
        write_envelope(
            sys.stdout.buffer,
            {
                "protocolVersion": 1,
                "requestId": request_id,
                "ok": False,
                "error": {"code": "ANALYSIS_FAILED", "message": str(error)[:300]},
            },
        )


if __name__ == "__main__":
    main()
