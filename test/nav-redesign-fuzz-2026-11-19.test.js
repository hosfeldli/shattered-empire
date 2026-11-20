// NAV_REDESIGN (2026-11-19, docs/gameplay-overhaul/NAV_REDESIGN.md): property / fuzz tests for the router. Random
// fields (mountains, lakes, a river with or without a bridge, field structures at random angles, wrecks) and random
// start / goal pairs for every ground class. Checked for every request:
//   valid      a returned path is a chain of straight legs nav.line() accepts, ending at the goal, and an independent
//              dense sampling (every 0.05) of each leg never stands on ground the class cannot stand on (water, a
//              mountain, a wall, a wreck hull, a slope): no route through walls or water
//   complete   whenever an independent fine-grid flood fill (8-connected, 0.1 apart, every cell and edge midpoint
//              standable) joins start and goal, route() finds a path
//   cost       a found path is no longer than OPT_RATIO x the flood fill's shortest grid distance (an upper bound of
//              the true shortest way, so this bounds the route against the optimum)
//   nearest    routeOrNearest() never fails silently: an unreachable goal gives a path to reachable ground (reason
//              'goal' / 'fine' / 'cut'), or null only with the router's reason
//   determinism  the same field and requests twice give identical paths
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 96;
globalThis.SE_WRAP = false;
const S = await import('./action-pathing-scenarios.mjs');
const sim = await S.loadSim();
const { ACTION_UNITS, tileAt, centerOf, distance, T, NB } = sim;

const CLASSES = ['rifle_squad', 'armored_car', 'tank'];
const OPT_RATIO = 1.6, BOX_MARGIN = 3, ROWS = 18, COLS = 22;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A random field: ROWS x COLS hexes of grass with mountains, a lake, a river (bridged or not), structures and wrecks. */
function field(seed) {
  const r = rng(seed * 7919 + 13);
  const g = S.makeGame(sim, 5);
  g.sandbox = true;
  const area = S.paintArea(sim, g, 20, 10, ROWS, COLS);
  g.units.clear(); S.reindex(sim, g);
  for (const b of [...g.buildings.values()]) if (area.tiles.includes(b.tile)) g.removeBuilding(b);
  const pick = (r0 = 1, r1 = ROWS - 2, c0 = 1, c1 = COLS - 2) => area.at(r0 + Math.floor(r() * (r1 - r0 + 1)), c0 + Math.floor(r() * (c1 - c0 + 1)));
  // mountain ridges: short random walks
  for (let k = 0; k < 3; k++) {
    let t = pick(), len = 3 + Math.floor(r() * 6);
    const ridge = [];
    for (let i = 0; i < len; i++) { ridge.push(t); const n = NB[t * 6 + Math.floor(r() * 6)]; if (n >= 0 && area.tiles.includes(n)) t = n; }
    S.paintTerrain(sim, g, ridge, T.MOUNTAIN, .6);
  }
  // a small lake
  if (r() < .6) { const c = pick(); S.paintLake(sim, g, [c, ...[0, 1, 2].map((d) => NB[c * 6 + d]).filter((n) => n >= 0 && area.tiles.includes(n))]); }
  // a river across the field at a random column, wide (vehicles need a bridge), bridged half of the time
  if (r() < .7) {
    const col = 6 + Math.floor(r() * (COLS - 12)), river = Array.from({ length: ROWS }, (_, i) => area.at(i, col));
    S.paintRiver(sim, g, river, 120);
    if (r() < .5) { const row = 3 + Math.floor(r() * (ROWS - 6)); S.paintRoad(sim, g, [area.at(row, col - 1), area.at(row, col), area.at(row, col + 1)], 2); }
  }
  // field structures at random angles
  const types = ['bunker', 'barricade', 'guard_post', 'turret', 'repair_point', 'fort'];
  for (let k = 0; k < 18; k++) {
    const t = pick(), c = centerOf(t);
    if (!Number.isFinite(g.nav.cost(t, c.x, c.z, ACTION_UNITS.rifle_squad)) && g.world.terr[t] !== T.GRASS) continue;
    const at = { x: c.x + (r() - .5) * .8, z: c.z + (r() - .5) * .8, yaw: r() * Math.PI * 2 };
    try { sim.bases.addFacility(g, g.civs[1], null, types[Math.floor(r() * types.length)], t, { instant: true, point: at }); } catch { /* refused spot */ }
  }
  // wrecks
  const wtypes = ['tank', 'armored_car', 'scout_buggy', 'supply_truck'];
  for (let k = 0; k < 14; k++) {
    const c = centerOf(pick());
    const w = { type: wtypes[Math.floor(r() * wtypes.length)], owner: 1, burn: 0, at: g.time, x: c.x + (r() - .5) * 1.2, z: c.z + (r() - .5) * 1.2, yaw: r() * 6.28 };
    const t = tileAt(w.x, w.z); g.wrecks.set(t, [...(g.wrecks.get(t) || []), w]);
  }
  g.bfVer++; g.nav.invalidate();
  return { g, area, r };
}

