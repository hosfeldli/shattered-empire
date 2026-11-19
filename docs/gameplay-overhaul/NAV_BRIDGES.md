# Navigation at bridges, in cities and around wrecks; no bridges at match start (2026-11-18)

User reports:
- *"The pathfinding is still bugged, specifically with bridges and cities. The roads attached to bridges over rivers
  shouldn't be built until the road is built."*
- *"Path finding also has issues around rusted cars."* These are the battlefield wrecks.

## For the AI: `roadRouteBetween`

```js
import { roadRouteBetween } from './actionEngineers.js';
roadRouteBetween(game, civ, from, to, { preview = false } = {})
//   from, to: tile indices or points { x, z }
// -> { ok: true, edges, bridges, skipped, cost: { materials }, route: [tiles] }   (preview: nothing paid or queued)
// -> { error, code }   code: 'points' | 'route' | 'length' | 'funds' | 'projects' | 'built'
//                       | a roadBuild refusal code ('territory' | 'foundation' | 'blocked')
```

What it does:
- Plans a road from `from` to `to` with the road planner: heavy-vehicle ground, rivers bridged, never across open
  water or a lake (`nav.strategic(..., buildingRoads = true, ..., ROAD_SEARCH)`).
- Orders the road exactly as a player's road stroke (`actionEconomy.roadBuild`), under the same rules:
  - the route must be visible;
  - it may cross the player's own territory or neutral ground only;
  - it stays out of hostile headquarters compounds, base foundations and structures;
  - the price is the same;
  - the per-player limit of 24 projects applies;
  - the base engineers build it.
- A road longer than `ROAD_ROUTE_MAX` (120) segments is refused with `code: 'length'`. Build it in sections.
- Edges the rules skip (fogged, foreign, through a structure) are left out and counted in `skipped`, as with a stroke.
- Cost: one A* over the map (up to N nodes). Call it when deciding to build, not every tick.

## The crossing rule (goal 2)

**Before.** `actionMap.layCrossings` paved every crossing on the planned city-to-city corridors at match start:
bridges, marsh causeways and slope cuttings. The authored maps' roads did the same. The result was short stubs over
rivers that led nowhere.

**Now.** No bridge, causeway or cutting exists at match start. `layCrossings` is gone:
- Procedural corridors are still planned, because they shape the coast.
- Authored roads are still routed, because that validates the catalog.
- Neither is paved.

The compound streets (`compoundSpokes`) no longer run onto a river hex, so no street is a bridge either.

**A bridge is laid with the road through it.** It is laid by any of:
- the claim road (`actionBases.establish` / `planClaimRoad`);
- a player's road stroke (`roadBuild`);
- `roadRouteBetween`;
- the free automatic links (outposts, New Base).

All of them already used the road planner, which crosses rivers. The bridge is the road segment with a river end.

**Price** (`actionMap.ROAD_BRIDGE_COST`, `roadEdgeCost`, `roadEdgesCost`):

| Segment | Materials |
|---|---|
| Plain road, marsh causeway or cutting (`ROAD_EDGE_COST`) | 15 |
| Bridge segment: an end on a river hex, not a lake (`ROAD_BRIDGE_COST`) | 40 |

- A crossing of one river hex is two bridge segments (bank, river, bank): 80 Materials, against 30 for plain road.
- The claim road's settlement price uses the same table: HQ + 15 per segment + 40 per bridge segment.
- The road tool tooltip says so (`Hud.Base.cs`).

**Consequences**
- Vehicles that need a bridge cannot cross a wide river until a road crosses it. A wide river is flow >= 94, and it
  blocks every non-infantry class. The same holds for marsh (wheeled) and steep slopes (wheeled, tracked).
