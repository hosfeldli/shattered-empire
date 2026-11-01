// Desktop downloads served from the game's own host (game.liamhosfeld.com/download), through the
// same load balancer -> Cloud Run path as the game. Builds live in Cloud Storage under downloads/
// (uploaded by the desktop release workflow) with a manifest.json; locally, DOWNLOAD_DIR works too.
//   GET /download              page with the latest build for each platform
//   GET /api/downloads         the manifest (JSON)
//   GET /download/file/<name>  the installer, streamed (attachment)
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gcsToken } from './storage.js';

const API = 'https://storage.googleapis.com';
const PLATFORMS = { win: 'Windows', mac: 'macOS' };

export function makeDownloads(log) {
  const dir = process.env.DOWNLOAD_DIR || '';
  const bucket = dir ? null : process.env.DOWNLOAD_BUCKET || process.env.SNAPSHOT_BUCKET || null;
  let cache = null, cacheAt = 0;

  async function manifest() {
    if (cache && Date.now() - cacheAt < 60_000) return cache;
    let m = null;
    try {
      if (dir) m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      else if (bucket) {
        const r = await fetch(`${API}/storage/v1/b/${bucket}/o/${encodeURIComponent('downloads/manifest.json')}?alt=media`, { headers: { authorization: 'Bearer ' + (await gcsToken()) } });
        if (r.ok) m = await r.json();
      }
    } catch (e) { log.warn?.('downloads manifest: ' + e.message); }
    cache = m && Array.isArray(m.files) ? m : { version: null, files: [] }; cacheAt = Date.now();
    return cache;
  }

  async function file(name, res) {
    const m = await manifest();
    const f = m.files.find((x) => x.name === name);
    if (!f || name.includes('/') || name.includes('..')) { res.writeHead(404); return res.end('not found'); }
    const head = { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'public, max-age=3600' };
    if (dir) {
      const p = path.join(dir, name); if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { ...head, 'content-length': fs.statSync(p).size }); return fs.createReadStream(p).pipe(res);
    }
    const r = await fetch(`${API}/storage/v1/b/${bucket}/o/${encodeURIComponent('downloads/' + (f.path || name))}?alt=media`, { headers: { authorization: 'Bearer ' + (await gcsToken()) } });
    if (!r.ok || !r.body) { res.writeHead(502); return res.end('download unavailable'); }
    res.writeHead(200, { ...head, ...(r.headers.get('content-length') ? { 'content-length': r.headers.get('content-length') } : {}) });
    Readable.fromWeb(r.body).pipe(res);
  }

  async function page(res, ua = '') {
    const m = await manifest();
    const guess = /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'win' : /Linux/.test(ua) ? 'linux' : '';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const size = (b) => (b > 1e6 ? (b / 1e6).toFixed(0) + ' MB' : b ? Math.round(b / 1e3) + ' kB' : '');
    const rows = Object.entries(PLATFORMS).map(([k, label]) => {
      const fs2 = m.files.filter((f) => f.platform === k);
      return `<section class="${k === guess ? 'you' : ''}"><h2>${label}${k === guess ? ' <small>(your system)</small>' : ''}</h2>${fs2.length ? fs2.map((f) => `<a class="btn" href="/download/file/${encodeURIComponent(f.name)}">${esc(f.label || f.name)}</a> <span class="muted">${size(f.size)}${f.sha256 ? ` · sha256 ${esc(f.sha256.slice(0, 12))}…` : ''}</span>`).join('<br>') : '<p class="muted">No build yet.</p>'}</section>`;
    }).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shattered Empires — Desktop</title>
<style>body{margin:0;background:#122025;color:#e9e4d6;font:16px/1.5 'Barlow Semi Condensed',system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:40px 16px}h1{font-family:'IM Fell English SC',Georgia,serif;font-weight:400;font-size:40px;margin:0 0 8px}h2{font-size:20px;margin:0 0 8px}section{background:#1a2c32;border:1px solid #2c3d40;border-radius:6px;padding:14px 16px;margin:12px 0}section.you{border-color:#d9a43a}.btn{display:inline-block;background:#d9a43a;color:#13201f;font-weight:700;padding:8px 14px;border-radius:4px;text-decoration:none;margin:4px 8px 4px 0}.muted{color:#9fb0ab;font-size:14px}a{color:#d9a43a}small{font-weight:400;color:#9fb0ab}</style></head>
<body><main><h1>Shattered Empires</h1><p>The desktop edition runs the same game and server on your own computer: play offline against the AI with saves on your disk, connect to this server for online matches, or host friends over Steam.${m.version ? ` Latest version <b>${esc(m.version)}</b>${m.date ? ` (${esc(m.date.slice(0, 10))})` : ''}.` : ''}</p>${rows}
<p class="muted">macOS: open the .dmg and drag the app to Applications (first launch: right-click → Open if Gatekeeper warns about an unsigned build). Windows: run the installer.</p><p><a href="/">← Play in the browser</a></p></main></body></html>`);
  }
  return { manifest, file, page };
}
