// Painting a hand-authored map (mapCatalog.js) into a World: a deterministic heightfield built from
// shape primitives, explicit rivers with fords, and exact 180° symmetry. The game seed never touches
// the terrain: the same map is the same ground every time.
import { W, H, N } from './constants.js';
import { NB, idx, qOf, rOf } from './hex.js';
import { fbm } from './rng.js';
import { MAPS_BY_ID } from './mapCatalog.js';

export const MAP_SEED = 0x5eed;
const SQ3 = Math.sqrt(3);
const CX = SQ3 * (W - .5) / 2, CZ = 1.5 * (H - 1) / 2;
const XS = SQ3 * W, ZS = 1.5 * H;

export const authoredMap = (id) => (id && id !== 'random' && Object.hasOwn(MAPS_BY_ID, id) ? MAPS_BY_ID[id] : null);

// With an even number of rows the half-turn about (CX, CZ) maps every hex centre onto another hex centre.
export const mirrorTile = (t) => idx(W - 1 - qOf(t), H - 1 - rOf(t));
export const mirrorPoint = (p) => ({ x: 2 * CX - p.x, z: 2 * CZ - p.z });
export const mapPoint = ([u, v]) => ({ x: CX + (u - .5) * XS, z: CZ + (v - .5) * ZS });
const tileCenter = (t) => ({ x: SQ3 * (qOf(t) + .5 * (rOf(t) & 1)), z: 1.5 * rOf(t) });

function segDist(px, pz, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / l));
  return Math.hypot(px - a.x - dx * t, pz - a.z - dz * t);
}

// Signed distance (negative inside) from world point p to an op's shape, in world units.
function shapeOf(op, scale) {
  if (op.circle) { const c = mapPoint(op.circle), r = op.r * scale; return (x, z) => Math.hypot(x - c.x, z - c.z) - r; }
  if (op.ellipse) {
    const c = mapPoint(op.ellipse), rx = op.rx * scale, rz = op.rz * scale, s = Math.sin(op.rot || 0), k = Math.cos(op.rot || 0);
    return (x, z) => {
      const dx = x - c.x, dz = z - c.z, lx = dx * k + dz * s, lz = -dx * s + dz * k;
      const q = Math.hypot(lx / rx, lz / rz);
      return (q - 1) * Math.min(rx, rz);
    };
  }
  if (op.line) {
    const pts = op.line.map(mapPoint), w = op.w * scale;
    return (x, z) => { let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(x, z, pts[i - 1], pts[i])); return d - w; };
  }
  if (op.poly) {
    const pts = op.poly.map(mapPoint);
    return (x, z) => {
      let d = Infinity, inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], b = pts[j];
        d = Math.min(d, segDist(x, z, a, b));
        if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
      }
      return inside ? -d : d;
    };
  }
  throw new Error(`map op without a shape: ${JSON.stringify(op)}`);
}

const smooth = (t) => t * t * (3 - 2 * t);
const weight = (sd, soft) => (sd <= 0 ? 1 : soft <= 0 ? 0 : sd >= soft ? 0 : smooth(1 - sd / soft));

