"""Normalized record = the JSON accepted by POST /api/ingest (see platform/server/ingest.ts)."""

from __future__ import annotations

import struct
from dataclasses import dataclass, field


@dataclass
class Mapping:
    """How device-specific values become engine hours / odometer.

    Defaults follow vendor documents: Galileosky FMS mode puts total engine hours into tag 0xDB
    (value/100 = h) and vehicle distance into 0xC2 (value*5 = m). EGTS has no standard engine-hour
    field (ГОСТ 33472 ABS_CNTR_DATA is an unnamed counter), so it must be configured per device.
    """

    galileo_hours_tag: int | None = 0xDB
    galileo_hours_scale: float = 0.01
    egts_hours_counter: int | None = None
    egts_hours_scale: float = 0.1
    param_hours: dict[str, str] = field(
        default_factory=lambda: {"can_engine_hours": "ecu", "engine_hours": "tracker", "motohours": "tracker"}
    )
    param_hours_scale: float = 1.0
    param_mileage: dict[str, str] = field(
        default_factory=lambda: {"can_mileage": "ecu", "mileage": "tracker", "odometer": "tracker"}
    )
    param_mileage_scale: float = 1.0
    # oil sensors: key -> source + transform, e.g.
    #   {"oil_level_pct": {"param": "oil_lvl"}}                  Wialon IPS / Retranslator parameter
    #   {"oil_level_pct": {"tag": 0x50, "table": [[0, 0], [9800, 100]]}}  Galileosky tag (mV) + calibration
    #   {"oil_level_low": {"tag": 0x46, "bit": 2}}              Galileosky discrete input bit
    #   {"oil_level_pct": {"egts_an": 1, "scale": 0.1}}         EGTS ABS_AN_SENS_DATA input number
    #   {"oil_water_aw": {"tag": 0xE2, "float": True}}          Galileosky user tag (RS-485/Modbus algorithm), IEEE-754
    #   {"oil_level_low": {"tag": 0x50, "threshold": 1900, "when": "below"}}  current-type level switch via shunt
    #   {"fuel_level_l": {"egts_lls": 1}}                         EGTS LIQUID_LEVEL_SENSOR number (litres)
    sensors: dict = field(default_factory=dict)

    @staticmethod
    def from_dict(d: dict) -> "Mapping":
        m = Mapping()
        for k, v in d.items():
            if hasattr(m, k):
                setattr(m, k, v)
        return m


def clean(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if v is not None}


def params_to_counters(params: dict, mapping: Mapping, rec: dict) -> None:
    for name, method in mapping.param_hours.items():
        v = params.get(name)
        if isinstance(v, (int, float)) and v > 0:
            rec["engine_hours"] = v * mapping.param_hours_scale
            rec["engine_hours_method"] = method
            break
    for name, method in mapping.param_mileage.items():
        v = params.get(name)
        if isinstance(v, (int, float)) and v > 0:
            rec["odometer_km"] = v * mapping.param_mileage_scale
            rec["odometer_method"] = method
            break


def _interp(table: list, x: float) -> float:
    pts = sorted((float(a), float(b)) for a, b in table)
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 != x0 else y1
    return pts[-1][1]


def apply_sensors(mapping: Mapping, rec: dict, *, params: dict | None = None, tags: dict | None = None,
                  analog: dict | None = None, lls: dict | None = None) -> None:
    out: dict = {}
    for key, spec in (mapping.sensors or {}).items():
        raw = None
        if params is not None and "param" in spec:
            raw = params.get(spec["param"])
        elif tags is not None and "tag" in spec and spec["tag"] in tags:
            b = tags[spec["tag"]]
            off = spec.get("byte_offset", 0)
            if spec.get("float"):
                raw = struct.unpack_from("<f", b, off)[0] if len(b) >= off + 4 else None
            else:
                raw = int.from_bytes(b[off: off + spec.get("bytes", len(b) - off)], "little", signed=spec.get("signed", False))
        elif analog is not None and "egts_an" in spec:
            raw = analog.get(spec["egts_an"])
        elif lls is not None and "egts_lls" in spec:
            raw = lls.get(spec["egts_lls"])
        if not isinstance(raw, (int, float)) or isinstance(raw, bool):
            continue
        if isinstance(raw, float) and raw != raw:  # NaN from an unset float register
            continue
        if "bit" in spec:
            val = float((int(raw) >> spec["bit"]) & 1)
        elif "threshold" in spec:
            hit = raw < spec["threshold"] if spec.get("when") == "below" else raw >= spec["threshold"]
            val = 1.0 if hit else 0.0
        elif "table" in spec:
            val = _interp(spec["table"], raw)
        else:
            val = raw * spec.get("scale", 1.0) + spec.get("offset", 0.0)
        out[key] = round(val, 4)
    if out:
        rec["sensors"] = out
    if params is not None and isinstance(params.get("dtc"), str):
        rec["dtc"] = parse_dtc(params["dtc"])


def parse_dtc(text: str) -> list[dict]:
    """Active J1939 DM1 codes sent as a text parameter: "SPN.FMI[.OC];..." (empty = none active)."""
    out = []
    for item in text.replace(",", ";").split(";"):
        parts = item.strip().split(".")
        if len(parts) < 2 or not all(p.isdigit() for p in parts[:3]):
            continue
        code = {"spn": int(parts[0]), "fmi": int(parts[1])}
        if len(parts) > 2:
            code["oc"] = int(parts[2])
        out.append(code)
    return out
