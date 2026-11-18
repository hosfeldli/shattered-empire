# Bottleneck register

**Severity scale**
- S1: causes multi-frame freezes or a collapse in late-match play.
- S2: a large steady cost or frequent spikes.
- S3: minor.

**Owners**
- Lead: client fixes.
- Sim: server simulation and AI.
- Nav: pathfinding and movement.
- Render: rendering audit.
- Mem: memory audit.
- Impl: server implementation.

The "Result" column only records measured outcomes. See [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md) and [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md) for the numbers.

## Client (Unity)

| ID | System | Scenario | Evidence | Sev | Root cause | Experiment | Fix | Owner | Status | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 | Snapshot apply / terrain jobs | Combat, any crater/trench/geo change | Attribution soak: `impacts` apply max 400–1,200 ms, total 1–4 s per 15 s window; `geo` max 300–960 ms | S1 | Before mutating the world arrays that chunk jobs read in place, `ApplyImpacts`/`ApplyTrenches`/`ApplyGeo` call `terrain.CompleteAll`. That blocks on up to 6 running Burst chunk jobs and finishes them on the main thread | Phase split of `ClientSession` apply (PartMs) | Queue geometry updates in order. Hold new job scheduling while queued. Apply once the jobs finish on their own, without blocking. Also reuse `ApplyImpacts` scratch buffers | Lead | Fixed | fix1: impacts apply max ≤ 12 ms, geo ≤ 1 ms |
| C2 | City: base compounds | Whole match; worst while bases build up | Baseline `city` max 300–990 ms per window, early game too. Base composes about 2/s, ~100–150 ms each. Cache built 35 vs replayed 9 | S1 | Every building's 10% construction step or damage band dirties its cell, which recomposes the whole compound. The compound cache key included the map-wide `RoadRevision` (any road built anywhere) and `floor(Maturity)` (ticks continuously; only used by a disabled feature). Neighbouring base cells are composed in one frame with no budget | `BaseCellComposes`, `baseBuilt`/`baseReplayed` counters | Key on the roads and explored hexes around the compound only. Drop maturity while settlement houses are off | Lead | Fixed | Builds per window: 6–22 → 1–6 (fix1) |
| C3 | City: street draping | Every cell recompose | Hex-loop split: `ComposeStreets` ≈ 28–60 ms per cell compose, 1.1–3.4 s per 15 s window | S1 | Each street vertex samples the full terrain height 3–4 times (sectors, craters, trenches, shoreline) under Mono. All streets of a 16×16 cell are recomposed for any change in the cell | `HexLoopMs` split; street cache hit/miss counters with miss attribution | Record and replay each road hex's street output, keyed on everything it reads in its 5×5 neighbourhood | Lead | Fixed, measuring | fix3 (cell-level): hit rate ~40%, misses mostly parcels/districts and craters. fix4 is per hex |
| C4 | Compound lanes → warzone | Every base compound rebuild | `LaneRevision` bumped on every compound compose. That forced a full warzone rebuild, because trench road gaps key on it | S2 | Revision bumped without checking whether the lanes changed | Code inspection, plus warzone rebuild counter | Bump only when the lane content differs | Lead | Fixed | Included in fix3/fix4 |
| C5 | Warzone: crater spoil | Combat; grows with match age | `warzone` max 5 → 190–300 ms over 80 min. Spoil 150–460 ms per window | S1 | Every econ frame (1 Hz) re-places all crater clods (up to 14k), each sampling terrain height. Cost grows with accumulated impacts (server cap 6,000) | Warzone part timers (trench / wrecks / spoil) | Cache clods per impact tile, keyed on the tile's 5×5 terrain and impacts. Same order and same 14k cap | Lead | Fixed | fix2: spoil 2–36 ms per window; warzone max ≤ 22 ms in the comparable window |
| C6 | Territory field | Ownership changes | Max 60–130 ms per rebuild, several times per window | S2 | Full-map texel rebuild on the main thread (about 300k texels): a `TileAt` lookup per texel, a closure per border side, 2 RGBA uploads | `TerritoryMs` counters | Cache the texel → hex map. Run the rebuild on a worker thread from a snapshot; upload when done | Lead | Fixed | fix2: max ~1–3 ms |
| C7 | GC / allocations | Grows with match age | `gcKbPerFrame` 65 → 600–1,000 KB; gen0 collections about 1/s; scattered 40–80 ms spikes in units, HUD and fx | S2 | Per-frame LINQ and closures. JSON trees per message. Rebuild lists | Allocation attribution: `GC.GetAllocatedBytesForCurrentThread` returns 0 on Unity Mono, so a Profiler capture is needed | `ApplyImpacts` scratch reuse done. Per-frame cleanups pending (findings M5) | Lead | Partially fixed | Not yet measured separately |
| C8 | `bf` resend every econ frame | Whole match | Client bumps `BattlefieldRevision` every second whether or not anything changed | S2 | Server sends `bf` whole each econ frame; client treats it as always changed | — | Server omits unchanged `bf`/`fw` per viewer (S4) | Impl | See server log | — |
| C9 | Units renderer | Large armies | `units` avg 2–6 ms; spikes 40–140 ms | S2 | No frustum culling; full figure work for every unit (findings R3) | `units` positions/build/upload split | Frustum culling or Burst job (R3a/b) | — | Open | — |
| C10 | Wrap images ×3, 1e5 bounds | GPU, shadows | GPU p95 6 → 17 ms over the match | S3 now | World-wide batches drawn at all 3 wrap images, no culling (R2) | Frame Debugger draw counts | Real bounds or a single image | — | Open | — |
| C11 | First combat warm-up | First explosions | Not isolated | S3? | Lazy effect resources; no shader/PSO warm-up (R7) | Player Profiler capture | Pre-create and warm up at load | — | Open | — |
| C12 | Object accumulation | Long matches | GameObjects, meshes, materials and textures flat for 81 min | — | — | Soak object counts | — | Mem | **Rejected** | No leak |
| C13 | Physics | — | No colliders or rigidbodies used | S3 | Auto-simulation runs empty FixedUpdates | — | `Physics.simulationMode = Script` | — | Open | — |

