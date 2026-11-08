// Large-battle server benchmark: two human empires at war, N troops per side spawned facing each
// other and ordered to attack-move. Reports scheduler timings per system, tick p50/p95/max,
// and the cost and size of the per-viewer snapshots. Usage: node tools/battle-bench.mjs [perSide=100] [seconds=60]
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { spawnUnit } from '../server/sim/military.js';
import { disk, dist } from '../server/sim/hex.js';
import { UNITS, TERRAIN, isWater, W } from '../server/sim/constants.js';
const per = Number(process.argv[2] || 100), seconds = Number(process.argv[3] || 60);
const g = new Game({ id: 'bench', seed: 5, slots: [{ human: true }, { human: true }], rebels: false, ruleset: WORKS_RULESET });
for (const c of g.civs) { c.connected = true; for (const k of Object.keys(c.res)) c.res[k] = 1e6; }
g.diplomacy.rel(0, 1).state = 'war';
const capA = g.capital(g.civs[0]).tile;
const ok = (t) => !isWater(g.world.terr[t]) && Number.isFinite(TERRAIN[g.world.terr[t]].move);
const mid = disk(capA, 14).filter(ok).sort((a, b) => dist(b, capA) - dist(a, capA))[0];
const shift = (t, dq) => { const q = (t % W) + dq, r = (t / W) | 0; return r * W + ((q % W) + W) % W; };
const mix = ['rifle_squad', 'rifle_squad', 'rifle_squad', 'tank', 'mortar_team', 'armored_car', 'militia', 'field_gun'];
function army(civ, center) {
  const out = []; const tiles = disk(center, 12).filter(ok).sort((a, b) => dist(a, center) - dist(b, center));
  let i = 0;
  for (const t of tiles) { for (let k = 0; k < 3 && i < per; k++, i++) { const u = spawnUnit(g, g.civs[civ], mix[i % mix.length], t); u.stance = 'aggressive'; out.push(u.id); } if (i >= per) break; }
  return out;
}
const A = army(0, shift(mid, -7)), B = army(1, shift(mid, 7));
g.rebuildTileUnits();
g.command(0, { c: 'move', units: A, tile: shift(mid, 7), attackMove: true });
g.command(1, { c: 'move', units: B, tile: shift(mid, -7), attackMove: true });
const snapTimes = [], snapBytes = [], tickTimes = [];
for (let i = 0; i < seconds * 10; i++) {
  const t0 = performance.now(); g.tick(); tickTimes.push(performance.now() - t0);
  if (i % 2 === 0) {
    const s0 = performance.now(); const msgs = g.snapshots(null, i % 10 === 0); snapTimes.push(performance.now() - s0);
    let bytes = 0; for (const [, m] of msgs) bytes += JSON.stringify(m).length; snapBytes.push(bytes);
  }
  g.outbox.length = 0;
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const m = g.sched.metrics();
const top = Object.entries(m).filter(([k]) => k !== 'tick').sort((a, b) => b[1].p95 - a[1].p95).slice(0, 8).map(([k, v]) => `${k} p95 ${v.p95} max ${v.max}`);
console.log(JSON.stringify({ perSide: per, unitsAlive: g.units.size, tick: { p50: q(tickTimes, .5), p95: q(tickTimes, .95), max: q(tickTimes, 1) }, snapshot: { p50: q(snapTimes, .5), p95: q(snapTimes, .95), kbP95: Math.round(q(snapBytes, .95) / 1024) }, top }, null, 1));
