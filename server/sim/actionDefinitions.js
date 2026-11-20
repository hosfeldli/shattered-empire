import { BUILDINGS, UNITS } from './constants.js';
import { BUILDING_WEAPON, UNIT_WEAPON } from './weapons.js';
import { HILL_PACE, MAX_GRADIENT, MAX_SLOPE_DEG } from './actionNavigation.js';   // the climb limits, for the client's hover card (RULESET.mobility)

const cost = (materials, energy = 0) => energy ? { materials, energy } : { materials };
const building = (key, name, tier, materials, energy, time, extra = {}) => ({
  name, glyph: BUILDINGS[key]?.glyph || '', cat: BUILDINGS[key]?.cat || 'military', tier, age: tier - 1, cost: cost(materials, energy), time,
  hp: BUILDINGS[key]?.hp || 380, radius: .45, ...extra,
});

export const ACTION_BUILDINGS = {
  town: building('town', 'Headquarters', 1, 400, 120, 30, { hp: 1450, radius: .51, materials: 140 / 60, energy: 12 / 60, vision: 8, attack: 8, range: 2.6, desc: 'The city command center. Local upgrades unlock 3, 5, then 7 ring sites. Each base keeps its own automatic engineers (2 / 3 / 4 by tier).' }),
  depot: building('depot', 'Materials Processor', 1, 150, 0, 15, { materials: 170 / 60, desc: 'Generates Materials. Competes for a headquarters ring site.' }),
  power_plant: building('power_plant', 'Energy Generator', 1, 160, 30, 18, { energy: 65 / 60, desc: 'Generates Energy for technology and advanced forces.' }),
  barracks: building('barracks', 'Barracks', 1, 170, 0, 17, { desc: 'Trains infantry and scout buggies.' }),
  motor_works: building('motor_works', 'Vehicle Works', 2, 300, 110, 30, { radius: .57, desc: 'Produces armored cars, infantry carriers, infantry fighting vehicles and main battle tanks.' }),
  heavy_weapons: building('heavy_assembly', 'Heavy Weapons Facility', 2, 310, 180, 32, { radius: .55, desc: 'Produces artillery, missile vehicles and mobile air defense.' }),
  airfield: building('airfield', 'Airfield', 2, 360, 220, 38, { radius: .45, vision: 7, desc: 'Produces and services aircraft.' }),
  armory: building('armory', 'Armory', 1, 240, 90, 24, { desc: 'Faction-wide command upgrades: Improved Logistics and Networked Command.' }),
  advanced_lab: building('advanced_lab', 'Advanced Systems Lab', 3, 450, 300, 42, { desc: 'Produces autonomous systems and advanced specialist units.' }),
  missile_silo: building('missile_silo', 'Strategic Missile Facility', 3, 750, 500, 60, { hp: 1250, radius: .5, needs: 'advanced_lab', desc: 'Produces limited strategic missiles in a headquarters ring site.' }),
  barricade: building('bunker', 'Sandbag Barricade', 1, 20, 0, 4, { field: true, radius: .26, width: .50, depth: .34, lowCover: true, hp: 240, cover: .25, desc: 'Rotatable sandbags, wire and tank obstacles. Infantry can shelter and fire over the low wall. Q / E rotates before placement.' }),
  city_turret: building('guard_post', 'Perimeter Turret', 1, 85, 20, 20, { field: true, radius: .14, hp: 360, vision: 6, attack: 13, range: 2.6, weapon: 'mg', desc: 'A short-range machine-gun turret. Effective against exposed infantry; vulnerable to armor and artillery.' }),
  guard_post: building('guard_post', 'Watchtower', 1, 100, 15, 16, { field: true, radius: .18, vision: 6, attack: 10, range: 2.3, claims: 1,
    desc: 'A compact machine-gun watchtower. Claims the hexes around it as territory.' }),
  // 2026-11-18 (user: "longer bursts"): the bunker MG fires sustained bursts (actionCombat.fire, `burst`): `shots` rounds
  // `gap` s apart, then `rest` s; each round does `share` of a volley. Cycle 1.5 + 2.7 = 4.2 s on the structure cadence.
  // attack 14 -> 16: sustained DPS 12.8 -> 14.7 (it trailed the 85/20 perimeter turret's 11.9 at twice the price).
  bunker: building('bunker', 'Bunker', 1, 165, 45, 23, { field: true, radius: .32, attack: 16, range: 2.7, claims: 1, burst: { shots: 6, gap: .3, rest: 2.7, share: .39 } }),
  turret: building('bunker', 'Anti-Armor Emplacement', 2, 195, 85, 26, { field: true, radius: .30, attack: 26, range: 3.3, weapon: 'cannon', claims: 1 }),
  aa_battery: building('aa_battery', 'AA Battery', 2, 200, 125, 28, { field: true, radius: .29, attack: 19, range: 5.5, vision: 7, claims: 1 }),
  sensor_post: building('comms_tower', 'Radar / Sensor Post', 2, 140, 85, 22, { field: true, radius: .23, vision: 11 }),
  repair_point: building('depot', 'Forward Repair Station', 2, 165, 70, 28, { field: true, radius: .25, repair: 3.5 }),
  artillery_post: building('fort', 'Artillery Emplacement', 2, 340, 220, 52, { field: true, radius: .38, attack: 29, range: 7.5, weapon: 'howitzer', claims: 1 }),
  fort: building('fort', 'Outpost', 2, 300, 90, 45, { field: true, radius: .45, vision: 8, attack: 26, range: 3.6, claims: 2,
    desc: 'A fortified outpost. Claims the hexes within two of it as territory, extending where you can build.' }),
  // Placed from the build wheel anywhere in your own territory on or beside a road. When the engineers
  // finish it, it becomes a real base site: the placeholder is replaced by a headquarters with its own ring.
  base_site: building('town', 'New Base', 1, 1000, 0, 60, { field: true, radius: .5, hp: 900, newBase: true,
    desc: 'Founds a new base in your territory, on or beside a road and clear of other bases. Engineers build it; it becomes a headquarters with its own ring sites.' }),
};

