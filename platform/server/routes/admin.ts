// Organisations, users, invites, trash, audit log, service settings and gateway keys.
import { randomUUID } from 'node:crypto';
import { hashPassword, newInviteCode, newToken, normalizeCode, sha256, validPassword } from '../auth.js';
import { assertCanAssignRole, assertCanManageUser, assertCap, assertOrgVisible, assertOwnerAdmin, can, visibleOrgIds, type UserPrincipal, type UserTarget } from '../access.js';
import { bad, forbidden, HttpError, json, notFound, readJson } from '../http.js';
import { audit, getSetting, ms, router, setSetting, str, user, type Ctx } from '../core.js';
import { cleanOverrides, effectiveBlocks, isRole, legacyRole, rank, ROLES, rolesFor, type Role } from '../domain/roles.js';
import { orgSubtree, purgeOrgs, purgeUsers, restoreBatch, softDeleteOrg, TRASH_DAYS } from '../purge.js';
import { ensureDemoTenant } from '../demo.js';

async function loadOrg(c: Ctx, id: string) {
  const r = await c.db.query<any>(`select id, kind, name, parent_id, is_demo, protected, deleted_at, delete_batch from orgs where id = $1`, [id]);
  if (!r.rows[0]) throw notFound('Организация не найдена');
  return r.rows[0];
}

async function loadUserTarget(c: Ctx, id: string): Promise<UserTarget & { deleted_at: string | null; delete_batch: string | null; login: string }> {
  const r = await c.db.query<any>(
    `select u.id, u.org_id, o.kind as org_kind, u.role, u.protected, u.deleted_at, u.delete_batch, u.login
       from users u join orgs o on o.id = u.org_id where u.id = $1`,
    [id],
  );
  const t = r.rows[0];
  if (!t) throw notFound('Пользователь не найден');
  return { ...t, role: legacyRole(t.role, t.org_kind) };
}

// ---------------------------------------------------------------- organisations

router.on('GET', '/api/orgs', async (c) => {
  const u = user(c);
  const ids = await visibleOrgIds(c.db, u);
  const r = await c.db.query<any>(
    `select o.id, o.kind, o.name, o.parent_id, p.name as parent_name, o.tz, o.share_location_up, o.is_demo, o.protected,
            (select count(*)::int from machines m where m.org_id = o.id and not m.archived) as machines,
            (select count(*)::int from users x where x.org_id = o.id and not x.disabled and x.deleted_at is null) as users
       from orgs o left join orgs p on p.id = o.parent_id
      where o.id = any($1::text[])
      order by case o.kind when 'fuchs' then 0 when 'distributor' then 1 else 2 end, o.name`,
    [ids],
  );
  return json({ orgs: r.rows, roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, kinds: v.kinds, summary: v.summary }])) });
});

router.on('POST', '/api/orgs', async (c) => {
  const u = user(c);
  if (!can(u, 'orgs.manage')) throw forbidden();
  const b = await readJson(c.req);
  const name = str(b.name, 120);
  if (!name) throw bad('bad_name', 'Укажите название');
  let kind: string;
  let parent: string;
  if (u.org_kind === 'fuchs') {
    kind = b.kind === 'customer' ? 'customer' : 'distributor';
    parent = kind === 'customer' && typeof b.parent_id === 'string' ? b.parent_id : u.org_id;
    if (kind === 'customer' && parent !== u.org_id) {
      await assertOrgVisible(c.db, u, parent);
      const p = await c.db.query<any>(`select kind from orgs where id = $1`, [parent]);
      if (p.rows[0]?.kind !== 'distributor') throw bad('bad_parent', 'Клиент привязывается к дистрибьютору');
    }
  } else if (u.org_kind === 'distributor') {
    kind = 'customer';
    parent = u.org_id;
  } else throw forbidden('Клиент не создаёт другие организации');
  const demo = (await c.db.query<any>(`select is_demo from orgs where id = $1`, [parent])).rows[0]?.is_demo ?? false;
  const id = randomUUID();
  await c.db.query(`insert into orgs (id, kind, name, parent_id, tz, is_demo) values ($1, $2, $3, $4, $5, $6)`, [
    id,
    kind,
    name,
    parent,
    str(b.tz, 64) ?? 'Europe/Moscow',
    demo,
  ]);
  await audit(c.db, u, 'org_created', { id, kind, name }, id);
  return json({ org: { id, kind, name, parent_id: parent } }, 201);
});

