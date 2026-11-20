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
// Storm systems (2026-11, WEATHER_VISUALS.md "Storm systems"): the background weather is fair to lightly
// overcast; real storms are rare scheduled events. At most one large system is alive at a time: the first
// arrives 6–12 minutes in, and each later one 9–18 minutes after the previous one has died, so a 30–45 minute
// match sees one to three. Two kinds:
//   squall line  a bowed line of thunderstorms with a shelf cloud at its leading edge and trailing rain, born
//                just off an upwind map edge and driven across the map in four to six minutes
//   hurricane    (favoured on maps with much sea) born over open water, a rotating system with a clear eye,
//                the strongest storm in the eyewall and spiral rain bands; it drifts on a curving track,
//                strengthens over the sea and fills over land
// A system is a handful of parameters (centre, heading, turn rate, speed, radius, intensity, spin, age, life),
// moved deterministically with no random draws after it is born, so the snapshot ('sys') lets each client
// rebuild the whole field and forecast the track exactly. Each step it is stamped into the regional cloud,
// rain and storm fields (systemProfile, mirrored by the client), so every existing effect follows it.
//
// Gameplay effects are deliberately mild and capped:
//   heavy rain / snow   off-road movement over unpaved ground up to +15% (roads unaffected)
//   dense fog, storm core   units see one hex less (never below one)
//   storm               aircraft do not take off from a base under a storm
// Permanent daylight: clouds dim the ground in places, there is never night.
import { W, H, N, T, isWater } from './constants.js';
import { mulberry32 } from './rng.js';
import { WRAP } from './hex.js';

export const CELL = 8;
const STEP = 5;                                // seconds between updates
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const SQ3 = Math.sqrt(3);
export const WX_PERIOD = W * SQ3, WX_DEPTH = H * 1.5;       // world extent (hex centres are √3 apart, rows 1.5)
export const WX_STEP = STEP;

// storm-system schedule, in weather steps (5 s): first arrival, then the quiet gap after a system dies
export const STORM_SCHEDULE = { first: 72, firstSpan: 72, gap: 108, gapSpan: 108 };
export const STORM_KIND = { SQUALL: 0, HURRICANE: 1 };
const HURRICANE_NAMES = ['Ada', 'Bram', 'Cora', 'Dov', 'Esme', 'Falk', 'Greta', 'Hale', 'Iris', 'Jory', 'Kesh', 'Lena', 'Mako', 'Nell', 'Orrin', 'Pia', 'Quill', 'Rhea', 'Soren', 'Tova', 'Ulf', 'Vera', 'Wyn', 'Yara', 'Zeno'];

const PROF = [0, 0, 0];
const prof = (c, st, rn) => { PROF[0] = c; PROF[1] = st; PROF[2] = rn; return PROF; };
/**
 * A storm system's field at an offset (dx east, dz south, world units) from its centre: [cloud, storm, rain]
 * (0..1; a shared scratch array: copy the values out). Axisymmetric for hurricanes (the client adds rotating spiral bands and noise on top); the client
 * mirrors this exactly (StormSystems.Profile), so the minimap, the hover card and the gameplay agree.
 */
