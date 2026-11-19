# Trenches: connected, terrain-following works (2026-11-18)

User request: "Improve the trenches so that they look better, more connected, and work over different terrain heights."
Gameplay rules for trenches (cost, digging, cover, where they may be dug) are unchanged.

## What was wrong

1. **Lines broke into pieces (action ruleset).** `fieldworksFor` only sent a node's route bits under the native
   rulesets, so in the action RTS the client linked neighbouring nodes by distance alone (at most 1.35). Nodes sit at
   the first stroke sample inside each hex, so consecutive nodes are often 1.5–2.4 apart: links were dropped and a
   line showed as separate pits. Where links did form, every pair of neighbouring hexes of a stroke was routed, so a
   stroke over a hex corner drew a triangle of trenches, and two parallel lines a hex apart were laddered together.
2. **The cut could not be seen.** `TerrainView.DamageHeight` carved a 0.15-wide, 0.05-deep slot into the shared
   ground. The terrain mesh has vertices about 0.17 apart (0.125 by craters), so the slot showed up as random dents,
   while the instanced trench parts (placed on the carved height) were buried under the ground beside them.
3. **Boxes on slopes.** Every floor, wall and sandbag piece was an axis-aligned box placed on one height sample
   and rotated only in yaw: on a slope each piece floated at one end and sank at the other, with steps between bays.

## Design

### Network (server + `Core/World/TrenchNetwork.cs`)

* `actionBases.trenchRoutes`: a new line links **consecutive** hexes of the stroke only, and each end of a dug run
  joins the nearest existing trench of the same owner beside it (≤ 2.8 apart; the bit is set on both nodes, so a line
  drawn up to an earlier one continues it as one work). Gameplay never reads the route.
* `fieldworksFor` now sends the route (element 8) under the action ruleset too.
* `TrenchNetwork.Linked` is the one link rule (used by `TrenchRenderer` and `WorldModel.ApplyTrenches`, which feeds
  `TerrainView.TrenchNearest` that troops stand along): route bits decide (up to 2.9 apart); records with route bits
  link by them only; route-less positioned records fall back to the old proximity rule (≤ 1.35); hex-centred records
  (older rulesets, stress scenario) link routed or route-less neighbours as before.

### Works stand on the terrain instead of cutting it

The trench is no longer carved into the shared ground (`DamageHeight` keeps craters only). The floor is at grade and
the depth comes from the banks: a sandbagged parapet 0.050 (1.25 m) on the enemy side, a parados 0.034 behind. A
1.75 m soldier on the floor shows head and shoulders over the parapet. Troops' feet (`UnitRenderer`) need no rim
lift any more: the ground height is the floor.

Cross-section (map units, 1 = 25 m), per side, swept along each link:

| row | offset | height | part |
|---|---|---|---|
| floor | 0 … ±0.019 | +0.0016 | mud floor, duckboard walk down the middle (alternating shades read as slats) |
| A → B | 0.019 → 0.030 | → fire step 0.017 (front only, fades out on the rear side) | fire step |
| C → D | 0.034 → 0.041 | step → bank | timber revetment (concrete-grey on a reinforced line) |
| D → E → F | 0.041 → 0.075 → toe 0.165 front / 0.13 rear | bank → 0.93 bank → −0.004 | earth crest and outer bank, toe tucked under the ground |

Front/rear is decided per side by how squarely it faces the enemy (`smoothstep` of side · facing), so heights blend
smoothly where a line turns parallel to its facing. The facing blends from the node's own to the link's mean along
each half, so both halves meet in an identical section.

### Following the terrain

Every vertex is placed on `MeshSurface(x, z)`: an exact replica of `ChunkMeshJob`'s triangulation (damaged/shore hexes
split 3×3, or 4×4 near craters, vertex heights = `GroundHeight` + `CraterRelief`; other hexes the plain sector
triangles). Sections are 0.02 apart near a node and 0.05 elsewhere, and a section is inserted wherever the ground
between two bends by more than 0.0012 (two passes), so floors, walls and banks follow slopes, crests and height steps
continuously. Nothing floats; the toe is buried 0.004.

### Joins

* Each node draws the half of every link it is joined to; with both ends finished the two halves meet without caps.
* At a node, a link's step, wall and bank vertices that fall inside another of the node's dug slots are pressed down
  just below the floor (and coloured as floor), so links open into one pit at any angle (corners, T and X junctions)
  instead of walling each other off.
* The outer side of a corner (angular gap > 180° between neighbouring links) is closed by sweeping the side profile
  round the node; the same sweep makes a rounded free end, the digging face of a part-dug half, and a lone pit.
  A lone node is a straight run of ±0.42 across its facing, rounded at both ends.
