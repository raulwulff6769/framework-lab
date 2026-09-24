"""Tracker firmware emulators: record policy, black box, cellular coverage and protocol sessions.

The emulator reads engine values only from decoded J1939 frames and the fuel level from the raw code
of an RS-485 level sensor, as a real terminal does; then it opens a TCP session and sends the archive
in the tracker's own protocol, waiting for each acknowledgement before dropping records.
"""

from __future__ import annotations

import math
import socket
import struct
import threading
import time
from dataclasses import dataclass, field

from sim.protocols import egts, egts_retranslator, galileosky, navtelecom, teltonika, wialon_ips, wialon_retranslator

from . import can


def hexdump(data: bytes, limit: int = 96) -> str:
    s = data[:limit].hex(" ").upper()
    return s + (f" … (+{len(data) - limit} байт)" if len(data) > limit else "")


@dataclass
class Rec:
    index: int
    t: int
    lat: float
    lon: float
    speed: float
    course: float
    alt: int
    sats: int
    hdop: float
    ignition: bool
    implement: bool
    power_v: float
    gnss_odo_m: float
    can: dict = field(default_factory=dict)
    fuel_raw: int | None = None
    fuel_l: float | None = None
    full: bool = True


class EventLog:
    def __init__(self, cap: int = 400):
        self.items: list[dict] = []
        self.cap = cap
        self.sent = 0
        self.lock = threading.Lock()

    def add(self, kind: str, summary: str, imei: str | None = None, **payload) -> None:
        with self.lock:
            self.items.append({"t": int(time.time() * 1000), "kind": kind, "imei": imei, "summary": summary, **payload})
            if len(self.items) > self.cap:
                drop = len(self.items) - self.cap
                self.items = self.items[drop:]
                self.sent = max(0, self.sent - drop)

    def take_new(self, limit: int = 300) -> list[dict]:
        with self.lock:
            new = self.items[self.sent :][-limit:]
            self.sent = len(self.items)
            return new


PROTO_RU = {
    "galileosky": "Galileosky", "navtelecom_flex": "NTCB/FLEX", "egts": "EGTS", "wialon_ips": "Wialon IPS",
    "wialon_retranslator": "Wialon Retranslator", "egts_retranslator": "EGTS (ретрансляция)", "teltonika": "Teltonika Codec 8E",
}


