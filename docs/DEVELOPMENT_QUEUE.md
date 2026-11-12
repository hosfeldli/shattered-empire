# Shattered Empires — development queue

Updated 2026-11-08 (Unity visual pass, research overhaul, road-aware governors). Every item from the 2026-11-08 feedback pass is recorded here. What has been done in detail: [UNITY_PROGRESS.md](UNITY_PROGRESS.md). The full target specification and its gaps: [UNITY_GAP_ANALYSIS.md](UNITY_GAP_ANALYSIS.md). The client is
moving from Godot to Unity ([UNITY_MIGRATION.md](UNITY_MIGRATION.md)), so each item says where
the work lands:

- **server**: the authoritative Node.js simulation. Engine-independent; can be done at any time
  and benefits both clients.
- **unity**: presentation, input, UI or audio. Built in the Unity client during the milestone
  shown. It is not added to the frozen Godot client.
- **ci**: build, packaging and publishing.

Status: `[ ]` queued, `[~]` started (for unity items: a first pass is in the Unity client, still to be checked in play), `[x]` done. Milestones (M0–M8) are defined in the migration
plan. Per the plan, new gameplay systems wait until the M2 performance gate passes. Server-side
corrections to existing rules (balance, placement rules, names) are not new systems and may land
earlier.

Withdrawn: *"Enemy territories are attempting to connect to my settlement with roads"*. The
reporter retracted it in the same message.

## 1. Performance and reliability (the reason for the migration)

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Moving the camera quickly at any zoom causes frame drops | unity | M1–M2 |
| [~] | Placing ~10 buildings quickly causes lag and frame spikes | unity + server | M2, M6 |
| [~] | Lag grows over a 30-minute game and when moving many troops; present earlier too | unity | M2, M5 |
| [~] | Doing anything quickly (essential in an RTS) creates lag | unity | M2–M6 |
| [~] | City buildings take a long time to appear when a city is discovered | unity | M4 |
| [~] | Buildings in cities randomly unrender (**top priority** within cities) | unity | M4 |
| [~] | The view occasionally resets, unrenders everything and rebuilds it | unity + server | M3 |
| [~] | Clicking fast under lag says "can't place" and then places the building anyway: show a pending state and only report a refusal the server actually sent | unity | M6 |

## 2. Multiplayer and publishing

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Steam networking for multiplayer: invite friends. A Steam lobby carries the server's match code; the game traffic stays on the authoritative server (same design as `desktop/steam.cjs`) | unity | M3 |
| [~] | Remove the Electron build from the published downloads | ci | now |
| [~] | CI publishes the newest native build to game.liamhosfeld.com automatically as the official build (Godot until the Unity client passes its release gates, then Unity) | ci | now / M8 |

## 3. Cities and architecture

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Apartment buildings are too small. A house upgraded to an apartment complex should be clearly larger | unity | M4 |
| [~] | The city centre is too small | unity | M4 |
| [~] | A late-game city should be full of skyscrapers, not low Eastern-European blocks | unity | M4 |
| [~] | Every building's design updates to the new era when the civilization enters a new age | unity | M4 |
| [~] | City development should look natural rather than patterned, and integrate with the buildings | unity + server | M4 |
| [x] | Buildings are not road-aware and many do not form districts as intended (governor placement scoring for frontage, district and connectivity) | server + unity | M4 |
| [~] | District membership must not mean each building gets its own little connecting road; streets should vary | unity | M4 |
| [~] | Sidewalks clip in and out of the ground constantly (one shared height sampler) | unity | M4 |
| [~] | Sidewalks, small roads and grass look too uniform and silly | unity | M4 |
| [~] | Remove the grass patches under parks, universities and other buildings; they don't match the ground | unity | M4 |
| [~] | The army base looks bad: redesign the barracks/fort compound | unity | M4 |
| [x] | Cities never expand over water, so you can never build a port: allow coastal growth and port sites | server | any |
| [x] | Housing districts make little sense when only three houses can be placed for most of the game: revisit the house cap or the district design | server | any |
| [x] | Governors automatically upgrade roads | server | any |
| [~] | Remove the civilians who walk around in cities | unity | M4 |
| [~] | Full traffic simulation: cars follow lanes, stop at intersections and take varied routes instead of repeating the same flow | unity | M4 |

