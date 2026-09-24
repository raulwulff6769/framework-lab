"""Navtelecom NTCB/FLEX 1.0–2.0 receiver (vendor protocol v6.2, Annex A).

FLEX 3.0 is asked to downgrade; encrypted and legacy NTCB telemetry are unsupported.
"""

from __future__ import annotations

import math
import struct

from ..crc import crc8_egts
from ..records import Mapping

# Annex A.1, one-based fields 1–122; checked against Traccar 6.15.3
# NavisProtocolDecoder (Apache-2.0). FLEX 3.0 fields are excluded.
FIELD_SIZES = (
    4, 2, 4, 1, 1, 1, 1, 1, 4, 4, 4, 4, 4, 2, 4, 4,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1,
    4, 4, 2, 2, 4, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1,
    1, 1, 1, 1, 2, 4, 2, 1, 4, 2, 2, 2, 2, 2, 1, 1,
    1, 2, 4, 2, 1, 8, 2, 1, 16, 4, 2, 4, 37, 1, 1, 1,
    1, 1, 1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 6, 12, 24,
    48, 1, 1, 1, 1, 4, 4, 1, 4, 2, 6, 2, 6, 2, 2, 2,
    2, 2, 2, 2, 2, 1, 2, 2, 2, 1,
)
FIELD_COUNTS = {10: 69, 20: 122, 30: 255}
# Additional-record lengths are supplied by the device, unlike mask-bounded standard records.
MAX_ADDITIONAL_FRAME = 8192
MAX_PENDING = 128 * 1024


def _xor(data: bytes) -> int:
    value = 0
    for byte in data:
        value ^= byte
    return value


def _ntcb(payload: bytes, receiver: int, sender: int) -> bytes:
    header = struct.pack("<4sIIH", b"@NTC", receiver, sender, len(payload))
    header += bytes([_xor(payload)])
    return header + bytes([_xor(header)]) + payload


def _flex_reply(payload: bytes) -> bytes:
    return payload + bytes([crc8_egts(payload)])


