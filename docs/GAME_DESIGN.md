# Game design

- **Type:** Current design contract
- **Updated:** 2026-11-13
- **Scope:** Unity edition / `action-v2`
- **Implementation and evidence:** [Current status](UNITY_PROGRESS.md)

## Direction

Build a combat-first, base-building modern RTS. The Unity edition is a substantial gameplay and
visual redesign. Preserve the living world, free-moving combined arms and persistent history
while simplifying administration. Responsive control, rewarding captures and understandable
battles take priority over extra simulation complexity.

The ring-city brief and later owner overrides supersede flexible city placement, Supplies/Power,
field Energy pickups, engineer-required construction and civilian activity. Later feedback also
requires contextual world interaction, connected roads and bridges, very short groundcover,
natural soldier movement and a stable mountain camera.

## Core loop and matches

Scout → Capture → Rebuild → Deploy → Conquer.

Normal matches begin with one operational Tier I headquarters, four available development sites,
500 Materials, 100 Energy, three Rifle Squads, an Engineer and a Scout Buggy. Players can act
immediately. Sandbox scenarios may explicitly replace this setup.

Military Domination is the default victory condition. A faction loses when it has no operational
headquarters and no valid recovery path. Recovery is bounded and clearly explained. Territorial
control and scenario objectives are alternatives; research, culture and economic victories are removed.

Target a meaningful decision within 30 seconds, an interesting scouting encounter within two
minutes, expansion within the opening minutes and a typical 25–40-minute standard match.
Escalate through armor, artillery, air support and advanced systems. These are balance targets,
not verified timings. Avoid premature infantry base rushes, passive opposition and prolonged idle
time. Comebacks come from terrain, useful affordable infantry, rebuilding and vulnerable routes.

## Ruins, capture and headquarters

Primary bases can only be established at designated captured city ruins. Infantry and engineers
capture; tanks and aircraft can clear defenders. Use continuous world-space zones, approximately
12–20 seconds of uncontested holding, contested pauses and abandonment decay. Do not require
clearing every decorative building.

Use six ruin identities: Provincial Town, Industrial City, Metropolitan Ruins, Military Installation,
Coastal City and Research Complex. Explain their modest strategic differences.

At the actual site, show ownership, eligibility, capture zone/progress, contested status and
Establish Base. Capture provides faction markings, a raised flag, concise audiovisual feedback
and useful expansion capacity. Destroyed bases leave recognizable ruins and can become capturable
again. Reconstruction preserves street, parcel, building and damage history.

City compounds belong on plains. Select or grade level authoritative ground with blended approaches;
do not bridge foundations across steep hills. Every normal city must fit its final eight-site
footprint. Preserve existing save identities rather than silently relocating old cities.

## Ring construction and local progression

The headquarters occupies the center and consumes no development site. Plan eight irregular,
adjacent parcels when the ruin is generated. They form one compact district, with stable
positions, orientations and dimensions, rather than isolated pads in a perfect circle.

| Local City Tier | Active sites | Presentation |
| --- | ---: | --- |
| I — Foothold | 4 | Repaired command center, surviving ruins and limited support detail |
| II — Operations Base | 6 | Restored facilities, connected streets and shared yards |
| III — Stronghold | 8 | Dense, coherent military-industrial district |

Exactly two sites unlock when each local HQ upgrade completes. Time held never unlocks sites.
Global Technology Tier records the highest achieved faction tier and unlocks units/technology
faction-wide; each secondary city retains its own local tier until upgraded.

Nine facilities compete for ring sites: Materials Processor, Energy Generator, Barracks, Armory,
Vehicle Works, Heavy Weapons Facility, Airfield, Advanced Systems Lab and Strategic Missile
Facility. Field defenses occupy no ring sites. Civilian buildings are accessories, not hidden
economic facilities. An airfield needs credible operations within a suitable ring-edge footprint.

Automatic development restores compatible ruins, annexes, streets, sidewalks, yards, parking
and modest landscaping. Use staged clearing, scaffolding, structure, finishing and activation
over an initial 15–45-second visual interval. Avoid sudden finished-building appearances,
rerolled neighbors and universal futuristic replacements of surviving architecture.

## Economy and military progression

