# Benchmark results: before and after

## Setup
- **Client A/B:** one Development build of the final tree. Run A used `-perf-legacy all`, which restores every replaced client code path: blocking geometry apply, no street cache, no spoil cache, synchronous territory, and the old base cache key. Run B was the normal build.
- **Order and conditions:** the runs went back to back on an idle machine (no benchmark agents running), using the same local server (final tree), the same seed (7, 4-AI observe) and the same settings (1920×1080, Ultra, VSync off, 4× match speed, 12 real minutes, about 47 game minutes).
- **Hardware:** i5-8600K and RX 7600 XT.
- **Raw data:**
  - `data/client/soak-ab-legacy.jsonl`, `data/client/soak-ab-new.jsonl`
  - server metrics: `data/client/server-ab-*.jsonl`
- **Reproduce:** see BASELINE.md, then `node tools/soak-report.mjs data/client/soak-ab-new.jsonl --label=static`.
- **Exceptions:** zero in both player logs (`player-ab-*.log`).

## Static camera on the busiest area (scenarios D, E, G)

| Game min | Units | FPS A → B | p50 ms | p95 ms | p99 ms | Worst frame ms | Frames >33 ms per 15 s | GC KB/frame |
|---|---|---|---|---|---|---|---|---|
| 0–5 | 47 | 188 → 206 | 4.4 → 4.4 | 5.8 → 5.6 | 9.9 → 8.4 | 536 → 297 | 8.3 → 7.0 | 75 → 71 |
| 5–10 | 75 | 144 → 171 | 5.9 → 5.4 | 8.1 → 7.8 | 15.2 → 10.8 | 475 → 201 | 9.0 → 8.7 | 129 → 116 |
| 10–20 | 113 | 95 → 108 | 8.0 → 8.3 | 11.5 → 11.4 | 73.7 → 21.0 | 644 → 264 | 19.7 → 10.0 | 198 → 197 |
| 20–30 | 151 | 54 → 93 | 153 → 9.4 | 211 → 14.5 | 416 → 39.3 | 1256 → 394 | 22.8 → 19.0 | 2654 → 276 |
| 30–45 | 190 | 30 → 87 | 10.9 → 10.2 | 255 → 15.3 | 839 → 48.8 | 1484 → 354 | 19.3 → 18.4 | 1080 → 299 |

## Camera panning across the map (scenario F)

| Game min | FPS A → B | p95 ms | p99 ms | Worst frame ms |
|---|---|---|---|---|
| 0–5 | 269 → 291 | 4.6 → 4.5 | 6.9 → 6.7 | 642 → 178 |
| 5–10 | 127 → 155 | 9.5 → 8.4 | 86.3 → 12.6 | 516 → 225 |
| 10–20 | 112 → 136 | 10.2 → 10.0 | 43.6 → 15.7 | 394 → 208 |
| 20–30 | 55 → 119 | 261 → 11.5 | 539 → 33.1 | 1237 → 357 |
| 30–45 | 38 → 105 | 360 → 12.8 | 716 → 42.3 | 1505 → 311 |

## What remains in B
- **Worst frames of 200–400 ms** come from the `city` phase: base compounds still being composed from scratch when a compound's key really changes, such as a new parcel or a tier change.
- **About 18 frames over 33 ms per 15 s.** In 15 s at about 90 FPS that is roughly 1.3% of frames.
- **Steady costs late in the match:**
  - `units` is now the largest steady phase, at about 4–5 ms (register C9).
  - GC churn is about 250–300 KB per frame (C7).
- **GPU:** p95 stays at about 9–11 ms at 1080p, so the GPU is not the limiter.

## Server (headless, from the server implementation log)
All kept server changes are bit-identical: the `stateHash` matches HEAD every 1,500 ticks.

