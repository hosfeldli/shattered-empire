// NAV_BRIDGES (2026-11-18, docs/gameplay-overhaul/NAV_BRIDGES.md): pathfinding at bridges, in base compounds and
// around wrecks, and the crossing rule (no bridge at match start; a bridge is laid with the road through it).
// The scenarios are the reproduction of tools/nav-bridge-city-repro.mjs, cut down to the cases that failed before.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 96;
globalThis.SE_WRAP = false;
const S = await import('./action-pathing-scenarios.mjs');
const sim = await S.loadSim();
const { connect, ROAD_BRIDGE_COST, ROAD_EDGE_COST, roadEdgesCost, isBridgeSegment } = await import('../server/sim/actionMap.js');
const { roadRouteBetween } = await import('../server/sim/actionEngineers.js');
const { reachQuery } = await import('../server/sim/actionOrders.js');
const { touchesWreck, wreckHull, LIGHT_GROUND } = await import('../server/sim/actionNavigation.js');
const { ACTION_UNITS, NB, distance, centerOf, tileAt } = sim;

const tick = (g, n, until = () => false) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; if (until()) return i + 1; } return n; };
const wide = (g, t) => !!g.world.river[t] && !g.world.lake[t] && g.world.flow[t] >= 94;

/** A real seeded map with its main sites joined by roads (bridges laid with them), and its wide-river bridge spans. */
function roadedMap(seed) {
  const g = S.makeGame(sim, seed);
  const main = g.sites.filter((s) => s.slots);
  for (const s of main) for (const o of main.filter((o) => o !== s).sort((a, b) => distance(s, a) - distance(s, b)).slice(0, 2)) connect(g, s.tile, o.tile);
  g.nav.invalidate();
  const seen = new Set(), spans = [];
  for (const e of g.roads.edges.values()) for (const t of [e.a, e.b]) {
    if (seen.has(t) || !wide(g, t) || !g.world.road[t]) continue;
    const tiles = [t]; seen.add(t);
    for (let i = 0; i < tiles.length; i++) for (let d = 0; d < 6; d++) {
      const n = NB[tiles[i] * 6 + d];
      if (n >= 0 && !seen.has(n) && wide(g, n) && g.roads.usable(tiles[i], n)) { seen.add(n); tiles.push(n); }
    }
    const banks = [];
    for (const s of tiles) for (let d = 0; d < 6; d++) {
      const n = NB[s * 6 + d];
      if (n < 0 || tiles.includes(n) || !g.roads.usable(s, n)) continue;
      let at = n, prev = s;
      for (let k = 0; k < 4; k++) {
        let next = -1;
        for (let dd = 0; dd < 6; dd++) { const m = NB[at * 6 + dd]; if (m >= 0 && m !== prev && !tiles.includes(m) && g.roads.usable(at, m) && !g.world.river[m]) { next = m; break; } }
        if (next < 0) break;
        prev = at; at = next;
      }
      banks.push(at);
    }
    if (banks.length >= 2) spans.push({ tiles, a: banks[0], b: banks[banks.length - 1] });
  }
  return { g, spans };
}
function bankPoint(g, t, def, off) {
  const c = centerOf(t);
  for (let a = 0; a < 8; a++) {
    const p = { x: c.x + Math.sin(a * Math.PI / 4) * off, z: c.z + Math.cos(a * Math.PI / 4) * off };
    if (g.nav.canStand(p.x, p.z, def) && !g.world.river[tileAt(p.x, p.z)]) return p;
  }
  return g.nav.nearest(c, def, 1.5);
}
/** Order a block of `types` from `start` to `goal`; every member must arrive (stop within the group radius or 1 of its slot). */
function crossAll(g, types, start, goal, seconds = 150) {
  g.units.clear(); S.reindex(sim, g);
  const units = S.placeBlock(sim, g, 0, types, start, .62);
  const reply = g.command(0, { c: 'move', units: units.map((u) => u.id), point: goal });
  const slots = new Map(units.filter((u) => u.goal).map((u) => [u.id, { ...u.goal }]));
  const gave0 = g.navStats?.stuck?.gaveUp || 0;
  tick(g, Math.round(seconds / sim.DT), () => units.every((u) => !u.goal));
  const r = 1.4 + Math.sqrt(units.length) * .32;
  const missed = units.filter((u) => u.goal || !(distance(u, goal) <= r || slots.has(u.id) && distance(u, slots.get(u.id)) <= 1));
  return { reply, units, missed: missed.map((u) => `${u.type}#${u.id} ${distance(u, goal).toFixed(1)} from goal${u.goal ? ' (still moving)' : ''}`), gaveUp: (g.navStats?.stuck?.gaveUp || 0) - gave0 };
}

