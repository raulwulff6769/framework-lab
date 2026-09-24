// Roles, capabilities and data blocks. Shared by the API (enforcement) and the UI (what to show).
// Scope is the organisation tree: FUCHS → distributors → customers. A capability applies to the
// organisations the user can see (FUCHS: all, distributor: itself + its customers, customer: itself).

export type OrgKind = 'fuchs' | 'distributor' | 'customer';
export type Role = 'superadmin' | 'admin' | 'analyst' | 'engineer' | 'dispatcher' | 'mechanic' | 'viewer' | 'operator';

export type Cap =
  | 'orgs.manage'
  | 'users.manage'
  | 'machines.create'
  | 'machines.edit'
  | 'machines.delete'
  | 'sources.manage'
  | 'connectors.manage'
  | 'service.manage'
  | 'readings.enter'
  | 'audit.view'
  | 'trash.view'
  | 'purge'
  | 'stand.view'
  | 'stand.control'
  | 'settings.manage';

export type Block =
  | 'map'
  | 'history'
  | 'hours'
  | 'mileage'
  | 'fuel'
  | 'engine'
  | 'oil'
  | 'faults'
  | 'service'
  | 'agro'
  | 'sources'
  | 'reports';

export const BLOCKS: Record<Block, { label: string; hint: string }> = {
  map: { label: 'Карта и координаты', hint: 'текущее местоположение машин' },
  history: { label: 'История и таймлайн', hint: 'треки, ползунок времени, стоянки' },
  hours: { label: 'Моточасы', hint: 'счётчик моточасов и работа двигателя по дням' },
  mileage: { label: 'Пробег', hint: 'одометр CAN и пробег по ГНСС' },
  fuel: { label: 'Топливо', hint: 'уровень в баке, расход, заправки и сливы' },
  engine: { label: 'Параметры двигателя (CAN)', hint: 'обороты, температура, нагрузка, напряжение' },
  oil: { label: 'Масло', hint: 'уровень, давление, температура, состояние масла' },
  faults: { label: 'Ошибки (DTC)', hint: 'активные коды неисправностей J1939 DM1' },
  service: { label: 'Обслуживание', hint: 'план ТО по моточасам' },
  agro: { label: 'Агро', hint: 'обработанная площадь, расход на гектар' },
  sources: { label: 'Источники данных', hint: 'трекеры, IMEI, телефоны, платформы' },
  reports: { label: 'Сводки', hint: 'суточная статистика' },
};
export const ALL_BLOCKS = Object.keys(BLOCKS) as Block[];

const ALL_CAPS: Cap[] = [
  'orgs.manage', 'users.manage', 'machines.create', 'machines.edit', 'machines.delete', 'sources.manage',
  'connectors.manage', 'service.manage', 'readings.enter', 'audit.view', 'trash.view', 'purge',
  'stand.view', 'stand.control', 'settings.manage',
];
const ADMIN_CAPS: Cap[] = [
  'users.manage', 'machines.create', 'machines.edit', 'machines.delete', 'sources.manage', 'connectors.manage',
  'service.manage', 'readings.enter', 'audit.view', 'trash.view', 'stand.view', 'stand.control',
];

export interface RoleDef {
  label: string;
  kinds: OrgKind[];
  summary: string;
  caps: Cap[];
  blocks: Block[];
}