- **Clear refusals.** `nav.needsCrossing(a, b, def)` makes two cached region lookups (`componentOf`). It is true when
  the vehicle's class region differs from the target's but the infantry region is the same. When it holds:
  - A move order where no unit can go is refused with *"A vehicle cannot cross there without a bridge: build a road
    across the river (or marsh) first."* and `code: 'bridge'`.
  - A partial order returns `crossing: n` and `note`. A human player also gets the note as a quiet notification.
  - The `reach` query reply carries `reason: 'bridge'` and `crossing: n`. The client still reads only `ok`.
  - The unreachable pre-check stays O(1) per unit. The component arrays are cached and rebuilt only on
    `nav.invalidate()`.
- **Maps stay playable on foot.** Without the start crossings, seed 3 on a 96 map was split in two for infantry. A
  river ran along a cliff foot, and a hex's gradient is its steepest neighbour, so the river floor read as a wall.
  - Fix: infantry now wade any river hex, whatever its banks' gradient (`actionNavigation.cost` / `roadOnly`, `wade`).
    The banks keep their climb limit, and vehicles still need the road.
  - Checked: start-to-every-main-site reach on foot over 16 seeds (96), 11 seeds (64), 5 seeds (128) and 4 seeds
    (160 / 208). There are no gaps.
  - Every catalog map also passes the updated `action-maps` test.
- **Lobby previews** (`PREVIEW_CLASSES` 'bridge') are drawn from road data, so they now show no bridges.
  `server/sim/mapPreviews.js` was regenerated (`node tools/map-previews.mjs`).
  - The catalog descriptions in `MainMenu.cs` still mention bridges, for example "Coastal roads bridge both rivers".
    Those are now "where the roads will cross". That file belongs to another workstream, so it was not edited.
- **Client.**
  - Streets and bridges are composed only from the per-hex road field (`WorldModel.Road`). A bridge is drawn where a
    road hex is a river or lake hex (`CityRenderer.StreetCache` "bridged", `RoadCurve.SpanLevel`).
  - When a bridge is built mid-match:
    - `ApplyTiles` marks the hex and its neighbours' render cells dirty and bumps `RoadRevision`;
    - the bridge deck level cache (`RoadCurve`) and the street keys of hexes near a river road follow
      `RoadRevision`.
    - So the bridge appears when the road completes.
  - Nothing synthesises a bridge without a road edge (`CityRenderer.RoadConnections`).
  - No rendering change was needed.

## Bugs found, root causes, fixes (goal 1 and the wreck report)

### Reproduction

`tools/nav-bridge-city-repro.mjs` (`--size=96 --seeds=3,7,11,41`; add `--verbose --trace` for per-unit traces).

**Setup.** Real procedural maps. The main sites are joined by roads with `actionMap.connect`, which lays bridges with
the road, so old and new code get the same kind of crossings. Ordinary `move` orders are then simulated for 150 s.

**Groups.**
- 6 tanks.
- 6 wheeled: armored cars, buggy, truck, field gun.
- 8 rifle squads.
- 10 mixed.

**Scenarios.**
- **bridge**: each wide-river bridge, crossed both ways by each group, plus two groups crossing against each other.
- **wrecks:bridge**: the same crossings with a tank wreck and an armored-car wreck beside the road at both bridge
  ends.
- **city**: player 0's start base, fully developed (every parcel built, perimeter). Groups are ordered into the court
  beside the HQ, out across the far side, and straight through, at three bearings.
- **wrecks:field**: an open field strewn with 132 wrecks, crossed west to east.

**What counts.**
- A unit **arrived** when it stopped within the group radius of the point, or within 1 of its own slot.
- **cut**: units whose region cannot hold the point (a plateau, an unbridged river). These are excluded: the refusal
  is correct.
- **overlap**: unit-ticks with a unit body more than 0.02 inside a wreck hull *as the client draws it*.

### Before and after

Before is HEAD 8e6bfef, run from a `git archive` copy. After is this change. Both use the same repro.

