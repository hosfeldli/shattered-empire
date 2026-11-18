# Balance tests (W3: squads and unit balance)

## Squad model (R3 user decision)
Squads stay single entities, with more men and a per-man simulation inside the squad. The code is in `actionUpgrades.js`: `squadHit`, `killCap`, `squadFirepower`, `suppress`. Server cost stays O(1) per squad.

| Squad | Men (was) | HP per man | Max HP (was) | Cost (was) | Train time, s (was) | Capacity (was) | Attack (was) |
|---|---|---|---|---|---|---|---|
| Rifle squad | 12 (8) | 14 | 168 (112) | 90 (80) | 10 (12) | 2 | 12 (9) |
| Militia | 10 (6) | 13 | 130 (90) | 60 (54) | 8 (10) | 2 | 9 (6) |
| Special forces | 8 (5) | 30 | 240 (196) | 140/45 (125/40) | 20 (23) | 3 (4) | 26 (19) |
| Exo infantry | 6 (4) | 85 | 510 (400) | 260/130 (240/120) | 27 (30) | 5 | 44 (34) |
| Anti-armor | 5 (3) | 26 | 130 (100) | 110/30 (100/25) | 16 (18) | 3 | 18 (15) |
| Mortar team | 4 (3) | 30 | 120 (120) | 150/45 | 21 | 3 | 15 |

Vehicles are unchanged. A tank still costs 235/80, 6 capacity and 29 s, so infantry stay 2.5–4× cheaper per entity and faster to field.

**How damage works inside a squad**
- **Casualties are discrete.** The wounded man falls first, then whole men.
- **Each hit has a kill cap:**
  - Small-arms volleys kill at most their burst: rifle 3, carbine 2, MG 6.
  - A single direct round kills at most `1 + HE` men (field gun: 2). A tank firing HE kills at most twice that (tank: 4).
  - A blast kills the men inside its lethal core, `0.6 × radius`. The count compares that core with the squad's spread: 0.52 when halted, 0.34 when moving. A bunched squad on the move suffers more.
  - Damage beyond the cap is wasted.
- **Body Armour** works inside the same model: each lethal hit spares one man, who is left on 1 HP.

**Firepower**
- Firepower = living men / men × accuracy × suppression.
  - Accuracy is 1 out to 40% of range, falling to 0.7 at maximum range.
  - A fully suppressed squad fires at 0.65.
- Suppression comes from each incoming round's `supp` (×1.5 for blasts) and decays by 5 per second.
- Crew-served mortars fire at full rate while 2 men stand.

## Balance sim
Command: `node tools/action-balance.mjs all 1,2 25` (17 maps × 2 seeds, 25 min).

The "before" run used a snapshot of the tree taken before W3. The "after" run used a snapshot that also contains concurrent W1/W2 work.

| Unit | Kills/loss before | Kills/loss after | Value killed/lost before | Value killed/lost after |
|---|---|---|---|---|
| Rifle squad | 0.79 | 0.94 | 1.14 | 1.30 |
| Anti-armor | 1.18 | 1.51 | 1.36 | 1.62 |
| Mortar team | 1.22 | 1.25 | 0.74 | 0.81 |
| Special forces | 2.70 | 2.37 | 2.13 | 1.81 |
| Tank | 4.64 | 4.61 | 2.20 | 2.18 |
| Mech infantry | 2.27 | 2.33 | 1.19 | 1.29 |
| Armored car | 0.71 | 0.70 | 0.54 | 0.57 |

**Reading:**
- Infantry trade better and are still worth producing late.
- Tanks remain the hard counter to infantry: their value ratio is unchanged.
- Match pace is similar: first contact 2–9 min, army value per player at 12 min about 2.8k–4.2k (was 2.5k–4.0k).
- **Watch:** the anti-armor squad (1.62). If it keeps outtrading armour in playtests, trim its attack from 18 to 16.

## Tests
- **`test/action-w3-squads-world.test.js`** (new):
  - Squad sizes and the extra[8] wire value.
  - Discrete casualties and kill caps.
  - Blast multi-kill and the effect of squad spread.
  - Firepower by men, range and suppression.
  - Body Armour in the squad model.
  - Forest clearing: Test E plus the batching test.
  - Storms and mountains for aircraft.
  - Missile interception: determinism, saturation, range and tactical rounds.
- **`test/action-bases-2026-11.test.js`:** the squad assertions now use 12 men instead of 8. This follows the R3 decision; the test's intent is unchanged.
- **`test/action-balance-2026-11-17.test.js`:** the duel tests pass unchanged.

## 2026-11-18: grunts, IFV and bunker bursts (workstream G)
Changes are listed in `UNITS_AND_DEFENSES.md`:
- **Line infantry:** HP per man rifle 14 → 9, militia 13 → 8, anti-armor 26 → 22, special forces 30 → 26. Costs and train times are lower and attacks trimmed.
- **IFV:** `exo_infantry` is now an Infantry Fighting Vehicle.
- **Bunker:** fires in bursts, DPS +15%.
- **Ring of influence:** 3 hexes.

