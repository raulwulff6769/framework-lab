// Fuel level analysis for a tank level sensor (litres after the tank calibration table).
// Steps are found on a time-median level as a change over the next 10 minutes; each step is judged
// against what the engine burned in the same minutes (J1939 fuel rate): a drop larger than the
// burn is a drain, a rise is a refill. Without fuel rate data only drops faster than any engine
// burns (150 l/h) are reported.
import type { Pt } from './sensors.js';

export interface FuelEvent {
  kind: 'refill' | 'drain';
  t_start: number;
  t_end: number;
  litres: number;
  level_before: number;
  level_after: number;
}

export interface FuelAnalysis {
  events: FuelEvent[];
  start_l: number | null;
  end_l: number | null;
  consumed_l: number | null;
  points: number;
}

const MIN = 60e3;
const STEP_WINDOW = 10 * MIN;

/** Median over ±half window in time: rejects slosh while keeping the edges of real steps. */
export function timeMedian(pts: Pt[], halfMs = 4 * MIN): Pt[] {
  const out: Pt[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < pts.length; i++) {
    while (pts[lo].t < pts[i].t - halfMs) lo++;
    while (hi + 1 < pts.length && pts[hi + 1].t <= pts[i].t + halfMs) hi++;
    const w = pts.slice(lo, hi + 1).map((p) => p.v).sort((a, b) => a - b);
    out.push({ t: pts[i].t, v: w[w.length >> 1] });
  }
  return out;
}

function burned(rate: Pt[], t0: number, t1: number): number | null {
  if (!rate.length) return null;
  let litres = 0;
  let covered = 0;
  for (let i = 0; i < rate.length; i++) {
    const a = Math.max(t0, rate[i].t);
    const b = Math.min(t1, i + 1 < rate.length ? rate[i + 1].t : rate[i].t + 10 * MIN);
    if (b > a) {
      litres += (rate[i].v * (b - a)) / 3600e3;
      covered += b - a;
    }
  }
  return covered >= (t1 - t0) * 0.5 ? litres : null;
}

/** Level at time t: first filtered point at or after t (the series is sorted). */
function after(f: Pt[], from: number, t: number): number {
  let k = from;
  while (k + 1 < f.length && f[k].t < t) k++;
  return k;
}

export function analyzeFuel(level: Pt[], rate: Pt[] = [], opts: { tankL?: number | null } = {}): FuelAnalysis {
  const raw = [...level].filter((p) => Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (raw.length < 5) return { events: [], start_l: raw[0]?.v ?? null, end_l: raw.at(-1)?.v ?? null, consumed_l: null, points: raw.length };
  const f = timeMedian(raw);
  const rt = [...rate].sort((a, b) => a.t - b.t);
  const thr = Math.max(10, (opts.tankL ?? 0) * 0.02);
  const dv = f.map((p, i) => {
    const k = after(f, i, p.t + STEP_WINDOW);
    if (f[k].t - p.t <= STEP_WINDOW * 2) return f[k].v - p.v;
    // a gap (a parked tracker in a data-saving profile writes once an hour): the level only rises by
    // refuelling, so a rise across the gap is still a step; a fall is judged by the burn rule below
    return i + 1 < f.length ? f[i + 1].v - p.v : 0;
  });
  const events: FuelEvent[] = [];
  let i = 0;
  while (i < f.length) {
    if (Math.abs(dv[i]) < thr) {
      i++;
      continue;
    }
    const dir = Math.sign(dv[i]);
    // points whose next 10 minutes still show the same step belong to one event
    let j = i;
    while (j + 1 < f.length && dir * dv[j + 1] >= thr / 2 && f[j + 1].t - f[i].t <= 60 * MIN) j++;
    const until = Math.max(f[j].t + STEP_WINDOW, f[Math.min(j + 1, f.length - 1)].t);
    let e = i;
    for (let k = i; k < f.length && f[k].t <= until; k++) if (dir > 0 ? f[k].v > f[e].v : f[k].v < f[e].v) e = k;
    let s = i;
    for (let k = i; k <= e; k++) if (dir > 0 ? f[k].v < f[s].v : f[k].v > f[s].v) s = k;
    const d = f[e].v - f[s].v;
    const span = Math.max(f[e].t - f[s].t, MIN);
    if (dir > 0 && d >= thr) {
      events.push({ kind: 'refill', t_start: f[s].t, t_end: f[e].t, litres: round1(d), level_before: round1(f[s].v), level_after: round1(f[e].v) });
    } else if (dir < 0 && -d >= thr) {
      const burn = burned(rt, f[s].t, f[e].t);
      const excess = burn === null ? ((-d / span) * 3600e3 > 150 ? -d : 0) : -d - burn;
      if (excess >= thr)
        events.push({ kind: 'drain', t_start: f[s].t, t_end: f[e].t, litres: round1(excess), level_before: round1(f[s].v), level_after: round1(f[e].v) });
    }
    i = Math.max(e, j) + 1;
  }
  const start = f[0].v;
  const end = f[f.length - 1].v;
  const refills = events.filter((e) => e.kind === 'refill').reduce((a, e) => a + e.litres, 0);
  const drains = events.filter((e) => e.kind === 'drain').reduce((a, e) => a + e.litres, 0);
  return { events, start_l: round1(start), end_l: round1(end), consumed_l: round1(Math.max(0, start - end + refills - drains)), points: raw.length };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
