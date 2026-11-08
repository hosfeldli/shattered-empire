import { nativeRules, REMOVED_TECHS } from './rulesets.js';
// Shattered Empires — game data (sent to clients in `welcome`).
// Setting: a post-collapse continent. Five eras take survivors from salvaged tools
// (Reclamation) to autonomous war machines (Advanced Systems).
// Map size is fixed per process: each match runs in its own worker thread, which sets
// globalThis.SE_MAP_SIZE before loading the simulation (128 / 192 / 256).
export const MAP_SIZES = { small: 128, medium: 192, large: 256 };
const SIZE = Math.max(64, Math.min(256, +(globalThis.SE_MAP_SIZE || (typeof process !== 'undefined' && process.env.SE_MAP_SIZE) || 128)));
export const W = SIZE;
export const H = SIZE;
export const N = W * H;
export const TICK_HZ = 10;
export const DT = 1 / TICK_HZ;

// ---- Terrain -------------------------------------------------------------
export const T = { DEEP: 0, SHALLOW: 1, GRASS: 2, PLAINS: 3, FOREST: 4, DESERT: 5, TUNDRA: 6, MARSH: 7, HILLS: 8, MOUNTAIN: 9, PEAK: 10, LAVA: 11, ASH: 12 };
export const TERRAIN = [
  { id: 0, key: 'deep', name: 'Deep Ocean', move: Infinity, def: 0, fert: 0, color: [22, 52, 92], water: true },
  { id: 1, key: 'shallow', name: 'Shallow Sea', move: Infinity, def: 0, fert: 0, color: [44, 98, 138], water: true },
  { id: 2, key: 'grass', name: 'Grassland', move: 1, def: 0, fert: 1.0, color: [104, 150, 72] },
  { id: 3, key: 'plains', name: 'Plains', move: 1, def: 0, fert: 0.85, color: [168, 160, 92] },
  { id: 4, key: 'forest', name: 'Forest', move: 2, def: 0.25, fert: 0.3, color: [50, 102, 52] },
  { id: 5, key: 'desert', name: 'Desert', move: 1.5, def: 0, fert: 0.2, color: [206, 184, 122] },
  { id: 6, key: 'tundra', name: 'Tundra', move: 1.5, def: 0, fert: 0.35, color: [150, 156, 140] },
  { id: 7, key: 'marsh', name: 'Marsh', move: 3, def: -0.1, fert: 0.6, color: [82, 112, 88] },
  { id: 8, key: 'hills', name: 'Hills', move: 2, def: 0.3, fert: 0.45, color: [138, 128, 86] },
  { id: 9, key: 'mountain', name: 'Mountains', move: 4, def: 0.5, fert: 0, color: [118, 108, 100] },
  { id: 10, key: 'peak', name: 'Impassable Peaks', move: Infinity, def: 0, fert: 0, color: [220, 222, 228] },
  { id: 11, key: 'lava', name: 'Lava Field', move: Infinity, def: 0, fert: 0, color: [214, 70, 24] },
  { id: 12, key: 'ash', name: 'Volcanic Soil', move: 1.2, def: 0, fert: 1.6, color: [96, 86, 80] },
];
export const isWater = (t) => t === T.DEEP || t === T.SHALLOW;

// Movement classes: cost per terrain (Infinity = impassable), road multipliers and river rules.
//   ford: extra cost to enter an unbridged minor river; majorFord: for major rivers (flow bucket >= 2).
// Roads speed movement but do not dominate it (a unit should not take a road 3x around a hill), and
// heavy vehicles can ford a major river slowly where there is no bridge instead of detouring for miles.
export const MOVE = {
  infantry: { terrain: [Infinity, Infinity, 1, 1, 2, 1.5, 1.5, 3, 2, 4, Infinity, Infinity, 1.2], road: [1, 0.68, 0.6, 0.55, 0.6], ford: 1.5, majorFord: 2.5 },
  wheeled: { terrain: [Infinity, Infinity, 1.2, 1.1, 3.5, 1.8, 2, Infinity, 3, Infinity, Infinity, Infinity, 1.4], road: [1, 0.55, 0.42, 0.35, 0.42], ford: 4, majorFord: 9 },
  tracked: { terrain: [Infinity, Infinity, 1, 1, 2, 1.3, 1.6, 4, 2, Infinity, Infinity, Infinity, 1.2], road: [1, 0.6, 0.48, 0.4, 0.45], ford: 3, majorFord: Infinity, heavy: true },
  aircraft: { air: true },
};
export const ROAD_TYPES = [
  null,
  { id: 1, key: 'dirt', name: 'Dirt road', cost: { materials: 2 }, time: 1.2, capacity: 8, freight: 3, tech: null },
  { id: 2, key: 'paved', name: 'Paved road', cost: { materials: 3, steel: 1 }, time: 1.6, capacity: 12, freight: 6, tech: 'civil_engineering' },
  { id: 3, key: 'highway', name: 'Highway', cost: { materials: 4, steel: 2, fuel: 1 }, time: 2, capacity: 18, freight: 10, tech: 'highways' },
  { id: 4, key: 'rail', name: 'Railway', cost: { steel: 3, ore: 1 }, time: 2, capacity: 10, freight: 18, tech: 'railways' },
];
export const PORT_FREIGHT = 6;      // goods/s through a sea lane between two ports
export const LOCAL_STORE = 300;    // per-good warehouse capacity of a single city
export const BRIDGE_MULT = 2.5; // building across a river costs this much more

// ---- Map resources ---------------------------------------------------------
export const RES = { NONE: 0, OIL: 1, IRON: 2, COAL: 3, RARE: 4, STONE: 5, FISH: 6, RUINS: 7 };
export const RESOURCE = [
  { id: 0, key: 'none', name: '' },
  { id: 1, key: 'oil', name: 'Oil field', glyph: 'Oi' },
  { id: 2, key: 'iron', name: 'Iron ore', glyph: 'Fe' },
  { id: 3, key: 'coal', name: 'Coal seam', glyph: 'C' },
  { id: 4, key: 'rare', name: 'Rare earths', glyph: 'Re' },
  { id: 5, key: 'stone', name: 'Stone', glyph: 'St' },
  { id: 6, key: 'fish', name: 'Fishing grounds', glyph: 'Fi' },
  { id: 7, key: 'ruins', name: 'Old-world ruins', glyph: 'Ru' },
];

export const GOODS = ['food', 'materials', 'ore', 'steel', 'fuel', 'electronics', 'munitions', 'credits'];
export const GOOD_NAMES = { food: 'Food', materials: 'Materials', ore: 'Ore', steel: 'Steel', fuel: 'Fuel', electronics: 'Electronics', munitions: 'Munitions', credits: 'Credits' };

