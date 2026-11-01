// Bridges: crossings over rivers and short spans of shallow water, built on purpose with the Bridge
// tool (or along the way by the road planner) and treated as strategic infrastructure.
//
// A bridge is the road edges that cross a river hex or a shallow-water hex; it is stored in the road
// network like any other segment (one source of truth for both tools, so nothing is built or paid
// twice), and its class follows the road type:
//   Timber Bridge (dirt)            starting era  infantry and light vehicles; short crossings
//   Reinforced Road Bridge (paved+) Civil Engineering  everything, including tanks; major rivers
//   Rail Bridge (rail)              Railways      trains and everything else
// Condition: operational (>= 50), damaged (< 50: slow, still usable), destroyed (0: no crossing,
// rebuild to repair). Shelling and bombing damage bridges like roads; engineers repair them.
import { N, T, isWater } from './constants.js';
import { NB, dist } from './hex.js';
import { riverSize } from './roads.js';

export const BRIDGE_CLASSES = {
  timber: { key: 'timber', name: 'Timber Bridge', roadType: 1, tech: null, span: 2, heavy: false, desc: 'Infantry and light vehicles. Not over major rivers.' },
  road: { key: 'road', name: 'Reinforced Road Bridge', roadType: 2, tech: 'civil_engineering', span: 3, heavy: true, desc: 'Every unit, including tanks and heavy artillery.' },
  rail: { key: 'rail', name: 'Rail Bridge', roadType: 4, tech: 'railways', span: 3, heavy: true, desc: 'Carries the railway (and every unit).' },
};
export const classOfType = (type) => (type >= 4 ? 'rail' : type >= 2 ? 'road' : 'timber');

// a hex a bridge may stand on between its two banks
export const spanTile = (w, t) => (isWater(w.terr[t]) && w.terr[t] === T.SHALLOW) || !!w.river[t];
// an edge is a bridge when it touches a river or a water hex
export const isBridgeEdge = (w, a, b) => !!(w.river[a] || w.river[b] || isWater(w.terr[a]) || isWater(w.terr[b]));

// Every bridge (a maximal run of bridge edges) a civilization can see, for the client and the AI.
export function bridgesFor(g, civ, vis) {
  const w = g.world, out = [], seen = new Set();
  for (const e of g.roads.edges.values()) {
    if (!isBridgeEdge(w, e.a, e.b)) continue;
    if (vis && !vis[e.a] && !vis[e.b] && !civ.explored[e.a]) continue;
    const k = Math.min(e.a, e.b) * N + Math.max(e.a, e.b); if (seen.has(k)) continue; seen.add(k);
    out.push([e.a, e.b, e.type, Math.round(e.cond)]);
  }
  return out;
}

// Plan a bridge between two banks: the shortest run of span hexes (river or shallow water) joining
// them, no longer than the class allows. Returns the road tiles to build, or an error to show.
export function planBridge(g, civ, from, to, cls) {
  const w = g.world, C = BRIDGE_CLASSES[cls];
  if (!C) return { error: 'Unknown bridge type' };
  if (C.tech && !civ.techs.has(C.tech)) return { error: `${C.name} needs ${g.defs.TECHS[C.tech].name}` };
  if (!(from >= 0 && from < N && to >= 0 && to < N) || from === to) return { error: 'Pick both banks' };
  for (const t of [from, to]) if (isWater(w.terr[t])) return { error: 'A bridge starts and ends on land' };
  if (dist(from, to) > C.span + 2) return { error: `Too far for a ${C.name.toLowerCase()}: at most ${C.span} hexes of water or river between the banks` };
  // breadth-first search through span hexes only (river land or shallow water)
  const prev = new Map([[from, -1]]), q = [from];
  let found = false;
  for (let qi = 0; qi < q.length && !found; qi++) {
    const cur = q[qi];
    for (let d = 0; d < 6; d++) {
      const n = NB[cur * 6 + d]; if (n < 0 || prev.has(n)) continue;
      if (n === to) { prev.set(n, cur); found = true; break; }
      if (!spanTile(w, n) || dist(n, from) > C.span + 1) continue;
      prev.set(n, cur); q.push(n);
    }
  }
  if (!found) return { error: 'No crossing joins those banks: pick the two sides of one river or narrow strait' };
  const tiles = []; for (let t = to; t >= 0; t = prev.get(t)) tiles.unshift(t);
  const water = tiles.filter((t) => isWater(w.terr[t])).length, river = tiles.filter((t) => w.river[t]).length;
  if (!water && !river) return { error: 'There is no river or water to cross there' };
  if (water > C.span) return { error: `${water} hexes of water: a ${C.name.toLowerCase()} spans at most ${C.span}` };
  const major = tiles.some((t) => w.river[t] && riverSize(w, t) >= 2);
  if (major && !C.heavy) return { error: 'A major river needs a Reinforced Road Bridge (Civil Engineering)' };
  return { tiles, water, river, major };
}

// may this movement class use this (usable) bridge edge?
export function bridgeCarries(edge, heavy) { return !heavy || edge.type >= 2; }

export function bridgeState(cond) { return cond <= 0 ? 'destroyed' : cond < 50 ? 'damaged' : 'operational'; }
