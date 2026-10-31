// Spatial, procedural sound for the world (Web Audio; no sample files to download).
//
//  * Unlocked by the first click or key press (browsers block audio before a gesture).
//  * Buses: master -> effects / ambience / interface, each with a saved volume slider.
//  * Spatial: an event is panned by its screen position and attenuated (and muffled) by its
//    distance from the centre of the view and by zoom. Off-screen events are not played.
//  * Fog-safe: only events the server already sent this client are heard, and only when the
//    tile is currently visible to the player. Spectators hear what they see.
//  * Voice limits: a hard cap on concurrent voices and a per-category rate; dense fire is
//    clustered into a single louder volley instead of a hundred clicks.
//  * Ambience beds follow what is on screen: wind, sea, forest, city murmur, industry hum and a
//    distant battle rumble that swells with the fighting in view.
//  * Suspended while the tab is hidden.

const STORE = 'se.audio';
const DEFAULTS = { master: 0.7, effects: 0.8, ambience: 0.55, ui: 0.6, muted: false };
const MAX_VOICES = 28;
const RATE = { fire: 14, launch: 6, impact: 8, kill: 5, ui: 6, build: 3 };     // per second
const INDUSTRY = new Set(['steel_mill', 'factory', 'munitions_plant', 'motor_works', 'refinery', 'power_plant', 'electronics_plant', 'mine', 'oil_well', 'arms_works', 'fab']);

const load = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return { ...DEFAULTS }; } };