export const AGES = [
  { id: 0, name: 'Reclamation' },
  // paced for: industrial ~10-15 min, mechanised ~18-25, networked ~30-45, advanced ~45-60
  { id: 1, name: 'Industrial Recovery', techsNeeded: 6, cost: { food: 700, materials: 700, credits: 400 }, time: 60 },
  { id: 2, name: 'Mechanization', techsNeeded: 5, cost: { steel: 350, fuel: 150, credits: 800 }, time: 60 },
  { id: 3, name: 'Networked Warfare', techsNeeded: 6, cost: { steel: 1100, fuel: 700, credits: 2500, munitions: 300 }, time: 90 },
  { id: 4, name: 'Advanced Systems', techsNeeded: 6, cost: { steel: 1600, electronics: 600, credits: 4000 }, time: 120 },
];

// ---- Technology graph (req = prerequisites) --------------------------------
export const TECHS = {
  // Reclamation
  agronomy: { name: 'Agronomy', age: 0, cost: 60, req: [], desc: '+25% farm output; Rationing policy.' },
  salvage_engineering: { name: 'Salvage Engineering', age: 0, cost: 60, req: [], desc: 'Salvage yards on old-world ruins (materials + steel).' },
  small_arms: { name: 'Small Arms', age: 0, cost: 60, req: [], desc: 'Rifle squads.' },
  fortification: { name: 'Fortification', age: 0, cost: 70, req: ['salvage_engineering'], desc: 'Bunkers and reinforced trench lines; Fortification Doctrine policy.' },
  trade_networks: { name: 'Trade Networks', age: 0, cost: 70, req: [], desc: 'Markets (merchants), Free Markets policy.' },
  schooling: { name: 'Schooling', age: 0, cost: 60, req: [], desc: 'Academies (specialists produce research); Research Grants policy.' },
  seafaring: { name: 'Seafaring', age: 0, cost: 70, req: ['salvage_engineering'], desc: 'Ports: fishing, embarking at ports, sea supply.' },
  surveying: { name: 'Surveying', age: 0, cost: 60, req: [], desc: 'Reveals structural stability; Public Works policy.' },
  // Industrial Recovery
  metallurgy: { name: 'Metallurgy', age: 1, cost: 300, req: ['salvage_engineering'], desc: 'Mines (iron/coal ore) and steel mills.' },
  electrification: { name: 'Electrification', age: 1, cost: 300, req: ['metallurgy'], desc: 'Power plants. Industry needs power.' },
  petroleum: { name: 'Petroleum', age: 1, cost: 320, req: ['surveying'], desc: 'Oil wells (fuel).' },
  motorization: { name: 'Motorization', age: 1, cost: 340, req: ['petroleum', 'metallurgy'], desc: 'Motor works: armored cars, supply trucks.' },
  munitions_industry: { name: 'Munitions Industry', age: 1, cost: 320, req: ['metallurgy'], desc: 'Munitions plants; mortar teams.' },
  logistics: { name: 'Logistics', age: 1, cost: 320, req: ['motorization'], desc: 'Supply depots; +2 supply range.' },
  field_artillery: { name: 'Field Artillery', age: 1, cost: 340, req: ['munitions_industry'], desc: 'Field guns.' },
  civil_engineering: { name: 'Civil Engineering', age: 1, cost: 320, req: ['electrification'], desc: 'Paved roads, heavy bridges, fortresses, blasting peaks.' },
  higher_education: { name: 'Higher Education', age: 1, cost: 300, req: ['schooling'], desc: 'Universities; Technocracy.' },
  // Mechanization
  mechanization: { name: 'Mechanization', age: 2, cost: 700, req: ['motorization'], desc: 'Heavy assembly: tanks, mechanized infantry.' },
  aviation: { name: 'Aviation', age: 2, cost: 720, req: ['petroleum'], desc: 'Airfields, attack helicopters and basic fighters; AA batteries to defend against aircraft.' },
  highways: { name: 'Highways', age: 2, cost: 650, req: ['civil_engineering'], desc: 'Highways: fastest road movement and supply.' },
  railways: { name: 'Railways', age: 2, cost: 650, req: ['civil_engineering'], desc: 'Railways for bulk supply and transport.' },
  mechanized_agriculture: { name: 'Mechanized Agriculture', age: 2, cost: 650, req: ['agronomy'], desc: '+50% farm output, +housing.' },
  self_propelled_guns: { name: 'Self-Propelled Guns', age: 2, cost: 700, req: ['field_artillery'], desc: 'Self-propelled artillery.' },
  corporate_charter: { name: 'Corporate Charter', age: 2, cost: 650, req: ['trade_networks'], desc: 'Corporate State government.' },
  // Networked Warfare
  computing: { name: 'Computing', age: 3, cost: 1200, req: ['electrification', 'higher_education'], desc: 'Electronics plants (rare earths from a deposit, a trade partner, imports or recycling).' },
  materials_recycling: { name: 'Materials Recycling', age: 3, cost: 900, req: ['computing', 'salvage_engineering'], desc: 'Recover rare earths from salvage: electronics plants run without a deposit.' },
  networked_command: { name: 'Networked Command', age: 3, cost: 1200, req: ['computing'], desc: 'Comms towers: long-range vision, +1 supply range.' },
  drones: { name: 'Drones', age: 3, cost: 1250, req: ['computing', 'aviation'], desc: 'Drone works: recon drones that scout a region, and expendable one-way strike drones.' },
  air_operations: { name: 'Air Operations', age: 3, cost: 1200, req: ['aviation'], desc: 'Tactical bombers for strikes on troop concentrations and infrastructure; faster launches and landings.' },
  precision_missiles: { name: 'Precision Missiles', age: 3, cost: 1300, req: ['drones'], desc: 'Missile batteries.' },
  air_defense: { name: 'Air Defense', age: 3, cost: 1150, req: ['aviation'], desc: 'Air-defense vehicles; AA batteries can be upgraded for better detection, range and accuracy.' },
  special_operations: { name: 'Special Operations', age: 3, cost: 1150, req: ['small_arms'], desc: 'Special forces (hidden beyond 2 hexes).' },
  energy_shields: { name: 'Energy Shields', age: 3, cost: 1250, req: ['computing', 'electrification'], desc: 'Shield generators: a dome over everything of yours within 3 hexes soaks up incoming fire until it is worn down, then recharges once the shooting stops. Needs power.' },
  federal_union: { name: 'Federal Union', age: 3, cost: 1150, req: ['higher_education'], desc: 'Federal Republic government.' },
  // Advanced Systems
  robotics: { name: 'Robotics', age: 4, cost: 2000, req: ['computing', 'mechanization'], desc: 'Robotics complex: autonomous tanks.' },
  fusion_power: { name: 'Fusion Power', age: 4, cost: 2100, req: ['electrification', 'computing'], desc: 'Fusion plants: abundant power without fuel.' },
  strike_swarms: { name: 'Strike Swarms', age: 4, cost: 2100, req: ['drones', 'robotics'], desc: 'Strike drone swarms.' },
  exo_armor: { name: 'Exo Armor', age: 4, cost: 2000, req: ['robotics'], desc: 'Exo-armored infantry.' },
  climate_engineering: { name: 'Climate Engineering', age: 4, cost: 2000, req: ['mechanized_agriculture'], desc: 'Engineered climate: +20% farm yields in your territory.' },
  improved_servicing: { name: 'Improved Servicing', age: 4, cost: 1900, req: ['air_operations', 'robotics'], desc: 'Aircraft refuel, rearm and repair a third faster; airfields gain two servicing slots.' },
  missile_defense: { name: 'Missile Defense', age: 4, cost: 2000, req: ['air_defense', 'computing'], desc: 'Upgraded AA batteries and air-defense vehicles can intercept strategic missiles.' },
  strategic_missiles: { name: 'Strategic Missiles', age: 4, cost: 2300, req: ['precision_missiles', 'fusion_power'], desc: 'Missile silos: a long, costly project yields one strategic missile at a time.' },
  continental_arcology: { name: 'Continental Arcology', age: 4, cost: 2400, req: ['fusion_power'], desc: 'The Arcology wonder (victory project).' },
};

