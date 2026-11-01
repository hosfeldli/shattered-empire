// A living sea on top of the static water colours: broad, slow light glints drifting with the wind
// over open water, and foam washing along every coast (a bright line on the shore edge that pulses,
// with a fainter wash moving out and fading). World-anchored (waves never follow the camera), it
// tiles across the east–west seam because it is drawn from each hex's nearest copy. Nothing at
// strategic zoom; calmer in harbours; a little livelier when the wind or a storm is up.
import { h, frac, atLeast } from './VisualLOD.js';

export class OceanSurface {
  constructor(view, S, field, g) { this.v = view; this.S = S; this.f = field; this.g = g; this.coast = []; this.water = []; this.key = -1; }

  // coastline edges and water hexes, recomputed only when the known map changes
  index() {
    const S = this.S, v = this.v;
    if (this.key === S.tilesVersion) return;
    this.key = S.tilesVersion;
    this.coast = []; this.water = [];
    for (let i = 0; i < v.N; i++) {
      if (S.terr[i] > 1) continue;                  // 0 deep, 1 shallow; 255 unknown is excluded too
      this.water.push(i);
      for (let d = 0; d < 6; d++) { const n = v.nb(i, d); if (n >= 0 && S.terr[n] > 1 && S.terr[n] !== 255) this.coast.push([i, n]); }
    }
  }
  frame(t) {
    const S = this.S, v = this.v, g = this.g;
    g.clear();
    if ((S.prefs?.weather || 'full') === 'off' || !atLeast(S, 'city') || (S.softwareGpu && S.lod !== 'micro')) return;
    this.index();
    const close = S.lod === 'micro';
    const wind = S.wind || [5, -1], ws = Math.hypot(wind[0], wind[1]) || 1, ux = wind[0] / ws, uy = wind[1] / ws;
    const rough = Math.min(1, 0.35 + ws / 14 + (this.f.ready ? this.f.at('storm', v.camCenterX(), v.cam.y) : 0));
    // open-water glints: two per hex, drifting downwind and fading in and out (batched into four
    // brightness levels: a handful of draw calls however many glints are on screen)
    const G = [[], [], [], []], F = [[], [], [], []], WASH = [];
    let budget = !close ? 0 : S.softwareGpu ? 300 : 1400;     // glints only up close; foam from city zoom
    for (const i of this.water) {
      const x = v.cx[i], y = v.cy[i]; if (!v.inView(x, y, 10)) continue;
      if (budget-- <= 0) break;
      for (let k = 0; k < (close ? 2 : 1); k++) {
        const ph = frac(t * (0.05 + 0.04 * rough) + h(i, k, 61));
        const ox = (h(i, k, 62) - 0.5) * 16 + ux * (ph - 0.5) * 10, oy = (h(i, k, 63) - 0.5) * 14 + uy * (ph - 0.5) * 8;
        const a = Math.sin(ph * Math.PI) * (S.terr[i] === 0 ? 0.22 : 0.16) * (0.6 + rough * 0.6);
        const L = 2.4 + h(i, k, 64) * 2.5;
        G[Math.min(3, (a / 0.3 * 4) | 0)].push(x + ox - uy * L, y + oy + ux * L * 0.4, x + ox + uy * L, y + oy - ux * L * 0.4);
      }
    }
    // coastal foam: the shore line pulses; a wash rolls out from it and fades
    for (const [i, n] of this.coast) {
      const xi = v.cx[i], yi = v.cy[i]; if (!v.inView(xi, yi, 14)) continue;
      const xn = v.nx(n, xi), yn = v.cy[n];
      const mx = (xi + xn) / 2, my = (yi + yn) / 2, dx = xn - xi, dy = yn - yi, L = Math.hypot(dx, dy) || 1, nx = dx / L, ny = dy / L;   // n points toward land
      const px = -ny * 6, py = nx * 6;                                    // half the shared edge
      const ph = frac(t * 0.22 + h(i, n, 71));
      const a0 = 0.35 + 0.25 * Math.sin(t * 1.3 + h(i, n, 72) * 6.283);
      F[Math.min(3, ((a0 * (0.7 + rough * 0.4)) / 0.75 * 4) | 0)].push(mx - px - nx * 0.8, my - py - ny * 0.8, mx + px - nx * 0.8, my + py - ny * 0.8);
      if ((close || rough > 0.6) && ph < 0.7) { const off = 1.5 + ph * 4; WASH.push(mx - px * 0.8 - nx * off, my - py * 0.8 - ny * off, mx + px * 0.8 - nx * off, my + py * 0.8 - ny * off); }
    }
    const lines = (arr) => { for (let i = 0; i < arr.length; i += 4) g.moveTo(arr[i], arr[i + 1]).lineTo(arr[i + 2], arr[i + 3]); };
    G.forEach((arr, k) => { if (arr.length) { lines(arr); g.stroke({ width: 0.7, color: 0xdff0ff, alpha: 0.05 + k * 0.07 }); } });
    F.forEach((arr, k) => { if (arr.length) { lines(arr); g.stroke({ width: 1.1, color: 0xf4fbff, alpha: 0.2 + k * 0.17 }); } });
    if (WASH.length) { lines(WASH); g.stroke({ width: 0.7, color: 0xe8f6ff, alpha: 0.18 }); }
  }
}
