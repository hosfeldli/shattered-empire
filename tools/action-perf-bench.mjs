// Action RTS server performance bench (live ruleset: ActionGame). Headless, deterministic seeds, one worker
// thread per scenario (the map size is fixed per process). Measures per tick: total tick ms and every
// scheduler system, visibility sub-parts (reveal / siteWire / rememberStructures), pathfinding route() calls,
// the per-viewer snapshot path the live worker runs at 5 Hz (game.snapshots + udelta encode + JSON.stringify,
// econ at 1 Hz), the autosave's synchronous JSON.stringify(serializeGame()) and world/entity counts.
// Instrumentation is monkey-patched onto the game instance only; simulation source is untouched.
//
// Usage: node tools/action-perf-bench.mjs [scenarios] [--out=dir] [--workers=N] [--deep] [--minutes=M]
//   scenarios (comma list, default all): A,A-large,B,D50,D100,D250,D500,D1000,G,DUEL
//   --deep adds per-call timing of nav.clearShot / targets.query / sees (expensive; distorts totals).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const SIM = new URL('../server/sim/', import.meta.url).href;
const SERVER = new URL('../server/', import.meta.url).href;

const SCENARIOS = {
  A: { kind: 'idle', map: 'crossroads', players: 4, seconds: 90, desc: 'Early idle: 4 seats on Crossroads, AI off, starting forces only' },
  'A-large': { kind: 'idle', map: null, size: 256, players: 4, seconds: 60, desc: 'Early idle on a random 256x256 map (per-tile loop scaling)' },
  B: { kind: 'developed', map: 'crossroads', players: 4, perCiv: 60, seconds: 90, desc: 'Developed world, peace: 4 civs, all bases built out, 60 units each parked at home, AI off' },
  D50: { kind: 'battle', map: 'crossroads', total: 50, seconds: 60 },
  D100: { kind: 'battle', map: 'crossroads', total: 100, seconds: 60 },
  D250: { kind: 'battle', map: 'crossroads', total: 250, seconds: 60 },
  D500: { kind: 'battle', map: 'crossroads', total: 500, seconds: 60 },
  D1000: { kind: 'battle', map: 'crossroads', total: 1000, seconds: 60 },
  // stationary, immortal (hp x1000): the count stays at N for the whole run, so cost per tick at N is steady state
  S50: { kind: 'battle', stationary: true, map: 'crossroads', total: 50, seconds: 30 },
  S100: { kind: 'battle', stationary: true, map: 'crossroads', total: 100, seconds: 30 },
  S250: { kind: 'battle', stationary: true, map: 'crossroads', total: 250, seconds: 30 },
  S500: { kind: 'battle', stationary: true, map: 'crossroads', total: 500, seconds: 30 },
  S1000: { kind: 'battle', stationary: true, map: 'crossroads', total: 1000, seconds: 30 },
  G: { kind: 'soak', map: 'crossroads', players: 4, seconds: 40 * 60, desc: '4 AI FFA soak on Crossroads, 40 game-minutes' },
  DUEL: { kind: 'soak', map: 'twin_rivers', players: 2, seconds: 30 * 60, desc: 'AI vs AI duel on Twin Rivers (action-balance style), 30 game-minutes' },
};

if (isMainThread) await main(); else await runScenario(workerData);

