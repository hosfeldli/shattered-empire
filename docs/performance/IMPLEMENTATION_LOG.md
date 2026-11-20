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


# Pass 3: late-game server (2026-11-18, server perf agent)

The user's report: "Especially later in the game the server seems like it begins having issues."

## Method

- **Bench.** New tool `tools/late-game-bench.mjs`, which runs headless all-AI matches. It is monkey-patched only; the sim source is untouched.
  - **Measured:** per-system time; tick p50/p95/p99/max and the count of ticks over 50/100/250 ms per window; `route()`/`strategic()`/`primeGroup()`/`componentOf()` calls and ms, attributed to the system that called them; GC pauses by kind, attributed to the tick they fell in; and thread CPU (`process.threadCpuUsage`).
  - **The live worker's paths:** 5 Hz delta-encoded snapshots plus geo for one connected player, with econ at 1 Hz; outbox bytes; and the autosave (serialize, stringify, gzip) every 60 game-seconds.
  - **Census:** every 30 s, the size of every Map, Set, array and typed array on the game, the civs (max and sum), the AI plans and the units/buildings. Anything that grows shows up without being named.
  - **Diagnostics:** the 25 worst ticks with their breakdown; `--prof=A-B` (CPU profile of game minutes A..B); `--heap` (allocation sampling); `--save-at`/`--from` (replay a late window from a save); `--young=MB` (young-generation size).
- **Matches.** 6 AI (normal) on iron_basin (128), continental_divide (132) and twin_continents (128), seed 7, 45–50 game minutes. Three matches ran in parallel on the 6-core dev box.
- **Machine load (read before the numbers).** Other agents were running benches and tests on the same machine for the whole pass, and CPU load was at 100% most of the time. Wall-clock tick times for the same work varied by 40–60% between back-to-back runs, and even thread CPU varied by ±7% for an identical simulation (same stateHash). Only same-hash comparisons and paired runs below are meaningful. Small differences are noise.

## Growth curve: before (HEAD 8e6bfef + in-progress tree at the start of the pass)

Mean, p95, p99 and max are tick ms per 5-minute window. GC is in-tick GC ms per window. Snap and econ are KB per message for one player.

| map | window (min) | units | mean | p95 | p99 | max | ai mean | nav mean | GC ms | snap KB | econ KB | save ms | save KB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| iron_basin | 0-5 | 100 | 9.4 | 105 | 169 | 628 | 2.8 | 2.4 | 1459 | 10 | 14 | 40 | 2139 |
| iron_basin | 10-15 | 261 | 30.4 | 169 | 394 | 1530 | 13.5 | 8.9 | 4337 | 29 | 45 | 14 | 2684 |
| iron_basin | 15-20 | 265 | 59.1 | 227 | 743 | 2973 | 27.3 | 17.2 | 6613 | 38 | 73 | 52 | 2702 |
| iron_basin | 20-25 | 156 | 56.8 | 265 | 903 | 1875 | 33.2 | 10.3 | 8333 | 37 | 83 | 14 | 2647 |
| iron_basin | 30-35 | 186 | 28.8 | 160 | 370 | 1537 | 14.5 | 6.4 | 8376 | 40 | 94 | 51 | 2727 |
| iron_basin | 45-50 | 205 | 39.9 | 210 | 506 | 1309 | 20.9 | 9.1 | 17920 | 46 | 118 | 66 | 2911 |
| continental_divide | 0-5 | 99 | 8.4 | 31 | 166 | 526 | 2.0 | 2.4 | 1285 | 8 | 12 | 30 | 2240 |
| continental_divide | 15-20 | 238 | 60.9 | 255 | 842 | 3004 | 34.5 | 14.4 | 6973 | 34 | 64 | 45 | 2808 |
| continental_divide | 35-40 | 185 | 48.5 | 252 | 609 | 1454 | 18.4 | 7.2 | 10064 | 24 | 34 | 81 | 2887 |
| twin_continents | 0-5 | 98 | 8.4 | 22 | 165 | 937 | 2.3 | 2.6 | 1992 | 8 | 11 | 41 | 2114 |
| twin_continents | 15-20 | 213 | 41.0 | 185 | 445 | 1157 | 17.3 | 13.4 | 5436 | 31 | 60 | 38 | 2657 |
| twin_continents | 30-35 | 157 | 29.0 | 211 | 419 | 1071 | 11.8 | 7.4 | 7321 | 22 | 30 | 89 | 2684 |

**What grew:** the cost per tick, not the data.

- From game minute ~10, the mean tick rose from 3–9 ms to 30–60 ms and p99 from about 165 to 400–900 ms. Single ticks reached 1.5–3 s.
- **Almost all of it was route searching:**
  - AI plans, through `moveGroup` → `candidate` → `route` → `strategic`;
  - flow fields (`primeGroup`);
  - region rebuilds (`componentOf`) after every `invalidate()`;
  - in one window on continental_divide, base engineers (`goNear`) re-ordering every 0.2 s: 13 ms a tick of `route()` from `field economy`.
- A CPU profile of minutes 6–12 on iron_basin put 30% in `planActionAI`, almost all of it `moveGroup` routing. The worst AI ticks ran single `strategic()` searches of 290 ms.
- GC grew with it: up to 18 s of in-tick GC per 5 minutes, from about 22 MB/s of allocation, mostly in navigation.

## After NAVIGATION's pass (same protocol, the tree this pass then worked on)

NAVIGATION's changes were:

- region-based instant failure;
- chase back-off;
- a fine-search budget;
- typed-array coarse search;
- cached obstacle lists and centre costs.

| map | window (min) | units | mean | p95 | p99 | max | ai mean | nav mean | GC ms | econ KB |
|---|---|---|---|---|---|---|---|---|---|---|
| iron_basin | 0-5 | 100 | 2.7 | 5 | 59 | 151 | 0.9 | 0.8 | 513 | 14 |
| iron_basin | 15-20 | 244 | 14.2 | 66 | 106 | 237 | 3.5 | 6.0 | 1466 | 70 |
| iron_basin | 25-30 | 199 | 22.7 | 114 | 185 | 472 | 5.0 | 9.6 | 5247 | 97 |
| iron_basin | 30-35 | 198 | 22.5 | 104 | 204 | 939 | 6.3 | 9.7 | 4502 | 110 |
| iron_basin | 40-45 | 164 | 13.9 | 51 | 162 | 333 | 5.0 | 4.7 | 555 | 110 |
| continental_divide | 25-30 | 169 | 18.0 | 98 | 163 | 639 | 5.0 | 6.9 | 2132 | 34 |
| continental_divide | 35-40 | 198 | 15.5 | 86 | 141 | 560 | 4.5 | 5.4 | 2740 | 31 |
| twin_continents | 25-30 | 154 | 19.4 | 108 | 165 | 386 | 4.8 | 8.4 | 3075 | 29 |
| twin_continents | 35-40 | 193 | 17.9 | 94 | 156 | 436 | 3.4 | 8.4 | 2620 | 27 |

The late-game mean was about 4x lower, but the tail was still there.

