#!/usr/bin/env node
// Procedural sound design for the native client. Every sound here is synthesized from noise,
// oscillators and filters by this script (original work, released CC0 with the project), so no
// third-party recording or licence is involved. Ambience beds are seamless loops; weapon sounds are
// one-shots. Deterministic: a fixed seed per sound reproduces the same files.
//
//   node tools/synth-audio.mjs [outDir]      (default godot/assets/audio/synth)
//
// Writes 16-bit WAV to a temporary folder and encodes Ogg Vorbis with ffmpeg when available.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RATE = 32000;
const OUT = path.resolve(process.argv[2] || 'godot/assets/audio/synth');

// ------------------------------------------------------------------ primitives
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const buf = (seconds) => new Float32Array(Math.round(seconds * RATE));
function white(n, r) { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = r() * 2 - 1; return o; }
function pink(n, r) { // Paul Kellet's refined pink filter
  const o = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) { const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926; }
  return o;
}
function brown(n, r) { const o = new Float32Array(n); let v = 0; for (let i = 0; i < n; i++) { v = (v + 0.02 * (r() * 2 - 1)) / 1.02; o[i] = v * 3.5; } return o; }
// RBJ biquad; f may be a number or a function of the sample index (time-varying filters)
function biquad(x, type, f, q = 0.707, gainDb = 0) {
  const o = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let b0, b1, b2, a1, a2, lastF = -1;
  const design = (fc) => {
    const w = 2 * Math.PI * Math.min(fc, RATE * 0.45) / RATE, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), A = Math.pow(10, gainDb / 40);
    let B0, B1, B2, A0, A1, A2;
    if (type === 'lp') { B0 = (1 - c) / 2; B1 = 1 - c; B2 = (1 - c) / 2; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; }
    else if (type === 'hp') { B0 = (1 + c) / 2; B1 = -(1 + c); B2 = (1 + c) / 2; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; }
    else if (type === 'bp') { B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; }
    else { B0 = 1 + al * A; B1 = -2 * c; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * c; A2 = 1 - al / A; } // peak
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  };
  for (let i = 0; i < x.length; i++) {
    const fc = typeof f === 'function' ? f(i) : f;
    if (fc !== lastF && (typeof f !== 'function' || (i & 31) === 0 || lastF < 0)) { design(fc); lastF = fc; }
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; o[i] = y;
  }
  return o;
}
function mix(into, src, at = 0, gain = 1) { for (let i = 0; i < src.length && at + i < into.length; i++) if (at + i >= 0) into[at + i] += src[i] * gain; return into; }
function env(x, fn) { for (let i = 0; i < x.length; i++) x[i] *= fn(i / RATE, i); return x; }
// smooth random control signal (cosine-interpolated values every `step` seconds), periodic over n
function lfo(n, step, r, lo = 0, hi = 1) {
  const k = Math.max(2, Math.round(n / (step * RATE))), pts = Array.from({ length: k }, () => lo + (hi - lo) * r()), o = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i / n * k, a = Math.floor(p), t = p - a, u = (1 - Math.cos(t * Math.PI)) / 2; o[i] = pts[a % k] * (1 - u) + pts[(a + 1) % k] * u; }
  return o;
}
// make a seamless loop: render len+xf seconds, crossfade the tail into the head
function loopify(x, xfSeconds) {
  const xf = Math.round(xfSeconds * RATE), n = x.length - xf, o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = x[i];
  for (let i = 0; i < xf; i++) { const t = i / xf, a = Math.sqrt(t), b = Math.sqrt(1 - t); o[i] = x[i] * a + x[n + i] * b; }
  return o;
}
function normalize(x, peak = 0.8) { let m = 1e-9; for (const v of x) m = Math.max(m, Math.abs(v)); const k = peak / m; for (let i = 0; i < x.length; i++) x[i] *= k; return x; }
function fade(x, inS = 0.002, outS = 0.05) { const a = Math.round(inS * RATE), b = Math.round(outS * RATE); for (let i = 0; i < a && i < x.length; i++) x[i] *= i / a; for (let i = 0; i < b && i < x.length; i++) x[x.length - 1 - i] *= i / b; return x; }
// small diffuse room/landscape tail (a few feedback comb filters + allpass)
function reverb(x, seconds = 1.2, wet = 0.25, damp = 0.4) {
  const o = new Float32Array(x.length + Math.round(seconds * RATE));
  for (let i = 0; i < x.length; i++) o[i] = x[i];
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => Math.round(d * RATE / 44100));
  const fb = Math.pow(0.001, (combs[0] / RATE) / seconds);
  const acc = new Float32Array(o.length);
  for (const d of combs) { const line = new Float32Array(d); let p = 0, lp = 0; for (let i = 0; i < o.length; i++) { const out = line[p]; lp = out * (1 - damp) + lp * damp; line[p] = (i < x.length ? x[i] : 0) + lp * fb; p = (p + 1) % d; acc[i] += out; } }
  for (let i = 0; i < o.length; i++) o[i] = o[i] * (1 - wet) + acc[i] * wet / combs.length;
  return o;
}

