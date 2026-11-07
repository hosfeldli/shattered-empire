// AI and pacing (backlog J): human-like reaction delay by skill, disengaging from a war, and
// captured cities counting half toward an AI's own settlement target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { reactionDelay } from '../server/sim/missions.js';
import { spawnUnit } from '../server/sim/military.js';

const newGame = () => new Game({ id: 'aip' + Math.random(), seed: 7, slots: [{ human: true }, { human: true }], rebels: false, ruleset: WORKS_RULESET });

test('reaction delay shrinks with skill', () => {
  assert.ok(reactionDelay(0) > reactionDelay(2) && reactionDelay(2) > reactionDelay(4));
  assert.ok(reactionDelay(4) >= 1, 'even the best AI is not instantaneous');
});

test('disengaging withdraws troops from enemy territory and is refused when not fighting', () => {
  const g = newGame(), me = g.civs[0], them = g.civs[1];
  assert.match(g.command(0, { c: 'diplo', to: 1, action: 'disengage' }).error, /not fighting|not met/);
  g.diplomacy.rel(0, 1).state = 'war';
  const theirCity = [...g.cities.values()].find((c) => c.owner === 1);
  const u = spawnUnit(g, me, 'rifle_squad', theirCity.tile);
  u.stance = 'aggressive';
  const r = g.command(0, { c: 'diplo', to: 1, action: 'disengage' });
  assert.ok(!r?.error, JSON.stringify(r));
  assert.equal(r.reply.withdrawing >= 1, true);
  assert.equal(u.stance, 'defensive');
  void them;
});

test('captured cities count half toward the AI settlement target', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../server/sim/ai.js', import.meta.url), 'utf8');
  assert.match(src, /capturedAt != null \? 0\.5 : 1/);
});
