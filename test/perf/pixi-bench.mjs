#!/usr/bin/env node
// Fair PixiJS counterpart to Godot's --bench mode. By default this owns a clean port-8139 server
// for each scene, launches headed Chromium at 1024x768 CSS and render pixels by default, and runs
// the same idle, continuous-zoom and east-west seam-pan phases as Diagnostics.gd.
//
// Real measurements must stay headed and visible. --headless and --allow-software-gpu exist only
// for short harness checks on machines without a display; results from either are marked invalid.

import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const raw = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [key, ...rest] = a.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
if (raw.help) {
  console.log(`Usage: node test/perf/pixi-bench.mjs [options]

  --scenario=all|early|late   scenes to run (default all)
  --seconds=N                 total seconds; one third per phase (default 30)
  --out=PATH                  JSON output (default pixi-bench.json)
  --scale=1|2                 render scale (default 1; must match Godot meta.pixels)
  --url=URL                   external clean server; do not start port 8139
  --port=N                    owned-server port (default 8139)
  --headless                  harness check only; invalid benchmark
  --allow-software-gpu        harness check only; invalid benchmark
  --verbose                   show browser console and server logs`);
  process.exit(0);
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  console.error('Playwright is not installed. Run npm ci, then retry.');
  process.exit(1);
}

const scenario = String(raw.scenario || 'all');
if (!['all', 'early', 'late'].includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
const seconds = Number(raw.seconds || 30);
const resolution = String(raw.resolution || '1024x768');
if (!/^\d{3,4}x\d{3,4}$/.test(resolution)) throw new Error('Invalid --resolution');
const [width, height] = resolution.split('x').map(Number);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--seconds must be positive');
const outPath = path.resolve(ROOT, String(raw.out || 'pixi-bench.json'));
const port = Number(raw.port || 8139);
const scale = Number(raw.scale || 1);
if (![1, 2].includes(scale)) throw new Error('--scale must be 1 or 2');
const externalUrl = raw.url ? String(raw.url).replace(/\/$/, '') : '';
const headless = !!raw.headless;
const allowSoftware = !!raw['allow-software-gpu'];
const verbose = !!raw.verbose;
const scenes = scenario === 'all' ? ['early', 'late'] : [scenario];

const round = (n, places = 3) => Number(Number(n || 0).toFixed(places));

function startServer() {
  const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'se-pixi-bench-'));
  const child = fork(path.join(ROOT, 'server/index.js'), [], {
    cwd: ROOT,
    env: { ...process.env, SERVE_CLIENT: '1', ADMIT_OFF: '1', PORT: String(port), SNAPSHOT_DIR: snapshots },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  const collect = (chunk) => {
    logs = (logs + String(chunk)).slice(-12000);
    if (verbose) process.stderr.write(chunk);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start on port ${port}.\n${logs}`)), 20_000);
    child.on('message', (m) => {
      if (m?.t === 'listening') { clearTimeout(timer); resolve(); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited with ${code}.\n${logs}`)); });
  });
  return { child, snapshots, ready };
}

async function stopServer(server) {
  if (!server) return;
  if (server.child.exitCode != null) {
    fs.rmSync(server.snapshots, { recursive: true, force: true });
    return;
  }
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  if (server.child.connected) server.child.send({ t: 'shutdown' });
  else server.child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (server.child.exitCode == null) server.child.kill('SIGKILL');
  fs.rmSync(server.snapshots, { recursive: true, force: true });
}