for (const [key, def] of Object.entries(ACTION_BUILDINGS)) if (!def.weapon) def.weapon = BUILDING_WEAPON[key];
// Fortified structures resist small arms and light explosives (actionCombat.structureArmour, 2026-11-17).
for (const key of ['town', 'barricade', 'city_turret', 'guard_post', 'bunker', 'turret', 'aa_battery', 'artillery_post', 'fort', 'missile_silo'])
  ACTION_BUILDINGS[key].armor = 'fortified';
// Ring of influence (2026-11-17). Defensive structures (`def.defense`: anything armed, plus barricades) may be
// placed on your own territory or on neutral ground (never in another player's territory); every other build-wheel
// structure stays territory-only. The ring of influence is your territory plus `reach` hexes beyond its border:
// inside it a defense costs its listed price, outside it `factor` times that. Support posts (radar, repair) and a
// New Base are never surcharged. Computed by actionBases.influenceRing: a BFS from every owned hex, capped at reach + 1.
// 2026-11-18 (user): reach 8 -> 3 hexes; the client draws its edge with the territory border shading (TerritoryField).
export const DEFENSE_INFLUENCE = { reach: 3, factor: 3, note: 'Outside your influence: ×3 cost' };
for (const def of Object.values(ACTION_BUILDINGS)) if (def.field && !def.newBase && (def.attack || def.lowCover)) def.defense = true;
// W2 neutral infrastructure (overhaul §13, 2026-11-17): non-defensive support structures flagged `neutral` may also
// go on neutral ground (never another player's territory). They claim no territory (no `claims`), and like defenses
// they cost DEFENSE_INFLUENCE.factor × beyond the ring of influence. A New Base stays territory-only.
for (const key of ['sensor_post', 'repair_point']) ACTION_BUILDINGS[key].neutral = true;
// W2 placement leniency (overhaul §14, 2026-11-17), used by actionBases.constructDefense:
//  slope      rotated footprints: allowed |Δelev| between a footprint sample's hex and the centre hex is
//             base + perSpan × the footprint's half-diagonal (a sandbag wall: .10 + .30 × .30 ≈ .19; was a flat .10,
//             which refused ~14% of adjacent land hex pairs on hills)
//  edge       water / cliff samples are taken at this fraction of the radius (obstacles still at the full radius)
//  hubMargin  extra clearance beyond a site's capture radius (was .10)
//  parcelMargin clearance from a planned ring parcel's centre (the largest facility radius .57 + .03; was .62)
//  hostileHq  keep-out from an enemy headquarters (unchanged)
//  contest    radius of the hostile-troops check (unchanged)
//  roadClear  (2026-11-18) a defense other than the sandbag barricade keeps its disc this far beyond the centre line of
//             every road edge (the widest road's half-width .31 + .04), and never stands on a road hex
//  snapHexes  (2026-11-18) a refused structure moves to the nearest valid hex centre within this many hexes (actionBases
//             snapCandidates, SNAP_CODES)
export const PLACEMENT = { slope: { base: .10, perSpan: .30 }, edge: .75, hubMargin: .04, parcelMargin: .60, hostileHq: 2.65, contest: .75, roadClear: .35, snapHexes: 2 };
// W2 capture (requirement R7, 2026-11-17). `base` / `outpost`: seconds of uncontested presence to capture a city
// ruin / an outpost. `decay`: seconds for abandoned progress to fall from full to zero (no grace period). A
// non-allied new claimant first drains the previous claimant's progress at the same rate, then builds its own.
// Contested zones freeze progress (no gain, no decay).
export const CAPTURE = { base: 20, outpost: 12, decay: 15 };
// W4 garrison (requirement R4, 2026-11-17; actionGarrison.js, docs/gameplay-overhaul/CAPTURE_AND_GARRISON.md).
// def.garrison: squads the structure shelters; def.firingSlots: how many of them (the first to enter) fire out.
// Only capture-capable infantry squads (rifle, militia, anti-armor, special forces) may enter, one slot each.
//  reach       enter when within the structure's radius + reach (world units)
//  protection  occupants take this much less of a blast that hits their structure (direct fire cannot reach them)
//  rangeBonus  range added to a firing occupant's weapon; fireBonus: its damage multiplier (steadier aim)
//  ejectDamage share of max HP an occupant loses when its structure is destroyed and it is thrown out
export const GARRISON = { reach: .9, protection: .6, rangeBonus: .6, fireBonus: 1.15, ejectDamage: .3 };
for (const [key, garrison, firingSlots] of [['town', 4, 2], ['fort', 4, 3], ['bunker', 2, 2], ['guard_post', 1, 1], ['barracks', 3, 0]])
  Object.assign(ACTION_BUILDINGS[key], { garrison, firingSlots });
