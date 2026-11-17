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

/** True if a disc of radius r at (x, z) touches any recorded wall of building b. */
export function insideFootprint(b, rects, x, z, r) {
  const dx = dxBetween(b.x, x), dz = z - b.z, sn = Math.sin(b.yaw || 0), cs = Math.cos(b.yaw || 0);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  for (const [rx, rz, hw, hd, yaw] of rects) {
    const s = Math.sin(yaw), c = Math.cos(yaw), ox = lx - rx, oz = lz - rz;
    const u = Math.abs(ox * c - oz * s) - hw, v = Math.abs(ox * s + oz * c) - hd;
    if (Math.max(0, u) ** 2 + Math.max(0, v) ** 2 < r * r) return true;
  }
  return false;
}

const SQRT3 = Math.sqrt(3), PERIOD = W * SQRT3;
const DIAG = Math.SQRT1_2;
const DIRECTIONS = [[1, 0], [DIAG, DIAG], [0, 1], [-DIAG, DIAG], [-1, 0], [-DIAG, -DIAG], [0, -1], [DIAG, -DIAG]];
const X = new Float32Array(N), Z = new Float32Array(N);
for (let i = 0; i < N; i++) [X[i], Z[i]] = center(i);

export const centerOf = (t) => ({ x: X[t], z: Z[t] });
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
    for (let ix = left; ix <= right; ix++) for (let iz = top; iz <= bottom; iz++) {
      const list = this.cells.get(ix * 2048 + iz);
      if (list) for (const item of list) {
        if (item.x >= minX && item.x < maxX && (item.x - x) ** 2 + (item.z - z) ** 2 <= r * r) out.push(item);
      }
    }
  }
}

const TERRAIN_COST = {
  infantry: [Infinity, Infinity, 1, 1, 1.13, 1.16, 1.12, 1.60, 1.23, 1.93, Infinity, Infinity, 1.14],
  wheeled: [Infinity, Infinity, 1.14, 1.07, 1.73, 1.39, 1.26, Infinity, 1.63, Infinity, Infinity, Infinity, 1.20],
  tracked: [Infinity, Infinity, 1, 1, 1.40, 1.15, 1.21, 1.89, 1.38, Infinity, Infinity, Infinity, 1.11],
};
// Steepest climbable gradient (rise over run, in world units) per movement class. Infantry can scramble
// up a ~33° hillside; tracks ~24°; wheels ~17°. Steeper ground is a wall: troops route around ridges and
// through passes instead of walking up mountain faces.
const MAX_GRADIENT = { infantry: .65, tracked: .45, wheeled: .31 };
// Each class's cost on its best open ground (grass or plains): pace is measured relative to it, so a unit
// type's normal cruising speed is its definition speed and only rough ground or roads change it.
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
export const LIGHT_GROUND = { move: 'infantry', radius: .13 };
export const HEAVY_GROUND = { move: 'tracked', radius: .22 };

