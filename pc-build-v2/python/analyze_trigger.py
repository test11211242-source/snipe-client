"""Build a deterministic trigger profile from an in-memory canonical PNG."""

from __future__ import annotations

import base64
import os
import sys
from typing import Any

import cv2
import numpy as np

from protocol.framing import ProtocolError, read_envelope, write_envelope

ANALYZER_VERSION = "1.0.0"
MAX_PNG_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 20_000_000


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


def autocrop(gray: np.ndarray) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    height, width = gray.shape
    border = np.concatenate((gray[0], gray[-1], gray[:, 0], gray[:, -1]))
    background = float(np.median(border))
    mask = np.abs(gray.astype(np.float32) - background) > 10.0
    points = cv2.findNonZero(mask.astype(np.uint8))
    if points is None:
        return gray, (0, 0, width, height)
    x, y, crop_width, crop_height = cv2.boundingRect(points)
    if crop_width * crop_height < width * height * 0.1:
        return gray, (0, 0, width, height)
    return gray[y : y + crop_height, x : x + crop_width], (x, y, crop_width, crop_height)


def ahash64(gray: np.ndarray) -> str:
    small = cv2.resize(gray, (8, 8), interpolation=cv2.INTER_AREA)
    bits = small >= float(small.mean())
    value = 0
    for bit in bits.reshape(-1):
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def hamming64(left: str, right: str) -> int:
    if len(left) != 16 or len(right) != 16:
        raise ValueError("ahash values must contain 16 hexadecimal characters")
    return (int(left, 16) ^ int(right, 16)).bit_count()


def analyze(png: bytes, outer_rect: Any) -> dict[str, Any]:
    image = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ProtocolError("PNG cannot be decoded")
    height, width = image.shape[:2]
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        raise ProtocolError("image dimensions exceed limits")
    x, y, rect_width, rect_height = validate_pixel_rect(outer_rect, width, height)
    gray = cv2.cvtColor(image[y : y + rect_height, x : x + rect_width], cv2.COLOR_BGR2GRAY)
    inner, (inner_x, inner_y, inner_width, inner_height) = autocrop(gray)
    normalized = cv2.resize(inner, (128, 128), interpolation=cv2.INTER_AREA)
    orb = cv2.ORB_create(nfeatures=300)
    keypoints = orb.detect(normalized, None)
    feature_mode = "orb" if len(keypoints) >= 18 else "ncc"
    encoded_ok, encoded_template = cv2.imencode(".png", normalized)
    if not encoded_ok:
        raise ProtocolError("normalized template cannot be encoded")
    return {
        "schemaVersion": 2,
        "analyzer": {"name": "cr-tools-trigger-analyzer", "version": ANALYZER_VERSION},
        "hashAlgorithm": "ahash64-bitwise-v1",
        "ahash64": ahash64(normalized),
        "innerRect": {
            "x": inner_x / rect_width,
            "y": inner_y / rect_height,
            "width": inner_width / rect_width,
            "height": inner_height / rect_height,
        },
        "featureMode": feature_mode,
        "keypointsCount": len(keypoints),
        "normalizedTemplateSize": {"width": 128, "height": 128},
        "templateGrayBase64": base64.b64encode(encoded_template.tobytes()).decode("ascii"),
        "hashMaxDistance": 18,
        "orbDistanceThreshold": 55,
        "orbMinGoodMatches": 10,
        "nccMinScore": 0.72,
    }


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
        profile = analyze(envelope.binary, metadata["outerRect"])
        write_envelope(
            sys.stdout.buffer,
            {"protocolVersion": 1, "requestId": request_id, "ok": True, "profile": profile},
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
