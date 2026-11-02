// Regional weather: a coarse grid of cells (8×8 hexes each) over the map carrying wind, temperature,
// humidity, cloud, precipitation, fog, ground wetness and storm intensity. It updates deterministically
// every 5 simulated seconds: humidity and cloud drift downwind (wrapping east–west, stopping at the
// poles), the sea and wet ground feed humidity, high ground wrings rain out of passing cloud, rain
// spends humidity and wets the ground, cold turns it to snow, still humid air pools into fog in
// valleys and along rivers and coasts, and occasional fronts and storms blow in from the west.
// Weather systems: low-pressure cyclones form over the sea, drift with the prevailing wind and spin
// the air around them, so cloud is carried along a real wind field (prevailing flow plus each
// system's rotation and inflow): bands wrap into spirals, cores thicken into rain and storms, and
// the system fills and dies away after a few minutes.
// Seeded and saved, so a restored match continues the same weather.
//
// Gameplay effects are deliberately mild and capped:
//   heavy rain / snow   off-road movement over unpaved ground up to +15% (roads unaffected)
//   dense fog           units see one hex less (never below one)
//   storm               aircraft do not take off from a base under a storm
// Permanent daylight: clouds dim the ground in places, there is never night.
import { W, H, N, T, isWater } from './constants.js';
import { mulberry32 } from './rng.js';

