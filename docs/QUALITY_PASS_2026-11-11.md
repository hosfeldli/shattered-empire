# Unity visual and spatial audio quality pass — 11 November 2026

Status: **visually incomplete / functional prototype**. This is an integrated quality pass;
it is not art approval, a performance certification, or production acceptance.

## Development delivered

- The current [ring-city and economy implementation](RING_CITY_REDESIGN.md) supersedes the
  earlier flexible base system. Eight saved irregular parcels unlock 4 / 6 / 8 by local HQ tier.
  Global technology and faction-wide capacity remain independent of the number of cities.
  Materials and Energy replace Supplies and Power. Ground pickups grant Materials; abandoned
  energy plants are capturable Energy producers. Roads remain buildable and generated between cities.
- Normal openings have an operational headquarters, four empty sites, 500 Materials, 100 Energy,
  infantry, a scout and an engineer. Nine facility choices and the full active unit roster use
  revised prices and timings. Field defenses and trenches require no engineer selection.
  Engineers automatically repair vehicles, buildings and defenses and assist construction outside
  combat, with a defensive pistol and bounded task recovery.
- Ring selection uses world positions and stable parcel IDs, including multiple facilities in a
  coarse terrain cell. Eight-site controls distinguish empty, occupied and locked lots. Hovered
  building choices preview at the chosen parcel; affordability updates as resources change.
  Field placement ghosts use server validation. Client capability `ring-cities-v1` and save schema 5
  establish an explicit compatibility boundary.
- The ring district replaces scattered civilian infill and per-building road loops. Shared roads
  use continuous curve tangents and terrain-draped verges, with service entrances, connected
  pavements and modest outer street fronts. Upgrade-driven accessory restoration lasts about
  35 seconds. Recorded maturity pauses when HQ is lost; recapture preserves the layout and
  earlier restoration. Destroyed ring facilities retain type-specific industrial, utility,
  airfield or research remnants.
- Distinct action-RTS designs for Vehicle Works, generator stations, Airfields, Armories,
  Defense Works, Advanced Systems Labs and strategic missile facilities. These add to the
  rebuilt headquarters, barracks and supply-center designs from the preceding pass.
  Assembly bays, shutters, offices, roof plant, transformers, service yards, hangars,
  protected magazines and communications equipment give facilities different silhouettes.
- Parabolic dish geometry, mechanical roof fans and yaw-correct service activity.
  Buildings use saved parcels and stable construction datums; rebuilt facilities retain
  their scale rather than inheriting a legacy hex parcel shrink factor.
- Wider graded roads fit the vehicles better. Shoulders and sidewalks remain terrain-draped;
  pavement joints and modest gravel margins add detail without disconnected decorative plates.
- Vegetation palettes are quieter and autumn variation belongs to groves. Wind drives foliage
  and flags using the same environmental direction and gust strength.
- Infantry stride phase follows actual travel, with two-bone leg posing and ground-adjusted
  feet. Equipment now includes additional face, headset, chinstrap, boot and recovery details.
  Crew use articulated figures. These are procedural articulated meshes, **not an imported
  authored animation library or human motion capture**.
- Tank treads follow a flat-bottom capsule path, wheels respond to ground height and steering,
  hull attitude is smoothed, weapons recoil, and helicopters have driven main and tail rotors.
  Extra hull fittings, welded joints, tools, mirrors and handles improve engineering scale.
- Terrain-following blast fronts replace the larger floating ring effects. Irregular elliptical
  craters have angular variation and overlapping rims flatten inside newer depressions.
  Splintered trees, fallen branches and torn vehicle/airframe wrecks preserve material identity.
  Smoke receives wind drift and a softer, corrected lighting treatment.
- Contextual capture, reconstruction, training and force-condition meters. The default army card
  shows relevant orders and abilities; details and air missions open on demand. HQ selection
  reveals eight compact site controls; choosing a site replaces these with available facilities.
  Placement tools show their own focused instructions instead of the whole selection catalogue.
  The compact action rail, quieter objective labels and reduced alert feed leave more of the map clear.
