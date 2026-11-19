// Late-game navigation probe (NAV_BRIDGES.md, 2026-11-18): an AI-only match played for --minutes game minutes, with
// navigation instrumented per game minute. Reports, per minute:
//   tick ms (mean / max wall time per tick; noisy on a loaded machine), nav work (route / strategic / localRoute calls,
//   standing tests), nav.invalidate() calls and what they rebuilt, stuck-ladder counters (ghost, replan, escape,
//   unstick, gave up), and the units stuck NOW: ground units with an order that moved less than 0.5 in the last 30 s,
//   split into vehicles / infantry and those standing near a river.
// Usage: node tools/nav-late-game-probe.mjs [--map=twin_rivers] [--seed=7] [--players=4] [--minutes=30] [--json]
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
const SIM = new URL('../server/sim/', import.meta.url).href;
const { MAP_CATALOG } = await import(SIM + 'mapCatalog.js');
const mapId = flags.map || 'twin_rivers', def = MAP_CATALOG.find((m) => m.id === mapId);
globalThis.SE_MAP_SIZE = def ? def.size : Number(flags.size || 128);
globalThis.SE_WRAP = false;
const { ActionGame } = await import(SIM + 'actionGame.js');
const { ACTION_UNITS } = await import(SIM + 'actionDefinitions.js');
const { DT } = await import(SIM + 'constants.js');
const { NB } = await import(SIM + 'hex.js');
const seed = Number(flags.seed ?? 7), minutes = Number(flags.minutes || 30);
const players = Number(flags.players || def?.players || 4);
const P = ['warlord', 'merchant', 'builder'];
const slots = Array.from({ length: players }, (_, i) => ({ human: false, difficulty: 'normal', personality: P[(i + seed) % 3] }));
// --save-at=M --save=file: write a snapshot after minute M; --load=file: continue from a snapshot (minutes count on)
const persist = await import(SIM + 'persist.js');
const fsMod = await import('node:fs');
let g, startMin = 1;
if (flags.load) { const data = JSON.parse(fsMod.readFileSync(flags.load, 'utf8')); g = persist.restoreGame(data); startMin = (data.probeMin || 0) + 1; }
else { g = new ActionGame({ id: 'late-' + mapId + '-' + seed, seed, ...(def ? { map: mapId } : { style: 'pangaea' }), slots }); g.tick(); g.outbox.length = 0; }

