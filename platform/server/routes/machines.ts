// Machines, telemetry reads (track, timeline, counters, sensors), readings, sources, service, geofences.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { newPairingCode, sha256 } from '../auth.js';
import { assertCap, assertOwnerAdmin, can, hasBlock, loadVisibleMachine, locationVisible, visibleOrgIds, type UserPrincipal } from '../access.js';
import { bad, forbidden, HttpError, json, notFound, readJson } from '../http.js';
import { audit, finite, router, str, user, type Ctx } from '../core.js';
import { loadMachine, recomputeDirtyDays, refitCalibrations } from '../ingest.js';
import { oilLevelAnalysis, summarize, type Viewer } from '../state.js';
import { SENSORS } from '../domain/sensors.js';
import { forecast } from '../domain/service.js';
import { analyzeFuel } from '../domain/fuel.js';
import { workedArea } from '../domain/agro.js';
import { polygonArea, validRing } from '../domain/geodesy.js';
import { dtcText } from '../domain/j1939.js';
import type { Block } from '../domain/roles.js';
import { purgeMachines, TRASH_DAYS } from '../purge.js';

const CATEGORIES = new Set([
  'harvester', 'forwarder', 'skidder', 'timber_truck', 'tractor', 'combine', 'forage_harvester', 'sprayer',
  'excavator', 'loader', 'dozer', 'grader', 'roller', 'crane', 'telehandler', 'dump_truck', 'truck', 'drill', 'other',
]);

export const viewer = (u: UserPrincipal): Viewer => ({ org_id: u.org_id, blocks: u.blocks });

function needBlock(u: UserPrincipal, b: Block, what: string) {
  if (!hasBlock(u, b)) throw new HttpError(403, 'block_hidden', `Раздел «${what}» скрыт для вашей роли`);
}

export async function visibleMachineIds(c: Ctx, u: UserPrincipal, orgId?: string | null): Promise<string[]> {
  const orgs = await visibleOrgIds(c.db, u);
  const scope = orgId ? orgs.filter((o) => o === orgId) : orgs;
  const r = await c.db.query<{ id: string }>(`select id from machines where org_id = any($1::text[]) and not archived`, [scope]);
  const ids = r.rows.map((x) => x.id);
  return u.machine_ids ? ids.filter((id) => u.machine_ids!.includes(id)) : ids;
}

function range(c: Ctx, maxDays: number, defHours = 24) {
  const to = c.url.searchParams.get('to') ? Date.parse(c.url.searchParams.get('to')!) : Date.now();
  const from = c.url.searchParams.get('from') ? Date.parse(c.url.searchParams.get('from')!) : to - defHours * 3600e3;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw bad('bad_range', 'Неверный интервал времени');
  if (to - from > maxDays * 86400e3) throw bad('range_too_long', `Не более ${maxDays} суток за запрос`);
  return { from, to };
}

const decimate = <T,>(rows: T[], max: number): T[] => {
  const step = Math.max(1, Math.ceil(rows.length / max));
  return step === 1 ? rows : rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
};

// ---------------------------------------------------------------- machines

router.on('GET', '/api/machines', async (c) => {
  const u = user(c);
  const ids = await visibleMachineIds(c, u, c.url.searchParams.get('org_id'));
  // someone looks at the fleet: the live stand leaves its economy mode at the next report
  await c.db.query(`update stand_status set last_viewed_at = now() where last_viewed_at is null or last_viewed_at < now() - interval '30 seconds'`);
  return json({ machines: await summarize(c.db, ids, viewer(u)), now: Date.now() });
});

function machineFields(b: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  const name = str(b.name, 120);
  if (name) out.name = name;
  else if (!partial) throw bad('bad_name', 'Укажите название или гаражный номер');
  if (b.category !== undefined) {
    if (!CATEGORIES.has(b.category)) throw bad('bad_category', 'Неизвестная категория техники');
    out.category = b.category;
  } else if (!partial) out.category = 'other';
  for (const k of ['make', 'model'] as const) if (b[k] !== undefined) out[k] = str(b[k], 80);
  if (b.year !== undefined) {
    const y = b.year === null || b.year === '' ? null : Number(b.year);
    if (y !== null && (!Number.isInteger(y) || y < 1950 || y > 2100)) throw bad('bad_year', 'Неверный год выпуска');
    out.year = y;
  }
  if (b.chassis !== undefined) {
    if (b.chassis !== 'wheeled' && b.chassis !== 'tracked') throw bad('bad_chassis', 'Ходовая: колёсная или гусеничная');
    out.chassis = b.chassis;
  }
  if (b.rotating_upper !== undefined) out.rotating_upper = !!b.rotating_upper;
  for (const [k, lo, hi] of [['tank_l', 10, 20000], ['work_width_m', 0.5, 60]] as const) {
    if (b[k] === undefined) continue;
    const v = b[k] === null || b[k] === '' ? null : Number(b[k]);
    if (v !== null && (!Number.isFinite(v) || v < lo || v > hi)) throw bad('bad_' + k, 'Неверное значение');
    out[k] = v;
  }
  return out;
}