// ------------------------------------------------------------------ ambience beds (loops)
function wind() {
  const r = rng(11), n = buf(34).length, base = pink(n, r), gust = lfo(n, 3.2, r, 0.25, 1), tone = lfo(n, 5.1, r, 260, 900);
  let x = biquad(base, 'bp', (i) => tone[i], 0.6);
  x = mix(x, biquad(brown(n, r), 'lp', 180), 0, 0.8);
  for (let i = 0; i < n; i++) x[i] *= gust[i] * gust[i];
  // a faint whistle in strong gusts
  const whistle = biquad(white(n, r), 'bp', (i) => 1300 + 500 * tone[i] / 900, 18);
  for (let i = 0; i < n; i++) x[i] += whistle[i] * Math.max(0, gust[i] - 0.75) * 0.5;
  return normalize(loopify(x, 4), 0.7);
}
function rain() {
  const r = rng(23), n = buf(26).length;
  let x = biquad(biquad(pink(n, r), 'hp', 900), 'lp', 7000);
  for (let i = 0; i < n; i++) x[i] *= 0.35;
  const drops = Math.round(n / RATE * 140);
  for (let k = 0; k < drops; k++) {
    const len = Math.round(RATE * (0.004 + r() * 0.01)), at = Math.floor(r() * (n - len)), f = 2500 + r() * 4500, g = 0.15 + r() * 0.5;
    for (let i = 0; i < len; i++) x[at + i] += Math.sin(2 * Math.PI * f * i / RATE) * Math.exp(-i / (len * 0.25)) * g * (r() * 0.5 + 0.5);
  }
  x = mix(x, biquad(brown(n, r), 'lp', 220), 0, 0.6);
  return normalize(loopify(x, 3), 0.7);
}
function water() {
  // a river / shoreline bed: broadband rush, babbling resonances and slow swells
  const r = rng(37), n = buf(30).length;
  let x = biquad(pink(n, r), 'bp', 700, 0.5);
  const swell = lfo(n, 4.5, r, 0.45, 1);
  for (let i = 0; i < n; i++) x[i] *= swell[i];
  for (let k = 0; k < 5; k++) {
    const centre = 380 + r() * 900, wob = lfo(n, 0.35 + r() * 0.4, r, 0.7, 1.3), amp = lfo(n, 0.25 + r() * 0.3, r, 0, 1);
    const b = biquad(white(n, r), 'bp', (i) => centre * wob[i], 14);
    for (let i = 0; i < n; i++) x[i] += b[i] * Math.pow(amp[i], 3) * 1.4;
  }
  return normalize(loopify(x, 3), 0.65);
}
function city() {
  // distant town life: traffic rumble, engine drones passing, a faint bustle band
  const r = rng(41), n = buf(32).length;
  let x = biquad(brown(n, r), 'lp', 260);
  const bustle = biquad(pink(n, r), 'bp', 1100, 0.7), busy = lfo(n, 2.2, r, 0.2, 0.7);
  for (let i = 0; i < n; i++) x[i] = x[i] * 0.9 + bustle[i] * busy[i] * 0.25;
  for (let k = 0; k < 9; k++) { // vehicles passing: a filtered harmonic drone with a doppler sweep
    const dur = 3 + r() * 4, len = Math.round(dur * RATE), at = Math.floor(r() * (n - len)), f0 = 55 + r() * 60, rise = 0.92 + r() * 0.16;
    let ph = 0; const v = new Float32Array(len);
    for (let i = 0; i < len; i++) { const t = i / len, f = f0 * (t < 0.5 ? rise : 2 - rise); ph += 2 * Math.PI * f / RATE;
      v[i] = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph)) * Math.sin(Math.PI * t) ** 2; }
    mix(x, biquad(v, 'lp', 500), at, 0.25);
  }
  return normalize(loopify(x, 4), 0.6);
}
function industry() {
  // works: mains hum harmonics, a rhythmic press / conveyor clank and steam bursts
  const r = rng(53), n = buf(24).length, x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / RATE; x[i] = 0.25 * Math.sin(2 * Math.PI * 50 * t) + 0.18 * Math.sin(2 * Math.PI * 100 * t) + 0.08 * Math.sin(2 * Math.PI * 150 * t); }
  mix(x, biquad(pink(n, r), 'bp', 420, 0.8), 0, 0.45);
  const period = 1.6, clank = Math.round(period * RATE);
  for (let at = 0; at < n; at += clank) {
    const len = Math.round(0.25 * RATE), hit = white(len, r);
    env(hit, (t) => Math.exp(-t * 26));
    for (const f of [620, 1340, 2310]) mix(x, biquad(hit, 'bp', f * (0.97 + r() * 0.06), 30), at, 0.9);
    mix(x, biquad(hit, 'lp', 160), at + Math.round(0.4 * RATE), 1.2);
  }
  for (let k = 0; k < 4; k++) { const len = Math.round(RATE * (0.8 + r())), at = Math.floor(r() * (n - len)), s = biquad(white(len, r), 'hp', 2500); env(s, (t) => Math.min(1, t * 12) * Math.exp(-t * 2.5)); mix(x, s, at, 0.07); }
  return normalize(loopify(x, 2), 0.6);
}
function construction() {
  // a building site: irregular hammer blows on timber, a saw run, a small engine idling
  const r = rng(61), n = buf(22).length, x = biquad(brown(n, r), 'lp', 140);
  for (let i = 0; i < n; i++) x[i] *= 0.4;
  let t = 0.3;
  while (t < 21) {
    const len = Math.round(0.18 * RATE), hit = white(len, r); env(hit, (s) => Math.exp(-s * 45));
    const at = Math.round(t * RATE);
    mix(x, biquad(hit, 'bp', 480 + r() * 180, 6), at, 1.0);
    mix(x, biquad(hit, 'bp', 1900 + r() * 400, 9), at, 0.35);
    t += r() < 0.2 ? 1.2 + r() * 1.5 : 0.42 + r() * 0.12;
  }
  for (let k = 0; k < 2; k++) {
    const len = Math.round(RATE * (1.6 + r())), at = Math.floor(r() * (n - len)), saw = biquad(white(len, r), 'bp', 3200, 2), stroke = new Float32Array(len);
    for (let i = 0; i < len; i++) stroke[i] = saw[i] * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3.1 * i / RATE)) * Math.min(1, i / 2000, (len - i) / 2000);
    mix(x, stroke, at, 0.35);
  }
  return normalize(loopify(reverb(x, 0.6, 0.15).slice(0, n), 2), 0.6);
}
function battleDistant() {
  // the front heard from afar: low rolling artillery, muffled bursts of small-arms crackle
  const r = rng(71), n = buf(30).length, x = biquad(brown(n, r), 'lp', 90);
  for (let i = 0; i < n; i++) x[i] *= 0.5;
  for (let k = 0; k < 16; k++) {
    const len = Math.round(RATE * 2.4), at = Math.floor(r() * (n - len)), b = biquad(brown(len, r), 'lp', 70 + r() * 60);
    env(b, (t) => Math.min(1, t * 40) * Math.exp(-t * (1.6 + r())));
    mix(x, b, at, 2.5 + r() * 2);
  }
  for (let k = 0; k < 10; k++) {
    let at = Math.floor(r() * n * 0.95); const shots = 3 + Math.floor(r() * 9);
    for (let s = 0; s < shots; s++) { const len = Math.round(RATE * 0.06), c = white(len, r); env(c, (t) => Math.exp(-t * 90)); mix(x, biquad(c, 'bp', 900, 1.5), at, 0.35); at += Math.round(RATE * (0.07 + r() * 0.12)); }
  }
  return normalize(loopify(reverb(x, 2.2, 0.35, 0.6).slice(0, n), 3), 0.6);
}

