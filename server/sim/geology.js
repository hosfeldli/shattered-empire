// Dynamic continental simulation: tectonic drift, earthquakes, eruptions,
// droughts and river avulsions. Runs once per simulated second on the server.
import { T, RES, isWater, N } from './constants.js';
import { NB, disk, dist, qOf, rOf } from './hex.js';

const QUAKE_COOLDOWN = 75;

export class Geology {
  constructor(game) {
    this.g = game;
    const w = game.world;
    this.w = w;
    this.rng = game.rng;
    this.moving = [];
    for (let i = 0; i < N; i++) if (w.rate[i] !== 0) this.moving.push(i);
    this.faultMul = new Map(w.faultTiles.map((t) => [t, this.rng.range(0.6, 1.4)]));
    this.lastQuake = -60;            // first quake usually 3-4 minutes in
    this.nextDrought = 240 + this.rng.range(0, 120);
    this.nextAvulsion = 300 + this.rng.range(0, 150);
    this.hydroTimer = 0;
    this.warned = new Map();         // key -> time warned
    this.riftFlooded = 0; this.lastRiftMsg = -999; this.riftAnnounced = false;
    this.upliftPending = 0; this.lastUpliftMsg = -999; this.upliftTile = -1;
    this.stabilizers = new Float32Array(N); // stress damping from seismic stations/levees
  }

  recomputeStabilizers() {
    this.stabilizers.fill(0);
    for (const b of this.g.buildings.values()) {
      const def = this.g.defs.BUILDINGS[b.type];
      if (!def.stabilize || !b.done) continue;
      for (const t of disk(b.tile, 4)) this.stabilizers[t] = Math.max(this.stabilizers[t], def.stabilize);
    }
  }

  step(dt, now) {
    const w = this.w, g = this.g;
    // Peaceful world (the default): no quakes, eruptions, droughts, shifting rivers or moving
    // mountains. Volcanoes are landmarks; lava and ash from before simply cool.
    if (!g.cataclysm) { this.coolOnly(dt); return; }
    const freq = g.cataclysm.freq, sev = g.cataclysm.sev;
    dt *= freq;                                   // Cataclysm frequency scales every geological clock
    if (Math.floor(now) % 5 === 0) this.recomputeStabilizers();
    // --- Slow tectonics: uplift & subsidence
    let terrainChanged = false;
    for (const i of this.moving) {
      const damp = 1 - this.stabilizers[i];
      const before = w.elev[i];
      w.elev[i] += w.rate[i] * dt * damp * sev;
      const t0 = w.terr[i];
      if (w.classify(i)) {
        w.touch(i); terrainChanged = true;
        const t1 = w.terr[i];
        if (t1 === T.PEAK && t0 === T.MOUNTAIN) { this.upliftPending++; this.upliftTile = i; }
        if (isWater(t1) && !isWater(t0)) {
          g.onTileFlooded(i);
          if (w.riftTiles.includes(i)) {
            this.riftFlooded++;
            if (now > 90 && now - this.lastRiftMsg > 150) {
              this.lastRiftMsg = now;
              g.geoEvent('rift', i, 2, this.riftAnnounced ? `The Great Rift widens: ${this.riftFlooded} hexes of land have sunk beneath the sea.` : 'The Great Rift has breached: the sea pours into the heart of the continent.');
              this.riftAnnounced = true;
            }
          }
        }
      }
      void before;
    }
    if (this.upliftPending && now - this.lastUpliftMsg > 120) {
      g.geoEvent('uplift', this.upliftTile, 2, this.upliftPending > 1 ? `Mountains rise: ${this.upliftPending} high passes have become impassable.` : 'Mountains rise: a high pass has become impassable.');
      this.upliftPending = 0; this.lastUpliftMsg = now;
    }
    // --- Lava cooling, ash & drought timers
    for (let i = 0; i < N; i++) {
      if (w.lava[i] > 0) {
        w.lava[i] -= dt;
        if (w.lava[i] <= 0) { w.lava[i] = 0; w.soil[i] = 1; w.classify(i); w.touch(i); terrainChanged = true; }
      }
      if (w.ash[i] > 0) { w.ash[i] -= dt; if (w.ash[i] <= 0) { w.ash[i] = 0; w.touch(i); } }
      if (w.drought[i] > 0) { w.drought[i] -= dt; if (w.drought[i] <= 0) { w.drought[i] = 0; w.touch(i); this.hydroTimer = 999; } }
    }
    // --- Seismic stress
    let maxS = 0, maxT = -1;
    for (const t of w.faultTiles) {
      w.stress[t] += dt * 0.0042 * this.faultMul.get(t) * (1 - this.stabilizers[t] * 1.6);
      if (w.stress[t] > maxS) { maxS = w.stress[t]; maxT = t; }
    }
    if (maxT >= 0 && maxS > 0.86) this.warn('quake:' + maxT, maxT, 'Seismic precursors detected: an earthquake is imminent nearby.', 'quake');
    if (maxT >= 0 && maxS >= 1 && now - this.lastQuake > QUAKE_COOLDOWN) {
      const o = w.owner[maxT];
      if (o >= 0 && g.civs[o].techs.has('climate_engineering')) { w.stress[maxT] = 0.5; this.lastQuake = now; }
      else { this.earthquake(maxT, now); terrainChanged = true; }
    }
    // --- Volcanoes
    for (const v of w.volcanoes) {
      v.pressure += v.rate * dt * (0.8 + this.rng() * 0.4);
      if (v.pressure > 0.88) this.warn('volc:' + v.tile + ':' + Math.floor(v.erupts || 0), v.tile, 'The volcano is swelling: an eruption is imminent.', 'eruption');
      if (v.pressure >= 1) { this.erupt(v); terrainChanged = true; }
    }
    // --- Drought
    if (now > this.nextDrought) { this.droughtEvent(); this.nextDrought = now + (220 + this.rng.range(0, 160)) / freq; }
    // --- River avulsion
    if (now > this.nextAvulsion) { if (this.avulsion()) terrainChanged = true; this.nextAvulsion = now + (260 + this.rng.range(0, 160)) / freq; }
    // --- Hydrology refresh (rivers follow the changing land)
    this.hydroTimer += dt;
    if (this.hydroTimer > (terrainChanged ? 3 : 20)) { this.hydroTimer = 0; this.refreshRivers(); }
  }

