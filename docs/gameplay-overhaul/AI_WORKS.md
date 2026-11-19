# AI works: defenses, trenches and perimeters (2026-11-18)

**User report:**
- "The AI doesn't build defenses as it should."
- "In the late game, the AI ... doesn't construct defenses and trenches as it should."

**Before this change:**
- The action-mode AI placed one emergency watchtower or anti-armour emplacement when a base was attacked, and only if no field structure already stood within 4 of it.
- It bought a base perimeter only while in the Defending state.
- It upgraded perimeters to level 2 only with a 500-materials surplus.
- It never dug a trench.

**Now:**
- `server/sim/actionAIWorks.js` gives every AI base a defense plan along its threat axes.
- It digs connected trench lines in front of bases, at forward outposts and on fronts that have stopped moving.
- It upgrades field defenses and perimeters.
- A wallet pays for all of it: a share of income that scales with phase, threat and difficulty.

## Hook-up
In `actionAI.js`, the AI OPERATIONS agent's file, there are exactly three lines:
- the import;
- `aiWorks(game, civ, bases, owned, enemy, p)` right after `developBases(...)` in `planActionAI`, so it runs every plan tick (2–4.2 s) after the army has queued its production;
- the body of the Defending branch's emergency block, replaced by `aiEmergencyWorks(game, civ, defended, vanguard, enemiesNearHome, p)`, which sets `p.defenseAt`.

**Commands used:** every structure goes through the player commands, so the server validates it exactly as it would a player's order:
- `constructDefense` with a dry run first (`preview = true`), as `developBases` does for a New Base;
- `trenchLine`, a three-point stroke with a dry run first;
- `fortifyBase`, `upgradeDefenses` and `upgradeBuilding`.

**What the placement rules enforce:**
- own or neutral ground;
- defenses offset from roads, except sandbag barricades;
- the 2-hex snap;
- the ×3 surcharge beyond the ring of influence;
- trench hexes skipped on bridge and causeway decks, bases and other players' land. Under the 2026-11-18 rule (TRENCHES.md, "Trenches and roads"), a road hex is dug as a covered crossing. A base line across an axis that follows a road therefore crosses it and stays one work; the road stays open to vehicles.

**State:** `p.works` on the AI plan. It is plain JSON, so it is saved with the match and shown in the god-view `actionPlan`:
- `wallet`, `spent`, `built`, `dug`;
- `attacks`: recent attack bearings per site, at most 16, kept for 10 minutes;
- `bases[siteId].axes`: the cached threat axes;
- `front`, `frontLines`;
- `armor`: decaying count of enemy vehicles seen.

## Design

### Threat axes (per base, cached)
Each candidate bearing from the base gets a weight:

| Source | Weight |
|---|---|
| Known enemy base, or presumed: an unscouted rival capital | 2.2 × min(1, 24 / distance) |
| Recorded attack direction (where hostile ground troops came within 7 of the site) | 1.7 × e^(−age / 300 s) |
| Road leaving the base (road hex at hex distance 4) | 0.6 |
| Contested border: hostile territory within 8 hexes, per 60° sector | 0.12 per hex, max 1.5 |
| Nothing known | Toward the map centre, 0.5 |

**Clustering:**
- Bearings within 0.62 rad (about 35°) merge into one axis, keeping the sources (`kinds`) and the first road hex.
- Axes kept: 1 / 2 / 3 / 3 / 4 (easy → brutal).
- A road-only axis is kept only for hard and above, unless it is the main axis.

**Anchor:**
- The defense line stands 4.4 from the base centre, plus 0.45 per tier above I. That is just outside the perimeter lots (3.0–3.7) and inside the territory.
- **Chokepoints:** the first one along the axis, sampled every 1.1 from 4.4 to 11, moves the anchor forward to 0.9 short of it (up to 8.8). A chokepoint is either:
  - a bridge (a river hex with a road), or
  - a passable hex whose 2-hex neighbourhood is at least 40% water, lake, river or mountain (a pass, a valley mouth or a causeway).
- A chokepoint farther out (still 0.5 or more beyond the anchor) can take one forward strong point at ×3 cost. This needs all of the following:
  - the main axis;
  - hard or above;
  - an `enemy` or `attack` source;
  - the price is at most 60% of the wallet.
- Nothing else ever pays the surcharge.

**Recompute:**
- every 120 s per base, at most two bases per pass;
- at once for a new base;
- at once when an attack comes from a bearing that no axis covers.