async function main() {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
  const pick = (args.find((a) => !a.startsWith('--')) || Object.keys(SCENARIOS).join(',')).split(',');
  const outDir = path.resolve(ROOT, flags.out || 'docs/performance/data');
  fs.mkdirSync(outDir, { recursive: true });
  const { MAP_CATALOG } = await import(SIM + 'mapCatalog.js');
  const jobs = pick.map((key) => {
    const sc = SCENARIOS[key]; if (!sc) throw new Error('unknown scenario ' + key);
    const def = sc.map ? MAP_CATALOG.find((m) => m.id === sc.map) : null;
    const seconds = flags.minutes ? Number(flags.minutes) * 60 : sc.seconds;
    return { key, ...sc, seconds, size: sc.size || def?.size || 128, players: sc.players || def?.players || 2, seed: Number(flags.seed) || 7, deep: !!flags.deep, sim: SIM, server: SERVER };
  });
  const pool = Math.max(1, Math.min(Number(flags.workers) || Math.max(1, os.cpus().length - 2), jobs.length));
  console.error(`running ${jobs.length} scenario(s) on ${pool} worker(s); node ${process.version}`);
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: pool }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const t0 = Date.now();
      const r = await new Promise((resolve) => {
        const w = new Worker(SELF, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
        w.once('message', resolve);
        w.once('error', (e) => resolve({ key: job.key, error: String(e.stack || e) }));
      });
      r.wallSeconds = Math.round((Date.now() - t0) / 1000);
      results.push(r);
      const file = path.join(outDir, `action-perf-${job.key}${job.deep ? '-deep' : ''}.json`);
      fs.writeFileSync(file, JSON.stringify(r, null, 1));
      console.error(`${job.key}: ${r.error ? 'ERROR ' + r.error.split('\n')[0] : 'done'} in ${r.wallSeconds}s -> ${path.relative(ROOT, file)}`);
      if (!r.error) printSummary(r);
    }
  }));
}

function printSummary(r) {
  const s = r.summary;
  const row = (name, q) => `  ${name.padEnd(26)} ${f(q.p50)} ${f(q.p95)} ${f(q.p99)} ${f(q.max)}  mean ${f(q.mean)}`;
  const f = (x) => (x == null ? '-' : x.toFixed(2)).padStart(8);
  console.log(`\n== ${r.key}: ${r.desc || ''}  (map ${r.map ?? 'random'} ${r.size}, ${r.ticks} ticks, final units ${r.final.units}, buildings ${r.final.buildings})`);
  console.log(`  ${'system (ms)'.padEnd(26)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}`);
  console.log(row('TICK', s.tick));
  for (const [k, q] of Object.entries(s.systems).sort((a, b) => b[1].mean - a[1].mean)) console.log(row(k, q));
  for (const [k, q] of Object.entries(s.extra)) console.log(row(k, q));
}