/** Paint the map `def` into world `w` (replacing World.generate). Rivers and lakes are authored. */
export function paintAuthoredWorld(w, def) {
  if (H % 2) throw new Error('Authored maps need an even number of rows.');
  const scale = W / def.size;
  const noise = def.noise || {}, ns = (noise.scale || 8) * scale;
  // symmetric scalar noise and antisymmetric warp: both survive the half-turn exactly
  const sym = (x, z, seed, k = ns, o = 4) => { const m = mirrorPoint({ x, z }); return (fbm(x / k, z / k, seed, o) + fbm(m.x / k, m.z / k, seed, o)) * .5 - .5; };
  const anti = (x, z, seed, k = ns) => { const m = mirrorPoint({ x, z }); return fbm(x / k, z / k, seed, 3) - fbm(m.x / k, m.z / k, seed, 3); };
  const ws = (noise.warpScale || noise.scale * 2 || 16) * scale, ms = (noise.moistScale || noise.scale || 8) * scale;
  const knolls = noise.knolls || null, ks = (knolls?.scale || 6) * scale;
  const warp = (noise.warp || 0) * scale;
  const shapes = def.ops.map((op) => (op.op === 'river' ? null : shapeOf(op, scale)));
  const border = (def.border || 5);
  w.style = def.style || 'continents';
  w.mapDef = def;
  for (let i = 0; i < N; i++) {
    const c = tileCenter(i);
    const wx = c.x + anti(c.x, c.z, MAP_SEED + 1, ws) * warp, wz = c.z + anti(c.x, c.z, MAP_SEED + 2, ws) * warp;
    const mx = 2 * CX - wx, mz = 2 * CZ - wz;
    let e = def.base.elev + sym(c.x, c.z, MAP_SEED + 3) * 2 * (noise.elev ?? .04);
    let moist = def.base.moist + sym(c.x, c.z, MAP_SEED + 4, ms) * 2 * (noise.moist ?? .08);
    // scattered knolls: low hills (cover) wherever the noise peaks
    if (knolls) e += Math.min(knolls.max ?? .2, Math.max(0, sym(c.x, c.z, MAP_SEED + 6, ks, 2) - (knolls.above ?? .1)) * knolls.amp);
    for (let k = 0; k < def.ops.length; k++) {
      const op = def.ops[k], sd = shapes[k];
      if (!sd) continue;
      const d = Math.min(sd(wx, wz), sd(mx, mz)), soft = (op.soft ?? 2) * scale;
      if (op.op === 'ridge') {
        const width = op.w * scale, reach = d + width;      // distance to the crest line
        if (reach >= width + soft) continue;
        const crest = op.h + sym(c.x, c.z, MAP_SEED + 5) * .12;
        const v = reach <= width ? .3 + (crest - .3) * smooth(1 - reach / width) : .3 * weight(reach - width, soft);
        e = Math.max(e, v);
        continue;
      }
      const a = weight(d, soft);
      if (!a) continue;
      if (op.op === 'moist') { moist += (op.value - moist) * a; continue; }
      const target = e + (op.value - e) * a;
      e = op.mode === 'max' ? Math.max(e, target) : op.mode === 'min' ? Math.min(e, target) : target;
    }
    // bounded battlefields end in open sea that meets the client's ocean
    const edge = Math.min(qOf(i), W - 1 - qOf(i), rOf(i), H - 1 - rOf(i));
    const coast = edge < border + 3 ? 1 - Math.max(0, edge - 1) / (border + 2) : 0;
    if (coast > 0) e = Math.min(e, e - (e + .45) * smooth(Math.min(1, coast)) );
    if (edge < border - 1) e = Math.min(e, -.3);
    w.elev[i] = e;
    w.moist[i] = Math.max(.3, Math.min(.85, moist));
    w.temp[i] = .62;
    w.stab[i] = 1; w.rate[i] = 0; w.plate[i] = 0;
    w.river[i] = 0; w.lake[i] = 0; w.flow[i] = 0; w.flowDir[i] = -1; w.res[i] = 0; w.soil[i] = 0;
  }
  // Relax the lowland and hill slopes (Jacobi passes, so the half-turn symmetry holds): noise and
  // soft shape edges must not leave cliffs a vehicle cannot climb. Mountains and the sea keep their edges.
  for (let pass = 0; pass < (def.relax ?? 2); pass++) {
    const next = Float32Array.from(w.elev);
    for (let i = 0; i < N; i++) {
      const e = w.elev[i]; if (e < 0 || e > .54) continue;
      let sum = e * 2, n = 2;
      for (let d = 0; d < 6; d++) { const m = NB[i * 6 + d]; if (m >= 0 && w.elev[m] >= 0 && w.elev[m] <= .54) { sum += w.elev[m]; n++; } }
      next[i] = sum / n;
    }
    w.elev.set(next);
  }
  return w;
}

// Pointy-top hex containing a world point (the same rounding as actionNavigation.tileAt, bounded).
export function tileAt(x, z) {
  const q = x / SQ3 - z / 3, r = z * 2 / 3, s = -q - r;
  let a = Math.round(q), b = Math.round(r);
  const c = Math.round(s), dq = Math.abs(a - q), dr = Math.abs(b - r), ds = Math.abs(c - s);
  if (dq > dr && dq > ds) a = -b - c;
  else if (dr > ds) b = -a - c;
  if (b < 0 || b >= H) return -1;
  a += (b - (b & 1)) >> 1;
  return a >= 0 && a < W ? b * W + a : -1;
}
const tileOf = (at) => { const p = mapPoint(at); return tileAt(p.x, p.z); };

/** The authored site list resolved to tiles: team 0's sites (their rotated twins are implied), then centre sites. */
export function siteTiles(def) {
  return { half: def.sites.filter((s) => !s.center).map((s) => ({ ...s, tile: tileOf(s.at) })),
    center: def.sites.filter((s) => s.center).map((s) => ({ ...s, tile: tileOf(s.at) })) };
}
export { tileOf };

