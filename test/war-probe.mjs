// War probe: AI nations at war — do they hold dug-in lines, push like players, use aircraft, keep
// progressing? Usage: node test/war-probe.mjs [seed=5] [minutes=45] [civs=3]
import { Game } from '../server/sim/game.js';
import { UNITS } from '../server/sim/constants.js';
const seed = +(process.argv[2] || 5), minutes = +(process.argv[3] || 45), n = +(process.argv[4] || 3);
const g = new Game({ id: 'war' + seed, seed, slots: Array.from({ length: n }, (_, i) => ({ personality: ['warlord', 'warlord', 'builder', 'merchant'][i % 4], difficulty: 'normal' })) });
const t0 = performance.now();
for (let i = 1; i <= minutes * 600; i++) {
  g.tick(); g.outbox.length = 0;
  if (i % (5 * 600) === 0) {
    const wars = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (g.hostile(a, b)) wars.push(`${a}-${b}`);
    console.log(`t=${i / 600}m wars [${wars.join(' ')}] captures ${g.stats.captures || 0} ruined ${g.stats.ruined || 0} trenches ${g.fieldworks.size} missiles ${g.stats.missiles || 0}`);
    for (const c of g.civs.filter((x) => !x.isRebel && x.alive)) {
      const army = [...g.units.values()].filter((u) => u.owner === c.id && !UNITS[u.type].civilian);
      const ms = c.ai ? Object.entries([...c.ai.mil.missions.values()].reduce((o, m) => { const k = `${m.kind}${m.state ? ':' + m.state : ''}`; o[k] = (o[k] || 0) + m.units.size; return o; }, {})).map(([k, v]) => `${k} ${v}`).join(', ') : '';
      const air = army.filter((u) => u.air), aloft = air.filter((u) => !u.grounded).length;
      const fw = [...g.fieldworks.values()].filter((f) => f.owner === c.id).length;
      console.log(`  ${c.id} ${c.name.split(' ')[0].padEnd(8)} e${c.age} cities ${g.cityOf(c).length} army ${army.length} air ${air.length} (aloft ${aloft}) trenches ${fw} | ${ms}`);
    }
  }
}
console.log(`${((performance.now() - t0) / (minutes * 600)).toFixed(1)} ms/tick`);
