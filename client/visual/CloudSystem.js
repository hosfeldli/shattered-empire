// Clouds are the weather you see. A GPU shader draws them as a continuous, fluid-looking sky:
// domain-warped noise that keeps churning, carried downwind, twisted into spiral bands around the
// server's cyclones, with its cover taken from the regional weather grid (thin wisps where the air
// is dry, banks of cumulus where it is humid, dark heavy cloud where it rains or storms). The same
// field is drawn twice: once as soft shadows on the ground (offset by the sun) and once overhead,
// thinning as you zoom in so it never hides the battle. Clouds never show over unexplored land.
// The noise tiles exactly once around the wrapped world, so there is no seam.
/* global PIXI */
import { R, SQ3 } from '../view.js';

const VERT = `
in vec2 aPosition;
out vec2 vWorld;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uRect;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vWorld = uRect.xy + aPosition * uRect.zw;
}`;

const FRAG = `
precision highp float;
in vec2 vWorld;
out vec4 finalColor;
uniform sampler2D uWx;
uniform sampler2D uWxPrev;
uniform sampler2D uMask;
uniform float uTime;
uniform float uBlend;
uniform float uAlpha;
uniform float uShadow;
uniform float uDetail;
uniform float uScale;
uniform float uPeriod;
uniform float uWorldP;
uniform vec2 uOffset;
uniform vec4 uMapWx;
uniform vec4 uMapMask;
uniform vec4 uCy0;
uniform vec4 uCy1;
uniform vec4 uCy2;
uniform vec4 uCy3;

float hash(vec2 i, float per) {
  i.x = mod(i.x, per);
  vec3 p3 = fract(vec3(i.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i, per), hash(i + vec2(1.0, 0.0), per), u.x), mix(hash(i + vec2(0.0, 1.0), per), hash(i + vec2(1.0, 1.0), per), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0, n = 0.0, per = uPeriod;
  for (int k = 0; k < 5; k++) {
    if (float(k) >= uDetail) break;
    s += a * vnoise(p, per); n += a;
    p = p * 2.0 + vec2(0.0, 13.7); per *= 2.0; a *= 0.5;
  }
  return s / n;
}
vec2 swirl(vec2 p, vec4 cy) {
  if (cy.z <= 0.0) return p;
  vec2 d = p - cy.xy; d.x -= uWorldP * floor(d.x / uWorldP + 0.5);
  float k = length(d) / cy.z;
  float a = cy.w * 3.2 * exp(-k * k * 0.45);
  float c = cos(a), s = sin(a);
  return cy.xy + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}
void main() {
  vec2 w = vWorld;
  vec2 uv = vec2(fract(w.x * uMapWx.x + uMapWx.y), clamp(w.y * uMapWx.z + uMapWx.w, 0.0, 1.0));
  vec4 wx = mix(texture(uWxPrev, uv), texture(uWx, uv), uBlend);
  float mask = texture(uMask, vec2(fract(w.x * uMapMask.x), w.y * uMapMask.z + uMapMask.w)).r;
  float cover = clamp(wx.r * 1.05 + wx.g * 0.45, 0.0, 1.0);
  if (cover < 0.03 || mask < 0.01) { finalColor = vec4(0.0); return; }
  vec2 sp = swirl(swirl(swirl(swirl(w, uCy0), uCy1), uCy2), uCy3);
  vec2 p = sp / uScale - uOffset;
  float t = uTime * 0.025;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - vec2(t, 0.0)));
  float n, lit = 0.0;
  if (uShadow > 0.5) n = fbm(p + 1.9 * q);
  else {
    vec2 r = vec2(fbm(p + 2.2 * q + vec2(1.7, 9.2) + 0.6 * t), fbm(p + 2.2 * q + vec2(8.3, 2.8) - 0.5 * t));
    n = fbm(p + 1.7 * r);
    // sunlit from the upper left: denser toward the sun means this side is in the cloud's own shade
    lit = clamp((n - fbm(p + 1.7 * r - vec2(0.05, 0.06))) * 9.0 + 0.5, 0.0, 1.0);
  }
  float thr = 0.8 - cover * 0.6;
  float dens = smoothstep(thr, thr + 0.26, n) * smoothstep(0.03, 0.14, cover) * mask;
  if (dens < 0.004) { finalColor = vec4(0.0); return; }
  float heavy = clamp(wx.g * 1.3 + wx.b * 0.7, 0.0, 1.0);
  if (uShadow > 0.5) {
    float a = dens * uAlpha * (0.75 + heavy * 0.5);
    finalColor = vec4(vec3(0.03, 0.05, 0.08) * a, a);
    return;
  }
  float thick = smoothstep(0.0, 0.45, n - thr);
  // edges facing the sun brighten; the far side and thick cores grey; rain and storm cloud darkens
  vec3 col = mix(vec3(0.985, 0.99, 1.0), vec3(0.70, 0.74, 0.81), thick * 0.5 + (1.0 - lit) * 0.25);
  col = mix(col, vec3(0.32, 0.35, 0.42), heavy * (0.45 + 0.55 * thick));
  col += vec3(1.0, 0.97, 0.9) * (lit - 0.5) * 0.14 * (1.0 - heavy * 0.6);
  float a = dens * uAlpha * (0.65 + 0.35 * thick);
  finalColor = vec4(clamp(col, 0.0, 1.0) * a, a);
}`;

