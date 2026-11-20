// Scale bench (SCALE Phase 1, 2026-11-20): an 8-civ free-for-all at N units per civ (default 8 x 1,000 = 8,000) and
// ~B buildings (default 4,000: every claimable site's headquarters and facilities, the rest field defences, barricades
// and posts), moving and fighting continuously on several fronts, with the live worker's per-interval work:
//   * one tick per 100 ms interval (speed 1), every scheduler system timed, route() time attributed to the system that
//     called it (scheduler.current);
//   * 5 Hz snapshots for 8 fog-of-war players + 1 god-view spectator, each keyed-delta encoded (deltaEncoder, the
//     'udelta' + 'econ-delta-v1' path the Unity client negotiates) and JSON.stringified, econ every 10 intervals;
//   * permessage-deflate cost per message (main thread in production; level 6, no context takeover = upper bound);
//   * autosave serialize + stringify every 60 game-seconds;
//   * optionally the real telemetry probe (--probe), whose spans and per-minute rows are reported as well.
// The orders are scripted (sandbox: no AI planning, no victory) so every size runs the same kind of fight: each civ
// splits its army into groups of ~40 (attack-move to the fronts with both neighbours, deep strikes on a far enemy base,
// home guards), idle groups get a new order every few seconds, losses are topped up at home every 15 s and sent to a
// front, destroyed buildings are rebuilt every 30 s. AI planning load is measured separately with --ai (AI civs).
// Runs in a worker_thread with the production resource limits by default (--inproc to stay on the main thread).
//
// Usage: node [--cpu-prof --cpu-prof-dir=D:/...] tools/scale-bench.mjs [--per=1000] [--civs=8] [--buildings=4000]
//          [--size=256] [--seconds=60] [--warm=15] [--seed=3] [--deflate=1] [--probe] [--ai] [--inproc] [--root=tree] [--out=file.json]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { PerformanceObserver } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const flags = isMainThread
  ? Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }))
  : workerData.flags;

if (isMainThread && !flags.inproc) {
  const size = Number(flags.size || 256);
  const w = new Worker(SELF, { workerData: { flags }, resourceLimits: { maxOldGenerationSizeMb: Number(flags.heap || (size >= 256 ? 1024 : 512)) } });
  w.on('message', (m) => { if (m.log) process.stderr.write(m.log); if (m.result) { console.log(JSON.stringify(m.result.summary)); if (flags.out) fs.writeFileSync(String(flags.out), JSON.stringify(m.result, null, 1)); } });
  w.on('error', (e) => { console.error('worker error', e); process.exitCode = 1; });
  w.on('exit', (c) => { if (c) { console.error('worker exit', c); process.exitCode = c; } });
} else {
  await run();
}

