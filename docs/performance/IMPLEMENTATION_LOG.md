# Server performance implementation log

These are server-side changes from the 2026-11-17 performance pass. They are not committed.

**Machine and method**
- Machine: i5-8600K, Node v26.13.
- Before and after ran the same seed (7) and the same scenario, back to back, on copies of the tree. Benchmarks ran one at a time.

**Trees**
- **T0** HEAD
- **T1** HEAD + N1
- **T2** T1 + N5
- **T3** T2 + N6 + S2
- **final** HEAD + N5 + N6 + S2 + item 7 + S4. N1 and S5 were reverted.

**Measurement noise**
- Between about 22:16 and 22:50 a client build (ShatteredEmpires.exe, about 2 cores) and Edge ran on the machine. From 23:11 another `action-balance` run (not ours) ran too.
- Single-run millisecond figures from those windows are ±20–40%. Deterministic counters (route calls, stateHash, bytes) are exact.
- The quiet-machine reruns are marked *quiet*.

**Raw data:** `docs/performance/data/*-before.json`, `*-after.json`, `*-reverted.json`.

## Final tree is simulation-identical to HEAD
- `stateHash` was taken every 1,500 ticks for 12,000 ticks (20 game-minutes) on crossroads (4 AI) and iron_basin (6 AI).
- All 8 hashes match for T0 vs final on both maps. Final unit and building counts also match.
- Every kept change is behaviour-preserving, so action-balance outcomes are identical by construction.

**Tests**
- `npm test` on the final tree: 358 tests, 355 pass, 1 skipped, 2 fail.
- Neither failure is from this work:
  - `functional upgrades change behaviour … squad firepower` (12 !== 8) is in the gameplay-overhaul files another engineer is editing concurrently (`actionUpgrades.js`, `action-bases-2026-11.test.js`, …).
  - `server hosts a match end-to-end` hit its 25 s timeout under machine load. It passes when run alone.
- Before the concurrent edits landed, the run with all my changes was 337 tests, 336 pass, 1 skipped.

**New tests**
- `test/visibility-equivalence.test.js`
- `test/group-route-equivalence.test.js`
- `test/econ-gate.test.js`

---

## N1 — back off futile re-routing of blocked units: REVERTED

**Hypothesis:** blocked and stalled re-plans mostly return the current path, so per-unit exponential backoff saves route time.

**Tried**
- **v1:** back off every successful re-route, 26 → 208 ticks.
- **v2:** back off only after a re-plan returns *exactly* the current path. A skipped re-plan behaves as that same path, including refreshing `stallLen`/`stallBest` in `stallCheck`. The backoff resets on a different path, on progress, or on a new goal.
- In both versions failed routes never back off, so the give-up rules are unchanged.

**Measurement**
- **v1** jammed units: on longMove N=1000, units with stall ≥ 40 rose from 12 to 157, and nav p95 / p99 went from 79 / 137 to 127 / 260 ms.
  - Cause: a blocked re-route that returns a different path is what resets the stall counter.
- **v2** cuts re-route calls a lot:

| Scenario | Before | After v2 |
|---|---|---|
| longMove N=250, re-route calls | 3,389 (2.9 s) | 2,514 (2.4 s) |
| longMove N=1000, re-route calls | 19,954 (18.0 s, instrumented) | 13,366 (13.0 s) |

  - About 56% of the remaining re-routes still returned the same path.
- Tick time did not improve:

| Scenario | Before | After v2 |
|---|---|---|
| *quiet* iron_basin 6-AI 45-min: nav mean / p95 / p99 | 1.92 / 5.29 / 8.2 ms | 2.10 / 6.51 / 10.8 ms |
| *quiet* iron_basin: ticks with nav > 15 ms | 9 | 78 |
| *quiet* longMove N=250: nav mean | 4.30 ms | 4.54 ms |
| *quiet* longMove N=1000, two interleaved repeats: nav mean | 21.8 / 22.3 ms | 22.1 / 22.3 ms |

  - The earlier noisy runs had suggested a win, for example iron_basin p95 12.4 → 10.2 ms. The quiet reruns showed that was noise.
- Arrival over 6 minutes:

| N | Before | After v2 |
|---|---|---|
| 250 | 84.0% | 88.8% |
| 1000 | 59.4% | 56.4% |

**Why it does not help**
- A unit that keeps its path stays blocked longer, and a blocked unit pays the 8-sidestep collision search (`canMove` plus neighbour scan) every tick.
- The re-plans were also nudging jams apart. The route time saved goes back into collision work.
- The real cost is N2 (collision geometry), not route calls.

**Decision:** reverted. `actionOrders.js` motion code is back to HEAD.
- The nav bench keeps the new `arrival` block: arrived %, median and 90th-percentile arrival tick, and remaining distance. `--ticks=3600` is needed for a cross-map move to finish.

---

## N5 — pre-check unreachable group orders: KEPT (`actionOrders.js` `groupRoute`, used by `candidate` in `moveGroup`/`deployLine`)