/** Independent oracle: an 8-connected flood over a 0.1 grid of the field; every cell and every edge midpoint standable. */
function flood(g, area, def, from, to) {
  // the field's box, cut to BOX_MARGIN around start and goal (a way leaving that box is not looked for: the oracle may
  // miss a long detour, never invent a way, so "oracle finds a way => route() must" stays a sound check)
  const xs = area.tiles.map((t) => centerOf(t).x), zs = area.tiles.map((t) => centerOf(t).z), step = .1;
  const x0 = Math.max(Math.min(...xs) - .8, Math.min(from.x, to.x) - BOX_MARGIN), z0 = Math.max(Math.min(...zs) - .8, Math.min(from.z, to.z) - BOX_MARGIN);
  const x1 = Math.min(Math.max(...xs) + .8, Math.max(from.x, to.x) + BOX_MARGIN), z1 = Math.min(Math.max(...zs) + .8, Math.max(from.z, to.z) + BOX_MARGIN);
  const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
  const stand = new Int8Array(nx * nz), best = new Float64Array(nx * nz).fill(Infinity);
  const ok = (i) => { if (!stand[i]) stand[i] = g.nav.canStand(x0 + (i % nx) * step, z0 + Math.floor(i / nx) * step, def) ? 1 : 2; return stand[i] === 1; };
  const cell = (p) => { const cx = Math.round((p.x - x0) / step), cz = Math.round((p.z - z0) / step); return cx < 0 || cz < 0 || cx >= nx || cz >= nz ? -1 : cz * nx + cx; };
  const s = cell(from);
  if (s < 0 || !ok(s)) return null;
  // Dijkstra over the grid (small: a few 10k cells)
  best[s] = 0;
  const heap = new sim.MinHeap(); heap.push(s, 0);
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DZ = [0, 1, 1, 1, 0, -1, -1, -1];
  while (heap.size) {
    const i = heap.pop(), cx = i % nx, cz = Math.floor(i / nx);
    for (let d = 0; d < 8; d++) {
      const ax = cx + DX[d], az = cz + DZ[d];
      if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
      const j = az * nx + ax, w = best[i] + (d & 1 ? Math.SQRT2 : 1) * step;
      if (w >= best[j] || !ok(j)) continue;
      if (!g.nav.canStand(x0 + (cx + DX[d] / 2) * step, z0 + (cz + DZ[d] / 2) * step, def)) continue;
      best[j] = w; heap.push(j, w);
    }
  }
  return { at: (p) => { const i = cell(p); return i >= 0 && i < best.length ? best[i] : Infinity; } };
}

const length = (from, path) => { let l = 0, p = from; for (const q of path) { l += distance(p, q); p = q; } return l; };

/** Dense check of a path: every leg accepted by line() and every point every 0.05 standable for the class. */
function checkPath(g, def, from, to, path, label) {
  assert.ok(path.length > 0, label + ': empty path');
  const end = path[path.length - 1];
  assert.ok(distance(end, to) < 1e-6, label + ': path ends at the goal');
  // a soft-wreck path (Pass 5: no clear way exists, the unit pushes past wreck hulls) is checked with wrecks soft
  const soft = !!path.soft, was = g.nav.softWrecks;
  g.nav.softWrecks = soft;
  try {
  let p = from;
  for (const q of path) {
    assert.ok(g.nav.line(p, q, def), `${label}: leg ${p.x.toFixed(2)},${p.z.toFixed(2)} -> ${q.x.toFixed(2)},${q.z.toFixed(2)} is a straight line the router accepts`);
    const n = Math.max(1, Math.ceil(distance(p, q) / .05));
    for (let k = 1; k <= n; k++) {
      const x = p.x + (q.x - p.x) * k / n, z = p.z + (q.z - p.z) * k / n, t = tileAt(x, z);
      assert.ok(t >= 0 && Number.isFinite(g.nav.cost(t, x, z, def)), `${label}: point ${x.toFixed(2)},${z.toFixed(2)} on impassable ground (water, mountain, slope)`);
      assert.ok(!g.nav.obstacleAt(t, x, z, Math.max(0, def.radius - .05)), `${label}: point ${x.toFixed(2)},${z.toFixed(2)} inside a wall or wreck`);
    }
    p = q;
  }
  } finally { g.nav.softWrecks = was; }
}

function requests(g, area, r, def, count) {
  const out = [];
  for (let k = 0; k < count * 6 && out.length < count; k++) {
    const p = () => { const c = centerOf(area.at(1 + Math.floor(r() * (ROWS - 2)), 1 + Math.floor(r() * (COLS - 2)))); return { x: c.x + (r() - .5) * 1.2, z: c.z + (r() - .5) * 1.2 }; };
    const a = g.nav.nearest(p(), def, .6), b = p();
    if (a) out.push([a, b]);
  }
  return out;
}

const SEEDS = [1, 2, 3, 4, 5];

