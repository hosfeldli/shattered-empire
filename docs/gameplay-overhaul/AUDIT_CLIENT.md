# Client audit: current state against the overhaul requirements (2026-11-17, read-only)

Paths are relative to `unity/Assets/ShatteredEmpires/Runtime/`. Section numbers refer to the directive.

| Req | State | Notes and code locations | Smallest change |
|---|---|---|---|
| §11–12 Base menu and pads | **Exists** | Empty pad → base wheel → facility sub-ring (`Commander.Rings.cs:SelectActionRing/SelectRingSlot`, `Hud.Base.cs:SocketFromSelection/FacilityItems`). Occupied pad or building → building wheel with upgrades, training, rally, repair, demolish. Base wheel = tier upgrade + 7 socket wedges + perimeter. Build wheel (B) = field builds | Pad hover works without the base selected; pick radius scales with zoom; base wheel focuses on upgrades and status |
| §7–9 Production UI | Partial | Wheel wedges: click 1, Shift ×5, right-click cancel last, Ctrl repeat. Selection card queue icons are not clickable. No queue states (`BuildingRecord.Why` unused) | Clickable card slots, a "Clear" button, queue-state lines |
| §19–21 Hotkeys | Partial | Arrow scheme: A = attack-move (double-tap selects on-screen combat units), Ctrl+A = army plus attack-move. WASD scheme: A pans. No select-all or building-type hotkeys | `select_local` / `select_all` actions; building-category selection |
| §22 Rally | Partial | Right-click with production selected, wheel item, or attack-move rally. Shift+click is additive selection | Shift+click a barracks → rally placement mode |
| §23 Formation preview | Exists | Right-drag polyline with server dry-run positions every 0.32 s; instanced; F flip, Alt advance, Shift queue | Immediate client-side placeholder slots before the server reply |
| §27/36 Rings | Partial | Engineer uses the squad ring size (0.6). Buildings get fixed 1.02 corner brackets | Ring size per type; size from `BUILDINGS[type].radius` |
| §35 Team accents | Partial | Authored models and sockets have them; recipe facilities (armory, lab, airfield, silo, heavy weapons) have flags only | Team panel or roof band |
| §37 Icons | Partial | UI glyphs; ground glyph on sockets; none on field defenses | — |
| §38 Pickup rings | Missing | Pickups are crate modules baked into chunks | Ground ring baked in `MaterialsPickup` |
| §39 Cursors | Partial | System, attack and blocked only | Context cursor at ~10 Hz: move, attack, collect, capture, build, garrison, invalid |
| §40 Click-away | Partial | Escape chain is fine. A right-click order passes through an open wheel; left-click doesn't close the dock wheel | `Hud.ConsumedWorldClick`, skip that frame in Commander |
| §33 HUD / minimap | Partial | Bars overlap the 240 px minimap bezel by 7–15 px; income-only EMA; Command shows used/cap +queued | Chord-fit offsets; net and consumption rates; Power/Units naming |
| §28 Terrain tools | Partial | 3 separate paths (legacy hex drag, road/trench stroke, brush) with different cancel/Shift rules; road/trench show no stroke total | Unify Shift-keep and right-click-drops-stroke; stroke cost |
| §42–43 Speed | Partial | Speed control only for spectators or sandbox; no vote | Server vote command + `Hud.SpeedVote.cs` |
| §16–18 Capture / garrison | Capture UI exists; garrison missing | `Hud.Action.cs:SiteBadge/SiteCard` | — |
| §45 Updater | Partial | Banner on the main menu only, "Update now / Later"; relaunches | "Update and Restart" label plus a session note |
| §34 Differentiation | Mixed | Authored models: town, barracks, depot, motor_works, power_plant, all defenses. Recipes look alike | Distinct elements and team accents on recipes |

## Per-frame allocation to fix while touching these files
- `Commander.Update`: `RemoveAll` closure, `new List<int>`, `.Any` lambda.
- `DrawActionOverlay`: JArray enumeration every frame.
- `TrainItem.Hosts()`: LINQ at 10 Hz.

## File ownership for parallel client work

| Owner | Files |
|---|---|
| A: HUD | `Hud.Shell.cs`, `Hud.Console.cs`, `Minimap.cs`, `Hud.Command.cs`, `UpdateBanner.cs`, `Updater.cs`, the USS, and new `Hud.SpeedVote.cs` |
| B: Base / production | `Hud.Base.cs`, `RadialMenu.cs`, `Commander.Rings.cs`, `Hud.Action.cs` |
| C: Controls / tools | `InputFacade.cs`, `SettingsView.cs`, `Commander.cs`, `Commander.Action.cs`, `Commander.Orders.cs`, `Commander.Terrain.cs`, `Commander.Groups.cs`, `Commander.Markers.cs`, `Hud.DefenseBar.cs` |
| D: Visuals | `UnitRenderer*.cs`, `CityRenderer.*.cs`, `Icons.cs`, and new `Commander.Selection.cs` / `Commander.Cursor.cs` (one-line hooks from C) |

Hotspots that need a single owner:
- `Commander.cs` and `Commander.Action.cs`: C.
- `Hud.cs`: A.
- `Hud.Base.cs`: B.
- `InputFacade.cs`: C.
- `SE.uss`: A.
- `CityRenderer.cs`: D.
