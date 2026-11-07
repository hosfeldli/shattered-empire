# Building asset audit (2026-11-07)

The native client draws all 34 authoritative building definitions from composed geometry and
reusable authored components. This audit records the source, recognisable features and
state handling for each one. It is a production checklist, not a claim of final art quality;
every entry still needs visual review in play.

## Visual language (locked)

- **Setting:** stylized realism in a *modern post-collapse* world. Reclamation repairs
  contemporary concrete, glass, containers, salvaged steel and modular housing. Industrial
  Recovery standardises restored industry. Mechanization adds modern blocks, vehicles, rail and
  highways. Networked Warfare adds sensors and automation. Advanced Systems adds grounded robotics,
  fusion, composites and the arcology.
- **Never:** medieval, steampunk or WWI styling, magical sci-fi props, or instant whole-city era
  swaps. Older structures keep their look; only new and upgraded parts use newer components.
- **Materials:** CC0 photographic PBR sets at real-world scale (`assets/materials/SOURCES.md`).
  Weathering is restrained: grime on walls, rust on metal, scorch only from real damage. Faction
  colour appears only on flags and markings.
- **Scale:** 1 hex radius ≈ 25 m. A detached home is about 0.4 wide; a car about 0.09 long.

## Shared states (every building)

| State | Source | Presentation |
| --- | --- | --- |
| Construction | `p`, `cr`, `qw` | Site preparation → ground work → frame → exterior in scaffolding → finishing. Machinery, tower crane (tall buildings), workers and material only while a crew works. Sites waiting for materials show empty pallets and no machinery. |
| Upgrade / repair works | `wk` | Scaffold towers rise with progress. Upgrades show a jib crane; repairs show a tarpaulin. Halted works show no crane load. Priority and pause come from the server. |
| Damage | `hp` bands (85/60/35) | Missing panels clustered at recorded impacts, or deterministic when none were recorded. Glass breaks first. Scorch on walls, bent rebar on broken concrete, a fallen slab when severe, smoke when below 35. |
| Ruin | `st = ruined`, ruins list | Shell clipped to a quarter of its height, rubble cone and twisted steel; ruins layer afterwards. |
| Active / idle | `a` | Chimney smoke, vehicles, tractors and yard stock appear only while the server reports activity. |
| Remembered (foreign, out of sight) | `mem` | Frozen last-seen record in a cool, desaturated tone, with no smoke or activity. |
| Identity | site/type seed + recipe id/version | Stable across reloads; the placement preview uses the same parcel and architecture. |
| LOD | `LODManager` + district batching | One mesh per district; wrapped copies at the seam. |

## Per-building audit

