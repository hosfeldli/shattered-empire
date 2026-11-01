// The public site: game.liamhosfeld.com is a downloader for the desktop app, served by the game server
// itself (same load balancer -> Cloud Run path). Builds live in Cloud Storage under downloads/
// (uploaded by the desktop release workflow) with a manifest.json; locally, DOWNLOAD_DIR works too.
//   GET / and /download         page with the latest build for each platform
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

  // Installers are 90-120 MB. Cloud Run refuses buffered responses over 32 MiB (the client sees a
  // 500), so the file is streamed with chunked transfer encoding and no content-length; the size is
  // on the download page instead.
  async function file(name, res) {
    const m = await manifest();
    const f = m.files.find((x) => x.name === name);
    if (!f || name.includes('/') || name.includes('..')) { res.writeHead(404); return res.end('not found'); }
    const head = { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'public, max-age=3600', 'x-file-size': String(f.size || '') };
    if (dir) {
      const p = path.join(dir, name); if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, head); return fs.createReadStream(p).pipe(res);
    }
    const r = await fetch(`${API}/storage/v1/b/${bucket}/o/${encodeURIComponent('downloads/' + (f.path || name))}?alt=media`, { headers: { authorization: 'Bearer ' + (await gcsToken()) } });
    if (!r.ok || !r.body) { log.warn?.(`download ${name}: storage ${r.status}`); res.writeHead(502); return res.end('download unavailable'); }
    res.writeHead(200, head);
    const body = Readable.fromWeb(r.body);
    body.on('error', (e) => { log.warn?.(`download ${name} interrupted: ${e.message}`); res.destroy(e); });
    res.on('close', () => body.destroy());
    body.pipe(res);
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
<style>body{margin:0;background:#122025;color:#e9e4d6;font:16px/1.5 'Barlow Semi Condensed',system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:40px 16px}h1{font-family:'IM Fell English SC',Georgia,serif;font-weight:400;font-size:40px;margin:0 0 8px}h2{font-size:20px;margin:0 0 8px}section{background:#1a2c32;border:1px solid #2c3d40;border-radius:6px;padding:14px 16px;margin:12px 0}section.you{border-color:#d9a43a}img.map{width:100%;max-height:240px;object-fit:cover;border-radius:6px;margin:8px 0 12px;image-rendering:pixelated}.btn{display:inline-block;background:#d9a43a;color:#13201f;font-weight:700;padding:8px 14px;border-radius:4px;text-decoration:none;margin:4px 8px 4px 0}.muted{color:#9fb0ab;font-size:14px}a{color:#d9a43a}small{font-weight:400;color:#9fb0ab}</style></head>
<body><main><h1>Shattered Empires</h1><img class="map" src="/api/preview?seed=${Date.now() % 100000}" alt="A generated continent"><p>A grand-scale strategy game on a continent that is still tearing itself apart. Download the game for Windows or macOS; every match is played on the game servers here, against the AI or with friends (Steam invites included).${m.version ? ` Latest version <b>${esc(m.version)}</b>${m.date ? ` (${esc(m.date.slice(0, 10))})` : ''}.` : ''}</p>${rows}
<p class="muted">macOS: open the .dmg and drag Shattered Empires to Applications (first launch of an unsigned build: right-click the app → Open). Windows: run the installer (SmartScreen may ask: More info → Run anyway). An internet connection is required to play.</p></main></body></html>`);
  }
  return { manifest, file, page };
}
