// PixiJS map renderer. Draws exactly what the server sends (server-shaded tile colours, fog-filtered
// units, server-computed paths and placements) plus purely decorative ambient life (client/visual).
/* global PIXI */
import { AmbientWorld } from './visual/AmbientWorld.js';
import { lodFor } from './visual/VisualLOD.js';
import { drawUnitBody } from './visual/MilitaryVisuals.js';
import { UnitAtlas, attachArt, updateArt } from './visual/UnitSpriteManager.js';
import { drawFieldworks } from './visual/FieldworksVisuals.js';
import { drawBuildingArt, waterDir, shade, CAT_COL } from './visual/BuildingArt.js';
import { paintTerrainDetail, smoothColor } from './visual/TerrainMaterials.js';
import { CombatEffects } from './visual/combat/CombatEffects.js';
import { nearestCopy, tilePolyline } from './visual/WorldWrapGeometry.js';

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
    // A wrapped world is a cylinder of circumference P. Static layers (terrain chunks, borders,
    // ruins, districts) are drawn once at base positions (cx0) and mirrored one period east and
    // west; everything drawn per frame uses cx, re-based each frame to the copy nearest the camera.
    this.wrap = !!S.wrap; this.P = R * SQ3 * this.W;
    this.cx0 = Float32Array.from(this.cx); this.cxCenter = NaN;
    // The camera's x is continuous (it is never wrapped back into 0…P while panning). Static layers
    // exist as three copies (previous, current and next period) that follow the camera's period.
    this.period = 0; this.periodic = [];
    this.unitSprites = new Map(); this.buildingSprites = new Map(); this.fx = []; this.pings = [];
    this.shake = 0; this.hitGrid = new Map(); this.stackBadges = new Map();
  }

  async init() {
    const app = new PIXI.Application();
    await app.init({ resizeTo: this.host, background: 0x0d1416, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) });
    this.app = app;
    this.host.appendChild(app.canvas);
    this.atlas = new UnitAtlas(); await this.atlas.load();
    const L = (name) => { const c = name === 'g' ? new PIXI.Graphics() : new PIXI.Container(); return c; };
    this.world = new PIXI.Container(); app.stage.addChild(this.world);
    this.terrainLayer = L(); this.overlayLayer = L();
    this.world.addChild(this.terrainLayer, this.overlayLayer);
    this.borders = L('g'); this.front = L('g'); this.ruinsG = L('g'); this.fwG = L('g'); this.tacG = L('g');
    this.districtLayer = L(); this.underG = L('g');
    this.bLayer = L(); this.ambientG = L('g'); this.uLayer = L(); this.fxG = L('g'); this.overlay = L('g');
    this.overlayTags = L(); this.campG = L('g'); this.ghost = L('g');
    // combat layers: ground decals under buildings, wrecks with them, effects and smoke over units
    this.decalG = L('g'); this.wreckG = L('g'); this.cfxG = L('g'); this.smokeG = L('g'); this.engageG = L('g');
    // aircraft: ground shadows under the units, operational markers (patrol orbits, fuel, AA threat) over them
    this.airShadowG = L('g'); this.airG = L('g');
    this.world.addChild(this.borders, this.front, this.districtLayer, this.ruinsG, this.fwG, this.decalG, this.underG, this.bLayer, this.wreckG, this.ambientG, this.airShadowG, this.uLayer, this.cfxG, this.smokeG, this.fxG, this.engageG, this.tacG, this.airG, this.overlay, this.ghost, this.campG, this.overlayTags);
    this.combat = new CombatEffects(this, this.S);
    this.combat.attach({ decal: this.decalG, wreck: this.wreckG, fx: this.cfxG, smoke: this.smokeG, engage: this.engageG });
    // night: a screen tint, then additive lights in world space above it
    this.night = new PIXI.Graphics(); app.stage.addChild(this.night);
    this.lights = new PIXI.Graphics(); this.lights.blendMode = 'add';
    this.lightWorld = new PIXI.Container(); this.lightWorld.addChild(this.lights); app.stage.addChild(this.lightWorld);
    this.selG = new PIXI.Graphics(); app.stage.addChild(this.selG);
    // static graphics are mirrored by sharing their geometry (redrawing one redraws all three)
    this.mirrorOf = (g) => {
      if (!this.wrap) return;
      const top = g.parent === this.world;   // copies inside a periodic container move with it
      const i = g.parent.getChildIndex(g);
      if (top) { g.x = this.period * this.P; this.periodic.push({ o: g, k: 0 }); }
      for (const k of [-1, 1]) { const m = new PIXI.Graphics(g.context); m.x = (top ? this.period + k : k) * this.P; g.parent.addChildAt(m, i + 1); if (top) this.periodic.push({ o: m, k }); }
    };
    if (this.wrap) for (const o of [this.terrainLayer, this.overlayLayer, this.districtLayer]) this.periodic.push({ o, k: 0 });
    for (const g of [this.borders, this.front, this.ruinsG, this.fwG]) this.mirrorOf(g);
    this.chunks = [];
    const ccols = Math.ceil(this.W / CH), crows = Math.ceil(this.H / CH);
    for (let cr = 0; cr < crows; cr++) for (let cc = 0; cc < ccols; cc++) {
      const q0 = cc * CH, r0 = cr * CH;
      const x0 = Math.floor(R * SQ3 * q0) - 2, y0 = Math.floor(R * 1.5 * r0) - 2;
      const x1 = Math.ceil(R * SQ3 * (Math.min(this.W, q0 + CH) + 0.5)) + 4, y1 = Math.ceil(R * 1.5 * Math.min(this.H, r0 + CH) + R) + 4;
      const mk = () => { const c = document.createElement('canvas'); c.width = x1 - x0; c.height = y1 - y0; return c; };
      const tc = mk(), oc = mk();
      const tctx = tc.getContext('2d'); if (!this.wrap) { tctx.fillStyle = UNKNOWN; tctx.fillRect(0, 0, tc.width, tc.height); } tctx.translate(-x0, -y0);   // wrapped: margins stay transparent so mirrors overlap cleanly
      const octx = oc.getContext('2d'); octx.translate(-x0, -y0);
      const tTex = PIXI.Texture.from(tc), oTex = PIXI.Texture.from(oc);
      const ts = new PIXI.Sprite(tTex), os = new PIXI.Sprite(oTex);
      ts.position.set(x0, y0); os.position.set(x0, y0);
      this.terrainLayer.addChild(ts); this.overlayLayer.addChild(os);
      // wrapped world: the same textures drawn one period east and west
      const mirrors = [];
      if (this.wrap) for (const k of [-1, 1]) { const mt = new PIXI.Sprite(tTex), mo = new PIXI.Sprite(oTex); mt.position.set(x0 + k * this.P, y0); mo.position.set(x0 + k * this.P, y0); this.terrainLayer.addChild(mt); this.overlayLayer.addChild(mo); mirrors.push({ k, mt, mo }); }
      this.chunks.push({ x0, y0, x1, y1, tctx, octx, tTex, oTex, ts, os, mirrors, tDirty: false, oDirty: false });
    }
    this.ccols = ccols;
    this.cam = { x: 0, y: 0, z: 1 };
    // resizing the window keeps the same map point in the middle of the screen
    this.lastSW = app.screen.width; this.lastSH = app.screen.height;
    app.renderer.on('resize', (w, h) => { const z = this.cam.z; this.cam.x += (this.lastSW - w) / 2 / z; this.cam.y += (this.lastSH - h) / 2 / z; this.lastSW = w; this.lastSH = h; this.clamp(); });
    this.dirtyTiles = new Set(); this.dirtyOverlay = new Set(); this.overlayAll = true; this.bordersDirty = true; this.ruinsDirty = true;
    this.ambient = new AmbientWorld(this, this.S);
    app.ticker.add((t) => this.frame(Math.min(0.1, t.deltaMS / 1000)));
  }

  // spectator follow/fog switches resend the map from scratch
  resetMap() {
    for (const ch of this.chunks) {
      if (this.wrap) ch.tctx.clearRect(ch.x0, ch.y0, ch.x1 - ch.x0, ch.y1 - ch.y0); else { ch.tctx.fillStyle = UNKNOWN; ch.tctx.fillRect(ch.x0, ch.y0, ch.x1 - ch.x0, ch.y1 - ch.y0); } ch.tTex.source.update();
      ch.octx.clearRect(ch.x0, ch.y0, ch.x1 - ch.x0, ch.y1 - ch.y0); ch.oTex.source.update();
    }
    for (const s of this.unitSprites.values()) s.destroy({ children: true });
    this.unitSprites.clear();
    this.dirtyTiles.clear(); this.overlayAll = true; this.bordersDirty = true; this.ruinsDirty = true;
  }

  // the image of x (one period east or west) nearest to ref
  near(x, ref) { if (!this.wrap) return x; const P = this.P; return x + Math.round((ref - x) / P) * P; }
  // re-base per-frame positions on the camera centre (only when it has moved a long way)
  rebase() {
    if (!this.wrap) return;
    const c = this.cam.x + this.app.screen.width / 2 / this.cam.z;
    // static copies follow the camera's period: base copy at k·P, mirrors at (k±1)·P
    const k = Math.floor(c / this.P);
    if (k !== this.period) { this.period = k; for (const p of this.periodic) p.o.x = (k + p.k) * this.P; }
    if (!this.rebaseAll && Math.abs(c - this.cxCenter) < this.P * 0.02) return;
    this.rebaseAll = false;
    this.cxCenter = c;
    const P = this.P, cx = this.cx, cx0 = this.cx0;
    for (let i = 0; i < this.N; i++) cx[i] = cx0[i] + Math.round((c - cx0[i]) / P) * P;
    this.rebased = true;
  }

  // ---------------------------------------------------------------- geometry & camera
  chunksFor(i) {
    const x = this.cx0[i], y = this.cy[i], out = [];
    for (const ch of this.chunks) if (x + R + 1 > ch.x0 && x - R - 1 < ch.x1 && y + R + 1 > ch.y0 && y - R - 1 < ch.y1) out.push(ch);
    return out;
  }
  // centre on a tile's copy nearest to the current view (never scrolls round the world)
  centerOn(i, z) { if (z) this.cam.z = Math.max(this.minZoom(), Math.min(4, z)); const sw = this.app.screen.width, sh = this.app.screen.height; const c = this.cam.x + sw / 2 / this.cam.z; this.cam.x = this.near(this.cx0[i], c) - sw / 2 / this.cam.z; this.cam.y = this.cy[i] - sh / 2 / this.cam.z; this.clamp(); }
  // the smallest zoom: a wrapped world never shows more than ~92% of its circumference, so a second
  // copy of the continent never appears; a flat world may be seen whole
  minZoom() {
    const sw = this.app.screen.width, sh = this.app.screen.height;
    if (this.wrap) return Math.max(0.22, sw / (this.P * 0.92));
    return Math.max(0.22, Math.min(sw / (this.pw * 1.1), sh / (this.ph * 1.1)));
  }
  clamp() {
    const zmin = this.minZoom();
    if (this.cam.z < zmin) {
      // resize below the minimum: keep the map centre where it was
      const c = this.cam.x + this.app.screen.width / 2 / this.cam.z, cy = this.cam.y + this.app.screen.height / 2 / this.cam.z;
      this.cam.z = zmin; this.cam.x = c - this.app.screen.width / 2 / zmin; this.cam.y = cy - this.app.screen.height / 2 / zmin;
    }
    const sw = this.app.screen.width / this.cam.z, sh = this.app.screen.height / this.cam.z;
    if (this.wrap) {
      // x stays continuous; north and south are real edges: never scroll far past the polar seas
      this.cam.y = sh >= this.ph ? (this.ph - sh) / 2 : Math.max(-R * 3, Math.min(this.ph - sh + R * 3, this.cam.y));
      return;
    }
    this.cam.x = sw >= this.pw ? (this.pw - sw) / 2 : Math.max(-sw * 0.4, Math.min(this.pw - sw * 0.6, this.cam.x));
    this.cam.y = sh >= this.ph ? (this.ph - sh) / 2 : Math.max(-sh * 0.4, Math.min(this.ph - sh * 0.6, this.cam.y));
  }
  // Zoom anchored under the cursor: the allowed scale is settled first, then the anchor applied,
  // so reaching the minimum zoom never shifts the map.
  zoomAt(f, sx, sy) {
    const z0 = this.cam.z, z1 = Math.max(this.minZoom(), Math.min(4, z0 * f));
    if (z1 === z0) return;
    const wx = this.cam.x + sx / z0, wy = this.cam.y + sy / z0;
    this.cam.z = z1; this.cam.x = wx - sx / z1; this.cam.y = wy - sy / z1; this.clamp();
  }
  camCenterX() { return this.cam.x + this.app.screen.width / 2 / this.cam.z; }
  // continuous points for a tile route (each point placed relative to the previous one)
  tilePts(tiles, anchorX) { return tilePolyline(this, tiles, anchorX); }
  // x of tile b's copy nearest to x
  nx(b, x) { return this.wrap ? nearestCopy(this.cx0[b], x, this.P) : this.cx0[b]; }
  // Far from the origin, float32 precision on the GPU suffers: move everything back by whole world
  // periods. The scene is periodic, so nothing visible moves.
  recenter() {
    if (!this.wrap || this.panning) return;
    const shift = Math.round(this.cam.x / this.P) * this.P; if (!shift) return;
    this.cam.x -= shift; this.cxCenter -= shift; this.rebaseAll = true;
    for (const s of this.unitSprites.values()) s.dx -= shift;
    if (this.armyTags) for (const t of this.armyTags.values()) { if (t.sx != null) t.sx -= shift; }
    this.combat?.shift?.(-shift);
    this.onRecenter?.(shift);
  }
  screenToWorld(sx, sy) { return [this.cam.x + sx / this.cam.z, this.cam.y + sy / this.cam.z]; }
  worldToScreen(x, y) { return [(x - this.cam.x) * this.cam.z, (y - this.cam.y) * this.cam.z]; }
  viewRect(margin = 0) { const sw = this.app.screen.width / this.cam.z, sh = this.app.screen.height / this.cam.z; return [this.cam.x - margin, this.cam.y - margin, this.cam.x + sw + margin, this.cam.y + sh + margin]; }
  inView(x, y, m = 30) { const v = this.vr; return x > v[0] - m && x < v[2] + m && y > v[1] - m && y < v[3] + m; }
  tileAt(wx, wy) {
    if (this.wrap) wx = ((wx % this.P) + this.P) % this.P;
    const r0 = Math.round((wy - R) / (1.5 * R));
    let best = -1, bd = Infinity;
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      if (r < 0 || r >= this.H) continue;
      const q0 = Math.round((wx - HW) / (R * SQ3) - 0.5 * (r & 1));
      for (let q = q0 - 1; q <= q0 + 1; q++) {
        if (!this.wrap && (q < 0 || q >= this.W)) continue;
        const qq = this.wrap ? (q + this.W) % this.W : q;
        const i = r * this.W + qq, d = (this.near(this.cx0[i], wx) - wx) ** 2 + (this.cy[i] - wy) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return bd <= R * R * 1.1 ? best : -1;
  }
  nb(i, d) { const q = i % this.W, r = (i / this.W) | 0; const dd = (r & 1 ? DIRS_ODD : DIRS_EVEN)[d]; let nq = q + dd[0]; const nr = r + dd[1]; if (this.wrap) nq = (nq + this.W) % this.W; return nq < 0 || nr < 0 || nq >= this.W || nr >= this.H ? -1 : nr * this.W + nq; }
  dirTo(a, b) { for (let d = 0; d < 6; d++) if (this.nb(a, d) === b) return d; return -1; }
  hexPath(ctx, i, grow = 0) {
    const x = this.cx0[i], y = this.cy[i], rr = R + grow;
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
    const mine = [...tiles].filter((i) => { const x = this.cx0[i], y = this.cy[i]; return x + R + 1 > ch.x0 && x - R - 1 < ch.x1 && y + R + 1 > ch.y0 && y - R - 1 < ch.y1; });
    // base fills (softened toward same-biome neighbours), then blends, relief and biome detail
    for (const i of mine) {
      this.hexPath(ctx, i, 0.6);
      if (S.terr[i] === 255) ctx.fillStyle = UNKNOWN; else { const c = smoothColor(this, S, i); ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }
      ctx.fill();
    }
    for (const i of mine) paintTerrainDetail(ctx, this, S, i, R, CORNERS);
    ctx.lineCap = 'round';
    for (const i of mine) {
      if (S.terr[i] === 255 || !(S.flags[i] & 1) || S.fdir[i] < 0) continue;
      const n = this.nb(i, S.fdir[i]); if (n < 0) continue;
      ctx.strokeStyle = S.flags[i] & 16 ? '#6f8fa8' : '#3f86c4'; ctx.lineWidth = (1.4 + S.fb[i] * 0.8) * (S.flags[i] & 16 ? 0.5 : 1);
      ctx.beginPath(); ctx.moveTo(this.cx0[i], this.cy[i]); ctx.lineTo(this.near(this.cx0[n], this.cx0[i]), this.cy[n]); ctx.stroke();
    }
    for (const i of mine) {
      if (S.terr[i] === 255 || !S.road[i]) continue;
      const x = this.cx0[i], y = this.cy[i];
      for (let d = 0; d < 6; d++) {
        const ty = this.roadType(i, d); if (!ty) continue;
        const n = this.nb(i, d); if (n < 0) continue;
        const mx = (x + this.near(this.cx0[n], x)) / 2, my = (y + this.cy[n]) / 2;
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
      ctx.fillStyle = 'rgba(10,16,18,0.42)'; ctx.beginPath(); ctx.arc(this.cx0[i] + 5, this.cy[i] - 5, 4.6, 0, 7); ctx.fill();
      ctx.fillStyle = RES_COLORS[r] === '#1c1c1c' ? '#e9d36b' : RES_COLORS[r]; ctx.fillText(S.defs.RESOURCE[r].glyph, this.cx0[i] + 5, this.cy[i] - 4.6);
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
          ctx.clearRect(this.cx0[i] - R - 1, this.cy[i] - R - 1, 2 * R + 2, 2 * R + 2);
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
        const seg = [this.cx0[i] + R * CORNERS[a][0], this.cy[i] + R * CORNERS[a][1], this.cx0[i] + R * CORNERS[b][0], this.cy[i] + R * CORNERS[b][1], this.cx0[i], this.cy[i]];
        let arr = byCiv.get(o); if (!arr) byCiv.set(o, arr = []); arr.push(seg);
        // front line: our border where it touches an empire we are at war with
        if (o === S.civId && on >= 0 && atWar(on)) fronts.push([this.cx0[i] + R * CORNERS[a][0], this.cy[i] + R * CORNERS[a][1], this.cx0[i] + R * CORNERS[b][0], this.cy[i] + R * CORNERS[b][1]]);
      }
    }
    // seamless borders: hex edges are chained into continuous outlines, then pulled slightly inside
    // each nation's land, so two neighbours' borders run side by side without notches or gaps
    for (const [o, arr] of byCiv) {
      const col = S.civColor(o);
      for (const pts of chainBorder(arr)) {
        g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
        if (pts.closed) g.closePath();
      }
      g.stroke({ width: 2.2, color: col, alpha: 0.9, join: 'round', cap: 'round' });
    }
    if (fronts.length) { for (const s of fronts) f.moveTo(s[0], s[1]).lineTo(s[2], s[3]); f.stroke({ width: 4, color: 0xd0533b, alpha: 0.75 }); }
    this.bordersDirty = false;
  }

  redrawRuins() {
    const g = this.ruinsG; g.clear();
    for (const [t, r] of this.S.ruins) {
      const x = this.cx0[t], y = this.cy[t];
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
      // illustrated artwork from the atlas (letter glyphs only as a fallback)
      if (attachArt(s, this.atlas, u.type, this.S.defs.UNITS[u.type])) s.label.visible = false;
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
    if (b.na && inspect) return ['NEEDS MUNITIONS', 0x1b1405, 0xf0b54a, 'input'];
    if (b.st === 'planned') return [inspect ? 'AWAITING FUNDS' : 'PLANNED', 0x1b1405, 0xf1c75b, 'funds'];
    if (!b.d) return inspect && (b.cr || 1) < 0.6 ? ['SLOW: FEW HANDS', 0x1b1405, 0xf0b54a, 'staff'] : null;
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
      s.position.set(this.cx[b.t], this.cy[b.t]); s.t = b.t;
      this.bLayer.addChild(s); this.buildingSprites.set(b.id, s); s.key = ''; s.mkey = '';
      // words float above units, so they live on the label layer
      s.labels = new PIXI.Container(); s.labels.position.copyFrom(s.position); this.overlayTags.addChild(s.labels);
    }
    const city = b.ty === 'town' ? S.cityAt.get(b.t) : null;
    const era = b.o === S.civId ? S.econ?.age || 0 : S.civInfo[b.o]?.age ?? S.econ?.age ?? 0;
    const planned = b.st === 'planned', building = !b.d && !planned;
    const stock = city && city.stock ? Object.values(city.stock).reduce((a, v) => a + v, 0) : 0;
    const aiming = b.ty === 'aa_battery' && b.af >= 0;
    const key = [b.ty, b.o, b.st, era, building ? Math.round(b.p / 10) : 0, b.a, S.lod, b.lv || 1, b.ug, aiming, city ? (city.cap ? 'c' : '') + Math.min(5, Math.floor(stock / 150)) : ''].join('|');
    if (key !== s.key) {
      // a brief burst when a site completes or a housing block gains storeys
      if (s.key && ((s.wasDone === false && b.d) || (s.lv && (b.lv || 1) > s.lv))) { this.ping(b.t, 0.8, 0x8fe0a8); this.combat?.dust?.(this.cx[b.t], this.cy[b.t], 6, 1.6, 0); }
      s.key = key; s.wasDone = !!b.d; s.lv = b.lv || 1;
      drawBuildingArt(s.body, b, def, { id: b.id, era, civ: S.civColor(b.o), lod: S.lod, ghost: planned, building, damaged: b.st === 'damaged', active: !!b.a, level: b.lv || 1, upgraded: !!b.ug, aimed: aiming,
        alpha: building ? 0.3 + 0.7 * (b.p / 100) : 1, capital: city?.cap, stockCrates: Math.floor(stock / 150), water: b.ty === 'port' ? waterDir(this, S, b.t) : null });
    }
    // progress, condition, training and selection marks
    const sel = S.selBuilding === b.id || !!S.selBuildings?.has(b.id);
    const mkey = [b.hp, b.p, b.d, b.tr ?? -1, sel, S.lod, planned, b.af ?? -1].join('|');
    if (mkey !== s.mkey) {
      s.mkey = mkey;
      const g = s.marks; g.clear();
      const R0 = b.ty === 'town' ? 12 : 10.5;
      if (building) g.rect(-8, 9.5, 16, 2.2).fill({ color: 0x1b1405, alpha: 0.85 }).rect(-8, 9.5, (16 * b.p) / 100, 2.2).fill({ color: 0xf1c75b });
      if (b.hp < 100 && b.d) g.rect(-8, -R0 - 3, 16, 2).fill({ color: 0x220d09, alpha: 0.85 }).rect(-8, -R0 - 3, (16 * b.hp) / 100, 2).fill({ color: b.hp > 50 ? 0x6db36a : 0xd0533b });
      if (b.tr != null && b.d) g.arc(0, 0, R0, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * b.tr) / 100).stroke({ width: 1.8, color: 0x8fe0a8, alpha: 0.95 });
      if (sel) g.poly(this.hexLocal(R0 + 1.5)).stroke({ width: 1.8, color: 0xf1c75b });
      // an AA battery in action swings its barrels toward the aircraft it is engaging
      if (b.ty === 'aa_battery' && b.af >= 0 && S.lod !== 'strategic') {
        const dx = this.nx(b.af, this.cx[b.t]) - this.cx[b.t], dy = this.cy[b.af] - this.cy[b.t], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
        g.moveTo(-0.5, 0).lineTo(-0.5 + ux * 8, -2 + uy * 6).moveTo(0.6, 0.4).lineTo(0.6 + ux * 8, -1.6 + uy * 6).stroke({ width: 1.2, color: 0x2f3632 });
      }
      // operational zoom: a compact category marker in the corner (industry, power, science…)
      if (S.lod === 'city' && b.ty !== 'house' && b.ty !== 'town' && !planned) g.circle(R0 - 2.5, -R0 + 3.5, 1.9).fill({ color: CAT_COL[def.cat] || 0x888888 }).stroke({ width: 0.6, color: 0x0b1518 });
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
      // zoomed out, construction is aggregated per city instead of one bar per site
      const sites = own && S.lod === 'strategic' ? (this.consCount?.get(city.id) || 0) : 0;
      if (sites && !troubles.length) troubles.push(`⚒ ${sites} UNDER CONSTRUCTION`);
      if (troubles.length) this.setTag(s.chips, troubles.join(' · '), 0xffffff, sites && troubles.length === 1 ? 0x6a5414 : 0xb5432f);
      else if (gov) this.setTag(s.chips, gov, 0xdff3e6, 0x24533c);
      s.chips.visible = !!(troubles.length || gov);
    }
    return s;
  }
  hexLocal(r) { const p = []; for (let k = 0; k < 6; k++) p.push(r * CORNERS[k][0], r * CORNERS[k][1]); return p; }

  syncBuildings() {
    const S = this.S;
    this.consCount = new Map(); for (const b of S.buildings.values()) if (b.o === S.civId && !b.d) this.consCount.set(b.c, (this.consCount.get(b.c) || 0) + 1);
    for (const [id, s] of this.buildingSprites) if (!S.buildings.has(id)) { s.labels?.destroy({ children: true }); s.destroy({ children: true }); this.buildingSprites.delete(id); }
    for (const b of S.buildings.values()) this.buildingSprite(b);
  }

  // AI offensives (spectators): a dashed arrow from the army to the city it marches on, labelled.
  syncCampaigns() {
    const S = this.S;
    this.campTags = this.campTags || [];
    const list = S.campaigns || [];
    list.forEach((c, i) => {
      // both ends on the same side of the seam: the arrow points at the nearby target, never round the world
      const x0 = this.cx[c.from], y0 = this.cy[c.from], x1 = this.nx(c.to, x0), y1 = this.cy[c.to];
      const L = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      c.x0 = x0; c.x1 = x1; c.mx = (x0 + x1) / 2 - uy * L * 0.12; c.my = (y0 + y1) / 2 + ux * L * 0.12;
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
      const x0 = c.x0, y0 = this.cy[c.from], x1 = c.x1, y1 = this.cy[c.to];
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
      t.tile = a.center; t.tx = this.cx[a.center]; t.ty = this.cy[a.center] - 4;
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
    { const k = (this.S.fwVersion || 0) + (this.S.lod === 'strategic' ? 's' : 'c'); if (k !== this.fwKey) { this.fwKey = k; drawFieldworks(this.fwG, this, this.S, this.S.lod === 'strategic'); } }
    S.onFrame?.(dt);
    let sx = 0, sy = 0;
    if (this.S.shakeOff) this.shake = 0;
    if (this.shake > 0) { this.shake = Math.max(0, this.shake - dt); sx = (Math.random() - 0.5) * 10 * this.shake; sy = (Math.random() - 0.5) * 10 * this.shake; }
    if (this.wrap && Math.abs(this.cam.x) > this.P * 32) this.recenter();
    const z = this.cam.z;
    this.world.scale.set(z); this.world.position.set(-this.cam.x * z + sx, -this.cam.y * z + sy);
    this.lightWorld.scale.set(z); this.lightWorld.position.copyFrom(this.world.position);
    this.rebase();
    this.vr = this.viewRect(R * 2);
    if (this.rebased) {
      // everything positioned from cx moves to the copy nearest the camera
      this.rebased = false;
      for (const s of this.buildingSprites.values()) { s.x = this.cx[s.t]; s.labels.x = s.x; }
      if (this.armyTags) for (const t of this.armyTags.values()) { t.tx = this.cx[t.tile]; t.sx = t.tx; }
      this.syncCampaigns?.();
    }
    S.lod = lodFor(z, S.lod);
    if (S.lod !== this.lastLod) { this.lastLod = S.lod; this.syncBuildings(); }
    const off = this.wrap ? this.period * this.P : 0;   // the layers' own period offset
    for (const ch of this.chunks) {
      const vy = ch.y1 > this.vr[1] && ch.y0 < this.vr[3];
      const v = vy && ch.x1 + off > this.vr[0] && ch.x0 + off < this.vr[2]; ch.ts.visible = v; ch.os.visible = v;
      for (const m of ch.mirrors) { const mv = vy && ch.x1 + off + m.k * this.P > this.vr[0] && ch.x0 + off + m.k * this.P < this.vr[2]; m.mt.visible = mv; m.mo.visible = mv; }
    }
    // labels keep a readable size on screen whatever the zoom
    const ts = Math.min(3, Math.max(0.55, 1.35 / z));
    const tagS = Math.min(2.6, Math.max(0.6, 2 / z));
    for (const s of this.buildingSprites.values()) {
      s.visible = this.inView(s.x, s.y, 40); s.labels.visible = s.visible;
      if (!s.visible) continue;
      s.scale.set(S.lod === 'strategic' ? Math.min(2.6, 1.15 / z) : 1);   // pictograms stay readable zoomed out
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
    for (const u of S.units.values()) { const k = S.defs.UNITS[u.type].air ? -1 - u.id : u.next >= 0 && u.prog > 50 ? u.next : u.tile; const a = stacks.get(k) || []; a.push(u); stacks.set(k, a); }
    const parked = new Map();   // airfield tile -> aircraft parked there, for apron slots
    const k1 = Math.min(1, dt * 9);
    this.hitGrid.clear(); this.badgeHits = [];
    const badges = new Set();
    for (const [tileKey, arr] of stacks) {
      // stacks: up to three pieces of artwork and a count badge with the stack's average strength
      const MAXV = arr.length > 3 ? 3 : arr.length;
      if (arr.length > 3) {
        badges.add(tileKey);
        let bt = this.stackBadges.get(tileKey);
        if (!bt) { bt = new PIXI.Container(); bt.g = new PIXI.Graphics(); bt.t = new PIXI.Text({ text: '', style: { fontFamily: 'Barlow Semi Condensed, sans-serif', fontSize: 9, fontWeight: '700', fill: 0xffffff } }); bt.t.anchor.set(0.5); bt.t.resolution = 4; bt.addChild(bt.g, bt.t); this.uLayer.addChild(bt); this.stackBadges.set(tileKey, bt); }
        const own = arr[0].owner, hp = Math.round(arr.reduce((s2, x) => s2 + x.hp, 0) / arr.length), key = arr.length + '|' + hp + '|' + own;
        if (bt.k !== key) { bt.k = key; bt.t.text = '×' + arr.length; bt.g.clear().roundRect(-9, -6, 18, 12, 3).fill({ color: 0x0b1518, alpha: 0.85 }).stroke({ width: 1.2, color: S.civColor(own) }).rect(-8, 6.5, 16, 2).fill({ color: 0x220d09 }).rect(-8, 6.5, (16 * hp) / 100, 2).fill({ color: hp > 40 ? 0x7ccf73 : 0xe0533b }); }
        const sc = S.lod === 'strategic' ? Math.min(2.4, 1 / this.cam.z) : 1;
        bt.scale.set(sc); bt.position.set(this.cx[tileKey], this.cy[tileKey] - 14 * sc); bt.visible = this.inView(bt.x, bt.y);
        if (bt.visible) { const [px, py] = this.worldToScreen(bt.x, bt.y); this.badgeHits.push([px, py, tileKey, arr[0].owner, 12 * sc]); }
      }
      arr.forEach((u, idx) => {
        const s = this.unitSprite(u); seen.add(u.id);
        let tx = this.cx[u.tile], ty = this.cy[u.tile];
        if (u.next >= 0) { const p = u.prog / 100; tx += (this.near(this.cx[u.next], tx) - tx) * p; ty += (this.cy[u.next] - ty) * p; }
        const shown = MAXV;
        if (idx >= MAXV) { s.visible = false; s.dx = tx; s.dy = ty; return; }
        if (arr.length > 1) { const a = (idx / shown) * Math.PI * 2 + 0.6, rr = Math.min(7, 3 + shown * 1.4); tx += Math.cos(a) * rr; ty += Math.sin(a) * rr * 0.8; }
        const adef = S.defs.UNITS[u.type];
        if (adef.air) {
          const st = u.air?.st, grounded = u.air ? u.air.grounded : false;
          if (grounded) {
            // parked on the apron in rows; launching aircraft roll forward
            const n = parked.get(u.tile) || 0; parked.set(u.tile, n + 1);
            tx += ((n % 3) - 1) * 7 - 2; ty += (n < 3 ? -4 : 5) + Math.floor(n / 6) * 9;
            if (st === 'launching') tx += 6;
          } else {
            // aloft: orbit the patrol area while on station, a lazy racetrack otherwise
            const onStation = st === 'mission' && (u.air?.mis === 'patrol' || u.air?.mis === 'scout' || u.air?.mis === 'support');
            const holding = st === 'holding';
            const r = onStation ? 11 : holding ? 8 : 3, w = (adef.role === 'bomber' ? 0.55 : 0.9) * (u.id % 2 ? 1 : -1);
            const ph = this.t * w + u.id * 1.7;
            tx += Math.cos(ph) * r; ty += Math.sin(ph) * r * 0.75;
          }
        }
        if (this.wrap && Math.abs(tx - s.dx) > this.P / 2) s.dx += Math.round((tx - s.dx) / this.P) * this.P;   // crossed the seam
        const ox = s.dx, oy = s.dy;
        s.dx += (tx - s.dx) * k1; s.dy += (ty - s.dy) * k1;
        if (Math.hypot(s.dx - ox, s.dy - oy) > 0.05) s.heading = Math.atan2(s.dy - oy, s.dx - ox);
        const def = S.defs.UNITS[u.type];
        const aloft = def.air && !(u.air && u.air.grounded);
        // altitude: jets fly high (long shadow offset), helicopters and drones low; parked aircraft sit on the ground
        const alt = !aloft ? 0 : def.alt === 'high' ? 12 : 6;
        s.alt = s.alt == null ? alt : s.alt + (alt - s.alt) * Math.min(1, dt * 1.5);
        const hover = def.air ? s.alt + (aloft && def.alt !== 'high' ? Math.sin(this.t * 3 + u.id) * 1.2 : 0) : 0;
        s.position.set(s.dx, s.dy - hover);
        if (def.air) {
          // banking: the turn rate narrows the wingspan as the aircraft rolls into the turn
          const hd = s.heading ?? 0, dh = Math.atan2(Math.sin(hd - (s.lastHd ?? hd)), Math.cos(hd - (s.lastHd ?? hd)));
          s.lastHd = hd; s.bank = (s.bank || 0) + ((aloft ? Math.max(-1, Math.min(1, dh / Math.max(0.001, dt) / 2.2)) : 0) - (s.bank || 0)) * Math.min(1, dt * 4);
        }
        s.visible = this.inView(s.dx, s.dy, 20);
        if (!s.visible) return;
        const sel = S.selUnits.has(u.id);
        updateArt(s, u, def, S, s.heading, S.lod === 'strategic');
        const key = [u.hp, u.sup, u.flags, sel, u.owner, S.lod, s.art ? u.vet : Math.round(s.heading * 4), u.det, S.prefs?.factionPattern, S.prefs?.highContrast].join('|');
        if (key !== s.key) { s.key = key; drawUnitBody(s.body, u, def, S, sel, s.heading, !!s.art); s.label.visible = !s.art && S.lod !== 'strategic'; }
        if (s.art && S.lod === 'strategic') s.scale.set(Math.min(2.2, 0.9 / this.cam.z)); else if (s.scale.x !== 1) s.scale.set(1);
        if (def.air && s.art) { s.artS = s.artS || s.art.scale.x; s.art.scale.set(s.artS * (u.air?.grounded ? 0.85 : 1), s.artS * (u.air?.grounded ? 0.85 : 1) * (1 - Math.min(0.45, Math.abs(s.bank || 0) * 0.45))); }
        // screen-space spatial index for O(1) hit-testing
        const [px, py] = this.worldToScreen(s.dx, s.dy);
        const ck = ((px / 32) | 0) + ',' + ((py / 32) | 0); const cell = this.hitGrid.get(ck); if (cell) cell.push(u.id); else this.hitGrid.set(ck, [u.id]);
      });
    }
    for (const [id, s] of this.unitSprites) if (!seen.has(id)) { s.destroy({ children: true }); this.unitSprites.delete(id); }
    for (const [k, bt] of this.stackBadges) if (!badges.has(k)) { bt.destroy(); this.stackBadges.delete(k); }
    this.drawAir(dt);
    this.ambient.frame(dt, this.t);
    this.combat.frame(dt, this.t);
    this.audio?.frame(dt);
    this.drawOverlay();
    this.tacT = (this.tacT || 0) + dt; if (this.tacT > 0.25) { this.tacT = 0; this.drawTactical(); }
    this.drawCampaigns();
    this.drawFx(dt);
  }

  // Aircraft: ground shadows, contrails, servicing at airfields, and for our own aircraft the patrol
  // orbit, return and low-fuel markers; with aircraft selected, the known enemy air defenses.
  drawAir(dt) {
    const S = this.S, D = S.defs, sh = this.airShadowG, g = this.airG; sh.clear(); g.clear();
    if (!D) return;
    const strategic = S.lod === 'strategic';
    const selAir = [...S.selUnits].map((id) => S.units.get(id)).filter((u) => u && u.owner === S.civId && D.UNITS[u.type].air);
    for (const u of S.units.values()) {
      const def = D.UNITS[u.type]; if (!def.air) continue;
      const s = this.unitSprites.get(u.id); if (!s || !s.visible) continue;
      const aloft = !(u.air && u.air.grounded);
      // shadow on the ground, offset and softened by altitude
      if (!strategic) {
        const a = s.alt || 0, big = def.role === 'bomber' ? 1.5 : def.role === 'fighter' ? 1.1 : 0.8;
        sh.ellipse(s.dx + a * 0.45, s.dy + 2 + a * 0.15, 7 * big * (1 - a / 40), 3 * big * (1 - a / 40)).fill({ color: 0x000000, alpha: aloft ? 0.16 : 0.26 });
      }
      // contrails behind high-flying jets
      if (aloft && def.alt === 'high' && !strategic && !S.prefs?.reducedMotion) {
        const tr = s.trail || (s.trail = []);
        tr.push([s.dx, s.dy - (s.alt || 0)]); if (tr.length > 18) tr.shift();
        for (let i = 1; i < tr.length; i++) if (Math.abs(tr[i][0] - tr[i - 1][0]) < 40) g.moveTo(tr[i - 1][0], tr[i - 1][1]).lineTo(tr[i][0], tr[i][1]).stroke({ width: 1.2, color: 0xe8eef0, alpha: (i / tr.length) * 0.35 });
      } else if (s.trail) s.trail.length = 0;
      if (u.owner !== S.civId || !u.air?.st) continue;
      const top = s.dy - (s.alt || 0) - 10;
      // low fuel / returning / waiting for supplies, as small icons over the aircraft
      if (aloft && u.air.fuel < 30) g.circle(s.dx + 6, top, 2.6).fill({ color: 0xd0533b }).stroke({ width: 0.8, color: 0x0b1518 });
      if (u.air.st === 'returning' || u.air.st === 'diverting') g.moveTo(s.dx - 4, top + 1).lineTo(s.dx - 1, top - 2).lineTo(s.dx + 2, top + 1).stroke({ width: 1.4, color: u.air.st === 'diverting' ? 0xf0b54a : 0x8fe0a8 });
      if (u.air.st === 'awaiting') g.rect(s.dx - 2, top - 2, 4, 4).fill({ color: 0xd0533b });
      if (u.air.st === 'servicing' && u.air.svc >= 0) { const p = u.air.svc / 100; g.arc(s.dx, s.dy, 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p).stroke({ width: 1.6, color: 0x8fe0a8, alpha: 0.9 }); }
    }
    // selected aircraft: their mission areas and routes
    for (const u of selAir) {
      const a = u.air; if (!a || !a.mis || a.mt < 0) continue;
      const s = this.unitSprites.get(u.id); if (!s) continue;
      const mx = this.nx(a.mt, s.dx), my = this.cy[a.mt];
      const col = a.mis === 'strike' ? 0xd0533b : a.mis === 'scout' ? 0xb4d4e8 : 0x7fb8e0;
      if (a.mis !== 'strike' && a.mis !== 'return') { const r = Math.max(1, a.rad) * this.hexW(); g.circle(mx, my, r).stroke({ width: 1.4, color: col, alpha: 0.75 }); g.circle(mx, my, r).fill({ color: col, alpha: 0.05 }); }
      else if (a.mis === 'strike') g.moveTo(mx - 5, my - 5).lineTo(mx + 5, my + 5).moveTo(mx + 5, my - 5).lineTo(mx - 5, my + 5).stroke({ width: 2, color: col });
      if (!a.grounded && a.st !== 'returning') for (let k = 0; k < 10; k++) { const p0 = k / 10, p1 = (k + 0.5) / 10; g.moveTo(s.dx + (mx - s.dx) * p0, s.dy + (my - s.dy) * p0).lineTo(s.dx + (mx - s.dx) * p1, s.dy + (my - s.dy) * p1); }
      g.stroke({ width: 1, color: col, alpha: 0.6 });
    }
    // air-defense threat: the reach of known enemy AA (batteries, flak, AA vehicles) while aircraft are selected
    if (selAir.length || S.mode?.kind?.startsWith?.('air')) {
      const hostile = (o) => o !== S.civId && (S.civInfo[o]?.rel?.state === 'war' || S.civInfo[o]?.rebel);
      for (const b of S.buildings.values()) {
        const d = D.BUILDINGS[b.ty]; if (!hostile(b.o) || d.defense !== 'air' || !b.d) continue;
        const x = this.nx(b.t, this.camCenterX()), y = this.cy[b.t], r = (d.range + (b.ug ? 1 : 0)) * this.hexW();
        if (!this.inView(x, y, r)) continue;
        g.circle(x, y, r).fill({ color: 0xd0533b, alpha: 0.07 }); g.circle(x, y, r).stroke({ width: 1.4, color: 0xd0533b, alpha: 0.6 });
      }
      for (const u of S.units.values()) {
        const d = D.UNITS[u.type]; if (!hostile(u.owner) || !(d.aa > 1) || d.air) continue;
        const s = this.unitSprites.get(u.id); if (!s || !s.visible) continue;
        g.circle(s.dx, s.dy, d.range * this.hexW()).stroke({ width: 1, color: 0xd0533b, alpha: 0.45 });
      }
    }
  }
  // a stack badge under the pointer: [tile, owner] or null
  badgeAtScreen(sx, sy) {
    for (const [x, y, tile, owner, r] of this.badgeHits || []) if (Math.abs(sx - x) <= r + 4 && Math.abs(sy - y) <= r * 0.7 + 4) return { tile, owner };
    return null;
  }
  hexW() { return this.hexStep || (this.hexStep = Math.abs(this.cx[1] - this.cx[0]) || 18); }

  // Hit-testing is generous (a missed click on a moving unit is punishing): the radius grows with
  // zoom, and moving units are matched against where they are drawn this frame.
  unitAtScreen(sx, sy, filter, radius) {
    const R = radius || Math.max(16, Math.min(30, 12 * this.cam.z));
    let best = null, bd = R * R;
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

  // Front Lines and Tactical lenses (and a light version for a selected force): control zones,
  // contested gaps, fortified positions, formation lines and objectives, convoys, units in trouble.
  // Only what this client has been sent (fog-filtered by the server) is drawn.
  drawTactical() {
    const S = this.S, g = this.tacG; g.clear();
    const lens = S.lens, D = S.defs; if (!D) return;
    const selF = new Set([...S.selUnits].map((id) => S.units.get(id)?.form).filter(Boolean));
    // convoys on the move always show their cargo and where they are going
    for (const c of S.econ?.convoys || []) {
      if (c.state === 'available') continue;
      const s = this.unitSprites.get(c.truck); if (!s || !s.visible) continue;
      const col = c.state === 'blocked' ? 0xe0533b : c.state === 'returning' ? 0x9aa58a : 0x8fd19e;
      if (c.cargo > 0) g.rect(s.dx - 3, s.dy - 14, 6, 5).fill({ color: 0xb9a77a }).stroke({ width: 1, color: col });
      if (c.dest >= 0 && (S.selUnits.has(c.truck) || lens === 'front' || lens === 'tactical')) { const dx = this.nx(c.dest, s.dx); for (let k = 0; k < 8; k++) { const a = k / 8, b = (k + 0.5) / 8; g.moveTo(s.dx + (dx - s.dx) * a, s.dy + (this.cy[c.dest] - s.dy) * a).lineTo(s.dx + (dx - s.dx) * b, s.dy + (this.cy[c.dest] - s.dy) * b); } g.stroke({ width: 1.2, color: col, alpha: 0.8 }); g.rect(dx - 3, this.cy[c.dest] - 3, 6, 6).stroke({ width: 1.4, color: col }); }
    }
    if (lens !== 'front' && lens !== 'tactical' && !selF.size) return;
    const hexAt = (t, col, a) => g.poly(this.hexPoints(t, -1)).fill({ color: col, alpha: a });
    if (lens === 'front') {
      const mine = new Map(), theirs = new Map();
      for (const u of S.units.values()) {
        const d = D.UNITS[u.type]; if (d.air || d.civilian || u.hp < 15) continue;
        const m = u.owner === S.civId ? mine : S.civInfo[u.owner]?.rel?.state === 'war' || S.civInfo[u.owner]?.rebel ? theirs : null; if (!m) continue;
        m.set(u.tile, 2); for (let k = 0; k < 6; k++) { const n = this.nb(u.tile, k); if (n >= 0 && !m.has(n)) m.set(n, 1); }
      }
      for (const [t, w] of mine) if (this.inView(this.cx[t], this.cy[t])) hexAt(t, theirs.has(t) ? 0xf0b54a : S.civColor(S.civId), theirs.has(t) ? 0.32 : w === 2 ? 0.22 : 0.1);
      for (const [t, w] of theirs) if (!mine.has(t) && this.inView(this.cx[t], this.cy[t])) hexAt(t, 0xd0533b, w === 2 ? 0.28 : 0.12);
      for (const f of S.fw?.values() || []) if (f.p >= 100 && this.inView(this.cx[f.t], this.cy[f.t])) g.poly(this.hexPoints(f.t, -2)).stroke({ width: 1.6, color: f.o === S.civId ? 0x8fd19e : 0xd0533b, alpha: 0.9 });
    }
    // formation lines (selected ones always; all of them on the tactical/front lenses)
    for (const f of S.econ?.formations || []) {
      if (!(lens === 'tactical' || lens === 'front' || selF.has(f.id))) continue;
      const slots = Object.values(f.slots || {}); if (!slots.length) continue;
      for (const t of new Set(slots)) g.poly(this.hexPoints(t, -3)).stroke({ width: 1.2, color: f.behavior === 'hold' ? 0x8fd19e : f.behavior === 'attackMove' ? 0xf0b54a : 0x6fa8dc, alpha: 0.85 });
      const [a, b] = f.line || []; if (a >= 0 && b >= 0) g.moveTo(this.cx[a], this.cy[a]).lineTo(this.nx(b, this.cx[a]), this.cy[b]).stroke({ width: 1.4, color: 0xf1c75b, alpha: 0.6 });
    }
    if (lens === 'tactical' || lens === 'front') {
      // army objectives and defensive zones
      for (const a of S.econ?.armies || []) { const o = a.order || {}; if (o.tile >= 0) { if (o.kind === 'defend') g.circle(this.cx[o.tile], this.cy[o.tile], (o.radius || 4) * 18).stroke({ width: 1.4, color: 0x6fa8dc, alpha: 0.7 }); else g.circle(this.cx[o.tile], this.cy[o.tile], 7).stroke({ width: 2, color: 0xf0b54a }); } }
      for (const c of S.econ?.caches || []) g.rect(this.cx[c.t] - 4, this.cy[c.t] - 4, 8, 8).fill({ color: 0x8fd19e, alpha: 0.5 }).stroke({ width: 1, color: 0x0b1518 });
      // own units in trouble
      for (const u of S.units.values()) {
        if (u.owner !== S.civId) continue; const s = this.unitSprites.get(u.id); if (!s || !s.visible) continue;
        if (u.flags & 4) g.circle(s.dx, s.dy, 13).stroke({ width: 1.6, color: 0xe0533b, alpha: 0.9 });
        else if (u.supp >= 60) g.circle(s.dx, s.dy, 13).stroke({ width: 1.6, color: 0xf0b54a, alpha: 0.9 });
      }
    }
  }

  drawOverlay() {
    const S = this.S, g = this.overlay; g.clear();
    const m = S.mode;
    if (m && m.kind === 'build' && m.tiles) for (const i of m.tiles) if (this.inView(this.cx[i], this.cy[i])) g.poly(this.hexPoints(i, -1.5)).stroke({ width: 1.3, color: 0x8fe0a8, alpha: 0.85 });
    // ghost of the building under the cursor: its real artwork, green where it can go, red where not
    const gk = m && m.kind === 'build' && S.hover >= 0 ? m.type + '|' + S.hover + '|' + (m.tiles ? m.tiles.has(S.hover) : '?') + '|' + S.lod : '';
    if (gk !== this.ghostKey) {
      this.ghostKey = gk; this.ghost.clear();
      if (gk && S.lod !== 'strategic') {
        const def = S.defs.BUILDINGS[m.type], ok = !m.tiles || m.tiles.has(S.hover);
        drawBuildingArt(this.ghost, { id: -1, ty: m.type, o: S.civId, t: S.hover }, def, { id: 1, era: S.econ?.age || 0, civ: S.civColor(S.civId), lod: S.lod, ghost: true, building: false, alpha: 0.75 });
        this.ghost.poly(this.hexLocal(R - 0.5)).stroke({ width: 1.6, color: ok ? 0x8fe0a8 : 0xe0533b, alpha: 0.95 });
        this.ghost.alpha = ok ? 0.85 : 0.5;
      }
    }
    if (this.ghostKey) this.ghost.position.set(this.cx[S.hover], this.cy[S.hover]);
    // selected units' server-computed routes
    for (const id of S.selUnits) {
      const p = S.paths[id]; const s = this.unitSprites.get(id); if (!p || !p.length || !s) continue;
      // the route along the actual path: each hex placed next to the previous one
      const pts = this.tilePts(p, s.dx);
      g.moveTo(s.dx, s.dy); for (const [x, y] of pts) g.lineTo(x, y);
      g.stroke({ width: 1.4, color: 0xf1c75b, alpha: 0.55 });
      const lp = pts[pts.length - 1]; g.circle(lp[0], lp[1], 3).fill({ color: 0xf1c75b, alpha: 0.8 });
    }
    // road projects under construction
    for (const pr of S.econ?.roads || []) {
      const t = pr.tiles; if (!t || t.length < 2) continue;
      const pts = this.tilePts(t);
      g.moveTo(pts[0][0], pts[0][1]); for (const [x, y] of pts) g.lineTo(x, y);
      g.stroke({ width: 2.4, color: pr.status === 'paused' || pr.status === 'blocked' ? 0xd0533b : 0xc99a2e, alpha: 0.5 });
      g.circle(pts[0][0], pts[0][1], 2.5).fill({ color: 0xc99a2e });
    }
    // road planner preview: per-segment validity from the server
    if (m && m.kind === 'road') {
      for (const w of m.points) g.circle(this.cx[w], this.cy[w], 4).stroke({ width: 2, color: 0xf1c75b });
      const plan = m.preview;
      if (plan) for (const sgm of plan.segments) {
        const col = sgm.skip ? 0x9aa5a0 : sgm.ok ? (sgm.bridge ? 0x6fc3ff : 0x8fe0a8) : 0xe0533b;
        g.moveTo(this.cx[sgm.a], this.cy[sgm.a]).lineTo(this.nx(sgm.b, this.cx[sgm.a]), this.cy[sgm.b]).stroke({ width: 4, color: col, alpha: 0.85 });
      }
    }
    // trench line planner: the route (green valid, red invalid, grey existing, blue reinforcing) and
    // small direction markers on the protected side; existing trench projects outlined
    if (m && m.kind === 'trench') {
      for (const w of m.points) g.circle(this.cx[w], this.cy[w], 4).stroke({ width: 2, color: 0xf1c75b });
      const plan = m.preview;
      if (plan) {
        const pts = this.tilePts(plan.tiles);
        for (let i = 1; i < pts.length; i++) g.moveTo(pts[i - 1][0], pts[i - 1][1]).lineTo(pts[i][0], pts[i][1]);
        g.stroke({ width: 2, color: 0xf1c75b, alpha: 0.55 });
        const [fx, fy] = plan.facing || [0, -1];
        plan.segments.forEach((sg, i) => {
          const [x, y] = pts[i] || [this.cx[sg.t], this.cy[sg.t]];
          const col = !sg.ok ? 0xe0533b : sg.skip ? 0x9aa5a0 : sg.upgrade ? 0x6fc3ff : 0x8fe0a8;
          g.poly(this.hexPoints(sg.t, -2).map((v, k) => (k % 2 ? v : v + (x - this.cx[sg.t])))).fill({ color: col, alpha: 0.18 }).stroke({ width: 1.5, color: col, alpha: 0.95 });
          if (sg.ok && !sg.skip) g.moveTo(x, y).lineTo(x + fx * 8, y + fy * 8).stroke({ width: 1.6, color: 0xf1c75b }).poly([x + fx * 10, y + fy * 10, x + fx * 6 - fy * 2.5, y + fy * 6 + fx * 2.5, x + fx * 6 + fy * 2.5, y + fy * 6 - fx * 2.5]).fill({ color: 0xf1c75b });
        });
      }
    }
    if (m && (m.kind === 'trench' || S.lens === 'tactical')) for (const pr of S.econ?.trenches?.projects || []) {
      if (pr.status === 'complete') continue;
      const pts = this.tilePts(pr.tiles); if (pts.length < 2) continue;
      g.moveTo(pts[0][0], pts[0][1]); for (const [x, y] of pts) g.lineTo(x, y);
      g.stroke({ width: 2, color: pr.status === 'materials' ? 0xd0533b : 0xc99a2e, alpha: 0.5 });
    }
    // defensive installations being placed: their reach, ground or air, and overlap with what exists
    if (m && m.kind === 'build' && S.defs.BUILDINGS[m.type]?.attack && S.hover >= 0) {
      const d = S.defs.BUILDINGS[m.type], air = d.defense === 'air';
      const col = air ? 0x6fc3ff : 0xf0b54a;
      g.circle(this.cx[S.hover], this.cy[S.hover], R * 1.75 * d.range + R).stroke({ width: 1.6, color: col, alpha: 0.9 });
      for (const b of S.buildings.values()) {
        if (b.o !== S.civId) continue; const bd = S.defs.BUILDINGS[b.ty]; if (!bd.attack || (bd.defense === 'air') !== air) continue;
        const x = this.nx(b.t, this.cx[S.hover]); if (!this.inView(x, this.cy[b.t], 200)) continue;
        g.circle(x, this.cy[b.t], R * 1.75 * (bd.range + (b.ug ? 1 : 0)) + R).stroke({ width: 1, color: col, alpha: 0.35 });
      }
    }
    // army zones & staging points
    for (const a of S.econ?.armies || []) {
      const o = a.order || {};
      if (o.kind === 'defend' && o.tile >= 0) g.circle(this.cx[o.tile], this.cy[o.tile], R * 1.6 * o.radius).stroke({ width: 1.5, color: 0x8fd19e, alpha: 0.5 });
      if (o.kind === 'offensive' && o.staging >= 0) {
        g.moveTo(this.cx[o.staging], this.cy[o.staging]).lineTo(this.nx(o.tile, this.cx[o.staging]), this.cy[o.tile]).stroke({ width: 2, color: 0xd0533b, alpha: 0.45 });
        g.rect(this.cx[o.staging] - 1, this.cy[o.staging] - 14, 2, 14).fill({ color: 0xe7e2d4 }).poly([this.cx[o.staging] + 1, this.cy[o.staging] - 14, this.cx[o.staging] + 10, this.cy[o.staging] - 10, this.cx[o.staging] + 1, this.cy[o.staging] - 6]).fill({ color: 0xd0533b });
      }
    }
    // building finder: pulse every match; count those off-screen
    // deposits and sites for a building the player wants to place (from a resource panel)
    if (S.deposits) {
      if (S.time > S.deposits.until && !(m && m.kind === 'build')) S.deposits = null;
      else { const pulse = 0.5 + 0.5 * Math.sin(this.t * 3); for (const t of S.deposits.tiles) { const x = this.cx[t], y = this.cy[t]; if (!this.inView(x, y, 10)) continue; g.poly(this.hexPoints(t, -1)).fill({ color: 0x6fc3ff, alpha: 0.12 + 0.12 * pulse }).stroke({ width: 1.6, color: 0x6fc3ff, alpha: 0.6 + 0.4 * pulse }); } }
    }
    // one building just focused from the finder or a construction list: a short bright pulse
    if (S.pulse) { const b = S.buildings.get(S.pulse.id); if (!b || S.time > S.pulse.until) S.pulse = null; else { const k = 0.5 + 0.5 * Math.sin(this.t * 8); g.poly(this.hexPoints(b.t, 2 + 3 * k)).stroke({ width: 3, color: 0xffffff, alpha: 0.5 + 0.5 * k }); } }
    if (S.find || S.findIds) {
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);
      let on = 0, off = 0;
      for (const b of S.buildings.values()) {
        if (b.o !== S.civId || !(S.findIds ? S.findIds.has(b.id) : findMatch(S, b.ty, S.find))) continue;
        const x = this.cx[b.t], y = this.cy[b.t];
        if (!this.inView(x, y, 0)) { off++; continue; }
        on++;
        g.circle(x, y, R * (1.05 + 0.25 * pulse)).stroke({ width: 2.4 / Math.max(0.6, this.cam.z) + 1, color: 0xf1c75b, alpha: 0.55 + 0.45 * pulse });
      }
      const label = `${on + off} found${off ? ` (${off} off-screen: see the minimap)` : ''}`;
      if (S.findLabel !== label) { S.findLabel = label; document.getElementById('hint').textContent = `Find: ${label}. ${S.findIds ? 'Esc' : 'Choose "Find…"'} to clear.`; }
    } else if (S.findLabel) { S.findLabel = null; document.getElementById('hint').textContent = ''; }
    if (S.hover >= 0 && S.terr[S.hover] !== 255) g.poly(this.hexPoints(S.hover, -0.5)).stroke({ width: 1.2, color: 0xffffff, alpha: 0.45 });
    if (S.selBuilding != null) { const b = S.buildings.get(S.selBuilding); if (b && b.r >= 0) { const rx = this.nx(b.r, this.cx[b.t]); g.moveTo(this.cx[b.t], this.cy[b.t]).lineTo(rx, this.cy[b.r]).stroke({ width: 1, color: 0x8fe0a8, alpha: 0.6 }); g.circle(rx, this.cy[b.r], 4).stroke({ width: 1.5, color: 0x8fe0a8 }); } }
  }

  drawFx(dt) {
    const f = this.fxG; f.clear();
    this.pings = this.pings.filter((p) => (p.t -= dt) > 0);
    for (const p of this.pings) { const a = p.t / p.max; f.circle(this.cx[p.tile], this.cy[p.tile], R * (p.radius || 2) * (1.4 - a * 0.4)).stroke({ width: 3, color: p.color, alpha: a }); }
    // deployment preview: ghost slots with per-hex counts (colour by density), the facing,
    // ranks, impassable hexes; the same planner the server will run on commit
    const dp = this.S.deploy;
    if (dp && dp.plan) {
      const p = dp.plan, ln = p.line || [];
      // the dragged line stays continuous across the seam: each hex next to the previous one
      const anchor = dp.anchorX ?? (ln.length ? this.cx[ln[0]] : this.camCenterX());
      const lpts = this.tilePts(ln, anchor);
      if (lpts.length) { f.moveTo(lpts[0][0], lpts[0][1]); for (const [x, y] of lpts) f.lineTo(x, y); f.stroke({ width: 2, color: 0xf1c75b, alpha: 0.8 }); }
      const midX = lpts.length ? lpts[Math.floor(lpts.length / 2)][0] : anchor;
      for (const [t, n] of p.perHex) {
        const x = this.nx(t, midX), y = this.cy[t];
        const col = n >= 4 ? 0xe0533b : n >= 2 ? 0xf0b54a : 0x8fd19e;
        f.poly(this.hexPoints(t, -2).map((v, i) => (i % 2 ? v : v + (x - this.cx[t])))).fill({ color: col, alpha: 0.18 }).stroke({ width: 1.4, color: col, alpha: 0.9 });
        for (let k = 0; k < Math.min(n, 9); k++) { const a = (k / Math.min(n, 9)) * Math.PI * 2 - Math.PI / 2, rr = n > 1 ? 4.5 : 0; f.circle(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 1.8).fill({ color: col }); }
      }
      for (const t of p.invalid) { const x = this.nx(t, midX), y = this.cy[t]; f.moveTo(x - 4, y - 4).lineTo(x + 4, y + 4).moveTo(x + 4, y - 4).lineTo(x - 4, y + 4).stroke({ width: 2, color: 0xe0533b }); }
      if (lpts.length) {
        const [mx, my] = lpts[Math.floor(lpts.length / 2)], [fx, fy] = p.facing || [0, -1];
        f.moveTo(mx, my).lineTo(mx + fx * 18, my + fy * 18).stroke({ width: 2.4, color: 0xf1c75b });
        f.poly([mx + fx * 24, my + fy * 24, mx + fx * 16 - fy * 5, my + fy * 16 + fx * 5, mx + fx * 16 + fy * 5, my + fy * 16 - fx * 5]).fill({ color: 0xf1c75b });
      }
    }
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

// Building finder classes (shared with the minimap).
const FIND_CLASSES = { milprod: ['barracks', 'motor_works', 'heavy_assembly', 'airfield', 'drone_works', 'robotics_complex'], defense: ['bunker', 'fort'], power: ['power_plant', 'fusion_plant'], research: ['academy', 'university', 'seismic'], food: ['farm', 'port'], logistics: ['depot', 'port', 'comms_tower'] };
export function findMatch(S, type, key) {
  if (!key) return false;
  if (!key.startsWith('class:')) return type === key;
  const c = key.slice(6);
  if (c === 'industry') return S.defs.BUILDINGS[type]?.cat === 'industry';
  return (FIND_CLASSES[c] || []).includes(type);
}

// Chain directed border edges (all taken from hexes of one owner, so the land is always on the same
// side) into polylines and offset them a little toward the land. Returns arrays of [x, y] points.
function chainBorder(segs, inset = 1.3) {
  const key = (x, y) => Math.round(x * 4) + ',' + Math.round(y * 4);
  const from = new Map();
  for (const s of segs) { const k = key(s[0], s[1]); const a = from.get(k); if (a) a.push(s); else from.set(k, [s]); }
  const used = new Set(), out = [];
  for (const s0 of segs) {
    if (used.has(s0)) continue;
    let guard = 0;
    const chain = [s0]; used.add(s0);
    let cur = s0;
    while (guard++ < 100000) {
      const nx = (from.get(key(cur[2], cur[3])) || []).find((x) => !used.has(x));
      if (!nx) break;
      used.add(nx); chain.push(nx); cur = nx;
    }
    const pts = [[chain[0][0], chain[0][1]], ...chain.map((c) => [c[2], c[3]])];
    const closed = key(pts[0][0], pts[0][1]) === key(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    // which side is the land: toward the hex centre of the first edge
    const c0 = chain[0], dx = c0[2] - c0[0], dy = c0[3] - c0[1], mx = (c0[0] + c0[2]) / 2, my = (c0[1] + c0[3]) / 2;
    const sign = (-dy) * (c0[4] - mx) + dx * (c0[5] - my) >= 0 ? 1 : -1;
    const nrm = (a, b) => { const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1; return [(-ey / l) * sign, (ex / l) * sign]; };
    const n = pts.length, res = [];
    for (let k = 0; k < n; k++) {
      const prev = k > 0 ? pts[k - 1] : closed ? pts[n - 2] : null, next = k < n - 1 ? pts[k + 1] : closed ? pts[1] : null;
      const n1 = prev ? nrm(prev, pts[k]) : null, n2 = next ? nrm(pts[k], next) : null;
      let ox = (n1 ? n1[0] : 0) + (n2 ? n2[0] : 0), oy = (n1 ? n1[1] : 0) + (n2 ? n2[1] : 0);
      const l = Math.hypot(ox, oy) || 1; ox /= l; oy /= l;
      const cos = n1 && n2 ? Math.max(0.5, ox * n1[0] + oy * n1[1]) : 1;
      res.push([pts[k][0] + (ox * inset) / cos, pts[k][1] + (oy * inset) / cos]);
    }
    if (closed) { res[n - 1] = res[0]; res.closed = true; }
    out.push(res);
  }
  return out;
}
