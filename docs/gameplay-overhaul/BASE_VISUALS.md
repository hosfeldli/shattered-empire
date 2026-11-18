# Base and world visuals (workstream V, 2026-11-18)

This workstream changed only the client. The server's river data and navigation already had the right width; only the client drew rivers too narrow. The server agent owns the authoritative rule that keeps defenses off road tiles. This client work assumes that rule: placement on a road tile is refused or snapped to the side.

## 1. Defenses stand beside roads; roads no longer bend around them

**Before.** Any building on a hex marked that hex as a "street parcel" (`RoadCurve.Occupied`). On a parcel, the streets wrap around the block along the hex edge (`RoadCurve.Pieces` / `Chain` / `AroundControl`). The junction is also pushed to one side (`JunctionControl`). A turret or bunker on a road hex therefore made the road swerve around it.

**Now**
- `CityRenderer.Update` builds `streetParcels` from buildings whose type is not a field defense (`DefenseKinds`, the barricade included). Roads keep their natural line through hexes that hold defenses.
- `CityRenderer.Defenses.cs` `RoadsidePosition` handles every positioned defense except `barricade` / `sandbags`:
  - If its body (`DefenseClearance`: plinth or blast ring) would reach onto a drawn carriageway, the defense is drawn pushed straight off the road. Drawn carriageways are hex half-streets and compound lanes, measured by `RoadCurve.RoadDistance`.
  - It is pushed to the side it already leans toward. A defense exactly on the crown line picks a side from its building id.
  - The push takes up to 3 passes, so the defense also clears a second road, and is capped at 0.55 units.
  - Construction sites (`DefenseSite`) move the same way.
  - The pad, team ring, gravel path, damage overlay and turret head all follow, because they use the shifted centre.
- The sandbag barricade is never moved and may sit on or across a road.
- `ComposeCityDistrict` calls `DirtyRoadsideDefenses` when a compound's lanes really change. Defenses composed in other cells before those lanes existed then move to the roadside on their cell's next compose. The base's own cell is not re-dirtied.
- **Deterministic.** The position depends only on the drawn roads (hex roads, built parcels, published compound lanes) and the building id.
- **Gameplay is unchanged.** Collision footprints are recorded in local coordinates. Selection, HP bars and server collision use the server position. With the server snapping placement off road tiles, the visual shift is normally zero or a few centimetres.

## 2. Thicker rivers