export const BASE_FACILITIES = Object.keys(ACTION_BUILDINGS).filter((key) => key !== 'town' && !ACTION_BUILDINGS[key].field);
export const FIELD_FACILITIES = Object.keys(ACTION_BUILDINGS).filter((key) => ACTION_BUILDINGS[key].field);
export const CITY_DEFENSES = { name: 'City perimeter', cost: cost(240, 60), time: 25, pieces: 6,
  desc: 'Constructs four sandbag positions and two machine-gun turrets outside the building ring. Uses no development sites. Missing positions can be rebuilt at proportional cost.',
  // Perimeter upgrades (command `upgradeDefenses`): level 2 and 3, each needing the matching era. From
  // level 2 the city has built-in anti-aircraft fire (site.defenseLevel >= CITY_DEFENSES.aaLevel).
  upgrade: { max: 3, aaLevel: 2, cost: [cost(260, 140), cost(420, 240)], time: [25, 35],
    desc: 'Hardens every perimeter position (+30% health, +25% firepower per level). Level 2 adds built-in city anti-aircraft fire.' } };

// Era upgrades bought on an individual building (command `upgradeBuilding`). A building starts at level 1;
// each global era unlocks one more level (era II: level 2, era III: level 3). cost[i] / time[i] buy level i + 2.
const LEVELS = {
  output: { desc: 'Output +40% per level.' },
  production: { desc: 'Training time -15% per level.' },
  defense: { desc: 'Health +30%, firepower +25% and range +0.35 per level.' },
};
const levelCost = (def, f) => cost(Math.round(def.cost.materials * f / 5) * 5, Math.round((def.cost.energy || 0) * f / 5) * 5);
for (const [key, def] of Object.entries(ACTION_BUILDINGS)) {
  const effect = ['depot', 'power_plant'].includes(key) ? 'output' : ['barracks', 'motor_works', 'heavy_weapons', 'airfield', 'advanced_lab'].includes(key) ? 'production'
    : def.field && def.attack ? 'defense' : key === 'barricade' ? 'defense' : null;
  if (effect) def.levels = { max: 3, effect, desc: LEVELS[effect].desc, cost: effect === 'output' ? [levelCost(def, 1), levelCost(def, 1.6)] : [levelCost(def, .5), levelCost(def, .8)], time: [20, 30] };
}

function unit(key, facility, tier, materials, energy, capacity, extra = {}) {
  const old = UNITS[key] || UNITS.rifle_squad;
  return { name: old.name, glyph: old.glyph, move: old.move, cat: old.cat, air: !!old.air, alt: old.alt, tier, age: tier - 1, facility,
    cost: cost(materials, energy), capacity, time: old.time, hp: old.hp, atk: old.atk, def: old.def,
    vision: old.vision * 1.55 + 1, speed: old.speed * (old.air ? 1.27 : .92), range: old.range * 1.17 + .45,
    radius: old.move === 'infantry' ? .139 : old.air ? .14 : old.move === 'tracked' ? .235 : .193,
    weapon: UNIT_WEAPON[key], antiBuilding: old.vsBuildings || (old.move === 'infantry' && old.cat !== 'artillery' ? .38 : old.move === 'wheeled' ? .60 : 1), capture: old.move === 'infantry' && old.cat !== 'artillery',
    ...extra,
  };
}

