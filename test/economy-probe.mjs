// Economy probe: seeded AI matches (governed like a player's cities) and the numbers that matter
// for "can a nation grow without starving or running out of room": population vs housing, food
// balance and starvation time, stocks and income of ore/steel/fuel/materials, how full the land is,
// revolts, and the army it can field. Usage: node test/economy-probe.mjs [seeds=7,11] [minutes=40] [civs=4]
import { Game } from '../server/sim/game.js';
import { UNITS, BUILDINGS, isWater } from '../server/sim/constants.js';
const seeds = (process.argv[2] || '7,11').split(',').map(Number);
const minutes = +(process.argv[3] || 40), ncivs = +(process.argv[4] || 4);
const tot = { starve: 0, revolts: 0, fill: 0, n: 0 };
for (const seed of seeds) {
  const g = new Game({ id: 'eco' + seed, seed, slots: Array.from({ length: ncivs }, () => ({ human: false })) });
  const starve = g.civs.map(() => 0);
  const t0 = performance.now();
  for (let i = 1; i <= minutes * 600; i++) {
    g.tick(); g.outbox.length = 0;
    if (i % 50 === 0) for (const c of g.civs) if (!c.isRebel && c.alive && g.cityOf(c).some((x) => x.foodShort)) starve[c.id] += 5;
    if (i % (10 * 600) === 0) {
      console.log(`seed ${seed} t=${i / 600}m`);
      for (const c of g.civs.filter((x) => !x.isRebel && x.alive)) {
        const cities = g.cityOf(c), pop = cities.reduce((s, x) => s + x.pop, 0), housing = cities.reduce((s, x) => s + x.housing, 0);
        let land = 0, built = 0; for (let t = 0; t < g.world.owner.length; t++) if (g.world.owner[t] === c.id && !isWater(g.world.terr[t])) { land++; if (g.tileB[t] >= 0) built++; }
        const army = [...g.units.values()].filter((u) => u.owner === c.id && !UNITS[u.type].civilian);
        const mech = army.filter((u) => ['tracked', 'wheeled'].includes(UNITS[u.type].cat)).length, air = army.filter((u) => UNITS[u.type].air).length;
        const r = (k) => `${k[0]}${Math.round(c.res[k] || 0)}(${((c.gross?.[k] || 0) - (c.upkeep?.[k] || 0)).toFixed(1)})`;
        console.log(`  ${c.name.split(' ')[0].padEnd(9)} e${c.age} cities ${cities.length} pop ${pop.toFixed(0)}/${housing} unrest ${cities.filter((x) => x.stability < 20).length} built ${built}/${land} (${Math.round(100 * built / Math.max(1, land))}%) ${['food', 'materials', 'ore', 'steel', 'fuel'].map(r).join(' ')} army ${army.length} mech ${mech} air ${air} starved ${starve[c.id]}s`);
      }
    }
  }
  const living = g.civs.filter((c) => !c.isRebel);
  tot.starve += living.reduce((s, c) => s + starve[c.id], 0) / living.length; tot.revolts += g.stats.revolts || 0; tot.n++;
  console.log(`seed ${seed}: avg starving ${Math.round(living.reduce((s, c) => s + starve[c.id], 0) / living.length)}s, revolts ${g.stats.revolts || 0}, ${((performance.now() - t0) / (minutes * 600)).toFixed(1)} ms/tick`);
}
console.log(`ALL: avg starving ${Math.round(tot.starve / tot.n)}s per civ, revolts ${tot.revolts}`);
