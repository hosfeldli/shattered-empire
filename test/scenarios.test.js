// Automated balance scenarios (equal-cost battles across seeds): soft counters hold, no single
// composition dominates, concentration is punished by artillery, supply decides endurance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, SCENARIOS } from './scenarios.mjs';

const SEEDS = [7, 11, 23];
const avg = (k, f = (r) => r.exchange) => SEEDS.map((s) => f(battle(s, SCENARIOS[k]))).reduce((a, b) => a + b, 0) / SEEDS.length;

test('equal-cost infantry mirror is roughly even', () => { const x = avg('infantryMirror'); assert.ok(x > 0.5 && x < 2, `exchange ${x}`); });
test('massed cheapest units lose to an equally priced infantry-and-support force', () => { const x = avg('massVsBalanced'); assert.ok(x < 0.7, `militia exchange ${x}`); });
test('tanks beat open infantry, but prepared defences with heavy guns blunt them', () => {
  const open = avg('tanksVsOpenInfantry'), prep = avg('tanksVsPrepared');
  assert.ok(open > 1.3, `tanks vs open infantry ${open}`);
  assert.ok(prep < open * 0.7, `tanks vs prepared ${prep} (open ${open})`);
});
test('artillery punishes a concentrated stack far more than a dispersed force', () => {
  const stack = avg('artilleryVsStack', (r) => r.lossB), spread = avg('artilleryVsDispersed', (r) => r.lossB);
  assert.ok(stack > spread * 1.8, `stacked losses ${stack}, dispersed ${spread}`);
});
test('a supplied force beats an equal force that has run out of supply', () => {
  const r = SEEDS.map((s) => battle(s, SCENARIOS.suppliedVsIsolated));
  assert.ok(r.every((x) => x.lossB > x.lossA), r.map((x) => `${x.lossA}/${x.lossB}`).join(' '));
});
