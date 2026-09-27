/**
 * The reel's choreography: pure functions of film time T that write one Frame. The DOM overlay reads the
 * same layout (OUT), so words, shapes and 3D always agree. Ambient loops use wall time only at rest.
 * Every move takes its curve, duration and stagger from the motion system in time.ts.
 */
import { WORDMARK } from '../../brand/logo';
import type { Glyph, Word } from './atlas';
import { COVERAGE, MAST, route, type Route } from './gl/geometry';
import type { Col, Frame } from './gl/renderer';
import { HOLDS, M, MORPH_AT, arc, arrive, clamp01, expoIn, expoInOut, glide, inOutCubic, inOutSine, leave, lerp, outCubic, range, smooth, stag } from './time';

const hex = (h: string): Col => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** «мазут»: warm black of used oil */
export const INK = hex('#0a0907');
const INK2 = hex('#1d1a15');
/** «кость»: paper */
export const BONE = hex('#f2ebdd');
/** «сурик»: the red-lead primer machines are painted with; the point the count starts from */
export const SURIK = hex('#ff4a14');
/** «синь»: the blue of tempered steel */
export const SIN = hex('#2446b0');
/** «ковш»: the yellow of the machines themselves */
export const KOVSH = hex('#f5b301');
/** «золото»: oil, the fine lines of instruments */
export const GOLD = hex('#d6a84e');

const H = HOLDS;
const DEG = Math.PI / 180;
/** Motion-blur exposure in seconds: a touch over one frame. */
const SHUTTER = 1 / 45;
const SITE = [-0.6, -0.8, 0] as const;
const BEACON = [0.33, 1.53, 0.31] as const;
const MAST_H = 1.7;

/** Colour the stage shows under the lifted frame while it waits at scene k: the next scene's first field. */
export const PEEK: Col[] = [SURIK, BONE, SIN, INK2, INK2, SURIK, BONE, BONE];

export interface Type {
  wm: Glyph[];
  /** raster px per wordmark unit */
  wmScale: number;
  words: Record<string, Word>;
}
let TYPE: Type | null = null;
export const setType = (t: Type) => (TYPE = t);
let coverU = 0.62;
export const setCoverU = (u: number) => (coverU = u);

/** short: a landscape phone — little height, so every scene keeps its words clear of the bottom HUD. */
export const L = { W: 1, H: 1, cx: 0, cy: 0, U: 1, portrait: false, short: false, cover: 1 };
export function layout(W: number, Hh: number) {
  L.W = W;
  L.H = Hh;
  L.cx = W / 2;
  L.cy = Hh / 2;
  L.U = Math.min(W, Hh);
  L.portrait = W / Hh < 0.8;
  L.short = !L.portrait && Hh < 560;
  L.cover = Math.hypot(W, Hh) / 2 + 60;
}

/** Positions shared with the DOM overlay. */
export const OUT = {
  wmX0: 0, wmX1: 0, wmBase: 0, wmU: 1, ruleY: 0,
  srcX: new Float32Array(4), srcY: new Float32Array(4), icon: 0, cabX: 0, cabY: 0, cabW: 0, cabH: 0, lit: 0, phoneOff: 0,
  s3x: 0, s3y: 0, s3R: 0, reading: 0, readingPrev: 0, readingT: 1,
  tagX: 0, tagY: 0, tagOn: 0, stored: 0, sent: 0, inCover: false,
  lockBottom: 0, lockX: 0,
};

const tmp = new Float32Array(3);
const tmp2 = new Float32Array(3);
const col: [number, number, number] = [0, 0, 0];
function mix(a: Col, b: Col, t: number): Col {
  col[0] = a[0] + (b[0] - a[0]) * t;
  col[1] = a[1] + (b[1] - a[1]) * t;
  col[2] = a[2] + (b[2] - a[2]) * t;
  return col;
}

// ── background: base colour, circle wipes that carry the dot, one diagonal wipe ──────────
const dot0 = () => 0.02857 * L.U;
const dot3 = () => 0.016 * L.U;
const wipeR = (T: number, a: number, b: number, r0: number, r1 = L.cover) => {
  const x = range(T, a, b);
  // slow in, fast middle, slow out; softer than expo so the second disc keeps up with the first
  return lerp(r0, r1, x < 0.5 ? 8 * x ** 4 : 1 - 8 * (1 - x) ** 4);
};
const wipeSoft = (T: number, a: number, b: number, r0: number, r1 = L.cover) =>
  0.7 + Math.abs(wipeR(T + 1 / 240, a, b, r0, r1) - wipeR(T - 1 / 240, a, b, r0, r1)) * 120 * SHUTTER * 0.16;

const CUT = 0.34;
interface Cut { bg: Col; word: string; col: Col; dot?: Col; cond?: boolean; pattern?: boolean; bars?: boolean }
const CUTS: Cut[] = [
  { bg: SURIK, word: 'МОТОЧАСЫ.', col: INK, dot: INK },
  { bg: INK, word: 'ПРОБЕГ.', col: BONE, dot: SURIK },
  { bg: BONE, word: 'МЕСТОПОЛОЖЕНИЕ', col: SIN, cond: true },
  { bg: SIN, word: 'МАСЛО.', col: BONE, dot: SURIK },
  { bg: KOVSH, word: 'ЛЮБАЯ', col: INK },
  { bg: KOVSH, word: 'ТЕХНИКА', col: INK, pattern: true },
  { bg: INK, word: 'НА\u00a0СВЯЗИ.', col: BONE, dot: SURIK, bars: true },
];
export const WORDS = CUTS.map((c) => ({ word: c.word, cond: !!c.cond }));
const cutIndex = (T: number) => Math.max(0, Math.min(CUTS.length - 1, Math.floor((T - H[5]) / CUT + 1e-6)));

function background(F: Frame, T: number) {
  const { cx, cy, W, U } = L;
  const Hh = L.H;
  if (T <= 1.86) return F.setBase(INK);
  if (T < 2.32) {
    F.setBase(INK);
    F.addDisc(cx, cy, wipeR(T, 1.86, 2.16, dot0()), wipeSoft(T, 1.86, 2.16, dot0()), BONE);
    F.addDisc(cx, cy, wipeR(T, 1.89, 2.24, dot0()), wipeSoft(T, 1.89, 2.24, dot0()), SURIK);
    return;
  }
  const w0 = H[1] + 0.14, w1 = H[1] + 0.56;
  if (T < w0) return F.setBase(SURIK);
  if (T < w1) {
    F.setBase(SURIK);
    const k = 1 / Math.hypot(0.55, 1), soft = 0.14 * U;
    F.setWipe(0.55, -1, lerp(-Hh * k - soft * 1.3, 0.55 * W * k + soft * 1.3, inOutCubic(range(T, w0, w1))), soft, BONE);
    return;
  }
  const b0 = H[2] + 0.4, b1 = H[2] + 0.82;
  if (T < b0) return F.setBase(BONE);
  if (T < b1) {
    F.setBase(BONE);
    s3Geom();
    F.addDisc(S3.x, S3.y, wipeR(T, b0, b1, dot3()), wipeSoft(T, b0, b1, dot3()), SIN);
    return;
  }
  if (T <= H[3] + 0.25) return F.setBase(SIN);
  if (T <= H[5]) return F.setBase(INK);
  if (T <= H[6]) return F.setBase(CUTS[cutIndex(T)].bg);
  const f0 = H[6], f1 = H[6] + 0.3, g0 = H[6] + 0.06, g1 = H[6] + 0.4;
  if (T < g1) {
    F.setBase(INK);
    const x = W * 1.08, r1 = Math.hypot(x, Hh / 2) + 60;
    F.addDisc(x, cy, wipeR(T, f0, f1, 0, r1), wipeSoft(T, f0, f1, 0, r1), SURIK);
    F.addDisc(x, cy, wipeR(T, g0, g1, 0, r1), wipeSoft(T, g0, g1, 0, r1), BONE);
    F.clip[0] = x;
    F.clip[1] = cy;
    F.clip[2] = wipeR(T, f0, f1, 0, r1);
    return;
  }
  F.setBase(BONE);
}