const canvasTex = (w, h) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  const tex = PIXI.Texture.from(c);
  tex.source.style.addressModeU = 'repeat'; tex.source.style.scaleMode = 'linear';
  return { c, ctx, tex };
};

export class CloudSystem {
  constructor(view, S, field, shadowLayer, skyLayer) {
    this.v = view; this.S = S; this.f = field;
    this.shadowLayer = shadowLayer; this.skyLayer = skyLayer;
    this.wxVer = -1; this.maskT = 99; this.ok = true;
  }
  build() {
    const f = this.f.cur, v = this.v;
    this.cur = canvasTex(f.cw, f.ch); this.prev = canvasTex(f.cw, f.ch); this.mask = canvasTex(v.W, v.H);
    this.maskImg = this.mask.ctx.createImageData(v.W, v.H);
    const geometry = new PIXI.Geometry({ attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] }, indexBuffer: [0, 1, 2, 0, 2, 3] });
    // noise cells around the world: an integer, so the pattern meets itself at the wrap seam
    const P = v.P, period = Math.max(4, Math.round(P / 300)), scale = P / period;
    const mk = (shadow) => {
      const uniforms = {
        uRect: { value: new Float32Array(4), type: 'vec4<f32>' },
        uTime: { value: 0, type: 'f32' }, uBlend: { value: 1, type: 'f32' }, uAlpha: { value: 0.5, type: 'f32' },
        uShadow: { value: shadow ? 1 : 0, type: 'f32' }, uDetail: { value: 5, type: 'f32' },
        uScale: { value: scale, type: 'f32' }, uPeriod: { value: period, type: 'f32' }, uWorldP: { value: P, type: 'f32' },
        uOffset: { value: new Float32Array(2), type: 'vec2<f32>' },
        uMapWx: { value: new Float32Array(4), type: 'vec4<f32>' }, uMapMask: { value: new Float32Array(4), type: 'vec4<f32>' },
        uCy0: { value: new Float32Array(4), type: 'vec4<f32>' }, uCy1: { value: new Float32Array(4), type: 'vec4<f32>' },
        uCy2: { value: new Float32Array(4), type: 'vec4<f32>' }, uCy3: { value: new Float32Array(4), type: 'vec4<f32>' },
      };
      const shader = PIXI.Shader.from({ gl: { vertex: VERT, fragment: FRAG, name: 'clouds' }, resources: { cloud: uniforms, uWx: this.cur.tex.source, uWxPrev: this.prev.tex.source, uMask: this.mask.tex.source } });
      const m = new PIXI.Mesh({ geometry, shader }); m.eventMode = 'none';
      return m;
    };
    this.shadow = mk(true); this.sky = mk(false);
    this.shadowLayer.addChild(this.shadow); this.skyLayer.addChild(this.sky);
  }
  // the newest weather into the textures (the previous one kept for a smooth 5-second blend)
  upload() {
    const f = this.f;
    const put = (dst, c) => {
      const img = dst.ctx.createImageData(c.cw, c.ch), d = img.data;
      for (let i = 0; i < c.cw * c.ch; i++) { d[i * 4] = c.cloud[i]; d[i * 4 + 1] = c.storm[i]; d[i * 4 + 2] = c.rain[i]; d[i * 4 + 3] = 255; }
      dst.ctx.putImageData(img, 0, 0); dst.tex.source.update();
    };
    // previous = what was on screen when this reading arrived (the field blends from it)
    put(this.prev, f.prev || f.cur); put(this.cur, f.cur);
  }
  // explored land (so the sky never gives away what lies under unexplored ground)
  uploadMask() {
    const S = this.S, d = this.maskImg.data, n = this.v.N;
    for (let i = 0; i < n; i++) { const k = S.terr[i] === 255 ? 0 : 255; d[i * 4] = k; d[i * 4 + 3] = 255; }
    this.mask.ctx.putImageData(this.maskImg, 0, 0); this.mask.tex.source.update();
  }
  frame(t, dt = 0.016) {
    const S = this.S, v = this.v, f = this.f;
    const mode = S.prefs?.weather || 'full';
    const on = this.ok && f.ready && mode !== 'off' && !S.softwareGpu;
    if (!on) { if (this.sky) { this.sky.visible = false; this.shadow.visible = false; } return; }
    try {
      if (!this.sky) this.build();
      if (f.cur.v !== this.wxVer) { this.upload(); this.wxVer = f.cur.v; }
      this.maskT += dt; if (this.maskT > 1.5) { this.maskT = 0; this.uploadMask(); }
    } catch (e) { console.warn('clouds disabled:', e); this.ok = false; return; }
    const [x0, y0, x1, y1] = v.vr, z = v.cam.z, strategic = S.lod === 'strategic';
    const c = f.cur, cell = c.cell, cw = c.cw, ch = c.ch, Rq = R * SQ3;
    // overhead cloud thins as you zoom in; shadows stay
    const skyA = (strategic ? 0.8 : Math.max(0.26, 0.78 - (z - 0.6) * 0.34)) * (mode === 'reduced' ? 0.6 : 1);
    const shA = 0.3 * (mode === 'reduced' ? 0.7 : 1);
    // the sky drifts by the wind integrated over time (never wind × elapsed time, which jumps the
    // whole sky whenever the wind changes); the wind itself eases toward each new reading
    const wind = S.wind || [5, -1], sw = this.wind || (this.wind = [...wind]), ke = Math.min(1, dt * 0.4);
    sw[0] += (wind[0] - sw[0]) * ke; sw[1] += (wind[1] - sw[1]) * ke;
    const off = this.off || (this.off = [0, 0]); off[0] += sw[0] * 0.0009 * dt; off[1] += sw[1] * 0.0009 * dt;
    const cx = (x0 + x1) / 2, P = v.P;
    const cys = f.cyclones(), sc = cell * Rq;
    for (const [m, alpha, ox, oy] of [[this.sky, skyA, 0, 0], [this.shadow, shA, 34, 46]]) {
      m.visible = true;
      const u = m.shader.resources.cloud.uniforms;
      // the shadow is drawn where the cloud's shadow falls, i.e. sampled up-left of the ground point
      const rx = x0 - 60, ry = y0 - 60, rw = x1 - x0 + 120, rh = y1 - y0 + 120;
      m.position.set(rx, ry); m.scale.set(rw, rh);
      u.uRect[0] = rx - ox; u.uRect[1] = ry - oy; u.uRect[2] = rw; u.uRect[3] = rh;
      u.uTime = t; u.uBlend = f.blend(); u.uAlpha = alpha; u.uDetail = mode === 'reduced' ? 3 : m === this.shadow ? 4 : 5;
      u.uOffset[0] = off[0]; u.uOffset[1] = off[1];
      u.uMapWx[0] = 1 / (Rq * cell * cw); u.uMapWx[1] = -0.5 / (cell * cw); u.uMapWx[2] = 1 / (R * 1.5 * cell * ch); u.uMapWx[3] = -R / (R * 1.5 * cell * ch);
      u.uMapMask[0] = 1 / (Rq * v.W); u.uMapMask[1] = 0; u.uMapMask[2] = 1 / (R * 1.5 * v.H); u.uMapMask[3] = (-R / (R * 1.5) + 0.5) / v.H;
      ['uCy0', 'uCy1', 'uCy2', 'uCy3'].forEach((k, i) => {
        const a = u[k], cy = cys[i];
        if (!cy) { a[2] = 0; return; }
        let wxp = (cy.x + 0.5) * sc + R * SQ3 / 2; wxp += P * Math.round((cx - wxp) / P);
        a[0] = wxp; a[1] = (cy.y + 0.5) * cell * R * 1.5 + R; a[2] = cy.r * sc; a[3] = cy.s * cy.spin;
      });
    }
  }
}
