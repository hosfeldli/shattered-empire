import { LEGACY_RULESET, nativeRules, validateRuleset, normalizeNativeCiv, nativeDefinitions, tempo, movementRate, techEnabled, timedWorks, REMOVED_COMMANDS } from './rulesets.js';
import { rivalIntel } from './rivals.js';
// Authoritative match simulation. One Game per match; clients only send intents.
import { Scheduler } from './scheduler.js';
import { techFx, IMPORT_PRICE, IMPORT_PER_MARKET, REFIT, N, W, H, T, DT, TERRAIN, BUILDINGS, UNITS, TECHS, GOVS, POLICIES, FOCI, AGES, CIV_COLORS, CIV_NAMES, REBEL, GAME_DEFS, GOVERNOR_SPECS, ROAD_TYPES, RES, isWater, DIFFICULTY } from './constants.js';
import { NB, disk, dist, centroid, dqWrap, stamp, idx as hexIdx } from './hex.js';
import { recruitBlock, reserve, commitTraining, releaseTraining, enlistExisting, demobilize, labor, recruitable } from './population.js';
import { World } from './world.js';
import { mulberry32 } from './rng.js';
import { Geology, describeTile } from './geology.js';
import { tileRecord } from './render.js';
import { findPath, findRoadRoute, flowField, formationSlots, pathFail, PATH_FAIL, PATH_FAIL_CODES } from './path.js';
import { RoadNet } from './roads.js';
import { economyStep, recomputeTerritory, recomputeTradeNetwork, migrationStep, allocationFor } from './economy.js';
import { MODES, PRIORITY, CATEGORIES, defaultWorkforce } from './workforce.js';
import { missilesInit, missilesStep, siloStep, startMissile, launchMissile, interceptors, interceptOdds, inventory, missilesSnapshot, MISSILE } from './missiles.js';
import { BRIDGE_CLASSES, planBridge } from './bridges.js';
import { Weather } from './weather.js';
import { upgradable, upgradeCost as levelUpgradeCost, upgradeProblem, upgradeTime, jobSlots, outMul, MAX_LEVEL, LEVEL_JOBS, LEVEL_OUT, LEVEL_AGE, CITY_TIERS } from './levels.js';
import { cityState, CITY_STATES, rebuildSettlement, rebuildProblem, cityDiagnostics, REBUILD_COST } from './cities.js';
import { unitsStep, buildingCombatStep, recomputeSupply, supplyStep, spawnUnit, damageUnit, damageBuilding, resolveDeadlocks, shieldStep } from './military.js';
import { Diplomacy } from './diplomacy.js';
import { AI, TECH_PREF, resolvePersonality } from './ai.js';
import { autonomyStep } from './autonomy.js';
import { RebelAI } from './rebels.js';
import { defaultGovernor, governorStep, autoColonists, migrateGovernor, answerProposal, LEVELS } from './governor.js';
import { GOALS, readiness, candidates } from './planner.js';
import { armyCommand, armiesStep, armySummary } from './armies.js';
import { recoveryStep } from './recovery.js';
import { projectilesStep, moraleStep, eventsFor, CS, vetLevel, testImpact, fireUnit, detonate } from './combat.js';
import { airStep, airMission, autoSelect, onAircraftBuilt, onBuildingLost, airSnapshot, stateCode, canFly, MISSIONS, AIR_STATES } from './airOperations.js';
import { canHit } from './military.js';
import { bfInit, battlefieldStep, battlefieldSnapshot, concealBySmoke, rememberBattlefield } from './battlefield.js';
import { battlesStep, battlesFor, assignTargets } from './battles.js';
import { runScenario, spawnGroup, clearForces, SCENARIOS } from './sandbox.js';
import { rebuildEntering } from './tacticalOccupancy.js';
import { lInit, supplyRun, cancelRun, logisticsStep, policyStep, convoysFor, cachesFor, PRESETS, cargoTotal } from './logistics.js';
import { deployOrder, formationCommand, formationsStep, formationsSnapshot, detach } from './formations.js';
import { book, bookCost, ledgerSnapshot, LEDGER_CATS } from './ledger.js';
import { resourcesReport, shortageAlerts, SITE_HINT, PLACE_INFO, RESOURCE_INFO } from './resources.js';
import { fwInit, clearFieldworks, fieldworksStep, urbanStep, buildOver, fieldworksFor, FIELDWORKS, planTrench, commitTrench, cancelTrenchProject, trenchProjectsFor } from './fieldworks.js';

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
    { name: 'units', fn: () => { unitsStep(g, DT); resolveDeadlocks(g); }, budget: 15 },
    { name: 'projectiles', fn: () => projectilesStep(g), budget: 3 },
    { name: 'air', every: 2, fn: () => airStep(g, DT * 2), budget: 3 },
    { name: 'missiles', fn: () => missilesStep(g, DT), budget: 1 },
    { name: 'silos', every: 10, phase: 3, fn: () => siloStep(g, 1), budget: 1 },
    { name: 'morale', every: 5, fn: () => moraleStep(g, 0.5), budget: 3 },
    { name: 'battlefield', every: 10, phase: 5, fn: () => { battlefieldStep(g, 1); battlesStep(g); }, budget: 4 },
    { name: 'buildingCombat', every: 5, fn: () => buildingCombatStep(g, 0.5), budget: 3 },
    { name: 'construction', every: 10, fn: () => { g.constructionStep(1); g.roads.step(g, 1); }, budget: 5 },
    { name: 'economy', every: 10, phase: 8, fn: () => { economyStep(g, 1); supplyStep(g, 1); g.researchStep(1); }, budget: 20 },
    { name: 'geology', every: 10, phase: 6, fn: () => { g.geology.step(1); for (const tile of g.world.wiped) g.roads.obliterate(tile); g.world.wiped.clear(); }, budget: 5 },
    { name: 'weather', every: 10, phase: 1, fn: () => g.weather.step(1, (g.time / 600) % 1), budget: 2 },
    { name: 'diplomacy', every: 10, phase: 4, fn: () => g.diplomacy.step(1), budget: 2 },
    { name: 'governors', every: 10, phase: 2, fn: () => governorStep(g, 1), budget: 10 },
    { name: 'victory', every: 10, fn: () => g.checkVictory(), budget: 2 },
    { name: 'formations', every: 10, phase: 3, fn: () => formationsStep(g), budget: 4 },
    { name: 'autonomy', every: 20, phase: 11, fn: () => autonomyStep(g), budget: 4 },
    { name: 'fieldworks', every: 10, phase: 7, fn: () => fieldworksStep(g, 1), budget: 4 },
    { name: 'logistics', every: 10, phase: 9, fn: () => { logisticsStep(g, 1); if ((g.policyT = (g.policyT || 0) + 1) % 5 === 0) policyStep(g); }, budget: 5 },
    { name: 'shortages', every: 50, phase: 31, fn: () => { for (const civ of g.civs) if (civ.human && civ.alive) shortageAlerts(g, civ); }, budget: 4 },
    { name: 'urban', every: 30, phase: 23, fn: () => urbanStep(g), budget: 4 },
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

// research helpers
function researchReady(civ, k) { const t = TECHS[k]; return techEnabled(civ, k) && !!t && !civ.techs.has(k) && t.age <= civ.age && t.req.every((r) => civ.techs.has(r)); }
function researchChain(civ, k) { const chain = []; const add = (x) => { if (civ.techs.has(x) || chain.includes(x)) return; for (const r of TECHS[x].req) add(r); chain.push(x); }; add(k); return chain; }
const prereqCache = new Map();
function researchPrereqsAll(k) { let s = prereqCache.get(k); if (s) return s; s = new Set(); const walk = (x) => { for (const r of TECHS[x].req) if (!s.has(r)) { s.add(r); walk(r); } }; walk(k); prereqCache.set(k, s); return s; }

const bestBridgeClass = (civ) => (civ.techs.has('civil_engineering') ? 'road' : 'timber');

// players' automatic research: the builder's economy-first order with arms interleaved early
const AUTO_TECH_ORDER = (() => {
  const out = [];
  const a = TECH_PREF.builder, b = TECH_PREF.warlord;
  for (let i = 0; i < Math.max(a.length, b.length); i++) for (const k of [a[i], b[i]]) if (k && !out.includes(k)) out.push(k);
  return out;
})();

