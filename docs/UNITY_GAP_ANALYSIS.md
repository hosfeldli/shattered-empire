# Unity edition — target specification and gap analysis

The owner's complete game design and technical specification for the Unity edition, received
2026-11-08, is the target. This document condenses its requirements and records, for each one,
where the Unity client stands. Progress detail is in [UNITY_PROGRESS.md](UNITY_PROGRESS.md).

Legend:

- **Done** — works in the Unity client (not necessarily at final art quality).
- **Partial** — a first version exists, with the stated gaps.
- **Missing** — not started.
- **Server** — the server has it and the Unity client must expose it.

Status reflects commit `6ecd9d3` plus the target-specification batch (section 8 of the progress
record). **Done (local)** means built and tested locally but not yet deployed.

## Decisions the specification fixes

- The Node.js server stays authoritative. Unity replaces the presentation client only.
- The streamlined native rules stay:
  - no trading, taxation, treaty management or deep government controls;
  - no rebel civilisations in new matches;
  - no manual supply trucks.
- Daylight stays constant; there is no day/night cycle for now.
- The camera keeps a fixed 60° pitch, orthographic or a restrained perspective.
- **There is no permanent minimap.** The Overview menu carries Cities, Economy, Rivals, Chronicle and Map Lenses.
- Five eras, all 23 unit types and the 32 active building types are kept. The supply depot is legacy-only; the rebel camp is not built in new matches.
- Every system has three layers: authoritative simulation, world presentation and player interaction. Cosmetics never change gameplay.
- Do not publish the Unity build as the official release until it passes the acceptance suite.

## Part I — World

| Requirement | Status | Notes |
| --- | --- | --- |
| Continuous 3D surface over the hex grid; hexes not visible as tiles | Partial | Sector-triangulated terrain with blended heights. Some hex patterning remains (per-hex fog edges, street rings in dense districts). |
| Four world types (continents, Pangaea, archipelago, inland sea) | Server | Server worldgen. The Unity menu does not yet offer world-type choice. |
| Natural mountain ranges and drainage | Partial | Ridged relief client-side; headwater streams flagged. Server worldgen unchanged (seeded tests depend on it). |
| Seamless east–west wrap for camera, rendering, fog, paths and effects | Done | One nearest-image calculation everywhere; tested in the stress camera tour. |
| Terrain types (plains, forest, mountains, hills, desert, wetland, snow, urban, damaged) | Partial | Biome colouring, trees, urban paving and battle damage. No snow accumulation, reeds or dust. Not yet physically based materials. |
| Water: rivers, lakes, coast, reflections, wind ripples, rain, foam | Partial | Shoreline-following depth alpha, distance-faded detail, rain rings, foam. No boat wakes; no near-camera ripple field. |
| Damaged bridges visibly unusable | Partial | Broken road edges drawn with gaps. Bridge collapse not modelled separately. |
| Weather: clouds, cloud shadows, rain, storms, thunder, wind | Done | From the server weather grid. |
| Snow, fog and mist, wet/dry ground | Partial | Wet ground done. No snowfall or ground mist. |
| Vegetation sways; wildlife; birds | Missing | Trees are static. Birds exist only as an ambient sound. |

## Part II — Cities and civilisation

| Requirement | Status | Notes |
| --- | --- | --- |
| Cities read as settlements with history, districts and streets | Partial | Street geometry, infill, parks, plazas and the per-kind colour language. No parcel planner or district recipes yet. |
| Four settlement tiers with distinct looks | Partial | The town centre skyline grows with era and tier. No explicit tier-specific layouts. |
| Historical continuity: old buildings keep their era, new ones are built in the new style | Done (local) | **Conflicts with the current implementation**: every building restyles to the current era. Needs a per-building "built in era" (from the server or recorded on first sight). |
| Deterministic parcels and street networks per city seed | Partial | Deterministic from tile and building ids. The server owns roads; the client lays streets within hexes. |
| Visual contracts (nothing implies a route or bridge that isn't real; inactive factories don't animate) | Partial | Streets follow the server's road edges; your own unstaffed buildings do not smoke (staffing is not visible for other nations). Not systematically enforced. |
| All 32 active building types modelled | Partial | Every type renders. Many share generic models (the `Industry` fallback for the steel mill, refinery, munitions, motor works, heavy assembly, electronics, drone works, robotics); unique models remain to be done. |
| Upgrade levels 1–3 change the model | Done (local) | Every kind gains annexes, storage or reinforcement. |
| Five-stage visible construction | Done (local) | Five stages and a dormant look when waiting. No work crews yet. |
| Damage bands (85/60/35%) and persistent ruins | Done (local) | Per-band scorch, rubble and broken walls; ruins persist. Not yet material-specific (glass, steel, masonry). |
| Visible civilians and vehicles | Partial | Traffic simulation done. Pedestrians were removed at the owner's request (2026-11-08); the spec asks for sidewalk pedestrians, which needs reconciling. |
| City reactions (prosperity, shortage, war, reconstruction) | Missing | |

