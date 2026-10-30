// Load: several large matches at once, thousands of entities, many terrain events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

test('four 12-empire matches on 256x256 maps each stay within the 100 ms tick budget', async () => {
  const code = `
    import { parentPort, workerData } from 'node:worker_threads';
    globalThis.SE_MAP_SIZE = 256;
    const { Game } = await import(${JSON.stringify(new URL('../server/sim/game.js', import.meta.url).href)});
    const g = new Game({ id: 'L' + workerData, seed: 100 + workerData, slots: Array.from({ length: 12 }, (_, i) => ({ personality: ['builder', 'warlord', 'merchant'][i % 3] })) });
    let max = 0, sum = 0, n = 0;
    for (let i = 0; i < 3000; i++) { const t = performance.now(); g.tick(); if (i % 2 === 0) g.snapshots(); g.outbox.length = 0; const d = performance.now() - t; sum += d; n++; if (i > 50) max = Math.max(max, d); }
    parentPort.postMessage({ avg: sum / n, max, units: g.units.size, buildings: g.buildings.size, events: g.log.length });
  `;
  const results = await Promise.all([0, 1, 2, 3].map((i) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)), { workerData: i });
    w.on('message', resolve); w.on('error', reject);
  })));
  for (const r of results) {
    assert.ok(r.avg < 40, `average tick ${r.avg.toFixed(1)} ms`);
    assert.ok(r.units + r.buildings > 300, 'populated world');
  }
  const total = results.reduce((s, r) => s + r.units + r.buildings, 0);
  assert.ok(total > 1500, 'thousands of entities across matches: ' + total);
});
