// Protocol handshake and the optional terrain-geometry capability ('geo') used by the native client:
// fog filtering in the simulation, then end to end against a real server, next to a protocol-1
// client (the PixiJS client) that must see exactly what it always has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Game } from '../server/sim/game.js';
import { N, W } from '../server/sim/constants.js';
import { geoViewer, geoMessage, geoBytes, decodeGeo, GEO_STRIDE, GEO_CHUNK } from '../server/sim/terrainGeo.js';
import { negotiate, PROTOCOL_VERSION } from '../server/protocol.js';

test('handshake: versions and capabilities are negotiated, unknown ones are ignored', () => {
  assert.deepEqual(negotiate({}), { proto: 1, caps: [] }, 'no hello fields: protocol 1, no capabilities');
  assert.deepEqual(negotiate({ proto: 2, caps: ['geo', 'teleport', 7] }), { proto: 2, caps: ['geo'] });
  assert.deepEqual(negotiate({ proto: 1, caps: ['geo'] }), { proto: 1, caps: [] }, 'capabilities need protocol 2');
  assert.equal(negotiate({ proto: PROTOCOL_VERSION + 5, caps: ['geo'] }).proto, PROTOCOL_VERSION, 'a newer client is answered at our version');
  assert.ok(negotiate({ proto: 0 }).error, 'too-old protocols are refused');
});

test('terrain geometry: initial sync carries explored tiles only, updates only what is in sight', () => {
  const g = new Game({ id: 'geo' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  for (let i = 0; i < 20; i++) { g.tick(); g.outbox.length = 0; }
  const civ = g.civs[0], v = geoViewer();
  const full = geoMessage(g, v, civ.visible, civ.explored, true);
  assert.equal(full.full, 1); assert.equal(full.cs, GEO_CHUNK); assert.equal(full.stride, GEO_STRIDE); assert.equal(full.w, W);
  const got = decodeGeo(full);
  const explored = civ.explored.reduce((s, x) => s + x, 0);
  assert.ok(explored > 50 && explored < N / 2, 'a fogged start: ' + explored);
  assert.equal(got.size, explored, 'every explored tile, once');
  const tmp = new Uint8Array(GEO_STRIDE);
  for (const [i, bytes] of got) {
    assert.equal(civ.explored[i], 1, `tile ${i} is explored`);
    geoBytes(g, i, tmp, 0); assert.deepEqual(bytes, [...tmp], `tile ${i} bytes`);
  }
  // elevation is quantized around sea level; biome is the terrain id
  const [i0, b0] = got.entries().next().value;
  assert.ok(Math.abs((b0[0] / 127.5 - 1) - g.world.elev[i0]) <= 0.005); assert.equal(b0[1], g.world.terr[i0]);
  assert.equal(geoMessage(g, v, civ.visible, civ.explored, false), null, 'nothing changed: no message');

  // change three tiles: one in sight, one explored but out of sight, one never explored
  let seen = -1, remembered = -1, unknown = -1;
  for (let i = 0; i < N; i++) {
    if (seen < 0 && civ.visible[i]) seen = i;
    if (remembered < 0 && civ.explored[i] && !civ.visible[i]) remembered = i;
    if (unknown < 0 && !civ.explored[i]) unknown = i;
  }
  if (remembered < 0) { remembered = [...got.keys()].find((i) => i !== seen); civ.visible[remembered] = 0; }   // make one out of sight
  for (const t of [seen, remembered, unknown]) { g.world.elev[t] += 0.2; g.world.touch(t); }
  const d1 = decodeGeo(geoMessage(g, v, civ.visible, civ.explored, false));
  assert.deepEqual([...d1.keys()], [seen], 'only the tile in sight is re-sent');
  assert.ok(!d1.has(unknown), 'unexplored terrain never leaks');
  // the remembered tile is updated once it comes back into sight; the unknown one when explored
  civ.visible[remembered] = 1; civ.explored[remembered] = 1;
  assert.deepEqual([...decodeGeo(geoMessage(g, v, civ.visible, civ.explored, false)).keys()], [remembered]);
  civ.visible[unknown] = 1; civ.explored[unknown] = 1;
  assert.deepEqual([...decodeGeo(geoMessage(g, v, civ.visible, civ.explored, false)).keys()], [unknown]);
});

function boot(port) {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), ADMIT_OFF: '1', SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-geo-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(srv); }));
}
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.seen = []; ws.on('message', (raw) => ws.seen.push(JSON.parse(raw)));
  await new Promise((r) => ws.on('open', r)); return ws;
}
function waitFor(ws, pred, ms = 20000) {
  return new Promise((resolve, reject) => {
    const hit = ws.seen.find(pred); if (hit) return resolve(hit);
    const to = setTimeout(() => { ws.off('message', on); reject(new Error('timeout')); }, ms);
    const on = (raw) => { const m = JSON.parse(raw); if (pred(m)) { clearTimeout(to); ws.off('message', on); resolve(m); } };
    ws.on('message', on);
  });
}
const stop = (srv) => new Promise((r) => { srv.on('exit', r); srv.kill('SIGTERM'); });