/** World.generate for an authored map: terrain, site pads, rivers, classification. */
export function generateAuthored(w, def) {
  paintAuthoredWorld(w, def);
  const scale = W / def.size;
  const { half, center } = siteTiles(def);
  for (const s of [...half, ...center]) padSite(w, s.tile, 5.2 * Math.min(1, scale), s.pad ?? null);
  w.rivers = [];
  for (const op of def.ops) if (op.op === 'river') w.rivers.push(paintRiver(w, op, tileAt, scale));
  classifyAll(w);
  w.wiped.clear(); w.dirty.clear();
  w.volcanoes = []; w.riftTiles = []; w.faultTiles = [];
  w.starts = [];
  w.fairness = [];
  return w;
}

/** Flatten a pad for a city ruin (and its mirror): level ground, open fields, no rivers. */
export function padSite(w, tile, radius = 5.2, height = null) {
  const c = tileCenter(tile);
  const level = height ?? Math.max(.08, Math.min(.24, w.elev[tile]));
  for (const t of [tile, mirrorTile(tile)]) {
    const o = t === tile ? c : mirrorPoint(c);
    for (let i = 0; i < N; i++) {
      const p = tileCenter(i), d = Math.hypot(p.x - o.x, p.z - o.z);
      if (d > radius + 3) continue;
      const a = d <= radius ? 1 : smooth(1 - (d - radius) / 3);
      w.elev[i] += (level - w.elev[i]) * a;
      if (d <= radius) w.moist[i] = Math.min(w.moist[i], .46);
    }
  }
}

function catmull(pts, step = .35) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => .5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const dirTo = (a, b) => { for (let d = 0; d < 6; d++) if (NB[a * 6 + d] === b) return d; return -1; };

/**
 * Trace an authored river source → mouth onto the hex grid (and its rotated twin). Flow grows along
 * the course; fords are shallow, narrow reaches every class can wade. The bed is carved into the
 * terrain and the course ends where it meets open water.
 */
export function paintRiver(w, op, tileAt, scale) {
  const curve = catmull(op.path.map(mapPoint));
  const course = [];
  for (const p of curve) {
    const t = tileAt(p.x, p.z);
    if (t < 0 || t === course[course.length - 1]) continue;
    const prev = course[course.length - 1];
    if (prev !== undefined && dirTo(prev, t) < 0) {
      // bridge a diagonal step through the neighbour closer to the curve
      let best = -1, bd = Infinity;
      for (let d = 0; d < 6; d++) {
        const n = NB[prev * 6 + d]; if (n < 0 || dirTo(n, t) < 0) continue;
        const c = tileCenter(n), dd = Math.hypot(c.x - p.x, c.z - p.z);
        if (dd < bd) { bd = dd; best = n; }
      }
      if (best < 0) continue;
      course.push(best);
    }
    course.push(t);
  }
  // stop at the first open water: the river drains into it
  let end = course.findIndex((t) => w.elev[t] < 0);
  if (end < 0) throw new Error(`river in ${w.mapDef?.id} does not reach open water`);
  const fords = (op.fords || []).map(mapPoint);
  const [f0, f1] = op.flow || [60, 160];
  const tiles = course.slice(0, end + 1);
  for (const [list, mirrored] of [[tiles, false], [tiles.map(mirrorTile), true]]) {
    for (let i = 0; i < list.length - 1; i++) {
      const t = list[i], c = tileCenter(t), o = mirrored ? mirrorPoint(c) : c;
      const ford = fords.some((f) => Math.hypot(f.x - o.x, f.z - o.z) < 1.9 * scale);
      w.river[t] = 1;
      w.flow[t] = ford ? Math.min(80, f0 + 10) : f0 + (f1 - f0) * (i / Math.max(1, list.length - 2));
      w.flowDir[t] = dirTo(t, list[i + 1]);
      w.elev[t] = Math.max(.02, Math.min(w.elev[t], ford ? .07 : .09));
      w.moist[t] = Math.min(w.moist[t], .5);
      // gentle banks: the valley floor falls toward the water
      for (let d = 0; d < 6; d++) {
        const n = NB[t * 6 + d];
        if (n < 0 || w.elev[n] < 0 || list.includes(n)) continue;
        w.elev[n] = Math.min(w.elev[n], Math.max(.12, w.elev[t] + .06), w.elev[n] * .6 + .1 * .4);
      }
    }
  }
  return tiles;
}

export function classifyAll(w) { for (let i = 0; i < N; i++) { w.terr[i] = 255; w.classify(i); } }
