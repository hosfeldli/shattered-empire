// Shattered Empires — game data definitions (shared with clients via the `welcome` message).
export const W = 128;
export const H = 128;
export const N = W * H;

export const TICK_HZ = 10;
export const DT = 1 / TICK_HZ;

// ---- Terrain -------------------------------------------------------------
export const T = {
  DEEP: 0, SHALLOW: 1, GRASS: 2, PLAINS: 3, FOREST: 4, DESERT: 5, TUNDRA: 6,
  MARSH: 7, HILLS: 8, MOUNTAIN: 9, PEAK: 10, LAVA: 11, ASH: 12,
};

// move: cost multiplier (Infinity = impassable on foot). def: defense bonus. fert: farm fertility.
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
export const isLandPassable = (t) => Number.isFinite(TERRAIN[t].move);

// ---- Map resources ---------------------------------------------------------
export const RES = { NONE: 0, HORSES: 1, IRON: 2, COAL: 3, GOLD: 4, STONE: 5, FISH: 6 };
export const RESOURCE = [
  { id: 0, key: 'none', name: '' },
  { id: 1, key: 'horses', name: 'Horses', glyph: 'H' },
  { id: 2, key: 'iron', name: 'Iron Ore', glyph: 'Fe' },
  { id: 3, key: 'coal', name: 'Coal', glyph: 'C' },
  { id: 4, key: 'gold', name: 'Gold', glyph: 'Au' },
  { id: 5, key: 'stone', name: 'Stone', glyph: 'St' },
  { id: 6, key: 'fish', name: 'Fish', glyph: 'Fi' },
];

// ---- Stockpiles -----------------------------------------------------------
export const GOODS = ['food', 'wood', 'stone', 'iron', 'coal', 'gold', 'equip'];

export const AGES = [
  { id: 0, name: 'Settlement Age' },
  { id: 1, name: 'Kingdom Age', techsNeeded: 5, cost: { food: 500, stone: 350, gold: 400 }, time: 45 },
  { id: 2, name: 'Industrial Age', techsNeeded: 5, cost: { stone: 900, iron: 500, gold: 1200, equip: 150 }, time: 60 },
];

// ---- Technologies ---------------------------------------------------------
export const TECHS = {
  // Settlement
  agriculture: { name: 'Agriculture', age: 0, cost: 60, desc: '+25% farm output; Agrarian Reform policy.' },
  mining: { name: 'Mining', age: 0, cost: 60, desc: 'Mines on iron, coal and gold deposits; Mining Guilds policy.' },
  masonry: { name: 'Masonry', age: 0, cost: 70, desc: 'Watchtowers; Fortification Doctrine policy.' },
  archery: { name: 'Archery', age: 0, cost: 60, desc: 'Archers.' },
  writing: { name: 'Writing', age: 0, cost: 60, desc: 'Libraries (specialists produce research).' },
  trade: { name: 'Trade', age: 0, cost: 80, desc: 'Markets (merchants), trade routes, Free Trade policy.' },
  sailing: { name: 'Sailing', age: 0, cost: 80, desc: 'Ports: fishing, embark armies, supply by sea.' },
  surveying: { name: 'Surveying', age: 0, cost: 70, desc: 'Reveals structural stability; Road Corvee policy.' },
  horseback: { name: 'Horseback Riding', age: 0, cost: 60, desc: 'Reveals horses; Frontier Settlement policy.' },
  // Kingdom
  iron_working: { name: 'Iron Working', age: 1, cost: 560, desc: 'Swordsmen.' },
  feudalism: { name: 'Feudalism', age: 1, cost: 580, desc: 'Stables & Knights; Monarchy government.' },
  engineering: { name: 'Engineering', age: 1, cost: 620, desc: 'Siege Works, Catapults, Forts, bridges over rivers, clearing collapsed passes.' },
  banking: { name: 'Banking', age: 1, cost: 580, desc: 'Merchant Republic; +25% market gold.' },
  logistics: { name: 'Logistics', age: 1, cost: 560, desc: 'Supply Depots & Wagons; +2 supply range.' },
  navigation: { name: 'Navigation', age: 1, cost: 580, desc: 'Armies may cross deep ocean; faster at sea.' },
  seismology: { name: 'Seismology', age: 1, cost: 560, desc: 'Seismic Stations; early warning of quakes & eruptions.' },
  guilds: { name: 'Guilds', age: 1, cost: 560, desc: 'Workshops produce equipment.' },
  scholasticism: { name: 'Scholasticism', age: 1, cost: 580, desc: 'Universities.' },
  military_tradition: { name: 'Military Tradition', age: 1, cost: 580, desc: 'Military Junta government; Total Mobilization policy.' },
  // Industrial
  steam_power: { name: 'Steam Power', age: 2, cost: 1580, desc: 'Factories; Industrial Planning policy.' },
  railroads: { name: 'Railroads', age: 2, cost: 1660, desc: 'Upgrade roads to rail (very fast movement & supply).' },
  rifling: { name: 'Rifling', age: 2, cost: 1580, desc: 'Riflemen.' },
  artillery: { name: 'Artillery', age: 2, cost: 1740, desc: 'Artillery.' },
  geoengineering: { name: 'Geoengineering', age: 2, cost: 1660, desc: 'Levees & stabilizers; Conservation policy; quakes do half damage.' },
  democracy: { name: 'Democracy', age: 2, cost: 1580, desc: 'Industrial Democracy government.' },
  industrial_agriculture: { name: 'Industrial Agriculture', age: 2, cost: 1580, desc: '+50% farm output, +housing.' },
  telegraph: { name: 'Telegraph', age: 2, cost: 1580, desc: '+1 supply range, +1 vision for buildings.' },
  explosives: { name: 'Explosives', age: 2, cost: 1660, desc: 'Clear peaks cheaply; Grand Exposition wonder.' },
};

