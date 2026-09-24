"""Live stand runner.

    ITLES_API_URL=https://itles.vercel.app STAND_KEY=<gateway key> python -m stand

Every demo machine is advanced in real time. Its tracker emulator records and sends real protocol
bytes over TCP: to the ITles gateway (Galileosky, NTCB/FLEX, EGTS, Wialon IPS), to a Traccar server
(Teltonika Codec 8E) or through an emulated monitoring platform that retranslates (Wialon
Retranslator, EGTS dispatcher). The stand makes only outbound calls to the platform: a status report
with recent packets, and scenario commands in the reply.

While nobody watches, trackers send every 15 minutes and the stand reports as rarely, so the
serverless database can suspend between sessions; the platform switches the stand to live mode
when someone opens the stand or the fleet map.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import pathlib
import signal
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from . import fleet as fleetmod
from .model import Machine
from .trackers import PROTO_RU, EventLog, PlatformRetranslator, Tracker

log = logging.getLogger("itles.stand")

VERSION = "стенд 1.0"
ARCHIVE_CAP = 20_000  # black-box emulation: the oldest records are overwritten beyond this
# Record policy (moving period s, parked period s, turn deg, min s between turn records, distance m, CAN every n-th record).
# Live: someone watches. Economy and history: a data-saving terminal profile; every record costs ~2 KB in PostgreSQL
# (position, counters, sensors), so the demo fleet stays around 4 MB a day.
LIVE_POLICY = (30, 600, 15, 5, 300, 1)
ECO_POLICY = (300, 3600, 30, 180, 1500, 2)
ECO_SEND_S = 900
HOURS_PER_YEAR = {"tractor": 900, "combine": 380, "harvester": 3300, "forwarder": 3100, "timber_truck": 2700,
                  "excavator": 2300, "dump_truck": 3200, "loader": 2100, "dozer": 1900}
PATH_RU = {"gateway": "напрямую на шлюз ITles", "traccar": "через сервер Traccar", "wialon_local": "через Wialon Local (эмуляция)",
           "omnicomm_online": "через Omnicomm Online (эмуляция)"}


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return int(v) if v else default


@dataclass
class Config:
    api: str | None
    key: str | None
    stand_id: str
    host_label: str
    gateway_host: str
    ports: dict[str, int]
    traccar_host: str
    traccar_port: int
    traccar_web: str
    state_file: pathlib.Path
    gateway_status_file: str | None
    history_days: float
    max_catchup_days: float = 35.0

    @classmethod
    def from_env(cls, args: argparse.Namespace) -> "Config":
        host = socket.gethostname()
        return cls(
            api=(os.environ.get("ITLES_API_URL") or "").rstrip("/") or None,
            key=os.environ.get("STAND_KEY") or os.environ.get("GATEWAY_TOKEN"),
            stand_id=os.environ.get("STAND_ID") or f"stand-{host}"[:60],
            host_label=os.environ.get("STAND_HOST_LABEL") or host,
            gateway_host=os.environ.get("GATEWAY_HOST", "127.0.0.1"),
            ports={
                "galileosky": _env_int("PORT_GALILEOSKY", 5034), "wialon_ips": _env_int("PORT_WIALON_IPS", 5039),
                "egts": _env_int("PORT_EGTS", 5037), "wialon_retranslator": _env_int("PORT_WIALON_RETRANSLATOR", 5090),
                "navtelecom_flex": _env_int("PORT_NAVTELECOM_FLEX", 5041),
            },
            traccar_host=os.environ.get("TRACCAR_HOST", "demo.traccar.org"),
            traccar_port=_env_int("TRACCAR_PORT_TELTONIKA", 5027),
            traccar_web=os.environ.get("TRACCAR_WEB", "https://demo.traccar.org"),
            state_file=pathlib.Path(args.state or os.environ.get("STAND_STATE", "stand-state.json")),
            gateway_status_file=os.environ.get("GATEWAY_STATUS_FILE"),
            history_days=float(args.history_days if args.history_days is not None else os.environ.get("STAND_HISTORY_DAYS", 0)),
        )


@dataclass
class Unit:
    u: dict
    m: Machine
    tr: Tracker
    lock: threading.Lock = field(default_factory=threading.Lock)
    busy: bool = False
    fails: int = 0
    retry_at: float = 0.0
    reboot_until: float = 0.0
    last_t: int = 0
    state: object = None
    fast_off: bool = False


def start_hours(u: dict, rng_seed: int) -> float:
    age = max(0.3, 2026.7 - (u.get("year") or 2024.5))
    return round(HOURS_PER_YEAR.get(u["profile"], 1500) * age * (0.85 + (rng_seed % 1000) / 4000), 1)


class Api:
    def __init__(self, base: str, key: str):
        self.base, self.key = base, key

    def post(self, path: str, body: dict, timeout: float = 25.0) -> dict:
        req = urllib.request.Request(
            self.base + path, data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(), method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.key}", "x-itles-client": "stand"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")


class Stand:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.fleet = fleetmod.load()
        self.log = EventLog(cap=600)
        self.stop = threading.Event()
        # the first report waits for real state (after history and the first live tick); wake = report now
        self.ready = threading.Event()
        self.wake = threading.Event()
        self.mode = ""
        self.policy = ECO_POLICY
        self.started = time.time()
        self.known: set[str] = set()
        self.report_error: str | None = None
        self.last_report_ok: float | None = None
        self.api = Api(cfg.api, cfg.key) if cfg.api and cfg.key else None
        gw = cfg.gateway_host
        endpoints = {p: (gw, cfg.ports[p]) for p in ("galileosky", "wialon_ips", "egts", "navtelecom_flex")}
        endpoints["teltonika"] = (cfg.traccar_host, cfg.traccar_port)
        self.retranslators = {
            "wialon_local": PlatformRetranslator("wialon_retranslator", gw, cfg.ports["wialon_retranslator"], self.log, True),
            "omnicomm_online": PlatformRetranslator("egts_retranslator", gw, cfg.ports["egts"], self.log, True),
        }
        self.units: list[Unit] = []
        for u in fleetmod.units(self.fleet):
            seed = int(hashlib.sha1(u["imei"].encode()).hexdigest()[:8], 16)
            m = Machine(u, self.fleet, seed, start_hours({**u, "year": self._year(u)}, seed))
            tr = Tracker(u, m, endpoints, self.log, live=True, via=self.retranslators.get(u["path"]))
            self.units.append(Unit(u, m, tr))
        self.by_imei = {x.u["imei"]: x for x in self.units}
        self.frames_mark = (time.time(), 0)
        self.frame_rate = 0.0
        # economy until the platform says someone is watching; without a platform, live
        self.set_mode("eco" if self.api else "live")

    def _year(self, u: dict) -> int | None:
        m = next((x for x in self.fleet["machines"] if x["id"] == u["machine_id"]), None)
        return m.get("year") if m else None

    # ------------------------------------------------------------------ persistence
    def load_state(self) -> float | None:
        """Counters survive restarts: engine hours and odometers must never run backwards."""
        try:
            st = json.loads(self.cfg.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        oldest = None
        for imei, v in st.get("units", {}).items():
            x = self.by_imei.get(imei)
            if not x:
                continue
            s = x.m.s
            for k in ("hours", "odo_m", "gnss_odo_m", "fuel_used_l", "fuel_l"):
                if isinstance(v.get(k), (int, float)):
                    setattr(s, k, float(v[k]))
            x.tr.index = int(v.get("index", 0))
            x.last_t = int(v.get("t", 0))
            oldest = x.last_t if oldest is None else min(oldest, x.last_t)
        return oldest

    def save_state(self) -> None:
        data = {"version": 1, "saved_at": time.time(), "units": {
            x.u["imei"]: {"t": x.last_t, "hours": x.m.s.hours, "odo_m": x.m.s.odo_m, "gnss_odo_m": x.m.s.gnss_odo_m,
                          "fuel_used_l": x.m.s.fuel_used_l, "fuel_l": x.m.s.fuel_l, "index": x.tr.index} for x in self.units}}
        tmp = self.cfg.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, self.cfg.state_file)

    # ------------------------------------------------------------------ history / catch-up
    def fast_forward(self, t0: int, t1: int, step: int = 10, flush_every: int = 4 * 3600) -> None:
        """Simulate [t0, t1) quickly; the trackers deliver it as black-box archive over the same TCP paths."""
        moving, parked, turn, turn_dt, dist, full = ECO_POLICY
        for x in self.units:
            x.tr.live, x.tr.full_every, x.fast_off, x.fails = False, full, False, 0
        days = (t1 - t0) / 86400
        self.log.add("stand", f"Досылка истории за {days:.1f} сут: модели идут ускоренно, трекеры отправляют архив чёрного ящика")
        log.info("fast-forward %.1f days", days)
        t, next_flush, next_note = t0, t0 + flush_every, time.time() + 30
        while t < t1 and not self.stop.is_set():
            for x in self.units:
                if t <= x.last_t:
                    continue
                s = x.m.step(t, step)
                x.tr.sample(s, moving, parked, turn, turn_dt, dist)
                x.last_t = t
                del x.m.events[:]
                if len(x.tr.archive) > ARCHIVE_CAP:
                    del x.tr.archive[: len(x.tr.archive) - ARCHIVE_CAP]
            t += step
            if t >= next_flush or t >= t1:
                next_flush += flush_every
                self._flush_all_fast()
                if time.time() > next_note:
                    next_note = time.time() + 30
                    log.info("history at %s", time.strftime("%Y-%m-%d %H:%M", time.gmtime(t)))
                    self.save_state()
        for x in self.units:
            x.tr.live, x.tr.full_every = True, self.policy[5]
        self.save_state()
        self.log.add("stand", "История дослана, стенд перешёл в реальное время")

    def _flush_all_fast(self) -> None:
        for x in self.units:
            if x.fast_off or not x.tr.archive:
                continue
            before = len(x.tr.archive)
            x.tr.flush(time.time(), True, force=True)
            if len(x.tr.archive) >= before:
                x.fails += 1
                if x.fails >= 3:
                    x.fast_off = True  # e.g. Traccar does not know the device: stop hammering it during history
                    log.warning("%s: history paused after repeated send failures", x.u["vehicle"])
            else:
                x.fails = 0

    # ------------------------------------------------------------------ live loop
    def set_mode(self, mode: str) -> None:
        if mode == self.mode:
            return
        self.mode = mode
        self.policy = ECO_POLICY if mode == "eco" else LIVE_POLICY
        for x in self.units:
            x.tr.send_period = ECO_SEND_S if mode == "eco" else (20 if x.u["protocol"] == "wialon_ips" else 30)
            x.tr.full_every = self.policy[5]
        if mode == "live":
            self.log.add("stand", "Живой режим: кто-то смотрит стенд или карту — трекеры отправляют каждые 20–30 с")
            for x in self.units:
                x.tr.last_send = 0.0
        else:
            self.log.add("stand", "Экономичный режим: трекеры копят записи и отправляют раз в 15 минут")

    def _flush_async(self, x: Unit, now: float, coverage: bool) -> None:
        if x.busy or now < x.retry_at or now < x.reboot_until:
            return
        if not x.tr.archive or now - x.tr.last_send < x.tr.send_period:
            return
        x.busy = True

        def work() -> None:
            try:
                with x.lock:
                    before = len(x.tr.archive)
                    sent = x.tr.flush(time.time(), coverage)
                if coverage and sent == 0 and before and not x.tr.connected:
                    x.fails += 1
                    x.retry_at = time.time() + min(900, 15 * 2 ** min(x.fails, 6))
                elif sent:
                    x.fails = 0
            except Exception:
                log.exception("flush %s", x.u["imei"])
            finally:
                x.busy = False

        threading.Thread(target=work, daemon=True, name=f"send-{x.u['imei']}").start()

    def live_loop(self) -> None:
        first_tick = False
        last_save = time.time()
        prev = time.time()
        while not self.stop.is_set():
            now = time.time()
            t = int(now)
            dt = min(5.0, max(0.5, now - prev))
            prev = now
            for x in self.units:
                if t <= x.last_t:
                    continue
                s = x.m.step(t, dt)
                x.state, x.last_t = s, t
                for et, text in x.m.events:
                    self.log.add("event", f"{x.u['vehicle']}: {text}", x.u["imei"])
                del x.m.events[:]
                if now < x.reboot_until:
                    continue
                x.tr.sample(s, *self.policy[:5])
                if len(x.tr.archive) > ARCHIVE_CAP:
                    del x.tr.archive[: len(x.tr.archive) - ARCHIVE_CAP]
                self._flush_async(x, now, s.coverage)
            if not first_tick:
                first_tick = True
                # give the first TCP sessions a few seconds, then report a snapshot with real state
                threading.Timer(8, self.ready.set).start()
            if now - last_save > 60:
                last_save = now
                self.save_state()
            self.stop.wait(max(0.05, 1.0 - (time.time() - now)))

    # ------------------------------------------------------------------ reporting and commands
    def gateway_status(self) -> dict | None:
        p = self.cfg.gateway_status_file
        if not p:
            return None
        try:
            st = json.loads(pathlib.Path(p).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return st if time.time() - st.get("t", 0) < 60 else None

    def snapshot(self) -> dict:
        now = time.time()
        frames = sum(x.tr.can_frames for x in self.units)
        t0, f0 = self.frames_mark
        if now - t0 >= 10:
            self.frame_rate = (frames - f0) / (now - t0)
            self.frames_mark = (now, frames)
        machines = []
        for x in self.units:
            s, tr = x.state, x.tr
            host, port = tr.endpoint()
            item = {
                "id": x.u["imei"], "imei": x.u["imei"], "vehicle": x.u["vehicle"], "model": x.u["model"], "protocol": x.u["protocol"],
                "protocol_label": PROTO_RU.get(x.u["protocol"], x.u["protocol"]), "path": x.u["path"], "path_label": PATH_RU.get(x.u["path"], x.u["path"]),
                "endpoint": f"{host}:{port}", "connected": tr.connected and now >= x.reboot_until, "archive": len(tr.archive),
                "packets": tr.packets, "bytes": tr.bytes, "records_sent": tr.records_sent, "last_packet_t": tr.last_packet_t,
                "can": x.u["can"], "fuel_sensor": x.u["fuel_sensor"], "free": x.u["free"], "rebooting": now < x.reboot_until,
                "retry_in_s": max(0, round(x.retry_at - now)) if x.fails else 0, "error": tr.last_error,
            }
            if s is not None:
                item["state"] = {
                    "activity": s.activity, "engine": s.engine, "ignition": s.ignition, "rpm": round(s.rpm), "speed": round(s.speed_kmh, 1),
                    "fuel_l": round(s.fuel_l, 1), "coolant": round(s.coolant, 1), "oil_kpa": round(s.oil_kpa), "hours": round(s.hours, 2),
                    "lat": round(s.lat, 6), "lon": round(s.lon, 6), "coverage": s.coverage, "implement": s.implement,
                    "faults": [f"SPN {a} FMI {b}" for a, b, _ in s.faults],
                }
            machines.append(item)
        engines = sum(1 for x in self.units if x.state is not None and x.state.engine)
        covered = sum(1 for x in self.units if x.state is None or x.state.coverage)
        gw = self.gateway_status()
        ports = self.cfg.ports
        gw_detail = (f"{self.cfg.gateway_host}: Galileosky {ports['galileosky']}, EGTS {ports['egts']}, Wialon IPS {ports['wialon_ips']}, "
                     f"NTCB/FLEX {ports['navtelecom_flex']}, Wialon Retranslator {ports['wialon_retranslator']}")
        if gw:
            gw_detail += f" · сессий {gw.get('connections', 0)}, в очереди {gw.get('queue', 0)}, передано в ITles {gw.get('forwarded', 0)}"
            if gw.get("last_error"):
                gw_detail += f" · ошибка передачи: {gw['last_error']}"
        tel = [x for x in self.units if x.u["protocol"] == "teltonika"]
        retr = [x for x in self.units if x.u["path"] in self.retranslators]
        by_model: dict[str, int] = {}
        for x in self.units:
            by_model[x.u["model"]] = by_model.get(x.u["model"], 0) + 1
        components = [
            {"id": "can", "kind": "can", "name": "Шины CAN J1939 (модели ЭБУ двигателей)", "status": "up" if engines else "warn",
             "detail": f"двигателей работает: {engines} из {len(self.units)} · ~{self.frame_rate:.0f} кадров/с на всех шинах · 250 кбит/с"},
            {"id": "trackers", "kind": "tracker", "name": "Эмуляторы прошивок трекеров", "status": "up",
             "detail": ", ".join(f"{k} ×{v}" for k, v in by_model.items()) + f" · в чёрных ящиках {sum(len(x.tr.archive) for x in self.units)} зап."},
            {"id": "network", "kind": "network", "name": "Сотовая сеть (модель покрытия по регионам)", "status": "up" if covered == len(self.units) else "warn",
             "detail": f"в зоне сети {covered} из {len(self.units)}; на лесосеках связь пропадает на десятки минут"},
            {"id": "gateway", "kind": "gateway", "name": "Шлюз ITles: TCP → очередь на диске → HTTPS", "status": "up" if gw and not gw.get("last_error") else ("warn" if gw else "down"),
             "detail": gw_detail if gw else gw_detail + " · нет свежего статуса шлюза"},
            {"id": "traccar", "kind": "traccar", "name": f"Traccar ({self.cfg.traccar_host})", "status": "up" if any(x.tr.connected for x in tel) else "warn",
             "detail": f"Teltonika Codec 8E → порт {self.cfg.traccar_port}; в ITles — через подключение «Traccar» (REST API)", "url": self.cfg.traccar_web},
            {"id": "retranslator", "kind": "retranslator", "name": "Эмуляция платформ-ретрансляторов", "status": "up" if all(r.ok for r in self.retranslators.values()) else "warn",
             "detail": f"Wialon Local → Wialon Retranslator, Omnicomm Online → EGTS (диспетчер 9001); машин: {len(retr)}"},
        ]
        return {
            "stand_id": self.cfg.stand_id, "host": self.cfg.host_label, "mode": self.mode, "version": VERSION, "started_at": int(self.started * 1000),
            "stats": {"can_frames": sum(x.tr.can_frames for x in self.units), "packets": sum(x.tr.packets for x in self.units),
                      "bytes": sum(x.tr.bytes for x in self.units), "records": sum(x.tr.records_sent for x in self.units),
                      "uptime_s": round(now - self.started)},
            "report_error": self.report_error, "components": components, "machines": machines,
        }

    def run_command(self, c: dict) -> None:
        imei, name, cid = str(c.get("imei") or ""), str(c.get("command") or ""), c.get("id")
        x = self.by_imei.get(imei)
        now = time.time()
        if not x:
            ok, msg = False, "такого IMEI нет на стенде"
        elif name == "reboot_tracker":
            x.reboot_until, x.tr.connected, ok = now + 45, False, True
            msg = "трекер перезагружается ~45 с, архив сохраняется во flash-памяти"
            threading.Timer(46, lambda: self.log.add("conn", f"{x.u['vehicle']}: трекер загрузился, досылает архив", imei)).start()
        else:
            msg = x.m.command(name, int(now))
            ok = "не поддерживается" not in msg
            x.tr.last_ign = None  # next sample writes a record, so the change reaches the platform at once
            x.tr.last_send = 0.0
        if x:
            self.log.add("cmd", f"{x.u['vehicle']}: сценарий «{name}» — {msg}", imei)
        if self.api and cid:
            try:
                self.api.post(f"/api/stand/commands/{cid}/result", {"ok": ok, "message": msg})
            except Exception as e:  # the result is informational; the command already ran
                log.warning("command result: %s", e)

    def report_loop(self) -> None:
        if not self.api:
            return
        while not self.stop.is_set() and not self.ready.wait(1):
            pass
        while not self.stop.is_set():
            body = self.snapshot()
            events = self.log.take_new(300)
            body["events"] = events
            delay = 30.0
            try:
                resp = self.api.post("/api/stand/report", body)
                self.report_error, self.last_report_ok = None, time.time()
                self.set_mode("live" if resp.get("live") else "eco")
                self.known = set(resp.get("known_imeis") or [])
                cmds = resp.get("commands") or []
                for c in cmds:
                    self.run_command(c)
                delay = 1.0 if cmds else max(2.0, min(900.0, float(resp.get("poll_ms", 15000)) / 1000))
            except urllib.error.HTTPError as e:
                self.report_error = f"HTTP {e.code}"
                log.warning("report: HTTP %s %s", e.code, e.read()[:200])
            except Exception as e:
                self.report_error = str(e)[:200]
                log.warning("report: %s", e)
            self.wake.wait(delay)
            self.wake.clear()

    # ------------------------------------------------------------------ entry
    def run(self) -> None:
        now = int(time.time())
        oldest = self.load_state()
        if oldest:
            gap_from = max(oldest, now - int(self.cfg.max_catchup_days * 86400))
            if oldest < gap_from:
                for x in self.units:
                    x.last_t = max(x.last_t, gap_from)
            self.log.add("stand", f"Стенд перезапущен; счётчики восстановлены из {self.cfg.state_file.name}")
        elif self.cfg.history_days > 0:
            gap_from = now - int(self.cfg.history_days * 86400)
            for x in self.units:
                x.last_t = gap_from - 1
        else:
            gap_from = now
        threading.Thread(target=self.report_loop, daemon=True, name="report").start()
        if now - gap_from > 120:
            self.fast_forward(gap_from, now)
        self.live_loop()
        self.save_state()


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m stand", description="Живой стенд ITles")
    ap.add_argument("--history-days", type=float, default=None, help="при первом запуске дослать историю за N суток")
    ap.add_argument("--state", default=None, help="файл состояния (счётчики между перезапусками)")
    ap.add_argument("--write-mappings", metavar="PATH", help="записать настройки датчиков для шлюза (MAPPINGS_FILE) и выйти")
    ap.add_argument("--duration", type=float, default=0, help="остановиться через N секунд (проверки)")
    args = ap.parse_args()
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if args.write_mappings:
        fleet = fleetmod.load()
        maps = {u["imei"]: fleetmod.gateway_mapping(u) for u in fleetmod.units(fleet) if u["path"] != "traccar"}
        pathlib.Path(args.write_mappings).write_text(json.dumps(maps, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"mappings: {len(maps)} trackers → {args.write_mappings}")
        return
    cfg = Config.from_env(args)
    stand = Stand(cfg)
    if not stand.api:
        log.warning("ITLES_API_URL/STAND_KEY not set: running without the platform report")

    def stop(*_a) -> None:
        stand.stop.set()
        stand.wake.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if args.duration:
        threading.Timer(args.duration, stop).start()
    stand.run()
