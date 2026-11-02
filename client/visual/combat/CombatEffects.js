// Combat presentation. The server decides every outcome; this replays its event stream:
//   fire -> muzzle flash + tracer burst | launch -> a projectile that lands when the server's impact
//   does (shells arc, rockets and missiles trail smoke, bombs fall from the aircraft) | impact ->
//   fireball, dirt plume, shock ring, lingering dust | hit -> sparks | kill -> wreck fire and smoke.
// Also draws the persistent battlefield (craters, scarred ground, wrecks, smoke and battle haze),
// strategic missiles in flight and their strikes (flash, shockwave across the zone, mushroom cloud),
// the engagement overlay for the selection, and battle markers.
//
// Particles live in a 2.5D frame: x/y is the point on the ground, z the height above it; they are
// drawn at (x, y - z). Debris is thrown up and lands (it never slides down the screen), smoke
// rises and drifts with the wind.
/* global PIXI */
import { h, frac, atLeast } from '../VisualLOD.js';
import { drawBattlefieldTerrain, hole } from '../BattlefieldTerrain.js';

const TRACER = { light: 0xffe9a8, heavy: 0xffc46a, flak: 0xfff0d0 };
const BLAST = { cannon: 0.8, rocket: 1, mortar: 1.15, missile: 1.4, artillery: 1.7 };
const ARC = { mortar: 34, artillery: 46 };
const MAX_PARTICLES = 1800;
const WIND = [5, -1.2];                      // world units per second: smoke drifts east
const HEX = 21;                              // hex spacing in world units (strike radii are in hexes)
const fin = (...a) => a.every(Number.isFinite);

export class CombatEffects {
  constructor(view, S) {
    this.v = view; this.S = S;
    this.queue = []; this.parts = []; this.shots = []; this.proj = new Map(); this.flashes = [];
    this.strikes = [];                       // strategic missile detonations (shockwave, mushroom cloud)
    this.scorch = [];                        // fading blast marks on the ground
    this.columns = [];                       // smoke columns rising from burning vehicles
    this.mtrail = new Map();                 // strategic missile id -> exhaust trail points
    this.recentHits = new Map();             // own unit id -> { t, from }
    this.clock = 0;
  }

  // layers are created by the view so they interleave correctly with terrain, buildings and units
  attach({ decal, wreck, fx, smoke, engage }) { this.decalG = decal; this.wreckG = wreck; this.fxG = fx; this.smokeG = smoke; this.engageG = engage; }

  cap() { return MAX_PARTICLES * Math.max(0.3, this.S.particleScale ?? 1); }
  full() { return this.parts.length > this.cap(); }
  seen(t) { return t >= 0 && (!this.S.vis || this.S.vis[t]); }

  // near: an x the result should be placed next to (the other end of a shot or arrow), so lines
  // across the world seam stay short
  pos(id, tile, near) {
    const s = id ? this.v.unitSprites.get(id) : null;
    const p = s ? [s.dx, s.dy - (s.alt || 0)] : tile >= 0 ? [this.v.cx[tile], this.v.cy[tile]] : null;
    if (p && near != null && this.v.wrap) p[0] = this.v.near(p[0], near);
    return p && fin(p[0], p[1]) ? p : null;
  }
  // a precision recentre of the camera moved the world by whole periods: move live effects with it
  shift(dx) {
    for (const a of [this.parts, this.shots, this.flashes, this.strikes, this.scorch, this.columns]) for (const p of a) { if (p.x != null) p.x += dx; if (p.x0 != null) { p.x0 += dx; p.x1 += dx; } }
    for (const p of this.proj.values()) { p.x0 += dx; p.x1 += dx; }
    for (const tr of this.mtrail.values()) for (const q of tr) q[0] += dx;
  }

  // Events of one snapshot arrive together; spread them over the 0.2 s they actually span.
  ingest(evs, tick) {
    const W = this.S.defs.WEAPON_KEYS;
    for (const e of evs) {
      const d = (e.n - ((tick | 0) - 2)) * 0.1;
      const delay = Number.isFinite(d) ? Math.max(0, Math.min(0.25, d)) : 0;
      this.queue.push({ at: this.clock + delay, e, w: e.w != null ? W[e.w] : null });
    }
  }

