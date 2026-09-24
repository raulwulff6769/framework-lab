"""Live stand orchestrator against a real in-process gateway over localhost TCP (simulated fleet)."""

from __future__ import annotations

import argparse
import asyncio
import socket
import sys
import threading
import time

import pytest

from gateway.itles_gateway.queue import DurableQueue
from gateway.itles_gateway.records import Mapping
from gateway.itles_gateway.server import Gateway
from stand import fleet as fleetmod
from stand.run import Config, Stand

PROTOS = ("galileosky", "wialon_ips", "egts", "wialon_retranslator", "navtelecom_flex")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def gateway():
    q = DurableQueue(":memory:")
    fleet = fleetmod.load()
    maps = {u["imei"]: Mapping.from_dict(fleetmod.gateway_mapping(u)) for u in fleetmod.units(fleet) if u["path"] != "traccar"}
    gw = Gateway(q, maps)
    ports = {p: _free_port() for p in PROTOS}
    loop = asyncio.new_event_loop()
    ready = threading.Event()

    def run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_until_complete(gw.serve(ports, host="127.0.0.1"))
        ready.set()
        loop.run_forever()

    threading.Thread(target=run, daemon=True).start()
    assert ready.wait(10)
    yield q, ports
    loop.call_soon_threadsafe(loop.stop)


def _stand(tmp_path, ports) -> Stand:
    cfg = Config.from_env(argparse.Namespace(state=str(tmp_path / "state.json"), history_days=None))
    cfg.api = cfg.key = None
    cfg.ports = dict(ports)
    cfg.traccar_host, cfg.traccar_port = "127.0.0.1", _free_port()  # nothing listens: Traccar is unreachable
    return Stand(cfg)


def test_history_reaches_the_gateway_through_every_tracker_protocol(tmp_path, gateway):
    q, ports = gateway
    st = _stand(tmp_path, ports)
    now = int(time.time())
    hours = 13  # history is flushed every 4 h: enough attempts for the Traccar units to pause
    for x in st.units:
        x.last_t = now - hours * 3600 - 1
    st.fast_forward(now - hours * 3600, now)
    got = q.by_device()
    for x in st.units:
        if x.u["path"] == "traccar":
            # the Traccar server is unreachable: the history pauses and stays in the black box
            assert x.fast_off and x.tr.archive and x.u["imei"] not in got
        else:
            assert got.get(x.u["imei"], 0) > 0, x.u["vehicle"]
            assert not x.tr.archive, x.u["vehicle"]
    # the Omnicomm emulation retranslates over an EGTS dispatcher link with its own object id
    assert "7011043" in got
    # the machines really drive: GNSS and CAN odometers grow with the distance covered
    moved = [x for x in st.units if x.m.s.gnss_odo_m > 1000]
    assert len(moved) >= len(st.units) // 2
    assert all(x.m.s.odo_m > x.m.s.gnss_odo_m for x in moved if x.m.prof.odometer)
    # engine hours from J1939 HOURS never run backwards within one tracker
    items = q.take(100_000)
    by_dev: dict[str, list[tuple[float, float]]] = {}
    for _id, ext, rec, _tries in items:
        if "engine_hours" in rec:
            by_dev.setdefault(ext, []).append((rec["t"], rec["engine_hours"]))
    assert by_dev
    for ext, pts in by_dev.items():
        pts.sort()
        assert all(b[1] >= a[1] - 1e-6 for a, b in zip(pts, pts[1:])), ext


def test_scenario_commands_and_snapshot(tmp_path, gateway):
    _q, ports = gateway
    st = _stand(tmp_path, ports)
    x = st.by_imei["868183030828904"]
    x.state = x.m.step(int(time.time()), 1.0)
    fuel = x.m.s.fuel_l
    st.run_command({"id": None, "imei": x.u["imei"], "command": "fuel_drain"})
    assert x.m.s.fuel_l < fuel
    st.run_command({"id": None, "imei": x.u["imei"], "command": "reboot_tracker"})
    snap = st.snapshot()
    item = next(m for m in snap["machines"] if m["imei"] == x.u["imei"])
    assert item["rebooting"] and not item["connected"]
    assert {c["kind"] for c in snap["components"]} >= {"can", "tracker", "network", "gateway", "traccar", "retranslator"}
    st.run_command({"id": None, "imei": "000", "command": "refuel"})  # unknown IMEI is reported, not raised
    kinds = [e["kind"] for e in st.log.take_new(600)]
    assert "cmd" in kinds


def test_counters_survive_a_restart(tmp_path, gateway):
    _q, ports = gateway
    st = _stand(tmp_path, ports)
    x = st.units[0]
    x.m.s.hours, x.last_t, x.tr.index = 4321.5, 1_790_000_000, 77
    st.save_state()
    again = _stand(tmp_path, ports)
    assert again.load_state() is not None
    y = again.by_imei[x.u["imei"]]
    assert (y.m.s.hours, y.last_t, y.tr.index) == (4321.5, 1_790_000_000, 77)