// ── 1 · ОТСЧЁТ: the dot opens a layered wipe, the wordmark rises with squash and stretch ──
const WM = { u: 1, x0: 0, base: 0 };
function wmGeom() {
  const w = L.portrait ? L.W * 0.86 : Math.min(L.W * 0.74, L.H * 2.2);
  WM.u = w / WORDMARK.width;
  WM.x0 = L.cx - w / 2;
  WM.base = L.cy + 50 * WM.u - L.H * (L.portrait ? 0.07 : L.short ? 0.13 : 0.045);
  OUT.wmX0 = WM.x0;
  OUT.wmX1 = WM.x0 + w;
  OUT.wmBase = WM.base;
  OUT.wmU = WM.u;
  OUT.ruleY = WM.base - 100 * WM.u - Math.max(46 * WM.u, 0.085 * L.H);
}
const RISE0 = 1.98;
const riseX = (T: number, i: number) => range(T, RISE0 + stag(i, 6, 0.05), RISE0 + stag(i, 6, 0.05) + M.enter);
const rise = (T: number, i: number) => (1 - arrive(riseX(T, i), 0.1)) * 118;
/** Letters fold into dots at the end of the scene: a swell first (the pull of leave), then away. */
const collapse = (T: number, i: number) => range(T, H[1] + 0.04 + i * 0.03, H[1] + 0.36 + i * 0.03);

function letterCentre(i: number, out: Float32Array) {
  const g = TYPE!.wm[i], k = WM.u / TYPE!.wmScale;
  out[0] = WM.x0 + g.ox * k;
  out[1] = WM.base + g.oy * k;
}

function s1(F: Frame, T: number, now: number) {
  if (!TYPE || T < 1.95 || T > H[1] + 0.6) return;
  wmGeom();
  const u = WM.u, k = u / TYPE.wmScale;
  const inDisc = T < 2.26;
  if (inDisc) {
    F.clip[0] = L.cx;
    F.clip[1] = L.cy;
    F.clip[2] = wipeR(T, 1.89, 2.24, dot0());
  }
  for (let i = 0; i < 6; i++) {
    const x = riseX(T, i);
    if (x <= 0) continue;
    const lift = rise(T, i) * u;
    const vy = (rise(T + 1 / 240, i) - rise(T - 1 / 240, i)) * 120 * u * SHUTTER;
    // squash and stretch: long while it flies, round again as it lands
    const stretch = 1 + 0.28 * Math.sin(Math.PI * clamp01(x * 1.7));
    let sx = 1 / Math.sqrt(stretch), sy = stretch;
    const c = collapse(T, i);
    let a = 1;
    if (c > 0) {
      const e = leave(c, 0.06);
      sx *= 1 - 0.85 * e;
      sy *= 1 - 0.85 * e;
      a = 1 - range(c, 0.6, 1);
    }
    F.glyph(TYPE.wm[i], WM.x0, WM.base + lift, k, sx, sy, INK, a, 0, vy, inDisc ? 2 : 0, WM.base + 4 * u);
  }
  // «ё»: the left dot in ink, the right one — the point of reference — in bone
  const d = WORDMARK.dots;
  const c4 = collapse(T, 4);
  letterCentre(4, tmp);
  for (let j = 0; j < 2; j++) {
    const p = arrive(range(T, 2.42 + j * 0.08, 2.42 + j * 0.08 + 0.5), 0.22);
    let r = d.r * u * p;
    if (j === 1 && T > 3.1) r *= 1 + 0.06 * Math.sin(now * 5.2) * range(T, 3.1, 3.4);
    const x = lerp(WM.x0 + d.x[j] * u, tmp[0], expoIn(c4));
    const y = lerp(WM.base + (d.y - 100) * u, tmp[1], expoIn(c4));
    F.disc2(x, y, r * (1 - 0.7 * expoIn(c4)), j ? BONE : INK, 1 - range(c4, 0.5, 1));
  }
  const rule = outCubic(range(T, 2.62, 3.1)) * (WORDMARK.width / 2) * u;
  F.seg(L.cx - rule, OUT.ruleY, L.cx + rule, OUT.ruleY, 0.6, INK, 0.85 * (1 - range(T, H[1], H[1] + 0.14)));
}

// ── 2 · ЧЕТЫРЕ ПУТИ: letters fold into dots, the dots become four sources, all flow into one cabinet ──
const S2 = { sx: new Float32Array(4), sy: new Float32Array(4), px: new Float32Array(4), py: new Float32Array(4), ex: new Float32Array(4), ey: new Float32Array(4), bend: new Float32Array(4), s: 20, cx: 0, cy: 0, cw: 0, ch: 0 };
function s2Geom() {
  const { W, portrait } = L, Hh = L.H;
  if (portrait) {
    const s = Math.min(W * 0.058, 24);
    S2.s = s;
    S2.cw = W * 0.84;
    S2.ch = Math.min(Hh * 0.25, W * 0.6);
    S2.cx = W / 2;
    S2.cy = Hh * 0.72;
    for (let i = 0; i < 4; i++) {
      S2.sx[i] = W * (0.14 + 0.24 * i);
      S2.sy[i] = Hh * 0.35;
      S2.px[i] = S2.sx[i];
      S2.py[i] = S2.sy[i] + s + 34;
      S2.ex[i] = S2.cx + (i - 1.5) * S2.cw * 0.11;
      S2.ey[i] = S2.cy - S2.ch / 2;
      S2.bend[i] = (i < 2 ? -1 : 1) * (0.1 + 0.08 * Math.abs(i - 1.5));
    }
  } else {
    const s = Math.max(16, Math.min(L.U * 0.036, 32));
    S2.s = s;
    S2.cw = Math.min(W * 0.34, Hh * 0.62);
    S2.ch = S2.cw * 0.7;
    S2.cx = W * 0.72;
    S2.cy = Hh * (L.short ? 0.62 : 0.6);
    // a landscape phone: the rows start under the headline block and end above the bottom HUD
    const r0 = L.short ? 0.47 : 0.41, dr = L.short ? 0.105 : 0.125;
    for (let i = 0; i < 4; i++) {
      S2.sx[i] = W * 0.075;
      S2.sy[i] = Hh * (r0 + dr * i);
      S2.px[i] = W * 0.36;
      S2.py[i] = S2.sy[i];
      S2.ex[i] = S2.cx - S2.cw / 2;
      S2.ey[i] = S2.cy + (i - 1.5) * S2.ch * 0.14;
      S2.bend[i] = (S2.sy[i] < S2.cy ? -1 : 1) * 0.16;
    }
  }
  for (let i = 0; i < 4; i++) {
    OUT.srcX[i] = S2.sx[i];
    OUT.srcY[i] = S2.sy[i];
  }
  OUT.icon = S2.s;
  OUT.cabX = S2.cx;
  OUT.cabY = S2.cy;
  OUT.cabW = S2.cw;
  OUT.cabH = S2.ch;
}
/** LED of each source icon, relative to its centre in icon units. */
const LED = [[-0.42, 0.12], [-0.55, -0.5], [0, 0.12], [0.6, 0]] as const;
const ROWC: Col[] = [INK, SIN, SURIK, INK];
/** letter → source: six letters, four sources */
const MAP = [0, 1, 2, 3, 2, 3];
const TS = H[1] + 1.5;
/** Moments each source first delivers, in the order the cabinet lights its tiles. */
const FIRST = [TS + 0.55, TS + 0.8, TS + 1.5, TS + 1.62];

