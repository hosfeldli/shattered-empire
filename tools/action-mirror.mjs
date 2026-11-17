// Action RTS mirror tests: equal-cost forces of two unit types (or mixes) meet on flat open ground
// and attack-move through each other. Reports the share of its starting value each side keeps after the
// fight (averaged over several arenas). A fair pairing ends near even; a counter should win clearly.
// Value = materials + energy. Usage: node tools/action-mirror.mjs [budget=1800] [seconds=120] [arenas=3]
globalThis.SE_MAP_SIZE = 76; globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { mapPoint } = await import('../server/sim/authoredMaps.js');
const { centerOf, tileAt } = await import('../server/sim/actionNavigation.js');
const { N } = await import('../server/sim/constants.js');

const [budget = 1800, seconds = 120, arenas = 3] = process.argv.slice(2).map(Number);
export const value = (type) => (ACTION_UNITS[type].cost.materials || 0) + (ACTION_UNITS[type].cost.energy || 0);

function arena(seed) {
  const g = new ActionGame({ id: 'mirror' + seed, seed, map: 'twin_rivers', slots: [{ human: false }, { human: false }] });
  g.sandbox = true;
  for (const c of g.civs) c.res = { materials: 1e6, energy: 1e6 };
  // a flat, open field west of the river: no buildings, rivers, woods or hills
  const centre = mapPoint([[.2, .55], [.22, .45], [.24, .62]][seed % 3]);
  const w = g.world;
  for (const b of [...g.buildings.values()]) if (Math.hypot(b.x - centre.x, b.z - centre.z) < 18) g.removeBuilding(b);
  for (let t = 0; t < N; t++) {
    const c = centerOf(t);
    if (Math.hypot(c.x - centre.x, c.z - centre.z) > 16) continue;
    w.elev[t] = .15; w.moist[t] = .4; w.river[t] = 0; w.flow[t] = 0; w.terr[t] = 255; w.classify(t); w.touch(t);
  }
  g.units.clear(); g.movers.clear(); g.projectiles?.clear?.();
  g.nav.invalidate();
  return { g, centre };
}

function fight(mixA, mixB, seed) {
  const { g, centre } = arena(seed);
  const sides = [mixA, mixB].map((mix, side) => {
    const ids = [], per = budget / mix.reduce((s, t) => s + value(t), 0);
    const roster = [];
    for (const t of mix) for (let i = 0; i < Math.max(1, Math.round(per)); i++) roster.push(t);
    const cols = Math.ceil(Math.sqrt(roster.length * 1.5));
    roster.forEach((type, i) => {
      const x = centre.x + (side ? 1 : -1) * (5 + Math.floor(i / cols) * .55), z = centre.z + (i % cols - cols * .5) * .56;
      const u = g.spawn(g.civs[side], type, { x, z }, .13);
      if (u) ids.push(u.id);
    });
    return ids;
  });
  for (let side = 0; side < 2; side++) {
    const goal = { x: centre.x + (side ? -1 : 1) * 9, z: centre.z };
    g.command(side, { c: 'move', units: sides[side], point: goal, attackMove: true, tile: tileAt(goal.x, goal.z) });
  }
  for (let i = 0; i < seconds * 10; i++) { g.tick(); g.outbox.length = 0; }
  const kept = (ids) => {
    let start = 0, left = 0;
    for (const id of ids) { const u = g.units.get(id); start += 1; if (u) left += u.hp / u.maxHp; }
    return left / Math.max(1, start);
  };
  return { keptA: kept(sides[0]), keptB: kept(sides[1]), nA: sides[0].length, nB: sides[1].length };
}

const PAIRS = [
  [['rifle_squad'], ['rifle_squad']],
  [['rifle_squad'], ['militia']],
  [['rifle_squad'], ['anti_armor']],
  [['rifle_squad'], ['mortar_team']],
  [['rifle_squad'], ['scout_buggy']],
  [['rifle_squad'], ['armored_car']],
  [['anti_armor'], ['tank']],
  [['anti_armor'], ['armored_car']],
  [['tank'], ['mech_infantry']],
  [['tank'], ['field_gun']],
  [['tank'], ['tank']],
  [['armored_car'], ['mech_infantry']],
  [['special_forces'], ['rifle_squad']],
  [['exo_infantry'], ['tank']],
  [['autonomous_tank'], ['tank']],
  [['rifle_squad', 'rifle_squad', 'anti_armor', 'mortar_team'], ['tank', 'rifle_squad', 'rifle_squad']],
  [['rifle_squad', 'rifle_squad', 'rifle_squad'], ['rifle_squad', 'anti_armor', 'mortar_team']],
];
const name = (mix) => [...new Set(mix)].map((t) => `${mix.filter((x) => x === t).length > 1 ? mix.filter((x) => x === t).length + 'x' : ''}${t}`).join('+');
const only = process.env.PAIRS ? process.env.PAIRS.split(';').map((p) => p.split('|').map((s) => s.split(','))) : PAIRS;
console.log(`| A | B | count A : B | kept A : B (share of starting HP, mean of ${arenas} arenas) | verdict |`);
console.log('|---|---|---|---|---|');
for (const [a, b] of only) {
  const runs = Array.from({ length: arenas }, (_, s) => fight(a, b, s + 1));
  const kA = runs.reduce((s, r) => s + r.keptA, 0) / runs.length, kB = runs.reduce((s, r) => s + r.keptB, 0) / runs.length;
  const verdict = Math.abs(kA - kB) < .15 ? 'even' : kA > kB ? 'A wins' : 'B wins';
  console.log(`| ${name(a)} | ${name(b)} | ${runs[0].nA} : ${runs[0].nB} | ${kA.toFixed(2)} : ${kB.toFixed(2)} | ${verdict} |`);
}
