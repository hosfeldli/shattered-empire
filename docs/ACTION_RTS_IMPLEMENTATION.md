# Unity action RTS implementation

Current ruleset: `action-v2`, save schema 5. Unity: `6000.3.28f1` (6.3 LTS), URP.
The [ring-city redesign](RING_CITY_REDESIGN.md) supersedes the earlier economy, initial buildings,
parcel capacities and engineer construction requirements described below. Historical test results
in this document apply to `action-v1`, and do not validate the current ring economy.

The following implementation inventory records the earlier action foundation; refer to the
linked redesign for current behavior and outstanding acceptance.

## Implemented behavior

- Secured starting headquarters, a Supply Center, Barracks and a five-unit force. Compact maps use eight major sites for 1v1, twelve for 2v2 and twenty for 4v4, subject to valid geography. Competitive maps are bounded; wrapping is optional.
- Six recognizable ruin specializations, minor supply/power/radar/support objectives, infantry/engineer capture, contesting, abandonment decay, one-time salvage rewards and reconstruction. Headquarters construction requires ownership of a designated city site.
- Supplies, Power and command capacity are authoritative rules. Civilian economics, workforce, taxes, imports and settlement-anywhere commands do not run in action matches.
- Functional city parcels, three headquarters tiers, ten core facility families, tactical defenses and engineer-drawn trenches. Training reserves capacity, balances shared queues, supports repeat production, rally points and reinforcement groups.
- Continuous authoritative positions, facing, unit footprints, movement classes, coarse shared strategic routes, local tactical routing and collision steering. Curved battle lines allocate distinct role-aware positions with live validity previews. Combat ranges, line of sight, capture, impacts and network snapshots use world coordinates.
- Combined-arms weapons and counters, specialist abilities, aircraft patrol/scout/strike/intercept/support/return orders, servicing, artillery and strategic missiles with interception. Domination, timed control and operation objectives include bounded headquarters recovery.
- Fog-aware AI expansion, production, upgrades, reconnaissance, staged operations, flanking, defensive construction, bounded stall recovery and committed retreats. Battle reports summarize losses and the principal weapons responsible.
- Saved world-space parcel anchors preserve facility position, road-facing orientation and construction previews. Large orders share reverse navigation fields, crossings arbitrate entry direction, and idle friendly traffic can yield without moving an explicitly held formation.
- Movement and attack orders share a bounded queue. Units can detach from reinforcement groups. Camera and group keys are remappable alongside the military commands.
- Version-four saves retain continuous motion, ownership, production, groups, operations, projectiles, damage and reconstruction. Reconnect uses the same authoritative state and delta protocol. Older clients cannot join action matches without the action capability.

## Presentation changes

- Shared tileable material arrays for concrete, brick, sheet metal, roof tiles, asphalt, armor, rubber, fabric, glass, soil and rock; surface relief, roughness variation, restrained highlights and weathering.
- The clean-world pass adds original photographic terrain and architecture atlases, explicit linear ambient lighting, terrain-clipped water, finer irregular banks, continuous street and sidewalk meshes, supported ruin frames, revised base architecture and stable historical street frontages. It removes duplicate infill over ruin parcels and bright civic lawn plates. See [world visual pass](WORLD_VISUAL_PASS.md) for assets, prompts, capture coverage and remaining defects.
- More detailed vehicle hulls, running gear, turrets, barrels, wheeled platforms, aircraft and seven personnel equipment families. Close-range infantry use procedural articulated joints; vehicles use terrain alignment, steering, wheels, turret traverse and recoil. Existing simpler representations remain distant LODs.
- Organic facilities with entrances, glazing, roof equipment, roller doors, historical architectural variation and specialization-specific ruin geometry. Flags wave, construction crews and cranes work only during construction, and active facilities receive bounded machinery and yard activity.
- Recorded impacts deform terrain into irregular bowls and rims. Nearby impacts merge through the shared ground-height function. Wrecks retain their exact position and heading; artillery and aircraft have distinct wreck silhouettes. Trench geometry follows the recorded world-space route.
- Exact firing origins, projectile travel times, shell arcs, rocket trails, surface-specific impacts, capture effects, smoke and persistent debris. Particle, sound and activity pools are bounded.
- Animated tread links, infantry weapons and launchers, reload gestures, articulated casualty reactions, upgraded armor panels and infantry equipment, damaged-engine smoke, movement dust and four pooled impact lights extend the military presentation.
- Trench records also depress the shared terrain geometry. Action-map lake basins are clamped to their banks so cosmetic water cannot flood legal base parcels.
- Combat HUD, contextual capture/base/army cards, production, compact upgrades, world objectives, control groups and a twelve-step match tutorial. No permanent minimap in action matches.
- Living reconstructed menu scene, original adaptive synthesized music, capture sound and the existing eight-shot engine cinematic. Campaign descent opens onto the secured military foothold.

