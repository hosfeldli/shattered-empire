# Unity edition — progress record

What has been built, changed, verified and deployed for the Unity client, and what is still open.
Last updated **2026-11-08**. Branch `feature/unity-client` (local, not pushed).

Related documents:

- [UNITY_MIGRATION.md](UNITY_MIGRATION.md) — the migration plan, milestones and the M2 gate decision.
- [DEVELOPMENT_QUEUE.md](DEVELOPMENT_QUEUE.md) — every feedback item and its status.
- [UNITY_GAP_ANALYSIS.md](UNITY_GAP_ANALYSIS.md) — the complete target specification, system by
  system, against what exists today.
- [benchmarks/](benchmarks/) — the recorded performance runs.

## 1. Where things stand

| Area | State |
| --- | --- |
| Engine decision | Unity 6000.3.28f1 (6.3 LTS), URP. M2 performance gate passed; the owner committed to Unity and Godot client development is frozen. |
| Server | Node.js server stays authoritative. Feedback-queue rule changes, the research overhaul and road-aware governors are live. |
| Unity client | Connects to live matches and covers the world, cities, units, effects, weather, audio, interface, intro and stress benchmark. Not yet played end to end by a person in a full match. |
| Live site | game.liamhosfeld.com runs server version `6ecd9d3` (Cloud Run revision `shattered-empires-00017-wnj`). The Unity Windows build is on the download page as the "Unity preview"; Godot remains the official download. |
| Tests | Unity EditMode 6/6, standalone .NET checks 11,383, server 193/195. The two server failures are pre-existing macOS-only updater tests that need `/bin/sh`. |
| Performance | Offline stress scene: 165–241 fps by segment, p99 ≤ 14.2 ms, no frames over 50 ms (section 6). |

## 2. Commit history

| Commit | Summary |
| --- | --- |
| `06cc0dd` | Unity project created; migration plan written; the 2026-11-08 feedback recorded in the development queue. |
| `6042ad4` | Unity client compiles, tests pass and the Windows player builds; first M2 benchmark runs recorded. |
| `7a39e47` | M2 decision recorded: commit to Unity, freeze the Godot client. |
| `b5bc818` | Server rules from the feedback queue (section 4.1). |
| `1450e35` | Headwater-stream geo flag so rivers taper into the hills. |
| `6ecd9d3` | Unity parity pass and visual-language overhaul (section 3), research tree and road-aware governors (section 4.2), key-file protection. **Deployed.** |

Uncommitted work in progress is listed in section 8.

## 3. Unity client — what exists

All code is under `unity/Assets/ShatteredEmpires`.

### 3.1 Foundation (`Core/`, `Net/`)

- **Shared core without Unity dependencies:**
  - Hex grid with east–west wrap and the shared height function (`HexGrid`, `TerrainView`, `WorldModel`).
  - Unit and building stores; protocol decoding of snapshots, deltas, geo and welcome messages.
  - The standalone .NET test project in `unity/Tests.Standalone` checks this core against server fixtures.
- **Networking:**
  - A WebSocket link with off-thread decoding, applied in wire order on the main thread.
  - Request ids and command acknowledgment tracking.
  - Rejoin with session tokens.
  - Capabilities `geo` and `udelta`.
- **Typed world records:** trenches, ruins, battlefield intensity, craters and wrecks, and weather fields (`WorldRecords.cs`).
- **Reconnects:**
  - A rejoin of the same match keeps the world, units, buildings and selection on screen.
  - The server's full re-send then redraws only hexes that actually changed. This addresses "the view resets and rebuilds everything".
- **Stress scenario:**
  - A generated 256×256 world with an urban core, ruins, trench lines, a moving rain band and 1,000 units.
  - A scripted camera tour and a JSON performance report.

### 3.2 World (`Terrain/`, `Landscape/`, `Effects/Atmosphere.cs`)

- **Terrain:**
  - Burst-compiled chunk meshes and one shared height function, used by everything placed on the ground.
  - Ridged mountain relief computed client-side, so server tests that depend on seeded worldgen are unchanged.
  - The ridge noise is cached per hex for main-thread queries, which removed a frame-time regression.
