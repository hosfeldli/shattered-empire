import { H, N, T, W, isWater } from './constants.js';
import { NB, WRAP, center, dist, disk } from './hex.js';
import { MinHeap } from './world.js';

const SQRT3 = Math.sqrt(3), PERIOD = W * SQRT3;
const DIAG = Math.SQRT1_2;
const DIRECTIONS = [[1, 0], [DIAG, DIAG], [0, 1], [-DIAG, DIAG], [-1, 0], [-DIAG, -DIAG], [0, -1], [DIAG, -DIAG]];
const X = new Float32Array(N), Z = new Float32Array(N);
for (let i = 0; i < N; i++) [X[i], Z[i]] = center(i);

export const centerOf = (t) => ({ x: X[t], z: Z[t] });
export const wrapX = (x) => WRAP ? ((x % PERIOD) + PERIOD) % PERIOD : x;
export const dxBetween = (a, b) => { const d = b - a; return WRAP ? d - Math.round(d / PERIOD) * PERIOD : d; };
export const distance = (a, b) => Math.hypot(dxBetween(a.x, b.x), b.z - a.z);

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
  invalidate() { this.corridors.clear(); this.flows.clear(); this.activeFlows.clear(); this.terrainVersion++; }

  primeGroup(group, point) {
    this.activeFlows.clear();
    if (group.length < 12) return;
    const goal = tileAt(point.x, point.z);
    if (goal < 0) return;
    for (const def of group.map((u) => this.game.defs.UNITS[u.type])) {
      if (def.air || this.activeFlows.has(def.move)) continue;
      const key = `${def.move}:${goal}`;
      let flow = this.flows.get(key);
      if (!flow) {
        const next = new Int32Array(N).fill(-1), weights = new Float64Array(N).fill(Infinity), closed = new Uint8Array(N), heap = new MinHeap();
        weights[goal] = 0; heap.push(goal, 0); let expanded = 0;
        while (heap.size && expanded < 4300) {
          const t = heap.pop(); if (closed[t]) continue;
          closed[t] = 1; expanded++;
          for (let d = 0; d < 6; d++) {
            const n = NB[t * 6 + d]; if (n < 0 || closed[n]) continue;
            const terrain = this.cost(n, X[n], Z[n], def); if (!Number.isFinite(terrain)) continue;
            const cost = weights[t] + terrain * (this.roads.usable(t, n) ? .94 : 1);
            if (cost >= weights[n]) continue;
            weights[n] = cost; next[n] = t; heap.push(n, cost);
          }
        }
        flow = { goal, next };
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
      if (!edge || edge.type === 4) continue;
      if (bridgeOnly && def.move === 'tracked' && edge.type < 2) continue;
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
    if (river && !road) {
      if (w.flow[t] >= 94 && def.move !== 'infantry') return Infinity;
      base *= def.move === 'infantry' ? 1.34 : 2.35;
    }
    return road ? Math.min(base, road === 1 ? .84 : .66) : base;
  }

  obstacleAt(t, x, z, radius, ignore = 0, ignoreTarget = 0) {
    for (const b of this.game.obstaclesAtTile(t))
      if (b.id !== ignore && b.id !== ignoreTarget && dxBetween(x, b.x) ** 2 + (b.z - z) ** 2 < (b.radius + radius) ** 2) return true;
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

  strategic(from, to, def, buildingRoads = false, skipFlow = false) {
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
    while (heap.size && closed.size < 4300) {
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
        let weight = this.cost(n, X[n], Z[n], def);
        if (!Number.isFinite(weight) && buildingRoads && this.world.river[n] && !this.world.lake[n] && !isWater(this.world.terr[n])) weight = 2.6;
        if (!Number.isFinite(weight)) continue;
        if (this.roads.usable(t, n)) weight *= .94;
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
        const detour = this.localRoute(points[i], points[i + 1], def);
        if (!detour) return null;
        path.push(...detour);
        i++;
      } else {
        path.push(points[j]);
        i = j;
      }
    }
    return path;
  }

  localRoute(a, b, def) {
    const step = .24, grid = 25, mid = grid >> 1;
    const x0 = a.x, z0 = a.z, key = (x, z) => z * grid + x;
    const heap = new MinHeap(), start = key(mid, mid), weights = new Map([[start, 0]]), from = new Map();
    const point = (k) => ({ x: wrapX(x0 + (k % grid - mid) * step), z: z0 + (((k / grid) | 0) - mid) * step });
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    heap.push(start, 0);
    let visited = 0;
    while (heap.size && visited++ < 220) {
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
      if (t !== start && t !== end && elev[t] > lo + (hi - lo) * f + .18 || this.obstacleAt(t, x, z, 0, a.id, b.id)) return false;
    }
    return true;
  }

  region(centerTile, radius) { return disk(centerTile, radius); }
}
