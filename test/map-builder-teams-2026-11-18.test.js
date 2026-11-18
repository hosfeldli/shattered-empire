// Map builder: team ownership of the starting bases (2026-11-18, docs/gameplay-overhaul/MAP_BUILDER_TEAMS.md).
// A sketch may carry `owners` (one team index per base, -1 neutral). The server validates it against the seats
// (every active seat keeps a base), renumbers it like the teams when closed seats leave, and the world generator
// seats each team on its own bases (the k-th civ of a team on its k-th base; surplus and neutral bases stay ruins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { baseOwnersProblem, encodeCells, ownedStarts, parseSketch, sketchForTeams, sketchPreview, SKETCH_SIZES } from '../server/sim/sketchMaps.js';
import { MatchManager } from '../server/matches.js';

const SIM = new URL('../server/sim/', import.meta.url).href;

function sampleSketch(extra = {}) {
  const w = 64, h = 64, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x < 3 || y < 3 || x >= w - 3 || y >= h - 3 ? 0 : 1;
  return { v: 1, name: 'Owned', size: 'small', w, h, cells: encodeCells(g), bases: [[.15, .2], [.85, .8], [.85, .2], [.15, .75]], ...extra };
}
const seats = (n, closed = []) => Array.from({ length: n }, (_, i) => ({ human: i === 0, closed: closed.includes(i) || undefined }));

test('owners are validated and kept; all-neutral or absent means automatic seating', () => {
  assert.deepEqual(parseSketch(sampleSketch({ owners: [1, 0, -1, 1] })).owners, [1, 0, -1, 1]);
  assert.equal(parseSketch(sampleSketch()).owners, undefined);
  assert.equal(parseSketch(sampleSketch({ owners: [-1, -1, -1, -1] })).owners, undefined);
  for (const owners of [[0, 1], [0, 1, 2, 'x'], [0, 1, 2, 9], [0, 1, 2, -2], [0, 1.5, 2, 3], 'abc'])
    assert.throws(() => parseSketch(sampleSketch({ owners })), /Map sketch/, JSON.stringify(owners));
  assert.deepEqual(sketchPreview(parseSketch(sampleSketch({ owners: [1, 0, -1, 1] }))).startOwners, [1, 0, -1, 1]);
});

test('every active seat keeps a base; a base may not name a missing team', () => {
  const sk = parseSketch(sampleSketch({ owners: [0, 1, 1, -1] }));
  assert.equal(baseOwnersProblem(sk, seats(2), 1), null);
  assert.match(baseOwnersProblem(sk, seats(3), 1), /Player 3 has 1 player but no starting base/);
  assert.match(baseOwnersProblem(sk, seats(4), 2), /Team 1 has 2 players but only 1 starting base/);
  // a closed seat needs no base
  assert.equal(baseOwnersProblem(sk, seats(4, [1]), 2), null);
  // team 3 does not exist in a 1 v 1
  assert.match(baseOwnersProblem(parseSketch(sampleSketch({ owners: [0, 1, 2, -1] })), seats(2), 1), /Base 3 belongs to Team 3/);
  assert.equal(baseOwnersProblem(parseSketch(sampleSketch()), seats(4), 1), null, 'automatic seating is never refused here');
});

test('closed seats renumber the owners like the teams; seating follows base order within a team', () => {
  const sk = parseSketch(sampleSketch({ owners: [2, 0, 2, 1] }));
  // ffa3 with seat 1 (team 1) closed: teams 0 and 2 remain and become 0 and 1; team 1's base turns neutral
  assert.deepEqual(sketchForTeams(sk, seats(3, [1]), 1).owners, [1, 0, 1, -1]);
  assert.deepEqual(sketchForTeams(sk, seats(3), 1).owners, [2, 0, 2, 1]);
  assert.deepEqual(ownedStarts([1, 0, 1, -1], [0, 1, 1]), [1, 0, 2]);
  assert.throws(() => ownedStarts([0, -1, -1, 1], [0, 0, 1]), /no starting base to player 2/);
});

