"""Gateway decoders against real device packets (Traccar test suite) and the simulator encoders."""

import http.server
import json
import os
import socket
import stat
import struct
import sys
import tempfile
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gateway"))

from itles_gateway.crc import crc16_ccitt, crc8_egts  # noqa: E402
from itles_gateway.forwarder import Forwarder  # noqa: E402
from itles_gateway.protocols.egts import EgtsSession  # noqa: E402
from itles_gateway.protocols.galileosky import GalileoskySession, parse_packet  # noqa: E402
from itles_gateway.protocols.retranslator import RetranslatorSession  # noqa: E402
from itles_gateway.protocols.wialon_ips import WialonIpsSession, parse_data_body  # noqa: E402
from itles_gateway.queue import DurableQueue  # noqa: E402
from itles_gateway.records import Mapping  # noqa: E402
from sim.protocols import egts as sim_egts  # noqa: E402
from sim.protocols import galileosky as sim_gs  # noqa: E402
from sim.protocols import wialon_ips as sim_wialon  # noqa: E402


def test_galileosky_real_packets(vectors):
    decoded = 0
    for h in vectors["galileosky_main"]:
        pkt = bytes.fromhex(h)
        s = GalileoskySession()
        s.ext_id = "preset"  # packets captured mid-session carry no IMEI
        out = s.feed(pkt)
        assert len(out) == 1
        records, ack = out[0]
        assert ack == b"\x02" + pkt[-2:]
        decoded += len(records)
    assert decoded >= 12
    # first vector: head+record; values decoded per the official tag table
    s = GalileoskySession()
    (records, _), = s.feed(bytes.fromhex(vectors["galileosky_main"][0]))
    assert s.ext_id == "868345032042426"
    r = records[0]
    assert r["t"] == 0x5B9FAA7C and r["sats"] == 12 and r["alt"] == 696 and r["hdop"] == 0.5
    assert abs(r["lat"] - 24.709763) < 1e-9 and abs(r["lon"] - 46.665418) < 1e-9


def test_galileosky_round_trip_engine_hours_and_can_distance():
    rec = sim_gs.GalileoRecord(
        index=1, t=1789466400, lat=61.784912, lon=34.346901, valid=True, sats=11, speed_kmh=7.4, course=93.0,
        alt_m=140, hdop=0.9, inputs=1, power_mv=27800, gps_odometer_m=5_000_123, can_b0_raw=2_000_000,
        engine_hours_x100=452_137,
    )
    packets = [sim_gs.head_packet("356307042441013")] + sim_gs.records_packets([rec], archive=True)
    s = GalileoskySession()
    out = [x for p in packets for x in s.feed(p)]
    recs = [r for rs, _ in out for r in rs]
    assert s.ext_id == "356307042441013" and len(recs) == 1
    r = recs[0]
    assert r["engine_hours"] == 4521.37 and r["engine_hours_method"] == "ecu"
    assert r["odometer_km"] == 10_000.0 and r["odometer_method"] == "ecu"  # 2e6 * 5 m
    assert abs(r["lat"] - 61.784912) < 1e-9 and r["speed_kmh"] == 7.4
    # split across TCP segments
    s2 = GalileoskySession()
    stream = b"".join(packets)
    got = []
    for i in range(0, len(stream), 7):
        got += s2.feed(stream[i : i + 7])
    assert sum(len(rs) for rs, _ in got) == 1


def test_galileosky_invalid_fix_keeps_counters_drops_coordinates():
    rec = sim_gs.GalileoRecord(index=2, t=1789466460, lat=61.0, lon=34.0, valid=False, sats=2, speed_kmh=0, course=0,
                               alt_m=0, hdop=9.9, inputs=0, power_mv=24000, gps_odometer_m=0, engine_hours_x100=100)
    s = GalileoskySession()
    s.feed(sim_gs.head_packet("356307042441013"))
    (recs, _), = s.feed(sim_gs.records_packets([rec], archive=False)[0])
    assert "lat" not in recs[0] and recs[0]["engine_hours"] == 1.0


