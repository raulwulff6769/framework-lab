// Field work by track: distance driven with the implement engaged at working speed, multiplied by
// the working width. This is gross area (overlaps between passes are not subtracted), the figure
// most agricultural telematics platforms report as «обработано по треку».
import { geodesicM } from './geodesy.js';
import type { Pt } from './sensors.js';

export interface WorkPoint {
  t: number;
  lat: number;
  lon: number;
  speed_kmh: number | null;
}

export interface WorkSummary {
  area_ha: number;
  work_km: number;
  work_h: number;
}

export function workedArea(track: WorkPoint[], implement: Pt[], widthM: number, opts: { minKmh?: number; maxKmh?: number; maxGapS?: number } = {}): WorkSummary {
  const minKmh = opts.minKmh ?? 1.5;
  const maxKmh = opts.maxKmh ?? 30;
  const maxGap = (opts.maxGapS ?? 180) * 1000;
  const imp = [...implement].sort((a, b) => a.t - b.t);
  let k = -1;
  let m = 0;
  let ms = 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    while (k + 1 < imp.length && imp[k + 1].t <= a.t) k++;
    if (k < 0 || imp[k].v < 0.5) continue;
    const dt = b.t - a.t;
    if (dt <= 0 || dt > maxGap) continue;
    const d = geodesicM(a.lat, a.lon, b.lat, b.lon);
    const v = a.speed_kmh ?? (d / dt) * 3600;
    if (v < minKmh || v > maxKmh) continue;
    m += d;
    ms += dt;
  }
  return { area_ha: Math.round(((m * widthM) / 1e4) * 100) / 100, work_km: Math.round(m / 10) / 100, work_h: Math.round((ms / 3600e3) * 100) / 100 };
}
