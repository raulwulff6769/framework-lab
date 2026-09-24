import { describe, expect, it } from 'vitest';
import { analyzeFuel } from '../server/domain/fuel.js';
import { workedArea } from '../server/domain/agro.js';
import { geodesicM, polygonArea } from '../server/domain/geodesy.js';
import { effectiveBlocks, cleanOverrides, rank, rolesFor } from '../server/domain/roles.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('fuel level analysis', () => {
  const t0 = Date.UTC(2026, 8, 1, 6);
  it('finds a refill and a drain in slosh noise and tells the drain from consumption', () => {
    for (const seed of [1, 2, 3]) {
      const r = rng(seed);
      const level: Array<{ t: number; v: number }> = [];
      const rate: Array<{ t: number; v: number }> = [];
      let v = 500;
      for (let i = 0; i < 600; i++) {
        const t = t0 + i * 60e3;
        const working = i < 200 || (i >= 300 && i < 450);
        if (working) v -= 30 / 60; // 30 l/h
        if (i === 250) v += 300; // refill at the fuel truck
        if (i >= 500 && i < 505) v -= 12; // 60 l drained in 5 min, engine off
        rate.push({ t, v: working ? 30 : 0 });
        level.push({ t, v: v + (r() - 0.5) * (working ? 8 : 1.5) });
      }
      const a = analyzeFuel(level, rate, { tankL: 1000 });
      expect(a.events.map((e) => e.kind)).toEqual(['refill', 'drain']);
      expect(a.events[0].litres).toBeGreaterThan(285);
      expect(a.events[0].litres).toBeLessThan(315);
      expect(a.events[1].litres).toBeGreaterThan(50);
      expect(a.events[1].litres).toBeLessThan(70);
      expect(a.consumed_l!).toBeGreaterThan(160);
      expect(a.consumed_l!).toBeLessThan(190);
    }
  });
  it('does not report a heavy burn as a drain when the fuel rate explains it', () => {
    const level = Array.from({ length: 60 }, (_, i) => ({ t: t0 + i * 60e3, v: 400 - i * 1.2 }));
    const rate = level.map((p) => ({ t: p.t, v: 72 }));
    expect(analyzeFuel(level, rate).events).toEqual([]);
  });
  it('finds a refill across a gap of a parked tracker that writes once an hour', () => {
    // evening shift every 5 min down to 380 l, hourly points parked overnight, the tank is filled
    // before the morning shift, then work again (no fuel-rate sensor, like the Galileosky mapping)
    const level: Array<{ t: number; v: number }> = [];
    let t = t0;
    let v = 700;
    for (let i = 0; i < 40; i++, t += 5 * 60e3) level.push({ t, v: (v -= 8) });
    for (let i = 0; i < 4; i++, t += 3600e3) level.push({ t, v });
    t += 3.5 * 3600e3;
    v = 950;
    for (let i = 0; i < 30; i++, t += 5 * 60e3) level.push({ t, v: (v -= 8) });
    const a = analyzeFuel(level, [], { tankL: 1000 });
    expect(a.events.map((e) => e.kind)).toEqual(['refill']);
    expect(a.events[0].litres).toBeCloseTo(950 - 8 - 380, 0);
    expect(a.consumed_l!).toBeCloseTo((39 + 29) * 8, 0); // observed drops between points; the refill itself is excluded
  });
});

describe('worked area and geodesy', () => {
  it('counts only passes with the implement down at working speed', () => {
    const t0 = Date.UTC(2026, 8, 1, 8);
    const track = Array.from({ length: 121 }, (_, i) => ({ t: t0 + i * 10e3, lat: 45.63 + i * 0.00025, lon: 38.97, speed_kmh: 10 }));
    const imp = [{ t: t0, v: 1 }, { t: t0 + 600e3, v: 0 }];
    const w = workedArea(track, imp, 12);
    const dist = geodesicM(45.63, 38.97, 45.63 + 60 * 0.00025, 38.97);
    expect(w.work_km * 1000).toBeCloseTo(dist, -1);
    expect(w.area_ha).toBeCloseTo((dist * 12) / 1e4, 1);
  });
  it('matches a 1 km square to ±0.1 % and the GeographicLib reference geodesic', () => {
    // 0.009 deg lat ≈ 1000 m at 45°N; the area of the rectangle is checked against its own geodesic sides
    const lat = 45;
    const dLat = 1000 / geodesicM(lat, 0, lat + 1, 0);
    const dLon = 1000 / geodesicM(lat, 0, lat, 1);
    const ring: Array<[number, number]> = [[0, lat], [dLon, lat], [dLon, lat + dLat], [0, lat + dLat], [0, lat]];
    expect(polygonArea(ring).areaM2 / 1e6).toBeCloseTo(1, 2);
    // JFK → LHR example from the GeographicLib documentation: s12 = 5551759.400319 m
    expect(geodesicM(40.6, -73.8, 51.6, -0.5)).toBeCloseTo(5551759.4, 0);
  });
});

describe('role model', () => {
  it('keeps overrides relative to the role and ranks admins above staff', () => {
    expect(effectiveBlocks('mechanic', { map: true })).toContain('map');
    expect(effectiveBlocks('dispatcher', { fuel: false })).not.toContain('fuel');
    expect(cleanOverrides('mechanic', { map: true, oil: true, bogus: true })).toEqual({ map: true });
    expect(rank('admin', 'customer')).toBeGreaterThan(rank('dispatcher', 'customer'));
    expect(rolesFor('distributor')).toEqual(['admin', 'engineer']);
    expect(rolesFor('customer')).toEqual(['admin', 'dispatcher', 'mechanic', 'viewer', 'operator']);
  });
});
