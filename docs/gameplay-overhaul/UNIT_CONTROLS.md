# Unit controls and hotkeys (workstream C-C, 2026-11-17)

Covers directive §19–23, §28 and §40. Every key below is a named action in `InputFacade.Actions`, so players can remap it in Settings › Controls. That list flags a key used by two actions. Two actions that share a default on purpose are not flagged: Attack move and Flip both default to F, and Flip acts only while a battle line is being drawn.

While a text field has focus, no game key fires (`InputFacade.Typing`); Escape still works.

Choose the camera scheme in Settings › Controls › Camera keys. "Arrow keys" is the default.

## Hotkeys per scheme

| Action (id) | Arrow keys (default) | WASD | Notes |
|---|---|---|---|
| Pan (`pan_*`) | Arrows | W A S D (arrows too) | Also screen edges and middle-drag. |
| Rotate (`rotate_left/right`) | `,` `.` | `,` `.` | Or Alt + drag. |
| **Select units on screen** (`select_local`) | **A** | **Q** | Selects every own unit inside the camera view. Automatic base engineers are skipped. Shift adds to the selection. |
| **Select every unit** | **Ctrl+A** | **Ctrl+Q** | Same action with Ctrl: works world-wide. |
| **Select production buildings** (`select_production`) | **E** | **E** | Every finished building of yours that trains units, anywhere on the map. Shift adds. |
| **Select every building** | **Ctrl+E** | **Ctrl+E** | Same action with Ctrl. Towns stay with their base. |
| Same type on screen | double-click | double-click | Works on units and buildings (existing behaviour). |
| **Same type everywhere** | **Ctrl + double-click** | **Ctrl + double-click** | Units and buildings. |
| Attack move (`attack`) | **F** (was A) | F | Then click a destination. Press twice: every combat unit on screen. Ctrl+F: the whole army. With only production selected, sets an attack-move rally point. |
| Flip line facing (`flip`) | F | F | Only while a battle line is being dragged. |
| Stance (`stance`) | S | V | |
| Hold (`hold`) | H | H | |
| Withdraw (`withdraw`) | W | X | |
| Follow (`follow`) | G | G | |
| Control groups | 1–9, Ctrl+1–9 assigns | same | Pressing the same number twice moves the camera to the group. |
| Air patrol / pause | P | P | |
| Unit wheel / Build / Terrain | C / B / T | same | |
| Brush size | `[` `]` (or Ctrl + wheel) | same | |

**Why attack move moved to F in the Arrow scheme.** The directive puts "select local" on A. F already held attack move in the WASD scheme, and it does not clash with Flip, which only acts while a line is being drawn. Both schemes now share the same order keys apart from stance and withdraw.

**Why the WASD scheme uses Q.** A pans in that scheme. Q was free once rotate moved to `,` and `.`, and it sits next to A.

### Binding migration (`BindingVersion` 4 → 5)

- **Players with default binds** move to the new defaults automatically.
- **Custom binds** are never overwritten.
- **Arrow scheme, a custom bind already on F:** attack move is pinned to A, as before.
- **A new select action whose default is taken** by one of the player's custom binds starts unbound ("—" in Settings). The player can bind it there.
- **Bug fixed:** the v4 scheme inference (`WasdCameraKeys = saved == 3 && custom`) now runs only for saves older than v4. Before, it would have reset existing WASD players to the Arrow scheme.

## Mouse

| Gesture | Effect |
|---|---|
| Left click / drag | Select (box). Shift adds. |
| Right click | Context order: move, attack, collect or capture. Ctrl makes it an attack move, Shift queues it. |
| Right drag | Battle line. Dim placeholder rings appear at once, one per selected unit spaced along the line, until the server's dry run returns slot positions. F flips the facing, Alt makes the line advance, Shift queues it, Esc cancels. |
| Production selected, no units: right click | Sets a move rally point. |
| **Production selected, no units: Shift + left click on open ground** | **Rally placement.** While Shift is held, a dim hint ring and dotted leads follow the cursor. Pressing the button shows the full preview; releasing sets the rally point. Esc or right-click before release cancels. A Shift + drag that grows into a box still adds the boxed units. A Shift-click on a unit, building, pickup or base parcel is still additive selection. |
| **Click outside an open unit / build / terrain wheel** | **Closes the wheel only.** No move, build or selection happens on that click (§40). Escape still steps back through the wheel. |

## Stroke tools: road, trench, terrain brush (§28)