async function openScene(browser, baseUrl, kind) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.t === 'create') {
          msg.rivals = ['warlord', 'merchant', 'builder'].map((personality) => ({ personality }));
          data = JSON.stringify(msg);
        }
      }
      return send.call(this, data);
    };
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.stack || e)));
  if (verbose) page.on('console', (m) => console.error(`[browser:${m.type()}] ${m.text()}`));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.fill('#playerName', `Pixi benchmark ${kind}`);
  await page.locator('details.advanced summary').click();
  await page.fill('#seed', kind === 'early' ? '7' : '5');
  if (kind === 'early') {
    await page.click('#btnPlayAI');
  } else {
    await page.click('[data-mode=watch]');
    await page.selectOption('#watchCount', '3'); // Godot's --mode=observe creates three empires.
    await page.click('#btnWatch');
  }
  await page.waitForFunction(() => {
    const v = window.__view?.();
    return window.__S?.ready && window.__S?.econ && v?.app?.renderer && v.app.canvas.width > 0;
  }, null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__view().dirtyTiles.size === 0, null, { timeout: 30_000 });

  if (kind === 'late') {
    await page.evaluate(() => window.__actions().speed(8));
    await page.waitForFunction(() => window.__S.obs?.speed === 8, null, { timeout: 15_000 });
    await page.waitForFunction(() => window.__S.time >= 720, null, { timeout: 240_000, polling: 1000 });
    await page.evaluate(() => window.__actions().speed(1));
    await page.waitForFunction(() => window.__S.obs?.speed === 1, null, { timeout: 15_000 });
  }

  await page.evaluate((sceneKind) => {
    const S = window.__S, v = window.__view();
    const cities = [...S.cities.values()];
    const target = sceneKind === 'late'
      ? cities.sort((a, b) => Number(b.pop || 0) - Number(a.pop || 0))[0]
      : cities.find((c) => c.o === S.civId) || cities[0];
    // Match Godot's 26-unit early and 30-unit late orthographic height. Pixi world units use a
    // 12-unit hex radius, while Godot uses 1.
    const cameraSize = sceneKind === 'late' ? 30 : 26;
    const zoom = v.app.screen.height / (cameraSize * 12);
    if (target) v.centerOn(target.t, zoom);
  }, kind);
  await page.waitForTimeout(1500);
  if (errors.length) throw new Error(`Browser errors before benchmark:\n${errors.join('\n')}`);
  return { context, page, errors };
}

