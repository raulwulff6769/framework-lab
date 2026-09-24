import { beforeAll, describe, expect, it } from 'vitest';
import { call, iso } from './helpers.js';
import { getDb } from '../server/db.js';
import { ensureDemoTenant } from '../server/demo.js';
import { polygonArea } from '../server/domain/geodesy.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'pglite:memory';
process.env.SETUP_KEY = 'test-setup-key-0123456789';
process.env.GATEWAY_TOKEN = 'gw_test_token_0123456789abcdef';
process.env.CRON_SECRET = 'cron-secret-test';

const T: Record<string, string> = {};
let distOrg = '';
let custOrg = '';
let otherCust = '';
let mA = '';
let mB = '';

async function redeem(code: string, login: string) {
  const r = await call('POST', '/api/auth/redeem', { code, login, password: 'password-' + login });
  expect(r.status).toBe(201);
  return r.data.token as string;
}
async function invite(org: string, role: string, by: string, login: string) {
  const inv = await call('POST', `/api/orgs/${org}/invites`, { role }, by);
  expect(inv.status).toBe(201);
  return redeem(inv.data.code, login);
}
const userId = async (org: string, login: string, by: string) =>
  (await call('GET', `/api/orgs/${org}/users`, undefined, by)).data.users.find((u: any) => u.login === login).id as string;

