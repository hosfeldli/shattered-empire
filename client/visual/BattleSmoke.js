// Battle smoke as a drifting fluid, drawn the way the clouds are: a smoke density per hex, fed by
// fighting (each battle keeps its ground hazy), shell bursts, burning wrecks and smoke screens, and
// thinning away over half a minute; a GPU shader turns that coarse field into rolling, curling
// smoke (domain-warped noise carried downwind and slowly rising), grey-brown and lit from the sun,
// dark and dense at its heart. It replaces the old scattered puffs. Only over what we can see.
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
uniform sampler2D uDens;
uniform vec4 uMapMask;
uniform float uTime;
uniform float uScale;
uniform float uPeriod;
uniform float uAlpha;
uniform vec2 uOffset;

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
float fbm(vec2 p, float per) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p, per); n += a; p = p * 2.0 + vec2(0.0, 11.1); per *= 2.0; a *= 0.5; }
  return s / n;
}
void main() {
  vec2 w = vWorld;
  float d = texture(uDens, vec2(fract(w.x * uMapMask.x), w.y * uMapMask.z + uMapMask.w)).r;
  if (d < 0.02) { finalColor = vec4(0.0); return; }
  vec2 p = w / uScale - uOffset;
  float t = uTime * 0.06;
  vec2 q = vec2(fbm(p + vec2(0.0, t), uPeriod), fbm(p + vec2(4.3, 1.7) - vec2(t, 0.0), uPeriod));
  vec2 r = vec2(fbm(p + 2.4 * q + vec2(1.3, 8.1) + t, uPeriod), fbm(p + 2.4 * q + vec2(6.2, 2.4) - t, uPeriod));
  float n = fbm(p + 2.0 * r, uPeriod);
  float dens = smoothstep(0.1, 0.75, d * (0.45 + 1.1 * n));
  if (dens < 0.01) { finalColor = vec4(0.0); return; }
  float lit = clamp((n - fbm(p + 2.0 * r - vec2(0.06, 0.08), uPeriod)) * 8.0 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.66, 0.63, 0.57), vec3(0.24, 0.22, 0.2), smoothstep(0.35, 1.0, dens));
  col += vec3(0.12, 0.11, 0.09) * (lit - 0.5);
  float a = dens * uAlpha * 0.82;
  finalColor = vec4(clamp(col, 0.0, 1.0) * a, a);
}`;

export class BattleSmoke {
  constructor(view, S, layer) { this.v = view; this.S = S; this.layer = layer; this.ok = true; this.d = null; this.upT = 0; this.off = [0, 0]; }
  // smoke put into the air at a world point (amount ~0.1 a rifle volley, ~0.6 a heavy shell)
  add(x, y, amount) {
    if (!this.d) return;
    const t = this.v.tileAt(x, y); if (t < 0) return;
    this.d[t] = Math.min(1.6, this.d[t] + amount);
  }
  build() {
    const v = this.v;
    this.d = new Float32Array(v.N);
    const c = document.createElement('canvas'); c.width = v.W; c.height = v.H;
    this.ctx = c.getContext('2d', { willReadFrequently: true }); this.img = this.ctx.createImageData(v.W, v.H);
    this.tex = PIXI.Texture.from(c); this.tex.source.style.addressModeU = 'repeat'; this.tex.source.style.scaleMode = 'linear';
    const P = v.P, period = Math.max(4, Math.round(P / 55)), scale = P / period;
    const uniforms = {
      uRect: { value: new Float32Array(4), type: 'vec4<f32>' }, uMapMask: { value: new Float32Array(4), type: 'vec4<f32>' },
      uTime: { value: 0, type: 'f32' }, uScale: { value: scale, type: 'f32' }, uPeriod: { value: period, type: 'f32' }, uAlpha: { value: 1, type: 'f32' },
      uOffset: { value: new Float32Array(2), type: 'vec2<f32>' },
    };
    const geometry = new PIXI.Geometry({ attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] }, indexBuffer: [0, 1, 2, 0, 2, 3] });
    const shader = PIXI.Shader.from({ gl: { vertex: VERT, fragment: FRAG, name: 'battlesmoke' }, resources: { smoke: uniforms, uDens: this.tex.source } });
    this.mesh = new PIXI.Mesh({ geometry, shader }); this.mesh.eventMode = 'none';
    this.layer.addChild(this.mesh);
  }
  frame(t, dt) {
    const S = this.S, v = this.v;
    if (!this.ok || S.softwareGpu) { if (this.mesh) this.mesh.visible = false; return; }
    try { if (!this.mesh) this.build(); } catch (e) { console.warn('battle smoke disabled:', e); this.ok = false; return; }
    const d = this.d;
    // sources: the battles we can see keep their ground hazy; smoke screens hold their density
    for (const b of S.battles || []) { if (S.vis && !S.vis[b.t]) continue; const k = Math.min(1, 0.3 + (b.n || 0) / 25) * dt * 0.25; d[b.t] = Math.min(1.4, d[b.t] + k); for (let i = 0; i < 6; i++) { const n = v.nb(b.t, i); if (n >= 0) d[n] = Math.min(1.2, d[n] + k * 0.4); } }
    for (const [tile, d10] of S.bf?.s || []) d[tile] = Math.max(d[tile], d10 / 10);
    this.upT += dt;
    if (this.upT > 0.2) {
      // thin out (about a minute to clear), never over ground we cannot see, then upload
      const k = Math.exp(-this.upT / 25), px = this.img.data;
      for (let i = 0; i < d.length; i++) {
        if (d[i] > 0.001) { d[i] *= k; if (S.vis && !S.vis[i]) d[i] *= 0.5; } else d[i] = 0;
        px[i * 4] = Math.min(255, d[i] * 200); px[i * 4 + 3] = 255;
      }
      this.ctx.putImageData(this.img, 0, 0); this.tex.source.update();
      this.upT = 0;
    }
    const [x0, y0, x1, y1] = v.vr, m = this.mesh, u = m.shader.resources.smoke.uniforms;
    m.visible = true;
    const rx = x0 - 30, ry = y0 - 30, rw = x1 - x0 + 60, rh = y1 - y0 + 60;
    m.position.set(rx, ry); m.scale.set(rw, rh);
    u.uRect[0] = rx; u.uRect[1] = ry; u.uRect[2] = rw; u.uRect[3] = rh;
    u.uMapMask[0] = 1 / (R * SQ3 * v.W); u.uMapMask[1] = 0; u.uMapMask[2] = 1 / (R * 1.5 * v.H); u.uMapMask[3] = (-R / (R * 1.5) + 0.5) / v.H;
    // drifts downwind and rises (integrated, so a wind change never jumps it)
    const wind = S.wind || [5, -1];
    this.off[0] += wind[0] * 0.004 * dt; this.off[1] += (wind[1] * 0.004 - 0.02) * dt;
    u.uOffset[0] = this.off[0]; u.uOffset[1] = this.off[1];
    u.uTime = t; u.uAlpha = S.lod === 'strategic' ? 0.8 : 1;
  }
}
