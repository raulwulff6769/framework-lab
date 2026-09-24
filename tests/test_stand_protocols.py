"""Encoders of the live stand against the gateway decoders (and the CRC reference value)."""

import socket
import struct
import threading

from gateway.itles_gateway.protocols.egts import EgtsSession
from gateway.itles_gateway.protocols.retranslator import RetranslatorSession
from gateway.itles_gateway.records import Mapping, parse_dtc
from sim.crc import crc16_arc
from sim.protocols import egts, egts_retranslator, teltonika, wialon_retranslator


def test_crc16_ibm_check_value():
    # CRC-16/ARC (IBM, poly 0xA001 reflected, init 0) check value from the CRC catalogue
    assert crc16_arc(b"123456789") == 0xBB3D


def test_teltonika_codec8e_round_trip_and_io_sizes():
    recs = [
        teltonika.AvlRecord(1_758_690_000_000, 45.6321, 38.9712, 34, 91, 17, 9, io={239: 1, 240: 1, 85: 1650, 84: 6405, 89: 64, 87: 812_345_000, 103: 734_520, 66: 27_800}),
        teltonika.AvlRecord(1_758_690_030_000, 45.6325, 38.9716, 35, 92, 16, 10, io={239: 1, 240: 1, 16: 5_000_123}),
    ]
    pkt = teltonika.avl_packet(recs)
    assert pkt[:4] == b"\x00\x00\x00\x00" and pkt[8] == 0x8E
    out = teltonika.decode_avl(pkt)
    assert [r.io for r in out] == [r.io for r in recs]
    assert abs(out[0].lat - 45.6321) < 1e-7 and out[1].speed_kmh == 10
    assert teltonika.imei_packet("352102127408282") == b"\x00\x0f352102127408282"


def test_teltonika_tcp_session_is_acknowledged():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    got = {}

    def serve():
        c, _ = srv.accept()
        n = struct.unpack(">H", c.recv(2))[0]
        got["imei"] = c.recv(n).decode()
        c.sendall(b"\x01")
        head = c.recv(8)
        length = struct.unpack(">I", head[4:])[0]
        body = b""
        while len(body) < length + 4:
            body += c.recv(65536)
        got["records"] = teltonika.decode_avl(head + body)
        c.sendall(struct.pack(">I", len(got["records"])))
        c.close()

    th = threading.Thread(target=serve)
    th.start()
    recs = [teltonika.AvlRecord(1_758_690_000_000 + i * 30_000, 45.63, 38.97, 30, 0, 12, 0) for i in range(3)]
    st = teltonika.send_records("127.0.0.1", srv.getsockname()[1], "352102127408282", recs)
    th.join(5)
    srv.close()
    assert got["imei"] == "352102127408282" and st["acked"] == 3 and len(got["records"]) == 3


def test_wialon_retranslator_round_trip_with_sensors_and_dtc():
    m = Mapping(param_hours={"eng_hours": "ecu"}, sensors={"rpm": {"param": "rpm"}, "fuel_level_pct": {"param": "fuel_pct"}})
    s = RetranslatorSession(m)
    pkt = wialon_retranslator.encode("868183036457856", 1_758_690_000, 45.6471, 38.9255, 31.0, 6, 180, 15,
                                     {"eng_hours": 812.35, "rpm": 1850, "fuel_pct": 57.2, "dtc": "100.1.2;110.0"})
    (recs, ack), = s.feed(pkt)
    assert ack == b"\x11" and s.ext_id == "868183036457856"
    r = recs[0]
    assert abs(r["lat"] - 45.6471) < 1e-9 and r["speed_kmh"] == 6 and r["engine_hours"] == 812.35
    assert r["sensors"] == {"rpm": 1850, "fuel_level_pct": 57.2}
    assert r["dtc"] == [{"spn": 100, "fmi": 1, "oc": 2}, {"spn": 110, "fmi": 0}]


def test_parse_dtc_ignores_garbage_and_empty():
    assert parse_dtc("") == []
    assert parse_dtc("x;100;98.1") == [{"spn": 98, "fmi": 1}]


def test_egts_dispatcher_retranslation_carries_object_ids_and_fuel():
    s = EgtsSession(Mapping(egts_hours_counter=1, egts_hours_scale=0.1))
    s.mappings = {"7011043": Mapping(egts_hours_counter=1, egts_hours_scale=0.1, sensors={"fuel_level_l": {"egts_lls": 1}})}
    auth = egts.transport(egts.record(1, egts.SERVICE_AUTH, egts_retranslator.dispatcher_identity(9001, description="Omnicomm Online")), 0)
    (recs, reply), = s.feed(auth)
    assert recs == [] and s.dispatcher
    frames, _ = egts.split_frames(reply)
    assert [egts.decode(f)["type"] for f in frames] == [egts.PT_RESPONSE, egts.PT_APPDATA]

    def point(t, lat):
        return egts.EgtsPoint(t, lat, 34.46, True, 54.0, 90, 0.0, 0, 120, 14, 0.9, True, False, {1: 18_234})

    body = b""
    for rn, (oid, t) in enumerate([(7011043, 1_758_690_000), (7011044, 1_758_690_010)], start=2):
        subs = egts.pos_data(point(t, 62.9)) + egts.ext_pos_data(point(t, 62.9)) + egts.abs_counters({1: 18_234}) + egts_retranslator.liquid_level(1, 211.4)
        body += egts.record(rn, egts.SERVICE_TELEDATA, subs, object_id=oid)
    (recs, reply), = s.feed(egts.transport(body, 1))
    assert [r["_ext"] for r in recs] == ["7011043", "7011044"]
    assert recs[0]["sensors"] == {"fuel_level_l": 211.4} and recs[0]["engine_hours"] == 1823.4
    assert "sensors" not in recs[1]  # the second object has no fuel mapping
    assert egts.decode(egts.split_frames(reply)[0][0])["result"] == 0