test('fuzz: routes are valid, complete, near-optimal, and unreachable goals give the nearest reachable ground', () => {
  const totals = { soft: 0, found: 0, reachable: 0, unreachable: 0, fallback: 0, worst: 0 };
  for (const seed of SEEDS) {
    const { g, area, r } = field(seed);
    for (const type of CLASSES) {
      const def = ACTION_UNITS[type];
      for (const [from, to] of requests(g, area, r, def, 6)) {
        const label = `seed ${seed} ${type} ${from.x.toFixed(2)},${from.z.toFixed(2)} -> ${to.x.toFixed(2)},${to.z.toFixed(2)}`;
        const oracle = flood(g, area, def, from, to);
        const opt = oracle ? oracle.at(to) : Infinity;
        const standable = g.nav.canStand(to.x, to.z, def);
        const path = g.nav.route(from, to, def);
        if (path) {
          checkPath(g, def, from, to, path, label);
          totals.found++; if (path.soft) totals.soft++;
          if (Number.isFinite(opt) && opt > .5) {
            const ratio = length(from, path) / opt;
            totals.worst = Math.max(totals.worst, ratio);
            assert.ok(ratio <= OPT_RATIO, `${label}: path ${length(from, path).toFixed(2)} vs optimum ${opt.toFixed(2)} (x${ratio.toFixed(2)})`);
          }
        }
        if (standable && Number.isFinite(opt)) {
          totals.reachable++;
          assert.ok(path, `${label}: a way exists (flood fill, ${opt.toFixed(2)}) but route() failed (${g.nav.lastFail})`);
        }
        if (!path) {
          totals.unreachable++;
          g.nav.failed?.clear();
          const best = g.nav.routeOrNearest(from, to, def);
          assert.ok(['goal', 'fine', 'cut', 'coarse', 'none'].includes(best.reason), `${label}: a reason (${best.reason})`);
          if (best.path) {
            totals.fallback++;
            assert.ok(best.reason !== 'ok' && best.goal, label + ': the fallback names its goal');
            assert.ok(g.nav.canStand(best.goal.x, best.goal.z, def), label + ': the fallback goal is standable');
            const ca = g.nav.componentOf(tileAt(from.x, from.z), def);
            assert.equal(g.nav.componentOf(tileAt(best.goal.x, best.goal.z), def), ca, label + ': the fallback goal is in the unit\'s region');
          }
        }
      }
    }
  }
  console.log('fuzz totals', JSON.stringify(totals));
  assert.ok(totals.found > 40, 'enough routable requests were generated: ' + JSON.stringify(totals));
  assert.ok(totals.fallback > 0, 'some unreachable requests got the nearest reachable ground: ' + JSON.stringify(totals));
});

test('fuzz: the same field and requests twice give identical paths (determinism)', () => {
  const run = () => {
    const { g, area, r } = field(11);
    const out = [];
    for (const type of CLASSES) {
      const def = ACTION_UNITS[type];
      for (const [from, to] of requests(g, area, r, def, 5)) out.push(JSON.stringify(g.nav.routeOrNearest(from, to, def)));
    }
    return out;
  };
  assert.deepEqual(run(), run());
});

test('an order onto an unreachable island sends the unit to the nearest reachable shore instead of leaving it standing', () => {
  const g = S.makeGame(sim, 5);
  g.sandbox = true;
  const area = S.paintArea(sim, g, 20, 10, 14, 24);
  g.units.clear(); S.reindex(sim, g);
  for (const b of [...g.buildings.values()]) if (area.tiles.includes(b.tile)) g.removeBuilding(b);
  // a ring of lake around a small island at the far end
  const island = area.at(7, 18), ring = sim.disk(island, 2).filter((t) => t !== island && !NB.slice(island * 6, island * 6 + 6).includes(t));
  S.paintLake(sim, g, ring);
  const tank = S.place(sim, g, 0, 'tank', area.point(7, 3));
  assert.ok(tank);
  const def = ACTION_UNITS.tank, goal = centerOf(island);
  assert.equal(g.nav.route(tank, goal, def), null, 'the island cannot be reached');
  g.nav.failed?.clear();
  const best = g.nav.routeOrNearest(tank, goal, def);
  assert.equal(best.reason, 'cut');
  assert.ok(best.path?.length, 'a path to the nearest shore');
  assert.ok(distance(best.goal, goal) < distance(tank, goal) - 3, 'the fallback goal is much nearer the island');
  assert.ok(distance(best.goal, goal) < 3.2 * Math.sqrt(3), 'the fallback goal is on the shore facing the island (3 hexes out)');
  // a queued order to the island (started by stopUnit when the current one ends) drives to that shore
  tank.orders = [{ goal, mode: 'move' }];
  sim.orders.stopUnit(g, tank, true);
  assert.ok(tank.path.length, 'the unit has a path instead of standing still');
  assert.ok(distance(tank.path[tank.path.length - 1], best.goal) < 1e-6, 'it leads to the nearest reachable shore');
  for (let i = 0; i < 600 && tank.goal; i++) { g.tick(); g.outbox.length = 0; }
  assert.ok(distance(tank, best.goal) < 1, `the tank reached the shore (${distance(tank, best.goal).toFixed(2)} away)`);
});
