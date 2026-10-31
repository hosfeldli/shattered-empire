// Field trenches drawn from the authoritative fieldworks list: excavation (dark earth and soil
// piles), defensive works (a cut trench with sandbags going in), fortified (a connected zig-zag
// trench with a sandbag parapet on the facing side and timber revetments). Adjacent segments of
// the same owner join up; damage shows as gaps and spilled earth. At strategic zoom a defensive-
// line symbol in the owner's colour. Static per change; drawn at base positions (mirrored).
import { h } from './VisualLOD.js';

const DIRV = [[1, 0], [0.5, 0.866], [-0.5, 0.866], [-1, 0], [-0.5, -0.866], [0.5, -0.866]];
const EARTH = 0x5b4632, EARTH_D = 0x3d2f22, SOIL = 0x7a6248, BAG = 0xb9a77a, BAG_D = 0x8d7c55, WOOD = 0x6e5236;

export function drawFieldworks(g, v, S, strategic) {
  g.clear();
  if (!S.fw || !S.fw.size) return;
  const R = 12;
  const pos = (t) => [v.cx0[t], v.cy[t]];
  for (const f of S.fw.values()) {
    const [x, y] = pos(f.t);
    const col = S.civColor(f.o);
    const stage = f.p >= 100 ? 3 : f.p >= 34 ? 2 : 1;
    const dmg = f.hp < 60;
    // neighbours of the same owner (pixel direction to each)
    const links = [];
    for (let d = 0; d < 6; d++) { const n = v.nb(f.t, d); if (n >= 0) { const o = S.fw.get(n); if (o && o.o === f.o) { let nx = v.cx0[n]; if (v.wrap && Math.abs(nx - x) > v.P / 2) nx += nx > x ? -v.P : v.P; links.push([nx - x, v.cy[n] - y]); } } }
    const [fx, fy] = DIRV[f.dir] || [0, -1];
    const [rx, ry] = [-fy, fx];
    if (strategic) {
      // understated defensive-line symbol
      if (links.length) for (const [dx, dy] of links) g.moveTo(x, y).lineTo(x + dx / 2, y + dy / 2).stroke({ width: 3, color: col, alpha: 0.8 });
      else g.moveTo(x - rx * 7, y - ry * 7).lineTo(x + rx * 7, y + ry * 7).stroke({ width: 3, color: col, alpha: 0.8 });
      g.moveTo(x, y).lineTo(x + fx * 4, y + fy * 4).stroke({ width: 2, color: col, alpha: 0.8 });
      continue;
    }
    // the cut: through every link to the hex edge, else across the facing
    const segs = links.length ? links.map(([dx, dy]) => [x, y, x + dx / 2, y + dy / 2]) : [[x - rx * 8, y - ry * 8, x + rx * 8, y + ry * 8]];
    // stage 1: disturbed ground and soil piles
    g.ellipse(x, y, R * 0.75, R * 0.6).fill({ color: EARTH_D, alpha: stage === 1 ? 0.45 : 0.3 });
    for (let k = 0; k < 5; k++) { const a = h(f.t, k) * 6.28, d = 3 + h(f.t, k, 1) * 6; g.ellipse(x + Math.cos(a) * d - fx * 3, y + Math.sin(a) * d - fy * 3, 2.2, 1.5).fill({ color: SOIL, alpha: 0.85 }); }
    if (stage === 1) {
      const frac = Math.max(0.15, f.p / 34);
      for (const [x0, y0, x1, y1] of segs) g.moveTo(x0, y0).lineTo(x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac).stroke({ width: 2.4, color: EARTH, alpha: 0.9 });
    } else {
      for (const [x0, y0, x1, y1] of segs) {
        // zig-zag trench
        const n = 4, dx = (x1 - x0) / n, dy = (y1 - y0) / n, l = Math.hypot(dx, dy) || 1, px = -dy / l * 1.6, py = dx / l * 1.6;
        g.moveTo(x0, y0);
        for (let i = 1; i <= n; i++) g.lineTo(x0 + dx * i + (i % 2 ? px : -px), y0 + dy * i + (i % 2 ? py : -py));
        g.stroke({ width: 3.6, color: EARTH_D, alpha: 0.95 });
        g.moveTo(x0, y0); for (let i = 1; i <= n; i++) g.lineTo(x0 + dx * i + (i % 2 ? px : -px), y0 + dy * i + (i % 2 ? py : -py)); g.stroke({ width: 1.4, color: 0x2a1f16, alpha: 0.9 });
        // sandbag parapet on the facing side (stage 2 partial, stage 3 full, gaps when damaged)
        const bags = stage === 3 ? 6 : Math.round(6 * ((f.p - 34) / 66));
        for (let i = 0; i < bags; i++) {
          if (dmg && h(f.t, i, 7) < 0.35) continue;
          const t = (i + 0.5) / 6, bx = x0 + (x1 - x0) * t + fx * 2.8, by = y0 + (y1 - y0) * t + fy * 2.8;
          g.ellipse(bx, by, 1.7, 1.1).fill({ color: i % 2 ? BAG : BAG_D }).stroke({ width: 0.4, color: 0x5a4c33 });
        }
        if (stage === 3) for (let i = 1; i < 4; i += 2) { const t = i / 4, bx = x0 + (x1 - x0) * t - fx * 2.2, by = y0 + (y1 - y0) * t - fy * 2.2; g.rect(bx - 0.9, by - 0.9, 1.8, 1.8).fill({ color: WOOD }); }
      }
      if (f.type === 'reinforced' && stage === 3) g.circle(x + fx * 4.5, y + fy * 4.5, 1.6).fill({ color: BAG }).stroke({ width: 0.5, color: 0x5a4c33 });
    }
    if (dmg) for (let k = 0; k < 3; k++) { const a = h(f.t, k, 9) * 6.28; g.ellipse(x + Math.cos(a) * 5, y + Math.sin(a) * 5, 2.6, 1.6).fill({ color: SOIL, alpha: 0.9 }); }
    // owner tick (so a captured or enemy line is readable)
    g.circle(x - fx * 6.5, y - fy * 6.5, 1.3).fill({ color: col });
    if (f.st === 1) g.circle(x, y - 7, 1.8).fill({ color: 0xf0b54a });        // waiting for materials
  }
}