// ---- Governments & policies ----------------------------------------------
// Governments shape the whole nation, including which branches of the research tree it pursues
// fastest (favors: technology categories researched 30% faster).
export const GOVS = {
  council: { name: 'Provisional Council', slots: 2, favors: ['civ'], effects: ['+5 stability', 'Civic technologies (farming, schooling) researched 30% faster'], desc: 'Survivors governing by committee: steady, unremarkable.' },
  technocracy: { name: 'Technocracy', tech: 'higher_education', slots: 3, favors: ['civ', 'industry', 'advanced'], effects: ['+20% research', '+10% power output', 'Civic, industrial and advanced technologies researched 30% faster', '−6 stability'], desc: 'Rule by engineers and scientists.' },
  junta: { name: 'Military Junta', tech: 'munitions_industry', slots: 3, favors: ['military'], effects: ['Units 20% cheaper', '+10% attack', 'Military technologies researched 30% faster', '−15% research', '−8 stability'], desc: 'The army runs the state.' },
  corporate: { name: 'Corporate State', tech: 'corporate_charter', slots: 3, favors: ['industry', 'society'], effects: ['+30% credits', '+10% steel, munitions and electronics', 'Industrial and society technologies researched 30% faster', '−10% unit attack'], desc: 'The companies own the country.' },
  federal: { name: 'Federal Republic', tech: 'federal_union', slots: 4, favors: ['infra', 'logistics', 'society'], effects: ['+10 stability', '+10% all production', 'Infrastructure, logistics and society technologies researched 30% faster', 'War weariness builds twice as fast'], desc: 'Self-governing states in a union.' },
};
// research branches (the research screen's lanes); governments favour some of them
export const TECH_CAT = {
  agronomy: 'civ', schooling: 'civ', higher_education: 'civ', mechanized_agriculture: 'civ', climate_engineering: 'civ',
  salvage_engineering: 'industry', metallurgy: 'industry', electrification: 'industry', petroleum: 'industry', munitions_industry: 'industry', computing: 'industry', materials_recycling: 'industry', fusion_power: 'industry',
  surveying: 'infra', seafaring: 'infra', civil_engineering: 'infra', highways: 'infra', railways: 'infra',
  small_arms: 'military', fortification: 'military', field_artillery: 'military', mechanization: 'military', aviation: 'military', self_propelled_guns: 'military', air_defense: 'military', special_operations: 'military', air_operations: 'military', precision_missiles: 'military', missile_defense: 'military', strategic_missiles: 'military', improved_servicing: 'military',
  motorization: 'logistics', logistics: 'logistics', networked_command: 'logistics', drones: 'logistics',
  trade_networks: 'society', corporate_charter: 'society', federal_union: 'society',
  robotics: 'advanced', strike_swarms: 'advanced', exo_armor: 'advanced', continental_arcology: 'advanced', energy_shields: 'advanced',
};
export const POLICIES = {
  rationing: { name: 'Rationing', tech: 'agronomy', desc: '+20% food, -10% materials.' },
  conscription: { name: 'Conscription', desc: 'Units cost 30% less food & credits. -6 stability.' },
  free_markets: { name: 'Free Markets', tech: 'trade_networks', desc: '+30% market credits, trade agreements +50%. -10% munitions.' },
  extraction_quotas: { name: 'Extraction Quotas', tech: 'metallurgy', desc: '+30% materials, ore and fuel. -4 stability.' },
  research_grants: { name: 'Research Grants', tech: 'schooling', desc: '+30% research, -10% credits.' },
  martial_law: { name: 'Martial Law', desc: '+15 stability, -25% growth, -15% credits.' },
  public_works: { name: 'Public Works', tech: 'surveying', desc: 'Roads half price and twice as fast. -4 stability.' },
  fortification: { name: 'Fortification Doctrine', tech: 'fortification', desc: 'Defensive buildings +50% HP & attack.' },
  homesteading: { name: 'Homesteading', desc: 'Colonists 40% cheaper; new cities grow +50%.' },
  total_war: { name: 'Total War', tech: 'munitions_industry', desc: '+20% attack, +30% munitions, -10 stability, -20% food.' },
  industrial_planning: { name: 'Industrial Planning', tech: 'electrification', desc: '+30% steel & munitions, -5 stability.' },
};
export const FOCI = { balanced: 'Balanced', food: 'Food first', industry: 'Industry', commerce: 'Commerce', science: 'Science', military: 'War economy' };
export const TAX = [
  { name: 'None', credits: 0, stab: 6 },
  { name: 'Low', credits: 0.03, stab: 0 },
  { name: 'Normal', credits: 0.06, stab: -6 },
  { name: 'High', credits: 0.1, stab: -16 },
];

