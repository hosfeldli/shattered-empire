# Shattered Empires Native — outstanding development and design backlog

Updated 2026-11-06. This is the consolidated backlog for the user's Living World Engine, streamlined
native redesign, simple UI, visual asset bible, persistent warzone brief, reference images and later
corrections. It records the intended outcomes and remaining work; it is **not** a claim that the
project is complete. Read alongside [CURRENT_WORK.md](CURRENT_WORK.md),
[LWE_REQUIREMENTS.md](LWE_REQUIREMENTS.md), [NATIVE_REDESIGN.md](NATIVE_REDESIGN.md),
[SIMPLE_UI.md](SIMPLE_UI.md), [RELEASE_GATES.md](RELEASE_GATES.md) and
[VERIFICATION.md](VERIFICATION.md).

The complete 21-section persistent-warzone design is recorded separately in
[PERSISTENT_WARZONE_BRIEF.md](PERSISTENT_WARZONE_BRIEF.md). It includes the continuation supplied
after the earlier truncated message and should be read together with the tasks in section I.

## Status, evidence and decision rules

- `[ ]` means the requested outcome still needs implementation, integration, quality review,
  acceptance testing, or some combination. A first pass, placeholder, one passing test, or a module
  with the right name does not complete a production-quality requirement.
- **Local partial** identifies a relevant feature in the uncommitted working tree as of this
  checkpoint. It still needs the acceptance and remaining work listed here. Existing implementation
  summaries are recorded in [CURRENT_WORK.md](CURRENT_WORK.md); test evidence is limited to the
  actual scenarios tested.
- The explicitly requested Windows and macOS **native preview** and compatible Cloud Run revision
  were published earlier; see [NATIVE_PREVIEW_RELEASE.md](NATIVE_PREVIEW_RELEASE.md). Later local
  work is not in those downloads or the deployed server. The preview is not evidence of complete
  parity or production-quality acceptance.
- Source inventory in the design references `hosfeldli/shattered-empire` at `8c03ba7`; the active
  working tree has evolved beyond that baseline and contains user work. Inspect its actual state
  and preserve it. Do not treat historical commit descriptions as current implementation reports.
- Godot native is the development target; the browser/Electron build is dead as a product and is
  reference only. The Node.js server remains authoritative. Do not develop a parallel browser
  renderer or silently change deployment configuration.
- Latest direct correction: **remove all trading**, including neutral imports and treaty-based
  trade. Domestic markets/commercial halls may generate ordinary credits and civilian activity;
  do not reintroduce resource purchasing or treaty mechanics. Government, policies, taxation,
  national workforce focus, treaty negotiation and alliances are not native player decisions.
- Latest direct building instruction: no visible building plates, raised foundation plinths or
  disconnected platforms. Buildings must be part of the terrain and never float. The pasted art
  bible also mentions foundations/platforms; apply terrain-conforming site grading, local ground
  cuts or unobtrusive structural integration without reintroducing the rejected building bases.
  Any necessary technical solution must preserve authoritative footprints and readable terrain.
- **Minimap (resolved 2026-11-07):** removed. Map lenses/navigation and their accessibility remain
  required.
- **Fog distinction:** atmospheric clouds and weather fog must fade at close zoom and not obscure
  play. The new request for thick clouds applies to *unseen fog of war*; implement it without
  exposing unknown terrain or obscuring units and orders in legitimately visible areas.
- **Ports (resolved 2026-11-07):** ports sit on the ocean water hex (native-v4): an owned ocean hex
  beside an owned dry shore hex; no lakes or rivers. Units embark by entering the port hex; freight
  lands on the adjacent shore. Earlier rulesets keep shore-hex ports and their saves.
- The initially truncated warzone brief was subsequently supplied in full; its terrain-specific
  damage, tracks, recovery, architecture, server changes, performance, UI, tests and definitive
  battlefield scenario are captured in [PERSISTENT_WARZONE_BRIEF.md](PERSISTENT_WARZONE_BRIEF.md).

## A. Shared design principles and architecture

- [ ] Deliver one coherent, deterministic, contextual, spatially continuous and scalable living
  world. Each representation considers identity, geography, adjacency, development, condition,
  history, activity, visibility and presentation scale, in that order where the higher-priority
  gameplay and identity constraints require it.
- [ ] Preserve three content classes: server-authoritative gameplay objects; visual state derived
  from server facts; deterministic decoration. Decorative alleys, rubble, pedestrians, trenches,
  soldier offsets and weather must not create paths, collision, cover, shots, resources or
  unauthorized information. Retain stable IDs and individual selectable buildings/units.
- [ ] Complete `WorldSemanticGraph`: terrain regions/features, rivers, settlements, districts,
  buildings, roads, bridges, rail, resource sites, units, formations, armies, battle regions and
  environmental regions. Add only relationships supported by authorized state: adjacency,
  transport connectivity, city/district membership, slope/coast/water, support, formation/army,
  battle/damage and historical development. Explain selected recipe, dependencies and conflicts.
- [ ] Complete versioned declarative recipes for geography, era, adjacency, level, condition,
  activity, materials, geometry, environmental response, animation, damage, LOD and validation.
  Hard authority/visibility/footprint constraints outrank soft orientation and decoration.
- [ ] Use world seed, entity ID, explicit recipe version and independent purpose channels for
  deterministic choices. Generation order, zoom, ownership and minor HP/population changes must
  not rearrange sites, paths, neighbors or damage. Persist compact layout/impact metadata only
  where reconstruction is insufficient, with explicit migration for recipe revisions.
- [ ] Keep the composition pipeline event-driven and locally invalidated. Separate structural
  changes from material/state changes; cancel superseded work, prioritize essential visible
  gameplay, prepare geometry off-thread only where safe, commit scene resources on Godot's main
  thread, and bound caches/jobs. Never rebuild the world because a frame rendered.
- [ ] Maintain orthographic 3D and native 2D controls for Windows and macOS; crisp text and
  essential tactical/resource indicators stay in screen space. No mandatory night cycle.

## B. Camera, selection, visibility and input

- [ ] **WASD/camera — local partial:** review accelerated/decelerated, frame-rate-independent pan
  for feel on keyboard, edge pan, drag, focus, zoom anchor, wrap and camera boundaries. Remove
  residual jolt, drift, velocity carry-over and excessive movement when opening panels or changing
  FPS. Respect reduced-motion settings and remappable bindings.
