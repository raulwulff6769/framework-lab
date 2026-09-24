"""Run: ITLES_API_URL=https://... GATEWAY_TOKEN=... python -m itles_gateway"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time

from .forwarder import Forwarder
from .queue import DurableQueue
from .records import Mapping
from .server import Gateway

DEFAULT_PORTS = {"galileosky": 5034, "wialon_ips": 5039, "egts": 5037, "wialon_retranslator": 5090}


def write_status(path: str, gw: Gateway, q: DurableQueue, fwd: Forwarder, ports: dict[str, int], stop: threading.Event) -> None:
    """Snapshot for the live stand's monitoring page; written atomically every few seconds."""
    while not stop.wait(5):
        try:
            snap = {
                "t": time.time(), "ports": ports, **gw.stats, "queue": q.size(), "queue_by_device": q.by_device(),
                "forwarded": fwd.forwarded, "last_forward_ok_t": fwd.last_ok_t, "last_error": fwd.last_error,
            }
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(snap, f)
            os.replace(tmp, path)
        except Exception:
            logging.getLogger("itles.gateway").exception("status file")


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(name)s %(levelname)s %(message)s")
    api = os.environ["ITLES_API_URL"]
    token = os.environ["GATEWAY_TOKEN"]
    q = DurableQueue(os.environ.get("QUEUE_PATH", "itles-gateway.sqlite3"))
    ports = {k: int(os.environ.get(f"PORT_{k.upper()}", v)) for k, v in DEFAULT_PORTS.items()}
    if os.environ.get("PORT_NAVTELECOM_FLEX"):
        ports["navtelecom_flex"] = int(os.environ["PORT_NAVTELECOM_FLEX"])
    mappings: dict[str, Mapping] = {}
    if os.environ.get("MAPPINGS_FILE"):
        with open(os.environ["MAPPINGS_FILE"], encoding="utf-8") as f:
            mappings = {k: Mapping.from_dict(v) for k, v in json.load(f).items()}
    fwd = Forwarder(q, api, token)
    threading.Thread(target=fwd.loop, daemon=True, name="forwarder").start()

    async def run() -> None:
        gw = Gateway(q, mappings)
        if os.environ.get("STATUS_FILE"):
            threading.Thread(target=write_status, args=(os.environ["STATUS_FILE"], gw, q, fwd, ports, fwd.stop), daemon=True, name="status").start()
        servers = await gw.serve(ports)
        await asyncio.gather(*(s.serve_forever() for s in servers))

    asyncio.run(run())


if __name__ == "__main__":
    main()
