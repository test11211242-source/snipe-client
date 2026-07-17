import io

import pytest

from protocol.framing import ProtocolError, encode_envelope, read_envelope, read_stream_envelope


def test_binary_envelope_round_trip() -> None:
    encoded = encode_envelope({"protocolVersion": 1, "ok": True}, b"PNG")
    result = read_envelope(io.BytesIO(encoded), max_binary_bytes=3)
    assert result.metadata == {"protocolVersion": 1, "ok": True}
    assert result.binary == b"PNG"


@pytest.mark.parametrize("payload", [b"CRT2", encode_envelope({}, b"abc")[:-1]])
def test_rejects_truncated_frames(payload: bytes) -> None:
    with pytest.raises(ProtocolError, match="truncated"):
        read_envelope(io.BytesIO(payload), max_binary_bytes=10)


def test_rejects_bounded_binary_overflow() -> None:
    with pytest.raises(ProtocolError, match="exceeds"):
        read_envelope(io.BytesIO(encode_envelope({}, b"123")), max_binary_bytes=2)


def test_stream_reader_consumes_consecutive_envelopes() -> None:
    stream = io.BytesIO(encode_envelope({"sequence": 1}) + encode_envelope({"sequence": 2}, b"PNG"))
    first = read_stream_envelope(stream, max_binary_bytes=3)
    second = read_stream_envelope(stream, max_binary_bytes=3)
    assert first.metadata == {"sequence": 1}
    assert first.binary == b""
    assert second.metadata == {"sequence": 2}
    assert second.binary == b"PNG"