- [ ] **Zoom/unloading and ground loss:** reproduce and fix disappearing map/ground when zooming,
  including close view around city-center hexes immediately after world reload. Keep terrain,
  buildings, labels, selections and wrapped copies present throughout camera/LOD transitions;
  investigate the user's original screenshot and report, not only synthetic samples. Ensure
  reload resets stale weather/fog/material/cache state and never causes pink/purple unexplored fog.
- [ ] **Formation line — local partial:** validate continuous per-frame overlays, wrapped endpoint
  selection, right-drag placement, Tab facing reversal, camera/zoom movement while drawing,
  multiple formations and terrain slopes; avoid moving/jolting or selecting the wrong seam image.
- [ ] **Follow camera — local partial:** expose an understandable follow/stop control for selected
  infantry and vehicles; track interpolated authoritative motion across seams and terrain, handle
  air/ground units, disappearance/death, selection changes, pause and reconnect. Manual camera
  input should predictably cancel or override follow without a jump.
- [ ] **Alt tile inspector — local partial:** show compact, fog-safe terrain, known resources,
  actual relevant movement/crossing restrictions and costs by movement type, and farm suitability
  rather than implying that terrain fertility alone guarantees a legal farm. Include owner and
  useful slope/defense/road details only when authorized; position and dismiss it reliably.
- [ ] **Local partial (2026-11-07):** hazy faction border band + edge line from last-known tile owners, zoom-scaled, toggleable. Add a subtle, faction-colored, hazy territorial boundary with legible ownership at all
  applicable scales and fog-safe last-known boundaries. Do not paint entire buildings/terrain in
  saturated faction colors or reveal hidden ownership changes.
- [ ] Show actual city development/placement edges when a building tool is active. The boundary
  must use the authoritative city/ownership/buildability rules, not a guessed circular radius.
  Explain which city/site is affected; handle overlapping cities, rivers, occupied hexes and wrap.
- [ ] **Local partial (2026-11-07):** procedural lit cloud sea over unknown cells, billowing known-side edges. Fog of war: implement tasteful thick-cloud coverage for truly unseen regions, with clear
  boundaries and no shimmering, transparency leak or misleading pink/purple colors. Previously
  explored terrain retains only legitimately remembered information. Visible combat/selection
  and controls must remain clear at close and wide zoom.
- [ ] **Enemy last-seen buildings — local partial (2026-11-07):** server-side bounded saved viewer memory, quiet frozen records; remaining: reconnect/alliance/spectator review and visual marking. save a viewer-specific snapshot of a structure's last visible
  type, owner, level, construction, damage and relevant appearance; render that frozen snapshot
  after sight is lost. Do not silently update, delete, animate hidden production, play audio or
  reveal capture/destruction/upgrades until visible again. Reconcile on resighting, save/reload,
  reconnect, alliance/ruleset changes and spectator permissions. Do not expose live hidden state
  in client packets; use bounded versioned server-side fog-filtered memory as necessary.
- [ ] Validate direct controls: left-click/drag select; right-click move or contextual attack;
  E attack-move; Shift queues; H hold; X withdraw; Q on-screen combat; G create army; B build;
  R roads; T research; Space center; Escape cancel; right-drag formation; Tab reverse while
  drawing. Resolve/remap shortcut conflicts and preserve selection when appropriate.

## C. Building, road, bridge and trench tools

- [ ] **Build placement — local partial:** show all relevant nearby authorized legal hexes, the
  recognizable actual finished 3D model, correct footprint/orientation/terrain, costs/time and
  green/red/amber outlines and concise server-derived reasons. Do not obscure it with a solid
  colored block. A stable adjacency-aware preview must match the committed district layout.
  Validate camera movement, large/complex maps, clipping, seam and low FPS without popping.
- [ ] One click submits, server acknowledgement creates the real site, Shift repeats, and supported
  drag places groups. Handle pending, affordability, shortages, per-site failures and rejection
  without duplicate commands, hidden failures, lost selection or fake success.
- [ ] **Roads/trenches — local partial:** clearly mark *which* segments/hexes fail and why, keep or
  reopen the relevant editable construction UI after any server failure, preserve waypoints and
  offer correction/retry/cancel. Test stale preview replies, endpoint restrictions, partial road
  plans, continuous trench rejection, destroyed bridges, resources, zoom/pan and wrapped routes.
- [ ] Roads: dirt, paved, highway and railway continuous terrain-following previews/final meshes;
  widths/materials/shoulders/tracks; road/rail junctions, graded approaches, city access and
  authorized connectivity. Forest roads clear vegetation in the actual corridor and regrow only
  when authoritative/visual state warrants it. **Local partial:** corridor tree clearing exists;
  validate changes, destruction, wrap and far-LOD canopy rather than clearing a whole forest tile.
- [ ] Bridges: select legal banks and show the whole class-specific timber, reinforced-road or
  railway deck and supports before confirmation. Add coherent approaches, traffic, construction,
  damage/broken span and repair stages. No implied crossing over an unauthorized river.
- [ ] Trenches: one continuous ordered, terrain-following excavated channel, not an accordion;
  physical recessed floor/walls, spoil, parapet, revetments, access, junctions and occasional
  purposeful traverses. Show real survey/clearing/shallow/deep/reinforcement/completed progress,
  work fronts and bounded representative crews/machinery; halt on missing materials. Do not let
  scattered segments finish ahead of their accessible fronts. Support branch connections,
  local collapses, rain/mud, repair and seamless horizontal wrap.
- [ ] Integrate guard posts, bunkers, fortresses and AA emplacements with adjacent trenches using
  coherent geometry, entrances, berms and junctions. Existing cosmetic links must not imply
  functional access, protection or supply that the server does not support. Validate partial,
  destroyed, occupied and upgraded structures separately.

## D. Terrain, hydrology, resources and environment

- [ ] Continuous shared-edge, chunked authoritative terrain: connected mountains/ridges and
  passes, hills, valleys, plains, wetlands, deserts, tundra, volcanic soils/landmarks, shorelines,
  rivers, lakes and oceans. Mountains need visible height and mass at strategic zoom without
  cone-per-hex spikes, hidden passes or concealed important units. Use slope-aware rock, forests,
  climate-supported snow/scree and daylight shadows; avoid changing gameplay traversability.
- [ ] Maintain valid shared mesh boundaries, elevation sampling and wrap under terrain changes,
  reconnect and varying LOD. Reproject roads, vegetation, buildings and other dependent local
  geometry when authoritative terrain changes. Avoid floating structures or visible hex plates.
- [ ] Rivers: continuous channels/banks, curves, flow direction, bank materials/vegetation,
  compatible slopes, widths, bridge approaches and subtle motion. Buildings and newly founded
  settlements must never occupy river hexes; preserve existing saves and explain rejected sites.