router.on('PATCH', '/api/orgs/:id', async (c, { id }) => {
  const u = user(c);
  await assertOrgVisible(c.db, u, id);
  const b = await readJson(c.req);
  if (b.share_location_up !== undefined) {
    assertOwnerAdmin(u, id);
    await c.db.query(`update orgs set share_location_up = $2 where id = $1`, [id, !!b.share_location_up]);
    await audit(c.db, u, 'share_location_up', { org: id, value: !!b.share_location_up }, id);
  }
  if (b.name !== undefined || b.tz !== undefined) {
    await assertCap(c.db, u, 'orgs.manage', id);
    if (b.tz !== undefined) {
      const tz = String(b.tz);
      const ok = await c.db.query(`select 1 from pg_timezone_names where name = $1`, [tz]);
      if (!ok.rows.length) throw bad('bad_tz', 'Неизвестный часовой пояс');
      await c.db.query(`update orgs set tz = $2 where id = $1`, [id, tz]);
    }
    const name = str(b.name, 120);
    if (name) await c.db.query(`update orgs set name = $2 where id = $1`, [id, name]);
    await audit(c.db, u, 'org_updated', { org: id, name: name ?? undefined, tz: b.tz }, id);
  }
  return json({ ok: true });
});

router.on('DELETE', '/api/orgs/:id', async (c, { id }) => {
  const u = user(c);
  await assertCap(c.db, u, 'orgs.manage', id, 'Удалять организации могут администраторы вышестоящей организации');
  const o = await loadOrg(c, id);
  if (o.id === u.org_id) throw forbidden('Свою организацию удалить нельзя');
  if (o.kind === 'fuchs') throw forbidden('Главную организацию удалить нельзя');
  if (u.is_demo && o.protected) throw forbidden('Демо-организацию нельзя удалить из демо-доступа');
  const batch = randomUUID();
  const ids = await softDeleteOrg(c.db, id, u.id, batch);
  await audit(c.db, u, 'org_deleted', { org: id, name: o.name, with_children: ids.length - 1 }, id);
  return json({ ok: true, batch, orgs: ids.length, restore_days: TRASH_DAYS });
});

router.on('POST', '/api/orgs/:id/restore', async (c, { id }) => {
  const u = user(c);
  if (!can(u, 'orgs.manage')) throw forbidden();
  const visible = await visibleOrgIds(c.db, u, { deleted: true });
  if (!visible.includes(id)) throw notFound('Организация не найдена');
  const o = await loadOrg(c, id);
  if (!o.deleted_at) throw bad('not_deleted', 'Организация не в корзине');
  if (o.parent_id) {
    const p = await loadOrg(c, o.parent_id);
    if (p.deleted_at && p.delete_batch !== o.delete_batch) throw bad('parent_deleted', 'Сначала восстановите вышестоящую организацию');
  }
  await restoreBatch(c.db, o.delete_batch);
  await audit(c.db, u, 'org_restored', { org: id, name: o.name }, id);
  return json({ ok: true });
});

