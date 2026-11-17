// Action RTS balance sims: AI-only matches on the authored maps, run headless in parallel worker
// threads (the map size is fixed per process). Logs army sizes over time, time to first contact,
// match length, kills, the no-man's-land (craters, wrecks, field works) and per-unit-type results.
// Usage: node tools/action-balance.mjs [maps=all|id,id] [seeds=1,2,3] [minutes=30] [--out=file.json] [--workers=N]
//   difficulty and personalities: --difficulty=normal, personalities rotate warlord/merchant/builder per seat.
//   --teams=0,1 plays every map with those teams instead of the ones it was drawn for (fewer players, other
//   sides: actionMap.assignStarts seats them), e.g. --teams=0,1 for duels or --teams=0,0,1 for 2 v 1.
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';

const SIM = new URL('../server/sim/', import.meta.url).href;
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const [mapsArg = 'all', seedsArg = '1,2,3', minutesArg = '30'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const maps = mapsArg === 'all' ? MAP_CATALOG : MAP_CATALOG.filter((m) => mapsArg.split(',').includes(m.id));
const seeds = seedsArg.split(',').map(Number);
const minutes = Number(minutesArg);
const difficulty = flags.difficulty || 'normal';
const teamOf = flags.teams ? String(flags.teams).split(',').map(Number) : null;
const poolSize = Math.max(1, Number(flags.workers) || Math.max(1, os.cpus().length - 1));

const RUN = `
const { parentPort, workerData: job } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = job.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(job.sim + 'actionGame.js');
const { ACTION_UNITS } = await import(job.sim + 'actionDefinitions.js');
const P = ['warlord', 'merchant', 'builder'];
const slots = Array.from({ length: job.teamOf ? job.teamOf.length : job.players }, (_, i) => ({ human: false, difficulty: job.difficulty, personality: P[(i + job.seed) % 3] }));
const g = new ActionGame({ id: 'bal-' + job.id + '-' + job.seed, seed: job.seed, map: job.id, slots, ...(job.teamOf ? { teamOf: job.teamOf, teamSize: Math.max(...job.teamOf.map((t) => job.teamOf.filter((x) => x === t).length)) } : {}) });
const value = (type) => { const c = ACTION_UNITS[type]?.cost || {}; return (c.materials || 0) + (c.energy || 0); };
const byType = {};
const T = (type) => (byType[type] ??= { built: 0, lost: 0, kills: 0, killValue: 0, damage: 0, lostValue: 0 });
let firstContact = null, firstKill = null, firstBuildingHit = null, firstBattle = null, unitKills = 0;
const record = g.recordEngagement.bind(g);
g.recordEngagement = (source, target, weapon, damage) => {
  if (source && target) {
    const srcUnit = g.units.get(source.id), sType = srcUnit?.type || (source.isUnit ? source.type : 'structure:' + (source.type || '?'));
    if (target.isUnit && (srcUnit || source.isUnit) && firstContact == null) firstContact = g.time;
    if (!target.isUnit && firstBuildingHit == null && (srcUnit || source.isUnit)) firstBuildingHit = g.time;
    T(sType).damage += damage;
    if (target.isUnit && target.hp <= 0) {
      T(sType).kills++; T(sType).killValue += value(target.type);
      T(target.type).lost++; T(target.type).lostValue += value(target.type);
      if (firstKill == null) firstKill = g.time;
      if (++unitKills >= 5 && firstBattle == null) firstBattle = g.time;
    }
  }
  return record(source, target, weapon, damage);
};
const seen = new Set();
const samples = [];
const sample = () => {
  const civs = g.civs.map((c) => {
    let units = 0, ground = 0, air = 0, armyValue = 0, infantry = 0;
    for (const u of g.units.values()) if (u.owner === c.id) {
      const d = ACTION_UNITS[u.type]; units++; armyValue += value(u.type);
      if (d.air) air++; else ground++;
      if (d.move === 'infantry') infantry++;
    }
    const sites = g.sites.filter((s) => s.owner === c.id && s.slots).length;
    return { units, ground, air, infantry, armyValue, sites, kills: c.kills || 0, casualties: c.casualties || 0, materials: Math.round(c.res.materials), energy: Math.round(c.res.energy),
      income: Math.round((c.rates?.materials || 0) * 60), age: c.age, alive: c.alive };
  });
  let field = 0; for (const b of g.buildings.values()) if (b.done !== false && ['barricade', 'trench', 'guard_post', 'bunker', 'city_turret', 'turret', 'fort', 'outpost'].includes(b.type)) field++;
  samples.push({ t: Math.round(g.time), civs, craters: g.craters?.size || 0, wrecks: g.wrecks?.size || 0, field });
};
const t0 = performance.now();
const ticks = job.minutes * 600;
let error = null;
try {
  for (let i = 1; i <= ticks && !g.over; i++) {
    g.tick(); g.outbox.length = 0;
    if (i % 20 === 0) for (const u of g.units.values()) if (!seen.has(u.id)) { seen.add(u.id); T(u.type).built++; }
    if (i % 300 === 0) sample();
  }
} catch (e) { error = String(e.stack || e); }
sample();
parentPort.postMessage({ map: job.id, seed: job.seed, players: job.players, teamSize: job.teamSize, wallSeconds: Math.round((performance.now() - t0) / 1000), error,
  length: Math.round(g.time), over: !!g.over, winner: g.winner ? { civ: g.winner.civ, team: g.civs[g.winner.civ]?.team, how: g.winner.how } : null,
  firstContact, firstKill, firstBattle, firstBuildingHit, byType, samples, personalities: slots.map((s) => s.personality) });
`;

function run(job) {
  return new Promise((resolve) => {
    const worker = new Worker(RUN, { eval: true, type: 'module', workerData: job, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', (e) => resolve({ map: job.id, seed: job.seed, error: String(e.stack || e) }));
  });
}

const jobs = [];
for (const def of maps) for (const seed of seeds) jobs.push({ id: def.id, size: def.size, players: teamOf ? teamOf.length : def.players, teamSize: def.teamSize, teamOf, seed, minutes, difficulty, sim: SIM });
const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(poolSize, jobs.length) }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    const r = await run(job);
    results.push(r);
    const s = r.samples?.at(-1);
    console.error(`${r.map} seed ${r.seed}: ${r.error ? 'ERROR ' + r.error.split('\n')[0] : `${Math.round(r.length / 60)} min${r.over ? ' (over: team ' + r.winner?.team + ')' : ''}, contact ${fmt(r.firstContact)}, units ${s?.civs.map((c) => c.units).join('/')}, kills ${s?.civs.map((c) => c.kills).join('/')}, ${r.wallSeconds}s wall`}`);
  }
}));