test('a vehicle on the dry part of a wide-river hex beside a bridge is not standing on passable ground (no coarse-graph trap)', () => {
  const { g, spans } = roadedMap(3);
  assert.ok(spans.length, 'the map has a wide-river bridge');
  const tank = ACTION_UNITS.tank, rifle = ACTION_UNITS.rifle_squad;
  let checked = 0;
  for (const span of spans) for (const t of span.tiles) for (let d = 0; d < 6; d++) {
    const n = NB[t * 6 + d];
    if (n < 0 || !wide(g, n) || g.world.road[n]) continue;
    // every off-road point of a wide-river hex: vehicles cannot stand there (the coarse graph calls it road-only);
    // infantry wade it as before
    const c = centerOf(n);
    for (const [ox, oz] of [[.45, 0], [-.45, 0], [0, .45], [0, -.45]]) {
      assert.equal(g.nav.canStand(c.x + ox, c.z + oz, tank), false, `hex ${n} (${ox},${oz})`);
      checked++;
    }
    assert.equal(g.nav.roadOnly(n, tank), true);
    assert.equal(g.nav.roadOnly(n, rifle), false);
  }
  assert.ok(checked > 0, 'river hexes beside the bridge were checked');
});

test('groups cross real bridges both ways with no unit left at a bridge end (tanks, wheeled, mixed)', () => {
  // before (HEAD 8e6bfef): seed 3 bridge 0 lost one tank of six (A>B, its slot refused: it stood on a river hex the
  // coarse search could not leave) and seed 41 two tanks each way (deadlocked at the bridge end on a lane sliver)
  for (const seed of [3, 41]) {
    const { g, spans } = roadedMap(seed);
    const span = spans[0];
    assert.ok(span, `seed ${seed} has a wide-river bridge`);
    for (const types of [Array(6).fill('tank'), ['armored_car', 'armored_car', 'scout_buggy', 'supply_truck', 'field_gun', 'armored_car'],
      ['tank', 'tank', 'armored_car', 'armored_car', 'rifle_squad', 'rifle_squad', 'rifle_squad', 'anti_armor', 'mech_infantry', 'scout_buggy']]) {
      for (const [from, to] of [[span.a, span.b], [span.b, span.a]]) {
        const d0 = ACTION_UNITS[types[0]];
        const r = crossAll(g, types, bankPoint(g, from, d0, 1.1), bankPoint(g, to, d0, .8));
        assert.ok(!r.reply.error, r.reply.error);
        assert.deepEqual(r.missed, [], `seed ${seed} ${types[0]} group ${from}->${to}`);
        assert.equal(r.gaveUp, 0, 'no unit gave up');
      }
    }
  }
});

