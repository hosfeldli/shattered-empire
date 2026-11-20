// AI planner fairness (2026-11-19, docs/performance/TELEMETRY_ANALYSIS_2026-11-19.md B2): with 8 brutal AIs the
// planner served the first due civ by seat, so seat 7 never planned (0 decisions, eliminated with 5,921 materials
// banked). runAI() now serves the most overdue civ; every seat must plan regularly and train units early on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 104;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { TICK_HZ } = await import('../server/sim/constants.js');

test('8 brutal AIs: every seat plans regularly and trains units in the first minutes', () => {
  const slots = Array.from({ length: 8 }, (_, i) => ({ human: false, difficulty: 'brutal', personality: ['builder', 'merchant', 'warlord'][i % 3] }));
  const g = new ActionGame({ id: 'fair-ai', seed: 59, style: 'pangaea', slots, teamSize: 4 });
  const plans = g.civs.map(() => 0), first = g.civs.map(() => null), last = g.civs.map(() => 0), gaps = g.civs.map(() => 0);
  const lastNext = g.civs.map((c) => c.aiPlan.next);
  const seen = new Set(g.units.keys()), trained = g.civs.map(() => 0);
  for (let i = 0; i < 150 * TICK_HZ; i++) {
    g.tick(); g.outbox.length = 0;
    for (const c of g.civs) {
      if (c.aiPlan.next === lastNext[c.id]) continue;   // planActionAI sets a new `next` on every plan
      lastNext[c.id] = c.aiPlan.next;
      plans[c.id]++;
      first[c.id] ??= g.time;
      if (plans[c.id] > 1) gaps[c.id] = Math.max(gaps[c.id], g.time - last[c.id]);
      last[c.id] = g.time;
    }
    if (i % 10 === 0) for (const u of g.units.values()) if (!seen.has(u.id)) { seen.add(u.id); if (!u.auto && u.owner >= 0) trained[u.owner]++; }
  }
  const alive = g.civs.filter((c) => c.alive);
  assert.equal(alive.length, 8, 'nobody falls in the first 150 s');
  for (const c of g.civs) {
    assert.ok(first[c.id] != null && first[c.id] <= 8, `seat ${c.id} planned first at ${first[c.id]} s`);
    // 8 brutal AIs ask for a plan every 2 s each (4/s) from a task that serves 3.33/s: each waits ~2.4 s, never far more
    assert.ok(plans[c.id] >= 50, `seat ${c.id} planned ${plans[c.id]} times in 150 s`);
    assert.ok(gaps[c.id] <= 4, `seat ${c.id} waited up to ${gaps[c.id].toFixed(1)} s between plans`);
    assert.ok(trained[c.id] >= 2, `seat ${c.id} trained ${trained[c.id]} units`);
  }
  const most = Math.max(...plans), least = Math.min(...plans);
  assert.ok(most - least <= 3, `plans are shared evenly: ${plans.join(', ')}`);
});
