# Baseline measurements (before optimisation)

Commit 4bd3f1d, measured 2026-11-17. All numbers below were observed; none are estimates unless marked.

## Test machine and configuration

| Item | Value |
|---|---|
| CPU | Intel i5-8600K, 6 cores |
| GPU | AMD Radeon RX 7600 XT |
| RAM | 32 GB |
| OS | Windows 11 |
| Unity | 6000.3.28f1, URP, Mono scripting backend |
| Client build | Windows x64 Development build (`BuildOptions.Development`), not Deep Profiling |
| Display | 1920×1080 windowed, quality Ultra (the default "high" setting maps to the Ultra preset), VSync off, no frame cap |
| Server | Local Node v26 server built from the same commit, on the same machine (`PORT=8137`) |

## How to reproduce

Client soak:

```
# 1) server (pinned commit), and its metrics
PORT=8137 HOST=127.0.0.1 node server/index.js
node tools/metrics-poll.mjs http://127.0.0.1:8137 server.jsonl 10

# 2) client (Development build), 4-AI observed match, seed 7, 4x speed
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode observe -seed 7 -perf-soak 25 -perf-speed 4 -perf-window 15 \
  -perf-out soak.jsonl -vsync 0 -screen-fullscreen 0 -screen-width 1920 -screen-height 1080

# 3) report
node tools/soak-report.mjs soak.jsonl --label=static
node tools/soak-report.mjs --server server.jsonl
```

**What the soak does** (`unity/Assets/ShatteredEmpires/Runtime/App/GameBootstrap.Bench.cs`):
- It watches an AI-only match as it develops.
- It alternates two windows:
  - a 15 s **static** window, with the camera on the busiest 4×4-hex block at play zoom (30);
  - a 9 s **pan** window, sweeping across the map at the same zoom.
- For each window it records:
  - frame-time percentiles, FrameTimingManager CPU/GPU, and per-phase `Present` timings;
  - network apply time, split into geo, units, trenches, impacts and buildings;
  - HUD time;
  - city-compose and warzone breakdowns;
  - ProfilerRecorder render counters, GC allocated per frame, memory, and live object counts.

Server-only benchmarks (headless, deterministic):
- `node tools/action-perf-bench.mjs [A,B,S50..S1000,D50..D1000,G,DUEL]`: simulation and AI scaling, per system.
- `node tools/nav-perf-bench.mjs [all|aiMatch] [--plain]`: navigation scaling.

**Raw data**
- `docs/performance/data/client/soak-baseline-dev.jsonl`: 57 windows, game minutes 1–81.
- `docs/performance/data/client/server-baseline.jsonl`
- `docs/performance/data/client/soak-attrib-dev.jsonl`: the same seed, with attribution timers.
- `docs/performance/data/action-perf-*.json`, `nav-perf-*.json` (server)
- `docs/performance/data/prod-metrics-2026-11-17.json`: live Cloud Run metrics.

## Client: static camera on the battle (scenarios A, B, D, E, G combined over match age)