| Scenario | Before: arrived / units (gave up) | After: arrived / units (gave up) |
|---|---|---|
| bridge, tanks | 71/72 (0) | 60/60 (0) |
| bridge, wheeled | 67/72 (4) | 60/60 (0) |
| bridge, infantry | 96/96 | 80/80 |
| bridge, mixed | 112/120 (5) | 100/100 (0) |
| bridge, two-way | 65/71 (3) | 60/60 (0) |
| wrecks at bridge ends, tanks / wheeled / mixed | 70/72, 68/72, 117/120 (8) | 60/60, 60/60, 100/100 (0) |
| wreck overlap at bridge ends (unit-ticks) | 270, up to 0.041 deep | 0 |
| wreck field, all groups | 360/360 | 360/360 |
| wreck field overlap (unit-ticks) | 274, up to 0.041 deep | 0 |
| city (out / in / through, all classes) | 806/818: 12 halted short (1 gave up) | 812/814: 2 halted short (0) |

- After has fewer bridge orders. With no crossings at the start, `connect` plans slightly different roads and finds 5
  wide-river bridges instead of 6. The repro also runs in sandbox mode now, so the harness player is never eliminated
  between orders.
- A second repro on 128 maps (seeds 5, 9, 13; 9 bridges) arrived 646/646 on clear bridges.
- Every HEAD bridge failure was at a bridge end. Seed 11 bridge 2 lost 3 of 6 wheeled. After: 0 failures in
  65 bridge orders.
- City, remaining after the fix: 2 units halted 2.5–3 from the point in a crowded court, beside a taken slot. That is
  the intended "as near as the crowd allows" arrival, and none gave up.
- City, fixed: the HEAD give-up (seed 11 wheeled, a buggy blocked on a facility corner for 60 s) and the wheeled
  halts.

**Route cost.** Measured over 1,580 route() calls inside developed bases, as standing tests per route:

| Class | HEAD | After |
|---|---|---|
| Tanks | 675 | 678 |
| Wheeled | 262 | 318 |
| Infantry | 156 | 157 |

- Wheeled cost more because lanes are now sampled finely near cuttings.
- Each standing test is cheaper: `obstaclesAtTile` no longer builds three arrays per call.

### 1. Vehicles trapped on the dry part of a wide-river hex (bridge ends)

**Cause.** The coarse graph treats a wide-river hex (flow >= 94) as road-only for vehicles over the whole hex
(`roadOnly`). `cost()` blocked only the drawn channel (`riverAt`, at most 0.37 wide). A vehicle that sidestepped at a
bridge end, or got an order slot there, could stand on the dry part of the river hex.
- From there `strategic()` could not leave the hex, which has no road edge. `componentOf` was -1, and route() returned
  null.
- The unit was refused its slot ("blocked") or halted after the blocked re-routes.

**Fix.** `cost()`: for vehicles a wide-river hex is impassable off the road over the whole hex. This matches the
coarse graph. Infantry still wade the channel at the old cost.

### 2. Bridge lanes: lines the planner accepted that units could not drive

**Cause.** On a bridge the passable lane for a tank is about 0.13 either side of the road line. `line()` samples every
0.28 and tests the body with a centre disc plus four rim points.
- A diagonal line could pass the samples while a stretch between them, or the first 0.02 from the unit, was
  unstandable.
- The unit stood blocked at the bridge end. Every re-route returned the same path, until the stuck ladder gave up
  after 60 s.
- This was most of the give-ups on seeds 11 and 41.

**Fix.**
- `line()`: segments on or beside a lane (`nearLane`: road-only ground carrying a road) are checked at
  `LANE_STRIDE` = 0.06.
- `unitMotion`: a unit facing its waypoint steps over a sliver up to `LANE_HOP` = 0.07 instead of stopping.

### 3. Base courts: a line grazing a facility corner

**Cause.** The same sampling gap as bug 2, against a facility's corner in a crowded court. Seed 41: a buggy was
blocked for 60 s, then gave up.