## 4. Interface (Halo Wars is the reference for functional design)

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Training UI copies Halo Wars: selecting several production buildings and queueing distributes the configured order across all of them | unity + server | M6 |
| [~] | The training quantity settings do not work | unity | M6 |
| [~] | Queueing many troops makes the UI hard to navigate: compact queue and stacked counts | unity | M6 |
| [~] | Research screen: the Start research button's icon overlaps its label | unity | M6 |
| [~] | Hard to tell what uses each resource, where it goes, and what to focus on. Am I short of power or of people? Show consumers, sinks and the limiting factor | unity + server | M6 |
| [~] | Hard to track power demand: dedicated power balance readout | unity | M6 |
| [~] | Pop-ups for destroyed buildings, discovered resources and first builds are too invasive: route them to a quiet feed | unity | M6 |
| [~] | Show the tile type only while Alt is held | unity | M6 |
| [~] | The tutorial is very short and never says where to click: a longer, step-by-step tutorial with on-screen pointers | unity | M6 |
| [x] | Better civilization and town names that fit the setting | server | any |

## 5. Research

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [x] | Research must not need resources to continue: remove the goods wait | server | any |
| [x] | Overhaul the research tree to suit the current design (native ruleset; retired systems removed) | server + unity | any / M6 |

## 6. Military

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [x] | Field guns are strong direct-fire weapons, not mortars: effective against hard targets and vehicles | server + unity | any / M5 |
| [~] | Planes fly natural paths and do strafing runs instead of stopping to fire | server + unity | M5 |
| [~] | Helicopters keep moving: patrol an area, circle and attack on the move instead of hovering in a group | server + unity | M5 |
| [~] | Tanks and vehicles turn their turret or hull toward the target | unity | M5 |
| [~] | AA fires air bursts into the sky | unity | M5 |
| [~] | Vehicles cross bridges on the deck instead of dropping to the ground beneath | unity | M5 |
| [x] | Engineers are non-combat: they only repair and build, spread naturally to the cities that need them, and at least one stays in each city when possible | server | any |
| [x] | Exploring troops don't explore the map well enough and need more randomness | server | any |
| [x] | A destroyed nuclear power plant explodes at half the size of a nuclear bomb. Nuclear plants produce a great deal of power (no nuclear plant exists yet: add one, or apply this to the fusion plant) | server + unity | any / M7 |
| [~] | Nuclear bomb effect with a dramatic shockwave after the explosion | unity | M7 |
| [~] | Icons: special forces (looks bad), engineer, exo infantry ("eco-troop"), autonomous tank, field gun | unity | M5 |
| [~] | Models: autonomous tank, all drones | unity | M5 |

## 7. Trenches and battlefields

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Smaller trenches that form real networks: blocky WW1 traverses (zig-zag bays) that prevent enfilade fire | unity | M7 |
| [~] | Trenches are dug into the ground, not raised above it | unity | M7 |
| [~] | Trenches integrate with defensive buildings (bunkers, guard posts, forts) | unity | M7 |
| [x] | A trench order still builds when some segments are invalid: skip those segments only | server | any |
| [x] | Trenches cannot be built on roads | server | any |
| [x] | Trenches can be built outside your city and in enemy territory | server | any |
| [~] | No-man's land is more visceral: mud, wire, shell holes, debris, smoke | unity | M7 |

## 8. World, weather and effects

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Mountains and ranges form natural shapes: ridged ranges and massifs rather than blobs | server (worldgen) + unity | any / M4 |
| [~] | Rivers end in lakes or in mountains as small streams, never cut off | server (worldgen) + unity | any / M4 |
| [~] | Remnants of the collapsed world: toppled skyscrapers, ruined neighbourhoods, half-sunken cargo ships | server + unity | M4 |
| [~] | Cloud rendering for full weather systems | unity | M7 |
| [~] | Better rain visuals | unity | M7 |
| [~] | Realistic, believable flames | unity | M7 |

