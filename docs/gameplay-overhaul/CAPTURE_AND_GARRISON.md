# Capture and garrison

## Capture (W2, requirement R7)

**Code:** `server/sim/actionCapture.js` (`captureStep(game, dt)`, extracted from `ActionGame.captureStep`, which now delegates to it). The scheduler runs it every 2 ticks (dt 0.2 s), one spatial query per site (O(sites)).

**Constants:** `actionDefinitions.CAPTURE = { base: 20, outpost: 12, decay: 15 }`, published as `RULESET.capture`. Each site has its own `captureTime`, set from `CAPTURE` when the map is built (`actionMap.js`, and `actionEngineers.foundBase` for founded bases). Saves made before this change keep their stored 16 s / 10 s.

| Situation | Rule |
|---|---|
| Uncontested claimant in the zone | Progress +1 per second. A city ruin falls after **20 s**, an outpost after **12 s**. Progress starts at 0, so a capture never completes on entry. Only eligible ground units count: infantry that is not artillery, not the automatic engineers. |
| Nobody claiming (withdrawn, or only the owner's troops present) | Progress **decays at once, with no grace period**, at `captureTime / 15` per second. Full progress reaches 0 in **15 s** (ruin 1.33/s, outpost 0.8/s). At 0 the claim is cleared (`by = -1`). Returning before then continues from the remaining progress. |
| Contested (ground units of more than one team in the zone) | **Frozen: no gain and no decay.** The owner gets a "contested" notice at most every 18 s. |
| A different, non-allied claimant arrives | It first **drains** the previous claim at the decay rate. While it drains, `by` stays the old claimant and `decaying` is true. Once the claim reaches 0 it builds its own from 0. Example: taking over a ruin left at 50% costs 7.5 s + 20 s. |
| An allied claimant arrives | It continues the existing progress (unchanged). |
| Site with a headquarters | Never captured here (unchanged; HQ capture is W4). |

**Why there is no grace period:** R7's invariant requires progress to fall strictly on every step whenever nobody is capturing. A 15 s full decay is already forgiving: a squad that steps out for 2 s loses only 2.7 s of a 20 s capture.

**Wire (`siteWire`, per visible site):** `capture` (0–100 %), `by`, `contested`, and the new **`decaying`** (true while progress fell in the last step, including a rival draining your claim). Remembered (fogged) sites send `decaying: false`. The client can show a draining bar when `decaying` is true and a paused bar when `contested` is true.

**AI (`actionAI.js`, expansion branch):** while its capture troops hold an uncontested zone it does not own, the operation's stall timer is refreshed, so the AI stays until the site falls. A contested stalemate still ends after the usual 85 s bound.

**Tests:** `test/capture-decay.test.js` (directive Test G) and `test/action-rts.test.js`.

## Garrison (W4, requirement R4)

**Code:** `server/sim/actionGarrison.js`. Data is `GARRISON` plus the building fields `garrison` and `firingSlots` in `actionDefinitions.js`, published as `RULESET.garrison` and in `defs.BUILDINGS`. The changes elsewhere are small:

- `actionCombat.js`: occupants are not targets; only firing-slot holders shoot; the shelter blast.
- `actionOrders.unitMotion`: skips occupants.
- `actionGame.js`: commands, `sees`, snapshots, ejection in `removeBuilding`, and a `garrison` scheduler step every 2 ticks.
- `persist.js`: restore keeps occupants out of the indexes.

**Tests:** `test/garrison.test.js` (directive Test D) and `test/garrison-entry-2026-11-18.test.js` (the client's exact commands on real map structures).

### Data

| Structure | `garrison` (squads) | `firingSlots` |
|---|---|---|
| Headquarters (`town`) | 4 | 2 |
| Outpost (`fort`) | 4 | 3 |
| Bunker (`bunker`) | 2 | 2 |
| Watchtower (`guard_post`) | 1 | 1 |
| Barracks (`barracks`) | 3 | 0 (shelter only) |

`GARRISON = { reach: .9, protection: .6, rangeBonus: .6, fireBonus: 1.15, ejectDamage: .3 }`

### Rules

- **Who can enter:** capture-capable infantry squads only: rifle squad, militia, anti-armor, special forces and exo infantry. Vehicles, artillery (mortar teams), aircraft and the automatic engineers are refused. Each squad takes one slot. The structure must be your own, finished and alive.
- **Entering:** `garrison` sends the squads toward the structure with a normal group move. Squads already within `radius + reach` enter at once. The others enter on arrival: within `radius + .9`, or `radius + 1.7` if they halted at their slot. Squads beyond the free capacity are refused; squads already walking in count against it. A walker that stops short, or gets any field order, drops the garrison order.
- **While inside:** `u.inside = buildingId`. The unit sits at the structure's position. It is not in `movers` (no movement, collisions or capture counting) and not in `targets` (it cannot be shot directly). `sees()` hides it from rivals. It still counts once for population and army value. It still gives vision from the structure's position, with its own vision radius.
- **Protection:** direct fire hits only the structure. A blast (mortar, artillery, bombs, missiles, grenades) that damages the structure also hits every occupant for **40%** of the blast damage (60% protection). The normal damage rules then apply: squad casualties, armour and cover.
- **Firing:** only the first `firingSlots` living occupants, in order of entry, fire. They fire from the structure, with their own weapon, **+0.6 range** and **×1.15 damage**, and need a clear line of sight from the structure (its own walls never block it). An explicit attack target is preferred while it is in reach. Hold fire keeps them silent unless they are ordered to attack. Occupants never chase, take cover or set up. The other occupants are sheltered and silent. The structure's own weapon fires as before.
- **Leaving:** `ungarrison`, or any field order (move, capture, attack, withdraw, deploy, collect) given to an occupant, places the squad beside the structure. `hold` keeps it inside. If the structure has an exit rally point, squads that leave through `ungarrison` move there.
- **Destruction:** when a structure is removed, its occupants are placed around it. This covers destruction, demolition, and the facilities that go when a base's headquarters is lost. If the structure was destroyed (hp 0), each occupant loses **30% of its max HP**, and a squad below that dies (counted as a casualty).
- **Ownership:** structures never change owner in this ruleset (a headquarters is destroyed and becomes a ruin), so there is no capture-with-occupants case. Units can only enter their owner's structures.
- **Save:** `u.inside`, `u.enter`, `b.garrison` and `b.exitRally` are plain fields and persist. Restore leaves occupants out of `movers` and `targets`, and rebuilds the queue of walkers from `u.enter`.
- **AI:** the AI does not garrison yet (no `garrison` command in actionAI.js / actionAIWorks.js). Its army counts and threat estimates are unaffected, because it never sees rival occupants.
- **Performance:** occupants leave the movement and combat loops. Only firing-slot holders do a target search. The scheduler step costs O(squads walking in).

### Wire contract (for C-B)

**Commands**

| Command | Effect / reply |
|---|---|
| `{c:'garrison', units:[ids], building:id}` | `{garrison:id, entered, moving, refused}`. Errors: "Only infantry squads can garrison structures.", "That structure is full.", "That structure cannot be garrisoned.", "The structure is not finished yet.", "Select one of your structures." |
| `{c:'ungarrison', building:id, all:true}` | All occupants step out. |
| `{c:'ungarrison', building:id, units:[ids]}` | Only those occupants step out. `building` may be omitted when `units` is given. Reply `{ungarrisoned:n}`, or the error "Nobody is inside." |
| `{c:'garrisonRally', building:id, x, z}` | Sets the exit rally point. `{c:'garrisonRally', building:id, clear:true}` (or no point) clears it. Reply `{}`. |

**Definitions:** `welcome.defs.BUILDINGS[type].garrison` and `.firingSlots` for the eligible structures. Eligible units are the `defs.UNITS` entries with `capture: true` and no `auto`. `defs.RULESET.garrison` holds the `GARRISON` constants.

**Econ, per building:** these fields are only on your own buildings (and in the spectator god view).
- `gar: [unitIds]`: occupants in entry order. The first `firingSlots` of them fire. Absent when empty.
- `ge: [x, z]`: the exit rally point. Absent when not set.

**Units snapshot:** an occupant keeps its normal row, with these differences:
- flag bit **16384** (`unit[8]`) means inside.
- `x`/`z` are the structure's position.
- the row is sent only to the owner, allies and the god view. Rivals never receive it.

The client should hide the model of a unit whose flag bit 16384 is set, and list it in the structure's occupant panel from `gar`.

### Fix 2026-11-18: "the troops never actually garrison, they just go over to the building"

**Root cause (client).** Right-clicking one of your own garrisonable structures with infantry selected showed the
Garrison cursor (`Commander.Cursor.EvaluateHover`), but the right-click itself (`Commander.Action.ActionContextOrder`)
had no garrison branch. It fell through to a plain `{c:'move', point}` onto the structure. The server moved the
squads next to the structure (the footprint is blocked) and did nothing else. A `move` also clears `u.enter`, so it
cancels a garrison walk that was already under way. Only the unit wheel (Garrison > structure) sent `garrison`.

**Server path checked, and not at fault.** `garrisonCommand` → `moveGroup` to the structure → `garrisonStep` every 2
ticks enters within `radius + reach` (+0.8 once halted) → `u.inside`, flag 16384, econ `gar`. Headless runs on real
structures entered every time: the HQ, a bunker, a watchtower and a parcel barracks, approached from 8 directions on 4
seeds, with mixed selections including a tank. The near-goal arrival logic and stuck recovery did not interfere. The
decoder reads `gar`, and UnitRenderer hides flagged units.

**Fixes**
- `Commander.Action.cs` adds `GarrisonOrder`. A right-click on an own, finished garrisonable structure sends
  `{c:'garrison', units:[eligible], building}`, the same command the wheel sends. The rest of the selection (vehicles,
  mortar teams) gets the ordinary move to the structure. The reply is shown: "2 moving in to garrison" or "1 inside,
  2 moving in", plus "· N turned away" when it is full. Refusals are shown by `Resolve`.
- `Commander.Cursor.cs`: the Garrison cursor now uses the server's eligibility (`capture && !auto && !air`), so
  mortar teams alone keep the Move cursor. It also adds the shared helpers `GarrisonEligible`, `GarrisonTarget` and `SplitGarrison`.
- `Commander.cs` `ScreenOf`: garrisoned squads can no longer be picked. Before, clicking a garrisoned structure
  selected the hidden squad at its centre instead of the structure.
- `Commander.Rings.cs` adds `DrawGarrisonPips`. Each own garrisonable structure shows one pip per place on its camera
  side: a filled blue disc for each occupant and an empty ring for each free place. The pips show on any structure with
  occupants, and on every one in view while eligible squads are selected.
- `Hud.Overlay.cs`: no health bars for hidden occupants.
- Card and wheel hints now mention the right-click.
- `actionGarrison.js`: a garrison order for squads that are all already inside says "Those squads are already inside."
  instead of the infantry-only message.

### In-game checklist
1. Select 2–3 rifle squads about 10 hexes from your HQ. Hover the HQ: the cursor is the blue Garrison cursor and empty
   pips appear in front of it. Right-click: the toast says "N moving in to garrison". The squads walk over and disappear,
   and the pips fill in.
2. Click the HQ: the HQ is selected (not a hidden squad). The card shows "Garrison · n/4 · …" with occupant chips.
3. Do the same with a bunker (2 places): send 3 squads. The toast says "· 1 turned away". Right-click it again with
   the leftover squad: the toast says "That structure is full."
4. Select a mortar team alone and hover the bunker: you get the Move cursor. A tank plus squads: the squads enter and
   the tank parks beside the structure.
5. Unit wheel > Garrison > pick a structure: the same result.
6. Card "Eject all", or right-click a chip: the squads reappear beside the structure (or walk to the exit rally point).
   Selecting an occupant from a chip and right-clicking the ground also brings it out.
7. Shell a garrisoned bunker with enemy mortars: the occupants take reduced damage. Destroy it: they are thrown out, hurt.
