// Flexible player counts on catalog maps (maps wave 3): a map plays with fewer players than it was
// drawn for, and with any team arrangement up to its number of starts. actionMap.assignStarts seats
// the civs (rivals apart, allies together, symmetric twins preferred); the starts nobody takes stay
// as neutral city ruins. Each case runs in its own worker (the map size is fixed per process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';

const SIM = new URL('../server/sim/', import.meta.url).href;
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { mirrorTile } = await import(workerData.sim + 'authoredMaps.js');
const { HEAVY_GROUND } = await import(workerData.sim + 'actionNavigation.js');
const slots = workerData.teamOf.map((_, i) => ({ human: i === 0, difficulty: 'normal', personality: 'builder' }));
const g = new ActionGame({ id: 'flex', seed: 7, map: workerData.id, slots, teamOf: workerData.teamOf, teamSize: workerData.teamSize });
const route = (a, b) => g.nav.strategic(a, b, HEAVY_GROUND, false, true, 1e9)?.length ?? Infinity;
const capitals = g.civs.map((c) => g.sites[c.id]);
const result = {
  teams: g.civs.map((c) => c.team), wstarts: g.world.starts.length,
  capitals: capitals.map((s, i) => ({ start: s.start, owner: s.owner, hq: !!g.buildings.get(s.hq), tile: s.tile, startTile: g.world.starts[i] })),
  twins: capitals.length === 2 && mirrorTile(capitals[0].tile) === capitals[1].tile,
  routes: capitals.map((a) => capitals.map((b) => (a === b ? 0 : route(a.tile, b.tile)))),
  spare: g.sites.filter((s) => s.slots && s.start === undefined).length,
  spareOwned: g.sites.filter((s) => s.slots && s.start === undefined && s.owner >= 0).length,
  starting: g.sites.filter((s) => s.start !== undefined).length,
};
let error = null;
try { for (let i = 0; i < 300; i++) { g.tick(); g.outbox.length = 0; } } catch (e) { error = String(e.stack || e); }
result.error = error;
result.alive = g.civs.filter((c) => c.alive !== false).length;
parentPort.postMessage(result);
`;

function play(def, teamOf, teamSize) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(probe, { eval: true, type: 'module', workerData: { size: def.size, id: def.id, teamOf, teamSize, sim: SIM } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', reject);
  });
}

const firstMap = (pred) => MAP_CATALOG.find(pred);
const common = (r, def, teamOf) => {
  assert.equal(r.error, null, r.error);
  assert.deepEqual(r.teams, teamOf);
  assert.equal(r.wstarts, teamOf.length);
  assert.equal(r.starting, teamOf.length, 'only the seated civs have a start');
  r.capitals.forEach((c, i) => {
    assert.equal(c.start, i); assert.equal(c.owner, i); assert.ok(c.hq, `civ ${i} starts at an operational headquarters`);
    assert.equal(c.startTile, c.tile);
  });
  assert.ok(r.spare >= def.players - teamOf.length + 3, 'the unused starts stay as neutral city ruins');
  assert.equal(r.spareOwned, 0);
  for (const row of r.routes) assert.ok(row.every(Number.isFinite), 'every capital can drive to every other');
};
const enemy = (r, teamOf) => { const v = []; teamOf.forEach((a, i) => teamOf.forEach((b, j) => { if (i < j && a !== b) v.push(r.routes[i][j]); })); return v; };
const ally = (r, teamOf) => { const v = []; teamOf.forEach((a, i) => teamOf.forEach((b, j) => { if (i < j && a === b) v.push(r.routes[i][j]); })); return v; };

test('1v1 on a 3v3 map: the duel takes a symmetric pair of starts', async () => {
  const def = firstMap((m) => m.players === 6 && m.teamSize === 3);
  const r = await play(def, [0, 1], 1);
  common(r, def, [0, 1]);
  assert.ok(r.twins, 'the two capitals are half-turn twins (equal ground)');
});

test('2v2 on a free-for-all map for four: allies take neighbouring starts', async () => {
  const def = firstMap((m) => m.players === 4 && m.symmetry === 4);
  const teamOf = [0, 0, 1, 1];
  const r = await play(def, teamOf, 2);
  common(r, def, teamOf);
  assert.ok(Math.max(...ally(r, teamOf)) < Math.max(...enemy(r, teamOf)), `allies ${ally(r, teamOf)} enemies ${enemy(r, teamOf)}`);
  // both teams are a turned copy of each other: the same distance between allies
  const [a, b] = ally(r, teamOf);
  assert.ok(Math.abs(a - b) <= Math.max(4, a * .08), `ally routes ${a} / ${b}`);
});

test('1v2 on a 2v2 map: the lone civ holds one side, the pair the other', async () => {
  const def = firstMap((m) => m.players === 4 && m.teamSize === 2);
  const teamOf = [0, 1, 1];
  const r = await play(def, teamOf, 2);
  common(r, def, teamOf);
  assert.ok(ally(r, teamOf)[0] < Math.min(...enemy(r, teamOf)), 'the pair sit together');
});

test('free-for-all for three on a six-start map: three spread, fair starts', async () => {
  const def = firstMap((m) => m.players === 6);
  const teamOf = [0, 1, 2];
  const r = await play(def, teamOf, 1);
  common(r, def, teamOf);
  const near = r.routes.map((row, i) => Math.min(...row.filter((_, j) => j !== i)));
  assert.ok(Math.min(...near) >= 20, `no two capitals side by side (${near})`);
});

test('every wave 3 map also plays as a duel', async () => {
  for (const id of ['fortress_pass', 'stepping_stones', 'twin_continents', 'ring_of_fire', 'king_of_the_hill']) {
    const def = MAP_CATALOG.find((m) => m.id === id);
    const r = await play(def, [0, 1], 1);
    common(r, def, [0, 1]);
  }
});
