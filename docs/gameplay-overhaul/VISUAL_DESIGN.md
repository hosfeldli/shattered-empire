# Visual design: rings, accents, icons and cursors (workstream C-D)

Paths are relative to `unity/Assets/ShatteredEmpires/Runtime/`. Every element below is either baked into the city chunks or added to an instanced batch that already exists. None of them creates a GameObject per entity.

## Unit rings (§27)
- **Where:** `Military/UnitRenderer.Readability.cs` (`RingSizeOf`, `RingReach`, `GroundRing`). The size is cached per slot in `ringSize[]` when the slot is assigned.
- **Infantry:** a squad's ring stays at 0.60 and holds its men. A one-man unit (the engineer) gets a 0.30 ring. Its man is clamped inside his own, smaller ring.
- **Vehicles by drawn hull:**
  - autonomous tank 0.40
  - self-propelled gun 0.38
  - tank 0.36
  - APC and launcher 0.34
  - armored car and AA vehicle 0.33
  - truck 0.31
  - field gun 0.29
  - buggy 0.27
- **Zoom:** the minimum on-screen size at long zoom is unchanged.

## Building and turret selection rings (§36)
- **Where:** `Session/Commander.Selection.cs`. It is called by one line in `Commander.Action.cs` in place of the old fixed 1.02 corner brackets.
- **Size source:** the footprint comes from `BUILDINGS[type]` and is cached per type:
  - `radius`, as used for picking in `SpatialBuildingAt`
  - `width` and `depth` when present
- **Round ring:** used for field structures and defenses, including turrets. It is a single ring-mesh instance, laid at the highest ground under its edge.
- **Rectangular brackets:** used for base buildings and field rectangles such as the barricade. They are oriented by the building's yaw, sized `max(0.5, 2r) + 0.05` (or `width`/`depth` + 0.08), with arms of `min(0.15, side/6)`.
- **Colour:** green for our own and allied buildings, red for hostile ones.
- **Cap:** at most 48 buildings, 8 line instances each.

## Team accents and silhouettes on recipe facilities (§34, §35)
- **Where:** `Cities/CityRenderer.Facilities.cs`, plus `HeavyWeaponsFacility` and `PerimeterTurret` in `CityRenderer.Rings.cs`.
- **Team colour:** shown as a roof band and/or a door panel in `c.Civ` with a little emission. This matches how the authored models show their "mark" panels. A change of owner already recomposes the cell.

| Facility | Distinct element (§34) | Team accent (§35) |
|---|---|---|
| Armory | earth blast traverses and a turfed berm around its magazines | ridge band and door panel |
| Heavy weapons | yellow gantry crane over the yard, with a trolley and a gun barrel in the slings (the magazines are dropped) | ridge band and door panel |
| Airfield | striped windsock mast by the strip; beacon on the control tower | band on each hangar roof; the beacon is team-coloured |
| Advanced lab | antenna array (three masts with crossed dipoles) on the test wing | bands on the institute and the wing |
| Missile silo | ring of 16 bollards round the hatch | every other bollard is team-coloured, the rest hazard yellow; band on the control block |
| Defense works | (already had a crane and casting beds) | roof band and door panel |
| Perimeter turret (recipe fallback) | — | team band |

Field defenses keep their team pad rings.

## Building-type glyphs (§37)
- **Where:** `Military/UnitRenderer.BuildingGlyphs.cs`.
- **Look:** a square card with a stem, in the owner's frame colour, carrying a white sign:
  - X: barracks
  - track oval: vehicle works
  - dot and bar: heavy weapons
  - aircraft: airfield
  - crate: depot
  - bolt: generator
  - shells: armory
  - diamond: lab
  - arrow: silo
  - battlements: defense works
- **Why not HUD badges:** the plates go into the role-glyph instance batch, which is already rebuilt and drawn every frame. That costs no UI Toolkit elements to lay out or repaint, and the camera-facing code is shared.
- **Shown:** from camera distance 16 out to the strategic switch (52). Hidden closer in, and at strategic zoom.
- **Decluttering:**
  - one card per screen-sized cell (`camDist × 0.024`), with our own buildings first
  - at most 64 cards
- **Cost:**
  - picking is O(buildings) at 4 Hz, or when the zoom changes by more than 15%
  - each frame only re-emits at most 64 × 7 plates

