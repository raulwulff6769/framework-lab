// Data intake: phone in the cab (device token), Traccar Client (OsmAnd protocol) and TCP gateways.
import { sha256 } from '../auth.js';
import { bad, forbidden, HttpError, json, notFound, readJson } from '../http.js';
import { device, finite, router } from '../core.js';
import type { Db } from '../db.js';
import { ingestForSource, refitCalibrations, type IngestRecord } from '../ingest.js';
import { newToken } from '../auth.js';
import { randomUUID } from 'node:crypto';

router.on('POST', '/api/devices/enroll', async (c) => {
  const b = await readJson(c.req);
  const code = String(b.code ?? '').replace(/\D/g, '');
  if (code.length !== 6) throw bad('bad_code', 'Код — 6 цифр');
  const token = newToken();
  const s = await c.db.tx(async (db) => {
    const r = await db.query<any>(`select id, machine_id from sources where enroll_code_hash = $1 and enroll_expires_at > now() for update`, [
      sha256('pair:' + code),
    ]);
    if (!r.rows[0]) throw bad('bad_code', 'Код неверный или истёк. Получите новый код на странице машины');
    await db.query(`update sources set token_hash = $2, enroll_code_hash = null, enroll_expires_at = null where id = $1`, [r.rows[0].id, sha256(token)]);
    return r.rows[0];
  });
  return json({ token, config: await deviceConfig(c.db, s.id) }, 201);
});

export async function deviceConfig(db: Db, sourceId: string) {
  const r = await db.query<any>(
    `select s.id as source_id, m.id, m.name, m.category, m.chassis, m.rotating_upper, m.location_enabled, m.archived
       from sources s join machines m on m.id = s.machine_id where s.id = $1`,
    [sourceId],
  );
  const row = r.rows[0];
  if (!row) throw notFound();
  return {
    source_id: row.source_id,
    machine: { id: row.id, name: row.name, category: row.category, chassis: row.chassis, rotating_upper: row.rotating_upper },
    location_enabled: row.location_enabled && !row.archived,
    server_time: Date.now(),
  };
}

router.on('GET', '/api/devices/me', async (c) => json(await deviceConfig(c.db, device(c).source_id)));

/** Dashboard meter reading taken in the cab (photo + number), sent with the device token. */
router.on('POST', '/api/devices/reading', async (c) => {
  const d = device(c);
  if (!d.machine_id) throw bad('not_assigned', 'Телефон не привязан к машине');
  const b = await readJson(c.req, 3_000_000);
  const metric = b.metric === 'odometer_km' ? 'odometer_km' : 'engine_hours';
  const value = finite(b.value);
  if (value === null || value < 0 || value > (metric === 'engine_hours' ? 300000 : 10_000_000)) throw bad('bad_value', 'Неверное показание');
  const t = b.t ? Date.parse(b.t) : Date.now();
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60e3) throw bad('bad_time', 'Неверное время показания');
  const prev = await c.db.query<any>(
    `select value from readings where machine_id = $1 and metric = $2 and t <= to_timestamp($3 / 1000.0) order by t desc limit 1`,
    [d.machine_id, metric, t],
  );
  if (prev.rows[0] && value < Number(prev.rows[0].value) && !b.confirm_decrease)
    throw new HttpError(409, 'decrease', `Показание меньше предыдущего (${prev.rows[0].value}). Если счётчик заменён, подтвердите.`);
  const rid = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
  const photo = typeof b.photo === 'string' && b.photo.startsWith('data:image/') ? b.photo : null;
  const r = await c.db.query(
    `insert into readings (id, machine_id, metric, value, t, photo, source_id) values ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)
     on conflict (id) do nothing`,
    [rid, d.machine_id, metric, value, t, photo, d.source_id],
  );
  if (r.rowCount) await refitCalibrations(c.db, d.machine_id, metric);
  return json({ id: rid, duplicate: r.rowCount === 0 }, 201);
});

router.on('POST', '/api/ingest', async (c) => {
  if (!c.p) throw new HttpError(401, 'unauthorized');
  const b = await readJson(c.req, 10_000_000);
  const records: any[] = Array.isArray(b.records) ? b.records : [];
  if (records.length > 20000) throw new HttpError(413, 'too_many', 'Не более 20000 записей за запрос');
  if (c.p.kind === 'device') {
    const s = (await c.db.query<any>(`select id, machine_id, org_id, kind from sources where id = $1`, [c.p.source_id])).rows[0];
    const res = await ingestForSource(c.db, s, records as IngestRecord[]);
    return json({ ...res, config: await deviceConfig(c.db, s.id) });
  }
  if (c.p.kind === 'gateway') {
    // records carry the tracker id; unknown ids are reported so the gateway keeps them queued
    const byExt = new Map<string, Array<{ i: number; r: any }>>();
    records.forEach((r, i) => {
      const ext = String(r?.ext_id ?? '');
      if (!byExt.has(ext)) byExt.set(ext, []);
      byExt.get(ext)!.push({ i, r });
    });
    const results: any[] = [];
    for (const [ext, list] of byExt) {
      const s = (await c.db.query<any>(`select id, machine_id, org_id, kind from sources where kind = 'tracker' and external_id = $1`, [ext])).rows[0];
      if (!s || !s.machine_id) {
        results.push({ ext_id: ext, status: 'unknown_device', indexes: list.map((x) => x.i) });
        continue;
      }
      const res = await ingestForSource(c.db, s, list.map((x) => x.r));
      results.push({ ext_id: ext, status: 'ok', ...res, rejected: res.rejected.map((x) => ({ index: list[x.index].i, reason: x.reason })) });
    }
    return json({ results });
  }
  throw forbidden();
});

