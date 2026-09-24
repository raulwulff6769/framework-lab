import type { Db } from './db.js';
import { validLatLon } from './domain/geo.js';
import { robustDistance, type Fix, type MachineProfile } from './domain/odometry.js';
import { fitCalibration, type CounterMethod, type Point } from './domain/counters.js';
import { SENSORS } from './domain/sensors.js';

export type RawMethod = 'ecu' | 'tracker' | 'platform' | 'device';
const METHODS: ReadonlySet<string> = new Set(['ecu', 'tracker', 'platform', 'device']);

export interface IngestRecord {
  t: string | number;
  lat?: number | null;
  lon?: number | null;
  speed_kmh?: number | null;
  course?: number | null;
  alt?: number | null;
  sats?: number | null;
  hdop?: number | null;
  acc_m?: number | null;
  engine_hours?: number | null;
  engine_hours_method?: RawMethod;
  odometer_km?: number | null;
  odometer_method?: RawMethod;
  sensors?: Record<string, number> | null;
  /** active J1939 DM1 codes at time t (an empty list means "no active faults") */
  dtc?: Array<{ spn: number; fmi: number; oc?: number | null; lamp?: number | null }> | null;
}

export interface SourceRow {
  id: string;
  machine_id: string | null;
  org_id: string;
  kind: string;
}

export interface IngestResult {
  positions: number;
  counters: number;
  sensors: number;
  faults: number;
  duplicates: number;
  location_dropped: number;
  rejected: Array<{ index: number; reason: string }>;
}

export const DEFAULT_METHOD: Record<string, RawMethod> = {
  tracker: 'tracker',
  phone: 'device',
  traccar: 'platform',
  wialon: 'platform',
  aemp: 'ecu',
  manual: 'device',
};

// Trackers without a valid RTC/GNSS time report 1970/2000 dates; nothing real predates 2015.
const MIN_T = Date.UTC(2015, 0, 1);
const MAX_PAST_MS = 800 * 86400e3; // longer than any tracker archive (Galileosky: ~500 days at 1 rec/5 min)
const MAX_FUTURE_MS = 10 * 60e3;

