# Gameplay overhaul: workstreams, ownership and status

**Audits:**
- Server: [AUDIT_SERVER.md](AUDIT_SERVER.md) (summary below).
- Client: [AUDIT_CLIENT.md](AUDIT_CLIENT.md).

## Decision log
- **2026-11-17, R3 Infantry (user decision).** Squads stay single simulated entities. They do not split into one server entity per soldier.
  - The audit measured that a split would multiply ground entities 3–5×. Late matches would go from about 190 to 550–1,000 entities, with navigation already over budget in production.
  - Instead, squads get **more soldiers per unit** and a **better per-soldier simulation** inside the squad: discrete casualties, blast casualties and per-man firing. Server cost per squad stays O(1).
  - This replaces the directive's "N independent entities per batch".

## Server audit summary

**Already in place**
- Two stockpiles: materials and energy. There is no "Power" capacity model.
- A command-capacity population cap, with queued items reserving capacity.
- Pads at 3/5/7 by tier (+2 per upgrade).
- Capture: grace of 3.5 s, then decay at 1.45 s per second.
- Interception only by `aa_battery`, at missile impact, with 38% odds.
- Roads, trenches and defenses can be placed on neutral ground.

**Missing or different**
- Production is paid in full up front, refunds 100% on cancel, uses one FIFO queue (8 entries) per building, and refuses queueing without resources or capacity.
- No garrison.
- No speed vote; speed is sandbox-only.
- Forest is a biome only: tanks cannot clear it.
- Storms do not affect aircraft.
- Terrain works are allowed on own territory only.

## Workstreams

| WS | Scope | Owns (writes) | Hooks into the performance agent's files | Status |
|---|---|---|---|---|
| W1 Economy and production | R1, R2, §5–9, §7–8, production AI | actionBases.js production and economy functions; actionDefinitions.js production fields; actionAI.js production section; new tests | Small Edit hunks in actionGame.js `econSnapshot` and `command()` only | Implemented, tests pass |
| W2 Construction, territory, capture | §12–14, R7 capture decay, neutral non-defensive builds, placement leniency, terrain works on neutral ground | actionBases.js placement functions (`placeableBy`, `constructDefense`); actionEngineers.js; actionMap.js capture constants; capture section of actionAI.js | `captureStep` constants in actionGame.js (small hunk) | Implemented, tests pass |
| W3 Squads, combat, world | R3 (decision above), unit balance, R5 forest clearing, storms and mountains for air, anti-missile §44 | `ACTION_UNITS` and `SQUAD_MEN` stats in actionDefinitions.js; actionUpgrades.js; actionCombat.js; battlefield.js; actionAir.js | none | Implemented, tests pass; client squad sizes and garrison hiding wired by lead |
| C-A HUD | §33, §45, speed UI shell | `Hud.Shell.cs`, `Hud.Console.cs`, `Minimap.cs`, `Hud.Command.cs`, `UpdateBanner.cs`, `Updater.cs`, USS | — | Implemented, compiles; runtime check pending |
| C-C Controls | §19–22, §23 placeholder, §28 tool unification, §40 click-away | `InputFacade.cs`, `SettingsView.cs`, `Commander*.cs` (except the Selection/Cursor partials), `Hud.DefenseBar.cs`, `Hud.Base.cs` (click-away hook only) | — | Implemented, compiles; runtime check pending |
| C-D Visuals | §27, §34–38, §39 cursors | `UnitRenderer*.cs`, `CityRenderer.Facilities/Rings/Authored.cs`, `Icons.cs`, new `Commander.Selection.cs` and `Commander.Cursor.cs` | — | Implemented, compiles; runtime check pending |
| C-B Base and production UI | §11–12 pad UX, production queue UI (W1 contract), capture/garrison UI | `Hud.Base.cs`, `Hud.Action.cs`, `RadialMenu.cs`, `Commander.Rings.cs` | — | Implementing |
| W4 Garrison, speed vote, HQ capture | R4, R6 | new actionGarrison.js, speedVote.js; worker.js; actionGame.js; actionOrders.js skip | Small hunks in actionCombat.js, persist.js, actionDefinitions.js (building fields) | Implemented (garrison and speed vote; see CAPTURE_AND_GARRISON.md and MULTIPLAYER_RULES.md) |

**Rules for every workstream**
- Preserve the uncommitted performance work in the tree.
- Use Edit-tool hunks only, never whole-file rewrites, in shared files.
- No commits.
- Run `npm test` for server work.
- Client compile check: each agent uses its own copy of the type-check project (see the brief).
