# Native living-world and direct-control checkpoint

Baseline: `57c0bb7`. Godot is the only development target; browser/Electron is reference only.
The consolidated outstanding requirements, including the latest visual and warzone briefs, are
tracked in [DEVELOPMENT_BACKLOG.md](DEVELOPMENT_BACKLOG.md). The earlier project acceptance
contract remains in [LWE_REQUIREMENTS.md](LWE_REQUIREMENTS.md).

## Fun-first decisions, UI, menu, tutorial and intro (2026-11-08)

- **Guide Growth:**
  - `cityGrowth {city, kind, tile}` stores a server plan (`city.plan`; `city.growth` remains the
    growth rate) within the city's reach and borders.
  - The mayor favours that kind of building (planner fit) and places it in the marked area
    (radius 2), keeping other uses out.
  - After four buildings it reports "X expanded" as a result card.
  - City card: Guide growth, then Housing, Industry or Farming, then a map click with a hover
    preview (open hexes, existing buildings, road access).
  - The current plan, with direction and progress, can be cancelled. The area is outlined in the
    world while the city is selected (`GrowthZoneOverlay`).
- **Mayor controls on the city card:** state and one on/off button, then "What should the mayor
  favour?" with the four priorities (current one marked, each with its meaning), and what the mayor
  is doing now.
- **Opportunity Director** (`server/sim/opportunities.js`, every 5 s, human players):
  - Situations: rival forces massing near a city (visible troops only), a damaged building, a
    city at 85% of its housing with no plan, a workable explored deposit (higher when short of
    its good), idle research.
  - At most two, each with direct actions (go to, select nearby troops, repair, guide growth,
    build, research).
  - `oppQuiet` silences a suggestion for four minutes.
  - Client: `NativeOpportunities` on the left, hidden while a tool or panel is open.
- **Every resource in the top bar:** food, materials, ore, steel, fuel, electronics, munitions and
  credits as compact chips with trends and tooltips. The small "all resources" popup is gone.
  - A click opens a cause-and-fix card: the cause, Find deposit (camera to the nearest known
    one), Build the producer (or which technology it needs), Details.
- **Objective assessment:** hovering an army objective shows what is known there (fortifications,
  enemy troops seen or "not in sight", cover or exposed approach, supply).
- **Battles end decisively:** the side holding the field (within 3 hexes) wins: "the enemy
  withdrew; we hold the field" or "driven from the field", shown as a result card.
- **Result cards** (`kind: result` notes) for completed growth plans, battle victories and defeats,
  and the first of each kind of industry, defence or silo.
- **Main menu:** title and premise, the three pillars, then Continue, New campaign, Tutorial;
  Multiplayer, AI match, Sandbox; Settings, Field guide, Watch the intro, Quit. Every option has a
  tooltip. The card fits its content; the backdrop has drifting ash and pulsing settlement lights.
- **Intro cinematic in the engine** (`NativeIntroCinematic`): a 3D scene in its own world, built
  from the game's own building, housing and vehicle models, in eight beats of about six seconds:
  1. the old world's city at dusk with lit windows;
  2. three warheads arcing in, flashes, fireballs and smoke columns;
  3. the city replaced by ruins under falling ash, grey fog and a desaturated grade;
  4. the land greening as trees grow back;
  5. your settlement ("Your people");
  6. the rival's fort, barracks and armour rolling toward the border;
  7. the silo still standing, its warning light pulsing;
  8. the title at dawn.

  Captions tell the history (the missiles, the fallout, the long winter, the Reclamation). Space,
  Enter or Esc skips, with the hint on screen. It plays on first launch and from the menu;
  `--intro-shots=DIR` captures each beat.
- **Opening descent:** a new match opens with the camera descending onto the capital, captioned
  with the empire's name and "The Reclamation · Year one".
- **Tutorial:** a small, quiet match (one easy builder rival) with the coach on. Steps: look around,
  choose how your city grows, scout, act on an opportunity, choose research. Only the current
  step's hint is shown, highlighted, in tutorial mode.
- **Checks:** server 187/187 (new tests for Guide Growth and opportunities, including fog of war),
  all Godot suites passing.

## Performance pass: large online battles (2026-11-08)

Goal: large battles with several online players, constant orders and building placement must
never show the engine's limits.

**New benchmarks**
- `tools/load-bench.mjs`: four players at war, 1600 troops, each player re-ordering troop groups
  and placing buildings every two seconds on its own beat.
- `tools/sandbox-bench.mjs`: the client's 500 vs 500 staging, run headless.
- `tools/live-bench.mjs`: a WebSocket client that drives a running server and measures command
  round trips and snapshot pacing.
- `--perf` also reports script process time, badge time, objects and draw calls.