  frame(dt, t) {
    dt = Math.min(dt, 0.1);                  // a stalled tab must not fling everything in one step
    this.clock += dt;
    const S = this.S;
    if (this.queue.length) {
      const due = []; this.queue = this.queue.filter((q) => (q.at <= this.clock ? (due.push(q), false) : true));
      for (const q of due) this.play(q.e, q.w);
    }
    const g = this.fxG; g.clear();
    const lodStrategic = S.lod === 'strategic';
    // effects keep a readable size on screen: zoomed out, flashes, fire and smoke grow so a battle
    // reads as a battle at every zoom, not as a few specks and the craters they leave
    const K = this.K = Math.max(1, Math.min(3, 1.25 / Math.max(0.2, this.v.cam.z)));
    // ground marks first (under the fire and smoke)
    this.scorch = this.scorch.filter((s) => (s.t += dt) < s.ttl);
    for (const s of this.scorch) { const a = 1 - s.t / s.ttl; g.ellipse(s.x, s.y, s.r * 1.25, s.r).fill({ color: 0x15110d, alpha: 0.42 * a }); if (s.r > 12) g.ellipse(s.x, s.y, s.r * 0.7, s.r * 0.55).fill({ color: 0x0c0a08, alpha: 0.3 * a }); }
    this.drawMissiles(g, dt);
    // tracers: a bright head and a short fading tail
    this.shots = this.shots.filter((s) => (s.t += dt) < s.delay + s.ttl);
    for (const s of this.shots) {
      if (s.t < s.delay) continue;
      const p = (s.t - s.delay) / s.ttl, hp = Math.min(1, p * 1.3), tp = Math.max(0, p * 1.3 - 0.45);
      const hx = s.x0 + (s.x1 - s.x0) * hp, hy = s.y0 + (s.y1 - s.y0) * hp, tx = s.x0 + (s.x1 - s.x0) * tp, ty = s.y0 + (s.y1 - s.y0) * tp;
      const w = (s.heavy ? 1.1 : 0.7) * K;
      g.moveTo(tx, ty).lineTo(hx, hy).stroke({ width: w * 2.4, color: s.col, alpha: 0.18 * (1 - p * 0.4) });     // glow
      g.moveTo(tx, ty).lineTo(hx, hy).stroke({ width: w, color: s.col, alpha: 0.95 * (1 - p * 0.4) });
    }
    // projectiles in flight
    for (const [id, p] of this.proj) {
      p.t += dt;
      const k = Math.min(1, p.t / p.f);
      if (k >= 1) { if (p.t > p.f + 0.6) this.proj.delete(id); continue; }
      let x = p.x0 + (p.x1 - p.x0) * k, y = p.y0 + (p.y1 - p.y0) * k, z = 0;
      if (p.kind === 'bomb') z = p.z0 * (1 - k * k);                                   // released at altitude, accelerating down
      else if (p.arc) z = Math.sin(k * Math.PI) * p.arc;
      else if (p.curve) { const s = Math.sin(k * Math.PI) * p.curve; x += -(p.y1 - p.y0) / p.L * s; y += (p.x1 - p.x0) / p.L * s; z = Math.sin(k * Math.PI) * 6; }
      if (!fin(x, y, z)) continue;
      if (lodStrategic && !p.arc && p.kind !== 'bomb') continue;
      if (p.kind === 'missile' || p.kind === 'rocket') {
        // exhaust: a hot point and a trail of smoke puffs left in the air
        if (!lodStrategic && (p.pt = (p.pt || 0) + dt) > 0.03 && !this.full()) { p.pt = 0; this.parts.push({ kind: 'smoke', x, y, z, vx: 0, vy: 0, vz: 1, r: 0.9, grow: 2.2, col: 0xcfcac0, a: 0.5, t: 0, ttl: p.kind === 'missile' ? 1.4 : 0.8 }); }
        g.circle(x, y - z, 1.5 * K).fill({ color: 0xffe2a0 }); g.circle(x, y - z, 3.2 * K).fill({ color: 0xff9a3a, alpha: 0.35 });
      } else if (p.kind === 'bomb') {
        const ang = Math.atan2(p.y1 - p.y0 - p.z0 * 0.5, p.x1 - p.x0);
        g.ellipse(x, y - z, 1.6, 0.9).fill({ color: 0x2a2826 });
        if (!lodStrategic) g.circle(x, y, 1.2 * k).fill({ color: 0x000000, alpha: 0.2 });   // its shadow closing in
        void ang;
      } else {
        g.circle(x, y - z, (p.arc ? 1.2 : 1) * K).fill({ color: p.kind === 'cannon' ? 0xffd27a : 0x3a3530 });
        if (p.kind === 'cannon') g.moveTo(x, y - z).lineTo(x - (p.x1 - p.x0) / p.L * 7 * K, y - z - (p.y1 - p.y0) / p.L * 7 * K).stroke({ width: 1 * K, color: 0xffd27a, alpha: 0.7 });
        else if (p.arc && !lodStrategic) g.circle(x, y, 0.8 * K * Math.min(1, k * 2)).fill({ color: 0x000000, alpha: 0.18 });   // a shell's shadow racing over the ground
      }
    }
    // flashes: muzzle cones, fireball cores, shock rings
    this.flashes = this.flashes.filter((f) => (f.t += dt) < f.ttl);
    for (const f of this.flashes) {
      if (f.t < 0) continue;
      const k = f.t / f.ttl, a = 1 - k, fr = f.r * K;
      if (f.ring) g.circle(f.x, f.y, fr * (0.25 + 0.75 * Math.sqrt(k))).stroke({ width: Math.max(0.4, f.w * a * K), color: f.col || 0xf6ecd8, alpha: a * (f.a ?? 0.45) });
      else if (f.cone) {
        const L = fr * (0.7 + 0.3 * a), w = fr * 0.45;
        g.poly([f.x - f.dy * w * 0.4, f.y + f.dx * w * 0.4, f.x + f.dx * L, f.y + f.dy * L, f.x + f.dy * w * 0.4, f.y - f.dx * w * 0.4]).fill({ color: 0xffe9a8, alpha: a });
        g.circle(f.x, f.y, w * 0.6).fill({ color: 0xffffff, alpha: a * 0.9 });
      } else if (f.fire) {
        // a fireball: hot core inside a cooler shell, growing then collapsing into smoke
        const r = fr * (0.5 + 0.8 * Math.sqrt(k)), cy = f.y - fr * k * 0.7;
        g.circle(f.x, cy, r * 1.6).fill({ color: 0xff7a1a, alpha: a * 0.22 });                           // heat glow
        g.circle(f.x, cy, r).fill({ color: k < 0.4 ? 0xff9a2a : 0xd0561a, alpha: a * 0.9 });
        g.circle(f.x - r * 0.15, cy - r * 0.15, r * 0.55).fill({ color: 0xffe6a0, alpha: Math.max(0, 1 - k * 2.2) });
      } else g.circle(f.x, f.y, fr * (0.6 + 0.4 * a)).fill({ color: f.col, alpha: a });
      if (f.light) S.lightsList.push([f.x, f.y, fr * 3, 0xffb050]);
    }
    // particles
    this.parts = this.parts.filter((p) => (p.t += dt) < p.ttl);
    for (const p of this.parts) {
      if (p.t < 0) continue;
      const k = p.t / p.ttl;
      if (p.kind === 'smoke') {
        const wd = S.wind || WIND; p.x += (p.vx + wd[0] * k) * dt; p.y += (p.vy + wd[1] * k) * dt; p.z += p.vz * dt; p.vx *= 0.97; p.vy *= 0.97;
        const r = p.r * K * (1 + k * p.grow);
        g.circle(p.x, p.y - p.z, r).fill({ color: p.col, alpha: (1 - k) * (1 - k) * p.a });
        continue;
      }
      // debris, dirt, sparks: ballistic in z, they land and settle
      if (p.z > 0 || p.vz > 0) { p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vz -= 90 * dt; if (p.z <= 0) { p.z = 0; p.vz = 0; p.vx = 0; p.vy = 0; p.ttl = Math.min(p.ttl, p.t + 0.3); } }
      const pr = p.r ? p.r * K : 0.8 * K;
      if (p.kind === 'spark') g.rect(p.x - pr / 2, p.y - p.z - pr / 2, pr, pr).fill({ color: p.col, alpha: 1 - k });
      else g.rect(p.x - pr / 2, p.y - p.z - pr / 2, pr, pr).fill({ color: p.col, alpha: p.z > 0 ? 1 : 1 - k });
    }
    this.drawStrikes(g, dt);
    this.drawBattlefield(t, dt);
    this.drawEngagement(t);
  }

