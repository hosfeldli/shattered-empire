// PixiJS map renderer. Draws exactly what the server sends (server-shaded tile colours, fog-filtered
// units, server-computed paths and placements) plus purely decorative ambient life (client/visual).
/* global PIXI */
import { AmbientWorld } from './visual/AmbientWorld.js';
import { lodFor } from './visual/VisualLOD.js';
import { drawUnitBody } from './visual/MilitaryVisuals.js';

export const R = 12;
export const SQ3 = Math.sqrt(3);
const HW = (R * SQ3) / 2;
export const CORNERS = [...Array(6)].map((_, k) => { const a = (Math.PI / 180) * (60 * k - 30); return [Math.cos(a), Math.sin(a)]; });
const EDGE = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
const DIRS_EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const DIRS_ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];
const UNKNOWN = '#10181b';
const RES_COLORS = { 1: '#1c1c1c', 2: '#d7d9dc', 3: '#3a3a3a', 4: '#c6f', 5: '#e8e1d0', 6: '#bfe6ff', 7: '#c9a26b' };
const ROAD_STYLE = { 1: { w: 2.2, c: '#8c6a3c' }, 2: { w: 2.8, c: '#5f6266' }, 3: { w: 3.6, c: '#3b3e42' }, 4: { w: 3, c: '#2a2724' } };
const CH = 32; // tiles per chunk side

