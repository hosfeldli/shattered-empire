// The sea as a subtle moving fluid: a GPU shader over the water hexes. Two layers of noise flow
// in different directions with the wind and warp each other, so the surface shows slowly shifting
// swells — soft lighter crests and darker troughs — broader over deep water, with a faint foam band
// that breathes along the shore. World-anchored and tiled exactly once round the wrapped world.
// Only water the player has seen; skipped without a GPU or with weather effects off.
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
uniform sampler2D uMask;
uniform vec4 uMapMask;
uniform float uTime;
uniform float uScale;
uniform float uPeriod;
uniform float uAlpha;
uniform vec2 uFlow;
uniform vec2 uOffA;
uniform vec2 uOffB;

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
  for (int k = 0; k < 4; k++) { s += a * vnoise(p, per); n += a; p = p * 2.0 + vec2(0.0, 7.3); per *= 2.0; a *= 0.5; }
  return s / n;
}
void main() {
  vec2 w = vWorld;
  float m = texture(uMask, vec2(fract(w.x * uMapMask.x), w.y * uMapMask.z + uMapMask.w)).r;
  if (m < 0.03) { finalColor = vec4(0.0); return; }
  vec2 p = w / uScale;
  float t = uTime;
  vec2 q = vec2(fbm(p + uOffA, uPeriod), fbm(p + vec2(3.1, 7.7) - uOffB, uPeriod));
  float n = fbm(p * 2.0 + 1.7 * q + vec2(t * 0.02, -t * 0.015), uPeriod * 2.0);
  float deep = smoothstep(0.55, 1.0, m);
  float crest = smoothstep(0.56 - 0.04 * deep, 0.74, n);
  float trough = smoothstep(0.44, 0.28, n);
  float shore = smoothstep(0.08, 0.3, m) * (1.0 - smoothstep(0.3, 0.6, m));
  float foam = shore * (0.55 + 0.45 * sin(t * 1.2 + n * 14.0)) * smoothstep(0.4, 0.6, n);
  float inner = smoothstep(0.03, 0.2, m);
  float ca = (crest * (0.07 + 0.03 * deep) + foam * 0.3) * uAlpha * inner;
  float ta = trough * (0.06 + 0.04 * deep) * uAlpha * inner;
  vec3 light = mix(vec3(0.80, 0.92, 1.0), vec3(1.0), foam);
  vec3 dark = vec3(0.02, 0.07, 0.14);
  finalColor = vec4(light * ca + dark * ta, ca + ta);
}`;

export class WaterShader {
  constructor(view, S, layer) { this.v = view; this.S = S; this.layer = layer; this.ok = true; this.key = -1; }
  build() {
    const v = this.v;
    const c = document.createElement('canvas'); c.width = v.W; c.height = v.H;
    this.ctx = c.getContext('2d', { willReadFrequently: true }); this.canvas = c;
    this.img = this.ctx.createImageData(v.W, v.H);
    this.tex = PIXI.Texture.from(c); this.tex.source.style.addressModeU = 'repeat'; this.tex.source.style.scaleMode = 'linear';
    const P = v.P, period = Math.max(4, Math.round(P / 110)), scale = P / period;
    const uniforms = {
      uRect: { value: new Float32Array(4), type: 'vec4<f32>' }, uMapMask: { value: new Float32Array(4), type: 'vec4<f32>' },
      uTime: { value: 0, type: 'f32' }, uScale: { value: scale, type: 'f32' }, uPeriod: { value: period, type: 'f32' }, uAlpha: { value: 1, type: 'f32' },
      uFlow: { value: new Float32Array(2), type: 'vec2<f32>' }, uOffA: { value: new Float32Array(2), type: 'vec2<f32>' }, uOffB: { value: new Float32Array(2), type: 'vec2<f32>' },
    };
    const geometry = new PIXI.Geometry({ attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] }, indexBuffer: [0, 1, 2, 0, 2, 3] });
    const shader = PIXI.Shader.from({ gl: { vertex: VERT, fragment: FRAG, name: 'water' }, resources: { water: uniforms, uMask: this.tex.source } });
    this.mesh = new PIXI.Mesh({ geometry, shader }); this.mesh.eventMode = 'none';
    this.layer.addChild(this.mesh);
  }
  // water the player knows: 255 deep, 150 shallow, 0 land or unknown (softened by linear filtering)
  upload() {
    const S = this.S, d = this.img.data, n = this.v.N;
    for (let i = 0; i < n; i++) { const t = S.terr[i]; d[i * 4] = t === 0 ? 255 : t === 1 ? 150 : 0; d[i * 4 + 3] = 255; }
    this.ctx.putImageData(this.img, 0, 0); this.tex.source.update();
  }
  frame(t) {
    const S = this.S, v = this.v;
    const on = this.ok && (S.prefs?.weather || 'full') !== 'off' && !S.softwareGpu;
    if (!on) { if (this.mesh) this.mesh.visible = false; return; }
    try {
      if (!this.mesh) this.build();
      if (this.key !== S.tilesVersion) { this.key = S.tilesVersion; this.upload(); }
    } catch (e) { console.warn('water shader disabled:', e); this.ok = false; return; }
    const [x0, y0, x1, y1] = v.vr;
    const m = this.mesh, u = m.shader.resources.water.uniforms;
    m.visible = true;
    const rx = x0 - 30, ry = y0 - 30, rw = x1 - x0 + 60, rh = y1 - y0 + 60;
    m.position.set(rx, ry); m.scale.set(rw, rh);
    u.uRect[0] = rx; u.uRect[1] = ry; u.uRect[2] = rw; u.uRect[3] = rh;
    u.uMapMask[0] = 1 / (R * SQ3 * v.W); u.uMapMask[1] = 0; u.uMapMask[2] = 1 / (R * 1.5 * v.H); u.uMapMask[3] = (-R / (R * 1.5) + 0.5) / v.H;
    const wind = S.wind || [5, -1], ws = Math.hypot(wind[0], wind[1]) || 1;
    u.uFlow[0] = wind[0] / ws; u.uFlow[1] = wind[1] / ws;
    // the swell drifts by the integrated flow (a change of wind turns it gently, never jumps it)
    const dt = Math.min(0.1, Math.max(0, t - (this.lastT ?? t))); this.lastT = t;
    const fl = this.fl || (this.fl = [u.uFlow[0], u.uFlow[1]]); fl[0] += (u.uFlow[0] - fl[0]) * dt * 0.3; fl[1] += (u.uFlow[1] - fl[1]) * dt * 0.3;
    const a = this.offA || (this.offA = [0, 0]), b = this.offB || (this.offB = [0, 0]);
    a[0] += fl[0] * 0.05 * dt; a[1] += fl[1] * 0.05 * dt; b[0] += fl[1] * 0.04 * dt; b[1] += -fl[0] * 0.04 * dt;
    u.uOffA[0] = a[0]; u.uOffA[1] = a[1]; u.uOffB[0] = b[0]; u.uOffB[1] = b[1];
    u.uTime = t; u.uAlpha = S.lod === 'strategic' ? 0.7 : 1;
  }
}
