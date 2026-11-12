// Self-update logic shared by the app and its tests (no Electron here).
//
// The download site's manifest (GET /api/downloads) lists every published file with its platform,
// architecture and kind: 'install' files are what people download from the site (the macOS .dmg,
// the Windows setup .exe); 'update' files are what a running app fetches to replace itself (the
// macOS .app zipped for its architecture; on Windows the same setup .exe, run silently).
const path = require('node:path');

// "0.1.42" > "0.1.9"; anything unparsable counts as 0
function cmpVersion(a, b) {
  const pa = String(a || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0), pb = String(b || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// the file this install should update from, or null when there is none newer
function pickUpdate(manifest, { version, platform, arch }) {
  if (!manifest || !Array.isArray(manifest.files) || cmpVersion(manifest.version, version) <= 0) return null;
  const plat = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform;
  const cands = manifest.files.filter((f) => f.platform === plat && (f.kind === 'update' || (plat === 'win' && /\.exe$/i.test(f.name))));
  const f = cands.find((x) => (x.arch || archOf(x.name)) === arch) || (plat === 'win' ? cands[0] : null);
  return f ? { version: manifest.version, file: f } : null;
}
function archOf(name) { return /arm64/i.test(name) ? 'arm64' : /x64|x86_64|amd64/i.test(name) ? 'x64' : ''; }

// macOS: where the running .app bundle lives, and whether it can be replaced in place (not from the
// disk image, not from a translocated read-only copy in Downloads)
function macBundle(execPath) {
  const app = path.posix.resolve(execPath, '..', '..', '..');
  if (!app.endsWith('.app')) return { app: null, why: 'not running from an app bundle' };
  if (app.startsWith('/Volumes/')) return { app, why: 'running from the disk image: drag Shattered Empires to Applications first' };
  if (app.includes('/AppTranslocation/')) return { app, why: 'macOS is running a protected copy: move Shattered Empires to Applications and open it from there' };
  return { app, why: '' };
}

// macOS: a small detached script that waits for this process to exit, swaps the bundle and reopens it
function macSwapScript({ pid, app, fresh, log }) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return [
    '#!/bin/sh',
    `exec >>${q(log)} 2>&1`,
    `while kill -0 ${pid | 0} 2>/dev/null; do sleep 0.3; done`,
    `xattr -dr com.apple.quarantine ${q(fresh)} 2>/dev/null`,
    `rm -rf ${q(app + '.old')}`,
    `mv ${q(app)} ${q(app + '.old')} && mv ${q(fresh)} ${q(app)} && rm -rf ${q(app + '.old')} || { echo 'swap failed, restoring'; [ -d ${q(app + '.old')} ] && [ ! -d ${q(app)} ] && mv ${q(app + '.old')} ${q(app)}; }`,
    `open ${q(app)}`,
    '',
  ].join('\n');
}

// Windows: the setup .exe installs silently over the current install (per-user, no prompts) and
// starts the game again when it is done
const winInstallArgs = () => ['/S', '--updated', '--force-run'];

module.exports = { cmpVersion, pickUpdate, archOf, macBundle, macSwapScript, winInstallArgs };
