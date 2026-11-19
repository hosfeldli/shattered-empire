# AI operations: captures, task forces and strategic strikes (2026-11-18)

**User report:**
- "It has a hard time conquering territories sometime and will just keep moving through them over and over."
- "The AI also attacks through the same path for the entire game, never spreads out troops or coordinates attacks and instead just streams troops in a direction over and over again."
- "In the late game, the AI doesn't attempt to use nuclear bombs to break stale mates."

**Files:**
- `server/sim/actionAIOps.js` (new): captures, pickets, corridors, task forces, raids, the strategic programme.
- `server/sim/actionAI.js`: hooks only. The objective state machine is unchanged: Expanding, Attacking, Final Assault, Defending, hunting.
- `tools/ai-ops-probe.mjs` (new): the measurement harness behind every number below.
- `test/ai-operations-2026-11-18.test.js` (new).

## How it was measured
`node tools/ai-ops-probe.mjs all 1,2,3 30` runs AI-only matches headless: 17 maps × 3 seeds, 30 min, normal difficulty, personalities rotating. The "before" run used `--sim=<snapshot>`, a `git archive` of HEAD 8e6bfef.

The probe measures each civ by watching the world, not the AI's internals:
- **Zone entries ("passes"):** times its capture-capable infantry entered a neutral or hostile capture zone.
- **Captures:** entries that ended with the site flipped.
- **Abandoned:** entries left with the site not taken.
- **Repeat sites:** (civ, site) pairs entered three or more times.
- **Axes:** for every enemy base it fought at, the unit-seconds its troops spent 3–11 units out in each of 8 compass sectors. Reported as sectors holding ≥12 % and as the share of the busiest sector.
- **Failed operations:** "Operation ended" notes.
- **Silos, missiles built and launched, own units in the blast.**
- **Bases held** at minutes 8 / 16 / 24.

## Root causes (with numbers)

### 1. Capture: troops walk through zones (before: 44 % of zone entries ended in a capture)
Before: 1,896 entries, 826 captures, 1,056 abandoned. 142 (civ, site) pairs were entered three or more times. An entry lasted 8.4 s on average; a city takes 20 s.

Traced cases (crossroads seed 2, civ 1 at Eastyard, minute 16):
- **Chase on the way in.** The capture squad got an exact attack-move onto the centre (`approach(..., 'assault')`). Attack-move units with a goal chase any foe within range + 2.6 (`stanceStep`). Squads 0.2–1 from the centre were drawn 2.5–5 out of a 1.35-radius zone. Progress reached 4.8 s, then decayed (R7: no grace, full decay in 15 s). The AI re-issued the same approach and the cycle repeated: 5 entries in 60 s, never captured.
- **Cover shuffle.** Units under fire step up to 0.65 to cover (`seekCover`), which crosses the zone edge from anywhere near it.
- **"Occupied" meant one squad near the centre.** That squad had no hold order. Once it was pulled away, the next approach went to whichever five capture units came first in the troop list, often ones far away.
- **The army was never told to capture.** Columns marching through outposts and ruins (not the objective) produced 11 of 18 abandoned entries in that match: nobody ever stopped.
- The capture decay rules (`actionCapture.js`) are not at fault. They behaved exactly as R7 specifies.

### 2. One axis, streamed (before: 71 % of the fighting at an enemy base came from one 45° sector)
- `planActionAI` ran one operation: one target, one troop list.
- Every reinforcement got the same `moveGroup(target)`, so it walked the shortest route from home in ones and twos.
- The only variation was one flank waypoint at 68 % of the way, offset 3.8, taken once per operation. Its side depended only on `civ.id % 2`, so every operation of a civ bent the same way.
- There was no memory of earlier axes.

### 3. No strategic strikes (before: 0 silos and 0 missiles in 51 matches)
- `missile_silo` appeared only in the build list of `research` cities. Even there it was the 5th of 6 entries, behind an Advanced Systems Lab that the main base's list never reached (9 entries for 7 slots).
- The missile (1440/1140 since this morning) was built only with spare funds, which an AI never has: energy sits near 0–200 all game.
- Tier III (1000/600), needed for the silo, was rarely bought: the AI spends energy on units as it comes in.
- There was no notion of a stalemate.

## Design

