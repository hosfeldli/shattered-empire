// End-to-end protocol tests against a real server process: lobby, fog-filtered streaming,
// commands, and match persistence across a server restart (what happens on every deploy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const SNAP = fs.mkdtempSync(path.join(os.tmpdir(), 'se-snap-'));

function boot(port) {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), SNAPSHOT_DIR: SNAP, AUTOSAVE_SECONDS: '5' }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(srv); }));
}
function waitFor(ws, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.off('message', on); reject(new Error('timeout')); }, ms);
    const on = (raw) => { const m = JSON.parse(raw); if (pred(m)) { clearTimeout(to); ws.off('message', on); resolve(m); } };
    ws.on('message', on);
  });
}
async function connect(port) { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); await new Promise((r) => ws.on('open', r)); return ws; }
const stop = (srv) => new Promise((r) => { srv.on('exit', r); srv.kill('SIGTERM'); });

test('server hosts a match end-to-end and resumes it after a restart', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  let srv = await boot(port);
  let session;
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /Shattered Empires/);
    const ws = await connect(port);
    ws.send(JSON.stringify({ t: 'create', mode: 'ai', ais: 1, name: 'Tester', seed: 7 }));
    const joined = await waitFor(ws, (m) => m.t === 'joined');
    session = { match: joined.match, token: joined.token };
    const welcome = await waitFor(ws, (m) => m.t === 'welcome');
    assert.equal(welcome.civId, 0);
    assert.ok(welcome.defs.UNITS.tank && welcome.defs.TECHS.drones, 'modern unit and tech defs');
    const snap = await waitFor(ws, (m) => m.t === 's' && m.econ);
    assert.ok(snap.tiles.length > 50, 'initial explored tiles');
    assert.ok(snap.units.every((u) => u[1] === 0), 'no enemy units leak through fog at start');
    const scout = snap.units.find((u) => u[2] === 'scout_buggy');
    ws.send(JSON.stringify({ t: 'cmd', rid: 1, cmd: { c: 'move', units: [scout[0]], tile: scout[3] + 3 } }));
    const ack = await waitFor(ws, (m) => m.rid === 1);
    assert.equal(ack.error, undefined);
    ws.send(JSON.stringify({ t: 'cmd', rid: 2, cmd: { c: 'placement', type: 'house' } }));
    const pl = await waitFor(ws, (m) => m.rid === 2);
    assert.ok(pl.tiles.length > 0, 'server computes valid placements');
    ws.send(JSON.stringify({ t: 'cmd', rid: 3, cmd: { c: 'build', type: 'house', tile: pl.tiles[0] } }));
    assert.equal((await waitFor(ws, (m) => m.rid === 3)).error, undefined);
    const moved = await waitFor(ws, (m) => m.t === 's' && m.paths && m.paths[scout[0]]);
    assert.ok(moved.paths[scout[0]].length > 0, 'server-side path returned');
    // let an autosave happen, then restart the server like a deploy would
    await new Promise((r) => setTimeout(r, 6500));
    ws.close();
  } finally { await stop(srv); }
  srv = await boot(port);
  try {
    const ws = await connect(port);
    ws.send(JSON.stringify({ t: 'rejoin', ...session }));
    const welcome = await waitFor(ws, (m) => m.t === 'welcome');
    assert.ok(welcome.time >= 5, 'match resumed from its snapshot, not restarted: t=' + welcome.time);
    const snap = await waitFor(ws, (m) => m.t === 's' && m.econ);
    assert.ok(snap.buildings.some((b) => b.ty === 'house' && b.o === 0), 'the house built before the restart is still there');
    ws.close();
  } finally { await stop(srv); }
});
