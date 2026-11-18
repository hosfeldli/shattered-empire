# Units and defenses (workstream G, 2026-11-18)

Four user requests:
1. Bunker bursts.
2. A 3-hex ring of influence for defenses, shown with the territory border style.
3. The "armored infantry" turned into a Bradley-style IFV.
4. Line infantry as cheap, disposable grunts.

Status: server covered by `test/action-units-defenses-2026-11-18.test.js`; the client compiles; nothing played by hand in Unity yet (see "In-game checks").

## 1. Bunker bursts

The bunker MG now fires **sustained bursts** instead of one volley at a time.

| | Before | After |
|---|---|---|
| Fire pattern | 1 volley every 1.8 s (1.6 s cooldown on the 0.6 s structure cadence) | 6 rounds 0.3 s apart, then a 2.7 s rest: one burst every 4.2 s |
| Attack | 14 | 16 |
| Damage per round | 14 × 1.65 = 23.1 | 16 × 1.65 × 0.39 = 10.3 |
| Sustained DPS | 12.8 | 14.7 (+15%) |

**Why +15% DPS:** at 165/45 the bunker was out-damaged by the 85/20 perimeter turret (11.9 DPS). It now leads it, without leaving the MG band.

Each round still carries the MG's suppression (16), so a burst pins a squad hard. Its kill cap stays 6 men per round, but at about 10 damage a round kills one 9-HP rifleman.

**Server:** `ACTION_BUILDINGS.bunker.burst = { shots, gap, rest, share }`.
- `actionCombat.fire`: a structure with `def.burst` counts rounds in `b.burstLeft` and keeps its target in `b.burstTarget`. Its `readyAt` is `gap` during a burst and `rest` after the last round.
- The building loop polls a structure mid-burst every 3 ticks instead of 6, and keeps its target while that target stays valid.
- An idle bunker still polls every 6 ticks, so it adds no acquisition cost.
- State is deterministic and saved with the building.

**Wire:** each round is a `fire` event with `bu` = its place in the burst (1–6).

**Client:**
- `CityRenderer.Defenses` records the bunker's embrasure. Tracers leave the slit on the side facing the target, not the roof.
- `GameBootstrap` draws each burst round as a heavy tracer plus a second, slightly offset tracer, so the six rounds read as one stream.

## 2. Ring of influence: 3 hexes, territory-style edge

**Server:** `DEFENSE_INFLUENCE.reach` 8 → 3. Defenses (and the neutral support posts) cost ×3 more than 3 hexes beyond your territory. The AI's emergency towers still never pay the surcharge.

**Client:** `TerritoryField` builds a third map texture, `_SE_InfluenceTex` (R8).
- **What it holds:** the signed distance to the edge of the local civ's ring of influence, encoded like the territory alpha.
- **How it is computed:** a BFS from your hexes through any hex, capped at reach + 1, the same as `actionBases.influenceRing`.
  - The ring is the hexes within reach that no other player owns.
  - Its edge is stamped on hex sides, like the territory border.
  - Sides facing another player's territory are skipped, because their border already shows there.
- **When it rebuilds:** it is built in the same worker-thread rebuild as the territory. It changes only when ownership, the local civ or the reach changes, so there is no per-frame work.
- **How it is drawn:** `SE/Terrain` draws it with the territory border's line (same width, zoom and pulse, without the inward wash) in your team colour.
  - Strength 0.3 at all times.
  - Strength 1.0 while placing a defense or a neutral support post (`Commander.PlacingInfluencedStructure`).
  - Strength is a shader global, set only when it changes.
- **What it replaced:**
  - The amber disc band in `Commander.Rings.DrawInfluenceEdge` is gone.
  - The amber hovered-hex ring and the ×3 cursor warning stay.
  - The hint text now says "past your ring of influence border".

## 3. exo_infantry → Infantry Fighting Vehicle

The key stays `exo_infantry`, so saves, the AI tables and the client type tables keep working. The tier III barracks squad (6 exo-suited men) is now a Bradley-style IFV.

| | Exo squad (before) | IFV (after) | Carrier (APC, unchanged) | Tank (unchanged) |
|---|---|---|---|---|
| Facility / tier | Barracks / III | Vehicle Works / II | Vehicle Works / II | Vehicle Works / II |
| Cost | 260 / 130 | 235 / 85 (first 215 / 75) | 195 / 65 | 235 / 80 |
| Capacity | 5 | 5 | 5 | 6 |
| Train time | 27 s | 27 s | 26 s | 29 s |
| HP | 510 (6 × 85) | 240 (first 270) | 190 | 330 |
| Def | 19 | 15 | 13 | 18 |
| Move | Infantry | Tracked, speed 1.0 | Tracked | Tracked |
| Weapon | Assault rifles, atk 44 | Autocannon, atk 15 (first 18), range 3.0 | Autocannon, atk 17 | Cannon, atk 28 |
| Missile | – | Anti-tank missile: 62 dmg, 10 s reload, range 3.6 | – | – |

**The missile (`actionCombat.fireAtgm`):**
- After an autocannon burst, a ready IFV launches a guided `missile` (vsArmor 1.3).
- Valid targets are tracked or wheeled vehicles (not aircraft), or fortified structures, that the IFV sees and has a line of fire to within 3.6.
- It prefers its current target if that qualifies. Otherwise it picks the nearest valid target, armour before bunkers.
- Tactical interception does not apply: it is not a battery round.
- A tank hit takes 77.