| Game min | Units | FPS | p50 ms | p95 ms | p99 ms | Worst ms | Frames >33 ms per 15 s | GPU p95 ms | GC KB/frame | Worst main-thread phases (avg / worst ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| 0-5 | 43 | 161 | 5.0 | 9.0 | 13.3 | 583 | 10 | 8.0 | 68 | city 1.0/580, units 1.0/47.6 |
| 5-10 | 72 | 133 | 6.1 | 9.8 | 16.9 | 445 | 8 | 8.9 | 108 | city 1.3/439, net 0.1/335 |
| 10-20 | 97 | 67 | 9.6 | 22.2 | 202 | 766 | 26 | 12.6 | 326 | city 3.8/994, net 1.4/622, warzone 0.6/93 |
| 20-30 | 131 | 55 | 10.8 | 37.4 | 320 | 1017 | 26 | 14.9 | 479 | net 3.7/693, city 4.6/685, warzone 1.4/178 |
| 30-45 | 178 | 39 | 13.0 | 52.8 | 435 | 1075 | 29 | 17.2 | 605 | net 5.3/909, city 5.6/726, warzone 2.6/285 |
| 45-60 | 187 | 35 | 11.1 | 62.1 | 600 | 1356 | 23 | 14.9 | 606 | city 6.5/1116, net 8.8/962, warzone 2.8/329 |
| 60-90 | 185 | 53 | 10.7 | 24.0 | 335 | 1506 | 22 | 12.8 | 380 | net 4.3/1027, city 3.4/797 |

## Client: camera panning across the map (scenario F)

| Game min | Units | FPS | p50 | p95 | p99 | Worst | GPU p95 | Worst phases |
|---|---|---|---|---|---|---|---|---|
| 0-5 | 47 | 178 | 4.5 | 9.3 | 12.8 | 387 | 6.4 | city 0.8/384 |
| 10-20 | 94 | 87 | 7.7 | 16.8 | 115 | 1009 | 11.1 | city 2.1/564, net 0.7/549 |
| 30-45 | 176 | 53 | 10.1 | 26.8 | 305 | 1146 | 14.6 | net 3.6/749, city 4.3/517 |
| 45-60 | 188 | 33 | 12.6 | 188 | 622 | 1310 | 17.0 | net 14.5/1117, city 7.7/976 |

**Memory and objects:** GameObjects, meshes, materials and textures stayed flat for 81 game-minutes (64, 489–495, 112, 176). GFX memory rose from 291 to 516 MB and total used memory reached about 1.1 GB. The managed heap fluctuated between 72 and 224 MB.

## Server

### Local 4-AI observed match (same run, `/api/metrics` every 10 s)

| Real min (×4 game) | Units | Tick p50 | Tick p95 | Tick p99 | Nav p95 | Vis p95 | AI p95 | AI p99 | Combat p95 |
|---|---|---|---|---|---|---|---|---|---|
| 0-5 | 70 | 1.1 | 7.2 | 23 | 3.1 | 4.9 | 7.6 | 33 | 0.6 |
| 5-10 | 131 | 3.2 | 34.6 | 127 | 24.6 | 8.5 | 25.2 | 196 | 1.8 |
| 10-20 | 187 | 3.5 | 34.1 | 207 | 16.8 | 5.7 | 117 | 358 | 2.3 |
| 20-30 | 186 | 1.7 | 14.2 | 188 | 3.9 | 2.7 | 106 | 252 | 1.0 |

**Production** (Cloud Run, match 646585, 228 units, about 54 game-minutes):

| System | p50 | p95 | p99 | Notes |
|---|---|---|---|---|
| Tick | 22.5 ms | 45.8 ms | 79 ms | — |
| Navigation | 18.8 ms | 39 ms | — | Over its 15 ms budget on 24% of ticks |
| Visibility | 5.5 ms | — | — | — |

Server scaling tables (S*, D*, G, and navigation sweeps) are in [findings/server-simulation.md](findings/server-simulation.md) and [findings/server-navigation.md](findings/server-navigation.md).

## Initial classification
- **Client: CPU, main-thread-bound, with match-age accumulation.** GPU p95 stays at 6–17 ms while frame p99 reaches 200–600 ms. The stalls are single long main-thread frames from rebuild work, not a steady GPU load. Average FPS also falls (161 → 35) as per-frame work grows with units and accumulated battlefield data.
- **Server: CPU-bound in navigation and AI pathfinding, superlinear in moving units.** Spikes come from synchronous group routing (AI planning and orders). Visibility is the steady second-largest cost.
- **Synchronisation:** server spikes of 100–370 ms delay the 5 Hz snapshots. The client interpolates 250 ms behind, so spikes above that are visible as freezes.
- **Memory:** no leaks of objects. Battlefield data (`bf`) and GC allocation volume grow with match age.

## Limitations
- One machine, at 1080p only. 1440p/4K and weaker GPUs are not measured.
- The client is a Development build. An ordinary non-development player has not been measured yet; it is planned for the final comparison.
- Game time runs at 4× in the soak. Snapshot cadence per real second is unchanged (5 Hz), but four times more game events happen per real second than in normal play. This is a stress condition, not equivalent to normal 1× play.
- Multiplayer (scenario H) is covered only by the server benchmarks (`load-bench`/`live-bench` are the legacy ruleset); no multi-client capture yet.
