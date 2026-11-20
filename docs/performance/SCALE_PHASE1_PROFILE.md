# Scale Phase 1: where the time goes at 8,000 units and 4,000 buildings (2026-11-20)

Ticket: an 8-player free-for-all with 1,000 units per player (8,000) and up to 4,000 buildings must hold full
simulation speed on the server (10 ticks/s) with clients at 30 fps or better. This pass only **measures**; nothing in
the simulation or renderers was rewritten. Phase 2 proposals are at the end.

**Headline**
- **Server: 2.2 ticks/s against 10 (22 % of real time) at 8 × 1,000 units + 4,000 buildings.** Every loop interval
  is over the 100 ms budget (mean 448 ms, p95 682 ms, max 1.3 s). The sim tick alone is 329 ms; snapshot work for 8
  players + 1 spectator adds 78 ms on the tick thread plus 26 ms of deflate.
- Unit motion (152 ms/tick), combat (75 ms), routing (57 ms), snapshots (78 ms) and visibility (35 ms/tick average,
  141 ms per pass) are each individually over budget. There is no single hotspot to fix: the ticket's "small
  optimisations are not enough" is confirmed by the data.
- **Network: 156 KB/s per player and 925 KB/s for a spectator after deflate** (824 KB/s and 5 MB/s raw JSON). About
  half of each message is the owner's waypoint lists (`wp`).
- The simulation core scales at about **n^1.5–1.8** in unit count on a fixed map (density grows with n); snapshots
  scale linearly but are multiplied by the number of viewers.
- Client: the 8k/4k stress scene and the F3 readout are built and compile; the far / middle / close zoom measurements are still pending (section 3).

## 1. Method

### Server harness: `tools/scale-bench.mjs` (new)
- 8 civs, free-for-all (`teamSize: 1`), pangaea, map size 256 (the maximum), seed 3, max starting resources,
  `armyLimit` raised to fit.
- **Buildings:** every claimable site (24) gets its headquarters and all eight facilities (208 facilities); the rest
  (to 4,000) are field structures spread over each civ's side of the map and towards its neighbours: barricades 25 %,
  guard posts 15 %, bunkers 12 %, turrets 12 %, city turrets 10 %, AA 6 %, sensor posts 6 %, repair points 5 %,
  artillery posts 5 %, forts 4 % (about 60 % armed).
- **Units:** 1,000 per civ (25-type mix, about 8 % aircraft), spawned in five muster areas around home, aggressive
  stance, split into groups of 40.
- **Orders (scripted, `sandbox`: no AI planning, no victory):** 80 % of groups attack-move to the fronts with both ring
  neighbours, 10 % deep-strike a far enemy base, 10 % guard home. Idle or stalled groups get a new attack-move every
  6–12 s. Losses are topped up at home every 15 s and sent to a front; destroyed buildings are rebuilt every 30 s.
  Result: continuous fighting on 8 fronts with chases, group orders and reinforcement streams (about 350 wrecks and
  250 rebuilt structures in 50 s).
- **Live worker work per 100 ms interval**, as `server/worker.js` does it: one tick (speed 1); every 2nd interval
  `game.snapshots()` for 8 fog-of-war players + 1 god-view spectator, each through its own keyed `deltaEncoder`
  (`udelta` + `econ-delta-v1`, what the Unity client negotiates), then `JSON.stringify`; econ every 10th interval;
  `zlib.deflateRawSync` per message over 1 KB (the ws permessage-deflate work, done on the main thread in production;
  level 6 without context takeover, an upper bound); one autosave serialize + stringify at the end.
- **Timing:** every scheduler system wrapped; every `nav.route()` timed and attributed to the system running it
  (`scheduler.current`); GC by PerformanceObserver; thread CPU; heap and RSS peaks; message bytes per viewer kind and a
  per-field breakdown; the real telemetry probe attached (`--probe`), its spans reported too.
- **Runs:** 10 s warm-up, then 40 s measured. `--cpu-prof` profiles attributed by
  `D:/Projects/se_scratch/scale/analyze.mjs` (samples to the outermost system frame).
- **Tree:** a frozen `git archive` of HEAD b13f439 (`--root=D:/Projects/se_scratch/scale/tree`), because other agents
  were editing `server/sim` during the pass (twice the live tree did not load).
