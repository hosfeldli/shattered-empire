import { BUILDINGS, UNITS } from './constants.js';
import { BUILDING_WEAPON, UNIT_WEAPON } from './weapons.js';

const cost = (materials, energy = 0) => energy ? { materials, energy } : { materials };
const building = (key, name, tier, materials, energy, time, extra = {}) => ({
  name, glyph: BUILDINGS[key]?.glyph || '', cat: BUILDINGS[key]?.cat || 'military', tier, age: tier - 1, cost: cost(materials, energy), time,
  hp: BUILDINGS[key]?.hp || 380, radius: .45, ...extra,
});

export const ACTION_BUILDINGS = {
  town: building('town', 'Headquarters', 1, 400, 120, 30, { hp: 1450, radius: .51, materials: 50 / 60, energy: 8 / 60, vision: 8, attack: 8, range: 2.6, desc: 'The city command center. Local upgrades unlock 4, 6, then 8 ring sites.' }),
  depot: building('depot', 'Materials Processor', 1, 150, 0, 15, { materials: 115 / 60, desc: 'Generates Materials. Competes for a headquarters ring site.' }),
  power_plant: building('power_plant', 'Energy Generator', 1, 160, 30, 18, { energy: 65 / 60, desc: 'Generates Energy for technology and advanced forces.' }),
  barracks: building('barracks', 'Barracks', 1, 170, 0, 17, { desc: 'Trains infantry, engineers and scout buggies.' }),
  motor_works: building('motor_works', 'Vehicle Works', 2, 300, 110, 30, { radius: .57, desc: 'Produces armored cars, infantry carriers and main battle tanks.' }),
  heavy_weapons: building('heavy_assembly', 'Heavy Weapons Facility', 2, 310, 180, 32, { radius: .55, desc: 'Produces artillery, missile vehicles and mobile air defense.' }),
  airfield: building('airfield', 'Airfield', 2, 360, 220, 38, { radius: .45, vision: 7, desc: 'Produces and services aircraft.' }),
  armory: building('armory', 'Armory', 1, 240, 90, 24, { desc: 'Faction-wide military and economic upgrades.' }),
  advanced_lab: building('advanced_lab', 'Advanced Systems Lab', 3, 450, 300, 42, { desc: 'Produces autonomous systems and advanced specialist units.' }),
  missile_silo: building('missile_silo', 'Strategic Missile Facility', 3, 750, 500, 60, { hp: 1250, radius: .5, needs: 'advanced_lab', desc: 'Produces limited strategic missiles in a headquarters ring site.' }),
  barricade: building('bunker', 'Sandbag Barricade', 1, 20, 0, 4, { field: true, radius: .22, hp: 240, cover: .25 }),
  guard_post: building('guard_post', 'Guard Post', 1, 100, 15, 16, { field: true, radius: .26, vision: 6, attack: 10, range: 2.3 }),
  bunker: building('bunker', 'Bunker', 1, 165, 45, 23, { field: true, radius: .32, attack: 14, range: 2.7 }),
  turret: building('bunker', 'Anti-Armor Emplacement', 2, 195, 85, 26, { field: true, radius: .30, attack: 26, range: 3.3, weapon: 'cannon' }),
  aa_battery: building('aa_battery', 'AA Battery', 2, 200, 125, 28, { field: true, radius: .29, attack: 19, range: 5.5, vision: 7 }),
  sensor_post: building('comms_tower', 'Radar / Sensor Post', 2, 140, 85, 22, { field: true, radius: .23, vision: 11 }),
  repair_point: building('depot', 'Forward Repair Station', 2, 165, 70, 28, { field: true, radius: .25, repair: 3.5 }),
  artillery_post: building('fort', 'Artillery Emplacement', 2, 340, 220, 52, { field: true, radius: .38, attack: 29, range: 7.5, weapon: 'howitzer' }),
  fort: building('fort', 'Fortress', 3, 430, 220, 70, { field: true, radius: .56, vision: 8, attack: 34, range: 4.1 }),
};

