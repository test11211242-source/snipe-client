"""Capture one canonical PNG using a validated CRT2 request."""

from __future__ import annotations

import os
import sys
from typing import Any

from capture.backend import CaptureBackendError, capture_once
from protocol.framing import ProtocolError, read_envelope, write_envelope

MAX_PNG_BYTES = 32 * 1024 * 1024


def validate_request(metadata: dict[str, Any], binary: bytes) -> tuple[str, dict[str, Any]]:
    if binary:
        raise ProtocolError("capture request must not contain binary data")
    if set(metadata) != {"protocolVersion", "requestId", "operation", "selector"}:
        raise ProtocolError("capture request fields are invalid")
    if metadata["protocolVersion"] != 1 or metadata["operation"] != "capture_once":
        raise ProtocolError("capture request version or operation is invalid")
    request_id = metadata["requestId"]
    if not isinstance(request_id, str) or request_id != os.environ.get("CR_TOOLS_REQUEST_ID"):
        raise ProtocolError("capture request id is invalid")
    if not isinstance(metadata["selector"], dict):
        raise ProtocolError("capture selector must be an object")
    return request_id, metadata["selector"]


def main() -> None:
    request_id = os.environ.get("CR_TOOLS_REQUEST_ID", "unknown")
    try:
        envelope = read_envelope(sys.stdin.buffer, max_binary_bytes=0)
        request_id, selector = validate_request(envelope.metadata, envelope.binary)
        png, width, height = capture_once(selector)
        if not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) > MAX_PNG_BYTES:
            raise CaptureBackendError("PNG_INVALID", "Capture PNG is invalid or too large")
        write_envelope(
            sys.stdout.buffer,
            {
                "protocolVersion": 1,
                "requestId": request_id,
                "ok": True,
                "width": width,
                "height": height,
                "mimeType": "image/png",
                "byteLength": len(png),
            },
            png,
        )
    except (ProtocolError, CaptureBackendError, Exception) as error:
        code = getattr(error, "code", "CAPTURE_FAILED")
        write_envelope(
            sys.stdout.buffer,
            {
                "protocolVersion": 1,
                "requestId": request_id,
                "ok": False,
                "error": {"code": code, "message": str(error)[:300]},
            },
        )


if __name__ == "__main__":
    main()