Materials and Energy are the only spendable resources. Command Capacity is an army limit, not
a currency. Food, ore, steel, fuel, electronics, munitions, credits, housing and workers cannot
secretly constrain ordinary recruitment or construction.

| Source | Materials/min | Energy/min |
| --- | ---: | ---: |
| Operational headquarters | 50 | 8 |
| Materials Processor | 115 | 0 |
| Upgraded Materials Processor | 175 | 0 |
| Energy Generator | 0 | 65 |
| Upgraded Energy Generator | 0 | 100 |
| Captured Materials Relay | 30 | 0 |
| Captured abandoned energy plant | 0 | 18 |

These are the starting balance model. Actual tuning belongs in authoritative definitions and
requires playtesting; this table is not balance acceptance.

Supply drops grant Materials, normally 55 or 110 per cache. Eligible mobile ground units collect
visible caches on contact or by right-click order. Deposit once, immediately, without workers or
return trips. Aircraft cannot collect. The server resolves simultaneous arrival. A selected cache
shows its actual value; collection has a restrained floating reward and spatial sound.

Abandoned energy plants are capturable passive Energy objectives. Do not restore ordinary field
Energy pickups. Relays and plants cannot support headquarters or production rings. Replenishment
is limited to defined neutral collection locations, not endless random scatter.

Command Capacity follows global tier: 80 / 120 / 160, plus purchased upgrades, bounded by the match
maximum. Additional headquarters do not multiply it. Reserve capacity for queued production.

Global technology tiers are I — Reclamation, II — Mechanized Warfare, III — Advanced Warfare.
Keep upgrades compact and tactically useful. Preserve distinct infantry, engineer, reconnaissance,
armor, artillery, air-defense, aircraft and drone roles. Basic infantry remain useful for capture
and terrain control. Shared queues, rally and reinforcement reduce repetitive factory visits.

## Roads, bridges and field construction

Roads remain manually buildable and also connect cities and settlements automatically. Join
highways to city entrances, the internal loop, facility frontages and shared junctions. Match
geometry, widths, materials and tangents. Open curbs at junctions; avoid isolated stubs, overlapping
strips and sidewalks crossing carriageways.

River crossings use coherent bridge decks above water, structural depth, supports and graded
approaches from both banks. Units and roads share the bridge support height. A destroyed bridge
genuinely interrupts the route until authoritative repair.

Field construction requires legal, visible terrain and clearance, but no engineer selection,
nearby headquarters or continuous territory connection. Enforce protected capture zones and
active hostile-compound exclusions on the server. Q/E rotates defenses; preview, collision,
saved orientation and geometry agree. Invalid placement explains the reason and retains the tool.

Offer sandbags, trenches, guard posts, bunkers, anti-armor and AA positions, sensors, repair
stations, artillery emplacements and fortified anchors. Cost, vulnerable construction and siege
counters limit spam. Functional city turrets and sandbags require a purchased HQ upgrade;
decorative security architecture grants no free weapons.

Idle engineers automatically repair allied vehicles, buildings and defenses and assist construction
outside combat. Explicit player orders take precedence. Their pistols serve self-defense, without
offensive pursuit or structure attacks.

## Armies and combat

Position, facing, footprints, collision, navigation, ranges, line of sight, area damage, capture
and saved motion are genuinely continuous and authoritative. A coarse grid may support terrain
or routing; unit movement and occupancy cannot depend on hex-center steps or stacking.

Use shared strategic routing, group navigation, separation and crossing management. Vehicles
accelerate, brake, steer and slow for turns without sideways rubber-band motion. Individual
soldiers move and turn into their own positions; squads must not pivot rigidly around a center.

Support consistent selection, control groups, queued orders, curved battle-line previews,
attack-move, hold/defend, retreat, rally and reinforcement. Preserve the player's broader intent
while allowing bounded cover-seeking, spacing and useful local firing positions.

Infantry ordered into completed trenches enter them and stand on the trench floor. Darken the
surrounding disturbed ground. Cover follows the real trench, not an invisible broad tile bonus.

Mixed armies reward positioning, counters and timing without demanding individual soldier orders.
Make losses and important terrain effects understandable. Keep specialist abilities limited and
impactful. AI respects fog, scouts, contests ruins, stages forces, defends, retreats and recovers;
it must avoid repeated orders, mission stalls and unsupported economic replacement bonuses.