export class AudioManager {
  constructor(S) {
    this.S = S; this.view = null;
    this.settings = load();
    this.ctx = null; this.voices = 0; this.rate = {}; this.rateT = 0;
    this.cluster = new Map();           // grid cell -> pending volley this frame
    this.amb = null; this.battle = 0;
    this.heardEvents = 0;               // for tests and the settings readout
    const unlock = () => { this.unlock(); };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {}); else this.ctx.resume().catch(() => {});
    });
  }

  attach(view) { this.view = view; }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch { return; }
    const c = this.ctx;
    this.master = c.createGain();
    // a gentle limiter so big battles never clip
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.25;
    this.master.connect(comp).connect(c.destination);
    this.bus = {};
    for (const k of ['effects', 'ambience', 'ui']) { const g = c.createGain(); g.connect(this.master); this.bus[k] = g; }
    this.noise = { white: this.makeNoise('white'), pink: this.makeNoise('pink'), brown: this.makeNoise('brown') };
    this.apply();
    this.startAmbience();
  }

  // ------------------------------------------------------------------ settings
  set(k, v) {
    if (k === 'muted') this.settings.muted = !!v; else this.settings[k] = Math.max(0, Math.min(1, +v));
    try { localStorage.setItem(STORE, JSON.stringify(this.settings)); } catch { /* private window */ }
    this.apply();
  }
  apply() {
    if (!this.ctx) return;
    const s = this.settings, t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.05);
    for (const k of ['effects', 'ambience', 'ui']) this.bus[k].gain.setTargetAtTime(s[k], t, 0.05);
  }

  // ------------------------------------------------------------------ building blocks
  makeNoise(kind) {
    const c = this.ctx, len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') { b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.9; }
      else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return buf;
  }
  // where on screen, and how loud, a world position is (null when it should not be heard)
  place(x, y) {
    const v = this.view; if (!v || !v.vr) return null;
    const r = v.vr, w = r[2] - r[0], h = r[3] - r[1];
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    x = v.near ? v.near(x, cx) : x;
    const nx = (x - cx) / (w / 2), ny = (y - cy) / (h / 2);
    const d = Math.hypot(nx, ny * 0.8);
    if (d > 1.35) return null;
    const zoom = Math.min(1, Math.max(0.12, v.cam.z / 1.4));
    return { pan: Math.max(-0.9, Math.min(0.9, nx * 0.8)), gain: Math.max(0, 1 - d * 0.55) * (0.35 + 0.65 * zoom), muffle: 0.25 + 0.75 * zoom * Math.max(0, 1 - d * 0.4) };
  }
  allow(cat) {
    const now = this.ctx.currentTime;
    if (now - this.rateT > 1) { this.rateT = now; this.rate = {}; }
    if (this.voices >= MAX_VOICES) return false;
    this.rate[cat] = (this.rate[cat] || 0) + 1;
    return this.rate[cat] <= (RATE[cat] || 8);
  }
  // one voice: noise or oscillator -> filter -> envelope -> panner -> bus
  voice({ bus = 'effects', src = 'noise', noise = 'white', type = 'sine', f0 = 440, f1 = null, filter = 'lowpass', fq = 1200, q = 0.8, a = 0.002, d = 0.2, gain = 0.5, pan = 0, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    let s;
    if (src === 'noise') { s = c.createBufferSource(); s.buffer = this.noise[noise]; s.loop = true; s.loopStart = Math.random(); }
    else { s = c.createOscillator(); s.type = type; s.frequency.setValueAtTime(f0, t); if (f1) s.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + d); }
    const fl = c.createBiquadFilter(); fl.type = filter; fl.frequency.value = fq; fl.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    const p = c.createStereoPanner ? c.createStereoPanner() : null;
    s.connect(fl).connect(g);
    if (p) { p.pan.value = pan; g.connect(p).connect(this.bus[bus]); } else g.connect(this.bus[bus]);
    this.voices++;
    s.start(t, src === 'noise' ? Math.random() * 1.5 : 0); s.stop(t + a + d + 0.05);
    s.onended = () => { this.voices--; try { s.disconnect(); fl.disconnect(); g.disconnect(); p?.disconnect(); } catch { /* already gone */ } };
  }

  // ------------------------------------------------------------------ world events
  // Combat events of one snapshot (already filtered by the server to what this player may know).
  combat(evs) {
    if (!this.ready || !this.view) return;
    const S = this.S, v = this.view, W = S.defs.WEAPON_KEYS;
    for (const e of evs) {
      const tile = e.b >= 0 ? e.b : e.a;
      if (tile == null || tile < 0) continue;
      if (!S.spectator && !S.vis[tile] && !(e.a >= 0 && S.vis[e.a])) continue;     // fog: never hear what you cannot see
      const at = e.k === 'fire' || e.k === 'launch' ? (e.a >= 0 && S.vis[e.a] ? e.a : tile) : tile;
      const x = v.cx[at], y = v.cy[at];
      const pl = this.place(x, y); if (!pl) continue;
      const wk = e.w != null ? W[e.w] : null, wpn = wk ? S.defs.WEAPONS[wk] : null;
      // cluster per screen cell so a firefight is a volley, not a hundred clicks
      const key = e.k + ':' + Math.round(x / 60) + ':' + Math.round(y / 60);
      const cl = this.cluster.get(key);
      if (cl) { cl.n += e.x || 1; continue; }
      this.cluster.set(key, { e, wpn, pl, n: e.x || 1 });
    }
  }
  flush() {
    if (!this.ready) { this.cluster.clear(); return; }
    let fights = 0;
    for (const { e, wpn, pl, n } of this.cluster.values()) {
      this.heardEvents++;
      const g = pl.gain, pan = pl.pan, m = pl.muffle;
      switch (e.k) {
        case 'fire': {
          fights += n;
          if (!this.allow('fire')) break;
          const heavy = wpn?.tracer === 'heavy' || wpn?.tracer === 'flak';
          const k = Math.min(5, 1 + Math.floor(Math.log2(n + 1)));
          for (let i = 0; i < k; i++) this.voice({ noise: 'white', filter: 'bandpass', fq: (heavy ? 900 : 2200) * m + 300, q: 1.2, d: heavy ? 0.12 : 0.05, gain: g * (heavy ? 0.5 : 0.32) * (1 + Math.min(1, n / 12)), pan: pan + (Math.random() - 0.5) * 0.1, delay: i * (0.05 + Math.random() * 0.05) });
          break;
        }
        case 'launch': {
          if (!this.allow('launch')) break;
          const kind = wpn?.impact || 'cannon';
          this.voice({ src: 'osc', type: 'sine', f0: kind === 'missile' || kind === 'rocket' ? 220 : 120, f1: 45, d: 0.25, gain: g * 0.6, pan });
          this.voice({ noise: kind === 'missile' || kind === 'rocket' ? 'pink' : 'brown', fq: 600 * m + 200, d: kind === 'missile' || kind === 'rocket' ? 0.7 : 0.3, gain: g * 0.45, pan });
          break;
        }
        case 'impact': case 'kill': case 'bkill': {
          if (!this.allow(e.k === 'impact' ? 'impact' : 'kill')) break;
          const big = e.k === 'bkill' ? 1.6 : e.k === 'kill' ? 1.2 : wpn?.impact === 'artillery' || wpn?.impact === 'missile' ? 1.3 : 1;
          this.voice({ noise: 'brown', fq: 380 * m + 120, d: 0.5 * big, gain: g * 0.8 * Math.min(1.4, big), pan });
          this.voice({ src: 'osc', type: 'sine', f0: 70, f1: 30, d: 0.4 * big, gain: g * 0.55 * big, pan });
          if (e.o === 'miss') break;
          this.voice({ noise: 'white', filter: 'highpass', fq: 2500, d: 0.08, gain: g * 0.12, pan, delay: 0.02 });
          break;
        }
        default: break;
      }
    }
    this.cluster.clear();
    this.battle = Math.max(this.battle * 0.97, Math.min(1, fights / 30));
  }

  // interface sounds (not spatial)
  ui(kind) {
    if (!this.ready || !this.allow('ui')) return;
    switch (kind) {
      case 'click': this.voice({ bus: 'ui', src: 'osc', type: 'triangle', f0: 880, f1: 700, d: 0.05, gain: 0.18 }); break;
      case 'order': this.voice({ bus: 'ui', src: 'osc', type: 'triangle', f0: 520, f1: 660, d: 0.08, gain: 0.2 }); this.voice({ bus: 'ui', src: 'osc', type: 'triangle', f0: 780, d: 0.07, gain: 0.12, delay: 0.06 }); break;
      case 'build': this.voice({ bus: 'ui', noise: 'brown', fq: 900, d: 0.09, gain: 0.5 }); this.voice({ bus: 'ui', noise: 'brown', fq: 700, d: 0.09, gain: 0.4, delay: 0.11 }); break;
      case 'error': this.voice({ bus: 'ui', src: 'osc', type: 'square', f0: 180, f1: 150, filter: 'lowpass', fq: 900, d: 0.16, gain: 0.12 }); break;
      case 'alert': for (let i = 0; i < 2; i++) this.voice({ bus: 'ui', src: 'osc', type: 'sine', f0: 660, d: 0.12, gain: 0.2, delay: i * 0.16 }); break;
      case 'done': this.voice({ bus: 'ui', src: 'osc', type: 'sine', f0: 660, f1: 990, d: 0.18, gain: 0.16 }); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ ambience
  startAmbience() {
    const c = this.ctx;
    const bed = (noise, filter, fq, q = 0.7) => {
      const s = c.createBufferSource(); s.buffer = this.noise[noise]; s.loop = true;
      const f = c.createBiquadFilter(); f.type = filter; f.frequency.value = fq; f.Q.value = q;
      const g = c.createGain(); g.gain.value = 0;
      s.connect(f).connect(g).connect(this.bus.ambience); s.start(0, Math.random() * 1.5);
      return { s, f, g };
    };
    const hum = () => {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 55;
      const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 110.7;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220;
      const g = c.createGain(); g.gain.value = 0;
      o.connect(f); o2.connect(f); f.connect(g).connect(this.bus.ambience); o.start(); o2.start();
      return { s: o, f, g };
    };
    this.amb = { wind: bed('pink', 'bandpass', 500, 0.4), sea: bed('brown', 'lowpass', 500), forest: bed('pink', 'highpass', 3000), city: bed('brown', 'bandpass', 300, 0.5), industry: hum(), battle: bed('brown', 'lowpass', 140) };
    this.ambT = 0; this.birdT = 0; this.mix = { wind: 0, sea: 0, forest: 0, city: 0, industry: 0 };
  }
  // called every frame by the view: sample what is on screen and steer the beds
  frame(dt) {
    if (!this.ready || !this.amb || !this.view) return;
    this.flush();
    const v = this.view, S = this.S, t = this.ctx.currentTime;
    this.ambT -= dt;
    if (this.ambT <= 0) {
      this.ambT = 0.5;
      // sample a coarse grid of the view
      const r = v.vr; if (!r) return;
      let n = 0, sea = 0, forest = 0, open = 0, high = 0;
      const tileAt = v.tileAt ? (x, y) => v.tileAt(x, y) : () => -1;
      for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) {
        const tile = tileAt(r[0] + (r[2] - r[0]) * (i + 0.5) / 6, r[1] + (r[3] - r[1]) * (j + 0.5) / 5);
        if (tile < 0) continue;
        const ter = S.terr[tile]; if (ter === 255) continue;
        n++;
        if (ter <= 1) sea++; else if (ter === 4 || ter === 7) forest++; else if (ter >= 8 && ter <= 10) high++; else open++;
      }
      let city = 0, industry = 0;
      for (const b of S.buildings.values()) {
        if (!b.d || !v.inView(v.cx[b.t], v.cy[b.t], 0) || (!S.spectator && !S.vis[b.t])) continue;
        if (INDUSTRY.has(b.ty) && b.w !== 0) industry++; else city++;
      }
      const zoom = Math.min(1, v.cam.z / 1.2), far = 1 - zoom;
      n = Math.max(1, n);
      this.mix = {
        wind: 0.06 + 0.14 * far + 0.12 * (high / n),
        sea: 0.22 * (sea / n) * (0.4 + 0.6 * zoom),
        forest: 0.07 * (forest / n) * zoom * (1 - (S.night || 0) * 0.6),
        city: Math.min(0.14, city * 0.012) * zoom,
        industry: Math.min(0.08, industry * 0.02) * zoom,
      };
      if ((S.night || 0) > 0.5) this.mix.city *= 0.6;
    }
    const a = this.amb, m = this.mix, tc = 0.6;
    a.wind.g.gain.setTargetAtTime(m.wind, t, tc); a.wind.f.frequency.setTargetAtTime(380 + 260 * Math.sin(t * 0.13) + 120 * Math.sin(t * 0.37), t, 0.5);
    a.sea.g.gain.setTargetAtTime(m.sea * (0.75 + 0.25 * Math.sin(t * 0.5)), t, tc);
    a.forest.g.gain.setTargetAtTime(m.forest * 0.4, t, tc);
    a.city.g.gain.setTargetAtTime(m.city, t, tc);
    a.industry.g.gain.setTargetAtTime(m.industry, t, tc);
    a.battle.g.gain.setTargetAtTime(this.battle * 0.35, t, 0.8);
    // birds in forests by day
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 1.2 + Math.random() * 3;
      if (m.forest > 0.02 && this.allow('ui')) { const f = 2400 + Math.random() * 1800; for (let i = 0; i < 2 + (Math.random() * 3 | 0); i++) this.voice({ bus: 'ambience', src: 'osc', type: 'sine', f0: f, f1: f * (1.15 + Math.random() * 0.3), filter: 'highpass', fq: 1500, d: 0.06, gain: m.forest * 1.4, pan: (Math.random() - 0.5) * 1.4, delay: i * 0.09 }); }
    }
  }
}