export const ACTION_UNITS = {
  // W3 (2026-11-17): 12 men (was 8): 80 -> 90 materials, atk 9 -> 12 (per-man fire with range falloff), 12 -> 10 s
  // 2026-11-18 (user: "disposable grunts"): 90 -> 65 materials, atk 12 -> 9, 10 -> 7 s, 14 -> 9 HP per man (168 -> 108)
  rifle_squad: unit('rifle_squad', 'barracks', 1, 65, 0, 2, { ability: 'cover', time: 7, atk: 9 }),
  // W3: 10 men (was 6): 54 -> 60 materials, atk 6 -> 9, 10 -> 8 s (the cheapest, fastest way to hold ground)
  // 2026-11-18: 60 -> 40 materials, atk 9 -> 6, 8 -> 5 s, 13 -> 8 HP per man (130 -> 80)
  militia: unit('militia', 'barracks', 1, 40, 0, 2, { ability: 'cover', time: 5, atk: 6 }),
  // Not trainable: every base fields its own automatic engineers (actionEngineers.js), free and uncommandable.
  engineer: unit('engineer', 'barracks', 1, 100, 25, 2, { ability: 'repair', radius: .122, atk: 4, range: 1.2, weapon: 'pistol', defensiveOnly: true, time: 15, auto: true }),
  // W3: 5 men (was 3): 100/25 -> 110/30, atk 15 -> 18, 18 -> 16 s
  anti_armor: unit('anti_armor', 'barracks', 1, 110, 30, 3, { name: 'Anti-Armor Squad', glyph: 'AT', weapon: 'atgun', atk: 16, range: 3.25, antiBuilding: .72, ability: 'focused_fire', time: 15 }),   // 2026-11-18: atk 18 -> 16, 16 -> 15 s, 26 -> 22 HP per man
  // 2026-11-17: mortar 120/30 -> 150/45, fires every 4.5 s (was 3.0), 80 -> 120 HP (40 per man), shell atk 13 -> 15
  // (sustained fire -23%: a heavier, slower bomb that still digs entrenched infantry out)
  mortar_team: unit('mortar_team', 'barracks', 1, 150, 45, 3, { ability: 'bombard', time: 21, fireCooldown: 4.5, hp: 120, atk: 15 }),
  // W3: 8 men (was 5; hp 196 -> 240): 125/40 -> 140/45, atk 19 -> 26, capacity 4 -> 3, 23 -> 20 s
  // 2026-11-18: atk 26 -> 24, 30 -> 26 HP per man (240 -> 208); cost and time unchanged (it stays the elite squad)
  special_forces: unit('special_forces', 'barracks', 2, 140, 45, 3, { ability: 'infiltrate', time: 20, atk: 24 }),
  // 2026-11-18 (user: "make them more like a Bradley"): the exo-armored squad is now an Infantry Fighting Vehicle. The key
  // stays `exo_infantry` (saves, AI, client tables). Tracked hull from the Vehicle Works, tier II (was a tier III barracks
  // squad: 260/130, 6 men x 85 HP, atk 44): 235/85 (tuned from 215/75 after the sims; the carrier is 195/65, the tank 235/80), capacity 5, 27 s,
  // 240 HP (tuned from 270), def 15, autocannon atk 15 (tuned from 18; 4-seed sims: value ratio 2.90, the tank's) (infantry, light vehicles, low aircraft) and a TOW-style missile (`atgm`, fired by
  // actionCombat.fireAtgm at armour or fortified structures in reach): 62 damage, 10 s reload, reach 3.6 (the tank's gun
  // reaches 2.8). No dismount squad. It does not clear forest (a light hull) and takes the vehicle upgrade line.
  exo_infantry: unit('exo_infantry', 'motor_works', 2, 235, 85, 5, { name: 'Infantry Fighting Vehicle', glyph: 'IF', move: 'tracked', cat: 'tracked',
    ability: 'focused_fire', time: 27, hp: 240, def: 15, atk: 15, weapon: 'autocannon', range: 3.0, speed: 1.0, radius: .235, antiBuilding: 1, capture: false,
    atgm: { damage: 62, cooldown: 10, range: 3.6 } }),
  scout_buggy: unit('scout_buggy', 'barracks', 1, 85, 10, 3, { ability: 'scan', vision: 8.8, time: 17 }),
  armored_car: unit('armored_car', 'motor_works', 2, 125, 30, 4, { ability: 'scan', time: 21 }),
  supply_truck: unit('supply_truck', 'motor_works', 2, 140, 35, 3, { name: 'Support Truck', ability: 'repair', time: 21 }),
  field_gun: unit('field_gun', 'heavy_weapons', 2, 170, 60, 4, { ability: 'focused_fire', time: 24, hp: 130, atk: 27 }), // W2: hp 90 -> 130; 2026-11-17: atk 24 -> 27 (tanks gained HP)
  mech_infantry: unit('mech_infantry', 'motor_works', 2, 195, 65, 5, { ability: 'focused_fire', time: 26 }),
  tank: unit('tank', 'motor_works', 2, 235, 80, 6, { ability: 'focused_fire', radius: .25, time: 29, hp: 330, vsInfantry: 1.25 }), // 2026-11-17: hp 280 -> 330, HE vs infantry
  sp_artillery: unit('sp_artillery', 'heavy_weapons', 2, 250, 115, 6, { ability: 'bombard', time: 32 }),
  air_defense: unit('air_defense', 'heavy_weapons', 2, 180, 95, 4, { ability: 'intercept', time: 25 }),
  missile_battery: unit('missile_battery', 'heavy_weapons', 3, 310, 185, 7, { ability: 'bombard', time: 38 }),
  helicopter: unit('helicopter', 'airfield', 2, 280, 130, 6, { ability: 'strike', time: 32 }),
  // 'fighter' is the Warthog (id kept for saves and the protocol): strafing runs with a 30 mm cannon
  // (actionFlight.js), ground targets only, slow for a jet and fragile under anti-aircraft fire
  fighter: unit('fighter', 'airfield', 2, 315, 160, 7, { ability: 'gun_run', strafe: true, aaVulnerable: 1.35, time: 35,
    desc: 'Ground-attack jet. Strafing runs with a 30 mm rotary cannon shred armor and troops along the line of the pass. Cannot engage aircraft; slow and fragile under air defense.' }),
  recon_drone: unit('recon_drone', 'airfield', 2, 115, 65, 2, { ability: 'scan', vision: 10.5, time: 19 }),
  bomber: unit('bomber', 'airfield', 3, 470, 250, 9, { ability: 'strike', time: 46 }),
  oneway_drone: unit('oneway_drone', 'advanced_lab', 3, 125, 80, 2, { ability: 'strike', time: 18 }),
  autonomous_tank: unit('autonomous_tank', 'advanced_lab', 3, 340, 150, 8, { ability: 'focused_fire', radius: .255, time: 42, hp: 480, vsInfantry: 1.2 }), // 2026-11-17: hp 420 -> 480, HE vs infantry
  strike_swarm: unit('strike_swarm', 'advanced_lab', 3, 335, 210, 7, { ability: 'strike', time: 40 }),
};
// Aircraft cross the (larger) battlefield noticeably faster than any ground force, scaled by role:
// one-way drones fastest, then bombers and the Warthog (slow for a jet: 2.3 x 1.27 x 1.3 = 3.8, was the 6.5
// fighter), with helicopters and swarms as the slow low-level
// attackers. Resulting speeds (hexes/s): Warthog 3.8, oneway 5.5, swarm 4.5, recon 4.3, bomber 4.2, helicopter 3.4.
const AIR_PACE = { fighter: 1.3, oneway_drone: 1.55, bomber: 1.5, recon_drone: 1.4, strike_swarm: 1.35, helicopter: 1.35 };
for (const [key, pace] of Object.entries(AIR_PACE)) ACTION_UNITS[key].speed *= pace;
// Endurance in seconds of flight (actionAir.js fuel): aircraft refuel at an airfield or headquarters.
const AIR_FUEL = { fighter: 51, bomber: 76, helicopter: 102, recon_drone: 42, strike_swarm: 38, oneway_drone: 30 };
for (const [key, fuel] of Object.entries(AIR_FUEL)) ACTION_UNITS[key].fuel = fuel;
// Crew-served weapons must stop and set up before their first shot (seconds).
// W2: the field gun sets up in 1.5 s (was 3: tanks closed its whole range advantage while it set up) and,
// as a direct-fire gun, holds its position for `setupHold` s after a shot so it retargets instead of packing up.
ACTION_UNITS.mortar_team.setup = 2.5;
ACTION_UNITS.field_gun.setup = 1.5;
ACTION_UNITS.field_gun.setupHold = 3.2;
// 2026-11-19 (user: "make it so that missile trucks need to setup"): the missile battery halts, lowers its stabilisers
// and raises the launch rails before its first salvo; moving off packs it up again.
ACTION_UNITS.missile_battery.setup = 5;
// 2026-11-19 (user: "decrease indirect fire units damage and fire rate"): mortar team, self-propelled artillery and
// missile battery hit 15 % softer and fire 20 % slower (sustained damage x0.71). Per-unit fireCooldown overrides the
// weapon's cooldown (actionCombat.fire); the artillery emplacement building keeps the howitzer profile.
for (const [key, base] of [['mortar_team', 4.5], ['sp_artillery', 3.5], ['missile_battery', 4.0]]) {
  const d = ACTION_UNITS[key];
  d.atk = Math.round(d.atk * .85);
  d.fireCooldown = +(base * 1.2).toFixed(2);
}
// 2026-11-19 (user: "make it so that missile trucks cannot attack close in troops"): a minimum range (hexes) inside
// which nothing is engaged, by auto-fire, attack orders (the battery backs off: actionOrders.chase) or Area
// Bombardment. 3.5 = ~36% of its 9.8 reach: everything that closes to direct-fire distance (tank 2.8, IFV missile
// 3.6, AT squads 3.25) is inside the dead zone, so the battery needs an escort, while its own sight (~5.7) still
// leaves it a band to defend itself in.
ACTION_UNITS.missile_battery.minRange = 3.5;
for (const [key, def] of Object.entries(ACTION_UNITS)) {
  if (def.auto) continue;
  const factory = ACTION_BUILDINGS[def.facility];
  (factory.trains ??= []).push(key);
}
// Production scheduler (W1, actionProduction.js): each producing building has one capacity budget of
// `production` work units per simulation second (scaled by site bonus and era level) shared by its per-unit-type
// queues; an item needs ACTION_UNITS[type].time work units. maxQueued caps the items queued per building.
export const PRODUCTION = { maxQueued: 20, priorities: ['low', 'normal', 'high'] };
for (const def of Object.values(ACTION_BUILDINGS)) if (def.trains) def.production ??= 1;
// Squads are made of men (shared with E for balance, J for visuals): maxHp = men × HP per man. Men die one at a
// time (actionUpgrades.squadHit: the wounded man first, a hit killing at most its weapon's cap) and a squad's
// firepower is its living men × the per-man weapon (squadFirepower). The client draws unit extra[8] = living men.
// W3 (2026-11-17, user decision R3: squads stay single entities, with more men): rifle 8 -> 12, militia 6 -> 10,
// special forces 5 -> 8, exo 4 -> 6, anti-armor 3 -> 5, mortar 3 -> 4. HP per man stays near its old value
// (rifle 14, militia 13 (was 15), special forces 30 (was 39), exo 85 (was 100), anti-armor 26 (was 33), mortar 30
// (was 40; the team keeps its 120 HP)), so squads are tougher but every hit still costs men.
// 2026-11-18 (user: infantry are cheap, disposable grunts): HP per man rifle 14 -> 9 (168 -> 108), militia 13 -> 8
// (130 -> 80), special forces 30 -> 26 (240 -> 208), anti-armor 26 -> 22 (130 -> 110); mortar 30 unchanged.
// exo_infantry left both tables: it is an Infantry Fighting Vehicle now (no men, no squad casualties).
export const SQUAD_MEN = { rifle_squad: 12, militia: 10, special_forces: 8, anti_armor: 5, mortar_team: 4, engineer: 1 };
export const SQUAD_HP_PER_MAN = { rifle_squad: 9, militia: 8, special_forces: 26, anti_armor: 22, mortar_team: 30 };
for (const [key, men] of Object.entries(SQUAD_MEN)) ACTION_UNITS[key].men = men;
for (const [key, per] of Object.entries(SQUAD_HP_PER_MAN)) ACTION_UNITS[key].hp = SQUAD_MEN[key] * per;
// Heavy tracked hulls flatten forest they drive through (battlefield.js forest clearing, R5).
for (const key of ['tank', 'autonomous_tank', 'sp_artillery']) ACTION_UNITS[key].clearsForest = true;