- **Water:**
  - Depth colours and silty rivers.
  - Fine detail (chop, foam texture, sun glint, rain rings) fades with camera distance, so there is no far-zoom shimmer.
  - Lake hexes are subdivided, so the transparent waterline follows the real ground instead of the hex outline.
  - River ribbons have soft banks.
- **Ground field:** a per-hex texture drives:
  - patchy city paving with greenery;
  - no-man's-land mud and shell holes;
  - rain-wet ground;
  - crater density.
- **Atmosphere:**
  - Sky, post-processing (ACES, bloom, colour adjustment, vignette, film grain) and weather easing.
  - Lightning, and cloud puffs that thin out above tactical zoom while cloud shadows carry the weather.
  - Rain particles.

### 3.3 Cities (`Cities/`)

- **Street geometry (`RoadCurve.cs`)**, shared by drawing and traffic:
  - Streets cross each hex edge at its midpoint.
  - Open hexes meet at an off-centre, rounded junction.
  - In built hexes the streets wrap round the block instead of cutting through it.
  - A lone road edge stops at the kerb, with no private driveway.
- **Buildings (`CityRenderer.cs`)** use a colour and silhouette language per kind:

  | Kind | Look |
  | --- | --- |
  | Homes | Warm stucco and terracotta |
  | Civic | Pale stone, copper roofs, domes, clock tower, flags |
  | Military | Olive |
  | Industry | Rust sheet, sawtooth roofs |
  | Power | Hazard yellow, pylons |
  | Commerce | Coloured awnings, lit signs |
  | Extraction | Spoil heaps, yellow plant |
  | Logistics | Owner-coloured doors |

- **Reclamation-era architecture (era 0):**
  - shacks and shipping-container homes under tarps, plus water towers;
  - a reclaimed old-world shell as the town hall;
  - hoop greenhouses, wind turbines and a militia camp;
  - open-sided workshops and container depots.
- **Later eras:** brick and stucco terraces, apartment courtyards, then residential towers with roof gardens. Glass towers are kept for downtown infill. Every building updates when the era changes.
- **Infill and old world:**
  - Developed district hexes without a building get organic infill that keeps clear of the streets, with parks and plazas.
  - Old-world ruins: toppled skyscrapers, dead neighbourhoods, half-sunken cargo ships.
- **Smoke and steam:** chimneys, power stations and the new nuclear plant's cooling towers record their stack positions, and the frame loop emits smoke and steam there.
- **Traffic (`TrafficSystem.cs`):**
  - Cars drive on the right along the street curves and keep their distance.
  - Junctions are held by one car at a time; main roads have priority and side streets stop at the line.
  - Routes go to varied destinations.
  - Traffic only runs near the camera at tactical zoom.
- **Cell dirtying:** road and district changes now dirty only the affected cells. Previously every road change recomposed the whole map, which made cities slow to appear.

### 3.4 Military and battlefield (`Military/`, `Battlefields/`, `Effects/`)

- **Unit renderer:**
  - Instanced, with level of detail by zoom.
  - Infantry squads as several figures; vehicles turn hull or turret toward their last target.
  - Bridge decks; troops sit lower in finished trenches.
- **Paint:** each faction wears a camouflage scheme with a light team tint and a faint team ring on the ground, instead of a full-body team colour.
- **Flight model:**
  - Aircraft chase the server position with limited turn rates.
  - Jets overshoot and bank round for the next strafing pass.
  - Helicopters slow down but keep circling their station.
- **Warzone renderer:**
  - WW1-style trenches with traverses, duckboards and sandbags, joined to bunkers, posts and forts.
  - No-man's-land stumps, wire and debris; battlefield wrecks.
- **Effects:** explosions, air bursts, muzzle flashes, tracers, flames and embers, the strategic blast (half size for a reactor meltdown), craters, wrecks, smoke and steam, rain.

### 3.5 Interface (`UI/`)

- **Top bar:**
  - The era with progress to the next one.
  - Resource chips with tooltips (stock, net, where it goes, producers, users, what to do).
  - Power gauge and power tooltip; people and work.
  - A "short of …" pill.
- **Panels:** a rail (Build, Army, Research, Overview, Settings) with the active panel marked; panels close with a button or Esc.
- **Research tree:** eras by column, colour-coded branches, what each tech unlocks, era progress and queueing.
- **Cards:**
  - Units, with orders.
  - Buildings: Halo Wars-style training across all selected buildings, quantity ×1/×5/×10, stacked queue, right-click cancel.
  - Cities: Guide Growth and the mayor.
