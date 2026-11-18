// §30 (2026-11-18): dense forest blocks ordinary infantry; heavy hulls clear it; generated forests never cut a map
// apart (connectivity unchanged for infantry on every catalogue map) and detours stay short. TERRAIN_SYSTEM.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';

const SIM = new URL('../server/sim/', import.meta.url).href;
// One worker per map (the map size is fixed per process). Reports dense count, connectivity breaks and detours.
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { LIGHT_GROUND } = await import(workerData.sim + 'actionNavigation.js');
const slots = Array.from({ length: workerData.players }, () => ({ human: false, difficulty: 'normal' }));
const t0 = performance.now();
const g = new ActionGame({ id: 'dense-' + workerData.id, seed: workerData.seed, map: workerData.id === 'random' ? undefined : workerData.id, slots });
const genMs = performance.now() - t0;
const w = g.world, N = w.elev.length, nav = g.nav, dense = w.dense;
const isDense = (t) => !!dense[t] && w.terr[t] === workerData.FOREST;
let count = 0; for (let t = 0; t < N; t++) if (isDense(t)) count++;
nav.componentOf(0, LIGHT_GROUND); const after = nav.components.infantry;
w.dense = null; nav.invalidate(); nav.componentOf(0, LIGHT_GROUND); const before = nav.components.infantry;
// connectivity: every pre-dense region maps to exactly one post-dense region (non-dense hexes)
const map = new Map(); let breaks = 0;
for (let t = 0; t < N; t++) {
  if (!(before[t] > 0) || isDense(t)) continue;
  const m = map.get(before[t]);
  if (m === undefined) map.set(before[t], after[t]); else if (m !== after[t]) breaks++;
}
// detours: infantry coarse route cost from each start to every site, without and with dense forest
const starts = g.sites.filter((s) => s.start !== undefined);
const cost = (path) => path ? path.length : Infinity;
const plain = [], withDense = [];
for (const s of starts) for (const o of g.sites) if (o !== s) plain.push(cost(nav.strategic(s.tile, o.tile, LIGHT_GROUND, false, true, 1e9)));
w.dense = dense; nav.invalidate();
for (const s of starts) for (const o of g.sites) if (o !== s) withDense.push(cost(nav.strategic(s.tile, o.tile, LIGHT_GROUND, false, true, 1e9)));
let worst = 1, lost = 0, extra = 0, unfair = 0;
plain.forEach((p, i) => { if (Number.isFinite(p) && !Number.isFinite(withDense[i])) lost++; else if (Number.isFinite(p)) { worst = Math.max(worst, withDense[i] / p); extra = Math.max(extra, withDense[i] - p); if (withDense[i] > p * 1.5 && withDense[i] - p > 4) unfair++; } });
// seat fairness: each seat's summed start-to-site route grows by a similar factor
const per = starts.length, sites = g.sites.length - 1, seatGrowth = starts.map((_, i) => { let a = 0, b = 0; for (let k = i * sites; k < (i + 1) * sites; k++) if (Number.isFinite(plain[k]) && Number.isFinite(withDense[k])) { a += plain[k]; b += withDense[k]; } return b / Math.max(1, a); });
const seatSpread = Math.max(...seatGrowth) - Math.min(...seatGrowth);
const sitesInDense = g.sites.filter((s) => isDense(s.tile)).length;
parentPort.postMessage({ id: workerData.id, count, breaks, worst, extra, unfair, seatSpread, lost, sitesInDense, genMs: Math.round(genMs) });
`;
const run = (m, seed = 11) => new Promise((resolve, reject) => {
  const w = new Worker(probe, { eval: true, workerData: { sim: SIM, id: m.id, size: m.size, players: m.players, seed, FOREST: 4 } });
  w.once('message', resolve); w.once('error', reject);
});

test('dense forest: on every catalogue map, infantry connectivity is unchanged and detours stay short', async () => {
  const { T } = await import('../server/sim/constants.js');
  assert.equal(T.FOREST, 4, 'probe assumes T.FOREST = 4');
  const results = [];
  for (const m of MAP_CATALOG) results.push(await run(m));
  for (const r of results) {
    assert.equal(r.breaks, 0, `${r.id}: dense forest split an infantry region`);
    assert.equal(r.lost, 0, `${r.id}: a start lost its infantry route to a site`);
    assert.ok(r.seatSpread <= .03, `${r.id}: dense forest favours one seat (growth spread ${r.seatSpread.toFixed(3)})`);
    assert.equal(r.sitesInDense, 0, `${r.id}: a site stands in dense forest`);
    assert.equal(r.unfair, 0, `${r.id}: a start-to-site infantry detour grew by more than half and 4 hexes (worst x${r.worst.toFixed(2)}, +${r.extra})`);
  }
  console.log('dense forest per map:', results.map((r) => `${r.id} ${r.count} (detour x${r.worst.toFixed(2)} / +${r.extra} hexes, seat spread ${r.seatSpread.toFixed(3)}, gen ${r.genMs} ms)`).join('; '));
  assert.ok(results.some((r) => r.count > 0), 'some map has dense forest');
});

test('dense forest: generated worlds keep infantry connectivity too', async () => {
  for (const seed of [3, 17]) {
    const r = await run({ id: 'random', size: 64, players: 2 }, seed);
    assert.equal(r.breaks, 0, `seed ${seed}`);
    assert.equal(r.lost, 0, `seed ${seed}`);
  }
});

test('dense forest: infantry blocked, vehicles pass, heavy hulls clear it, saved across load', async () => {
  globalThis.SE_MAP_SIZE = 64; globalThis.SE_WRAP = false;
  const { ActionGame } = await import('../server/sim/actionGame.js');
  const { LIGHT_GROUND, HEAVY_GROUND, centerOf } = await import('../server/sim/actionNavigation.js');
  const { T } = await import('../server/sim/constants.js');
  const { clearForest } = await import('../server/sim/battlefield.js');
  const { serializeGame, restoreGame } = await import('../server/sim/persist.js');
  const { denseWire } = await import('../server/sim/actionMap.js');
  let g, t = -1;
  for (const seed of [41, 5, 9, 23, 77, 101]) {
    g = new ActionGame({ id: 'dense-unit', seed, style: 'pangaea', slots: [{ human: true }, { human: true }] });
    t = g.world.dense.findIndex((v, i) => v && g.world.terr[i] === T.FOREST && Number.isFinite(g.nav.cost(i, centerOf(i).x, centerOf(i).z, HEAVY_GROUND)));
    if (t >= 0) break;
  }
  assert.ok(t >= 0, 'a dense hex exists on some 64 world');
  const c = centerOf(t), nav = g.nav;
  assert.equal(nav.cost(t, c.x, c.z, LIGHT_GROUND), Infinity, 'infantry cannot enter');
  assert.ok(Number.isFinite(nav.cost(t, c.x, c.z, HEAVY_GROUND)), 'tracked vehicles can');
  const wheeled = { move: 'wheeled', radius: .2 }, withDense = nav.cost(t, c.x, c.z, wheeled), saved = g.world.dense;
  g.world.dense = null; nav.invalidate();
  assert.equal(nav.cost(t, c.x, c.z, wheeled), withDense, 'wheeled vehicles are unchanged');
  g.world.dense = saved; nav.invalidate();
  // wire bitset
  const bits = Buffer.from(denseWire(g.world), 'base64');
  assert.ok(bits[t >> 3] & (1 << (t & 7)));
  // save / load keeps the set
  const back = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.deepEqual([...back.world.dense], [...g.world.dense]);
  // clearing reopens it
  assert.ok(clearForest(g, t));
  nav.invalidate();
  assert.ok(Number.isFinite(nav.cost(t, c.x, c.z, LIGHT_GROUND)), 'a cleared hex is open to infantry');
  assert.equal(g.world.dense[t], 0);
});
