// §24/§25/§30 (2026-11-18): stuck-unit recovery. Displacement-based progress (path changes are not progress), a
// bounded ladder (ghost through allies, wedge escape, replan / alternate goal, escape waypoint, vehicle unstick,
// give up), capped collision re-routes and instrumentation in game.navStats.stuck. actionOrders.js STUCK.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 104;
globalThis.SE_WRAP = false;
const S = await import('./action-pathing-scenarios.mjs');
const sim = await S.loadSim();
const { STUCK } = sim.orders;
const run = (g, ticks, until = () => false) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; if (until()) return i + 1; } return ticks; };
const countRoutes = (g) => { const box = { n: 0 }, route = g.nav.route.bind(g.nav); g.nav.route = (...a) => { box.n++; return route(...a); }; return box; };

test('a tank boxed in by idle allied tanks ghosts out instead of re-planning forever', () => {
  const g = S.makeGame(sim), area = S.paintArea(sim, g, 40, 40, 14, 18);
  S.reindex(sim, g);
  const c = area.point(7, 5), tank = S.place(sim, g, 0, 'tank', c);
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4, v = S.place(sim, g, 0, 'tank', { x: c.x + Math.sin(a) * .5, z: c.z + Math.cos(a) * .5 });
    assert.ok(v);
  }
  // pin the escorts in place: braced, no goals
  for (const u of g.units.values()) if (u !== tank && u.type === 'tank' && sim.distance(u, c) < .8) { u.braced = true; u.formation = 0; }
  const routes = countRoutes(g), to = area.point(7, 14);
  assert.ok(!g.command(0, { c: 'move', units: [tank.id], point: to }).error);
  const ticks = run(g, 600, () => !tank.goal);
  assert.ok(sim.distance(tank, to) < 1.2, `arrived (at ${sim.distance(tank, to).toFixed(2)} after ${ticks} ticks)`);
  assert.ok(routes.n <= 30, `bounded route requests: ${routes.n}`);
  // Pass 5: a unit held only by other units' bodies passes through them (PUSH) before the ladder's ghost rung
  assert.ok((g.navStats?.stuck?.ghost || 0) + (g.navStats?.stuck?.pushPast || 0) >= 1 || ticks < 200, 'it ghosted out');
});

test('a unit wedged under a new structure steps out and carries on', () => {
  const g = S.makeGame(sim), area = S.paintArea(sim, g, 40, 40, 12, 16);
  S.reindex(sim, g);
  const u = S.place(sim, g, 0, 'rifle_squad', area.point(6, 4)), to = area.point(6, 12);
  g.command(0, { c: 'move', units: [u.id], point: to });
  // a bunker appears on top of the squad (built instantly)
  const b = sim.bases.addFacility(g, g.civs[0], null, 'bunker', u.tile, { instant: true, point: { x: u.x, z: u.z, yaw: 0 } });
  assert.ok(b);
  { const ox = u.x, oz = u.z; u.x = b.x + .05; u.z = b.z; u.tile = sim.tileAt(u.x, u.z); g.movers.moved(u, ox, oz); }
  assert.ok(!g.nav.canStand(u.x, u.z, sim.ACTION_UNITS[u.type]), 'wedged');
  run(g, 900, () => !u.goal);
  assert.ok(sim.distance(u, to) < 1.2, `arrived (${sim.distance(u, to).toFixed(2)})`);
});

test('a goal that becomes occupied ends near it (alternate goal or near-goal halt), never a minute of re-planning', () => {
  const g = S.makeGame(sim), area = S.paintArea(sim, g, 40, 40, 12, 16);
  S.reindex(sim, g);
  const u = S.place(sim, g, 0, 'armored_car', area.point(6, 3)), to = area.point(6, 12);
  g.command(0, { c: 'move', units: [u.id], point: to });
  run(g, 5);
  sim.bases.addFacility(g, g.civs[0], null, 'bunker', sim.tileAt(to.x, to.z), { instant: true, point: { ...to, yaw: 0 } });
  const routes = countRoutes(g);
  const ticks = run(g, STUCK.giveUp + 100, () => !u.goal);
  assert.ok(!u.goal, 'the order ended');
  assert.ok(ticks < STUCK.giveUp, `ended before the give-up (${ticks} ticks)`);
  assert.ok(sim.distance(u, to) < 2, `ended near the goal (${sim.distance(u, to).toFixed(2)})`);
  assert.ok(routes.n <= 30, `bounded route requests: ${routes.n}`);
});

