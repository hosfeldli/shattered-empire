// R4 garrisons (directive Test D): capacity enforced, protection applied, firing bonus only for slot holders,
// ineligible units refused, destruction ejects, ungarrison works, no duplication in counts, save/restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS, GARRISON, actionDefinitions } = await import('../server/sim/actionDefinitions.js');
const { tileAt, distance } = await import('../server/sim/actionNavigation.js');
const { damageActionTarget, actionCombat } = await import('../server/sim/actionCombat.js');
const { serializeGame, restoreGame } = await import('../server/sim/persist.js');

const create = () => new ActionGame({ id: 'garrison-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const hqOf = (g, owner) => [...g.buildings.values()].find((b) => b.owner === owner && b.type === 'town');
function reindex(g) {
  g.movers.clear(); g.targets.clear();
  for (const u of g.units.values()) { if (u.inside) continue; if (!ACTION_UNITS[u.type].air) g.movers.add(u); g.targets.add(u); }
  for (const b of g.buildings.values()) g.targets.add(b);
}
function place(g, owner, type, point) {
  const u = g.spawn(g.civs[owner], type, point, .3) || g.spawn(g.civs[owner], type, point, .8);
  assert.ok(u, `spawn ${type}`);
  return u;
}
function setup() {
  const g = create(), b = hqOf(g, 0);
  for (const u of [...g.units.values()]) if (!u.auto) g.units.delete(u.id);
  reindex(g);
  const near = (i) => ({ x: b.x + Math.sin(i * 1.3) * (b.radius + .5), z: b.z + Math.cos(i * 1.3) * (b.radius + .5) });
  return { g, b, near };
}
const garrison = (g, units, b) => g.command(0, { c: 'garrison', units: units.map((u) => u.id), building: b.id });

test('garrison data is published in the defs and the ruleset', () => {
  const defs = actionDefinitions({});
  assert.equal(defs.RULESET.garrison, GARRISON);
  assert.equal(defs.BUILDINGS.town.garrison, 4); assert.equal(defs.BUILDINGS.town.firingSlots, 2);
  assert.equal(defs.BUILDINGS.bunker.garrison, 2);
  assert.equal(ACTION_BUILDINGS.depot.garrison, undefined);
});

test('ineligible units are refused; capacity is enforced; occupants leave movement and targeting', () => {
  const { g, b, near } = setup();
  const tank = place(g, 0, 'tank', near(0));
  assert.match(garrison(g, [tank], b).error, /Only infantry/);
  const engineer = [...g.units.values()].find((u) => u.auto && u.owner === 0);
  if (engineer) assert.ok(garrison(g, [engineer], b).error, 'automatic engineers never garrison');
  const squads = Array.from({ length: 6 }, (_, i) => place(g, 0, 'rifle_squad', near(i + 1)));
  reindex(g);
  const total = g.units.size;
  const r = garrison(g, squads, b);
  assert.equal(r.entered + r.moving, 4, 'capacity 4');
  assert.equal(r.refused, 2);
  // walkers (if any) arrive and enter
  for (let i = 0; i < 80 && b.garrison.length < 4; i++) g.tick();
  assert.equal(b.garrison.length, 4);
  assert.match(garrison(g, squads.filter((u) => !u.inside), b).error, /full/);
  const inside = squads.filter((u) => u.inside === b.id);
  assert.equal(inside.length, 4);
  g.tick();
  for (const u of inside) {
    assert.equal(u.x, b.x); assert.equal(u.z, b.z);
    assert.ok(!g.movers.query(b.x, b.z, 2, []).includes(u), 'not in movers');
    assert.ok(!g.targets.query(b.x, b.z, 2, []).includes(u), 'not a target');
    assert.equal(g.sees(g.civs[1], u), false, 'hidden from rivals');
  }
  // no duplication: the unit count is unchanged and the owner's snapshot lists each occupant once (flag 16384)
  assert.equal(g.units.size, total);
  const own = g.unitSnapshot(g.civs[0], { god: false }).units;
  for (const u of inside) {
    const rows = own.filter((row) => row[0] === u.id);
    assert.equal(rows.length, 1); assert.ok(rows[0][8] & 16384);
  }
  g.civs[1].visible.fill(1);
  assert.ok(!g.unitSnapshot(g.civs[1], { god: false }).units.some((row) => inside.some((u) => u.id === row[0])), 'rivals do not see occupants');
  const econ = g.econSnapshot(g.civs[0], { vis: g.civs[0].visible, god: false, explored: g.civs[0].explored });
  assert.deepEqual(econ.buildings.find((x) => x.id === b.id).gar, b.garrison);
});

test('occupants take only a reduced share of blasts and none of direct fire', () => {
  const { g, b, near } = setup();
  const sheltered = place(g, 0, 'special_forces', near(1));
  const exposed = place(g, 0, 'special_forces', near(4));
  assert.equal(garrison(g, [sheltered], b).entered, 1);
  const enemy = place(g, 1, 'rifle_squad', { x: b.x + 3, z: b.z });
  const src = { id: enemy.id, owner: 1, tile: enemy.tile, x: enemy.x, z: enemy.z };
  damageActionTarget(g, b, src, 60, 'rifle');
  assert.equal(sheltered.hp, sheltered.maxHp, 'direct fire hits the structure only');
  const hp0 = b.hp;
  damageActionTarget(g, b, src, 100, 'mortar', true, .9);
  damageActionTarget(g, exposed, src, 100, 'mortar', true, .9);
  const insideLoss = sheltered.maxHp - sheltered.hp, outsideLoss = exposed.maxHp - exposed.hp;
  assert.ok(b.hp < hp0, 'the structure takes the blast');
  assert.ok(insideLoss > 0 && insideLoss < outsideLoss, `sheltered ${insideLoss} < exposed ${outsideLoss}`);
});

test('only the firing-slot holders fire, with the range bonus, from the structure', () => {
  const { g, b, near } = setup();
  const squads = Array.from({ length: 4 }, (_, i) => place(g, 0, 'rifle_squad', near(i)));
  assert.equal(garrison(g, squads, b).entered, 4);
  const def = ACTION_UNITS.rifle_squad;
  // beyond a rifle squad's normal reach, within reach + rangeBonus
  const reach = def.range + GARRISON.rangeBonus * .6;
  let enemy = null;
  for (let a = 0; a < 12 && !enemy; a++) {
    const p = { x: b.x + Math.sin(a * .52) * reach, z: b.z + Math.cos(a * .52) * reach };
    if (!g.nav.canStand(p.x, p.z, def) || !g.nav.clearShot(b, p)) continue;
    enemy = place(g, 1, 'rifle_squad', p);
    enemy.x = p.x; enemy.z = p.z; enemy.tile = tileAt(p.x, p.z);
  }
  assert.ok(enemy, 'an open firing lane');
  assert.ok(distance(b, enemy) > def.range, 'out of normal range');
  enemy.stance = 'holdFire';
  g.civs[0].visible.fill(1);
  for (let i = 0; i < 6; i++) { g.tickN++; g.time += .1; actionCombat(g); }
  const slots = b.garrison.slice(0, 2).map((id) => g.units.get(id)), rest = b.garrison.slice(2).map((id) => g.units.get(id));
  for (const u of slots) assert.ok(u.readyAt > 0, `slot holder ${u.id} fired`);
  for (const u of rest) { assert.equal(u.readyAt, 0, `occupant ${u.id} without a slot stays silent`); assert.equal(u.target, 0); }
  assert.ok(enemy.hp < enemy.maxHp, 'the enemy took fire');
});

test('ungarrison and the exit rally point', () => {
  const { g, b, near } = setup();
  const squads = Array.from({ length: 3 }, (_, i) => place(g, 0, 'rifle_squad', near(i)));
  garrison(g, squads, b);
  assert.equal(b.garrison.length, 3);
  assert.equal(g.command(0, { c: 'ungarrison', building: b.id, units: [squads[0].id] }).ungarrisoned, 1);
  assert.equal(squads[0].inside, 0);
  assert.ok(g.movers.query(squads[0].x, squads[0].z, .1, []).includes(squads[0]));
  const rally = { x: b.x + 2, z: b.z + 1 };
  assert.deepEqual(g.command(0, { c: 'garrisonRally', building: b.id, ...rally }), {});
  assert.equal(g.command(0, { c: 'ungarrison', building: b.id, all: true }).ungarrisoned, 2);
  assert.equal(b.garrison.length, 0);
  for (const u of squads.slice(1)) { assert.equal(u.inside, 0); assert.ok(u.goal, 'heading for the exit rally point'); }
  // a field order to an occupant takes it out first
  garrison(g, [squads[0]], b);
  assert.equal(squads[0].inside, b.id);
  assert.ok(!g.command(0, { c: 'move', units: [squads[0].id], x: b.x - 2, z: b.z }).error);
  assert.equal(squads[0].inside, 0); assert.equal(b.garrison.length, 0);
});

test('destruction ejects occupants, hurt', () => {
  const { g, b, near } = setup();
  const squads = Array.from({ length: 2 }, (_, i) => place(g, 0, 'special_forces', near(i)));
  garrison(g, squads, b);
  b.hp = 0; g.loseBuilding(b);
  for (const u of squads) {
    assert.ok(g.units.has(u.id));
    assert.equal(u.inside, 0);
    assert.ok(Math.abs(u.hp - u.maxHp * (1 - GARRISON.ejectDamage)) < 1e-6);
    assert.ok(distance(u, b) > .05, 'placed beside the ruin');
    assert.ok(g.movers.query(u.x, u.z, .1, []).includes(u));
  }
});

test('save and restore keep occupants inside and out of the indexes', () => {
  const { g, b, near } = setup();
  const squads = Array.from({ length: 2 }, (_, i) => place(g, 0, 'rifle_squad', near(i)));
  garrison(g, squads, b);
  const walker = place(g, 0, 'rifle_squad', { x: b.x + 3, z: b.z + 1 });
  const r = garrison(g, [walker], b);
  const r2 = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  const b2 = r2.buildings.get(b.id);
  assert.deepEqual(b2.garrison, b.garrison);
  for (const id of b2.garrison) {
    const u = r2.units.get(id);
    assert.equal(u.inside, b.id);
    assert.ok(!r2.movers.query(u.x, u.z, 1, []).includes(u));
    assert.ok(!r2.targets.query(u.x, u.z, 1, []).includes(u));
  }
  if (r.moving) {
    for (let i = 0; i < 120 && !r2.units.get(walker.id).inside; i++) r2.tick();
    assert.equal(r2.units.get(walker.id).inside, b.id, 'a squad walking in when saved still enters after restore');
  }
});