const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { pointUV } = await import(workerData.sim + 'authoredMaps.js');
const slots = workerData.teamOf.map((_, i) => ({ human: i === 0, difficulty: 'normal', personality: 'builder' }));
const g = new ActionGame({ id: 'owned', seed: 3, map: 'custom', sketch: workerData.sketch, slots, teamOf: workerData.teamOf, teamSize: 1 });
parentPort.postMessage({
  starts: g.sites.filter((s) => s.start !== undefined).map((s) => ({ civ: s.start, owner: s.owner, uv: pointUV(s) })),
  spare: g.sites.filter((s) => s.slots && s.start === undefined).map((s) => pointUV(s)),
});
`;
const generate = (sketch, teamOf) => new Promise((resolve, reject) => {
  const worker = new Worker(probe, { eval: true, type: 'module', workerData: { size: SKETCH_SIZES[sketch.size], sketch, teamOf, sim: SIM } });
  worker.once('message', (m) => { resolve(m); worker.terminate(); });
  worker.once('error', reject);
});
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test('the generated match seats each team on the bases it owns', { timeout: 120_000 }, async () => {
  // a duel: player 1 (team 0) owns base 4 (south-west), player 2 (team 1) base 2 (south-east); bases 1 and 3 neutral
  const sk = parseSketch(sampleSketch({ owners: [-1, 1, -1, 0] }));
  const r = await generate(sk, [0, 1]);
  assert.equal(r.starts.length, 2);
  const at = (civ) => r.starts.find((s) => s.civ === civ);
  assert.ok(near(at(0).uv, sk.bases[3]) < .08, `civ 0 starts at base 4 (${at(0).uv})`);
  assert.ok(near(at(1).uv, sk.bases[1]) < .08, `civ 1 starts at base 2 (${at(1).uv})`);
  assert.equal(at(0).owner, 0); assert.equal(at(1).owner, 1);
  for (const b of [0, 2]) assert.ok(r.spare.some((p) => near(p, sk.bases[b]) < .08), `base ${b + 1} stays a neutral city`);
});

// ---- the lobby refuses ownership that leaves a seat without a base
const CAPS = ['geo', 'udelta', 'action-rts', 'ring-cities-v1'];
const quiet = { info() {}, warn() {}, error() {} };
function socket(mm) {
  const handlers = {};
  const ws = { readyState: 1, bufferedAmount: 0, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, on(ev, fn) { handlers[ev] = fn; }, close() { handlers.close?.(); } };
  mm.attach(ws);
  ws.msg = (o) => handlers.message(JSON.stringify(o));
  ws.error = (o) => { const n = ws.sent.length; ws.msg(o); const e = ws.sent.slice(n).find((m) => m.t === 'error'); return e ? e.error : null; };
  ws.msg({ t: 'hello', proto: 2, caps: CAPS });
  return ws;
}

test('lobby and New Skirmish: owners that leave a seat without a base are refused with a clear message', () => {
  const mm = new MatchManager(quiet, null);
  clearInterval(mm.janitor);
  mm.admit = () => null;
  const realStart = mm.start.bind(mm);
  let started = 0;
  mm.start = (m) => { started++; m.status = 'running'; };
  const host = socket(mm);
  host.msg({ t: 'create', mode: 'pvp', name: 'Host', ruleset: 'action-v2', format: '2v2', waitForReady: true });
  const m = [...mm.matches.values()][0];
  // the lobby keeps an unfinished assignment (the host edits one base at a time; every client shows the warning)
  assert.equal(host.error({ t: 'map', map: 'custom', sketch: sampleSketch({ owners: [0, 0, 1, -1] }) }), null);
  assert.deepEqual(m.sketch.owners, [0, 0, 1, -1]);
  // the start refuses it, and the lobby stays a lobby
  assert.throws(() => realStart(m), /Team 2 has 2 players but only 1 starting base/);
  assert.equal(m.status, 'lobby');
  assert.equal(host.error({ t: 'map', map: 'custom', sketch: sampleSketch({ owners: [0, 1, 0, 1] }) }), null);
  assert.deepEqual(m.sketch.owners, [0, 1, 0, 1]);
  const ws = socket(mm);
  assert.match(ws.error({ t: 'create', mode: 'ai', name: 'P', ruleset: 'action-v2', map: 'custom', format: '1v1', sketch: sampleSketch({ owners: [0, 0, -1, -1] }) }), /Team 2 has 1 player but no starting base/);
  assert.equal(started, 0);
});
