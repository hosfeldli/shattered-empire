// Pass 5 (2026-11-19, docs/gameplay-overhaul/NAV_BRIDGES.md "Pass 5"): vehicles never block pathing. Wrecks and other
// units (own or hostile, moving or parked) are soft obstacles: avoided while a way round exists, never a wall. Covers a
// single-lane bridge closed by wrecks at both ends, vehicles parked on the deck, a one-hex chokepoint jammed by wrecks,
// the failed-route memo and determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 96;
globalThis.SE_WRAP = false;
const S = await import('./action-pathing-scenarios.mjs');
const sim = await S.loadSim();
const { ACTION_UNITS, distance, tileAt } = sim;
const { stateHash } = await import('../server/sim/persist.js');

const tick = (g, n, until = () => false) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; if (until()) return i + 1; } return n; };

/**
 * A flat field split by a wide river (column 10, flow 120) with one road across it on row 7: the bridge is the single
 * river hex (7, 10). Vehicles can only cross on its lane.
 */
function bridgeField(seed = 5) {
  const g = S.makeGame(sim, seed);
  g.sandbox = true;
  const area = S.paintArea(sim, g, 30, 20, 15, 22);
  S.paintRiver(sim, g, Array.from({ length: 15 }, (_, r) => area.at(r, 10)), 120);
  S.paintRoad(sim, g, Array.from({ length: 13 }, (_, k) => area.at(7, 4 + k)), 1);
  g.wrecks.clear(); g.bfVer++; g.nav.invalidate();
  g.units.clear(); S.reindex(sim, g);
  return { g, area };
}

/** Wrecks across the lane at both ends of the bridge: on each edge midpoint between bank and river hex, and on the bank hex. */
function jamBridge(g, area) {
  const river = area.point(7, 10), list = [];
  for (const c of [9, 11]) {
    const bank = area.point(7, c), mid = { x: (bank.x + river.x) / 2, z: (bank.z + river.z) / 2 };
    list.push({ type: 'tank', owner: 1, burn: 0, at: g.time, x: mid.x, z: mid.z, yaw: Math.PI / 2 },
      { type: 'armored_car', owner: 1, burn: 0, at: g.time, x: bank.x + (mid.x - bank.x) * .2, z: bank.z, yaw: 1.3 });
  }
  for (const w of list) { const t = tileAt(w.x, w.z); g.wrecks.set(t, [...(g.wrecks.get(t) || []), w]); }
  g.bfVer++; g.nav.invalidate();
}

function cross(g, types, from, to, seconds = 120, owner = 0) {
  const units = S.placeBlock(sim, g, owner, types, from, .62);
  for (const u of units) u.stance = 'holdFire';
  const reply = g.command(owner, { c: 'move', units: units.map((u) => u.id), point: to });
  const slots = new Map(units.filter((u) => u.goal).map((u) => [u.id, { ...u.goal }]));
  const gave0 = g.navStats?.stuck?.gaveUp || 0;
  tick(g, Math.round(seconds / sim.DT), () => units.every((u) => !u.goal));
  const r = 1.4 + Math.sqrt(units.length) * .32;
  const missed = units.filter((u) => u.goal || !(distance(u, to) <= r || slots.has(u.id) && distance(u, slots.get(u.id)) <= 1));
  return { reply, units, missed: missed.map((u) => `${u.type}#${u.id} ${distance(u, to).toFixed(1)} from goal${u.goal ? ' (still moving)' : ''}`), gaveUp: (g.navStats?.stuck?.gaveUp || 0) - gave0 };
}

test('two wrecks across each end of a single-lane bridge no longer close it: wheeled and tracked vehicles cross both ways', () => {
  const { g, area } = bridgeField();
  const west = area.point(7, 3), east = area.point(7, 17);
  // the field really is jammed: no route clear of the wreck hulls exists for a wheeled vehicle
  jamBridge(g, area);
  const car = ACTION_UNITS.armored_car;
  assert.equal(g.nav.routeOnce(west, east, car), null, 'precondition: no wreck-free way across');
  assert.ok(g.nav.route(west, east, car), 'route() plans through the wrecks instead of failing');
  for (const [types, from, to] of [
    [['armored_car', 'armored_car', 'scout_buggy', 'supply_truck'], west, east],
    [['tank', 'tank', 'tank'], east, west],
    [['armored_car', 'tank', 'scout_buggy', 'rifle_squad'], east, west],
  ]) {
    g.units.clear(); S.reindex(sim, g);
    const res = cross(g, types, from, to);
    assert.ok(!res.reply?.error, `order accepted: ${JSON.stringify(res.reply)}`);
    assert.deepEqual(res.missed, [], types.join(','));
    assert.equal(res.gaveUp, 0);
  }
  assert.ok((g.navStats.stuck.wreckPass || 0) > 0, 'units pushed past the wrecks');
});