  coolOnly(dt) {
    const w = this.w;
    for (let i = 0; i < N; i++) {
      if (w.lava[i] > 0) { w.lava[i] -= dt; if (w.lava[i] <= 0) { w.lava[i] = 0; w.soil[i] = 1; w.classify(i); w.touch(i); } }
      if (w.ash[i] > 0) { w.ash[i] -= dt; if (w.ash[i] <= 0) { w.ash[i] = 0; w.touch(i); } }
      if (w.drought[i] > 0) { w.drought[i] -= dt; if (w.drought[i] <= 0) { w.drought[i] = 0; w.touch(i); } }
    }
  }

  warn(key, tile, text, kind) {
    if (this.warned.has(key)) return;
    this.warned.set(key, true);
    this.g.geoWarning(kind, tile, text);
  }

  refreshRivers(announce = false) {
    const w = this.w;
    const changed = w.recomputeHydrology();
    for (const i of changed) { w.classify(i); w.touch(i); if (w.terr[i] === T.SHALLOW) this.g.onTileFlooded(i); }
    if (announce && changed.length) return changed;
    return changed;
  }

  earthquake(epi, now) {
    const w = this.w, g = this.g, rng = this.rng;
    this.lastQuake = now;
    const mag = 5.6 + rng() * 2.2;
    const R = Math.round((mag - 5) * 2.4) + 2;
    const mitig = g.civMitigation.bind(g);
    let collapsed = 0;
    for (const t of disk(epi, R)) {
      const inten = 1 - dist(epi, t) / (R + 1);
      const fragility = 1 - w.stab[t] * 0.65;
      // fault offset & landslides
      if (!isWater(w.terr[t])) {
        const before = w.terr[t];
        if ((before === T.MOUNTAIN || before === T.HILLS) && rng() < inten * fragility * 0.55) {
          w.elev[t] += 0.12 + 0.2 * inten;
          if (w.elev[t] > 0.74) collapsed++;
        } else {
          w.elev[t] += (rng() - 0.5) * 0.08 * inten;
        }
        g.roads.damageTile(t, 100 * inten * fragility, rng, 0.8);   // quakes break individual road segments and bridges
        if ((w.terr[t] === T.HILLS || w.terr[t] === T.MOUNTAIN) && !w.res[t] && rng() < 0.05 * inten) w.res[t] = rng.pick([RES.IRON, RES.RARE, RES.COAL, RES.STONE]);
        w.stab[t] = Math.max(0.05, w.stab[t] - 0.06 * inten);
      }
      if (dist(epi, t) <= R - 2) w.stress[t] = 0; else w.stress[t] += 0.15 * rng();
      w.classify(t); w.touch(t);
      // damage
      for (const b of g.buildingsAt(t)) g.damageBuilding(b, b.maxHp * inten * fragility * 0.85 * mitig(b.owner), null, 'quake');
      for (const u of g.unitsAt(t)) g.damageUnit(u, 14 * inten, null, 'quake');
    }
    for (const c of g.cities.values()) {
      const d = dist(c.tile, epi);
      if (d <= R + 2) g.cityDisaster(c, 28 * (1 - d / (R + 3)) * mitig(c.owner));
    }
    this.refreshRivers();
    g.geoEvent('quake', epi, R, `Magnitude ${mag.toFixed(1)} earthquake!` + (collapsed > 2 ? ' Landslides have sealed mountain passes.' : ''), { mag: +mag.toFixed(1) });
  }

