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
