// The client's --battle=massive staging reproduced headless: the sandbox match, the 500 vs 500
// scenario, a third of side A fortified and the rest attack-moving into the arena. Reports tick
// timing and the slowest systems. Usage: node tools/sandbox-bench.mjs [seconds=60] [scenario=massive]
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { makeSandbox } from '../server/sim/sandbox.js';
const seconds = Number(process.argv[2] || 60), key = process.argv[3] || 'massive';
const g = new Game({ id: 'sbx', seed: Number(process.argv[4] || 5), slots: [{ human: true }, { personality: 'builder' }], rebels: false, ruleset: WORKS_RULESET });
makeSandbox(g); g.sandboxReveal = true; for (const c of g.civs) if (!c.human) c.ai = null;
g.civs[0].connected = true;
const r = g.command(0, { c: 'sandbox', op: 'scenario', key }).reply.scenario;
const A = r.A;
g.command(0, { c: 'fortify', units: A.slice(0, A.length / 3 | 0) });
const ticks = [];
for (let i = 0; i < seconds * 10; i++) {
  if (i === 60) g.command(0, { c: 'move', units: A.slice(A.length / 3 | 0), tile: r.arena, attackMove: true });
  const t0 = performance.now(); g.tick(); ticks.push(performance.now() - t0);
  if (i % 2 === 0) g.snapshots(null, i % 10 === 0);
  g.outbox.length = 0;
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const m = g.sched.metrics();
console.log(JSON.stringify({ units: g.units.size, tick: { p50: q(ticks, .5), p95: q(ticks, .95), max: q(ticks, 1) },
  top: Object.entries(m).filter(([k]) => k !== 'tick').sort((a, b) => b[1].p95 - a[1].p95).slice(0, 6).map(([k, v]) => `${k} p95 ${v.p95} max ${v.max}`) }));