- Intro shots share a closer, continuous city framing. Districts have connected streets on dry
  ground, military facilities use the new designs, convoys receive continuous motion records,
  incoming missiles travel before detonation, and a red warning beacon replaces muzzle flashes.
  Film grain is reduced. The menu now stages the actual headquarters ring and military units in
  warm low-angle light with cool ambient fill, restrained haze and a clearer navigation panel.
  The old-world cinematic uses modern mid-rise blocks; their saved footprints survive destruction
  and regrowth. Legacy factory upgrade props are excluded from those blocks. Sky clouds and their
  ground shadows replace the oversized atmospheric cloud billboards. Transient blast particles
  clear before the long-winter time jump.
- Decorative civilians, pedestrian activity, parked civilian cars, ambient traffic, miniature
  service vehicles and construction-worker figures have been removed. Flags, cranes, machinery,
  vegetation and military units retain animation. No traffic manager is created at runtime.
- A `stronghold` combat sandbox setup develops captured sites with the actual server facilities
  and equipment so the complete design can be viewed with terrain, roads and armies.

## Recorded spatial audio

27 selected edited assets, **6,371,791 bytes** of source Ogg files, replace runtime
procedural combat, engine, ambience and music synthesis. Sources include real firearm and
environmental recordings, designed heavy engine/explosion effects, and two music tracks.
There is no bulk sound-library import into Assets.

[Source, author, license and edit inventory](../unity/Assets/ShatteredEmpires/Runtime/Resources/Audio/SOURCES.md).
[Reproducible editing script](../tools/prepare-unity-audio.cjs).

Weapons and vehicles remain world emitters. Water and industry are localized to known river
and operational facility positions; broad wind, rain and forest beds retain environmental stereo
width. A camera-focus listener avoids treating the RTS camera altitude as the ear's height.
Distance filtering, voice priority, limited simultaneous effects, bus headroom and restrained
pitch variation keep large engagements clearer. Music is quieter and crossfades with battle heat.
Credits are available in Field Guide and Settings. Audio has **not received a human listening
and mixing approval**. Edited aircraft/engine sources do not claim to record particular military models.

## Visual review and build

Major development was performed before the build/review phase. This phase runs native Unity
captures only, with no functional, load, AI, networking or soak test suite.

The review capture path now includes the actual UI Toolkit panel rendered to a texture and
composited with the URP scene. It also captures all eight running cinematic beats and the menu.
This avoids presenting isolated models or scene-only screenshots as UI approval.

Unity 6000.3.28f1 produced a **132 MB Windows player build with zero errors**. Completed
build logs are under `.scratch/action-rts/unity-build-ring*.log`; the integrated delivery build
reported 18 seconds. Build time is not a runtime performance result. A final camera correction
is documented below with its recapture.

Actual 1920 × 1080 High captures include an ordinary Tier I opening, a developed `stronghold`
sandbox with combined arms, and all eight running intro beats plus the live menu. The ordinary
opening contains 14 images, the developed review 23 images, and the cinematic review 18 images.
These are actual Unity renders, including the live UI Toolkit HUD. No asset approval is inferred.

Representative evidence:

- [Tier I construction controls](../.scratch/action-rts/review-ring-foothold/02b_ring_construction_hud.png).
- [Developed headquarters district](../.scratch/action-rts/review-ring-delivery/02_base_operational_hud.png).
- [Headquarters architecture and shared streets](../.scratch/action-rts/review-ring-delivery/01b_headquarters_architecture.png).
- [Tighter military cinematic composition](../.scratch/action-rts/review-intro-final/intro_6_captions.png).
- [Menu typography and navigation](../.scratch/action-rts/review-intro-final/menu_interface.png).

The review exposed repeated sidewalk wedges, overly bright selection rings, blank HQ rear walls,
wrapped facility labels, excessive empty framing in the military shot, and overflowing menu title
text. Follow-up changes introduced shared curve tangents, separate road verges, thin nonemissive
building corners, full HQ facades, clipped single-line site labels, a closer shot and a wrapped
menu title. Earlier captures remain evidence of those defects and should not be used as approved
references. The final recapture also covers the service-entrance and history refinements.

One ordinary-match review exposed camera drift outside the visible world: the opening descent
could re-enable user input after the review took camera ownership. The review now waits until
the descent completes and suspends manual camera/orders only while capturing. Normal bounded
maps also clamp horizontal camera focus. The invalid `review-ring-foothold-delivery` images are
retained as failure evidence and are not reference images. Review runs now preserve saved
connection preferences and the player's Continue session.