// ------------------------------------------------------------------ one-shots
function crack(r, bright = 2600, body = 1.0) {
  const len = Math.round(RATE * 0.35), x = new Float32Array(len), n = white(len, r);
  for (let i = 0; i < len; i++) { const t = i / RATE; x[i] = n[i] * (Math.exp(-t * 160) * 1.0 + Math.exp(-t * 18) * 0.12 * body); }
  let y = biquad(x, 'hp', 300); y = mix(biquad(x, 'bp', bright, 0.9), y, 0, 0.6);
  return y;
}
function rifle() { const r = rng(101); return normalize(fade(reverb(crack(r), 0.9, 0.22, 0.5), 0.0005, 0.2), 0.85); }
function mg() {
  const r = rng(107), x = buf(0.9);
  for (let s = 0; s < 7; s++) mix(x, crack(r, 2100 + r() * 300, 0.8), Math.round(s * 0.085 * RATE), 0.9 - s * 0.04);
  return normalize(fade(reverb(x, 0.9, 0.2, 0.5), 0.0005, 0.25), 0.85);
}
function autocannon() {
  const r = rng(113), x = buf(1.0);
  for (let s = 0; s < 4; s++) { const c = crack(r, 1300, 2.0); const thump = env(biquad(brown(c.length, r), 'lp', 180), (t) => Math.exp(-t * 20)); mix(x, c, Math.round(s * 0.16 * RATE), 0.9); mix(x, thump, Math.round(s * 0.16 * RATE), 3); }
  return normalize(fade(reverb(x, 1.1, 0.25), 0.0005, 0.3), 0.85);
}
function boom(seed, low = 55, decay = 3.2, crackGain = 0.5, length = 2.4) {
  const r = rng(seed), len = Math.round(length * RATE), x = new Float32Array(len);
  let ph = 0;
  for (let i = 0; i < len; i++) { const t = i / RATE, f = low * (1 + 1.6 * Math.exp(-t * 14)); ph += 2 * Math.PI * f / RATE; x[i] = Math.sin(ph) * Math.exp(-t * decay) * 0.9; }
  const n = biquad(brown(len, r), 'lp', 420); env(n, (t) => Math.min(1, t * 300) * Math.exp(-t * decay * 0.8)); mix(x, n, 0, 3.2);
  const c = crack(r, 1500, 0.4); mix(x, c, 0, crackGain);
  return x;
}
function cannon() { return normalize(fade(reverb(boom(127, 62, 4.5, 0.7, 2.0), 1.6, 0.3), 0.0005, 0.5), 0.9); }
function mortar() { // hollow launch "thoomp"
  const r = rng(131), len = Math.round(0.9 * RATE), x = new Float32Array(len); let ph = 0;
  for (let i = 0; i < len; i++) { const t = i / RATE, f = 140 * Math.exp(-t * 6) + 70; ph += 2 * Math.PI * f / RATE; x[i] = Math.sin(ph) * Math.exp(-t * 9); }
  mix(x, env(biquad(white(len, r), 'bp', 500, 1.2), (t) => Math.exp(-t * 30)), 0, 0.5);
  return normalize(fade(reverb(x, 1.0, 0.25), 0.0005, 0.3), 0.85);
}
function artillery() { return normalize(fade(reverb(boom(137, 44, 2.6, 0.6, 3.0), 2.4, 0.38, 0.6), 0.0005, 0.8), 0.9); }
function rocket() { // ignition crack then a receding roar
  const r = rng(139), len = Math.round(1.6 * RATE), x = crack(r, 1800, 1.5), out = new Float32Array(len);
  mix(out, x, 0, 0.8);
  const roar = biquad(pink(len, r), 'bp', (i) => 1600 - 1100 * i / len, 1.2);
  env(roar, (t) => Math.min(1, t * 25) * Math.exp(-t * 1.9)); mix(out, roar, 0, 1.4);
  return normalize(fade(reverb(out, 1.2, 0.2), 0.0005, 0.4), 0.85);
}
function explosion(seed = 149, big = false) {
  const r = rng(seed), x = boom(seed, big ? 38 : 50, big ? 1.8 : 2.6, 0.9, big ? 3.6 : 2.6);
  // debris patter after the blast
  for (let k = 0; k < (big ? 40 : 18); k++) { const len = Math.round(RATE * 0.03), at = Math.round(RATE * (0.15 + r() * (big ? 1.6 : 0.9))), d = white(len, r); env(d, (t) => Math.exp(-t * 160)); mix(x, biquad(d, 'bp', 1200 + r() * 2500, 4), at, 0.25 * (1 - at / x.length)); }
  return normalize(fade(reverb(x, big ? 3.0 : 2.0, 0.35, 0.55), 0.0005, 1.0), 0.95);
}
function collapse() { // a structure giving way: rumble, crumbling, a final settling crash
  const r = rng(157), len = Math.round(3.4 * RATE), x = biquad(brown(len, r), 'lp', 260);
  env(x, (t) => Math.min(1, t * 6) * Math.exp(-t * 0.9));
  for (let k = 0; k < 70; k++) { const l = Math.round(RATE * 0.05), at = Math.round(RATE * r() * 2.8), d = white(l, r); env(d, (t) => Math.exp(-t * 90)); mix(x, biquad(d, 'bp', 300 + r() * 1800, 3), at, 0.4); }
  mix(x, boom(158, 48, 3.5, 0.3, 1.6), Math.round(RATE * 1.9), 0.7);
  return normalize(fade(reverb(x, 2.0, 0.3), 0.01, 0.8), 0.9);
}

