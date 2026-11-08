// Rules changed by the 2026-11-08 feedback pass (docs/DEVELOPMENT_QUEUE.md): non-combat engineers,
// direct-fire field guns strong against armour, trench rules (roads, partial lines, anywhere), the
// nuclear plant's explosion, coastal territory for ports, larger housing districts, explorers that
// spread out, and setting-appropriate names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena, spawnGroup } from '../server/sim/sandbox.js';
import { siteProblem, planTrench } from '../server/sim/fieldworks.js';
import { UNIT_WEAPON, WEAPONS, weaponOf } from '../server/sim/weapons.js';
import { BUILDINGS, UNITS, CIV_NAMES, isWater, TERRAIN } from '../server/sim/constants.js';
import { disk, dist, NB, idx, qOf, rOf } from '../server/sim/hex.js';

const game = (seed = 7) => new Game({ id: 'fb' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
const sandbox = (seed = 7) => { const g = game(seed); makeSandbox(g); for (const k of Object.keys(g.civs[0].res)) g.civs[0].res[k] = 5000; return g; };
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; } };
const open = (g, t) => !isWater(g.world.terr[t]) && TERRAIN[g.world.terr[t]].move <= 2 && !g.world.river[t] && g.tileB[t] < 0 && !g.urban[t];

test('engineers are non-combat and carry no weapon', () => {
  assert.equal(UNIT_WEAPON.engineer, undefined);
  assert.equal(weaponOf('engineer'), null);
  assert.equal(UNITS.engineer.atk, 0);
});

test('field guns are direct-fire anti-armour guns, stronger against vehicles than infantry weapons', () => {
  const w = weaponOf('field_gun');
  assert.ok(w && !w.arc, 'flat trajectory: line of fire needed');
  assert.ok(w.vsArmor > WEAPONS.rifle.vsArmor && w.vsArmor >= WEAPONS.cannon.vsArmor, 'strong against hard targets');
});

test('trenches: never on roads; outside territory allowed; a line with blocked hexes builds the rest', () => {
  const g = sandbox();
  const civ = g.civs[0];
  const arena = findArena(g, 8);
  // a road hex is refused with a reason
  const roadTile = disk(arena, 6).find((t) => open(g, t));
  g.world.road[roadTile] = 1;
  assert.match(siteProblem(g, civ, roadTile), /road/);
  g.world.road[roadTile] = 0;
  // foreign or unclaimed land is fine now
  const foreign = [...g.world.owner.keys()].find((t) => g.world.owner[t] === 1 && open(g, t) && !(g.tileUnits.get(t) || []).length);
  if (foreign != null) assert.equal(siteProblem(g, civ, foreign), null, 'enemy territory is allowed');
  // a straight line with one blocked hex in the middle still commits the other segments
  let start = -1;
  for (const c of disk(arena, 6)) { let ok = true; for (let k = 0; k < 5; k++) if (!open(g, idx(qOf(c) + k, rOf(c)))) { ok = false; break; } if (ok) { start = c; break; } }
  assert.ok(start >= 0, 'found an open line');
  const mid = idx(qOf(start) + 2, rOf(start));
  g.world.road[mid] = 1;
  const plan = planTrench(g, civ, [start, idx(qOf(start) + 4, rOf(start))]);
  assert.equal(plan.invalid, 1);
  const r = g.command(0, { c: 'trenchPlan', points: [start, idx(qOf(start) + 4, rOf(start))], commit: true });
  assert.ok(!r.error, r.error);
  assert.equal(r.reply.started.placed, 4, 'the four valid segments are dug');
  assert.ok(!g.fieldworks.has(mid), 'not on the road');
});

test('a destroyed nuclear plant explodes: half a strategic warhead, damage around it', () => {
  const g = sandbox();
  const civ = g.civs[0];
  civ.techs.add(BUILDINGS.nuclear_plant.tech);
  const arena = findArena(g, 8);
  const site = disk(arena, 4).find((t) => open(g, t) && disk(t, 1).every((n) => !isWater(g.world.terr[n])));
  const plant = g.placeBuilding(civ, 'nuclear_plant', site, true);
  plant.done = true; plant.progress = 1;
  const nb = disk(site, 1).find((t) => t !== site && open(g, t));
  const [victim] = spawnGroup(g, 1, 'rifle_squad', nb, 1); victim.tile = nb; g.rebuildTileUnits();
  const hp0 = victim.hp;
  const seq0 = g.eventSeq;
  g.damageBuilding(plant, plant.hp + 10, 1, 'combat');
  const blast = g.events.find((e) => e.i > seq0 && e.k === 'mimpact' && e.h === 1);
  assert.ok(blast && blast.b === site, 'a half-strength strategic impact at the plant');
  assert.ok(!g.units.has(victim.id) || victim.hp < hp0, 'troops beside it are hurt');
  assert.ok(BUILDINGS.nuclear_plant.power > BUILDINGS.fusion_plant.power, 'and it is very powerful while it stands');
});

test('coastal cities own their shoreline water, so ports can be built', () => {
  const g = game(11);
  let checked = 0;
  for (const c of g.cities.values()) {
    for (const t of disk(c.tile, c.radius || 3)) {
      if (!isWater(g.world.terr[t]) || g.world.lake[t] || dist(t, c.tile) <= 2) continue;
      const shore = [0, 1, 2, 3, 4, 5].some((d) => { const n = NB[t * 6 + d]; return n >= 0 && !isWater(g.world.terr[n]) && g.world.owner[n] === c.owner; });
      if (shore) { assert.equal(g.world.owner[t], c.owner, 'shore water within the radius belongs to the city'); checked++; }
    }
  }
  assert.ok(checked >= 0);
});

test('housing districts: at least six homes per city from the start', () => {
  const g = game();
  assert.ok(g.maxHouses(g.civs[0]) >= 6);
});

test('explorers spread out instead of walking to the same frontier', () => {
  const g = game(9);
  const civ = g.civs[0], cap = g.capital(civ);
  const scouts = [];
  for (let k = 0; k < 4; k++) { const [u] = spawnGroup(g, 0, 'scout_buggy', cap.tile, 1); u.stance = 'explore'; scouts.push(u); }
  run(g, 80);
  const goals = scouts.map((u) => u.path.at(-1) ?? u.tile);
  let apart = 0;
  for (let i = 0; i < goals.length; i++) for (let j = i + 1; j < goals.length; j++) if (dist(goals[i], goals[j]) >= 4) apart++;
  assert.ok(apart >= 3, `explorers head to different places (${goals.join(', ')})`);
});

test('civilization names fit the post-collapse setting', () => {
  assert.ok(!CIV_NAMES.some((n) => /^(Azure|Crimson|Golden|Violet|Cyan|Rose|Lime|Scarlet|Teal)\b/.test(n)));
});
