// Ticket 3 (2026-11-20, docs/gameplay-overhaul/BASE_MENU_REWORK.md): militia and scout buggies at the headquarters,
// four units per production building, per-building unit upgrades with mechanics and kit, building levels with veterancy,
// engineers (3 / 5 / 8, upgrades, automatic repairs ranked by jobScore), perimeter turret paths, the centre turret,
// outposts as tiny bases, production in the order queued, old saves, determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS, KIT, PERIMETER_COST, REMOVED_PERIMETER_LEVELS, trainsAt } = await import('../server/sim/actionDefinitions.js');
const { addFacility, openSlots, productionStep } = await import('../server/sim/actionBases.js');
const { beginProduction, runProduction } = await import('../server/sim/actionProduction.js');
const { jobScore } = await import('../server/sim/actionEngineers.js');
const { incoming, stampUnit, structureDef } = await import('../server/sim/actionUnitUpgrades.js');
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');
const { outpostPlots } = await import('../server/sim/actionOutposts.js');

const create = (seed = 41) => new ActionGame({ id: 'bmr-' + seed, seed, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const rich = (g, age = 2) => { for (const c of g.civs) { c.res = { materials: 1e5, energy: 1e5 }; c.age = age; } };
const hqOf = (g, civ = 0) => g.buildings.get(g.sites.find((s) => s.owner === civ && s.hq).hq);
const engineers = (g, civ = 0) => [...g.units.values()].filter((u) => u.auto && u.owner === civ && u.hp > 0);
const run = (g, seconds) => { for (let i = 0; i < seconds * 10; i++) g.tick(); };

test('four units per production building, militia and scout buggies at the headquarters; no unit type deleted', () => {
  const B = ACTION_BUILDINGS;
  for (const key of ['barracks', 'motor_works', 'heavy_weapons', 'airfield', 'advanced_lab']) assert.equal(B[key].trains.length, 4, key);
  assert.deepEqual(B.town.trains, ['militia', 'scout_buggy']);
  assert.deepEqual(B.barracks.trains, ['rifle_squad', 'anti_armor', 'mortar_team', 'special_forces']);
  assert.ok(B.heavy_weapons.trains.includes('supply_truck') && B.advanced_lab.trains.includes('missile_battery'));
  const homed = new Set(Object.values(B).flatMap((d) => d.trains || []));
  for (const [key, d] of Object.entries(ACTION_UNITS)) if (!d.auto) assert.ok(homed.has(key), `${key} has a building`);
  // every trainable unit has an upgrade line of three tiers, with a mechanic and a kit bit the client draws
  for (const key of homed) {
    const u = ACTION_UNITS[key].upgrade;
    assert.ok(u && u.mech && u.kit > 0 && u.tiers.length === 3, key);
    assert.ok(u.tiers[0].cost.materials < u.tiers[2].cost.materials);
  }
  // an outpost trains militia from tier 1, buggies from tier 2
  const fort = { type: 'fort', level: 1 };
  assert.ok(trainsAt(fort, 'militia') && !trainsAt(fort, 'scout_buggy'));
  assert.ok(trainsAt({ type: 'fort', level: 2 }, 'scout_buggy'));
  const g = create(); rich(g, 0);
  const hq = hqOf(g), barracks = addFacility(g, g.civs[0], g.sites[0], 'barracks', openSlots(g, g.sites[0])[0], { instant: true });
  assert.ok(!g.command(0, { c: 'train', id: hq.id, type: 'militia' }).error);
  assert.ok(g.command(0, { c: 'train', id: barracks.id, type: 'militia' }).error, 'militia left the barracks');
});

test('production runs in the order queued, one item at a time; each type keeps its own count and cancel', () => {
  const g = create(); rich(g);
  const b = addFacility(g, g.civs[0], g.sites[0], 'barracks', openSlots(g, g.sites[0])[0], { instant: true });
  for (const [type, n] of [['rifle_squad', 1], ['anti_armor', 1], ['rifle_squad', 1]]) g.command(0, { c: 'train', id: b.id, type, count: n });
  assert.deepEqual(b.order, ['rifle_squad', 'anti_armor', 'rifle_squad']);
  assert.deepEqual(b.queues.map((q) => [q.unit, q.count]), [['rifle_squad', 2], ['anti_armor', 1]]);
  const out = [];
  const spawn = g.spawn.bind(g);
  g.spawn = (civ, type, ...rest) => { const u = spawn(civ, type, ...rest); if (u && !u.auto && type !== 'engineer') out.push(type); return u; };
  for (let i = 0; i < 400 && b.queues.length; i++) { beginProduction(); runProduction(g, g.civs[0], b, .3); g.movers.clear(); }
  assert.deepEqual(out, ['rifle_squad', 'anti_armor', 'rifle_squad'], 'delivered in the order queued');
  // cancel takes the latest queued of that type
  g.command(0, { c: 'train', id: b.id, type: 'rifle_squad', count: 2 });
  g.command(0, { c: 'train', id: b.id, type: 'mortar_team', count: 1 });
  assert.ok(!g.command(0, { c: 'cancelTrain', id: b.id, type: 'rifle_squad', count: 1 }).error);
  assert.deepEqual(b.order, ['rifle_squad', 'mortar_team']);
  assert.deepEqual(g.econSnapshot(g.civs[0], { vis: g.civs[0].visible, god: false }).buildings.find((x) => x.id === b.id).qo, ['rifle_squad', 'mortar_team']);
});

test('unit upgrades are per building, change how the unit plays and show on it', () => {
  const g = create(); rich(g);
  const civ = g.civs[0], site = g.sites[0], [s0, s1] = openSlots(g, site);
  const a = addFacility(g, civ, site, 'motor_works', s0, { instant: true }), b = addFacility(g, civ, site, 'motor_works', s1, { instant: true });
  const res = { ...civ.res };
  assert.ok(!g.command(0, { c: 'unitUpgrade', id: a.id, unit: 'tank' }).error);
  assert.equal(res.materials - civ.res.materials, ACTION_UNITS.tank.upgrade.tiers[0].cost.materials);
  assert.equal(g.command(0, { c: 'unitUpgrade', id: a.id, unit: 'armored_car' }).code, 'busy', 'one upgrade at a time per building');
  assert.equal(g.command(0, { c: 'unitUpgrade', id: a.id, unit: 'rifle_squad' }).code, 'unit');
  productionStep(g, 25);
  assert.equal(a.ug.tank, 1);
  const t1 = g.spawn(civ, 'tank', a, 1.5), t2 = g.spawn(civ, 'tank', b, 1.5);
  stampUnit(g, t1, a); stampUnit(g, t2, b);
  assert.equal(t1.mods.mech, 'reactive');
  assert.ok(!t2.mods, 'the other Vehicle Works did not buy it');
  // reactive armour: the first anti-armour hit loses half its damage, the next within the cooldown does not
  assert.equal(incoming(g, t1, { id: 0, tile: t1.tile }, 'cannon'), .5);
  assert.equal(incoming(g, t1, { id: 0, tile: t1.tile }, 'cannon'), 1);
  // the kit bit (and the tier) reach the client on the unit record (extra[7])
  const rec = g.unitSnapshot(civ, { vis: civ.visible, god: true }).units.find((r) => r[0] === t1.id);
  assert.equal(rec[20][7] & KIT.reactive, KIT.reactive);
  assert.equal(rec[20][7] >> 24 & 3, 1);
  // tier 2 needs era II, tier 3 era III
  civ.age = 0;
  assert.equal(g.command(0, { c: 'unitUpgrade', id: a.id, unit: 'tank' }).code, 'era');
});

test('a production building level is expensive and gives the units it trains veterancy', () => {
  const g = create(); rich(g, 1);
  const civ = g.civs[0], b = addFacility(g, civ, g.sites[0], 'barracks', openSlots(g, g.sites[0])[0], { instant: true });
  const old = g.spawn(civ, 'rifle_squad', b, 1.2); stampUnit(g, old, b);
  assert.equal(old.kills || 0, 0);
  assert.deepEqual(ACTION_BUILDINGS.barracks.levels.cost[0], ACTION_BUILDINGS.barracks.cost, 'level 2 costs the building again');
  assert.ok(!g.command(0, { c: 'upgradeBuilding', id: b.id }).error);
  productionStep(g, 30);
  assert.equal(b.level, 2);
  assert.equal(Math.floor(old.kills / 4), 1, 'units it already made are promoted');
  const fresh = g.spawn(civ, 'rifle_squad', b, 1.2); stampUnit(g, fresh, b);
  assert.equal(Math.floor(fresh.kills / 4), 1);
});

test('engineers: 3 / 5 / 8 by tier, upgrades in order, no repair button, repairs ranked by damage and danger', () => {
  const g = create(); rich(g);
  const site = g.sites[0], hq = hqOf(g);
  assert.equal(engineers(g).length, 3);
  site.tier = 2;
  run(g, 60);
  assert.equal(engineers(g).filter((u) => u.home === site.id).length, 5, 'the tier-II quota requeues itself');
  assert.equal(g.command(0, { c: 'repair', id: hq.id }).code, 'repair_removed');
  assert.ok(!g.command(0, { c: 'engineerUpgrade', site: site.id }).error);
  productionStep(g, 25);
  assert.equal(site.engLevel, 1);
  for (const u of engineers(g).filter((u) => u.home === site.id)) {
    assert.ok(u.mods.kit & KIT.armour, 'vests on every engineer');
    assert.ok(Math.abs(u.maxHp - ACTION_UNITS.engineer.hp * 1.6) < 1e-6);
  }
  assert.ok(!g.command(0, { c: 'engineerUpgrade', site: site.id }).error);
  productionStep(g, 35);
  assert.equal(g.command(0, { c: 'engineerUpgrade', site: site.id }).code, 'tier', 'power tools need a tier-III base');
  assert.ok(engineers(g).every((u) => u.home !== site.id || u.mods.speed > 1 && u.mods.kit & KIT.car));
  const wire = g.siteWire(site, g.civs[0], true);
  assert.equal(wire.engLevel, 2); assert.equal(wire.engQuota, 5);
  // ranking: the more damaged structure first; a job close to enemy reach is penalised
  const u = { x: 0, z: 0 }, near = { x: 2, z: 0 };
  const light = { kind: 'repair', x: 2, z: 0, target: { hp: 90, maxHp: 100, type: 'depot' } };
  const heavy = { kind: 'repair', x: 3, z: 0, target: { hp: 20, maxHp: 100, type: 'depot' } };
  assert.ok(jobScore(u, heavy, 0, 0) < jobScore(u, light, 0, 0));
  assert.ok(jobScore(u, { ...heavy, near: true }, 0, 0) > jobScore(u, heavy, 0, 0));
  assert.ok(jobScore(u, { kind: 'repair', ...near, target: { hp: 50, maxHp: 100, type: 'town' } }, 0, 0) < jobScore(u, { kind: 'repair', ...near, target: { hp: 50, maxHp: 100, type: 'depot' } }, 0, 0));
});

test('perimeter turrets choose a path and deepen it; the centre turret; the old perimeter upgrade is gone', () => {
  const g = create(); rich(g);
  const site = g.sites[0], hq = hqOf(g);
  assert.equal(g.command(0, { c: 'upgradeDefenses', site: site.id }).code, 'perimeter_paths');
  assert.ok(!g.command(0, { c: 'baseDefenses', site: site.id }).error);
  productionStep(g, 30);
  const [t1, t2] = [...g.buildings.values()].filter((b) => b.site === site.id && b.type === 'city_turret');
  assert.ok(!g.command(0, { c: 'perimeterUpgrade', id: t1.id, path: 'av' }).error);
  assert.ok(!g.command(0, { c: 'perimeterUpgrade', id: t2.id, path: 'aa' }).error);
  productionStep(g, 25);
  assert.equal(structureDef(t1).weapon, 'cannon');
  assert.equal(structureDef(t2).weapon, 'flak');
  assert.ok(structureDef(t1).range >= ACTION_BUILDINGS.city_turret.range, 'a path never shortens the turret');
  assert.equal(g.command(0, { c: 'perimeterUpgrade', id: t1.id, path: 'aa' }).code, 'path', 'the path is permanent');
  const res = { ...g.civs[0].res };
  assert.ok(!g.command(0, { c: 'perimeterUpgrade', id: t1.id }).error);
  assert.equal(res.materials - g.civs[0].res.materials, PERIMETER_COST[1].materials);
  productionStep(g, 30);
  assert.equal(t1.level, 2);
  const wire = g.econSnapshot(g.civs[1], { vis: new Uint8Array(g.world.owner.length).fill(1), god: false }).buildings.find((b) => b.id === t1.id);
  assert.equal(wire.pa, 'av', 'the path is public: rivals see the turret head');
  // the centre turret
  assert.ok(!g.command(0, { c: 'centreTurret', site: site.id }).error);
  productionStep(g, 25);
  assert.equal(hq.gun, 1);
  site.tier = 2;
  assert.ok(!g.command(0, { c: 'centreTurret', site: site.id }).error);
  productionStep(g, 35);
  assert.equal(g.siteWire(site, g.civs[0], true).aa, 1, 'the airburst fuze gives the base its AA');
});

test('outposts: tiny bases with one plot per tier, militia then buggies, an engineer at tier 3; no New Base', () => {
  const g = create(); rich(g);
  const civ = g.civs[0];
  assert.equal(ACTION_BUILDINGS.base_site, undefined);
  // an outpost beside the base, in own territory
  let fort = null;
  const home = g.sites[0];
  for (let r = 3; r <= 5 && !fort; r += .5) for (let k = 0; k < 12 && !fort; k++) {
    const p = { x: home.x + Math.sin(k * Math.PI / 6) * r, z: home.z + Math.cos(k * Math.PI / 6) * r };
    const res = g.command(0, { c: 'fieldBuild', type: 'fort', point: p });
    if (!res.error) fort = g.buildings.get(res.building);
  }
  assert.ok(fort, 'an outpost could be placed');
  fort.done = true; fort.progress = 1; fort.hp = fort.maxHp; fort.state = 'operational';
  assert.ok(!g.command(0, { c: 'train', id: fort.id, type: 'militia' }).error);
  assert.ok(g.command(0, { c: 'train', id: fort.id, type: 'scout_buggy' }).error, 'buggies from tier 2');
  assert.ok(!g.command(0, { c: 'outpostBuild', id: fort.id, type: 'depot' }).error);
  assert.equal(g.command(0, { c: 'outpostBuild', id: fort.id, type: 'power_plant' }).code, 'plots', 'one plot per tier');
  assert.equal(g.command(0, { c: 'outpostBuild', id: fort.id, type: 'airfield' }).code, 'type');
  assert.ok(!g.command(0, { c: 'upgradeBuilding', id: fort.id }).error);
  productionStep(g, 30);
  assert.equal(fort.level, 2);
  assert.ok(!g.command(0, { c: 'train', id: fort.id, type: 'scout_buggy' }).error);
  assert.ok(!g.command(0, { c: 'outpostBuild', id: fort.id, type: 'power_plant' }).error);
  assert.equal(outpostPlots(g, fort).length, 2);
  assert.ok(outpostPlots(g, fort).every((b) => b.site === -1 && b.outpost === fort.id));
  assert.ok(!engineers(g).some((u) => u.outpost === fort.id), 'no engineer before tier 3');
  assert.ok(!g.command(0, { c: 'upgradeBuilding', id: fort.id }).error);
  productionStep(g, 40);
  run(g, 3);
  assert.equal(engineers(g).filter((u) => u.outpost === fort.id).length, 1, 'tier 3: one engineer');
  // plot facilities build themselves and produce
  run(g, 30);
  assert.ok(outpostPlots(g, fort).every((b) => b.done));
});

test('an older save: moved units refunded, New Base and perimeter levels refunded, health and production intact', () => {
  const g = create(); rich(g, 1);
  const civ = g.civs[0], site = g.sites[0];
  const barracks = addFacility(g, civ, site, 'barracks', openSlots(g, site)[0], { instant: true });
  g.command(0, { c: 'baseDefenses', site: site.id });
  productionStep(g, 30);
  const data = JSON.parse(JSON.stringify(serializeGame(g)));
  const wb = data.buildings.find((b) => b.id === barracks.id);
  wb.queues = [{ unit: 'militia', count: 2, priority: 1, work: 2, paid: { materials: 11, energy: 0 }, reserved: 2, ready: false, paused: false, repeat: false, state: 'producing' },
    { unit: 'rifle_squad', count: 1, priority: 1, work: 0, paid: { materials: 0, energy: 0 }, reserved: 0, ready: false, paused: false, repeat: false, state: 'waiting' }];
  delete wb.order;
  const ds = data.action.sites.find((s) => s.id === site.id);
  ds.defenseLevel = 3;
  for (const b of data.buildings) if (b.site === site.id && b.perimeterSlot) { b.level = 3; b.maxHp *= 1.6; b.hp = b.maxHp; }
  data.buildings.push({ ...data.buildings.find((b) => b.type === 'barricade'), id: 99999, type: 'base_site', perimeterSlot: undefined, site: 0 });
  const before = { ...civ.res };
  const r = restoreGame(JSON.parse(JSON.stringify(data))), rc = r.civs[0];
  const lv = REMOVED_PERIMETER_LEVELS;
  assert.equal(rc.res.materials, before.materials + 11 + lv[0].materials + lv[1].materials + 1000);
  const rb = r.buildings.get(barracks.id);
  assert.deepEqual(rb.queues.map((q) => q.unit), ['rifle_squad']);
  assert.deepEqual(rb.order, ['rifle_squad']);
  assert.equal(r.siteById.get(site.id).defenseLevel, 1);
  assert.ok([...r.buildings.values()].filter((b) => b.site === site.id && b.perimeterSlot).every((b) => b.level === 1));
  assert.ok(!r.buildings.has(99999));
  // and it runs on deterministically
  const again = restoreGame(JSON.parse(JSON.stringify(serializeGame(r))));
  run(r, 20); run(again, 20);
  assert.equal(stateHash(r), stateHash(again));
});

test('deterministic with AI players buying upgrades; a save restores the exact state', () => {
  const make = () => new ActionGame({ id: 'bmr-ai', seed: 23, style: 'pangaea', slots: [{ ai: true, difficulty: 'brutal' }, { ai: true, difficulty: 'hard' }] });
  const a = make(), b = make();
  for (const g of [a, b]) for (const c of g.civs) { c.res.materials += 6000; c.res.energy += 3000; }
  run(a, 300); run(b, 300);
  assert.equal(stateHash(a), stateHash(b));
  // a save restores the exact state (the per-building upgrades, unit mods, research and production order included)
  const r = restoreGame(JSON.parse(JSON.stringify(serializeGame(a))));
  assert.equal(stateHash(a), stateHash(r));
  const bought = [...a.buildings.values()].some((x) => x.ug || x.upg) || a.sites.some((s) => s.engLevel);
  assert.ok(bought, 'the AI bought per-building upgrades');
});
