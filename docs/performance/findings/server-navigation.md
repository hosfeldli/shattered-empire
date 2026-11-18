# Server navigation and movement (Agent 3, measured)

**Tool:** `tools/nav-perf-bench.mjs [scenarios|all|aiMatch] [--sizes=…] [--map=…] [--minutes=…] [--plain] [--prof]`
- Uses a fixed seed (7).
- Instruments the `ActionNavigation` and `MinHeap` prototypes plus the scheduler tasks.
- `--plain` turns the wrappers off; wrapped runs read about 1.5–2× higher than plain.
- The synthetic sweep ran alongside other benchmarks, so its absolute numbers are approximate. The trends hold.

**Raw data:** `docs/performance/data/nav-perf-*.json` and `docs/performance/data/profiles/*.cpuprofile`.

## What the production "navigation" metric measures
- It is only `unitMotion` (`actionGame.js:452`), which has a 15 ms budget. Its "over" count is the number of ticks above 15 ms.
- Human orders run `moveGroup` synchronously from the worker message handler (`worker.js:134`). That cost is not counted in the metric, but it delays the next tick.

## AI matches (plain runs)

| Run | Units | Navigation p50 / p95 / max | Ticks over budget |
|---|---|---|---|
| iron_basin, 6 AI | 230–275 | 1.7–1.9 / 5.8–6.5 ms | — |
| iron_basin, 6 AI | 364–382 | 3.1–3.6 / 10.5 / 178 ms | 1.2% |
| crossroads, 4 AI, end of match | ~175 | 3.4 / 16.6 ms | — |

- We did not reproduce production's level: 18.8 ms p50 at 228 units and 24% of ticks over budget, about 10× our numbers.
- Possible causes, all untested:
  - the slower Cloud Run vCPU
  - the map
  - human orders
  - an older match with many wrecks and stuck units

## Where `unitMotion` spends its time (CPU profile, iron_basin)

| Part | Share |
|---|---|
| Re-pathing (`route` from `stallCheck`, blocked re-route, `stopUnit` resume) | 36% |
| Collision tests (`allowed`) | 25% |
| Loop's own code | 20% |
| Spatial queries | 6% |
| Terrain `cost()` | 6% |

Across the whole subtree, `canMove`/`canStand` take 41% and `cost()` 25%. `roadAt` alone is 15%.

## Scaling: per-tick navigation ms, p50 / p95 / max

| N | Idle | Long move | Order every 0.5 s | Converge | Narrow pass | Terrain changes | Combat |
|---|---|---|---|---|---|---|---|
| 50 | 0.02/0.05/16 | 0.63/2.8/11 | 0.47/1.8/10 | 0.51/1.9/25 | 0.50/3.6/14 | 0.65/5.3/53 | 0.17/1.9/21 |
| 250 | 0.06/0.12/0.4 | 12.2/37/107 | 2.8/4.6/9.6 | 4.1/11/79 | 5.9/13/25 | 10.7/23/45 | 4.3/23/156 |
| 1000 | 0.18/0.29/1.0 | 58/100/452 | 15/35/240 | 33/100/322 | 48/136/630 | 68/209/690 | 21/54/169 |

- The long move grows superlinearly: the exponent is about 1.8 from N = 50 to 250.
- Synchronous order latency for one long move: 112 ms at N=50, 475 ms at 250, 819 ms at 500 and 1,666 ms at 1000.
- An unreachable order costs 290 ms at N=250 and 2.1 s at N=1000.

## Bottlenecks

**N1. Futile periodic re-routing of blocked units** (`actionOrders.js` `unitMotion` 389–393, `stallCheck` 409–418, `stopUnit` resume 84)
- `route()` ignores the units that are blocking, so it usually returns the same path. Units retry every 13 ticks with no limit.
- iron_basin totals:
  - 14,824 blocked re-routes (33.6 s)
  - 4,389 stall re-routes (9.4 s)
  - 3,975 resume re-routes (7.5 s)
- One unit made 1,050 route calls; another stayed blocked for 13.5 minutes.
- Fixes:
  - (a) per-unit backoff
  - (b) re-route only when a static obstacle is the cause
  - (c) a count-based route budget per tick
  - (d) treat a unit that is blocked near its goal as arrived

**N2. Collision geometry is recomputed without caching**
- `canMove` calls per moving unit per tick went from 1.2 to 6.7 as the match grew. `cost()` ran 109 M times in 45 minutes.
- `obstaclesAtTile` allocates a new array on every call.
- Fixes:
  - (a) a versioned "plain ground" fast path per tile
  - (b) let blocked units sleep instead of trying 8 sidesteps every tick
  - (c) cache `obstaclesAtTile`

**N3. Fine path building inside `route()`**
- About 1.6 ms per call: `localRoute` 34%, `line` 27%, `strategic` 26%, `nearest` 9%.
- Fixes:
  - lazy refinement
  - forward string-pulling
  - checking `localRoute` at grid nodes only

**N4. Group orders route every unit synchronously** (`moveGroup`/`candidate`/`primeGroup`)
- At N=1000, slots outside the flow-field tail fall back to full A* at 745 µs per call.
- Fixes:
  - one shared route plus a short per-unit tail
  - extend the flow-field tail to cover the formation
  - fill per-unit routes under a budget

**N5. Unreachable orders**
- There is no connected-region pre-check, so each unit makes two full attempts.
- Fix: pre-check with `componentOf`.

**N6. Every invalidation clears all caches**
- About 16–55 invalidations per minute, mostly from buildings being added or lost. `loseBuilding` invalidates twice.
- After an invalidation, the path-cache hit rate falls from 70% to 28%.
- Fix: track dirty regions so only affected caches are cleared.

**N7. Wrecks drive the blocking**
- 132–269 wreck tiles late in a match. A wreck is near 50–90% of long-blocked units.
- Creating a wreck does not invalidate paths. Any change here is a gameplay decision.

**N8. Attack-move resume and chase churn**
- 208 routes/s in a 1000-unit combat. This is small in AI matches.
- Fix: resume onto the remaining part of the old path.
