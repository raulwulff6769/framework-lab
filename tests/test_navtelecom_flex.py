"""Navtelecom FLEX v6.2 manufacturer examples and independent synthetic frames."""

import asyncio
import json
import os
import struct
import sys

import pytest

sys.path[:0] = [os.path.join(os.path.dirname(__file__), "..", "gateway"), os.path.join(os.path.dirname(__file__), "..")]

from itles_gateway.crc import crc8_egts  # noqa: E402
from itles_gateway.protocols.navtelecom_flex import FIELD_SIZES, FlexSession  # noqa: E402
from itles_gateway.queue import DurableQueue  # noqa: E402
from itles_gateway.server import Gateway  # noqa: E402
from sim.protocols import navtelecom as sim_flex  # noqa: E402

DEVICE = "111111111111111"  # synthetic ID, never a customer tracker
EVENT_T = 1789466400
FIX_T = EVENT_T - 60
TEST_LAT = 1.234567  # synthetic offshore point, not a captured location
TEST_LON = -150.234567
FIELDS = (1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 37, 57, 67, 71)
MASK = sim_flex.flex_mask(FIELDS)


def _value_map(index=17, event_t=EVENT_T, fix_t=FIX_T, valid=True):
    return {
        1: struct.pack("<I", index), 2: struct.pack("<H", 123), 3: struct.pack("<I", event_t),
        8: bytes([(12 << 2) | 0x01 | (0x02 if valid else 0x00)]), 9: struct.pack("<I", fix_t),
        10: struct.pack("<i", round(TEST_LAT * 600_000)),
        11: struct.pack("<i", round(TEST_LON * 600_000)),
        12: struct.pack("<i", 1400), 13: struct.pack("<f", 7.5),
        14: struct.pack("<H", 93), 15: struct.pack("<f", 1230.5),
        37: struct.pack("<I", 4600 * 3600), 57: struct.pack("<f", 1234.5),
        67: struct.pack("<I", 4521 * 3600), 71: bytes((9, 12)),
    }


def _ready(fields=FIELDS, version=20):
    s = FlexSession()
    (records, reply), = s.feed(sim_flex.ntcb(b"*>S:" + DEVICE.encode()))
    assert not records and reply == sim_flex.ntcb(b"*<S", receiver=0, sender=1)
    (records, reply), = s.feed(sim_flex.flex_negotiation(fields, protocol_version=version, structure_version=version))
    assert not records and reply == sim_flex.ntcb(b"*<FLEX\xb0" + bytes((version, version)), receiver=0, sender=1)
    return s


def test_manufacturer_annex_a3_negotiation_and_telemetry():
    data = json.load(open(os.path.join(os.path.dirname(__file__), "data", "navtelecom_vectors.json"), encoding="utf-8"))
    assert data["_source"]["evidence_category"] == "manufacturer example"
    samples = {v["name"]: v for v in data["vectors"]}
    negotiation = bytes.fromhex(samples["flex_2_0_protocol_negotiation"]["packet_hex"])
    sample = bytes.fromhex(samples["flex_2_0_telemetry_array"]["packet_hex"])
    assert len(FIELD_SIZES) == 122
    assert sim_flex.ntcb(bytes.fromhex(samples["flex_2_0_protocol_negotiation"]["payload_hex"])) == negotiation
    assert sim_flex.flex_frame("A", bytes.fromhex(samples["flex_2_0_telemetry_array"]["payload_hex"])) == sample
    assert crc8_egts(sample[:-1]) == sample[-1]

    s = FlexSession()
    s.feed(sim_flex.ntcb(b"*>S:" + DEVICE.encode()))
    (records, reply), = s.feed(negotiation)
    assert not records and reply == sim_flex.ntcb(b"*<FLEX\xb0\x14\x14", receiver=0, sender=1)
    (records, reply), = s.feed(sample)
    assert not records  # vendor sample contains voltage/GSM, not ITles metrics
    assert reply == sim_flex.flex_frame("A", b"\x01")


