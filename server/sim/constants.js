// Shattered Empires — game data (sent to clients in `welcome`).
// Setting: a post-collapse continent. Five eras take survivors from salvaged tools
// (Reclamation) to autonomous war machines (Advanced Systems).
export const W = 128;
export const H = 128;
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
export const MOVE = {
  infantry: { terrain: [Infinity, Infinity, 1, 1, 2, 1.5, 1.5, 3, 2, 4, Infinity, Infinity, 1.2], road: [1, 0.55, 0.45, 0.4, 0.5], ford: 1.5, majorFord: 2.5 },
  wheeled: { terrain: [Infinity, Infinity, 1.2, 1.1, 3.5, 1.8, 2, Infinity, 3, Infinity, Infinity, Infinity, 1.4], road: [1, 0.3, 0.2, 0.15, 0.25], ford: 4, majorFord: Infinity },
  tracked: { terrain: [Infinity, Infinity, 1, 1, 2, 1.3, 1.6, 4, 2, Infinity, Infinity, Infinity, 1.2], road: [1, 0.45, 0.3, 0.25, 0.3], ford: 3, majorFord: Infinity, heavy: true },
  aircraft: { air: true },
};
export const ROAD_TYPES = [
  null,
  { id: 1, key: 'dirt', name: 'Dirt road', cost: { materials: 2 }, time: 1.2, capacity: 8, tech: null },
  { id: 2, key: 'paved', name: 'Paved road', cost: { materials: 3, steel: 1 }, time: 1.6, capacity: 12, tech: 'civil_engineering' },
  { id: 3, key: 'highway', name: 'Highway', cost: { materials: 4, steel: 2, fuel: 1 }, time: 2, capacity: 18, tech: 'highways' },
  { id: 4, key: 'rail', name: 'Railway', cost: { steel: 3, ore: 1 }, time: 2, capacity: 10, tech: 'railways' },
];
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
  { id: 1, name: 'Industrial Recovery', techsNeeded: 5, cost: { food: 500, materials: 500, credits: 300 }, time: 40 },
  { id: 2, name: 'Mechanization', techsNeeded: 5, cost: { steel: 400, fuel: 250, credits: 800 }, time: 50 },
  { id: 3, name: 'Networked Warfare', techsNeeded: 5, cost: { steel: 700, fuel: 500, credits: 1500, munitions: 200 }, time: 60 },
  { id: 4, name: 'Advanced Systems', techsNeeded: 5, cost: { steel: 1000, electronics: 400, credits: 2500 }, time: 70 },
];

