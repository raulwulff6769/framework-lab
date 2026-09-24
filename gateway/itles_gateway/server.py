"""asyncio TCP listeners, one per protocol."""

from __future__ import annotations

import asyncio
import logging

from .protocols.egts import EgtsSession
from .protocols.galileosky import GalileoskySession
from .protocols.navtelecom_flex import FlexSession
from .protocols.retranslator import RetranslatorSession
from .protocols.wialon_ips import WialonIpsSession
from .queue import DurableQueue
from .records import Mapping

log = logging.getLogger("itles.server")

SESSIONS = {
    "galileosky": GalileoskySession,
    "wialon_ips": WialonIpsSession,
    "egts": EgtsSession,
    "wialon_retranslator": RetranslatorSession,
    "navtelecom_flex": FlexSession,
}
IDLE_TIMEOUT_S = 15 * 60


class Gateway:
    def __init__(self, queue: DurableQueue, mappings: dict[str, Mapping] | None = None):
        self.q = queue
        self.mappings = mappings or {}
        self.stats = {"connections": 0, "records": 0, "errors": 0}

    def handler(self, proto: str):
        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            peer = writer.get_extra_info("peername")
            session = SESSIONS[proto](self.mappings.get("*"))
            self.stats["connections"] += 1
            try:
                while True:
                    data = await asyncio.wait_for(reader.read(65536), timeout=IDLE_TIMEOUT_S)
                    if not data:
                        break
                    if session.ext_id and session.ext_id in self.mappings:
                        session.mapping = self.mappings[session.ext_id]
                    for records, reply in session.feed(data):
                        if records:
                            # durable before ACK: the device may delete these records from its archive
                            await asyncio.to_thread(self.q.put, session.ext_id or "", proto, records)
                            self.stats["records"] += len(records)
                        if reply:
                            writer.write(reply)
                    await writer.drain()
            except asyncio.TimeoutError:
                pass
            except Exception as e:
                self.stats["errors"] += 1
                log.warning("%s %s ext_id=%s: %s", proto, peer, session.ext_id, e)
            finally:
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass

        return handle

    async def serve(self, ports: dict[str, int], host: str = "0.0.0.0") -> list[asyncio.base_events.Server]:
        servers = []
        for proto, port in ports.items():
            srv = await asyncio.start_server(self.handler(proto), host, port)
            log.info("listening %s on %s:%d", proto, host, port)
            servers.append(srv)
        return servers