- [ ] Lakes: continuous connected water surface and compatible level/shore transitions, including
  chunk edges and world wrap; avoid separated visible hex patches. Oceans: subtle fine-grained
  wind/current/rain response, broad swell, believable reflections, shallow depth and shoreline
  foam. Avoid cartoon waves, bright blobs, jarring repetition and distant readability loss.
  **Local partial:** fluid/micro-water and lake continuity have prototypes; validate quality,
  simulation stability, cost and seam behavior across weather and zoom.
- [ ] Resources: oil, iron, coal, rare earths, stone, fish and old-world ruins need recognizable
  physical deposits, appropriate sites and sharp icons when relevant. No new deposits on rivers;
  **local partial:** deterministic relocation exists for new maps. Test seeded fairness, starting
  resources, saved worlds, geological change and ocean fish. Icons should be subtle and appear
  during settler or build placement; otherwise rely on visible geological cues and contextual
  inspection rather than permanent intrusive banners.
- [ ] Forests: believable dense, varied clusters, edge gradients, clearings, altitude/climate and
  wind response; improve trees beyond simple cones. Respect roads, rivers, trenches, buildings,
  damage, recovery and LOD without regenerating unrelated regions. Roads clear only their
  corridor. Use region-partitioned instancing and budgets.
- [ ] One weather context drives regional clouds, projected shadows, wind, rain/snow, wetness,
  smoke, foliage, ground, roads, rooftops, craters and water. Use gradual regional transitions and
  world-wrap continuity. Clouds fade out close up; weather never veils selected units, tactical
  labels or cursor. Keep daylight, restrained bloom/fog and no invented recurring disasters.

## E. Cities, districts, history and civilian life

- [ ] Derive a stable settlement plan from actual center, tier, roads, buildings, terrain,
  waterways, population, era and history. Real roads anchor development; decorative streets may
  fill valid land but never grant a route/crossing or suggest functional infrastructure.
- [ ] Adjacent Housing Blocks form recognizable connected streets, shared walls/rooflines,
  courtyards, gardens and era-appropriate parking while retaining individual IDs and selection.
  Neighbor upgrades and destruction must not reshuffle the street.
- [ ] Farms form fluid connected fields/rows and merged estate boundaries following terrain,
  without repeating a barn on every hex or placing fields across rivers. Improve the current
  jarring farm model, crop/field transitions, agricultural activity and upgrade/damage behavior.
- [ ] Factories, warehouses, mills and related industry form coherent compounds with shared yards,
  freight access, pipes/utilities and loading areas only where justified. Preserve each building's
  function, owner, damage, activity and selection; connect naturally to real roads, rail and port.
- [ ] Universities and academies join better into recognizable modern campuses with laboratories,
  teaching halls, paths, landscaping and related civic squares. Markets form commercial streets;
  compatible mixed uses transition naturally. Quarry and mine designs must look excavated and
  match slope/deposit, with benches, conveyors/haul paths and meaningful upgrades.
- [ ] Town, City, Metropolis and Megacity development is distinct from building levels 1–3. Growth,
  construction, modernization, ownership, destruction and recovery must be incremental, stable,
  individually selectable and historically legible; older structures do not instantly change era.
- [ ] Show purposeful, bounded pedestrians, cars, carts, vans, freight and service vehicles on
  plausible paths: homes/workplaces/markets, industry, construction, farms, rail and ports as
  relevant. Density and activity follow actual population, employment, production, roads,
  weather, occupation and damage. Do not invent deliveries, drive through destroyed bridges or
  require thousands of simulated citizens. Validate visibility at useful zoom and city growth.
- [ ] Operating machinery, smoke, loading, construction and material indicators reflect actual
  staffing, resources and progress; inactive/ruined sites stay quiet. Positive production popups
  use the right resource icon and measured output, appear only around close/one-third zoom, are
  subtle, infrequent, slow enough to read, bounded, and never imply fabricated rewards.

## F. Era-specific art, building assets and materials

- [ ] Lock visual language to stylized realism and a **modern post-collapse** setting. Reclamation
  uses repaired contemporary concrete, containers, salvaged steel/glass, modular housing and
  improvised modern equipment; avoid medieval, steampunk and WWI styling. Industrial Recovery
  standardizes restored industry; Mechanization develops modern blocks, vehicles, rail/highways;
  Networked Warfare adds practical sensors/automation; Advanced Systems adds grounded robotics,
  fusion, composites and arcology. No magical sci-fi props or instant whole-city era swaps.
- [ ] Production-audit **all 34 authoritative building definitions**, including their stable ID,
  recognizable silhouette, appropriate era/level, authored or justified legacy asset, preview,
  icon, selection proxy, environment/site integration, operational/inactive state, construction,
  animation, damage/ruin/rebuild, audio, LOD, deterministic identity and save/reconnect behavior.
  Do not mistake existing primitive placeholders for finished art:
  - Reclamation/civic: `town` Settlement Hub, `house` Housing Block, `farm` Farm, `lumber` Timber
    Mill, `quarry` Quarry, `salvage` Salvage Yard, `barracks` Barracks, `market` Market/Commercial
    Hall, `academy` Academy, `port` Port, `guard_post` Guard Post, `bunker` Bunker.
  - Industrial Recovery: `mine` Mine, `steel_mill` Steel Mill, `power_plant` Power Plant,
    `oil_well` Oil Well, `munitions_plant` Munitions Plant, `motor_works` Motor Works,
    `depot` Supply Depot, `fort` Fortress, `university` University. `depot` remains legacy-only;
    do not put it back into the ordinary build palette absent a rules change.
  - Mechanization: `aa_battery` AA Battery, `refinery` Synthetic Fuel Refinery, `heavy_assembly`
    Heavy Assembly, `airfield` Airfield with actual runway/taxi/servicing presentation.
  - Networked Warfare: `electronics_plant`, `comms_tower`, `drone_works`, `shield_generator`.
  - Advanced Systems: `fusion_plant`, `robotics_complex`, `missile_silo`, `wonder` Continental
    Arcology. `camp` Rebel Camp is an irregular modern rebel-only asset, not player construction.
- [ ] Use recognizable functional features: settlement hub as repaired modern civic center;
  housing as modular/apartment stock; farms and timber/quarry/salvage as practical works; modern
  barracks/guard posts/bunkers and concrete fortress; mills, power, oil, ammunition and motor
  works as distinct credible industrial processes; modern university campus; correct airfield,
  AA, drone, comms, shield, fusion, robotics, underground silo and integrated arcology silhouettes.
