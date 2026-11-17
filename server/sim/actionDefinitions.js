import { BUILDINGS, UNITS } from './constants.js';
import { BUILDING_WEAPON, UNIT_WEAPON } from './weapons.js';

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
  motor_works: building('motor_works', 'Vehicle Works', 2, 300, 110, 30, { radius: .57, desc: 'Produces armored cars, infantry carriers and main battle tanks.' }),
  heavy_weapons: building('heavy_assembly', 'Heavy Weapons Facility', 2, 310, 180, 32, { radius: .55, desc: 'Produces artillery, missile vehicles and mobile air defense.' }),
  airfield: building('airfield', 'Airfield', 2, 360, 220, 38, { radius: .45, vision: 7, desc: 'Produces and services aircraft.' }),
  armory: building('armory', 'Armory', 1, 240, 90, 24, { desc: 'Faction-wide military and economic upgrades.' }),
  advanced_lab: building('advanced_lab', 'Advanced Systems Lab', 3, 450, 300, 42, { desc: 'Produces autonomous systems and advanced specialist units.' }),
  missile_silo: building('missile_silo', 'Strategic Missile Facility', 3, 750, 500, 60, { hp: 1250, radius: .5, needs: 'advanced_lab', desc: 'Produces limited strategic missiles in a headquarters ring site.' }),
  barricade: building('bunker', 'Sandbag Barricade', 1, 20, 0, 4, { field: true, radius: .26, width: .50, depth: .34, lowCover: true, hp: 240, cover: .25, desc: 'Rotatable sandbags, wire and tank obstacles. Infantry can shelter and fire over the low wall. Q / E rotates before placement.' }),
  city_turret: building('guard_post', 'Perimeter Turret', 1, 85, 20, 20, { field: true, radius: .14, hp: 360, vision: 6, attack: 13, range: 2.6, weapon: 'mg', desc: 'A short-range machine-gun turret. Effective against exposed infantry; vulnerable to armor and artillery.' }),
  guard_post: building('guard_post', 'Watchtower', 1, 100, 15, 16, { field: true, radius: .18, vision: 6, attack: 10, range: 2.3, claims: 1,
    desc: 'A compact machine-gun watchtower. Claims the hexes around it as territory.' }),
  bunker: building('bunker', 'Bunker', 1, 165, 45, 23, { field: true, radius: .32, attack: 14, range: 2.7, claims: 1 }),
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
export const DEFENSE_INFLUENCE = { reach: 8, factor: 3, note: 'Outside your influence: ×3 cost' };
for (const def of Object.values(ACTION_BUILDINGS)) if (def.field && !def.newBase && (def.attack || def.lowCover)) def.defense = true;
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
  rifle_squad: unit('rifle_squad', 'barracks', 1, 80, 0, 2, { ability: 'cover', time: 12 }), // 2026-11-17: 70 -> 80 materials
  militia: unit('militia', 'barracks', 1, 54, 0, 2, { ability: 'cover', time: 10 }), // 2026-11-17: 48 -> 54 materials (follows the rifle squad's 70 -> 80)
  // Not trainable: every base fields its own automatic engineers (actionEngineers.js), free and uncommandable.
  engineer: unit('engineer', 'barracks', 1, 100, 25, 2, { ability: 'repair', radius: .122, atk: 4, range: 1.2, weapon: 'pistol', defensiveOnly: true, time: 15, auto: true }),
  anti_armor: unit('anti_armor', 'barracks', 1, 100, 25, 3, { name: 'Anti-Armor Squad', glyph: 'AT', weapon: 'atgun', atk: 15, range: 3.25, antiBuilding: .72, ability: 'focused_fire', time: 18 }),
  // 2026-11-17: mortar 120/30 -> 150/45, fires every 4.5 s (was 3.0), 80 -> 120 HP (40 per man), shell atk 13 -> 15
  // (sustained fire -23%: a heavier, slower bomb that still digs entrenched infantry out)
  mortar_team: unit('mortar_team', 'barracks', 1, 150, 45, 3, { ability: 'bombard', time: 21, fireCooldown: 4.5, hp: 120, atk: 15 }),
  special_forces: unit('special_forces', 'barracks', 2, 125, 40, 4, { ability: 'infiltrate', time: 23, hp: Math.round(UNITS.special_forces.hp * 1.4) }),
  exo_infantry: unit('exo_infantry', 'barracks', 3, 240, 120, 5, { ability: 'cover', time: 30, hp: 400, atk: 34 }), // 2026-11-17: 260/135 -> 240/120, hp 230 -> 400, atk 27 -> 34
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
  fighter: unit('fighter', 'airfield', 2, 315, 160, 7, { ability: 'patrol', time: 35 }),
  recon_drone: unit('recon_drone', 'airfield', 2, 115, 65, 2, { ability: 'scan', vision: 10.5, time: 19 }),
  bomber: unit('bomber', 'airfield', 3, 470, 250, 9, { ability: 'strike', time: 46 }),
  oneway_drone: unit('oneway_drone', 'advanced_lab', 3, 125, 80, 2, { ability: 'strike', time: 18 }),
  autonomous_tank: unit('autonomous_tank', 'advanced_lab', 3, 340, 150, 8, { ability: 'focused_fire', radius: .255, time: 42, hp: 480, vsInfantry: 1.2 }), // 2026-11-17: hp 420 -> 480, HE vs infantry
  strike_swarm: unit('strike_swarm', 'advanced_lab', 3, 335, 210, 7, { ability: 'strike', time: 40 }),
};
// Aircraft cross the (larger) battlefield noticeably faster than any ground force, scaled by role:
// fighters fastest, then one-way drones and bombers, with helicopters and swarms as the slow low-level
// attackers. Resulting speeds (hexes/s): fighter 6.5, oneway 5.5, swarm 4.5, recon 4.3, bomber 4.2, helicopter 3.4.
const AIR_PACE = { fighter: 1.6, oneway_drone: 1.55, bomber: 1.5, recon_drone: 1.4, strike_swarm: 1.35, helicopter: 1.35 };
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
for (const [key, def] of Object.entries(ACTION_UNITS)) {
  if (def.auto) continue;
  const factory = ACTION_BUILDINGS[def.facility];
  (factory.trains ??= []).push(key);
}
// Squads are made of men (shared with E for balance, J for visuals): maxHp = men × HP per man; the living
// count is ceil(hp / maxHp × men), and a squad's firepower scales with the men still standing.
const SQUAD_MEN = { rifle_squad: 8, militia: 6, special_forces: 5, exo_infantry: 4, anti_armor: 3, mortar_team: 3, engineer: 1 };
for (const [key, men] of Object.entries(SQUAD_MEN)) ACTION_UNITS[key].men = men;
ACTION_UNITS.rifle_squad.hp = 8 * 14;

