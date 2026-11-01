// Shattered Empires game server: the authoritative simulation over WebSocket (/ws), a small JSON API,
// and the public web page, which is only a downloader for the desktop app (the client ships inside the
// app). SERVE_CLIENT=1 also serves the client from this server, for development and tests only; the
// deployed image does not contain the client at all.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MatchManager } from './matches.js';
import { makeStore } from './storage.js';
import { continentPreview } from './png.js';
import { makeDownloads } from './downloads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const PORT = +(process.env.PORT || 8080);
const PIXI_VERSION = '8.6.6';
// the desktop edition passes the bundled copy explicitly (works offline)
const PIXI_LOCAL = process.env.PIXI_PATH || path.join(ROOT, 'node_modules', 'pixi.js', 'dist', 'pixi.min.js');
const VERSION = process.env.APP_VERSION || 'dev';
const SERVE_CLIENT = process.env.SERVE_CLIENT === '1' && fs.existsSync(CLIENT);

const log = {
  info: (...a) => console.log(JSON.stringify({ severity: 'INFO', message: a.join(' ') })),
  warn: (...a) => console.log(JSON.stringify({ severity: 'WARNING', message: a.join(' ') })),
  error: (m, e) => console.error(JSON.stringify({ severity: 'ERROR', message: m + ' ' + (e && e.stack ? e.stack : e) })),
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp' };
const manager = new MatchManager(log, makeStore(log));
const downloads = makeDownloads(log);
manager.restoreAll().catch((e) => log.error('restore failed', e));

// The desktop client runs on its own origin (app://game): the API answers cross-origin reads.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v); if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); } }
  // Note: Cloud Run reserves paths ending in 'z' (e.g. /healthz), so production checks use /api/health.
  if (url.pathname === '/api/health' || url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, version: VERSION, ...manager.stats() })); }
  if (url.pathname === '/api/metrics') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(manager.metrics())); }
  if (url.pathname === '/api/matches') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(manager.list())); }
  // the public site: a downloader for the desktop app (same host, same service)
  if ((url.pathname === '/' && !SERVE_CLIENT) || url.pathname === '/index.html' && !SERVE_CLIENT || url.pathname === '/download' || url.pathname === '/download/') { downloads.page(res, req.headers['user-agent'] || '').catch((e) => { log.error('download page', e); res.writeHead(500); res.end(); }); return; }
  if (url.pathname === '/api/downloads') { downloads.manifest().then((m) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(JSON.stringify(m)); }); return; }
  if (url.pathname.startsWith('/download/file/')) { downloads.file(decodeURIComponent(url.pathname.slice(15)), res).catch((e) => { log.error('download', e); if (!res.headersSent) res.writeHead(502); res.end(); }); return; }
  if (url.pathname === '/api/preview') {
    const seed = (+url.searchParams.get('seed') || 1) % 1000000, scale = Math.max(2, Math.min(12, +url.searchParams.get('scale') || 6));
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
    return res.end(continentPreview(seed, scale));
  }
  if (!SERVE_CLIENT) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Shattered Empires is played in the desktop app: https://game.liamhosfeld.com/'); }
  // ---- development and tests only: the client, served the way the desktop app bundles it
  if (url.pathname === '/vendor/pixi.min.js') {
    if (fs.existsSync(PIXI_LOCAL)) { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'public, max-age=86400' }); return fs.createReadStream(PIXI_LOCAL).pipe(res); }
    res.writeHead(302, { location: `https://cdn.jsdelivr.net/npm/pixi.js@${PIXI_VERSION}/dist/pixi.min.js` }); return res.end();
  }
  // pure simulation helpers the browser runs too (same code for previews and authority)
  if (url.pathname === '/shared/deploy.js') { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' }); return fs.createReadStream(new URL('./sim/deploy.js', import.meta.url)).pipe(res); }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(CLIENT, p));
  if (!file.startsWith(CLIENT)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', etag });
    fs.createReadStream(file).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 1024 } });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  manager.attach(ws);
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 25_000);

server.listen(PORT, process.env.HOST || undefined, () => { log.info(`Shattered Empires server ${VERSION} listening on :${server.address().port}`); process.send?.({ t: 'listening', port: server.address().port }); });

// Cloud Run sends SIGTERM before replacing an instance: snapshot every live match first so the
// next revision resumes them and players reconnect automatically.
async function shutdown() {
  log.info('shutting down: saving matches');
  clearInterval(heartbeat);
  setTimeout(() => process.exit(0), 9000).unref();
  try { await manager.shutdown(); } catch (e) { log.error('save on shutdown failed', e); }
  for (const ws of wss.clients) ws.close(1012, 'server restarting');
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
export { server, manager };

// the desktop edition asks over IPC (Windows children get no SIGTERM): save matches, then exit
process.on('message', (m) => { if (m && m.t === 'shutdown') shutdown(); });