// ---- Governments & policies ----------------------------------------------
export const GOVS = {
  chiefdom: { name: 'Chiefdom', slots: 2, desc: 'Traditional rule. No modifiers.' },
  monarchy: { name: 'Monarchy', tech: 'feudalism', slots: 3, desc: '+10 stability, +15% unit HP, knights 20% cheaper.' },
  republic: { name: 'Merchant Republic', tech: 'banking', slots: 3, desc: '+25% gold, +1 trade route value, -10% unit attack.' },
  junta: { name: 'Military Junta', tech: 'military_tradition', slots: 3, desc: 'Units 20% cheaper, +10% attack, -8 stability, -15% research.' },
  democracy: { name: 'Industrial Democracy', tech: 'democracy', slots: 4, desc: '+20% research, +10% all production, war weariness doubled.' },
};

export const POLICIES = {
  agrarian: { name: 'Agrarian Reform', tech: 'agriculture', desc: '+20% food, -10% wood & stone.' },
  conscription: { name: 'Conscription', desc: 'Units cost 30% less food & gold. -6 stability.' },
  free_trade: { name: 'Free Trade', tech: 'trade', desc: '+30% market gold, trade agreements +50%. -10% equipment.' },
  mining_guilds: { name: 'Mining Guilds', tech: 'mining', desc: '+30% stone, iron, coal & gold.' },
  scholarship: { name: 'Scholarly Patronage', tech: 'writing', desc: '+30% research, -10% gold.' },
  martial_law: { name: 'Martial Law', desc: '+15 stability, -25% growth, -15% gold.' },
  road_corvee: { name: 'Road Corvee', tech: 'surveying', desc: 'Roads half price and twice as fast. -4 stability.' },
  fortification: { name: 'Fortification Doctrine', tech: 'masonry', desc: 'Defensive buildings +50% HP & attack.' },
  frontier: { name: 'Frontier Settlement', tech: 'horseback', desc: 'Settlers 40% cheaper; new cities grow +50%.' },
  total_mobilization: { name: 'Total Mobilization', tech: 'military_tradition', desc: '+20% attack, +30% equipment, -10 stability, -20% food.' },
  industrial_planning: { name: 'Industrial Planning', tech: 'steam_power', desc: '+30% factory output, -5 stability.' },
  conservation: { name: 'Conservation', tech: 'geoengineering', desc: 'Terrain events do 50% less damage; +5 stability.' },
};

export const FOCI = {
  balanced: 'Balanced', food: 'Food first', industry: 'Industry', commerce: 'Commerce', science: 'Science', military: 'War economy',
};

export const TAX = [
  { name: 'None', gold: 0, stab: 6 },
  { name: 'Low', gold: 0.03, stab: 0 },
  { name: 'Normal', gold: 0.06, stab: -6 },
  { name: 'High', gold: 0.1, stab: -16 },
];