function fmt(t) { if (t == null || !Number.isFinite(t)) return '-'; const s = Math.round(t); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const at = (r, minute) => r.samples?.find((s) => s.t >= minute * 60) || null;
const lines = [];
lines.push('| Map | Seeds | First contact (mean) | First kill | 5th kill (first battle) | Units/player @3 @6 @9 @12 @18 @24 | Army value/player @12 | Kills/player (end) | Match length | Ended | Craters @end | Field works @end |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const def of maps) {
  const rs = results.filter((r) => r.map === def.id && !r.error);
  if (!rs.length) continue;
  const unitsAt = (m) => { const v = rs.map((r) => at(r, m)).filter(Boolean).map((s) => mean(s.civs.filter((c) => c.alive).map((c) => c.units))); return v.length ? Math.round(mean(v)) : '-'; };
  const value12 = rs.map((r) => at(r, 12)).filter(Boolean).map((s) => mean(s.civs.map((c) => c.armyValue)));
  const end = rs.map((r) => r.samples.at(-1));
  lines.push(`| ${def.name} | ${rs.length} | ${fmt(mean(rs.map((r) => r.firstContact).filter((x) => x != null)))} | ${fmt(mean(rs.map((r) => r.firstKill).filter((x) => x != null)))} | ${fmt(mean(rs.map((r) => r.firstBattle).filter((x) => x != null)))} | ${[3, 6, 9, 12, 18, 24].map(unitsAt).join(' / ')} | ${value12.length ? Math.round(mean(value12)) : '-'} | ${Math.round(mean(end.map((s) => mean(s.civs.map((c) => c.kills)))))} | ${fmt(mean(rs.map((r) => r.length)))} | ${rs.filter((r) => r.over).length}/${rs.length} | ${Math.round(mean(end.map((s) => s.craters)))} | ${Math.round(mean(end.map((s) => s.field)))} |`);
}
const types = {};
for (const r of results) for (const [k, v] of Object.entries(r.byType || {})) { const t = (types[k] ??= { built: 0, lost: 0, kills: 0, killValue: 0, lostValue: 0, damage: 0 }); for (const f of Object.keys(t)) t[f] += v[f] || 0; }
lines.push('');
lines.push('| Unit type | Built | Lost | Kills | Kills per loss | Value killed / value lost |');
lines.push('|---|---|---|---|---|---|');
for (const [k, t] of Object.entries(types).sort((a, b) => b[1].built - a[1].built)) {
  if (!t.built && !t.kills) continue;
  lines.push(`| ${k} | ${t.built} | ${t.lost} | ${t.kills} | ${t.lost ? (t.kills / t.lost).toFixed(2) : '-'} | ${t.lostValue ? (t.killValue / t.lostValue).toFixed(2) : '-'} |`);
}
console.log(lines.join('\n'));
if (flags.out) fs.writeFileSync(flags.out, JSON.stringify(results));