// ------------------------------------------------------------------ weather, life and cues
function thunder() { // a close crack then a long rolling grumble
  const r = rng(167), len = Math.round(7 * RATE), x = new Float32Array(len);
  const c = crack(r, 1200, 3); mix(x, c, 0, 0.6);
  const roll = biquad(brown(len, r), 'lp', 140), swell = lfo(len, 0.45, r, 0.2, 1);
  env(roll, (t, i) => Math.min(1, t * 8) * Math.exp(-t * 0.55) * swell[i]); mix(x, roll, 0, 3.0);
  return normalize(fade(reverb(x, 3.5, 0.35, 0.6), 0.001, 1.5), 0.9);
}
function radio() { // field-radio acknowledgement: squelch click, short two-tone chirp, static tail
  const r = rng(173), len = Math.round(0.42 * RATE), x = new Float32Array(len);
  let ph = 0;
  for (let i = 0; i < len; i++) { const t = i / RATE, f = t < 0.09 ? 1250 : t < 0.17 ? 1650 : 0; ph += 2 * Math.PI * f / RATE; x[i] = f ? Math.sin(ph) * 0.35 * Math.min(1, (0.17 - t) * 200, t * 400) : 0; }
  const st = biquad(white(len, r), 'bp', 2500, 0.8); env(st, (t) => (t < 0.012 ? 1 : t > 0.17 ? Math.exp(-(t - 0.17) * 30) * 0.5 : 0.12)); mix(x, st, 0, 0.5);
  return normalize(fade(biquad(biquad(x, 'hp', 400), 'lp', 3400), 0.0005, 0.05), 0.6);
}
function build() { // a foundation stake driven home: dull thud and a wooden knock
  const r = rng(179), len = Math.round(0.6 * RATE), x = new Float32Array(len); let ph = 0;
  for (let i = 0; i < len; i++) { const t = i / RATE; ph += 2 * Math.PI * (90 * Math.exp(-t * 8) + 60) / RATE; x[i] = Math.sin(ph) * Math.exp(-t * 14); }
  const knock = white(len, r); env(knock, (t) => Math.exp(-t * 60)); mix(x, biquad(knock, 'bp', 700, 5), 0, 0.8);
  return normalize(fade(reverb(x, 0.5, 0.12), 0.0005, 0.1), 0.7);
}
function chime() { // a soft two-note mallet tone for completed works
  const len = Math.round(1.6 * RATE), x = new Float32Array(len);
  for (const [f, at] of [[659.3, 0], [987.8, 0.14]]) {
    for (let i = Math.round(at * RATE); i < len; i++) { const t = i / RATE - at; x[i] += (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 3.01 * t) * Math.exp(-t * 6)) * Math.exp(-t * 3.2) * Math.min(1, t * 300); }
  }
  return normalize(fade(reverb(x, 1.2, 0.2), 0.0005, 0.4), 0.5);
}
function engines() { // diesel and tracked vehicles nearby: firing-rate harmonics, track clatter, revs
  const r = rng(181), n = buf(24).length, x = new Float32Array(n), rev = lfo(n, 2.6, r, 0.85, 1.25);
  let ph = 0;
  for (let i = 0; i < n; i++) { const f = 32 * rev[i]; ph += 2 * Math.PI * f / RATE; let v = 0; for (let h = 1; h <= 7; h++) v += Math.sin(ph * h + h * 0.7) / h; x[i] = v * 0.35; }
  const bodyNoise = biquad(brown(n, r), 'lp', 300); mix(x, bodyNoise, 0, 0.8);
  for (let at = 0; at < n; at += Math.round(RATE * (0.07 + r() * 0.03))) { const len = Math.round(RATE * 0.02), c = white(len, r); env(c, (t) => Math.exp(-t * 200)); mix(x, biquad(c, 'bp', 1500 + r() * 800, 6), at, 0.18); }
  return normalize(loopify(biquad(x, 'lp', 2400), 2), 0.6);
}
function birdsong() { // woodland: sparse varied chirps and trills over a leaf rustle
  const r = rng(191), n = buf(28).length, x = biquad(pink(n, r), 'bp', 3000, 0.6);
  for (let i = 0; i < n; i++) x[i] *= 0.05;
  for (let k = 0; k < 46; k++) {
    const notes = 1 + Math.floor(r() * 6), base = 2600 + r() * 2800, at0 = Math.floor(r() * (n - RATE));
    let at = at0;
    for (let s = 0; s < notes; s++) {
      const len = Math.round(RATE * (0.04 + r() * 0.09)), sweep = (r() - 0.4) * 1800, f0 = base * (0.9 + r() * 0.2);
      let ph = 0; const note = new Float32Array(len);
      for (let i = 0; i < len; i++) { const t = i / len; ph += 2 * Math.PI * (f0 + sweep * t + 120 * Math.sin(t * 40)) / RATE; note[i] = Math.sin(ph) * Math.sin(Math.PI * t) ** 1.5; }
      mix(x, note, at, 0.25 + r() * 0.3); at += len + Math.round(RATE * (0.02 + r() * 0.06));
    }
  }
  return normalize(loopify(reverb(x, 1.0, 0.18, 0.3).slice(0, n), 2), 0.55);
}