test('a line the planner accepts can be driven: no sliver where a short step fails beside a bridge lane', () => {
  const { g, spans } = roadedMap(3);
  const tank = ACTION_UNITS.tank;
  // straight lines from points around each bridge end across the span: wherever line() says yes, small steps go through
  let lines = 0;
  for (const span of spans) for (const s0 of span.tiles) for (let d = 0; d < 6; d++) {
    const end = NB[s0 * 6 + d];
    if (end < 0 || span.tiles.includes(end) || !g.roads.usable(s0, end)) continue;
    // from around the bank hex at the bridge end onto the span
    const c = centerOf(end), far = centerOf(s0);
    for (let k = 0; k < 24; k++) {
      const p = { x: c.x + Math.sin(k * .262) * (.2 + (k % 3) * .15), z: c.z + Math.cos(k * .262) * (.2 + (k % 3) * .15) };
      if (!g.nav.canStand(p.x, p.z, tank) || !g.nav.line(p, far, tank)) continue;
      lines++;
      const len = distance(p, far), steps = Math.ceil(len / .07);
      let last = p;
      for (let i = 1; i <= steps; i++) {
        const q = { x: p.x + (far.x - p.x) * i / steps, z: p.z + (far.z - p.z) * i / steps };
        assert.ok(g.nav.canMove(last, q.x, q.z, tank), `step ${i}/${steps} of a line the planner accepted`);
        last = q;
      }
    }
  }
  assert.ok(lines > 0, 'some lines across the bridge were accepted');
});

test('units leave and cross a developed base and enter its court (seed 41: a buggy used to stay blocked on a facility corner)', () => {
  const g = S.makeGame(sim, 41);
  const site = S.developBase(sim, g);
  const ring = (r, a) => ({ x: site.x + Math.sin(a) * r, z: site.z + Math.cos(a) * r });
  const wheeled = ['armored_car', 'armored_car', 'scout_buggy', 'supply_truck', 'field_gun', 'armored_car'];
  for (const a of [0, 2.1, 4.2]) {
    const def = ACTION_UNITS.armored_car;
    const start = g.nav.nearest(ring(1.4, a), def, 1), goal = g.nav.nearest(ring(6, a + Math.PI), def, 1.5);
    if (!start || !goal) continue;
    g.units.clear(); S.reindex(sim, g);
    const units = S.placeBlock(sim, g, 0, wheeled, start, .5);
    g.command(0, { c: 'move', units: units.map((u) => u.id), point: goal });
    tick(g, Math.round(150 / sim.DT), () => units.every((u) => !u.goal));
    const r = 1.4 + Math.sqrt(units.length) * .32;
    const far = units.filter((u) => distance(u, goal) > r + 1.2);
    assert.deepEqual(far.map((u) => `${u.type}@${distance(u, goal).toFixed(1)}`), [], `out of the base at angle ${a}`);
  }
});

test('a fresh match lays no bridge; starting bases reach each other on foot; vehicles cut off by a wide river are refused with the reason', () => {
  for (const seed of [3, 11, 41]) {
    const g = S.makeGame(sim, seed), w = g.world;
    for (let t = 0; t < w.road.length; t++) if (w.road[t]) assert.ok(!w.river[t] || w.lake[t], `seed ${seed}: no bridge on hex ${t} at the start`);
    const starts = g.sites.filter((s) => s.start !== undefined);
    for (const a of starts) for (const b of starts) if (a !== b)
      assert.ok(g.nav.strategic(a.tile, b.tile, LIGHT_GROUND, false, true, 1e9), `seed ${seed}: ${a.name} reaches ${b.name} on foot`);
  }
  // seed 3: a wide river with no bridge between two banks
  const g = S.makeGame(sim, 3), tank = ACTION_UNITS.tank;
  let pair = null;
  for (let t = 0; t < g.world.road.length && !pair; t++) {
    if (!wide(g, t)) continue;
    for (let d = 0; d < 3 && !pair; d++) {
      const a = NB[t * 6 + d], b = NB[t * 6 + d + 3];
      if (a < 0 || b < 0 || g.world.river[a] || g.world.river[b]) continue;
      if (g.nav.needsCrossing(a, b, tank)) pair = [a, b];
    }
  }
  assert.ok(pair, 'a wide river separates two banks for vehicles but not for infantry');
  g.units.clear(); S.reindex(sim, g);
  const pa = bankPoint(g, pair[0], tank, .3), pb = bankPoint(g, pair[1], tank, .3);
  const t1 = S.place(sim, g, 0, 'tank', pa);
  g.civs[0].explored.fill(1);   // VISION (2026-11-20): the reason is given for discovered ground only
  const refused = g.command(0, { c: 'move', units: [t1.id], point: pb });
  assert.equal(refused.code, 'bridge', JSON.stringify(refused));
  assert.match(refused.error, /bridge/);
  const reach = reachQuery(g, [t1], pb).reply.reach;
  assert.equal(reach.ok, false);
  assert.equal(reach.reason, 'bridge');
  // infantry with it: they go, the tank stays behind with a note
  const r1 = S.place(sim, g, 0, 'rifle_squad', pa);
  const mixed = g.command(0, { c: 'move', units: [t1.id, r1.id], point: pb });
  assert.equal(mixed.placed, 1);
  assert.equal(mixed.crossing, 1);
  assert.match(mixed.note, /bridge/);
});

