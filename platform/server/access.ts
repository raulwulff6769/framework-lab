import type { Db } from './db.js';
import { forbidden, notFound } from './http.js';
import { hasCap, rank, rolesFor, type Block, type Cap, type OrgKind, type Role } from './domain/roles.js';

export interface UserPrincipal {
  kind: 'user';
  id: string;
  login: string;
  org_id: string;
  org_kind: OrgKind;
  org_name: string;
  role: Role;
  label: string | null;
  is_demo: boolean;
  protected: boolean;
  blocks: Block[];
  /** null = every machine of the visible organisations */
  machine_ids: string[] | null;
}
export interface DevicePrincipal {
  kind: 'device';
  source_id: string;
  machine_id: string | null;
  org_id: string;
}
export interface GatewayPrincipal {
  kind: 'gateway';
  key_id: string | null;
  label: string;
}
export type Principal = UserPrincipal | DevicePrincipal | GatewayPrincipal;

/**
 * Organisations a user may see (and, with the right capability, manage): FUCHS sees all, a distributor
 * itself and its customers, a customer itself. Demo accounts are confined to the demo tenant.
 */
export async function visibleOrgIds(db: Db, u: UserPrincipal, opts: { deleted?: boolean } = {}): Promise<string[]> {
  const del = opts.deleted ? 'true' : 'o.deleted_at is null';
  let r;
  if (u.org_kind === 'fuchs')
    r = await db.query<{ id: string }>(`select id from orgs o where ${del} ${u.is_demo ? 'and o.is_demo' : ''}`);
  else if (u.org_kind === 'distributor')
    r = await db.query<{ id: string }>(`select id from orgs o where (o.id = $1 or o.parent_id = $1) and ${del}`, [u.org_id]);
  else r = await db.query<{ id: string }>(`select id from orgs o where o.id = $1 and ${del}`, [u.org_id]);
  return r.rows.map((x) => x.id);
}

export async function assertOrgVisible(db: Db, u: UserPrincipal, orgId: string) {
  const ids = await visibleOrgIds(db, u);
  if (!ids.includes(orgId)) throw notFound('Организация не найдена');
}

export const can = (u: UserPrincipal, cap: Cap) => hasCap(u.role, cap);
export const hasBlock = (u: UserPrincipal, b: Block) => u.blocks.includes(b);

/** The role allows the action and the organisation is inside the user's tree. */
export async function assertCap(db: Db, u: UserPrincipal, cap: Cap, orgId: string, message?: string) {
  if (!can(u, cap)) throw forbidden(message ?? 'Недостаточно прав для этого действия');
  await assertOrgVisible(db, u, orgId);
}

/** Coordinates of a machine are decided only by the main administrator of the owner organisation. */
export function assertOwnerAdmin(u: UserPrincipal, orgId: string) {
  if (u.role !== 'admin' || u.org_kind !== 'customer' || u.org_id !== orgId)
    throw forbidden('Это решение принимает только главный администратор организации-владельца техники');
}

export interface MachineAccessRow {
  id: string;
  org_id: string;
  location_enabled: boolean;
  share_location_up: boolean;
  archived: boolean;
  protected: boolean;
  name: string;
}

export async function loadVisibleMachine(db: Db, u: UserPrincipal, id: string, opts: { deleted?: boolean } = {}): Promise<MachineAccessRow> {
  const r = await db.query<MachineAccessRow>(
    `select m.id, m.org_id, m.location_enabled, o.share_location_up, m.archived, m.protected, m.name
       from machines m join orgs o on o.id = m.org_id where m.id = $1`,
    [id],
  );
  const m = r.rows[0];
  if (!m || (m.archived && !opts.deleted)) throw notFound('Машина не найдена');
  const orgs = await visibleOrgIds(db, u, opts);
  if (!orgs.includes(m.org_id)) throw notFound('Машина не найдена');
  if (u.machine_ids && !u.machine_ids.includes(m.id)) throw notFound('Машина не найдена');
  return m;
}

export function locationVisible(u: UserPrincipal, m: { org_id: string; location_enabled: boolean; share_location_up: boolean }): boolean {
  return hasBlock(u, 'map') && m.location_enabled && (u.org_id === m.org_id || m.share_location_up);
}

export interface UserTarget {
  id: string;
  org_id: string;
  org_kind: OrgKind;
  role: Role;
  protected: boolean;
}

/**
 * Who manages whom: inside one organisation only colleagues ranked strictly below; in a child
 * organisation (distributor → its customers, FUCHS → everyone) any user. Demo seed accounts are
 * protected from other demo users so the public demo keeps working for the next visitor.
 */
export async function assertCanManageUser(db: Db, u: UserPrincipal, t: UserTarget) {
  if (!can(u, 'users.manage')) throw forbidden('Управление пользователями доступно администраторам');
  if (t.id === u.id) throw forbidden('Свою учётную запись этим способом изменить нельзя');
  await assertOrgVisible(db, u, t.org_id);
  if (t.protected && u.is_demo) throw forbidden('Демо-учётную запись нельзя изменить из демо-доступа');
  if (u.role === 'superadmin') return;
  if (t.org_id === u.org_id && rank(t.role, t.org_kind) >= rank(u.role, u.org_kind))
    throw forbidden('Можно управлять только сотрудниками с ролью ниже вашей');
}

export function assertCanAssignRole(u: UserPrincipal, role: Role, targetOrgId: string, targetKind: OrgKind) {
  if (!rolesFor(targetKind).includes(role)) throw forbidden('Эта роль не существует для такого типа организации');
  if (u.role === 'superadmin') return;
  if (role === 'superadmin') throw forbidden('Роль суперадминистратора назначает только суперадминистратор');
  if (targetOrgId === u.org_id && rank(role, targetKind) >= rank(u.role, u.org_kind))
    throw forbidden('Можно назначать только роли ниже своей');
}