### Defenses per axis
**Quota per axis:**
- On the main axis: 1 / 2 / 3 / 4 / 5 (easy → brutal); one fewer on the other axes, minimum 1.
- **Phase:**
  - Before minute 10: at most 1 (2 for expert and brutal).
  - Minutes 10–15: one fewer.
  - From minute 18: one more for hard and above.
- An axis attacked within the last 3 minutes gets one more.
- **Base cap** (armed structures within 11): 2 / 4 / 7 / 9 / 11, plus 2 from minute 18, plus 1 under attack. Outposts other than the main base get 60% unless attacked.

**Mix (build order along the axis):**
- **Era I:** watchtower first, then bunkers, then a fourth watchtower.
- **Era II and later:** a bunker first for hard and above. Against armour (two or more enemy vehicles seen recently) every second slot is an anti-armour emplacement, and at least one per axis. A turret also covers a missing bunker.
- **Once per base:**
  - an AA battery from era II against recent enemy air (`p.enemyAir` ≥ 1.5);
  - for expert and brutal, from minute 15, an artillery emplacement behind the main axis.
- **Road on the axis:** a sandbag barricade on the road itself (normal), two for hard and above, from minute 6.

**Placement:**
- Spots: the anchor and lateral offsets ±1.25 and ±2.5.
- Each spot is dry-run first. The server snaps it within 2 hexes and keeps it off roads.
- A spot is refused if the snap lands it against another field structure of ours.
- Per pass: at most 8 dry runs and 2 orders (3 for expert and brutal).
- No new orders while 2 + (number of bases) structures are still unbuilt, because the engineers can only build so much.

**Rebuild:** a lost structure drops its axis under quota and is replaced on a later pass. The engineers repair damaged ones on their own.

### Trenches
- **In front of bases:**
  - One line across the main axis, 1.3 beyond the anchor. A second axis gets one from minute 15 for hard, and always for expert and brutal.
  - A line is dug once a defense on that axis is finished, the base has been attacked, or it is past minute 15.
  - Length: 4 / 5 / 5 / 6 hexes (normal → brutal), +1 from minute 15. Easy digs none here.
  - If the ground is rough, it tries 0.8 nearer and 0.9 farther out.
  - If the stockpile is short it digs a 3-hex stub. `trenchRoutes` joins strokes drawn up to an existing trench, so the next stroke extends it into one work.
  - A base trench that is funded but not affordable holds the rest of that pass's planned defenses, so the line is not starved by cheaper structures.
- **Forward positions:**
  - The 2 outposts closest to an enemy base (3 for expert and brutal, within 34) get a 3–6-hex line 2.2 toward the enemy.
  - Hard and above also put a bunker there (an anti-armour emplacement against armour).
- **Stalled fronts:**
  - The front is the centroid of our ground troops in contact: at least 3 within 6.5 of visible enemy ground troops, more than 6 from our sites. Failing that, it is the committed troops of an operation that has made no progress for 30 s.
  - A front that stays within 3 for 150 / 75 / 55 / 45 / 35 s digs in. That is ×0.65 from minute 15, because a front that is not moving should dig in.
  - The line goes across the line of contact, 1.1 behind the troops. If that is not possible it goes 2.6 or 4.1 back, to own or neutral ground behind a siege.
  - Then a 45 s cooldown, and no second line within 2.6 of the last.
- **Limits:**
  - one base or outpost stroke per pass, plus one for a stalled front;
  - no strokes while 8 + 2 × level hexes are still undug;
  - every stroke is a single `trenchLine` call, so it is connected and short.

### Upgrades
Upgrades run only when no planned defense is waiting for the wallet:
- **Era levels of the AI's own field defenses**, lowest level first and armed structures first.
- **Base perimeter:**
  - **Bought** when a base has none (normal) or is missing pieces (hard and above, or attacked within 5 minutes).
  - **Upgraded** to level 2, then 3, as the eras allow.
  - Never while the headquarters has another project, or while `buildArmy` wants to advance that base's tier, so tier-ups are not delayed.

### Budget
**Wallet:**
- It accrues `materials income × share × phase × threat × capacity`:
  - **share:** 0.025 / 0.055 / 0.075 / 0.08 / 0.085;
  - **phase:** 0.3 before minute 5, 0.6 before minute 10, 1.0 before minute 15, 1.15 before minute 20, 1.2 after;
  - **threat:** ×1.3 if a site was attacked in the last 150 s;
  - **capacity:** ×2.5 when the army is within 6 of its capacity, so production has nowhere to go.