| Change | Measurement | Before | After |
|---|---|---|---|
| Visibility | S1000 pass p50/p95, quiet machine | 2.77/8.63 ms | 1.59/3.95 ms |
| Visibility | Cache misses, p95 | 1046 | 132 |
| Unreachable orders | N=1000 command time, quiet machine | 1,030/1,738 ms | 215/361 ms |
| Group order latency | Repeat order, N=250 | 179 ms | 29 ms |
| Group order latency | Repeat order, N=1000 | 1,252 ms | 677 ms |
| Group order latency | AI route time over the G soak | 3,643 ms | 2,566 ms |
| Econ message size | p50 | 44.4 KB | 33.3 KB (−18%) |
| Cache invalidations | G soak | 509 | 397 |

The data is in `data/*-before.json` and `data/*-after.json`.

## Caveats
- This is one machine at 1080p. 1440p/4K and weaker CPUs or GPUs were not measured.
- The client is a Development build. A non-development player should be somewhat faster; it was not measured separately.
- The A/B used the final tree's server, which includes the gameplay overhaul (12-man squads and so on). Both runs saw the same match, so the comparison isolates the client code paths. It is not a comparison of the whole game against the shipped 4bd3f1d version, whose earlier, noisier numbers are in BASELINE.md.
- Production (Cloud Run) server timing after the changes has not been measured, because nothing has been deployed.

## Pass 2 (2026-11-18): every zoom, final tree, idle machine
- **Build:** one Development build of the final tree, which includes all gameplay work from 2026-11-18.
- **Runs:** Run A with `-perf-legacy all`, which also turns off unit culling, tree scars, sliced compose and decode pooling. Run B is the normal build.
- **Settings:** back to back on an idle machine, the same local server (final tree), seed 7, 4-AI observe, 4× speed, 14 real minutes each, `-perf-zooms 2.5,12,30,80`. Each zoom gets a 15 s static window and a 9 s pan window.
- **Rows:** game minute 20 to the end, about 200 units.
- **Raw data:** `data/final2-legacy.jsonl` and `data/final2-new.jsonl`. Reproduce with `node tools/soak-report.mjs data/final2-new.jsonl --zoom --from=20`.
- **Exceptions:** zero in both player logs.

| Window (camera distance) | FPS A → B | p95 ms | p99 ms | Worst frame ms | Frames >33 ms per window | GC KB/frame |
|---|---|---|---|---|---|---|
| pan, 2.5 (closest) | 114 → 206 | 11.3 → 8.6 | 19.6 → 11.2 | 557 → 24 | 5.6 → 0.0 | 165 → 34 |
| static, 2.5 | 95 → 152 | 12.6 → 9.7 | 54.3 → 13.8 | 901 → 31 | 10.4 → 0.0 | 230 → 52 |
| pan, 12 | 125 → 220 | 10.2 → 7.6 | 16.0 → 12.3 | 628 → 35 | 4.8 → 0.3 | 139 → 37 |
| static, 12 | 107 → 159 | 11.0 → 9.5 | 18.7 → 14.1 | 574 → 27 | 9.3 → 0.0 | 171 → 44 |
| pan, 30 (play zoom) | 120 → 221 | 10.6 → 8.8 | 35.7 → 11.5 | 589 → 29 | 6.0 → 0.0 | 163 → 38 |
| static, 30 | 81 → 119 | 14.8 → 11.6 | 29.5 → 16.5 | 873 → 40 | 10.3 → 0.3 | 234 → 69 |
| pan, 80 (strategic) | 141 → 163 | 11.3 → 10.5 | 44.7 → 13.8 | 535 → 30 | 6.8 → 0.0 | 161 → 54 |
| static, 80 | 79 → 100 | 14.2 → 11.5 | 75.8 → 17.4 | 925 → 60 | 9.8 → 0.2 | 265 → 78 |

**Notes**
- **Unit culling:** below strategic zoom, B skips 133–200 off-screen units. Unit instances drop from 1,479–2,863 to 50–1,396.
- **Trees:** trees regrown per window go from 115–257 to 0–0.3, and chunk rebuilds roughly halve.
- **Strategic zoom:** the 8–16% drop at zoom 80 seen on the busy machine (IMPLEMENTATION_LOG, Pass 2) does not reproduce here. B is 16–27% faster.
- **Remaining:** the worst frame is now 23–60 ms (in A it was the city compose, at 535–925 ms). GC is 34–78 KB per frame, mostly the network decode.
