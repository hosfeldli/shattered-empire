# Construction, territory and placement (W2)

**Scope:** directive §12–14. Server: `server/sim/actionBases.js` (`placeableBy`, `fieldCost`, `constructDefense`), `server/sim/actionEngineers.js` (terrain works), constants in `server/sim/actionDefinitions.js` (`PLACEMENT`, `def.neutral`, `TERRAIN_WORKS.neutral`). Tests: `test/neutral-construction.test.js`.

## Where each structure may be built

| Structure | Own territory | Neutral ground | Another player's territory | Beyond the ring of influence (8 hexes) |
|---|---|---|---|---|
| Defenses (`def.defense`: anything armed, plus sandbags) | yes | yes | never | ×3 cost (unchanged) |
| Neutral infrastructure (`def.neutral`: radar / sensor post, forward repair station) | yes | **yes (new)** | never | ×3 cost (new, same rule as defenses) |
| New Base (`base_site`) | yes (on or beside a road) | no | never | n/a |
| Roads, trenches | yes | yes | never | unchanged |
| Terrain works (`TERRAIN_WORKS.neutral`) | yes | **yes (new)**, in sight only | never | flat price |
| Base facilities (ring pads) | own operational HQ only | n/a | n/a | n/a |

- **Pads are unchanged:** 3 / 5 / 7 ring sites by base tier (`openSlots`).
- **Neutral infrastructure claims no territory.** Territory comes only from sites, from `def.claims` (watchtower, bunker and emplacements claim 1 hex, the Outpost claims 2) and from dug trenches. `refreshTerritory` is unchanged. The test builds each post on neutral ground, finishes it, refreshes territory and checks that the owner map is identical.
- **Fog:** your own territory need not be in sight; neutral ground must be visible. This applies to every build-wheel structure and to terrain works. A legacy single-point terrain order may still include fogged hexes of your own territory.

## Placement leniency (§14)

| Rule | Before | Now |
|---|---|---|
| Rotated footprint (sandbag wall) level check | flat \|Δelev\| ≤ 0.10 between each footprint sample's hex and the centre hex | ≤ `slope.base + slope.perSpan × half-diagonal` = 0.10 + 0.30 × 0.30 ≈ **0.19**. About 14% of adjacent land-hex pairs differ by more than 0.10; about 4% differ by more than 0.19. |
| Water and cliff sampling | `nav.canStand` at the full radius | Centre, plus 4 samples at **0.75 × radius** (`PLACEMENT.edge`) |
| Obstacles (structures, wrecks) | Full radius | Full radius (unchanged), so structures never overlap |
| Command-zone margin | site radius + r + 0.10 | site radius + r + **0.04** |
| Building-pad margin | r + 0.62 from every planned parcel | r + **0.60** (largest facility radius 0.57 + 0.03) |
| Enemy HQ keep-out | 2.65 + r | Unchanged |
| Hostile-troops check | radius 0.75 | Unchanged |
| Bridges | allowed: a road deck counted as walkable | **Refused** (`water`): a structure on a bridge would cut the crossing |

**What stays protected for navigation:**
- The base command zone, which holds the hub and the ring road.
- Every planned pad, including those still locked by tier.
- A pending New Base's ring.
- Trenches.
- Bridges.

The server stays authoritative: the preview (`fieldPreview`) and the build (`fieldBuild`) run the same function.

## Refusal codes (for the client preview)

Every refusal from `fieldPreview` and `fieldBuild` carries `code`. The messages are in `actionBases.PLACEMENT_REASONS`.

| code | Meaning |
|---|---|
| `hidden` | Neutral ground not in sight |
| `territory` | Another player's territory (or a territory-only structure off your land; a rotated footprint crossing a border) |
| `base` | Too close to a base or outpost: its command zone, an enemy HQ, or a New Base under construction |
| `pad` | On or too close to a base building pad |
| `trench` | A trench already runs here |
| `water` | Water, lake, a river too deep to ford, or a bridge |
| `slope` | Too steep: a cliff or mountain, or a rotated footprint that is not level enough |
| `blocked` | Overlaps a structure or wreck, or is off the map |
| `enemy` | Hostile troops within 0.75 |
| `influence` | Can't afford it, with the ×3 surcharge outside the ring of influence |
| `road`, `spacing`, `ring` | New Base rules (unchanged) |

**Terrain works** return `territory`, `hidden`, `ground` or `busy`.

**Client follow-up (C-B / C-C):**
- Label the ghost by `code`.
- `Hud.Base.cs` currently says "Inside your territory" for non-defenses. Use the `neutral` building flag to say "Your land or neutral ground".
- The ring overlay in `Commander.Rings.cs` should also show for `neutral` structures.

## Client (C-B, 2026-11-17)

Unity files: `UI/Hud.Base.cs` (wheels), `UI/Hud.Action.cs` (selection card, site markers), `UI/RadialMenu.cs`, `Session/Commander.Rings.cs`. Protocol (additive): `BuildingRecord.Queues / QueuesFromServer / ProductionCapacity / Garrison / HasGarrisonExit`, `ObjectiveSite.Decaying`.