export function systemProfile(sy, dx, dz) {
  const R = sy.r, s = sy.s;
  if (s <= 0 || R <= 0) return prof(0, 0, 0);
  if (sy.kind === STORM_KIND.HURRICANE) {
    const r = Math.hypot(dx, dz), k = r / R;
    if (k > 1.1) return prof(0, 0, 0);
    const rm = 0.2 * R, eye = smooth(0.3 * rm, 0.55 * rm, r);
    const wall = Math.exp(-(((r - rm) / (0.42 * rm)) ** 2));
    const bands = smooth(0.9 * rm, 1.6 * rm, r) * (1 - smooth(0.55, 1.0, k));
    const shield = (1 - smooth(0.35, 1.05, k));
    const grow = clamp01(0.35 + s);
    return prof(eye * clamp01(Math.max(wall, 0.32 * bands + 0.62 * shield)) * grow, eye * clamp01(wall + 0.22 * bands) * s, eye * clamp01(wall * 0.95 + 0.3 * bands + 0.2 * shield) * clamp01(s * 1.2));
  }
  // squall line: (a) along the line, (b) along the motion, the line bowed forward in the middle
  const fx = Math.cos(sy.h), fz = Math.sin(sy.h);
  const a = (dx * -fz + dz * fx) / R, b = dx * fx + dz * fz;
  if (a > 1.05 || a < -1.05 || b > 0.3 * R || b < -0.95 * R) return prof(0, 0, 0);
  const lat = 1 - smooth(0.62, 1.0, Math.abs(a));
  const e = b - (0.2 * R * (1 - a * a) - 0.08 * R);             // > 0 ahead of the leading edge
  const conv = Math.exp(-(((e + 0.07 * R) / (0.075 * R)) ** 2));
  const shelf = Math.exp(-(((e - 0.01 * R) / (0.035 * R)) ** 2));
  const trail = e < 0 ? Math.exp(e / (0.45 * R)) * smooth(0.02 * R, -0.04 * R, e) : 0;
  return prof(lat * clamp01(conv + shelf * 0.7 + trail * 0.72) * clamp01(0.35 + s), lat * conv * s, lat * clamp01(conv * 0.95 + trail * 0.75) * s);
}

/** Where a system will be after `secs` seconds (its motion is parametric: constant speed, constant turn rate). */
export function systemTrackAt(sy, secs) {
  let x = sy.x, z = sy.z, h = sy.h;
  const steps = Math.max(0, Math.round(secs / STEP));
  for (let k = 0; k < steps; k++) { x += Math.cos(h) * sy.v * STEP; z += Math.sin(h) * sy.v * STEP; h += sy.turn * STEP; }
  return { x, z, h };
}

/** A system's intensity at its age: grows, matures, decays (times its fuel: hurricanes weaken over land). */
export function systemIntensity(sy) {
  const f = sy.age / Math.max(1, sy.life);
  return sy.peak * smooth(0, 0.18, f) * (1 - smooth(0.72, 1, f)) * (sy.fuel ?? 1);
}

