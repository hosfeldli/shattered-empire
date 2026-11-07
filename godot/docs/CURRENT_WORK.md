# Native living-world and direct-control checkpoint

Baseline: `57c0bb7`. Godot is the only development target; browser/Electron is reference only.
The consolidated outstanding requirements, including the latest visual and warzone briefs, are
tracked in [DEVELOPMENT_BACKLOG.md](DEVELOPMENT_BACKLOG.md). The earlier project acceptance
contract remains in [LWE_REQUIREMENTS.md](LWE_REQUIREMENTS.md).

## Long-game rendering fix and second backlog pass (2026-11-07)

- **Buildings stopped rendering in long games:** every frame whose network work exceeded 0.5 ms
  skipped all building updates, and late games decode large snapshots nearly every frame. Updates
  may now be postponed for at most two frames. Also fixed: a missing-building lookup that could
  abort district refreshes, a scheduler that re-sorted every job per step, refresh work starving
  mesh generation (generation now gets at least 60 % of a backlog-scaled budget), long district
  jobs that restarted on every change (they now finish, then the newest revision runs), and a
  district hand-off that could hide buildings indefinitely (4 s limit). Regression added.
- **Gameplay (native-v4):** garrisons (fort 6, bunker 3, guard post 2 places; defensive troops
  seek free places as cover; card shows occupancy), pause/resume for timed works, idle engineers
  assist upgrade works, threatened artillery falls back within range, veteran promotion notices.
- **World:** animated pumpjacks, boats at ports and fishing grounds, deer in quiet woodland,
  broadleaf trees in open country, thinning forest edges, battle-felled trees with stumps and
  logs, snow settling on roofs and open ground, smouldering heavily damaged buildings, contrails,
  modern port terminal, strategic battle markers, city development areas while building.
- **Audio:** jet passes, helicopter rotor bed, air-raid siren for strikes near own cities.
- **UI:** unit callsigns, unit list in the hover inspector, owner/defence in Alt details,
  city-wide "Repair damaged".

## Immersion, world-building and gameplay pass (2026-11-07)

Local, uncommitted development; not in the published preview or deployed server.

- **Ruleset `native-v4`** (new matches; v3/legacy saves unchanged): timed upgrade and repair
  works (paid up front, level/health arrive over time, engineers within two hexes accelerate,
  fire halts work, cancel refunds half of the unspent cost, works dropped on capture, progress
  and ETA in snapshots and on the building card, scaffolding/crane/tarp in the world); indirect-fire
  crews move at 0.82× and have 0.85× durability. The client requests v4 and accepts v3/v4.
- **Last-seen structures:** each human viewer keeps a bounded (4,000), saved, frozen record of
  foreign buildings; out of sight they are sent as quiet memory (`mem`, `ls`), corrected only
  when the hex is seen again. Tooltip and card show "as last seen".
- **After-action battle reports** ("Battle of <city>") with losses, duration and verdict, in
  notices and the chronicle; battles and their pending events are now saved, so restored matches
  report identically.
- **Fog of war** is a lit, drifting procedural cloud sea over unknown land (billowing edges that
  only spill into explored ground; backdrop parallax corrected); explored-but-unseen ground has a
  light cool haze. **Territory**: hazy faction-coloured borders with a fine edge line, scaled
  with zoom, from fog-safe last-known ownership (toggle in Settings).
- **Water** reads as water: depth-tinted blue-green palette, sky/cloud reflection, river flow
  streaks, shallow banks, restrained glint. Camera can no longer show the void past the poles.
- **Grounding:** buildings are seated into slopes (≤25 % of relief left as a skirt); corner
  stilts removed. Market rebuilt as a covered hall with container shopfronts; slim pipe racks
  and paved shopping streets replace black girders and stall scatter between districts.
- **Modern catalogue** (`ModernBuildingLibrary`): concrete casemate fort, checkpoint guard post,
  bermed bunker, barracks compound, rebel camp, technical college/university campus, pumpjack,
  airfield (runway/taxiway/hangars/tower), AA battery with radar, lattice comms mast.
- **World life:** wind-swaying three-tier conifers, organic forest canopy at distance, home
  chimney smoke, grazing livestock on visible farms, bird flocks over known countryside (calm
  weather, away from fighting), civilians take shelter in contested districts, sandbag positions
  for fortified troops, storm lightning, rubble heaps instead of ruin plates, old-world ruins,
  fishing-ground buoys and rare derelict car hulks. Soft noise-eroded smoke replaces faceted puffs;
  trenches have occluded walls, a dark floor and duckboards.
- **Audio:** 26 original procedurally synthesized sounds (`tools/synth-audio.mjs`, CC0) and a
  layered soundscape driven only by what the viewer perceives: wind, rain, water, birdsong, town,
  industry, building sites, engines, distant battle; per-weapon fire/impact sounds, thunder,
  order/build/completion cues, era/city fanfare and battle-report drum. Separate Ambience and
  Battle & effects volume buses.