export class Game {
  constructor({ id, seed = (Math.random() * 2 ** 31) | 0, slots, rebels = true, restore = null, style = null, ruleset = LEGACY_RULESET }) {
    this.id = id;
    this.ruleset = validateRuleset(ruleset);
    this.seed = seed;
    this.worldStyle = style || null;
    this.slotsDef = slots.map((s) => ({ human: !!s.human, name: s.name, leader: s.leader, personality: s.personality, difficulty: s.difficulty, fairPlay: s.fairPlay }));
    this.defs = { ...GAME_DEFS, RESOURCE_INFO, PLACE_INFO, SITE_HINT, LEDGER_CATS, AIR_STATES, MISSIONS, PATH_FAIL, PATH_FAIL_CODES, LEVELS: { max: MAX_LEVEL, jobs: LEVEL_JOBS, out: LEVEL_OUT, age: LEVEL_AGE, tiers: CITY_TIERS }, CITY_STATES, REBUILD_COST, BRIDGE_CLASSES, MISSILE: { cost: MISSILE.cost, build: MISSILE.build, store: MISSILE.store, range: MISSILE.range } };
    if (nativeRules(this)) this.defs = nativeDefinitions(this.defs, this.ruleset);
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.world = new World(seed, { style });
    this.world.generate(slots.length);
    this.roads = new RoadNet(this.world);
    this.time = 0; this.tickN = 0; this.nextId = 1; this.stats = { pathFail: 0, deadlocks: 0 };
    this.units = new Map(); this.buildings = new Map(); this.cities = new Map();
    this.ruins = new Map();                 // tile -> { type, owner, name, time }
    this.tileB = new Int32Array(N).fill(-1);
    this.tileUnits = new Map(); this.tileLoad = new Map();
    this.navVersion = 1; this.navDirty = false;
    // combat: sequenced event stream, projectiles in flight, damage already on its way, battles
    this.events = []; this.eventSeq = 0; this.projectiles = new Map(); this.pending = new Map(); this.assigned = new Map(); this.battles = []; this.nextBattle = 1;
    bfInit(this); missilesInit(this);
    this.formations = new Map();
    fwInit(this); lInit(this);
    this.over = false; this.winner = null; this.log = []; this.outbox = [];
    this.cityNameIdx = 0;
    this.civs = slots.map((s, i) => this.makeCiv(i, s));
    if (rebels) { const r = this.makeCiv(this.civs.length, { human: false, name: REBEL.name }); r.isRebel = true; r.color = REBEL.color; r.personality = 'rebel'; this.civs.push(r); }
    for (const civ of this.civs) { civ.ruleset = this.ruleset; if (nativeRules(this)) normalizeNativeCiv(civ); }
    this.diplomacy = new Diplomacy(this);
    this.geology = new Geology(this);
    this.weather = new Weather(this.world, this.seed ?? 1);
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
      human: !!slot.human, isAI: !slot.human, isRebel: false, personality: resolvePersonality(slot.personality,id), difficulty: DIFFICULTY[slot.difficulty] ? slot.difficulty : 'normal', fairPlay: slot.fairPlay !== false, diffProfile: 'v2',
      alive: true, connected: false, token: null,
      res: { food: 220, materials: 260, ore: 0, steel: 20, fuel: 0, electronics: 0, munitions: 20, credits: 150 },
      rates: {}, researchRate: 0, researching: null, progress: 0, techProgress: {}, researchGoal: null, queue: [], techs: new Set(),
      age: 0, advancing: 0, gov: 'council', govCooldown: 0, policies: new Set(), tax: 1, focus: 'balanced',
      weariness: 0, casualties: 0, kills: 0, popTotal: 0, powerGen: 0, powerUse: 0, powerRatio: 1,
      knownVer: new Uint16Array(N), knownOwner: new Int8Array(N).fill(-2), visible: new Uint8Array(N), detect: new Uint8Array(N), supply: new Uint8Array(N), airSupply: new Uint8Array(N),
      explored: new Uint8Array(N), lastOwner: new Int8Array(N).fill(-2), knownCities: new Map(), battlefieldMemory: new Map(), intel: {},
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
  cityOf(civ) { return [...this.cities.values()].filter((c) => c.owner === civ.id); }
  capital(civ) { return this.cityOf(civ).sort((a, b) => (b.capital ? 1 : 0) - (a.capital ? 1 : 0) || a.id - b.id)[0]; }
  // cached per second: a full-map scan, asked many times per economy step
  civHasResource(civ, r) {
    const c = this._resCache || (this._resCache = new Map()), k = civ.id * 32 + r, sec = Math.floor(this.tickN / 10);
    const hit = c.get(k); if (hit && hit.sec === sec) return hit.v;
    const w = this.world; let v = false; for (let i = 0; i < N; i++) if (w.owner[i] === civ.id && w.res[i] === r) { v = true; break; }
    c.set(k, { sec, v }); return v;
  }
  damageUnit(u, amount, attacker, cause) { damageUnit(this, u, amount, attacker, cause); }
  // air operations hooks (kept here so airOperations.js does not import the combat stack)
  fireForAir(u, tg, tt) { return fireUnit(this, u, tg, tt); }
  detonateForAir(u, tt) { detonate(this, u, tt); }
  canHitUnit(u, e) { return canHit(UNITS[u.type], e); }
  onBaseLost(b) { onBuildingLost(this, b); }
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
    }
  }
  onTileFlooded(t) {
    const b = this.buildingAtTile(t);
    if (b && b.type !== 'port') damageBuilding(this, b, 1e9, null, 'flood');
    for (const u of this.unitsAt(t)) { const civ = this.civs[u.owner]; if (!UNITS[u.type].air && !civ.techs.has('seafaring')) damageUnit(this, u, 1e9, null, 'flood'); }
    this.roads.obliterate(t);
    this.ruins.delete(t);
  }
  addRuin(tile, type, owner, name) { if (isWater(this.world.terr[tile])) return; this.ruins.set(tile, { type, owner, name, time: this.time }); this.world.touch(tile); }

  // ----------------------------------------------------------------- cities & buildings
  foundCity(civ, tile, pop = 3, capital = false) {
    const id = this.id_();
    const name = CITY_NAMES[this.cityNameIdx++ % CITY_NAMES.length] + (this.cityNameIdx > CITY_NAMES.length ? ' II' : '');
    const city = { id, owner: civ.id, tile, name, pop, housing: 8, stability: 60, disaster: 0, occupied: 0, unrestT: 0, founded: this.time, capital, foodShort: false, jobs: {}, unemployed: 0, radius: 3,
      isolated: !capital, freight: capital ? Infinity : 0, stock: {}, tradeConnected: false,
      governor: defaultGovernor(civ.isAI) };
    // every city runs itself by default (the player can step in, or turn its governor down, at any time)
    if (!civ.isAI) { city.governor.enabled = true; city.governor.level = 'autonomous'; }
    this.cities.set(id, city);
    this.ruins.delete(tile);
    const b = this.makeBuilding(civ, 'town', tile, true);
    b.cityId = id; city.buildingId = b.id;
    return city;
  }

  makeBuilding(civ, type, tile, done) {
    const def = BUILDINGS[type];
    const b = { id: this.id_(), owner: civ.id, type, tile, hp: done ? def.hp : def.hp * 0.1, maxHp: def.hp, done: !!done, progress: done ? 1 : 0, queue: [], staffed: 0, cityId: -1, cooldown: 0, rally: -1, active: false, placedAt: this.time,
      state: done ? 'operational' : 'construction', funded: true, fire: 0, crew: 0, qn: done ? 0 : (civ.buildSeq = (civ.buildSeq || 0) + 1) };
    this.buildings.set(b.id, b);
    this.tileB[tile] = b.id;
    this.ruins.delete(tile);
    buildOver(this, tile);
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
    if (w.river[t] || isWater(ter) || !Number.isFinite(TERRAIN[ter].move) || ter === T.LAVA) return false;
    if (def.anywhere) { if (w.owner[t] !== civ.id && !civ.supply[t]) return false; if (w.owner[t] >= 0 && w.owner[t] !== civ.id) return false; }
    else if (w.owner[t] !== civ.id) return false;
    if (def.wonder && [...this.buildings.values()].some((b) => b.type === 'wonder' && b.owner === civ.id)) return false;
    if (type === 'house') {
      const cid = this.nearestCityId(civ.id, t);
      let n = 0; for (const b of this.buildings.values()) if (b.type === 'house' && b.cityId === cid) n++;
      if (n >= this.maxHouses(civ)) return false;
    }
    if (!this.terrainOk(def, t)) return false;
    if (!ignoreCost && !this.canAfford(civ, this.buildingCost(civ, type, t), t)) return false;
    return true;
  }

  // the building's terrain or deposit rule (shared by placement, previews and resource advice)
  terrainOk(def, t) {
    const w = this.world, ter = w.terr[t];
    switch (def.place) {
      case 'farm': return [T.GRASS, T.PLAINS, T.ASH, T.MARSH, T.TUNDRA, T.HILLS, T.FOREST].includes(ter) || (ter === T.DESERT && Array.from({ length: 6 }, (_, d) => NB[t * 6 + d]).some((n) => n >= 0 && w.river[n])); // irrigated desert farms sit beside a river
      case 'forest': return ter === T.FOREST;
      case 'quarry': return ter === T.HILLS || ter === T.MOUNTAIN || w.res[t] === RES.STONE;
      case 'mine': return [RES.IRON, RES.COAL].includes(w.res[t]) || ((ter === T.HILLS || ter === T.MOUNTAIN) && !w.res[t]);   // a shaft into bare rock yields less (see economy)
      case 'oil': return w.res[t] === RES.OIL;
      case 'ruins': return w.res[t] === RES.RUINS;
      case 'coast': { for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && isWater(w.terr[n]) && !w.lake[n]) return true; } return false; }
      case 'flat': return ter !== T.MOUNTAIN && ter !== T.MARSH;
      default: return true;
    }
  }
  buildingCost(civ, type, tile) {
    const c = { ...BUILDINGS[type].cost };
    let m = 1;
    if ((type === 'bunker' || type === 'fort') && (!nativeRules(this) && civ.policies.has('fortification'))) m *= 0.75;
    if (tile != null && this.ruins.get(tile)?.type === type) m *= 0.5;   // rebuilding from ruins
    if (m !== 1) for (const k in c) c[k] = Math.round(c[k] * m);
    return c;
  }
  upgradeCost(civ, b) { const lv = b.level || 1; if (b.type !== 'house') return levelUpgradeCost(b.type, lv); return civ.age >= 1 ? { materials: 55 * lv, steel: 12 * lv } : { materials: 60 * lv }; }
  // a refit pays the difference in equipment; a conversion pays most of a new unit
  refitCost(civ, from, to, conv) {
    const a = this.unitCost(civ, to), b = this.unitCost(civ, from), out = {};
    for (const [k, v] of Object.entries(a)) { const c = conv ? v * 0.75 : Math.max(v * 0.25, v - (b[k] || 0) * 0.6); if (c > 0) out[k] = Math.ceil(c); }
    return out;
  }
  unitCost(civ, type) {
    const c = { ...UNITS[type].cost };
    if ((!nativeRules(this) && civ.policies.has('conscription'))) { if (c.food) c.food = Math.round(c.food * 0.7); if (c.credits) c.credits = Math.round(c.credits * 0.7); }
    if (!nativeRules(this) && civ.gov === 'junta' && !UNITS[type].civilian) for (const k in c) c[k] = Math.round(c[k] * 0.8);
    if (type === 'colonist' && (!nativeRules(this) && civ.policies.has('homesteading'))) for (const k in c) c[k] = Math.round(c[k] * 0.6);
    // every city already held makes the next settlement dearer: expansion has to be earned
    if (type === 'colonist') { const n = this.cityOf(civ).length; const m = 1 + 0.45 * Math.max(0, n - 1); for (const k in c) c[k] = Math.round(c[k] * m); }
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
  // cat: the ledger category this spending is booked under (local stock of a cut-off city is not national)
  pay(civ, cost, tile, cat = 'construction') {
    const local = this.poolAt(civ, tile);
    for (const k in cost) { if (local && k !== 'credits') local[k] = (local[k] || 0) - cost[k]; else { civ.res[k] -= cost[k]; book(civ, cat, k, -cost[k]); } }
  }
  // goods returned to the national stockpile
  credit(civ, goods, cat = 'refunds') { for (const [k, v] of Object.entries(goods)) { if (!v) continue; civ.res[k] = (civ.res[k] || 0) + v; book(civ, cat, k, v); } }

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
    if (b.queue.length >= 8) return 'queue full';
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

  // which way to face a new trench: toward the nearest known threat
  threatFacing(civ, tile) {
    const xy = (t) => { const r = (t / W) | 0, q = t % W; return [Math.sqrt(3) * (q + 0.5 * (r & 1)), 1.5 * r]; };
    let best = -1, bd = Infinity;
    for (const u of this.units.values()) if (this.hostile(civ.id, u.owner) && civ.visible[u.tile]) { const d = dist(u.tile, tile); if (d < bd) { bd = d; best = u.tile; } }
    if (best < 0) for (const k of civ.knownCities.values()) if (this.hostile(civ.id, k.owner)) { const d = dist(k.tile, tile); if (d < bd) { bd = d; best = k.tile; } }
    if (best < 0) { const cap = this.capital(civ); if (cap && cap.tile !== tile) { const [ax, ay] = xy(cap.tile), [bx, by] = xy(tile); const l = Math.hypot(bx - ax, by - ay) || 1; return [(bx - ax) / l, (by - ay) / l]; } return [0, -1]; }
    const [ax, ay] = xy(tile); let [bx, by] = xy(best); const P = Math.sqrt(3) * W; bx += Math.round((ax - bx) / P) * P;
    const l = Math.hypot(bx - ax, by - ay) || 1; return [(bx - ax) / l, (by - ay) / l];
  }

  areaImpactForTest(owner, tile, wk) { this.rebuildTileUnits(); testImpact(this, owner, tile, wk); }

  // a queued deployment comes up for one of its units: run it once for the whole group
  runQueuedDeploy(u, d) {
    this.deploysDone = this.deploysDone || new Set();
    if (this.deploysDone.has(d.key)) return;
    this.deploysDone.add(d.key); if (this.deploysDone.size > 200) this.deploysDone.delete(this.deploysDone.values().next().value);
    for (const id of d.units) { const o = this.units.get(id); if (o && o.queue) o.queue = o.queue.filter((q) => !(q.deploy && q.deploy.key === d.key)); }
    deployOrder(this, this.civs[u.owner], d, u.auth || '');
  }

  rebuildTileUnits() {
    this.tileUnits.clear(); this.tileLoad.clear(); this.knownCache?.clear();
    for (const u of this.units.values()) {
      let a = this.tileUnits.get(u.tile); if (!a) this.tileUnits.set(u.tile, a = []); a.push(u.id);
      if (!UNITS[u.type].air) {
        this.tileLoad.set(u.tile, (this.tileLoad.get(u.tile) || 0) + 1);
        if (u.next >= 0 && u.prog > 0) this.tileLoad.set(u.next, (this.tileLoad.get(u.next) || 0) + 1);
      }
    }
    rebuildEntering(this);
  }


  constructionStep(dt) {
    shieldStep(this, dt);
    for (const [t, r] of this.ruins) {
      if (r.clearing && this.time >= r.clearAt) { this.ruins.delete(t); this.world.touch(t); continue; }
      if (r.smoke > 0) { r.smoke -= dt; if (r.smoke <= 0) this.world.touch(t); }
    }
    // The construction queue. Sites are built in the order they were ordered (qn; "build next" moves
    // one to the front). Funding: an unfunded site takes its money in queue order, and a later site
    // may only use what is left after every earlier waiting site's cost is set aside, so a cheap
    // order never starves an expensive one placed before it. Building: each city's crews work on
    // a few sites at a time (2, +1 per city tier) and finish them quickly; the rest wait their turn.
    const unfunded = new Map();
    for (const b of this.buildings.values()) if (!b.done && !b.funded) { const a = unfunded.get(b.owner) || []; a.push(b); unfunded.set(b.owner, a); }
    for (const [owner, list] of unfunded) {
      const civ = this.civs[owner], held = {};
      list.sort((a, b) => (a.qn ?? a.id) - (b.qn ?? b.id));
      for (const b of list) {
        const need = { ...b.cost }; for (const k in held) need[k] = (need[k] || 0) + held[k];
        if (this.canAfford(civ, need, b.tile)) { this.pay(civ, b.cost, b.tile); b.funded = true; this.refreshState(b); }
        else for (const k in b.cost) held[k] = (held[k] || 0) + b.cost[k];
      }
    }
    const sites = new Map();
    for (const b of this.buildings.values()) if (!b.done && b.funded) { const a = sites.get(b.cityId) || []; a.push(b); sites.set(b.cityId, a); }
    const engineers = [...this.units.values()].filter((u) => UNITS[u.type].engineer);
    for (const [cityId, list] of sites) {
      const city = this.cities.get(cityId);
      const crews = 1.4 + (city ? Math.min(3, city.unemployed * 0.25) : 0);
      const slots = Math.min(5, 2 + (city?.tier || 0));
      list.sort((a, b) => (a.qn ?? a.id) - (b.qn ?? b.id));
      const active = Math.min(slots, list.length);
      list.forEach((b, i) => {
        const eng = engineers.filter((u) => u.owner === b.owner && dist(u.tile, b.tile) <= 2).length;
        // engineers on the spot always get a site moving, even one still waiting its turn
        b.waiting = i >= slots && !eng ? i - slots + 1 : 0;
        b.crew = b.waiting ? 0 : Math.max(0.6, Math.min(2.2, (i < slots ? crews / active : 0) + eng * 0.75));
      });
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
          const q = b.queue[0]; q.left -= dt * tempo(this, 'training') * (b.state === 'damaged' ? 0.5 : 1);
          if (q.left <= 0) {
            b.queue.shift();
            const spot = this.freeTilesNear(b.tile, 2)[0] ?? b.tile;
            const u = spawnUnit(this, civ, q.unit, UNITS[q.unit].air ? b.tile : spot);
            if (UNITS[q.unit].air) onAircraftBuilt(this, u, b);
            commitTraining(this, this.cities.get(b.cityId), q, u);
            if (q.unit === 'colonist' && (q.auto || civ.isAI === false && this.cities.get(b.cityId)?.governor?.enabled && this.cities.get(b.cityId)?.governor?.perms.settle)) u.auto = true;
            if (q.army && civ.armies?.has(q.army)) civ.armies.get(q.army).units.push(u.id);
            // new units gather round the rally point (each to the next free hex), not all onto one
            if (b.rally >= 0) { const ring = [b.rally, ...disk(b.rally, 1).filter((t) => t !== b.rally && Number.isFinite(TERRAIN[this.world.terr[t]].move) && !isWater(this.world.terr[t]))]; b.rallyN = ((b.rallyN || 0) + 1) % ring.length; this.orderMove(civ, [u.id], ring[b.rallyN], u.stance === 'aggressive'); }
            this.notify(civ.id, `${UNITS[q.unit].name} ready.`, { kind: 'unit', tile: spot, quiet: true, level: 'info' });
          }
        }
        // repeat production: only when affordable twice over and manpower is spare (never starves the city)
        if (b.repeat && !b.queue.length && this.tickN % 10 === 0) {
          const cost = this.unitCost(civ, b.repeat), dbl = {}; for (const [k, v] of Object.entries(cost)) dbl[k] = v * 2;
          const city = this.cities.get(b.cityId), men = UNITS[b.repeat].pop || 0;
          if (this.canAfford(civ, dbl, b.tile) && (!men || !city || recruitable(civ, city) >= men * 2) && !this.canTrainBatch(civ, b, b.repeat)) this.trainBatch(civ, [b.id], b.repeat, 1, {});
        }
        if (b.works) this.worksStep(civ, b, dt, engineers);
        // natural upkeep only keeps sound buildings sound; damaged ones need repair (governor, engineers, or you)
        if (b.hp < b.maxHp && b.hp >= b.maxHp * 0.5 && !b.fire && this.time - (b.lastHit || -99) > 15) b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.002 * dt);
        this.refreshState(b);
        continue;
      }
      if (!b.funded || b.waiting) continue;          // awaiting funds, or waiting its turn in the queue
      const def = BUILDINGS[b.type];
      const rate = tempo(this, 'construction') * (b.crew || 1) * ((!nativeRules(this) && civ.policies.has('public_works')) ? 1.15 : 1) * (1 + (techFx(civ).build || 0));
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
    if (b.works) return { error: b.works.k === 'repair' ? 'Repairs are already under way' : 'Works are already under way here' };
    const cost = { materials: Math.ceil(10 + (BUILDINGS[b.type].cost.materials || 40) * 0.2) };
    if (!this.canAfford(civ, cost, b.tile)) return { error: `Repair needs ${cost.materials} materials` };
    this.pay(civ, cost, b.tile, 'maintenance');
    if (timedWorks(this)) {
      // Crews put out fires at once; the structure itself is rebuilt over time.
      b.fire = 0;
      this.startWorks(b, 'repair', cost, this.repairSeconds(b), { heal: b.maxHp * 0.4 });
      this.refreshState(b); this.world.touch(b.tile);
      this.history(civ, by, `Began repairing ${BUILDINGS[b.type].name}`);
      return null;
    }
    b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.4); b.fire = 0; this.refreshState(b); this.world.touch(b.tile);
    this.history(civ, by, `Repaired ${BUILDINGS[b.type].name}`);
    return null;
  }

  // Timed works (native-v4): upgrades and repairs are projects paid up front that take time.
  // Engineers within two hexes speed them up; fire on the site halts work until it is quiet.
  // A level only takes effect when its works complete, so no bonus arrives early.
  repairSeconds(b) { return Math.max(10, Math.round((BUILDINGS[b.type].time || 20) * 0.35)); }
  worksSeconds(b) { return b.type === 'house' ? Math.round((BUILDINGS.house.time || 20) * (0.9 + 0.5 * (b.level || 1))) : upgradeTime(b.type, b.level || 1); }
  startWorks(b, kind, cost, seconds, extra = {}) {
    b.works = { k: kind, left: seconds, total: seconds, cost: { ...cost }, ...extra };
    if (kind === 'upgrade') b.upgrading = true;
  }
  worksStep(civ, b, dt, engineers) {
    const w = b.works;
    if (this.time - (b.lastHit || -99) < 5) {
      if (!w.halt) this.notify(civ.id, `Works on the ${BUILDINGS[b.type].name} halted: the site is under fire.`, { kind: 'build', tile: b.tile, quiet: true, level: 'warning' });
      w.halt = 1; return;
    }
    w.halt = 0;
    const eng = engineers.filter((u) => u.owner === b.owner && dist(u.tile, b.tile) <= 2).length;
    const rate = tempo(this, 'construction') * (1 + 0.6 * Math.min(3, eng)) * (1 + (techFx(civ).build || 0));
    const step = Math.min(w.left, dt * rate);
    w.left -= step;
    if (w.k === 'repair') b.hp = Math.min(b.maxHp, b.hp + w.heal * step / w.total);
    w.rate = rate;
    if (w.left > 1e-6 && !(w.k === 'repair' && b.hp >= b.maxHp)) return;
    delete b.works; b.upgrading = false;
    if (w.k === 'repair') this.notify(civ.id, `${BUILDINGS[b.type].name} repaired.`, { kind: 'build', tile: b.tile, quiet: true, level: 'info' });
    if (w.k === 'upgrade') {
      this.applyLevel(b);
      this.notify(civ.id, `${BUILDINGS[b.type].name} upgraded to level ${b.level}.`, { kind: 'build', tile: b.tile, quiet: true, level: 'info' });
    }
    this.refreshState(b); this.world.touch(b.tile);
  }
  applyLevel(b) {
    const lv = b.level || 1, base = BUILDINGS[b.type].hp, k = b.type === 'house' ? 0.5 : 0.4;
    b.level = lv + 1; b.maxHp = Math.round(base * (1 + k * lv)); b.hp = Math.min(b.maxHp, b.hp + base * k);
    b.upgradedAt = this.time;
  }
  cancelWorks(civ, b) {
    if (!b || b.owner !== civ.id || !b.works) return { error: 'No works to cancel here' };
    const w = b.works, refund = {};
    for (const [k, v] of Object.entries(w.cost || {})) refund[k] = Math.floor(v * 0.5 * (w.left / w.total));
    for (const [k, v] of Object.entries(refund)) if (v > 0) civ.res[k] = (civ.res[k] || 0) + v;
    delete b.works; b.upgrading = false; this.world.touch(b.tile);
    return { reply: { t: 'ack', cancelled: w.k, refund } };
  }

  // Research. Eras are not bought: a nation that knows enough of its era's technologies moves on
  // at once. What holds it back is materials: a later-era technology needs its goods (steel, fuel,
  // electronics) before work on it can begin. Nothing chosen: the next useful technology is picked
  // automatically (players' own picks and queue always come first). A project left waiting on goods
  // for a while gives way to one that can proceed, keeping its progress.
  researchStep(dt) {
    for (const civ of this.civs) {
      if (!civ.alive || civ.isRebel) continue;
      if (!nativeRules(this) && civ.govCooldown > 0) civ.govCooldown -= dt;
      this.checkEra(civ);
      const tp = civ.techProgress || (civ.techProgress = {});
      if (!civ.researching && civ.queue.length) {
        const nxt = civ.queue.find((k) => researchReady(civ, k));
        if (nxt) { civ.researching = nxt; civ.queue = civ.queue.filter((k) => k !== nxt); }
      }
      if (civ.human) this.autoTech(civ);
      if (!civ.researching) { civ.progress = 0; continue; }
      const k = civ.researching, tech = TECHS[k];
      const paid = civ.techPaid || (civ.techPaid = {});
      if (tech.goods && !paid[k]) {
        if (this.canAfford(civ, tech.goods)) { this.pay(civ, tech.goods, undefined, 'research'); paid[k] = 1; }
        else {
          civ.researchWait = k; civ.waitT = (civ.waitT || 0) + dt; civ.progress = tp[k] || 0;
          if (civ.waitT > 20) {
            const alt = Object.keys(TECHS).find((x) => x !== k && researchReady(civ, x) && (!TECHS[x].goods || paid[x] || this.canAfford(civ, TECHS[x].goods)));
            if (alt) { civ.queue = [k, ...civ.queue.filter((x) => x !== k && x !== alt)]; civ.researching = alt; civ.waitT = 0; civ.researchWait = null; }
          }
          continue;
        }
      }
      civ.researchWait = null; civ.waitT = 0;
      // progress belongs to the technology: switching away and back loses nothing
      tp[k] = (tp[k] || 0) + civ.researchRate * dt;
      civ.progress = tp[k];
      if (tp[k] >= tech.cost) {
        civ.techs.add(k);
        delete tp[k]; delete paid[k];
        this.notify(civ.id, `Research complete: ${tech.name}.`, { kind: 'tech', sound: 'research' });
        civ.researching = null; civ.progress = 0;
        civ.queue = civ.queue.filter((x) => !civ.techs.has(x));
        this.checkEra(civ);
      }
    }
  }
  checkEra(civ) {
    for (;;) {
      const next = this.defs.AGES[civ.age + 1]; if (!next) return;
      const have = [...civ.techs].filter((t) => techEnabled(civ, t) && TECHS[t].age === civ.age).length;
      if (have < next.techsNeeded) return;
      civ.age++; civ.advancing = 0; civ.saving = null;
      this.notify(-1, `${civ.name} has entered the ${AGES[civ.age].name} era!`, { kind: 'age' });
    }
  }

  // Players: when nothing is chosen, the next useful technology is picked (a balanced order of
  // economy and arms), preferring what the nation can supply the goods for right now.
  autoTech(civ) {
    if (civ.researching) return;
    const paid = civ.techPaid || {};
    const can = (k) => !TECHS[k].goods || paid[k] || this.canAfford(civ, TECHS[k].goods);
    const ready = AUTO_TECH_ORDER.filter((k) => TECHS[k] && researchReady(civ, k)).concat(Object.keys(TECHS).filter((k) => researchReady(civ, k) && !AUTO_TECH_ORDER.includes(k)));
    const pick = ready.find(can) || ready[0];
    if (pick) civ.researching = pick;
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
    // posture: what an AI nation is visibly doing (Expanding, Defending, Preparing…), never its plan
    return { id: c.id, name: c.name, alive: c.alive, cities: cities.length, pop: Math.round(pop), techs: c.techs.size, age: c.age, kills: c.kills, casualties: c.casualties, posture: c.ai && !c.isRebel ? c.posture : undefined,
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
      if (this.weather && this.weather.fogAt(u.tile) > 0.55) v = Math.max(1, v - 1);     // dense fog: one hex less
      stamp(o.v, u.tile, v);
      stamp(o.d, u.tile, def.cat === 'air' && def.civilian ? 4 : 2);
    }
    for (const b of this.buildings.values()) {
      const o = own[b.owner]; if (!o) continue;
      stamp(o.v, b.tile, (BUILDINGS[b.type].vision || 2) + (civs[b.owner].techs.has('networked_command') ? 1 : 0) + (b.upgraded ? 2 : 0));   // upgraded AA batteries see aircraft further out
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
      if (this.smoke.size) concealBySmoke(this, civ, vis, allies); else civ.smokeHide?.fill(0);
      if (this.sandboxReveal && civ.human) vis.fill(1);      // developer sandbox matches see the whole field
      rememberBattlefield(this, civ);
      this.rememberStructures(civ);
      const ex = civ.explored, lo = civ.lastOwner, seenOwners = new Set();
      // when each hex was last seen (in 4-second steps): explorers revisit what has gone unseen longest
      if (!civ.seenAt) Object.defineProperty(civ, 'seenAt', { value: new Uint16Array(N), writable: true, enumerable: false });   // not saved: rebuilt as the map is seen
      const sa = civ.seenAt, stamp = Math.min(65535, 1 + Math.floor(this.time / 4));
      for (let i = 0; i < N; i++) if (vis[i]) { ex[i] = 1; sa[i] = stamp; const o = w.owner[i]; lo[i] = o; if (o >= 0) seenOwners.add(o); }
      if (intel) { this.updateIntel(civ); this.diplomacy.checkContact(civ, seenOwners); }
    }
  }

  // Last-seen structures: each human viewer keeps a bounded, frozen record of foreign buildings
  // as they last appeared. Out of sight they are drawn from this memory without activity; any
  // capture, damage, upgrade or destruction is learned only when the ground is seen again.
  rememberStructures(civ) {
    if (!civ.human || !civ.alive) return;
    const vis = civ.visible;
    const mem = civ.seenB || (civ.seenB = new Map());
    for (const [id, r] of mem) {
      if (!vis[r.t]) continue;
      const b = this.buildings.get(id);
      if (!b || b.tile !== r.t || b.owner === civ.id || this.allied(civ.id, b.owner)) mem.delete(id);
    }
    for (const b of this.buildings.values()) {
      if (b.owner === civ.id || !vis[b.tile] || this.allied(civ.id, b.owner)) continue;
      const hp = Math.round((100 * b.hp) / b.maxHp), lv = b.level > 1 ? b.level : undefined, p = Math.round(b.progress * 100);
      const r = mem.get(b.id);
      if (r && r.o === b.owner && r.hp === hp && r.lv === lv && r.p === p && r.d === (b.done ? 1 : 0) && r.st === b.state) { r.ls = Math.round(this.time); continue; }
      mem.set(b.id, { id: b.id, o: b.owner, ty: b.type, t: b.tile, hp, d: b.done ? 1 : 0, p, st: b.state, lv, ti: b.type === 'town' && b.tier ? b.tier : undefined, ls: Math.round(this.time) });
    }
    if (mem.size > 4000) {
      const oldest = [...mem.values()].sort((a, b) => a.ls - b.ls).slice(0, mem.size - 4000);
      for (const r of oldest) mem.delete(r.id);
    }
  }

  // What a civilization actually knows about others: last-known cities and observed strength.
  updateIntel(civ) {
    const vis = civ.visible;
    for (const c of this.cities.values()) if (vis[c.tile]) civ.knownCities.set(c.id, { tile: c.tile, owner: c.owner, name: c.name, seen: this.time });
    for (const [id, k] of civ.knownCities) { if (!vis[k.tile]) continue; const c = this.cities.get(id); if (!c || c.tile !== k.tile) civ.knownCities.delete(id); }
    const seen = {};
    // what kinds of hostile forces have been seen (decaying memory; feeds AI counter-composition)
    const comp = civ.seenComp || (civ.seenComp = { inf: 0, armor: 0, art: 0, air: 0 });
    for (const k of Object.keys(comp)) comp[k] *= 0.999;
    for (const u of this.units.values()) {
      if (u.owner === civ.id || !vis[u.tile] || civ.smokeHide?.[u.tile] || !this.detects(civ.id, u)) continue;
      const d = UNITS[u.type]; if (d.civilian) continue;
      seen[u.owner] = (seen[u.owner] || 0) + (d.atk + d.def) * (u.hp / u.maxHp);
      if (this.hostile(civ.id, u.owner)) comp[d.air ? 'air' : d.cat === 'artillery' ? 'art' : d.move === 'infantry' ? 'inf' : 'armor'] += 0.02;
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

  // city lifecycle state for the wire (cached per city for 1 s: it scans nearby units)
  cityStateWire(c, own) {
    if (!c._cs || this.time - c._cs.at >= 1) { const s = cityState(this, c); c._cs = { at: this.time, cs: CITY_STATES.indexOf(s.state), why: s.why }; }
    return own ? { cs: c._cs.cs, csw: c._cs.why || undefined } : { cs: c._cs.cs };
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
      // land we knew as our own that changed hands is always sent, seen or not: a nation knows which
      // of its territory it has lost (otherwise a captured city's land stays drawn in our colour)
      const lost = k.knownOwner[i] === civ.id && w.owner[i] !== civ.id;
      if (!vis[i] && !(full && explored[i]) && !lost) continue;
      if (k.knownVer[i] !== w.ver[i] || k.knownOwner[i] !== w.owner[i] || (stabOK && k.knownStab !== true)) {
        k.knownVer[i] = w.ver[i]; k.knownOwner[i] = w.owner[i];
        tiles.push(tileRecord(w, i, stabOK, this.roads.packTile(i), this.ruins.has(i)));
      }
    }
    if (stabOK) k.knownStab = true;
    const units = [];
    for (const u of this.units.values()) {
      if (!view.god && u.owner !== civ.id && (!vis[u.tile] || civ.smokeHide?.[u.tile] || !this.detects(civ.id, u))) continue;   // smoke over our own land hides what is in it
      units.push([u.id, u.owner, u.type, u.tile, u.next ?? -1, Math.round(u.prog * 100), Math.round((100 * u.hp) / u.maxHp), Math.round(u.supply),
        (this.time - u.lastCombat < 1.5 ? 1 : 0) | (isWater(w.terr[u.tile]) && !UNITS[u.type].air && !this.roads.edgesOf(u.tile).some((e) => e.cond > 0) ? 2 : 0) | (u.outOfSupply ? 4 : 0) | (u.status === 'waiting' ? 8 : 0) | (u.status === 'blocked' ? 16 : 0) | (u.field ? 32 : 0),
        u.owner === civ.id || view.god ? u.stance : undefined,
        u.owner === civ.id || view.god ? u.cstat || 0 : undefined, u.owner === civ.id || view.god ? u.tgt || 0 : undefined,
        Math.round(u.supp || 0), u.owner === civ.id || view.god ? Math.round(u.morale ?? 100) : undefined,
        vetLevel(u), u.refitUntil > this.time ? Math.ceil(u.refitUntil - this.time) : 0,
        u.owner === civ.id || view.god ? u.formation || 0 : 0, u.detached ? 1 : 0,
        // aircraft: [state, fuel %, ammunition, mission, mission tile, servicing %] for the owner; everyone sees grounded or not
        u.air ? (u.owner === civ.id || view.god ? [stateCode(u.air.state), Math.round((100 * Math.max(0, u.air.fuel)) / UNITS[u.type].fuel), u.air.ammo, u.air.mission ? MISSIONS.indexOf(u.air.mission.kind) : -1, u.air.mission?.tile ?? -1, u.air.state === 'servicing' ? Math.round(100 * (1 - u.air.svcLeft / Math.max(1, u.air.svcTotal || 1))) : -1, u.air.mission?.radius || 0] : [u.grounded ? 0 : 2]) : undefined,
        // why the last order could not be carried out (own units, for 30 s)
        (u.owner === civ.id || view.god) && u.pathFail && this.time - u.pathFail.at < 30 ? PATH_FAIL_CODES.indexOf(u.pathFail.code) : -1]);
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
    // regional weather (whole map: the sky is seen from anywhere), sent when it changes
    if (this.weather && (full || k.wxVer !== this.weather.ver)) { k.wxVer = this.weather.ver; msg.wx = this.weather.snapshot(); }
    if (visB64) msg.vis = visB64;
    if (view.observer) msg.obs = { follow: civ.id, fog: !view.god, speed: this.speed ?? 1 };
    if (econ) {
      Object.assign(msg, this.econSnapshot(civ, view));
      msg.fw = fieldworksFor(this, civ, view.god ? vis : vis);
      // developed city districts (authoritative; drawn by the client, they also forbid trenches)
      if (full || k.urbanVer !== this.urbanVer) { k.urbanVer = this.urbanVer; const u = new Uint8Array(N); for (let i = 0; i < N; i++) u[i] = this.urban[i] && explored[i] ? 1 : 0; msg.urban = packBits(u).toString('base64'); }
    }
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
        st: b.state, f: b.fire > 0 ? 1 : 0, cr: b.done ? 0 : +(b.crew || 0).toFixed(2), qw: !b.done && b.waiting ? b.waiting : undefined, qn: own && !b.done ? b.qn ?? b.id : undefined,
        lv: b.level > 1 ? b.level : undefined, r: own && BUILDINGS[b.type].trains && b.rally >= 0 ? b.rally : undefined, pr: own && b.out && Object.keys(b.out).length ? Object.entries(b.out).filter(([, v]) => v > 0.005).map(([k, v]) => [k, +v.toFixed(2)]) : undefined, sh: BUILDINGS[b.type].shield && b.done ? Math.round((100 * (b.shield || 0)) / BUILDINGS[b.type].shield.cap) : undefined, ug: b.upgraded ? 1 : undefined, uc: own && b.done && upgradable(b.type) && (b.level || 1) < MAX_LEVEL ? levelUpgradeCost(b.type, b.level || 1) : undefined, ut: own && timedWorks(this) && b.done && !b.works && (b.type === 'house' ? (b.level || 1) < 3 : upgradable(b.type) && (b.level || 1) < MAX_LEVEL) ? Math.ceil(this.worksSeconds(b) / tempo(this, 'construction')) : undefined, rc: own && b.done && b.hp < b.maxHp && !b.works ? Math.ceil(10 + (BUILDINGS[b.type].cost.materials || 40) * 0.2) : undefined, rt: own && timedWorks(this) && b.done && b.hp < b.maxHp && !b.works ? Math.ceil(this.repairSeconds(b) / tempo(this, 'construction')) : undefined, ti: b.type === 'town' && b.tier ? b.tier : undefined, mi: own && BUILDINGS[b.type].silo ? b.missiles || 0 : undefined, mp: own && b.project ? Math.round(100 * (1 - b.project.left / b.project.total)) : undefined, na: b.noAmmo ? 1 : undefined, af: b.lastFire && this.time - b.lastFire < 1.5 ? b.aimAt : undefined, up: b.upgradedAt && this.time - b.upgradedAt < 3 ? 1 : undefined, wk: b.works ? [b.works.k === 'repair' ? 'r' : 'u', Math.round(100 * (1 - b.works.left / b.works.total)), b.works.halt ? 1 : 0, b.owner === civ.id && b.works.rate ? Math.ceil(b.works.left / b.works.rate) : -1] : undefined, ...(own ? { s: b.staffed, w: b.why || undefined, lk: b.lock ?? undefined, off: b.off ? 1 : undefined, tr: b.queue.length ? Math.max(0, Math.min(100, Math.round(100 * (1 - b.queue[0].left / Math.max(1, UNITS[b.queue[0].unit]?.time || 1))))) : undefined, q: b.queue.map((q) => [q.unit, Math.max(0, Math.round(q.left))]), c: b.cityId, r: b.rally, rp: b.repeat || undefined, ra: b.rallyArmy || undefined, gov: (this.cities.get(b.cityId)?.governor?.queue || []).includes(b.id) ? 1 : 0 } : {}) });
    }
    // remembered foreign structures out of sight: frozen, quiet, marked as memory
    if (!god && civ.seenB) for (const r of civ.seenB.values()) if (!vis[r.t]) buildings.push({ ...r, a: 0, f: 0, mem: 1 });
    const cities = [];
    for (const c of this.cities.values()) {
      if (c.owner !== civ.id && !vis[c.tile]) continue;
      const own = c.owner === civ.id || god;
      cities.push({ id: c.id, o: c.owner, n: c.name, t: c.tile, pop: +c.pop.toFixed(1), cap: c.capital ? 1 : 0, r: c.radius,
        dmg: this.cityDamage(c), ...this.cityStateWire(c, own), ti: c.tier || 0,
        ...(own ? { h: c.housing, st: Math.round(c.stability), jobs: c.jobs, un: Math.round(c.unemployed), fs: c.foodShort ? 1 : 0, dis: Math.round(c.disaster), occ: Math.round(c.occupied), unrest: c.stability < 20 ? 1 : 0, trade: c.tradeConnected ? 1 : 0,
          mil: Math.round(c.mil || 0), rsv: c.reserved || 0, lab: labor(c), rec: recruitable(civ.id === c.owner ? civ : this.civs[c.owner], c), gr: +((c.growth || 0) * 60).toFixed(1), recov: c.recovering ? 1 : 0, ua: c.unassigned || 0, mig: +(c.inMig || 0).toFixed(1), fw: c.foodWorkers || 0, wf: c.wf || null, back: c.returning ? 1 : 0,
          iso: c.isolated ? 1 : 0, fr: c.freight === Infinity ? -1 : +(c.freight || 0).toFixed(1), stock: roundObj(c.stock || {}), ship: +(c.shipped || 0).toFixed(1),
          gov: c.governor ? { enabled: c.governor.enabled, level: c.governor.level || (c.governor.enabled ? 'autonomous' : 'off'), goal: c.governor.goal || 'none', budget: c.governor.budget ?? 0.15, emergency: c.governor.emergency !== false, spec: c.governor.spec, reserve: c.governor.reserve, perms: c.governor.perms, log: c.governor.log.slice(0, 12), queue: c.governor.queue, now: c.governor.now && this.time - c.governor.now.t < 150 ? c.governor.now.text : null,
            proposals: (c.governor.proposals || []).map((p) => ({ id: p.id, action: p.action, type: p.type, tile: p.tile, cost: p.cost, reason: p.reason, benefit: p.benefit, confidence: p.confidence })), deferred: c.governor.deferred || [] } : null } : {}) });
    }
    if (nativeRules(this)) for (const record of cities) {
      if (record.o !== civ.id && !god) continue;
      const city = this.cities.get(record.id);
      record.development = { on: city.governor?.enabled !== false, priority: city.development || 'balanced', activity: city.governor?.now?.text || null };
      delete record.gov; delete record.wf;
    }
    const ruins = [];
    for (const [t, r] of this.ruins) if (vis[t] || civ.explored[t] || god) ruins.push([t, r.type, (r.clearing ? 1 : 0) | (r.smoke > 0 ? 2 : 0) | (r.overgrown ? 4 : 0)]);
    const traffic = [];
    for (const [k, v] of this.roads.traffic) { const a = Math.floor(k / N), b = k % N; if (v > 0.5 && (vis[a] || vis[b])) traffic.push([a, b, Math.min(9, Math.round(v))]); }
    const soldiers = [...this.units.values()].filter((u) => u.owner === civ.id).reduce((s, u) => s + UNITS[u.type].pop, 0);
    const me = {
      res: roundObj(civ.res), rates: roundObj(civ.rates, 2), research: civ.researching, autoTech: true, researchWait: civ.researchWait ? TECHS[civ.researchWait]?.goods : undefined, progress: Math.round(civ.progress), researchRate: +civ.researchRate.toFixed(2), queue: civ.queue, techProgress: Object.fromEntries(Object.entries(civ.techProgress || {}).map(([k, v]) => [k, Math.round(v)])), researchGoal: civ.researchGoal, gross: roundObj(civ.gross || {}, 2), saving: civ.saving || null,
      techs: [...civ.techs], age: civ.age, advancing: Math.round(civ.advancing), gov: civ.gov, govCooldown: Math.round(civ.govCooldown), policies: [...civ.policies],
      tax: civ.tax, focus: civ.focus, weariness: Math.round(civ.weariness), soldiers, wonder: civ.wonder ? Math.round(300 - (this.time - civ.wonder.since)) : null,
      power: { gen: Math.round(civ.powerGen), use: Math.round(civ.powerUse) }, storage: civ.storage || 0,
      roads: this.roads.projectsFor(civ.id), proposals: civ.proposals,
      armies: armySummary(this, civ), cmdlog: civ.cmdlog.slice(0, 60),
      readiness: this.tickN % 50 === 0 || !civ.readinessCache ? (civ.readinessCache = readiness(this, civ)) : civ.readinessCache,
      upkeep: civ.upkeep || null, natReserve: civ.natReserve ? civ.natReserve.type : null,
      market: !nativeRules(this) && civ.techs.has('trade_networks') ? this.marketInfo(civ) : null,
      men: [...this.units.values()].filter((u) => u.owner === civ.id).reduce((s, u) => s + (UNITS[u.type].men || 0), 0),
      formations: formationsSnapshot(this, civ.id), command: civ.command || null,
      convoys: convoysFor(this, civ), caches: cachesFor(this, civ), logPolicies: civ.logPolicies ? [...civ.logPolicies].map(([k, p]) => ({ key: k, auto: p.auto, threshold: p.threshold, preset: p.preset, note: p.note || '' })) : [],
      ledger: ledgerSnapshot(civ),
      resources: this.resourcesFor(civ, view),
      fortifyTypes: Object.keys(FIELDWORKS).filter((k) => !FIELDWORKS[k].tech || civ.techs.has(FIELDWORKS[k].tech)),
      trenches: trenchProjectsFor(this, civ),
      air: airSnapshot(this, civ),
      missiles: { ready: inventory(this, civ.id) },
    };
    if (nativeRules(this)) { for (const key of ['gov', 'govCooldown', 'policies', 'tax', 'focus', 'market', 'proposals']) delete me[key]; me.ruleset = this.ruleset; }
    const civs = this.civs.map((c) => {
      const base = { id: c.id, name: c.name, color: c.color, alive: c.alive, human: c.human, rebel: c.isRebel };
      if (c.id === civ.id) return { ...base, age: c.age, rel: null, summary: this.civSummary(c) };
      const rel = this.diplomacy.rel(civ.id, c.id);
      if (nativeRules(this)) return { ...base, rel: { state: rel.state }, intel: rivalIntel(this, civ, c) };
      if (rel.state === 'unmet' && !god) return { ...base, rel: { state: 'unmet' } };
      const knownCities = [...civ.knownCities.values()].filter((k) => k.owner === c.id).length;
      if (god && !c.isRebel) base.summary = this.civSummary(c);
      // a met AI nation's posture is public (what it is visibly doing); its plans are not
      return { ...base, age: c.isRebel ? undefined : c.age, posture: c.ai && !c.isRebel ? c.posture : undefined, rel: { state: rel.state, trade: rel.trade, borders: rel.borders, until: rel.until ? Math.round(rel.until - this.time) : undefined }, known: { cities: knownCities } };
    });
    const out = { econ: me, buildings, cities, civs, ruins, traffic, supply: packBits(civ.supply).toString('base64'),
      bf: battlefieldSnapshot(this, vis, god ? vis : civ.explored, civ.battlefieldMemory || new Map(), god), battles: battlesFor(this, civ, vis, god), ms: missilesSnapshot(this, civ, vis) };
    if (god) out.campaigns = this.campaignSummary();
    return out;
  }

  // resource explanations for the economy screen and shortage alerts (recomputed at most every 2 s)
  resourcesFor(civ, view) {
    if (!civ.human && !(view && view.observer)) return undefined;
    if (!civ._resReport || civ._resReport.at <= this.time - 2) civ._resReport = { at: this.time, v: resourcesReport(this, civ) };
    return civ._resReport.v;
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
      case 'buildNext': return 'Build next: moved a site to the front of the queue';
      case 'buildMany': return `Build ${(cmd.tiles || []).length} × ${BUILDINGS[cmd.type]?.name}`;
      case 'found': return 'Found a city';
      case 'roadPlan': return cmd.commit ? `Commission road (${(cmd.tiles || []).length} waypoints)` : null;
      case 'bridgePlan': return cmd.commit ? 'Build a bridge' : null;
      case 'governor': return `Governor settings for ${this.cities.get(cmd.city)?.name}`;
      case 'clearPass': return 'Blast a pass through the peaks';
      default: return null;
    }
  }

  commandInner(civ, cmd) {
    try {
      if (nativeRules(this) && REMOVED_COMMANDS.has(cmd.c)) return { error: 'This system is not part of the native ruleset' };
      switch (cmd.c) {
        case 'move': {
          const line = Array.isArray(cmd.line) && cmd.line.length === 2 && cmd.line.every((t) => t >= 0 && t < N) ? cmd.line : null;
          detach(this, cmd.units || []);          // moving part of a formation by hand detaches just those units
          for (const id of cmd.units || []) { const u = this.units.get(id); if (u && u.owner === civ.id && u.convoy && u.convoy.state !== 'available' && !cmd.by && this.authOf(civ, cmd) === 'player') u.convoy = { state: 'available', note: 'redirected by you (cargo still aboard)' }; }
          return this.orderMove(civ, cmd.units, line ? line[0] : cmd.tile, !!cmd.attackMove, cmd.formation || 'line', { auth: this.authOf(civ, cmd), queue: !!cmd.queue, line });
        }
        case 'deploy': return deployOrder(this, civ, cmd, this.authOf(civ, cmd));
        case 'airMission': {
          // one order: patrol / strike / support / scout / return. From a base with auto-selection, or for chosen aircraft.
          const kind = MISSIONS.includes(cmd.kind) ? cmd.kind : null; if (!kind) return { error: 'unknown mission' };
          const target = cmd.target && (cmd.target.kind === 'unit' || cmd.target.kind === 'building') ? { kind: cmd.target.kind, id: cmd.target.id | 0 } : null;
          const mission = { kind, tile: cmd.tile | 0, target, radius: cmd.radius, army: cmd.army | 0, repeat: cmd.repeat };
          let ids = (cmd.units || []).slice(0, 40);
          if (!ids.length) { const base = cmd.base != null ? this.buildings.get(cmd.base) : null; if (base && base.owner !== civ.id) return { error: 'not your airfield' }; ids = autoSelect(this, civ, mission, { base, max: Math.max(1, Math.min(8, cmd.count | 0 || (kind === 'patrol' ? 2 : 3))), prefer: cmd.prefer }); if (!ids.length) return { error: base ? 'no suitable aircraft ready at this airfield' : 'no suitable aircraft ready' }; }
          const r = airMission(this, civ, ids, mission, this.authOf(civ, cmd));
          if (r.error) return r;
          if (!r.assigned && r.refused.length) return { error: r.refused[0][1] };
          return { reply: { t: 'ack', air: r } };
        }
        case 'missileBuild': return startMissile(this, civ, cmd.silo | 0);
        case 'missileLaunch': {
          if (!cmd.commit) {
            // preview: range, flight time and the interception odds we can estimate from what we see
            const t = cmd.tile | 0; if (!(t >= 0 && t < N)) return { error: 'bad target' };
            const silos = [...this.buildings.values()].filter((b) => b.owner === civ.id && b.done && BUILDINGS[b.type].silo && (b.missiles || 0) > 0);
            const near = silos.sort((a, b) => dist(a.tile, t) - dist(b.tile, t))[0];
            const seen = interceptors(this, { owner: civ.id, to: t }).filter((x) => civ.visible[x.tile] || civ.explored[x.tile]);
            return { reply: { t: 'ack', missile: { ready: inventory(this, civ.id), inRange: !!near && dist(near.tile, t) <= MISSILE.range, eta: near ? +MISSILE.flight(dist(near.tile, t)).toFixed(0) : 0, odds: +interceptOdds(seen).toFixed(2), interceptors: seen.length, war: this.world.owner[t] < 0 || this.world.owner[t] === civ.id ? null : this.diplomacy.rel(civ.id, this.world.owner[t]).state } } };
          }
          const victim = this.world.owner[cmd.tile | 0];
          if (victim === civ.id) return { error: 'that is your own territory' };
          if (victim >= 0 && !this.hostile(civ.id, victim)) return { error: 'you are not at war with the owner of that land' };
          return launchMissile(this, civ, cmd.tile | 0, this.authOf(civ, cmd));
        }
        case 'rebuild': {
          // Rebuild Settlement on town ruins (preview with commit:false)
          const t = cmd.tile | 0; if (!(t >= 0 && t < N)) return { error: 'bad tile' };
          if (!cmd.commit) { const why = rebuildProblem(this, civ, t); return { reply: { t: 'ack', rebuild: { ok: !why, why, cost: REBUILD_COST, name: this.ruins.get(t)?.name || '' } } }; }
          return rebuildSettlement(this, civ, t);
        }
        case 'cityDiag': {
          const c = this.cities.get(cmd.city | 0); if (!c) return { error: 'no such city' };
          if (c.owner !== civ.id && !this.sandbox && !civ.visible[c.tile]) return { error: 'not visible' };
          return { reply: { t: 'ack', city: cityDiagnostics(this, c) } };
        }
        case 'diagnose': {
          // developer inspector: why a unit is doing what it does (own units; anything in the sandbox)
          const u = this.units.get(cmd.unit | 0);
          if (!u) return { error: 'no such unit' };
          if (u.owner !== civ.id && !this.sandbox) return { error: 'not your unit' };
          const owner = this.civs[u.owner], m = owner.ai?.mil?.missionOf?.(u.id);
          return { reply: { t: 'ack', diag: {
            id: u.id, type: u.type, owner: u.owner, tile: u.tile, order: u.order.kind, auth: u.auth || '-', goal: u.goal ?? -1, slot: u.slot ?? -1,
            path: u.path.length, flowField: !!u.field, status: u.status || 'ok', wait: +(u.wait || 0).toFixed(1), stance: u.stance, cstat: u.cstat || 0,
            pathFail: u.pathFail ? { ...u.pathFail, text: PATH_FAIL[u.pathFail.code], ago: +(this.time - u.pathFail.at).toFixed(1) } : null,
            supply: Math.round(u.supply), morale: Math.round(u.morale ?? 100), formation: u.formation || 0,
            air: u.air ? { state: u.air.state, fuel: +u.air.fuel.toFixed(1), ammo: u.air.ammo, home: u.air.home, mission: u.air.mission ? { kind: u.air.mission.kind, tile: u.air.mission.tile, auth: u.air.mission.auth, suspended: !!u.air.mission.suspended } : null, note: u.air.note || '' } : null,
            mission: m ? { id: m.id, kind: m.kind, state: m.state, since: +(this.time - (m.stateAt ?? m.created)).toFixed(1), history: m.history || [], units: m.units.size } : null,
            stats: { ...this.stats },
          } } };
        }
        case 'airHome': {
          const b = this.buildings.get(cmd.base); if (!b || b.owner !== civ.id || !BUILDINGS[b.type].airbase) return { error: 'choose one of your airfields' };
          let n = 0; for (const id of cmd.units || []) { const u = this.units.get(id); if (u && u.owner === civ.id && u.air && (BUILDINGS[b.type].droneOnly ? ['recon', 'oneway'].includes(UNITS[u.type].role) || u.type === 'strike_swarm' : true)) { u.air.home = b.id; n++; } }
          return { reply: { t: 'ack', rehomed: n } };
        }
        case 'trenchPlan': {
          // Build -> Defenses -> Trench Line: preview a drawn line, or commit it exactly as previewed
          const plan = planTrench(this, civ, (cmd.points || cmd.tiles || []).slice(0, 200), { type: cmd.type, reverse: !!cmd.reverse });
          if (!cmd.commit) return { reply: { t: 'ack', trench: plan } };
          const r = commitTrench(this, civ, plan, cmd.by || this.authOf(civ, cmd));
          if (r.error) return { error: r.error };
          return { reply: { t: 'ack', trench: plan, started: r } };
        }
        case 'trenchCancel': return (({ error, cancelled }) => (error ? { error } : { reply: { t: 'ack', cancelled } }))(cancelTrenchProject(this, civ, cmd.id | 0));
        case 'trenchDemolish': return { reply: { t: 'ack', cleared: clearFieldworks(this, civ, (cmd.tiles || []).slice(0, 200), { finished: true }) } };
        case 'fortify': case 'fortifyPreview': {
          // legacy alias: the same planner and restrictions as a drawn trench line (no troop digging)
          const us = (cmd.units || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id);
          let tiles = Array.isArray(cmd.tiles) ? cmd.tiles.filter((t) => Number.isInteger(t) && t >= 0 && t < N).slice(0, 60) : null;
          if (!tiles) tiles = [...new Set(us.map((u) => (u.formation && this.formations.get(u.formation)?.slots[u.id]) ?? u.tile))];
          if (!tiles.length) return { error: 'draw a trench line from the Build palette (Defenses)' };
          const plan = planTrench(this, civ, tiles, { type: cmd.type, facing: Array.isArray(cmd.facing) ? cmd.facing : undefined });
          if (cmd.c === 'fortifyPreview') return { reply: { t: 'ack', trench: plan } };
          const r = commitTrench(this, civ, plan, this.authOf(civ, cmd));
          if (r.error) return { error: r.error };
          return { reply: { t: 'ack', fortify: { placed: r.placed, skipped: r.skipped, cost: r.cost, seconds: r.seconds, type: r.type } } };
        }
        case 'supplyRun': return { error: 'Troops are supplied automatically: there are no supply runs to send.' };
        case 'supplyRunLegacy': {
          // one click: pick a truck and a source, load a package by need, deliver behind the force
          const target = cmd.formation ? { kind: 'formation', id: cmd.formation } : cmd.army ? { kind: 'army', id: cmd.army } : { kind: 'units', units: (cmd.units || []).slice(0, 80) };
          if (target.kind === 'formation' && this.formations.get(target.id)?.owner !== civ.id) return { error: 'not your formation' };
          return supplyRun(this, civ, target, { preset: PRESETS[cmd.preset] ? cmd.preset : 'auto', truck: cmd.truck });
        }
        case 'supplyPolicy': {
          const key = cmd.formation ? 'f:' + cmd.formation : cmd.army ? 'a:' + cmd.army : null;
          if (!key) return { error: 'choose a formation or an army' };
          if (key[0] === 'f' && this.formations.get(cmd.formation)?.owner !== civ.id) return { error: 'not your formation' };
          if (key[0] === 'a' && !civ.armies?.has(cmd.army)) return { error: 'not your army' };
          civ.logPolicies = civ.logPolicies || new Map();
          if (!cmd.auto) civ.logPolicies.delete(key);
          else civ.logPolicies.set(key, { auto: true, threshold: Math.max(15, Math.min(80, cmd.threshold | 0 || 40)), preset: PRESETS[cmd.preset] ? cmd.preset : 'auto' });
          return null;
        }
        case 'cancelSupplyRun': case 'returnSupplyTruck': return cancelRun(this, civ, cmd.truck, true);
        case 'inspectLogistics': return { reply: { t: 'ack', logistics: { convoys: convoysFor(this, civ), caches: cachesFor(this, civ), trucks: [...this.units.values()].filter((u) => u.owner === civ.id && u.type === 'supply_truck').map((u) => ({ id: u.id, cargo: Math.round(cargoTotal(u.cargo)), state: u.convoy?.state || 'available' })) } } };
        case 'cityPlan': {
          // the city development planner: the same scoring governors use, as advice
          const c = this.cities.get(cmd.city);
          if (!c || c.owner !== civ.id) return { error: 'not your city' };
          const gv = c.governor || defaultGovernor();
          const { list, deferred } = candidates(this, civ, c, gv);
          const none = list.find((x) => x.kind === 'none')?.u ?? 6;
          const recs = list.filter((x) => x.kind !== 'none' && x.u > none).slice(0, 4).map((x) => ({ kind: x.kind, type: x.type, u: Math.round(x.u), reason: x.reason, cost: x.cost }));
          const issues = [];
          if (c.isolated) issues.push('Cut off from the network: build a road (or a port) to share the national stockpile.');
          else if (c.freight !== Infinity && (c.shipped || 0) >= (c.freight || 0) * 0.95) issues.push('Freight capacity is the bottleneck: upgrade the road link to move more goods.');
          if ((c.unemployed || 0) > 3) issues.push(`${Math.round(c.unemployed)} people without work: more workplaces would pay off.`);
          if (c.pop >= c.housing * 0.95) issues.push('Housing is full: growth stalls without more homes.');
          return { reply: { t: 'ack', plan: { city: c.id, recs, avoid: deferred.slice(0, 4), issues } } };
        }
        case 'clearFieldworks': {
          const tiles = Array.isArray(cmd.tiles) ? cmd.tiles : (cmd.units || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id).map((u) => u.tile);
          return { reply: { t: 'ack', cleared: clearFieldworks(this, civ, tiles, { finished: !!cmd.finished }) } };
        }
        case 'formation': return formationCommand(this, civ, cmd, this.authOf(civ, cmd));
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
        case 'stance': {
          const units = (Array.isArray(cmd.units) ? cmd.units : []).map(id => this.units.get(id)).filter(u => u && u.owner === civ.id && !UNITS[u.type].civilian);
          if (!['aggressive', 'defensive', 'hold', 'explore'].includes(cmd.stance)) return null;
          // Native Explore releases selected units from a fixed frontage. They finish their
          // current direct movement before existing idle exploration takes over.
          if (cmd.stance === 'explore' && cmd.releaseFormation) detach(this, units.map(u => u.id));
          for (const u of units) u.stance = cmd.stance;
          return null;
        }
        case 'build': {
          if (BUILDINGS[cmd.type]?.obsolete) return { error: `${BUILDINGS[cmd.type].name} is no longer needed: troops are always supplied` };
          if (!this.canPlace(civ, cmd.type, cmd.tile, true)) return { error: this.world.river[cmd.tile] ? 'Choose dry land beside the river' : 'Cannot build there' };
          if (this.isAutomated(civ, cmd) && !ESSENTIAL.has(cmd.type) && !cmd.national && !this.enablesSavings(civ, cmd.type) && this.breaksSavings(civ, this.buildingCost(civ, cmd.type, cmd.tile))) return { error: 'saving for the next era' };
          const affordable = this.canAfford(civ, this.buildingCost(civ, cmd.type, cmd.tile), cmd.tile);
          // a player's order is never refused for want of funds: it joins the construction queue and
          // starts when funded. Governors and AI empires only order what they can pay for.
          if (!affordable && !cmd.plan && (civ.isAI || this.isAutomated(civ, cmd))) return { error: 'Not enough resources' };
          const cost = this.buildingCost(civ, cmd.type, cmd.tile);
          const nb = this.placeBuilding(civ, cmd.type, cmd.tile, false, !affordable);
          // the placement outcome, so a series of placements can be summarised from real costs
          return { reply: { t: 'ack', built: { id: nb.id, type: cmd.type, tile: cmd.tile, planned: !affordable, cost } } };
        }
        case 'placement': {
          if (cmd.tile != null) {
            const tile = Number(cmd.tile), def = BUILDINGS[cmd.type];
            if (!Number.isInteger(tile) || tile < 0 || tile >= N || !civ.explored[tile] || !def) return { reply: { t: 'placement', site: { tile, valid: false, reason: 'Explore this site first' } } };
            const valid = this.canPlace(civ, cmd.type, tile, true), cost = this.buildingCost(civ, cmd.type, tile);
            let reason = '';
            if (!valid) reason = this.tileB[tile] >= 0 ? 'This site already has a building' : def.tech && !civ.techs.has(def.tech) ? 'Research ' + TECHS[def.tech].name + ' first' : def.age > civ.age ? 'Requires a later era' : isWater(this.world.terr[tile]) || this.world.river[tile] ? 'Choose dry land beside the water' : !this.terrainOk(def, tile) ? 'Requires suitable terrain or a resource deposit' : this.world.owner[tile] !== civ.id ? 'Choose a site in your territory' : 'Site unavailable: check city capacity or clear the ruins';
            const local = this.poolAt(civ, tile);
            const missing = Object.fromEntries(Object.entries(cost).map(([key, amount]) => [key, Math.max(0, amount - ((local && key !== 'credits' ? local[key] : civ.res[key]) || 0))]).filter(([, amount]) => amount > 0));
            return { reply: { t: 'placement', site: { tile, valid, reason, cost, missing, queued: valid && !this.canAfford(civ, cost, tile), seconds: Math.ceil(def.time / (tempo(this, 'construction') * (1 + (techFx(civ).build || 0)))) } } };
          }
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
        case 'bridgePlan': {
          // the Bridge tool: two banks and a class; the bridge is built as road segments (one source
          // of truth with the road planner) by the same construction crews
          const cls = BRIDGE_CLASSES[cmd.cls] ? cmd.cls : bestBridgeClass(civ);
          const b = planBridge(this, civ, cmd.from | 0, cmd.to | 0, cls);
          if (b.error) return cmd.commit ? { error: b.error } : { reply: { t: 'bridgePlan', error: b.error, cls } };
          const plan = this.roads.plan(this, civ, b.tiles, BRIDGE_CLASSES[cls].roadType, true);
          plan.cls = cls; plan.water = b.water; plan.major = b.major;
          if (cmd.commit) { if (!plan.buildable) return { error: plan.segments.find((s) => s.reason && !s.skip)?.reason || 'That bridge is already built' }; const r = this.roads.startProject(this, civ, plan); if (r.error) return { error: r.error }; return { reply: { t: 'bridgePlan', plan, started: r.project } }; }
          return { reply: { t: 'bridgePlan', plan } };
        }
        case 'roadCancel': return this.roads.cancel(civ, cmd.id);
        case 'buildMany': {
          // drag or area placement: one order for many hexes, each validated; queued when unaffordable
          const tiles = [...new Set((cmd.tiles || []).map(Number))].filter((t) => t >= 0 && t < N).slice(0, 60);
          let placed = 0, planned = 0; const failed = []; const cost = {};
          for (const t of tiles) {
            const r = this.commandInner(civ, { c: 'build', type: cmd.type, tile: t, plan: true });
            const b = r?.reply?.built;
            if (!b) { failed.push(t); continue; }
            placed++; if (b.planned) planned++;
            for (const [k, v] of Object.entries(b.cost || {})) cost[k] = (cost[k] || 0) + v;
          }
          return { reply: { t: 'ack', many: { placed, planned, failed: failed.length, cost } } };
        }
        case 'buildNext': {
          // move a site to the front of the construction queue (funding and crews)
          const b = this.buildings.get(cmd.id);
          if (!b || b.owner !== civ.id || b.done) return { error: 'Only unfinished sites can be reordered' };
          let lo = Infinity; for (const o of this.buildings.values()) if (o.owner === civ.id && !o.done) lo = Math.min(lo, o.qn ?? o.id);
          b.qn = (Number.isFinite(lo) ? lo : 1) - 1;
          return null;
        }
        case 'demolish': {
          const b = this.buildings.get(cmd.id);
          if (b && b.owner === civ.id && b.type !== 'town') {
            if (!b.done && b.funded !== false) { const cost = b.cost || BUILDINGS[b.type].cost, back = {}; for (const k in cost) back[k] = Math.floor(cost[k] * 0.5); this.credit(civ, back, 'refunds'); }
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
          this.pay(civ, this.unitCost(civ, cmd.unit), b.tile, 'training');
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
          const c = this.foundCity(civ, u.tile, (u.men || 3) + ((!nativeRules(this) && civ.policies.has('homesteading')) ? 1 : 0));   // the convoy's settlers
          c.stock = { food: 80, materials: 60 };   // the convoy's wagons become the new town's first reserves
          if (civ.human && u.auto) { c.governor.enabled = true; c.governor.level = 'managed'; }
          this.notify(civ.id, `New city founded: ${c.name}.`, { kind: 'city', tile: c.tile });
          recomputeTerritory(this); recomputeTradeNetwork(this);
          return null;
        }
        case 'autoTech': civ.autoTech = !!cmd.on; return null;
        case 'research': {
          const tech = TECHS[cmd.tech];
          if (!tech || !techEnabled(civ, cmd.tech) || civ.techs.has(cmd.tech)) return { error: 'unavailable' };
          if (!researchReady(civ, cmd.tech) || cmd.queue) {
            // queue it (and any missing prerequisites in order)
            for (const k of researchChain(civ, cmd.tech)) if (!civ.queue.includes(k) && k !== civ.researching) civ.queue.push(k);
            if (civ.queue.length > 40) civ.queue.length = 40;
            return null;
          }
          // switching keeps the earned progress of the previous project (no penalty)
          if (civ.researching !== cmd.tech) {
            if (civ.researching && !civ.queue.includes(civ.researching)) civ.queue.unshift(civ.researching);
            civ.researching = cmd.tech; civ.progress = civ.techProgress?.[cmd.tech] || 0; civ.queue = civ.queue.filter((k) => k !== cmd.tech);
          }
          return null;
        }
        case 'unqueue': civ.queue = civ.queue.filter((k) => k !== cmd.tech); return null;
        case 'researchQueue': {
          // queue management: add (with prerequisites), remove, move to an index, move to the front,
          // clear, or set a long-term goal (which may lie in a later era)
          const k = cmd.tech, t = TECHS[k];
          if (cmd.op !== 'clear' && (!t || !techEnabled(civ, k) || civ.techs.has(k))) return { error: 'unknown or already researched' };
          if (cmd.op === 'add' || cmd.op === 'goal') {
            for (const x of researchChain(civ, k)) if (!civ.queue.includes(x) && x !== civ.researching) civ.queue.push(x);
          } else if (cmd.op === 'remove') {
            // removing a technology also removes queued ones that depend on it
            const drop = new Set([k]); let grew = true;
            while (grew) { grew = false; for (const x of civ.queue) if (!drop.has(x) && TECHS[x].req.some((r) => drop.has(r))) { drop.add(x); grew = true; } }
            civ.queue = civ.queue.filter((x) => !drop.has(x));
            if (civ.researchGoal && drop.has(civ.researchGoal)) civ.researchGoal = null;
          } else if (cmd.op === 'move' || cmd.op === 'front') {
            const i = civ.queue.indexOf(k); if (i < 0) return { error: 'not queued' };
            civ.queue.splice(i, 1);
            let to = cmd.op === 'front' ? 0 : Math.max(0, Math.min(civ.queue.length, cmd.index | 0));
            // never ahead of its own prerequisites
            for (const r of researchPrereqsAll(k)) { const j = civ.queue.indexOf(r); if (j >= to) to = j + 1; }
            civ.queue.splice(to, 0, k);
            // nor behind technologies that need it
            for (let j = 0; j < to; j++) if (researchPrereqsAll(civ.queue[j]).has(k)) { const [x] = civ.queue.splice(j, 1); civ.queue.splice(civ.queue.indexOf(k) + 1, 0, x); j--; to--; }
          } else if (cmd.op === 'clear') { civ.queue = []; civ.researchGoal = null; }
          else return { error: 'unknown queue operation' };
          if (civ.queue.length > 40) civ.queue.length = 40;
          return null;
        }
        case 'advance': return { error: 'eras advance on their own once enough of this era’s technologies are known' };
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
        case 'cityDevelopment': {
          if (!nativeRules(this)) return { error: 'Requires native ruleset' };
          const city = this.cities.get(cmd.city);
          if (!city || city.owner !== civ.id) return { error: 'not your city' };
          const gv = city.governor || (city.governor = defaultGovernor(true));
          if (cmd.priority != null && !['balanced', 'industry', 'agriculture', 'military'].includes(cmd.priority)) return { error: 'Unknown development priority' };
          if (cmd.on != null) { gv.enabled = !!cmd.on; gv.level = gv.enabled ? 'managed' : 'off'; gv.chosen = true; }
          if (cmd.priority) { city.development = cmd.priority; gv.spec = cmd.priority === 'agriculture' ? 'agrarian' : cmd.priority === 'industry' ? 'industrial' : cmd.priority === 'military' ? 'fortress' : 'balanced'; }
          return null;
        }
        case 'governor': {
          if (nativeRules(this)) return { error: 'Use Automatic Development in the city inspector' };
          const c = this.cities.get(cmd.city);
          if (!c || c.owner !== civ.id) return { error: 'not your city' };
          const gv = c.governor || (c.governor = defaultGovernor());
          migrateGovernor(gv);
          if (cmd.enabled !== undefined) { gv.enabled = !!cmd.enabled; gv.level = gv.enabled ? (gv.level === 'off' ? 'autonomous' : gv.level) : 'off'; gv.chosen = true; }
          if (cmd.level && LEVELS.includes(cmd.level)) { gv.level = cmd.level; gv.enabled = cmd.level !== 'off'; gv.chosen = true; }
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
          book(civ, 'imports', 'credits', -quote.credits); book(civ, 'imports', k, quote.amount);
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
            this.pay(civ, cost, fac.tile, 'training');
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
          // housing upgrades: a block gains storeys (more homes on the same hex); production buildings
          // gain a level (more jobs, every worker more productive: more output from the same land)
          const b = this.buildings.get(cmd.id);
          if (b && b.owner === civ.id && b.type !== 'house') {
            const why = upgradeProblem(civ, b); if (why) return { error: why };
            const cost = levelUpgradeCost(b.type, b.level || 1);
            if (this.isAutomated(civ, cmd) && this.breaksSavings(civ, cost)) return { error: 'saving for the next era' };
            if (!this.canAfford(civ, cost, b.tile)) return { error: 'cannot afford the upgrade: ' + Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ') };
            if (b.works) return { error: 'works are already under way here' };
            this.pay(civ, cost, b.tile);
            if (timedWorks(this)) { this.startWorks(b, 'upgrade', cost, this.worksSeconds(b)); this.world.touch(b.tile); return { reply: { t: 'ack', level: b.level || 1, works: b.works.total, cost } }; }
            const lv = b.level || 1;
            b.level = lv + 1; b.maxHp = Math.round(BUILDINGS[b.type].hp * (1 + 0.4 * lv)); b.hp = Math.min(b.maxHp, b.hp + BUILDINGS[b.type].hp * 0.4);
            b.upgradedAt = this.time; this.world.touch(b.tile);
            return { reply: { t: 'ack', level: b.level, cost } };
          }
          if (!b || b.owner !== civ.id || b.type !== 'house' || !b.done) return { error: 'only finished buildings can be upgraded' };
          const lv = b.level || 1;
          if (lv >= 3) return { error: 'already at the highest density' };
          if (b.works) return { error: 'works are already under way here' };
          const cost = this.upgradeCost(civ, b);
          if (this.isAutomated(civ, cmd) && this.breaksSavings(civ, cost)) return { error: 'saving for the next era' };
          if (!this.canAfford(civ, cost, b.tile)) return { error: 'cannot afford the upgrade' };
          this.pay(civ, cost, b.tile);
          if (timedWorks(this)) { this.startWorks(b, 'upgrade', cost, this.worksSeconds(b)); this.world.touch(b.tile); return null; }
          b.level = lv + 1; b.maxHp = Math.round(BUILDINGS.house.hp * (1 + 0.5 * lv)); b.hp = Math.min(b.maxHp, b.hp + BUILDINGS.house.hp * 0.5);
          b.upgradedAt = this.time; this.world.touch(b.tile);
          return null;
        }
        case 'upgradeDefense': {
          // AA battery upgrade after Air Defense: better detection, one more hex of range, better fire control
          const b = this.buildings.get(cmd.id);
          if (!b || b.owner !== civ.id || b.type !== 'aa_battery' || !b.done) return { error: 'select a finished AA battery' };
          if (b.upgraded) return { error: 'already upgraded' };
          if (!civ.techs.has('air_defense')) return { error: 'requires Air Defense' };
          const cost = { steel: 30, electronics: 10 };
          if (!this.canAfford(civ, cost, b.tile)) return { error: 'needs 30 steel and 10 electronics' };
          this.pay(civ, cost, b.tile, 'construction'); b.upgraded = true; this.world.touch(b.tile);
          return null;
        }
        case 'batchUpgrade': {
          // several housing blocks in one order, each validated here; never charged twice
          if (cmd.requestId != null) { this.requests = this.requests || new Map(); const seen = this.requests.get(civ.id + ':u:' + cmd.requestId); if (seen) return { reply: { t: 'ack', upgrade: seen, repeat: true } }; }
          const res = this.batchUpgrade(civ, cmd.ids || [], cmd.policy === 'all' ? 'all' : 'affordable', !!cmd.preview, cmd);
          if (cmd.requestId != null && !cmd.preview) { this.requests.set(civ.id + ':u:' + cmd.requestId, res); if (this.requests.size > 300) this.requests.delete(this.requests.keys().next().value); }
          if (res.error) return { error: res.error };
          return { reply: { t: 'ack', upgrade: res } };
        }
        case 'clearQueue': {
          // empty one facility's training queue: refunds as for single cancellations, completed units untouched
          const ids = Array.isArray(cmd.buildings) ? cmd.buildings : [cmd.building];
          const refund = {}; let n = 0, men = 0;
          for (const id of ids) {
            const b = this.buildings.get(id); if (!b || b.owner !== civ.id) continue;
            for (let i = b.queue.length - 1; i >= 0; i--) {
              const q = b.queue[i]; b.queue.splice(i, 1); releaseTraining(this.cities.get(b.cityId), q);
              const share = i === 0 && q.left < UNITS[q.unit].time - 0.01 ? 0.5 : 1;
              for (const [k, v] of Object.entries(q.cost || {})) refund[k] = (refund[k] || 0) + Math.floor(v * share);
              n++; men += q.men || 0;
            }
          }
          this.credit(civ, refund, 'refunds');
          return { reply: { t: 'ack', cleared: { n, refund, men } } };
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
          this.credit(civ, refund, 'refunds');
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
        case 'cancelWorks': return this.cancelWorks(civ, this.buildings.get(cmd.id));
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
    if (w.river[t]) return 'Choose dry land beside the river';
    if (isWater(w.terr[t]) || !Number.isFinite(TERRAIN[w.terr[t]].move) || w.terr[t] === T.MOUNTAIN) return 'unsuitable terrain';
    if (w.owner[t] >= 0 && w.owner[t] !== civ.id) return 'inside foreign territory';
    if (this.tileB[t] >= 0) return 'tile occupied';
    for (const c of this.cities.values()) if (dist(c.tile, t) < 7) return 'too close to another city';
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
        this.pay(civ, cost, b.tile, 'training');
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
  // Upgrades for several buildings at once: housing blocks gain storeys, production buildings a
  // level. 'all': commit only if every eligible building can be funded; 'affordable': upgrade in a
  // deterministic order (lowest level, then id) while funds last.
  batchUpgrade(civ, ids, policy, preview, cmd = {}) {
    const uniq = [...new Set((ids || []).map(Number))].slice(0, 200);
    const eligible = [], skipped = [];
    for (const id of uniq) {
      const b = this.buildings.get(id);
      if (!b || b.owner !== civ.id) { skipped.push({ id, reason: 'not yours' }); continue; }
      if (b.type !== 'house') { const why = upgradeProblem(civ, b); if (why) { skipped.push({ id, reason: why }); continue; } eligible.push(b); continue; }
      if (!b.done) { skipped.push({ id, reason: 'unfinished' }); continue; }
      if ((b.level || 1) >= 3) { skipped.push({ id, reason: 'already at maximum density' }); continue; }
      if (b.works) { skipped.push({ id, reason: 'works already under way' }); continue; }
      eligible.push(b);
    }
    eligible.sort((a, b) => (a.level || 1) - (b.level || 1) || a.id - b.id);
    const each = eligible.map((b) => ({ b, cost: b.type === 'house' ? this.upgradeCost(civ, b) : levelUpgradeCost(b.type, b.level || 1) }));
    const total = {}; for (const x of each) for (const [k, v] of Object.entries(x.cost)) total[k] = (total[k] || 0) + v;
    const homes = (b) => (b.type === 'house' ? 4 + civ.age : 0);      // each housing level adds this many homes (see economy housing)
    const capacity = each.reduce((s2, x) => s2 + homes(x.b), 0);
    if (preview) return { eligible: each.map((x) => x.b.id), skipped, cost: total, capacity, upgraded: [], policy };
    if (!each.length) return { error: skipped.length ? `nothing to upgrade: ${skipped[0].reason}` : 'select buildings to upgrade' };
    if (this.isAutomated(civ, cmd) && this.breaksSavings(civ, total) && policy === 'all') return { error: 'saving for the next era' };
    if (policy === 'all' && !this.canAfford(civ, total, each[0].b.tile)) return { error: 'cannot afford every upgrade (choose "what is affordable" to upgrade some)', cost: total };
    const upgraded = [], spent = {};
    for (const x of each) {
      if (!this.canAfford(civ, x.cost, x.b.tile)) { skipped.push({ id: x.b.id, reason: 'cannot afford' }); continue; }
      this.pay(civ, x.cost, x.b.tile, 'construction');
      for (const [k, v] of Object.entries(x.cost)) spent[k] = (spent[k] || 0) + v;
      if (timedWorks(this)) {
        this.startWorks(x.b, 'upgrade', x.cost, this.worksSeconds(x.b)); this.world.touch(x.b.tile);
        upgraded.push({ id: x.b.id, level: (x.b.level || 1) + 1, works: x.b.works.total });
        continue;
      }
      const lv = x.b.level || 1, base = BUILDINGS[x.b.type].hp, k = x.b.type === 'house' ? 0.5 : 0.4;
      x.b.level = lv + 1; x.b.maxHp = Math.round(base * (1 + k * lv)); x.b.hp = Math.min(x.b.maxHp, x.b.hp + base * k);
      x.b.upgradedAt = this.time; this.world.touch(x.b.tile);
      upgraded.push({ id: x.b.id, level: x.b.level });
    }
    return { upgraded, skipped, cost: spent, capacity: upgraded.reduce((s2, u) => s2 + homes(this.buildings.get(u.id)), 0), policy };
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
    // an AI's blackboard reservations for planned works (the era itself is civ.saving)
    const board = civ.ai?.brain ? civ.ai.brain.board.reserved(this.time, ['era']) : null;
    for (const sv of [civ.saving, res, board && Object.keys(board).length ? board : null]) {
      if (!sv) continue;
      for (const [k, v] of Object.entries(cost)) if (sv[k] && (civ.res[k] || 0) - v < sv[k]) return true;
    }
    return false;
  }
  authOf(civ, cmd) { return civ.human && !cmd.by ? 'player' : cmd.auth || 'mission'; }

  orderMove(civ, ids, tile, attackMove, formation = 'line', opts = {}) {
    if (!(tile >= 0 && tile < N)) return { error: 'bad tile' };
    let units = (ids || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id);
    // aircraft do not "move": a destination becomes a patrol (recon: a scouting run) over that place
    const air = units.filter((u) => UNITS[u.type].air);
    if (air.length) {
      units = units.filter((u) => !UNITS[u.type].air);
      const scouts = air.filter((u) => canFly(u.type, 'scout') && !canFly(u.type, 'strike')).map((u) => u.id);
      const patrol = air.filter((u) => canFly(u.type, 'patrol') && !scouts.includes(u.id)).map((u) => u.id);
      if (scouts.length) airMission(this, civ, scouts, { kind: 'scout', tile }, opts.auth || 'player');
      if (patrol.length) airMission(this, civ, patrol, { kind: 'patrol', tile }, opts.auth || 'player');
      if (!units.length) return { reply: { t: 'ack', order: { reached: air.length, partial: 0, unreachable: 0, kept: 0, air: true } } };
    }
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
    const groupSpeed = free.length >= 3 && ground.length ? Math.min(...ground.map((u) => UNITS[u.type].speed * movementRate(this, UNITS[u.type]))) : 0;
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
      if (path && path.partial) { u.slot = path[path.length - 1]; results.partial++; pathFail(this, u, 'partial'); }
      else if (!path && u.tile !== slot) { results.unreachable++; pathFail(this, u, 'no_route'); u.status = 'blocked'; }
      else { results.reached++; u.pathFail = null; }
    }
    if (opts.line) results.slots = [...slots.values()];
    return { reply: { t: 'ack', order: results } };
  }

  // Group attack: by default fire is distributed over the threats around the target with
  // overkill avoidance; focus fire puts every weapon on the one target.
  orderAttack(civ, ids, target, opts = {}) {
    let units = (ids || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id && UNITS[u.type].atk > 0);
    // aircraft attacking something fly a strike mission (fighters intercept aircraft the same way)
    const air = units.filter((u) => UNITS[u.type].air);
    if (air.length) {
      units = units.filter((u) => !UNITS[u.type].air);
      const tt = target.kind === 'unit' ? this.units.get(target.id)?.tile : this.buildings.get(target.id)?.tile;
      if (tt >= 0) airMission(this, civ, air.filter((u) => canFly(u.type, 'strike')).map((u) => u.id), { kind: 'strike', tile: tt, target }, opts.auth || 'player');
      if (!units.length) return { reply: { t: 'ack', order: { assigned: air.length, air: true } } };
    }
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