router.on('POST', '/api/machines', async (c) => {
  const u = user(c);
  const b = await readJson(c.req);
  const orgId = typeof b.org_id === 'string' ? b.org_id : u.org_id;
  await assertCap(c.db, u, 'machines.create', orgId, 'Добавлять технику могут администратор или диспетчер');
  const kind = (await c.db.query<any>(`select kind from orgs where id = $1`, [orgId])).rows[0]?.kind;
  if (kind !== 'customer') throw bad('bad_org', 'Технику добавляют в организацию-клиента (владельца техники)');
  const f = machineFields(b, false);
  const id = randomUUID();
  const cols = ['id', 'org_id', ...Object.keys(f)];
  const vals = [id, orgId, ...Object.values(f)];
  await c.db.query(`insert into machines (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
  await audit(c.db, u, 'machine_created', { id, name: f.name }, orgId);
  return json({ machine: (await summarize(c.db, [id], viewer(u)))[0] }, 201);
});

export async function avgDailyHours(db: Db, machineId: string): Promise<number | null> {
  const r = await db.query<any>(
    `with best as (
       select c.source_id from counters c where c.machine_id = $1 and c.metric = 'engine_hours'
          and c.t > now() - interval '30 days'
        group by c.source_id order by count(*) desc limit 1
     )
     select (max(value) - min(value))::float8 as dh,
            (extract(epoch from max(t) - min(t)) / 86400)::float8 as days
       from counters where source_id = (select source_id from best) and metric = 'engine_hours'
        and t > now() - interval '30 days'`,
    [machineId],
  );
  const row = r.rows[0];
  if (row?.dh === null || row?.dh === undefined || !row.days || row.days < 3) return null;
  return row.dh / Math.max(row.days, 1);
}

async function series(db: Db, machineId: string, key: string, from: number, to: number) {
  const r = await db.query<any>(
    `select (extract(epoch from t) * 1000)::float8 as t, value from sensor_readings
      where machine_id = $1 and key = $2 and t >= to_timestamp($3 / 1000.0) and t <= to_timestamp($4 / 1000.0) order by t`,
    [machineId, key, from, to],
  );
  return r.rows.map((x) => ({ t: Number(x.t), v: Number(x.value) }));
}

async function positionsBetween(db: Db, machineId: string, from: number, to: number) {
  const r = await db.query<any>(
    `select (extract(epoch from t) * 1000)::float8 as t, lat, lon, speed_kmh, course
       from positions where machine_id = $1 and t >= to_timestamp($2 / 1000.0) and t <= to_timestamp($3 / 1000.0) order by t`,
    [machineId, from, to],
  );
  return r.rows.map((p) => ({ t: Number(p.t), lat: p.lat as number, lon: p.lon as number, speed_kmh: p.speed_kmh as number | null, course: p.course as number | null }));
}

async function dayStart(db: Db, orgId: string): Promise<number> {
  const r = await db.query<any>(
    `select (extract(epoch from date_trunc('day', now() at time zone o.tz) at time zone o.tz) * 1000)::float8 as t from orgs o where o.id = $1`,
    [orgId],
  );
  return Number(r.rows[0]?.t ?? Date.now() - 86400e3);
}

router.on('GET', '/api/machines/:id', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  const [summary] = await summarize(c.db, [id], viewer(u));
  const items = hasBlock(u, 'service')
    ? await c.db.query<any>(
        `select id, item, interval_h, last_done_h, volume_l, product, (extract(epoch from last_done_at) * 1000)::float8 as last_done_at
           from service_items where machine_id = $1 order by item`,
        [id],
      )
    : { rows: [] as any[] };
  const avg = hasBlock(u, 'hours') ? await avgDailyHours(c.db, id) : null;
  const cals = hasBlock(u, 'hours') || hasBlock(u, 'mileage')
    ? await c.db.query<any>(
        `select c.source_id, c.metric, c.scale, c.offset_value, c.basis from calibrations c join sources s on s.id = c.source_id where s.machine_id = $1`,
        [id],
      )
    : { rows: [] as any[] };
  const conns = hasBlock(u, 'sources')
    ? await c.db.query<any>(
        `select s.id, s.kind, s.external_id, s.label, s.connector_id, k.label as connector_label, s.meta,
                (extract(epoch from s.enroll_expires_at) * 1000)::float8 as enroll_expires_at,
                (extract(epoch from s.last_seen_at) * 1000)::float8 as last_seen_at,
                s.token_hash is not null as paired
           from sources s left join connectors k on k.id = s.connector_id where s.machine_id = $1 order by s.created_at`,
        [id],
      )
    : { rows: [] as any[] };
  let fuel = null;
  if (hasBlock(u, 'fuel')) {
    const to = Date.now();
    const from = to - 7 * 86400e3;
    const lv = await series(c.db, id, 'fuel_level_l', from, to);
    if (lv.length) fuel = analyzeFuel(lv, await series(c.db, id, 'fuel_rate_lph', from, to), { tankL: summary?.tank_l });
  }
  let agro = null;
  if (hasBlock(u, 'agro') && summary?.work_width_m && locationVisible(u, m)) {
    const from = await dayStart(c.db, m.org_id);
    agro = {
      since: from,
      width_m: summary.work_width_m,
      ...workedArea(await positionsBetween(c.db, id, from, Date.now()), await series(c.db, id, 'implement_on', from - 3600e3, Date.now()), summary.work_width_m),
    };
  }
  return json({
    machine: summary,
    oil_level: hasBlock(u, 'oil') ? await oilLevelAnalysis(c.db, id) : null,
    service: hasBlock(u, 'service') ? forecast(items.rows, summary?.engine_hours?.value ?? null, avg) : [],
    avg_daily_hours: avg,
    calibrations: cals.rows,
    sources: conns.rows,
    fuel,
    agro,
  });
});

router.on('PATCH', '/api/machines/:id', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  const b = await readJson(c.req);
  if (b.location_enabled !== undefined) {
    assertOwnerAdmin(u, m.org_id);
    await c.db.query(`update machines set location_enabled = $2 where id = $1`, [id, !!b.location_enabled]);
    await audit(c.db, u, 'location_enabled', { machine: id, value: !!b.location_enabled }, m.org_id);
  }
  const f = machineFields(b, true);
  delete (f as any).location_enabled;
  if (Object.keys(f).length) {
    await assertCap(c.db, u, 'machines.edit', m.org_id, 'Карточку машины меняют администратор или диспетчер');
    const sets = Object.keys(f).map((k, i) => `${k} = $${i + 2}`);
    await c.db.query(`update machines set ${sets.join(', ')} where id = $1`, [id, ...Object.values(f)]);
    await audit(c.db, u, 'machine_updated', { machine: id, fields: Object.keys(f) }, m.org_id);
    if ('chassis' in f || 'rotating_upper' in f || 'category' in f) {
      await c.db.query(`update daily_stats set dirty = true where machine_id = $1`, [id]);
      const mr = await loadMachine(c.db, id);
      if (mr) await recomputeDirtyDays(c.db, mr, 60);
    }
  }
  return json({ machine: (await summarize(c.db, [id], viewer(u)))[0] });
});

router.on('DELETE', '/api/machines/:id', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  await assertCap(c.db, u, 'machines.delete', m.org_id, 'Удалять технику могут администраторы');
  await c.db.query(`update machines set archived = true, deleted_at = now(), deleted_by = $2, delete_batch = $3 where id = $1`, [id, u.id, randomUUID()]);
  await audit(c.db, u, 'machine_deleted', { machine: id, name: m.name }, m.org_id);
  return json({ ok: true, restore_days: TRASH_DAYS });
});

router.on('POST', '/api/machines/:id/restore', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id, { deleted: true });
  await assertCap(c.db, u, 'machines.delete', m.org_id);
  if (!m.archived) throw bad('not_deleted', 'Машина не в корзине');
  const r = await c.db.query<any>(`select o.deleted_at from orgs o where o.id = $1`, [m.org_id]);
  if (r.rows[0]?.deleted_at) throw bad('org_deleted', 'Машина удалена вместе с организацией — восстановите организацию');
  await c.db.query(`update machines set archived = false, deleted_at = null, deleted_by = null, delete_batch = null where id = $1`, [id]);
  await audit(c.db, u, 'machine_restored', { machine: id, name: m.name }, m.org_id);
  return json({ ok: true });
});

router.on('DELETE', '/api/machines/:id/purge', async (c, { id }) => {
  const u = user(c);
  if (!can(u, 'purge')) throw forbidden('Окончательно удаляет только суперадминистратор');
  const m = await loadVisibleMachine(c.db, u, id, { deleted: true });
  if (!m.archived) throw bad('not_deleted', 'Сначала переместите машину в корзину');
  if (u.is_demo && m.protected) throw forbidden('Демо-машину нельзя удалить окончательно из демо-доступа');
  const b = await readJson(c.req);
  if (String(b.confirm ?? '') !== m.name) throw bad('confirm', 'Для окончательного удаления введите точное название машины');
  await purgeMachines(c.db, [id]);
  await audit(c.db, u, 'machine_purged', { machine: id, name: m.name }, m.org_id);
  return json({ ok: true });
});

router.on('DELETE', '/api/machines/:id/positions', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  assertOwnerAdmin(u, m.org_id);
  const r = await c.db.query(`delete from positions where machine_id = $1`, [id]);
  await c.db.query(`update daily_stats set gnss_km = 0, transport_km = 0, points = 0, first_t = null, last_t = null where machine_id = $1`, [id]);
  await audit(c.db, u, 'positions_purged', { machine: id, rows: r.rowCount }, m.org_id);
  return json({ deleted: r.rowCount });
});

// ---------------------------------------------------------------- track, timeline, fleet at a moment

router.on('GET', '/api/machines/:id/track', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  needBlock(u, 'history', 'История');
  if (!locationVisible(u, m)) throw new HttpError(403, 'location_disabled', 'Местоположение этой машины недоступно');
  const { from, to } = range(c, 31);
  const rows = await positionsBetween(c.db, id, from, to);
  const points = decimate(rows, 5000).map((p) => [p.t, p.lat, p.lon, p.speed_kmh]);
  return json({ points, total: rows.length, decimated: points.length < rows.length });
});

/** Stops: the machine stayed within 50 m for at least 5 minutes. */
function findStops(pts: Array<{ t: number; lat: number; lon: number; speed_kmh: number | null }>) {
  const out: Array<{ from: number; to: number; lat: number; lon: number }> = [];
  let i = 0;
  const R = 6371008.8;
  const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const x = ((b.lon - a.lon) * Math.PI) / 180 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const y = ((b.lat - a.lat) * Math.PI) / 180;
    return Math.sqrt(x * x + y * y) * R;
  };
  while (i < pts.length) {
    let j = i;
    while (j + 1 < pts.length && dist(pts[i], pts[j + 1]) < 50 && (pts[j + 1].speed_kmh ?? 0) < 3) j++;
    if (pts[j].t - pts[i].t >= 5 * 60e3) {
      out.push({ from: pts[i].t, to: pts[j].t, lat: pts[i].lat, lon: pts[i].lon });
      i = j + 1;
    } else i++;
  }
  return out;
}

const TIMELINE_KEYS = ['rpm', 'engine_load_pct', 'coolant_temp_c', 'battery_v', 'fuel_level_l', 'fuel_level_pct', 'fuel_rate_lph', 'oil_pressure_kpa', 'oil_temp_c', 'implement_on'];

router.on('GET', '/api/machines/:id/timeline', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  needBlock(u, 'history', 'История');
  const { from, to } = range(c, 7);
  const loc = locationVisible(u, m);
  const pos = loc ? await positionsBetween(c.db, id, from, to) : [];
  const out: Record<string, Array<[number, number]>> = {};
  for (const key of TIMELINE_KEYS) {
    if (!hasBlock(u, SENSORS[key].block)) continue;
    const s = await series(c.db, id, key, from, to);
    if (s.length) out[key] = decimate(s, 4000).map((p) => [p.t, p.v]);
  }
  const counters: Record<string, Array<[number, number]>> = {};
  for (const [metric, block] of [['engine_hours', 'hours'], ['odometer_km', 'mileage']] as const) {
    if (!hasBlock(u, block)) continue;
    const r = await c.db.query<any>(
      `with best as (select source_id from counters where machine_id = $1 and metric = $2 and t >= to_timestamp($3 / 1000.0) and t <= to_timestamp($4 / 1000.0)
                      group by source_id order by count(*) desc limit 1)
       select (extract(epoch from t) * 1000)::float8 as t, value from counters
        where source_id = (select source_id from best) and metric = $2 and t >= to_timestamp($3 / 1000.0) and t <= to_timestamp($4 / 1000.0) order by t`,
      [id, metric, from, to],
    );
    if (r.rows.length) counters[metric] = decimate(r.rows, 3000).map((x) => [Number(x.t), Number(x.value)]);
  }
  const summary = (await summarize(c.db, [id], viewer(u)))[0];
  const fuelRaw = hasBlock(u, 'fuel') ? await series(c.db, id, 'fuel_level_l', from, to) : [];
  const faults = hasBlock(u, 'faults')
    ? (
        await c.db.query<any>(
          `select spn, fmi, min(t) as t0, max(t) as t1, max(oc) as oc, max(lamp) as lamp,
                  (extract(epoch from min(t)) * 1000)::float8 as first_t, (extract(epoch from max(t)) * 1000)::float8 as last_t
             from fault_events where machine_id = $1 and t >= to_timestamp($2 / 1000.0) and t <= to_timestamp($3 / 1000.0)
            group by spn, fmi order by min(t)`,
          [id, from, to],
        )
      ).rows.map((f) => ({ spn: f.spn, fmi: f.fmi, oc: f.oc, lamp: f.lamp, first_t: Number(f.first_t), last_t: Number(f.last_t), text: dtcText(f.spn, f.fmi) }))
    : null;
  const width = summary?.work_width_m;
  const implement = out.implement_on ? await series(c.db, id, 'implement_on', from - 3600e3, to) : [];
  return json({
    from,
    to,
    location: loc,
    positions: decimate(pos, 15000).map((p) => [p.t, p.lat, p.lon, p.speed_kmh, p.course]),
    total_positions: pos.length,
    stops: loc ? findStops(pos) : [],
    series: out,
    counters,
    fuel: fuelRaw.length ? analyzeFuel(fuelRaw, out.fuel_rate_lph?.map(([t, v]) => ({ t, v })) ?? [], { tankL: summary?.tank_l }) : null,
    faults,
    agro: hasBlock(u, 'agro') && width && loc && implement.length ? { width_m: width, ...workedArea(pos, implement, width) } : null,
  });
});

router.on('GET', '/api/machines/:id/track.gpx', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  needBlock(u, 'history', 'История');
  if (!locationVisible(u, m)) throw new HttpError(403, 'location_disabled', 'Местоположение этой машины недоступно');
  const { from, to } = range(c, 31);
  const pts = await positionsBetween(c.db, id, from, to);
  const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]!);
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ITles" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `<trk><name>${esc(m.name)}</name><trkseg>\n` +
    pts.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n') +
    `\n</trkseg></trk></gpx>\n`;
  await audit(c.db, u, 'track_exported', { machine: id, points: pts.length }, m.org_id);
  return new Response(body, {
    headers: {
      'content-type': 'application/gpx+xml; charset=utf-8',
      'content-disposition': `attachment; filename="track-${new Date(from).toISOString().slice(0, 10)}.gpx"`,
      'cache-control': 'no-store',
    },
  });
});

/** Where every visible machine was at moment t (last fix not older than 2 hours before t). */
router.on('GET', '/api/fleet/at', async (c) => {
  const u = user(c);
  needBlock(u, 'history', 'История');
  needBlock(u, 'map', 'Карта');
  const t = Date.parse(c.url.searchParams.get('t') ?? '');
  if (!Number.isFinite(t)) throw bad('bad_time', 'Укажите момент времени');
  const ids = await visibleMachineIds(c, u);
  if (!ids.length) return json({ t, machines: [] });
  const r = await c.db.query<any>(
    `select m.id, m.name, m.category, m.org_id, m.location_enabled, o.share_location_up, p.lat, p.lon, p.speed_kmh, p.course,
            (extract(epoch from p.t) * 1000)::float8 as pt
       from machines m join orgs o on o.id = m.org_id
       cross join lateral (select * from positions where machine_id = m.id and t <= to_timestamp($2 / 1000.0)
                             and t > to_timestamp($2 / 1000.0) - interval '2 hours' order by t desc limit 1) p
      where m.id = any($1::text[])`,
    [ids, t],
  );
  return json({
    t,
    machines: r.rows
      .filter((row) => locationVisible(u, row))
      .map((row) => ({ id: row.id, name: row.name, category: row.category, lat: row.lat, lon: row.lon, speed_kmh: row.speed_kmh, course: row.course, t: Number(row.pt) })),
  });
});

router.on('GET', '/api/machines/:id/daily', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  needBlock(u, 'reports', 'Сводки');
  const days = Math.min(366, Math.max(1, Number(c.url.searchParams.get('days') ?? 30)));
  const tz = (await c.db.query<any>(`select tz from orgs where id = $1`, [m.org_id])).rows[0].tz;
  const km = await c.db.query<any>(
    `select day::text as day, gnss_km, transport_km, points from daily_stats
      where machine_id = $1 and day > (now() at time zone $2)::date - $3::int order by day`,
    [id, tz, days],
  );
  const hours = await c.db.query<any>(
    `select (t at time zone $2)::date::text as day, source_id, (max(value) - min(value))::float8 as dh, count(*)::int as n
       from counters where machine_id = $1 and metric = 'engine_hours' and t > now() - ($3::int || ' days')::interval
      group by 1, 2`,
    [id, tz, days + 1],
  );
  const byDay = new Map<string, { dh: number; n: number }>();
  for (const h of hours.rows) {
    const prev = byDay.get(h.day);
    if (!prev || h.n > prev.n) byDay.set(h.day, { dh: h.dh, n: h.n });
  }
  const kmOk = m.location_enabled && hasBlock(u, 'mileage');
  const allDays = new Set([...km.rows.map((r) => r.day), ...byDay.keys()]);
  const out = [...allDays].sort().map((day) => {
    const k = km.rows.find((r) => r.day === day);
    return {
      day,
      gnss_km: kmOk ? (k?.gnss_km ?? 0) : null,
      transport_km: kmOk ? (k?.transport_km ?? 0) : null,
      points: k?.points ?? 0,
      engine_hours: hasBlock(u, 'hours') ? (byDay.get(day)?.dh ?? null) : null,
    };
  });
  return json({ days: out });
});

router.on('GET', '/api/machines/:id/counters', async (c, { id }) => {
  const u = user(c);
  await loadVisibleMachine(c.db, u, id);
  const metric = c.url.searchParams.get('metric') === 'odometer_km' ? 'odometer_km' : 'engine_hours';
  needBlock(u, metric === 'engine_hours' ? 'hours' : 'mileage', metric === 'engine_hours' ? 'Моточасы' : 'Пробег');
  const days = Math.min(366, Math.max(1, Number(c.url.searchParams.get('days') ?? 30)));
  const r = await c.db.query<any>(
    `select c.source_id, s.kind, c.method, (extract(epoch from c.t) * 1000)::float8 as t, c.value,
            coalesce(k.scale, 1) as scale, coalesce(k.offset_value, 0) as offset_value
       from counters c join sources s on s.id = c.source_id
       left join calibrations k on k.source_id = c.source_id and k.metric = c.metric
      where c.machine_id = $1 and c.metric = $2 and c.t > now() - ($3::int || ' days')::interval
      order by c.t`,
    [id, metric, days],
  );
  const byS: Record<string, any> = {};
  for (const row of r.rows) {
    const s = (byS[row.source_id] ??= { source_id: row.source_id, kind: row.kind, method: row.method, points: [] });
    s.points.push([Number(row.t), Number(row.value) * row.scale + row.offset_value]);
  }
  for (const s of Object.values(byS) as any[]) s.points = decimate(s.points, 2000);
  const readings = await c.db.query<any>(
    `select id, value, (extract(epoch from t) * 1000)::float8 as t, photo is not null as has_photo, entered_by
       from readings where machine_id = $1 and metric = $2 order by t desc limit 200`,
    [id, metric],
  );
  return json({ metric, series: Object.values(byS), readings: readings.rows });
});

router.on('GET', '/api/machines/:id/sensors', async (c, { id }) => {
  const u = user(c);
  await loadVisibleMachine(c.db, u, id);
  const key = c.url.searchParams.get('key') ?? 'oil_level_pct';
  if (!SENSORS[key]) throw bad('bad_key', 'Неизвестный показатель');
  needBlock(u, SENSORS[key].block, SENSORS[key].label);
  const days = Math.min(366, Math.max(1, Number(c.url.searchParams.get('days') ?? 30)));
  const r = await c.db.query<any>(
    `select (extract(epoch from t) * 1000)::float8 as t, value from sensor_readings
      where machine_id = $1 and key = $2 and t > now() - ($3::int || ' days')::interval order by t`,
    [id, key, days],
  );
  const points = decimate(r.rows, 1500).map((x) => [Number(x.t), Number(x.value)]);
  return json({ key, points, total: r.rows.length });
});

router.on('GET', '/api/oil/overview', async (c) => {
  const u = user(c);
  needBlock(u, 'oil', 'Масло');
  const ids = await visibleMachineIds(c, u, c.url.searchParams.get('org_id'));
  const machines = (await summarize(c.db, ids, viewer(u))).filter((m) => m.oil);
  const rows = [];
  for (const m of machines) {
    const lv = m.oil!.values.oil_level_pct ? await oilLevelAnalysis(c.db, m.id) : null;
    rows.push({
      id: m.id, name: m.name, org_name: m.org_name, category: m.category, engine_hours: m.engine_hours?.value ?? null,
      oil: m.oil, topups_30d: lv?.topups.length ?? null, consumption_pct_per_100h: lv?.consumption_pct_per_100h ?? null,
    });
  }
  const rank = { crit: 0, warn: 1, ok: 2 } as Record<string, number>;
  rows.sort((a, b) => (rank[a.oil!.status ?? 'ok'] ?? 3) - (rank[b.oil!.status ?? 'ok'] ?? 3) || a.name.localeCompare(b.name));
  return json({ machines: rows, sensors: SENSORS });
});

// ---------------------------------------------------------------- meter readings

router.on('POST', '/api/machines/:id/readings', async (c, { id }) => {
  const u = user(c);
  await loadVisibleMachine(c.db, u, id);
  if (!can(u, 'readings.enter')) throw forbidden('Вносить показания счётчика может механик, оператор, диспетчер или администратор');
  const b = await readJson(c.req, 3_000_000);
  const metric = b.metric === 'odometer_km' ? 'odometer_km' : 'engine_hours';
  const value = finite(b.value);
  if (value === null || value < 0 || value > (metric === 'engine_hours' ? 300000 : 10_000_000)) throw bad('bad_value', 'Неверное показание счётчика');
  const t = b.t ? Date.parse(b.t) : Date.now();
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60e3) throw bad('bad_time', 'Неверное время показания');
  const photo = typeof b.photo === 'string' && b.photo.startsWith('data:image/') ? b.photo : null;
  const prev = await c.db.query<any>(
    `select value from readings where machine_id = $1 and metric = $2 and t <= to_timestamp($3 / 1000.0) order by t desc limit 1`,
    [id, metric, t],
  );
  if (prev.rows[0] && value < Number(prev.rows[0].value) && !b.confirm_decrease)
    throw new HttpError(409, 'decrease', `Показание меньше предыдущего (${prev.rows[0].value}). Если счётчик заменён, подтвердите.`);
  const rid = randomUUID();
  await c.db.query(
    `insert into readings (id, machine_id, metric, value, t, photo, entered_by) values ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)`,
    [rid, id, metric, value, t, photo, u.id],
  );
  await refitCalibrations(c.db, id, metric);
  return json({ id: rid, machine: (await summarize(c.db, [id], viewer(u)))[0] }, 201);
});

router.on('DELETE', '/api/readings/:id', async (c, { id }) => {
  const u = user(c);
  const r = (await c.db.query<any>(`select machine_id, metric from readings where id = $1`, [id])).rows[0];
  if (!r) throw notFound();
  const m = await loadVisibleMachine(c.db, u, r.machine_id);
  if (!can(u, 'machines.edit') && !can(u, 'service.manage')) throw forbidden();
  await assertCap(c.db, u, can(u, 'machines.edit') ? 'machines.edit' : 'service.manage', m.org_id);
  await c.db.query(`delete from readings where id = $1`, [id]);
  await refitCalibrations(c.db, r.machine_id, r.metric);
  await audit(c.db, u, 'reading_deleted', { machine: r.machine_id, metric: r.metric }, m.org_id);
  return json({ ok: true });
});

router.on('GET', '/api/readings/:id/photo', async (c, { id }) => {
  const u = user(c);
  const r = (await c.db.query<any>(`select machine_id, photo from readings where id = $1`, [id])).rows[0];
  if (!r?.photo) throw notFound();
  await loadVisibleMachine(c.db, u, r.machine_id);
  if (!hasBlock(u, 'hours') && !hasBlock(u, 'mileage')) throw forbidden();
  const [, mime, b64] = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(r.photo) ?? [];
  if (!mime) throw notFound();
  return new Response(Buffer.from(b64, 'base64'), { headers: { 'content-type': mime, 'cache-control': 'private, max-age=86400' } });
});

// ---------------------------------------------------------------- data sources

/** Traccar Client identifier: long enough not to be guessed, short enough to type on a phone. */
export const newOsmandId = () => {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = randomBytes(12);
  let s = '';
  for (const x of b) s += a[x % a.length];
  return `itl-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
};

router.on('POST', '/api/machines/:id/sources', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  await assertCap(c.db, u, 'sources.manage', m.org_id, 'Подключать источники могут администратор, диспетчер или сервисный инженер');
  const b = await readJson(c.req);
  const sid = randomUUID();
  if (b.kind === 'phone') {
    const code = newPairingCode();
    await c.db.query(
      `insert into sources (id, org_id, machine_id, kind, label, enroll_code_hash, enroll_expires_at)
       values ($1, $2, $3, 'phone', $4, $5, now() + interval '24 hours')`,
      [sid, m.org_id, id, str(b.label, 80) ?? 'Телефон в кабине', sha256('pair:' + code)],
    );
    await audit(c.db, u, 'source_added', { machine: id, kind: 'phone' }, m.org_id);
    return json({ source_id: sid, pairing_code: code, expires_in_hours: 24 }, 201);
  }
  if (b.kind === 'osmand') {
    const ext = newOsmandId();
    await c.db.query(`insert into sources (id, org_id, machine_id, kind, external_id, label) values ($1, $2, $3, 'osmand', $4, $5)`, [
      sid,
      m.org_id,
      id,
      ext,
      str(b.label, 80) ?? 'Traccar Client',
    ]);
    await audit(c.db, u, 'source_added', { machine: id, kind: 'osmand' }, m.org_id);
    return json({ source_id: sid, device_id: ext, server_url: `${c.url.origin}/api/osmand` }, 201);
  }
  if (b.kind === 'tracker') {
    const ext = String(b.external_id ?? '').replace(/\s/g, '');
    if (!/^\d{5,20}$/.test(ext)) throw bad('bad_imei', 'Укажите IMEI (15 цифр) или идентификатор терминала');
    const dup = await c.db.query(`select machine_id from sources where kind = 'tracker' and external_id = $1`, [ext]);
    if (dup.rows.length) throw new HttpError(409, 'imei_taken', 'Этот трекер уже привязан к другой машине');
    const meta = b.meta && typeof b.meta === 'object' ? { model: str(b.meta.model, 80), protocol: str(b.meta.protocol, 40), path: str(b.meta.path, 120) } : null;
    await c.db.query(`insert into sources (id, org_id, machine_id, kind, external_id, label, meta) values ($1, $2, $3, 'tracker', $4, $5, $6)`, [
      sid,
      m.org_id,
      id,
      ext,
      str(b.label, 80) ?? 'Трекер',
      meta ? JSON.stringify(meta) : null,
    ]);
    await audit(c.db, u, 'source_added', { machine: id, kind: 'tracker', imei_tail: ext.slice(-4) }, m.org_id);
    return json({ source_id: sid, external_id: ext }, 201);
  }
  throw bad('bad_kind', 'Тип источника: phone, osmand или tracker (платформы подключаются через раздел «Подключения»)');
});