- **Machine:** i5-8600K (6 cores), Node 26.13, in-process runs (for the CPU profile). The machine was 65–85 % busy
  with other agents' work. Thread CPU was within 4 % of wall time in every run (171.6 s CPU / 179.4 s wall at 8k), so
  the process was not starved, but single numbers are ±15 %.
- Raw results: `D:/Projects/se_scratch/scale/{p250,p500,p1000,q1000,ai1000,s1000}.json`, profiles in
  `D:/Projects/se_scratch/scale/prof/`.

```
node --cpu-prof --cpu-prof-dir=D:/... tools/scale-bench.mjs --inproc --per=1000 --buildings=4000 --seconds=40 --warm=10 --probe --out=x.json
node tools/scale-bench.mjs                    # same in a worker_thread with the production resource limits
node tools/scale-bench.mjs --ai ...           # 8 brutal AI civs drive the same armies (AI planning load)
```

### Server → client perf block (new, for the client readout)
- `server/perfStats.js` (new) and three hook lines in `server/worker.js`: econ messages (1 Hz) carry
  `perf: { tps, target, ms: { tick, path, sim, combat, vis, ai, econ, net } }`. `tps` is ticks per wall second over
  the last 3 s, `target` is 10 × speed, and `ms` is mean wall ms per tick by system group over the last second
  (`path` = every `nav.route()` whichever system called it; `sim`, `combat`, `ai`, `econ` without their routing;
  `net` = snapshot build + encode).
- It reads a new cumulative `total` per system in `server/sim/scheduler.js` (one add per record) and wraps the nav
  instance's `route()` (same arguments and result, like the telemetry probe). Only action-ruleset matches.
- Test: `test/perf-stats-2026-11-20.test.js` (shape, means, stateHash identical with and without it).
- Old clients ignore the field; the delta encoder passes it through like `pace`.

## 2. Server results

### 2.1 Scale curve (ms per tick, mean of the 40 s window)

| | 8 × 250 | 8 × 500 | 8 × 1,000 | 8 × 1,000 |
|---|---|---|---|---|
| units (mean) / buildings | 2,058 / 999 | 4,028 / 1,984 | 7,983 / 2,278 | **7,955 / 3,990** |
| **ticks per second (target 10)** | **10** | **7.2** | **2.9** | **2.2** |
| loop interval mean / p95 / max | 63 / 114 / 154 | 139 / 234 / 465 | 340 / 545 / 763 | **448 / 682 / 1,295** |
| sim tick mean / p95 | 37 / 57 | 86 / 126 | 239 / 340 | **329 / 446** |
| intervals over 100 ms | 10 % | 59 % | 100 % | 100 % |
| unit motion (navigation without routing) | 19.3 | 42.8 | 120.7 | **152.4** |
| pathfinding (all `route()` calls) | 4.9 | 11.5 | 32.7 | **56.9** |
| routes per tick | 5.3 | 8.9 | 16.6 | 14.4 |
| combat (without its routes) | 6.5 | 16.7 | 47.9 | **74.6** |
| visibility (runs every 4th tick: ×4 per pass) | 4.2 | 11.4 | 29.0 | **35.4** |
| field economy (engineers) | 1.5 | 3.7 | 8.2 | 10.1 |
| production | 0.5 | 1.0 | 1.8 | 4.0 |
| snapshot build (9 viewers) | 11.6 | 22.4 | 41.9 | **48.8** |
| keyed delta encode | 3.9 | 8.0 | 17.1 | 20.6 |
| JSON.stringify | 1.8 | 3.5 | 7.5 | 8.3 |
| deflate (main thread in production) | 5.4 | 11.1 | 23.8 | 25.9 |
| GC in the window (mean / worst pause) | 1.6 / 9 | 3.7 / 13 | 8.0 / 29 | 10.4 / 40 |
| scripted orders (stands in for player / AI commands) | 3.2 | 6.9 | 10.0 | 14.4 |
| heap peak / RSS peak, MB | 195 / 374 | 288 / 481 | 404 / 649 | 438 / 662 |

**Scaling** (exponent k in cost ∝ units^k, 2,058 → 7,955 units with buildings scaled alongside):