router.on('DELETE', '/api/orgs/:id/purge', async (c, { id }) => {
  const u = user(c);
  if (!can(u, 'purge')) throw forbidden('Окончательно удаляет только суперадминистратор');
  const visible = await visibleOrgIds(c.db, u, { deleted: true });
  if (!visible.includes(id)) throw notFound('Организация не найдена');
  const o = await loadOrg(c, id);
  if (!o.deleted_at) throw bad('not_deleted', 'Сначала переместите организацию в корзину');
  const b = await readJson(c.req);
  if (String(b.confirm ?? '') !== o.name) throw bad('confirm', 'Для окончательного удаления введите точное название организации');
  const sub = await orgSubtree(c.db, id);
  if (u.is_demo) {
    const prot = await c.db.query(`select 1 from orgs where id = any($1::text[]) and protected limit 1`, [sub]);
    if (prot.rows.length) throw forbidden('Демо-организацию нельзя удалить окончательно из демо-доступа');
  }
  const res = await purgeOrgs(c.db, id);
  await audit(c.db, u, 'org_purged', { org: id, name: o.name, ...res }, null);
  return json({ ok: true, ...res });
});

// ---------------------------------------------------------------- users & invites

router.on('POST', '/api/orgs/:id/invites', async (c, { id }) => {
  const u = user(c);
  await assertCap(c.db, u, 'users.manage', id, 'Приглашать сотрудников могут администраторы');
  const o = await loadOrg(c, id);
  const b = await readJson(c.req);
  const roles = rolesFor(o.kind);
  const role: Role = isRole(b.role) ? b.role : legacyRole(b.role === 'admin' ? 'admin' : 'member', o.kind);
  if (!roles.includes(role)) throw bad('bad_role', 'Эта роль недоступна для такой организации');
  assertCanAssignRole(u, role, id, o.kind);
  const code = newInviteCode();
  await c.db.query(
    `insert into invites (code_hash, org_id, role, created_by, expires_at) values ($1, $2, $3, $4, now() + interval '7 days')`,
    [sha256(normalizeCode(code)), id, role, u.id],
  );
  await audit(c.db, u, 'invite_created', { org: id, role }, id);
  return json({ code, role, role_label: ROLES[role].label, expires_in_days: 7 }, 201);
});

function userRow(r: any) {
  const role = legacyRole(r.role, r.org_kind);
  return {
    id: r.id,
    login: r.login,
    role,
    role_label: ROLES[role].label,
    label: r.label,
    disabled: r.disabled,
    protected: r.protected,
    overrides: r.blocks ?? {},
    blocks: effectiveBlocks(role, r.blocks),
    machine_ids: Array.isArray(r.machine_ids) && r.machine_ids.length ? r.machine_ids : null,
    created_at: r.created_at,
    last_login_at: ms(r.last_login_ms),
  };
}

router.on('GET', '/api/orgs/:id/users', async (c, { id }) => {
  const u = user(c);
  await assertCap(c.db, u, 'users.manage', id, 'Список сотрудников доступен администраторам');
  const o = await loadOrg(c, id);
  const r = await c.db.query<any>(
    `select u.id, u.login, u.role, u.label, u.disabled, u.protected, u.blocks, u.machine_ids, u.created_at,
            (extract(epoch from u.last_login_at) * 1000)::float8 as last_login_ms, o.kind as org_kind
       from users u join orgs o on o.id = u.org_id where u.org_id = $1 and u.deleted_at is null order by u.login`,
    [id],
  );
  const machines = await c.db.query<any>(`select id, name from machines where org_id = $1 and not archived order by name`, [id]);
  const manageable = rolesFor(o.kind).filter((role) => {
    try {
      assertCanAssignRole(u, role, id, o.kind);
      return true;
    } catch {
      return false;
    }
  });
  const myRank = rank(u.role, u.org_kind);
  return json({
    users: r.rows.map((row) => ({
      ...userRow(row),
      manageable:
        row.id !== u.id && !(u.is_demo && row.protected) && (u.role === 'superadmin' || id !== u.org_id || rank(legacyRole(row.role, o.kind), o.kind) < myRank),
    })),
    assignable_roles: manageable,
    machines: machines.rows,
  });
});

