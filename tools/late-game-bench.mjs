// Late-game server cost bench (Pass 3). Long headless AI matches on the live ruleset (ActionGame), measuring how the
// per-tick cost grows with match age: tick p50/p95/p99/max per window, per scheduler system, route() time, the
// snapshot path the live worker runs (5 Hz delta-encoded snapshots for one connected player + spectator-free,
// econ 1 Hz), the autosave (serializeGame + stringify + gzip) every 60 game-seconds, GC pauses, heap, and a generic
// census of every Map / Set / Array / typed-array hanging off the game, the civs and the AI plans (so anything that
// grows without bound shows up without having to know its name).
// Instrumentation is monkey-patched onto the instance only; simulation source is untouched.
//
// Usage: node tools/late-game-bench.mjs [maps] [--minutes=45] [--window=5] [--seed=7] [--tag=name]
//          [--prof=40-45] (cpu profile of game minutes 40..45, written next to the json) [--save-at=40] [--from=file]
//   maps (comma list, default iron_basin,continental_divide,twin_continents); all slots AI.
//   --save-at writes a gzip save at that game minute (scratch path in --savedir) so a late window can be replayed
//   with --from=<save> (faster before/after comparisons of a late window).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const SIM = new URL('../server/sim/', import.meta.url).href;
const SERVER = new URL('../server/', import.meta.url).href;

if (isMainThread) await main(); else await run(workerData);

async function main() {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
  const maps = (args.find((a) => !a.startsWith('--')) || 'iron_basin,continental_divide,twin_continents').split(',');
  const outDir = path.resolve(ROOT, flags.out || 'docs/performance/data');
  fs.mkdirSync(outDir, { recursive: true });
  const { MAP_CATALOG } = await import(SIM + 'mapCatalog.js');
  const tag = flags.tag ? '-' + flags.tag : '';
  const jobs = maps.map((map) => {
    const def = MAP_CATALOG.find((m) => m.id === map); if (!def) throw new Error('unknown map ' + map);
    const [p0, p1] = flags.prof ? String(flags.prof).split('-').map(Number) : [null, null];
    return { map, size: def.size, players: Number(flags.players) || def.players, minutes: Number(flags.minutes) || 45, window: Number(flags.window) || 5, seed: Number(flags.seed) || 7,
      prof: flags.prof ? { from: p0 * 60, to: p1 * 60, file: path.join(outDir, `late-${map}${tag}-m${p0}-${p1}.cpuprofile`) } : null,
      saveAt: flags['save-at'] ? Number(flags['save-at']) * 60 : null, saveFile: path.join(flags.savedir || os.tmpdir(), `late-${map}-seed${Number(flags.seed) || 7}.json.gz`),
      from: flags.from || null, heap: !!flags.heap, young: Number(flags.young) || 0, census: flags.census !== 'off', sim: SIM, server: SERVER };
  });
  const pool = Math.max(1, Math.min(Number(flags.workers) || Math.max(1, os.cpus().length - 2), jobs.length));
  console.error(`running ${jobs.length} match(es) on ${pool} worker(s); node ${process.version}`);
  let next = 0;
  await Promise.all(Array.from({ length: pool }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const t0 = Date.now();
      const r = await new Promise((resolve) => {
        const w = new Worker(SELF, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 4096, ...(job.young && { maxYoungGenerationSizeMb: job.young }) } });
        w.on('message', (m) => { if (m.progress) console.error(`  ${job.map}: ${m.progress}`); else resolve(m); });
        w.once('error', (e) => resolve({ map: job.map, error: String(e.stack || e) }));
      });
      r.wallSeconds = Math.round((Date.now() - t0) / 1000);
      const file = path.join(outDir, `late-${job.map}${tag}.json`);
      fs.writeFileSync(file, JSON.stringify(r, null, 1));
      console.error(`${job.map}: ${r.error ? 'ERROR ' + r.error : 'done'} in ${r.wallSeconds}s -> ${path.relative(ROOT, file)}`);
      if (!r.error) print(r);
    }
  }));
}

