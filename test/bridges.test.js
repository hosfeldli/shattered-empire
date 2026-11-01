// Bridges: the Bridge tool plans a crossing between two banks (river or a short shallow strait),
// builds it as road segments with the same crews, units cross it according to its class, and a
// destroyed bridge stops carrying anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { NB } from '../server/sim/hex.js';
import { T, isWater } from '../server/sim/constants.js';
import { findPath } from '../server/sim/path.js';
import { planBridge } from '../server/sim/bridges.js';
import { spawnUnit } from '../server/sim/military.js';

const rich = (civ) => { for (const k of Object.keys(civ.res)) civ.res[k] = 1e6; };
const finish = (g, n = 4000) => { for (let i = 0; i < n; i++) { g.roads.step(g, 0.5); } };
const land = (w, t) => t >= 0 && !isWater(w.terr[t]) && Number.isFinite(g0TerrainMove(w, t)) && !w.river[t];
let g0TerrainMove = () => 1;

// a shallow-water hex with land on two opposite sides (a narrow strait)
function strait(g) {
  const w = g.world;
  for (let t = 0; t < w.terr.length; t++) {
    if (w.terr[t] !== T.SHALLOW) continue;
    for (let d = 0; d < 3; d++) { const a = NB[t * 6 + d], b = NB[t * 6 + d + 3]; if (land(w, a) && land(w, b) && w.terr[a] !== T.PEAK && w.terr[b] !== T.PEAK && w.terr[a] !== T.MOUNTAIN && w.terr[b] !== T.MOUNTAIN) return { t, a, b }; }
  }
  return null;
}

test('a bridge over a narrow strait carries units; destroyed, it carries nobody', () => {
  for (const seed of [3, 7, 11, 19, 23]) {
    const g = new Game({ id: 'br' + seed, seed, slots: [{ human: true }, { human: false }], rebels: false });
    const civ = g.civs[0]; rich(civ); civ.explored.fill(1);
    g0TerrainMove = (w, t) => g.defs.MOVE.infantry.terrain[w.terr[t]];
    const s = strait(g); if (!s) continue;
    for (const t of [s.a, s.t, s.b]) g.world.owner[t] = -1;
    assert.equal(findPath(g, civ, s.a, s.b, 'militia')?.includes(s.t) ? 'crossed' : 'no', 'no', 'no crossing before the bridge');
    const p = planBridge(g, civ, s.a, s.b, 'timber');
    assert.ok(!p.error, p.error); assert.deepEqual(p.tiles, [s.a, s.t, s.b]); assert.equal(p.water, 1);
    const plan = g.roads.plan(g, civ, p.tiles, 1, true);
    assert.equal(plan.buildable, 2, 'two bridge segments');
    assert.ok(!g.roads.plan(g, civ, p.tiles, 1, false).buildable, 'the plain road planner will not build over open water');
    assert.ok(g.roads.startProject(g, civ, plan).project);
    finish(g);
    assert.ok(g.roads.usable(s.a, s.t) && g.roads.usable(s.t, s.b), 'built');
    assert.deepEqual(findPath(g, civ, s.a, s.b, 'militia'), [s.t, s.b], 'infantry cross the bridge');
    spawnUnit(g, civ, 'tank', s.a);
    const tank = findPath(g, civ, s.a, s.b, 'tank');
    assert.ok(!tank || !tank.includes(s.t), 'a timber bridge does not carry tanks');
    g.roads.damage(s.a, s.t, 1000);
    const after = findPath(g, civ, s.a, s.b, 'militia');
    assert.ok(!after || !after.includes(s.t), 'a destroyed bridge carries nobody');
    return;
  }
  assert.fail('no narrow strait found on the test seeds');
});

test('the bridge tool refuses what cannot be bridged and names the reason', () => {
  const g = new Game({ id: 'brx', seed: 7, slots: [{ human: true }, { human: false }], rebels: false });
  const civ = g.civs[0];
  const w = g.world;
  const deep = [...w.terr.keys()].find((t) => w.terr[t] === T.DEEP);
  assert.match(planBridge(g, civ, deep, NB[deep * 6], 'timber').error, /land/);
  const landA = [...w.terr.keys()].find((t) => w.terr[t] === T.GRASS && !w.river[t]);
  const landB = NB[landA * 6 + 0];
  assert.match(planBridge(g, civ, landA, landB, 'timber').error, /river or water|No crossing/);
  assert.match(planBridge(g, civ, landA, landB, 'road').error, /Civil Engineering/);
  // a major river needs a reinforced bridge
  const major = [...w.terr.keys()].find((t) => w.river[t] && w.flow[t] > 84 && !isWater(w.terr[t]));
  if (major) {
    for (let d = 0; d < 3; d++) {
      const a = NB[major * 6 + d], b = NB[major * 6 + d + 3];
      if (a < 0 || b < 0 || isWater(w.terr[a]) || isWater(w.terr[b]) || w.river[a] || w.river[b]) continue;
      assert.match(planBridge(g, civ, a, b, 'timber').error, /major river/i);
      civ.techs.add('civil_engineering');
      assert.ok(!planBridge(g, civ, a, b, 'road').error);
      break;
    }
  }
});
