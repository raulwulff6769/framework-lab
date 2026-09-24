"""TCP clients that talk to a real gateway exactly like trackers do (with acks)."""

from __future__ import annotations

import socket
import struct

from .protocols import egts, galileosky, navtelecom, wialon_ips
from .tracker import Record


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("gateway closed the connection")
        buf += chunk
    return buf


def galileo_record(r: Record) -> galileosky.GalileoRecord:
    return galileosky.GalileoRecord(
        r.index, r.t, r.lat, r.lon, r.valid, r.sats, r.speed_kmh, r.course, r.alt_m, r.hdop,
        1 if r.ignition else 0, round(r.power_v * 1000), round(r.gps_odometer_m),
        r.rpm, r.coolant_c, r.fuel_level_pct, r.fuel_total_raw, r.can_distance_raw,
        None if r.can_hours_raw is None else r.can_hours_raw * 5)  # SPN 247 0.05 h/bit -> 0xDB 0.01 h


def send_galileosky(host: str, port: int, imei: str, records: list[Record], late_s: int = 120, extra=None) -> dict:
    stats = {"packets": 0, "bytes": 0, "acks_ok": 0}
    groups: list[tuple[bool, list[Record]]] = []
    for r in records:
        # Records delivered long after they were taken are sent with the archive bit.
        archived = r.delivered_t is not None and r.delivered_t - r.t > late_s
        if groups and groups[-1][0] == archived:
            groups[-1][1].append(r)
        else:
            groups.append((archived, [r]))
    packets = [galileosky.head_packet(imei)]
    for archived, group in groups:
        recs = [galileo_record(x) for x in group]
        if extra:
            for gr, x in zip(recs, group):
                gr.analog_mv = extra(x)
        packets += galileosky.records_packets(recs, archive=archived)
    with socket.create_connection((host, port), timeout=10) as sock:
        for p in packets:
            sock.sendall(p)
            ack = _recv_exact(sock, 3)
            stats["packets"] += 1
            stats["bytes"] += len(p)
            stats["acks_ok"] += ack == galileosky.expected_ack(p)
    return stats


def wialon_message(r: Record, hours_method: str) -> wialon_ips.WialonMessage:
    params: dict[str, int | float | str] = {"ign": int(r.ignition), "pwr_ext": round(r.power_v, 2),
                                            "gps_odom_km": round(r.gps_odometer_m / 1000, 3)}
    hours = r.hours.get(hours_method)
    if hours is not None:
        params["eng_hours"] = round(hours, 2)
        params["eng_hours_src"] = hours_method
    if r.can_distance_raw is not None:
        params["can_dist_km"] = round(r.can_distance_raw * 0.005, 3)
    if r.rpm is not None:
        params["rpm"] = round(r.rpm)
    return wialon_ips.WialonMessage(r.t, r.lat, r.lon, r.speed_kmh, r.course, r.alt_m, r.sats, r.hdop,
                                    1 if r.ignition else 0, params)


def send_wialon(host: str, port: int, imei: str, records: list[Record], hours_method: str, chunk: int = 100, extra=None) -> dict:
    stats = {"packets": 0, "bytes": 0, "acks_ok": 0}
    with socket.create_connection((host, port), timeout=10) as sock:
        reader = sock.makefile("rb")
        login = wialon_ips.login(imei)
        sock.sendall(login)
        stats["login_reply"] = reader.readline().decode().strip()
        for i in range(0, len(records), chunk):
            part = records[i : i + chunk]
            msgs = [wialon_message(r, hours_method) for r in part]
            if extra:
                for msg, r in zip(msgs, part):
                    msg.params.update(extra(r))
            packet = wialon_ips.blackbox(msgs)
            sock.sendall(packet)
            reply = reader.readline().decode().strip()
            stats["packets"] += 1
            stats["bytes"] += len(packet)
            # Traccar counts the trailing CRC field as a message (len(split('|')) == n + 1).
            stats["acks_ok"] += reply in (f"#AB#{len(part)}", f"#AB#{len(part) + 1}")
    return stats


def egts_point(r: Record, hours_method: str) -> egts.EgtsPoint:
    counters = {}
    hours = r.hours.get(hours_method)
    if hours is not None:
        counters[1] = round(hours * 10)  # counter 1: engine hours, 0.1 h (stand convention)
    if r.can_distance_raw is not None:
        counters[2] = round(r.can_distance_raw * 0.005 * 10)  # counter 2: CAN distance, 0.1 km
    return egts.EgtsPoint(r.t, r.lat, r.lon, r.valid, r.speed_kmh, r.course, r.gps_odometer_m / 1000,
                          1 if r.ignition else 0, r.alt_m, r.sats, r.hdop, r.speed_kmh >= 3,
                          r.delivered_t is not None and r.delivered_t - r.t > 120, counters)


