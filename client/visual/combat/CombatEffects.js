// Combat presentation. The server decides every outcome; this replays its event stream:
//   weapon_fired -> muzzle flash + tracer burst (hitscan) | launch -> projectile that lands when
//   the server's impact does | impact -> blast, shockwave, debris, dust | hit / kill -> flashes.
// Also draws the persistent battlefield (craters, wrecks, smoke), the engagement overlay for the
// selection (who is shooting whom, incoming fire, target markers) and battle markers.
/* global PIXI */
import { h, frac, atLeast } from '../VisualLOD.js';

const TRACER = { light: 0xffe9a8, heavy: 0xffc46a, flak: 0xfff0d0 };
const BLAST = { cannon: 1, rocket: 1.1, mortar: 1.4, missile: 1.7, artillery: 2.1 };
const ARC = { mortar: 34, artillery: 46 };
const MAX_PARTICLES = 1400;

export class CombatEffects {
  constructor(view, S) {
    this.v = view; this.S = S;
    this.queue = []; this.parts = []; this.shots = []; this.proj = new Map(); this.flashes = [];
    this.recentHits = new Map();          // own unit id -> { t, from }
    this.clock = 0;
  }

  // layers are created by the view so they interleave correctly with terrain, buildings and units
  attach({ decal, wreck, fx, smoke, engage }) { this.decalG = decal; this.wreckG = wreck; this.fxG = fx; this.smokeG = smoke; this.engageG = engage; }

  // near: an x the result should be placed next to (the other end of a shot or arrow), so lines
  // across the world seam stay short
  pos(id, tile, near) {
    const s = id ? this.v.unitSprites.get(id) : null;
    const p = s ? [s.dx, s.dy] : tile >= 0 ? [this.v.cx[tile], this.v.cy[tile]] : null;
    if (p && near != null && this.v.wrap) p[0] = this.v.near(p[0], near);
    return p;
  }
  // a precision recentre of the camera moved the world by whole periods: move live effects with it
  shift(dx) {
    for (const a of [this.parts, this.shots, this.flashes]) for (const p of a) { if (p.x != null) p.x += dx; if (p.x0 != null) { p.x0 += dx; p.x1 += dx; } }
    for (const p of this.proj.values()) { p.x0 += dx; p.x1 += dx; if (p.trail) for (const q of p.trail) if (q && q.x != null) q.x += dx; else if (Array.isArray(q)) q[0] += dx; }
  }

  // Events of one snapshot arrive together; spread them over the 0.2 s they actually span.
  ingest(evs, tick) {
    const W = this.S.defs.WEAPON_KEYS;
    for (const e of evs) {
      const delay = Math.max(0, Math.min(0.25, ((e.n - (tick - 2)) * 0.1)));
      this.queue.push({ at: this.clock + delay, e, w: e.w != null ? W[e.w] : null });
    }
  }