export const TIERS = [
  { name: 'Reclamation', label: 'I', desc: 'Infantry, reconnaissance and early defenses.' },
  { name: 'Mechanized Warfare', label: 'II', desc: 'Global mechanized technology and two additional local ring sites.', cost: cost(480, 240), time: 40 },
  { name: 'Advanced Warfare', label: 'III', desc: 'Global advanced technology and the final two local ring sites.', cost: cost(1000, 600), time: 65 },
];

// Faction-wide command upgrades, researched at the Armory (actionBases.startUpgrade). Functional: each changes
// behaviour rather than adding a flat percentage.
// 2026-11-19 (user: "Remove the upgrade system for troops"): the troop upgrades, one per unit class (infantry kit at
// the barracks, Infantry Training, Heavy Armor, Field Engineering, Aircraft Systems; UPGRADES.md), are gone. Their
// research is refused (code 'upgrade_removed'); an older save refunds each one owned or in progress
// (persist.js, REMOVED_UPGRADES). The two command upgrades below stay.
export const ACTION_UPGRADES = {
  improved_logistics: { name: 'Improved Logistics', desc: 'Reinforcements leaving a base move 35% faster until they reach their rally point (up to 45 s).', tier: 2, time: 30, cost: cost(240, 130) },
  networked_command: { name: 'Networked Command', desc: 'Units share a vision net: every unit and structure sees 1.5 hexes further and spots hidden units within 2.5 hexes.', tier: 3, time: 52, cost: cost(340, 180) },
};
// The removed troop upgrades and what each cost (refunded to an older save that owned it or had it in progress).
export const REMOVED_UPGRADES = {
  infantry_training: { name: 'Infantry Training', cost: cost(170, 42) },
  field_engineering: { name: 'Field Engineering', cost: cost(255, 90) },
  heavy_armor: { name: 'Heavy Armor', cost: cost(285, 120) },
  aircraft_systems: { name: 'Aircraft Systems', cost: cost(225, 135) },
  grenades: { name: 'Hand Grenades', cost: cost(60, 110) },
  rocket_teams: { name: 'Rocket Teams', cost: cost(80, 150) },
  body_armor: { name: 'Body Armour', cost: cost(110, 190) },
  marksmen: { name: 'Designated Marksmen', cost: cost(100, 160) },
};

