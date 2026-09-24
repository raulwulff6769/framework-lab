"""Platform-to-platform EGTS retranslation (ГОСТ 33472-2015 transport, ГОСТ 33465-2015 services), as a
monitoring platform (e.g. Omnicomm Online) forwards its units to another server: the sender
authenticates as a dispatcher (EGTS_SR_DISPATCHER_IDENTITY, subrecord 5: DT, DID, optional DSCR),
then every TELEDATA record carries the object ID (OID) of its unit. Fuel from a tank level sensor is
sent as EGTS_SR_LIQUID_LEVEL_SENSOR (subrecord 27): flags (LLSN bits 0-2, RDF bit 3, LLSVU bits 4-5,
LLSEF bit 6), module address (2 bytes), value (4 bytes; LLSVU 10 = 0.1 litre).
"""

from __future__ import annotations

import socket
import struct

from . import egts

SR_DISPATCHER_IDENTITY = 5
SR_LIQUID_LEVEL_SENSOR = 27
LLSVU_LITRES_X10 = 0b10


def dispatcher_identity(dispatcher_id: int, dispatcher_type: int = 0, description: str = "") -> bytes:
    return egts.subrecord(SR_DISPATCHER_IDENTITY, struct.pack("<BI", dispatcher_type, dispatcher_id) + description.encode("cp1251"))


def liquid_level(sensor: int, litres: float, module_address: int = 0) -> bytes:
    flags = (sensor & 0x07) | LLSVU_LITRES_X10 << 4
    return egts.subrecord(SR_LIQUID_LEVEL_SENSOR, struct.pack("<BHI", flags, module_address, max(0, round(litres * 10))))


class EgtsRetranslator:
    """One TCP connection of a platform retranslator to the receiving server."""

    def __init__(self, host: str, port: int, dispatcher_id: int, timeout: float = 15.0):
        self.host, self.port, self.dispatcher_id, self.timeout = host, port, dispatcher_id, timeout
        self.sock: socket.socket | None = None
        self.pid = 0
        self.rn = 0
        self.stats = {"packets": 0, "records": 0, "bytes": 0, "acked": 0}

    def _send(self, sfrd: bytes) -> bytes:
        assert self.sock is not None
        pkt = egts.transport(sfrd, self.pid)
        self.pid = (self.pid + 1) & 0xFFFF
        self.sock.sendall(pkt)
        self.stats["packets"] += 1
        self.stats["bytes"] += len(pkt)
        buf = b""
        while True:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("server closed the connection")
            buf += chunk
            frames, _rest = egts.split_frames(buf)
            if any(egts.decode(f)["type"] == egts.PT_RESPONSE for f in frames):
                self.stats["acked"] += 1
                return pkt

    def connect(self) -> bytes:
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.rn += 1
        return self._send(egts.record(self.rn, egts.SERVICE_AUTH, dispatcher_identity(self.dispatcher_id, description="Omnicomm Online (эмуляция)")))

    def send(self, oid: int, points: list[egts.EgtsPoint], fuel_l: list[float | None] | None = None) -> bytes:
        body = b""
        for i, p in enumerate(points):
            self.rn += 1
            subs = egts.pos_data(p) + egts.ext_pos_data(p) + egts.abs_counters(p.counters) + egts.abs_analog(p.analog)
            if fuel_l and fuel_l[i] is not None:
                subs += liquid_level(1, fuel_l[i])
            body += egts.record(self.rn, egts.SERVICE_TELEDATA, subs, object_id=oid)
        self.stats["records"] += len(points)
        return self._send(body)

    def close(self) -> None:
        if self.sock:
            self.sock.close()
            self.sock = None
