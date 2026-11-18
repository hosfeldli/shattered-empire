# Gameplay overhaul: final report (2026-11-18)

**Status key:** "Implemented" means the server is covered by automated tests and the client compiles. "Runtime-unverified" means nobody has played it by hand in Unity yet; each workstream doc lists the runtime checks.

Server: `npm test` runs 384 tests, all pass except 1 that is skipped. Unity compiles with no errors. A 47-minute AI soak on the new build logged no exceptions.

## Confirmed rules

| Rule | Status | Where |
|---|---|---|
| R1 Shared production capacity | Implemented and tested (Test A) | `server/sim/actionProduction.js`; UI in `Hud.Base.cs` and `Hud.Action.cs` (runtime-unverified) |
| R2 No refund of consumed resources | Implemented and tested (Test B) | Same files. Also applies to cancelling construction (`cancelConstruction`, `test/cancel-construction.test.js`) |
| R3 Infantry squads | **Changed by user decision:** squads stay single entities, with more men (rifle 12) and per-man simulation | `actionUpgrades.js` (`squadHit`), `actionDefinitions.js`; client draws up to 12 figures |
| R4 Garrison | Implemented and tested (Test D) | `server/sim/actionGarrison.js`; UI in `Hud.Action.cs` and `Hud.Base.cs` (runtime-unverified); occupants hidden in `UnitRenderer.cs` |
| R5 Persistent forest clearing | Implemented and tested (Test E, server side) | `battlefield.js`. The client relies on geo deltas to remove trees (runtime-unverified) |
| R6 Unanimous speed vote | Implemented and tested (Test F logic) | `server/sim/speedVote.js`, `worker.js`; UI in `Hud.SpeedVote.cs` (runtime-unverified) |
| R7 Capture decay | Implemented and tested (Test G) | `server/sim/actionCapture.js`; UI states in `Hud.Action.cs` |

## Other directive items
**Implemented:**
- Queueing without resources or beyond the population cap, with authoritative reservation.
- Queue states and priorities.
- Base wheel refocused on upgrades and status.
- Pads clickable without selecting the base first.
- Neutral non-defensive structures and terrain works.
- More forgiving placement, with coded refusal reasons.
- A / Ctrl+A / E selection and Ctrl+double-click selection.
- Shift-click rally point.
- Formation placeholder preview.
- Click-away dismiss.
- Unified stroke-tool rules and stroke cost.
- Sizes: engineer ring, building and turret rings.
- Team accents and distinct facility silhouettes.
- Building glyphs and pickup rings.
- Context cursors.
- Resource HUD fitted to the minimap, with net rates.
- "Update and Restart" with confirmation.
- Single-player speed.
- Storms and mountains affecting aircraft.
- Missile interception.

**Not done, or follow-up:**
- A separate missile-defense building. Interception currently uses `aa_battery` and `air_defense`.
- Client visual for interceptions (`mintercept` event).
- Storm-grounding notice styling.
- Dense forest that blocks infantry (needs a navigation change).
- Rivers made thicker and more natural (§31).
- Road and emplacement variation around bases (§32).
- Passive base development and decoration (§15).
- Destruction rendering changes (§41): the performance work handled debris via caching instead.
- Right-click a building to garrison: currently done via the wheel.
- Vehicle terrain-assisted unsticking (§30) and stuck-unit recovery improvements (§24). The server re-route backoff experiment did not help (see the performance log). Separation is unchanged.
- Road-aware long-route preference (§26): unchanged (×0.94 road weighting).

## Balance and performance
- AI balance sims run to completion on all 17 maps. AI expansion in mid and late game is about 10–14% lower (slower captures). Anti-armor trades well at 1.62; consider trimming its attack from 18 to 16.
- Performance invariant: the new systems are O(queues), O(sites) or O(pending) per step; garrisoned units leave the movement and combat loops. The A/B soak on the final tree is in `docs/performance/BENCHMARK_RESULTS.md`.

## Docs
REQUIREMENTS, AGENT_TASKS, AUDIT_CLIENT, PRODUCTION_SCHEDULER, ECONOMY_DESIGN, CONSTRUCTION_DESIGN, CAPTURE_AND_GARRISON, MULTIPLAYER_RULES, TERRAIN_SYSTEM, BALANCE_TESTS, UNIT_CONTROLS, VISUAL_DESIGN.

