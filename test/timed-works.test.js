// native-v4 timed works: upgrades and repairs are paid projects that take time; nothing levels up
// or heals instantly, engineers accelerate the work, fire halts it, cancelling refunds part of the
// cost, and earlier rulesets keep their instant behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { spawnUnit } from '../server/sim/military.js';
import { EXPANSIVE_RULESET, WORKS_RULESET } from '../server/sim/rulesets.js';
import { disk } from '../server/sim/hex.js';

const newGame = (ruleset = WORKS_RULESET) => new Game({ id: 'works' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false, ruleset });
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; } };
const rich = (civ) => { for (const k of Object.keys(civ.res)) civ.res[k] = 5000; };
function farms(g, n = 1) {
  const civ = g.civs[0], cap = g.capital(civ);
  for (const c of g.cities.values()) if (c.owner === 0) { c.governor.enabled = false; c.governor.level = 'off'; }
  rich(civ); civ.age = 1;
  return disk(cap.tile, 3).filter((t) => g.canPlace(civ, 'farm', t, true)).slice(0, n).map((t) => g.makeBuilding(civ, 'farm', t, true));
}

test('an upgrade is a timed project: paid at once, level only on completion', () => {
  const g = newGame(), civ = g.civs[0];
  const [farm] = farms(g);
  const steelBefore = civ.res.materials;
  const r = g.command(0, { c: 'upgrade', id: farm.id });
  assert.ok(!r?.error, JSON.stringify(r));
  assert.ok(civ.res.materials < steelBefore, 'cost is charged when work begins');
  assert.equal(farm.level || 1, 1, 'no instant level');
  assert.ok(farm.works && farm.works.k === 'upgrade');
  assert.match(g.command(0, { c: 'upgrade', id: farm.id }).error, /already/);
  run(g, 10);
  assert.equal(farm.level || 1, 1, 'still building after a second');
  run(g, Math.ceil(farm.works.total * 10 / 0.5));
  assert.equal(farm.level, 2, 'level arrives when the works finish');
  assert.equal(farm.works, undefined);
  assert.equal(farm.upgrading, false);
});

test('engineers nearby make works finish sooner; fire on the site halts them', () => {
  const slow = newGame(), fast = newGame();
  const [a] = farms(slow), [b] = farms(fast);
  spawnUnit(fast, fast.civs[0], 'engineer', b.tile); spawnUnit(fast, fast.civs[0], 'engineer', b.tile);
  slow.command(0, { c: 'upgrade', id: a.id }); fast.command(0, { c: 'upgrade', id: b.id });
  run(slow, 50); run(fast, 50);
  assert.ok(b.works === undefined || b.works.left < a.works.left, 'engineers accelerate the project');
  const g = newGame(); const [c] = farms(g);
  g.command(0, { c: 'upgrade', id: c.id });
  const left = c.works.left;
  c.lastHit = g.time + 100;                    // under fire for the whole interval
  run(g, 30);
  assert.equal(c.works.left, left, 'no progress while the site is under fire');
  assert.equal(c.works.halt, 1);
});

test('repairs heal progressively; cancelling refunds part of the remaining cost', () => {
  const g = newGame(), civ = g.civs[0];
  const [farm] = farms(g);
  farm.hp = farm.maxHp * 0.3;
  const hp0 = farm.hp;
  assert.equal(g.command(0, { c: 'repair', id: farm.id }), null);
  assert.ok(farm.hp - hp0 < 1, 'no instant heal');
  assert.match(g.command(0, { c: 'repair', id: farm.id }).error, /under way/);
  run(g, 40);
  assert.ok(farm.hp > hp0, 'repair restores health over time');
  const [other] = farms(g, 2).slice(1);
  g.command(0, { c: 'upgrade', id: other.id });
  const before = civ.res.materials;
  const res = g.command(0, { c: 'cancelWorks', id: other.id });
  assert.ok(res.reply && res.reply.cancelled === 'upgrade');
  assert.ok(civ.res.materials > before, 'part of the cost comes back');
  assert.equal(other.works, undefined);
  assert.equal(other.level || 1, 1);
});

test('works survive save/restore and earlier rulesets keep instant upgrades', () => {
  const g = newGame();
  const [farm] = farms(g);
  g.command(0, { c: 'upgrade', id: farm.id });
  run(g, 20);
  const restored = restoreGame(serializeGame(g));
  const again = restored.buildings.get(farm.id);
  assert.deepEqual(again.works.k, 'upgrade');
  assert.ok(Math.abs(again.works.left - farm.works.left) < 1e-9);
  const legacy = newGame(EXPANSIVE_RULESET);
  const [old] = farms(legacy);
  legacy.command(0, { c: 'upgrade', id: old.id });
  assert.equal(old.level, 2, 'native-v3 matches keep their instant upgrades');
  assert.equal(old.works, undefined);
});

test('native-v4 indirect-fire crews are slower and more fragile; earlier rulesets unchanged', async () => {
  const { movementRate, SUPPORT_FIRE } = await import('../server/sim/rulesets.js');
  const { UNITS } = await import('../server/sim/constants.js');
  const v4 = newGame(), v3 = newGame(EXPANSIVE_RULESET);
  const mortar = UNITS.mortar_team, rifles = UNITS.rifle_squad;
  assert.ok(Math.abs(movementRate(v4, mortar) - movementRate(v3, mortar) * SUPPORT_FIRE.movement) < 1e-9);
  assert.equal(movementRate(v4, rifles), movementRate(v3, rifles), 'line infantry keep their pace');
  const a = spawnUnit(v4, v4.civs[0], 'mortar_team', v4.capital(v4.civs[0]).tile);
  const b = spawnUnit(v3, v3.civs[0], 'mortar_team', v3.capital(v3.civs[0]).tile);
  assert.ok(a.maxHp < b.maxHp, 'mortar crews are less durable in native-v4');
  assert.equal(restoreGame(serializeGame(v4)).ruleset, WORKS_RULESET);
});