def _selected(mask: bytes, count: int) -> list[int]:
    return [i for i in range(1, count + 1) if mask[(i - 1) // 8] & (0x80 >> ((i - 1) % 8))]


def _u(blob: bytes) -> int:
    return int.from_bytes(blob, "little")


def _f(blob: bytes) -> float | None:
    value = struct.unpack("<f", blob)[0]
    return value if math.isfinite(value) and value >= 0 else None


def _records(values: dict[int, bytes]) -> list[dict]:
    event_t = _u(values[3]) if 3 in values else 0
    fix_t = _u(values[9]) if 9 in values else 0
    counter: dict = {}
    if 67 in values and (seconds := _u(values[67])) != 0xFFFFFFFF:
        counter.update(engine_hours=seconds / 3600, engine_hours_method="ecu")
    elif 37 in values and (seconds := _u(values[37])) != 0xFFFFFFFF:
        counter.update(engine_hours=seconds / 3600, engine_hours_method="tracker")
    can_distance = _f(values[57]) if 57 in values else None
    gnss_distance = _f(values[15]) if 15 in values else None
    if can_distance is not None:
        counter.update(odometer_km=can_distance, odometer_method="ecu")
    elif gnss_distance is not None:
        counter.update(odometer_km=gnss_distance, odometer_method="tracker")

    position: dict = {}
    if all(i in values for i in (8, 9, 10, 11)) and values[8][0] & 0x02 and fix_t:
        lat = int.from_bytes(values[10], "little", signed=True) / 600_000
        lon = int.from_bytes(values[11], "little", signed=True) / 600_000
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            position = {"lat": lat, "lon": lon, "sats": values[8][0] >> 2}
            if 12 in values:
                position["alt"] = int.from_bytes(values[12], "little", signed=True) / 10
            if 13 in values and (speed := _f(values[13])) is not None:
                position["speed_kmh"] = speed
            if 14 in values:
                position["course"] = _u(values[14])
            if 71 in values:
                position["hdop"] = values[71][0] / 10

    result = []
    # The last fix time cannot date counters measured at a different, unknown event time.
    if counter and not event_t:
        raise ValueError("FLEX counters missing valid event time")
    if counter:
        result.append({"t": event_t, **counter})
    if position:
        if result and event_t == fix_t:
            result[0].update(position)
        else:
            result.append({"t": fix_t, **position})
    return result


def _standard_record(blob: bytes, selected: list[int]) -> tuple[dict[int, bytes], list[dict]]:
    values = {}
    pos = 0
    for number in selected:
        width = FIELD_SIZES[number - 1]
        values[number] = blob[pos : pos + width]
        pos += width
    if pos != len(blob):
        raise ValueError("invalid FLEX record length")
    return values, _records(values)


def _additional_record(blob: bytes) -> tuple[dict[int, bytes], list[dict]]:
    if len(blob) < 39 or blob[0] != 10 or blob[1] != 37:
        raise ValueError("unsupported FLEX additional record")
    values = {}
    pos = 2
    for number, width in ((1, 4), (2, 2), (3, 4), (8, 1), (9, 4), (10, 4),
                          (11, 4), (12, 4), (13, 4), (14, 2), (15, 4)):
        values[number] = blob[pos : pos + width]
        pos += width
    while pos < len(blob):
        if pos + 2 > len(blob) or pos + 2 + blob[pos + 1] > len(blob):
            raise ValueError("truncated FLEX dynamic field")
        # Dynamic fields may contain driver/card identifiers; never enqueue them.
        pos += 2 + blob[pos + 1]
    return values, _records(values)


class FlexSession:
    proto = "navtelecom_flex"

    def __init__(self, mapping: Mapping | None = None):
        self.buf = bytearray()
        self.ext_id: str | None = None
        self.mapping = mapping or Mapping()
        self.mask: bytes | None = None
        self.selected: list[int] = []
        self.record_size = 0
        self.version = 0

    def feed(self, data: bytes) -> list[tuple[list[dict], bytes]]:
        if len(data) > MAX_PENDING:
            raise ValueError("FLEX stream chunk exceeded")
        self.buf.extend(data)
        out: list[tuple[list[dict], bytes]] = []
        while self.buf:
            if self.buf[0] == 0x7F:
                del self.buf[:1]
                continue
            if b"@NTC".startswith(self.buf[:4]):
                if len(self.buf) < 16:
                    break
                header = self.buf[:16]
                if _xor(header[:15]) != header[15]:
                    del self.buf[:1]
                    continue
                length = struct.unpack_from("<H", header, 12)[0]
                if len(self.buf) < 16 + length:
                    break
                packet = bytes(self.buf[16 : 16 + length])
                del self.buf[: 16 + length]
                if length and _xor(packet) == header[14]:
                    receiver, sender = struct.unpack_from("<II", header, 4)
                    reply = self._ntcb_message(packet)
                    if reply:
                        out.append(([], _ntcb(reply, sender, receiver)))
                continue
            if self.buf[0] == ord("~"):
                if self.mask is None:
                    raise ValueError("FLEX telemetry before negotiation")
                size = self._frame_length()
                if size is None:
                    break
                packet = bytes(self.buf[:size])
                if crc8_egts(packet[:-1]) != packet[-1]:
                    # A corrupt length makes the next frame boundary ambiguous; retry on a new connection.
                    raise ValueError("FLEX frame checksum mismatch")
                del self.buf[:size]
                records, reply = self._flex_message(packet[:-1])
                out.append((records, _flex_reply(reply)))
                continue
            del self.buf[:1]
        if len(self.buf) > MAX_PENDING:
            raise ValueError("FLEX stream buffer exceeded")
        return out

    def _ntcb_message(self, packet: bytes) -> bytes:
        if packet.startswith(b"*>S:"):
            device = packet[4:]
            if len(device) != 15 or any(b < 48 or b > 57 for b in device):
                raise ValueError("invalid FLEX device identifier")
            identifier = device.decode("ascii")
            if self.ext_id is not None and self.ext_id != identifier:
                raise ValueError("FLEX device identity changed within session")
            self.ext_id = identifier
            self.mask = None
            return b"*<S"
        if packet.startswith(b"*>FLEX"):
            if self.ext_id is None or len(packet) < 10 or packet[6] != 0xB0:
                raise ValueError("FLEX negotiation without identity")
            protocol, structure, count = packet[7:10]
            if (protocol not in FIELD_COUNTS or structure not in FIELD_COUNTS
                    or count != FIELD_COUNTS[structure] or len(packet) != 10 + (count + 7) // 8):
                raise ValueError("invalid FLEX negotiation")
            accepted_protocol = min(protocol, 20)
            accepted_structure = min(structure, 20)
            if (accepted_protocol, accepted_structure) == (protocol, structure):
                selected = _selected(packet[10:], count)
                if 3 not in selected and any(i in selected for i in (15, 37, 57, 67)):
                    raise ValueError("FLEX counters require event time field 3")
                self.mask = packet[10:]
                self.selected = selected
                self.record_size = sum(FIELD_SIZES[i - 1] for i in self.selected)
                self.version = protocol
            else:
                self.mask = None
            return b"*<FLEX" + bytes([0xB0, accepted_protocol, accepted_structure])
        return b""

    def _frame_length(self) -> int | None:
        if len(self.buf) < 2:
            return None
        kind = chr(self.buf[1])
        if kind in ("A", "E", "T", "X") and len(self.buf) < (3 if kind in ("A", "E") else 6):
            return None
        if kind == "A":
            size = 4 + self.buf[2] * self.record_size
        elif kind == "T":
            size = 7 + self.record_size
        elif kind == "C":
            size = 3 + self.record_size
        elif kind in ("E", "X") and self.version >= 20:
            count = self.buf[2] if kind == "E" else 1
            pos = 3 if kind == "E" else 6
            for _ in range(count):
                if len(self.buf) < pos + 2:
                    return None
                length = struct.unpack_from("<H", self.buf, pos)[0]
                if length < 39 or pos + 2 + length + 1 > MAX_ADDITIONAL_FRAME:
                    raise ValueError("invalid FLEX additional frame length")
                pos += 2 + length
            size = pos + 1
        else:
            raise ValueError("unsupported FLEX message type")
        if kind in ("E", "X") and size > MAX_ADDITIONAL_FRAME:
            raise ValueError("FLEX additional frame too large")
        return size if len(self.buf) >= size else None

    def _flex_message(self, packet: bytes) -> tuple[list[dict], bytes]:
        kind = chr(packet[1])
        if kind in ("A", "T", "C"):
            count = packet[2] if kind == "A" else 1
            pos = 3 if kind == "A" else 6 if kind == "T" else 2
            records: list[dict] = []
            for _ in range(count):
                values, recs = _standard_record(packet[pos : pos + self.record_size], self.selected)
                if kind == "T" and 1 in values and _u(values[1]) != _u(packet[2:6]):
                    raise ValueError("FLEX event index mismatch")
                records.extend(recs)
                pos += self.record_size
            reply = packet[:3] if kind == "A" else packet[:6] if kind == "T" else packet[:2]
            return records, reply
        count = packet[2] if kind == "E" else 1
        pos = 3 if kind == "E" else 6
        records = []
        for _ in range(count):
            length = struct.unpack_from("<H", packet, pos)[0]
            values, recs = _additional_record(packet[pos + 2 : pos + 2 + length])
            if kind == "X" and _u(values[1]) != _u(packet[2:6]):
                raise ValueError("FLEX additional event index mismatch")
            records.extend(recs)
            pos += 2 + length
        reply = packet[:3] if kind == "E" else packet[:6]
        return records, reply
