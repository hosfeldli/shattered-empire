// PixiJS map renderer. Draws exactly what the server sends (server-shaded tile colours, fog-filtered
// units, server-computed paths and placements) plus purely decorative ambient life (client/visual).
/* global PIXI */
import { AmbientWorld } from './visual/AmbientWorld.js';
import { lodFor } from './visual/VisualLOD.js';
import { drawUnitBody } from './visual/MilitaryVisuals.js';
import { drawBuildingArt, waterDir, shade } from './visual/BuildingArt.js';
import { CombatEffects } from './visual/combat/CombatEffects.js';

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
    this.overlayTags = L(); this.campG = L('g');
    // combat layers: ground decals under buildings, wrecks with them, effects and smoke over units
    this.decalG = L('g'); this.wreckG = L('g'); this.cfxG = L('g'); this.smokeG = L('g'); this.engageG = L('g');
    this.world.addChild(this.borders, this.front, this.districtLayer, this.ruinsG, this.decalG, this.underG, this.bLayer, this.wreckG, this.ambientG, this.uLayer, this.cfxG, this.smokeG, this.fxG, this.engageG, this.overlay, this.campG, this.overlayTags);
    this.combat = new CombatEffects(this, this.S);
    this.combat.attach({ decal: this.decalG, wreck: this.wreckG, fx: this.cfxG, smoke: this.smokeG, engage: this.engageG });
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

  // spectator follow/fog switches resend the map from scratch
  resetMap() {
    for (const ch of this.chunks) {
      ch.tctx.fillStyle = UNKNOWN; ch.tctx.fillRect(ch.x0, ch.y0, ch.x1 - ch.x0, ch.y1 - ch.y0); ch.tTex.source.update();
      ch.octx.clearRect(ch.x0, ch.y0, ch.x1 - ch.x0, ch.y1 - ch.y0); ch.oTex.source.update();
    }
    for (const s of this.unitSprites.values()) s.destroy({ children: true });
    this.unitSprites.clear();
    this.dirtyTiles.clear(); this.overlayAll = true; this.bordersDirty = true; this.ruinsDirty = true;
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
    if (s && s.utype !== u.type) { s.destroy({ children: true }); this.unitSprites.delete(u.id); s = null; }   // refitted
    if (!s) {
      s = new PIXI.Container();
      s.body = new PIXI.Graphics(); s.addChild(s.body);
      s.label = new PIXI.Text({ text: this.S.defs.UNITS[u.type].glyph, style: { fontFamily: 'Barlow Semi Condensed, sans-serif', fontSize: 8, fontWeight: '700', fill: 0xffffff } });
      s.label.anchor.set(0.5); s.label.resolution = 3; s.addChild(s.label);
      s.dx = this.cx[u.tile]; s.dy = this.cy[u.tile]; s.heading = 0; s.utype = u.type;
      s.position.set(s.dx, s.dy);
      this.uLayer.addChild(s); this.unitSprites.set(u.id, s); s.key = '';
    }
    return s;
  }

  // In-world label: a small pill (background + text) that keeps a readable on-screen size.
  makeTag(parent, size = 7, font = 'Barlow Semi Condensed, sans-serif') {
    const c = new PIXI.Container(); const bg = new PIXI.Graphics();
    const tx = new PIXI.Text({ text: '', style: { fontFamily: font, fontSize: size, fontWeight: '700', fill: 0xffffff, letterSpacing: 0.3 } });
    tx.anchor.set(0.5); tx.resolution = 4; c.addChild(bg, tx); parent.addChild(c); c.bg = bg; c.tx = tx; c.cur = '';
    return c;
  }
  setTag(tag, text, fg, bg, opts = {}) {
    const k = text + fg + bg + (opts.bar ?? '');
    if (tag.cur === k) return;
    tag.cur = k; tag.tx.text = text; tag.tx.style.fill = fg;
    const w = tag.tx.width + 7, hh = tag.tx.height + 2;
    tag.bg.clear().roundRect(-w / 2, -hh / 2, w, hh, 2.5).fill({ color: bg, alpha: 0.88 }).stroke({ width: 0.8, color: opts.edge ?? 0x0b1518, alpha: 0.9 });
    if (opts.bar != null) tag.bg.rect(-w / 2 + 1.5, hh / 2 - 1.6, (w - 3) * opts.bar, 1.1).fill({ color: 0x8fe0a8 });
  }

  setStatusTag(tag, [text, fg, bg, kind], iconOnly) {
    const k = text + kind + iconOnly;
    if (tag.cur === k) return;
    tag.cur = k;
    tag.tx.visible = !iconOnly; tag.tx.text = text; tag.tx.style.fill = fg;
    const ic = tag.icon; ic.clear();
    if (iconOnly) {
      tag.bg.clear().circle(0, 0, 4.4).fill({ color: bg, alpha: 0.95 }).stroke({ width: 0.8, color: 0x0b1518 });
      drawStatusIcon(ic, kind, fg); ic.position.set(0, 0);
    } else {
      const w = tag.tx.width + 13, hh = Math.max(8.5, tag.tx.height + 2);
      tag.bg.clear().roundRect(-w / 2, -hh / 2, w, hh, 2.5).fill({ color: bg, alpha: 0.92 }).stroke({ width: 0.8, color: 0x0b1518, alpha: 0.9 });
      drawStatusIcon(ic, kind, fg); ic.position.set(-w / 2 + 5, 0); tag.tx.position.set(3.2, 0);
    }
  }

  // What a building is (not) doing, in words, for its in-world tag. Null when all is well.
  buildingStatus(b) {
    const S = this.S, D = S.defs, inspect = b.o === S.civId || S.spectator;
    if (b.f) return ['ON FIRE', 0xffffff, 0xb5432f, 'fire'];
    if (b.st === 'damaged') return ['DAMAGED', 0xffd9cf, 0x6a2a1e, 'damaged'];
    if (b.st === 'planned') return [inspect ? 'AWAITING FUNDS' : 'PLANNED', 0x1b1405, 0xf1c75b, 'funds'];
    if (!b.d) return null;
    if (!inspect) return null;
    if (b.w === 'staff') return ['NO WORKERS', 0x1b1405, 0xf0b54a, 'staff'];
    if (b.w === 'power') return ['NO POWER', 0x1b1405, 0xf0d84a, 'power'];
    if (b.w === 'rare') return ['NEEDS RARE EARTHS', 0xffffff, 0x7a4aa8, 'rare'];
    if (b.w && b.w.startsWith('input:')) { const g = b.w.slice(6); return ['NO ' + (D.GOOD_NAMES[g] || g).toUpperCase(), 0x1b1405, 0xf0b54a, 'input']; }
    if (b.q?.length) { const u = D.UNITS[b.q[0][0]]; return [`${u ? u.name.toUpperCase() : 'TRAINING'}${b.q.length > 1 ? ' +' + (b.q.length - 1) : ''}`, 0xe9fbef, 0x24533c, 'train']; }
    return null;
  }

  buildingSprite(b) {
    let s = this.buildingSprites.get(b.id);
    const S = this.S, def = S.defs.BUILDINGS[b.ty];
    if (!s) {
      s = new PIXI.Container();
      s.body = new PIXI.Graphics(); s.marks = new PIXI.Graphics(); s.addChild(s.body, s.marks);
      s.position.set(this.cx[b.t], this.cy[b.t]);
      this.bLayer.addChild(s); this.buildingSprites.set(b.id, s); s.key = ''; s.mkey = '';
      // words float above units, so they live on the label layer
      s.labels = new PIXI.Container(); s.labels.position.copyFrom(s.position); this.overlayTags.addChild(s.labels);
    }
    const city = b.ty === 'town' ? S.cityAt.get(b.t) : null;
    const era = b.o === S.civId ? S.econ?.age || 0 : S.civInfo[b.o]?.age ?? S.econ?.age ?? 0;
    const planned = b.st === 'planned', building = !b.d && !planned;
    const stock = city && city.stock ? Object.values(city.stock).reduce((a, v) => a + v, 0) : 0;
    const key = [b.ty, b.o, b.st, era, building ? Math.round(b.p / 10) : 0, b.a, S.lod, city ? (city.cap ? 'c' : '') + Math.min(5, Math.floor(stock / 150)) : ''].join('|');
    if (key !== s.key) {
      s.key = key;
      drawBuildingArt(s.body, b, def, { id: b.id, era, civ: S.civColor(b.o), lod: S.lod, ghost: planned, building, damaged: b.st === 'damaged', active: !!b.a,
        alpha: building ? 0.3 + 0.7 * (b.p / 100) : 1, capital: city?.cap, stockCrates: Math.floor(stock / 150), water: b.ty === 'port' ? waterDir(this, S, b.t) : null });
    }
    // progress, condition, training and selection marks
    const sel = S.selBuilding === b.id;
    const mkey = [b.hp, b.p, b.d, b.tr ?? -1, sel, S.lod, planned].join('|');
    if (mkey !== s.mkey) {
      s.mkey = mkey;
      const g = s.marks; g.clear();
      const R0 = b.ty === 'town' ? 12 : 10.5;
      if (building) g.rect(-8, 9.5, 16, 2.2).fill({ color: 0x1b1405, alpha: 0.85 }).rect(-8, 9.5, (16 * b.p) / 100, 2.2).fill({ color: 0xf1c75b });
      if (b.hp < 100 && b.d) g.rect(-8, -R0 - 3, 16, 2).fill({ color: 0x220d09, alpha: 0.85 }).rect(-8, -R0 - 3, (16 * b.hp) / 100, 2).fill({ color: b.hp > 50 ? 0x6db36a : 0xd0533b });
      if (b.tr != null && b.d) g.arc(0, 0, R0, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * b.tr) / 100).stroke({ width: 1.8, color: 0x8fe0a8, alpha: 0.95 });
      if (sel) g.poly(this.hexLocal(R0 + 1.5)).stroke({ width: 1.8, color: 0xf1c75b });
    }
    // status tag above the building
    // mid zoom: a pictogram badge; close up: pictogram and words
    const st = this.buildingStatus(b);
    if (st && S.lod !== 'strategic') {
      if (!s.tag) { s.tag = this.makeTag(s.labels, 5.6); s.tag.icon = new PIXI.Graphics(); s.tag.addChild(s.tag.icon); s.tag.position.set(0, -13); }
      this.setStatusTag(s.tag, st, S.lod !== 'micro'); s.tag.visible = true;
    } else if (s.tag) s.tag.visible = false;
    // city banner: name, population, capital star, and its troubles in words
    if (city) {
      if (!s.banner) { s.banner = this.makeTag(s.labels, 9, 'IM Fell English SC, serif'); s.banner.position.set(0, 16); s.chips = this.makeTag(s.labels, 6); s.chips.position.set(0, 25); }
      const col = S.civColor(b.o);
      this.setTag(s.banner, `${city.cap ? '★ ' : ''}${city.n}  ${Math.floor(city.pop)}`, 0xf3eedf, shade(col, 0.42), { edge: col });
      const own = city.o === S.civId || S.spectator;
      const troubles = own ? [city.fs && 'STARVING', city.iso && 'CUT OFF', city.unrest && 'UNREST', city.dmg >= 30 && 'DAMAGED'].filter(Boolean) : [];
      const gov = own && city.gov?.enabled ? 'GOVERNOR · ' + (S.defs.GOVERNOR_SPECS[city.gov.spec]?.name || '').toUpperCase() : '';
      if (troubles.length) this.setTag(s.chips, troubles.join(' · '), 0xffffff, 0xb5432f);
      else if (gov) this.setTag(s.chips, gov, 0xdff3e6, 0x24533c);
      s.chips.visible = !!(troubles.length || gov);
    }
    return s;
  }
  hexLocal(r) { const p = []; for (let k = 0; k < 6; k++) p.push(r * CORNERS[k][0], r * CORNERS[k][1]); return p; }

  syncBuildings() {
    const S = this.S;
    for (const [id, s] of this.buildingSprites) if (!S.buildings.has(id)) { s.labels?.destroy({ children: true }); s.destroy({ children: true }); this.buildingSprites.delete(id); }
    for (const b of S.buildings.values()) this.buildingSprite(b);
  }

  // AI offensives (spectators): a dashed arrow from the army to the city it marches on, labelled.
  syncCampaigns() {
    const S = this.S;
    this.campTags = this.campTags || [];
    const list = S.campaigns || [];
    list.forEach((c, i) => {
      const x0 = this.cx[c.from], y0 = this.cy[c.from], x1 = this.cx[c.to], y1 = this.cy[c.to];
      const L = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      c.mx = (x0 + x1) / 2 - uy * L * 0.12; c.my = (y0 + y1) / 2 + ux * L * 0.12;
      let t = this.campTags[i];
      if (!t) { t = this.makeTag(this.overlayTags, 8); this.campTags[i] = t; }
      this.setTag(t, `${S.civInfo[c.civ]?.name || ''} → ${c.name} · ${c.n} units`, 0xffffff, 0x5a1e14, { edge: S.civColor(c.civ) });
      t.position.set(c.mx, c.my); t.visible = true; t.wx = c.mx;
    });
    for (let i = list.length; i < this.campTags.length; i++) { this.campTags[i].visible = false; this.campTags[i].wx = null; }
  }
  // drawn every frame so the stroke keeps a visible width at any zoom
  drawCampaigns() {
    const S = this.S, g = this.campG; g.clear();
    const w = Math.max(2.5, 2.4 / this.cam.z);
    for (const c of S.campaigns || []) {
      if (c.mx == null) continue;
      const x0 = this.cx[c.from], y0 = this.cy[c.from], x1 = this.cx[c.to], y1 = this.cy[c.to];
      const col = S.civColor(c.civ);
      const L = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      const steps = Math.max(8, Math.floor(L / 9));
      const pts = []; for (let k = 0; k <= steps; k++) { const t = k / steps, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, cc = t * t; pts.push([a * x0 + b * c.mx + cc * x1, a * y0 + b * c.my + cc * y1]); }
      // dark casing, then dashes in the attacker's colour, marching toward the target
      g.moveTo(pts[0][0], pts[0][1]); for (const p of pts) g.lineTo(p[0], p[1]); g.stroke({ width: w + 2, color: 0x0b1518, alpha: 0.55 });
      const ph = (this.t * 2) % 2;
      for (let k = 0; k < steps; k++) if (Math.floor(k + ph) % 2 === 0) g.moveTo(pts[k][0], pts[k][1]).lineTo(pts[k + 1][0], pts[k + 1][1]);
      g.stroke({ width: w, color: col, alpha: 0.95 });
      const hs = w * 2.6, hx = x1 - ux * hs * 1.6, hy = y1 - uy * hs * 1.6;
      g.poly([x1 - ux * 4, y1 - uy * 4, hx - uy * hs, hy + ux * hs, hx + uy * hs, hy - ux * hs]).fill({ color: col }).stroke({ width: 1, color: 0x0b1518 });
      g.circle(x1, y1, Math.max(12, w * 5)).stroke({ width: w * 0.7, color: 0xd0533b, alpha: 0.85 });
    }
  }

  // Army standards: each army's name and what it is doing, planted over its centre.
  syncArmies() {
    const S = this.S; this.armyTags = this.armyTags || new Map();
    const seen = new Set();
    for (const a of S.econ?.armies || []) {
      if (a.center == null || a.center < 0 || !a.units.length) continue;
      seen.add(a.id);
      let t = this.armyTags.get(a.id);
      if (!t) { t = new PIXI.Container(); t.flag = new PIXI.Graphics(); t.addChild(t.flag); t.tag = this.makeTag(t, 7); t.tag.position.set(0, -24); this.overlayTags.addChild(t); this.armyTags.set(a.id, t); }
      const col = S.civColor(S.civId);
      t.flag.clear().moveTo(0, 0).lineTo(0, -19).stroke({ width: 1, color: 0xe7e2d4 }).poly([0, -19, 8, -16.5, 0, -14]).fill({ color: col }).stroke({ width: 0.6, color: 0x0b1518 });
      const status = { attacking: 0xb5432f, engaging: 0xb5432f, withdrawing: 0x8a4a2a, blocked: 0x8a4a2a, staging: 0x8a6a1e }[a.status] ?? 0x24394a;
      this.setTag(t.tag, `${a.name} · ${a.units.length} · ${String(a.status || 'idle').toUpperCase()}`, 0xffffff, status, { edge: col });
      t.tx = this.cx[a.center]; t.ty = this.cy[a.center] - 4;
    }
    for (const [id, t] of this.armyTags) if (!seen.has(id)) { t.destroy({ children: true }); this.armyTags.delete(id); }
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
    if (S.lod !== this.lastLod) { this.lastLod = S.lod; this.syncBuildings(); }
    for (const ch of this.chunks) { const v = ch.x1 > this.vr[0] && ch.x0 < this.vr[2] && ch.y1 > this.vr[1] && ch.y0 < this.vr[3]; ch.ts.visible = v; ch.os.visible = v; }
    // labels keep a readable size on screen whatever the zoom
    const ts = Math.min(3, Math.max(0.55, 1.35 / z));
    const tagS = Math.min(2.6, Math.max(0.6, 2 / z));
    for (const s of this.buildingSprites.values()) {
      s.visible = this.inView(s.x, s.y, 40); s.labels.visible = s.visible;
      if (!s.visible) continue;
      if (s.tag) s.tag.scale.set(tagS);
      if (s.banner) { s.banner.scale.set(ts); s.chips.scale.set(ts); s.banner.y = 11 + 6 * ts; s.chips.y = s.banner.y + 10.5 * ts; }
      if (s.tag) s.tag.y = -10 - 4 * tagS;
    }
    if (this.campTags) for (const t of this.campTags) if (t.wx != null) t.scale.set(ts);
    if (this.armyTags) for (const t of this.armyTags.values()) {
      t.sx = t.sx == null ? t.tx : t.sx + (t.tx - t.sx) * Math.min(1, dt * 3); t.sy = t.sy == null ? t.ty : t.sy + (t.ty - t.sy) * Math.min(1, dt * 3);
      t.position.set(t.sx, t.sy); t.visible = this.inView(t.sx, t.sy, 60); t.tag.scale.set(ts); t.flag.scale.set(Math.max(1, ts * 0.9));
    }
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
    this.combat.frame(dt, this.t);
    this.drawOverlay();
    this.drawCampaigns();
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
    this.pings = this.pings.filter((p) => (p.t -= dt) > 0);
    for (const p of this.pings) { const a = p.t / p.max; f.circle(this.cx[p.tile], this.cy[p.tile], R * (p.radius || 2) * (1.4 - a * 0.4)).stroke({ width: 3, color: p.color, alpha: a }); }
    // right-drag battle line preview
    const dl = this.S.dragLine;
    if (dl) {
      f.moveTo(dl.x0, dl.y0).lineTo(dl.x1, dl.y1).stroke({ width: 2, color: 0xf1c75b, alpha: 0.9 });
      for (const [x, y] of dl.slots) f.circle(x, y, 3).fill({ color: 0xf1c75b, alpha: 0.35 }).stroke({ width: 1, color: 0xf1c75b });
      const mx = (dl.x0 + dl.x1) / 2, my = (dl.y0 + dl.y1) / 2;
      f.moveTo(mx, my).lineTo(mx + dl.fx * 16, my + dl.fy * 16).stroke({ width: 2, color: 0xf1c75b });
      f.poly([mx + dl.fx * 20, my + dl.fy * 20, mx + dl.fx * 14 - dl.fy * 4, my + dl.fy * 14 + dl.fx * 4, mx + dl.fx * 14 + dl.fy * 4, my + dl.fy * 14 - dl.fx * 4]).fill({ color: 0xf1c75b });
    }
  }

  ping(tile, radius, color) { this.pings.push({ tile, radius, color, t: 2.4, max: 2.4 }); }
}

