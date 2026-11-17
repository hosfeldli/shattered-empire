// Map builder (2026-11-17): a host's coarse sketch (ocean / land / mountain cells and placed bases) is a
// constraint the world generator fills in naturally (sketchMaps.js). Validation rejects malformed or
// hostile payloads; the generated world honours the painted classes for most hexes; the bases become
// the starts (spares stay neutral); one seed is one world. The lobby carries the sketch to every client.
// Generation runs in a worker per case (the map size is fixed per process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { decodeCells, encodeCells, parseSketch, sketchMetrics, sketchPreview, SKETCH_SIZES } from '../server/sim/sketchMaps.js';
import { MatchManager } from '../server/matches.js';

const SIM = new URL('../server/sim/', import.meta.url).href;

// 64 × 64: land with an ocean border, a north-south range, a lake in the south-west, four bases
function sampleSketch(extra = {}) {
  const w = 64, h = 64, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = x < 3 || y < 3 || x >= w - 3 || y >= h - 3 ? 0 : 1;
    if (Math.abs(x - 32) < 3 && y > 14 && y < 50) c = 2;
    if (Math.hypot(x - 18, y - 45) < 6) c = 0;
    g[y * w + x] = c;
  }
  return { v: 1, name: 'Test Ridge', size: 'small', w, h, cells: encodeCells(g), bases: [[.15, .2], [.85, .8], [.85, .2], [.15, .75]], ...extra };
}

test('sketch cells round-trip through the run-length encoding', () => {
  const g = Uint8Array.from({ length: 300 }, (_, i) => (i * 7 >> 4) % 3);
  assert.deepEqual(decodeCells(encodeCells(g), 300), g);
  assert.equal(encodeCells(new Uint8Array(20).fill(1)), 'l20');
});

test('a valid sketch is canonicalised: known fields only, rounded bases, cleaned name', () => {
  const sk = parseSketch({ ...sampleSketch({ name: '  My <b>map</b>\u0007 ', bases: [[.150001, .2], { u: .85, v: .8 }] }), extra: 'ignored', __proto__x: 1 });
  assert.deepEqual(Object.keys(sk).sort(), ['bases', 'cells', 'h', 'name', 'size', 'v', 'w']);
  assert.deepEqual(sk.bases, [[.15, .2], [.85, .8]]);
  assert.equal(sk.name, 'My bmap/b');
  assert.equal(parseSketch({ ...sampleSketch(), name: '' }).name, 'Custom map');
  assert.ok(Object.hasOwn(SKETCH_SIZES, sk.size));
});

test('bad sketch payloads are rejected', () => {
  const good = sampleSketch();
  const bad = [
    null, 'x', [], 42,
    { ...good, w: 8 }, { ...good, w: 1000, h: 1000 }, { ...good, w: 64.5 }, { ...good, h: '64' },
    { ...good, size: 'gigantic' }, { ...good, size: undefined },
    { ...good, cells: '' }, { ...good, cells: 'l4095' }, { ...good, cells: 'l4097' }, { ...good, cells: 'x4096' }, { ...good, cells: 'l0l4096' },
    { ...good, cells: 'l4096 ' }, { ...good, cells: 'l'.repeat(50000) }, { ...good, cells: 123 },
    { ...good, cells: 'o4096' },                                // no land
    { ...good, bases: [] }, { ...good, bases: [[.5, .5]] }, { ...good, bases: Array.from({ length: 9 }, (_, i) => [.2 + i * .05, .5]) },
    { ...good, bases: [[.5, .5], [1.5, .5]] }, { ...good, bases: [[.5, .5], [NaN, .5]] }, { ...good, bases: [[.5, .5], ['.2', .5]] },
    { ...good, bases: [[.5, .5], [.01, .01]] },                // in the sea (the border)
    { ...good, bases: 'everywhere' },
  ];
  for (const b of bad) assert.throws(() => parseSketch(b), /Map sketch/, JSON.stringify(b)?.slice(0, 80));
});

test('sketch metrics measure land steps between bases; the preview shows the sketch', () => {
  const sk = parseSketch(sampleSketch());
  const { steps, reach } = sketchMetrics(sk);
  assert.equal(steps.length, 4);
  for (let i = 0; i < 4; i++) { assert.equal(steps[i][i], 0); for (let j = 0; j < 4; j++) assert.equal(steps[i][j], steps[j][i]); }
  assert.ok(steps[0][2] > steps[0][3], 'the range lengthens the route east');
  assert.deepEqual(reach, [0, 0, 0, 0]);
  const p = sketchPreview(sk);
  assert.equal(Buffer.from(p.cells, 'base64').length, 64 * 64);
  assert.equal(p.starts.length, 4);
  // an island base cannot be reached overland
  const g = new Uint8Array(32 * 32).fill(0);
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) g[y * 32 + x] = 1;
  for (let y = 20; y < 28; y++) for (let x = 20; x < 28; x++) g[y * 32 + x] = 1;
  const islands = parseSketch({ w: 32, h: 32, size: 'small', cells: encodeCells(g), bases: [[.25, .25], [.75, .75]] });
  assert.equal(sketchMetrics(islands).steps[0][1], 1e4);
});