## World and presentation

Use compact maps whose objective and route distribution gives playable land strategic purpose.
Keep flanking and army maneuvering space without an unused continent around the battlefield.
Standard maps have geographic boundaries and an ocean horizon; wrapping is reserved for explicitly
supported special modes.

Preserve natural ridges, valleys, forests, rivers, lakes, coasts and historical infrastructure.
Cities need district relationships, irregular parcels and connected circulation. Randomness is
constrained, deterministic and stable through growth and conquest.

Remove civilian actors and little ambient vehicles. Build atmosphere through weather, vegetation,
water, lighting, machinery, military activity and spatial sound. Grass is very short groundcover
relative to infantry. Use small leaves and coherent tree canopies.

Use consistent physical scale, distinct silhouettes, restrained PBR materials and grounded
foundations. Foliage must not produce giant HDR glares. Bound bloom and transient lights while
retaining purposeful firing, impact and missile feedback.

Improve tracks, wheels, suspension, rotors, turret traverse, recoil, infantry gait, aiming,
reload and casualties. Persistent destruction includes irregular depressed craters, damaged
forests, recognizable wrecks, rubble and material-specific scars. Barbed wire and tank obstacles
are 3D geometry. VFX must preserve tactical readability.

## Interface and camera

Keep interaction contextual and anchored to the world. Select HQ for local tier/perimeter
upgrades, a facility for production/repair/upgrades, an Armory for military research, and an empty
world parcel for construction choices.

Remove Army and Objectives tabs, the global upgrade menu and permanent bottom building/defense
shortcut bars. Keep tools discoverable without displaying all options continually. Provide
costs, requirements, shortages, progress, tooltips, cancellation and immediate feedback.
Field construction remains available without selecting an engineer.

Menus scroll and fit the viewport. Normal startup uses fullscreen or borderless fullscreen.
Keep cursor-centered zoom, stable oblique pitch and smooth focus over mountains. Ground picking
must not oscillate on ridges or make the camera jump.

## Cinematic and audio

Play the skippable, replayable eight-beat intro on normal boot: World Before, Catastrophe, Long
Winter, Nature Returns, Reclamation, Rival Empires, Warning, Title. Direct real Unity scenes with
distinct districts, skyline, geography and coherent missile targets. Communicate global collapse,
loss, recovery and the danger of recurrence. Keep the silo warning restrained and free of glare.

Use a real-time rebuilt menu district and an opening descent to the secured foothold. Compose
purposeful action and variation rather than uniform wilderness or random decoration.

Use properly licensed recordings for weapons, armor, aircraft, explosions, construction, weather,
forests and close water. Audio follows camera position and zoom with spatial attenuation, bounded
source counts and a restrained dynamic music mix. Retain source/license records; free download
availability alone is not redistribution permission.

## Quality, performance and release

Review real Unity scenes at tactical, operational and strategic scales, during gameplay and in
damaged states, through normal post-processing. Code tests and screenshots do not establish
final art quality or fun.

Windows targets are 1080p/60 FPS, approximately 16.7 ms average and p99 below 25 ms in principal
scenes on a defined reference gaming PC. Measure varied bases, terrain, 100/500/1,000-unit
battles, 2,000-unit stress, input, save/rejoin and extended multiplayer sessions. Targets remain
unapproved until measured for the specific build.

Production requires gameplay, visual, platform, multiplayer, save/rejoin, frame-pacing and
distribution gates. Windows and macOS need separate acceptance. Current distribution remains a
Windows preview; legacy and macOS downloads are not advertised.

## Terminology

| Preferred term | Meaning / superseded wording |
| --- | --- |
| Materials | Primary currency; replaces Supplies from the earlier action brief |
| Energy | Secondary currency; replaces Power |
| Command Capacity | Army limit, never stored currency |
| Global Technology Tier | Highest faction technology achieved |
| Local City Tier | Individual HQ level, appearance and 4/6/8 sites |
| Development site / ring parcel | Predetermined functional facility location beside HQ |
| Accessory | Automatically composed decorative detail without hidden gameplay effects |
| Field defense | Independently placed authoritative defensive structure |
| Materials drop / cache | Collectible Materials, without harvesting chains |
| Abandoned energy plant | Capturable passive Energy objective, not an Energy pickup |
