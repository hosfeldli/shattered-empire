// Clouds from the regional weather: soft shadows that drift across the ground (and the units on it),
// and, at city zoom, faint wisps overhead. Puffs move continuously with the wind and take their
// density from the interpolated weather field where they are, so the sky changes smoothly between
// the server's 5-second updates. Overhead wisps fade away close in so they never hide the battle.
import { h, frac } from './VisualLOD.js';
import { PuffPool } from './WeatherField.js';

export class CloudSystem {
  constructor(view, S, field, shadowLayer, skyLayer) {
    this.v = view; this.S = S; this.f = field;
    this.shadows = new PuffPool(shadowLayer); this.sky = new PuffPool(skyLayer);
  }
  frame(t) {
    const S = this.S, v = this.v, f = this.f;
    this.shadows.begin(); this.sky.begin();
    const mode = S.softwareGpu && (S.prefs?.weather || 'full') === 'full' ? 'reduced' : S.prefs?.weather || 'full';
    // without a GPU the soft cloud sprites cost too much fill rate: skip them (rain, snow and fog remain)
    if (!f.ready || mode === 'off' || S.softwareGpu) { this.shadows.end(); this.sky.end(); return; }
    const z = v.cam.z, strategic = S.lod === 'strategic';
    const [x0, y0, x1, y1] = v.vr;
    const step = (strategic ? 120 : 46) * (mode === 'reduced' ? 1.6 : 1);                        // puff spacing in world units (sized to keep overdraw low)
    const wind = S.wind || [5, -1], ws = Math.hypot(wind[0], wind[1]) || 1;
    const drift = 3.2;                                         // world units per second per unit of wind
    const span = step * 2;
    const gx0 = Math.floor(x0 / step) - 2, gx1 = Math.ceil(x1 / step) + 2, gy0 = Math.floor(y0 / step) - 2, gy1 = Math.ceil(y1 / step) + 2;
    const skyAlpha = mode === 'reduced' ? 0.5 : 1;
    const wispA = mode === 'reduced' ? 0 : strategic ? 0.14 : Math.max(0, 0.2 - (z - 0.8) * 0.14);     // overhead cloud thins as you zoom in
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const seed = gx * 7919 + gy * 104729;
      // the puff travels with the wind and loops over two grid steps, fading in and out at the ends
      const ph = frac(t * drift * ws / span + h(seed, 3));
      const px = gx * step + h(seed, 1) * step + (wind[0] / ws) * (ph - 0.5) * span;
      const py = gy * step + h(seed, 2) * step + (wind[1] / ws) * (ph - 0.5) * span;
      const life = Math.sin(ph * Math.PI);
      const tt = v.tileAt(px, py); if (tt < 0 || S.terr[tt] === 255) continue;      // never over land we have not seen
      const cl = f.at('cloud', px, py), st = f.at('storm', px, py);
      if (cl < 0.15 && st < 0.1) continue;
      const dens = Math.min(1, cl * 1.2 + st * 0.5) * life;
      const r = step * (0.85 + h(seed, 4) * 0.45);
      // the shadow on the ground, offset down-right of the cloud by the sun
      this.shadows.take(px + 14, py + 18, r, st > 0.4 ? 0x0a0e14 : 0x101820, Math.min(0.24, dens * 0.24) * skyAlpha);
      if (wispA > 0.01) this.sky.take(px, py, r * 0.9, st > 0.4 ? 0x7d8590 : cl > 0.7 ? 0xc9ced4 : 0xf2f4f6, Math.min(0.5, dens * wispA) * skyAlpha);
    }
    this.shadows.end(); this.sky.end();
  }
}
