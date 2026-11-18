// Height-aware blast propagation (effects pass, 2026-11-18; docs/gameplay-overhaul/EFFECTS.md).
//
// A ground shock front is modelled as N rays marched outward from the burst over the terrain height field.
// Each ray carries energy E (starts at E0): every unit of distance costs 1/reach (so on level ground it dies
// at `reach`), every unit of height climbed costs `up`, every unit descended refunds `down` (never above E0).
// So a front climbing a mountain side dies quickly, one running down a valley floor carries on, and energy
// lost on a ridge stays lost behind it. Channelling: a first pass measures how much of the front the terrain
// blocks; the blocked share is pushed into the open directions (E0 = 1 + channel * blocked, at most `boost`),
// so a burst in a valley runs much farther both ways down it than on open ground. The rays are then smoothed
// across their neighbours. The Unity client runs the same algorithm (EffectsRenderer.TerrainShock.cs) on its
// own height field to draw the volumetric front; the trees that actually fall come from here.
//
// Gameplay (blastForest): a strategic warhead flattens EVERY forest hex within SHOCK.core of the burst and
// knocks forest down beyond it with a chance that grows with the energy the front still carries there
// (more on open ground and down valleys, little behind ridges). Clearing goes through battlefield.clearForest,
// so it is permanent (terr / moist are saved world arrays), replicated (world.touch) and re-navigated
// (forestNavDirty, batched by battlefieldStep at most every FOREST_CLEAR.navEvery seconds). Deterministic:
// heights from world.elev, chance from a tile hash, never game.rng.
import { T } from './constants.js';
import { clearForest } from './battlefield.js';
import { disk } from './hex.js';
import { TILE_X, TILE_Z, dxBetween, tileAt, wrapX } from './actionNavigation.js';

export const SHOCK = Object.freeze({
  rays: 48, step: 0.5, reach: 16, up: 0.45, down: 0.12, channel: 0.8, boost: 1.7,
  core: 4.5,               // world units: every forest hex inside is flattened (MISSILE_PROJECT.radius is 2.7)
  knock: [0.12, 0.6],      // beyond the core, the fall chance ramps from 0 to 1 over this energy band
});
// Conventional heavy blasts (bombs, missiles, bombardment) may fell the forest on the hex they hit.
export const BLAST_TREES = Object.freeze({ radius: 0.9, chance: 0.1, heavy: 1.2, heavyChance: 0.3 });

/** Terrain height (client world units) the shock climbs: the client's TileHeightFromGeo for land, sea level 0. */
export function shockHeight(elev) {
  if (!(elev > 0)) return 0;
  const relief = Math.max(elev - 0.32, 0);
  return elev * 3.2 + relief * relief * 6;
}

function march(field, heightAt, x0, z0, e0) {
  const { rays, steps, step, R, energy, reach } = field, s = field.scale;
  const h0 = Math.max(0, heightAt(x0, z0));
  for (let i = 0; i < rays; i++) {
    const a = i * 2 * Math.PI / rays, ca = Math.cos(a), sa = Math.sin(a);
    let e = e0, h = h0;
    reach[i] = steps * step;
    for (let k = 0; k < steps; k++) {
      const d = (k + 1) * step;
      let hn = heightAt(x0 + ca * d, z0 + sa * d);
      hn = Number.isFinite(hn) ? Math.max(0, hn) : h;
      const dh = hn - h; h = hn;
      e -= step / R;
      if (dh > 0) e -= SHOCK.up * dh / s; else e = Math.min(e0, e - SHOCK.down * dh / s);
      if (e <= 0) { for (let j = k; j < steps; j++) energy[i * steps + j] = 0; reach[i] = d; break; }
      energy[i * steps + k] = e;
    }
  }
}

/**
 * The shock field of a burst at (x0, z0): per ray, the energy at each step and the distance it dies at.
 * heightAt(x, z) returns terrain height in client world units. scale 1 = a strategic warhead.
 */