export class ActionNavigation {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.roads = game.roads;
    this.corridors = new Map();
    this.flows = new Map(); this.activeFlows = new Map();
    this.crossings = new Map(); this.crossingVersion = -1;
    this.terrainVersion = 0;
  }
  invalidate() {
    this.corridors.clear(); this.flows.clear(); this.activeFlows.clear(); this.terrainVersion++; this.gradient = null;
    this.roadOnlyCache = null; this.crowdCache = null; this.components = null;
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
      if (!only && this.gradientOf(t) > (MAX_GRADIENT[def.move] ?? .5)) only = true;
      v = cache[t] = only ? 2 : 1;
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
    const near = this.game.obstaclesAtTile(t), wrecks = this.game.wrecks.get(t);
    if (!near.length && !wrecks?.length) return 0;
    const key = t * 4 + (def.radius > .2 ? def.radius > .24 ? 2 : 1 : 0);
    const sig = near.map((b) => b.id * 2 + (b.done === false || b.state === 'ruin' ? 1 : 0)).join(',') + '|' + (wrecks?.length || 0);
    const cache = this.crowdCache ??= new Map();
    const hit = cache.get(key);
    if (hit && hit.sig === sig) return hit.value;
    let blocked = 0;
    const cx = X[t], cz = Z[t];
    for (let i = -1; i < 6; i++) {
      const x = i < 0 ? cx : cx + Math.cos(i * Math.PI / 3 + Math.PI / 6) * .5, z = i < 0 ? cz : cz + Math.sin(i * Math.PI / 3 + Math.PI / 6) * .5;
      if (this.obstacleAt(t, wrapX(x), z, def.radius)) blocked++;
    }
    const value = blocked / 7;
    if (cache.size > 20000) cache.clear();
    cache.set(key, { sig, value });
    return value;
  }

  /** Coarse step weight from t to n (Infinity when impossible), shared by flow fields and A*. */
  stepCost(t, n, def) {
    if (!this.edgeOk(t, n, def)) return Infinity;
    let terrain = this.cost(n, X[n], Z[n], def);
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
        if (comp[s] >= 0 || !Number.isFinite(this.cost(s, X[s], Z[s], def))) continue;
        comp[s] = ++id; stack.push(s);
        while (stack.length) {
          const t = stack.pop();
          for (let d = 0; d < 6; d++) {
            const n = NB[t * 6 + d];
            if (n < 0 || comp[n] >= 0 || !this.edgeOk(t, n, def) || !Number.isFinite(this.cost(n, X[n], Z[n], def))) continue;
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
          for (let d = 0; d < 6; d++) {
            const n = NB[t * 6 + d]; if (n < 0 || closed[n]) continue;
            // flows run goal-outward: the unit will step n -> t
            const terrain = Number.isFinite(this.cost(n, X[n], Z[n], def)) ? this.stepCost(n, t, def) : Infinity;
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
    if (this.crossingVersion !== this.terrainVersion) {
      this.crossings.clear(); this.crossingVersion = this.terrainVersion;
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
    if (!bridgeOnly) for (const edge of this.game.ringRoads?.get(t) || [])
      if (segmentDistanceSq(x, z, edge.a.x, edge.a.z, edge.b.x, edge.b.z) < .15 ** 2) return 2;
    if (!this.world.road[t]) return 0;
    const ax = x + dxBetween(x, X[t]), az = Z[t];
    let best = 0;
    for (let d = 0; d < 6; d++) {
      const next = NB[t * 6 + d];
      if (next < 0) continue;
      const edge = this.roads.usable(t, next);
      // Any road over a river or water is a bridge every vehicle may use (tracked included, 2026-11-16).
      if (!edge || edge.type === 4) continue;
      const bx = ax + dxBetween(X[t], X[next]) * .5, bz = (az + Z[next]) * .5;
      const r = bridgeOnly ? .38 : edge.type >= 2 ? .31 : .24;
      if (segmentDistanceSq(x, z, ax, az, bx, bz) <= r * r) best = Math.max(best, edge.cond < 50 ? 1 : edge.type);
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
    let base = TERRAIN_COST[def.move][terrain];
    const river = this.riverAt(t, x, z);
    const road = this.roadAt(t, x, z, def, river);
    // Mountain faces: impassable beyond the class's climb limit unless a road cuts the slope;
    // below it, climbing costs grow with the gradient so routes prefer valleys and passes.
    const gradient = this.gradientOf(t), limit = MAX_GRADIENT[def.move] ?? .5;
    if (!road && gradient > limit) return Infinity;
    if (!road) base *= 1 + Math.max(0, gradient - limit * .45) * 1.6;
    if (river && !road) {
      if (w.flow[t] >= 94 && def.move !== 'infantry') return Infinity;
      base *= def.move === 'infantry' ? 1.34 : 2.35;
    }
    return road ? Math.min(base, road === 1 ? .84 : .66) : base;
  }

  obstacleAt(t, x, z, radius, ignore = 0, ignoreTarget = 0, sight = false) {
    for (const b of this.game.obstaclesAtTile(t)) {
      if (b.id === ignore || b.id === ignoreTarget) continue;
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
    const wrecks = this.game.wrecks.get(t);
    if (wrecks) for (const w of wrecks) if (w.x != null && !w.air && dxBetween(x, w.x) ** 2 + (w.z - z) ** 2 < (.115 + radius) ** 2) return true;
    return false;
  }

  canStand(x, z, def, ignore = 0) {
    x = wrapX(x);
    const t = tileAt(x, z);
    if (t < 0 || !Number.isFinite(this.cost(t, x, z, def))) return false;
    if (def.air) return true;
    if (this.obstacleAt(t, x, z, def.radius, ignore)) return false;
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
    let last = a;
    for (let i = 1; i <= steps; i++) {
      const next = { x: wrapX(a.x + dx * i / steps), z: a.z + dz * i / steps };
      if (!this.canMove(last, next.x, next.z, def)) return false;
      last = next;
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
    let escaping = false;
    const tiles = new Set([tileAt(from.x, from.z), tileAt(x, z)]);
    for (const t of [...tiles]) if (t >= 0) for (let d = 0; d < 6; d++) if (NB[t * 6 + d] >= 0) tiles.add(NB[t * 6 + d]);
    for (const t of tiles) {
      const obstacles = [...this.game.obstaclesAtTile(t), ...(this.game.wrecks.get(t) || []).filter((w) => !w.air && w.x != null).map((w) => ({ ...w, radius: .115 }))];
      for (const o of obstacles) {
        const radius = (o.radius + def.radius) ** 2;
        const before = dxBetween(from.x, o.x) ** 2 + (from.z - o.z) ** 2, after = dxBetween(x, o.x) ** 2 + (z - o.z) ** 2;
        if (after >= radius) continue;
        if (before >= radius || after <= before + 1e-7) return false;
        escaping = true;
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
  strategic(from, to, def, buildingRoads = false, skipFlow = false, limit = STRATEGIC_LIMIT) {
    if (from === to) return [to];
    const flow = !buildingRoads && !skipFlow && this.activeFlows.get(def.move);
    if (flow && dist(to, flow.goal) <= 4 && flow.next[from] >= 0) {
      const route = [from]; let t = from;
      while (t !== flow.goal && dist(t, to) > 3 && route.length < 4300) { t = flow.next[t]; if (t < 0) break; route.push(t); }
      if (t >= 0) {
        const tail = this.strategic(t, to, def, false, true);
        if (tail) return route.concat(tail.slice(1));
      }
    }
    const key = `${def.move}:${from}:${to}`;
    if (!buildingRoads && this.corridors.has(key)) return this.corridors.get(key);
    const heap = new MinHeap(), best = new Map([[from, 0]]), parents = new Map(), closed = new Set();
    heap.push(from, 0);
    let result = null;
    while (heap.size && closed.size < limit) {
      const t = heap.pop();
      if (closed.has(t)) continue;
      if (t === to) {
        result = [t];
        for (let p = parents.get(t); p !== undefined; p = parents.get(p)) result.push(p);
        result.reverse();
        break;
      }
      closed.add(t);
      for (let d = 0; d < 6; d++) {
        const n = NB[t * 6 + d];
        if (n < 0 || closed.has(n)) continue;
        let weight = buildingRoads ? this.cost(n, X[n], Z[n], def) : this.stepCost(t, n, def);
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
        } else if (this.roads.usable(t, n)) weight *= .94;
        const cost = best.get(t) + weight;
        if (cost >= (best.get(n) ?? Infinity)) continue;
        best.set(n, cost);
        parents.set(n, t);
        heap.push(n, cost + dist(n, to) * .59);
      }
    }
    if (!buildingRoads) {
      if (this.corridors.size >= 384) this.corridors.delete(this.corridors.keys().next().value);
      this.corridors.set(key, result);
    }
    return result;
  }

  route(from, to, def) {
    if (!this.canStand(to.x, to.z, def)) return null;
    if (def.air || (distance(from, to) < 12 && this.line(from, to, def))) return [to];
    const a = tileAt(from.x, from.z), b = tileAt(to.x, to.z);
    if (a < 0 || b < 0) return null;
    const coarse = this.strategic(a, b, def);
    if (!coarse) return this.line(from, to, def) ? [to] : null;
    const points = [from];
    for (let i = 0; i < coarse.length - 1; i++) {
      const t = coarse[i], n = coarse[i + 1];
      // Portals stay continuous. A coarse cell only guides the corridor search.
      const x = X[t] + dxBetween(X[t], X[n]) * .5, z = (Z[t] + Z[n]) * .5;
      const portal = this.nearest({ x, z }, def, .65);
      if (portal) points.push(portal);
      if (i + 2 < coarse.length) {
        const hub = this.nearest(centerOf(n), def, .89);
        if (hub) points.push(hub);
      }
    }
    points.push(to);
    const path = [];
    let i = 0;
    while (i < points.length - 1) {
      let j = Math.min(points.length - 1, i + 7);
      for (; j > i; j--) if (this.line(points[i], points[j], def)) break;
      if (j === i) {
        // A blocked corridor step (a facility, a wreck, a tight gap between buildings): search a fine
        // local grid, first cheaply, then wider and toward the next waypoint too, so one badly placed
        // portal inside a compound does not fail the whole order.
        let detour = this.localRoute(points[i], points[i + 1], def), skip = 1;
        if (!detour && i + 2 < points.length) { detour = this.localRoute(points[i], points[i + 2], def, 900, 37, .2); skip = 2; }
        if (!detour) { detour = this.localRoute(points[i], points[i + 1], def, 1400, 45, .18); skip = 1; }
        if (!detour) return null;
        path.push(...detour);
        i += skip;
      } else {
        path.push(points[j]);
        i = j;
      }
    }
    return path;
  }

  localRoute(a, b, def, budget = 220, grid = 25, step = .24) {
    const mid = grid >> 1;
    const x0 = a.x, z0 = a.z, key = (x, z) => z * grid + x;
    const heap = new MinHeap(), start = key(mid, mid), weights = new Map([[start, 0]]), from = new Map();
    const point = (k) => ({ x: wrapX(x0 + (k % grid - mid) * step), z: z0 + (((k / grid) | 0) - mid) * step });
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    heap.push(start, 0);
    let visited = 0;
    while (heap.size && visited++ < budget) {
      const t = heap.pop(), p = point(t);
      if (distance(p, b) < .65 && this.line(p, b, def, .15)) {
        const result = [b];
        for (let n = t; n !== start; n = from.get(n)) result.push(point(n));
        return result.reverse();
      }
      const tx = t % grid, tz = (t / grid) | 0;
      for (const [dx, dz] of dirs) {
        const x = tx + dx, z = tz + dz;
        if (x < 0 || x >= grid || z < 0 || z >= grid) continue;
        const n = key(x, z), q = point(n), w = weights.get(t) + (dx && dz ? 1.414 : 1);
        if (w >= (weights.get(n) ?? Infinity) || !this.line(p, q, def, .14)) continue;
        weights.set(n, w);
        from.set(n, t);
        heap.push(n, w + distance(q, b) / step);
      }
    }
    return null;
  }

  clearShot(a, b) {
    const dx = dxBetween(a.x, b.x), dz = b.z - a.z, steps = Math.ceil(Math.hypot(dx, dz) / .44);
    const start = tileAt(a.x, a.z), end = tileAt(b.x, b.z);
    const elev = this.world.elev, lo = elev[start] ?? 0, hi = elev[end] ?? 0;
    for (let i = 1; i < steps; i++) {
      const f = i / steps, x = wrapX(a.x + dx * f), z = a.z + dz * f, t = tileAt(x, z);
      if (t < 0) continue;
      if (t !== start && t !== end && elev[t] > lo + (hi - lo) * f + .18 || this.obstacleAt(t, x, z, 0, a.id, b.id, true)) return false;
    }
    return true;
  }

  region(centerTile, radius) { return disk(centerTile, radius); }
}
