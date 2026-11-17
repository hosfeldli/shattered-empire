# Request checklist — 2026-11-16 review pass

Every item the user (liamh) and the tester (Rowen) asked for. Reviewers mark each item
**Done (verified how)**, **Fixed in review**, or **Open (why)** in their section at the bottom.
Owner letters: S = server reviewer, U = client UI/controls reviewer, V = editor/visual/perf reviewer.

## User requests
| # | Request | Owner |
|---|---|---|
| 1 | ≥30 FPS everywhere, big drops when slightly zoomed out | V |
| 2 | LOD spread wider; NOTHING disappears when zoomed out (very important) | V |
| 3 | Defensive buildings rebuilt in the new art style | V |
| 4 | AA shows visible airbursts | V |
| 5 | Aircraft pseudo-fuel → return to base, not strict (no exploding) | S |
| 6 | Easy patrol routes for aircraft; fuel limits range | S+U |
| 7 | Planes fly longer multi-hex paths; helicopters patrol a couple of hexes, not hover | S+V |
| 8 | More men in the rifle squad (visible) | S+V |
| 9 | Upgrades functional (grenades, rockets…), not % increases; shown visually | S+V |
| 10 | Steam overlay invites working with Spacewar (480) | U |
| 11 | Lobby: change teams, add AIs, set AI difficulty | S+U |
| 12 | Better, fun, strategic maps, not too big; map preview; select all maps | S+U |
| 13 | Troops a bit cheaper; epic battles; desolate no-man's-land | S |
| 14 | Cities get built-in AA once upgraded with defenses | S+V |
| 15 | Green destination circle never goes away | U |
| 16 | Minimap shows a smaller section (local view) | U |
| 17 | Base UI covers the bottom defensive/other items | U |
| 18 | Drag-selection box not visible | U |
| 19 | Troops hard to find on screen | V |
| 20 | Trench brown line extends past trench; troops sink into ground in trenches | V |
| 21 | Troop meshes match the rest of the game | V |
| 22 | Follow the HUD mockup docs/design/hud_mockup_2026-11-16.png where sensible | U+V |

## Rowen's feedback
| # | Item | Owner |
|---|---|---|
| R1 | Placement exploit: build only in own territory; defenses claim territory | S |
| R2 | Fog of war missing / whole map visible | V |
| R3 | Mid-zoom lag | V |
| R4 | Pathfinding: groups, bridges, stuck in bases, river roads for tanks | S |
| R5 | Attack move on F; arrow-key panning; Alt+mouse rotate | U |
| R6 | Stances; rally points that take actions; crossed-out cursor on impassable | S+U |
| R7 | Cap zoom-in; slight perspective camera | V |
| R8 | HUD docked to minimap, no top bar; match clock; floating pause/menu; resource bars + era badge + idle button on minimap | U |
| R9 | Minimap fitted to the circle; trapezoid camera view | U+V |
| R10 | Attack warnings (banner, jump) | U |
| R11 | Build and Terrain buttons (B/T) | U |
| R12 | Selection panel with per-type boxes; hover card with owner + team | U |
| R13 | Radial wheels: 9 segments, centre info circle, top = upgrades, next-page only when needed, green progress ring + queue counts | U |
| R14 | Base slots 3/5/7; defenses on build wheel; perimeter on base wheel; era upgrades per building | S+U |
| R15 | Halo Wars / Grey Goo bases: circular HQ, concrete pads, docking; bigger turrets; visible damage; hex territory outline | V |
| R16 | Automatic AI engineers per base | S |
| R17 | New base buildable (1000) connected to a road | S+U |
| R18 | Smaller footprints; terraforming | S+U |
| R19 | Enemy unit icons + squad circles visible at any distance | V |
| R20 | Lower poly, exaggerated proportions | V |
| R21 | Units 20–50% slower; consistent speeds | S |
| R22 | Income spread over ticks | S |
| R23 | 1v1v1 / FFA modes | S+U |
| R24 | Steam lobbies filtered by game name + version | U |
| R25 | Bugs: black patches; small units vanishing; tanks can't cross river roads; units stuck in bases; spectate speed buttons; duplicate move markers; birds move while paused; inconsistent unit speeds | S+U+V |

## Known open items from Wave 1/2 reports
- Base_town (round HQ) and possibly motor works / power plant render near-black in play (V)
- HQ team bands show as big flat blue discs (V)
- Minimap: square map small inside circle with dark corners (U, verify V)
- Decisive Domination countdown (`econ.dominance [team, secondsLeft]`) has no client banner (U)
- `roadBuild` error code `foundation` / placement error codes need readable client messages (U)
- Rally markers from econ `ra:[x,z,mode]` not drawn (U)
- Base compose cache (CityRenderer.BaseCache.cs) not yet measured (V)
- P = pause vs patrol conflict (patrol only with own aircraft selected) — keep unless broken
- Unverified in editor: wheels, markers, cursor, defenses/turret aim, damage stages, soldiers + helmet overlay, trenches, flak, fog, menus at 1080p/720p (V)

## Reviewer results
(append sections below)