function fanfare() { // a restrained swelling brass-like chord: new era, new or captured city
  const len = Math.round(3.2 * RATE), x = new Float32Array(len);
  const chord = [[196.0, 0], [246.9, 0.12], [293.7, 0.24], [392.0, 0.36]];
  for (const [f, at] of chord) {
    let ph = 0;
    for (let i = Math.round(at * RATE); i < len; i++) {
      const t = i / RATE - at, vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t);
      ph += 2 * Math.PI * f * vib / RATE;
      let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(ph * h) / (h * h * 0.8);
      x[i] += v * Math.min(1, t * 3) * Math.exp(-Math.max(0, t - 1.2) * 1.6) * 0.3;
    }
  }
  return normalize(fade(reverb(biquad(x, 'lp', 2600), 2.2, 0.3), 0.01, 0.8), 0.55);
}
function drum() { // a distant muffled drum roll for battle reports
  const r = rng(197), len = Math.round(2.2 * RATE), x = new Float32Array(len);
  for (let k = 0; k < 9; k++) { const at = Math.round(RATE * k * 0.11), l = Math.round(RATE * 0.5), d = brown(l, r); env(d, (t) => Math.exp(-t * (14 - k))); mix(x, biquad(d, 'lp', 160), at, 1 - k * 0.06); }
  return normalize(fade(reverb(x, 1.6, 0.3), 0.001, 0.6), 0.5);
}

