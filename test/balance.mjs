// Balance probe: run seeded AI-vs-AI matches and report population, idle buildings, starvation,
// army composition and time to each era. Usage: node test/balance.mjs [seeds=1,2] [minutes=25] [civs=4]
import { Game } from '../server/sim/game.js';
import { UNITS, BUILDINGS, AGES } from '../server/sim/constants.js';
const seeds = (process.argv[2] || '1,2').split(',').map(Number);
const minutes = +(process.argv[3] || 25), ncivs = +(process.argv[4] || 4);
for (const seed of seeds) {
  const g = new Game({ id: 'bal' + seed, seed, slots: Array.from({ length: ncivs }, () => ({ human: false })) });
  const eraAt = g.civs.map(() => [0]); const starve = g.civs.map(() => 0); let idleSum = 0, idleN = 0;
  const t0 = performance.now();
  for (let i = 0; i < minutes * 600; i++) {
    g.tick();
    if (i % 50 === 0) {
      for (const c of g.civs) if (!c.isRebel && c.alive) { if (c.age >= eraAt[c.id].length) eraAt[c.id].push(Math.round(g.time / 60)); if (g.cityOf(c).some((x) => x.foodShort)) starve[c.id] += 5; }
      const jb = [...g.buildings.values()].filter((b) => b.done && BUILDINGS[b.type].jobs && !g.civs[b.owner].isRebel);
      if (jb.length) { idleSum += jb.filter((b) => !b.staffed).length / jb.length; idleN++; }
    }
    if (i % (5 * 600) === 0 && i) {
      const row = g.civs.filter((c) => !c.isRebel).map((c) => {
        const cities = g.cityOf(c); const pop = cities.reduce((s, x) => s + x.pop, 0);
        const units = [...g.units.values()].filter((u) => u.owner === c.id && !UNITS[u.type].civilian);
        const top = Object.entries(units.reduce((m, u) => (m[u.type] = (m[u.type] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
        return `${c.name.split(' ')[0]} ${c.alive ? '' : '(dead)'} e${c.age} c${cities.length} p${pop.toFixed(0)} u${units.length} [${top}]`;
      });
      console.log(`seed ${seed} t=${Math.round(g.time / 60)}m  ` + row.join(' | '));
    }
  }
  console.log(`seed ${seed}: eras(min) ${g.civs.filter((c) => !c.isRebel).map((c) => eraAt[c.id].join('/')).join('  ')}  starving(s) ${starve.filter((_, i) => !g.civs[i].isRebel).join(',')}  idle-jobs ${(100 * idleSum / Math.max(1, idleN)).toFixed(0)}%  ${((performance.now() - t0) / (minutes * 600)).toFixed(1)}ms/tick`);
}
