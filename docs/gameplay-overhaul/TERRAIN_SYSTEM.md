# Terrain system: forest clearing (R5)

**Owner:** W3. **Code:** `server/sim/battlefield.js` (`addWear`, `clearForest`, `forestStep`, `FOREST_CLEAR`), `server/sim/actionDefinitions.js` (`clearsForest` flag). **Tests:** `test/action-w3-squads-world.test.js` (Test E and the batching test).

## Rule
Heavy tracked hulls flatten the forest they drive through. A cleared hex stays cleared for the rest of the match, through save/load and in multiplayer.

- **Which units clear forest:** units whose definition has `clearsForest` set. Currently that is `tank`, `autonomous_tank` and `sp_artillery`.
  - Until the hook below lands, the caller passes no unit definition, so every tracked hull counts. That adds `mech_infantry`.
- **How a hex is cleared:** `FOREST_CLEAR.passes` (3) entries into the same FOREST hex.
  - Each entry adds one pass, counted on the hex's wear record (`g.wear.get(t).h`).
  - The record decays with ordinary wear, so the passes must come within a few minutes of each other.
- **What clearing does:**
  - Moisture drops to at most `FOREST_CLEAR.moist` (0.45), which is below the forest band (> 0.53) of `world.classify`.
  - The terrain becomes `T.GRASS`.
  - `world.touch(t)` bumps the hex version, so geo deltas reach every client.
  - `g.bfVer` is bumped.
- **No regrowth:** nothing in the action ruleset raises moisture again. A later `classify` from a terrain brush works from the lowered moisture, so it never returns a forest.

## Persistence and replication
- `moist` and `terr` are both in `persist.js` `WORLD_ARRAYS`, so a save stores the cleared hex directly.
- The wear records, including the pass counters, are saved with the battlefield.
- `restoreBattlefield` re-queues any forest hex that reached its passes but had not yet been processed.
- Clients receive the hex through the normal tile-version delta (`world.ver`).

## Performance
- **No per-tick work:** `addWear` already runs once per tile entry. It now also adds the hex to `g.forestPending`, but only when a heavy hull enters a forest hex with enough passes.
- **Bounded checks:** `forestStep` runs inside `battlefieldStep` (the 1 Hz warzone job). It checks only the pending set, at most 64 hexes per step. There is no full-map scan.
- **Batched navigation invalidation:** `nav.invalidate()` runs at most once per `FOREST_CLEAR.navEvery` (3) seconds, however many hexes were cleared.
- **Ruleset gate:** clearing applies only when `g.nav.invalidate` exists (the action ruleset). The legacy ruleset keeps its forests.

## Hooks needed from other owners
- **`server/sim/actionOrders.js:394` (performance agent):** pass the unit definition so only heavy hulls clear forest:
  - Current: `addWear(game, nextTile, def.move)`
  - Change to: `addWear(game, nextTile, def.move, def)`
  - Without this change, every tracked hull counts (including mech infantry).
- **Client (C-D / terrain):** the forest vegetation on a hex must be rebuilt when that hex's terrain changes from FOREST in a tile delta.

## Follow-ups (not in scope)
- **Dense forest blocking infantry:** dense forest that blocks or slows infantry until it is cleared needs `actionNavigation.js` cost changes, which the performance agent owns.
- **Partial clearing states:** thinned forest after one or two passes, with its own cover value, would need a client visual.

# Dense forest blocks infantry (§30, 2026-11-18)

**Code:** `server/sim/actionMap.js` (`markDenseForest`, `DENSE_FOREST`, `denseWire`), `server/sim/actionNavigation.js` (`cost`, `roadOnly`), `server/sim/persist.js`, `battlefield.js` `clearForest`. **Tests:** `test/dense-forest-2026-11-18.test.js`.

## Rule
- **Infantry:** the `infantry` move class (every foot unit, including engineers, special forces and exo infantry) cannot enter a dense-forest hex unless it walks along a road through it.
- **Vehicles:** wheeled and tracked vehicles are unchanged.
  - Heavy hulls (`clearsForest`: tank, autonomous tank, SP artillery) clear a hex after 3 passes, as before.
  - A cleared hex becomes grass and is open to everyone. Navigation is invalidated at most once every 3 s (`FOREST_CLEAR.navEvery`).
- **Lighter vegetation:** ordinary forest, and every hex that is not dense, stays traversable at its normal forest cost.
- **Build-wheel structures:** they refuse dense forest with code `forest` and snap out of it (see CONSTRUCTION_DESIGN.md).

## Which hexes are dense
The set is decided once, at map creation, and saved in the save file. Rules:
- **Interior only.** A FOREST hex qualifies only if its six neighbours are all FOREST. Every dense core therefore sits inside a passable fringe of ordinary forest.
- **Exclusions.** Never a road, river or lake hex. Never within 3 hexes of a base or outpost.
- **Lanes.** Every 5th offset row and column stays open as footpaths. Large forests split into groves at most 4 hexes across, so a detour around one is short.
- **Symmetry.** On authored maps (mirror, or 3- or 4-fold rotation), a hex stays dense only if all of its symmetric images are dense too. No seat gets a different forest.
  - Rotational maps keep little dense forest, because the lane grid does not rotate onto itself.
- **Minimum size.** Cores smaller than 3 hexes are dropped.
- **Connectivity guarantee.** The infantry connected regions are computed before and after. Any hex the cores would cut off has its surrounding dense hexes opened. This repeats up to 12 rounds. The last round opens every core that touches a pocket.
  - Result: every pair of hexes infantry could connect without dense forest stays connected.
  - The test checks this on every catalogue map and on generated maps.
  - It also bounds the start-to-objective detour: the worst is ×1.08 (+3 hexes) on continental_divide.
  - It also checks seat fairness: the spread between seats in route growth is ≤ 0.01.

## Saves and wire
- **Saves:** `world.arrays.dense` (base64 `Uint8Array`). An older save derives the set from its saved terrain.
- **Welcome:** `world.dense` is base64 of a bitset. Hex `t` is bit `t & 7` of byte `t >> 3`. Sent once.
  - A hex is dense while its bit is set **and** its terrain is still FOREST. Clearing only ever removes dense hexes, and clients already receive the terrain change in tile deltas, so nothing more is sent.
- **Client follow-up:** draw dense hexes with thicker vegetation, and show a "Dense forest: infantry cannot pass" cursor hint for infantry orders.
