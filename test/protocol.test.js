// End-to-end protocol test: boot the server, create an AI match over WebSocket,
// receive the welcome + fog-filtered snapshots, issue commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);

function waitFor(ws, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout')), ms);
    const on = (raw) => { const m = JSON.parse(raw); if (pred(m)) { clearTimeout(to); ws.off('message', on); resolve(m); } };
    ws.on('message', on);
  });
}

test('server hosts a match end-to-end', async () => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) r(); }));
    const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    assert.equal(health.ok, true);
    const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    assert.match(html, /Shattered Empires/);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'create', mode: 'ai', ais: 1, name: 'Tester', seed: 7 }));
    const welcome = await waitFor(ws, (m) => m.t === 'welcome');
    assert.equal(welcome.civId, 0);
    assert.ok(welcome.defs.UNITS.knight);
    const snap = await waitFor(ws, (m) => m.t === 's' && m.econ);
    assert.ok(snap.tiles.length > 50, 'initial explored tiles');
    assert.ok(snap.units.some((u) => u[1] === 0), 'own units visible');
    assert.ok(snap.vis, 'visibility bitset');
    // no enemy units leak through fog at start
    assert.ok(snap.units.every((u) => u[1] === 0));
    const scout = snap.units.find((u) => u[2] === 'scout');
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
    ws.close();
  } finally { srv.kill(); }
});
