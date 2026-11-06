// The Free Companies: a rebel minor faction. Camps appear in unclaimed land at the start and
// later, gather supplies, field raiders matched to the era, patrol, raid weakly defended
// targets, occupy ruined towns, and absorb cities that revolt. They can be paid off for a truce.
import { N, T, UNITS, AGES, isWater } from './constants.js';
import { disk, dist } from './hex.js';
import { spawnUnit } from './military.js';

const RAIDERS = [['militia', 'rifle_squad'], ['rifle_squad', 'armored_car'], ['armored_car', 'mech_infantry'], ['mech_infantry', 'special_forces'], ['special_forces', 'exo_infantry']];

export class RebelAI {
  constructor(g, civ) { this.g = g; this.civ = civ; this.nextCamp = 480; this.nextSpawn = 60; this.raid = null; }

  static seed(g, civ, count = 3) {
    const ai = new RebelAI(g, civ);
    for (let i = 0; i < count; i++) ai.newCamp(true);
    return ai;
  }

  campSites() {
    const g = this.g, w = g.world, rng = g.rng;
    const cities = [...g.cities.values()];
    const camps = [...g.buildings.values()].filter((b) => b.type === 'camp');
    const cands = [];
    for (let k = 0; k < 600 && cands.length < 40; k++) {
      const t = rng.int(N);
      const ter = w.terr[t];
      if (w.river[t] || isWater(ter) || ter === T.PEAK || ter === T.LAVA || ter === T.MOUNTAIN || w.owner[t] >= 0 || g.tileB[t] >= 0) continue;
      if (cities.some((c) => dist(c.tile, t) < 13) || w.starts.some((s) => dist(s, t) < 16) || camps.some((c) => dist(c.tile, t) < 12)) continue;
      cands.push(t);
    }
    return cands;
  }

  newCamp(initial = false) {
    const g = this.g, w = g.world;
    // prefer re-occupying the ruins of a fallen town
    for (const [t, r] of g.ruins) {
      if (r.type !== 'town' || w.owner[t] >= 0 || w.river[t]) continue;
      g.ruins.delete(t);
      const c = g.foundCity(this.civ, t, 3);
      c.name = 'Free ' + (r.name || c.name);
      this.g.notify(-1, `Rebels have occupied the ruins of ${r.name || 'a fallen town'}.`, { kind: 'rebel', tile: t });
      return true;
    }
    const sites = this.campSites();
    if (!sites.length) return false;
    const t = sites[0];
    const b = g.makeBuilding(this.civ, 'camp', t, true);
    b.cityId = -1;
    for (let i = 0; i < (initial ? 2 : 1); i++) spawnUnit(g, this.civ, this.raiderType(), g.freeTilesNear(t, 1)[i] ?? t);
    if (!initial) g.geoEvent('rebel', t, 2, 'A Free Company has raised its banner in the wilds.');
    return true;
  }

  era() { return Math.max(0, Math.max(...this.g.civs.filter((c) => !c.isRebel && c.alive).map((c) => c.age)) - 1); }
  raiderType() { const opts = RAIDERS[Math.min(AGES.length - 1, this.era())]; return opts[this.g.rng.int(opts.length)]; }

  think() {
    const g = this.g, civ = this.civ;
    const camps = [...g.buildings.values()].filter((b) => b.owner === civ.id && (b.type === 'camp' || b.type === 'town'));
    const units = [...g.units.values()].filter((u) => u.owner === civ.id);
    // foraging keeps the companies fed
    civ.res.food = 200; civ.res.munitions = 100; civ.res.fuel = 100; civ.res.steel = 100;
    if (g.time > this.nextSpawn) {
      this.nextSpawn = g.time + 75 + g.rng() * 30;
      for (const c of camps) if (units.filter((u) => dist(u.tile, c.tile) < 10).length < 4) spawnUnit(g, civ, this.raiderType(), g.freeTilesNear(c.tile, 1)[0] ?? c.tile);
    }
    if (g.time > this.nextCamp) { this.nextCamp = g.time + 300 + g.rng() * 200; if (camps.length < 6) this.newCamp(); }
    // raid: look for weakly defended targets the companies can see
    if (!this.raid || !units.some((u) => u.order.kind !== 'idle')) this.raid = null;
    if (!this.raid && units.length >= 3 && g.time > 600) {          // no raids in the first ten minutes
      let best = null, bs = 0;
      for (const b of g.buildings.values()) {
        if (b.owner === civ.id || !civ.visible[b.tile] || !g.hostile(civ.id, b.owner) || b.type === 'town' || b.type === 'fort' || b.type === 'bunker') continue;
        const home = camps.reduce((m, c) => Math.min(m, dist(c.tile, b.tile)), 99); if (home > 14) continue;
        const guards = [...g.units.values()].filter((u) => u.owner === b.owner && !UNITS[u.type].civilian && dist(u.tile, b.tile) <= 4).length;
        const score = 10 - guards * 4 - home * 0.3;
        if (score > bs) { bs = score; best = b; }
      }
      if (best) {
        const party = units.filter((u) => !UNITS[u.type].civilian).slice(0, 5);
        this.raid = { target: best.id, since: g.time };
        g.command(civ.id, { c: 'move', units: party.map((u) => u.id), tile: best.tile, attackMove: true });
        g.notify(best.owner, 'Rebel raiders are moving on your territory!', { kind: 'warning', tile: best.tile });
      }
    }
    if (this.raid && g.time - this.raid.since > 120) {
      // fall back to camp after the raid
      const home = camps[0]; if (home) g.command(civ.id, { c: 'move', units: units.map((u) => u.id), tile: home.tile });
      this.raid = null;
    }
    // patrol around camps
    for (const u of units) {
      if (u.path.length || u.field || u.order.kind !== 'idle' || g.rng() > 0.15) continue;
      const c = camps.sort((a, b) => dist(a.tile, u.tile) - dist(b.tile, u.tile))[0]; if (!c) continue;
      const ring = disk(c.tile, 5).filter((t) => !isWater(w(g).terr[t]) && g.world.owner[t] < 0);
      if (ring.length) g.command(civ.id, { c: 'move', units: [u.id], tile: ring[g.rng.int(ring.length)] });
    }
  }
}
const w = (g) => g.world;
