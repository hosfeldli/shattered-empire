# Roads and claims (workstream R, 2026-11-18)

User request: *"Don't have roads connect to new cities until you claim that city. The road should auto-build as
part of the settlement cost in that scenario, but you shouldn't be able to follow roads to find new cities."*

## Match start: no roads between sites
- **Procedural and sketch maps** (`actionMap.buildActionMap`): the city-to-city corridors are still planned with the
  road planner (`hubRoute` over `nav.strategic`, heavy-vehicle ground). They still shape the coast
  (`compactBattlefield`), but they are no longer paved.
- **Authored maps** (`buildAuthoredMap`, `buildRotatedMap`): the catalog's `roads` are still routed. This keeps the
  catalog validation: a missing route still throws. They are not paved either.
- **Exception: crossings.** For every planned corridor, `actionMap.layCrossings` lays only the edges with
  an end on a hex that needs a road. Each crossing is a few hexes long and leads nowhere:
  - **Bridges:** an end on a river hex (`river && !lake`), bank to bank.
  - **Causeways and cuttings:** an end on a hex that wheels can cross only on a road (`nav.roadOnly(t, wheeled)`):
    marsh, or a slope steeper than the wheeled climb limit (0.31).
  - Why: a wide river (flow >= 94) is road-only for every vehicle, and marsh and steep ground are road-only for the
    six wheeled types (scout buggy, armored car, supply truck, field gun, AA vehicle, missile battery). Without the
    crossings, a 208 map left armored cars unable to reach the far cities
    (`test/review-s-longroute.test.js`). Some authored maps also lost every bridge (`test/action-maps.test.js`:
    "rivers, fords and bridges").
    The AI does not build roads.
  - Measured on procedural maps: 64 map, 4–13 edges in 2 pieces (longest 9 hexes); 208 map, 6 players, 54 edges
    in 18 pieces (longest 12; the old network had 596 edges in one piece). Vehicle reach matches the old network
    on every seed checked.
- **Starting bases keep their compound.** They keep the ring road (`game.ringRoads`, drawn by the client from the site
  parcels). They also get their own **compound streets** (`actionMap.compoundSpokes` / `baseStreets`, laid in the
  `ActionGame` constructor):
  - Three straight spokes run from the hub along alternate hex directions, each `COMPOUND_SPOKE` (3) hexes long.
    They end just past the client's 3.6 skip radius, so they give heavy hulls drivable lanes between the facilities.
  - They are the same star at every base and point at nothing.
  - Which triple is used: the one with more buildable spokes; on a tie, the one with a spoke toward the map centre, so
    half-turned twin bases get the half-turned star.
  - An edge within a hex of another site is dropped.
  - The old spokes were not reused: they ran along the routes to the neighbouring cities, and on a 64 map they
    covered half the way to the nearest one.
- **Established and founded bases get the same streets.** On `establish` they are free and go into the same
  automatic project as the claim road. A New Base lays them at once.
- **Client:** the client draws roads only from server data. `CityRenderer.RoadConnections` says so explicitly:
  "Only authoritative road edges can produce entrances … No independent decorative road stubs". Nothing is
  synthesised between cities.
- **Lobby previews:** `server/sim/mapPreviews.js` was regenerated (`node tools/map-previews.mjs`). The previews now
  show the crossings only.

## Claiming a city builds its road
**When.** A city ruin is claimed in two steps: capture (`actionCapture.captureStep`, free), then establishing a
headquarters (`actionBases.establish`, the paid settlement). The road belongs to the paid step:

1. **At capture** (claim time), `planClaimRoad` plans the road from the city to the new owner's nearest operational
   base. The plan is cached on `site.claimRoad` and is the price shown on the ruin until it is established.
2. **At `establish`** the plan is reused if it is under 20 s old. A cached plan drops any segments built or queued
   since, so nothing is charged twice. An older plan is re-planned. The command is then refused, or paid in full.
3. **Pay:** the settlement price is charged in one payment (see the cost model below). The road is queued as an
   automatic road project (`roadProjects`, `auto: true`, `claim: site.id`). It lays itself while the headquarters
   is built, in `max(4, min(30, segments × 0.5))` seconds (the same mechanism as the outpost links). The
   segments appear together when it finishes.
4. **When the headquarters finishes:** no second, free link is laid (`site.claimRoadBuilt`). A headquarters that
   predates this change, from an older save, still gets the free `connectSiteRoads` links as before.

**Planner.** The same planner as the map roads: `hubRoute(nav.strategic(city, base, HEAVY_GROUND, true, false,
ROAD_SEARCH))`. It follows valleys and passes, never crosses open water, and bridges rivers.
- It tries the 3 nearest own operational bases, by distance; the first base with a route wins.
- It meets only the hubs of this city and of the owner's bases, so it never takes a spoke into an unclaimed city.
- A route through an active hostile headquarters compound is rejected, as in `connectSiteRoads`.
- Existing healthy roads (`cond >= 60`, paved) and segments already under construction are reused at no charge.
  Ruined segments are rebuilt and charged.