- [ ] Build a reusable quality material library for soil, grass, sand, stone, rock, mud, asphalt,
  concrete, brick, timber, steel, painted metal, glass, composites and rubble. Use credible
  **prebaked** licensed/authored albedo, roughness and normal maps; do not ship obviously poor
  generated textures or leave surfaces untextured. Keep physical scale consistent; use triplanar
  mapping and atlases where appropriate, controlled weathering/rust/scorch and restrained faction
  accents. Review resolution, UVs, filtering and repetition at close/strategic zoom.
- [ ] Use optimized authored reusable glTF/components with consistent scale, origins and pivots;
  stable recipe/gameplay IDs rather than display-name lookup. Asset review asks: what is it, what
  does it do, where is it, how developed/damaged is it, and does it preserve readability?

## G. Construction, repair, damage and recovery

- [ ] Show server-driven site preparation → ground work → structure/frame → exterior/equipment →
  complete, with materials, workers and machinery where actual progress/activity allows. Small
  and large buildings, roads and bridges need appropriate variants; stalled or cancelled work
  must not look complete. No decorative buildings floating over the terrain or sitting on plates.
- [ ] **No instant upgrades or repairs — local partial (native-v4):** timed paid works, engineer acceleration, halt under fire, cancel/refund, persistence; remaining: pause/priority, AI/governor tuning, balance. design authoritative time-based construction, repair and
  upgrade projects. Engineers may accelerate work; without engineers the player may wait for
  ordinary crews as balanced. Charge materials correctly, support pause/cancel/priority and
  interruption, persist progress and prevent damage/bonuses taking effect prematurely. Migrate
  saves/rulesets explicitly and update player commands, AI, governors, UI estimates and tests.
- [ ] Damage follows real HP/state: intact, light, moderate, severe and ruined with recognizable
  identity. Make material-specific cracked concrete/rebar, broken brick, bent steel, timber and
  glass, roof collapse, scorch, rubble, fire and repair. Neighboring buildings and shared walls
  take only their own server-authorized damage; reconstruction fills gaps locally.
- [ ] Use bounded visibility-filtered significant impact metadata where actual localization is
  required, or deterministic damage selection when exact impacts are unavailable. Never invent a
  precisely located hit. Preserve damage appearance after save/reload, occupation and recovery.
- [ ] Cosmetic rubble/earthworks never alter pathfinding, cover or ownership. Functional
  destruction, roads/bridges, fieldworks, movement or defense changes come from the server.

## H. Military units, formations, control and emplacements

- [ ] Production-audit all **23 authoritative unit types** for silhouette, scale, faction markings,
  terrain fit, movement/idle/deploy/fire/reload/suppression/retreat/repair animations, health and
  destruction, event-based muzzle points/effects/audio, portraits, selection and tactical/
  operational/strategic LOD. Represent squads/swarms with bounded figures; never add gameplay
  soldiers or damage. Preserve authoritative formation slots and movement interpolation:
  - Reclamation: `colonist`, `engineer`, `scout_buggy`, `militia`, `rifle_squad`.
  - Industrial Recovery: `mortar_team`, `armored_car`, `supply_truck`, `field_gun`.
  - Mechanization: `mech_infantry`, `tank`, `sp_artillery`, `helicopter`, `fighter`.
  - Networked Warfare: `recon_drone`, `missile_battery`, `bomber`, `oneway_drone`, `air_defense`,
    `special_forces`.
  - Advanced Systems: `autonomous_tank`, `strike_swarm`, `exo_infantry`.
- [ ] Ensure vehicle wheels/tracks, suspension, turret traverse and cannon recoil; realistic
  artillery setup, load/fire/reposition; infantry posture and weapon handling; aircraft
  takeoff/landing/banking/rotors; supply and engineer work; role-specific wrecks. Equipment is
  modern or advanced engineered, not historical fantasy. Keep comparable roles recognizable.
- [ ] Formation line, column, wedge and box honor actual slots/facing, maintain coherent marching
  and support positions, handle corrections/seams, and scale to army markers without losing unit
  identity. A selected formation clearly communicates direction, orders and readiness with
  restrained icons; army operations should not require individual-unit babysitting.
- [ ] Support multiple compatible friendly troops on a position according to an explicit,
  server-authoritative stacking/capacity design. Audit movement/pathing, combat targeting,
  visibility, collisions, UI selection and balance; do not infer unlimited capacity from visual
  offsets. Troops must be able to enter, occupy and leave suitable defensive emplacements, with
  observable capacity/cover/firing behavior. Add authoritative emplacement upgrade projects.
- [ ] **Attack / Defend / Explore:** preserve player direct orders; make idle behaviors useful,
  understandable and recoverable. **Local partial:** Explore avoids unreachable/partial paths;
  validate long exploration, different terrain/movement classes, changing roads, naval access,
  formations, save/reconnect, no busy-loop and no hidden-information leaks. Defenders choose and
  hold useful cover/lines; attackers use cover while engaging or close distance when none exists.
- [ ] **Local partial (native-v4):** 0.82× movement, 0.85× HP; behaviour remains open. Mortar/artillery squads should be slower and less durable relative to comparable forces,
  with versioned server balance and tested costs/retreat/supply; they should intelligently remain
  behind aggressive troops and reposition when threatened, without overriding direct player
  orders or learning unseen enemies. Do not merely change rendering speed/health.
- [ ] Troop badges remain separate, compact circles over the actual tile/formation, with dynamic
  type/composition/count, ownership, health and selection. Avoid overlap, screen domination,
  zoom jitter, stale hidden enemies and misleading representative figure counts.

## I. Battles and persistent warzone evolution

- [ ] Maintain three linked layers: authoritative battlefield state/events; incremental warzone
  composition; transient event-driven combat presentation. Existing server battlefield intensity,
  impacts/craters, wrecks, smoke/visibility, cover, movement, fieldwork, road/building damage and
  recovery are the starting point. Client effects never determine damage or create false cover.
- [ ] Replace the “100 mole holes” look with one continuous, irregular battlefield density field
  driven by connected damaged regions and actual impact history. Preserve stable regional
  identity, terrain, vegetation, roads, buildings, active/abandoned state and historical scars.
  **Local partial:** continuous scar coloring and terrain deformation work were started. The
  latest crater prototype and its tests were interrupted and have not been validated; it is not
  evidence of completed physical craters or the full warzone system.
- [ ] Create independent material/state channels for disturbance, crater damage, scorch,
  vegetation loss, vehicle wear, debris, soil exposure and historical scarring. Derive wetness
  and snow from the shared weather state. Rifles disturb ground without craters; vehicles leave
  appropriate tracks; actual explosives cause appropriate crater/scorch; wrecks and ruined
  buildings contribute material-specific debris. Blend across neighboring regions and wrap.