function print(r) {
  const f = (x, w = 7) => (x == null ? '-' : typeof x === 'number' ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : String(x)).padStart(w);
  console.log(`\n== ${r.map} (${r.players} AI, seed ${r.seed}, ${r.ticks} ticks, over=${r.final.over} at ${r.final.time}s, hash ${r.hash})`);
  console.log(`${'min'.padStart(7)} ${'units'.padStart(6)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)} ${'route'.padStart(7)} ${'snapMs'.padStart(7)} ${'snapKB'.padStart(7)} ${'econKB'.padStart(7)} ${'saveMs'.padStart(7)} ${'saveKB'.padStart(7)} ${'gcMs'.padStart(7)} ${'heapMB'.padStart(7)}  top systems (mean ms)`);
  for (const w of r.windows) {
    const top = Object.entries(w.sysMean).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
    console.log(`${f(`${w.m0}-${w.m1}`)} ${f(w.units, 6)} ${f(w.tick.p50)} ${f(w.tick.p95)} ${f(w.tick.p99)} ${f(w.tick.max)} ${f(w.routeMs)} ${f(w.snap.p95)} ${f(w.snapKB)} ${f(w.econKB)} ${f(w.saveMs)} ${f(w.saveKB)} ${f(w.gcMs)} ${f(w.heapMb)}  >50/100/250ms ${w.over50}/${w.over100}/${w.over250} mean ${w.tick.mean}  ${top}`);
  }
  console.log('growth (first window end -> last window end), largest relative growth:');
  for (const g of r.growth.slice(0, 30)) console.log(`  ${g.k.padEnd(48)} ${String(g.a).padStart(8)} -> ${String(g.b).padStart(8)}`);
}

