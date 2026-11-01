// Precipitation, fog and wet ground from the regional weather. Rain falls as fine slanted streaks
// (slanting with the wind) with splashes up close; snow drifts down as flakes; fog lies as soft
// pale banks; ground that rain has soaked darkens. Lightning in a storm is a brief, local brightening
// inside the cloud — never a screen-wide flash (and none at all with reduced motion).
// All of it is world-anchored, culled to the view, and scaled by the graphics preset and the
// Weather effects setting (Full / Reduced / Off).
import { h, frac, atLeast } from './VisualLOD.js';
import { PuffPool } from './WeatherField.js';

export class WeatherEffects {
  constructor(view, S, field, groundLayer, airGraphics, fogLayer) {
    this.v = view; this.S = S; this.f = field;
    this.wet = new PuffPool(groundLayer); this.fog = new PuffPool(fogLayer); this.g = airGraphics;
    this.bolts = [];
  }
  frame(t, dt) {
    const S = this.S, v = this.v, f = this.f, g = this.g;
    g.clear(); this.wet.begin(); this.fog.begin();
    const mode = S.softwareGpu && (S.prefs?.weather || 'full') === 'full' ? 'reduced' : S.prefs?.weather || 'full';
    if (!f.ready || mode === 'off') { this.wet.end(); this.fog.end(); return; }
    const [x0, y0, x1, y1] = v.vr, z = v.cam.z;
    const strategic = S.lod === 'strategic';
    const wind = S.wind || [5, -1];
    // soaked ground and fog banks (cheap soft sprites on a coarse grid)
    const gs = (strategic ? 110 : 56) * (mode === 'reduced' ? 1.6 : 1);
    for (let gy = Math.floor(y0 / gs) - 1; gy <= Math.ceil(y1 / gs) + 1; gy++) for (let gx = Math.floor(x0 / gs) - 1; gx <= Math.ceil(x1 / gs) + 1; gx++) {
      const seed = gx * 15485863 + gy * 32452843;
      const px = gx * gs + h(seed, 1) * gs, py = gy * gs + h(seed, 2) * gs;
      { const tt = v.tileAt(px, py); if (tt < 0 || S.terr[tt] === 255) continue; }
      const wet = f.at('wet', px, py), fog = f.at('fog', px, py);
      if (wet > 0.15 && !S.softwareGpu) this.wet.take(px, py, gs * 0.95, f.snowAt(px, py) ? 0xe8eef2 : 0x14202c, Math.min(0.22, (wet - 0.15) * 0.3) * (f.snowAt(px, py) ? 1.3 : 1));
      if (fog > 0.12) {
        const ph = frac(t * 0.02 + h(seed, 3));
        this.fog.take(px + Math.sin(ph * 6.283) * 10, py, gs * 1.15, 0xdfe5e8, Math.min(0.36, (fog - 0.12) * 0.5) * (mode === 'reduced' ? 0.7 : 1));
      }
    }
    this.wet.end(); this.fog.end();
    if (strategic || mode === 'reduced' || !atLeast(S, 'city')) return;
    // rain and snow: a grid of emitters across the view, each dropping a few streaks or flakes
    const scale = Math.min(1.6, S.particleScale ?? 1);
    const step = 26, slx = wind[0] * 0.35, sly = 1;
    const len = Math.max(3, 7 / Math.max(0.7, z * 0.8));
    let budget = Math.round(1400 * scale);
    const flakes = [], splash = [];
    let streaks = 0;
    for (let gy = Math.floor(y0 / step); gy <= Math.ceil(y1 / step) && budget > 0; gy++) for (let gx = Math.floor(x0 / step); gx <= Math.ceil(x1 / step) && budget > 0; gx++) {
      const cx = gx * step, cy = gy * step;
      const p = f.at('rain', cx, cy); if (p < 0.08) continue;
      { const tt = v.tileAt(cx, cy); if (tt < 0 || S.terr[tt] === 255) continue; }
      const snow = f.snowAt(cx, cy);
      const n = Math.min(6, Math.round(p * 6 * scale));
      for (let k = 0; k < n; k++, budget--) {
        const seed = gx * 73856093 ^ gy * 19349663 ^ k * 83492791;
        const sp = snow ? 0.18 + h(seed, 5) * 0.1 : 1.3 + h(seed, 5) * 0.5;
        const ph = frac(t * sp + h(seed, 1));
        const x = cx + h(seed, 2) * step + slx * ph * step * (snow ? 0.6 : 0.4) + (snow ? Math.sin(t * 1.5 + k) * 2 : 0), y = cy + h(seed, 3) * step + ph * step * sly;
        // batched: one path for every streak, one for every flake, one for every splash
        if (snow) flakes.push(x, y);
        else { g.moveTo(x, y).lineTo(x + slx * 0.12 * len, y + len); streaks++; if (S.lod === 'micro' && ph > 0.9) splash.push(x, y + len); }
      }
      // lightning inside a storm cloud: a short, local brightening
      if (!S.prefs?.reducedMotion && f.at('storm', cx, cy) > 0.5 && Math.random() < 0.0004 * dt * 60) this.bolts.push({ x: cx, y: cy, t: 0 });
    }
    if (streaks) g.stroke({ width: 0.5, color: 0xcfe0ec, alpha: 0.5 });
    for (let i = 0; i < flakes.length; i += 2) g.circle(flakes[i], flakes[i + 1], 0.8);
    if (flakes.length) g.fill({ color: 0xffffff, alpha: 0.85 });
    for (let i = 0; i < splash.length; i += 2) g.circle(splash[i], splash[i + 1], 0.9);
    if (splash.length) g.stroke({ width: 0.4, color: 0xe8f2f8, alpha: 0.5 });
    this.bolts = this.bolts.filter((b) => (b.t += dt) < 0.25);
    for (const b of this.bolts) { const a = 1 - b.t / 0.25; g.circle(b.x, b.y - 20, 30).fill({ color: 0xf4f6ff, alpha: 0.18 * a }); g.moveTo(b.x, b.y - 40).lineTo(b.x + 3, b.y - 28).lineTo(b.x - 2, b.y - 20).lineTo(b.x + 2, b.y - 10).stroke({ width: 0.9, color: 0xffffff, alpha: 0.8 * a }); }
  }
}