**Island (no route).** No road and no charge: the price is the plain headquarters. The same applies when the owner
has no operational base, for example during recovery at the 140-materials emergency price.

**Outposts.** An outpost is claimed by capture alone, with no price, so its road is free. On capture it is linked by
the existing free automatic road (`connectSiteRoads`, 1 link, within 18 hexes of an own base). This is unchanged.

**New Base (build wheel).** A New Base must still stand on or beside a road. With no country roads at the start,
that means beside a claim road, or beside a road the player draws. Founding a base still links it for free
(`actionEngineers`), unchanged.

## Cost model
```
settlement = headquarters (400 materials, 120 energy; 140 materials during recovery)
           + ROAD_EDGE_COST (15 materials) × new road segments
```
- `ROAD_EDGE_COST` (`actionMap.js`) is the per-segment price of player roads (`actionEconomy.roadBuild`), now shared.
- Only segments that must be built count. A city next to an existing own road pays almost nothing extra.
- Typical claims run 8–25 segments, or 120–375 materials. All of it is paid up front with the headquarters.
- A refusal for funds names the road: *"Establishing Gantry costs 640 Materials and 120 Energy, including 240 for
  the road to Ironford."*
- Engineers are not needed for the road.

## Fog
The claim road is an ordinary road edge (`game.roads`). It reaches clients in the per-tile road field, under the
normal fog rules.

## AI
- The AI finds cities from `civ.siteIntel` (scouted sites) and from the known start positions. It never follows
  roads to find them, so expansion is unaffected.
- It still calls `establish` each plan tick for its unestablished cities. The road is planned only when the plain
  headquarters is affordable, and a plan is reused for 20 s, so planning is never a per-tick cost.
- Its "save for a base" reserve (`buildArmy`) now uses `settlementCost` with the capture-time plan.
- AI New Base founding still needs a road tile in its territory. Its claim roads provide those.

## Protocol
The site wire (`ActionGame.siteWire`) carries `settle: { materials, energy, road, to }` on an own captured city
without a headquarters.
- Unity: `ObjectiveSite.SettleMaterials/SettleEnergy/SettleRoad/SettleTo` (`Messages.cs`, `ProtocolDecoder.cs`).
- The ruin wheel's "Establish base" shows that price and the line "Includes the road to X (n segments)"
  (`Hud.Base.cs`, `OpenRuinWheel`).

## Saves
- No migration. Older saves keep every road they have.
- `site.claimRoad` and `site.claimRoadBuilt` are plain site fields and persist with the sites.
- Only new matches start without country roads.

## Performance
Road planning runs only:
- at capture,
- on an affordable `establish` (at most once per 20 s per site),
- in the existing outpost and New Base links.

It never runs per tick. Map generation makes the same number of planner calls as before.

## Tests
- `test/roads-and-claims.test.js`:
  - A fresh match, over three seeds, has only crossing edges, no road at any city or outpost, and tracked and wheeled
    vehicles still reach every city.
  - Capture plans the road to the nearest own base. The ruin wire shows headquarters + 15 × segments.
  - One material short is refused (the message names the road) and charges nothing. Exactly enough pays it all and
    queues the claim road, which joins the city to the home base by road.
  - No second link is laid when the headquarters finishes, and unclaimed cities stay unconnected.
  - Island case: no route means no road and the plain headquarters price.
- `test/action-rts.test.js`: two tests assumed a pre-built network. The trench crossing test and the hub junction
  test now lay their road first with `connect`, and assert that hubs start bare.
- `test/action-maps.test.js`: the rival fairness measure on turned (3/4-seat) maps changed. The fairness bar is
  unchanged.
  - **Old measure:** coarse planner tiles. That only measured ground while the routes followed the pre-built roads.
  - **Problem without roads:** on a turned sector a straight run counts more hex steps along a zigzag bearing than
    along a hex axis. The tile-count planner then prefers a detour to the straight way over a central objective.
  - Measured on Crossroads, seat to opposite seat, at equal straight-line distance (99.6 / 100.5): 59 tiles against
    68.
  - Measured on King of the Hill: drives of 57.6 / 64.8 hexes. The 1→3 seats were routed around the Summit rather
    than up the ramps. Every seat's drive to the Summit is 28.5–30.1.
  - **New measure:** the drive the units actually take (`nav.route`, pulled taut), in hexes. It is taken direct or by
    way of one main site, whichever is shorter, under the same tolerance (`max(4, 8%)`).
  - Every catalog map passes. With the old roads, King of the Hill was 59.7 / 61.3; without them, via the Summit,
    ~58 / ~59.

## Balance sims (2026-11-18, `node tools/action-balance.mjs all 1,2 20`)
- 34 AI-only matches, no errors.
- **AI expansion works without roads to follow.** Cities held per player (mean of each match) grew from 1.0–2.5 at
  3 min to 1.5–3.5 at 18 min on every map. The most any one player held at the end ranged from 2 to 7.
- First contact was 1:41–8:18, comparable to the earlier W3 runs.
- A 12-minute AI duel (96 map, seed 5) established every captured city: 6, and 8 HQs counting the two starts.
  Four claim roads were built (2–7 new segments each); the others reused roads already laid.
