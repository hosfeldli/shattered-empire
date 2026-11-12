// The public site: game.liamhosfeld.com is a downloader for the desktop app, served by the game server
// itself (same load balancer -> Cloud Run path). Builds live in Cloud Storage under downloads/
// (uploaded by the desktop release workflow) with a manifest.json; locally, DOWNLOAD_DIR works too.
//   GET / and /download         the current Windows Unity ZIP
//   GET /api/downloads         the manifest (JSON)
//   GET /download/file/<name>  the installer, streamed (attachment)
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gcsToken } from './storage.js';

const API = 'https://storage.googleapis.com';
// Distribution is Windows Unity only. Retired clients remain in private storage,
// but are neither listed nor served by the public download routes.
function windowsManifest(m) {
  const files = (m.files || []).filter(f => f.platform === 'win' && f.kind === 'unity-preview' && /\.zip$/i.test(f.name))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const file = files[0];
  return { version: m.version ?? null, unity: file ? { build: file.build || m.unity?.build, date: file.date || m.unity?.date } : null,
    files: file ? [file] : [] };
}

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
    cache = windowsManifest(m && Array.isArray(m.files) ? m : { version: null, files: [] }); cacheAt = Date.now();
    return cache;
  }

  // Installers are 90-120 MB. Cloud Run refuses buffered responses over 32 MiB (the client sees a
  // 500), so the file is streamed with chunked transfer encoding and no content-length; the size is
  // on the download page instead.
  async function file(name, res) {
    const m = await manifest();
    const f = m.files.find((x) => x.name === name);
    if (!f || name.includes('/') || name.includes('..')) { res.writeHead(404); return res.end('not found'); }
    const head = { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'public, max-age=3600', 'x-file-size': String(f.size || '') };
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

  async function page(res) {
    const m = await manifest();
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const size = (b) => (b > 1e6 ? (b / 1e6).toFixed(0) + ' MB' : b ? Math.round(b / 1e3) + ' kB' : '');
    const file = m.files[0];
    const download = file ? `<section class="download"><p class="eyebrow">WINDOWS · 64-BIT</p><h2>Ready to reclaim the ruins?</h2><a class="btn" href="/download/file/${encodeURIComponent(file.name)}" download>Download for Windows (ZIP)</a><p class="muted">${size(file.size)} · Unity preview${file.build ? ` · Build ${esc(file.build)}` : ''}</p><ol><li>Save the ZIP and choose <b>Extract All</b> into a local folder.</li><li>Open the extracted folder and run <b>ShatteredEmpires.exe</b>.</li></ol><p class="muted">Keep the accompanying files and folders together. An internet connection is required to play.</p>${file.sha256 ? `<details><summary>Verify your download</summary><p class="checksum">SHA-256: ${esc(file.sha256)}</p></details>` : ''}</section>` : '<section><h2>Windows download</h2><p>The next build is being published. Please try again shortly.</p></section>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shattered Empires — Desktop</title>
<style>body{margin:0;background:radial-gradient(ellipse at top,#23383c,#101b20 75%);color:#e9e4d6;font:16px/1.6 system-ui,sans-serif;min-height:100vh}main{max-width:660px;margin:0 auto;padding:64px 22px}h1{font-family:Georgia,serif;font-weight:400;font-size:clamp(34px,7vw,48px);line-height:1.15;margin:12px 0 20px}h2{font-size:23px;margin:0 0 20px}.eyebrow{color:#d5b877;font-size:12px;letter-spacing:2px;margin:0 0 10px}section{background:#192b30;border:1px solid #3d5050;border-top:2px solid #c3a564;border-radius:6px;padding:26px;margin:32px 0}.btn{display:block;background:#d2b373;color:#13201f;font-size:18px;font-weight:700;padding:15px 18px;border-radius:4px;text-align:center;text-decoration:none}.btn:hover{background:#e4c689}.btn:focus-visible{outline:3px solid #eef4ef;outline-offset:4px}.muted,details{color:#afbfba;font-size:14px}ol{padding-left:22px}li{margin:9px 0}summary{cursor:pointer}.checksum{font:12px/1.6 monospace;overflow-wrap:anywhere}</style></head>
<body><main><p class="eyebrow">RECLAMATION COMMAND</p><h1>Shattered Empires</h1><p>Reclaim ruined cities, develop military bases, and command free-moving armies in a world shaped by war.</p>${download}</main></body></html>`);
  }
  return { manifest, file, page };
}
