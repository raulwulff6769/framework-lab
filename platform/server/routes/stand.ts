// Live stand: simulated machines with J1939 ECUs → tracker emulators → real TCP to the gateway and
// Traccar. The stand runs outside Vercel and only makes outbound HTTPS calls: it reports status and
// packet samples here and picks up scenario commands from the response (no inbound connection).
import { randomUUID } from 'node:crypto';
import { can, visibleOrgIds, type UserPrincipal } from '../access.js';
import { bad, forbidden, json, readJson } from '../http.js';
import { audit, gateway, router, str, user, type Ctx } from '../core.js';

export const STAND_COMMANDS: Record<string, string> = {
  engine_start: 'Запустить двигатель',
  engine_stop: 'Заглушить двигатель',
  oil_pressure_drop: 'Падение давления масла (DTC SPN 100)',
  overheat: 'Перегрев ОЖ (DTC SPN 110)',
  clear_faults: 'Сбросить неисправности',
  fuel_drain: 'Слив топлива 60 л на стоянке',
  refuel: 'Заправка до полного бака',
  coverage_loss: 'Пропадание сотовой связи (архив в чёрный ящик)',
  coverage_restore: 'Связь восстановлена (досылка архива)',
  implement_on: 'Опустить орудие (начать обработку)',
  implement_off: 'Поднять орудие',
  reboot_tracker: 'Перезагрузить трекер',
};

const LIVE_MS = 3000;
const ECO_MS = 15 * 60e3;

router.on('POST', '/api/stand/report', async (c) => {
  const g = gateway(c);
  const b = await readJson(c.req, 4_000_000);
  const standId = str(b.stand_id, 60);
  if (!standId) throw bad('bad_stand', 'stand_id обязателен');
  const events: any[] = Array.isArray(b.events) ? b.events.slice(-300) : [];
  const { events: _drop, ...status } = b;
  const prev = await c.db.query<any>(`select last_viewed_at > now() - interval '2 minutes' as live from stand_status where stand_id = $1`, [standId]);
  await c.db.query(
    `insert into stand_status (stand_id, reported_at, payload) values ($1, now(), $2)
     on conflict (stand_id) do update set reported_at = now(), payload = excluded.payload`,
    [standId, JSON.stringify({ ...status, gateway_key: g.label })],
  );
  if (events.length) {
    const rows: unknown[] = [];
    const ph: string[] = [];
    for (const e of events) {
      const t = Number(e?.t);
      if (!Number.isFinite(t)) continue;
      rows.push(standId, new Date(t).toISOString(), String(e.kind ?? 'log').slice(0, 20), e.imei ? String(e.imei).slice(0, 32) : null, String(e.summary ?? '').slice(0, 300),
        JSON.stringify({ hex: typeof e.hex === 'string' ? e.hex.slice(0, 1200) : undefined, fields: e.fields ?? undefined, dir: e.dir ?? undefined, proto: e.proto ?? undefined }));
      const n = rows.length;
      ph.push(`($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`);
    }
    if (ph.length) await c.db.query(`insert into stand_events (stand_id, t, kind, imei, summary, payload) values ${ph.join(',')}`, rows);
    await c.db.query(
      `delete from stand_events where stand_id = $1 and id < (select coalesce(min(id), 0) from (select id from stand_events where stand_id = $1 order by id desc limit 3000) x)`,
      [standId],
    );
  }
  const cmds = await c.db.query<any>(
    `update stand_commands set status = 'taken', taken_at = now()
      where id in (select id from stand_commands where status = 'queued' and (stand_id is null or stand_id = $1) and created_at > now() - interval '1 hour' order by created_at limit 20)
      returning id, imei, command, params`,
    [standId],
  );
  const imeis: string[] = (b.machines ?? []).map((m: any) => String(m?.imei ?? '')).filter(Boolean);
  const known = imeis.length
    ? (await c.db.query<any>(`select external_id from sources where kind = 'tracker' and external_id = any($1::text[]) and machine_id is not null`, [imeis])).rows.map((r) => r.external_id)
    : [];
  const live = !!prev.rows[0]?.live || cmds.rows.length > 0;
  return json({ commands: cmds.rows, known_imeis: known, live, poll_ms: live ? LIVE_MS : ECO_MS });
});

router.on('POST', '/api/stand/commands/:id/result', async (c, { id }) => {
  gateway(c);
  const b = await readJson(c.req);
  await c.db.query(`update stand_commands set status = $2, done_at = now(), result = $3 where id = $1`, [id, b.ok ? 'done' : 'failed', str(b.message, 300)]);
  return json({ ok: true });
});

