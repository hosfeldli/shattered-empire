// Server-side terrain shading. Clients receive a final RGB per tile so they never
// need elevation fields, normals or palette logic: the cloud does the lighting.
import { TERRAIN, T, W } from './constants.js';
import { NB, qOf, rOf } from './hex.js';
import { hash2 } from './rng.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function tileColor(w, i) {
  const t = w.terr[i];
  let [r, g, b] = TERRAIN[t].color;
  const e = w.elev[i];
  if (t === T.DEEP || t === T.SHALLOW) {
    const depth = clamp(-e, 0, 0.6);
    const k = 1 - depth * 0.9;
    r *= k; g *= k; b *= 0.85 + 0.15 * k;
    if (w.lake[i]) { r = 52; g = 112; b = 150; }
  } else {
    // hillshade: light from the north-west
    const nw = NB[i * 6 + 2], se = NB[i * 6 + 5], wv = NB[i * 6 + 3], ev = NB[i * 6 + 0];
    const gx = (wv >= 0 ? w.elev[wv] : e) - (ev >= 0 ? w.elev[ev] : e);
    const gy = (nw >= 0 ? w.elev[nw] : e) - (se >= 0 ? w.elev[se] : e);
    const shade = clamp(1 + (gx + gy) * 2.4, 0.62, 1.35);
    const lift = clamp(e * 0.35, 0, 0.25);
    r = r * shade + 255 * lift * 0.25; g = g * shade + 255 * lift * 0.22; b = b * shade + 255 * lift * 0.2;
    if (t === T.GRASS || t === T.PLAINS || t === T.FOREST) {
      const m = w.moist[i] - 0.5;
      g += m * 30; r -= m * 20;
    }
    if (w.ash[i] > 0) { r = r * 0.6 + 40; g = g * 0.6 + 38; b = b * 0.6 + 36; }
    if (w.drought[i] > 0) { r = r * 0.85 + 34; g = g * 0.8 + 22; b *= 0.75; }
    if (t === T.LAVA) { const p = hash2(qOf(i), rOf(i), 5); r = 200 + p * 55; g = 50 + p * 70; b = 20; }
  }
  const n = (hash2(qOf(i), rOf(i), w.seed) - 0.5) * 14;
  r = clamp(Math.round(r + n), 0, 255); g = clamp(Math.round(g + n), 0, 255); b = clamp(Math.round(b + n), 0, 255);
  return (r << 16) | (g << 8) | b;
}

// Compact per-tile record sent to clients:
// [index, terrain, colorRGB, resource, roadEdges(packed 6x4 bits), river|lake<<1|soil<<2|ruin<<3|drought<<4|ash<<5, flowDir, flowBucket, owner, stability(0-100 or -1)]
export function tileRecord(w, i, showStability, roadsPacked = 0, ruin = 0) {
  const fb = w.river[i] ? Math.min(4, Math.floor(Math.log2(Math.max(1, w.flow[i] / 42))) + 1) : 0;
  return [
    i, w.terr[i], tileColor(w, i), w.res[i], roadsPacked,
    w.river[i] | (w.lake[i] << 1) | (w.soil[i] << 2) | (ruin ? 8 : 0) | (w.drought[i] > 0 ? 16 : 0) | (w.ash[i] > 0 ? 32 : 0),
    w.flowDir[i], fb, w.owner[i],
    showStability ? Math.round(w.stab[i] * 100) : -1,
  ];
}
export const MAP_W = W;