def test_wialon_ips_real_packets(vectors):
    v = vectors["wialon_v2_with_crc"]
    s = WialonIpsSession()
    assert s.feed((v[0] + "\r\n").encode()) == [([], b"#AL#1\r\n")]
    assert s.ext_id == "42001300083" and s.login_crc_ok is False  # CRC over a redacted password
    (recs, ack), = s.feed((v[1] + "\r\n").encode())
    assert ack == b"#ASD#1\r\n"
    assert abs(recs[0]["lat"] - (55 + 54.350052 / 60)) < 1e-9 and abs(recs[0]["lon"] - (36 + 44.670410 / 60)) < 1e-9
    for line in v[2:5]:
        (recs, ack), = s.feed((line + "\r\n").encode())
        assert ack == b"#AD#1\r\n", line
    bad = v[2][:-4] + "0000"
    assert s.feed((bad + "\r\n").encode())[0][1] == b"#AD#16\r\n"


def test_wialon_ips_round_trip_params_and_blackbox():
    m = sim_wialon.WialonMessage(t=1789466400, lat=61.784912, lon=-34.346901, speed_kmh=12, course=270, alt_m=150,
                                 sats=9, hdop=1.1, inputs=1, params={"can_engine_hours": 4521.37, "mileage": 1234.5})
    s = WialonIpsSession()
    s.feed(sim_wialon.login("356307042441013", "pw"))
    (recs, ack), = s.feed(sim_wialon.data(m))
    assert ack == b"#AD#1\r\n"
    r = recs[0]
    assert r["engine_hours"] == 4521.37 and r["engine_hours_method"] == "ecu"
    assert r["odometer_km"] == 1234.5 and r["odometer_method"] == "tracker"
    assert abs(r["lat"] - 61.784912) < 1e-6 and abs(r["lon"] + 34.346901) < 1e-6
    (recs, ack), = s.feed(sim_wialon.blackbox([m] * 3))
    assert ack == b"#AB#3\r\n" and len(recs) == 3


@pytest.mark.parametrize(("sats", "hdop", "valid"), [
    (2, 0.9, False), (2, 99, False), (3, 0.9, True), (4, 49.9, True), (4, 50, False),
    (4, -1, False), (12, float("nan"), True),
])
def test_wialon_ips_gnss_quality_keeps_counters(sats, hdop, valid):
    m = sim_wialon.WialonMessage(t=1789466400, lat=1.25, lon=-150.25, speed_kmh=0, course=0,
                                 alt_m=100, sats=sats, hdop=hdop, inputs=1, params={"can_engine_hours": 4521.0})
    s = WialonIpsSession()
    s.feed(sim_wialon.login("111111111111111"))
    (records, ack), = s.feed(sim_wialon.data(m))
    assert ack == b"#AD#1\r\n"
    assert len(records) == 1 and records[0]["engine_hours"] == 4521.0
    assert ("lat" in records[0] and "lon" in records[0]) is valid
    if hdop != hdop:
        assert "hdop" not in records[0]


def test_wialon_ips_invalid_coordinate_is_omitted_without_losing_counters():
    m = sim_wialon.WialonMessage(t=1789466400, lat=1.25, lon=-150.25, speed_kmh=0, course=0,
                                 alt_m=100, sats=12, hdop=0.9, inputs=1, params={"can_engine_hours": 4521.0})
    fields = sim_wialon._body(m).split(";")
    fields[2] = "nan"
    rec = parse_data_body(fields, Mapping(), short=False)
    assert rec == {"t": m.t, "engine_hours": 4521.0, "engine_hours_method": "ecu"}


def _egts_response_ok(resp: bytes, pid: int) -> None:
    hl = resp[3]
    assert crc8_egts(resp[: hl - 1]) == resp[hl - 1]
    fdl = struct.unpack_from("<H", resp, 5)[0]
    assert crc16_ccitt(resp[hl : hl + fdl]) == struct.unpack_from("<H", resp, hl + fdl)[0]
    assert resp[9] == 0 and struct.unpack_from("<HB", resp, hl) == (pid, 0)


def test_egts_real_packets(vectors):
    appdata = 0
    for h in vectors["egts"]:
        pkt = bytes.fromhex(h)
        s = EgtsSession(Mapping(egts_hours_counter=None))
        s.ext_id = "preset"
        out = s.feed(pkt)
        if pkt[9] == 1:
            appdata += 1
            assert len(out) == 1
            _egts_response_ok(out[0][1], struct.unpack_from("<H", pkt, 7)[0])
    assert appdata >= 10


