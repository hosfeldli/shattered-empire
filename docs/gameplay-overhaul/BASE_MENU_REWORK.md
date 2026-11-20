# Base menu rework and per-building upgrades (2026-11-20, Ticket 3)

User intent (Ticket 3, plus the follow-up "have the upgrades all be meaningful, gameplay affecting upgrades that are
visually identifiable, not just stat boosts"). This replaces the troop upgrades and the Armory removed on 2026-11-19/20
(UPGRADES.md) with a per-building design: every upgrade is bought on one building and applies only to what that
building makes (units trained there afterwards, and the living units it already made). Every upgrade changes how the
unit or structure plays (a mechanic) and is visible on its model; small numbers only ever accompany a mechanic.

Server: `server/sim/baseMenuDefs.js` (the tables below), `server/sim/actionUnitUpgrades.js` (commands, mods, the
mechanics), `actionBases.js` (perimeter paths, centre turret, outposts), `actionEngineers.js` (engineer quota,
upgrades, repair ranking), `actionProduction.js` (queue order), `persist.js` (old saves). Client: `Hud.Base.cs` (wheels),
`UnitRenderer.UpgradeKit.cs` (unit kit), `CityRenderer` (turret heads, centre turret, plots). Tests:
`test/base-menu-rework-2026-11-20.test.js`.

## 1. Main base menu (headquarters wheel)

Nine segments, clockwise from 12 o'clock (each unit's upgrade sits immediately to its left on screen):