test('a unit ringed by hostile vehicles that never move pushes through them (Pass 5: units never hold a unit for good)', () => {
  const g = S.makeGame(sim), area = S.paintArea(sim, g, 40, 40, 12, 16);
  S.reindex(sim, g);
  const u = S.place(sim, g, 0, 'rifle_squad', area.point(6, 4)), to = area.point(6, 12);
  g.command(0, { c: 'move', units: [u.id], point: to });
  const ring = [];
  for (let k = 0; k < 10; k++) {
    const a = k * Math.PI / 5, v = S.place(sim, g, 1, 'tank', { x: u.x + Math.sin(a) * .42, z: u.z + Math.cos(a) * .42 });
    if (v) ring.push([v, v.x, v.z]);
  }
  const routes = countRoutes(g);
  for (let i = 0; i < 600 && u.goal; i++) {
    for (const [v, x, z] of ring) { v.x = x; v.z = z; v.hp = v.maxHp ?? v.hp; v.goal = null; v.target = 0; v.stance = 'holdFire'; }
    u.hp = u.maxHp ?? u.hp; u.stance = 'holdFire'; u.target = 0;
    g.tick(); g.outbox.length = 0;
  }
  assert.ok(!u.goal && sim.distance(u, to) < 1.2, `arrived (${sim.distance(u, to).toFixed(2)})`);
  assert.ok(g.navStats.stuck.pushPast >= 1, JSON.stringify(g.navStats.stuck));
  assert.ok(routes.n <= 10, `bounded route requests: ${routes.n}`);
});

test('a unit with no way forward gives up after the bounded ladder, with a quiet notice and a log entry', () => {
  const g = S.makeGame(sim), area = S.paintArea(sim, g, 40, 40, 12, 16);
  S.reindex(sim, g);
  g.civs[0].human = true;
  const u = S.place(sim, g, 0, 'rifle_squad', area.point(6, 4)), to = area.point(6, 12);
  g.command(0, { c: 'move', units: [u.id], point: to });
  tick5: for (let i = 0; i < 5; i++) { g.tick(); g.outbox.length = 0; if (!u.goal) break tick5; }
  // the ground around it floods (its hex becomes an island): no route, no alternate goal, no coarse corridor
  S.paintLake(sim, g, Array.from({ length: 6 }, (_, d) => sim.NB[u.tile * 6 + d]).filter((t) => t >= 0));
  // searches actually run (Pass 5: a repeated failed request is answered from nav's failed-route memo in O(1))
  const routes = { n: 0 }, once = g.nav.routeOnce.bind(g.nav);
  g.nav.routeOnce = (...a) => { routes.n++; return once(...a); };
  let notes = 0;
  for (let i = 0; i < STUCK.giveUp + 60 && u.goal; i++) {
    u.hp = u.maxHp ?? u.hp;
    g.tick();
    notes += g.outbox.filter(([, m]) => m.t === 'note' && /could not reach/.test(m.text)).length;
    g.outbox.length = 0;
  }
  const st = g.navStats.stuck;
  assert.ok(!u.goal, 'the order ended');
  assert.ok(st.ghost >= 1 && st.replan >= 1 && st.gaveUp >= 1, JSON.stringify(st));
  assert.ok(routes.n <= STUCK.blockedReplans + STUCK.replans + 8, `bounded route requests: ${routes.n}`);
  assert.ok(notes >= 1, 'owner told');
  assert.ok(g.navStats.stuckLog.length >= 1);
});
