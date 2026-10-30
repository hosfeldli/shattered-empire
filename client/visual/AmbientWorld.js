// Orchestrates the purely visual life of the world. None of it is simulated by the server: it is
// derived from aggregate gameplay facts (population, employment, active buildings, road traffic,
// construction crews, damage, fires, era) and cheap enough to cull and level-of-detail by zoom.
import { CityVisuals } from './CityVisuals.js';
import { drawTraffic } from './CivilianTraffic.js';
import { drawPedestrians } from './PedestrianSystem.js';
import { drawFactories } from './FactoryActivity.js';
import { drawConstruction } from './ConstructionVisuals.js';
import { drawEnvironment, nightLevel } from './EnvironmentalEffects.js';

export class AmbientWorld {
  constructor(view, S) { this.view = view; this.S = S; this.cityVis = new CityVisuals(view, S); this.acc = 0; }

  frame(dt, t) {
    const S = this.S, v = this.view, g = v.ambientG;
    this.acc += dt;
    if (this.acc > 0.5) { this.acc = 0; this.cityVis.update(); }
    S.night = nightLevel(S.time);
    S.lightsList = [];
    g.clear();
    drawFactories(g, v, S, t);
    drawConstruction(g, v, S, t);
    drawTraffic(g, v, S, t);
    drawPedestrians(g, v, S, this.cityVis, t);
    drawEnvironment(g, v, S, t);
    // night: dim the world, then light windows, streets, vehicles and fires additively
    const n = v.night; n.clear();
    if (S.night > 0.01) n.rect(0, 0, v.app.screen.width, v.app.screen.height).fill({ color: 0x07112a, alpha: S.night });
    const L = v.lights; L.clear();
    if (S.night > 0.15) {
      for (const rec of this.cityVis.cities.values()) {
        for (const b of rec.blocks || []) { if (b.ruined || !v.inView(b.x, b.y)) continue; if ((Math.floor(b.x * 7 + b.y * 3) & 3) === 0) continue; L.rect(b.x - 0.6, b.y - 0.6, 1.2, 1.2).fill({ color: 0xffd98a, alpha: S.night * 1.6 }); }
      }
      for (const [x, y, r, c] of S.lightsList) if (v.inView(x, y)) L.circle(x, y, r).fill({ color: c, alpha: S.night * 0.5 });
    }
  }
}
