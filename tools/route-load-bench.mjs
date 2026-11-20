// Route-load bench (Pass 6, 2026-11-19): reproduces the production 8-brutal-AI 4v4 (match 59f3a8: random pangaea map,
// size 104, max starting resources) headless and reports, per game minute, the tick cost (mean / p95 / p99 / max wall
// ms) and the routing load: nav.route() calls, ms, failures by reason (nav.lastFail) and by caller (the two sim
// functions above route() on the stack), coarse re-plans, memo hits and Pass 6 deferrals (game.navStats).
// Instrumentation is monkey-patched onto the instance; the simulation source is untouched, so any copy of server/sim
// can be measured with --sim=dir (a before snapshot).
// Usage: node tools/route-load-bench.mjs [--sim=dir] [--seed=1] [--minutes=30] [--size=104] [--players=8] [--team=4]
//          [--difficulty=brutal] [--res=max] [--map=random|id] [--out=file.json]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
const SIM = flags.sim ? pathToFileURL(String(flags.sim).replace(/[\\/]?$/, '/')).href : new URL('../server/sim/', import.meta.url).href;
const seed = Number(flags.seed ?? 1), minutes = Number(flags.minutes || 30), players = Number(flags.players || 8), team = Number(flags.team || 4);
const mapId = flags.map && flags.map !== 'random' ? flags.map : null;
const { MAP_CATALOG } = await import(SIM + 'mapCatalog.js');
const def = mapId ? MAP_CATALOG.find((m) => m.id === mapId) : null;
globalThis.SE_MAP_SIZE = def ? def.size : Number(flags.size || 104);
globalThis.SE_WRAP = false;
const { ActionGame } = await import(SIM + 'actionGame.js');
const { stateHash } = await import(SIM + 'persist.js');
const { DT } = await import(SIM + 'constants.js');
const P = ['warlord', 'merchant', 'builder'];
const slots = Array.from({ length: players }, (_, i) => ({ human: false, difficulty: flags.difficulty || 'brutal', personality: P[(i + seed) % 3] }));
const g = new ActionGame({ id: 'routeload-' + seed, seed, ...(mapId ? { map: mapId } : { style: 'pangaea' }), teamSize: team, startRes: flags.res || 'max', slots });