test('roadRouteBetween plans an engineer road with its bridge under the player rules; once built, the tank crosses', () => {
  const g = S.makeGame(sim, 3), civ = g.civs[0], tank = ACTION_UNITS.tank, w = g.world;
  // the nearest wide-river pair to player 0's base, both banks visible and neutral or own ground
  const home = g.sites[0];
  let pair = null, best = Infinity;
  for (let t = 0; t < w.road.length; t++) {
    if (!wide(g, t)) continue;
    for (let d = 0; d < 3; d++) {
      const a = NB[t * 6 + d], b = NB[t * 6 + d + 3];
      if (a < 0 || b < 0 || w.river[a] || w.river[b] || !g.nav.needsCrossing(a, b, tank)) continue;
      const dd = distance(centerOf(t), home);
      if (dd < best) { best = dd; pair = [a, b]; }
    }
  }
  assert.ok(pair);
  civ.visible.fill(1);
  for (const t of pair) for (const n of [t, ...NB.slice(t * 6, t * 6 + 6)]) if (n >= 0 && w.owner[n] >= 0 && w.owner[n] !== civ.id) w.owner[n] = -1;
  civ.res.materials = 5000;
  const preview = roadRouteBetween(g, civ, pair[0], pair[1], { preview: true });
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.ok(preview.bridges >= 1, 'the road carries its bridge');
  assert.equal(preview.cost.materials, preview.bridges * ROAD_BRIDGE_COST + (preview.edges - preview.bridges) * ROAD_EDGE_COST);
  assert.equal(civ.res.materials, 5000, 'a preview pays nothing');
  assert.equal(roadRouteBetween(g, civ, -1, pair[1]).code, 'points');
  const before = g.roadProjects.length;
  const r = roadRouteBetween(g, civ, pair[0], pair[1]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(civ.res.materials, 5000 - r.cost.materials);
  const project = g.roadProjects[before];
  assert.ok(project && !project.auto, 'an engineer road project, as a drawn stroke');
  assert.equal(roadEdgesCost(w, project.edges), r.cost.materials);
  assert.ok(project.edges.some((e) => isBridgeSegment(w, e.a, e.b)));
  // the engineers finish it (fast-forwarded here); the bridge then exists and the tank crosses
  for (let t = 0; t < w.road.length; t++) if (w.road[t]) assert.ok(!(w.river[t] && pair.includes(t)));
  project.left = 0; tick(g, 1);
  assert.ok(!g.roadProjects.includes(project), 'built');
  assert.equal(g.nav.needsCrossing(pair[0], pair[1], tank), false, 'the bridge opens the crossing to vehicles');
  const goal = bankPoint(g, pair[1], tank, .6);
  const res = crossAll(g, ['tank'], bankPoint(g, pair[0], tank, .6), goal);
  assert.deepEqual(res.missed, [], 'the tank crosses the new bridge');
});

test('a wreck blocks exactly its drawn hull, also across a hex edge; units in a wreck field never drive into one', () => {
  const g = S.makeGame(sim, 3), area = S.paintArea(sim, g, sim.H - 30, 8, 24, 34);
  // hull: a tank wreck's corner (outside the old 0.115 disc) blocks; a scout buggy's (smaller than the disc) does not
  const tw = { type: 'tank', x: 0, z: 0, yaw: 0 }, h = wreckHull('tank');
  assert.ok(Math.hypot(h.hw, h.hl) > .115 + .02, 'a tank hull reaches past the old disc');
  assert.ok(touchesWreck(tw, h.hw * .98, h.hl * .98, .001), 'its corner is solid');
  const bw = { type: 'scout_buggy', x: 0, z: 0, yaw: 0 }, hb = wreckHull('scout_buggy');
  assert.ok(!touchesWreck(bw, hb.hw + .03, 0, .001), 'beside a buggy wreck is free ground');
  // a wreck just across a hex edge blocks a unit centred in the next hex
  const t = area.at(10, 10), n = NB[t * 6], c = centerOf(t), cn = centerOf(n);
  const edge = { x: (c.x + cn.x) / 2, z: (c.z + cn.z) / 2 };
  const wreck = { type: 'tank', owner: 1, burn: 0, at: g.time, x: edge.x + (cn.x - c.x) * .08, z: edge.z + (cn.z - c.z) * .08, yaw: 0 };
  g.wrecks.set(n, [wreck]); g.bfVer++;
  const probe = { x: edge.x - (cn.x - c.x) * .12, z: edge.z - (cn.z - c.z) * .12 };
  assert.equal(tileAt(probe.x, probe.z), t);
  assert.equal(g.nav.canStand(probe.x, probe.z, ACTION_UNITS.tank), false, 'the wreck in the next hex blocks');
  g.wrecks.clear(); g.bfVer++;
  // a field of wrecks: a mixed group crosses, and no unit body ever enters a drawn hull (> 0.02)
  let k = 0;
  for (let r = 1; r < 23; r++) for (let col = 12; col <= 22; col += 2) {
    const p = area.point(r, col), q = ((k * 104729) % 1000) / 1000;
    const wr = { type: k % 3 ? 'tank' : 'armored_car', owner: 1, burn: 0, at: g.time, x: p.x + (q - .5) * .8, z: p.z + ((q * 7) % 1 - .5) * .8, yaw: q * 6.28 };
    const tt = tileAt(wr.x, wr.z); g.wrecks.set(tt, [...(g.wrecks.get(tt) || []), wr]); k++;
  }
  g.bfVer++; g.nav.invalidate();
  g.units.clear(); S.reindex(sim, g);
  const types = ['tank', 'tank', 'armored_car', 'armored_car', 'rifle_squad', 'rifle_squad', 'scout_buggy', 'mech_infantry'];
  const units = S.placeBlock(sim, g, 0, types, area.point(12, 4), .62), goal = area.point(12, 30);
  g.command(0, { c: 'move', units: units.map((u) => u.id), point: goal });
  let deepest = 0;
  for (let i = 0; i < Math.round(150 / sim.DT) && units.some((u) => u.goal); i++) {
    g.tick(); g.outbox.length = 0;
    for (const u of units) for (let d = -1; d < 6; d++) {
      const tt = d < 0 ? u.tile : NB[u.tile * 6 + d];
      for (const wr of (tt >= 0 && g.wrecks.get(tt)) || []) {
        const hh = wreckHull(wr.type), sn = Math.sin(wr.yaw), cs = Math.cos(wr.yaw), dx = u.x - wr.x, dz = u.z - wr.z;
        const out = Math.hypot(Math.max(0, Math.abs(dx * cs - dz * sn) - hh.hw), Math.max(0, Math.abs(dx * sn + dz * cs) - hh.hl));
        deepest = Math.max(deepest, ACTION_UNITS[u.type].radius - out);
      }
    }
  }
  assert.ok(units.every((u) => !u.goal && distance(u, goal) < 3.5), 'the group crossed the field');
  assert.ok(deepest <= .02, `deepest reach into a drawn wreck hull ${deepest.toFixed(3)}`);
});

test('late game: a route to ground cut off for the class fails in O(1), and a failed chase is not retried at once', () => {
  const g = S.makeGame(sim, 3), tank = ACTION_UNITS.tank;
  let pair = null;
  for (let t = 0; t < g.world.road.length && !pair; t++) {
    if (!wide(g, t)) continue;
    for (let d = 0; d < 3 && !pair; d++) {
      const a = NB[t * 6 + d], b = NB[t * 6 + d + 3];
      if (a >= 0 && b >= 0 && !g.world.river[a] && !g.world.river[b] && g.nav.needsCrossing(a, b, tank)) pair = [a, b];
    }
  }
  assert.ok(pair);
  const from = bankPoint(g, pair[0], tank, .3), far = centerOf(pair[1]);
  // a goal 12+ away on the far bank (no straight walk): no coarse search is made at all
  let to = null;
  for (let r = 1; r < 8 && !to; r++) for (const n of sim.disk(pair[1], r)) {
    const c = centerOf(n);
    if (distance(c, from) >= 12.5 && g.nav.canStand(c.x, c.z, tank) && g.nav.componentOf(n, tank) === g.nav.componentOf(pair[1], tank)) { to = c; break; }
  }
  assert.ok(to, 'a far-bank goal');
  let searches = 0;
  const strategic = g.nav.strategic.bind(g.nav);
  g.nav.strategic = (...a) => { searches++; return strategic(...a); };
  assert.equal(g.nav.route(from, to, tank), null);
  assert.equal(searches, 0, 'answered from the cached regions');
  g.nav.strategic = strategic;
  // chase: an enemy on the far bank of an unbridged wide river; the second attempt within the back-off makes no search
  g.units.clear(); S.reindex(sim, g);
  const u = S.place(sim, g, 0, 'tank', from), foe = S.place(sim, g, 1, 'rifle_squad', to);
  assert.ok(u && foe);
  void far;
  let routes = 0;
  const route = g.nav.route.bind(g.nav);
  g.nav.route = (...a) => { routes++; return route(...a); };
  sim.orders.chase(g, u, foe, ACTION_UNITS.tank.range);
  const first = routes;
  assert.ok(first > 0 && !u.goal, 'the first chase searched and found no firing spot');
  sim.orders.chase(g, u, foe, ACTION_UNITS.tank.range);
  assert.equal(routes, first, 'the failed chase backs off');
  g.nav.route = route;
});

test('road planning keeps off the hexes beside a field defense (barricades excepted) where a way round exists', () => {
  const g = S.makeGame(sim, 3);
  g.sandbox = true;
  const area = S.paintArea(sim, g, sim.H - 30, 8, 14, 20);
  const a = area.at(7, 2), b = area.at(7, 17);
  const plan = () => g.nav.strategic(a, b, { move: 'tracked', radius: .22 }, true, false, sim.N);
  const straight = plan();
  assert.ok(straight);
  const mid = straight[Math.floor(straight.length / 2)];
  const add = (type) => sim.bases.addFacility(g, g.civs[0], null, type, mid, { instant: true, point: { ...centerOf(mid), yaw: 0 } });
  const near = (route) => route.filter((t) => g.nav.nearDefense(t)).length;
  const bunker = add('bunker');
  const around = plan();
  assert.ok(around && near(around) === 0, `the road goes round the bunker (${near(around)} hexes beside it)`);
  assert.ok(around.length <= straight.length + 4, 'by a reasonable detour');
  g.removeBuilding(bunker);
  add('barricade');
  assert.deepEqual(plan(), straight, 'a barricade does not push the road away');
});
