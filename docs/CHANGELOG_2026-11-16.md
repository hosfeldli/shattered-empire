# Changelog: 2026-11-16 feedback round

One section per workstream (see `docs/PLAN_2026-11-16.md`).

## H. Controls and camera input

**Changed**
- **Key layout** (`Runtime/Input/InputFacade.cs`, which also drives the Settings key-binding list):
  - pan on the arrow keys (screen edges still pan); rotate moved off Q/E to `,` and `.`; WASD and Q/E are now unbound;
  - `F` attack move (also flips a battle line while one is drawn, as before); `V` cycles stance; `G` follows the selection (was F); `H` hold and `X` withdraw unchanged; `C` unit wheel is now labelled optional;
  - new action ids reserved for other streams: `terrain` (T, terrain wheel, G) and `minimap_zoom` (Z, F). `build` is relabelled "Build wheel".
  - One-time migration (`se.keys.version` = 2) drops saved bindings for pan, rotate, attack, follow and build, so old WASD/Q/E/T saves don't survive the new layout.
  - `InputFacade.MiddleDown` added.
- **Alt + drag rotates** (`RtsCamera.cs`, input only): Alt + left or middle drag started over the map turns the yaw (`MouseRotateSpeed`, 0.25°/px). `RtsCamera.MouseRotating` is true meanwhile; the commander doesn't start a selection box or place a point while it is. Alt + right drag is still the advancing battle line.
- **Attack move** (`Session/Commander.Orders.cs`, new file): `F` with units selected arms it and the next click sends `{c:'move', attackMove:true, point, queue}`; Shift-click keeps it armed for more points; right-click or Esc cancels. Double-tap `F` (within 0.35 s) selects every combat unit on screen and arms it; `Ctrl+F` does the same for the whole army; `F` with nothing selected acts like the double tap. Combat unit = has a weapon/attack and isn't `defensiveOnly`/`civilian`. The marker is red (`Order.Kind == "attackMove"`, coloured in `Commander.DrawOverlay`) and the per-unit order lines use the existing red "attack" kind.
- **Stances**: `V` (and the selection panel button) cycles aggressive → defensive → hold fire and sends `{c:'stance', units:[ids], stance}` with stance one of `"aggressive"`, `"defensive"`, `"holdFire"`. A refusal toasts the server's reason and rolls the local value back.
- **Rally points with an action**: with production (buildings or a base) selected and no units, right-click sets a move rally, `F` then click sets an attack-move rally. Sent as `{c:'rally', buildings, tile, point, action:'move'|'attackMove', attackMove:bool}`; a marker is drawn for both.
- **Crossed-out cursor**: while units are selected (or attack move / rally is armed), the cursor becomes a red crossed-out circle over ground the selected ground units can't reach, and a red crosshair while attack move is armed. Hardware cursor drawn in code (`Cursor.SetCursor`), reset over the UI and on `Commander.Dispose`.
- **C-then-2 flow**: basic orders no longer go through the unit wheel (F, V, H, X act directly). The wheel (`C`) stays for abilities, air missions and digging in; Hud.Base.cs (G) was not touched.
- Text: field guide hotkeys (`FieldGuide.cs`, both rulesets), the two camera tutorial lines (`Hud.Action.cs`, `Hud.cs`, one string each), and a SettingsView comment.

**API for other streams (F: selection panel and markers, G: wheels)**
- `Commander.ArmAttackMove(AttackScope scope = Selection)` → bool; `AttackScope { Selection, Local, All }`; `Commander.AttackMoveArmed`.
- `Commander.ArmRallyAttackMove()`, `Commander.RallyAttackMoveArmed`.
- `Commander.CycleStance()`, `Commander.SetStance(string)`, `Commander.SelectionStance` (stance id, `"mixed"`, or null), `Commander.StanceLabel(string)` ("Hold fire"), `Commander.Stances`, `Commander.DefaultStance` (assumed for units we never set; "aggressive"), event `StanceChanged(string)`.
- event `Commander.OrderIssued(string kind, Vector3 mapPoint)`; kinds `move`, `attackMove`, `attack`, `capture`, `collect`, `deploy`, `rally`, `rallyAttackMove`. `Commander.Order.Kind` carries the same value for the marker list.
- `Commander.TargetImpassable`, `Commander.Impassable(Vector3 mapPoint)`, `Commander.SelectCombatUnits(bool onScreenOnly)`, `Commander.ResetOrderCursor()`.
- `RtsCamera.MouseRotating`, `RtsCamera.MouseRotateSpeed`.

**Protocol needs (C)**
- `{c:'stance', units, stance}` in the action ruleset with stances `aggressive`, `defensive`, `holdFire`. If C names hold fire differently, change `Commander.Stances` (one line); `StanceLabel` already accepts `hold_fire` and `passive`.
- `rally` should read `action` (`'move'` | `'attackMove'`); today the server always rallies with `mode: 'assault'` and ignores the field.
- The stance isn't decoded from action snapshots, so the panel shows what this client last sent (default "aggressive"). If C sends stance per unit, decode it and prefer it in `SelectionStance`.

**Verified**: dotnet type-check of Runtime/Core/Net, 0 errors.
**Not verified** (no editor in Wave 1): anything in play. In particular the Alt-drag feel and direction, the cursor art and hotspot, the double-tap timing, and whether the client `Terrain` bytes in the action ruleset follow the server `T` enum (water is also detected from the water level, so lakes and sea work either way).
**Risks / notes**
- `X` is withdraw, so F's minimap zoom should use `Z` (the `minimap_zoom` action) rather than Z/X.
- Comma and period rotate field defenses before placement (`Commander.Rings.cs` reads `rotate_left/right`); G may prefer the wheel or R.
- `Hud.DefenseBar.cs` still says "Q/E rotate" in a tooltip; G is replacing that bar.
- The client impassable check is an approximation (water without road, peaks, off-map); steep slopes the server refuses aren't flagged. Swap in C's query if one lands.

## G. Radial menus (base, build, terrain)

**Changed**
- **`RadialMenu.cs` (rewritten).**
  - Every wheel is nine 40° segments, with segment 1 centred at 12 o'clock. Segments meet each other and the centre with no gap; hairline separators are drawn between them. Unused segments draw as dim, inert glass, so every wheel has the same shape.
  - The centre circle is enlarged (r 70; wedges 70–158). It shows the hovered item's name, description, cost (Materials, Energy, seconds, digit) and lock reason. With nothing hovered it shows the subject and its detail. The readout card below the wheel is gone, and nothing covers the icons.
  - A next-page segment (11 o'clock, key 0) appears only when a ring has more than nine items. In that case each page shows 8 items plus the next-page segment.
  - Progress is a green ring that fills clockwise around the item's icon. The queued count ("×3") sits at the bottom of the item.
  - The backing is about 86 % opaque, with a blur-free two-disc drop shadow and a dark rim, so the wheel reads over busy bases.
  - Placement:
    - the bounding circle is clamped to the safe area;
    - the wheel is pushed out of the minimap circle and out of every rectangle in `RadialMenu.KeepOut`, taking the smallest move that stays on screen.
  - Digits: 1–9 pick segments clockwise, and 0 turns the page.
  - New: `EnterItem(id)`, `PressItem(id)`, `HoveredId`, `SegmentOf/SegmentAngle`, `RadialClick.Alt`.
  - Performance: fixed child pools, 10 Hz sampling, transform-only movement, and a repaint only on change. No per-frame allocations.
- **Base wheel (`Hud.Base.cs`).**
  - Top segment: the HQ tier upgrade (U).
  - Sites (3 / 5 / 7 by tier; locked ones show a lock and tier numeral) fill the other seven segments. Each one points at its parcel on screen (greedy nearest angle).
  - Perimeter sits at 200°, near the bottom. It builds, rebuilds (n/6) or upgrades (`upgradeDefenses`, level 2 adds city AA), and is shown as "Lv n" and maxed at the top level.
  - An empty site opens a sub-ring of the nine facilities (centre info; hovering previews the facility in the world). This replaces the pop-out picker. Clicking a parcel in the world opens the same sub-ring.
  - Defenses are no longer on the base wheel.
  - Outer arc: Rally, Base production, All production (only with production at 2+ bases), Repair HQ.
- **Building wheel.**
  - Top segment: building upgrades.
    - With Armory or Barracks techs, it is an "Upgrades" sub-ring holding the era level upgrade plus the techs.
    - With only levels, it is the level upgrade itself (`{c:'upgradeBuilding', id}` for every eligible selected building; "Lv n" caption; progress from project kind `level`).
    - Otherwise it is disabled ("This building has no upgrades").
  - Then the training items, then missile build/launch.
  - Rally, Reinforce, Repair and Demolish moved to the outer arc, so the units keep the segments.
- **Batch production.**
  - Unit clicks send `batchTrain` across every host in the selection: Shift ×5, and **Alt queues one in each building** (`policy:'each'`). Ctrl toggles repeat.
  - Selecting 2+ own HQs gives subject `prod:` and opens one roster over all their production buildings.
  - `OpenProductionWheel(siteIds)` does the same for a caller.
  - A roster spread over several bases anchors at the dock.
- **Build wheel (B / dock Build button).**
  - Segments: Trench, Road, Sandbags, Watchtower, Bunker, AT, AA, Outpost (`fort`), New base (`RULESET.newBase.type`, default `base_site`, placed via `fieldBuild`).
  - Support emplacements (artillery, sensor, repair, plus any other field building the server adds) go on the outer arc.
  - It opens just above the bottom-centre dock (`DockWheelLift`, default 112).
  - Picking an item starts placement and closes the wheel.
  - Tier-locked items are disabled with the reason. Without a server definition an item reads "Not available on this server".
- **Terrain wheel (T / dock Terrain button).**
  - Items come from `RULESET.terrain.ops` (raise, lower, flatten, smooth), with cost and time from `RULESET.terrain`.
  - A click starts target mode and sends `{c:'terrain', op, tile, point}`.
  - The tool chip shows "Raise ground" and so on.
- **Old bottom defense bar removed** (`Hud.DefenseBar.cs` now holds only the tool chip and the cursor reason). Its USS, the picker USS and the readout USS were removed from `SE.Command.uss`. The tool chip moved to bottom 112, above the dock. Its rotate keycaps read the bound `rotate_left/right` keys (`,` and `.`), per H.
- **Placement reason at the cursor.** It already covered field builds (`fieldPreview`, so outpost, new base and defenses). It now also covers trench and road strokes: `Commander.StrokePreviewReason` is set from the preview error in `Commander.Action.cs` `DrawActionTrench`, which is the only change in that file.
- **Icons** (`Icons.cs`, additive cases only): `new_base`, `terrain`, `terrain_raise`, `terrain_lower`, `terrain_flatten`, `terrain_smooth`.
- **Protocol (client)**: `ObjectiveSite.DefenseLevel` is decoded from the site's `defenseLevel` (one field in `Messages.cs`, one assignment in `ProtocolDecoder.cs`).

**API for other streams**
- Hud (public):
  - `OpenBuildWheel(bool keyboard=false)`, `OpenTerrainWheel(...)`, `ToggleBuildWheel(...)`, `ToggleTerrainWheel(...)`;
  - `BuildWheelOpen`, `TerrainWheelOpen`;
  - `RegisterWheelKeepOut(VisualElement)`;
  - `DockWheelLift`;
  - `OpenProductionWheel(IEnumerable<int> siteIds)`.
- F already calls the toggles and registers console, dock and card. Until something is registered, conservative default keep-out rectangles apply: console 420×312 bottom-left, dock 200×96 bottom-centre, selection panel 640×250 bottom-right.
- The B and T keys are read from H's `build` and `terrain` actions inside `Hud.Base.CommandKeys`, and both toggle.
- `Commander.StrokePreviewReason`.
- F's `SelectAllProduction()` (`Hud.Console.cs`) is used by the console button. G's base-wheel arc uses its own private `SelectEveryProduction()`, so the two cannot collide.

**Verified**
- dotnet type-check: 0 errors and 0 warnings in my files (`RadialMenu.cs`, `Hud.Base.cs`, `Hud.DefenseBar.cs`, the `Commander.Action.cs` edit, `Icons.cs`, the protocol fields).
- At check time the remaining project errors were other streams' work in progress: `CityRenderer.RoadConnections.cs`, and the patrol members in `Commander.cs` and `Hud.cs`.
- The server command names and fields were checked against B's code: `upgradeBuilding {id}`, `upgradeDefenses {site}`, `terrain {op, point}`, `fieldBuild base_site`, `batchTrain policy:'each'`, and project kinds `level`, `defenses`, `perimeter`, `tier`.

**Not verified** (no editor in Wave 1)
- Everything visual: the centre text fitting in the 140 px circle (the name is 2 lines max and the detail 3, both clipped), icon and count positions, shadow strength, and keep-out pushes at 1080p and at other UI scales.
- Whether F's registered elements' `worldBound` matches their visible footprint. If an element spans more than its drawn area, wheels may sit higher than needed.

**Risks / notes**
- The base wheel can no longer be exactly centred on a base near the bottom of the screen: it is pushed up out of the dock, selection panel and console. This is intended.
- The `SettingsView` toggle "Show defense bar hotkey labels" (`GameSettings.DefenseBarHotkeyLabels`) is now unused. H or the lead can drop or relabel it.
- `FieldGuide.cs` still describes "eight wedges" and the panel below the wheel. That is H's text: it should say nine segments with the centre circle, B for the Build wheel and T for the Terrain wheel.
- `docs/UI_DESIGN_SPEC.md` B6–B8 and B11 are superseded by this section.
- The perimeter level falls back to the lowest `city_turret` level when `defenseLevel` is absent (older servers).

## J. Units: art, readability, trenches, squads

**Changed**
- **Troop meshes** (`tools/blender/build_soldiers.py`, re-exported to `Runtime/Resources/Models/Soldier0-6.bytes` and `SoldierAnim0-6.bytes`, plus new `SoldierTeam0-6.bytes`):
  - a new stylised figure: slightly exaggerated proportions (head and helmet ×1.22, broader shoulders, chunky gloves, boots and weapon), a lighter uniform palette, flat low-poly forms. About **1,050 triangles per soldier, down from 4,824** (6,408 → ~2,050 vertices). Same skeleton, bones and clips, so the baked animation and every pose in `UnitRenderer` are unchanged. The old high-detail builder is kept in the script as `soldier_mesh_detailed` for reference only (not exported).
  - **Team colour on helmet and shoulders**: the helmet (cap for militia, hard hat for engineers) and two shoulder pads are a separate skinned overlay mesh on the same bones (`SoldierTeam<r>`, 156–260 triangles). `SoldierRig.TeamMesh` loads it; `UnitRenderer` draws it as one extra instanced batch per role with the same transform and animation frame as the body, coloured with the owner's relation colour (saturated, never dark). No shader change was needed. If a `SoldierTeam` file is missing the soldier simply has no helmet.
  - Operational-zoom figures (the simple `MeshKit.Soldier`) blend 45 % toward the team colour, since helmets are too small to read there.
  - Paint: troops 1.3× lighter with a 20 % team tint; ground vehicles take a **36 % team tint** (was 12 %), lifted so nothing reads near-black; damage darkens less (84–100 %, was 70–100 %). Vehicles get two bold team squares on the glacis instead of one small mark. Vehicle models (`build_military.py`) were not re-exported: they are almost entirely `paint` surfaces, so the tint does the work (previewed).
- **Readability** (`Runtime/Military/UnitRenderer.Readability.cs`, new):
  - every ground unit has a **team-coloured outline circle at every zoom**. It keeps a minimum on-screen size (`max(base, camDist × 0.0105)`) and also rings each strategic badge. The selection ring takes its place when selected (was: a faint ring hidden under distance 12).
  - **Role glyph over enemy units**: a NATO-style card (team-coloured frame, dark card, white glyph) that faces the camera and keeps a constant on-screen size: X rifle, / militia, thick X exo, X with a bar for special forces, Λ anti-armour, Π engineer, a tube on a base for mortars, a track oval for armour (with a bar for carriers and a slash for recon cars), a dot for artillery, Λ over a bar for AA, and a bar with two wheels for trucks. At most 6 plates per enemy unit, one instanced batch, no shadows. Strategic zoom shows one glyph per badge. `UnitRenderer.IsHostile` is wired in `GameBootstrap` to `session.IsHostile` (one line).
- **Squads follow the server's man count** (B's `SQUAD_MEN`): rifle squad 8 men (was 6 drawn), militia 6, special forces 5, exo 4, anti-armour 3, mortar 3, engineer 1. `AliveMen` mirrors the server's `ceil(hp / maxHp × men)` from the hp percentage on the wire (allowing for its rounding). Casualties remove men in a fixed id-seeded order, and the survivors keep their places. Optional `UnitRenderer.MenOf(id)` hook if an exact men field is ever sent. Operational zoom draws up to 4 men per squad (2 for exo). `MaxFigures` is now 10. Fallen soldiers keep their team gear on the death clip.
- **Trenches**:
  - the dug cut (`TerrainView.DamageHeight`) and the brown scar (`ChunkMeshJob.DamageVertex`) now follow the **actual drawn line**. The new `TerrainView.TrenchNearest` gives the nearest point on a node's half-links to its joined neighbours, or a ±0.42 run across the facing for a lone node, exactly as `WarzoneRenderer` draws it. The scar is trimmed to the trench length and narrowed (0.24 instead of 0.32 + 1.02-long bands along a fixed axis).
  - The links are computed in `WorldModel.ApplyTrenches` with WarzoneRenderer's rule (route bits ≤ 2.2, same owner ≤ 1.35) and packed into the facing slot of `TrenchGeometry` (`TerrainView.EncodeTrenchFacing`: facing wrapped to ±π + 16 × link mask; read back with `TrenchFacing(n)` / `TrenchLinks(n)`). **Anyone reading `Trenches[n*4+2]` directly must use `TrenchFacing(n)`**; the three existing readers are converted.
  - **Troops no longer sink**: the extra −0.035 ground drop and −0.045 stand-down were removed, because the shared ground height already contains the cut. Men stand on the cut floor (+ duckboard), are held at the rim until their hop, never go below `GroundHeight`, and spread along the dug line (following bends, never past the end).
- **Upgrade visuals for B's functional upgrades** (event flags decoded in `ProtocolDecoder`: `CombatEvent.Grenade/Rocket/Marksman/Armoured` from `gr/rk/mk/ar`; new `Runtime/Effects/EffectsRenderer.Upgrades.cs`; small edits to the `fire`/`launch`/`hit` cases in `GameBootstrap`):
  - grenade launches fly as a lobbed grenade (not a mortar shell, no muzzle flash) and land with a dust ring (`GrenadeBurst`). The server's impact event still gives the blast. The old client-side random grenade lob was removed, since the server now sends the real ones.
  - Rocket-team launches fly as a small rocket with a smoke trail (`at_rocket`) and a back-blast (`RocketBackBlast`).
  - Marksman shots draw one long bright streak (`MarksmanShot`) instead of a tracer.
  - Hits absorbed by body armour strike a small spark (`ArmourSave`).
  - The worn kit (grenades, slung rocket, plate carrier, scope; equipment bits 32/64/128/256) and the tank add-on armour (bit 2) were already drawn and are unchanged.
- **No black blobs**: the crater disc (0.14 → 0.27 brown), scorch marks (0.035–0.06 → 0.17–0.21 burnt earth), wreck instances, metal and charred rubble, cook-off debris, explosion clods, battlefield wreck scorch and debris, and the trench floor were lifted to soil and ash tones. The crater-floor scorch in the terrain (`ChunkMeshJob`, crater code) is now dark soil (soil × 0.6) instead of 0.075 near-black.

**Verified**
- dotnet type-check (Runtime/Core/Net): 0 errors in J's files. The 16 remaining errors are other streams' work in progress (Hud.*, CityRenderer.RoadConnections, GameBootstrap IGameActions).
- Blender 5.3 headless export of all 7 soldier roles (body and team overlay). Preview renders: `scratchpad/jsoldiers_preview.png` (body in field uniform, overlay in blue and red), `scratchpad/jveh_preview.png` (vehicle models are paint-dominated).

**Not verified (no editor in Wave 1)**
- Everything in play: how the overlay looks animated and in-engine lit, glyph legibility and lighting (lit plates facing the camera), ring sizes against A's new perspective camera, how strong the vehicle tint looks against the terrain grade, and trench scar and foot height on real trench networks.
- `TrenchNearest` runs inside the Burst terrain job: it uses only `System.Math` and pointer reads, like the code it replaces, but it was not compiled by Burst.

**Risks / notes**
- Soldiers now cost two instances each (body + overlay; the overlay casts no shadow). Triangles per soldier are still ~1,300, against 4,824 before. Glyphs add up to 6 small instances per visible enemy unit.
- The link mask packed into the trench facing float is a contained encoding. `WarzoneRenderer` reads `TrenchRecord.Facing` from the session, not the view, so it is unaffected.
- The hp-derived men count can be off by one at an exact boundary because of the wire's percentage rounding. Send a men field and set `MenOf` if that matters.
- Grenade launches play the generic "launch" sound. The audio director has no grenade-throw cue.
- The new `SoldierTeam*.bytes` need Unity to generate `.meta` files on the next import.