async function measurePhase(page, phase, duration) {
  return page.evaluate(({ phase, duration }) => new Promise((resolve, reject) => {
    const v = window.__view?.(), S = window.__S, renderer = v?.app?.renderer;
    if (!v || !renderer || !S?.ready) return reject(new Error('renderer is not ready'));
    const originalFrame = v.frame;
    const originalRender = renderer.render;
    const intervals = [], scripts = [], renders = [];
    let scriptMs = 0, renderMs = 0, previous = 0, started = 0;
    let hidden = document.hidden;

    v.frame = function (...args) {
      const t0 = performance.now();
      try { return originalFrame.apply(this, args); } finally { scriptMs += performance.now() - t0; }
    };
    renderer.render = function (...args) {
      const t0 = performance.now();
      try { return originalRender.apply(this, args); } finally { renderMs += performance.now() - t0; }
    };

    if (phase === 'pan') {
      v.cam.z = v.app.screen.height / (30 * 12);
      const half = v.app.screen.width / 2 / v.cam.z;
      const centre = v.cam.x + half;
      const seam = Math.ceil(centre / v.P) * v.P;
      v.cam.x = seam - v.P * 0.15 - half; // cross the seam early, then keep moving east.
      v.clamp();
    }

    const finish = () => {
      v.frame = originalFrame;
      renderer.render = originalRender;
      resolve({ intervals, scripts, renders, hidden });
    };
    const step = (now) => {
      if (!previous) {
        previous = started = now;
        scriptMs = renderMs = 0;
        requestAnimationFrame(step);
        return;
      }
      const interval = now - previous;
      hidden ||= document.hidden;
      previous = now;
      intervals.push(interval);
      scripts.push(scriptMs);
      renders.push(renderMs);
      scriptMs = renderMs = 0;
      const dt = Math.min(0.1, interval / 1000);
      if (phase === 'zoom') {
        const elapsed = (now - started) / 1000;
        const k = elapsed % 4;
        const height = v.app.screen.height;
        const nextZoom = Math.max(height / (110 * 12), Math.min(height / (16 * 12),
          v.cam.z / Math.pow(k < 2 ? 0.985 : 1.015, dt * 60)));
        v.zoomAt(nextZoom / v.cam.z, v.app.screen.width * 0.65, v.app.screen.height * 0.5);
      } else if (phase === 'pan') {
        v.cam.x += 30 * 12 * dt; // Godot's 30 world units/s in Pixi's 12x coordinate system.
        v.clamp();
      }
      if ((now - started) / 1000 >= duration) finish();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), { phase, duration });
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function summary(samples, counts) {
  const elapsed = samples.intervals.reduce((sum, value) => sum + value, 0);
  const sub = (values) => ({ avg: round(average(values)), p99: round(percentile(values, 0.99)), max: round(percentile(values, 1)) });
  return {
    frames: samples.intervals.length,
    fps: round(samples.intervals.length / Math.max(0.001, elapsed / 1000)),
    frame_p50: round(percentile(samples.intervals, 0.5)),
    frame_p95: round(percentile(samples.intervals, 0.95)),
    frame_p99: round(percentile(samples.intervals, 0.99)),
    frame_max: round(percentile(samples.intervals, 1)),
    over50: samples.intervals.filter((value) => value > 50).length,
    script_avg: round(average(samples.scripts)),
    script_p95: round(percentile(samples.scripts, 0.95)),
    script_p99: round(percentile(samples.scripts, 0.99)),
    render_cpu_avg: round(average(samples.renders)),
    render_cpu_p95: round(percentile(samples.renders, 0.95)),
    render_cpu_p99: round(percentile(samples.renders, 0.99)),
    gpu_avg: 0,
    gpu_p95: 0,
    draw_calls: null, // Pixi has no public per-frame draw-call counter.
    units: counts.units,
    buildings: counts.buildings,
    recentred: counts.recentred,
    script: { 'view.frame': sub(samples.scripts), 'renderer.render': sub(samples.renders) },
  };
}

async function sceneMeta(page, kind, invalidReasons) {
  return page.evaluate(({ kind, invalidReasons, headless }) => {
    const S = window.__S, v = window.__view(), r = v.app.renderer;
    const gl = r.gl;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const adapter = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) || 'unknown';
    return {
      viewport: [v.app.screen.width, v.app.screen.height],
      renderer: r.name || r.type || 'WebGL',
      adapter,
      quality: S.prefs?.graphics || 'medium',
      scale: r.resolution,
      pixels: [v.app.canvas.width, v.app.canvas.height],
      pixi: PIXI.VERSION,
      browser: navigator.userAgent,
      map: [S.W, S.H],
      server_time: S.time,
      camera_size_range: [16, 110],
      scenario: kind,
      headless,
      valid: invalidReasons.length === 0,
      invalid_reasons: invalidReasons,
    };
  }, { kind, invalidReasons, headless });
}

const browser = await chromium.launch({ headless });
const output = {};
try {
  for (const kind of scenes) {
    let server;
    let opened;
    try {
      if (!externalUrl) { server = startServer(); await server.ready; }
      const baseUrl = externalUrl || `http://127.0.0.1:${port}`;
      console.error(`${kind}: loading ${baseUrl}`);
      opened = await openScene(browser, baseUrl, kind);
      const gpu = await opened.page.evaluate(() => {
        const gl = window.__view().app.renderer.gl;
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) || '';
      });
      const software = /swiftshader|llvmpipe|software|microsoft basic/i.test(gpu);
      if (software && !allowSoftware) throw new Error(`Software GPU is not a valid benchmark: ${gpu}`);
      const invalidReasons = [];
      if (headless) invalidReasons.push('headless Chromium');
      if (software) invalidReasons.push(`software GPU: ${gpu}`);
      if (externalUrl) invalidReasons.push('external server cleanliness not verified by harness');
      const result = {};
      for (const phase of ['idle', 'zoom', 'pan']) {
        console.error(`${kind}: ${phase}`);
        const samples = await measurePhase(opened.page, phase, seconds / 3);
        if (samples.hidden) invalidReasons.push(`${phase}: page was hidden`);
        const counts = await opened.page.evaluate(() => ({
          units: window.__S.units.size,
          buildings: window.__S.buildings.size,
          recentred: window.__view().period || 0,
        }));
        result[phase] = summary(samples, counts);
      }
      result.meta = await sceneMeta(opened.page, kind, invalidReasons);
      if (opened.errors.length) throw new Error(`Browser errors during benchmark:\n${opened.errors.join('\n')}`);
      output[kind] = result;
    } finally {
      await opened?.context.close();
      await stopServer(server);
    }
  }
} finally {
  await browser.close();
}

fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
console.error(`Wrote ${outPath}`);
