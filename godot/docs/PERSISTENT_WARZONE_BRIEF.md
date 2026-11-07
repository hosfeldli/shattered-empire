# Shattered Empires — Persistent Warzone Evolution Engine

## Complete design brief and implementation handoff

**Target:** Godot Native Edition  
**Simulation authority:** Existing Node.js Shattered Empires server  
**Rendering:** Procedural 3D terrain, material blending, persistent deformation and dynamic effects  
**Art direction:** Modern post-collapse warfare progressing into advanced and autonomous combat  
**Objective:** Battles permanently change how the world looks and temporarily change how it plays,
without excessive micromanagement.

This document records the user's complete 21-section brief, including the continuation supplied
on 2026-11-06. It is a **design and acceptance target**, not a statement that all parts are
implemented. The [development backlog](DEVELOPMENT_BACKLOG.md) tracks related open work and
conflicts with older designs. [CURRENT_WORK.md](CURRENT_WORK.md) records the current checkpoint.
The existing public preview does not include later uncommitted work.

## 1. Core experience

A battlefield should not look the same after sustained fighting. A wooded ridgeline with a road,
settlements and a new trench is first marked by isolated impacts, soil and broken branches; then
shelling overlaps craters, destroys trees and deteriorates the road and defenses. Continued combat
produces one recognizable no man's land, with wrecks and connected crater fields. Rain darkens mud,
fills existing crater bowls and changes tracks and smoke. After fighting moves on, fires and smoke
clear while wrecks and scars remain, weathering slowly as vegetation returns. Terrain tells the
story of the battle.

## 2. One persistent battlefield state

Keep three connected but separate layers:

1. **Authoritative warzone state:** the Node.js server determines impacts, intensity, craters,
   wrecks, trench/road/bridge/building condition, visibility-affecting smoke, cover, movement
   penalties and recovery. Extend `server/sim/battlefield.js` rather than replacing the simulation.
2. **Warzone composition:** Godot converts authorized state into connected terrain regions,
   crater/deformation geometry, materials, vegetation damage, debris/wrecks, mud/water, district
   surroundings and LOD, incrementally and with stable identity.
3. **Live combat presentation:** immediate explosions, muzzle flashes, projectiles, smoke, dust,
   fire, dirt, falling debris and vehicle destruction transition into the persistent state actually
   recorded by the server. Live effects and persistent damage share the same authorized events.

A visual effect cannot create gameplay damage, cover, obstacles or hidden intelligence.

## 3. Battlefield development stages

Keep the existing stage thresholds 15, 40 and 75 as **initial calibration**, not instant visible
transitions. Appearance should respond continuously to intensity and actual events:

| Stage | State | Intended visual development |
| --- | --- | --- |
| 0 | Natural | Normal terrain, vegetation and infrastructure. |
| 1 | Disturbed | Predominantly original terrain, with flattened grass, tracks, trampled plants, exposed soil, small impacts, limited scorch and debris. |
| 2 | Heavily contested | Expanding exposed soil, overlapping craters, damaged vegetation and roads, mud, isolated wrecks, local dust/smoke and rainwater in existing craters. |
| 3 | Devastated no man's land | Connected exposed earth and craters, major vegetation loss, wrecks/debris, damaged defenses and roads, physical deformation, climate-appropriate mud and historical scars. |

Do not depict one isolated dark hex for each damaged tile.

## 4. Warzone material field

Maintain separate normalized 0–1 presentation channels, derived from authorized persistent state:

| Channel | Meaning |
| --- | --- |
| `disturbance` | General combat wear and trampled land. |
| `crater_damage` | Terrain damaged by explosive impacts. |
| `scorch` | Burning and thermal damage. |
| `vegetation_loss` | Removed or damaged plant cover. |
| `vehicle_wear` | Tracks and ground wear from vehicles. |
| `debris` | Persistent wreckage and structural material. |
| `soil_exposure` | Ground exposed by loss of surface cover. |
| `historical_scarring` | Longer-lived evidence of previous combat. |

Use shared regional weather for wetness and snow instead of inventing a separate battlefield
weather model. Rifle engagements may disturb terrain but do not make craters; vehicle movement
contributes wear; authorized artillery impacts can create crater damage, exposed soil and scorch;
destroyed armor and damaged buildings contribute appropriate wreckage/debris. Different fights
and terrains should not all become the same generic muddy surface.

## 5. Physical crater generation

### 5.1 Recessed geometry

At tactical zoom, important craters need a genuinely depressed center, irregular sloped walls,
raised displaced-soil rim, exposed material, limited secondary debris, ground shadows and optional
water pooling. Use smooth, deterministic irregularity; avoid identical perfect circles.

### 5.2 Impact categories