| Angle | Item |
|---|---|
| 0° | Base tier upgrade. Its icon is the era glyph of the next tier with an up-arrow; it disappears at Tier III. |
| 40° | Scout buggy upgrade (Spotter mast) |
| 80° | Scout buggy |
| 120° | Engineers (panel: the base's engineers and their three upgrades) |
| 160°, 200° | unused (kept empty, per the ticket) |
| 240° | Build perimeter / rebuild missing positions (only while the perimeter is incomplete) |
| 280° | Militia upgrade (Rifle grenades) |
| 320° | Militia |

Outer arc (circle buttons at the bottom): Base production, Rally point, All production.

Removed: the Pads button and the open-pads view (a pad is entered by clicking it on the base), the Headquarters/Repair
button, the Garrison button (garrisoning itself is unchanged: right-click the HQ with infantry, or Garrison on the unit
wheel), the materials-produced (Economy) wedge, the perimeter upgrade button. The centre circle shows the base name and,
below it, the base's Materials and Energy income. Health is no longer in the menu: the headquarters has its own health
bar over the model (the only building that has one).

## 2. Production buildings: four units each

| Building | Units (wheel order) |
|---|---|
| Headquarters | Militia, Scout Buggy (moved from the Barracks) |
| Barracks | Rifle Squad, Anti-Armor Squad, Mortar Team, Special Forces |
| Vehicle Works | Armored Car, Infantry Carrier (mech_infantry), Infantry Fighting Vehicle (exo_infantry), Main Battle Tank |
| Heavy Weapons Facility | Field Gun, Self-Propelled Artillery, Mobile Air Defense, Support Truck (moved from the Vehicle Works) |
| Airfield | Helicopter, Warthog (fighter), Recon Drone, Bomber |
| Advanced Systems Lab | One-Way Drone, Autonomous Tank, Strike Swarm, Missile Battery (moved from Heavy Weapons) |
| Outpost | Militia (tier 1), Scout Buggy (tier 2) |

Re-homing (no unit deleted): the Vehicle Works had five units and the Lab three. The Support Truck (a tier II support
vehicle) moved to Heavy Weapons, whose tier III Missile Battery moved to the Lab (a guided-missile launcher is an
"advanced system" and is tier III like the Lab). Nothing was left without a home. Base engineers stay automatic.

Wheel (nine segments): 0° the building upgrade; units at 80°, 120°, 200°, 320° with their upgrades at 40°, 160°,
240°, 280° (each upgrade immediately to the unit's left on screen). Outer arc: rally, reinforce group, clear queue,
demolish.

Production order: items are produced in the order they were queued (`b.order`), one at a time, priority first (high,
normal, low), then queue order; a blocked head (funds, capacity, paused, exit) passes the capacity to the next item.
Each unit type still has its own queue entry: its count badge, progress ring, pause, priority and cancel (right-click
-1, Shift all) on its wedge; the order strip shows the sequence.

## 3. Unit upgrades (one line per unit, three tiers, bought per building)

Tier k needs global era k (and the unit's own tier). Price: tier 1 = 0.8 x the unit's cost, tier 2 = 1.3 x, tier 3 =
2.0 x (materials and energy, rounded to 5); 20 / 30 / 40 s. One upgrade project at a time per building, alongside its
production. Visual: an equipment bit on the unit record (`extra[7]`, bits listed below; bits 24-25 carry the tier),
drawn by `UnitRenderer.UpgradeKit.cs`: tier 1 shows the kit, tiers 2 and 3 add to it.

| Unit (building) | Upgrade | Mechanic (t1 / t2 / t3) | Visual (bit) |
|---|---|---|---|
| Militia (HQ, Outpost) | Rifle Grenades | Each volley at infantry lobs a grenade that hits the other enemy squads within 0.45 / 0.55 / 0.65 of the target for 35 / 50 / 65 % of the volley (grenade arc event) | grenade pouches on the belt (32) |
| Scout Buggy (HQ, Outpost) | Spotter Mast | Detects hidden units (camouflaged, infiltrating, in smoke) within 3 / 4 / 5 hexes and +0.5 / 1 / 1.5 vision | telescopic mast with sensor head (2048) |
| Rifle Squad | Squad Rockets | Gains an anti-armour rocket (vehicles and fortified structures, reach 2.6) : 28 / 36 / 44 damage every 14 / 12 / 10 s | disposable launchers on the men's backs (64) |
| Anti-Armor Squad | Ghillie Camouflage | Concealed (only detection reveals it) after 4 / 3 / 2 s still and silent; t3: its first shot from hiding +25 % | ghillie / leaf netting on the men (1024) |
| Mortar Team | Heavy HE Rounds | Shell blast radius x1.2 / 1.35 / 1.5 and +50 % suppression on the men hit | ammunition crates beside the tube (16384) |
| Special Forces | Body Armour | Small-arms damage x0.8 / 0.7 / 0.6 and suppression x0.6 / 0.45 / 0.3 (they keep firing under fire) | plate carriers front and back (128) |
| Armored Car | Smoke Launchers | When hit below 70 % health it fires a smoke screen on its hex (and the 6 around it at t3) for 7 / 9 / 11 s, which blocks sight into it; recharges 45 / 35 / 25 s | smoke-grenade dischargers on the hull (512) |
| Infantry Carrier | Turbo Diesel | Sprint: on a move order it drives x1.35 / 1.45 / 1.55 for 6 s, every 24 / 20 / 16 s | exhaust stacks (4096) |
| Infantry Fighting Vehicle | Field Repair Kit | Self-repair out of combat (6 s after the last hit): 1 / 1.5 / 2 % of its health a second | toolbox and spare track links on the hull (8192) |
| Main Battle Tank | Reactive Armour | The first anti-armour hit (cannon, AT gun, missiles, rockets, drones) every 14 / 11 / 8 s loses 50 / 60 / 70 % of its damage | explosive reactive armour tiles (2) |
| Field Gun | Camouflage Nets | Concealed after 5 / 4 / 3 s still and silent; t3: first shot from hiding +25 % | camo net over the gun (1024) |
| SP Artillery | Airburst Shells | Blast radius x1.2 / 1.35 / 1.5 and +50 % suppression | ammunition racks (16384) |
| Mobile Air Defense | Search Radar | Detects hidden units and aircraft within 3.5 / 4.5 / 5.5 hexes, +0.5 / 1 / 1.5 vision | rotating radar dish (2048) |
| Support Truck | Mobile Workshop | Repairs friendly vehicles and structures within 2.4 continuously: 4 / 6 / 8 HP a second (no button) | crane and toolboxes (8192) |
| Helicopter | Flares | The first anti-air hit every 18 / 14 / 10 s is decoyed (no damage) | flare dispensers on the tail (32768) |
| Warthog | Hardpoint Rockets | Fires a rocket at an armoured target in reach 2.4 on its runs: 40 / 55 / 70 damage every 10 / 9 / 8 s | rocket pods under the wings (262144) |
| Recon Drone | Thermal Camera | Detects hidden units within 4 / 5 / 6 hexes, +0.5 / 1 / 1.5 vision | sensor ball under the nose (2048) |
| Bomber | Flares | First anti-air hit every 20 / 16 / 12 s decoyed | flare dispensers (32768) |
| One-Way Drone | Shaped Charge | Blast radius x1.2 / 1.35 / 1.5 and +50 % suppression | larger warhead nose (16384) |
| Autonomous Tank | Self-Maintenance | Self-repair out of combat 0.8 / 1.2 / 1.6 % a second | maintenance pods on the hull (8192) |
| Strike Swarm | Extra Munitions | +1 / +1 / +2 projectile per attack (t2 also fires 10 % faster) | extra munition pods (65536) |
| Missile Battery | Extra Salvo | +1 / +1 / +2 missile per salvo (t2 also reloads 10 % faster) | extra launch tubes (65536) |

## 4. Building upgrades (the top wedge of a production building)

Two levels, era-gated (level 2 at era II, level 3 at era III), expensive: 1.0 x and 1.6 x the building's price, 25 / 35 s.

* Production buildings ("Instructors and assembly line"): training -15 % time per level, and every unit trained there
  leaves with veterancy rank 1 (level 2) or rank 2 (level 3): the rank's damage bonus and its chevrons on the unit.
  Living units the building already made gain the rank too. Visual: the building's level props (CityRenderer level hook).
* Processors and generators keep their output levels (+40 % per level).

## 5. Engineers (headquarters)

Quota by base tier: 3 / 5 / 8. They requeue themselves: a lost engineer is replaced every 25 s (the panel shows the
countdown). Repairs are automatic: every repair button is gone (HQ, building wheel, the `repair` command is refused with
code `repair_removed`; the Support Truck's Field Repair became its passive workshop).

Repair ranking (`actionEngineers.jobScore`): walking distance, distance from home, how damaged the structure is (the
most damaged first, the headquarters first of all), danger (a job within a visible enemy's reach is not taken, one
within 2 hexes of that reach is penalised), the other engineers already on it, and a preference for construction.

Three upgrades, in order, at the headquarters:

| Level | Upgrade | Mechanic | Visual |
|---|---|---|---|
| 1 | Armoured Vests | +60 % health, and they no longer drop their job and run home when shot at (they retreat only below half health) | vests and helmets (128) |
| 2 | Utility Car | Engineers drive a small utility car: x1.8 speed (still on the infantry routes) | the engineer is drawn in a small utility car (131072) |
| 3 | Power Tools | Build, dig and repair x1.5 | tool trailer and generator on the car (8192) |

Cost 150/40, 260/90, 380/160; 20 / 30 / 40 s.

## 6. Perimeter (clicking a perimeter position opens its wheel)

The two perimeter turrets each choose one path at level 1, then deepen it (levels 2, 3; level n needs era n). The
choice is permanent. Cost per level 140/60, 240/120, 360/200; 20 / 28 / 36 s.

| Path | Level 1 | Level 2 | Level 3 | Visual |
|---|---|---|---|---|
| Anti-air | Flak head: engages aircraft (and ground at reduced effect) at range 4.2 | gives the base its built-in anti-aircraft umbrella (the HQ's own flak) | search radar: detects hidden units and aircraft within 5 | twin flak barrels; radar dish at level 3 |
| Anti-infantry | Twin machine guns, range 3.0, heavy suppression | grenade launcher: splash on clustered infantry | searchlight: detects hidden units within 4 and +0.6 range | twin MGs; grenade launcher; searchlight |
| Anti-vehicle | Anti-tank cannon, range 3.2 | sabot: ignores the reactive armour of tanks and pierces fortification | a wire-guided missile launcher (anti-armour missile, reach 3.8) | long cannon; missile box at level 3 |

The perimeter wheel also holds the centre turret and Build / Rebuild perimeter.

Centre turret (provisional): the headquarters' own gun becomes a roof turret. Level 1 High-Explosive Shells (its shots
burst, hitting infantry around the target), level 2 Airburst Fuze (it engages aircraft), level 3 Heavy Gun (range
+0.8, x1.4 damage vs vehicles). 160/60, 280/130, 420/220; 20 / 30 / 40 s. Visual: a turret on the HQ roof, a longer
barrel and a fuze-radar at level 2, a heavy barrel at level 3.

The old perimeter levels (site.defenseLevel 2-3) are refunded on load and the pieces return to level 1.

## 7. Outposts (build wheel: Outpost; "New Base" is removed)

A tiny base: levels 1-3 (its tier, the upgrade wedge on top). One build plot per level (Materials Processor, Energy
Generator or Barracks) placed around it. Tier 1 trains Militia, tier 2 Militia and Scout Buggies (each with its own
per-outpost upgrade, the same lines as at the HQ). No engineers until tier 3, when it gets one. Level costs 200/80 and
320/140. Mechanics of its levels: level 2 adds a second plot and buggies, level 3 a third plot, an engineer and a
radar on the outpost (detects hidden units within 4). Visual: the level props, the plots' facilities, the radar mast.

An older save's New Base under construction is removed and its 1000 Materials refunded.

## 8. AI

`actionAI.js` trains at every producing building (HQ and outposts included, militia in the line role), buys engineer
upgrades first, then unit upgrades for the types it fields most (at the building that trains most of them), building
levels when rich, perimeter paths answering what it sees (air -> anti-air, armour -> anti-vehicle, else
anti-infantry; the second turret complements the first), the centre turret when attacked, and outposts (placed toward
the enemy instead of new bases, upgraded, plots filled with processors and generators). The mechanics are passive or
automatic (no buttons), so the AI uses them by owning them.

## 9. Saves

`persist.js migrateBaseMenu`: queues of units a building no longer trains are dropped and their consumed cost refunded;
New Base sites removed and refunded; perimeter levels refunded; the production order rebuilt from the queues;
unit health rescaled with the unit's own upgrade multiplier. Deterministic (save order, no RNG).