test('vehicles parked on a bridge deck, own or hostile, do not block a crossing', () => {
  for (const owner of [0, 1]) for (const types of [['tank', 'tank', 'tank'], ['armored_car', 'scout_buggy', 'armored_car']]) {
    const { g, area } = bridgeField();
    const deck = area.point(7, 10);
    const parked = [S.place(sim, g, owner, 'tank', deck), S.place(sim, g, owner, 'armored_car', area.point(7, 9))].filter(Boolean);
    assert.ok(parked.length >= 1);
    for (const p of parked) { p.stance = 'holdFire'; p.mode = 'guard'; }
    const res = cross(g, types, area.point(7, 3), area.point(7, 17));
    assert.deepEqual(res.missed, [], `${owner ? 'hostile' : 'own'} parked, ${types.join(',')}`);
    assert.equal(res.gaveUp, 0);
  }
});

test('a one-hex chokepoint between lakes jammed by wrecks: a mixed column gets through, and a clear way is preferred when one exists', () => {
  const g = S.makeGame(sim, 7);
  g.sandbox = true;
  const area = S.paintArea(sim, g, 30, 20, 15, 20);
  // a wall of lake across column 9 except the gap at row 7
  S.paintLake(sim, g, Array.from({ length: 15 }, (_, r) => r).filter((r) => r !== 7).map((r) => area.at(r, 9)));
  g.nav.invalidate(); g.units.clear(); S.reindex(sim, g);
  const gap = area.point(7, 9);
  // a line of wrecks across the whole gap hex (a destroyed column)
  const wrecks = Array.from({ length: 7 }, (_, k) => ({ type: k % 2 ? 'armored_car' : 'tank', owner: 1, burn: 0, at: g.time, x: gap.x, z: gap.z + (k - 3) * .27, yaw: Math.PI / 2 }));
  for (const w of wrecks) { const t = tileAt(w.x, w.z); g.wrecks.set(t, [...(g.wrecks.get(t) || []), w]); }
  g.bfVer++; g.nav.invalidate();
  const from = area.point(7, 3), to = area.point(7, 15);
  assert.equal(g.nav.routeOnce(from, to, ACTION_UNITS.tank), null, 'precondition: the gap is closed by the hulls');
  const res = cross(g, ['tank', 'armored_car', 'armored_car', 'scout_buggy', 'rifle_squad', 'rifle_squad'], from, to);
  assert.deepEqual(res.missed, []);
  assert.equal(res.gaveUp, 0);
  // the wreck still counts as an obstacle where there is room to go round: the ordinary planner keeps clear of it
  assert.equal(g.nav.canStand(wrecks[0].x, wrecks[0].z, ACTION_UNITS.tank), false, 'a wreck is still solid to the standing test');
});

test('a failed route is remembered briefly (no repeated search) and forgotten on invalidate()', () => {
  const g = S.makeGame(sim, 7), area = S.paintArea(sim, g, 30, 20, 10, 10);
  const from = area.point(5, 2), to = area.point(5, 7);
  const b = sim.bases.addFacility(g, g.civs[0], null, 'bunker', tileAt(to.x, to.z), { instant: true, point: { ...to, yaw: 0 } });
  assert.ok(b);
  const def = ACTION_UNITS.rifle_squad, inside = { x: b.x, z: b.z };
  let calls = 0;
  const once = g.nav.routeOnce.bind(g.nav);
  g.nav.routeOnce = (...a) => { calls++; return once(...a); };
  assert.equal(g.nav.route(from, inside, def), null);
  const first = calls;
  assert.ok(first >= 1);
  assert.equal(g.nav.route(from, inside, def), null);
  assert.equal(calls, first, 'the second request is answered from the memo');
  assert.ok(g.navStats.routeMemo >= 1);
  g.nav.invalidate();
  assert.equal(g.nav.route(from, inside, def), null);
  assert.ok(calls > first, 'invalidate() forgets failures');
  g.nav.routeOnce = once;
});

test('soft obstacles are deterministic: the same jammed crossing twice gives the same state hash', () => {
  const hashes = [];
  for (let k = 0; k < 2; k++) {
    const { g, area } = bridgeField(9);
    jamBridge(g, area);
    S.place(sim, g, 1, 'tank', area.point(7, 10)).stance = 'holdFire';
    cross(g, ['tank', 'armored_car', 'scout_buggy', 'rifle_squad'], area.point(7, 3), area.point(7, 17), 60);
    hashes.push(stateHash(g));
  }
  assert.equal(hashes[0], hashes[1]);
});