describe('roles, visibility, trash, demo, stand, Traccar Client', () => {
  beforeAll(async () => {
    const ok = await call('POST', '/api/setup', { setup_key: process.env.SETUP_KEY, login: 'owner', password: 'secret-password' });
    T.super = ok.data.token;
    const d = await call('POST', '/api/orgs', { kind: 'distributor', name: 'Дилер Юг' }, T.super);
    distOrg = d.data.org.id;
    T.dealer = await invite(distOrg, 'admin', T.super, 'dealer');
    T.engineer = await invite(distOrg, 'engineer', T.dealer, 'engineer');
    custOrg = (await call('POST', '/api/orgs', { name: 'Кубань' }, T.dealer)).data.org.id;
    otherCust = (await call('POST', '/api/orgs', { name: 'Дон' }, T.dealer)).data.org.id;
    T.admin = await invite(custOrg, 'admin', T.dealer, 'kub-admin');
    T.dispatcher = await invite(custOrg, 'dispatcher', T.admin, 'kub-disp');
    T.mechanic = await invite(custOrg, 'mechanic', T.admin, 'kub-mech');
    T.viewer = await invite(custOrg, 'viewer', T.admin, 'kub-view');
    T.operator = await invite(custOrg, 'operator', T.admin, 'kub-oper');
    mA = (await call('POST', '/api/machines', { org_id: custOrg, name: 'К-7М', category: 'tractor', tank_l: 1000, work_width_m: 12 }, T.dispatcher)).data.machine.id;
    mB = (await call('POST', '/api/machines', { org_id: custOrg, name: 'RSM 2375', category: 'tractor' }, T.admin)).data.machine.id;
  });

  it('the setup account is the superadmin and /api/me explains capabilities and blocks', async () => {
    const me = await call('GET', '/api/me', undefined, T.super);
    expect(me.data.user.role).toBe('superadmin');
    expect(me.data.user.caps).toContain('purge');
    const mech = await call('GET', '/api/me', undefined, T.mechanic);
    expect(mech.data.user.role).toBe('mechanic');
    expect(mech.data.user.blocks).not.toContain('map');
    expect(mech.data.user.blocks).toContain('oil');
  });

  it('users are managed top-down: only lower ranks inside the org, anyone in child orgs', async () => {
    const sameRank = await call('POST', `/api/orgs/${custOrg}/invites`, { role: 'admin' }, T.admin);
    expect(sameRank.status).toBe(403);
    const wrongKind = await call('POST', `/api/orgs/${custOrg}/invites`, { role: 'engineer' }, T.admin);
    expect(wrongKind.status).toBe(400);
    const byDealer = await call('POST', `/api/orgs/${custOrg}/invites`, { role: 'admin' }, T.dealer);
    expect(byDealer.status).toBe(201);
    const dispId = await userId(custOrg, 'kub-disp', T.admin);
    const promoteSelfLevel = await call('PATCH', `/api/users/${dispId}`, { role: 'admin' }, T.admin);
    expect(promoteSelfLevel.status).toBe(403);
    const adminId = await userId(custOrg, 'kub-admin', T.dealer);
    const peer = await call('PATCH', `/api/users/${adminId}`, { label: 'x' }, T.admin);
    expect(peer.status).toBe(403);
    const dispCantManage = await call('GET', `/api/orgs/${custOrg}/users`, undefined, T.dispatcher);
    expect(dispCantManage.status).toBe(403);
    const otherOrg = await call('GET', `/api/orgs/${otherCust}/users`, undefined, T.admin);
    expect(otherOrg.status).toBe(404);
    const superToDealerOrg = await call('PATCH', `/api/users/${await userId(distOrg, 'dealer', T.super)}`, { label: 'Руководитель' }, T.super);
    expect(superToDealerOrg.status).toBe(200);
  });

  it('data blocks are enforced on the server and adjustable per user', async () => {
    const now = Date.now();
    const s = await call('POST', `/api/machines/${mA}/sources`, { kind: 'tracker', external_id: '869999000000014' }, T.dispatcher);
    expect(s.status).toBe(201);
    const recs = [0, 1, 2].map((i) => ({
      ext_id: '869999000000014',
      t: iso((3 - i) * 60e3, now),
      lat: 45.63 + i * 0.001,
      lon: 38.97,
      speed_kmh: 8,
      engine_hours: 1200 + i * 0.02,
      engine_hours_method: 'ecu',
      sensors: { rpm: 1650, coolant_temp_c: 86, fuel_level_l: 640 - i, oil_pressure_kpa: 380, implement_on: 1 },
    }));
    expect((await call('POST', '/api/ingest', { records: recs }, process.env.GATEWAY_TOKEN)).status).toBe(200);
    const mech = (await call('GET', '/api/machines', undefined, T.mechanic)).data.machines.find((m: any) => m.id === mA);
    expect(mech.position).toBeNull();
    expect(mech.fuel).toBeNull();
    expect(mech.engine.values.rpm.value).toBe(1650);
    expect(mech.oil.values.oil_pressure_kpa.value).toBe(380);
    expect(mech.hidden).toContain('map');
    const track = await call('GET', `/api/machines/${mA}/track`, undefined, T.mechanic);
    expect(track.status).toBe(403);
    const disp = (await call('GET', '/api/machines', undefined, T.dispatcher)).data.machines.find((m: any) => m.id === mA);
    expect(disp.position.lat).toBeCloseTo(45.632, 4);
    expect(disp.fuel.values.fuel_level_l.value).toBe(638);
    expect(disp.oil).toBeNull();
    // the admin hides fuel from the dispatcher and shows the map to the mechanic
    const dispId = await userId(custOrg, 'kub-disp', T.admin);
    const mechId = await userId(custOrg, 'kub-mech', T.admin);
    expect((await call('PATCH', `/api/users/${dispId}`, { blocks: { fuel: false } }, T.admin)).status).toBe(200);
    expect((await call('PATCH', `/api/users/${mechId}`, { blocks: { map: true } }, T.admin)).status).toBe(200);
    expect((await call('GET', '/api/machines', undefined, T.dispatcher)).data.machines.find((m: any) => m.id === mA).fuel).toBeNull();
    expect((await call('GET', '/api/machines', undefined, T.mechanic)).data.machines.find((m: any) => m.id === mA).position).not.toBeNull();
    const fuelSeries = await call('GET', `/api/machines/${mA}/sensors?key=fuel_level_l`, undefined, T.dispatcher);
    expect(fuelSeries.status).toBe(403);
  });

  it('an operator sees only the assigned machine', async () => {
    const opId = await userId(custOrg, 'kub-oper', T.admin);
    const bad = await call('PATCH', `/api/users/${opId}`, { machine_ids: ['nope'] }, T.admin);
    expect(bad.status).toBe(400);
    expect((await call('PATCH', `/api/users/${opId}`, { machine_ids: [mA] }, T.admin)).status).toBe(200);
    const list = await call('GET', '/api/machines', undefined, T.operator);
    expect(list.data.machines.map((m: any) => m.id)).toEqual([mA]);
    expect((await call('GET', `/api/machines/${mB}`, undefined, T.operator)).status).toBe(404);
    const reading = await call('POST', `/api/machines/${mA}/readings`, { metric: 'engine_hours', value: 1200.1 }, T.operator);
    expect(reading.status).toBe(201);
  });

  it('machines go to the trash, come back, and only the superadmin purges them', async () => {
    const denied = await call('DELETE', `/api/machines/${mB}`, undefined, T.dispatcher);
    expect(denied.status).toBe(403);
    const del = await call('DELETE', `/api/machines/${mB}`, undefined, T.admin);
    expect(del.status).toBe(200);
    expect((await call('GET', '/api/machines', undefined, T.admin)).data.machines.map((m: any) => m.id)).not.toContain(mB);
    const trash = await call('GET', '/api/trash', undefined, T.admin);
    expect(trash.data.machines.map((m: any) => m.id)).toContain(mB);
    expect(trash.data.can_purge).toBe(false);
    expect((await call('POST', `/api/machines/${mB}/restore`, undefined, T.admin)).status).toBe(200);
    expect((await call('GET', '/api/machines', undefined, T.admin)).data.machines.map((m: any) => m.id)).toContain(mB);
    await call('DELETE', `/api/machines/${mB}`, undefined, T.admin);
    expect((await call('DELETE', `/api/machines/${mB}/purge`, { confirm: 'RSM 2375' }, T.admin)).status).toBe(403);
    expect((await call('DELETE', `/api/machines/${mB}/purge`, { confirm: 'wrong' }, T.super)).status).toBe(400);
    expect((await call('DELETE', `/api/machines/${mB}/purge`, { confirm: 'RSM 2375' }, T.super)).status).toBe(200);
    expect((await call('POST', `/api/machines/${mB}/restore`, undefined, T.super)).status).toBe(404);
  });

  it('a trashed machine rejects telemetry so the gateway stops retrying', async () => {
    const m = (await call('POST', '/api/machines', { org_id: custOrg, name: 'Временная' }, T.admin)).data.machine.id;
    await call('POST', `/api/machines/${m}/sources`, { kind: 'tracker', external_id: '869999000000022' }, T.admin);
    await call('DELETE', `/api/machines/${m}`, undefined, T.admin);
    const r = await call('POST', '/api/ingest', { records: [{ ext_id: '869999000000022', t: iso(1000), lat: 45.6, lon: 38.9 }] }, process.env.GATEWAY_TOKEN);
    expect(r.data.results[0].rejected[0].reason).toBe('machine_deleted');
  });

  it('deleting an organisation cascades to its customers and users and restores as a whole', async () => {
    const d2 = (await call('POST', '/api/orgs', { kind: 'distributor', name: 'Дилер Север' }, T.super)).data.org.id;
    const tNorth = await invite(d2, 'admin', T.super, 'north-admin');
    const c2 = (await call('POST', '/api/orgs', { name: 'Карелия' }, tNorth)).data.org.id;
    await invite(c2, 'admin', tNorth, 'karelia-admin');
    expect((await call('DELETE', `/api/orgs/${d2}`, undefined, T.dealer)).status).toBe(404);
    const del = await call('DELETE', `/api/orgs/${d2}`, undefined, T.super);
    expect(del.data.orgs).toBe(2);
    expect((await call('POST', '/api/auth/login', { login: 'karelia-admin', password: 'password-karelia-admin' })).status).toBe(401);
    expect((await call('GET', '/api/me', undefined, tNorth)).status).toBe(401);
    const trash = await call('GET', '/api/trash', undefined, T.super);
    expect(trash.data.orgs.map((o: any) => o.id)).toEqual([d2]);
    expect(trash.data.orgs[0].users).toBe(2);
    expect((await call('POST', `/api/orgs/${c2}/restore`, undefined, T.super)).status).toBe(200);
    expect((await call('POST', '/api/auth/login', { login: 'karelia-admin', password: 'password-karelia-admin' })).status).toBe(200);
    expect((await call('DELETE', `/api/orgs/${custOrg}`, undefined, T.admin)).status).toBe(403);
  });

  it('users can be deleted and restored; the audit log records who did what', async () => {
    const viewId = await userId(custOrg, 'kub-view', T.admin);
    expect((await call('DELETE', `/api/users/${viewId}`, undefined, T.admin)).status).toBe(200);
    expect((await call('GET', '/api/me', undefined, T.viewer)).status).toBe(401);
    expect((await call('POST', `/api/users/${viewId}/restore`, undefined, T.admin)).status).toBe(200);
    const log = await call('GET', '/api/audit', undefined, T.admin);
    const actions = log.data.entries.map((e: any) => e.action);
    expect(actions).toContain('user_deleted');
    expect(actions).toContain('user_restored');
    expect(actions).toContain('machine_purged');
    expect((await call('GET', '/api/audit', undefined, T.dispatcher)).status).toBe(403);
  });

  it('gateway keys are created by the superadmin, work for ingest and can be revoked', async () => {
    expect((await call('POST', '/api/gateway-keys', { label: 'x' }, T.dealer)).status).toBe(403);
    const k = await call('POST', '/api/gateway-keys', { label: 'Стенд' }, T.super);
    expect(k.data.key).toMatch(/^itg_/);
    const ok = await call('POST', '/api/ingest', { records: [{ ext_id: '869999000000014', t: iso(30e3), lat: 45.64, lon: 38.97 }] }, k.data.key);
    expect(ok.data.results[0].status).toBe('ok');
    expect((await call('DELETE', `/api/gateway-keys/${k.data.id}`, undefined, T.super)).status).toBe(200);
    expect((await call('POST', '/api/ingest', { records: [] }, k.data.key)).status).toBe(401);
  });

  it('Traccar Client (OsmAnd) posts in the query and JSON forms', async () => {
    const s = await call('POST', `/api/machines/${mA}/sources`, { kind: 'osmand' }, T.dispatcher);
    expect(s.data.device_id).toMatch(/^itl-/);
    expect(s.data.server_url).toMatch(/\/api\/osmand$/);
    const ts = Math.floor(Date.now() / 1000) - 20;
    const q = await call('POST', `/api/osmand?id=${s.data.device_id}&lat=45.6401&lon=38.9702&timestamp=${ts}&speed=10&bearing=90&accuracy=4.5`, undefined, undefined, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(q.status).toBe(200);
    expect(q.data.positions).toBe(1);
    const j = await call('POST', '/api/osmand', {
      device_id: s.data.device_id,
      location: { timestamp: new Date(Date.now() - 10e3).toISOString(), coords: { latitude: 45.6405, longitude: 38.9712, speed: 5, heading: 91, accuracy: 3, altitude: 30 }, is_moving: true },
    });
    expect(j.status).toBe(200);
    const unknown = await call('POST', `/api/osmand?id=nope&lat=45&lon=38`);
    const emptyJson = await call('POST', `/api/osmand?id=${s.data.device_id}&lat=45.6402&lon=38.9703`);
    expect(emptyJson.status).toBe(200);
    expect(unknown.status).toBe(404);
    const tl = await call('GET', `/api/machines/${mA}/timeline?from=${new Date(Date.now() - 3600e3).toISOString()}`, undefined, T.dispatcher);
    const speeds = tl.data.positions.filter((p: any) => Math.abs(p[1] - 45.6401) < 1e-6 || Math.abs(p[1] - 45.6405) < 1e-6).map((p: any) => p[3]);
    expect(speeds[0]).toBeCloseTo(18.52, 2); // 10 knots
    expect(speeds[1]).toBeCloseTo(18, 2); // 5 m/s
  });

  it('the timeline returns track, stops, fuel events, faults and worked area', async () => {
    const now = Date.now();
    const t0 = now - 3 * 3600e3;
    const recs: any[] = [];
    // 60 min of field passes at 9 km/h with the implement down, then a 40 min stop with a 90 l refill
    for (let i = 0; i <= 120; i++) {
      const t = t0 + i * 30e3;
      recs.push({
        ext_id: '869999000000014', t: new Date(t).toISOString(), lat: 45.6320 + (i * 0.075) / 111.2, lon: 38.9700, speed_kmh: 9,
        sensors: { fuel_level_l: 600 - i * 0.2, fuel_rate_lph: 24, rpm: 1700, implement_on: 1 },
        dtc: i === 60 ? [{ spn: 100, fmi: 1, oc: 1, lamp: 3 }] : [],
      });
    }
    const tStop = t0 + 121 * 30e3;
    for (let i = 0; i < 80; i++) {
      const t = tStop + i * 30e3;
      recs.push({ ext_id: '869999000000014', t: new Date(t).toISOString(), lat: 45.6320 + (120 * 0.075) / 111.2, lon: 38.9700, speed_kmh: 0,
        sensors: { fuel_level_l: i < 20 ? 576 : 666, fuel_rate_lph: 0, rpm: 0, implement_on: 0 } });
    }
    const r = await call('POST', '/api/ingest', { records: recs }, process.env.GATEWAY_TOKEN);
    expect(r.data.results[0].faults).toBe(1);
    const tl = await call('GET', `/api/machines/${mA}/timeline?from=${new Date(t0 - 60e3).toISOString()}&to=${new Date(tStop + 80 * 30e3).toISOString()}`, undefined, T.admin);
    expect(tl.status).toBe(200);
    expect(tl.data.positions.length).toBeGreaterThan(190);
    expect(tl.data.stops.length).toBe(1);
    expect(tl.data.stops[0].to - tl.data.stops[0].from).toBeGreaterThan(30 * 60e3);
    expect(tl.data.fuel.events.map((e: any) => e.kind)).toEqual(['refill']);
    expect(tl.data.fuel.events[0].litres).toBeCloseTo(90, 0);
    expect(tl.data.faults[0].text).toMatch(/Давление моторного масла/);
    // ~9 km at 12 m wide ≈ 10.8 ha (geodesic distance of the synthetic passes)
    expect(tl.data.agro.area_ha).toBeGreaterThan(9);
    expect(tl.data.agro.area_ha).toBeLessThan(12);
    const hidden = await call('GET', `/api/machines/${mA}/timeline?from=${new Date(t0).toISOString()}`, undefined, T.mechanic);
    expect(hidden.status).toBe(403);
    const mechId = await userId(custOrg, 'kub-mech', T.admin);
    await call('PATCH', `/api/users/${mechId}`, { blocks: { map: true, history: true } }, T.admin);
    const mech = await call('GET', `/api/machines/${mA}/timeline?from=${new Date(t0).toISOString()}`, undefined, T.mechanic);
    expect(mech.data.fuel).toBeNull();
    expect(mech.data.series.rpm).toBeDefined();
    expect(mech.data.series.fuel_level_l).toBeUndefined();
    const at = await call('GET', `/api/fleet/at?t=${new Date(t0 + 30 * 60e3).toISOString()}`, undefined, T.admin);
    expect(at.data.machines.find((m: any) => m.id === mA).lat).toBeCloseTo(45.6320 + (60 * 0.075) / 111.2, 4);
  });

  it('geofence areas are geodesic (WGS-84)', async () => {
    const ring = [[38.962, 45.631], [38.986, 45.631], [38.986, 45.6405], [38.962, 45.6405]];
    const g = await call('POST', '/api/geofences', { org_id: custOrg, name: 'Поле №7', kind: 'field', ring }, T.dispatcher);
    expect(g.status).toBe(201);
    const expected = polygonArea([...ring, ring[0]] as Array<[number, number]>).areaM2 / 1e4;
    expect(g.data.area_ha).toBeCloseTo(expected, 6);
    expect(g.data.area_ha).toBeGreaterThan(190);
    expect(g.data.area_ha).toBeLessThan(200);
    expect((await call('POST', '/api/geofences', { org_id: custOrg, name: 'x', ring }, T.mechanic)).status).toBe(403);
  });

  it('the stand reports over outbound HTTPS and receives scenario commands', async () => {
    const report = {
      stand_id: 'test-stand', mode: 'live', machines: [{ imei: '869999000000014', model: 'Galileosky 10' }, { imei: '868183038959735', model: 'Galileosky 10' }],
      events: [{ t: Date.now(), kind: 'packet', imei: '868183038959735', summary: 'Galileosky: 3 записи', hex: '01 1a 00' }],
    };
    const r1 = await call('POST', '/api/stand/report', report, process.env.GATEWAY_TOKEN);
    expect(r1.data.known_imeis).toEqual(['869999000000014']);
    expect((await call('POST', '/api/stand/report', report, T.admin)).status).toBe(401);
    const view = await call('GET', '/api/stand', undefined, T.dispatcher);
    expect(view.data.stands[0].online).toBe(true);
    const free = view.data.stands[0].machines.find((m: any) => m.imei === '868183038959735');
    expect(free.link.registered).toBe(false);
    expect((await call('GET', '/api/stand', undefined, T.mechanic)).status).toBe(403);
    const cmd = await call('POST', '/api/stand/commands', { imei: '869999000000014', command: 'oil_pressure_drop' }, T.dispatcher);
    expect(cmd.status).toBe(201);
    const r2 = await call('POST', '/api/stand/report', report, process.env.GATEWAY_TOKEN);
    expect(r2.data.commands.map((c: any) => c.command)).toEqual(['oil_pressure_drop']);
    expect(r2.data.live).toBe(true);
    expect((await call('POST', `/api/stand/commands/${cmd.data.id}/result`, { ok: true, message: 'ok' }, process.env.GATEWAY_TOKEN)).status).toBe(200);
  });

  it('the demo tenant has one-click accounts confined to demo data', async () => {
    const db = await getDb();
    const res = await ensureDemoTenant(db);
    expect(res.skipped).toEqual([]);
    const list = await call('GET', '/api/demo');
    expect(list.data.enabled).toBe(true);
    expect(list.data.accounts.map((a: any) => a.role)).toEqual(expect.arrayContaining(['superadmin', 'admin', 'analyst', 'engineer', 'dispatcher', 'mechanic', 'viewer', 'operator']));
    const demoOwner = (await call('POST', '/api/auth/demo', { login: 'demo-owner' })).data.token;
    const orgs = await call('GET', '/api/orgs', undefined, demoOwner);
    expect(orgs.data.orgs.every((o: any) => o.is_demo)).toBe(true);
    expect(orgs.data.orgs.map((o: any) => o.name)).not.toContain('Кубань');
    expect((await call('POST', '/api/gateway-keys', { label: 'x' }, demoOwner)).status).toBe(403);
    const kubanAdmin = (await call('POST', '/api/auth/demo', { login: 'demo-kuban-admin' })).data.token;
    const kubanOrg = orgs.data.orgs.find((o: any) => o.name.includes('Кубань-Агро')).id;
    const disp = await userId(kubanOrg, 'demo-dispatcher', kubanAdmin);
    expect((await call('DELETE', `/api/users/${disp}`, undefined, kubanAdmin)).status).toBe(403);
    expect((await call('POST', '/api/auth/password', { old_password: 'x', new_password: 'yyyyyyyyy' }, kubanAdmin)).status).toBe(403);
    const oper = (await call('POST', '/api/auth/demo', { login: 'demo-operator' })).data.token;
    expect((await call('GET', '/api/machines', undefined, oper)).data.machines).toHaveLength(1);
    // a demo visitor deletes a demo machine; the nightly run brings it back
    const machines = (await call('GET', '/api/machines', undefined, kubanAdmin)).data.machines;
    await call('DELETE', `/api/machines/${machines[0].id}`, undefined, kubanAdmin);
    await ensureDemoTenant(db);
    expect((await call('GET', '/api/machines', undefined, kubanAdmin)).data.machines).toHaveLength(machines.length);
    expect((await call('POST', '/api/auth/demo', { login: 'owner' })).status).toBe(404);
    // only the real superadmin (re)creates the demo tenant from the settings page
    expect((await call('POST', '/api/settings/demo-tenant', {}, demoOwner)).status).toBe(403);
    const again = await call('POST', '/api/settings/demo-tenant', {}, T.super);
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ orgs: 8, machines: 12, skipped: [] });
  });

  it('machines archived before the trash existed are never purged automatically', async () => {
    const db = await getDb();
    const legacy = (await call('POST', '/api/machines', { org_id: custOrg, name: 'Старый архив', category: 'tractor' }, T.admin)).data.machine.id;
    // what the v4 migration leaves for a machine archived under v3: in the trash, but without a delete batch
    await db.query(`update machines set archived = true, deleted_at = now() - interval '90 days', delete_batch = null where id = $1`, [legacy]);
    const trashed = (await call('POST', '/api/machines', { org_id: custOrg, name: 'Удалена давно', category: 'tractor' }, T.admin)).data.machine.id;
    expect((await call('DELETE', `/api/machines/${trashed}`, undefined, T.admin)).status).toBe(200);
    await db.query(`update machines set deleted_at = now() - interval '90 days' where id = $1`, [trashed]);
    const cron = await call('GET', '/api/cron/daily', undefined, undefined, { authorization: `Bearer ${process.env.CRON_SECRET}` });
    expect(cron.status).toBe(200);
    const left = (await db.query<{ id: string }>(`select id from machines where id = any($1::text[])`, [[legacy, trashed]])).rows.map((r) => r.id);
    expect(left).toEqual([legacy]);
  });
});
