# Performance recovery: final report (2026-11-17/18)

## Why the game got slower as matches developed
Two independent problems overlapped.

### 1. The client did more main-thread rebuild work as the battlefield accumulated history
Late-match freezes came from a few systems that redid whole-map or whole-compound work on the main thread every time something changed:
- **Blocking terrain-job waits (0.4–1.2 s frames).** Every crater, trench or height update made the main thread wait for the terrain mesh jobs reading those arrays.
- **Base compounds and their streets were recomposed repeatedly.**
  - The compound cache was invalidated when anyone built a road anywhere.
  - Street draping (28–60 ms per map cell) was redone on any change in the cell.
- **The battlefield layer re-placed all crater debris (up to 14k clods) every second.** Its cost grew with accumulated impacts.
- **The territory texture was rebuilt on the main thread** (60–130 ms) at every ownership change.

None of these are GPU costs. GPU p95 stayed at 6–17 ms the whole time. No objects leaked: GameObject, mesh, material and texture counts stayed flat for 80 minutes.

### 2. The authoritative server's per-tick cost grew superlinearly with moving units
In production, navigation took 18.8 ms p50 per tick at only 228 units. The causes:
- Blocked units re-routing every 1.3 s against the obstacle that blocks them.
- Collision geometry recomputed without caching.
- AI and player group orders routing every unit synchronously (AI p99 up to 370 ms).
- Visibility was the second steady cost.

Server spikes delay snapshots, which the client shows as freezes.

## What was changed
The details, with per-change before and after numbers, are in [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md).

**Client** (all can be reverted in one build with `-perf-legacy`):
- Deferred geometry apply.
- Local base-cache key and lane content check.
- Per-hex street cache.
- Per-tile crater spoil cache.
- Threaded territory rebuild.

**Server:**
- Unreachable-order pre-check.
- Batched group routing.
- Per-team visibility stamping.
- Econ `bf`/`fw` gating.
- Duplicate cache invalidation removed.

All server changes keep the simulation bit-identical. Two attempted server changes were measured and reverted because they did not help: re-route backoff and autosave caching.

## Results (measured; see [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md))
Same build, same match, back-to-back runs, legacy paths compared with new ones, at about 190 units after 30–45 game minutes:

| Measure | Legacy paths | New paths |
|---|---|---|
| Static camera FPS | 30 | 87 |
| p95 frame | 255 ms | 15 ms |
| p99 frame | 839 ms | 49 ms |
| Worst frame | 1.48 s | 0.35 s |
| Panning FPS | 38 | 105 |
| Panning p99 | 716 ms | 42 ms |
| GC allocation per frame | 1–2.7 MB | 0.25–0.3 MB |

Server, headless:
- Visibility pass p95 halved.
- Unreachable orders 4–6× faster.
- Group orders 1.5–6× faster.
- Econ bytes −18%.

## Correctness
- `npm test`: 383 run, 382 pass, 1 skipped. The suite includes new equivalence tests:
  - visibility, byte-identical to the old implementation;
  - group routes, identical match hash;
  - econ gating, where the client's kept copy equals the full snapshot.
- The load test passes.
- Client: Unity compiles with no errors, and there were no exceptions in either soak.

## Does it now scale?
Partly.
- **Fixed:** the late-match collapse (FPS falling to 30 with second-long freezes) is gone in the measured scenario. The game now holds about 87–105 FPS at 190 units with p99 under 50 ms.
- **Client limits remaining:**
  - Occasional 200–400 ms frames when a base compound really changes and is composed from scratch.
  - About 1% of frames over 33 ms.
- **Server limits remaining:**
  - Navigation collision cost (N2) is the next limiter.
  - Production Cloud Run timing has not been measured after these changes.
  - Battles of 500–1000 units still give tick p95 of 15–30 ms locally, which roughly doubles on Cloud Run.

## Next steps (ranked; see [OPTIMIZATION_PLAN.md](OPTIMIZATION_PLAN.md))
1. **Base compound compose:** time-slice it or move it to a job, to remove the remaining 200–400 ms frames.
2. **Units renderer:** frustum culling, then a Burst job (about 4–5 ms steady).
3. **Server navigation collision:** a cache plus letting blocked units sleep (N2).
4. **GC:** capture a profile, then a streaming snapshot decoder.
5. **Production measurement after deploy:** `/api/metrics` on Cloud Run.
6. **IL2CPP player build.**

## Tooling added
- `GameBootstrap.Bench.cs`: `-perf-soak` client soak benchmark.
- `PerfFlags.cs`: `-perf-legacy` A/B switches.
- Per-part timers.
- `tools/soak-report.mjs`, `tools/metrics-poll.mjs`, `tools/action-perf-bench.mjs`, `tools/nav-perf-bench.mjs`.
