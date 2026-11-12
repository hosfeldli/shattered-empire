// Publish the Windows Unity ZIP to game.liamhosfeld.com/download.
//   node tools/publish-downloads.mjs --dir=dist/publish --kind=unity-preview --build=<source hash> [--bucket=...]
// Every file goes to its own folder (downloads/<kind>-<build>/), is verified after upload, and only then
// is the manifest replaced with the Windows Unity listing. Earlier files stay in private storage.
// Mac and Godot downloads are retired. Needs gcloud with write access to the bucket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const opts = Object.fromEntries(process.argv.slice(2).map((s) => { const [k, ...v] = s.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const dir = String(opts.dir || ''), kind = String(opts.kind || ''), build = String(opts.build || '');
const bucket = String(opts.bucket || process.env.DOWNLOAD_BUCKET || process.env.SNAPSHOT_BUCKET || 'stem-471602-se-snapshots');
const dry = !!opts['dry-run'];
if (!dir || kind !== 'unity-preview' || !/^[0-9a-f]{7,40}$/.test(build)) {
  console.error('usage: publish-downloads.mjs --dir=DIR --kind=unity-preview --build=HASH [--bucket=B] [--dry-run] (Windows ZIP only)');
  process.exit(2);
}
// Windows installs gcloud as a .cmd wrapper, which execFile cannot start directly.
// Invoke the SDK's Python entry point with separate arguments; no shell quoting is involved.
const sdkRoot = process.env.CLOUDSDK_ROOT_DIR || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk') : '');
const gcloudProgram = process.platform === 'win32'
  ? process.env.CLOUDSDK_PYTHON || path.join(sdkRoot, 'platform', 'bundledpython', 'python.exe') : 'gcloud';
const gcloudPrefix = process.platform === 'win32' ? [path.join(sdkRoot, 'lib', 'gcloud.py')] : [];
const gcloud = (...args) => (dry ? (console.log('[dry-run] gcloud', args.join(' ')), '')
  : execFileSync(gcloudProgram, [...gcloudPrefix, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
const platformOf = (n) => (/mac|osx|darwin/i.test(n) ? 'mac' : /win/i.test(n) || /\.exe$/i.test(n) ? 'win' : /linux/i.test(n) ? 'linux' : null);

const folder = `${kind}-${build}`;
const files = fs.readdirSync(dir).filter((n) => /\.zip$/i.test(n) && platformOf(n) === 'win').map((name) => {
  const p = path.join(dir, name), data = fs.readFileSync(p), platform = platformOf(name);
  return { platform, kind, name, label: 'Download for Windows (ZIP)', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), path: `${folder}/${name}`, build, date: new Date().toISOString() };
});
if (files.length !== 1) { console.error(`expected one Windows Unity ZIP in ${dir}`); process.exit(1); }

// upload, then confirm each object is complete before anything points at it
for (const f of files) {
  const url = `gs://${bucket}/downloads/${f.path}`;
  gcloud('storage', 'cp', path.join(dir, f.name), url);
  if (!dry) {
    const meta = JSON.parse(gcloud('storage', 'objects', 'describe', url, '--format=json'));
    if (Number(meta.size) !== f.size) throw new Error(`upload of ${f.name} is incomplete (${meta.size} of ${f.size} bytes); manifest not changed`);
  }
}

// Retire previous distribution entries without deleting their private storage objects.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-publish-'));
let manifest = { version: null, files: [] };
try {
  if (!dry) { gcloud('storage', 'cp', `gs://${bucket}/downloads/manifest.json`, path.join(tmp, 'old.json')); manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'old.json'), 'utf8')); }
} catch { console.warn('no existing manifest; starting a new one'); }
manifest = { version: manifest.version ?? null, unity: { build, date: files[0].date }, files };
fs.writeFileSync(path.join(tmp, 'new.json'), JSON.stringify(manifest, null, 2) + '\n');
gcloud('storage', 'cp', path.join(tmp, 'new.json'), `gs://${bucket}/downloads/manifest.json`, '--cache-control=no-cache');
console.log(`published ${kind} ${build}: ${files.map((f) => `${f.name} (${(f.size / 1e6).toFixed(0)} MB)`).join(', ')}`);
