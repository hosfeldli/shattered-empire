// SCALE Phase 1 (2026-11-20): the econ `perf` block (server/perfStats.js) has the documented shape and never changes
// the simulation (it reads the scheduler's totals and wraps nav.route() with the same arguments and result).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { stateHash } = await import('../server/sim/persist.js');
const { createPerfStats } = await import('../server/perfStats.js');

const slots = [{ human: false, difficulty: 'normal', personality: 'warlord' }, { human: false, difficulty: 'normal', personality: 'builder' }];
const make = () => new ActionGame({ id: 'perf', seed: 4, style: 'pangaea', teamSize: 1, slots });

test('perf block: shape, per-tick means, hash-neutral', () => {
  const a = make(), b = make();
  const stats = createPerfStats(b);
  let block = null;
  for (let i = 1; i <= 600; i++) {
    a.tick(); a.outbox.length = 0;
    const t0 = performance.now(); b.tick(); b.outbox.length = 0;
    stats.interval(1, performance.now() - t0);
    if (i % 2 === 0) stats.net(0.5);
    if (i % 10 === 0) block = stats.block(1);
  }
  assert.equal(stateHash(a), stateHash(b));
  assert.equal(block.target, 10);
  assert.ok(block.tps > 0);
  for (const k of ['tick', 'path', 'sim', 'combat', 'vis', 'ai', 'econ', 'net']) assert.ok(Number.isFinite(block.ms[k]) && block.ms[k] >= 0, k);
  assert.equal(block.ms.net, 0.3);   // 5 x 0.5 ms over 10 ticks, rounded to 0.1
  assert.ok(block.ms.tick >= block.ms.sim);
  assert.equal(stats.block(1), block, 'one block per tick, shared by every viewer');
});