- **The worst ticks were all single AI plans (one civ, one call) taking 400–940 ms.** The time went on:
  - `primeGroup` flow fields: 130–590 ms;
  - fine routes and local detours: 100–350 ms;
  - `componentOf` region rebuilds: 80–140 ms;
  - occasional 100–390 ms GC pauses.
- **Profile of minutes 30–35 on iron_basin (31.7 s of CPU):**
  - unitMotion: 43% (`route()` alone is 34%);
  - AI: 20%, mostly `moveGroup`;
  - visibility: 8%;
  - combat: 7%;
  - snapshot build and encode: 7%;
  - field economy: 3%.

## Unbounded growth and superlinear costs: none outside navigation

The census at minute 10 against the end, iron_basin:

| structure | min 10 | min 45 | bound |
|---|---|---|---|
| `g.events` | 107 | 5973 | capped at 6000 (splices to 4000); `eventsFor` binary-searches |
| `g.wrecks` (tiles / records) | 1 / 1 | 91 / 126 | WRECK.total 400, life 600 s |
| `g.impacts` (tiles / records) | 5 / 6 | 155 / 489 | IMPACT.total 3000, healed after 300 s |
| `g.craters` / `intensity` / `scars` / `scorch` / `wear` | 5 / 24 / 0 / 3 / 890 | 107 / 264 / 230 / 98 / 781 | all decay; wear capped at 8000 |
| `g.fieldworks` (trench tiles) | 0 | 158 | player-built |
| `g.roads.edges` | 114 | 429 | player-built |
| `g.reports` / `g.log` | 0 / 0 | 30 / 0 | 30 cap |
| `civ.battlefieldMemory` (human) | 30 | 645 | at most the tile count |
| `civ.aiPlan.notes` | 15 | 18 | 18 cap |
| `g.fogCache` | 6000 | 6000 | 6000 cap (full: 12% misses late; small cost) |
| `nav.crowdCache` / `g.obstacleLists` | 369 / 12380 | 1282 / 12386 | 20000 cap / at most the tile count |
| heap | 45 MB | 89 MB | flat; no leak |

- **Autosave** grows from 2.1 to 2.9 MB of JSON (gzip 183 → 328 KB). serialize + stringify on the tick thread takes 9–15 ms, and up to 177 ms when a GC lands in it. The gzip already runs async.
- **Messages.**
  - The per-player econ message grows from 14 to 110–118 KB at minute 45 on iron_basin. The biggest parts are `buildings` 33 KB, `bf` 28 KB and `sites` 17 KB.
  - `sites` (with `tenure`, which changes every frame) is rebuilt and resent in every 5 Hz snapshot, not only in econ.
  - ws permessage-deflate is on, so the wire bytes are much smaller.
  - Not changed: a server-only delta for `sites`/`buildings` needs client agreement. ClientSession keeps `Objectives` when `sites` is absent, but `tenure` would then go stale. Recommended as a protocol follow-up.

## Changes

### Hash-neutral

Proved by stateHash equality against the frozen pre-change tree, on the iron_basin minute-30 save run to 35, 36 and 40, twin_continents run from start to minute 15, and continental_divide from start to minute 12:

| # | file | change | measured |
|---|---|---|---|
| P3-1 | actionNavigation.js `invalidate()`, `groundPrint`/`sameGround` | The ground-only caches (`components`, `centreCache`, `roadOnlyCache`, `laneCache`, `gradient`) are kept when every input they read is unchanged since the last invalidate. Most invalidates are a building placed or removed. Those inputs change only one way between two invalidates, so equal at both ends means unchanged throughout. | Region rebuilds per 5 min (iron_basin, minutes 30–35): 254 → 12, and 4.5 s → 0.2 s. Each removed rebuild was an 80–140 ms spike. |
| P3-2 | actionNavigation.js `crowding()` | The cache signature is compared code by code instead of `map().join()` into a string on every call (13.6 M calls per 5 min). A hit is exactly the old test. | `crowding` was 4.6% of all server CPU; its string garbage is gone. |
| P3-3 | actionNavigation.js `primeGroup` | The cost of entering the settled tile is computed once per pop, on the first neighbour that passes, instead of six times through `stepCost(n, t)`. | Flow-field ms per new flow: about 35 → 26 ms. |
| P3-4 | actionNavigation.js `insideFootprint`/`obstacleAt` | Indexed loops replace `for…of` with destructuring. Heap sampling attributed about 0.5 GB per 5 minutes of short-lived iterator garbage to these two. | Allocation only. |

### Deterministic behaviour changes

Run-to-run hashes are identical (test/group-route-queue.test.js).

| # | file | change |
|---|---|---|
| P3-5 | actionOrders.js `moveGroup`/`groupRouteStep`, `assign`; actionGame.js (constructor, `command`); persist.js | **Chunked group routing.** A group order routes its first `GROUP_ROUTE.now` (24) members at once. The rest go to `game.groupJobs` and are routed `perTick` (16) a tick at the start of `unitMotion`, oldest order first, against the same reserved slots and the same flow-field goal. An AI that has already routed `aiTick` (48) members in a tick queues its further orders whole. Waiting members keep their current order. A new order (`assign`) or a field order (`ActionGame.command`) cancels a member's queued route. The queue and `nextGroupJob` are saved. Bounds the 68-unit-assault and AI-expansion ticks; a 1.5 s AI plan with 12 group orders was observed. |
| P3-6 | persist.js | **Save/restore continuity.** Three pieces of runtime state are now saved: `game.convoys` (convoy pace), `game.nextConvoy`, and `nav.terrainVersion`. Before, a restored late-game match diverged from the uninterrupted one on the first tick, because every moving unit's `navVer` mismatched (stuck-ladder replan) and convoy pace and ids reset. It now diverges at tick 2: the rest comes from history kept in the nav caches (below). |

Tuning note for P3-5: smaller chunks (10/12/12) cost about +13% thread CPU (36.4 vs 31.9 s for iron_basin minutes 30–36). The flow field was re-primed for each chunk, and more 250–350 ms ticks appeared. 24/16/48 measured 33.3 and 37.9 s on the same hash, which is inside the ±7% thread-CPU noise. It engages only for genuinely large orders.

## After: paired runs from the minute-30 saves, game minutes 30–40

These are the cleanest runs of this pass: 3 runs in parallel, before and after run back to back.

| map | tree | mean | p50 | p95 | p99 | max | ticks >100 / >250 ms | ai mean | nav mean | in-tick GC ms |
|---|---|---|---|---|---|---|---|---|---|---|
| iron_basin | before (post-NAVIGATION) | 18.6 | 6.2 | 87 | 145 | 815 | 186 / 12 | 4.7 | 8.6 | 3437 |
| iron_basin | after (P3-1..6, chunks 12/12) | 17.7 | 7.0 | 65 | 119 | 1506 | 87 / 7 | 4.3 | 8.0 | 2209 |
| continental_divide | before | 17.3 | 5.3 | 86 | 138 | 530 | 175 / 11 | 4.5 | 6.5 | 3590 |
| continental_divide | after | 14.6 | 6.0 | 61 | 90 | 362 | 33 / 2 | 3.0 | 6.0 | 1848 |
| twin_continents | before | 19.9 | 6.5 | 91 | 143 | 405 | 194 / 6 | 4.4 | 8.5 | 4314 |
| twin_continents | after | 16.9 | 6.4 | 67 | 102 | 261 | 55 / 1 | 3.1 | 8.0 | 1813 |