export const ABILITIES = {
  cover: { name: 'Take Cover', cooldown: 23, duration: 8, desc: 'Reduce incoming ground fire while holding position.' },
  repair: { name: 'Field Repair', cooldown: 28, desc: 'Restore nearby friendly units and structures. Repair nearby roads or bridges for 20 materials per segment; clear nearby wrecks for 10 materials each.' },
  scan: { name: 'Recon Scan', cooldown: 32, duration: 9, desc: 'Extend vision and detect hidden units.' },
  focused_fire: { name: 'Focused Fire', cooldown: 28, duration: 8, desc: 'Increase damage while engaging a target.' },
  bombard: { name: 'Area Bombardment', cooldown: 27, point: true, desc: 'Fire an area attack at a position in range.' },
  intercept: { name: 'Priority Intercept', cooldown: 26, duration: 9, desc: 'Increase range and damage against aircraft.' },
  patrol: { name: 'Air Superiority Patrol', cooldown: 22, point: true, desc: 'Patrol the selected airspace for enemy aircraft.' },
  strike: { name: 'Targeted Strike', cooldown: 25, point: true, desc: 'Fly to the target and strike the selected area.' },
  gun_run: { name: 'Gun Run', cooldown: 20, point: true, desc: 'Strafe ground forces around the selected point: repeated cannon passes until nothing is left there.' },
  infiltrate: { name: 'Tactical Infiltration', cooldown: 31, duration: 12, desc: 'Remain concealed until firing or detected at close range.' },
};