const C = { nullMs: 0, slowNull: [], route: 0, routeNull: 0, routeMs: 0, strategic: 0, local: 0, stand: 0, invalidate: 0, components: 0, gradient: 0, moveGroup: 0 };
const nav = () => g.nav;
const wrap = (obj, name, fn) => { const f = obj[name].bind(obj); obj[name] = (...a) => fn(f, a); };
function instrument() {
  const n = nav();
  const where = () => new Error().stack.split('\n').slice(4, 8).map((l) => l.trim().replace(/^at /, '').replace(/\(.*\/sim\//, '(')).join(' < ');
  wrap(n, 'route', (f, a) => {
    const t0 = performance.now(), r = f(...a), ms = performance.now() - t0;
    C.routeMs += ms; C.route++;
    if (!r) {
      C.routeNull++; C.nullMs += ms;
      if (C.slowNull.length < (flags.stacks ? 6 : 3) && ms > 20)
        C.slowNull.push(`${a[2].move} ${ms.toFixed(0)}ms d${Math.hypot(a[0].x - a[1].x, a[0].z - a[1].z).toFixed(1)}${nav().strict ? ' strict' : ''}${flags.stacks ? ' <' + where() + '>' : ''}`);
    }
    return r;
  });
  wrap(n, 'strategic', (f, a) => { C.strategic++; return f(...a); });
  wrap(n, 'localRoute', (f, a) => { C.local++; return f(...a); });
  wrap(n, 'canStand', (f, a) => { C.stand++; return f(...a); });
  wrap(n, 'invalidate', (f, a) => { C.invalidate++; if (n.components) C.components++; if (n.gradient) C.gradient++; return f(...a); });
}
instrument();
const zero = () => { for (const k of Object.keys(C)) C[k] = 0; C.slowNull = []; };
const last = new Map();   // unit id -> { x, z, t }
const rows = [];
const ticksPerMin = Math.round(60 / DT);
let stuck0 = { ...(g.navStats?.stuck || {}) }, cut0 = 0;
for (let m = startMin; m <= minutes; m++) {
  zero();
  let tickSum = 0, tickMax = 0;
  for (let i = 0; i < ticksPerMin; i++) {
    const t0 = performance.now();
    g.tick(); g.outbox.length = 0;
    const ms = performance.now() - t0; tickSum += ms; tickMax = Math.max(tickMax, ms);
    if (i % 50 === 0) for (const u of g.units.values()) {
      const d = ACTION_UNITS[u.type]; if (d.air || u.inside) continue;
      const l = last.get(u.id);
      if (!l || !u.goal || Math.hypot(u.x - l.x, u.z - l.z) > .5) last.set(u.id, { x: u.x, z: u.z, t: g.time });
    }
  }
  const st = g.navStats?.stuck || {}, d = {}, cut = (g.navStats?.routeCutOff || 0) - cut0; cut0 = g.navStats?.routeCutOff || 0;
  for (const k of Object.keys(st)) d[k] = (st[k] || 0) - (stuck0[k] || 0);
  stuck0 = { ...st };
  let stuckV = 0, stuckI = 0, nearRiver = 0, ground = 0, vehicles = 0;
  const examples = [];
  for (const u of g.units.values()) {
    const ud = ACTION_UNITS[u.type]; if (ud.air || u.inside) continue;
    ground++; if (ud.move !== 'infantry') vehicles++;
    const l = last.get(u.id);
    if (!u.goal || !l || g.time - l.t < 30) continue;
    const river = [u.tile, ...NB.slice(u.tile * 6, u.tile * 6 + 6)].some((t) => t >= 0 && g.world.river[t]);
    if (ud.move === 'infantry') stuckI++; else stuckV++;
    if (river) nearRiver++;
    if (examples.length < 4) examples.push(`${u.type}#${u.id}@${u.tile}${river ? 'R' : ''} ${(g.time - l.t).toFixed(0)}s blk${u.blocked} st${u.stall}`);
  }
  let wrecks = 0; for (const l of g.wrecks.values()) wrecks += l.length;
  const row = { min: m, tickMean: +(tickSum / ticksPerMin).toFixed(2), tickMax: +tickMax.toFixed(1), units: g.units.size, ground, vehicles, wrecks, craters: g.craters.size,
    roads: g.roads.edges.size, buildings: g.buildings.size, cut, route: C.route, routeNull: C.routeNull, routeMs: +C.routeMs.toFixed(0), nullMs: +C.nullMs.toFixed(0), slowNull: C.slowNull, strategic: C.strategic, local: C.local,
    stand: C.stand, invalidate: C.invalidate, rebuilt: C.components, stuck: d, stuckV, stuckI, nearRiver, examples };
  rows.push(row);
  console.log(`min ${String(m).padStart(2)} tick ${row.tickMean}/${row.tickMax} ms units ${row.units} (veh ${vehicles}) wrecks ${wrecks} roads ${row.roads} | route ${row.route} (null ${row.routeNull}, cut ${row.cut}, ${row.routeMs} ms, null ${row.nullMs} ms ${row.slowNull.join(',')}) strat ${row.strategic} local ${row.local} stand ${(row.stand / 1000).toFixed(0)}k inval ${row.invalidate} (rebuilt ${row.rebuilt}) | ghost ${d.ghost || 0} replan ${d.replan || 0} escape ${d.escape || 0} unstick ${d.unstick || 0} gaveUp ${d.gaveUp || 0} capped ${d.blockedCapped || 0} | stuck now veh ${stuckV} inf ${stuckI} (river ${nearRiver}) ${examples.join('; ')}`);
  if (flags.save && Number(flags['save-at']) === m) { const data = persist.serializeGame(g); data.probeMin = m; fsMod.writeFileSync(flags.save, JSON.stringify(data)); console.log('saved', flags.save); }
  if (g.over || g.winner != null) { console.log('match over'); break; }
}
if (flags.json) console.log(JSON.stringify(rows));