export function parseTime(t: unknown): number {
  if (typeof t === 'number') return t < 1e11 ? t * 1000 : t;
  if (typeof t === 'string' && t) return Date.parse(t);
  return NaN;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const inRange = (v: number | null, lo: number, hi: number) => (v === null || (v >= lo && v <= hi) ? v : null);

interface MachineRow {
  id: string;
  org_id: string;
  location_enabled: boolean;
  chassis: 'wheeled' | 'tracked';
  rotating_upper: boolean;
  category: string;
  tz: string;
  archived: boolean;
}

export async function loadMachine(db: Db, id: string): Promise<MachineRow | null> {
  const r = await db.query<MachineRow>(
    `select m.id, m.org_id, m.location_enabled, m.chassis, m.rotating_upper, m.category, o.tz, m.archived
       from machines m join orgs o on o.id = m.org_id where m.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function ingestForSource(
  db: Db,
  source: SourceRow,
  records: IngestRecord[],
  now = Date.now(),
): Promise<IngestResult> {
  const res: IngestResult = { positions: 0, counters: 0, sensors: 0, faults: 0, duplicates: 0, location_dropped: 0, rejected: [] };
  if (!source.machine_id) {
    records.forEach((_, i) => res.rejected.push({ index: i, reason: 'source_not_assigned' }));
    return res;
  }
  const machine = await loadMachine(db, source.machine_id);
  if (!machine) throw new Error('machine missing for source ' + source.id);
  if (machine.archived) {
    // the machine is in the trash: nothing is stored, the sender must not retry
    records.forEach((_, i) => res.rejected.push({ index: i, reason: 'machine_deleted' }));
    return res;
  }

  const pos = new Map<number, unknown[]>();
  const cnt = new Map<string, unknown[]>();
  const sen = new Map<string, unknown[]>();
  const flt = new Map<string, unknown[]>();
  let attemptedPos = 0;
  let attemptedCnt = 0;

  records.forEach((r, i) => {
    if (!r || typeof r !== 'object') return res.rejected.push({ index: i, reason: 'not_an_object' });
    const t = parseTime(r.t);
    if (!Number.isFinite(t)) return res.rejected.push({ index: i, reason: 'bad_time' });
    if (t < MIN_T || t < now - MAX_PAST_MS) return res.rejected.push({ index: i, reason: 'time_too_old' });
    if (t > now + MAX_FUTURE_MS) return res.rejected.push({ index: i, reason: 'time_in_future' });
    let useful = false;

    const hasLoc = r.lat !== undefined && r.lat !== null && r.lon !== undefined && r.lon !== null;
    if (hasLoc) {
      if (!machine.location_enabled) {
        // Location collection is switched off for this machine: coordinates are discarded here,
        // before any storage or processing.
        res.location_dropped++;
        useful = true;
      } else if (validLatLon(r.lat, r.lon)) {
        attemptedPos++;
        pos.set(t, [
          source.id,
          new Date(t).toISOString(),
          machine.id,
          r.lat,
          r.lon,
          inRange(num(r.speed_kmh), 0, 400),
          inRange(num(r.course), 0, 360),
          inRange(num(r.alt), -500, 9000),
          inRange(num(r.sats), 0, 99),
          inRange(num(r.hdop), 0, 99.9),
          inRange(num(r.acc_m), 0, 100000),
        ]);
        useful = true;
      } else if (!(r.engine_hours ?? r.odometer_km) && !r.sensors) {
        return res.rejected.push({ index: i, reason: 'bad_coordinates' });
      }
    }

    const eh = num(r.engine_hours);
    if (eh !== null) {
      if (eh < 0 || eh > 300000) return res.rejected.push({ index: i, reason: 'bad_engine_hours' });
      const m = r.engine_hours_method && METHODS.has(r.engine_hours_method) ? r.engine_hours_method : DEFAULT_METHOD[source.kind];
      attemptedCnt++;
      cnt.set(`engine_hours|${t}`, [source.id, 'engine_hours', new Date(t).toISOString(), machine.id, eh, m]);
      useful = true;
    }
    const od = num(r.odometer_km);
    if (od !== null) {
      if (od < 0 || od > 10_000_000) return res.rejected.push({ index: i, reason: 'bad_odometer' });
      const m = r.odometer_method && METHODS.has(r.odometer_method) ? r.odometer_method : DEFAULT_METHOD[source.kind];
      attemptedCnt++;
      cnt.set(`odometer_km|${t}`, [source.id, 'odometer_km', new Date(t).toISOString(), machine.id, od, m]);
      useful = true;
    }
    let badSensor = false;
    if (r.sensors && typeof r.sensors === 'object') {
      for (const [key, v] of Object.entries(r.sensors)) {
        const def = SENSORS[key];
        if (!def || typeof v !== 'number' || !Number.isFinite(v) || v < def.min || v > def.max) {
          badSensor = true;
          continue;
        }
        sen.set(`${key}|${t}`, [source.id, key, new Date(t).toISOString(), machine.id, v]);
        useful = true;
      }
    }
    if (Array.isArray(r.dtc)) {
      useful = true;
      for (const d of r.dtc.slice(0, 64)) {
        const spn = num(d?.spn);
        const fmi = num(d?.fmi);
        if (spn === null || fmi === null || spn < 0 || spn > 524287 || fmi < 0 || fmi > 31 || !Number.isInteger(spn) || !Number.isInteger(fmi)) {
          badSensor = true;
          continue;
        }
        const oc = inRange(num(d.oc), 0, 127);
        const lamp = inRange(num(d.lamp), 0, 4);
        flt.set(`${spn}|${fmi}|${t}`, [source.id, new Date(t).toISOString(), machine.id, spn, fmi, oc, lamp]);
      }
    }
    // other values of the record are still stored; one reason per record, never retried
    if (badSensor) res.rejected.push({ index: i, reason: 'bad_sensor' });
    else if (!useful) res.rejected.push({ index: i, reason: 'no_data' });
  });

  const posRows = [...pos.values()];
  const cntRows = [...cnt.values()];
  res.positions = await insertMany(
    db,
    'positions (source_id, t, machine_id, lat, lon, speed_kmh, course, alt, sats, hdop, acc_m)',
    posRows,
    'on conflict (source_id, t) do nothing',
  );
  res.counters = await insertMany(
    db,
    'counters (source_id, metric, t, machine_id, value, method)',
    cntRows,
    'on conflict (source_id, metric, t) do nothing',
  );
  const senRows = [...sen.values()];
  res.sensors = await insertMany(
    db,
    'sensor_readings (source_id, key, t, machine_id, value)',
    senRows,
    'on conflict (source_id, key, t) do nothing',
  );
  res.faults = await insertMany(
    db,
    'fault_events (source_id, t, machine_id, spn, fmi, oc, lamp)',
    [...flt.values()],
    'on conflict (source_id, t, spn, fmi) do nothing',
  );
  res.duplicates = attemptedPos + attemptedCnt + senRows.length - res.positions - res.counters - res.sensors;

  await db.query(`update sources set last_seen_at = now() where id = $1`, [source.id]);

  if (res.positions > 0) {
    await markDirty(db, machine.id, machine.tz, [...pos.keys()]);
    await recomputeDirtyDays(db, machine, 14);
  }
  if (res.counters > 0) {
    const metrics = new Set(cntRows.map((r) => r[1] as string));
    for (const m of metrics) await refitCalibrations(db, machine.id, m as 'engine_hours' | 'odometer_km');
  }
  return res;
}

async function insertMany(db: Db, target: string, rows: unknown[][], tail: string): Promise<number> {
  let inserted = 0;
  const width = rows[0]?.length ?? 0;
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const params: unknown[] = [];
    const values = chunk
      .map((row) => {
        const ph = row.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${ph.join(',')})`;
      })
      .join(',');
    if (width === 0) continue;
    const r = await db.query(`insert into ${target} values ${values} ${tail}`, params);
    inserted += r.rowCount;
  }
  return inserted;
}