const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { sketchGrid } = await import(workerData.sim + 'sketchMaps.js');
const { pointUV } = await import(workerData.sim + 'authoredMaps.js');
const { N, W, T, isWater } = await import(workerData.sim + 'constants.js');
const sk = workerData.sketch, grid = sketchGrid(sk);
const slots = workerData.teamOf.map((_, i) => ({ human: i === 0, difficulty: 'normal', personality: 'builder' }));
const g = new ActionGame({ id: 'sketch', seed: workerData.seed, map: 'custom', sketch: sk, slots, teamOf: workerData.teamOf, teamSize: 1 });
const per = [[0, 0], [0, 0], [0, 0]];
for (let i = 0; i < N; i++) {
  const q = i % W, r = (i / W) | 0, [u, v] = pointUV({ x: Math.sqrt(3) * (q + .5 * (r & 1)), z: 1.5 * r });
  const c = grid[Math.min(sk.h - 1, Math.max(0, Math.floor(v * sk.h))) * sk.w + Math.min(sk.w - 1, Math.max(0, Math.floor(u * sk.w)))];
  const t = g.world.terr[i];
  const ok = c === 0 ? isWater(t) : c === 2 ? t === T.MOUNTAIN || t === T.PEAK : !isWater(t) && t !== T.MOUNTAIN && t !== T.PEAK;
  per[c][1]++; if (ok) per[c][0]++;
}
const uv = (s) => pointUV(s);
let error = null;
try { for (let i = 0; i < 100; i++) { g.tick(); g.outbox.length = 0; } } catch (e) { error = String(e.stack || e); }
parentPort.postMessage({
  mapId: g.mapId, per, error,
  starts: g.sites.filter((s) => s.start !== undefined).map((s) => ({ start: s.start, uv: uv(s), owner: s.owner })),
  spare: g.sites.filter((s) => s.slots && s.start === undefined).map((s) => uv(s)),
  outposts: g.sites.filter((s) => !s.slots).length, mains: g.sites.filter((s) => s.slots).length,
  wstarts: g.world.starts.length, rivers: g.world.river.reduce((a, b) => a + b, 0),
  hash: [...g.world.terr].reduce((h, t, i) => (h * 31 + t * (i % 97 + 1)) >>> 0, 7) + ':' + g.sites.map((s) => s.tile).join(','),
});
`;

function generate(sketch, teamOf, seed = 7) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(probe, { eval: true, type: 'module', workerData: { size: SKETCH_SIZES[sketch.size], sketch, teamOf, seed, sim: SIM } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', reject);
  });
}

const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test('the generated world honours the painted ocean, land and mountains; the bases become the starts', { timeout: 120_000 }, async () => {
  const sk = parseSketch(sampleSketch());
  const r = await generate(sk, [0, 1, 2, 3]);
  assert.equal(r.error, null, r.error);
  assert.equal(r.mapId, 'custom');
  const share = r.per.map(([ok, n]) => ok / n);
  const all = r.per.reduce((a, [ok]) => a + ok, 0) / r.per.reduce((a, [, n]) => a + n, 0);
  assert.ok(all > .9, `classes honoured overall: ${all}`);
  for (const [k, s] of share.entries()) assert.ok(s > .85, `class ${k} honoured: ${s}`);
  assert.equal(r.wstarts, 4);
  assert.equal(r.starts.length, 4);
  // every civ starts at (within a couple of sketch cells of) one of the painted bases, each base used once
  const used = new Set();
  for (const s of r.starts) {
    const b = sk.bases.findIndex((p) => near(p, s.uv) < .06);
    assert.ok(b >= 0, `start ${s.start} at ${s.uv} is near a painted base`);
    used.add(b);
    assert.equal(s.owner, s.start, 'each civ holds its start');
  }
  assert.equal(used.size, 4);
  // the generator fills in the rest: neutral cities, outposts and rivers
  assert.ok(r.mains > 4, 'neutral cities besides the starts');
  assert.ok(r.outposts >= 4, 'outposts');
  assert.ok(r.rivers > 0, 'rivers');
});

test('fewer players than bases: the spare bases stay neutral cities; generation is deterministic per seed', { timeout: 120_000 }, async () => {
  const sk = parseSketch(sampleSketch());
  const [a, b, c] = await Promise.all([generate(sk, [0, 1], 11), generate(sk, [0, 1], 11), generate(sk, [0, 1], 12)]);
  for (const r of [a, b, c]) assert.equal(r.error, null, r.error);
  assert.equal(a.starts.length, 2);
  assert.equal(a.wstarts, 2);
  for (const p of sk.bases.filter((p) => !a.starts.some((s) => near(p, s.uv) < .06))) assert.ok(a.spare.some((s) => near(p, s) < .06), `spare base ${p} is a neutral city`);
  // a duel takes bases far apart: the opposite corners across the range
  const [s0, s1] = a.starts.map((s) => s.uv);
  assert.ok(near(s0, s1) > .8, `the duel's starts are far apart (${near(s0, s1)})`);
  assert.equal(a.hash, b.hash, 'same seed, same world');
  assert.notEqual(a.hash, c.hash, 'another seed, another fill');
});

