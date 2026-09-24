import { randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, normalizeCode, sha256, validLogin, validPassword, verifyPassword } from '../auth.js';
import { bad, forbidden, HttpError, json, readJson } from '../http.js';
import { APP_VERSION, audit, createSession, getSetting, meView, readCookie, router, SESSION_DAYS, sessionCookie, str, user } from '../core.js';
import { ROLES, legacyRole } from '../domain/roles.js';

router.on('GET', '/api/health', async (c) => {
  await c.db.query('select 1');
  return json({ ok: true, version: APP_VERSION, db: c.db.kind, time: new Date().toISOString() });
});

router.on('GET', '/api/setup/status', async (c) => {
  const r = await c.db.query<{ n: number }>(`select count(*)::int as n from orgs`);
  return json({ needs_setup: r.rows[0].n === 0, setup_key_configured: !!process.env.SETUP_KEY });
});

router.on('POST', '/api/setup', async (c) => {
  const b = await readJson(c.req);
  const key = process.env.SETUP_KEY;
  if (!key) throw new HttpError(503, 'setup_disabled', 'SETUP_KEY не задан на сервере');
  const given = String(b.setup_key ?? '');
  if (given.length !== key.length || !timingSafeEqual(Buffer.from(given), Buffer.from(key))) throw forbidden('Неверный ключ установки');
  if (!validLogin(b.login)) throw bad('bad_login', 'Логин: 3–40 символов, латиница в нижнем регистре, цифры, . _ -');
  if (!validPassword(b.password)) throw bad('bad_password', 'Пароль: не короче 8 символов');
  const orgName = str(b.org_name, 120) ?? 'FUCHS';
  const userId = randomUUID();
  const created = await c.db.tx(async (db) => {
    const n = await db.query<{ n: number }>(`select count(*)::int as n from orgs`);
    if (n.rows[0].n > 0) return false;
    const orgId = randomUUID();
    await db.query(`insert into orgs (id, kind, name) values ($1, 'fuchs', $2)`, [orgId, orgName]);
    await db.query(`insert into users (id, org_id, login, pass_hash, role) values ($1, $2, $3, $4, 'superadmin')`, [
      userId,
      orgId,
      b.login,
      await hashPassword(b.password),
    ]);
    return true;
  });
  if (!created) throw new HttpError(409, 'already_setup', 'Система уже инициализирована');
  const token = await createSession(c, userId);
  return json({ token, user: await meView(c.db, userId) }, 201, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});

router.on('POST', '/api/auth/login', async (c) => {
  const b = await readJson(c.req);
  const login = String(b.login ?? '').trim().toLowerCase();
  const fails = await c.db.query<{ n: number }>(
    `select count(*)::int as n from audit_log
      where action = 'login_failed' and details->>'login' = $1 and t > now() - interval '15 minutes'`,
    [login],
  );
  if (fails.rows[0].n >= 10) throw new HttpError(429, 'locked', 'Слишком много попыток. Повторите через 15 минут');
  const r = await c.db.query<any>(
    `select u.id, u.pass_hash, u.disabled, u.deleted_at, o.deleted_at as org_deleted
       from users u join orgs o on o.id = u.org_id where u.login = $1`,
    [login],
  );
  const u = r.rows[0];
  const ok = u && !u.disabled && !u.deleted_at && !u.org_deleted && (await verifyPassword(String(b.password ?? ''), u.pass_hash));
  if (!ok) {
    await audit(c.db, null, 'login_failed', { login });
    throw new HttpError(401, 'bad_credentials', 'Неверный логин или пароль');
  }
  const token = await createSession(c, u.id);
  return json({ token, user: await meView(c.db, u.id) }, 200, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});

router.on('POST', '/api/auth/logout', async (c) => {
  const auth = c.req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : readCookie(c.req, 'itles_session');
  if (token) await c.db.query(`delete from sessions where token_hash = $1`, [sha256(token)]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(c, '', 0) });
});

router.on('GET', '/api/me', async (c) => json({ user: await meView(c.db, user(c).id) }));

router.on('POST', '/api/auth/redeem', async (c) => {
  const b = await readJson(c.req);
  const code = normalizeCode(String(b.code ?? ''));
  if (!validLogin(b.login)) throw bad('bad_login', 'Логин: 3–40 символов, латиница в нижнем регистре, цифры, . _ -');
  if (!validPassword(b.password)) throw bad('bad_password', 'Пароль: не короче 8 символов');
  const userId = randomUUID();
  const passHash = await hashPassword(b.password);
  await c.db.tx(async (db) => {
    const inv = await db.query<any>(
      `select i.code_hash, i.org_id, i.role, o.kind from invites i join orgs o on o.id = i.org_id
        where i.code_hash = $1 and i.used_at is null and i.expires_at > now() and o.deleted_at is null for update of i`,
      [sha256(code)],
    );
    if (!inv.rows[0]) throw bad('bad_code', 'Код приглашения недействителен или уже использован');
    const exists = await db.query(`select 1 from users where login = $1`, [b.login]);
    if (exists.rows.length) throw new HttpError(409, 'login_taken', 'Такой логин уже занят');
    await db.query(`insert into users (id, org_id, login, pass_hash, role) values ($1, $2, $3, $4, $5)`, [
      userId,
      inv.rows[0].org_id,
      b.login,
      passHash,
      legacyRole(inv.rows[0].role, inv.rows[0].kind),
    ]);
    await db.query(`update invites set used_at = now(), used_by = $2 where code_hash = $1`, [inv.rows[0].code_hash, userId]);
  });
  const token = await createSession(c, userId);
  return json({ token, user: await meView(c.db, userId) }, 201, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});

router.on('POST', '/api/auth/password', async (c) => {
  const u = user(c);
  if (u.protected && u.is_demo) throw forbidden('У демо-учётной записи пароль не меняется');
  const b = await readJson(c.req);
  const r = await c.db.query<any>(`select pass_hash from users where id = $1`, [u.id]);
  if (!(await verifyPassword(String(b.old_password ?? ''), r.rows[0].pass_hash))) throw forbidden('Текущий пароль неверен');
  if (!validPassword(b.new_password)) throw bad('bad_password', 'Пароль: не короче 8 символов');
  await c.db.query(`update users set pass_hash = $2 where id = $1`, [u.id, await hashPassword(b.new_password)]);
  await c.db.query(`delete from sessions where user_id = $1`, [u.id]);
  const token = await createSession(c, u.id);
  return json({ token }, 200, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});

// ---------------------------------------------------------------- public demo access

/** Demo accounts shown on the login page: protected users of the demo tenant, no passwords needed. */
router.on('GET', '/api/demo', async (c) => {
  const enabled = await getSetting(c.db, 'demo_login', { enabled: false });
  if (!enabled?.enabled) return json({ enabled: false, accounts: [] });
  const r = await c.db.query<any>(
    `select u.login, u.role, u.label, o.name as org_name, o.kind as org_kind
       from users u join orgs o on o.id = u.org_id
      where o.is_demo and u.protected and not u.disabled and u.deleted_at is null and o.deleted_at is null
      order by case o.kind when 'fuchs' then 0 when 'distributor' then 1 else 2 end, o.name, u.login`,
  );
  return json({
    enabled: true,
    accounts: r.rows.map((a) => {
      const role = legacyRole(a.role, a.org_kind);
      return { login: a.login, role, role_label: ROLES[role].label, summary: ROLES[role].summary, label: a.label, org_name: a.org_name, org_kind: a.org_kind };
    }),
  });
});

router.on('POST', '/api/auth/demo', async (c) => {
  const enabled = await getSetting(c.db, 'demo_login', { enabled: false });
  if (!enabled?.enabled) throw forbidden('Демо-доступ выключен');
  const b = await readJson(c.req);
  const r = await c.db.query<any>(
    `select u.id from users u join orgs o on o.id = u.org_id
      where u.login = $1 and o.is_demo and u.protected and not u.disabled and u.deleted_at is null and o.deleted_at is null`,
    [String(b.login ?? '')],
  );
  if (!r.rows[0]) throw new HttpError(404, 'not_found', 'Нет такой демо-учётной записи');
  const token = await createSession(c, r.rows[0].id);
  return json({ token, user: await meView(c.db, r.rows[0].id) }, 200, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});