## Part III — Economy and progression

| Requirement | Status | Notes |
| --- | --- | --- |
| Every resource explained in one click | Partial | Top-bar tooltip: stock, net, categories, producers, consumers, blockers, actions. No detailed economy panel or history graph. |
| Workforce priorities, staffing locks | Server | Not exposed in Unity. |
| Guide Growth and mayors | Done | On the city card. |
| Construction visibility (ETA, committed and missing resources, why paused) | Partial | The building card shows state and works. The construction queue is not surfaced. |
| Five eras, connected research graph | Done | Research overhaul: Nuclear Fission added; Fusion follows. |
| Research search; queue a route with prerequisites | Done (local) | Shift-click queues the route. No search; no highlighting of prerequisites and unlocks on selection. |
| Pacing targets | Not measured | Server tempo `native-v4`; validate in play. |

## Part IV — Military

| Requirement | Status | Notes |
| --- | --- | --- |
| All 23 unit types distinguishable | Partial | Distinct procedural meshes and icons. No rigged models. |
| Infantry animation vocabulary | Missing | Procedural bob and spacing only. |
| Vehicle movement (tracks, suspension, steering) | Partial | Hull and turret facing. No suspension or track motion. |
| LOD from figures to badges to army markers | Partial | Three levels (tactical, operational, strategic markers). No count badges or army-group markers. |
| Camera: WASD, Shift fast pan, middle drag, cursor zoom | Done | |
| Camera: follow, jump to cities/armies/alerts, back, double-click centre | Done (local) | Space jumps to the latest alert; Go buttons on cities, armies, notices and the chronicle. |
| Selection: click, box, Shift add, double-click same type | Done | |
| Control groups | Done (local) | |
| Behaviours: Defend / Attack / Explore plus Hold, Withdraw, Attack-move | Partial | Stance buttons and keys. The single primary-behaviour display is missing. |
| **Battle-line drawing with preview, facing flip, advancing line, queue** | Done (local) | *Uncommitted batch, built on the server planner and a new preview mode. The overlay drawing of the preview remains. |
| Detach and reassign formation members; reinforce a line | Server | `formation` ops exist; no Unity UI. |
| Immediate feedback on every order; refusal reasons | Done | Pending, accepted and refused markers with the server's reason. |
| Combat effects from real server events | Done | Fire, impact, hit, kill, launch and strategic events drive all effects. |
| Muzzle origin per model and figure | Partial | From the unit centre. |
| Persistent battlefield transformation | Partial | Craters, wrecks, scarred ground, trenches. No vegetation destruction or recovery over time. |
| After-action battle report | Done (local) | The server's report shown as a result card. |
| Trenches drawn as routes and joined to defences | Done | |
| Air mission cycle; flight presentation | Partial | The server runs the cycle; Unity has the flight model. No airfield ground activity. |
| Strategic missile launch workflow and presentation | Partial | Strategic blast and shockwave. No launch or targeting UI and no silo animation. |

## Part V — AI and automation

| Requirement | Status | Notes |
| --- | --- | --- |
| Layered national AI, campaigns, fog-limited perception | Server | Existing server AI. Measured validation remains. |
| AI observation mode (follow nation, speed, fog toggle, decisions) | Done (local) | "Watch AI empires" starts a match. No spectator controls in the Unity interface yet. |
| Developer AI overlay | Missing | |
| Production repeat; distribute across selected buildings; shared rally | Partial | Distribution and rally done. The repeat toggle is not exposed. |
| Opportunity Director suggestions | Missing in Unity | |

## Part VI — Interface

| Requirement | Status | Notes |
| --- | --- | --- |
| Map-first; top bar with resources, weather, alerts, settings | Partial | The top bar has resources, power, people and the era. Weather and alert icons are missing. |
| Build, Army, Research as primary; Overview with Cities, Economy, Rivals, Chronicle, Map Lenses | Done (local) | Map Lenses tab; the minimap is a lens, off by default. More lenses (resources, supply, threat) remain. |
| Searchable build palette with model preview | Partial | Search done (local). No 3D preview at the cursor yet. |
| Input guarantees | Done (local) | Typing guard, remappable shortcuts with a settings UI, Esc cancels the innermost action, presses never repeat. Enter-to-confirm is not wired to specific dialogs yet. |
| Research card details and a structured-connector graph | Partial | Tooltips carry the details. There are no connectors. |
| City card with tier, workforce, housing, threats, mayor | Partial | |
| Alerts by severity (critical, actionable, info); result cards | Done (local) | A quiet feed and a critical banner. No actionable notices or result cards. |
| Main menu: Continue, New Campaign, Multiplayer, Watch AI, Sandbox, Tutorial, Settings | Partial | Equivalent entries with different labels. No world-generation options. |
| Opening cinematic descending to the capital | Partial | The intro cinematic exists. No descent into the actual start. |
| Tutorial as a quiet real match | Partial | 10 coached steps in a normal match. |
| Accessibility: UI scale, colour-blind markers, reduced motion, shake toggle, volumes, presets | Partial | Quality presets and volumes. The others are missing. |

