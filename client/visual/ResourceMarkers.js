// Resource deposits as crisp, zoom-aware markers in their own layer (not letters painted into the
// terrain texture, which blurred as the map scaled). Each kind has its own shape and colour as well
// as its short name, so deposits are told apart at a glance and not by colour alone:
//   iron: rust diamond · coal: black square · oil: dark drop · rare earths: violet star ·
//   stone: pale hexagon · fishing grounds: blue fish · old-world ruins: amber arch.
// Markers keep a constant size on screen (about 14 px) and are shown at city and close zoom; zoomed
// out they would only clutter the map (the deposit finder still highlights them there).
/* global PIXI */
import { atLeast } from './VisualLOD.js';

const KIND = {
  1: { fill: 0x2a2622, edge: 0xe9d36b, text: 0xe9d36b, shape: 'drop' },
  2: { fill: 0x8a4a32, edge: 0xf0c4a8, text: 0xffffff, shape: 'diamond' },
  3: { fill: 0x1d1d1d, edge: 0xb8b8b8, text: 0xf0f0f0, shape: 'square' },
  4: { fill: 0x6a3a9a, edge: 0xe2c4ff, text: 0xffffff, shape: 'star' },
  5: { fill: 0xd8d0bc, edge: 0x6a6252, text: 0x2a2620, shape: 'hex' },
  6: { fill: 0x2f6f9f, edge: 0xcfeaff, text: 0xffffff, shape: 'fish' },
  7: { fill: 0x7a5a2a, edge: 0xf0d090, text: 0xfff4dc, shape: 'arch' },
};
const SIZE = 14;   // screen pixels

function shape(g, k) {
  const r = 6.2;
  g.clear();
  switch (k.shape) {
    case 'diamond': g.poly([0, -r * 1.1, r * 1.05, 0, 0, r * 1.1, -r * 1.05, 0]); break;
    case 'square': g.roundRect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8, 1.4); break;
    case 'drop': g.moveTo(0, -r * 1.2).bezierCurveTo(r * 0.9, -r * 0.1, r * 0.95, r * 0.9, 0, r * 0.95).bezierCurveTo(-r * 0.95, r * 0.9, -r * 0.9, -r * 0.1, 0, -r * 1.2).closePath(); break;
    case 'star': { const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.55 : r * 1.15; p.push(Math.cos(a) * rr, Math.sin(a) * rr); } g.poly(p); break; }
    case 'hex': { const p = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; p.push(Math.cos(a) * r, Math.sin(a) * r); } g.poly(p); break; }
    case 'fish': g.ellipse(-0.8, 0, r * 0.9, r * 0.6).poly([r * 0.2, 0, r * 1.15, -r * 0.6, r * 1.15, r * 0.6]); break;
    case 'arch': g.roundRect(-r, -r * 0.7, r * 2, r * 1.5, 1.6); break;
    default: g.circle(0, 0, r);
  }
  g.fill({ color: k.fill, alpha: 0.95 }).stroke({ width: 1.2, color: k.edge, alpha: 0.95 });
}

export class ResourceMarkers {
  constructor(view, S, layer) { this.v = view; this.S = S; this.layer = layer; this.items = new Map(); this.scanAt = -1; }

  tex(r) {
    this.texs = this.texs || new Map();
    if (this.texs.has(r)) return this.texs.get(r);
    const k = KIND[r], c = new PIXI.Container(), g = new PIXI.Graphics(); shape(g, k);
    const txt = new PIXI.Text({ text: this.S.defs.RESOURCE[r].glyph, style: { fontFamily: 'Barlow Semi Condensed, sans-serif', fontSize: 9, fontWeight: '700', fill: k.text } });
    txt.anchor.set(0.5, 0.52); txt.resolution = 4; c.addChild(g, txt);
    const t = this.v.app.renderer.generateTexture({ target: c, resolution: 6, antialias: true });
    c.destroy({ children: true });
    this.texs.set(r, t); return t;
  }
  // the deposits we know about change only when explored tiles arrive: rescan at most twice a second
  sync(t) {
    if (t - this.scanAt < 0.5 && this.scanned === this.S.tilesVersion) return;
    this.scanAt = t; this.scanned = this.S.tilesVersion;
    const S = this.S, seen = new Set();
    for (let i = 0; i < S.res.length; i++) {
      const r = S.res[i]; if (!r || S.terr[i] === 255 || !KIND[r]) continue;
      seen.add(i);
      const it = this.items.get(i);
      if (it && it.r === r) continue;
      if (it) it.c.destroy();
      // one sharp texture per kind (shape and letters rendered once at high resolution), shared by
      // every marker of that kind: hundreds of markers cost a single batched draw
      const c = new PIXI.Sprite(this.tex(r)); c.anchor.set(0.5); c.eventMode = 'none';
      this.layer.addChild(c);
      this.items.set(i, { c, r });
    }
    for (const [i, it] of this.items) if (!seen.has(i)) { it.c.destroy(); this.items.delete(i); }
  }

  frame(t) {
    const S = this.S, v = this.v;
    this.sync(t);
    const show = atLeast(S, 'city') || !!S.deposits;
    this.layer.visible = show && S.prefs?.resourceMarkers !== false;
    if (!this.layer.visible) return;
    const z = v.cam.z, s = (SIZE / 16) / z * Math.min(1.25, Math.max(0.85, z / 1.6));   // the texture is about 16 world units across
    for (const [i, it] of this.items) {
      const x = v.cx[i] + 5.5, y = v.cy[i] - 5.5;
      // a deposit that has been built on is marked by its building; at close zoom, keep the hex clear
      const on = v.inView(x, y, 20) && !(S.lod === 'micro' && S.buildingTiles.has(i));
      it.c.visible = on;
      if (on) { it.c.position.set(x, y); it.c.scale.set(s); }
    }
  }
}
