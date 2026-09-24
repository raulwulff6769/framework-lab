// Soft delete (trash) and permanent deletion. Soft-deleted rows share a batch id so that restoring
// an organisation brings back exactly what was deleted with it.
import type { Db } from './db.js';

export const TRASH_DAYS = 30;

export async function orgSubtree(db: Db, rootId: string): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `with recursive t as (select id from orgs where id = $1 union all select o.id from orgs o join t on o.parent_id = t.id)
     select id from t`,
    [rootId],
  );
  return r.rows.map((x) => x.id);
}

export async function softDeleteOrg(db: Db, rootId: string, by: string, batch: string) {
  const ids = await orgSubtree(db, rootId);
  await db.query(`update orgs set deleted_at = now(), deleted_by = $2, delete_batch = $3 where id = any($1::text[]) and deleted_at is null`, [ids, by, batch]);
  await db.query(
    `update machines set archived = true, deleted_at = now(), deleted_by = $2, delete_batch = $3 where org_id = any($1::text[]) and not archived`,
    [ids, by, batch],
  );
  await db.query(`update users set deleted_at = now(), deleted_by = $2, delete_batch = $3 where org_id = any($1::text[]) and deleted_at is null`, [ids, by, batch]);
  await db.query(`delete from sessions where user_id in (select id from users where delete_batch = $1)`, [batch]);
  return ids;
}

export async function restoreBatch(db: Db, batch: string) {
  await db.query(`update orgs set deleted_at = null, deleted_by = null, delete_batch = null where delete_batch = $1`, [batch]);
  await db.query(`update machines set archived = false, deleted_at = null, deleted_by = null, delete_batch = null where delete_batch = $1`, [batch]);
  await db.query(`update users set deleted_at = null, deleted_by = null, delete_batch = null where delete_batch = $1`, [batch]);
}

/** Machines with all their telemetry, sources and service plan. */
export async function purgeMachines(db: Db, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  await db.tx(async (q) => {
    for (const t of ['positions', 'counters', 'sensor_readings', 'fault_events', 'engine_runs', 'daily_stats', 'readings', 'service_items'])
      await q.query(`delete from ${t} where machine_id = any($1::text[])`, [ids]);
    await q.query(`delete from calibrations where source_id in (select id from sources where machine_id = any($1::text[]))`, [ids]);
    await q.query(`delete from sources where machine_id = any($1::text[])`, [ids]);
    await q.query(`delete from machines where id = any($1::text[])`, [ids]);
  });
  return ids.length;
}

export async function purgeUsers(db: Db, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  await db.tx(async (q) => {
    await q.query(`update invites set created_by = null where created_by = any($1::text[])`, [ids]);
    await q.query(`update invites set used_by = null where used_by = any($1::text[])`, [ids]);
    await q.query(`update readings set entered_by = null where entered_by = any($1::text[])`, [ids]);
    await q.query(`delete from sessions where user_id = any($1::text[])`, [ids]);
    await q.query(`delete from users where id = any($1::text[])`, [ids]);
  });
  return ids.length;
}

/** An organisation subtree: machines, users, connectors, invites, geofences, then the orgs (leaves first). */
export async function purgeOrgs(db: Db, rootId: string): Promise<{ orgs: number; machines: number; users: number }> {
  const ids = await orgSubtree(db, rootId);
  const machines = (await db.query<{ id: string }>(`select id from machines where org_id = any($1::text[])`, [ids])).rows.map((r) => r.id);
  await purgeMachines(db, machines);
  const users = (await db.query<{ id: string }>(`select id from users where org_id = any($1::text[])`, [ids])).rows.map((r) => r.id);
  await purgeUsers(db, users);
  await db.tx(async (q) => {
    await q.query(`delete from calibrations where source_id in (select id from sources where org_id = any($1::text[]))`, [ids]);
    await q.query(`delete from sources where org_id = any($1::text[])`, [ids]);
    await q.query(`delete from connectors where org_id = any($1::text[])`, [ids]);
    await q.query(`delete from invites where org_id = any($1::text[])`, [ids]);
    await q.query(`delete from geofences where org_id = any($1::text[])`, [ids]);
    for (const id of [...ids].reverse()) await q.query(`delete from orgs where id = $1`, [id]);
  });
  return { orgs: ids.length, machines: machines.length, users: users.length };
}

/**
 * Everything in the trash for longer than TRASH_DAYS, except protected demo seed rows. Machines that were
 * archived before the trash existed (schema v4 moved them there without a batch) are never purged
 * automatically: nobody chose to delete them.
 */
export async function purgeExpired(db: Db): Promise<{ orgs: number; machines: number; users: number }> {
  const cutoff = `now() - interval '${TRASH_DAYS} days'`;
  const roots = await db.query<{ id: string }>(
    `select o.id from orgs o where o.deleted_at < ${cutoff} and not o.protected
        and not exists (select 1 from orgs p where p.id = o.parent_id and p.delete_batch = o.delete_batch)`,
  );
  let orgs = 0;
  for (const { id } of roots.rows) orgs += (await purgeOrgs(db, id)).orgs;
  const m = await db.query<{ id: string }>(`select id from machines where archived and deleted_at < ${cutoff} and not protected and delete_batch is not null`);
  const u = await db.query<{ id: string }>(`select id from users where deleted_at < ${cutoff} and not protected`);
  return { orgs, machines: await purgeMachines(db, m.rows.map((r) => r.id)), users: await purgeUsers(db, u.rows.map((r) => r.id)) };
}
