// Pass 4 (perf, 2026-11-18): bytes and server encode time of the per-player snapshot stream, udelta (the 0.5.0 Unity
// client) against udelta + econ-delta-v1 (keyed sites / buildings / battlefield, server/delta.js), paired in one run:
// both encoders see exactly the same snapshots. A headless all-AI match on the live ruleset; civ 0 is watched as a player.
// Every nation is watched as a connected player. Per window, averaged over the nations alive at its end: KB per player per minute (raw JSON, and deflated per message as an upper bound of permessage-deflate),
// encode + JSON.stringify ms per snapshot round, econ message KB, and a census of the econ message's top-level fields
// (mean KB, and how often the field was byte-identical to the previous econ message: resent unchanged).
//
// Usage: node tools/econ-delta-bench.mjs [map] [--minutes=41] [--seed=7] [--at=5,20,40] [--samples=dir] [--no-victory] [--tag=name]
//   --samples writes one legacy and one keyed econ / non-econ wire message at the last window (client decode bench).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const map = args.find((a) => !a.startsWith('--')) || 'iron_basin';
const minutes = Number(flags.minutes) || 41, seed = Number(flags.seed) || 7;
const at = String(flags.at || '5,20,40').split(',').map(Number);
const { MAP_CATALOG } = await import(new URL('../server/sim/mapCatalog.js', import.meta.url).href);
const def = MAP_CATALOG.find((m) => m.id === map); if (!def) throw new Error('unknown map ' + map);
globalThis.SE_MAP_SIZE = def.size; globalThis.SE_WRAP = true;
const { ActionGame } = await import(new URL('../server/sim/actionGame.js', import.meta.url).href);
const { deltaEncoder } = await import(new URL('../server/delta.js', import.meta.url).href);

const P = ['warlord', 'merchant', 'builder'];
const slots = Array.from({ length: Number(flags.players) || def.players }, (_, i) => ({ human: false, difficulty: 'normal', personality: P[(i + seed) % 3] }));
const g = new ActionGame({ id: 'econ-delta-' + map, seed, map, slots });
// every nation is watched as a connected player (each with its own pair of encoders); a window averages over the
// nations still alive at its end, so an eliminated seat (a frozen view) does not dilute the late numbers
const seats = g.civs.filter((c) => !c.isRebel);
for (const c of seats) { c.human = true; c.connected = true; }
// --no-victory: the match runs to --minutes (late-game volume) even when one side wins; instance-only, sim source untouched
if (flags["no-victory"]) g.checkVictory = () => {};
const enc = new Map(seats.map((c) => [c.id, { legacy: deltaEncoder(), keyed: deltaEncoder(50, 10, { keyed: true }) }]));
for (const c of seats) { const [[, msg]] = g.snapshots(c.id); for (const e of Object.values(enc.get(c.id))) e(JSON.parse(JSON.stringify(msg))); }