## C. Server: pathfinding, movement, orders, stances

Files: `server/sim/actionNavigation.js`, `server/sim/actionOrders.js`, the movement and stance parts of `actionGame.js` (the `stance`, `reach`, `rally`, `hold` and `attack` commands, `reinforce`, and the unit and building snapshot fields) and of `actionCombat.js` (`stanceStep` and the hold-fire check), plus `server/worker.js` (observer speed notice). New tests: `test/action-pathing.test.js` (11 tests) and its reusable scenario builder `test/action-pathing-scenarios.mjs`. `test/spectator.test.js` is extended.

### What changed
- **Bridges for every vehicle.** Any usable road over a river or water is now a bridge for both wheeled and tracked units. Before, tanks were refused on dirt-road bridges and got "No selected unit can reach that ground".
- **Coarse routes follow the road onto bridges.** Some tiles are passable for a movement class only on a road: water, lakes, wide rivers for vehicles, and cliffs. A unit can now only enter or leave such a tile along a usable road edge (`nav.roadOnly`, `nav.edgeOk`, `nav.stepCost`). Routes no longer step off the side of a bridge.
- **Routing through compounds.**
  - Coarse A* and flow fields add a crowding cost for how much of each tile buildings and wrecks cover (`nav.crowding`).
  - When a corridor step is blocked, the path smoother tries wider local searches, then skips the bad portal, before it fails the order.
  - When the destination is crowded, the search for a free spot widens, so units are no longer left behind as `blocked`.
- **Base lanes.** Movement collision now uses only the solid walls of a building footprint. Thin decoration rectangles (fences and posts under 0.12 wide) are ignored, and walls get 0.03 of slack. Before, the inner court of a developed base was sealed for tanks and SP artillery; now every spawn point inside it can drive out.
- **No sliding into buildings.** `canMove` lets an overlapping unit move away from what it overlaps (its escape allowance). That allowance now applies only to a unit that already overlaps something. Before, free units used it to slide into footprints and stayed trapped for good.
- **Groups.**
  - Groups of 4 or more share one flow field (the threshold was 12), so they take the same corridor around obstacles.
  - Formation slots face from the group's centre to the destination.
  - Slots keep the group's arrangement: the units furthest forward take the front row, and left-to-right order is kept, so paths do not cross.
- **Convoy speed.**
  - A multi-unit move travels at its slowest member's pace. Members more than 1.3 behind the leader drive at their own speed until they close up.
  - A vehicle following another vehicle now matches its speed. Before, each car in a column went at 0.88× the speed of the one ahead, so long columns slowed to a crawl.
- **Speed.**
  - Ground units move at **0.7× their definition speed** (`GROUND_PACE`, 30% slower).
  - Open ground (grass and plains) is one cruising speed per unit type.
  - Roads give +20% (was +50%); rough ground slows units by at most 20%.
  - Aircraft speeds are unchanged and left to D's flight and fuel work.
- **Jams.** A progress check (`stallCheck`) replaces "blocked forever":
  - no progress for 2.5 s within about 1.4 of its slot: the unit counts as arrived;
  - every 4 s without progress: the unit passes through allies for 2.5 s, plans again, and steps out of any structure it is wedged in;
  - 60 s without progress: the unit gives up.

  In your own team's territory, allied units need only half the usual clearance to pass each other.
- **Stances** (server behaviour):
  - `aggressive`: idle units chase visible enemies within about 6.5 and return to their post. They chase at most 4.5 from it.
  - `defensive` (**default**, the old behaviour): units fire at whatever enters range and never chase.
  - `holdFire`: units never choose their own targets. Explicit attack orders and attack-moves still fire.

  Hold position (`{c:'hold'}`) is unchanged.
- **Attack-move** (`{c:'move', attackMove:true}`): units fire on the move and stop to fight anything in range, as before. They now also turn aside to engage a visible enemy within about range + 2.6 of their line of advance, then resume their original destination and order queue.
- **Rally action:** units sent to a rally point move or attack-move as the rally point says.
- **Spectator speed.**
  - Cause of "the speed buttons do nothing": the native client sends spectator commands as `{t:'obsCmd'}`, and the server rejected that as an unknown message.
  - K added an `obsCmd` case in `matches.js`. I had added the same case and removed mine in favour of K's.
  - The worker now also sends `{t:'paused', on, speed}` to spectators after a speed change, so the HUD's speed control updates.

### Protocol (for F, H and G)
- `{c:'stance', units:[ids], stance:'aggressive'|'defensive'|'holdFire'}` returns ack `{}`. Any other value, or no owned units, is an error. These are exactly the values H sends. Current orders continue.
- Unit snapshot row (action ruleset):
  - **Index 10 is the stance code:** `0` aggressive, `1` defensive, `2` holdFire. It is sent for every visible unit, friendly or enemy, so the hover card can show it.
  - **Flag bit 2048** in index 8 means the unit is idle and holding position (from the `hold` command).
  - Index 9 is still the order mode, sent only for your own units.
- `{c:'rally', id|buildings, point, action:'move'|'attackMove', attackMove:bool}`:
  - `action:'move'` or `attackMove:false` sets move;
  - `action:'attackMove'` or `attackMove:true` sets attack-move;
  - neither sets attack-move (the old behaviour).

  When a rally point is set, your own buildings in the econ snapshot carry `ra: [x, z, mode]`, where mode is 1 for attack-move and 0 for move.
- **Reachability query:** `{c:'reach', units:[ids], point:{x,z}, move?}` returns `{t:'ack', rid, reach:{ok, all, reachable, units, reason}}`.
  - `reason` is `null`, `'impassable'` (the point itself is water, cliff, or inside a structure for these units) or `'unreachable'` (the point is passable but cut off, such as the far bank with no bridge, or an island).
  - It is cheap: a lookup of connected regions, cached per terrain version, with no route search.
  - Aircraft always count as able to reach.
  - With no units, `move` (`'infantry'|'wheeled'|'tracked'`) picks which class to test.
  - Suggested client use: send it on right-click, or on hover throttled to about 5 Hz. Show the crossed-out cursor when `ok` is false (or when `all` is false).

### Measurements
All scenarios come from `test/action-pathing-scenarios.mjs` on the 104 map with seed 9. Route ratio is the distance driven divided by the shortest passable route.

| Scenario | Before | After |
|---|---|---|
| 12 tanks, river, dirt-road bridge | order refused, 12/12 stuck | 12/12 arrive, ratio 1.05 (max 1.08), spread 21 s |
| 12 tanks, river, paved bridge | 5/12 arrive (7 jammed at the far bank), 9119 blocked ticks | 12/12, ratio 1.05, spread 23 s, 352 blocked ticks |
| 12 armored cars, paved bridge | 5/12 arrive | 12/12, ratio 1.05, spread 18 s |
| Mixed 12 around a lake and mountain spur | 7/12 arrive, spread 50 s | 12/12, ratio 1.06 (max 1.11), spread 19 s |
| 8 tanks and SP artillery leaving a developed base | 2/8 (4 got no route, 2 trapped in footprints) | 8/8, ratio 1.05 |
| The same 8 re-entering the base | 1/8 | 8/8 |
| Mixed 10 on open ground | 8/10, spread 64 s | 10/10, spread 8 s |
| Cruise speed ÷ definition speed (tank / rifles / armored car) | grass 1.00 / 1.00 / 0.88, road 1.51 | 0.70 for all on grass and plains, road 0.84, forest 0.62–0.65 |

Arrival times after the change include the 30% slow-down.

Cost:
- A 10-minute AI-vs-AI sim on the 104 map averages about 0.3 ms per tick (navigation p95 0.09 ms).
- A 120-unit order in the 1000-unit `massive` sandbox resolves in 25 ms.

### Verified and not verified
- `npm test`: the new and changed tests pass. The only failure in my area is the known "action saves continue deterministic spatial simulation" hash. Other failures seen mid-run came from concurrent base edits and passed on rerun.
- Not verified in the Unity client: the client does not yet read index 10 or `ra`, and does not send `reach`.

### Risks
- The default stance is `defensive`, so AI and existing behaviour are unchanged. If the design wants `aggressive` as the default, change `stanceOf` in `actionOrders.js`.
- The 30% slow-down changes match pacing (first contact comes later), so E's balance sims should be rerun.
- Base lanes depend on B's and I's layout. If new footprints put solid walls closer together than one tank width (about 0.53), the inner court can seal again. The test "large units leave and re-enter a developed friendly base" will catch it.

## F. HUD per the mockup (docked console, minimap, selection, hover, markers)

**Changed** (layout follows `docs/design/hud_mockup_2026-11-16.png`; action ruleset only, the legacy ruleset keeps its top bar)
- **No top bar** (`Hud.Shell.cs`). In the action ruleset the bar gets `se-topbar--floating`: transparent, and `PickingMode.Ignore` so the top strip clicks through to the world. What stays:
  - the floating group at the top right: pause and menu, plus speed and observer controls for spectators and the sandbox;
  - a **match clock** at top centre (`mm:ss`, or `h:mm:ss` after an hour). It comes from `session.Units.NewestTime`, the server match time of the newest snapshot, and its text is set only when the second changes;
  - the status pill (recovery, objective held, observing), which moves under the clock.

  The toast, the critical banner, the result card and the alert feed move clear of the clock and console through the root class `se-hud--action`.