async function markDirty(db: Db, machineId: string, tz: string, times: number[]) {
  await db.query(
    `insert into daily_stats (machine_id, day, dirty)
       select $1, d, true from (
         select distinct (to_timestamp(x / 1000.0) at time zone $2)::date as d from unnest($3::float8[]) as x
       ) s
     on conflict (machine_id, day) do update set dirty = true`,
    [machineId, tz, times],
  );
}

export async function recomputeDirtyDays(db: Db, m: MachineRow, limit: number): Promise<number> {
  const days = await db.query<{ day: string }>(
    `select day::text as day from daily_stats where machine_id = $1 and dirty order by day desc limit $2`,
    [m.id, limit],
  );
  const profile: MachineProfile = { chassis: m.chassis, rotatingUpper: m.rotating_upper, category: m.category };
  for (const { day } of days.rows) {
    const pts = await db.query<any>(
      `select (extract(epoch from t) * 1000)::float8 as t, lat, lon, speed_kmh, hdop, sats, acc_m
         from positions
        where machine_id = $1
          and t >= ($2::date)::timestamp at time zone $3
          and t < ($2::date + 1)::timestamp at time zone $3
        order by t`,
      [m.id, day, m.tz],
    );
    const fixes: Fix[] = pts.rows.map((p) => ({
      t: Number(p.t),
      lat: p.lat,
      lon: p.lon,
      speedKmh: p.speed_kmh,
      hdop: p.hdop,
      sats: p.sats,
      accM: p.acc_m,
    }));
    const r = robustDistance(fixes, profile);
    await db.query(
      `update daily_stats set gnss_km = $3, transport_km = $4, points = $5,
              first_t = to_timestamp($6 / 1000.0), last_t = to_timestamp($7 / 1000.0), dirty = false
        where machine_id = $1 and day = $2::date`,
      [m.id, day, r.km, r.transportKm, fixes.length, fixes[0]?.t ?? null, fixes.at(-1)?.t ?? null],
    );
  }
  return days.rows.length;
}

/** Re-fit offset/scale of every relative counter of the machine against dashboard readings. */
export async function refitCalibrations(db: Db, machineId: string, metric: 'engine_hours' | 'odometer_km') {
  const readings = await db.query<{ t: number; value: number }>(
    `select (extract(epoch from t) * 1000)::float8 as t, value from readings
      where machine_id = $1 and metric = $2 order by t desc limit 20`,
    [machineId, metric],
  );
  const srcs = await db.query<{ source_id: string; method: CounterMethod }>(
    `select s.id as source_id, c.method from sources s
       cross join lateral (select method from counters where source_id = s.id and metric = $2 order by t desc limit 1) c
      where s.machine_id = $1`,
    [machineId, metric],
  );
  const rs: Point[] = readings.rows.map((r) => ({ t: Number(r.t), value: Number(r.value) })).reverse();
  for (const s of srcs.rows) {
    if (s.method === 'ecu') continue; // absolute value from the engine controller, same as the dashboard
    if (rs.length === 0) {
      await db.query(`delete from calibrations where source_id = $1 and metric = $2`, [s.source_id, metric]);
      continue;
    }
    const pts = new Map<number, number>();
    for (const r of rs) {
      const q = await db.query<{ t: number; value: number }>(
        `(select (extract(epoch from t) * 1000)::float8 as t, value from counters
           where source_id = $1 and metric = $2 and t <= to_timestamp($3 / 1000.0) order by t desc limit 1)
         union all
         (select (extract(epoch from t) * 1000)::float8 as t, value from counters
           where source_id = $1 and metric = $2 and t >= to_timestamp($3 / 1000.0) order by t asc limit 1)`,
        [s.source_id, metric, r.t],
      );
      for (const p of q.rows) pts.set(Number(p.t), Number(p.value));
    }
    const points = [...pts.entries()].map(([t, value]) => ({ t, value })).sort((a, b) => a.t - b.t);
    const cal = fitCalibration(points, rs, s.method);
    if (!cal) continue;
    await db.query(
      `insert into calibrations (source_id, metric, scale, offset_value, basis, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (source_id, metric) do update
         set scale = excluded.scale, offset_value = excluded.offset_value, basis = excluded.basis, updated_at = now()`,
      [s.source_id, metric, cal.scale, cal.offset, cal.basis],
    );
  }
}
