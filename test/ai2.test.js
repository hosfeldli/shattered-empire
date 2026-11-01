// The AI coordination layer: fair perception, memory, the command arbiter's refusals, the execution
// monitor's bounded recovery, saved plans, and behavioural quality over a long AI-only match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { spawnUnit } from '../server/sim/military.js';
import { visibleHostiles } from '../server/sim/ai2/Perception.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { dist } from '../server/sim/hex.js';
import { isWater } from '../server/sim/constants.js';

const run = (g, n) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; } };
const game = (seed = 7, n = 2) => new Game({ id: 'a2' + Math.random(), seed, slots: Array.from({ length: n }, () => ({ human: false })), rebels: false });

test('perception: an AI knows only the hostile units it can see', () => {
  const g = game(); const a = g.civs[0], b = g.civs[1];
  g.diplomacy.rel(a.id, b.id).state = 'war'; g.refreshVisibility(false);
  const far = [...g.world.terr.keys()].find((t) => !isWater(g.world.terr[t]) && !a.visible[t] && dist(t, g.cityOf(a)[0].tile) > 10);
  const u = spawnUnit(g, b, 'rifle_squad', far);
  g.refreshVisibility(false);
  assert.ok(!visibleHostiles(g, a).includes(u), 'a unit under the fog is unknown');
  const near = [...g.world.terr.keys()].find((t) => a.visible[t] && !isWater(g.world.terr[t]) && !g.tileUnits.get(t)?.size);
  const v = spawnUnit(g, b, 'rifle_squad', near); g.rebuildTileUnits(); g.refreshVisibility(false);
  assert.ok(visibleHostiles(g, a).includes(v), 'a unit in plain view is seen');
  // memory: seen once, remembered with fading confidence after it vanishes from view
  a.ai.brain.begin();
  assert.ok(a.ai.brain.belief.sightings.has(v.id));
  const s = a.ai.brain.belief.sightings.get(v.id);
  assert.ok(a.ai.brain.belief.confidence(s, g.time + 90) < a.ai.brain.belief.confidence(s, g.time));
});

test('the command arbiter refuses duplicates, orders to units it does not control, and repeated failures', () => {
  const g = game(); const civ = g.civs[0], ai = civ.ai;
  run(g, 50);
  const t = g.cityOf(civ)[0].tile;
  const u = spawnUnit(g, civ, 'rifle_squad', t); g.rebuildTileUnits();
  const dest = [...g.world.terr.keys()].find((x) => !isWater(g.world.terr[x]) && dist(x, t) === 4);
  assert.ok(!ai.cmd({ c: 'move', units: [u.id], tile: dest }).error, 'the first order goes out');
  assert.equal(ai.cmd({ c: 'move', units: [u.id], tile: dest }).error, 'duplicate', 'the same order again is refused while it is being carried out');
  // a unit that belongs to a mission cannot be ordered by another controller
  ai.mil.missions.set(999, { id: 999, kind: 'defend', units: new Set([u.id]), created: g.time });
  assert.equal(ai.cmd({ c: 'hold', units: [u.id], by: 'mission:5' }).error, 'not_owner');
  ai.mil.missions.delete(999);
  // an impossible order: refused by the game three times, then the arbiter stops sending it
  for (let i = 0; i < 3; i++) ai.cmd({ c: 'build', type: 'nonexistent', tile: t });
  assert.equal(ai.cmd({ c: 'build', type: 'nonexistent', tile: t }).error, 'repeated_failure');
  assert.ok(ai.brain.diag.log.some((l) => l.kind === 'stuck'), 'and records that it is stuck');
});

test('a mission that cannot reach its objective is rerouted, then given up with a reason (never stuck forever)', () => {
  const g = game(); const civ = g.civs[0], ai = civ.ai;
  run(g, 50);
  const t = g.cityOf(civ)[0].tile;
  const u = spawnUnit(g, civ, 'rifle_squad', t); g.rebuildTileUnits();
  const sea = [...g.world.terr.keys()].find((x) => isWater(g.world.terr[x]) && g.world.terr[x] === 0);
  const m = { id: 77, kind: 'offensive', state: 'approach', units: new Set([u.id]), created: g.time, lastTile: sea, commitUntil: g.time + 999 };
  ai.mil.missions.set(77, m);
  u.pathFail = { code: 'unreachable', at: g.time };
  for (let i = 0; i < 6; i++) { g.time += 25; u.pathFail = { code: 'unreachable', at: g.time }; ai.brain.monitor.step(); }
  assert.ok(!ai.mil.missions.has(77), 'the mission was abandoned');
  assert.ok(ai.brain.diag.log.some((l) => l.kind === 'abandoned' && /no route/.test(l.text)), 'with the reason on record');
  assert.ok(ai.brain.monitor.counts.abandoned >= 1);
});

test('an AI keeps its plan and memory across a save and restore', () => {
  const g = game(11, 2);
  run(g, 3000);
  const civ = g.civs[0];
  const before = { goal: civ.strategy?.goal, posture: civ.posture, memory: civ.ai.brain.belief.sightings.size, log: civ.ai.brain.diag.log.length };
  const g2 = restoreGame(serializeGame(g));
  const c2 = g2.civs[0];
  assert.equal(c2.strategy?.goal, before.goal);
  assert.equal(c2.ai.brain.belief.sightings.size, before.memory);
  assert.equal(c2.ai.brain.diag.log.length, before.log);
  run(g2, 30);
  assert.equal(c2.strategy?.goal, before.goal, 'no new objective just because the game was loaded');
});

test('behavioural quality over a long AI match: no duplicate spam, few reversals, plans recover or end', { timeout: 600000 }, () => {
  const g = game(5, 3);
  for (const a of g.civs) for (const b of g.civs) if (a !== b && a.id < b.id) g.diplomacy.act(a, b.id, 'war');
  run(g, 20 * 600);
  for (const civ of g.civs.filter((c) => c.ai && !c.isRebel && c.alive)) {
    const q = civ.ai.brain.diag.quality();
    assert.ok(q.orders > 20, `${civ.name} acts (${q.orders} orders)`);
    assert.ok(q.duplicates <= q.orders * 0.5, `${civ.name}: duplicates are caught, not spammed (${q.duplicates}/${q.orders})`);
    assert.ok(q.oscillations <= 6, `${civ.name}: missions do not flip back and forth (${q.oscillations})`);
    assert.ok(civ.posture, 'a public posture');
  }
});
