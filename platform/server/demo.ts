// Demo tenant: organisations, one account per role, machines with tracker sources, geofences and
// service plans from demo-fleet.json. Idempotent: the nightly cron runs it to bring back whatever
// demo visitors deleted or changed. Telemetry comes from the live stand, not from here.
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { hashPassword } from './auth.js';
import { polygonArea } from './domain/geodesy.js';
import { restoreBatch } from './purge.js';
import fleet from './demo-fleet.json';

export const DEMO = fleet;
export const demoSourceId = (machineId: string) => `${machineId}-src`;

const SERVICE = [
  { item: 'Моторное масло', interval_h: 500, volume_l: 32, product: 'FUCHS TITAN CARGO MAXX 10W-40' },
  { item: 'Гидравлическое масло', interval_h: 2000, volume_l: 180, product: 'FUCHS RENOLIN B 46 HVI' },
  { item: 'Трансмиссионное масло', interval_h: 1000, volume_l: 60, product: 'FUCHS TITAN UNIVERSAL HD 80W-90' },
];

export async function ensureDemoTenant(db: Db): Promise<{ orgs: number; users: number; machines: number; skipped: string[] }> {
  const skipped: string[] = [];
  // bring back everything deleted together with a demo organisation, then single rows
  const batches = await db.query<{ b: string }>(`select distinct delete_batch as b from orgs where is_demo and protected and delete_batch is not null`);
  for (const { b } of batches.rows) await restoreBatch(db, b);
  for (const o of fleet.orgs) {
    await db.query(
      `insert into orgs (id, kind, name, parent_id, tz, is_demo, protected) values ($1, $2, $3, $4, $5, true, true)
       on conflict (id) do update set name = excluded.name, parent_id = excluded.parent_id, is_demo = true, protected = true,
         deleted_at = null, deleted_by = null, delete_batch = null`,
      [o.id, o.kind, o.name, o.parent, o.tz],
    );
  }
  for (const m of fleet.machines) {
    await db.query(
      `insert into machines (id, org_id, name, category, make, model, year, chassis, rotating_upper, tank_l, work_width_m, protected)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
       on conflict (id) do update set org_id = excluded.org_id, name = excluded.name, category = excluded.category, make = excluded.make,
         model = excluded.model, year = excluded.year, chassis = excluded.chassis, rotating_upper = excluded.rotating_upper,
         tank_l = excluded.tank_l, work_width_m = excluded.work_width_m, protected = true, archived = false,
         deleted_at = null, deleted_by = null, delete_batch = null, location_enabled = true`,
      [m.id, m.org, m.name, m.category, m.make, m.model, m.year, m.chassis, m.rotating_upper, m.tank_l, m.work_width_m],
    );
    if (m.tracker.path !== 'traccar') {
      const meta = JSON.stringify({ model: m.tracker.model, protocol: m.tracker.protocol, path: m.tracker.path, can: m.tracker.can, fuel_sensor: m.tracker.fuel_sensor });
      const taken = await db.query<{ id: string }>(`select id from sources where kind = 'tracker' and external_id = $1 and id <> $2`, [m.tracker.imei, demoSourceId(m.id)]);
      if (taken.rows.length) {
        skipped.push(`${m.name}: IMEI уже привязан к другой машине`);
      } else {
        await db.query(
          `insert into sources (id, org_id, machine_id, kind, external_id, label, meta) values ($1, $2, $3, 'tracker', $4, $5, $6)
           on conflict (id) do update set machine_id = excluded.machine_id, org_id = excluded.org_id, external_id = excluded.external_id,
             label = excluded.label, meta = excluded.meta`,
          [demoSourceId(m.id), m.org, m.id, m.tracker.imei, m.tracker.model, meta],
        );
      }
    }
    const has = await db.query(`select 1 from service_items where machine_id = $1 limit 1`, [m.id]);
    if (!has.rows.length)
      for (const [i, s] of SERVICE.entries())
        await db.query(
          `insert into service_items (id, machine_id, item, interval_h, last_done_h, volume_l, product) values ($1, $2, $3, $4, 0, $5, $6)`,
          [`${m.id}-svc${i}`, m.id, s.item, s.interval_h, s.volume_l, s.product],
        );
  }
  for (const u of fleet.users) {
    const found = await db.query<{ id: string; org_id: string }>(`select id, org_id from users where login = $1`, [u.login]);
    const machines = (u as { machines?: string[] }).machines ?? null;
    if (found.rows[0] && !fleet.orgs.some((o) => o.id === found.rows[0].org_id)) {
      skipped.push(`${u.login}: логин занят вне демо`);
      continue;
    }
    if (!found.rows[0]) {
      await db.query(
        `insert into users (id, org_id, login, pass_hash, role, label, protected, machine_ids) values ($1, $2, $3, $4, $5, $6, true, $7)`,
        [`demo-u-${u.login}`, u.org, u.login, await hashPassword(randomBytes(24).toString('base64url')), u.role, u.label, machines],
      );
    } else {
      await db.query(
        `update users set org_id = $2, role = $3, label = $4, protected = true, disabled = false, deleted_at = null, deleted_by = null,
                delete_batch = null, blocks = '{}', machine_ids = $5 where id = $1`,
        [found.rows[0].id, u.org, u.role, u.label, machines],
      );
    }
  }
  for (const g of fleet.geofences) {
    const ring = g.ring as Array<[number, number]>;
    await db.query(
      `insert into geofences (id, org_id, name, kind, geometry, area_ha) values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set name = excluded.name, kind = excluded.kind, geometry = excluded.geometry, area_ha = excluded.area_ha`,
      [g.id, g.org, g.name, g.kind, JSON.stringify({ type: 'Polygon', coordinates: [ring] }), polygonArea(ring).areaM2 / 1e4],
    );
  }
  await db.query(`insert into settings (key, value) values ('demo_login', '{"enabled": true}') on conflict (key) do nothing`);
  return { orgs: fleet.orgs.length, users: fleet.users.length, machines: fleet.machines.length, skipped };
}

/** Keeps the free database tier small: demo telemetry older than `days` is removed. */
export async function pruneDemoTelemetry(db: Db, days = 35): Promise<number> {
  let n = 0;
  for (const t of ['positions', 'counters', 'sensor_readings', 'fault_events']) {
    const r = await db.query(
      `delete from ${t} where machine_id in (select m.id from machines m join orgs o on o.id = m.org_id where o.is_demo)
          and t < now() - ($1::int || ' days')::interval`,
      [days],
    );
    n += r.rowCount;
  }
  return n;
}
