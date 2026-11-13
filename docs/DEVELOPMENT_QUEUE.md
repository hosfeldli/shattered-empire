# Development queue

- **Type:** Prioritized backlog
- **Updated:** 2026-11-13
- **Scope:** Unity edition / `action-v2`
- **Status source:** [Current status](UNITY_PROGRESS.md)

## Working rules

The [current design](GAME_DESIGN.md) is authoritative. This queue covers remaining work;
source presence or an old checkbox does not establish completion. Use the
[shared status vocabulary](VERIFICATION.md#status-vocabulary).

Complete a substantial development batch before visual review. Manual checks remain visual-only
during this iteration; required CI/release gates still apply. Preserve the user's sessions and
unrelated working-tree changes. Keep the documentation review commit separate from implementation.

## P0 — Rendering and connected terrain

| ID | Work | Acceptance |
| --- | --- | --- |
| RENDER-01 | Remove foliage/menu/cinematic glare | No giant white or invalid-HDR orbs through normal full-camera post-processing at all relevant zooms; inspect silo and effects separately |
| ROAD-01 | Join intercity and city road networks | Entrances share actual route portals, width, material and tangent; city loop/frontages meet at clean junctions without disconnected stubs or cross-road curbs |
| BRIDGE-01 | Keep roads above river water | Continuous supported deck, graded banks, correct broken state and matching vehicle/infantry support height |
| CITY-01 | Put cities on plains | Every eight-site footprint fits dry level authoritative ground; apron blends into terrain; existing saves are not silently relocated |

Latest road and bridge source changes are prototypes awaiting compilation and actual seeded
visual review. The earlier glare captures do not validate the new road code.

## P1 — Control and contextual usability

| ID | Work | Acceptance |
| --- | --- | --- |
| MOVE-01 | Remove rubber-band vehicle turning | Accelerate/brake/steer with hull motion; no sideways snapping, constant oscillation or destination overlap |
| INF-01 | Remove rigid squad pivots | Each soldier walks/turns into position independently, including formation turns, combat spreading, stops and LOD transitions |
| CAMERA-01 | Stabilize mountain movement/picking | Fixed gameplay pitch, smooth focus height, reliable first terrain intersection on ridges, stable cursor-centered zoom |
| TRENCH-01 | Enter trenches naturally | Eligible troops reach the actual line, occupy its floor and receive matching directional cover; surrounding ground is darker |
| UI-01 | Remove redundant global tabs | No player Army/Objectives tabs or separate global upgrade screen; retain necessary spectator tools |
| UI-02 | Upgrade selected buildings | HQ tier/perimeter actions on selected HQ; research on selected Armory; no hidden fallback to another facility |
| UI-03 | Replace bottom build/defense shortcuts | Select world lots/buildings for relevant actions; retain discoverable field construction without engineer selection |
| UI-04 | Explain every control and failure | Real runtime hover/disabled-state tooltips, visible costs/prerequisites/progress, no silent failed placement |
| UI-05 | Keep menus responsive | All long pages scroll, focus is clear, panels fit small viewports, gameplay feedback stays immediate |
| DISPLAY-01 | Fullscreen startup | Normal boot is fullscreen/borderless; intentional review/windowed behavior remains explicit |

Keep selection, Shift queues, Q/E defense rotation, escape/cancel, typing and camera bindings
consistent. Preserve production/rally/reinforcement capability as redundant navigation is removed.

## P1 — World use, groundcover and encounter pacing

| ID | Work | Acceptance |
| --- | --- | --- |
| MAP-01 | Reduce unused generated land | Objective/road region uses the playable island with useful flanks; preserve all routes/sites and coherent hydrology/coasts |
| GRASS-01 | Make grass very small | Short ankle-height-or-lower groundcover beside soldiers, correctly grounded, visible close-up without spikes or distant noise |
| AI-01 | Delay premature infantry rushes | Early scouts/neutral contests remain active; base attacks gather coherent forces and allow opening decisions |
| COMBAT-01 | Natural local positioning | Units find cover/firing space within bounded intent; Hold and explicit formation constraints remain respected |

Map compaction needs multi-seed/faction-size checks and actual strategic captures later; no
fairness or path-connectivity acceptance is implied by a source edit.

## P2 — Art, atmosphere and readable warfare

| Area | Remaining work |
| --- | --- |
| Buildings and scale | Cohesive HQ/ring recipes, clear entrances, consistent doors/storeys/vehicles/people, distinctive facilities and recognizable damaged states |
| Trees and ground | Smaller leaves, stronger canopy/fir structure, restrained material scale, natural forest edges and shoreline transitions |
| Roads and districts | Shared sidewalks, access yards and clean mixed-use transitions; preserve parcels and historical identity |
| Military | Better soldier equipment and gait; tracks, wheels, suspension, rotors, firing origins, turret/recoil and casualty presentation |
| Battlefield | Irregular depressed/merged craters, dark disturbed soil, forest damage, typed wrecks, 3D wire/obstacles, readable shockwaves/flames |
| Intro/menu | Varied city geography and skyline, coherent global missile attack, emotional collapse/recovery, restrained silo warning and stronger direction |
| Audio | Licensed recordings for guns/tanks/air/explosions/construction; close river/nature ambience, spatial mix, camera zoom and bounded aggregation |

Do not reintroduce civilian actors, small ambient vehicles, housing/workforce management or
resource chains while adding visual richness.

## P2 — Core completion and balance

Complete and validate capture/rebuild/conquest, all facility/unit costs, local/global tier behavior,
shared/repeat production, reinforcement, combat counters/abilities, aircraft servicing and strategic
weapons. Verify free-placement defenses, paid city perimeter, engineer self-defense/automation,
save history and fog filtering.

AI still needs reliable openings, expansion, scouting, combined-arms counters, staging, retreat,
recovery, final assaults, order arbitration and recorded bounded stall recovery. Difficulty should
change competence; numerical help must be disclosed.

Finish tutorial, campaign/skirmish, multiplayer/lobbies, AI observation and configurable sandbox.
Replay/challenge expansion, naval warfare and modding are later work and do not displace core stability.

## P3 — Acceptance and distribution

Obtain human art/audio and fun/balance review. Measure reference-hardware frame pacing,
100/500/1,000-unit battles, 2,000-unit stress, effects/forest/bridge scenes, memory stability,
command latency, save/rejoin, extended multiplayer and two-hour sessions when testing scope permits.

Pass required CI and platform gates. Validate the exact Windows ZIP with native extraction and
public download hashes. Keep public listings Windows-only until macOS separately qualifies.
See [verification](VERIFICATION.md) and [release](RELEASE.md).

The [earlier queue](archive/DEVELOPMENT_QUEUE_BEFORE_2026-11-13.md) is historical; its civilian,
five-era, traffic, minimap and automatic visual-era replacement items are superseded.