**Fix.** Re-routes of blocked or stuck units are **strict**: `actionOrders.strictRoute` sets `nav.strict`. They check
lines finely beside structures and wrecks too (`tight()` = 1), but only where the body, grown by half a segment,
touches a structure at the segment's middle.
- The ordinary planner is unchanged. Sampling every line finely in courts doubled standing tests per base route.
- Only units that are actually blocked pay for it.

### 4. Wrecks ("rusted cars") were soft obstacles

**Cause.** Every wreck blocked as a disc of radius 0.115, whatever its type.
- The client draws the hull (`WarzoneRenderer.WreckScale` × the `WorldMeshes.Wreck` / `LightVehicleWreck` extents) at
  the living vehicle's scale. A tank wreck's corners reach 0.155 from its centre, so units drove into the drawn hull
  (measured up to 0.041 deep).
- A buggy's disc was wider than its hull.
- `obstacleAt` read only the probe point's own hex. A wreck just across a hex edge did not stop a unit whose body
  reached over the edge.

**Fix.**
- `wreckHull(type)` / `touchesWreck(w, x, z, r)` (`actionNavigation.js`) block the drawn, yaw-oriented hull. Tracked
  hulls use half 0.44 × 0.50 of the scale; wheeled chassis use half 0.37 × 0.455.
- `wrecksNear(t)` indexes wrecks on their hex and its six neighbours. It is rebuilt when `game.bfVer` changes.
- The escape rule uses the hull's circumradius.
- The decorative parked cars in base parcels (`CityRenderer.Parked`) stay non-blocking. `RecordFootprint` excludes
  them on purpose, and they stand inside the facilities' lots.

### Other checks (no change needed)

- **Slot reservation** (`candidate()`, bounded 3 tries): the river-hex trap (bug 1) was what made slots at bridge ends
  fail. With it fixed, the retries no longer fire there.
- **Near-goal arrival** (`STUCK.close*`): the remaining 3 court halts are this rule working as designed.
- **`route()` retry with a tile penalty:** unchanged. It fired fewer times after fixes 1–3.
- **Single-lane bunching** (`beginTraffic` / `trafficAllows`): the two-way bridge scenario passes 48/48. Units wait
  for oncoming traffic: `wait` ticks were recorded, and all units arrived.

## Late game: the repath storm (urgent user report)

User report: *"around any blocker like rivers/bridges vehicles will be completely unable to path … later in the game the
server seems like it begins having issues."*

### Reproduction

`tools/nav-late-game-probe.mjs`:
- **Setup.** An AI-only match, with navigation instrumented per game minute. Example run:
  `--map=random --size=160 --players=6 --minutes=40`, seed 7.
- **Per-minute output.**
  - tick time;
  - route, coarse-search and local-search calls, with failures and their milliseconds;
  - standing tests;
  - `nav.invalidate()` calls;
  - stuck-ladder counters;
  - units stuck now: a ground order that moved less than 0.5 in 30 s.
- **Options.**
  - `--stacks` names the callers of slow failed routes.
  - `--save-at` / `--save` / `--load` snapshot a match and continue from it, for quick replays.

### Measurements

Seed 7, 160 map, 6 AI. "Before" is HEAD 8e6bfef. "After" includes every fix below. Each row is a mean over the
game-minutes given.

| Minutes | Units | Tick mean, before → after | Worst tick | Route ms per game minute | Failed routes per minute | Gave up (whole span) |
|---|---|---|---|---|---|---|
| 1–10 | ~100 | 11.8 → 6.5 ms | 623 → 433 ms | 410 → 382 | 78 → 1 | 1 → 0 |
| 11–20 | ~160 | 18.0 → 8.1 ms | 802 → 221 ms | 1,497 → 812 | 215 → 7 | 5 → 0 |
| 21–30 | ~205 | 48.0 → 11.0 ms | 2,651 → 292 ms | 15,115 → 2,456 | 174 → 81 | 20 → 0 |
| 31–40 | ~240–265 | 47.3 → 11.3 ms | 9,676 → 434 ms | 11,488 → 2,370 | 185 → 179 (all cheap) | 0 → 0 |