**Change**
- After the first failed route of a group order, or whenever `nav.components` is already built, the unit's and slot's connected regions are compared with `componentOf`.
- If they differ, coarse A* cannot succeed. `route()` would then only return `line(from, to) ? [to] : null`, so only that is evaluated.
- The result is identical. The components are built lazily, only after a failure, so normal orders pay nothing.

**Measurement:** unreachable scenario on saltmarsh_estuary, 10 orders, command median / p95.

| Run | N | Before | After |
|---|---|---|---|
| Isolated (T1 → T2) | 250 | 170 / 949 ms | 57 / 109 ms |
| Isolated (T1 → T2) | 1000 | 1,263 / 2,149 ms | 213 / 644 ms |
| Final A/B, quiet rep 1 | 250 | 123 / 770 ms | 38 / 90 ms |
| Final A/B, quiet rep 1 | 1000 | 1,030 / 1,738 ms | 215 / 361 ms |

**Correctness:** the same units were placed (218/215/218), and the final states and counters are identical.

---

## N6 — duplicate invalidate in `loseBuilding`: KEPT (`actionGame.js`)
- **Verified redundant:**
  - `removeBuilding` invalidates just before.
  - `addRuin` only writes `ruins` and `world.ver`, neither of which the navigation reads.
  - Nothing refills a cache in between.
- **Measurement:** G soak invalidations fell from 509 to 397, exactly one per `loseBuilding`. There is no measurable time effect, since clearing empty caches is free.
- **Behaviour:** none (stateHash identical).

---

## S2 — visibility: KEPT (`actionGame.js` `refreshVisibility`/`revealSource`/`fogTiles`/`reveal`; `TILE_X`/`TILE_Z` exported from `actionNavigation.js`)

**Change**
- Each team's sight is stamped once, into its first living member's arrays, then copied to the other living members with `TypedArray.set`.
- The disk cache uses an integer key carrying exactly the old key's inputs (tile, quantised x and z, radius), with a string fallback.
- Cache values are `Int32Array`s.
- A miss filters with inline `TILE_X`/`TILE_Z` arithmetic, identical to `distance(…, centerOf(t))`, with no per-tile objects.
- FIFO capacity was raised from 3,500 to 6,000. Results depend only on the key.

**Measurement**

| Scenario | Before | After |
|---|---|---|
| S1000, isolated (T2 → T3): vis pass p50 / p95 | 3.57 / 8.58 ms | 1.75 / 4.96 ms |
| S1000, *quiet*: vis pass p50 / p95 | 2.77 / 8.63 ms | 1.59 / 3.95 ms |
| S1000: fog misses p95 per pass | 1,046 | 132 |
| G, final A/B rep 1: vis pass p50 / p95 / p99 / max | 1.46 / 2.15 / 2.55 / 9.9 ms | 1.13 / 1.71 / 2.01 / 2.8 ms |

- Free-for-all teams have a single member, so the copy step only pays off in team games.

**Correctness**
- `test/visibility-equivalence.test.js` recomputes `visible`/`detect` for every civ with the old implementation, kept verbatim in the test, after *every* pass. It requires them byte-identical in:
  - a 4-AI free-for-all, 6,000 ticks
  - a 2v2, 6,000 ticks
- A mutation (`.38` changed to `.37`) makes it fail.

---

## Item 7 — cheaper group orders: KEPT (`actionNavigation.js` `beginBatch`/`endBatch`/`snapAt`/`lineB`/`localRouteB`, `route()`; `moveGroup`/`deployLine` wrap a batch)

**Hypothesis**
- AI spikes come from `moveGroup` routing every member.
- `route()`'s fine stage (portal and hub `nearest` snaps, `line` checks, `localRoute` detours) is pure while the world is unchanged.
- Members of one order share the corridor, so this work can be shared exactly.

**Change**
- Within one order, snaps are memoised by coarse tile pair and movement class/radius.
- Lines and detours are memoised by the identity of the shared snapped points.
- `invalidate()` resets the memo. `nav.batchOff` turns it off; it is used only by the test.
- A shared strategic route with per-unit tails was not built. It changes paths and would need balance validation, and this memo already gives an exact win.

**Measurement**

| Scenario | Before | After |
|---|---|---|
| G soak, isolated (T3 → final-with-S4), *quiet*: AI route time (same 8,996 calls) | 3,638 ms | 2,670 ms (−27%) |
| G soak, isolated, *quiet*: AI p99 / mean | 19.7 / 0.54 ms | 18.4 / 0.49 ms |
| G soak, isolated, *quiet*: tick p99 | 21.8 ms | 20.0 ms |
| G soak, final A/B rep 1 (T0 → final): AI route time | 3,643 ms | 2,566 ms |
| G soak, final A/B rep 1: AI p99 / max / mean | 17.8 / 126 / 0.48 ms | 16.7 / 113 / 0.44 ms |
| G soak, final A/B rep 1: tick p99 / max | 19.7 / 132 ms | 18.9 / 115 ms |
| Order latency, longMove N=250 | 155 ms | 103 ms |
| Order latency, longMove N=1000 | 1,025 ms | 844 ms |
| Order latency, repeat N=250, median / p95 | 179 / 247 ms | 29 / 42 ms |
| Order latency, repeat N=1000, median / p95 | 1,252 / 2,432 ms | 677 / 769 ms |

