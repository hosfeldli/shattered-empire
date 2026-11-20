// Base menu rework (2026-11-20, docs/gameplay-overhaul/BASE_MENU_REWORK.md): the data tables of the per-building
// upgrades. No imports (actionDefinitions re-exports them and sends them to clients). Every upgrade is a mechanic with a
// visual (`kit`: the equipment bit drawn by the client, unit record extra[7]; bits 24-25 carry the tier).

const r5 = (v) => Math.round(v / 5) * 5;
export const KIT = { reactive: 2, grenades: 32, rockets: 64, armour: 128, smoke: 512, camo: 1024, mast: 2048, exhaust: 4096,
  tools: 8192, ammo: 16384, flares: 32768, pods: 65536, car: 131072, hardpoints: 262144 };
export const KIT_TIER_SHIFT = 24;
const AT_WEAPONS = ['cannon', 'atgun', 'missile', 'rockets', 'drone_strike', 'warhead', 'gau8'];
const AA_WEAPONS = ['flak', 'airburst', 'aam', 'autocannon'];

// One line per unit: `mech` names the mechanic (actionUnitUpgrades.js), `t` its parameters per tier (index 0..2).
export const UNIT_UPGRADE_LINES = {
  militia: { name: 'Rifle Grenades', kit: KIT.grenades, mech: 'grenade', t: [{ damage: 18, cooldown: 7, radius: .45 }, { damage: 24, cooldown: 6, radius: .55 }, { damage: 30, cooldown: 5, radius: .65 }],
    desc: 'The squad lobs rifle grenades at infantry: a small blast that hits every enemy squad bunched around the target.' },
  scout_buggy: { name: 'Spotter Mast', kit: KIT.mast, mech: 'detect', t: [{ detect: 3, vision: .5 }, { detect: 4, vision: 1 }, { detect: 5, vision: 1.5 }],
    desc: 'A telescopic sensor mast: detects camouflaged, infiltrating and smoke-hidden units nearby.' },
  rifle_squad: { name: 'Squad Rockets', kit: KIT.rockets, mech: 'rocket', t: [{ damage: 28, cooldown: 14, range: 2.6 }, { damage: 36, cooldown: 12, range: 2.6 }, { damage: 44, cooldown: 10, range: 2.6 }],
    desc: 'Disposable launchers: the squad fires an anti-armour rocket at vehicles and fortified structures.' },
  anti_armor: { name: 'Ghillie Camouflage', kit: KIT.camo, mech: 'camo', t: [{ delay: 4 }, { delay: 3 }, { delay: 2, ambush: 1.25 }],
    desc: 'Hidden from sight (only detection reveals it) once it has stood still and silent for a few seconds.' },
  mortar_team: { name: 'Heavy HE Rounds', kit: KIT.ammo, mech: 'blast', t: [{ blast: 1.2, supp: 1.5 }, { blast: 1.35, supp: 1.5 }, { blast: 1.5, supp: 1.5 }],
    desc: 'Heavier shells: a wider blast that pins down the squads it catches.' },
  special_forces: { name: 'Body Armour', kit: KIT.armour, mech: 'armour', t: [{ small: .8, supp: .6 }, { small: .7, supp: .45 }, { small: .6, supp: .3 }],
    desc: 'Plate carriers: less small-arms damage, and far less suppression, so they keep firing under fire.' },
  armored_car: { name: 'Smoke Launchers', kit: KIT.smoke, mech: 'smoke', t: [{ cooldown: 45, seconds: 7, wide: 0 }, { cooldown: 35, seconds: 9, wide: 0 }, { cooldown: 25, seconds: 11, wide: 1 }],
    desc: 'When badly hit it fires a smoke screen that hides it and blocks enemy sight through it.' },
  mech_infantry: { name: 'Turbo Diesel', kit: KIT.exhaust, mech: 'sprint', t: [{ mult: 1.35, seconds: 6, cooldown: 24 }, { mult: 1.45, seconds: 6, cooldown: 20 }, { mult: 1.55, seconds: 6, cooldown: 16 }],
    desc: 'Sprints for a few seconds when given a move order, to rush troops through fire.' },
  exo_infantry: { name: 'Field Repair Kit', kit: KIT.tools, mech: 'regen', t: [{ rate: .01 }, { rate: .015 }, { rate: .02 }],
    desc: 'The crew patches the vehicle up whenever it is out of combat.' },
  tank: { name: 'Reactive Armour', kit: KIT.reactive, mech: 'reactive', t: [{ cut: .5, cooldown: 14 }, { cut: .6, cooldown: 11 }, { cut: .7, cooldown: 8 }],
    desc: 'Explosive tiles blunt the first anti-armour hit, then need time to be replaced.' },
  field_gun: { name: 'Camouflage Nets', kit: KIT.camo, mech: 'camo', t: [{ delay: 5 }, { delay: 4 }, { delay: 3, ambush: 1.25 }],
    desc: 'Hidden once it has stood still and silent for a few seconds: an ambush gun.' },
  sp_artillery: { name: 'Airburst Shells', kit: KIT.ammo, mech: 'blast', t: [{ blast: 1.2, supp: 1.5 }, { blast: 1.35, supp: 1.5 }, { blast: 1.5, supp: 1.5 }],
    desc: 'Shells that burst above the target: a wider blast that pins troops down.' },
  air_defense: { name: 'Search Radar', kit: KIT.mast, mech: 'detect', t: [{ detect: 3.5, vision: .5 }, { detect: 4.5, vision: 1 }, { detect: 5.5, vision: 1.5 }],
    desc: 'A search radar: detects hidden units and aircraft around it.' },
  supply_truck: { name: 'Mobile Workshop', kit: KIT.tools, mech: 'aura', t: [{ rate: 4, radius: 2.4 }, { rate: 6, radius: 2.4 }, { rate: 8, radius: 2.6 }],
    desc: 'A crane and workshop: repairs friendly vehicles and structures around it all the time.' },
  helicopter: { name: 'Flares', kit: KIT.flares, mech: 'flares', t: [{ cooldown: 18 }, { cooldown: 14 }, { cooldown: 10 }],
    desc: 'Decoy flares: the first anti-aircraft hit in a while misses.' },
  fighter: { name: 'Hardpoint Rockets', kit: KIT.hardpoints, mech: 'rocket', t: [{ damage: 40, cooldown: 10, range: 2.4 }, { damage: 55, cooldown: 9, range: 2.4 }, { damage: 70, cooldown: 8, range: 2.4 }],
    desc: 'Rocket pods: it fires a rocket at armour during its runs.' },
  recon_drone: { name: 'Thermal Camera', kit: KIT.mast, mech: 'detect', t: [{ detect: 4, vision: .5 }, { detect: 5, vision: 1 }, { detect: 6, vision: 1.5 }],
    desc: 'A thermal sensor ball: detects hidden units below it.' },
  bomber: { name: 'Flares', kit: KIT.flares, mech: 'flares', t: [{ cooldown: 20 }, { cooldown: 16 }, { cooldown: 12 }],
    desc: 'Decoy flares: the first anti-aircraft hit in a while misses.' },
  oneway_drone: { name: 'Shaped Charge', kit: KIT.ammo, mech: 'blast', t: [{ blast: 1.2, supp: 1.5 }, { blast: 1.35, supp: 1.5 }, { blast: 1.5, supp: 1.5 }],
    desc: 'A larger warhead: a wider blast.' },
  autonomous_tank: { name: 'Self-Maintenance', kit: KIT.tools, mech: 'regen', t: [{ rate: .008 }, { rate: .012 }, { rate: .016 }],
    desc: 'Maintenance drones repair the hull whenever it is out of combat.' },
  strike_swarm: { name: 'Extra Munitions', kit: KIT.pods, mech: 'salvo', t: [{ extra: 1, rof: 1 }, { extra: 1, rof: .9 }, { extra: 2, rof: .9 }],
    desc: 'Extra munition pods: more projectiles in every attack.' },
  missile_battery: { name: 'Extra Salvo', kit: KIT.pods, mech: 'salvo', t: [{ extra: 1, rof: 1 }, { extra: 1, rof: .9 }, { extra: 2, rof: .9 }],
    desc: 'Extra launch tubes: more missiles in every salvo.' },
};
export const UPGRADE_TIME = [20, 30, 40];
const TIER_PRICE = [.8, 1.3, 2.0];
/** Price of tier `tier` (1..3) of a unit's line, from the unit's own cost. */
export function unitUpgradeCost(unitCost, tier) {
  const f = TIER_PRICE[tier - 1], out = { materials: r5((unitCost.materials || 0) * f) };
  if (unitCost.energy) out.energy = r5(unitCost.energy * f);
  return out;
}
export const MECH = { AT_WEAPONS, AA_WEAPONS };

