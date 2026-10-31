// Server-side navigation: per-movement-class step costs, A*, shared flow fields for
// large groups, and road routing. Clients never path-find.
import { N, W, H, T, MOVE, UNITS, TERRAIN, isWater } from './constants.js';
import { NB, dist, dqWrap, inBounds, idx } from './hex.js';
import { MinHeap } from './world.js';
import { riverSize } from './roads.js';
import { scarCost } from './battlefield.js';

const gScore = new Float32Array(N);
const came = new Int32Array(N);
const stamp = new Int32Array(N);
const closed = new Int32Array(N);
let gen = 0;

// Cost of stepping a -> b for a unit type of a civ (Infinity if not allowed).
export function stepCost(game, civ, a, b, unitType, avoid) {
  const w = game.world;
  const def = UNITS[unitType] || UNITS.militia;
  const mc = MOVE[def.move];
  const own = w.owner[b];
  if (own >= 0 && own !== civ.id && w.owner[a] !== own && !game.canEnter(civ.id, own)) return Infinity;
  if (mc.air) return w.terr[b] === T.LAVA ? 1.5 : 1;
  const tb = w.terr[b], ta = w.terr[a];
  if (isWater(tb)) {
    if (!civ.techs.has('seafaring')) return Infinity;
    if (!isWater(ta)) {
      const pb = game.buildingAtTile(a);
      if (!pb || pb.type !== 'port' || pb.owner !== civ.id || (pb.state !== 'operational' && pb.state !== 'damaged')) return Infinity; // embark only at own ports
    }
    return tb === T.DEEP ? 0.6 : 0.7;
  }
  const base = mc.terrain[tb];
  if (!Number.isFinite(base)) return Infinity;
  let c;
  const edge = game.roads.usable(a, b);
  const riverHere = w.river[b] || (w.river[a] && !isWater(ta));
  if (edge && !(mc.heavy && riverHere && edge.type < 2)) {
    c = mc.road[edge.type] * (edge.cond < 50 ? 1.6 : 1);
  } else {
    c = base;
    if (w.river[b]) {
      const major = riverSize(w, b) >= 2;
      const f = w.river[a] ? (major ? mc.majorFord : mc.ford) * 0.4 : (major ? mc.majorFord : mc.ford);
      if (!Number.isFinite(f)) return Infinity;
      c += f;
    }
  }
  if (game.craters && (game.craters.size || game.wrecks.size)) c += scarCost(game, b, def.move);
  if (avoid && avoid.has(b)) c += 6;
  return c;
}

export function findPath(game, civ, start, goal, unitType, maxNodes = 24000, avoid = null) {
  if (start === goal) return [];
  gen++;
  const heap = new MinHeap();
  stamp[start] = gen; gScore[start] = 0; came[start] = -1;
  heap.push(start, 0);
  let expanded = 0, best = start, bestH = dist(start, goal);
  const air = MOVE[(UNITS[unitType] || UNITS.militia).move].air;
  const hw = air ? 1 : 0.25;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (cur === goal) { best = cur; break; }
    const h = dist(cur, goal);
    if (h < bestH) { bestH = h; best = cur; }
    if (++expanded > maxNodes) break;
    for (let d = 0; d < 6; d++) {
      const n = NB[cur * 6 + d]; if (n < 0 || closed[n] === gen) continue;
      const c = stepCost(game, civ, cur, n, unitType, avoid);
      if (!Number.isFinite(c)) continue;
      const ng = gScore[cur] + c;
      if (stamp[n] !== gen || ng < gScore[n]) {
        stamp[n] = gen; gScore[n] = ng; came[n] = cur;
        heap.push(n, ng + dist(n, goal) * hw);
      }
    }
  }
  const path = [];
  let c = best;
  if (stamp[c] !== gen) return null;
  while (c !== start && c >= 0) { path.push(c); c = came[c]; }
  path.reverse();
  if (!path.length) return null;
  if (best !== goal) path.partial = true; // goal unreachable: this only gets as close as possible
  return path;
}

// ---------------------------------------------------------------- flow fields
// One Dijkstra from the goal serves every unit of the same movement class heading there.
const fieldCache = new Map();
export function flowField(game, civ, goal, unitType) {
  const cls = (UNITS[unitType] || UNITS.militia).move;
  const k = `${game.id}:${civ.id}:${cls}:${goal}:${game.navVersion}`;
  const hit = fieldCache.get(k);
  if (hit) { hit.used = game.time; return hit.field; }
  const field = new Float32Array(N).fill(Infinity);
  const heap = new MinHeap();
  field[goal] = 0; heap.push(goal, 0);
  const done = new Uint8Array(N);
  while (heap.size) {
    const cur = heap.pop();
    if (done[cur]) continue; done[cur] = 1;
    for (let d = 0; d < 6; d++) {
      const n = NB[cur * 6 + d]; if (n < 0 || done[n]) continue;
      const c = stepCost(game, civ, n, cur, unitType);    // reversed: cost to move n -> cur
      if (!Number.isFinite(c)) continue;
      const nv = field[cur] + c;
      if (nv < field[n]) { field[n] = nv; heap.push(n, nv); }
    }
  }
  fieldCache.set(k, { field, used: game.time });
  if (fieldCache.size > 48) {
    const old = [...fieldCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 16);
    for (const [kk] of old) fieldCache.delete(kk);
  }
  return field;
}

