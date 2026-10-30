// Continental world: generation, terrain classification and hydrology.
import { W, H, N, T, RES, TERRAIN, isWater } from './constants.js';
import { NB, idx, qOf, rOf, dist, disk } from './hex.js';
import { mulberry32, fbm, hash2 } from './rng.js';

export const RIVER_FLOW = 42;

export class World {
  constructor(seed) {
    this.seed = seed;
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
    const P = 11;
    const plates = [];
    for (let p = 0; p < P; p++) {
      const q = rng.range(6, W - 6), r = rng.range(6, H - 6);
      const dc = Math.hypot((q - W / 2) / W, (r - H / 2) / H);
      plates.push({ q, r, cont: dc < 0.33 ? rng() < 0.85 : rng() < 0.25, vx: rng.range(-1, 1), vy: rng.range(-1, 1) });
    }
    this.plates = plates;
    for (let i = 0; i < N; i++) {
      const q = qOf(i) + (fbm(qOf(i) / 22, rOf(i) / 22, seed + 7) - 0.5) * 26;
      const r = rOf(i) + (fbm(qOf(i) / 22, rOf(i) / 22, seed + 11) - 0.5) * 26;
      let best = 0, bd = Infinity;
      for (let p = 0; p < P; p++) { const d = (q - plates[p].q) ** 2 + (r - plates[p].r) ** 2; if (d < bd) { bd = d; best = p; } }
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
        const nx = qOf(n) - qOf(i), ny = rOf(n) - rOf(i), len = Math.hypot(nx, ny) || 1;
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
      const falloff = 1 - Math.pow(Math.hypot(nx * 0.95, ny * 1.05), 2.2);
      const pl = plates[this.plate[i]];
      let e = (pl.cont ? 0.12 : -0.18) + (fbm(q / 28, r / 28, seed + 3) - 0.5) * 0.7 + falloff * 0.42 - 0.17;
      e += (fbm(q / 7, r / 7, seed + 5) - 0.5) * 0.14;
      const f = Math.exp(-bdist[i] / 2.2);
      const v = bval[i];
      if (v > 0) e += Math.min(0.75, v * 0.55) * f * (pl.cont ? 1 : 0.6);
      else e += v * 0.18 * f;
      this.elev[i] = e;
      this.stab[i] = Math.max(0.05, Math.min(1, 1 - 0.8 * f * Math.min(1, Math.abs(v) + 0.25) + (fbm(q / 9, r / 9, seed + 9) - 0.5) * 0.25));
      this.rate[i] = v > 0 ? 0.00011 * f * Math.min(1.5, v) : v * 0.00004 * f;
      if (bdist[i] <= 1 && Math.abs(v) > 0.25) this.faultTiles.push(i);
    }
    // --- The Great Rift: a subsiding fracture through the continent, leaving an isthmus.
    this.makeRift(rng);
    // --- Climate
    const waterDist = this.distanceToWater();
    for (let i = 0; i < N; i++) {
      const q = qOf(i), r = rOf(i);
      this.moist[i] = Math.max(0, Math.min(1, fbm(q / 18, r / 18, seed + 21) * 0.9 + 0.36 * Math.exp(-waterDist[i] / 7) - 0.07));
      this.temp[i] = 0.15 + 0.8 * (r / H) - Math.max(0, this.elev[i]) * 0.45 + (fbm(q / 30, r / 30, seed + 31) - 0.5) * 0.3;
    }
    this.recomputeHydrology(true);
    for (let i = 0; i < N; i++) this.classify(i);
    this.placeVolcanoes(rng);
    this.placeResources(rng);
    this.starts = this.pickStarts(nCivs, rng);
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
      if (q < 0 || r < 0 || q >= W || r >= H) break;
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
      const edge = qOf(i) === 0 || rOf(i) === 0 || qOf(i) === W - 1 || rOf(i) === H - 1;
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
      if (q < 10 || r < 10 || q > W - 11 || r > H - 11) continue;
      if ((q + r) % 2) continue;
      const s = this.siteScore(i); if (s > 12) cands.push([i, s]);
    }
    cands.sort((a, b) => b[1] - a[1]);
    const pool = cands.slice(0, 600).map((c) => c[0]);
    let best = null, bestScore = -1;
    for (let attempt = 0; attempt < 300; attempt++) {
      const pick = [];
      for (let k = 0; k < n; k++) pick.push(rng.pick(pool));
      let minD = Infinity;
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) minD = Math.min(minD, dist(pick[a], pick[b]));
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
      for (const t of disk(s, 2)) { this.stab[t] = Math.max(this.stab[t], 0.6); this.rate[t] = Math.max(-0.00002, Math.min(this.rate[t], 0.00002)); }
    }
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