Command: `node tools/action-balance.mjs all 1,2 25` (17 maps × 2 seeds, 25 min, no errors). The tree also holds other agents' in-progress work, so the before/after comparison is indicative.

| Unit | Built | Kills/loss (W3 after) | Kills/loss now | Value killed/lost (W3 after) | Value killed/lost now |
|---|---|---|---|---|---|
| Rifle squad | 4708 | 0.94 | 0.47 | 1.30 | 0.73 |
| Anti-armor | 1939 | 1.51 | 1.43 | 1.62 | 1.47 |
| Mortar team | 741 | 1.25 | 1.36 | 0.81 | 0.78 |
| Special forces | 89 | 2.37 | 2.43 | 1.81 | 1.64 |
| Tank | 466 | 4.61 | 6.71 | 2.18 | 2.99 |
| Mech infantry (APC) | 221 | 2.33 | 3.43 | 1.29 | 1.72 |
| IFV (`exo_infantry`), first version | 151 | – (exo squad) | 8.28 | – | 4.01 |
| Armored car | 3804 | 0.70 | 0.96 | 0.57 | 0.69 |

**Reading:**
- **Rifle squads** are now the disposable line, as requested: they trade at about half a loss per kill, and their value ratio is 0.73 (was 1.30). Each one is cheap (65 materials, 7 s).
- **Anti-armor** came down from 1.62 to 1.47. That closes the earlier watch item.
- **Mortar team and special forces** are about where they were.
- **Armour now farms the frailer infantry:** tank 2.99, APC 1.72.
- **The IFV was the outlier in the first run** (atk 18, 215/75, 270 HP): value ratio 4.01. See the tuning table below.
- **Match pace:**
  - First contact is 2:25–8:00.
  - Army value per player at 12 min is 2.7k–4.2k, which matches before.
  - 14 of 34 matches ended before 25 min.
- **Bunkers:** the tool does not attribute kills to a single structure type, so bunkers (inside `structure:?`) are not measured here.

**Tests:**
- **New:** `test/action-units-defenses-2026-11-18.test.js` covers burst timing and DPS, the 3-hex ring, IFV definition, weapons, missile targeting and reload, damage, save migration, and the infantry numbers.
- **Updated, with intent unchanged:**
  - `action-w3-squads-world`: numbers scaled to 9-HP men; exo removed from `SQUAD_MEN`.
  - `garrison`: special forces replace exo in the two tests that used exo.
  - `action-influence` and `neutral-construction`: the spot helpers skip snapped previews, because a snap can carry a spot past the 3-hex edge.
  - `production-scheduler`: 20 rifle squads keep the single queue busy for the whole run.
  - `review-s-2026-11`: a 20-damage volley, below the rifle kill cap.

### IFV tuning (2026-11-18, coordinator request: value ratio in the tank's band, ≈2–3)
Each row adds to the change above it. The missile (62 damage, 10 s, range 3.6) is unchanged throughout.

| Run | Change | Seeds | IFVs built / lost | Kills/loss | Value killed/lost | Tank value (same run) |
|---|---|---|---|---|---|---|
| 1 | First version: atk 18, 215/75, 270 HP | 1,2 | 151 / 74 | 8.28 | 4.01 | 2.99 |
| 2 | Autocannon atk 18 → 15 | 1,2 | 134 / 76 | 6.55 | 3.19 | 2.94 |
| 3 | Plus cost 215/75 → 235/85 | 1,2 | 92 / 41 | 9.66 | 4.20 | 3.21 |
| **4 (final)** | Plus HP 270 → 240 | 1,2,3,4 | 185 / 108 | 6.37 | **2.90** | 2.90 |

**Reading:**
- The two-seed runs are noisy for a unit built about 100 times: run 3 rose even though the IFV only got more expensive.
- The final run uses 4 seeds (68 matches, no errors).
- **Final IFV:** autocannon atk 15, 235/85, 240 HP, def 15, plus the missile. It still bites armour: a missile does 77 to a tank, and a 1 v 1 costs the tank over half its HP.

**Final 4-seed run, other units:**

| Unit | Kills/loss | Value killed/lost |
|---|---|---|
| Rifle squad | 0.48 | 0.76 |
| Armored car | 1.03 | 0.75 |
| Anti-armor | 1.39 | 1.47 |
| Mortar team | 1.29 | 0.75 |
| Tank | 6.45 | 2.90 |
| APC | 3.35 | 1.66 |
| Special forces | 2.54 | 1.66 |

Match pace: first contact 2:46–8:34, army value per player at 12 min 2.9k–3.9k.