## Verification sequence

At the user's request, the major implementation pass precedes test execution. Regression cases cover capture eligibility/contesting/decay, construction restrictions, continuous motion, capacity reservation, conquest, team visibility and deterministic save continuation.

Actual-player screenshot capture is available with `-review DIRECTORY` (optional `-review-quit 0`). A live action sandbox captures headquarters, operational base, available ruins, close army, combined arms, strategic view and aftermath. Capture stalls must be excluded from performance benchmarks. `-mode stress -shots DIRECTORY` retains the earlier offline camera tour.

Commands:

```powershell
node --test test/action-rts.test.js
npm test
dotnet run -c Release --project unity/Tests.Standalone
Unity -batchmode -quit -projectPath unity -executeMethod SE.EditorTools.BuildScript.BuildWindows
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode sandbox -battle mixed -seed 41 -review DIRECTORY
```

## Acceptance status

These classifications distinguish implemented behavior from release approval. They are updated with measured results after verification.

Before the user's visual-only testing instruction, the action suite passed eleven cases and the standalone client passed 11,386 checks, including repeated lake-update and geometry-resend regressions. A live action session synchronized up to 997 units, rejoined after a dropped connection and recorded zero command timeouts (acknowledgment p95 87.1 ms). An earlier concurrent capture/live run recorded one timeout; it was not reproduced on the repeat. These functional results precede the final shoreline and material refinements. After that instruction, only Unity builds and visual scene reviews are performed.

An initial AI match ended at 669 simulation seconds; other seeds reached 45 minutes with stalled operations. This exposed scouting, collision, army-composition and reinforcement problems addressed in the current development pass. Match pacing and AI completion therefore remain unapproved until the new behavior is measured.

Actual Unity camera images are captured in `.scratch/action-rts/review`. Iterative review exposed exposure problems, oversized capture rings, water coverage errors, duplicate historical infill and roads crossing building interiors. These findings drive the clean-world implementation and replacement captures. The offscreen camera captures show the actual scene without the screen-space HUD. They are review artifacts, not approved references.

| Area | Status before verification |
| --- | --- |
| Capture/base/economy/tiers/production | Functional prototype |
| Continuous movement, combat, formations | Functional prototype |
| AI, team rules, saves and reconnect | Functional prototype |
| Terrain, ruins, cities, units and effects | Visually incomplete pending actual Unity review |
| HUD, tutorial, menu and cinematic integration | Functional prototype |
| Rigged authored animation clips | Not implemented; procedural articulation is used |
| New material and model library | Visually incomplete pending art review |
| 60 FPS / p99 targets and long sessions | Not performance approved |
| Human fun/balance playtesting | Not performed |
| macOS runtime acceptance | Not performed on this Windows workstation |
| Human art approval | Not performed |
| Production distribution and replacement release | Not production accepted |

Visual ambition, fun, release acceptance and platform performance cannot be established by code tests alone. The library uses original project geometry, generated photographic albedo atlases, and synthesized surface/audio data; no external asset library was added.
