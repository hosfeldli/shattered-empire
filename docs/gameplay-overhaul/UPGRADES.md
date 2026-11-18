# Upgrades: one per unit class (2026-11-18)

**User decision:** each player may take **one upgrade per unit class** per match.

**Code**
- `server/sim/actionDefinitions.js`: `ACTION_UPGRADES[key].line`, `UPGRADE_LINES`
- `server/sim/actionBases.js`: `upgradeLineHolder`, `startUpgrade`, `cancelUpgrade`
- `server/sim/actionGame.js`: the `research` and `cancelResearch` commands
- `server/sim/actionAI.js`: the AI's upgrade pick

**Tests:** `test/upgrade-lines-2026-11-18.test.js`.

## Mapping

| Upgrade | Facility | `line` |
|---|---|---|
| `infantry_training` (Infantry Training) | Armory | `infantry` |
| `grenades` (Hand Grenades) | Barracks | `infantry` |
| `rocket_teams` (Rocket Teams) | Barracks | `infantry` |
| `body_armor` (Body Armour) | Barracks | `infantry` |
| `marksmen` (Designated Marksmen) | Barracks | `infantry` |
| `heavy_armor` (Heavy Armor) | Armory | `vehicle` |
| `field_engineering` (Field Engineering) | Armory | `vehicle` |
| `aircraft_systems` (Aircraft Systems) | Armory | `air` |
| `improved_logistics` (Improved Logistics) | Armory | none (unrestricted: affects every reinforcement) |
| `networked_command` (Networked Command) | Armory | none (unrestricted: affects every unit and structure) |

The `air` line has a single upgrade today, so the rule does not restrict it yet. Future air upgrades should be given `line: 'air'`.

## Rule
- A line is **taken** for a civ when that civ has researched an upgrade of the line, or has one in progress at any of its buildings.
- A `research` of another upgrade in a taken line is refused.
- Re-researching the same upgrade keeps the old refusals ("That upgrade is unavailable." / "This upgrade is already in progress.").
- **Cancelling** an upgrade in progress frees its line.
  - The cost was paid in full when the research started, and it is **not refunded** (R2).
- **Old saves** that already hold several upgrades of one line keep all of them (grandfathered). The rule is only checked when a research starts. Such a civ cannot start any further upgrade of that line.
- **AI:** `actionAI` skips every upgrade whose line is taken, so it takes exactly one per line. Which one it takes is its existing priority: barracks kit first, then the armory's, in definition order.

## Commands

| command | reply |
|---|---|
| `research { tech, id? }` | Success: plain ack. Refusal: `{ t:'ack', error, code:'upgrade_line_taken', reason:'upgrade_line_taken' }`. Example text: "Your infantry already follow the Hand Grenades path: one upgrade per unit class." (vehicles / aircraft for the other lines) |
| `cancelResearch { tech }` | **New.** `{ t:'ack', cancelled: { tech, lost: { materials, energy } } }`. Refusal: `code: 'not_researching'`. |

## Wire
- The upgrade definitions reach the client in the welcome `defs.TECHS` (that is `ACTION_UPGRADES`). Each restricted entry now carries `line` (`'infantry' | 'vehicle' | 'air'`). An entry without `line` is unrestricted.
- `defs.RULESET.upgradeLines: true` and `defs.RULESET.cancelResearch: true` advertise the rule and the new command.
- The client can derive "taken" from the civ's researched techs plus the in-progress projects it already receives. It should grey out the other upgrades of a taken line with the refusal text.

## Client UI (workstream U, 2026-11-18)

Code: `UI/Hud.Base.cs` (`TechItems`, `UpgradeLineHolder`, `CanCancelResearch`, `UpgradesItem`), `UI/Hud.Shell.cs` (the Upgrades list in the army popover), `Core/Protocol/ProtocolDecoder.cs` (`UpgradeLine`, `UpgradeLineName`). `line` is read from `defs.TECHS[key].line`. The definitions are raw JSON on the client, so nothing else needs parsing.

**The Upgrades sub-ring (Armory / Barracks wheel) shows each line as a fork.**
- **Line badge.** Every upgrade with a `line` carries its line as micro text under the icon ("Infantry", "Vehicle", "Air").
- **Taken line.** A line is taken by a researched upgrade (econ `techs`) or one in progress (econ `research`), the same as the server's `upgradeLineHolder`. While a line is taken, its other upgrades are disabled: dimmed, with the lock glyph. They read "Locked · Infantry path: Hand Grenades · one upgrade per unit class", and a click only flashes that reason.
- **Before choosing.** The centre circle says "Permanent choice: your only infantry upgrade this match, the other infantry upgrades lock · …". The wedge is a two-step `Confirm`: the first click arms it ("Confirm · Hand Grenades") and a second click within 4 s starts it. Unrestricted upgrades (no `line`) start on one click as before.
- **The chosen upgrade** says "Infantry path · …", and "Infantry path · complete" once done.
- **Cancelling.** Shift + right-click on an upgrade in progress sends `cancelResearch` (only when `RULESET.cancelResearch`). The toast says what was lost and that the path is free again.
- **Other text.** The Upgrades wedge says "one upgrade per unit class (infantry, vehicle, air) per match" when `RULESET.upgradeLines` is set. The army popover lists researched upgrades with their path, for example "Hand Grenades (infantry path)".
- **Refusals.** A server refusal `upgrade_line_taken` (from a stale client) toasts the server's text.

**Funds:** research is paid in full when it starts (`startUpgrade` calls `affordable`). It does not queue without funds, so the wheel keeps its affordability gate for upgrades. Only unit production is cost-advisory.