export const ROLES: Record<Role, RoleDef> = {
  superadmin: {
    label: 'Суперадминистратор',
    kinds: ['fuchs'],
    summary: 'Владелец сервиса: всё, включая окончательное удаление, ключи шлюзов и демо-доступ',
    caps: ALL_CAPS,
    blocks: ALL_BLOCKS,
  },
  admin: {
    label: 'Администратор',
    kinds: ['fuchs', 'distributor', 'customer'],
    summary: 'Управляет своей организацией и нижестоящими: пользователи, техника, подключения, корзина. У клиента — ещё и координаты',
    caps: [...ADMIN_CAPS, 'orgs.manage'],
    blocks: ALL_BLOCKS,
  },
  analyst: {
    label: 'Аналитик',
    kinds: ['fuchs'],
    summary: 'Видит все разрешённые данные парков, ничего не меняет',
    caps: ['stand.view'],
    blocks: ALL_BLOCKS,
  },
  engineer: {
    label: 'Сервисный инженер',
    kinds: ['distributor'],
    summary: 'ТО, масло и ошибки у клиентов, монтаж трекеров; без удаления и без топлива',
    caps: ['sources.manage', 'service.manage', 'readings.enter', 'stand.view'],
    blocks: ['map', 'history', 'hours', 'mileage', 'engine', 'oil', 'faults', 'service', 'sources', 'reports'],
  },
  dispatcher: {
    label: 'Диспетчер',
    kinds: ['customer'],
    summary: 'Карта, история, топливо; добавляет машины и подключает трекеры и телефоны',
    caps: ['machines.create', 'machines.edit', 'sources.manage', 'readings.enter', 'stand.view', 'stand.control'],
    blocks: ['map', 'history', 'hours', 'mileage', 'fuel', 'engine', 'faults', 'service', 'agro', 'sources', 'reports'],
  },
  mechanic: {
    label: 'Механик',
    kinds: ['customer'],
    summary: 'ТО, масло, ошибки и параметры двигателя; карта скрыта',
    caps: ['service.manage', 'readings.enter'],
    blocks: ['hours', 'mileage', 'engine', 'oil', 'faults', 'service', 'reports'],
  },
  viewer: {
    label: 'Наблюдатель',
    kinds: ['customer'],
    summary: 'Руководитель или бухгалтер: сводки, моточасы, пробег, топливо; только чтение',
    caps: [],
    blocks: ['map', 'history', 'hours', 'mileage', 'fuel', 'agro', 'service', 'reports'],
  },
  operator: {
    label: 'Оператор',
    kinds: ['customer'],
    summary: 'Водитель или тракторист: только назначенные машины, показания счётчика и ТО',
    caps: ['readings.enter'],
    blocks: ['hours', 'faults', 'service'],
  },
};

export const ROLE_ORDER: Role[] = ['superadmin', 'admin', 'analyst', 'engineer', 'dispatcher', 'mechanic', 'viewer', 'operator'];

/** Rank inside one organisation: a user manages only colleagues ranked strictly below. */
export function rank(role: Role, kind: OrgKind): number {
  if (role === 'superadmin') return 100;
  if (role === 'admin') return kind === 'fuchs' ? 90 : kind === 'distributor' ? 80 : 70;
  return { analyst: 40, engineer: 50, dispatcher: 45, mechanic: 35, viewer: 25, operator: 15 }[role];
}

export const rolesFor = (kind: OrgKind): Role[] => ROLE_ORDER.filter((r) => ROLES[r].kinds.includes(kind));
export const isRole = (v: unknown): v is Role => typeof v === 'string' && v in ROLES;
export const hasCap = (role: Role, cap: Cap): boolean => ROLES[role]?.caps.includes(cap) ?? false;

/** Per-user overrides on top of the role defaults: {"fuel": false, "map": true}. */
export type BlockOverrides = Partial<Record<Block, boolean>>;

export function effectiveBlocks(role: Role, overrides: BlockOverrides | null | undefined): Block[] {
  const set = new Set<Block>(ROLES[role]?.blocks ?? []);
  for (const [b, on] of Object.entries(overrides ?? {}) as Array<[Block, boolean]>) {
    if (!(b in BLOCKS)) continue;
    if (on) set.add(b);
    else set.delete(b);
  }
  return ALL_BLOCKS.filter((b) => set.has(b));
}

export function cleanOverrides(role: Role, v: unknown): BlockOverrides {
  const out: BlockOverrides = {};
  if (!v || typeof v !== 'object') return out;
  const defaults = new Set(ROLES[role].blocks);
  for (const [b, on] of Object.entries(v as Record<string, unknown>)) {
    if (!(b in BLOCKS) || typeof on !== 'boolean') continue;
    // store only differences from the role, so a later role change keeps its own defaults
    if (on !== defaults.has(b as Block)) out[b as Block] = on;
  }
  return out;
}

/** Legacy roles ('member') and old FUCHS admins are mapped by the schema migration. */
export function legacyRole(role: string, kind: OrgKind): Role {
  if (isRole(role)) return role;
  return kind === 'fuchs' ? 'analyst' : kind === 'distributor' ? 'engineer' : 'viewer';
}