- **Single-match A/B** (iron_basin, minutes 30–36, alternating, thread CPU s / p95 / p99 / max / ticks >250 ms):
  - before: 32.7 / 46 / 101 / 242 / 0 and 31.1 / 24 / 61 / 183 / 0;
  - hash-neutral changes only: 33.0 / 41 / 85 / 205 / 0 and 31.2 / 39 / 83 / 224 / 0.
- **A repeat of the 3-map paired run under heavier load** (6 runs in parallel) showed no difference in p95/p99 between before and after. Read the table as "p95 −25 to −30%, ticks over 100 ms halved, in the cleaner runs", not as a precise figure.
- **The one robust result is the tail:** the 0.8–3.4 s single ticks (AI plans with dozens of group routes) are bounded by P3-5, and region rebuilds are gone (P3-1).

## Threading inside a match: evaluated, not done

A late match uses about 10–20% of one core on average; the problem is the spikes. Parallelism inside a match cannot split a single synchronous AI plan or route search. The candidates:

1. **Snapshot/delta/stringify on a helper:** at most 7% of the tick. The structured clone costs about what the stringify saves.
2. **Visibility on helpers:** 8%, best case about 1 ms a tick (SharedArrayBuffer positions, Atomics.wait).
3. **AI planning off-thread:** not viable. It mutates the game synchronously and would need a full state replica (about 5 + 50 ms per hand-off) or a lockstep replica (2x CPU).
4. **Batched path searches:** the biggest share, but the order pipeline consumes `route()` synchronously everywhere. Both modes would have to defer results, and the helpers would need nav-input replicas rebuilt on every invalidate.

The lead agreed: no threading.

## GC / Node flags

- Production runs `node:22-slim` with plain `node server/index.js`; match workers get `maxOldGenerationSizeMb` only.
- **Young-generation test locally** (node 26, iron_basin minutes 28–42, 3 runs in parallel):

  | `maxYoungGenerationSizeMb` | scavenges | scavenge ms | max scavenge ms | major GCs | major GC ms |
  |---|---|---|---|---|---|
  | default | 322 | 9342 | 417 | 8 | 855 |
  | 32 | 620 | 14176 | 486 | 12 | 633 |
  | 64 | 322 | 8109 | 358 | 10 | 328 |

  - 32 MB doubles the scavenges, and 64 MB is about the default.
  - The 30–400 ms scavenges are a contention artefact: parallel scavenger threads starved on a box at 100% load.
- **Not measured under Linux** (no WSL or Docker here). Recommendation: don't add `--max-semi-space-size` blind. If it is tried, set `resourceLimits.maxYoungGenerationSizeMb: 64` on the match Worker in matches.js, since the CLI flag does not size worker isolates reliably, and compare `/api/metrics` p99 on Cloud Run gen2.

## Handed over / open

- **Flow fields** are dropped on every `invalidate()`, because their crowding depends on buildings. Keeping them is not exactly neutral: their extent depends on the members' starts, and they are not saved.
- **Remaining route cost:**
  - per-unit `fineRoute`/`localRoute` detours: 100–350 ms in the worst ticks;
  - `stopUnit` → `tacticalResume`/queued-order routes: about 6% of CPU;
  - the stuck-ladder `strictRoute`: about 5%.
- **Save/restore continuity late in a match** still diverges at tick 2. Causes:
  - nav cache history: `crowdCache` keyed by a radius bucket, not the radius; corridors and flows keyed without radius;
  - a `destinationFacing` null-vs-undefined difference.

  With exact-radius keys, 150 ticks matched. Worth a dedicated pass if deploy restores must continue the exact match.
- **Engineers can be assigned build jobs across the whole map** (`pickJob` has no distance bound for build jobs). One was seen walking about 170 units.
- **Protocol:** `sites` is resent at 5 Hz and `buildings`/`bf` in full at 1 Hz (about 110 KB per second per player before deflate, late).
- Raw data stayed in the session scratch directory and is not committed.

# Pass 4: econ deltas (2026-11-18, protocol agent)

Follow-up to Pass 3's open protocol item. Late in a match the per-player econ message is 60–110 KB: `bf` 15–40 KB, `sites` 16–20 KB (in every 5 Hz snapshot, not only econ), `buildings` 5–22 KB. Most of each is identical to what the player was sent a second earlier.

## Design

New capability **`econ-delta-v1`**, used together with `udelta`.

- The Unity client announces it in the hello (`GameConnection.WantCaps`), and `server/protocol.js` offers it.
- `worker.js` builds the player's `deltaEncoder(50, 10, { keyed: true })` only when the welcome carries the capability.
- A 0.5.0 client (no capability) and spectators get exactly what they got before.

The new code is in `server/delta.js`; the simulation is untouched.

| field | full (first message, rejoin, resync, slow safety refresh) | delta | key |
|---|---|---|---|
| `sites` (5 Hz) | `sites` + `sv` | `sd: { v, u: [records], r: [ids] }` | id |
| `buildings` (1 Hz) | `buildings` + `bv` | `bd: { v, u, r }` | id |
| `bf` (1 Hz) | `bf` + `bfv` | `bfd: { v, u: { sub: rows }, r: { sub: tiles } }` | tile within each sub-list; a listed tile replaces all of that tile's rows (order within a tile is kept; crater stamping uses the first six) |
| `ruins`, `cities` | as before | left out while identical to the last econ message (the client keeps its copy) | – |

- **Versions and gaps.**
  - A delta is sent only when something changed, and each delta increments the field version.
  - A client applies a delta only on top of `v - 1`. Any other version is a gap: the delta is dropped and the client sends `cmd { c: 'resync' }`, at most every 2 s.
  - The worker answers with `resyncEcon()` and `catchUp`, so the next snapshot carries all three fields whole.
  - A rejoin builds a new encoder, so its first message is whole too.
  - The safety refresh runs every 300 econ messages (bf/buildings) and every 1500 snapshots (sites).
- **Per-frame clocks.**
  - `tenure` changed in every frame, so every owned site counted as changed. It travels as its anchor `ta` (claim time) instead, and the client sets `Tenure = time - ta`.
  - `maturity` travels as `ml: 1` while it grows (the client computes `min(35, time - developedAt)`).
  - Remembered sites keep their literal values.
- **Client** (Core/Protocol, Session):
  - `ProtocolDecoder` decodes `sd`/`bd`/`bfd` into `KeyedDelta<T>`/`BattlefieldDelta` on the network threads. Site and building decoding were factored into `Sites()`/`Buildings()`, field for field the same.
  - `ClientSession` checks the versions and applies the deltas in wire order:
    - sites go into `Objectives`, with anchors re-derived on every snapshot (`ObjectiveSite.Rederive`);
    - buildings go into `StructureStore.ApplyBuildingChanges`, with the same dirty cells and revision as a full apply;
    - the battlefield goes into the new `BattlefieldStore` (tile groups), whose `Snapshot()` feeds the existing geometry path.
  - Full fields without a version (older servers) behave exactly as before.
