// Pedestrians walk the district streets at close zoom; their number follows population and employment.
import { h, frac, atLeast } from './VisualLOD.js';

export function drawPedestrians(g, view, S, cityVis, t) {
  if (!atLeast(S, 'micro')) return;
  let budget = 700;
  for (const c of S.cities.values()) {
    const rec = cityVis.cities.get(c.id); if (!rec || !rec.streets?.length) continue;
    if (!view.inView(view.cx[c.t], view.cy[c.t], 80)) continue;
    const busy = c.o === S.civId && c.jobs ? Math.min(1, (c.jobs.worker + c.jobs.merchant + c.jobs.specialist) / Math.max(1, c.pop)) : 0.7;
    const n = Math.min(40, Math.round((c.pop / 2) * (0.4 + busy * 0.6) * (c.fs ? 0.4 : 1) * (1 - S.night * 0.7)));
    for (let k = 0; k < n && budget > 0; k++, budget--) {
      const s = rec.streets[Math.floor(h(c.id, k) * rec.streets.length)];
      const p = frac(t * (0.03 + h(k, c.id, 2) * 0.04) + h(c.id, k, 3));
      const q = p < 0.5 ? p * 2 : 2 - p * 2;
      const side = (h(k, 9) - 0.5) * 2;
      g.rect(s[0] + (s[2] - s[0]) * q + side, s[1] + (s[3] - s[1]) * q - side * 0.5, 0.9, 0.9).fill({ color: [0xe8d9b0, 0x7aa3c4, 0xc46b5a, 0x9ac47a][k % 4] });
    }
  }
}
