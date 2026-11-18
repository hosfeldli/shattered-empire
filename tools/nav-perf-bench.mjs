// Navigation / movement performance bench for the live action-RTS server (ActionGame).
// Every scenario runs in its own child process (the map size is a module-level constant), sequentially,
// so timings are not skewed by sibling workers. Instrumentation is installed by wrapping
// ActionNavigation / MinHeap prototypes and the scheduler tasks from this script; no source is edited.
//
// Usage: node tools/nav-perf-bench.mjs [scenarios=all|a,b] [--sizes=50,100,250,500,1000] [--seed=7]
//          [--map=crossroads] [--minutes=40] [--players=4] [--ticks=N] [--plain] [--prof] [--tag=name] [--out=dir]
// Scenarios: idle, longMove, repeat, converge, unreachable, baseJam, passage, deform, combat, aiMatch
//   aiMatch: AI-only match (4 AI on --map, --minutes game minutes); the production-like reproduction.
//   --plain: no fine-grained wrappers (scheduler task timing only) to measure undisturbed tick cost.
//   --prof: also writes a V8 .cpuprofile per scenario into <out>/profiles/ (D: only).
// Output: one JSON per run in docs/performance/data/ (median/p95/p99/max per metric).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const SIM = new URL('../server/sim/', import.meta.url).href;

const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));

if (flags.child) await child(JSON.parse(Buffer.from(flags.child, 'base64').toString()));
else await parent();

// ---------------------------------------------------------------- parent: schedule child processes
async function parent() {
  const ALL = ['idle', 'longMove', 'repeat', 'converge', 'unreachable', 'baseJam', 'passage', 'deform', 'combat'];
  const pos = argv.filter((a) => !a.startsWith('--'));
  const scenarios = !pos[0] || pos[0] === 'all' ? ALL : pos[0].split(',');
  const sizes = String(flags.sizes || '50,100,250,500,1000').split(',').map(Number);
  const seed = Number(flags.seed ?? 7);
  const outDir = path.resolve(ROOT, flags.out || 'docs/performance/data');
  fs.mkdirSync(outDir, { recursive: true });
  const { MAP_CATALOG } = await import(SIM + 'mapCatalog.js');
  const jobs = [];
  for (const sc of scenarios) {
    const mapId = sc === 'passage' ? flags.passageMap || 'fortress_pass' : sc === 'unreachable' ? flags.islandMap || 'stepping_stones' : flags.map || 'crossroads';
    const def = MAP_CATALOG.find((m) => m.id === mapId);
    if (!def) throw new Error('unknown map ' + mapId);
    const list = sc === 'aiMatch' ? [0] : sizes;
    for (const n of list) jobs.push({ scenario: sc, n, seed, map: mapId, size: def.size, players: sc === 'aiMatch' ? Number(flags.players || def.players) : def.players,
      minutes: Number(flags.minutes || 40), ticks: flags.ticks ? Number(flags.ticks) : null, plain: !!flags.plain, sim: SIM });
  }
  const results = [];
  for (const job of jobs) {
    const execArgv = ['--max-old-space-size=4096'];
    if (flags.prof) { const dir = path.join(outDir, 'profiles'); fs.mkdirSync(dir, { recursive: true }); execArgv.push('--cpu-prof', `--cpu-prof-dir=${dir}`, `--cpu-prof-name=${job.scenario}-${job.n}-${job.map}${job.plain ? '-plain' : ''}.cpuprofile`); }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [...execArgv, SELF, '--child=' + Buffer.from(JSON.stringify(job)).toString('base64')],
      { env: { ...process.env, SE_MAP_SIZE: String(job.size) }, maxBuffer: 1 << 28, encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).at(-1);
    let res;
    try { res = JSON.parse(line); } catch { res = { ...job, error: (r.stderr || '').slice(-2000) || 'no output' }; }
    res.wallSeconds = Math.round((Date.now() - t0) / 100) / 10;
    results.push(res);
    const h = res.headline || {};
    console.error(`${job.scenario} n=${job.n} ${job.map}: ${res.error ? 'ERROR ' + String(res.error).split('\n')[0] : `units ${h.units} nav p50/p95/p99/max ${h.navP50}/${h.navP95}/${h.navP99}/${h.navMax} ms, route ${h.routePerSec}/s, arrived ${h.arrivedPct ?? '-'}%, cmd ${h.commandMs ?? '-'} ms`} (${res.wallSeconds}s)`);
  }
  const tag = flags.tag || scenarios.join('+').slice(0, 60);
  const file = path.join(outDir, `nav-perf-${tag}${flags.plain ? '-plain' : ''}-seed${seed}.json`);
  fs.writeFileSync(file, JSON.stringify({ generated: new Date().toISOString(), node: process.version, seed, flags, results }, null, 1));
  console.error('wrote ' + file);
}