function flowPos(i: number, u: number, out: Float32Array, bendK = 1) {
  arc(S2.px[i], S2.py[i], S2.ex[i], S2.ey[i], S2.bend[i] * bendK, u, out);
}
function packet(F: Frame, i: number, u: number, u2: number, r: number, c: Col, a: number, bendK = 1) {
  if (u <= 0 || u >= 1) return;
  flowPos(i, u, tmp, bendK);
  flowPos(i, Math.min(1, u2), tmp2, bendK);
  // swell out of the port, shrink into the cabinet
  const s = Math.min(1, u * 6, (1 - u) * 5);
  F.disc2(tmp[0], tmp[1], r * (0.4 + 0.6 * s), c, a, (tmp2[0] - tmp[0]) * 240 * SHUTTER, (tmp2[1] - tmp[1]) * 240 * SHUTTER);
}

function icon(F: Frame, i: number, x: number, y: number, s: number, a: number, led: Col, ledA: number) {
  if (a <= 0.01 || s <= 0.5) return;
  const lw = 1.25;
  if (i === 0) {
    // tracker: box, antenna, LED
    F.rect(x, y + s * 0.12, s * 0.8, s * 0.5, s * 0.16, INK, a, lw);
    F.seg(x + s * 0.48, y - s * 0.38, x + s * 0.66, y - s * 1.0, 0.7, INK, a);
    F.disc2(x + s * 0.66, y - s * 1.0, Math.max(1.4, s * 0.07), INK, a);
    F.seg(x - s * 0.05, y + s * 0.12, x + s * 0.5, y + s * 0.12, 0.7, INK, a * 0.55, 3.2, 0.5);
  } else if (i === 1) {
    // platform: a rack of servers
    for (let r = 0; r < 3; r++) F.rect(x, y + (r - 1) * s * 0.52, s * 0.82, s * 0.2, s * 0.07, INK, a, lw);
    for (let r = 0; r < 3; r++) F.seg(x - s * 0.1, y + (r - 1) * s * 0.52, x + s * 0.55, y + (r - 1) * s * 0.52, 0.7, INK, a * 0.45);
  } else if (i === 2) {
    // phone in the cab
    F.rect(x, y, s * 0.5, s * 0.86, s * 0.16, INK, a, lw);
    F.seg(x - s * 0.14, y - s * 0.68, x + s * 0.14, y - s * 0.68, 0.8, INK, a);
    F.seg(x - s * 0.18, y + s * 0.68, x + s * 0.18, y + s * 0.68, 0.8, INK, a * 0.6);
  } else {
    // hour meter: four drums, the tenths in red like on a real counter
    F.rect(x, y, s * 0.92, s * 0.44, s * 0.08, INK, a, lw);
    for (let c = 0; c < 4; c++) F.rect(x - s * 0.57 + c * s * 0.38, y, s * 0.14, s * 0.25, s * 0.035, c === 3 ? SURIK : INK, a * 0.9);
  }
  const lx = LED[i][0], ly = LED[i][1];
  if (i !== 3) F.disc2(x + lx * s, y + ly * s, Math.max(1.8, s * (i === 2 ? 0.1 : 0.12)), led, a * ledA);
}

/** Reading icons shared by the cabinet tiles and the next scene: dial, drop, pin, counter window. */
const TILE_SHAPE = [0, 1, 2, 3];

function cabinet(F: Frame, T: number, x: number, y: number, w: number, h: number, a: number, lit: number, now: number) {
  const b = arrive(range(T, H[1] + 1.05, H[1] + 1.05 + M.enter), 0.05);
  if (b <= 0 || a <= 0.01) return;
  const sw = w * lerp(0.7, 1, b), sh = h * lerp(0.7, 1, b), aa = a * Math.min(1, b * 1.6);
  const r = Math.min(14, w * 0.04);
  F.rect(x, y, sw / 2, sh / 2, r, INK, aa);
  const head = Math.max(22, sh * 0.14);
  const top = y - sh / 2;
  F.seg(x - sw / 2 + 1, top + head, x + sw / 2 - 1, top + head, 0.5, BONE, aa * 0.18);
  for (let d = 0; d < 3; d++) F.disc2(x + sw / 2 - head * (0.55 + d * 0.42), top + head / 2, Math.max(2, head * 0.1), BONE, aa * 0.35);
  // 2 × 2 tiles; each lights with a pop when a source delivers
  const pad = Math.max(8, sw * 0.04);
  const tw = (sw - pad * 3) / 2, th = (sh - head - pad * 3) / 2;
  for (let n = 0; n < 4; n++) {
    const tp = arrive(range(T, H[1] + 1.25 + stag(n, 4, 0.06), H[1] + 1.25 + stag(n, 4, 0.06) + 0.5), 0.12);
    if (tp <= 0) continue;
    const cx = x - sw / 2 + pad + tw / 2 + (n % 2) * (tw + pad);
    const cy = top + head + pad + th / 2 + Math.floor(n / 2) * (th + pad);
    const on = n < lit ? 1 : 0;
    const pop = on ? arrive(range(T, FIRST[n], FIRST[n] + 0.45), 0.25) : 0;
    const amb = T >= H[2] - 1e-3 ? 0.5 + 0.5 * Math.sin(now * 1.7 + n * 1.3) : 1;
    F.rect(cx, cy, (tw / 2) * tp, (th / 2) * tp, r * 0.6, INK2, aa * tp);
    const R = Math.min(tw, th) * 0.2 * (1 + 0.18 * Math.sin(Math.PI * clamp01(pop)) * (pop < 1 ? 1 : 0));
    const ix = cx - tw * 0.22, iy = cy;
    const sh0 = TILE_SHAPE[n];
    F.morph(ix, iy, R * tp, sh0, sh0, 0, sh0 === 0 || sh0 === 3 ? Math.max(1.2, R * 0.16) : 0, on ? SURIK : BONE, aa * tp * (on ? 1 : 0.4));
    // the reading arrives as a bar that fills
    const bw = tw * 0.36, bx = cx + tw * 0.06;
    F.seg(bx, iy, bx + bw, iy, Math.max(1.5, th * 0.035), BONE, aa * tp * 0.14);
    if (on) F.seg(bx, iy, bx + bw * lerp(0.2, 0.55 + 0.35 * ((n * 0.37) % 1), clamp01(pop)) * (0.94 + 0.06 * amb), iy, Math.max(1.5, th * 0.035), BONE, aa * tp * 0.85);
  }
}