- [ ] Progressive server-driven states: natural → disturbed → heavily contested → devastated;
  existing intensity thresholds 15/40/75 are calibration starting points, not instant visual
  switches. Gradually flatten/destroy vegetation, expose soil, merge impact fields, add wrecks,
  damage infrastructure, accumulate mud/water in rain and preserve longer-lived scars. Recover
  only as authoritative history/recovery permits, without restoring functional obstacles early.
- [ ] Match damage to forest, grassland, mountain rock/scree, desert, marsh and urban terrain;
  use appropriate broken trees, tracks, mud, paved/street damage and industrial debris rather
  than painting every battlefield as an identical muddy field. Never invent permanent lakes.
- [ ] Aggregate tracked-vehicle, wheeled-vehicle and infantry traffic wear; store only significant
  persistent wear, use bounded close-range transient marks, and do not damage roads from ordinary
  traffic. Weather, crater pools, drying, snow and smoke use the shared regional weather context.
- [ ] Preserve event-to-impact identity and bounded significant impact records with category,
  severity, local location, stable visual seed, creation time and revision when warranted; support
  existing-save migration, visibility filtering and batched local geometry/material updates.
- [ ] Type-correct persistent wrecks and debris need stable burned, damaged and heavily ruined
  variants; burning and smoke end according to actual state while wrecks remain until cleared.
  Roads, bridges, buildings and trenches show their own authoritative damage and repairs.
- [ ] Expose crater cover/vehicle slowdown, damaged trench repair and supported wreck cleanup in
  small contextual UI; integrate damage with the existing Tactical/Front Lines lens without a
  new tab or permanently visible heatmap.
- [ ] Implement true terrain-aware 3D craters at tactical zoom with irregular depressed centers,
  sloped walls, displaced rim, ground shadows, debris and optional pooled water. Vary by actual
  mortar, artillery, bomb, missile or strategic impact. Merge overlapping depressions into shared
  basins/material masks, update only affected chunks and preserve save/reload. No craters from
  rifles or airburst-only attacks; no new gameplay elevation/passability without server authority.
- [ ] Artillery/mortar trajectories originate at the actual visible firing troop/model muzzle and
  arc to the authorized impact using real event timing. **Local partial:** visible source position
  is used where the event exposes it. Validate muzzle attachments, moving troops, all weapons,
  timing, projectile visibility, wrap and fog-hidden shooters; never reveal a hidden source.
- [ ] Match rifle/machine-gun/autocannon, cannon, mortar, howitzer, rocket, guided missile, bomb,
  AA/airburst, air-to-air, drone and strategic missile effects to authoritative fire/impact types.
  Add bursts and repeated visible firing, convincing recoil/flash, powerful vehicle fire, dust,
  restrained camera shake and appropriately delayed impacts without generating extra damage.
- [ ] Implement bounded smoke/fog **simulation** for weapon smoke and battle plumes, driven by
  actual events and shared wind/weather; current simple wind-drifting puffs are not that system.
  Improve fire, embers, debris and destruction, scale with importance/distance/LOD, prevent
  unbounded particles and keep selections, enemies, order previews and labels readable.
- [ ] Make battles more intense through authorized sustained fire, suppression/reactions,
  intelligent cover/rush/reposition, formation movement, artillery support and persistent
  consequences. Tune server combat/AI separately from visual effects; do not manufacture extra
  shots, hidden AI knowledge or endless inflated-HP firefights. Retreat and recovery stay viable.

## J. AI, city automation, economy and pacing

- [ ] AI is for player enjoyment: imperfect, human-like, understandable and varied by personality
  and difficulty; it should make believable mistakes and create memorable challenges without
  cheating fog, changing orders constantly or playing with perfect information. Calibrate and
  test easy-to-hard behavior and disclosed advantages against actual player experience.
- [ ] **City count — local partial:** discourage colonist spam. Target 1–2 self-founded cities in
  early game, 3–4 midgame, and 5–8 late game without conquest; count and handle captured cities
  sensibly. Existing era-based preferred counts need seeded campaign/economy and personality
  validation; this is an AI preference, not a hard cap on the player or captured settlements.
- [ ] AI plans defensible, functional and visually coherent city districts, roads, rivers,
  resource sites and industry. It prepares trench lines in plausible intended fighting areas,
  not unrealistically close to unseen enemies; stages forces and makes defensive stands along
  completed/partial authoritative works. Respect supply, fog, engineering time and construction
  budgets; avoid perfect omniscient placement and repetitive or excessive defenses.
- [ ] **Mayors — local partial:** automatically address real housing, food, production, materials,
  staffing, research, repairs and infrastructure needs, not just three houses then stop. Use the
  selected Balanced/Agriculture/Industry/Military preference, available workforce and actual
  bottlenecks; respect disabled mode, budgets, explicit blocked sites and player reservations.
  Avoid overbuilding, unstaffed factories, unauthorized military spending and repetitive prompts.
  Explain genuine caps or shortages rather than fabricating growth.
- [ ] Preserve simplified economy/research, production chains, logistics, automatic workforce,
  city growth, roads/bridges/rail, training, formation, weather and battles. Remove all trading,
  imports, treaty dependencies and dead government technologies from native gameplay and UI;
  scarce-resource regions need viable non-trade progression using actual game rules.
- [ ] Slow movement, material accrual, production, research, construction, training and growth
  deliberately through centralized server-side, independently tuned rates. Artillery/mortar
  should be slower still. Avoid double-penalizing fuel or creating famine by mismatching baseline
  production/consumption. Keep input/network interpolation responsive and simulation cadence
  separate from game speed.
- [ ] Review pathfinding timeouts, congestion, repathing, AI mission commitments, formation
  synchronization, supply/fuel, air operations, morale, retreat, pursuit and conflict resolution
  under slower rates. Use persistent strategic missions with reactions to meaningful changes.
- [ ] Rebalance/measure era milestones as initial targets: Industrial Recovery 18–25 min,
  Mechanization 30–45, Networked Warfare 50–75, Advanced Systems 75–110, adjusted if the later
  request for an additional slowdown changes the agreed target. Measure sustainable food,
  population, city growth, common builds, military training, roads, trenches and representative
  routes; prevent starvation, stagnation or a progression dead end.
- [ ] Rivals presents only known civilization, relationship, observed conflict, posture and coarse
  legitimately discovered focus; show Unknown when unsupported. Permit deliberate attack with
  clear hostility confirmation, disengagement and reasonable server-driven war resolution; no
  treaties, tribute, negotiations, gifts or invented hidden AI information.