| ID | Name | Composition | Recognisable features |
| --- | --- | --- | --- |
| `town` | Settlement Hub | CivicBuildingLibrary `_hub` | Repaired municipal block, forecourt, flag, roof solar, parked cars and a bus shelter. City adds a plaza and apartments, Metropolis adds offices and streetlights, Megacity adds towers. |
| `house` | Housing Block | SettlementRenderer homes and `residential_*.glb` | Detached homes; four- and nine-storey apartment blocks at levels 2–3; joined into residential streets with terraces, kerbside cars and lights. |
| `farm` | Farm | CivicBuildingLibrary `_farm` | One farmstead per estate (barn, silos, shed, tractor, hay); other farms carry irrigation pivots or field kit. Level 3 adds greenhouses. |
| `lumber` | Timber Mill | CivicBuildingLibrary `_sawmill` | Open steel saw shed, infeed conveyor, log decks, sawn stacks, log loader while working. |
| `quarry` | Quarry | CivicBuildingLibrary `_quarry` | Stepped benches (more at higher levels), crusher, conveyor to a ballast heap, haul truck. |
| `salvage` | Salvage Yard | DevelopedBuildingLibrary | Sorting hall, wreck stacks, crane mast. |
| `barracks` | Barracks | ModernBuildingLibrary | Prefab accommodation, training ground, flag. |
| `market` | Market | SettlementRenderer `_market` | Covered hall, plaza, container shopfronts with awnings; neighbouring markets form a shopping street. |
| `academy` | Academy | ModernBuildingLibrary `_campus` | Modern teaching block; joins universities into a campus with lawns and paths. |
| `port` | Port | ModernBuildingLibrary `_port` | Terminal on a piled deck standing in the ocean hex, facing its own shore. |
| `guard_post` | Guard Post | ModernBuildingLibrary | Prefab lookout on legs, jersey barriers, boom gate, sandbagged position. |
| `bunker` | Bunker | ModernBuildingLibrary | Earth-bermed concrete with a firing slit; a concrete trench portal where works meet it. |
| `mine` | Mine | CivicBuildingLibrary `_mine` | Iron or coal deposit: shaft headframe and winding house. Bare rock: adit portal. Conveyor, ore or coal stockpile matching the deposit, haul truck. |
| `steel_mill` | Steel Mill | DevelopedBuildingLibrary | Furnace hall, twin stacks, rooftop plant, pipe rack. |
| `power_plant` | Power Plant | CivicBuildingLibrary `_power` | Turbine hall, boiler house, chimney stack, cooling towers, transformer yard. |
| `oil_well` | Oil Well | ModernBuildingLibrary `_pumpjack` | Pumpjack that moves only while producing; tanks and pipework. |
| `munitions_plant` | Munitions Plant | DevelopedBuildingLibrary | Separated halls, blast bays, rooftop plant, perimeter fence. |
| `motor_works` | Motor Works | DevelopedBuildingLibrary | Assembly hall with large doors and parked vans. |
| `depot` | Supply Depot (legacy only) | CivicBuildingLibrary `_depot` | Warehouse with loading doors, stacked containers, pallets. Not in the build palette. |
| `fort` | Fortress | ModernBuildingLibrary `_fort` | Earth-covered concrete casemates, command bunker, berms. |
| `university` | University | ModernBuildingLibrary `_campus` | Larger campus with a lecture hall. |
| `aa_battery` | AA Battery | ModernBuildingLibrary `_aa` | Revetted gun, radar panel, ammunition; a sandbag-lined trench entrance. |
| `refinery` | Synthetic Fuel Refinery | DevelopedBuildingLibrary | Distillation columns, storage tanks, pipe racks. |
| `heavy_assembly` | Heavy Assembly | DevelopedBuildingLibrary | Tall hall, gantry, wide doors, heavy truck. |
| `airfield` | Airfield | ModernBuildingLibrary `_airfield` | Runway, taxiway, hangars, control tower. |
| `electronics_plant` | Electronics Plant | DevelopedBuildingLibrary | Glazed clean-room block, roof units, solar, dish. |
| `comms_tower` | Comms Tower | ModernBuildingLibrary `_mast` | Lattice mast with dishes, beacon, shelter, transformer, fence. |
| `drone_works` | Drone Works | DevelopedBuildingLibrary | Twin hangars, control tower, launch mast, radar. |
| `shield_generator` | Shield Generator | DevelopedBuildingLibrary | Composite emitter column, four pylons. |
| `fusion_plant` | Fusion Plant | DevelopedBuildingLibrary | Ring of composite coil housings around the reactor, control hall. |
| `robotics_complex` | Robotics Complex | DevelopedBuildingLibrary | Composite-clad automated hall, robot arms, roof plant. |
| `missile_silo` | Missile Silo | DevelopedBuildingLibrary | Armoured flush silo doors, support building, mast. |
| `wonder` | Continental Arcology | DevelopedBuildingLibrary | Four composite towers around a central spire with terraced greenery. |
| `camp` | Rebel Camp (removed) | ModernBuildingLibrary `_camp` | Kept for old records only; rebels no longer exist. |

## Reusable components

There are 36 authored components with stable ids in `recipes/assets.json`, stored as
`assets/components/<id>.glb`. They are generated from `scripts/composition/ComponentKit.gd` by
`tools/build_components.gd`. Pivots sit at the centre of the base, +Y is up and the front faces
+Z. Material slots use `MaterialLibrary` keys.

## Remaining art work

- Review every entry above in play, at close and strategic zoom.
- Replace the remaining procedural primitives in the DevelopedBuildingLibrary halls with
  authored components where silhouettes need more detail.
- Military units: rebuilt in `MilitaryModelLibrary` and `FigureKit`. Squads are drawn as
  free-moving figures by `SquadPresentation`. All still need review in play.