**Server**
- **Move orders are instant:** large groups follow the shared flow field without settling it
  inside the command (0.18 ms per order, was 4.7 ms; worst 3.8 ms, was 40 ms).
- **Incremental flow fields:**
  - Built outward from the goal only as far as the units that need them, and resumed later.
  - A unit the field cannot reach within a bound set by its distance routes itself, instead of
    flooding the map.
  - Settled values and settle order are history-independent, so restored games stay
    bit-identical.
- **Deferred path searches:** a search over the tick's budget (now 15,000 expansions) waits one
  tick, and deferred units retry first on the next tick. No more 600-node floor per search,
  which let hundreds of searches overshoot the budget.
- **Faster searches:**
  - The heap moves a hole instead of swapping pairs, and `dist` allocates nothing.
  - Enemy-held and controlled hexes are a byte mask.
  - Off-road cost (terrain, weather and scars) is memoised per tick and movement class.
  - Road lookups only happen where both hexes have a road.
- **Autonomy (player troops' self-direction):**
  - Enemy lookups use a per-pass spatial grid, not a scan of every unit.
  - A quarter of the units are handled every half second, so each still checks every two
    seconds, without spikes.
- **Targeting:** empty hexes are skipped, and line of fire is checked only for a candidate that
  could still win (same choice).
- **Snapshot deltas (`udelta` capability, native client):**
  - Only changed unit records and paths, plus the ids that left view.
  - A full refresh every 10 seconds and on join.
  - About 60 KB down to 12 KB per snapshot per player.
  - The browser keeps full snapshots.
- **Results:**
  - Large battle (1000 troops): tick p95 10.8 ms (was 22.8), worst 26.5 ms (was 42–54).
  - Four-player load: tick p95 16 ms, worst 25 ms, all within the 100 ms tick.
  - Live: command round trip p50 2 ms, p95 11 ms; snapshots every 204 ms (p95 214).

**Client**
- **Troop badges:**
  - Full layout split over three frames (grouping, candidates, clustering and placement).
  - Badges follow the camera every frame from stored world positions.
  - One projection per group; clusters placed directly; integer cluster keys.
  - p95 spikes down from 12–14 ms to 2–6 ms; median under 0.1 ms.
- **Units:**
  - A unit standing still with an unchanged record, offset and ground reuses its transform and
    batch.
  - When zoomed out, marching units refresh every second frame (every third above zoom 40).
  - Stack lanes use integer keys.
- **Squad figures:** squads standing still simulate on alternate frames with a double step;
  marching squads update every frame.
- **Measured back to back on this laptop (battery):** frame time at 1000 troops 16.7 / 22.9 /
  25.0 ms at zoom 8 / 16 / 40, against 20.0 / 28.8 / 29.2 ms before. Script time is now about
  8–11 ms; most of the rest is GPU (vegetation is the largest share). Battery and thermal
  throttling move absolute numbers by up to 2–3x.

**Checks:** server 185/185, load 1/1, browser e2e 13/13. Godot: render 66, composition 34, LWE
67, development 303, surface 27, water 24, battle 11, warzone 14, all passing.

## P7 playtest fixes and balance (2026-11-08)

- **Map lenses:** every economy snapshot used to reset the lens and restart its image job (one
  row per step), so a lens never finished drawing. Now a lens change applies at once; data
  refreshes at most once a second in 16-row steps and keep the previous image on screen. L shows
  the lens name. `--lens=N` starts with a lens (visual checks). Verified on screen (Territory).
- **Troop badges at scale:** with more than 36 groups on screen, badges aggregate per owner and
  screen cell (the most common unit's icon and the total count). The cell grows until at most
  120 clusters remain, and a cluster is never dropped. Verified at 1000 troops.
- **Placement under load:** the legal-site list is cached per empire and type (two seconds or
  until buildings change; hits are re-checked site by site). The client places on click while
  the list is in flight and lets the server validate. Hover site checks keep one request in
  flight, then check the latest hex.
- **Missiles:** an AI at war builds a silo near its capital once it has the technology and the
  goods. It strikes massed armies, dug-in fronts (trenches plus defences) and airfields. A human
  player's cities, and anything within two hexes of one, are targets only on Brutal.
- **Research stall at Railways:** a mid-industrial technology needs 140 steel and 60 fuel to
  begin, and every alternative in that era needs the same goods, so automation had nothing to
  switch to and research waited silently. Now the player gets one notice listing the missing
  goods; the top bar shows "Waiting · needs …" and the research panel shows the missing amounts
  with current rates. Era 2 goods are eased to 120 steel and 40 fuel; steel mills make 0.65 steel
  per second (0.55 before) and synthetic refineries 0.6 fuel per second (0.42 before).
- **Hostile borders:** client traffic never runs on an edge between two empires (from P2).
- **Balance pass** (`tools/balance-report.mjs`: equal-value duels over three maps; aircraft
  excluded because they cannot rearm away from an airfield):
  - Special Forces cost 170 value (was 125): they beat mechanised and exo infantry at half the
    cost.
  - Exo infantry cost 325 (was 265) and gain +25% against infantry.
  - Autonomous tanks cost 520 (was 620) and gain the main tank's anti-infantry edge (+5%).
  - The main battle tank gains +20% against tracked vehicles (cost 320, was 340).
  - Mechanised infantry cost 220 (was 190).
  - Armored cars cost 130 (was 120), and their bonus against infantry drops to +15% (was +30%).
  - Result: mech against tank is about even, and armour edges out same-era infantry at scale.
    The "prepared defences blunt tanks" scenario still holds.
  - Era pacing is unchanged within noise: era 2 at 24–45 minutes, era 4 at 65–107.

**Checks (2026-11-08):** server 184/184, load 1/1. Godot: render 66, composition 34, LWE 67,
development 303, surface 27, water 24, battle 11, warzone 14, all passing. Browser e2e 11/13: the
two failures (multi-building Alt-drag, line deployment) fail identically on the commit before P1
(`6fe3491`), so they are local and environmental, not regressions.

## P6 visuals (2026-11-07)

- **Wear and stripes removed:** the hex-wide track-wear tint (`bf.wr`) is no longer drawn or
  listed in the inspector. The diagonal lines in busy areas were its rut pattern (a sine across
  the whole hex) and are gone with it. The server still records wear; nothing renders it.
- **No man's land** is always darker than the ground it replaces (never a pale hex), damp, and
  churned into clods at two scales.
- **Craters** are dark, damp, scorched bowls with a lighter ring of thrown earth at the lip; rain
  pools in the deepest part. This shading runs only on damaged ground. Frame time at 1000 troops
  matches the previous shader within run-to-run noise.
- **Calmer ground:** less fine speckle and detail-texture contrast, with a broader low-frequency
  variation layer.

## P4 troops and combat (2026-11-07)

- **March, then fight:** near the camera a squad marches as a tight two-file column whose files
  keep step. Once it fires or is suppressed, it breaks up for eight seconds after the last shot:
  each rifleman picks his own spot in a wider spread and rushes between spots, and an advance
  under fire becomes a staggered skirmish line. It re-forms when calm. Unit formations stay
  player-drawn.
- **Gait:** five stride poses (full, half, passing, half back, full back) chosen from the
  continuous step phase replace the two alternating frames, for soldiers and civilians.
- **Tracers** leave one of the shooter's actual soldiers and fly at one of the target's soldiers
  (or its drawn vehicle), with spread by weapon. About a quarter overshoot past the target.
- **AI war works:** at war, each AI front gets a defensive network straight away, without waiting
  for troops: the widest trench line that fits on its own ground toward the enemy, a reserve line
  on harder settings, guard posts or bunkers just behind its ends and centre, and AA behind the
  line when the enemy has aircraft. Paid like player works and renewed every five minutes.

## P3 construction tools and UI (2026-11-07)

- Road, bridge and trench tools stay open after a confirmed order; Esc or right-click closes them.
- The wheel and middle button reach the camera while a placement or drawing tool is active.
- **Scrolling fix:** buttons used to stop wheel events, so build and train lists only scrolled
  in the gaps. Buttons now pass the wheel to their list; panels still keep it from the map.
  Model thumbnails ignore the mouse from creation.
- **Build more** on an own building's card opens placement for the same type.
- **Training queue:** unit icons, the current unit with progress, remaining time per item, the
  queue total, a repeat toggle and "train next" (new server command `trainNext`; it never
  interrupts the unit in training). Cancel works as before.
- **All resources:** the strip's resources button opens a panel listing every stockpile with its
  trend, with shortages in red; click a row for its detail page.
- **Trenches and defences:** a line drawn through an own guard post, bunker, fort or AA battery
  joins it (the segment reads "joins the …"); the channel on each side runs up to the defence.
- **Curved battle lines:** a right-drag sends its stroke (up to 24 points). The server places the
  front along the curve in drawing order, and rear ranks follow each section's local normal.
- Trench curves are sampled twice as densely (`TrenchPresentation.CURVE_SAMPLES`).

## P1 city growth and P2 roads/traffic (2026-11-07)

**P1. Cities**
- **City street network (`CityStreets`):** every urban hex (server urban footprint plus homes,
  markets, campuses and the hub) is a block. Streets run along block edges and meet at the
  corners as one continuous network that grows with the city. Stable corner offsets and gentle
  bends keep it from looking like a rigid hex grid. Lanes in towns, kerbed streets with raised
  sidewalks in cities (sampled densely, never sunk into the ground), and avenues with a planted
  median around the centre of larger cities. Outer access lanes appear only where a building lies
  beyond. Replaces the old per-pair street stubs.
- **Open blocks** are hex-fitted pocket parks (winding paths, trees, benches), rare plazas
  beside the centre, or small parking courts.
- **District-aware placement (server, native rulesets):** `governor.pickTile` scores district
  fit (compatible neighbours, clashing uses), street frontage, freight-road access and each
  district's ring around the centre (homes and commerce near it, industry toward the edge on good
  roads, farms on the outer fertile ring). Shared by player mayors and AI. Automation never builds
  over trench lines.
- **Compounds:** neighbouring barracks form an army base (parade ground and flag, motor pool,
  obstacle course, perimeter fence with gates at real roads).
- **City centre:** a larger parcel; a broad civic hall on a stepped forecourt, a landmark civic
  tower with glazed bands, beacon and flag, and a colonnade.
- **Farms:** rows of standing grain swaying in the wind (`CropFields`) along the estate's field
  direction, clear of the farmstead and the central track; gold when working, green when new or
  idle, sparse when damaged; near the camera only.

**P2. Roads, bridges and traffic**
- Traffic follows the drawn road centre-lines: curves, graded approaches and bridge decks (no
  more driving through decks or cutting corners). It keeps to its lane, faces along the road and
  never crosses into another empire's territory. Freight trains follow the track the same way.
- Drawn roads follow the player's stroke (gaps filled, jitter loops removed). Only blocked steps
  get a short local detour that rejoins the stroke; a two-click road still auto-routes.
- Blocked road works raise an alert with the reason and location, and red-and-white barriers mark
  the blocked stretch; works waiting for materials send a minor notice.
- Native governors build and upgrade a road to their nearest sister city (with its bridges) as
  better road classes are researched. On the road turn they build when there is no road work.

## P5 performance and stability (2026-11-07)

Measured with `tools/battle-bench.mjs` (server) and `--battle=massive --perf=SECONDS` (client;
500 vs 500 sandbox scenario).
- **Server:** pathfinding was most of the tick cost in big battles: failed searches ran to 6,000–24,000
  nodes, and hundreds of units repeated them every couple of seconds. Searches now share a per-tick
  budget (60,000 expansions). Identical searches within the unit step share one result, and the
  goal bias is firmer. Worst tick with about 1000 troops: 155 → 60 ms (budget 100 ms).
- **Backpressure:** when a player's connection backs up (over 2 MB unsent), the match worker skips
  building that player's snapshots until it drains, then sends a catch-up. Incremental tile updates
  are held, not lost, and the heartbeat no longer queues behind megabytes, which previously led to
  disconnects.
- **Rejoins** to the same match keep the camera and keep buildings drawn until rebuilt (the
  "everything vanished and the camera reset" report).
- **Client, 1000 troops:**
  - Squads outside the near view are a single shader-animated instance per unit: each soldier
    wanders, lags behind when marching, swings legs and arms, and goes to ground. There is a
    low-poly variant for wide views.
  - Squads near the camera keep the full per-soldier simulation (48 nearest in large battles).
  - Instance uploads use one buffer per batch; off-screen units refresh every tenth frame; unit
    interpolation endpoints are cached per snapshot pair.
  - Trees switch to low-detail models beyond close zoom.
  - Units cast shadows only up close.
  - The 3D scene renders to a pixel budget per quality preset with FSR upscaling on high-density
    displays.
  - Frame time with 1000 troops in battle: 39–53 ms → 22–25 ms (1600×900 window). Script time
    11 ms.
- **Vehicles sharing a hex:** stationary units take stable places around the hex; units travelling
  the same stretch take parallel lanes, so vehicles no longer overlap.
- **Tests:** server path budget and backpressure (`test/native-performance.test.js`); Godot squad
  animation tagging, low-detail mesh and buffer layout.

## AI and pacing (J), interface (K) and leftovers (2026-11-07)

**J. AI and pacing**
- Human-like reactions: a new threat near an AI city is answered after a delay by skill
  (18 s relaxed → 2 s brutal); existing defences keep responding. Skill-scaled estimates,
  commitment and the trench lines toward known enemies were already in place.
- Settlement targets stay era-based (2 / 3 / 4 / 6 / 8); captured cities count half, so conquest
  does not stop an AI founding its own towns.
- Player city development (mayors) may now also build salvage yards, power plants and oil wells
  and undertake timed upgrades of housing and production within its budget, so growth no longer
  stalls at the housing cap. Military and national projects stay with the player.
- Rivals: "Disengage and pull back" (confirmed) withdraws your troops from their territory and
  stands aggressive units down; the war ends once the front stays quiet. Only hostilities and
  disengagement exist: no treaties, payments or trade.
- Pacing measured with `tools/pace-report.mjs` (AI-only native-v4 matches): eras arrived at
  9–16 / 15–24 / 30–41 / 46–58 min against targets of 18–25 / 30–45 / 50–75 / 75–110, so
  native-v4 research was slowed from 0.45 to 0.21, with later eras researching more slowly still
  (`ERA_RESEARCH` 1 / .9 / .72 / .62 / .62). Measured after the change (2 seeds, 4 AIs each): eras at
  16–31 / 24–45 / 42–59 / 65–104 min. The fastest AIs are still a few minutes early in later eras;
  one AI stalled at a single city with flat population from about minute 60 (follow-up).

**K. Interface**
- Alert feed (`NativeAlertFeed`): critical events show a banner, major and warning events a short
  pill, both with Go-to and dismiss; minor and informational events stay in the chronicle.
- Training: cost, time and affordability per unit; a queue with the training progress bar and a
  cancel button per item (full refund while waiting, half once started).
- Build menu: build time and "waits for materials" per building.
- Feature parity matrix: `docs/PARITY_MATRIX.md`.

**Requested during this pass**
- Bird flocks pick their centre once, when they appear, and stay fixed in the world instead of
  following the camera.
- Trees: a spruce-like conifer with six ragged whorls and a broadleaf with a forked trunk and
  nine shaded crown lobes; per-tree girth and height variety; forests about twice as dense
  (30 per interior forest hex, thinning to 20 at edges; vegetation recipe v3); fewer, duller logs.
- Closer zoom: the minimum view is 2.5 instead of 7, so people, vehicles and building detail
  can be inspected.
- Civilians: four everyday figure variants (plain, shoulder bag, long coat, rucksack) and errand
  walking with eased starts and stops, pauses at both ends, gently curved paths, some walking in
  pairs, and stride frames that follow the walking speed.

**Leftovers**
- E: a local street plan joins neighbouring urban hexes of different kinds (homes, market,
  campus, hub) with streets, sidewalks and lights, decorative only. Residents walk between
  their homes and a nearby workplace, market, campus or hub.
- N: the F9 inspector draws the hovered building's district, its planned parcel and the real
  road edges in the world.

## Quick fixes and units/civilians overhaul (2026-11-07)

- **Server refusals are visible:** a match refused before the world arrives (for example
  "short of memory", an unknown match or an expired session) now shows on the connecting card
  with a way back, including for command-line starts, instead of an empty black screen.
- **Industrial halls:** a concrete plinth, pilaster bays, a clerestory band, roller doors with
  ribs, a personnel door, corner downpipes and roof vents on every hall.
- **Figures (`FigureKit`):** human-proportioned soldiers, crews and civilians in five poses
  (stand, two walk frames, kneel, prone). Kit by role: rifle troops wear helmets, plate carriers
  and packs; militia wear caps and jackets; special forces wear dark kit with night optics; exo
  infantry wear powered frames; engineers wear hard hats and hi-vis vests and carry tools; crews
  carry ammunition cases; civilians wear everyday clothes. Owner colour appears only as a
  shoulder patch. Skin uses its own material.
- **Free-moving soldiers (`SquadPresentation`):** one server unit, many people. Each figure has
  its own place, follow rate (some lead, some lag), gait and facing, and its own small wander.
  Halted squads shift position now and then. Marching squads string out in loose pairs; halted
  squads form a loose line; under fire they spread out and go prone, and when firing they kneel
  toward the target. Figures keep apart, step around water and building cores, and never leave
  the unit's footprint. Gun and mortar crews stay at their weapon and kneel once it is deployed.
  Casualties thin the group with health. Used up to operational zoom; wider views keep the baked
  squad. Presentation only.
- **Units sharing a hex** take stable, eased places around it instead of overlapping (presentation
  of the server's capacity rule).
- **Vehicles and aircraft (`MilitaryModelLibrary` rewrite):** sloped-glacis tracked hulls with
  track runs, road wheels and side skirts. Separate turrets with mantlet, long barrel, hatch and
  smoke dischargers. An 8-wheel armoured car, a covered cargo truck, an open scout buggy with a
  roll cage, a towed howitzer with split trail and shield, a mortar with baseplate and bipod, a
  casemate self-propelled gun, missile and air-defence trucks, a settler van with trailer, a
  helicopter with stub wings and skids, and swept-wing aircraft. Wheel hubs and track links
  animate while moving, and moving vehicles bob slightly on their suspension. Military paint
  keeps its olive drab.
- **Civilians:** pedestrians use the same figure style with varied clothing; traffic uses the
  city components (cars, delivery vans, handcarts in the first era) in real car colours.
- **Artillery (server, native-v4):** indirect-fire guns and mortars must halt for 6 s to set up
  before firing, and cannot fire on the move. The deployed state is sent as unit flag 64.
- Troop group shapes (line/column/wedge/box) were dropped at the user's request: formations are
  drawn by the player.

Verification: server 170/170, Godot development 244 (new figure, roll-frame, kit and free-moving
squad checks), render 66, composition 34, LWE 67, surface 27, water 24, battle 11, warzone 14.
Sandbox screenshots reviewed: tanks, stacked squads and individual soldiers.

## Backlog B–G pass: controls, construction tools, terrain, cities, art and damage (2026-11-07)

**B. Camera, selection and visibility**
- Camera steps are capped after hitches, WASD no longer pans while typing, follow-camera releases
  without a jump when the unit dies, leaves sight or changes owner, and a "Following …" pill
  with a one-click stop (`NativeFollowPill`) makes following visible. V (follow) and Y (stance)
  are remappable; the dead T stance toggle (T opens Research) moved to Y. Controls guide updated.
- Rejoining the same world keeps the existing ground until each chunk is rebuilt from the fresh
  geometry, so reloads no longer drop the map around the camera.
- Alt inspector: movement cost per class (infantry/wheeled/tracked, roads, river fords) from the
  server's movement rules, and farm legality by the server's farm terrain rule.
- Building placement draws the authoritative buildable area as one continuous outline (gaps at
  rivers, occupied hexes, overlaps) and names the city a site belongs to.
- Remembered foreign buildings are drawn in a cool, desaturated tone.

**C. Building, road, bridge and trench tools**
- Placement: ground-following footprint outline of the real planned parcel (green / amber waiting
  for materials / red refused), a cursor tooltip with name, city, cost, time or the exact refusal
  reason, pending sites marked until the server's building appears (no duplicate orders), and
  group placement reports each refused hex with its reason (`buildMany.failedTiles`).
- Roads: through-hexes follow one smooth curve; dirt tracks with mud ruts, paved roads with gravel
  shoulders, edge lines and dashed centre lines, divided highways with a raised median, railways
  with ballast, sleepers and two rails; destroyed segments end in debris. Vegetation clears the
  exact drawn corridor (`InfrastructureRenderer.clearance`).
- Bridges: timber trestle, reinforced concrete deck with parapets and piers, steel rail girder;
  graded approach embankments on both banks; damaged spans from the server's bridge condition
  (`bridges`, visible crossings only); collapsed spans drop into the water. Previews use the exact
  class construction before confirmation.
- Road works show their real segment and progress (`seg`, `prog`): survey stakes, graded earth,
  base course, surfacing and a roller; bridge segments raise piers and falsework first.
- Trenches: one continuous curved channel per through-hex (terrain cut matches), survey tape →
  spoil heaps → spoil bank → revetments, sandbags and duckboards → firing step and occasional fire
  bays; crews and a small excavator only at real project fronts; works waiting for materials are
  idle; damaged segments slump; mud floors pool with rain. Bunker/fort, AA and guard-post entrances
  differ by type and upgrade level.

**D. Terrain and environment**
- Continuous terrain: every hex sector is subdivided (indexed, 25 vertices/36 triangles per hex);
  shared edge midpoints carry the mean of both hexes so adjacent mountains form ridges, and an inner
  ring rounds hills and peaks into mass instead of one pyramid per hex. `ground_height` follows the
  exact same triangles, so everything stays seated.
- Forests: stable glades, altitude/climate species mix, smaller high-altitude conifers, shrubs at
  edges and in glades, deadwood, marsh sedge. River banks get reeds (lowland) or stones (upland).
- Deposits: iron rust outcrops, layered coal seams with spoil, pale rare-earth rock with mineral
  glints, pale stone shelves and boulders.
- Weather: standing water gathers in puddles on level wet surfaces (roads, yards, flat roofs);
  shore foam slightly stronger.

**E. Cities and civilian life**
- Settlement hub by tier: municipal block, forecourt and bus stop; City adds plaza and apartments;
  Metropolis adds offices and streetlights; Megacity adds towers. Tiers only add.
- Housing levels 2–3 add modern apartment blocks; neighbouring housing hexes form a local street
  with sidewalks, a terrace under one roofline, parked cars and streetlights (decorative, no route).
- Farms: one farmstead per estate (oldest farm) with barn, silos, shed, tractor and hay; other farms
  carry irrigation pivots or field kit; farm tracks join them; greenhouses at level 3.
- Industry: outer-boundary compound fences with gates at real roads, shared yard stock only when
  both plants are working. Campuses join with lawns and paths.
- Traffic never crosses destroyed spans; busy railway edges run freight trains.

**F. Art and materials**
- 36 reusable modern components (containers, tanks, chimney stacks, cooling towers, pipe racks,
  roof plant, solar, dishes, radar, streetlights, fences, gantry and tower cranes, conveyors,
  headframe, excavator, bulldozer, cars, vans, trucks, tractor, silo, greenhouse, hay, irrigation
  pivot, logs, office and apartment blocks, shop row, pallets, wind turbine, transformer, bus
  shelter) authored in `ComponentKit`, exported to `assets/components/*.glb` by
  `tools/build_components.gd`, listed with stable ids in `recipes/assets.json`.
- `CivicBuildingLibrary`: hub, farm, sawmill, deposit-specific mines, quarry, power station and depot
  rebuilt from those components (replacing timber-and-gable placeholders). Industrial and
  communications buildings gained stacks, tanks, roof plant, dishes, radar and vehicles.
- New CC0 materials: mud (Ground048) for trench floors and ruts; composite (Plastic010) for
  Advanced Systems buildings. Visual language and a 34-building audit: `docs/ASSET_AUDIT.md`.

**G. Construction, repair and damage**
- Construction stages from server progress, crew and waiting state: site preparation, ground work
  (slab, rebar), frame, exterior in scaffolding, finishing; machinery (tower crane on tall
  buildings), workers and material only while a crew works; waiting sites are visibly idle.
- Damage: missing panels cluster on the side recorded impacts struck, scorch on walls, bent rebar on
  concrete, a fallen slab when severe; deterministic and save-stable.
- Works priority (one per city: faster, the city's other works slow slightly), button on the card.
  Governors now repair through timed works under native-v4 instead of an instant 40 % heal.

Verification: server 169/169 (`ADMIT_OFF=1`, 4 new infrastructure tests), Godot render 66,
composition 34, LWE 67, development 191 (new component, civic, construction, impact-damage and
trench-curve checks), surface 27, water 24, battle 11, warzone 14.

## Architecture (A) and texture overhaul (F) (2026-11-07)

**Architecture**
- **Declarative world recipes** (`recipes/world.json`, schema 1): versioned sections with `hard`
  constraints and `soft` tuning for LOD, vegetation, building condition, warzone, ambient activity
  and environment. `RecipeRegistry.world_section/world_value` validate and serve them; LOD
  presets and scale thresholds, tree densities/edge thinning/battle loss, damage bands, crater
  shapes/rock depth/basin limit and wildlife caps are now read from the catalog.
- **Semantic graph completed**: terrain regions and water bodies (forest, mountains, hills,
  desert, wetland, tundra, sea, lake, river) as connected components; transport networks from
  authoritative road/rail edges; environmental (weather) regions; bounded per-building history
  (seen, completed, upgraded, damaged, repaired, changed hands); buildings link to their region
  and serving network, units to their region; `explain_tile()` for any known hex. Geography and
  transport rebuild as budgeted, cancellable low-priority jobs.
- **Scheduler**: threaded jobs (`enqueue_threaded`) that compute on the WorkerThreadPool over
  immutable copies and commit on the main thread only if still current; the territory field's
  full rebuild now runs this way.
- **F9 recipe inspector**: region, network, building recipe id/version/matched preconditions,
  relationships, identity seeds, history, units, battle region, world-recipe versions and
  scheduler/graph timings for the hovered hex.

**Textures**
- The ten 256-px generated placeholder sets were removed and replaced with ambientCG CC0 1K
  photographic Color/NormalGL/Roughness sets; eight new materials were added (grass, sand,
  rubble, gravel, snow, painted metal, corrugated steel, paving). Sources in
  `assets/materials/SOURCES.md` (33 MB of JPEG).
- Every material applies its maps at a per-material real-world scale, with the map's average
  colour factored out so the palette and vertex tints control hue, plus procedural grime and
  rust weathering.
- Terrain blends grass/soil/sand/rock/snow layers by biome palette, slope and height, with
  seam-free wrapped tiling and three-way projected rock on cliffs; detail fades at strategic zoom.
- Containers use painted metal, industrial halls and hangars corrugated steel, ruins rubble,
  markings and yards concrete. The observer bar got its own pill after the old full-width HUD
  strip was hidden.

Verification: server suite 165/165 (`ADMIT_OFF=1`; the rebel-camp test now asserts rebels are
absent), all Godot headless suites pass, rendered UI validation passed, and player, observer
and city close-up renders were reviewed for the new UI and textures. Not yet reviewed on screen:
water ports, recorded-impact craters, typed wrecks, flat tank fire, smoke field and the
synthesized audio by ear.

## Rebels removed, section I completed, UI redesign pass (2026-11-07)

Tested with the architecture and texture pass below. Old-save compatibility is no longer a goal
(no active play).

- **Rebels removed:** the rebel civilization is never created (`Game` ignores `rebels`; the worker
  passes `false`; the lobby option is gone). Prolonged unrest ends in riots or defection to a
  neighbouring empire; existing code already handled a missing rebel civ.
- **Section I (battles and warzone):**
  - Historical scarring channel (`g.scars`): the worst intensity a hex reached persists for about
    an hour after recovery, sent as `bf.hs` and drawn as a faint long-lived trace.
  - Continuous no man's land: the damage field is sampled through a low-frequency noise warp
    with a noisy threshold, so fronts read as irregular regions rather than hex patches.
  - Weapon-matched effects: machine-gun tracer volleys (staggered), heavier autocannon/flak
    tracers with dark flak airbursts, and rockets/missiles flying a flatter powered path with an
    exhaust smoke trail (`ROCKETS`, `rocket` effect kind).
  - Bounded smoke simulation (`render/SmokeField.gd`): a 44×44 world-space density grid around
    the camera, fed by server smoke records and visible combat events, advected by regional wind
    with turbulence, diffused and decayed, drawn as soft puffs; strategic zoom keeps the old puffs.
  - More intense battles from server behaviour: suppressed infantry out of cover move to better
    cover nearby, away from the threat (`autonomy.js`).
- **UI redesign (design system first):**
  - `NativeUI`: new palette tokens (slate panels, amber accent, teal info, green/coral status),
    translucent panels with soft shadows, ghost/primary button styles, styled popup menus,
    tooltips, inputs, slim scrollbars; `primary()`, `icon_button()`, `icon_for()` helpers;
    compact buttons build their own styles (previously copied Godot defaults) and get icons for
    common actions (move, attack, defend, explore, upgrade, repair, train, rally, follow…).
  - `NativeIcon`: ~30 vector icons on a 24-unit grid (build, army, research, overview, alerts,
    settings, move, attack, defend, explore, upgrade, repair, train, rally, follow, close, check,
    pause, play, city, industry, formation, info, time, weather, star).
  - Top bar (`NativeResourceStrip`, rewritten): one floating translucent pill with faction stripe,
    empire, era · clock · local weather; resource chips with icon, amount and coloured trend;
    an all-resources button; current research name with a progress bar; icon buttons for
    Overview (pages and map lenses), Alerts (count badge) and Settings. The old full-width bar is hidden.
  - Left rail: icon-first Build / Army / Research tiles with captions, key hints (B, T) and an
    active state while their drawer is open; positioned under the top bar.
  - Selection card: faction stripe, semibold title, centre-camera and close icon buttons, slim
    colour-coded health bar.
  - Drawer: sits beside the rail, semibold heading, icon close, "More options…".
  - Toasts: slim pills with a green or coral edge.
  - Hard-coded colours replaced with design tokens across the dashboard, labels, overlay, nav.
  - New-player checklist (`NativeOnboarding`): look around, open your city, place a building,
    move a unit, choose research; ticks from real actions, dismissable, remembered
    (`onboarding_done` preference), hidden in automated runs, keeps recent notes clear of it.

## Decisions, pace, direct fire, water ports and warzone pass (2026-11-07)

- **Decisions:** ports on the ocean hex; minimap stays removed; 10 Hz simulation; the warzone
  brief file is the source. The native-v4 ruleset is still unreleased, so these were folded into it.
- **Pace and AI:** `WORKS_TEMPO` (infantry 0.42, wheeled/tracked 0.47, construction and research
  0.45, production/training/growth 0.50); AI empires plan every 4 s (rebels 6 s).
- **Direct fire:** tank and fortress guns fire flat, fast shots with heavy muzzle blast, dust,
  recoil on the firing vehicle and a penetrating impact; artillery keeps its arcs.
- **Water ports:** placement on owned ocean hexes beside owned shore, embarkation by entering the
  port hex, freight landing on the shore, AI/governor via the same rule, piled deck rendering.
- **Warzone (brief §4–§11, §15, §18):** bounded saved impact records (class, local position,
  severity, seed) with fog-safe memory; scorch and aggregated vehicle/infantry wear channels;
  per-impact crater bowls that merge into basins, shallower on rock; rain pooling in bowls;
  terrain-specific scar colour (soil, rock, sand, wetland, urban rubble), scorch, ruts;
  type-specific wrecks; battlefield conditions in the hover inspector. Save format v2 migrates
  older battlefields (no impacts recorded until new fighting).
- **Also:** zoom-scaled hillshade for mountain mass, civic plaza at city tier 1+, presentation
  state reset on reload, V follows the selected unit.

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