**Base wheel (§11).** The root ring holds upgrades and status, not construction:

| Angle | Wedge |
|---|---|
| 0° | Tier upgrade (U) |
| 40° | Pads: a sub-ring of the pads, each pointed at its parcel. Empty pads open the facility ring. |
| 80° | Economy: this base's income and the stockpile |
| 120° | Garrison of the HQ (W4), when the HQ type has `garrison` |
| 160° | Base production (selects its producers) |
| 200° | Perimeter: build, rebuild or upgrade |
| 240° | Headquarters: condition, tier, pads used/open/free. Click repairs it when damaged. |
| 280° | All production |

The outer arc holds the rally point. The centre shows "Tier II base · 3/5 pads used · HQ 100%".

**Pads (§12).** Pads of every own base can be hovered and clicked without selecting the base first. Nothing changes while units are selected, because a right-click is then a move.
- The pick radius is `.57 × sqrt(cameraDistance / 14)`, clamped to .57–.82.
- A hovered pad of a base that is not selected gets a ring: amber when empty, teal when built, grey when locked.
- A cursor hint names the pad's state: locked (with the tier that unlocks it), empty (click to build, pads used), the facility on it, or construction progress.
- A click selects the base and opens Pads, then that pad's facility ring. That ring shows cost, time, requirements and why a facility is locked.
- Cancelling a facility under construction has a client hook (right-click its pad wedge). It sends `{c:'cancelConstruction', id}`, but only once the server advertises `RULESET.cancelConstruction`. **The server has no such command yet**: `demolish` refuses unfinished structures.

**Placement (§14).**
- `fieldPreview` refusals are labelled from `code` by `Commander.PlacementRefusal`. The codes are hidden, territory, base, pad, trench, water, slope, blocked, enemy and influence. The road, spacing and ring codes keep the existing readable texts.
- `neutral` structures say "Your land or neutral ground" in the build wheel.
- The amber ring-of-influence overlay and the ×3 warning also show while placing `neutral` structures.

**Production (§7–9, R1/R2)**
- The client reads `qs` and `cap`. Without `qs`, the legacy `q`/`tr`/`rp` fields are grouped by unit type. Priority and pause are then disabled, and cancel uses `index`.
- **Wheel training wedge**
  - Badge: the summed count. Green ring: the best progress. Top-right glyph: the state when not producing.
    - resources: the Materials or Energy glyph
    - capacity: command
    - prerequisites: lock
    - exit: close
    - paused: pause
    - waiting: queued
  - The centre circle names the state in words.
  - Costs are advisory (`RadialItem.CostAdvisory`): an unaffordable unit still queues, and the order waits.
  - Click +1, Shift +5, Alt one per building, Ctrl repeat.
  - Right-click −1, Shift+right-click all of that type, Ctrl+right-click pause or resume, Alt+right-click to cycle priority.
  - The outer arc has "Clear queue" (confirm).
- **Selection card**
  - A capacity bar shows the building's budget split equally across the queues that are producing now (an approximation of the tiered scheduler), with "N work/s · K queues share it".
  - Then Repeat and Clear.
  - Then up to five queue rows. Each row has: swatch, icon, name ×count, progress, state icon and text, a priority button (Low / Normal / High), pause/resume, −1 and cancel-all.
  - Every cancel tooltip says "Resources already spent are not refunded". The toast reports the `lost` amount.
- With several buildings of one type selected, rows are summed per unit type. Each command goes to every building that holds that queue. Queueing uses `batchTrain` over all of them.

**Capture (R7).** Sites have three states: rising, paused (contested) and draining (`decaying`). They are shown with words on the card ("Capturing 45%", "Paused · contested · 45%", "Draining 45% · nobody capturing") and a state glyph (up chevrons, pause, withdraw). The world marker draws a shape: an up triangle, two bars, or a red down triangle. A draining arc turns red. The marker name reads "Contested · paused" or "Draining".

