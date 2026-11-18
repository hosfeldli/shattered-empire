// Polls a running server's /api/metrics every N seconds and appends one JSON line per running match
// (per-system tick p50/p95/p99/max, units, heap). Pair with the client's -perf-soak benchmark.
// Usage: node tools/metrics-poll.mjs [base=http://127.0.0.1:8137] [out=metrics.jsonl] [seconds=10]
import fs from 'node:fs';
const base = process.argv[2] || 'http://127.0.0.1:8137', out = process.argv[3] || 'metrics.jsonl', every = Number(process.argv[4] || 10);
const t0 = Date.now();
setInterval(async () => {
  try {
    const m = await (await fetch(base + '/api/metrics')).json();
    for (const x of m.matches.filter((x) => x.status === 'running'))
      fs.appendFileSync(out, JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), id: x.id, avg: x.avg, units: x.units, heapMb: x.heapMb, systems: x.systems }) + '\n');
  } catch (e) { /* server not up yet */ }
}, every * 1000);
