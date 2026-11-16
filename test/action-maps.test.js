import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG, MAPS_BY_ID, mapList } from '../server/sim/mapCatalog.js';

// Each authored map has its own size, and the map size is fixed per process (constants.js), so every
// map is built in its own worker thread, as a live match would be.
const SIM = new URL('../server/sim/', import.meta.url).href;
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { mirrorTile } = await import(workerData.sim + 'authoredMaps.js');
const { HEAVY_GROUND } = await import(workerData.sim + 'actionNavigation.js');
const slots = Array.from({ length: workerData.players }, () => ({ human: false, difficulty: 'normal' }));
const make = (seed) => new ActionGame({ id: 'map-' + seed, seed, map: workerData.id, slots });
const t0 = performance.now();
const g = make(11);
const genMs = performance.now() - t0;
const w = g.world, N = w.elev.length;
let asym = 0;
for (let i = 0; i < N; i++) {
  const m = mirrorTile(i);
  if (Math.abs(w.elev[i] - w.elev[m]) > 1e-4 || w.terr[i] !== w.terr[m] || w.river[i] !== w.river[m] || !!w.road[i] !== !!w.road[m]) asym++;
}
const twin = make(98765);
let same = twin.roads.edges.size === g.roads.edges.size && twin.sites.length === g.sites.length;
for (let i = 0; same && i < N; i++) if (twin.world.elev[i] !== w.elev[i] || twin.world.terr[i] !== w.terr[i] || twin.world.river[i] !== w.river[i]) same = false;
for (let i = 0; same && i < g.sites.length; i++) if (twin.sites[i].tile !== g.sites[i].tile || twin.sites[i].name !== g.sites[i].name) same = false;
const starts = g.sites.filter((s) => s.start !== undefined);
const unreachable = g.sites.filter((s) => !g.nav.strategic(starts[0].tile, s.tile, HEAVY_GROUND, false, true, 1e9)).map((s) => s.name);
let fords = 0, bridges = 0, rivers = 0;
for (let i = 0; i < N; i++) if (w.river[i]) { rivers++; if (w.flow[i] < 94) fords++; if (w.road[i]) bridges++; }
let error = null;
try { for (let i = 0; i < 600; i++) g.tick(); } catch (e) { error = String(e.stack || e); }
parentPort.postMessage({ genMs, asym, same, unreachable, rivers, fords, bridges, error, mapId: g.mapId, teamSize: g.teamSize,
  starts: starts.map((s) => ({ start: s.start, owner: s.owner, hq: !!g.buildings.get(s.hq) })), main: g.sites.filter((s) => s.slots).length,
  outposts: g.sites.filter((s) => !s.slots).length, rings: g.sites.filter((s) => s.slots).every((s) => s.parcels.length === 9),
  wstarts: w.starts.length, teams: g.civs.map((c) => c.team), units: g.units.size });
`;

function build(def) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(probe, { eval: true, type: 'module', workerData: { size: def.size, id: def.id, players: def.players, sim: SIM } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', reject);
  });
}

test('the lobby lists the authored maps with their team sizes, after the procedural default', () => {
  const list = mapList();
  assert.equal(list[0].id, 'random');
  assert.ok(MAP_CATALOG.length >= 3);
  for (const size of [1, 2, 3]) assert.ok(MAP_CATALOG.some((m) => m.teamSize === size), `a ${size}v${size} map`);
  for (const m of MAP_CATALOG) {
    assert.equal(m.players, m.teamSize * 2);
    assert.equal(m.size % 2, 0, 'an even number of rows keeps the half-turn exact');
    assert.ok(list.some((x) => x.id === m.id && x.name && x.description && x.mode === `${m.teamSize}v${m.teamSize}`));
  }
});

for (const def of MAP_CATALOG) {
  test(`${def.name}: deterministic, point-symmetric, connected and playable`, async () => {
    const r = await build(def);
    assert.equal(r.error, null, r.error);
    assert.equal(r.mapId, def.id);
    assert.equal(r.teamSize, def.teamSize);
    assert.deepEqual(r.teams, Array.from({ length: def.players }, (_, i) => Math.floor(i / def.teamSize)));
    assert.ok(r.same, 'the same map is the same ground, sites and roads whatever the match seed');
    // only the single central objective (not mirrored onto itself) may differ from its half-turn
    assert.ok(r.asym <= 40, `${r.asym} tiles break the symmetry`);
    assert.deepEqual(r.unreachable, [], 'every ruin and outpost can be reached by heavy vehicles');
    assert.equal(r.starts.length, def.players);
    assert.ok(r.starts.every((s, i) => s.start === i && s.owner === i && s.hq), 'each seat starts at its own operational base');
    assert.equal(r.wstarts, def.players);
    assert.ok(r.rings, 'every city ruin has its full ring of parcels');
    assert.ok(r.main >= def.players + 3 && r.outposts >= def.players * 2);
    assert.ok(r.rivers > 0 && r.fords > 0 && r.bridges > 0, `rivers ${r.rivers}, fords ${r.fords}, bridges ${r.bridges}`);
    assert.ok(r.genMs < 8000, `generation took ${r.genMs} ms`);
  });
}

test('matches on an authored map take its size and teams; unknown maps are refused', async () => {
  const { MatchManager } = await import('../server/matches.js');
  const mm = new MatchManager({ info() {}, warn() {}, error() {} });
  try {
    const def = MAPS_BY_ID.saltmarsh_estuary;
    const ai = mm.create({ ruleset: 'action-v2', mode: 'ai', map: def.id, name: 'P', ais: 1, teamSize: 1 });
    assert.equal(ai.map, def.id);
    assert.equal(ai.mapSize, def.size);
    assert.equal(ai.teamSize, def.teamSize);
    assert.equal(ai.slots.length, def.players);
    assert.equal(ai.slots.filter((s) => s.human).length, 1);
    const pvp = mm.create({ ruleset: 'action-v2', mode: 'pvp', map: 'twin_rivers', humans: 4, teamSize: 2 });
    assert.equal(pvp.teamSize, 1);
    assert.equal(pvp.slots.length, 2);
    assert.equal(mm.meta(pvp).map, 'twin_rivers');
    assert.throws(() => mm.create({ ruleset: 'action-v2', mode: 'ai', map: 'atlantis' }), /Unknown map/);
    const random = mm.create({ ruleset: 'action-v2', mode: 'ai' });
    assert.equal(random.map, 'random');
  } finally { clearInterval(mm.janitor); }
});