test('server: a geo client gets fog-filtered terrain; a protocol-1 client is unchanged', { timeout: 120000 }, async () => {
  const port = 19100 + Math.floor(Math.random() * 800);
  const srv = await boot(port);
  try {
    const old = await connect(port);
    old.send(JSON.stringify({ t: 'create', mode: 'ai', ais: 1, name: 'Legacy', seed: 7 }));
    const oldWelcome = await waitFor(old, (m) => m.t === 'welcome');
    assert.equal(oldWelcome.caps, undefined, 'the legacy welcome is unchanged');

    const ws = await connect(port);
    ws.send(JSON.stringify({ t: 'hello', proto: 2, caps: ['geo', 'bogus'], client: 'test' }));
    const hello = await waitFor(ws, (m) => m.t === 'hello');
    assert.equal(hello.ok, true); assert.equal(hello.proto, 2); assert.deepEqual(hello.caps, ['geo']);
    ws.send(JSON.stringify({ t: 'create', mode: 'ai', ais: 1, name: 'Native', seed: 7 }));
    await waitFor(ws, (m) => m.t === 'welcome');
    const first = await waitFor(ws, (m) => m.t === 's' && m.econ);
    const geo = await waitFor(ws, (m) => m.t === 'geo' && m.full);
    const tiles = decodeGeo(geo, geo.w);
    // the first snapshot sends every explored tile: geometry must cover exactly those
    assert.deepEqual([...tiles.keys()].sort((a, b) => a - b), first.tiles.map((t) => t[0]).sort((a, b) => a - b), 'geometry = explored tiles');
    for (const [i, b] of tiles) assert.equal(b[1], first.tiles.find((t) => t[0] === i)[1], 'biome matches the tile record');

    // the scout explores: later geo messages only add tiles the snapshots also reveal
    const scout = first.units.find((u) => u[2] === 'scout_buggy');
    ws.send(JSON.stringify({ t: 'cmd', rid: 1, cmd: { c: 'move', units: [scout[0]], tile: scout[3] + 6 } }));
    await waitFor(ws, (m) => m.t === 'geo' && !m.full, 30000);
    const known = new Set();
    for (const m of ws.seen) if (m.t === 's' && m.tiles) for (const t of m.tiles) known.add(t[0]);
    for (const m of ws.seen.filter((x) => x.t === 'geo')) for (const i of decodeGeo(m, geo.w).keys()) assert.ok(known.has(i), `geo tile ${i} was revealed by the snapshots`);

    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!old.seen.some((m) => m.t === 'geo' || m.t === 'hello'), 'the protocol-1 client never receives new message types');
    assert.ok(old.seen.filter((m) => m.t === 's').length > 3, 'and keeps streaming snapshots');

    const bad = await connect(port);
    bad.send(JSON.stringify({ t: 'hello', proto: 0 }));
    assert.equal((await waitFor(bad, (m) => m.t === 'hello')).ok, false);
    for (const s of [old, ws, bad]) s.close();
  } finally { await stop(srv); }
});

test('server: geo spectators see the whole map without fog, and a fog toggle resets it', { timeout: 120000 }, async () => {
  const port = 19950 + Math.floor(Math.random() * 40);
  const srv = await boot(port);
  try {
    const ws = await connect(port);
    ws.send(JSON.stringify({ t: 'hello', proto: 2, caps: ['geo'] }));
    await waitFor(ws, (m) => m.t === 'hello');
    ws.send(JSON.stringify({ t: 'create', mode: 'observe', ais: 2, name: 'Watcher', seed: 11 }));
    const welcome = await waitFor(ws, (m) => m.t === 'welcome');
    const n = welcome.defs.W * welcome.defs.H;
    const geo = await waitFor(ws, (m) => m.t === 'geo' && m.full);
    assert.equal(decodeGeo(geo, geo.w).size, n, 'no fog: every tile');
    ws.seen.length = 0;
    ws.send(JSON.stringify({ t: 'cmd', rid: 2, cmd: { c: 'fog', on: true } }));
    const reset = await waitFor(ws, (m) => m.t === 'geo' && m.full);
    const fogged = decodeGeo(reset, reset.w).size;
    assert.ok(fogged > 0 && fogged < n / 2, 'fog on: only the followed empire\'s explored land ' + fogged);
    ws.close();
  } finally { await stop(srv); }
});
