// Pass 6 (2026-11-19, docs/performance/IMPLEMENTATION_LOG.md "Pass 6"): localized nav invalidation and the per-tick
// routing budget. A building placed or lost keeps every cached corridor, flow field and remembered failure it cannot
// affect; deferrable routes (chases, cover and trench moves, collision re-routes, stuck replans) wait for budget in a
// fair queue, so no unit waits for ever; all of it deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 96;
globalThis.SE_WRAP = false;
const S = await import('./action-pathing-scenarios.mjs');
const sim = await S.loadSim();
const { ACTION_UNITS, tileAt, ROUTE_BUDGET } = sim;
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');

const tick = (g, n) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; } };
const key = (def, a, b) => `${def.move}:${a}:${b}`;
const bunker = (g, area, r, c) => sim.bases.addFacility(g, g.civs[0], null, 'bunker', area.at(r, c), { instant: true, point: { ...area.point(r, c), yaw: 0 } });

/** A flat field 30 x 60 with a road along row 4 (cheap corridors there) and nothing else. */
function field(seed = 7) {
  const g = S.makeGame(sim, seed);
  g.sandbox = true;
  const area = S.paintArea(sim, g, 20, 10, 30, 60);
  S.paintRoad(sim, g, Array.from({ length: 56 }, (_, k) => area.at(4, 2 + k)), 2);
  g.units.clear(); S.reindex(sim, g);
  for (const b of [...g.buildings.values()]) if (area.tiles.includes(b.tile)) g.removeBuilding(b);
  g.nav.invalidate();
  return { g, area };
}

test('a building placed or lost keeps the corridors it cannot affect and drops the ones it can', () => {
  const { g, area } = field();
  const nav = g.nav, def = ACTION_UNITS.tank;
  const a = area.at(4, 3), b = area.at(4, 55), c = area.at(26, 3), d = area.at(26, 55);
  const road = nav.strategic(a, b, def), open = nav.strategic(c, d, def);
  assert.ok(road && open);
  const roadCopy = [...road];
  const before = g.navStats.localInvalidate || 0;
  // placed on the open corridor, far from the road: only the open corridor goes
  const placed = bunker(g, area, 26, 30);
  assert.equal(g.navStats.localInvalidate, before + 1, 'a building placement invalidates locally');
  assert.ok(nav.corridors.has(key(def, a, b)), 'the road corridor is kept');
  assert.ok(!nav.corridors.has(key(def, c, d)), 'the corridor through the new building is dropped');
  // what was kept is what a fresh search gives
  nav.corridors.delete(key(def, a, b));
  assert.deepEqual([...nav.strategic(a, b, def)], roadCopy);
  // lost again (costs fall): the cheap road corridor cannot be beaten through ground that far off it, the open one is
  // searched again
  nav.strategic(c, d, def);
  g.removeBuilding(placed);
  assert.ok(nav.corridors.has(key(def, a, b)), 'a far removal keeps the road corridor');
  // a building on the road corridor drops it
  bunker(g, area, 4, 30);
  assert.ok(!nav.corridors.has(key(def, a, b)), 'a building on the corridor drops it');
  // the ground changing (a new road) still drops everything
  nav.strategic(c, d, def);
  S.paintRoad(sim, g, [area.at(15, 20), area.at(15, 21)], 2);
  assert.equal(nav.corridors.size, 0, 'a ground change is a full invalidation');
});

test('remembered failures survive unrelated building changes and are dropped by those that can matter', () => {
  const { g, area } = field(9);
  const nav = g.nav, def = ACTION_UNITS.rifle_squad;
  const target = bunker(g, area, 10, 40), inside = { x: target.x, z: target.z }, from = area.point(10, 5);
  let calls = 0;
  const once = nav.routeOnce.bind(nav);
  nav.routeOnce = (...x) => { calls++; return once(...x); };
  try {
    assert.equal(nav.route(from, inside, def), null);
    assert.equal(nav.lastFail, 'goal');
    const first = calls;
    bunker(g, area, 25, 10);   // placed far away
    g.tickN++;
    assert.equal(nav.route(from, inside, def), null);
    assert.equal(calls, first, 'still answered from the memo');
    bunker(g, area, 11, 40);   // placed beside the goal: more structure never frees it
    assert.equal(nav.route(from, inside, def), null);
    assert.equal(calls, first, 'an addition beside an unstandable goal keeps the failure');
    g.removeBuilding(target);  // the goal itself freed
    const path = nav.route(from, inside, def);
    assert.ok(calls > first, 'a removal at the goal forgets the failure');
    assert.ok(path, 'and the goal is reachable now');
  } finally { nav.routeOnce = once; }
});

test('a flow field is dropped exactly when a changed hex was reached by it', () => {
  const { g, area } = field(11);
  const nav = g.nav, goal = area.point(15, 30);
  const group = S.placeBlock(sim, g, 0, ['tank', 'tank', 'tank', 'tank'], area.point(15, 20));
  nav.primeGroup(group, goal);
  nav.activeFlows.clear();
  const k = `tracked:${tileAt(goal.x, goal.z)}`, flow = nav.flows.get(k);
  assert.ok(flow);
  let far = -1;
  for (let t = 0; t < sim.N && far < 0; t++) {
    if (t === flow.goal || flow.next[t] >= 0) continue;
    let touch = false;
    for (const c of sim.disk(t, 2)) if (c === flow.goal || flow.next[c] >= 0) touch = true;
    if (!touch) far = t;
  }
  if (far >= 0) { nav.invalidate([far], 'added'); assert.ok(nav.flows.has(k), 'a change the field never reached keeps it'); }
  nav.invalidate([area.at(15, 25)], 'added');
  assert.ok(!nav.flows.has(k), 'a change on ground the field reached drops it');
});

