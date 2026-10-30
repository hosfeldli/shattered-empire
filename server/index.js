// Shattered Empires game server: static client + WebSocket simulation host.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MatchManager } from './matches.js';
import { continentPreview } from './png.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const PORT = +(process.env.PORT || 8080);
const PIXI_VERSION = '8.6.6';
const PIXI_LOCAL = path.join(ROOT, 'node_modules', 'pixi.js', 'dist', 'pixi.min.js');
const VERSION = process.env.APP_VERSION || 'dev';

const log = {
  info: (...a) => console.log(JSON.stringify({ severity: 'INFO', message: a.join(' ') })),
  warn: (...a) => console.log(JSON.stringify({ severity: 'WARNING', message: a.join(' ') })),
  error: (m, e) => console.error(JSON.stringify({ severity: 'ERROR', message: m + ' ' + (e && e.stack ? e.stack : e) })),
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const manager = new MatchManager(log);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, version: VERSION, ...manager.stats() })); }
  if (url.pathname === '/api/matches') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(manager.list())); }
  if (url.pathname === '/api/preview') {
    const seed = (+url.searchParams.get('seed') || 1) % 1000000;
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
    return res.end(continentPreview(seed));
  }
  if (url.pathname === '/vendor/pixi.min.js') {
    if (fs.existsSync(PIXI_LOCAL)) { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'public, max-age=86400' }); return fs.createReadStream(PIXI_LOCAL).pipe(res); }
    res.writeHead(302, { location: `https://cdn.jsdelivr.net/npm/pixi.js@${PIXI_VERSION}/dist/pixi.min.js` }); return res.end();
  }
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

server.listen(PORT, () => log.info(`Shattered Empires server ${VERSION} listening on :${PORT}`));

function shutdown() {
  log.info('shutting down');
  clearInterval(heartbeat);
  manager.shutdown();
  for (const ws of wss.clients) ws.close(1012, 'server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
export { server, manager };