export const CELL = 8;
const STEP = 5;                                // seconds between updates
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Weather {
  constructor(world, seed) {
    this.w = world;
    this.cw = Math.ceil(W / CELL); this.ch = Math.ceil(H / CELL); this.n = this.cw * this.ch;
    const F = () => new Float32Array(this.n);
    this.cloud = F(); this.humid = F(); this.rain = F(); this.fog = F(); this.wet = F(); this.storm = F(); this.temp = F(); this.sea = F(); this.relief = F(); this.riv = F();
    this.windA = 0; this.windS = 0.5;          // direction (radians, 0 = blowing east) and strength 0..1
    this.rng = mulberry32((seed ^ 0x5eed7) >>> 0);
    this.acc = 0; this.ver = 0;
    this.cyclones = []; this.nextCy = 1;     // { id, x, y (cells), r (cells), s (0..1), spin (+1/-1), age, life (steps) }
    this.climate();
    // a plausible start: some cloud where the air is humid
    for (let c = 0; c < this.n; c++) { this.humid[c] = 0.3 + 0.3 * this.sea[c]; this.cloud[c] = clamp01(this.humid[c] - 0.4 + this.rng() * 0.25); }
  }

  // static per-cell climate: share of sea, average relief, rivers, base temperature (latitude/height)
  climate() {
    const w = this.w;
    const cnt = new Float32Array(this.n);
    this.sea.fill(0); this.relief.fill(0); this.temp.fill(0); this.riv.fill(0);
    for (let i = 0; i < N; i++) {
      const c = this.cellOf(i); cnt[c]++;
      if (isWater(w.terr[i])) this.sea[c]++;
      const t = w.terr[i]; this.relief[c] += t === T.MOUNTAIN || t === T.PEAK ? 1 : t === T.HILLS ? 0.5 : 0;
      if (w.river[i]) this.riv[c]++;
      this.temp[c] += w.temp ? w.temp[i] : 0.5;
    }
    for (let c = 0; c < this.n; c++) { const k = Math.max(1, cnt[c]); this.sea[c] /= k; this.relief[c] /= k; this.temp[c] /= k; this.riv[c] = Math.min(1, this.riv[c] / 6); }
  }
  cellOf(i) { const q = i % W, r = (i / W) | 0; return ((r / CELL) | 0) * this.cw + ((q / CELL) | 0); }

  // bilinear sample of a field at fractional cell coordinates (wrapping in x, clamped in y)
  sample(f, x, y) {
    const cw = this.cw, ch = this.ch;
    y = Math.max(0, Math.min(ch - 1.001, y));
    x = ((x % cw) + cw) % cw;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, x1 = (x0 + 1) % cw, y1 = Math.min(ch - 1, y0 + 1);
    return (f[y0 * cw + x0] * (1 - fx) + f[y0 * cw + x1] * fx) * (1 - fy) + (f[y1 * cw + x0] * (1 - fx) + f[y1 * cw + x1] * fx) * fy;
  }

  step(dt, season = 0) {
    this.acc += dt; if (this.acc < STEP) return false;
    this.acc -= STEP;
    const rng = this.rng, cw = this.cw, ch = this.ch, n = this.n;
    // the prevailing wind wanders slowly (westerlies on average), gusting now and then
    this.windA += (rng() - 0.5) * 0.18 + (0 - Math.sin(this.windA)) * 0.02;
    this.windS = clamp01(this.windS + (rng() - 0.5) * 0.08 + (0.45 - this.windS) * 0.03);
    const vx = Math.cos(this.windA) * (0.25 + this.windS * 0.55), vy = Math.sin(this.windA) * (0.25 + this.windS * 0.55) * 0.6;   // cells per step
    this.stepCyclones(vx, vy);
    // advect humidity, cloud and storm along the wind field (semi-Lagrangian: sample upstream)
    const nh = new Float32Array(n), nc = new Float32Array(n), ns = new Float32Array(n), lift = new Float32Array(n);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const c = y * cw + x, [ux, uy, lf] = this.windAt(x, y, vx, vy), sx = x - ux, sy = y - uy;
      nh[c] = this.sample(this.humid, sx, sy); nc[c] = this.sample(this.cloud, sx, sy); ns[c] = this.sample(this.storm, sx, sy); lift[c] = lf;
    }
    // fronts: now and then a band of humid, cloudy air (rarely a storm) enters on the upwind side
    if (rng() < 0.05) {
      const y0 = rng.int(ch), x0 = rng.int(cw), len = 1 + rng.int(3), stormy = rng() < 0.3;
      for (let k = -len; k <= len; k++) for (const dx of [0, 1]) { const y = Math.max(0, Math.min(ch - 1, y0 + k)), c = y * cw + ((x0 + dx) % cw); nh[c] = Math.min(1, nh[c] + 0.3); nc[c] = Math.min(1, nc[c] + 0.4); if (stormy) ns[c] = 1; }
    }
    for (let c = 0; c < n; c++) {
      const temp = this.temp[c] - 0.12 * Math.cos(season * Math.PI * 2);     // a seasonal swing
      // humidity: the sea and wet ground evaporate into the air, which slowly dries over land
      const hT = 0.32 + 0.42 * this.sea[c] + 0.18 * this.wet[c] + 0.08 * this.riv[c];
      let h = nh[c] + (hT - nh[c]) * 0.05 + lift[c] * 0.03;
      // cloud forms from humid air (more where it is forced up over high ground or converges into a
      // weather system) and thins otherwise
      const cT = clamp01((h - 0.45) * 2.6 + this.relief[c] * Math.max(0, h - 0.35) * 1.2 + lift[c] * 0.9);
      let cl = nc[c] + (cT - nc[c]) * 0.12;
      cl = clamp01(cl);
      // precipitation: only thick cloud rains (more over high ground and in storms)
      const pr = clamp01((cl - 0.62) * 2.8 + this.relief[c] * 0.12 * Math.max(0, cl - 0.4) + ns[c] * 0.6);
      h -= pr * 0.02; cl -= pr * 0.012;
      this.humid[c] = clamp01(h); this.cloud[c] = clamp01(cl); this.rain[c] = pr;
      this.storm[c] = clamp01(Math.max(ns[c] * 0.988 - 0.002, (lift[c] - 0.6) * 2));
      // ground wetness: rain wets, sun and wind dry
      this.wet[c] = clamp01(this.wet[c] * 0.975 + pr * 0.1 - (1 - cl) * 0.008);
      // fog: humid, calm air over wet ground, rivers and coasts, under little cloud
      const fogTarget = clamp01((h - 0.47) * 4 * (1.1 - this.windS) * (0.35 + this.riv[c] + this.sea[c] * 0.5 + this.wet[c] * 0.5) * (1 - pr) * (1 - cl * 0.6));
      this.fog[c] = this.fog[c] + (fogTarget - this.fog[c]) * 0.3;
      this.snowCold = this.snowCold || new Float32Array(n);
      this.snowCold[c] = temp < 0.22 ? 1 : 0;
    }
    this.ver++;
    return true;
  }

  // cyclones: born over open sea, carried by the prevailing wind, strengthen, then fill and die
  stepCyclones(vx, vy) {
    const rng = this.rng, cw = this.cw, ch = this.ch;
    if (this.cyclones.length < Math.max(1, Math.round(this.n / 500)) && rng() < 0.035) {
      for (let k = 0; k < 8; k++) {
        const x = rng.int(cw), y = 1 + rng.int(Math.max(1, ch - 2)), c = y * cw + x;
        if (this.sea[c] < 0.5 && k < 7) continue;
        this.cyclones.push({ id: this.nextCy++, x, y, r: 2.2 + rng() * 2.6, s: 0, spin: y < ch / 2 ? 1 : -1, age: 0, life: 50 + rng.int(70) });
        break;
      }
    }
    for (const cy of this.cyclones) {
      cy.age++;
      cy.x = (((cy.x + vx * 0.8 + (rng() - 0.5) * 0.1) % cw) + cw) % cw; cy.y += vy * 0.8 + (rng() - 0.5) * 0.1;
      cy.s = Math.sin(Math.PI * Math.min(1, cy.age / cy.life)) * (0.7 + 0.3 * Math.min(1, cy.r / 4));
    }
    this.cyclones = this.cyclones.filter((cy) => cy.age < cy.life && cy.y > -1 && cy.y < ch);
  }
  // local wind (cells per step) at a cell: prevailing flow plus each cyclone's swirl and inflow;
  // the third value is how strongly air converges and rises there (0..1)
  windAt(x, y, vx, vy) {
    let ux = vx, uy = vy, lift = 0;
    for (const cy of this.cyclones) {
      let dx = x - cy.x; const dy = y - cy.y;
      if (dx > this.cw / 2) dx -= this.cw; else if (dx < -this.cw / 2) dx += this.cw;
      const d = Math.hypot(dx, dy), k = d / cy.r; if (k > 3.5 || d < 1e-3) { if (d < 1e-3) lift = Math.max(lift, cy.s); continue; }
      const v = cy.s * 0.9 * k * Math.exp(0.5 * (1 - k * k));      // a Rankine-like vortex: fastest at radius r
      const tx = -dy / d * cy.spin, ty = dx / d * cy.spin;
      ux += tx * v - (dx / d) * v * 0.3; uy += ty * v - (dy / d) * v * 0.3;   // swirl, spiralling inward
      lift = Math.max(lift, cy.s * Math.exp(-k * k));
    }
    return [ux, uy, lift];
  }

  // ---- gameplay hooks (cheap; called from movement and vision)
  at(i) { return this.cellOf(i); }
  // movement cost multiplier for leaving the road over unpaved ground: capped at +15%
  moveMul(i) { const c = this.cellOf(i), p = this.rain[c]; return p > 0.45 ? 1 + Math.min(0.15, (p - 0.45) * 0.3 + this.wet[c] * 0.05) : 1; }
  fogAt(i) { return this.fog[this.cellOf(i)]; }
  stormAt(i) { return this.storm[this.cellOf(i)]; }

  // what clients draw: one byte per field per cell, plus the wind
  snapshot() {
    const pack = (f) => Buffer.from(f.map((v) => Math.round(v * 255))).toString('base64');
    const snow = Buffer.from((this.snowCold || new Float32Array(this.n))).toString('base64');
    return { v: this.ver, cw: this.cw, ch: this.ch, cell: CELL, wind: [+this.windA.toFixed(3), +this.windS.toFixed(3)],
      cy: this.cyclones.map((c) => [c.id, +c.x.toFixed(2), +c.y.toFixed(2), +c.r.toFixed(2), +c.s.toFixed(3), c.spin]), cloud: pack(this.cloud), rain: pack(this.rain), fog: pack(this.fog), wet: pack(this.wet), storm: pack(this.storm), snow };
  }

  serialize() {
    const b = (f) => Buffer.from(f.buffer.slice(0)).toString('base64');
    return { cloud: b(this.cloud), humid: b(this.humid), rain: b(this.rain), fog: b(this.fog), wet: b(this.wet), storm: b(this.storm), windA: this.windA, windS: this.windS, rng: this.rng.getState(), acc: this.acc, ver: this.ver, cyclones: this.cyclones, nextCy: this.nextCy };
  }
  load(o) {
    if (!o) return;
    const f = (s, dst) => { if (!s) return; const buf = Buffer.from(s, 'base64'); const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); if (arr.length === dst.length) dst.set(arr); };
    f(o.cloud, this.cloud); f(o.humid, this.humid); f(o.rain, this.rain); f(o.fog, this.fog); f(o.wet, this.wet); f(o.storm, this.storm);
    this.windA = o.windA ?? this.windA; this.windS = o.windS ?? this.windS; if (o.rng != null) this.rng.setState(o.rng); this.acc = o.acc || 0; this.ver = o.ver || 0;
    this.cyclones = Array.isArray(o.cyclones) ? o.cyclones : []; this.nextCy = o.nextCy || 1;
  }
}