// ------------------------------------------------------------------------------------------------ worker
async function run(job) {
  globalThis.SE_MAP_SIZE = job.size; globalThis.SE_WRAP = true;
  const { ActionGame } = await import(job.sim + 'actionGame.js');
  const { serializeGame, restoreGame, stateHash } = await import(job.sim + 'persist.js');
  const { deltaEncoder } = await import(job.server + 'delta.js');
  const { geoViewer, geoMessage } = await import(job.sim + 'terrainGeo.js');
  const { PerformanceObserver } = await import('node:perf_hooks');

  const P = ['warlord', 'merchant', 'builder'];
  let g;
  if (job.from) g = restoreGame(JSON.parse(zlib.gunzipSync(fs.readFileSync(job.from)).toString()));
  else {
    const slots = Array.from({ length: job.players }, (_, i) => ({ human: false, difficulty: 'normal', personality: P[(i + job.seed) % 3] }));
    g = new ActionGame({ id: 'late-' + job.map, seed: job.seed, map: job.map, slots });
  }
  // civ 0 is AI-driven but flagged human + connected, so per-player memory / snapshots run as for a real player
  const viewer = g.civs[0]; viewer.human = true; viewer.connected = true;

  const now = () => performance.now();
  let cur = null, curSys = 'outside';
  const add = (k, ms) => { if (cur) cur[k] = (cur[k] || 0) + ms; };
  const cnt = (k, n = 1) => { if (cur) cur['#' + k] = (cur['#' + k] || 0) + n; };
  const wrap = (obj, name, label) => {
    const orig = obj?.[name]; if (typeof orig !== 'function') return;
    obj[name] = function (...a) { cnt(label); const t = now(); try { return orig.apply(this, a); } finally { const ms = now() - t; add(label, ms); if (label === 'route') add('route@' + curSys, ms); } };
  };
  wrap(g.nav, 'route', 'route');
  wrap(g.nav, 'strategic', 'strategic');
  wrap(g.nav, 'fineRoute', 'fineRoute');
  wrap(g.nav, 'nearest', 'nearest');
  wrap(g.nav, 'primeGroup', 'primeGroup');
  wrap(g.nav, 'componentOf', 'componentOf');
  wrap(g.nav, 'localRouteB', 'localRouteB');
  wrap(g.nav, 'localRoute', 'localRoute');
  wrap(g.nav, 'invalidate', 'nav.invalidate');
  wrap(g, 'refreshTerritory', 'refreshTerritory');
  wrap(g, 'reveal', 'reveal');
  wrap(g, 'notify', 'notify');
  { const orig = g.runAI; g.runAI = function () { const c = this.civs.find((x) => x.alive && x.aiPlan?.next <= this.time); if (c && cur) { cur.aiCiv = c.id; cur.aiState = c.aiPlan.state + (c.aiPlan.op ? '/op' : ''); } return orig.call(this); }; }
  const gcs = [];
  const gcKinds = {}; const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { gcs.push([e.startTime, e.duration]); const k = e.detail?.kind ?? 0; const r = gcKinds[k] ??= { n: 0, ms: 0, max: 0 }; r.n++; r.ms += e.duration; r.max = Math.max(r.max, e.duration); } });
  obs.observe({ entryTypes: ['gc'] });
  if (!g.sched) g.tick();
  for (const t of g.sched.tasks) { const fn = t.fn; t.fn = (ctx, n) => { const a = now(); curSys = t.name; try { return fn(ctx, n); } finally { curSys = 'outside'; add('sys:' + t.name, now() - a); } }; }

  const enc = deltaEncoder(), geo = geoViewer();
  { const [msg] = g.snapshots(0); enc(msg[1]); geoMessage(g, geo, viewer.visible, viewer.explored, true); }

  let session = null;
  const startProf = async () => { const insp = await import('node:inspector'); session = new insp.Session(); session.connect(); if (job.heap) { await post(session, 'HeapProfiler.enable'); await post(session, 'HeapProfiler.startSampling', { samplingInterval: 65536, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); } else { await post(session, 'Profiler.enable'); await post(session, 'Profiler.setSamplingInterval', { interval: 200 }); await post(session, 'Profiler.start'); } };
  const stopProf = async () => { const { profile } = await post(session, job.heap ? 'HeapProfiler.stopSampling' : 'Profiler.stop'); fs.writeFileSync(job.heap ? job.prof.file.replace('.cpuprofile', '.heapprofile') : job.prof.file, JSON.stringify(profile)); session.disconnect(); session = null; };

  const endT = job.minutes * 60;
  const cpu0 = process.threadCpuUsage?.();
  const rows = [], saves = [], census = [];
  let frames = 0, saved = false;
  const startT = g.time;
  while (g.time < endT - 1e-6 && !g.over) {
    if (job.prof && !session && g.time >= job.prof.from && g.time < job.prof.to) await startProf();
    if (job.prof && session && g.time >= job.prof.to) await stopProf();
    cur = {};
    const t0 = now();
    g.tick();
    cur.tick = now() - t0; cur.t0 = t0;
    frames++;
    if (frames % 2 === 0) {
      const econ = frames % 10 === 0;
      const a = now();
      let bytes = 0, econBytes = 0;
      for (const [civId, msg] of g.snapshots(null, econ, null)) {
        if (civId !== 0) continue;
        const s = JSON.stringify(enc(msg)); bytes += s.length; if (econ) econBytes = s.length;
      }
      const gm = geoMessage(g, geo, viewer.visible, viewer.explored, false); if (gm) bytes += JSON.stringify(gm).length;
      cur.snap = now() - a; cur.snapBytes = bytes; if (econ) cur.econBytes = econBytes;
    }
    // outbox (notes, events, acks) as the worker would stringify it
    if (g.outbox.length) { let ob = 0; for (const [, m] of g.outbox) ob += JSON.stringify(m).length; cur.outboxBytes = ob; cur.outboxN = g.outbox.length; }
    g.outbox.length = 0;
    cur.t = g.time; cur.units = g.units.size;
    rows.push(cur);
    const sec = Math.round(g.time * 10);
    if (sec % 600 === 0) {          // autosave cadence: every 60 game-seconds
      let a = now(); const snap = serializeGame(g); const ser = now() - a;
      a = now(); const json = JSON.stringify(snap); const str = now() - a;
      a = now(); const gz = zlib.gzipSync(json, { level: 6 }); const gzMs = now() - a;
      saves.push({ t: Math.round(g.time), serializeMs: +ser.toFixed(2), stringifyMs: +str.toFixed(2), gzipMs: +gzMs.toFixed(1), kb: Math.round(json.length / 1024), gzKb: Math.round(gz.length / 1024), parts: Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, JSON.stringify(v ?? null).length]).filter(([, n]) => n > 20000)) });
      if (job.saveAt != null && !saved && g.time >= job.saveAt) { fs.writeFileSync(job.saveFile, gz); saved = true; }
    }
    if (job.census && sec % 300 === 0) census.push({ t: Math.round(g.time), ...takeCensus(g) });
    if (sec % 3000 === 0) parentPort.postMessage({ progress: `game ${Math.round(g.time / 60)} min, units ${g.units.size}, last tick ${cur.tick.toFixed(1)} ms` });
  }
  if (session) await stopProf();
  const cpu1 = process.threadCpuUsage?.(cpu0);
  cur = null;
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  { let j = 0; for (const [st, dur] of gcs) { while (j < rows.length - 1 && rows[j + 1].t0 <= st) j++; const r = rows[j]; if (r && st >= r.t0 && st <= r.t0 + r.tick) r.gc = (r.gc || 0) + dur; } }

  const keys = new Set(); for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  const windows = [];
  const W = job.window * 60;
  for (let w0 = Math.floor(startT / W) * W; w0 < (rows.at(-1)?.t ?? 0); w0 += W) {
    const part = rows.filter((r) => r.t > w0 && r.t <= w0 + W); if (!part.length) continue;
    const sys = {}, sysP99 = {}; for (const k of keys) if (k.startsWith('sys:')) { const v = part.map((r) => r[k] || 0); sys[k.slice(4)] = +mean(v).toFixed(3); sysP99[k.slice(4)] = q(v).p99; }
    const routeBy = {}; for (const k of keys) if (k.startsWith('route@')) routeBy[k.slice(6)] = +mean(part.map((r) => r[k] || 0)).toFixed(3);
    const sv = saves.filter((s) => s.t > w0 && s.t <= w0 + W);
    const cz = census.filter((c) => c.t > w0 && c.t <= w0 + W).at(-1);
    windows.push({ m0: w0 / 60, m1: (w0 + W) / 60, units: Math.max(...part.map((r) => r.units)), tick: q(part.map((r) => r.tick)), over50: part.filter((r) => r.tick > 50).length, over100: part.filter((r) => r.tick > 100).length, over250: part.filter((r) => r.tick > 250).length, tickExGc: q(part.map((r) => r.tick - (r.gc || 0))),
      sysMean: sys, sysP99, routeMs: +mean(part.map((r) => r.route || 0)).toFixed(3), routeCalls: part.reduce((n, r) => n + (r['#route'] || 0), 0), routeBy,
      invalidates: part.reduce((n, r) => n + (r['#nav.invalidate'] || 0), 0), territory: part.reduce((n, r) => n + (r['#refreshTerritory'] || 0), 0), territoryMs: +part.reduce((n, r) => n + (r.refreshTerritory || 0), 0).toFixed(1),
      notifies: part.reduce((n, r) => n + (r['#notify'] || 0), 0),
      snap: q(part.filter((r) => r.snap != null).map((r) => r.snap)), snapKB: +(mean(part.filter((r) => r.snapBytes != null).map((r) => r.snapBytes)) / 1024).toFixed(2),
      econKB: +(mean(part.filter((r) => r.econBytes != null).map((r) => r.econBytes)) / 1024).toFixed(2),
      outboxKBperS: +(part.reduce((n, r) => n + (r.outboxBytes || 0), 0) / 1024 / W).toFixed(2),
      saveMs: sv.length ? +mean(sv.map((s) => s.serializeMs + s.stringifyMs)).toFixed(1) : null, saveKB: sv.at(-1)?.kb ?? null, gzKB: sv.at(-1)?.gzKb ?? null,
      gcMs: +part.reduce((n, r) => n + (r.gc || 0), 0).toFixed(1), gcMax: +Math.max(0, ...part.map((r) => r.gc || 0)).toFixed(1), heapMb: cz?.heapMb ?? null, census: cz });
  }
  // the worst ticks, with their breakdown (system ms, route/strategic calls and ms)
  const spikes = [...rows].sort((a, b) => b.tick - a.tick).slice(0, 25).map((r) => Object.fromEntries(Object.entries(r)
    .filter(([k, v]) => k !== 't0' && (typeof v === 'string' || typeof v === 'number' && (k.startsWith('#') ? v > 0 : v >= 0.5 || k === 't' || k === 'aiCiv'))).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v])));
  const growth = [];
  if (census.length > 1) {
    const a = census.find((c) => c.t >= (census.at(-1).t >= 1200 ? 600 : 0)) || census[0], b = census.at(-1);
    for (const [k, v] of Object.entries(b)) if (typeof v === 'number' && k !== 't') { const u = a[k] ?? 0; if (v > 50 && v > u * 1.3) growth.push({ k, a: u, b: v, r: v / Math.max(1, u) }); }
    growth.sort((x, y) => (y.b - y.a) / Math.max(50, y.a) - (x.b - x.a) / Math.max(50, x.a));
  }
  parentPort.postMessage({ map: job.map, players: g.civs.length, seed: job.seed, ticks: rows.length, threadCpuS: cpu1 ? +((cpu1.user + cpu1.system) / 1e6).toFixed(1) : null, from: job.from ? path.basename(job.from) : null, gcKinds, windows, spikes, saves, census, growth,
    hash: stateHash(g), final: { over: !!g.over, time: Math.round(g.time), units: g.units.size, buildings: g.buildings.size, alive: g.civs.filter((c) => c.alive).length } });
}