**Garrison (W4, from the contract in CAPTURE_AND_GARRISON.md)**
- **Card** (one garrisonable building selected, or an own base's HQ):
  - "Garrison · 2/4 inside · 2 firing, 0 sheltered · exit rally set".
  - Exit rally sets the point with a map click (`garrisonRally` with a point). × clears it.
  - Eject all.
  - One chip per occupant, in `gar` order. A gold top edge marks a firing slot. Click selects the squad. Right-click ejects it (`ungarrison` with `units`).
- **Wheels**
  - The building wheel and the base wheel have a Garrison wedge (badge = occupants). Its sub-ring has Eject all, Exit rally, Clear exit rally, and one wedge per occupant: click selects it, right-click ejects it.
  - The unit wheel has "Garrison" when it holds capture-capable squads. Its sub-ring lists the eight nearest own structures with free room, and a click sends `garrison`.
  - When selected squads are inside (flag 16384), the unit wheel has "Leave structure" instead.
- A blue ring marks the exit rally point of the selected structure.
- Right-click-to-garrison on a building (the order path in `Commander*.cs`) and hiding occupants' models are left to C-C and the renderer.

## Defenses off roads, snapping, and the placement contract (2026-11-18)

**Code:** `server/sim/actionBases.js` (`constructDefense`, `siteRefusal`, `snapCandidates`, `onRoad`, `PLACEMENT_REASONS`), constants `PLACEMENT.roadClear` and `PLACEMENT.snapHexes` in `actionDefinitions.js`. **Tests:** `test/placement-snap-2026-11-18.test.js`.

### Road rule
- Every defense (`def.defense`) **except the sandbag barricade (`barricade`)** stays off roads. Roads are never rerouted around a defense; the defense moves instead.
- A spot is "on a road" (code `road`) when either:
  - its hex carries any road edge (usable or ruined; a ruined road can be repaired, so it stays clear), or
  - the structure's disc (radius `r`) comes within `r + PLACEMENT.roadClear` (0.35) of a road edge's centre line (hex centre to hex centre) or of a base ring road. Only the hex and its six neighbours are checked.
- The barricade may stand on roads (unchanged).
- Base perimeter turrets (`fortifyBase`) also skip lots on roads, and they now try two extra bearings (±0.32 rad).
- Non-defensive build-wheel structures (radar post, repair station) are not affected.

### Snap rule (the client preview mirrors this exactly)
When the requested point is refused with a **snappable** code (`road`, `slope`, `blocked`, `water`, `trench`, `pad`, `forest`), the server moves the structure instead of refusing:
1. **Candidates:** the centres of every hex within **R = 2 hexes** (`PLACEMENT.snapHexes`, hex distance) of the requested point's hex. The requested hex's own centre is included.
2. **Order:** by straight-line distance from the *requested point* to the hex centre, rounded to 1e-6 (`Math.round(d * 1e6)`). **Ties go to the lowest tile id.**
3. The first candidate that passes **every** placement rule is used: the same checks as the original point, including territory, sight, base, pad, trench, road, ground, the rotated footprint at the same yaw, and hostile troops. The structure is placed at that hex's centre.
4. If no candidate passes, the original refusal (code and text) is returned.

Codes that are **never snapped** (the player must choose again): `hidden`, `territory`, `base`, `enemy`, `funds`, `influence`, `tech`, `invalid`, and the New Base codes. Funds are checked after snapping, at the final hex, so the ×3 surcharge is the one for where it actually goes.

### Refusal codes (complete list for `fieldPreview` / `fieldBuild`)
Every refusal ack carries `error` (human text), `code`, and **`reason` (same value as `code`)**.

| code | text (default) |
|---|---|
| `hidden` | Scout the construction site so it is currently visible. |
| `territory` | Build only on your own territory or neutral ground, never in another player's territory. (Variants for a non-defense and for a rotated footprint.) |
| `base` | Too close to a base or outpost: keep its command zone and approaches clear. (Variant: "Keep clear of the new base being built.") |
| `pad` | Keep clear of the base's building pads. |
| `trench` | A trench already runs here. |
| `water` | Structures cannot stand in water or on a bridge. |
| `slope` | The ground is too steep here. |
| `blocked` | Something is in the way: choose clear ground. |
| `forest` | **new** Dense forest: infantry engineers cannot reach it. Clear it with tanks first, or build at its edge. |
| `road` | **new for defenses** Defenses cannot block a road: place it beside the road (sandbag barricades may go on roads). For a New Base, `road` keeps its old meaning: "A new base must connect to a road". |
| `enemy` | Hostile troops contest the position. |
| `influence` | Insufficient materials or energy · Outside your influence: ×3 cost. |
| `funds` | **new** Insufficient materials or energy. |
| `tech` | **new** This defense requires more advanced global technology. |
| `invalid` | **new** Bad structure type, location or rotation. |
| `spacing`, `ring` | New Base rules (unchanged). New Base "Choose clear, open ground" is now `blocked` and "The position is contested" is now `enemy`. |

### Responses
- **Preview success** (`fieldPreview`): `{ t:'ack', rid, placement: { valid:true, cost, seconds, tile, x, z, yaw, surcharge?, note?, snapped?:true, reason?, moved? } }`.
  - `tile`, `x`, `z` give where the structure would actually go.
  - `snapped: true` and `reason` (the code that was resolved) appear only when the server moved it. `moved` is the distance from the requested point.
- **Build success** (`fieldBuild`): `{ t:'ack', rid, building: id, tile, snapped?:true, reason?, placement: { ...as above } }`.
  - When snapped, the owner also receives a quiet note: `{ t:'note', kind:'build', text:'Bunker placed 0.9 away: kept off the road.', tile, building, x, z, snapped:true, reason }`.
- **Refusal:** `{ t:'ack', rid, error, code, reason }`.

**Client follow-up:** draw the ghost at `placement.x/z` (or the snapped hex). When `snapped`, show a thin line from the cursor to the ghost and the resolved reason. Label refusals by `reason`/`code`, using the table above.
