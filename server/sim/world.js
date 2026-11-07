// Continental world: generation, terrain classification and hydrology.
import { W, H, N, T, RES, TERRAIN, isWater } from './constants.js';
import { NB, idx, qOf, rOf, dist, disk, WRAP, dqWrap } from './hex.js';
import { mulberry32, fbm, hash2 } from './rng.js';

export const RIVER_FLOW = 42;
export const WORLD_STYLES = { continents: { plates: 11, land: 0.42, cont: 0.45 }, pangaea: { plates: 8, land: 0.55, cont: 0.7 }, archipelago: { plates: 18, land: 0.34, cont: 0.4 }, inlandSea: { plates: 10, land: 0.56, cont: 0.75 } };

// Noise that tiles horizontally: two copies one world-width apart, cross-faded, so the seam
// between the last and first column is invisible (and so are rivers and coasts that cross it).
export function pfbm(q, r, scale, seed, octaves = 5) {
  if (!WRAP) return fbm(q / scale, r / scale, seed, octaves);
  const t = (((q % W) + W) % W) / W;
  return fbm(q / scale, r / scale, seed, octaves) * (1 - t) + fbm((q - W) / scale, r / scale, seed, octaves) * t;
}

export class World {
  constructor(seed, opts = {}) {
    this.seed = seed;
    this.opts = opts;
    this.rng = mulberry32(seed);
    this.elev = new Float32Array(N);      // < 0 is sea
    this.stab = new Float32Array(N);      // structural stability 0..1
    this.moist = new Float32Array(N);
    this.temp = new Float32Array(N);
    this.rate = new Float32Array(N);      // tectonic uplift(+)/subsidence(-) per second
    this.stress = new Float32Array(N);    // accumulated seismic stress
    this.plate = new Uint8Array(N);
    this.terr = new Uint8Array(N);
    this.res = new Uint8Array(N);
    this.river = new Uint8Array(N);       // 1 = river tile
    this.lake = new Uint8Array(N);
    this.flowDir = new Int8Array(N).fill(-1);
    this.flow = new Float32Array(N);
    this.road = new Uint8Array(N);        // 1 road/bridge, 2 rail
    this.soil = new Uint8Array(N);        // 1 = volcanic soil
    this.lava = new Float32Array(N);      // seconds of molten lava remaining
    this.ash = new Float32Array(N);       // seconds of ashfall remaining (farm penalty)
    this.drought = new Float32Array(N);   // seconds of drought remaining
    this.owner = new Int8Array(N).fill(-1);
    this.ver = new Uint16Array(N).fill(1);
    this.dirty = new Set();
    this.wiped = new Set();               // tiles whose roads must be obliterated (consumed by Game)
    this.volcanoes = [];
    this.riftTiles = [];
    this.faultTiles = [];
  }

  touch(i) { this.ver[i] = (this.ver[i] + 1) & 0xffff || 1; this.dirty.add(i); }

