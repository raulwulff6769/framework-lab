// Monitoring platforms (Wialon, Traccar, ISO 15143-3), near-real-time refresh and the daily cron.
import { randomUUID } from 'node:crypto';
import { assertCap, assertOrgVisible, can, hasBlock, visibleOrgIds } from '../access.js';
import { bad, forbidden, HttpError, json, notFound, readJson } from '../http.js';
import { audit, router, str, user } from '../core.js';
import { encryptSecret } from '../secrets.js';
import { fetchUnits, syncConnector } from '../connectors/sync.js';
import { wialonLoginUrl } from '../connectors/wialon.js';
import { ConnectorError } from '../connectors/types.js';
import { loadMachine, recomputeDirtyDays } from '../ingest.js';
import { purgeExpired } from '../purge.js';
import { ensureDemoTenant, pruneDemoTelemetry } from '../demo.js';

router.on('GET', '/api/connectors', async (c) => {
  const u = user(c);
  if (!can(u, 'connectors.manage') && !hasBlock(u, 'sources')) throw forbidden('Подключения скрыты для вашей роли');
  const orgs = await visibleOrgIds(c.db, u);
  const r = await c.db.query<any>(
    `select k.id, k.org_id, o.name as org_name, k.kind, k.label, k.base_url, k.status, k.last_error,
            (extract(epoch from k.last_sync_at) * 1000)::float8 as last_sync_at,
            (select count(*)::int from sources s where s.connector_id = k.id) as units
       from connectors k join orgs o on o.id = k.org_id where k.org_id = any($1::text[]) order by k.created_at`,
    [orgs],
  );
  return json({ connectors: r.rows });
});

router.on('GET', '/api/connectors/wialon/login-url', async (c) => {
  user(c);
  const host = c.url.searchParams.get('host') ?? 'https://hosting.wialon.com';
  const redirect = c.url.searchParams.get('redirect') ?? `${c.url.origin}/app/#/connect/wialon`;
  return json({ url: wialonLoginUrl(host, redirect) });
});

router.on('POST', '/api/connectors', async (c) => {
  const u = user(c);
  const b = await readJson(c.req);
  const orgId = typeof b.org_id === 'string' ? b.org_id : u.org_id;
  await assertCap(c.db, u, 'connectors.manage', orgId, 'Подключать платформы могут администраторы');
  const kind = String(b.kind);
  if (!['wialon', 'traccar', 'aemp'].includes(kind)) throw bad('bad_kind', 'Тип подключения: wialon, traccar или aemp');
  const baseUrl = str(b.base_url, 300);
  if (!baseUrl) throw bad('bad_url', 'Укажите адрес сервера');
  const secret: Record<string, string> = {};
  for (const k of ['token', 'email', 'password', 'username']) if (typeof b[k] === 'string' && b[k]) secret[k] = b[k];
  let units;
  try {
    units = await fetchUnits(kind, baseUrl, secret);
  } catch (e) {
    if (e instanceof ConnectorError) throw new HttpError(422, 'connector_' + e.code, e.message);
    throw e;
  }
  const id = randomUUID();
  await c.db.query(`insert into connectors (id, org_id, kind, label, base_url, secret_enc) values ($1, $2, $3, $4, $5, $6)`, [
    id,
    orgId,
    kind,
    str(b.label, 80) ?? `${kind} ${new URL(baseUrl).host}`,
    baseUrl,
    encryptSecret(JSON.stringify(secret)),
  ]);
  await audit(c.db, u, 'connector_created', { id, kind, units: units.length }, orgId);
  const report = await syncConnector(c.db, id);
  return json({ id, units: units.length, report }, 201);
});

router.on('POST', '/api/connectors/:id/sync', async (c, { id }) => {
  const u = user(c);
  const k = (await c.db.query<any>(`select org_id from connectors where id = $1`, [id])).rows[0];
  if (!k) throw notFound();
  await assertOrgVisible(c.db, u, k.org_id);
  try {
    return json({ report: await syncConnector(c.db, id) });
  } catch (e) {
    if (e instanceof ConnectorError) throw new HttpError(422, 'connector_' + e.code, e.message);
    throw e;
  }
});

router.on('DELETE', '/api/connectors/:id', async (c, { id }) => {
  const u = user(c);
  const k = (await c.db.query<any>(`select org_id, label from connectors where id = $1`, [id])).rows[0];
  if (!k) throw notFound();
  await assertCap(c.db, u, 'connectors.manage', k.org_id);
  await c.db.query(`update sources set connector_id = null, external_id = null where connector_id = $1`, [id]);
  await c.db.query(`delete from connectors where id = $1`, [id]);
  await audit(c.db, u, 'connector_deleted', { id, label: k.label }, k.org_id);
  return json({ ok: true });
});

/** Near-real-time refresh while someone is looking: sync connectors not synced in the last minute. */
router.on('POST', '/api/refresh', async (c) => {
  const u = user(c);
  const orgs = await visibleOrgIds(c.db, u);
  const due = await c.db.query<any>(
    `select id from connectors where org_id = any($1::text[]) and status <> 'disabled'
        and (last_sync_at is null or last_sync_at < now() - interval '60 seconds') order by last_sync_at nulls first limit 3`,
    [orgs],
  );
  const results: any[] = [];
  for (const { id } of due.rows) {
    try {
      const rep = await syncConnector(c.db, id, { historyHours: 2 });
      results.push({ id, ok: true, positions: rep.result.positions, counters: rep.result.counters });
    } catch (e: any) {
      results.push({ id, ok: false, error: String(e?.message ?? e) });
    }
  }
  return json({ synced: results });
});

router.on('GET', '/api/cron/daily', async (c) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || c.req.headers.get('authorization') !== `Bearer ${secret}`) throw forbidden();
  const conns = await c.db.query<any>(`select id from connectors where status <> 'disabled'`);
  const out: any[] = [];
  for (const { id } of conns.rows) {
    try {
      const r = await syncConnector(c.db, id, { historyHours: 26 });
      out.push({ id, ok: true, positions: r.result.positions });
    } catch (e: any) {
      out.push({ id, ok: false, error: String(e?.message ?? e) });
    }
  }
  const dirty = await c.db.query<any>(`select distinct machine_id from daily_stats where dirty`);
  for (const { machine_id } of dirty.rows) {
    const m = await loadMachine(c.db, machine_id);
    if (m) await recomputeDirtyDays(c.db, m, 400);
  }
  const trash = await purgeExpired(c.db);
  const demoExists = (await c.db.query(`select 1 from orgs where is_demo limit 1`)).rows.length > 0;
  const demo = demoExists ? await ensureDemoTenant(c.db) : null;
  const pruned = demoExists ? await pruneDemoTelemetry(c.db) : 0;
  await c.db.query(`delete from sessions where expires_at < now()`);
  await c.db.query(`delete from stand_events where t < now() - interval '2 days'`);
  await c.db.query(`delete from stand_commands where created_at < now() - interval '7 days'`);
  return json({ connectors: out, recomputed_machines: dirty.rows.length, trash, demo, pruned_demo_rows: pruned });
});
