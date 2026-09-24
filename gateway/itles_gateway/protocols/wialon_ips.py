"""Wialon IPS 1.1 / 2.x text protocol (Gurtam specification v2.2)."""

from __future__ import annotations

import calendar
import math

from ..crc import crc16_arc
from ..records import Mapping, apply_sensors, clean, params_to_counters


def _num(s: str) -> float | None:
    if s in ("", "NA"):
        return None
    try:
        value = float(s)
        return value if math.isfinite(value) else None
    except ValueError:
        return None


def _coord(value: str, hemi: str, deg_digits: int) -> float | None:
    if value in ("", "NA") or hemi in ("", "NA"):
        return None
    v = _num(value)
    if v is None or v < 0 or hemi not in (("N", "S") if deg_digits == 2 else ("E", "W")):
        return None
    deg = int(v // 100)
    minutes = v - deg * 100
    res = deg + minutes / 60
    if not 0 <= minutes < 60 or res > (90 if deg_digits == 2 else 180):
        return None
    return -res if hemi in ("S", "W") else res


def parse_params(s: str) -> dict:
    out: dict = {}
    if s in ("", "NA"):
        return out
    for item in s.split(","):
        parts = item.split(":", 2)
        if len(parts) != 3:
            continue
        name, typ, val = parts
        try:
            out[name] = int(val) if typ == "1" else float(val) if typ == "2" else val
        except ValueError:
            continue
    return out


def parse_data_body(fields: list[str], mapping: Mapping, short: bool) -> dict | None:
    """fields of #D# / #SD# / black-box message without CRC."""
    if len(fields) < (10 if short else 16):
        return None
    date, tm = fields[0], fields[1]
    if date == "NA" or tm == "NA" or len(date) != 6 or len(tm) < 6:
        return None
    t = calendar.timegm(
        (2000 + int(date[4:6]), int(date[2:4]), int(date[0:2]), int(tm[0:2]), int(tm[2:4]), int(float(tm[4:])), 0, 0, 0)
    )
    rec: dict = {"t": t}
    lat = _coord(fields[2], fields[3], 2)
    lon = _coord(fields[4], fields[5], 3)
    sats = _num(fields[9])
    hdop = _num(fields[10]) if not short else None
    if (lat is not None and lon is not None
            and (sats is None or sats >= 3) and (hdop is None or 0 <= hdop < 50)):
        rec.update(lat=lat, lon=lon, speed_kmh=_num(fields[6]), course=_num(fields[7]), alt=_num(fields[8]))
        rec["sats"] = int(sats) if sats is not None else None
        if not short:
            rec["hdop"] = hdop
    if not short:
        params = parse_params(fields[15])
        params_to_counters(params, mapping, rec)
        apply_sensors(mapping, rec, params=params)
    return clean(rec)


class WialonIpsSession:
    proto = "wialon_ips"

    def __init__(self, mapping: Mapping | None = None):
        self.buf = b""
        self.ext_id: str | None = None
        self.v2 = False
        self.login_crc_ok: bool | None = None
        self.mapping = mapping or Mapping()

    def _check(self, body: str) -> tuple[bool, str]:
        """v2.x: last field is CRC16 (hex) over everything before it. Returns (ok, body_without_crc)."""
        if not self.v2:
            return True, body
        idx = max(body.rfind(";"), body.rfind("|"))
        head, crc = body[: idx + 1], body[idx + 1 :]
        try:
            return crc16_arc(head.encode("utf-8")) == int(crc, 16), head
        except ValueError:
            return False, head

    def feed(self, data: bytes) -> list[tuple[list[dict], bytes]]:
        self.buf += data
        out = []
        while b"\r\n" in self.buf:
            line, self.buf = self.buf.split(b"\r\n", 1)
            text = line.decode("utf-8", "replace")
            if not text.startswith("#"):
                continue
            end = text.find("#", 1)
            kind, body = text[1:end], text[end + 1 :]
            if kind == "L":
                parts = body.split(";")
                if parts[0].startswith("2."):
                    self.v2 = True
                    # Login CRC is not enforced: it carries only the id (unknown ids never reach the
                    # platform) and field devices/test captures exist with a CRC over a redacted password.
                    self.login_crc_ok, _ = self._check(body)
                    self.ext_id = parts[1]
                else:
                    self.ext_id = parts[0]
                out.append(([], b"#AL#1\r\n"))
            elif kind == "P":
                out.append(([], b"#AP#\r\n"))
            elif self.ext_id is None:
                out.append(([], b"#AL#0\r\n"))
            elif kind in ("D", "SD"):
                ok, head = self._check(body)
                if not ok:
                    out.append(([], f"#A{kind}#{'16' if kind == 'D' else '13'}\r\n".encode()))
                    continue
                fields = head.rstrip(";").split(";")
                rec = parse_data_body(fields, self.mapping, kind == "SD")
                if rec is None:
                    out.append(([], f"#A{kind}#-1\r\n".encode()))
                else:
                    out.append(([rec], f"#A{kind}#1\r\n".encode()))
            elif kind == "B":
                ok, head = self._check(body)
                if not ok:
                    out.append(([], b"#AB#\r\n"))
                    continue
                recs = []
                for msg in filter(None, head.split("|")):
                    r = parse_data_body(msg.split(";"), self.mapping, len(msg.split(";")) < 16)
                    if r:
                        recs.append(r)
                out.append((recs, f"#AB#{len([m for m in head.split('|') if m])}\r\n".encode()))
        return out