### Review S (server) — 2026-11-16

Method: code read of every S path plus runs: full `npm test`, the new `test/review-s-2026-11.test.js` (7) and `test/review-s-longroute.test.js` (1), scratch integration scripts (new base save/restore/capture, FFA starts on random 104/152/208 and the FFA catalog maps, field-structure completion tracking, feature-usage AI sims), `tools/action-balance.mjs` (6 maps × 2 seeds) and `tools/action-mirror.mjs`, and 6-player 20-minute tick benchmarks against the pre-round tree (`git archive HEAD`).

| # | Item | Result |
|---|---|---|
| 5 | Aircraft pseudo-fuel → return, not strict | **Done** — `test/action-air.test.js` (bingo → return → refuel → resume, dry limping, never destroyed). Aircraft Systems now extends it (below). |
| 6 | Patrol routes; fuel limits range | **Done** — `patrol` command and range clamp tested; clamp now uses the real tank size (drop tanks +50%). Client input is U. |
| 7 | Longer flight paths; helicopter circuits | **Done** (server) — lap sizes and "no hovering" asserted in `action-air`. Visuals are V. |
| 8 | More men in the rifle squad | **Done** (server) — 8 men × 14 HP, men in unit extra[8], firepower scales with survivors. |
| 9 | Functional upgrades, not % | **Fixed in review** — the 8 kit upgrades were functional, but Infantry Training (+15% damage) and Aircraft Systems (+18% speed) were still flat %. Now: Infantry Training = fieldcraft (halted infantry take .22 cover, .12 vs shellfire); Aircraft Systems = drop tanks (+50% endurance and patrol range, refuel 2× faster). AI sims show grenade/rocket/marksman/armour events every match. |
| 11 | Lobby: teams, add AI, difficulty | **Done** (server) — `lobby-controls` tests; format/map relayout re-read; FFA seats → one team per seat verified in-game. |
| 12 | Maps: smaller, preview, all maps | **Done** (server) — `action-maps` (10 maps, previews current, ≥2 per format). |
| 13 | Cheaper troops, epic battles, no-man's-land | **Done** — balance rerun after review changes (see changelog Review S); craters/field works accumulate on fronts. |
| 14 | City AA after defense upgrade | **Fixed in review** — worked, but a captured ruin kept the old owner's `defenseLevel` (free perimeter level and city AA for whoever rebuilt the HQ). Reset on HQ loss. |
| R1 | Build only in own territory; defenses claim | **Done** — every placement path checked (fieldBuild/Preview incl. rotated corners, New Base, trench, road, terrain); only sandbox `anywhere` bypasses. AI sims: 0 structures placed outside own territory. |
| R4 | Pathfinding: groups, bridges, bases | **Fixed in review** — bridges/base lanes tests pass, but long group orders on big maps failed: the group flow field stopped at 4300 hexes, members beyond it fell back to bounded A* that gave up (68-unit AI final assault on a 208 map: 18 units got no order, 590 ms). The flow now expands until every member is covered: 68/68 placed, ~150 ms. A lone unit ordered ~210 units away can still be refused on a 208 map (1 of 61 probes). |
| R6 | Stances; rally actions | **Done** (server) — `action-pathing` stance/attack-move/rally tests; stance × attack-move × hold re-read (hold fire still fires on attack-move, braced never pursues). `reach` query tested. |
| R14 | Slots 3/5/7; era upgrades per building | **Done** (server) — tests; AI buys levels (2–15 levelled buildings per sim). |
| R16 | Automatic AI engineers | **Done** — staffing, respawn, re-homing after a base falls, exclusion from capture/capacity/dominance/AI checked; field structures placed by the AI get completed (tracked per structure). |
| R17 | New base (1000) on a road | **Done** — founded mid-match by the AI (1–2 per 4-player sim); save/restore during construction and after founding are hash-identical; a founded base can be captured and re-established by the enemy. |
| R18 | Smaller footprints; terraforming | **Done** (server) — tests. |
| R21 | Units slower; consistent speeds | **Done** — `action-pathing` speed tests. Aircraft speeds are no longer changed by an upgrade. |
| R22 | Income spread over ticks | **Fixed in review** — the server accrued per tick, but the client only received `res` in the 1 Hz econ block, so the bar still stepped once a second. Every 5 Hz snapshot now carries `res` (client hook needed, see changelog). |
| R23 | 1v1v1 / FFA | **Done** — ffa3/4/5/6 on random 104/152/208 and the 4 FFA maps start with one HQ and one team per seat; decisive domination and elimination work per team (FFA = per player); the winner now names its team. |
| R25 | Server bugs: river roads, stuck in bases, spectate speed, speeds | **Done** — `action-pathing`, `spectator`, `lobby-controls` (obsCmd) tests. |
| — | Known failing "action saves continue deterministic spatial simulation" | **Fixed in review** — not caused by this round: `buildActionMap` reshapes terrain after `Game` built the weather's per-cell climate; a restore recomputed it from the saved terrain, so weather (fog, then vision) diverged. The constructor now recomputes the climate after the map is built. `npm test` is fully green. |
| — | Saves of new fields | **Fixed in review** — units/buildings/sites carry fuel, stance, levels, `defenseLevel`, founded sites, engineers, projects; the game-level decisive-domination countdown and territory-dirty flag were not saved and now are. |
| — | Server perf, 6 players, largest maps | **Done** — no regression, see changelog Review S table. |

