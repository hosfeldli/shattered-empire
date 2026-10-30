// Environmental restoration (every 30 s): ruins smoulder out and overgrow, scarred ground slowly
// re-stabilises, abandoned roads in no-man's land decay, and ash-choked fields recover.
import { N } from './constants.js';

export function recoveryStep(g) {
  const w = g.world;
  for (const [t, r] of g.ruins) {
    const age = g.time - r.time;
    if (!r.overgrown && age > 600) { r.overgrown = true; w.touch(t); }
  }
  if (!w.stab0) w.stab0 = Float32Array.from(w.stab);
  for (let i = 0; i < N; i++) if (w.stab[i] < w.stab0[i]) w.stab[i] = Math.min(w.stab0[i], w.stab[i] + 0.004);
  // roads outside anyone's territory and without traffic slowly crumble
  for (const e of g.roads.edges.values()) {
    if (e.cond <= 0 || w.owner[e.a] >= 0 || w.owner[e.b] >= 0) continue;
    if ((g.roads.traffic.get(e.a < e.b ? e.a * N + e.b : e.b * N + e.a) || 0) > 0.5) continue;
    if (g.rng() < 0.15) { e.cond = Math.max(0, e.cond - 5); g.roads.refresh(e.a); g.roads.refresh(e.b); }
  }
}
