#!/usr/bin/env python3
"""Tracker → gateway → platform end-to-end run.

Simulated machines (sim/) speak Galileosky, EGTS, Wialon IPS and Navtelecom FLEX over TCP to the
gateway (gateway/), which forwards over HTTP to the platform server (platform/dev/server.ts,
PostgreSQL via PGlite). The result is reconciled against what the trackers sent and against the
simulator's ground truth; the archive is then re-sent to prove idempotency.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "gateway")]

from itles_gateway.forwarder import Forwarder  # noqa: E402
from itles_gateway.queue import DurableQueue  # noqa: E402
from itles_gateway.records import Mapping  # noqa: E402
from itles_gateway.server import Gateway  # noqa: E402
from sim import uplink  # noqa: E402
from sim.tracker import run  # noqa: E402

TOKEN = "gw_e2e_" + os.urandom(12).hex()
MACHINES = [
    {"profile": "harvester", "proto": "galileosky", "imei": "356307042441013", "hours": "can",
     "body": {"name": "Харвестер John Deere 1270G", "category": "harvester", "chassis": "wheeled"},
     "mapping": Mapping()},
    {"profile": "excavator", "proto": "egts", "imei": "868204005185938", "hours": "voltage",
     "body": {"name": "Экскаватор SANY SY500H", "category": "excavator", "chassis": "tracked", "rotating_upper": True},
     "mapping": Mapping(egts_hours_counter=1, egts_hours_scale=0.1)},
    {"profile": "timber_truck", "proto": "wialon_ips", "imei": "861230043345678", "hours": "can",
     "body": {"name": "Лесовоз КАМАЗ-43118", "category": "timber_truck", "chassis": "wheeled"},
     "mapping": Mapping(param_hours={"eng_hours": "ecu"}, param_mileage={"can_dist_km": "ecu"})},
    {"profile": "dump_truck", "proto": "navtelecom_flex", "imei": "111111111111111", "hours": "can",
     "body": {"name": "Модель карьерного самосвала (FLEX)", "category": "dump_truck", "chassis": "wheeled"},
     "mapping": Mapping()},
]


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def api(base: str, method: str, path: str, body=None, token: str | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json"})
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def main(output: pathlib.Path) -> None:
    port = free_port()
    env = {**os.environ, "PORT": str(port), "DATABASE_URL": "pglite:memory", "GATEWAY_TOKEN": TOKEN,
           "SETUP_KEY": "e2e-setup-key", "STATIC_DIR": str(ROOT / "platform" / "dist")}
    srv = subprocess.Popen(["npx", "tsx", "dev/server.ts"], cwd=ROOT / "platform", env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(120):
            try:
                if api(base, "GET", "/api/health")[0] == 200:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        _, r = api(base, "POST", "/api/setup", {"setup_key": "e2e-setup-key", "login": "fuchs-admin", "password": "e2e-password"})
        admin = r["token"]
        _, d = api(base, "POST", "/api/orgs", {"kind": "distributor", "name": "Дистрибьютор Северо-Запад"}, admin)
        _, c = api(base, "POST", "/api/orgs", {"kind": "customer", "name": "Леспромхоз «Тайга»", "parent_id": d["org"]["id"]}, admin)
        org = c["org"]["id"]
        for m in MACHINES:
            st, res = api(base, "POST", "/api/machines", {**m["body"], "org_id": org}, admin)
            assert st == 201, res
            m["id"] = res["machine"]["id"]
            st, res = api(base, "POST", f"/api/machines/{m['id']}/sources", {"kind": "tracker", "external_id": m["imei"]}, admin)
            assert st == 201, res

        q = DurableQueue(":memory:")
        gw = Gateway(q, {m["imei"]: m["mapping"] for m in MACHINES})
        ports = {p: free_port() for p in ("galileosky", "egts", "wialon_ips", "navtelecom_flex")}
        loop = asyncio.new_event_loop()
        started = threading.Event()

        def serve():
            asyncio.set_event_loop(loop)
            loop.run_until_complete(gw.serve(ports, "127.0.0.1"))
            started.set()
            loop.run_forever()

        threading.Thread(target=serve, daemon=True).start()
        started.wait(10)
        fwd = Forwarder(q, base, TOKEN, batch=2000)
        threading.Thread(target=fwd.loop, kwargs={"idle": 0.2}, daemon=True).start()

        now = int(time.time())
        start = (now - 4 * 86400) // 86400 * 86400 - 3 * 3600
        report: dict = {"generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "machines": []}
        sims = {}
        for m in MACHINES:
            t0 = time.time()
            res = run(m["profile"], start, 3, seed=7)
            recs = sorted(res.records, key=lambda r: r.t)
            sims[m["imei"]] = recs
            if m["proto"] == "navtelecom_flex":
                stats = uplink.send_navtelecom("127.0.0.1", ports["navtelecom_flex"], m["imei"], recs)
            else:
                send = {"galileosky": lambda h, p, i, rs, hm: uplink.send_galileosky(h, p, i, rs),
                        "egts": uplink.send_egts, "wialon_ips": uplink.send_wialon}[m["proto"]]
                stats = send("127.0.0.1", ports[m["proto"]], m["imei"], recs, m["hours"])
            if "acks_ok" in stats:
                assert stats["acks_ok"] == stats["packets"], f"{m['proto']}: missing protocol ACK"
            m["send_stats"] = stats
            m["sim_s"] = round(time.time() - t0, 1)

        deadline = time.time() + 300
        while q.size() > 0 and time.time() < deadline:
            time.sleep(0.5)
        time.sleep(1.0)

        _, lst = api(base, "GET", "/api/machines", token=admin)
        by_id = {x["id"]: x for x in lst["machines"]}
        for m in MACHINES:
            recs = sims[m["imei"]]
            valid_t = {r.t for r in recs if r.valid}
            frm = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start - 3600))
            to = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 600))
            _, tr = api(base, "GET", f"/api/machines/{m['id']}/track?from={frm}&to={to}", token=admin)
            _, daily = api(base, "GET", f"/api/machines/{m['id']}/daily?days=10", token=admin)
            gnss_km = sum(x["gnss_km"] or 0 for x in daily["days"])
            last = recs[-1]
            sent_hours = last.hours.get(m["hours"])
            s = by_id[m["id"]]
            truth_km = (recs[-1].truth_path_m - recs[0].truth_path_m) / 1000
            naive_km = sum(
                ((a.lat - b.lat) ** 2 + ((a.lon - b.lon) * 0.5) ** 2) ** 0.5 * 111.2
                for a, b in zip([r for r in recs if r.valid][1:], [r for r in recs if r.valid][:-1])
            )
            m["result"] = {
                "records_sent": len(recs),
                "valid_fixes_sent": len(valid_t),
                "positions_stored": tr["total"],
                "lost_positions": len(valid_t) - tr["total"],
                "engine_hours_platform": s["engine_hours"] and round(s["engine_hours"]["value"], 3),
                "engine_hours_method": s["engine_hours"] and s["engine_hours"]["method"],
                "engine_hours_last_sent": sent_hours and round(sent_hours, 3),
                "engine_hours_truth": round(last.truth_engine_h, 3),
                "odometer_platform_km": s["odometer"] and round(s["odometer"]["value"], 3),
                "odometer_method": s["odometer"] and s["odometer"]["method"],
                "gnss_robust_km": round(gnss_km, 3),
                "gnss_naive_km_from_sent_track": round(naive_km, 3),
                "truth_path_km": round(truth_km, 3),
                "freshness": s["freshness"],
            }
            # The model emits at most one position for each valid fix timestamp.
            assert tr["total"] == len(valid_t), f"{m['proto']}: valid fixes != stored positions"

        # idempotency: re-send everything (e.g. tracker re-uploads its archive after a reconnect)
        before = {m["id"]: m["result"]["positions_stored"] for m in MACHINES}
        for m in MACHINES:
            recs = sims[m["imei"]]
            if m["proto"] == "galileosky":
                uplink.send_galileosky("127.0.0.1", ports["galileosky"], m["imei"], recs)
            elif m["proto"] == "egts":
                uplink.send_egts("127.0.0.1", ports["egts"], m["imei"], recs, m["hours"])
            elif m["proto"] == "navtelecom_flex":
                uplink.send_navtelecom("127.0.0.1", ports["navtelecom_flex"], m["imei"], recs)
            else:
                uplink.send_wialon("127.0.0.1", ports["wialon_ips"], m["imei"], recs, m["hours"])
        deadline = time.time() + 300
        while q.size() > 0 and time.time() < deadline:
            time.sleep(0.5)
        time.sleep(1.0)
        for m in MACHINES:
            frm = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start - 3600))
            to = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 600))
            _, tr = api(base, "GET", f"/api/machines/{m['id']}/track?from={frm}&to={to}", token=admin)
            m["result"]["positions_after_resend"] = tr["total"]
            m["result"]["duplicates_created"] = tr["total"] - before[m["id"]]
            assert tr["total"] == before[m["id"]], f"{m['proto']}: replay added positions"

        for m in MACHINES:
            report["machines"].append({k: m[k] for k in ("profile", "proto", "imei", "body", "send_stats", "result")})
        report["gateway_stats"] = gw.stats
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2,
                                     default=lambda o: o.hex() if isinstance(o, bytes) else str(o)))
        print(json.dumps([{"machine": m["body"]["name"], **m["result"]} for m in MACHINES], ensure_ascii=False, indent=1))
        loop.call_soon_threadsafe(loop.stop)
    finally:
        srv.terminate()
        try:
            srv.wait(10)
        except Exception:
            srv.kill()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "docs" / "evidence" / "gateway-e2e.json",
                        help="report path; defaults to docs/evidence/gateway-e2e.json")
    main(parser.parse_args().output)
