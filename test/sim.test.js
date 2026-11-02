import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/sim/world.js';
import { Game } from '../server/sim/game.js';
import { T, N, isWater } from '../server/sim/constants.js';
import { dist } from '../server/sim/hex.js';

test('continent generation is deterministic and playable', () => {
  const a = new World(42); a.generate(2);
  const b = new World(42); b.generate(2);
  assert.deepEqual(a.elev, b.elev);
  let land = 0, rivers = 0;
  for (let i = 0; i < N; i++) { if (!isWater(a.terr[i])) land++; rivers += a.river[i]; }
  assert.ok(land > N * 0.25 && land < N * 0.75, 'land fraction ' + land / N);
  assert.ok(rivers > 50, 'has rivers');
  assert.ok(a.volcanoes.length >= 2, 'has volcanoes');
  assert.ok(a.riftTiles.length > 50, 'has the Great Rift');
  assert.ok(dist(a.starts[0], a.starts[1]) > 30, 'starts are far apart');
});

test('AI vs AI match runs 20 minutes with economy and combat', () => {
  const g = new Game({ id: 't', seed: 11, slots: [{ personality: 'warlord' }, { personality: 'builder' }] });
  for (let i = 0; i < 12000 && !g.over; i++) { g.tick(); g.outbox.length = 0; }
  for (const c of g.civs.filter((x) => !x.isRebel)) {
    assert.ok(c.techs.size >= 5, `${c.name} researched`);
    assert.ok(g.cityOf(c).length >= 2 || !c.alive, `${c.name} expanded`);
  }
  const pop = g.civs.filter((c) => !c.isRebel).map((c) => g.civSummary(c).pop);
  assert.ok(pop.every((p) => p > 20), 'populations grew ' + pop);
});

test('commands are validated server-side', () => {
  const g = new Game({ id: 't', seed: 3, slots: [{ human: true }, { personality: 'builder' }] });
  const civ = g.civs[0];
  assert.ok(g.command(0, { c: 'build', type: 'heavy_assembly', tile: 0 }).error, 'cannot build a Mechanization building in the Reclamation era');
  assert.ok(!g.civs[0].researching || g.civs[0].researching !== 'mechanization');
  g.command(0, { c: 'research', tech: 'mechanization' });
  assert.notEqual(g.civs[0].researching, 'mechanization', 'future-era tech is queued, not researched');
  assert.ok(g.civs[0].queue.includes('mechanization') && g.civs[0].queue.includes('motorization'), 'prerequisites queued in order');
  assert.equal(g.command(0, { c: 'research', tech: 'agronomy' }), null);
  const enemyUnit = [...g.units.values()].find((u) => u.owner === 1);
  g.command(0, { c: 'move', units: [enemyUnit.id], tile: 0 });
  assert.equal(enemyUnit.goal, -1, 'cannot order enemy units');
  assert.ok(g.command(0, { c: 'diplo', to: 1, action: 'war' }).error, 'must meet before war');
  void civ; void T;
});
