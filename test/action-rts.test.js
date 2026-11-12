import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { armyCapacity, openSlots, productionStep } = await import('../server/sim/actionBases.js');
const { unitMotion } = await import('../server/sim/actionOrders.js');
const { centerOf, distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { damageActionTarget, canEngage } = await import('../server/sim/actionCombat.js');
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');
const { disk } = await import('../server/sim/hex.js');

const create = (options = {}) => new ActionGame({ id: 'action-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }], ...options });
function reindex(g) { g.movers.clear(); for (const u of g.units.values()) if (!ACTION_UNITS[u.type].air) g.movers.add(u); }
function place(g, owner, type, point) {
  const u = g.spawn(g.civs[owner], type, point, .5);
  assert.ok(u, `spawn ${type}`);
  u.x = point.x; u.z = point.z; u.tile = tileAt(u.x, u.z); reindex(g); return u;
}
const neutral = (g) => g.sites.find((s) => s.slots && s.owner < 0);

test('action matches start with secured bases, compact objectives and a genuinely simple economy', () => {
  const g = create();
  assert.equal(g.ruleset, 'action-v2');
  assert.equal(g.defs.AGES.length, 3);
  assert.deepEqual(g.civs[0].res, { materials: 500, energy: 100 });
  assert.ok(g.sites.filter((s) => s.slots).length >= 6 && g.sites.filter((s) => s.slots).length <= 9);
  assert.ok(new Set(g.sites.filter((s) => s.slots).map((s) => s.kind)).size >= 3);
  assert.ok(g.sites.slice(0, 2).every((s) => s.owner >= 0 && g.buildings.get(s.hq)?.done));
  assert.ok(g.sites.filter((s) => s.slots).every((s) => s.slots.length === 8 && s.parcels.length === 9));
  assert.ok(g.sites.slice(0, 2).every((s) => openSlots(g, s).length === 4 && s.parcels.every((p) =>
    !g.world.lake[p.tile] && !g.world.river[p.tile])), 'every starting ring has four active sites and eight dry planned parcels');
  assert.equal([...g.units.values()].filter((u) => u.owner === 0).length, 5);
  assert.ok(armyCapacity(g, g.civs[0]).limit >= 5);
  const before = g.civs[0].res.materials;
  productionStep(g, .3);
  assert.ok(g.civs[0].res.materials > before);
  for (const c of ['tax', 'diplo', 'import', 'settle']) assert.ok(g.command(0, { c }).error);
});

test('only eligible ground forces capture; contested zones pause and abandoned progress decays', () => {
  const g = create(), s = neutral(g); g.units.clear(); reindex(g);
  const tank = place(g, 0, 'tank', s);
  g.captureStep(20); assert.equal(s.owner, -1);
  const infantry = place(g, 0, 'rifle_squad', { x: s.x + .24, z: s.z });
  g.captureStep(5); assert.ok(s.progress > 0);
  const saved = s.progress, hostile = place(g, 1, 'scout_buggy', { x: s.x - .24, z: s.z });
  g.captureStep(20); assert.equal(s.progress, saved); assert.equal(s.contested, true);
  g.units.delete(hostile.id); g.units.delete(tank.id); g.units.delete(infantry.id); reindex(g);
  g.time += 5; g.captureStep(1); assert.ok(s.progress < saved);
  place(g, 0, 'engineer', s); g.captureStep(20);
  assert.equal(s.owner, 0); assert.equal(s.contested, false);
});

test('headquarters require a captured site and facilities consume valid parcels', () => {
  const g = create(), s = neutral(g); g.civs[0].res = { materials: 5000, energy: 5000 };
  assert.ok(g.command(0, { c: 'establish', site: s.id }).error);
  assert.ok(g.command(0, { c: 'baseBuild', site: g.sites[0].id, type: 'town' }).error);
  s.owner = 0; reindex(g);
  const result = g.command(0, { c: 'establish', site: s.id }); assert.ok(!result.error, result.error);
  productionStep(g, 30); assert.equal(g.buildings.get(s.hq).done, true);
  assert.ok(g.command(0, { c: 'baseBuild', site: s.id, type: 'barracks' }).error === undefined);
  const facilities = [...g.buildings.values()].filter((b) => b.site === s.id && b.type !== 'town');
  assert.ok(facilities.every((b) => s.slots.includes(b.slot)));
  assert.equal(openSlots(g, s).length, 3);
});

test('motion is continuous with world facing and separate group arrival positions', () => {
  const g = create(), owned = [...g.units.values()].filter((u) => u.owner === 0 && ACTION_UNITS[u.type].capture);
  const s = g.sites[0], p = { x: s.x + 3.37, z: s.z + .61 };
  const result = g.command(0, { c: 'move', units: owned.map((u) => u.id), point: p });
  assert.ok(!result.error, result.error);
  const moving = owned.filter((u) => u.goal);
  assert.ok(moving.length >= 2);
  assert.equal(new Set(moving.map((u) => `${u.goal.x},${u.goal.z}`)).size, moving.length);
  const old = moving.map((u) => ({ x: u.x, z: u.z }));
  unitMotion(g);
  assert.ok(moving.some((u, i) => distance(u, old[i]) > .0001 && distance(u, old[i]) < .5));
  for (const u of moving) { assert.ok(Number.isFinite(u.yaw)); assert.ok(Number.isFinite(u.x)); }
  assert.ok(moving.some((u) => distance(u, centerOf(u.tile)) > .05));
});

test('capture-and-rebuild conquest preserves ruins and exact wreck history', () => {
  const g = create(), s = g.sites[1], hq = g.buildings.get(s.hq);
  const enemy = place(g, 0, 'tank', { x: s.x + 2, z: s.z });
  damageActionTarget(g, hq, enemy, 100000, 'cannon');
  assert.equal(s.owner, -1); assert.equal(s.hq, 0); assert.ok(g.ruins.has(s.tile));
  assert.ok(g.craters.has(s.tile));
  const victim = place(g, 1, 'tank', { x: s.x - .23, z: s.z + .25 });
  damageActionTarget(g, victim, enemy, 100000, 'cannon');
  const wreck = g.wrecks.get(victim.tile).find((w) => w.x === victim.x);
  assert.equal(wreck.z, victim.z);
  assert.ok(!canEngage(enemy, { type: 'fighter', isUnit: true }));
});

test('production reserves command capacity; shared queues and reinforcement groups persist', () => {
  const g = create(), c = g.civs[0];
  c.res = { materials: 10000, energy: 10000 };
  const construction = g.command(0, { c: 'baseBuild', site: g.sites[0].id, type: 'barracks' });
  assert.ok(!construction.error, construction.error);
  productionStep(g, 18);
  const b = g.buildings.get(construction.building);
  const id = [...g.units.values()].find((u) => u.owner === 0).id;
  assert.ok(!g.command(0, { c: 'group', group: 2, units: [id] }).error);
  assert.ok(!g.command(0, { c: 'rallyGroup', group: 2, buildings: [b.id] }).error);
  assert.ok(!g.command(0, { c: 'batchTrain', buildings: [b.id], unit: 'rifle_squad', count: 2 }).error);
  assert.equal(armyCapacity(g, c).queued, 4);
  productionStep(g, 100);
  assert.ok(c.groups.get(2).units.length > 1);
  const saved = JSON.parse(JSON.stringify(serializeGame(g))), restored = restoreGame(saved);
  assert.equal(restored.ruleset, 'action-v2');
  assert.equal(restored.civs[0].groups.get(2).units.length, c.groups.get(2).units.length);
  assert.equal(restored.buildings.get(b.id).rallyGroup, 2);
});

test('action saves continue deterministic spatial simulation without legacy reinterpretation', () => {
  const g = create(); for (let i = 0; i < 30; i++) g.tick();
  const data = JSON.parse(JSON.stringify(serializeGame(g)));
  assert.equal(data.v, 5);
  const restored = restoreGame(data);
  assert.equal(stateHash(restored), stateHash(g));
  for (let i = 0; i < 20; i++) { g.tick(); restored.tick(); }
  assert.equal(stateHash(restored), stateHash(g));
  assert.throws(() => restoreGame({ ...data, v: 4 }), /Unsupported ring-city RTS/);
  assert.throws(() => restoreGame({ ...data, ruleset: 'action-v1', v: 4 }), /has not been converted/);
});

test('allies contest as one team and hostile visibility remains authoritative', () => {
  const g = create({ teamSize: 2, slots: Array.from({ length: 4 }, () => ({ human: true })) });
  assert.equal(g.hostile(0, 1), false); assert.equal(g.hostile(0, 2), true);
  g.refreshVisibility();
  const hidden = [...g.units.values()].find((u) => u.owner === 2 && !g.sees(g.civs[0], u));
  assert.ok(hidden);
  assert.ok(g.command(0, { c: 'attack', target: hidden.id, units: [...g.units.values()].filter((u) => u.owner === 0).map((u) => u.id) }).error);
});

test('base upgrades and saves preserve the actual parcel position and facing', () => {
  const g = create(), s = g.sites[0], b = g.buildings.get(s.hq), c = g.civs[0];
  const before = { x: b.x, z: b.z, yaw: b.yaw };
  assert.ok(s.parcels.some((p) => p.tile === b.tile && p.x === b.x && p.yaw === b.yaw));
  c.res = { materials: 5000, energy: 5000 };
  const parcels = structuredClone(s.parcels);
  assert.equal(openSlots(g, s).length, 4);
  assert.ok(!g.command(0, { c: 'advance', site: s.id }).error);
  productionStep(g, 60);
  assert.equal(s.tier, 2);
  assert.equal(openSlots(g, s).length, 6);
  assert.equal(c.age, 1);
  assert.equal(armyCapacity(g, c).limit, 120);
  assert.deepEqual(s.parcels, parcels);
  assert.deepEqual({ x: b.x, z: b.z, yaw: b.yaw }, before);
  const restored = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.deepEqual(restored.sites[0].parcels, s.parcels);
  assert.deepEqual({ x: restored.buildings.get(b.id).x, z: restored.buildings.get(b.id).z, yaw: restored.buildings.get(b.id).yaw }, before);
});

test('units escape an authoritative wreck created under their footprint', () => {
  const g = create(), s = neutral(g); g.units.clear(); reindex(g);
  const u = place(g, 0, 'rifle_squad', s), origin = { x: u.x, z: u.z };
  g.wrecks.set(u.tile, [{ type: 'tank', owner: 1, x: u.x, z: u.z, burn: 0 }]);
  const destination = g.nav.nearest({ x: u.x + 1.1, z: u.z + .2 }, ACTION_UNITS[u.type], 2);
  assert.ok(destination);
  assert.ok(!g.command(0, { c: 'move', units: [u.id], point: destination }).error);
  for (let i = 0; i < 40; i++) { g.tickN++; unitMotion(g); }
  assert.ok(distance(u, origin) > .30, 'new wrecks must not immobilize surviving troops');
});

test('queued attacks retain preceding movement and a full queue never replaces the active order', () => {
  const g = create(), u = [...g.units.values()].find((u) => u.owner === 0), target = [...g.units.values()].find((u) => u.owner === 1);
  g.civs[0].visible.fill(1); g.civs[0].detect.fill(1);
  assert.ok(!g.command(0, { c: 'move', units: [u.id], point: { x: u.x + 2, z: u.z } }).error);
  const goal = { ...u.goal };
  assert.ok(!g.command(0, { c: 'attack', target: target.id, units: [u.id], queue: true }).error);
  for (let i = 1; i < 8; i++) g.command(0, { c: 'move', units: [u.id], point: { x: u.x + 3, z: u.z + i * .1 }, queue: true });
  assert.equal(u.orders.length, 8);
  const response = g.command(0, { c: 'attack', target: target.id, units: [u.id], queue: true });
  assert.ok(response.error);
  assert.deepEqual(u.goal, goal); assert.equal(u.orders[0].kind, 'attack');
});