class Tracker:
    """One terminal on one machine."""

    def __init__(self, u: dict, machine, endpoints: dict, log: EventLog, live: bool = True, via: "PlatformRetranslator | None" = None):
        self.u, self.m, self.endpoints, self.log, self.via = u, machine, endpoints, log, via
        self.archive: list[Rec] = []
        self.index = 0
        self.last: Rec | None = None
        self.last_ign: bool | None = None
        self.last_send = 0.0
        self.connected = False
        self.last_packet_t: int | None = None
        self.packets = 0
        self.bytes = 0
        self.records_sent = 0
        self.can_frames = 0
        self.live = live
        self.full_every = 1 if live else 4
        self.send_period = {"galileosky": 30, "navtelecom_flex": 30, "egts": 30, "wialon_ips": 20, "teltonika": 30}.get(u["protocol"], 30)
        self.dtc: list[tuple[int, int, int]] = []
        self.can_values: dict = {}
        self.last_can_log = 0
        self.pending_note: str | None = None
        self.last_error: str | None = None

    # ---------------------------------------------------------------- record policy
    def sample(self, s, moving_period: int, parked_period: int, turn_deg: float = 15, turn_dt: int = 5, dist_m: float = 300) -> Rec | None:
        """Record policy of a tracker: by time, by heading change and by distance (all configurable, as in the terminals)."""
        due = False
        if self.last is None or s.ignition != self.last_ign:
            due = True
        else:
            dt = s.t - self.last.t
            if s.speed_kmh >= 3:
                turn = abs((s.course - self.last.course + 180) % 360 - 180)
                dist = math.hypot((s.lat - self.last.lat) * 111_320, (s.lon - self.last.lon) * 111_320 * math.cos(math.radians(s.lat)))
                due = dt >= moving_period or (turn >= turn_deg and dt >= turn_dt) or dist >= dist_m
            else:
                due = dt >= parked_period
        self.last_ign = s.ignition
        tank = self.u["tank_l"] or 400
        # fast-forward (history) decodes the bus only for records; live mode listens every step
        if self.live or due:
            frames = can.frames(s, self.m.prof.odometer)
            self.can_frames += len(frames)
            self.can_values = can.read(frames) if frames else {}
            if s.engine:
                self.can_values[96] = min(100.0, round(s.fuel_l / tank * 100 / 0.4) * 0.4)
            self.dtc = self.can_values.get("dtc", [])
            if self.live and frames and s.t - self.last_can_log >= 30:
                self.last_can_log = s.t
                pick = [f for f in frames if can.j1939.parse_can_id(f[0])[1] in (61444, 65262, 65263, 65266, 65226)]
                v = self.can_values
                self.log.add("can", f"{self.u['vehicle']}: EEC1 {v.get(190, 0):.0f} об/мин · ET1 ОЖ {v.get(110, 0):.0f} °C · EFL/P1 масло {v.get(100, 0):.0f} кПа · LFE {v.get(183, 0):.1f} л/ч"
                             + (f" · DM1 SPN {self.dtc[0][0]} FMI {self.dtc[0][1]}" if self.dtc else ""), self.u["imei"],
                             hex="\n".join(can.candump(i, d) for i, d in pick), fields={can.PGN_NAME.get(can.j1939.parse_can_id(i)[1], "?"): d.hex(" ").upper() for i, d in pick})
        if not due:
            return None
        self.index += 1
        full = self.index % self.full_every == 0 or not s.engine or self.last is None
        r = Rec(self.index, s.t, s.lat, s.lon, s.speed_kmh, s.course, 30, s.sats, s.hdop, s.ignition, s.implement,
                s.battery_v if s.engine else 25.3, s.gnss_odo_m, dict(self.can_values), full=full)
        if "RS-485" in (self.u["fuel_sensor"] or ""):
            # capacitive probe: raw code over the tank height; slosh while moving, mostly removed by the
            # sensor's own averaging filter (LLS/DUT-E filter settings), so the residue is small
            level = s.fuel_l / tank + (self.m.rng.gauss(0, 0.0015) if s.speed_kmh > 2 else 0)
            r.fuel_raw = max(0, min(4095, round(level * 4095)))
            r.fuel_l = r.fuel_raw / 4095 * tank
        elif s.engine:
            r.fuel_l = s.fuel_l
        self.archive.append(r)
        self.last = r
        return r

    # ---------------------------------------------------------------- protocol encodings
    def _galileo(self, r: Rec) -> galileosky.GalileoRecord:
        c = r.can if r.full else {}
        extra: dict[int, bytes] = {}
        if r.fuel_raw is not None:
            extra[0x60] = struct.pack("<H", r.fuel_raw)
        if 92 in c:
            extra[0xA0] = bytes([min(255, round(c[92]))])
        if 100 in c:
            extra[0xB0] = struct.pack("<H", round(c[100]))
        return galileosky.GalileoRecord(
            r.index & 0xFFFF, r.t, r.lat, r.lon, True, r.sats, r.speed, r.course, r.alt, r.hdop,
            (1 if r.ignition else 0) | (2 if r.implement else 0), round(r.power_v * 1000), round(r.gnss_odo_m),
            c.get(190), round(c[110]) if 110 in c else None, c.get(96), round(c[250] / 0.5) if 250 in c else None,
            round(c[917] / 5) if 917 in c else None, round(c[247] * 100) if 247 in c else None, None, extra or None)

    def _wialon_params(self, r: Rec) -> dict:
        c = r.can if r.full else {}
        p: dict = {"ign": int(r.ignition), "pwr": round(r.power_v, 2), "implement": int(r.implement), "gps_odom_km": round(r.gnss_odo_m / 1000, 3)}
        if 247 in c:
            p["eng_hours"] = round(c[247], 2)
        if 917 in c:
            p["can_dist_km"] = round(c[917] / 1000, 3)
        for key, spn, nd in (("rpm", 190, 0), ("coolant", 110, 0), ("fuel_pct", 96, 1), ("fuel_rate", 183, 2), ("oil_p", 100, 0), ("load", 92, 0)):
            if spn in c:
                p[key] = round(c[spn], nd) if nd else int(round(c[spn]))
        if r.full:
            p["dtc"] = ";".join(f"{a}.{b}.{o}" for a, b, o in c.get("dtc", []))
        return p

    def _egts_point(self, r: Rec, blackbox: bool) -> egts.EgtsPoint:
        c = r.can if r.full else {}
        counters = {1: round(c[247] * 10)} if 247 in c else {}
        analog = {}
        if 190 in c:
            analog[2] = round(c[190])
        if 110 in c:
            analog[3] = round(c[110]) + 40
        return egts.EgtsPoint(r.t, r.lat, r.lon, True, r.speed, r.course, r.gnss_odo_m / 1000, 1 if r.ignition else 0, r.alt,
                              r.sats, r.hdop, r.speed >= 3, blackbox, counters, analog)

    def _flex(self, r: Rec) -> bytes:
        c = r.can if r.full else {}
        values = {
            1: struct.pack("<I", r.index), 2: struct.pack("<H", 1), 3: struct.pack("<I", r.t),
            8: bytes([min(r.sats, 63) << 2 | 0x03]), 9: struct.pack("<I", r.t),
            10: struct.pack("<i", round(r.lat * 600_000)), 11: struct.pack("<i", round(r.lon * 600_000)),
            12: struct.pack("<i", r.alt * 10), 13: struct.pack("<f", r.speed), 14: struct.pack("<H", round(r.course) % 360),
            15: struct.pack("<f", r.gnss_odo_m / 1000), 37: struct.pack("<I", 0xFFFFFFFF),
            57: struct.pack("<f", c[917] / 1000 if 917 in c else float("nan")),
            67: struct.pack("<I", round(c[247] * 3600) if 247 in c else 0xFFFFFFFF),
            71: bytes((min(round(r.hdop * 10), 255), min(round(r.hdop * 10), 255))),
        }
        return navtelecom.flex_record(values, navtelecom.flex_mask(FLEX_FIELDS))

    def _teltonika(self, r: Rec) -> teltonika.AvlRecord:
        c = r.can if r.full else {}
        io = {239: int(r.ignition), 240: int(r.speed >= 3), 66: round(r.power_v * 1000), 16: round(r.gnss_odo_m),
              181: round(r.hdop * 13), 182: round(r.hdop * 10)}
        if 190 in c:
            io.update({85: round(c[190]), 110: round(c.get(183, 0) * 10), 115: round(c.get(110, 0) * 10), 83: round(c.get(250, 0) * 10)})
        if 247 in c:
            io[103] = round(c[247] * 60)
        if 917 in c:
            io[87] = round(c[917])
        if r.fuel_l is not None:
            io[84] = round(r.fuel_l * 10)
            io[89] = round(r.fuel_l / (self.u["tank_l"] or 400) * 100)
        return teltonika.AvlRecord(r.t * 1000, r.lat, r.lon, r.alt, round(r.course) % 360, r.sats, round(r.speed), 0, 0, io)

    # ---------------------------------------------------------------- sending
    def _note_packet(self, pkt: bytes, n: int, archive: bool, target: str, r: Rec | None) -> None:
        self.packets += 1
        self.bytes += len(pkt)
        self.records_sent += n
        self.last_packet_t = int(time.time() * 1000)
        if not self.live:
            return
        fields = None
        if r:
            c = r.can
            fields = {"время": time.strftime("%H:%M:%S", time.localtime(r.t)), "координаты": f"{r.lat:.5f}, {r.lon:.5f}", "скорость": f"{r.speed:.0f} км/ч",
                      "зажигание": r.ignition, "обороты": round(c.get(190, 0)), "моточасы": round(c.get(247, 0), 2), "топливо_л": None if r.fuel_l is None else round(r.fuel_l)}
        self.log.add("packet", f"{self.u['vehicle']}: {PROTO_RU[self.u['protocol']]} → {target}: {n} зап.{' (архив)' if archive else ''}, {len(pkt)} байт",
                     self.u["imei"], hex=hexdump(pkt), fields=fields, dir="out", proto=self.u["protocol"])

    def flush(self, now: float, coverage: bool, force: bool = False, chunk: int = 20) -> int:
        if not self.archive or (not force and now - self.last_send < self.send_period):
            return 0
        if not coverage:
            if self.connected:
                self.log.add("conn", f"{self.u['vehicle']}: нет сотовой связи — записи копятся в памяти трекера", self.u["imei"])
            self.connected = False
            return 0
        self.last_send = now
        recs = list(self.archive)
        archive = bool(recs) and time.time() - recs[0].t > 120
        try:
            sent = self.via.forward(self, recs, archive) if self.via else self._send(recs, archive, chunk)
        except (OSError, ConnectionError) as e:
            first = self.last_error != str(e)
            self.last_error = str(e)
            if self.live and (self.connected or first):
                self.log.add("conn", f"{self.u['vehicle']}: ошибка TCP-сессии ({e}); повтор позже", self.u["imei"])
            self.connected = False
            return 0
        self.last_error = None
        if not self.connected and self.live:
            self.log.add("conn", f"{self.u['vehicle']}: TCP-сессия {self.endpoint_label()} открыта, IMEI {self.u['imei']}", self.u["imei"])
        self.connected = True
        del self.archive[:sent]
        return sent

    def endpoint_label(self) -> str:
        host, port = self.endpoint()
        return f"{host}:{port}"

    def endpoint(self) -> tuple[str, int]:
        if self.via:
            return self.via.host, self.via.port
        return self.endpoints[self.u["protocol"]]

    def _send(self, recs: list[Rec], archive: bool, chunk: int) -> int:
        p = self.u["protocol"]
        host, port = self.endpoint()
        target = "Traccar" if p == "teltonika" else "шлюз ITles"
        with socket.create_connection((host, port), timeout=15) as sock:
            if p == "galileosky":
                head = galileosky.head_packet(self.u["imei"])
                sock.sendall(head)
                _recv_exact(sock, 3)
                done = 0
                for i in range(0, len(recs), chunk):
                    part = recs[i : i + chunk]
                    for pkt in galileosky.records_packets([self._galileo(r) for r in part], archive=archive):
                        sock.sendall(pkt)
                        ack = _recv_exact(sock, 3)
                        if ack != galileosky.expected_ack(pkt):
                            raise ConnectionError("неверный ACK Galileosky")
                        self._note_packet(pkt, len(part), archive, target, part[-1])
                    done += len(part)
                return done
            if p == "navtelecom_flex":
                for packet, expected in (
                    (navtelecom.ntcb(b"*>S:" + self.u["imei"].encode()), navtelecom.ntcb(b"*<S", receiver=0, sender=1)),
                    (navtelecom.negotiation(FLEX_FIELDS), navtelecom.ntcb(b"*<FLEX\xb0\x14\x14", receiver=0, sender=1)),
                ):
                    sock.sendall(packet)
                    if _recv_exact(sock, len(expected)) != expected:
                        raise ConnectionError("неверный ответ NTCB")
                done = 0
                for i in range(0, len(recs), chunk):
                    part = recs[i : i + chunk]
                    pkt = navtelecom.frame("A", b"".join(self._flex(r) for r in part), count=len(part))
                    expected = navtelecom.frame("A", b"", count=len(part))
                    sock.sendall(pkt)
                    if _recv_exact(sock, len(expected)) != expected:
                        raise ConnectionError("нет подтверждения FLEX")
                    self._note_packet(pkt, len(part), archive, target, part[-1])
                    done += len(part)
                return done
            if p == "egts":
                buf = b""
                pid = 1
                sock.sendall(egts.transport(egts.record(1, egts.SERVICE_AUTH, egts.term_identity(1, self.u["imei"])), pid))
                buf = _egts_wait(sock, buf)
                done = 0
                for i in range(0, len(recs), chunk):
                    part = recs[i : i + chunk]
                    pid += 1
                    body = b""
                    for j, r in enumerate(part):
                        subs = egts.pos_data(self._egts_point(r, archive)) + egts.ext_pos_data(self._egts_point(r, archive))
                        pt = self._egts_point(r, archive)
                        subs += egts.abs_counters(pt.counters) + egts.abs_analog(pt.analog)
                        if r.fuel_l is not None:
                            subs += egts_retranslator.liquid_level(1, r.fuel_l)
                        body += egts.record(i + j + 2, egts.SERVICE_TELEDATA, subs)
                    pkt = egts.transport(body, pid)
                    sock.sendall(pkt)
                    buf = _egts_wait(sock, buf)
                    self._note_packet(pkt, len(part), archive, target, part[-1])
                    done += len(part)
                return done
            if p == "wialon_ips":
                reader = sock.makefile("rb")
                sock.sendall(wialon_ips.login(self.u["imei"]))
                if not reader.readline().startswith(b"#AL#1"):
                    raise ConnectionError("Wialon IPS: вход отклонён")
                done = 0
                for i in range(0, len(recs), chunk):
                    part = recs[i : i + chunk]
                    msgs = [wialon_ips.WialonMessage(r.t, r.lat, r.lon, r.speed, r.course, r.alt, r.sats, r.hdop, 1 if r.ignition else 0, self._wialon_params(r)) for r in part]
                    pkt = wialon_ips.blackbox(msgs)
                    sock.sendall(pkt)
                    reader.readline()
                    self._note_packet(pkt, len(part), archive, target, part[-1])
                    done += len(part)
                return done
            if p == "teltonika":
                sock.sendall(teltonika.imei_packet(self.u["imei"]))
                if _recv_exact(sock, 1) != b"\x01":
                    raise ConnectionError("Traccar не принял IMEI (устройство не заведено?)")
                done = 0
                for i in range(0, len(recs), 50):
                    part = recs[i : i + 50]
                    pkt = teltonika.avl_packet([self._teltonika(r) for r in part])
                    sock.sendall(pkt)
                    acked = struct.unpack(">I", _recv_exact(sock, 4))[0]
                    self._note_packet(pkt, acked, archive, target, part[-1])
                    done += acked
                    if acked < len(part):
                        break
                return done
        raise ValueError(f"протокол {p} отправляется через эмулятор платформы")