- **Width.** `ChunkMeshJob.ChannelWidth` now follows the server's navigation width (`actionNavigation.riverAt`: `.12 + .049·log2(flow/42)`, at most .37) by flow bucket. The new half-widths are .13 / .18 / .23 / .28 for buckets 1–4 and .04 for streams. The old values were .093–.147, about half of what navigation treats as river. What looks like water is now where wading slows units and where deep rivers stop vehicles. No server change was needed.
- **Natural variation.** Each bank varies on its own: ±14% over long distances, plus finer ripples of ±5% and ±2%. The variation is sampled from map position, so neighbouring ribbons meet exactly. The deep line runs midway between the two banks.
- **Depth.** Deep rivers (bucket 2 and up, near the server's vehicle ford limit of flow 94) have a darker middle (depth alpha .56 instead of .42).
- **Banks.** The wet earthen margin scales with the new width (0.73–1.38 × the half-width).
- **Vegetation.** Trees and ground plants now keep off the actual channel and its margin (`ChunkMeshJob.OnChannel`): centre to the downstream edge and to each upstream inflow. Before, they were only kept from a disc at the hex centre.
- **Client placement.** `CityRenderer.OverWater` (pads, paths, development) uses the same channel shape and width (`OnRiverChannel` / `RiverHalfWidth`).
- **Bridges.** These are unchanged: a bridge deck spans the whole wet hex (`RoadCurve.SpanLevel`), and that is wider than the widest river. Collision and navigation are unchanged: the server already used the wider width.

## 3. Road variety around bases (`CityRenderer.RoadConnections.cs`)

- **Varied approach bends.** Past the foundation, each entrance approach can swing to one side by up to .42 (20% of its length), with a strength set per entrance.
  - The side is chosen by terrain: three candidates are compared on climbing over hex base heights. Craters are ignored, so shelling never re-routes a road.
  - A straight run is the default on flat ground. A bend wins when it saves more than .02 of climbing.
  - On flat ground a stable per-entrance bias adds a gentle half bend.
  - Inside the foundation the trunk stays straight between pads, so no road crosses a pad.
- **Natural intersections.** Junction aprons (asphalt discs under the carriageways) are added where a trunk leaves the ring road and where it forks into several approaches. They are not published as lanes.
- **Surfaces.** Country-road (class 1) approaches arrive as kerbless lanes that blend into their rural surface colour. Streets keep their verges.
- **Accessory paths.** Gravel footpaths join the development lots (section 4) to the foundation. A path that would meet a road ends at the road instead of crossing it.
- **Deterministic.** All inputs are the site id, the anchor hex and direction, and the hex heights.

## 4. Passive base development (`CityRenderer.BaseDevelopment.cs`, new)

A held base grows dressing outside its round foundation.

**What grows**
- Service yards: a shed, fuel tanks, crates and drums on gravel.
- Transformer yards: a fenced slab, transformers and power poles toward the base.
- Camps: canvas tents, a hut and a water tank.
- From level 6, a water tower.
- Trees and shrubs, plus a gravel path from each lot.

**What decides it**
- Level = 2 × (tier − 1) + development stage. The stage comes from how long the base has been held (server `tenure`): 0–1, 1–3, 3–6, 6–10 and 10+ minutes give stages 0 to 4. Level runs 0 to 8, and the base uses 3 + 2 × level of 20 candidate lots in two rings.
- Each lot's type follows the nearest socket's building:
  - depot, vehicle works, heavy weapons → yard;
  - power plant → utility;
  - barracks or armory → camp;
  - HQ or an empty socket → nothing (open ground).
  - About 45% of the outer ring also stays open.

**Kept strictly separate from gameplay**
- Decorations have no server record, no footprint (no collision or infantry avoidance), no selection and no team colour. Team-coloured or authored objects are always gameplay.
- They are low: sheds about .1 tall, the water tower about .4.
- No houses of any kind (see "Houses removed" below).
- They never sit on:
  - the foundation, so never on build pads or docking arms;
  - a drawn road (`RoadDistance` > lot radius + .09);
  - water or river channels, mountains, forests (biomes 4, 7, 9+) or ground with more than .10 of relief across the lot (hex terrain without craters);
  - another base's compound.
- They keep clear of every positioned building (defenses by their ring, others .55) plus a margin. Placing a defense near the base re-keys the compound, and the dressing moves out of the way.

**Determinism.** Lot angles, order, radius, type and recipes come only from `StableHash(Seed, site.Id)` and the lot index.

**Performance**
- Development is composed inside the base compound record, so it is replayed with the compound and rebuilt only when the compound key changes.
- It is bounded to about 20 lots × about 10 instances, plus about 12 ground quads each.
- The cost of a rebuild is about 250 `RoadDistance` calls. This needs measuring in the soak (see in-game checks).

## Houses removed (user request 2026-11-18)

The user asked to "remove the little houses that are dynamically built next to cities". Nothing residential is generated around cities or bases any more:

- **Development cottages.** The cottage theme in `CityRenderer.BaseDevelopment.cs` is gone (`DecorHomestead` deleted). Lots that would have held cottages stay open ground; they get no substitute dressing. The water tower, yards, utility yards and camps remain. None of these is a house.
- **Settlement houses.** The ring of street-front houses outside the foundation (`SettlementHouses` / `ComposeCityAccessories` / `AccessoryScaffold` in `CityRenderer.Rings.cs`) had been switched off. It is now deleted, along with its key and dirty inputs: the maturity term in `BaseSignature` (kept only for the `-perf-legacy basekey` A/B) and the maturity stage in `UpdateCityMaturation`.
- **Other paths checked; none grows houses over time, by tier or by maturity in action RTS:**
  - `Infill` and `StreetLife` run only outside action RTS.
  - `ActionRuin` (static objective ruins) and `HistoricalBlock` (static ruins on unclaimed sockets) are the static ruin city and stay.
  - `DistrictPlanner` only groups server buildings.
  - The Architecture, Activity, Facilities, Authored and Catalog files have no growth housing.
  - The server's `house` type is the legacy mode's player-built building, not generated.

## Cache keys

| Key | Change | Why |
|---|---|---|
| `BaseSignature` | `+ DevelopmentStage(site.Tenure)` (0–4, not raw tenure) | The dressing grows by stage. Raw tenure ticks every snapshot, which would cause a miss every time. |
| `BaseSignature` | Positioned-building reach goes from foundation + 1.6 to foundation + 1.6 + .8 (`DevelopmentReach`) | The dressing keeps clear of buildings out to that distance. |
| `UpdateCityMaturation` | Its stage is now `DevelopmentStage` only; the maturity stage was dropped | It dirties the base cell when the stage advances: at most 4 extra recomposes per base per match. Maturity fed only the removed settlement houses. |
| `BaseSignature` | Maturity is mixed in only under `-perf-legacy basekey` | The `SettlementHouses` term is gone with the houses. |
| `HexStreetKey` | Unchanged | It already folds in `streetParcels` over the 5×5 window. Removing defenses from the parcels changes the key only on hexes that hold defenses. |
| Compound lanes | Junction aprons are excluded from `RoadCurve.CompoundLanes` | `SameLanes` / `LaneRevision` are unaffected by them. |

Nothing new reads a map-wide revision. Development does not react to unrelated global changes.

## Known approximations

- The dressing's road check reads the hex streets around it, which depend on `streetParcels`. A non-positioned building appearing near a base, which is rare in action RTS, can change those streets without re-keying the compound until its next rebuild.
- `BaseSignature` measures building distance without map wrap, as before. Development uses wrap-aware positions. Near the seam this can lag by one rebuild.

## Verification

- A type-check of all Runtime/Core/Net sources (`dotnet build`, check project copy) gave 0 errors and no warnings in the touched files.
- There were no server changes, so no node tests were run.

## In-game checks needed

1. **Defenses.** Build a turret, bunker, AA, artillery post or fort next to a road, and over an existing road on an old save. The road must stay straight, with the defense beside it. Build a barricade on a road: it must stay on the road. Check that turret heads and muzzle flashes sit on the shifted model.
2. **Rivers.**
   - Rivers read clearly wider at strategic zoom, with banks that wander but no gaps or overlaps where ribbons join.
   - The water does not float on steep valleys.
   - No trees stand in the water.
   - Units wade or stop where water is drawn.
   - Bridges still span the whole width.
3. **Base roads.** Entrances bend differently per base, junction aprons don't z-fight the ring road or the docking-arm marks, and country entrances show no kerbs.
4. **Development.**
   - A starting base gains lots over the first 10 minutes and after each tier upgrade.
   - Nothing sits on roads, pads, rivers or defenses. Placing a defense near a base makes the dressing move.
   - No houses or cottages appear next to any city or base, at any tier or hold time. The HQ side of a base stays open ground.
   - Captured bases start over.
   - In a 4-AI soak, check `BaseComposeBuilt` and `BaseCellComposeMsMax`: development adds cost only on compound rebuilds, and must not push the 200–400 ms compose spikes higher.