// Engineers (per base, bought in order at the headquarters).
export const ENGINEER_UPGRADES = [
  { name: 'Armoured Vests', kit: KIT.armour, cost: { materials: 150, energy: 40 }, time: 20, hp: 1.6, steady: true,
    desc: 'Vests and helmets: +60% health, and engineers stay on the job under fire (they fall back only below half health).' },
  { name: 'Utility Car', kit: KIT.car, cost: { materials: 260, energy: 90 }, time: 30, speed: 1.8,
    desc: 'Engineers drive small utility cars: much faster to every job.' },
  { name: 'Power Tools', kit: KIT.tools, cost: { materials: 380, energy: 160 }, time: 40, build: 1.5,
    desc: 'A tool trailer and generator: build, dig and repair 50% faster.' },
];
export const ENGINEERS_BY_TIER = [3, 5, 8];

// Perimeter turret paths (the two city_turret positions). Level 1 chooses the path; 2 and 3 deepen it.
export const PERIMETER_PATHS = {
  aa: { name: 'Anti-air', weapon: 'flak', attack: 15, range: 4.2, vision: 7,
    levels: ['Flak guns: engage aircraft at long range', 'City air umbrella: the headquarters fires flak too', 'Search radar: detects hidden units and aircraft (5 hexes)'] },
  // 2026-11-20: the base perimeter turret now reaches 3.4 (was 2.6) with vision 7; the paths keep their margin over it
  ai: { name: 'Anti-infantry', weapon: 'mg', attack: 16, range: 3.8, vision: 7,
    levels: ['Twin machine guns: heavy suppression', 'Grenade launcher: blasts clustered infantry', 'Searchlight: detects hidden units (4 hexes), +0.6 range'] },
  av: { name: 'Anti-vehicle', weapon: 'cannon', attack: 24, range: 4.0, vision: 7,
    levels: ['Anti-tank cannon', 'Sabot rounds: defeat reactive armour, pierce fortification', 'Guided missile launcher: an anti-armour missile (reach 4.4)'] },
};
export const PERIMETER_COST = [{ materials: 140, energy: 60 }, { materials: 240, energy: 120 }, { materials: 360, energy: 200 }];
export const PERIMETER_TIME = [20, 28, 36];

