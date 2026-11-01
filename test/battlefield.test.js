// Battlefield intensity and no man's land: sustained shelling wears the ground through stages, with
// effects on movement and cover; it recovers slowly once fighting stops; infantry under fire scrape
// out capped, temporary field positions; everything persists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena, spawnGroup } from '../server/sim/sandbox.js';
import { addIntensity, intensityStage, scarCost, FIELD_POS } from '../server/sim/battlefield.js';
import { coverAt } from '../server/sim/combat.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';

const run = (g, n, each) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; each && each(); } };
const sandbox = () => { const g = new Game({ id: 'b' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); return g; };

test('shelling turns ground into no man\'s land in stages; vehicles bog down; it recovers slowly', () => {
  const g = sandbox(); const t = findArena(g);
  const cost0 = scarCost(g, t, 'wheeled');
  for (let i = 0; i < 12; i++) g.areaImpactForTest(1, t, 'howitzer');
  const st = g.intensity.get(t)?.st || 0;
  assert.ok(st >= 1, `the ground is churned (stage ${st})`);
  addIntensity(g, t, 80);
  assert.equal(intensityStage(g.intensity.get(t).v), 3);
  assert.ok(scarCost(g, t, 'wheeled') > cost0 + 0.3, 'wheeled vehicles labour through it');
  const v0 = g.intensity.get(t).v;
  run(g, 10 * 60);                       // a quiet minute: nothing yet
  assert.ok(g.intensity.get(t).v > v0 - 2);
  run(g, 10 * 600);                      // ten quiet minutes: visibly better
  assert.ok((g.intensity.get(t)?.v || 0) < v0 - 10, 'recovering');
});

test('infantry holding under fire dig temporary field positions (capped), which give cover and vanish when abandoned', () => {
  const g = sandbox(); const t = findArena(g);
  addIntensity(g, t, 30);
  const us = spawnGroup(g, 0, 'rifle_squad', t, 3); for (const u of us) { u.stance = 'hold'; u.lastCombat = g.time; }
  const cov0 = coverAt(g, us[0]);
  run(g, 10 * 25, () => { for (const u of us) u.lastCombat = g.time; });
  const held = us.filter((u) => g.fieldPos.has(u.tile));
  assert.ok(held.length >= 1, 'foxholes appeared');
  const u = held[0];
  assert.ok(coverAt(g, u) >= Math.min(0.6, cov0) && coverAt(g, u) >= FIELD_POS.cover * 0.99, 'they give cover');
  const g2 = restoreGame(serializeGame(g));
  assert.equal(g2.fieldPos.size, g.fieldPos.size, 'persisted');
  assert.equal(g2.intensity.size, g.intensity.size);
  // cap
  addIntensity(g, t, 0);
  for (const x of us) g.units.delete(x.id); g.rebuildTileUnits();
  run(g, 10 * (FIELD_POS.abandon + 5));
  assert.equal([...g.fieldPos.values()].filter((f) => f.o === 0).length, 0, 'abandoned positions collapse');
});