// ---- Buildings -------------------------------------------------------------
// jobs: [kind, slots]; produce/consume per staffed slot per second.
// place: 'flat' | 'farm' | 'forest' | 'quarry' | 'mine' | 'coast' | 'any' | 'city'
export const BUILDINGS = {
  town: { name: 'Town Center', glyph: '\u{1F3F0}', age: 0, cost: {}, time: 0, hp: 900, place: 'city',
    jobs: ['worker', 2], produce: { food: 0.3, wood: 0.35, gold: 0.15 }, housing: 8, vision: 5,
    attack: 8, range: 3, trains: ['settler', 'scout', 'supply_wagon'] },
  house: { name: 'Houses', glyph: '\u{1F3E0}', age: 0, cost: { wood: 30 }, time: 10, hp: 150, place: 'flat', housing: 4 },
  farm: { name: 'Farm', glyph: '\u{1F33E}', age: 0, cost: { wood: 25 }, time: 10, hp: 120, place: 'farm',
    jobs: ['worker', 3], produce: { food: 0.45 } },
  lumber: { name: 'Lumber Camp', glyph: '\u{1FAB5}', age: 0, cost: { wood: 20 }, time: 10, hp: 120, place: 'forest',
    jobs: ['worker', 3], produce: { wood: 0.38 } },
  quarry: { name: 'Quarry', glyph: '\u{1FAA8}', age: 0, cost: { wood: 40 }, time: 14, hp: 160, place: 'quarry',
    jobs: ['worker', 3], produce: { stone: 0.35 } },
  mine: { name: 'Mine', glyph: '⛏', age: 0, tech: 'mining', cost: { wood: 50, stone: 20 }, time: 18, hp: 180, place: 'mine',
    jobs: ['worker', 3], produce: { ore: 0.3 } },
  barracks: { name: 'Barracks', glyph: '⚔', age: 0, cost: { wood: 80, stone: 20 }, time: 20, hp: 300, place: 'flat',
    trains: ['spearman', 'archer', 'swordsman', 'rifleman'] },
  market: { name: 'Market', glyph: '\u{1F4B0}', age: 0, tech: 'trade', cost: { wood: 60, stone: 30 }, time: 18, hp: 200, place: 'flat',
    jobs: ['merchant', 3], produce: { gold: 0.45 } },
  library: { name: 'Library', glyph: '\u{1F4DC}', age: 0, tech: 'writing', cost: { wood: 60, stone: 40 }, time: 20, hp: 200, place: 'flat',
    jobs: ['specialist', 3], produce: { research: 0.25 } },
  port: { name: 'Port', glyph: '⚓', age: 0, tech: 'sailing', cost: { wood: 80 }, time: 20, hp: 250, place: 'coast',
    jobs: ['worker', 2], produce: { food: 0.45, gold: 0.15 }, vision: 4, supply: 4 },
  tower: { name: 'Watchtower', glyph: '\u{1F5FC}', age: 0, tech: 'masonry', cost: { stone: 60, wood: 20 }, time: 18, hp: 400, place: 'any',
    vision: 5, attack: 7, range: 3, anywhere: true },
  stable: { name: 'Stable', glyph: '\u{1F40E}', age: 1, tech: 'feudalism', cost: { wood: 100, stone: 40 }, time: 24, hp: 300, place: 'flat', trains: ['knight'] },
  workshop: { name: 'Workshop', glyph: '\u{1F528}', age: 1, tech: 'guilds', cost: { wood: 80, stone: 60 }, time: 24, hp: 260, place: 'flat',
    jobs: ['worker', 3], produce: { equip: 0.3 }, consume: { wood: 0.15, iron: 0.15 } },
  siege: { name: 'Siege Works', glyph: '\u{1F3AF}', age: 1, tech: 'engineering', cost: { wood: 120, stone: 60 }, time: 26, hp: 300, place: 'flat', trains: ['catapult'] },
  fort: { name: 'Fort', glyph: '\u{1F6E1}', age: 1, tech: 'engineering', cost: { stone: 160, wood: 40 }, time: 30, hp: 1100, place: 'any',
    vision: 4, attack: 12, range: 3, anywhere: true, blocksSupply: 2, heals: true },
  depot: { name: 'Supply Depot', glyph: '\u{1F4E6}', age: 1, tech: 'logistics', cost: { wood: 80, stone: 40 }, time: 20, hp: 300, place: 'any',
    supply: 5, vision: 3, anywhere: true, trains: ['supply_wagon'] },
  seismic: { name: 'Seismic Station', glyph: '\u{1F4E1}', age: 1, tech: 'seismology', cost: { stone: 80, gold: 60 }, time: 24, hp: 200, place: 'flat',
    jobs: ['specialist', 1], produce: { research: 0.2 }, stabilize: 0.15 },
  university: { name: 'University', glyph: '\u{1F393}', age: 1, tech: 'scholasticism', cost: { stone: 140, gold: 100 }, time: 32, hp: 300, place: 'flat',
    jobs: ['specialist', 3], produce: { research: 0.4 } },
  factory: { name: 'Factory', glyph: '\u{1F3ED}', age: 2, tech: 'steam_power', cost: { stone: 200, iron: 120 }, time: 34, hp: 500, place: 'flat',
    jobs: ['worker', 4], produce: { equip: 0.8 }, consume: { coal: 0.3, iron: 0.2 }, trains: ['artillery'] },
  levee: { name: 'Levee & Stabilizer', glyph: '\u{1F9F1}', age: 2, tech: 'geoengineering', cost: { stone: 150, iron: 40 }, time: 24, hp: 400, place: 'any',
    stabilize: 0.35, anywhere: true },
  wonder: { name: 'Grand Exposition', glyph: '\u{1F3DB}', age: 2, tech: 'explosives', cost: { stone: 2000, iron: 800, gold: 2500, equip: 500 }, time: 180, hp: 2500, place: 'flat', wonder: true },
};