- The order-latency rows are from the final A/B rep 1, quiet.
- Final A/B rep 2 overlapped the other `action-balance` run and is noisy in both directions. Its route-time saving still shows: 3,653 → 3,102 ms.

**Correctness:** `test/group-route-equivalence.test.js` covers three things:
- The same 4-AI match with and without batching gives an identical `stateHash` at 6,000 ticks.
- At 4 points, every civ's army is ordered across the map, plus a `deployLine` preview, on restored copies. Goals, paths and results are identical.
- The memo was hit 18,583 times.

---

## S5 — autosave base64 cache: REVERTED (`persist.js`)
- **Tried:** cache each typed array's base64, kept valid by a byte compare with a private copy. It is exact, and a round-trip test passed.
- **A/B:** same state, old vs new `serializeGame`, once per game-minute for 40 minutes, with identical output. Median 5.64 → 5.41 ms; after minute 20, 6.29 → 6.25 ms. That is noise.
- **Why it does not help (`save-breakdown-before.json`):**
  - The 736 KB of base64 world arrays costs about 0.7 ms to stringify.
  - The growth from 3.2 ms (minute 1) to 7.5 ms (minute 40) is object data:
    - `combat`/battlefield maps: 0 → 242 KB, about 1.4 ms
    - `units` with paths: 20 → 181 KB
    - civ `siteIntel`: 7 → 53 KB
  - A real fix needs incremental or structured serialisation of those objects.
- **Decision:** reverted. My test was removed.
- **Note:** `persist.js` now shows a 2-line diff from the concurrent gameplay work, not from this pass.

---

## S4 — gate `bf`/`fw` in econ snapshots: KEPT (`server/delta.js` `deltaEncoder`, `server/worker.js` congestion handler)

**Change**
- For udelta viewers only, `bf`, and `fw` together with `trenchWorld`, are left out of an econ message when they serialise identically to what that viewer last got.
- They are always sent:
  - on the encoder's first econ message (welcome or rejoin creates a new encoder)
  - after `resyncEcon()`, called when a congested connection drains (catch-up)
  - on every 10th econ message
- Spectator full and reset messages bypass the encoder.
- Spectators and non-udelta clients are unchanged.

**Client tolerance, checked by reading the code (read-only)**
- Unity: `ProtocolDecoder` gets null `Battlefield`/`Trenches` when absent. `ClientSession.ApplySnapshot` applies them only `if (s.BattlefieldState != null)` / `if (s.Trenches != null)`; `trenchWorld` only merges into a non-null `Trenches`.
- Godot: `WorldState` uses `if m.has("bf")` / `if m.has("fw")`.

**Measurement:** G soak, viewer civ 0, identical trajectory.

| Econ message bytes | Before | After |
|---|---|---|
| p50 | 44.4 KB | 33.3 KB |
| mean | 38.9 KB | 31.9 KB (−18%) |
| p95 | 54.2 KB | 54.2 KB |

- p95 is unchanged because the battlefield changes during fights.

**Correctness:** `test/econ-gate.test.js` covers three things:
- Over a 6,000-tick 4-AI match, a client that keeps the last copy always holds exactly the full snapshot's `bf`/`fw`/`trenchWorld`.
- `resyncEcon()` forces both blocks.
- At least every 10th message carries them.

---

# Client performance implementation log (lead)

Every client change was measured with the soak benchmark: `GameBootstrap.Bench.cs`, using `-perf-soak` with a seed-7 4-AI observe match at 4× speed. Each change can be switched back to its old code path in the same build with `-perf-legacy <name>` (see `Runtime/Core/PerfFlags.cs`), and the A/B comparison is in BENCHMARK_RESULTS.md. Attribution numbers come from per-part timers added for diagnosis: `ClientSession.PartMs`, `CityRenderer` compose and hex-loop splits, `WarzoneRenderer.PartMs`, and the territory and districts timers.

## C1: deferred geometry instead of blocking on terrain jobs (`-perf-legacy geometry`). KEPT
- **Hypothesis:** `WorldModel.ApplyImpacts`, `ApplyTrenches` and `ApplyGeo` call `terrain.CompleteAll()`. That blocks the main thread on up to 6 in-flight Burst chunk jobs, and on finishing them, before it writes to the world arrays the jobs read.
- **Evidence before:** attribution soak, `applyMsTotalMax`:
  - `impacts` worst frame 136–1,200 ms, total 0.4–4 s per 15 s window;
  - `geo` worst frame 170–960 ms.
- **Change:**
  - `ClientSession.Geometry()` queues the geometry update in order when `TerrainRenderer.PollBusy()` reports running jobs.
  - `TerrainRenderer.HoldScheduling` stops new jobs while anything is queued.
  - `GameBootstrap.Present` drains the queue once the jobs have finished on their own.
  - The battlefield and trench revisions now move together with their geometry.
  - `ApplyImpacts` scratch buffers are reused instead of a `float[24]` per tile.