router.on('PATCH', '/api/users/:id', async (c, { id }) => {
  const u = user(c);
  const t = await loadUserTarget(c, id);
  await assertCanManageUser(c.db, u, t);
  const b = await readJson(c.req);
  const changes: Record<string, unknown> = {};
  let role = t.role;
  if (b.role !== undefined) {
    if (!isRole(b.role)) throw bad('bad_role', 'Неизвестная роль');
    assertCanAssignRole(u, b.role, t.org_id, t.org_kind);
    role = b.role;
    await c.db.query(`update users set role = $2 where id = $1`, [id, role]);
    changes.role = role;
  }
  if (b.disabled !== undefined) {
    await c.db.query(`update users set disabled = $2 where id = $1`, [id, !!b.disabled]);
    if (b.disabled) await c.db.query(`delete from sessions where user_id = $1`, [id]);
    changes.disabled = !!b.disabled;
  }
  if (b.label !== undefined) {
    await c.db.query(`update users set label = $2 where id = $1`, [id, str(b.label, 80)]);
    changes.label = true;
  }
  if (b.blocks !== undefined) {
    const ov = cleanOverrides(role, b.blocks);
    await c.db.query(`update users set blocks = $2 where id = $1`, [id, JSON.stringify(ov)]);
    changes.blocks = ov;
  } else if (b.role !== undefined) {
    await c.db.query(`update users set blocks = '{}' where id = $1`, [id]);
  }
  if (b.machine_ids !== undefined) {
    let list: string[] | null = null;
    if (Array.isArray(b.machine_ids) && b.machine_ids.length) {
      const ids: string[] = [...new Set<string>((b.machine_ids as unknown[]).map(String))].slice(0, 500);
      list = ids;
      const ok = await c.db.query<{ n: number }>(
        `select count(*)::int as n from machines where id = any($1::text[]) and org_id = $2 and not archived`,
        [ids, t.org_id],
      );
      if (ok.rows[0].n !== ids.length) throw bad('bad_machines', 'Назначать можно только машины организации сотрудника');
    }
    await c.db.query(`update users set machine_ids = $2 where id = $1`, [id, list]);
    changes.machine_ids = list?.length ?? 'all';
  }
  await audit(c.db, u, 'user_updated', { user: id, login: t.login, ...changes }, t.org_id);
  return json({ ok: true });
});

router.on('POST', '/api/users/:id/password', async (c, { id }) => {
  const u = user(c);
  const t = await loadUserTarget(c, id);
  await assertCanManageUser(c.db, u, t);
  const b = await readJson(c.req);
  if (!validPassword(b.password)) throw bad('bad_password', 'Пароль: не короче 8 символов');
  await c.db.query(`update users set pass_hash = $2 where id = $1`, [id, await hashPassword(b.password)]);
  await c.db.query(`delete from sessions where user_id = $1`, [id]);
  await audit(c.db, u, 'password_reset', { user: id, login: t.login }, t.org_id);
  return json({ ok: true });
});

router.on('DELETE', '/api/users/:id', async (c, { id }) => {
  const u = user(c);
  const t = await loadUserTarget(c, id);
  await assertCanManageUser(c.db, u, t);
  if (t.deleted_at) throw bad('already_deleted', 'Пользователь уже в корзине');
  await c.db.query(`update users set deleted_at = now(), deleted_by = $2, delete_batch = $3 where id = $1`, [id, u.id, randomUUID()]);
  await c.db.query(`delete from sessions where user_id = $1`, [id]);
  await audit(c.db, u, 'user_deleted', { user: id, login: t.login }, t.org_id);
  return json({ ok: true, restore_days: TRASH_DAYS });
});

router.on('POST', '/api/users/:id/restore', async (c, { id }) => {
  const u = user(c);
  if (!can(u, 'users.manage')) throw forbidden();
  const t = await loadUserTarget(c, id);
  if (!(await visibleOrgIds(c.db, u)).includes(t.org_id)) throw notFound('Пользователь не найден');
  if (!t.deleted_at) throw bad('not_deleted', 'Пользователь не в корзине');
  const orgBatch = await c.db.query(`select 1 from orgs where delete_batch = $1`, [t.delete_batch]);
  if (orgBatch.rows.length) throw bad('org_deleted', 'Пользователь удалён вместе с организацией — восстановите организацию');
  await c.db.query(`update users set deleted_at = null, deleted_by = null, delete_batch = null where id = $1`, [id]);
  await audit(c.db, u, 'user_restored', { user: id, login: t.login }, t.org_id);
  return json({ ok: true });
});