FLEX_FIELDS = (1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 37, 57, 67, 71)


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("соединение закрыто сервером")
        buf += chunk
    return buf


def _egts_wait(sock: socket.socket, buf: bytes) -> bytes:
    while True:
        frames, rest = egts.split_frames(buf)
        if any(egts.decode(f)["type"] == egts.PT_RESPONSE for f in frames):
            return rest
        chunk = sock.recv(65536)
        if not chunk:
            raise ConnectionError("соединение закрыто сервером")
        buf = rest + chunk if frames else buf + chunk


class PlatformRetranslator:
    """Emulated monitoring platform (Wialon Local of an integrator / Omnicomm Online) that already receives
    the machine's tracker and forwards a copy of every message to the ITles gateway."""

    def __init__(self, kind: str, host: str, port: int, log: EventLog, live: bool):
        self.kind, self.host, self.port, self.log, self.live = kind, host, port, log, live
        self.name = "Wialon Local (эмуляция)" if kind == "wialon_retranslator" else "Omnicomm Online (эмуляция)"
        self.ok = False
        self.packets = 0

    def forward(self, tr: Tracker, recs: list[Rec], archive: bool) -> int:
        if self.kind == "wialon_retranslator":
            pkts = [wialon_retranslator.encode(tr.u["imei"], r.t, r.lat, r.lon, float(r.alt), round(r.speed), round(r.course), r.sats, tr._wialon_params(r)) for r in recs]
            st = wialon_retranslator.send_packets(self.host, self.port, pkts)
            # one message per packet: log the newest, count the rest
            tr.packets += len(pkts) - 1
            tr.bytes += sum(len(p) for p in pkts[:-1])
            tr.records_sent += st["acked"] - 1
            tr._note_packet(pkts[-1], 1, archive, f"{self.name} → шлюз ITles", recs[-1])
            self.packets += len(pkts)
            self.ok = True
            return st["acked"]
        r0 = egts_retranslator.EgtsRetranslator(self.host, self.port, dispatcher_id=9001)
        auth = r0.connect()
        try:
            done = 0
            for i in range(0, len(recs), 20):
                part = recs[i : i + 20]
                pkt = r0.send(int(tr.u["imei"]), [tr._egts_point(r, archive) for r in part], [r.fuel_l for r in part])
                done += len(part)
                if self.live and i + 20 >= len(recs):
                    tr._note_packet(pkt, len(part), archive, f"{self.name} → шлюз ITles (EGTS, диспетчер 9001, OID {tr.u['imei']})", part[-1])
                else:
                    tr.packets += 1
                    tr.bytes += len(pkt)
                    tr.records_sent += len(part)
            self.packets += r0.stats["packets"]
            self.ok = True
            if self.live and tr.packets <= 2:
                self.log.add("packet", f"{self.name}: авторизация диспетчера EGTS_SR_DISPATCHER_IDENTITY", tr.u["imei"], hex=hexdump(auth), dir="out", proto="egts")
            return done
        finally:
            r0.close()