- **After (fix1):** impacts worst frame ≤ 12 ms; geo ≤ 1 ms.
- **Correctness:** the final world state is identical; updates are applied in arrival order. Reset and welcome clear the queue, and the server resends the whole view in that case.
- **Visible effect:** crater, trench and height changes appear a few frames later.

## C2: base compound cache key made local (`-perf-legacy basekey`). KEPT
- **Hypothesis:** the compound cache missed whenever any road anywhere changed (it was keyed on the map-wide `RoadRevision`), or when `floor(Maturity)` ticked. Maturity is only used by the disabled settlement houses.
- **Evidence:**
  - Baseline `city` worst frame 300–990 ms from the first minutes.
  - The compound was rebuilt from scratch 35 times and replayed 9 times in 15 s.
  - Neighbouring base cells are composed together outside the frame budget.
- **Change:**
  - The key covers the roads and explored hexes in an 11×13-hex window around the compound.
  - Maturity is in the key only when settlement houses are on.
  - `RoadCurve.SameLanes` compares lane content, so `LaneRevision` (which forces full warzone rebuilds) is bumped only on a real change.
- **After:** compounds rebuilt from scratch per window went from 6–22 to 1–6 (fix1, fix2).

## C3: per-hex street cache (`-perf-legacy streets`). KEPT
- **Hypothesis:** the hex-loop split showed `ComposeStreets` at 28–60 ms per 16×16 cell compose, paid on every recompose. Every street vertex samples terrain height 3–4 times under Mono.
- **Change:** `CityRenderer.StreetCache.cs` records each road hex's instances and ground quads and replays them while its key is unchanged. The key covers everything the streets read:
  - over a 5×5-hex neighbourhood: roads, explored state, urban flag, parcels, district kind, height, water, flags, biome, craters and trench geometry;
  - globally: the base-site layout;
  - for bridged hexes only: the map-wide road and geometry revisions.
- **Diagnosis path:** a first cell-level version hit only about 5% of the time because it was keyed on `LaneRevision` and on coast tiles via `IsWet`. Miss attribution by key part led to removing `LaneRevision` from the key and restricting the global bridge revisions to river and lake spans (40% hits), and then to per-hex records.

## C4: per-tile crater spoil cache (`-perf-legacy spoil`). KEPT
- **Hypothesis:** every warzone rebuild re-placed up to 14k clods, each sampling terrain, and this happened on every econ frame.
- **Before:** warzone worst frame grew from 5 to 300 ms over the match; spoil took 150–460 ms per window.
- **Change:** clods are cached per impact tile, keyed on a 5×5 window of terrain and impacts. Order and the 14k cap are unchanged.
- **After (fix2):** spoil 2–36 ms per window; warzone worst frame ≤ 22 ms in comparable windows.

## C5: territory rebuild on a worker thread (`-perf-legacy territory`). KEPT
- **Before:** 60–130 ms main-thread spikes on each ownership change.
- **Change:**
  - The texel → hex map is cached.
  - The rebuild runs on a worker thread from a snapshot of owners, sites and colours; the texture upload stays on the main thread.
  - Only one rebuild runs at a time; a newer change re-runs it.
- **After (fix2):** worst frame about 1–3 ms.

## Not effective / not kept
- **Per-phase allocation attribution through `GC.GetAllocatedBytesForCurrentThread`:** it returns 0 on Unity Mono. The instrumentation was removed; GC attribution needs a Profiler capture (OPTIMIZATION_PLAN wave 2).

---

## N7 — stuck-unit recovery ladder: KEPT (`actionOrders.js` `stallCheck`, `STUCK`; 2026-11-18)

**Root cause**
- The old watchdog counted "no progress" against the current waypoint, and reset whenever the path length changed.
- A blocked unit re-routes every 13 ticks, and each re-route returns a slightly different path, so the counter kept resetting.
  - Ghosting, wedge escape and give-up therefore almost never fired for blocked units: they re-planned without end.
- This is also why N1's backoff hurt: the re-plans were the only escape left.

**Change**
- **Progress is displacement:** 0.5 from an anchor, or closing on the *same* waypoint.
- **A bounded ladder**, all O(1) per unit per tick except the rung's own route call:
  - ghost at 3 s, plus wedge escape and a replan when the path predates a terrain change
  - replan, or an alternate goal, at 5.5 s
  - an escape waypoint at 9 s
  - vehicle terrain unstick at 13 s: ≤ 0.9 world units, once per 30 s, never in combat, same region
  - up to 6 replans in total
  - give up at 60 s, with a quiet notice
- Collision re-routes are capped at 10 between progress.
- Counters are in `game.navStats.stuck`.

**Measurement**
- `nav-perf-bench` longMove, converge, baseJam, passage and deform; n = 250, `--ticks=2400`, seed 7.
- Before is the snapshot tree without this change and without dense forest. The two trees ran concurrently, so the ms figures are noisy; the counts are deterministic.
- In each cell, "before → after":

