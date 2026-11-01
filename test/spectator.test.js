// Spectator mode: an AI-only match watched without fog of war, with civ following, fog toggle,
// speed control, and orders refused. Runs against a real server process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

function boot(port) {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-obs-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(srv); }));
}
function waitFor(ws, pred, ms = 20000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.off('message', on); reject(new Error('timeout')); }, ms);
    const on = (raw) => { const m = JSON.parse(raw); if (pred(m)) { clearTimeout(to); ws.off('message', on); resolve(m); } };
    ws.on('message', on);
  });
}

test('AI-only spectator match: whole map visible, follow + fog toggle, speed control, no orders', { timeout: 180000 }, async () => {
  const port = 17000 + Math.floor(Math.random() * 900);
  const srv = await boot(port);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'create', mode: 'observe', ais: 3, name: 'Watcher', seed: 11 }));
    const joined = await waitFor(ws, (m) => m.t === 'joined');
    assert.equal(joined.spectator, true);
    assert.equal(joined.mode, 'observe');
    const welcome = await waitFor(ws, (m) => m.t === 'welcome');
    assert.equal(welcome.spectator, true);
    assert.equal(welcome.civs.filter((c) => !c.rebel).length, 3, 'three AI empires');
    assert.ok(welcome.civs.every((c) => !c.human), 'no human seats');
    const N = welcome.defs.W * welcome.defs.H;
    const first = await waitFor(ws, (m) => m.t === 's' && m.econ);
    assert.equal(first.tiles.length, N, 'no fog: every tile is sent');
    const owners = new Set(first.units.map((u) => u[1]));
    assert.ok(owners.size >= 3, 'units of every empire are visible');
    assert.equal(first.obs.fog, false);
    assert.ok(first.cities.filter((c) => c.stock).length >= 3, 'full city detail for every empire');

    // orders are refused
    ws.send(JSON.stringify({ t: 'cmd', rid: 1, cmd: { c: 'move', units: [first.units[0][0]], tile: first.units[0][3] + 2 } }));
    assert.match((await waitFor(ws, (m) => m.rid === 1)).error, /Spectators/);

    // follow another empire, then turn its fog on: only what that empire sees is streamed
    ws.send(JSON.stringify({ t: 'cmd', rid: 2, cmd: { c: 'follow', civ: 1 } }));
    assert.equal((await waitFor(ws, (m) => m.rid === 2)).follow, 1);
    const fol = await waitFor(ws, (m) => m.t === 's' && m.reset);
    assert.equal(fol.econ.res !== undefined, true);
    assert.equal(fol.obs.follow, 1);
    ws.send(JSON.stringify({ t: 'cmd', rid: 3, cmd: { c: 'fog', on: true } }));
    await waitFor(ws, (m) => m.rid === 3);
    const fogged = await waitFor(ws, (m) => m.t === 's' && m.obs && m.obs.fog && m.tiles);
    assert.ok(fogged.tiles.length < N / 2, 'fog on: only the followed empire\'s explored map');
    if (fogged.vis) {
      const bits = Buffer.from(fogged.vis, 'base64');
      const seen = (i) => (bits[i >> 3] >> (i & 7)) & 1;
      assert.ok(fogged.units.every((u) => u[1] === 1 || seen(u[3])), 'other empires\' units only where the followed empire can see');
    }

    // speed: 8x runs the clock much faster than real time
    ws.send(JSON.stringify({ t: 'cmd', rid: 4, cmd: { c: 'speed', speed: 8 } }));
    assert.equal((await waitFor(ws, (m) => m.rid === 4)).speed, 8);
    const a = await waitFor(ws, (m) => m.t === 's');
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 2000));
    const b = await waitFor(ws, (m) => m.t === 's');
    const rate = (b.time - a.time) / ((Date.now() - t0) / 1000);
    // 8x is a ceiling: the server never lets a tick interval overrun, so a busy CI machine gets less;
    // the clock must still run clearly faster than real time
    assert.ok(rate > 1.4, `game clock runs fast (${rate.toFixed(1)}x)`);
    // pause stops the clock
    ws.send(JSON.stringify({ t: 'cmd', rid: 5, cmd: { c: 'speed', speed: 0 } }));
    await waitFor(ws, (m) => m.rid === 5);
    const p1 = await waitFor(ws, (m) => m.t === 's');
    await new Promise((r) => setTimeout(r, 1200));
    const p2 = await waitFor(ws, (m) => m.t === 's');
    assert.equal(p2.time, p1.time, 'paused');
    ws.close();
  } finally { srv.kill('SIGTERM'); }
});
