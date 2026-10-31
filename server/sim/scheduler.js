// Tick scheduler: every simulation system declares a cadence, a phase and a time budget.
//
//  * Phases spread the once-a-second systems over different ticks, so no single tick carries the
//    economy, supply, research, geology, diplomacy and governors all at once.
//  * The order of systems inside a tick is fixed and nothing here reads the clock to decide what
//    runs, so matches stay deterministic (save/restore and replay hash tests depend on it). The one
//    exception is opt-in: with `adaptive` on (live servers), deferrable work such as AI planning
//    slides to the next tick when a tick has already used most of its budget.
//  * Per-system timings are kept in small ring buffers: p50 / p95 / p99 / max and budget overruns.

const RING = 256;
const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

export class Scheduler {
  constructor(tasks, { tickBudget = 100, adaptive = false } = {}) {
    this.tasks = tasks.map((t) => ({ every: 1, phase: 0, budget: 5, deferrable: false, ...t }));
    this.tickBudget = tickBudget; this.adaptive = adaptive;
    this.stats = new Map();
    for (const t of this.tasks) this.stats.set(t.name, { ring: new Float32Array(RING), n: 0, over: 0, max: 0, deferred: 0 });
    this.stats.set('tick', { ring: new Float32Array(RING), n: 0, over: 0, max: 0, deferred: 0 });
    this.carry = new Set();      // deferrable tasks pushed to the next tick
  }

  record(name, ms, budget) {
    const s = this.stats.get(name); if (!s) return;
    s.ring[s.n % RING] = ms; s.n++;
    if (ms > s.max) s.max = ms;
    if (budget && ms > budget) s.over++;
  }

  run(tickN, ctx) {
    const t0 = now();
    for (const task of this.tasks) {
      const due = task.every <= 1 || (tickN + task.phase) % task.every === 0 || this.carry.has(task.name);
      if (!due) continue;
      if (this.adaptive && task.deferrable && !this.carry.has(task.name) && now() - t0 > this.tickBudget * 0.6) {
        this.carry.add(task.name); this.stats.get(task.name).deferred++; continue;
      }
      this.carry.delete(task.name);
      const a = now();
      task.fn(ctx, tickN);
      this.record(task.name, now() - a, task.budget);
    }
    this.record('tick', now() - t0, this.tickBudget);
  }

  // { system: { p50, p95, p99, max, calls, over, deferred } } over the recent window
  metrics() {
    const out = {};
    for (const [name, s] of this.stats) {
      const k = Math.min(RING, s.n);
      if (!k) continue;
      const a = Array.from(s.ring.subarray(0, k)).sort((x, y) => x - y);
      const q = (p) => +a[Math.min(k - 1, Math.floor(p * k))].toFixed(2);
      out[name] = { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s.max.toFixed(2), calls: s.n, over: s.over, deferred: s.deferred };
    }
    return out;
  }
  resetMax() { for (const s of this.stats.values()) s.max = 0; }
}
