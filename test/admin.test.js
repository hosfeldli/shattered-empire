// Server administration: only the administrator's name with the right PIN signs in, wrong guesses
// are rate-limited, and closing a match ends it for its players (who are told why) and removes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Admin } from '../server/admin.js';

function waitFor(ws, pred, ms = 20000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.off('message', on); reject(new Error('timeout')); }, ms);
    const on = (raw) => { const m = JSON.parse(raw); if (pred(m)) { clearTimeout(to); ws.off('message', on); resolve(m); } };
    ws.on('message', on);
  });
}
async function connect(port) { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); await new Promise((r) => ws.on('open', r)); return ws; }

test('admin sign-in checks name and PIN and limits guessing', () => {
  const sent = [];
  const admin = new Admin({ matches: new Map(), send: (_ws, m) => sent.push(m) }, { warn() {}, info() {} });
  const ws = { addr: '1.2.3.4' };
  assert.ok(admin.login(ws, 'Liam6642', '0000').error, 'wrong PIN');
  assert.ok(admin.login(ws, 'liam6642', '6642').error, 'name must match exactly');
  assert.ok(!ws.isAdmin);
  admin.handle(ws, { action: 'list' });
  assert.match(sent.pop().error, /Sign in/, 'nothing without signing in');
  assert.ok(admin.login(ws, 'Liam6642', '6642').ok);
  assert.ok(ws.isAdmin);
  const other = { addr: '5.6.7.8' };
  for (let i = 0; i < 5; i++) admin.login(other, 'Liam6642', String(1000 + i));
  assert.match(admin.login(other, 'Liam6642', '6642').error, /Too many/, 'locked out after five wrong PINs, even with the right one');
});

test('the administrator closes a running match; its player is sent back with the reason', { timeout: 90000 }, async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-adm-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) r(); }));
  try {
    const player = await connect(port);
    player.send(JSON.stringify({ t: 'create', mode: 'ai', ais: 1, name: 'P', seed: 3 }));
    const joined = await waitFor(player, (m) => m.t === 'joined');
    await waitFor(player, (m) => m.t === 'welcome');
    const adm = await connect(port);
    adm.send(JSON.stringify({ t: 'admin', action: 'list' }));
    assert.match((await waitFor(adm, (m) => m.t === 'admin')).error, /Sign in/);
    adm.send(JSON.stringify({ t: 'admin', action: 'login', name: 'Liam6642', pin: '6642' }));
    const list = await waitFor(adm, (m) => m.t === 'admin');
    assert.equal(list.ok, true);
    assert.ok(list.matches.some((m) => m.id === joined.match && m.players[0].connected));
    const closed = waitFor(player, (m) => m.t === 'closed');
    adm.send(JSON.stringify({ t: 'admin', action: 'close', match: joined.match }));
    const r = await waitFor(adm, (m) => m.t === 'admin');
    assert.deepEqual(r.closed, [joined.match]);
    assert.ok(!r.matches.some((m) => m.id === joined.match));
    assert.match((await closed).reason, /administrator/);
    const pub = await (await fetch(`http://127.0.0.1:${port}/api/matches`)).json();
    assert.ok(!pub.some((m) => m.id === joined.match), 'gone from the server');
    player.close(); adm.close();
  } finally { srv.kill(); }
});
