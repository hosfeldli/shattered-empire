// The download page and installer downloads. Installers are larger than Cloud Run's 32 MiB limit for
// buffered responses, so they must stream (chunked, no content-length).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('download page lists the builds; installers stream without a content-length', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-dl-'));
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(dir, 'ShatteredEmpires-9.9.9-win-x64-setup.exe'), big);
  fs.writeFileSync(path.join(dir, 'native-mac.zip'), 'native preview');
  fs.writeFileSync(path.join(dir, 'native-win.exe'), 'native official');
  fs.writeFileSync(path.join(dir, 'unity-win.zip'), 'unity preview');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '9.9.9', files: [
    { platform: 'win', name: 'ShatteredEmpires-9.9.9-win-x64-setup.exe', size: big.length, label: 'Download for Windows' },
    { platform: 'mac', kind: 'native-preview', name: 'native-mac.zip', label: 'Native preview for macOS' },
    { platform: 'win', kind: 'native', name: 'native-win.exe', label: 'Download for Windows', build: 'abc123def456' },
    { platform: 'win', kind: 'unity-preview', name: 'unity-win.zip', label: 'Unity preview for Windows' },
    { platform: 'mac', kind: 'update', name: 'update.zip' }] }));
  const srv = fork(fileURLToPath(new URL('../server/index.js', import.meta.url)), [], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DOWNLOAD_DIR: dir, SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-dls-')) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const port = await new Promise((r) => srv.on('message', (m) => m.t === 'listening' && r(m.port)));
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    // the official build is the newest native client; Electron installers are no longer offered
    assert.match(page, /\/download\/file\/native-win\.exe/); assert.match(page, /abc123def456/);
    assert.doesNotMatch(page, /ShatteredEmpires-9\.9\.9-win-x64-setup\.exe/);
    assert.doesNotMatch(page, /\/download\/file\/native-mac\.zip/, 'older previews give way once an official native build exists');
    assert.doesNotMatch(page, /\/download\/file\/update\.zip/);
    assert.match(page, /\/download\/file\/unity-win\.zip/); assert.match(page, /New engine preview/);
    assert.match(page, /not notarized/); assert.match(page, /do not auto-update/);
    // retired Electron files stay downloadable for links already shared
    const r = await fetch(`http://127.0.0.1:${port}/download/file/ShatteredEmpires-9.9.9-win-x64-setup.exe`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), null, 'streamed, not buffered');
    assert.match(r.headers.get('content-disposition'), /attachment/);
    assert.equal(Buffer.from(await r.arrayBuffer()).length, big.length);
    assert.equal((await fetch(`http://127.0.0.1:${port}/download/file/nope.exe`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/download/file/..%2Fmanifest.json`)).status, 404);
  } finally { srv.kill(); }
});
