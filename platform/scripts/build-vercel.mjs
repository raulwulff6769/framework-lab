// Produces .vercel/output (Build Output API v3): static UI + one bundled Node function + cron.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const out = '.vercel/output';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/static`, { recursive: true });
cpSync('dist', `${out}/static`, { recursive: true });
if (existsSync('downloads')) cpSync('downloads', `${out}/static/downloads`, { recursive: true });

const fn = `${out}/functions/api/index.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ['api/node.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: `${fn}/index.mjs`,
  external: ['@electric-sql/pglite', 'pg-native'],
  // pg is CommonJS and requires node built-ins at runtime
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
});
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: 'module' }));
writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }),
);
writeFileSync(
  `${out}/config.json`,
  JSON.stringify({
    version: 3,
    // Emulated platforms (simext) are served by the same function under their own hosts.
    routes: [
      ...JSON.parse(readFileSync(new URL('../server/simext/companies.json', import.meta.url), 'utf8'))
        .companies.filter((c) => c.platform === 'wialon' || c.platform === 'aemp')
        .map((c) => ({ src: '^/(.*)$', has: [{ type: 'host', value: new URL(c.base_url).host }], dest: '/api/index' })),
      { src: '^/api/(.*)$', dest: '/api/index' },
      // Content-hashed build output (JS/CSS/fonts/workers) never changes under a given name,
      // so it is cached for a year. Without this the platform default is max-age=0,
      // must-revalidate — every asset is revalidated on every load, which is slow on distant
      // or throttled links. index.html / sw.js stay uncached so new deploys are picked up.
      { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
      { handle: 'filesystem' },
    ],
    crons: [{ path: '/api/cron/daily', schedule: '0 3 * * *' }],
  }),
);
console.log('vercel output ready');