export const TIERS = [
  { name: 'Reclamation', label: 'I', desc: 'Infantry, reconnaissance and early defenses.' },
  { name: 'Mechanized Warfare', label: 'II', desc: 'Global mechanized technology and two additional local ring sites.', cost: cost(480, 240), time: 40 },
  { name: 'Advanced Warfare', label: 'III', desc: 'Global advanced technology and the final two local ring sites.', cost: cost(1000, 600), time: 65 },
];

export const ACTION_UPGRADES = {
  infantry_training: { name: 'Infantry Training', desc: 'Fieldcraft: infantry that halt go prone and scrape firing positions, taking cover wherever they stop (less damage from direct fire and some from shellfire).', tier: 1, time: 25, cost: cost(170, 42) },
  // Functional upgrades: each changes behaviour rather than adding a flat percentage (see actionUpgrades.js).
  improved_logistics: { name: 'Improved Logistics', desc: 'Reinforcements leaving a base move 35% faster until they reach their rally point (up to 45 s).', tier: 2, time: 30, cost: cost(240, 130) },
  field_engineering: { name: 'Field Engineering', desc: 'Engineers keep building and repairing under fire, and damaged vehicles patch themselves up in the field (1.2 HP/s, up to 70%).', tier: 2, time: 36, cost: cost(255, 90) },
  heavy_armor: { name: 'Heavy Armor', desc: 'Tracked vehicles ignore small-arms fire (rifles, machine guns, pistols); wheeled vehicles take half damage from it.', tier: 2, time: 40, cost: cost(285, 120) },
  aircraft_systems: { name: 'Aircraft Systems', desc: 'Drop tanks and quick-turnaround crews: aircraft fly 50% longer before returning to refuel (and patrol 50% further from base), and refuel twice as fast.', tier: 2, time: 38, cost: cost(225, 135) },
  networked_command: { name: 'Networked Command', desc: 'Units share a vision net: every unit and structure sees 1.5 hexes further and spots hidden units within 2.5 hexes.', tier: 3, time: 52, cost: cost(340, 180) },
  // Barracks upgrades: kit the infantry carry, each shown on the soldiers (equipment bits 32, 64, 128, 256)
  grenades: { name: 'Hand Grenades', at: 'barracks', desc: 'Infantry close to enemy troops in cover, or to a structure, throw a grenade every 9 s: an area burst that reaches troops in trenches and cover.', tier: 1, time: 22, cost: cost(60, 110) },
  rocket_teams: { name: 'Rocket Teams', at: 'barracks', desc: 'One man in each rifle squad, militia or special forces team fires a light anti-tank rocket at vehicles or structures in rifle range every 24 s.', tier: 1, time: 30, cost: cost(80, 150) },
  body_armor: { name: 'Body Armour', at: 'barracks', desc: 'Plate carriers and helmets: once per soldier, a hit that would kill men spares one of them.', tier: 2, time: 34, cost: cost(110, 190) },
  marksmen: { name: 'Designated Marksmen', at: 'barracks', desc: 'A scoped marksman per squad picks off crews and squad leaders: every 12 s a long-range precision shot (1.45x range) at enemy crews and squads.', tier: 2, time: 32, cost: cost(100, 160) },
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
  supply: { name: 'Materials Relay', benefit: '+90 Materials/min', materials: 1.5, ruin: 'depot' },
  energy: { name: 'Abandoned Energy Plant', benefit: '+30 Energy/min', energy: .5, ruin: 'power_plant' },
  radar: { name: 'Radar Station', benefit: 'Reveals nearby terrain and units', vision: 10, ruin: 'comms_tower' },
  repair: { name: 'Repair Station', benefit: 'Repairs nearby units', repair: 3, ruin: 'motor_works' },
  defense: { name: 'Defensive Position', benefit: 'Ground forces gain cover within the zone', cover: .27, ruin: 'bunker' },
};