def test_egts_round_trip_auth_position_odometer_counter():
    ident = sim_egts.transport(sim_egts.record(1, 1, sim_egts.term_identity(7001, "868204005185938")), 1)
    p = sim_egts.EgtsPoint(t=1789466400, lat=61.784912, lon=34.346901, valid=True, speed_kmh=23.4, course=301,
                           odometer_km=1234.5, inputs=1, alt_m=150, sats=10, hdop=0.9, moving=True, blackbox=False,
                           counters={})
    tele = sim_egts.transport(
        sim_egts.record(2, 2, sim_egts.pos_data(p) + sim_egts.ext_pos_data(p) + sim_egts.abs_counters({3: 45213})), 2
    )
    s = EgtsSession(Mapping(egts_hours_counter=3, egts_hours_scale=0.1))
    out = s.feed(ident + tele)
    assert s.ext_id == "868204005185938"
    _egts_response_ok(out[0][1], 1)
    assert b"\x09\x01\x00\x00" in out[0][1]  # EGTS_SR_RESULT_CODE (ГОСТ 33472: code 9), RCD=0
    r = out[1][0][0]
    assert r["t"] == 1789466400 and abs(r["lat"] - 61.784912) < 1e-6 and r["speed_kmh"] == 23.4
    assert r["odometer_km"] == 1234.5 and r["engine_hours"] == 4521.3


def test_wialon_retranslator_real_packets(vectors):
    s = RetranslatorSession()
    out = s.feed(bytes.fromhex(vectors["wialon_retranslator"][0]))
    (recs, ack), = out
    assert ack == b"\x11" and s.ext_id == "353976013445485"
    r = recs[0]
    assert r["t"] == 0x4B0BFB70 and r["sats"] == 11 and r["speed_kmh"] == 54 and r["course"] == 326
    assert 55.7 < r["lat"] < 55.8 and 49.1 < r["lon"] < 49.3  # Kazan
    (recs2, _), = RetranslatorSession().feed(bytes.fromhex(vectors["wialon_retranslator"][1]))
    assert recs2 and "t" in recs2[0]


def test_queue_survives_restart_and_parks_unknown_devices():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "q.sqlite3")
        q = DurableQueue(path)
        q.put("1", "egts", [{"t": 1, "lat": 1.0, "lon": 1.0}, {"t": 2, "lat": 1.0, "lon": 1.0}])
        q.db.close()  # "crash" without ack
        q = DurableQueue(path)
        items = q.take()
        assert [i[2]["t"] for i in items] == [1, 2]
        q.retry([items[0][0]], "unknown_device", park=True)
        assert [i[2]["t"] for i in q.take()] == [2]
        q.ack([items[1][0]])
        assert q.size() == 1


def test_queue_and_wal_are_private_even_under_permissive_umask(tmp_path):
    path = tmp_path / "q.sqlite3"
    previous_umask = os.umask(0o022)
    try:
        q = DurableQueue(str(path))
        q.put("device", "egts", [{"t": 1, "lat": 1.0, "lon": 2.0}])
        files = [path, tmp_path / "q.sqlite3-wal", tmp_path / "q.sqlite3-shm"]
        assert all(f.exists() and stat.S_IMODE(f.stat().st_mode) == 0o600 for f in files)

        for f in files:
            f.chmod(0o644)
        reopened = DurableQueue(str(path))
        assert reopened.size() == 1
        assert all(stat.S_IMODE(f.stat().st_mode) == 0o600 for f in files)
        reopened.close()
        q.close()
    finally:
        os.umask(previous_umask)


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="platform lacks no-follow open")
def test_queue_rejects_symlink_path(tmp_path):
    target = tmp_path / "target.sqlite3"
    target.touch()
    link = tmp_path / "q.sqlite3"
    link.symlink_to(target)
    with pytest.raises(OSError):
        DurableQueue(str(link))


def test_queue_requires_directory_not_writable_by_other_users(tmp_path):
    directory = tmp_path / "shared"
    directory.mkdir()
    directory.chmod(0o777)
    try:
        with pytest.raises(OSError, match="directory must not be writable"):
            DurableQueue(str(directory / "q.sqlite3"))
        assert not (directory / "q.sqlite3").exists()
    finally:
        directory.chmod(0o700)


