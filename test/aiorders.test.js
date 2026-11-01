// AI order ownership and mission state machine: transitions are recorded with reasons, flip-flops
// are counted, player orders are never overridden by automation, and an assault first turns its
// guns on the defenses covering the objective.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { spawnUnit } from '../server/sim/military.js';
import { isWater, TERRAIN } from '../server/sim/constants.js';
import { disk, dist } from '../server/sim/hex.js';

const run = (g, n) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; } };
const land = (g, t) => !isWater(g.world.terr[t]) && Number.isFinite(TERRAIN[g.world.terr[t]].move) && g.tileB[t] < 0;

test('mission transitions carry reasons; a flip straight back is counted as an oscillation', () => {
  const g = new Game({ id: 'm' + Math.random(), seed: 5, slots: [{ personality: 'warlord' }, { personality: 'builder' }], rebels: false });
  const mil = g.civs[0].ai.mil;
  const m = { id: 99, kind: 'defend', units: new Set(), state: 'respond', created: 0 };
  assert.equal(mil.setState(m, 'consolidate', 'zone quiet'), true);
  assert.equal(mil.setState(m, 'consolidate', 'again'), false, 'no-op transitions are ignored');
  g.time += 3; mil.setState(m, 'respond', 'threat back');
  assert.equal(m.history.length, 2);
  assert.deepEqual(m.history[0].slice(1), ['respond', 'consolidate', 'zone quiet']);
  assert.equal(g.stats.oscillations, 1, 'respond -> consolidate -> respond within seconds is an oscillation');
});

test('automation never overrides a unit the player is directing', () => {
  const g = new Game({ id: 'o' + Math.random(), seed: 5, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], cap = g.capital(civ);
  const t = disk(cap.tile, 2).find((x) => land(g, x));
  const u = spawnUnit(g, civ, 'rifle_squad', t); g.rebuildTileUnits();
  const dest = disk(cap.tile, 5).find((x) => dist(x, cap.tile) === 5 && land(g, x));
  g.command(0, { c: 'move', units: [u.id], tile: dest });
  const other = disk(cap.tile, 5).filter((x) => dist(x, cap.tile) === 5 && land(g, x)).pop();
  g.command(0, { c: 'move', units: [u.id], tile: other, by: 'governor', auth: 'mission' });
  assert.equal(u.goal, dest, 'a mission order does not replace the player order');
  assert.equal(u.auth, 'player');
});

test('an AI assault turns its artillery on the defenses covering the objective first', () => {
  const g = new Game({ id: 's' + Math.random(), seed: 5, slots: [{ personality: 'warlord' }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], enemy = g.civs[1], ai = civ.ai;
  enemy.ai = null;
  g.diplomacy.rel(0, 1).state = 'war';
  const tc = g.capital(enemy);
  const bt = disk(tc.tile, 3).find((x) => dist(x, tc.tile) === 2 && land(g, x));
  const bunker = g.placeBuilding(enemy, 'bunker', bt, true);
  civ.visible.fill(1); civ.explored.fill(1);
  civ.knownCities.set(tc.id, { tile: tc.tile, owner: enemy.id });
  const near = disk(tc.tile, 6).filter((x) => dist(x, tc.tile) >= 5 && land(g, x));
  const guns = [], inf = [];
  for (let i = 0; i < 3; i++) guns.push(spawnUnit(g, civ, 'field_gun', near[i]));
  for (let i = 0; i < 6; i++) inf.push(spawnUnit(g, civ, 'rifle_squad', near[3 + (i % 4)]));
  g.rebuildTileUnits();
  const off = { id: 50, kind: 'offensive', target: tc.id, tile: tc.tile, buildingId: g.tileB[tc.tile], staging: near[0], units: new Set([...guns, ...inf].map((u) => u.id)), state: 'execute', commitUntil: g.time + 999, created: g.time, start: 1 };
  ai.mil.missions.set(off.id, off);
  ai.myUnits = [...g.units.values()].filter((u) => u.owner === civ.id); ai.cities = g.cityOf(civ);
  ai.mil.step([...guns, ...inf], [], ai.enemies(), 4, { allowOffensive: true });
  assert.ok(guns.every((u) => u.order.kind === 'attack' && u.order.target.kind === 'building' && u.order.target.id === bunker.id), 'every gun targets the bunker');
  assert.ok(off.suppressing >= 1);
  run(g, 1);
});

test('Final Campaign: against a nation down to its last cities the AI commits everything, and moves troops in once the town is broken', () => {
  const g = new Game({ id: 'f' + Math.random(), seed: 5, slots: [{ personality: 'warlord' }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], enemy = g.civs[1], ai = civ.ai;
  enemy.ai = null; g.diplomacy.rel(0, 1).state = 'war';
  const tc = g.capital(enemy);
  civ.visible.fill(1); civ.explored.fill(1); civ.knownCities.set(tc.id, { tile: tc.tile, owner: enemy.id });
  const near = disk(tc.tile, 7).filter((x) => dist(x, tc.tile) >= 4 && land(g, x));
  const army = []; for (let i = 0; i < 8; i++) army.push(spawnUnit(g, civ, 'rifle_squad', near[i % near.length]));
  g.rebuildTileUnits();
  ai.myUnits = [...g.units.values()].filter((u) => u.owner === civ.id); ai.cities = g.cityOf(civ);
  ai.mil.step(army, [], ai.enemies(), 6, { allowOffensive: true });
  const off = [...ai.mil.missions.values()].find((m) => m.kind === 'offensive');
  assert.ok(off && off.final, 'a final campaign');
  assert.equal(off.units.size, army.length, 'no home reserve held back');
  // skip to the assault on a broken town
  off.state = 'execute'; off.start = 1;
  const town = g.buildings.get(tc.buildingId); town.hp = town.maxHp * 0.1;
  ai.mil.step(army, [], ai.enemies(), 6, { allowOffensive: true });
  assert.equal(off.state, 'capture');
  assert.ok(army.some((u) => u.slot >= 0 && dist(u.slot, tc.tile) <= 1), 'troops are sent next to the town to take it');
});