export const ACTION_RESOURCES = ['materials', 'energy'];
export const MISSILE_PROJECT = { cost: cost(480, 380), time: 52, range: 58, radius: 2.7 };
// A new base keeps this distance (world units) from every other base site, and 3.5 from outposts.
export const NEW_BASE_GAP = 5;
// Terrain works (command `terrain`): engineers reshape ground in your own territory. A legacy single-point order
// reshapes the 7 hexes around the point for `cost` / `time`; a brush stroke (`points` + `radius` 0..maxRadius) covers
// every hex within `radius` of the stroke (at most maxHexes) and costs `cost` / `time` per 7 hexes (minimum minCost).
export const TERRAIN_WORKS = { ops: ['raise', 'lower', 'flatten', 'smooth'], cost: cost(60), time: 6, step: .06, min: .02, max: .5,
  maxRadius: 2, maxHexes: 60, minCost: 10,
  desc: 'Engineers raise, lower, flatten or smooth the ground in your territory: drag a brush stroke across visible open ground (never water, never into mountains). The cost grows with the hexes painted.' };

// W2 (2026-11-16): decisive domination (default 'domination' scenario). From minute 18, a team that holds at least
// 65% of the operational headquarters while fielding at least 2.5x the army value of all its rivals together, for
// 90 s without a break, wins; its rivals are warned when the countdown starts. Before this a beaten side with a few
// scattered bases kept the match alive to the 30-minute cap in 27 of 30 balance sims.
export const DOMINANCE = { after: 1080, hqShare: .65, armyRatio: 2.5, hold: 90 };

export function actionDefinitions(base) {
  return {
    W: base.W, H: base.H, TERRAIN: base.TERRAIN, ROAD_TYPES: base.ROAD_TYPES, DIFFICULTY: base.DIFFICULTY,
    CIV_COLORS: base.CIV_COLORS, STANCES: base.STANCES, FORMATIONS: base.FORMATIONS, WEAPON_KEYS: base.WEAPON_KEYS,
    AGES: TIERS, TECHS: ACTION_UPGRADES, CITY_DEFENSES, GOODS: ACTION_RESOURCES, GOOD_NAMES: { materials: 'Materials', energy: 'Energy' },
    RULESET: { id: 'action-v2', ringVersion: 1, slots: [3, 5, 7], commandCapacity: [80, 120, 160], fieldConstruction: 'engineers', engineerRequired: false,
      autoEngineers: [2, 3, 4], territoryBuild: true, newBase: { type: 'base_site', cost: ACTION_BUILDINGS.base_site.cost, minGap: NEW_BASE_GAP },
      terrain: TERRAIN_WORKS, dominance: DOMINANCE, influence: DEFENSE_INFLUENCE },
    BUILDINGS: ACTION_BUILDINGS, UNITS: ACTION_UNITS, ABILITIES, RUIN_TYPES, OUTPOST_TYPES, MISSILE: MISSILE_PROJECT,
  };
}