function jet() { // a fast jet pass: rising then falling roar with a doppler sweep
  const r = rng(211), len = Math.round(4.5 * RATE), x = pink(len, r);
  const y = biquad(x, 'bp', (i) => { const t = i / len; return 700 + 1800 * Math.exp(-((t - 0.42) ** 2) / 0.02) - 400 * t; }, 0.8);
  env(y, (t) => Math.exp(-((t - 1.9) ** 2) / 0.9));
  mix(y, env(biquad(brown(len, r), 'lp', 160), (t) => Math.exp(-((t - 2.0) ** 2) / 1.2)), 0, 1.5);
  return normalize(fade(y, 0.05, 0.6), 0.8);
}
function rotor() { // helicopter: blade-slap pulse train over turbine whine
  const r = rng(223), n = buf(12).length, x = new Float32Array(n), rate = 5.6;
  for (let at = 0; at < n; at += Math.round(RATE / rate)) { const l = Math.round(RATE * 0.09), d = brown(l, r); env(d, (t) => Math.exp(-t * 45)); mix(x, biquad(d, 'lp', 260), at, 1.5); }
  let ph = 0; for (let i = 0; i < n; i++) { ph += 2 * Math.PI * 3100 / RATE; x[i] += Math.sin(ph) * 0.03; }
  mix(x, biquad(pink(n, r), 'bp', 900, 0.6), 0, 0.15);
  return normalize(loopify(x, 1), 0.6);
}