def send_egts(host: str, port: int, imei: str, records: list[Record], hours_method: str, chunk: int = 20, extra=None) -> dict:
    stats = {"packets": 0, "bytes": 0, "responses": 0, "response_crc_ok": 0, "sent_packets": []}
    with socket.create_connection((host, port), timeout=10) as sock:
        pid = 1
        auth = egts.transport(egts.record(1, egts.SERVICE_AUTH, egts.term_identity(1, imei)), pid)
        outgoing = [auth]
        for i in range(0, len(records), chunk):
            pid += 1
            pts = [egts_point(r, hours_method) for r in records[i : i + chunk]]
            if extra:
                for pt, r in zip(pts, records[i : i + chunk]):
                    pt.analog = extra(r)
            outgoing.append(egts.transport(egts.teledata_records(pts, i + 2), pid))
        buffer = b""

        def consume() -> int:
            nonlocal buffer
            frames, buffer = egts.split_frames(buffer)
            for f in frames:
                stats["responses"] += 1
                try:
                    egts.decode(f)
                    stats["response_crc_ok"] += 1
                except ValueError:
                    pass
            return len(frames)

        for packet in outgoing:
            sock.sendall(packet)
            stats["packets"] += 1
            stats["bytes"] += len(packet)
            stats["sent_packets"].append(packet)
            # The gateway answers every record; wait for at least one frame per packet.
            while consume() == 0:
                buffer += sock.recv(65536)
        sock.settimeout(1.5)
        try:
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buffer += chunk
                consume()
        except TimeoutError:
            pass
    return stats


FLEX_FIELDS = (1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 37, 57, 67, 71)


def _flex_record(r: Record) -> bytes:
    can_hours = r.hours.get("can")
    tracker_hours = r.hours.get("ignition")
    values = {
        1: struct.pack("<I", r.index), 2: struct.pack("<H", 1), 3: struct.pack("<I", r.t),
        8: bytes([min(r.sats, 63) << 2 | 0x01 | (0x02 if r.valid else 0)]), 9: struct.pack("<I", r.t),
        10: struct.pack("<i", round(r.lat * 600_000)),
        11: struct.pack("<i", round(r.lon * 600_000)),
        12: struct.pack("<i", round(r.alt_m * 10)), 13: struct.pack("<f", r.speed_kmh),
        14: struct.pack("<H", round(r.course)), 15: struct.pack("<f", r.gps_odometer_m / 1000),
        37: struct.pack("<I", round(tracker_hours * 3600) if tracker_hours is not None else 0xFFFFFFFF),
        57: struct.pack("<f", r.can_distance_raw * 0.005 if r.can_distance_raw is not None else float("nan")),
        67: struct.pack("<I", round(can_hours * 3600) if can_hours is not None else 0xFFFFFFFF),
        71: bytes((min(round(r.hdop * 10), 255), min(round(r.hdop * 10), 255))),
    }
    return navtelecom.flex_record(values, navtelecom.flex_mask(FLEX_FIELDS))


def send_navtelecom(host: str, port: int, imei: str, records: list[Record], chunk: int = 20) -> dict:
    stats = {"packets": 0, "bytes": 0, "acks_ok": 0}
    with socket.create_connection((host, port), timeout=10) as sock:
        outgoing = (
            (navtelecom.ntcb(b"*>S:" + imei.encode()), navtelecom.ntcb(b"*<S", receiver=0, sender=1)),
            (navtelecom.negotiation(FLEX_FIELDS),
             navtelecom.ntcb(b"*<FLEX\xb0\x14\x14", receiver=0, sender=1)),
        )
        for packet, expected in outgoing:
            sock.sendall(packet)
            stats["packets"] += 1
            stats["bytes"] += len(packet)
            stats["acks_ok"] += _recv_exact(sock, len(expected)) == expected
        for i in range(0, len(records), chunk):
            part = records[i : i + chunk]
            packet = navtelecom.frame("A", b"".join(_flex_record(r) for r in part), count=len(part))
            expected = navtelecom.frame("A", b"", count=len(part))
            sock.sendall(packet)
            stats["packets"] += 1
            stats["bytes"] += len(packet)
            stats["acks_ok"] += _recv_exact(sock, len(expected)) == expected
    return stats