// ---------------------------------------------------------------- Traccar Client (OsmAnd protocol)

const KNOT = 1.852;

/** Unix seconds or milliseconds, ISO 8601, or "yyyy-MM-dd HH:mm:ss" (UTC), as Traccar accepts. */
export function osmandTime(v: string | null | undefined): number {
  if (!v) return Date.now();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n < 2147483647 ? n * 1000 : n;
  }
  const t = Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : NaN;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One OsmAnd request → id + ingest record. Speed: knots in the query form, m/s in the JSON form. */
export function parseOsmand(contentType: string, query: URLSearchParams, body: string): Array<{ id: string; rec: IngestRecord }> {
  // Traccar decides by content type; an empty JSON body still carries the fix in the query string
  if (contentType.startsWith('application/json') && body.trim()) {
    const root = JSON.parse(body || '{}');
    const id = String(root.device_id ?? '');
    const locs = Array.isArray(root.location) ? root.location : [root.location];
    return locs
      .filter((l: any) => l && typeof l === 'object')
      .map((l: any) => {
        const c = l.coords ?? {};
        const speed = numOrNull(c.speed);
        const heading = numOrNull(c.heading);
        const rec: IngestRecord = {
          t: osmandTime(String(l.timestamp ?? '')),
          lat: numOrNull(c.latitude),
          lon: numOrNull(c.longitude),
          speed_kmh: speed !== null && speed >= 0 ? speed * 3.6 : null,
          course: heading !== null && heading >= 0 ? heading : null,
          alt: numOrNull(c.altitude),
          acc_m: numOrNull(c.accuracy),
        };
        return { id, rec };
      });
  }
  const p = new URLSearchParams(query);
  if (![...p.keys()].length && body) for (const [k, v] of new URLSearchParams(body)) p.append(k, v);
  const id = p.get('id') ?? p.get('deviceid') ?? '';
  let lat = numOrNull(p.get('lat'));
  let lon = numOrNull(p.get('lon'));
  const loc = p.get('location');
  if ((lat === null || lon === null) && loc?.includes(',')) [lat, lon] = loc.split(',').map((x) => numOrNull(x)) as [number | null, number | null];
  const speed = numOrNull(p.get('speed'));
  const valid = p.get('valid');
  const rec: IngestRecord = {
    t: osmandTime(p.get('timestamp')),
    lat: valid === 'false' || valid === '0' ? null : lat,
    lon: valid === 'false' || valid === '0' ? null : lon,
    speed_kmh: speed !== null && speed >= 0 ? speed * KNOT : null,
    course: numOrNull(p.get('bearing') ?? p.get('heading')),
    alt: numOrNull(p.get('altitude')),
    acc_m: numOrNull(p.get('accuracy')),
    hdop: numOrNull(p.get('hdop')),
  };
  return [{ id, rec }];
}

async function osmand(c: import('../core.js').Ctx) {
  const body = c.req.method === 'POST' ? await c.req.text() : '';
  let items;
  try {
    items = parseOsmand(c.req.headers.get('content-type') ?? '', c.url.searchParams, body);
  } catch {
    throw bad('invalid_request', 'Неверный формат OsmAnd');
  }
  const id = items[0]?.id;
  if (!id) throw bad('no_id', 'Нет идентификатора устройства (id)');
  const s = (await c.db.query<any>(`select id, machine_id, org_id, kind from sources where kind = 'osmand' and external_id = $1`, [id])).rows[0];
  // not found → the client keeps the point in its buffer and retries (Traccar answers the same way)
  if (!s) return json({ error: 'unknown_device', message: 'Устройство с таким идентификатором не подключено' }, 404);
  const res = await ingestForSource(c.db, s, items.map((x) => x.rec));
  if (res.rejected.length && res.rejected.length === items.length && res.rejected[0].reason !== 'machine_deleted')
    return json({ error: 'rejected', rejected: res.rejected }, 400);
  return json({ ok: true, positions: res.positions, duplicates: res.duplicates, location_dropped: res.location_dropped });
}

router.on('GET', '/api/osmand', osmand);
router.on('POST', '/api/osmand', osmand);
