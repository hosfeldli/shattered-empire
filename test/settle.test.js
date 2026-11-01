// Several auto-settling colonists pick different sites instead of converging on one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { spawnUnit } from '../server/sim/military.js';
import { dist } from '../server/sim/hex.js';

test('auto-settle: three colonists claim three distinct, spaced-out sites', () => {
  const g = new Game({ id: 's' + Math.random(), seed: 12, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], cap = g.capital(civ);
  civ.explored.fill(1);
  const cs = [0, 1, 2].map(() => spawnUnit(g, civ, 'colonist', cap.tile));
  g.rebuildTileUnits();
  for (const c of cs) g.command(0, { c: 'autoSettle', unit: c.id });
  for (let i = 0; i < 30; i++) { g.tick(); g.outbox.length = 0; }
  const goals = cs.map((c) => civ.colonistGoals.get(c.id)).filter((t) => t >= 0);
  assert.equal(goals.length, 3, 'each has a site');
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(dist(goals[i], goals[j]) >= 6, `sites ${i} and ${j} are apart (${dist(goals[i], goals[j])})`);
});