| scenario | arrived | stopped short | peak units stalled ≥ 4 s | peak long-blocked | route calls |
|---|---|---|---|---|---|
| longMove | 106 → 115 | 7 → 8 | 8 → 2 | 1 → 0 | 5,490 → 3,653 |
| converge | 100 → 106 | 57 → 51 | 50 → 43 | 35 → 25 | 5,205 → 3,266 |
| baseJam | 247 → 244 | 3 → 6 | 1 → 1 | 0 → 0 | 287 → 261 |
| passage (fortress_pass) | 123 → 117 | 6 → 6 | 4 → 2 | 1 → 1 | 2,971 → 1,774 |
| deform | 106 → 125 | 7 → 3 | 8 → 2 | 1 → 1 | 5,490 → 4,751 |

- longMove and deform do not finish in 2,400 ticks in either tree: about 125 of 250 are still moving and none are stuck.
- passage on fortress_pass also includes dense forest, which blocks 50 hexes to infantry there in the "after" tree.
- Nav p50: 5.56 → 5.21 ms (longMove) and 4.07 → 3.28 ms (converge).

---

# Pass 2: zoom and scrolling (2026-11-18, client)

**Report:** "laggy when scrolling and mid-game, worst at middle zoom and at very close zoom"; "trees pop in and out in battle-ridden, heavily deformed areas, together with performance drops".

**Method**
- The soak now has a zoom dimension: `-perf-zooms 2.5,12,30,80`. Each cycle measures a 15 s static window and a 9 s pan window at each camera distance. The pan moves at the speed a held pan key gives at that zoom (1.1 × Distance per second). Labels are `static@Z` / `pan@Z`.
- New per-window fields:
  - `drawMs`: the draw phase split into terrain, city, warzone, units and fx;
  - `renderMs`: render thread; `engineMainMs`: the whole main thread from FrameTiming (added after the diagnostic run);
  - `terrain`: chunks rebuilt, main-thread collect time, trees drawn and shadowed, `treesRegrown` (a chunk refill with more trees than before, the popping signal);
  - `unitInstances`, `unitsCulled`, `shadowCasters`.
- Report: `node tools/soak-report.mjs run.jsonl --zoom [--from=MIN]`.
- Same machine as pass 1 (i5-8600K, RX 7600 XT, 1920×1080, Development player, seed 7 observe, 4×). Other agents' node processes were running (about 20% of one core). Raw data: `docs/performance/data/pass2-soak-{diag,new,legacy}.jsonl`.

## Diagnosis (one capture, before any fix: `pass2-soak-diag.jsonl`, game minute 35+, about 197 units)

| window | FPS | p95 ms | units phase ms | unit instances | trees regrown / 15 s | chunks rebuilt / 15 s |
|---|---|---|---|---|---|---|
| static@2.5 | 82 | 27.8 | 6.2 | 2,164 | 87 | 52 |
| static@12 | 75 | 31.7 | 6.0 | 2,199 | 236 | 77 |
| static@30 | 71 | 22.9 | 6.2 | 3,115 | 113 | 70 |
| static@80 | 68 | 24.4 | 1.9 | 708 | 83 | 46 |

**R1: every unit on the map was built and drawn below strategic zoom.**
- `UnitRenderer.Update` had no view culling. Below `StrategicDistance` (52), every squad on the whole map became 4–12 rigged soldiers (about 1,200 triangles each, plus team gear and kit). Every vehicle became a full model.
- All unit batches use 1e5-unit bounds, so the GPU drew all of them in the main pass and in every shadow cascade.
- That is why middle and close zoom were worse than strategic zoom:
  - units phase 6 ms versus 1.9 ms at strategic zoom;
  - 2,000–3,100 instances versus 700;
  - 4–6 M triangles at zoom ≤ 30 versus 2.4 M at 80;
  - render-thread p95 up to 10–13 ms at static@12/30.

**R2: tree popping came from two independent causes. Both also rebuilt chunks.**
- **(a) A fight over the no-tree flag.** Two writers shared `TerrainRenderer.Blocked`:
  - `GameBootstrap` set wasteland tiles (GroundField scar ≥ .45) to blocked on every battlefield revision;
  - `CityRenderer.Compose` set `SetBlocked(t, IsBlocked(t))` for every hex of a recomposed cell, which is false for wasteland without a road or building.
  - Impacts dirty city cells every econ frame, so a battle-area tile flipped between "trees" and "no trees" about once per second. Each flip rebuilt the chunk: terrain mesh, water and all vegetation.
- **(b) Crater rotation.** The server keeps only the newest 6 craters per tile (`battlefield.js IMPACT.perTile`, `list.shift()`). Trees were re-derived from the current impact list (`|DamageHeight| > .012`), so a tree under a forgotten crater grew back, and later vanished under a new one.
- Evidence: `treesRegrown` was 50–236 per 15 s window in mid and late match, and 27–86 chunk rebuilds per window. The main-thread collect cost stayed small (≤ 10 ms per window). The cost was the Burst rebuild work and the visual churn.

**Not zoom-specific, but the largest single hitches (other owners):**
- City phase worst frame 100–560 ms in nearly every window: base compound compose, `CityRenderer` (base visuals agent).
- Warzone worst frame 20–100 ms: wrecks plus spoil, `WarzoneRenderer` (destruction agent).
- GC 200–460 KB/frame, with 10–27 gen-0 collections per 15 s window (not attributed).

## Changes