// ------------------------------------------------------------------------------------------- worker side
async function runScenario(job) {
  globalThis.SE_MAP_SIZE = job.size; globalThis.SE_WRAP = false;
  const { ActionGame } = await import(job.sim + 'actionGame.js');
  const { ACTION_UNITS } = await import(job.sim + 'actionDefinitions.js');
  const { addFacility, openSlots, headquarters, fortifyBase } = await import(job.sim + 'actionBases.js');
  const { staffBase } = await import(job.sim + 'actionEngineers.js');
  const { wrapX, distance } = await import(job.sim + 'actionNavigation.js');
  const { rememberBattlefield, battlefieldSnapshot } = await import(job.sim + 'battlefield.js');
  const { serializeGame } = await import(job.sim + 'persist.js');
  const { deltaEncoder } = await import(job.server + 'delta.js');
  const { geoViewer, geoMessage } = await import(job.sim + 'terrainGeo.js');

  const P = ['warlord', 'merchant', 'builder'];
  const slots = Array.from({ length: job.players || 2 }, (_, i) => ({ human: false, difficulty: 'normal', personality: P[(i + job.seed) % 3] }));
  const g = new ActionGame({ id: 'perf-' + job.key, seed: job.seed, map: job.map || null, slots });
  const viewer = g.civs[0];
  // The player seat: in a live single-player match civ 0 is human and connected. Here the AI keeps playing it
  // (aiPlan stays), but it is flagged human + connected so rememberBattlefield / rememberStructures / snapshots
  // run for it exactly as for a real player.
  viewer.human = true; viewer.connected = true;
  const aiOff = job.kind !== 'soak';
  if (aiOff) for (const c of g.civs) c.aiPlan = null;

  // -------- scenario staging
  const center = g.sites.find((s) => s.kind === 'metro') || g.sites.find((s) => s.owner < 0) || g.sites[0];
  if (job.kind === 'developed') {
    const pending = ['barracks', 'motor_works', 'power_plant', 'depot', 'airfield', 'armory', 'heavy_weapons', 'advanced_lab'];
    for (const civ of g.civs) {
      civ.age = 2; civ.res = { materials: 9000, energy: 5000 };
      civ.techs.add('improved_logistics');   // (the troop upgrades were removed 2026-11-19)
      const home = g.sites.find((s) => s.owner === civ.id && s.slots);
      const extra = g.sites.filter((s) => s.slots && s.owner < 0).sort((a, b) => distance(a, home) - distance(b, home)).slice(0, 1);
      for (const site of [home, ...extra]) {
        if (site.owner >= 0 && site.owner !== civ.id) continue;
        site.owner = civ.id; site.tier = 3; site.everEstablished = true; site.developedAt = 0;
        if (!headquarters(g, site)) addFacility(g, civ, site, 'town', site.tile, { instant: true });
        const todo = [...pending];
        for (const tile of openSlots(g, site)) { const type = todo.shift(); if (!type) break; addFacility(g, civ, site, type, tile, { instant: true }); }
        staffBase(g, site);
        fortifyBase(g, civ, site);
      }
      const types = ['rifle_squad', 'rifle_squad', 'tank', 'armored_car', 'mortar_team', 'anti_armor', 'scout_buggy', 'engineer'];
      for (let i = 0; i < job.perCiv; i++) g.spawn(civ, types[i % types.length], home, 1.6 + (i % 12) * .22);
    }
    g.refreshTerritory(); g.rebuildBuildingIndex?.(); g.refreshVisibility();
  } else if (job.kind === 'battle') {
    // The sandbox 'massive' scenario (ActionGame.stageScenario) with a variable count: two lines facing off.
    g.units.clear(); g.movers.clear(); g.projectiles.clear();
    const count = job.total / 2;
    const types = ['rifle_squad', 'rifle_squad', 'tank', 'armored_car', 'mortar_team', 'sp_artillery', 'helicopter', 'air_defense'];
    const cols = Math.ceil(Math.sqrt(count * 1.5));
    for (let side = 0; side < 2; side++) for (let i = 0; i < count; i++) {
      const x = wrapX(center.x + (side ? 1 : -1) * ((job.stationary ? 1.9 : 3.8) + Math.floor(i / cols) * .51)), z = center.z + (i % cols - cols * .5) * .54;
      const type = types[(i + side) % types.length];
      const u = g.spawn(g.civs[side], type, { x, z }, .13) || g.spawn(g.civs[side], type, center, 2 + i * .017);
      if (u) { u.yaw = side === 0 ? Math.PI * .5 : -Math.PI * .5; u.mode = 'guard'; if (job.stationary) { u.hp *= 1000; u.maxHp *= 1000; u.braced = true; } }
    }
    job.spawned = g.units.size;
    // side A attack-moves into side B (a real engagement, not just two static lines)
    const { moveGroup } = await import(job.sim + 'actionOrders.js');
    const a = [...g.units.values()].filter((u) => u.owner === 0);
    if (!job.stationary) moveGroup(g, a, { x: center.x + 3, z: center.z }, { mode: 'assault' });
    g.refreshVisibility();
  }

  // -------- instrumentation
  const now = () => performance.now();
  let cur = null;                         // per-tick accumulator
  let curSys = 'outside';                  // scheduler system currently running (route() attribution)
  const add = (k, ms) => { if (cur) cur[k] = (cur[k] || 0) + ms; };
  const cnt = (k, n = 1) => { if (cur) cur['#' + k] = (cur['#' + k] || 0) + n; };
  const wrapMethod = (obj, name, label, { time = true } = {}) => {
    const orig = obj[name];
    obj[name] = function (...a) {
      cnt(label);
      if (!time) return orig.apply(this, a);
      const t = now(); try { return orig.apply(this, a); } finally { const ms = now() - t; add(label, ms); if (label === 'nav.route') { add('route@' + curSys, ms); cnt('route@' + curSys); } }
    };
  };
  wrapMethod(g, 'reveal', 'vis.reveal');
  { const fc = g.fogCache, set = fc.set.bind(fc); fc.set = (k, v) => { cnt('fogCacheMiss'); return set(k, v); }; }
  const { PerformanceObserver } = await import('node:perf_hooks');
  const gcs = [];
  const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcs.push([e.startTime, e.duration]); });
  obs.observe({ entryTypes: ['gc'] });
  wrapMethod(g, 'siteWire', 'siteWire');
  wrapMethod(g, 'rememberStructures', 'vis.rememberStructures');
  wrapMethod(g, 'refreshTerritory', 'refreshTerritory');
  wrapMethod(g, 'loseBuilding', 'loseBuilding');
  wrapMethod(g.nav, 'route', 'nav.route');
  wrapMethod(g.nav, 'invalidate', 'nav.invalidate', { time: false });
  wrapMethod(g, 'recordEngagement', 'recordEngagement', { time: job.deep });
  if (job.deep) {
    wrapMethod(g.nav, 'clearShot', 'nav.clearShot');
    wrapMethod(g.targets, 'query', 'targets.query');
    wrapMethod(g.movers, 'query', 'movers.query');
    wrapMethod(g, 'sees', 'sees');
    wrapMethod(g.nav, 'canStand', 'nav.canStand');
    wrapMethod(g.nav, 'canMove', 'nav.canMove');
  }
  // scheduler systems: wrap after the scheduler exists (first tick builds it)
  g.tick();
  for (const t of g.sched.tasks) { const fn = t.fn; t.fn = (ctx, n) => { const a = now(); curSys = t.name; try { return fn(ctx, n); } finally { curSys = 'outside'; add('sys:' + t.name, now() - a); } }; }

  // -------- snapshot path, exactly as server/worker.js runs it for a connected udelta+geo viewer
  const enc = deltaEncoder();
  const geo = geoViewer();
  { const [msg] = g.snapshots(0); enc(msg[1]); geoMessage(g, geo, viewer.visible, viewer.explored, true); }

  const ticks = Math.round(job.seconds * 10);
  const rows = [];
  const probes = [];
  const saves = [];
  let frames = 0;
  const heapEvery = 50;
  for (let i = 0; i < ticks && !g.over; i++) {
    cur = {};
    const t0 = now();
    g.tick();
    cur.tick = now() - t0;
    cur.t0 = t0;
    frames++;
    if (frames % 2 === 0) {
      const econ = frames % 10 === 0;
      let a = now();
      const snaps = g.snapshots(null, econ, null);
      cur['snap.build'] = now() - a;
      let bytes = 0, unitsSent = 0;
      a = now();
      for (const [, msg] of snaps) { const m = enc(msg); unitsSent += m.units?.length || 0; bytes += JSON.stringify(m).length; }
      cur['snap.encode+stringify'] = now() - a;
      a = now();
      const gm = geoMessage(g, geo, viewer.visible, viewer.explored, false);
      cur['snap.geo'] = now() - a;
      if (gm) bytes += JSON.stringify(gm).length;
      cur.snapBytes = bytes; cur.snapEcon = econ ? 1 : 0; cur.unitsSent = unitsSent;
    }
    g.outbox.length = 0;
    cur.t = +g.time.toFixed(1);
    cur.units = g.units.size; cur.buildings = g.buildings.size; cur.projectiles = g.projectiles.size;
    if (i % heapEvery === 0) Object.assign(cur, counts(g, viewer));
    rows.push(cur);
    // autosave cost (worker: every 60 game-seconds, synchronous stringify on the tick thread)
    if (i > 0 && i % 600 === 0) {
      const a = now(); const json = JSON.stringify(serializeGame(g)); const ms = now() - a;
      saves.push({ t: Math.round(g.time), ms: +ms.toFixed(2), bytes: json.length, units: g.units.size, buildings: g.buildings.size });
    }
    // standalone probes of components that cannot be wrapped (module functions), every 10 s
    if (i % 100 === 50) {
      const p = { t: Math.round(g.time) };
      let a = now(); rememberBattlefield(g, viewer); p.rememberBattlefield = now() - a;
      const view = { civ: viewer, vis: viewer.visible, explored: viewer.explored, god: false };
      a = now(); const bf = battlefieldSnapshot(g, viewer.visible, viewer.explored, viewer.battlefieldMemory, false); p.battlefieldSnapshot = now() - a;
      p.bfBytes = JSON.stringify(bf).length;
      a = now(); const us = g.unitSnapshot(viewer, view); p.unitSnapshot = now() - a; p.unitBytes = JSON.stringify(us).length;
      a = now(); const es = g.econSnapshot(viewer, view); p.econSnapshot = now() - a; p.econBytes = JSON.stringify(es).length;
      const godView = { civ: viewer, vis: new Uint8Array(viewer.visible.length).fill(1), explored: new Uint8Array(viewer.visible.length).fill(1), god: true };
      a = now(); const os2 = JSON.stringify(g.econSnapshot(viewer, godView)); p.spectatorEcon = now() - a; p.spectatorEconBytes = os2.length;
      p.econParts = Object.fromEntries(Object.entries(es).map(([k, v]) => [k, JSON.stringify(v ?? null).length]));
      probes.push(p);
    }
  }
  cur = null;
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  // attribute GC pauses to the tick they happened in (by timestamp)
  { let j = 0; for (const [st, dur] of gcs) { while (j < rows.length - 1 && rows[j + 1].t0 <= st) j++; const r = rows[j]; if (r && st >= r.t0 && st <= r.t0 + r.tick) r.gc = (r.gc || 0) + dur; } }
  const gcTotal = gcs.reduce((n, x) => n + x[1], 0);

  // -------- summaries
  const summary = { tick: q(rows.map((r) => r.tick)), systems: {}, extra: {} };
  const keys = new Set(); for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  for (const k of keys) if (k.startsWith('sys:')) summary.systems[k.slice(4)] = q(rows.map((r) => r[k] || 0));
  for (const k of ['snap.build', 'snap.encode+stringify', 'snap.geo', 'snapBytes']) summary.extra[k] = q(rows.filter((r) => r[k] != null).map((r) => r[k]));
  summary.extra['snapBytes(econ)'] = q(rows.filter((r) => r.snapEcon === 1).map((r) => r.snapBytes));
  for (const k of keys) if (!k.startsWith('sys:') && !k.startsWith('#') && ['vis.reveal', 'siteWire', 'vis.rememberStructures', 'refreshTerritory', 'loseBuilding', 'nav.route', 'recordEngagement', 'nav.clearShot', 'targets.query', 'movers.query', 'sees', 'nav.canStand', 'nav.canMove'].includes(k))
    summary.extra[k + ' (ms/tick)'] = q(rows.map((r) => r[k] || 0));
  const callTotals = {}; for (const k of keys) if (k.startsWith('#')) callTotals[k.slice(1)] = rows.reduce((n, r) => n + (r[k] || 0), 0);
  // visibility ticks only (every 4th)
  const visRows = rows.filter((r) => r['sys:visibility'] != null && r['sys:visibility'] > 0);
  summary.routeBySystem = {}; for (const k of keys) if (k.startsWith('route@')) summary.routeBySystem[k.slice(6)] = { ms: +rows.reduce((n, r) => n + (r[k] || 0), 0).toFixed(1), calls: rows.reduce((n, r) => n + (r['#' + k] || 0), 0), maxTickMs: +Math.max(...rows.map((r) => r[k] || 0)).toFixed(2) };
  summary.gc = { totalMs: +gcTotal.toFixed(1), count: gcs.length, inTickMs: +rows.reduce((n, r) => n + (r.gc || 0), 0).toFixed(1), ticksWithGc: rows.filter((r) => r.gc).length,
    tickExGc: q(rows.map((r) => r.tick - (r.gc || 0))) };
  summary.visibilityTicks = { total: q(visRows.map((r) => r['sys:visibility'])), reveal: q(visRows.map((r) => r['vis.reveal'] || 0)), siteWire: q(visRows.map((r) => r.siteWire || 0)),
    rememberStructures: q(visRows.map((r) => r['vis.rememberStructures'] || 0)), revealCalls: q(visRows.map((r) => r['#vis.reveal'] || 0)), fogCacheMisses: q(visRows.map((r) => r['#fogCacheMiss'] || 0)), siteWireCalls: q(visRows.map((r) => r['#siteWire'] || 0)) };
  // time series in 60 s windows
  const windows = [];
  const W = 600;
  for (let s = 0; s < rows.length; s += W) {
    const part = rows.slice(s, s + W);
    const vr = part.filter((r) => r['sys:visibility'] > 0);
    const last = [...part].reverse().find((r) => r.heapMb != null) || {};
    const sys = {}; for (const k of keys) if (k.startsWith('sys:')) sys[k.slice(4)] = +mean(part.map((r) => r[k] || 0)).toFixed(3);
    const { t: _t, tick: _k, t0: _z, units: _u, buildings: _b, projectiles: _p, ...cnts } = last;
    windows.push({ counts: Object.fromEntries(Object.entries(cnts).filter(([k]) => !k.includes('.') && !k.startsWith('#') && !k.startsWith('sys:'))),
      t0: part[0].t, t1: part.at(-1).t, tick: q(part.map((r) => r.tick)), gcInTickMs: +part.reduce((n, r) => n + (r.gc || 0), 0).toFixed(1), fogMissPerVisTick: +mean(vr.map((r) => r['#fogCacheMiss'] || 0)).toFixed(1), sysMean: sys,
      visTick: q(vr.map((r) => r['sys:visibility'])), revealTick: q(vr.map((r) => r['vis.reveal'] || 0)), siteWireTick: q(vr.map((r) => r.siteWire || 0)),
      remStructTick: q(vr.map((r) => r['vis.rememberStructures'] || 0)),
      routeMsPerTick: +mean(part.map((r) => r['nav.route'] || 0)).toFixed(3), routeCalls: part.reduce((n, r) => n + (r['#nav.route'] || 0), 0),
      snapBuild: q(part.filter((r) => r['snap.build'] != null).map((r) => r['snap.build'])), snapBytes: q(part.filter((r) => r.snapBytes != null).map((r) => r.snapBytes)),
      snapEnc: q(part.filter((r) => r['snap.encode+stringify'] != null).map((r) => r['snap.encode+stringify'])),
      units: part.at(-1).units, buildings: part.at(-1).buildings, projectiles: q(part.map((r) => r.projectiles)).max });
  }
  const final = { units: g.units.size, buildings: g.buildings.size, ...counts(g, viewer), over: !!g.over, time: Math.round(g.time) };
  // scheduler's own ring metrics for comparison with production /api/metrics
  parentPort.postMessage({ key: job.key, desc: job.desc, kind: job.kind, map: job.map, size: job.size, players: job.players, seed: job.seed, deep: job.deep, node: process.version,
    ticks: rows.length, spawned: job.spawned, summary, callTotals, windows, probes: probes.map(round3), saves, final, schedMetrics: g.sched.metrics() });

  function counts(game, civ) {
    const m = process.memoryUsage();
    let impacts = 0; for (const l of game.impacts.values()) impacts += l.length;
    return { heapMb: Math.round(m.heapUsed / 1048576), events: game.events.length, eventSeq: game.eventSeq,
      craters: game.craters.size, wrecks: game.wrecks.size, smoke: game.smoke.size, intensity: game.intensity.size, impacts, scorch: game.scorch.size, wear: game.wear.size, scars: game.scars.size,
      fieldPos: game.fieldPos.size, fieldworks: game.fieldworks?.size || 0, bfMemory: civ.battlefieldMemory?.size || 0, seenB: civ.seenB?.size || 0,
      fogCache: game.fogCache.size, engagements: game.engagements.size, reports: game.reports.length, roadProjects: game.roadProjects.length,
      ruins: game.ruins.size, caches: game.materialCaches.size, siteIntel: civ.siteIntel.size, cacheIntel: civ.cacheIntel.size, log: game.log.length,
      convoys: game.convoys?.size || 0, deploysDone: game.deploysDone?.size || 0, aliveCivs: game.civs.filter((c) => c.alive).length };
  }
}

function q(a) {
  if (!a.length) return { n: 0 };
  const s = Float64Array.from(a).sort();
  const at = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
  return { n: s.length, mean: +mean(a).toFixed(3), p50: at(.5), p95: at(.95), p99: at(.99), max: +s[s.length - 1].toFixed(3) };
}
function mean(a) { let t = 0; for (const x of a) t += x; return a.length ? t / a.length : 0; }
function round3(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = typeof v === 'number' ? +v.toFixed(3) : v; return r; }