- **Cap:** 220 / 420 / 560 / 680 / 800, plus 120 per base (×1.6 at capacity).
- **Surplus:** half of any stock above 1500 after production commitments also counts as funds. That is above `developBases`' New Base threshold (1350), so new bases are not crowded out.

**Spending rules:**
- The wallet is income set aside, so it is spent from the stockpile itself. Production is paid progressively and loses at most the wallet's share.
- **Reserves:** a purchase must leave these in the stockpile:
  - the settlement price of a captured ruin being settled (`settlementCost`, always);
  - era II (480), once the army is at 80% of its floor;
  - 200, the price of a facility, while the main base has an open ring site. The economy build-out comes first: the first tuning pass, without this reserve, left a brutal AI's main base at 3 facilities for 12 minutes while emergency bunkers ate its second depot.
- **Army below floor:** no planned works at all while the army is below 60% of its floor (`8 + minute`, max 40), unless it is at capacity.
- **Stockpile drained by production:** a funded purchase retries on the next plan tick the stockpile can cover it, at most every 1.5 s, instead of waiting a whole period.

**Emergency builds** (`aiEmergencyWorks`, the Defending branch):
- Every 50 / 35 / 28 / 24 / 20 s.
- Only while fewer than 1 / 2 / 3 / 3 / 4 armed structures stand within 4 of the base.
- **Type:** an AA battery against 2+ aircraft (era II); an anti-armour emplacement against tracked vehicles (era II); otherwise a watchtower. Bunkers come only as reinforcements, for hard and above.
- **Placement:** 3.2 toward the attackers, ±0.9 lateral.
- **Price:** always list price; a surcharged spot is skipped.
- **Funding:** the first structure by an attacked base comes regardless of the wallet, as before AI works. Further ones need wallet funds. All are charged to the wallet (`works.emergency` counts them).

### Difficulty
| | easy | normal | hard | expert | brutal |
|---|---|---|---|---|---|
| Income share | 2.5% | 5.5% | 7.5% | 8% | 8.5% |
| Axes per base | 1 | 2 | 3 | 3 | 4 |
| Armed per main axis | 1 | 2 | 3 | 4 | 5 |
| Base cap | 2 | 4 | 7 | 9 | 11 |
| Trench line (hexes) | – (fronts from min 15) | 4 | 5 | 5 | 6 |
| Front stall before digging (s) | 150 | 75 | 55 | 45 | 35 |
| Planned works start | 7:00 | 5:00 | 4:00 | 3:30 | 3:00 |
| Works pass every (s) | 10 | 6 | 5 | 4 | 4 |

**Determinism and cost:**
- No randomness: the module does not call `game.rng`, and ties are broken by id and bearing.
- One works pass every 4–10 s per AI:
  - axis recomputation every 120 s, which scans a radius-8 disk (217 hexes) plus a few chokepoint samples;
  - at most 8 + 4 + 4 dry runs.
- In the 12-minute test match, the AI plan tick's cost is not measurably different.

## Numbers
**How these were measured:**
- **Probe:** a works probe, an AI-only match runner like `tools/action-balance.mjs` that samples each AI every minute. It is a scratch script and not committed.
- **Before and after:** both come from **one frozen snapshot of the tree**. "Before" is the same snapshot with the three `actionAI.js` hooks reverted to the old emergency block. Other agents were editing the AI and navigation at the same time, so the two runs share all their changes.
- **Maps:** Twin Rivers, Mirefen Gap, Fortress Pass, Serpentine, Three Crowns and Crossroads.
- **Runs:** seeds 1–3, 25 minutes, personalities rotated per seat.
- **Units:** values are means per AI still alive at that minute.
  - **Field defenses:** finished, outside the base perimeter.
  - **Trench hexes:** dug or being dug.
  - **Army:** units, base engineers excluded.

### Normal (18 matches, 45 AIs)
| Minute | Field defenses, before → after | Trench hexes, before → after | Perimeter pieces, before → after | Works spent, after | Army, before → after (per alive AI) | Army per seat, all seats (dead = 0) |
|---|---|---|---|---|---|---|
| 5 | 0.1 → 0.1 | 0 → 0 | 0.1 → 0.0 | 31 | 12.8 → 12.8 | 13.0 → 13.0 |
| 10 | 0.5 → 1.5 | 0 → 0.3 | 2.1 → 1.9 | 239 | 20.1 → 20.3 | 20.3 → 20.5 (+1%) |
| 15 | 0.7 → 3.0 | 0 → 4.5 | 4.5 → 5.2 | 644 | 23.4 → 22.1 | 23.6 → 22.2 (−6%) |
| 20 | 0.7 → 3.8 | 0 → 11.4 | 5.4 → 8.6 | 1209 | 31.7 → 29.1 | 30.8 → 28.6 (−7%) |
| 25 | 0.6 → 6.7 | 0 → 17.1 | 7.0 → 9.3 | 1989 | 38.1 → 35.4 | 33.9 → 32.3 (−5%) |