**P2-1: units outside the view are not built (`-perf-legacy unitcull`).** `UnitRenderer.cs`
- Below strategic zoom, a non-air unit is skipped before any per-unit work (ground height, road support, facing, figures) when its position (tile height) lies more than `CullMargin` (1.2 world units) outside any plane of the camera frustum.
- The margin covers shadows cast into the frame and men stepping in at the screen edge.
- Strategic badges (level 0), aircraft, building glyphs and casualties are unchanged. `Culled` counts the skipped units.
- Trade-off: smoothed per-squad state (spread, trench hop, mortar deploy, cover) does not advance while a unit is off-screen. A squad scrolled into view can finish a short transition (under 1 s) that it would otherwise have finished off-screen.

**P2-2: separate no-tree sources (`-perf-legacy trees`).** `TerrainRenderer.cs`, plus a one-line hunk in `GameBootstrap.cs`
- `Blocked` is now a bit mask:
  - bit 1 for towns, roads and buildings (`SetBlocked`, CityRenderer);
  - bit 2 for battle wasteland (new `SetWasteland`, GameBootstrap).
- A chunk rebuilds only when "may trees grow" actually changes. Legacy mode writes both sources to the shared bit, as before.

**P2-3: sticky tree and groundcover scars (`-perf-legacy trees`).** `TerrainRenderer.cs`, `ChunkMeshJob.cs`
- Per tile: `TreeScars` (uint, one bit per tree slot) and `GrassScars` (ulong, one bit per plant slot).
- The chunk job skips a slot whose bit is set, and sets the bit when a crater or trench kills the slot. `Finish` ORs the bits back. They reset with the world epoch.
- A tree destroyed once stays destroyed for the life of the world. Placement stays deterministic per tile and seed.
- Interaction: the destruction agent's crater healing (depth fading) no longer regrows trees either.

**P2-4: diagnostics.**
- `GameBootstrap.cs`: draw-phase split timers (`DrawMark`), a hunk in a shared file.
- `TerrainRenderer` counters.
- `GameBootstrap.Bench.cs`: `-perf-zooms` and the fields above.
- `tools/soak-report.mjs --zoom`.

## Result: same build, back to back (`pass2-soak-new` vs `pass2-soak-legacy` with `-perf-legacy trees,unitcull`, game minute 30+)

| window | FPS new / legacy | p95 ms new / legacy | p99 ms new / legacy | units phase ms new / legacy | unit instances new / legacy | render p95 new / legacy | GPU p95 new / legacy | trees regrown new / legacy | chunks rebuilt new / legacy |
|---|---|---|---|---|---|---|---|---|---|
| pan@2.5 | 173 / 105 | 8.8 / 14.2 | 17.4 / 38.8 | 0.5 / 3.1 | 27 / 1,423 | 1.2 / 5.2 | 5.9 / 8.0 | 0 / 130 | 28 / 48 |
| static@2.5 | 155 / 103 | 8.8 / 14.8 | 16.5 / 35.4 | 1.2 / 3.5 | 254 / 1,552 | 1.3 / 6.7 | 6.1 / 6.9 | 0 / 125 | 41 / 79 |
| pan@12 | 141 / 100 | 9.9 / 14.7 | 24.9 / 36.0 | 0.6 / 3.3 | 56 / 1,491 | 1.4 / 4.1 | 8.2 / 11.0 | 0 / 99 | 27 / 49 |
| static@12 | 145 / 87 | 10.1 / 18.2 | 19.8 / 61.6 | 1.2 / 3.7 | 279 / 1,668 | 1.6 / 4.3 | 7.1 / 12.1 | 0 / 133 | 41 / 80 |
| pan@30 | 175 / 124 | 10.0 / 12.5 | 20.6 / 26.3 | 0.6 / 3.2 | 38 / 1,455 | 2.3 / 1.5 | 6.8 / 8.5 | 0 / 69 | 30 / 46 |
| static@30 | 111 / 87 | 15.0 / 19.0 | 28.8 / 48.2 | 2.2 / 4.3 | 684 / 1,977 | 2.0 / 6.0 | 9.8 / 11.6 | 0 / 195 | 30 / 86 |
| pan@80 | 99 / 118 | 14.7 / 13.0 | 39.4 / 23.9 | 1.6 / 1.4 | 770 / 769 | 1.8 / 6.3 | 12.2 / 9.9 | 0 / 82 | 26 / 52 |
| static@80 | 84 / 91 | 15.7 / 15.4 | 43.8 / 25.3 | 1.7 / 1.5 | 810 / 782 | 2.6 / 4.5 | 13.1 / 12.3 | 0 / 115 | 41 / 73 |

- **Close and middle zoom (2.5–30):**
  - FPS +27% to +67%; p95 −20% to −45%; p99 roughly halved.
  - Units phase −50% to −85%.
  - Unit instances −65% to −98%.