// ---- Technology graph (req = prerequisites) --------------------------------
export const TECHS = {
  // Reclamation
  agronomy: { name: 'Agronomy', age: 0, cost: 60, req: [], desc: '+25% farm output; Rationing policy.' },
  salvage_engineering: { name: 'Salvage Engineering', age: 0, cost: 60, req: [], desc: 'Salvage yards on old-world ruins (materials + steel).' },
  small_arms: { name: 'Small Arms', age: 0, cost: 60, req: [], desc: 'Rifle squads.' },
  fortification: { name: 'Fortification', age: 0, cost: 70, req: ['salvage_engineering'], desc: 'Bunkers; Fortification Doctrine policy.' },
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
  seismology: { name: 'Seismology', age: 1, cost: 300, req: ['surveying'], desc: 'Seismic stations; early warning of quakes & eruptions.' },
  higher_education: { name: 'Higher Education', age: 1, cost: 300, req: ['schooling'], desc: 'Universities; Technocracy.' },
  // Mechanization
  mechanization: { name: 'Mechanization', age: 2, cost: 700, req: ['motorization'], desc: 'Heavy assembly: tanks, mechanized infantry.' },
  aviation: { name: 'Aviation', age: 2, cost: 720, req: ['petroleum'], desc: 'Airfields and attack helicopters.' },
  highways: { name: 'Highways', age: 2, cost: 650, req: ['civil_engineering'], desc: 'Highways: fastest road movement and supply.' },
  railways: { name: 'Railways', age: 2, cost: 650, req: ['civil_engineering'], desc: 'Railways for bulk supply and transport.' },
  mechanized_agriculture: { name: 'Mechanized Agriculture', age: 2, cost: 650, req: ['agronomy'], desc: '+50% farm output, +housing.' },
  geoengineering: { name: 'Geoengineering', age: 2, cost: 700, req: ['seismology'], desc: 'Stabilizers; Conservation policy; terrain events do half damage.' },
  self_propelled_guns: { name: 'Self-Propelled Guns', age: 2, cost: 700, req: ['field_artillery'], desc: 'Self-propelled artillery.' },
  corporate_charter: { name: 'Corporate Charter', age: 2, cost: 650, req: ['trade_networks'], desc: 'Corporate State government.' },
  // Networked Warfare
  computing: { name: 'Computing', age: 3, cost: 1200, req: ['electrification', 'higher_education'], desc: 'Electronics plants (need rare earths in territory).' },
  networked_command: { name: 'Networked Command', age: 3, cost: 1200, req: ['computing'], desc: 'Comms towers: long-range vision, +1 supply range.' },
  drones: { name: 'Drones', age: 3, cost: 1250, req: ['computing', 'aviation'], desc: 'Drone works: recon drones.' },
  precision_missiles: { name: 'Precision Missiles', age: 3, cost: 1300, req: ['drones'], desc: 'Missile batteries.' },
  air_defense: { name: 'Air Defense', age: 3, cost: 1150, req: ['aviation'], desc: 'Air-defense vehicles.' },
  special_operations: { name: 'Special Operations', age: 3, cost: 1150, req: ['small_arms'], desc: 'Special forces (hidden beyond 2 hexes).' },
  federal_union: { name: 'Federal Union', age: 3, cost: 1150, req: ['higher_education'], desc: 'Federal Republic government.' },
  // Advanced Systems
  robotics: { name: 'Robotics', age: 4, cost: 2000, req: ['computing', 'mechanization'], desc: 'Robotics complex: autonomous tanks.' },
  fusion_power: { name: 'Fusion Power', age: 4, cost: 2100, req: ['electrification', 'computing'], desc: 'Fusion plants: abundant power without fuel.' },
  strike_swarms: { name: 'Strike Swarms', age: 4, cost: 2100, req: ['drones', 'robotics'], desc: 'Strike drone swarms.' },
  exo_armor: { name: 'Exo Armor', age: 4, cost: 2000, req: ['robotics'], desc: 'Exo-armored infantry.' },
  climate_engineering: { name: 'Climate Engineering', age: 4, cost: 2000, req: ['geoengineering'], desc: 'Droughts and quakes in your territory are suppressed.' },
  continental_arcology: { name: 'Continental Arcology', age: 4, cost: 2400, req: ['fusion_power'], desc: 'The Arcology wonder (victory project).' },
};

