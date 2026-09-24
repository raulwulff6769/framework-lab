"""J1939 frames from the engine model, and their decoding on the tracker side.

Frames use the SAE J1939-71 layouts from sim/j1939.py (EEC1, ET1, EFL/P1, HOURS, LFC, LFE, DD, VDHR,
CCVS) plus EEC2 (SPN 92 load), VEP1 (SPN 168 battery potential), AMB (SPN 171 ambient) and DM1 (active
diagnostic trouble codes, J1939-73). The tracker emulator reads values only from these frames, so they
carry the real resolution and rounding of the bus.
"""

from __future__ import annotations

import struct

from sim import j1939

ENGINE_SA = 0x00
PGN_EEC2, PGN_VEP1, PGN_AMB, PGN_DM1 = 61443, 65271, 65269, 65226


def _frame(pgn: int, data: bytes, priority: int = 6) -> tuple[int, bytes]:
    return j1939.can_id(pgn, ENGINE_SA, priority=priority), data


def frames(s, odometer: bool) -> list[tuple[int, bytes]]:
    """One cycle of broadcast frames; only a running engine controller talks on the bus."""
    if not s.engine:
        return []
    out = [
        _frame(61444, j1939.encode(61444, {190: min(8031.0, s.rpm)}), 3),
        _frame(PGN_EEC2, bytes([0xFF, 0xFF, max(0, min(250, round(s.load))), 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), 3),
        _frame(65262, j1939.encode(65262, {110: max(-40.0, min(210.0, round(s.coolant)))})[:2]
               + struct.pack("<H", max(0, min(0xFAFF, round((s.oil_temp + 273) / 0.03125)))) + b"\xff" * 4),
        _frame(65263, j1939.encode(65263, {100: min(1000.0, max(0.0, round(s.oil_kpa / 4) * 4))})),
        _frame(65253, j1939.encode(65253, {247: round(s.hours / 0.05) * 0.05})),
        _frame(65257, j1939.encode(65257, {250: round(s.fuel_used_l / 0.5) * 0.5})),
        _frame(65266, j1939.encode(65266, {183: min(3212.0, round(s.fuel_rate / 0.05) * 0.05)})),
        _frame(PGN_VEP1, b"\xff" * 4 + struct.pack("<H", round(s.battery_v / 0.05)) + b"\xff\xff"),
        _frame(PGN_AMB, b"\xff" * 3 + struct.pack("<H", round((s.ambient + 273) / 0.03125)) + b"\xff" * 3),
        _frame(65265, j1939.encode(65265, {84: min(250.0, s.speed_kmh)})),
    ]
    if odometer:
        out.append(_frame(65217, j1939.encode(65217, {917: round(s.odo_m / 5) * 5})))
    out.append(_frame(PGN_DM1, dm1(s.faults)))
    return out


def dm1(faults: list[tuple[int, int, int]]) -> bytes:
    """DM1: lamp status, then SPN/FMI/OC of the first active code (more codes use the BAM transport)."""
    if not faults:
        return bytes([0x00, 0xFF, 0, 0, 0, 0, 0xFF, 0xFF])
    spn, fmi, oc = faults[0]
    red = spn in (100, 110)
    lamps = (0b01 << 4) if red else (0b01 << 2)  # red stop lamp or amber warning lamp on
    return bytes([lamps, 0xFF, spn & 0xFF, spn >> 8 & 0xFF, (spn >> 16 & 0x07) << 5 | fmi & 0x1F, oc & 0x7F, 0xFF, 0xFF])


def read(frames_: list[tuple[int, bytes]]) -> dict:
    """What a CAN reader decodes from one cycle of frames (engineering units, J1939 resolution)."""
    v: dict = {}
    for ident, data in frames_:
        _, pgn, _, _ = j1939.parse_can_id(ident)
        if pgn in j1939.PGNS:
            for spn, r in j1939.decode(pgn, data).items():
                if r.value is not None:
                    v[spn] = r.value
        if pgn == 65262 and data[2:4] != b"\xff\xff":
            v[175] = struct.unpack("<H", data[2:4])[0] * 0.03125 - 273
        elif pgn == PGN_EEC2 and data[2] <= 250:
            v[92] = data[2]
        elif pgn == PGN_VEP1:
            v[168] = struct.unpack("<H", data[4:6])[0] * 0.05
        elif pgn == PGN_AMB:
            v[171] = struct.unpack("<H", data[3:5])[0] * 0.03125 - 273
        elif pgn == PGN_DM1:
            lamp = data[0]
            spn = data[2] | data[3] << 8 | (data[4] >> 5) << 16
            v["dtc"] = [] if lamp == 0 and spn == 0 else [(spn, data[4] & 0x1F, data[5] & 0x7F)]
    return v


def candump(ident: int, data: bytes) -> str:
    return f"can0  {ident:08X}   [{len(data)}]  {' '.join(f'{b:02X}' for b in data)}"


PGN_NAME = {61444: "EEC1", PGN_EEC2: "EEC2", 65262: "ET1", 65263: "EFL/P1", 65253: "HOURS", 65257: "LFC", 65266: "LFE",
            PGN_VEP1: "VEP1", PGN_AMB: "AMB", 65265: "CCVS", 65217: "VDHR", PGN_DM1: "DM1", 65276: "DD"}
