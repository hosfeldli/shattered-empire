// Workstream B (2026-11-16): territory-only building, defense claims, automatic engineers, new bases,
// 3/5/7 ring sites, era building levels, perimeter upgrades and city AA, functional upgrades, squads made
// of men, terrain works and per-tick income.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS, CITY_DEFENSES, TERRAIN_WORKS } = await import('../server/sim/actionDefinitions.js');
const { addFacility, armyCapacity, incomeStep, openSlots, productionStep, train } = await import('../server/sim/actionBases.js');
const { centerOf, distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { damageActionTarget } = await import('../server/sim/actionCombat.js');
const { menOf, squadFirepower } = await import('../server/sim/actionUpgrades.js');
const { disk, NB } = await import('../server/sim/hex.js');

const create = () => new ActionGame({ id: 'b-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
function reindex(g) { g.movers.clear(); for (const u of g.units.values()) if (!ACTION_UNITS[u.type].air) g.movers.add(u); }
const rich = (g, id = 0) => { g.civs[id].res = { materials: 20000, energy: 20000 }; g.civs[id].visible.fill(1); };
const engineers = (g, owner) => [...g.units.values()].filter((u) => u.owner === owner && u.auto);
const ticks = (g, n, until) => { for (let i = 0; i < n; i++) { g.tick(); if (until?.()) return true; } return !!until?.(); };
// an own-territory point where a structure of this type may be placed
function spot(g, owner, type, near, test = () => true) {
  const site = near || g.sites[owner];
  for (const t of disk(site.tile, 4)) {
    if (g.world.owner[t] !== owner || !test(t)) continue;
    const p = centerOf(t);
    if (!g.command(owner, { c: 'fieldPreview', type, point: p }).error) return p;
  }
  return null;
}

test('build wheel placements are limited to the builder\'s own territory', () => {
  const g = create(); rich(g);
  const enemy = g.sites[1];
  const hostile = disk(enemy.tile, 2).map(centerOf).find((p) => g.world.owner[tileAt(p.x, p.z)] === 1);
  const r = g.command(0, { c: 'fieldBuild', type: 'bunker', point: hostile });
  assert.equal(r.code, 'territory', r.error);
  const neutral = [...Array(g.world.owner.length).keys()].find((t) => g.world.owner[t] < 0 && g.nav.canStand(centerOf(t).x, centerOf(t).z, ACTION_UNITS.rifle_squad));
  assert.equal(g.command(0, { c: 'fieldPreview', type: 'guard_post', point: centerOf(neutral) }).code, 'territory');
  // trenches and roads too
  const t = g.command(0, { c: 'trenchWorld', points: [centerOf(neutral), centerOf(NB[neutral * 6 + 1] >= 0 ? NB[neutral * 6 + 1] : neutral)] });
  assert.ok(t.error);
  const road = g.command(0, { c: 'roadBuild', points: [{ x: enemy.x + 1.5, z: enemy.z + 1.5 }, { x: enemy.x - 1.5, z: enemy.z - 1.5 }] });
  assert.ok(road.error);
  // own land works
  assert.ok(spot(g, 0, 'bunker'), 'a bunker can be placed inside own territory');
});

test('automatic engineers: two per base, free, uncommandable, they build placed defenses and respawn', () => {
  const g = create(); rich(g);
  const team = engineers(g, 0);
  assert.equal(team.length, 2);
  assert.ok(team.every((u) => u.type === 'engineer' && u.home === g.sites[0].id));
  assert.ok(!ACTION_BUILDINGS.barracks.trains.includes('engineer'), 'engineers are not trainable');
  assert.ok(train(g, g.civs[0], [g.sites[0].hq], 'engineer', 1).error);
  assert.equal(armyCapacity(g, g.civs[0]).used, [...g.units.values()].filter((u) => u.owner === 0 && !u.auto).reduce((n, u) => n + ACTION_UNITS[u.type].capacity, 0));
  const eng = team[0], far = { x: eng.x + 2, z: eng.z + 1 };
  g.command(0, { c: 'move', units: [eng.id], point: far });
  assert.ok(!eng.goal || distance(eng.goal, far) > .5, 'players cannot order base engineers');
  const p = spot(g, 0, 'bunker');
  const placed = g.command(0, { c: 'fieldBuild', type: 'bunker', point: p });
  assert.ok(!placed.error, placed.error);
  const b = g.buildings.get(placed.building);
  productionStep(g, 30);
  assert.equal(b.done, false, 'field structures wait for the engineers');
  assert.ok(ticks(g, 1200, () => b.done), 'the engineers walk out and finish the bunker');
  // a killed engineer is replaced for free after a while
  const victim = engineers(g, 0)[0];
  g.units.delete(victim.id); reindex(g);
  assert.equal(engineers(g, 0).length, 1);
  assert.ok(ticks(g, 400, () => engineers(g, 0).length === 2), 'the lost engineer respawns');
});

test('finished defenses claim the unclaimed hexes around them; trenches too', () => {
  const g = create(), home = g.sites[0];
  const edge = disk(home.tile, 3).find((t) => g.world.owner[t] === 0 && [0, 1, 2, 3, 4, 5].some((d) => NB[t * 6 + d] >= 0 && g.world.owner[NB[t * 6 + d]] < 0));
  assert.ok(edge >= 0);
  const outside = [0, 1, 2, 3, 4, 5].map((d) => NB[edge * 6 + d]).filter((n) => n >= 0 && g.world.owner[n] < 0);
  const tower = addFacility(g, g.civs[0], null, 'guard_post', edge, { point: centerOf(edge) });
  g.refreshTerritory();
  assert.ok(outside.every((n) => g.world.owner[n] < 0), 'an unfinished tower claims nothing');
  tower.done = true; g.refreshTerritory();
  assert.ok(outside.every((n) => g.world.owner[n] === 0), 'a finished watchtower claims radius 1');
  assert.equal(ACTION_BUILDINGS.fort.name, 'Outpost'); assert.equal(ACTION_BUILDINGS.fort.claims, 2);
  g.removeBuilding(tower); g.refreshTerritory();
  assert.ok(outside.every((n) => g.world.owner[n] < 0));
  g.fieldworks.set(edge, { tile: edge, ...centerOf(edge), owner: 0, progress: 1, facing: 0, hp: 100 });
  g.refreshTerritory();
  assert.ok(outside.every((n) => g.world.owner[n] === 0), 'a dug trench section claims radius 1');
});

test('ring sites follow the base tier: 3 / 5 / 7', () => {
  const g = create(), s = g.sites[0];
  assert.deepEqual(g.defs.RULESET.slots, [3, 5, 7]);
  for (const [tier, n] of [[1, 3], [2, 5], [3, 7]]) { s.tier = tier; assert.equal(openSlots(g, s).length, n); }
});

test('a New Base (1000) in own territory beside a road becomes a real base site when the engineers finish it', () => {
  const g = create(); rich(g);
  const before = g.sites.length;
  let placed = null, point = null;
  for (const t of disk(g.sites[0].tile, 4)) {
    if (g.world.owner[t] !== 0) continue;
    const r = g.command(0, { c: 'fieldPreview', type: 'base_site', point: centerOf(t) });
    if (r.error) continue;
    assert.equal(r.reply.placement.cost.materials, 1000);
    assert.equal(r.reply.placement.parcels.length, 8);
    point = centerOf(t); placed = g.command(0, { c: 'fieldBuild', type: 'base_site', point }); break;
  }
  if (!placed) {
    // a fallback layout: lay a road through the territory edge so a valid spot exists
    g.sites[0].tier = 2; g.refreshTerritory();
    for (const t of disk(g.sites[0].tile, 4)) {
      if (g.world.owner[t] !== 0 || g.sites.some((s) => distance(s, centerOf(t)) < 5)) continue;
      const n = NB[t * 6]; if (n < 0) continue;
      g.roads.set(t, n, 2);
      const r = g.command(0, { c: 'fieldBuild', type: 'base_site', point: centerOf(t) });
      if (!r.error) { placed = r; point = centerOf(t); break; }
    }
  }
  assert.ok(placed && !placed.error, placed?.error || 'no valid new base spot');
  assert.ok(g.civs[0].res.materials <= 19000);
  const site = () => g.sites.find((s) => s.founded);
  assert.ok(ticks(g, 2500, () => !!site()), 'engineers complete the new base');
  const s = site();
  assert.equal(g.sites.length, before + 1);
  assert.equal(s.owner, 0); assert.equal(s.slots.length, 8); assert.equal(s.parcels.length, 9);
  assert.ok(g.buildings.get(s.hq)?.done, 'the new base has an operational headquarters');
  assert.equal(openSlots(g, s).length, 3);
  assert.ok(![...g.buildings.values()].some((b) => b.type === 'base_site'), 'the placeholder is replaced');
  ticks(g, 30);
  assert.equal(engineers(g, 0).filter((u) => u.home === s.id).length, 2, 'the new base staffs its own engineers');
  // spacing and road rules
  const close = g.command(0, { c: 'fieldPreview', type: 'base_site', point: { x: s.x + 1.8, z: s.z } });
  assert.ok(close.error);
});

test('era levels on buildings and perimeter upgrades (level 2 gives the city built-in AA)', () => {
  const g = create(), civ = g.civs[0], s = g.sites[0]; rich(g);
  const depot = addFacility(g, civ, s, 'depot', openSlots(g, s)[0], { instant: true });
  assert.equal(g.command(0, { c: 'upgradeBuilding', id: depot.id }).code, 'era', 'level 2 needs era II');
  civ.age = 1;
  productionStep(g, .3); const base = civ.rates.materials;
  assert.ok(!g.command(0, { c: 'upgradeBuilding', id: depot.id }).error);
  productionStep(g, 30);
  assert.equal(depot.level, 2);
  productionStep(g, .3);
  assert.ok(Math.abs(civ.rates.materials - base - ACTION_BUILDINGS.depot.materials * .4) < 1e-6, 'output +40%');
  assert.ok(g.command(0, { c: 'upgradeBuilding', id: depot.id }).error, 'level 3 needs era III');
  // perimeter
  assert.ok(g.command(0, { c: 'upgradeDefenses', site: s.id }).error, 'needs a perimeter first');
  assert.ok(!g.command(0, { c: 'baseDefenses', site: s.id }).error);
  productionStep(g, CITY_DEFENSES.time + 1);
  const pieces = [...g.buildings.values()].filter((b) => b.site === s.id && b.perimeterSlot);
  const hp = pieces[0].maxHp;
  assert.ok(!g.command(0, { c: 'upgradeDefenses', site: s.id }).error);
  productionStep(g, CITY_DEFENSES.upgrade.time[0] + 1);
  assert.equal(s.defenseLevel, 2);
  assert.ok(pieces.every((b) => b.level === 2)); assert.ok(pieces[0].maxHp > hp);
  const wire = g.siteWire(s, civ, true);
  assert.equal(wire.defenseLevel, 2); assert.equal(wire.aa, 1); assert.equal(wire.capacity, 3);
});

test('functional upgrades change behaviour: heavy armor, body armour, men and squad firepower', () => {
  const g = create(), s = g.sites.find((v) => v.slots && v.owner < 0); g.units.clear(); reindex(g);
  const at = (owner, type, dx) => { const u = g.spawn(g.civs[owner], type, { x: s.x + dx, z: s.z }, .2); u.x = s.x + dx; u.z = s.z; u.tile = tileAt(u.x, u.z); reindex(g); return u; };
  const shooter = at(1, 'rifle_squad', 2), tank = at(0, 'tank', -1), squad = at(0, 'rifle_squad', 0);
  damageActionTarget(g, tank, shooter, 40, 'rifle');
  const plain = tank.maxHp - tank.hp; tank.hp = tank.maxHp;
  assert.ok(plain > 0);
  g.civs[0].techs.add('heavy_armor');
  damageActionTarget(g, tank, shooter, 40, 'rifle');
  assert.equal(tank.hp, tank.maxHp, 'tracked vehicles ignore small arms with Heavy Armor');
  // squads: 8 men, firepower falls with casualties
  assert.equal(ACTION_UNITS.rifle_squad.men, 8);
  assert.equal(menOf(squad), 8); assert.equal(squadFirepower(squad), 1);
  squad.hp = squad.maxHp / 2;
  assert.equal(menOf(squad), 4); assert.equal(squadFirepower(squad), .5);
  // body armour: the hit that would kill a man is absorbed once per man
  squad.hp = squad.maxHp;
  g.civs[0].techs.add('body_armor');
  const per = squad.maxHp / 8;
  damageActionTarget(g, squad, shooter, per * 3, 'rifle', true);
  assert.equal(menOf(squad), 8, 'the lethal hit is absorbed');
  assert.equal(squad.plates, 1);
  const snap = g.unitSnapshot(g.civs[0], { god: true });
  const row = snap.units.find((r) => r[0] === squad.id);
  assert.equal(row[row.length - 1][8], menOf(squad), 'men count in the unit record extra[8]');
});

test('rocket teams fire a real rocket at vehicles; networked command widens vision', () => {
  const g = create(), s = g.sites.find((v) => v.slots && v.owner < 0); g.units.clear(); reindex(g);
  g.civs[0].techs.add('rocket_teams'); g.civs[0].visible.fill(1); g.civs[0].detect.fill(1);
  const squad = g.spawn(g.civs[0], 'rifle_squad', s, .2), car = g.spawn(g.civs[1], 'armored_car', { x: s.x + 1.6, z: s.z }, .1);
  assert.ok(squad && car);
  ticks(g, 60);
  assert.ok(g.events.some((e) => e.k === 'launch' && e.s === squad.id && e.rk === 1), 'a rocket launch event (rk:1)');
  const before = g.civs[0].visible.reduce((n, v) => n + v, 0);
  g.civs[0].techs.add('networked_command'); g.refreshVisibility();
  assert.ok(g.civs[0].visible.reduce((n, v) => n + v, 0) > before);
});

test('terrain works: engineers raise the ground around a point in own territory', () => {
  const g = create(); rich(g);
  const civ = g.civs[0];
  let tile = -1;
  for (const t of disk(g.sites[0].tile, 3)) if (!g.command(0, { c: 'terrain', op: 'raise', point: centerOf(t), preview: true }).error) { tile = t; break; }
  assert.ok(tile >= 0, 'a reshapeable tile in own territory');
  const e0 = g.world.elev[tile], m0 = civ.res.materials;
  assert.ok(!g.command(0, { c: 'terrain', op: 'raise', point: centerOf(tile) }).error);
  assert.equal(m0 - civ.res.materials, TERRAIN_WORKS.cost.materials);
  assert.equal(g.command(1, { c: 'terrain', op: 'raise', point: centerOf(tile) }).error.length > 0, true, 'not in someone else\'s territory');
  assert.ok(ticks(g, 1500, () => g.world.elev[tile] > e0 + .01), 'the engineers carry it out');
});

test('income accrues every tick at 10 Hz', () => {
  const g = create(), civ = g.civs[0];
  ticks(g, 6);
  const seen = [];
  for (let i = 0; i < 6; i++) { g.tick(); seen.push(civ.res.materials); }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], 'materials rise on every tick');
  const r = civ.rates.materials, m = civ.res.materials;
  incomeStep(g, .1);
  assert.ok(Math.abs(civ.res.materials - m - r * .1) < 1e-9);
});

test('trench and road lines are refused through a building (code blocked)', () => {
  const g = create(); rich(g);
  g.world.owner.fill(0);
  const p = spot(g, 0, 'bunker', null, (t) => !g.world.road[t] && [0, 3].every((d) => NB[t * 6 + d] >= 0 && !g.world.road[NB[t * 6 + d]]));
  assert.ok(p, 'a bunker spot');
  const built = g.command(0, { c: 'fieldBuild', type: 'bunker', point: p });
  assert.ok(!built.error, built.error);
  const bunker = [...g.buildings.values()].find((b) => b.type === 'bunker' && distance(b, p) < .5);
  assert.ok(bunker, 'the bunker is on the map');
  const across = [{ x: bunker.x - 1.6, z: bunker.z }, { x: bunker.x + 1.6, z: bunker.z }];
  for (const preview of [true, false]) {
    const t = g.command(0, { c: 'trenchWorld', points: across, preview });
    assert.equal(t.code, 'blocked', t.error);
    assert.match(t.error, /runs through the bunker/i);
  }
  assert.ok(![...g.fieldworks.values()].length, 'nothing was dug');
  // the same line moved clear of the walls is not refused for the building
  const beside = g.command(0, { c: 'trenchWorld', points: across.map((q) => ({ x: q.x, z: q.z + 1.4 })), preview: true });
  assert.notEqual(beside.code, 'blocked');
  // a road through the building's hex
  const t = tileAt(bunker.x, bunker.z);
  const road = g.command(0, { c: 'roadBuild', points: [centerOf(NB[t * 6 + 3]), centerOf(NB[t * 6])], preview: true });
  assert.equal(road.code, 'blocked', road.error);
});
