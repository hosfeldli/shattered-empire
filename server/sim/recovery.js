// Environmental restoration (every 30 s): ruins smoulder out and overgrow, scarred ground slowly
// re-stabilises, abandoned roads in no-man's land decay, and ash-choked fields recover.
import { N, T } from './constants.js';
import { NB } from './hex.js';

export function recoveryStep(g) {
  const w = g.world;
  for (const [t, r] of g.ruins) {
    const age = g.time - r.time;
    if (!r.overgrown && age > 600) { r.overgrown = true; w.touch(t); }
  }
  if (!w.stab0) w.stab0 = Float32Array.from(w.stab);
  for (let i = 0; i < N; i++) if (w.stab[i] < w.stab0[i]) w.stab[i] = Math.min(w.stab0[i], w.stab[i] + 0.004);
  // forests reclaim untouched land beside them (never owned, built-on or road-bearing hexes)
  for (let k = 0; k < 400; k++) {
    const t = Math.floor(g.rng() * N);
    if ((w.terr[t] !== T.GRASS && w.terr[t] !== T.PLAINS) || w.owner[t] >= 0 || g.buildingAtTile(t) || g.roads.edgesOf(t).length || w.moist[t] < 0.4) continue;
    let f = 0; for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && w.terr[n] === T.FOREST) f++; }
    if (f >= 3 && g.rng() < 0.08) { w.terr[t] = T.FOREST; w.moist[t] = Math.max(w.moist[t], 0.62); w.touch(t); }
  }
  // roads outside anyone's territory and without traffic slowly crumble
  for (const e of g.roads.edges.values()) {
    if (e.cond <= 0 || w.owner[e.a] >= 0 || w.owner[e.b] >= 0) continue;
    if ((g.roads.traffic.get(e.a < e.b ? e.a * N + e.b : e.b * N + e.a) || 0) > 0.5) continue;
    if (g.rng() < 0.15) { e.cond = Math.max(0, e.cond - 5); g.roads.refresh(e.a); g.roads.refresh(e.b); }
  }
}