- **Alerts and help:**
  - A quiet alert feed and a critical-only banner.
  - A 10-step tutorial with on-screen pointers.
  - Alt-held tile readout.
- **Minimap:** terrain, territory, fog, unit dots, camera footprint, click to move.
  - *Note:* the target spec says no permanent minimap; see section 7.
- **Commands:**
  - Placement with legal sites. Pending and refused states prevent double placement under lag.
  - Live previews for roads, bridges and trenches.
- **Main menu:** UI Toolkit, over a living world backdrop.

### 3.6 Audio and intro

- **Audio:**
  - Procedurally synthesised one-shots and loops.
  - 32 spatial voices and 8 engine voices.
  - City, river, wind and rain beds.
  - Volumes saved per player.
- **Intro:** seven shots telling the story of the collapse, with captions, letterbox, film grain and music. It can be skipped.

## 4. Server changes

### 4.1 Feedback rules (`b5bc818`)

- Research no longer waits for goods.
- **Field guns:** direct-fire anti-armour (new `atgun` weapon, range 4).
- **Engineers:**
  - non-combat;
  - they spread to cities that need them, and every city keeps one when possible.
- **Explorers:** fan out with per-unit headings and randomness.
- **Trenches:**
  - never on roads;
  - allowed outside your territory;
  - partially invalid lines still build their valid segments.
- **Nuclear plant:** 45 power; when destroyed it melts down at half a strategic warhead, with fallout.
- **Ports:** cities claim shoreline water, so ports can be built.
- **Districts and governors:**
  - The house cap grows with the era (6 + 3 per era, up to 15).
  - Governors pave city streets once Civil Engineering is known.
- **Names:** new post-collapse civilization and city names.

### 4.2 Research and governors (`6ecd9d3`)

- New tech **Nuclear Fission** (era 3, industry) unlocks the nuclear plant. Fusion Power now follows Fission.
- AI rivals research every branch: air operations, recycling, fission, missile defence, servicing and strategic missiles were missing from their preferences.
- **Road-aware governor placement:**
  - It caches the hexes a city's streets reach (up to 8 steps, refreshed every 20 s).
  - Placement scores frontage on connected streets above stray tracks.

## 5. Deployment (2026-11-08)

| Part | Where | How |
| --- | --- | --- |
| Server | Cloud Run `shattered-empires`, us-east1, revision `00017-wnj`, image `…/shattered-empires:6ecd9d3` | `gcloud builds submit` (Cloud Build, since there is no Docker on the PC), then `gcloud run deploy` keeping the service's existing settings. `/api/health` reports `6ecd9d3`. |
| Unity build | `gs://stem-471602-se-snapshots/downloads/unity-preview-6ecd9d3/ShatteredEmpires-Unity-win64.zip` (40,559,221 bytes) | Uploaded, size verified, then the manifest was merged (the same rule as `tools/publish-downloads.mjs`). Served at `/download/file/ShatteredEmpires-Unity-win64.zip`. |

Security:

- The service-account key is ignored by git, Docker and Cloud Build.
- `.gcloudignore` uploads only the Dockerfile, package files and `server/`.
- gcloud ran with an isolated config directory.

## 6. Verification and performance

Offline stress scene, 256×256 world, ~470 buildings, 1,000 units, 1920×1080, D3D12, vsync off. Reports are in `benchmarks/`.

| Segment | Before this round's work | Regression (new visuals, before fixes) | After fixes (deployed build) |
| --- | --- | --- | --- |
| city strategic | 323 fps, p99 9.9 | 177 fps, p99 12.3 | 241 fps, p99 11.2 |
| city tactical | 206 fps, p99 12.6 | 97 fps, p99 17.7 | 165 fps, p99 14.2 |
| battle tactical | 221 fps, p99 8.6 | 103 fps, p99 12.7 | 183 fps, p99 13.3 |
| battle operational | 275 fps, p99 10.4 | 187 fps, p99 10.2 | 233 fps, p99 11.7 |
| frames > 50 ms (all) | 0 | 4 | 0 |

The regression came from three things, each fixed:

