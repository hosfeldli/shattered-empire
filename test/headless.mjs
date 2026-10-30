// Headless AI-vs-AI soak test: node test/headless.mjs [seed] [minutes] [civs]
import { Game } from '../server/sim/game.js';
const seed = +(process.argv[2] || 7), minutes = +(process.argv[3] || 10), n = +(process.argv[4] || 2);
const g = new Game({ id: 't', seed, slots: Array.from({ length: n }, (_, i) => ({ human: false, personality: ['builder', 'warlord', 'merchant', 'warlord'][i] })) });
const t0 = Date.now(); let maxTick = 0;
const notes = [];
for (let i = 0; i < minutes * 600 && !g.over; i++) {
  const a = performance.now(); g.tick(); maxTick = Math.max(maxTick, performance.now() - a);
  for (const [civ, m] of g.outbox) if (m.t === 'note' && !m.quiet && (civ === 0 || civ === -1)) notes.push(`[${m.time}s] ${m.text}`);
  g.outbox.length = 0;
  if (i % 3000 === 0 && i) { const s = g.snapshots(0); if (!s[0][1].tiles) throw new Error('no tiles'); }
  if (i % 1800 === 0) console.log(`t=${Math.round(g.time)}s`, g.civs.map((c) => { const s = g.civSummary(c); return `${c.name}[${c.personality}] age${c.age} cities${s.cities} pop${s.pop} techs${s.techs} units${[...g.units.values()].filter((u) => u.owner === c.id).length} food${Math.round(c.res.food)} mat${Math.round(c.res.materials)} cr${Math.round(c.res.credits)} rr${c.researchRate.toFixed(2)} ${c.researching||'-'}`; }).join(' | '));
}
console.log(notes.slice(-60).join('\n'));
console.log('winner', g.winner, 'wall', Date.now() - t0, 'ms', 'max tick', maxTick.toFixed(1), 'ms', 'events', g.log.map((e) => e.kind).join(','));
