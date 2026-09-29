/**
 * Single-process server: REST API + static UI. Used for local development, end-to-end tests and
 * as the production server on a VPS (Node 20+ with PostgreSQL via DATABASE_URL).
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sendWebResponse, toWebRequest } from '../server/node-adapter.js';
import { handleWithSimext } from '../server/simext/index.js';

const port = Number(process.env.PORT ?? 8787);
process.env.DATABASE_URL ??= 'pglite:' + path.resolve('.data/pg');
process.env.SETUP_KEY ??= 'dev-setup-key';
const root = path.resolve(process.env.STATIC_DIR ?? 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(pathname: string, res: http.ServerResponse) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  // Release mirrors survive rebuilds: /downloads/* is served from a sibling folder (dist is wiped by builds).
  if (rel.startsWith('/downloads/')) {
    const dl = path.resolve(root, '..', 'downloads', rel.slice('/downloads/'.length));
    if (dl.startsWith(path.resolve(root, '..'))) {
      try {
        const st = await stat(dl);
        if (!st.isDirectory()) {
          res.writeHead(200, {
            'content-type': TYPES[path.extname(dl)] ?? 'application/octet-stream',
            'cache-control': 'public, max-age=300',
          });
          res.end(await readFile(dl));
          return;
        }
      } catch { /* fall through to normal lookup */ }
    }
  }
  try {
    const st = await stat(file);
    if (st.isDirectory()) {
      res.writeHead(301, { location: pathname + '/' }).end();
      return;
    }
    const ext = path.extname(file);
    const immutable = rel.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
  }
}

http
  .createServer(async (req, res) => {
    try {
      const path = req.url ?? '/';
      if (path.startsWith('/api/') || path.startsWith('/ext/')) {
        await sendWebResponse(await handleWithSimext(await toWebRequest(req)), res);
        return;
      }
      const url = new URL(path, 'http://localhost');
      await serveStatic(url.pathname, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  })
  .listen(port, () => console.log(`ITles: http://localhost:${port}  (DATABASE_URL=${process.env.DATABASE_URL?.split('@').pop()})`));
