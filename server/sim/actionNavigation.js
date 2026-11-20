import { H, N, T, W, isWater } from './constants.js';
import { NB, WRAP, center, dist, disk } from './hex.js';
import { MinHeap } from './world.js';
import { readFileSync } from 'node:fs';

// Building walls as drawn by the client (exported from CityRenderer.ExportJson):
// { type: [[x, z, halfWidth, halfDepth, yaw], …] } in the building frame. Types without an entry
// keep their circular radius.
let FOOTPRINTS = {};
try { FOOTPRINTS = JSON.parse(readFileSync(new URL('./actionFootprints.json', import.meta.url), 'utf8')); } catch { FOOTPRINTS = {}; }
export const footprintOf = (type) => FOOTPRINTS[type] || null;
// Movement collision uses only the solid walls of a building. Thin decoration (fence runs, posts, rails
// narrower than 0.12) is drawn but driven past, and walls give 0.03 of slack, so compounds keep lanes between their structures and
// vehicles produced in the inner court can always leave (2026-11-16, Rowen: units stuck in bases).
const SOLID = {};
for (const [type, rects] of Object.entries(FOOTPRINTS)) SOLID[type] = rects.filter((r) => Math.min(r[2], r[3]) >= .06).map(([x, z, hw, hd, yaw]) => [x, z, hw - .03, hd - .03, yaw]);
const solidFootprintOf = (type) => SOLID[type] || null;
const NO_OWNER = -99;   // obstacleAt's skipOwner when no side's structures are skipped (owners are >= -1)
/** The farthest solid wall corner of a building type from its origin (0 without recorded walls). */
export const footprintReach = (type) => SOLID[type]?.length ? footprintPre(SOLID[type]).reach : 0;

/** True if a disc of radius r at (x, z) touches any recorded wall of building b. */
export function insideFootprint(b, rects, x, z, r) {
  const dx = dxBetween(b.x, x), dz = z - b.z;
  // NAV_REDESIGN L0 (exact): the footprint's bounding reach (its farthest wall corner from the building's origin)
  // rejects a probe that cannot touch any wall before the rotation and per-wall tests; the walls' sines and cosines are
  // worked out once per footprint. Every probe that is tested gets the same arithmetic as before.
  const pre = footprintPre(rects), reach = pre.reach + r;
  if (dx * dx + dz * dz >= reach * reach) return false;
  const sn = Math.sin(b.yaw || 0), cs = Math.cos(b.yaw || 0);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  const S = pre.sin, C = pre.cos;
  // Pass 3 (perf): indexed loops here and in obstacleAt (no iterator objects; ~0.5 GB of short-lived garbage per
  // 5 late-game minutes came from these two hot loops)
  for (let i = 0; i < rects.length; i++) {
    const q = rects[i], rx = q[0], rz = q[1], hw = q[2], hd = q[3];
    const s = S[i], c = C[i], ox = lx - rx, oz = lz - rz;
    const u = Math.abs(ox * c - oz * s) - hw, v = Math.abs(ox * s + oz * c) - hd;
    if (Math.max(0, u) ** 2 + Math.max(0, v) ** 2 < r * r) return true;
  }
  return false;
}
// NAV_REDESIGN L0: per footprint (rect list): wall sines/cosines and the bounding reach, plus a hair of slack so
// rounding never rejects a probe the exact test would accept
const FOOT_PRE = new WeakMap();
function footprintPre(rects) {
  let p = FOOT_PRE.get(rects);
  if (!p) {
    const sin = new Float64Array(rects.length), cos = new Float64Array(rects.length);
    let reach = 0;
    for (let i = 0; i < rects.length; i++) {
      const q = rects[i];
      sin[i] = Math.sin(q[4]); cos[i] = Math.cos(q[4]);
      reach = Math.max(reach, Math.hypot(q[0], q[1]) + Math.hypot(q[2], q[3]));
    }
    FOOT_PRE.set(rects, p = { sin, cos, reach: reach + 1e-6 });
  }
  return p;
}

const SQRT3 = Math.sqrt(3), PERIOD = W * SQRT3;
// the hex's inscribed radius (centres sqrt 3 apart), less a margin for the Float32 tile centres
const HEX_INNER = SQRT3 / 2 - 1e-3;
// localRoute's eight steps (odd indices diagonal), in the order the grid search has always tried them
const LOCAL_DX = Int8Array.of(1, 1, 0, -1, -1, -1, 0, 1), LOCAL_DZ = Int8Array.of(0, 1, 1, 1, 0, -1, -1, -1);

/**
 * NAV_REDESIGN: a binary min-heap of integer ids on typed arrays, ordered by (priority, id) so equal priorities pop in
 * a fixed order whatever the push order (deterministic tie-breaking); grows by doubling, never allocates per push.
 */
export class IndexHeap {
  constructor(capacity = 1024) { this.ids = new Int32Array(capacity); this.pri = new Float64Array(capacity); this.size = 0; }
  clear() { this.size = 0; }
  push(id, p) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2), pri = new Float64Array(this.size * 2);
      ids.set(this.ids); pri.set(this.pri); this.ids = ids; this.pri = pri;
    }
    const ids = this.ids, pri = this.pri;
    let i = this.size++;
    while (i > 0) {
      const up = (i - 1) >> 1, q = pri[up];
      if (q < p || q === p && ids[up] < id) break;
      ids[i] = ids[up]; pri[i] = q; i = up;
    }
    ids[i] = id; pri[i] = p;
  }
  pop() {
    const ids = this.ids, pri = this.pri, top = ids[0], n = --this.size;
    if (n > 0) {
      const lid = ids[n], lp = pri[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && (pri[r] < pri[l] || pri[r] === pri[l] && ids[r] < ids[l]) ? r : l;
        if (pri[m] > lp || pri[m] === lp && ids[m] > lid) break;
        ids[i] = ids[m]; pri[i] = pri[m]; i = m;
      }
      ids[i] = lid; pri[i] = lp;
    }
    return top;
  }
}
const DIAG = Math.SQRT1_2;
const DIRECTIONS = [[1, 0], [DIAG, DIAG], [0, 1], [-DIAG, DIAG], [-1, 0], [-DIAG, -DIAG], [0, -1], [DIAG, -DIAG]];
const X = new Float32Array(N), Z = new Float32Array(N);
for (let i = 0; i < N; i++) [X[i], Z[i]] = center(i);

export const centerOf = (t) => ({ x: X[t], z: Z[t] });
/** Tile centre coordinates as flat arrays (centerOf without the allocation). */
export const TILE_X = X, TILE_Z = Z;
export const wrapX = (x) => WRAP ? ((x % PERIOD) + PERIOD) % PERIOD : x;
export const dxBetween = (a, b) => { const d = b - a; return WRAP ? d - Math.round(d / PERIOD) * PERIOD : d; };
export const distance = (a, b) => Math.hypot(dxBetween(a.x, b.x), b.z - a.z);

/** True if a disc of radius r at (x, z) touches building b as drawn: every recorded wall (thin ones too), else its box or radius. */
export function touchesBuilding(game, b, x, z, r) {
  const rects = footprintOf(b.type);
  if (rects) return insideFootprint(b, rects, x, z, r);
  const def = game.defs?.BUILDINGS?.[b.type];
  if (def?.width) {
    const dx = dxBetween(b.x, x), dz = z - b.z, sn = Math.sin(b.yaw || 0), cs = Math.cos(b.yaw || 0);
    const lx = Math.abs(dx * cs - dz * sn) - def.width * .5, lz = Math.abs(dx * sn + dz * cs) - def.depth * .5;
    return Math.max(0, lx) ** 2 + Math.max(0, lz) ** 2 < r * r;
  }
  return dxBetween(x, b.x) ** 2 + (b.z - z) ** 2 < ((b.radius || .3) + r) ** 2;
}

// An outpost's compound (its relay, plant, station or bunker, drawn at the site) as a disc for works lines.
export const OUTPOST_STRUCTURE_RADIUS = .78;

/**
 * The first structure a straight works line (a trench or a road) from a to b would cut through: a building's
 * walls (any owner, built, under construction or ruined) or an outpost's compound. `clearance` is the
 * half-width of the works. Returns { label, x, z } of the structure (label reads "the barracks"), or null when the line is clear.
 */
export function structureOnSegment(game, a, b, clearance = .14, { outposts = true } = {}) {
  const dx = dxBetween(a.x, b.x), dz = b.z - a.z;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / .08));
  for (let i = 0; i <= steps; i++) {
    const x = wrapX(a.x + dx * i / steps), z = a.z + dz * i / steps;
    const t = tileAt(x, z);
    if (t < 0) continue;
    for (const bd of game.obstaclesAtTile(t))
      if (touchesBuilding(game, bd, x, z, clearance)) return { label: 'the ' + (game.defs?.BUILDINGS?.[bd.type]?.name || 'building').toLowerCase(), x: bd.x, z: bd.z, building: bd.id };
    if (outposts) for (const s of game.sites)
      if (!s.slots && dxBetween(x, s.x) ** 2 + (s.z - z) ** 2 < (OUTPOST_STRUCTURE_RADIUS + clearance) ** 2) return { label: s.name ? 'the ' + s.name + ' outpost' : 'an outpost', x: s.x, z: s.z, site: s.id };
  }
  return null;
}

// Continuous positions along a completed trench. Shared by orders and cover evaluation;
// entering a trench is an actual movement destination, not a cosmetic tile-wide bonus.
export function trenchPosition(game, point, owner, reach = .55) {
  const tile = tileAt(point.x, point.z);
  if (tile < 0) return null;
  let best = null, nearest = reach;
  for (let i = -1; i < 6; i++) {
    const t = i < 0 ? tile : NB[tile * 6 + i], trench = game.fieldworks.get(t);
    if (!trench || trench.progress < 1 || trench.owner !== owner && !game.civs[owner]?.visible[t]) continue;
    const sn = Math.sin(trench.facing), cs = Math.cos(trench.facing);
    const dx = dxBetween(trench.x, point.x), dz = point.z - trench.z;
    const along = Math.max(-.60, Math.min(.60, -dx * cs + dz * sn));
    const p = { x: wrapX(trench.x - cs * along), z: trench.z + sn * along, facing: trench.facing };
    const d = distance(point, p);
    if (d < nearest) { nearest = d; best = p; }
  }
  return best;
}

export function tileAt(x, z) {
  const q = x / SQRT3 - z / 3, r = z * 2 / 3, s = -q - r;
  let a = Math.round(q), b = Math.round(r);
  const c = Math.round(s), dq = Math.abs(a - q), dr = Math.abs(b - r), ds = Math.abs(c - s);
  if (dq > dr && dq > ds) a = -b - c;
  else if (dr > ds) b = -a - c;
  if (b < 0 || b >= H) return -1;
  a += (b - (b & 1)) >> 1;
  if (WRAP) a = ((a % W) + W) % W;
  return a >= 0 && a < W ? b * W + a : -1;
}

function segmentDistanceSq(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, px = x - ax, pz = z - az;
  const t = Math.max(0, Math.min(1, (dx * px + dz * pz) / (dx * dx + dz * dz || 1)));
  return (px - dx * t) ** 2 + (pz - dz * t) ** 2;
}