// Formation slots around a goal: front rank melee/armor, then ranged, then artillery, then support.
export function formationSlots(game, civ, units, goal, shape = 'line', line = null) {
  const w = game.world;
  const role = (u) => { const d = UNITS[u.type]; if (d.civilian || d.cat === 'support') return 3; if (d.cat === 'artillery') return 2; if (d.range >= 2 && d.cat === 'infantry') return 1; return 0; };
  const sorted = units.slice().sort((a, b) => role(a) - role(b) || a.id - b.id);
  // facing: from the group's centre toward the goal
  let cx = 0, cy = 0;
  // positions are unwrapped around the goal so a formation straddling the seam stays whole
  const gq = goal % W;
  const pos = (t) => { const q = gq + dqWrap(gq, t % W); return [Math.sqrt(3) * (q + 0.5 * (((t / W) | 0) & 1)), 1.5 * ((t / W) | 0)]; };
  for (const u of units) { const [x, y] = pos(u.tile); cx += x; cy += y; }
  cx /= units.length; cy /= units.length;
  let [gx, gy] = pos(goal);
  let fx = gx - cx, fy = gy - cy; const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
  let rx = -fy, ry = fx;
  let width = shape === 'column' ? 1 : Math.max(2, Math.ceil(Math.sqrt(units.length * 2)));
  let spacing = 1.75;
  if (line) {
    // a dragged battle line: its length sets the frontage, its direction the facing
    const [ax, ay] = pos(line[0]), [bx, by] = pos(line[1]);
    const lx = bx - ax, ly = by - ay, ll = Math.hypot(lx, ly) || 1;
    rx = lx / ll; ry = ly / ll; fx = ry; fy = -rx;              // facing: the drag direction turned left
    gx = (ax + bx) / 2; gy = (ay + by) / 2;
    width = Math.max(1, Math.min(units.length, Math.round(ll / 1.75) + 1));
    spacing = width > 1 ? Math.max(1.75, ll / (width - 1)) : 1.75;
  }
  const taken = new Set();
  const slots = new Map();
  const near = (x, y) => {
    let best = -1, bd = Infinity;
    const r0 = Math.round(y / 1.5);
    for (let r = r0 - 2; r <= r0 + 2; r++) {
      if (r < 0 || r >= H) continue;
      const q0 = Math.round(x / Math.sqrt(3) - 0.5 * (r & 1));
      for (let q = q0 - 2; q <= q0 + 2; q++) {
        if (!inBounds(q, r)) continue;
        const t = idx(q, r); if (taken.has(t)) continue;
        const ter = w.terr[t]; if (isWater(ter) || !Number.isFinite(TERRAIN[ter].move)) continue;
        const [px, py] = pos(t); const d = (px - x) ** 2 + (py - y) ** 2;
        if (d < bd) { bd = d; best = t; }
      }
    }
    return best;
  };
  sorted.forEach((u, i) => {
    const rank = Math.floor(i / width), file = i % width;
    const off = (file - (width - 1) / 2) * spacing;
    const x = gx + rx * off - fx * rank * 1.6, y = gy + ry * off - fy * rank * 1.6;
    let t = UNITS[u.type].air ? goal : near(x, y);
    if (t < 0) t = goal;
    taken.add(t); slots.set(u.id, t);
  });
  return slots;
}

// Auto road routing for a road class: prefers existing roads, gentle terrain, avoids rivers unless bridgeable.
export function findRoadRoute(game, civ, a, b, type = 1) {
  gen++;
  const w = game.world, roads = game.roads;
  const heap = new MinHeap();
  stamp[a] = gen; gScore[a] = 0; came[a] = -1; heap.push(a, 0);
  let found = false, expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (cur === b) { found = true; break; }
    if (++expanded > 20000) break;
    for (let d = 0; d < 6; d++) {
      const n = NB[cur * 6 + d]; if (n < 0 || closed[n] === gen) continue;
      const why = roads.validateSegment(game, civ, cur, n, type);
      if (why && why !== 'already built') continue;
      const t = w.terr[n];
      let c = why === 'already built' ? 0.2 : TERRAIN[t].move + (w.river[n] ? 3 : 0);
      if (roads.usable(cur, n)) c = Math.min(c, 0.3);
      const ng = gScore[cur] + c;
      if (stamp[n] !== gen || ng < gScore[n]) { stamp[n] = gen; gScore[n] = ng; came[n] = cur; heap.push(n, ng + dist(n, b) * 0.3); }
    }
  }
  if (!found) return null;
  const out = []; let c = b;
  while (c >= 0) { out.push(c); c = came[c]; }
  return out.reverse();
}