export function shockField(heightAt, x0, z0, scale = 1) {
  const rays = SHOCK.rays, step = SHOCK.step * scale, R = SHOCK.reach * scale;
  const steps = Math.ceil(R * SHOCK.boost / step);
  const field = { x: x0, z: z0, scale, rays, steps, step, R, e0: 1, energy: new Float32Array(rays * steps), reach: new Float32Array(rays) };
  march(field, heightAt, x0, z0, 1);
  let open = 0;
  for (let i = 0; i < rays; i++) open += Math.min(field.reach[i], R) / R;
  const blocked = 1 - open / rays;
  field.e0 = Math.min(SHOCK.boost, 1 + SHOCK.channel * blocked);
  march(field, heightAt, x0, z0, field.e0);
  // one 1-2-1 pass across neighbouring rays, so the front has no single-ray spikes
  const src = field.energy.slice(), e = field.energy;
  for (let i = 0; i < rays; i++) {
    const l = (i + rays - 1) % rays, r = (i + 1) % rays;
    let last = -1;
    for (let k = 0; k < steps; k++) {
      const v = src[l * steps + k] * .25 + src[i * steps + k] * .5 + src[r * steps + k] * .25;
      e[i * steps + k] = v;
      if (v > 0) last = k;
    }
    field.reach[i] = (last + 1) * step;
  }
  return field;
}

/** Energy the front carries at distance d in direction angle (radians, atan2(dz, dx)). */
export function shockEnergy(field, angle, d) {
  const { rays, steps, step, energy } = field;
  if (d <= step) return field.e0;
  let f = angle / (2 * Math.PI) * rays; f = ((f % rays) + rays) % rays;
  const i0 = Math.floor(f) % rays, i1 = (i0 + 1) % rays, fr = f - Math.floor(f);
  const g = d / step - 1, k0 = Math.floor(g), kr = g - k0;
  if (k0 >= steps - 1) return 0;
  const at = (i, k) => energy[i * steps + k];
  const a = at(i0, k0) * (1 - kr) + at(i0, k0 + 1) * kr, b = at(i1, k0) * (1 - kr) + at(i1, k0 + 1) * kr;
  return a * (1 - fr) + b * fr;
}

const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Deterministic per-hex roll in [0, 1) (no game RNG: blasts must not shift the match's random stream). */
export function treeRoll(t, salt) {
  let h = Math.imul(t ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt | 0, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The server's height field for the shock: hex elevation mapped like the client's terrain. */
export function worldHeightAt(world) {
  return (x, z) => { const t = tileAt(wrapX(x), z); return t < 0 ? NaN : shockHeight(world.elev[t]); };
}

/**
 * A strategic burst at (x, z): flattens every forest hex in the core and knocks forest down along the
 * height-aware front. Returns the number of hexes cleared.
 */
export function blastForest(g, x, z, scale = 1) {
  const w = g.world, center = tileAt(wrapX(x), z);
  if (center < 0) return 0;
  const field = shockField(worldHeightAt(w), x, z, scale);
  const far = field.steps * field.step, core = SHOCK.core * scale;
  const salt = Math.round(x * 97) ^ Math.round(z * 131);
  let cleared = 0;
  for (const t of disk(center, Math.ceil(far / 1.5) + 1)) {
    if (w.terr[t] !== T.FOREST) continue;
    const dx = dxBetween(x, TILE_X[t]), dz = TILE_Z[t] - z, d = Math.hypot(dx, dz);
    if (d > far) continue;
    const fall = d <= core ? 1 : smooth(SHOCK.knock[0], SHOCK.knock[1], shockEnergy(field, Math.atan2(dz, dx), d));
    if (fall > 0 && (fall >= 1 || treeRoll(t, salt) < fall) && clearForest(g, t)) cleared++;
  }
  return cleared;
}

/** A heavy conventional blast of radius r on hex t may fell its forest (bombs more often). */
export function blastTrees(g, t, r, x = 0, z = 0) {
  if (t < 0 || g.world.terr[t] !== T.FOREST || r < BLAST_TREES.radius) return false;
  const chance = r >= BLAST_TREES.heavy ? BLAST_TREES.heavyChance : BLAST_TREES.chance;
  return treeRoll(t, (g.tickN | 0) * 31 + Math.round(x * 53) + Math.round(z * 71)) < chance && clearForest(g, t);
}