All three follow the same rules (`StrokeRightClickInput`, `KeepToolAfterStroke` in `Commander.Action.cs`):

- **Drag** draws the stroke. **Release** (or Enter) sends it.
- **Shift held on release** keeps the tool armed for the next stroke. Without Shift, the tool ends.
- **Right-click mid-stroke** drops only that stroke; the tool stays armed. Right-click when no stroke is in progress puts the tool away.
- **Escape** cancels the tool.
- **A click without a drag** (road or trench) sends nothing and keeps the tool armed.
- **The tool chip shows the stroke total.** The figure is the server preview's `cost.materials` when present, otherwise accepted parts × list price (15 per road link, 35 per trench segment). The chip also shows the accepted count, skipped parts and build seconds, for example "210 Materials · 6 segments (2 skipped) · 7s · Shift keeps the tool". With no stroke in progress, the chip shows the list price.

## Placing build-wheel structures: defenses, posts, New Base (2026-11-18)

Code: `Session/Commander.Rings.cs` (`UpdateFieldPreview`, `FieldBuildClick`, `RoadSnapEstimate`, `PlacementRefusal`, `SnapNote`), the footprint in `Session/Commander.Action.cs` (`DrawActionOverlay`), the cursor text and tool chip in `UI/Hud.DefenseBar.cs`. Server contract: CONSTRUCTION_DESIGN.md, "Defenses off roads, snapping, and the placement contract".

**The ghost stands where the structure will really go.**
- **Green** means allowed and **red** means refused. Under the ghost, an outline shows the real footprint: the rotated rectangle for walls with `width × depth` (the sandbag barricade), otherwise a ring of the structure's `radius`.
- **Snapped.** The server moves a spot the ground can resolve (`road`, `slope`, `blocked`, `water`, `trench`, `pad`, `forest`) to the nearest valid hex centre within `RULESET.placementSnap` (2) hexes. When it does, the ghost and footprint stand at that hex. An amber lead runs from the cursor to the ghost, with a small ring at the cursor. An amber note at the cursor says why and where it will go, for example "→ On a road · will be placed beside it" or "→ Too steep · will be placed on level ground nearby".
- **Magnetic hold.** A snapped answer holds the ghost while the cursor stays within 0.6 of the spot that was asked, so a near-miss doesn't jitter.
- **No red flicker while moving.** While a new preview is in flight, the ghost keeps the last answer's colour and words.
- **Road rule, before the server answers.** On a road, the client mirrors the rule at once: every defense except the sandbag barricade keeps off roads. The ghost jumps to the first hex centre off the road, in the server's order: hexes within R = 2, nearest centre first, ties to the lowest tile id, skipping other players' land. The estimate is cached per hovered spot (5 cm grid), type and road revision, so it costs nothing per frame. Ring roads, slopes and obstacles are left to the server's answer, which replaces the estimate within one round trip.
- **Refused.** The reason shows at the cursor in plain words, for example:
  - "Outside your territory · …"
  - "Too steep · choose level ground"
  - "On a road, with no clear ground beside it · …"
  - "Not enough resources · need 40 more Materials · structures are paid in full when placed"
  - "Not enough resources for the ×3 price outside your ring of influence · need …"

  Build-wheel structures are paid in full when placed; they never wait in a queue. The ×3 surcharge warning beyond the ring of influence is unchanged, and it stacks under a snap note.
- **Previews.** One is sent every 0.12 s while the cursor moves (more than ≈0.19) or the yaw changes. Every answer newer than the last one applied is used, so a lagging reply still updates the ghost.

**Clicking**

| Input | Effect |
|---|---|
| Click | Sends the cursor point. The server runs the same snap as its preview, so the structure lands where the ghost stood. Refused on the client only when the answer for this very spot is a refusal that nothing nearby resolves. Without Shift, the tool ends when the server accepts. If the server refuses, the tool stays armed and the toast gives the reason. Only one placement is in flight at a time. |
| **Shift + click** | **Places several.** The tool stays armed and the next spot is asked again, so a second Shift-click on the same spot snaps beside the first. The tool chip shows `Shift` "place several". |
| `,` / `.` (rotate keys) | Rotate by 15°. The preview re-checks at the new yaw. |
| Right-click / Esc | Puts the tool away. |

A snapped build toasts "Construction started · kept off the road", or "moved to level ground", and so on. The build wheel's description of every defense except the barricade says "Not on roads: a click on one places it beside the road".
