// The world is peaceful: no quakes, eruptions, droughts, shifting rivers or moving mountains.
// Volcanoes are landmarks; lava, ash and drought left in older saves simply fade.
// Runs once per simulated second on the server.
import { N } from './constants.js';
import { qOf, rOf } from './hex.js';

export class Geology {
  constructor(game) {
    this.g = game;
    this.w = game.world;
  }

  step(dt) {
    const w = this.w;
    for (let i = 0; i < N; i++) {
      if (w.lava[i] > 0) { w.lava[i] -= dt; if (w.lava[i] <= 0) { w.lava[i] = 0; w.soil[i] = 1; w.classify(i); w.touch(i); } }
      if (w.ash[i] > 0) { w.ash[i] -= dt; if (w.ash[i] <= 0) { w.ash[i] = 0; w.touch(i); } }
      if (w.drought[i] > 0) { w.drought[i] -= dt; if (w.drought[i] <= 0) { w.drought[i] = 0; w.touch(i); } }
    }
  }
}

export function describeTile(i) { return `(${qOf(i)}, ${rOf(i)})`; }
