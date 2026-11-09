# Unity edition — target specification and gap analysis

The owner's complete game design and technical specification for the Unity edition, received
2026-11-08, is the target. This document condenses its requirements and records, for each one,
where the Unity client stands. Progress detail is in [UNITY_PROGRESS.md](UNITY_PROGRESS.md).

Legend:

- **Done** — works in the Unity client (not necessarily at final art quality).
- **Partial** — a first version exists, with the stated gaps.
- **Missing** — not started.
- **Server** — the server has it and the Unity client must expose it.

Status reflects commit `6ecd9d3` plus the uncommitted battle-line and camera work (section 8 of the
progress record).

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
| Historical continuity: old buildings keep their era, new ones are built in the new style | **Missing** | **Conflicts with the current implementation**: every building restyles to the current era. Needs a per-building "built in era" (from the server or recorded on first sight). |
| Deterministic parcels and street networks per city seed | Partial | Deterministic from tile and building ids. The server owns roads; the client lays streets within hexes. |
| Visual contracts (nothing implies a route or bridge that isn't real; inactive factories don't animate) | Partial | Streets follow the server's road edges; your own unstaffed buildings do not smoke (staffing is not visible for other nations). Not systematically enforced. |
| All 32 active building types modelled | Partial | Every type renders. Many share generic models (the `Industry` fallback for the steel mill, refinery, munitions, motor works, heavy assembly, electronics, drone works, robotics); unique models remain to be done. |
| Upgrade levels 1–3 change the model | Partial | Homes change by level. Other types do not yet. |
| Five-stage visible construction | Partial | A generic site with scaffold and crane, growing with progress. No stages, crews or stalled state. |
| Damage bands (85/60/35%) and persistent ruins | Partial | Damage tints the model, fires burn, and destruction leaves a ruin record. No per-band geometry. |
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
| Research search; queue a route with prerequisites | Partial | Shift-click queues the route. No search; no highlighting of prerequisites and unlocks on selection. |
| Pacing targets | Not measured | Server tempo `native-v4`; validate in play. |

## Part IV — Military

| Requirement | Status | Notes |
| --- | --- | --- |
| All 23 unit types distinguishable | Partial | Distinct procedural meshes and icons. No rigged models. |
| Infantry animation vocabulary | Missing | Procedural bob and spacing only. |
| Vehicle movement (tracks, suspension, steering) | Partial | Hull and turret facing. No suspension or track motion. |
| LOD from figures to badges to army markers | Partial | Three levels (tactical, operational, strategic markers). No count badges or army-group markers. |
| Camera: WASD, Shift fast pan, middle drag, cursor zoom | Done* | *Shift fast pan is in the uncommitted batch. |
| Camera: follow, jump to cities/armies/alerts, back, double-click centre | Partial* | *Follow, back and double-click centre are in the uncommitted batch. Jump to alert is not done. |
| Selection: click, box, Shift add, double-click same type | Done | |
| Control groups | Partial* | *Uncommitted batch. |
| Behaviours: Defend / Attack / Explore plus Hold, Withdraw, Attack-move | Partial | Stance buttons and keys. The single primary-behaviour display is missing. |
| **Battle-line drawing with preview, facing flip, advancing line, queue** | Partial* | *Uncommitted batch, built on the server planner and a new preview mode. The overlay drawing of the preview remains. |
| Detach and reassign formation members; reinforce a line | Server | `formation` ops exist; no Unity UI. |
| Immediate feedback on every order; refusal reasons | Done | Pending, accepted and refused markers with the server's reason. |
| Combat effects from real server events | Done | Fire, impact, hit, kill, launch and strategic events drive all effects. |
| Muzzle origin per model and figure | Partial | From the unit centre. |
| Persistent battlefield transformation | Partial | Craters, wrecks, scarred ground, trenches. No vegetation destruction or recovery over time. |
| After-action battle report | Missing | |
| Trenches drawn as routes and joined to defences | Done | |
| Air mission cycle; flight presentation | Partial | The server runs the cycle; Unity has the flight model. No airfield ground activity. |
| Strategic missile launch workflow and presentation | Partial | Strategic blast and shockwave. No launch or targeting UI and no silo animation. |

## Part V — AI and automation

| Requirement | Status | Notes |
| --- | --- | --- |
| Layered national AI, campaigns, fog-limited perception | Server | Existing server AI. Measured validation remains. |
| AI observation mode (follow nation, speed, fog toggle, decisions) | Partial | "Watch AI empires" starts a match. No spectator controls in the Unity interface yet. |
| Developer AI overlay | Missing | |
| Production repeat; distribute across selected buildings; shared rally | Partial | Distribution and rally done. The repeat toggle is not exposed. |
| Opportunity Director suggestions | Missing in Unity | |

## Part VI — Interface

| Requirement | Status | Notes |
| --- | --- | --- |
| Map-first; top bar with resources, weather, alerts, settings | Partial | The top bar has resources, power, people and the era. Weather and alert icons are missing. |
| Build, Army, Research as primary; Overview with Cities, Economy, Rivals, Chronicle, Map Lenses | Partial | Rail and Overview tabs exist. **Map Lenses are missing. The minimap should become a lens, not a permanent fixture.** |
| Searchable build palette with model preview | Partial | Grouped palette with costs. No search and no 3D preview at the cursor. |
| Input guarantees | Partial* | Typing guard, remapping storage and Esc are in the uncommitted batch. Enter-to-confirm and the remapping UI are missing. |
| Research card details and a structured-connector graph | Partial | Tooltips carry the details. There are no connectors. |
| City card with tier, workforce, housing, threats, mayor | Partial | |
| Alerts by severity (critical, actionable, info); result cards | Partial | A quiet feed and a critical banner. No actionable notices or result cards. |
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

Based on the specification's priorities and what is already half built:

1. **Finish and verify the uncommitted control batch:**
   - battle-line overlay and Esc cancel;
   - rebinding UI;
   - the minimap becomes a Map Lens;
   - jump to alert.
2. **Historical continuity:** buildings keep the era they were built in. This needs a "built in era" per building.
3. **Construction stages and damage bands** on buildings; after-action battle reports; alerts by severity with result cards.
4. **Interface:**
   - research search and selection highlighting;
   - build palette search with a cursor preview;
   - accessibility settings;
   - observer controls.
5. **Unique models** for the shared industrial fallbacks; upgrade-level variants beyond homes.
6. **Separate benchmark scenes**, and a full live playtest in Unity before promoting it from "preview".