| system | ×cost for ×3.9 units | k | why |
|---|---|---|---|
| pathfinding | ×11.7 | 1.8 | more blocked / stuck replans per unit in denser crowds, more buildings per corridor |
| combat | ×11.6 | 1.8 | each shooter scans more candidates in range (density), more armed buildings |
| unit motion | ×7.9 | 1.5 | neighbour queries and collision tests per unit grow with local density |
| visibility | ×8.5 | 1.6 | one reveal per unit; the fog cache misses more as more units move |
| field economy | ×6.8 | 1.4 | engineer threat/job scans over all armed entities |
| GC | ×6.5 | 1.4 | per-unit closures and per-record arrays |
| snapshot build / delta / stringify / deflate | ×4.2 / 5.3 / 4.7 / 4.8 | 1.1–1.2 | linear in units, × number of viewers |

On a fixed (maximum-size) map, density grows with the army, so "per unit" work that looks at neighbours grows too:
that is the quadratic part. A real 8-player 8k match on a 256 map has this density.

**Buildings alone** (8 × 1,000 units, 2,278 → 3,990 buildings, two runs): unit motion +26 %, routing +74 %, combat
+56 %, visibility +22 %, snapshots +16 %, production ×2.2. Structures are not free when idle: they are obstacles in
every standing test, targets re-inserted into the combat index every tick, shooters polled every 6 ticks, and they
are scanned whole by aircraft refuelling and engineers.

**AI civs instead of the script** (`--ai`, 8 brutal AIs, same armies, 30 s): 3.1 ticks/s; AI planning 5.6 ms/tick
(one civ per AI run, every 3rd tick), combat 77, unit motion 75 (fewer units moving in the first 30 s), routing 39,
visibility 35, field economy 15. AI plan cost at this size over a longer match was not measured (the AI gives few
orders in the first 30 s); TELEMETRY_ANALYSIS_2026-11-19 B1 already shows single plans of 0.6–1.5 s at 500 units,
O(sites × units).

### 2.2 Where the time goes at 8 × 1,000 / 4,000 (CPU profile, 236 s of samples)

| system | share | inside it |
|---|---|---|
| navigation (`unitMotion`) | **40.6 %** | `unitMotion` self 18 % (per-unit steering, closures `unitsOk`/`allowed` created per unit per tick), `canStand` 12.5 %, `obstacleAt` 8.2 %, `crowding` 7.9 %, `SpatialIndex.read`/`query` 6 %, `cost` 4.2 %, `stallCheck` 2.3 %, `stepCost`/`primeGroup` (flow fields) 4 %. 63 % of navigation time is inside `actionNavigation.js` (routing plus standing tests). |
| combat | **15.6 %** | `actionCombat` self 20 %, **`airStep` 17.7 % + `nearestRefuel`/`refuels` 7 %** (every aircraft scans every building, `actionAir.js` `nearestRefuel`), `SpatialIndex.query`/`read` 23 % (`stanceStep` → `nearestHostile`, acquisition), `TargetIndex` rebuild every tick (12k inserts) |
| snapshot build | 9.3 % | `viewerSnapshot` self 32 % (**the per-viewer loop over all 65,536 tiles**, `game.js` `viewerSnapshot`), `unitSnapshot` 27 % (one ~120-byte array per visible unit per viewer), `sees` 7 %, `siteWire`/`siteCount` 7 % |
| visibility | 7.2 % | **`fogTiles` 58 %** (disk filter per moving unit: cache misses once units move), `disk` 11 %, `reveal`, `rememberBattlefield` |
| deflate | 5.3 % | zlib (main thread in production) |
| keyed delta | 4.0 % | `encode` (`delta.js`): every unit record JSON-compared per viewer |
| GC (outside systems) | 2.5 % | |
| field economy | 2.2 % | `jobsFor` 44 %, `engineerStep`, `threatsFor` |
| stringify | 1.7 % | |
| other | 7 % | setup (map generation, 4,000 `addFacility` → `sameGround`, first 200 group orders: 7.9 s) |

### 2.3 What fails first
1. **The tick itself.** Already at 8 × 500 (4,000 units) the loop is at 7.2 ticks/s, and 59 % of intervals are over
   100 ms. The live loop (`worker.js`) runs at most one tick per interval at speed 1, so the match simply runs slow
   (pace 0.22 at 8k) and the clients' clocks follow `pace`.
2. **Snapshot cadence.** Snapshots ride on intervals: at 448 ms intervals players get about 1.1 snapshots/s instead
   of 5, so client interpolation delay becomes ~1 s.