1. **Ground-height samples became expensive.** The ridged mountain noise made them so; it is now cached per hex for main-thread callers, while Burst jobs compute it directly.
2. **City composition spikes.** Each building and road change recomposed the whole map; changes now dirty only the affected cells.
3. **Trench rebuilds.** Trenches rebuilt on every building health tick; they now rebuild only when defences change.

Per-phase timings are logged with every stall and summarised after each benchmark (`PHASES` in the player log).

What testing does **not** yet cover: a person playing a full live match in the Unity client with the new interface, multiplayer with two humans, macOS, and the two-hour session.

## 7. Known issues

- **Street rings:** in districts where every hex has roads on all six sides, streets wrapping each built hex read as a lattice of rings (visible in the era-0 stress shot). The fix is to link fewer edges round dense blocks.
- **Diplomacy state:** the client does not receive it, so the minimap shows every other faction's units as foreign.
- **Benchmark coverage:** the stress scene has no staffed buildings, so smoke and steam are not exercised there.
- **Windows publishing script:** `tools/publish-downloads.mjs` cannot run on Windows (`execFileSync('gcloud')` cannot start the `.cmd` wrapper), so publishing was done by hand.

## 8. Target-specification batch (built and verified locally, not yet deployed)

Built against [UNITY_GAP_ANALYSIS.md](UNITY_GAP_ANALYSIS.md) after `6ecd9d3`. It compiles, all tests pass and the stress benchmark holds. It has not been played by a person and is not on the live site.

### Commands and camera

- **Battle lines** (spec §15.3):
  - A right-drag draws a line; a right-click still moves (on release).
  - While dragging, the server plans the deployment as a dry run (`deploy` with `preview: true`, in `formations.js`). The map shows each unit's slot in green and refused ground in red, and the hint counts placed, overflowing and refused units.
  - F flips the facing, Alt makes an advancing line, Shift queues it, Esc cancels, and release commits.
- **Control groups:** Ctrl+1–9 to set, 1–9 to select, Shift+number to add, a double press jumps the camera there.
- **Other unit keys:** F follows the selection, T then a click attack-moves, H holds, X withdraws.
- **Camera:**
  - Fixed 60° pitch (spec §14); Shift fast pan.
  - Smooth jumps; Backspace returns to the previous view.
  - Double-click on open ground centres the view; Space jumps to the latest important alert.
  - Moving the camera by hand always cancels following.
- **Input:**
  - Every key now registers under the Input System backend (only a handful did before).
  - No game key fires while a text field has focus.
  - All shortcuts are remappable in Settings and saved per player.

### Interface

- **Minimap:** now a Map Lens, off by default (Overview → Map Lenses, or M), per the spec's map-first interface.
- **Alerts in three tiers:**
  - critical: banner;
  - major: compact notice with Go;
  - everything else: chronicle only, with Go buttons.
- **Result cards:** concluded battles show the server's after-action report as a result card (title, outcome, losses, Go there).
- **Alert feed fix:** after 200 notes, new alerts stopped appearing (the list was trimmed but the "already shown" count was not). It now counts with a running total.
- **Research:**
  - Search by name, effect or unlock; matches are outlined and the rest fade.
  - Hovering a technology highlights everything it needs and everything that needs it.
  - The progress bar updates in place, so typing in the search box is never interrupted.
- **Build palette:** search by name or category.
- **Observe tab** (spectators): follow a nation, whole map or that nation's fog of war, match speed (pause, 1×–8×), and the server's AI inspector report.
- **Settings:**
  - Interface scale, screen shake, reduced motion, weather intensity and high-contrast markers.
  - Edge pan and pan speed.
  - Shortcut rebinding with restore defaults.

### Cities

- **Historical continuity** (spec §7.2):
  - The server records the era each building was built in (`era`, sent as `ea`); an upgrade brings it up to the current era.
  - The client draws each building in its own era, so old districts keep their architecture.
  - Old saves without the record follow the current era as before.
- **Five-stage construction** (spec §8.2): survey stakes, excavation and foundations, structural frame, walls and roof, finishing. A site waiting for materials or workers is visibly dormant: tarped, crane parked.
- **Damage bands** (spec §8.3): 85/60/35%. Scorch marks, rubble heaps and broken wall sections grow with each band, deterministic per building. Buildings redraw only when they cross a band.
- **Upgrade levels 2–3** change every building kind, not just homes: annex halls, silos, loading aprons, domes for civic buildings, revetments and hardened blocks for military sites.