const now = () => performance.now();
const win = new Map();   // window minute -> stats
const prevField = new Map();
let frames = 0;
const inWin = (t) => at.find((m) => t > (m - 1) * 60 && t <= (m + 1) * 60);
const t0 = Date.now();
const blank = () => ({ bytes: 0, defl: 0, deflMs: 0, encMs: 0, ms: [], econKB: [] });
while (g.time < minutes * 60 && !g.over) {
  g.tick(); g.outbox.length = 0; frames++;
  if (frames % 2) continue;
  const econ = frames % 10 === 0, m = inWin(g.time);
  for (const [civId, msg] of g.snapshots(null, econ)) {
    const e = enc.get(civId); if (!e) continue;
    // each encoder gets its own copy, to keep the comparison honest
    const copies = { legacy: JSON.parse(JSON.stringify(msg)), keyed: JSON.parse(JSON.stringify(msg)) };
    const res = {};
    for (const k of (frames / 2) % 2 ? ["legacy", "keyed"] : ["keyed", "legacy"]) { const a = now(); const str = JSON.stringify(e[k](copies[k])); res[k] = { ms: now() - a, s: str }; }   // alternating order
    if (m == null) continue;
    let w = win.get(m);
    if (!w) win.set(m, w = { t0: g.time, by: new Map(), fields: {}, units: 0 });
    w.t1 = g.time; w.units = Math.max(w.units, g.units.size);
    let c = w.by.get(civId); if (!c) w.by.set(civId, c = { legacy: blank(), keyed: blank() });
    for (const k of ["legacy", "keyed"]) {
      const r = res[k], o = c[k];
      o.bytes += r.s.length; const d0 = now(); o.defl += zlib.deflateRawSync(r.s, { level: 6 }).length; o.deflMs += now() - d0; o.encMs += r.ms; o.ms.push(r.ms); if (econ) o.econKB.push(r.s.length / 1024);
    }
    if (econ && g.civs[civId].alive) {
      const prev = prevField.get(civId) || {}; prevField.set(civId, prev);
      for (const [f, v] of Object.entries(msg)) {
        const j = JSON.stringify(v ?? null), fe = w.fields[f] ??= { kb: 0, n: 0, same: 0 };
        fe.kb += j.length / 1024; fe.n++; if (prev[f] === j) fe.same++; prev[f] = j;
      }
      const ko = JSON.parse(res.keyed.s);
      for (const f of ["sd", "bd", "bfd", "sites", "buildings", "bf"]) if (ko[f] !== undefined) { const fe = w.fields["keyed." + f] ??= { kb: 0, n: 0, same: 0 }; fe.kb += JSON.stringify(ko[f]).length / 1024; fe.n++; }
    }
    if (flags.samples && m === at.at(-1) && g.civs[civId].alive && (econ ? !w.sampled : !w.sampledS)) {
      fs.mkdirSync(flags.samples, { recursive: true });
      const kind = econ ? "econ" : "snap";
      fs.writeFileSync(path.join(flags.samples, kind + "-legacy.json"), res.legacy.s); fs.writeFileSync(path.join(flags.samples, kind + "-keyed.json"), res.keyed.s);
      if (econ) w.sampled = true; else w.sampledS = true;
    }
  }
  if (frames % 3000 === 0) console.error(`  game ${Math.round(g.time / 60)} min, units ${g.units.size}, ${Math.round((Date.now() - t0) / 1000)} s`);
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const out = { map, seed, players: g.civs.length, over: !!g.over, end: Math.round(g.time), windows: [] };
for (const [m, w] of [...win.entries()].sort((a, b) => a[0] - b[0])) {
  const mins = Math.max(1e-9, (w.t1 - w.t0) / 60);
  const alive = [...w.by.entries()].filter(([id]) => g.civs[id].alive || g.time < m * 60 + 60).map(([, c]) => c);   // alive at the window end
  const row = { minute: m, units: w.units, players: alive.length };
  for (const k of ["legacy", "keyed"]) {
    const sum = (f) => alive.reduce((x, c) => x + c[k][f], 0) / Math.max(1, alive.length);
    const ms = alive.flatMap((c) => c[k].ms), econKB = alive.flatMap((c) => c[k].econKB);
    row[k] = { kbPerMin: +(sum("bytes") / 1024 / mins).toFixed(0), deflKbPerMin: +(sum("defl") / 1024 / mins).toFixed(0), encMsPerMin: +(sum("encMs") / mins).toFixed(1), deflateMsPerMin: +(sum("deflMs") / mins).toFixed(1),
      encMsMean: +mean(ms).toFixed(3), encMsP95: +q(ms, 0.95).toFixed(3), encMsMax: +Math.max(0, ...ms).toFixed(2), econKB: +mean(econKB).toFixed(1), econKBMax: +Math.max(0, ...econKB).toFixed(1) };
  }
  row.fields = Object.fromEntries(Object.entries(w.fields).sort((a, b) => b[1].kb - a[1].kb).map(([f, e]) => [f, { kb: +(e.kb / e.n).toFixed(2), sentOf: e.n, unchanged: e.same }]));
  out.windows.push(row);
}
const file = path.join(ROOT, 'docs/performance/data', `econ-delta-${map}${flags.tag ? '-' + flags.tag : ''}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
for (const r of out.windows) {
  console.log(`min ${r.minute} (units ${r.units}, ${r.players} players): legacy ${r.legacy.kbPerMin} KB/min (deflated ${r.legacy.deflKbPerMin}), econ ${r.legacy.econKB} KB (max ${r.legacy.econKBMax}), enc ${r.legacy.encMsPerMin} ms/min, deflate ${r.legacy.deflateMsPerMin} ms/min`);
  console.log(`            keyed  ${r.keyed.kbPerMin} KB/min (deflated ${r.keyed.deflKbPerMin}), econ ${r.keyed.econKB} KB (max ${r.keyed.econKBMax}), enc ${r.keyed.encMsPerMin} ms/min, deflate ${r.keyed.deflateMsPerMin} ms/min`);
  console.log('   econ fields (mean KB, unchanged/sent):', Object.entries(r.fields).slice(0, 16).map(([f, e]) => `${f} ${e.kb} ${e.unchanged}/${e.sentOf}`).join(', '));
}
console.log('->', path.relative(ROOT, file));