  generate(nCivs) {
    const rng = this.rng, seed = this.seed;
    // --- Tectonic plates (warped Voronoi)
    const styleKeys = Object.keys(WORLD_STYLES);
    this.style = WORLD_STYLES[this.opts.style] ? this.opts.style : styleKeys[Math.floor(rng() * styleKeys.length)];
    const ST = WORLD_STYLES[this.style];
    const P = ST.plates;
    const plates = [];
    for (let p = 0; p < P; p++) {
      const q = WRAP ? rng.range(0, W) : rng.range(6, W - 6), r = rng.range(6, H - 6);
      const lat = Math.abs(r / H - 0.5) * 2;
      let cont = rng() < ST.cont * (1.15 - lat * 0.5);
      if (!WRAP) { const dc = Math.hypot((q - W / 2) / W, (r - H / 2) / H); cont = dc < 0.33 ? rng() < 0.85 : rng() < 0.25; }
      plates.push({ q, r, cont, vx: rng.range(-1, 1), vy: rng.range(-1, 1) });
    }
    // an inland sea: the plate nearest the middle of the land is drowned
    if (this.style === 'inlandSea') { const mid = plates.reduce((b, p) => (Math.abs(p.r - H / 2) < Math.abs(b.r - H / 2) ? p : b), plates[0]); mid.cont = false; mid.sea = true; }
    if (!plates.some((p) => p.cont)) plates[0].cont = true;
    this.plates = plates;
    for (let i = 0; i < N; i++) {
      const q = qOf(i) + (pfbm(qOf(i), rOf(i), 22, seed + 7) - 0.5) * 26;
      const r = rOf(i) + (pfbm(qOf(i), rOf(i), 22, seed + 11) - 0.5) * 26;
      let best = 0, bd = Infinity;
      for (let p = 0; p < P; p++) { const dq = WRAP ? dqWrap(plates[p].q, q) : q - plates[p].q; const d = dq ** 2 + (r - plates[p].r) ** 2; if (d < bd) { bd = d; best = p; } }
      this.plate[i] = best;
    }
    // --- Boundary interaction strength (convergent > 0, divergent < 0)
    const bound = new Float32Array(N);
    const isB = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const a = plates[this.plate[i]];
      for (let d = 0; d < 6; d++) {
        const n = NB[i * 6 + d]; if (n < 0) continue;
        if (this.plate[n] === this.plate[i]) continue;
        const b = plates[this.plate[n]];
        const nx = dqWrap(qOf(i), qOf(n)), ny = rOf(n) - rOf(i), len = Math.hypot(nx, ny) || 1;
        const rel = ((a.vx - b.vx) * nx + (a.vy - b.vy) * ny) / len;
        if (Math.abs(rel) > Math.abs(bound[i])) bound[i] = rel;
        isB[i] = 1;
      }
    }
    // spread boundary effect with BFS distance
    const bdist = new Float32Array(N).fill(99), bval = new Float32Array(N);
    const queue = [];
    for (let i = 0; i < N; i++) if (isB[i]) { bdist[i] = 0; bval[i] = bound[i]; queue.push(i); }
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h]; if (bdist[i] >= 6) continue;
      for (let d = 0; d < 6; d++) {
        const n = NB[i * 6 + d]; if (n < 0 || bdist[n] <= bdist[i] + 1) continue;
        bdist[n] = bdist[i] + 1; bval[n] = bval[i]; queue.push(n);
      }
    }
    // --- Elevation
    for (let i = 0; i < N; i++) {
      const q = qOf(i), r = rOf(i);
      const nx = (q - W / 2) / (W / 2), ny = (r - H / 2) / (H / 2);
      // a cylinder has no east/west edge: only the polar seas fall away
      const falloff = WRAP ? 1 - Math.pow(Math.abs(ny) * 1.08, 3) : 1 - Math.pow(Math.hypot(nx * 0.95, ny * 1.05), 2.2);
      const pl = plates[this.plate[i]];
      let e = (pl.cont ? 0.12 : -0.18) + (pfbm(q, r, 28, seed + 3) - 0.5) * 0.7 + falloff * 0.42 - 0.17;
      e += (pfbm(q, r, 7, seed + 5) - 0.5) * 0.14;
      const f = Math.exp(-bdist[i] / 2.2);
      const v = bval[i];
      if (v > 0) e += Math.min(0.75, v * 0.55) * f * (pl.cont ? 1 : 0.6);
      else e += v * 0.18 * f;
      this.elev[i] = e;
      this.stab[i] = Math.max(0.05, Math.min(1, 1 - 0.8 * f * Math.min(1, Math.abs(v) + 0.25) + (pfbm(q, r, 9, seed + 9) - 0.5) * 0.25));
      this.rate[i] = v > 0 ? 0.00011 * f * Math.min(1.5, v) : v * 0.00004 * f;
      if (bdist[i] <= 1 && Math.abs(v) > 0.25) this.faultTiles.push(i);
    }
    // two smoothing passes: without an island falloff, near-sea-level land would otherwise
    // leave one-hex slivers along every coast
    if (WRAP) for (let pass = 0; pass < 2; pass++) {
      const e2 = new Float32Array(N);
      for (let i = 0; i < N; i++) { let s2 = this.elev[i] * 2, n2 = 2; for (let d = 0; d < 6; d++) { const n = NB[i * 6 + d]; if (n >= 0) { s2 += this.elev[n]; n2++; } } e2[i] = s2 / n2; }
      this.elev.set(e2);
    }
    // sea level by land fraction, so every style gets the coastline it promises
    if (WRAP) {
      const sorted = Float32Array.from(this.elev).sort();
      const sea = sorted[Math.floor(N * (1 - ST.land))];
      for (let i = 0; i < N; i++) { this.elev[i] -= sea; if (plates[this.plate[i]].sea) this.elev[i] = Math.min(this.elev[i], -0.15); }
    }
    // --- The Great Rift: a subsiding fracture through the continent, leaving an isthmus.
    this.makeRift(rng);
    // --- Climate
    const waterDist = this.distanceToWater();
    // westerly winds carry sea moisture east; mountains wring it out (rain shadows behind ranges)
    const humid = new Float32Array(N);
    if (WRAP && !globalThis.SE_NO_SHADOW) for (let r = 0; r < H; r++) {
      let h = 0.6;
      for (let lap = 0; lap < 2; lap++) for (let q = 0; q < W; q++) {
        const i = r * W + q, e = this.elev[i];
        if (e < 0) h = Math.min(1, h + 0.12); else { h *= e > 0.55 ? 0.7 : e > 0.35 ? 0.9 : 0.985; }
        if (lap) humid[i] = h;
      }
    } else humid.fill(0.6);
    for (let i = 0; i < N; i++) {
      const q = qOf(i), r = rOf(i);
      this.moist[i] = Math.max(0, Math.min(1, pfbm(q, r, 18, seed + 21) * 0.7 + 0.3 * humid[i] + 0.3 * Math.exp(-waterDist[i] / 7) - 0.1));
      // latitude: warm at the equator (mid-map), cold toward both poles
      const lat = WRAP ? 1 - Math.abs(r / H - 0.5) * 2 : r / H;
      this.temp[i] = 0.15 + 0.8 * lat - Math.max(0, this.elev[i]) * 0.45 + (pfbm(q, r, 30, seed + 31) - 0.5) * 0.3;
    }
    this.recomputeHydrology(true);
    for (let i = 0; i < N; i++) this.classify(i);
    this.placeVolcanoes(rng);
    this.placeResources(rng);
    this.starts = this.pickStarts(nCivs, rng);
    this.moveRiverResources();
    this.dirty.clear();
  }

  makeRift(rng) {
    // walk from one coast across ~70% of the continent
    const horizontal = rng() < 0.5;
    let pos = horizontal ? [4, H * rng.range(0.38, 0.62)] : [W * rng.range(0.38, 0.62), 4];
    let ang = horizontal ? rng.range(-0.25, 0.25) : Math.PI / 2 + rng.range(-0.25, 0.25);
    const len = (horizontal ? W : H) * rng.range(0.62, 0.74);
    const flip = rng() < 0.5;
    const seen = new Set();
    for (let s = 0; s < len; s++) {
      ang += rng.range(-0.18, 0.18);
      pos = [pos[0] + Math.cos(ang), pos[1] + Math.sin(ang)];
      let q = Math.round(pos[0]), r = Math.round(pos[1]);
      if (flip) { if (horizontal) q = W - 1 - q; else r = H - 1 - r; }
      if (r < 0 || r >= H || (!WRAP && (q < 0 || q >= W))) break;
      for (const t of disk(idx(q, r), 1)) {
        if (seen.has(t)) continue; seen.add(t);
        const core = t === idx(q, r);
        this.elev[t] = Math.min(this.elev[t], 0.16 + (core ? 0 : 0.06));
        this.rate[t] = core ? -0.00026 : -0.00018;
        this.stab[t] = Math.min(this.stab[t], core ? 0.12 : 0.22);
        this.riftTiles.push(t);
        if (core) this.faultTiles.push(t);
      }
    }
  }

  distanceToWater() {
    const d = new Float32Array(N).fill(1e9), q = [];
    for (let i = 0; i < N; i++) if (this.elev[i] < 0) { d[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (let k = 0; k < 6; k++) { const n = NB[i * 6 + k]; if (n >= 0 && d[n] > d[i] + 1) { d[n] = d[i] + 1; q.push(n); } }
    }
    return d;
  }

  // Priority-flood depression filling + D6 flow routing + accumulation.
  // Returns array of tiles whose river/lake status changed.
  recomputeHydrology(initial = false) {
    const filled = new Float32Array(N);
    const done = new Uint8Array(N);
    const heap = new MinHeap();
    for (let i = 0; i < N; i++) {
      const edge = rOf(i) === 0 || rOf(i) === H - 1 || (!WRAP && (qOf(i) === 0 || qOf(i) === W - 1));
      if (this.elev[i] < 0 || edge) { filled[i] = this.elev[i]; done[i] = 1; heap.push(i, filled[i]); }
    }
    const order = [];
    const dir = this.flowDir; dir.fill(-1);
    while (heap.size) {
      const i = heap.pop(); order.push(i);
      for (let k = 0; k < 6; k++) {
        const n = NB[i * 6 + k]; if (n < 0 || done[n]) continue;
        done[n] = 1;
        filled[n] = Math.max(this.elev[n], filled[i] + 1e-5);
        dir[n] = (k + 3) % 6; // n flows toward i
        heap.push(n, filled[n]);
      }
    }
    const flow = this.flow;
    for (let i = 0; i < N; i++) flow[i] = this.elev[i] < 0 ? 0 : (0.45 + this.moist[i]) * (this.drought[i] > 0 ? 0.25 : 1);
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k];
      if (dir[i] < 0) continue;
      const d = NB[i * 6 + dir[i]]; if (d >= 0) flow[d] += flow[i];
    }
    const changed = [];
    for (let i = 0; i < N; i++) {
      const land = this.elev[i] >= 0;
      const lake = land && filled[i] - this.elev[i] > 0.045 && flow[i] > 8 ? 1 : 0;
      const riv = land && !lake && flow[i] > RIVER_FLOW ? 1 : 0;
      if (riv !== this.river[i] || lake !== this.lake[i]) {
        this.river[i] = riv; this.lake[i] = lake;
        if (!initial) changed.push(i);
      }
    }
    return changed;
  }

  classify(i) {
    const e = this.elev[i];
    let t;
    if (this.lava[i] > 0) t = T.LAVA;
    else if (e < -0.12) t = T.DEEP;
    else if (e < 0 || this.lake[i]) t = T.SHALLOW;
    else if (e > 0.74) t = T.PEAK;
    else if (e > 0.52) t = T.MOUNTAIN;
    else if (e > 0.34) t = T.HILLS;
    else if (this.soil[i]) t = T.ASH;
    else {
      const m = this.moist[i], tp = this.temp[i];
      if (tp < 0.24) t = T.TUNDRA;
      else if (m < 0.27 && tp > 0.5) t = T.DESERT;
      else if (m > 0.7 && e < 0.08) t = T.MARSH;
      else if (m > 0.53) t = T.FOREST;
      else if (m > 0.38) t = T.GRASS;
      else t = T.PLAINS;
    }
    if (t !== this.terr[i]) {
      const was = this.terr[i];
      this.terr[i] = t;
      if (isWater(t) && this.res[i] !== RES.FISH) this.res[i] = RES.NONE;
      if (!isWater(t) && this.res[i] === RES.FISH) this.res[i] = RES.NONE;
      if ((isWater(t) && !isWater(was)) || t === T.PEAK || t === T.LAVA) this.wiped.add(i); // roads here are destroyed
      return true;
    }
    return false;
  }

  placeVolcanoes(rng) {
    const cands = [];
    for (const i of this.faultTiles) {
      if (this.elev[i] > 0.3 && this.rate[i] > 0) cands.push(i);
    }
    const want = 3 + rng.int(2);
    for (let k = 0; k < 400 && this.volcanoes.length < want && cands.length; k++) {
      const i = rng.pick(cands);
      if (this.volcanoes.some((v) => dist(v.tile, i) < 22)) continue;
      this.volcanoes.push({ tile: i, pressure: rng.range(0.1, 0.4), rate: rng.range(0.0011, 0.0019), erupting: 0 });
      this.elev[i] = Math.max(this.elev[i], 0.8);
      this.stab[i] = 0.05;
      this.classify(i);
    }
  }

  placeResources(rng) {
    for (let i = 0; i < N; i++) {
      const t = this.terr[i], y = rng();
      let r = RES.NONE;
      if (t === T.MOUNTAIN) { if (y < 0.08) r = RES.IRON; else if (y < 0.12) r = RES.RARE; else if (y < 0.17) r = RES.STONE; else if (y < 0.2) r = RES.COAL; }
      else if (t === T.HILLS) { if (y < 0.07) r = RES.IRON; else if (y < 0.13) r = RES.COAL; else if (y < 0.18) r = RES.STONE; else if (y < 0.19) r = RES.RARE; }
      else if (t === T.FOREST) { if (y < 0.03) r = RES.COAL; else if (y < 0.045) r = RES.RUINS; }
      else if (t === T.MARSH || t === T.TUNDRA) { if (y < 0.05) r = RES.OIL; else if (y < 0.07) r = RES.COAL; }
      else if (t === T.DESERT) { if (y < 0.06) r = RES.OIL; else if (y < 0.09) r = RES.RUINS; else if (y < 0.1) r = RES.RARE; }
      else if (t === T.GRASS || t === T.PLAINS) { if (y < 0.03) r = RES.RUINS; else if (y < 0.04) r = RES.OIL; else if (y < 0.045) r = RES.STONE; }
      else if (t === T.SHALLOW && !this.lake[i]) {
        let coast = false; for (let k = 0; k < 6; k++) { const n = NB[i * 6 + k]; if (n >= 0 && this.elev[n] >= 0) coast = true; }
        if (coast && y < 0.08) r = RES.FISH;
      }
      this.res[i] = r;
    }
  }

  // Keep the original seeded placement and starting-site calculations stable, then move any
  // river deposits to nearby dry terrain without consuming simulation randomness.
  moveRiverResources() {
    for (let i = 0; i < N; i++) {
      if (!this.river[i] || !this.res[i]) continue;
      const resource = this.res[i], terrain = this.terr[i];
      let target = -1;
      for (const radius of [2, 4, 8]) {
        const dry = disk(i, radius).filter((t) => !this.river[t] && !this.res[t] && !isWater(this.terr[t]) && this.terr[t] !== T.PEAK && this.terr[t] !== T.LAVA);
        target = dry.find((t) => this.terr[t] === terrain) ?? dry[0] ?? -1;
        if (target >= 0) break;
      }
      this.res[i] = RES.NONE;
      if (target >= 0) this.res[target] = resource;
    }
  }

  siteScore(i) {
    const t = this.terr[i];
    if (t !== T.GRASS && t !== T.PLAINS) return -1;
    if (this.river[i] || this.stab[i] < 0.35) return -1;
    if (this.volcanoes.some((v) => dist(v.tile, i) < 9)) return -1;
    if (this.riftTiles.length && this.riftTiles.some((r) => dist(r, i) < 4)) return -1;
    let s = 0;
    for (const n of disk(i, 3)) {
      const tn = this.terr[n];
      s += TERRAIN[tn].fert;
      if (tn === T.FOREST) s += 0.6;
      if (tn === T.HILLS) s += 0.5;
      if (this.river[n]) s += 0.5;
      if (this.res[n]) s += 0.8;
      if (tn === T.SHALLOW || tn === T.DEEP) s += 0.15;
      if (tn === T.PEAK || tn === T.MOUNTAIN) s -= 0.2;
    }
    return s;
  }

  pickStarts(n, rng) {
    const cands = [];
    for (let i = 0; i < N; i++) {
      const q = qOf(i), r = rOf(i);
      if (r < 10 || r > H - 11 || (!WRAP && (q < 10 || q > W - 11))) continue;
      if ((q + r) % 2) continue;
      const s = this.siteScore(i); if (s > 12) cands.push([i, s]);
    }
    cands.sort((a, b) => b[1] - a[1]);
    // farthest-point sampling over good sites: each new start maximises its distance to the others
    const pool = cands.slice(0, Math.max(600, n * 120)).map((c) => c[0]);
    let best = null, bestScore = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const pick = [rng.pick(pool)];
      while (pick.length < n) {
        let bt = -1, bd = -1;
        for (const t of pool) { let m = Infinity; for (const p of pick) { const d = dist(t, p); if (d < m) m = d; } if (m > bd) { bd = m; bt = t; } }
        pick.push(bt);
      }
      let minD = Infinity;
      for (let a2 = 0; a2 < n; a2++) for (let b2 = a2 + 1; b2 < n; b2++) minD = Math.min(minD, dist(pick[a2], pick[b2]));
      if (minD > bestScore) { bestScore = minD; best = pick; }
    }
    if (!best) throw new Error('no start positions');
    // guarantee basic resources around each start
    for (const s of best) {
      const ring = disk(s, 3).filter((t) => t !== s && !isWater(this.terr[t]) && this.terr[t] !== T.PEAK && dist(t, s) >= 2);
      const ensure = (cond, fix) => { if (!ring.some(cond)) { const free = ring.filter((t) => !this.res[t] && this.terr[t] !== T.FOREST); const t = rng.pick(free.length ? free : ring); fix(t); } };
      for (let k = 0; k < 2; k++) ensure((t) => this.terr[t] === T.FOREST && (k === 0 || ring.filter((x) => this.terr[x] === T.FOREST).length > 1), (t) => { this.moist[t] = 0.6; this.elev[t] = Math.min(this.elev[t], 0.2); this.classify(t); });
      ensure((t) => this.terr[t] === T.HILLS || this.res[t] === RES.STONE, (t) => { this.res[t] = RES.STONE; });
      ensure((t) => this.res[t] === RES.STONE, (t) => { this.res[t] = RES.STONE; });
      ensure((t) => this.res[t] === RES.IRON, (t) => { this.res[t] = RES.IRON; });
      ensure((t) => this.res[t] === RES.COAL, (t) => { this.res[t] = RES.COAL; });
      ensure((t) => this.res[t] === RES.RUINS, (t) => { this.res[t] = RES.RUINS; });
      const wide = disk(s, 6).filter((t) => dist(t, s) >= 4 && !isWater(this.terr[t]) && this.terr[t] !== T.PEAK && !this.res[t]);
      if (!disk(s, 6).some((t) => this.res[t] === RES.OIL) && wide.length) this.res[rng.pick(wide)] = RES.OIL;
      const far = disk(s, 10).filter((t) => dist(t, s) >= 6 && (this.terr[t] === T.HILLS || this.terr[t] === T.MOUNTAIN) && !this.res[t]);
      if (!disk(s, 10).some((t) => this.res[t] === RES.RARE) && far.length) this.res[rng.pick(far)] = RES.RARE;
      // food: at least four open farm hexes near the city (a start on bare hills is a dead end)
      const farmable = (t) => t !== s && (this.terr[t] === T.GRASS || this.terr[t] === T.PLAINS || this.terr[t] === T.ASH);
      let fields = disk(s, 3).filter(farmable).length;
      for (const t of disk(s, 3)) {
        if (fields >= 4) break;
        if (t === s || farmable(t) || isWater(this.terr[t]) || this.terr[t] === T.PEAK || this.res[t]) continue;
        this.elev[t] = Math.min(this.elev[t], 0.18); this.moist[t] = Math.max(0.45, Math.min(this.moist[t], 0.55)); this.temp[t] = Math.max(this.temp[t], 0.45); this.classify(t);
        if (farmable(t)) fields++;
      }
      for (const t of disk(s, 2)) { this.stab[t] = Math.max(this.stab[t], 0.6); this.rate[t] = Math.max(-0.00002, Math.min(this.rate[t], 0.00002)); }
    }
    // fairness report: every start has a path to food, materials, metals, fuel and rare earths
    this.fairness = best.map((s) => {
      const near = (rad, test) => disk(s, rad).filter(test).length;
      return { start: s, food: near(3, (t) => [T.GRASS, T.PLAINS, T.ASH].includes(this.terr[t])), materials: near(3, (t) => this.terr[t] === T.FOREST || this.res[t] === RES.STONE),
        metals: near(6, (t) => this.res[t] === RES.IRON || this.res[t] === RES.COAL), fuel: near(8, (t) => this.res[t] === RES.OIL), rare: near(12, (t) => this.res[t] === RES.RARE) };
    });
    return best;
  }
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (v[p] <= v[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const k = this.k, v = this.v, top = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}
export { MinHeap };