// ---- Buildings -------------------------------------------------------------
// jobs: [kind, slots]; produce/consume per staffed slot per second; power: + generated / - consumed per staffed slot.
// Workplaces are large (five jobs for most), so a city needs a handful of well-staffed buildings it
// then upgrades, rather than a sprawl of small ones. base: what an extraction site yields per second
// on its own (the land itself: no workers needed), raised by matching land around it and by its
// level; its workers add their produce on top.
// place: 'city' | 'flat' | 'farm' | 'forest' | 'quarry' | 'mine' | 'oil' | 'ruins' | 'coast' | 'any'
export const BUILDINGS = {
  town: { name: 'Settlement Hub', glyph: '\u{1F3D8}', age: 0, cost: {}, time: 0, hp: 1000, place: 'city', cat: 'civic',
    jobs: ['worker', 2], produce: { food: 0.5, materials: 0.45, credits: 0.2 }, housing: 8, vision: 5, attack: 8, range: 3,
    trains: ['colonist', 'engineer', 'scout_buggy'] },
  house: { name: 'Housing Block', glyph: '\u{1F3E2}', age: 0, cost: { materials: 45 }, time: 12, hp: 160, place: 'flat', housing: 4, cat: 'residential' },
  farm: { name: 'Farm', glyph: '\u{1F33E}', age: 0, cost: { materials: 60 }, time: 14, hp: 140, place: 'farm', jobs: ['worker', 5], base: { food: 2.2 }, produce: { food: 0.8 }, cat: 'agri' },
  lumber: { name: 'Timber Mill', glyph: '\u{1FAB5}', age: 0, cost: { materials: 55 }, time: 14, hp: 140, place: 'forest', jobs: ['worker', 5], base: { materials: 2.2 }, produce: { materials: 0.46 }, cat: 'industry' },
  quarry: { name: 'Quarry', glyph: '\u{1FAA8}', age: 0, cost: { materials: 80 }, time: 18, hp: 180, place: 'quarry', jobs: ['worker', 5], base: { materials: 1.6, ore: 0.4 }, produce: { materials: 0.42, ore: 0.1 }, cat: 'industry' },
  salvage: { name: 'Salvage Yard', glyph: '⚙', age: 0, tech: 'salvage_engineering', cost: { materials: 80 }, time: 18, hp: 180, place: 'ruins', jobs: ['worker', 5], base: { materials: 1.2, steel: 0.3 }, produce: { materials: 0.32, steel: 0.1, ore: 0.05, credits: 0.06 }, cat: 'industry' },
  barracks: { name: 'Barracks', glyph: '⚔', age: 0, cost: { materials: 80 }, time: 20, hp: 320, place: 'flat', cat: 'military',
    trains: ['militia', 'rifle_squad', 'mortar_team', 'special_forces', 'exo_infantry'] },
  market: { name: 'Market', glyph: '\u{1F4B0}', age: 0, tech: 'trade_networks', cost: { materials: 145 }, time: 23, hp: 220, place: 'flat', jobs: ['merchant', 5], produce: { credits: 0.62 }, cat: 'commerce' },
  academy: { name: 'Academy', glyph: '\u{1F4DA}', age: 0, tech: 'schooling', cost: { materials: 160, credits: 40 }, time: 25, hp: 220, place: 'flat', jobs: ['specialist', 5], produce: { research: 0.32 }, cat: 'science' },
  port: { name: 'Port', glyph: '⚓', age: 0, tech: 'seafaring', cost: { materials: 160 }, time: 25, hp: 280, place: 'coast', jobs: ['worker', 3], base: { food: 1.6, credits: 0.4 }, produce: { food: 0.75, credits: 0.2 }, vision: 4, supply: 4, cat: 'logistics' },
  guard_post: { name: 'Guard Post', glyph: '\u{1F5FC}', age: 0, cost: { materials: 35 }, time: 9, hp: 180, place: 'any', vision: 4, attack: 6, range: 2, anywhere: true, cat: 'military', defense: 'ground', desc: 'Cheap early defense: a light machine gun against small raids.' },
  bunker: { name: 'Bunker', glyph: '\u{1F6E1}', age: 0, tech: 'fortification', cost: { materials: 90 }, time: 18, hp: 450, place: 'any', vision: 5, attack: 10, range: 3, anywhere: true, cat: 'military', defense: 'ground', shelter: 0.1, desc: 'Durable ground defense: strong against infantry, limited against light vehicles; shelters troops beside it.' },
  aa_battery: { name: 'AA Battery', glyph: '\u{1F3AF}', age: 2, tech: 'aviation', cost: { materials: 90, steel: 40, munitions: 20 }, time: 20, hp: 300, place: 'any', vision: 5, attack: 14, range: 4, anywhere: true, cat: 'military', defense: 'air', ammo: 0.4, desc: 'Stationary anti-aircraft guns: fires airburst volleys at detected aircraft; cannot target ground units. Uses munitions.' },
  mine: { name: 'Mine', glyph: '⛏', age: 1, tech: 'metallurgy', cost: { materials: 175 }, time: 25, hp: 220, place: 'mine', jobs: ['worker', 5], base: { ore: 2 }, produce: { ore: 0.65 }, cat: 'industry', desc: 'Ore from an iron or coal deposit; dug into bare hills or mountains it yields under half as much.' },
  steel_mill: { name: 'Steel Mill', glyph: '\u{1F3ED}', age: 1, tech: 'metallurgy', cost: { materials: 295 }, time: 34, hp: 400, place: 'flat', jobs: ['worker', 5], produce: { steel: 0.65 }, consume: { ore: 0.36 }, power: -2, cat: 'industry' },
  power_plant: { name: 'Power Plant', glyph: '⚡', age: 1, tech: 'electrification', cost: { materials: 160, steel: 40 }, time: 28, hp: 380, place: 'flat', jobs: ['worker', 2], consume: { ore: 0.08 }, power: 9, cat: 'power' },
  oil_well: { name: 'Oil Well', glyph: '\u{1F6E2}', age: 1, tech: 'petroleum', cost: { materials: 190, steel: 50 }, time: 28, hp: 240, place: 'oil', jobs: ['worker', 3], base: { fuel: 2 }, produce: { fuel: 1.0 }, cat: 'industry' },
  refinery: { name: 'Synthetic Fuel Refinery', glyph: '\u{1F6E2}', age: 2, tech: 'petroleum', cost: { materials: 320, steel: 120 }, time: 39, hp: 380, place: 'flat', jobs: ['worker', 5], produce: { fuel: 0.6 }, consume: { ore: 0.12, materials: 0.1 }, power: -2, cat: 'industry', desc: 'Makes fuel from ore and timber where there is no oil: slower and costlier than a well, but anywhere.' },
  munitions_plant: { name: 'Munitions Plant', glyph: '\u{1F9E8}', age: 1, tech: 'munitions_industry', cost: { materials: 240, steel: 80 }, time: 34, hp: 360, place: 'flat', jobs: ['worker', 5], produce: { munitions: 0.55 }, consume: { steel: 0.08 }, power: -2, cat: 'industry' },
  motor_works: { name: 'Motor Works', glyph: '\u{1F69A}', age: 1, tech: 'motorization', cost: { materials: 150, steel: 60 }, time: 28, hp: 380, place: 'flat', power: -2, cat: 'military',
    trains: ['armored_car', 'field_gun', 'missile_battery', 'air_defense'] },
  depot: { name: 'Supply Depot', obsolete: true, glyph: '\u{1F4E6}', age: 1, tech: 'logistics', cost: { materials: 90, steel: 20 }, time: 20, hp: 300, place: 'any', supply: 5, vision: 3, anywhere: true, cat: 'logistics' },
  fort: { name: 'Fortress', glyph: '\u{1F3EF}', age: 1, tech: 'civil_engineering', cost: { materials: 200, steel: 60 }, time: 30, hp: 1300, place: 'any', vision: 4, attack: 14, range: 4, anywhere: true, blocksSupply: 2, heals: true, cat: 'military', defense: 'ground', shelter: 0.15, desc: 'Major strongpoint: engages infantry and armor, anchors an area, heals troops beside it. No anti-air.' },
  university: { name: 'University', glyph: '\u{1F393}', age: 1, tech: 'higher_education', cost: { materials: 295, credits: 215 }, time: 39, hp: 320, place: 'flat', jobs: ['specialist', 5], produce: { research: 0.55 }, power: -1, cat: 'science' },
  heavy_assembly: { name: 'Heavy Assembly', glyph: '\u{1F3D7}', age: 2, tech: 'mechanization', cost: { materials: 220, steel: 160 }, time: 36, hp: 520, place: 'flat', power: -4, cat: 'military',
    trains: ['mech_infantry', 'tank', 'sp_artillery', 'autonomous_tank'] },
  airfield: { name: 'Airfield', glyph: '\u{1F6EB}', age: 2, tech: 'aviation', cost: { materials: 200, steel: 120, fuel: 60 }, time: 34, hp: 450, place: 'flat', power: -2, supply: 3, vision: 5, cat: 'military', slots: 4, airbase: true,
    trains: ['fighter', 'helicopter', 'bomber', 'recon_drone', 'strike_swarm'] },
  electronics_plant: { name: 'Electronics Plant', glyph: '\u{1F4BB}', age: 3, tech: 'computing', needs: 'rare', cost: { materials: 375, steel: 265 }, time: 46, hp: 440, place: 'flat', jobs: ['worker', 5], produce: { electronics: 0.4 }, consume: { steel: 0.08 }, power: -3, cat: 'industry' },
  comms_tower: { name: 'Comms Tower', glyph: '\u{1F4E1}', age: 3, tech: 'networked_command', cost: { steel: 120, electronics: 40 }, time: 26, hp: 260, place: 'any', vision: 9, anywhere: true, power: -1, cat: 'logistics' },
  drone_works: { name: 'Drone Works', glyph: '\u{1F6F8}', age: 3, tech: 'drones', cost: { steel: 200, electronics: 80 }, time: 36, hp: 420, place: 'flat', power: -3, cat: 'military', slots: 2, airbase: true, droneOnly: true,
    trains: ['recon_drone', 'oneway_drone', 'strike_swarm', 'missile_battery', 'air_defense'] },
  shield_generator: { name: 'Shield Generator', glyph: '\u{1F6E1}', age: 3, tech: 'energy_shields', cost: { steel: 220, electronics: 120 }, time: 32, hp: 520, place: 'any', anywhere: true, power: -6, cat: 'military', shield: { radius: 3, cap: 900, regen: 30, delay: 5 },
    desc: 'Projects an energy dome over your troops and buildings within 3 hexes: incoming fire is absorbed until the dome is worn down; it recharges 5 s after the last hit. Off without power.' },
  fusion_plant: { name: 'Fusion Plant', glyph: '☢', age: 4, tech: 'fusion_power', cost: { steel: 400, electronics: 200 }, time: 45, hp: 700, place: 'flat', jobs: ['specialist', 2], power: 30, cat: 'power' },
  robotics_complex: { name: 'Robotics Complex', glyph: '\u{1F916}', age: 4, tech: 'robotics', cost: { steel: 400, electronics: 250 }, time: 45, hp: 600, place: 'flat', power: -5, cat: 'military',
    trains: ['autonomous_tank', 'exo_infantry', 'strike_swarm'] },
  missile_silo: { name: 'Missile Silo', glyph: '\u{1F680}', age: 4, tech: 'strategic_missiles', cost: { materials: 400, steel: 600, electronics: 300, credits: 1500 }, time: 60, hp: 900, place: 'flat', power: -4, cat: 'military', silo: true, desc: 'Builds one strategic missile at a time through a long, expensive project.' },
  camp: { name: 'Rebel Camp', glyph: '⛺', age: 0, rebelOnly: true, cost: {}, time: 0, hp: 450, place: 'any', vision: 5, attack: 6, range: 2, supply: 5, cat: 'military' },
  wonder: { name: 'Continental Arcology', glyph: '\u{1F3D9}', age: 4, tech: 'continental_arcology', cost: { steel: 2500, electronics: 900, credits: 4000, materials: 3000 }, time: 180, hp: 3000, place: 'flat', wonder: true, power: -10, cat: 'civic' },
};