- **Encoder cost.**
  - Records are compared by their JSON. `buildings` and each `bf` sub-list first compare as a whole, which is cheap when unchanged.
  - Site anchors are rest-spread copies: `delete` put the copies into dictionary mode and cost about 12%.
  - On a replay of minutes 18–22 (iron_basin, 1200 messages), keyed and legacy encode + stringify take the same time: 445 vs 445 ms.

## Measured

Tool: `tools/econ-delta-bench.mjs`.

- **Setup.** Every nation is watched as a connected player, with both encoders fed the same snapshots in alternating order. Values are averaged over the 6 players, in ±1 min windows. `--no-victory` keeps the match running past the AI's decisive win at about minute 23 (instance-only patch).
- **Measures.** Raw KB per player per minute, KB deflated per message (an upper bound for permessage-deflate with context takeover), and ms per player per minute. "enc" is delta encoding plus `JSON.stringify` on the match worker's tick thread. "deflate" is `zlib.deflateRawSync` of each message, as a proxy for the ws compression on the main thread.
- **Data:** `docs/performance/data/econ-delta-*.json`.

| map | min | udelta KB/min (deflated) | keyed KB/min (deflated) | econ msg KB udelta → keyed | enc ms/min udelta → keyed | deflate ms/min udelta → keyed |
|---|---|---|---|---|---|---|
| iron_basin | 5 | 3771 (996) | 1391 (357) | 17.4 → 6.1 | 26 → 34 | 66 → 28 |
| iron_basin | 20 | 11046 (2827) | 3776 (993) | 72.8 → 15.9 | 111 → 124 | 280 → 79 |
| iron_basin | 40 | 9894 (2529) | 2484 (672) | 59.0 → 11.4 | 67 → 79 | 192 → 49 |
| continental_divide | 5 | 3105 (818) | 1266 (297) | 14.6 → 5.6 | 22 → 29 | 54 → 25 |
| continental_divide | 20 | 11748 (3012) | 4163 (1069) | 80.9 → 17.9 | 109 → 123 | 256 → 79 |
| continental_divide | 40 | 10977 (2648) | 3001 (738) | 66.5 → 13.4 | 128 → 140 | 285 → 86 |

- **Bytes:** 2.7–4x fewer, raw and deflated. Late-match wire traffic falls from about 2.5–3 MB to about 0.7 MB per player per minute.
- **Server CPU per player** (encode + deflate): 330–410 → 160–225 ms per game minute. The deflate on the main thread falls by about 70%.
- **Tick thread:** encode + stringify is equal on the isolated replay. In the paired bench it is +10–25%, about 0.2 ms per player per second; the bench ran on a loaded machine.
- The occasional full refresh is still 80–125 KB: the "max" econ message, 6 in 720.
- **Client decode** (Unity editor, minute-40 iron_basin samples, `ProtocolDecoder.Decode`; allocation by Mono heap delta, approximate):

  | message | wire | allocated | decode time |
  |---|---|---|---|
  | econ, udelta | 51 KB | about 122 KB | 9.6 ms |
  | econ, keyed | 10 KB | about 12 KB | 1.1 ms |
  | 5 Hz snapshot, udelta | 23 KB | about 20 KB | 2.9 ms |
  | 5 Hz snapshot, keyed | 5 KB | about 4 KB | 0.8 ms |

  Per second (1 econ + 4 snapshots): about 200 → 28 KB allocated and about 21 → 4 ms of decode on the network threads. On top of that, a battlefield delta rebuilds the typed arrays (`BattlefieldStore.Snapshot`) on the main thread only when the battlefield changed.

## Other large fields resent unchanged (census, econ messages, minute 40)

| field | size | how often unchanged | status |
|---|---|---|---|
| `ruins` | 1–3 KB | 96–99% | now gated |
| `cities` | 0.3–0.5 KB | 99% | now gated |
| `trenchWorld` + `fw` | 2–5 KB | 75–95% | already gated whole for udelta (S4). Could be keyed by tile; small. |
| `civs` | 0.7 KB | 92–99% | ungated; the Unity client ignores it, the Godot client may read it |
| `units` / `wp` / `paths` | – | – | already per-record (udelta) |
| `vis` / `urban` | – | – | already only sent on change |

## Verification

- `test/econ-delta-2026-11-18.test.js`:
  - **Capability:** negotiated only when asked for.
  - **Unit checks:** delta contents, tenure anchors, a version gap, a resync, and an old encoder never emitting keyed fields.
  - **Long replay:** 20 minutes of crossroads with 4 AI, 6000 snapshots. The reference client (`keyedReceiver`, which ClientSession mirrors) is compared with the full snapshot after every delivered message, covering sites, buildings, bf, ruins and cities. The run includes:
    - a reconnect at tick 3000 (new encoder, client keeps its copy);
    - a dropped message at tick 6450. The gap is detected on the next delta, and the resync fields arrive in the following message (6 messages stale in total).

    Bytes: 23.6 MB keyed vs 80.0 MB udelta.
- `test/econ-gate.test.js` (unchanged) still passes.
- **C# parity.** The real `ProtocolDecoder`, `StructureStore` and `BattlefieldStore` were run in the Unity editor over a 20-minute keyed fixture (3371 deltas). Sites, buildings (visual key plus queue and staff fields) and battlefield equal the decoded full snapshot at all 61 checkpoints, with no gaps.
- The client compiles (Unity 6.3, no console errors).

## Risks / notes

- **Site tenure** is re-derived from the snapshot clock (rounded to 0.1 s). It differs from the server value by under 0.05 s in general; the test measured about 3e-13. It only feeds `DevelopmentStage` and a release-shots sort.
- **Version-gap recovery** costs one round trip plus a full message (about 80–125 KB late). There is no gap source in normal operation: ws is ordered, congested viewers are skipped before encoding, and a rejoin uses a new encoder. It is a safety net.
- **Ruins and cities gating** relies on the client keeping its copies when the fields are absent. Unity does. Only keyed clients get it.

# Pass 5: vehicles never block pathing; failed-route memo (2026-11-19, navigation)

Details and numbers are in docs/gameplay-overhaul/NAV_BRIDGES.md, "Pass 5".
- Wrecks and units are soft obstacles (`actionOrders.PUSH`, `nav.softWrecks`).
- Failed routes are remembered for 3 s (`route()`) and per group order (`groupRoute`).
- On the 160-map probe, late-game failed routes fell from 367–524 to 30–39 a game minute. Route time per game minute
  roughly halved (1,784 → 801 ms in minutes 21–30, 2,635 → 1,438 ms in minutes 31–40). The worst tick fell from
  439–490 to 202–250 ms.
- Hash-changing (behaviour change), deterministic.

# Pass 6: incremental warzone (2026-11-19, client, TELEMETRY_ANALYSIS_2026-11-19 B3)

`WarzoneRenderer.Update` used to clear every batch and re-place every trench detail, no-man's-land patch and wreck
(hull, scorch decal, gun barrel, five debris pieces) on the main thread in one frame whenever any of the trench,
battlefield, terrain, defence or road revisions changed. In a 4v4 that is several times a second, and the cost grows
with the wreck count (production i5: warzone 10.2 ms/frame average, frames up to 5 s).