How to read the table:
- HEAD's worst minutes spent 90 s of route time per game minute, with ticks up to 9.7 s. That is the server falling
  behind.
- Vehicles stuck at any moment fell from an average of 2–3 to 0.3–1.3. Give-ups fell from 26 to 0.
- The AI code differs between the two builds: HEAD's AI against the working tree's. The army sizes are comparable.
- An intermediate build had only the cut-off (fix A). Over minutes 11–40 it still spent 13–17 s of route time per game
  minute, with ticks up to 10.7 s, from 220–500 expensive failed routes a minute. Fixes B to E removed those.

### Root causes and fixes

**A. Cut-off ground paid a full search every time.**
- *Cause.* A route to ground in another region for the unit's class failed only after exhausting a bounded A*
  (`STRATEGIC_LIMIT` nodes). With no bridges at the start this is the normal case for vehicles at rivers. Each AI
  order, blocked re-route and ladder replan paid for it again.
- *Fix.* `route()` checks the cached regions first (`componentOf`) and fails in O(1) (`navStats.routeCutOff`).

**B. Long detours inside one region failed.**
- *Cause.* When the regions match a path exists, but a long way round a river (to its ford or source) could need more
  than the interactive bound. The order then failed and the unit was left with no path.
- *Fix.* With the regions known to match, the bound is half the map.

**C. Chase storms.**
- *Cause.* Attack orders and attack-moves call `chase()` every 9 ticks per unit, and each call is up to five route
  searches. Against a target with no firing spot (across a river, in a compound, on a cliff) every unit repeated all
  five, forever.
- *Fix.* A chase that found nothing is not retried for the same target and unit position for 40 ticks
  (`CHASE_BACKOFF`).

**D. Failing fine stages.**
- *Cause.* A goal in a pocket that no corridor can thread cost three attempts of three local searches each, up to
  about 7,500 grid nodes per call.
- *Fix.* One `route()` now has a total of `ROUTE_LOCAL_BUDGET` = 3,200 local nodes. A local search cut short by the
  budget is not memoised as a verdict for the rest of the group.

**E. Per-node cost of the coarse search.**
- *Cause.* `strategic()` kept its state in three Maps and Sets per call. Every coarse search, flow field and region
  fill also re-ran the river, road, ring-road and gradient tests for each hex. A 90-hex infantry route took 214 ms in
  replay.
- *Fix.*
  - The search state lives in reused typed arrays, stamped per search. The expansion order and results are
    identical.
  - Hex-centre costs are cached per movement class until `invalidate()` (`centreCost`).
  - `obstaclesAtTile` returns a cached array.
- *Result.* The same route takes 11 ms. In the replayed window, slow routes fell from 19 (2,081 ms) to 9 (312 ms).
  The 68-unit 208-map assault order fell from about 390 ms to about 160 ms.

**F. Clear refusals.** An order no unit can carry out is refused at once, either:
- with the bridge reason, or
- with "…the way is blocked (water, cliffs, structures or wrecks)."

It never leaves units grinding through the stuck ladder.

## Roads keep off field defenses (AI WORKS request)

- Claim roads, `roadRouteBetween`, player strokes and automatic links all plan with `strategic(buildingRoads)`.
- In that search, a new road edge onto a hex on or beside a standing field defense costs `DEFENSE_ROAD_PENALTY` (×4)
  (`nav.nearDefense`).
- The sandbag barricade is excepted, and existing roads are not penalised.
- The road goes round where a reasonable alternative exists. The test case is a bunker on a straight 15-hex road: the
  detour is at most 4 hexes. Otherwise the road goes straight through as before.

## Files

**Server**
- `server/sim/actionNavigation.js`:
  - the wide-river rule;
  - infantry wading;
  - `nearLane`, `tight`, fine `line()`;
  - `wreckHull`, `touchesWreck`, `wrecksNear`;
  - `needsCrossing`;
  - the late-game fixes: the route cut-off, the long-detour bound, `ROUTE_LOCAL_BUDGET`, the typed-array A*,
    `centreCost`;
  - `nearDefense` and `DEFENSE_ROAD_PENALTY`.