export function hexA(c, a) { return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`; }

// Small vector pictograms for building status badges (drawn within about ±3 units).
export function drawStatusIcon(g, kind, col) {
  switch (kind) {
    case 'fire': g.poly([0, -3.2, 2.2, 0, 1.4, 2.6, -1.4, 2.6, -2.2, 0, -0.6, -1]).fill({ color: col }); break;
    case 'damaged': g.moveTo(-2.6, -2.6).lineTo(-0.4, -0.4).lineTo(-1.4, 0.8).lineTo(2.6, 2.8).stroke({ width: 1.1, color: col }); break;
    case 'funds': g.poly([-2.2, -2.8, 2.2, -2.8, 0, 0]).fill({ color: col }).poly([-2.2, 2.8, 2.2, 2.8, 0, 0]).fill({ color: col }); break;
    case 'staff': g.circle(0, -1.6, 1.1).fill({ color: col }).roundRect(-1.7, -0.2, 3.4, 2.8, 1).fill({ color: col }).moveTo(-2.8, 2.8).lineTo(2.8, -2.8).stroke({ width: 0.9, color: 0xb5432f }); break;
    case 'power': g.poly([0.8, -3.2, -2, 0.4, -0.2, 0.4, -0.8, 3.2, 2, -0.6, 0.2, -0.6]).fill({ color: col }); break;
    case 'input': g.rect(-2.4, -2.4, 4.8, 4.8).stroke({ width: 0.9, color: col }).moveTo(-2.4, -2.4).lineTo(2.4, 2.4).moveTo(2.4, -2.4).lineTo(-2.4, 2.4).stroke({ width: 0.7, color: col }); break;
    case 'rare': g.poly([0, -3, 2.4, 0, 0, 3, -2.4, 0]).fill({ color: col }); break;
    case 'train': g.poly([-2.6, -0.6, 0, -2.8, 2.6, -0.6]).stroke({ width: 1, color: col }).poly([-2.6, 2.2, 0, 0, 2.6, 2.2]).stroke({ width: 1, color: col }); break;
    default: g.circle(0, 0, 1.5).fill({ color: col });
  }
}