function post(session, method, params) { return new Promise((res, rej) => session.post(method, params, (e, r) => (e ? rej(e) : res(r)))); }

// sizes of every collection one or two levels below the game, the civs (max across civs) and the AI plans
function takeCensus(g) {
  const out = { heapMb: Math.round(process.memoryUsage().heapUsed / 1048576) };
  const size = (v) => (v instanceof Map || v instanceof Set ? v.size : Array.isArray(v) ? v.length : ArrayBuffer.isView(v) ? -1 : null);
  const walk = (obj, prefix, depth, agg) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      let v; try { v = obj[k]; } catch { continue; }
      const n = size(v);
      if (n != null && n >= 0) {
        const key = prefix + k;
        out[key] = agg ? Math.max(out[key] || 0, n) : n;
        if (agg) out[key + '(sum)'] = (out[key + '(sum)'] || 0) + n;
        // nested arrays / sets inside a map's values: total element count (e.g. impacts lists, road edges)
        if (v instanceof Map && n) { let inner = 0, any = false; for (const x of v.values()) { const m = size(x); if (m > 0) { inner += m; any = true; } else if (x && typeof x === 'object' && !Array.isArray(x)) { for (const y of Object.values(x)) { const m2 = size(y); if (m2 > 0) { inner += m2; any = true; } } } } if (any) out[key + '.*'] = agg ? Math.max(out[key + '.*'] || 0, inner) : inner; }
        if (Array.isArray(v) && n && depth > 0) { let inner = 0, any = false; for (const x of v) if (x && typeof x === 'object') for (const y of Object.values(x)) { const m = size(y); if (m > 0) { inner += m; any = true; } } if (any) out[key + '[].*'] = agg ? Math.max(out[key + '[].*'] || 0, inner) : inner; }
      } else if (v && typeof v === 'object' && depth > 0 && !(v instanceof Map) && !ArrayBuffer.isView(v) && k !== 'game' && k !== 'g') walk(v, prefix + k + '.', depth - 1, agg);
    }
  };
  walk(g, 'g.', 2, false);
  for (const c of g.civs) { walk(c, 'civ.', 1, true); if (c.aiPlan) walk(c.aiPlan, 'civ.aiPlan.', 1, true); }
  // per-entity arrays (paths, queues, memories) summed over units and buildings
  let up = 0, uq = 0, umax = 0;
  for (const u of g.units.values()) for (const k of Object.keys(u)) { const n = size(u[k]); if (n > 0) { up += n; umax = Math.max(umax, n); out['unit.' + k + '(max)'] = Math.max(out['unit.' + k + '(max)'] || 0, n); } }
  out['unit.*(sum)'] = up; out['unit.*(maxOne)'] = umax;
  for (const b of g.buildings.values()) for (const k of Object.keys(b)) { const n = size(b[k]); if (n > 0) { uq += n; out['bldg.' + k + '(max)'] = Math.max(out['bldg.' + k + '(max)'] || 0, n); } }
  out['bldg.*(sum)'] = uq;
  return out;
}

function q(a) {
  if (!a.length) return { n: 0 };
  const s = Float64Array.from(a).sort();
  const at = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  return { n: s.length, mean: +mean(a).toFixed(3), p50: at(.5), p95: at(.95), p99: at(.99), max: +s[s.length - 1].toFixed(2) };
}
function mean(a) { let t = 0; for (const x of a) t += x; return a.length ? t / a.length : 0; }
