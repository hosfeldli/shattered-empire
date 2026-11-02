// Ground-level weather: fog lies as soft pale banks, and ground that rain has soaked darkens (or
// whitens under snow). Rain itself is shown by the clouds (CloudSystem): heavy, dark cloud is where
// it rains. World-anchored, culled to the view, and scaled by the Weather effects setting.
import { h, frac } from './VisualLOD.js';
import { PuffPool } from './WeatherField.js';

export class WeatherEffects {
  constructor(view, S, field, groundLayer, airGraphics, fogLayer) {
    this.v = view; this.S = S; this.f = field;
    this.wet = new PuffPool(groundLayer); this.fog = new PuffPool(fogLayer); void airGraphics;
  }
  frame(t) {
    const S = this.S, v = this.v, f = this.f;
    this.wet.begin(); this.fog.begin();
    const mode = S.softwareGpu && (S.prefs?.weather || 'full') === 'full' ? 'reduced' : S.prefs?.weather || 'full';
    if (!f.ready || mode === 'off') { this.wet.end(); this.fog.end(); return; }
    const [x0, y0, x1, y1] = v.vr;
    const strategic = S.lod === 'strategic';
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
  }
}