export class SpatialIndex {
  constructor(size) { this.size = size; this.cells = new Map(); }
  key(x, z) { return Math.floor(x / this.size) * 2048 + Math.floor(z / this.size); }
  clear() { this.cells.clear(); }
  add(object) {
    const key = this.key(object.x, object.z);
    const cell = this.cells.get(key);
    if (cell) cell.push(object); else this.cells.set(key, [object]);
  }
  moved(object, oldX, oldZ) {
    const old = this.key(oldX, oldZ);
    if (old === this.key(object.x, object.z)) return;
    const cell = this.cells.get(old);
    if (cell) { const i = cell.indexOf(object); if (i >= 0) cell.splice(i, 1); }
    this.add(object);
  }
  query(x, z, radius, out) {
    out.length = 0;
    this.read(x, z, radius, out, -Infinity, Infinity);
    if (WRAP && x - radius < 0) this.read(x + PERIOD, z, radius, out, PERIOD - radius, Infinity);
    if (WRAP && x + radius >= PERIOD) this.read(x - PERIOD, z, radius, out, -Infinity, radius);
    return out;
  }
  read(x, z, r, out, minX, maxX) {
    const s = this.size, left = Math.floor((x - r) / s), right = Math.floor((x + r) / s);
    const top = Math.floor((z - r) / s), bottom = Math.floor((z + r) / s);
    // NAV_REDESIGN L0 (exact): indexed loop, r * r hoisted, same order and same test
    const rr = r * r, cells = this.cells;
    for (let ix = left; ix <= right; ix++) for (let iz = top; iz <= bottom; iz++) {
      const list = cells.get(ix * 2048 + iz);
      if (list) for (let i = 0; i < list.length; i++) {
        const item = list[i], ix2 = item.x, dx = ix2 - x, dz = item.z - z;
        if (ix2 >= minX && ix2 < maxX && dx * dx + dz * dz <= rr) out.push(item);
      }
    }
  }
}

// HILLS_MOUNTAINS (2026-11-19, user: "mountains shouldn't be passable, hills are but slower by infantry"): mountain and
// peak hexes are walls for every ground class (cost() refuses them before roads or slopes are considered); hills cost
// infantry 1.43 (= 1 / HILL_PACE.infantry, so routes weigh the time a climb takes and go round when that is faster).
const TERRAIN_COST = {
  infantry: [Infinity, Infinity, 1, 1, 1.13, 1.16, 1.12, 1.60, 1.43, Infinity, Infinity, Infinity, 1.14],
  wheeled: [Infinity, Infinity, 1.14, 1.07, 1.73, 1.39, 1.26, Infinity, 1.63, Infinity, Infinity, Infinity, 1.20],
  tracked: [Infinity, Infinity, 1, 1, 1.40, 1.15, 1.21, 1.89, 1.38, Infinity, Infinity, Infinity, 1.11],
};
// Steepest climbable gradient (rise over run, in world units) per movement class. Infantry can scramble
// up a ~26.6° hillside; tracks ~24°; wheels ~17°. Steeper ground is a wall: troops route around ridges and
// through passes instead of walking up mountain faces.
// 2026-11-19 (user: "Decrease the angle that infantry can climb"): infantry .65 (33.0°) -> .50 (26.6°), the angle
// down by a fifth and the gradient by 23%. A full 25% cut of the angle (24.8°, .46) would leave infantry level with
// tracks (.45); .50 keeps the order infantry > tracked > wheeled, so a squad still takes the slopes armour cannot.
// exported for the client definitions payload (actionDefinitions RULESET.mobility: hover-card terrain limits)
export const MAX_GRADIENT = { infantry: .50, tracked: .45, wheeled: .31 };
/** The same limits as slope angles in degrees (one decimal), per movement class: the unit definitions' maxSlope. */
export const MAX_SLOPE_DEG = Object.fromEntries(Object.entries(MAX_GRADIENT).map(([k, g]) => [k, Math.round(Math.atan(g) * 1800 / Math.PI) / 10]));
// Each class's cost on its best open ground (grass or plains): pace is measured relative to it, so a unit
// type's normal cruising speed is its definition speed and only rough ground or roads change it.
/** HILLS_MOUNTAINS: the pace on hills off a road, per movement class (actionOrders caps the terrain pace with it).
 *  Vehicles keep their terrain-cost pace (hills cost them 1.63 / 1.38: the 0.8 floor of TERRAIN_PACE). */
export const HILL_PACE = Object.freeze({ infantry: .7 });
/** HILLS_MOUNTAINS: mountains and peaks are impassable to every ground unit (aircraft fly over). */
export const isMountain = (terrain) => terrain === T.MOUNTAIN || terrain === T.PEAK;
export const OPEN_COST = Object.fromEntries(Object.entries(TERRAIN_COST).map(([k, v]) => [k, Math.min(v[T.GRASS], v[T.PLAINS])]));
const HEX_SPACING = Math.sqrt(3);
// The client's visual terrain height for a tile (WorldModel.TileHeightFromGeo, land only), so the
// gradient the server enforces is the one players see.
function visualHeight(e) {
  const relief = Math.max(e - .32, 0);
  return Math.max(e, 0) * 3.2 + relief * relief * 6 + .05;
}
// Interactive route searches scale gently with the world so cross-map orders on large maps still resolve.
const STRATEGIC_LIMIT = Math.max(4300, Math.round(N / 7));
// route(): coarse re-searches around a corridor tile the fine stage could not thread, and that tile's weight factor
const ROUTE_RETRIES = 2, AVOID_PENALTY = 8;
// road planning: weight factor for a new road edge onto a hex on or beside a field defense (barricades excepted)
const DEFENSE_ROAD_PENALTY = 4;
// route(): fine local-grid nodes one route() may expand over all its attempts (NAV_BRIDGES.md, late game: a goal in a
// pocket no corridor can thread cost three attempts x three local searches, up to ~7,500 nodes, and was asked again and
// again by group slots, chases and re-routes)
const ROUTE_LOCAL_BUDGET = 3200;
// route(): a failed request is remembered this many ticks (Pass 5), keyed on start and goal cells FAIL_CELL wide
const FAIL_MEMO_TICKS = 30, FAIL_CELL = .25;
// Pass 6 (localized invalidation): the cheapest coarse step weight (a road hex .66 x the .94 road-edge factor, so the
// A* estimate dist x .59 never overestimates), and how many hexes off its corridor a failed route's fine stage looked
const LOWER_STEP = .59, FAIL_MARGIN = 3;
// Pass 6: how long a corridor step the fine stage could not thread is taken as closed for the same class (route())
const BAD_STEP_TICKS = 50;
// Pass 6 (routing budget, mayRoute): work: standing tests (canStand calls; a settled coarse hex counts 3) all route()
// calls of a tick may use before deferrable requests wait; admit: queued units let through per tick whatever the budget;
// expire: ticks an admitted unit may take to ask again before it leaves the queue (its need has passed; the slowest
// deferrable caller, manTrenches, asks every 20 ticks).
export const ROUTE_BUDGET = Object.freeze({ work: 12000, admit: 6, expire: 25 });
// NAV_REDESIGN fallback(): how far (hexes) around an unreachable goal to look for the unit's own region, and how many
// candidate spots to route to before giving up
const NEAREST_RINGS = 24, NEAREST_TRIES = 3;
// line(): sample spacing on road-only hexes (bridge lanes)
const LANE_STRIDE = .06;
// A wreck blocks movement with the hull the client draws (NAV_BRIDGES.md, "rusted cars", 2026-11-18): the scale of
// WarzoneRenderer.WreckScale times the extents of WorldMeshes.Wreck (tracks and hull: half 0.44 x 0.50) or
// LightVehicleWreck (wheels and chassis: half 0.37 x 0.455), oriented by the wreck's yaw. It was a 0.115 disc for every
// type: a tank wreck's corners stuck out of it (units drove into the drawn hull) and a buggy's was a third wider than
// drawn. { hw, hl, r } half-width, half-length and circumradius.
const HULLS = new Map();
export function wreckHull(type) {
  let h = HULLS.get(type);
  if (!h) {
    const t = String(type || ''), tracked = t.includes('tank') || t === 'sp_artillery';
    const s = tracked ? .235 : t === 'mech_infantry' || t === 'exo_infantry' ? .22 : ['supply_truck', 'colonist', 'missile_battery', 'air_defense'].includes(t) ? .2
      : t === 'armored_car' ? .19 : t === 'field_gun' ? .16 : t === 'scout_buggy' ? .14 : .17;
    const hw = (tracked ? .44 : .37) * s, hl = (tracked ? .5 : .455) * s;
    HULLS.set(type, h = { hw, hl, r: Math.hypot(hw, hl) });
  }
  return h;
}
/** True if a disc of radius r at (x, z) touches wreck w's hull. */
export function touchesWreck(w, x, z, r) {
  const h = wreckHull(w.type), dx = dxBetween(w.x, x), dz = z - w.z;
  if (dx * dx + dz * dz >= (h.r + r) ** 2) return false;
  const sn = Math.sin(w.yaw || 0), cs = Math.cos(w.yaw || 0);
  const u = Math.abs(dx * cs - dz * sn) - h.hw, v = Math.abs(dx * sn + dz * cs) - h.hl;
  return Math.max(0, u) ** 2 + Math.max(0, v) ** 2 < r * r;
}

export const LIGHT_GROUND = { move: 'infantry', radius: .13 };
export const HEAVY_GROUND = { move: 'tracked', radius: .22 };

// Pass 3 (perf): everything cost(), edgeOk(), roadOnly(), nearLane() and gradientOf() read about the ground, so
// invalidate() can tell a building change (ground untouched) from a ground change. Road edges by class and condition
// band (cut, worn below 50, sound); the ring-road and dense-forest tables by identity and content.
const GROUND_ARRAYS = ['terr', 'lake', 'river', 'flowDir', 'flow', 'road', 'elev'];
const roadBand = (e) => (e.cond <= 0 ? 0 : e.cond < 50 ? 1 : 2);
function groundPrint(nav) {
  const w = nav.world, edges = [];
  for (const [k, e] of nav.roads.edges) edges.push(k, e.type, roadBand(e));
  const print = { ring: nav.game.ringRoads, dense: w.dense ? w.dense.slice() : null, edges };
  for (const name of GROUND_ARRAYS) print[name] = w[name].slice();
  return print;
}
function sameGround(nav, p) {
  const w = nav.world;
  if (p.ring !== nav.game.ringRoads || !!p.dense !== !!w.dense || nav.roads.edges.size * 3 !== p.edges.length) return false;
  if (p.dense) for (let i = 0; i < p.dense.length; i++) if (p.dense[i] !== w.dense[i]) return false;
  let i = 0;
  for (const [k, e] of nav.roads.edges) { if (p.edges[i] !== k || p.edges[i + 1] !== e.type || p.edges[i + 2] !== roadBand(e)) return false; i += 3; }
  for (const name of GROUND_ARRAYS) {
    const a = p[name], b = w[name];
    if (a.length !== b.length) return false;
    for (let j = 0; j < a.length; j++) if (a[j] !== b[j] && !(a[j] !== a[j] && b[j] !== b[j])) return false;
  }
  return true;
}