* Roads: a line never runs onto a road. It ends square at the verge (closed cut faces and a sandbag wall across the
  slot); a dug stretch a road crosses is split, with steel plates on the road between. Road stubs from a node to the
  verge of a road hex the line continues into are kept (as before).
* Hex-centred records (older rulesets) still run into the owner's adjacent defences.

### Details (instanced)

Sandbag courses on the parapet crest every 0.12 bay, 0.082 long (gaps between are loopholes; 0.112 and grey on a
reinforced line), a few on the parados, revetment posts on the firing wall, wire belts in front of a reinforced line,
a sign post at junctions of three or more, pegged tape for planned works.

## Budget and caching

* Mesh: 17 rows per section (≈ 17 vertices; the bands do not share vertices at creases), ≈ 25 sections per half link
  with refinement → about 1–1.3k vertices per node. 150 nodes ≈ 170k static vertices.
* Draw calls: one per 16×16-hex terrain chunk holding trenches (one mesh, drawn through `InstanceBatch` with a single
  instance), plus three detail batches (sandbag courses, boxes for posts/plates/tape, wire), per visible wrap image,
  plus their shadow passes. Before: up to nine shared warzone batches carried thousands of trench boxes.
* Instances: ≈ 7 sandbag courses and ≈ 8 posts per half link (≈ 40 + 24 vertices each).
* Caching: geometry is cached per node, keyed by the node's record, its six neighbours' records, and the ground within
  three hexes (heights, water, flags, biome, craters, trench geometry, and the road layout when a road is near). The
  1 Hz digging progress rebuilds only the nodes being dug (and neighbours whose ends change), and only the chunk
  meshes holding them are reassembled. Terrain-mesh vertex heights are memoised during a rebuild.
* `TrenchRenderer.NodesBuilt / NodesReplayed / Vertices` are available for the bench.

## Wire changes

* `fw` record element 8 (route bitmask, bit d = joined to the neighbour in hex direction d) is now also sent under the
  action ruleset. Records stay 9 elements; older clients already read element 8 when present.
* Route bits of newly drawn action trench lines: consecutive stroke hexes + junctions to existing works (see above).
  Existing saved trenches keep the bits they were given.
* No delta.js change: `fw` and `trenchWorld` keep their gating (`fwKey`).

## Files

* `server/sim/actionBases.js` — `trenchRoutes`, used by `trenchLine`.
* `server/sim/fieldworks.js` — route sent under the action ruleset.
* `unity/.../Core/World/TrenchNetwork.cs` (new) — link rule, facing of a record.
* `unity/.../Core/World/WorldModel.cs` — `ApplyTrenches` uses `TrenchNetwork.Linked`.
* `unity/.../Core/World/TerrainView.cs` — trench cut removed from `DamageHeight`; `TrenchWorksReach`, `OnTrenchWorks`.
* `unity/.../Runtime/Terrain/ChunkMeshJob.cs` — trees and groundcover kept off the works (`OnTrenchWorks`), since the
  cut no longer excludes them.
* `unity/.../Runtime/Military/UnitRenderer.cs` — no rim lift for troops in a trench (the floor is the ground).
* `unity/.../Runtime/Battlefields/TrenchRenderer.cs` (new) — the works.
* `unity/.../Runtime/Battlefields/WarzoneRenderer.cs` — old box-built trench code removed; owns and calls `Works`.

## In-game checks needed

1. Draw a straight line, an L, a zig-zag over hex corners, and a line ending next to an earlier one: one continuous
   work, corners open, no triangles, the new line joins the old one.
2. Lines up a hill side, along a ridge, across a valley and over a mountain hex edge: floor and banks follow the
   ground, no floating banks, no terrain poking through the floor (if it does, raise `FloorLift` or the bend
   threshold).
3. T and X junctions (three or four lines meeting at one node): one open pit, no walls across a slot.
4. A line across a road: square ends at both verges with a sandbag wall, steel plates on the road, nothing on the
   asphalt. Stubs to a road hex.
5. Digging progress: a part-dug half grows from its node with a rounded face; finished halves meet without a seam;
   planned works show pegged tape.
6. Shelled trenches: craters in and beside a trench (works follow the bowl; check the floor over a fresh crater).
7. Troops manning a trench: they stand on the floor along the line with head and shoulders over the parapet; the hop in
   is still read; vehicles crossing a trench drive at grade (the banks do not lift them).