- **Trees:** popping is gone at every zoom (0 regrown trees versus 69–195 per window). Chunk rebuilds are about 40–60% fewer; the rest are real crater, trench and road changes.
- **Strategic zoom (80):** culling does not apply there (badges). New is 8–16% lower FPS with worse p99. That is not explained by these changes: the units phase and instance counts are equal, and new draws about 20% more trees there (10.6k vs 8.6k). It is probably match divergence between runs (the legacy run's flip-flopping no-tree flag had more trees hidden at any moment) or machine noise. The idle-machine A/B should confirm it.
- **Worst frames:** 200–390 ms in both modes. They are the city base compose (not changed here).
- One run per mode; the other agents' processes were not idle. Treat the percentages as indicative until the lead's idle-machine A/B.

## Also in this pass (requests from the lead, unmeasured)
- **Camera overscroll** (`RtsCamera.cs`):
  - The focus may go a zoom-scaled margin past the old limit on every non-wrapping side: `OverscrollMargin` = clamp(0.35 × Distance, 1.5, 5 hexes). Close in, the map edge can reach about mid-screen.
  - The pan eases out over the last 60% of the margin (`EaseAtEdges`) instead of stopping dead.
  - Off the map the focus height is sea level. The ocean horizon quad (12,000 units) fills the extra view. No streaming or LOD change; all terrain chunks are already resident.
- **Dense forest (§30):**
  - The welcome `world.dense` bitset is decoded (`ProtocolDecoder`, `WelcomeMessage.Dense`), unpacked into `WorldModel.Dense` / `IsDense(t)` (still forest: biome 4), pinned, and passed to the chunk job.
  - Dense hexes get 11–12 trees (forest: 5.5–9.5) with a canopy 18% darker, and up to 6 understory plants with a shaded floor.
  - Only interior forest hexes are dense, so the extra instances go through the existing LOD bands. Tree capacity per chunk was raised to 12 per hex and understory to 6. Cost unmeasured.

**Addendum (2026-11-18, `action-pathing` "large units leave and re-enter a developed base")**
- **Root cause:** the tank was never enclosed, since short routes worked in most directions.
  - `route()` failed outright when the fine stage could not thread one corridor step. The coarse route went north through the HQ compound, between the depot, the HQ and the perimeter.
  - The order therefore reported `blocked`, and the unit got no goal. The stuck ladder cannot act without one.
- **Fix:** `route()` now penalises the coarse tile it could not thread (×8, `AVOID_PENALTY`) and re-runs the coarse search, at most 2 times (`ROUTE_RETRIES`). This happens only after a failure, so normal routes cost nothing.
  - Penalised searches bypass the corridor cache and flow fields.
  - Retries are counted in `navStats.routeRetry`.
- **Near-goal arrival:** within 1.5 (+2r) of the goal, with no 0.15 net approach for 6 s, the unit has arrived.
  - This watchdog is independent of displacement, so a hull circling a crowded court no longer wanders for a minute.
  - It resets on any goal change.
- **Result:** the scenario passes on seeds 9, 3, 5, 17, 23, 31 and 42. On seed 11 the test's exit point is on unreachable ground, so the order is refused up front.

## Pass 2b: city compose hitches, GC, warzone wrecks (2026-11-18)

The lead's follow-up: the two largest remaining hitches and GC. CityRenderer* and WarzoneRenderer passed to this workstream when their owners finished.

### Attribution (soak `pass2-soak-new`, game minute 30+, about 185 units)
- **Base cells.** A cell holding a base compound took 80–165 ms to compose even when the compound itself was replayed from its cache. Most cells were replays: 17–89 per window against 0–7 rebuilt.
  - The cell's own streets (`hexStreetsMs`) cost 160–950 ms per window.
  - The street mesh build (`finishMs`) cost 90–390 ms per window.
  - Coupled base cells were composed together in one frame.
- **City phase:** worst frame 100–560 ms in almost every window.
- **Warzone:** worst frame 7–38 ms (wrecks only; the destruction agent had already removed crater spoil).
- **GC.** Profiler capture of one late-match static@30 window (514 frames, binary log via `-perf-profile`):

| Source | Allocated per frame |
|---|---|
| Network decode on the thread-pool workers (`WebSocketLink` → `ProtocolDecoder`, Newtonsoft JObject) | 180.6 KB |
| Main thread | 119.3 KB |
| … of which the city phase | 114.6 KB |
| … everything else | under 2 KB per marker |

### Changes

**P2-5: time-sliced city composition (`-perf-legacy compose`).** New `CityRenderer.Slicing.cs`, a safe partial: C# 9 does not allow iterators in the `unsafe` partials.
- **Resumable compose.** `Compose` became a resumable job (`ComposeSteps`). It yields at checkpoints whenever the frame's slice budget (`SliceBudgetMs`, 2.5 ms) is spent:
  - between street hexes;
  - after each hex row;
  - between base compounds and their stages: road network, network drawing (between segments), presentation (after the foundation and after each socket), development, old-town blocks;
  - between buildings;
  - while walking the street mesh's quads.
- **Double buffer.** A sliced job builds into the cell's back buffer while the old cell stays drawn. The finished cell replaces it in one step, so nothing flickers.
- **Coupled base cells.** They still leave the dirty set together and are composed by one job, one after another, so the ring-invalidation livelock stays fixed.
- **Single source of logic.** The legacy and ghost paths drain the same iterators, so there is one copy of each piece of logic. `ComposeCityDistrict`, `DrawCompoundRoadNetwork` and `ComposeBasePresentation` now delegate to their step forms.
- **Placement ghost.** It now saves and restores the open record's bounds, tap and `composing`, because a job can wait mid-record.
- **Throttle fix.** The base recompose hold now runs from when a compose *finished*. In the first measured version it ran from when the job started, which let base cells recompose 40% more often.
- **Budget.** The 5 ms legacy budget raised p95 by about 4 ms (`pass2-soak-d`), so the sliced budget is 2.5 ms.

**P2-6: GC (`-perf-legacy compose` for the pools, `-perf-legacy decode` for the decoder).**
- **Pools.** A sliced compose draws into one pooled `GroundLayers` (`Reset` keeps the lists and their capacity) and builds its street mesh with one reused `MeshBuilder` (new `Clear`). The ghost keeps its own.
- **Decoder.** `ProtocolDecoder` interns property names per thread: a self-populating `JsonNameTable`, numeric keys excluded, capped at 4,096 names. The reader's char buffers are pooled per thread (`IArrayPool<char>`).
- **Equivalence.** Checked in the editor on a 44 KB synthetic snapshot (300 units, nested objects, numeric keys): the parsed tree (`ToString`) and every decoded unit field are identical with and without the change.

**Tried and reverted: a per-wreck placement cache in WarzoneRenderer.**
- Keyed on the wreck record, its index and the terrain, craters and trench cuts within two hexes.
- In battle the crater window churns, so most wrecks missed. Hashing the window cost more than placing the wreck.
- Measured: wreck time 39 vs 23.8 ms per window, and warzone worst frame 11 vs 5 ms, both against legacy. Reverted; the wreck loop is identical to HEAD again. The warzone worst frame is now 6–19 ms, so it is no longer a hitch.

**Diagnostics.**
- Profiler markers `SE.Present.<phase>`, `SE.Net`, `SE.Hud`, `SE.Units.Update`, `SE.City.Animate` and `SE.Hud.Overlays` in `GameBootstrap.cs`. They cost nothing without a profiler.
- `-perf-profile MIN` / `-perf-profile-out FILE`: one static@30 window after MIN real minutes is written to a binary profiler log.
- The soak `compose` block: worst slice ms, jobs sliced, most frames a job took, and per-stage active ms.

### GC after the change (second capture, same point of the match, 593 frames)

| Allocations | Before | After |
|---|---|---|
| Main thread | 119.3 KB/frame | 11.5 KB/frame |
| … city phase | 114.6 KB/frame | 7.1 KB/frame |
| Network decode, per frame | 180.6 KB/frame | 98.2 KB/frame |
| Network decode, per second (frame rates differ) | about 15.5 MB/s | about 9.7 MB/s |

The rest of the decode needs a streaming snapshot decoder (units arrays straight to `UnitWire`, no JObject). That is the next GC step, not done here.

### Result: same build, back to back (`pass2-soak-e-new` vs `pass2-soak-e-legacy` with `-perf-legacy compose,decode`)

Both runs have tree scars and unit culling on.

| | new, game min 0–30 | legacy, game min 0–30 | new, game min 30+ | legacy, game min 30+ |
|---|---|---|---|---|
| units | 126 | 131 | 228 | 235 |
| FPS | 200 | 191 | 155 | 164 |
| p50 / p95 / p99 ms | 5.3 / 8.3 / 11.6 | 5.1 / 7.9 / 11.9 | 6.6 / 9.9 / 13.8 | 5.8 / 9.0 / 15.8 |
| worst frame per window (mean) | 22 ms | 237 ms | 23 ms | 172 ms |
| worst frame of the run | 40 ms | 512 ms | 33 ms | 253 ms |
| frames > 33 ms per 15 s window | 0.1 | 7.1 | 0.0 | 9.1 |
| city phase worst (mean / max) | 16 / 24 ms | 234 / 506 ms | 14 / 21 ms | 165 / 248 ms |
| GC KB/frame | 43 | 135 | 51 | 167 |
| gen-0 collections per window | 5.7 | 16.7 | 4.1 | 14.3 |

- **Hitches.** The base compose hitches are gone. The worst frame of the late match fell from 253 to 33 ms, frames over 33 ms from 9.1 to 0 per window, and GC from 167 to 51 KB/frame.
- **Cost.**
  - The steady-state cost is about +1 ms at p95 in the late match; p99 is better.
  - Average FPS is 6% lower late (155 vs 164) and 5% higher early. The compose work that used to land in one frame is now spread at 2.5 ms per frame.
  - A recomposed base cell appears up to about 1 s (136 frames) after the change that caused it, and the old one stays drawn until then.
- **Strategic zoom.** The pass-2 note stands: the strategic-zoom FPS difference in `pass2-soak-new`/`legacy` (−8 to −16%) is unexplained and should be checked in the lead's idle-machine A/B.
- Raw data: `docs/performance/data/pass2-soak-{c,d,e}-*.jsonl`.

### PerfFlags now
`-perf-legacy geometry,streets,spoil,territory,basekey,trees,unitcull,compose,decode` (or `all`).