function siren() { // a distant civil-defence siren: two slow rising and falling wails
  const len = Math.round(9 * RATE), x = new Float32Array(len); let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / RATE, cycle = (t % 4.5) / 4.5, f = 300 + 420 * Math.sin(Math.PI * cycle) ** 0.7;
    ph += 2 * Math.PI * f / RATE;
    x[i] = (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph)) * Math.min(1, t * 2, (9 - t) * 1.5);
  }
  return normalize(fade(reverb(biquad(x, 'lp', 1800), 2.8, 0.45, 0.6), 0.2, 1.2), 0.6);
}

// ------------------------------------------------------------------ output
function writeWav(file, x) {
  const n = x.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}
const SOUNDS = {
  amb_wind: wind, amb_rain: rain, amb_water: water, amb_city: city, amb_industry: industry, amb_construction: construction, amb_battle: battleDistant,
  sfx_rifle: rifle, sfx_mg: mg, sfx_autocannon: autocannon, sfx_cannon: cannon, sfx_mortar: mortar, sfx_artillery: artillery, sfx_rocket: rocket,
  sfx_explosion: () => explosion(149, false), sfx_explosion_big: () => explosion(151, true), sfx_collapse: collapse,
  sfx_thunder: thunder, ui_radio: radio, ui_build: build, ui_chime: chime, ui_fanfare: fanfare, ui_drum: drum, sfx_jet: jet, amb_rotor: rotor, ui_siren: siren, amb_engines: engines, amb_birds: birdsong,
};
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-synth-'));
let ffmpeg = true; try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
for (const [name, fn] of Object.entries(SOUNDS)) {
  const x = fn(), wav = path.join(ffmpeg ? tmp : OUT, name + '.wav');
  writeWav(wav, x);
  if (ffmpeg) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libvorbis', '-q:a', name.startsWith('amb') ? '3' : '5', path.join(OUT, name + '.ogg')]);
  console.log(name, (x.length / RATE).toFixed(1) + 's');
}
fs.rmSync(tmp, { recursive: true, force: true });
