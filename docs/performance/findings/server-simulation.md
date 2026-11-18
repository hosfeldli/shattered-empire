# Server simulation, AI and combat scaling (Agent 2, measured)

**Setup**
- Machine: i5-8600K, Node v26.13. A Cloud Run vCPU is about 2× slower.
- Calibration: at about 190 units the bench shows a visibility pass of 2.4–2.7 ms, while production shows 5.5 ms at 228 units.

**Tool:** `tools/action-perf-bench.mjs [A,A-large,B,D50..D1000,S50..S1000,G,DUEL] [--deep] [--workers=N] [--minutes=M]`
- Runs are deterministic: seed 7 reproduces the same final state.
- Each scheduler system is timed.
- `nav.route` time is broken down by calling system.
- The bench also measures the snapshot path exactly as `worker.js` runs it, the synchronous autosave stringify, GC pauses and entity counts.

**Raw data:** `docs/performance/data/action-perf-*.json` and `action-perf-*.log`. The clean sequential runs are `action-perf-scaling.log` and `action-perf-soak-G2.log`.

## Stationary battle scaling (S*, units made immortal)

| Units | Tick p50/p95/p99 ms | Combat mean ms | Combat µs/unit | Visibility pass p50/p95 | Fog misses p95 | Snapshot bytes p50 |
|---|---|---|---|---|---|---|
| 50 | 0.31/1.79/23.0 | 0.42 | ~8 | 0.44/2.8 | 12 | 5.6K |
| 100 | 0.54/2.85/6.5 | 0.44 | 4.2 | 0.63/2.9 | 18 | 7.0K |
| 250 | 1.36/4.63/7.0 | 1.07 | 4.2 | 0.96/4.3 | 41 | 12K |
| 500 | 3.72/9.67/17.6 | 3.39 | 6.7 | 1.84/6.1 | 72 | 18K |
| 1000 | 8.14/18.7/26.5 | 7.37 | 7.3 | 4.44/10.6 | 1046 | 29K |

**Moving battles (D*)**

| Scenario | Tick p50/p95 ms | Navigation ms | Combat ms |
|---|---|---|---|
| D500 | 3.9/14.2 | 2.3 | 2.1 |
| D1000 | 10.8/28.9 | 5.5 | 6.1 |

## Soak G: 4 AI, Crossroads, 40 game-minutes

| Minute | Units | Buildings | Tick p50/p95/p99 | Navigation | Combat | Visibility | AI | `route` ms/tick | Snapshot bytes p50/max | Save stringify |
|---|---|---|---|---|---|---|---|---|---|---|
| 5 | 56 | 19 | 0.45/2.6/13.6 | 0.23 | 0.10 | 0.21 | 0.33 | 0.10 | 9.4K/15K | 3.1 ms / 1.25 MB |
| 10 | 84 | 63 | 0.92/4.4/12.7 | 0.54 | 0.20 | 0.33 | 0.29 | 0.14 | 13.6K/33K | 4.6 / 1.38 |
| 20 | 138 | 74 | 2.15/6.6/29.0 | 1.17 | 0.47 | 0.60 | 0.64 | 0.41 | 13.9K/46K | 15.0 / 1.58 |
| 25 | 183 | 87 | 3.03/8.8/36.4 | 1.63 | 0.61 | 0.72 | 1.05 | 0.58 | 16.2K/60K | 14.6 / 1.67 |
| 40 | 191 | 136 | 4.14/10.9/27.8 | 2.82 | 0.73 | 0.70 | 0.67 | 1.56 | 11.5K/53K | 9.8–16.7 / 1.8 |

**Spikes and route time**
- The worst tick was 371 ms, and the AI system alone peaked at 367 ms.
- `route` time by caller over the run:
  - AI: 5.2 s, which is 31% of all AI time; one AI tick spent 285 ms in it.
  - Navigation: 8.0 s.
  - Production: 1.0 s, peaking at 27 ms in one tick.
- GC paused ticks for only 1.16 s over 2,400 s of game time.

**Growth with match age vs. unit count**
- At a constant unit count (scenario B, 288 units at peace), cost does not grow over time.
- Growth with match age comes from:
  - the `bf` block, from 68 B to 34 KB, which is 83% of the econ snapshot; the spectator's econ view grew from 4 KB to 102 KB;
  - the save stringify;
  - the cost of each `route` call.

## Findings

**S1. Navigation and route (owned by Agent 3)**
- Largest cost in every scenario with moving units; per tick it grew 12× over the soak.
- The AI and production spikes are calls into `moveGroup` → `nav.route`.

**S2. Visibility: `refreshVisibility`/`reveal` (`actionGame.js:394-445`)**
- Each pass calls `reveal` (U+B) × team members × 2 times, and each call writes about 90–130 disk tiles.
- On a cache miss it allocates a `disk()`, a `filter` and `centerOf` objects.
- The FIFO cache (3,500 entries) is keyed by quantised sub-tile position and radius, so at about 1,000 units it thrashes (1,046 misses per pass at p95).
- Per civ there is also an N-tile explored loop and a `siteWire` call, which filters all units and buildings for each own site.
- **Fix A:** stamp once per team and copy the result to each member; key the cache by tile and radius; store disks as `Int32Array`.
- **Fix B:** keep a coverage grid with reference counts, updated only for sources that moved.
- **Validation:** compare `civ.visible` and `civ.detect` byte for byte against a reference run.

**S3. Combat acquisition (`actionCombat.acquire`)**
- About U/3 queries per tick over all owners within range + 0.45 (cell size 3.2). This is O(U·k) and becomes superlinear when units are dense.
- `targets.query` takes 54% of combat time. Combat p99 at S500 is 12.8 ms.
- `cover()` loops over all sites on every damage call.
- **Fix A:** spatial index per team.
- **Fix B:** precompute the list of outpost sites used by `cover()`. This does not change behaviour.

**S4. `bf` in the econ snapshot (`battlefield.js:270-317`)**
- The whole block is sent at 1 Hz with no delta encoding, and its size grows with match age.
- **Fix:** gate it on `bfVer` per viewer, or send per-tile deltas.

**S5. Autosave (`worker.js` `saveAsync`)**
- The synchronous `JSON.stringify(serializeGame())` grows with the match: 3 ms at minute 5, 10–21 ms at minutes 35–40.
- It runs every 60 game-seconds.
- **Fix:** cache the base64 world arrays, keyed on `world.ver`.

**S6. AI planning spikes**
- p99 is 24.8 ms and the maximum 367 ms, mostly from `route`.
- **Fix:** share one route per group, and spread planning across ticks.