  play(e, wk) {
    const S = this.S, D = S.defs;
    const wpn = wk ? D.WEAPONS[wk] : null;
    const src = e.a >= 0 || e.s ? this.pos(e.sb ? 0 : e.s, e.a) : null;
    const dst = this.pos(e.tb ? 0 : e.t, e.b, src ? src[0] : null) || (e.b >= 0 ? [src ? this.v.nx(e.b, src[0]) : this.v.cx[e.b], this.v.cy[e.b]] : null);
    if (!dst || !fin(dst[0], dst[1])) return;
    // strategic strikes are seen from anywhere; everything else only near the view
    if (e.k !== 'mimpact' && !this.v.inView(dst[0], dst[1], 120) && !(src && this.v.inView(src[0], src[1], 120))) return;
    switch (e.k) {
      case 'mintercept': {
        // an interceptor climbs toward the incoming warhead: a smoky streak and a burst high above if it hit
        const x0 = this.v.nx(e.a, dst[0]), y0 = this.v.cy[e.a];
        this.proj.set('mi' + e.i, { x0, y0, x1: dst[0], y1: dst[1] - 60, f: 0.5, t: 0, arc: 0, curve: 4, L: Math.hypot(dst[0] - x0, dst[1] - 60 - y0) || 1, kind: 'missile' });
        if (e.o === 'hit') setTimeout(() => { this.airburst(dst[0], dst[1] - 60, true, e.m); this.explosion(dst[0], dst[1] - 60, 1.6, true, true); }, 450);
        break;
      }
      case 'mimpact': this.strike(dst[0], dst[1], e.r || 2); break;
      case 'fire': {
        if (src) this.muzzle(src, dst, wpn?.tracer === 'heavy' ? 1.2 : 0.8);
        if (src) this.v.smoke?.add(src[0], src[1], 0.03);          // gunsmoke builds up along the firing line
        const n = Math.min(8, e.x || 3);
        for (let i = 0; i < n; i++) {
          const j = (h(e.i, i) - 0.5) * 7, jy = (h(e.i, i, 3) - 0.5) * 6;
          if (src) this.shots.push({ x0: src[0], y0: src[1], x1: dst[0] + j, y1: dst[1] + jy, t: 0, delay: i * 0.07, ttl: 0.14, col: TRACER[wpn?.tracer] || TRACER.light, heavy: wpn?.tracer !== 'light' });
          if (h(e.i, i, 9) < 0.45) this.kick(dst[0] + j, dst[1] + jy, i * 0.07 + 0.1);
        }
        break;
      }
      case 'launch': {
        const kind = wpn?.impact || 'cannon';
        if (kind === 'airburst') {
          // anti-aircraft volley: short tracers rising toward the aircraft (the server resolves the hit)
          if (src) this.muzzle(src, [dst[0], dst[1] - 8], 1);
          const n = Math.min(4, e.x || 3);
          for (let i = 0; i < n; i++) { const j = (h(e.i, i) - 0.5) * 10, jy = (h(e.i, i, 5) - 0.5) * 8; if (src) this.shots.push({ x0: src[0], y0: src[1] - 3, x1: dst[0] + j, y1: dst[1] - 8 + jy, t: 0, delay: i * 0.09, ttl: Math.max(0.2, (e.f || 0.5) * 0.9), col: TRACER.flak, heavy: false }); }
          break;
        }
        const air = src && e.s && D.UNITS[S.units.get(e.s)?.type]?.air;
        const bomb = wk === 'bombs';
        if (src && !bomb) { this.muzzle(src, dst, kind === 'cannon' ? 1.8 : 1.3); if (kind === 'artillery' || kind === 'mortar' || kind === 'cannon') this.puff(src[0], src[1], 2.2, 0xc8c2b6, 0.5); }
        const from = src || [dst[0] + (h(e.i) - 0.5) * 30, dst[1] - 90];     // hidden origin: falls from the sky
        const salvo = e.x || 1;
        for (let s = 0; s < salvo; s++) {
          const x1 = dst[0] + (s ? (h(e.i, s) - 0.5) * 9 : 0), y1 = dst[1] + (s ? (h(e.i, s, 2) - 0.5) * 6 : 0);
          // a bomb leaves the aircraft (drawn at its altitude) and falls onto the ground point below
          const x0 = from[0], y0 = bomb ? from[1] + (air ? 10 : 30) : from[1];
          const pr = { x0, y0, x1, y1, f: Math.max(0.15, (e.f || 0.4) + s * (bomb ? 0.18 : 0.12)), t: 0, arc: !bomb && wpn?.arc ? ARC[kind] || 30 : 0, kind: bomb ? 'bomb' : kind, z0: bomb ? (air ? 10 : 30) : 0, L: Math.hypot(x1 - x0, y1 - y0) || 1 };
          if (wpn?.guided) pr.curve = (h(e.i, s, 4) - 0.5) * 14;
          this.proj.set(s ? e.p + '_' + s : e.p, pr);
        }
        break;
      }
      case 'impact': {
        { const pr = this.proj.get(e.p); if (pr) pr.t = Math.max(pr.t, pr.f); }   // land now, in sync with the server
        const kind = wpn?.impact || 'cannon';
        if (e.ab || kind === 'airburst') { this.airburst(dst[0], dst[1] - 8, e.o === 'hit', e.i); break; }     // in the air: no crater, no ground dust
        const size = (BLAST[kind] || 1) * (wk === 'bombs' ? 1.3 : 1) * (e.r ? 1.15 : 1);
        this.explosion(dst[0], dst[1], size, e.o === 'miss' && kind === 'cannon');
        if ((kind === 'artillery' || kind === 'missile') && this.v.inView(dst[0], dst[1], 0)) this.v.shake = Math.max(this.v.shake, 0.18);
        break;
      }
      case 'hit': if (e.d > 0) { this.sparks(dst[0], dst[1], 3, 0xffc070); const mine = S.units.get(e.t); if (mine && mine.owner === S.civId) this.recentHits.set(e.t, { t: this.clock, from: e.a }); } break;
      case 'bhit': this.dirt(dst[0], dst[1], 4, 0.9, 0x9a8c76); this.puff(dst[0], dst[1], 3, 0x9a9086, 0.4); break;
      case 'kill': {
        const inf = D.UNITS[e.ty]?.move === 'infantry';
        if (inf) { this.dirt(dst[0], dst[1], 3, 0.7, 0x7a6a56); break; }
        this.explosion(dst[0], dst[1], 1.3, false);
        // a vehicle brews up: secondary flashes, then a column of black smoke that rises for a while
        for (let i = 1; i <= 2; i++) this.flashes.push({ x: dst[0] + (h(e.i, i) - 0.5) * 4, y: dst[1] - 2, r: 3.5, t: -0.25 * i, ttl: 0.4 + 0.25 * i, fire: true });
        this.columns.push({ x: dst[0], y: dst[1], t: 0, ttl: 28, acc: 0, r: 2.8 });
        break;
      }
      case 'bkill': {
        this.explosion(dst[0], dst[1], 2.2, false);
        this.columns.push({ x: dst[0], y: dst[1], t: 0, ttl: 45, acc: 0, r: 4.5 });
        for (let i = 0; i < 6; i++) this.puff(dst[0] + (h(e.i, i) - 0.5) * 16, dst[1] + (h(e.i, i, 2) - 0.5) * 12, 5, 0x5a524a, 0.5);
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------ effect building blocks
  muzzle(src, dst, size) {
    const dx = dst[0] - src[0], dy = dst[1] - src[1], l = Math.hypot(dx, dy) || 1;
    this.flashes.push({ x: src[0] + (dx / l) * 3, y: src[1] + (dy / l) * 3, dx: dx / l, dy: dy / l, r: 3.2 * size, t: 0, ttl: 0.07, cone: true, light: size > 1.2 });
  }
  // a bullet striking the ground: a tiny spurt of dirt
  kick(x, y, delay) {
    if (this.full() || this.S.lod === 'strategic') return;
    for (let i = 0; i < 2; i++) this.parts.push({ kind: 'dirt', x, y, z: 0.1, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 5, vz: 14 + Math.random() * 10, r: 0.7, col: 0xa8987c, t: -delay, ttl: 0.5 });
  }
  dirt(x, y, n, size, col) {
    n = Math.max(1, Math.round(n * Math.min(1.6, this.S.particleScale ?? 1)));
    if (this.full()) return;
    for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, sp = 6 + Math.random() * 14; this.parts.push({ kind: 'dirt', x, y, z: 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.7, vz: 22 + Math.random() * 22, r: size, col, t: 0, ttl: 1.2 }); }
  }
  sparks(x, y, n, col) {
    if (this.full() || this.S.lod === 'strategic') return;
    for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, sp = 12 + Math.random() * 18; this.parts.push({ kind: 'spark', x, y, z: 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6, vz: 10 + Math.random() * 20, col, t: 0, ttl: 0.35 }); }
  }
  puff(x, y, r, col, a = 0.35) {
    if (this.full()) return;
    this.parts.push({ kind: 'smoke', x, y, z: 1, vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 0.5) * 2, vz: 3 + Math.random() * 4, r, grow: 1.8, col, a, t: 0, ttl: 2.6 + Math.random() });
  }
  // Flak: a few staggered bursts in the air near the aircraft — a white-yellow flash, a small
  // expanding ring, dark grey puffs and a few sparks; nothing touches the ground.
  airburst(x, y, hit, seed) {
    const S = this.S, scale = Math.min(1.6, S.particleScale ?? 1);
    const reduced = S.prefs?.reducedMotion;
    const n = reduced ? 1 : S.lod === 'strategic' ? 1 : Math.max(1, Math.round(3 * scale));
    for (let i = 0; i < n; i++) {
      const bx = x + (h(seed, i) - 0.5) * 12, by = y + (h(seed, i, 7) - 0.5) * 9, d = i * 0.11;
      this.flashes.push({ x: bx, y: by, r: 2.2, col: 0xfff2b0, t: -d, ttl: 0.1 + d, light: !reduced });
      if (S.lod !== 'strategic') this.flashes.push({ x: bx, y: by, r: 5, w: 0.8, ring: true, t: -d, ttl: 0.35 + d });
      if (this.full() || reduced || S.lod === 'strategic') continue;
      for (let k = 0; k < 2; k++) this.parts.push({ kind: 'smoke', x: bx + (Math.random() - 0.5) * 3, y: by, z: 0, vx: (Math.random() - 0.5) * 3, vy: 0, vz: 1, r: 2.2 + k, grow: 1.2, col: 0x3d3b39, a: 0.55, t: -d, ttl: 1.3 });
    }
    if (hit) this.sparks(x, y, 4, 0xffa060);
    this.audioCue?.('airburst', x, y);
  }