export class View {
  constructor(S, host) {
    this.S = S; this.host = host;
    this.W = S.W; this.H = S.H; this.N = S.W * S.H;
    this.cx = new Float32Array(this.N); this.cy = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) { const q = i % this.W, r = (i / this.W) | 0; this.cx[i] = R * SQ3 * (q + 0.5 * (r & 1)) + HW; this.cy[i] = R * 1.5 * r + R; }
    this.pw = Math.ceil(R * SQ3 * (this.W + 0.5) + 2); this.ph = Math.ceil(R * 1.5 * this.H + R + 2);
    this.unitSprites = new Map(); this.buildingSprites = new Map(); this.fx = []; this.pings = [];
    this.shake = 0; this.hitGrid = new Map(); this.stackBadges = new Map();
  }

  async init() {
    const app = new PIXI.Application();
    await app.init({ resizeTo: this.host, background: 0x0d1416, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) });
    this.app = app;
    this.host.appendChild(app.canvas);
    const L = (name) => { const c = name === 'g' ? new PIXI.Graphics() : new PIXI.Container(); return c; };
    this.world = new PIXI.Container(); app.stage.addChild(this.world);
    this.terrainLayer = L(); this.overlayLayer = L();
    this.world.addChild(this.terrainLayer, this.overlayLayer);
    this.borders = L('g'); this.front = L('g'); this.ruinsG = L('g');
    this.districtLayer = L(); this.underG = L('g');
    this.bLayer = L(); this.ambientG = L('g'); this.uLayer = L(); this.fxG = L('g'); this.overlay = L('g');
    this.world.addChild(this.borders, this.front, this.districtLayer, this.ruinsG, this.underG, this.bLayer, this.ambientG, this.uLayer, this.fxG, this.overlay);
    // night: a screen tint, then additive lights in world space above it
    this.night = new PIXI.Graphics(); app.stage.addChild(this.night);
    this.lights = new PIXI.Graphics(); this.lights.blendMode = 'add';
    this.lightWorld = new PIXI.Container(); this.lightWorld.addChild(this.lights); app.stage.addChild(this.lightWorld);
    this.selG = new PIXI.Graphics(); app.stage.addChild(this.selG);
    this.chunks = [];
    const ccols = Math.ceil(this.W / CH), crows = Math.ceil(this.H / CH);
    for (let cr = 0; cr < crows; cr++) for (let cc = 0; cc < ccols; cc++) {
      const q0 = cc * CH, r0 = cr * CH;
      const x0 = Math.floor(R * SQ3 * q0) - 2, y0 = Math.floor(R * 1.5 * r0) - 2;
      const x1 = Math.ceil(R * SQ3 * (Math.min(this.W, q0 + CH) + 0.5)) + 4, y1 = Math.ceil(R * 1.5 * Math.min(this.H, r0 + CH) + R) + 4;
      const mk = () => { const c = document.createElement('canvas'); c.width = x1 - x0; c.height = y1 - y0; return c; };
      const tc = mk(), oc = mk();
      const tctx = tc.getContext('2d'); tctx.fillStyle = UNKNOWN; tctx.fillRect(0, 0, tc.width, tc.height); tctx.translate(-x0, -y0);
      const octx = oc.getContext('2d'); octx.translate(-x0, -y0);
      const tTex = PIXI.Texture.from(tc), oTex = PIXI.Texture.from(oc);
      const ts = new PIXI.Sprite(tTex), os = new PIXI.Sprite(oTex);
      ts.position.set(x0, y0); os.position.set(x0, y0);
      this.terrainLayer.addChild(ts); this.overlayLayer.addChild(os);
      this.chunks.push({ x0, y0, x1, y1, tctx, octx, tTex, oTex, ts, os, tDirty: false, oDirty: false });
    }
    this.ccols = ccols;
    this.cam = { x: 0, y: 0, z: 1 };
    this.dirtyTiles = new Set(); this.dirtyOverlay = new Set(); this.overlayAll = true; this.bordersDirty = true; this.ruinsDirty = true;
    this.ambient = new AmbientWorld(this, this.S);
    app.ticker.add((t) => this.frame(Math.min(0.1, t.deltaMS / 1000)));
  }

  // ---------------------------------------------------------------- geometry & camera
  chunksFor(i) {
    const x = this.cx[i], y = this.cy[i], out = [];
    for (const ch of this.chunks) if (x + R + 1 > ch.x0 && x - R - 1 < ch.x1 && y + R + 1 > ch.y0 && y - R - 1 < ch.y1) out.push(ch);
    return out;
  }
  centerOn(i, z) { if (z) this.cam.z = z; const sw = this.app.screen.width, sh = this.app.screen.height; this.cam.x = this.cx[i] - sw / 2 / this.cam.z; this.cam.y = this.cy[i] - sh / 2 / this.cam.z; this.clamp(); }
  clamp() {
    const sw = this.app.screen.width / this.cam.z, sh = this.app.screen.height / this.cam.z;
    this.cam.x = Math.max(-sw * 0.4, Math.min(this.pw - sw * 0.6, this.cam.x));
    this.cam.y = Math.max(-sh * 0.4, Math.min(this.ph - sh * 0.6, this.cam.y));
  }
  zoomAt(f, sx, sy) {
    const z0 = this.cam.z, z1 = Math.max(0.22, Math.min(4, z0 * f));
    const wx = this.cam.x + sx / z0, wy = this.cam.y + sy / z0;
    this.cam.z = z1; this.cam.x = wx - sx / z1; this.cam.y = wy - sy / z1; this.clamp();
  }
  screenToWorld(sx, sy) { return [this.cam.x + sx / this.cam.z, this.cam.y + sy / this.cam.z]; }
  worldToScreen(x, y) { return [(x - this.cam.x) * this.cam.z, (y - this.cam.y) * this.cam.z]; }
  viewRect(margin = 0) { const sw = this.app.screen.width / this.cam.z, sh = this.app.screen.height / this.cam.z; return [this.cam.x - margin, this.cam.y - margin, this.cam.x + sw + margin, this.cam.y + sh + margin]; }
  inView(x, y, m = 30) { const v = this.vr; return x > v[0] - m && x < v[2] + m && y > v[1] - m && y < v[3] + m; }
  tileAt(wx, wy) {
    const r0 = Math.round((wy - R) / (1.5 * R));
    let best = -1, bd = Infinity;
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      if (r < 0 || r >= this.H) continue;
      const q0 = Math.round((wx - HW) / (R * SQ3) - 0.5 * (r & 1));
      for (let q = q0 - 1; q <= q0 + 1; q++) {
        if (q < 0 || q >= this.W) continue;
        const i = r * this.W + q, d = (this.cx[i] - wx) ** 2 + (this.cy[i] - wy) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return bd <= R * R * 1.1 ? best : -1;
  }
  nb(i, d) { const q = i % this.W, r = (i / this.W) | 0; const dd = (r & 1 ? DIRS_ODD : DIRS_EVEN)[d]; const nq = q + dd[0], nr = r + dd[1]; return nq < 0 || nr < 0 || nq >= this.W || nr >= this.H ? -1 : nr * this.W + nq; }
  dirTo(a, b) { for (let d = 0; d < 6; d++) if (this.nb(a, d) === b) return d; return -1; }
  hexPath(ctx, i, grow = 0) {
    const x = this.cx[i], y = this.cy[i], rr = R + grow;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) { const px = x + rr * CORNERS[k][0], py = y + rr * CORNERS[k][1]; k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath();
  }
  hexPoints(i, grow = 0) { const pts = []; for (let k = 0; k < 6; k++) pts.push(this.cx[i] + (R + grow) * CORNERS[k][0], this.cy[i] + (R + grow) * CORNERS[k][1]); return pts; }
  roadType(i, d) { return (this.S.road[i] >> (d * 4)) & 7; }
  roadRuined(i, d) { return (this.S.road[i] >> (d * 4)) & 8; }

  // ---------------------------------------------------------------- terrain chunks
  redrawTiles(set) {
    const all = new Set(set);
    for (const i of set) for (let d = 0; d < 6; d++) { const n = this.nb(i, d); if (n >= 0) all.add(n); }
    const touched = new Set();
    for (const i of all) for (const ch of this.chunksFor(i)) touched.add(ch);
    for (const ch of touched) this.paintChunkTiles(ch, all);
    for (const ch of touched) ch.tTex.source.update();
  }
  paintChunkTiles(ch, tiles) {
    const S = this.S, ctx = ch.tctx;
    const mine = [...tiles].filter((i) => { const x = this.cx[i], y = this.cy[i]; return x + R + 1 > ch.x0 && x - R - 1 < ch.x1 && y + R + 1 > ch.y0 && y - R - 1 < ch.y1; });
    for (const i of mine) { this.hexPath(ctx, i, 0.6); ctx.fillStyle = S.terr[i] === 255 ? UNKNOWN : '#' + S.color[i].toString(16).padStart(6, '0'); ctx.fill(); }
    ctx.lineCap = 'round';
    for (const i of mine) {
      if (S.terr[i] === 255 || !(S.flags[i] & 1) || S.fdir[i] < 0) continue;
      const n = this.nb(i, S.fdir[i]); if (n < 0) continue;
      ctx.strokeStyle = S.flags[i] & 16 ? '#6f8fa8' : '#3f86c4'; ctx.lineWidth = (1.4 + S.fb[i] * 0.8) * (S.flags[i] & 16 ? 0.5 : 1);
      ctx.beginPath(); ctx.moveTo(this.cx[i], this.cy[i]); ctx.lineTo(this.cx[n], this.cy[n]); ctx.stroke();
    }
    for (const i of mine) {
      if (S.terr[i] === 255 || !S.road[i]) continue;
      const x = this.cx[i], y = this.cy[i];
      for (let d = 0; d < 6; d++) {
        const ty = this.roadType(i, d); if (!ty) continue;
        const n = this.nb(i, d); if (n < 0) continue;
        const mx = (x + this.cx[n]) / 2, my = (y + this.cy[n]) / 2;
        const ruined = this.roadRuined(i, d);
        const bridge = (S.flags[i] & 1) || (S.flags[n] & 1);
        const st = ROAD_STYLE[ty];
        if (bridge && !ruined) { ctx.strokeStyle = '#2b2620'; ctx.lineWidth = st.w + 2.4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke(); }
        if (ruined) {
          // wrecked segment: broken dashes and rubble
          ctx.setLineDash([2, 3]); ctx.strokeStyle = '#6b5d4c'; ctx.lineWidth = st.w; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#4a4038'; for (let k = 0; k < 3; k++) { const f = 0.2 + k * 0.25; ctx.fillRect(x + (mx - x) * f - 1, y + (my - y) * f - 1, 2, 2); }
          continue;
        }
        ctx.strokeStyle = st.c; ctx.lineWidth = st.w; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke();
        if (ty === 4) { ctx.strokeStyle = '#b9b2a2'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke(); }
        if (ty === 3) { ctx.strokeStyle = 'rgba(240,220,120,0.7)'; ctx.lineWidth = 0.6; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke(); ctx.setLineDash([]); }
      }
    }
    ctx.font = 'bold 7px "Barlow Semi Condensed", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const i of mine) {
      const r = S.res[i]; if (!r || S.terr[i] === 255) continue;
      ctx.fillStyle = 'rgba(10,16,18,0.6)'; ctx.beginPath(); ctx.arc(this.cx[i] + 5, this.cy[i] - 5, 5.2, 0, 7); ctx.fill();
      ctx.fillStyle = RES_COLORS[r] === '#1c1c1c' ? '#e9d36b' : RES_COLORS[r]; ctx.fillText(S.defs.RESOURCE[r].glyph, this.cx[i] + 5, this.cy[i] - 4.6);
    }
  }

  // ---------------------------------------------------------------- fog & lenses
  overlayFill(i) {
    const S = this.S;
    if (S.terr[i] === 255) return null;
    const fills = [];
    const lens = S.lens;
    if (lens === 'territory' && S.owner[i] >= 0) fills.push(hexA(S.civColor(S.owner[i]), 0.32));
    else if (lens === 'supply') { if (S.supply[i]) fills.push('rgba(79,190,140,0.30)'); else if (S.owner[i] === S.civId) fills.push('rgba(200,70,50,0.25)'); }
    else if (lens === 'stability' && S.stab[i] >= 0) { const v = S.stab[i] / 100; fills.push(`rgba(${Math.round(220 - 160 * v)},${Math.round(60 + 150 * v)},70,0.48)`); }
    else if (lens === 'traffic') { const t = S.trafficTile.get(i) || 0; if (t) fills.push(`rgba(241,199,91,${Math.min(0.6, 0.12 + t * 0.07)})`); }
    if (S.flags[i] & 32) fills.push('rgba(60,55,50,0.35)');
    if (!S.vis[i]) fills.push('rgba(9,16,19,0.5)');
    return fills;
  }
  redrawOverlay() {
    if (this.overlayAll) {
      for (const ch of this.chunks) { ch.octx.clearRect(ch.x0, ch.y0, ch.x1 - ch.x0, ch.y1 - ch.y0); ch.oDirty = true; }
      for (let i = 0; i < this.N; i++) {
        const f = this.overlayFill(i); if (!f || !f.length) continue;
        for (const ch of this.chunksFor(i)) { this.hexPath(ch.octx, i, 0.6); for (const c of f) { ch.octx.fillStyle = c; ch.octx.fill(); } }
      }
      this.overlayAll = false; this.dirtyOverlay.clear();
    } else {
      for (const i of this.dirtyOverlay) {
        const f = this.overlayFill(i);
        for (const ch of this.chunksFor(i)) {
          const ctx = ch.octx; ch.oDirty = true;
          ctx.save(); this.hexPath(ctx, i, 0.6); ctx.clip();
          ctx.clearRect(this.cx[i] - R - 1, this.cy[i] - R - 1, 2 * R + 2, 2 * R + 2);
          if (f) for (const c of f) { ctx.fillStyle = c; ctx.fill(); }
          ctx.restore();
        }
      }
      this.dirtyOverlay.clear();
    }
    for (const ch of this.chunks) if (ch.oDirty) { ch.oTex.source.update(); ch.oDirty = false; }
  }

  redrawBorders() {
    const S = this.S, g = this.borders; g.clear();
    const f = this.front; f.clear();
    const byCiv = new Map(), fronts = [];
    const atWar = (o) => S.civInfo[o]?.rel?.state === 'war';
    for (let i = 0; i < this.N; i++) {
      const o = S.owner[i]; if (o < 0 || S.terr[i] === 255) continue;
      for (let d = 0; d < 6; d++) {
        const n = this.nb(i, d);
        const on = n >= 0 ? S.owner[n] : -1;
        if (on === o) continue;
        const [a, b] = EDGE[d];
        const seg = [this.cx[i] + (R - 1.2) * CORNERS[a][0], this.cy[i] + (R - 1.2) * CORNERS[a][1], this.cx[i] + (R - 1.2) * CORNERS[b][0], this.cy[i] + (R - 1.2) * CORNERS[b][1]];
        let arr = byCiv.get(o); if (!arr) byCiv.set(o, arr = []); arr.push(seg);
        // front line: our border where it touches an empire we are at war with
        if (o === S.civId && on >= 0 && atWar(on)) fronts.push([this.cx[i] + R * CORNERS[a][0], this.cy[i] + R * CORNERS[a][1], this.cx[i] + R * CORNERS[b][0], this.cy[i] + R * CORNERS[b][1]]);
      }
    }
    for (const [o, arr] of byCiv) { for (const s of arr) g.moveTo(s[0], s[1]).lineTo(s[2], s[3]); g.stroke({ width: 2, color: S.civColor(o), alpha: 0.9 }); }
    if (fronts.length) { for (const s of fronts) f.moveTo(s[0], s[1]).lineTo(s[2], s[3]); f.stroke({ width: 4, color: 0xd0533b, alpha: 0.75 }); }
    this.bordersDirty = false;
  }

  redrawRuins() {
    const g = this.ruinsG; g.clear();
    for (const [t, r] of this.S.ruins) {
      const x = this.cx[t], y = this.cy[t];
      const over = r.flags & 4;
      g.poly(this.hexPoints(t, -3)).fill({ color: over ? 0x3d5233 : 0x3a332c, alpha: 0.75 });
      for (let k = 0; k < 7; k++) { const a = (k * 2.4 + t) % 6.28, d = 2 + ((k * 37 + t) % 7); g.rect(x + Math.cos(a) * d - 1.5, y + Math.sin(a) * d - 1.5, 3, 2.4).fill({ color: over ? 0x587a44 : 0x7c7062 }); }
      if (r.type === 'town') g.rect(x - 4, y - 6, 2, 8).fill({ color: 0x5a5148 }).rect(x + 2, y - 4, 2, 6).fill({ color: 0x5a5148 });
      if (r.flags & 1) g.circle(x, y, 9).stroke({ width: 1, color: 0xc99a2e, alpha: 0.7 });
    }
    this.ruinsDirty = false;
  }

  // ---------------------------------------------------------------- entities
  unitSprite(u) {
    let s = this.unitSprites.get(u.id);
    if (!s) {
      s = new PIXI.Container();
      s.body = new PIXI.Graphics(); s.addChild(s.body);
      s.label = new PIXI.Text({ text: this.S.defs.UNITS[u.type].glyph, style: { fontFamily: 'Barlow Semi Condensed, sans-serif', fontSize: 8, fontWeight: '700', fill: 0xffffff } });
      s.label.anchor.set(0.5); s.label.resolution = 3; s.addChild(s.label);
      s.dx = this.cx[u.tile]; s.dy = this.cy[u.tile]; s.heading = 0;
      s.position.set(s.dx, s.dy);
      this.uLayer.addChild(s); this.unitSprites.set(u.id, s); s.key = '';
    }
    return s;
  }

  buildingSprite(b) {
    let s = this.buildingSprites.get(b.id);
    const S = this.S, def = S.defs.BUILDINGS[b.ty];
    if (!s) {
      s = new PIXI.Container();
      s.body = new PIXI.Graphics(); s.addChild(s.body);
      s.glyph = new PIXI.Text({ text: def.glyph, style: { fontSize: b.ty === 'town' ? 14 : 11 } }); s.glyph.anchor.set(0.5); s.glyph.resolution = 3; s.addChild(s.glyph);
      if (b.ty === 'town') { s.name = new PIXI.Text({ text: '', style: { fontFamily: 'IM Fell English SC, serif', fontSize: 12, fill: 0xf3eedf, stroke: { color: 0x0b1518, width: 3 } } }); s.name.anchor.set(0.5, 0); s.name.position.set(0, 14); s.name.resolution = 3; s.addChild(s.name); }
      s.position.set(this.cx[b.t], this.cy[b.t]);
      this.bLayer.addChild(s); this.buildingSprites.set(b.id, s); s.key = '';
    }
    const city = b.ty === 'town' ? S.cityAt.get(b.t) : null;
    const key = [b.o, b.hp, b.d, b.p, b.st, b.f, S.selBuilding === b.id, city ? city.n + Math.floor(city.pop) + (city.iso ? 'i' : '') + (city.fs ? 'f' : '') : '', S.lod].join('|');
    if (key !== s.key) {
      s.key = key;
      const g = s.body; g.clear();
      const sz = b.ty === 'town' ? 12 : 8.5;
      const col = S.civColor(b.o);
      const planned = b.st === 'planned';
      if (planned) g.roundRect(-sz, -sz, sz * 2, sz * 2, 3).stroke({ width: 1.4, color: col, alpha: 0.7 });
      else g.roundRect(-sz, -sz, sz * 2, sz * 2, 3).fill({ color: b.st === 'damaged' ? 0x2a1a14 : 0x0f1a1d, alpha: 0.85 }).stroke({ width: 2, color: col, alpha: b.d ? 1 : 0.5 });
      if (!b.d && !planned) g.rect(-sz, sz + 2, (2 * sz * b.p) / 100, 3).fill({ color: 0xc99a2e });
      if (b.hp < 100 && !planned) g.rect(-sz, -sz - 5, 2 * sz, 3).fill({ color: 0x220d09 }).rect(-sz, -sz - 5, (2 * sz * b.hp) / 100, 3).fill({ color: b.hp > 50 ? 0x6db36a : 0xd0533b });
      if (S.selBuilding === b.id) g.roundRect(-sz - 3, -sz - 3, sz * 2 + 6, sz * 2 + 6, 4).stroke({ width: 1.5, color: 0xf1c75b });
      if (city && city.o === S.civId && (city.iso || city.fs)) g.circle(sz, -sz, 3.5).fill({ color: city.fs ? 0xe0533b : 0xf0b54a }).stroke({ width: 1, color: 0x0b1518 });
      s.glyph.alpha = planned ? 0.35 : b.d ? 1 : 0.55;
      if (s.name && city) s.name.text = `${city.n} ${Math.floor(city.pop)}`;
    }
    return s;
  }

  syncBuildings() {
    const S = this.S;
    for (const [id, s] of this.buildingSprites) if (!S.buildings.has(id)) { s.destroy({ children: true }); this.buildingSprites.delete(id); }
    for (const b of S.buildings.values()) this.buildingSprite(b);
  }

  // ---------------------------------------------------------------- per-frame
  frame(dt) {
    const S = this.S;
    if (!S.ready) return;
    this.t = (this.t || 0) + dt;
    if (this.dirtyTiles.size) { this.redrawTiles(this.dirtyTiles); this.dirtyTiles.clear(); }
    if (this.overlayAll || this.dirtyOverlay.size) this.redrawOverlay();
    if (this.bordersDirty) this.redrawBorders();
    if (this.ruinsDirty) this.redrawRuins();
    S.onFrame?.(dt);
    let sx = 0, sy = 0;
    if (this.shake > 0) { this.shake = Math.max(0, this.shake - dt); sx = (Math.random() - 0.5) * 10 * this.shake; sy = (Math.random() - 0.5) * 10 * this.shake; }
    const z = this.cam.z;
    this.world.scale.set(z); this.world.position.set(-this.cam.x * z + sx, -this.cam.y * z + sy);
    this.lightWorld.scale.set(z); this.lightWorld.position.copyFrom(this.world.position);
    this.vr = this.viewRect(R * 2);
    S.lod = lodFor(z);
    for (const ch of this.chunks) { const v = ch.x1 > this.vr[0] && ch.x0 < this.vr[2] && ch.y1 > this.vr[1] && ch.y0 < this.vr[3]; ch.ts.visible = v; ch.os.visible = v; }
    for (const s of this.buildingSprites.values()) s.visible = this.inView(s.x, s.y, 40);
    // units: interpolate toward server positions, fan out stacks, orient vehicles
    const seen = new Set(), stacks = new Map();
    for (const u of S.units.values()) { const k = u.next >= 0 && u.prog > 50 ? u.next : u.tile; const a = stacks.get(k) || []; a.push(u); stacks.set(k, a); }
    const k1 = Math.min(1, dt * 9);
    this.hitGrid.clear();
    const badges = new Set();
    for (const [tileKey, arr] of stacks) {
      // big stacks: draw up to 8 markers and a "+N" badge instead of an unreadable pile
      if (arr.length > 8) {
        badges.add(tileKey);
        let bt = this.stackBadges.get(tileKey);
        if (!bt) { bt = new PIXI.Text({ text: '', style: { fontFamily: 'Barlow Semi Condensed, sans-serif', fontSize: 10, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x0b1518, width: 3 } } }); bt.anchor.set(0.5); bt.resolution = 3; this.uLayer.addChild(bt); this.stackBadges.set(tileKey, bt); }
        bt.text = '+' + (arr.length - 8); bt.position.set(this.cx[tileKey], this.cy[tileKey] - 16); bt.visible = this.inView(this.cx[tileKey], this.cy[tileKey]);
      }
      arr.forEach((u, idx) => {
        const s = this.unitSprite(u); seen.add(u.id);
        let tx = this.cx[u.tile], ty = this.cy[u.tile];
        if (u.next >= 0) { const p = u.prog / 100; tx += (this.cx[u.next] - tx) * p; ty += (this.cy[u.next] - ty) * p; }
        const shown = Math.min(8, arr.length);
        if (idx >= 8) { s.visible = false; s.dx = tx; s.dy = ty; return; }
        if (arr.length > 1) { const a = (idx / shown) * Math.PI * 2, rr = Math.min(9, 3 + shown); tx += Math.cos(a) * rr; ty += Math.sin(a) * rr; }
        const ox = s.dx, oy = s.dy;
        s.dx += (tx - s.dx) * k1; s.dy += (ty - s.dy) * k1;
        if (Math.hypot(s.dx - ox, s.dy - oy) > 0.05) s.heading = Math.atan2(s.dy - oy, s.dx - ox);
        const def = S.defs.UNITS[u.type];
        const hover = def.air ? 5 + Math.sin(this.t * 3 + u.id) * 1.2 : 0;
        s.position.set(s.dx, s.dy - hover);
        s.visible = this.inView(s.dx, s.dy, 20);
        if (!s.visible) return;
        const sel = S.selUnits.has(u.id);
        const key = [u.hp, u.sup, u.flags, sel, u.owner, S.lod, Math.round(s.heading * 4)].join('|');
        if (key !== s.key) { s.key = key; drawUnitBody(s.body, u, def, S, sel, s.heading); s.label.visible = S.lod !== 'strategic'; }
        // screen-space spatial index for O(1) hit-testing
        const [px, py] = this.worldToScreen(s.dx, s.dy);
        const ck = ((px / 32) | 0) + ',' + ((py / 32) | 0); const cell = this.hitGrid.get(ck); if (cell) cell.push(u.id); else this.hitGrid.set(ck, [u.id]);
      });
    }
    for (const [id, s] of this.unitSprites) if (!seen.has(id)) { s.destroy({ children: true }); this.unitSprites.delete(id); }
    for (const [k, bt] of this.stackBadges) if (!badges.has(k)) { bt.destroy(); this.stackBadges.delete(k); }
    this.ambient.frame(dt, this.t);
    this.drawOverlay();
    this.drawFx(dt);
  }

  unitAtScreen(sx, sy, filter) {
    let best = null, bd = 14 * 14;
    const cx = (sx / 32) | 0, cy = (sy / 32) | 0;
    for (let a = cx - 1; a <= cx + 1; a++) for (let b = cy - 1; b <= cy + 1; b++) {
      for (const id of this.hitGrid.get(a + ',' + b) || []) {
        const u = this.S.units.get(id), s = this.unitSprites.get(id); if (!u || !s || (filter && !filter(u))) continue;
        const [x, y] = this.worldToScreen(s.dx, s.dy); const d = (x - sx) ** 2 + (y - sy) ** 2;
        if (d < bd) { bd = d; best = u; }
      }
    }
    return best;
  }

  drawOverlay() {
    const S = this.S, g = this.overlay; g.clear();
    const m = S.mode;
    if (m && m.kind === 'build' && m.tiles) for (const i of m.tiles) if (this.inView(this.cx[i], this.cy[i])) g.poly(this.hexPoints(i, -1.5)).stroke({ width: 1.3, color: 0x8fe0a8, alpha: 0.85 });
    // selected units' server-computed routes
    for (const id of S.selUnits) {
      const p = S.paths[id]; const s = this.unitSprites.get(id); if (!p || !p.length || !s) continue;
      g.moveTo(s.dx, s.dy); for (const t of p) g.lineTo(this.cx[t], this.cy[t]);
      g.stroke({ width: 1.4, color: 0xf1c75b, alpha: 0.55 });
      const last = p[p.length - 1]; g.circle(this.cx[last], this.cy[last], 3).fill({ color: 0xf1c75b, alpha: 0.8 });
    }
    // road projects under construction
    for (const pr of S.econ?.roads || []) {
      const t = pr.tiles; if (!t || t.length < 2) continue;
      g.moveTo(this.cx[t[0]], this.cy[t[0]]); for (const x of t) g.lineTo(this.cx[x], this.cy[x]);
      g.stroke({ width: 2.4, color: pr.status === 'paused' || pr.status === 'blocked' ? 0xd0533b : 0xc99a2e, alpha: 0.5 });
      for (const x of t.slice(0, 1)) g.circle(this.cx[x], this.cy[x], 2.5).fill({ color: 0xc99a2e });
    }
    // road planner preview: per-segment validity from the server
    if (m && m.kind === 'road') {
      for (const w of m.points) g.circle(this.cx[w], this.cy[w], 4).stroke({ width: 2, color: 0xf1c75b });
      const plan = m.preview;
      if (plan) for (const sgm of plan.segments) {
        const col = sgm.skip ? 0x9aa5a0 : sgm.ok ? (sgm.bridge ? 0x6fc3ff : 0x8fe0a8) : 0xe0533b;
        g.moveTo(this.cx[sgm.a], this.cy[sgm.a]).lineTo(this.cx[sgm.b], this.cy[sgm.b]).stroke({ width: 4, color: col, alpha: 0.85 });
      }
    }
    // army zones & staging points
    for (const a of S.econ?.armies || []) {
      const o = a.order || {};
      if (o.kind === 'defend' && o.tile >= 0) g.circle(this.cx[o.tile], this.cy[o.tile], R * 1.6 * o.radius).stroke({ width: 1.5, color: 0x8fd19e, alpha: 0.5 });
      if (o.kind === 'offensive' && o.staging >= 0) {
        g.moveTo(this.cx[o.staging], this.cy[o.staging]).lineTo(this.cx[o.tile], this.cy[o.tile]).stroke({ width: 2, color: 0xd0533b, alpha: 0.45 });
        g.rect(this.cx[o.staging] - 1, this.cy[o.staging] - 14, 2, 14).fill({ color: 0xe7e2d4 }).poly([this.cx[o.staging] + 1, this.cy[o.staging] - 14, this.cx[o.staging] + 10, this.cy[o.staging] - 10, this.cx[o.staging] + 1, this.cy[o.staging] - 6]).fill({ color: 0xd0533b });
      }
    }
    if (S.hover >= 0 && S.terr[S.hover] !== 255) g.poly(this.hexPoints(S.hover, -0.5)).stroke({ width: 1.2, color: 0xffffff, alpha: 0.45 });
    if (S.selBuilding != null) { const b = S.buildings.get(S.selBuilding); if (b && b.r >= 0) { g.moveTo(this.cx[b.t], this.cy[b.t]).lineTo(this.cx[b.r], this.cy[b.r]).stroke({ width: 1, color: 0x8fe0a8, alpha: 0.6 }); g.circle(this.cx[b.r], this.cy[b.r], 4).stroke({ width: 1.5, color: 0x8fe0a8 }); } }
  }

  drawFx(dt) {
    const f = this.fxG; f.clear();
    this.fx = this.fx.filter((e) => (e.t -= dt) > 0);
    for (const e of this.fx) {
      const a = e.t / e.max;
      if (e.kind === 'shot') f.moveTo(this.cx[e.a], this.cy[e.a]).lineTo(this.cx[e.b], this.cy[e.b]).stroke({ width: 1.2, color: 0xffe9a8, alpha: a });
      else if (e.kind === 'shell') { const p = 1 - a; const x = this.cx[e.a] + (this.cx[e.b] - this.cx[e.a]) * p, y = this.cy[e.a] + (this.cy[e.b] - this.cy[e.a]) * p - Math.sin(p * Math.PI) * 18; f.circle(x, y, 1.6).fill({ color: 0xffe0a0, alpha: 1 }); if (a < 0.15) f.circle(this.cx[e.b], this.cy[e.b], 7).fill({ color: 0xf08a3c, alpha: 0.6 }); }
      else if (e.kind === 'melee') f.circle(this.cx[e.b], this.cy[e.b], 4 + 5 * (1 - a)).stroke({ width: 1.4, color: 0xffd0a0, alpha: a });
      else if (e.kind === 'die') f.circle(this.cx[e.a], this.cy[e.a], 3 + 9 * (1 - a)).fill({ color: 0xd0533b, alpha: a * 0.6 });
      else if (e.kind === 'boom') f.circle(this.cx[e.a], this.cy[e.a], 6 + 16 * (1 - a)).fill({ color: 0xf08a3c, alpha: a * 0.6 });
    }
    this.pings = this.pings.filter((p) => (p.t -= dt) > 0);
    for (const p of this.pings) { const a = p.t / p.max; f.circle(this.cx[p.tile], this.cy[p.tile], R * (p.radius || 2) * (1.4 - a * 0.4)).stroke({ width: 3, color: p.color, alpha: a }); }
  }

  addFx(list) { for (const [kind, a, b] of list) { const max = kind === 'shot' ? 0.25 : kind === 'shell' ? 0.7 : 0.45; this.fx.push({ kind, a, b, t: max, max }); } }
  ping(tile, radius, color) { this.pings.push({ tile, radius, color, t: 2.4, max: 2.4 }); }
}

export function hexA(c, a) { return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`; }
