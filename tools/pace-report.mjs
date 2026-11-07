// Pacing report: run AI-only native-v4 matches headless and record when each empire reaches each
// era, how many cities it has, and whether food or progress stalls. Usage:
//   node tools/pace-report.mjs [minutes=110] [seeds=3,7] [map=]
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
const minutes = Number(process.argv[2] || 110);
const seeds = String(process.argv[3] || '3,7').split(',').map(Number);
const out = [];
for (const seed of seeds) {
  const g = new Game({ id: 'pace' + seed, seed, slots: [{ personality: 'builder' }, { personality: 'merchant' }, { personality: 'warlord' }, { personality: 'builder' }], rebels: false, ruleset: WORKS_RULESET });
  const reached = g.civs.map(() => ({}));
  const samples = [];
  const t0 = Date.now();
  for (let i = 0; i < minutes * 600; i++) {
    g.tick(); g.outbox.length = 0;
    if (i % 600 === 0) {
      const minute = i / 600;
      g.civs.forEach((c, k) => { if (c.alive && reached[k][c.age] == null) reached[k][c.age] = minute; });
      if (minute % 10 === 0) samples.push({ minute, civs: g.civs.map((c) => ({ age: c.age, alive: c.alive, cities: [...g.cities.values()].filter((x) => x.owner === c.id).length, pop: Math.round([...g.cities.values()].filter((x) => x.owner === c.id).reduce((s, x) => s + x.pop, 0)), food: Math.round(c.res.food), units: [...g.units.values()].filter((u) => u.owner === c.id).length })) });
    }
  }
  out.push({ seed, wallSeconds: Math.round((Date.now() - t0) / 1000), eraMinute: reached, samples });
  console.log(JSON.stringify(out.at(-1)));
}
