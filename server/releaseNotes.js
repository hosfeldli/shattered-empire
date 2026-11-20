// Release notes for the in-app "What's new" changelog (docs/RELEASING.md).
//   GET /api/release-notes/index             every version, newest first: {schema, latest, versions[{version, date,
//                                            title, summary, since, sections[{heading, category}], fixes}]}
//   GET /api/release-notes/latest            the notes of the published client version
//   GET /api/release-notes/<version>         one version's notes.json
//   GET /api/release-notes/<version>/<image> an image those notes reference (png/jpg)
// Production reads the bucket (downloads/release-notes/<version>/, uploaded by tools/release.ps1 next to the ZIP;
// "latest" is the manifest entry's notes.version). Locally (no bucket, DOWNLOAD_DIR set, or RELEASE_NOTES_DIR)
// it reads docs/releases/<version>/ from the repository, where "latest" is the highest version folder.
// The index lists the bucket's release-notes/ folders (none newer than "latest", no drafts) or, locally, every
// folder (drafts included and flagged); it is cached for 5 minutes like the notes.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gcsToken } from './storage.js';

const API = 'https://storage.googleapis.com';
const VERSION = /^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.(png|jpe?g)$/;
const LOCAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'releases');

function cmp(a, b) {
  const pa = a.split(/[.-]/), pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) { if (+x !== +y) return +x - +y; continue; }
    if (x !== y) return x === '' ? 1 : y === '' ? -1 : x < y ? -1 : 1;
  }
  return 0;
}

export function makeReleaseNotes(log, downloads) {
  const bucket = process.env.DOWNLOAD_DIR ? null : process.env.DOWNLOAD_BUCKET || process.env.SNAPSHOT_BUCKET || null;
  const dir = process.env.RELEASE_NOTES_DIR || (bucket ? '' : LOCAL);
  const cache = new Map();   // version -> { at, notes } (bucket only; 5 min)
  let indexCache = null;     // { at, body } (bucket only; 5 min)

  async function storage(object) {
    return fetch(`${API}/storage/v1/b/${bucket}/o/${encodeURIComponent('downloads/release-notes/' + object)}?alt=media`, { headers: { authorization: 'Bearer ' + (await gcsToken()) } });
  }

  async function latest() {
    if (dir) {
      const vs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((v) => VERSION.test(v) && fs.existsSync(path.join(dir, v, 'notes.json'))).sort(cmp) : [];
      return vs.pop() || null;
    }
    const m = await downloads.manifest();
    const v = m.files?.[0]?.notes?.version || m.version;
    return typeof v === 'string' && VERSION.test(v) ? v : null;
  }

  async function notes(version) {
    if (dir) {
      const p = path.join(dir, version, 'notes.json');
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    }
    if (!bucket) return null;
    const hit = cache.get(version);
    if (hit && Date.now() - hit.at < 300_000) return hit.notes;
    const r = await storage(`${version}/notes.json`);
    const n = r.ok ? await r.json() : null;
    if (cache.size > 32) cache.clear();
    cache.set(version, { at: Date.now(), notes: n });
    return n;
  }

  /** Every version folder there is: the bucket listing (paged) or the local notes directory. */
  async function folders() {
    if (dir) return fs.existsSync(dir) ? fs.readdirSync(dir).filter((v) => VERSION.test(v) && fs.existsSync(path.join(dir, v, 'notes.json'))) : [];
    if (!bucket) return [];
    const out = [];
    let page = '';
    for (let i = 0; i < 20; i++) {
      const q = `prefix=${encodeURIComponent('downloads/release-notes/')}&delimiter=${encodeURIComponent('/')}&fields=prefixes,nextPageToken${page ? '&pageToken=' + encodeURIComponent(page) : ''}`;
      const r = await fetch(`${API}/storage/v1/b/${bucket}/o?${q}`, { headers: { authorization: 'Bearer ' + (await gcsToken()) } });
      if (!r.ok) throw new Error('release notes listing: storage ' + r.status);
      const j = await r.json();
      for (const p of j.prefixes || []) { const v = p.slice('downloads/release-notes/'.length).replace(/\/$/, ''); if (VERSION.test(v)) out.push(v); }
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out;
  }

  /** One index entry: what the changelog's version list and table of contents need, not the blocks. */
  function entry(n, v) {
    const e = {
      version: v, date: typeof n.date === 'string' ? n.date : '', title: typeof n.title === 'string' ? n.title : '',
      summary: typeof n.summary === 'string' ? n.summary : '', since: typeof n.since?.version === 'string' ? n.since.version : '',
      sections: (Array.isArray(n.sections) ? n.sections : []).filter((s) => s && typeof s.heading === 'string')
        .map((s) => ({ heading: s.heading, category: typeof s.category === 'string' ? s.category : 'other' })),
      fixes: Array.isArray(n.fixes) ? n.fixes.length : 0,
    };
    if (n.draft === true) e.draft = true;
    return e;
  }

  async function index() {
    if (!dir && indexCache && Date.now() - indexCache.at < 300_000) return indexCache.body;
    try {
      const top = await latest();
      const vs = (await folders()).filter((v) => dir || !top || cmp(v, top) <= 0).sort(cmp).reverse();
      const all = await Promise.all(vs.map(async (v) => { try { return [v, await notes(v)]; } catch { return [v, null]; } }));
      const versions = all.filter(([v, n]) => n && typeof n === 'object' && n.version === v && (dir || n.draft !== true)).map(([v, n]) => entry(n, v));
      const body = { schema: 1, latest: top, versions };
      if (!dir) indexCache = { at: Date.now(), body };
      return body;
    } catch (e) {
      if (indexCache) { log.warn?.('release notes index (serving the cached one): ' + e.message); return indexCache.body; }
      throw e;
    }
  }

  function send(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': code === 200 ? 'public, max-age=60' : 'no-store' });
    res.end(JSON.stringify(body));
  }

  /** Handles /api/release-notes/...; the caller already set the CORS headers. */
  async function handle(pathname, res) {
    const parts = pathname.slice('/api/release-notes/'.length).split('/').map((s) => decodeURIComponent(s));
    let [version, file] = parts;
    if (parts.length > 2 || !version) return send(res, 404, { error: 'not found' });
    if (version === 'index' && !file) return send(res, 200, await index());
    if (version === 'latest' && !file) version = await latest();
    if (!version || !VERSION.test(version)) return send(res, 404, { error: 'no release notes' });
    if (!file) {
      const n = await notes(version);
      return n ? send(res, 200, n) : send(res, 404, { error: 'no release notes for ' + version });
    }
    if (!IMAGE.test(file)) return send(res, 404, { error: 'not found' });
    const type = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    const head = { 'content-type': type, 'cache-control': 'public, max-age=86400' };
    if (dir) {
      const p = path.join(dir, version, file);
      if (!fs.existsSync(p)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, head); return fs.createReadStream(p).pipe(res);
    }
    if (!bucket) return send(res, 404, { error: 'not found' });
    const r = await storage(`${version}/${file}`);
    if (!r.ok || !r.body) { log.warn?.(`release notes ${version}/${file}: storage ${r.status}`); return send(res, r.status === 404 ? 404 : 502, { error: 'unavailable' }); }
    res.writeHead(200, head);
    Readable.fromWeb(r.body).on('error', (e) => res.destroy(e)).pipe(res);
  }

  return { handle, latest, notes, index };
}