// ---- Units ----------------------------------------------------------------
// speed in tiles/second over cost-1 terrain.
export const UNITS = {
  settler: { name: 'Settler', glyph: 'Se', age: 0, cost: { food: 80, wood: 40, gold: 20 }, pop: 3, time: 12, hp: 40, atk: 0, def: 1, range: 0, speed: 0.55, vision: 2, civilian: true },
  scout: { name: 'Scout', glyph: 'Sc', age: 0, cost: { food: 25, gold: 10 }, pop: 1, time: 8, hp: 50, atk: 3, def: 2, range: 1, speed: 1.6, vision: 5 },
  spearman: { name: 'Spearman', glyph: 'Sp', age: 0, cost: { food: 35, wood: 20 }, pop: 1, time: 10, hp: 100, atk: 8, def: 6, range: 1, speed: 0.65, vision: 2, bonus: { cavalry: 2 }, cls: 'infantry' },
  archer: { name: 'Archer', glyph: 'Ar', age: 0, tech: 'archery', cost: { food: 30, wood: 40 }, pop: 1, time: 11, hp: 70, atk: 7, def: 3, range: 3, speed: 0.65, vision: 3, cls: 'ranged' },
  swordsman: { name: 'Swordsman', glyph: 'Sw', age: 1, tech: 'iron_working', cost: { food: 45, iron: 25, equip: 10 }, pop: 1, time: 13, hp: 135, atk: 13, def: 9, range: 1, speed: 0.65, vision: 2, cls: 'infantry' },
  knight: { name: 'Knight', glyph: 'Kn', age: 1, tech: 'feudalism', needs: 'horses', cost: { food: 60, iron: 20, gold: 35, equip: 15 }, pop: 1, time: 15, hp: 150, atk: 16, def: 8, range: 1, speed: 1.35, vision: 3, bonus: { ranged: 1.6, siege: 2 }, cls: 'cavalry' },
  catapult: { name: 'Catapult', glyph: 'Ca', age: 1, tech: 'engineering', cost: { wood: 90, stone: 40, equip: 15 }, pop: 2, time: 18, hp: 80, atk: 20, def: 2, range: 4, speed: 0.4, vision: 2, vsBuildings: 3, cls: 'siege' },
  supply_wagon: { name: 'Supply Wagon', glyph: 'Wg', age: 1, tech: 'logistics', cost: { food: 60, wood: 50, equip: 5 }, pop: 1, time: 12, hp: 60, atk: 0, def: 2, range: 0, speed: 0.8, vision: 2, civilian: true, supplyRadius: 3 },
  rifleman: { name: 'Rifleman', glyph: 'Ri', age: 2, tech: 'rifling', cost: { food: 50, iron: 20, coal: 10, equip: 20 }, pop: 1, time: 14, hp: 145, atk: 21, def: 12, range: 3, speed: 0.75, vision: 3, cls: 'ranged' },
  artillery: { name: 'Artillery', glyph: 'At', age: 2, tech: 'artillery', cost: { iron: 60, coal: 40, equip: 40 }, pop: 2, time: 20, hp: 100, atk: 38, def: 4, range: 6, speed: 0.45, vision: 3, vsBuildings: 2.5, cls: 'siege' },
};

export const CIV_COLORS = [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308];
export const CIV_NAMES = ['Azure Dominion', 'Crimson Throne', 'Verdant League', 'Golden Compact'];

export const GAME_DEFS = { W, H, TERRAIN, RESOURCE, GOODS, AGES, TECHS, GOVS, POLICIES, FOCI, TAX, BUILDINGS, UNITS, CIV_COLORS, CIV_NAMES };