test('bases on two continents split by a sea each start on their own continent', { timeout: 120_000 }, async () => {
  // the north and south halves are separate landmasses (an ocean channel between them); the south is larger
  const w = 64, h = 64, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x < 3 || y < 3 || x >= w - 3 || y >= h - 3 || (y >= 24 && y < 32) ? 0 : 1;
  const sk = parseSketch({ v: 1, name: 'Two Shores', size: 'small', w, h, cells: encodeCells(g), bases: [[.15, .15], [.85, .15], [.15, .85], [.85, .85]] });
  const r = await generate(sk, [0, 1, 2, 3], 5);
  assert.equal(r.error, null, r.error);
  for (const [i, p] of sk.bases.entries()) {
    const s = r.starts.find((x) => near(p, x.uv) < .08);
    assert.ok(s, `base ${i + 1} at ${p} became a start on its own continent (starts: ${JSON.stringify(r.starts.map((x) => x.uv))})`);
  }
});

// ---- lobby: the sketch travels with the room
const CAPS = ['geo', 'udelta', 'action-rts', 'ring-cities-v1'];
const quiet = { info() {}, warn() {}, error() {} };
function manager() {
  const mm = new MatchManager(quiet, null);
  clearInterval(mm.janitor);
  mm.admit = () => null;
  mm.start = (m) => { m.status = 'running'; };
  return mm;
}
function socket(mm) {
  const handlers = {};
  const ws = { readyState: 1, bufferedAmount: 0, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, on(ev, fn) { handlers[ev] = fn; }, close() { handlers.close?.(); } };
  mm.attach(ws);
  ws.msg = (o) => handlers.message(JSON.stringify(o));
  ws.last = (t) => [...ws.sent].reverse().find((m) => m.t === t);
  ws.error = (o) => { const n = ws.sent.length; ws.msg(o); const e = ws.sent.slice(n).find((m) => m.t === 'error'); return e ? e.error : null; };
  ws.msg({ t: 'hello', proto: 2, caps: CAPS });
  return ws;
}

test('lobby: the host picks a custom sketch; every client receives it; bad sketches are refused', () => {
  const mm = manager();
  const host = socket(mm);
  host.msg({ t: 'create', mode: 'pvp', name: 'Host', ruleset: 'action-v2', format: '2v2', waitForReady: true });
  const code = host.last('joined').match;
  const guest = socket(mm);
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  const m = mm.matches.get(code);
  assert.match(host.error({ t: 'map', map: 'custom', sketch: { ...sampleSketch(), cells: 'o4096' } }), /Map sketch/);
  assert.match(host.error({ t: 'map', map: 'custom' }), /Map sketch/);
  assert.equal(m.map, 'random');
  assert.match(guest.error({ t: 'map', map: 'custom', sketch: sampleSketch() }), /host/);
  assert.equal(host.error({ t: 'map', map: 'custom', sketch: sampleSketch({ size: 'medium' }) }), null);
  assert.equal(m.map, 'custom');
  assert.equal(m.mapSize, 152);
  for (const ws of [host, guest]) {
    const room = ws.last('room');
    assert.equal(room.map, 'custom');
    assert.equal(room.mapName, 'Test Ridge');
    assert.equal(room.mapPlayers, 4);
    assert.equal(room.sketch.cells, parseSketch(sampleSketch()).cells);
    assert.equal(room.sketch.bases.length, 4);
  }
  // 2v2 fits four bases; 4v4 does not, so the map gives way to a random world
  assert.equal(m.slots.length, 4);
  assert.equal(host.error({ t: 'mode', mode: '4v4' }), null);
  assert.equal(m.map, 'random');
  assert.equal(m.sketch, undefined);
  assert.equal(host.last('room').sketch, undefined);
  // a sketch with two bases relays out a larger lobby to its own format (1 v 1)
  assert.equal(host.error({ t: 'map', map: 'custom', sketch: sampleSketch({ bases: [[.15, .2], [.85, .8]] }) }), null);
  assert.equal(m.slots.length, 2);
  // the worker gets the sketch, the saved meta keeps it
  assert.equal(mm.meta(m).sketch.bases.length, 2);
});

