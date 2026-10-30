// Civilian traffic on the real road graph: the server sends how busy each visible road segment is
// (trade convoys and unit movements); the client turns that into era-appropriate vehicles.
import { h, frac, atLeast } from './VisualLOD.js';

export function drawTraffic(g, view, S, t) {
  if (!atLeast(S, 'city')) return;
  const era = S.econ?.age || 0;
  let budget = 900;
  for (const [a, b, lvl] of S.traffic) {
    if (budget <= 0) break;
    const ax = view.cx[a], ay = view.cy[a], bx = view.cx[b], by = view.cy[b];
    if (!view.inView(ax, ay) && !view.inView(bx, by)) continue;
    const d = view.dirTo(a, b); const ty = d >= 0 ? view.roadType(a, d) : 1;
    const n = Math.min(4, Math.ceil(lvl / 2.5));
    if (ty === 4) {
      // freight train: locomotive + wagons, one per busy rail segment
      const p = frac(t * 0.25 + h(a, b));
      for (let k = 0; k < 4; k++) { const q = p - k * 0.12; if (q < 0 || q > 1) continue; g.rect(ax + (bx - ax) * q - 1.6, ay + (by - ay) * q - 1.1, 3.2, 2.2).fill({ color: k ? 0x6b5236 : 0x222222 }); budget--; }
      continue;
    }
    for (let k = 0; k < n; k++) {
      const dir = k % 2 ? 1 : -1;
      const sp = era === 0 ? 0.12 : 0.22 + ty * 0.06;
      let p = frac(t * sp + h(a, b, k)); if (dir < 0) p = 1 - p;
      const off = dir * 1.1;
      const nx = -(by - ay), ny = bx - ax, nl = Math.hypot(nx, ny) || 1;
      const x = ax + (bx - ax) * p + (nx / nl) * off, y = ay + (by - ay) * p + (ny / nl) * off;
      const col = era === 0 ? 0x7a5a3a : [0xd8d2c4, 0xb84a3a, 0x3b6ea8, 0x2f2f2f, 0xc9a43a][Math.floor(h(a, b, k + 5) * 5)];
      g.rect(x - 1.2, y - 0.8, era === 0 ? 2 : 2.6, 1.6).fill({ color: col });
      if (S.night > 0.2 && era >= 1) S.lightsList.push([x, y, 1.6, 0xffe2a0]);
      budget--;
    }
  }
}