async function imeiMap(c: Ctx, u: UserPrincipal, imeis: string[]) {
  if (!imeis.length) return new Map<string, any>();
  const orgs = await visibleOrgIds(c.db, u);
  const r = await c.db.query<any>(
    `select s.external_id as imei, m.id as machine_id, m.name, m.org_id, o.name as org_name, o.is_demo, m.archived
       from sources s join machines m on m.id = s.machine_id join orgs o on o.id = m.org_id
      where s.kind = 'tracker' and s.external_id = any($1::text[])`,
    [imeis],
  );
  const out = new Map<string, any>();
  for (const row of r.rows) {
    const mine = orgs.includes(row.org_id) && (!u.machine_ids || u.machine_ids.includes(row.machine_id));
    out.set(row.imei, mine ? { registered: true, visible: true, machine_id: row.machine_id, name: row.name, org_name: row.org_name, archived: row.archived } : { registered: true, visible: false });
  }
  return out;
}

router.on('GET', '/api/stand', async (c) => {
  const u = user(c);
  if (!can(u, 'stand.view')) throw forbidden('Стенд доступен администраторам, диспетчерам, инженерам и аналитикам');
  await c.db.query(`update stand_status set last_viewed_at = now()`);
  const st = await c.db.query<any>(
    `select stand_id, payload, (extract(epoch from reported_at) * 1000)::float8 as reported_at from stand_status order by reported_at desc limit 5`,
  );
  const imeiFilter = c.url.searchParams.get('imei');
  const ev = await c.db.query<any>(
    `select id::text as id, stand_id, (extract(epoch from t) * 1000)::float8 as t, kind, imei, summary, payload from stand_events
      where ($1::text is null or imei = $1) order by id desc limit $2`,
    [imeiFilter, imeiFilter ? 300 : 150],
  );
  const allImeis = new Set<string>();
  for (const s of st.rows) for (const m of s.payload?.machines ?? []) if (m?.imei) allImeis.add(String(m.imei));
  for (const e of ev.rows) if (e.imei) allImeis.add(e.imei);
  const map = await imeiMap(c, u, [...allImeis]);
  const hideImei = (imei: string | null) => (imei && map.get(imei)?.registered && !map.get(imei)?.visible ? null : imei);
  const now = Date.now();
  const stands = st.rows.map((s) => {
    const p = s.payload ?? {};
    const eco = p.mode === 'eco';
    return {
      stand_id: s.stand_id,
      reported_at: s.reported_at,
      online: now - s.reported_at < (eco ? ECO_MS * 1.5 : 120e3),
      ...p,
      machines: (p.machines ?? [])
        .filter((m: any) => !map.get(String(m.imei))?.registered || map.get(String(m.imei))?.visible)
        .map((m: any) => ({ ...m, link: map.get(String(m.imei)) ?? { registered: false } })),
    };
  });
  const cmds = await c.db.query<any>(
    `select id, imei, command, status, result, (extract(epoch from created_at) * 1000)::float8 as created_at from stand_commands
      where created_at > now() - interval '1 day' order by created_at desc limit 30`,
  );
  return json({
    stands,
    events: ev.rows.filter((e) => hideImei(e.imei) !== null || !e.imei),
    commands: cmds.rows.filter((x) => hideImei(x.imei) !== null),
    command_labels: STAND_COMMANDS,
    can_control: can(u, 'stand.control'),
  });
});

router.on('POST', '/api/stand/commands', async (c) => {
  const u = user(c);
  if (!can(u, 'stand.control')) throw forbidden('Управлять стендом могут администраторы и диспетчеры');
  const b = await readJson(c.req);
  const command = String(b.command ?? '');
  if (!STAND_COMMANDS[command]) throw bad('bad_command', 'Неизвестная команда стенда');
  const imei = String(b.imei ?? '').replace(/\D/g, '');
  if (!/^\d{5,20}$/.test(imei)) throw bad('bad_imei', 'Укажите IMEI трекера стенда');
  const link = (await imeiMap(c, u, [imei])).get(imei);
  if (link?.registered && !link.visible) throw forbidden('Этот трекер привязан к машине, которая вам недоступна');
  const id = randomUUID();
  await c.db.query(`insert into stand_commands (id, stand_id, imei, command, params, created_by) values ($1, $2, $3, $4, $5, $6)`, [
    id,
    str(b.stand_id, 60),
    imei,
    command,
    b.params ? JSON.stringify(b.params) : null,
    u.id,
  ]);
  await c.db.query(`update stand_status set last_viewed_at = now()`);
  await audit(c.db, u, 'stand_command', { command, imei_tail: imei.slice(-4) });
  return json({ id, label: STAND_COMMANDS[command] }, 201);
});