**Changes** (`Runtime/Battlefields/WarzoneRenderer.cs`, `TrenchRenderer.cs`):
- **Per-tile cache.** Wrecks and no-man's-land are built per tile into a cell (`Cell`: one packed `InstanceData[]` with
  per-part ranges, plus the tile's burning-wreck points). A cell's key covers everything it reads: its wreck records,
  shelling stage, known/urban flags, `ActionLandscape`, and a ground key over the 19-hex disk (heights, water, flags,
  biome, crater impacts, trench geometry; local hashes memoised per tile per `GeometryRevision`). A revision change only
  re-keys the cells (0.1–1.5 ms in the editor); changed cells are queued.
- **Time-sliced rebuilds.** `WarzoneRenderer.BudgetMs` (1.5 ms) per frame: trench nodes get up to half, battlefield
  cells the rest; always at least one item a frame. The part batches are re-joined from the cells with one `MemCpy` per
  cell and part, at most once a frame, only when a cell changed.
- **Trenches** are re-keyed only on a trench, defence, road or terrain change (no longer on every battlefield change).
  `TrenchRenderer.Build` now only re-keys and queues; `Pump(budget)` rebuilds queued nodes, bakes each node into packed
  arrays, re-joins the changed groups within the budget (at least one a frame once no node is waiting) and re-collects
  the details by memcpy once everything is joined. Trench meshes are joined per 8×8-hex group instead of per 16×16
  terrain chunk (a quarter of the join per change, a few more draws).
- Wreck scatter (debris, char tint, position of wrecks without `HasPosition`) is seeded by the wreck's index within its
  tile instead of its index in the whole wreck list, so adding a wreck no longer reshuffles every other wreck's debris.
- Diagnostics: `Rebuilds` now counts re-key passes; `PartMs` = trench / battlefield cells / join ms (the bench JSON
  still labels the third one `spoilMs`); `CellsBuilt`, `CellsPending`, `LastScanMs`, `TrenchRenderer.LastPumpMs`.

**Measurement** (edit-mode harness in the Unity editor, Release code optimisation; 256² stress world, the stress
scenario's 24-node trench lines, 600→750 wrecks, 1,587 shelled tiles, 500 craters; a battlefield change every 12
frames with 2 new wrecks, 4 stage changes and 3 new craters, a trench revision every 60 frames; 900 frames timed):

| | before | after |
|---|---|---|
| warzone ms / frame, average | 10.06 | 0.60 |
| p95 / p99 | – / 173.8 | 2.66 / 3.56 |
| worst frame | 558.8 | 4.31 |
| first full build | 350 ms in one frame | 97 ms spread over 50 frames (≤ ~3 ms each) |

The before figure matches the production average (10.2 ms). Remaining frames over 1.5 ms are single trench-node builds
(0.3–2.6 ms each, the minimum one item a frame). Equivalence: after 600 frames of churn (wrecks added and removed,
stages changed and removed, craters added and removed, a trench node removed and one re-dug, wrecks without a
position), the incrementally maintained batches equal a fresh build of the final state part by part (count and
position/colour checksums of all 14 warzone parts and 3 trench detail batches, trench vertex count, burning wrecks).

**Check visually:** wrecks and no-man's-land appear within a few frames of the server reporting them (a fresh match or
rejoin with hundreds of wrecks fills in over ~1 s); trench works over 8×8 groups join seamlessly; debris around
existing wrecks looks the same in kind but is laid out differently than before (new seeding).

**B4 (session creep), not resolved in this pass.** A real soak was not possible: the editor's play mode was shared with
another agent restarting the stress scene. Object counts sampled inside that session (GameObjects 76, Meshes
968→974, Materials 310→319, Texture2D 1,175→1,186 over a few minutes, across at least one scene restart) are not
conclusive. One churn source found and reduced here: every trench re-join made a new `Mesh` and `InstanceBatch` (three
`MaterialPropertyBlock`s, freed only by the finaliser, which rarely runs with GC near 0); that now happens per 8×8 group
and only once a slice. Still to do: a standalone player soak (2–3 h, two matches and a post-match screen) logging
`Resources.FindObjectsOfTypeAll` counts per type and `cpu_frame_ms - main_ms` every minute.

# Pass 6: routing load (2026-11-19, server navigation, TELEMETRY_ANALYSIS_2026-11-19 B1)

Reproduction: `tools/route-load-bench.mjs` (pangaea, size 104, 4v4 of 8 brutal AIs, max starting resources), HEAD
e1aae82 against HEAD plus only these edits, each pair run side by side on the same (loaded) machine.

- **Localized invalidation** (`actionNavigation.invalidate(tiles, 'added'|null)` → `invalidateNear`): a building or wreck
  change drops only the corridors it lies on (or, for removals, whose A* lower bound through the change beats their
  cost), the flow fields that reached it, and the failure-memo entries it can affect. Crowding cache kept; bridge
  crossings rebuilt only on ground changes (`groundVersion`). Call sites: `actionBases.addFacility`, wreck clearing,
  `actionGame.removeBuilding`.
- **Per-tick routing budget** (`ROUTE_BUDGET = { work: 12000, admit: 6, expire: 25 }`, counted in deterministic work
  units, not wall clock): deferrable requests (chases, collision re-routes, stuck replans, return-after-chase, AI group
  members) queue FIFO on the unit (saved) once it is spent; 6 are admitted per tick regardless. `actionOrders.budgetRoute`,
  `DEFERRED`, `settleRoute`; `GROUP_ROUTE.min = 4`.
- **Cheaper failures**: one batch per `route()` so retries reuse work, retry stops when the penalised corridor still
  crosses the failed hex, unthreadable steps remembered 50 ticks per class, group orders skip remaining slots/start hex
  after a far failure.

| Seed | Run | Length | Tick mean / p95 / p99 / max (ms) | Route s | Fail ms |
|---|---|---|---|---|---|
| 2 | before | 21 min | 30.5 / 103 / 244 / 2394 | 94.9 | 42,230 |
| 2 | after | 22 min | 19.9 / 83 / 151 / 656 | 52.0 | 10,462 |
| 3 | before (quiet, sequential) | 16 min | 4.6 / 10.6 / 22.7 / 72 | 6.1 | 797 |
| 3 | after (quiet, sequential) | 18.5 min | 10.4 / 35 / 68 / 693 | 16.7 | 289 |
| 4 | before | 27 min | 17.3 / 77 / 136 / 514 | 25.3 | 1,265 |
| 4 | after | 27 min | 16.8 / 74 / 131 / 607 | 17.5 | 610 |