// ---- Governments & policies ----------------------------------------------
export const GOVS = {
  council: { name: 'Provisional Council', slots: 2, desc: 'Survivors governing by committee. No modifiers.' },
  technocracy: { name: 'Technocracy', tech: 'higher_education', slots: 3, desc: '+20% research, +10% power output, -6 stability.' },
  junta: { name: 'Military Junta', tech: 'munitions_industry', slots: 3, desc: 'Units 20% cheaper, +10% attack, -8 stability, -15% research.' },
  corporate: { name: 'Corporate State', tech: 'corporate_charter', slots: 3, desc: '+30% credits, +10% industry, -10% unit attack.' },
  federal: { name: 'Federal Republic', tech: 'federal_union', slots: 4, desc: '+10 stability, +10% all production, war weariness doubled.' },
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
  conservation: { name: 'Conservation', tech: 'geoengineering', desc: 'Terrain events do 50% less damage; +5 stability.' },
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
// place: 'city' | 'flat' | 'farm' | 'forest' | 'quarry' | 'mine' | 'oil' | 'ruins' | 'coast' | 'any'
export const BUILDINGS = {
  town: { name: 'Settlement Hub', glyph: '\u{1F3D8}', age: 0, cost: {}, time: 0, hp: 1000, place: 'city', cat: 'civic',
    jobs: ['worker', 2], produce: { food: 0.3, materials: 0.35, credits: 0.15 }, housing: 8, vision: 5, attack: 8, range: 3, aa: 0.5,
    trains: ['colonist', 'engineer', 'scout_buggy', 'supply_truck'] },
  house: { name: 'Housing Block', glyph: '\u{1F3E2}', age: 0, cost: { materials: 30 }, time: 10, hp: 160, place: 'flat', housing: 4, cat: 'residential' },
  farm: { name: 'Farm', glyph: '\u{1F33E}', age: 0, cost: { materials: 25 }, time: 10, hp: 120, place: 'farm', jobs: ['worker', 3], produce: { food: 0.45 }, cat: 'agri' },
  lumber: { name: 'Timber Mill', glyph: '\u{1FAB5}', age: 0, cost: { materials: 20 }, time: 10, hp: 120, place: 'forest', jobs: ['worker', 3], produce: { materials: 0.3 }, cat: 'industry' },
  quarry: { name: 'Quarry', glyph: '\u{1FAA8}', age: 0, cost: { materials: 35 }, time: 14, hp: 160, place: 'quarry', jobs: ['worker', 3], produce: { materials: 0.26 }, cat: 'industry' },
  salvage: { name: 'Salvage Yard', glyph: '⚙', age: 0, tech: 'salvage_engineering', cost: { materials: 40 }, time: 14, hp: 160, place: 'ruins', jobs: ['worker', 3], produce: { materials: 0.25, steel: 0.08, credits: 0.05 }, cat: 'industry' },
  barracks: { name: 'Barracks', glyph: '⚔', age: 0, cost: { materials: 80 }, time: 20, hp: 320, place: 'flat', cat: 'military',
    trains: ['militia', 'rifle_squad', 'mortar_team', 'special_forces', 'exo_infantry'] },
  market: { name: 'Market', glyph: '\u{1F4B0}', age: 0, tech: 'trade_networks', cost: { materials: 70 }, time: 18, hp: 200, place: 'flat', jobs: ['merchant', 3], produce: { credits: 0.45 }, cat: 'commerce' },
  academy: { name: 'Academy', glyph: '\u{1F4DA}', age: 0, tech: 'schooling', cost: { materials: 80, credits: 20 }, time: 20, hp: 200, place: 'flat', jobs: ['specialist', 3], produce: { research: 0.25 }, cat: 'science' },
  port: { name: 'Port', glyph: '⚓', age: 0, tech: 'seafaring', cost: { materials: 90 }, time: 20, hp: 260, place: 'coast', jobs: ['worker', 2], produce: { food: 0.45, credits: 0.15 }, vision: 4, supply: 4, cat: 'logistics' },
  bunker: { name: 'Bunker', glyph: '\u{1F6E1}', age: 0, tech: 'fortification', cost: { materials: 90 }, time: 18, hp: 450, place: 'any', vision: 5, attack: 8, range: 3, aa: 0.4, anywhere: true, cat: 'military' },
  mine: { name: 'Mine', glyph: '⛏', age: 1, tech: 'metallurgy', cost: { materials: 80 }, time: 18, hp: 180, place: 'mine', jobs: ['worker', 3], produce: { ore: 0.3 }, cat: 'industry' },
  steel_mill: { name: 'Steel Mill', glyph: '\u{1F3ED}', age: 1, tech: 'metallurgy', cost: { materials: 140 }, time: 26, hp: 360, place: 'flat', jobs: ['worker', 3], produce: { steel: 0.3 }, consume: { ore: 0.22 }, power: -2, cat: 'industry' },
  power_plant: { name: 'Power Plant', glyph: '⚡', age: 1, tech: 'electrification', cost: { materials: 160, steel: 40 }, time: 28, hp: 380, place: 'flat', jobs: ['worker', 2], consume: { ore: 0.08 }, power: 9, cat: 'power' },
  oil_well: { name: 'Oil Well', glyph: '\u{1F6E2}', age: 1, tech: 'petroleum', cost: { materials: 90, steel: 20 }, time: 20, hp: 200, place: 'oil', jobs: ['worker', 2], produce: { fuel: 0.4 }, cat: 'industry' },
  munitions_plant: { name: 'Munitions Plant', glyph: '\u{1F9E8}', age: 1, tech: 'munitions_industry', cost: { materials: 120, steel: 40 }, time: 26, hp: 320, place: 'flat', jobs: ['worker', 3], produce: { munitions: 0.4 }, consume: { steel: 0.08 }, power: -2, cat: 'industry' },
  motor_works: { name: 'Motor Works', glyph: '\u{1F69A}', age: 1, tech: 'motorization', cost: { materials: 150, steel: 60 }, time: 28, hp: 380, place: 'flat', power: -2, cat: 'military',
    trains: ['armored_car', 'supply_truck', 'field_gun', 'missile_battery', 'air_defense'] },
  depot: { name: 'Supply Depot', glyph: '\u{1F4E6}', age: 1, tech: 'logistics', cost: { materials: 90, steel: 20 }, time: 20, hp: 300, place: 'any', supply: 5, vision: 3, anywhere: true, cat: 'logistics', trains: ['supply_truck'] },
  fort: { name: 'Fortress', glyph: '\u{1F3EF}', age: 1, tech: 'civil_engineering', cost: { materials: 200, steel: 60 }, time: 30, hp: 1300, place: 'any', vision: 4, attack: 14, range: 4, aa: 0.6, anywhere: true, blocksSupply: 2, heals: true, cat: 'military' },
  seismic: { name: 'Seismic Station', glyph: '\u{1F4E1}', age: 1, tech: 'seismology', cost: { materials: 100, credits: 60 }, time: 24, hp: 200, place: 'flat', jobs: ['specialist', 1], produce: { research: 0.2 }, stabilize: 0.15, cat: 'science' },
  university: { name: 'University', glyph: '\u{1F393}', age: 1, tech: 'higher_education', cost: { materials: 160, credits: 120 }, time: 32, hp: 300, place: 'flat', jobs: ['specialist', 3], produce: { research: 0.45 }, power: -1, cat: 'science' },
  heavy_assembly: { name: 'Heavy Assembly', glyph: '\u{1F3D7}', age: 2, tech: 'mechanization', cost: { materials: 220, steel: 160 }, time: 36, hp: 520, place: 'flat', power: -4, cat: 'military',
    trains: ['mech_infantry', 'tank', 'sp_artillery', 'autonomous_tank'] },
  airfield: { name: 'Airfield', glyph: '\u{1F6EB}', age: 2, tech: 'aviation', cost: { materials: 200, steel: 120, fuel: 60 }, time: 34, hp: 450, place: 'flat', power: -2, supply: 3, airSupply: 7, vision: 5, cat: 'military',
    trains: ['helicopter', 'recon_drone', 'strike_swarm'] },
  stabilizer: { name: 'Crustal Stabilizer', glyph: '\u{1F9F1}', age: 2, tech: 'geoengineering', cost: { materials: 180, steel: 80 }, time: 26, hp: 400, place: 'any', stabilize: 0.35, anywhere: true, power: -2, cat: 'science' },
  electronics_plant: { name: 'Electronics Plant', glyph: '\u{1F4BB}', age: 3, tech: 'computing', needs: 'rare', cost: { materials: 200, steel: 150 }, time: 36, hp: 400, place: 'flat', jobs: ['worker', 3], produce: { electronics: 0.3 }, consume: { steel: 0.08 }, power: -3, cat: 'industry' },
  comms_tower: { name: 'Comms Tower', glyph: '\u{1F4E1}', age: 3, tech: 'networked_command', cost: { steel: 120, electronics: 40 }, time: 26, hp: 260, place: 'any', vision: 9, anywhere: true, power: -1, cat: 'logistics' },
  drone_works: { name: 'Drone Works', glyph: '\u{1F6F8}', age: 3, tech: 'drones', cost: { steel: 200, electronics: 80 }, time: 36, hp: 420, place: 'flat', power: -3, cat: 'military',
    trains: ['recon_drone', 'strike_swarm', 'missile_battery', 'air_defense'] },
  fusion_plant: { name: 'Fusion Plant', glyph: '☢', age: 4, tech: 'fusion_power', cost: { steel: 400, electronics: 200 }, time: 45, hp: 700, place: 'flat', jobs: ['specialist', 2], power: 30, cat: 'power' },
  robotics_complex: { name: 'Robotics Complex', glyph: '\u{1F916}', age: 4, tech: 'robotics', cost: { steel: 400, electronics: 250 }, time: 45, hp: 600, place: 'flat', power: -5, cat: 'military',
    trains: ['autonomous_tank', 'exo_infantry', 'strike_swarm'] },
  camp: { name: 'Rebel Camp', glyph: '⛺', age: 0, rebelOnly: true, cost: {}, time: 0, hp: 450, place: 'any', vision: 5, attack: 6, range: 2, aa: 0.3, supply: 5, cat: 'military' },
  wonder: { name: 'Continental Arcology', glyph: '\u{1F3D9}', age: 4, tech: 'continental_arcology', cost: { steel: 2500, electronics: 900, credits: 4000, materials: 3000 }, time: 180, hp: 3000, place: 'flat', wonder: true, power: -10, cat: 'civic' },
};

// ---- Units ----------------------------------------------------------------
// move: movement class; cat: combat category (for bonuses); aa: multiplier vs aircraft (0 = cannot hit air).
export const UNITS = {
  colonist: { name: 'Colonist Convoy', glyph: 'Co', age: 0, move: 'infantry', cat: 'civilian', cost: { food: 80, materials: 50, credits: 20 }, pop: 3, time: 12, hp: 50, atk: 0, def: 1, range: 0, speed: 0.6, vision: 2, civilian: true },
  engineer: { name: 'Engineer Team', glyph: 'En', age: 0, move: 'infantry', cat: 'support', cost: { food: 30, materials: 40 }, pop: 1, time: 10, hp: 70, atk: 2, def: 3, range: 1, speed: 0.7, vision: 2, engineer: true },
  scout_buggy: { name: 'Scout Buggy', glyph: 'Sc', age: 0, move: 'wheeled', cat: 'wheeled', cost: { food: 20, materials: 25 }, pop: 1, time: 8, hp: 60, atk: 3, def: 2, range: 1, speed: 1.7, vision: 5, aa: 0.2 },
  militia: { name: 'Militia', glyph: 'Mi', age: 0, move: 'infantry', cat: 'infantry', cost: { food: 30, materials: 15 }, pop: 1, time: 9, hp: 90, atk: 6, def: 5, range: 1, speed: 0.7, vision: 2, aa: 0.2 },
  rifle_squad: { name: 'Rifle Squad', glyph: 'Ri', age: 0, tech: 'small_arms', move: 'infantry', cat: 'infantry', cost: { food: 40, materials: 30, credits: 10 }, pop: 1, time: 11, hp: 100, atk: 9, def: 6, range: 2, speed: 0.7, vision: 3, aa: 0.3 },
  mortar_team: { name: 'Mortar Team', glyph: 'Mo', age: 1, tech: 'munitions_industry', move: 'infantry', cat: 'artillery', cost: { food: 40, steel: 15, munitions: 15 }, pop: 1, time: 13, hp: 80, atk: 13, def: 3, range: 4, speed: 0.6, vision: 2, bonus: { infantry: 1.4 }, vsBuildings: 1.5 },
  armored_car: { name: 'Armored Car', glyph: 'AC', age: 1, tech: 'motorization', move: 'wheeled', cat: 'wheeled', cost: { steel: 35, fuel: 20, credits: 20 }, pop: 1, time: 14, hp: 150, atk: 12, def: 9, range: 2, speed: 1.4, vision: 4, aa: 0.3, bonus: { infantry: 1.3 } },
  supply_truck: { name: 'Supply Truck', glyph: 'Tr', age: 1, tech: 'motorization', move: 'wheeled', cat: 'support', cost: { materials: 50, steel: 15, fuel: 15 }, pop: 1, time: 12, hp: 70, atk: 0, def: 2, range: 0, speed: 1.2, vision: 2, civilian: true, supplyRadius: 4 },
  field_gun: { name: 'Field Gun', glyph: 'FG', age: 1, tech: 'field_artillery', move: 'wheeled', cat: 'artillery', cost: { steel: 50, munitions: 30 }, pop: 2, time: 18, hp: 90, atk: 24, def: 2, range: 5, speed: 0.6, vision: 2, vsBuildings: 2.5 },
  mech_infantry: { name: 'Mechanized Infantry', glyph: 'MI', age: 2, tech: 'mechanization', move: 'tracked', cat: 'tracked', cost: { food: 40, steel: 60, fuel: 25 }, pop: 1, time: 16, hp: 190, atk: 17, def: 13, range: 2, speed: 1.1, vision: 3, aa: 0.5 },
  tank: { name: 'Main Battle Tank', glyph: 'Tk', age: 2, tech: 'mechanization', move: 'tracked', cat: 'tracked', cost: { steel: 110, fuel: 40, munitions: 20 }, pop: 1, time: 20, hp: 280, atk: 28, def: 18, range: 2, speed: 1.0, vision: 3, bonus: { wheeled: 1.5, infantry: 1.2 } },
  sp_artillery: { name: 'Self-Propelled Gun', glyph: 'SP', age: 2, tech: 'self_propelled_guns', move: 'tracked', cat: 'artillery', cost: { steel: 100, fuel: 30, munitions: 40 }, pop: 2, time: 20, hp: 150, atk: 34, def: 6, range: 6, speed: 0.8, vision: 3, vsBuildings: 2.5 },
  helicopter: { name: 'Attack Helicopter', glyph: 'He', age: 2, tech: 'aviation', move: 'aircraft', cat: 'air', air: true, cost: { steel: 80, fuel: 60, munitions: 30 }, pop: 1, time: 20, hp: 150, atk: 22, def: 6, range: 2, speed: 2.0, vision: 4, aa: 0.5, bonus: { tracked: 1.6, wheeled: 1.4 } },
  recon_drone: { name: 'Recon Drone', glyph: 'RD', age: 3, tech: 'drones', move: 'aircraft', cat: 'air', air: true, civilian: true, cost: { steel: 20, electronics: 15, fuel: 10 }, pop: 0, time: 10, hp: 40, atk: 0, def: 2, range: 0, speed: 2.4, vision: 8 },
  missile_battery: { name: 'Missile Battery', glyph: 'MB', age: 3, tech: 'precision_missiles', move: 'wheeled', cat: 'artillery', cost: { steel: 90, electronics: 40, munitions: 60 }, pop: 2, time: 22, hp: 130, atk: 42, def: 5, range: 8, speed: 0.9, vision: 3, vsBuildings: 3 },
  air_defense: { name: 'Air Defense Vehicle', glyph: 'AA', age: 3, tech: 'air_defense', move: 'wheeled', cat: 'wheeled', cost: { steel: 70, electronics: 25, munitions: 30 }, pop: 1, time: 18, hp: 140, atk: 5, def: 8, range: 5, speed: 1.1, vision: 5, aa: 4.5 },
  special_forces: { name: 'Special Forces', glyph: 'SF', age: 3, tech: 'special_operations', move: 'infantry', cat: 'infantry', cost: { food: 50, munitions: 30, electronics: 10 }, pop: 1, time: 16, hp: 140, atk: 19, def: 11, range: 2, speed: 0.9, vision: 4, aa: 0.5, stealth: true },
  autonomous_tank: { name: 'Autonomous Tank', glyph: 'AT', age: 4, tech: 'robotics', move: 'tracked', cat: 'tracked', cost: { steel: 160, electronics: 60, fuel: 30 }, pop: 0, time: 22, hp: 340, atk: 40, def: 26, range: 3, speed: 1.15, vision: 4, aa: 0.6, bonus: { wheeled: 1.5, tracked: 1.2 } },
  strike_swarm: { name: 'Strike Drone Swarm', glyph: 'SS', age: 4, tech: 'strike_swarms', move: 'aircraft', cat: 'air', air: true, cost: { electronics: 60, steel: 40, munitions: 40 }, pop: 0, time: 16, hp: 120, atk: 30, def: 5, range: 2, speed: 2.6, vision: 4, aa: 0.8, bonus: { tracked: 1.5, artillery: 1.5 } },
  exo_infantry: { name: 'Exo-Armored Infantry', glyph: 'EX', age: 4, tech: 'exo_armor', move: 'infantry', cat: 'infantry', cost: { food: 50, steel: 60, electronics: 30 }, pop: 1, time: 18, hp: 230, atk: 27, def: 19, range: 2, speed: 0.95, vision: 3, aa: 0.8 },
};

export const CIV_COLORS = [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308, 0xa855f7, 0x06b6d4, 0xf97316, 0xec4899, 0x8b8b8b];
export const CIV_NAMES = ['Azure Dominion', 'Crimson Directorate', 'Verdant League', 'Golden Compact', 'Violet Syndicate', 'Cyan Federation', 'Ember Republic', 'Rose Assembly'];
export const REBEL = { name: 'Free Companies', color: 0x8b8b8b };

export const GOVERNOR_SPECS = {
  balanced: { name: 'Balanced', desc: 'Grow steadily: food, housing, materials, then services.' },
  industrial: { name: 'Industrial Center', desc: 'Mines, mills, power and munitions.' },
  agrarian: { name: 'Breadbasket', desc: 'Farms and housing; feeds the empire.' },
  commercial: { name: 'Trade Hub', desc: 'Markets, ports and road links.' },
  research: { name: 'Research Campus', desc: 'Academies, universities and seismic stations.' },
  fortress: { name: 'Fortress City', desc: 'Bunkers, fortresses and a standing garrison.' },
};

export const GAME_DEFS = { W, H, TERRAIN, MOVE, ROAD_TYPES, RESOURCE, GOODS, GOOD_NAMES, AGES, TECHS, GOVS, POLICIES, FOCI, TAX, BUILDINGS, UNITS, CIV_COLORS, CIV_NAMES, REBEL, GOVERNOR_SPECS };