// The headquarters' centre turret (provisional, BASE_MENU_REWORK.md §6).
export const CENTRE_TURRET = {
  name: 'Centre turret', provisional: true,
  levels: [
    { name: 'High-Explosive Shells', desc: 'Its shots burst, hitting infantry around the target.', cost: { materials: 160, energy: 60 }, time: 20 },
    { name: 'Airburst Fuze', desc: 'It engages aircraft.', cost: { materials: 280, energy: 130 }, time: 30 },
    { name: 'Heavy Gun', desc: 'Range +0.8 and x1.4 damage against vehicles.', cost: { materials: 420, energy: 220 }, time: 40 },
  ],
};

// Outposts (the 'fort' structure): a tiny base.
export const OUTPOST = { plots: ['depot', 'power_plant', 'barracks'], trainsAt: { militia: 1, scout_buggy: 2 }, engineerLevel: 3, detect: 4,
  levelCost: [{ materials: 200, energy: 80 }, { materials: 320, energy: 140 }], levelTime: [25, 35] };

// Production building levels (the top wedge): veterancy for every unit trained there.
export const BUILDING_LEVEL = { price: [1, 1.6], time: [25, 35], rank: [0, 1, 2],
  desc: 'Instructors and an assembly line: training -15% time per level, and every unit trained here leaves with veterancy (rank 1 at level 2, rank 2 at level 3).' };