Source ground albedo and normal maps now include CC0 ambientCG Grass001, with provenance in
[texture sources](../unity/Assets/ShatteredEmpires/Runtime/Resources/Textures/SOURCES.md).
The earlier tangled grass treatment no longer drives the grass material. Ring facilities have
stable seeded variation; building previews use the same parcel identity as completed buildings.

## Runtime performance and functional verification

No new functional, AI, balance, multiplayer, rejoin, stress or soak suite was run during this
visual-only phase. Prior action-v1 test results do not validate action-v2. Current FPS, CPU/GPU
timing, frame pacing, command latency and long-session memory are **not measured** here. Screenshot
readbacks and concurrent review players make these runs unsuitable as performance benchmarks.
The server nevertheless logged slow-tick warnings during concurrent captures: roughly 50–61 ms
average tick work, peaks up to 512 ms, and navigation p95 reaching 67 ms in the developed scenario.
These observations are an unresolved performance concern, not a reference-hardware benchmark or
a passing performance gate. The Windows player also logged a D3D12 diagnostic-interface probe
failure before using D3D11; scene capture completed and no managed gameplay exception was logged.

## Remaining defects and priority

1. The redesigned intro and menu remain below the final art standard. Modern facades, distant
   terrain, skyline variety and destruction effects still need further authored asset work.
2. Lake outlines and river/lake outlets still show coarse or pointed transitions in some shots.
   The water and terrain pass is visually incomplete.
3. Airfield strips need credible ring-edge runway extension. Some facades, service fittings,
   ruin recipes and accessories still look repetitive or too simple at close range.
4. Accessory restoration is quantized into procedural construction stages; final authored
   animation, foliage detail and asset LOD review remain outstanding. Infantry motion is an
   articulated prototype and has no human animation approval.
5. The new ring economy, placement clearances, cache fairness, AI priorities and automatic repair
   arbitration need later functional and balance validation. Save/rejoin, old-client rejection
   and larger team modes need verification against the revised schema and capability.
6. The current pass has no measured hardware performance, macOS runtime acceptance, human audio
   mix approval, fun playtesting or production packaging acceptance.

## Outstanding acceptance

- Human art and animation review at all camera scales, including damaged and rebuilt states.
- Human listening review, weapon/engine coverage, localized acoustic treatment and final mix.
- Authored rigged human animation, more bespoke asset silhouettes and additional LOD refinement.
- Full hardware profiling, late-game frame pacing, extended sessions and macOS runtime approval.
- Match balance, opponent consistency, fun playtesting and the complete production release gates.

No screenshot or successful build establishes those approvals.

## Contextual HUD, forest and beacon follow-up

The latest Windows build (`unity-build-forest-beacon.log`) completed at **132 MB, zero errors**.
Its reported build work was 179 seconds; this is not a frame-time measurement.

Terrain tree instances previously used positive map Z directly in Unity transforms. Terrain
geometry uses negative Z, so the trees were placed outside the rendered map. Tree instances now
use the shared `MapSpace` conversion, mature trees have the correct larger scale, and chunk
culling includes canopy height and wind motion. Existing road, building and urban exclusions
remain active. The actual opening now visibly contains broadleaf and conifer trees.

The silo beacon no longer emits an additive flare on every rendered frame. It uses a smaller,
dim red lens effect with a fixed emission rate and two slow pulses during the warning shot.
The review captures the shot near the pulse peak. It does not change scene exposure or add a
large area light. Battle summaries now open from a compact Report notice instead of automatically
covering the active selection; changing selection closes a report already on screen.

Latest actual Unity evidence:

- [Visible trees and contextual HQ controls](../.scratch/action-rts/review-restored-trees/02_base_operational_hud.png).
- [Compact army commands](../.scratch/action-rts/review-restored-trees/05_combined_arms_hud.png).
- [Developed ring controls](../.scratch/action-rts/review-preview-stronghold/02_base_operational_hud.png).
- [Silo warning shot with reduced beacon](../.scratch/action-rts/review-dimmed-beacon-trees/intro_7_captions.png).
- [Headquarters menu with woodland](../.scratch/action-rts/review-dimmed-beacon-trees/menu_interface.png).

These are visual checks of the native player. No manual functional or load suite was run during
this follow-up. Deployment uses the repository's existing automated checks separately; their
results must be recorded before claiming they pass. No macOS, hardware-performance or final
production acceptance is inferred from these captures.