export class ActionNavigation {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.roads = game.roads;
    this.corridors = new Map();
    this.flows = new Map(); this.activeFlows = new Map();
    this.crossings = new Map(); this.crossingVersion = -1;
    this.terrainVersion = 0;
    this.groundVersion = 0;      // Pass 6: bumped only when the ground (terrain, roads, forest) changed (bridge crossings)
    this.work = 0;               // Pass 6: standing tests and coarse nodes so far (routing budget)
    this.budgetWork = null;      // Pass 6: overrides ROUTE_BUDGET.work (tests and benches only)
    this.localLeft = Infinity;   // fine local-grid nodes left to the route() in progress (ROUTE_LOCAL_BUDGET)
  }
  /**
   * Item 7 (perf): a group order routes every member through the same corridor, and route()'s fine
   * stage (portal/hub snapping, straight-line checks, local detours) is a pure function of its points
   * while the world is unchanged. Between beginBatch() and endBatch() those results are memoised, keyed
   * on the coarse tiles (snaps) or on the identity of the shared points (lines, detours); a unit whose
   * path joins the corridor reuses the work of the members before it. Results are identical to unbatched
   * routing (test/group-route-equivalence). `batchOff` disables it (test harness only).
   */
  beginBatch() { this.batch = this.batchOff ? null : { snap: new Map(), line: new Map(), local: new Map(), ids: new WeakMap(), next: 1, hits: 0 }; }
  endBatch() { const b = this.batch; this.batch = null; return b ? b.hits : 0; }
  snapAt(B, key, x, z, def, max) {
    const k = key + ':' + def.move + ':' + def.radius + (this.softWrecks ? ':s' : '');
    // Pass 6: every memo hit is charged the standing tests it saved, so the routing budget (which counts them) sees the
    // same work batched or not and batching stays invisible to the simulation
    const hit = B.snap.get(k);
    if (hit) { B.hits++; this.work += hit.w; return hit.p; }
    const w0 = this.work, p = this.nearest({ x, z }, def, max);
    if (p) B.ids.set(p, B.next++);
    B.snap.set(k, { p, w: this.work - w0 });
    return p;
  }
  lineB(a, b, def) {
    const B = this.batch, ia = B && B.ids.get(a), ib = ia && B.ids.get(b);
    if (!ib) return this.line(a, b, def);
    const k = ia + ':' + ib + ':' + def.move + ':' + def.radius + (this.softWrecks ? ':s' : '');
    const hit = B.line.get(k);
    if (hit) { B.hits++; this.work += hit.w; return hit.v; }
    const w0 = this.work, v = this.line(a, b, def);
    B.line.set(k, { v, w: this.work - w0 });
    return v;
  }
  localRouteB(a, b, def, budget, grid, step) {
    const B = this.batch, ia = B && B.ids.get(a), ib = ia && B.ids.get(b);
    if (!ib) return this.localRoute(a, b, def, budget, grid, step);
    const k = ia + ':' + ib + ':' + def.move + ':' + def.radius + ':' + budget + (this.softWrecks ? ':s' : '');
    // Pass 6: a remembered detour is charged the fine nodes it took (ROUTE_LOCAL_BUDGET), and reused only while that
    // many are left, so a batched route spends and finds exactly what an unbatched one would (a route's own retries
    // share a batch now)
    const hit = B.local.get(k);
    if (hit && hit.used <= this.localLeft) { B.hits++; this.localLeft -= hit.used; this.work += hit.w; return hit.r; }
    const left = this.localLeft, w0 = this.work;
    const r = this.localRoute(a, b, def, budget, grid, step);
    if (r || !this.localCut) B.local.set(k, { r, used: left - this.localLeft, w: this.work - w0 });   // a search cut short is not a verdict
    return r;
  }
  /**
   * The world changed: drop what the change can affect. `tiles` (Pass 6) names the hexes of buildings or wrecks that
   * were placed or removed (the ground itself unchanged); without it, or when the ground changed too, every route cache
   * is dropped as before.
   */
  invalidate(tiles = null, added = null) {
    if (this.batch) this.beginBatch();
    this.terrainVersion++;
    const stats = this.game.navStats ??= {};
    // Pass 6 (localized invalidation): late in a big match a building was placed or lost every 2-3 game seconds, and
    // each one wiped every corridor, flow field and remembered failure on the map, so chases, replans and AI orders kept
    // paying full searches again. A building or wreck changes only the obstacle lists of its hex and the six around it
    // (game.registerBuilding, wrecksNear); invalidateNear keeps every cached result that change cannot alter.
    if (tiles && this.groundPrint && sameGround(this, this.groundPrint)) {
      stats.localInvalidate = (stats.localInvalidate || 0) + 1;
      this.invalidateNear(tiles, added === 'added');
      return;
    }
    stats.fullInvalidate = (stats.fullInvalidate || 0) + 1;
    this.corridors.clear(); this.flows.clear(); this.activeFlows.clear(); this.crowdCache = null;
    this.failed?.clear(); this.badSteps?.clear();
    // Pass 3 (perf, late game): most invalidations are a building placed or removed, which leaves the ground itself as
    // it was. The ground-only caches (regions, centre costs, road-only and lane tiles, gradient) are kept when every
    // input they read is unchanged since the last invalidate. Those inputs only change one way between two invalidates
    // (forest cleared, a road worn down; repairs, new roads and reshaping all invalidate), so "the same at both ends"
    // means "unchanged throughout", and each kept entry is what a fresh evaluation would give. Rebuilding the regions
    // alone cost 80-140 ms per movement class after every building change late in a match.
    if (this.groundPrint && sameGround(this, this.groundPrint)) return;
    this.groundPrint = groundPrint(this);
    this.groundVersion++;
    this.gradient = null; this.roadOnlyCache = null; this.laneCache = null; this.centreCache = null; this.components = null;
  }

  /**
   * Pass 6: the caches a building or wreck placed or removed on `tiles` can affect, and only those, are dropped.
   * The obstacle lists that changed are those of each tile and its six neighbours (the marked hexes); crowding() and
   * canStand() read nothing else of buildings and wrecks. The ground is unchanged (invalidate() checked it), so the
   * ground-only caches and the bridge crossings stay as well.
   *  - A corridor (a coarse A* result) is kept when no marked hex lies on it and none could offer a cheaper way: a way
   *    through hex x costs at least LOWER_STEP x (dist(a, x) + dist(x, b)) (the search's own admissible estimate), so a
   *    marked hex whose bound is not below the corridor's cost cannot change the result. Failed searches are dropped.
   *  - A flow field is kept when no marked hex was reached by it or borders a hex it reached (Dijkstra: a hex the field
   *    never reached cannot change the weights or the order of the hexes it settled).
   *  - A remembered failure: region cut-offs depend on the ground only and are kept; an unstandable goal is dropped when
   *    a marked hex is the goal's or beside it; a failed corridor is dropped when a marked hex lies within the bound of
   *    its coarse cost plus FAIL_MARGIN hexes (the fine stage's local detours reach that far off the corridor).
   * crowding()'s cache checks its own signature on every read and is kept.
   */
  /** Pass 6: routing work left in this tick's budget (ROUTE_BUDGET.work); negative once overspent. */
  budgetLeft() { return (this.budgetWork ?? ROUTE_BUDGET.work) - this.budgetTick().spent; }

  /** Pass 6: charge routing work to this tick's budget. */
  spend(work) {
    const B = this.budgetTick();
    B.spent += work;
  }

  /** Pass 6: this tick's routing budget, reset (and the front of the wait queue admitted) on the first use in a tick. */
  budgetTick() {
    const g = this.game, tick = g.tickN ?? 0;
    let B = this.budget;
    if (!B || B.tick !== tick) {
      B = this.budget = { tick, spent: 0 };
      this.admitFront(tick);
    }
    return B;
  }

  /**
   * Pass 6 (routing budget): may unit u run a deferrable route now (a chase, a cover or trench move, a collision re-route,
   * a stuck-ladder replan, the way back after a chase)? Every route() is charged to the tick's budget (ROUTE_BUDGET.work,
   * in standing tests, so deterministic); orders and group routes always run but use it up too. Once it is spent a
   * deferrable request is refused and the unit queued, oldest first (ties by id); the ROUTE_BUDGET.admit units at the
   * front of the queue are let through on their next request whatever the budget, so no unit waits for ever. A refused
   * unit keeps what it was doing (its current path) and its caller asks again later. Queue state lives on the units
   * (u.routeWait: tick queued; u.routeFront: tick it reached the front), so it is saved with them.
   */
  mayRoute(u) {
    const B = this.budgetTick(), stats = this.game.navStats ??= {};
    if (B.spent < (this.budgetWork ?? ROUTE_BUDGET.work)) { if (u.routeWait != null) this.served(u, stats); return true; }
    if (u.routeWait != null && u.routeFront != null) { this.served(u, stats); stats.routeAdmitted = (stats.routeAdmitted || 0) + 1; return true; }
    if (u.routeWait == null) { this.enqueue(u); stats.routeDeferred = (stats.routeDeferred || 0) + 1; }
    stats.routeRefused = (stats.routeRefused || 0) + 1;
    return false;
  }

  /** The wait queue (unit ids by u.routeWait, then id), rebuilt from the units after a restore. */
  waitQueue() {
    if (!this.queue) {
      const q = [];
      for (const u of this.game.units.values()) if (u.routeWait != null) q.push(u);
      q.sort((a, b) => a.routeWait - b.routeWait || a.id - b.id);
      this.queue = q.map((u) => u.id);
    }
    return this.queue;
  }

  enqueue(u) {
    const q = this.waitQueue(), tick = this.game.tickN ?? 0;
    u.routeWait = tick; u.routeFront = null;
    let i = q.length;
    while (i > 0) {
      const v = this.game.units.get(q[i - 1]);
      if (v && v.routeWait === tick && v.id > u.id) i--; else break;
    }
    q.splice(i, 0, u.id);
  }

  served(u, stats) {
    const wait = (this.game.tickN ?? 0) - u.routeWait;
    stats.routeWaitTicks = (stats.routeWaitTicks || 0) + wait;
    if (wait > (stats.routeWaitMax || 0)) stats.routeWaitMax = wait;
    this.unqueue(u);
  }

  unqueue(u) {
    u.routeWait = null; u.routeFront = null;
    const q = this.waitQueue(), i = q.indexOf(u.id);
    if (i >= 0) q.splice(i, 1);
  }

  /**
   * Once a tick: admits the next ROUTE_BUDGET.admit queued units (oldest first), drops dead units and those no longer
   * waiting, and lets go of admitted units that have not asked again within ROUTE_BUDGET.expire ticks (their need has
   * passed: the target died, a new order came). Admitted units stay at the front until served or let go.
   */
  admitFront(tick) {
    const q = this.waitQueue(), units = this.game.units;
    let i = 0, fresh = 0;
    while (i < q.length && fresh < ROUTE_BUDGET.admit) {
      const u = units.get(q[i]);
      if (!u || u.hp <= 0 || u.routeWait == null) { q.splice(i, 1); if (u) u.routeFront = null; continue; }
      if (u.routeFront == null) { u.routeFront = tick; fresh++; }
      else if (tick - u.routeFront > ROUTE_BUDGET.expire) { q.splice(i, 1); u.routeWait = null; u.routeFront = null; continue; }
      i++;
    }
  }

  invalidateNear(tiles, added) {
    const mark = this.mark ??= new Uint8Array(N), list = [];
    for (const c of tiles) for (let d = -1; d < 6; d++) {
      const t = d < 0 ? c : c >= 0 ? NB[c * 6 + d] : -1;
      if (t >= 0 && !mark[t]) { mark[t] = 1; list.push(t); }
    }
    const stats = this.game.navStats;
    // a cheaper way through a freed hex: only when its lower bound is under the cached cost (removals only)
    const cheaper = (a, b, cost) => {
      if (!(cost < Infinity)) return true;
      for (let i = 0; i < list.length; i++) if (LOWER_STEP * (dist(a, list[i]) + dist(list[i], b)) < cost) return true;
      return false;
    };
    // the hexes within FAIL_MARGIN of a changed one (a failed corridor's fine stage looked that far to either side)
    let wide = null;
    const widen = () => {
      if (!wide) {
        wide = this.markWide ??= new Uint8Array(N); wide.list = [];
        for (const c of list) for (const t of disk(c, FAIL_MARGIN)) if (!wide[t]) { wide[t] = 1; wide.list.push(t); }
      }
      return wide;
    };
    const nearFail = (path) => {
      widen();
      for (let i = 0; i < path.length; i++) if (wide[path[i]]) return true;
      return false;
    };
    try {
      let kept = 0, dropped = 0;
      for (const [key, path] of this.corridors) {
        let hit = !path || !added && cheaper(path[0], path[path.length - 1], path.cost);
        for (let i = 0; !hit && i < path.length; i++) if (mark[path[i]]) hit = true;
        if (hit) { this.corridors.delete(key); dropped++; } else kept++;
      }
      stats.corridorKept = (stats.corridorKept || 0) + kept; stats.corridorDropped = (stats.corridorDropped || 0) + dropped;
      for (const [key, flow] of this.flows) {
        let hit = false;
        for (let i = 0; !hit && i < list.length; i++) {
          const t = list[i];
          if (t === flow.goal || flow.next[t] >= 0) { hit = true; break; }
          for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && (n === flow.goal || flow.next[n] >= 0)) { hit = true; break; } }
        }
        if (!hit) continue;
        this.flows.delete(key);
        for (const [move, f] of this.activeFlows) if (f === flow) this.activeFlows.delete(move);
      }
      if (this.failed?.size) {
        kept = 0; dropped = 0;
        for (const [key, f] of this.failed) {
          let hit;
          if (f.why === 'cut') hit = false;
          else if (f.why === 'goal') {
            // more structure never makes an unstandable goal standable
            hit = !added && (f.b < 0 || !!mark[f.b]);
            for (let d = 0; !added && !hit && d < 6; d++) { const n = NB[f.b * 6 + d]; if (n >= 0 && mark[n]) hit = true; }
          } else if (!f.path || f.a < 0 || f.b < 0) hit = true;
          else hit = nearFail(f.path) || !added && cheaper(f.a, f.b, f.cost + 2 * FAIL_MARGIN * LOWER_STEP);
          if (hit) { this.failed.delete(key); dropped++; } else kept++;
        }
        stats.memoKept = (stats.memoKept || 0) + kept; stats.memoDropped = (stats.memoDropped || 0) + dropped;
      }
      // an unthreadable corridor step stays so while structure is only added (more never opens a lane); a removal near it
      // (or near its approach) lets it be tried again
      if (!added && this.badSteps?.size) {
        widen();
        for (const steps of this.badSteps.values()) for (const k of steps.keys()) if (wide[Math.floor(k / N)] || wide[k % N]) steps.delete(k);
      }
    } finally {
      for (const t of list) mark[t] = 0;
      if (wide) { for (const t of wide.list) wide[t] = 0; wide.list = null; }
    }
  }


  /**
   * True when tile t is only passable for this movement class along a road (a bridge over water, a lake,
   * a wide river for vehicles, a road cut through a cliff). Moving into or out of such a tile is only valid
   * along one of its usable road edges, so coarse routes never "jump" off the side of a bridge.
   */
  roadOnly(t, def) {
    if (def.air || t < 0) return false;
    const cache = (this.roadOnlyCache ??= {})[def.move] ??= new Uint8Array(N);
    let v = cache[t];
    if (!v) {
      const w = this.world;
      let only = isWater(w.terr[t]) || !!w.lake[t] || !Number.isFinite(TERRAIN_COST[def.move]?.[w.terr[t]] ?? Infinity);
      if (!only && w.river[t] && w.flow[t] >= 94 && def.move !== 'infantry') only = true;
      if (!only && this.gradientOf(t) > (MAX_GRADIENT[def.move] ?? .5) && !(def.move === 'infantry' && w.river[t])) only = true;
      // dense forest (actionMap.markDenseForest): infantry enter it only along a road
      if (!only && def.move === 'infantry' && w.dense?.[t] && w.terr[t] === T.FOREST) only = true;
      v = cache[t] = only ? 2 : 1;
    }
    return v === 2;
  }

  /** A standing field defense (not a barricade) on hex t or beside it (buildingCells register each building on its six neighbours too). */
  nearDefense(t) {
    const defs = this.game.defs?.BUILDINGS;
    for (const b of this.game.obstaclesAtTile(t)) {
      const d = defs?.[b.type];
      if (d?.field && d.defense && b.type !== 'barricade' && b.state !== 'ruin') return true;
    }
    return false;
  }

  /**
   * How hex t needs line() sampled: 2 a bridge lane nearby (road-only ground), 1 structures or wrecks on it (only for
   * a strict route: a blocked unit's re-route, see actionOrders.strictRoute), 0 open.
   */
  tight(t, def) {
    if (t < 0) return 0;
    return this.nearLane(t, def) ? 2 : this.strict && (this.game.buildingCells?.get(t)?.size || !this.softWrecks && this.wrecksNear(t)) ? 1 : 0;
  }

  /**
   * Ground wrecks (with a position) whose hull a unit on hex t could touch: those on t and on its six neighbours.
   * obstacleAt read only the probe point's own hex, so a wreck just across a hex edge did not block a unit whose body
   * reached over it. Rebuilt when the battlefield changes (game.bfVer). Returns an array or undefined.
   */
  wrecksNear(t) {
    const g = this.game;
    if (!g.wrecks?.size) return undefined;
    if (this.wreckVer !== g.bfVer || !this.wreckCells) {
      const cells = this.wreckCells = new Map();
      this.wreckVer = g.bfVer;
      for (const [tile, list] of g.wrecks) for (const w of list) {
        if (w.x == null || w.air) continue;
        for (let d = -1; d < 6; d++) {
          const n = d < 0 ? tile : NB[tile * 6 + d];
          if (n < 0) continue;
          const c = cells.get(n); if (c) c.push(w); else cells.set(n, [w]);
        }
      }
    }
    return this.wreckCells.get(t);
  }

  /**
   * Tile t or one of its neighbours is a lane for this class: road-only ground carrying a road (a bridge, a causeway, a
   * cutting), where a unit's body can touch the lane's edge. Road-only ground without a road is a plain wall.
   */
  nearLane(t, def) {
    if (t < 0) return false;
    const all = this.laneCache ??= {}, cache = all[def.move] ??= new Uint8Array(N);
    let v = cache[t];
    if (!v) {
      const w = this.world;
      let near = !!w.road[t] && this.roadOnly(t, def);
      for (let d = 0; d < 6 && !near; d++) { const n = NB[t * 6 + d]; if (n >= 0 && w.road[n] && this.roadOnly(n, def)) near = true; }
      v = cache[t] = near ? 2 : 1;
    }
    return v === 2;
  }

  /** Whether a coarse step t -> n is physically possible (both tiles stand-able, bridges entered along their road). */
  edgeOk(t, n, def) {
    if (def.air) return true;
    if (!this.roadOnly(t, def) && !this.roadOnly(n, def)) return true;
    const e = this.roads.usable(t, n);
    return !!e && e.type !== 4;
  }

  /**
   * How much of a tile buildings and wrecks fill for a unit of this radius (0 = open, 1 = solid), from
   * seven probe points. Coarse routes avoid dense compounds and pass between buildings through the open
   * tiles instead of planning straight through a facility.
   */
  crowding(t, def) {
    if (def.air) return 0;
    const near = this.game.obstaclesAtTile(t), wrecks = this.wrecksNear(t);
    if (!near.length && !wrecks?.length) return 0;
    const key = t * 4 + (def.radius > .2 ? def.radius > .24 ? 2 : 1 : 0);
    // Pass 3 (perf, late game): the signature (each building's id and whether it is unfinished or a ruin, then the
    // wreck count) is compared code by code instead of joined into a string on every call. This is called for every
    // node of every coarse search and flow field (~45k times a tick late in a match). A hit is exactly the old test.
    const wl = wrecks?.length || 0;
    const cache = this.crowdCache ??= new Map();
    const hit = cache.get(key);
    if (hit && hit.wl === wl && hit.codes.length === near.length) {
      let same = true;
      for (let i = 0; i < near.length; i++) {
        const b = near[i];
        if (hit.codes[i] !== b.id * 2 + (b.done === false || b.state === 'ruin' ? 1 : 0)) { same = false; break; }
      }
      if (same) return hit.value;
    }
    const codes = near.map((b) => b.id * 2 + (b.done === false || b.state === 'ruin' ? 1 : 0));
    let blocked = 0;
    const cx = X[t], cz = Z[t], soft = this.softWrecks;
    // wrecks always weigh on the coarse cost (routes prefer the clear way), even inside a soft-wreck route
    this.softWrecks = false;
    try {
      for (let i = -1; i < 6; i++) {
        const x = i < 0 ? cx : cx + Math.cos(i * Math.PI / 3 + Math.PI / 6) * .5, z = i < 0 ? cz : cz + Math.sin(i * Math.PI / 3 + Math.PI / 6) * .5;
        if (this.obstacleAt(t, wrapX(x), z, def.radius)) blocked++;
      }
    } finally { this.softWrecks = soft; }
    const value = blocked / 7;
    if (cache.size > 20000) cache.clear();
    cache.set(key, { codes, wl, value });
    return value;
  }

  /**
   * cost() at a hex centre, cached per movement class until the next invalidate() (NAV_BRIDGES.md, late game: every
   * coarse search, flow field and region fill re-evaluated river, road, ring-road and gradient tests for each hex it
   * touched). Ground units only.
   */
  centreCost(t, def) {
    if (def.air) return this.cost(t, X[t], Z[t], def);
    if (t < 0) return Infinity;
    const all = this.centreCache ??= {};
    let c = all[def.move];
    if (!c) { c = all[def.move] = new Float64Array(N); c.fill(NaN); }
    let v = c[t];
    if (v !== v) v = c[t] = this.cost(t, X[t], Z[t], def);
    return v;
  }

  /** Coarse step weight from t to n (Infinity when impossible), shared by flow fields and A*. */
  stepCost(t, n, def) {
    if (!this.edgeOk(t, n, def)) return Infinity;
    let terrain = this.centreCost(n, def);
    if (!Number.isFinite(terrain)) return Infinity;
    const crowd = this.crowding(n, def);
    if (crowd >= 1) terrain *= 4; else if (crowd > 0) terrain *= 1 + crowd * 1.6;
    return terrain;
  }

  /**
   * Connected land regions per movement class (terrain and bridges only; buildings and units ignored).
   * Two tiles in different regions can never be joined by a route: the cheap "can these units reach here" test.
   */
  componentOf(t, def) {
    if (def.air) return 1;
    const all = this.components ??= {};
    let comp = all[def.move];
    if (!comp) {
      comp = all[def.move] = new Int32Array(N).fill(-1);
      const stack = [];
      let id = 0;
      for (let s = 0; s < N; s++) {
        if (comp[s] >= 0 || !Number.isFinite(this.centreCost(s, def))) continue;
        comp[s] = ++id; stack.push(s);
        while (stack.length) {
          const t = stack.pop();
          for (let d = 0; d < 6; d++) {
            const n = NB[t * 6 + d];
            if (n < 0 || comp[n] >= 0 || !this.edgeOk(t, n, def) || !Number.isFinite(this.centreCost(n, def))) continue;
            comp[n] = id; stack.push(n);
          }
        }
      }
    }
    return t >= 0 ? comp[t] : -1;
  }

  /**
   * Cheap reachability for order feedback. Returns 'ok', 'blocked' (the point itself is impassable for this
   * class: water, cliff, inside a structure) or 'unreachable' (passable, but cut off from the unit).
   */
  reachability(from, to, def) {
    const b = tileAt(to.x, to.z);
    if (b < 0) return 'blocked';
    if (def.air) return 'ok';
    if (!this.nearest(to, def, .45)) return 'blocked';
    const a = tileAt(from.x, from.z), ca = this.componentOf(a, def);
    if (ca < 0) return 'ok';   // a unit already standing somewhere odd (on a bridge edge): let the router decide
    const goal = this.nearest(to, def, .45), cb = this.componentOf(tileAt(goal.x, goal.z), def);
    return cb < 0 || cb === ca ? 'ok' : 'unreachable';
  }

  /**
   * NAV_BRIDGES (2026-11-18): a vehicle at tile a is cut off from tile b only by ground a road would open (a wide river
   * without a bridge, marsh or a slope without a road): the two lie in different regions for its class, but in one region
   * on foot. Matches start without bridges, so this is the usual reason a vehicle order fails. Two cached lookups.
   */
  needsCrossing(a, b, def) {
    if (def.air || def.move === 'infantry' || a < 0 || b < 0) return false;
    const ca = this.componentOf(a, def), cb = this.componentOf(b, def);
    if (ca < 0 || cb < 0 || ca === cb) return false;
    const fa = this.componentOf(a, LIGHT_GROUND), fb = this.componentOf(b, LIGHT_GROUND);
    return fa >= 0 && fa === fb;
  }

  /** Steepest visual gradient from each tile to a land neighbour (lazily rebuilt after terrain changes). */
  gradientOf(t) {
    if (!this.gradient) {
      const elev = this.world.elev, g = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const hi = visualHeight(elev[i]);
        let worst = 0;
        for (let d = 0; d < 6; d++) {
          const n = NB[i * 6 + d];
          if (n < 0 || isWater(this.world.terr[n])) continue;
          worst = Math.max(worst, Math.abs(visualHeight(elev[n]) - hi) / HEX_SPACING);
        }
        g[i] = worst;
      }
      this.gradient = g;
    }
    return this.gradient[t];
  }

  primeGroup(group, point) {
    this.activeFlows.clear();
    if (group.length < 4) return;   // groups share one flow field so they take the same corridor around obstacles
    const goal = tileAt(point.x, point.z);
    if (goal < 0) return;
    for (const def of group.map((u) => this.game.defs.UNITS[u.type])) {
      if (def.air || this.activeFlows.has(def.move)) continue;
      const key = `${def.move}:${goal}`;
      // review S: the field must reach the members' own tiles. With a fixed 4300-node bound a long order on
      // a large map (an AI final assault across a 208 world) fell back to per-unit bounded A*, which
      // exhausted its budget: ~40 ms per unit and a quarter of the group left behind with no route.
      // Expand at least 4300 nodes as before, then on until every member of this class is covered.
      const starts = group.filter((u) => this.game.defs.UNITS[u.type].move === def.move && !this.game.defs.UNITS[u.type].air)
        .map((u) => tileAt(u.x, u.z)).filter((t) => t >= 0 && t !== goal);
      let flow = this.flows.get(key);
      if (flow && !flow.complete && starts.some((t) => flow.next[t] < 0)) flow = null;
      if (!flow) {
        const next = new Int32Array(N).fill(-1), weights = new Float64Array(N).fill(Infinity), closed = new Uint8Array(N), heap = new MinHeap();
        weights[goal] = 0; heap.push(goal, 0); let expanded = 0;
        const pending = new Set(starts);
        while (heap.size && (expanded < 4300 || pending.size)) {
          const t = heap.pop(); if (closed[t]) continue;
          closed[t] = 1; expanded++; pending.delete(t);
          // Pass 3 (perf): stepCost(n, t) is the price of entering t, the same for all six neighbours, so it is worked
          // out once per settled tile (on the first neighbour that passes, exactly where stepCost first asked for it)
          // instead of six times; the neighbour's own tests (stand-able centre, edge) still run per neighbour.
          let enter = NaN;
          for (let d = 0; d < 6; d++) {
            const n = NB[t * 6 + d]; if (n < 0 || closed[n]) continue;
            // flows run goal-outward: the unit will step n -> t
            if (!Number.isFinite(this.centreCost(n, def)) || !this.edgeOk(n, t, def)) continue;
            if (enter !== enter) {
              enter = this.centreCost(t, def);
              if (Number.isFinite(enter)) { const crowd = this.crowding(t, def); if (crowd >= 1) enter *= 4; else if (crowd > 0) enter *= 1 + crowd * 1.6; }
            }
            const terrain = enter;
            if (!Number.isFinite(terrain)) continue;
            const cost = weights[t] + terrain * (this.roads.usable(t, n) ? .94 : 1);
            if (cost >= weights[n]) continue;
            weights[n] = cost; next[n] = t; heap.push(n, cost);
          }
        }
        flow = { goal, next, complete: !heap.size };
        if (this.flows.size >= 24) this.flows.delete(this.flows.keys().next().value);
        this.flows.set(key, flow);
      }
      this.activeFlows.set(def.move, flow);
    }
  }

  beginTraffic(units) {
    if (this.crossingVersion !== this.groundVersion) {
      this.crossings.clear(); this.crossingVersion = this.groundVersion;
      const span = new Set();
      for (const e of this.roads.edges.values()) if (e.cond > 0) for (const t of [e.a, e.b])
        if (this.world.river[t] || isWater(this.world.terr[t])) span.add(t);
      for (const start of span) {
        if (this.crossings.has(start)) continue;
        const group = { tiles: [start], direction: 0, axisX: 1, axisZ: 0 };
        this.crossings.set(start, group);
        for (let i = 0; i < group.tiles.length; i++) for (let d = 0; d < 6; d++) {
          const t = group.tiles[i], n = NB[t * 6 + d];
          if (n < 0 || !this.roads.usable(t, n)) continue;
          if (span.has(n) && !this.crossings.has(n)) { this.crossings.set(n, group); group.tiles.push(n); }
          else if (!span.has(n)) {
            const dx = dxBetween(X[t], X[n]), dz = Z[n] - Z[t], length = Math.hypot(dx, dz);
            group.axisX = dx / length; group.axisZ = dz / length;
          }
        }
      }
    }
    for (const crossing of this.crossings.values()) crossing.direction = 0;
    for (const u of units.values()) {
      if (!u.goal || this.game.defs.UNITS[u.type].air) continue;
      const crossing = this.crossings.get(u.tile);
      if (!crossing || crossing.direction || !this.roadAt(u.tile, u.x, u.z, this.game.defs.UNITS[u.type], true)) continue;
      const next = u.path[0] || u.goal;
      crossing.direction = dxBetween(u.x, next.x) * crossing.axisX + (next.z - u.z) * crossing.axisZ >= 0 ? 1 : -1;
    }
  }

  trafficAllows(u, x, z, def) {
    if (def.air) return true;
    const crossing = this.crossings.get(tileAt(x, z));
    if (!crossing || crossing === this.crossings.get(u.tile) || !this.roadAt(tileAt(x, z), x, z, def, true)) return true;
    const direction = dxBetween(u.x, x) * crossing.axisX + (z - u.z) * crossing.axisZ >= 0 ? 1 : -1;
    if (!crossing.direction) crossing.direction = direction;
    return crossing.direction === direction;
  }

  roadAt(t, x, z, def, bridgeOnly) {
    if (!bridgeOnly) {
      const ring = this.game.ringRoads?.get(t);
      if (ring) for (let i = 0; i < ring.length; i++) {
        const edge = ring[i];
        if (segmentDistanceSq(x, z, edge.a.x, edge.a.z, edge.b.x, edge.b.z) < .15 ** 2) return 2;
      }
    }
    if (!this.world.road[t]) return 0;
    const ax = x + dxBetween(x, X[t]), az = Z[t];
    let best = 0;
    // NAV_REDESIGN L0 (exact): the point's distance to each half-edge is measured first and the road edge looked up only
    // when the point lies within the widest lane any edge could have (.38 on a bridge, .31 otherwise); same verdicts
    const reach = bridgeOnly ? .38 * .38 : .31 * .31;
    for (let d = 0; d < 6; d++) {
      const next = NB[t * 6 + d];
      if (next < 0) continue;
      const bx = ax + dxBetween(X[t], X[next]) * .5, bz = (az + Z[next]) * .5;
      const sq = segmentDistanceSq(x, z, ax, az, bx, bz);
      if (sq > reach) continue;
      const edge = this.roads.usable(t, next);
      // Any road over a river or water is a bridge every vehicle may use (tracked included, 2026-11-16).
      if (!edge || edge.type === 4) continue;
      const r = bridgeOnly ? .38 : edge.type >= 2 ? .31 : .24;
      if (sq <= r * r) best = Math.max(best, edge.cond < 50 ? 1 : edge.type);
    }
    return best;
  }

  riverAt(t, x, z) {
    if (!this.world.river[t]) return false;
    const ax = x + dxBetween(x, X[t]), az = Z[t], downstream = this.world.flowDir[t];
    const width = Math.min(.37, .12 + .049 * Math.log2(Math.max(1, this.world.flow[t] / 42)));
    if ((x - ax) ** 2 + (z - az) ** 2 <= width ** 2) return true;
    for (let d = 0; d < 6; d++) {
      const n = NB[t * 6 + d];
      if (n < 0 || (d !== downstream && (!this.world.river[n] || this.world.flowDir[n] !== (d + 3) % 6))) continue;
      if (segmentDistanceSq(x, z, ax, az, ax + dxBetween(X[t], X[n]) * .5, (az + Z[n]) * .5) <= width ** 2) return true;
    }
    return false;
  }

  cost(t, x, z, def) {
    if (t < 0) return Infinity;
    if (def.air) return 1;
    const w = this.world, terrain = w.terr[t];
    if (isWater(terrain) || w.lake[t]) return this.roadAt(t, x, z, def, true) ? 1.15 : Infinity;
    if (isMountain(terrain)) return Infinity;   // HILLS_MOUNTAINS: a wall for every ground class, road or not
    let base = TERRAIN_COST[def.move][terrain];
    // NAV_BRIDGES (2026-11-18): a wide river (flow >= 94) is road-only for vehicles over the WHOLE hex, as the coarse
    // graph (roadOnly) has it. Before, only the drawn channel was impassable: a vehicle nudged onto the dry part of a
    // river hex beside a bridge stood on a tile the coarse search could neither leave nor enter, so its route failed
    // and it halted at the bridge end (or its order slot there was refused).
    const wide = !!w.river[t] && w.flow[t] >= 94 && def.move !== 'infantry';
    const river = wide || this.riverAt(t, x, z);
    const road = this.roadAt(t, x, z, def, river);
    // §30 (2026-11-18): ordinary infantry cannot pass dense forest (world.dense, actionMap.markDenseForest) off a
    // road; vehicles can, and heavy hulls clear it to grass (battlefield.js FOREST_CLEAR), which reopens it.
    if (!road && terrain === T.FOREST && def.move === 'infantry' && w.dense?.[t]) return Infinity;
    // Mountain faces: impassable beyond the class's climb limit unless a road cuts the slope;
    // below it, climbing costs grow with the gradient so routes prefer valleys and passes.
    // NAV_BRIDGES (2026-11-18): infantry wade any river hex, however steep its banks. A hex's gradient is its steepest
    // neighbour, so a river along a cliff foot read as a wall although its floor is the valley's lowest ground. The old
    // match-start crossings (bridges laid along such gorges) hid it; without them seed 3 on a 96 map was split in two
    // on foot. Vehicles still need the road (and the climb limit still holds on the banks themselves).
    const wade = def.move === 'infantry' && !!w.river[t];
    const gradient = wade ? Math.min(this.gradientOf(t), MAX_GRADIENT.infantry) : this.gradientOf(t), limit = MAX_GRADIENT[def.move] ?? .5;
    if (!road && gradient > limit) return Infinity;
    if (!road) base *= 1 + Math.max(0, gradient - limit * .45) * 1.6;
    if (river && !road) {
      if (wide) return Infinity;
      base *= def.move === 'infantry' ? 1.34 : 2.35;
    }
    return road ? Math.min(base, road === 1 ? .84 : .66) : base;
  }

  obstacleAt(t, x, z, radius, ignore = 0, ignoreTarget = 0, sight = false, skipOwner = NO_OWNER) {
    const near = this.game.obstaclesAtTile(t);
    for (let i = 0; i < near.length; i++) {
      const b = near[i];
      if (b.id === ignore || b.id === ignoreTarget || b.owner === skipOwner) continue;
      const def = this.game.defs.BUILDINGS[b.type];
      if (sight && def?.lowCover) continue;
      const rects = b.done !== false && b.state !== 'ruin' ? solidFootprintOf(b.type) : null;
      if (rects) {
        if (insideFootprint(b, rects, x, z, radius + .015)) return true;
      } else if (def?.width) {
        const dx = dxBetween(b.x, x), dz = z - b.z, sn = Math.sin(b.yaw || 0), cs = Math.cos(b.yaw || 0);
        const lx = Math.abs(dx * cs - dz * sn) - def.width * .5, lz = Math.abs(dx * sn + dz * cs) - def.depth * .5;
        if (Math.max(0,lx) ** 2 + Math.max(0,lz) ** 2 < (radius + .015) ** 2) return true;
      } else if (dxBetween(x, b.x) ** 2 + (b.z - z) ** 2 < (b.radius + radius) ** 2) return true;
    }
    // Pass 5: wrecks never close the way. A soft-wreck test (nav.softWrecks: a route no clear way exists for, a unit
    // pushing past a wreck) ignores them; sight lines (clearShot) and the ordinary planner still see them.
    if (this.softWrecks && !sight) return false;
    const wrecks = this.wrecksNear(t);
    if (wrecks) for (let i = 0; i < wrecks.length; i++) if (touchesWreck(wrecks[i], x, z, radius + .01)) return true;
    return false;
  }

  canStand(x, z, def, ignore = 0) {
    this.work++;   // Pass 6: the routing budget counts standing tests (ROUTE_BUDGET)
    x = wrapX(x);
    const t = tileAt(x, z);
    if (t < 0 || !Number.isFinite(this.cost(t, x, z, def))) return false;
    if (def.air) return true;
    if (this.obstacleAt(t, x, z, def.radius, ignore)) return false;
    // NAV_REDESIGN L0 (exact): a body wholly inside the hex's inscribed circle has all four rim probes on hex t, which
    // the loop below skips anyway; most standing tests stop here instead of locating four probe hexes
    const ox = dxBetween(X[t], x), oz = z - Z[t], inner = HEX_INNER - def.radius;
    if (inner > 0 && ox * ox + oz * oz < inner * inner) return true;
    for (let d = 0; d < 4; d++) {
      const xx = wrapX(x + (d < 2 ? (d === 0 ? 1 : -1) * def.radius : 0));
      const zz = z + (d >= 2 ? (d === 2 ? 1 : -1) * def.radius : 0);
      const n = tileAt(xx, zz);
      if (n !== t && (!Number.isFinite(this.cost(n, xx, zz, def)) || this.obstacleAt(n, xx, zz, 0, ignore))) return false;
    }
    return true;
  }

  line(a, b, def, stride = .28) {
    const dx = dxBetween(a.x, b.x), dz = b.z - a.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / stride));
    const fine = stride > LANE_STRIDE && !def.air ? Math.ceil(Math.hypot(dx, dz) / steps / LANE_STRIDE) : 1;
    const half = Math.hypot(dx, dz) / steps / 2;
    let last = a, lastNarrow = fine > 1 ? this.tight(tileAt(a.x, a.z), def) : 0;
    for (let i = 1; i <= steps; i++) {
      const next = { x: wrapX(a.x + dx * i / steps), z: a.z + dz * i / steps };
      // NAV_BRIDGES (2026-11-18): beside a road-only hex (a bridge, a causeway, a cutting) the passable lane is only
      // ~0.13 either side of the road for a tank. Samples .28 apart could straddle the lane's edge on a diagonal, so
      // a path was accepted that the unit's own small steps could not drive: it stopped at the bridge end, blocked,
      // and every replan returned the same path. The same held for a line grazing a facility's corner in a base
      // court, or a wreck. On such hexes (tight) the segment is checked at the lane stride; beside structures and
      // wrecks only when the body, grown by half the segment, touches one at the segment's middle (else no point of
      // the segment can).
      const narrow = fine > 1 ? this.tight(tileAt(next.x, next.z), def) : 0;
      let sub = false;
      if (narrow || lastNarrow) {
        const mx = wrapX(a.x + dx * (i - .5) / steps), mz = a.z + dz * (i - .5) / steps;
        // on a lane always (the standing test is not monotonic in the body's size, so no cheaper shortcut holds)
        sub = narrow === 2 || lastNarrow === 2 || this.obstacleAt(tileAt(mx, mz), mx, mz, def.radius + half + .02);
      }
      if (sub) {
        for (let k = 1; k < fine; k++) {
          const f = (i - 1 + k / fine) / steps, x = wrapX(a.x + dx * f), z = a.z + dz * f;
          if (!this.canMove(last, x, z, def)) return false;
          last = { x, z };
        }
      }
      if (!this.canMove(last, next.x, next.z, def)) return false;
      last = next; lastNarrow = narrow;
    }
    return true;
  }

  canMove(from, x, z, def) {
    if (this.canStand(x, z, def)) return true;
    if (def.air || !Number.isFinite(this.cost(tileAt(x, z), x, z, def))) return false;
    // Escaping is only for a unit that is already overlapping something; a free unit may never use it
    // to slide into a building's footprint (that trapped vehicles inside base compounds).
    if (this.canStand(from.x, from.z, def)) return false;
    // New wrecks may overlap nearby troops. Permit a continuous step out, never farther in.
    // NAV_REDESIGN L0 (exact): the same test over the same obstacles (the hexes of both points and their neighbours;
    // the verdict does not depend on the order or on a hex being seen twice) without building Sets, spread arrays and
    // copied wreck records on every call
    let escaping = false;
    const ta = tileAt(from.x, from.z), tb = tileAt(x, z);
    for (let s = 0; s < 2; s++) {
      const c = s ? tb : ta;
      if (s && tb === ta) break;
      for (let d = -1; d < 6; d++) {
        const t = d < 0 ? c : c >= 0 ? NB[c * 6 + d] : -1;
        if (d >= 0 && t < 0) continue;
        const v = this.escapeTile(t, from, x, z, def);
        if (v < 0) return false;
        if (v > 0) escaping = true;
      }
    }
    return escaping;
  }

  /** canMove's escape rule on one hex's obstacles: -1 the step goes into or deeper into one, 1 it leaves an overlap, 0 clear. */
  escapeTile(t, from, x, z, def) {
    let escaping = 0;
    const near = this.game.obstaclesAtTile(t);
    for (let i = 0; i < near.length + 1; i++) {
      let list, n;
      if (i < near.length) { list = null; n = 1; } else {
        if (this.softWrecks) break;
        list = this.game.wrecks.get(t); n = list ? list.length : 0;
      }
      for (let k = 0; k < n; k++) {
        let ox, oz, or;
        if (!list) { const o = near[i]; ox = o.x; oz = o.z; or = o.radius; } else {
          const w = list[k];
          if (w.air || w.x == null) continue;
          ox = w.x; oz = w.z; or = wreckHull(w.type).r;
        }
        const radius = (or + def.radius) ** 2;
        const before = dxBetween(from.x, ox) ** 2 + (from.z - oz) ** 2, after = dxBetween(x, ox) ** 2 + (z - oz) ** 2;
        if (after >= radius) continue;
        if (before >= radius || after <= before + 1e-7) return -1;
        escaping = 1;
      }
    }
    return escaping;
  }

  nearest(point, def, max = 1.25, valid = null) {
    const test = (x, z) => this.canStand(x, z, def) && (!valid || valid(x, z));
    if (test(point.x, point.z)) return { x: wrapX(point.x), z: point.z };
    for (let r = .22; r <= max + .01; r += .22) {
      for (const [dx, dz] of DIRECTIONS) {
        const x = wrapX(point.x + dx * r), z = point.z + dz * r;
        if (test(x, z)) return { x, z };
      }
    }
    return null;
  }

  // `limit` bounds the A* expansion. Unit orders keep the interactive default; one-off planners
  // (road layout between distant bases) pass a larger bound so long routes on big worlds resolve.
  // `avoid` (route's retry, 2026-11-18): coarse tiles whose fine corridor could not be threaded cost AVOID_PENALTY ×;
  // such a search neither reads nor fills the corridor cache and ignores flow fields.
  strategic(from, to, def, buildingRoads = false, skipFlow = false, limit = STRATEGIC_LIMIT, avoid = null) {
    if (from === to) return [to];
    const flow = !buildingRoads && !skipFlow && !avoid && this.activeFlows.get(def.move);
    if (flow && dist(to, flow.goal) <= 4 && flow.next[from] >= 0) {
      const route = [from]; let t = from;
      while (t !== flow.goal && dist(t, to) > 3 && route.length < 4300) { t = flow.next[t]; if (t < 0) break; route.push(t); }
      if (t >= 0) {
        const tail = this.strategic(t, to, def, false, true);
        if (tail) return route.concat(tail.slice(1));
      }
    }
    const key = `${def.move}:${from}:${to}`;
    if (!buildingRoads && !avoid && this.corridors.has(key)) return this.corridors.get(key);
    // NAV_BRIDGES (2026-11-18, late game): the search state lives in reused typed arrays stamped per search (it was
    // three Maps/Sets per call, the bulk of a long search's time); same expansion order, same result.
    const A = this.astar ??= { best: new Float64Array(N), parent: new Int32Array(N), seen: new Uint32Array(N), shut: new Uint32Array(N), gen: 0 };
    if (++A.gen === 0xffffffff) { A.seen.fill(0); A.shut.fill(0); A.gen = 1; }
    const gen = A.gen, best = A.best, parent = A.parent, seen = A.seen, shut = A.shut;
    const heap = new MinHeap();
    best[from] = 0; parent[from] = -1; seen[from] = gen;
    heap.push(from, 0);
    let result = null, closedCount = 0;
    while (heap.size && closedCount < limit) {
      const t = heap.pop();
      if (shut[t] === gen) continue;
      if (t === to) {
        result = [t];
        for (let p = parent[t]; p >= 0; p = parent[p]) result.push(p);
        result.reverse();
        result.cost = best[t];   // Pass 6: what invalidateNear weighs a changed hex against
        break;
      }
      shut[t] = gen; closedCount++;
      for (let d = 0; d < 6; d++) {
        const n = NB[t * 6 + d];
        if (n < 0 || shut[n] === gen) continue;
        let weight = buildingRoads ? this.centreCost(n, def) : this.stepCost(t, n, def);
        if (!Number.isFinite(weight) && buildingRoads && this.world.river[n] && !this.world.lake[n] && !isWater(this.world.terr[n])) weight = 2.6;
        if (!Number.isFinite(weight)) continue;
        if (buildingRoads) {
          // A new road joins the existing network instead of shadowing it: following a built edge is
          // cheap, a chord between two tiles that already carry roads (a triangle or a doubled lane at
          // a junction) is dear, and so is a fresh edge running right beside an existing road.
          const w = this.world;
          if (this.roads.usable(t, n)) weight *= .6;
          else if (w.road[t] && w.road[n]) weight *= 2.4;
          else if (!w.road[n] && !w.river[n]) for (let k = 0; k < 6; k++) {
            const m = NB[n * 6 + k];
            if (m >= 0 && m !== t && w.road[m] && !(t >= 0 && w.road[t] && this.roads.usable(t, m))) { weight *= 1.3; break; }
          }
          // 2026-11-18 (user rule "defenses offset from roads, except the sandbag barricade"): a new road keeps off
          // the hexes on or beside a field defense where a reasonable way round exists
          if (!this.roads.usable(t, n) && this.nearDefense(n)) weight *= DEFENSE_ROAD_PENALTY;
        } else if (this.roads.usable(t, n)) weight *= .94;
        if (avoid?.has(n)) weight *= AVOID_PENALTY;
        const cost = best[t] + weight;
        if (seen[n] === gen && cost >= best[n]) continue;
        best[n] = cost; seen[n] = gen;
        parent[n] = t;
        heap.push(n, cost + dist(n, to) * .59);
      }
    }
    this.work += closedCount * 3;   // Pass 6: a settled hex weighs about three standing tests (ROUTE_BUDGET)
    if (!buildingRoads && !avoid) {
      if (this.corridors.size >= 384) this.corridors.delete(this.corridors.keys().next().value);
      this.corridors.set(key, result);
    }
    return result;
  }

  /**
   * A continuous path from `from` to `to`. The coarse tile route guides a fine corridor through portals and hubs.
   * 2026-11-18 (stuck recovery): a corridor step that no local detour can thread (a heavy hull among a base's
   * facilities, perimeter and HQ) no longer fails the whole route. Its coarse tile is penalised and the coarse search
   * runs again, at most ROUTE_RETRIES times, so the unit leaves by another side of the compound. Before this, a tank
   * spawned on the far side of a facility could be refused every exit even though an open way out existed.
   */
  route(from, to, def) {
    if (def.air) return this.routeOnce(from, to, def);
    // Pass 6: the work is charged to the tick's routing budget (mayRoute), whoever asked. One route's coarse re-plans
    // and its soft-wreck retry share a batch (beginBatch), so the corridor steps they have in common (portals, hubs,
    // straight lines, detours) are worked out once.
    const w0 = this.work, own = !this.batch && !this.batchOff;
    if (own) this.beginBatch();
    try { return this.routeMemo(from, to, def); } finally { if (own) this.endBatch(); this.spend(this.work - w0); }
  }

  routeMemo(from, to, def) {
    // Pass 5 (failed-route memo): the same failed request (a group slot in a pocket no corridor can thread, a chase spot,
    // a ladder replan, an AI order repeated every plan) cost a full budgeted search each time: late in a match 400-850
    // failed routes a game minute, 60-85% of all route time. A failure is remembered for FAIL_MEMO_TICKS, keyed on the
    // start and goal to a FAIL_CELL grid, the class, the body and strictness; any invalidate() (terrain, buildings,
    // roads) forgets them all. Wrecks never fail a route (below), so the battlefield changing does not matter.
    const g = this.game, tick = g.tickN ?? 0;
    const key = def.move + ':' + def.radius + (this.strict ? 's' : '') + ':' + Math.floor(wrapX(from.x) / FAIL_CELL) + ',' + Math.floor(from.z / FAIL_CELL) + ':'
      + Math.floor(wrapX(to.x) / FAIL_CELL) + ',' + Math.floor(to.z / FAIL_CELL);
    const memo = this.failed ??= new Map(), seen = memo.get(key);
    if (seen !== undefined) {
      if (tick - seen.tick < FAIL_MEMO_TICKS && tick >= seen.tick) {
        this.lastFail = 'memo'; this.memoWhy = seen.why;
        const st = g.navStats ??= {}; st.routeMemo = (st.routeMemo || 0) + 1;
        return null;
      }
      memo.delete(key);
    }
    let path = this.routeOnce(from, to, def);
    // Pass 5 (vehicles never block pathing): wrecks never close the way. When no route clear of wreck hulls exists (two
    // wrecks across a single-lane bridge end, a cutting, a gap between facilities), the route is planned again with
    // wrecks soft: the unit drives through the wreck (unitMotion lets a unit push past a wreck in its way). The coarse
    // cost still weighs wrecks, so the clear way is preferred wherever there is one. A region cut-off or a coarse failure
    // does not depend on wrecks and is not retried.
    if (!path && !this.softWrecks && g.wrecks?.size && (this.lastFail === 'goal' || this.lastFail === 'fine') && this.failNearWreck(to)) {
      this.softWrecks = true;
      try { path = this.routeOnce(from, to, def); } finally { this.softWrecks = false; }
      // tagged: unitMotion lets a unit on this path push through a wreck at once (PUSH.wreckEarly); not saved, a restored
      // unit only waits the ordinary PUSH.wreck ticks
      if (path) { path.soft = true; const st = g.navStats ??= {}; st.routeSoft = (st.routeSoft || 0) + 1; }
    }
    if (!path) {
      if (memo.size >= 4096) memo.delete(memo.keys().next().value);
      // Pass 6: what the failure depended on, so a building placed or lost elsewhere keeps it (invalidateNear)
      memo.set(key, { tick, why: this.lastFail, a: tileAt(from.x, from.z), b: tileAt(to.x, to.z), path: this.lastCoarse, cost: this.coarseCost(this.lastCoarse, def) });
    }
    return path;
  }

  /** Pass 6: a coarse tile route's weight (its search's own, or summed for one taken from a flow field); Infinity for none. */
  coarseCost(coarse, def) {
    if (!coarse) return Infinity;
    if (coarse.cost !== undefined) return coarse.cost;
    let c = 0;
    for (let i = 1; i < coarse.length; i++) c += this.stepCost(coarse[i - 1], coarse[i], def);
    return c;
  }

  /** The failed route() could have been closed by a wreck: one stands near the goal or near a corridor step no detour threaded. */
  failNearWreck(to) {
    if (this.lastFail === 'goal') return !!this.wrecksNear(tileAt(to.x, to.z));
    for (const t of this.failTiles) if (this.wrecksNear(t)) return true;
    return false;
  }

  routeOnce(from, to, def) {
    this.localLeft = ROUTE_LOCAL_BUDGET;
    this.lastFail = null; this.failTiles = []; this.lastCoarse = null;
    try { return this.routeBudgeted(from, to, def); } finally { this.localLeft = Infinity; }
  }

  routeBudgeted(from, to, def) {
    if (!this.canStand(to.x, to.z, def)) { this.lastFail = 'goal'; return null; }
    if (def.air || (distance(from, to) < 12 && this.line(from, to, def))) return [to];
    const a = tileAt(from.x, from.z), b = tileAt(to.x, to.z);
    if (a < 0 || b < 0) { this.lastFail = 'cut'; return null; }
    // NAV_BRIDGES (2026-11-18, late game): ground cut off from the unit (across a wide river with no bridge yet, which
    // is now the normal state of a match) made every request exhaust a full bounded A* (STRATEGIC_LIMIT nodes) before
    // failing. With no start bridges, vehicles ordered across rivers turned that into a repath storm (each blocked
    // re-route, ladder replan and AI order paid it again). The cached regions answer it in O(1); a straight walk
    // closer than 12 was already tried above.
    const ca = this.componentOf(a, def), cb = ca >= 0 ? this.componentOf(b, def) : -1;
    if (ca >= 0 && cb >= 0 && ca !== cb) {
      const stats = this.game.navStats ??= {};
      stats.routeCutOff = (stats.routeCutOff || 0) + 1;
      this.lastFail = 'cut';
      return null;
    }
    // In one region a route exists: a long way around a river (to its ford or source) may need more than the
    // interactive bound, which used to fail it and leave the unit with no path. Bounded at half the map.
    let coarse = this.strategic(a, b, def, false, false, ca >= 0 && ca === cb ? Math.max(STRATEGIC_LIMIT, N >> 1) : STRATEGIC_LIMIT), avoid = null;
    if (!coarse) { this.lastFail = 'coarse'; return this.line(from, to, def) ? [to] : null; }
    this.lastCoarse = coarse;
    const stats = this.game.navStats ??= {};
    for (let attempt = 0; ; attempt++) {
      // Pass 6: a corridor step this class could not thread a moment ago (badSteps) fails at once, without the fine stage
      const known = this.knownBad(coarse, def);
      if (known >= 0) stats.routeBadStep = (stats.routeBadStep || 0) + 1;
      const r = known >= 0 ? { fail: coarse[known], from: coarse[known - 1] } : this.fineRoute(from, to, def, coarse);
      if (r.path) return r.path;
      if (r.fail >= 0) this.failTiles.push(r.fail, r.from ?? r.fail);
      if (attempt >= ROUTE_RETRIES || r.fail < 0 || r.fail === a || r.fail === b) return this.fineFailed(def);
      (avoid ??= new Set()).add(r.fail);
      stats.routeRetry = (stats.routeRetry || 0) + 1;
      coarse = this.strategic(a, b, def, false, true, STRATEGIC_LIMIT, avoid);
      if (!coarse) return this.fineFailed(def);
      // Pass 6: the corridor still runs through the hex no detour could thread although it now costs AVOID_PENALTY
      // times as much: there is no reasonable way round it, and the fine stage would fail there again (late in a match
      // most failed routes paid all three attempts at one blocked lane: barricades across a bridge deck)
      if (coarse.includes(r.fail)) { stats.routeRetryStop = (stats.routeRetryStop || 0) + 1; return this.fineFailed(def); }
    }
  }

  /** Pass 6: a fine-stage failure: its unthreadable corridor steps are remembered (badSteps) for BAD_STEP_TICKS. */
  fineFailed(def) {
    this.lastFail = 'fine';
    const tick = this.game.tickN ?? 0, all = this.badSteps ??= new Map(), v = this.stepVariant(def);
    let steps = all.get(v);
    if (!steps) all.set(v, steps = new Map());
    for (let i = 0; i < this.failTiles.length; i += 2) {
      const k = this.failTiles[i + 1] * N + this.failTiles[i];
      steps.delete(k); steps.set(k, tick);
    }
    while (steps.size > 512) steps.delete(steps.keys().next().value);
    return null;
  }

  stepVariant(def) { return def.move + ':' + def.radius + (this.strict ? 's' : '') + (this.softWrecks ? 'w' : ''); }

  /** Pass 6: the index in `coarse` of the first step this class failed to thread within BAD_STEP_TICKS, or -1. */
  knownBad(coarse, def) {
    const steps = this.badSteps?.get(this.stepVariant(def));
    if (!steps?.size) return -1;
    const tick = this.game.tickN ?? 0;
    for (let i = 1; i < coarse.length; i++) {
      // the failed step: hub or portal of coarse[i - 1] to those of coarse[i], or within coarse[i] itself
      let at = steps.get(coarse[i - 1] * N + coarse[i]);
      if (at === undefined) at = steps.get(coarse[i] * N + coarse[i]);
      if (at !== undefined && tick - at < BAD_STEP_TICKS && tick >= at) return i;
    }
    return -1;
  }

  /**
   * Pass 5 (stuck recovery, last resort): the coarse corridor from `from` to `to` as standable hex-centre waypoints,
   * without the fine stage. Only within one region for the class (a way exists); null otherwise. Used by the stuck
   * ladder when every route and alternate goal failed, so the unit keeps working its way along with local avoidance.
   */
  coarsePath(from, to, def) {
    if (def.air) return [to];
    const a = tileAt(from.x, from.z), b = tileAt(to.x, to.z);
    if (a < 0 || b < 0) return null;
    const ca = this.componentOf(a, def);
    if (ca < 0 || ca !== this.componentOf(b, def)) return null;
    const coarse = a === b ? [a] : this.strategic(a, b, def, false, true, Math.max(STRATEGIC_LIMIT, N >> 1));
    if (!coarse) return null;
    const points = [];
    for (let i = 1; i < coarse.length - 1; i++) { const p = this.nearest(centerOf(coarse[i]), def, .89); if (p) points.push(p); }
    const goal = this.nearest(to, def, .45);
    if (!goal) return points.length ? points : null;
    points.push(goal);
    return points;
  }

  /**
   * NAV_REDESIGN (no silent failure): route() and, when it fails, the best way that does exist, with the reason.
   * Returns { path, reason, goal }: reason 'ok' (the goal itself), 'goal' (the goal point is not standable for this
   * body: the nearest spot that is), 'fine' (the goal is in the unit's region but no fine corridor threads to it now:
   * the coarse corridor's hex-centre waypoints, ending at the goal, for local avoidance and the stuck ladder to work
   * along), 'cut' (the goal lies in another region for this class: the nearest reachable ground to it), or path null
   * with the router's own reason when even that does not exist (a unit standing nowhere a route can start). Bounded:
   * at most NEAREST_TRIES further routes and a ring scan of NEAREST_RINGS hexes of O(1) region lookups.
   */
  routeOrNearest(from, to, def) {
    const path = this.route(from, to, def);
    if (path) return { path, reason: 'ok', goal: to };
    return this.fallback(from, to, def);
  }

  /** routeOrNearest() after route(from, to, def) has just failed (reads its lastFail). */
  fallback(from, to, def) {
    const why = this.lastFail === 'memo' ? this.memoWhy : this.lastFail;
    const none = { path: null, reason: why || 'none', goal: null };
    if (def.air) return none;
    const a = tileAt(from.x, from.z), b = tileAt(to.x, to.z), stats = this.game.navStats ??= {};
    if (why === 'goal') {
      const g = this.nearest(to, def, 1.25);
      const p = g && this.route(from, g, def);
      if (p) { stats.fallbackGoal = (stats.fallbackGoal || 0) + 1; return { path: p, reason: 'goal', goal: g }; }
    }
    const ca = this.componentOf(a, def);
    if (ca < 0 || b < 0) return none;
    if (this.componentOf(b, def) === ca) {
      const cp = this.coarsePath(from, to, def);
      if (cp?.length) { stats.fallbackFine = (stats.fallbackFine || 0) + 1; return { path: cp, reason: 'fine', goal: cp[cp.length - 1] }; }
      return none;
    }
    // another region: the hexes of the unit's region nearest the goal, ring by ring (nearest centre first, ties by index)
    let tries = 0;
    for (let r = 1; r <= NEAREST_RINGS && tries < NEAREST_TRIES; r++) {
      const ring = disk(b, r).filter((t) => dist(b, t) === r && this.componentOf(t, def) === ca);
      if (!ring.length) continue;
      const d2 = (t) => dxBetween(X[t], to.x) ** 2 + (Z[t] - to.z) ** 2;
      ring.sort((p, q) => d2(p) - d2(q) || p - q);
      for (const t of ring) {
        if (tries >= NEAREST_TRIES) break;
        const g = this.nearest(centerOf(t), def, .89);
        if (!g) continue;
        tries++;
        const p = this.route(from, g, def) || this.coarsePath(from, g, def);
        if (p?.length) { stats.fallbackCut = (stats.fallbackCut || 0) + 1; return { path: p, reason: 'cut', goal: g }; }
      }
    }
    return none;
  }

  /** The fine stage of route(): { path } or { fail: the coarse tile of the step no detour could thread }. */
  fineRoute(from, to, def, coarse) {
    const points = [from], tiles = [coarse[0]];
    for (let i = 0; i < coarse.length - 1; i++) {
      const t = coarse[i], n = coarse[i + 1];
      // Portals stay continuous. A coarse cell only guides the corridor search.
      const x = X[t] + dxBetween(X[t], X[n]) * .5, z = (Z[t] + Z[n]) * .5;
      const B = this.batch;
      const portal = B ? this.snapAt(B, 'p' + t + ':' + n, x, z, def, .65) : this.nearest({ x, z }, def, .65);
      if (portal) { points.push(portal); tiles.push(n); }
      if (i + 2 < coarse.length) {
        const hub = B ? this.snapAt(B, 'h' + n, X[n], Z[n], def, .89) : this.nearest(centerOf(n), def, .89);
        if (hub) { points.push(hub); tiles.push(n); }
      }
    }
    points.push(to); tiles.push(coarse[coarse.length - 1]);
    const path = [];
    let i = 0;
    while (i < points.length - 1) {
      let j = Math.min(points.length - 1, i + 7);
      for (; j > i; j--) if (this.lineB(points[i], points[j], def)) break;
      if (j === i) {
        // A blocked corridor step (a facility, a wreck, a tight gap between buildings): search a fine
        // local grid, first cheaply, then wider and toward the next waypoint too, so one badly placed
        // portal inside a compound does not fail the whole order.
        let detour = this.localRouteB(points[i], points[i + 1], def, 220, 25, .24), skip = 1;
        if (!detour && i + 2 < points.length) { detour = this.localRouteB(points[i], points[i + 2], def, 900, 37, .2); skip = 2; }
        if (!detour) { detour = this.localRouteB(points[i], points[i + 1], def, 1400, 45, .18); skip = 1; }
        if (!detour) return { fail: tiles[i + 1] === tiles[0] && i + 2 < points.length ? tiles[i + 2] : tiles[i + 1], from: tiles[i] };
        path.push(...detour);
        i += skip;
      } else {
        path.push(points[j]);
        i = j;
      }
    }
    return { path };
  }

  /**
   * NAV_REDESIGN (fine stage, local detour): an 8-connected A* on a small grid of `grid` x `grid` cells `step` apart
   * centred on a, toward b. Rewritten on reused typed arrays (generation-stamped, no per-search Maps or point objects),
   * with a closed set (the heuristic, straight distance / step, is consistent with the 1 / 1.414 step costs, so a
   * settled cell is final and a stale heap entry is skipped instead of being expanded again and charged to the budget),
   * a deterministic heap (ties broken by cell index), and a per-search memo of each cell's standing test: a cell
   * whose centre a body cannot stand on is found once, not once from every neighbour trying to step into it (in a
   * cluttered court or a failing search most edge tests were repeats against the same blocked cells). An edge is
   * accepted exactly when line(p, q, def, .14) would accept it (same samples, lane sub-samples and escape rule), with
   * the end sample taken as the cell centre itself.
   */
  localRoute(a, b, def, budget = 220, grid = 25, step = .24) {
    const mid = grid >> 1, cells = grid * grid;
    const L = this.localState(cells);
    if (++L.gen === 0x7fffffff) { L.seen.fill(0); L.shut.fill(0); L.memoGen.fill(0); L.gen = 1; }
    const gen = L.gen, g = L.g, parent = L.parent, seen = L.seen, shut = L.shut, stand = L.stand, memoGen = L.memoGen;
    const x0 = a.x, z0 = a.z, start = mid * grid + mid, heap = L.heap;
    heap.clear();
    const px = (k) => wrapX(x0 + (k % grid - mid) * step), pz = (k) => z0 + (((k / grid) | 0) - mid) * step;
    const bx = b.x, bz = b.z;
    const hOf = (k) => Math.hypot(dxBetween(px(k), bx), bz - pz(k)) / step;
    g[start] = 0; parent[start] = -1; seen[start] = gen;
    // the start is the unit's own point (it may stand where it could not step: canMove's escape rule applies)
    memoGen[start] = gen; stand[start] = this.canStand(x0, z0, def) ? 1 : 2;
    heap.push(start, hOf(start));
    let visited = 0;
    const cap = Math.min(budget, this.localLeft ?? Infinity);
    this.localCut = false;
    try {
      while (heap.size) {
        const t = heap.pop();
        if (shut[t] === gen) continue;
        if (visited++ >= cap) break;
        shut[t] = gen;
        const tx = t % grid, tz = (t / grid) | 0, x = px(t), z = pz(t);
        const p = { x, z };
        if ((dxBetween(x, bx) ** 2 + (bz - z) ** 2) < .65 * .65 && this.line(p, b, def, .15)) {
          const result = [b];
          for (let n = t; n !== start; n = parent[n]) result.push({ x: px(n), z: pz(n) });
          return result.reverse();
        }
        const gt = g[t], tStands = stand[t] === 1;
        for (let d = 0; d < 8; d++) {
          const nx = tx + LOCAL_DX[d], nz = tz + LOCAL_DZ[d];
          if (nx < 0 || nx >= grid || nz < 0 || nz >= grid) continue;
          const n = nz * grid + nx;
          if (shut[n] === gen) continue;
          const w = gt + (d & 1 ? 1.414 : 1);
          if (seen[n] === gen && w >= g[n]) continue;
          if (!this.localEdge(L, gen, p, tStands, n, px(n), pz(n), def)) continue;
          g[n] = w; parent[n] = t; seen[n] = gen;
          heap.push(n, w + hOf(n));
        }
      }
      this.localCut = cap < budget && visited > cap && heap.size > 0;
      return null;
    } finally { if (this.localLeft !== undefined) this.localLeft -= Math.min(visited, cap); }
  }

  /** NAV_REDESIGN: reused search state for localRoute (grown on demand, never shrunk). */
  localState(cells) {
    let L = this.local;
    if (!L || L.size < cells) {
      const size = Math.max(cells, 2048);
      L = this.local = { size, gen: 0, g: new Float64Array(size), parent: new Int32Array(size), seen: new Int32Array(size), shut: new Int32Array(size),
        stand: new Uint8Array(size), memoGen: new Int32Array(size), heap: new IndexHeap() };
    }
    return L;
  }

  /**
   * NAV_REDESIGN: line(p, q, def, .14) for a local-grid edge into cell n at (qx, qz), with the end sample's standing test
   * memoised per cell for this search (1 stands, 2 does not). pStands: p is known to stand (so the escape rule, which
   * only frees a unit already overlapping something, cannot apply to a step out of it).
   */
  localEdge(L, gen, p, pStands, n, qx, qz, def) {
    const stand = L.stand, memoGen = L.memoGen;
    if (memoGen[n] !== gen) { memoGen[n] = gen; stand[n] = this.canStand(qx, qz, def) ? 1 : 2; }
    // a blocked end cell: the step fails unless the body may escape out of an overlap (canMove), never when p stands
    if (stand[n] === 2 && (pStands || def.air)) return false;
    const stride = .14, dx = dxBetween(p.x, qx), dz = qz - p.z, len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / stride));
    const fine = !def.air ? Math.ceil(len / steps / LANE_STRIDE) : 1;
    const half = len / steps / 2;
    let last = p, lastNarrow = fine > 1 ? this.tight(tileAt(p.x, p.z), def) : 0;
    for (let i = 1; i <= steps; i++) {
      const end = i === steps;
      const nx = end ? qx : wrapX(p.x + dx * i / steps), nz = end ? qz : p.z + dz * i / steps;
      const narrow = fine > 1 ? this.tight(tileAt(nx, nz), def) : 0;
      let sub = false;
      if (narrow || lastNarrow) {
        const mx = wrapX(p.x + dx * (i - .5) / steps), mz = p.z + dz * (i - .5) / steps;
        sub = narrow === 2 || lastNarrow === 2 || this.obstacleAt(tileAt(mx, mz), mx, mz, def.radius + half + .02);
      }
      if (sub) {
        for (let k = 1; k < fine; k++) {
          const f = (i - 1 + k / fine) / steps, x = wrapX(p.x + dx * f), z = p.z + dz * f;
          if (!this.canMove(last, x, z, def)) return false;
          last = { x, z };
        }
      }
      if (end && stand[n] === 1) return true;
      if (!this.canMove(last, nx, nz, def)) return false;
      last = { x: nx, z: nz }; lastNarrow = narrow;
    }
    return true;
  }

  /**
   * Line of sight from a to b over the terrain and structures. `tower` (2026-11-20, perimeter turrets): the shooter is
   * a raised gun tower: its eye stands tower.rise above its hex and it overlooks the structures of its own side
   * (tower.owner: its base's facilities and defenses do not block it).
   */
  clearShot(a, b, tower = null) {
    const dx = dxBetween(a.x, b.x), dz = b.z - a.z, steps = Math.ceil(Math.hypot(dx, dz) / .44);
    const start = tileAt(a.x, a.z), end = tileAt(b.x, b.z);
    const elev = this.world.elev, lo = (elev[start] ?? 0) + (tower?.rise || 0), hi = elev[end] ?? 0, own = tower ? tower.owner : NO_OWNER;
    for (let i = 1; i < steps; i++) {
      const f = i / steps, x = wrapX(a.x + dx * f), z = a.z + dz * f, t = tileAt(x, z);
      if (t < 0) continue;
      if (t !== start && t !== end && elev[t] > lo + (hi - lo) * f + .18 || this.obstacleAt(t, x, z, 0, a.id, b.id, true, own)) return false;
    }
    return true;
  }

  region(centerTile, radius) { return disk(centerTile, radius); }
}