function s2(F: Frame, T: number, now: number) {
  if (!TYPE || T < H[1] || T > H[2] + 0.62) return;
  s2Geom();
  wmGeom();
  s3Geom();
  const s = S2.s, r = Math.max(3, 0.0062 * L.U);
  // letters → dots, on arcs to the sources' LEDs
  for (let d = 0; d < 6; d++) {
    const c = collapse(T, d);
    if (c <= 0.5) continue;
    const a0 = H[1] + 0.22 + d * 0.03, b0 = a0 + 0.62;
    if (T >= b0) continue;
    letterCentre(d, tmp2);
    const i = MAP[d];
    const tx = S2.sx[i] + LED[i][0] * s, ty = S2.sy[i] + LED[i][1] * s;
    const f = expoInOut(range(T, a0, b0)), f2 = expoInOut(range(T + 1 / 240, a0, b0));
    const x0 = tmp2[0], y0 = tmp2[1];
    arc(x0, y0, tx, ty, L.portrait ? 0.3 : -0.28, f, tmp);
    const px = tmp[0], py = tmp[1];
    arc(x0, y0, tx, ty, L.portrait ? 0.3 : -0.28, f2, tmp);
    F.disc2(px, py, r * range(c, 0.5, 1), mix(INK, ROWC[i], f), 1, (tmp[0] - px) * 240 * SHUTTER, (tmp[1] - py) * 240 * SHUTTER);
  }
  const out = range(T, H[2], H[2] + 0.22);
  const srcA = 1 - out;
  // the stream keeps flowing while the scene rests; played packets hand over to the ambient loop
  const amb = range(T, H[2] - 0.45, H[2] - 0.05) * (1 - out);
  const play = 1 - amb;
  const phoneOn = TS + 1.0;
  OUT.phoneOff = 0;
  for (let i = 0; i < 4; i++) {
    const t0 = H[1] + 0.84 + stag(i, 4, 0.08);
    const p = arrive(range(T, t0, t0 + M.enter), 0.14);
    if (p <= 0) continue;
    const x = S2.sx[i], y = S2.sy[i];
    let led: Col = ROWC[i], ledA = 1;
    if (i === 0) ledA = 0.45 + 0.55 * (0.5 + 0.5 * Math.cos((T - TS) * 39));
    if (i === 2) {
      const off = T > TS - 0.2 && T < phoneOn;
      if (off) {
        OUT.phoneOff = 1;
        ledA = 0.3 + 0.7 * (Math.sin((T - TS) * 18) > 0 ? 1 : 0);
      }
    }
    icon(F, i, x, y, s * p, srcA * Math.min(1, p * 1.5), led, ledA);
    // the port the packets leave from
    if (!L.portrait) F.seg(S2.px[i] - L.W * 0.05, y, S2.px[i] - 6, y, 0.5, INK, 0.14 * srcA * p, 3, 0.35);
    F.disc2(S2.px[i], S2.py[i], 2.2, INK, 0.5 * srcA * p);
    // the route each source's data takes, drawn out towards the cabinet
    const tr = range(T, t0 + 0.2, t0 + 0.2 + M.enter) * srcA;
    if (tr > 0) {
      const n = 22;
      for (let q = 0; q < n; q++) {
        const u0 = q / n, u1 = (q + 0.45) / n;
        if (u0 > outCubic(tr)) break;
        flowPos(i, u0, tmp, i === 3 ? 2.4 : 1);
        const ax = tmp[0], ay = tmp[1];
        flowPos(i, u1, tmp, i === 3 ? 2.4 : 1);
        F.seg(ax, ay, tmp[0], tmp[1], 0.6, ROWC[i], 0.26 * tr);
      }
    }
  }
  const lit = FIRST.filter((t) => T >= t).length;
  OUT.lit = T >= H[2] ? 4 : lit;
  if (play > 0.01 && out < 1) {
    // tracker: a steady stream
    for (let k = 0; k < 24; k++) {
      const e = TS + k * 0.16;
      if (e > H[2] - 0.4) break;
      packet(F, 0, inOutSine(range(T, e, e + 0.55)), inOutSine(range(T + 1 / 240, e, e + 0.55)), r, INK, play * srcA);
    }
    // platform: synchronised bursts
    for (let m = 0; m < 2; m++)
      for (let q = 0; q < 4; q++) {
        const e = TS + 0.3 + m * 1.2 + q * 0.06;
        packet(F, 1, expoInOut(range(T, e, e + 0.5)), expoInOut(range(T + 1 / 240, e, e + 0.5)), r * 0.9, SIN, play * srcA);
      }
    // phone: no network — points pile up at the phone, then the backlog rushes in
    for (let q = 0; q < 5; q++) {
      const born = TS - 0.1 + q * 0.2;
      if (T < born) continue;
      const e = phoneOn + q * 0.06;
      if (T < e) {
        const pop = arrive(range(T, born, born + 0.3), 0.3);
        const qx = S2.px[2] + (L.portrait ? (q - 2) * r * 2.6 : -r * 2.6 * (q + 1)), qy = S2.py[2] - (L.portrait ? 0 : 0);
        F.disc2(qx, qy + (L.portrait ? -r * 2.2 : -r * 2.4), r * 0.8 * pop, SURIK, play * srcA);
      } else packet(F, 2, outCubic(range(T, e, e + 0.45)), outCubic(range(T + 1 / 240, e, e + 0.45)), r * 0.9, SURIK, play * srcA);
    }
    for (let k = 0; k < 6; k++) {
      const e = phoneOn + 0.7 + k * 0.3;
      if (e > H[2] - 0.4) break;
      packet(F, 2, inOutSine(range(T, e, e + 0.6)), inOutSine(range(T + 1 / 240, e, e + 0.6)), r * 0.8, SURIK, play * srcA);
    }
    // counter: a photo flash, then one reading leaps in on a high arc
    const fl = TS + 0.85;
    const fq = range(T, fl, fl + 0.4);
    if (fq > 0 && fq < 1) F.ring(S2.sx[3], S2.sy[3], s * (0.6 + 1.6 * outCubic(fq)), 1.1, INK, 0.8 * (1 - fq) * srcA);
    const jx = range(T, fl + 0.1, fl + 0.72);
    packet(F, 3, jx < 1 ? inOutCubic(jx) : 1, inOutCubic(range(T + 1 / 240, fl + 0.1, fl + 0.72)), r * 1.7, INK, play * srcA, 2.4);
  }
  if (amb > 0.01) {
    const t = now;
    for (let k = 0; k < 3; k++) packet(F, 0, (t * 0.6 + k / 3) % 1, ((t + 1 / 240) * 0.6 + k / 3) % 1, r, INK, amb * srcA);
    const bp = (t % 2.6) / 0.6;
    for (let q = 0; q < 4; q++) {
      const u = clamp01(bp - q * 0.1);
      packet(F, 1, expoInOut(u), expoInOut(clamp01(bp + 1 / 144 - q * 0.1)), r * 0.9, SIN, amb * srcA);
    }
    packet(F, 2, (t * 0.9 + 0.5) % 1, ((t + 1 / 240) * 0.9 + 0.5) % 1, r * 0.8, SURIK, amb * srcA);
    const cp = (t % 4.2) / 0.62;
    if (cp < 1) packet(F, 3, inOutCubic(cp), inOutCubic(Math.min(1, cp + 1 / 150)), r * 1.7, INK, amb * srcA, 2.4);
  }
  // the cabinet: builds, lights tile by tile, then folds into the dot the next scene opens from
  const cx0 = S2.cx, cy0 = S2.cy;
  const c = leave(range(T, H[2] + 0.02, H[2] + 0.46), 0.05);
  if (c < 1) {
    const k = 1 - c;
    arc(cx0, cy0, S3.x, S3.y, 0.22, smooth(clamp01(c)), tmp);
    cabinet(F, T, tmp[0], tmp[1], S2.cw * k, S2.ch * k, 1, OUT.lit, now);
  }
  if (c > 0.9 && T < H[2] + 0.62) F.disc2(S3.x, S3.y, dot3(), mix(INK, SIN, range(T, H[2] + 0.4, H[2] + 0.5)), 1);
}