export const RUIN_TYPES = [
  { key: 'town', name: 'Provincial Town', ruin: 'suburb', slots: 4, expansion: 4, bonus: 'Quick headquarters construction' },
  { key: 'industrial', name: 'Industrial City', ruin: 'plant', slots: 4, expansion: 4, bonus: 'Vehicle production is 12% faster' },
  { key: 'metro', name: 'Metropolitan Ruins', ruin: 'city', slots: 4, expansion: 4, bonus: 'Headquarters has 15% more health' },
  { key: 'military', name: 'Military Installation', ruin: 'fort', slots: 4, expansion: 4, bonus: 'Infantry training is 12% faster' },
  { key: 'coastal', name: 'Coastal City', ruin: 'port', slots: 4, expansion: 4, bonus: 'Aircraft production is 12% faster' },
  { key: 'research', name: 'Research Complex', ruin: 'academy', slots: 4, expansion: 4, bonus: 'Military upgrades finish 12% faster' },
];
export const OUTPOST_TYPES = {
  supply: { name: 'Materials Relay', benefit: '+90 Materials/min', materials: 1.5, ruin: 'depot' },
  energy: { name: 'Abandoned Energy Plant', benefit: '+30 Energy/min', energy: .5, ruin: 'power_plant' },
  radar: { name: 'Radar Station', benefit: 'Reveals nearby terrain and units', vision: 10, ruin: 'comms_tower' },
  repair: { name: 'Repair Station', benefit: 'Repairs nearby units', repair: 3, ruin: 'motor_works' },
  defense: { name: 'Defensive Position', benefit: 'Ground forces gain cover within the zone', cover: .27, ruin: 'bunker' },
};

export const ACTION_RESOURCES = ['materials', 'energy'];
// 2026-11-18 (user): strategic missiles cost 3x (was 480 / 380). No separate missile-defense building; interception
// stays with aa_battery / air_defense (actionCombat MISSILE_DEFENSE). The missile_battery vehicle is unchanged.
// 2026-11-19 (user: "nukes barely do any damage considering how expensive they are"): a strategic warhead is now
// devastating (docs/gameplay-overhaul/NUKES.md). Was one flat 480 damage within 2.7, falling to a third at the rim
// (a headquarters lost a third of its HP). Now everything within `core` takes the full blast, which then falls off
// smoothly (nukeFalloff) to `edge` of it at `radius`, nothing beyond. Units take `damage` x falloff; structures lose a
// share of their own max HP: `structure` x falloff (ring facilities and defenses in the core are destroyed), a
// headquarters `hq` x falloff (a direct hit leaves the command centre on a tenth of its HP with the city around it
// gone). `radius` is the outer ring: the AI's own-forces safety check and the client's targeting circle use it.
export const MISSILE_PROJECT = { cost: cost(1440, 1140), time: 52, range: 58, radius: 7.5, core: 3.2, damage: 1500,
  structure: 1.05, hq: .9, edge: .1, falloff: 1.6 };