## Server (Node)

| ID | System | Scenario | Evidence | Sev | Root cause | Experiment | Fix | Owner | Status | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| N1 | Navigation: blocked re-routing | Moving armies, jams, wrecks | Prod: navigation p50 18.8 ms at 228 units. iron_basin: 14,824 blocked re-routes (33.6 s); one unit made 1,050 route calls | S1 | `route()` ignores the units that block, so it returns the same path every 13 ticks for as long as the unit is blocked | `nav-perf-bench` aiMatch and long-move | Per-unit backoff; skip identical re-routes | Impl | See IMPLEMENTATION_LOG | — |
| N2 | Navigation: collision geometry | Moving units | `canMove` calls per moving unit rose 1.2 → 6.7 per tick; `cost()` called 109 M times in 45 min | S2 | No caching; blocked units try 8 sidesteps every tick | CPU profile | Per-tile fast path; sleep blocked units | — | Open | — |
| N3 | Route fine path | Every route | ~1.6 ms per call (`localRoute` 34%, `line` 27%) | S2 | Eager full refinement | Profile | Lazy refinement | — | Open | — |
| N4 / S6 | Group orders / AI | AI planning, player orders | AI p99 up to 372 ms locally; order latency 0.5–2.2 s at 500–1,000 units | S1 | `moveGroup` routes every unit synchronously | `action-perf-bench` G; nav sweeps | Shared route per group | Impl | See IMPLEMENTATION_LOG | — |
| N5 | Unreachable orders | Orders across water | 2.1 s at N=1,000 | S2 | No connected-region pre-check | Unreachable scenario | Region pre-check | Impl | See IMPLEMENTATION_LOG | — |
| N6 | Cache invalidation | Building add/remove | Path cache hit rate 70% → 28%; `loseBuilding` invalidates twice | S2 | Global `invalidate()` | Fuzz test | Remove the duplicate; regional dirtying | Impl (duplicate only) | See IMPLEMENTATION_LOG | — |
| S2 | Visibility | All matches | Prod p50 5.5 ms; S1000 cache misses 1,046 per pass | S2 | Disks stamped per source × team member; FIFO cache thrashes | S1000 / G | Stamp once per team | Impl | See IMPLEMENTATION_LOG | — |
| S3 | Combat acquisition | Dense battles | 4.2 → 7.3 µs per unit from 250 to 1,000 units | S3 | Queries over all owners | S* | Per-team index | — | Open | — |
| S4 | `bf` snapshot block | Grows with match age | 68 B → 34 KB per econ frame (83% of it); spectator view 102 KB | S2 | Battlefield sent whole every second | G soak | Per-viewer unchanged → omit | Impl | See IMPLEMENTATION_LOG | — |
| S5 | Autosave stringify | Every 60 game-seconds | 3 → 21 ms, growing with match age | S3 | Synchronous `JSON.stringify` of the whole state | G | Cache the encoded world arrays | Impl | See IMPLEMENTATION_LOG | — |