## Pickup rings (§38)
- **Where:** `CityRenderer.Rings.cs` (`MaterialsPickup`, `PickupRing`).
- **Materials:** an amber square band, with crates.
- **Energy:** a cyan hexagon band, with upright cells and glowing caps instead of crates.
- Both are draped into the cell's ground mesh, so they cost nothing per frame.

## Context cursors (§39)
- **Where:** `Session/Commander.Cursor.cs`. `SetOrderCursor` and `MakeCursor` moved here from `Commander.Orders.cs`, and `UpdateTargetCursor` now calls `UpdateContextCursor`.
- **Tool modes (evaluated every frame, cheap):**
  - build: placement, a field build or growth; invalid where the footprint is refused
  - terrain: brush, road, trench or bridge
  - attack: an armed attack move or a targeted ability
  - move or attack: setting a rally point
- **Select mode with units selected:** the hover target, in the same priority as `ActionContextOrder`:
  1. enemy unit within 19 px, or enemy building: attack
  2. pickup: collect
  3. site we don't hold: capture
  4. own damaged building, with an engineer selected: repair
  5. own building with `garrison` slots, with infantry selected: garrison (reserved until the server sends slots)
  6. impassable ground: invalid
  7. anything else: move
- **Select mode with nothing selected:** the select arrow over anything clickable.
- **Throttle:** the O(units) hover lookup runs at most at 10 Hz. It runs only when one of these holds:
  - the mouse moved more than 2 px
  - the selection or the mode changed
  - 0.3 s passed
- **Textures:** each is drawn once per kind (32×32, coloured core with a dark outline) and set only when the kind changes.

## Building readability and picking (workstream B, 2026-11-18)

Goal: every defense and base facility has its own silhouette at mid and far zoom. Each also has a click target that matches what is drawn.

### Silhouettes

Code: `CityRenderer.Facilities.cs` (`DefenseSignature`, `FacilitySignature`).

These features are drawn on top of the authored Blender bodies. They are static instances composed with the building, so there is no per-frame cost. Everything they read (type, level, owner, memory, damage band, position) is already in `StructureStore.VisualKey`.

| Type | Body (authored) | Signature added | Height / pick radius |
|---|---|---|---|
| barricade | low sandbag arc, wire, hedgehogs | striped end posts with team caps; no rim (rectangle) | .12 / rect .50 × .34 |
| guard_post (watchtower) | braced tower, cabin | mast and bright team beacon over the roof (the tallest thin shape) | .66 / .28 |
| bunker | octagonal pillbox in a berm | concrete dome, team cap, periscope (reads as a squat dome) | .27 / .46 |
| turret (anti-armor) | revetment ring, shielded gun | row of five dragon's teeth across the field of fire | .22 / .42 |
| aa_battery | octagonal platform, barrels skyward | rear fire-director mast with a team band and a dish | .48 / .40 |
| city_turret | hex plinth, MG cupola | team disc round the cupola, searchlight mast at the rear | .27 / .26 |
| artillery_post | wide berm, long tube | camouflage net on poles over the ammo bunker, team front edge | .28 / .50 |
| fort (outpost) | hex star fort, blockhouse gun | team cap on each of the six bastions | .34 / .56 |
| sensor_post | lattice mast | dish on the mast head, team beacon above | .70 / .30 |
| repair_point | hazard gantry | team plate with a white cross on the gantry | .38 / .36 |
| barracks (authored) | hall, wing, flag | team-edged drill yard with hurdles, radio mast with a team beacon | .46 / .54 |
| depot (authored) | warehouse, bay doors | container stack under a portal crane with a team beam (clear of the bays) | .46 / .54 |
| motor_works (authored) | assembly hall | proof tank on a team-rimmed turntable in front | .46 / .54 |
| town, power_plant | authored | unchanged (tier dressing / smoke stacks already distinct) | .80 / .54, .46 / .54 |
| airfield, armory, heavy_weapons, labs, missile_silo | recipes (§34, §35) | unchanged (hangars, berms, masts, bollard ring) | .30–.46 / .54–.56 |

**Gameplay structures versus ambient houses**

- **Defenses:** every defense stands inside a crisp team rim on the ground, just outside its body (outside the blast ring from level 2).
  - Inside a base's influence ring, the rim sits on a concrete apron.
  - In the field, the existing gravel pad and team ring (`FieldStructurePad`) do the job. A rim is added there only where the body outgrows that pad (bunker, artillery, fort, AA).