- **Atmosphere at a glance:** local weather and wind direction in the top bar; dust trails
  behind visible vehicles moving over dry, unpaved ground.
- **Readability:** veteran chevrons on troop badges and a veteran line on unit cards, city tier
  labels and capital star, building level on hover, upgrade/repair cost and duration tooltips.

Verification for this pass: server suite 165/165 (with `ADMIT_OFF=1`; without it three
end-to-end tests are refused by the host memory-admission guard), Godot headless suites
render 62, composition 34, LWE 67, development 70, surface 27, water/weather 24, battle 11,
warzone 14; rendered UI validation passed. The load test met its 100 ms budget (one match
p95 ≈ 50 ms on a shared machine). Sounds were checked for level, clipping and loop seams, not
by ear. Remaining backlog items are unchanged unless listed above.

## Persistent warzone work paused

The complete 21-section user brief is now documented in
[PERSISTENT_WARZONE_BRIEF.md](PERSISTENT_WARZONE_BRIEF.md). The user requested documentation only
and development was stopped. The working tree contains unfinished, uncommitted warzone changes:

- `server/sim/battlefield.js` and `server/sim/game.js` contain a first attempt at persistent,
  viewer-specific last-observed crater/wreck/intensity memory. A focused server test run passed
  before subsequent client changes; comprehensive fairness, old-save, reconnect, spectator and
  heavy-battle performance validation remains necessary.
- `WorldState.gd`, `WorldRenderer.gd`, `MilitaryRenderer.gd`, `EnvironmentRenderer.gd` and
  `CombatRenderer.gd` contain an in-progress local crater-height/mesh prototype and invalidation.
  It uses the server's aggregate per-hex crater depth, not weapon-specific impact positions, and
  avoids deformation under roads, buildings, water and functional trenches. It does not satisfy
  the full warzone brief. `godot/tests/warzone_regressions.gd` was added and its initial parse
  error was edited, but **the corrected test was not rerun**. The latest prototype as a whole has
  not been validated with a rendered scene, full test suite, multiplayer or performance run.
- Do not treat prior test counts or the public preview as verification of these later edits. No
  warzone changes were deployed. Resume by reviewing the interrupted prototype, running its tests
  and evaluating performance/fog safety before extending it.

## Latest local gameplay and presentation pass

- Keyboard camera travel eases in and out independently of frame rate. Formation overlays follow
  the camera each frame and use a single wrapped image for both ends. The Orders menu can follow a
  selected unit; manual panning exits follow mode.
- Building placement displays nearby known legal sites. Road and trench previews identify blocked
  segments, and a rejected order keeps its editable plan and explanation. Double-clicking an owned
  building now prioritizes it over troops occupying the same tile; explicit troop badges still
  select units. Deposit pictograms appear during building placement or colonist selection.
- Explore skips unreachable or partial destinations, retrying alternatives within a bounded search.
  Human city automation can build basic productive and research facilities through its
  existing scoring and budgets; it does not automatically undertake major military projects.
  Native AI settlement preferences grow by era rather than immediately seeking four cities.
- New maps move deposits off river hexes without changing the seeded start-selection sequence.
  Forest trees clear road corridors and update when road state changes. Artillery launch effects
  originate from the visible firing unit when the event identifies it. Repeated raised crater discs
  have been replaced with fewer terrain-following marks and the existing continuous scar field.
- An unattended worker stops advancing until a player or observer reconnects, without changing the
  requested simulation speed or manual pause. An attributed CC0 outdoor recording fades in over
  known countryside at close zoom. Alt provides terrain movement and fertility context.

The local rendered UI validation exercised 94 actions and passed 74 checks against source hash
`f5a52e524845aaa7ec14cbef0785329538412111c28d23ee2c544b39c7b96cd1`. The four-match,
12-empire-per-match load test passed its existing 100 ms budget; observed p95 tick times of
26.73–34.91 ms do **not** meet the newly requested 10 ms target.

This is local development and has not been added to the published preview. The extensive remaining
work includes the requested full art and animation catalog, terrain deformation and fluid smoke,
fog-safe last-seen building memory, timed repairs/upgrades and emplacement occupancy, defensive AI,
realistic battle behavior, city and territory outlines, infrastructure design, performance scaling,
and representative late-game performance and cross-platform validation. Previously verified crater
marks did not physically deform terrain; the newer terrain-deformation prototype described above is
unvalidated. Existing building support geometry has not been removed.

## Reference-image interface and world presentation

- The three quick tools form a labelled vertical rail beside compact dark workspace panels;
  stockpiles show their resource icons and measured rates. The minimap remains removed.