for (const [key, def] of Object.entries(ACTION_BUILDINGS)) if (!def.weapon) def.weapon = BUILDING_WEAPON[key];
export const BASE_FACILITIES = Object.keys(ACTION_BUILDINGS).filter((key) => key !== 'town' && !ACTION_BUILDINGS[key].field);
export const FIELD_FACILITIES = Object.keys(ACTION_BUILDINGS).filter((key) => ACTION_BUILDINGS[key].field);

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
  rifle_squad: unit('rifle_squad', 'barracks', 1, 90, 0, 2, { ability: 'cover', time: 12 }),
  militia: unit('militia', 'barracks', 1, 70, 0, 2, { ability: 'cover', time: 10 }),
  engineer: unit('engineer', 'barracks', 1, 100, 25, 2, { ability: 'repair', radius: .122, atk: 4, range: 1.2, weapon: 'pistol', defensiveOnly: true, time: 15 }),
  anti_armor: unit('anti_armor', 'barracks', 1, 125, 35, 3, { name: 'Anti-Armor Squad', glyph: 'AT', weapon: 'atgun', atk: 15, range: 3.25, antiBuilding: .72, ability: 'focused_fire', time: 18 }),
  mortar_team: unit('mortar_team', 'barracks', 1, 145, 40, 3, { ability: 'bombard', time: 19 }),
  special_forces: unit('special_forces', 'barracks', 2, 210, 85, 4, { ability: 'infiltrate', time: 23 }),
  exo_infantry: unit('exo_infantry', 'barracks', 3, 335, 180, 5, { ability: 'cover', time: 30 }),
  scout_buggy: unit('scout_buggy', 'barracks', 1, 120, 15, 3, { ability: 'scan', vision: 8.8, time: 17 }),
  armored_car: unit('armored_car', 'motor_works', 2, 180, 50, 4, { ability: 'scan', time: 21 }),
  supply_truck: unit('supply_truck', 'motor_works', 2, 175, 45, 3, { name: 'Support Truck', ability: 'repair', time: 21 }),
  field_gun: unit('field_gun', 'heavy_weapons', 2, 220, 80, 4, { ability: 'focused_fire', time: 24 }),
  mech_infantry: unit('mech_infantry', 'motor_works', 2, 255, 90, 5, { ability: 'focused_fire', time: 26 }),
  tank: unit('tank', 'motor_works', 2, 300, 110, 6, { ability: 'focused_fire', radius: .25, time: 29 }),
  sp_artillery: unit('sp_artillery', 'heavy_weapons', 2, 315, 150, 6, { ability: 'bombard', time: 32 }),
  air_defense: unit('air_defense', 'heavy_weapons', 2, 230, 125, 4, { ability: 'intercept', time: 25 }),
  missile_battery: unit('missile_battery', 'heavy_weapons', 3, 390, 240, 7, { ability: 'bombard', time: 38 }),
  helicopter: unit('helicopter', 'airfield', 2, 350, 165, 6, { ability: 'strike', time: 32 }),
  fighter: unit('fighter', 'airfield', 2, 395, 200, 7, { ability: 'patrol', time: 35 }),
  recon_drone: unit('recon_drone', 'airfield', 2, 145, 85, 2, { ability: 'scan', vision: 10.5, time: 19 }),
  bomber: unit('bomber', 'airfield', 3, 590, 315, 9, { ability: 'strike', time: 46 }),
  oneway_drone: unit('oneway_drone', 'advanced_lab', 3, 155, 105, 2, { ability: 'strike', time: 18 }),
  autonomous_tank: unit('autonomous_tank', 'advanced_lab', 3, 500, 240, 8, { ability: 'focused_fire', radius: .255, time: 42 }),
  strike_swarm: unit('strike_swarm', 'advanced_lab', 3, 420, 265, 7, { ability: 'strike', time: 40 }),
};
for (const [key, def] of Object.entries(ACTION_UNITS)) {
  const factory = ACTION_BUILDINGS[def.facility];
  (factory.trains ??= []).push(key);
}

export const TIERS = [
  { name: 'Reclamation', label: 'I', desc: 'Infantry, reconnaissance and early defenses.' },
  { name: 'Mechanized Warfare', label: 'II', desc: 'Global mechanized technology and two additional local ring sites.', cost: cost(480, 240), time: 40 },
  { name: 'Advanced Warfare', label: 'III', desc: 'Global advanced technology and the final two local ring sites.', cost: cost(1000, 600), time: 65 },
];

export const ACTION_UPGRADES = {
  infantry_training: { name: 'Infantry Training', desc: 'Infantry deal 15% more damage.', tier: 1, time: 25, cost: cost(170, 42) },
  improved_logistics: { name: 'Industrial Efficiency', desc: 'Processors produce 175 Materials/min and generators 100 Energy/min.', tier: 2, time: 30, cost: cost(240, 130) },
  field_engineering: { name: 'Field Engineering', desc: 'Repair and construction progress increases by 25%.', tier: 2, time: 36, cost: cost(255, 90) },
  heavy_armor: { name: 'Heavy Armor', desc: 'Tracked vehicles take 16% less damage.', tier: 2, time: 40, cost: cost(285, 120) },
  aircraft_systems: { name: 'Aircraft Systems', desc: 'Aircraft fly 18% faster.', tier: 2, time: 38, cost: cost(225, 135) },
  networked_command: { name: 'Networked Command', desc: 'Adds 20 command capacity.', tier: 3, time: 52, cost: cost(340, 180) },
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
  supply: { name: 'Materials Relay', benefit: '+30 Materials/min', materials: .5, ruin: 'depot' },
  energy: { name: 'Abandoned Energy Plant', benefit: '+18 Energy/min', energy: .3, ruin: 'power_plant' },
  radar: { name: 'Radar Station', benefit: 'Reveals nearby terrain and units', vision: 10, ruin: 'comms_tower' },
  repair: { name: 'Repair Station', benefit: 'Repairs nearby units', repair: 3, ruin: 'motor_works' },
  defense: { name: 'Defensive Position', benefit: 'Ground forces gain cover within the zone', cover: .27, ruin: 'bunker' },
};

export const ACTION_RESOURCES = ['materials', 'energy'];
export const MISSILE_PROJECT = { cost: cost(480, 380), time: 52, range: 58, radius: 2.7 };

export function actionDefinitions(base) {
  return {
    W: base.W, H: base.H, TERRAIN: base.TERRAIN, ROAD_TYPES: base.ROAD_TYPES, DIFFICULTY: base.DIFFICULTY,
    CIV_COLORS: base.CIV_COLORS, STANCES: base.STANCES, FORMATIONS: base.FORMATIONS, WEAPON_KEYS: base.WEAPON_KEYS,
    AGES: TIERS, TECHS: ACTION_UPGRADES, GOODS: ACTION_RESOURCES, GOOD_NAMES: { materials: 'Materials', energy: 'Energy' },
    RULESET: { id: 'action-v2', ringVersion: 1, slots: [4, 6, 8], commandCapacity: [80, 120, 160], fieldConstruction: 'independent', engineerRequired: false },
    BUILDINGS: ACTION_BUILDINGS, UNITS: ACTION_UNITS, ABILITIES, RUIN_TYPES, OUTPOST_TYPES, MISSILE: MISSILE_PROJECT,
  };
}