| Authorized impact class | Expected appearance |
| --- | --- |
| Small explosive | Small disturbance or shallow impact. |
| Mortar | Compact crater with limited displaced earth. |
| Artillery shell | Deeper crater, raised rim and broader disturbance. |
| Heavy bomb | Large depression and damaged surroundings. |
| Guided ground missile | Localized blast/debris matched to warhead. |
| Strategic strike | Exceptional, separate large-scale devastation recipe. |

Size and crater creation follow the authoritative impact type and gameplay rules. Rifles and
airburst-only anti-aircraft weapons never create ground craters.

### 5.3 Accumulation and consistency

For a recorded new impact, find nearby persistent shapes, add local deformation, blend overlapping
depressions and the material mask, rebuild only affected terrain and debris, and reconstruct the
same result on save/reload. Heavy overlap may become a shared basin rather than intersecting
independent meshes. Small/medium visual depressions use existing server crater cover and movement
rules. Large additional changes to elevation, cover or passability require explicit server
authority; visual geometry alone cannot silently make a hex impassable.

## 6. Continuous no man's land

- Detect connected components of neighboring authorized damaged hexes. For each region track
  footprint, intensity, crater distribution, original vegetation/terrain, road and infrastructure
  intersections, building damage, active/abandoned status and persistent historical scars.
- Give regions stable visual identity. Compute an irregular smooth damage-density field from nearby
  affected hexes and authorized impact stamps; use deterministic low-frequency variation and soft
  boundaries to drive materials, vegetation loss, debris, mud, crater LOD and recovery.
- Avoid hexagonal patches, uniformly black circles, repeated zigzags, equally spaced holes,
  unrelated random wire and abrupt grass/devastation boundaries.
- Merge overlapping expanding damaged regions. When the front moves, old damage remains tied to
  terrain coordinates; it does not vanish with the current battle object.

## 7. Terrain-specific warzones

| Original terrain | Initial and sustained damage | Long-term presentation |
| --- | --- | --- |
| Forest | Broken branches, trampled undergrowth, exposed soil; then missing canopy, snapped trunks, fallen timber, roots, craters and burned vegetation. | Regrowth around survivors, weathered trunks and persistent larger craters. |
| Grassland | Flattened grass, tracks and soil; then broad disturbed earth, crater fields, damaged roads and wreck concentrations. | Gradual regrowth and traces of vehicle routes. |
| Mountains | Loose-rock impacts and broken sparse plants; then exposed rock, scree, soil-pocket craters, damaged mountain roads and forts. | Weathered scars consistent with rock and local soil; do not use deep muddy soft-ground craters on solid rock. |
| Desert | Tracks, disturbed sand and dust; then cratered sand/gravel, exposed rock, burned wrecks and windblown debris. | Dry weathering; mud is uncommon without appropriate rain/local conditions. |
| Marsh | Trampled reeds and wet soil; then waterlogged craters, mud, destroyed vegetation and damaged walkways/infrastructure. | Recovery follows wetland state; no invented permanent lakes. |
| Urban | Cracked paving/streets, destroyed walls and roofs, damaged machinery, rubble, wrecks and public spaces. | Reconstruction and individual building/district history; do not paint mud over an intact city. |

## 8. Buildings and infrastructure in battle

- **Buildings:** render real condition as material-specific broken exterior, framing, roof
  collapse, machinery damage, scorch, fencing and local rubble. Preserve type and individual
  selection; a ruined steel mill retains recognizable chimneys/furnace frames, a power plant its
  generator housings, and a refinery damaged pipes/tanks. Do not use one generic ruin for all.
- **Roads:** show condition-dependent cracks, crater damage, broken shoulders, soil/debris,
  wrecks and actual repairs. Do not falsely destroy or repair a functional road.
- **Bridges:** show broken railings, supports/decks, missing spans and crossing debris according to
  server condition. Destroyed spans visibly interrupt the crossing while water continues flowing.
- **Trenches:** keep functional works authoritative and individually damageable; show broken
  parapets, support failure, localized collapses, debris, excavation and actual repair. Continuous
  construction follows the ordered work-front design. Do not automatically add functional trenches
  to all battlefields. Temporary infantry scrapes follow decorative or existing field-position rules.

## 9. Persistent vehicle wrecks and debris

Use recorded wreck type and owner to select recognizable tank, armored car, self-propelled gun,
aircraft or other appropriate remains. Stable variants may include burned/intact, damaged armor,
broken equipment/turret and heavily ruined hull. An authorized destruction can produce a short
explosion, flames, smoke and residual heat; burning ends and smoke dissipates while the wreck
persists until server removal or clearing. Use limited nearby debris and short initial motion before
stable geometry; no permanent rigid-body simulation for each fragment.

