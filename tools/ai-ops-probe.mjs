// AI operations probe (2026-11-18, docs/gameplay-overhaul/AI_OPERATIONS.md): AI-only matches on authored maps, run
// headless in worker threads, measuring what the AI operations layer does rather than unit balance:
//  - captures: entries of an AI civ's capture-capable infantry into a neutral/hostile capture zone ("passes"),
//    seconds spent inside, passes that left without the capture completing, and captures completed;
//  - axes: for every enemy base an AI civ fights at, which of 8 compass sectors (seen from the base) its troops
//    stood in between 3 and 11 units out, weighted by unit-seconds; reports the sectors holding >= 12 % share;
//  - operations: objective changes, failed operations ("Operation ended"), task-force count;
//  - strategic missiles: silos built, missiles built and launched, own units caught in a blast;
//  - expansion: bases held per civ at minutes 8 / 16 / 24; match length and winner.
// Usage: node tools/ai-ops-probe.mjs [maps=all|id,id] [seeds=1,2] [minutes=25] [--difficulty=normal] [--out=file.json]
//   [--sim=dir] runs another copy of server/sim (a before snapshot); [--noworks] switches the AI works layer off
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
// --sim=dir runs another copy of server/sim (a before snapshot) under the same probe
const SIM = flags.sim ? pathToFileURL(String(flags.sim).replace(/[\\/]?$/, '/')).href : new URL('../server/sim/', import.meta.url).href;
const [mapsArg = 'all', seedsArg = '1,2', minutesArg = '25'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const maps = mapsArg === 'all' ? MAP_CATALOG : MAP_CATALOG.filter((m) => mapsArg.split(',').includes(m.id));
const seeds = seedsArg.split(',').map(Number);
const minutes = Number(minutesArg);
const difficulty = flags.difficulty || 'normal';
const poolSize = Math.max(1, Number(flags.workers) || Math.max(1, os.cpus().length - 1));

const RUN = `
const { parentPort, workerData: job } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = job.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(job.sim + 'actionGame.js');
const { ACTION_UNITS } = await import(job.sim + 'actionDefinitions.js');
if (job.noWorks) { try { (await import(job.sim + 'actionAIWorks.js')).AI_WORKS.enabled = false; } catch {} }
const P = ['warlord', 'merchant', 'builder'];
const slots = Array.from({ length: job.players }, (_, i) => ({ human: false, difficulty: job.difficulty, personality: P[(i + job.seed) % 3] }));
const g = new ActionGame({ id: 'probe-' + job.id + '-' + job.seed, seed: job.seed, map: job.id, slots });
const dist = (a, b) => Math.hypot(g.dx(b.x, a.x), a.z - b.z);
const civs = g.civs.map((c) => ({ id: c.id, passes: 0, abandoned: 0, inside: 0, captures: 0, opChanges: 0, failed: 0, silos: 0, built: 0, launched: 0,
  friendlyInBlast: 0, strikes: 0, army: [], sitePasses: {}, sectors: {}, bases: [], forces: 0, forceSamples: 0 }));
const inZone = new Map();   // civ:site -> { since }
const command = g.command.bind(g);
g.command = (civId, cmd) => {
  const r = command(civId, cmd);
  if (!r?.error && g.civs[civId]?.isAI) {
    if (cmd.c === 'missileBuild') civs[civId].built++;
    if (cmd.c === 'missileLaunch') {
      civs[civId].launched++;
      civs[civId].friendlyInBlast += [...g.units.values()].filter((u) => u.owner === civId && !ACTION_UNITS[u.type].air && dist(u, cmd.point) < 2.9).length;
    }
  }
  return r;
};
const lastState = new Map();
let error = null;
const t0 = performance.now();
const ticks = job.minutes * 600;
const silos = new Set();
try {
  for (let i = 1; i <= ticks && !g.over; i++) {
    g.tick(); g.outbox.length = 0;
    if (i % 10) continue;   // 1 s sampling
    for (const c of g.civs) {
      if (!c.alive || !c.aiPlan) continue;
      const m = civs[c.id], p = c.aiPlan;
      const key = p.state + ':' + p.target;
      if (lastState.get(c.id) !== key) { m.opChanges++; lastState.set(c.id, key); }
      for (const n of p.notes) { if (n.time <= (m.lastNote ?? -1)) break; if (/Operation ended|Assault failed/.test(n.text)) m.failed++; if (/Strategic strike/.test(n.text)) m.strikes++; }
      if (p.notes[0]) m.lastNote = p.notes[0].time;
      if (p.op?.forces?.length) { m.forces += p.op.forces.filter((f) => f.ids.length).length; m.forceSamples++; }
    }
    for (const b of g.buildings.values()) if (b.type === 'missile_silo' && !silos.has(b.id) && g.civs[b.owner]?.isAI) { silos.add(b.id); civs[b.owner].silos++; }
    for (const s of g.sites) {
      if (s.hq) continue;
      const near = g.movers.query(s.x, s.z, s.radius, g.search);
      for (const c of g.civs) {
        if (!c.alive || !c.aiPlan) continue;
        const k = c.id + ':' + s.id, eligible = s.owner !== c.id && !(s.owner >= 0 && g.allied(c.id, s.owner));
        const here = eligible && near.some((u) => u.owner === c.id && u.hp > 0 && !u.auto && ACTION_UNITS[u.type].capture);
        const was = inZone.get(k);
        if (here && !was) { inZone.set(k, { since: g.time }); civs[c.id].passes++; civs[c.id].sitePasses[s.id] = (civs[c.id].sitePasses[s.id] || 0) + 1; }
        else if (here) civs[c.id].inside++;
        else if (was) {
          inZone.delete(k);
          if (s.owner === c.id) civs[c.id].captures++;
          else civs[c.id].abandoned++;
        }
      }
    }
    // axes: unit-seconds per sector around enemy bases with an HQ
    if (i % 50 === 0) for (const s of g.sites) {
      if (!s.hq || s.owner < 0) continue;
      const near = g.movers.query(s.x, s.z, 11, g.search);
      for (const u of near) {
        if (!g.civs[u.owner]?.isAI || !g.hostile(u.owner, s.owner) || u.auto) continue;
        const d = dist(u, s); if (d < 3) continue;
        const sector = ((Math.round(Math.atan2(g.dx(s.x, u.x), u.z - s.z) / (Math.PI / 4)) % 8) + 8) % 8;
        const sec = (civs[u.owner].sectors[s.id] ??= [0, 0, 0, 0, 0, 0, 0, 0]);
        sec[sector] += 5;
      }
    }
    if (i % 4800 === 0) for (const c of g.civs) { civs[c.id].bases.push(g.sites.filter((s) => s.owner === c.id && s.slots).length); civs[c.id].army.push(c.alive ? [...g.units.values()].filter((u) => u.owner === c.id && !u.auto).length : null); }
  }
} catch (e) { error = String(e.stack || e); }
for (const [k] of inZone) { const [cid, sid] = k.split(':').map(Number); if (g.siteById.get(sid).owner === cid) civs[cid].captures++; }
for (const m of civs) {
  const axes = Object.values(m.sectors).filter((sec) => sec.reduce((a, b) => a + b, 0) >= 400).map((sec) => {
    const total = sec.reduce((a, b) => a + b, 0);
    return sec.filter((v) => v / total >= .12).length;
  });
  m.top = Object.values(m.sectors).filter((sec) => sec.reduce((a, b) => a + b, 0) >= 400).map((sec) => Math.max(...sec) / sec.reduce((a, b) => a + b, 0));
  m.axes = axes; m.sectors = undefined;
  m.repeatSites = Object.values(m.sitePasses).filter((n) => n >= 3).length; m.sitePasses = undefined;
  m.forces = m.forceSamples ? +(m.forces / m.forceSamples).toFixed(2) : 0;
}
parentPort.postMessage({ map: job.id, seed: job.seed, error, length: Math.round(g.time), over: !!g.over, winner: g.winner?.civ ?? null,
  wall: Math.round((performance.now() - t0) / 1000), civs });
`;

function run(job) {
  return new Promise((resolve) => {
    const worker = new Worker(RUN, { eval: true, type: 'module', workerData: job, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', (e) => resolve({ map: job.id, seed: job.seed, error: String(e.stack || e) }));
  });
}
const jobs = [];
for (const def of maps) for (const seed of seeds) jobs.push({ id: def.id, size: def.size, players: def.players, seed, minutes, difficulty, sim: SIM, noWorks: !!flags.noworks });
const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(poolSize, jobs.length) }, async () => {
  while (next < jobs.length) {
    const r = await run(jobs[next++]);
    results.push(r);
    if (r.error) { console.error(`${r.map} ${r.seed}: ERROR ${r.error.split('\\n').slice(0, 3).join(' | ')}`); continue; }
    const sum = (f) => r.civs.reduce((n, c) => n + c[f], 0);
    const axes = r.civs.flatMap((c) => c.axes);
    console.error(`${r.map} seed ${r.seed}: ${Math.round(r.length / 60)} min${r.over ? ' over' : ''} | passes ${sum('passes')} captures ${sum('captures')} abandoned ${sum('abandoned')} ` +
      `| failed ops ${sum('failed')} | axes/base ${axes.length ? (axes.reduce((a, b) => a + b, 0) / axes.length).toFixed(2) : '-'} | silos ${sum('silos')} missiles ${sum('built')}/${sum('launched')} ` +
      `| bases ${r.civs.map((c) => c.bases.join('-')).join(' ')} | ${r.wall}s`);
  }
}));
const ok = results.filter((r) => !r.error), all = ok.flatMap((r) => r.civs), sum = (f) => all.reduce((n, c) => n + c[f], 0);
const axes = all.flatMap((c) => c.axes), tops = all.flatMap((c) => c.top);
const armyAt = (k) => { const v = all.map((c) => c.army?.[k]).filter((x) => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '-'; };
const at = (k) => { const v = all.map((c) => c.bases[k]).filter((x) => x != null); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : '-'; };
console.log(JSON.stringify({ matches: ok.length, errors: results.length - ok.length, over: ok.filter((r) => r.over).length,
  meanLength: Math.round(ok.reduce((n, r) => n + r.length, 0) / Math.max(1, ok.length)),
  passes: sum('passes'), captures: sum('captures'), abandoned: sum('abandoned'), captureRate: +(sum('captures') / Math.max(1, sum('passes'))).toFixed(3),
  insideSecondsPerPass: +(sum('inside') / Math.max(1, sum('passes'))).toFixed(1), failedOps: sum('failed'), opChanges: sum('opChanges'),
  axesPerBase: axes.length ? +(axes.reduce((a, b) => a + b, 0) / axes.length).toFixed(2) : null, basesFought: axes.length, topSectorShare: tops.length ? +(tops.reduce((a, b) => a + b, 0) / tops.length).toFixed(3) : null, repeatSites: sum('repeatSites'), strikes: sum('strikes'),
  silos: sum('silos'), missilesBuilt: sum('built'), launched: sum('launched'), friendlyInBlast: sum('friendlyInBlast'),
  meanForces: +(all.reduce((n, c) => n + c.forces, 0) / Math.max(1, all.length)).toFixed(2),
  basesAt8_16_24: [at(0), at(1), at(2)], armyAt8_16_24: [armyAt(0), armyAt(1), armyAt(2)] }, null, 1));
if (flags.out) fs.writeFileSync(flags.out, JSON.stringify(results));
