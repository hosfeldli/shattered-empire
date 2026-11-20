// S2 (perf, 2026-11-17): refreshVisibility stamps each team's sight once and copies it to the team's other
// members, with an integer-keyed Int32Array disk cache. This test replays deterministic AI matches and,
// after every visibility pass, recomputes every civ's visible/detect arrays with the previous
// implementation (kept here verbatim as the reference) and requires them to be byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';

const SIM = new URL('../server/sim/', import.meta.url).href;
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { ACTION_UNITS, ACTION_BUILDINGS, OUTPOST_TYPES } = await import(workerData.sim + 'actionDefinitions.js');
const { centerOf, distance } = await import(workerData.sim + 'actionNavigation.js');
const { disk } = await import(workerData.sim + 'hex.js');
const { T } = await import(workerData.sim + 'constants.js');
const slots = workerData.teamOf.map((_, i) => ({ human: false, difficulty: 'normal', personality: ['warlord', 'merchant', 'builder'][i % 3] }));
const g = new ActionGame({ id: 'viseq', seed: workerData.seed, map: workerData.id, slots, teamOf: workerData.teamOf, teamSize: workerData.teamSize });

// ---- reference: the implementation before S2, writing into fresh buffers
const legacyCache = new Map();
function legacyReveal(source, radius, buffer) {
  const reach = Math.ceil(radius / 1.49) + 1;
  const quantX = Math.round(source.x * 2), quantZ = Math.round(source.z * 2);
  const key = source.tile + ':' + quantX + ':' + quantZ + ':' + radius;
  let tiles = legacyCache.get(key);
  if (!tiles) {
    tiles = disk(source.tile, reach).filter((t) => distance({ x: quantX * .5, z: quantZ * .5 }, centerOf(t)) <= radius + .38);
    if (legacyCache.size >= 3500) legacyCache.delete(legacyCache.keys().next().value);
    legacyCache.set(key, tiles);
  }
  for (const t of tiles) buffer[t] = 1;
  buffer[source.tile] = 1;
}
function legacyVisibility() {
  const out = g.civs.map((c) => ({ visible: new Uint8Array(c.visible.length), detect: new Uint8Array(c.detect.length) }));
  for (const source of [...g.units.values(), ...g.buildings.values()]) {
    const own = g.civs[source.owner], d = source.isUnit ? ACTION_UNITS[source.type] : ACTION_BUILDINGS[source.type];
    let vision = d.vision || 5.1;
    if (!d.air && g.world.terr[source.tile] === T.HILLS) vision += 1.05;
    if (g.weather.fogAt(source.tile) > .55) vision -= .9;
    const scan = d.ability === 'scan' && source.abilityUntil > g.time;
    if (scan) vision += 3.5;
    for (const civ of g.civs) if (civ.alive && civ.team === own.team) {
      legacyReveal(source, vision, out[civ.id].visible);
      legacyReveal(source, scan ? vision : 1.52, out[civ.id].detect);
    }
  }
  for (const s of g.sites) if (s.owner >= 0) {
    const radar = !s.slots && OUTPOST_TYPES[s.kind].vision;
    for (const civ of g.civs) if (civ.alive && g.allied(civ.id, s.owner)) {
      legacyReveal(s, radar || (s.slots ? 3.8 : 2.5), out[civ.id].visible);
      if (radar) legacyReveal(s, radar, out[civ.id].detect);
    }
  }
  for (const civ of g.civs) if (civ.alive && g.sandboxReveal && civ.human) { out[civ.id].visible.fill(1); out[civ.id].detect.fill(1); }
  return out;
}
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

let passes = 0, mismatch = null, maxUnits = 0, visibleTiles = 0;
const refresh = g.refreshVisibility.bind(g);
g.refreshVisibility = () => {
  refresh();
  if (mismatch) return;
  passes++;
  const ref = legacyVisibility();
  for (const civ of g.civs) {
    if (!same(civ.visible, ref[civ.id].visible) || !same(civ.detect, ref[civ.id].detect)) { mismatch = { pass: passes, tick: g.tickN, civ: civ.id }; break; }
    for (let t = 0; t < civ.visible.length; t++) visibleTiles += civ.visible[t];
  }
};
let error = null;
try {
  for (let i = 0; i < workerData.ticks && !g.over; i++) { g.tick(); g.outbox.length = 0; maxUnits = Math.max(maxUnits, g.units.size); }
} catch (e) { error = String(e.stack || e); }
parentPort.postMessage({ passes, mismatch, error, maxUnits, visibleTiles, teams: g.civs.map((c) => c.team) });
`;

function play(id, teamOf, teamSize, ticks, seed = 7) {
  const def = MAP_CATALOG.find((m) => m.id === id);
  return new Promise((resolve, reject) => {
    const worker = new Worker(probe, { eval: true, type: 'module', workerData: { size: def.size, id, teamOf, teamSize, ticks, seed, sim: SIM } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', reject);
  });
}

test('visibility: 4-AI free-for-all matches the previous implementation byte for byte on every pass', { timeout: 300000 }, async () => {
  const r = await play('crossroads', [0, 1, 2, 3], 1, 6000);
  assert.equal(r.error, null);
  assert.equal(r.mismatch, null, JSON.stringify(r.mismatch));
  assert.ok(r.passes > 1000, `passes ${r.passes}`);
  assert.ok(r.maxUnits > 40 && r.visibleTiles > 0, `units ${r.maxUnits}`);
});

test('visibility: 2v2 team match (shared team sight copied to allies) matches the previous implementation', { timeout: 300000 }, async () => {
  const r = await play('crossroads', [0, 0, 1, 1], 2, 6000, 11);
  assert.equal(r.error, null);
  assert.deepEqual(r.teams, [0, 0, 1, 1]);
  assert.equal(r.mismatch, null, JSON.stringify(r.mismatch));
  assert.ok(r.passes > 1000, `passes ${r.passes}`);
});