/** Units asking for deferrable routes with the budget spent: who is let through, tick by tick. */
function contend(g, units, ticks, asks) {
  const nav = g.nav, served = new Map();
  nav.budgetWork = 0;   // every request beyond the admitted ones is refused
  const t0 = g.tickN;
  for (let k = 0; k < ticks; k++) {
    g.tickN = t0 + k + 1;
    for (const u of units) if (asks(u, k) && !served.has(u.id) && nav.mayRoute(u)) served.set(u.id, k);
  }
  return served;
}

test('the routing budget never starves a unit: queued units are let through oldest first', () => {
  const { g, area } = field(13);
  const units = Array.from({ length: 30 }, (_, i) => S.place(sim, g, 0, 'rifle_squad', area.point(10 + (i % 6) * 2, 10 + Math.floor(i / 6) * 3)));
  assert.equal(units.filter(Boolean).length, 30);
  // all ask every tick: each is through within ceil(30 / admit) + 1 ticks
  const served = contend(g, units, 40, () => true);
  assert.equal(served.size, 30);
  const bound = Math.ceil(30 / ROUTE_BUDGET.admit) + 1;
  for (const [id, k] of served) assert.ok(k <= bound, `unit ${id} waited ${k} ticks (bound ${bound})`);
  // the order of service is the order of queueing (ties by id), not the order the units are walked
  const order = [...served.entries()].sort((p, q) => p[1] - q[1] || p[0] - q[0]).map(([id]) => id);
  assert.deepEqual(order, units.map((u) => u.id));
});

test('a unit that asks only now and then is not starved by units that ask every tick', () => {
  const { g, area } = field(15);
  const units = Array.from({ length: 24 }, (_, i) => S.place(sim, g, 0, 'rifle_squad', area.point(8 + (i % 6) * 2, 10 + Math.floor(i / 6) * 3)));
  const late = units[units.length - 1];
  // the others ask every tick and ask again at once once served; the late unit asks every 9 ticks (a chase turn)
  const nav = g.nav, t0 = g.tickN;
  nav.budgetWork = 0;
  let lateServed = -1;
  for (let k = 0; k < 120 && lateServed < 0; k++) {
    g.tickN = t0 + k + 1;
    for (const u of units) {
      if (u === late) { if (k % 9 === 0 && nav.mayRoute(u)) lateServed = k; continue; }
      nav.mayRoute(u);
    }
  }
  assert.ok(lateServed >= 0, 'the occasional asker is let through');
  assert.ok(lateServed <= 9 * Math.ceil(units.length / ROUTE_BUDGET.admit + 1), `served at tick ${lateServed}`);
});

test('the wait queue is rebuilt after a restore in the order it was kept', () => {
  const { g, area } = field(17);
  const units = Array.from({ length: 8 }, (_, i) => S.place(sim, g, 0, 'rifle_squad', area.point(10, 8 + i * 3)));
  const nav = g.nav;
  nav.budgetWork = 0;
  // queued over three ticks, in an order unlike their ids
  const t0 = g.tickN;
  const waves = [[5, 2], [7, 0, 3], [1, 6, 4]];
  waves.forEach((wave, k) => { g.tickN = t0 + k + 1; for (const i of wave) nav.mayRoute(units[i]); });
  const live = [...nav.waitQueue()];
  const back = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.deepEqual(back.nav.waitQueue(), live);
  assert.deepEqual(live.slice(0, 2), [units[2].id, units[5].id], 'ties within a tick by id');
});

/** Two forces facing each other in the open, aggressive: chases, cover moves and re-routes, with no budget at all (every
 * deferrable route waits for its admission). */
function skirmish(seed, budget) {
  const { g, area } = field(seed);
  g.nav.budgetWork = budget;
  const blue = S.placeBlock(sim, g, 0, ['rifle_squad', 'rifle_squad', 'tank', 'armored_car', 'rifle_squad', 'tank'], area.point(14, 12));
  const red = S.placeBlock(sim, g, 1, ['rifle_squad', 'tank', 'rifle_squad', 'armored_car', 'rifle_squad', 'tank'], area.point(14, 24));
  for (const u of [...blue, ...red]) u.stance = 'aggressive';
  g.command(0, { c: 'move', units: blue.map((u) => u.id), point: area.point(14, 26), attackMove: true });
  g.command(1, { c: 'move', units: red.map((u) => u.id), point: area.point(14, 16), attackMove: true });
  tick(g, 600);
  return g;
}

test('the routing budget is deterministic: the same skirmish twice with no budget gives the same state', () => {
  const a = skirmish(21, 0), b = skirmish(21, 0);
  assert.ok((a.navStats.routeDeferred || 0) > 0, 'routes were deferred');
  assert.equal(stateHash(a), stateHash(b));
  // nobody is left waiting for ever: whatever is still queued was queued recently
  for (const u of a.units.values()) if (u.routeWait != null) assert.ok(a.tickN - u.routeWait <= 120, `unit ${u.id} queued since ${u.routeWait}`);
});