router.on('POST', '/api/sources/:id/pairing', async (c, { id }) => {
  const u = user(c);
  const s = (await c.db.query<any>(`select machine_id, kind from sources where id = $1`, [id])).rows[0];
  if (!s || s.kind !== 'phone') throw notFound();
  const m = await loadVisibleMachine(c.db, u, s.machine_id);
  await assertCap(c.db, u, 'sources.manage', m.org_id);
  const code = newPairingCode();
  await c.db.query(
    `update sources set enroll_code_hash = $2, enroll_expires_at = now() + interval '24 hours', token_hash = null where id = $1`,
    [id, sha256('pair:' + code)],
  );
  return json({ pairing_code: code, expires_in_hours: 24 });
});

router.on('DELETE', '/api/sources/:id', async (c, { id }) => {
  const u = user(c);
  const s = (await c.db.query<any>(`select machine_id, kind from sources where id = $1`, [id])).rows[0];
  if (!s) throw notFound();
  const m = await loadVisibleMachine(c.db, u, s.machine_id);
  await assertCap(c.db, u, 'sources.manage', m.org_id);
  // data already received stays with the machine; the source just stops being accepted
  await c.db.query(
    `update sources set token_hash = null, enroll_code_hash = null,
            external_id = case when kind in ('tracker', 'osmand') then null else external_id end,
            label = coalesce(label, '') || ' (отключён)' where id = $1`,
    [id],
  );
  await audit(c.db, u, 'source_disabled', { machine: s.machine_id, kind: s.kind }, m.org_id);
  return json({ ok: true });
});