8. Reinforced lines (grey revetment, continuous bags, wire), facing flipped (`reverse`), wrap seam on a wrapping map.
9. Performance: bench `warzone.trenchMs` during digging with ~150 nodes; draw calls; check no hitch when roads change
   near many trenches (those nodes rebuild).
10. Trees and grass no longer grow on the works; existing trees under old works are scarred (sticky scars).

---

# Second pass: "the trenches don't connect" (2026-11-18)

User report: "the trenches don't connect". Reproduced headlessly by drawing strokes through the `trenchWorld`
command on a 64×64 action map and walking the network the client builds from the wire (`fw` element 8 route
bits + `trenchWorld` positions, linked by the `TrenchNetwork.Linked` rule). Fuzzing ~150 placements per shape:

| case | before | after |
|---|---|---|
| single strokes (straight, diagonal, bent, wobbling, random walks) | 0 broken | 0 broken |
| a gap between two lines drawn in afterwards | 67 / 75 broken | 0 |
| T: a line ending against the middle of an older one | 9 / 145 broken | 0 |
| X: a line crossing an older one | 2 / 145 broken | 0 |
| routed links longer than the client's 2.9 reach (dropped) | ~1 in 100 links | none dropped |

## Root causes

1. **Gap fills joined one side only (server).** `trenchRoutes` joined each end of a dug run to the *single*
   nearest older trench. A run of one hex (a gap redrawn, a hole shelled out and re-dug) is both ends at once, so
   it joined one neighbour and the line stayed broken on the other side.
2. **Older free ends were never joined (server).** Only the new run's *ends* looked for older works. A new line
   passing beside the free end of an older line (a T where the old line stops at the new one, or an earlier line
   whose own end hex had been skipped) never got a link from either side.
3. **The client dropped long links.** `TrenchNetwork.RoutedReach` was 2.9 map units, but routed nodes in
   neighbouring hexes can be up to ~3.7 apart (each node sits where the stroke first entered its hex, anywhere
   inside it). The junction to an older line's node across its hex was silently not drawn.
4. **Digging looked like separate pits (client).** Each node dug its half of every link outward from itself by its
   own progress, so a finished node next to a part-dug one showed two stubs with untouched ground between them,
   and a line being dug read as a row of separate pits until every node was 100 %. Engineers dig a section in
   ~4 s each, but a long line or a busy crew leaves this state on screen for a long time.
5. **Minor (client): a notch at every node.** A link's banks are pressed to the floor inside another link's slot
   (that opens corners and junctions). The test counted a point *at* the node (along = 0) as inside the opposite
   link's slot, so on a straight run the fire step and wall foot dipped to below the floor at each node, which
   reads as a seam between the two halves.

Checked and found correct: server/client hex direction tables match (`hex.js` DIRS vs `HexMath.DirsEven/Odd`, odd-r);
the wire carries route bits for planned, part-dug and finished hexes alike and masks bits toward vanished
neighbours; the two halves of a link meet in an identical section (same point, same blended facing, vertices on the
same `MeshSurface`, so slopes and height steps do not open a seam); a node's cache key includes its neighbours'
records, so a neighbour finished, destroyed or redrawn rebuilds it.

## Fixes

* `actionBases.trenchLine` records every hex the stroke enters in drawing order (re-entries included) and
  `trenchRoutes` was rewritten:
  1. each hex entered for the first time joins the hex it was entered from: the last of the owner's trench hexes on
     the stroke, so a stroke that clips a road or another skipped hex keeps going when the hexes either side touch;
     an older trench the stroke runs through is joined in on both sides (a crossing is one network). If that hex is
     not a neighbour, the latest neighbouring hex of the stroke is used;
  2. every dug hex with fewer than two links joins the owner's older works beside it, nearest first, until it has
     two (an end once, a lone hex both sides);
  3. a free end (fewer than two links) of an older line beside a newly dug hex joins the nearest new hex (T);
  4. no link may close a triangle (a common neighbour already joined to both), so a stroke over a hex corner or
     drawn along an older line makes no triangles or ladders. The 2.8 distance limit is gone (links are between
     hex neighbours only).
* `TrenchNetwork.RoutedReach` 2.9 → 3.8 (a guard against bad data only).
* `TrenchNetwork.HalfDug` / `MeetsOpen` / `ProgressOf`: a link's digging is drawn as **one stretch grown from the
  more advanced node** (higher progress, ties to the lower tile), (progress a + progress b) halves long. A finished
  node and a part-dug neighbour show one trench reaching on from the finished one with a digging face; the halves
  meet open only when the stretch crosses the midpoint. `TrenchRenderer` arms carry `DugStart..Dug`; a stretch
  dug from the far side starts with a rounded digging face (`Sweep` start `End.Round`), is taped up to it, and does
  not shape the node (no pit, no corner fan at a node whose only digging is away from it).
