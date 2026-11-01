// City lifecycle: capture vs ruin under bombardment (no endless shelling at 1 HP), surrounding
// buildings change hands with a capture, rebellion cooldowns (persisted), resettling ruins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { spawnUnit, damageBuilding } from '../server/sim/military.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { cityState, revoltBlocked, REVOLT, SIEGE_RUIN } from '../server/sim/cities.js';
import { recomputeTerritory } from '../server/sim/economy.js';
import { isWater, TERRAIN } from '../server/sim/constants.js';
import { disk, dist } from '../server/sim/hex.js';

const land = (g, t) => !isWater(g.world.terr[t]) && Number.isFinite(TERRAIN[g.world.terr[t]].move) && g.tileB[t] < 0;
const mk = () => { const g = new Game({ id: 'c' + Math.random(), seed: 9, slots: [{ human: true }, { personality: 'builder' }, { personality: 'builder' }], rebels: false }); g.diplomacy.rel(0, 1).state = 'war'; for (const c of g.civs) if (c.ai) c.ai = null; return g; };
// a second city for civ 1 so it is not eliminated by losing one
const second = (g, civ) => { const cap = g.capital(civ); const t = disk(cap.tile, 9).find((x) => dist(x, cap.tile) >= 7 && land(g, x) && g.world.owner[x] < 0); const c = g.foundCity(civ, t, 4); recomputeTerritory(g); return c; };

test('bombarding an undefended town without troops to take it ruins it instead of pinning it at 1 HP', () => {
  const g = mk(); const civ1 = g.civs[1];
  second(g, civ1);
  const c = g.capital(civ1); const b = g.buildings.get(c.buildingId);
  let hits = 0;
  while (g.cities.has(c.id) && hits < 400) { damageBuilding(g, b, 60, 0, 'combat'); hits++; }
  assert.ok(!g.cities.has(c.id), 'the city is gone');
  assert.equal(g.ruins.get(c.tile)?.type, 'town', 'town ruins remain, named');
  assert.equal(g.ruins.get(c.tile).name, c.name);
  assert.ok(hits * 60 <= b.maxHp * (1 + SIEGE_RUIN) + 120, `bounded siege (${hits} hits)`);
  assert.ok(g.cityOf(civ1).some((x) => x.capital), 'the nation picked a new capital');
  assert.ok(g.stats.ruined >= 1);
});

test('capture: adjacent troops take the town, nearby buildings in the new borders change hands, the city is stabilized', () => {
  const g = mk(); const civ0 = g.civs[0], civ1 = g.civs[1];
  second(g, civ1);
  const c = g.capital(civ1); const b = g.buildings.get(c.buildingId);
  const t = disk(c.tile, 1).find((x) => x !== c.tile && land(g, x));
  spawnUnit(g, civ0, 'rifle_squad', t); g.rebuildTileUnits();
  damageBuilding(g, b, b.hp + 10, 0, 'combat');
  assert.equal(c.owner, 0, 'captured');
  assert.equal(cityState(g, c).state, 'captured');
  assert.ok(revoltBlocked(g, c), 'cannot revolt right after capture');
  const left = [...g.buildings.values()].filter((x) => x.owner === 1 && g.world.owner[x.tile] === 0 && dist(x.tile, c.tile) <= 6);
  assert.equal(left.length, 0, 'no enemy buildings left inside the captured territory');
});

test('rebellion cooldowns: a city ~300 s, the empire ~120 s, and they survive save/restore', () => {
  const g = mk(); const civ0 = g.civs[0];
  const a = second(g, civ0), b2 = (() => { const cap = g.capital(civ0); const t = disk(cap.tile, 12).find((x) => dist(x, cap.tile) >= 10 && land(g, x) && g.world.owner[x] < 0 && dist(x, a.tile) > 5); return g.foundCity(civ0, t, 4); })();
  // force a revolt in a
  a.stability = 0; a.unrestT = 100;
  for (let i = 0; i < 20 && a.owner === 0; i++) { a.stability = 0; g.tick(); g.outbox.length = 0; }
  const revolted = a.owner !== 0 || (a.revoltCooldownUntil || 0) > g.time;
  assert.ok(revolted, 'the city revolted (or rioted)');
  assert.ok(Math.abs(a.revoltCooldownUntil - g.time - REVOLT.cityCooldown) < 5);
  assert.ok(civ0.revoltCooldownUntil > g.time, 'the empire cooldown started');
  if (b2.owner === 0) assert.match(revoltBlocked(g, b2), /another city|stabiliz|recently/);
  const g2 = restoreGame(serializeGame(g));
  assert.equal(g2.cities.get(a.id).revoltCooldownUntil, a.revoltCooldownUntil, 'city cooldown persisted');
  assert.equal(g2.civs[0].revoltCooldownUntil, civ0.revoltCooldownUntil, 'empire cooldown persisted');
});

test('ruins can be resettled from your borders; the new city keeps the name and is protected for a while', () => {
  const g = mk(); const civ0 = g.civs[0];
  const a = second(g, civ0);
  const name = a.name, tile = a.tile;
  g.ruins.set(tile, { type: 'town', owner: 0, name, time: 0 }); g.cities.delete(a.id); g.removeBuilding(g.buildings.get(a.buildingId));
  g.ruins.set(tile, { type: 'town', owner: 0, name, time: 0 });
  for (const k of Object.keys(civ0.res)) civ0.res[k] = 1000;
  const prev = g.command(0, { c: 'rebuild', tile }).reply.rebuild;
  assert.ok(prev.ok, prev.why);
  const r = g.command(0, { c: 'rebuild', tile, commit: true });
  assert.ok(r.reply?.city, r.error);
  const c = g.cities.get(r.reply.city);
  assert.equal(c.name, name);
  assert.equal(cityState(g, c).state, 'rebuilding');
  assert.ok(!g.ruins.has(tile));
});