def test_flex_archive_preserves_event_and_fix_times_with_ecu_counters():
    s = _ready()
    record = sim_flex.flex_record(_value_map(), MASK)
    frame = sim_flex.flex_frame("A", b"\x01" + record)
    (records, ack), = s.feed(frame)
    assert ack == sim_flex.flex_frame("A", b"\x01")
    assert len(records) == 2
    assert records[0] == {"t": EVENT_T, "engine_hours": 4521.0, "engine_hours_method": "ecu",
                          "odometer_km": 1234.5, "odometer_method": "ecu"}
    assert records[1]["t"] == FIX_T
    assert records[1]["sats"] == 12 and records[1]["hdop"] == 0.9
    assert abs(records[1]["lat"] - TEST_LAT) < 1e-6
    assert abs(records[1]["lon"] - TEST_LON) < 1e-6
    assert records[1]["speed_kmh"] == 7.5 and records[1]["alt"] == 140


def test_flex_requires_event_time_for_counters_and_never_reuses_fix_time():
    selected = (8, 9, 10, 11, 57, 67)
    s = FlexSession()
    s.feed(sim_flex.ntcb(b"*>S:" + DEVICE.encode()))
    with pytest.raises(ValueError, match="require event time field 3"):
        s.feed(sim_flex.negotiation(selected))
    assert s.mask is None

    selected = (3, *selected)
    s = _ready(selected)
    source = _value_map(event_t=0)
    packet = sim_flex.frame("C", sim_flex.record({i: source[i] for i in selected}))
    with pytest.raises(ValueError, match="counters missing valid event time"):
        s.feed(packet)

    selected = (3, 8, 9, 10, 11)
    s = _ready(selected)
    packet = sim_flex.frame("C", sim_flex.record({i: source[i] for i in selected}))
    (records, ack), = s.feed(packet)
    assert ack == sim_flex.frame("C", b"")
    assert len(records) == 1 and records[0]["t"] == FIX_T
    assert "lat" in records[0] and "lon" in records[0]


def test_flex_bad_fix_keeps_counters_and_current_state_ack_has_no_index():
    s = _ready()
    invalid = sim_flex.flex_frame("A", b"\x01" + sim_flex.flex_record(_value_map(valid=False), MASK))
    (records, ack), = s.feed(invalid)
    assert ack == sim_flex.flex_frame("A", b"\x01")
    assert len(records) == 1 and records[0]["engine_hours"] == 4521
    assert "lat" not in records[0] and "lon" not in records[0]

    current = sim_flex.flex_frame("C", sim_flex.flex_record(_value_map(index=0, event_t=EVENT_T, fix_t=EVENT_T), MASK))
    (records, ack), = s.feed(current)
    assert ack == sim_flex.flex_frame("C", b"")  # vendor §1.2: unlike Traccar, no record index in ~C ACK
    assert len(records) == 1 and records[0]["t"] == EVENT_T and "lat" in records[0]


def test_flex_partial_tcp_frames_ping_and_corrupt_checksums():
    s = FlexSession()
    stream = sim_flex.ntcb(b"*>S:" + DEVICE.encode()) + sim_flex.flex_negotiation(FIELDS)
    replies = []
    for i in range(0, len(stream), 5):
        replies.extend(s.feed(stream[i : i + 5]))
    assert len(replies) == 2 and s.ext_id == DEVICE
    assert s.feed(b"\x7f") == []

    frame = sim_flex.flex_frame("T", struct.pack("<I", 17) + sim_flex.flex_record(_value_map(), MASK))
    with pytest.raises(ValueError, match="checksum mismatch"):
        s.feed(frame[:-1] + bytes((frame[-1] ^ 1,)))
    s = _ready()
    replies = []
    for i in range(0, len(frame), 7):
        replies.extend(s.feed(frame[i : i + 7]))
    assert len(replies) == 1
    records, ack = replies[0]
    assert len(records) == 2 and ack == sim_flex.flex_frame("T", struct.pack("<I", 17))

    bad_header = bytearray(sim_flex.ntcb(b"*>S:" + DEVICE.encode()))
    bad_header[15] ^= 1
    assert FlexSession().feed(bytes(bad_header)) == []
    bad_data = bytearray(sim_flex.ntcb(b"*>S:" + DEVICE.encode()))
    bad_data[-1] ^= 1
    assert FlexSession().feed(bytes(bad_data)) == []