- **Matches:** 9/18 ended before 25 min without works, 8/18 with them. Mean length 22.9 → 23.2 min. No errors.
- **Mix at the end:** 143 watchtowers, 79 sandbag barricades, 8 anti-armour emplacements, 2 bunkers. Most normal AIs are still in era I or only just in era II. Before: 24 watchtowers and 2 emplacements, all emergency builds.
- **Spending:** about 8–9% of cumulative materials income by minute 20–25.

### Brutal (Twin Rivers, Serpentine, Three Crowns; 9 matches)
| Minute | Field defenses, before → after | Trench hexes, before → after | Perimeter, before → after | Works spent | Army per seat, all seats |
|---|---|---|---|---|---|
| 10 | 0.6 → 2.0 | 0 → 1.3 | 1.1 → 0.6 | 298 | 20.6 → 19.9 (−3%) |
| 15 | 0.7 → 4.7 | 0 → 8.9 | 4.0 → 3.7 | 907 | 26.9 → 24.7 (−8%) |
| 20 | 0.6 → 6.4 | 0 → 20.3 | 5.2 → 4.9 | 1835 | 37.1 → 26.1 (−30%) |
| 25 | 0.5 → 13.2 | 0 → 31.1 | 9.7 → 8.9 | 2655 | 38.1 → 28.0 (−27%) |

- **Matches:** with works, 5/9 brutal matches end before 25 min (1/9 without). Mean length 24.4 → 22.3 min.
- **Mix at the end:** 135 barricades, 31 watchtowers, 15 bunkers, 3 emplacements.
- **Watch:** see Risks.

### Easy (Twin Rivers, Serpentine, Three Crowns; 6 matches)
| Minute | Field defenses, before → after | Trench hexes | Army per seat, all seats |
|---|---|---|---|
| 10 | 0.3 → 0.4 | 0 → 0 | 22.5 → 21.4 |
| 15 | 0.3 → 1.3 | 0 → 0 | 18.9 → 21.9 |
| 20 | 0.4 → 2.3 | 0 → 0 | 24.3 → 27.6 |
| 25 | 0.3 → 3.4 | 0 → 0 | 30.2 → 27.0 |

Easy builds a watchtower or two per base and no base trenches. Its army is within noise of before.

### Tuning history
These are the same snapshots, so the effect of each change can be read directly:
1. **First version:** share 12% (normal) and emergency bunkers. Normal army −10% from minute 10.
2. **Wallet spent from the stockpile and shares lowered.** Normal is within 2–7% through minute 15, but −11–17% late. Brutal lost a third of its army: it built emergency bunkers early, delaying its second depot (main base stuck at 3 facilities for 12 minutes).
3. **Watchtower first in emergencies, a facility reserve while the main base has open sites, and a settlement reserve.** The brutal economy recovered: the side-by-side match reaches era II and 6+ facilities by minute 10, as without works.
4. **Final:** shares 2.5–8.5%, a flatter late phase, one stroke per pass, and shorter expert and brutal lines.

### Balance sims (BALANCE_TESTS.md tool)
- **Command:** `node tools/action-balance.mjs all 1 25`.
- **Setup:** all 17 maps, seed 1, 25 min, normal difficulty, run from the same two frozen snapshots as above.
- **Result:** no errors in either run.

| | Without works | With works |
|---|---|---|
| Units per player @12 (mean of 17 maps) | 29.4 | 29.1 (−1%) |
| Units per player @18 | 36.6 | 32.6 (−11%) |
| Units per player @24 | 43.1 | 38.5 (−11%) |
| Army value per player @12 | 3442 | 3396 (−1%) |
| Matches ended before 25 min | 4/17 | 4/17 |
| Field works on the map at the end (structures counted by the tool) | 13 | 32 |

