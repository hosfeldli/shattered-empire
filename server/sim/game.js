// Authoritative match simulation. One Game per match; clients only send intents.
import { Scheduler } from './scheduler.js';
import { IMPORT_PRICE, IMPORT_PER_MARKET, REFIT, N, W, H, T, DT, TERRAIN, BUILDINGS, UNITS, TECHS, GOVS, POLICIES, FOCI, AGES, CIV_COLORS, CIV_NAMES, REBEL, GAME_DEFS, GOVERNOR_SPECS, ROAD_TYPES, RES, isWater } from './constants.js';
import { NB, disk, dist, centroid, dqWrap, stamp, idx as hexIdx } from './hex.js';
import { recruitBlock, reserve, commitTraining, releaseTraining, enlistExisting, demobilize, labor, recruitable } from './population.js';
import { World } from './world.js';
import { mulberry32 } from './rng.js';
import { Geology, describeTile } from './geology.js';
import { tileRecord } from './render.js';
import { findPath, findRoadRoute, flowField, formationSlots } from './path.js';
import { RoadNet } from './roads.js';
import { economyStep, recomputeTerritory, recomputeTradeNetwork, migrationStep, allocationFor } from './economy.js';
import { MODES, PRIORITY, CATEGORIES, defaultWorkforce } from './workforce.js';
import { unitsStep, buildingCombatStep, recomputeSupply, supplyStep, spawnUnit, damageUnit, damageBuilding, hardened } from './military.js';
import { Diplomacy } from './diplomacy.js';
import { AI } from './ai.js';
import { RebelAI } from './rebels.js';
import { defaultGovernor, governorStep, autoColonists, migrateGovernor, answerProposal, LEVELS } from './governor.js';
import { GOALS, readiness } from './planner.js';
import { armyCommand, armiesStep, armySummary } from './armies.js';
import { recoveryStep } from './recovery.js';
import { projectilesStep, moraleStep, eventsFor, CS, vetLevel } from './combat.js';
import { bfInit, battlefieldStep, battlefieldSnapshot, concealBySmoke } from './battlefield.js';
import { battlesStep, battlesFor, assignTargets } from './battles.js';
import { runScenario, spawnGroup, clearForces, SCENARIOS } from './sandbox.js';

const LEVEL_OF = { tech: 'info', build: 'info', unit: 'info', history: 'info', rumor: 'minor', city: 'minor', diplo: 'minor', peace: 'minor', age: 'minor', gov: 'minor',
  quake: 'major', eruption: 'major', rift: 'minor', uplift: 'minor', drought: 'major', river: 'minor', warning: 'major', rebel: 'major', loss: 'major', isolated: 'major', blocked: 'major', proposal: 'major', war: 'major', error: 'minor',
  famine: 'critical', fall: 'critical', wonder: 'critical' };

const CITY_NAMES = ['Aldmoor', 'Brightwater', 'Cindervale', 'Dunhollow', 'Emberfell', 'Frosthaven', 'Greywatch', 'Highcrag', 'Ironford', 'Juniper', 'Kingsreach', 'Lowmarsh', 'Mistport', 'Northgate', 'Oakheart', 'Pinecrest', 'Quarrytown', 'Redcliff', 'Stonebridge', 'Thornfield', 'Umberdale', 'Valewind', 'Westmarch', 'Yarrow', 'Zephyr Rock', 'Ashmere', 'Blackreed', 'Coldspring', 'Deepwell', 'Eastbrook', 'Foundry Hill', 'Gantry', 'Harrowgate', 'Isolde', 'Jetty'];

const ESSENTIAL = new Set(['farm', 'house', 'port']);

// Every system with its cadence (ticks), phase (spreads the once-a-second systems over the
// second instead of piling them onto one tick) and time budget in ms. Order inside a tick is fixed.
function makeScheduler(g) {
  const T = [
    { name: 'tileUnits', fn: () => g.rebuildTileUnits(), budget: 3 },
    { name: 'units', fn: () => unitsStep(g, DT), budget: 15 },
    { name: 'projectiles', fn: () => projectilesStep(g), budget: 3 },
    { name: 'morale', every: 5, fn: () => moraleStep(g, 0.5), budget: 3 },
    { name: 'battlefield', every: 10, phase: 5, fn: () => { battlefieldStep(g, 1); battlesStep(g); }, budget: 4 },
    { name: 'buildingCombat', every: 5, fn: () => buildingCombatStep(g, 0.5), budget: 3 },
    { name: 'construction', every: 10, fn: () => { g.constructionStep(1); g.roads.step(g, 1); }, budget: 5 },
    { name: 'economy', every: 10, phase: 8, fn: () => { economyStep(g, 1); supplyStep(g, 1); g.researchStep(1); }, budget: 20 },
    { name: 'geology', every: 10, phase: 6, fn: () => { g.geology.step(1, g.time); for (const tile of g.world.wiped) g.roads.obliterate(tile); g.world.wiped.clear(); }, budget: 5 },
    { name: 'diplomacy', every: 10, phase: 4, fn: () => g.diplomacy.step(1), budget: 2 },
    { name: 'governors', every: 10, phase: 2, fn: () => governorStep(g, 1), budget: 10 },
    { name: 'victory', every: 10, fn: () => g.checkVictory(), budget: 2 },
    { name: 'supplyNet', every: 20, phase: 13, fn: () => { recomputeSupply(g); autoColonists(g); armiesStep(g); if (g.world.dirty.size) { g.navVersion++; g.world.dirty.clear(); } }, budget: 15 },
    { name: 'territory', every: 30, phase: 21, fn: () => recomputeTerritory(g), budget: 10 },
    { name: 'trade', every: 50, phase: 47, fn: () => { recomputeTradeNetwork(g); g.roads.decayTraffic(); }, budget: 15 },
    { name: 'migration', every: 100, phase: 89, fn: () => migrationStep(g), budget: 5 },
    { name: 'recovery', every: 300, phase: 283, fn: () => recoveryStep(g), budget: 10 },
    // AI planning: each empire thinks every 2 s, staggered; deferrable when a tick runs long
    { name: 'aiQueue', budget: 1, fn: (gg, t) => { const due = gg.aiDue || (gg.aiDue = new Set()); for (const civ of gg.civs) if (civ.ai && civ.alive && (t + civ.id * 7) % (civ.isRebel ? 30 : 20) === 0) due.add(civ.id); } },
    { name: 'ai', deferrable: true, budget: 20, fn: (gg) => {
      const due = gg.aiDue; if (!due || !due.size) return;
      for (const id of [...due].sort((a, b) => a - b)) { const civ = gg.civs[id]; if (civ.ai && civ.alive) civ.ai.think(); }
      due.clear();
    } },
    { name: 'visibility', every: 2, fn: () => g.refreshVisibility(), budget: 8 },
  ];
  return new Scheduler(T, { tickBudget: 1000 / 10, adaptive: !!g.adaptive });
}

export class Game {
  constructor({ id, seed = (Math.random() * 2 ** 31) | 0, slots, rebels = true, restore = null, cataclysm = null, style = null }) {
    this.id = id;
    this.seed = seed;
    // the world is peaceful unless the match asks for destructive geology (Cataclysm mode)
    this.cataclysm = cataclysm && cataclysm.on ? { on: true, freq: Math.max(0.25, Math.min(3, +cataclysm.freq || 1)), sev: Math.max(0.25, Math.min(2, +cataclysm.sev || 1)) } : null;
    this.worldStyle = style || null;
    this.slotsDef = slots.map((s) => ({ human: !!s.human, name: s.name, leader: s.leader, personality: s.personality, difficulty: s.difficulty }));
    this.defs = GAME_DEFS;
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.world = new World(seed, { style });
    this.world.generate(slots.length);
    this.roads = new RoadNet(this.world);
    this.time = 0; this.tickN = 0; this.nextId = 1;
    this.units = new Map(); this.buildings = new Map(); this.cities = new Map();
    this.ruins = new Map();                 // tile -> { type, owner, name, time }
    this.tileB = new Int32Array(N).fill(-1);
    this.tileUnits = new Map(); this.tileLoad = new Map();
    this.navVersion = 1; this.navDirty = false;
    // combat: sequenced event stream, projectiles in flight, damage already on its way, battles
    this.events = []; this.eventSeq = 0; this.projectiles = new Map(); this.pending = new Map(); this.assigned = new Map(); this.battles = []; this.nextBattle = 1;
    bfInit(this);
    this.over = false; this.winner = null; this.log = []; this.outbox = [];
    this.cityNameIdx = 0;
    this.civs = slots.map((s, i) => this.makeCiv(i, s));
    if (rebels) { const r = this.makeCiv(this.civs.length, { human: false, name: REBEL.name }); r.isRebel = true; r.color = REBEL.color; r.personality = 'rebel'; this.civs.push(r); }
    this.diplomacy = new Diplomacy(this);
    this.geology = new Geology(this);
    if (restore) return;                      // persistence fills in the rest
    for (const civ of this.civs) if (!civ.isRebel) this.setupStart(civ, this.world.starts[civ.id]);
    recomputeTerritory(this);
    for (const civ of this.civs) {
      if (civ.isRebel) civ.ai = RebelAI.seed(this, civ, 2 + Math.min(3, slots.length));
      else if (civ.isAI) civ.ai = new AI(this, civ);
    }
    this.refreshVisibility();
    recomputeSupply(this);
  }

  makeCiv(id, slot) {
    return {
      id, name: slot.name || CIV_NAMES[id % CIV_NAMES.length], leader: slot.leader || (slot.human ? 'Player' : 'AI'), color: CIV_COLORS[id % CIV_COLORS.length],
      human: !!slot.human, isAI: !slot.human, isRebel: false, personality: slot.personality || ['merchant', 'warlord', 'builder'][id % 3], difficulty: slot.difficulty || 'normal',
      alive: true, connected: false, token: null,
      res: { food: 220, materials: 260, ore: 0, steel: 20, fuel: 0, electronics: 0, munitions: 20, credits: 150 },
      rates: {}, researchRate: 0, researching: null, progress: 0, queue: [], techs: new Set(),
      age: 0, advancing: 0, gov: 'council', govCooldown: 0, policies: new Set(), tax: 1, focus: 'balanced',
      weariness: 0, casualties: 0, kills: 0, popTotal: 0, powerGen: 0, powerUse: 0, powerRatio: 1,
      knownVer: new Uint16Array(N), knownOwner: new Int8Array(N).fill(-2), visible: new Uint8Array(N), detect: new Uint8Array(N), supply: new Uint8Array(N), airSupply: new Uint8Array(N),
      explored: new Uint8Array(N), lastOwner: new Int8Array(N).fill(-2), knownCities: new Map(), intel: {},
      visKey: '', proposals: [], wonder: null, armies: new Map(), cmdlog: [],
    };
  }

  setupStart(civ, tile) {
    const city = this.foundCity(civ, tile, 7, true);
    city.stability = 70;
    recomputeTerritory(this);
    const free = this.freeTilesNear(tile, 2);
    // the founding expedition: its people are on the capital's books as serving manpower
    for (const [i, type] of ['scout_buggy', 'militia', 'militia', 'engineer'].entries()) enlistExisting(this, civ, spawnUnit(this, civ, type, free[i] ?? tile));
    const near = disk(tile, 3);
    const farmT = near.find((t) => this.canPlace(civ, 'farm', t, true));
    if (farmT !== undefined) this.placeBuilding(civ, 'farm', farmT, true);
    const lumT = near.find((t) => this.canPlace(civ, 'lumber', t, true));
    if (lumT !== undefined) this.placeBuilding(civ, 'lumber', lumT, true);
  }