router.on('DELETE', '/api/users/:id/purge', async (c, { id }) => {
  const u = user(c);
  if (!can(u, 'purge')) throw forbidden('Окончательно удаляет только суперадминистратор');
  const t = await loadUserTarget(c, id);
  if (!(await visibleOrgIds(c.db, u, { deleted: true })).includes(t.org_id)) throw notFound('Пользователь не найден');
  if (!t.deleted_at) throw bad('not_deleted', 'Сначала переместите пользователя в корзину');
  if (u.is_demo && t.protected) throw forbidden('Демо-учётную запись нельзя удалить окончательно');
  await purgeUsers(c.db, [id]);
  await audit(c.db, u, 'user_purged', { user: id, login: t.login }, t.org_id);
  return json({ ok: true });
});

// ---------------------------------------------------------------- trash & audit

router.on('GET', '/api/trash', async (c) => {
  const u = user(c);
  if (!can(u, 'trash.view')) throw forbidden('Корзина доступна администраторам');
  const orgs = await visibleOrgIds(c.db, u, { deleted: true });
  const days = `greatest(0, ${TRASH_DAYS} - extract(day from now() - x.deleted_at))::int as days_left`;
  const o = await c.db.query<any>(
    `select x.id, x.kind, x.name, x.protected, (extract(epoch from x.deleted_at) * 1000)::float8 as deleted_at, d.login as deleted_by, ${days},
            (select count(*)::int from machines m where m.delete_batch = x.delete_batch) as machines,
            (select count(*)::int from users z where z.delete_batch = x.delete_batch) as users
       from orgs x left join users d on d.id = x.deleted_by
      where x.id = any($1::text[]) and x.deleted_at is not null
        and not exists (select 1 from orgs p where p.id = x.parent_id and p.delete_batch = x.delete_batch)
      order by x.deleted_at desc`,
    [orgs],
  );
  const m = await c.db.query<any>(
    `select x.id, x.name, x.category, x.protected, g.name as org_name, (extract(epoch from x.deleted_at) * 1000)::float8 as deleted_at, d.login as deleted_by, ${days}
       from machines x join orgs g on g.id = x.org_id left join users d on d.id = x.deleted_by
      where x.org_id = any($1::text[]) and x.archived and not exists (select 1 from orgs b where b.delete_batch = x.delete_batch)
      order by x.deleted_at desc`,
    [orgs],
  );
  const us = can(u, 'users.manage')
    ? await c.db.query<any>(
        `select x.id, x.login, x.role, x.protected, g.name as org_name, g.kind as org_kind, (extract(epoch from x.deleted_at) * 1000)::float8 as deleted_at,
                d.login as deleted_by, ${days}
           from users x join orgs g on g.id = x.org_id left join users d on d.id = x.deleted_by
          where x.org_id = any($1::text[]) and x.deleted_at is not null and not exists (select 1 from orgs b where b.delete_batch = x.delete_batch)
          order by x.deleted_at desc`,
        [orgs],
      )
    : { rows: [] as any[] };
  return json({
    trash_days: TRASH_DAYS,
    can_purge: can(u, 'purge'),
    orgs: o.rows,
    machines: m.rows,
    users: us.rows.map((x) => ({ ...x, role_label: ROLES[legacyRole(x.role, x.org_kind)].label })),
  });
});