test('New Skirmish: a custom map creates a match sized and seated by the sketch', () => {
  const mm = manager();
  const ws = socket(mm);
  assert.match(ws.error({ t: 'create', mode: 'ai', name: 'P', ruleset: 'action-v2', map: 'custom', sketch: { ...sampleSketch(), bases: [[.5, .5]] } }), /Map sketch/);
  ws.msg({ t: 'create', mode: 'ai', name: 'P', ruleset: 'action-v2', map: 'custom', sketch: sampleSketch({ size: 'large' }), format: 'ffa3' });
  const m = [...mm.matches.values()].find((x) => x.map === 'custom');
  assert.ok(m, 'match created');
  assert.equal(m.mapSize, 208);
  assert.equal(m.slots.length, 3);
  assert.equal(m.sketch.name, 'Test Ridge');
  // without a format, one seat per base
  ws.msg({ t: 'create', mode: 'ai', name: 'P', ruleset: 'action-v2', map: 'custom', sketch: sampleSketch() });
  const all = [...mm.matches.values()].filter((x) => x.map === 'custom');
  assert.equal(all.length, 2);
  assert.equal(all[1].slots.length, 4);
});

// ---- a sketch that validates but cannot be generated (dots of land too small for any city): the worker
// throws before it is ready; the lobby comes back as it was with the reason, a skirmish is closed with it
function dottedSketch() {
  const w = 64, h = 64, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x % 4 < 2 && y % 4 < 2 ? 1 : 0;
  const bases = [];
  for (let i = 0; i < 8; i++) bases.push([((i % 4) * 16 + 1) / 64, (Math.floor(i / 4) * 32 + 1) / 64]);
  return { v: 1, name: 'Dots', size: 'small', w, h, cells: encodeCells(g), bases };
}
const until = (fn, ms = 60_000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => { const v = fn(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timed out')); setTimeout(tick, 50); };
  tick();
});

test('a sketch that fails generation returns the lobby with an error and closes a skirmish', { timeout: 120_000 }, async () => {
  assert.doesNotThrow(() => parseSketch(dottedSketch()), 'the sketch itself is valid');
  const mm = new MatchManager(quiet, null);
  clearInterval(mm.janitor);
  mm.admit = () => null;
  try {
    // lobby (pvp): host + guest, one open seat and one closed seat, then the host starts
    const host = socket(mm);
    host.msg({ t: 'create', mode: 'pvp', name: 'Host', ruleset: 'action-v2', format: '2v2', waitForReady: true });
    const code = host.last('joined').match;
    const m = mm.matches.get(code);
    const guest = socket(mm);
    guest.msg({ t: 'join', match: code, name: 'Guest' });
    assert.equal(host.error({ t: 'map', map: 'custom', sketch: dottedSketch() }), null);
    assert.equal(host.error({ t: 'closeSeat', seat: 3, closed: true }), null);
    const seats = m.slots.map((s) => ({ human: s.human, closed: !!s.closed, name: s.name }));
    const n = host.sent.length;
    host.msg({ t: 'start' });
    assert.equal(m.status, 'running');
    const err = await until(() => host.sent.slice(n).find((x) => x.t === 'error'));
    assert.match(err.error, /could not start/i);
    assert.ok(guest.sent.some((x) => x.t === 'error' && x.startFailed), 'the guest is told too');
    assert.equal(m.status, 'lobby');
    assert.equal(m.worker, null);
    assert.equal(m.map, 'custom');
    assert.deepEqual(m.slots.map((s) => ({ human: s.human, closed: !!s.closed, name: s.name })), seats, 'seats as they were (open seat, closed seat)');
    assert.ok(m.slots.every((s) => s.civId === undefined));
    const room = host.last('room');
    assert.equal(room.status, 'lobby');
    assert.equal(room.canStart, true);
    // the lobby is usable: the host picks a valid map
    assert.equal(host.error({ t: 'map', map: 'custom', sketch: sampleSketch() }), null);
    assert.equal(m.sketch.name, 'Test Ridge');

    // New Skirmish: no lobby to go back to, the match is closed with the reason
    const solo = socket(mm);
    solo.msg({ t: 'create', mode: 'ai', name: 'P', ruleset: 'action-v2', map: 'custom', sketch: dottedSketch(), format: '1v1' });
    const id = solo.last('joined').match;
    const closed = await until(() => solo.last('lobbyClosed'));
    assert.match(closed.error, /could not start/i);
    assert.equal(closed.match, id);
    assert.equal(mm.matches.has(id), false);
  } finally {
    for (const x of mm.matches.values()) mm.stopWorker(x);
  }
});