// ── 3 · ПОКАЗАНИЯ: one shape becomes each reading in turn, slowly, each held long enough to read ─────
const S3 = { x: 0, y: 0, R: 0 };
function s3Geom() {
  S3.x = L.cx;
  if (L.portrait) {
    S3.R = Math.min(L.W * 0.2, L.H * 0.11);
    S3.y = L.cy - 0.07 * L.H;
  } else {
    // the dial, its bezel and the words under it share the band between the top and bottom HUD
    const top = 64, bottom = L.H - (L.short ? 96 : 124);
    const words = L.short ? 92 : Math.min(190, L.H * 0.2);
    S3.R = Math.max(18, Math.min(L.U * 0.15, (bottom - top - words) / 4.6));
    S3.y = Math.min(L.cy - 0.04 * L.H, bottom - words - 2.2 * S3.R);
  }
  OUT.s3x = S3.x;
  OUT.s3y = S3.y;
  OUT.s3R = S3.R;
}
const morphX = (T: number, j: number) => range(T, MORPH_AT[j], MORPH_AT[j] + M.morph);
const DIAL0 = H[2] + 0.62;

function s3(F: Frame, T: number, now: number) {
  if (T < H[2] + 0.4 || T > H[3] + 0.42) return;
  s3Geom();
  const { x, y } = S3;
  let j = -1;
  for (let m = 0; m < 4; m++) if (T >= MORPH_AT[m]) j = m;
  const a = j < 0 ? 0 : j, b = j < 0 ? 0 : j + 1, mx = j < 0 ? 0 : morphX(T, j), t = glide(mx);
  OUT.reading = j + 1;
  OUT.readingPrev = Math.max(0, j);
  OUT.readingT = j < 0 ? 1 : range(T, MORPH_AT[j] + 0.12, MORPH_AT[j] + 0.82);
  const g = arrive(range(T, DIAL0, DIAL0 + M.enter), 0.1);
  let R = lerp(dot3(), S3.R, g);
  // a slow swell through each transformation, and a sway that travels on an arc and returns
  const sway = Math.sin(Math.PI * mx);
  R *= (1 + 0.035 * sway) * (1 - 0.06 * smooth(range(T, H[3], H[3] + 0.25)));
  const rot = 0.13 * sway * (j % 2 ? -1 : 1);
  const fade = 1 - range(T, H[3] + 0.25, H[3] + 0.4);
  const vis = range(T, DIAL0, DIAL0 + 0.3) * (1 - range(T, H[3], H[3] + 0.2));
  if (vis > 0) {
    F.seg(0, y, L.W, y, 0.5, GOLD, 0.3 * vis);
    F.seg(x, 0, x, L.H, 0.5, GOLD, 0.3 * vis);
    F.ring(x, y, S3.R * (L.portrait ? 2.4 : 2.55), 0.5, GOLD, 0.34 * vis);
  }
  // onion skins trail the transformation in gold
  if (j >= 0 && mx > 0 && mx < 1)
    for (let k = 1; k <= 2; k++) F.morph(x, y, R, a, b, glide(morphX(T - k * 0.085, j)), 1.1, GOLD, (0.42 / k) * fade * sway, rot * 0.7);
  F.morph(x, y, R, a, b, t, 0, BONE, fade, rot);
  // bezel: twelve small readings follow the big one a beat later, a wave running round the dial
  const last = j === 3;
  for (let k = 0; k < 12; k++) {
    const p = arrive(range(T, DIAL0 + 0.1 + stag(k, 12, 0.03), DIAL0 + 0.1 + stag(k, 12, 0.03) + 0.5), 0.2);
    if (p <= 0) continue;
    const an = k * 30 * DEG, rr = S3.R * (L.portrait ? 1.72 : 1.95);
    const tk = j < 0 ? 0 : glide(morphX(T - 0.12 - stag(k, 12, 0.025), j));
    const small = last ? 1 - range(T, MORPH_AT[3] + 0.3, MORPH_AT[3] + 0.8) : 1;
    F.morph(x + Math.sin(an) * rr, y - Math.cos(an) * rr, S3.R * 0.12 * p * (0.35 + 0.65 * small), a, last ? 3 : b, last ? 0 : tk, 0, BONE, Math.min(1, small * 1.4) * fade, rot * 0.5);
    if (last) F.disc2(x + Math.sin(an) * rr, y - Math.cos(an) * rr, 2, BONE, (1 - small) * fade * 0.8);
  }
  // the index dot drops into the ring: the reading becomes the sign
  const dp = arrive(range(T, MORPH_AT[3] + 0.78, MORPH_AT[3] + 1.22), 0.2);
  if (dp > 0) {
    const pulse = T >= H[3] - 1e-3 ? 1 + 0.05 * Math.sin(now * 5.2) : 1;
    const drop = (1 - dp) * R * 0.9;
    F.disc2(x + 0.5 * R, y - 0.866 * R - drop, 0.381 * R * Math.min(1, dp * 1.3) * pulse, SURIK, fade);
  }
}