**Reading:**
- Matches still finish at the same rate.
- Armies are unchanged through minute 12. From minute 18 they are about 11% smaller on this single seed; the 3-seed works probe above gives −5–7%.
- The per-map spread is wide (e.g. Mirefen Gap +25% @12, Twin Rivers −26% @12), so one seed per map is indicative only.

## Tests
`test/ai-works-2026-11-18.test.js`:
1. **Defenses on threat axes:** in a 12-minute hard AI match, AI bases get armed field defenses on their threat axes (at least 3 across the AIs; before: 0–1) and trench hexes (at least 3).
2. **Road offset:** no defense other than a barricade is placed on a road (`onRoad`, checked at placement). Trenches may cross roads as covered crossings, but never a bridge or causeway deck.
3. **Economy not starved:** the mean army from minute 4 with works is at least 85% of the same matches without works (`AI_WORKS.enabled = false`). It is pooled over three hard matches: seed 41 for 15 min, seeds 7 and 3 for 12 min (balance pass).
4. **Threat axes:** the main axis faces the enemy capital, and an attack from the opposite side becomes an `attack` axis.
5. **Controlled base plan:**
   - each axis is filled;
   - list price only;
   - off roads;
   - own or neutral ground;
   - trench lines linked (`route`);
   - a destroyed defense is rebuilt.
6. **Stalled front:** a contact held still digs a line on the home side of the troops, with the note "Digging in on a stalled front."
7. **Starvation gate:** no planned works with the army below its floor. An emergency build still comes, toward the attackers, at list price, and sets `p.defenseAt`.
8. **Difficulty scaling:** the tables grow monotonically, and brutal builds, digs and spends more than easy in the same scenario.
9. **Determinism:** the same state gives the same works.

## Risks and knobs
- **Brutal late-game army** (see "Balance pass (2026-11-18)": resolved by `keep` and the AI operations changes; the notes below describe the first version).
  - **What we see:** with works, brutal AIs field about 27–30% fewer units per seat from minute 20, against −3–8% through minute 15. They have 13 field defenses and 31 trench hexes each by minute 25.
  - **Why the number is uncertain:** more brutal matches end (5/9 vs 1/9), so dead seats pull the per-seat mean down. Only 9 matches were run.
  - **Knob:** `AI_WORKS.share[4]` (0.085). The phase multipliers and `baseCap` are the other levers.
- **Claim roads can be laid under a finished or planned defense.**
  - **What we see:** in the 15-minute test match a road was laid beside an unbuilt AI bunker shortly after it was placed (t = 170 s; `onRoad` then true).
  - **Who owns it:** the placement rule holds at placement time, which is what the test checks. Routing claim roads around field structures is NAVIGATION's area.
- **Watchtowers dominate normal AIs.** Normal AIs mostly stay in era I, where the mix is watchtower first. Bunkers come only on a second slot, which normal reaches from minute 15. A sturdier mix would cost more army.
- **Trenches need open ground.** Hills, mountains and dense forest refuse every hex (`ground`), so a base in the mountains gets no line on that axis. It still gets defenses: the snap moves them to level ground.
- **Fronts are short-lived on small maps.** Most contacts move within 30–60 s, so front lines appear mostly on long sieges and late stalemates. That is the intent, but on 2-player maps it rarely triggers before minute 15.
- **`p.works` is in the god-view `actionPlan` snapshot:** a few hundred bytes per AI.

## Balance pass (2026-11-18)
**Problem:** brutal armies fell below the old AI's from minute 16 once AI WORKS and AI OPERATIONS ran together (AI_OPERATIONS.md, "Balance pass"). Measured with `tools/ai-ops-probe.mjs` over 51 brutal matches (17 maps × seeds 1–3, 30 min):
- Without works, brutal's army at minute 24 was about 4 units larger.
- Most of that gap was **energy**. Late AIs are energy-bound (4–7 energy/s against 20–35 materials/s). The works wallet counts materials only, but bunkers, emplacements and perimeter upgrades (140 and 240 energy per base) were bought down to 0 energy, starving the energy-cost units.
- Works also spent the energy the strategic programme banks, so in the "before" run no brutal missile was ever built.