router.on('GET', '/api/audit', async (c) => {
  const u = user(c);
  if (!can(u, 'audit.view')) throw forbidden('Журнал действий доступен администраторам');
  const limit = Math.min(500, Math.max(1, Number(c.url.searchParams.get('limit') ?? 200)));
  const before = Number(c.url.searchParams.get('before') ?? 0) || null;
  const all = u.role === 'superadmin' && !u.is_demo;
  const orgs = all ? [] : await visibleOrgIds(c.db, u, { deleted: true });
  const r = await c.db.query<any>(
    `select a.id::text as id, (extract(epoch from a.t) * 1000)::float8 as t, a.action, a.details, x.login, g.name as org_name, tg.name as target_name
       from audit_log a left join users x on x.id = a.user_id left join orgs g on g.id = a.org_id left join orgs tg on tg.id = a.target_org
      where ($1 or a.org_id = any($2::text[]) or a.target_org = any($2::text[]))
        and ($3::bigint is null or a.id < $3::bigint)
        and a.action <> 'login_failed'
      order by a.id desc limit $4`,
    [all, orgs, before, limit],
  );
  return json({ entries: r.rows });
});

// ---------------------------------------------------------------- service settings & gateway keys

function assertOwner(u: UserPrincipal) {
  if (!can(u, 'settings.manage')) throw forbidden('Настройки сервиса меняет суперадминистратор');
  if (u.is_demo) throw forbidden('В демо-доступе настройки сервиса только для просмотра');
}

router.on('GET', '/api/settings', async (c) => {
  const u = user(c);
  if (!can(u, 'settings.manage')) throw forbidden('Настройки сервиса доступны суперадминистратору');
  const keys = await c.db.query<any>(
    `select k.id, k.label, (extract(epoch from k.created_at) * 1000)::float8 as created_at, (extract(epoch from k.last_used_at) * 1000)::float8 as last_used_at,
            (extract(epoch from k.revoked_at) * 1000)::float8 as revoked_at, x.login as created_by
       from gateway_keys k left join users x on x.id = k.created_by order by k.created_at desc`,
  );
  return json({
    demo_login: await getSetting(c.db, 'demo_login', { enabled: false }),
    gateway_env_token: !!process.env.GATEWAY_TOKEN,
    gateway_keys: keys.rows,
    read_only: u.is_demo,
  });
});

router.on('PATCH', '/api/settings', async (c) => {
  const u = user(c);
  assertOwner(u);
  const b = await readJson(c.req);
  if (b.demo_login !== undefined) {
    await setSetting(c.db, 'demo_login', { enabled: !!b.demo_login?.enabled });
    await audit(c.db, u, 'demo_login', { enabled: !!b.demo_login?.enabled });
  }
  return json({ ok: true });
});

/** Creates the demo tenant or brings it back to its seed state (the nightly cron does the same once it exists). */
router.on('POST', '/api/settings/demo-tenant', async (c) => {
  const u = user(c);
  assertOwner(u);
  const res = await ensureDemoTenant(c.db);
  await audit(c.db, u, 'demo_tenant_restored', { orgs: res.orgs, users: res.users, machines: res.machines, skipped: res.skipped.length });
  return json(res);
});

router.on('POST', '/api/gateway-keys', async (c) => {
  const u = user(c);
  assertOwner(u);
  const b = await readJson(c.req);
  const label = str(b.label, 80) ?? 'Шлюз';
  const key = 'itg_' + newToken();
  const id = randomUUID();
  await c.db.query(`insert into gateway_keys (id, label, key_hash, created_by) values ($1, $2, $3, $4)`, [id, label, sha256(key), u.id]);
  await audit(c.db, u, 'gateway_key_created', { id, label });
  return json({ id, label, key }, 201);
});

router.on('DELETE', '/api/gateway-keys/:id', async (c, { id }) => {
  const u = user(c);
  assertOwner(u);
  const r = await c.db.query(`update gateway_keys set revoked_at = now() where id = $1 and revoked_at is null`, [id]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', 'Ключ не найден или уже отозван');
  await audit(c.db, u, 'gateway_key_revoked', { id });
  return json({ ok: true });
});