// ── 4–5 · ТЕХНИКА → БЕЗ СВЯЗИ: the ring turns into the facet shell, the machine, then the map ─
// The choreography below is authored in its original time base (8.2 → 13.36); warp45 maps film time onto it,
// giving the dead-zone drive and the flush more time so the counter can be read.
const WARP: Array<[number, number]> = [
  [H[3], 8.2],
  [H[4], 10.78],
  [H[4] + 0.9, 11.6],
  [H[4] + 2.7, 12.5],
  [H[4] + 3.45, 13.0],
  [H[5], 13.5],
];
function warp45(T: number) {
  if (T <= WARP[0][0]) return WARP[0][1] + (T - WARP[0][0]);
  for (let i = 1; i < WARP.length; i++) {
    const [a, ta] = WARP[i - 1], [b, tb] = WARP[i];
    if (T <= b) return ta + ((T - a) / (b - a)) * (tb - ta);
  }
  return WARP[WARP.length - 1][1] + (T - WARP[WARP.length - 1][0]);
}

interface Key { t: number; tx: number; ty: number; tz: number; d: number; az: number; el: number; fov: number; lx: number; py: number }
const K = (t: number, tx: number, ty: number, tz: number, d: number, az: number, el: number, fov: number, lx = 0, py = 0): Key => ({ t, tx, ty, tz, d, az: az * DEG, el: el * DEG, fov: fov * DEG, lx, py });
// lx: landscape shift of the target (the machine moves right of the words); py: portrait lift
const KEYS: Key[] = [
  K(8.45, 0, 0, 0, 6, 0, 0, 34),
  K(9.2, 0, 0.05, 0, 5.4, 20, 23, 38, -0.3, 0),
  K(10.78, 0, 0.02, 0, 4.7, 40, 15, 40, -1.3, -0.05),
  K(11.6, 3.0, -0.8, -0.8, 10.6, 6, 38, 36, -0.9, 0.5),
  K(13.36, 3.8, -0.8, -1.1, 10.2, 11, 40, 36, -1.3, 0.62),
];
/** Portrait framing: the machine needs a longer lens distance than the map. */
const pm = (i: number) => (L.portrait ? (i <= 2 ? 2.25 : 2.15) : 1);
function camera(F: Frame, t: number) {
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const s = inOutCubic(range(t, a.t, b.t));
  const pan = L.portrait ? -1.8 * smooth(range(t, 11.45, 12.5)) : 0;
  const ox = L.portrait ? pan : lerp(a.lx, b.lx, s), oy = L.portrait ? lerp(a.py, b.py, s) : 0;
  F.cam.set(lerp(a.tx, b.tx, s) + ox, lerp(a.ty, b.ty, s) + oy, lerp(a.tz, b.tz, s), lerp(a.d * pm(i), b.d * pm(i + 1), s), lerp(a.az, b.az, s), lerp(a.el, b.el, s), lerp(a.fov, b.fov, s), L.W, L.H);
}

function compose(out: Float32Array, tx: number, ty: number, tz: number, rx: number, ry: number, s: number) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  // R = Ry · Rx
  out[0] = cy * s; out[1] = 0; out[2] = -sy * s; out[3] = 0;
  out[4] = sy * sx * s; out[5] = cx * s; out[6] = cy * sx * s; out[7] = 0;
  out[8] = sy * cx * s; out[9] = -sx * s; out[10] = cy * cx * s; out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
}
function apply(m: Float32Array, x: number, y: number, z: number, out: Float32Array) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

const RT: Route = route();
function routePos(u: number, out: Float32Array) {
  const s = clamp01(u) * RT.length;
  let i = 1;
  while (i < RT.cum.length - 1 && RT.cum[i] < s) i++;
  const k = (s - RT.cum[i - 1]) / Math.max(1e-6, RT.cum[i] - RT.cum[i - 1]);
  out[0] = RT.pts[i - 1][0] + (RT.pts[i][0] - RT.pts[i - 1][0]) * k;
  out[1] = RT.pts[i - 1][1] + (RT.pts[i][1] - RT.pts[i - 1][1]) * k;
}
const machineU = (t: number) =>
  t < 11.45 ? 0 : t < 12.5 ? coverU * inOutSine(range(t, 11.45, 12.5)) : lerp(coverU, Math.min(1, coverU + 0.1), outCubic(range(t, 12.5, 12.95)));
const STORE = 0.055;

const scr = new Float32Array(3);
const w3 = new Float32Array(3);
const w3b = new Float32Array(3);
export let quality = 1;
export const setQuality = (q: number) => (quality = q);

