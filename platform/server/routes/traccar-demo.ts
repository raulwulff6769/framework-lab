import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError, forbidden, json } from '../http.js';
import { router, user, type Ctx } from '../core.js';

const TOKEN_SCOPE = 'traccar-demo';
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT_MS = 48 * 60 * 60 * 1000;
const HISTORY_MAX = 300;
const HISTORY_STEP_MS = 15 * 60 * 1000;
const TOKEN_ERROR = () => new HttpError(401, 'unauthorized', 'Недействительный или истёкший demo-токен');

function signingSecret(): string {
  const secret = process.env.APP_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL)
    throw new HttpError(503, 'unavailable', 'Demo-коннектор не настроен');
  return 'itles-dev-only-secret';
}

export function createTraccarDemoToken(userId: string, expiresAt = Date.now() + TOKEN_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ scope: TOKEN_SCOPE, userId, exp: Math.floor(expiresAt / 1000), nonce: randomUUID() })).toString('base64url');
  const signature = createHmac('sha256', signingSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readTraccarDemoToken(token: string): { userId: string } {
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) throw TOKEN_ERROR();
  const expected = createHmac('sha256', signingSecret()).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    throw TOKEN_ERROR();
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw TOKEN_ERROR();
  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw TOKEN_ERROR();
  }
  if (claims?.scope !== TOKEN_SCOPE || typeof claims.userId !== 'string' || !claims.userId || !Number.isInteger(claims.exp) || claims.exp <= Date.now() / 1000)
    throw TOKEN_ERROR();
  return { userId: claims.userId };
}

async function authorizedDemoUser(c: Ctx): Promise<void> {
  const header = c.req.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) throw TOKEN_ERROR();
  await assertDemoToken(c, header.slice(7).trim());
}

/** Shared by the synthetic Traccar and АвтоГРАФ.WEB emulators: token of an active real superadmin. */
export async function assertDemoToken(c: Ctx, token: string): Promise<void> {
  const claims = readTraccarDemoToken(token);
  const result = await c.db.query(
    `select 1 from users u join orgs o on o.id = u.org_id
      where u.id = $1 and u.role = 'superadmin' and not u.disabled and u.deleted_at is null
        and o.kind = 'fuchs' and not o.is_demo and o.deleted_at is null`,
    [claims.userId],
  );
  if (!result.rows.length) throw TOKEN_ERROR();
}

const units = [
  { id: 101, name: 'DEMO — Экскаватор A', uniqueId: 'DEMO-TRACCAR-101', model: 'Эмулятор спецтехники', lat: 55.7512, lon: 37.6184 },
  { id: 102, name: 'DEMO — Погрузчик B', uniqueId: 'DEMO-TRACCAR-102', model: 'Эмулятор спецтехники', lat: 55.7632, lon: 37.6284 },
  { id: 103, name: 'DEMO — Бульдозер C', uniqueId: 'DEMO-TRACCAR-103', model: 'Эмулятор спецтехники', lat: 55.7432, lon: 37.6084 },
] as const;

const anchorMs = Date.UTC(2026, 0, 1);

function makePosition(device: (typeof units)[number], at: number) {
  const n = units.indexOf(device);
  const elapsed = at - anchorMs;
  const phase = at / (1000 * 60 * 60 * 3) + n * 1.7;
  const latitude = device.lat + Math.sin(phase) * 0.0025;
  const longitude = device.lon + Math.cos(phase * 0.83) * 0.0035;
  const engineHours = 4200 + Math.max(0, elapsed) / 3_600_000 * 0.08 + n * 320;
  const odometer = 185_000 + Math.max(0, elapsed) / 3_600_000 * (1_200 + n * 250);
  const id = device.id * 1_000_000_000 + Math.floor(at / 60_000);
  return {
    id,
    attributes: { sat: 12, hdop: 0.9, ignition: true, hours: engineHours * 3_600_000, odometer, totalDistance: odometer },
    deviceId: device.id,
    protocol: 'demo',
    serverTime: new Date(at).toISOString(),
    deviceTime: new Date(at).toISOString(),
    fixTime: new Date(at).toISOString(),
    valid: true,
    latitude,
    longitude,
    altitude: 145,
    speed: (0.8 + Math.abs(Math.sin(phase)) * 1.8) / 1.852,
    course: ((phase * 22) % 360 + 360) % 360,
    accuracy: 6,
    address: 'Синтетическая тестовая позиция',
    network: {},
    geofenceIds: [],
  };
}

/** Only an active, real (non-demo) FUCHS superadmin may issue synthetic connector credentials. */
export async function assertDemoIssuer(c: Ctx): Promise<string> {
  const current = user(c);
  if (current.role !== 'superadmin' || current.org_kind !== 'fuchs' || current.is_demo)
    throw forbidden('Demo-доступ может выдать только реальный суперадминистратор');
  const active = await c.db.query(
    `select 1 from users u join orgs o on o.id = u.org_id
      where u.id = $1 and u.role = 'superadmin' and not u.disabled and u.deleted_at is null
        and o.kind = 'fuchs' and not o.is_demo and o.deleted_at is null`,
    [current.id],
  );
  if (!active.rows.length) throw forbidden('Учётная запись не имеет доступа к demo-коннектору');
  return current.id;
}

router.on('POST', '/api/connectors/traccar-demo-access', async (c) => {
  const userId = await assertDemoIssuer(c);
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  return json({
    base_url: `${c.url.origin}/api/traccar-demo`,
    token: createTraccarDemoToken(userId, expiresAt),
    expires_at: new Date(expiresAt).toISOString(),
  });
});

router.on('GET', '/api/traccar-demo/api/devices', async (c) => {
  await authorizedDemoUser(c);
  const now = Date.now();
  return json(units.map((device) => {
    const latest = makePosition(device, now);
    return {
      id: device.id,
      attributes: { demo: true },
      name: device.name,
      uniqueId: device.uniqueId,
      status: 'online',
      lastUpdate: latest.fixTime,
      positionId: latest.id,
      groupId: 0,
      phone: null,
      model: device.model,
      contact: null,
      category: 'tractor',
      disabled: false,
    };
  }));
});

router.on('GET', '/api/traccar-demo/api/positions', async (c) => {
  await authorizedDemoUser(c);
  const now = Date.now();
  const deviceId = c.url.searchParams.get('deviceId');
  const selected = deviceId === null ? units : units.filter((device) => String(device.id) === deviceId);
  const fromText = c.url.searchParams.get('from');
  const toText = c.url.searchParams.get('to');
  if (fromText === null && toText === null) return json(selected.map((device) => makePosition(device, now)));

  const requestedFrom = fromText === null ? now - HISTORY_LIMIT_MS : Date.parse(fromText);
  const requestedTo = toText === null ? now : Date.parse(toText);
  if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo)) throw new HttpError(400, 'invalid_range', 'Некорректный интервал позиций');
  const from = Math.max(requestedFrom, now - HISTORY_LIMIT_MS);
  const to = Math.min(requestedTo, now);
  if (to < from) return json([]);
  const count = Math.min(HISTORY_MAX, Math.max(1, Math.floor((to - from) / HISTORY_STEP_MS) + 1));
  const positions = selected.flatMap((device) => Array.from({ length: count }, (_, i) => {
    const at = count === 1 ? to : from + ((to - from) * i) / (count - 1);
    return makePosition(device, at);
  }));
  return json(positions);
});