class _Api(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self.server.seen.append((self.headers["authorization"], body))
        recs = body["records"]
        results = []
        for ext in sorted({r["ext_id"] for r in recs}):
            idx = [i for i, r in enumerate(recs) if r["ext_id"] == ext]
            if ext == "unknown":
                results.append({"ext_id": ext, "status": "unknown_device", "indexes": idx})
            else:
                rej = [{"index": i, "reason": "time_too_old"} for i in idx if recs[i]["t"] < 100]
                results.append({"ext_id": ext, "status": "ok", "rejected": rej})
        out = json.dumps({"results": results}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


def test_forwarder_acks_only_confirmed_records():
    srv = http.server.HTTPServer(("127.0.0.1", 0), _Api)
    srv.seen = []
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as d:
        q = DurableQueue(os.path.join(d, "q.sqlite3"))
        q.put("868204005185938", "egts", [{"t": 1789466400, "lat": 61.0, "lon": 34.0}, {"t": 5, "lat": 61.0, "lon": 34.0}])
        q.put("unknown", "egts", [{"t": 1789466401, "lat": 55.0, "lon": 37.0}])
        f = Forwarder(q, f"http://127.0.0.1:{srv.server_port}", "token-123")
        assert f.run_once() == 2  # stored + permanently rejected
        assert q.size() == 1  # unknown tracker parked, not lost
        assert srv.seen[0][0] == "Bearer token-123"
        srv.shutdown()
        # platform down: nothing is dropped
        f2 = Forwarder(q, "http://127.0.0.1:9", "token-123", timeout=1)
        q.db.execute("update q set next_try = 0")
        assert f2.run_once() == 0 and q.size() == 1


@pytest.mark.parametrize("response", [
    {"results": [{"ext_id": "known", "status": "error", "rejected": []}]},
    {"results": [{"ext_id": "known", "rejected": []}]},
    {"results": [{"ext_id": "known", "status": "ok"}]},
    {"results": [{"ext_id": "known", "status": "ok", "rejected": [{"index": True, "reason": "bad_time"}]}]},
    {"results": [{"ext_id": "known", "status": "ok", "rejected": [{"index": 1, "reason": "bad_time"}]}]},
    {"results": [{"ext_id": "known", "status": "unknown_device", "indexes": [1]}]},
    {"results": [{"ext_id": "known", "status": "ok", "rejected": []},
                 {"ext_id": "known", "status": "ok", "rejected": []}]},
    {"results": []},
    {"message": "temporary failure"},
])
def test_forwarder_retains_records_without_valid_confirmation(tmp_path, monkeypatch, response):
    q = DurableQueue(str(tmp_path / "q.sqlite3"))
    q.put("known", "egts", [{"t": 1}])
    f = Forwarder(q, "http://127.0.0.1:9", "test-token")
    monkeypatch.setattr(f, "post", lambda _records: response)

    assert f.run_once() == 0
    assert q.size() == 1
    assert q.take() == []  # unconfirmed data gets backoff, not a hot retry loop
    tries, error = q.db.execute("select tries, last_error from q").fetchone()
    assert tries == 1 and error in ("invalid_response", "unconfirmed_response")

    q.db.execute("update q set next_try = 0")
    monkeypatch.setattr(f, "post", lambda _records: {
        "results": [{"ext_id": "known", "status": "ok", "rejected": []}],
    })
    assert f.run_once() == 1 and q.size() == 0
    q.close()


def test_forwarder_retries_only_missing_device_in_partial_response(tmp_path, monkeypatch):
    q = DurableQueue(str(tmp_path / "q.sqlite3"))
    q.put("known", "egts", [{"t": 1}])
    q.put("device-b", "egts", [{"t": 2}])
    f = Forwarder(q, "http://127.0.0.1:9", "test-token")
    monkeypatch.setattr(f, "post", lambda _records: {
        "results": [{"ext_id": "known", "status": "ok", "rejected": []}],
    })

    assert f.run_once() == 1
    assert q.size() == 1 and q.take() == []
    assert q.db.execute("select ext_id, tries, last_error from q").fetchone() == (
        "device-b", 1, "unconfirmed_response",
    )
    q.close()


def test_forwarder_retries_only_transiently_rejected_record(tmp_path, monkeypatch):
    q = DurableQueue(str(tmp_path / "q.sqlite3"))
    q.put("device-a", "egts", [{"t": 1}, {"t": 2}])
    f = Forwarder(q, "http://127.0.0.1:9", "test-token")
    monkeypatch.setattr(f, "post", lambda _records: {
        "results": [{"ext_id": "device-a", "status": "ok",
                     "rejected": [{"index": 1, "reason": "temporary_backend_error"}]}],
    })

    assert f.run_once() == 1
    assert q.size() == 1 and q.take() == []
    assert q.db.execute("select payload, tries, last_error from q").fetchone() == (
        '{"t":2}', 1, "unconfirmed_response",
    )
    q.close()


def test_free_port_helper():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    assert s.getsockname()[1] > 0
    s.close()


def test_oil_sensors_wialon_param_galileosky_tag_table_and_bit_egts_analog():
    # Wialon IPS: CAN oil data as parameters (SPN 98 raw 0.4 %/bit, SPN 175 already in °C)
    m = sim_wialon.WialonMessage(t=1789466400, lat=61.78, lon=34.34, speed_kmh=0, course=0, alt_m=100, sats=9, hdop=1.0,
                                 inputs=0, params={"oil_lvl_raw": 180, "oil_t": 91.5, "oil_aw": 0.23})
    s = WialonIpsSession(Mapping(sensors={"oil_level_pct": {"param": "oil_lvl_raw", "scale": 0.4},
                                          "oil_temp_c": {"param": "oil_t"}, "oil_water_aw": {"param": "oil_aw"}}))
    s.feed(sim_wialon.login("356307042441013"))
    (recs, _), = s.feed(sim_wialon.data(m))
    assert recs[0]["sensors"] == {"oil_level_pct": 72.0, "oil_temp_c": 91.5, "oil_water_aw": 0.23}

    # Galileosky: level sender on analog input 0x50 (mV) through a calibration table; switch on input bit 2
    rec = sim_gs.GalileoRecord(index=3, t=1789466500, lat=61.78, lon=34.34, valid=True, sats=10, speed_kmh=0, course=0,
                               alt_m=100, hdop=0.9, inputs=0b100, power_mv=27000, gps_odometer_m=0, analog_mv={0x50: 4900})
    g = GalileoskySession(Mapping(sensors={"oil_level_pct": {"tag": 0x50, "table": [[500, 0], [9300, 100]]},
                                           "oil_level_low": {"tag": 0x46, "bit": 2}}))
    g.feed(sim_gs.head_packet("356307042441013"))
    (grecs, _), = g.feed(sim_gs.records_packets([rec], archive=False)[0])
    assert grecs[0]["sensors"] == {"oil_level_pct": 50.0, "oil_level_low": 1.0}

    # EGTS: ABS_AN_SENS_DATA input 3 (ГОСТ 33472 Б.13: ASN 1 byte + ASV 3 bytes)
    p = sim_egts.EgtsPoint(t=1789466600, lat=61.78, lon=34.34, valid=True, speed_kmh=0, course=0, odometer_km=0, inputs=0,
                           alt_m=100, sats=9, hdop=1.0, moving=False, blackbox=False, counters={}, analog={3: 860})
    e = EgtsSession(Mapping(sensors={"hyd_temp_c": {"egts_an": 3, "scale": 0.1}}))
    e.ext_id = "preset"
    out = e.feed(sim_egts.transport(sim_egts.record(5, 2, sim_egts.pos_data(p) + sim_egts.abs_analog(p.analog)), 9))
    assert out[0][0][0]["sensors"] == {"hyd_temp_c": 86.0}


def test_oil_sensor_float_user_tag_and_current_switch_threshold():
    # Galileosky: Modbus value written by the RS-485 exchange algorithm into user tag 0xE2 as IEEE-754 float;
    # СУЖ-type current switch read through a shunt on analog input 0x50 (low current in air = below minimum)
    def rec(mv, aw):
        return sim_gs.GalileoRecord(index=4, t=1789466700, lat=61.78, lon=34.34, valid=True, sats=10, speed_kmh=0, course=0,
                                    alt_m=100, hdop=0.9, inputs=0, power_mv=27000, gps_odometer_m=0, analog_mv={0x50: mv},
                                    extra_tags={0xE2: struct.pack("<f", aw)})
    g = GalileoskySession(Mapping(sensors={"oil_water_aw": {"tag": 0xE2, "float": True},
                                           "oil_level_low": {"tag": 0x50, "threshold": 1900, "when": "below"}}))
    g.feed(sim_gs.head_packet("356307042441013"))
    (low, _), = g.feed(sim_gs.records_packets([rec(1650, 0.37)], archive=False)[0])
    (ok, _), = g.feed(sim_gs.records_packets([rec(2100, 0.41)], archive=False)[0])
    assert low[0]["sensors"] == {"oil_water_aw": 0.37, "oil_level_low": 1.0}
    assert ok[0]["sensors"] == {"oil_water_aw": 0.41, "oil_level_low": 0.0}