## Round 2 (2026-11-18)

**Verification**
- `npm test`: 426 tests, 425 pass, 1 skipped.
- Unity compiles clean with all agents' code.
- The idle-machine A/B is in `docs/performance/BENCHMARK_RESULTS.md` ("Pass 2").
- Gameplay and visuals below are **runtime-unverified** unless noted. Each doc has its in-game checklist.

| Request | Status | Doc |
|---|---|---|
| Scroll and mid-game lag, worst at mid and close zoom | Fixed and measured: unit culling, tree scars, sliced base compose, decode pooling | performance/IMPLEMENTATION_LOG.md (Pass 2, 2b) |
| Tree popping in fought-over ground | Fixed and measured: 0 trees regrown per window (was 115–257) | same |
| Debris and deformation never clear; use decals | Craters heal in 5 min (server-authoritative), wrecks last 10 min (cap 400), decals fade, 14k clod instances removed | DESTRUCTION.md |
| Trenches: connected, terrain-following | Rebuilt as continuous terrain-fitted meshes; route bits on the wire | TRENCHES.md |
| Roads bending around defenses; defenses offset from roads (barricade exempt) | Server refuses or snaps; client draws the road straight and the defense at the roadside | CONSTRUCTION_DESIGN.md, BASE_VISUALS.md |
| One upgrade per unit class | Server rule plus UI fork and lock | UPGRADES.md |
| Easier defense placement, clearer refusals | Snap within 2 hexes; ghost at the real spot; reason codes | CONSTRUCTION_DESIGN.md, UNIT_CONTROLS.md |
| Queue units without funds | Already worked server-side (test added); client wording clarified | PRODUCTION_SCHEDULER.md |
| Missiles 3× cost; no anti-missile building | 1440/1140 | UPGRADES.md / economy test |
| Thicker rivers | Channel matches navigation width, with varied banks | BASE_VISUALS.md |
| Road variety around bases; base decoration | Entrance bends and aprons; yards, utility yards, camps and water tower (no houses) | BASE_VISUALS.md |
| Remove dynamic houses | Removed | BASE_VISUALS.md |
| Dense forest blocks infantry | Interior cores; connectivity verified on all maps; thicker render | TERRAIN_SYSTEM.md |
| Stuck-unit recovery | Recovery ladder; route retry; arrival near goal; measured with nav-perf-bench | performance/IMPLEMENTATION_LOG.md N7 |
| Bunker bursts | 6 rounds per 4.2 s, +15% DPS | UNITS_AND_DEFENSES.md |
| Defense influence to 3 hexes plus border shading | Done | UNITS_AND_DEFENSES.md |
| Distinct, clickable buildings | Signatures, team rims, footprint picking, hover highlight and card | VISUAL_DESIGN.md |
| Scroll past the map edge | 1.5–5 hexes depending on zoom, eased | performance/IMPLEMENTATION_LOG.md |
| Armored infantry → IFV | Tracked IFV with autocannon and ATGM; tuned to value ratio 2.90 (tank 2.90) | UNITS_AND_DEFENSES.md, BALANCE_TESTS.md |
| Recoil, missile launch and travel, terrain-aware nuclear shockwave, trees felled | Done; nuke forest clearing is server-authoritative | EFFECTS.md |
| Infantry as cheap grunts | Rifle 65 cost, 9 HP per man | UNITS_AND_DEFENSES.md |
| Map builder: base team ownership | Done (server-validated) | MAP_BUILDER_TEAMS.md |
| No roads to unclaimed cities; claim road in settlement cost | Done; crossings (bridges and causeways) kept; base compound streets | ROADS_AND_CLAIMS.md |
| Release notes after every update, required by release script | Done; 0.5.0 notes validate | ../RELEASING.md, ../releases/0.5.0 |

**Known gaps**
- Sparse non-forest trees knocked down by a nuke regrow on reconnect (client-only state).
- Release-shot framing for craters and shockwave lands on ocean, and trench and IFV shots found nothing to frame, so those images are not in the 0.5.0 notes.
- The river screenshot showed a short channel ending abruptly; check rivers in play.
- A recomposed base can appear up to about 1 s late (by design of the sliced compose).
