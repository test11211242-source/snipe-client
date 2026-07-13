import io

import pytest

from protocol.framing import ProtocolError, encode_envelope, read_envelope


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