## K. Compact native UI and gameplay parity

- [ ] Match the supplied dark, restrained reference-image UI while keeping the living world
  dominant. Use a compact top bar (civ/era, essential resource icons/totals, research, time,
  alerts, settings), three clear Build/Army/Research controls and contextual selection cards.
  No permanent inspector/full-height sidebar or ambiguous button overload. Confirm scaling,
  contrast, native-resolution text, discoverability and responsive controls with real players.
- [ ] Build palette: five expandable City, Resources, Industry, Roads/Infrastructure and Defense
  groups, recognizable thumbnails, short names, costs and availability; selecting immediately
  activates the faithful 3D preview. Build → select → click; no ordinary extra confirmation.
- [ ] Troop creation/queue UI: selected barracks/factory offers Train and Rally clearly, with unit
  silhouettes, cost and one-click queue, clear pending/rejection and visible queue/progress only
  when relevant. Support Shift quantity, compact expandable quantity/per-building/repeat,
  multiple selected producers, cancel/refund/rally and all unlocked eras. Validate that users can
  actually discover and understand queue state.
- [ ] Selection cards expose direct context: city Build/Manage/Production and actionable problems;
  building Upgrade/Train/Repair; unit Move/Attack/Defend/Explore and relevant detailed commands;
  army Move/Defend/Attack plus More; infrastructure condition/repair/cancel. Double-click same
  building type and mass upgrade must work even with units overlapping, retain selection, report
  per-entity failures and obey the future timed-upgrade rules. **Local partial:** overlap fix and
  batch command tested; production UX and timed behavior remain open.
- [ ] Research: readable visual tree for all five eras, prerequisites, unlocks, cost/time, search,
  selection, one-click research and compact queue. Remove government-only dead prerequisites;
  validate late-game unlocks and visuals, dependencies and meaningful pacing.
- [ ] Overview provides Cities, Economy, Rivals and Chronicle without permanent workspaces;
  detailed production, shortages, infrastructure, supply, training/aircraft and history remain
  available contextually. Shortage warnings provide cause and actionable location/build steps.
  No Government, trade, diplomacy or market-purchase screens.
- [ ] Alerts: critical, actionable and informational levels; only urgent attacks/disasters/
  strategic weapons interrupt. Routine completion is unobtrusive and historic; click relevant
  alerts to locate the real object. No noisy server-allow/connection messages in normal play.
- [ ] Settings: graphics presets, UI scale, weather/particles, reduced motion, screen shake,
  high-contrast selection, unit labels, resource markers, faction cues, independent audio and
  remappable keys. Preserve full screen/windowed behavior and accessibility/readability.
- [ ] Map lenses and hide-UI mode remain discoverable. Resolve the minimap contradiction above.
  Retain useful old-build functionality through native UI: single-player, multiplayer, lobby,
  invite/match code, Steam where applicable, tutorial, sandbox, observer, reconnection and
  spectator AI speed controls with eligibility/authority; do not restore obsolete trade/government.
- [ ] Run an explicit old-build action/feature parity matrix against the streamlined native scope;
  include eligibility, cost, command result, pending/rejection, safe confirmation and no dead
  controls. Every ordinary action should be achievable without three management screens.

## L. Audio

- [ ] **Local partial (2026-11-07):** 26 original synthesized CC0 sounds, layered perception-driven beds, separate buses. Add appropriately licensed free/environmental audio for wind, woodland/birds, coast,
  rivers, city/civilian traffic, industry, construction and distant combat; make density depend on
  legitimately visible/local activity, terrain and zoom. Record source, creator and license for
  every asset. **Local partial:** one CC0 countryside bed exists; the complete mix is open.
- [ ] Add appropriate utility/heavy diesel/tracked/electric/drone/rotor/aircraft and freight
  sounds, plus distinctive rifle, MG, cannon, mortar, artillery, explosion and vehicle destruction
  audio. Attenuate by distance/zoom, prioritize important events, cap voices and avoid hidden
  combat information. Provide separate ambience/effects controls, mute and comfortable levels.

## M. Networking, persistence, server scaling and release

- [ ] Negotiate optional native geometry/state fields without silently changing older clients;
  server filters terrain, rivers, weather, historical impact and last-seen records per viewer.
  Every record needs stable identity, scope/visibility, revision and dependencies. Avoid sending
  thousands of decorative components or exact hidden AI plans.
- [ ] Preserve ruleset-aware saves and reconnects, legacy saves and explicit migrations for
  gameplay changes, slow tempo, trench progress, construction/repair/upgrade, emplacement
  occupancy, visual identity and warzone history. Rejoin first reconstructs essential nearby
  authoritative state, then fills distant decoration; repeated reloads do not reshuffle cities.
- [ ] Profile and improve high-load Node simulation, pathfinding, AI, battlefield updates, snapshot
  filtering, encoding, memory, worker isolation and network fan-out. The user asks for extremely
  complex late games and **10 ms updates for every troop**: define whether this is a simulation
  cadence, end-to-end latency or compute budget; benchmark and engineer toward it without claiming
  that the existing 10 Hz simulation meets a 10 ms update interval. Test concurrency, long sessions,
  recoveries and horizontal/vertical scaling, with hardware/workload and p95/p99 reported.
- [ ] **Unattended matches — local partial:** worker stops simulation when no player or spectator
  is connected; watching AI counts as human presence; preserve requested speed and manual pause,
  reconnect, autosave/parking and multiplayer connection replacement. Validate crashes, server
  restarts, multiple spectators and no loss of unsaved progress.
- [ ] Final product release remains gated on UI/gameplay parity, complete living-world/LOD/
  destruction/city/troop/battle work and quality validation. Rebuild both downloads from one
  recorded revision, publish them at `game.liamhosfeld.com`, deploy the compatible Cloud Run
  server, preserve other downloads, and verify actual URLs, artifact hashes, health, capability
  negotiation, real native match/reconnect and rollback. The existing preview is already live;
  it does not include the latest uncommitted changes. Windows/macOS signing and platform-specific
  validation were explicitly excluded from the earlier immediate development request, but remain
  separate release considerations, not a reason to skip game quality or gameplay validation.

## N. Tooling, acceptance and execution order

- [ ] Developer recipe inspector: entity ID, selected rules/preconditions, geography/adjacency,
  seed/version, materials, damage, LOD, cache revision, invalidation dependencies and generation
  timing. Add district/road/parcel/shared-wall/invalid-transition overlays.