### Verification

| Check | Result |
| --- | --- |
| Unity compile | Clean |
| EditMode tests | 6/6 |
| Standalone .NET checks | 11,383 |
| Server suite | 195/197 after the fix below. The only failures are the two pre-existing macOS-only updater tests. |
| New server tests (`test/spec-2026-11.test.js`) | The deploy preview plans exactly what the real order does and changes nothing; buildings keep their era and an upgrade updates it; the era reaches the client. |

On the first server run, the new era test failed because the test called the snapshot function wrongly; the era logic itself was correct. It passes after the fix.

Stress benchmark ([report](benchmarks/unity-stress-2026-11-08-spec-batch.json)):

| Segment | Deployed build (`6ecd9d3`) | This batch |
| --- | --- | --- |
| city strategic | 241 fps, p99 11.2 | 269 fps, p99 9.4 |
| city tactical | 165 fps, p99 14.2 | 172 fps, p99 12.1 |
| battle tactical | 183 fps, p99 13.3 | 188 fps, p99 8.1 |
| battle operational | 233 fps, p99 11.7 | 259 fps, p99 7.3 |
| frames > 50 ms | 0 | 0 |

### Not yet covered

- Live play with a person: battle-line feel, rebinding and the observe tab against a real server.
- Server deployment of the preview and era changes. The live server is still `6ecd9d3`, so a client built from this batch would get no line preview from the live server, and no building eras until it is redeployed.

## 9. Organic cities and the visual design bible (2026-11-09, built and verified locally, not deployed)

Built against two further owner documents: *Organic City & District Generation* and the *Complete Visual Design Bible*.

### City composition engine

- **District planner** (`Cities/DistrictPlanner.cs`): neighbouring buildings join districts by the document's affinity score, A = wF·F + wR·R + wN·N + wH·H − wB·B:
  - F: function compatibility.
  - R: a street connecting them.
  - N: proximity.
  - H: shared era.
  - B: a river or water between them with no crossing.
  - Each district is named after its oldest building, with a stable hash seed, so adding a house extends a neighbourhood instead of re-rolling it.
  - Developed hexes without a building join the district most of their neighbours belong to.
  - Only hexes whose district relationships changed are recomposed.
- **Parcels and streets:**
  - A built hex's building sits on the widest street-free side, scaled to the room it has and facing the streets.
  - The hex's junction moves to the street side, so streets pass the building instead of crossing or ringing it.
  - Traffic follows the same geometry.
- **Street hierarchy:**
  - Primary streets: wide, with centre lines.
  - Industrial service roads: pale concrete with yellow edge lines, no sidewalks.
  - Residential and commercial streets: kerbs and continuous sidewalks, patchy in older neighbourhoods.
  - Country lanes: gravel with shoulders.
  - Pedestrian crossings at busy town junctions.
- **Railways and bridges:** railways get ballast, sleepers and rails; bridges get railings and abutments.
- **District vocabulary:** each district has a wall-material and roof family (terracotta, slate or weathered brown, and so on); buildings vary within it (60% district, 40% parcel).
- **Shared district spaces,** drawn once per pair of neighbours:
  - Industry and energy: paved service yards, pipe racks, container stacks, and one perimeter fence round the works with gates where streets enter.
  - Military: one compound wall, a shared parade ground and the motor pool. Barracks in a compound drop their own walls.
  - Farms: estates whose fields all run one way, joined by farm tracks, with one farmstead at the oldest farm.
  - Campus: lawns and paths.
  - Commerce: pedestrian lanes with benches.
  - Homes: footpaths and small groups of street trees.
- **Parking by district,** with stable spots and occupancy:
  - Homes: driveways, often with a car (not every house has one). Apartments: a shared rear lot.
  - Shops: a compact rear lot and curbside cars.
  - Industry: employee parking kept apart from the truck yard.
  - Military: motor pools. Institutions: visitor spaces.
- **Infill:**
  - It follows the district: commercial districts get shopfronts with awnings and signs; industrial districts get workshops and yards.
  - Historical layers: most infill keeps the district's era, some is newer.
  - Parks appear where the document says (leftover interior blocks; plazas beside civic buildings), rarely otherwise, and never in a young settlement.