import { WEAPONS, UNIT_WEAPON, BUILDING_WEAPON, WEAPON_KEYS } from './weapons.js';
// ---- Units ----------------------------------------------------------------
// move: movement class; cat: combat category (for bonuses). What a unit can shoot at (ground, air,
// low-flying aircraft only) comes from its weapon's target classes (weapons.js), never from the unit.
// Aircraft: fuel = seconds aloft, ammo = engagements per sortie, svc = base servicing seconds, alt = low/high.
export const UNITS = {
  colonist: { name: 'Colonist Convoy', glyph: 'Co', men: 0, age: 0, move: 'infantry', cat: 'civilian', cost: { food: 80, materials: 50, credits: 20 }, pop: 3, time: 12, hp: 50, atk: 0, def: 1, range: 0, speed: 0.6, vision: 2, civilian: true },
  engineer: { name: 'Engineer Team', glyph: 'En', men: 8, age: 0, move: 'infantry', cat: 'support', cost: { food: 30, materials: 40 }, pop: 1, time: 10, hp: 70, atk: 2, def: 3, range: 1, speed: 0.7, vision: 2, engineer: true },
  scout_buggy: { name: 'Scout Buggy', glyph: 'Sc', men: 3, age: 0, move: 'wheeled', cat: 'wheeled', cost: { food: 20, materials: 25 }, pop: 1, time: 8, hp: 60, atk: 3, def: 2, range: 1, speed: 1.7, vision: 5 },
  militia: { name: 'Militia', glyph: 'Mi', men: 12, age: 0, move: 'infantry', cat: 'infantry', cost: { food: 30, materials: 15 }, pop: 1, time: 9, hp: 90, atk: 6, def: 5, range: 1, speed: 0.7, vision: 2 },
  rifle_squad: { name: 'Rifle Squad', glyph: 'Ri', men: 10, age: 0, tech: 'small_arms', move: 'infantry', cat: 'infantry', cost: { food: 40, materials: 30, credits: 10 }, pop: 1, time: 11, hp: 100, atk: 9, def: 6, range: 2, speed: 0.7, vision: 3 },
  mortar_team: { name: 'Mortar Team', glyph: 'Mo', men: 6, age: 1, tech: 'munitions_industry', move: 'infantry', cat: 'artillery', cost: { food: 40, steel: 15, munitions: 15 }, pop: 1, time: 13, hp: 80, atk: 13, def: 3, range: 4, speed: 0.6, vision: 2, bonus: { infantry: 1.4 }, vsBuildings: 1.5 },
  armored_car: { name: 'Armored Car', glyph: 'AC', men: 4, age: 1, tech: 'motorization', move: 'wheeled', cat: 'wheeled', cost: { steel: 40, fuel: 20, credits: 20 }, pop: 1, time: 14, hp: 150, atk: 12, def: 9, range: 2, speed: 1.4, vision: 4, bonus: { infantry: 1.15 } },
  supply_truck: { name: 'Supply Truck', glyph: 'Tr', men: 2, age: 1, tech: 'motorization', move: 'wheeled', cat: 'support', cost: { materials: 50, steel: 15, fuel: 15 }, pop: 1, time: 12, hp: 70, atk: 0, def: 2, range: 0, speed: 1.2, vision: 2, civilian: true, supplyRadius: 4 },
  field_gun: { name: 'Field Gun', glyph: 'FG', men: 6, age: 1, tech: 'field_artillery', move: 'wheeled', cat: 'artillery', cost: { steel: 50, munitions: 30 }, pop: 2, time: 18, hp: 90, atk: 24, def: 2, range: 5, speed: 0.6, vision: 2, vsBuildings: 2.5 },
  mech_infantry: { name: 'Mechanized Infantry', glyph: 'MI', men: 10, age: 2, tech: 'mechanization', move: 'tracked', cat: 'tracked', cost: { food: 40, steel: 70, fuel: 30 }, pop: 1, time: 16, hp: 190, atk: 17, def: 13, range: 2, speed: 1.1, vision: 3 },
  tank: { name: 'Main Battle Tank', glyph: 'Tk', men: 4, age: 2, tech: 'mechanization', move: 'tracked', cat: 'tracked', cost: { steel: 105, fuel: 40, munitions: 15 }, pop: 1, time: 20, hp: 280, atk: 28, def: 18, range: 2, speed: 1.0, vision: 3, bonus: { wheeled: 1.5, infantry: 1.2, tracked: 1.2 } },
  sp_artillery: { name: 'Self-Propelled Gun', glyph: 'SP', men: 5, age: 2, tech: 'self_propelled_guns', move: 'tracked', cat: 'artillery', cost: { steel: 100, fuel: 30, munitions: 40 }, pop: 2, time: 20, hp: 150, atk: 34, def: 6, range: 6, speed: 0.8, vision: 3, vsBuildings: 2.5 },
  helicopter: { name: 'Attack Helicopter', glyph: 'He', men: 2, age: 2, tech: 'aviation', move: 'aircraft', cat: 'air', air: true, role: 'support', alt: 'low', fuel: 55, ammo: 6, svc: 16, cost: { steel: 80, fuel: 60, munitions: 30 }, pop: 1, time: 20, hp: 150, atk: 22, def: 6, range: 2, speed: 2.0, vision: 4, bonus: { tracked: 1.6, wheeled: 1.4 } },
  recon_drone: { name: 'Recon Drone', glyph: 'RD', men: 0, age: 3, tech: 'drones', move: 'aircraft', cat: 'air', air: true, civilian: true, role: 'recon', alt: 'low', fuel: 90, ammo: 0, svc: 10, cost: { steel: 20, electronics: 15, fuel: 10 }, pop: 0, time: 10, hp: 40, atk: 0, def: 2, range: 0, speed: 2.4, vision: 8 },
  missile_battery: { name: 'Missile Battery', glyph: 'MB', men: 6, age: 3, tech: 'precision_missiles', move: 'wheeled', cat: 'artillery', cost: { steel: 90, electronics: 40, munitions: 60 }, pop: 2, time: 22, hp: 130, atk: 42, def: 5, range: 8, speed: 0.9, vision: 3, vsBuildings: 3 },
  fighter: { name: 'Fighter', glyph: 'Fi', men: 1, age: 2, tech: 'aviation', move: 'aircraft', cat: 'air', air: true, role: 'fighter', alt: 'high', fuel: 60, ammo: 8, svc: 15, cost: { steel: 90, fuel: 50, credits: 40 }, pop: 1, time: 20, hp: 120, atk: 16, def: 8, range: 2, speed: 3.2, vision: 5 },
  bomber: { name: 'Tactical Bomber', glyph: 'Bo', men: 3, age: 3, tech: 'air_operations', move: 'aircraft', cat: 'air', air: true, role: 'bomber', alt: 'high', fuel: 80, ammo: 2, svc: 25, cost: { steel: 160, fuel: 80, munitions: 60, credits: 80 }, pop: 1, time: 28, hp: 200, atk: 34, def: 6, range: 1, speed: 2.2, vision: 4, vsBuildings: 2.5 },
  oneway_drone: { name: 'One-Way Strike Drone', glyph: 'OW', men: 0, age: 3, tech: 'drones', move: 'aircraft', cat: 'air', air: true, role: 'oneway', alt: 'low', oneWay: true, fuel: 45, ammo: 1, svc: 0, cost: { steel: 25, electronics: 10, munitions: 20 }, pop: 0, time: 10, hp: 30, atk: 26, def: 1, range: 0, speed: 2.8, vision: 3, vsBuildings: 2 },
  air_defense: { name: 'Air Defense Vehicle', glyph: 'AA', men: 4, age: 3, tech: 'air_defense', move: 'wheeled', cat: 'wheeled', cost: { steel: 70, electronics: 25, munitions: 30 }, pop: 1, time: 18, hp: 140, atk: 5, def: 8, range: 5, speed: 1.1, vision: 5 },
  special_forces: { name: 'Special Forces', glyph: 'SF', men: 8, age: 3, tech: 'special_operations', move: 'infantry', cat: 'infantry', cost: { food: 60, munitions: 40, electronics: 15 }, pop: 1, time: 16, hp: 140, atk: 19, def: 11, range: 2, speed: 0.9, vision: 4, stealth: true },
  autonomous_tank: { name: 'Autonomous Tank', glyph: 'AT', men: 0, age: 4, tech: 'robotics', move: 'tracked', cat: 'tracked', cost: { steel: 140, electronics: 45, fuel: 30 }, pop: 0, time: 22, hp: 340, atk: 40, def: 26, range: 3, speed: 1.15, vision: 4, bonus: { wheeled: 1.5, tracked: 1.2, infantry: 1.05 } },
  strike_swarm: { name: 'Strike Drone Swarm', glyph: 'SS', men: 0, age: 4, tech: 'strike_swarms', move: 'aircraft', cat: 'air', air: true, role: 'strike', alt: 'low', fuel: 60, ammo: 4, svc: 20, cost: { electronics: 60, steel: 40, munitions: 40 }, pop: 0, time: 16, hp: 120, atk: 30, def: 5, range: 2, speed: 2.6, vision: 4, bonus: { tracked: 1.5, artillery: 1.5 } },
  exo_infantry: { name: 'Exo-Armored Infantry', glyph: 'EX', men: 8, age: 4, tech: 'exo_armor', move: 'infantry', cat: 'infantry', cost: { food: 50, steel: 70, electronics: 40 }, pop: 1, time: 18, hp: 230, atk: 27, def: 19, range: 2, speed: 0.95, vision: 3, bonus: { infantry: 1.25 } },
};