## 9. Audio

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Sound sounds plinky and not spatial: fuller mix, 3D spatial audio with distance attenuation | unity | M7 |
| [~] | Most vehicles and aircraft make no sound | unity | M7 |
| [~] | City ambience near cities; nature ambience when zoomed in on wilderness; water audio near rivers | unity | M7 |

## 10. Intro cinematic

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | The intro is lazy and corny. Make it emotional and impactful: tell the story of the collapse, evoke loss, draw the player in. Super cool and super sad | unity | M7 |

## 11. Visual language pass (2026-11-08, second feedback round)

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Buildings readable at a glance: a colour and silhouette language per kind (warm homes, copper civic roofs, olive military, rust industry, hazard-yellow power, colourful commerce) | unity | M4 |
| [~] | An early-game "recovering" architecture for the Reclamation era: shacks, container homes, tarps, water towers, wind turbines, militia camps, reclaimed old-world shells | unity | M4 |
| [~] | Vehicle and troop colours: faction camouflage schemes with a team tint and ground ring, not a full-body team colour | unity | M5 |
| [~] | Water: brighter depth colours, no distant shimmer, soft shorelines that follow the ground instead of the hex | unity | M4 |
| [~] | Cities less patterned: streets meet at off-centre junctions, wrap round built blocks, no private driveways; varied block layouts | unity | M4 |
| [~] | Full interface pass: design tokens, era pill, active rail, panel close, minimap with camera footprint and click-to-move | unity | M6 |
| [ ] | Streets wrapping every built hex in a fully road-covered district read as a lattice of rings: link fewer edges round dense blocks | unity | M4 |

## 12. Target specification (2026-11-08)

The owner's complete Unity-edition specification is condensed in
[UNITY_GAP_ANALYSIS.md](UNITY_GAP_ANALYSIS.md), which tracks each requirement. Items started against
it, built and tested locally, not yet deployed (see [UNITY_PROGRESS.md](UNITY_PROGRESS.md), section 8):

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | Battle-line drawing: right-drag with a live server preview, F flips facing, Alt advances, Shift queues, release commits | server + unity | M5 |
| [~] | Control groups (Ctrl+1–9 set, 1–9 select, double press jumps), follow selection, attack-move key | unity | M5 |
| [~] | Camera: fixed 60° pitch, Shift fast pan, smooth jumps, Backspace returns to the previous view | unity | M5 |
| [~] | Input: every key registers under the Input System, no game keys while typing, remappable shortcuts | unity | M6 |
| [~] | Minimap becomes an optional Map Lens (the spec has no permanent minimap) | unity | M6 |
| [~] | Historical continuity: buildings keep the era they were built in | server + unity | M4 |
| [~] | Five-stage construction, damage bands, upgrade-level extensions for every building kind | unity | M4 |
| [~] | Alerts by severity with Go buttons, battle result cards, research and build search, accessibility settings, observer controls | unity | M6 |

## 13. Organic cities and the visual design bible (2026-11-09)

Built and tested locally, not deployed (see [UNITY_PROGRESS.md](UNITY_PROGRESS.md), section 9).

| | Item | Where | Milestone |
| --- | --- | --- | --- |
| [~] | District planner: affinity-based districts, stable seeds, parcels, local recomposition | unity | M4 |
| [~] | Street hierarchy, sidewalks, crossings, railways, bridge railings and abutments | unity | M4 |
| [~] | Shared district spaces, parking by district, estates, compounds, campuses, pocket parks | unity | M4 |
| [~] | Distinct models for every building type that shared a generic look | unity | M4 |
| [~] | Eight-beat intro, main menu, New Campaign, Field Guide, loading stages, opening descent | unity | M6–M7 |
| [~] | Speed strip, pause menu, placement ghost, strategic badges, city card summary | unity | M5–M6 |
| [ ] | Vegetation and crop sway, irregular craters, forest damage and recovery | unity | M7 |
| [ ] | Missile launch and targeting workflow, multiplayer lobby screen, construction crews | unity | M6–M7 |
