import { beforeAll, describe, expect, it } from 'vitest';
import { call, iso } from './helpers.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'pglite:memory';
process.env.SETUP_KEY = 'test-setup-key-0123456789';
process.env.GATEWAY_TOKEN = 'gw_test_token_0123456789abcdef';
process.env.CRON_SECRET = 'cron-secret-test';

let fuchs = '';
let dist = '';
let owner = '';
let member = '';
let dispatcher = '';
let mechanic = '';
let distOrg = '';
let custOrg = '';
let machineId = '';
let deviceToken = '';

async function redeem(code: string, login: string) {
  const r = await call('POST', '/api/auth/redeem', { code, login, password: 'password-' + login });
  expect(r.status).toBe(201);
  return r.data.token as string;
}

describe('platform API end-to-end (PGlite)', () => {
  beforeAll(async () => {
    const st = await call('GET', '/api/setup/status');
    expect(st.data.needs_setup).toBe(true);
  });

  it('initial setup requires the setup key and runs once', async () => {
    const wrong = await call('POST', '/api/setup', { setup_key: 'nope', login: 'fuchs-admin', password: 'secret-password' });
    expect(wrong.status).toBe(403);
    const ok = await call('POST', '/api/setup', {
      setup_key: process.env.SETUP_KEY,
      org_name: 'FUCHS Россия',
      login: 'fuchs-admin',
      password: 'secret-password',
    });
    expect(ok.status).toBe(201);
    fuchs = ok.data.token;
    const again = await call('POST', '/api/setup', { setup_key: process.env.SETUP_KEY, login: 'x-admin', password: 'secret-password' });
    expect(again.status).toBe(409);
    const login = await call('POST', '/api/auth/login', { login: 'fuchs-admin', password: 'secret-password' });
    expect(login.status).toBe(200);
    expect(login.data.user.org_kind).toBe('fuchs');
    const bad = await call('POST', '/api/auth/login', { login: 'fuchs-admin', password: 'wrong-password' });
    expect(bad.status).toBe(401);
  });

  it('builds the FUCHS → distributor → customer hierarchy with invite codes', async () => {
    const d = await call('POST', '/api/orgs', { kind: 'distributor', name: 'Дистрибьютор Север' }, fuchs);
    expect(d.status).toBe(201);
    distOrg = d.data.org.id;
    const inv = await call('POST', `/api/orgs/${distOrg}/invites`, { role: 'admin' }, fuchs);
    expect(inv.data.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    dist = await redeem(inv.data.code.toLowerCase(), 'dist-admin');
    const reuse = await call('POST', '/api/auth/redeem', { code: inv.data.code, login: 'dist-two', password: 'password-xx' });
    expect(reuse.status).toBe(400);

    const c = await call('POST', '/api/orgs', { name: 'Леспромхоз «Тайга»' }, dist);
    expect(c.status).toBe(201);
    expect(c.data.org.kind).toBe('customer');
    custOrg = c.data.org.id;
    const inv2 = await call('POST', `/api/orgs/${custOrg}/invites`, { role: 'admin' }, dist);
    owner = await redeem(inv2.data.code, 'taiga-glavny');
    const inv3 = await call('POST', `/api/orgs/${custOrg}/invites`, { role: 'viewer' }, owner);
    member = await redeem(inv3.data.code, 'taiga-viewer');
    const inv4 = await call('POST', `/api/orgs/${custOrg}/invites`, { role: 'dispatcher' }, owner);
    dispatcher = await redeem(inv4.data.code, 'taiga-dispatcher');
    const inv5 = await call('POST', `/api/orgs/${custOrg}/invites`, { role: 'mechanic' }, owner);
    mechanic = await redeem(inv5.data.code, 'taiga-mechanic');

    const custOrgs = await call('GET', '/api/orgs', undefined, owner);
    expect(custOrgs.data.orgs.map((o: any) => o.id)).toEqual([custOrg]);
    const distOrgs = await call('GET', '/api/orgs', undefined, dist);
    expect(distOrgs.data.orgs).toHaveLength(2);
    const cantCreate = await call('POST', '/api/orgs', { name: 'x' }, owner);
    expect(cantCreate.status).toBe(403);
  });

  it('read-only roles cannot add machines; machines belong to customers', async () => {
    const denied = await call('POST', '/api/machines', { name: 'Экскаватор', org_id: custOrg }, member);
    expect(denied.status).toBe(403);
    const wrongOrg = await call('POST', '/api/machines', { name: 'X', org_id: distOrg }, dist);
    expect(wrongOrg.status).toBe(400);
    const m = await call(
      'POST',
      '/api/machines',
      { org_id: custOrg, name: 'Харвестер №7', category: 'harvester', make: 'John Deere', model: '1270G', year: 2016, chassis: 'wheeled' },
      owner,
    );
    expect(m.status).toBe(201);
    machineId = m.data.machine.id;
    expect(m.data.machine.freshness).toBe('none');
  });

  it('pairs a phone with a 6-digit code and ingests idempotently', async () => {
    const s = await call('POST', `/api/machines/${machineId}/sources`, { kind: 'phone' }, owner);
    expect(s.data.pairing_code).toMatch(/^\d{6}$/);
    const badCode = await call('POST', '/api/devices/enroll', { code: '000000' === s.data.pairing_code ? '111111' : '000000' });
    expect(badCode.status).toBe(400);
    const e = await call('POST', '/api/devices/enroll', { code: s.data.pairing_code });
    expect(e.status).toBe(201);
    deviceToken = e.data.token;
    expect(e.data.config.location_enabled).toBe(true);
    const reuse = await call('POST', '/api/devices/enroll', { code: s.data.pairing_code });
    expect(reuse.status).toBe(400);

    const now = Date.now();
    const records = [
      { t: iso(3600e3, now), lat: 61.7849, lon: 34.3469, speed_kmh: 0, acc_m: 6, engine_hours: 10.0, engine_hours_method: 'device' },
      { t: iso(1800e3, now), lat: 61.7851, lon: 34.3474, speed_kmh: 0, acc_m: 6, engine_hours: 10.5, engine_hours_method: 'device' },
      { t: iso(60e3, now), lat: 61.7853, lon: 34.3480, speed_kmh: 2.5, acc_m: 5, engine_hours: 10.98, engine_hours_method: 'device' },
      { t: '1970-01-01T00:00:10Z', lat: 61.78, lon: 34.34 },
      { t: iso(0, now + 3600e3), lat: 61.78, lon: 34.34 },
      { t: iso(10e3, now), lat: 0, lon: 0 },
    ];
    const r1 = await call('POST', '/api/ingest', { records }, deviceToken);
    expect(r1.status).toBe(200);
    expect(r1.data.positions).toBe(3);
    expect(r1.data.counters).toBe(3);
    expect(r1.data.rejected.map((x: any) => x.reason)).toEqual(['time_too_old', 'time_in_future', 'bad_coordinates']);
    const r2 = await call('POST', '/api/ingest', { records: records.slice(0, 3) }, deviceToken);
    expect(r2.data.positions).toBe(0);
    expect(r2.data.duplicates).toBe(6);

    const list = await call('GET', '/api/machines', undefined, owner);
    const m = list.data.machines[0];
    expect(m.position.lat).toBeCloseTo(61.7853, 4);
    expect(m.freshness).toBe('online');
    expect(m.engine_hours.method).toBe('device');
    expect(m.engine_hours.exact).toBe(false);
  });

  it('dashboard readings become the ground truth and calibrate the estimate', async () => {
    const t0 = Date.now() - 3600e3;
    const viewerDenied = await call('POST', `/api/machines/${machineId}/readings`, { metric: 'engine_hours', value: 4521.0 }, member);
    expect(viewerDenied.status).toBe(403);
    const r = await call('POST', `/api/machines/${machineId}/readings`, { metric: 'engine_hours', value: 4521.0, t: new Date(t0).toISOString() }, dispatcher);
    expect(r.status).toBe(201);
    const dec = await call('POST', `/api/machines/${machineId}/readings`, { metric: 'engine_hours', value: 4000, t: new Date().toISOString() }, dispatcher);
    expect(dec.status).toBe(409);
    const det = await call('GET', `/api/machines/${machineId}`, undefined, owner);
    const cal = det.data.calibrations.find((c: any) => c.metric === 'engine_hours');
    expect(cal.offset_value).toBeCloseTo(4511.0, 3);
    // device estimate (10.98) is newer than the reading; shown as calibrated estimate 4521.98
    expect(det.data.machine.engine_hours.value).toBeCloseTo(4521.98, 2);
    expect(det.data.machine.engine_hours.exact).toBe(false);
    expect(det.data.machine.engine_hours.last_exact.value).toBe(4521.0);
  });

  it('location sharing and the per-machine location switch belong to the owner', async () => {
    const seen = await call('GET', '/api/machines', undefined, dist);
    expect(seen.data.machines[0].location_visible).toBe(true);
    const denied = await call('PATCH', `/api/orgs/${custOrg}`, { share_location_up: false }, dist);
    expect(denied.status).toBe(403);
    const ok = await call('PATCH', `/api/orgs/${custOrg}`, { share_location_up: false }, owner);
    expect(ok.status).toBe(200);
    const hidden = await call('GET', '/api/machines', undefined, dist);
    expect(hidden.data.machines[0].location_visible).toBe(false);
    expect(hidden.data.machines[0].position).toBeNull();
    expect(hidden.data.machines[0].engine_hours).not.toBeNull();
    const track = await call('GET', `/api/machines/${machineId}/track`, undefined, dist);
    expect(track.status).toBe(403);
    await call('PATCH', `/api/orgs/${custOrg}`, { share_location_up: true }, owner);

    const d2 = await call('PATCH', `/api/machines/${machineId}`, { location_enabled: false }, dist);
    expect(d2.status).toBe(403);
    const off = await call('PATCH', `/api/machines/${machineId}`, { location_enabled: false }, owner);
    expect(off.data.machine.location_enabled).toBe(false);
    const r = await call(
      'POST',
      '/api/ingest',
      { records: [{ t: iso(5e3), lat: 61.79, lon: 34.35, engine_hours: 11.0, engine_hours_method: 'device', odometer_km: 0.2, odometer_method: 'device' }] },
      deviceToken,
    );
    expect(r.data.location_dropped).toBe(1);
    expect(r.data.positions).toBe(0);
    expect(r.data.counters).toBe(2);
    expect(r.data.config.location_enabled).toBe(false);
    const ownerView = await call('GET', '/api/machines', undefined, owner);
    expect(ownerView.data.machines[0].position).toBeNull();
    const own = await call('GET', `/api/machines/${machineId}/track`, undefined, owner);
    expect(own.status).toBe(403);
    await call('PATCH', `/api/machines/${machineId}`, { location_enabled: true }, owner);
  });

  it('accepts tracker data through the gateway and keeps unknown trackers for later', async () => {
    const s = await call('POST', `/api/machines/${machineId}/sources`, { kind: 'tracker', external_id: '868204005185938' }, owner);
    expect(s.status).toBe(201);
    const dup = await call('POST', `/api/machines/${machineId}/sources`, { kind: 'tracker', external_id: '868204005185938' }, owner);
    expect(dup.status).toBe(409);
    const records = [
      { ext_id: '868204005185938', t: iso(120e3), lat: 61.7854, lon: 34.3481, speed_kmh: 3, sats: 12, hdop: 0.8, engine_hours: 4520.95, engine_hours_method: 'ecu' },
      { ext_id: '999999999999999', t: iso(100e3), lat: 55.75, lon: 37.62 },
    ];
    const noAuth = await call('POST', '/api/ingest', { records }, 'wrong-token');
    expect(noAuth.status).toBe(401);
    const r = await call('POST', '/api/ingest', { records }, process.env.GATEWAY_TOKEN);
    expect(r.status).toBe(200);
    const known = r.data.results.find((x: any) => x.ext_id === '868204005185938');
    const unknown = r.data.results.find((x: any) => x.ext_id === '999999999999999');
    expect(known.positions).toBe(1);
    expect(unknown.status).toBe('unknown_device');
    expect(unknown.indexes).toEqual([1]);
    const det = await call('GET', `/api/machines/${machineId}`, undefined, owner);
    // ECU value (4520.95, 2 min ago) is exact; the phone estimate is newer → shown as estimate
    expect(det.data.machine.engine_hours.last_exact.method).toBe('ecu');
  });

  it('stores oil sensors, rejects unknown keys and analyses level (top-up, consumption per 100 h)', async () => {
    const now = Date.now();
    const recs: any[] = [];
    // 40 h of work, 1 sample/h: level falls 0.3 pp/h, topped up +20 pp at hour 20; ECU engine hours advance 1 h/h
    for (let h = 0; h <= 40; h++) {
      const level = 80 - 0.3 * h + (h >= 20 ? 20 : 0);
      recs.push({
        ext_id: '868204005185938',
        t: new Date(now - (41 - h) * 3600e3).toISOString(),
        engine_hours: 5000 + h,
        engine_hours_method: 'ecu',
        sensors: { oil_level_pct: level, oil_temp_c: 88, oil_water_aw: h === 40 ? 0.62 : 0.2 },
      });
    }
    recs.push({ ext_id: '868204005185938', t: new Date(now - 30e3).toISOString(), sensors: { oil_magic: 1, oil_temp_c: 999 } });
    const r = await call('POST', '/api/ingest', { records: recs }, process.env.GATEWAY_TOKEN);
    const res = r.data.results[0];
    expect(res.sensors).toBe(41 * 3);
    expect(res.rejected).toEqual([{ index: 41, reason: 'bad_sensor' }]);
    const det = await call('GET', `/api/machines/${machineId}`, undefined, owner);
    const oil = det.data.machine.oil;
    expect(oil.values.oil_level_pct.value).toBeCloseTo(88, 5);
    expect(oil.values.oil_water_aw.status).toBe('warn');
    expect(oil.status).toBe('warn');
    const lv = det.data.oil_level;
    expect(lv.topups).toHaveLength(1);
    expect(lv.topups[0].to - lv.topups[0].from).toBeGreaterThan(15);
    expect(lv.topups[0].to - lv.topups[0].from).toBeCloseTo(20, 6);
    expect(lv.hours).toBeCloseTo(39, 6); // two segments: 19 h + 20 h of fitted span
    expect(lv.consumption_pct_per_100h).toBeCloseTo(30, 6);
    const ov = await call('GET', '/api/oil/overview', undefined, dist);
    expect(ov.data.machines).toHaveLength(1);
    expect(ov.data.machines[0].topups_30d).toBe(1);
    const series = await call('GET', `/api/machines/${machineId}/sensors?key=oil_level_pct&days=7`, undefined, owner);
    expect(series.data.total).toBe(41);
  });

  it('forecasts oil service from engine hours for owner, distributor and FUCHS', async () => {
    const s = await call(
      'POST',
      `/api/machines/${machineId}/service`,
      { item: 'Моторное масло', interval_h: 500, last_done_h: 4100, volume_l: 28, product: 'FUCHS TITAN CARGO MAXX 10W-40' },
      owner,
    );
    expect(s.status).toBe(201);
    const det = await call('GET', `/api/machines/${machineId}`, undefined, owner);
    const f = det.data.service[0];
    expect(f.due_at_h).toBe(4600);
    expect(f.remaining_h).toBeCloseTo(4600 - det.data.machine.engine_hours.value, 3);
    const ov = await call('GET', '/api/service/overview', undefined, fuchs);
    expect(ov.data.items).toHaveLength(1);
    expect(ov.data.items[0].org).toBe('Леспромхоз «Тайга»');
    const denied = await call('POST', `/api/service/${f.id}/done`, { at_h: 4600 }, member);
    expect(denied.status).toBe(403);
    const done = await call('POST', `/api/service/${f.id}/done`, { at_h: 4600 }, mechanic);
    expect(done.data.last_done_h).toBe(4600);
  });

  it('rejects cookie sessions without the client header (CSRF) and bad input', async () => {
    const r = await call('POST', '/api/machines', { name: 'x', org_id: custOrg }, undefined, { cookie: `itles_session=${owner}` });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe('csrf');
    const ok = await call('POST', '/api/machines', { name: 'Погрузчик', org_id: custOrg, category: 'loader' }, undefined, {
      cookie: `itles_session=${owner}`,
      'x-itles-client': 'web',
    });
    expect(ok.status).toBe(201);
    const badCat = await call('POST', '/api/machines', { name: 'x', org_id: custOrg, category: 'spaceship' }, owner);
    expect(badCat.status).toBe(400);
    const cron = await call('GET', '/api/cron/daily', undefined, 'wrong');
    expect(cron.status).toBe(403);
    const cronOk = await call('GET', '/api/cron/daily', undefined, 'cron-secret-test');
    expect(cronOk.status).toBe(200);
  });
});