  // ----------------------------------------------------------------- helpers
  id_() { return this.nextId++; }
  rebelCiv() { return this.civs.find((c) => c.isRebel) || null; }
  buildingAtTile(t) { const id = this.tileB[t]; return id >= 0 ? this.buildings.get(id) : null; }
  buildingsAt(t) { const b = this.buildingAtTile(t); return b ? [b] : []; }
  unitsAt(t) { return (this.tileUnits.get(t) || []).map((id) => this.units.get(id)).filter(Boolean); }
  hostile(a, b) { return a !== b && this.diplomacy.rel(a, b).state === 'war'; }
  hostileAt(civId, t) { return (this.tileUnits.get(t) || []).some((id) => { const u = this.units.get(id); return u && this.hostile(civId, u.owner); }); }
  canEnter(a, b) { if (a === b) return true; const r = this.diplomacy.rel(a, b); return r.state === 'war' || r.state === 'alliance' || r.borders || this.civs[b].isRebel; }
  allied(a, b) { return a === b || this.diplomacy.rel(a, b).state === 'alliance'; }
  // stealth units are only seen at close range
  detects(civId, u) { if (u.owner === civId || !UNITS[u.type].stealth) return true; return this.civs[civId].detect[u.tile] === 1; }
  freeTilesNear(t, rad) {
    return disk(t, rad).filter((x) => x !== t && Number.isFinite(TERRAIN[this.world.terr[x]].move) && !isWater(this.world.terr[x]))
      .sort((a, b) => dist(t, a) - dist(t, b));
  }
  civMitigation(civId) {
    const c = this.civs[civId]; if (!c) return 1;
    let m = 1;
    if (c.techs.has('geoengineering')) m *= 0.5;
    if (c.policies.has('conservation')) m *= 0.5;
    return m;
  }
  cityOf(civ) { return [...this.cities.values()].filter((c) => c.owner === civ.id); }
  capital(civ) { return this.cityOf(civ).sort((a, b) => (b.capital ? 1 : 0) - (a.capital ? 1 : 0) || a.id - b.id)[0]; }
  civHasResource(civ, r) { const w = this.world; for (let i = 0; i < N; i++) if (w.owner[i] === civ.id && w.res[i] === r) return true; return false; }
  damageUnit(u, amount, attacker, cause) { damageUnit(this, u, amount, attacker, cause); }
  damageBuilding(b, amount, attacker, cause) { damageBuilding(this, b, amount, attacker, cause); }
  maxHouses(civ) { return 3 + 2 * Math.min(3, civ.age); }

  // Alerts carry a level so players can tell routine news from emergencies.
  notify(civId, text, extra = {}) {
    const msg = { t: 'note', time: Math.round(this.time), text, ...extra };
    if (!msg.level) msg.level = LEVEL_OF[msg.kind] || (msg.quiet ? 'info' : 'minor');
    this.outbox.push([civId < 0 ? -1 : civId, msg]);
  }
  // Command history: what was ordered, by whom (you, a governor, an army controller), and why.
  history(civ, by, text) {
    if (!civ || civ.isAI) return;
    civ.cmdlog.unshift({ t: Math.round(this.time), by, text });
    if (civ.cmdlog.length > 120) civ.cmdlog.length = 120;
  }
  geoEvent(kind, tile, radius, text, extra = {}) {
    this.log.push({ time: this.time, kind, tile, text });
    for (const civ of this.civs) {
      if (civ.isRebel) continue;
      const seen = disk(tile, Math.max(1, radius)).some((t) => civ.visible[t]);
      if (seen || kind === 'rift') this.notify(civ.id, text + ' ' + describeTile(tile), { kind, tile, radius, ...extra });
      else if (kind === 'quake' || kind === 'eruption') this.notify(civ.id, kind === 'quake' ? 'Distant tremors are felt across the land.' : 'A distant volcano darkens the horizon.', { kind: 'rumor' });
    }
  }
  geoWarning(kind, tile, text) {
    for (const civ of this.civs) {
      if (civ.isRebel || !civ.techs.has('seismology')) continue;
      if (this.cityOf(civ).some((c) => dist(c.tile, tile) < 18)) this.notify(civ.id, '[Seismology] ' + text + ' ' + describeTile(tile), { kind: 'warning', tile, radius: 6 });
    }
  }
  onTileFlooded(t) {
    const b = this.buildingAtTile(t);
    if (b && b.type !== 'port') damageBuilding(this, b, 1e9, null, 'flood');
    for (const u of this.unitsAt(t)) { const civ = this.civs[u.owner]; if (!UNITS[u.type].air && !civ.techs.has('seafaring')) damageUnit(this, u, 1e9, null, 'flood'); }
    this.roads.obliterate(t);
    this.ruins.delete(t);
  }
  cityDisaster(c, amount) {
    c.disaster = Math.min(45, (c.disaster || 0) + amount);
    const refugees = c.pop * Math.min(0.2, amount / 150);
    if (refugees > 0.5) {
      c.pop -= refugees;
      const others = this.cityOf(this.civs[c.owner]).filter((o) => o !== c && dist(o.tile, c.tile) > 6);
      if (others.length) others[0].pop += refugees * 0.7;
      this.notify(c.owner, `${Math.round(refugees)} refugees flee ${c.name}.`, { kind: 'city', tile: c.tile });
    }
  }
  addRuin(tile, type, owner, name) { if (isWater(this.world.terr[tile])) return; this.ruins.set(tile, { type, owner, name, time: this.time }); this.world.touch(tile); }

  // ----------------------------------------------------------------- cities & buildings
  foundCity(civ, tile, pop = 3, capital = false) {
    const id = this.id_();
    const name = CITY_NAMES[this.cityNameIdx++ % CITY_NAMES.length] + (this.cityNameIdx > CITY_NAMES.length ? ' II' : '');
    const city = { id, owner: civ.id, tile, name, pop, housing: 8, stability: 60, disaster: 0, occupied: 0, unrestT: 0, founded: this.time, capital, foodShort: false, jobs: {}, unemployed: 0, radius: 3,
      isolated: !capital, freight: capital ? Infinity : 0, stock: {}, tradeConnected: false,
      governor: defaultGovernor(civ.isAI) };
    this.cities.set(id, city);
    this.ruins.delete(tile);
    const b = this.makeBuilding(civ, 'town', tile, true);
    b.cityId = id; city.buildingId = b.id;
    return city;
  }

  makeBuilding(civ, type, tile, done) {
    const def = BUILDINGS[type];
    const b = { id: this.id_(), owner: civ.id, type, tile, hp: done ? def.hp : def.hp * 0.1, maxHp: def.hp, done: !!done, progress: done ? 1 : 0, queue: [], staffed: 0, cityId: -1, cooldown: 0, rally: -1, active: false, placedAt: this.time,
      state: done ? 'operational' : 'construction', funded: true, fire: 0, crew: 0 };
    this.buildings.set(b.id, b);
    this.tileB[tile] = b.id;
    this.ruins.delete(tile);
    if (type !== 'town') b.cityId = this.nearestCityId(civ.id, tile);
    this.world.touch(tile);
    return b;
  }
  nearestCityTile(civId, tile) { let best = -1, bd = Infinity; for (const c of this.cities.values()) if (c.owner === civId) { const d = dist(c.tile, tile); if (d < bd) { bd = d; best = c.tile; } } return best; }
  nearestCityId(civId, tile) {
    let best = -1, bd = Infinity;
    for (const c of this.cities.values()) if (c.owner === civId) { const d = dist(c.tile, tile); if (d < bd) { bd = d; best = c.id; } }
    return best;
  }
  removeBuilding(b) { this.buildings.delete(b.id); if (this.tileB[b.tile] === b.id) this.tileB[b.tile] = -1; this.world.touch(b.tile); }