- **Base facilities:** these keep their socket pads with team corner arcs.
- **Ambient city fabric:** houses, ruins and the passive base dressing (`CityRenderer.BaseDevelopment.cs`) carry no team colour and no rim.

**Far zoom:** field defenses also get a building glyph (`UnitRenderer.BuildingGlyphs.cs`).

- The card is a diamond, a square turned 45°. Facility cards are upright squares.
- Signs by type:
  - MG: dot and bar
  - anti-armor: long barrel
  - AA: twin barrels pointing up
  - howitzer: raised tube
  - bunker: mound
  - watchtower: T
  - outpost: battlements
  - radar: arc
  - repair: cross
- Declutter order: own facilities first, then own defenses, then other players' facilities, then theirs. The cap is still 64.

### Picking

Code: `Commander.Selection.cs`, `PickBuilding`. `SpatialBuildingAt` now forwards to it.

- **Ray against the drawn shape:** the cursor ray is cut at two planes, the structure's ground and its tallest readable part. The plan-view segment between the two cuts is then tested against the footprint:
  - for most structures, a disc of radius `max(server radius, CityRenderer.VisualExtent)`
  - for the barricade, its rotated rectangle
  - Because the test uses a segment between two heights, clicking a tall mast or a roof still picks the building.
- **Margin:** .04 map units, with a minimum of 13 px on screen. A perimeter turret stays clickable when zoomed out.
- **Overlaps:** the structure whose footprint the cursor is deepest inside wins. Depth is normalised by size, so a turret beside a headquarters still wins when the cursor is on the turret.
- **What can be picked:** only gameplay structures, meaning types in the server's `BUILDINGS` or known to `CityRenderer.IsGameplayType`. Ambient houses, ruins and the base dressing are never picked and never take the hover.
- **Units versus structures:** a click inside the inner 60% of a structure's pick radius selects the structure. This holds unless an own unit is within 9 px. Before this change, any unit within 18 px won the click.
- **Hover highlight:** in select mode (not over the interface, not dragging), the structure under the cursor gets a bright ring at its pick footprint before any click, plus a faint outer halo.
  - Base buildings and the barricade get corner brackets instead of a ring.
  - Colours: pale for own or allied, red for hostile, sand for neutral.
  - The hover card (`Hud.HoverCard.cs`) names the structure, its owner, a one-line role (with what it is good and weak against), its condition and level, or its construction progress. It only appears when no unit is under the cursor.
- **Cost:**
  - One pick pass per frame, memoised per frame and mouse position. The cursor context, the click and the hover ring all share it.
  - Most buildings are rejected after a single ground-hit distance check.
  - No allocation. Footprints are cached per type.
  - The hover adds at most two ring instances (or eight bracket lines).
- **Selection ring:** the round ring of a defense now hugs its drawn body, at `max(server radius, visual − .04)`.

### In-game checks

1. **Zoom 25–60:** with a mixed group of defenses, each type is identifiable by silhouette alone. Look for the dome bunker, the teeth on the anti-armor gun, the mast and dish on the AA, the beacon on the watchtower, the dish on the radar, the camo net on the artillery, and the team bastions on the outpost.
2. **Zoom 16 up to the strategic switch:** defense diamonds appear next to the facility squares and do not crowd out facility cards.
3. **Dish orientation:** the AA and radar dishes and the bunker dome sit on their bodies without floating or clipping. If a dish faces the wrong way, change the `yawOffset` in `DefenseSignature`.
4. **Facility features:** the depot crane and containers stay clear of the bay doors, the motor-works proof tank sits on its turntable in front of the hall, and the barracks drill yard and mast stay clear of the hall and wing.
5. **Hover:** hover each structure type at close, mid and far zoom. A ring or brackets appear before the click, and the hover card names the structure. Clicking anywhere inside the ring selects it.
6. **Tall structures:** clicking on a watchtower roof or a radar dish selects it.
7. **Neighbours:** a perimeter turret next to the HQ can be picked on the turret, and the HQ everywhere else.
8. **Units beside structures:** with own infantry standing beside a bunker, clicking the bunker's centre selects the bunker, and clicking right on a soldier selects the soldier.
9. **Ambient city:** houses, ruins and the base's development dressing (sheds, tanks, tents, water tower) never show a hover ring and never take a click away from the pad under them.
10. **Rims:** defenses inside a base ring show a concrete apron with a team rim, and field defenses show no double ring.