def test_flex_wide_mask_archive_and_coalesced_maximum_ntcb_packets():
    s = _ready(range(1, 123))
    wide_record = bytearray(sum(FIELD_SIZES))
    assert len(wide_record) == 403
    wide_record[sum(FIELD_SIZES[:2]):sum(FIELD_SIZES[:3])] = struct.pack("<I", EVENT_T)
    for count in (21, 255):
        packet = sim_flex.frame("A", wide_record * count, count=count)
        cut = min(len(packet) - 1, 65536)
        assert s.feed(packet[:cut]) == []
        (records, ack), = s.feed(packet[cut:])
        assert len(records) == count and all(r["t"] == EVENT_T for r in records)
        assert ack == sim_flex.frame("A", b"", count=count)

    s = FlexSession()
    maximum = sim_flex.ntcb(b"?" * 65535)
    next_packet = sim_flex.ntcb(b"?" * 65519)
    assert len(maximum[-1:] + next_packet) == 65536
    assert s.feed(maximum[:-1]) == []
    assert s.feed(maximum[-1:] + next_packet) == []
    assert not s.buf
    (records, reply), = s.feed(sim_flex.ntcb(b"*>S:" + DEVICE.encode()))
    assert not records and reply == sim_flex.ntcb(b"*<S", receiver=0, sender=1)


def _additional(index=17, dynamic=b""):
    static = struct.pack("<IHI", index, 123, EVENT_T)
    static += bytes([(12 << 2) | 0x02])
    static += struct.pack("<IiiifHf", FIX_T, round(TEST_LAT * 600_000),
                          round(TEST_LON * 600_000), 1400, 7.5, 93, 1230.5)
    assert len(static) == 37
    payload = b"\x0a\x25" + static + dynamic
    return struct.pack("<H", len(payload)) + payload


def test_flex_2_additional_archive_skips_driver_identifiers_and_unknown_fields():
    s = _ready()
    dynamic = b"\x02\x10" + bytes(16) + b"\x90\x03\x01\x02\x03"
    encoded = _additional(dynamic=dynamic)
    for kind, body in (("E", b"\x01" + encoded), ("X", struct.pack("<I", 17) + encoded)):
        packet = sim_flex.flex_frame(kind, body)
        (records, ack), = s.feed(packet)
        expected_ack = b"\x01" if kind == "E" else struct.pack("<I", 17)
        assert ack == sim_flex.flex_frame(kind, expected_ack)
        assert records[0] == {"t": EVENT_T, "odometer_km": 1230.5, "odometer_method": "tracker"}
        assert records[1]["t"] == FIX_T and abs(records[1]["lat"] - TEST_LAT) < 1e-6
        assert not any("driver" in key or "card" in key for rec in records for key in rec)

    malformed = _additional(dynamic=b"\x90\x04\x01")
    with pytest.raises(ValueError, match="truncated FLEX dynamic field"):
        s.feed(sim_flex.flex_frame("E", b"\x01" + malformed))


@pytest.mark.parametrize("kind", ("E", "X"))
def test_flex_corrupt_additional_length_never_swallows_next_frame(kind):
    s = _ready()
    packet = bytearray(sim_flex.frame(kind, _additional(), count=1 if kind == "E" else None,
                                     event_index=17 if kind == "X" else None))
    packet[3 if kind == "E" else 6] += 1
    assert s.feed(bytes(packet)) == []
    valid = sim_flex.frame("A", sim_flex.flex_record(_value_map(), MASK), count=1)
    with pytest.raises(ValueError, match="checksum mismatch"):
        s.feed(valid)
    s = _ready()
    (records, reply), = s.feed(valid)
    assert records and reply == sim_flex.frame("A", b"", count=1)


def test_flex_downgrades_v3_and_rejects_inconsistent_frames_without_ack():
    s = FlexSession()
    s.feed(sim_flex.ntcb(b"*>S:" + DEVICE.encode()))
    (records, reply), = s.feed(sim_flex.flex_negotiation(FIELDS, protocol_version=30, structure_version=30))
    assert not records and s.mask is None
    assert reply == sim_flex.ntcb(b"*<FLEX\xb0\x14\x14", receiver=0, sender=1)
    with pytest.raises(ValueError, match="before negotiation"):
        s.feed(sim_flex.flex_frame("A", b"\x01"))

    s = _ready()
    mismatched = sim_flex.flex_frame("T", struct.pack("<I", 18) + sim_flex.flex_record(_value_map(index=17), MASK))
    with pytest.raises(ValueError, match="index mismatch"):
        s.feed(mismatched)
    with pytest.raises(ValueError, match="identity changed"):
        s.feed(sim_flex.ntcb(b"*>S:" + b"222222222222222"))


