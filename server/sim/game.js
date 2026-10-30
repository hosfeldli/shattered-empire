// Authoritative match simulation. One Game per match; clients only send intents.
import { N, W, T, DT, TERRAIN, BUILDINGS, UNITS, TECHS, GOVS, POLICIES, FOCI, AGES, CIV_COLORS, CIV_NAMES, REBEL, GAME_DEFS, GOVERNOR_SPECS, ROAD_TYPES, RES, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';
import { World } from './world.js';
import { mulberry32 } from './rng.js';
import { Geology, describeTile } from './geology.js';
import { tileRecord } from './render.js';
import { findPath, findRoadRoute, flowField, formationSlots } from './path.js';
import { RoadNet } from './roads.js';
import { economyStep, recomputeTerritory, recomputeTradeNetwork, migrationStep } from './economy.js';
import { unitsStep, buildingCombatStep, recomputeSupply, supplyStep, spawnUnit, damageUnit, damageBuilding } from './military.js';
import { Diplomacy } from './diplomacy.js';
import { AI } from './ai.js';
import { RebelAI } from './rebels.js';
import { defaultGovernor, governorStep, autoColonists } from './governor.js';
import { armyCommand, armiesStep, armySummary } from './armies.js';
import { recoveryStep } from './recovery.js';

const LEVEL_OF = { tech: 'info', build: 'info', unit: 'info', history: 'info', rumor: 'minor', city: 'minor', diplo: 'minor', peace: 'minor', age: 'minor', gov: 'minor',
  quake: 'major', eruption: 'major', rift: 'minor', uplift: 'minor', drought: 'major', river: 'minor', warning: 'major', rebel: 'major', loss: 'major', isolated: 'major', blocked: 'major', proposal: 'major', war: 'major', error: 'minor',
  famine: 'critical', fall: 'critical', wonder: 'critical' };

const CITY_NAMES = ['Aldmoor', 'Brightwater', 'Cindervale', 'Dunhollow', 'Emberfell', 'Frosthaven', 'Greywatch', 'Highcrag', 'Ironford', 'Juniper', 'Kingsreach', 'Lowmarsh', 'Mistport', 'Northgate', 'Oakheart', 'Pinecrest', 'Quarrytown', 'Redcliff', 'Stonebridge', 'Thornfield', 'Umberdale', 'Valewind', 'Westmarch', 'Yarrow', 'Zephyr Rock', 'Ashmere', 'Blackreed', 'Coldspring', 'Deepwell', 'Eastbrook', 'Foundry Hill', 'Gantry', 'Harrowgate', 'Isolde', 'Jetty'];

export class Game {
  constructor({ id, seed = (Math.random() * 2 ** 31) | 0, slots, rebels = true, restore = null }) {
    this.id = id;
    this.seed = seed;
    this.slotsDef = slots.map((s) => ({ human: !!s.human, name: s.name, leader: s.leader, personality: s.personality }));
    this.defs = GAME_DEFS;
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.world = new World(seed);
    this.world.generate(slots.length);
    this.roads = new RoadNet(this.world);
    this.time = 0; this.tickN = 0; this.nextId = 1;
    this.units = new Map(); this.buildings = new Map(); this.cities = new Map();
    this.ruins = new Map();                 // tile -> { type, owner, name, time }
    this.tileB = new Int32Array(N).fill(-1);
    this.tileUnits = new Map(); this.tileLoad = new Map();
    this.navVersion = 1; this.navDirty = false;
    this.fx = []; this.over = false; this.winner = null; this.log = []; this.outbox = [];
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
      human: !!slot.human, isAI: !slot.human, isRebel: false, personality: slot.personality || ['merchant', 'warlord', 'builder'][id % 3],
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
    spawnUnit(this, civ, 'scout_buggy', free[0] ?? tile);
    spawnUnit(this, civ, 'militia', free[1] ?? tile);
    spawnUnit(this, civ, 'militia', free[2] ?? tile);
    spawnUnit(this, civ, 'engineer', free[3] ?? tile);
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
      case 'farm': if (![T.GRASS, T.PLAINS, T.ASH, T.MARSH, T.TUNDRA].includes(ter) && !(ter === T.DESERT && w.river[t])) return false; break;
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
    if (city && def.pop && city.pop - def.pop < 2) return 'not enough population';
    if (b.queue.length >= 5) return 'queue full';
    if (!this.canAfford(civ, this.unitCost(civ, unit), b.tile)) return 'cannot afford';
    return null;
  }

  // ----------------------------------------------------------------- main loop
  tick() {
    if (this.over) return;
    this.time += DT;
    this.tickN++;
    const t = this.tickN;
    this.fx.length = 0;
    this.rebuildTileUnits();
    unitsStep(this, DT);
    if (t % 5 === 0) buildingCombatStep(this, 0.5);
    if (t % 10 === 0) {
      this.constructionStep(1);
      this.roads.step(this, 1);
      economyStep(this, 1);
      supplyStep(this, 1);
      this.researchStep(1);
      this.geology.step(1, this.time);
      for (const tile of this.world.wiped) this.roads.obliterate(tile);
      this.world.wiped.clear();
      this.diplomacy.step(1);
      governorStep(this, 1);
      this.checkVictory();
    }
    if (t % 20 === 0) { recomputeSupply(this); autoColonists(this); armiesStep(this); if (this.world.dirty.size) { this.navVersion++; this.world.dirty.clear(); } }
    if (t % 30 === 0) recomputeTerritory(this);
    if (t % 50 === 0) { recomputeTradeNetwork(this); this.roads.decayTraffic(); }
    if (t % 100 === 0) migrationStep(this);
    if (t % 300 === 0) recoveryStep(this);
    for (const civ of this.civs) if (civ.ai && civ.alive && (t + civ.id * 7) % (civ.isRebel ? 30 : 20) === 0) civ.ai.think();
    if (t % 2 === 0) this.refreshVisibility();
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
            if (q.unit === 'colonist' && (q.auto || civ.isAI === false && this.cities.get(b.cityId)?.governor?.enabled && this.cities.get(b.cityId)?.governor?.perms.settle)) u.auto = true;
            if (q.army && civ.armies?.has(q.army)) civ.armies.get(q.army).units.push(u.id);
            if (b.rally >= 0) this.orderMove(civ, [u.id], b.rally, false);
            this.notify(civ.id, `${UNITS[q.unit].name} ready.`, { kind: 'unit', tile: spot, quiet: true, level: 'info' });
          }
        }
        // natural upkeep only keeps sound buildings sound; damaged ones need repair (governor, engineers, or you)
        if (b.hp < b.maxHp && b.hp >= b.maxHp * 0.5 && !b.fire && this.time - (b.lastHit || -99) > 15) b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.002 * dt);
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
    const w = this.world;
    for (const civ of this.civs) {
      if (!civ.alive) continue;
      const vis = civ.visible, det = civ.detect; vis.fill(0); det.fill(0);
      const allies = this.civs.filter((o) => o.alive && this.allied(civ.id, o.id)).map((o) => o.id);
      for (const u of this.units.values()) {
        if (!allies.includes(u.owner)) continue;
        const def = UNITS[u.type];
        let v = def.vision;
        if (!def.air) { const tt = w.terr[u.tile]; if (tt === T.HILLS) v += 1; else if (tt === T.MOUNTAIN) v += 2; }
        for (const t of disk(u.tile, v)) vis[t] = 1;
        for (const t of disk(u.tile, def.cat === 'air' && def.civilian ? 4 : 2)) det[t] = 1;
      }
      const tele = civ.techs.has('networked_command') ? 1 : 0;
      for (const b of this.buildings.values()) {
        if (!allies.includes(b.owner)) continue;
        for (const t of disk(b.tile, (BUILDINGS[b.type].vision || 2) + tele)) vis[t] = 1;
        for (const t of disk(b.tile, 2)) det[t] = 1;
      }
      for (let i = 0; i < N; i++) { if (w.owner[i] === civ.id) vis[i] = 1; if (vis[i]) { civ.explored[i] = 1; civ.lastOwner[i] = w.owner[i]; } }
      if (intel) { this.updateIntel(civ); this.diplomacy.checkContact(civ); }
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
        u.owner === civ.id || view.god ? u.stance : undefined]);
    }
    const paths = {};
    for (const u of this.units.values()) if ((u.owner === civ.id || view.god) && (u.path.length || u.field)) paths[u.id] = u.field ? [u.slot] : u.path.slice(0, view.god ? 16 : 40);
    const fx = view.god ? this.fx : this.fx.filter((f) => vis[f[1]] || vis[f[2]]);
    let visB64;
    const key = packBits(vis).toString('base64');
    if (key !== k.visKey) { k.visKey = key; visB64 = key; }
    const msg = { t: 's', time: +this.time.toFixed(1), units, paths, fx };
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
        ...(own ? { s: b.staffed, w: b.why || undefined, tr: b.queue.length ? Math.max(0, Math.min(100, Math.round(100 * (1 - b.queue[0].left / Math.max(1, UNITS[b.queue[0].unit]?.time || 1))))) : undefined, q: b.queue.map((q) => [q.unit, Math.max(0, Math.round(q.left))]), c: b.cityId, r: b.rally, gov: (this.cities.get(b.cityId)?.governor?.queue || []).includes(b.id) ? 1 : 0 } : {}) });
    }
    const cities = [];
    for (const c of this.cities.values()) {
      if (c.owner !== civ.id && !vis[c.tile]) continue;
      const own = c.owner === civ.id || god;
      cities.push({ id: c.id, o: c.owner, n: c.name, t: c.tile, pop: +c.pop.toFixed(1), cap: c.capital ? 1 : 0, r: c.radius,
        dmg: this.cityDamage(c),
        ...(own ? { h: c.housing, st: Math.round(c.stability), jobs: c.jobs, un: Math.round(c.unemployed), fs: c.foodShort ? 1 : 0, dis: Math.round(c.disaster), occ: Math.round(c.occupied), unrest: c.stability < 20 ? 1 : 0, trade: c.tradeConnected ? 1 : 0,
          iso: c.isolated ? 1 : 0, fr: c.freight === Infinity ? -1 : +(c.freight || 0).toFixed(1), stock: roundObj(c.stock || {}), ship: +(c.shipped || 0).toFixed(1),
          gov: c.governor ? { enabled: c.governor.enabled, spec: c.governor.spec, reserve: c.governor.reserve, perms: c.governor.perms, log: c.governor.log.slice(0, 12), queue: c.governor.queue } : null } : {}) });
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
    const out = { econ: me, buildings, cities, civs, ruins, traffic, supply: packBits(civ.supply).toString('base64') };
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
      let sx = 0, sy = 0; for (const u of army) { sx += u.tile % W; sy += (u.tile / W) | 0; }
      sx /= army.length; sy /= army.length;
      let best = army[0], bd = Infinity; for (const u of army) { const d = (u.tile % W - sx) ** 2 + (((u.tile / W) | 0) - sy) ** 2; if (d < bd) { bd = d; best = u; } }
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
      case 'attack': return `Attack with ${n(cmd.units)} unit${n(cmd.units) === 1 ? '' : 's'}`;
      case 'build': return `${cmd.plan ? 'Plan' : 'Build'} ${BUILDINGS[cmd.type]?.name}` + (cmd.why ? `: ${cmd.why}` : '');
      case 'train': return `Train ${UNITS[cmd.unit]?.name}`;
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
        case 'move': return this.orderMove(civ, cmd.units, cmd.tile, !!cmd.attackMove, cmd.formation || 'line');
        case 'attack': return this.orderAttack(civ, cmd.units, cmd.target);
        case 'stop': for (const id of cmd.units || []) { const u = this.units.get(id); if (u && u.owner === civ.id) { u.path = []; u.field = false; u.order = { kind: 'idle' }; u.goal = -1; u.slot = -1; u.groupSpeed = 0; } } return null;
        case 'stance': for (const id of cmd.units || []) { const u = this.units.get(id); if (u && u.owner === civ.id && ['aggressive', 'defensive', 'hold'].includes(cmd.stance) && !UNITS[u.type].civilian) u.stance = cmd.stance; } return null;
        case 'build': {
          if (!this.canPlace(civ, cmd.type, cmd.tile, true)) return { error: 'Cannot build there' };
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
          const why = this.canTrain(civ, b, cmd.unit); if (why) return { error: why };
          this.pay(civ, this.unitCost(civ, cmd.unit), b.tile);
          const city = this.cities.get(b.cityId); if (city) city.pop -= UNITS[cmd.unit].pop;
          b.queue.push({ unit: cmd.unit, left: UNITS[cmd.unit].time, auto: !!cmd.auto, army: cmd.army || b.rallyArmy || 0 });
          return null;
        }
        case 'rally': { const b = this.buildings.get(cmd.building); if (b && b.owner === civ.id) { b.rally = cmd.tile; b.rallyArmy = cmd.army || 0; } return null; }
        case 'found': {
          const u = this.units.get(cmd.unit);
          if (!u || u.owner !== civ.id || u.type !== 'colonist') return { error: 'need a colonist convoy' };
          const why = this.canFound(civ, u.tile); if (why) return { error: why };
          this.units.delete(u.id);
          const c = this.foundCity(civ, u.tile, civ.policies.has('homesteading') ? 4 : 3);
          c.stock = { food: 80, materials: 60 };   // the convoy's wagons become the new town's first reserves
          if (civ.human && u.auto) { c.governor.enabled = true; }
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
          if (cmd.enabled !== undefined) gv.enabled = !!cmd.enabled;
          if (cmd.spec && GOVERNOR_SPECS[cmd.spec]) gv.spec = cmd.spec;
          if (cmd.reserve !== undefined) gv.reserve = Math.max(0, Math.min(0.9, +cmd.reserve));
          if (cmd.perms) for (const k of ['build', 'roads', 'repair', 'recruit', 'settle']) if (cmd.perms[k] !== undefined) gv.perms[k] = !!cmd.perms[k];
          if (cmd.cancel) { const b = this.buildings.get(cmd.cancel); if (b && !b.done && b.owner === civ.id) { this.command(civ.id, { c: 'demolish', id: b.id, block: true }); gv.log.unshift({ t: Math.round(this.time), text: `Project cancelled by you: ${BUILDINGS[b.type].name}. The governor will not build on that hex again.` }); } }
          return null;
        }
        case 'army': return armyCommand(this, civ, cmd);
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
  orderMove(civ, ids, tile, attackMove, formation = 'line') {
    if (!(tile >= 0 && tile < N)) return { error: 'bad tile' };
    const units = (ids || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id);
    const results = { reached: 0, partial: 0, unreachable: 0 };
    if (!units.length) return { reply: { t: 'ack', order: results } };
    const slots = units.length > 1 ? formationSlots(this, civ, units, tile, formation) : new Map([[units[0].id, tile]]);
    const ground = units.filter((u) => !UNITS[u.type].air);
    const groupSpeed = units.length >= 3 && ground.length ? Math.min(...ground.map((u) => UNITS[u.type].speed)) : 0;
    for (const u of units) {
      const slot = slots.get(u.id) ?? tile;
      u.order = { kind: attackMove ? 'attackMove' : 'move' };
      u.goal = tile; u.slot = slot; u.wait = 0; u.status = 'ok';
      u.groupSpeed = UNITS[u.type].air ? 0 : groupSpeed;
      const far = dist(u.tile, slot) > 6;
      if (units.length >= 4 && far) {
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
    return { reply: { t: 'ack', order: results } };
  }

  orderAttack(civ, ids, target) {
    for (const id of ids || []) {
      const u = this.units.get(id);
      if (!u || u.owner !== civ.id || UNITS[u.type].atk <= 0) continue;
      u.order = { kind: 'attack', target }; u.field = false;
      u.repathAt = 0;
    }
    return null;
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