- [ ] Fixed-seed native scenes/screenshots for flat, mountain, river and coastal cities; industry,
  farms, mixed eras and destroyed neighborhoods; trenches, heavy artillery, large moving armies
  and the wrap seam. Regression checks cover selection, terrain seams, clipping, text, shadows,
  damage, connectivity and controlled animation times; use meaningful tolerances.
- [ ] Terrain acceptance: recognizable continuous ridges, lake/ocean/river continuity, valid
  slopes, grounded buildings, road/bridge approaches, correct coast/port, no river buildings or
  resource spawns, and no pop/unload across zoom, reload or world wrap.
- [ ] City/economy acceptance: compatible districts merge without losing IDs; upgrades or damage
  stay local; historic architecture persists; citizens/traffic follow valid connections; economy,
  growth, staffing, shortages and automation are legible and sustainable without trading.
- [ ] Military/combat acceptance: authoritative formation spacing/facing and stacked-unit rules;
  understandable troop composition; real Explore; AI cover/defensive stands; projectile origin
  and impact; no extra shots, unauthorized crater, hidden data or decorative movement obstacles;
  battlefield persistence, recovery, rain response, bounded effects and unobscured commands.
- [ ] Controls acceptance: B→building→click; select producer→Train→unit; select→right-click;
  right-click enemy; right-drag formation; road/trench draw→preview→confirm; rejected work opens
  editable UI with exact reason; select→repair; double-click→batch upgrade; T→technology;
  shortage→cause/action; Alt details; follow camera. Validate keyboard/mouse, scaling and focus.
- [ ] Performance acceptance: bounded local generation, cache/memory and particles; no full-world
  rebuild for one city; all presets retain gameplay information; close/strategic readability and
  input responsiveness; sustained large cities and battles, representative lower-end hardware,
  server scaling and the explicitly requested 10 ms target. Existing local four-match 256×256,
  12-empire test met its **100 ms** budget with p95 26.73–34.91 ms, not the new 10 ms goal.
- [ ] Integrated, actual-server vertical slice: one modern recovery settlement; connected housing,
  farms and active industry; mountain ridge/forest/deposit/mine; river and real bridge; functional
  economy, workers and vehicles; infantry/armor/artillery/supply formation; progressively dug
  trench and defensive emplacements; active battle, craters/wrecks/ruins and recovery; weather,
  moving water and wind-driven smoke; complete minimal UI. Upgrade, damage, bridge loss, weather,
  save/load and reconnect must all match simulation truth and preserve visual identity.
- [ ] Prioritize a playable, testable vertical slice and authority/data contracts, then resolve
  camera/input and placement reliability, production-quality modular assets and district logic,
  server projects/AI/warzone state, military/combat/environment, complete UI parity, and finally
  workload-specific optimization and release. Work incrementally; a section is closed only when
  its implementation **and** acceptance evidence meet the user's stated outcome.

## O. Detailed asset-design intent by gameplay ID

These are production-art and behavior targets for each item, not assertions that a current
placeholder meets them. Apply the universal asset, era, state, LOD, selection, audio, authority,
material, animation and persistence requirements above to each entry.

### Buildings: Reclamation and early defenses

- [ ] `town` — recognizable repurposed modern municipal/commercial hub, repaired concrete,
  antennas, utility containers, storage and modest civic space; expand surrounding activity and
  campus with city tier while preserving its original identity, damage and repair.
- [ ] `house` — modular homes/repaired apartments at level 1, expanded residential block at level
  2, denser level-3 apartments; merge neighbors into shared streets, walls, gardens and courtyards
  while keeping each block selectable, historically stable and independently damaged.
- [ ] `farm` — connected terrain-following crop fields, practical agricultural buildings, storage,
  repaired machinery and access tracks; later modern equipment/irrigation, crop and work activity
  from real production, and shared barns/facilities rather than a copy on every neighbor.
- [ ] `lumber` — contemporary salvaged sawmill, sawing machinery, logs, loading and open sheds
  near real forests; show wood handling and freight only while active.
- [ ] `quarry` — believable excavated rock faces, benches, piles, processing and haul road embedded
  into terrain; expand the working area/equipment by upgrade, with conditional loading and dust.
- [ ] `salvage` — organized recovery yard with recognizable modern wrecked vehicles, concrete,
  reusable components, sorting equipment/cranes and activity; avoid random generic junk scatter.
- [ ] `barracks` — modern repaired/prefabricated accommodation, training ground and equipment
  compound; later standardized campus, real train/rally states and representative activity.
- [ ] `market` — repaired storefronts, covered commercial space and storage that becomes a
  coherent shopping/distribution street with pedestrian and local delivery activity. This is
  domestic commerce/credits; it must not reintroduce a trading system.
- [ ] `academy` — small rehabilitated classroom and modern technical-training campus with
  plausible pedestrian activity; no medieval/fantasy school.
- [ ] `port` — actual ocean-shore terminal, water-facing docks extending into eligible ocean,
  cranes, warehouses, service roads and real port/supply/embarkation states; expand cargo and
  harbor-service activity only as justified by state. Resolve land/water tile semantics in C/D.
- [ ] `guard_post` — inexpensive modern checkpoint with barriers, lookout and light weapon;
  visible sentry/weapon direction, condition and coherent neighboring trench access.
- [ ] `bunker` — low-profile reinforced concrete, earth-integrated armored firing aperture;
  firing, impact, repair, occupation and trench junctions follow actual server state.

### Buildings: Industrial Recovery

- [ ] `mine` — ore-specific entrance/open cut, conveyors, stockpiles, handling and freight; a
  mountain-slope entrance and retaining/cut arrangement must differ meaningfully from flat land.
- [ ] `steel_mill` — unmistakable furnace, chimney, industrial halls, stockpiles, loading and
  freight yard; merge compatible industrial compounds and show furnace glow/controlled smoke,
  conveyors and logistics only while the economy says they operate.
- [ ] `power_plant` — restored conventional turbines, generator/cooling and distribution equipment,
  distinct from fusion; operating fans/heat/activity and inactive/damaged states.
- [ ] `oil_well` — credible extraction pump/pumpjack, pipework, storage and access; machinery moves
  only during production and responds to terrain, level, damage and repair.
- [ ] `munitions_plant` — secured, separated manufacturing halls and loading, without decorative
  exposed explosive piles; production and transport follow real state.
- [ ] `motor_works` — vehicle assembly/repair halls, large access doors, loading and test area;
  equipment and vehicle dispatch correspond to authoritative production events.
- [ ] `depot` — practical warehouses, freight platform and loading for legacy saves/debugging only;
  retain visualization but do not re-enable normal construction absent an explicit rules change.
