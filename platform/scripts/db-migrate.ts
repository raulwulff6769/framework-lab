/**
 * Brings a database to the current schema in ONE transaction (any error rolls everything back);
 * optionally seeds the demo tenant and issues a gateway key for a stand/gateway host.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-migrate.ts [--demo] [--gateway-key-file PATH] [--gateway-key-label TEXT]
 *
 * The raw gateway key is written only to PATH (mode 600); the database keeps its SHA-256 hash.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { newToken, sha256 } from '../server/auth.js';
import { openDb } from '../server/db.js';
import { ensureDemoTenant } from '../server/demo.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../server/schema.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const db = await openDb(url);
const before = await db.query<{ value: string }>(`select value from schema_meta where key = 'version'`).catch(() => ({ rows: [] as { value: string }[] }));
const keyFile = opt('--gateway-key-file');
const key = keyFile ? 'itg_' + newToken() : null;
const out = await db.tx(async (t) => {
  await t.exec(SCHEMA_SQL);
  await t.query(`insert into schema_meta (key, value) values ('version', $1) on conflict (key) do update set value = excluded.value`, [SCHEMA_VERSION]);
  const demo = args.includes('--demo') ? await ensureDemoTenant(t) : null;
  let keyId: string | null = null;
  if (key) {
    keyId = randomUUID();
    await t.query(`insert into gateway_keys (id, label, key_hash) values ($1, $2, $3)`, [keyId, opt('--gateway-key-label') ?? 'Стенд', sha256(key)]);
    await t.query(`insert into audit_log (user_id, org_id, action, details) values (null, null, 'gateway_key_created', $1)`, [
      JSON.stringify({ id: keyId, label: opt('--gateway-key-label') ?? 'Стенд', by: 'scripts/db-migrate.ts' }),
    ]);
  }
  return { demo, keyId };
});
if (key && keyFile) writeFileSync(keyFile, key + '\n', { mode: 0o600 });
const roles = await db.query<{ role: string; n: number }>(`select role, count(*)::int as n from users group by role order by role`);
console.log(JSON.stringify({ schema_before: before.rows[0]?.value ?? null, schema_after: SCHEMA_VERSION, demo: out.demo, gateway_key_id: out.keyId, roles: roles.rows }));
await db.close();