* `TrenchRenderer.InOtherSlot` only presses points strictly ahead of the node (along > 0.001 and inside the
  other link's dug stretch).

## Tests

* `test/trench-connect-2026-11-18.test.js`: straight, diagonal, bent, wobbling, crossing, T, extension, overlapping
  end and gap-fill strokes over every placement on the map where they can be laid (each shape includes cases with
  ≥ 0.08 elevation relief across the line): the client's network is one piece wherever the hexes touch, with no
  triangles; a straight stroke is a single chain; route bits are sent while planned and part-dug; a shelled-out hex
  is masked and, redrawn, rejoins both sides; parallel lines a hex apart are not laddered.
* `TrenchNetwork.SelfTest()` (pure C#): link rule (either bit, owners, long routed links, legacy proximity) and the
  dig stretches (contiguous, whole when both finished, digging face otherwise). Run in the editor with
  `execute_code`: `return SE.Core.World.TrenchNetwork.SelfTest();` → `"ok"`.

## In-game checklist (second pass)

1. Draw a straight line, an L, a zig-zag and a deliberately wobbly hand-drawn line: one continuous work, no pits
   joined by nothing, no triangle at hex corners, no notch or seam at the nodes along a straight run.
2. Draw a line across an older one (X), one ending against the middle of an older one (T, both ways round: the new
   line ending at the old, and the old line's end beside the new), one continuing an older line's end: one network,
   open junction pits.
3. Draw two lines with a gap, then draw the gap in (or shell a hex out and redraw it): joined on both sides.
4. Watch engineers dig a line: the dug trench grows continuously from finished sections with a rounded digging face
   and tape ahead; no isolated pits between finished nodes; finished halves meet without a seam.
5. Lines up a slope and across a height step: banks and floor continuous through the midpoint of each link.
6. Two lines drawn a hex apart in parallel: two works, not a ladder.

# Trenches and roads (2026-11-18, follow-up)

User request: "allow trenches to be built connected to roads, account for them connecting, don't block trenches for
that reason."

## Decision: a trench hex on a road is a covered crossing

* **Server (action ruleset).** `trenchLine` no longer skips road hexes (`why: 'road'` is gone); a road hex is dug and
  routed like any other, so a line across a road is one work and a line drawn up to a road ends in the road hex.
  Hexes beside roads were never refused and still are not. The only road-related skip left is a **bridge or
  causeway deck** (a road on a river, lake or water hex), `why: 'bridge'`: there is no ground to dig. The reply's
  `crossings` now counts the road hexes dug as crossings.
* **Roads stay open.** Trenches never change movement (nav reads terrain, roads and structures only, never
  `fieldworks`), so no nav change was needed: vehicles drive a road through a crossing on the same route at the same
  cost (tested). A road finished later through a trench used to fill the trench hex in (`actionEconomy`
  `fieldEconomyStep`); it now keeps it as a crossing and re-sends the works (their road masks change).
* **Client.** The line runs up to the carriageway's verge on both sides, steel plates carry it across the road
  (existing `Plates`), and each verge end is now left **open onto the road**: the bank cut faces are closed as
  before, timber posts frame the opening and a duckboard step spans the verge to the carriageway. (It was closed by
  a sandbag wall, which read as the line stopping short of the road.) A free end of a line (one link) beside a road
  now runs on to the road it points most toward (not back along its own link), so a line that ends next to a road
  visibly joins it; before, only a node continuing straight into a road got that stub.
* The native rulesets (`fieldworks.js`, hex-centred trenches) are unchanged: they still keep trench segments off
  roads.

## Tests

* `test/trench-connect-2026-11-18.test.js`: a line across a country road digs the road hex (`crossings` ≥ 1), is one
  network, and a tank's route along the road is identical before and after; a line drawn up to a road joins the
  crossing; a road over a river is skipped as `bridge`.
* `test/action-rts.test.js` (*trench lines cross roads as covered crossings…*): updated from the old "roads stay
  open, road tile not dug, a finished road fills the trench" rule to the new one.

## In-game checks (roads)

1. Draw a line across a road: one continuous work, steel plates on the asphalt, the slot open at both verges with
   timber posts and a duckboard step; no sandbag wall across the slot.
2. Draw a line that stops beside a road (one hex short): it runs on to the road's verge and opens onto it.
3. Drive a tank column along the road through the crossing: no slowdown, no detour.
4. Build a road across an existing trench: the trench stays, now with plates.
5. Draw a line across a bridge: the deck is skipped, the line either side ends at the banks.