for (const [k, u] of Object.entries(UNITS)) u.key = k;

// Pace: this is a real-time strategy game, so research, construction, training and eras move
// briskly and troops cross the map quickly. One place to tune the whole tempo.
export const PACE = { research: 0.75, build: 0.6, train: 0.6, era: 0.5, eraCost: 0.75, move: 1.2 };
// later eras' technologies cost far more: the whole tree is a long game, not a quarter of an hour
const ERA_RESEARCH = [1, 2, 3.5, 5.5, 8];
for (const t of Object.values(TECHS)) t.cost = Math.round(t.cost * PACE.research * ERA_RESEARCH[t.age]);
// Goods to begin a technology, by era: the industrial base is the bottleneck between the eras
export const TECH_GOODS = [null, { materials: 150, ore: 60 }, { steel: 120, fuel: 40 }, { steel: 240, fuel: 140 }, { steel: 300, electronics: 120 }];
for (const t of Object.values(TECHS)) if (TECH_GOODS[t.age]) { t.goods = { ...TECH_GOODS[t.age] }; t.desc += ` Needs ${Object.entries(t.goods).map(([k, v]) => `${v} ${k}`).join(' and ')} to begin.`; }

// Every technology also makes the nation better at something, on top of what it unlocks:
// output of a good (or 'industry': steel, munitions, electronics), construction speed, unit attack
// by class ('all', 'infantry', 'wheeled', 'tracked', 'artillery', 'air'), movement, stability.
export const TECH_FX = {
  agronomy: { food: 0.1 }, salvage_engineering: { materials: 0.1 }, small_arms: { atk: { infantry: 0.1 } }, fortification: { stability: 3 },
  trade_networks: { credits: 0.1 }, schooling: { research: 0.1 }, seafaring: { food: 0.05, credits: 0.05 }, surveying: { build: 0.1 },
  metallurgy: { materials: 0.05, industry: 0.1 }, electrification: { industry: 0.1, research: 0.05 }, petroleum: { fuel: 0.15 }, motorization: { speed: 0.06, atk: { wheeled: 0.1 } },
  munitions_industry: { munitions: 0.15 }, logistics: { speed: 0.06, build: 0.05 }, field_artillery: { atk: { artillery: 0.15 } }, civil_engineering: { build: 0.2 },
  higher_education: { research: 0.15 },
  mechanization: { atk: { tracked: 0.1 } }, aviation: { atk: { air: 0.1 } }, highways: { speed: 0.05, credits: 0.05 }, railways: { materials: 0.1, build: 0.1 },
  mechanized_agriculture: { food: 0.2 }, self_propelled_guns: { atk: { artillery: 0.1 } }, corporate_charter: { credits: 0.2 },
  computing: { research: 0.2, industry: 0.05 }, materials_recycling: { materials: 0.15, industry: 0.05 }, networked_command: { atk: { all: 0.08 } }, drones: { atk: { air: 0.1 } },
  air_operations: { atk: { air: 0.1 } }, precision_missiles: { atk: { artillery: 0.1 } }, air_defense: { stability: 2 }, special_operations: { atk: { infantry: 0.1 } }, federal_union: { stability: 5, credits: 0.1 },
  robotics: { industry: 0.2, atk: { tracked: 0.1 } }, fusion_power: { industry: 0.15, research: 0.1 }, strike_swarms: { atk: { air: 0.15 } }, exo_armor: { atk: { infantry: 0.15 } },
  climate_engineering: { food: 0.1, stability: 3 }, energy_shields: { stability: 2 }, improved_servicing: { atk: { air: 0.05 } }, missile_defense: { stability: 3 }, strategic_missiles: { atk: { all: 0.05 } }, continental_arcology: { research: 0.2, stability: 5 },
};
const FX_WORD = { food: 'food', materials: 'materials', credits: 'credits', research: 'research', fuel: 'fuel', munitions: 'munitions', industry: 'steel, munitions and electronics', build: 'construction speed', speed: 'unit speed' };
for (const [k, fx] of Object.entries(TECH_FX)) {
  if (!TECHS[k]) continue;
  const parts = [];
  for (const [e, v] of Object.entries(fx)) {
    if (e === 'atk') for (const [cat, x] of Object.entries(v)) parts.push(`+${Math.round(x * 100)}% attack (${cat === 'all' ? 'all units' : cat === 'air' ? 'aircraft' : cat === 'tracked' ? 'tracked vehicles' : cat === 'wheeled' ? 'wheeled vehicles' : cat})`);
    else if (e === 'stability') parts.push(`+${v} stability`);
    else parts.push(`+${Math.round(v * 100)}% ${FX_WORD[e] || e}`);
  }
  if (parts.length) { TECHS[k].fx = fx; TECHS[k].desc += ` Nation-wide: ${parts.join(', ')}.`; }
}
// a civ's combined technology bonuses (cached until its technologies change)
export function techFx(civ) {
  if (civ._fx && civ._fxN === civ.techs.size) return civ._fx;
  const out = { atk: {} };
  for (const t of civ.techs) { if (nativeRules(civ) && REMOVED_TECHS.has(t)) continue; const fx = TECH_FX[t]; if (!fx) continue; for (const [e, v] of Object.entries(fx)) { if (e === 'atk') for (const [c, x] of Object.entries(v)) out.atk[c] = (out.atk[c] || 0) + x; else out[e] = (out[e] || 0) + v; } }
  Object.defineProperty(civ, '_fx', { value: out, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(civ, '_fxN', { value: civ.techs.size, writable: true, configurable: true, enumerable: false });
  return out;
}
for (const b of Object.values(BUILDINGS)) if (b.time) b.time = Math.max(5, Math.round(b.time * PACE.build));
for (const u of Object.values(UNITS)) { u.time = Math.max(4, Math.round(u.time * PACE.train)); if (u.move !== 'aircraft') u.speed = +(u.speed * PACE.move).toFixed(2); }
for (const a of AGES) { if (a.time) a.time = Math.round(a.time * PACE.era); if (a.cost) for (const k in a.cost) a.cost[k] = Math.round(a.cost[k] * PACE.eraCost); }
// derived, for display and the AI: multiplier this unit's weapon applies against aircraft (0 = cannot)
for (const [k, u] of Object.entries(UNITS)) { const w = WEAPONS[UNIT_WEAPON[k]]; u.aa = w ? (w.targets.includes('air') ? w.airMul || 1 : w.targets.includes('lowair') ? (w.airMul || 1) * 0.5 : 0) : 0; }

export const CIV_COLORS = [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308, 0xa855f7, 0x06b6d4, 0xf97316, 0xec4899, 0x84cc16, 0xf43f5e, 0x14b8a6, 0xd4a373];
export const CIV_NAMES = ['Azure Dominion', 'Crimson Directorate', 'Verdant League', 'Golden Compact', 'Violet Syndicate', 'Cyan Federation', 'Ember Republic', 'Rose Assembly', 'Lime Concord', 'Scarlet Union', 'Teal Commonwealth', 'Umber Protectorate'];
export const MAX_CIVS = 12;
export const REBEL = { name: 'Free Companies', color: 0x8b8b8b };

export const FORMATIONS = { line: 'Line', column: 'Column', wedge: 'Wedge', box: 'Box' };
export const STANCES = { aggressive: 'Aggressive', defensive: 'Defensive', hold: 'Hold position', passive: 'Hold fire' };
export const ALERT_LEVELS = ['info', 'minor', 'major', 'critical'];

export const GOVERNOR_SPECS = {
  balanced: { name: 'Balanced', desc: 'Grow steadily: food, housing, materials, then services.' },
  industrial: { name: 'Industrial Center', desc: 'Mines, mills, power and munitions.' },
  agrarian: { name: 'Breadbasket', desc: 'Farms and housing; feeds the empire.' },
  commercial: { name: 'Trade Hub', desc: 'Markets, ports and road links.' },
  research: { name: 'Research Campus', desc: 'Academies and universities.' },
  fortress: { name: 'Fortress City', desc: 'Bunkers, fortresses and a standing garrison.' },
};

export const ENGAGE_POLICIES = { balanced: 'Balanced engagement', focus: 'Focus fire', threat: 'Threat priority', antiArmor: 'Anti-armour', counterBattery: 'Counter-battery', defensive: 'Defensive (no pursuit)' };
export const COMBAT_STATUS = ['Idle', 'Moving', 'Engaging', 'Repositioning', 'Suppressed', 'Out of range', 'No line of fire', 'Reloading', 'Low ammunition', 'Retreating', 'Pinned down'];
// World market: goods bought with credits through your markets (another route past a missing deposit).
export const IMPORT_PRICE = { food: 2, materials: 3, ore: 5, steel: 11, fuel: 9, munitions: 9, electronics: 24 };
export const IMPORT_PER_MARKET = 60;     // units per minute each operational market can bring in

// Refit paths: surviving units (and their veterancy) are re-equipped instead of replaced.
// conv: a conversion between movement classes, priced closer to a new unit.
// AI difficulty (profile v2). Two separate things:
//   skill       - how well the AI plans (army sizing, reconnaissance, reserves, retreat judgment,
//                 counter-composition, campaign coordination, fortifying, reacting to artillery)
//   advantages  - explicit numerical bonuses. Off at every level under Fair Play (the default);
//                 only Brutal offers them, and the lobby discloses them.
// Matches saved before v2 keep their old multipliers (profile 'legacy'), shown as such.
export const DIFFICULTY = {
  easy: { name: 'Relaxed', blurb: 'Learns with you: builds, defends, forms armies; slow to adapt and makes readable mistakes.',
    skill: { level: 0, react: 1.0, switch: 2.0, commit: 1.4, recon: 0.5, reserve: 0, retreat: 0.25, counter: 0, scale: 0.8, fortify: false, screen: false, raid: false, disperse: false, plan: 'short' } },
  normal: { name: 'Standard', blurb: 'The fair benchmark: a working economy, sensible research, balanced armies and stable objectives.',
    skill: { level: 1, react: 1.3, switch: 1.5, commit: 1, recon: 1, reserve: 0.15, retreat: 0.35, counter: 0.35, scale: 1, fortify: true, screen: false, raid: false, disperse: true, plan: 'moderate' } },
  hard: { name: 'Hard', blurb: 'Deeper planning, better scouting, deliberate reserves and counter-aware armies.',
    skill: { level: 2, react: 1.5, switch: 1.35, commit: 0.85, recon: 1.5, reserve: 0.25, retreat: 0.45, counter: 0.7, scale: 1.05, fortify: true, screen: true, raid: false, disperse: true, plan: 'long' } },
  expert: { name: 'Expert', blurb: 'Coordinates offense and defense, hunts exposed logistics, weighs relative strength before it commits.',
    skill: { level: 3, react: 1.6, switch: 1.3, commit: 0.8, recon: 1.5, reserve: 0.3, retreat: 0.5, counter: 0.85, scale: 1.1, fortify: true, screen: true, raid: true, disperse: true, plan: 'long' } },
  brutal: { name: 'Brutal', blurb: 'The strongest planner, adapting aggressively. Economic help only if you allow it (shown below).',
    skill: { level: 4, react: 1.8, switch: 1.2, commit: 0.7, recon: 2, reserve: 0.3, retreat: 0.5, counter: 1, scale: 1.15, fortify: true, screen: true, raid: true, disperse: true, plan: 'multi' },
    advantages: { econ: 1.15, research: 1.1, army: 1.2 } },
};
export const DIFFICULTY_LEGACY = { easy: { econ: 0.85, army: 0.7, research: 0.85 }, normal: { econ: 1, army: 1, research: 1 }, hard: { econ: 1.12, army: 1.25, research: 1.1 }, brutal: { econ: 1.25, army: 1.5, research: 1.2 } };
export const NO_ADVANTAGE = { econ: 1, research: 1, army: 1 };
// the profile an AI empire actually runs with
export function aiProfile(civ) {
  const d = DIFFICULTY[civ.difficulty] || DIFFICULTY.normal;
  if (civ.diffProfile === 'legacy') return { skill: d.skill, adv: DIFFICULTY_LEGACY[civ.difficulty] || NO_ADVANTAGE, legacy: true };
  return { skill: d.skill, adv: civ.fairPlay === false && d.advantages ? d.advantages : NO_ADVANTAGE, legacy: false };
}

export const REFIT = {
  militia: [{ to: 'rifle_squad' }],
  rifle_squad: [{ to: 'mech_infantry' }, { to: 'special_forces' }],
  mech_infantry: [{ to: 'exo_infantry' }],
  scout_buggy: [{ to: 'armored_car' }],
  armored_car: [{ to: 'tank', conv: true }, { to: 'air_defense' }],
  tank: [{ to: 'autonomous_tank' }],
  mortar_team: [{ to: 'field_gun', conv: true }],
  field_gun: [{ to: 'sp_artillery', conv: true }],
  sp_artillery: [{ to: 'missile_battery', conv: true }],
  helicopter: [{ to: 'strike_swarm', conv: true }],
};
export const VET_NAMES = ['Green', 'Regular', 'Veteran', 'Elite'];
export const GOVERNOR_GOALS = { none: { name: 'No particular goal' }, grow: { name: 'Grow population' }, steel: { name: 'Increase steel output' }, self: { name: 'Become self-sufficient' },
  defense: { name: 'Strengthen defenses' }, repair: { name: 'Repair war damage' }, research: { name: 'Become a research centre' } };

export const GAME_DEFS = { TECH_CAT, DIFFICULTY, GOVERNOR_GOALS, IMPORT_PRICE, IMPORT_PER_MARKET, REFIT, VET_NAMES, W, H, TERRAIN, MOVE, ROAD_TYPES, RESOURCE, GOODS, GOOD_NAMES, AGES, TECHS, GOVS, POLICIES, FOCI, TAX, BUILDINGS, UNITS, CIV_COLORS, CIV_NAMES, REBEL, GOVERNOR_SPECS, FORMATIONS, STANCES, ALERT_LEVELS,
  WEAPONS, UNIT_WEAPON, BUILDING_WEAPON, WEAPON_KEYS, ENGAGE_POLICIES, COMBAT_STATUS };