- [ ] `fort` — major modern concrete casemates, armored firing positions, integrated perimeter and
  functional compound, not a medieval castle; show real tracking, fire, occupation and damage.
- [ ] `university` — modern laboratories, teaching halls, paths and landscaped campus, clearly
  larger than an Academy; neighboring universities/academies merge coherently with independent
  entity selection, historical identity, activity and damage.

### Buildings: Mechanization and later

- [ ] `aa_battery` — upward-facing AA gun/launcher, sensor/radar and protected service area;
  legitimate air tracking, airbursts, ammunition status and adjacent defensive connections.
- [ ] `refinery` — substantial conversion plant, tanks, pipes and processing/loading, distinct from
  an Oil Well; restrained operating exhaust and real resource/production activity.
- [ ] `heavy_assembly` — large heavy-vehicle plant, wide doors, handling and test yard, capable in
  silhouette of producing tanks; show actual assembly/dispatch states.
- [ ] `airfield` — runway, taxiways, hangars, hardened surfaces, control/servicing and believable
  aircraft scale. Taxi, launch, landing, refuel and rearm must match authoritative operations.
- [ ] `electronics_plant` — modern precision-manufacturing campus and specialized logistics,
  cleaner/enclosed than a steel mill, with subtle real operational activity.
- [ ] `comms_tower` — recognizable mast/tower, aerial arrays, equipment housing and connections;
  subtle equipment state rather than gratuitous flashing or invented surveillance effects.
- [ ] `drone_works` — unmanned-aircraft production, service/landing pads, equipment and controls;
  launches/recoveries reflect actual units and do not fabricate sorties.
- [ ] `shield_generator` — grounded energy emitter and support plant, charging/active/impact/
  depletion/recovery states; field visible when useful without obscuring the whole city.
- [ ] `fusion_plant` — engineered reactor housing, containment and cooling in metal/ceramic with
  restrained lighting, thermal/operational state and a clear distinction from a conventional plant.
- [ ] `robotics_complex` — automated production campus with enclosed assembly, robotics,
  maintenance and autonomous handling, with bounded state-driven machinery activity.
- [ ] `missile_silo` — reinforced underground installation with armored surface doors and support
  facilities, not a permanently exposed rocket; show actual building, readiness and launch phases.
- [ ] `wonder` — Continental Arcology as a major vertical integrated settlement/wonder growing
  from its surrounding city, with staged construction, population, transport and completion.
- [ ] `camp` — rebel-only modern irregular encampment using containers, tents, repaired vehicles,
  barricades and scavenged equipment; guard/activity/damage, not a player build option.

### Units: Reclamation and Industrial Recovery

- [ ] `colonist` — identifiable civilian convoy with people, supplies, carts/backpacks or a
  reclaimed utility vehicle; organized slow travel and settlement establishment without implying
  faster movement than the authoritative infantry class.
- [ ] `engineer` — distinct modern workwear/tool team; walking, clearing, construction, repairs
  and infrastructure work tied to actual work state and the future timed-project rules.
- [ ] `scout_buggy` — small recovered off-road reconnaissance vehicle, light weapon, turning
  wheels/suspension and appropriate dust; readily distinct from armored combat vehicles.
- [ ] `militia` — mixed contemporary civilian/tactical clothing and basic gear; walking, aiming,
  firing, cover and retreat, visually less uniform than trained infantry.
- [ ] `rifle_squad` — standardized practical contemporary squad, recognizable weapons, formation
  movement, aiming, fire, suppression and cover without implying extra authoritative soldiers.
- [ ] `mortar_team` — portable modern mortar with crew/equipment, setup, load, recoil, reposition,
  high-arcing authorized projectile and compact impact; slower, less durable support positioning.
- [ ] `armored_car` — wheeled modern armored reconnaissance/combat silhouette, steering/suspension,
  weapon station/turret and dust; lighter/faster-looking than a tank.
- [ ] `supply_truck` — recognizable modern cargo/support truck with covered or modular load,
  movement and legitimate loading/unloading states rather than fictional deliveries.
- [ ] `field_gun` — recognizable towed artillery, barrel, crew and stabilizers with deploy, aim,
  load and recoil; moving representation must not create a separate gameplay towing vehicle.

### Units: Mechanization, Networked Warfare and Advanced Systems

- [ ] `mech_infantry` — recognizable armored carrier plus bounded infantry representation;
  tracked movement, weapon rotation and deployment without looking like a main battle tank.
- [ ] `tank` — low modern tracked hull and heavy cannon, independent turret, track/suspension,
  recoil, exhaust, powerful event-driven firing and progressive damaged/wrecked components.
- [ ] `sp_artillery` — tracked indirect-fire platform with long barrel, elevation, stabilization,
  recoil and smoke, distinctly artillery rather than a tank; appropriate slow support behavior.
- [ ] `helicopter` — narrow modern attack helicopter, rotors, sensors/weapons, hover, banking,
  pitch, landing and actual rocket/attack-run effects.
- [ ] `fighter` — recognizable swept-wing modern fighter with taxi, takeoff, climb, bank, combat,
  return and authorized air-to-air missile effects.
- [ ] `recon_drone` — small scouting unmanned aircraft distinct from armed drones, with launch,
  flight, turning and recovery reflecting real scouting activity.
- [ ] `missile_battery` — wheeled launcher, stabilizers and electronics with deploy, aim, guided
  launch and return-to-march states.
- [ ] `bomber` — larger tactical strike aircraft with taxi, takeoff, bank, bomb release, delayed
  ground impacts and return consistent with real aircraft state.
- [ ] `oneway_drone` — recognizable expendable guided aircraft with launch, flight and final dive;
  one server-authorized detonation and disappearance on use.
- [ ] `air_defense` — wheeled armored AA platform with radar/sensors and anti-air weapons,
  separate silhouette from an Armored Car, tracking and authorized bursts/airbursts.
- [ ] `special_forces` — modern specialist troops with advanced tactical kit, controlled movement,
  aiming and cover; no visual effects revealing a legitimately hidden unit.
- [ ] `autonomous_tank` — practical unmanned tracked armor with sensors and heavy weapon, coherent
  advanced silhouette, deliberate movement and independent turret/sensor tracking.
- [ ] `strike_swarm` — one authoritative unit represented by a bounded, coordinated group of
  small drones; formation/dispersal/attack states must not simulate extra gameplay units.
- [ ] `exo_infantry` — recognizably human infantry in articulated powered armor, mechanical
  supports, heavier movement, aiming and recoil; avoid oversized fantasy-robot proportions.