  canPlace(civ, type, t, ignoreCost = false) {
    const def = BUILDINGS[type]; if (!def || type === 'town' || def.rebelOnly) return false;
    const w = this.world, ter = w.terr[t];
    if (def.age > civ.age) return false;
    if (def.tech && !civ.techs.has(def.tech)) return false;
    if (this.tileB[t] >= 0) return false;
    const ruin = this.ruins.get(t);
    if (ruin && ruin.type !== type) return false;            // clear the rubble first (engineers / governor)
    if (isWater(ter) || !Number.isFinite(TERRAIN[ter].move) || ter === T.LAVA) return false;
    if (def.anywhere) { if (w.owner[t] !== civ.id && !civ.supply[t]) return false; if (w.owner[t] >= 0 && w.owner[t] !== civ.id) return false; }
    else if (w.owner[t] !== civ.id) return false;
    if (def.wonder && [...this.buildings.values()].some((b) => b.type === 'wonder' && b.owner === civ.id)) return false;
    if (type === 'house') {
      const cid = this.nearestCityId(civ.id, t);
      let n = 0; for (const b of this.buildings.values()) if (b.type === 'house' && b.cityId === cid) n++;
      if (n >= this.maxHouses(civ)) return false;
    }
    switch (def.place) {
      case 'farm': if (![T.GRASS, T.PLAINS, T.ASH, T.MARSH, T.TUNDRA, T.HILLS, T.FOREST].includes(ter) && !(ter === T.DESERT && w.river[t])) return false; break;   // hills are terraced, forest cleared (lower yield)
      case 'forest': if (ter !== T.FOREST) return false; break;
      case 'quarry': if (!(ter === T.HILLS || ter === T.MOUNTAIN || w.res[t] === RES.STONE)) return false; break;
      case 'mine': if (![RES.IRON, RES.COAL].includes(w.res[t])) return false; break;
      case 'oil': if (w.res[t] !== RES.OIL) return false; break;
      case 'ruins': if (w.res[t] !== RES.RUINS) return false; break;
      case 'coast': { let c = false; for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && isWater(w.terr[n]) && !w.lake[n]) c = true; } if (!c) return false; break; }
      case 'flat': if (ter === T.MOUNTAIN || ter === T.MARSH) return false; break;
      default: break;
    }
    if (!ignoreCost && !this.canAfford(civ, this.buildingCost(civ, type, t), t)) return false;
    return true;
  }

  buildingCost(civ, type, tile) {
    const c = { ...BUILDINGS[type].cost };
    let m = 1;
    if ((type === 'bunker' || type === 'fort') && civ.policies.has('fortification')) m *= 0.75;
    if (tile != null && this.ruins.get(tile)?.type === type) m *= 0.5;   // rebuilding from ruins
    if (m !== 1) for (const k in c) c[k] = Math.round(c[k] * m);
    return c;
  }
  upgradeCost(civ, b) { const lv = b.level || 1; return civ.age >= 1 ? { materials: 40 * lv, steel: 10 * lv } : { materials: 45 * lv }; }
  // a refit pays the difference in equipment; a conversion pays most of a new unit
  refitCost(civ, from, to, conv) {
    const a = this.unitCost(civ, to), b = this.unitCost(civ, from), out = {};
    for (const [k, v] of Object.entries(a)) { const c = conv ? v * 0.75 : Math.max(v * 0.25, v - (b[k] || 0) * 0.6); if (c > 0) out[k] = Math.ceil(c); }
    return out;
  }
  unitCost(civ, type) {
    const c = { ...UNITS[type].cost };
    if (civ.policies.has('conscription')) { if (c.food) c.food = Math.round(c.food * 0.7); if (c.credits) c.credits = Math.round(c.credits * 0.7); }
    if (civ.gov === 'junta' && !UNITS[type].civilian) for (const k in c) c[k] = Math.round(c[k] * 0.8);
    if (type === 'colonist' && civ.policies.has('homesteading')) for (const k in c) c[k] = Math.round(c[k] * 0.6);
    return c;
  }
  // Spending draws on the stockpile that can actually reach the place: the national pool, or the
  // local reserves of a city that is cut off from the network. Credits are always national.
  poolAt(civ, tile) {
    if (tile == null || tile < 0) return null;
    const c = this.cities.get(this.nearestCityId(civ.id, tile));
    return c && c.isolated && c.stock ? c.stock : null;
  }
  canAfford(civ, cost, tile) {
    const local = this.poolAt(civ, tile);
    for (const k in cost) { const have = local && k !== 'credits' ? local[k] || 0 : civ.res[k] || 0; if (have < cost[k]) return false; }
    return true;
  }
  pay(civ, cost, tile) {
    const local = this.poolAt(civ, tile);
    for (const k in cost) { if (local && k !== 'credits') local[k] = (local[k] || 0) - cost[k]; else civ.res[k] -= cost[k]; }
  }

  placeBuilding(civ, type, tile, instant = false, planned = false) {
    const cost = this.buildingCost(civ, type, tile);
    if (!instant && !planned) this.pay(civ, cost, tile);
    const b = this.makeBuilding(civ, type, tile, instant);
    if (planned) { b.funded = false; b.state = 'planned'; b.cost = cost; }
    return b;
  }

  // Lifecycle: planned -> construction -> operational <-> damaged -> (ruin) -> cleared/rebuilt
  refreshState(b) {
    const s = !b.done ? (b.funded ? 'construction' : 'planned') : b.hp < b.maxHp * 0.5 ? 'damaged' : 'operational';
    if (s !== b.state) { b.state = s; this.world.touch(b.tile); }
  }
  ignite(b, chance = 0.5) {
    if (b.fire > 0 || b.hp > b.maxHp * 0.6 || this.rng() > chance) return;
    b.fire = 25 + this.rng() * 25; this.world.touch(b.tile);
  }

  canTrain(civ, b, unit) {
    const def = UNITS[unit], bd = BUILDINGS[b.type];
    if (!def || !bd.trains || !bd.trains.includes(unit) || !b.done || b.owner !== civ.id) return 'not available here';
    if (def.age > civ.age) return 'requires ' + AGES[def.age].name;
    if (def.tech && !civ.techs.has(def.tech)) return 'requires ' + TECHS[def.tech].name;
    const city = this.cities.get(b.cityId);
    if (city && def.pop) { const why = recruitBlock(civ, city, def.pop); if (why) return why; }
    if (b.queue.length >= 5) return 'queue full';
    if (!this.canAfford(civ, this.unitCost(civ, unit), b.tile)) return 'cannot afford';
    return null;
  }

  // ----------------------------------------------------------------- main loop
  tick() {
    if (this.over) return;
    this.time += DT;
    this.tickN++;
    this.assigned.clear();
    (this.sched || (this.sched = makeScheduler(this))).run(this.tickN, this);
  }

  rebuildTileUnits() {
    this.tileUnits.clear(); this.tileLoad.clear();
    for (const u of this.units.values()) {
      let a = this.tileUnits.get(u.tile); if (!a) this.tileUnits.set(u.tile, a = []); a.push(u.id);
      if (!UNITS[u.type].air) {
        this.tileLoad.set(u.tile, (this.tileLoad.get(u.tile) || 0) + 1);
        if (u.next >= 0 && u.prog > 0) this.tileLoad.set(u.next, (this.tileLoad.get(u.next) || 0) + 1);
      }
    }
  }

  constructionStep(dt) {
    for (const [t, r] of this.ruins) {
      if (r.clearing && this.time >= r.clearAt) { this.ruins.delete(t); this.world.touch(t); continue; }
      if (r.smoke > 0) { r.smoke -= dt; if (r.smoke <= 0) this.world.touch(t); }
    }
    // construction crews: each city puts its idle hands (plus nearby engineers) to work on its sites
    const sites = new Map();
    for (const b of this.buildings.values()) if (!b.done && b.funded) { const a = sites.get(b.cityId) || []; a.push(b); sites.set(b.cityId, a); }
    const engineers = [...this.units.values()].filter((u) => UNITS[u.type].engineer);
    for (const [cityId, list] of sites) {
      const city = this.cities.get(cityId);
      const crews = 1 + (city ? Math.min(3, city.unemployed * 0.25) : 0);
      for (const b of list) {
        const eng = engineers.filter((u) => u.owner === b.owner && dist(u.tile, b.tile) <= 2).length;
        b.crew = Math.max(0.35, Math.min(1.6, crews / list.length + eng * 0.75));
      }
    }
    for (const b of this.buildings.values()) {
      const civ = this.civs[b.owner];
      if (b.fire > 0) {
        b.fire -= dt;
        b.hp -= b.maxHp * 0.012 * dt; b.lastHit = this.time;
        if (this.rng() < 0.01 * dt) for (const n of disk(b.tile, 1)) { const o = this.buildingAtTile(n); if (o && o !== b) this.ignite(o, 0.4); }
        if (b.hp <= 0) { damageBuilding(this, b, 1, null, 'fire'); continue; }
        if (b.fire <= 0) { b.fire = 0; this.world.touch(b.tile); }
      }
      if (b.done) {
        if (b.queue.length) {
          const q = b.queue[0]; q.left -= dt * (b.state === 'damaged' ? 0.5 : 1);
          if (q.left <= 0) {
            b.queue.shift();
            const spot = this.freeTilesNear(b.tile, 2)[0] ?? b.tile;
            const u = spawnUnit(this, civ, q.unit, spot);
            commitTraining(this, this.cities.get(b.cityId), q, u);
            if (q.unit === 'colonist' && (q.auto || civ.isAI === false && this.cities.get(b.cityId)?.governor?.enabled && this.cities.get(b.cityId)?.governor?.perms.settle)) u.auto = true;
            if (q.army && civ.armies?.has(q.army)) civ.armies.get(q.army).units.push(u.id);
            if (b.rally >= 0) this.orderMove(civ, [u.id], b.rally, false);
            this.notify(civ.id, `${UNITS[q.unit].name} ready.`, { kind: 'unit', tile: spot, quiet: true, level: 'info' });
          }
        }
        // repeat production: only when affordable twice over and manpower is spare (never starves the city)
        if (b.repeat && !b.queue.length && this.tickN % 10 === 0) {
          const cost = this.unitCost(civ, b.repeat), dbl = {}; for (const [k, v] of Object.entries(cost)) dbl[k] = v * 2;
          const city = this.cities.get(b.cityId), men = UNITS[b.repeat].pop || 0;
          if (this.canAfford(civ, dbl, b.tile) && (!men || !city || recruitable(civ, city) >= men * 2) && !this.canTrainBatch(civ, b, b.repeat)) this.trainBatch(civ, [b.id], b.repeat, 1, {});
        }
        // natural upkeep only keeps sound buildings sound; damaged ones need repair (governor, engineers, or you)
        if (b.hp < b.maxHp && b.hp >= b.maxHp * 0.5 && !b.fire && this.time - (b.lastHit || -99) > 15) b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.002 * dt * (hardened(this, b) ? 2 : 1));
        this.refreshState(b);
        continue;
      }
      if (!b.funded) {
        // planned: starts as soon as the resources exist where it is being built
        if (this.canAfford(civ, b.cost, b.tile)) { this.pay(civ, b.cost, b.tile); b.funded = true; this.refreshState(b); }
        continue;
      }
      const def = BUILDINGS[b.type];
      const rate = (b.crew || 1) * (civ.policies.has('public_works') ? 1.15 : 1);
      b.progress += (dt * rate) / def.time;
      b.hp = Math.min(b.maxHp, b.hp + (b.maxHp * 0.9 * dt * rate) / def.time);
      if (b.progress >= 1) {
        b.done = true; b.progress = 1; this.refreshState(b);
        this.notify(civ.id, `${def.name} completed.`, { kind: 'build', tile: b.tile, quiet: true, level: 'info' });
        if (b.type === 'wonder') { civ.wonder = { since: this.time, id: b.id }; this.notify(-1, `${civ.name} has completed the Continental Arcology! They win if it stands for 5 minutes.`, { kind: 'wonder', tile: b.tile, level: 'critical' }); }
      }
      this.refreshState(b);
    }
  }

  repairBuilding(civ, b, by = 'you') {
    if (!b || b.owner !== civ.id || !b.done || b.hp >= b.maxHp) return { error: 'Nothing to repair' };
    const cost = { materials: Math.ceil(10 + (BUILDINGS[b.type].cost.materials || 40) * 0.2) };
    if (!this.canAfford(civ, cost, b.tile)) return { error: `Repair needs ${cost.materials} materials` };
    this.pay(civ, cost, b.tile);
    b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.4); b.fire = 0; this.refreshState(b); this.world.touch(b.tile);
    this.history(civ, by, `Repaired ${BUILDINGS[b.type].name}`);
    return null;
  }

  researchStep(dt) {
    for (const civ of this.civs) {
      if (!civ.alive || civ.isRebel) continue;
      if (civ.advancing > 0) {
        civ.advancing -= dt;
        if (civ.advancing <= 0) { civ.advancing = 0; civ.age++; this.notify(-1, `${civ.name} has entered the ${AGES[civ.age].name} era!`, { kind: 'age' }); }
      }
      if (civ.govCooldown > 0) civ.govCooldown -= dt;
      if (!civ.researching && civ.queue.length) {
        const nxt = civ.queue.find((k) => !civ.techs.has(k) && TECHS[k].age <= civ.age && TECHS[k].req.every((r) => civ.techs.has(r)));
        if (nxt) { civ.researching = nxt; civ.progress = 0; civ.queue = civ.queue.filter((k) => k !== nxt); }
      }
      if (!civ.researching) continue;
      civ.progress += civ.researchRate * dt;
      const tech = TECHS[civ.researching];
      if (civ.progress >= tech.cost) {
        civ.techs.add(civ.researching);
        this.notify(civ.id, `Research complete: ${tech.name}.`, { kind: 'tech' });
        civ.researching = null; civ.progress = 0;
        civ.queue = civ.queue.filter((k) => !civ.techs.has(k));
      }
    }
  }

  checkVictory() {
    const alive = this.civs.filter((c) => c.alive && !c.isRebel);
    for (const civ of alive) {
      if (civ.wonder) {
        const b = this.buildings.get(civ.wonder.id);
        if (!b || b.owner !== civ.id) civ.wonder = null;
        else if (this.time - civ.wonder.since >= 300) return this.endGame(civ, 'Continental Arcology (civilizational victory)');
      }
    }
    if (alive.length === 1) return this.endGame(alive[0], 'Conquest');
    if (alive.length > 1 && alive.every((c) => alive.every((d) => this.allied(c.id, d.id)))) return this.endGame(alive[0], 'Allied victory');
    if (alive.length && alive.every((c) => !c.human) && this.civs.some((c) => c.human)) return this.endGame(alive[0], 'All human players were defeated');
  }
  endGame(civ, how) {
    if (this.over) return;
    this.over = true;
    this.winner = { civ: civ.id, name: civ.name, how };
    this.outbox.push([-1, { t: 'over', winner: this.winner, stats: this.civs.filter((c) => !c.isRebel).map((c) => this.civSummary(c)) }]);
  }
  eliminate(civ) {
    if (!civ.alive || civ.isRebel) return;
    civ.alive = false;
    for (const u of [...this.units.values()]) if (u.owner === civ.id) this.units.delete(u.id);
    for (const b of [...this.buildings.values()]) if (b.owner === civ.id) { this.removeBuilding(b); this.addRuin(b.tile, b.type, civ.id); }
    this.notify(-1, `${civ.name} has fallen.`, { kind: 'fall' });
  }
  civSummary(c) {
    const cities = this.cityOf(c);
    const pop = cities.reduce((s, x) => s + x.pop, 0);
    return { id: c.id, name: c.name, alive: c.alive, cities: cities.length, pop: Math.round(pop), techs: c.techs.size, age: c.age, kills: c.kills, casualties: c.casualties,
      score: Math.round(pop + c.techs.size * 10 + cities.length * 25 + c.age * 60 + c.kills * 2) };
  }

  // ----------------------------------------------------------------- visibility & intel
  refreshVisibility(intel = true) {
    const w = this.world, civs = this.civs;
    // what each empire's own units, buildings and territory reveal (computed once per owner) ...
    if (!this.visOwn || this.visOwn.length < civs.length) this.visOwn = civs.map((_, i) => this.visOwn?.[i] || { v: new Uint8Array(N), d: new Uint8Array(N) });
    const own = this.visOwn;
    for (let i = 0; i < civs.length; i++) { own[i].v.fill(0); own[i].d.fill(0); }
    for (const u of this.units.values()) {
      const o = own[u.owner]; if (!o) continue;
      const def = UNITS[u.type];
      let v = def.vision;
      if (!def.air) { const tt = w.terr[u.tile]; if (tt === T.HILLS) v += 1; else if (tt === T.MOUNTAIN) v += 2; }
      stamp(o.v, u.tile, v);
      stamp(o.d, u.tile, def.cat === 'air' && def.civilian ? 4 : 2);
    }
    for (const b of this.buildings.values()) {
      const o = own[b.owner]; if (!o) continue;
      stamp(o.v, b.tile, (BUILDINGS[b.type].vision || 2) + (civs[b.owner].techs.has('networked_command') ? 1 : 0));
      stamp(o.d, b.tile, 2);
    }
    for (let i = 0; i < N; i++) { const o = w.owner[i]; if (o >= 0 && own[o]) own[o].v[i] = 1; }
    // ... then each empire sees what it and its allies see
    for (const civ of civs) {
      if (!civ.alive) continue;
      const vis = civ.visible, det = civ.detect;
      const allies = civs.filter((o) => o.alive && this.allied(civ.id, o.id)).map((o) => o.id);
      vis.set(own[civ.id].v); det.set(own[civ.id].d);
      for (const a of allies) if (a !== civ.id) { const ov = own[a].v, od = own[a].d; for (let i = 0; i < N; i++) { vis[i] |= ov[i]; det[i] |= od[i]; } }
      if (this.smoke.size) concealBySmoke(this, civ, vis, allies);
      if (this.sandboxReveal && civ.human) vis.fill(1);      // developer sandbox matches see the whole field
      const ex = civ.explored, lo = civ.lastOwner, seenOwners = new Set();
      for (let i = 0; i < N; i++) if (vis[i]) { ex[i] = 1; const o = w.owner[i]; lo[i] = o; if (o >= 0) seenOwners.add(o); }
      if (intel) { this.updateIntel(civ); this.diplomacy.checkContact(civ, seenOwners); }
    }
  }

  // What a civilization actually knows about others: last-known cities and observed strength.
  updateIntel(civ) {
    const vis = civ.visible;
    for (const c of this.cities.values()) if (vis[c.tile]) civ.knownCities.set(c.id, { tile: c.tile, owner: c.owner, name: c.name, seen: this.time });
    for (const [id, k] of civ.knownCities) { if (!vis[k.tile]) continue; const c = this.cities.get(id); if (!c || c.tile !== k.tile) civ.knownCities.delete(id); }
    const seen = {};
    for (const u of this.units.values()) {
      if (u.owner === civ.id || !vis[u.tile] || !this.detects(civ.id, u)) continue;
      const d = UNITS[u.type]; if (d.civilian) continue;
      seen[u.owner] = (seen[u.owner] || 0) + (d.atk + d.def) * (u.hp / u.maxHp);
    }
    for (const o of this.civs) {
      if (o === civ) continue;
      const prev = civ.intel[o.id] || { peak: 0, seen: 0, time: -1 };
      const now = seen[o.id] || 0;
      prev.peak = Math.max(now, prev.peak * 0.99995);
      prev.seen = now; if (now > 0) prev.time = this.time;
      civ.intel[o.id] = prev;
    }
  }

  // share of a city's buildings that are damaged or in ruins (drives damaged-district visuals)
  cityDamage(c) {
    let n = 0, bad = 0;
    for (const t of disk(c.tile, Math.min(3, c.radius || 3))) {
      const b = this.buildingAtTile(t);
      if (b && b.owner === c.owner) { n++; if (b.state === 'damaged' || b.fire > 0) bad++; }
      else if (this.ruins.has(t)) { n++; bad++; }
    }
    return n ? Math.round((100 * bad) / n) : 0;
  }

  // ----------------------------------------------------------------- snapshots
  // Per-viewer snapshots. A viewer is a civ (fog-filtered) or the spectator (whole map, or a
  // followed civ's fog). Each viewer keeps its own "already sent" tile versions.
  snapshots(onlyCiv = null, econFlag = undefined) {
    const out = [];
    const full = onlyCiv !== null;
    const econ = econFlag ?? (this.tickN % 10 === 0 || full);
    for (const civ of this.civs) {
      if (civ.isRebel) continue;
      if (full ? civ.id !== onlyCiv : !civ.connected) continue;
      out.push([civ.id, this.viewerSnapshot(civ, { civ, vis: civ.visible, explored: civ.explored, god: false }, full, econ)]);
    }
    if (!full && this.observer && this.observer.connected) out.push([-2, this.observerSnapshot(false, econ)]);
    return out;
  }

  setObserver(opts = {}) {
    const o = this.observer || (this.observer = { connected: false, follow: 0, fog: false, knownVer: new Uint16Array(N), knownOwner: new Int8Array(N).fill(-2), visKey: '', knownStab: false });
    if (opts.connected !== undefined) o.connected = !!opts.connected;
    if (opts.follow !== undefined) { const c = this.civs[opts.follow | 0]; if (c && !c.isRebel) o.follow = c.id; }
    if (opts.fog !== undefined) o.fog = !!opts.fog;
    if (!this.civs[o.follow] || this.civs[o.follow].isRebel) o.follow = this.civs.find((c) => !c.isRebel)?.id ?? 0;
    return o;
  }

  observerSnapshot(full, econ = true) {
    const o = this.setObserver();
    const civ = this.civs[o.follow];
    if (!this.allSeen) this.allSeen = new Uint8Array(N).fill(1);
    const view = o.fog ? { civ, vis: civ.visible, explored: civ.explored, god: false, known: o, observer: true } : { civ, vis: this.allSeen, explored: this.allSeen, god: true, known: o, observer: true };
    return this.viewerSnapshot(civ, view, full, econ);
  }

  viewerSnapshot(civ, view, full, econ) {
    const w = this.world;
    const k = view.known || civ;   // where this viewer's sent-tile bookkeeping lives
    if (full) { k.knownVer.fill(0); k.knownOwner.fill(-2); k.visKey = ''; k.knownStab = false; }
    const vis = view.vis, explored = view.explored;
    const tiles = [];
    const stabOK = view.god || civ.techs.has('surveying');
    for (let i = 0; i < N; i++) {
      if (!vis[i] && !(full && explored[i])) continue;
      if (k.knownVer[i] !== w.ver[i] || k.knownOwner[i] !== w.owner[i] || (stabOK && k.knownStab !== true)) {
        k.knownVer[i] = w.ver[i]; k.knownOwner[i] = w.owner[i];
        tiles.push(tileRecord(w, i, stabOK, this.roads.packTile(i), this.ruins.has(i)));
      }
    }
    if (stabOK) k.knownStab = true;
    const units = [];
    for (const u of this.units.values()) {
      if (!view.god && u.owner !== civ.id && (!vis[u.tile] || !this.detects(civ.id, u))) continue;
      units.push([u.id, u.owner, u.type, u.tile, u.next ?? -1, Math.round(u.prog * 100), Math.round((100 * u.hp) / u.maxHp), Math.round(u.supply),
        (this.time - u.lastCombat < 1.5 ? 1 : 0) | (isWater(w.terr[u.tile]) && !UNITS[u.type].air ? 2 : 0) | (u.outOfSupply ? 4 : 0) | (u.status === 'waiting' ? 8 : 0) | (u.status === 'blocked' ? 16 : 0) | (u.field ? 32 : 0),
        u.owner === civ.id || view.god ? u.stance : undefined,
        u.owner === civ.id || view.god ? u.cstat || 0 : undefined, u.owner === civ.id || view.god ? u.tgt || 0 : undefined,
        Math.round(u.supp || 0), u.owner === civ.id || view.god ? Math.round(u.morale ?? 100) : undefined,
        vetLevel(u), u.refitUntil > this.time ? Math.ceil(u.refitUntil - this.time) : 0]);
    }
    const paths = {};
    for (const u of this.units.values()) if ((u.owner === civ.id || view.god) && (u.path.length || u.field)) paths[u.id] = u.field ? [u.slot] : u.path.slice(0, view.god ? 16 : 40);
    // combat events since this viewer's last delivery (a fresh view starts from now)
    if (full) k.evSeq = this.eventSeq;
    const ev = eventsFor(this, k.evSeq || 0, vis, view.god);
    k.evSeq = this.eventSeq;
    let visB64;
    const key = packBits(vis).toString('base64');
    if (key !== k.visKey) { k.visKey = key; visB64 = key; }
    const msg = { t: 's', time: +this.time.toFixed(1), tick: this.tickN, units, paths };
    if (ev.length) msg.ev = ev;
    if (tiles.length) msg.tiles = tiles;
    if (visB64) msg.vis = visB64;
    if (view.observer) msg.obs = { follow: civ.id, fog: !view.god, speed: this.speed ?? 1 };
    if (econ) Object.assign(msg, this.econSnapshot(civ, view));
    return msg;
  }

  econSnapshot(civ, view = null) {
    const vis = view ? view.vis : civ.visible;
    const god = !!(view && view.god);
    const buildings = [];
    for (const b of this.buildings.values()) {
      if (b.owner !== civ.id && !vis[b.tile]) continue;
      const own = b.owner === civ.id || god;
      buildings.push({ id: b.id, o: b.owner, ty: b.type, t: b.tile, hp: Math.round((100 * b.hp) / b.maxHp), d: b.done ? 1 : 0, p: Math.round(b.progress * 100), a: b.active || b.queue.length ? 1 : 0,
        st: b.state, f: b.fire > 0 ? 1 : 0, cr: b.done ? 0 : +(b.crew || 0).toFixed(2),
        lv: b.level > 1 ? b.level : undefined, ...(own ? { s: b.staffed, w: b.why || undefined, lk: b.lock ?? undefined, off: b.off ? 1 : undefined, tr: b.queue.length ? Math.max(0, Math.min(100, Math.round(100 * (1 - b.queue[0].left / Math.max(1, UNITS[b.queue[0].unit]?.time || 1))))) : undefined, q: b.queue.map((q) => [q.unit, Math.max(0, Math.round(q.left))]), c: b.cityId, r: b.rally, rp: b.repeat || undefined, gov: (this.cities.get(b.cityId)?.governor?.queue || []).includes(b.id) ? 1 : 0 } : {}) });
    }
    const cities = [];
    for (const c of this.cities.values()) {
      if (c.owner !== civ.id && !vis[c.tile]) continue;
      const own = c.owner === civ.id || god;
      cities.push({ id: c.id, o: c.owner, n: c.name, t: c.tile, pop: +c.pop.toFixed(1), cap: c.capital ? 1 : 0, r: c.radius,
        dmg: this.cityDamage(c),
        ...(own ? { h: c.housing, st: Math.round(c.stability), jobs: c.jobs, un: Math.round(c.unemployed), fs: c.foodShort ? 1 : 0, dis: Math.round(c.disaster), occ: Math.round(c.occupied), unrest: c.stability < 20 ? 1 : 0, trade: c.tradeConnected ? 1 : 0,
          mil: Math.round(c.mil || 0), rsv: c.reserved || 0, lab: labor(c), rec: recruitable(civ.id === c.owner ? civ : this.civs[c.owner], c), gr: +((c.growth || 0) * 60).toFixed(1), recov: c.recovering ? 1 : 0, ua: c.unassigned || 0, mig: +(c.inMig || 0).toFixed(1), fw: c.foodWorkers || 0, wf: c.wf || null, back: c.returning ? 1 : 0,
          iso: c.isolated ? 1 : 0, fr: c.freight === Infinity ? -1 : +(c.freight || 0).toFixed(1), stock: roundObj(c.stock || {}), ship: +(c.shipped || 0).toFixed(1),
          gov: c.governor ? { enabled: c.governor.enabled, level: c.governor.level || (c.governor.enabled ? 'autonomous' : 'off'), goal: c.governor.goal || 'none', budget: c.governor.budget ?? 0.15, emergency: c.governor.emergency !== false, spec: c.governor.spec, reserve: c.governor.reserve, perms: c.governor.perms, log: c.governor.log.slice(0, 12), queue: c.governor.queue,
            proposals: (c.governor.proposals || []).map((p) => ({ id: p.id, action: p.action, type: p.type, tile: p.tile, cost: p.cost, reason: p.reason, benefit: p.benefit, confidence: p.confidence })), deferred: c.governor.deferred || [] } : null } : {}) });
    }
    const ruins = [];
    for (const [t, r] of this.ruins) if (vis[t] || civ.explored[t] || god) ruins.push([t, r.type, (r.clearing ? 1 : 0) | (r.smoke > 0 ? 2 : 0) | (r.overgrown ? 4 : 0)]);
    const traffic = [];
    for (const [k, v] of this.roads.traffic) { const a = Math.floor(k / N), b = k % N; if (v > 0.5 && (vis[a] || vis[b])) traffic.push([a, b, Math.min(9, Math.round(v))]); }
    const soldiers = [...this.units.values()].filter((u) => u.owner === civ.id).reduce((s, u) => s + UNITS[u.type].pop, 0);
    const me = {
      res: roundObj(civ.res), rates: roundObj(civ.rates, 2), research: civ.researching, progress: Math.round(civ.progress), researchRate: +civ.researchRate.toFixed(2), queue: civ.queue,
      techs: [...civ.techs], age: civ.age, advancing: Math.round(civ.advancing), gov: civ.gov, govCooldown: Math.round(civ.govCooldown), policies: [...civ.policies],
      tax: civ.tax, focus: civ.focus, weariness: Math.round(civ.weariness), soldiers, wonder: civ.wonder ? Math.round(300 - (this.time - civ.wonder.since)) : null,
      power: { gen: Math.round(civ.powerGen), use: Math.round(civ.powerUse) }, storage: civ.storage || 0,
      roads: this.roads.projectsFor(civ.id), proposals: civ.proposals,
      armies: armySummary(this, civ), cmdlog: civ.cmdlog.slice(0, 60),
      readiness: this.tickN % 50 === 0 || !civ.readinessCache ? (civ.readinessCache = readiness(this, civ)) : civ.readinessCache,
      upkeep: civ.upkeep || null, natReserve: civ.natReserve ? civ.natReserve.type : null,
      market: civ.techs.has('trade_networks') ? this.marketInfo(civ) : null,
      men: [...this.units.values()].filter((u) => u.owner === civ.id).reduce((s, u) => s + (UNITS[u.type].men || 0), 0),
    };
    const civs = this.civs.map((c) => {
      const base = { id: c.id, name: c.name, color: c.color, alive: c.alive, human: c.human, rebel: c.isRebel };
      if (c.id === civ.id) return { ...base, age: c.age, rel: null, summary: this.civSummary(c) };
      const rel = this.diplomacy.rel(civ.id, c.id);
      if (rel.state === 'unmet' && !god) return { ...base, rel: { state: 'unmet' } };
      const knownCities = [...civ.knownCities.values()].filter((k) => k.owner === c.id).length;
      if (god && !c.isRebel) base.summary = this.civSummary(c);
      return { ...base, age: c.isRebel ? undefined : c.age, rel: { state: rel.state, trade: rel.trade, borders: rel.borders, until: rel.until ? Math.round(rel.until - this.time) : undefined }, known: { cities: knownCities } };
    });
    const out = { econ: me, buildings, cities, civs, ruins, traffic, supply: packBits(civ.supply).toString('base64'),
      bf: battlefieldSnapshot(this, vis, god ? vis : civ.explored), battles: battlesFor(this, civ, vis, god) };
    if (god) out.campaigns = this.campaignSummary();
    return out;
  }

  // Spectators see every AI offensive: where its army is, the city it is marching on.
  campaignSummary() {
    const list = [];
    for (const c of this.civs) {
      const cp = c.ai && c.ai.campaign; if (!cp || !c.alive) continue;
      const city = this.cities.get(cp.city); if (!city) continue;
      const army = [...this.units.values()].filter((u) => u.owner === c.id && !UNITS[u.type].civilian && !UNITS[u.type].engineer && u.type !== 'scout_buggy');
      if (!army.length) continue;
      // the unit nearest the army's centre of mass marks where the army is
      const mid = centroid(army.map((u) => u.tile));
      let best = army[0], bd = Infinity; for (const u of army) { const d = dist(u.tile, mid); if (d < bd) { bd = d; best = u; } }
      list.push({ civ: c.id, from: best.tile, to: city.tile, name: city.name, owner: city.owner, n: army.length });
    }
    return list;
  }

  // ----------------------------------------------------------------- commands
  command(civId, cmd) {
    const civ = this.civs[civId];
    if (!civ || !civ.alive || this.over) return { error: 'not active' };
    const res = this.commandInner(civ, cmd);
    if (!(res && res.error) && civ.human) { const d = this.describeCommand(civ, cmd); if (d) this.history(civ, cmd.by || 'you', d); }
    return res;
  }

  describeCommand(civ, cmd) {
    const n = (ids) => (ids || []).length;
    switch (cmd.c) {
      case 'move': return `${cmd.attackMove ? 'Attack-move' : 'Move'} ${n(cmd.units)} unit${n(cmd.units) === 1 ? '' : 's'} (${cmd.formation || 'line'})`;
      case 'attack': return `${cmd.focus ? 'Focus fire' : 'Attack'} with ${n(cmd.units)} unit${n(cmd.units) === 1 ? '' : 's'}`;
      case 'withdraw': return `Withdraw ${n(cmd.units)} unit${n(cmd.units) === 1 ? '' : 's'}`;
      case 'hold': return `Hold position (${n(cmd.units)} units)`;
      case 'build': return `${cmd.plan ? 'Plan' : 'Build'} ${BUILDINGS[cmd.type]?.name}` + (cmd.why ? `: ${cmd.why}` : '');
      case 'train': return `Train ${UNITS[cmd.unit]?.name}`;
      case 'batchTrain': return `Train ${cmd.count} ${UNITS[cmd.unit]?.name} across ${n(cmd.buildings)} buildings`;
      case 'research': return `${cmd.queue ? 'Queue' : 'Research'} ${TECHS[cmd.tech]?.name}`;
      case 'advance': return `Advance to the ${AGES[civ.age + 1]?.name} era`;
      case 'gov': return `Government: ${GOVS[cmd.id]?.name}`;
      case 'policy': return `${cmd.on ? 'Enact' : 'Repeal'} ${POLICIES[cmd.id]?.name}`;
      case 'tax': return `Tax level ${cmd.level}`;
      case 'diplo': return `Diplomacy: ${cmd.action} → ${this.civs[cmd.to]?.name}`;
      case 'demolish': return 'Demolish building';
      case 'found': return 'Found a city';
      case 'roadPlan': return cmd.commit ? `Commission road (${(cmd.tiles || []).length} waypoints)` : null;
      case 'governor': return `Governor settings for ${this.cities.get(cmd.city)?.name}`;
      case 'clearPass': return 'Blast a pass through the peaks';
      default: return null;
    }
  }

  commandInner(civ, cmd) {
    try {
      switch (cmd.c) {
        case 'move': {
          const line = Array.isArray(cmd.line) && cmd.line.length === 2 && cmd.line.every((t) => t >= 0 && t < N) ? cmd.line : null;
          return this.orderMove(civ, cmd.units, line ? line[0] : cmd.tile, !!cmd.attackMove, cmd.formation || 'line', { auth: this.authOf(civ, cmd), queue: !!cmd.queue, line });
        }
        case 'attack': return this.orderAttack(civ, cmd.units, cmd.target, { focus: !!cmd.focus, auth: this.authOf(civ, cmd) });
        case 'withdraw': return this.orderWithdraw(civ, cmd.units, cmd.tile);
        case 'sandbox': {
          // developer combat sandbox only: stage scenarios and spawn forces for either side
          if (!this.sandbox) return { error: 'only available in the combat sandbox' };
          if (cmd.op === 'scenario') { const r = runScenario(this, cmd.key, cmd.tile >= 0 ? cmd.tile : undefined); return r.error ? r : { reply: { t: 'ack', scenario: r } }; }
          if (cmd.op === 'spawn' && UNITS[cmd.type] && (cmd.civ === 0 || cmd.civ === 1) && cmd.tile >= 0 && cmd.tile < N) { const us = spawnGroup(this, cmd.civ, cmd.type, cmd.tile, Math.max(1, Math.min(30, cmd.n | 0 || 1))); if (cmd.civ === 1) for (const u of us) u.stance = cmd.stance || 'defensive'; return null; }
          if (cmd.op === 'clear') { clearForces(this); return null; }
          if (cmd.op === 'advance') { const ids = [...this.units.values()].filter((u) => u.owner === 1).map((u) => u.id); return this.orderMove(this.civs[1], ids, cmd.tile, true, 'line', {}); }
          return { error: 'bad sandbox op' };
        }
        case 'hold':
        case 'stop': for (const id of cmd.units || []) { const u = this.units.get(id); if (u && u.owner === civ.id) { u.path = []; u.field = false; u.order = { kind: 'idle' }; u.goal = -1; u.slot = -1; u.groupSpeed = 0; u.queue = []; u.retreating = false; u.auth = cmd.c === 'hold' ? this.authOf(civ, cmd) : ''; if (cmd.c === 'hold' && !UNITS[u.type].civilian) u.stance = 'hold'; } } return null;
        case 'engage': for (const id of cmd.units || []) { const u = this.units.get(id); if (u && u.owner === civ.id && ['balanced', 'focus', 'threat', 'antiArmor', 'counterBattery', 'defensive'].includes(cmd.policy)) u.policy = cmd.policy; } return null;
        case 'stance': for (const id of cmd.units || []) { const u = this.units.get(id); if (u && u.owner === civ.id && ['aggressive', 'defensive', 'hold'].includes(cmd.stance) && !UNITS[u.type].civilian) u.stance = cmd.stance; } return null;
        case 'build': {
          if (!this.canPlace(civ, cmd.type, cmd.tile, true)) return { error: 'Cannot build there' };
          if (this.isAutomated(civ, cmd) && !ESSENTIAL.has(cmd.type) && !cmd.national && !this.enablesSavings(civ, cmd.type) && this.breaksSavings(civ, this.buildingCost(civ, cmd.type, cmd.tile))) return { error: 'saving for the next era' };
          const affordable = this.canAfford(civ, this.buildingCost(civ, cmd.type, cmd.tile), cmd.tile);
          if (!affordable && !cmd.plan) return { error: 'Not enough resources (shift-click to plan it; it starts when funded)' };
          this.placeBuilding(civ, cmd.type, cmd.tile, false, !affordable);
          return null;
        }
        case 'placement': {
          const tiles = [];
          for (let i = 0; i < N; i++) if (civ.explored[i] && this.canPlace(civ, cmd.type, i, true)) tiles.push(i);
          return { reply: { t: 'placement', type: cmd.type, tiles, afford: this.canAfford(civ, this.buildingCost(civ, cmd.type)) } };
        }
        case 'roadPlan': {
          const type = Math.max(1, Math.min(4, cmd.type | 0));
          let tiles = (cmd.tiles || []).slice(0, 400);
          if (cmd.auto && tiles.length >= 2) tiles = findRoadRoute(this, civ, tiles[0], tiles[tiles.length - 1], type) || tiles;
          const plan = this.roads.plan(this, civ, tiles, type);
          if (cmd.commit) { const r = this.roads.startProject(this, civ, plan); if (r.error) return { error: r.error }; return { reply: { t: 'roadPlan', plan, started: r.project } }; }
          return { reply: { t: 'roadPlan', plan } };
        }
        case 'roadCancel': return this.roads.cancel(civ, cmd.id);
        case 'demolish': {
          const b = this.buildings.get(cmd.id);
          if (b && b.owner === civ.id && b.type !== 'town') {
            if (!b.done) { const cost = BUILDINGS[b.type].cost; for (const k in cost) civ.res[k] += Math.floor(cost[k] * 0.5); }
            const city = this.cities.get(b.cityId); if (city?.governor && cmd.block) city.governor.blocked.push(b.tile);
            this.removeBuilding(b);
          }
          return null;
        }
        case 'clearRuin': {
          const r = this.ruins.get(cmd.tile);
          if (!r || (this.world.owner[cmd.tile] >= 0 && this.world.owner[cmd.tile] !== civ.id)) return { error: 'No ruins you can clear there' };
          if (!this.canAfford(civ, { materials: 15 })) return { error: 'Clearing needs 15 materials' };
          this.pay(civ, { materials: 15 }); r.clearing = true; r.clearAt = this.time + 8; return null;
        }
        case 'train': {
          const b = this.buildings.get(cmd.building);
          if (!b) return { error: 'no building' };
          if (this.isAutomated(civ, cmd) && !cmd.urgent && this.breaksSavings(civ, this.unitCost(civ, cmd.unit))) return { error: 'saving for the next era' };
          const why = this.canTrain(civ, b, cmd.unit); if (why) return { error: why };
          this.pay(civ, this.unitCost(civ, cmd.unit), b.tile);
          const city = this.cities.get(b.cityId);
          const men = city ? UNITS[cmd.unit].pop || 0 : 0;
          if (city && men) reserve(city, men);           // manpower is reserved, not yet lost
          b.queue.push({ unit: cmd.unit, left: UNITS[cmd.unit].time, auto: !!cmd.auto, army: cmd.army || b.rallyArmy || 0, men, cost: this.unitCost(civ, cmd.unit), batch: cmd.batch || 0 });
          return null;
        }
        case 'rally': { const b = this.buildings.get(cmd.building); if (b && b.owner === civ.id) { b.rally = cmd.tile; b.rallyArmy = cmd.army || 0; } return null; }
        case 'found': {
          const u = this.units.get(cmd.unit);
          if (!u || u.owner !== civ.id || u.type !== 'colonist') return { error: 'need a colonist convoy' };
          const why = this.canFound(civ, u.tile); if (why) return { error: why };
          this.units.delete(u.id);
          const c = this.foundCity(civ, u.tile, (u.men || 3) + (civ.policies.has('homesteading') ? 1 : 0));   // the convoy's settlers
          c.stock = { food: 80, materials: 60 };   // the convoy's wagons become the new town's first reserves
          if (civ.human && u.auto) { c.governor.enabled = true; c.governor.level = 'managed'; }
          this.notify(civ.id, `New city founded: ${c.name}.`, { kind: 'city', tile: c.tile });
          recomputeTerritory(this); recomputeTradeNetwork(this);
          return null;
        }
        case 'research': {
          const tech = TECHS[cmd.tech];
          if (!tech || civ.techs.has(cmd.tech)) return { error: 'unavailable' };
          const ready = tech.age <= civ.age && tech.req.every((r) => civ.techs.has(r));
          if (!ready || cmd.queue) {
            // queue it (and any missing prerequisites in order)
            const chain = [];
            const add = (k) => { if (civ.techs.has(k) || chain.includes(k)) return; for (const r of TECHS[k].req) add(r); chain.push(k); };
            add(cmd.tech);
            for (const k of chain) if (!civ.queue.includes(k) && k !== civ.researching) civ.queue.push(k);
            return null;
          }
          if (civ.researching !== cmd.tech) { civ.researching = cmd.tech; civ.progress = 0; civ.queue = civ.queue.filter((k) => k !== cmd.tech); }
          return null;
        }
        case 'unqueue': civ.queue = civ.queue.filter((k) => k !== cmd.tech); return null;
        case 'advance': {
          const next = AGES[civ.age + 1]; if (!next || civ.advancing) return { error: 'cannot advance' };
          const have = [...civ.techs].filter((t) => TECHS[t].age === civ.age).length;
          if (have < next.techsNeeded) return { error: `need ${next.techsNeeded} ${AGES[civ.age].name} technologies` };
          if (!this.canAfford(civ, next.cost)) return { error: 'cannot afford' };
          this.pay(civ, next.cost); civ.advancing = next.time; return null;
        }
        case 'gov': {
          const g = GOVS[cmd.id]; if (!g || (g.tech && !civ.techs.has(g.tech))) return { error: 'unavailable' };
          if (civ.govCooldown > 0) return { error: 'government recently changed' };
          civ.gov = cmd.id; civ.govCooldown = 90;
          while (civ.policies.size > g.slots) civ.policies.delete([...civ.policies][0]);
          for (const c of this.cityOf(civ)) c.stability = Math.max(0, c.stability - 10);
          this.notify(civ.id, `Government reformed: ${g.name}.`, { kind: 'gov' }); return null;
        }
        case 'policy': {
          const p = POLICIES[cmd.id]; if (!p) return { error: 'unknown' };
          if (cmd.on) {
            if (p.tech && !civ.techs.has(p.tech)) return { error: 'requires ' + TECHS[p.tech].name };
            if (civ.policies.size >= GOVS[civ.gov].slots) return { error: 'no free policy slots' };
            civ.policies.add(cmd.id);
          } else civ.policies.delete(cmd.id);
          return null;
        }
        case 'tax': civ.tax = Math.max(0, Math.min(3, cmd.level | 0)); return null;
        case 'focus': if (FOCI[cmd.id]) civ.focus = cmd.id; return null;
        case 'governor': {
          const c = this.cities.get(cmd.city);
          if (!c || c.owner !== civ.id) return { error: 'not your city' };
          const gv = c.governor || (c.governor = defaultGovernor());
          migrateGovernor(gv);
          if (cmd.enabled !== undefined) { gv.enabled = !!cmd.enabled; gv.level = gv.enabled ? (gv.level === 'off' ? 'advisor' : gv.level) : 'off'; }
          if (cmd.level && LEVELS.includes(cmd.level)) { gv.level = cmd.level; gv.enabled = cmd.level !== 'off'; }
          if (cmd.goal && GOALS[cmd.goal]) gv.goal = cmd.goal;
          if (cmd.budget !== undefined) gv.budget = Math.max(0.05, Math.min(0.6, +cmd.budget));
          if (cmd.emergency !== undefined) gv.emergency = !!cmd.emergency;
          if (cmd.proposal != null) { const r = answerProposal(this, civ, c, cmd.proposal, cmd.answer); if (r && r.error) return r; }
          if (cmd.spec && GOVERNOR_SPECS[cmd.spec]) gv.spec = cmd.spec;
          if (cmd.reserve !== undefined) gv.reserve = Math.max(0, Math.min(0.9, +cmd.reserve));
          if (cmd.perms) for (const k of ['build', 'roads', 'repair', 'recruit', 'settle']) if (cmd.perms[k] !== undefined) gv.perms[k] = !!cmd.perms[k];
          if (cmd.cancel) { const b = this.buildings.get(cmd.cancel); if (b && !b.done && b.owner === civ.id) { this.command(civ.id, { c: 'demolish', id: b.id, block: true }); gv.log.unshift({ t: Math.round(this.time), text: `Project cancelled by you: ${BUILDINGS[b.type].name}. The governor will not build on that hex again.` }); } }
          return null;
        }
        case 'army': return armyCommand(this, civ, cmd);
        case 'workforce': {
          // labor settings: allocation mode, category priorities, per-building locks and switches
          const c = this.cities.get(cmd.city);
          if (!c || c.owner !== civ.id) return { error: 'not your city' };
          const wf = c.wf || (c.wf = defaultWorkforce());
          if (cmd.mode && MODES[cmd.mode]) { wf.mode = cmd.mode; wf.prio = { ...MODES[cmd.mode] }; }
          if (cmd.prio) for (const k of CATEGORIES) if (cmd.prio[k] in PRIORITY) { wf.prio[k] = cmd.prio[k]; wf.mode = 'custom'; }
          if (cmd.building != null) {
            const b = this.buildings.get(cmd.building);
            if (!b || b.owner !== civ.id || b.cityId !== c.id || !BUILDINGS[b.type].jobs) return { error: 'not a workplace in this city' };
            if ('lock' in cmd) b.lock = cmd.lock == null ? null : Math.max(0, Math.min(BUILDINGS[b.type].jobs[1], cmd.lock | 0));
            if ('off' in cmd) b.off = !!cmd.off;
          }
          if (cmd.autoBalance) {
            // apply the previewed balance: clear locks (not switches) and use the chosen mode
            for (const b of this.buildings.values()) if (b.cityId === c.id && b.owner === civ.id) b.lock = null;
            if (cmd.mode && MODES[cmd.mode]) { wf.mode = cmd.mode; wf.prio = { ...MODES[cmd.mode] }; }
          }
          return null;
        }
        case 'workforcePreview': {
          const c = this.cities.get(cmd.city);
          if (!c || c.owner !== civ.id) return { error: 'not your city' };
          const mode = MODES[cmd.mode] ? cmd.mode : 'balanced';
          // the preview clears locks on a copy, like the real auto-balance
          const locks = new Map();
          for (const b of this.buildings.values()) if (b.cityId === c.id && b.lock != null) { locks.set(b.id, b.lock); b.lock = null; }
          const r = allocationFor(this, civ, c, { mode, prio: { ...MODES[mode] } });
          for (const [id, l] of locks) this.buildings.get(id).lock = l;
          const changes = r.blds.filter((b) => BUILDINGS[b.type].jobs && b.done && (r.plan.get(b.id) || 0) !== (b.staffed || 0)).map((b) => ({ id: b.id, type: b.type, from: b.staffed || 0, to: r.plan.get(b.id) || 0 }));
          return { reply: { t: 'ack', preview: { mode, changes, effect: r.effect, unassigned: r.unassigned } } };
        }
        case 'import': {
          const k = cmd.good, price = IMPORT_PRICE[k];
          if (!price) return { error: 'that cannot be imported' };
          if (!civ.techs.has('trade_networks')) return { error: 'requires Trade Networks' };
          const quote = this.importQuote(civ, k, cmd.amount | 0);
          if (quote.error) return quote;
          if (this.isAutomated(civ, cmd) && (civ.res.credits - quote.credits) < (civ.saving?.credits || 0)) return { error: 'saving for the next era' };
          if (civ.res.credits < quote.credits) return { error: `needs ${quote.credits} credits` };
          civ.res.credits -= quote.credits; civ.res[k] = (civ.res[k] || 0) + quote.amount;
          civ.importUsed = civ.importUsedNext; civ.importAt = this.time;
          civ.imported = (civ.imported || 0) + quote.amount;
          return { reply: { t: 'ack', bought: quote } };
        }
        case 'importQuote': return { reply: { t: 'ack', quote: this.importQuote(civ, cmd.good, cmd.amount | 0) } };
        case 'refit': {
          // re-equip units at a facility that builds the new type; veterancy is kept
          const to = cmd.to, ud = UNITS[to];
          if (!ud) return { error: 'unknown unit' };
          if (ud.tech && !civ.techs.has(ud.tech)) return { error: 'requires ' + TECHS[ud.tech].name };
          if (ud.age > civ.age) return { error: 'requires ' + AGES[ud.age].name };
          let done = 0, why = '';
          for (const id of cmd.units || []) {
            const u = this.units.get(id); if (!u || u.owner !== civ.id || u.refitUntil > this.time) continue;
            const path = (REFIT[u.type] || []).find((r) => r.to === to); if (!path) { why = `${UNITS[u.type].name} cannot be refitted into ${ud.name}`; continue; }
            const fac = [...this.buildings.values()].find((b) => b.owner === civ.id && b.done && (BUILDINGS[b.type].trains || []).includes(to) && dist(b.tile, u.tile) <= 3);
            if (!fac) { why = `bring it within 3 hexes of a ${Object.values(BUILDINGS).find((d) => (d.trains || []).includes(to))?.name || 'facility'} that builds ${ud.name}`; continue; }
            const cost = this.refitCost(civ, u.type, to, path.conv);
            const extra = Math.max(0, (ud.pop || 0) - (u.men ?? UNITS[u.type].pop ?? 0));
            const city = this.cities.get(fac.cityId);
            if (extra && city) { const block = recruitBlock(civ, city, extra); if (block) { why = block; continue; } }
            if (!this.canAfford(civ, cost, fac.tile)) { why = 'cannot afford the refit'; continue; }
            this.pay(civ, cost, fac.tile);
            if (extra && city) { city.pop -= extra; city.mil = (city.mil || 0) + extra; }
            const frac = u.hp / u.maxHp;
            u.type = to; u.maxHp = ud.hp; u.hp = Math.max(1, ud.hp * Math.max(0.5, frac)); u.men = (u.men ?? 0) + extra;
            u.refitUntil = this.time + Math.max(6, ud.time * (path.conv ? 0.7 : 0.4));
            u.path = []; u.field = false; u.order = { kind: 'idle' };
            done++;
          }
          if (!done) return { error: why || 'nothing to refit' };
          return { reply: { t: 'ack', refitted: done } };
        }
        case 'upgrade': {
          // housing upgrades: a block gains storeys (more homes on the same hex)
          const b = this.buildings.get(cmd.id);
          if (!b || b.owner !== civ.id || b.type !== 'house' || !b.done) return { error: 'only finished housing can be upgraded' };
          const lv = b.level || 1;
          if (lv >= 3) return { error: 'already at the highest density' };
          const cost = this.upgradeCost(civ, b);
          if (this.isAutomated(civ, cmd) && this.breaksSavings(civ, cost)) return { error: 'saving for the next era' };
          if (!this.canAfford(civ, cost, b.tile)) return { error: 'cannot afford the upgrade' };
          this.pay(civ, cost, b.tile);
          b.level = lv + 1; b.maxHp = Math.round(BUILDINGS.house.hp * (1 + 0.5 * lv)); b.hp = Math.min(b.maxHp, b.hp + BUILDINGS.house.hp * 0.5);
          this.world.touch(b.tile);
          return null;
        }
        case 'batchTrain': {
          // one order, many facilities: idempotent per requestId, charged once per unit queued
          if (cmd.requestId != null) { this.requests = this.requests || new Map(); const seen = this.requests.get(civ.id + ':' + cmd.requestId); if (seen) return { reply: { t: 'ack', batch: seen, repeat: true } }; }
          const res = this.trainBatch(civ, cmd.buildings || [], cmd.unit, Math.max(1, Math.min(60, cmd.count | 0)), { policy: cmd.policy === 'all' ? 'all' : 'partial', by: cmd.by, army: cmd.army, each: cmd.each ? Math.max(1, Math.min(8, cmd.each | 0)) : 0 });
          if (cmd.requestId != null) { this.requests.set(civ.id + ':' + cmd.requestId, res); if (this.requests.size > 300) this.requests.delete(this.requests.keys().next().value); }
          if (res.error) return { error: res.error };
          return { reply: { t: 'ack', batch: res } };
        }
        case 'repeat': {
          // repeat production: a facility re-queues its unit whenever its queue empties (with safeguards)
          for (const id of cmd.buildings || []) { const b = this.buildings.get(id); if (b && b.owner === civ.id && BUILDINGS[b.type].trains) b.repeat = cmd.unit && BUILDINGS[b.type].trains.includes(cmd.unit) ? cmd.unit : null; }
          return null;
        }
        case 'cancelTrain': {
          const b = this.buildings.get(cmd.building);
          if (!b || b.owner !== civ.id) return { error: 'no building' };
          const i = cmd.index ?? b.queue.length - 1, q = b.queue[i];
          if (!q) return { error: 'nothing queued' };
          b.queue.splice(i, 1);
          releaseTraining(this.cities.get(b.cityId), q);
          // full refund before work starts, half once training is under way
          const started = i === 0 && q.left < UNITS[q.unit].time - 0.01;
          const share = started ? 0.5 : 1;
          const refund = {}; for (const [k, v] of Object.entries(q.cost || {})) refund[k] = Math.floor(v * share);
          for (const [k, v] of Object.entries(refund)) civ.res[k] = (civ.res[k] || 0) + v;
          return { reply: { t: 'ack', refund, men: q.men || 0 } };
        }
        case 'disband': {
          let men = 0, back = 0;
          for (const id of cmd.units || []) {
            const u = this.units.get(id); if (!u || u.owner !== civ.id || u.type === 'colonist') continue;
            const r = demobilize(this, u); men += r.men; back += r.back;
            this.units.delete(u.id);
          }
          return { reply: { t: 'ack', men, back: +back.toFixed(1) } };
        }
        case 'autoSettle': { const u = this.units.get(cmd.unit); if (!u || u.owner !== civ.id || u.type !== 'colonist') return { error: 'need a colonist convoy' }; u.auto = true; return null; }
        case 'repair': return this.repairBuilding(civ, this.buildings.get(cmd.id), cmd.by || 'you');
        case 'rallyAll': {
          let n = 0;
          for (const b of this.buildings.values()) if (b.owner === civ.id && BUILDINGS[b.type].trains && (!cmd.cat || BUILDINGS[b.type].cat === cmd.cat)) { b.rally = cmd.tile; b.rallyArmy = cmd.army || 0; n++; }
          this.history(civ, cmd.by || 'you', `Rally point set for ${n} production buildings`);
          return null;
        }
        case 'diplo': return this.diplomacy.act(civ, cmd.to, cmd.action);
        case 'respond': return this.diplomacy.respond(civ, cmd.id, !!cmd.accept);
        case 'clearPass': return this.clearPass(civ, cmd.tile);
        case 'surrender': this.eliminate(civ); return null;
        default: return { error: 'unknown command' };
      }
    } catch (e) {
      return { error: 'command failed: ' + e.message };
    }
  }

  canFound(civ, t) {
    const w = this.world;
    if (isWater(w.terr[t]) || !Number.isFinite(TERRAIN[w.terr[t]].move) || w.terr[t] === T.MOUNTAIN) return 'unsuitable terrain';
    if (w.owner[t] >= 0 && w.owner[t] !== civ.id) return 'inside foreign territory';
    if (this.tileB[t] >= 0) return 'tile occupied';
    for (const c of this.cities.values()) if (dist(c.tile, t) < 6) return 'too close to another city';
    return null;
  }

  // Group orders: formation slots, a shared flow field per movement class, the group moves at
  // its slowest member's pace, and the result says who can reach the destination.
  // who stands behind an order: the player directly, or automation (governor, army, AI)
  // automation (AI empires, governors, armies) spends within the national savings plan
  isAutomated(civ, cmd) { return !civ.human || !!cmd.by; }
  // Production manager (players, governors and AI): distribute `count` units over facilities so
  // each next unit goes where it would finish earliest; reserve cost and manpower exactly once.
  trainBatch(civ, ids, unit, count, opts = {}) {
    const blds = [...new Set(ids)].map((id) => this.buildings.get(id)).filter((b) => b && b.owner === civ.id && b.done && (BUILDINGS[b.type].trains || []).includes(unit));
    if (!blds.length) return { error: `none of the selected buildings can train ${UNITS[unit]?.name || unit}` };
    const ud = UNITS[unit], cost = this.unitCost(civ, unit);
    if (opts.policy === 'all') {
      // all-or-nothing: check the whole order first
      const total = {}; for (const [k, v] of Object.entries(cost)) total[k] = v * count;
      if (!this.canAfford(civ, total, blds[0].tile)) return { error: `cannot afford ${count} ${ud.name}` };
      const menNeed = (ud.pop || 0) * count;
      const room = blds.reduce((s2, b) => s2 + Math.max(0, 8 - b.queue.length), 0);
      if (room < count) return { error: `queues have room for only ${room}` };
      if (menNeed) { const cities = new Map(); for (const b of blds) cities.set(b.cityId, this.cities.get(b.cityId)); let rec = 0; for (const c of cities.values()) if (c) rec += Math.max(0, recruitable(civ, c)); if (rec < menNeed) return { error: `needs ${menNeed} reserve manpower, ${rec} available` }; }
    }
    const eta = (b) => b.queue.reduce((s2, q) => s2 + q.left, 0) + ud.time * (b.state === 'damaged' ? 2 : 1);
    const per = {}; let queued = 0, blocked = '';
    for (let n = 0; n < count; n++) {
      // `each`: exactly that many per building; otherwise each unit goes where it finishes soonest
      const order = blds.filter((b) => b.queue.length < 8 && (!opts.each || (per[b.id] || 0) < opts.each)).sort((a, b) => eta(a) - eta(b) || a.id - b.id);
      let placed = false;
      for (const b of order) {
        const why = this.canTrainBatch(civ, b, unit);
        if (why) { blocked = why; continue; }
        this.pay(civ, cost, b.tile);
        const city = this.cities.get(b.cityId), men = city ? ud.pop || 0 : 0;
        if (city && men) reserve(city, men);
        b.queue.push({ unit, left: ud.time, auto: false, army: opts.army || b.rallyArmy || 0, men, cost, batch: 1 });
        per[b.id] = (per[b.id] || 0) + 1; queued++; placed = true; break;
      }
      if (!placed) break;
    }
    const total = {}; for (const [k, v] of Object.entries(cost)) total[k] = v * queued;
    const finish = blds.length ? Math.round(Math.max(...blds.map((b) => b.queue.reduce((s2, q) => s2 + q.left, 0)))) : 0;
    return { unit, requested: count, queued, per, cost: total, finish, blocked: queued < count ? blocked || 'queues are full' : '', text: queued < count ? `${queued} of ${count} queued. Remaining ${count - queued} blocked: ${blocked || 'queues are full'}.` : `${queued} ${ud.name} queued across ${Object.keys(per).length} building${Object.keys(per).length > 1 ? 's' : ''}.` };
  }
  // like canTrain, but a batch may fill queues up to 8
  canTrainBatch(civ, b, unit) {
    const def = UNITS[unit], bd = BUILDINGS[b.type];
    if (!def || !bd.trains || !bd.trains.includes(unit) || !b.done || b.owner !== civ.id) return 'not available here';
    if (def.age > civ.age) return 'requires ' + AGES[def.age].name;
    if (def.tech && !civ.techs.has(def.tech)) return 'requires ' + TECHS[def.tech].name;
    const city = this.cities.get(b.cityId);
    if (city && def.pop) { const why = recruitBlock(civ, city, def.pop); if (why) return 'insufficient reserve manpower'; }
    if (b.queue.length >= 8) return 'queues are full';
    if (!this.canAfford(civ, this.unitCost(civ, unit), b.tile)) return 'cannot afford';
    return null;
  }
  // World market capacity refills over a minute; trade partners make goods cheaper.
  importQuote(civ, k, amount) {
    const price = IMPORT_PRICE[k]; if (!price) return { error: 'that cannot be imported' };
    const markets = [...this.buildings.values()].filter((b) => b.owner === civ.id && b.type === 'market' && b.done && b.state !== 'damaged').length;
    if (!markets) return { error: 'needs an operational market' };
    const partners = this.civs.filter((o) => o !== civ && o.alive && !o.isRebel && this.diplomacy.rel(civ.id, o.id).trade).length;
    const cap = markets * IMPORT_PER_MARKET;
    const used = Math.max(0, (civ.importUsed || 0) - (this.time - (civ.importAt || 0)) * (cap / 60));
    const room = Math.max(0, Math.floor(cap - used));
    const n = Math.max(0, Math.min(amount || 0, room, Math.max(0, Math.floor((civ.storage || 1500) - (civ.res[k] || 0)))));
    if (!n) return { error: room ? 'storage is full' : 'the markets are at capacity for now' };
    const unit = price * (partners ? 1 - Math.min(0.35, partners * 0.12) : 1.4);
    civ.importUsedNext = used + n;
    return { good: k, amount: n, credits: Math.ceil(n * unit), unit: +unit.toFixed(2), room };
  }
  marketInfo(civ) {
    const out = {};
    for (const k of Object.keys(IMPORT_PRICE)) { const q = this.importQuote(civ, k, 1e6); out[k] = q.error ? { error: q.error } : { unit: q.unit, room: q.room }; }
    return out;
  }
  // what produces the saved goods (or powers their producers) is an investment in the goal itself
  enablesSavings(civ, type) {
    const sv = civ.saving; if (!sv) return false;
    const d = BUILDINGS[type];
    if (d.power > 0) return true;
    return !!d.produce && Object.keys(d.produce).some((k) => sv[k] || (k === 'ore' && sv.steel));
  }
  breaksSavings(civ, cost) {
    if (civ.natReserve && this.time - civ.natReserve.since > 240) civ.natReserve = null;   // never wait forever
    const res = civ.natReserve?.cost;
    for (const sv of [civ.saving, res]) {
      if (!sv) continue;
      for (const [k, v] of Object.entries(cost)) if (sv[k] && (civ.res[k] || 0) - v < sv[k]) return true;
    }
    return false;
  }
  authOf(civ, cmd) { return civ.human && !cmd.by ? 'player' : cmd.auth || 'mission'; }

  orderMove(civ, ids, tile, attackMove, formation = 'line', opts = {}) {
    if (!(tile >= 0 && tile < N)) return { error: 'bad tile' };
    const units = (ids || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id);
    const results = { reached: 0, partial: 0, unreachable: 0, kept: 0 };
    if (!units.length) return { reply: { t: 'ack', order: results } };
    const auth = opts.auth || '';
    // order ownership: automation never overrides a unit the player is directing
    const free = auth === 'player' ? units : units.filter((u) => u.auth !== 'player' || u.order.kind === 'idle');
    if (!free.length) return { reply: { t: 'ack', order: results } };
    const kind = opts.withdraw ? 'move' : attackMove ? 'attackMove' : 'move';
    // shift-queued: append a leg instead of replacing the current order
    if (opts.queue) {
      const slots = free.length > 1 ? formationSlots(this, civ, free, tile, formation, opts.line) : new Map([[free[0].id, tile]]);
      for (const u of free) { (u.queue || (u.queue = [])).push({ tile: slots.get(u.id) ?? tile, attackMove: !!attackMove }); if (u.queue.length > 8) u.queue.shift(); if (u.order.kind === 'idle' && !u.path.length) { const nx = u.queue.shift(); u.order = { kind: nx.attackMove ? 'attackMove' : 'move' }; u.goal = nx.tile; u.slot = nx.tile; u.path = findPath(this, civ, u.tile, nx.tile, u.type) || []; } }
      return { reply: { t: 'ack', order: { ...results, queued: free.length } } };
    }
    // the same order again (an AI replanning, a double click) keeps existing routes
    const same = free.filter((u) => u.goal === tile && u.order.kind === kind && !opts.line && (u.path.length || u.field || u.tile === u.slot) && !!u.order.withdraw === !!opts.withdraw);
    if (same.length === free.length) { results.kept = free.length; return { reply: { t: 'ack', order: results } }; }
    const slots = free.length > 1 || opts.line ? formationSlots(this, civ, free, tile, formation, opts.line) : new Map([[free[0].id, tile]]);
    const ground = free.filter((u) => !UNITS[u.type].air);
    const groupSpeed = free.length >= 3 && ground.length ? Math.min(...ground.map((u) => UNITS[u.type].speed)) : 0;
    for (const u of free) {
      const slot = slots.get(u.id) ?? tile;
      u.order = { kind }; if (opts.withdraw) u.order.withdraw = true;
      u.retreating = !!opts.withdraw;
      u.auth = auth; u.queue = [];
      u.goal = tile; u.slot = slot; u.wait = 0; u.status = 'ok';
      u.groupSpeed = UNITS[u.type].air ? 0 : groupSpeed;
      const far = dist(u.tile, slot) > 6;
      if (free.length >= 4 && far) {
        const field = flowField(this, civ, tile, u.type);
        if (Number.isFinite(field[u.tile])) { u.field = true; u.path = []; results.reached++; continue; }
      }
      u.field = false;
      const path = u.tile === slot ? [] : findPath(this, civ, u.tile, slot, u.type);
      u.path = path || [];
      if (path && path.partial) { u.slot = path[path.length - 1]; results.partial++; }
      else if (!path && u.tile !== slot) results.unreachable++;
      else results.reached++;
    }
    if (opts.line) results.slots = [...slots.values()];
    return { reply: { t: 'ack', order: results } };
  }

  // Group attack: by default fire is distributed over the threats around the target with
  // overkill avoidance; focus fire puts every weapon on the one target.
  orderAttack(civ, ids, target, opts = {}) {
    const units = (ids || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id && UNITS[u.type].atk > 0);
    if (!units.length) return null;
    const plan = opts.focus || units.length <= 2 ? null : assignTargets(this, civ, units, target);
    const tt = target.kind === 'unit' ? this.units.get(target.id)?.tile : this.buildings.get(target.id)?.tile;
    // a group closes in as a line facing the target instead of trickling down one road
    let approach = null;
    if (units.length >= 4 && tt >= 0) {
      const mid = centroid(units.map((u) => u.tile));
      const tq = tt % W, tr = (tt / W) | 0, cq = tq - dqWrap(mid % W, tq), cr = (mid / W) | 0;
      const d = Math.hypot(tq - cq, tr - cr) || 1, stand = Math.min(d, 2.5);
      const aq = Math.round(tq - ((tq - cq) / d) * stand), ar = Math.max(0, Math.min(H - 1, Math.round(tr - ((tr - cr) / d) * stand)));
      const at = hexIdx(aq, ar);
      if (dist(at, tt) < d) approach = formationSlots(this, civ, units, at, 'line');
    }
    for (const u of units) {
      u.order = { kind: 'attack', target: plan?.get(u.id) || target, focus: !!opts.focus, resume: units.length > 2 && tt >= 0 ? tt : undefined, slot: approach?.get(u.id) ?? -1 };
      u.field = false; u.repathAt = 0; u.queue = [];
      if (opts.auth) u.auth = opts.auth;
      u.retreating = false;
    }
    return { reply: { t: 'ack', order: { assigned: plan ? new Set([...plan.values()].map((x) => x.id)).size : 1 } } };
  }

  // Fall back toward the nearest supplied friendly city (or a given hex), firing only in passing.
  orderWithdraw(civ, ids, tile) {
    const units = (ids || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id);
    if (!units.length) return null;
    let dest = tile;
    if (!(dest >= 0)) {
      const c = centroid(units.map((u) => u.tile));
      dest = this.nearestCityTile(civ.id, c);
    }
    if (!(dest >= 0)) return { error: 'nowhere to fall back to' };
    return this.orderMove(civ, units.map((u) => u.id), dest, false, 'column', { withdraw: true, auth: 'player' });
  }

  clearPass(civ, t) {
    const w = this.world;
    if (w.terr[t] !== T.PEAK) return { error: 'only impassable peaks can be cleared' };
    if (!civ.techs.has('civil_engineering')) return { error: 'requires Civil Engineering' };
    const eng = [...this.units.values()].some((u) => u.owner === civ.id && UNITS[u.type].engineer && dist(u.tile, t) <= 1);
    if (!eng && !civ.supply[t] && !disk(t, 1).some((n) => civ.supply[n])) return { error: 'needs an engineer team next to it, or your supply network' };
    const cost = { materials: 120, munitions: 40 };
    if (!this.canAfford(civ, cost)) return { error: 'cannot afford (120 materials, 40 munitions)' };
    this.pay(civ, cost);
    w.elev[t] = 0.6; w.stab[t] = Math.max(0.1, w.stab[t] - 0.1); w.classify(t); w.touch(t);
    this.notify(civ.id, 'Engineers have blasted a passage through the peaks.', { kind: 'build', tile: t });
    return null;
  }
}

export function packBits(arr) {
  const out = Buffer.alloc(Math.ceil(arr.length / 8));
  for (let i = 0; i < arr.length; i++) if (arr[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}
function roundObj(o, d = 0) { const r = {}; for (const k in o) r[k] = +(+o[k]).toFixed(d); return r; }
void ROAD_TYPES;