## 10. Dynamic movement wear

- **Tracked vehicles:** parallel track compression, flattened vegetation, wet mud deformation or
  dry disturbed dust where terrain and actual movement support them.
- **Wheeled vehicles:** narrow tire marks and disturbed soft soil/mud.
- **Infantry:** aggregate worn paths, flattened vegetation and small disturbance, not thousands of
  individually persistent footprints.
- Use a low-resolution aggregated traffic-wear field; retain only significant persistent wear.
  Short-lived nearby tracks may complement it. Road traffic does not automatically destroy paving.

## 11. Shared weather response

Rain affects soil color/roughness, mud, crater water and smoke; recently cratered ground becomes
wet and prolonged rain may muddy older ground. Snow accumulates only where climate permits, with
exposed recent earth and local displacement from new authorized explosions. Shared regional wind
drives smoke, dust, fire, foliage and cloud shadows. Drying/weathering are gradual and derive from
authoritative weather, not a second independent battlefield weather simulation.

## 12. Recovery and reconstruction

1. **Active fighting:** impacts refresh damage; smoke and destruction are present.
2. **Recently abandoned:** explosions stop, smoke disperses, wrecks cool and fresh soil remains.
3. **Weathering:** server recovery softens craters, wrecks corrode, soil settles and vegetation
   returns where appropriate.
4. **Reconstruction:** real projects and crews repair roads, bridges and buildings; decorative
   cleanup follows the corresponding authoritative repair/removal.
5. **Historical landscape:** old crater outlines, irregular vegetation, remaining ruins and
   weathered works can retain recognizable history without permanently inventing gameplay obstacles.

Do not automatically repair a destroyed bridge or remove a functional trench as vegetation
returns. Visual recovery always follows server battlefield and infrastructure state.

## 13. Gameplay effects and balance

Keep the current server crater/wreck cover and movement model initially: infantry can use limited
cover and generally traverse; wheeled vehicles suffer more in craters, mud and wrecks; tracked
vehicles cope better but slow in extreme damage; aircraft avoid ground penalties; artillery can
damage terrain/fieldworks; engineers can perform actual repairs and clearing. Test one coherent
server movement-cost calculation so terrain, weather, craters and wrecks do not stack into
unreasonable slowdown. Rendering faithfully conveys conditions; it does not add rules.

## 14. Godot rendering architecture

The desired responsibilities may be implemented through existing services if their boundaries are
clear; module names need not be empty wrappers:

| Module | Responsibility |
| --- | --- |
| `WarzoneStateAdapter` | Authorized snapshots and combat events. |
| `WarzoneRegionGraph` | Connected damaged regions. |
| `DamageFieldComposer` | Damage and vegetation-loss fields. |
| `CraterDeformationSystem` | Physical crater geometry. |
| `WarzoneMaterialSystem` | Damage/weather material blending. |
| `VegetationDamageSystem` | Damage, removal and restoration of vegetation. |
| `BattlefieldDebrisSystem` | Persistent debris. |
| `WreckPresentationSystem` | Type-specific persistent wrecks. |
| `InfrastructureDamageAdapter` | Roads, bridges, buildings and trenches. |
| `TrackWearSystem` | Aggregated traffic wear. |
| `WarzoneWeatherAdapter` | Shared regional weather response. |
| `CombatEffectDirector` | Immediate impacts, smoke and destruction. |
| `WarzoneRecoverySystem` | Presentation of actual recovery and rebuilding. |
| `WarzoneLODManager` | Distance-appropriate detail. |
| `WarzoneDiagnostics` | State, geometry and performance inspection. |

Separate base terrain, persistent deformation, surface materials, vegetation, persistent debris and
transient effects. For distant/moderate damage use low-cost shader-driven height/material fields;
for close major craters use locally regenerated `ArrayMesh` chunks or recessed geometry that
intersects terrain correctly. Maintain compact chunk masks for disturbance/scorch/vegetation loss/
deformation; update local affected areas, persist essential authoritative records and reconstruct
presentation deterministically. Do not rebuild the map after each shell.

## 15. Server and save changes

- `server/sim/battlefield.js`: retain existing crater, wreck, smoke and intensity records; add
  bounded significant impact ID, tile, local position, weapon-impact class, severity, stable seed,
  creation time and damage revision where needed. Merge insignificant overlaps into aggregate
  damage. Do not record imaginary craters.
- `server/sim/combat.js`: attach stable local placement to applicable authorized impacts;
  airburst-only effects never damage ground. A crater exists persistently only if recorded by the
  server's gameplay state.
- `server/sim/fieldworks.js`: connect actual health and construction stages to continuous
  terrain/deformation and ordered contiguous construction fronts.