**Changes** (`actionAIWorks.js`):
- **The programme's bank is a reserve.** While `p.nuke.saving`, the budget keeps `p.nuke.reserve` in materials and energy.
- **`AI_WORKS.keep`:** materials and energy that works leave in stock for production. 0 / 0 except brutal, which keeps 300 materials and 350 energy, so its works are bought in times of plenty. Applying the energy part only to purchases that cost energy dug 30 % more trench hexes but cost about 3 units at minute 24, so it applies to every purchase.
- **`AI_WORKS.starve`:** the share of the army floor below which no planned works are bought. It is 0.6 as before, except brutal at 0.85. In practice it rarely binds once brutal's economy runs.
- **`share[4]` stays 0.085.** In an earlier configuration, 0.065 gained about 2 units at minute 24 but cut field defenses at minute 24 from 5.2 to 3.7. 0.10 showed no gain beyond noise. `keep` was chosen instead: it costs works only when production needs the stock.

| Brutal, 51 matches × 30 min | Before | After |
|---|---|---|
| Army per civ at 8 / 16 / 24 min | 19.2 / 26.1 / 23.7 | 20.7 / 34.9 / 31.6 |
| Field defenses at 8 / 16 / 24 min | 0.7 / 3.1 / 9.3 | 0.2 / 1.8 / 3.6 |
| … of which armed | 0.4 / 1.6 / 4.7 | 0.2 / 1.1 / 1.8 |
| Trench hexes at 8 / 16 / 24 min | 0.3 / 11.5 / 27.6 | 0 / 6.1 / 14.6 |
| Works spent by 8 / 16 / 24 min | 97 / 841 / 2621 | 64 / 571 / 1440 |
| Missiles built / launched | 0 / 0 | 6 / 3 |
| Matches ended within 30 min | 21 | 30 |

| Normal, 17 matches × 30 min (works unchanged for normal) | Before | After |
|---|---|---|
| Army per civ at 8 / 16 / 24 min | 20.1 / 28.3 / 32.2 | 20.1 / 28.3 / 32.3 |
| Field defenses / trench hexes at 24 min | 5.6 / 16.1 | 5.4 / 16.1 |

| Long brutal matches (14 × 48 min, AI_OPERATIONS.md) | After |
|---|---|
| Field defenses at 32 / 40 / 48 min | 9.0 / 19.6 / 19.8 |
| Trench hexes at 32 / 40 / 48 min | 30.9 / 51.9 / 71.4 |

**Reading:**
- Brutal fortifies less in the first 24 minutes: about 40 % of the field defenses and half the trench hexes it had this morning. The army is a third larger.
- Brutal still fortifies, and does so on top of a larger army. Its works grow late: 20 field defenses and 70 trench hexes per surviving civ by minute 48.
- Defense counts are means over civs still alive. Brutal now ends more matches early, so the minute-24 sample is the long grinds.
- **Tests:** "the works budget does not starve the army" now pools three hard matches (seed 41 for 15 min, seeds 7 and 3 for 12 min) and still asks for 85 %. The pooled ratio is 1.02 (per seed 0.98–1.06). One seed alone swung across the margin with unrelated AI changes.

## In-game checklist
- [ ] **Normal AI, 1v1 on Twin Rivers, spectate in god view.**
  - From about minute 5–6, a watchtower appears 4–5 hexes out from the AI's main base, on the side facing you (`actionPlan.works.bases[...].axes[0]`).
  - By minute 10–12, a trench line 4 hexes long lies just beyond it, across the approach.
- [ ] **Attack the AI from a new side.**
  - The emergency structure appears toward you.
  - Within about 2 minutes a new axis covers that side (`kinds` includes `attack`), with a structure and, later, a trench there.
- [ ] **Armour:** bring 2 or more tanks into its sight (era II AI). New defenses on that axis are anti-armour emplacements.
- [ ] **Aircraft:** fly 2 or more aircraft over it (era II AI). One AA battery appears beside the main base.
- [ ] **Road through the defense line:** a sandbag barricade stands on the road. No watchtower, bunker or emplacement sits on a road surface.
- [ ] **Destroyed defense:** destroy one of its defenses and do not press the attack. It is rebuilt on a later pass.
- [ ] **Stalled front:** stall its attack (hold a line outside your base for 1–2 minutes).
  - A short trench line appears just behind its troops.
  - The plan notes read "Digging in on a stalled front."
- [ ] **Late game (minute 20+):**
  - Second axes get trench lines.
  - Defenses are upgraded (level 2/3 badges) and perimeters reach level 2–3.
- [ ] **Difficulty:** an easy AI builds 1–2 structures per base and digs only on long-stalled fronts. A brutal AI has 3–4 axes, 5+ armed structures on the main one, and an artillery emplacement after minute 15.
- [ ] **Army size:** the AI's army is not visibly smaller than before (the god-view army count at minutes 10/15/20).