- **Minimap console** (new `Hud.Console.cs`; 420×312 at left 16 / bottom 16, around the existing 240 minimap):
  - **Era hexagon badge** on the circle's upper-left rim, in the accent colour with a Roman numeral from `econ.age`. Its tooltip names the era from `Defs.AGES[age].name` when one is sent.
  - **Slim resource bars** beside the circle: dark slanted strips (painted, `SlantBack`) with the glyph, the amount and the rate. Materials and Energy show the 10 s average income as before. Command shows used/cap, "+queued" and a thin load line. Hover (0.35 s) or click pins the existing breakdown popover, which now opens beside the bar and grows upward. A short resource flashes the strip's outline red.
  - **Idle units button** (person glyph and count): our ground units with no motion, no path, no target and no recent fire. Engineers, aircraft and civilian units are excluded. Click selects them all and jumps the camera to one; each further click jumps to the next. It dims at 0 and is hidden for spectators.
  - **All production button** (shown only once you have production): selects every finished production building, and G's building wheel then batch-queues across them. `Hud.SelectAllProduction()` lives here, and G's base wheel uses its own private copy.
  - **Local view toggle** on the rim, also on `Z` (H's `minimap_zoom` action; falls back to `Z` if unbound).
  - **Attack banner**: "CINDERHOLD UNDER ATTACK · Space to jump", or "FORCES UNDER ATTACK" away from a base. It names the nearest own base within max(6, 2 × radius) and lasts 6 s. It shows on a *new* attack only: a different place (more than 10 units away) or the same place after 20 s of quiet. It sets `session.LastAlertTile`, so Space (the `alert` action) and a click on the banner both jump there. The minimap pings (now red, bigger rings) on every detection.
- **Minimap** (`Minimap.cs`):
  - The whole map still fits the circle by default.
  - **Local view (×3)** centred on the camera footprint. Terrain images now move by `translate` (no layout pass). The aggregation grid is sized once for the closest view, so toggling never allocates.
  - **No unit blobs**: one owner's units in a 4 px cell merge into one dot whose size grows at 2/4/8/16 units. Before, they collapsed into a single unit-sized dot.
  - The **camera footprint** is a filled trapezoid with an outline; it already came from the four ground corners.
  - New `UnderAttack(x, z)` callback (the old under-fire detection, still throttled to 2.5 s), plus `Zoomed` and `ToggleZoom()`.
- **Bottom-centre dock**: Build (`B`, building glyph) and Terrain (`T`, hex glyph), 80×64 each. They toggle G's wheels (`ToggleBuildWheel` / `ToggleTerrainWheel`), or the `DockBuildPressed` / `DockTerrainPressed` delegates that G assigns. They show selected while the wheel is open. The console, dock and selection panel are passed to G's `RegisterWheelKeepOut`. Hidden for spectators.
- **Selection panel**, bottom-right (`Hud.Action.cs`, `SelectionPanelWidth` 560 at right 16 / bottom 16, max height 300):
  - head: "N units selected" (the unit name for one), **Attack move · F** (`Commander.ArmAttackMove()`, highlighted while armed) and **Stance: X** (`Commander.CycleStance()`, label from `SelectionStance` / `StanceLabel`);
  - a box per unit type (glyph well, name, ×count; at most 6 boxes, the last one "N more types"). Below 6 units there is one box per unit, showing its condition in % (warn colour at 60 % or less);
  - the condition bar and the crossing / rerouting line as before.

  The panel stays up while attack move is armed. The control-group chips (`Hud.Command.cs`) now sit just above the panel. The C-wheel button was dropped from the card (H: basic orders don't need the wheel). `UnitRole` was rewritten as "role · weak to …" lines.
- **Hover card** (new `Hud.HoverCard.cs`) for any unit, friendly or enemy:
  - the name, a relation-coloured "Owner · Team X" ("You · Team A"), the role line, and "Condition N% · Stance: X";
  - the stance shows for own units only (`Commander.StanceOf`, what this client last sent); fuel shows for aircraft once wired (see below);
  - the unit is picked at 10 Hz (nearest within 18 px), settles for 0.15 s, follows the unit by `translate`, and its text changes only when values change;
  - hidden over the UI, while a mouse button is held or a box is dragged, and in menus.
- **Drag selection box** (`Hud.Overlay.cs`): `Commander.Dragging()` existed but nothing drew it. It is now a translucent blue fill with a bright border on the battle overlay canvas (same repaint-if-changed hash).
- **Move markers** (new `Session/Commander.Markers.cs` and one block in `Commander.DrawOverlay`):
  - **Root cause of "the green circle never goes away"**: `Resolve()` stamps `Order.Time` with `Time.unscaledTime`, but `DrawOverlay` and `Update` compare against the bootstrap's own clock. That clock accumulates clamped `dt`, so it lags `unscaledTime` after any hitch. The order's age stayed negative, so the ring stayed at full strength and was never removed. A second cause: the HUD drew a pulsing ring at every selected unit's destination for up to 90 s, one per unit.
  - Now: one marker per order, fed by H's `Commander.OrderIssued` event, which the HUD subscribes to. It is green for move and red (with an inner ring) for attack move, attack and attack-move rally. It pops in, then shrinks away by 1.5 s, timed only on `Time.unscaledTime`. A repeat at the same spot within 0.25 s replaces the earlier marker instead of stacking; at most 12 are kept.
  - The action ruleset no longer draws `Orders` rings; the legacy ruleset keeps them, including H's Kind colour. The HUD's dotted order lines now fade out within 1.5 s and have no destination ring.
- Styles: a new block at the end of `SE.uss` (clock, floating bar, console, resource bars, round buttons, dock, hover card, selection panel). `SE.Minimap.uss` and `SE.Command.uss` are unchanged.

**API / contracts for others**
- Fuel: the hover card shows "Fuel N%" for aircraft from `UnitStore.Record.Fuel` (0..255, decoded by D from `air[1]`; nothing is shown at -1). `Hud.UnitFuel` (static `Func<int,int>`) can override it. The selection panel doesn't show fuel yet.
- `Commander.StanceOf(int id)` (in `Commander.Markers.cs`): the server stance, else the last one sent (see the addendum below).
- `Commander.AddOrderMarker(kind, mapPoint)` (static), `Commander.SelectUnits(ids)`, `Commander.JumpCamera(mapPoint)`.
- Constants `Hud.ConsoleWidth/ConsoleHeight`, `Hud.DockWidth/DockHeight`, `Hud.SelectionPanel*` for anything that must keep clear.
- The dock delegates `DockBuildPressed`, `DockTerrainPressed`, `DockBuildActive`, `DockTerrainActive` are declared in `Hud.Console.cs`; G assigns them in `UpdateCommandUi`.

**Verified**: dotnet type-check (Runtime/Core/Net), 0 errors in F's files. The only remaining errors at the time of the check were in workstream I's in-progress `Runtime/Cities/CityRenderer.Authored.cs`, `.Defenses.cs` and `.RoadConnections.cs` (`Part.Def*`, `MinRingParcels`, `CausewayConcrete`). USS braces balanced.

**Not verified** (no editor in Wave 1):
- everything visual: console geometry against the 240 minimap (bars docking on the bezel, era badge and idle positions), how the slanted bars look, Button default theme styles leaking into `se-resbar`, `se-console-round` and `se-dock-button`, clock width and hover-card placement;
- whether UI Toolkit's rounded `overflow: hidden` clips the local-view terrain and the footprint fill cleanly;
- whether the attack heuristic (own unit or building hp drops) fires too often in long fights (throttled to 2.5 s; the banner only shows on new places or after 20 s);
- the `ui_alert` sound cue, which may not exist (it is silently skipped if not).

**Risks / notes**
- `.meta` files for the new `Hud.Console.cs`, `Hud.HoverCard.cs` and `Commander.Markers.cs` will be generated by Unity on import.
- Hover picking projects every unit 10 times a second (`unitAt` + `ToScreen`). Fine for hundreds; with thousands, A may want a spatial pre-filter.
- Idle detection is a client heuristic (no motion, path, target or recent fire). If the server ever sends an idle flag, use it.
- Optional "production view" near the minimap was not built (low priority); only the all-production select.
- Spectators see the console with the followed civ's economy; the idle, production and dock controls are hidden.


**F addendum (after C finished)**
- **Stance from the server.**
  - Decoding: `ProtocolDecoder.DecodeUnit` reads unit-row index 10 into `UnitWire.Stance` (-1 when absent or not an integer). `UnitStore.Record` has a new `Stance` field, copied in `Apply`. These are small additive edits in Core.
  - `Commander.StanceOf(id)` now prefers the server code (0/1/2 → `Commander.Stances`) and falls back to what this client last sent.
  - H's `SelectionStance` uses `StanceOf`: one line in `Commander.Orders.cs`. So the selection panel, `V` and the panel button all cycle from the server's value.
  - Flag bit 2048 (holding position) is `Commander.HoldingFlag`. `Commander.SelectionHolding` is true when every selected unit holds; the panel then reads "Stance: Hold".
  - The hover card shows the stance for every unit that has a server code, enemies included, with "Hold" while holding.
  - A stance just changed shows the old value until the next snapshot.
- **Crossed-out cursor uses C's `reach` query.** `Commander.ReachBlocked(point)` lives in `Commander.Markers.cs`.
  - It sends `{c:'reach', units, point}`, adding `move:'infantry'` for a rally with no units.
  - It asks only when the hovered hex isn't cached, at most every 0.2 s (5/s), one request in flight (released after 2 s without a reply).
  - Answers are cached per hex for 4 s, and the cache is dropped when the selection changes. The hex is marked blocked when `reach.ok` is false.
  - H's `UpdateTargetCursor` now ORs it with the client-side `Impassable(p)`: one line in `Commander.Orders.cs`. Until a hex's reply arrives, only the client-side check applies.
- Not done: the rally markers from the econ `ra:[x,z,mode]` field (optional).
- Not verified: the reach round-trip feel. The cursor may lag about one request (~0.1–0.2 s) when it enters a new hex.
- Type-check: 0 errors outside workstream I's in-progress Cities files.
## K. Multiplayer and lobby

Files: `server/matches.js` (lobby and routing), `test/lobby-controls.test.js` (new, 8 tests), `Runtime/UI/MainMenu.cs`, `Runtime/UI/GameActions.cs`, `Runtime/UI/MapPreview.cs` (new: catalog entry, preview parser and renderer, `MapPicker`), `Runtime/Resources/UI/SE.Menu.uss` (new rules appended), `Runtime/Social/MatchRoom.cs`, `Runtime/Social/SocialPlatform.cs`, `Steam/SteamInvites.cs`, and the lobby parts of `GameBootstrap.cs` (`SendLobby`, `HostMultiplayer`, `StartCampaign`, the `create` message, `OnRoom`).

**Changed**
- **Spectator speed buttons.** The client sends spectator commands as `{t:'obsCmd', rid, cmd}` (`GameConnection.ObserverCommand`). `matches.js` had no case for it and answered "Unknown message". A new `obsCmd` case forwards the command to the worker, for spectators only. C's worker change sends the `paused` notice back to spectators.
- **Lobby formats.** There are now team modes `1v1`–`4v4` and free-for-all formats `ffa3` and `ffa4`; the server also accepts `ffa5` and `ffa6`.
  - `create` accepts `format` (or `teams` with `teamSize`), which sets exactly `teams × teamSize` seats. Team is still `seat / teamSize` (`actionGame.js`), so changing a player's team just swaps their seat.
  - New Skirmish (`mode:'ai'`) uses the same formats. The player sits in seat 0 and the AIs fill the other seats. Each AI's settings come from `rivals[i]`.
- **Lobby controls (server, validated).**
  - The host is tracked by reference (`m.hostSlot`), so the host keeps the role when seats move. `isHost`, `start`, and the host leaving all use `hostOf(m)`.
  - A player may move only themselves, and only to a free seat (open, or held by an AI, which then swaps into their old seat). The host may move anyone.
  - Changing the format or the map rebuilds the seats in this order: seated players first, then AIs, then open seats. Each keeps its team where there is room. It is refused if more players are seated than the format has seats; in that case nothing changes.
  - A catalog map sets the format and size. A format that doesn't fit the chosen map switches the map to `random`. A random world re-sizes with the seat count, or keeps the host's `mapSize`.
- **Start rule.**
  - A lobby created with `waitForReady:true` (the Unity client always sends it) starts when every human seat is taken **and** every player is ready, or when the host presses Start.
  - Older clients (no flag) keep the old rule: start when the last seat is taken.
  - When the match starts, open seats become AI with `difficulty:'normal'`.
- **Lobby page (client).**
  - Format segmented control (host only; guests see the format as text).
  - Teams column, one box per team, each with a team colour dot. Each box has a "Join" button to move yourself.
  - For the host, each AI seat has a difficulty chip and a personality chip (click: next value, right-click: previous) and a remove button. Each open seat has "+ AI". Each other player has "Team ›" to move them to the next team. Anyone can "Sit" in an open seat or an AI's seat.
  - Map picker with preview: the host picks from every map, filtered to the seat count, with "All maps" available. Guests see a preview of the host's choice.
  - Start is enabled for the host at any time (open seats become AI).
  - A "Friends only / Public" Steam visibility button for the host.
- **New Skirmish.** Format control and a list of allies and rivals (difficulty and personality per AI), plus a "Difficulty (every AI)" control that sets them all. Same map picker and preview. World style and size apply only to random maps. Sends `format`, `ais` and `rivals`.
- **Multiplayer page.** "Host lobby" plus the format to open with. The map, AI seats and teams are chosen in the lobby. The old per-team-size map list is gone.
- **Map preview.** This is E's format (`actionMap.js` `mapPreview`): base64 `cells` indexed into `classes`, `aspect`, and `starts` / `bases` / `outposts` with normalised `u, v` (starts carry `seat`).
  - It renders to a cached texture: terrain colours by class name, start discs in team colours (blue, red, then FFA colours; team = seat / teamSize), base rings and outpost dots, drawn `aspect` wider than high.
  - The parser is tolerant: it also accepts row strings, char grids, hex, numeric arrays, a `legend`, and grid-cell coordinates.
  - A map without a preview, or with an unreadable one, gets a plain card with its format. Checked with a dotnet harness against the live `mapList()`: all 10 current maps parse, with correct starts and teams.
- **Steam on Spacewar (480).**
  - Lobbies carry `se_game` and the new **`se_version`** (`Application.version`), plus `se_format` and `se_mapname`.
  - Invite, friends-list and `+connect_lobby` joins are refused, with a clear status, when the host's version differs.
  - "Join a friend" lists friends' lobbies only when both the game and the version match. It also runs a public lobby search filtered with `AddRequestLobbyListStringFilter` on `se_game`, `se_version` and `se_status=lobby` (worldwide, at most 50), so we only see our own subset of Spacewar.
  - The host can make the lobby public with `SetLobbyType`. The member limit follows the room's human seats (`SetLobbyMemberLimit`). `OnRoom` re-applies the Steam lobby data whenever the code, format, map, human seats, visibility or size change.

**Protocol (server/matches.js; every change answers with a fresh `room` to everyone, a refusal with `{t:'error'}` to the sender; an optional `rid` also gets `{t:'ack', rid}`)**
- `{t:'seat', to, seat?}`: move yourself to seat `to`. Host only: `seat` moves any seat (a swap).
- `{t:'team', team, seat?}`: move to a free seat of team `team` (0-based); an open seat is preferred over an AI's. Host only: `seat` moves anyone.
- `{t:'addAi', seat?, team?, difficulty?, personality?}` (host): an open seat becomes an AI. Personality can be `'random'`, or left out for a random one.
- `{t:'removeAi', seat}` (host): an AI seat becomes an open seat.
- `{t:'aiDifficulty', seat, difficulty?, personality?}` (host): difficulty is one of `easy | normal | hard | expert | brutal`; personality is one of `warlord | merchant | builder`.
- `{t:'mode', mode}` (host): `1v1 | 2v2 | 3v3 | 4v4 | ffa3 | ffa4 | ffa5 | ffa6`.
- `{t:'map', map}` (host): a catalog id or `'random'`.
- `{t:'obsCmd', rid, cmd}`: spectators only. The worker validates the command.
- `create` gains `format`, `teams` and `waitForReady`.
- `room` gains `teams`, `format`, `players` and `waitForReady`. Each slot gains `seat`, `team` and `host`. `isHost` and `host` follow the host's seat.
- `IGameActions` gains `SendLobby(JObject)`. `HostMultiplayer(teamSize, map, format = null)` takes a format. `CampaignOptions` gains `Format` and `Ais`. `LobbyMessages` gains `Seat`, `Team`, `AddAi`, `RemoveAi`, `AiSettings`, `Mode` and `Map`.

**Verified**
- `npm test`: the new `test/lobby-controls.test.js` (formats, AI seats, teams and permissions, format changes, maps, the ready start, outsiders, `obsCmd` routing) and the existing `match-lobby` and `action-maps` tests pass. The only full-suite failure is the known "action saves continue deterministic spatial simulation".
- dotnet type-check: the Steam assembly (`SteamInvites` + Social + GameActions) builds with 0 errors. In Runtime/Core/Net, none of K's files show errors. The remaining errors at the time of checking were other streams' work in progress (Hud.Console/HUD partials, CityRenderer.RoadConnections, Commander air patrol).
- Preview parsing against the live catalog (above).

**Not verified** (no editor in Wave 1; no second PC)
- Anything on screen: the lobby, picker and skirmish layout at 880 wide, chip widths, the preview look, and the right-click on the chips.
- Steam end to end: overlay invite, rich-presence "Join Game", public search, version refusal. Use the procedure below.

**Risks / notes**
- **Spacewar launches Spacewar.** An invite accepted while our game is not running makes Steam start app 480's own executable. Both players must start Shattered Empires first.
- The Steam overlay needs a standalone build. It does not appear in the editor, and in some setups only after a restart of Steam.
- Builds must report the same `Application.version`. A local or dev build with a different version will not see or join a release build's lobbies; this is intended.
- A public lobby on 480 is visible to anyone running the same version of our game. The default stays friends-only.
- If a newer server's catalog has map ids the client's built-in list lacks, the picker shows the server's name with a plain card until `/api/maps` loads.
- Old clients (the web/Godot clients) keep the "start when full" rule. Unity lobbies no longer start the moment the last friend joins: everyone presses Ready, or the host presses Start.

**Manual two-PC Steam test (Spacewar 480)**
1. **Setup.**
   - Build the same commit on PC A (host) and PC B (guest), so `Application.version` matches.
   - Sign in to two different Steam accounts that are friends. Steam must be running on both.
   - Keep `steam_appid.txt` (480) next to the exe, or leave it out: 480 is the default.
2. Start Shattered Empires on **both** PCs (not through Steam: an invite to a closed game launches Spacewar itself). Check that Multiplayer shows "Steam: <name>" on both.
3. **Host (A).**
   - Multiplayer → pick `2v2` → Host lobby. The lobby page opens with a code, and the note reads "Steam lobby open · 1 member · v<version>".
   - Shift+Tab should show the Steam overlay.
4. **Invite join.**
   - A clicks "Invite Steam friends" (the overlay invite dialog opens) and invites B.
   - B accepts in the Steam chat or overlay. B's status should read "Joining <A>'s lobby…", then B lands in the same lobby, in the next open seat.
   - On A, the seat shows B as connected, and the note reads "2 members".
5. **Lobby controls.** On A:
   - "+ AI" on the last open seat; cycle its difficulty and personality (B sees the chips' values as text); remove it and add it again.
   - "Team ›" on B, then switch the format to `ffa3` and back to `2v2` (B keeps a seat).
   - Pick a map from "All maps" (the format follows the map) and check that B's preview updates.
   - On B: "Join" on the other team; "Sit" on an AI's seat. Check that B cannot change AIs, the format or the map (B has no controls for them).
6. **Ready start.** B presses Ready, then A presses Ready. The match should start on both PCs (open seats become AI). Repeat with A pressing Start before B is ready.
7. **Rich-presence join.**
   - New lobby on A. In B's Steam friends list, right-click A → "Join Game".
   - B should join the lobby the same way as in step 4. Also try B's Multiplayer → "Join a friend": A's lobby should be listed with "2v2 · <map>".
8. **Filtering.**
   - On A, click "Friends only" to make the lobby Public. On B, "Join a friend" should still list it, marked public.
   - Run a build with a different version on B (or change *Player Settings › Version*). The lobby must not appear, and an invite or Join Game from it must be refused with "Version mismatch: the host runs v… you have v…".
   - Any other Spacewar lobby must never appear.
9. **Leaving.**
   - B presses Leave: A sees the seat open again.
   - A presses Leave: B gets "The host closed the lobby" and returns to Multiplayer.
   - Once a match has started, the lobby is not joinable from the friends list (`se_status` = running).
10. **Spectate speed.**
    - Training & Extras → Watch AI Match (or spectate by code). The speed buttons (pause, 1×, 2×, 4×, 8×) must change the clock, and the HUD speed control must follow.
    - In a multiplayer match the speed buttons stay refused ("Game speed is fixed…").

## B. Server: placement, territory, engineers, bases, economy, upgrades

### What changed
- **Build only in your own territory.** `fieldBuild` / `fieldPreview` (every defense, the outpost and the new base), `trenchWorld` and `roadBuild` now require `world.owner[tile] === civ.id` for the centre and (for rotated sandbags) every footprint corner, every trench section and every road edge. Enemy, allied and neutral land are refused. Territory that is lost keeps what is already built, but nothing new can be placed there. Errors now carry an optional `code`: `territory` | `road` | `spacing` | `ring` | `era` (the `error` string is unchanged in form). The trench preview adds `outside` (sections dropped for being outside the territory). Automatic HQ road links (`connectSiteRoads`) are unaffected.
- **Defenses claim territory.** A finished Watchtower (`guard_post`), Bunker, Anti-Armor Emplacement (`turret`), AA Battery, Artillery Emplacement: radius 1. The Outpost (`fort`): radius 2 (it exists to extend territory, so it gets more than the plan's radius 1). A dug trench section: radius 1. They only claim **unclaimed** hexes and never take land from a base or outpost. Unfinished structures claim nothing. The territory refreshes when one finishes (`game.territoryDirty`) and every ~5 s; the result goes through the usual tile record owner field.
- **Automatic engineers** (new `server/sim/actionEngineers.js`).
  - `engineer` is no longer trainable (`ACTION_UNITS.engineer.auto = true`; removed from `barracks.trains`, and `train` refuses it). The start roster is 3 rifle squads and a scout buggy, and the HQ adds its engineers.
  - Every base with an operational HQ keeps **2 / 3 / 4 engineers by base tier** (`RULESET.autoEngineers`). A new or re-established HQ is staffed at once; a lost engineer is replaced free after 25 s. They don't use command capacity and don't capture or contest sites. If their base falls they join the nearest base.
  - Player commands skip them: `command()` filters `u.auto` units out of every unit group. The AI never drafts them.
  - Jobs, picked by distance and load: build placed field structures (1 engineer = the structure's build time, each extra adds 0.6×); dig trench sections (~4 s per section within 1.3 of the engineer); lay player roads edge by edge; carry out terrain works; repair damaged own structures; patch idle damaged vehicles within 9 of home. When hit they run home for 6 s, unless the civ has Field Engineering.
  - Field structures (except perimeter pieces, which the HQ project still builds), trench sections and **player** road projects now make progress **only while an engineer works them**. Base ring facilities build as before (nearby engineers still add +20% each, up to 2).
- **New base buildable** `base_site` ("New Base", 1000 Materials, 60 s, field structure placed with `fieldBuild`). Rules: own territory; the tile or a neighbour carries a road; at least `RULESET.newBase.minGap` (5.0 world units) from every base site and 3.5 from outposts; a full eight-parcel ring must fit (dry, level, no reserved parcel, trench or structure). When the engineers finish it, the placeholder is removed and a **real base site** is appended to `game.sites`: `founded: true`, `kind: 'town'`, eight-slot ring, owner = builder, an **operational tier-1 HQ** at once, its own engineers, a territory refresh and automatic road links. Event `{k:'found', b: tile, bx, bz, ow, site}`. The preview reply adds `x, z` (the snapped tile centre) and `parcels: [[tile, x, z, yaw] ×8]` so the client can draw the ring footprint.
- **Base ring sites 3 / 5 / 7** by tier (`openSlots`, `siteWire.capacity`, `RULESET.slots = [3,5,7]`; parcels are still 8 + HQ, so saves and layouts are unchanged).
- **Era levels per building** (`{c:'upgradeBuilding', id}`). Level 1 → 2 needs era II (`civ.age ≥ 1`), and 2 → 3 needs era III. The level is bought on the individual building as a project of kind `level`. Each eligible definition carries `levels: { max: 3, effect, desc, cost: [toLv2, toLv3], time: [20, 30] }`:
  - `output` (depot, power_plant): +40% output per level;
  - `production` (barracks, motor_works, heavy_weapons, airfield, advanced_lab): −15% training time per level;
  - `defense` (every field structure with a weapon, plus sandbags): +30% max HP (applied on completion), +25% firepower, +0.35 range per level.
  - The level is the existing econ field `lv`. Perimeter pieces are refused here and upgraded together instead (below).
- **Perimeter upgrades and city AA** (`{c:'upgradeDefenses', site}`, HQ project kind `defenses`, `CITY_DEFENSES.upgrade = { max: 3, aaLevel: 2, cost: [{260,140},{420,240}], time: [25,35] }`). Each level needs the matching era and an existing perimeter. It sets `site.defenseLevel`, and every perimeter piece (including ones rebuilt later) takes that level. **City AA:** `cityAA(site)` (exported from `actionBases.js`) is true when `defenseLevel ≥ 2`. Site wire: `defenseLevel` (1-3, base sites) and `aa: 1` when the city has built-in AA. **D fires it** (B only provides the trigger).
- **Smaller footprints**: sandbags radius .38 → .26 (width .62 → .50, depth .45 → .34); the watchtower .26 → .18. Trenches and roads are already one per hex and unchanged. Renames: `guard_post` is now **Watchtower**, and `fort` is now **Outpost** (tier 2, 300/90, 45 s, radius .45, attack 26, range 3.6, claims 2). Keys are unchanged.
- **Functional upgrades** (new `server/sim/actionUpgrades.js`, hooked into `actionCombat.js`; the flat percentage effects were removed):
  - `grenades`: an infantry squad within 1.4 of the enemy infantry or structure it is fighting lobs a grenade every 9 s: a 24-damage area burst (radius .45, resolved as indirect fire, so trench cover drops from .43 to .21). It leaves no crater. Launch event flag `gr:1` (weapon index = mortar).
  - `rocket_teams`: rifle squads, militia and special forces fire an AT rocket (`atgun`, 34 damage) at a vehicle or structure in range every 14 s. Launch event flag `rk:1`.
  - `body_armor`: the first hit that would kill each soldier is absorbed (the man survives at 1 HP). The limit is once per man (`u.plates` counts saves). Hit event flag `ar:1`, which is always emitted on a save, even with `d:0`.
  - `marksmen`: every 12 s an engaged squad fires a 24-damage precision shot at 1.45× its range, preferring crews and artillery, then infantry. Fire event flag `mk:1`. The old +10% range is gone.
  - `field_engineering`: engineers keep building and repairing under fire, and idle damaged tracked or wheeled vehicles self-repair at 1.2 HP/s up to 70%. The old +25% build rate is gone.
  - `heavy_armor`: tracked vehicles ignore small arms (`carbine, rifle, smg_team, mg, mg_light, pistol`), and wheeled vehicles take half. The old −16% is gone.
  - `improved_logistics` (renamed from "Industrial Efficiency"): a unit leaving a production building with somewhere to go moves 35% faster for up to 45 s, until it arrives (`u.hasteUntil`; one line in C's `unitMotion` pace). The old processor and generator boost is gone, because building levels do that now.
  - `networked_command`: every unit and structure sees 1.5 hexes further and detects hidden units within 2.5. The old +40 command capacity is gone.
  - The civ-wide equipment bits are unchanged (unit extra[7]: 1 infantry_training, 2 heavy_armor, 4 aircraft_systems, 8 field_engineering, 16 networked_command, 32 grenades, 64 rocket_teams, 128 body_armor, 256 marksmen).
- **Squads are made of men** (`ACTION_UNITS[t].men`): rifle squad 8 (HP 112 = 8 × 14; it was 100), militia 6, special forces 5, exo 4, anti-armour 3, mortar 3, engineer 1. The living count is `ceil(hp / maxHp × men)`, and a squad's firepower is `max(.25, alive / men)`. Numbers are open to E's balance pass.
- **Income every tick.** `productionStep` (every 3 ticks) now only computes `civ.rates`; a new scheduler task `income` (every tick) adds `rates × 0.1 s`. The rates are unchanged.
- **Terrain works** (`{c:'terrain', op:'raise'|'lower'|'flatten'|'smooth', point|tile, preview?}`, `RULESET.terrain`):
  - It costs 60 Materials. The engineers walk to the point and work for 6 s. It affects the centre hex plus its ring (excluding water, rivers, lakes, mountains, base parcels, structures and trenches): raise and lower move it ±0.06 (the ring half that), flatten sets it to the centre height, and smooth averages it with neighbours. Elevation is clamped to [.02, .50], so it never creates water or mountain.
  - Own territory only, at most 6 at once per civ, and no overlap.
  - The preview reply is `{terrain: {op, tile, tiles, cost, seconds}}`. The new heights reach 3D clients through the normal `geo` stream (elevation byte) once the tiles are visible.

### Protocol summary (for F, G, J, D)
- New commands: `upgradeBuilding {id}`, `upgradeDefenses {site}`, `terrain {op, point|tile, preview?}`. `fieldBuild`/`fieldPreview` accept `type:'base_site'`. The `engineer` unit can no longer be trained.
- Errors may carry `code` (`territory`, `road`, `spacing`, `ring`, `era`).
- Unit record: flag bit **4096** = automatic base engineer (not selectable for orders), and **8192** = Improved Logistics haste active. C already uses 2048 for braced. Extra array index **8** = living men (`[x, z, yaw, vx, vz, abilityCooldown, altitude, equipment, men]`).
- Site wire (base sites): `capacity` (3/5/7), `defenseLevel` (1-3), `aa` (1 when city AA is active), `founded` (1 for a built New Base), and `engineers` (owner only: the living engineer count).
- Econ snapshot: `projects: [{id, o, kind:'road'|'terrain', op?, t?, tiles?, edges?: [[a, b]...], p: percent}]` (own player roads and terrain works in progress; god sees all). Building project kinds can now also be `level` and `defenses`; `wk` stays `['u', pct]` for both.
- Events: `found` (new base founded), and the flags `gr` / `rk` on `launch`, `ar` on `hit`, `mk` on `fire`.
- Definitions (`welcome.defs`): `BUILDINGS[k].claims`, `BUILDINGS[k].levels`, `BUILDINGS.base_site`, `CITY_DEFENSES.upgrade`, `UNITS[k].men`, `UNITS.engineer.auto`, and `RULESET.{slots:[3,5,7], autoEngineers:[2,3,4], territoryBuild:true, newBase:{type,cost,minGap}, terrain:{ops,cost,time,step,min,max,desc}, fieldConstruction:'engineers'}`.

### AI (`actionAI.js`, build and placement logic only)
- It ignores its auto engineers (they are filtered out of `owned`) and no longer queues `engineer`. Wounded units fall back to any repair unit at home, the auto engineers included.
- New `developBases`, every 10 s once its army floor is met:
  - era level upgrades for its depots and power plants;
  - a perimeter level 2 (city AA) once it has a surplus;
  - after 7 min, with no expansion target and ≥ 1350 Materials, it places a **New Base** on the nearest valid road hex in its territory (checked with the same `fieldPreview` rules).
- Its forward defenses already respect the territory rule, and any placement it tries outside is simply refused.

### Files
- New: `server/sim/actionEngineers.js`, `server/sim/actionUpgrades.js`, `test/action-bases-2026-11.test.js`.
- Edited:
  - `actionDefinitions.js`: buildings, upgrades, men, ruleset;
  - `actionBases.js`: placement, levels, perimeter, income, production;
  - `actionEconomy.js`: roads, territory, engineers hook;
  - `actionGame.js`: begin, capture, territory, visibility, income task, commands, wires;
  - `actionAI.js`;
  - `actionCombat.js`: small hooks only, `attackRange`/`acquire` range, `damageActionTarget` armour, `fire` firepower and kit, no crater for `p.small`;
  - `actionOrders.js`: one haste line;
  - `actionMap.js`: `planRing` exported;
  - `test/action-rts.test.js`: updated for 3/5/7 slots, the start roster and tick income.

### Verified
- `test/action-bases-2026-11.test.js` (10 tests, all pass) covers:
  - placement refused on enemy and neutral land (fieldBuild, trench, road) and allowed in own territory;
  - two auto engineers that are uncommandable, untrainable and free of capacity; a bunker that waits for them, then gets built; respawn;
  - watchtower and trench territory claims, and the claim removed with the structure;
  - 3/5/7 slots;
  - a New Base placed, built by engineers and turned into a founded site with HQ, ring and engineers;
  - the depot level (era-gated, +40%) and the perimeter level 2 with `aa`;
  - heavy-armour immunity, body-armour saves, men and firepower;
  - rocket `rk` events and the networked vision gain;
  - terrain raise carried out by engineers;
  - income rising on every tick.
- `test/action-rts.test.js`: all pass except the known "action saves continue deterministic spatial simulation".
- AI vs AI on a 104 map (pangaea, seeds 9 and 21, 20 min): the AIs establish bases, their engineers build the AI's forward defenses and respawn after deaths, armies reach 38–78, and one game ends in a domination win at about 14 min. Tick cost: field economy p50 0.04 ms and production p50 0.05 ms.

### Not verified / risks
- **The AI rarely reaches building levels or New Base in sims**: materials stay scarce (E's economy and balance pass), so `developBases` seldom triggers. The logic is covered by the rules tests, not by an observed AI game.
- Territory creep: chaining outposts (2 hexes each, 300 Materials) extends territory into neutral land on purpose. It can never take enemy or base land.
- Engineers are required for field works, so a player with every base lost (or all engineers dead in the 25 s gap) sees construction stall. That is intended.
- The rifle squad HP rose from 100 to 112 (8 × 14), and wounded squads now fire weaker. E should re-check infantry balance.
- Grenade and rocket projectiles reuse the `mortar` and `atgun` weapon indices with `gr` and `rk` flags; clients that ignore the flags draw a small mortar shell and a field-gun round.
- The territory dirty flag is not saved; a restored game catches up within ~5 s. The known save-determinism test was already failing.
- The `improved_logistics` haste is one line in C's `unitMotion` (`if (u.hasteUntil > game.time) pace *= 1.35`). C should keep it if they restructure the pace code.

## D. Air operations, fuel, AA

### What changed

**Server** (new `server/sim/actionAir.js`; small hooks in `actionCombat.js`, `actionGame.js`, `actionDefinitions.js`).
- **Fuel.** Each aircraft type has an endurance, `ACTION_UNITS[type].fuel`, in seconds of flight: fighter 60, bomber 90, helicopter 120, recon drone 50, strike swarm 45, one-way drone 35.
  - Airborne aircraft burn 1 s of fuel per second (`u.fuel`).
  - At bingo (fuel ≤ flight time to the nearest base + 6 s reserve), an aircraft returns on its own to the nearest friendly refuelling point and lands. Refuelling points are airfields, headquarters, and the Advanced Systems Lab for drones and swarms; airfields are preferred.
  - On the ground it refuels from empty to full in 10 s and repairs 15 %/s. It then **relaunches and resumes** what it was doing: the patrol route, the mission point, the attack target, or the spot it was orbiting.
  - AI aircraft also relaunch on their own once serviced. Before this, AI aircraft that were sent home damaged stayed grounded for good.
  - **Not strict.** Bingo triggers once per sortie, so a player can override it. A dry aircraft never explodes: it limps at 35 % speed, cannot fire or strike, and keeps heading home. The owner gets one "out of fuel" note.
- **Patrol command** `{c:'patrol', units, points:[{x,z},…]}` (1–8 waypoints).
  - Aircraft fly a looping circuit through the waypoints. With one waypoint they fly a station orbit; with two, a racetrack between the points.
  - Waypoints beyond fuel range (`speed × endurance × 0.4` from the nearest refuelling base) are pulled back toward that base.
  - The reply is `{t:'ack', patrol:{patrol, waypoints, clamped, range, route:[[x,z],…], note?}}`. `note` is set when a waypoint was clamped.
  - Refused (with `error`) when no aircraft are selected, there are no valid points, or the selection is only one-way drones.
  - `airMission` with `mission:'patrol'` now goes through the same command.
- **Flight paths.** Aircraft no longer hover.
  - Fighters fly racetracks of about 23 map units per lap (2 × 3.2 legs, 1.6 turn radius). Bombers fly about 27.
  - Helicopters and drones fly a loose 8-point circuit of radius about 2.2 (about 2.5 hexes across) that changes slightly every lap.
  - Aircraft with nothing to do orbit where they are.
  - Jets on an attack order fly strafing passes through the target, then turn wide. Helicopters circle the target inside weapon range.
  - The next lap is queued before the current one ends, so there is no pause between laps.
  - `game.returnAircraft(u)` now uses the same refuelling-base search.
- **Flak airbursts.** A new event fires for every AA round:
  `{k:'flak', a, b, s, t, w, bx, bz, y, p:[dx,dy,dz,…], o:'hit'|'miss'}`
  - `(bx, bz)` is the burst centre; `y` is its altitude above the ground (the target aircraft's altitude); `p` gives the puff offsets of the 3–6 shells in the volley.
  - It is emitted by AA batteries and city AA (the `airburst` projectile, on resolution) and by mobile AA (`flak` hitscan against aircraft).
  - It is fog-filtered like other events. The old `impact`/`ab:1` events are still sent.
- **City AA.** A finished headquarters fires AA airbursts (range 4.6, 15 damage, every 1.8 s) when its city defenses are upgraded. See `cityHasAA` for the trigger.
- **Snapshot.** The air array of a unit (index 18) is now `[state, fuel, 0, mission, missionTile, -1, waypointCount]`.
  - `state` (own aircraft): 0 on the pad, 1 refuelling, 2 airborne, 3 returning to base, 4 out of fuel.
  - `fuel` is 0–255 for the owner and -1 for others; other viewers see state 0 or 2 only.
  - `mission` indexes `['patrol','route','intercept','scout','support','strike','return','orbit']`.

**Client.**
- `Core`: `UnitWire.Fuel` / `UnitStore.Record.Fuel` (0–255, -1 unknown), decoded from `air[1]`. `CombatEvent.Altitude` / `Bursts` are decoded from `y` / `p`. New helper `ProtocolDecoder.Floats`.
- `Effects/EffectsRenderer.Air.cs` (new): `FlakBurst` and `FlakVolley`. Each shell gives a hot flash, shrapnel streaks and a ragged black puff that hangs for 5–8 s. The size scales with camera distance (1× to 3.2×) so volleys read at mid zoom.
- `App/GameBootstrap.Air.cs` (new): `PresentFlak`. It bursts around the aircraft as drawn, at the server altitude.
  - Hooked as `case "flak"` in `PresentEvents`.
  - In the action RTS, the old small `AirBurst` is skipped for AA fire at aircraft and for `airburst` impacts, so volleys are not drawn twice. The legacy ruleset is unchanged.
- `Session/Commander.Air.cs` (new): patrol input.
  - With own aircraft selected, **P** arms patrol planning. Each click drops a waypoint; **Shift-click** keeps adding, and a plain click places the last waypoint and sends.
  - Enter, P again or right-click sends what is placed. Esc cancels.
  - Waypoints and a dotted closing loop are drawn while placing, then the accepted (clamped) route for 2.5 s. An amber note appears if the route was clamped.
  - Hooks: one line in `Commander.Update` (Select case), `ModeHint`, and `DrawOverlay`.
- `Input/InputFacade.cs`: new action `air_patrol` (default P). P still pauses when no aircraft are selected; the pause line in `Hud.cs` checks `commander.PatrolKeyClaimed`.
- `UI/Hud.Air.cs` (new): a fuel row on the selection card (`AirFuelCardBar`, lowest fuel among the selected aircraft, hidden otherwise; one hook line in `Hud.Action.cs`) and `AirStatusText(id)`. `Hud.UnitFuel` (F's hover-card hook) is wired in `GameBootstrap` so the hover card shows fuel.

### Verified
- `test/action-air.test.js` (6 tests, all pass):
  - endurance values;
  - a full fuel cycle: airborne → returning → refuelling → relaunch, with fuel never reaching 0 and the patrol kept;
  - dry limping: ≤ 35 % speed, no fire, heading home;
  - patrol range clamp with its note, and the refusals;
  - flight path sizes, with no aircraft stationary for 3 or more ticks on station;
  - flak events from mobile AA (altitude and offsets) and city AA appearing only after B's perimeter upgrade (`site.defenseLevel = 2`).
- **Bench**, patrol from the HQ to the map midpoint, 300 s, 64-hex map:

  | Aircraft | Sorties (relaunches) | Lowest fuel at landing | Distance flown | Longest stationary run airborne |
  |---|---|---|---|---|
  | Fighter | 4 | 4.9 s | 1456 u | 1 tick |
  | Bomber | 3 | 6.0 s | 1069 u | 1 tick |
  | Helicopter | 2 | 5.2 s | 915 u | 1 tick |
  | Recon drone | 5 | 5.5 s | 997 u | 1 tick |

- **Station lap lengths:** fighter 22.7 u (max radius 4.75), bomber 26.8 u (5.54), helicopter 13.6 u (2.53), recon drone 14.5 u (2.58), swarm 11.5 u (1.95).
- **Clamp:** a recon drone with test fuel of 8 s gets range 13.7. The far waypoint lands at exactly 13.66 from the HQ.
- **AA:** with a helicopter patrolling over an enemy HQ with `cityAA` and a mobile AA unit for 90 s, there were 44 city-AA and 18 mobile flak volleys.
- **AI vs AI**, 64 map, seed 7, 15 min, extra income: 20 aircraft built. 41,480 airborne aircraft-ticks, of which 56 were zero-velocity (0.1 %; it was 2.4 % before laps were chained). 62 dry ticks, 651 returning, 3328 grounded. No exceptions.
- C# type-check (dotnet `check.csproj`): no errors in D's files or hooks. The only errors (3, CS0103) are in I's in-progress `Cities/CityRenderer.RoadConnections.cs`.
- `npm test`: 262 of 264 pass. The only failure is the known "action saves continue deterministic spatial simulation". `test:load` passes.

### Not verified
- Not seen in Unity: the flak look, its scale at mid zoom, the patrol overlay, and the fuel row and hover line.
- Not measured: whether fuel ranges suit E's final map sizes. The clamp rarely triggers on 1v1 maps (fighter range about 156 u), and it bites on large maps and for drones.

### For other workstreams
- **B:** city AA uses your `cityAA(site)` (`defenseLevel >= 2`) from `actionBases.js`; `site.cityAA === true`, `hq.cityAA` or a perimeter piece at `level >= 2` also count (`actionAir.cityHasAA`). The firing is done in `actionCombat.cityAntiAir`.
- **E:** endurance (`AIR_FUEL` in `actionDefinitions.js`) and `AIR` in `actionAir.js` (reserve, refuel time, dry pace, range share) are balance knobs. Patrol range scales with aircraft speed, so C's global slow-down (if it touches aircraft) shortens it.
- **F:**
  - The hover card fuel line is wired through `Hud.UnitFuel`.
  - The selection-card fuel row is the single `AirFuelCardBar()` call after the condition bar; keep it if the card is rebuilt.
  - `Hud.AirStatusText(id)` gives "Fuel 72% · Returning to base".
- **H:** P now means "patrol" while own aircraft are selected (`air_patrol` action). Please add it to the FieldGuide hotkeys: "P, then click waypoints (Shift-click for more): aircraft patrol route".
- **J / A:** the `flak` particles come from the shared particle budget (up to about 6 shells × 6–14 particles per volley).

## I. Base structure and building art

### What changed

**Bases: one round compound docked to a round HQ** (`Cities/CityRenderer.BasePresentation.cs`, `Rings.cs`, `RoadConnections.cs`; mockup layout).
- **Round foundation.** One draped concrete disc holds the whole base (radius from the actual socket corners, `FoundationRadius`), with a light kerb and a darker skirt where it meets the land. The terrain apron (`_SE_BaseGroundTex`) still blends it into the ground.
- **Round HQ hub.** `Base_town` is now a round command hub (Blender): a stepped podium, a lower drum with a window band and pilasters, an upper drum, a parapet and a glazed command cab with a mast and a dish. It reads the same from every side.
  - The plaza around it has a dark collar, a team ring and lamps. The dark ring road around it is the mockup's hub ring.
  - Team bands go round both drums (`HeadquartersTierDressing`), so ownership reads at strategic zoom.
  - Tier 2 adds four radomes and a mast beacon. Tier 3 adds a team crown on the cab, a dish and antennas. The model still stands 10% / 20% taller per tier.
- **Docking and connections.** Every open or built socket gets a docking arm: a low concrete walkway from a gate in the HQ drum to the ring road. It carries lit team chevrons pointing out to the socket, bright when the building is operational. The spur from the ring road to the pad is now a concrete causeway (wider at the pad), not asphalt, so it merges with the pad. Buildings face the hub: doors and bays are on the causeway side.
- **Rounded pads.** Sockets are rounded squares:
  - Built sockets are concrete, vehicle asphalt or generator gravel by type, with a light kerb, team arcs on the corners and a hazard threshold where the causeway arrives.
  - Open sockets have a dashed team outline, corner lamps and a build cross.
  - Locked sockets (a later tier) are faint pads showing one dot per tier they need.
  - The authored building plinths are rounded too.
- **Building identity.** A painted glyph on each causeway says what stands there:
  - barracks: two green rank chevrons;
  - materials: an amber crate;
  - energy: a yellow bolt;
  - vehicles: blue track links;
  - heavy weapons: a red crosshair;
  - airfield: a plane;
  - lab: a cyan ring;
  - armory: a violet shield;
  - silo: a red arrow.
- **Slots 3 / 5 / 7.** Socket state follows the server: it opens `capacity` sockets in (parcel tier, ring index) order, the same order as `openSlots`. The eighth parcel never opens, so it draws as plain foundation. Older servers without `capacity` fall back to the parcel tier. `ComposeCityDistrict` and the compound network accept any socket count from 3 to 12 (no more hard-coded 8). Held bases no longer draw old-town ruins on empty sockets; unclaimed compounds still do.
- **Slots never overlap roads.**
  - The client compound now covers the first **two** hex rings (`CompoundSkipRadius` 3.6, was 2.6). Every outside street therefore ends on a portal outside the foundation, where before portals sat at 2.0–2.6, right among the pads.
  - Each entrance leaves the ring road straight out through the gap between two sockets, and only bends toward its portal once it is past the foundation.
  - `InvalidateRingDistricts` now looks one ring further out, to match.
  - The inherited "street front" accessory blocks moved outside the foundation.
- **Tier walls.** Tier 3 walls use the new `Def_wall` T-wall sections with a team band. Tier 2 barrier blocks are unchanged.
- **Improvements connect to the hub.** Every positioned field structure gets a small curved gravel path to the foundation edge of its owner's nearest base within 7.5 units (`ImprovementPath`). The path skips water and passes outside the pads.

**Defenses rebuilt in Blender** (new `tools/blender/build_defenses.py`, `Cities/CityRenderer.Defenses.cs`).
- Static bodies (`Def_*.bytes` plus `Models/DefenseLayout.txt`) for:
  - sandbags (fits B's smaller .50 × .34 footprint);
  - Watchtower (braced legs, sandbagged cabin, searchlight, MG);
  - Bunker (octagonal pillbox in an earth berm, slits all round, rear trench);
  - AT emplacement (revetment ring);
  - AA battery (octagonal platform, parapet, shell racks);
  - perimeter MG turret plinth;
  - Outpost (hexagonal star fort with bastions and a blockhouse, shrunk to B's .45 radius);
  - radar/sensor post (lattice mast, cabin);
  - artillery emplacement;
  - repair point (gantry);
  - T-wall section;
  - trench-side post (for J).

  Most bodies are 150–2,100 triangles; the sandbagged revetments are the largest (AT about 3,500, artillery about 4,400).
- **Tracking turret heads** are separate meshes (`Def_at_head1-3`, `Def_aa_head1-3`, `Def_mg_head1-3`, `Def_fort_head`, `Def_artillery_head`; 150–820 triangles each). They are drawn every frame at every zoom (`AnimateTurrets`, before the close-range cut in `Animate`), so they never pop out.
  - An idle head sweeps its arc; AA scans the sky.
  - A head that fired in the last 5 s slews onto its target at its traverse rate (AA 2.6 rad/s, MG 3.2, AT 1.3, artillery 0.7).
  - Heads take a team-tinted paint.
- **AA reads as AA:** elevated twin barrels at level 1, quad at level 2 with splinter shields, plus a fire-control radar at level 3.
- **Upgrade levels are visible:**
  - one team rank bar per level on each emplacement's front plate;
  - a ring of blast blocks from level 2, which becomes a taller banded wall at level 3;
  - heavier heads: AT gets a closed shield at level 2 and twin guns at level 3, MG gets twin guns and then a shield and searchlight.
- **City AA:** an HQ whose `defenseLevel ≥ 2` gets a tracking AA mount on its drum roof (quad, plus radar at level 3). It only takes air targets, so the HQ's own ground fire does not swing it.
- The sensor post's dish now actually turns (the activity code used to look for `comms_tower` / `aa_battery`).

**Damage stages, no health bar** (new `Cities/CityRenderer.Damage.cs`; replaces the old `DamageOverlay`).
- The marks go on the faces of the building's recorded walls (authored layout walls or recipe modules), not around it:
  - **light** (below 85%): soot streaks above openings, hairline cracks, charred ground and debris;
  - **heavy** (below 60%): a missing corner (charred cavity, jagged slab, rubble spill) and more heaps, plus a smoke plume;
  - **critical** (below 35%): a collapsed section, broken charred beams, open fires and heavy smoke.
- The old "damage darkens the whole building to 60%" tint is now 96 / 90 / 82%, and the ground scorch is a draped soil decal, not black boxes.
- Smoke and fire sources are published in `CityRenderer.DamageEmitters`. `GameBootstrap` emits them next to the existing burning-building loop.

**Hexagonal territory outline** (`Cities/TerritoryField.cs`, `Terrain.shader`).
- The distance field is built from hex sides. Every side between differently owned hexes (or an owner and no one) is stamped as a segment. Inside, a texel stores the inward distance; outside, it stores the distance to the nearest owned side, in that owner's colour. The line is centred on the hex side, straight, and in team colour on both sides.
- The source is the server's per-hex owner. Older servers fall back to site claims rasterised onto hexes, with corridors.
- The shader no longer warps the lookup, so the hexagon stays clean. Strength and width are unchanged, so it stays subtle up close.

**Black roofs.** `Module` lifts every roof (`Roof`, `MetalRoof`, and thin slabs above .08) to a readable luminance floor (`RoofFloor`, about .46). Blender roof sheet `roofm` went from .44 to .60. The round HQ roofs use a light membrane (`roofl` .72), not the old .36 asphalt.

### Shared-file edits (small, exact)
- `CityRenderer.cs`:
  - `Part` enum and `CreateCell` mesh list: eleven `Def*` parts appended before `Count`;
  - `ComposeBuilding`: a defense branch after `AuthoredBase`, the softer damage tint, and clearing `DamageEmitters`;
  - `Module`: the roof floor;
  - `DamageOverlay` moved to `CityRenderer.Damage.cs`;
  - `Draw` / `Dispose`: `DrawTurrets` / `DisposeTurrets`.
- `GameBootstrap.cs` (fire loop): emits `city.DamageEmitters`.
- `GameBootstrap.Presentation.cs` (`WeaponMuzzle`): for buildings, `city.TryMuzzle` returns the barrel tip and calls `city.NoteShot`, so tracers leave the barrel and the head slews.
- `CityRenderer.Action.cs`: a base also recomposes when `Capacity` or `DefenseLevel` changes.

### Verified
- `dotnet build` of Runtime + Core + Net: **0 errors** after all edits.
- Blender 5.3 headless builds of `build_bases.py` (5 models) and `build_defenses.py` (23 models), exported to `Runtime/Resources/Models` with `BaseLayout.txt` and `DefenseLayout.txt`.
- Rendered previews (scratchpad `prev/`):
  - `bases.png`: the round HQ and the rounded plinths;
  - `def_final.png`: the defense bodies;
  - `def2.png`: the turret heads by level;
  - `def3.png`: barricade, T-wall, trench post;
  - `base_composed.png`: a tier-3 base composed in Blender the way the client lays it out, compared against the mockup.

### Not verified (needs the editor in Wave 2)
- Nothing here has been seen in Unity. In particular:
  - the paint order of the new ground layers over the terrain apron;
  - the new entrance routing with `CompoundSkipRadius` 3.6 on every map (ring-2 roads are replaced by entrances);
  - turret yaw sign and mirroring in the real camera;
  - muzzle offsets;
  - damage marks on every building type;
  - the hex outline at all zooms;
  - glyph legibility;
  - performance of the larger base compose.
- New `.bytes` / `.txt` models need Unity to import them (`.meta` files are generated on import).

### Notes for others
- **A (performance):**
  - A held base composes more ground quads (foundation, pads, arms; roughly 2–3k quads per base). The ring invalidation reaches one ring further (`ring < 4`), which couples more cells to a base; your base-cell ordering still applies.
  - Turret heads are ~11 small instance batches drawn every frame with huge bounds.
  - `TerritoryField.Rebuild` costs about one `TileAt` per texel plus a stamp per border side whenever territory changes.
- **J:**
  - `Def_trench_post.bytes` is a trench-side revetment post (pivot at the ground, about 0.13 tall) if you want it along trenches.
  - Debris and craters are untouched.
- **D:** city AA fires from the HQ building id. The HQ mount tracks it through `WeaponMuzzle`. Muzzle offsets are in `CityRenderer.TryMuzzle`.
- **B:**
  - The client assumes the server opens sockets in the `openSlots` order: parcel tier, then ring index, `capacity` of them.
  - Player-built roads through a base's foundation are still allowed by the server, and they would cross pads. Consider refusing road edges within about 2.7 of a base centre.


## E. Maps and balance

### What changed

**Maps** (`server/sim/mapCatalog.js`, `authoredMaps.js`, the authored part of `actionMap.js`)
- 10 authored maps, at least 2 per format, all within the plan's size limits. Previous: 3 maps.

  | Format | Map | Size | Notes |
  |---|---|---|---|
  | 1v1 | Twin Rivers | 76 | unchanged |
  | 1v1 | **Mirefen Gap** (new) | 84 | Two fen lakes plus feeder rivers cut the map coast to coast. Mirefen (metro) holds the dry gap in the centre; coastal bridges and upstream fords form the flanks. |
  | 2v2 | Saltmarsh Estuary | 108 | unchanged |
  | 2v2 | **Highland Fork** (new) | 100 | Rivers fall north and south from the open Fork plateau. Flanks need bridges or fords. A tarn and a mountain spur guard each southern approach. |
  | 3v3 | Continental Divide | **132** (was 140) | Same layout on a smaller map. |
  | 3v3 | **Iron Basin** (new) | 128 | Two lakes make three fronts. The centre narrows to the Iron Gate mountain pass. A river crosses each team's own ground between the north and middle seats. |
  | FFA 3 | **Three Crowns** (new) | 96 | Three realms around the Crown plateau. Each pair of realms is split by a border river with one bridge and one ford; each realm has a march town on its far side. |
  | FFA 3 | **Shattered Delta** (new) | 104 | Three rivers run from the coast into a central lagoon, one between each pair of realms. Shore towns ring the lagoon; delta towns hold the crossings. |
  | FFA 4 | **Crossroads** (new) | 104 | Four realms around the Hub. Lakes on the diagonals split the approaches into lanes. Corner towns between neighbours sit across a river from each capital. |
  | FFA 4 | **Quarry Highlands** (new) | 112 | An impassable massif fills the centre; four passes cross its shoulders. Each capital has a mill river between it and one neighbour. |

- **Free-for-all maps.** Authored maps take `symmetry: 3 | 4` (default 2, the exact half-turn).
  - The ops, sites, outposts and roads describe seat 0's sector, which faces west. They are repeated at 120° or 90° about the centre for each further seat, numbered clockwise on screen.
  - Each turned feature is sampled per hex, so seats are equal to within a hex. The 4-fold maps are also an exact half-turn.
  - FFA maps end in a round coast (3-fold) or a squircle coast (4-fold).
  - In FFA roads, `'key'` means the site in the same sector and `'~key'` the site in the next sector clockwise. `names` lists one name per extra sector.
  - FFA maps are authored in polar form with `P<size>(degrees, worldUnits)`: 0° is east, 90° is south.
  - The team-map code path is unchanged; the old maps generate as before apart from the Continental Divide resize.
  - New exports in `authoredMaps.js`: `symmetryOf`, `rotatePoint`, `rotateTile`, `pointUV`. In `actionMap.js`: `mapPreview`, `PREVIEW_SIZE`, `PREVIEW_CLASSES`.
- **Lobby listing** (`mapList()`, sent in `hello.maps`, the `maps` reply and `/api/maps`):
  - `mode` now uses the lobby's format names: `'1v1' | '2v2' | '3v3' | 'ffa3' | 'ffa4'`, the same as `matches.js` FORMATS.
  - New fields: `ffa` (boolean) and `preview`.
  - FFA maps have `players` 3 or 4 and `teamSize` 1.
  - `matches.js` needed no change: an authored FFA map gets `teamSize` 1 and `players` seats.

**Map preview grid (for K).** `preview` on every `mapList()` entry. It is generated into `server/sim/mapPreviews.js` by `node tools/map-previews.mjs`; rerun that after editing a map (a test checks it is current).

```
preview = {
  w: 64, h: 64,                 // grid size (cells)
  aspect: 1.1547,               // world width / height (sqrt3 : 1.5): draw the grid this much wider than tall
  classes: ['deep','shallow','open','forest','marsh','hills','mountains','peaks','river','ford','road','bridge'],
  cells: '<base64>',            // w*h bytes, row-major from the NORTH-WEST corner; byte = index into classes
                                // cell (col,row) covers u in [col/64,(col+1)/64) west->east, v in [row/64,(row+1)/64) north->south
                                // a cell shows bridge > road > river > ford if any of its hexes has one, else its most common terrain
  starts:   [{ seat, u, v, name }],   // seat = civ id; u,v in 0..1 (multiply by 64 for the cell)
  bases:    [{ u, v, name, kind }],   // the other city ruins (town/industrial/metro/military/coastal/research)
  outposts: [{ u, v, kind }],         // energy/supply/radar/repair/defense
}
```

- The previews add about 69 KB to `hello`. If that is too much, K can drop `preview` from `hello` and keep it in `maps`.
- **For K:** the Unity `MainMenu.cs` fallback `MapInfo` list still names only the three old maps, and it lists Continental Divide at size 140 (now 132). Please read the server list.

**Map sketches.** These come from the previews: one character per 2×4 cells. Legend: `~` sea, `.` open ground, `f` forest, `h` hills, `M`/`A` mountains/peaks, `=` river, `:` ford, `#` road, `H` bridge, digit = seat, `B` city ruin, `o` outpost.

```
Twin Rivers (twin_rivers, 76, 1v1)
~~~~~~~~-..-=---~~==------o..-~~
~~~-~~~-..o.=#####=####B......~~
~~-....B####=#hMM.==...#......~~
~~.h...##h..=.oMh..=...##..ff.~~
~~.....##h.==.hMMh.:fff##...o.~~
~~.....#.ff==..fh..=.ff.#.....~~
~~~...##...o:=....:=..B##1...~~~
~~~~..0###B.==..B.==o...##...~~~
~~~....#....=......==ff.#....~~~
~~-o...##.ff=.hMMh.==fh##.....~~
~~-f...##fff=..hMof=..h##...h.~~
~~-.....#...==.MMh#=####B.....~~
~~-.....B###==#h###=..........~~
~~-..o......==###..:.o..-~~~~~~~

Saltmarsh Estuary (saltmarsh_estuary, 108, 2v2)
~~............~~~~...foff...o.-~
~~....##o##B####~...######....-~
~~ff.0#.....,f.#o####....#3...-~
~~...#=======-~~-...##M..##...-~
~~..#:=..h..f~-~~....#Mo..#...-~
~~h:##..hh..f-~~....f##..##.hh-~
~-hh.##f.#B#####.......#B#..ho.~
~-oh..#B#.......B####B#..##.hh.~
~~hh.##..#.f..,.~~-...hhff#::h.~
~~...#..o##ff...~.~,.fhh.=##...~
~~...##..M##....~~~====:==#...-~
~~...1#....####o#~~,.....#2..f-~
~~....######....#######o##...f-~
~~.o.....o.....~~~~.B#........-~

Continental Divide (continental_divide, 132, 3v3)
~~.....o--....hAh....~~~.o....-~
~~......##B#####h.#####B###..f-~
~~..0#####....ho#####.....#5...~
~~..#....##ff.hMh..M##....##...~
~~..##o...#B#o#Mh...o#...ff##.o~
~~..##:====H......f##.#B#####..~
~~.1#.hh:.##-~~~~~~####hhh..#..~
~~.#..hhh####~~.~~~~##.=hh.#4..~
~~.#####B#.##f-~~~~.#===::.#...~
~o.##.....#o.f.hM#o#B#...o##..~~
~~..##f...##M..hMh.ff##....#...~
~~..2#.....#####oh..ff#####3...~
~~...###B#####.h#####B##.......~
~~ff..o........hAh......o......~

Mirefen Gap (mirefen_gap, 84, 1v1)
~~~~~~~-...--.--.----.--..~~~~~~
~~-.....B####o######=###....o.~~
~~-....##ff........=:...B#....~~
~~-....#fffM..o...==.ffff#....~~
~~.h..#....MM...~~=,f.hh##....~~
~~.h..0##.......~~~o...##....o~~
~~.......##..f.#####B###......~~
~~......###B####B....##.......-~
~~o....##...~~~...f....##1..h.-~
~~....##hh..o=~~~..MM....#..h.-~
~~-...#.....==..-o..M...#.....~~
~~-...#Bfff:=........ff##.....~~
~~-o....##:#......o...#B......~~
~~-.......:###########....-..~~~

Highland Fork (highland_fork, 100, 2v2)
~~....o..B####=########B..o...-~
~~....####.f..=....ff..###....-~
~~h.###....ff.=....f......#...-~
~~h.0#........=...Mh.o....#3..-~
~~...######B..::..MM..~-.##...-~
~~...f##.....o.h...oM...##....-~
~~o....##.....h########B#.....~~
~~.....#B#######Bh.....##.....o~
~~....##...Mo...h.o.f..f##.....~
~~...##....hMM..:=..B######...~~
~~..1#...~o.hM...=........#2.h.~
~~...#...........=..f....###.h.~
~~...###...fff...=..ff####.....~
~~...o.#B#############B..o....-~

Iron Basin (iron_basin, 128, 3v3)
~~.....o..........ff..h..o.....~
~~...####B#####o######B####...-~
~~.0##.............M##....##5.-~
~~##....ff..f.~~-..hM##....#..-~
~~o#====:ff...~h~~~...##fff##o.~
~~.#....::...h.M....o..B####...~
~~.1#####B###o###..........##..~
~~.##..........#B#o###B#####4..~
~~..####B..o....M.h...::....#..~
~~o##...##....~~h~.....:====#o~~
~~..#.f..##Mh-~~~~~...fff...##-~
~~.2##....##M....-........##3.-~
~~...####B######o#####B####...-~
~~....o..h..ffff........o.....-~

Three Crowns (three_crowns, 96, FFA 3)
~~~~~~~~~~=~~--...-o~~~~~~~~~~~~
~~~~~~~~~-==..##o.ffhhh~~~~~~~~~
~~~~~~~~...#########1hh.o~~~~~~~
~~~~~~~~.B##==.MM..##.....~~~~~~
~~~~~o...##.o=.....##ff...-~~~~~
~~~~-.....#B#::hh##B####B..~~~~~
~~~~hh.0####.o###o::=o.##...~~~~
~~~~hhh##....hh#Bh...===#====~~~
~~~~.of.#.MM..::oh..hMM##...~~~~
~~~~~.fo#MM.===.B##...##o...~~~~
~~~~~-...##=#o.##..#.##....~~~~~
~~~~~~-...==#B##.ff.2#hof.~~~~~~
~~~~~~~~.==.......f.hhh.-~~~~~~~
~~~~~~~~~~.......o.....~~~~~~~~~

Shattered Delta (shattered_delta, 104, FFA 3)
~~~~~~~~~~~~~......~h~~~~~~~~~~~
~~~~~~~~~.........ohhhh~~~~~~~~~
~~~~~~~...:=:...ff.#1hh..~~~~~~~
~~~~~~......==..oh.#..f.o.-~~~~~
~~~~~o....B#o=####B##ff....-~~~~
~~~~...fff#.o.=....o##B.....~~~~
~~~~hh...##B...~~~===o#..::.-~~~
~~~~hhh0####..~~~~==##=:::...~~~
~~~~ho....o##.=~~~.##o......-~~~
~~~~~...ff..=#=o.#B#h.ff....~~~~
~~~~~......:=#o######.ff...-~~~~
~~~~~~.....:..B#ff..2hho..-~~~~~
~~~~~~~-...:.....ff.hhh..~~~~~~~
~~~~~~~~~~.......o..h..~~~~~~~~~

Crossroads (crossroads, 104, FFA 4)
~~~~~~~~~.....hhhh.o...-~~~~~~~~
~~~~~-......o##1##:........~~~~~
~~~~~....#######..H:###.....~~~~
~~~~....#B.fof##...=..B#....-~~~
~~~~.o.#:=o=..B#...=.oo##o..-~~~
~~~~..#:=:..~~.#o.~~~.ff#....~~~
~~~~hh##.....o..####B###2.hh.~~~
~~~~hh#0###B####B.o.....##hh.~~~
~~~~hh##ff.....o#..-..:=##.h.~~~
~~~~..o##of~=~..#B~~===.#.o..~~~
~~~~....#Bo.:...##.o.oB#....-~~~
~~~~.....###=:###.f####.....~~~~
~~~~~.......::.h3##o.......-~~~~
~~~~~~......o.hhhh........-~~~~~

Quarry Highlands (quarry_highlands, 112, FFA 4)
~~~~~~~~-.~=.ohhhh.o....-~~~~~~~
~~~~~-....-==...1..........~~~~~
~~~~-........==###ffo.......~~~~
~~~~.......o..#:.#B.........~~~~
~~~~....o..#B#..o..B..o..==~~~~~
~~~~.offfB##.hhhhhh##f====o.-~~~
~~~~hh.0##.ohhMAAMhh#####.hh.~~~
~~~~hh.##=##hhMAAMhho.##2.hh.~~~
~~~~.o====.##hhhhhh..#Bff.o..~~~
~~~~.==..offB#.o..#B#..of...-~~~
~~~~~~.......B#.:=.fo.......-~~~
~~~~.......o.f###==.........~~~~
~~~~.........f.3...==.......~~~~
~~~~~~......o.hhhho.=~~...-~~~~~
```

**Balance** (`server/sim/actionDefinitions.js`)
- Unit prices (materials / energy), old → new:

  | Unit | Old | New | Change |
  |---|---|---|---|
  | rifle_squad | 90 / 0 | **70 / 0** | −22% |
  | militia | 70 / 0 | **48 / 0** | −31% (mirror: was clearly worse than rifles at equal cost) |
  | anti_armor | 125 / 35 | **100 / 25** | −22% |
  | mortar_team | 145 / 40 | **120 / 30** | −19% |
  | special_forces | 210 / 85 | **140 / 50**, HP ×1.4 | −35% |
  | exo_infantry | 335 / 180 | **260 / 135** | −23% |
  | scout_buggy | 120 / 15 | **85 / 10** | −29% |
  | armored_car | 180 / 50 | **125 / 30** | −32% (worst value ratio in AI play) |
  | supply_truck | 175 / 45 | **140 / 35** | −21% |
  | field_gun | 220 / 80 | **170 / 60** | −24% |
  | mech_infantry | 255 / 90 | **195 / 65** | −24% |
  | tank | 300 / 110 | **235 / 80** | −22% |
  | sp_artillery | 315 / 150 | **250 / 115** | −22% |
  | air_defense | 230 / 125 | **180 / 95** | −23% |
  | missile_battery | 390 / 240 | **310 / 185** | −21% |
  | autonomous_tank | 500 / 240 | **340 / 150**, HP 420 | −32% |
  | helicopter (D) | 350 / 165 | **280 / 130** | −21% |
  | fighter (D) | 395 / 200 | **315 / 160** | −20% |
  | recon_drone (D) | 145 / 85 | **115 / 65** | −21% |
  | bomber (D) | 590 / 315 | **470 / 250** | −20% |
  | oneway_drone (D) | 155 / 105 | **125 / 80** | −20% |
  | strike_swarm (D) | 420 / 265 | **335 / 210** | −20% |

  Air prices were cut by the same ~20% so they keep their place relative to ground units. Only the price arguments changed.
- **Income.**
  - Headquarters base income: 80 → **140** materials/min, and 8 → **12** energy/min.
  - Materials Relay outpost: 45 → **90** materials/min. Abandoned Energy Plant outpost: 18 → **30** energy/min. This makes expansion pay.
  - Depot and power plant rates (B's) are unchanged.
  - At minute 12 the AI now holds about 520 materials, rising to about 870 by minute 18 and 1,630 by minute 24. That leaves room for B's building levels, perimeter upgrades and the 1000-material new base; energy stays tight at 100–200.
- **Rifle squad size, agreed with B and J: 8 men × 14 HP = 112 HP.** Firepower scales with the men still standing. Other squads: militia 6, special forces 5, exo 4, anti-armor 3, mortar 3. These are B's `SQUAD_MEN` numbers; E's prices assume them.
- **Small fix outside E's files** (`actionAI.js` `buildArmy`): the AI crashed (`lerpPoint` of `undefined`) when a civ with no base had an operation target. This killed about 1 in 4 long sims. The fix guards `bases[0]`.

**Tools** (new)
- `tools/action-balance.mjs [maps] [seeds] [minutes] [--workers=N] [--out=file]`: AI-only matches on authored maps in parallel workers. It produces the tables below.
- `tools/action-mirror.mjs [budget] [seconds] [arenas]`: equal-cost duels on flattened ground. Set `PAIRS='a|b;c,d|e'` to run custom pairs.
- `tools/map-previews.mjs [--ascii] [ids]`: regenerates the previews, or prints them as text.

### Verified

- `npm test`: 264 tests, 261 pass. The two failures:
  - "action saves continue deterministic spatial simulation": the known failure.
  - "server hosts a match end-to-end…": a timeout under load that passes alone (8.6 s).
- `test/action-maps.test.js` is extended, and all 12 tests pass. Every map is checked for:
  - deterministic generation, connectivity and a playable 600-tick run;
  - half-turn symmetry on team maps;
  - on FFA maps, each seat's heavy-vehicle route lengths to its rivals equal within 8%;
  - an up-to-date stored preview;
  - mode/ffa listing, size ranges, and at least 2 maps per format;
  - FFA match creation.
- **Rules tested against:** the working tree after B, C and D reported done (C: 30% slower ground units, slowest-member groups and attack-move; B: auto engineers, 3/5/7 slots, per-tick income, 8-man squads; D: fuel). File md5 prefixes at sim time: actionDefinitions 2cd48986, actionBases 6169b89a, actionCombat 8ffb3d7f, actionNavigation 70b670f0, actionOrders 32c9362b, actionAI 0be5c596, actionAir cc181df4, actionUpgrades 29c506ae.
- Sims ran 3 seeds × 10 maps, 30 minutes each, normal AI, with personalities rotating per seat.

**AI-vs-AI results (final rules).** Units are per living player. "Kills" are unit kills per player at the end.

| Map | Seeds | First contact (mean) | First kill | 5th kill (first battle) | Units/player @3 @6 @9 @12 @18 @24 | Army value/player @12 | Kills/player (end) | Match length | Ended | Craters @end | Field works @end |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Twin Rivers | 3 | 4:39 | 5:02 | 6:30 | 13 / 19 / 34 / 53 / 59 / 77 | 5149 | 163 | 27:18 | 1/3 | 67 | 8 |
| Saltmarsh Estuary | 3 | 6:14 | 7:06 | 10:13 | 15 / 16 / 24 / 41 / 66 / 74 | 4020 | 105 | 30:00 | 0/3 | 152 | 8 |
| Continental Divide | 3 | 9:45 | 9:46 | 12:40 | 14 / 16 / 23 / 40 / 66 / 78 | 3904 | 69 | 30:00 | 0/3 | 181 | 8 |
| Mirefen Gap | 3 | 5:09 | 5:22 | 6:30 | 14 / 17 / 30 / 47 / 76 / 74 | 4525 | 91 | 25:41 | 2/3 | 76 | 5 |
| Highland Fork | 3 | 8:07 | 8:34 | 9:06 | 14 / 18 / 25 / 46 / 62 / 70 | 4524 | 110 | 30:00 | 0/3 | 165 | 19 |
| Iron Basin | 3 | 5:28 | 7:06 | 11:24 | 14 / 16 / 22 / 39 / 59 / 69 | 3817 | 76 | 30:00 | 0/3 | 167 | 6 |
| Three Crowns | 3 | 2:54 | 3:48 | 6:05 | 14 / 18 / 26 / 34 / 52 / 52 | 3546 | 199 | 30:00 | 0/3 | 158 | 13 |
| Shattered Delta | 3 | 2:41 | 4:23 | 5:33 | 14 / 17 / 24 / 34 / 48 / 47 | 3390 | 175 | 30:00 | 0/3 | 132 | 10 |
| Crossroads | 3 | 3:44 | 5:03 | 6:18 | 14 / 17 / 28 / 43 / 54 / 55 | 4128 | 169 | 30:00 | 0/3 | 201 | 13 |
| Quarry Highlands | 3 | 3:50 | 4:02 | 5:30 | 14 / 18 / 25 / 35 / 58 / 68 | 3466 | 117 | 30:00 | 0/3 | 161 | 11 |

For comparison, the baseline before E's price and income pass (same tree, mid-B/C), units per player at 3 / 6 / 9 / 12 / 18 / 24 minutes:
- Twin Rivers 13 / 17 / 23 / 28 / 39 / 53
- Saltmarsh 13 / 16 / 21 / 33 / 50 / 48
- Continental Divide 13 / 15 / 21 / 30 / 51 / 67
- Crossroads 13 / 17 / 24 / 34 / 46 / 57

At minute 12 the baseline averaged about 29 units per player; it is now about 41. Army value at minute 12 rose from about 3,200 to about 4,050.

**Unit-type results in AI play** (all 30 sims):

| Unit type | Built | Lost | Kills | Kills per loss | Value killed / value lost |
|---|---|---|---|---|---|
| rifle_squad | 9685 | 6262 | 7411 | 1.18 | 1.80 |
| anti_armor | 3132 | 2281 | 2075 | 0.91 | 0.91 |
| mortar_team | 2508 | 1527 | 2114 | 1.38 | 0.94 |
| engineer | 2055 | 1087 | 17 | 0.02 | 0.01 |
| scout_buggy | 1232 | 1100 | 28 | 0.03 | 0.03 |
| armored_car | 1154 | 643 | 313 | 0.49 | 0.32 |
| tank | 850 | 486 | 984 | 2.02 | 0.80 |
| mech_infantry | 252 | 141 | 169 | 1.20 | 0.56 |
| sp_artillery | 34 | 9 | 79 | 8.78 | 2.81 |
| helicopter | 26 | 0 | 52 | - | - |
| air_defense | 5 | 0 | 0 | - | - |
| structure:? | 0 | 0 | 77 | - | - |
| structure:town | 0 | 0 | 200 | - | - |
| structure:guard_post | 0 | 0 | 5 | - | - |
| structure:city_turret | 0 | 0 | 12 | - | - |

**Mirror tests** (`tools/action-mirror.mjs 1800 120 3`): equal 1,800-value forces attack-move through each other on flat ground. The figure is the share of starting HP kept, averaged over 3 arenas.

| A | B | count A : B | kept A : B (share of starting HP, mean of 3 arenas) | verdict |
|---|---|---|---|---|
| rifle_squad | rifle_squad | 26 : 26 | 0.04 : 0.01 | even |
| rifle_squad | militia | 26 : 38 | 0.05 : 0.11 | even |
| rifle_squad | anti_armor | 26 : 14 | 0.89 : 0.00 | A wins |
| rifle_squad | mortar_team | 26 : 12 | 0.13 : 0.04 | even |
| rifle_squad | scout_buggy | 26 : 19 | 0.97 : 0.00 | A wins |
| rifle_squad | armored_car | 26 : 12 | 0.00 : 0.58 | B wins |
| anti_armor | tank | 14 : 6 | 0.59 : 0.00 | A wins |
| anti_armor | armored_car | 14 : 12 | 0.58 : 0.00 | A wins |
| tank | mech_infantry | 6 : 7 | 0.58 : 0.00 | A wins |
| tank | field_gun | 6 : 8 | 0.71 : 0.00 | A wins |
| tank | tank | 6 : 6 | 0.19 : 0.16 | even |
| armored_car | mech_infantry | 12 : 7 | 0.00 : 0.68 | B wins |
| special_forces | rifle_squad | 9 : 26 | 0.00 : 0.56 | B wins |
| exo_infantry | tank | 5 : 6 | 0.00 : 0.47 | B wins |
| autonomous_tank | tank | 4 : 6 | 0.46 : 0.00 | A wins |
| 2xrifle_squad+anti_armor+mortar_team | tank+2xrifle_squad | 16 : 12 | 0.13 : 0.07 | even |
| 3xrifle_squad | rifle_squad+anti_armor+mortar_team | 27 : 15 | 0.34 : 0.00 | A wins |

- Rifle mirrors, rifle vs militia, rifle vs mortar, and the two mixed combined-arms forces all trade evenly.
- The expected counters win clearly: AT beats tanks and cars, cars beat open infantry, tanks beat mech infantry.

### Against the targets

- **First contact, 3–6 min.**
  - Met on the 1v1 maps (4:39 and 5:09) and on Iron Basin (5:28).
  - Earlier on the FFA maps (2:41–3:50 for the first shot). Neighbours are close and scouts trade fire, but the first real battle (5th kill) comes at 5:30–6:18.
  - Later on Saltmarsh (6:14), Highland Fork (8:07) and Continental Divide (9:45). Those are wide team maps where the AI expands before it attacks.
- **Army 40–80 per player by minute 12.**
  - Met on 7 of 10 maps (39–53; Iron Basin is borderline at 39).
  - Three FFA maps sit at 34–35 (Crossroads reaches 43), because FFA players fight from minute 3.
  - Every map reaches 48–78 by minute 18–24.
- **Matches 18–30 min.** Only 3 of 30 sims ended inside 30 minutes (1v1 maps, 18–29 min). The other 27 ran to the cap.
  - The AI wins the field, sometimes 120 units against 0, but rarely destroys the last headquarters. On the larger maps it does not finish its opponents.
  - This is an AI or victory-rule problem (finishing assaults on headquarters, or the recovery rule), not a price problem. It needs B or the lead.
- **No-man's-land.** Every map ends with 67–201 craters and 5–19 field works. They concentrate on the central objectives and crossings.

### Not verified / risks

- **Air.** Air units barely appear in AI sims (26 helicopters, 0 fighters or bombers across 30 matches), so the air prices are unproven. The helicopters that were built went 52 kills to 0 losses, which may make them too strong. D should check.
- **Weak units.**
  - Special forces still lose the open-ground mirror at the new price. Their value is infiltration, which the mirror does not model.
  - Field guns lose to tanks at equal cost. They may never deploy under attack-move, because of setup time or stances.
  - armored_car still has the worst value-for-value in AI play (0.32), even after the cut.
- **AI play.** The AI never builds field guns, special forces, exo, fighters or bombers, so those prices rest on mirror tests only.
- **FFA balance.** Seat fairness on FFA maps is per hex, not exact. Route lengths between seats match within 8%; ring layouts are turned copies, re-planned where a turned parcel would not fit.
- **Untested in the client.** No Unity check of the new maps (lighting, the round FFA coastlines). Nothing in K's lobby has been drawn from the preview yet.

### For others

- **K:** the preview format is above. Map `mode` uses your format tokens (`ffa3`, `ffa4`). Remove or replace the hardcoded 3-map list in `MainMenu.cs`.
- **B and J:** rifle squad is 8 men × 14 HP, as above. Please tell E if that number changes, because the prices assume it.
- **B / lead:** matches rarely end. The AI needs to finish headquarters (see the targets above).
- **D:** air prices were cut by about 20%. Helicopters look strong in the little data there is.

### Wave 2

The full 10-map × 3-seed rerun after the Wave 2 server fixes is in **W2-S → "E metrics, Wave 2"** below: 25 of 30 matches now end within 30 minutes (was 3), with a median of 21:25. It also has the updated unit-type and mirror tables.

## A. Performance, LOD, fog of war, camera rendering

**Measured** (Unity editor play mode, Game view 1920×1080, vsync off, RX 7600 XT; local server; combat sandbox `stronghold`: 36 + 36 units, developed bases; frame time = GameBootstrap's own frame ring over ~5 s per zoom, GPU from FrameTimingManager). Baseline and final ran on different random sandbox maps (same scenario), so read the numbers as orders of magnitude.

| Zoom (rts.Distance) | Baseline FPS (1 % low) | Final FPS (1 % low), telephoto | Final GPU ms |
|---|---|---|---|
| close (3–6) | 15.9 (9.7) | 114 (62) | 6.5 |
| 14 | 16.0 (10.4) | 96 (45) | 6.6 |
| **mid (40)** | **16.4 (9.8)** | **113 (51)** | 5.6 |
| 70 | 16.6 (11.5) | 123 (49) | 5.0 |
| 120 | 15.8 (8.7) | 157 (59) | 4.3 |
| strategic (220) | 16.6 (15.0) | 141 (58) | 4.3 |

AI match (104×104 map, fog of war on, shroud active): 175–197 FPS at every zoom; the shroud march is not a measurable cost.

**Top costs found**
1. **City composition livelock, ~50 ms every frame at every zoom** (the whole baseline). `InvalidateRingDistricts` re-dirties a base cell while any neighbouring cell is dirty; `CityRenderer.Update` composed the nearest (the base, 50–190 ms) first, blew the 5 ms budget, and never reached the neighbours, so the base was recomposed every frame forever. Two neighbouring bases did the same to each other. Side effect: each compose bumps `RoadCurve.LaneRevision`, which made `WarzoneRenderer.Update` rebuild every frame (another ~6 ms).
2. **Base compound composition is very expensive** (not fixed, not mine): `ComposeCityDistrict` per base cell 16–172 ms; inside it `DrawCompoundRoadNetwork` 20–34 ms and `ComposeBasePresentation` ~23 ms per held site (editor Mono timings). Every shell landing in a base cell recomposes it. **For I:** cache the road network/presentation per site until its parcels/tier/owner change.
3. GPU: 2.5–5.5 M triangles at close/mid zoom (trees and base models); shadows ~100–200 casters. GPU is 4–7 ms on this card, no longer the limit.

**Changed**
- `Cities/CityRenderer.cs` (scheduling only): base cells are composed after plain cells; dirty base cells are composed together in one frame (no mutual livelock); base cells recompose at most once per `BaseRecomposeSeconds` (1.25 s) and stay dirty meanwhile, so a battle at a base is not a stream of 100 ms frames.
- **Telephoto perspective camera** (`Camera/RtsCamera.cs` projection part, new `Rendering/ViewLod.cs`): the match camera is perspective with a narrow FOV, 30° fully zoomed in to 14° at strategic zoom, placed further back so it frames the same ground as the old orthographic zoom (`eye = Distance·0.36 / tan(fov/2)`). `RtsCamera.Telephoto` (set in `GameBootstrap.OnWelcomed` for the action RTS, cleared in `ShowMenu`), `TelephotoFovNear/Far`. Far/near clip follow the real eye.
  - `ViewLod` publishes the *logical* eye (where the old camera stood) and the eye offset (`_SE_EyeOffset` shader global). LOD, wrap-image choice (`WrapImages.Begin`, units' `camX`), terrain LOD bands, `RtsCamera.MapPosition`, linear fog, haze, terrain/water detail fades (`SE_ViewDistance` in `SECommon.hlsl`) and ground overlay/decal depth bias all use it, so every detail band sits where it did.
  - URP shadow distance follows the eye (`Atmosphere.FollowShadowDistance`: quality base + eye offset; the base is restored on exit so `SE_URP.asset` is not left changed).
  - The low cumulus layer is off for the telephoto camera (it looks down from above it) (`Shroud.cs`).
- **Zoom-in cap:** `RtsCamera.MinDistance` 0.16 → 1.6.
- **Nothing disappears when zoomed out:** trees beyond `TreeDistance` now always draw as single-crown specks instead of vanishing (`TerrainRenderer.Draw`); unit badges take over at 52 instead of 75 (`UnitRenderer.StrategicDistance`), because between those zooms true-scale vehicles and squads were 2–4 px and read as gone.
- **Fog of war:** explored-but-unseen ground is now clearly darker (`FogField.UnseenDim` 0.35 → 0.62). The client also remembers which hexes it has seen this match and, in the action RTS, builds the shroud's explored channel from that (robust if the server ever sends the whole landscape as known).
- **Terrain shader** (`Terrain.shader`): the four close-up hex-tiled photo reads (12 samples) run only where the near detail shows (dynamic branch, gradients taken outside); far soil uses the earth photo's mean colour instead of a near-black constant, and crater cores are charred soil (0.06) at 55 % instead of 0.028 at 75 %: churned ground and craters no longer read as black blobs at mid/far zoom.
- **Birds freeze while paused** (`GameBootstrap` passes dt 0 to `Wildlife.Update` when `session.Paused`).

**Verified**
- Unity compile with 0 errors (whole project) and dotnet type-check; shaders compile (`ShaderUtil`, only the pre-existing warnings).
- FPS table above; telephoto view, crater field and strategic view inspected in screenshots; fog of war in an AI match (cloud bank over undiscovered land, dimmed explored land); birds' positions unchanged over 700 frames while paused; `SE_URP.asset` shadow distance back at 130 after play mode.

**Not verified / open**
- Not measured in a standalone player or on Rowen's machine; editor numbers include editor overhead (Mono, not IL2CPP).
- The "whole map visible" report could not be reproduced: in a fresh AI match the server sends only explored terrain and the cloud bank works. The likely cause was the weak dimming of explored-but-unseen land (fixed). The sandbox reveals the whole map by design (`sandboxReveal`). Server-side LOS for every unit/building/base is present in `refreshVisibility` (with C).
- **Black roofs** (I): the authored base models (`Base_town`, `Base_motor_works`, `Base_power_plant`, …) carry baked vertex AO of ~0.07 on 30–90 upward faces each, so whole roofs render black. Likely self-occlusion in `tools/blender/se_meshkit.py` `occlusion()` (coplanar roof decks/wall tops). Needs a re-bake, not a shader change.
- **Debris/scorch** (J): scorch discs under wrecks were near-black flat discs; J has already raised their colour in `WarzoneRenderer` (not re-checked after their change).
- Shroud half-resolution was not needed (no measurable cost).
- Telephoto FOV/zoom-cap values are first guesses for review; the GroundOverlay/Decal bias for the telephoto camera is approximate (no z-fighting seen at 40 or 150).

**For others**
- `RtsCamera.Telephoto`, `TelephotoFovNear/Far`, `MinDistance = 1.6`; H owns the input part of `RtsCamera`.
- Anything choosing detail by "distance from the camera" should use `SE.Runtime.Rendering.ViewLod.EyeOr(cam)` (C#) or `SE_ViewDistance(positionWS)` (HLSL), not the real camera position.

## W2-C. Wave 2 client integration, visual and performance review (partial: editor hung)

**Status: stopped partway.** The integration compile, the base-compose cache, the bake fix and the text updates are done. The in-editor review (task 4) and the performance sweep (task 5) were not finished. A diagnostic `execute_code` call of mine (Newtonsoft-serialising an `InstanceData`; `float4` swizzle properties recurse without end) hung the Unity main thread. Killing and relaunching the editor was refused by the permission system, so the editor needs a manual restart before Wave 2 can continue.

**Found**
- **Integration:** the whole project compiled in Unity with 0 errors before my changes (only the warnings CS0219 `Thick` and CS0414 `shownRecovery`/`shownHeld`). The dock delegates (F and G) fall back correctly. The only Unity error was a USS one: `Unknown pseudo class "first-child"` in `SE.Menu.uss`.
- **Black HQ / roofs: the bake is not the cause.** I parsed the exported `.bytes`. Roof keys (`roofl` .72, `roofm` .60) bake at ≥ .23. The "~0.07 upward faces" A reported are genuinely dark palette parts: RUBBER tyres at y = .07 in the depot, ARMOR grilles and fittings on the HQ roof. In play mode (sandbox, 1080p) the round `Base_town` still renders **almost black** as a whole: deck, drums and podium. The Unity mesh loads with the right vertex count, and the InstancedLit math (albedo = instance colour × vertex colour) cannot produce black from these colours. So something in the instance colour, the material or the draw is wrong. The editor hung during this inspection, so the cause is **not found yet**. Screenshot: `scratchpad/w2c/hq_close_before.png`.
- **HQ team bands:** `HeadquartersTierDressing` draws the bands as full `Cylinder` discs (Ø 1.018 at .19, Ø .756 at .238). In-game they show as large flat blue discs across the drum top instead of thin bands. This may be the same scale/black problem; check it once the HQ renders lit.
- **First look** (`scratchpad/w2c/sandbox_first.png`, `base_own_d8.png`):
  - matches the mockup: no top bar, clock, floating pause/speed/menu, console with era hexagon, resource bars and idle button, Build and Terrain dock, round foundation, 3 open pads (dashed team outline and cross) and 4 locked pads with tier dots, docking arms with chevrons, enemy role glyphs and rings;
  - the minimap draws the square map small inside the circle (it is diagonal-fitted, with dark corners).

**Changed**
- **Base compose cache** (`Cities/CityRenderer.BaseCache.cs`, new; hooks in `Rings.cs` `ComposeCityDistrict`, `Put`/`PutRot`, `GroundLayers.Tap`/`Replay` in `Streets.cs`, cleared on world epoch):
  - What is recorded per site: everything the compound emits (instances, draped ground quads per layer, flags, bounds), covering the ring road, causeways, entrances, foundation, pads, docking arms, glyphs, socket walls and accessories.
  - The key is a 64-bit signature of what the compose reads: site owner/tier/capacity/defenseLevel/memory/HQ/maturity, parcels, slot occupants (type, done), nearby positioned buildings, explored hexes in the 9×11 window, `world.RoadRevision`, epoch and team colour.
  - On a hit the record is replayed, and `RoadCurve.LaneRevision` is **not** bumped, so `WarzoneRenderer` no longer rebuilds after every base recompose. Shells, damage bands and units in the cell now replay instead of recomposing.
  - Craters under the foundation are intentionally not in the key.
  - Counters: `CityRenderer.BaseComposeBuilt` / `BaseComposeReplayed`.
  - **Not measured in the editor yet** (target < 8 ms per base recompose).
- **Bake** (`tools/blender/se_meshkit.py` `export`):
  - cosine-weighted hemisphere rays turned onto the normal (was uniform random, flipped);
  - hits closer than `max(.004, .06 × radius)` are ignored (coincident or touching parts);
  - sky-facing faces have their AO capped (`n.z > .5` → ≤ .30 + (1 − n.z) × .5).
  - Re-exported `build_bases.py` (5 models) and `build_defenses.py` (23 models) with Blender 5.3. Upward-face mean luminance rose 10–15 % (town .47 → .52, motor works .36 → .45, depot .33 → .40). Remaining dark verts are tyres and grilles. Soldiers and vehicles were not re-exported.
- **UI hygiene:**
  - `SE.Menu.uss`: `:first-child` (unsupported) replaced by `.se-menu-action--lead` on the footer Back button.
  - `.se-resbar` gets `:active`/`:focus` resets (Unity's default pressed style leaked when a resource bar was clicked).
  - In-game buttons are now `focusable = false`: `Hud.B`, console idle/production/zoom, dock Build/Terrain, resource bars, and the selection-panel Attack move and Stance. Before, a clicked button kept keyboard focus and fired again on Space (jump to alert) or Enter.
- **Stale text:**
  - `FieldGuide` action topics: nine-segment wheels with the centre circle and digits 1–9; base wheel 3/5/7 sites, perimeter and auto engineers; Alt+click batch production; resource bars at the minimap; the idle button; a new "Aircraft and patrols" topic (P, Shift+click, Enter/P/right-click, fuel); "Build and Terrain" replaces the defense-bar topic; Z for the minimap local view.
  - The unused "Show defense bar hotkey labels" setting is removed (`SettingsView`, `GameSettings.DefenseBarHotkeyLabels`).
  - The "field construction" tooltip no longer says Q / E.
  - `MainMenu` fallback map list now has all 10 catalog maps with the current sizes (Continental Divide 132). The live list still comes from `/api/maps`.

**Verified:** dotnet type-check (Runtime/Core/Net) 0 errors after all changes; Blender exports exit 0. **Not verified in Unity:** every change above, since the editor hung before they compiled there.

**Remaining (for whoever resumes)**
1. Restart Unity. **Do not save** anything from the hung session: the scene is in play mode. Then check `read_console` for compile errors after the import of the re-exported models.
2. Find the black authored-base render. Read the `Part.BaseTown` batch's instance colours and material (read `InstanceData.Color` fields directly; don't JSON-serialise it), then fix the HQ band discs.
3. Measure base recompose with the cache (`BaseComposeBuilt` / `Replayed`, `ComposeCityDistrict` timings) in a battle at a base.
4. Task 4 visual review (wheels, markers, cursor, defenses and turret yaw, damage stages, soldiers, trenches, flak, fog, menus at 1080p and 720p) and task 5 perf sweep: not done.
5. The editor's PlayerPrefs `se.server` was restored in the registry to `wss://game.liamhosfeld.com/ws`. The hung process still holds the local URL in memory, so re-check after the restart. A Game view size "W2C 720p" (1280×720) was added.

## W2-S. Wave 2 server fixes: closing out matches, air balance, field guns, road foundations

Files: `server/sim/actionAI.js`, `actionGame.js` (victory), `actionDefinitions.js`, `actionCombat.js`, `actionOrders.js` (one halt block), `actionBases.js` and `actionEngineers.js` (repair rate), `actionEconomy.js` (roads). New test: `test/action-wave2.test.js` (6 tests). `server/sim/weapons.js` (shared with the legacy ruleset) is unchanged.

### What changed
- **The AI closes out games** (`actionAI.js`).
  - **Field superiority.** The AI remembers the strongest enemy force it has seen recently (`p.enemyPeak`, half-life about 3.5 min). It is "closing" once either:
    - from minute 12, it has 24 or more units and 1.8× that force; or
    - from minute 16, it has 30 or more units.
  - **While closing**, it stops expanding and interrupts lesser operations. It goes into **Final Assault** on the weakest known enemy headquarters:
    - ranked by distance, plus the visible garrison, plus a penalty per other base that rival still has, so it finishes the player closest to elimination;
    - the current target gets a 12-unit stickiness bonus, so the AI no longer dithers between targets.

    A Final Assault is abandoned only after 5 failures or 150 s without progress (was 3 and 85 s), or when the attack is outmatched and withdraws (unchanged).
  - **Presumed capitals.** A rival's capital that was never scouted is presumed to be held by that rival, since start positions are public, and is a valid target. Before this, an AI with no intel expanded forever.
  - **Hunt.** With no known enemy base, a closing AI sweeps base sites it has not seen for 2.5 min, nearest to its army first. Allied sites are skipped. This replaces the old "probe toward the map centre", which expansion always pre-empted.
  - **Forward rally.** When the lead unit is within 12 of the objective, the column closes up at a rally point about 7 short of it: 60% of the group, or a 50 s limit. Then it assaults together. Before this, sieges stalled with 5–13 of 50+ troops at the objective and the rest strung out along the route.
  - **Reinforcements** move to 3.5 short of the objective. Before, they went to 83% of the way from home and often idled outside the fight.
- **Victory and headquarters durability.**
  - **Decisive domination** (`DOMINANCE` in `actionDefinitions.js`; `ActionGame.dominanceStep`; default `domination` scenario only):
    - From minute 18, a team wins if, for 90 s without a break, it holds at least 65% of the operational headquarters and fields at least 2.5× the army value of all its rivals combined.
    - When the countdown starts, every player gets a critical notice: the leader "hold 90 s", the others "retake headquarters or rebuild your army". Another notice goes out if the countdown breaks.
    - The win reason is `'Decisive Domination'`. Elimination is unchanged and still reports `'Military Domination'`.
  - **Repairs under fire.** A structure hit within the last 5 s repairs at 30% from the HQ repair project, and at 40% from engineer repairs. A besieged headquarters can no longer out-heal a siege: in Wave 1 one HQ went from 19% back to 96% under siege. Structures now record `hitAt` (units already did).
  - HQ HP is unchanged at 1450. Measured sieges showed the stall came from the AI's behaviour, not from HQ durability: 30 rifle squads can raze an HQ in about 15 s.
- **Air balance.**
  - **The cause of 52 kills and 0 losses:** nothing except dedicated AA could shoot a helicopter, and the AI almost never built AA. Helicopter damage was not the problem: rockets miss moving targets, so helicopters deal little damage in mirror tests.
  - **Small arms against low-flying aircraft** (action ruleset only: `SMALL_ARMS_VS_LOWAIR` in `actionCombat.js`):
    - carbine .1, rifle .12, assault rifles .15, MG .3, light MG .2 against helicopters and drones;
    - fighters and bombers (high altitude) stay immune;
    - MG bunkers and HQs now also fire at helicopters.
    - Duel: 4 helicopters against 26 rifle squads (equal cost) now trade evenly. Helicopters kept 0.06 of their HP and the rifles 0.28; before, the helicopters lost nothing.
  - **AI air mix** (`airChoice`, exported):
    - air is capped at about 18% of the army (minimum 2);
    - fighters come first while enemy air has been seen recently;
    - otherwise the target mix is helicopters 2 : fighters 1 (: bombers 1 from era III), plus one recon drone once the army reaches 20.
    - The old fallback that put only helicopters on every airfield is gone.
  - **AI AA response.**
    - Enemy air is remembered for about 2.3 min (`p.enemyAir`).
    - The AI wants one AA vehicle per two enemy aircraft, up to 6.
    - Seen enemy air moves the Heavy Weapons Facility ahead of the airfield in the build order.
    - The city-AA perimeter upgrade becomes urgent: it needs a 120 Materials reserve instead of 500.
    - The second base now builds its airfield (or, against enemy air, the Heavy Weapons Facility) fourth instead of sixth or seventh.
- **Field guns and attack-move** (`actionOrders.js` `unitMotion`, `actionDefinitions.js`).
  - **Cause:**
    - an attack-move turns a unit aside to engage (`tacticalResume`), and the halt-to-fire check skipped such units, so guns kept driving and their setup timer reset every tick;
    - the halt also used `range` while targeting used `range + .45`;
    - a gun packed up as soon as its target died, or was hidden by battlefield smoke;
    - a 3 s setup let tanks (speed 1.1) close the whole 2.3 range advantage.
  - **Fix:**
    - crew-served guns (`def.setup`) halt for their target even when turned aside, at their acquisition range;
    - they stay set up while the target is only smoke-hidden;
    - field guns (`setupHold` 3.2 s) hold position for 3.2 s after a shot so they can retarget;
    - field gun setup 3 → **1.5 s**, HP 90 → **130**.
  - Mortars keep re-laying after each target. Giving them the hold too made them beat rifles at equal cost (0.47 : 0), so it is left off.
- **Special forces** 140/50 → **125/40**; HP is unchanged. They now trade evenly with rifles at equal cost on open ground; before, rifles kept 0.56 and special forces 0. **Armored car** is unchanged: its mirrors match its role (it beats rifles, loses to AT, mech and guns). Its low AI value ratio (0.38) comes from the AI's AT-heavy armies.
- **Roads stay out of base foundations** (`actionEconomy.js`).
  - A player road edge whose segment passes within `ROAD_FOUNDATION` = 2.7 of any base site centre is refused, own bases included. The reply is `{error: 'Roads cannot be built through the <base> foundation; …', code: 'foundation'}`, for both the preview and the build.
  - Edges that already have a usable road (the automatic hub spokes) are skipped silently, so a route can join a spoke.
  - Auto links (`connectSiteRoads`) are unaffected.

### Protocol (for F, G, K)
- New error code `foundation` on `roadBuild` (preview and build).
- Econ snapshot `dominance: [team, secondsLeft]` while a decisive-domination countdown runs (omitted otherwise).
- `welcome.defs.RULESET.dominance = {after: 1080, hqShare: .65, armyRatio: 2.5, hold: 90}`.
- Game over can now carry `how: 'Decisive Domination'`.
- Units: `field_gun.setup` 1.5, `field_gun.setupHold` 3.2, `field_gun.hp` 130, `special_forces.cost` 125/40.

### E metrics, Wave 2 (10 maps × 3 seeds, 30 min, normal AI; same tool and seeds as E)

"Before" is the tree before these changes. It reproduces E's Wave 1 table exactly, so E's tables above are the before state.

Match length per run (before → after):

| Map | Before (s1 / s2 / s3) | After (s1 / s2 / s3) |
|---|---|---|
| Twin Rivers | 21:54 · cap · cap | 16:39 · 17:41 · 15:38 |
| Saltmarsh Estuary | cap · cap · cap | 29:09 D · 19:41 D · 19:30 D |
| Continental Divide | cap · cap · cap | 25:32 D · 19:35 D · 22:46 D |
| Mirefen Gap | cap · 29:07 · 17:56 | 19:07 · 13:04 · 16:14 |
| Highland Fork | cap · cap · cap | cap · cap · 23:46 D |
| Iron Basin | cap · cap · cap | 21:51 D · 29:33 D · cap |
| Three Crowns | cap · cap · cap | 23:40 D · cap · 26:23 D |
| Shattered Delta | cap · cap · cap | 19:34 D · 21:25 D · 19:11 |
| Crossroads | cap · cap · cap | 23:31 D · 26:19 D · 27:26 D |
| Quarry Highlands | cap · cap · cap | cap · 21:21 D · 26:31 D |

D = decisive domination; unmarked = elimination; cap = still running at 30 min.

| | Before | After |
|---|---|---|
| Matches ended within 30 min | 3 / 30 | **25 / 30** |
| Ended at 18–30 min | 2 | **20** |
| Ended under 18 min | 1 | 5 (all on the 1v1 maps, 13:04–17:41) |
| Median length of ended matches | 21:54 | **21:25** |
| Mean length, all runs (cap counted as 30:00) | 29:18 | 23:10 |
| Wins by elimination / by decisive domination | 3 / 0 | 7 / 18 |
| Headquarters destroyed (all runs) | 200 | 121 |

The five capped runs (Highland Fork s1 and s2, Iron Basin s3, Three Crowns s2, Quarry Highlands s1) were close contests: two or more strong survivors trading bases. Three of them were within reach of the domination thresholds by minute 30.

The full table, after (columns as in E's table):

| Map | Seeds | First contact (mean) | First kill | 5th kill (first battle) | Units/player @3 @6 @9 @12 @18 @24 | Army value/player @12 | Kills/player (end) | Match length | Ended | Craters @end | Field works @end |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Twin Rivers | 3 | 4:19 | 4:44 | 5:23 | 13 / 19 / 27 / 37 / - / - | 3449 | 63 | 16:39 | 3/3 | 62 | 3 |
| Saltmarsh Estuary | 3 | 6:02 | 6:59 | 9:03 | 15 / 16 / 23 / 37 / 42 / 59 | 3586 | 76 | 22:47 | 3/3 | 157 | 0 |
| Continental Divide | 3 | 9:36 | 9:44 | 10:57 | 14 / 16 / 23 / 38 / 46 / 59 | 3691 | 63 | 22:38 | 3/3 | 181 | 6 |
| Mirefen Gap | 3 | 4:38 | 4:50 | 5:48 | 14 / 17 / 26 / 37 / 52 / - | 3423 | 55 | 16:08 | 3/3 | 42 | 0 |
| Highland Fork | 3 | 7:25 | 7:47 | 8:32 | 14 / 18 / 24 / 39 / 54 / 56 | 3906 | 140 | 27:55 | 1/3 | 240 | 16 |
| Iron Basin | 3 | 5:28 | 7:22 | 10:46 | 14 / 16 / 22 / 37 / 47 / 50 | 3595 | 92 | 27:08 | 2/3 | 243 | 5 |
| Three Crowns | 3 | 2:54 | 3:48 | 6:00 | 14 / 18 / 25 / 32 / 42 / 42 | 3200 | 156 | 26:41 | 2/3 | 163 | 10 |
| Shattered Delta | 3 | 2:41 | 4:23 | 5:39 | 14 / 17 / 23 / 32 / 44 / - | 3147 | 78 | 20:03 | 3/3 | 128 | 2 |
| Crossroads | 3 | 3:44 | 5:07 | 6:27 | 14 / 17 / 25 / 33 / 60 / 60 | 3247 | 110 | 25:45 | 3/3 | 190 | 18 |
| Quarry Highlands | 3 | 3:50 | 4:02 | 5:19 | 14 / 18 / 21 / 24 / 36 / 53 | 2491 | 112 | 25:57 | 2/3 | 165 | 18 |

- Units per player at minute 12 average about 35, against about 41 before. Closing assaults now spend armies; matches that ended no longer contribute to later columns (`-`).
- First contact is unchanged.

Unit types in AI play, after (all 30 runs):

| Unit type | Built | Lost | Kills | Kills per loss | Value killed / value lost |
|---|---|---|---|---|---|
| rifle_squad | 7847 | 5515 | 6609 | 1.20 | 1.74 |
| anti_armor | 2149 | 1603 | 1633 | 1.02 | 0.94 |
| mortar_team | 1878 | 1243 | 1455 | 1.17 | 0.76 |
| scout_buggy | 859 | 770 | 17 | 0.02 | 0.02 |
| armored_car | 670 | 418 | 246 | 0.59 | 0.38 |
| tank | 416 | 221 | 522 | 2.36 | 0.88 |
| mech_infantry | 151 | 83 | 113 | 1.36 | 0.61 |
| recon_drone | 26 | 7 | 0 | 0 | 0 |
| helicopter | 8 | 1 | 3 | 3.00 | 0.93 |
| air_defense / fighter / sp_artillery | 1 / 1 / 1 | 0 | 1 / 0 / 0 | - | - |

- In an intermediate full run (v6, the same rules except closing from minute 10), the AI built 15 helicopters (4 lost, 25 kills), 5 fighters and 8 AA vehicles.
- Helicopters now die in AI play, and the AI builds fighters and AA. Air remains rare overall (see risks).

**Mirror tests, after** (`tools/action-mirror.mjs 1800 120 3`). Changed rows only; all other rows are identical to E's table.

| A | B | Before (kept A : B) | After |
|---|---|---|---|
| tank | field_gun | 0.71 : 0.00, A wins | **0.00 : 0.32, B wins** |
| anti_armor | field_gun | 0.94 : 0.00 | 0.69 : 0.00 (AT still counters guns) |
| field_gun | armored_car | (n/a) | 0.38 : 0.00, A wins |
| field_gun | mech_infantry | (n/a) | 0.56 : 0.00, A wins |
| field_gun | rifle_squad | 0.00 : 0.96 | 0.00 : 0.69 (infantry still counters guns) |
| special_forces | rifle_squad | 0.00 : 0.56, B wins | **0.00 : 0.13, even** |
| rifle_squad | mortar_team | 0.13 : 0.04 | 0.05 : 0.20, even |

### Verified
- `test/action-wave2.test.js`, 6 of 6 pass:
  - road refused with code `foundation` on preview and build, while routes around the base are allowed and keep 2.7 of clearance;
  - a field gun on attack-move sets up outside tank range and fires;
  - rifles can engage helicopters but not fighters, and tanks cannot engage helicopters;
  - repair rate is 0.30× under fire;
  - air mix choices;
  - decisive domination: not before minute 18, wins after a 90 s hold.
- `npm test`: 270 tests, 268 pass, 1 fails, and it is the known "action saves continue deterministic spatial simulation". `test/air.test.js` (the legacy `weaponVs` rules) is untouched.
- Sims: the tables above, plus the per-run logs.

### Not verified / risks
- **1v1 maps end early.** Twin Rivers and Mirefen Gap ended at 13–18 min (elimination). The knobs are the closing start (`game.time > 720` in `planActionAI`) and the superiority ratio (1.8×).
- **Decisive domination is a new rule.** It is announced to players, but the client does not show the countdown yet (econ field `dominance`). F/K: please add a banner. Human playtests should confirm that 65% / 2.5× / 90 s does not feel abrupt.
- **AI air is still rare.** The mix logic and the AA response are right, but era II, airfield slots and energy keep the AI to a handful of aircraft per match. The helicopter and fighter verdict rests on duels and on about 25 aircraft across two full runs.
- **The presumed-capital and hunt logic** use public knowledge only: start positions, which civs are alive, and the AI's own and allied site ownership.
- **Small-arms AA** is limited to the action ruleset. The legacy ruleset still treats rifles and MGs as ground-only.

## Review U. Client UI, controls, session and Steam (review pass)

Per-item results are in `docs/REQUESTS_CHECKLIST_2026-11-16.md` → "Review U". Files: `Runtime/UI/Minimap.cs`, `Hud.Shell.cs`, `Hud.Action.cs`, `Hud.Console.cs`, `Hud.DefenseBar.cs`, `Hud.Overlay.cs`, `Hud.Base.cs` (one line), `FieldGuide.cs`, `Resources/UI/SE.uss` (appended rules); `Runtime/Session/Commander.cs`, `Commander.Markers.cs`, `Commander.Orders.cs`, `Commander.Action.cs`, `Commander.Rings.cs`, `Commander.Air.cs`; `Core/Protocol/Messages.cs`, `ProtocolDecoder.cs` (additive); one hook line in `App/GameBootstrap.cs`.

**New**
- **Decisive Domination countdown.** Econ `dominance:[team, secondsLeft]` shows a banner under the clock: a green victory countdown for our team, a red defeat warning naming the leader and what breaks it, and a neutral line for spectators. The thresholds come from `RULESET.dominance`. The status pill, toast and critical banner step down while it shows (root class `se-hud--dominance`). The result card explains the game-over `how` (Decisive Domination with the hold numbers, Military Domination, Territorial Control).
- **Readable refusals.** `ServerMessage.ErrorCode` (from `code`) and `Commander.ReadableError` cover `territory`, `road`, `spacing`, `ring`, `era` and `foundation`. They are used for the cursor reason, the tool chip and the placement, road, trench, terrain and upgrade toasts. The command ack from `worker.js` currently drops `code`, so the codes are also recognised from the server's text (server fix for S in the checklist).
- **Rally markers from econ `ra:[x, z, mode]`** (`BuildingRecord.HasRally/RallyX/RallyZ/RallyAttackMove`): a ring at the point (green move, red attack move) and a dotted lead, drawn for selected producers or for every producer of the selected base.
- **Minimap fills the circle.** The scale is set by the shorter map side (it was the diagonal, which left a small square with dark corners). The whole-map view slides toward the camera only when the footprint centre would leave the circle, so corners stay reachable. The local view (Z) is 2.25× that.
- New Base placement draws the preview's eight-parcel ring. Shift+click keeps a build-wheel placement armed. A field build's success toast reads "Construction started".
- Selection panel: click a unit box to keep only those units; Shift+click drops them.
- The patrol planning tool chip ("Patrol route · n/8 waypoints" and its keys).
- Squads draw the server's exact living men: `UnitWire.Motion.Men` is decoded from unit extra[8], and `UnitRenderer.MenOf` (which existed but was never assigned) is wired in `GameBootstrap`.

**Fixed**
- Order rings, order lines and refused or pending sites mixed `Time.unscaledTime` with the bootstrap clock, which lags after hitches. The commander and the order lines now use `Time.unscaledTime` only.
- Automatic base engineers (flag 4096) could be box-, click- and double-click-selected and pulled into F's combat selection.
- The idle button counted units holding position (2048), units in a battle line (512) and automatic engineers.
- The action tutorial said "Press T for attack-move"; it now names the bound key (F).
- The assumed default stance is now "defensive", matching the server's `stanceOf`. The stance tooltip now describes the server's behaviour.
- Arming another tool now cancels patrol planning. An attack-move rally shows its own tool-chip title.
- The engineer role line no longer says engineers capture ruins. The field guide gained a "Victory" topic (Decisive Domination), Shift-placement and the selection-box clicks.

**Verified**
- dotnet type-check, 0 errors: Runtime/Core/Net (`check.csproj`) and the Steam assembly.
- Protocol names and indices read against `actionGame.js` (unit row index 10, flags 512/2048/4096, extra[8], econ `ra` and `dominance`, site wire, `rally` / `stance` / `reach` / `patrol` / `terrain` / `fieldPreview` replies), `matches.js` (lobby messages, `obsCmd`) and `worker.js` (acks).
- Steam flow read end to end: lobby keys and filters, overlay invite callback, rich-presence connect, launch arguments, version gate.

**Not verified**
- Anything on screen: there is no editor in this pass. V's play list is in the checklist.
- Steam end to end needs the two-PC procedure in section K.

## Review S. Server review pass (all S items)

Per-item verdicts are in `docs/REQUESTS_CHECKLIST_2026-11-16.md` → "Review S". `npm test`: 279 tests, 278 pass, 0 fail, 1 skipped (the known save-determinism failure is fixed).

### Fixed
- **Save determinism** (the long-standing "action saves continue deterministic spatial simulation" failure). Not caused by this round: `buildActionMap` reshapes terrain after `Game` builds the weather's per-cell climate, while a restore recomputes the climate from the saved terrain, so fog and then vision diverged. `ActionGame` now calls `weather.climate()` after building the map. Note: this changes live weather slightly (it now matches the actual terrain).
- **Saves:** the decisive-domination countdown (`game.dominance`) and `territoryDirty` are saved and restored. Founded bases were checked to save and restore hash-identically, both during construction and after founding.
- **City AA leak:** a lost headquarters now resets `site.defenseLevel`. Before this, whoever rebuilt on the ruin inherited the old owner's perimeter level and city AA.
- **Functional upgrades, the last two:**
  - Infantry Training (was +15% damage) is now *fieldcraft*: halted infantry take cover .22 against direct fire and .12 against shellfire.
  - Aircraft Systems (was +18% air speed) is now *drop tanks*: +50% endurance and patrol range, and refuelling twice as fast.
  - New helpers `actionAir.maxFuel` and `DROP_TANKS`. The air array's fuel byte is relative to the bigger tank.
- **Long group orders on large maps** (`actionNavigation.primeGroup`):
  - The group flow field stopped after 4300 hexes. Members beyond it fell back to bounded A*, which gave up.
  - Example: a 68-unit AI Final Assault across a 208 map took 590 ms and left 18 units with no order.
  - The field now expands at least 4300 hexes as before, then on until every member is covered. Result: 68/68 placed in about 150 ms.
- **Per-tick income visible:**
  - Every 5 Hz snapshot of the action ruleset now carries `res: {materials, energy}`. Before, the stockpile only reached clients in the 1 Hz econ block.
  - **Client (U):** in `ProtocolDecoder`, read `o["res"]` into `SnapshotMessage.Res`. In `ClientSession`, when `!s.HasEcon && s.Res != null && Econ != null`, set `Econ["res"] = s.Res`.
- **Command acks carry `code`** (request from review U): `server/commandAck.js` is used by the worker's `cmd` branch. Refusals now send `{t:'ack', rid, error, code}`.
- **Road projects:** the 24-project limit is now per player instead of shared by everyone. An eliminated player's road and terrain projects are removed.
- **Winner message:** `winner.team` is added, so team games can show a team victory.

### Measured
6 AI players, 20 game-minutes, normal difficulty, seed 7. Two processes ran in parallel. "HEAD" is the pre-round tree (`git archive HEAD`).

| Map | Tree | Mean tick | p95 | p99 | Max | Peak units |
|---|---|---|---|---|---|---|
| Continental Divide (132; HEAD 140) | review | 2.87 ms | 8.1 | 21.2 | 117 | 323 |
| | HEAD | 2.60 ms | 7.2 | 14.9 | 177 | 267 |
| Random 208, FFA 6 | review | 2.58 ms | 6.9 | 21.6 | 218 | 227 |
| | HEAD | 2.90 ms | 9.6 | 20.4 | 151 | 140 |

- No regression per unit. Navigation is 3–5× cheaper; visibility and AI cost more because armies are larger.
- The remaining spikes (100–220 ms single ticks, a handful per match) are AI Final Assault orders of 60+ units, which are `exact` group moves.
- Balance after the review changes (`tools/action-balance.mjs`, 6 maps × 2 seeds): 10 of 12 matches ended within 30 min, at 13–29 min, in line with W2. The two that ran to the cap were Three Crowns and one Saltmarsh run. Mirror tests are unchanged except "3×rifle vs combined arms": 0.34 → 0.24 kept, still A wins.

### Still open (not fixed)
- A **single** unit ordered about 210 units across a 208 map can be refused when bounded A* gives up (1 of 61 probes). Groups of 4 or more are fine.
- AI aircraft and city AA remain rare in AI play: 0 aircraft and 0 level-2 perimeters in three 25-minute feature sims. The fuel, patrol and city-AA logic is covered by tests only.

## Review V. Editor visual and performance review pass

**Found and fixed**
- **Every Blender model was drawn inside-out** (`Rendering/ModelLibrary.cs`). This caused the black round HQ, motor works and power plant, the near-black vehicles, aircraft, defenses and soldiers, and the "dark blob" look generally.
  - `tools/blender/se_meshkit.py` `export` writes positions as (x, z, y). That swap is a reflection, but the exporter keeps Blender's counter-clockwise triangle order, so every SEM1 triangle reaches Unity back-facing. SE/InstancedLit culls back faces, so the inside of each model was drawn.
  - `Decode` now swaps each triangle's second and third index. Normals were already right.
  - Confirmed by toggling the shared material's cull mode in play. Nothing else depends on the old order: foliage is cull-off, and every other mesh is code-built.
  - The exporter itself is unchanged; if it is ever fixed, remove the swap in `Decode`.
- **HQ team bands** (`Cities/CityRenderer.BasePresentation.cs` `HeadquartersTierDressing`): the full discs that capped the drum roofs are now thin panel bands. There are 16 between the lower drum's pilasters, 20 round the upper drum and a tier-3 crown round the cab. All dressing is placed in the authored model's frame, not the parcel-scaled `Module` frame.
- **Vehicle paint** (`Military/UnitRenderer.cs` `Paint`): the 36 % team tint and lift that compensated for the black models went to 24 % and ×1.02 (troops ×1.12 + .02), so lit vehicles keep their camouflage.
- **Defense construction sites** (`Cities/CityRenderer.Defenses.cs` `DefenseSite`, called from `ComposeBuilding`): an unfinished barricade, MG turret, bunker, etc. drew the generic house-sized site with a gable house. It now shows its own body rising with progress, plus timber posts with team tape.
- **Wreck scorch** (`Battlefields/WarzoneRenderer.cs`): an opaque near-black octagon became a soft-edged SE/GroundDecal splash, using a procedural texture and its own quad.
- **Fire and soot smoke** (`Effects/EffectsRenderer.cs`): lighter and less opaque, so burning towns no longer turn into a black sheet that hides units.
- **Diagnostics** (`Cities/CityRenderer.cs`): `BaseCellComposes`, `BaseCellComposeMsTotal`, `BaseCellComposeMsMax` and `ComposeMs[4]` (streets and old world / compounds / buildings / street mesh).

**Measured**
- Base compose with the W2-C cache:
  - **hit**: 13 ms per base cell (compound replay ~1 ms, street draping ~6.6 ms, street mesh ~4.8 ms);
  - **miss**: 94 ms avg, 187 ms max;
  - live battle at an HQ: 1 recompose in 130 s (5.8 ms).
- Perf sweep: see the Review V table in `docs/REQUESTS_CHECKLIST_2026-11-16.md` (sandbox 100–208 FPS, 1 % lows ≥ 44.7).

**Still open**
- A base-cell cache hit is still above the 8 ms target because the cell's ordinary streets are re-draped and their mesh rebuilt. The next step is to cache the street phase per cell.
- Not verified in play: turret yaw and mirroring, muzzle tips, damage stages per building type, trenches, upgrade effects, city AA, and most of U's list.
- The south edge of explored land shows a cliff band under the shroud.
- At zoom > 120 on small maps the ocean slab edge shows.
- Enemy vehicles read salmon-red.
- Barrage smoke from shell bursts is still dark.

## Armored car redesign (gun truck)

The armored car read as a little tank (a scaled-down MBT turret and cannon on a car body). It is now a generic light 4x4 gun truck.
- **Blender** (`tools/blender/build_military.py`, `armored_car` / `armored_car_lo` / `armored_car_mount`; layout constants `CAR_*`):
  - **Hull**: a low, wide tub with a long sloped, louvred hood, grille, bumper and brush guard. The armoured four-door cab has a raked windscreen and a flat roof with the gunner's ring. The hull also has big wheel arches with fender flares and a dark chassis gap for ground clearance. The rear deck carries a spare tyre, stowage boxes, jerry cans and whip antennas.
  - **`ArmoredCarMount`** (new): a roof-ring weapon station with a team-painted three-panel gunner's shield, a pintle heavy MG with ammo can and a gunner. Its origin is on the ring and the muzzle is at (0, .145, .33).
  - **`ArmoredCarLo`** (new): the whole vehicle, wheels included, without chamfers or small fittings, for the operational zoom.
  - **Triangle counts**: hull 2900 + mount 1188, below the old hull + turret + cannon (548 + 2952 + 1154); `ArmoredCarLo` 1152.
  - Only the three ArmoredCar*.bytes files and their MANIFEST lines were updated. New .meta files were written for the two new models.
- **Client** (`Military/UnitRenderer.cs`):
  - Close zoom: the hull rides the shared `Wheel` at 1.15x on two axles at ±.31 (track .27, centre .12), with the front pair steering. The new `Detail.ArmoredCarMount` turns independently on the roof ring at (0, .447, -.06). There is no tank turret or cannon, and the hull's firing kick is .12 (it was .45). The team markings sit on the hood.
  - Operational zoom: `Model.Car` is now `ArmoredCarLo` (it was the civilian saloon plus a tank turret), and the new `Model.CarGun` is the turning mount.
  - `MilitaryMeshes` loads both new models and has a code-built mount as fallback.
- **Muzzle** (`App/GameBootstrap.Presentation.cs` `WeaponMuzzle`): armored-car tracers and flashes leave the roof HMG (+.065 along the line of fire, +.08 up).

## Final pass. Editor review: visuals, camera, performance

**Fixed**
- **Zoom cap by map size** (`Camera/RtsCamera.cs`): `ZoomOutLimit` fits the framed ground, turned by the current yaw, inside the map (×0.9, clamped to 40–260). The focus is kept so the frame stays on the map at every zoom. Small maps no longer show the square ocean slab or the grey void; large maps keep 260.
- **Team colour** (`Military/UnitRenderer.cs` `Paint`): the team colour is scaled to the camouflage's brightness before tinting. Vehicles tint 0.48 and aircraft 0.42, with a 1.15× saturation push and a multiplicative lift; the additive grey on vehicle paint is gone. Enemy vehicles read red, not salmon, and stay lit.
- **Smoke** (`Effects/EffectsRenderer*.cs`): shell-burst puffs and columns are dusty grey-brown. Building-fire, ruin and wreck smoke are lighter.
- **Scorches and craters** (`Effects/EffectsRenderer.cs`, `Battlefields/WarzoneRenderer.cs`): no longer opaque 12-sided discs. They share the soft SE/GroundDecal splash, which removes the hard black octagons left by fallen buildings and wrecks.
- **Fog bank face** (`Resources/Shaders/Shroud.shader`): the depth shading runs over 2.4 units and darkens less, so the camera-facing side of the cloud bank no longer reads as a grey cliff band.
- **Base recompose hitches** (`Cities/CityRenderer.cs`): a base-cell recompose that costs N ms holds the next one back N × 0.05 s (at most 4 s); first composes are never held. In a sandbox battle at a compound, 1 % lows went from ~17 to ≥ 49 FPS.
- **Battle report** (`server/sim/actionGame.js`): "No friendly units lost near …" replaces "0 friendly units lost", with singular "1 friendly unit".
- **Diagnostics** (`App/GameBootstrap.cs`): `UpgradeFxCount` / `UpgradeFxLast` count the barracks-kit effects as they are presented (grenade, rocket, marksman, armour save).

**Verified in play**
- Turret aim and mounts after the winding flip.
- The armored-car gun truck at close and mid zoom.
- Damage stages on 7 base building types.
- Trenches with men on the floor.
- Upgrade effects: grenade, marksman and armour; rocket not seen.
- Aircraft racetracks with return and refuel; the patrol chip.
- Minimap corner sliding and the Z view.
- The dominance banner and the result card.
- Rally rings, the drag box and the radial wheels.
- Order markers vanishing by 1.5 s.
- Smooth resource ticks.

See the "Final pass" section in `docs/REQUESTS_CHECKLIST_2026-11-16.md` for screenshots and the perf table.

**Still open**
- City AA at perimeter level 2: not reachable in the sandbox.
- The per-cell street cache.
- New Base parcel marks and the selection-panel box click were not seen in play.
- The flak close-up and the rocket-team effect were not captured.

## Menus + four bugs

Screenshots: `D:/Projects/se_scratch/menus/` (outside the repo). Checked in play against a local server on :8093, at 1920×1080 and 1280×720. Afterwards the server was stopped, `se.server` was set back to the public server, and the URP asset was not changed. `npm test`: 285 pass, 0 fail (1 skipped, as before). Unity compiles with 0 errors.

**Four bugs**
- **Squad rings** (`Military/UnitRenderer.cs`, `UnitRenderer.Readability.cs`, `Rendering/MeshKit.cs`). Each unit type has one fixed ring size, centred on the unit's interpolated position. A squad's ring is 0.6 across and uses a new thin band (`MeshKit.RingThin`). The ring never changes with spread, casualties, formation or selection. It grows only when zoomed far out (the existing minimum on-screen size, which changes only with the zoom). The men are kept inside it instead:
  - The column and the line are centred on the squad's position, and their spacing is capped to fit (`SquadRingReach`).
  - Trench spacing is capped the same way.
  - A final clamp pulls back any man who would stand outside the ring (after cover, a vehicle or a wall slide moved him).
  - The ring is laid at the highest ground under its edge (`RingGround`), so on slopes it no longer turns into a buried "C".
  - Screenshots: `b1_rings_close_d3.png`, `b1_rings_d7_fight.png` (after casualties), `b1_rings_d26_720.png`.
- **Straight light/dark split** (`Core/Protocol/WorldRecords.cs` `WeatherState.Sample`). The terrain shader darkens rain-wet ground and adds a wet sheen from the ground field's `b` channel. `GroundField` filled that channel per hex with the value of the 8×8-hex weather cell the hex falls in. Neighbouring cells that differed therefore showed as straight-edged blocks: darker ground plus a hatched sheen, as in `f60` and `f91`. `Sample` now blends bilinearly between cell centres, which also smooths the regional weather that `Atmosphere` reads.
  - Confidence: the cause was found by reading the code and matched against the shape and strength of the split. No wet cells occurred in the sandbox during this pass, so the original frames could not be reproduced on demand.
  - Ruled out: the shroud (it casts no shadows), the shadow distance (its edge is a curve), and the fog texture (per hex and bilinear).
- **Trench (and road) through a building** (`server/sim/actionNavigation.js` `structureOnSegment` / `touchesBuilding`; `actionBases.js` `trenchLine`; `actionEconomy.js` `roadBuild`).
  - A trench stroke is checked every 0.08 along each segment against every building's recorded walls (thin ones too, ruins and sites under construction included) and against outpost compounds (radius 0.78). Any hit refuses the whole stroke, preview included, with `code: 'blocked'` and the message "The trench line runs through the bunker: draw it around the structure."
  - New road edges are checked against building walls the same way (not outposts, which roads serve).
  - Client: `Commander.ReadableError` turns `blocked` into "Blocked by the bunker · draw the line around it". A message without the code is recognised by "runs through".
  - Test: `action-bases-2026-11` "trench and road lines are refused through a building". In play: `b3_trench_blocked_toast.png` (a trench across the HQ).
- **Tool chip text cut off** (`UI/Hud.DefenseBar.cs`).
  - The chip sizes to its text (centred with a −50 % translate, max 860), and the title no longer squeezes into an ellipsis. The New Base title now reads "New base · on or beside a road, in your territory" in full.
  - The cursor reason wraps at 380 px and flips to the left of the cursor near the right edge.
  - The patrol chip, the longest of the others, also fits. Screenshot: `b4_newbase_chip.png`.

**Menus (review as a game UI designer)**
- **Found broken:**
  - Text fields were white boxes with pale text (the default theme's input).
  - Lobby "Sit / Join / Team › / + AI" buttons were light-grey default buttons with white text, nearly unreadable.
  - The "4 players" map filter offered FFA 4 maps for a 2v2.
  - A random map showed a "?" card.
  - Skirmish was lopsided: the left column was half empty and the right overflowed, with the seed row cut off.
  - There were no rules in the lobby (victory, starting resources, world style and size), no uneven teams, no spectator seats, and no public lobby list without Steam.
  - "Before" screenshots: `m0_skirmish_before_1080.png`, `m0_lobby_before_1080.png`.
- **New Skirmish** (`UI/MainMenu.cs`). Two balanced columns under section headings:
  - **Sides:** the format; a seat list (you, allies, rivals with team colours, a difficulty and personality chip per AI, and ✕ to leave a seat empty for uneven sides such as 1 v 2 or 3 v 2, random worlds only); a sides summary; and "Every AI".
  - **Rules:** victory, and starting resources (Low / Standard / High / Max), each with a help line.
  - **Battlefield:** a compact map card with the list filtered by format, then world style, size and seed, shown only for a random world.
  - Commander name.
  - Screenshots: `m1_skirmish_1080.png`, `m2_skirmish_3v3_uneven_1080.png`, `m7_skirmish_1v2_720.png`. A 1 v 2 skirmish on Max resources started with civ teams [0, 1, 1] and 5,000 / 2,000 (`m8_skirmish_1v2_started_720.png`).
- **Multiplayer:**
  - Host: "Host a lobby" with the opening format.
  - Join: Browse public lobbies (new), Join a friend (Steam), Join by code, and Spectate by code (which now also takes a lobby's spectator seat).
  - Screenshot: `m12_multiplayer_720.png`.
- **Public lobbies page** (new, `BuildBrowse`):
  - Reads `/api/lobbies` from the configured server every 4 s. Each row shows the name, format, map, victory, host, players/seats and watchers, with **Watch** and **Join** buttons (Join is off when the lobby is full).
  - Works without Steam. Screenshot: `m9_browse_720.png`.
- **Lobby:**
  - The code row has Private/Public (host; sets both the server listing and Steam visibility) and Invite (shown only with Steam).
  - The format control.
  - **Players** by team. The host has "+ AI", "Close" or "Open" (uneven sides, random worlds) and the AI chips. Everyone has "Sit" and "Join team". A sides summary follows.
  - **Spectators:** a list, plus "Watch instead" (guests) or "Take a seat" (spectators).
  - **Battlefield:** the map card and list filtered by format. A random world has style and size (Auto / Small / Standard / Large / Huge).
  - **Rules:** victory and starting resources. Guests see a one-line summary instead of the controls.
  - Screenshots:
    - `m3_lobby_host_1080.png`.
    - `m4_lobby_3v3_uneven_guests_1080.png`: 3 v 2 with a guest and a spectator connected from scripts.
    - `m5_lobby_720.png`.
    - `m10_lobby_spectator_720.png`: our client watching a scripted host's public 2v2.
    - `m11_lobby_guest_seated_720.png`: after "Take a seat".
    - `m6_lobby_match_started_720.png`: the 3 v 2 lobby started with Territory and High.
- **Shared fixes** (`Resources/UI/SE.Menu.uss`, `UI/MapPreview.cs`):
  - Section headings, dark inset text fields and dark small buttons.
  - The map card is compact: a 136 px preview beside the name and notes, above the list.
  - `MapPicker` filters by `Format`. A random world gets a generated preview (`MapPreview.RandomTexture`): an island in the chosen style, with start discs in team colours and closed seats left out.
- **Escape / back:** checked on every page. Lobby → (leave) Multiplayer → root. Skirmish, Settings and Training → root. Browse, Friends and Code → Multiplayer. Guide → Training.

**Server (for the menus)**
- `matches.js`:
  - `create` takes `startRes`, `public`, and `closed` (seat indices; random-world formats only, and both sides must keep a seat).
  - Lobby `options` `{objective, startRes, style, size ('auto' resets), public}` is host-only and validated.
  - `closeSeat {seat, closed}` is host-only. It is refused on catalog maps, and choosing a catalog map reopens closed seats.
  - Lobby spectators:
    - `spectate` now works on a pvp lobby.
    - `watch` moves a seated non-host player to the spectator seats.
    - `sit {to?}` moves a spectator into a seat.
    - Spectators get `room` with `you: -1, spectator: true` and are welcomed as observers when the match starts.
    - They are told when the host closes the lobby, and a spectator who leaves or disconnects is removed.
  - `room` gains `objective`, `startRes`, `style`, `size`, `public`, `spectators` and `slots[].closed`. Its `players` count leaves out closed seats.
  - `lobbies()` and `GET /api/lobbies` (`index.js`) list public lobbies.
  - At the start, `dropClosed` removes closed seats and passes `teamOf` (each player keeps their seat's team, renumbered from 0).
- `actionGame.js`: `START_RES` (low 300/50, standard 500/100, high 1500/500, max 5000/2000), `options.startRes`, and explicit `options.teamOf`.
- **Random-world capitals could stack** (`actionMap.js buildActionMap`). Found while starting the 3 v 2 archipelago lobby: three HQs landed on neighbouring hexes. It is an older problem: the same seed did it with 6 seats. Starts now keep a hard minimum distance (the ring chord × 0.9, relaxed step by step down to the base gap). Below that, a start apart from the others is preferred over a road-reachable one. Test: `test/action-start-spacing.test.js`.
- Tests: `lobby-controls` has five new tests: options and the public listing; closed seats, uneven teams and `teamOf`; lobby spectators; the simulation's teams and starting resources; and size auto.

**Still open**
- The rain-wet split was fixed from the code. The original sandbox frames could not be reproduced on demand to confirm it.
- Steam overlay invites, the Steam public list and joining a Steam lobby were not tested (no second PC). Those paths are unchanged, except that `Public` now follows the server's flag.
- Starting resources and victory are not shown in the in-match HUD (only in the lobby and Skirmish screens).
- Uneven sides need a random world: catalog maps have a fixed start for every seat.