- `server/sim/persist.js`: version the warzone format and migrate old saves; preserve crater,
  wreck, intensity, relevant smoke, functional fieldworks, significant impacts and persistent
  scars without serializing high-resolution decorative meshes.
- Filter snapshots by observer visibility. Remember legitimately observed historical damage,
  but do not send new hidden impacts, enemy movements or combat plans through terrain metadata.

## 16. Event flow

1. The server resolves the projectile impact and determines damage and crater eligibility.
2. It updates intensity and persistent authoritative records, then emits an authorized event.
3. Godot immediately presents the explosion and marks the affected region dirty.
4. Batch local updates to deformation/material fields, vegetation and debris.
5. The scar persists and is deterministically reconstructed after save/reconnect.

Rapid repeated impacts should not delay input or immediate effects; local terrain settles into its
recorded damaged state without a full-world rebuild.

## 17. Performance and LOD

Use sparse state, local/batched damage updates, affected-chunk regeneration, effect pools,
instanced repetitive debris, aggregate distant craters, deterministic regeneration and no
per-soldier persistent footprints. Prioritize gameplay responsiveness.

| Scale | Presentation |
| --- | --- |
| Strategic | Continuous devastation, major wrecks and front-line status; no requirement to draw every crater in 3D. |
| Operational | Crater fields, destroyed vegetation, infrastructure damage and major explosions. |
| Tactical | Visible recessed craters, detailed wrecks, mud, debris and damaged/construction details near the camera. |

Initial goals, subject to representative profiling: 60 FPS standard desktop gameplay; stable
interaction and predictable frame times in large battles; approximately 1–2 ms main-thread
terrain-generation budget per frame; no full-world rebuild for ordinary impacts; bounded particles
and debris. These are goals, not measured guarantees.

## 18. Contextual presentation and UI

Do not add a separate warzone-management tab. Terrain should explain combat visually. Contextual
inspection can show **Cratered Ground — Vehicles slowed · Limited infantry cover**, a damaged
**Reinforced Trench — Repair**, or a type-specific **Destroyed Main Battle Tank — Clear Wreckage**
where those server actions are supported. Put restrained battle-damage information in the
existing Front Lines or Tactical lens only while active; no permanent red heatmap or unsolicited
statistics.

## 19. Visual and gameplay acceptance

- **Artillery:** repeated authorized impacts produce overlapping physical craters and growing
  connected devastation.
- **Infantry:** rifle combat disturbs the ground without invented explosive holes.
- **Forest:** sustained shelling removes/damages trees over time and leaves broken trunks.
- **Weather:** rain darkens soil and affects existing crater water without unsupported penalties.
- **Urban:** damaged industry remains identifiable and buildings individually selectable.
- **Trenches:** continuous excavation; shell damage degrades the actual affected segments.
- **Wrecks:** type-correct remains persist until server-authorized cleanup/removal.
- **Recovery:** smoke clears, ground recovers gradually and functional ruins remain until repaired.
- **Save/reload:** recognizable crater positions, wrecks and damage patterns are restored.
- **World wrap:** one continuous warzone across the east-west seam, without doubled impacts.
- **Fog:** hidden combat cannot leak through effects or unauthorized terrain updates.

Also validate server-authoritative movement/cover, localized invalidation, memory and particle
bounds, performance budgets, old-save migration and authorized protocol behavior.

## 20. Implementation phases

1. Integrate existing battlefield intensity, craters, wrecks, smoke and fieldworks.
2. Build continuous damage material fields and transitions.
3. Implement physical local and overlapping craters.
4. Add terrain-specific vegetation damage and weather response.
5. Integrate infrastructure, buildings and district destruction.
6. Add aggregate vehicle/infantry ground wear.
7. Present state-driven weathering, cleanup and reconstruction.
8. Optimize and validate local chunk updates, deterministic identity, fog, persistence and LOD.

Each phase remains open until its implementation and acceptance criteria are actually validated.

## 21. Definitive battlefield scenario

Use an actual-server modern battle at a river crossing: green country, bridge/road, industrial
settlement and forested ridge; defenders draw an excavated continuous reinforced trench; arriving
attackers use artillery, progressively damaging trees, trench sections, ground and road; armor
advances and a tank becomes a burning then persistent wreck; infantry uses authorized shell-hole
cover; overlapping impacts form no man's land. Rain darkens soil, fills existing craters and moves
smoke with wind. After retreat, wrecks and damaged trenches persist, the former front is visible,
vegetation gradually returns under server recovery, and engineers repair the actual bridge and
infrastructure. Save/reload and horizontal wrap preserve the recognizable result.

The goal is not simply more visual noise: sustained engagements should visibly transform the
landscape and leave consequences the player can recognize long afterward.