- `server/sim/actionOrders.js`:
  - the sliver hop and `strictRoute`;
  - the `bridge` refusal, note and reach reason, and the blocked-way refusal;
  - `CHASE_BACKOFF`.
- `server/sim/actionGame.js`: the cached `obstaclesAtTile`, and the move note.
- `server/sim/actionMap.js`:
  - `layCrossings` removed;
  - compound streets kept off rivers;
  - `ROAD_BRIDGE_COST`, `isBridgeSegment`, `roadEdgeCost`, `roadEdgesCost`.
- `server/sim/actionBases.js` and `server/sim/actionEconomy.js`: bridge pricing.
- `server/sim/actionEngineers.js`: `roadRouteBetween`.
- `server/sim/mapPreviews.js`: regenerated.

**Client**
- `unity/.../UI/Hud.Base.cs`: the road tooltip price.

**Tests and tools**
- `test/nav-bridges-cities-2026-11-18.test.js`: new.
- Updated: `test/roads-and-claims.test.js`, `test/action-maps.test.js` (fairness on foot, roads plannable, no bridges
  at the start) and `test/review-s-longroute.test.js` (the assault drives a built road).
- `tools/nav-bridge-city-repro.mjs`: the reproduction of the bridge, city and wreck scenarios.
- `tools/nav-late-game-probe.mjs`: the late-game match probe.
- `test/action-pathing.test.js`: the cut-off bank now answers `reason: 'bridge'`.

## In-game checklist

1. **New match on a river map** (Twin Rivers, or a procedural map with a wide river): no bridge is drawn anywhere, and
   the lobby preview shows none.
2. **Tank to the far bank of a wide river**:
   - the cursor is crossed out;
   - the order is refused with "…cannot cross there without a bridge…".
3. **Infantry and a tank together** across the river: the infantry go; the tank stays with a quiet note.
4. **Draw a road across the river**:
   - the preview prices the bridge links at 40;
   - the engineers build it;
   - the bridge deck appears when the road completes.
5. **Tanks and armored cars across that bridge, both ways and against each other**: no unit stops at either end, and
   they queue for the single lane.
6. **Capture and establish a city across a river**:
   - the settlement price includes the bridge links (40 each);
   - the claim road lays the bridge.
7. **A developed base** (all parcels built): order mixed groups in beside the HQ, out across, and through. No unit is
   left pressed against a facility.
8. **After a tank battle**, drive through the wrecks:
   - no unit's hull visibly overlaps a wreck;
   - a gap between two wrecks wider than the unit is used.
9. **Infantry march from one start base to another** on several seeds: there is always a way on foot.

## Open risks

- **The AI does not build roads yet.** Until the AI agent calls `roadRouteBetween`, AI vehicle armies stop at wide
  rivers. Their move orders are refused with `code: 'bridge'`. Claim roads still bridge rivers to their own cities.
- **Strict re-routes cost more per call** than ordinary routes. They are bounded by the existing re-route rate limits:
  at most 10 collision re-routes between progress, and 6 ladder replans per order.
- **Wrecks can jam a single-lane bridge or cutting.** Seed 5 on a 128 map: two wrecks at a bridge end closed it to
  wheeled vehicles, while tanks still passed. Wheeled orders are refused ("the way is blocked") until engineers clear
  the wrecks or they rust away (600 s).
- **The remaining failed routes are cheap.** Late game there are about 180 a minute, mostly wheeled group slots 75
  away in a region they cannot thread, at about 40 ms each, under the local budget. Remembering a failed slot per goal
  would remove them.
- **Some heavy-vehicle routes are much longer now.** Where a corridor used to cross a river by a start bridge,
  vehicles detour to a ford or are cut off until a road is built. The fairness test now measures marches on foot and
  that a road can be planned to every site.