function s45(F: Frame, T: number, now: number) {
  const t = warp45(T);
  if (t < 8.4 || T > H[5] + 1e-4) return;
  s3Geom();
  camera(F, t);
  const cam = F.cam, P = F.part;
  // ring world size so the facet torus lands exactly on the flat logo ring at the cut
  const projPx = cam.projPx;
  const d0 = KEYS[0].d * pm(0);
  const r0 = (S3.R * 0.94 * d0) / projPx;
  const grow = lerp(1, 2.2, inOutCubic(range(t, 8.5, 9.2)));
  const e = inOutCubic(range(t, 8.5, 9.25));
  const ty0 = ((L.cy - S3.y) / projPx) * d0 * (1 - e);
  compose(P.ring, 0, ty0, 0, -52 * DEG * e, 78 * DEG * e + 0.12 * smooth(range(t, 8.5, 10.78)), (r0 * grow) / 0.62);
  compose(P.exc, SITE[0], SITE[1], SITE[2], 0, 0.06 * Math.sin(now * 0.35) * range(t, 10.2, 10.78), 1);
  if (t < 11.6) {
    P.on = true;
    P.T = t;
    P.appear = lerp(-0.2, 1.2, range(t, 8.45, 8.72));
    P.fly0 = 9.1;
    P.spread = 0.55;
    P.dur = 0.9;
    P.gone = range(t, 10.84, 11.5);
    apply(P.exc, BEACON[0], BEACON[1], BEACON[2], w3);
    P.goneTo[0] = w3[0];
    P.goneTo[1] = w3[1];
    P.goneTo[2] = w3[2];
    P.count = Math.max(200, Math.floor(1e9 * quality));
  }
  // the tracker beacon: the logo's index dot, carried through the whole sequence
  const u = machineU(t);
  routePos(u, tmp);
  const gx = tmp[0] + SITE[0], gy = SITE[1] + 0.06, gz = tmp[1] + SITE[2];
  let rw: number;
  // the dot keeps logo proportions on the flat ring, then shrinks to a tracker beacon as the shell turns 3D
  const shrink = lerp(1, 0.3, inOutCubic(range(t, 8.5, 9.1)));
  if (t < 9.15) {
    apply(P.ring, 0.62 * 0.5, 0.62 * 0.866, 0, w3);
    rw = 0.381 * 0.62 * Math.hypot(P.ring[0], P.ring[1], P.ring[2]) * shrink;
  } else if (t < 9.95) {
    apply(P.ring, 0.62 * 0.5, 0.62 * 0.866, 0, w3);
    apply(P.exc, BEACON[0], BEACON[1], BEACON[2], w3b);
    const f = inOutCubic(range(t, 9.15, 9.95));
    const lift = 0.9 * 4 * f * (1 - f);
    w3[0] = lerp(w3[0], w3b[0], f);
    w3[1] = lerp(w3[1], w3b[1], f) + lift;
    w3[2] = lerp(w3[2], w3b[2], f);
    rw = lerp(0.381 * 0.62 * Math.hypot(P.ring[0], P.ring[1], P.ring[2]) * shrink, 0.075, f);
  } else {
    apply(P.exc, BEACON[0], BEACON[1], BEACON[2], w3);
    const f = inOutCubic(range(t, 10.95, 11.45));
    w3[0] = lerp(w3[0], gx, f);
    w3[1] = lerp(w3[1], gy, f);
    w3[2] = lerp(w3[2], gz, f);
    rw = 0.075;
  }
  cam.project(w3[0], w3[1], w3[2], scr);
  const sx = scr[0], sy = scr[1];
  const rpx = Math.max(3.5, (rw * projPx) / scr[2]);
  const dotIn = range(t, 8.45, 8.5);
  if (scr[2] > 0) {
    F.disc2(sx, sy, rpx, SURIK, dotIn);
    if (t > 9.95)
      for (let i = 0; i < 2; i++) {
        const ph = (now * 0.7 + i * 0.5) % 1;
        F.ring(sx, sy, rpx * (1.6 + 4.5 * ph), 0.9, SURIK, 0.55 * (1 - ph) * (1 - ph));
      }
  }
  // the map
  let stored = 0, sent = 0;
  if (t > 10.86) {
    const Pt = F.pts;
    Pt.on = true;
    Pt.site[0] = SITE[0];
    Pt.site[1] = SITE[1];
    Pt.site[2] = SITE[2];
    Pt.rise[0] = 0;
    Pt.rise[1] = 0;
    Pt.rise[2] = 18 * inOutCubic(range(t, 10.95, 12.0));
    Pt.mast[0] = MAST[0];
    Pt.mast[1] = MAST[2];
    Pt.mast[2] = COVERAGE;
    Pt.machine[0] = tmp[0];
    Pt.machine[1] = tmp[1];
    Pt.wave = t > 12.5 ? (t - 12.5) * 7 : -1;
    Pt.alpha = 1;
    const vis = range(t, 11.1, 11.5);
    // mast with coverage pulses
    const mx = MAST[0] + SITE[0], mz = MAST[2] + SITE[2];
    cam.project(mx, SITE[1], mz, w3b);
    const bx = w3b[0], by = w3b[1];
    cam.project(mx, SITE[1] + MAST_H * range(t, 11.3, 11.8), mz, w3b);
    F.seg(bx, by, w3b[0], w3b[1], 1, BONE, 0.75 * vis);
    F.disc2(w3b[0], w3b[1], 3.5, SURIK, vis);
    for (let i = 0; i < 3; i++) {
      const ph = (now * 0.55 + i / 3) % 1;
      F.ring(w3b[0], w3b[1], 5 + 46 * ph, 0.8, BONE, 0.45 * (1 - ph) * vis);
    }
    const topX = w3b[0], topY = w3b[1];
    // points stored in the tracker while there is no network; sent to the mast on arrival
    for (let j = 0; ; j++) {
      const uj = 0.04 + j * STORE;
      if (uj >= coverU) break;
      if (u <= uj) break;
      routePos(uj, tmp2);
      const px = tmp2[0] + SITE[0], pz = tmp2[1] + SITE[2];
      const f = expoInOut(range(t, 12.52 + j * 0.034, 12.88 + j * 0.034));
      if (f >= 1) {
        sent++;
        continue;
      }
      stored++;
      cam.project(px, SITE[1] + 0.05, pz, w3b);
      const x0 = w3b[0], y0 = w3b[1];
      const mxs = lerp(x0, topX, 0.5), mys = Math.min(y0, topY) - 0.12 * L.H;
      const x = (1 - f) * (1 - f) * x0 + 2 * (1 - f) * f * mxs + f * f * topX;
      const y = (1 - f) * (1 - f) * y0 + 2 * (1 - f) * f * mys + f * f * topY;
      // a landed point pops when it is written to memory
      const pop = arrive(range(t, 11.45 + (uj / Math.max(0.01, coverU)) * 1.05, 11.45 + (uj / Math.max(0.01, coverU)) * 1.05 + 0.3), 0.4);
      F.rect(x, y, 4.4 * pop, 4.4 * pop, 1.2, SURIK, vis);
    }
    OUT.inCover = u >= coverU - 1e-4;
  }
  OUT.stored = stored;
  OUT.sent = sent;
  OUT.tagOn = t > 11.45 && T <= H[5] ? 1 : 0;
  OUT.tagX = sx;
  OUT.tagY = sy;
}

