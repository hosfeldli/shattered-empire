// SCALE Phase 1 (2026-11-20): a compact per-second server cost block for the client's performance readout (F3).
// Carried on econ messages as `perf` (1 Hz, every viewer):
//   { tps, target, ms: { tick, path, sim, combat, vis, ai, econ, net } }
//   tps    : ticks per wall second over the last few seconds (the loop's real rate)
//   target : 10 x speed (what the match asked for)
//   ms     : mean wall ms per tick over the last econ period, by system group:
//            path   = every nav.route() call, whichever system made it (scheduler.current)
//            sim    = unit motion and the other world systems, without their routing
//            combat = combat without its chase routes; vis = visibility; ai = AI planning without its routes;
//            econ   = field economy + production without routes; net = snapshot build + delta + stringify (per tick)
//            tick   = whole tick
// It reads the scheduler's cumulative per-system totals and wraps the nav instance's route() (same arguments, same
// result, as the telemetry probe does), so it never changes the simulation.
const SIM_SYSTEMS = ['navigation', 'capture', 'garrison', 'income', 'warzone', 'weather', 'victory', 'horde'];
const ECON_SYSTEMS = ['field economy', 'production'];
const r1 = (x) => Math.round(x * 10) / 10;

export function createPerfStats(game) {
  const route = new Map();      // system -> cumulative route ms
  let wrapped = null;
  const wrap = () => {
    const nav = game.nav;
    if (!nav || typeof nav.route !== 'function' || wrapped === nav) return;
    const orig = nav.route;
    nav.route = function (...args) {
      const t = performance.now();
      try { return orig.apply(this, args); } finally { const k = game.sched?.current || 'outside'; route.set(k, (route.get(k) || 0) + performance.now() - t); }
    };
    wrapped = nav;
  };
  wrap();
  let net = 0, ticks = 0, tickMs = 0, lastSys = new Map(), lastRoute = new Map(), lastBlock = null, lastAt = -1;
  const ring = [];   // [wallMs, ticks] for tps
  const total = (name) => game.sched?.stats.get(name)?.total || 0;
  return {
    /** After each loop interval: `n` ticks ran in `ms` wall (the whole interval). */
    interval(n, ms) {
      wrap();
      ticks += n; tickMs += ms;
      ring.push([performance.now(), n]); if (ring.length > 30) ring.shift();
    },
    /** Snapshot build + encode wall ms in this interval. */
    net(ms) { net += ms; },
    /** The block for this econ round (computed once per tick, shared by every viewer). */
    block(speed) {
      if (lastAt === game.tickN && lastBlock) return lastBlock;
      const sched = game.sched; if (!sched || !ticks) return lastBlock;
      const d = (name) => total(name) - (lastSys.get(name) || 0);
      const rd = (name) => (route.get(name) || 0) - (lastRoute.get(name) || 0);
      const own = (names) => names.reduce((a, k) => a + Math.max(0, d(k) - rd(k)), 0);
      let path = 0; for (const [k, v] of route) path += v - (lastRoute.get(k) || 0);
      const per = (x) => r1(x / ticks);
      let tw = 0, tn = 0; if (ring.length > 1) { tw = ring[ring.length - 1][0] - ring[0][0]; for (let i = 1; i < ring.length; i++) tn += ring[i][1]; }
      lastBlock = { tps: tw > 0 ? r1(tn * 1000 / tw) : null, target: 10 * (speed || 0),
        ms: { tick: per(d('tick')), path: per(path), sim: per(own(SIM_SYSTEMS)), combat: per(own(['combat'])), vis: per(d('visibility')), ai: per(own(['ai'])), econ: per(own(ECON_SYSTEMS)), net: per(net) } };
      lastAt = game.tickN;
      lastSys = new Map([...sched.stats].map(([k, s]) => [k, s.total || 0])); lastRoute = new Map(route);
      ticks = 0; tickMs = 0; net = 0;
      return lastBlock;
    },
  };
}
