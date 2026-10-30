// Server-side A* pathfinding on the hex grid. Clients never path-find.
import { N, TERRAIN, T, isWater } from './constants.js';
import { NB, dist } from './hex.js';
import { MinHeap } from './world.js';

const gScore = new Float32Array(N);
const came = new Int32Array(N);
const stamp = new Int32Array(N);
const closed = new Int32Array(N);
let gen = 0;

// Movement cost of stepping from a -> b for a civ (Infinity if not allowed).
export function stepCost(game, civ, a, b, unitType) {
  const w = game.world;
  const tb = w.terr[b], ta = w.terr[a];
  const own = w.owner[b];
  if (own >= 0 && own !== civ.id && !game.canEnter(civ.id, own)) return Infinity;
  if (isWater(tb)) {
    if (!civ.techs.has('sailing')) return Infinity;
    if (tb === T.DEEP && !civ.techs.has('navigation')) return Infinity;
    if (!isWater(ta)) {
      const pb = game.buildingAtTile(a);
      if (!pb || pb.type !== 'port' || pb.owner !== civ.id || !pb.done) return Infinity; // embark only at own ports
    }
    return civ.techs.has('navigation') ? 0.45 : 0.7;
  }
  const mv = TERRAIN[tb].move;
  if (!Number.isFinite(mv)) return Infinity;
  if (unitType === 'catapult' || unitType === 'artillery') { if (tb === T.MOUNTAIN) return Infinity; }
  let c = mv;
  if (w.road[b] && w.road[a]) c = w.road[b] === 2 && w.road[a] === 2 ? 0.12 : 0.4;
  else if (w.road[b]) c = Math.min(c, 0.8);
  if (w.river[b] && !w.road[b] && !w.river[a]) c += 1.5; // fording a river
  return c;
}

export function findPath(game, civ, start, goal, unitType, maxNodes = 24000) {
  if (start === goal) return [];
  gen++;
  const heap = new MinHeap();
  stamp[start] = gen; gScore[start] = 0; came[start] = -1;
  heap.push(start, 0);
  let expanded = 0, best = start, bestH = dist(start, goal);
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
      const c = stepCost(game, civ, cur, n, unitType);
      if (!Number.isFinite(c)) continue;
      const ng = gScore[cur] + c;
      if (stamp[n] !== gen || ng < gScore[n]) {
        stamp[n] = gen; gScore[n] = ng; came[n] = cur;
        heap.push(n, ng + dist(n, goal) * 0.4);
      }
    }
  }
  // reconstruct to goal, or to the closest reachable tile
  const path = [];
  let c = best;
  if (stamp[c] !== gen) return null;
  while (c !== start && c >= 0) { path.push(c); c = came[c]; }
  path.reverse();
  if (!path.length) return null;
  if (best !== goal) path.partial = true; // goal unreachable: this only gets as close as possible
  return path;
}

// Road routing: prefer passable land, avoid water; returns tile list including start.
export function findRoadRoute(game, civ, a, b) {
  gen++;
  const w = game.world;
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
      const t = w.terr[n];
      if (isWater(t) || !Number.isFinite(TERRAIN[t].move)) continue;
      if (w.owner[n] >= 0 && w.owner[n] !== civ.id) continue;
      if (w.river[n] && !civ.techs.has('engineering') && !w.road[n]) continue; // bridges need Engineering
      const c = w.road[n] ? 0.3 : TERRAIN[t].move;
      const ng = gScore[cur] + c;
      if (stamp[n] !== gen || ng < gScore[n]) { stamp[n] = gen; gScore[n] = ng; came[n] = cur; heap.push(n, ng + dist(n, b)); }
    }
  }
  if (!found) return null;
  const out = []; let c = b;
  while (c >= 0) { out.push(c); c = came[c]; }
  return out.reverse();
}
