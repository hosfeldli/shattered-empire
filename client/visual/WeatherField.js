// The client's copy of the server's regional weather: decoded fields, smooth interpolation between
// the 5-second updates, sampling at any world point (wrapping east–west), and a soft "puff" texture
// shared by clouds, fog, wet ground and smoke-like effects.
/* global PIXI */
const FIELDS = ['cloud', 'rain', 'fog', 'wet', 'storm'];

export class WeatherField {
  constructor(view, S) { this.v = view; this.S = S; this.cur = null; this.prev = null; this.t0 = 0; }

  ingest(wx) {
    const dec = (b64) => { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
    const f = { v: (this.cur?.v || 0) + 1, cw: wx.cw, ch: wx.ch, cell: wx.cell, windA: wx.wind[0], windS: wx.wind[1], snow: dec(wx.snow),
      cy: (wx.cy || []).map(([id, x, y, r, s, spin]) => ({ id, x, y, r, s, spin })) };
    for (const k of FIELDS) f[k] = dec(wx[k]);
    this.prev = this.cur && this.cur.cw === f.cw ? this.cur : f;
    this.cur = f; this.t0 = performance.now();
    this.S.wind = [Math.cos(f.windA) * (2 + f.windS * 9), Math.sin(f.windA) * (2 + f.windS * 9) * 0.6];
  }
  get ready() { return !!this.cur; }
  // 0..1 of the way from the previous update to the current one (updates are 5 s apart)
  blend() { return Math.min(1, (performance.now() - this.t0) / 5000); }
  // world point -> fractional cell coordinates
  cellXY(wx, wy) {
    const v = this.v, R = 12, cell = this.cur.cell;
    const r = (wy - R) / (R * 1.5), q = (wx - R * Math.sqrt(3) / 2) / (R * Math.sqrt(3)) - 0.5 * (Math.round(r) & 1);
    return [q / cell - 0.5, r / cell - 0.5, v];
  }
  // a field's value (0..1) at a world point, interpolated in space and in time
  at(field, wx, wy) {
    const c = this.cur, p = this.prev; if (!c) return 0;
    let [x, y] = this.cellXY(wx, wy);
    const cw = c.cw, ch = c.ch;
    y = Math.max(0, Math.min(ch - 1.001, y)); x = ((x % cw) + cw) % cw;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, x1 = (x0 + 1) % cw, y1 = Math.min(ch - 1, y0 + 1);
    const S = (f) => ((f[y0 * cw + x0] * (1 - fx) + f[y0 * cw + x1] * fx) * (1 - fy) + (f[y1 * cw + x0] * (1 - fx) + f[y1 * cw + x1] * fx) * fy) / 255;
    const k = this.blend();
    return k >= 1 || p === c ? S(c[field]) : S(p[field]) * (1 - k) + S(c[field]) * k;
  }
  // weather systems (cell coordinates), moving smoothly between updates, strongest first
  cyclones() {
    const c = this.cur, p = this.prev; if (!c) return [];
    const k = this.blend(), cw = c.cw;
    return c.cy.map((a) => {
      const b = p && p !== c ? p.cy.find((o) => o.id === a.id) : null;
      if (!b) return { ...a, s: a.s * k };
      let dx = a.x - b.x; if (dx > cw / 2) dx -= cw; else if (dx < -cw / 2) dx += cw;
      return { ...a, x: b.x + dx * k, y: b.y + (a.y - b.y) * k, s: b.s + (a.s - b.s) * k };
    }).sort((x, y) => y.s - x.s);
  }
  snowAt(wx, wy) { const c = this.cur; if (!c) return false; let [x, y] = this.cellXY(wx, wy); x = ((Math.round(x) % c.cw) + c.cw) % c.cw; y = Math.max(0, Math.min(c.ch - 1, Math.round(y))); return c.snow[y * c.cw + x] === 1; }
}

let puffTex = null;
// a soft round puff (white, alpha falling off smoothly): tinted for clouds, shadows, fog and wet ground
export function puffTexture() {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  puffTex = PIXI.Texture.from(c);
  return puffTex;
}

// a pool of sprites drawn from the puff texture; call begin() each frame, take() per puff, end()
export class PuffPool {
  constructor(layer) { this.layer = layer; this.items = []; this.n = 0; }
  begin() { this.n = 0; }
  take(x, y, r, tint, alpha) {
    let s = this.items[this.n];
    if (!s) { s = new PIXI.Sprite(puffTexture()); s.anchor.set(0.5); s.eventMode = 'none'; this.layer.addChild(s); this.items.push(s); }
    this.n++;
    s.visible = true; s.position.set(x, y); s.scale.set(r / 64, (r / 64) * 0.78); s.tint = tint; s.alpha = alpha;
    return s;
  }
  end() { for (let i = this.n; i < this.items.length; i++) this.items[i].visible = false; }
}
