# Strategic warheads (2026-11-19)

User: "Make nuclear bombs more powerful. They barely do any damage considering how expensive they are, have a
small damage range and barely damage cities. Have them nearly wipe out cities and do larger area damage that
decreases as it goes out. The smoke should be a solid plume, not dotted puffs."

Cost (1440 materials / 1140 energy), build time (52 s), range (58) and interception (`MISSILE_DEFENSE`:
AA battery 38 %, mobile air defense 30 %, one shot per interceptor per 8 s) are unchanged.

## Blast model

`MISSILE_PROJECT` and `nukeFalloff` (server/sim/actionDefinitions.js), `strategicBlast` / `strategicGround`
(server/sim/actionCombat.js). Distance `d` is measured to the target's edge, as for every blast.

- **Falloff `f(d)`:** 1 within `core` = 3.2. From there to `radius` = 7.5 it is `edge + (1 − edge)(1 − t)^1.6`,
  where `t = (d − core) / (radius − core)` and `edge` = 0.1. Beyond 7.5 it is 0.
- **Units:** they take `1500 × f`, then armour, cover and the squad model as usual. Squads have no kill cap.
  Aircraft in flight are spared, as before.
- **Structures:** they lose a share of their own max HP, so tiers and upgrades never make a city nuke-proof.
  - Ring facilities and defenses: `1.05 × f`.
  - Headquarters: `0.9 × f`.
  - Facilities are processed before headquarters, so a falling HQ leaves ruins of what the blast already levelled.
  - The owner of each hit HQ is notified.
- **Ground:**
  - Roads are torn up on every hex in the core: 110 at ground zero, 80 elsewhere.
  - Trenches lose `100 × f` across the whole blast. Before, only the centre hex was hit.
  - The crater, smoke, forest knock-down (shockwave.js) and garrison sheltering are unchanged.
- **Deterministic:** the order is the spatial query's, sorted by kind and id. No new rng draws in the damage step.
  Road damage still uses `game.rng`, now once per core hex.
- **No new saved state.** An in-flight warhead from an old save resolves with the new model.

## Before / after

| | Before | After |
|---|---|---|
| Radius | 2.7 | 7.5 (core 3.2) |
| Unit damage at 0 / 2 / 2.7 | 480 / 324 / 163 | 1500 / 1500 / 1500 |
| Unit damage at 4 / 5 / 6 / 7 / 7.5 | 0 | 1122 / 716 / 400 / 194 / 150 |
| HQ (1450 HP) direct hit | −480 (−33 %) | −1305 (−90 %, left on 145) |
| Ring facility (320–520 HP, ~1.9 out) | −~310 (often survives) | destroyed |
| A city whose HQ is 4 / 5 / 6 / 6.5 / 7.5 from ground zero: HQ loses | 0 | 81 % / 55 % / 33 % / 24 % / 12 % (its facilities on the near side more, often destroyed) |
| Roads | centre hex | every hex in the core |
| Trenches | centre hex, −100 | whole blast, −100 × f |

Probe (seed 41, a direct hit on a tier-1 city with three facilities):
- The HQ went from 1450 to 145 HP. The barracks, motor works and heavy weapons were destroyed.
- Every tank, autonomous tank, field gun and rifle squad within 5 died.
- At 6, an autonomous tank was left on 37/480. At 7, a tank on 54/330 and an autonomous tank on 214/480.
- Infantry died out to the rim. Units at 8 were untouched.

## AI

`pickStrike` already used `MISSILE_PROJECT.radius`, so the following grew automatically:
- the own-forces safety check, from radius + 1 = 3.7 to 8.5;
- the value scoring of what the blast covers.

The rally points (5.5–8.5 from the objective) now lie inside the blast. While a strike is pending, the operation
does the following:
- Troops within radius + 2.5 fall back along their axis to a hold point radius + 3.1 out.
- Forces whose rally lies inside that zone wait where they are.

Before, the troops went back to rallies inside the blast and the launch never came. The stalemate test in
ai-operations-2026-11-18.test.js covers this: one launch, with no own troops within the blast radius.

## Client

- **Targeting:** while aiming "Launch missile", the cursor shows two circles from `Defs.MISSILE`:
  - a red inner circle for the core;
  - an amber outer circle for the radius.
  - Code: Commander.Action.cs.
- **Impact:** the `mimpact` event's `r` (now 7.5) sizes the effect: `EffectsRenderer.Strategic(p, scale, blastRadius)`.
  - It covers the fireball, the mushroom cloud and the ground ring.
  - The cloud scale is r / 4.6, so the base surge settles at about the blast radius.
  - The terrain shock keeps scale 1 because it mirrors the server's forest knock-down.
- **Solid plume** (EffectsRenderer.Mushroom.cs, Shaders/NukePlume.shader):
  - Before, the stem, cap and skirt were about 190 separately lit soft puffs, so the cloud read as dots.
  - Now they are one lathe-mesh volume, rebuilt each frame from the evolving profile: a flared stem, a toroidal cap domed over the middle, and a ground-hugging base surge.
  - It is drawn in one draw per wrap image, with a depth pre-pass and a blended colour pass.
  - The shader billows the surface with 3D noise advected along the circulation: up the stem, out over the cap and down its rim.
  - Lighting: bump-lit from the sun and sky, with dark creases and a shaded underside.
  - It glows orange-white from the fireball inside for the first seconds, then cools to brown-grey.
  - Its silhouette is feathered. Over the last half of its 46 s life it erodes into wisps.
  - Particles remain only for two things: the brief condensation collar, now a dense, overlapping ring, and the firestorm flames.
