"""EGTS (ГОСТ 33472-2015, приказ Минтранса №285): transport + AUTH + TELEDATA services."""

from __future__ import annotations

import struct

from ..crc import crc8_egts, crc16_ccitt
from ..records import Mapping, apply_sensors, clean

EPOCH_2010 = 1262304000
PT_RESPONSE, PT_APPDATA = 0, 1
SERVICE_AUTH, SERVICE_TELEDATA = 1, 2
SR_RECORD_RESPONSE, SR_TERM_IDENTITY, SR_DISPATCHER_IDENTITY, SR_RESULT_CODE = 0, 1, 5, 9
SR_POS_DATA, SR_EXT_POS_DATA, SR_COUNTERS_DATA, SR_ABS_AN_SENS_DATA, SR_ABS_CNTR_DATA = 16, 17, 19, 24, 25
SR_LIQUID_LEVEL_SENSOR = 27


class ProtocolError(Exception):
    pass


class EgtsSession:
    proto = "egts"

    def __init__(self, mapping: Mapping | None = None):
        self.buf = b""
        self.ext_id: str | None = None
        self.pid = 0
        self.rn = 0
        self.mapping = mapping or Mapping()
        # platform retranslation: a dispatcher connection carries many objects, one OID per record
        self.dispatcher = False
        self.mappings: dict[str, Mapping] = {}

    def _packet(self, ptype: int, sfrd: bytes) -> bytes:
        header = struct.pack("<BBBBBHHB", 1, 0, 0, 11, 0, len(sfrd), self.pid, ptype)
        self.pid = (self.pid + 1) & 0xFFFF
        return header + bytes([crc8_egts(header)]) + sfrd + struct.pack("<H", crc16_ccitt(sfrd))

    def _record(self, service: int, subrecords: bytes) -> bytes:
        rn = self.rn
        self.rn = (self.rn + 1) & 0xFFFF
        return struct.pack("<HHBBB", len(subrecords), rn, 0, service, service) + subrecords

    def feed(self, data: bytes) -> list[tuple[list[dict], bytes]]:
        self.buf += data
        out = []
        while len(self.buf) >= 11:
            if self.buf[0] != 1:
                raise ProtocolError("unsupported EGTS protocol version")
            hl = self.buf[3]
            if hl not in (11, 16):
                raise ProtocolError("bad header length")
            if len(self.buf) < hl:
                break
            if crc8_egts(self.buf[: hl - 1]) != self.buf[hl - 1]:
                raise ProtocolError("header CRC mismatch")
            fdl = struct.unpack_from("<H", self.buf, 5)[0]
            total = hl + fdl + (2 if fdl else 0)
            if len(self.buf) < total:
                break
            pkt, self.buf = self.buf[:total], self.buf[total:]
            pid = struct.unpack_from("<H", pkt, 7)[0]
            ptype = pkt[9]
            sfrd = pkt[hl : hl + fdl]
            if fdl and crc16_ccitt(sfrd) != struct.unpack_from("<H", pkt, hl + fdl)[0]:
                # PR 138 = EGTS_PC_DATACRC_ERROR
                out.append(([], self._packet(PT_RESPONSE, struct.pack("<HB", pid, 138))))
                continue
            if ptype != PT_APPDATA:
                continue
            records, responses, extra = self._records(sfrd)
            out.append((records, self._packet(PT_RESPONSE, struct.pack("<HB", pid, 0) + responses) + extra))
        return out

    def _records(self, sfrd: bytes) -> tuple[list[dict], bytes, bytes]:
        records: list[dict] = []
        responses = b""
        extra = b""
        pos = 0
        while pos + 7 <= len(sfrd):
            rl, rn, rfl = struct.unpack_from("<HHB", sfrd, pos)
            pos += 5
            oid = None
            if rfl & 1:
                oid = struct.unpack_from("<I", sfrd, pos)[0]
                pos += 4
            if rfl >> 1 & 1:
                pos += 4
            if rfl >> 2 & 1:
                pos += 4
            sst = sfrd[pos]
            pos += 2
            end = pos + rl
            if oid is not None and self.ext_id is None:
                self.ext_id = str(oid)
            rec: dict = {}
            counters: dict[int, int] = {}
            analog: dict[int, int] = {}
            lls: dict[int, float] = {}
            while pos + 3 <= end:
                srt, srl = struct.unpack_from("<BH", sfrd, pos)
                pos += 3
                d = sfrd[pos : pos + srl]
                pos += srl
                if srt == SR_TERM_IDENTITY and sst == SERVICE_AUTH:
                    tid, flags = struct.unpack_from("<IB", d, 0)
                    p = 5 + (2 if flags & 1 else 0)
                    imei = d[p : p + 15].decode("ascii", "replace").strip("\x00 ") if flags >> 1 & 1 else ""
                    self.ext_id = imei if imei and imei.strip("0") else str(tid)
                    res = struct.pack("<BH", SR_RESULT_CODE, 1) + b"\x00"
                    extra += self._packet(PT_APPDATA, self._record(SERVICE_AUTH, res))
                elif srt == SR_DISPATCHER_IDENTITY and sst == SERVICE_AUTH and len(d) >= 5:
                    self.dispatcher = True
                    res = struct.pack("<BH", SR_RESULT_CODE, 1) + b"\x00"
                    extra += self._packet(PT_APPDATA, self._record(SERVICE_AUTH, res))
                elif srt == SR_POS_DATA and len(d) >= 21:
                    ntm, lat, lon, flg, spd, dirl = struct.unpack_from("<IIIBHB", d, 0)
                    rec["t"] = ntm + EPOCH_2010
                    if flg & 1:
                        rec["lat"] = lat * 90 / 0xFFFFFFFF * (-1 if flg >> 5 & 1 else 1)
                        rec["lon"] = lon * 180 / 0xFFFFFFFF * (-1 if flg >> 6 & 1 else 1)
                        rec["speed_kmh"] = (spd & 0x3FFF) / 10
                        rec["course"] = dirl | (0x100 if spd >> 15 & 1 else 0)
                    odm = int.from_bytes(d[16:19], "little")
                    if odm:
                        rec["odometer_km"] = odm / 10
                        rec["odometer_method"] = "tracker"
                elif srt == SR_EXT_POS_DATA and d:
                    fl = d[0]
                    p = 1
                    if fl & 1:
                        p += 2  # VDOP
                    if fl >> 1 & 1:
                        rec["hdop"] = struct.unpack_from("<H", d, p)[0] / 100
                        p += 2
                    if fl >> 2 & 1:
                        p += 2  # PDOP
                    if fl >> 3 & 1 and p < len(d):
                        rec["sats"] = d[p]
                elif srt == SR_ABS_AN_SENS_DATA and len(d) >= 4:
                    analog[d[0]] = int.from_bytes(d[1:4], "little")
                elif srt == SR_LIQUID_LEVEL_SENSOR and len(d) >= 7:
                    flags = d[0]
                    if not flags >> 3 & 1 and not flags >> 6 & 1:  # value (not raw data), no sensor error
                        value = struct.unpack_from("<I", d, 3)[0]
                        unit = flags >> 4 & 0b11
                        lls[flags & 0x07] = value / 10 if unit in (0b01, 0b10) else float(value)
                elif srt == SR_ABS_CNTR_DATA and len(d) >= 4:
                    counters[d[0]] = int.from_bytes(d[1:4], "little")
                elif srt == SR_COUNTERS_DATA and d:
                    mask, p = d[0], 1
                    for i in range(8):
                        if mask >> i & 1:
                            counters[i + 1] = int.from_bytes(d[p : p + 3], "little")
                            p += 3
            mapping = self.mappings.get(str(oid), self.mapping) if self.dispatcher and oid is not None else self.mapping
            n = mapping.egts_hours_counter
            if n is not None and n in counters and counters[n]:
                rec["engine_hours"] = counters[n] * mapping.egts_hours_scale
                rec["engine_hours_method"] = "tracker"
            apply_sensors(mapping, rec, analog=analog, lls=lls)
            responses += self._record(sst, struct.pack("<BHHB", SR_RECORD_RESPONSE, 3, rn, 0))
            if self.dispatcher and oid is not None:
                rec["_ext"] = str(oid)
            if "t" in rec and self.ext_id:
                records.append(clean(rec))
            pos = end
        return records, responses, extra
