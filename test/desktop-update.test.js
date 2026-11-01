// The desktop app's self-update: which published file an install updates from, the version order,
// where a macOS bundle can be replaced, the swap script, and that the manifest marks update packages
// (which the download page hides) apart from installers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { cmpVersion, pickUpdate, macBundle, macSwapScript, winInstallArgs } = require('../desktop/update-core.cjs');

const manifest = { version: '0.1.42', files: [
  { platform: 'mac', arch: 'arm64', kind: 'install', name: 'ShatteredEmpires-0.1.42-mac-arm64.dmg' },
  { platform: 'mac', arch: 'arm64', kind: 'update', name: 'ShatteredEmpires-0.1.42-mac-arm64.zip' },
  { platform: 'mac', arch: 'x64', kind: 'update', name: 'ShatteredEmpires-0.1.42-mac-x64.zip' },
  { platform: 'win', arch: 'x64', kind: 'install', name: 'ShatteredEmpires-0.1.42-win-x64-setup.exe' },
] };

test('versions compare numerically', () => {
  assert.equal(cmpVersion('0.1.42', '0.1.9'), 1);
  assert.equal(cmpVersion('0.1.0', '0.1.0'), 0);
  assert.equal(cmpVersion('0.2.1', '1.0.0'), -1);
  assert.equal(cmpVersion('0.1', '0.1.0'), 0);
});

test('an install picks the update for its platform and architecture, and only when newer', () => {
  assert.equal(pickUpdate(manifest, { version: '0.1.40', platform: 'darwin', arch: 'arm64' }).file.name, 'ShatteredEmpires-0.1.42-mac-arm64.zip');
  assert.equal(pickUpdate(manifest, { version: '0.1.40', platform: 'darwin', arch: 'x64' }).file.name, 'ShatteredEmpires-0.1.42-mac-x64.zip');
  assert.equal(pickUpdate(manifest, { version: '0.1.40', platform: 'win32', arch: 'x64' }).file.name, 'ShatteredEmpires-0.1.42-win-x64-setup.exe', 'Windows updates by running the setup .exe silently');
  assert.equal(pickUpdate(manifest, { version: '0.1.42', platform: 'darwin', arch: 'arm64' }), null, 'already current');
  assert.equal(pickUpdate(manifest, { version: '0.1.50', platform: 'win32', arch: 'x64' }), null, 'never downgrades');
  assert.equal(pickUpdate({ version: '0.1.42', files: manifest.files.filter((f) => f.platform === 'mac') }, { version: '0.1.1', platform: 'win32', arch: 'x64' }), null, 'no build for this platform yet');
  assert.deepEqual(winInstallArgs(), ['/S', '--updated', '--force-run']);
});

test('a macOS bundle is replaced in place only from a real install location', () => {
  assert.equal(macBundle('/Applications/Shattered Empires.app/Contents/MacOS/Shattered Empires').why, '');
  assert.match(macBundle('/Volumes/Shattered Empires/Shattered Empires.app/Contents/MacOS/Shattered Empires').why, /disk image/);
  assert.match(macBundle('/private/var/folders/x/AppTranslocation/ABC/d/Shattered Empires.app/Contents/MacOS/Shattered Empires').why, /Applications/);
});

test('the macOS swap script waits for the app, swaps the bundle and restores it on failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-swap-'));
  const app = path.join(dir, "Shattered Empires's.app"), fresh = path.join(dir, '.new.app');
  fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'v'), 'old');
  fs.mkdirSync(fresh); fs.writeFileSync(path.join(fresh, 'v'), 'new');
  const script = macSwapScript({ pid: 999999, app, fresh, log: path.join(dir, 'log') }).replace(/^open .*$/m, 'true').replace(/^xattr .*$/m, 'true');
  fs.writeFileSync(path.join(dir, 's.sh'), script);
  execFileSync('/bin/sh', [path.join(dir, 's.sh')]);
  assert.equal(fs.readFileSync(path.join(app, 'v'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(fresh) && !fs.existsSync(app + '.old'));
});

test('the manifest marks update packages, and the download page offers only installers', { timeout: 60000 }, async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'se-dist-'));
  for (const n of ['ShatteredEmpires-0.1.7-mac-arm64.dmg', 'ShatteredEmpires-0.1.7-mac-arm64.zip', 'ShatteredEmpires-0.1.7-win-x64-setup.exe', 'ShatteredEmpires-0.1.7-win-x64-setup.exe.blockmap']) fs.writeFileSync(path.join(dist, n), n);
  const m = JSON.parse(execFileSync(process.execPath, [new URL('../desktop/scripts/manifest.mjs', import.meta.url).pathname, dist, '0.1.7'], { encoding: 'utf8' }));
  assert.deepEqual(m.files.map((f) => [f.name.split('-').pop(), f.kind, f.arch]).sort(), [['arm64.dmg', 'install', 'arm64'], ['arm64.zip', 'update', 'arm64'], ['setup.exe', 'install', 'x64']]);
  fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(m));
  const srv = fork(new URL('../server/index.js', import.meta.url).pathname, [], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DOWNLOAD_DIR: dist, SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-dlu-')) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const port = await new Promise((r) => srv.on('message', (x) => x.t === 'listening' && r(x.port)));
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /0\.1\.7-win-x64-setup\.exe/); assert.match(page, /0\.1\.7-mac-arm64\.dmg/);
    assert.doesNotMatch(page, /\.zip/, 'update packages are not offered to people');
    const api = await (await fetch(`http://127.0.0.1:${port}/api/downloads`)).json();
    assert.ok(api.files.some((f) => f.kind === 'update'), 'but apps can find them');
    assert.equal((await fetch(`http://127.0.0.1:${port}/download/file/ShatteredEmpires-0.1.7-mac-arm64.zip`)).status, 200);
  } finally { srv.kill(); }
});
