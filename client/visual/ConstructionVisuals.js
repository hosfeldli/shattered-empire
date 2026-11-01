// Construction sites show scaffolding, a crane and crews (as many as the server's crew factor);
// planned sites show survey stakes; road projects show earthworks at the working segment.
import { h, frac, atLeast } from './VisualLOD.js';

export function drawConstruction(g, view, S, t) {
  if (!atLeast(S, 'city')) return;
  for (const b of S.buildings.values()) {
    if (b.d) continue;
    const x = view.cx[b.t], y = view.cy[b.t];
    if (!view.inView(x, y, 40) || !S.vis[b.t]) continue;
    if (b.st === 'planned') { for (const [dx, dy] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) g.rect(x + dx - 0.6, y + dy - 0.6, 1.2, 1.2).fill({ color: 0xf1c75b }); continue; }
    const p = (b.p || 0) / 100;
    const top = y + 8 - 16 * p;
    g.rect(x - 8, top, 16, y + 8 - top).stroke({ width: 0.8, color: 0xc9a46a, alpha: 0.9 });
    for (let k = 0; k <= 4; k++) g.moveTo(x - 8 + k * 4, y + 8).lineTo(x - 8 + k * 4, top);
    g.stroke({ width: 0.5, color: 0xc9a46a, alpha: 0.7 });
    // crane
    const ang = Math.sin(t * 0.4 + b.id) * 1.2;
    g.moveTo(x + 9, y + 9).lineTo(x + 9, y - 14).lineTo(x + 9 + Math.cos(ang) * 14, y - 14 + Math.sin(ang) * 3).stroke({ width: 1, color: 0xf0b54a });
    // crews
    const n = Math.max(1, Math.round((b.cr || 1) * 3));
    for (let k = 0; k < n; k++) { const q = frac(t * 0.25 + h(b.id, k)); const tri = q < 0.5 ? q * 2 : 2 - q * 2; g.circle(x - 7 + tri * 14, y + 6 - h(b.id, k, 2) * 12, 0.9).fill({ color: 0xf3d26b }); }
  }
  for (const pr of S.econ?.roads || []) {
    if (pr.status !== 'constructing' || !pr.tiles || pr.tiles.length < 2) continue;
    const pts = view.tilePts ? view.tilePts(pr.tiles.slice(0, 5)) : pr.tiles.slice(0, 5).map((k) => [view.cx[k], view.cy[k]]);
    const x = (pts[0][0] + pts[1][0]) / 2, y = (pts[0][1] + pts[1][1]) / 2;
    if (!view.inView(x, y)) continue;
    const p = frac(t * 0.5); g.rect(x - 2 + Math.sin(p * 6.28) * 2, y - 1.5, 3.4, 2.4).fill({ color: 0xe0a020 });
    for (let k = 1; k < pts.length; k++) g.circle(pts[k][0], pts[k][1], 0.9).fill({ color: 0xf1c75b });
  }
}