  // A shell or bomb going off: a short white core, a fireball, a thin shock ring, a plume of
  // dirt thrown up that lands around the hole, and dust that hangs and drifts. Sizes stay small:
  // the battlefield should read as many small violent events, not a field of giant flashes.
  explosion(x, y, size, small, inAir) {
    const S = this.S;
    this.flashes.push({ x, y, r: 3 * size, col: 0xfff6dc, t: 0, ttl: 0.07, light: true });
    this.flashes.push({ x, y, r: 4.6 * size, t: 0, ttl: 0.42 + 0.1 * size, fire: true });
    if (size >= 1.1) this.flashes.push({ x: x + (Math.random() - 0.5) * 3 * size, y: y - 1, r: 3 * size, t: -0.06, ttl: 0.36, fire: true });   // a second, ragged lobe
    if (!small) this.flashes.push({ x, y, r: 15 * size, w: 1.3, ring: true, a: 0.4, t: 0, ttl: 0.32 });
    if (!inAir && size >= 1.1) this.scorch.push({ x, y, r: 3.2 * size, t: 0, ttl: 25 });
    if (this.full()) return;
    const sc = Math.min(1.6, S.particleScale ?? 1);
    if (!inAir) {
      const n = Math.round((small ? 4 : 8) * size * sc);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, sp = 6 + Math.random() * 16 * size;
        this.parts.push({ kind: 'dirt', x, y, z: 1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.65, vz: 26 + Math.random() * 30 * size, r: 0.7 + Math.random() * 0.9, col: i % 3 ? 0x4a3f34 : 0x7d6c58, t: 0, ttl: 1.6 + Math.random() * 0.8 });
      }
    }
    // the burst's smoke joins the battle's drifting smoke; one dark puff marks the burst itself
    if (!inAir) this.v.smoke?.add(x, y, 0.22 * size);
    this.puff(x, y, 2.6 * size, inAir ? 0x4a4642 : 0x4a443e, 0.45);
    if (!small) this.sparks(x, y, Math.round(2 * size), 0xffd080);
  }

  // ------------------------------------------------------------ strategic missiles
  // A detonation over a zone: a blinding flash, the shockwave racing outward across the blast radius
  // (a bright front with a dust wall dragged behind it), a fireball that rises into a mushroom
  // cloud, and a scorched ground mark that stays for a long time.
  strike(x, y, radius) {
    const R = Math.max(1.5, radius) * HEX;
    this.strikes.push({ x, y, R, t: 0, ttl: 14, puffT: 0 });
    this.scorch.push({ x, y, r: R * 0.75, t: 0, ttl: 90 });
    if (this.v.inView(x, y, 200)) this.v.shake = Math.max(this.v.shake, 0.8);
    for (let i = 0; i < 14; i++) { const a = (i / 14) * 6.283, r = R * (0.15 + 0.35 * h(i, 3)); this.explosion(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.7, 1.6, true); }
    this.audioCue?.('strike', x, y);
  }
  drawStrikes(g, dt) {
    this.strikes = this.strikes.filter((s) => (s.t += dt) < s.ttl);
    for (const s of this.strikes) {
      const { x, y, R, t } = s;
      // flash: fills the zone white for an instant
      if (t < 0.5) { const a = 1 - t / 0.5; g.circle(x, y, R * (0.6 + 0.6 * t)).fill({ color: 0xfffbea, alpha: 0.75 * a }); this.S.lightsList.push([x, y, R * 2, 0xfff0c0]); }
      // the shockwave: front expands fast then slows, flattened to the ground plane
      if (t < 2.2) {
        const k = Math.min(1, t / 1.6), r = R * 1.6 * (1 - (1 - k) ** 2.2), a = 1 - t / 2.2;
        g.ellipse(x, y, r, r * 0.78).stroke({ width: 5 * a + 1, color: 0xfff4d8, alpha: 0.55 * a });
        g.ellipse(x, y, r * 0.93, r * 0.93 * 0.78).stroke({ width: 9 * a + 1, color: 0xb8a486, alpha: 0.35 * a });   // the dust wall behind the front
        g.ellipse(x, y, r * 0.8, r * 0.8 * 0.78).fill({ color: 0xe0d0b0, alpha: 0.08 * a });
        if (!this.full() && (s.dust = (s.dust || 0) + dt) > 0.05) {
          s.dust = 0;
          for (let i = 0; i < 6; i++) { const ang = Math.random() * 6.283; this.parts.push({ kind: 'smoke', x: x + Math.cos(ang) * r, y: y + Math.sin(ang) * r * 0.78, z: 0, vx: Math.cos(ang) * 10, vy: Math.sin(ang) * 8, vz: 1.5, r: 3, grow: 2.4, col: 0xa89a80, a: 0.4, t: 0, ttl: 3 }); }
        }
      }
      // fireball rising into the cap, the stem below it
      const rise = Math.min(1, t / 6), capY = y - 10 - rise * 55, k = t / s.ttl;
      if (t < 4) { const a = 1 - t / 4; g.circle(x, capY, R * (0.35 + 0.25 * rise)).fill({ color: 0xff8a2a, alpha: 0.7 * a }); g.circle(x, capY, R * 0.2).fill({ color: 0xffe0a0, alpha: 0.8 * a }); }
      if ((s.puffT += dt) > 0.12 && t < 9 && !this.full()) {
        s.puffT = 0;
        const cr = R * (0.3 + 0.35 * rise);
        for (let i = 0; i < 3; i++) { const ang = Math.random() * 6.283, d = Math.random() * cr; this.parts.push({ kind: 'smoke', x: x + Math.cos(ang) * d, y, z: (y - capY) + Math.sin(ang) * d * 0.4, vx: Math.cos(ang) * 2, vy: 0, vz: 0.8, r: 6 + Math.random() * 5, grow: 1.3, col: t < 2 ? 0x8a5a3a : i ? 0x5a524c : 0x777068, a: 0.55, t: 0, ttl: 6 }); }
        this.parts.push({ kind: 'smoke', x: x + (Math.random() - 0.5) * 6, y, z: Math.random() * (y - capY), vx: 0, vy: 0, vz: 2, r: 3.5, grow: 1, col: 0x5a524c, a: 0.45, t: 0, ttl: 4 });
      }
      void k;
    }
  }

  // Strategic missiles in flight: boost (a bright exhaust with a thick smoke trail standing in the
  // sky), midcourse (a small point high up), re-entry (a glowing streak). The aim point pulses.
  drawMissiles(g, dt) {
    const S = this.S, v = this.v, list = S.ms?.m;
    if (!list?.length) { if (this.mtrail.size) this.mtrail.clear(); return; }
    const now = S.time + (performance.now() - (S.timeAt || performance.now())) / 1000;
    const live = new Set();
    for (const [id, from, to, at, arrive, owner] of list) {
      live.add(id);
      const x1 = v.cx[to], y1 = v.cy[to], x0 = v.nx(from, x1), y0 = v.cy[from];
      const k = Math.max(0, Math.min(1, (now - at) / Math.max(0.1, arrive - at)));
      const H = Math.min(260, Math.hypot(x1 - x0, y1 - y0) * 0.45);
      // a ballistic path: slow climb out, fast fall in (the warhead accelerates on the way down)
      const ease = (p) => p < 0.5 ? 0.5 * Math.pow(p * 2, 1.25) : 1 - 0.5 * Math.pow((1 - p) * 2, 0.8);
      const P = (p) => { const q = ease(p); return [x0 + (x1 - x0) * q, y0 + (y1 - y0) * q - Math.sin(Math.PI * q) * H]; };
      const col = owner === S.civId ? 0x8fe0a8 : 0xff5a3c;
      // the planned path, faint
      for (let i = 0; i < 24; i++) { const [ax, ay] = P(i / 24), [bx, by] = P((i + 0.5) / 24); g.moveTo(ax, ay).lineTo(bx, by); }
      g.stroke({ width: 1.2 / Math.max(0.5, v.cam.z), color: col, alpha: 0.4 });
      // the trail actually flown: thick and white during boost, thinning as it dissipates
      const [mx, my] = P(k);
      const tr = this.mtrail.get(id) || []; this.mtrail.set(id, tr);
      if (!tr.length || Math.hypot(mx - tr[tr.length - 1][0], my - tr[tr.length - 1][1]) > 2) tr.push([mx, my, now, k]);
      for (let i = 1; i < tr.length; i++) {
        const age = now - tr[i][2], boost = tr[i][3] < 0.22;
        const a = Math.max(0, (boost ? 0.7 : 0.35) * (1 - age / (boost ? 30 : 8)));
        if (a <= 0.01 || Math.abs(tr[i][0] - tr[i - 1][0]) > 80) continue;
        g.moveTo(tr[i - 1][0], tr[i - 1][1]).lineTo(tr[i][0], tr[i][1]).stroke({ width: (boost ? 4 : 1.5) + age * 0.15, color: 0xe8e4dc, alpha: a });
      }
      if (k < 0.22) { g.circle(mx, my + 2, 4).fill({ color: 0xffb040, alpha: 0.8 }); g.circle(mx, my + 1, 2).fill({ color: 0xffffff }); S.lightsList.push([mx, my, 14, 0xffa040]); }
      else if (k > 0.82) { const [px, py] = P(k - 0.03); g.moveTo(px, py).lineTo(mx, my).stroke({ width: 3, color: 0xffa060, alpha: 0.8 }); g.circle(mx, my, 2.6).fill({ color: 0xfff0c0 }); }
      else g.circle(mx, my, 2.2).fill({ color: 0xffffff }).stroke({ width: 1.2, color: col });
      // the aim point: readable at any zoom (sizes in screen pixels), the blast radius shaded
      const zs = 1 / Math.max(0.35, v.cam.z), pulse = 0.5 + 0.5 * Math.sin(now * 6 + id);
      g.circle(x1, y1, HEX * 2.5).fill({ color: col, alpha: 0.06 + 0.06 * pulse });
      for (const r of [1, 2]) g.circle(x1, y1, (r * 12 + pulse * 4) * zs).stroke({ width: 2.5 * zs, color: col, alpha: 0.95 - r * 0.25 });
      g.moveTo(x1 - 10 * zs, y1).lineTo(x1 + 10 * zs, y1).moveTo(x1, y1 - 10 * zs).lineTo(x1, y1 + 10 * zs).stroke({ width: 2 * zs, color: col });
    }
    for (const id of this.mtrail.keys()) if (!live.has(id)) this.mtrail.delete(id);
    void dt;
  }

  // ------------------------------------------------------------ persistent battlefield
  // Drawn at base positions on mirrored layers (like the terrain), so it never needs redrawing when
  // the camera moves round a wrapped world.
  syncBattlefield(bf) {
    const S = this.S, v = this.v;
    S.bf = bf || { c: [], w: [], s: [], i: [], fp: [] };
    // standing water in craters follows the weather: redraw when the ground near them gets wetter or dries
    const wf = v.wxField, wetAt = (x, y) => (wf && wf.ready ? wf.at('wet', x, y) : 0);
    const wetKey = (S.bf.c || []).concat(S.bf.i || []).map(([t]) => Math.round(wetAt(v.cx[t], v.cy[t]) * 3)).join('');
    const key = JSON.stringify([S.bf.c, (S.bf.w || []).map((x) => [x[0], x[1], x[2]]), S.bf.i || [], S.bf.fp || [], S.ms?.fo || [], wetKey]);
    if (key === this.bfKey) return;
    this.bfKey = key;
    const X = v.cx0 || v.cx, N = v.N || X.length;
    const ok = (t) => Number.isInteger(t) && t >= 0 && t < N;
    const g = this.decalG; g.clear();
    // no man's land: connected scarred ground, crater fields, shattered woods, wire along the front
    drawBattlefieldTerrain(g, v, S, X, ok, wetAt);
    // fallout: a sickly hatched tint where nothing can be farmed and troops sicken
    for (const t of S.ms?.fo || []) {
      if (!ok(t)) continue;
      const x = X[t], y = v.cy[t], hp = v.hexPoints(t, 0).map((c, k) => (k % 2 ? c : c - v.cx[t] + x));
      g.poly(hp).fill({ color: 0x9fb03a, alpha: 0.22 });
      for (let k = -2; k <= 2; k++) g.moveTo(x - 9 + k * 4, y + 7).lineTo(x - 3 + k * 4, y - 7);
      g.stroke({ width: 0.8, color: 0xc8d25a, alpha: 0.5 });
    }
    // temporary field positions: small crescent scrapes with a lip of spoil, tinted to the owner
    for (const [t, o] of S.bf.fp || []) {
      if (!ok(t)) continue;
      const x = X[t], y = v.cy[t];
      for (let k = 0; k < 3; k++) {
        const ox = (k - 1) * 5 + (h(t, k, 51) - 0.5) * 2, oy = (h(t, k, 52) - 0.5) * 4 + 2;
        g.ellipse(x + ox, y + oy - 0.8, 2.6, 1.2).fill({ color: 0x7a6a50, alpha: 0.9 });
        g.ellipse(x + ox, y + oy + 0.4, 2, 1).fill({ color: 0x2a231b, alpha: 0.85 });
      }
      g.circle(x + 8, y - 3, 1).fill({ color: S.civColor(o), alpha: 0.8 });
    }
    // craters: each a ring of thrown earth, a deep bowl shaded from the top-left, scaled by depth
    for (const [t, d0] of S.bf.c) {
      if (!ok(t)) continue;
      const d = Math.max(1, Math.min(4, d0 | 0)), x = X[t], y = v.cy[t];
      const wet = wetAt(x, y);
      for (let k = 0; k < d + 1; k++) {
        const ox = (h(t, k) - 0.5) * 11, oy = (h(t, k, 2) - 0.5) * 8, r = 1.6 + d * 0.55 + h(t, k, 3) * 1.1;
        hole(g, x + ox, y + oy, r, wet, true);
      }
    }
    const w = this.wreckG; w.clear();
    (S.bf.w || []).forEach(([t, type, burning, owner], i) => {
      const def = S.defs.UNITS[type]; if (!def || !ok(t)) return;
      const x = X[t] + (h(t, i) - 0.5) * 9, y = v.cy[t] + (h(t, i, 4) - 0.5) * 7, a = h(t, i, 9) * Math.PI;
      const L = def.move === 'tracked' ? 6 : def.air ? 5 : 5, Wd = def.move === 'tracked' ? 3.6 : 2.8;
      const c = Math.cos(a), s = Math.sin(a);
      const box = (l, wd, ox = 0) => [[-l + ox, -wd], [l + ox, -wd], [l + ox, wd], [-l + ox, wd]].flatMap(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
      w.ellipse(x, y, L + 2.5, Wd + 2).fill({ color: 0x15110d, alpha: 0.35 });                          // scorch under it
      w.poly(box(L, Wd)).fill({ color: 0x2a2622 }).stroke({ width: 0.6, color: S.civColor(owner), alpha: 0.45 });
      if (def.move === 'tracked') { w.poly(box(L, 0.9, 0).map((p, k) => p + (k % 2 ? c * (Wd - 0.5) : -s * (Wd - 0.5)))).fill({ color: 0x14110e }); w.circle(x + c * 1.2, y + s * 1.2, 2).fill({ color: 0x1a1714 }); w.moveTo(x + c * 1.2, y + s * 1.2).lineTo(x + c * 1.2 + Math.cos(a + 0.7) * 5, y + s * 1.2 + Math.sin(a + 0.7) * 5).stroke({ width: 1, color: 0x1a1714 }); }
      w.circle(x - 1, y - 1, 1.4).fill({ color: burning ? 0x5a2a14 : 0x3a3430 });
    });
  }

  drawBattlefield(t, dt) {
    const S = this.S, v = this.v, g = this.smokeG; g.clear();
    const bf = S.bf;
    // smoke columns from destroyed vehicles: puffs rise and lean with the wind
    this.columns = this.columns.filter((c) => (c.t += dt) < c.ttl);
    for (const c of this.columns) {
      if (this.full() || !v.inView(c.x, c.y, 60)) continue;
      this.v.smoke?.add(c.x, c.y, 0.35 * dt);
      if ((c.acc += dt) > 0.16) { c.acc = 0; const k = c.t / c.ttl; this.parts.push({ kind: 'smoke', x: c.x + (Math.random() - 0.5) * 2, y: c.y, z: 2, vx: 0, vy: 0, vz: 7 + Math.random() * 3, r: c.r * (1 - k * 0.5), grow: 2.4, col: k < 0.5 ? 0x26221f : 0x4a4540, a: 0.55 * (1 - k * 0.6), t: 0, ttl: 4.5 }); }
      if (c.t < c.ttl * 0.6) {
        const K = this.K || 1;
        for (let k = 0; k < 3; k++) { const j = Math.sin(t * 11 + c.x + k * 2.1) * 0.9; g.circle(c.x + (k - 1) * 1.3 * K + j * 0.4, c.y - (1.5 + Math.abs(j)) * K, (1.2 + (k % 2) * 0.7) * K).fill({ color: k % 2 ? 0xffb02e : 0xff5a14, alpha: 0.9 }); }
        S.lightsList.push([c.x, c.y, 10 * K, 0xff7a2a]);
      }
    }
    if (!bf) return;
    // burning wrecks (only what we can see: a remembered wreck does not keep burning for us)
    for (const [tile, , burning] of bf.w || []) {
      if (!burning || !this.seen(tile)) continue;
      const x = v.cx[tile], y = v.cy[tile]; if (!v.inView(x, y, 30)) continue;
      for (let k = 0; k < 4; k++) { const j = Math.sin(t * 10 + k * 1.9 + tile) * 1.2; g.circle(x - 2 + k * 1.4 + j * 0.3, y - 2 - Math.abs(j) * 1.6, 1.2 + (k % 2) * 0.8).fill({ color: k % 2 ? 0xffb02e : 0xff5a14, alpha: 0.9 }); }
      for (let k = 0; k < 4; k++) { const age = frac(t * 0.22 + k / 4 + h(tile, k)); g.circle(x + age * 6, y - 4 - age * 18, 1.5 + age * 3.5).fill({ color: 0x2a2622, alpha: (1 - age) * 0.4 }); }
      S.lightsList.push([x, y, 9, 0xff7a2a]);
      this.v.smoke?.add(x, y, 0.2 * dt);
    }
    // a battle in progress: a dusky glow where the guns are firing, flickers of fire through the
    // smoke, and gunsmoke hanging low over the ground being fought over (at every zoom)
    const KB = this.K || 1;
    for (const b of S.battles || []) {
      if (!this.seen(b.t)) continue;
      const x = v.cx[b.t], y = v.cy[b.t]; if (!v.inView(x, y, 80)) continue;
      const heat = Math.min(1, 0.4 + (b.n || 0) / 30);
      g.circle(x, y, 26 * KB).fill({ color: 0xff8a3a, alpha: 0.05 * heat * (0.8 + 0.2 * Math.sin(t * 3 + b.t)) });
      for (let k = 0; k < 5; k++) {
        const ph = frac(t * (1.3 + h(b.t, k, 40)) + h(b.t, k, 41));
        if (ph > 0.18) continue;
        const fx = x + (h(b.t, k, Math.floor(t * 1.3 + k)) - 0.5) * 34, fy = y + (h(b.t, k, Math.floor(t * 1.3 + k) + 9) - 0.5) * 24;
        g.circle(fx, fy, 2.2 * KB * (1 - ph / 0.18)).fill({ color: 0xffd890, alpha: 0.7 * heat * (1 - ph / 0.18) });
      }
    }
    // smoke screens are drawn by the battle smoke (BattleSmoke), which they feed
  }

  // ------------------------------------------------------------ engagement overlay
  drawEngagement(t) {
    const S = this.S, v = this.v, g = this.engageG; g.clear();
    const z = v.cam.z;
    // aggregate the selection's fire by target: one arrow per target, thicker with more shooters
    const byTarget = new Map();
    for (const id of S.selUnits) {
      const u = S.units.get(id); if (!u || u.owner !== S.civId || !u.tgt) continue;
      const a = byTarget.get(u.tgt) || []; a.push(u); byTarget.set(u.tgt, a);
    }
    for (const [tg, arr] of byTarget) {
      const a0 = this.pos(arr[0].id, arr[0].tile); if (!a0) continue;
      let sx = 0, sy = 0, n = 0; for (const u of arr) { const p = this.pos(u.id, u.tile, a0[0]); if (!p) continue; sx += p[0]; sy += p[1]; n++; } if (!n) continue; sx /= n; sy /= n;
      const tp = tg > 0 ? this.pos(tg, S.units.get(tg)?.tile ?? -1, sx) : (() => { const b = S.buildings.get(-tg); return b ? [v.nx(b.t, sx), v.cy[b.t]] : null; })();
      if (!tp) continue;
      const focus = S.focusSet?.has(tg);
      const w = Math.min(4.5, 1 + arr.length * 0.35) / Math.max(0.6, z * 0.8);
      // dashed shaft from the shooters toward the target
      const dx = tp[0] - sx, dy = tp[1] - sy, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const ph = (t * 30) % 8;
      for (let d = ph; d < L - 8; d += 8) g.moveTo(sx + ux * d, sy + uy * d).lineTo(sx + ux * Math.min(L - 8, d + 4.5), sy + uy * Math.min(L - 8, d + 4.5));
      g.stroke({ width: w, color: 0xf1c75b, alpha: 0.75 });
      g.poly([tp[0] - ux * 6, tp[1] - uy * 6, tp[0] - ux * 11 - uy * 3.5, tp[1] - uy * 11 + ux * 3.5, tp[0] - ux * 11 + uy * 3.5, tp[1] - uy * 11 - ux * 3.5]).fill({ color: 0xf1c75b, alpha: 0.85 });
      // target reticle: square brackets for focus fire, a ring for distributed fire
      const r = 8;
      if (focus) { for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.moveTo(tp[0] + cx * r, tp[1] + cy * (r - 4)).lineTo(tp[0] + cx * r, tp[1] + cy * r).lineTo(tp[0] + cx * (r - 4), tp[1] + cy * r); g.stroke({ width: 1.6, color: 0xe0533b }); }
      else g.circle(tp[0], tp[1], r).stroke({ width: 1.2, color: 0xf1c75b, alpha: 0.9 });
      for (let i = 0; i < Math.min(arr.length, 12); i++) { const a = -Math.PI / 2 + (i - (Math.min(arr.length, 12) - 1) / 2) * 0.32; g.circle(tp[0] + Math.cos(a) * (r + 3.5), tp[1] + Math.sin(a) * (r + 3.5), 1).fill({ color: 0xf1c75b }); }
    }
    // hovered unit: its own line, whoever owns it
    const hu = S.hoverUnit != null ? S.units.get(S.hoverUnit) : null;
    if (hu && hu.tgt && !byTarget.size) { const a = this.pos(hu.id, hu.tile), b = hu.tgt > 0 && a ? this.pos(hu.tgt, S.units.get(hu.tgt)?.tile ?? -1, a[0]) : null; if (a && b) g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: 1, color: 0xf1c75b, alpha: 0.7 }); }
    // incoming fire on own selected units: red chevrons pointing from where it came
    for (const [id, hit] of this.recentHits) {
      if (this.clock - hit.t > 2.5) { this.recentHits.delete(id); continue; }
      if (!S.selUnits.has(id)) continue;
      const p = this.pos(id, S.units.get(id)?.tile ?? -1); if (!p) continue;
      const a = 1 - (this.clock - hit.t) / 2.5;
      let ang = -Math.PI / 2;
      if (hit.from >= 0) ang = Math.atan2(v.cy[hit.from] - p[1], v.nx(hit.from, p[0]) - p[0]);
      const cx = p[0] + Math.cos(ang) * 11, cy = p[1] + Math.sin(ang) * 11;
      for (let k = 0; k < 2; k++) { const o = k * 3.5; g.moveTo(cx + Math.cos(ang) * o + Math.cos(ang + 2.4) * 4, cy + Math.sin(ang) * o + Math.sin(ang + 2.4) * 4).lineTo(cx + Math.cos(ang) * o, cy + Math.sin(ang) * o).lineTo(cx + Math.cos(ang) * o + Math.cos(ang - 2.4) * 4, cy + Math.sin(ang) * o + Math.sin(ang - 2.4) * 4); }
      g.stroke({ width: 1.6, color: 0xe0533b, alpha: a });
    }
    // suppression: pinned units show it (any visible unit; it is observable)
    if (atLeast(S, 'city')) for (const u of S.units.values()) {
      if (!(u.supp >= 40)) continue;
      const p = this.pos(u.id, u.tile); if (!p || !v.inView(p[0], p[1], 10)) continue;
      const n = u.supp >= 75 ? 3 : u.supp >= 60 ? 2 : 1;
      for (let i = 0; i < n; i++) g.rect(p[0] - 5 + i * 3.6, p[1] + 9, 2.6, 1.4).fill({ color: 0xf0b54a });
    }
    // battle markers: crossed blades with a pulse; at strategic zoom they stand in for the effects
    if (S.lod !== 'micro') for (const b of S.battles || []) {
      const x = v.cx[b.t], y = v.cy[b.t] - (S.lod === 'city' ? 26 : 0); if (!v.inView(x, y, 60)) continue;
      const s = Math.max(1, 0.9 / z), pulse = 1 + 0.25 * Math.sin(t * 4);
      g.circle(x, y, 13 * s * pulse).stroke({ width: 1.6 * s, color: 0xe0533b, alpha: 0.55 });
      g.circle(x, y, 9 * s).fill({ color: 0x2a0f0b, alpha: 0.85 }).stroke({ width: 1.2 * s, color: 0xe0533b });
      g.moveTo(x - 5 * s, y - 5 * s).lineTo(x + 5 * s, y + 5 * s).moveTo(x + 5 * s, y - 5 * s).lineTo(x - 5 * s, y + 5 * s).stroke({ width: 1.8 * s, color: 0xf3eedf });
    }
  }

  battleAt(sx, sy) {
    if (this.S.lod === 'micro') return null;
    for (const b of this.S.battles || []) { const [x, y] = this.v.worldToScreen(this.v.cx[b.t], this.v.cy[b.t] - (this.S.lod === 'city' ? 26 : 0)); if ((x - sx) ** 2 + (y - sy) ** 2 < 20 * 20) return b; }
    return null;
  }
}
