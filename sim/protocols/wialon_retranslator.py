"""Wialon Retranslator protocol v1.0 (Gurtam): how Wialon Hosting/Local forwards unit messages to a
third-party server. Packet: size (4 bytes LE of the rest), unit ID (ASCIIZ), UNIX time (4 bytes BE),
flags (4 bytes BE), then blocks 0x0BBB: size (4 bytes BE), hidden flag, data type
(1 text, 2 binary, 3 int32 BE, 4 double LE, 5 int64 BE), name (ASCIIZ), value. The "posinfo" block is
binary: lon, lat, alt (double LE), speed and course (int16 BE), satellites (byte). The receiver
answers every packet with 0x11. Reference: Gurtam "Wialon Retranslator protocol" specification.
"""

from __future__ import annotations

import socket
import struct

FLAG_POSINFO = 0x01
FLAG_DIGITAL_INPUTS = 0x02
BLOCK = 0x0BBB


def _block(name: str, dtype: int, value: bytes, hidden: bool = False) -> bytes:
    body = bytes([1 if hidden else 0, dtype]) + name.encode("ascii") + b"\x00" + value
    return struct.pack(">Hi", BLOCK, len(body)) + body


def encode(unit_id: str, t: int, lat: float | None, lon: float | None, alt: float, speed_kmh: int, course: int, sats: int,
           params: dict[str, int | float | str]) -> bytes:
    flags = FLAG_POSINFO if lat is not None and lon is not None else 0
    body = unit_id.encode("ascii") + b"\x00" + struct.pack(">II", t, flags)
    if flags & FLAG_POSINFO:
        body += _block("posinfo", 2, struct.pack("<ddd", lon, lat, alt) + struct.pack(">hh", speed_kmh, course % 360) + bytes([sats]))
    for name, v in params.items():
        if isinstance(v, str):
            body += _block(name, 1, v.encode("utf-8") + b"\x00")
        elif isinstance(v, bool) or (isinstance(v, int) and -(2**31) <= v < 2**31):
            body += _block(name, 3, struct.pack(">i", int(v)))
        elif isinstance(v, int):
            body += _block(name, 5, struct.pack(">q", v))
        else:
            body += _block(name, 4, struct.pack("<d", float(v)))
    return struct.pack("<I", len(body)) + body


def send_packets(host: str, port: int, packets: list[bytes], timeout: float = 15.0, on_packet=None) -> dict:
    stats = {"sent": 0, "acked": 0, "bytes": 0}
    with socket.create_connection((host, port), timeout=timeout) as s:
        for pkt in packets:
            s.sendall(pkt)
            stats["sent"] += 1
            stats["bytes"] += len(pkt)
            if s.recv(1) == b"\x11":
                stats["acked"] += 1
            if on_packet:
                on_packet(pkt)
    return stats