const now = () => performance.now();
let W = null;
const fresh = () => ({ ticks: [], route: 0, routeMs: 0, fail: 0, failMs: 0, reasons: {}, callers: {}, callerMs: {}, failCallers: {}, inval: 0, work: 0, tickWork: [], sys: {} });
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
Error.stackTraceLimit = 8;
const caller = () => {
  const lines = new Error().stack.split('\n').slice(3), names = [];
  for (const l of lines) {
    const m = /at (?:ActionNavigation\.|ActionGame\.|Object\.)?([\w$.<>]+) \(/.exec(l) || /at ([\w$.<>]+) /.exec(l);
    const n = m ? m[1] : '?';
    if (n === 'route' || n === 'routeMemo' || n === 'budgetRoute' || n === 'strictRoute' || n.startsWith('nav.')) continue;
    names.push(n);
    if (names.length === 2) break;
  }
  return names.join('<');
};
if (flags.budget) g.nav.budgetWork = Number(flags.budget);
{
  const nav = g.nav, orig = nav.route;
  nav.route = function (...a) {
    const c = caller(), t = now();
    const r = orig.apply(this, a), ms = now() - t;
    W.route++; W.routeMs += ms; bump(W.callers, c); bump(W.callerMs, c, ms);
    if (!r) { W.fail++; W.failMs += ms; bump(W.reasons, nav.lastFail || 'other'); bump(W.failCallers, c); }
    return r;
  };
  if (nav.spend) { const sp = nav.spend; nav.spend = function (w) { W.work += w; W.tw = (W.tw || 0) + w; return sp.call(this, w); }; }
  const inv = nav.invalidate;
  nav.invalidate = function (...a) { W.inval++; return inv.apply(this, a); };
}
g.tick(); g.outbox.length = 0;
for (const t of g.sched.tasks) { const fn = t.fn; t.fn = (ctx, n) => { const a = now(); try { return fn(ctx, n); } finally { if (W) bump(W.sys, t.name, now() - a); } }; }

const q = (s, p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
const r1 = (x) => Math.round(x * 10) / 10;
const ticksPerMin = Math.round(60 / DT), rows = [], all = [];
let prev = {};
const cpu0 = process.threadCpuUsage();
for (let m = 1; m <= minutes && !g.over; m++) {
  W = fresh();
  for (let i = 0; i < ticksPerMin && !g.over; i++) {
    const t0 = now(); g.tick(); const ms = now() - t0;
    g.outbox.length = 0; W.ticks.push(ms); all.push(ms); W.tickWork.push(W.tw || 0); W.tw = 0;
  }
  const st = g.navStats || {}, d = {};
  for (const k of ['routeRetry', 'routeMemo', 'routeCutOff', 'routeSoft', 'routeDeferred', 'routeRefused', 'routeAdmitted', 'routeWaitTicks', 'memoKept', 'memoDropped', 'corridorKept', 'corridorDropped', 'localInvalidate', 'fullInvalidate'])
    { d[k] = (st[k] || 0) - (prev[k] || 0); prev[k] = st[k] || 0; }
  const s = [...W.ticks].sort((a, b) => a - b), mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
  const row = { min: m, units: g.units.size, buildings: g.buildings.size, mean: r1(mean), p95: r1(q(s, .95)), p99: r1(q(s, .99)), max: r1(s.at(-1) || 0),
    routes: W.route, routeMs: Math.round(W.routeMs), routeP: r1(W.routeMs / (W.route || 1) * 100) / 100, fails: W.fail, failMs: Math.round(W.failMs), reasons: W.reasons,
    callers: W.callers, callerMs: Object.fromEntries(Object.entries(W.callerMs).map(([k, v]) => [k, Math.round(v)])), failCallers: W.failCallers, inval: W.inval, work: W.work, workP99: q([...W.tickWork].sort((a, b) => a - b), .99), workMax: Math.max(0, ...W.tickWork), nav: d, sys: Object.fromEntries(Object.entries(W.sys).map(([k, v]) => [k, Math.round(v)])) };
  rows.push(row);
  console.log(`min ${String(m).padStart(2)} u${row.units} b${row.buildings} tick ${row.mean}/${row.p95}/${row.p99}/${row.max} | route ${row.routes} ${row.routeMs}ms fail ${row.fails} (${row.failMs}ms; ${top(W.reasons, 5)}) retry ${d.routeRetry} memo ${d.routeMemo} defer ${d.routeDeferred}/${d.routeRefused}/${d.routeAdmitted} wait ${(d.routeWaitTicks / (d.routeDeferred || 1)).toFixed(1)}/${g.navStats?.routeWaitMax || 0} kept c${d.corridorKept}/m${d.memoKept} inval ${row.inval} work ${(row.work / 1000).toFixed(0)}k p99 ${(row.workP99 / 1000).toFixed(0)}k max ${(row.workMax / 1000).toFixed(0)}k | fail by ${top(W.failCallers, 4)} | ms by ${top(row.callerMs, 5)}`);
}
const cpu = process.threadCpuUsage(cpu0);
const s = [...all].sort((a, b) => a - b);
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const total = { ticks: all.length, mean: r1(all.reduce((a, b) => a + b, 0) / all.length), p95: r1(q(s, .95)), p99: r1(q(s, .99)), max: r1(s.at(-1)),
  routes: sum('routes'), routeMs: sum('routeMs'), fails: sum('fails'), failMs: sum('failMs'), cpuS: r1((cpu.user + cpu.system) / 1e6), hash: stateHash(g), over: !!g.over, time: Math.round(g.time) };
console.log('TOTAL', JSON.stringify(total));
if (flags.out) fs.writeFileSync(flags.out, JSON.stringify({ flags, total, rows }, null, 1));