  erupt(v) {
    const w = this.w, g = this.g, rng = this.rng;
    v.pressure = 0; v.erupts = (v.erupts || 0) + 1;
    w.elev[v.tile] += 0.04;
    const streams = 2 + rng.int(3);
    const lavaTiles = new Set([v.tile]);
    for (let s = 0; s < streams; s++) {
      let cur = v.tile; const len = 7 + rng.int(8);
      for (let k = 0; k < len; k++) {
        let best = -1, be = Infinity;
        for (let d = 0; d < 6; d++) {
          const n = NB[cur * 6 + d]; if (n < 0 || lavaTiles.has(n)) continue;
          const e = w.elev[n] + rng() * 0.12;
          if (e < be) { be = e; best = n; }
        }
        if (best < 0) break;
        cur = best;
        if (isWater(w.terr[cur])) { w.elev[cur] = 0.02; w.lake[cur] = 0; lavaTiles.add(cur); break; } // lava builds new land
        lavaTiles.add(cur);
      }
    }
    for (const t of lavaTiles) {
      w.lava[t] = 110 + rng() * 60; g.roads.obliterate(t); w.res[t] = RES.NONE;
      w.classify(t); w.touch(t);
      for (const b of g.buildingsAt(t)) g.damageBuilding(b, b.maxHp * 5, null, 'lava');
      for (const u of g.unitsAt(t)) g.damageUnit(u, 999, null, 'lava');
    }
    for (const t of disk(v.tile, 6)) {
      if (lavaTiles.has(t) || isWater(w.terr[t])) continue;
      w.ash[t] = Math.max(w.ash[t], 100 + rng() * 60); w.touch(t);
    }
    for (const c of g.cities.values()) { const d = dist(c.tile, v.tile); if (d <= 8) g.cityDisaster(c, 30 * (1 - d / 9) * g.civMitigation(c.owner)); }
    this.refreshRivers();
    g.geoEvent('eruption', v.tile, 6, 'Volcanic eruption! Lava flows are cutting through the land; ash blankets the farms. Cooled lava will leave rich volcanic soil.');
  }

  droughtEvent() {
    const w = this.w, g = this.g, rng = this.rng;
    // prefer populated land
    const cities = [...g.cities.values()];
    let center;
    if (cities.length && rng() < 0.7) center = rng.pick(cities).tile;
    else { do { center = rng.int(N); } while (isWater(w.terr[center])); }
    const R = 8 + rng.int(6), dur = 120 + rng() * 90;
    for (const t of disk(center, R)) {
      if (isWater(w.terr[t]) && !w.lake[t]) continue;
      if (w.owner[t] >= 0 && g.civs[w.owner[t]].techs.has('climate_engineering')) continue;
      w.drought[t] = Math.max(w.drought[t], dur * (1 - dist(center, t) / (R + 4))); w.touch(t);
    }
    this.refreshRivers();
    g.geoEvent('drought', center, R, 'Drought! Harvests wither and shallow rivers run dry, opening new crossings.');
  }

  avulsion() {
    const w = this.w, rng = this.rng;
    const cands = [];
    for (let i = 0; i < N; i++) if (w.river[i] && w.flow[i] > 70 && w.elev[i] < 0.3) cands.push(i);
    if (!cands.length) return false;
    const t = rng.pick(cands);
    for (const n of disk(t, 1)) { w.elev[n] += n === t ? 0.07 : 0.035; w.classify(n); w.touch(n); }
    const changed = this.refreshRivers();
    if (changed.length) this.g.geoEvent('river', t, 4, 'Silt has choked a great river: it has burst its banks and carved a new course.');
    return true;
  }
}

export function describeTile(i) { return `(${qOf(i)}, ${rOf(i)})`; }
