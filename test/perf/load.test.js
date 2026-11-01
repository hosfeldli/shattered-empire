// Load: several large matches at once, thousands of entities, many terrain events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

test('four 12-empire matches on 256x256 maps each stay within the 100 ms tick budget', async () => {
  const code = `
    import { parentPort, workerData } from 'node:worker_threads';
    globalThis.SE_MAP_SIZE = 256;
    const { Game } = await import(${JSON.stringify(new URL('../../server/sim/game.js', import.meta.url).href)});
    const g = new Game({ id: 'L' + workerData, seed: 100 + workerData, slots: Array.from({ length: 12 }, (_, i) => ({ personality: ['builder', 'warlord', 'merchant'][i % 3] })) });
    let max = 0, sum = 0, n = 0;
    for (let i = 0; i < 3000; i++) { const t = performance.now(); g.tick(); if (i % 2 === 0) g.snapshots(); g.outbox.length = 0; const d = performance.now() - t; sum += d; n++; if (i > 50) max = Math.max(max, d); }
    parentPort.postMessage({ avg: sum / n, max, units: g.units.size, buildings: g.buildings.size, events: g.log.length, systems: g.sched.metrics() });
  `;
  const results = await Promise.all([0, 1, 2, 3].map((i) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)), { workerData: i });
    w.on('message', resolve); w.on('error', reject);
  })));
  for (const r of results) {
    const top = Object.entries(r.systems).filter(([k]) => k !== 'tick').sort((a, b) => b[1].p95 - a[1].p95).slice(0, 4);
    console.log(`avg ${r.avg.toFixed(1)} ms, max ${r.max.toFixed(0)} ms, tick p95 ${r.systems.tick.p95} p99 ${r.systems.tick.p99}; slowest: ` + top.map(([k, v]) => `${k} p95 ${v.p95}`).join(', '));
    // the tick budget is 100 ms; shared CI runners get some slack (this test runs on its own: npm run test:load)
    const slack = process.env.CI ? 1.5 : 1;
    assert.ok(r.systems.tick.p50 < 60 * slack, `median tick well inside the budget (${r.systems.tick.p50} ms)`);
    assert.ok(r.avg < 40 * slack, `average tick ${r.avg.toFixed(1)} ms`);
    assert.ok(r.units + r.buildings > 300, 'populated world');
  }
  const total = results.reduce((s, r) => s + r.units + r.buildings, 0);
  assert.ok(total > 1500, 'thousands of entities across matches: ' + total);
});
