// Balance scenarios (spec 16.2): equal-cost battles in the sandbox across seeds. Exported for the
// test suite; `node test/scenarios.mjs` prints a table.
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena, spawnGroup } from '../server/sim/sandbox.js';
import { UNITS } from '../server/sim/constants.js';
import { idx, qOf, rOf, disk } from '../server/sim/hex.js';

// the game's own valuation of goods (the planner's), so 'equal cost' means what the economy pays
const VALUE = { food: 1, materials: 1.2, ore: 1.6, steel: 3, fuel: 2.6, electronics: 6, munitions: 2.6, credits: 0.7 };
const value = (u) => Object.entries(UNITS[u.type].cost).reduce((s, [k, v]) => s + v * (VALUE[k] || 1), 0);
export const costOf = (type) => value({ type });
const off = (t, dq, dr = 0) => idx(qOf(t) + dq, rOf(t) + dr);
// n units of a type worth about `budget`
const afford = (type, budget) => Math.max(1, Math.round(budget / costOf(type)));

export function battle(seed, setup, seconds = 90) {
  const g = new Game({ id: 'sc' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  makeSandbox(g);
  const a = findArena(g, 9);
  const [A, B, after] = setup(g, a);
  for (const u of [...A, ...B]) u.cohesion = 1;
  if (after) after(g, A, B);
  const v0A = A.reduce((s, u) => s + value(u), 0), v0B = B.reduce((s, u) => s + value(u), 0);
  for (let i = 0; i < seconds * 10; i++) { g.tick(); g.outbox.length = 0; }
  const live = (us) => us.filter((u) => g.units.has(u.id)).reduce((s, u) => s + value(u) * (g.units.get(u.id).hp / g.units.get(u.id).maxHp), 0);
  const lossA = 1 - live(A) / v0A, lossB = 1 - live(B) / v0B;
  return { lossA: +lossA.toFixed(2), lossB: +lossB.toFixed(2), exchange: +((lossB * v0B + 0.01) / (lossA * v0A + 0.01)).toFixed(2), g };
}

const B = 1500;   // budget per side
export const SCENARIOS = {
  infantryMirror: (g, a) => { const A = spawnGroup(g, 0, 'rifle_squad', off(a, -4), afford('rifle_squad', B)), Bs = spawnGroup(g, 1, 'rifle_squad', off(a, 4), afford('rifle_squad', B)); return [A, Bs, (g2) => { g2.orderMove(g2.civs[0], A.map((u) => u.id), off(a, 3), true); g2.orderMove(g2.civs[1], Bs.map((u) => u.id), off(a, -3), true); }]; },
  massVsBalanced: (g, a) => {
    const A = spawnGroup(g, 0, 'militia', off(a, -4), afford('militia', B));
    const Bs = [...spawnGroup(g, 1, 'rifle_squad', off(a, 4), afford('rifle_squad', B * 0.65)), ...spawnGroup(g, 1, 'mortar_team', off(a, 6), afford('mortar_team', B * 0.35))];
    return [A, Bs, (g2) => { g2.orderMove(g2.civs[0], A.map((u) => u.id), off(a, 4), true); for (const u of Bs) u.stance = 'defensive'; }];
  },
  tanksVsPrepared: (g, a) => {
    const A = spawnGroup(g, 0, 'tank', off(a, -6), afford('tank', B));
    const Bs = [...spawnGroup(g, 1, 'rifle_squad', off(a, 3), afford('rifle_squad', B * 0.5)), ...spawnGroup(g, 1, 'field_gun', off(a, 5), afford('field_gun', B * 0.5))];
    return [A, Bs, (g2) => {
      for (const u of Bs) { u.stance = 'hold'; g2.fieldworks.set(u.tile, { tile: u.tile, owner: 1, type: 'reinforced', fx: -1, fy: 0, dir: 3, progress: 1, hp: 100, paid: true, state: 'complete', group: 0, at: 0, lastSeen: 0 }); }
      g2.orderMove(g2.civs[0], A.map((u) => u.id), off(a, 4), true);
    }];
  },
  tanksVsOpenInfantry: (g, a) => {
    const A = spawnGroup(g, 0, 'tank', off(a, -6), afford('tank', B));
    const Bs = spawnGroup(g, 1, 'rifle_squad', off(a, 3), afford('rifle_squad', B));
    return [A, Bs, (g2) => { for (const u of Bs) u.stance = 'hold'; g2.orderMove(g2.civs[0], A.map((u) => u.id), off(a, 4), true); }];
  },
  artilleryVsStack: (g, a) => {
    const A = spawnGroup(g, 0, 'sp_artillery', off(a, -5), 3);
    const Bs = spawnGroup(g, 1, 'rifle_squad', off(a, 2), 12);
    const spot = spawnGroup(g, 0, 'scout_buggy', off(a, -1), 1); spot[0].stance = 'passive';      // a spotter: artillery needs eyes
    return [A, Bs, (g2) => { const t = off(a, 1); for (const u of Bs) { u.tile = t; u.stance = 'passive'; } g2.rebuildTileUnits(); for (const u of A) u.stance = 'hold'; }];
  },
  artilleryVsDispersed: (g, a) => {
    const A = spawnGroup(g, 0, 'sp_artillery', off(a, -5), 3);
    const Bs = spawnGroup(g, 1, 'rifle_squad', off(a, 2), 12);
    const spot = spawnGroup(g, 0, 'scout_buggy', off(a, -1), 1); spot[0].stance = 'passive';
    return [A, Bs, (g2) => { Bs.forEach((u, i) => { u.tile = off(a, (i % 6) - 1, i < 6 ? -2 : 2); u.stance = 'passive'; }); g2.rebuildTileUnits(); for (const u of A) u.stance = 'hold'; }];
  },
  suppliedVsIsolated: (g, a) => {
    const A = spawnGroup(g, 0, 'tank', off(a, -4), 6), Bs = spawnGroup(g, 1, 'tank', off(a, 4), 6);
    return [A, Bs, (g2) => { g2.sandbox = false; for (const u of Bs) u.supply = 8; g2.civs[0].supply.fill(1); g2.civs[1].supply.fill(0); g2.orderMove(g2.civs[0], A.map((u) => u.id), off(a, 3), true); g2.orderMove(g2.civs[1], Bs.map((u) => u.id), off(a, -3), true); }];
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [k, f] of Object.entries(SCENARIOS)) {
    const rs = [7, 11, 23].map((s) => battle(s, f));
    console.log(k.padEnd(22), rs.map((r) => `A-${Math.round(r.lossA * 100)}% B-${Math.round(r.lossB * 100)}% x${r.exchange}`).join('   '));
  }
}
void disk;
