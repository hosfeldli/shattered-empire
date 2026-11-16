# Interface design specification — action RTS client

- **Type:** Design specification (implementation contract)
- **Updated:** 2026-11-15
- **Scope:** Unity client UI (UI Toolkit, built in code) for the `action-v2` ruleset. The legacy
  strategic ruleset (`session.ActionRts == false`) keeps its current panels and is not redesigned here.
- **Supersedes:** the "Remove … permanent bottom building/defense shortcut bars" line in
  [GAME_DESIGN.md § Interface and camera](GAME_DESIGN.md#interface-and-camera). The owner now wants a
  bottom defensive build bar; update GAME_DESIGN.md when this lands. The intro cinematic is removed.

All sizes are **panel units at the 1920×1080 reference resolution** (`PanelSettings` uses
ScaleWithScreenSize 1920×1080, match 0.5, times the player's Interface scale). "px" below means panel units.

---

## A. Principles

1. **The battlefield is the screen.** HUD lives only at the edges: top bar (56 px), minimap
   (bottom-left), defense bar (bottom-centre), control groups (bottom-right). The middle stays empty
   except for world-anchored command wheels, which open only around what you selected.
2. **Contextual, Halo Wars style.** Everything you can do with a thing is on a wheel around that thing.
   No global build/upgrade/army panels. One radial component for bases, buildings and units.
3. **Icons first, words on demand.** Persistent labels are removed; names, costs, times and lock
   reasons appear in one tooltip/readout after hover (0.35 s) or instantly on wheels.
4. **Nothing jumps.** Every container that holds changing text has a fixed width/height; numbers sit in
   fixed-width slots; status lines are single-line with ellipsis. Nothing appears/disappears inside a row
   in a way that shifts neighbours (hide with `visibility: hidden` where order matters).
5. **Mouse-fast, keyboard-complete.** Every wheel item has a digit key (1–8 clockwise from 12 o'clock);
   every common order keeps its direct hotkey. Escape always goes back exactly one level.
6. **Colour = relation.** Friendly = blue, allied = teal, each enemy = a distinct warm hue, neutral =
   sand. Brass accent (`--se-accent`) is reserved for focus, hover and selection — never for ownership.
7. **One component per concept.** One Settings view, one radial menu, one page stack, one icon set,
   one button/chip style — each owned by exactly one implementer (section C).

Sources applied: gamedesignskills.com RTS guidance (minimap, resource counters with rates, command list,
notifications, hotkeys and control groups, clarity over minimalism but keep the field clear) and Halo Wars 1
(radial base menu around a selected base, base as a hub with fixed sockets wired to the core, contextual
radial commands, circular minimap bottom-left, very lean top bar).

---

## B. Screens

### B0. Global tokens (SE.uss `:root`, owned by Impl-1)

```
--se-surface-0: rgba(8, 12, 14, 0.80)    top bar, bars
--se-surface-1: rgba(14, 21, 24, 0.92)   panels, wheel wedges
--se-surface-2: rgba(30, 40, 43, 0.96)   chips, buttons
--se-surface-hover: rgba(52, 66, 66, 0.98)
--se-line: rgba(255, 255, 255, 0.08)
--se-accent: rgb(226, 182, 96)           focus / hover / selected
--se-accent-dim: rgba(226, 182, 96, 0.35)
--se-text: rgb(232, 226, 210)
--se-text-dim: rgb(150, 164, 160)
--se-good: rgb(142, 212, 132)  --se-warn: rgb(240, 188, 86)  --se-bad: rgb(242, 116, 96)
--se-friendly: rgb(74, 150, 255)   --se-ally: rgb(64, 200, 190)   --se-neutral: rgb(200, 170, 110)
--se-radius: 6px   --se-radius-small: 4px
--se-gap: 8px
```
Enemy hues come from `UiKit.RelationColor(owner)` (C2), not USS. Fonts unchanged (Barlow Semi Condensed;
Cormorant only for the main-menu title).

Standard control sizes: button height 36; icon button 36×36 (icon 20); small icon button 28×28 (icon 16);
chip height 36; text 15 / small 13 / micro 11.
States for every `.se-btn`/`.se-chip`/wheel wedge:

| State | Visual |
| --- | --- |
| normal | `--se-surface-2`, 1 px `--se-line` |
| hover | `--se-surface-hover`, border `--se-accent` (0.7 alpha), 120 ms transition |
| pressed | translate 0 1px, background rgba(92,78,44,1) |
| selected | border `--se-accent`, background rgba(98,82,44,.96) |
| disabled | 40 % opacity; stays hoverable so its tooltip explains why |
| alert | border `--se-warn` (amber) or `--se-bad`; no blinking unless critical |

### B1. In-match layout (1920×1080)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│[▤ 1,240 +2.8/s][⚡ 310 +1.1/s][⋀ 62/120 ▂▂▂]      [ Objective held 34s ]    [❚❚|1×|2×|4×][⏸][☰]│ 56
│                                                                                          │
│                              ┌ toast (errors) ┐                                          │ top 68
│                                                                                          │
│                                                                                          │
│                            (world · wheels open around selection)                        │
│ ┌alerts┐                                                                                  │
│ │ ...  │ left16 bottom272                                                                 │
│ └──────┘                     ┌──── selection card 600×≤220 ────┐                         │ bottom 88
│   ╭────╮                     └─────────────────────────────────┘                          │
│  │ map  │ ⌀240             [▬][≋][▦][⌂][■][⊥][⋎][◎][✚][⌒][♜]   defense bar              [1·12][2·4]│
│   ╰────╯ left16 bottom16          centred, bottom 16, h 60                     right16 bottom16 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Removed in action mode: the left tool rail (`Hud.cs:168-173`, all of it), the top-left tier pill,
the separate speed strip, the idle-units button, the bottom-left "hint" box, the always-on mode-hint
text, the Build/Field-construction side panel.

### B2. Top bar (Impl-1)

- `.se-topbar`: absolute, left/right/top 0, **height 56**, padding 0 16, `flex-direction: row`,
  `align-items: flex-start`, background `--se-surface-0`, 1 px bottom border `--se-accent-dim`.
  Children have `margin-top: 8` → 36 px chips with 12 px clear space below.
- **Left group** (row, gap 8): three resource chips, **fixed width 164** each (Command chip 172).

```
┌────────────────────────┐
│ ▤  1,240      +2.8/s   │  icon 20 · amount (SemiBold 17, width 60, left) · rate (13, flex-grow, right)
└────────────────────────┘
┌──────────────────────────┐
│ ⋀  62/120          +8 ⧗ │  used/cap (width 70) · queued reserve "+8" with hourglass micro-icon
│ ▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂ │  3 px capacity bar absolute bottom 4, left/right 10 (green→amber ≥85 %→red full)
└──────────────────────────┘
```

- Amount: `N0` with thousands separator; ≥ 100,000 → `123k`. Rate: per second, one decimal,
  `+2.8/s`; 0 → `+0.0/s` in `--se-text-dim`; negative never occurs (income only).
- **Rate = average income per second**, not instantaneous: `rateShown = EMA(serverRate + pickupIncome)`
  with τ = 10 s, sampled at the 4 Hz refresh. `serverRate` = `Econ.rates.materials|energy` (already per
  second, passive). `pickupIncome` = Materials from pickup rewards in the last 60 s ÷ 60
  (`ShowPickupReward` records them, `Hud.Pickups.cs`). Spending is excluded so the number never flickers.
- Chips are buttons: **click** pins a breakdown popover under the chip (264 wide, same tooltip style):
  Materials — HQs ×n, Processors ×n, Relays ×n, Pickups (60 s), total /s and /min; Energy — likewise;
  Command — used, reserved in production, cap, faction tier ("Faction Tier II · cap 120 → Tier III 160"),
  purchased upgrades. Second click, Escape, or clicking elsewhere closes it. Hover shows the same as a
  plain tooltip after 0.35 s.
- Shortage states: chip border `--se-bad` for 1.2 s when a command fails for lack of that resource
  (Impl-2 calls `Hud.FlashResource("materials")`). Command chip border `--se-warn` when used+queued ≥ cap.
- **Tier is not shown in the top bar.** It lives on each base (B5 marker pips, hub of the base wheel)
  and in the Command chip popover (faction tier).
- **Centre status pill** (absolute, left 50 %, translate −50 %, top 10, fixed width 280, height 32):
  "Objective held 34 s" / "Restore command in 41 s" / spectator "Observing: <nation>". Hidden
  (display none — it is absolute, nothing shifts) when empty.
- **Right group** (absolute right 16, row, gap 8, never stretches; every element fixed width):
  1. Speed segmented control — only when `Welcome.Sandbox` or `Spectator`. Height 36, segments 44 wide:
     `❚❚ | 1× | 2× | 4×` (+ `8×` for spectators). Pause segment uses the `pause` icon (not a glyph
     character). Selected segment: accent fill, dark text. Width = 44 × count + 2 border. Hotkeys
     P (pause toggle), `=` faster, `-` slower.
  2. Observer chip (spectator only, 160 wide): civ colour dot + followed nation; click opens a small
     list popover (follow nation, toggle fog) — replaces the old rail "Observer" button.
  3. Invite (multiplayer with Steam available): icon button 36×36 `invite`.
  4. 1 px divider, 24 tall.
  5. Pause icon button 36×36 — shown only when the speed control is hidden **and** pausing is allowed
     (`Welcome.CanPause`). Toggles pause (same as P).
  6. Menu icon button 36×36 `menu` → opens the pause menu (same as Escape at the root).

### B3. Toasts, banner, alerts (Impl-1)

- **Toast** (replaces `hint`, `Hud.cs:180-184`, `705-712`): top 68, centred, max-width 560, height 32,
  single line, ellipsis, `--se-surface-1`. Shows **refusals and failures only** (red text) for 3 s, plus
  these positives for 1.5 s: "Construction started", "Upgrade started", "Rally point set", "N queued".
  Suppressed: "Order accepted", "N deploying", "Holding position", "Retreat ordered", group-assignment
  messages. Rule: `Commander.Say(text, good)` → good messages shown only if in the allow-list.
- **Critical banner**: top 108, centred, width 520, 4 s.
- **Alerts feed** moves to **left 16, bottom 272, width 320** (above the minimap), max 3 notes, 8 s life,
  each note a single row: severity bar 3 px · text (2 lines max, ellipsis) · `Go` small icon button
  (`target` icon, 28×28). Clicking the note body also jumps.
- **Space** jumps to the latest alert (unchanged).

### B4. Minimap — circular, bottom-left (Impl-3)

```
         ╭──────────╮
       ╱   N ·        ╲      diameter 240 (image 224, bezel 8)
      │   ░░▓▓  ·•     │     left 16, bottom 16
      │  ░▓▓▓●  ┌─┐  ◆ │     ● friendly base (blue circle)   ◆ enemy base (enemy-hue diamond)
      │   ░░    └─┘ ▲  │     ┌─┐ camera footprint (trapezoid, clipped to circle)
       ╲   ·  •      ╱       • units   ▲ ping (alerts)
         ╰──────────╯
```

- Element `.se-minimap`: absolute left 16, bottom 16, 240×240, `border-radius: 120`, `overflow: hidden`,
  bezel = 8 px border `--se-surface-0` with inner 1 px `--se-accent-dim` ring (drawn by Painter2D, not
  a second element). North-up (no rotation with camera yaw; the footprint shows yaw).
- **Projection:** the whole map is fitted into the circle: map rect (width `Grid.Period`, height
  `Grid.H*1.5`) scaled uniformly so its **diagonal** fits 224 px; area outside the map but inside the
  circle is `rgb(10,14,16)`. Wrapping maps: centre the circle on the camera focus x (scrolls horizontally)
  so wrap is seamless.
- **Layers** (texture redrawn at 2 Hz, overlay vector pass every frame):
  1. Terrain (existing `Terrain()` colours, darkened 0.55 when not visible; unknown = `rgb(14,18,20)`).
  2. Territory: tint 0.25 toward `RelationColor(owner)` + **1 px border at ownership edges at 0.85**
     (subtle territory border).
  3. Fog: unknown tiles opaque dark; known-not-visible 45 % darker.
  4. Objectives/bases (vector): own HQ = 10 px blue circle with white 1 px outline; enemy HQ =
     10 px diamond (square rotated 45°) in that enemy's hue (same shape language as B5); neutral ruin = 7 px hollow sand circle; capturable outposts 6 px
     hollow circle. Contested = pulsing red ring.
  5. Buildings (vector): 4×4 squares, relation colour; field defenses 3×3.
  6. Units (vector, not texture pixels): own = 3 px blue dots, allies teal, enemies their hue (visible
     only), aggregated per 4 px cell to cap draw count at 1,500.
  7. Camera footprint: the 4 ground corners (existing `ViewCorners`), stroke 1.5 px
     `rgba(255,236,180,.95)`, clipped to the circle.
  8. Alert pings: expanding ring (12→28 px, 1.2 s) at `LastAlertTile` and at under-fire events.
- **Interaction:** left-click/drag = jump camera (existing `FocusMap`); right-click with units selected =
  move order to that point (Impl-3 raises `Minimap.OrderAt(x, z, shift)` → Impl-2's
  `Commander.MinimapOrder`). Clicks outside the inner circle are ignored. Hover shows nothing (no tooltip).
- Shown whenever the game HUD is shown, in **both** rulesets (remove the `!session.ActionRts` gate,
  `Hud.cs:249`, and the lens toggle). `M` no longer toggles it (remove `Hud.cs:220`).

### B5. World markers and relation colours (Impl-2 markers, Impl-3 palette)

- `UiKit.RelationColor(owner)`: own → `--se-friendly`; same team → `--se-ally`; neutral/unowned →
  `--se-neutral`; enemies → fixed hue list by enemy order in `Welcome.Civs`
  [red (232,72,60), orange (240,140,40), magenta (210,70,180), yellow (230,200,50), violet (150,90,230)].
- `ClientSession.CivColor(id)` (Impl-3) returns the relation colour when the ruleset is action-v2, so
  units, building tint, health-bar stripes, objective markers and minimap all agree automatically.
  Server civ colours are kept for the legacy ruleset.
- **Base marker** (`DrawObjectives`, Impl-2): replaces the icon+name pill.
  - Own base: 28 px **circle** badge (blue fill 85 %, white HQ glyph), **tier pips** under it (3 slots,
    6×6 squares, filled = tier reached, gap 2). Detailed view adds the name to the right (max 110,
    ellipsis).
  - Enemy base: 28 px **square-rotated-45° (diamond)** badge in the enemy hue with a crossed-swords
    glyph, tier pips in the enemy hue (known tier only).
  - Neutral ruin: hollow sand ring with the ruin glyph; capture/rebuild progress as an arc around the
    badge (3 px), not a separate bar.
  - Shape differs as well as colour (friendly circle, enemy diamond, neutral hollow) — colour-blind safe.
- Selection ring around a selected own base: world-space circle at `site.Radius × 1.15`, blue
  `(.29,.59,1,.55)`, width .02 (Commander overlay), plus the parcels' corner brackets (existing).

### B6. Radial command wheel — one component for bases, buildings and units (Impl-2)

**Geometry** (`RadialMenu`, a `VisualElement` drawn with Painter2D, children only for icons/badges):

```
                 1
            8 ╱‾‾‾‾‾╲ 2           hub ⌀72 (r 36): selection glyph / back arrow / page dots
             │ ╲ ⬤ ╱ │            wedges: inner r 46, outer r 132, 2° gap, first wedge centred at 12 o'clock,
           7 │  (hub) │ 3           clockwise. Icon 32 at r 89. Badge (count) ⌀20 at r 118 on wedge mid-angle.
             │ ╱   ╲ │            progress/cooldown: 4 px arc along the outer edge of the wedge.
            6 ╲_____╱ 4           outer command arc (base wheel only): buttons ⌀44 at r 172.
                 5
         ┌ readout 280 ┐          readout card: below the wheel (top = centre + 148), or above if clipped.
```

- Segments per page: **2–8**. With more than 8 items, show 7 + a **More** wedge (`more` icon, key 0);
  hub shows page dots (6 px, gap 4). Mouse wheel over the wheel also pages. Sub-wheels (an item with
  children, e.g. "Upgrades", "Air missions") replace the ring; hub shows `back` arrow; Escape or
  right-click on the hub returns to the parent ring.
- Wedge states: normal `--se-surface-1` 92 %; hover → `--se-surface-hover` + 3 px outer stroke
  `--se-accent` + icon tint white; disabled → icon 40 % and a 12 px `lock` glyph at r 112;
  active/toggled (e.g. repeat production on) → inner 3 px stroke `--se-good`; armed-confirm → wedge
  fill `rgba(170,60,40,.85)`.
- **Readout** (fixed 280 wide, min-height 64, below wheel): name (heading) · cost row
  (`materials` icon 14 + value, `energy` icon 14 + value; unaffordable values in `--se-bad`) · time
  "17 s" · hotkey "[3]" right-aligned · lock reason line in `--se-warn` ("Requires Tier II",
  "Needs Advanced Systems Lab", "Need 40 more Materials", "Cooldown 12 s"). It shows the hovered wedge,
  else the hub's subject (e.g. "Barracks · 2 in queue"). This replaces tooltips on wheels.
- **Anchor and clamping:** centre = screen projection of the subject (base HQ centre, building centre)
  re-projected every frame; unit wheel = cursor position at open time (fixed in screen space).
  Clamp so the wheel's bounding circle (r 132, or r 200 for base wheel with outer arc) plus the readout
  stays inside the **safe area**: x ∈ [16, W−16], y ∈ [64, H−92]; then, if it intersects the minimap
  circle (centre (136, H−136), r 136), push the centre outward along the line between the centres.
  If the subject goes off-screen the wheel hides and reappears when it returns (selection kept).
- **Input:**
  - Left-click wedge = execute. Shift+click = ×5 (train) / queue (orders). Right-click wedge = cancel
    one queued unit, or toggle repeat (train wedges); elsewhere on the wheel = back/close.
  - Keys: digits **1–8** pick wedges clockwise from 12 o'clock; **0** = More; Escape = back one level
    (closes at root). Digits go to the wheel only while the wheel is "hot": pointer within r 200 of the
    centre **or** it was opened by keyboard (C) in the last 3 s; otherwise digits remain control groups.
    While hot, Impl-2 sets `Commander.SuppressGroupKeys = true`.
  - Disabled wedge click: no action, readout reason pulses, toast shows the reason.
- **Opening rules:**
  - **Own base (HQ) or empty socket clicked** → base wheel opens immediately (B7).
  - **Own building clicked** → building wheel opens immediately (B8). Double-click selects all of that
    type on screen; the wheel then shows the shared training roster (counts summed).
  - **Units:** wheel does **not** auto-open (selection happens constantly). Open with **C**
    (new remappable action `commands`) at the cursor, or the `wheel` button on the selection card.
    Setting "Open unit wheel on selection" (Interface section, default off) auto-opens it.
  - Closes on: selection change, placement/target tool starting, Escape at root, clicking empty world.
    Right-click world orders while the unit wheel is open issue the order and close it.
- **Coexistence:** wheels never cover the minimap or defense bar (clamping above). While a wheel is open
  the defense bar stays interactive; starting a defense placement closes the wheel. The selection card
  remains (it shows status, not commands).

### B7. Base wheel (Halo Wars hub) — Impl-2

```
                 [socket 1]
     [socket 8]               [socket 2]          ring = the base's 8 sockets, each wedge points
                    ╭───╮                          toward its parcel in the world
   [socket 7]      │ HQ │      [socket 3]          hub = HQ: tier pips; click = upgrade tier
                   │●●○ │                          locked socket: lock + "II"/"III"
     [socket 6]     ╰───╯     [socket 4]
                 [socket 5]
        (Defenses)(Perimeter)(Rally)(Production)(Repair)     outer arc, centred at 6 o'clock,
                                                             spacing 26°, r 172, only visible ones
```

- **Sockets:** always 8 wedges (positions fixed), item = parcel. Assignment: compute each parcel's
  screen bearing from the HQ; assign parcels to the 8 wedge angles by greedy nearest-angle so each wedge
  points at its parcel. Wedge content:
  - empty unlocked: `plus` icon, slow brass pulse on the outer stroke (alpha .35↔.7, 1.6 s) → "glows";
  - occupied: facility icon; construction/upgrade progress as the outer arc; queue count badge;
  - locked (`parcel.Tier > site.Tier`): `lock` + tier numeral, readout "Unlocks at base Tier II".
- **Socket glow both ways:** hovering a wedge sets `Commander.HoverRingSlot = parcelId` → world parcel
  draws bright brackets plus a translucent fill (blue .25). Hovering a parcel in the world (existing
  `SelectActionRing` hit test, now also on hover) highlights its wedge. Clicking a parcel in the world is
  equivalent to clicking its wedge.
- **Click empty socket → Build picker** (pop-out panel, not a sub-wheel, so all 9 facilities and their
  lock reasons are visible at once):

```
┌ Site 3 · empty ─────────────────── ✕ ┐  panel 352 wide, header 36, padding 12
│ ┌────────┐┌────────┐┌────────┐        │  tiles 104×104, gap 8, 3 columns, all 9 facilities always
│ │  ▣     ││  ⚡     ││  ⛑     │        │  icon 36 (top 10) · name 12 px, 2 lines max, centred
│ │Material││Energy  ││Barracks│        │  cost row: ▤150  ⚡30 (micro 11, unaffordable red)
│ │▤150    ││▤160 ⚡30││▤170    │        │  digit hotkey 1–9 top-left (micro, dim)
│ └────────┘└────────┘└────────┘        │  locked: icon 40 %, lock glyph top-right,
│ … Armory · Vehicle Works · Heavy …    │  footer text replaces cost: "Tier II" / "Needs Adv. Lab"
│ … Airfield · Adv. Systems Lab · Silo  │
└───────────────────────────────────────┘
```
  - Placement: on the side of the wheel where the socket wedge is (wedge angle in the right half →
    panel left edge at centre.x + 148; else right edge at centre.x − 148), vertically centred on the
    wedge's icon, clamped to the safe area.
  - Hover tile → `Commander.PreviewRingFacility(site, slot, type)` (ghost in the world); leave →
    `ClearRingPreview`. Click → `BuildRingFacility`, picker closes, wedge shows progress. Unaffordable
    → disabled with "Need N Materials". Keys 1–9 pick tiles while the picker is open; Escape closes the
    picker (back to the base wheel).
- **Hub = tier upgrade.** Hub shows the HQ glyph and 3 tier pips. Hover readout: "Upgrade to Tier II ·
  ▤ cost ⚡ cost · 45 s · Unlocks 2 sites and Tier II units". Click → `advance`; progress shown as a ring
  around the hub. At Tier III or while upgrading the hub is informational (no action).
  Key **U** = upgrade while the base wheel is open.
- **Outer arc commands** (left→right; each 44 px circle, icon 22):
  1. **Defenses** (`defense`) → defense picker (same pop-out style, 4 columns, tiles 76×88, all field
     defenses incl. locked; first tile row also has **Perimeter** if not yet bought). Picking starts
     `BeginFieldConstruction(type)`; the camera does not move; the wheel closes.
  2. **Perimeter** (`sandbags`) → `baseDefenses` (only while `DefenseCount < 6`; label in readout
     "Build city perimeter" / "Rebuild perimeter (4/6)").
  3. **Rally** (`rally`) → rally target mode for all trainers at this base.
  4. **Production** (`barracks`) → selects all production facilities at this base (shared roster wheel).
  5. **Repair** (`repair`) → only when the HQ is damaged.
- Not yet established (secured ruin): wheel has one item at 12 o'clock **Establish base** with cost,
  disabled while contested. Enemy or neutral base: no wheel; selection card shows capture state only.

### B8. Building wheel — Impl-2

Items in order (only applicable ones; empty wedges never shown):
1. Train items, one per trainable unit type (unit silhouette icon; badge = queued count across the
   selection; outer arc = head-of-queue progress on the wedge whose unit is training; click = queue
   `quantity` (default 1, Shift ×5); right-click = cancel one; **Ctrl+click** toggles repeat production —
   active repeat shows the green inner stroke). Locked units are shown disabled with reason.
2. **Upgrades ›** sub-wheel (`upgrade` icon) — techs researchable at this building (Armory, Barracks
   upgrades), with costs, tier locks, "Complete" (green check, disabled).
3. **Rally** (`rally`).
4. **Reinforce group ›** sub-wheel (only when control groups exist) — one wedge per group (number glyph).
5. **Repair** (`repair`) when damaged.
6. Missile facility: **Build missile** or **Launch ›** (two-step confirm: first click arms → wedge red
   "Confirm", second click within 4 s starts targeting).
7. **Demolish** (`demolish`, two-step confirm) — **only if the server advertises a `demolish`
   command**; the action ruleset has none today (server command list: ability, advance, airMission,
   attack, baseBuild, baseDefenses, batchTrain, cancelTrain, capture, collect, deploy, detach, establish,
   fieldBuild, fieldPreview, fortify, group, hold, missileBuild, missileLaunch, move, rally, rallyGroup,
   repair, repeat, research, roadBuild, train, trenchWorld, withdraw). Ship hidden; add when the server
   gains it.

Production with more than 7 unit types pages automatically (More wedge).

### B9. Unit wheel — Impl-2

Ring 1 (root), in order: **Move** (target mode, plain move) · **Attack-move** (T) · **Hold** (H) ·
**Withdraw** (X) · **Abilities** — one wedge per distinct ability in the selection (Take Cover, Field
Repair, Recon Scan, Focused Fire, Area Bombardment, Priority Intercept, Air Superiority Patrol, Targeted
Strike, Tactical Infiltration; cooldown sweep darkens the wedge clockwise and the readout shows "Ready in
12 s") · **Air missions ›** (aircraft in selection: Patrol, Scout, Intercept, Support, Return) ·
**Fortify/Dig in** (`fortify`, infantry) · **Detach** (units in reinforcement groups).
Hub: unit-type glyph of the largest group and the count. Direct hotkeys keep working without the wheel.

### B10. Selection card (Impl-2)

Fixed **width 600**, centred, **bottom 88**, max-height 220 (inner ScrollView), padding 10 12.
Status only — commands live on wheels. One header row (height 32): icon 24 · name (heading, ellipsis) ·
right: `wheel` small icon button (opens the subject's wheel; units only, since buildings auto-open).

| Selection | Body (max 3 rows) |
| --- | --- |
| Units | composition chips (unit icon 20 + count), condition bar 4 px, "3 queued at a crossing" only when non-zero |
| Own building | condition/construction bar; production line: queue icons (24) with progress on the first; "Repeat" tag |
| Own base | tier pips, HQ condition bar, income from this base "+1.9/s ▤ +0.6/s ⚡", sockets "5/6 used" |
| Enemy / neutral site | owner dot + name, capture/contested bar |
| Pickup | "+110 Materials" (one line) |
| Tool active | replaced by the **tool chip** (B11) |

Removed text: role captions/descriptions (moved to wheel readout), "LOCAL CITY TIER …", "Select a
highlighted building lot…", "A balanced opening…", "{n} development sites · … · Materials & Energy",
pickup instructions, "Hold the command zone…", "Infantry or engineers secure…".

### B11. Defensive build bar + tool chip (Impl-2)

```
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ [≋]  [═] │ [▬] [⌂] [■] [⊥] [⋎] [◎] [✚] [⌒] [♜]                                     │ h 60
 └──────────────────────────────────────────────────────────────────────────────────┘
   Trench Road   Sandbags Guard Bunker AT  AA  Sensor Repair Artillery Fortress
   1      2      3        4     5      6   7   8      9      0         -        (shown only while B is armed)
```

- `.se-defensebar`: absolute bottom 16, left 50 %, translate −50 %, height 60, padding 4, row,
  `--se-surface-0`, radius 8. Buttons 52×52, icon 28, gap 4; 1 px divider after Road. Total 620 px.
- Items (server keys): Trench (`Mode.Trench`, 35 M/segment), Road (`Mode.Road`, 15 M/link), Sandbag
  Barricade (`barricade`), Guard Post (`guard_post`), Bunker (`bunker`), Anti-Armor Emplacement
  (`turret`), AA Battery (`aa_battery`), Radar/Sensor Post (`sensor_post`), Forward Repair Station
  (`repair_point`), Artillery Emplacement (`artillery_post`), Fortress (`fort`). All always visible;
  tier-locked ones disabled with a 12 px lock and tier numeral in the bottom-right corner.
- Each button: bottom-left micro cost "165" (Materials) in `--se-text-dim`, red when unaffordable.
  Tooltip (0.35 s): name · cost · build time · "Q/E rotate" · lock reason.
- Click → starts placement (`BeginFieldConstruction(type)` / `Commander.Begin(Mode.Trench|Road)`); the
  button shows `selected` while its tool is active; clicking it again cancels.
- Hotkeys: **B** arms the bar for 2.5 s (bar border accent, digit labels appear top-left of each
  button); then `1–9, 0, -` pick in order. While armed, control-group digits are suppressed. B again or
  Escape disarms.
- Hidden for spectators and before the first base is established? **No** — field construction never
  needs a base; hidden only for spectators and while menus are open.
- **Tool chip** (replaces `ActionToolCard`): centred, bottom 88 (selection card slot), height 40,
  auto width (min 280, max 560): icon 20 · name · cost · `Q/E` keycap glyphs (fieldBuild only) ·
  close icon button 28 (= Escape). Invalid placement reason shows **at the cursor** in the existing
  place card (`PlacementCard`) only when invalid, red, single line.

### B12. Control groups (Impl-1, `Hud.Command.cs`)

Bottom-right (right 16, bottom 16), row, right-aligned, chips 52×32: digit (SemiBold 15) + count
(micro). Click = select, double-click = jump, Ctrl+click = assign current selection. Max 9; hidden when
none. **Idle button removed** (and its `idle` action/key).

### B13. Pause menu (Impl-1)

Escape (nothing else open) or the `menu` button. Dimmer `rgba(4,7,8,.55)` over the whole screen.

```
┌──────── PAUSED ────────┐     frame 360×440, centred, fixed size
│ ▶  Resume              │     items 44 tall, icon 20 + label, gap 4
│ ⚙  Settings            │     Settings pushes the shared SettingsView into a 880×720 frame
│ ?  Field guide         │     (same frame object resized via class .se-frame--wide)
│ ⇄  Invite friends      │     (MP + Steam only)
│ ⌂  Leave match         │     confirm sub-page: "Leave match?" [Cancel] [Leave]
│ ⏻  Quit to desktop     │     confirm sub-page
└────────────────────────┘
```
Opening the pause menu pauses the simulation only in single-player matches where pausing is allowed
(restore the previous speed on resume). Escape pops one page; at the root it resumes. No "Save"
button (saving is continuous; it was a dead-end toast).

### B14. Settings — one shared component (Impl-1, `SettingsView`)

Used identically by the main menu and the pause menu. It **fills its parent**; the parent frame decides
the size (both frames are 880×720, see B13/B15).

```
┌─ Settings ───────────────────────────────────────────────────────────────┐ header 48
│ ┌──────────┐ ┌─────────────────────────────────────────────────────────┐ │
│ │ Graphics │ │ Quality      [Low][Medium][High][Ultra]                 │ │ rows 40 tall
│ │ Display  │ │ Window mode  [Borderless][Windowed]                     │ │ label col 220
│ │ Audio    │ │ …                                                       │ │ control col flex
│ │ Interface│ │ Master volume  ───────●──────  80                       │ │ slider 280 + value 48
│ │ Camera   │ │                                                         │ │
│ │ Controls │ │ (ScrollView, only this pane scrolls)                    │ │
│ └──────────┘ └─────────────────────────────────────────────────────────┘ │
│                                       [Restore defaults (this tab)]       │ footer 52
└───────────────────────────────────────────────────────────────────────────┘
  tabs 168 wide, 40 tall each; selected tab: accent left bar 3 px.
```

- Tabs and contents: **Graphics** (quality preset), **Display** (window mode), **Audio** (Master,
  Effects, Ambience, Music sliders; "Sound credits" link opens the guide's credits),
  **Interface** (Interface scale 75–160 % slider applied on release, high-contrast markers, open unit
  wheel on selection, show defense bar hotkey labels), **Camera** (edge pan, pan speed, screen shake,
  reduced motion, weather intensity), **Controls** (key list: label col 300, keycap button 120;
  click → "Press a key…", Escape cancels; conflicts shown in `--se-warn` with the other action's name).
- All controls are custom rows built from `UiKit` (no default Unity `Slider`/`Toggle` label layout):
  `UiKit.SettingRow(label, control)`; toggles are 44×24 switches; sliders show a value label.
- Changing a value **never rebuilds the view** (fixes the scroll jump); only the affected row updates.
  Rebinding is handled inside SettingsView (it polls `InputFacade.AnyKeyPressed()` via
  `schedule.Execute(...).Every(0)` while active) — remove `RebindStep` from `Hud.Update`.
- In-match only: nothing else (no "Leave match"/"Restart tutorial" inside Settings — those live in the
  pause menu / Training page).

### B15. Main menu (Impl-4)

Fixed-size frame anchored to the **full height**: never resizes with text.

```
 ┌───────────────────────────────┐
 │  SHATTERED                    │  frame: left 64, top 64, bottom 64, width 460 (root pages)
 │  EMPIRES                      │  title block fixed height 150 (Cormorant 56, two lines, no wrap logic)
 │                               │
 │  ▶  Continue                  │  menu items: height 56, icon 24, label 20 SemiBold, gap 6
 │  ⚔  New Skirmish              │  primary item (Continue if a match exists, else New Skirmish)
 │  ⇄  Multiplayer               │  gets accent fill
 │  ◎  Training & Extras         │
 │  ⚙  Settings                  │
 │  ⏻  Quit                      │
 │                               │
 │ ───────────────────────────── │
 │ status line (1 line, ellipsis)│  fixed height 28 (errors/server status)
 │ v0.x · Windows preview        │  fixed height 20, micro
 └───────────────────────────────┘
```

- Wide pages (Skirmish setup, Multiplayer lobby, Settings) switch the same frame to **width 880**
  (`.se-frame--wide`), same top/bottom. Inner layout: header 56 (back arrow 36 + page title 28 px) ·
  content (ScrollView, flex 1) · footer 64 (primary action right, Back left). The frame height is
  always viewport − 128 (min 560); content scrolls inside.
- Removed: eyebrow "RECLAMATION COMMAND", subtitle, hover help line (`menu-help`), "Watch Intro".
- **Escape goes back one level** on every page (root: no-op). Back button = Escape. Mouse button 4
  (back) also pops if available.
- Pages:
  - **Continue** → rejoin (disabled with tooltip "No match to continue" when none).
  - **New Skirmish** (wide): two columns. Left 400: World (4 segmented: Continents, Pangaea,
    Archipelago, Inland Sea), Map size (Skirmish/Standard/Epic/Total War), Rivals (1–5 segmented),
    Difficulty (5 segmented; one-line description under it, fixed height 20). Right 400: Victory
    (3 options), Commander name field, Seed field + dice icon button. Footer: Back · **Start**.
    Selecting an option updates only that control (no page rebuild).
  - **Multiplayer** (root, 460): items **Host lobby** (team size segmented 1v1–4v4 inline at the
    right of the item, default 1v1), **Join a friend** (Steam; disabled if Steam unavailable),
    **Join by code**, **Spectate by code**; footer: server field collapsed under "Advanced ▸".
  - **Host lobby → Lobby page** (wide): see B16.
  - **Join a friend**: list of Steam friends currently in a Shattered Empires lobby (avatar 32, name,
    lobby name, slots "1/2", `Join` button 96). Empty state: "No friends are hosting right now" +
    `Open Steam friends` button. Refresh every 5 s while open.
  - **Join by code**: one large code field (monospace look, 6–8 chars, auto-lowercase), `Paste`
    icon button, **Join** primary; Enter submits.
  - **Training & Extras** (root list): Tutorial · Combat Sandbox · Watch AI Match · Field Guide (page).
  - **Settings** (wide): `SettingsView` inside the frame.
  - **Quit** → confirm row inline (item turns into "Quit? [Yes] [No]" for 4 s).

### B16. Multiplayer lobby (Impl-4)

```
┌ ← Lobby · Commander's match ─────────────────────────────────────── ┐
│ Match code   [ k3x9qa ] [⧉ Copy]        [⇄ Invite Steam friends]   │ row 48
│ ┌ Team 1 ───────────────┐  ┌ Team 2 ───────────────┐                │ slot rows 44:
│ │ ● Commander (host)    │  │ ○ Waiting for player… │                │  dot (blue = you/taken,
│ └───────────────────────┘  └───────────────────────┘                │  hollow = open, AI chip)
│ Map: Standard · Pangaea                                             │
│                                  [Leave]              [Start match] │ footer
└─────────────────────────────────────────────────────────────────────┘
```
- Data: server `room` messages (`{t:'room', match, name, status, mapSize, slots:[{name,human,taken,…}]}`)
  — route through `GameBootstrap.OnOther` to `MainMenuView.ShowLobby(JObject room)`.
- Host creates the match via `HostMultiplayer(teamSize)` then **immediately** opens the Steam lobby
  (`ISocialPlatform.HostLobby(code, name)`), so friends can join from the overlay; "Invite Steam
  friends" re-opens the overlay invite dialog.
- **Start match** (host only) sends `{t:'start'}`; disabled until at least 2 humans are seated;
  the server also auto-starts when every human slot is taken. Non-hosts see "Waiting for host".
- Leave: disconnect, `ISocialPlatform.LeaveLobby()`, back to Multiplayer.
- Steam accept-invite while in menus or in another lobby → `JoinRequested(code)` → join flow, page
  switches to the lobby.

### B17. Loading, title card

Keep `ShowLoading` (centre-bottom strip) and `ShowTitleCard`. Remove everything related to the intro
cinematic (letterbox/caption/skip styles `SE.uss:224-228` if no longer referenced).

---

## C. Components, ownership and contracts (4 implementers, disjoint files)

### C0. File ownership

| Impl | Owns (only they edit) | New files |
| --- | --- | --- |
| **Impl-1 Shell** | `UI/Hud.cs`, `UI/Hud.Tooltips.cs`, `UI/Hud.Pickups.cs`, `UI/Hud.Command.cs`, `UI/Icons.cs`, `Resources/UI/SE.uss`, `Input/InputFacade.cs`, `App/GameSettings.cs` | `UI/UiKit.cs`, `UI/SettingsView.cs`, `UI/Hud.Shell.cs` (top bar, pause menu, toasts) |
| **Impl-2 Command** | `UI/Hud.Action.cs`, `UI/Hud.ActionContext.cs`, `UI/Hud.Overlay.cs`, `Session/Commander.cs`, `Session/Commander.Action.cs`, `Session/Commander.Rings.cs`, `Session/Commander.Groups.cs` | `UI/RadialMenu.cs`, `UI/Hud.Base.cs` (base/building/unit wheels, pickers), `UI/Hud.DefenseBar.cs`, `Resources/UI/SE.Command.uss` |
| **Impl-3 Map** | `UI/Minimap.cs`, `Session/ClientSession.cs` (CivColor/relation only) | `Resources/UI/SE.Minimap.uss` |
| **Impl-4 Menu** | `App/GameBootstrap.cs`, `App/GameBootstrap.Review.cs`, `App/GameBootstrap.MenuDistrict.cs`, `Social/SocialPlatform.cs`, `Steam/SteamInvites.cs` | `UI/MainMenu.cs`, `UI/GameActions.cs`, `UI/FieldGuide.cs`, `Resources/UI/SE.Menu.uss` |

Rules: no one edits another's file. Cross-file needs go through the contracts below; if a contract is
missing something, the owner adds it. Day-0 deliverables (merge first, small): Impl-1 `UiKit.cs` API
stubs + `Icons.cs` glyph names + `SE.uss` tokens; Impl-4 `GameActions.cs`; Impl-2 `RadialMenu.cs` API
stub. Others code against the stubs.

Stylesheets: `Hud` constructor (Impl-1) loads `UI/SE`, `UI/SE.Command`, `UI/SE.Minimap`, `UI/SE.Menu`
in that order (missing sheets are skipped). Each owner creates their own `.uss` (+ `.meta` via Unity).
Only `SE.uss` defines `:root` variables; others use `var(--se-…)`. Class prefixes: Impl-2 `.se-cmd-*`,
`.se-radial-*`, `.se-defensebar*`; Impl-3 `.se-minimap*`; Impl-4 `.se-menu-*`, `.se-lobby-*`.

### C1. Removals and moves inside Hud.cs (Impl-1)

- Delete `Hud.cs:12-36` (`CampaignOptions`, `IGameActions`) — Impl-4 recreates them verbatim plus
  additions in `UI/GameActions.cs`.
- Delete the menu region `Hud.cs:260-518` (BuildMenu, MenuPage, MainPage, MenuAction, CampaignPage,
  MultiplayerPage, Guide, GuidePage, ReviewMenuPage/ScrollEnd) and replace with the `MainMenuView`
  wiring (C4). `ShowMenu`/`MenuVisible` delegate to it.
- Delete `SettingsPanel`, `RefreshSettings`, `RebindStep`, `Setting`, `Toggle(VisualElement…)`, `Volume`
  (`Hud.cs:1707-1795`); `Panel()` case "settings"/"guide" construct `SettingsView` / `FieldGuide.Build`
  (legacy ruleset only).
- Delete the speed strip and old pause menu (`Hud.cs:585-641`) → new top bar + pause menu in
  `Hud.Shell.cs`.
- In `Build()`: rail is created only for the legacy ruleset; remove the `hint` box; feed/toast/banner
  positions per B3.
- Impl-2 deletes `ActionGuide` (`Hud.Action.cs:15-28`); Impl-4 moves its text into `FieldGuide.cs`.

### C2. `UiKit` (Impl-1, `UI/UiKit.cs`) — shared helpers

```csharp
namespace SE.Runtime.UI {
public static class UiKit {
    // elements
    public static VisualElement El(string cls = null, VisualElement parent = null);
    public static Label Text(string text, string cls = null, VisualElement parent = null);
    public static Button Button(string label, Action click, VisualElement parent = null, string icon = null, string cls = null); // no auto tooltip
    public static Button IconButton(string icon, Action click, string tooltip, VisualElement parent = null, int size = 36);
    public static Button Chip(string icon, VisualElement parent = null);            // .se-chip, 36 high, caller sets width
    public static Segmented Segmented(IReadOnlyList<(string id, string label, string icon)> items, string selected, Action<string> pick, VisualElement parent = null, int segmentWidth = 44);
    public static VisualElement SettingRow(string label, VisualElement control, VisualElement parent);
    public static Toggle Switch(bool value, Action<bool> set);                      // 44×24 custom switch (wraps UnityEngine.UIElements.Toggle with .se-switch)
    public static VisualElement SliderRow(float value, float min, float max, Func<float,string> format, Action<float> set, bool applyOnRelease = false);
    public static VisualElement CostRow(JToken cost, Func<string,int> have, VisualElement parent); // ▤ 150  ⚡ 30, red when have < cost
    public static ScrollView BoundedScroll(VisualElement parent);                  // replaces Hud.Scroll
    // colour
    public static Color RelationColor(ClientSession s, int owner);               // B5 palette
    public static Color Token(string name);                                      // C# mirror of SE.uss tokens for Painter2D users
    // escape/back
    public sealed class PageStack {
        public PageStack(VisualElement host);                                    // host content is replaced on navigation
        public void Push(string id, Func<VisualElement> build, bool wide = false);
        public bool Pop();                                                       // false at root
        public void Reset(string id, Func<VisualElement> build);
        public string Top { get; }
        public event Action<bool> WideChanged;                                   // frame adds/removes .se-frame--wide
    }
}
public sealed class Segmented : VisualElement { public string Value { get; set; } }
}
```
`UiKit.RelationColor` delegates to `ClientSession.CivColor` (Impl-3 makes that relation-aware) so there
is one source of truth.

### C3. Icons (Impl-1, `UI/Icons.cs`)

Add every glyph of section D under the exact names listed. Change `BuildingKind(type)` to return the
per-type glyph (`depot`→`processor`, `power_plant`→`generator`, `barracks`→`barracks`, `armory`→
`armory`, `motor_works`→`vehicle_works`, `heavy_weapons`→`heavy_weapons`, `airfield`→`airfield`,
`advanced_lab`→`lab`, `missile_silo`→`silo`, `town`→`hq`, `barricade`→`sandbags`, `guard_post`→
`guard_post`, `bunker`→`bunker`, `turret`→`at_gun`, `aa_battery`→`aa`, `sensor_post`→`sensor`,
`repair_point`→`repair`, `artillery_post`→`artillery`, `fort`→`fortress`, `city_turret`→`guard_post`;
legacy types keep current mapping). Add `public static void DrawAt(Painter2D p, string kind, Rect r,
Color c)` (alias of `Draw`) for RadialMenu/Minimap painters. Unknown names keep the circle fallback.
No PNGs are needed; every glyph is drawn with Painter2D.

### C4. Hud ↔ MainMenu contract (Impl-4 provides, Impl-1 calls)

```csharp
public sealed class MainMenuView : VisualElement {           // UI/MainMenu.cs
    public MainMenuView(IGameActions game, Func<VisualElement> settingsFactory);  // Impl-1 passes () => new SettingsView(game)
    public bool Visible { get; }
    public void Show(bool on, string status);                 // status null = keep
    public bool HandleEscape();                               // pop one page; false at root
    public void ShowLobby(JObject room);                      // server 'room' message
    public void ReviewPage(string id);                        // review captures: "root","skirmish","multiplayer","lobby","training","settings","guide"
}
public static class FieldGuide { public static VisualElement Build(bool actionRts); }  // UI/FieldGuide.cs, used by pause menu
```
Hud forwards: `public bool MenuVisible => mainMenu.Visible; public void ShowMenu(bool on, string status
= "")` (also calls `ShowGame(false)`), `public void ShowLobby(JObject room) => mainMenu.ShowLobby(room)`.
`Hud.Update`: if `MenuVisible` and Escape pressed → `mainMenu.HandleEscape()`; then return.

`IGameActions` additions (Impl-4, `GameActions.cs`; implemented in `GameBootstrap.cs`):
```csharp
void StartLobbyMatch();                 // host: send {t:'start'}
void LeaveLobby();                      // disconnect + platform LeaveLobby, ShowMenu
Social.ISocialPlatform Social { get; }
bool CanPause { get; }                  // single-player and Welcome.CanPause
void SetPaused(bool on);                // used by pause menu (Impl-1)
```
Remove `CampaignOptions.Tutorial` flow from the main page (Training page calls `StartCampaign` with
Tutorial=true as today).

### C5. Social platform (Impl-4)

```csharp
public interface ISocialPlatform {
    bool Available { get; } string Status { get; } string PlayerName { get; }
    void InviteFriends(string matchCode, string matchName);       // existing: create/reuse lobby + overlay
    void HostLobby(string matchCode, string matchName);           // create lobby, no overlay
    void OpenInviteOverlay();                                     // ActivateGameOverlayInviteDialog(lobby)
    void OpenFriendsOverlay();                                    // ActivateGameOverlay("friends")
    void LeaveLobby();
    IReadOnlyList<FriendSession> FriendSessions();                // cached, refreshed by RefreshFriends
    void RefreshFriends();                                        // SteamFriends.GetFriendCount(k_EFriendFlagImmediate) + GetFriendGamePlayed → m_steamIDLobby; RequestLobbyData; read se_game/se_match/name and member counts
    void JoinFriend(ulong lobbyId);                               // existing Join(CSteamID)
    event Action<string> JoinRequested; event Action Changed;     // Changed: status/friends list updated
    void Tick(); void Shutdown();
}
public struct FriendSession { public ulong LobbyId; public string FriendName, LobbyName; public int Members, MaxMembers; }
```
`None` implementation returns empty lists and no-ops.

### C6. Escape chain in a match (Impl-1 owns `Hud.Update`, calls others)

Order (stop at the first that consumes):
1. Settings rebinding active → `SettingsView` cancels it (it consumes Escape itself; Hud checks
   `SettingsView.Capturing`).
2. Commander consumed it this frame (`commander.EscapeFrame == Time.frameCount`: tool, battle line).
3. Pause menu open → `pausePages.Pop()`; at root → close (resume).
4. Pinned resource popover / observer popover open → close.
5. `CloseCommandContext()` (Impl-2, `Hud.Base.cs`): build/defense picker → wheel sub-ring → defense
   bar armed → wheel close. Returns true if it consumed.
6. Legacy side panel open → close.
7. `commander.ClearSelection()` (Impl-2, new) if anything is selected → consumed.
8. Open pause menu.

### C7. Hud ↔ Command contracts (Impl-2 provides, Impl-1 calls)

```csharp
// Hud.Base.cs (partial Hud)
void BuildCommandUi();                 // called once from Hud.Build() after topbar; creates wheel layer, defense bar, tool chip
void UpdateCommandUi(float time);      // per frame from Hud.Update (after Escape handling)
bool CloseCommandContext();            // C6 step 5
bool CommandUiCapturesDigits { get; }  // wheel hot / picker open / bar armed
void ShowCommandUi(bool on);           // from ShowGame
```
`Hud.Refresh` keeps calling `ActionCard(force)` (Impl-2) for the selection card; `ActionPanel` and
`ActionBuildPanel`/`ActionFieldMenu`/`ActionUpgradePanel`/`ActionOverview` are deleted by Impl-2, and
Impl-1 removes the `ActionPanel(force)` call in `Refresh` (`Hud.cs:807`). `ActionTopBar` moves from
`Hud.Action.cs:70-107` to Impl-1's `Hud.Shell.cs` (Impl-2 deletes it; Impl-1 recreates as `TopBarAction`).
`Hud.FlashResource(string res)` (Impl-1, public within Hud) is called by Impl-2 on "not enough" refusals.

Commander additions (Impl-2): `ClearSelection()`, `SuppressGroupKeys` (bool, checked in
`ControlGroups`), `HoverRingSlot` (int, drawn in `DrawActionOverlay`), `HoverRingSlotFromWorld`
(int, computed each frame from the cursor over own selected base parcels), `MinimapOrder(float x, float
z, bool queue)`, `BeginTrench()`/`BeginRoad()` wrappers. Remove `IdleUnits`/`NextIdle` from
`Commander.Groups.cs` after Impl-1 removes the caller.

### C8. RadialMenu API (Impl-2, `UI/RadialMenu.cs`)

```csharp
public sealed class RadialItem {
    public string Id, Icon, Title, Hotkey; public JToken Cost; public int Seconds;
    public Func<bool> Enabled; public Func<string> Reason;        // reason shown when disabled (or informational)
    public Func<int> Badge; public Func<float> Progress;           // 0..1 outer arc, <0 none
    public Func<bool> Active;                                     // green inner stroke (repeat on)
    public bool Confirm;                                          // two-step
    public Action<RadialClick> Click; public Action RightClick;
    public Func<IList<RadialItem>> Children;                      // sub-ring
    public float? Angle;                                          // fixed angle (base sockets); null = auto
    public Action<bool> Hover;                                    // world highlight hooks
}
public struct RadialClick { public bool Shift, Ctrl; }
public sealed class RadialMenu : VisualElement {
    public RadialMenu(Func<string,int> resourceHave);
    public void Open(string subject, string hubIcon, IList<RadialItem> items, Func<Vector2?> anchor, RadialItem hub = null, IList<RadialItem> outerArc = null, bool keyboardOpened = false);
    public void Close(); public bool Back();                      // Back: sub-ring → parent, else false
    public bool IsOpen { get; } public bool Hot { get; }
    public void Tick(float time, Rect safeArea, Vector2 minimapCentre, float minimapRadius);
    public Rect WheelBounds { get; }                              // for picker placement
    public float AngleOf(string itemId);                          // for picker side choice
}
```

### C9. Minimap contract (Impl-3)

Keep `FocusMap`, `ViewCorners`, `Tick(time)`, `Dispose()`. Add `public Action<float,float,bool> OrderAt`
(Impl-1 wires it in `Hud.Build` to `commander.MinimapOrder`), `public void Ping(int tile)`
(Impl-1 calls from `Notes()` for critical/major notes with a tile). Minimap reads
`session.Objectives`, `session.Structures.Buildings`, `session.Units` directly. Impl-1 removes
`.minimap*` from `SE.uss` (`SE.uss:186-188`) and the lens code (`Hud.cs:200-212`, `220`, `1565-1571`,
gate at `249`); Impl-3 styles in `SE.Minimap.uss`.

### C10. Hotkey table (Impl-1 updates `InputFacade.Actions`)

| Action id | Default | Change |
| --- | --- | --- |
| `idle` | Period | **remove** |
| `build` | B | relabel "Arm defense bar" (Impl-2 handles it) |
| `research` | R | relabel "Open Research (legacy)"; no action-mode toast |
| `overview` | O | legacy only |
| `commands` | C | **new** "Open command wheel" |
| `upgrade_base` | U | **new** "Upgrade base tier (base wheel open)" |
| `pause`, `faster`, `slower`, `alert`, groups, camera, `hold`, `withdraw`, `attack`, `follow`, `flip`, `back` | unchanged | — |

Wheel digits 1–8/0 and defense-bar digits are fixed (not remappable) and only active in their modes.

---

## D. Icon catalogue

Flat single-colour glyphs on a unit square (0,0 top-left → 1,1), drawn with the existing Painter2D
helpers (`Poly`, `Box`, `Circle`, `Line(width)`); `dark` = 45 % tint for cut-outs. Default tint
`--se-text`; resource icons use their resource colour. Stroke widths are fractions of the square.
Existing glyphs keep their names (units, `house`, `industry`, `farm`, `military`, `defense`, `road`,
`trench`, `research`, `army`, `build`, `overview`, `settings`, `city`).

| Name | Glyph (flat vector) |
| --- | --- |
| `materials` | three stacked planks: boxes (.12,.62)-(.88,.78), (.18,.44)-(.82,.60), (.24,.26)-(.76,.42); a dark vertical grain line .04 wide at x .3 and .7 on each plank. Colour (199,158,102) |
| `energy` | lightning bolt: poly (.58,.06) (.22,.56) (.46,.56) (.38,.94) (.78,.40) (.54,.40) (.66,.06). Colour (122,196,224) |
| `command` | three stacked chevrons (rank): polylines width .1: (.2,.38)(.5,.18)(.8,.38); (.2,.6)(.5,.4)(.8,.6); (.2,.82)(.5,.62)(.8,.82). Colour (150,196,146) |
| `queued` | hourglass: two triangles (.25,.15)(.75,.15)(.5,.5) and (.5,.5)(.75,.85)(.25,.85) |
| `tier_pip` | filled square .2-.8 (drawn by code at 6 px; not used via IconElement) |
| `pause` | two boxes (.26,.18)-(.42,.82), (.58,.18)-(.74,.82) |
| `play` | triangle (.3,.16)(.84,.5)(.3,.84) |
| `menu` | three boxes (.16,.22)-(.84,.32), (.16,.45)-(.84,.55), (.16,.68)-(.84,.78) |
| `close` | two lines width .1: (.24,.24)-(.76,.76), (.76,.24)-(.24,.76) |
| `back` | line (.78,.5)-(.24,.5) width .1 + polyline (.48,.24)(.22,.5)(.48,.76) width .1 |
| `more` | three circles r .08 at (.24,.5) (.5,.5) (.76,.5) |
| `plus` | two lines width .12: (.5,.18)-(.5,.82), (.18,.5)-(.82,.5) |
| `lock` | body box (.22,.46)-(.78,.88); shackle arc: stroke .09 arc centre (.5,.46) r .2 from 180° to 360°; dark keyhole circle (.5,.64) r .06 |
| `check` | polyline (.18,.52)(.42,.76)(.84,.26) width .12 |
| `invite` | person (head circle (.38,.3) r .14; shoulders poly (.12,.86)(.18,.58)(.58,.58)(.64,.86)) + plus at (.8,.36) two lines width .07 length .26 |
| `friends` | two persons as in `invite`, second offset +.26 x and 70 % size behind |
| `copy` | two outlined squares (stroke .07): (.18,.3)-(.62,.82) and (.38,.12)-(.82,.64) |
| `code` | `#`: lines width .08 (.38,.14)-(.3,.86), (.7,.14)-(.62,.86), (.16,.38)-(.86,.38), (.14,.64)-(.84,.64) |
| `steam_overlay` | `friends` glyph (no brand marks) |
| `skirmish` | crossed swords: lines width .08 (.18,.82)-(.82,.18), (.82,.82)-(.18,.18); guards: short lines width .08 perpendicular at (.3,.7) and (.7,.7) |
| `multiplayer` | globe: stroke .07 circle (.5,.5) r .36; meridian ellipse via two arcs; equator line |
| `training` | target: stroke .07 circles r .36 and .2, filled circle r .07 |
| `quit` | power: arc stroke .1 centre (.5,.54) r .3 from −60° to 240°; line (.5,.14)-(.5,.5) width .1 |
| `continue` | `play` |
| `guide` | open book: two polys (.1,.24)(.48,.3)(.48,.84)(.1,.78) and mirrored; dark spine line |
| `hq` | command building: base box (.14,.5)-(.86,.88), tower box (.38,.18)-(.62,.5), star poly (5 points) r .1 at (.5,.32) dark |
| `processor` (Materials Processor) | crate (.14,.4)-(.86,.86) + `materials` planks miniature on top (.3,.18)-(.7,.36); dark X on crate (lines width .05) |
| `generator` (Energy Generator) | cooling tower poly (.2,.88)(.3,.2)(.7,.2)(.8,.88); dark bolt (scaled `energy` .5) centred (.5,.58) |
| `barracks` | helmet: half-disc arc centre (.5,.58) r .34 (180°–360°) filled + brim box (.1,.56)-(.9,.64) |
| `armory` | shield poly (.5,.1)(.86,.24)(.8,.62)(.5,.9)(.2,.62)(.14,.24) + dark up-chevron (.32,.58)(.5,.4)(.68,.58) width .08 |
| `vehicle_works` | gear: filled circle r .3 + 8 tooth boxes (.1×.12) around it at 45° steps; dark hub circle r .12 |
| `heavy_weapons` | artillery shell: poly (.4,.88)(.4,.38)(.5,.12)(.6,.38)(.6,.88) + dark band box (.4,.66)-(.6,.72) |
| `airfield` | plane top view (`fighter` glyph rotated −90°) over runway line (.1,.9)-(.9,.9) width .06 |
| `lab` | atom: three ellipse strokes .05 r (.38,.14) at 0°, 60°, 120° (approximate with 24-segment polylines) + nucleus circle r .07 |
| `silo` | missile: poly (.5,.06)(.62,.24)(.62,.72)(.74,.88)(.26,.88)(.38,.72)(.38,.24) + dark window circle (.5,.36) r .05 |
| `sandbags` | five rounded bags: circles r .13 at (.2,.72)(.44,.72)(.68,.72)(.32,.5)(.56,.5) + box under each row to flatten |
| `guard_post` | watchtower: legs lines width .06 (.3,.9)-(.38,.42), (.7,.9)-(.62,.42); cabin box (.28,.22)-(.72,.42); roof poly (.22,.22)(.5,.08)(.78,.22) |
| `bunker` | half dome: arc fill centre (.5,.8) r .38 (180°–360°) + ground box (.08,.8)-(.92,.88); dark slit box (.32,.6)-(.68,.66) |
| `at_gun` | anti-armor: shield poly (.3,.34)(.48,.3)(.5,.7)(.3,.7); barrel line width .07 (.42,.48)-(.94,.42); wheel circle (.4,.76) r .12 |
| `aa` | two barrels up: lines width .07 (.4,.62)-(.6,.12), (.52,.62)-(.72,.16); base box (.2,.62)-(.8,.86) |
| `sensor` | radar dish: arc stroke .08 centre (.42,.46) r .3 from 200° to 340° rotated −30°; mast line (.5,.6)-(.5,.9) width .06; dot (.62,.3) r .05 |
| `repair` | wrench: line width .12 (.24,.78)-(.62,.4) + open-jaw ring: circle (.7,.3) r .17 with dark circle r .08 and dark notch box rotated |
| `artillery` | howitzer: `field_gun` glyph with barrel at 40° (line (.5,.48)-(.92,.12)) |
| `fortress` | crenellated tower: box (.2,.34)-(.8,.9); merlons boxes (.2,.2)-(.32,.34), (.44,.2)-(.56,.34), (.68,.2)-(.8,.34); dark gate arc at bottom centre |
| `rally` | flag: pole line (.3,.1)-(.3,.9) width .06; flag poly (.3,.12)(.8,.26)(.3,.42) |
| `move` | arrow: line (.18,.82)-(.74,.26) width .1 + head poly (.82,.18)(.5,.22)(.78,.5) |
| `attack_move` | `move` + small crosshair (circle stroke r .12 at (.3,.7), ticks) |
| `hold` | octagon (stop sign) poly, circumradius .38 centred (.5,.5); dark bar box (.28,.46)-(.72,.54) |
| `withdraw` | double chevron left: polylines width .1 (.6,.2)(.3,.5)(.6,.8) and (.84,.2)(.54,.5)(.84,.8) |
| `fortify` | spade: blade poly (.36,.5)(.64,.5)(.64,.74)(.5,.9)(.36,.74), handle line (.5,.1)-(.5,.5) width .07, grip box (.4,.08)-(.6,.14) |
| `detach` | two circles r .14 at (.3,.5), (.7,.5) with a broken link: short lines (.42,.5)-(.47,.5), (.53,.5)-(.58,.5) |
| `upgrade` | up chevrons: polylines width .1 (.2,.56)(.5,.26)(.8,.56) and (.2,.84)(.5,.54)(.8,.84) |
| `demolish` | hammer: head box (.2,.16)-(.62,.36) rotated 0, handle line (.42,.36)-(.74,.88) width .09 |
| `cover` (Take Cover) | helmet (`barracks`) lowered: arc r .3 at (.5,.7) + ground line |
| `scan` | radar sweep: stroke circle r .36; filled wedge poly from centre 0°–50°; dots |
| `bombard` | burst: 8 triangle spikes around circle r .14 at (.5,.5) |
| `focus_fire` | crosshair: stroke circle r .3, four tick lines from r .18 to r .44 |
| `intercept` | `aa` glyph + small plane silhouette at top right |
| `patrol` | circular arrow: arc stroke .08 r .32 from 30° to 330° + head at end |
| `strike` | down arrow onto ground: line (.5,.1)-(.5,.66) width .1, head poly (.3,.5)(.5,.8)(.7,.5), ground line (.2,.9)-(.8,.9) |
| `infiltrate` | eye with slash: almond poly + dark pupil circle + line width .07 (.18,.82)-(.82,.18) |
| `missile_launch` | `silo` glyph tilted 30° + exhaust triangle |
| `wheel` | radial: stroke ring r .34 width .1 with 4 dark gaps at 45°, 135°, 225°, 315°; dot centre r .08 |
| `target` (Go) | `focus_fire` |
| `observer` | eye (almond + pupil) |
| `defense` (bar group / Defenses command) | existing `defense` glyph |

---

## E. Defect walkthrough (file:line → fix)

Line numbers refer to the working tree on 2026-11-15.

| # | Location | Defect | Fix (owner) |
| --- | --- | --- | --- |
| 1 | `Hud.Command.cs:30` + `:40` | Idle button rendered **twice**: `B("Idle 0")` adds a child Label, then `idleButton.text = …` sets the Button's own text, so two strings draw. | Remove the idle button, `idle` action and `.idle-button` USS (`SE.uss:319-320`), `InputFacade.cs:57` (Impl-1); remove `IdleUnits/NextIdle` (Impl-2). Rule for everyone: never set `.text` on a `B()`/`UiKit.Button`; update its Label. |
| 2 | `Hud.cs:589-601`, `SE.uss:245-246` | Speed strip is a separate floating glass strip under the top bar; buttons toggle display per frame (`Hud.cs:622-623`) so the strip changes width; holds the ☰ menu button. | Dock into top bar as fixed-width segmented control + icon buttons (B2) (Impl-1). |
| 3 | `Hud.cs:596`, `:600`, `:193` | Glyph characters `❚❚`, `☰`, `▼` depend on font coverage (Barlow lacks most; fallback varies). | Use Painter2D icons `pause`, `menu`; tutorial pointer drawn as a triangle (Impl-1). |
| 4 | `Hud.Action.cs:72-77`, `:94-95` | Tier pill inserted at top-bar index 0 also holds "Restore command…/Objective held…" text; its width changes every few seconds and shoves the resource chips. | Remove pill; status moves to the centred fixed-width pill (B2); tier moves to base markers (Impl-1/Impl-2). |
| 5 | `Hud.Action.cs:101-107`, `:84-89` | Resource chips: text labels "Materials/Energy/Command" + colour dot, no rate on screen (rate only in tooltip, per minute); amounts have no fixed width → jitter. | Fixed-width icon chips with `+x.x/s` average rate (B2) (Impl-1). |
| 6 | `Hud.cs:166`, `Hud.Action.cs:97` | Invite button uses the `army` icon and sits after a `grow` row, drifting with content. | `invite` icon, right group (Impl-1). |
| 7 | `Hud.Action.cs:503`, `Hud.cs:1707-1755` | **In-game Settings broken:** in action mode `ActionPanel` calls `SettingsPanel()` straight into the 440-px panel with no ScrollView; ~40 rows overflow past `max-height: 78%` off-screen; default Unity `Slider`/`Toggle` field labels (unstyled theme, fixed label min-width) collide in 440 px; `.btn.close` (`SE.uss:61-64`, absolute 8/8) overlaps the "Settings" title; the controls list (`menu-list`, `SE.uss:312`, `flex-shrink:0`) cannot shrink. | Replace with shared `SettingsView` in an 880×720 frame with its own scroll pane and custom rows (B14) (Impl-1). |
| 8 | `Hud.cs:327`, `:1760-1764`, `:316` | Menu Settings swaps the `panel` field (hack); any button (quality, window, rebind) calls `RefreshSettings → MenuPage`, which rebuilds the page and resets scroll to 0 (`Hud.cs:316`) — the page jumps to the top on every click. Title duplicated ("SETTINGS" + "Settings"). | `SettingsView` updates rows in place; one title (Impl-1). |
| 9 | `Hud.cs:637-638` | Pause menu "Settings"/"Controls and field guide" close the pause menu and open the left side panel — a different component and the broken one (#7). | Push pages inside the pause frame (B13) (Impl-1). |
| 10 | `Hud.cs:636` | "Save" button only shows a toast. | Remove (Impl-1). |
| 11 | `Hud.cs:701` | Escape does nothing in the main menu (`Update` returns early when `MenuVisible`). | Route to `MainMenuView.HandleEscape()` (Impl-1/Impl-4). |
| 12 | `Hud.cs:358`, `SE.uss:220` | Main menu help line (`white-space: normal`, min-height 36) changes line count on hover → menu box height changes; status label `Hud.cs:330` also wraps. | Remove help line; status single-line ellipsis, fixed 28 px; frame height fixed (B15) (Impl-4). |
| 13 | `Hud.cs:318`, `SE.uss:213`, `:289`, `:309` | Title wraps (`white-space: normal`) and has three conflicting font rules; `.menu-wide .menu-title` shrinks it to 30 px on sub-pages → header height changes between pages. | Fixed title block (B15) (Impl-4). |
| 14 | `Hud.cs:351`, `:353` | "Continue" label changes to "Continue operation"; primary highlight switches item. | Static label "Continue"; disabled state with tooltip (Impl-4). |
| 15 | `SE.uss:211/287/297/308`, `217/291`, `118/271`, `121/134/286`, `213/289` | Duplicate, conflicting rules for `.menu-box`, `.menu .btn`, `.action-card`, `.action-resource`, `.menu-box .menu-title`; later rules silently override earlier ones. | Delete superseded blocks when moving styles to per-owner sheets (each owner for their section). |
| 16 | `SE.uss:298` | `.menu-scroll { max-height: 690px }` fixed px: at UI scale 1.6 the menu exceeds the viewport. | Frame uses top/bottom anchoring, content flex 1 (Impl-4). |
| 17 | `Hud.cs:181`, `:705-712` | Hint box at 30 %/30 % left/right (width varies with resolution); in action mode moved to `top: 58` where it overlaps the critical banner (`SE.uss:202`, top 54). Persistent mode hints ("Click a highlighted site…", "Choose a target · Enter confirms…") always on. | Toast below top bar, errors only (B3); remove mode hints (Impl-1; Impl-2 trims `ActionModeHint`). |
| 18 | `Hud.cs:110-120` + `Hud.Tooltips.cs:40` | Every `B()` button gets `DefaultActionTip(label)`, which falls back to returning the label itself → redundant tooltip identical to the button text on every hover. | `DefaultActionTip` returns null when no specific text; `UiKit.Button` sets no tooltip by default (Impl-1). |
| 19 | `Hud.cs:168-173`, `Hud.ActionContext.cs:34-54`, `SE.uss:281-285` | Left rail in action mode: only "Base"/Field construction visible; `UpdateActionRail` re-queries and re-sets tooltips 4×/s; `.compact-rail:hover .btn { width:118px }` expands over any open panel (panel left 76). | No rail in action mode (Impl-1); delete `UpdateActionRail` (Impl-2). |
| 20 | `Hud.Action.cs:465`, `:527`, `Hud.ActionContext.cs:53`, `:56-76` | "Field construction" buttons (unit details, build panel, rail tooltip) and the text-list Field menu. | Remove; defense bar + base wheel Defenses (B11/B7) (Impl-2). |
| 21 | `SE.uss:271-273`, `118` | Action card positioned by percentages (`left 26% right 21%`, tool card 30 %/27 %) → width varies with aspect; at 21:9 it is very wide, at 4:3 cramped. | Fixed width 600 centred (B10) (Impl-2). |
| 22 | `Hud.Action.cs:220`, `Hud.ActionContext.cs:126`, `:155-156`, `:99`, `:91-94`, `Hud.Action.cs:244`, `:274`, `Hud.ActionContext.cs:62`, `:113` | Verbose persistent text in cards (city tier line, site counts, opening advice, rotate hints, pickup instructions, field-menu explainer). | Remove; information moves to wheel readouts/tooltips (Impl-2). |
| 23 | `Hud.ActionContext.cs:224-225` | Air mission buttons show raw ids ("patrol", "return"). | Wheel sub-ring with titles and icons (Impl-2). |
| 24 | `Hud.ActionContext.cs:133`, `Hud.Action.cs:238` | `TierLabels[parcel.Tier - 1]` indexes −1 if a parcel reports tier 0. | Clamp like elsewhere (`Mathf.Clamp(t-1,0,2)`) (Impl-2). |
| 25 | `Hud.cs:249`, `:220`, `:1565-1571` | Minimap hidden in action mode; lens toggle and M key only in legacy mode. | Always-on circular minimap (B4) (Impl-1 removes gates, Impl-3 builds it). |
| 26 | `Minimap.cs:103` | All non-own units drawn red, including allies; units are single texels (≈1 px at 280 px width → invisible). | Relation colours, vector dots (B4) (Impl-3). |
| 27 | `Minimap.cs:73` | Height derived from the map ratio each texture rebuild; frame size changes with map. | Fixed 240 circle (Impl-3). |
| 28 | `Hud.Action.cs:639-643`, `Hud.Overlay.cs:123-124` | Markers and health-bar stripes use server civ colours: friendly not blue; enemy vs friendly base only differ by hue. | Relation palette via `CivColor` + shape-coded base badges (B5) (Impl-3/Impl-2). |
| 29 | `Hud.Action.cs:616` | Marker culling compares screen pixels to fixed 50/49 px (top bar height in panel units × scale), wrong at other resolutions/UI scales. | Cull in panel space against top bar bottom (56) and bottom band (92) (Impl-2). |
| 30 | `Hud.cs:1005`, `SE.uss:191` | Alerts feed bottom-left would sit under the new minimap; action mode keeps only 2 notes. | Move to left 16 / bottom 272, max 3 (Impl-1). |
| 31 | `SE.uss:316` | Command strip `bottom: 220px` assumes the (hidden) 200-px minimap; groups float mid-right. | Groups bottom-right (B12) (Impl-1). |
| 32 | `Hud.cs:1257` vs `Hud.Action.cs:502` | Close glyph inconsistent ("✕" vs "×"), both font characters. | `close` icon button 28 (Impl-1/Impl-2). |
| 33 | `Hud.cs:227` | Pressing R in action mode shows a toast "Select an Armory…" every time. | Remove (Impl-1). |
| 34 | `Hud.Action.cs:346` | "Batch ×N" cycling button changes label width and is hidden knowledge. | Shift = ×5 on train wedges; remove button (Impl-2). |
| 35 | `Hud.cs:900` vs `SE.uss:98`, `Hud.Tooltips.cs:85` | Tooltip placement uses magic 380/376 widths while the tooltip is 360 + padding. | Measure `tooltip.resolvedStyle.width` after layout (one-frame delay) (Impl-1). |
| 36 | `Hud.cs:600`, `Hud.cs:635` | Pause menu frame (`.pause-menu .menu-box { width:340 }`, `SE.uss:249`) inherits `.menu-box` rules (border-left accent, padding 25) meant for the main menu; height grows with items. | Own fixed frame class `.se-pause-frame` (Impl-1). |
| 37 | `Hud.cs:240-247` | `ShowGame` fades in top bar, rail and speed strip with a scheduled opacity flip; the rail/strip disappear in the redesign. | Fade top bar, defense bar, minimap, groups (Impl-1 calls `ShowCommandUi`). |
| 38 | `SE.uss:224-228` | Cinematic letterbox/caption/skip styles left from the removed intro. | Delete if unreferenced (Impl-1). |

---

## F. Acceptance checklist

Run at 1920×1080, 1280×720 and 2560×1080, UI scale 0.75 / 1.0 / 1.6.

**Top bar**
- [ ] Materials/Energy/Command chips are icon chips of fixed width; amount and `+x.x/s` visible; no
      horizontal shift when numbers change by an order of magnitude.
- [ ] Rate shows the 10 s average, includes recent pickups, never negative.
- [ ] Clicking a chip pins a breakdown; Escape/click elsewhere closes it.
- [ ] No tier element in the top bar; Command chip popover shows faction tier.
- [ ] Pause and Menu buttons are in the top bar; no separate strip exists.
- [ ] Speed control appears only in sandbox/spectate, fixed width, P/=/- work.
- [ ] No idle-units button anywhere; Period key does nothing.

**Minimap**
- [ ] Circular, bottom-left, 240 px; friendly blue, allies teal, each enemy a distinct hue.
- [ ] Bases are shape-coded (friendly circle, enemy diamond, neutral hollow ring — B4/B5); fog and camera footprint visible.
- [ ] Click/drag jumps the camera; right-click moves selected units; alert pings appear.

**Wheels and base**
- [ ] Clicking own HQ opens the base wheel; 8 sockets point toward their parcels; empty sockets glow;
      hovering a socket highlights its parcel and vice versa.
- [ ] Clicking an empty socket opens the picker with all 9 facilities, icons, costs, lock reasons;
      hover previews the building in the world; click starts construction.
- [ ] Hub upgrades the base tier and shows progress; tier pips visible on the base marker.
- [ ] Defenses/Perimeter/Rally/Production/Repair on the outer arc work.
- [ ] Clicking an own building opens its wheel (train with counts, upgrades, rally, repair).
- [ ] C opens the unit wheel; abilities show cooldown sweeps; digits 1–8 pick wedges only while the
      wheel is hot, otherwise recall control groups.
- [ ] >8 items page via More/mouse wheel; sub-rings return with Escape/right-click on hub.
- [ ] Wheels never overlap the minimap, defense bar or top bar.

**Defense bar**
- [ ] Bottom-centre, 11 icon buttons with costs; locked ones show tier and reason.
- [ ] B then digit starts placement; active tool button is highlighted; tool chip shows cost, Q/E,
      close; invalid reason appears at the cursor only when invalid.
- [ ] No "Field construction" button exists anywhere (rail, cards, panels).

**Menus**
- [ ] Main menu frame size is identical on every root page and never changes on hover or status text.
- [ ] Escape goes back exactly one level in main menu, Skirmish, Multiplayer, Lobby, Training,
      Settings, pause menu and its sub-pages.
- [ ] Entry points: Continue, New Skirmish, Multiplayer, Training & Extras, Settings, Quit; no intro.
- [ ] Multiplayer: host lobby (Steam lobby created, invite overlay opens), join friend list, join by
      code, spectate by code; lobby shows code + copy, slots update live, host Start works.
- [ ] Settings is the same component in main menu and pause menu: same size, tabs, scroll; changing a
      value does not rebuild or scroll the view; rebinding works and Escape cancels it.

**Text and polish**
- [ ] No persistent hint text in match; toasts show refusals; success spam suppressed.
- [ ] No button shows a tooltip identical to its own label.
- [ ] Every defect in section E is fixed or explicitly deferred with a reason.
- [ ] `GAME_DESIGN.md` § Interface updated for the bottom defense bar and radial command UI.