- New construction, founding, ruin resettlement, rebel camps and sandbox building sites reject
  river hexes. Existing saved structures are retained. Desert farms may use dry land adjacent
  to a river; placement previews explain the water restriction.
- Civilians use alternating walking poses and more detailed vehicles; motor traffic requires a
  real usable road edge. Gunfire and large impacts create bounded, wind-driven smoke from actual
  events. Smoke-only snapshots and world resets now update the persistent battlefield correctly.
- Sandbox selection waits for the new unit snapshot before displaying its contextual controls.
- The terrain has a baked photographic ground detail. Steel, canvas and bark use baked color, normal
  and roughness maps; compatible surfaces share existing maps. Sources are in
  [material credits](../assets/materials/SOURCES.md).

This is an incremental pass, not a completed visual rebuild: the reference images depict much
more detailed cities, landscapes, assets, animated people and battlefields. Many materials still
need suitable authored textures and art review, and the current smoke is lightweight wind-driven
presentation rather than a full fluid simulation. The vertical slice and performance gates remain
open.

## Current gameplay and clarity work

- Production rate indicators use a 20-second cycle, remain visible for 4.5 seconds, rise more
  slowly and show at most four at once. They still use actual visible, measured output.
- Overhead clouds fade out at close zoom and are faint at wide zoom; cloud shadows remain subtle.
  Atmospheric weather fog no longer veils the world, while fog of war remains enforced.
- District generation gets a time slice even when economic snapshots arrive continuously.
  Terrain changes invalidate local building geometry and construction effects even if their
  semantic relationships remain the same. Footprint-sized supports follow sampled terrain.
- New matches request `native-v3`, with slower movement, production and development. Previous
  matches retain their rulesets. See [tempo notes](TEMPO_V2.md) for rates and limitations.

These fixes do not establish that all large-world rendering, art, performance or gameplay gates
are complete. The production gate remains in effect.

## Requests implemented in this pass

- Neutral fog with inward boundary blending; unknown cells never become revealed through filtering.
- Connected, terrain-following farmland and industrial yards, stable parcel variation and river margins.
- Connected lake components share a water height, blended depth colors and submerged internal edges,
  including terrain chunks and horizontal wrapping. Mountain elevation has stronger continuous relief.
- Attack / Defend / Explore in the compact unit card. Explore can leave a fixed formation after
  current movement. Right-drag previews a frontage and deploys on release; Tab reverses facing.
- Small material pictograms for resources. Troops use separate circular type icons with counts on
  each tile, names on hover and individual selection rings. Camera movement never changes membership;
  anchors update each frame, with stable layout slots while zooming.
- Available-first research navigation, unlock search, era filters, selected prerequisite paths,
  queue controls and explicit unlock/time/eligibility details across all five eras.
- Double-click matching building selection and one batch-upgrade action that retains selection.
- No routine connection/ping or generic order-accepted notices in gameplay. Useful errors remain.
- AI watching replaces player tools/resources with follow, fog, pause and 1×/2×/4×/8× controls.
  The Varied personality choice and older `mixed` saves now resolve to real AI personalities,
  fixing a live saved-match error that had stopped AI research and later decisions.
- Subtle close-view production pictograms with positive measured output rates, bounded to 12
  simultaneous indicators. Rates come from authoritative building output; no invented tick rewards.
- Improved quarry working faces, benches, stone handling and service equipment.
- Trench spoil-bank cross sections, sandbags, timber supports, junction floors and cosmetic access
  to adjacent friendly bunkers, guard posts, forts and AA. These paths add no cover or connectivity.
  Vegetation clears only the active trench corridor; surrounding trees retain their positions.
- More visible pedestrians and bounded carts/cars derived from visible city population/activity.
  A military unit no longer hides all civilians on its tile. Traffic avoids broken/wet road edges.
- City status describes current construction or a real growth constraint instead of stale logs.

## Findings retained for follow-up

The existing local campaign already had automatic development enabled. Its population was at the
current housing limit (85), with the allowed Housing Blocks built. This is an actual growth
constraint, not permission for the client to fabricate new city development. The new status text
explains it and the batch upgrade path makes the relevant action easy to reach.

Art refinement (including quarry and integrated defenses), full ecological/city-history coverage,
all animation/LOD transitions, sustained large-map battle performance and platform/release reviews
remain subject to [RELEASE_GATES.md](RELEASE_GATES.md). This checkpoint does not close those gates.

Verification, source hashes and local package results are recorded in [VERIFICATION.md](VERIFICATION.md).
An explicitly requested opt-in preview has been published; a finished native release remains
subject to the outstanding acceptance gates. See [NATIVE_PREVIEW_RELEASE.md](NATIVE_PREVIEW_RELEASE.md).
