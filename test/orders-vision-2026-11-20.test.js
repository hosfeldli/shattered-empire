// 2026-11-20 user tickets: vision rules for orders (no reachability answers about undiscovered ground), units pushed
// out of structures finished on top of them, a queued capture that finishes before the next order, terrain works
// with a height amount, units produced at the modelled doors, territory that trenches no longer extend and that
// shrinks when its claimants fall, and the longer-ranged perimeter turret that overlooks its own base.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame, FACILITY_DOORS } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS, TERRAIN_WORKS } = await import('../server/sim/actionDefinitions.js');
const { centerOf, distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { addFacility, influenceRing, openSlots } = await import('../server/sim/actionBases.js');
const { applyTerrain, completeField, terrainOrder } = await import('../server/sim/actionEngineers.js');
const { capturePending } = await import('../server/sim/actionOrders.js');
const { disk, dist } = await import('../server/sim/hex.js');
const { isWater, T } = await import('../server/sim/constants.js');
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');

const create = (seed = 41) => new ActionGame({ id: 'ov-1120', seed, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const ticks = (g, n) => { for (let i = 0; i < n; i++) g.tick(); };
function reindex(g) { g.movers.clear(); for (const u of g.units.values()) if (!ACTION_UNITS[u.type].air && !u.inside) g.movers.add(u); }
function put(g, u, p) { u.x = p.x; u.z = p.z; u.tile = tileAt(p.x, p.z); reindex(g); }
const home = (g, civ = 0) => g.sites.find((s) => s.owner === civ && s.hq);

/** Open sea nearest a point (three hexes from any shore): ground no land unit can reach or stand near. */
function deepWater(g, from) {
  let best = -1, bd = Infinity;
  for (let t = 0; t < g.world.terr.length; t++) if (g.world.terr[t] === T.DEEP && disk(t, 3).every((n) => isWater(g.world.terr[n]))) { const d = distance(centerOf(t), from); if (d < bd) { bd = d; best = t; } }
  return best;
}

// ---------------------------------------------------------------- vision rules
test('an order into undiscovered unreachable ground gives no notice and the units head toward it; discovered ground still says why', () => {
  const g = create(), civ = g.civs[0], s = home(g);
  const u = [...g.units.values()].find((v) => v.owner === 0 && ACTION_UNITS[v.type].move === 'infantry' && !v.auto);
  assert.ok(u, 'a squad');
  const sea = deepWater(g, u);
  assert.ok(sea >= 0, 'deep water on the map');
  const p = centerOf(sea);
  // discovered: the order is refused with the reason, and the cursor's reach query says so
  civ.explored[sea] = 1;
  const known = g.command(0, { c: 'move', units: [u.id], point: p });
  assert.ok(known.error, 'discovered water: refused with a reason');
  assert.equal(g.command(0, { c: 'reach', units: [u.id], point: p }).reply.reach.ok, false);
  // undiscovered: accepted without a word, the squad goes as far as it can toward it
  for (const t of disk(sea, 2)) civ.explored[t] = 0;
  const before = { x: u.x, z: u.z };
  const blind = g.command(0, { c: 'move', units: [u.id], point: p });
  assert.ok(!blind.error && !blind.note && !blind.code, `no notice (${JSON.stringify(blind)})`);
  assert.ok(u.goal, 'it has a goal');
  assert.ok(distance(u.goal, p) < distance(before, p) || distance(before, p) < 2, 'the goal lies toward the destination');
  const reach = g.command(0, { c: 'reach', units: [u.id], point: p }).reply.reach;
  assert.equal(reach.ok, true, 'the cursor is never crossed out over undiscovered ground');
  assert.equal(reach.reason, null);
  // a battle line drawn over undiscovered water shows every slot as placed
  const line = g.command(0, { c: 'deploy', units: [u.id], points: [{ x: p.x - .5, z: p.z }, { x: p.x + .5, z: p.z }], preview: true });
  assert.ok(!line.error, 'no refusal');
  assert.ok(line.reply.deploy.positions.every((q) => q[4] !== 0) && line.reply.deploy.unreachable === 0, 'no unreachable slots revealed');
  void s;
});

test('enemy units on explored ground out of sight are not sent; in sight they are', () => {
  const g = create(), civ = g.civs[0];
  const foe = [...g.units.values()].find((v) => v.owner === 1);
  civ.explored[foe.tile] = 1; civ.visible[foe.tile] = 0;
  assert.equal(g.sees(civ, foe), false);
  const snap = g.unitSnapshot(civ, { civ, vis: civ.visible, explored: civ.explored, god: false });
  const ids = (snap.units || snap.u || []).map((r) => r[0]);
  assert.ok(!ids.includes(foe.id), 'hidden while only explored');
  civ.visible[foe.tile] = 1;
  assert.equal(g.sees(civ, foe), true);
});

// ---------------------------------------------------------------- stuck inside a structure
test('units standing on a site are pushed out when a facility is placed and when a field structure is finished', () => {
  const g = create(), civ = g.civs[0], s = home(g);
  civ.res = { materials: 1e5, energy: 1e5 };
  const slot = openSlots(g, s)[0];
  const parcel = s.parcels?.find((q) => q.id === slot) || null;
  const at = parcel || centerOf(slot);
  const squad = g.spawn(civ, 'rifle_squad', at, .3), tank = g.spawn(civ, 'tank', at, .6);
  put(g, squad, { x: at.x + .05, z: at.z }); put(g, tank, { x: at.x - .1, z: at.z + .05 });
  const b = addFacility(g, civ, s, 'motor_works', slot, { instant: true });
  for (const u of [squad, tank]) assert.ok(g.nav.canStand(u.x, u.z, ACTION_UNITS[u.type]), `${u.type} stands clear of the walls`);
  // a field structure: under construction it is only its small circle; finished, its walls stand where units waited
  const field = [...g.world.owner.keys()].find((t) => g.world.owner[t] === 0 && !isWater(g.world.terr[t]) && g.obstaclesAtTile(t).length === 0 && distance(centerOf(t), s) > 3);
  const site = centerOf(field);
  const f = addFacility(g, civ, null, 'bunker', field, { point: site });
  const v = g.spawn(civ, 'rifle_squad', site, .2);
  put(g, v, { x: site.x + .1, z: site.z });
  completeField(g, f);
  assert.ok(g.nav.canStand(v.x, v.z, ACTION_UNITS.rifle_squad), 'stepped out of the finished bunker');
  assert.ok(distance(v, f) < 2.5, 'to the nearest free ground');
  void b;
});

// ---------------------------------------------------------------- queued capture
test('a capture order with a queued move holds at the site until the capture is decided', () => {
  const g = create(), civ = g.civs[0];
  const o = g.sites.find((x) => !x.slots && x.owner < 0 && !isWater(g.world.terr[x.tile]));
  for (const u of [...g.units.values()]) if (distance(u, o) < 6 && u.owner !== 0) g.units.delete(u.id);
  const u = g.spawn(civ, 'rifle_squad', o, 1.2);
  reindex(g);
  civ.siteIntel.set(o.id, g.siteWire(o, civ, true));
  assert.ok(!g.command(0, { c: 'capture', units: [u.id], site: o.id }).error);
  const after = g.nav.nearest({ x: o.x + 2.2, z: o.z }, ACTION_UNITS.rifle_squad, 1.5) || { x: o.x, z: o.z + 2 };
  assert.ok(!g.command(0, { c: 'move', units: [u.id], point: after, queue: true }).error);
  assert.equal(u.orders.length, 1, 'the move is queued');
  let waited = false;
  for (let i = 0; i < 600 && o.owner !== 0; i++) {
    g.tick();
    if (u.captureWait != null) { waited = true; assert.ok(!u.goal, 'it stays in the zone'); assert.equal(u.orders.length, 1); }
  }
  assert.equal(o.owner, 0, 'captured');
  assert.ok(waited, 'it waited at the site');
  ticks(g, 3);
  assert.equal(u.captureWait, null);
  assert.ok(u.goal && distance(u.goal, after) < 1, 'then went on to the queued point');
});

test('capturePending: decided when held, left, or the unit cannot capture', () => {
  const g = create(), civ = g.civs[0];
  const o = g.sites.find((x) => !x.slots && x.owner < 0);
  const u = g.spawn(civ, 'rifle_squad', o, .3); put(g, u, { x: o.x + .1, z: o.z });
  u.captureSite = o.id;
  assert.equal(capturePending(g, u, g.time), true);
  o.owner = 0; assert.equal(capturePending(g, u, g.time), false, 'held');
  o.owner = -1; put(g, u, { x: o.x + o.radius + 1, z: o.z }); assert.equal(capturePending(g, u, g.time), false, 'left the zone');
  put(g, u, { x: o.x, z: o.z }); assert.equal(capturePending(g, u, g.time - 999), false, 'timed out');
  const t = g.spawn(civ, 'tank', o, .5); t.captureSite = o.id; put(g, t, { x: o.x, z: o.z });
  assert.equal(capturePending(g, t, g.time), false, 'tanks do not capture');
});

// ---------------------------------------------------------------- terrain height amount
test('terrain works take a height amount for raise and lower: price, time and the change scale with it', () => {
  const g = create(), civ = g.civs[0], s = home(g);
  civ.res = { materials: 1e5, energy: 1e5 };
  assert.equal(TERRAIN_WORKS.maxAmount, 4);
  const t = [...g.world.owner.keys()].find((x) => g.world.owner[x] === 0 && terrainOrder(g, civ, 'raise', centerOf(x), true, [centerOf(x)], 0, 1).reply?.terrain?.tiles.length === 1 && g.obstaclesAtTile(x).length === 0 && distance(centerOf(x), s) > 2.5);
  assert.ok(t >= 0);
  const p = centerOf(t);
  const one = terrainOrder(g, civ, 'raise', p, true, [p], 0, 1).reply.terrain;
  const three = terrainOrder(g, civ, 'raise', p, true, [p], 0, 3).reply.terrain;
  assert.equal(three.amount, 3);
  assert.equal(three.cost.materials, one.cost.materials * 3);
  assert.ok(Math.abs(three.seconds - one.seconds * 3) < .11);
  assert.equal(terrainOrder(g, civ, 'flatten', p, true, [p], 0, 3).reply.terrain.amount, 1, 'flatten has no height amount');
  for (const bad of [0, 5, 1.5]) assert.equal(terrainOrder(g, civ, 'raise', p, true, [p], 0, bad).code, 'amount', `amount ${bad}`);
  assert.equal(g.command(0, { c: 'terrain', op: 'lower', points: [p], radius: 0, amount: 9 }).code, 'amount');
  const e0 = g.world.elev[t];
  assert.ok(!g.command(0, { c: 'terrain', op: 'raise', points: [p], radius: 0, amount: 3 }).error);
  const job = g.roadProjects.at(-1);
  assert.equal(job.amount, 3);
  // finish it at once (the engineers' work is tested elsewhere)
  applyTerrain(g, job);
  g.roadProjects.splice(g.roadProjects.indexOf(job), 1);
  const rise = g.world.elev[t] - e0;
  assert.ok(Math.abs(rise - TERRAIN_WORKS.step * 3) < 1e-6 || g.world.elev[t] === TERRAIN_WORKS.max, `raised by three steps (${rise.toFixed(3)})`);
  // the amount survives a save
  const job2 = terrainOrder(g, civ, 'lower', p, false, [p], 0, 2);
  assert.ok(!job2.error);
  const r = restoreGame(serializeGame(g));
  assert.equal(r.roadProjects.at(-1).amount, 2);
  assert.equal(stateHash(r), stateHash(g));
});

// ---------------------------------------------------------------- doors
test('every production facility puts a new unit right outside one of its modelled doors', () => {
  const trainers = Object.entries(ACTION_BUILDINGS).filter(([k, d]) => d.trains && k !== 'town' && FACILITY_DOORS[k]);
  assert.ok(trainers.length >= 5);
  for (const [type, def] of trainers) {
    const g = create(), civ = g.civs[0], s = home(g);
    civ.res = { materials: 1e6, energy: 1e6 };
    const b = addFacility(g, civ, s, type, openSlots(g, s)[0], { instant: true });
    for (const v of [...g.units.values()]) if (distance(v, b) < 2.5 && v.owner === 0) { g.units.delete(v.id); }
    reindex(g);
    const unit = (Array.isArray(def.trains) ? def.trains : Object.keys(def.trains)).find((k) => ACTION_UNITS[k]);
    const u = g.spawn(civ, unit, b, 1.2, true);
    assert.ok(u, `${type}: spawned`);
    const doors = FACILITY_DOORS[type].map(([x, z]) => g.buildingPoint(b, x, z));
    const near = Math.min(...doors.map((d) => distance(d, u)));
    const r = ACTION_UNITS[unit].radius;
    assert.ok(near < r + (ACTION_UNITS[unit].air ? .2 : b.radius + .45), `${type}/${unit}: ${near.toFixed(2)} from a door`);
    g.emerge(b, u);
    const ev = g.events.findLast((e) => e.k === 'emerge' && e.s === u.id);
    assert.ok(Math.min(...doors.map((d) => distance(d, { x: ev.ax, z: ev.az }))) < .1, `${type}: the roll-out starts in the doorway`);
  }
});

// ---------------------------------------------------------------- territory
test('trenches claim no territory; destroying the tower that extended it shrinks it and the structures beyond keep working', () => {
  const g = create(), civ = g.civs[0];
  g.refreshTerritory();
  const ring = influenceRing(g, civ);
  const clear = (t, r = 1) => disk(t, r).every((n) => !isWater(g.world.terr[n]) && g.world.owner[n] < 0);
  const trench = [...g.world.owner.keys()].find((t) => ring[t] === 1 && clear(t, 0));
  assert.ok(trench >= 0);
  g.fieldworks.set(trench, { tile: trench, ...centerOf(trench), owner: 0, progress: 1, facing: 0, hp: 100 });
  g.refreshTerritory();
  assert.ok(g.world.owner[trench] !== 0, 'a dug trench claims nothing');
  const edge = [...g.world.owner.keys()].find((t) => ring[t] === 2 && clear(t) && dist(t, trench) > 3);
  const tower = addFacility(g, civ, null, 'guard_post', edge, { point: centerOf(edge) });
  tower.done = true; tower.progress = 1; tower.state = 'operational';
  g.refreshTerritory();
  assert.equal(g.world.owner[edge], 0, 'the tower extends the territory');
  // a radar post (claims nothing) raised on that claimed ground
  const beyond = disk(edge, 1).find((t) => t !== edge && g.world.owner[t] === 0 && ring[t] >= 2 && g.obstaclesAtTile(t).length === 0);
  const post = addFacility(g, civ, null, 'sensor_post', beyond ?? edge, { point: centerOf(beyond ?? edge) });
  post.done = true; post.progress = 1; post.state = 'operational';
  g.removeBuilding(tower);
  assert.equal(g.territoryDirty, true, 'a claimant lost marks the territory for refresh');
  ticks(g, 10);   // the base economy step (every few ticks) refreshes a dirty territory
  assert.ok(g.world.owner[edge] !== 0, 'the influence shrank');
  assert.ok(g.buildings.has(post.id) && post.owner === 0 && post.done, 'the structure left outside is kept');
});

// ---------------------------------------------------------------- perimeter turret
test('the perimeter turret reaches 3.4, sees 7 and fires over its own base', () => {
  const d = ACTION_BUILDINGS.city_turret;
  assert.equal(d.range, 3.4); assert.equal(d.vision, 7); assert.ok(d.tower > 0);
  assert.ok(d.range > ACTION_UNITS.rifle_squad.range && d.range > ACTION_UNITS.anti_armor.range, 'outranges infantry');
  assert.ok(d.range < ACTION_UNITS.tank.range, 'tanks still outrange it');
  const g = create(), civ = g.civs[0], s = home(g);
  civ.res = { materials: 1e6, energy: 1e6 };
  const hall = addFacility(g, civ, s, 'motor_works', openSlots(g, s)[0], { instant: true });
  // a sight line straight through the hall: blocked for anyone, open for a gun tower of the hall's owner
  const fx = Math.sin(hall.yaw), fz = Math.cos(hall.yaw);
  const a = { x: hall.x - fx * 1.2, z: hall.z - fz * 1.2, id: -1 }, b = { x: hall.x + fx * 1.2, z: hall.z + fz * 1.2, id: -2 };
  assert.equal(g.nav.clearShot(a, b), false, 'the hall blocks an ordinary shot');
  assert.equal(g.nav.clearShot(a, b, { rise: d.tower, owner: 0 }), true, 'its own tower sees over it');
  assert.equal(g.nav.clearShot(a, b, { rise: d.tower, owner: 1 }), false, 'a rival tower does not');
});