**Duel numbers:**
- The autocannon (15 × 1.65 ≈ 25 a burst) kills 2–3 nine-HP riflemen per burst.
- Rifles do about 1 damage per volley to the IFV.
- 1 v 1 against a tank the IFV loses: the tank needs about 9 s (5 shells) to kill it, and in that time the IFV deals about 190 (one missile at 77 plus six autocannon bursts at about 19), over half the tank. It is a sting, not a tank killer.

**Dismount squad:** not implemented. There is no transport or carry system to build on, and it was not cheap. The IFV is a fighting vehicle only.

**Upgrades and other rules:**
- It takes the vehicle upgrade line: Heavy Armor makes it ignore small arms; Field Engineering self-repair applies.
- Infantry-line kit (grenades, rockets, body armour, marksmen, training cover) no longer applies. All of it is keyed on `move === 'infantry'`.
- It cannot capture or garrison.
- It is not blocked by dense forest, and it does not clear forest (a light hull).
- It counts as an armour shield for infantry sheltering behind it.

**Save migration (`persist.restoreGame`):**
- Any unit whose type's max HP changed keeps its health fraction at the new maximum. This covers the IFV and the rebalanced squads.
- A former exo squad also takes the vehicle radius and drops its suppression and plates.
- If it was garrisoned, it leaves the garrison.
- **Not migrated:** an exo already queued at a barracks in an old save.

**AI:** `actionAI` ROLES moved it from the line role (0.45, tier III) to the armour role (0.8, tier II).

**Client:**
- **Model:** a procedural IFV hull and turret in `MilitaryMeshes.Ifv` / `IfvTurret`. Authored `Ifv` / `IfvTurret` models can override them through ModelLibrary.
  - Hull: tall boxy hull on the tank's tracks, trim vane, skirt armour tiles, firing ports, rear ramp.
  - Turret: autocannon with muzzle brake, coaxial MG, twin missile box on the left cheek, sights, smoke dischargers.
- **UnitRenderer:**
  - `Kind.Ifv` renders the close-up and operational meshes, with tracks, road wheels and the turret slewing like a tank's.
  - It also gets suspension and an armour-shield slot.
- **Readability:** removed from `SquadMen` and casualty figures; vehicle badge; 0.35 ring; carrier glyph with an X (mechanised).
- **Presentation:**
  - Autocannon sound, heavy tracer and muzzle from the turret.
  - Missile launch backblast (`tw` flag).
  - Tank engine sound and wreck size.
- **UI:** IFV icon (`Icons.cs`), role line (`Hud.Action.cs`) and Field Guide text. The name "Infantry Fighting Vehicle" and glyph "IF" come from the server definitions.

## 4. Infantry as disposable grunts

| Squad | HP per man (was) | Max HP (was) | Cost (was) | Train time, s (was) | Attack (was) |
|---|---|---|---|---|---|
| Rifle squad (12) | 9 (14) | 108 (168) | 65 (90) | 7 (10) | 9 (12) |
| Militia (10) | 8 (13) | 80 (130) | 40 (60) | 5 (8) | 6 (9) |
| Anti-armor (5) | 22 (26) | 110 (130) | 110/30 | 15 (16) | 16 (18) |
| Special forces (8) | 26 (30) | 208 (240) | 140/45 | 20 | 24 (26) |
| Mortar team (4) | 30 | 120 | 150/45 | 21 | 15 |

- **Cheap and quick:** rifle squads cost 28% less and train 30% faster; militia cost 33% less and train 38% faster. Capacity is unchanged (2).
- **Frail:** fixed-damage weapons (MG rounds, tank HE, autocannon, blasts) now kill roughly 1.5× as many men per hit.
- **Specialists:** anti-armor, special forces and mortars stay clearly more valuable per squad (more than 1.6× a rifle squad's price) and lose less.
- **Anti-armor trim:** the anti-armor attack 18 → 16 is the trim BALANCE_TESTS recommended (it out-traded armour at 1.62).

## In-game checks (runtime-unverified)
1. **Bunker bursts:**
   - The bunker fires six-round streams from the slit facing the target, with a visible pause between bursts.
   - The streams stay readable at operational zoom.
   - Garrisoned squads still fire from it.
2. **Ring of influence:**
   - A faint team-coloured line runs about 3 hexes outside your territory. It turns full strength while a defense is on the cursor.
   - It is absent along enemy borders and the map edge.
   - It updates when territory changes, with no hitch (`TerritoryMs` in the bench overlay).
   - The ×3 warning appears past it.
3. **IFV:**
   - Trained at the Vehicle Works; reads as a tracked vehicle with a turret, its tracks animate and the turret slews.
   - Missiles launch with backblast at tanks and bunkers, autocannon tracers at infantry.
   - The icon shows in the Vehicle Works list; there are no soldier figures or casualty bodies.
   - Old saves with exo squads load as IFVs.
4. **Infantry:**
   - Rifle and militia squads die noticeably faster to MGs and tanks.
   - Production queues fill quickly.

## Balance sim (2026-11-18)
Results are in BALANCE_TESTS.md under "2026-11-18".
- **Rifle squad:** value ratio 0.73 (was 1.30). The intended disposable grunt.
- **Anti-armor:** 1.47 (was 1.62).
- **Tank:** 2.99 (was 2.18).
- **IFV, first version** (atk 18, 215/75, 270 HP): value ratio 4.01, built 151 times. Too efficient.
- **IFV, tuned:**
  - atk 15: 3.19 (2 seeds).
  - Plus cost 235/85: 4.20 (2 seeds, only 92 built, noisy).
  - Plus 240 HP: **2.90 over 4 seeds** (185 built, 108 lost), level with the tank (2.90). These are the final numbers.
