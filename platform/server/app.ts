import { timingSafeEqual } from 'node:crypto';
import { DbNotConfigured, getDb, type Db } from './db.js';
import { sha256 } from './auth.js';
import { CORS_HEADERS, HttpError, json } from './http.js';
import { readCookie, router, type Ctx } from './api.js';
import type { Principal } from './access.js';
import { effectiveBlocks, legacyRole } from './domain/roles.js';

async function principal(db: Db, req: Request): Promise<{ p: Principal | null; viaCookie: boolean }> {
  const auth = req.headers.get('authorization');
  let token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  let viaCookie = false;
  if (!token) {
    token = readCookie(req, 'itles_session');
    viaCookie = !!token;
  }
  if (!token) return { p: null, viaCookie };
  const gw = process.env.GATEWAY_TOKEN;
  if (gw && gw.length >= 24 && token.length === gw.length && timingSafeEqual(Buffer.from(token), Buffer.from(gw)))
    return { p: { kind: 'gateway', key_id: null, label: 'GATEWAY_TOKEN' }, viaCookie: false };
  const h = sha256(token);
  const s = await db.query<any>(
    `select u.id, u.login, u.org_id, u.role, u.label, u.blocks, u.machine_ids, u.protected,
            o.kind as org_kind, o.name as org_name, o.is_demo
       from sessions s join users u on u.id = s.user_id join orgs o on o.id = u.org_id
      where s.token_hash = $1 and s.expires_at > now() and not u.disabled and u.deleted_at is null and o.deleted_at is null`,
    [h],
  );
  const row = s.rows[0];
  if (row) {
    const role = legacyRole(row.role, row.org_kind);
    return {
      p: {
        kind: 'user',
        id: row.id,
        login: row.login,
        org_id: row.org_id,
        org_kind: row.org_kind,
        org_name: row.org_name,
        role,
        label: row.label,
        is_demo: !!row.is_demo,
        protected: !!row.protected,
        blocks: effectiveBlocks(role, row.blocks),
        machine_ids: Array.isArray(row.machine_ids) && row.machine_ids.length ? row.machine_ids : null,
      },
      viaCookie,
    };
  }
  const d = await db.query<any>(`select id, machine_id, org_id from sources where token_hash = $1`, [h]);
  if (d.rows[0]) return { p: { kind: 'device', source_id: d.rows[0].id, machine_id: d.rows[0].machine_id, org_id: d.rows[0].org_id }, viaCookie: false };
  const k = await db.query<any>(`select id, label from gateway_keys where key_hash = $1 and revoked_at is null`, [h]);
  if (k.rows[0]) {
    await db.query(`update gateway_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [k.rows[0].id]);
    return { p: { kind: 'gateway', key_id: k.rows[0].id, label: k.rows[0].label }, viaCookie: false };
  }
  return { p: null, viaCookie };
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(req.url);
  try {
    const m = router.match(req.method, url.pathname);
    if (m === null) throw new HttpError(404, 'not_found', 'Нет такого метода API');
    if (m === 'method') throw new HttpError(405, 'method_not_allowed');
    const db = await getDb();
    const { p, viaCookie } = await principal(db, req);
    // CSRF: a cookie session may change state only from our own UI (custom header forces preflight)
    if (viaCookie && req.method !== 'GET' && !req.headers.get('x-itles-client'))
      throw new HttpError(403, 'csrf', 'Запрос без заголовка клиента отклонён');
    const ctx: Ctx = { req, url, db, p, viaCookie };
    return await m.h(ctx, m.params);
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    if (e instanceof DbNotConfigured)
      return json({ error: 'db_not_configured', message: 'База данных не подключена (переменная DATABASE_URL)' }, 503);
    console.error('unhandled', req.method, url.pathname, e);
    return json({ error: 'internal', message: 'Внутренняя ошибка сервера' }, 500);
  }
}
