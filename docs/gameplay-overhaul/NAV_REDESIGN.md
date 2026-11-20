# Navigation redesign (2026-11-19)

Request: "redesign this pathfinding method around complete optimization, research the best and most optimized
pathfinding methods, implement them so it works completely, never fails, and runs super efficiently."

This document has five parts: the research survey, a profile of where the current router actually spends its time,
the architecture chosen and why, what was implemented, and verification and measurements. The code is in
`server/sim/actionNavigation.js` (router) and `server/sim/actionOrders.js` (one call site). The tests are in
`test/nav-redesign-fuzz-2026-11-19.test.js`.

## 1. Research survey

| Technique | What it is | Claimed gain | Fit for this game |
|---|---|---|---|
| **HPA\*** (Botea, Müller, Schaeffer 2004) [1] | Clusters with border entrances, precomputed intra-cluster costs, a search on the small abstract graph, then local refinement. | Up to ~10x faster than optimised A\*, paths within ~1 % after smoothing. Dynamic changes recompute only the touched clusters. | **Already the shape of our router.** A hex (~1.7 world units) is the cluster, the coarse hex A\* is the abstract search, and the fine stage refines. Corridors are cached and invalidated locally (Pass 6), which is HPA\*'s dynamic rule. |
| **HAA\* / Annotated A\*** (Harabor & Botea 2008) [2] | Clearance annotations per terrain-capability set, so one abstraction serves every agent size and class. | A fraction of the grid's memory, near-optimal paths. | Per-class regions and per-class costs already exist. A raster clearance field was **rejected** (see 3.2): it would have to be conservative, and that closes the 0.13-wide bridge lanes tanks use. |
| **JPS / JPS+** (Harabor & Grastien 2011, 2014) [3] | Symmetry breaking on uniform-cost 8-connected grids, with jump distances precomputed in JPS+. | Up to an order of magnitude over A\*. | **Rejected.** It is correct only on uniform-cost square grids. We have weighted hexes (roads, hills, forest, slope) and continuous-space bodies. |
| **Navmesh + funnel** (Lee & Preparata 1984; Mononen's "simple stupid funnel" [4]; TRA\* (Demyen & Buro 2006); Recast/Detour TileCache [5]) | A\* over polygons, then string pulling through portals. TileCache rebuilds tiles for dynamic obstacles. | Linear-time path smoothing; TileCache is aimed at simple, semi-static obstacles. | Our fine stage is a funnel in spirit: portals and hubs plus string pulling with a line test. A real constrained-Delaunay mesh rebuilt on every building, wreck and road change (several a second late in a match) would cost more than it saves, and it adds float-geometry determinism risk. |
| **Theta\* / Lazy Theta\*** (Nash, Koenig, Tovey 2010) [6] | Any-angle A\* using line-of-sight parent shortcuts. | Lazy variant needs about 10x fewer LOS checks; 8-grid paths are up to ~8 % longer than any-angle. | String pulling after the search already gives any-angle legs. Theta\*'s LOS-per-expansion cost is what we are trying to avoid. |
| **Flow fields / continuum crowds** (Treuille et al. 2006 [7]; Emerson, *Game AI Pro* ch. 23, Supreme Commander 2 [8]; Planetary Annihilation [9]) | One integration field per goal, shared by every unit of a group. SupCom2 builds sector fields only along the portal corridor. | Hundreds to thousands of agents per field. | **Kept.** Shared Dijkstra flow fields for groups of 4 or more (`primeGroup`) already exist and cost under 2 % of CPU in the profile below. |
| **StarCraft II** (Anhalt, Kring, Sturtevant, GDC 2011 [10]) | Constrained Delaunay mesh re-triangulated locally on building changes, a radius-aware funnel, units off the mesh with boids steering. | n/a | Our "units never block pathing, push-through, stuck ladder" (Pass 5) is the same split: static geometry is pathed, and units are steering. |
| **ALT / differential heuristics** (Goldberg & Harrelson 2005 [11]; Sturtevant et al. 2009 [12]) | Landmark distances give a tight, admissible heuristic on weighted graphs. | 6–14x fewer expansions. | Evaluated and **not adopted now**: the coarse search is 1.4–2.4 % of CPU (see 2), and every road built or worn changes the ground and would need k Dijkstras per class. It can be revisited if the coarse search ever dominates. |
| **Contraction hierarchies, SRC/CPD, subgoal graphs** (GPPC winners [13], Uras & Koenig [14]) | Heavy preprocessing on static maps. | Microsecond queries. | **Rejected.** They assume static (and for subgoal graphs, uniform-cost) maps, and ours change constantly. |
| **D\* Lite / LPA\*** (Koenig & Likhachev 2002) [15] | Incremental replanning reusing per-agent search state. | Good for one agent and a fixed goal. | **Rejected** in favour of localized cache invalidation (Pass 6). With ~560 units and constantly changing goals, per-agent search state does not pay. |
| **RVO / ORCA** (van den Berg et al. 2008/2011) [16]; boids (Reynolds 1987) | Velocity-obstacle local avoidance. | Thousands of agents in milliseconds. | Floating-point linear programs are a lockstep-determinism hazard, and ORCA deadlocks in chokepoints. The existing deterministic steering plus push-through plus stuck ladder stays. |
| **Engineering practice** (Red Blob Games [17], Amit Patel's heuristics notes [18]) | Typed arrays, generation stamps, no allocation in hot loops, deterministic heap tie-breaks, an admissible heuristic scaled to the cheapest terrain, per-tick budgets with a FIFO queue, O(1) connectivity rejects. | n/a | Applied throughout; see 4. |

Sources:
1. https://webdocs.cs.ualberta.ca/~mmueller/ps/hpastar.pdf
2. https://users.cecs.anu.edu.au/~dharabor/pathfinding.html (DOI 10.1109/CIG.2008.5035648)
3. https://ojs.aaai.org/index.php/ICAPS/article/view/13633 and https://ojs.aaai.org/index.php/SOCS/article/view/18254
4. digestingduck.blogspot.com, "Simple Stupid Funnel Algorithm", March 2010
5. https://groups.google.com/g/recastnavigation/c/F9mRO_eimEI
6. https://ojs.aaai.org/index.php/AAAI/article/view/7566
7. https://grail.cs.washington.edu/projects/crowd-flows/78-treuille.pdf
8. http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf
9. https://www.pcgamer.com/planetary-annihilation-devs-show-planet-creation-tech-clever-unit-pathfinding
10. GDC 2011, "AI Navigation: It's Not a Solved Problem – Yet" (summaries, e.g. https://www.gamedev.net/topic/624135-does-starcraft2-use-navmesh-a-or-grid-a-for-pathfinding/)
11. https://www.microsoft.com/en-us/research/publication/computing-the-shortest-path-a-search-meets-graph-theory
12. https://ijcai.org/proceedings/2009/107 and https://ojs.aaai.org/index.php/SOCS/article/view/18169
13. https://www.cs.du.edu/~sturtevant/papers/sturtevant2015gppc.html
14. https://ojs.aaai.org/index.php/AAAI/article/view/8845
15. https://idm-lab.org/bib/abstracts/Koen02e.html
16. https://gamma.cs.unc.edu/ORCA/
17. https://www.redblobgames.com/grids/hexagons/ and https://www.redblobgames.com/pathfinding/heuristics/
18. https://theory.stanford.edu/~amitp/GameProgramming/Heuristics.html

**Conclusion of the survey.** The literature's answer for a dynamic, weighted, multi-class RTS map is a hierarchy:
- an abstract search over clusters with local invalidation;
- shared flow fields for groups;
- a local refinement with string pulling;
- deterministic steering for units.

That is the architecture the router already has. The leverage is therefore in executing each layer at the cost the
literature assumes: O(1) primitive tests, no repeated work, and no allocation.

## 2. Where the time actually goes (measured before designing)

`node --cpu-prof tools/route-load-bench.mjs --seed=2 --minutes=24` on the pre-redesign tree (8 brutal AIs, size 104,
about 450 units late). Inclusive share of all CPU:

| Function | % |
|---|---|
| unitMotion (all movement, including its own canMove tests) | 47.4 |
| route() | 22.1 |
| canMove / canStand (from motion and routing) | 21.2 / 20.4 |
| fineRoute (fine stage) | 18.7 |
| line() | 16.5 |
| **localRoute (local grid detours)** | **14.4** |
| cost() (roadAt 5.6) | 9.8 |
| obstacleAt | 7.4 |
| strategic (coarse hex A\*) | 2.4 |
| primeGroup (flow fields) | 2.1 |

The coarse search, the part every textbook speeds up, is 2.4 %. The cost is in the fine stage and in the standing
test (`canStand`), which both movement and routing call millions of times a minute. Inside localRoute most edge tests
were repeats:
- a blocked cell was tested again from every neighbour that tried to step into it;
- a stale heap entry re-expanded a settled cell and was charged to the budget;
- each search allocated Maps and a point object per probe.

## 3. Architecture

### 3.1 Layers (kept, with each layer brought to its literature cost)

1. **Connectivity** (`componentOf`): per-class regions; an O(1) reject for cut-off goals (precomputed connectivity per class).
2. **Abstract search** (`strategic`): hex A\* with an admissible heuristic scaled to the cheapest step (Patel). Corridors are cached and invalidated locally (HPA\* dynamic rule, Pass 6).
3. **Groups** (`primeGroup`): a shared Dijkstra flow field per class and goal (SupCom2 / continuum-crowds style).
4. **Refinement** (`fineRoute`): portals and hubs along the corridor, string pulling with a body-aware line test (a radius-aware funnel equivalent), and **local grid A\* detours** where a leg is blocked.
5. **Steering** (`unitMotion`, unchanged): deterministic avoidance, push-through, stuck ladder.

### 3.2 Considered and rejected

- **Raster clearance grid / navmesh for the fine stage.** To be safe it must be conservative: the cell is inflated by its
  half-diagonal, otherwise a path accepted on the raster can fail the exact `canStand` the units move by. Inflation
  closes the narrowest lanes, such as a tank's ~0.13 margin either side of a bridge road. That is exactly where routes
  must not fail. Exact tests with memoisation get most of the speed without changing which ways exist.
- **ALT landmarks.** See the table above: the coarse search is not the bottleneck, and landmarks go stale on every road change.
- **ORCA.** Determinism and chokepoint deadlocks; see the table above.

### 3.3 Guarantees

- **No silent failure.** `nav.routeOrNearest(from, to, def)` (and `nav.fallback` after a failed `route`) always returns a
  path plus a reason, or null with the router's reason. The reasons:
  - `ok`: the route reaches the goal.
  - `goal`: the goal point itself is unstandable, so the route goes to the nearest standable spot within 1.25.
  - `fine`: the goal is in the unit's region but no fine corridor threads now (a crowded court), so the route is the
    coarse corridor's hex-centre waypoints, ending at the goal; local avoidance and the stuck ladder work along it.
  - `cut`: the goal is in another region (island, unbridged river), so the route goes to the nearest reachable ground,
    found ring by ring around the goal, nearest centre first.
  - null: only when the unit stands where no route can start.

  Orders started by `startOrder` (queued waypoints, resumed orders) use it, so a unit never just stands still. Group
  orders keep their existing pre-check and player feedback (`reachQuery`, "build a bridge", "unreachable").
- **Bounded per request.** The coarse search is bounded (`STRATEGIC_LIMIT`, `N/2` within one region). The fine stage is
  bounded by `ROUTE_LOCAL_BUDGET` expansions, now counted on distinct settled cells only. Retries are bounded
  (`ROUTE_RETRIES`). The fallback adds at most `NEAREST_TRIES` (3) routes plus a ring scan of `NEAREST_RINGS` (24) of
  O(1) lookups. The per-tick routing budget and FIFO queue (Pass 6) are unchanged.
- **Deterministic.** There are no wall-clock decisions. All new state is typed arrays, stamped per search. Heap ties
  break on (priority, cell index). Memo results are pure functions of the world at the time of the search.
- **Save-compatible.** No saved field was added or changed. Navigation caches are not saved (they rebuild lazily).
  `u.path` remains an array of `{x, z}`.

## 4. Implemented

### L0: exact acceleration of the primitives

These give bit-identical results. The stateHash after 4 game minutes of 8 brutal AIs was identical before and after.
- `insideFootprint`: each footprint has a bounding reach (its farthest wall corner, plus 1e-6). A probe beyond reach + r
  is rejected before the rotation and per-wall tests. The wall sines and cosines are computed once per footprint
  instead of on every call.
- `canStand`: a body wholly inside its hex's inscribed circle (less 1e-3 for the Float32 centres) skips the four rim
  probes. These were already skipped whenever they fell on the same hex, but each still cost a `tileAt`.
- `roadAt`: the ring-road loop no longer allocates an iterator or an empty array per call.
- `canMove` escape rule: the same test over the same obstacles without building two Sets, two spread arrays and copied
  wreck records per call (`escapeTile`). The verdict does not depend on order or duplicates.

### L1: fine stage, `localRoute` rewritten

- Reused typed arrays (g, parent, seen/shut generation stamps) and a typed `IndexHeap` with (priority, id)
  tie-breaking. There are no Maps and no per-probe objects.
- A **closed set**. The heuristic (straight distance / step) is consistent with the 1 / 1.414 step costs, so a settled
  cell is final. Stale heap entries are skipped and no longer consume the expansion budget.
- A **per-search standing memo**. A cell's centre is tested once. A blocked cell is refused to every neighbour without
  further tests whenever the stepping cell itself stands (then canMove's escape rule cannot apply).
- Each edge is accepted exactly as `line(p, q, def, .14)` would accept it: the same samples, the same lane
  sub-samples, the same escape rule. The end sample is the cell centre itself.
- `localRouteB` (batch memo) and the `ROUTE_LOCAL_BUDGET` accounting are unchanged.

### L2: no silent failure

- `routeOrNearest` and `fallback` as described in 3.3.
- `actionOrders.startOrder` uses the fallback when `route()` fails.
- Counted in `game.navStats`: `fallbackGoal`, `fallbackFine`, `fallbackCut`.

## 5. Verification and measurements

### Equivalence

L0 (every primitive change, including `roadAt`'s distance-first test and an indexed `SpatialIndex.read`) is
hash-identical to the old code. With the new `localRoute` swapped back for the old one, the stateHash is unchanged:
- `route-load-bench` seed 4, 5 game minutes: 3ed198d4 in both.
- seed 2, 6 game minutes: 3336e3a4 in both.

The new `localRoute` and the fallback change behaviour (and the hash) on purpose. Both are deterministic: the fuzz test
runs the same field twice.

### Tests

- The full suite passes in the copy (`node --test test/*.test.js`). No existing test was changed.
- New file `test/nav-redesign-fuzz-2026-11-19.test.js`:
  - 5 random fields: mountain ridges, a lake, a wide river (bridged half of the time), 18 field structures at random
    yaws, 14 wrecks.
  - Every ground class (rifle squad, armored car, tank).
  - About 90 requests per run.

  Properties checked:
  - **valid:** every leg passes `line()`, and every point sampled 0.05 apart is on finite-cost ground and outside walls
    and wreck hulls. A soft-wreck path (Pass 5) is checked with wrecks soft.
  - **complete:** whenever an independent 0.1-grid flood fill (cells and edge midpoints standable) joins start and goal,
    `route()` finds a path.
  - **near-optimal:** path length is at most 1.6x the flood fill's shortest way (worst seen: 1.44).
  - **nearest:** every unreachable request gets a reason, and a fallback path whose goal is standable and in the unit's
    own region (27 of 27 got a path).
  - **determinism.**
  - **island order:** a tank given a queued order onto an island drives to the shore 3 hexes off it instead of standing still.
- The same fuzz properties against the old router: also valid, complete and 1.44x worst on identical requests (it
  finds the same routes), with 0 of 28 unreachable requests getting anything.

### Benchmarks (paired: old and new run side by side on the same machine at the same time)

`tools/route-load-bench.mjs`: pangaea size 104, 8 brutal AIs 4v4, max resources, 25 game minutes or until the match
ends. Tick mean / p95 / p99 / max in ms. Run 1 was on a quiet machine.

| Seed | Router | Tick mean / p95 / p99 / max | Route s | ms / route | Failures / min | Coarse retries | Thread CPU s per sim s |
|---|---|---|---|---|---|---|---|
| 2 | old | 14.0 / 40.4 / 77.9 / 223 | 43.1 | 1.54 | 5.3 | 1,190 | 0.102 |
| 2 | new | **12.1 / 32.1 / 52.5** / 230 | **25.5** | **1.09** | **2.8** | 796 | **0.085** |
| 3 | old | 6.5 / 12.9 / 21.7 / 90.8 | 7.9 | 0.43 | 59.0 | 149 | 0.056 |
| 3 | new | 6.3 / 12.0 / 20.0 / 75.8 | **5.6** | **0.30** | 17.1 | 133 | 0.054 |
| 4 | old | 10.0 / 28.3 / 45.8 / 123 | 30.4 | 1.21 | 16.4 | 1,394 | 0.094 |
| 4 | new | 10.2 / 30.0 / 46.5 / 149.5 | 32.2 | 1.28 | 16.5 | **750** | 0.095 |

Run 2 (the final code with the last two exact L0 changes) was on a heavily loaded machine; wall times were 3–8x
slower for both routers:
- The route and failure counts match run 1 exactly, which confirms the last changes are behaviour-neutral.
- Paired ratios: route time −33 % (seed 2), −22 % (seed 3), +2 % (seed 4).
- Thread CPU: −10 %, −4 %, −1 %.

Notes:
- Seed 3's failure drop (59 to 17 a minute) is mostly region cut-offs from `chase` in a different combat history, not
  a router effect.
- Seed 2's fine-stage failures halve (82 to 44); that is the closed set no longer wasting the expansion budget.
- Seed 4's routing is dominated by stuck-ladder strict replans and group-slot routes in open ground, where `localRoute`
  is rarely needed. There it is a wash.

`tools/nav-late-game-probe.mjs` (twin_rivers, 4 normal AIs, 16 game minutes, the match ends):

| | Old | New |
|---|---|---|
| Identical route calls | 1,503 | 1,503 |
| Route ms | 4,620 | 3,627 (−21 %) |
| Standing tests per minute | | −10 % |
| Stuck-unit samples | 7 | 7 |
| Give-ups | 0 | 0 |

The route ms come from run 2; run 1 showed −20 to −35 % per minute.

`tools/nav-bridge-city-repro.mjs` (seeds 3, 7, 11, 41; bridges, base courts, wreck jams, parked vehicles, 2,198 unit
orders):

| | Old | New |
|---|---|---|
| Arrived | 2,192 | 2,191 |
| Halted | 6 | 7 |
| Never arrived | 0 | 0 |
| Gave up | 0 | 0 |
| Route ms | 6,017 | 4,384 (−27 %) |

### Residual risks

- The new `localRoute` reaches further within the same `ROUTE_LOCAL_BUDGET` because stale pops no longer count. Some
  detours that used to fail now succeed, and those detours can be longer (bounded by the fuzz test's 1.6x).
- `fallback` in `startOrder` moves units that used to stand still: queued or resumed orders onto cut-off ground now
  drive to the nearest shore or bank. Group orders (`moveGroup`/`deployLine`) are unchanged, and so is the AI's
  routing (`assign` always passes a path).
- `fallback` costs up to 3 extra routes, and it runs only after a failure. Failures are memoised for 30 ticks.
- The coarse layer is unchanged. On 160-size maps with long cross-map orders the coarse A\* (`N/2` bound) can still
  spike. ALT landmarks are the documented next step if profiles show it.
