// The native app opens straight into the cabinet (app/), not the marketing landing page.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import packageJson from './package.json' with { type: 'json' };

rmSync('www', { recursive: true, force: true });
cpSync('../../platform/dist', 'www', { recursive: true });
writeFileSync(
  'www/index.html',
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>location.replace("./app/index.html"+location.hash)</script>',
);

await build({
  entryPoints: ['src/native-geo.ts'],
  outfile: 'www/app/native-geo.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
});

const appIndexPath = 'www/app/index.html';
const appIndex = readFileSync(appIndexPath, 'utf8');
const moduleScript = /<script\b(?=[^>]*\btype=["']module["'])[^>]*>/i;
if (!moduleScript.test(appIndex)) {
  throw new Error(`Could not find the app module script in ${appIndexPath}`);
}
if (!appIndex.includes('./native-geo.js')) {
  writeFileSync(
    appIndexPath,
    appIndex.replace(moduleScript, (script) => `<script src="./native-geo.js"></script>\n    ${script}`),
  );
}

console.log('www ready');
