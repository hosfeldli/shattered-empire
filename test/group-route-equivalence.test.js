// Item 7 (perf, 2026-11-17): moveGroup / deployLine memoise route()'s fine stage across the members of one
// order (nav.beginBatch). The memo must be invisible: the same match played with batching disabled
// (nav.batchOff) has to end in exactly the same state, and big group orders issued on restored copies of
// a mid-match state must give every unit the same goal and path either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';

const SIM = new URL('../server/sim/', import.meta.url).href;
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { serializeGame, restoreGame, stateHash } = await import(workerData.sim + 'persist.js');
const { moveGroup, deployLine } = await import(workerData.sim + 'actionOrders.js');
const { ACTION_UNITS } = await import(workerData.sim + 'actionDefinitions.js');
const P = ['warlord', 'merchant', 'builder'];
const make = () => new ActionGame({ id: 'grp', seed: workerData.seed, map: workerData.map, slots: [0, 1, 2, 3].map((i) => ({ human: false, difficulty: 'normal', personality: P[(i + workerData.seed) % 3] })) });
const a = make(), b = make();
b.nav.batchOff = true;
const out = { checks: [], hashA: null, hashB: null, hits: 0 };
let hits = 0;
const end = a.nav.endBatch.bind(a.nav); a.nav.endBatch = () => { const h = end(); hits += h; return h; };
const orders = (state) => {
  const g1 = restoreGame(JSON.parse(state)), g2 = restoreGame(JSON.parse(state));
  g2.nav.batchOff = true;
  const res = [];
  for (const civ of g1.civs) {
    const ids = [...g1.units.values()].filter((u) => u.owner === civ.id && !ACTION_UNITS[u.type].air).map((u) => u.id);
    if (ids.length < 4) continue;
    const enemy = g1.sites.find((s) => s.slots && s.owner >= 0 && s.owner !== civ.id) || g1.sites[0];
    const pick = (g) => ids.map((id) => g.units.get(id));
    const r1 = moveGroup(g1, pick(g1), { x: enemy.x, z: enemy.z }, { mode: 'assault' }), r2 = moveGroup(g2, pick(g2), { x: enemy.x, z: enemy.z }, { mode: 'assault' });
    const line = [{ x: enemy.x - 2, z: enemy.z + 3 }, { x: enemy.x + 2, z: enemy.z + 3.5 }];
    const d1 = deployLine(g1, pick(g1), line, { preview: true }), d2 = deployLine(g2, pick(g2), line, { preview: true });
    res.push({ civ: civ.id, units: ids.length, placed: r1.placed ?? r1.error, same: JSON.stringify([r1, d1]) === JSON.stringify([r2, d2]) });
  }
  const view = (g) => JSON.stringify([...g.units.values()].map((u) => [u.id, u.goal, u.path]));
  return { res, samePaths: view(g1) === view(g2) };
};
for (let i = 1; i <= workerData.ticks; i++) {
  a.tick(); b.tick(); a.outbox.length = 0; b.outbox.length = 0;
  if (i % 1500 === 0) out.checks.push({ tick: i, units: a.units.size, ...orders(JSON.stringify(serializeGame(a))) });
}
out.hashA = stateHash(a); out.hashB = stateHash(b); out.hits = hits;
parentPort.postMessage(out);
`;

test('group routing memo: identical match outcome and identical big-group orders with and without batching', { timeout: 600000 }, async () => {
  const def = MAP_CATALOG.find((m) => m.id === 'crossroads');
  const r = await new Promise((resolve, reject) => {
    const w = new Worker(probe, { eval: true, type: 'module', workerData: { size: def.size, map: 'crossroads', seed: 7, ticks: 6000, sim: SIM } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
  assert.equal(r.hashA, r.hashB, 'the whole match ends in the same state');
  assert.ok(r.hits > 0, 'the memo was used');
  assert.equal(r.checks.length, 4);
  for (const c of r.checks) {
    assert.ok(c.samePaths, `paths differ at tick ${c.tick}`);
    for (const o of c.res) assert.ok(o.same, `order results differ at tick ${c.tick} civ ${o.civ}`);
  }
});