3. **Spectator bandwidth.** A god-view spectator gets 1.0 MB of JSON per snapshot (8,000 unit records + 1.4 MB of
   waypoints in the econ round), 5 MB/s raw, 0.9 MB/s deflated. Deflate costs ~26 ms per interval on the main
   thread (shared by every match on the instance).
4. **Autosave**: 27.8 MB of JSON, 143 ms serialize + stringify on the tick thread every 60 game-seconds (gzip runs
   on the pool). Memory is fine: heap peak 438 MB, RSS 662 MB, inside the worker's 1,024 MB old-generation limit.
5. **Command latency**: 200 group orders of 40 took 7.9 s in one go at setup; one 40-unit attack-move costs 20–40 ms.

### 2.4 Messages per player at 8k (keyed delta, raw JSON → deflated)

| viewer | snapshot (5 Hz) | econ round (1 Hz) | per second raw | per second deflated |
|---|---|---|---|---|
| player (sees ~1,170 units) | 163 KB | 174 KB | 824 KB | **156 KB** |
| god-view spectator (7,950 units) | 1,001 KB | 1,006 KB | 5,008 KB | **925 KB** |

Per-field, econ round: player `wp` (own units' next 18 waypoints, resent every snapshot) 178 KB, `units` 138 KB
(1,169 records, nearly all changed since units move); spectator `wp` 1,391 KB, `units` 950 KB. Buildings, sites and
battlefield are already keyed deltas and small. A whole 8-player match moves about **2.2 MB/s, ~7.9 GB per hour**
off the instance.

## 3. Client results

**Status: scene and readout built and compiling; the zoom measurements are still pending.** The client run was cut
off by a usage limit before the profiling pass, and the pass was closed without it. Nothing below is a measurement.

What exists (uncommitted, measurement code only):
- `Core/Stress/StressScale.cs` (new): an offline 8-civ free-for-all, 8 × 1,000 units and ~4,000 buildings (bases
  with HQ + 8 facility parcels, field defences along every neighbour front). Groups of ~25 advance, hold, chase and
  fall back, exchange fire with impacts and craters, kills respawn at home, wrecks are capped like the server's.
  Snapshots are udelta-style with a full set every 50; econ once a second with buildings, battlefield, sites and a
  synthetic `perf` block.
- `Runtime/App/GameBootstrap.Scale.cs` (new) + hooks in `GameBootstrap.cs`: launch with
  `-mode stress -stress-scale [-stress-civs 8] [-stress-units 1000] [-stress-buildings 4000] [-stress-zoom Z]`. Without
  `-stress-zoom` the camera holds far (80), middle (20) and close (2.5) over a front and logs one "SCALE segment" line
  per hold; `-shots DIR` saves a screenshot per hold; `-stress-quit -perf-out file` writes the report and quits. In the
  editor: `StartStressScale(8, 1000, 4000)`.
- The F3 readout (always on in stress scenes): FPS and frame ms (avg / p95), FrameTimingManager main / render / GPU
  ms, server ticks/s against the target (econ `perf`; else snapshot cadence and `pace`), server path / sim / combat
  ms, units and buildings with drawn / culled, client phase ms, player-loop UI / render / present ms, and draw calls,
  batches, SetPass calls and triangles.
- `Core/Protocol/ProtocolDecoder.cs` / `Messages.cs`: decode `perf` (absent → ignored).

To measure: run the command above (standalone Development player or editor play mode), collect the three segment
lines and screenshots to `D:/Projects/se_scratch/scale/{far,middle,close}.png`.

What is already known from earlier passes (code, not this measurement):
- **Units are frustum-culled below strategic zoom** (Pass 2, `UnitRenderer.Update`: a non-air unit outside the camera
  frustum by more than `CullMargin` is skipped before any per-unit work). At strategic zoom (badges) every unit is
  drawn. **Fog**: units the player cannot see are not in the snapshot at all (server filters by `sees`), so fog
  culling of enemy units happens on the server; own units are always drawn.
- Instanced batches use very large bounds (1e5), so the GPU draws every instance in the main pass and every shadow
  cascade; per-unit main-thread work (ground height, facing, figures of 4–12 rigged soldiers per squad) scales with
  the number of units in view. At 8k, middle zoom over a front can hold several hundred squads = thousands of figures.
- City/base visuals are composed per cell (`CityRenderer`); whether cells outside the frustum are skipped was not
  re-checked in this pass.

Phase 2 client direction (to confirm with the measurements): GPU-driven instancing with per-type indirect draws and
a compute/Burst culling pass (frustum + fog bitmap) instead of 1e5 bounds; distance LOD (full rig close, crowd
impostor / vertex-animated mesh at middle, badge far); Burst jobs for per-unit interpolation and transforms over
NativeArrays (SoA mirrors of the snapshot); building instances static per chunk, rebuilt only on change; a fixed
debris/decal ring buffer. Full ECS (Entities) is not needed for this: Jobs + Burst + Graphics.RenderMeshIndirect give
most of the benefit without rewriting the renderers.

## 4. Phase 2 architecture proposal

Budget: 10 ticks/s on Cloud Run means a whole interval (tick + snapshots) under 100 ms on a Cloud Run vCPU, which
runs a single thread at perhaps 60–80 % of this i5 (estimate, not measured). Target **≤ 50 ms per interval on the dev
box** at 8k/4k, i.e. **about 9× less tick-thread work** than today (448 ms). No single change gets there; each area
needs its own redesign. Estimates below are per-area guesses from the profile, to be confirmed by `scale-bench`.

### 4.1 Snapshots and networking (78 ms tick thread + 26 ms deflate; 156 KB/s per player) — do first
- **No per-viewer world scan.** `viewerSnapshot` loops all 65,536 tiles for every viewer every round. Keep a
  per-round list of touched tiles (`world.touch` already counts) plus the viewer's visibility-bit changes, and scan
  only those. Removes ~32 % of snapshot build.
- **One unit table per round, binary records.** Build the unit state once per round into typed arrays (id, owner,
  type, x/z as Int16 centi-units, yaw byte, hp byte, flags). Per viewer: filter by visibility bit and by **interest**
  (the client's camera rectangle + margin at 5 Hz; everything else at 1 Hz with position only; strategic zoom gets
  per-hex group badges). Delta against the viewer's last-sent values in a typed array instead of JSON string
  comparison (`delta.js encode`). ~6 bytes per changed unit, ~14 for a full record, against ~120 today.
- **Waypoints on change only**, versioned per unit, and only for selected or on-screen own units (`wp` is half the
  bytes today).
- **Encode off the tick thread.** Copy the round's tables into a SharedArrayBuffer (8k × 32 B, < 0.2 ms) and let a
  second worker filter, delta-encode and compress; binary frames with permessage-deflate off (or compressed in that
  worker), so the main thread stops paying deflate.
- **Expected:** tick-thread snapshot cost 78 → < 5 ms; per player 156 → ~20–40 KB/s; spectator 925 → ~60–120 KB/s.
  Risk: protocol change on both clients (Unity decoder, Godot client) and a new capability; spectators' interest
  rectangle when several share one channel (send the union or move spectators to per-connection channels).

### 4.2 Unit simulation (152 ms) and time-slicing
- **Structure-of-arrays state** for ground units (x, z, vx, vz, yaw, radius, class, flags, goal index) in typed
  arrays, with the per-unit objects keeping the rest. The movement loop becomes monomorphic loops without closures
  (today `unitsOk`, `groundOk`, `allowed` and `near.every` closures are created per unit per tick).
- **Static clearance field per movement class**: a rasterised "free" bitmap (≈ 0.1-unit cells) rebuilt locally when a
  building, wreck or ground changes, used for the per-step standing test; the exact `canStand`/`obstacleAt`/
  `insideFootprint` only where the raster says "near an edge". NAV_REDESIGN rejected a conservative raster for
  *routing* (it closes 0.13-wide bridge lanes); as a pre-filter with an exact fallback it changes no outcome.
  `canStand` + `obstacleAt` + `cost` are 25 % of navigation.
- **Flow-field following for groups**: members of a group order steer by the shared field (`primeGroup` already builds
  it) and keep only a short local path, instead of each following its own path and replanning when blocked.
  Blocked/stuck replans are most of the 57 ms of routing (`budgetRoute` strict replans in `unitMotion`, the stuck
  ladder in `stallCheck`).
- **Time-slicing by activity**: units with no goal already cost little. Add tiers: *engaged or near enemies* every
  tick; *moving in open ground with no enemy within ~12 units* full steering every tick but neighbour/collision tests
  against static ground every 2nd tick and `stallCheck`/ladder every 3rd ((tick + id) % 3); *idle and unthreatened*
  checked every 10th tick. Deterministic (driven by tick and id only).
- **Expected:** 4–6× on navigation (152 + 57 → ~35–50 ms). Risk: movement behaviour changes (hash changes); needs the
  nav fuzz/repro suites (`nav-redesign-fuzz`, `nav-bridge-city-repro`) and balance validation.

### 4.3 Combat (75 ms) — spatial grid with activity gating
- The combat `TargetIndex` (per-side cells, Pass 7) is rebuilt from scratch every tick for all 12,000 units and
  buildings. Make it incremental: buildings inserted once, units moved when they change cell.
- **Hostile-presence grid**: per coarse cell (e.g. 8 × 8 units) a count per side. A unit or building whose
  surrounding cells within weapon range + sensor have no hostile skips `acquire`, `stanceStep`/`nearestHostile`,
  cover search and setup logic entirely. Most of the 4,000 structures and the rear half of every army sit in such
  cells; they cost one lookup.
- **Aircraft refuelling**: `nearestRefuel` (called from `airStep`) scans every building for every aircraft every tick (`airStep` + `nearestRefuel` + `refuels` are about a quarter of combat at 4,000
  buildings). Keep a per-civ list of refuelling structures (airfields, HQs, drone labs) updated on build/loss.
- **Projectiles** are already cheap (combat.projectiles 0.5 s in 40 s).
- **Expected:** 3–5× (75 → ~15–25 ms). Low risk for the refuel list and the incremental index (exact); gating is
  exact if the skipped work provably finds no target (same candidates), otherwise a small behaviour change.

### 4.4 Visibility (35 ms per tick, 141 ms per pass)
- **Counted, incremental visibility**: per civ a Uint16 count per tile; a source adds its disk when it enters a
  (tile, quantised position, radius) and subtracts the old one when it leaves. Only units that moved a quantum do any
  work; idle units and all buildings cost nothing after their first stamp. Visible = count > 0.
- **Group sources**: units of one civ on the same tile with the same radius stamp once.
- **Spread** the per-civ refresh over the 4 ticks (2 civs per tick) to remove the 141 ms spike.
- **Expected:** 5–10× and no spike. It is a pure function of positions, so it can also move to a helper thread
  reading the SoA positions (double-buffered) if needed. Exact (same visible set).

### 4.5 Pathfinding (57 ms)
- Group orders already share a flow field (`primeGroup`) and the coarse hex A* is HPA-like with local invalidation
  (NAV_REDESIGN). Long routes: coarse first, fine stage only for the first few corridor hexes, refined lazily as the
  unit advances (today the whole fine route is built up front).
- Fewer requests is the main lever (4.2): blocked units in a crowd yield/queue instead of re-planning; the per-tick
  route budget (Pass 6) is kept.
- Keep flow fields across unrelated invalidations (Pass 3 open item): drop a field only when the change touches a
  cell it covers (`invalidateNear` already does this for corridors).
- **Expected:** 3× fewer route ms at 8k, on top of 4.2.

### 4.6 Buildings: 4,000 nearly free when idle
- A static building registry (SoA: tile, type, owner, hp, flags) with an "active" set: under construction, producing,
  damaged/burning, armed with a hostile in range (from the presence grid), garrisoned. Only active ones are visited
  per tick; the others are touched by events.
- Obstacles: part of the clearance field (4.2), so standing tests do not iterate building lists.
- Snapshots: already keyed deltas (`bd`); with the per-round dirty list the econ block visits only changed buildings.
- Engineers (`jobsFor`, `threatsFor`): index jobs by site and threats by presence grid instead of scanning all.

### 4.7 Destruction and debris
- Server side the budgets already exist and hold: wrecks ≤ 400 (`WRECK.total`, 600 s life), impacts ≤ 3,000 with
  healing (`IMPACT`). At 8k the wreck cap is reached within about a minute of fighting, so the oldest wrecks churn;
  battlefield deltas stay keyed. Client debris and deformation budgets: see section 3.

### 4.8 Threads, SoA, WASM
- **Yes to SoA typed arrays** in the hot loops (motion, collision, visibility, snapshot tables): it removes the
  closures and per-record garbage (GC is 10 ms/tick and pauses up to 40 ms) and is the prerequisite for threads.
- **Yes to 2–3 threads per match, no to a parallel simulation.** The tick stays single-threaded and deterministic;
  read-only work moves off it: (1) snapshot filtering/encoding/compression (4.1), (2) visibility (4.4), (3) the
  autosave (serialize a copy of the SoA tables + objects on a helper; today 143 ms on the tick thread). Splitting
  unit motion across threads would need a two-phase intent/resolve movement model; not needed if 4.2 delivers.
- **WASM: not first.** Monomorphic typed-array JS is typically within 1.5–2× of WASM for this kind of loop; port the
  movement/collision kernel to Rust/WASM only if it is still above ~25 ms after 4.2. Floating-point determinism must
  be kept (no fused ops, same evaluation order).
- **ECS on the server:** the SoA tables are the useful part of ECS; a full ECS rewrite is not warranted.

### 4.9 Order of work
1. Snapshot/network redesign (4.1): biggest and most self-contained win, protocol only (sim hash unchanged).
2. Visibility incremental (4.4) and combat refuel list + incremental target index (4.3, exact parts): hash-neutral.
3. Unit SoA + clearance pre-filter (4.2 exact parts): hash-neutral.
4. Hostile-presence gating (4.3) and activity time-slicing (4.2): behaviour changes, deterministic.
5. Flow-field steering and lazy fine routes (4.2/4.5): behaviour changes; nav suites + balance.
6. Snapshot/visibility/autosave threads (4.8).
Re-run `tools/scale-bench.mjs` (8 × 250 / 500 / 1,000) after each step; the econ `perf` block shows the same split
live in the client readout.

### 4.10 Feasibility on the current Cloud Run instance and budget
- **Compute.** Today an 8k/4k match needs ~4.5 single-thread seconds per wall second; it cannot run at speed on any
  instance size, because the work is on one thread and more vCPUs do not make one thread faster. If the Phase 2
  estimates hold (motion + routing ~40–50 ms, combat ~15–25, visibility ~5 or off-thread, economy/production ~10,
  snapshots < 5 on the tick thread), the tick is ~70–90 ms on this i5: **at the edge of 10 Hz, not comfortably
  inside it**. Reaching 10 Hz with headroom on a Cloud Run vCPU needs the time-slicing tiers to cut the per-tick
  unit work further, or a 5 Hz movement step for unengaged units with client interpolation. Honest assessment:
  8,000 units at 10 Hz is feasible only after the full redesign, and should be planned as "10 Hz in fights, sliced
  elsewhere".
- **Instance.** 4 vCPU / 4 GiB is enough for one such match with 2–3 threads (memory 0.7 GB per match). With max 1
  instance, two simultaneous 8k matches would share 4 vCPUs (fine for the helper threads, tight for two sim threads).
  No machine change is needed; a higher-clock VM (Compute Engine C3/C4) would help single-thread speed but costs far
  more than $10/month when always on.
- **Cost (list prices, approximate, verify before deciding).** Cloud Run request-based billing charges the whole
  allocated 4 vCPU + 4 GiB while a WebSocket is open: about 4 × 3,600 × $0.000024 + 4 × 3,600 × $0.0000025 ≈
  **$0.38 per match-hour** above the free tier. Egress dominates today: ~7.9 GB per match-hour at ~$0.12/GB ≈
  **$0.95 per match-hour**; after 4.1 (~1 GB/h) about $0.12. So $10/month buys roughly 7 match-hours of 8-player 8k
  play today and roughly 20 after the network redesign (less the free tier already used by normal matches).
  **The network redesign is required for the budget, not just for speed.**

## 5. Files

New: `tools/scale-bench.mjs`, `server/perfStats.js`, `test/perf-stats-2026-11-20.test.js`, this document.
Changed: `server/worker.js` (perf block hooks, 3 lines + import), `server/sim/scheduler.js` (cumulative `total`).
Client (new): `unity/Assets/ShatteredEmpires/Core/Stress/StressScale.cs`, `Runtime/App/GameBootstrap.Scale.cs`; hooks in `GameBootstrap.cs`, `ProtocolDecoder.cs`, `Messages.cs` (`perf` decode).
Scratch: `D:/Projects/se_scratch/scale/` (results, profiles, `analyze.mjs`, frozen tree).