async function run() {
  const log = (s) => (isMainThread ? process.stderr.write(s) : parentPort.postMessage({ log: s }));
  const SIZE = Number(flags.size || 256);
  globalThis.SE_MAP_SIZE = SIZE; globalThis.SE_WRAP = false;
  // --root=<dir>: measure another copy of the tree (a frozen snapshot while other work edits this one)
  const ROOT = flags.root ? pathToFileURL(String(flags.root).replace(/[\/]?$/, '/')).href : new URL('../', import.meta.url).href;
  const SIM = ROOT + 'server/sim/', SERVER = ROOT + 'server/';
  const { ActionGame } = await import(SIM + 'actionGame.js');
  const { serializeGame } = await import(SIM + 'persist.js');
  const { ACTION_UNITS, ACTION_BUILDINGS } = await import(SIM + 'actionDefinitions.js');
  const { addFacility } = await import(SIM + 'actionBases.js');
  const { tileAt, centerOf, distance } = await import(SIM + 'actionNavigation.js');
  const { isWater, N } = await import(SIM + 'constants.js');
  const { deltaEncoder } = await import(SERVER + 'delta.js');

  const CIVS = Number(flags.civs || 8), PER = Number(flags.per || 1000), BLD = Number(flags.buildings ?? 4000);
  const seed = Number(flags.seed ?? 3), SECONDS = Number(flags.seconds || 60), WARM = Number(flags.warm ?? 15);
  const AI = !!flags.ai;
  const now = () => performance.now();
  const P = ['warlord', 'merchant', 'builder'];
  const slots = Array.from({ length: CIVS }, (_, i) => AI ? { human: false, difficulty: 'brutal', personality: P[(i + seed) % 3] } : { human: true });
  const tg = now();
  const g = new ActionGame({ id: 'scale-' + seed, seed, style: 'pangaea', teamSize: 1, startRes: 'max', armyLimit: Math.max(1600, PER + 200), slots });
  const genMs = now() - tg;
  if (!AI) g.sandbox = true;
  g.adaptive = false;
  g.tick(); g.outbox.length = 0;
  let rs = seed * 9301 + 49297;
  const rnd = () => ((rs = (rs * 233280 + 49297) % 2147483647) / 2147483647);

  // ------------------------------------------------------------------------------------------------ setup: bases
  const ts = now();
  const homes = g.civs.map((c) => g.sites[c.id]);
  const cx = homes.reduce((a, h) => a + h.x, 0) / CIVS, cz = homes.reduce((a, h) => a + h.z, 0) / CIVS;
  const ring = g.civs.map((c) => c.id).sort((a, b) => Math.atan2(homes[a].z - cz, homes[a].x - cx) - Math.atan2(homes[b].z - cz, homes[b].x - cx));
  const nbr = (id, d) => ring[(ring.indexOf(id) + d + CIVS) % CIVS];
  const nearestCiv = (p) => { let best = 0, bd = Infinity; for (const c of g.civs) { const d = distance(p, homes[c.id]); if (d < bd) { bd = d; best = c.id; } } return best; };
  // every claimable site goes to the nearest civ: headquarters + all eight facility parcels
  const FAC = ['depot', 'power_plant', 'barracks', 'motor_works', 'heavy_weapons', 'airfield', 'advanced_lab', 'depot'];
  let facilities = 0;
  for (const site of g.sites) {
    if (!site.slots || facilities >= BLD) continue;
    const civ = g.civs[site.owner >= 0 ? site.owner : nearestCiv(site)];
    site.owner = civ.id; site.tier = 3;
    if (!site.hq) { addFacility(g, civ, site, 'town', site.tile, { instant: true }); facilities++; }
    let k = 0;
    const used = new Set([...g.buildings.values()].filter((b) => b.site === site.id).map((b) => b.slot));
    for (const p of site.parcels) {
      if (!p.id || used.has(p.id) || facilities >= BLD) continue;
      addFacility(g, civ, site, FAC[k++ % FAC.length], p.id, { instant: true }); facilities++;   // facility parcels are addressed by parcel id
    }
  }
  // field structures: per civ, spread over its side of the map (rings 4..R around home and its sites), weighted
  // towards the fronts; tiles must be land, standable for a tank and not reserved by a site
  const FIELD = [['barricade', 25], ['guard_post', 15], ['bunker', 12], ['turret', 12], ['city_turret', 10], ['aa_battery', 6], ['sensor_post', 6], ['repair_point', 5], ['artillery_post', 5], ['fort', 4]];
  const fieldPick = () => { let r = rnd() * 100; for (const [t, w] of FIELD) { if ((r -= w) < 0) return t; } return 'barricade'; };
  const tank = ACTION_UNITS.tank;
  const free = (t) => t >= 0 && t < N && !isWater(g.world.terr[t]) && g.tileB[t] < 0 && !g.reservedTiles.has(t);   // neighbours of a building may hold another (dense bases); canStand below keeps footprints apart
  const placeField = (civ, centre, rMin, rMax) => {
    for (let tries = 0; tries < 60; tries++) {
      const a = rnd() * Math.PI * 2, r = rMin + rnd() * (rMax - rMin);
      const p = { x: centre.x + Math.sin(a) * r, z: centre.z + Math.cos(a) * r };
      const t = tileAt(p.x, p.z);
      if (!free(t)) continue;
      const c = centerOf(t), pt = { x: c.x, z: c.z, yaw: rnd() * 6.28 };
      if (!g.nav.canStand(pt.x, pt.z, tank)) continue;
      if (nearestCiv(pt) !== civ.id) continue;
      addFacility(g, civ, null, fieldPick(), t, { instant: true, point: pt });
      return true;
    }
    return false;
  };
  const fieldTarget = () => Math.max(0, BLD - g.buildings.size);
  const spread = Math.max(14, Math.min(70, Math.sqrt(BLD / CIVS) * 2.6));
  let civTurn = 0, misses = 0;
  const civSites = g.civs.map((c) => g.sites.filter((s) => s.owner === c.id));
  while (fieldTarget() > 0 && misses < 40000) {
    const civ = g.civs[ring[civTurn++ % CIVS]];
    const r = rnd(), own = civSites[civ.id];
    const centre = r < .45 ? homes[civ.id] : r < .75 && own.length ? own[Math.floor(rnd() * own.length)] : g.lerpPoint(homes[civ.id], homes[nbr(civ.id, rnd() < .5 ? 1 : -1)], .15 + rnd() * .3);
    if (!placeField(civ, centre, 2, spread * (1 + misses / 8000))) misses++;
  }
  const buildPlaced = g.buildings.size;
  const bldMs = now() - ts;

  // ------------------------------------------------------------------------------------------------ setup: armies
  const MIX = ['rifle_squad', 'rifle_squad', 'rifle_squad', 'tank', 'armored_car', 'mortar_team', 'anti_armor', 'mech_infantry', 'militia', 'rifle_squad',
    'field_gun', 'scout_buggy', 'sp_artillery', 'air_defense', 'engineer', 'exo_infantry', 'special_forces', 'rifle_squad', 'tank', 'mech_infantry',
    'helicopter', 'rifle_squad', 'tank', 'supply_truck', 'fighter'];
  const groups = [];          // { civ, ids:Set, role, next }
  const spawnAround = (civ, centre, n, radius0 = 2) => {
    const ids = [];
    for (let r = radius0, k = 0; ids.length < n && r < radius0 + 40; r += .55) {
      const m = Math.max(6, Math.floor(r * 2 * Math.PI / .55));
      for (let i = 0; i < m && ids.length < n; i++, k++) {
        const a = i / m * Math.PI * 2 + r, p = { x: centre.x + Math.sin(a) * r, z: centre.z + Math.cos(a) * r };
        const t = tileAt(p.x, p.z);
        if (t < 0 || isWater(g.world.terr[t])) continue;
        const type = MIX[(ids.length * 7 + civ.id + k) % MIX.length];
        if (!ACTION_UNITS[type].air && !g.nav.canStand(p.x, p.z, ACTION_UNITS[type])) continue;
        const u = g.spawn(civ, type, p, 0);
        if (!u) continue;
        u.stance = 'aggressive';
        ids.push(u.id);
      }
    }
    return ids;
  };
  const owned = (civ) => { let n = 0; for (const u of g.units.values()) if (u.owner === civ.id && !u.auto) n++; return n; };
  const frontPoint = (civ, role) => {
    const h = homes[civ.id];
    if (role === 'guard') return g.lerpPoint(h, homes[nbr(civ.id, rnd() < .5 ? 1 : -1)], .1 + rnd() * .1);
    if (role === 'strike') { const e = homes[nbr(civ.id, 2 + Math.floor(rnd() * (CIVS - 3)))]; return g.lerpPoint(h, e, .75 + rnd() * .2); }
    const e = homes[nbr(civ.id, role === 'left' ? -1 : 1)];
    return g.lerpPoint(h, e, .4 + rnd() * .25);
  };
  const snapPoint = (p) => g.nav.nearest({ x: p.x + (rnd() - .5) * 10, z: p.z + (rnd() - .5) * 10 }, tank, 4) || g.nav.nearest(p, tank, 6) || p;
  const ROLES = ['left', 'right', 'left', 'right', 'left', 'right', 'left', 'right', 'strike', 'guard'];
  const order = (grp) => {
    const civ = g.civs[grp.civ];
    if (!civ.alive) return;
    const ids = [...grp.ids].filter((id) => g.units.has(id));
    grp.ids = new Set(ids);
    if (!ids.length) return;
    const p = snapPoint(frontPoint(civ, grp.role));
    g.command(civ.id, { c: 'move', units: ids, point: { x: p.x, z: p.z }, attackMove: true });
    grp.orders++;
  };
  const mkGroups = (civ, ids) => {
    for (let i = 0; i < ids.length; i += 40) {
      const grp = { civ: civ.id, ids: new Set(ids.slice(i, i + 40)), role: ROLES[(groups.length + civ.id) % ROLES.length], next: 0, orders: 0 };
      groups.push(grp);
    }
  };
  const tu = now();
  for (const civ of g.civs) {
    const h = homes[civ.id];
    // five muster areas around and in front of home
    const per = PER - owned(civ);
    for (let k = 0; k < 5; k++) {
      const toward = homes[nbr(civ.id, k % 2 ? 1 : -1)];
      const c = g.lerpPoint(h, toward, .06 + k * .03);
      mkGroups(civ, spawnAround(civ, { x: c.x + (k - 2) * 3, z: c.z + (k - 2) * 2 }, Math.ceil(per / 5), 1.5));
    }
  }

  for (const c of g.civs) c.explored.fill(1);
  const unitMs = now() - tu;
  const to = now();
  for (const grp of groups) order(grp);
  const firstOrdersMs = now() - to;
  log(`setup: map ${SIZE} gen ${genMs | 0} ms, ${buildPlaced} buildings (${facilities} facilities) ${bldMs | 0} ms, ${g.units.size} units ${unitMs | 0} ms, ${groups.length} groups first orders ${firstOrdersMs | 0} ms\n`);

  // scripted pressure: idle or shrunken groups get a new order (staggered), losses topped up, buildings rebuilt
  let reinforced = 0, rebuilt = 0, orders = 0;
  function scenarioStep(i) {
    if (AI) return;
    const gi = i % 10;
    for (let k = gi; k < groups.length; k += 10) {
      const grp = groups[k];
      if (g.time < grp.next) continue;
      let idle = 0, alive = 0;
      for (const id of grp.ids) { const u = g.units.get(id); if (!u) continue; alive++; if (!u.goal && !u.target) idle++; }
      if (!alive) continue;
      if (idle * 2 >= alive || g.time - grp.next > 40) { order(grp); orders++; grp.next = g.time + 6 + rnd() * 6; }
      else grp.next = g.time + 3;
    }
    if (i % 150 === 75) for (const civ of g.civs) {
      if (!civ.alive) continue;
      const miss = PER - owned(civ);
      if (miss < 20) continue;
      const ids = spawnAround(civ, homes[civ.id], miss, 2.2);
      reinforced += ids.length;
      const start = groups.length; mkGroups(civ, ids);
      for (let k = start; k < groups.length; k++) { groups[k].role = ROLES[k % 8]; order(groups[k]); }
    }
    if (i % 300 === 150) {
      let n = fieldTarget(), m = 0;
      while (n > 0 && m < 400) { const civ = g.civs[ring[m % CIVS]]; if (civ.alive && placeField(civ, homes[civ.id], 3, spread)) { n--; rebuilt++; } m++; }
    }
    if (i % 600 === 0) for (let k = groups.length - 1; k >= 0; k--) if (![...groups[k].ids].some((id) => g.units.has(id))) groups.splice(k, 1);
  }

  // ------------------------------------------------------------------------------------------------ viewers
  for (const c of g.civs) c.connected = true;
  g.setObserver({ connected: true });
  const encoders = new Map();
  for (const c of g.civs) encoders.set(c.id, deltaEncoder(50, 10, { keyed: true }));
  encoders.set(-2, deltaEncoder(50, 10, { keyed: true }));

  // ------------------------------------------------------------------------------------------------ instrumentation
  const sys = new Map(), routeBy = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const t of g.sched.tasks) { const fn = t.fn; t.fn = (ctx, n) => { const a = now(); try { return fn(ctx, n); } finally { add(sys, t.name, now() - a); } }; }
  let routeN = 0, routeFail = 0;
  { const nav = g.nav, orig = nav.route;
    nav.route = function (...a) { const t = now(); const r = orig.apply(this, a); const ms = now() - t; routeN++; if (!r) routeFail++; add(routeBy, g.sched.current || 'outside', ms); return r; }; }
  let probe = null; const probeRows = [];
  if (flags.probe) {
    const { createProbe } = await import(SERVER + 'telemetry/probe.js');
    probe = createProbe(g, { post: (m) => probeRows.push(m), units: ACTION_UNITS, buildings: ACTION_BUILDINGS, centerOf, minuteMs: 1e12 });
  }
  const gc = { n: 0, ms: 0, max: 0 };
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { gc.n++; gc.ms += e.duration; if (e.duration > gc.max) gc.max = e.duration; } });
  obs.observe({ entryTypes: ['gc'] });

  // named so the CPU profile attributes them
  function buildSnapshots(econ) { return g.snapshots(null, econ, null); }
  function encodeDelta(list) { return list.map(([id, m]) => [id, encoders.get(id) ? encoders.get(id)(m) : m, !!m.econ]); }
  function stringifyMsgs(list) { return list.map(([id, m, econ]) => [id, JSON.stringify(m), econ]); }
  function deflateMsgs(list) { const r = []; for (const [, s] of list) r.push(s.length > 1024 ? zlib.deflateRawSync(s).length : s.length); return r; }
  function autosave() { return JSON.stringify(serializeGame(g)).length; }

  // ------------------------------------------------------------------------------------------------ run
  const total = Math.round((WARM + SECONDS) * 10), warmN = Math.round(WARM * 10);
  const acc = { tick: 0, snapBuild: 0, snapDelta: 0, snapStr: 0, deflate: 0, save: 0, saves: 0, saveBytes: 0, interval: 0, scenario: 0 };
  const intervals = [], tickMs = [], unitsSeen = [], msgs = { snap: { player: [], spec: [] }, econ: { player: [], spec: [] } }, wire = { player: 0, spec: 0, raw: 0 };
  let heapPeak = 0, rssPeak = 0;
  const reset = () => { sys.clear(); routeBy.clear(); routeN = 0; routeFail = 0; gc.n = gc.ms = gc.max = 0; for (const k in acc) acc[k] = 0; intervals.length = tickMs.length = 0; for (const k of ['snap', 'econ']) msgs[k].player.length = msgs[k].spec.length = 0; wire.player = wire.spec = wire.raw = 0; };
  let cpu0 = process.threadCpuUsage(), wall0 = now();
  for (let i = 1; i <= total; i++) {
    if (i === warmN + 1) { if (probe) { probe.minute(); probe.flush(); probeRows.length = 0; } reset(); cpu0 = process.threadCpuUsage(); wall0 = now(); }
    const i0 = now();
    let a = now(); scenarioStep(i); acc.scenario += now() - a;
    const t0 = now();
    g.tick();
    const tm = now() - t0; tickMs.push(tm); acc.tick += tm;
    probe?.interval(tm, 1, false);
    g.outbox.length = 0;
    if (i % 2 === 0) {
      a = now(); const raw = buildSnapshots(i % 10 === 0); const b = now() - a; acc.snapBuild += b; probe?.span('snapshot.build', b);
      a = now(); const enc = encodeDelta(raw); acc.snapDelta += now() - a;
      a = now(); const strs = stringifyMsgs(enc); acc.snapStr += now() - a;
      for (const [id, s, econ] of strs) (econ ? msgs.econ : msgs.snap)[id === -2 ? 'spec' : 'player'].push(s.length);
      if (flags.deflate !== '0') {
        a = now(); const d = deflateMsgs(strs); acc.deflate += now() - a;
        strs.forEach(([id], k) => { wire[id === -2 ? 'spec' : 'player'] += d[k]; wire.raw += strs[k][1].length; });
      }
      probe?.snapshot(now() - a);
    }
    if (i % 600 === 0) { a = now(); acc.saveBytes = autosave(); acc.save += now() - a; acc.saves++; }
    if (probe && i % 10 === 0) probe.second();
    const iv = now() - i0; intervals.push(iv); acc.interval += iv;
    if (i % 10 === 0) await new Promise((r) => setImmediate(r));   // the worker yields between intervals (GC observer, probe timers)
    if (i % 10 === 0) { const m = process.memoryUsage(); heapPeak = Math.max(heapPeak, m.heapUsed); rssPeak = Math.max(rssPeak, m.rss); unitsSeen.push(g.units.size); }
    if (i % 100 === 0) {
      const n = intervals.length || 1;
      log(`t ${(g.time).toFixed(0)}s units ${g.units.size} bld ${g.buildings.size} | interval mean ${(acc.interval / n).toFixed(0)} ms tick ${(acc.tick / n).toFixed(0)} snap ${((acc.snapBuild + acc.snapDelta + acc.snapStr) / n).toFixed(0)} deflate ${(acc.deflate / n).toFixed(0)} | heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB${i <= warmN ? ' (warm-up)' : ''}\n`);
    }
  }
  const cpu = process.threadCpuUsage(cpu0), wallS = (now() - wall0) / 1000;
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  if (probe) { probe.minute(); probe.flush(); }

  // what the messages are made of: one more econ round, encoded as the viewers' encoders would (KB per top-level field)
  const breakdown = {};
  for (const [id, m] of g.snapshots(null, true, null)) {
    if (id !== ring[0] && id !== -2) continue;
    const e = encoders.get(id)(m), f = {};
    for (const [k, v] of Object.entries(e)) f[k] = +(JSON.stringify(v ?? null).length / 1024).toFixed(1);
    const top = Object.entries(f).sort((x, y) => y[1] - x[1]).slice(0, 10);
    breakdown[id === -2 ? 'spectator' : 'player'] = { units: m.units?.length, paths: m.paths ? Object.keys(m.paths).length : 0, buildings: m.buildings?.length, fieldsKB: Object.fromEntries(top) };
  }
  // ------------------------------------------------------------------------------------------------ report
  const n = intervals.length;
  const sorted = (a) => Float64Array.from(a).sort();
  const q = (s, p) => s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : 0;
  const stats = (a) => { const s = sorted(a); return { mean: +(a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(1), p50: q(s, .5), p95: q(s, .95), p99: q(s, .99), max: q(s, 1) }; };
  const per = (ms) => +(ms / n).toFixed(2);   // ms per interval (= per tick at speed 1)
  const routeIn = Object.fromEntries([...routeBy].map(([k, v]) => [k, per(v)]));
  const sysPer = Object.fromEntries([...sys].sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, per(v)]));
  const own = (name) => per((sys.get(name) || 0) - (routeBy.get(name) || 0));
  const kb = (a) => { const s = stats(a); return { mean: +(s.mean / 1024).toFixed(1), p95: +(s.p95 / 1024).toFixed(1), max: +(s.max / 1024).toFixed(1), n: a.length }; };
  const secs = n / 10, viewers = CIVS;
  const intervalStats = stats(intervals);
  const summary = {
    config: { civs: CIVS, per: PER, buildingsTarget: BLD, size: SIZE, seed, seconds: SECONDS, warm: WARM, ai: AI, worker: !isMainThread, node: process.version },
    setup: { genMs: Math.round(genMs), buildings: buildPlaced, facilities, unitsAtStart: unitsSeen[0] ?? g.units.size, groups: groups.length, firstOrdersMs: Math.round(firstOrdersMs) },
    end: { units: g.units.size, buildings: g.buildings.size, projectiles: g.projectiles?.size ?? null, unitsMean: Math.round(unitsSeen.slice(-SECONDS).reduce((x, y) => x + y, 0) / Math.max(1, Math.min(SECONDS, unitsSeen.length))), reinforced, rebuilt, orders, wrecks: g.wrecks?.size },
    pace: { intervalMs: intervalStats, tickMs: stats(tickMs), ticksPerSecond: +Math.min(10, 1000 / intervalStats.mean).toFixed(2), simSpeed: +Math.min(1, 100 / intervalStats.mean).toFixed(2), over100: intervals.filter((x) => x > 100).length / n, cpuS: +((cpu.user + cpu.system) / 1e6).toFixed(1), wallS: +wallS.toFixed(1) },
    msPerTick: {
      path: per([...routeBy.values()].reduce((x, y) => x + y, 0)), routeBy: routeIn, routes: routeN, routeFails: routeFail, routesPerTick: +(routeN / n).toFixed(1),
      unitMotion: own('navigation'), combat: own('combat'), visibility: own('visibility'), fieldEconomy: own('field economy'), ai: own('ai'), production: own('production'),
      capture: own('capture'), garrison: own('garrison'), warzone: own('warzone'), other: per(['income', 'weather', 'victory', 'horde'].reduce((x, k) => x + (sys.get(k) || 0), 0)),
      systems: sysPer,
      snapBuild: per(acc.snapBuild), snapDelta: per(acc.snapDelta), snapStringify: per(acc.snapStr), deflateMainThread: per(acc.deflate), autosave: per(acc.save), scenarioScript: per(acc.scenario),
      gc: per(gc.ms), gcMax: +gc.max.toFixed(1), gcCount: gc.n,
    },
    memory: { heapPeakMb: Math.round(heapPeak / 1048576), rssPeakMb: Math.round(rssPeak / 1048576), autosaveKB: Math.round(acc.saveBytes / 1024) },
    messages: {
      snapPlayerKB: kb(msgs.snap.player), econPlayerKB: kb(msgs.econ.player), snapSpectatorKB: kb(msgs.snap.spec), econSpectatorKB: kb(msgs.econ.spec),
      perPlayerKBps: +((msgs.snap.player.reduce((x, y) => x + y, 0) + msgs.econ.player.reduce((x, y) => x + y, 0)) / viewers / secs / 1024).toFixed(1),
      perPlayerWireKBps: +(wire.player / viewers / secs / 1024).toFixed(1), spectatorKBps: +((msgs.snap.spec.reduce((x, y) => x + y, 0) + msgs.econ.spec.reduce((x, y) => x + y, 0)) / secs / 1024).toFixed(1),
      spectatorWireKBps: +(wire.spec / secs / 1024).toFixed(1), deflateRatio: wire.raw ? +((wire.player + wire.spec) / ((msgs.snap.player.concat(msgs.snap.spec, msgs.econ.player, msgs.econ.spec)).reduce((x, y) => x + y, 0))).toFixed(3) : null,
    },
  };
  const probeSpans = probeRows.flatMap((m) => (m.rows || []).filter(([t]) => t === 'server_match_minute').map(([, r]) => ({ subsystems: r.subsystems, routes_by_caller: r.routes_by_caller, route_ms_p95: r.route_ms_p95, route_fail_reasons: r.route_fail_reasons })));
  summary.messages.breakdown = breakdown;
  { const t = now(); const bytes = autosave(); summary.memory.autosaveKB = Math.round(bytes / 1024); summary.memory.autosaveMs = Math.round(now() - t); }   // one save at the end (serialize + stringify, tick thread)
  const result = { summary, probe: probeSpans };
  if (isMainThread) { console.log(JSON.stringify(summary)); if (flags.out) fs.writeFileSync(String(flags.out), JSON.stringify(result, null, 1)); }
  else parentPort.postMessage({ result });
}