def test_flex_v1_archive_and_multiple_records_in_one_frame():
    selected = (1, 2, 3, 8, 9, 10, 11, 15, 37, 57, 67)
    mask = sim_flex.flex_mask(selected, version=10)
    s = _ready(selected, version=10)
    records = [sim_flex.flex_record({k: v for k, v in _value_map(index=i).items() if k in selected}, mask, version=10)
               for i in (17, 18)]
    (decoded, ack), = s.feed(sim_flex.flex_frame("A", b"\x02" + b"".join(records)))
    assert len(decoded) == 4 and ack == sim_flex.flex_frame("A", b"\x02")
    with pytest.raises(ValueError, match="unsupported FLEX message"):
        s.feed(sim_flex.flex_frame("E", b"\x00"))


def test_flex_tcp_ack_follows_durable_queue_commit(tmp_path, monkeypatch):
    q = DurableQueue(str(tmp_path / "q.sqlite3"))
    gw = Gateway(q)
    frame = sim_flex.flex_frame("A", b"\x01" + sim_flex.flex_record(_value_map(), MASK))

    async def exercise(fail_write=False):
        server = await asyncio.start_server(gw.handler("navtelecom_flex"), "127.0.0.1", 0)
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
            try:
                writer.write(sim_flex.ntcb(b"*>S:" + DEVICE.encode()))
                await writer.drain()
                assert await asyncio.wait_for(reader.readexactly(19), 2) == sim_flex.ntcb(b"*<S", receiver=0, sender=1)
                writer.write(sim_flex.flex_negotiation(FIELDS))
                await writer.drain()
                assert await asyncio.wait_for(reader.readexactly(25), 2) == sim_flex.ntcb(
                    b"*<FLEX\xb0\x14\x14", receiver=0, sender=1,
                )
                if fail_write:
                    monkeypatch.setattr(q, "put", lambda *_args: (_ for _ in ()).throw(OSError("synthetic disk fault")))
                writer.write(frame)
                await writer.drain()
                if fail_write:
                    assert await asyncio.wait_for(reader.read(), 2) == b""  # no ACK on failed commit
                else:
                    assert await asyncio.wait_for(reader.readexactly(4), 2) == sim_flex.flex_frame("A", b"\x01")
            finally:
                writer.close()
                await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(exercise())
    assert q.size() == 2
    assert [record[2]["t"] for record in q.take()] == [EVENT_T, FIX_T]
    reopened = DurableQueue(str(tmp_path / "q.sqlite3"))
    assert reopened.size() == 2
    reopened.close()
    asyncio.run(exercise(fail_write=True))
    assert q.size() == 2 and gw.stats["errors"] == 1
    q.close()


def test_flex_tcp_missing_counter_time_closes_without_ack_or_queue_entry(tmp_path):
    q = DurableQueue(str(tmp_path / "q.sqlite3"))
    gw = Gateway(q)
    frame = sim_flex.frame("A", sim_flex.flex_record(_value_map(event_t=0), MASK), count=1)

    async def exercise():
        server = await asyncio.start_server(gw.handler("navtelecom_flex"), "127.0.0.1", 0)
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
            try:
                writer.write(sim_flex.ntcb(b"*>S:" + DEVICE.encode()) + sim_flex.negotiation(FIELDS))
                await writer.drain()
                assert await asyncio.wait_for(reader.readexactly(19), 2) == sim_flex.ntcb(
                    b"*<S", receiver=0, sender=1,
                )
                assert await asyncio.wait_for(reader.readexactly(25), 2) == sim_flex.ntcb(
                    b"*<FLEX\xb0\x14\x14", receiver=0, sender=1,
                )
                writer.write(frame)
                await writer.drain()
                assert await asyncio.wait_for(reader.read(), 2) == b""
            finally:
                writer.close()
                await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(exercise())
    assert q.size() == 0 and gw.stats["errors"] == 1
    q.close()