// ---------------------------------------------------------------- service (oil changes)

router.on('POST', '/api/machines/:id/service', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  await assertCap(c.db, u, 'service.manage', m.org_id, 'План ТО ведут механик, сервисный инженер или администратор');
  const b = await readJson(c.req);
  const item = str(b.item, 80);
  const interval = finite(b.interval_h);
  if (!item || interval === null || interval <= 0 || interval > 20000) throw bad('bad_item', 'Укажите узел и интервал в моточасах');
  const sid = randomUUID();
  await c.db.query(
    `insert into service_items (id, machine_id, item, interval_h, last_done_h, volume_l, product) values ($1,$2,$3,$4,$5,$6,$7)`,
    [sid, id, item, interval, finite(b.last_done_h) ?? 0, finite(b.volume_l), str(b.product, 120)],
  );
  return json({ id: sid }, 201);
});

async function serviceItem(c: Ctx, u: UserPrincipal, id: string) {
  const it = (await c.db.query<any>(`select machine_id from service_items where id = $1`, [id])).rows[0];
  if (!it) throw notFound();
  const m = await loadVisibleMachine(c.db, u, it.machine_id);
  await assertCap(c.db, u, 'service.manage', m.org_id, 'План ТО ведут механик, сервисный инженер или администратор');
  return { it, m };
}