// ---------------------------------------------------------------- child: one scenario
async function child(job) {
  globalThis.SE_MAP_SIZE = job.size; globalThis.SE_WRAP = false;
  const { ActionGame } = await import(job.sim + 'actionGame.js');
  const { ActionNavigation, tileAt, distance, centerOf, wrapX } = await import(job.sim + 'actionNavigation.js');
  const { MinHeap } = await import(job.sim + 'world.js');
  const { ACTION_UNITS } = await import(job.sim + 'actionDefinitions.js');
  const { addFacility } = await import(job.sim + 'actionBases.js');
  const { NB } = await import(job.sim + 'hex.js');
  const now = () => performance.now();

  // ---- instrumentation state
  const S = {
    phase: 'setup', ctx: [],
    fn: {},                 // name -> { calls, ms, byPhase: { phase: { calls, ms } } }
    pops: {},               // MinHeap pops by enclosing search
    routeNull: 0, routeNullByPhase: {}, strategicNull: 0, strategicCalls: 0, corridorHit: 0, flowUse: 0, localNull: 0,
    flowBuilds: 0, flowBuildPops: 0, flowReuse: 0,
    invalidations: 0, invalidateBy: {}, rebuild: { components: { n: 0, ms: 0 }, gradient: { n: 0, ms: 0 } },
    routeBy: {},            // caller function -> { calls, ms, nulls }
    replans: new Map(),     // unit id -> route calls outside command phase
    tick: null,             // per-tick counters (reset each tick)
  };
  const fnStat = (name) => (S.fn[name] ??= { calls: 0, ms: 0, byPhase: {} });
  const depth = {};
  const P = ActionNavigation.prototype;
  function timed(name, after) {
    const orig = P[name];
    P[name] = function (...args) {
      const st = fnStat(name), top = !depth[name];
      depth[name] = (depth[name] || 0) + 1; S.ctx.push(name);
      const a = top ? now() : 0;
      let r;
      try { r = orig.apply(this, args); } finally {
        depth[name]--; S.ctx.pop();
        st.calls++;
        if (top) {
          const ms = now() - a; st.ms += ms;
          const bp = st.byPhase[S.phase] ??= { calls: 0, ms: 0 }; bp.calls++; bp.ms += ms;
          if (S.tick) { S.tick[name + 'Ms'] = (S.tick[name + 'Ms'] || 0) + ms; S.tick[name] = (S.tick[name] || 0) + 1; }
          if (after) after.call(this, r, args, ms);
        }
      }
      return r;
    };
  }
  function counted(obj, name, label = name) {
    const orig = obj[name];
    obj[name] = function (...args) { const st = fnStat(label); st.calls++; if (S.tick) S.tick[label] = (S.tick[label] || 0) + 1; return orig.apply(this, args); };
  }
  if (!job.plain) {
    const pop = MinHeap.prototype.pop;
    MinHeap.prototype.pop = function () { const k = S.ctx.at(-1) || 'other'; S.pops[k] = (S.pops[k] || 0) + 1; if (S.tick && k !== 'other') S.tick['pops_' + k] = (S.tick['pops_' + k] || 0) + 1; return pop.call(this); };
    // strategic: cache hits before the call (same key / flow conditions as actionNavigation.strategic)
    const strategic = P.strategic;
    P.strategic = function (from, to, def, buildingRoads = false, skipFlow = false, limit) {
      if (depth.strategic === 1) {   // outermost call (timed() wraps this and has already entered)
        S.strategicCalls++;
        const flow = !buildingRoads && !skipFlow && this.activeFlows.get(def.move);
        if (flow && flow.next[from] >= 0) S.flowUse++;
        else if (!buildingRoads && this.corridors.has(`${def.move}:${from}:${to}`)) S.corridorHit++;
      }
      return strategic.call(this, from, to, def, buildingRoads, skipFlow, limit);
    };
    timed('strategic', function (r) { if (!r) S.strategicNull++; });
    timed('route', function (r, args, ms) {
      if (!r) { S.routeNull++; S.routeNullByPhase[S.phase] = (S.routeNullByPhase[S.phase] || 0) + 1; if (S.tick) S.tick.routeNull = (S.tick.routeNull || 0) + 1; }
      const from = args[0];
      if (from?.id && S.phase !== 'command' && S.phase !== 'setup') S.replans.set(from.id, (S.replans.get(from.id) || 0) + 1);
      const by = S.phase + ':' + (S.caller || '?');
      const st = S.routeBy[by] ??= { calls: 0, ms: 0, nulls: 0 };
      st.calls++; st.ms += ms; if (!r) st.nulls++;
    });
    // caller attribution for route: cheap stack frame name
    const routeT = P.route;
    P.route = function (...args) {
      if (!depth.route) {
        const lim = Error.stackTraceLimit; Error.stackTraceLimit = 3;
        const s = new Error().stack.split('\n')[2] || ''; Error.stackTraceLimit = lim;
        S.caller = (s.match(/at (?:[\w.]+\.)?(\w+) \(/) || [])[1] || 'anon';
      }
      return routeT.apply(this, args);
    };
    timed('localRoute', function (r) { if (!r) S.localNull++; });
    const prime = P.primeGroup;
    P.primeGroup = function (group, point) {
      const before = this.flows.size, keys = new Set(this.flows.keys()), p0 = S.pops.primeGroup || 0;
      const r = prime.call(this, group, point);
      for (const k of this.flows.keys()) if (!keys.has(k)) S.flowBuilds++;
      S.flowReuse += this.activeFlows.size - Math.max(0, this.flows.size - before);
      S.flowBuildPops += (S.pops.primeGroup || 0) - p0;
      return r;
    };
    timed('primeGroup');
    for (const n of ['nearest', 'line', 'canMove', 'canStand', 'reachability', 'clearShot', 'beginTraffic']) timed(n);
    for (const n of ['cost', 'obstacleAt', 'roadAt', 'riverAt', 'crowding', 'trafficAllows']) counted(P, n);
    const comp = P.componentOf;
    P.componentOf = function (t, def) {
      const cold = !this.components?.[def.move] && !def.air;
      if (!cold) return comp.call(this, t, def);
      const a = now(); const r = comp.call(this, t, def); S.rebuild.components.n++; S.rebuild.components.ms += now() - a; return r;
    };
    const grad = P.gradientOf;
    P.gradientOf = function (t) {
      if (this.gradient) return grad.call(this, t);
      const a = now(); const r = grad.call(this, t); S.rebuild.gradient.n++; S.rebuild.gradient.ms += now() - a; return r;
    };
    const inv = P.invalidate;
    P.invalidate = function () {
      S.invalidations++; if (S.tick) S.tick.invalidations = (S.tick.invalidations || 0) + 1;
      const lim = Error.stackTraceLimit; Error.stackTraceLimit = 3;
      const s = new Error().stack.split('\n')[2] || ''; Error.stackTraceLimit = lim;
      const by = (s.match(/at (?:[\w.]+\.)?(\w+) \(/) || [])[1] || 'anon';
      S.invalidateBy[by] = (S.invalidateBy[by] || 0) + 1;
      return inv.call(this);
    };
  }

  // ---- game construction
  const ai = job.scenario === 'aiMatch';
  const P4 = ['warlord', 'merchant', 'builder'];
  const slots = Array.from({ length: job.players }, (_, i) => ai ? { human: false, difficulty: 'normal', personality: P4[(i + job.seed) % 3] } : { human: true });
  const g = new ActionGame({ id: 'navbench-' + job.scenario + '-' + job.seed, seed: job.seed, map: job.map, slots });
  if (!ai) g.sandbox = true;   // no AI planning / victory: only our orders move units
  g.tick(); g.outbox.length = 0;   // creates the scheduler
  // map generation is not part of any scenario: start every counter from zero here
  Object.assign(S, { fn: {}, pops: {}, routeNull: 0, routeNullByPhase: {}, strategicNull: 0, strategicCalls: 0, corridorHit: 0, flowUse: 0, localNull: 0, flowBuilds: 0, flowBuildPops: 0, flowReuse: 0, invalidations: 0, invalidateBy: {}, rebuild: { components: { n: 0, ms: 0 }, gradient: { n: 0, ms: 0 } }, routeBy: {} });
  const taskMs = {}, tickRows = [];
  let cur = null;
  for (const t of g.sched.tasks) {
    const f = t.fn;
    t.fn = (ctx, n) => { const prev = S.phase; S.phase = t.name; const a = now(); try { f(ctx, n); } finally { cur[t.name] = now() - a; S.phase = prev; } };
  }
  const tick = () => {
    cur = {}; S.tick = {}; S.phase = 'tick';
    const a = now(); g.tick(); cur.tick = now() - a;
    g.outbox.length = 0;
    S.phase = 'idle';
    const row = { ...cur, ...S.tick };
    S.tick = null;
    return row;
  };
  const command = (civ, cmd) => { const prev = S.phase; S.phase = 'command'; S.tick = S.tick || {}; const a = now(); const r = g.command(civ, cmd); const ms = now() - a; S.phase = prev; return { r, ms }; };

  // ---- placement helpers
  const home = (c) => g.sites.find((s) => s.owner === c && s.hq) || g.sites[c];
  const mapCentre = () => { const m = g.sites.find((s) => s.kind === 'metro'); if (m) return { x: m.x, z: m.z }; let x = 0, z = 0; for (const s of g.sites) { x += s.x; z += s.z; } return { x: x / g.sites.length, z: z / g.sites.length }; };
  const toward = (a, b, d) => { const l = distance(a, b) || 1; return { x: wrapX(a.x + (b.x - a.x) * d / l), z: a.z + (b.z - a.z) * d / l }; };
  const MIX = ['rifle_squad', 'rifle_squad', 'tank', 'armored_car', 'mortar_team', 'rifle_squad', 'anti_armor', 'mech_infantry'];
  function army(civ, centre, n, stance) {
    const ids = [], d0 = ACTION_UNITS.tank;
    for (let ring = 0; ids.length < n && ring < 80; ring++) {
      const pts = ring === 0 ? [[0, 0]] : Array.from({ length: ring * 8 }, (_, k) => { const a = k / (ring * 8) * Math.PI * 2; return [Math.sin(a) * ring * .5, Math.cos(a) * ring * .5]; });
      for (const [dx, dz] of pts) {
        if (ids.length >= n) break;
        const p = { x: wrapX(centre.x + dx), z: centre.z + dz };
        if (tileAt(p.x, p.z) < 0 || !g.nav.canStand(p.x, p.z, d0)) continue;
        const type = MIX[(ids.length + civ) % MIX.length];
        const u = g.spawn(g.civs[civ], type, p, 0);
        if (!u) continue;
        if (stance) u.stance = stance;
        ids.push(u.id);
      }
    }
    return ids;
  }
  const standable = (p, r = 2.5) => g.nav.nearest(p, ACTION_UNITS.tank, r) || p;

  const N = job.n, ticks = job.ticks;
  const rows = [], commands = [], samples = [];
  const states = () => {
    let units = 0, moving = 0, blocked = 0, stalled = 0, ghost = 0, resume = 0, pathPts = 0, ground = 0;
    for (const u of g.units.values()) {
      units++; if (ACTION_UNITS[u.type].air) continue; ground++;
      if (u.goal) { moving++; pathPts += u.path.length; }
      if (u.blocked > 0) blocked++;
      if (u.stall >= 40) stalled++;
      if (u.ghostUntil > g.time) ghost++;
      if (u.tacticalResume) resume++;
    }
    return { t: Math.round(g.time), units, ground, moving, blocked, stalled40: stalled, ghosting: ghost, tacticalResume: resume, meanPathPts: moving ? +(pathPts / moving).toFixed(1) : 0,
      buildings: g.buildings.size, fieldworks: g.fieldworks?.size || 0, wrecks: g.wrecks?.size || 0, roadEdges: g.roads.edges.size, corridors: g.nav.corridors.size, flows: g.nav.flows.size };
  };
  // Why are units blocked? (units with blocked > 12, i.e. on the periodic re-route path in unitMotion)
  const blockedDiag = () => {
    const out = { n: 0, wedged: 0, wreckNear: 0, buildingNear: 0, crowded: 0, nearGoal: 0, enemyNear: 0, longBlocked: 0, idleFriendNear: 0, byMove: {}, blockedTicks: [] };
    for (const u of g.units.values()) {
      const d = ACTION_UNITS[u.type];
      if (d.air || !u.goal || !(u.blocked > 12)) continue;
      out.n++; out.byMove[d.move] = (out.byMove[d.move] || 0) + 1; out.blockedTicks.push(u.blocked);
      if (u.blocked > 60) out.longBlocked++;
      if (!g.nav.canStand(u.x, u.z, d)) out.wedged++;
      if (distance(u, u.goal) < 1.5) out.nearGoal++;
      let wreck = false, bld = false;
      for (const t of [u.tile, ...[0, 1, 2, 3, 4, 5].map((k) => NB[u.tile * 6 + k])]) {
        if (t == null || t < 0) continue;
        if ((g.wrecks.get(t) || []).some((w) => w.x != null && !w.air && distance(w, u) < .45)) wreck = true;
        if (g.obstaclesAtTile(t).some((b) => distance(b, u) < (b.radius || .3) + .5)) bld = true;
      }
      if (wreck) out.wreckNear++; if (bld) out.buildingNear++;
      const near = g.movers.query(u.x, u.z, .55, []).filter((v) => v !== u && v.hp > 0);
      if (near.length >= 3) out.crowded++;
      if (near.some((v) => g.hostile(u.owner, v.owner))) out.enemyNear++;
      if (near.some((v) => g.allied(u.owner, v.owner) && !v.goal)) out.idleFriendNear++;
    }
    out.blockedTicks = out.blockedTicks.length ? { median: out.blockedTicks.sort((a, b) => a - b)[out.blockedTicks.length >> 1], max: out.blockedTicks.at(-1) } : null;
    return out;
  };
  let civA = 0, civB = 1;
  const setup = {};
  const sc = job.scenario;
  let loop = null;   // per-tick hook (i) => void
  let total = ticks ?? 600;
  if (sc === 'idle') {
    army(civA, toward(home(civA), mapCentre(), 4), N); total = ticks ?? 300;
  } else if (sc === 'longMove' || sc === 'passage' || sc === 'deform') {
    const ids = army(civA, toward(home(civA), home(civB), 4), N);
    const goal = standable(toward(home(civB), home(civA), 4));
    setup.distance = +distance(home(civA), goal).toFixed(1);
    commands.push({ ...command(civA, { c: 'move', units: ids, point: goal }), units: ids.length });
    total = ticks ?? 900;
    if (sc === 'deform') {
      // engineers' earthworks + field works dropped on the line of march while the army walks it
      const a = toward(home(civA), home(civB), 6), b = goal;
      let k = 0;
      loop = (i) => {
        if (i % 20 === 0) {   // terrain works (actionEngineers.reshape): elevation change + world.classify + nav.invalidate
          const f = ((k++ * .137) % .8) + .1, p = { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f }, t = tileAt(p.x, p.z);
          if (t >= 0) { g.world.elev[t] += .02; g.world.classify(t); g.world.touch(t); g.nav.invalidate(); }
        }
        if (i % 50 === 25) {   // a barricade placed on the route (addFacility -> nav.invalidate + clearFootprint)
          const f = ((k * .211) % .8) + .1, p = { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, yaw: k };
          const t = tileAt(p.x, p.z);
          if (t >= 0 && g.nav.canStand(p.x, p.z, ACTION_UNITS.tank)) addFacility(g, g.civs[civB], null, 'barricade', t, { instant: true, point: p });
        }
      };
    }
  } else if (sc === 'repeat') {
    const ids = army(civA, toward(home(civA), home(civB), 4), N);
    const goals = [standable(toward(home(civB), home(civA), 4)), standable(toward(home(2 % job.players), mapCentre(), 4))];
    let k = 0;
    loop = (i) => { if (i % 5 === 0) commands.push({ ...command(civA, { c: 'move', units: ids, point: goals[k++ % 2] }), units: ids.length }); };
    total = ticks ?? 300;
  } else if (sc === 'converge') {
    const goal = standable(mapCentre());
    for (let c = 0; c < Math.min(4, job.players); c++) {
      const ids = army(c, toward(home(c), goal, 4), Math.round(N / Math.min(4, job.players)));
      // allied? no: all hostile; use plain move so they do not fight on arrival (fighting is the combat scenario)
      commands.push({ ...command(c, { c: 'move', units: ids, point: goal }), units: ids.length });
    }
    total = ticks ?? 900;
  } else if (sc === 'unreachable') {
    // a passable target in a land region the army can never reach (another island)
    const start = toward(home(civA), mapCentre(), 3), d = ACTION_UNITS.tank;   // tracked: the class most often cut off (wide rivers, bridges)
    const ca = g.nav.componentOf(tileAt(start.x, start.z), d);
    let target = null, best = Infinity;
    const N2 = g.world.terr.length;
    for (let t = 0; t < N2; t++) {
      const c = g.nav.componentOf(t, d);
      if (c < 0 || c === ca) continue;
      const p = centerOf(t), dd = distance(p, start);
      if (dd > 8 && dd < best && g.nav.canStand(p.x, p.z, d)) { best = dd; target = p; }
    }
    setup.targetFound = !!target; setup.distance = +best.toFixed(1);
    const ids = army(civA, start, N);
    if (target) {
      const q = command(civA, { c: 'reach', units: ids, point: target });
      setup.reachQueryMs = +q.ms.toFixed(2); setup.reach = q.r?.reply?.reach;
      // the UI warns, but a player (or AI) can still issue it: every 3 s, as an impatient player would
      loop = (i) => { if (i % 30 === 0) commands.push({ ...command(civA, { c: 'move', units: ids, point: target }), units: ids.length }); };
    }
    total = ticks ?? 300;
  } else if (sc === 'baseJam') {
    // everyone ordered into their own HQ compound at once (rally / capture-like): crowding, stalls, replans
    const ids = army(civA, toward(home(civA), mapCentre(), 5), N);
    commands.push({ ...command(civA, { c: 'move', units: ids, point: { x: home(civA).x, z: home(civA).z } }), units: ids.length });
    total = ticks ?? 900;
  } else if (sc === 'combat') {
    const mid = standable(mapCentre(), 4);
    const a = standable(toward(mid, home(civA), 6)), b = standable(toward(mid, home(civB), 6));
    const A = army(civA, a, Math.round(N / 2), 'aggressive'), B = army(civB, b, Math.round(N / 2), 'aggressive');
    g.refreshVisibility();
    commands.push({ ...command(civA, { c: 'move', units: A, point: b, attackMove: true }), units: A.length });
    commands.push({ ...command(civB, { c: 'move', units: B, point: a, attackMove: true }), units: B.length });
    total = ticks ?? 600;
  } else if (sc === 'aiMatch') {
    total = ticks ?? job.minutes * 600;
  } else throw new Error('unknown scenario ' + sc);

  setup.initial = states();
  // arrival tracking (move scenarios): each ordered ground unit's slot; "arrived" = order finished within 1 tile-width of it
  const arrivals = new Map();
  if (!ai && sc !== 'repeat' && sc !== 'unreachable') for (const u of g.units.values()) if (u.goal && !ACTION_UNITS[u.type].air) arrivals.set(u.id, { x: u.goal.x, z: u.goal.z, at: 0, d: null });
  const trackArrivals = (i) => { for (const [id, s] of arrivals) { if (s.at) continue; const u = g.units.get(id); if (!u) { s.at = -1; continue; } if (!u.goal) { s.at = i; s.d = distance(u, s); } } };
  const sampleEvery = ai ? 300 : 50;
  for (let i = 1; i <= total && !g.over; i++) {
    if (loop) loop(i);
    const row = tick();
    row.i = i;
    if (ai || i % 10 === 0) { const s = states(); row.units = s.units; row.moving = s.moving; }
    if (arrivals.size && i % 10 === 0) trackArrivals(i);
    rows.push(row);
    if (i % sampleEvery === 0) samples.push({ ...states(), navP50: q(rows.slice(-sampleEvery).map((r) => r.navigation ?? 0), .5), navP95: q(rows.slice(-sampleEvery).map((r) => r.navigation ?? 0), .95),
      routeCalls: rows.slice(-sampleEvery).reduce((s, r) => s + (r.route || 0), 0), invalidations: S.invalidations, blockedDiag: blockedDiag() });
  }

  // ---- summarise
  function q(a, p) { if (!a.length) return null; const s = Float64Array.from(a).sort(); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); }
  const dist = (a) => ({ n: a.length, mean: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null, median: q(a, .5), p95: q(a, .95), p99: q(a, .99), max: a.length ? +Math.max(...a).toFixed(3) : null });
  const col = (k, from = rows) => from.map((r) => r[k] || 0);
  const seconds = rows.length / 10;
  const perTick = {};
  const keys = new Set(); for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  for (const k of keys) if (k !== 'i') perTick[k] = dist(col(k));
  // scheduler tasks that do not run every tick: only ticks on which they ran
  for (const t of g.sched.tasks) if (t.every > 1) perTick[t.name] = dist(rows.filter((r) => r[t.name] != null).map((r) => r[t.name]));
  // windows for the AI match: per 5-minute block of nav ms and units
  const windows = [];
  if (ai) for (let w = 0; w < rows.length; w += 3000) {
    const block = rows.slice(w, w + 3000);
    windows.push({ fromMin: w / 600, units: dist(block.map((r) => r.units || 0)).median, moving: dist(block.map((r) => r.moving || 0)).median, nav: dist(block.map((r) => r.navigation || 0)), tick: dist(block.map((r) => r.tick || 0)),
      routePerSec: +(block.reduce((s, r) => s + (r.route || 0), 0) / (block.length / 10)).toFixed(1), routeMsPerSec: +(block.reduce((s, r) => s + (r.routeMs || 0), 0) / (block.length / 10)).toFixed(2),
      canMovePerTick: +(block.reduce((s, r) => s + (r.canMove || 0), 0) / block.length).toFixed(0), invalidations: block.reduce((s, r) => s + (r.invalidations || 0), 0),
      over15: block.filter((r) => (r.navigation || 0) > 15).length });
  }
  const replans = [...S.replans.values()];
  const fn = Object.fromEntries(Object.entries(S.fn).map(([k, v]) => [k, { calls: v.calls, perSec: +(v.calls / seconds).toFixed(1), ms: +v.ms.toFixed(1), usPerCall: v.calls ? +((v.ms * 1000) / v.calls).toFixed(1) : null,
    byPhase: Object.fromEntries(Object.entries(v.byPhase).map(([p, b]) => [p, { calls: b.calls, ms: +b.ms.toFixed(1) }])) }]));
  trackArrivals(rows.length);
  const arr = [...arrivals.values()], done = arr.filter((s) => s.at > 0), arrivedL = done.filter((s) => s.d <= 1.0);
  const arrival = arrivals.size ? { ordered: arr.length, arrived: arrivedL.length, stoppedShort: done.length - arrivedL.length, stillMoving: arr.filter((s) => !s.at).length, dead: arr.filter((s) => s.at < 0).length,
    arrivedPct: +(100 * arrivedL.length / arr.length).toFixed(1), arriveTickP50: q(arrivedL.map((s) => s.at), .5), arriveTickP90: q(arrivedL.map((s) => s.at), .9), shortDistP50: q(done.filter((s) => s.d > 1.0).map((s) => s.d), .5), remainingP50: q(arr.filter((s) => !s.at).map((s) => distance(g.units.get(Number([...arrivals.entries()].find((e) => e[1] === s)[0])), s)), .5) } : null;
  const navCol = col('navigation');
  const headline = { units: setup.initial.units, navP50: q(navCol, .5), navP95: q(navCol, .95), navP99: q(navCol, .99), navMax: navCol.length ? +Math.max(...navCol).toFixed(2) : null,
    routePerSec: S.fn.route ? +(S.fn.route.calls / seconds).toFixed(1) : null, arrivedPct: arrival?.arrivedPct ?? null, commandMs: commands.length ? q(commands.map((c) => c.ms), .5) : null };
  const out = { scenario: sc, n: N, map: job.map, size: job.size, seed: job.seed, plain: job.plain, simSeconds: seconds, setup, headline,
    commands: { count: commands.length, ms: dist(commands.map((c) => c.ms)), placed: commands.slice(0, 3).map((c) => c.r?.placed ?? c.r?.error ?? null) },
    arrival, navStats: g.navStats || null, perTick, windows, samples, final: states(), fn,
    search: { heapPops: S.pops, strategicCalls: S.strategicCalls, strategicNull: S.strategicNull, corridorHits: S.corridorHit, flowUses: S.flowUse,
      flowBuilds: S.flowBuilds, flowBuildPops: S.flowBuildPops, flowReuse: S.flowReuse, routeNull: S.routeNull, routeNullByPhase: S.routeNullByPhase, localRouteNull: S.localNull,
      routeByCaller: Object.fromEntries(Object.entries(S.routeBy).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => [k, { calls: v.calls, ms: +v.ms.toFixed(1), nulls: v.nulls }])) },
    invalidation: { count: S.invalidations, perMin: +(S.invalidations / (seconds / 60)).toFixed(2), by: S.invalidateBy, rebuild: { components: { n: S.rebuild.components.n, ms: +S.rebuild.components.ms.toFixed(1) }, gradient: { n: S.rebuild.gradient.n, ms: +S.rebuild.gradient.ms.toFixed(1) } } },
    replansPerUnit: { units: replans.length, ...dist(replans) },
    scheduler: g.sched.metrics() };
  process.stdout.write(JSON.stringify(out) + '\n');
}
