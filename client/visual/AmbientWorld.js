// Orchestrates the purely visual life of the world. None of it is simulated by the server: it is
// derived from aggregate gameplay facts (population, employment, active buildings, road traffic,
// construction crews, damage, fires, era) and cheap enough to cull and level-of-detail by zoom.
import { CityVisuals } from './CityVisuals.js';
import { drawTraffic } from './CivilianTraffic.js';
import { drawPedestrians } from './PedestrianSystem.js';
import { drawFactories } from './FactoryActivity.js';
import { drawConstruction } from './ConstructionVisuals.js';
import { drawEnvironment } from './EnvironmentalEffects.js';

export class AmbientWorld {
  constructor(view, S) { this.view = view; this.S = S; this.cityVis = new CityVisuals(view, S); this.acc = 0; }

  frame(dt, t) {
    const S = this.S, v = this.view, g = v.ambientG;
    this.acc += dt;
    if (this.acc > 0.5) { this.acc = 0; this.cityVis.update(); }
    S.night = 0;                    // consistent daylight: no day/night cycle
    S.lightsList = [];
    g.clear();
    drawFactories(g, v, S, t);
    drawConstruction(g, v, S, t);
    // decorative life is the first thing the Low graphics preset drops (gameplay cues never are)
    if (S.decor !== false) { drawTraffic(g, v, S, t); drawPedestrians(g, v, S, this.cityVis, t); }
    drawEnvironment(g, v, S, t);
    // consistent daylight: only fires and explosions glow, locally, in daylight
    v.night.clear();
    const L = v.lights; L.clear();
    for (const [x, y, r, c] of S.lightsList) if (v.inView(x, y)) L.circle(x, y, r * 0.6).fill({ color: c, alpha: 0.14 });
  }
}
