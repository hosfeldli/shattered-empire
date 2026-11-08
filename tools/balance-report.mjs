// Unit balance evidence: equal-value forces of two unit types fight in the open (native-v4 rules)
// and the report gives the share of its value each side keeps. A fair pair ends near even; a
// counter should win clearly. Aircraft are left out: away from an airfield they cannot rearm. Usage: node tools/balance-report.mjs [budget=1200] [seconds=150]
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { spawnUnit } from '../server/sim/military.js';
import { disk, dist } from '../server/sim/hex.js';
import { UNITS, TERRAIN, isWater, W, T } from '../server/sim/constants.js';
const budget = Number(process.argv[2] || 1200), seconds = Number(process.argv[3] || 150);
const PRICE = { food: .5, materials: 1, ore: 1, steel: 2, fuel: 2, electronics: 4, munitions: 2, credits: .5 };
export const value = (type) => Object.entries(UNITS[type].cost || {}).reduce((s, [k, v]) => s + v * (PRICE[k] || 1), 0);

export function duel(a, b, seed = 5) {
  const g = new Game({ id: 'bal' + a + b + seed, seed, slots: [{ human: true }, { human: true }], rebels: false, ruleset: WORKS_RULESET });
  for (const c of g.civs) { c.connected = true; for (const k of Object.keys(c.res)) c.res[k] = 1e6; for (const t of Object.keys(UNITS)) void t; }
  g.diplomacy.rel(0, 1).state = 'war';
  const cap = g.capital(g.civs[0]).tile;
  const ok = (t) => !isWater(g.world.terr[t]) && Number.isFinite(TERRAIN[g.world.terr[t]].move);
  const mid = disk(cap, 14).filter(ok).sort((x, y) => dist(y, cap) - dist(x, cap))[0];
  const shift = (t, dq) => { const q = (t % W) + dq, r = (t / W) | 0; return r * W + ((q % W) + W) % W; };
  const side = (civ, type, center) => {
    const n = Math.max(1, Math.round(budget / value(type))), out = [];
    const tiles = disk(center, 6).filter(ok).sort((x, y) => dist(x, center) - dist(y, center));
    for (let i = 0; i < n; i++) { const u = spawnUnit(g, g.civs[civ], type, tiles[Math.floor(i / 2) % tiles.length]); u.stance = 'aggressive'; out.push(u.id); }
    return out;
  };
  for (const t of disk(mid, 9)) if (ok(t)) g.world.terr[t] = T.GRASS ?? g.world.terr[t];
  const A = side(0, a, shift(mid, -5)), B = side(1, b, shift(mid, 5));
  g.rebuildTileUnits();
  g.command(0, { c: 'move', units: A, tile: shift(mid, 5), attackMove: true });
  g.command(1, { c: 'move', units: B, tile: shift(mid, -5), attackMove: true });
  for (let i = 0; i < seconds * 10; i++) { g.tick(); g.outbox.length = 0; }
  const kept = (ids, type) => ids.reduce((s, id) => { const u = g.units.get(id); return s + (u ? u.hp / u.maxHp : 0); }, 0) / ids.length;
  return { a, b, keptA: +kept(A, a).toFixed(2), keptB: +kept(B, b).toFixed(2) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pairs = [['militia', 'rifle_squad'], ['rifle_squad', 'armored_car'], ['armored_car', 'mortar_team'], ['rifle_squad', 'mech_infantry'],
    ['mech_infantry', 'tank'], ['tank', 'sp_artillery'], ['special_forces', 'mech_infantry'],
    ['tank', 'missile_battery'], ['exo_infantry', 'autonomous_tank'], ['special_forces', 'exo_infantry']];
  for (const [a, b] of pairs) {
    // averaged over three maps: single fights are swingy
    const runs = [5, 7, 11].map((seed) => duel(a, b, seed));
    const r = { keptA: runs.reduce((s, x) => s + x.keptA, 0) / runs.length, keptB: runs.reduce((s, x) => s + x.keptB, 0) / runs.length };
    console.log(`${a.padEnd(16)} vs ${b.padEnd(16)} kept ${r.keptA.toFixed(2)} : ${r.keptB.toFixed(2)}  (value ${value(a)}/${value(b)})`);
  }
}