router.on('PATCH', '/api/service/:id', async (c, { id }) => {
  const u = user(c);
  await serviceItem(c, u, id);
  const b = await readJson(c.req);
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries({
    item: str(b.item, 80),
    interval_h: finite(b.interval_h),
    last_done_h: finite(b.last_done_h),
    volume_l: finite(b.volume_l),
    product: str(b.product, 120),
  })) {
    if (b[k] === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (sets.length) await c.db.query(`update service_items set ${sets.join(', ')} where id = $1`, vals);
  return json({ ok: true });
});

router.on('DELETE', '/api/service/:id', async (c, { id }) => {
  const u = user(c);
  await serviceItem(c, u, id);
  await c.db.query(`delete from service_items where id = $1`, [id]);
  return json({ ok: true });
});

router.on('POST', '/api/service/:id/done', async (c, { id }) => {
  const u = user(c);
  const { it } = await serviceItem(c, u, id);
  const b = await readJson(c.req);
  let at = finite(b.at_h);
  if (at === null) at = (await summarize(c.db, [it.machine_id], { org_id: u.org_id, blocks: ['hours'] }))[0]?.engine_hours?.value ?? null;
  if (at === null) throw bad('no_hours', 'Моточасы машины неизвестны — укажите их явно');
  await c.db.query(`update service_items set last_done_h = $2, last_done_at = now() where id = $1`, [id, at]);
  return json({ ok: true, last_done_h: at });
});

router.on('GET', '/api/service/overview', async (c) => {
  const u = user(c);
  needBlock(u, 'service', 'Обслуживание');
  const ids = await visibleMachineIds(c, u, c.url.searchParams.get('org_id'));
  const machines = await summarize(c.db, ids, { org_id: u.org_id, blocks: ['hours', 'service'] });
  const items = ids.length
    ? await c.db.query<any>(`select id, machine_id, item, interval_h, last_done_h, volume_l, product from service_items where machine_id = any($1::text[])`, [ids])
    : { rows: [] as any[] };
  const out: any[] = [];
  for (const m of machines) {
    const its = items.rows.filter((i) => i.machine_id === m.id);
    if (!its.length) continue;
    const avg = await avgDailyHours(c.db, m.id);
    for (const f of forecast(its, m.engine_hours?.value ?? null, avg))
      out.push({ machine_id: m.id, machine: m.name, org_id: m.org_id, org: m.org_name, hours: m.engine_hours?.value ?? null, ...f });
  }
  out.sort((a, b) => (a.remaining_h ?? 1e9) - (b.remaining_h ?? 1e9));
  return json({ items: out });
});

// ---------------------------------------------------------------- geofences

const GEOFENCE_KINDS = new Set(['field', 'forest', 'quarry', 'site', 'base', 'other']);

router.on('GET', '/api/geofences', async (c) => {
  const u = user(c);
  needBlock(u, 'map', 'Карта');
  const orgs = await visibleOrgIds(c.db, u);
  const r = await c.db.query<any>(
    `select g.id, g.org_id, o.name as org_name, g.name, g.kind, g.geometry, g.area_ha from geofences g join orgs o on o.id = g.org_id
      where g.org_id = any($1::text[]) order by g.name`,
    [orgs],
  );
  return json({ geofences: r.rows });
});

router.on('POST', '/api/geofences', async (c) => {
  const u = user(c);
  const b = await readJson(c.req);
  const orgId = typeof b.org_id === 'string' ? b.org_id : u.org_id;
  await assertCap(c.db, u, 'machines.edit', orgId, 'Геозоны создают администратор или диспетчер');
  const name = str(b.name, 120);
  if (!name) throw bad('bad_name', 'Укажите название зоны');
  if (!validRing(b.ring)) throw bad('bad_ring', 'Контур: не менее 3 точек [долгота, широта]');
  const ring = (b.ring as Array<[number, number]>).map(([lon, lat]) => [Number(lon), Number(lat)] as [number, number]);
  const closed = ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? ring : [...ring, ring[0]];
  const { areaM2 } = polygonArea(closed);
  const id = randomUUID();
  const kind = GEOFENCE_KINDS.has(b.kind) ? b.kind : 'other';
  await c.db.query(`insert into geofences (id, org_id, name, kind, geometry, area_ha, created_by) values ($1,$2,$3,$4,$5,$6,$7)`, [
    id,
    orgId,
    name,
    kind,
    JSON.stringify({ type: 'Polygon', coordinates: [closed] }),
    areaM2 / 1e4,
    u.id,
  ]);
  await audit(c.db, u, 'geofence_created', { id, name, area_ha: Math.round(areaM2 / 100) / 100 }, orgId);
  return json({ id, area_ha: areaM2 / 1e4 }, 201);
});

router.on('DELETE', '/api/geofences/:id', async (c, { id }) => {
  const u = user(c);
  const g = (await c.db.query<any>(`select org_id, name from geofences where id = $1`, [id])).rows[0];
  if (!g) throw notFound();
  await assertCap(c.db, u, 'machines.edit', g.org_id);
  await c.db.query(`delete from geofences where id = $1`, [id]);
  await audit(c.db, u, 'geofence_deleted', { id, name: g.name }, g.org_id);
  return json({ ok: true });
});
