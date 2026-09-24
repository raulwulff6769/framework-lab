"""Teltonika Codec 8 Extended (0x8E) over TCP, as sent by FMB/FMC trackers.

Spec: https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended (packet: 4 zero bytes, data length,
codec 0x8E, record count, AVL records, record count, CRC-16/IBM over codec..count; the server
answers the IMEI with 0x01 and each packet with the 4-byte number of accepted records).

IO IDs used by the stand (FMC150 with CAN data reading) and how Traccar 6.x TeltonikaProtocolDecoder
turns them into position attributes (model must match "FM[B-Z]..." and not "FM.6.."):
  16  total odometer, m            -> odometer (any model)
  66  external voltage, mV         -> power, V
  67  battery voltage, mV          -> battery, V
  181 PDOP x10 / 182 HDOP x10      -> pdop / hdop
  239 ignition / 240 movement      -> ignition / motion
  83  CAN fuel used, 0.1 l         -> fuelUsed, l
  84  CAN fuel level, 0.1 l        -> fuel, l
  85  CAN engine speed, rpm        -> rpm
  87  CAN total mileage, m         -> obdOdometer, m
  89  CAN fuel level, %            -> fuelLevel, %
  110 CAN fuel rate, 0.1 l/h       -> fuelConsumption, l/h
  115 CAN engine temperature, 0.1 C-> engineTemp, C
  103 CAN engine worktime, min     -> not mapped by Traccar: arrives as attribute io103
"""

from __future__ import annotations

import socket
import struct
from dataclasses import dataclass, field

from ..crc import crc16_arc

CODEC_8E = 0x8E
# fixed value sizes of the IDs above (Teltonika AVL ID list); others are sized by value
IO_SIZE = {16: 4, 66: 2, 67: 2, 181: 2, 182: 2, 239: 1, 240: 1, 83: 4, 84: 2, 85: 2, 87: 4, 89: 1, 110: 2, 115: 2, 103: 4}


@dataclass
class AvlRecord:
    t_ms: int
    lat: float
    lon: float
    alt: int
    course: int
    sats: int
    speed_kmh: int
    priority: int = 0
    event_id: int = 0
    io: dict[int, int] = field(default_factory=dict)


def imei_packet(imei: str) -> bytes:
    return struct.pack(">H", len(imei)) + imei.encode("ascii")


def _size(io_id: int, v: int) -> int:
    if io_id in IO_SIZE:
        return IO_SIZE[io_id]
    return 1 if 0 <= v <= 0xFF else 2 if -0x8000 <= v <= 0xFFFF else 4 if -0x80000000 <= v <= 0xFFFFFFFF else 8


def _record(r: AvlRecord) -> bytes:
    out = struct.pack(">QB", r.t_ms, r.priority)
    out += struct.pack(">iihHBH", round(r.lon * 1e7), round(r.lat * 1e7), r.alt, r.course % 360, r.sats, max(0, r.speed_kmh))
    groups: dict[int, list[tuple[int, int]]] = {1: [], 2: [], 4: [], 8: []}
    for k, v in sorted(r.io.items()):
        groups[_size(k, v)].append((k, v))
    out += struct.pack(">HH", r.event_id, sum(len(g) for g in groups.values()))
    for size, fmt in ((1, "B"), (2, "H"), (4, "I"), (8, "Q")):
        out += struct.pack(">H", len(groups[size]))
        for k, v in groups[size]:
            out += struct.pack(">H", k) + (v & ((1 << (8 * size)) - 1)).to_bytes(size, "big")
    out += struct.pack(">H", 0)  # NX: no variable-length elements
    return out


def avl_packet(records: list[AvlRecord]) -> bytes:
    if not 1 <= len(records) <= 255:
        raise ValueError("1..255 records per packet")
    data = bytes([CODEC_8E, len(records)]) + b"".join(_record(r) for r in records) + bytes([len(records)])
    return b"\x00\x00\x00\x00" + struct.pack(">I", len(data)) + data + struct.pack(">I", crc16_arc(data))


def decode_avl(packet: bytes) -> list[AvlRecord]:
    if packet[:4] != b"\x00\x00\x00\x00":
        raise ValueError("preamble")
    (length,) = struct.unpack_from(">I", packet, 4)
    data = packet[8 : 8 + length]
    if struct.unpack_from(">I", packet, 8 + length)[0] != crc16_arc(data):
        raise ValueError("crc")
    if data[0] != CODEC_8E:
        raise ValueError("codec")
    n, pos, out = data[1], 2, []
    for _ in range(n):
        t, prio = struct.unpack_from(">QB", data, pos)
        lon, lat, alt, course, sats, speed = struct.unpack_from(">iihHBH", data, pos + 9)
        pos += 24
        event_id, _total = struct.unpack_from(">HH", data, pos)
        pos += 4
        io: dict[int, int] = {}
        for size in (1, 2, 4, 8):
            (cnt,) = struct.unpack_from(">H", data, pos)
            pos += 2
            for _ in range(cnt):
                (k,) = struct.unpack_from(">H", data, pos)
                io[k] = int.from_bytes(data[pos + 2 : pos + 2 + size], "big")
                pos += 2 + size
        (nx,) = struct.unpack_from(">H", data, pos)
        pos += 2
        for _ in range(nx):
            k, ln = struct.unpack_from(">HH", data, pos)
            pos += 4 + ln
        out.append(AvlRecord(t, lat / 1e7, lon / 1e7, alt, course, sats, speed, prio, event_id, io))
    if data[pos] != n:
        raise ValueError("record count mismatch")
    return out


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("server closed the connection")
        buf += chunk
    return buf


def send_records(host: str, port: int, imei: str, records: list[AvlRecord], batch: int = 50, timeout: float = 15.0,
                 on_packet=None) -> dict:
    """TCP session like the device firmware: IMEI → 0x01, then packets until everything is acknowledged."""
    stats = {"sent": 0, "acked": 0, "bytes": 0}
    with socket.create_connection((host, port), timeout=timeout) as s:
        hello = imei_packet(imei)
        s.sendall(hello)
        stats["bytes"] += len(hello)
        if _recv_exact(s, 1) != b"\x01":
            raise ConnectionError("IMEI rejected by the server")
        for i in range(0, len(records), batch):
            chunk = records[i : i + batch]
            pkt = avl_packet(chunk)
            s.sendall(pkt)
            stats["sent"] += len(chunk)
            stats["bytes"] += len(pkt)
            acked = struct.unpack(">I", _recv_exact(s, 4))[0]
            stats["acked"] += acked
            if on_packet:
                on_packet(pkt, chunk, acked)
    return stats