## Part VII — Audio

| Requirement | Status | Notes |
| --- | --- | --- |
| Spatial, prioritised, aggregated combat sound | Partial | 32 prioritised voices with distance attenuation. No explicit aggregation layers. |
| Vehicles, aircraft, industry, city, nature, weather | Partial | Engines, beds and weather done. Industry loops are missing. |
| Adaptive music | Partial | One requiem track. Not state-driven. |

## Part VIII — Engine architecture and performance

| Requirement | Status | Notes |
| --- | --- | --- |
| Unity 6 LTS, URP, C#, UI Toolkit, existing WebSocket protocol | Done | |
| Mass rendering through instancing; no per-unit GameObjects | Done | |
| Event-driven or bounded rebuilds; incremental district updates | Done | Cell-level dirtying; bounded cells per frame. |
| LOD with hysteresis and crossfade | Missing | Hard thresholds. |
| Effects budgets by visibility, distance and importance | Partial | Particle budget, distance culling and intensity setting. |
| Benchmark scenes (empty world, city, megacity, 100/500/1,000/2,000 battles, 256² world, zoom, seam, save/rejoin, two hours) | Partial | One combined stress tour and the live 1,000-unit sandbox. The separate scenes are missing. |
| Release targets: 60 fps, p99 < 25 ms, no recurring 50 ms stalls | Met in the stress scene | Must be shown in live play. |

## Part IX — Multiplayer and modes

| Requirement | Status | Notes |
| --- | --- | --- |
| Lobbies, invites, reconnect, spectators | Partial | Steam invites, join codes, rejoin with world kept. No lobby UI for nations and rules. |
| Modes: campaign, multiplayer, Watch AI, sandbox, tutorial | Partial | All start; menus are basic. |
| Challenge scenarios, replay viewer | Missing | Expansion targets per the spec. |

## Suggested order of work

The first batch of this list (controls, battle lines, historical continuity, construction stages,
damage bands, alerts, search, settings and observer controls) is built and tested locally. Next:

1. **Deploy and playtest the batch.** The live server needs the deploy preview and building eras;
   then a person should play a full match in the Unity client and report how battle lines, control
   groups and the new panels feel.
2. **Street rings in dense districts:** link fewer edges round blocks where every hex is road-covered.
3. **Build placement preview:** the proposed 3D model at the cursor, matching the generated building.
4. **Unique models** for the industrial types that share the generic fallback (steel mill, refinery,
   munitions, motor works, heavy assembly, electronics, drone works, robotics), and work crews on
   construction sites.
5. **More Map Lenses:** resources, supply and threat. A workforce and staffing panel.
6. **Separate benchmark scenes** (city, megacity, 100/500/1,000/2,000 battles, seam crossing,
   save/rejoin, two-hour session) before promoting Unity from "preview".
## Organic city generation and the visual design bible (received 2026-11-09)

Two further owner documents refine Part II (cities) and every visual area. Status after the 2026-11-09 round (detail in [UNITY_PROGRESS.md](UNITY_PROGRESS.md), section 9):

| Requirement | Status |
| --- | --- |
| Hierarchical generation: city → district → street → parcel → building → details; persistent seeds | Done (local): district planner, stable hashes, parcel placement |
| District formation by affinity (function, connection, proximity, history, barriers) | Done (local) |
| Street hierarchy (primary, secondary, local, service), continuous sidewalks, crossings | Done (local) |
| Shared district spaces (industrial yards and fences, compounds, estates, campuses, commercial lanes) | Done (local) |
| Parking by district, stable parked cars, driveways not on every house | Done (local) |
| Pocket parks from leftover parcels, plazas beside civic buildings, none in young settlements | Done (local) |
| Historical layers in infill; stable growth (no re-rolls) | Done (local) |
| Repetition control | Partial: district vocabulary with parcel variance; no explicit similarity penalty yet |
| Hex skeleton invisible at the street level | Partial: much reduced; visible in fully road-covered districts |
| Eight-beat intro cinematic with the bible's captions | Done (local) |
| Main menu, New Campaign, Multiplayer page, Field Guide, loading stages, opening descent | Done (local) |
| Speed strip, pause menu, Esc order | Done (local) |
| Placement ghost and cursor card | Done (local) |
| Strategic badges by role shape with counts; battle-line amber and facing | Done (local) |
| City card summary | Done (local) |
| Distinct models for all 32 active buildings | Done (local) for all types that shared a fallback; quality is procedural, not final art |
| Vegetation and crop sway, irregular craters, forest damage, recovery | Missing |
| Missile launch workflow, multiplayer lobby screen, construction crews, rigged infantry | Missing |
