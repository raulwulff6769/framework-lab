"""Independent synthetic NTCB/FLEX encoder for simulator and test use."""

from __future__ import annotations

from collections.abc import Iterable, Mapping

_STRUCTURE_FIELD_COUNTS = {10: 69, 20: 122, 30: 255}
_FLEX_FRAME_KINDS = frozenset("ATCEX")


def _wire_bytes(value: bytes | bytearray | memoryview, name: str) -> bytes:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError(f"{name} must be bytes-like")
    return bytes(value)


def _unsigned(value: int, width: int, name: str) -> bytes:
    if type(value) is not int or not 0 <= value < 1 << (8 * width):
        raise ValueError(f"{name} must be an unsigned {8 * width}-bit integer")
    return value.to_bytes(width, "little")


def _field_count(count: int) -> int:
    if type(count) is not int or not 1 <= count <= 255:
        raise ValueError("FLEX field count must be in the range 1..255")
    return count


def _version_field_count(version: int) -> int:
    if type(version) is not int or version not in _STRUCTURE_FIELD_COUNTS:
        raise ValueError("FLEX version must be 10, 20, or 30")
    return _STRUCTURE_FIELD_COUNTS[version]


def xor_sum(data: bytes | bytearray | memoryview) -> int:
    """Return the NTCB XOR checksum for the provided bytes."""
    result = 0
    for byte in _wire_bytes(data, "data"):
        result ^= byte
    return result


def crc8(data: bytes | bytearray | memoryview) -> int:
    """Return FLEX CRC-8 (poly 0x31, init 0xFF, MSB-first, no final XOR)."""
    crc = 0xFF
    for byte in _wire_bytes(data, "data"):
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def ntcb(payload: bytes, receiver: int = 1, sender: int = 0) -> bytes:
    """Wrap application bytes in the 16-byte NTCB transport header."""
    data = _wire_bytes(payload, "payload")
    if len(data) > 0xFFFF:
        raise ValueError("NTCB payload cannot exceed 65535 bytes")
    header_prefix = (
        b"@NTC"
        + _unsigned(receiver, 4, "receiver")
        + _unsigned(sender, 4, "sender")
        + _unsigned(len(data), 2, "payload length")
    )
    header_with_data_checksum = header_prefix + bytes((xor_sum(data),))
    header = header_with_data_checksum + bytes((xor_sum(header_with_data_checksum),))
    return header + data


def mask(fields: Iterable[int], count: int = 122) -> bytes:
    """Encode selected 1-based FLEX field numbers as an MSB-first bit array."""
    field_count = _field_count(count)
    result = bytearray((field_count + 7) // 8)
    for field_number in fields:
        if type(field_number) is not int or not 1 <= field_number <= field_count:
            raise ValueError(f"FLEX field number must be in the range 1..{field_count}")
        bit_index = field_number - 1
        result[bit_index // 8] |= 1 << (7 - bit_index % 8)
    return bytes(result)


def negotiation(fields: Iterable[int], *, version: int = 20, count: int = 122) -> bytes:
    """Build a complete NTCB-wrapped FLEX version negotiation packet."""
    if type(version) is not int or version not in _STRUCTURE_FIELD_COUNTS:
        raise ValueError("FLEX version must be 10, 20, or 30")
    field_count = _field_count(count)
    payload = (
        b"*>FLEX"
        + bytes((0xB0, version, version, field_count))
        + mask(fields, field_count)
    )
    return ntcb(payload)


def record(fields: dict[int, bytes], *, count: int = 122) -> bytes:
    """Concatenate selected field bytes in ascending 1-based field order."""
    field_count = _field_count(count)
    if not isinstance(fields, dict):
        raise TypeError("fields must be a dict of field numbers to bytes")
    for field_number in fields:
        if type(field_number) is not int or not 1 <= field_number <= field_count:
            raise ValueError(f"FLEX field number must be in the range 1..{field_count}")
    return b"".join(_wire_bytes(fields[number], f"field {number}") for number in sorted(fields))


def frame(
    kind: str,
    payload: bytes,
    *,
    count: int | None = None,
    event_index: int | None = None,
) -> bytes:
    """Encode a FLEX frame, adding its kind-specific prefix and CRC-8.

    ``payload`` contains the record bytes; ``~E`` payloads must already include
    any per-record length fields required by their enclosing archive format.
    """
    if not isinstance(kind, str) or len(kind) != 1 or kind not in _FLEX_FRAME_KINDS:
        raise ValueError("FLEX frame kind must be one of A, T, C, E, or X")
    data = _wire_bytes(payload, "payload")
    prefix = bytearray(b"~" + kind.encode("ascii"))
    if kind in "AE":
        if count is None or event_index is not None:
            raise ValueError("~A and ~E frames require count and do not accept event_index")
        prefix.extend(_unsigned(count, 1, "count"))
    elif kind in "TX":
        if event_index is None or count is not None:
            raise ValueError("~T and ~X frames require event_index and do not accept count")
        prefix.extend(_unsigned(event_index, 4, "event_index"))
    elif count is not None or event_index is not None:
        raise ValueError("~C frames do not accept count or event_index")
    body = bytes(prefix) + data
    return body + bytes((crc8(body),))


def flex_mask(fields: Iterable[int], version: int = 20) -> bytes:
    """Compatibility wrapper for the former version-based mask helper."""
    return mask(fields, _version_field_count(version))


def flex_negotiation(
    fields: Iterable[int],
    protocol_version: int = 20,
    structure_version: int = 20,
    receiver: int = 1,
    sender: int = 0,
) -> bytes:
    """Compatibility wrapper retaining separate protocol and structure versions."""
    if type(protocol_version) is not int or protocol_version not in _STRUCTURE_FIELD_COUNTS:
        raise ValueError("FLEX protocol version must be 10, 20, or 30")
    field_count = _version_field_count(structure_version)
    payload = (
        b"*>FLEX"
        + bytes((0xB0, protocol_version, structure_version, field_count))
        + mask(fields, field_count)
    )
    return ntcb(payload, receiver=receiver, sender=sender)


def flex_record(
    values: Mapping[int, bytes],
    bit_mask: bytes | bytearray | memoryview,
    version: int = 20,
) -> bytes:
    """Compatibility wrapper for the former mask-checked record helper."""
    field_count = _version_field_count(version)
    selected_mask = _wire_bytes(bit_mask, "mask")
    if len(selected_mask) != (field_count + 7) // 8:
        raise ValueError("mask length does not match the FLEX structure version")
    selected = {
        field_number
        for field_number in range(1, field_count + 1)
        if selected_mask[(field_number - 1) // 8] & (1 << (7 - (field_number - 1) % 8))
    }
    if set(values) != selected:
        raise ValueError("values must provide exactly the fields selected by the mask")
    return record(dict(values), count=field_count)


def flex_frame(kind: str, payload: bytes) -> bytes:
    """Compatibility wrapper for payloads that already contain any frame prefix."""
    if not isinstance(kind, str) or len(kind) != 1 or kind not in _FLEX_FRAME_KINDS:
        raise ValueError("FLEX frame kind must be one of A, T, C, E, or X")
    body = b"~" + kind.encode("ascii") + _wire_bytes(payload, "payload")
    return body + bytes((crc8(body),))
