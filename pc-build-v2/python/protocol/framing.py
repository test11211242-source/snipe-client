"""Bounded CRT2 binary framing shared by one-shot Python workers."""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any, BinaryIO

MAGIC = b"CRT2"
HEADER = struct.Struct(">4sII")


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class Envelope:
    metadata: dict[str, Any]
    binary: bytes


def _read_exact(stream: BinaryIO, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise ProtocolError("truncated envelope")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_envelope(
    stream: BinaryIO, *, max_metadata_bytes: int = 65_536, max_binary_bytes: int
) -> Envelope:
    magic, metadata_length, binary_length = HEADER.unpack(_read_exact(stream, HEADER.size))
    if magic != MAGIC:
        raise ProtocolError("invalid envelope magic")
    if metadata_length > max_metadata_bytes or binary_length > max_binary_bytes:
        raise ProtocolError("envelope exceeds limits")
    try:
        metadata = json.loads(_read_exact(stream, metadata_length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("invalid envelope metadata") from error
    if not isinstance(metadata, dict):
        raise ProtocolError("metadata must be an object")
    binary = _read_exact(stream, binary_length)
    if stream.read(1):
        raise ProtocolError("trailing envelope bytes")
    return Envelope(metadata, binary)


def encode_envelope(metadata: dict[str, Any], binary: bytes = b"") -> bytes:
    metadata_bytes = json.dumps(
        metadata, ensure_ascii=True, separators=(",", ":")
    ).encode("utf-8")
    return HEADER.pack(MAGIC, len(metadata_bytes), len(binary)) + metadata_bytes + binary


def write_envelope(stream: BinaryIO, metadata: dict[str, Any], binary: bytes = b"") -> None:
    stream.write(encode_envelope(metadata, binary))
    stream.flush()