// ── 6 · НА СВЯЗИ: kinetic type cut fast, each word snapping in with weight ───────────────
function s6(F: Frame, T: number, now: number) {
  if (!TYPE || T <= H[5] || T > H[6] + 0.3) return;
  const j = cutIndex(T), c = CUTS[j], w = TYPE.words[c.word];
  if (!w) return;
  const lt = T - (H[5] + j * CUT);
  if (c.pattern) return pattern(F, w, lt);
  // a monospace word space is a whole cell wide: close it up by half, as a typesetter would
  const cell = w.adv / w.text.length, cutSp = cell * 0.5;
  let spaces = 0;
  for (let i = 0; i < w.text.length; i++) if (w.text[i] === ' ' || w.text[i] === '\u00a0') spaces++;
  const adv = w.adv - spaces * cutSp;
  let k = (L.W * (L.portrait ? 0.9 : c.bars ? 0.7 : 0.84)) / adv, sy = 1;
  if (c.cond) sy = Math.min(1.7, (L.H * (L.portrait ? 0.24 : 0.4)) / (w.cap * k));
  else k = Math.min(k, (L.H * (L.portrait ? 0.2 : 0.3)) / w.cap);
  // lands a little large and settles: the cut has weight
  const snap = 1 + 0.07 * (1 - arrive(range(lt, 0, 0.3), 0.06));
  k *= snap;
  const width = adv * k, cap = w.cap * k * sy;
  const barsW = c.bars && !L.portrait ? cap * 1.05 : 0;
  const x0 = L.cx - (width + barsW) / 2, base = L.cy + cap / 2 + (c.bars && L.portrait ? cap * 0.5 : 0);
  let dx = 0, vx = 0, mode = 0;
  if (j === 6 && T > H[6]) {
    const e = expoIn(range(T, H[6], H[6] + 0.22));
    dx = -e * 0.8 * L.W;
    vx = -(expoIn(range(T + 1 / 240, H[6], H[6] + 0.22)) - e) * 240 * 0.8 * L.W * SHUTTER;
    mode = 4;
  }
  const n = w.glyphs.length;
  let shift = 0;
  for (let i = 0; i < n; i++) {
    const g = w.glyphs[i];
    if (w.text[i] === ' ' || w.text[i] === '\u00a0') shift += cutSp;
    if (!g) continue;
    const e = arrive(range(lt, stag(i, n, 0.012), stag(i, n, 0.012) + 0.24), 0.12);
    const lift = (1 - e) * cap * 0.16;
    const isDot = w.text[i] === '.';
    let s = 1;
    if (isDot && j === 6 && T >= H[6] - 1e-3) s = 1 + 0.12 * Math.max(0, Math.sin(now * 5.4));
    F.glyph(g, x0 + (w.pens[i] - shift) * k + dx, base + lift, k, s, sy * s, isDot && c.dot ? c.dot : c.col, 1, vx, 0, mode);
  }
  if (c.bars) {
    // signal strength: four bars rise one after another — the machine is on the air
    const bw = cap * 0.17, gap = cap * 0.09;
    const bx0 = L.portrait ? L.cx - (4 * bw + 3 * gap) / 2 : x0 + width + cap * 0.22;
    const by = L.portrait ? base - cap * 1.45 : base;
    for (let b = 0; b < 4; b++) {
      const p = arrive(range(lt, 0.12 + stag(b, 4, 0.08), 0.12 + stag(b, 4, 0.08) + 0.42), 0.16);
      if (p <= 0) continue;
      const hgt = cap * (0.28 + 0.24 * b) * p;
      const glow = T >= H[6] - 1e-3 ? 0.75 + 0.25 * Math.max(0, Math.sin(now * 3 - b * 0.9)) : 1;
      F.rect(bx0 + b * (bw + gap) + bw / 2 + dx, by - hgt / 2, bw / 2, hgt / 2, bw * 0.18, b === 3 ? SURIK : BONE, glow);
    }
  }
}

function pattern(F: Frame, w: Word, lt: number) {
  const cap = L.H * (L.portrait ? 0.075 : 0.12), k = cap / w.cap, rowH = cap * 1.75, gap = cap * 1.2;
  const ww = w.adv * k + gap;
  const n = Math.ceil(L.H / rowH) + 1, mid = Math.floor(n / 2);
  for (let r = 0; r < n; r++) {
    const dir = r % 2 ? -1 : 1, sp = 0.4 * L.W * dir;
    const base = (r + 0.78) * rowH - (n * rowH - L.H) / 2;
    let off = (lt * sp + r * 137) % ww;
    if (off > 0) off -= ww;
    for (let x = off - ww; x < L.W + ww; x += ww)
      for (let i = 0; i < w.glyphs.length; i++) {
        const g = w.glyphs[i];
        if (g) F.glyph(g, x + w.pens[i] * k, base, k, 1, 1, INK, 1, sp * SHUTTER, 0, r === mid ? 0 : 1);
      }
  }
}

// ── 7 · СТАРТ: the sign counts itself in, the wordmark slides in, the next step follows ─────
const S7 = { u: 1, x0: 0, base: 0, symX: 0, symY: 0, symR: 0 };
function lockGeom() {
  const lw = 734;
  const u = L.portrait ? (L.W * 0.62) / lw : Math.min((L.W * 0.36) / lw, (L.H * 0.075) / 100);
  const left = L.cx - (lw * u) / 2, mid = L.H * (L.portrait ? 0.105 : 0.15);
  S7.u = u;
  S7.symR = 40 * u;
  S7.symX = left + 48.6 * u;
  S7.symY = mid;
  S7.x0 = left + 137.2 * u;
  S7.base = mid + 50 * u;
  OUT.lockBottom = S7.base + 18 * u;
  OUT.lockX = S7.x0;
}

function s7(F: Frame, T: number, now: number) {
  if (!TYPE || T < H[6] + 0.1) return;
  lockGeom();
  const t0 = H[6];
  const ax = L.cx, ay = L.cy - 0.04 * L.H;
  const m = inOutCubic(range(T, t0 + 0.72, t0 + 1.12));
  const R = lerp(0.1 * L.U, S7.symR, m), cx = lerp(ax, S7.symX, m), cy = lerp(ay, S7.symY, m);
  for (let k = 0; k < 12; k++) {
    const p = arrive(range(T, t0 + 0.3 + stag(k, 12, 0.026), t0 + 0.3 + stag(k, 12, 0.026) + 0.34), 0.2);
    if (p <= 0) continue;
    F.ring(cx, cy, R * (0.9 + 0.1 * p), 0.2143 * R, INK, clamp01(p * 2), (30 + 30 * k) * DEG, 30.6 * DEG);
  }
  const dp = arrive(range(T, t0 + 0.6, t0 + 0.98), 0.22);
  if (dp > 0) {
    const px = cx + 0.5 * R, py = cy - 0.866 * R;
    F.disc2(px, py, 0.5238 * R * Math.min(1, dp * 1.2), BONE);
    const pulse = T >= H[7] - 1e-3 ? 1 + 0.06 * Math.sin(now * 5.2) : 1;
    F.disc2(px, py - (1 - dp) * R * 0.6, 0.381 * R * Math.min(1, dp * 1.25) * pulse, SURIK);
    // one ring of signal as the dot lands
    const rq = range(T, t0 + 0.78, t0 + 1.5);
    if (rq > 0 && rq < 1) F.ring(px, py, 0.4 * R + outCubic(rq) * L.U * 0.35, 1.2, SURIK, 0.5 * (1 - rq) * (1 - rq));
  }
  const u = S7.u, k = u / TYPE.wmScale;
  for (let i = 0; i < 6; i++) {
    const a = t0 + 0.78 + i * 0.035;
    const e = arrive(range(T, a, a + 0.5), 0.05);
    if (e <= 0) continue;
    const dx = (1 - e) * 0.55 * L.W;
    const vx = -(arrive(range(T + 1 / 240, a, a + 0.5), 0.05) - e) * 240 * 0.55 * L.W * SHUTTER;
    F.glyph(TYPE.wm[i], S7.x0 + dx, S7.base, k, 1, 1, INK, range(e, 0, 0.25), vx, 0);
  }
  const d = WORDMARK.dots;
  for (let j = 0; j < 2; j++) {
    const p = arrive(range(T, t0 + 1.12 + j * 0.06, t0 + 1.12 + j * 0.06 + 0.32), 0.3);
    F.disc2(S7.x0 + d.x[j] * u, S7.base + (d.y - 100) * u, d.r * u * p, j ? SURIK : INK);
  }
}

export function draw(F: Frame, T: number, now: number) {
  F.time = now;
  background(F, T);
  s1(F, T, now);
  s2(F, T, now);
  s3(F, T, now);
  s45(F, T, now);
  s6(F, T, now);
  s7(F, T, now);
}