  frame(dt, t) {
    this.clock += dt;
    const S = this.S, v = this.v;
    // play due events
    if (this.queue.length) {
      const due = []; this.queue = this.queue.filter((q) => (q.at <= this.clock ? (due.push(q), false) : true));
      for (const q of due) this.play(q.e, q.w);
    }
    const g = this.fxG; g.clear();
    const lodStrategic = S.lod === 'strategic';
    // strategic strikes: the flash stays visible at every zoom level
    if (this.flashes?.length) {
      this.flashes = this.flashes.filter((f) => (f.t += dt) < f.ttl);
      for (const f of this.flashes) { const k = f.t / f.ttl, r = 20 + 90 * Math.sqrt(k); g.circle(f.x, f.y, r).fill({ color: 0xfff1c8, alpha: 0.55 * (1 - k) }); g.circle(f.x, f.y, r * 1.5).stroke({ width: 3, color: 0xffb060, alpha: 0.5 * (1 - k) }); }
    }
    this.drawMissiles(g);
    // tracers
    this.shots = this.shots.filter((s) => (s.t += dt) < s.delay + s.ttl);
    if (!lodStrategic) for (const s of this.shots) {
      if (s.t < s.delay) continue;
      const p = (s.t - s.delay) / s.ttl;
      const hx = s.x0 + (s.x1 - s.x0) * Math.min(1, p * 1.4), hy = s.y0 + (s.y1 - s.y0) * Math.min(1, p * 1.4);
      const tx = s.x0 + (s.x1 - s.x0) * Math.max(0, p * 1.4 - 0.35), ty = s.y0 + (s.y1 - s.y0) * Math.max(0, p * 1.4 - 0.35);
      g.moveTo(tx, ty).lineTo(hx, hy).stroke({ width: s.heavy ? 1.1 : 0.7, color: s.col, alpha: 0.9 * (1 - p * 0.5) });
    }
    // projectiles in flight
    for (const [id, p] of this.proj) {
      p.t += dt;
      const k = Math.min(1, p.t / p.f);
      const x = p.x0 + (p.x1 - p.x0) * k, y = p.y0 + (p.y1 - p.y0) * k - Math.sin(k * Math.PI) * p.arc;
      if (k >= 1) { if (p.t > p.f + 0.6) this.proj.delete(id); continue; }
      if (!lodStrategic || p.arc) {
        if (p.kind === 'missile' || p.kind === 'rocket') { p.trail.push([x, y]); if (p.trail.length > 10) p.trail.shift(); for (let i = 1; i < p.trail.length; i++) g.moveTo(p.trail[i - 1][0], p.trail[i - 1][1]).lineTo(p.trail[i][0], p.trail[i][1]).stroke({ width: 1.4, color: 0xd8d4cc, alpha: (i / p.trail.length) * 0.5 }); }
        g.circle(x, y, p.arc ? 1.5 : 1.1).fill({ color: p.kind === 'cannon' ? 0xffd27a : 0xfff0c0 });
        if (p.arc && k < 0.5) g.circle(x, y, 2.6).fill({ color: 0xffd27a, alpha: 0.25 });
      }
    }
    // flashes (muzzle, impact)
    this.flashes = this.flashes.filter((f) => (f.t += dt) < f.ttl);
    for (const f of this.flashes) {
      if (f.t < 0) continue;              // staggered: not yet
      const a = 1 - f.t / f.ttl;
      if (f.ring) g.circle(f.x, f.y, f.r * (0.4 + 1.4 * (1 - a))).stroke({ width: 1.2 * f.size, color: 0xfff2d8, alpha: a * 0.7 });
      else g.circle(f.x, f.y, f.r * (0.6 + 0.4 * a)).fill({ color: f.col, alpha: a });
      if (f.light) S.lightsList.push([f.x, f.y, f.r * 3, 0xffb050]);
    }
    // particles: debris, dust, sparks
    this.parts = this.parts.filter((p) => (p.t += dt) < p.ttl);
    for (const p of this.parts) {
      if (p.t < 0) continue;
      const k = p.t / p.ttl;
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; p.vx *= 0.96;
      if (lodStrategic && p.kind !== 'smoke') continue;
      if (p.kind === 'smoke') g.circle(p.x, p.y, p.r * (1 + k * 2.2)).fill({ color: p.col, alpha: (1 - k) * 0.35 });
      else g.rect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r).fill({ color: p.col, alpha: 1 - k });
    }
    this.drawBattlefield(t);
    this.drawEngagement(t);
  }

  play(e, wk) {
    const S = this.S, D = S.defs;
    const wpn = wk ? D.WEAPONS[wk] : null;
    const src = e.a >= 0 ? this.pos(e.sb ? 0 : e.s, e.a) : null;
    const dst = this.pos(e.tb ? 0 : e.t, e.b, src ? src[0] : null) || (e.b >= 0 ? [src ? this.v.nx(e.b, src[0]) : this.v.cx[e.b], this.v.cy[e.b]] : null);
    if (!dst || !this.v.inView(dst[0], dst[1], 120) && !(src && this.v.inView(src[0], src[1], 120))) return;
    switch (e.k) {
      case 'mintercept': {
        // an interceptor fires up at the incoming missile: a steep tracer, and a burst high above if it hit
        const [x0, y0] = [this.v.nx(e.a, dst[0]), this.v.cy[e.a]];
        this.shots.push({ x0, y0, x1: dst[0], y1: dst[1] - 70, t: 0, delay: 0, ttl: 0.5, col: 0xffe2a0, heavy: true });
        if (e.o === 'hit') { this.airburst(dst[0], dst[1] - 70, true, e.m); this.explosion(dst[0], dst[1] - 70, 1.6, false); }
        break;
      }
      case 'mimpact': {
        // a strategic strike: blinding flash, rolling fireballs across the blast rings, a rising column
        this.flashes = this.flashes || [];
        this.flashes.push({ x: dst[0], y: dst[1], t: 0, ttl: 2.4, big: true });
        for (let i = 0; i < 18; i++) { const a = (i / 18) * Math.PI * 2, r = 10 + (i % 3) * 14; this.explosion(dst[0] + Math.cos(a) * r, dst[1] + Math.sin(a) * r * 0.7, 2.2, false); }
        for (let i = 0; i < 10; i++) this.puff(dst[0] + (Math.random() - 0.5) * 20, dst[1] - i * 6, 10 + i, i % 2 ? 0x5a524a : 0x8a7f72);
        break;
      }
      case 'fire': {
        if (src) this.muzzle(src, dst, wpn?.tracer === 'heavy' ? 1.3 : 0.9);
        const n = Math.min(8, e.x || 3);
        for (let i = 0; i < n; i++) {
          const j = (h(e.i, i) - 0.5) * 6, jy = (h(e.i, i, 3) - 0.5) * 6;
          if (src) this.shots.push({ x0: src[0], y0: src[1], x1: dst[0] + j, y1: dst[1] + jy, t: 0, delay: i * 0.07, ttl: 0.16, col: TRACER[wpn?.tracer] || TRACER.light, heavy: wpn?.tracer !== 'light' });
          this.dust(dst[0] + j, dst[1] + jy, 1, 0.5, i * 0.07);
        }
        break;
      }
      case 'launch': {
        const kind = wpn?.impact || 'cannon';
        if (kind === 'airburst') {
          // anti-aircraft volley: short tracers rising toward the aircraft (the server resolves the hit)
          if (src) this.muzzle(src, [dst[0], dst[1] - 8], 1.1);
          const n = Math.min(4, e.x || 3);
          for (let i = 0; i < n; i++) { const j = (h(e.i, i) - 0.5) * 10, jy = (h(e.i, i, 5) - 0.5) * 8; if (src) this.shots.push({ x0: src[0], y0: src[1] - 3, x1: dst[0] + j, y1: dst[1] - 8 + jy, t: 0, delay: i * 0.09, ttl: Math.max(0.2, (e.f || 0.5) * 0.9), col: TRACER.flak, heavy: false }); }
          break;
        }
        if (src) { this.muzzle(src, dst, kind === 'cannon' ? 2 : 1.6); this.puff(src[0], src[1], 3, 0xb8b2a6); }
        const from = src || [dst[0] + (h(e.i) - 0.5) * 30, dst[1] - 90];     // hidden origin: falls from the sky
        const salvo = e.x || 1;
        for (let s = 0; s < salvo; s++) this.proj.set(s ? e.p + '_' + s : e.p, { x0: from[0], y0: from[1], x1: dst[0] + (s ? (h(e.i, s) - 0.5) * 8 : 0), y1: dst[1], f: Math.max(0.15, (e.f || 0.4) + s * 0.12), t: 0, arc: wpn?.arc ? ARC[kind] || 30 : 0, kind, trail: [] });
        break;
      }
      case 'impact': {
        { const pr = this.proj.get(e.p); if (pr) pr.t = Math.max(pr.t, pr.f); }   // land now, in sync with the server
        const kind = wpn?.impact || 'cannon';
        if (e.ab || kind === 'airburst') { this.airburst(dst[0], dst[1] - 8, e.o === 'hit', e.i); break; }     // in the air: no crater, no ground dust
        this.explosion(dst[0], dst[1], (BLAST[kind] || 1) * (e.r ? 1.2 : 1), e.o === 'miss');
        if (kind === 'artillery' || kind === 'missile') this.v.shake = Math.max(this.v.shake, this.v.inView(dst[0], dst[1], 0) ? 0.25 : 0);
        break;
      }
      case 'hit': if (e.d > 0) { this.flashes.push({ x: dst[0], y: dst[1], r: 3, col: 0xff6a4a, t: 0, ttl: 0.18 }); const mine = S.units.get(e.t); if (mine && mine.owner === S.civId) this.recentHits.set(e.t, { t: this.clock, from: e.a }); } break;
      case 'bhit': this.dust(dst[0], dst[1], 4, 1.4, 0); break;
      case 'kill': this.explosion(dst[0], dst[1], D.UNITS[e.ty]?.move === 'infantry' ? 0.6 : 1.5, false); break;
      case 'bkill': this.explosion(dst[0], dst[1], 2.4, false); for (let i = 0; i < 10; i++) this.puff(dst[0] + (h(e.i, i) - 0.5) * 16, dst[1] + (h(e.i, i, 2) - 0.5) * 12, 6, 0x5a524a); break;
      default: break;
    }
  }

  muzzle(src, dst, size) {
    const dx = dst[0] - src[0], dy = dst[1] - src[1], l = Math.hypot(dx, dy) || 1;
    this.flashes.push({ x: src[0] + (dx / l) * 4, y: src[1] + (dy / l) * 4, r: 2 * size, col: 0xffe08a, t: 0, ttl: 0.09, light: true });
  }
  dust(x, y, n, size, delay) { n = Math.max(1, Math.round(n * Math.min(1.6, this.S.particleScale ?? 1))); if (this.parts.length > MAX_PARTICLES * (this.S.particleScale ?? 1)) return; for (let i = 0; i < n; i++) this.parts.push({ kind: 'dust', x, y, vx: (Math.random() - 0.5) * 14, vy: -6 - Math.random() * 8, g: 30, r: size, col: 0xb8a98a, t: -delay, ttl: 0.45 }); }
  puff(x, y, r, col) { if (this.parts.length > MAX_PARTICLES * (this.S.particleScale ?? 1)) return; this.parts.push({ kind: 'smoke', x, y, vx: (Math.random() - 0.5) * 4, vy: -5 - Math.random() * 4, g: 0, r, col, t: 0, ttl: 2.2 }); }
  // Flak: a few staggered bursts in the air near the aircraft — a white-yellow flash, a small
  // expanding ring, dark grey puffs and a few sparks; nothing touches the ground.
  airburst(x, y, hit, seed) {
    const S = this.S, scale = Math.min(1.6, S.particleScale ?? 1);
    const reduced = S.prefs?.reducedMotion;
    const n = reduced ? 1 : S.lod === 'strategic' ? 1 : Math.max(1, Math.round(3 * scale));
    for (let i = 0; i < n; i++) {
      const bx = x + (h(seed, i) - 0.5) * 12, by = y + (h(seed, i, 7) - 0.5) * 9, d = i * 0.11;
      this.flashes.push({ x: bx, y: by, r: 2.6, col: 0xfff2b0, t: -d, ttl: 0.12 + d, light: !reduced });
      if (S.lod !== 'strategic') this.flashes.push({ x: bx, y: by, r: 5, size: 0.8, ring: true, t: -d, ttl: 0.4 + d });
      if (this.parts.length > MAX_PARTICLES * (S.particleScale ?? 1)) continue;
      if (!reduced && S.lod !== 'strategic') {
        for (let k = 0; k < 2; k++) this.parts.push({ kind: 'smoke', x: bx + (Math.random() - 0.5) * 3, y: by, vx: (Math.random() - 0.5) * 3, vy: -1.5 - Math.random(), g: 0, r: 2.4 + k, col: 0x3d3b39, t: -d, ttl: 1.1 });
        for (let k = 0; k < 4; k++) { const a = Math.random() * Math.PI * 2, sp = 18 + Math.random() * 16; this.parts.push({ kind: 'spark', x: bx, y: by, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 30, r: 0.6, col: 0xffd890, t: -d, ttl: 0.35 }); }
      }
    }
    if (hit) this.flashes.push({ x, y, r: 3.2, col: 0xff8a4a, t: 0, ttl: 0.2 });
    this.audioCue?.('airburst', x, y);
  }

  explosion(x, y, size, small) {
    this.flashes.push({ x, y, r: 5 * size, col: 0xffd070, t: 0, ttl: 0.12, light: true });
    this.flashes.push({ x, y, r: 3.5 * size, col: 0xff7a2a, t: 0, ttl: 0.3 });
    this.flashes.push({ x, y, r: 9 * size, size, ring: true, t: 0, ttl: 0.35 });
    if (this.parts.length > MAX_PARTICLES * (this.S.particleScale ?? 1)) return;
    const n = Math.round((small ? 4 : 9) * size);
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, sp = 20 + Math.random() * 40 * size; this.parts.push({ kind: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6 - 25, g: 70, r: 0.8 + Math.random() * 1.2, col: i % 3 ? 0x4a4038 : 0x8a7a68, t: 0, ttl: 0.6 + Math.random() * 0.4 }); }
    for (let i = 0; i < Math.ceil(size * 2); i++) this.puff(x + (Math.random() - 0.5) * 6 * size, y + (Math.random() - 0.5) * 4, 2.5 * size, i % 2 ? 0x6a625a : 0x9a9086);
  }

  // Strategic missiles in flight: a ballistic arc from silo to target, the warhead's position along it
  // (interpolated from the server clock), and a pulsing ring over the aim point.
  drawMissiles(g) {
    const S = this.S, v = this.v, list = S.ms?.m; if (!list?.length) return;
    const now = S.time + (performance.now() - (S.timeAt || performance.now())) / 1000;
    for (const [id, from, to, at, arrive, owner] of list) {
      const x1 = v.cx[to], y1 = v.cy[to], x0 = v.nx(from, x1), y0 = v.cy[from];
      const k = Math.max(0, Math.min(1, (now - at) / Math.max(0.1, arrive - at)));
      const H = Math.min(260, Math.hypot(x1 - x0, y1 - y0) * 0.45);
      const P = (p) => [x0 + (x1 - x0) * p, y0 + (y1 - y0) * p - Math.sin(Math.PI * p) * H];
      const col = owner === S.civId ? 0x8fe0a8 : 0xff5a3c;
      // dashed trajectory, solid behind the warhead
      for (let i = 0; i < 24; i++) { const a = i / 24, b = (i + 0.5) / 24; const [ax, ay] = P(a), [bx, by] = P(b); g.moveTo(ax, ay).lineTo(bx, by); }
      g.stroke({ width: 1.6 / Math.max(0.5, v.cam.z), color: col, alpha: 0.6 });
      const n = Math.max(2, Math.round(k * 30)); const [sx, sy] = P(0); g.moveTo(sx, sy);
      for (let i = 1; i <= n; i++) { const [px, py] = P((k * i) / n); g.lineTo(px, py); }
      g.stroke({ width: 2, color: 0xe8e2d4, alpha: 0.7 });
      const [mx, my] = P(k); g.circle(mx, my, 3.5).fill({ color: 0xffffff }).stroke({ width: 1.5, color: col });
      // the aim point: readable at any zoom (sizes in screen pixels), the blast radius shaded
      const zs = 1 / Math.max(0.35, v.cam.z), pulse = 0.5 + 0.5 * Math.sin(now * 6 + id), hx = Math.abs(v.cx[1] - v.cx[0]) || 18;
      g.circle(x1, y1, hx * 2.5).fill({ color: col, alpha: 0.08 + 0.06 * pulse });
      for (const r of [1, 2]) g.circle(x1, y1, (r * 12 + pulse * 4) * zs).stroke({ width: 2.5 * zs, color: col, alpha: 0.95 - r * 0.25 });
      g.moveTo(x1 - 10 * zs, y1).lineTo(x1 + 10 * zs, y1).moveTo(x1, y1 - 10 * zs).lineTo(x1, y1 + 10 * zs).stroke({ width: 2 * zs, color: col });
    }
  }

  // ------------------------------------------------------------ persistent battlefield
  syncBattlefield(bf) {
    const S = this.S, v = this.v;
    S.bf = bf || { c: [], w: [], s: [] };
    const key = JSON.stringify([S.bf.c, S.bf.w.map((x) => [x[0], x[1], x[2]]), S.bf.i || [], S.bf.fp || [], S.ms?.fo || []]);
    if (key === this.bfKey) return;
    this.bfKey = key;
    const g = this.decalG; g.clear();
    // battlefield intensity: churned earth (1), cratered mud with splintered stumps (2), wire and debris (3)
    for (const [t, st] of S.bf.i || []) {
      const x = v.cx[t], y = v.cy[t], hp = v.hexPoints ? v.hexPoints(t, 0) : null;
      if (hp) g.poly(hp).fill({ color: st >= 2 ? 0x3b3026 : 0x5a4a36, alpha: st === 1 ? 0.18 : st === 2 ? 0.34 : 0.46 });
      const n = st * 3;
      for (let k = 0; k < n; k++) { const ox = (h(t, k, 11) - 0.5) * 16, oy = (h(t, k, 12) - 0.5) * 13, r = 1 + h(t, k, 13) * (st >= 2 ? 2.4 : 1.4); g.ellipse(x + ox, y + oy, r * 1.3, r).fill({ color: 0x241d17, alpha: 0.55 }); }
      if (st >= 2) for (let k = 0; k < st; k++) { const ox = (h(t, k, 21) - 0.5) * 14, oy = (h(t, k, 22) - 0.5) * 11, a = h(t, k, 23) * Math.PI; g.moveTo(x + ox, y + oy).lineTo(x + ox + Math.cos(a) * 3, y + oy - 3.5).stroke({ width: 1.1, color: 0x2a2219, alpha: 0.9 }); }
      if (st >= 3) {
        // a run of barbed wire (zigzag on pickets) and scattered debris
        const a = h(t, 7, 31) * Math.PI, c = Math.cos(a), sn = Math.sin(a), L = 7;
        g.moveTo(x - c * L, y - sn * L);
        for (let k = 1; k <= 8; k++) { const f = -L + (2 * L * k) / 8, off = k % 2 ? 1.4 : -1.4; g.lineTo(x + c * f - sn * off, y + sn * f + c * off); }
        g.stroke({ width: 0.8, color: 0x8a8378, alpha: 0.85 });
        for (let k = 0; k <= 2; k++) { const f = -L + L * k; g.circle(x + c * f, y + sn * f, 0.8).fill({ color: 0x3a3029 }); }
        for (let k = 0; k < 4; k++) g.rect(x + (h(t, k, 41) - 0.5) * 14, y + (h(t, k, 42) - 0.5) * 10, 1.6, 1.1).fill({ color: k % 2 ? 0x6b6258 : 0x4a4038 });
      }
    }
    // fallout: a sickly hatched tint where nothing can be farmed and troops sicken
    for (const t of S.ms?.fo || []) {
      const hp = v.hexPoints(t, 0); g.poly(hp).fill({ color: 0x9fb03a, alpha: 0.22 });
      const x = v.cx[t], y = v.cy[t]; for (let k = -2; k <= 2; k++) g.moveTo(x - 9 + k * 4, y + 7).lineTo(x - 3 + k * 4, y - 7); g.stroke({ width: 0.8, color: 0xc8d25a, alpha: 0.5 });
    }
    // temporary field positions: small crescent scrapes with a lip of spoil, tinted to the owner
    for (const [t, o] of S.bf.fp || []) {
      const x = v.cx[t], y = v.cy[t];
      for (let k = 0; k < 3; k++) {
        const ox = (k - 1) * 5 + (h(t, k, 51) - 0.5) * 2, oy = (h(t, k, 52) - 0.5) * 4 + 2;
        g.arc(x + ox, y + oy, 2.4, Math.PI * 1.05, Math.PI * 1.95).stroke({ width: 1.6, color: 0x7a6a50, alpha: 0.9 });
        g.ellipse(x + ox, y + oy + 0.6, 2, 1).fill({ color: 0x2a231b, alpha: 0.8 });
      }
      g.circle(x + 8, y - 3, 1).fill({ color: S.civColor(o), alpha: 0.8 });
    }
    for (const [t, d] of S.bf.c) {
      const x = v.cx[t], y = v.cy[t];
      for (let k = 0; k < d + 1; k++) { const ox = (h(t, k) - 0.5) * 10, oy = (h(t, k, 2) - 0.5) * 8, r = 2.2 + d * 0.9 + h(t, k, 3) * 1.5; g.ellipse(x + ox, y + oy, r * 1.4, r).fill({ color: 0x2b241e, alpha: 0.35 }); g.ellipse(x + ox, y + oy, r, r * 0.7).fill({ color: 0x3a2f26, alpha: 0.85 }).stroke({ width: 0.6, color: 0x8a7a64, alpha: 0.6 }); }
    }
    const w = this.wreckG; w.clear();
    S.bf.w.forEach(([t, type, burning, owner], i) => {
      const def = S.defs.UNITS[type]; if (!def) return;
      const x = v.cx[t] + (h(t, i) - 0.5) * 9, y = v.cy[t] + (h(t, i, 4) - 0.5) * 7, a = h(t, i, 9) * Math.PI;
      const L = def.move === 'tracked' ? 6.5 : def.air ? 5 : 5.5, Wd = def.move === 'tracked' ? 4 : 3;
      const c = Math.cos(a), s = Math.sin(a);
      const pts = [[-L, -Wd], [L, -Wd], [L, Wd], [-L, Wd]].flatMap(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
      w.poly(pts).fill({ color: 0x24201c }).stroke({ width: 0.8, color: shadeCiv(S.civColor(owner)), alpha: 0.5 });
      if (def.move === 'tracked') w.circle(x, y, 2).fill({ color: 0x1a1714 });
      w.circle(x - 1, y - 1, 1.6).fill({ color: burning ? 0x5a2a14 : 0x3a3430 });
    });
  }

  drawBattlefield(t) {
    const S = this.S, v = this.v, g = this.smokeG; g.clear();
    const bf = S.bf; if (!bf) return;
    // burning wrecks
    for (const [tile, , burning] of bf.w) {
      if (!burning) continue;
      const x = v.cx[tile], y = v.cy[tile]; if (!v.inView(x, y, 30)) continue;
      for (let k = 0; k < 4; k++) { const j = Math.sin(t * 10 + k * 1.9 + tile) * 1.2; g.circle(x - 2 + k * 1.4 + j * 0.3, y - 2 - Math.abs(j) * 1.6, 1.4 + (k % 2)).fill({ color: k % 2 ? 0xffb02e : 0xff5a14, alpha: 0.9 }); }
      S.lightsList.push([x, y, 9, 0xff7a2a]);
    }
    // drifting smoke: denser hexes are near-opaque (they hide what is inside from the enemy)
    if (!atLeast(S, 'city') && bf.s.length > 60) return;
    for (const [tile, d10] of bf.s) {
      const x = v.cx[tile], y = v.cy[tile]; if (!v.inView(x, y, 40)) continue;
      const d = d10 / 10;
      for (let k = 0; k < 5; k++) {
        const age = frac(t * 0.08 + k / 5 + h(tile, k));
        g.circle(x + (h(tile, k) - 0.5) * 12 + age * 8, y + (h(tile, k, 5) - 0.5) * 10 - age * 10, 5 + age * 7).fill({ color: d > 0.55 ? 0x56524c : 0x8a857c, alpha: (1 - age) * 0.32 * d + 0.08 * d });
      }
    }
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
      const a0 = this.pos(arr[0].id, arr[0].tile);
      let sx = 0, sy = 0; for (const u of arr) { const p = this.pos(u.id, u.tile, a0[0]); sx += p[0]; sy += p[1]; } sx /= arr.length; sy /= arr.length;
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

function shadeCiv(c) { return c; }
