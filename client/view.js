// PixiJS map renderer. It draws exactly what the server sends: tile colours are
// pre-shaded server-side, units arrive fog-filtered, paths arrive pre-computed.
/* global PIXI */
export const R = 12;
export const SQ3 = Math.sqrt(3);
const HW = (R * SQ3) / 2;
const CORNERS = [...Array(6)].map((_, k) => { const a = (Math.PI / 180) * (60 * k - 30); return [Math.cos(a), Math.sin(a)]; });
const EDGE = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
const DIRS_EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const DIRS_ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];
const UNKNOWN = '#10181b';
const RES_COLORS = { 1: '#f3e2b3', 2: '#d7d9dc', 3: '#22262a', 4: '#ffd34d', 5: '#e8e1d0', 6: '#bfe6ff' };

export class View {
  constructor(S, host) {
    this.S = S; this.host = host;
    this.W = S.W; this.H = S.H; this.N = S.W * S.H;
    this.cx = new Float32Array(this.N); this.cy = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) { const q = i % this.W, r = (i / this.W) | 0; this.cx[i] = R * SQ3 * (q + 0.5 * (r & 1)) + HW; this.cy[i] = R * 1.5 * r + R; }
    this.pw = Math.ceil(R * SQ3 * (this.W + 0.5) + 2); this.ph = Math.ceil(R * 1.5 * this.H + R + 2);
    this.unitSprites = new Map(); this.buildingSprites = new Map(); this.fx = []; this.pings = [];
    this.shake = 0;
  }

  async init() {
    const app = new PIXI.Application();
    await app.init({ resizeTo: this.host, background: 0x0d1416, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) });
    this.app = app;
    this.host.appendChild(app.canvas);
    this.world = new PIXI.Container();
    app.stage.addChild(this.world);
    this.tc = document.createElement('canvas'); this.tc.width = this.pw; this.tc.height = this.ph;
    this.tctx = this.tc.getContext('2d');
    this.tctx.fillStyle = UNKNOWN; this.tctx.fillRect(0, 0, this.pw, this.ph);
    this.oc = document.createElement('canvas'); this.oc.width = this.pw; this.oc.height = this.ph;
    this.octx = this.oc.getContext('2d');
    this.tTex = PIXI.Texture.from(this.tc); this.oTex = PIXI.Texture.from(this.oc);
    this.world.addChild(new PIXI.Sprite(this.tTex));
    this.world.addChild(new PIXI.Sprite(this.oTex));
    this.borders = new PIXI.Graphics(); this.world.addChild(this.borders);
    this.overlay = new PIXI.Graphics(); this.world.addChild(this.overlay);   // placement, paths, roads in progress
    this.bLayer = new PIXI.Container(); this.world.addChild(this.bLayer);
    this.uLayer = new PIXI.Container(); this.world.addChild(this.uLayer);
    this.fxG = new PIXI.Graphics(); this.world.addChild(this.fxG);
    this.selG = new PIXI.Graphics(); app.stage.addChild(this.selG);       // screen-space drag box
    this.cam = { x: 0, y: 0, z: 1 };
    this.dirtyTiles = new Set(); this.dirtyOverlay = new Set(); this.overlayAll = true; this.bordersDirty = true;
    app.ticker.add((t) => this.frame(t.deltaMS / 1000));
  }

  // ---------------------------------------------------------------- camera
  centerOn(i, z) { if (z) this.cam.z = z; const sw = this.app.screen.width, sh = this.app.screen.height; this.cam.x = this.cx[i] - sw / 2 / this.cam.z; this.cam.y = this.cy[i] - sh / 2 / this.cam.z; this.clamp(); }
  clamp() {
    const sw = this.app.screen.width / this.cam.z, sh = this.app.screen.height / this.cam.z;
    this.cam.x = Math.max(-sw * 0.4, Math.min(this.pw - sw * 0.6, this.cam.x));
    this.cam.y = Math.max(-sh * 0.4, Math.min(this.ph - sh * 0.6, this.cam.y));
  }
  zoomAt(f, sx, sy) {
    const z0 = this.cam.z, z1 = Math.max(0.3, Math.min(3, z0 * f));
    const wx = this.cam.x + sx / z0, wy = this.cam.y + sy / z0;
    this.cam.z = z1; this.cam.x = wx - sx / z1; this.cam.y = wy - sy / z1; this.clamp();
  }
  screenToWorld(sx, sy) { return [this.cam.x + sx / this.cam.z, this.cam.y + sy / this.cam.z]; }
  worldToScreen(x, y) { return [(x - this.cam.x) * this.cam.z, (y - this.cam.y) * this.cam.z]; }
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

  // ---------------------------------------------------------------- terrain canvas
  hexPath(ctx, i, grow = 0) {
    const x = this.cx[i], y = this.cy[i], rr = R + grow;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) { const px = x + rr * CORNERS[k][0], py = y + rr * CORNERS[k][1]; k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath();
  }
  hexPoints(i, grow = 0) { const pts = []; for (let k = 0; k < 6; k++) pts.push(this.cx[i] + (R + grow) * CORNERS[k][0], this.cy[i] + (R + grow) * CORNERS[k][1]); return pts; }

  redrawTiles(set) {
    const S = this.S, ctx = this.tctx;
    const all = new Set(set);
    for (const i of set) for (let d = 0; d < 6; d++) { const n = this.nb(i, d); if (n >= 0) all.add(n); }
    for (const i of all) {
      const col = S.terr[i] === 255 ? UNKNOWN : '#' + S.color[i].toString(16).padStart(6, '0');
      this.hexPath(ctx, i, 0.6); ctx.fillStyle = col; ctx.fill();
    }
    ctx.lineCap = 'round';
    for (const i of all) {
      if (S.terr[i] === 255) continue;
      const x = this.cx[i], y = this.cy[i];
      // rivers flow toward their downstream neighbour
      if (S.flags[i] & 1 && S.fdir[i] >= 0) {
        const n = this.nb(i, S.fdir[i]);
        if (n >= 0) { ctx.strokeStyle = '#3f86c4'; ctx.lineWidth = 1.4 + S.fb[i] * 0.8; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(this.cx[n], this.cy[n]); ctx.stroke(); }
      }
    }
    for (const i of all) {
      if (S.terr[i] === 255 || !S.road[i]) continue;
      const x = this.cx[i], y = this.cy[i];
      let linked = false;
      for (let d = 0; d < 6; d++) {
        const n = this.nb(i, d); if (n < 0 || !S.road[n]) continue;
        linked = true;
        const mx = (x + this.cx[n]) / 2, my = (y + this.cy[n]) / 2;
        const rail = S.road[i] === 2 && S.road[n] === 2;
        ctx.strokeStyle = rail ? '#262422' : '#8c6a3c'; ctx.lineWidth = rail ? 3 : 2.4;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke();
        if (rail) { ctx.strokeStyle = '#b9b2a2'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke(); }
      }
      if (!linked) { ctx.fillStyle = '#8c6a3c'; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill(); }
    }
    ctx.font = 'bold 8px "Barlow Semi Condensed", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const i of all) {
      const r = S.res[i]; if (!r || S.terr[i] === 255) continue;
      const g = this.S.defs.RESOURCE[r].glyph;
      ctx.fillStyle = 'rgba(10,16,18,0.55)'; ctx.beginPath(); ctx.arc(this.cx[i] + 5, this.cy[i] - 5, 5.2, 0, 7); ctx.fill();
      ctx.fillStyle = RES_COLORS[r]; ctx.fillText(g, this.cx[i] + 5, this.cy[i] - 4.6);
    }
    this.tTex.source.update();
  }

  // ---------------------------------------------------------------- fog & lens overlay
  overlayFill(i) {
    const S = this.S;
    if (S.terr[i] === 255) return null;
    const fills = [];
    const lens = S.lens;
    if (lens === 'territory' && S.owner[i] >= 0) fills.push(hexA(S.civColor(S.owner[i]), 0.32));
    else if (lens === 'supply') { if (S.supply[i]) fills.push('rgba(79,190,140,0.30)'); else if (S.owner[i] === S.civId) fills.push('rgba(200,70,50,0.25)'); }
    else if (lens === 'stability' && S.stab[i] >= 0) { const v = S.stab[i] / 100; fills.push(`rgba(${Math.round(220 - 160 * v)},${Math.round(60 + 150 * v)},70,0.48)`); }
    if (!S.vis[i]) fills.push('rgba(9,16,19,0.5)');
    return fills;
  }
  redrawOverlay() {
    const ctx = this.octx;
    if (this.overlayAll) {
      ctx.clearRect(0, 0, this.pw, this.ph);
      for (let i = 0; i < this.N; i++) { const f = this.overlayFill(i); if (!f || !f.length) continue; this.hexPath(ctx, i, 0.6); for (const c of f) { ctx.fillStyle = c; ctx.fill(); } }
      this.overlayAll = false; this.dirtyOverlay.clear();
    } else {
      for (const i of this.dirtyOverlay) {
        ctx.save(); this.hexPath(ctx, i, 0.6); ctx.clip();
        ctx.clearRect(this.cx[i] - R - 1, this.cy[i] - R - 1, 2 * R + 2, 2 * R + 2);
        const f = this.overlayFill(i); if (f) for (const c of f) { ctx.fillStyle = c; ctx.fill(); }
        ctx.restore();
      }
      this.dirtyOverlay.clear();
    }
    this.oTex.source.update();
  }

  redrawBorders() {
    const S = this.S, g = this.borders; g.clear();
    const byCiv = new Map();
    for (let i = 0; i < this.N; i++) {
      const o = S.owner[i]; if (o < 0 || S.terr[i] === 255) continue;
      for (let d = 0; d < 6; d++) {
        const n = this.nb(i, d);
        if (n >= 0 && S.owner[n] === o) continue;
        const [a, b] = EDGE[d];
        let arr = byCiv.get(o); if (!arr) byCiv.set(o, arr = []);
        arr.push(this.cx[i] + (R - 1.2) * CORNERS[a][0], this.cy[i] + (R - 1.2) * CORNERS[a][1], this.cx[i] + (R - 1.2) * CORNERS[b][0], this.cy[i] + (R - 1.2) * CORNERS[b][1]);
      }
    }
    for (const [o, arr] of byCiv) {
      for (let k = 0; k < arr.length; k += 4) g.moveTo(arr[k], arr[k + 1]).lineTo(arr[k + 2], arr[k + 3]);
      g.stroke({ width: 2, color: S.civColor(o), alpha: 0.9 });
    }
    this.bordersDirty = false;
  }

  // ---------------------------------------------------------------- entities
  unitSprite(u) {
    let s = this.unitSprites.get(u.id);
    if (!s) {
      const S = this.S;
      s = new PIXI.Container();
      s.body = new PIXI.Graphics(); s.addChild(s.body);
      s.label = new PIXI.Text({ text: S.defs.UNITS[u.type].glyph, style: { fontFamily: 'Barlow Semi Condensed, sans-serif', fontSize: 9, fontWeight: '700', fill: 0xffffff } });
      s.label.anchor.set(0.5); s.label.resolution = 3; s.addChild(s.label);
      s.dx = this.cx[u.tile]; s.dy = this.cy[u.tile];
      s.position.set(s.dx, s.dy);
      this.uLayer.addChild(s);
      this.unitSprites.set(u.id, s);
      s.key = '';
    }
    return s;
  }

  buildingSprite(b) {
    let s = this.buildingSprites.get(b.id);
    const S = this.S, def = S.defs.BUILDINGS[b.ty];
    if (!s) {
      s = new PIXI.Container();
      s.body = new PIXI.Graphics(); s.addChild(s.body);
      s.glyph = new PIXI.Text({ text: def.glyph, style: { fontSize: b.ty === 'town' ? 15 : 12 } }); s.glyph.anchor.set(0.5); s.glyph.resolution = 3; s.addChild(s.glyph);
      if (b.ty === 'town') { s.name = new PIXI.Text({ text: '', style: { fontFamily: 'IM Fell English SC, serif', fontSize: 12, fill: 0xf3eedf, stroke: { color: 0x0b1518, width: 3 } } }); s.name.anchor.set(0.5, 0); s.name.position.set(0, 14); s.name.resolution = 3; s.addChild(s.name); }
      s.position.set(this.cx[b.t], this.cy[b.t]);
      this.bLayer.addChild(s); this.buildingSprites.set(b.id, s); s.key = '';
    }
    const city = b.ty === 'town' ? [...S.cities.values()].find((c) => c.t === b.t) : null;
    const key = [b.o, b.hp, b.d, b.p, S.selBuilding === b.id, city ? city.n + city.pop : ''].join('|');
    if (key !== s.key) {
      s.key = key;
      const g = s.body; g.clear();
      const sz = b.ty === 'town' ? 12 : 9;
      const col = S.civColor(b.o);
      g.roundRect(-sz, -sz, sz * 2, sz * 2, 3).fill({ color: 0x0f1a1d, alpha: 0.85 }).stroke({ width: 2, color: col, alpha: b.d ? 1 : 0.5 });
      if (!b.d) g.rect(-sz, sz + 2, (2 * sz * b.p) / 100, 3).fill({ color: 0xc99a2e });
      if (b.hp < 100) g.rect(-sz, -sz - 5, 2 * sz, 3).fill({ color: 0x220d09 }).rect(-sz, -sz - 5, (2 * sz * b.hp) / 100, 3).fill({ color: b.hp > 40 ? 0x6db36a : 0xd0533b });
      if (S.selBuilding === b.id) g.roundRect(-sz - 3, -sz - 3, sz * 2 + 6, sz * 2 + 6, 4).stroke({ width: 1.5, color: 0xc99a2e });
      s.glyph.alpha = b.d ? 1 : 0.55;
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
    if (this.dirtyTiles.size) { this.redrawTiles(this.dirtyTiles); this.dirtyTiles.clear(); }
    if (this.overlayAll || this.dirtyOverlay.size) this.redrawOverlay();
    if (this.bordersDirty) this.redrawBorders();
    this.S.onFrame?.(dt);
    // camera
    let sx = 0, sy = 0;
    if (this.shake > 0) { this.shake = Math.max(0, this.shake - dt); sx = (Math.random() - 0.5) * 10 * this.shake; sy = (Math.random() - 0.5) * 10 * this.shake; }
    this.world.scale.set(this.cam.z);
    this.world.position.set(-this.cam.x * this.cam.z + sx, -this.cam.y * this.cam.z + sy);
    // units: interpolate toward server positions, fan out stacks
    const seen = new Set();
    const stacks = new Map();
    for (const u of S.units.values()) { const k = u.next >= 0 && u.prog > 50 ? u.next : u.tile; const a = stacks.get(k) || []; a.push(u); stacks.set(k, a); }
    const k1 = Math.min(1, dt * 9);
    for (const [, arr] of stacks) {
      arr.forEach((u, idx) => {
        const s = this.unitSprite(u); seen.add(u.id);
        let tx = this.cx[u.tile], ty = this.cy[u.tile];
        if (u.next >= 0) { const p = u.prog / 100; tx += (this.cx[u.next] - tx) * p; ty += (this.cy[u.next] - ty) * p; }
        if (arr.length > 1) { const a = (idx / arr.length) * Math.PI * 2, rr = Math.min(7, 3 + arr.length); tx += Math.cos(a) * rr; ty += Math.sin(a) * rr; }
        s.dx += (tx - s.dx) * k1; s.dy += (ty - s.dy) * k1;
        s.position.set(s.dx, s.dy);
        const sel = S.selUnits.has(u.id);
        const key = [u.hp, u.sup, u.flags, sel, u.owner].join('|');
        if (key !== s.key) {
          s.key = key;
          const g = s.body; g.clear();
          const col = S.civColor(u.owner);
          const civil = S.defs.UNITS[u.type].civilian;
          if (u.flags & 2) g.ellipse(0, 0, 10, 6).fill({ color: 0x5b4127 }).stroke({ width: 1.5, color: col });
          if (civil) g.roundRect(-6.5, -6.5, 13, 13, 3).fill({ color: col }).stroke({ width: 1.2, color: 0x0b1518 });
          else g.circle(0, 0, 7).fill({ color: col }).stroke({ width: 1.2, color: 0x0b1518 });
          if (sel) g.circle(0, 0, 10).stroke({ width: 1.6, color: 0xf1c75b });
          if (u.hp < 100) g.rect(-7, 8.5, 14, 2.2).fill({ color: 0x220d09 }).rect(-7, 8.5, (14 * u.hp) / 100, 2.2).fill({ color: u.hp > 40 ? 0x7ccf73 : 0xe0533b });
          if (u.owner === S.civId && u.flags & 4) g.circle(6, -6, 2.6).fill({ color: 0xe0533b }).stroke({ width: 0.8, color: 0x0b1518 });
          if (u.flags & 1) g.circle(-6, -6, 2.2).fill({ color: 0xffe08a });
        }
      });
    }
    for (const [id, s] of this.unitSprites) if (!seen.has(id)) { s.destroy({ children: true }); this.unitSprites.delete(id); }
    // overlays: placement, paths, pending roads, hover
    const g = this.overlay; g.clear();
    if (S.mode && S.mode.kind === 'build' && S.mode.tiles) {
      for (const i of S.mode.tiles) g.poly(this.hexPoints(i, -1.5)).stroke({ width: 1.3, color: 0x8fe0a8, alpha: 0.85 });
    }
    for (const id of S.selUnits) {
      const p = S.paths[id]; const u = S.units.get(id); if (!p || !u) continue;
      const s = this.unitSprites.get(id); if (!s) continue;
      g.moveTo(s.dx, s.dy); for (const t of p) g.lineTo(this.cx[t], this.cy[t]);
      g.stroke({ width: 1.4, color: 0xf1c75b, alpha: 0.6 });
      const last = p[p.length - 1]; g.circle(this.cx[last], this.cy[last], 3).fill({ color: 0xf1c75b, alpha: 0.8 });
    }
    for (const road of S.econ?.roads || []) { if (!road.length) continue; g.moveTo(this.cx[road[0]], this.cy[road[0]]); for (const t of road) g.lineTo(this.cx[t], this.cy[t]); g.stroke({ width: 2, color: 0xc99a2e, alpha: 0.45 }); }
    if (S.hover >= 0 && S.terr[S.hover] !== 255) g.poly(this.hexPoints(S.hover, -0.5)).stroke({ width: 1.2, color: 0xffffff, alpha: 0.45 });
    if (S.mode && S.mode.kind === 'road' && S.mode.from >= 0) g.circle(this.cx[S.mode.from], this.cy[S.mode.from], 6).stroke({ width: 2, color: 0xc99a2e });
    for (const id of [...this.buildingSprites.keys()]) { const b = S.buildings.get(id); if (b && b.r >= 0 && S.selBuilding === id) { g.moveTo(this.cx[b.t], this.cy[b.t]).lineTo(this.cx[b.r], this.cy[b.r]).stroke({ width: 1, color: 0x8fe0a8, alpha: 0.6 }); g.circle(this.cx[b.r], this.cy[b.r], 4).stroke({ width: 1.5, color: 0x8fe0a8 }); } }
    // fx
    const f = this.fxG; f.clear();
    this.fx = this.fx.filter((e) => (e.t -= dt) > 0);
    for (const e of this.fx) {
      const a = e.t / e.max;
      if (e.kind === 'shot') f.moveTo(this.cx[e.a], this.cy[e.a]).lineTo(this.cx[e.b], this.cy[e.b]).stroke({ width: 1.2, color: 0xffe9a8, alpha: a });
      else if (e.kind === 'melee') f.circle(this.cx[e.b], this.cy[e.b], 4 + 5 * (1 - a)).stroke({ width: 1.4, color: 0xffd0a0, alpha: a });
      else if (e.kind === 'die') f.circle(this.cx[e.a], this.cy[e.a], 3 + 9 * (1 - a)).fill({ color: 0xd0533b, alpha: a * 0.6 });
      else if (e.kind === 'boom') f.circle(this.cx[e.a], this.cy[e.a], 6 + 16 * (1 - a)).fill({ color: 0xf08a3c, alpha: a * 0.6 });
    }
    this.pings = this.pings.filter((p) => (p.t -= dt) > 0);
    for (const p of this.pings) { const a = p.t / p.max; f.circle(this.cx[p.tile], this.cy[p.tile], R * (p.radius || 2) * (1.4 - a * 0.4)).stroke({ width: 3, color: p.color, alpha: a }); }
  }

  addFx(list) { for (const [kind, a, b] of list) this.fx.push({ kind, a, b, t: kind === 'shot' ? 0.25 : 0.45, max: kind === 'shot' ? 0.25 : 0.45 }); }
  ping(tile, radius, color) { this.pings.push({ tile, radius, color, t: 2.4, max: 2.4 }); }
}

function hexA(c, a) { return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`; }
