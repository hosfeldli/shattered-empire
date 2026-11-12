// Publish native client builds to game.liamhosfeld.com/download (Cloud Storage downloads/, read by the
// game server). Used by CI for the official native build ('native') and the Unity preview
// ('unity-preview'):
//   node tools/publish-downloads.mjs --dir=dist/publish --kind=native --build=<source hash> [--bucket=...]
// Every file goes to its own folder (downloads/<kind>-<build>/), is verified after upload, and only then
// is the manifest updated: the new entries replace the earlier ones of the same kind in the listing,
// while the earlier files stay in storage. Needs gcloud with write access to the bucket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const opts = Object.fromEntries(process.argv.slice(2).map((s) => { const [k, ...v] = s.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const dir = String(opts.dir || ''), kind = String(opts.kind || ''), build = String(opts.build || '');
const bucket = String(opts.bucket || process.env.DOWNLOAD_BUCKET || process.env.SNAPSHOT_BUCKET || 'stem-471602-se-snapshots');
const dry = !!opts['dry-run'];
if (!dir || !['native', 'unity-preview'].includes(kind) || !/^[0-9a-f]{7,40}$/.test(build)) {
  console.error('usage: publish-downloads.mjs --dir=DIR --kind=native|unity-preview --build=HASH [--bucket=B] [--dry-run]');
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
const labels = {
  native: { win: 'Download for Windows', mac: 'Download for macOS' },
  'unity-preview': { win: 'Unity preview for Windows', mac: 'Unity preview for macOS' },
};

const folder = `${kind}-${build}`;
const files = fs.readdirSync(dir).filter((n) => /\.(exe|zip)$/i.test(n)).map((name) => {
  const p = path.join(dir, name), data = fs.readFileSync(p), platform = platformOf(name);
  return { platform, kind, name, label: labels[kind][platform] || name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), path: `${folder}/${name}`, build, date: new Date().toISOString() };
}).filter((f) => f.platform);
if (!files.length) { console.error(`no .exe or .zip builds in ${dir}`); process.exit(1); }

// upload, then confirm each object is complete before anything points at it
for (const f of files) {
  const url = `gs://${bucket}/downloads/${f.path}`;
  gcloud('storage', 'cp', path.join(dir, f.name), url);
  if (!dry) {
    const meta = JSON.parse(gcloud('storage', 'objects', 'describe', url, '--format=json'));
    if (Number(meta.size) !== f.size) throw new Error(`upload of ${f.name} is incomplete (${meta.size} of ${f.size} bytes); manifest not changed`);
  }
}

// merge into the manifest: replace this kind's listing, keep everything else (and every file)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-publish-'));
let manifest = { version: null, files: [] };
try {
  if (!dry) { gcloud('storage', 'cp', `gs://${bucket}/downloads/manifest.json`, path.join(tmp, 'old.json')); manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'old.json'), 'utf8')); }
} catch { console.warn('no existing manifest; starting a new one'); }
const names = new Set(files.map((f) => f.name));
manifest.files = [...(manifest.files || []).filter((f) => f.kind !== kind && !names.has(f.name)), ...files];
if (kind === 'native') manifest.native = { build, date: files[0].date };
if (kind === 'unity-preview') manifest.unity = { build, date: files[0].date };
fs.writeFileSync(path.join(tmp, 'new.json'), JSON.stringify(manifest, null, 2) + '\n');
gcloud('storage', 'cp', path.join(tmp, 'new.json'), `gs://${bucket}/downloads/manifest.json`, '--cache-control=no-cache');
console.log(`published ${kind} ${build}: ${files.map((f) => `${f.name} (${(f.size / 1e6).toFixed(0)} MB)`).join(', ')}`);