### Review U (client UI, controls, session, Steam): 2026-11-16

Method: read each code path end to end (input → `Commander*` → command JSON → `server/sim/*.js` / `server/matches.js` handler → snapshot field → `ProtocolDecoder` → HUD) and checked field names and indices against the server. Type-checked Runtime/Core/Net and the Steam assembly with dotnet (0 errors). Nothing was run in the editor (V has it), so every visual is "verify in play" (list at the end).

| # | Status | How verified / what changed |
|---|---|---|
| 6 | Done + fixed | P with own aircraft → `{c:'patrol', units, points}` (`actionAir.patrolCommand`); the ack's `patrol.route` / `note` is drawn and toasted. **Fixed in review:** patrol planning had no on-screen hint in the action ruleset (mode hints only show in legacy); the tool chip now shows "Patrol route · n/8 waypoints" and the keys. Arming another tool (F, a wheel item) now cancels patrol planning instead of leaving it armed underneath. |
| 10 | Done (code review; needs the two-PC test) | `SteamInvites`: lobby data `se_game` / `se_version` / `se_status` / `se_match` / `se_server`; the public search filters on all three with `AddRequestLobbyListStringFilter` right before `RequestLobbyList`; the friends list uses `GetFriendGamePlayed` + `RequestLobbyData` + `Listable` (game, version, status). Overlay invite: `ActivateGameOverlayInviteDialog(lobby)` → `GameLobbyJoinRequested_t` → `JoinLobby` → `OnLobbyEntered` gate (game key, version, code) → `JoinRequested` → `GameBootstrap.StartMatch("join")`. Rich presence `connect = "+connect_lobby <id> +se_match <code>"` → `GameRichPresenceJoinRequested_t`, and the same string as launch arguments (`GetCommandLineArgs`, then `GetLaunchCommandLine`). A started match sets `se_status=running` and `SetLobbyJoinable(false)`. One gap noted, not changed: if the Steam lobby is gone, the `+se_match` fallback joins the match code directly without the version gate (the server stays the authority). |
| 11 | Done | `LobbyMessages` (`seat`, `team`, `addAi`, `removeAi`, `aiDifficulty`, `mode`, `map`) match the `matches.js` cases and fields exactly (K's 8 server tests cover them). |
| 12 (U part) | Done | The map picker lists every map, filtered by seat count, with the preview grid (K, checked against `mapList()`). |
| 15 | Fixed in review | F's markers were already on `Time.unscaledTime`, but the commander still mixed clocks: orders, refused and pending sites and the HUD order lines were stamped with `Time.unscaledTime` in some places and with the bootstrap clock (which lags after any hitch) in others. `Commander.Update` / `DrawOverlay` now run on `Time.unscaledTime`, and `Hud.NoteOrder` and the order lines stamp and age on it, so nothing outlives its 1.5 s. One marker per order confirmed: each order path raises `OrderIssued` once. |
| 16 | Done | Z or the rim button toggles the local view; it is now 2.25× the filled whole-map view (about 3.2× the old diagonal fit). |
| 17 | Done | The old defense bar is gone; wheels keep out of the console, dock and selection panel (`RegisterWheelKeepOut`). |
| 18 | Done | `Commander.Dragging` → overlay canvas fill and border. |
| 22 | Done | Layout per the mockup; the new dominance banner sits under the clock (the status pill steps down). |
| R5 | Done + fixed | F attack move (selection, double-tap for on screen, Ctrl for the whole army), arrows pan, Alt + left/middle drag rotates (`RtsCamera`). **Fixed in review:** the action tutorial still said "Press T for attack-move" (T is the terrain wheel); it now names the bound attack key. |
| R6 | Done + fixed | `{c:'stance'}` values match `STANCES` (`aggressive`, `defensive`, `holdFire`); snapshot index 10 is decoded; rally `action` / `attackMove` match `case 'rally'`; the crossed-out cursor uses `reach`. **Fixed:** the client's assumed default stance was "aggressive" but the server default is "defensive", and the stance tooltip described defensive wrongly. **Implemented:** rally markers from econ `ra:[x, z, mode]` (decoded into `BuildingRecord.HasRally/RallyX/RallyZ/RallyAttackMove`): a ring at the point (green move, red attack move) with a dotted lead from each selected producer, or from every producer of the selected base. |
| R8 | Done + fixed | Floating pause/menu, clock, console bars, era badge, idle button. **Fixed:** idle no longer counts units holding position (flag 2048), standing in a battle line (512) or automatic engineers (4096). |
| R9 | Fixed in review | The minimap now fills the circle: the map's shorter side spans the inner disc, so there is no small square with dark corners. The view slides toward the camera only when the footprint centre would leave the circle, so the clipped corners come into view when the camera goes there; wrapping maps still scroll sideways. The trapezoid footprint is unchanged. |
| R10 | Done | Minimap hp-drop detection → banner naming the nearest own base; Space or a click jumps (`session.LastAlertTile`). |
| R11 | Done | Dock Build (B) and Terrain (T) toggle G's wheels; the keys are read only in `Hud.Base.CommandKeys` (no duplicate handler). |
| R12 | Done + improved | Selection panel boxes per type (one per unit below 6) and the hover card with owner, team and stance. **Added:** clicking a box keeps only those units; Shift+click drops them. **Fixed:** automatic base engineers (flag 4096) were selectable by box, click and double-click (the server ignores orders to them); they are now skipped, also in F's combat selection. |
| R13 | Done (not seen in play) | Nine segments, centre info, top = upgrades, page segment only past nine (G). |
| R14 (U part) | Done | Base wheel 3/5/7 sites, perimeter near the bottom, defenses on the build wheel, per-building era levels (`upgradeBuilding`), perimeter `upgradeDefenses` (G; names checked against B). |
| R17 (U part) | Done + improved | New base via the build wheel (`fieldBuild base_site`). **Added:** the preview's eight-parcel ring (`placement.parcels`) is drawn while placing; the success toast now reads "Construction started" (it was the silent "Order accepted"); Shift+click keeps a build-wheel placement armed. |
| R18 (U part) | Done | Terrain wheel → `{c:'terrain', op, tile, point}` matches `terrainOrder`. |
| R23 (U part) | Done | Lobby and skirmish formats `1v1`–`4v4`, `ffa3`, `ffa4` (K). |
| R24 | Done (code review) | See #10. |
| R25 (U part) | Done | Spectator speed: `{t:'obsCmd'}` → `matches.js` → worker speed and `paused` notice → `ClientSession` updates the speed control. Duplicate move markers: one `OrderIssued` per order. |
| Open: minimap dark corners | Fixed in review | See R9. |
| Open: Decisive Domination banner | Fixed in review | Econ `dominance:[team, secondsLeft]` → a banner under the clock: "DECISIVE DOMINATION · VICTORY IN m:ss" (ours, green) or "ENEMY DECISIVE DOMINATION · DEFEAT IN m:ss" with what breaks it (red); neutral for spectators. Thresholds come from `RULESET.dominance` (`hqShare`, `armyRatio`). The toast and the critical banner step down while it shows. Game over `how` now gets a one-line explanation on the result card (Decisive Domination with the hold numbers, Military Domination, Territorial Control). |
| Open: placement error codes | Fixed in review (needs a one-line server change) | `ServerMessage.ErrorCode` decodes `code`; `Commander.ReadableError` turns `territory`, `road`, `spacing`, `ring`, `era` and `foundation` into short player-facing text at the cursor, on the tool chip and in toasts (field builds, roads, trenches, terrain, building and perimeter upgrades). **The worker drops `code`** (`server/worker.js` sends only `error` for command refusals), so until S forwards it the client also recognises each code from the server's text. |
| Open: rally markers from `ra` | Fixed in review | See R6. |
| Open: P pause vs patrol | Kept | P patrols only with own aircraft selected (`PatrolKeyClaimed`); otherwise it pauses. |

**Server change for S (not made; the server is S's):** in `server/worker.js`, the `m.t === 'cmd'` branch, send `{ t: 'ack', rid: m.rid, error: res ? res.error : undefined, code: res?.code }` so placement refusals carry their code to the client.

**For V to look at in play** (nothing here was seen in the editor):
1. Minimap: the map fills the circle at 1080p and 720p. Drive the camera to each map corner and check that the view slides so the corner shows. Check the Z local view scale.
2. The dominance banner under the clock (force it in a sandbox or a late AI match): width, colours, and that the status pill (116 px) and the toast (154 px) clear it.
3. Rally markers: select a barracks, or a base with a rally point set. Check the ring size (0.32) and the dotted lead (disc dots at 0.06 scale may be too small or too large).
4. New Base placement: the eight parcel corner marks around the cursor.
5. Squads now draw the server's exact living men (`units.MenOf` is wired to unit extra[8] in `GameBootstrap`). Check that casualties remove figures as hp drops.
6. Selection panel box hover and click; the patrol tool chip; the result card text; and that auto engineers can no longer be box-selected.
| — | Placement error codes reaching the client | **Fixed in review** (request from U) — the worker's command ack dropped `code`; now `{t:'ack', rid, error, code}` (`server/commandAck.js`, tested). |

### Review V (editor, visuals, performance): 2026-11-16

Method: Unity 6.3 editor play mode (Game view 1920×1080, also 1280×720), local server on :8093 (restarted after S's changes), combat sandbox `stronghold` and `air`, and a fresh AI match with fog of war. Screenshots in `C:/Users/liamh/AppData/Local/Temp/claude/040b7af8f66681dc/f6eff834-a980-4ffb-8183-45e32eed6366/scratchpad/review_v/` (named below). Whole project compiles with 0 errors (only the pre-existing CS0219/CS0414 warnings).

| # | Status | How verified / what changed |
|---|---|---|
| Known: black round HQ / motor works / power plant | **Fixed in review** | Root cause was not colour or AO: every Blender (SEM1) model was drawn **inside-out**. The exporter swaps Y/Z (a reflection) but keeps Blender's CCW order, so with SE/InstancedLit's back-face culling the outside was culled and the inside drawn. Proven by toggling the material cull (`x_hq_culloff.png`, `x_tank_cullback.png` vs `x_tank_cullfront.png`). `ModelLibrary.Decode` now flips each triangle. This also fixes the near-black vehicles, aircraft, defenses, soldiers and birds. After: `v04_hq_close_fixed.png`, `v05_hq_low_fixed.png`, `v06_base_d9.png`, `v62_base_defenses_d8.png`. |
| Known: HQ team bands as big flat blue discs | **Fixed in review** | `HeadquartersTierDressing` drew full cylinders that capped the drum roofs (and used parcel-scaled `Module` placement while the model is not scaled). The bands are now thin panels: 16 between the lower drum's pilasters, 20 round the upper drum and a tier-3 crown round the cab, placed in the model's own frame. The radomes, beacon, dish and city AA mount use the same placement. `v05_hq_low_fixed.png` |
| Known: base compose cache not measured | **Measured; target partly met** | New diagnostics `CityRenderer.BaseCellComposes / BaseCellComposeMsMax / ComposeMs[4]`. A cache **hit** (replay) costs 13 ms avg / 18.5 ms max per base cell. Of that, the compound itself is ~1 ms; the generic street draping of the cell is ~6.6 ms and the street mesh rebuild ~4.8 ms. A **miss** costs 94 ms avg / 187 ms max. In 130 s of live battle at an HQ there was **one** base recompose (5.8 ms, replayed), at most one per 1.25 s, with no hitch. **Open:** a hit is still above 8 ms because of the street phase, and the first composes at match load are 50–190 ms. |
| 1 / R3 | **Done** | Perf sweep below: ≥30 FPS at every zoom (lowest 1 % low 44.7). |
| 2 / R19 / R25 (small units vanishing) | **Done** | Zoom series 2.5 → 220 (`v10`–`v17`, `v24_enemy_d4.png`): rings, NATO glyph cards on enemies, strategic badges with counts; nothing pops out. |
| 3 / R15 | **Done + fixed** | Round HQ, pads 3/5/7, causeways, glyphs and docking arms (`v04`, `v06`). **Fixed:** defenses under construction drew a house-sized generic building site with a gable house (`v22_city_turret.png`, `v23_barricade.png`). Now the defense's own body rises on its own footprint with scaffold posts (`v60_barricade_site.png`). |
| 4 / flak / turret aim / barrel tips | **Open (not verified)** | The `air` sandbox fights were mostly inside the burning town (`v50`–`v54`). AA airbursts are visible (`v50_air_d6_a.png`, white bursts), but turret yaw, mirroring and muzzle tips were not checked close up. |
| 7 | **Partly verified** | Aircraft fly over the field and helicopters move (`v53_air_d14.png`); full circuits not timed. |
| 8 | **Done** | Rifle squad draws 8 men (`Men=8` on the wire), red helmets on enemies (`v65_enemy_rifle_squad.png`). |
| 9 (visuals) | **Open (not verified)** | Grenade, rocket, marksman and armour effects were not seen close up. |
| 14 | **Not verified** | No level-2 perimeter in these matches. |
| 19 / 21 / R20 | **Done + fixed** | Soldiers and vehicles now render lit (winding fix). The vehicle team tint (36 %) and paint lift that made up for the black models read as pastel toys once lit, so they went to 24 % and ×1.02 (troops ×1.12). Enemy vehicles still read salmon-red (`v65`); a darker red would help. |
| 20 | **Open (not verified)** | No trench network in these scenarios. |
| 22 | **Done** | HUD at 1080p and 720p (`v40_hud_720p.png`) matches the mockup's layout; the minimap fills the circle. |
| R2 | **Done (with a note)** | AI match start: a cloud bank over undiscovered land, explored land readable (`v31_ai_start_5s.png`, `v32_ai_fog_d40.png`). Note: on the camera-facing (south) edge, the cut terrain shows as a jagged grey cliff band under the cloud. |
| R7 | **Done** | Telephoto perspective, zoom-in cap 1.6. **Note:** at zoom 120–220 on the small sandbox island the square ocean slab and the grey void around it show (`v16`, `v17`); a max zoom tied to the map size would hide it. |
| R25 black patches | **Fixed in review** | Wreck scorch was a hard opaque near-black disc (`v18_blackdisc_close.png`). It is now a soft-edged SE/GroundDecal splash (`WarzoneRenderer`). Burning-building smoke also stacked into a black sheet that hid units (`v50_air_d6_a.png`, `v20`). Fire smoke went from .08 / α .46 to .17 / α .30 and soot from .16 / α .40 to .22 / α .32 (`v64_arena_smoke_d14.png`). Shell-burst smoke is still dark in heavy barrages. |
| Damage stages / hex outline | **Partly** | Hex outline visible in team colour at 40 (`v14_battle_d40.png`); damage stage marks were not inspected per type. |

**Performance (editor play mode, 1920×1080, vsync off, RX 7600 XT)**

| Zoom | Sandbox stronghold battle: FPS (1 % low) | AI match with fog, early: FPS (1 % low) |
|---|---|---|
| close 3 | 100 (46) | 260 (173) |
| 14 | 112 (45) | 267 (208) |
| mid 40 | 142 (52) | 279 (219) |
| 70 | 153 (56) | 297 (231) |
| 120 | 176 (59) | 289 (219) |
| strategic 220 | 208 (151) | 289 (215) |

(The AI-match sweep ran at about 1:30 of game time with 6 units and only the start area explored, so it is a light load. The sandbox is the stress case.)

**U's list, checked in play:** the minimap fills the circle at 1080p and 720p; squads keep 8 figures at full hp. **Not checked:** corner sliding, the Z local view, the dominance banner, rally rings, New Base marks, drag box, box click, patrol chip, result card, resource bars filling smoothly.

### Final pass (editor, visuals, performance): 2026-11-16

Method: Unity 6.3 editor play mode at 1920×1080 against a local server on :8093 (restarted after the one server change below), the combat sandbox (`stronghold`, `large`, `strategic`, `air`, `rifles`, `mixed`) and a fresh AI match with fog of war. Scenarios were staged with sandbox and player commands (research, rally, trench, patrol, demolish) sent through the client connection; UI states were driven through the commander and HUD (wheels, placement, drag box, dominance banner, result card). Screenshots: `C:/Users/liamh/AppData/Local/Temp/claude/040b7af8f66681dc/f6eff834-a980-4ffb-8183-45e32eed6366/scratchpad/final/` (named below). The project compiles with 0 errors; `npm test` passes (278 pass, 0 fail).

| Item | Status | How verified / what changed |
|---|---|---|
| A1 Grey cliff band under the fog cloud at the camera-facing edge | **Fixed (mitigated)** | The band was the shroud bank's own camera-facing face, shaded toward `_SE_ShroudShade`. `Shroud.shader` now spreads the depth shading over 2.4 units and darkens less, so the face reads as cloud. The original frame could not be reproduced on the new maps. South edge after the fix: `f93_ai_fog_south_d16_after.png`, `f92_ai_fog_d40_after.png`. Before: `f01`–`f04`. |
| A2 Square ocean edge / grey void at high zoom on small maps | **Fixed** | `RtsCamera.ZoomOutLimit`: the framed ground (turned by the current yaw) must fit the map, ×0.9, clamped to [40, 260]. It is 60–80 on the 64 sandbox, 127 on a 104 map, and 260 on large maps. The focus is also kept so the frame stays on the map at every zoom (proportional to the zoom, so it never jumps). Nothing disappears at the cap; badges and NATO cards still show (`f94_ai_maxzoom_capped.png`, `f63_armoredcar_enemy_d26.png`). Before: `f05_sandbox_maxzoom_capped.png` (yaw-unaware first try), `f44_minimap_corner_nw.png` (void at the map corner). |
| A3 Enemy vehicles salmon | **Fixed** | `UnitRenderer.Paint`: the team colour is first scaled to the camouflage's brightness. Vehicles tint 0.48 and aircraft 0.42 (they were 0.24 and 0.2), plus a 1.15× saturation push and a multiplicative lift; the `+.05` grey added to vehicle paint is gone. Models stay lit. `f63_armoredcar_enemy_d1.3.png` (strong red), `f61`, `f64_armoredcar_own_d1.5.png` (blue). A first try at 0.58/1.3 was toy-like (`f10`, `f12`) and was toned down. |
| A4 Shell-barrage smoke dark | **Fixed** | `EffectsRenderer.Explosion`: puffs and the lingering column are dusty grey-brown (.47/.42/.35 → .64/.60/.53; the column was .07–.13). Also lightened: building-fire smoke (.27 start), ruin smoke emitters (.20–.27), wreck plumes (.13–.18) and the wreck's first puffs. `f11_battle_d10.png`, `f91_battle_smoke_scorch_d12.png`. Large burning towns still read dark grey where many columns overlap. |
| Extra: hard black octagons on the ground | **Fixed** | `EffectsRenderer` scorches and craters were opaque 12-sided discs (left by fallen buildings, `f47`). They now use the soft SE/GroundDecal splash, the same as the wreck scorch (`WarzoneRenderer.ScorchTexture` is now internal and shared). `f91_battle_smoke_scorch_d12.png`. |
| Turret aim / mirroring / mounts after the winding flip | **Done** | Tank and armored-car turrets point at the enemy side, not mirrored. Barrels sit on the turrets, and the armored-car roof HMG points forward over the hood. `f12_own_tank_aim.png`, `f61_armoredcar_own_close_driving.png`, `f64_armoredcar_own_d1.5.png`. |
| Armored car gun truck (lead request) | **Done** | New models imported (unique GUIDs). Wheels sit in the arches on the ground, the gunner and mount are on the roof ring, team colour shows on the body, and nothing is inside-out. Close: `f61`, `f64_armoredcar_own_d1.5.png`, `f63_armoredcar_enemy_d1.3.png`. Mid zoom (26/40): `f64_armoredcar_own_d26.png`, `f64_armoredcar_own_d40.png` (too small to judge the Lo/mount alignment at that size). Wheel spin and steering were not checked frame by frame. |
| Close-up flak | **Partly** | The air scenario fought inside a burning base. AA airbursts are visible in Review V (`v50`) but not in these frames (`f70_flak_close_*`). |
| Damage stages per base building | **Done (7 types)** | HP bands forced client-side on HQ (town), motor works, power plant, airfield, armory, heavy weapons and advanced lab: soot, cavities, rubble, charred panels and smoke emitters (5) appear (`f22_damage_stages_d4b.png`; intact `f21`). Barracks and depot were not forced. The marks are crude dark slabs up close. |
| Trenches | **Done** | `trenchWorld` line built by engineers. The tiles carry `RoadMask` (road links), and rifle squads stand in single file on the trench floor with only heads and shoulders above the parapet (`f40_trench_d4.png`, `f41_trench_men_close.png`). The scar is a soft band along the trench. The server accepted a line through an abandoned relay building. |
| Upgrade effects | **Done (rocket not seen)** | Grenades, rocket teams, body armour and marksmen were researched in the sandbox, then a rifles battle. Client presentation counters (`GameBootstrap.UpgradeFxCount`) recorded grenade 1, marksman 24, armour saves 28 and rocket 0 (no vehicles in that scenario). Streaks are visible (`f80_upgrade_marksman.png`, `f80_upgrade_grenade.png`, `f80_upgrade_armour.png`) but small at that zoom. |
| City AA at perimeter level 2 | **Open (not staged)** | `upgradeDefenses` needs perimeter defenses first. `baseDefenses` was refused on all three sandbox bases ("Clear and scout the outer perimeter lots"), so level 2 could not be reached. |
| Aircraft circuits, return to refuel, P patrol + chip | **Done** | 5 fighters and bombers were sent a 2-waypoint patrol. A 75 s track shows repeated racetrack laps (about 9 × 3 units), bombers returning to the airfield at t=45 s and resuming, and fighters landing to refuel at t=66 s (`patrol_track.txt`). The chip reads "Click waypoints · Shift adds · P, Enter or right-click sends" with the dotted loop and fuel bar (`f72_patrol_planning_chip.png`). |
| Minimap corner sliding + Z local view | **Done** | The minimap slides to the NW corner (`f44_minimap_corner_nw.png`); the Z local view is in `f43`. |
| Decisive Domination banner | **Done** | Under the clock, green, readable, does not collide with the toasts (`f43_dominance_banner_zview.png`). |
| Rally rings | **Done** | Attack-move rally: red ring with a dotted red lead from the barracks. Move rally: green dots (`f42_rally_rings.png`). |
| New Base placement marks | **Partly** | The ghost, the refusal reason ("Outside your territory…") and the tool chip show (`f31_newbase_placement.png`). The 8 parcel corner marks only draw on a valid spot, and the sandbox had none (a 14×15 grid of `fieldPreview` probes was refused). The tool chip text was truncated ("New base · beside a…"); fixed in "Menus + four bugs". |
| Drag box | **Done** | Light-blue fill and border (`f46_drag_box.png`). |
| Selection-panel box click | **Open (not driven)** | The panel boxes show (`f72`). The click was not simulated. |
| Result card | **Done** | "Victory · Decisive Domination" with the explanation line (`f45_result_card.png`). |
| Resource bars | **Done** | Materials update at 5 Hz in +2 steps (15 changes in 3 s, `res_samples.txt`). |
| Radial wheels | **Done** | Build and production wheels: 9 segments, centre text fits, clear of the dock, minimap console and selection panel (`f30_build_wheel.png`, `f42_rally_rings.png`). |
| Crossed-out cursor | **Not verifiable in captures** | Hardware cursor (`Cursor.SetCursor`); screenshots do not include it. The code path was read. |
| Attack-move red marker fade / move marker 1.5 s | **Done** | Red attack ring with an inner ring and a green move ring at 0.3 s (`f47_markers_0.3s.png`); both gone at 1.75 s (`f47_markers_1.75s.png`). |
| Settlement houses (lead request) | **Done for bases** | Held bases have no street-front houses around them (`f64_armoredcar_own_d40.png`, `f93`). Unclaimed neutral compounds still show the old town's ruined shells on their open sockets (`HistoricalBlock`, `f90_neutral_settlement_d9.png`). These are the compound itself, not surroundings, so they were left. |
| Extra: "0 friendly units lost near …" toast | **Fixed (server)** | `actionGame.js engagementReports`: "No friendly units lost near …" and singular "1 friendly unit lost". |
| C Per-cell street cache (hit ≤ 8 ms) | **Open; hitch fixed another way** | In a sandbox battle at a neutral compound, base cells recomposed about once per 1.25 s at ~60 ms (streets ~33 ms per cell), which gave 1 % lows of ~17 FPS at zoom 3–70 (first sweep below). Instead of a street cache, `CityRenderer` now holds the next base recompose back by cost × 0.05 s (60 ms → 3 s, at most 4 s). First appearances are never held. The street-phase cache itself is not built. |

**Performance (editor play mode, 1920×1080, vsync off, RX 7600 XT)**

| Zoom (actual) | Stronghold battle, final build: FPS (1 % low) | AI match with fog, early: FPS (1 % low) | Sandbox `large` before the recompose hold: FPS (1 % low) |
|---|---|---|---|
| 3 | 109 (49) | 260 (206) | 65 (17) |
| 14 | 105 (50) | 260 (209) | 100 (17) |
| 40 | 135 (58) | 259 (180) | 136 (51) |
| 70 (60 capped on the 64 map) | 156 (54) | 279 (180) | 136 (48) |
| 120 (sandbox cap 60–78; AI 120) | 180 (66) | 269 (102) | 155 (51) |
| 220 (sandbox cap 60–78; AI cap 127) | 192 (67) | 281 (216) | 182 (55) |

Every average is ≥ 30 FPS. With the final build, every 1 % low is ≥ 49 FPS. The AI-match sweep ran early in the match (6 units), so it is a light load.

**Still open after the final pass**
- City AA at perimeter level 2 was never seen in play (the sandbox cannot buy perimeter defenses; AI matches rarely reach level 2).
- Per-cell street cache (C) not built; recomposes are throttled instead.
- New Base parcel corner marks and selection-panel box click were not seen; the crossed-out cursor cannot be captured.
- Flak close-up not captured in this pass; the rocket-team effect never fired in the staged fights.
- Neutral compounds keep ruined shells on their sockets (by design; flagged for the lead).
- Units and their rings: rifle-squad figures often stand outside their own ring (`f12`, `f80`). Fixed in "Menus + four bugs" below.
- A flat, straight-edged light/dark split across the terrain shows in some sandbox frames (`f60`, `f91`). Fixed in "Menus + four bugs" below (rain-wet weather cells).

### Menus + four bugs: 2026-11-16

Details in `docs/CHANGELOG_2026-11-16.md`, section "Menus + four bugs". Screenshots: `D:/Projects/se_scratch/menus/`.

| Item | Status | How verified |
|---|---|---|
| Rifle-squad men outside their ring (`f12`, `f80`) | **Fixed** | Each unit type has a fixed ring size (it does not follow spread, casualties or selection; it grows only when zoomed far out). Formations are centred and capped, and every man is clamped inside the ring. On slopes the ring is laid at the highest edge ground. In play: `b1_rings_close_d3.png`, `b1_rings_d7_fight.png` (casualties), `b1_rings_d26_720.png`. |
| Straight light/dark split on the terrain (`f60`, `f91`) | **Fixed (cause found in code)** | Rain-wet ground was filled per 8×8-hex weather cell, so each cell drew as a straight-edged block. It is now blended bilinearly (`WeatherState.Sample`). The wet split could not be reproduced on demand in this pass. |
| Trench dug through a building | **Fixed (server + client)** | Trench strokes and new road edges are refused across building walls and outpost compounds with `code: 'blocked'`. The readable message is "Blocked by the bunker · draw the line around it". There is a new test. In play: `b3_trench_blocked_toast.png`. |
| New-base tool label cut off | **Fixed** | The tool chip sizes to its text, and the cursor reason wraps and flips at the screen edge. `b4_newbase_chip.png`. |
| Menu design review (main, Skirmish, Multiplayer, Lobby, Settings, map picker) | **Done** | 1080p and 720p: `m0`–`m13`. Fixed the white text fields, unreadable seat buttons, the wrong map filter, the "?" random card and the lopsided Skirmish layout. Added section headings and the compact map card. Escape was checked on every page. |
| Diverse games: formats, uneven teams, maps, AI per seat, rules | **Done** | Formats 1v1–4v4 and FFA 3/4 (the server also accepts FFA 5/6). Closed seats give uneven sides on random worlds in Skirmish and the lobby. Every catalog map, plus a random world with style, size and seed. Difficulty and personality per AI. Victory and starting resources (new server option). A 1 v 2 skirmish on Max resources and a 3 v 2 lobby (a guest and a spectator, Territory, High) were both started against the local server. |
| Spectator slot, public lobby list, Steam | **Done (Steam not tested)** | Lobby spectator seats (`spectate` a lobby, `watch`, `sit`). A public lobby browser (`/api/lobbies`, Watch / Join). The Private/Public toggle drives both the server listing and Steam. The Steam invite paths are unchanged and were not tested end to end. |
| Extra: random-world capitals stacked on neighbouring hexes | **Fixed (server)** | Found while starting the 3 v 2 lobby. Starts keep a hard minimum distance. New test `action-start-spacing`. |