Seed 3 is not routing-bound; an earlier paired seed 3 result (20.7 → 10.8 ms) was load noise and is dropped. The seed 3
"after" row above ran later than "before" under different machine load: run side by side over minutes 0–10, the final
tree and the variant without its last four additions (batch work-charging, bad-step memory, retry stop, group
short-cut) did identical work in identical thread CPU (26.5 vs 26.6 s), with ~11 % more route wall time. Those additions
pay off on seed 2 (failures per minute 283 → 116 in minutes 11–15). Seed 2 minutes 11–15: tick mean 43 → 23 ms, p99 667 → 202 ms, max 2.4 s → 0.63 s. Deferral is rare (0–60 requests per
game minute, mean wait ≤ 9 ticks, max 22); most of the gain is localized invalidation and cheaper failures. Most of
seed 2's failure time came from an AI barricade on a road-only hex (fixed in actionAIWorks). Tests:
`test/nav-route-budget-2026-11-19.test.js`. Risks: a remembered unthreadable step can block approaches from other sides
for 5 s; deferred routes shift movement timing slightly; `ROUTE_BUDGET.work` was calibrated on one machine.

# Pass 7: diagnostics-driven (2026-11-19, server perf + telemetry)

## Data: BigQuery after the 2026-11-19 analysis (2026-11-20 01:11 to 03:32 UTC, build 9700bb8, `env = 'prod'`)

Four new matches: 0ed268 (PvP 2v2 with 2 AIs, saltmarsh_estuary 108, 81 min, up to 305 units), fdf76c (observed 1v1 of
AIs on a custom 232 map at 8x, up to 205 units), 23017c and 43a1cf (small).

| Match | Tick mean | p99 worst | Max | Pace | Route share of tick | Route failures | Snapshot share of worker | ms per snapshot round |
|---|---|---|---|---|---|---|---|---|
| 0ed268 | 7.4 | 64 | 189 | 1.0 | 13 % | 8 | **24.6 %** | 4.84 |
| fdf76c | 6.9 | 139 | 1,071 | 6.58 (8x asked) | 38 % | 4,984 (4,979 `other`) | 9.7 % | 10.9 |

* Scheduler shares outside navigation (31 to 43 %) and AI (10 to 32 %): **combat 11 to 20 %, visibility 11 to 18 %**,
  field economy 4 to 7 %, production 4 to 5 %. Snapshot building and encoding is the largest non-sim cost in every
  human match (25 % of worker time in 0ed268).
* fdf76c's 4,979 `other` route failures could not be read: v2 counted failed-route memo hits as `other` failures
  (fixed below, `route_memo_hits` and `nav.lastFail` reasons).
* **Client:** `cpu_frame_ms_avg` 25 to 47 ms while `main_ms_avg` (GameBootstrap.Update) was 4.6 to 9.5 ms and the GPU
  13.6 to 18.3 ms. Over 0ed268 (64 minutes) the 7950X went from 17 to 34 ms CPU frame (main 2 to 8 ms) and the i5 from 37
  to 65 ms (main 4 to 19 ms); Unity's allocated memory rose 323 to 451 MB and 378 to 694 MB. `cpu_frame_ms` turned out to
  equal the whole frame interval (including waits), so v2 cannot say whether the gap is render submission, the render
  thread, UI Toolkit or waiting: new client columns below.

## Local profile (where the server's time goes)

`D:/Projects/se_scratch/p7/bench.mjs`: the production 4v4 (pangaea 104, 8 brutal AIs, max resources, as
tools/route-load-bench.mjs) with the live worker's per-interval work: one tick per 100 ms interval, 5 Hz snapshots for
the god-view spectator **and** one fog-of-war player (keyed-delta encoded and stringified), econ every second, autosave
serialize + stringify every 60 game-seconds; `--cpu-prof`, samples attributed to the outermost system frame
(`analyze.mjs`). Seed 2, game minutes 0 to 20 (390 to 505 units), share of tick + snapshot time:

| System | Share | of which routing (nav) | Notes |
|---|---|---|---|
| navigation (`unitMotion`) | 40 % | 23 % | off limits (navigation agent) |
| **snapshots** | **24 %** | – | build 15.5 % (per-unit records ~45 % of it, sites ~14 %, 1 Hz econ block ~22 %), keyed delta 6.6 %, stringify 1.9 %; permessage-deflate (main thread) another 2.3 % |
| **combat** | **14 %** | 4 % (chase routes + line of sight) | target acquisition (`acquire`: spatial query, then friendly entries rejected one by one) about a third of combat |
| **field economy** | **6.7 %** | 0.6 % | engineers: `threatsFor` (every unit and building scanned per civ, every other tick) + `rawJobsFor` (same) two thirds |
| **visibility** | **6.6 %** | – | `fogTiles` cache churn (FIFO eviction at 6,000 entries) 30 %; per-civ site intel (`siteWire` with two whole-map filters per own site) 25 % |
| AI planning | 5.9 % | 2.1 % | off limits (AI agent) |
| production | 2.1 % | 1.3 % | |
| capture, warzone, income, victory, weather, garrison | < 1 % together | | weather 0.03 %, territory refresh ~0 |
| persistence (autosave serialize + stringify) | 0.15 % | | gzip runs on the pool |
| GC outside the scheduler | 1.1 % | | |

**Horde (Blight) mode**, 4 brutal AI defenders, seed 3, until they fell at game minute 9.8 (≤ 121 units): mean tick 1.2 ms,
p99 5 ms. The `horde` system is 22 % of tick time (13 % of all samples): creature steering (`step`, `creatureStep`),
the two flow fields (`buildField`, heap) and their navigation cost reads; no hotspot worth a change at this size. The
same paired check (before / after this pass) gave identical stateHashes; spectator bytes −19 % from P7-5.

## Changes (all hash-neutral)