### Capture that sticks: `secureSite`
- Capture-capable infantry inside 78 % of the zone get a `hold` order (`braced`). A braced squad does not chase on an attack-move, does not shuffle to cover and is not shoved by passing units. It still fires at anything in range.
- More squads are brought in until 3 hold a city, or 2 an outpost. Far away they attack-move. Within 3.4 they get an exact plain `move` to the centre, so nothing can draw them off the last few metres.
- Escorts clear contesters (enemies within the radius + 2.4) first. Otherwise they screen the zone 2.3 out, toward the nearest enemy.
- The operation's stall timer counts uncontested holding as progress.
- **Pickets** (`managePickets`, every 6 s):
  - A capture squad of the AI within 3.2 of a free or hostile outpost or ruin detaches one squad to take it, unless enemies nearby outweigh it. The site must not be the operation's own objective.
  - A captured objective keeps one squad as a picket: 45 s for an outpost, or until the headquarters stands (at most 100 s) for a city.
  - Limit: easy 1, normal 3, hard 4, expert and brutal 5, and never more than 1 + army/12.
  - An overrun picket is let go.
- The ruin left by a destroyed headquarters is taken with the same routine, by every assault unit at hand.

### Task forces: `runOperation`
- **Corridors.** Rally points stand 5.5–8.5 from the objective, on bearings 0, ±40°, ±75° and ±110° from the home line. Each is snapped to standable ground and kept only if infantry can reach it from home (the nav's connected regions).
  - Score: detour length, plus 3 per known enemy emplacement within 4.5, minus 1.5 on a road.
  - Penalty: up to +9 for an axis within ~35° of one used in the last 15 minutes against this target or near this rally (`p.axisLog`).
  - Up to N rallies are picked at least 55° apart.
  - Wide flanks (≥ 72°) go round through a stage point first, so they do not walk the main axis and turn at the end.
  - Cached 2 minutes per (home, target, count).
- **Forces:**

  | Difficulty | Assault axes | Raiders | Home reserve |
  |---|---|---|---|
  | Easy | 1 | never | none |
  | Normal | 2 (army ≥ 14) | only once the enemy turtles: a failed assault, or 4+ emplacements near the target | 10 % |
  | Hard | 3 (army ≥ 30) | always (army ≥ 18) | 10 % |
  | Expert, brutal | 3 (army ≥ 30) | always (army ≥ 18) | 12 % |

  - Assault units are dealt by composition, so each axis gets armour, infantry and support: main 60 / flank 40, or 48 / 30 / 22.
  - A unit that cannot reach a rally because a river cuts it off goes to home duty instead.
- **Muster, then step off together.**
  - Each force marches to its own rally, remembering per unit whether it has passed its stage or rally.
  - The march is an attack-move. Only a wide flank's leg from its stage round the objective to its rally is a plain move, so that column is not drawn into the defences it bypasses. Plain moves on every axis cost fights: 7 of 15 subset matches ended inside 30 min, against 10 of 15 with attack-moves.
  - The march toward the objective counts as operation progress: the nearest member, or the force's mean distance, closing in. A force ordered on to the objective is re-ordered when its members still walk toward their rally. Without this, launched forces parked at their rallies for minutes.
  - The operation launches when every force has 65 % of its founding members at the rally, or at the muster limit (30 s + 1.15 × the longest march, at most 150 s).
  - Each force then steps off at `now + (longest ETA − its ETA)`, so the axes reach the objective together.
- **Fighting.**
  - Each force runs the existing siege logic (defenders first, then emplacements, then the headquarters) with its own timers.
  - A force beaten back (outmatched 1.85×) regroups at its rally while the others carry on. After two setbacks a flank folds into the main thrust.
- **Reinforcements** join the force whose rally is nearest, weighted toward under-strength forces. They are routed stage → rally → objective, so they arrive along their force's axis instead of trickling down the shortest route.
- **Retargeting and variety.**
  - Failed assaults (bounded end or withdrawal) are counted per target (`p.failedAt`). Target ranking adds 9 per failure and 1.5 per known emplacement within 6, so the AI turns to the next weak point.
  - An operation interrupted by a defence resumes with its forces and corridors if it returns to the same target within 2 minutes.
- **Raiders** (`runRaid`):
  - They capture enemy-held (and distant neutral) outposts, or attack the Materials Processors and Energy Generators of a lightly held enemy base.
  - Never within 7 of the main objective, and never into more than 1.1× their strength.
  - They pull back from a fight 1.3× against them, and the site is avoided for 3 minutes.
- **Rivers** (NAV_BRIDGES: no bridges at match start; infantry wade, vehicle orders needing a bridge are refused with `code: 'bridge'`):
  - Vehicles that cannot reach their axis (the nav's per-class regions) go on home duty. Infantry, and whatever can reach, lead.
  - `bridgeToward` orders an engineer road with bridges through NAVIGATION's `roadRouteBetween(game, civ, from, to, { preview })`, under player rules:
    - It previews first and checks the cost against the bank (the strategic reserve + 120).
    - Orders are deduped per target (`p.roads['op:<id>' | 'site:<id>']`). An ordered road is not re-planned for 10 minutes.
    - A refusal backs off 90 s, 180 s and so on, up to 8 min.
    - When the far end is refused (hostile, unseen or other players' ground, or too long), it bridges 60 %, then 35 % of the way.
  - This is done for attack axes (home → main rally) and for expansion targets.
  - When the crossing opens, vehicles parked on home duty beyond the reserve's quota join the main thrust ("Bridge open: the armour joins the attack.").
  - A `bridge` refusal is never counted as a stalled approach.

### Strategic strikes: `strategicProgram`
- **Stalemate:** after `nukeAfter`, any of the following:
  - no base anywhere has changed hands for `frontStall`;
  - `failures` failed assaults on one target;
  - forces at parity (0.7–1.45× the strongest enemy force seen recently), with the front quiet for half of `frontStall`, after `nukeAfter + 4 min`.
- A declared stalemate holds for 3 minutes (hysteresis).

| Difficulty | `nukeAfter` | `frontStall` | `failures` | Launch cooldown |
|---|---|---|---|---|
| Easy | 40 min | 10 min | 3 | 8 min |
| Normal | 22 min | 7 min | 2 | 5 min |
| Hard | 19 min | 5.5 min | 2 | 4 min |
| Expert | 17 min | 4.5 min | 2 | 3 min |
| Brutal | 17 min | 4 min | 2 | 2.5 min |

These started 4 minutes earlier in the first version. With the programme banking from minute 12, brutal armies at minute 24 were 19 units against 35 before, and only 2 of 17 brutal matches ended.

- **Preparation.** A front quiet for half of `frontStall`, or one failed assault, already buys Tier III and the Advanced Systems Lab, from surplus only: it banks nothing.
- **Programme**, each step banked by `buildArmy` (the step's price is held back while the army is at least min(28, 80 % of its floor), including while defending a raid), with upgrades, depot upgrades, wall upgrades and new bases paused:
  1. Tier III on the main base (`advanceBase`).
  2. An Advanced Systems Lab at the base chosen as host: one within missile range of a known enemy headquarters, research cities first.
  3. The Strategic Missile Facility (`construct`). If no ring site is free, one duplicate facility is demolished (barracks first), as a player would. `buildArmy` leaves the host's free sites alone meanwhile.
  4. `missileBuild`, then `missileLaunch`.
- **Targets:**
  - Known enemy headquarters: worth 700 + 250 × tier, +1200 when it is the stalled operation's objective, +500 per failed assault.
  - Massed armies in view: clusters of 6+ ground units, valued at their cost.
  - Plus the enemy units and structures inside the 2.7 blast.
  - The threshold is 1400 in a stalemate and 2400 otherwise.
  - The point must be explored and in range.
- **Never into own troops.** A point with any own or allied unit or building within 3.7 (blast + 1) is rejected, with one exception: the operation's own troops at its own objective. They are pulled back to their rallies first (`p.nuke.aim` holds the assault), and the launch waits until the area is clear.
- **Follow-up.** After a launch at the objective, the forces re-muster and step off so that they arrive just after impact (`goAt = impact − 0.6 × ETA`).

### Cost and determinism
- No randomness: ties break on ids and site order.
- Per planning tick the work is O(own units + seen enemies + sites).
- Corridors are cached. Region checks reuse the nav's cached components. Known defences are refreshed at most every 10 s.
- `test/ai-operations-2026-11-18.test.js` checks that the same seed plays out identically.
- Group orders over 24 members are routed over consecutive ticks (`game.groupJobs`). Nothing here depends on a member starting to move in the same tick:
  - captures re-check holders every planning tick;
  - `advance` re-issues at most every 8 s.
- **Defence recalls keep a capture alive.** A capture past half way keeps its holders (`p.keepCapture`) while the rest of the army defends. Before this, a raid on home pulled squads off a ruin at 14–17 of 20 s.

## Before / after
Paired runs on the same working tree (2026-11-18 evening, including NAVIGATION's bridge removal, AI WORKS and server perf):
- **Old AI:** HEAD's `actionAI.js` plus the AI WORKS hook lines.
- **New AI:** this change.

Command: `node tools/ai-ops-probe.mjs all 1,2,3 30 --sim=<snapshot>`, normal difficulty (51 matches each), plus `all 1 30 --difficulty=brutal` (17 each).

| Normal, 51 matches × 30 min | Old AI | New AI |
|---|---|---|
| Zone entries | 1,795 | 1,649 |
| Captures completed | 845 | 1,438 |
| Capture rate (captures / entries) | **47 %** | **87 %** |
| Abandoned entries | 937 | 197 |
| Seconds in zone per entry | 8.9 | 13.4 |
| (civ, site) pairs entered ≥ 3 times | 126 | 66 |
| Share of fighting from the busiest 45° sector at an enemy base | 0.70 | 0.62 |
| Sectors ≥ 12 % per enemy base fought at | 1.95 | 2.27 |
| Task forces per operation (time-weighted, incl. reserve/raid) | 1 | 1.8 (up to 4) |
| Failed operations | 197 | 105 |
| Matches ended within 30 min | 29 | 31 |
| Mean match length | 26:33 | 25:51 |
| Bases per civ at 8 / 16 / 24 min | 1.95 / 2.33 / 2.47 | 2.10 / 2.67 / 2.95 |
| Army per civ at 8 / 16 / 24 min | 20.4 / 28.3 / 34.1 | 19.9 / 28.2 / 32.4 |

| Brutal, 17 matches × 30 min | Old AI | New AI |
|---|---|---|
| Capture rate | 48 % | 88 % |
| Matches ended within 30 min | 9 | 7 |
| Bases per civ at 8 / 16 / 24 min | 1.87 / 2.32 / 2.60 | 2.05 / 2.68 / 2.74 |
| **Army per civ at 8 / 16 / 24 min** | 19.1 / 26.8 / **33.0** | 18.6 / 25.6 / **21.7** |
| Missile facilities built | 0 | 4 |

**Strategic strikes** need a late stalemate, so 30-minute runs barely reach them. Two runs went longer:
- Hard difficulty, 48 min, crossroads / quarry_highlands / continental_divide × seeds 1, 3, an earlier build of this change: 11 silos, 5 missiles built, 2 launched, **0 own units in any blast**.
- Before the change: 0 silos, 0 missiles in every run, at any length.

The forced-stalemate test launches within 7 minutes of game time.

**Brutal army at minute 24 is 34 % smaller**:
- From minute 16 on, brutal's stalemate programme banks for Tier III, the lab, the silo and the missile.
- It does so whenever its army is above 80 % of its floor.
- AI WORKS also reported brutal armies 27–30 % smaller from minute 20, so the two effects overlap.
- Tuning knobs: `PROFILES.brutal.nukeAfter` (actionAIOps.js), and the `min(28, 0.8 × floor)` bank threshold in `buildArmy`.

**Tuning history behind these numbers** (15-match subset fjordmark, iron_basin, mirefen_gap, three_crowns, twin_rivers × 3 seeds; old AI 12 / 15 ended):

| Version | Ended | What changed |
|---|---|---|
| First version | 6 | |
| Stalemate programme off | 8 | |
| Single axis | 7 | so splitting was not the cause |
| Attack-move marches | 10 | |
| All fixes | final 31 / 51 vs 29 / 51 | the stall timer now counts the march; a launched force is re-ordered past its rally; a Final Assault folds the reserve and raiders in; preparation banks nothing; the programme starts 4 min later |

## Balance pass (2026-11-18)
**Problem:** with AI WORKS and AI OPERATIONS together, brutal fielded fewer troops than the old AI from minute 16 (26.1 / 23.7 against 26.8 / 33.0). The cause was traced with `tools/ai-ops-probe.mjs` plus per-civ samples:
- **Energy, not materials, caps a late AI.** Income runs at about 20–35 materials/s against 4–7 energy/s. Facilities idled with 1500–3000 materials in stock.
- **The programme's bank blocked every unit.** The energy reserve applied to units that cost no energy, so while saving 600 energy for Tier III nothing was trained at all.
- **Brutal declared a stalemate almost always.** `failures: 1` after minute 16 put 119 of 128 brutal civs into the programme, saving 6.8 min each by minute 30. Yet across 51 matches it built 4 silos and no missile: AI WORKS spent the banked energy.
- **Hard AIs never got there.** In 48-minute stalemates they sat on 3000 materials for 20 minutes but never held the 600 energy of Tier III, because they bank only above an army of 28.

**Changes** (`actionAI.js`, `actionAIOps.js`):
- **The bank holds energy only against units that cost energy.** Rifle squads and militia keep coming while the missile's energy is saved.
- **Energy is banked once the materials are.** Any AI whose stock holds the step's materials plus 400 banks the energy from 60 % of its floor.
- **Every AI keeps producing while it banks.** It also does so always for brutal: an idle facility trains its most under-represented role even over that role's share. If nothing fits, a barracks turns the materials surplus into rifle squads (`FILL_MARGIN` 150 above the reserve).
- **Brutal banks only at its full army floor**, not at min(28, 80 %).
- **Brutal's programme takes a step only with its army at 90 % of the floor** (`PROFILES.brutal.armyGate`). Its `nukeAfter` is 17 min (was 16, now equal to expert) and its `failures` is 2 (was 1).
- **Brutal invests in its economy first.** It buys Materials Processor and Energy Generator upgrades (+40 % output) every 5 s, even below its floor and while the programme saves. Each upgrade pays for itself in about two minutes.
- **AI WORKS:** see AI_WORKS.md, "Balance pass". It keeps the programme's reserve, and brutal keeps 300 materials and 350 energy in stock for production.

**Results:** `node tools/ai-ops-probe.mjs all 1,2,3 30 --difficulty=brutal` (51 matches); normal `all 1 30` (17 matches). "Before" is today's tree before this pass, run from a frozen copy with `--sim`. Old AI is the table above.

| Brutal, 51 matches × 30 min | Old AI | Before | After |
|---|---|---|---|
| **Army per civ at 8 / 16 / 24 min** | 19.1 / 26.8 / 33.0 | 19.2 / 26.1 / 23.7 | **20.7 / 34.9 / 31.6** |
| Capture rate | 48 % | 86.7 % | 85.4 % |
| Bases per civ at 8 / 16 / 24 min | 1.87 / 2.32 / 2.60 | 2.06 / 2.70 / 2.80 | 2.06 / 2.60 / 2.62 |
| Field defenses at 16 / 24 min (armed) | – | 3.1 (1.6) / 9.3 (4.7) | 1.8 (1.1) / 3.6 (1.8) |
| Trench hexes at 16 / 24 min | 0 | 11.5 / 27.6 | 6.1 / 14.6 |
| Minutes in the programme's bank per civ | – | 6.8 | 1.7 |
| Silos / missiles built / launched (matches with a launch) | 0 / 0 / 0 | 4 / 0 / 0 | 10 / 6 / 3 (3) |
| Own units in a blast | – | – | 0 |
| Matches ended within 30 min (mean length) | 9 of 17 | 21 (26:57) | 30 (26:15) |

| Normal, 17 matches × 30 min | Old AI (51 matches) | Before | After |
|---|---|---|---|
| Army per civ at 8 / 16 / 24 min | 20.4 / 28.3 / 34.1 | 20.1 / 28.3 / 32.2 | 20.1 / 28.3 / 32.3 |
| Capture rate | 47 % | 86.7 % | 86.5 % |
| Field defenses / trench hexes at 24 min | – | 5.6 / 16.1 | 5.4 / 16.1 |
| Matches ended within 30 min | – | 10 | 11 |

| 48-minute stalemates | Before | After |
|---|---|---|
| Hard, crossroads / quarry_highlands / continental_divide × seeds 1, 3 (6 matches): silos / built / launched | 1 / 0 / 0 | 7 / 3 / 1 (1 match) |
| Hard: matches ended within 48 min | 5 | 4 |
| Hard: army at 32 / 40 / 48 min | 25.1 / 30.6 / 36.9 | 33.4 / 39.0 / 49.1 |
| Brutal, the same 3 maps plus twin_rivers, fortress_pass, serpentine, three_crowns × seeds 1, 3 (14 matches): silos / built / launched | 5 / 6 / 5 (2 matches) | 9 / 6 / 4 (2 matches) |
| Brutal: matches ended within 48 min | 6 | 12 |
| Own units in a blast | 0 | 0 |

**Reading:**
- **Long brutal matches still launch, but fewer reach a stalemate.** Before, brutal spent about 17 minutes per civ in the programme's bank over 48 minutes and its matches ground on. After, 12 of 14 brutal matches end within 48 minutes. The 2 that stall still launch 4 missiles.
- **Hard AIs now reach the missile.** Before, 1 silo was built in 6 hard matches and no missile.
- **Brutal is the strongest AI again:** +34 % at minute 16, –4 % at minute 24 against the old AI, and +33 % against this morning's tree at minute 24.
- **The minute-24 figure counts only matches still running.** Brutal now ends 30 of 51 matches within 30 min (old AI 9 of 17), so the survivors at minute 24 are the long grinds. The strongest civ per match fields 51.3 / 49.0 units at minutes 16 / 24, against 35.3 / 35.4 before. Per seat, with dead and finished seats counted as 0, minute 24 goes from 17.0 to 20.1.
- **Normal is unchanged against this morning's tree.** It is within 1.5 % of the old AI through minute 16 and –5 % at minute 24, as it was before this pass.
- **Single runs vary by about ±1.5 units at minute 24**, even with 51 matches.
- **Knobs, in order of effect:** `AI_WORKS.keep[4]` (army ±2 at minute 24 between 150 and 350 energy); the eager economy upgrades; `PROFILES.brutal.nukeAfter` / `failures` / `armyGate`; `FILL_MARGIN`.

## Coordination notes
- **AI WORKS** (`actionAIWorks.js`) used to spend energy down to 0, eating the energy the strategic programme banks. Done in the balance pass below: its budget keeps `p.nuke.reserve` (materials and energy) while the programme saves.
- **NAVIGATION:** `roadRouteBetween` is wired in (`bridgeToward`). The lookup is at runtime, through a namespace import.

## In-game checklist (Watch AI)
Use the plan panel (`actionPlan` notes) and watch for each of the following:
1. **Expansion.** A squad reaches a ruin and stays: it stands still (braced) in the ring until "secured". Progress should rise steadily without decaying, and escorts should stand 2–3 out facing the enemy. No column should cross a zone repeatedly.
2. **Passing columns.** When an army walks past a free outpost, one squad peels off, takes it and stays for about 45 s.
3. **Attacks.** Normal and harder AIs log "2-axis assault on X" (hard: up to 3). Before the attack, groups gather at separate points around the target, 6–8 out and at least 55° apart. A flank swings wide through a stage point rather than following the main column.
4. **Simultaneous arrival.** The groups hit within a few seconds of each other. The later "Attacking at X" against the same base should come from a different direction.
5. **Reinforcements** walk to their force's gathering point, not straight at the enemy base.
6. **Raiders** (hard and up, or normal against a turtle): "Raiders sent to …". A small fast group goes for an outpost or a processor elsewhere, and is "pulled back" if it meets a superior force.
7. **Home reserve.** A few units stay just outside the main base during an attack.
8. **Stalemate** (normal: 18+ min with a quiet front or failed assaults): "Stalemate (…): strategic strike programme". Then:
   1. Tier III;
   2. "Advanced Systems Lab under construction";
   3. "Strategic Missile Facility under construction", possibly after "Cleared a ring site";
   4. "Strategic missile under construction";
   5. "Strategic strike on <base>".

   Check:
   - the AI's own troops stand back at their rallies when the missile lands;
   - the assault follows within ~10 s of the impact;
   - there is no second launch before the cooldown.
9. **Rivers:** "N vehicles cannot cross the river; infantry lead the attack", then "Engineers ordered to bridge the river (k bridge segments)". Base engineers build the road. Afterwards: "Bridge open: the armour joins the attack". A river should never leave tanks idling on the bank for long, or ordered there again and again.