export class Weather {
  constructor(world, seed) {
    this.w = world;
    this.cw = Math.ceil(W / CELL); this.ch = Math.ceil(H / CELL); this.n = this.cw * this.ch;
    const F = () => new Float32Array(this.n);
    this.cloud = F(); this.humid = F(); this.rain = F(); this.fog = F(); this.wet = F(); this.storm = F(); this.temp = F(); this.sea = F(); this.relief = F(); this.riv = F();
    this.windA = 0; this.windS = 0.5;          // direction (radians, 0 = blowing east) and strength 0..1
    this.rng = mulberry32((seed ^ 0x5eed7) >>> 0);
    this.acc = 0; this.ver = 0;
    this.cyclones = []; this.nextCy = 1;     // { id, x, y (cells), r (cells), s (0..1), spin (+1/-1), age, life (steps) } (legacy saves only: no new ones form)
    // storm systems: { id, kind, x, z (world), h (heading, radians, z south), v (world units/s), turn (rad/s), r, s, peak, fuel, spin, age, life (s), name }
    this.systems = []; this.nextSys = 1;
    this.sysAt = STORM_SCHEDULE.first + this.rng.int(STORM_SCHEDULE.firstSpan);   // weather step (ver) of the next arrival
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
    this.stepSystems(vx, vy);
    // advect humidity, cloud and storm along the wind field (semi-Lagrangian: sample upstream)
    const nh = new Float32Array(n), nc = new Float32Array(n), ns = new Float32Array(n), lift = new Float32Array(n);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const c = y * cw + x, [ux, uy, lf] = this.windAt(x, y, vx, vy), sx = x - ux, sy = y - uy;
      nh[c] = this.sample(this.humid, sx, sy); nc[c] = this.sample(this.cloud, sx, sy); ns[c] = this.sample(this.storm, sx, sy); lift[c] = lf;
    }
    // fronts: now and then a band of humid, cloudy air enters on the upwind side (storms come only from the
    // scheduled storm systems)
    if (rng() < 0.05) {
      const y0 = rng.int(ch), x0 = rng.int(cw), len = 1 + rng.int(3);
      for (let k = -len; k <= len; k++) for (const dx of [0, 1]) { const y = Math.max(0, Math.min(ch - 1, y0 + k)), c = y * cw + ((x0 + dx) % cw); nh[c] = Math.min(1, nh[c] + 0.25); nc[c] = Math.min(1, nc[c] + 0.3); }
    }
    // the storm systems' own cloud, rain and storm, stamped over the drifting background
    const sc = new Float32Array(n), sr = new Float32Array(n), ss = new Float32Array(n);
    if (this.systems.length) this.stampSystems(sc, sr, ss);
    for (let c = 0; c < n; c++) {
      const temp = this.temp[c] - 0.12 * Math.cos(season * Math.PI * 2);     // a seasonal swing
      // humidity: the sea and wet ground evaporate into the air, which slowly dries over land (fair to
      // lightly overcast over the sea; rain belongs to the storm systems and high ground)
      const hT = 0.3 + 0.3 * this.sea[c] + 0.16 * this.wet[c] + 0.06 * this.riv[c];
      let h = nh[c] + (hT - nh[c]) * 0.05 + lift[c] * 0.03 + sc[c] * 0.04;
      if (sc[c] > nc[c]) nc[c] += (sc[c] - nc[c]) * 0.85;          // the system's cloud mass (its trail thins away afterwards)
      // cloud forms from humid air (more where it is forced up over high ground or converges into a
      // weather system) and thins otherwise
      const cT = clamp01((h - 0.45) * 2.6 + this.relief[c] * Math.max(0, h - 0.35) * 1.2 + lift[c] * 0.9);
      let cl = nc[c] + (cT - nc[c]) * 0.12;
      cl = clamp01(cl);
      // precipitation: only thick cloud rains (more over high ground and in storms)
      const pr = clamp01(Math.max((cl - 0.66) * 2.4 + this.relief[c] * 0.12 * Math.max(0, cl - 0.4) + ns[c] * 0.5, sr[c]));
      h -= pr * 0.02; cl -= pr * 0.012;
      this.humid[c] = clamp01(h); this.cloud[c] = clamp01(cl); this.rain[c] = pr;
      // storm: the systems' own, plus a short-lived wake (and legacy cyclones from old saves)
      this.storm[c] = clamp01(Math.max(ns[c] * 0.8 - 0.01, (lift[c] - 0.6) * 2, ss[c]));
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

  // ---- storm systems (see the header): scheduled, born at an edge or over the sea, steered across the map
  cellCentre(c) { return [((c % this.cw) + 0.5) * CELL * SQ3, (((c / this.cw) | 0) + 0.5) * CELL * 1.5]; }
  seaShare() { let s = 0; for (let c = 0; c < this.n; c++) s += this.sea[c]; return s / this.n; }
  // share of sea under a disk (cells), for spawning and landfall
  seaUnder(x, z, r) {
    let s = 0, k = 0;
    for (let c = 0; c < this.n; c++) {
      const cx = ((c % this.cw) + 0.5) * CELL * SQ3, cz = (((c / this.cw) | 0) + 0.5) * CELL * 1.5; let dx = cx - x; dx -= Math.round(dx / WX_PERIOD) * WX_PERIOD;
      if (dx * dx + (cz - z) ** 2 > r * r) continue;
      s += this.sea[c]; k++;
    }
    return k ? s / k : 0;
  }

  spawnSystem(kind) {
    const rng = this.rng, P = WX_PERIOD, D = WX_DEPTH, span = Math.min(P, D);
    const sy = { id: this.nextSys++, kind, x: 0, z: 0, h: 0, v: 0, turn: 0, r: 0, s: 0, peak: 0.8 + 0.2 * rng(), fuel: 1, spin: 1, age: 0, life: 0, name: '' };
    if (kind === STORM_KIND.HURRICANE) {
      sy.r = span * (0.19 + 0.05 * rng());
      // the sea-richest of a handful of candidate points, away from the poles
      let best = -1;
      for (let k = 0; k < 16; k++) {
        const x = rng() * P, z = D * (0.2 + 0.6 * rng()), sea = this.seaUnder(x, z, sy.r * 0.5);
        if (sea > best) { best = sea; sy.x = x; sy.z = z; }
      }
      // head for the land (the centre of the map's land mass), give or take, on a gently curving track
      let lx = 0, lz = 0, lw = 0;
      for (let c = 0; c < this.n; c++) {
        const w = 1 - this.sea[c]; if (w <= 0) continue;
        const [cx, cz] = this.cellCentre(c); let dx = cx - sy.x; dx -= Math.round(dx / P) * P;
        lx += dx * w; lz += (cz - sy.z) * w; lw += w;
      }
      sy.h = (lw > 0 && (lx || lz) ? Math.atan2(lz, lx) : rng() * Math.PI * 2) + (rng() - 0.5) * 1.2;
      sy.v = P / (420 + 120 * rng());                    // about 7–9 minutes to cross the map's width
      sy.turn = (rng() < 0.5 ? -1 : 1) * (0.0008 + 0.0016 * rng());
      sy.life = 420 + 120 * rng();
      sy.spin = sy.z < D / 2 ? 1 : -1;                   // counter-clockwise in the north (seen from above), clockwise in the south
      sy.name = HURRICANE_NAMES[(this.nextSys - 2) % HURRICANE_NAMES.length];
    } else {
      sy.r = span * (0.3 + 0.08 * rng());                // half the line's length
      // driven by the prevailing wind; born just beyond the upwind edge
      const h = this.windA + (rng() - 0.5) * 0.7, fx = Math.cos(h), fz = Math.sin(h);
      sy.h = h; sy.turn = (rng() - 0.5) * 0.0016;
      const ex = fx > 0 ? -0.15 * sy.r : P + 0.15 * sy.r, ez = fz > 0 ? -0.15 * sy.r : D + 0.15 * sy.r;
      // enter through the side the heading comes from (the longer of the two crossings)
      if (Math.abs(fx) * D >= Math.abs(fz) * P) { sy.x = ex; sy.z = D * (0.25 + 0.5 * rng()); } else { sy.z = ez; sy.x = P * rng(); }
      const across = Math.abs(fx) * D >= Math.abs(fz) * P ? P / Math.max(0.3, Math.abs(fx)) : D / Math.max(0.3, Math.abs(fz));
      sy.life = 270 + 90 * rng();
      sy.v = (across + 0.3 * sy.r) / sy.life;
      sy.spin = 0; sy.name = 'Squall line';
    }
    this.systems.push(sy);
    return sy;
  }

  stepSystems() {
    const rng = this.rng;
    if (!this.systems.length && this.ver >= this.sysAt) {
      const hurricaneOdds = Math.min(0.75, this.seaShare() * 1.6);
      this.spawnSystem(rng() < hurricaneOdds ? STORM_KIND.HURRICANE : STORM_KIND.SQUALL);
    }
    const P = WX_PERIOD, D = WX_DEPTH;
    for (const sy of this.systems) {
      sy.age += STEP;
      sy.x += Math.cos(sy.h) * sy.v * STEP; sy.z += Math.sin(sy.h) * sy.v * STEP; sy.h += sy.turn * STEP;
      if (WRAP) sy.x = ((sy.x % P) + P) % P;
      if (sy.kind === STORM_KIND.HURRICANE) {
        // warm sea feeds it, land starves it
        const sea = this.seaUnder(sy.x, sy.z, sy.r * 0.3);
        sy.fuel = Math.max(0.3, Math.min(1, sy.fuel + (sea > 0.55 ? 0.02 : -0.035 * (1 - sea))));
      }
      sy.s = systemIntensity(sy);
    }
    const before = this.systems.length;
    this.systems = this.systems.filter((sy) => sy.age < sy.life && sy.z > -sy.r * 1.2 && sy.z < D + sy.r * 1.2 && (WRAP || (sy.x > -sy.r * 1.4 && sy.x < P + sy.r * 1.4)));
    if (before && !this.systems.length) this.sysAt = this.ver + STORM_SCHEDULE.gap + rng.int(STORM_SCHEDULE.gapSpan);
  }

  // each cell's share of the systems: cloud and rain averaged, storm the strongest of five sub-samples
  // (so a narrow squall line still grounds the bases it crosses)
  stampSystems(sc, sr, ss) {
    const qx = CELL * SQ3 * 0.3, qz = CELL * 1.5 * 0.3, P = WX_PERIOD;
    const ox = [0, qx, -qx, qx, -qx], oz = [0, qz, qz, -qz, -qz];
    for (const sy of this.systems) {
      if (sy.s <= 0.001) continue;
      for (let c = 0; c < this.n; c++) {
        const cx = ((c % this.cw) + 0.5) * CELL * SQ3, cz = (((c / this.cw) | 0) + 0.5) * CELL * 1.5;
        let dx = cx - sy.x; dx -= Math.round(dx / P) * P;
        const dz = cz - sy.z;
        if (Math.abs(dx) > sy.r * 1.25 || Math.abs(dz) > sy.r * 1.25) continue;
        let cl = 0, rn = 0, st = 0;
        for (let k = 0; k < 5; k++) { const p = systemProfile(sy, dx + ox[k], dz + oz[k]); cl += p[0]; rn += p[2]; if (p[1] > st) st = p[1]; }
        sc[c] = Math.max(sc[c], cl / 5); sr[c] = Math.max(sr[c], rn / 5); ss[c] = Math.max(ss[c], st);
      }
    }
  }
  // the systems' winds in cells per step at a cell: a hurricane's swirl and inflow, a squall's gust front
  systemWind(x, y, out) {
    const cx = (x + 0.5) * CELL * SQ3, cz = (y + 0.5) * CELL * 1.5, P = WX_PERIOD;
    for (const sy of this.systems) {
      let dx = cx - sy.x; dx -= Math.round(dx / P) * P;
      const dz = cz - sy.z, r = Math.hypot(dx, dz);
      if (r > sy.r * 1.3 || r < 1e-3) continue;
      const toCx = 1 / (CELL * SQ3) * STEP, toCz = 1 / (CELL * 1.5) * STEP, env = 1 - smooth(0.7, 1.3, r / sy.r);
      // carried along with the system
      let ux = Math.cos(sy.h) * sy.v * env, uz = Math.sin(sy.h) * sy.v * env;
      if (sy.kind === STORM_KIND.HURRICANE) {
        const rm = 0.2 * sy.r, vmax = 2.2 * sy.s;          // world units per second
        const vt = vmax * (r < rm ? r / rm : Math.pow(rm / r, 0.6)) * env;
        // counter-clockwise seen from above (north up) with spin +1: in map space (z south) that is clockwise
        const tx = dz / r * sy.spin, tz = -dx / r * sy.spin;
        ux += tx * vt - dx / r * vt * 0.25; uz += tz * vt - dz / r * vt * 0.25;
      } else {
        const p = systemProfile(sy, dx, dz);
        const g = 1.6 * sy.s * Math.min(1, p[0] * 1.5);
        ux += Math.cos(sy.h) * g; uz += Math.sin(sy.h) * g;
      }
      out[0] += ux * toCx; out[1] += uz * toCz;
    }
  }

  // legacy cyclones (from saves made before storm systems): carried by the prevailing wind, they fill and die
  stepCyclones(vx, vy) {
    const rng = this.rng, cw = this.cw, ch = this.ch;
    if (!this.cyclones.length) return;
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
    if (this.systems.length) { const o = [ux, uy]; this.systemWind(x, y, o); ux = o[0]; uy = o[1]; }
    return [ux, uy, lift];
  }

  // ---- gameplay hooks (cheap; called from movement and vision)
  at(i) { return this.cellOf(i); }
  // movement cost multiplier for leaving the road over unpaved ground: capped at +15%
  moveMul(i) { const c = this.cellOf(i), p = this.rain[c]; return p > 0.45 ? 1 + Math.min(0.15, (p - 0.45) * 0.3 + this.wet[c] * 0.05) : 1; }
  // what hides the view at a hex: fog, or the driving rain in a storm system's core (vision: > .55 is one hex less)
  fogAt(i) { const c = this.cellOf(i); return Math.max(this.fog[c], this.storm[c] * 0.75); }
  stormAt(i) { return this.storm[this.cellOf(i)]; }

  // what clients draw: one byte per field per cell, plus the wind
  snapshot() {
    const pack = (f) => Buffer.from(f.map((v) => Math.round(v * 255))).toString('base64');
    const snow = Buffer.from((this.snowCold || new Float32Array(this.n))).toString('base64');
    return { v: this.ver, cw: this.cw, ch: this.ch, cell: CELL, wind: [+this.windA.toFixed(3), +this.windS.toFixed(3)],
      cy: this.cyclones.map((c) => [c.id, +c.x.toFixed(2), +c.y.toFixed(2), +c.r.toFixed(2), +c.s.toFixed(3), c.spin]), cloud: pack(this.cloud), rain: pack(this.rain), fog: pack(this.fog), wet: pack(this.wet), storm: pack(this.storm), snow,
      // storm systems: enough for the client to rebuild the field and forecast the track (systemProfile, systemTrackAt)
      sys: this.systems.map((y) => ({ id: y.id, k: y.kind, x: +y.x.toFixed(2), z: +y.z.toFixed(2), h: +y.h.toFixed(5), v: +y.v.toFixed(5), t: +y.turn.toFixed(6), r: +y.r.toFixed(2), s: +y.s.toFixed(3), sp: y.spin, a: y.age, l: +y.life.toFixed(1), n: y.name })) };
  }

  serialize() {
    const b = (f) => Buffer.from(f.buffer.slice(0)).toString('base64');
    return { cloud: b(this.cloud), humid: b(this.humid), rain: b(this.rain), fog: b(this.fog), wet: b(this.wet), storm: b(this.storm), windA: this.windA, windS: this.windS, rng: this.rng.getState(), acc: this.acc, ver: this.ver, cyclones: this.cyclones, nextCy: this.nextCy, systems: this.systems.map((y) => ({ ...y })), nextSys: this.nextSys, sysAt: this.sysAt };
  }
  load(o) {
    if (!o) return;
    const f = (s, dst) => { if (!s) return; const buf = Buffer.from(s, 'base64'); const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); if (arr.length === dst.length) dst.set(arr); };
    f(o.cloud, this.cloud); f(o.humid, this.humid); f(o.rain, this.rain); f(o.fog, this.fog); f(o.wet, this.wet); f(o.storm, this.storm);
    this.windA = o.windA ?? this.windA; this.windS = o.windS ?? this.windS; if (o.rng != null) this.rng.setState(o.rng); this.acc = o.acc || 0; this.ver = o.ver || 0;
    this.cyclones = Array.isArray(o.cyclones) ? o.cyclones : []; this.nextCy = o.nextCy || 1;
    // saves from before storm systems: none alive, the first one due a few minutes after the restore
    this.systems = Array.isArray(o.systems) ? o.systems.map((y) => ({ ...y })) : []; this.nextSys = o.nextSys || 1;
    this.sysAt = o.sysAt ?? this.ver + STORM_SCHEDULE.first + (this.ver * 7919 % STORM_SCHEDULE.firstSpan);
  }
}