| # | File | Change |
|---|---|---|
| P7-1 | `server/sim/targetIndex.js` (new), `actionGame.js` (`this.targets`), `actionCombat.js` `acquire` | **Per-side target cells.** `TargetIndex` extends the combat `SpatialIndex` (same cells, same `query()`), and also keeps each cell's entries per side (team; each negative owner its own side). `acquire` reads only the other sides (`hostileQuery`), with each entry's rank in the order the full query would have listed it; a tie in score goes to the lower rank, so the pick equals walking the full list and keeping the first best. The score is computed before `sees` / `attackRange` / `hitChance` (all side-effect free) and a candidate that cannot beat the best so far skips them. |
| P7-2 | `actionEngineers.js` `threatsFor`, `underThreat`, `rawJobsFor`, `engineerStep` | **Engineers' threat and job scans once per step.** `armedList` lists the armed units and defences (with tile and danger radius) and every civ's own buildings and units once per `engineerStep`, not once per civ; liveness, completion and ownership are read live per civ; the list is rebuilt when an entity was created or removed since (`game.nextId`, map sizes). Threats are sorted by z and `underThreat` scans only the z band a threat can reach (radius ≤ 5.8). |
| P7-3 | `actionGame.js` `fogTiles` | **Two-generation fog cache** (8,000 entries each) instead of FIFO eviction at 6,000 (an iterator, a delete and a set per miss once full). A hit is still exactly the tiles a fresh computation gives. |
| P7-4 | `actionGame.js` `siteCount`, `siteWire`, `refreshVisibility`, `viewerSnapshot` | **Site counts by index.** Inside a batch of `siteWire` calls (the site intel loop of `refreshVisibility`, a viewer's site list) one pass over buildings and units counts perimeter defences and base engineers for every site; outside a batch the old filter. |
| P7-5 | `server/sim/game.js` `snapshots` | **Spectator econ at 1 Hz (bug fix).** `observerSnapshot(full, econ = true)` was called with `econ || catchUp`, and `catchUp` is `undefined` until a spectator's first resync: `false || undefined` is `undefined`, which took the default `true`. Every spectator snapshot (5 Hz) carried the whole econ block (buildings, battlefield, cities, civs, the followed AI's plan) instead of one a second as for players. Now `!!catchUp`. Changes what spectators are sent (behaviour change of the protocol stream only; the Unity client already gates on `econ` like for players); simulation hash unchanged. |
| – | `server/delta.js` | Tried and **reverted**: comparing unit records structurally instead of as JSON strings measured the same (V8's `JSON.stringify` is as fast as the walk) with more GC. |

**Equivalence.** stateHash identical before/after every 2 game minutes on seed 2 (20 minutes, 390 to 505 units) and
every 3 minutes on seed 4 (15 minutes, ~500 units), and the FNV checksum of every snapshot string sent to both viewers
(353 MB for seed 2) identical. The "before" tree is the same working-tree snapshot with only these edits reversed
(`D:/Projects/se_scratch/p7/mkbefore.mjs`), so other agents' concurrent edits are in both.

**Paired runs** (before and after side by side on the same loaded machine; thread CPU and CPU-profile samples; wall
times were 2 to 3x inflated by other agents' load, so systems are also given normalised to navigation, which neither
side changed):

| Run | Thread CPU before → after | combat | field economy | visibility | snapshots |
|---|---|---|---|---|---|
| seed 2, 20 min (profile samples) | 163.4 → 157.1 s (−3.9 %) | 50.9 → 34.7 s (−32 %) | 30.9 → 20.9 s (−32 %) | 24.1 → 16.8 s (−30 %) | 88.8 → 88.8 s (unchanged) |
| seed 2, 20 min, earlier pair (P7-1 without ranks, P7-3, P7-4, threat sort only) | 142.4 → 138.4 s (−2.8 %) | −13 % | −9 % | −11 % | ±2 % |
| seed 4, 15 min (bench timers, ÷ navigation) | 83.7 → 81.3 s (−2.9 %) | −23 % | −19 % | −30 % | ±5 % |

**P7-5, paired** (seed 2, 20 min, god-view spectator + one player, both keyed-delta; before = everything above, after = plus P7-5; same stateHash 871ab1c5): thread CPU 181.7 → 170.8 s (−6 %); snapshot build + delta + stringify 338.8 → 267.7 s of wall (−21 %; −18 % normalised to navigation); JSON sent 353 → 279 MB (−21 %) and deflated 104 → 80 MB (−23 %); deflate time (main thread in production) 25.2 → 19.6 s. For a spectator alone the econ share drops from every snapshot to one in five, which is where production's 35 to 100 KB spectator messages (TELEMETRY_ANALYSIS B5) came from.

Tick p99 / max moved with the load (seed 2 after vs before: p95 67.7 vs 77.6 ms, p99 273 vs 309 ms); the robust results
are the per-system reductions and the thread-CPU drop. Navigation (40 %) and AI planning (6 %) are the other agents'.

## New diagnostics (schema v3, docs/TELEMETRY.md; columns not yet created in BigQuery)

* **Server** (`server/telemetry/probe.js`, `worker.js`, hooks in `actionGame.js` / `actionCombat.js` / `scheduler.js`,
  each a `game.tm?.` call that is null without telemetry): route failures by `nav.lastFail` with failed-route memo hits
  counted apart (`route_memo_hits`; the v2 miscount), `routes_by_caller[]` (the scheduler system running, `command`,
  `outside`), `nav_counters[]` (all navStats deltas), `subsystems[]` (snapshot build / delta / stringify / geo,
  `post.out`, autosave serialize / stringify / gzip wall, visibility stamp / civs, combat projectiles, `ai.plan`),
  `ai_seats[]` (plans, ms, max per seat; the AI agent can add `game.tm?.span('ai.<phase>', ms)` inside the planner),
  `gc_kinds[]` (minor / major / incremental / weak), `heap_old_space_mb`, `bytes_by_kind[]` / `msgs_by_kind[]`,
  `deflate_sample_ratio` / `deflate_sample_ms_per_mb` (1 in 64 messages over 1 KB). Test:
  `test/telemetry-v3-2026-11-19.test.js`; the existing probe test still proves hash identity with telemetry on.
* **Client** (`Runtime/App/FrameLoopTimer.cs` new, `ClientTelemetry.cs`): FrameTimingManager main-thread, render-thread
  and present-wait ms and the untracked gap; `loop_phases[]` from timestamp systems inserted into the player loop (all
  seven top-level phases, script Update, UI Toolkit update + repaint, FinishFrameRendering, PresentAfterDraw, between
  frames; removed again on quit / leaving play mode); draw calls, batches, SetPass calls and triangles (profiler render
  counters, null where a release player lacks them); `objects[]` (GameObjects, objects, meshes, materials, textures,
  assets every minute; UI Toolkit elements every fifth); `post_match_s`. Compile-checked with Unity's Roslyn against the
  project's assemblies (`D:/Projects/se_scratch/p7/cscheck.ps1`; the editor was not running).

## Not done / open

* **Client profiling of the stress scenario**: the editor was in another agent's play session at the start of the pass
  and closed afterwards; it was not relaunched. Earlier in-session ProfilerRecorder sampling of that live (small) match
  showed nothing beyond the known phases (script Update 0.8 to 1.3 ms, camera rendering 1.75 ms), so the production gap
  (15 to 40 ms per frame, growing over a match) is not reproduced by small editor scenes. The new `loop_phases`,
  render-thread and object-count columns will locate it in the first prod session after the next client release.
* **Snapshots (24 %)** are the largest remaining non-nav cost: per-unit records for every viewer at 5 Hz (5.6 M records
  in 20 minutes, ~2.3 µs each), the 1 Hz econ block (whole building list, battlefield) and keyed deltas. Candidates:
  share unit records between viewers of the same side (pvp teams), build the econ block's battlefield once per round for
  all god views, send paths only for selected units (protocol change), or move encoding to a second worker thread.
* Run `node tools/telemetry-setup.mjs` (additive) before deploying a server with schema v3.

# Pass 8: memory growth (2026-11-20, client, TELEMETRY_ANALYSIS_2026-11-19 B4)

Symptom (production, builds up to 9700bb8): Unity allocated memory 402 → 457 MB over ~80 min on a static post-match
screen (≈0.7 MB/min, ~0 GC collections, no network traffic) and 323 → 451 / 378 → 694 MB over a 64-minute match; CPU
frame time 17 → 34 ms (7950X) and 37 → 65 ms (i5) while the timed `GameBootstrap.Update` phases stayed flat.

## Audit

Static audit of all of `Runtime/` (154 files) plus `Core/` and `Net/`: every `new Mesh/Material/Texture2D/RenderTexture/
GraphicsBuffer/InstanceBatch/AudioClip/GameObject`, every `Allocator.Persistent`, `ProfilerRecorder`, every dictionary or
list keyed by an entity id, every VisualElement created outside a one-time build, every `+=` on a long-lived event.
Renderers, the HUD and the session are long-lived and reset on a new world (`world.Epoch`), and nearly all of it is
correct: textures are destroyed before re-creation, effect pools are fixed rings, audio sources and clips are made
once, UI notices/rewards/bars are capped and removed, event handlers are swapped with the connection.

**Leaks found and fixed**

| # | Where | What grew | Why | Fix |
|---|---|---|---|---|
| M8-1 | `App/ClientTelemetry.cs` `Frame` / `StartRecorders` (0.6.0: `Frame`, `gcAlloc`) | native memory and per-frame profiler work, every frame, in every phase (menu, match, post-match) while Share diagnostics is on | `if (!rec.Valid) rec = ProfilerRecorder.StartNew(...)` every frame. `StartNew` always creates a native recorder (`Create(GetByName(...))`, UnityCsReference ProfilerRecorder.bindings.cs) and `Valid` is `handle != 0 && GetValid(handle)`: for a counter the player does not publish ("GC Allocated In Frame" is development-only, the code's own comment says so; Pass 7 added 10 more, some of them, e.g. the object counts, likely development-only too) `Valid` stays false, so a new recorder was made each frame and the previous one was never disposed. At ~60 fps, ≈200 bytes a frame is the observed 0.7 MB/min, and every live recorder is attached to the counter, so frame cost rises with session age outside the timed phases. The editor (where earlier soaks ran) publishes these counters, so it never showed up there. | each recorder is started once per enable and always `Dispose`d (not only when `Valid`) when diagnostics are switched off; `Process` handles disposed |
| M8-2 | `UI/Hud.Action.cs` `objectiveMarkers` | VisualElements (marker root, badge, icon, label) | keyed by site id, only hidden, never removed: destroyed sites and every earlier match's sites stayed in the UI tree | markers of sites no longer in `session.Objectives` are removed (checked every 120 frames when there are more markers than sites) |
| M8-3 | `Rendering/InstanceBatch.cs` | native memory per batch | the 4–64-instance Persistent array and three MaterialPropertyBlocks were allocated in the constructor. A city cell has 44 part batches and a chunk can hold two cells (shown + back buffer, `CityRenderer.Slicing.cs`), most parts empty: ~100 KB + 132 native property blocks per empty cell, growing as chunks get composed through a match. Disposed blocks were left to the finaliser | array allocated on first `Add`/`Grow`/`Data` access (`Data` is now a `ref` property, callers unchanged), blocks on first upload; `Dispose` clears the blocks |
| M8-4 | `Cities/CityRenderer.Catalog.cs` `SetGhost` | ghost cell's `Flags` list | cleared batches but not flags on each recompose (every cursor/parcel move while placing) | `ghost.Flags.Clear()` |
| M8-5 | `Cities/CityRenderer.cs` epoch reset, `CityRenderer.Defenses.cs` `AnimateTurrets` | `DamageEmitters`, `embrasures`, `mounts` | per-building state never reset on a new world; emitters and embrasures of destroyed buildings never removed (ids are reused, so a new match's building could smoke with an old one's fire) | cleared on a new world; gone buildings pruned every 2 s |
| M8-6 | `Core/Units/UnitStore.cs` `Remove` | `Paths` | a removed unit's path stayed until the server listed it in `PathsGone` or a full resync | removed with the unit |
| M8-7 | `UI/MapPreview.cs` `cache` | Texture2D | every seat layout / team split / edited sketch made a new preview texture, never destroyed | capped at the newest 128 (oldest destroyed) |
| M8-8 | `UI/MapBuilder.cs`, `MainMenu.Builder.cs` | Texture2D | one sketch canvas texture per opening of the map builder | the replaced view's texture is destroyed |
| M8-9 | `UI/Hud.Overlay.cs` `orderMarks` (static), `underFire` | dictionary entries | pruned only while the battle overlay draws | cleared while it is hidden (entries live 1.5 / 3.5 s) |
| M8-10 | `Effects/WeatherPresenter.cs` `approachNoted` | dictionary entries | one per airfield/HQ that ever had a storm notice | entries past the 90 s hold pruned |

**Checked, bounded, left as is:** `UnitRenderer.lastShot/shotCounts/incoming` (cleared at 4,096), city back-cell buffers
(bounded by the map, freed per match; reuse is deliberate), `InstanceBatch.Grow` never shrinking (bounded by the session
peak), `UiKit` fader `ConditionalWeakTable` (managed, weak), `WebSocketLink` cancellation sources (managed),
`HordeRenderer.Rising` (Blight agent's file; ids that never become units stay until the next match's welcome).

**Soak harness:** the `-perf-soak` window rows now also log `allocatedMb` (`Profiler.GetTotalAllocatedMemoryLong`),
`reservedMb`, `monoUsedMb`, `gcTotal`, Texture2D / RenderTexture / AudioClip counts and the UI element count.

## Measurements

**M8-1 confirmed in the editor** (edit mode, `execute_code`): `ProfilerRecorder.StartNew` on a counter that does not exist
returns `Valid == false` and still grows Unity's allocated memory by **345 bytes per recorder** (20,001 recorders); a
counter the editor publishes ("GC Allocated In Frame") is `Valid`. 345 B × the post-match frame rate of 36–52 fps is
0.75–1.1 MB/min, which matches production's 0.7 MB/min on the static screen with ~0 GC (the recorder is a struct, so
no managed garbage). The frame-time side (each live recorder attached to the counter and serviced every frame) is
inferred, not measured. In a 0.6.0 release player one recorder leaked per frame; the Pass 7 tree (not yet released)
could leak up to 11 per frame.

**Not measured:** the long soak (minutes of a match, several match restarts and returns to the menu, per-type object
counts every minute). The editor was not running for most of this pass; when it came up it was another session's,
importing, and an editor soak would not show M8-1 anyway (the editor publishes the development-only counters). To
confirm in a release player: `-perf-soak 60 -perf-window 60` against a local server (the window rows now carry
`allocatedMb`, `monoUsedMb`, per-type counts and `uiElements`), or simply compare the next release's `client_minute`
rows on the post-match screen (`objects[]`, `untracked` ms) with B4's table. Expected: `allocatedMb` flat on a static
screen, CPU frame time no longer rising with session age; in matches, lower city native memory (M8-3) and no
growth across matches from markers/emitters (M8-2, M8-5).

Compile: `D:/Projects/se_scratch/p7/cscheck.ps1` (Unity's Roslyn against the project's assemblies) clean; the one-line
`Core/Units/UnitStore.cs` change is outside that check (SE.Core is referenced as a built DLL).

**Residual risks:** M8-3 allocates a batch's array and property blocks lazily on the main thread at the first add/upload
(the same work as before, later); `InstanceBatch.Data` is now a `ref` property that allocates on access. M8-7 can
destroy a preview texture still shown on a menu page once more than 128 distinct previews were made in one session
(the page shows it again when it redraws). M8-2 removes markers of sites the session no longer lists; a site that
briefly leaves `Objectives` gets a new marker when it returns. The frame-time creep is attributed to M8-1 by inference;
if `untracked` ms still rises in the next release, look at UI Toolkit repaint and render-thread submission next.
