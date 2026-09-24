// Router, request context and helpers shared by every route module (server/routes/*).
import type { Db } from './db.js';
import { newToken, sha256 } from './auth.js';
import { HttpError, Router } from './http.js';
import type { DevicePrincipal, GatewayPrincipal, Principal, UserPrincipal } from './access.js';
import { effectiveBlocks, legacyRole, ROLES } from './domain/roles.js';

export const APP_VERSION = '0.3.0';
export const SESSION_DAYS = 30;

export interface Ctx {
  req: Request;
  url: URL;
  db: Db;
  p: Principal | null;
  viaCookie: boolean;
}

export const router = new Router<Ctx>();

export function user(c: Ctx): UserPrincipal {
  if (!c.p || c.p.kind !== 'user') throw new HttpError(401, 'unauthorized', 'Требуется вход');
  return c.p;
}
export function device(c: Ctx): DevicePrincipal {
  if (!c.p || c.p.kind !== 'device') throw new HttpError(401, 'unauthorized', 'Устройство не сопряжено');
  return c.p;
}
export function gateway(c: Ctx): GatewayPrincipal {
  if (!c.p || c.p.kind !== 'gateway') throw new HttpError(401, 'unauthorized', 'Нужен ключ шлюза');
  return c.p;
}

export const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
export const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const ms = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function audit(db: Db, u: UserPrincipal | null, action: string, details: unknown = null, targetOrg: string | null = null) {
  await db.query(`insert into audit_log (user_id, org_id, action, details, target_org) values ($1, $2, $3, $4, $5)`, [
    u?.id ?? null,
    u?.org_id ?? null,
    action,
    details === null ? null : JSON.stringify({ ...(details as object), by: u?.login ?? null }),
    targetOrg,
  ]);
}

export function sessionCookie(c: Ctx, token: string, maxAge: number): string {
  const secure = c.url.protocol === 'https:' ? '; Secure' : '';
  return `itles_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function createSession(c: Ctx, userId: string) {
  const token = newToken();
  await c.db.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(SESSION_DAYS)],
  );
  await c.db.query(`update users set last_login_at = now() where id = $1`, [userId]);
  return token;
}

export async function meView(db: Db, userId: string) {
  const r = await db.query<any>(
    `select u.id, u.login, u.role, u.label, u.blocks, u.machine_ids, u.protected, o.id as org_id, o.kind as org_kind,
            o.name as org_name, o.share_location_up, o.tz, o.is_demo
       from users u join orgs o on o.id = u.org_id where u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const role = legacyRole(row.role, row.org_kind);
  return {
    id: row.id,
    login: row.login,
    role,
    role_label: ROLES[role].label,
    label: row.label,
    org_id: row.org_id,
    org_kind: row.org_kind,
    org_name: row.org_name,
    share_location_up: row.share_location_up,
    tz: row.tz,
    is_demo: !!row.is_demo,
    protected: !!row.protected,
    caps: ROLES[role].caps,
    blocks: effectiveBlocks(role, row.blocks),
    machine_ids: Array.isArray(row.machine_ids) && row.machine_ids.length ? row.machine_ids : null,
    owner_admin: role === 'admin' && row.org_kind === 'customer',
  };
}

export function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get('cookie');
  if (!h) return null;
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const r = await db.query<{ value: T }>(`select value from settings where key = $1`, [key]);
  return r.rows[0]?.value ?? fallback;
}

export async function setSetting(db: Db, key: string, value: unknown) {
  await db.query(
    `insert into settings (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