/** Share of the full strategic blast `d` world units from ground zero: 1 in the core, `edge` at the rim, 0 beyond. */
export function nukeFalloff(d, m = MISSILE_PROJECT) {
  if (d <= m.core) return 1;
  if (d > m.radius) return 0;
  const t = (d - m.core) / (m.radius - m.core);
  return m.edge + (1 - m.edge) * (1 - t) ** m.falloff;
}
// A new base keeps this distance (world units) from every other base site, and 3.5 from outposts.
export const NEW_BASE_GAP = 5;
// Terrain works (command `terrain`): engineers reshape ground in your own territory or on neutral ground (W2,
// 2026-11-17: `neutral`; never another player's territory). A legacy single-point order
// reshapes the 7 hexes around the point for `cost` / `time`; a brush stroke (`points` + `radius` 0..maxRadius) covers
// every hex within `radius` of the stroke (at most maxHexes) and costs `cost` / `time` per 7 hexes (minimum minCost).
export const TERRAIN_WORKS = { ops: ['raise', 'lower', 'flatten', 'smooth'], cost: cost(60), time: 6, step: .06, min: .02, max: .5,
  maxRadius: 2, maxHexes: 60, minCost: 10, neutral: true,
  desc: 'Engineers raise, lower, flatten or smooth the ground in your territory or on neutral ground: drag a brush stroke across visible open ground (never water, never into mountains). The cost grows with the hexes painted.' };

// W2 (2026-11-16): decisive domination (default 'domination' scenario). From minute 18, a team that holds at least
// 65% of the operational headquarters while fielding at least 2.5x the army value of all its rivals together, for
// 90 s without a break, wins; its rivals are warned when the countdown starts. Before this a beaten side with a few
// scattered bases kept the match alive to the 30-minute cap in 27 of 30 balance sims.
export const DOMINANCE = { after: 1080, hqShare: .65, armyRatio: 2.5, hold: 90 };

export function actionDefinitions(base) {
  // per unit type, the steepest slope it climbs in degrees (actionNavigation MAX_SLOPE_DEG by movement class; null for
  // aircraft), for the client's hover card. Set here, at call time: actionNavigation imports this module.
  for (const d of Object.values(ACTION_UNITS)) d.maxSlope = d.air ? null : MAX_SLOPE_DEG[d.move] ?? null;
  return {
    W: base.W, H: base.H, TERRAIN: base.TERRAIN, ROAD_TYPES: base.ROAD_TYPES, DIFFICULTY: base.DIFFICULTY,
    CIV_COLORS: base.CIV_COLORS, STANCES: base.STANCES, FORMATIONS: base.FORMATIONS, WEAPON_KEYS: base.WEAPON_KEYS,
    AGES: TIERS, TECHS: ACTION_UPGRADES, CITY_DEFENSES, GOODS: ACTION_RESOURCES, GOOD_NAMES: { materials: 'Materials', energy: 'Energy' },
    RULESET: { id: 'action-v2', ringVersion: 1, cancelConstruction: true, upgradeLines: false, cancelResearch: true, placementSnap: 2, slots: [3, 5, 7], commandCapacity: [80, 120, 160], fieldConstruction: 'engineers', engineerRequired: false,
      autoEngineers: [2, 3, 4], territoryBuild: true, newBase: { type: 'base_site', cost: ACTION_BUILDINGS.base_site.cost, minGap: NEW_BASE_GAP },
      terrain: TERRAIN_WORKS, dominance: DOMINANCE, influence: DEFENSE_INFLUENCE, capture: CAPTURE, garrison: GARRISON,
      // 2026-11-19 (client hover card: "slopes needed for pathfinding"): steepest climbable gradient (rise over run) per
      // movement class, wide-river flow, and who wades; read live from the navigation so the card never goes stale
      mobility: { maxGradient: { ...MAX_GRADIENT }, wadeInfantry: true, wideRiverNeedsBridge: ['wheeled', 'tracked'],
        // HILLS_MOUNTAINS (2026-11-19): mountains and peaks are walls for every ground class; infantry climb hills slower
        impassableTerrain: ['mountain', 'peak'], hillPace: { ...HILL_PACE } } },
    BUILDINGS: ACTION_BUILDINGS, UNITS: ACTION_UNITS, ABILITIES, RUIN_TYPES, OUTPOST_TYPES, MISSILE: MISSILE_PROJECT,
  };
}