- **Building catalogue:** distinct models replace the shared fallbacks:
  - Steel mill: furnace hall and glow, blast furnace, stacks, ore yard.
  - Refinery: distillation columns, tank farm, flare.
  - Munitions plant: halls separated by blast berms, an earth-covered magazine.
  - Motor works: roller doors, dispatch yard.
  - Heavy assembly: high hall, gantry crane.
  - Electronics plant: clean walls, glazing, rooftop air handling, solar.
  - Drone works: twin hangars, launch pads, radar.
  - Robotics complex: skylit hall, robot arms.
  - Mine: headframe and winding wheel.
  - Quarry: terraced benches, crusher.
  - Salvage yard: wreck stacks, crane, fence.
  - Timber mill: saw shed, log decks.
  - Oil well: pumpjack.
  - Shield generator: emitter, four pylons, operating ring.
  - Communications tower: lattice mast with beacon.
  - Missile silo: armoured doors, warning light, perimeter.
  - Fortress: stepped command block, casemates, berms.
- **Placement ghost:** the building being placed is drawn at the cursor from the same recipe and parcel it will have, tinted green or red. A card beside the cursor shows cost, build time and the server's refusal reason.
- **Composition budget:** city composition is limited to 5 ms per frame (it was six cells per frame).

### Presentation

- **Intro:** rewritten to the bible's eight beats with its captions:
  - Shots 1–4 are one city: alive at dusk; three trails, blasts and a shock; ruined under ash; overgrown as the light returns.
  - Then the valley settlement, the rival's tank column, the silent silo with its beacon, and the dawn title.
  - Space, Enter or Esc skips.
- **Main menu:**
  - Title upper left over the living world, the bible's ten items, a one-line explanation on hover.
  - Continue shows the saved match; version and build in the corner.
- **New Campaign:** world type (four styles), map size, rivals (1–5), difficulty (Relaxed–Brutal, with descriptions), nation name and seed. All are real server options.
- **Multiplayer page:** host, join, spectate, server choice.
- **Field Guide:** searchable, in the menu and in the game.
- **Loading:** real stages (connecting, generating, synchronising, building the landscape, entering), with no invented percentages.
- **Opening descent:** from 230 units down to the capital, waiting honestly for the landscape to finish building. A title card shows the era and "Year One" over the nation's name, then the interface fades in. Any key or click skips.
- **In-game controls:**
  - Speed strip: pause, 1×, 2×, 4× (spectators: 0–8×).
  - Pause menu: Resume, Save, Settings, Controls, Return to menu, Quit.
  - Esc closes the innermost thing first.
- **Strategic badges:** shaped by role (circle infantry, rectangle vehicles, diamond aircraft) with a dark rim, so shape as well as colour carries the information. Units of one type on a hex merge into one badge with a count label.
- **Battle-line preview:**
  - Crowded hexes show amber.
  - Facing markers use the server's own facing vector.
- **City card summary:** tier and condition, population, housing used, development focus, mayor, the current plan with a progress bar, and the limiting factor in plain words.

### Verification

- **Unity:** clean compile; EditMode tests 6/6.
- **Server:** 195/197; the two failures are the pre-existing macOS-only tests.
- **Stress benchmark** ([report](benchmarks/unity-stress-2026-11-09-city-design.json)): 168–254 fps, p99 ≤ 12.1 ms, no frames over 50 ms (worst 29 ms).

**Not run: the standalone .NET checks.** Windows Application Control blocked the newly compiled check program on this PC, and I did not change that security policy. The core library they cover did not change in this round.

### Known issues

- **Street skeleton:** in the stress world every hex edge carries a road, so the street network still shows its hexagonal skeleton (much less than the earlier rings or bubbles). Real cities have far fewer roads. Check it in a played city.
- **Not exercised in play:**
  - the intro, the menu pages, the campaign start and descent, the pause menu;
  - the placement ghost and its card;
  - badges in a live match.
- **Still open from the bible:**
  - tree and crop sway;
  - irregular crater meshes and forest damage;
  - a missile launch and targeting workflow;
  - the multiplayer lobby screen;
  - work crews on construction sites;
  - rigged infantry animation.
