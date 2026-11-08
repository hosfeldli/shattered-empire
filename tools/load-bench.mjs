// Multiplayer load benchmark: four human empires at war, troops per player spawned around the map
// centre, every player re-ordering groups of troops and placing buildings every two seconds, as a
// busy online match would. Reports tick timing (p50/p95/max), per-command server time (orders,
// placement queries, builds), and per-viewer snapshot cost and size.
// Usage: node tools/load-bench.mjs [perPlayer=400] [seconds=90] [--prof]
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { spawnUnit } from '../server/sim/military.js';
import { disk, dist } from '../server/sim/hex.js';
import { TERRAIN, isWater, W } from '../server/sim/constants.js';
const per = Number(process.argv[2] || 400), seconds = Number(process.argv[3] || 90);
const g = new Game({ id: 'load', seed: 5, slots: [{ human: true }, { human: true }, { human: true }, { human: true }], rebels: false, ruleset: WORKS_RULESET });
for (const c of g.civs) { c.connected = true; for (const k of Object.keys(c.res)) c.res[k] = 1e6; }
for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) g.diplomacy.rel(a, b).state = 'war';
const ok = (t) => !isWater(g.world.terr[t]) && Number.isFinite(TERRAIN[g.world.terr[t]].move);
const caps = g.civs.map((c) => g.capital(c).tile);
const mix = ['rifle_squad', 'rifle_squad', 'rifle_squad', 'tank', 'mortar_team', 'armored_car', 'militia', 'field_gun', 'mech_infantry'];
const armies = g.civs.map((c, i) => {
  const out = []; const tiles = disk(caps[i], 10).filter(ok).sort((a, b) => dist(a, caps[i]) - dist(b, caps[i]));
  for (let k = 0; k < per; k++) { const u = spawnUnit(g, c, mix[k % mix.length], tiles[Math.floor(k / 3) % tiles.length]); u.stance = 'aggressive'; out.push(u.id); }
  return out;
});
g.rebuildTileUnits();
const rng = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const ticks = [], cmds = { move: [], placement: [], site: [], build: [] }, snaps = [], bytes = [];
const time = (list, f) => { const t0 = performance.now(); const r = f(); list.push(performance.now() - t0); return r; };
for (let i = 0; i < seconds * 10; i++) {
  // each player acts every two seconds on its own beat (players never act in lockstep)
  for (let p = 0; p < 4; p++) if (i % 20 === p * 5) {
    const alive = armies[p].filter((id) => g.units.has(id));
    // four groups per player, each sent toward another player's capital or a nearby point
    for (let k = 0; k < 4; k++) {
      const group = alive.slice(k * 40, k * 40 + 40); if (!group.length) continue;
      const target = rng() < 0.6 ? caps[(p + 1 + (k % 3)) % 4] : disk(caps[p], 8)[Math.floor(rng() * 200)];
      time(cmds.move, () => g.command(p, { c: 'move', units: group, tile: target, attackMove: rng() < 0.5 }));
    }
    time(cmds.placement, () => g.command(p, { c: 'placement', type: 'house' }));
    const site = disk(caps[p], 4)[Math.floor(rng() * 60)];
    time(cmds.site, () => g.command(p, { c: 'placement', type: 'house', tile: site }));
    time(cmds.build, () => g.command(p, { c: 'build', type: 'house', tile: site, plan: true }));
  }
  time(ticks, () => g.tick());
  if (i % 2 === 0) {
    const t0 = performance.now(); const msgs = g.snapshots(null, i % 10 === 0); const dt = performance.now() - t0;
    let b = 0, viewers = 0; for (const [civ, m] of msgs) { if (civ >= 0) viewers++; b += JSON.stringify(m).length; }
    snaps.push(dt / Math.max(1, viewers)); bytes.push(b / Math.max(1, viewers));
  }
  g.outbox.length = 0;
}
const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const m = g.sched.metrics();
const top = Object.entries(m).filter(([k]) => k !== 'tick').sort((a, b) => b[1].p95 - a[1].p95).slice(0, 8).map(([k, v]) => `${k} p95 ${v.p95} max ${v.max}`);
console.log(JSON.stringify({ perPlayer: per, alive: g.units.size, tick: { p50: q(ticks, .5), p95: q(ticks, .95), p99: q(ticks, .99), max: q(ticks, 1) },
  commands: Object.fromEntries(Object.entries(cmds).map(([k, v]) => [k, { p50: q(v, .5), p95: q(v, .95), max: q(v, 1) }])),
  snapshotPerViewer: { ms_p95: q(snaps, .95), kb_p95: Math.round(q(bytes, .95) / 1024) }, top }, null, 1));
