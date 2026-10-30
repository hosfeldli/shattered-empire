// Authoritative match simulation. One Game per match; clients only send intents.
import { N, W, T, DT, TERRAIN, BUILDINGS, UNITS, TECHS, GOVS, POLICIES, FOCI, TAX, AGES, CIV_COLORS, CIV_NAMES, GAME_DEFS, isWater, RES } from './constants.js';
import { NB, disk, dist, qOf, rOf } from './hex.js';
import { World } from './world.js';
import { mulberry32 } from './rng.js';
import { Geology, describeTile } from './geology.js';
import { tileRecord } from './render.js';
import { findPath, findRoadRoute } from './path.js';
import { economyStep, recomputeTerritory, recomputeTradeNetwork, migrationStep } from './economy.js';
import { unitsStep, buildingCombatStep, recomputeSupply, supplyStep, spawnUnit, damageUnit, damageBuilding } from './military.js';
import { Diplomacy } from './diplomacy.js';
import { AI } from './ai.js';

const CITY_NAMES = ['Aldmoor', 'Brightwater', 'Cindervale', 'Dunhollow', 'Emberfell', 'Frosthaven', 'Greywatch', 'Highcrag', 'Ironford', 'Juniper', 'Kingsreach', 'Lowmarsh', 'Mistport', 'Northgate', 'Oakheart', 'Pinecrest', 'Quarrytown', 'Redcliff', 'Stonebridge', 'Thornfield', 'Umberdale', 'Valewind', 'Westmarch', 'Yarrow', 'Zephyr Rock', 'Ashmere', 'Blackreed', 'Coldspring', 'Deepwell', 'Eastbrook'];

export class Game {
  constructor({ id, seed = (Math.random() * 2 ** 31) | 0, slots }) {
    this.id = id;
    this.seed = seed;
    this.defs = GAME_DEFS;
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.world = new World(seed);
    this.world.generate(slots.length);
    this.time = 0;
    this.tickN = 0;
    this.nextId = 1;
    this.units = new Map();
    this.buildings = new Map();
    this.cities = new Map();
    this.tileB = new Int32Array(N).fill(-1);
    this.tileUnits = new Map();
    this.fx = [];
    this.over = false;
    this.winner = null;
    this.log = [];
    this.outbox = [];                     // [civId|-1, message]
    this.cityNameIdx = 0;
    this.roadJobs = [];
    this.civs = slots.map((s, i) => this.makeCiv(i, s));
    this.diplomacy = new Diplomacy(this);
    this.geology = new Geology(this);
    for (const civ of this.civs) this.setupStart(civ, this.world.starts[civ.id]);
    recomputeTerritory(this);
    for (const civ of this.civs) if (civ.isAI) civ.ai = new AI(this, civ);
    this.refreshVisibility();
    recomputeSupply(this);
  }

  makeCiv(id, slot) {
    return {
      id, name: slot.name || CIV_NAMES[id], leader: slot.leader || (slot.human ? 'Player' : 'AI'), color: CIV_COLORS[id],
      human: !!slot.human, isAI: !slot.human, personality: slot.personality || ['merchant', 'warlord', 'builder'][id % 3],
      alive: true, connected: false, token: null,
      res: { food: 220, wood: 220, stone: 100, iron: 0, coal: 0, gold: 120, equip: 25 },
      rates: {}, researchRate: 0, researching: null, progress: 0, techs: new Set(),
      age: 0, advancing: 0, gov: 'chiefdom', govCooldown: 0, policies: new Set(), tax: 1, focus: 'balanced',
      weariness: 0, casualties: 0, kills: 0, popTotal: 0,
      knownVer: new Uint16Array(N), explored: new Uint8Array(N), lastOwner: new Int8Array(N).fill(-2), knownCities: new Map(), intel: {}, knownOwner: new Int8Array(N).fill(-2), visible: new Uint8Array(N), supply: new Uint8Array(N),
      visKey: '', proposals: [], wonder: null, notices: [], lastEcon: 0,
    };
  }

  setupStart(civ, tile) {
    const city = this.foundCity(civ, tile, 7, true);
    city.stability = 70;
    recomputeTerritory(this);
    const free = this.freeTilesNear(tile, 2);
    spawnUnit(this, civ, 'scout', free[0] ?? tile);
    spawnUnit(this, civ, 'spearman', free[1] ?? tile);
    spawnUnit(this, civ, 'spearman', free[2] ?? tile);
    // start with a working farm & lumber camp near town so the economy is alive from second one
    const near = disk(tile, 3);
    const farmT = near.find((t) => this.canPlace(civ, 'farm', t, true));
    if (farmT !== undefined) this.placeBuilding(civ, 'farm', farmT, true);
    const lumT = near.find((t) => this.canPlace(civ, 'lumber', t, true));
    if (lumT !== undefined) this.placeBuilding(civ, 'lumber', lumT, true);
  }

  // ----------------------------------------------------------------- helpers
  id_() { return this.nextId++; }
  civ(id) { return this.civs[id]; }
  buildingAtTile(t) { const id = this.tileB[t]; return id >= 0 ? this.buildings.get(id) : null; }
  buildingsAt(t) { const b = this.buildingAtTile(t); return b ? [b] : []; }
  unitsAt(t) { return (this.tileUnits.get(t) || []).map((id) => this.units.get(id)).filter(Boolean); }
  hostile(a, b) { return a !== b && this.diplomacy.rel(a, b).state === 'war'; }
  canEnter(a, b) { if (a === b) return true; const r = this.diplomacy.rel(a, b); return r.state === 'war' || r.state === 'alliance' || r.borders; }
  allied(a, b) { return a === b || this.diplomacy.rel(a, b).state === 'alliance'; }
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
  capital(civ) { return this.cityOf(civ).sort((a, b) => a.id - b.id)[0]; }

  notify(civId, text, extra = {}) {
    const msg = { t: 'note', time: Math.round(this.time), text, ...extra };
    if (civId < 0) this.outbox.push([-1, msg]); else this.outbox.push([civId, msg]);
  }

  // Terrain events: civs that can see the area get full details; others feel distant tremors.
  geoEvent(kind, tile, radius, text, extra = {}) {
    this.log.push({ time: this.time, kind, tile, text });
    for (const civ of this.civs) {
      const seen = disk(tile, Math.max(1, radius)).some((t) => civ.visible[t]);
      if (seen || kind === 'rift') this.notify(civ.id, text + ' ' + describeTile(tile), { kind, tile, radius, ...extra });
      else if (kind === 'quake' || kind === 'eruption') this.notify(civ.id, kind === 'quake' ? 'Distant tremors are felt across the land.' : 'A distant volcano darkens the horizon.', { kind: 'rumor' });
    }
  }
  geoWarning(kind, tile, text) {
    for (const civ of this.civs) {
      const hasSensors = civ.techs.has('seismology');
      const nearOwn = this.cityOf(civ).some((c) => dist(c.tile, tile) < 18);
      if (hasSensors && nearOwn) this.notify(civ.id, '[Seismology] ' + text + ' ' + describeTile(tile), { kind: 'warning', tile, radius: 6 });
    }
  }
  onTileFlooded(t) {
    const b = this.buildingAtTile(t);
    if (b && b.type !== 'port') damageBuilding(this, b, 1e9, null, 'flood');
    for (const u of this.unitsAt(t)) { const civ = this.civs[u.owner]; if (!civ.techs.has('sailing')) damageUnit(this, u, 1e9, null, 'flood'); }
    this.world.road[t] = 0;
  }
  damageUnit(u, amount, attacker, cause) { damageUnit(this, u, amount, attacker, cause); }
  damageBuilding(b, amount, attacker, cause) { damageBuilding(this, b, amount, attacker, cause); }
  maxHouses(civ) { return 3 + 2 * civ.age; }

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

  // ----------------------------------------------------------------- cities & buildings
  foundCity(civ, tile, pop = 3, capital = false) {
    const id = this.id_();
    const name = CITY_NAMES[this.cityNameIdx++ % CITY_NAMES.length] + (this.cityNameIdx > CITY_NAMES.length ? ' II' : '');
    const city = { id, owner: civ.id, tile, name, pop, housing: 8, stability: 60, disaster: 0, occupied: 0, unrestT: 0, founded: this.time, capital, foodShort: false, jobs: {}, unemployed: 0 };
    this.cities.set(id, city);
    const w = this.world;
    w.road[tile] = 1; w.touch(tile);
    const b = this.makeBuilding(civ, 'town', tile, true);
    b.cityId = id; city.buildingId = b.id;
    return city;
  }

  makeBuilding(civ, type, tile, done) {
    const def = BUILDINGS[type];
    const b = { id: this.id_(), owner: civ.id, type, tile, hp: done ? def.hp : def.hp * 0.1, maxHp: def.hp, done: !!done, progress: done ? 1 : 0, queue: [], staffed: 0, cityId: -1, cooldown: 0, rally: -1 };
    this.buildings.set(b.id, b);
    this.tileB[tile] = b.id;
    if (type !== 'town') b.cityId = this.nearestCityId(civ.id, tile);
    return b;
  }

  nearestCityId(civId, tile) {
    let best = -1, bd = Infinity;
    for (const c of this.cities.values()) if (c.owner === civId) { const d = dist(c.tile, tile); if (d < bd) { bd = d; best = c.id; } }
    return best;
  }

  removeBuilding(b) {
    this.buildings.delete(b.id);
    if (this.tileB[b.tile] === b.id) this.tileB[b.tile] = -1;
  }

  // Placement rules (server is the single source of truth; clients ask via `placement`).
  canPlace(civ, type, t, ignoreCost = false) {
    const def = BUILDINGS[type]; if (!def || type === 'town') return false;
    const w = this.world, ter = w.terr[t];
    if (def.age > civ.age) return false;
    if (def.tech && !civ.techs.has(def.tech)) return false;
    if (this.tileB[t] >= 0) return false;
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
      case 'mine': if (![RES.IRON, RES.COAL, RES.GOLD].includes(w.res[t])) return false; break;
      case 'coast': { let c = false; for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && isWater(w.terr[n]) && !w.lake[n]) c = true; } if (!c) return false; break; }
      case 'flat': if (ter === T.MOUNTAIN || ter === T.MARSH) return false; break;
      default: break;
    }
    if (!ignoreCost && !this.canAfford(civ, this.buildingCost(civ, type))) return false;
    return true;
  }

  buildingCost(civ, type) {
    const c = { ...BUILDINGS[type].cost };
    if ((type === 'tower' || type === 'fort') && civ.policies.has('fortification')) for (const k in c) c[k] = Math.round(c[k] * 0.75);
    return c;
  }
  unitCost(civ, type) {
    const c = { ...UNITS[type].cost };
    if (civ.policies.has('conscription')) { if (c.food) c.food = Math.round(c.food * 0.7); if (c.gold) c.gold = Math.round(c.gold * 0.7); }
    if (civ.gov === 'junta' && !UNITS[type].civilian) for (const k in c) c[k] = Math.round(c[k] * 0.8);
    if (civ.gov === 'monarchy' && type === 'knight') for (const k in c) c[k] = Math.round(c[k] * 0.8);
    if (type === 'settler' && civ.policies.has('frontier')) for (const k in c) c[k] = Math.round(c[k] * 0.6);
    return c;
  }
  canAfford(civ, cost) { for (const k in cost) if ((civ.res[k] || 0) < cost[k]) return false; return true; }
  pay(civ, cost) { for (const k in cost) civ.res[k] -= cost[k]; }

  placeBuilding(civ, type, tile, instant = false) {
    const cost = this.buildingCost(civ, type);
    if (!instant) this.pay(civ, cost);
    return this.makeBuilding(civ, type, tile, instant);
  }

  canTrain(civ, b, unit) {
    const def = UNITS[unit], bd = BUILDINGS[b.type];
    if (!def || !bd.trains || !bd.trains.includes(unit) || !b.done || b.owner !== civ.id) return 'not available here';
    if (def.age > civ.age) return 'requires ' + AGES[def.age].name;
    if (def.tech && !civ.techs.has(def.tech)) return 'requires ' + TECHS[def.tech].name;
    if (def.needs === 'horses' && !this.civHasResource(civ, RES.HORSES)) return 'requires horses in your territory';
    const city = this.cities.get(b.cityId);
    if (city && city.pop - def.pop < 1) return 'not enough population';
    if (b.queue.length >= 5) return 'queue full';
    if (!this.canAfford(civ, this.unitCost(civ, unit))) return 'cannot afford';
    return null;
  }
  civHasResource(civ, r) { const w = this.world; for (let i = 0; i < N; i++) if (w.owner[i] === civ.id && w.res[i] === r) return true; return false; }

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
      economyStep(this, 1);
      supplyStep(this, 1);
      this.researchStep(1);
      this.geology.step(1, this.time);
      this.diplomacy.step(1);
      this.checkVictory();
    }
    if (t % 20 === 0) recomputeSupply(this);
    if (t % 30 === 0) recomputeTerritory(this);
    if (t % 50 === 0) recomputeTradeNetwork(this);
    if (t % 100 === 0) migrationStep(this);
    for (const civ of this.civs) if (civ.ai && civ.alive && (t + civ.id * 7) % 20 === 0) civ.ai.think();
    if (t % 2 === 0) this.refreshVisibility();
  }

  rebuildTileUnits() {
    this.tileUnits.clear();
    for (const u of this.units.values()) {
      let a = this.tileUnits.get(u.tile); if (!a) this.tileUnits.set(u.tile, a = []); a.push(u.id);
    }
  }

  constructionStep(dt) {
    for (const b of this.buildings.values()) {
      if (b.done) {
        // training queues
        if (b.queue.length) {
          const q = b.queue[0]; q.left -= dt;
          if (q.left <= 0) {
            b.queue.shift();
            const civ = this.civs[b.owner];
            const spot = this.freeTilesNear(b.tile, 2)[0] ?? b.tile;
            const u = spawnUnit(this, civ, q.unit, spot);
            if (b.rally >= 0) this.orderMove(civ, [u.id], b.rally, false);
            this.notify(civ.id, `${UNITS[q.unit].name} ready.`, { kind: 'unit', tile: spot, quiet: true });
          }
        }
        // repair if not in combat
        if (b.hp < b.maxHp && this.time - (b.lastHit || -99) > 10) b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.01 * dt);
        continue;
      }
      const civ = this.civs[b.owner];
      const def = BUILDINGS[b.type];
      b.progress += dt / def.time;
      b.hp = Math.min(b.maxHp, b.hp + (b.maxHp * 0.9 * dt) / def.time);
      if (b.progress >= 1) {
        b.done = true; b.progress = 1;
        this.notify(civ.id, `${def.name} completed.`, { kind: 'build', tile: b.tile, quiet: true });
        if (b.type === 'wonder') { civ.wonder = { since: this.time, id: b.id }; this.notify(-1, `${civ.name} has completed the Grand Exposition! They win if it stands for 5 minutes.`, { kind: 'wonder', tile: b.tile }); }
      }
    }
    // roads
    for (let k = this.roadJobs.length - 1; k >= 0; k--) {
      const j = this.roadJobs[k];
      const civ = this.civs[j.owner];
      j.t -= dt * (civ.policies.has('road_corvee') ? 2 : 1);
      if (j.t > 0) continue;
      const tile = j.tiles[j.i];
      const w = this.world;
      if (!isWater(w.terr[tile]) && Number.isFinite(TERRAIN[w.terr[tile]].move) && (w.owner[tile] === civ.id || w.owner[tile] < 0 || civ.supply[tile])) {
        if (w.road[tile] < j.level) { w.road[tile] = j.level; w.touch(tile); }
      }
      j.i++; j.t = j.level === 2 ? 1.2 : 1.5;
      if (j.i >= j.tiles.length) { this.roadJobs.splice(k, 1); this.notify(civ.id, j.level === 2 ? 'Railway completed.' : 'Road completed.', { kind: 'build', tile, quiet: true }); }
    }
  }

  researchStep(dt) {
    for (const civ of this.civs) {
      if (!civ.alive) continue;
      if (civ.advancing > 0) {
        civ.advancing -= dt;
        if (civ.advancing <= 0) { civ.advancing = 0; civ.age++; this.notify(-1, `${civ.name} has entered the ${AGES[civ.age].name}!`, { kind: 'age' }); }
      }
      if (civ.govCooldown > 0) civ.govCooldown -= dt;
      if (!civ.researching) continue;
      civ.progress += civ.researchRate * dt;
      const tech = TECHS[civ.researching];
      if (civ.progress >= tech.cost) {
        civ.techs.add(civ.researching);
        this.notify(civ.id, `Research complete: ${tech.name}.`, { kind: 'tech' });
        civ.researching = null; civ.progress = 0;
      }
    }
  }

  checkVictory() {
    const alive = this.civs.filter((c) => c.alive);
    for (const civ of alive) {
      if (civ.wonder) {
        const b = this.buildings.get(civ.wonder.id);
        if (!b || b.owner !== civ.id) civ.wonder = null;
        else if (this.time - civ.wonder.since >= 300) return this.endGame(civ, 'Grand Exposition (cultural & industrial victory)');
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
    this.outbox.push([-1, { t: 'over', winner: this.winner, stats: this.civs.map((c) => this.civSummary(c)) }]);
  }

  eliminate(civ) {
    if (!civ.alive) return;
    civ.alive = false;
    for (const u of [...this.units.values()]) if (u.owner === civ.id) this.units.delete(u.id);
    for (const b of [...this.buildings.values()]) if (b.owner === civ.id) this.removeBuilding(b);
    this.notify(-1, `${civ.name} has fallen.`, { kind: 'fall' });
  }

  civSummary(c) {
    const cities = this.cityOf(c);
    const pop = cities.reduce((s, x) => s + x.pop, 0);
    return { id: c.id, name: c.name, alive: c.alive, cities: cities.length, pop: Math.round(pop), techs: c.techs.size, age: c.age, kills: c.kills, casualties: c.casualties,
      score: Math.round(pop + c.techs.size * 10 + cities.length * 25 + c.age * 60 + c.kills * 2) };
  }

  // ----------------------------------------------------------------- visibility & snapshots
  refreshVisibility() {
    const w = this.world;
    for (const civ of this.civs) {
      if (!civ.alive) continue;
      const vis = civ.visible; vis.fill(0);
      const allies = this.civs.filter((o) => o.alive && this.allied(civ.id, o.id)).map((o) => o.id);
      for (const u of this.units.values()) {
        if (!allies.includes(u.owner)) continue;
        let v = UNITS[u.type].vision;
        const tt = w.terr[u.tile]; if (tt === T.HILLS) v += 1; else if (tt === T.MOUNTAIN) v += 2;
        for (const t of disk(u.tile, v)) vis[t] = 1;
      }
      const tele = civ.techs.has('telegraph') ? 1 : 0;
      for (const b of this.buildings.values()) {
        if (!allies.includes(b.owner)) continue;
        for (const t of disk(b.tile, (BUILDINGS[b.type].vision || 2) + tele)) vis[t] = 1;
      }
      for (let i = 0; i < N; i++) { if (w.owner[i] === civ.id) vis[i] = 1; if (vis[i]) { civ.explored[i] = 1; civ.lastOwner[i] = w.owner[i]; } }
      this.updateIntel(civ);
      this.diplomacy.checkContact(civ);
    }
  }

  // What a civilization actually knows about others: cities it has seen (last-known), and the
  // military strength it has observed. AI planning reads only this, never the true world state.
  updateIntel(civ) {
    const vis = civ.visible;
    for (const c of this.cities.values()) if (vis[c.tile]) civ.knownCities.set(c.id, { tile: c.tile, owner: c.owner, name: c.name, seen: this.time });
    for (const [id, k] of civ.knownCities) { if (!vis[k.tile]) continue; const c = this.cities.get(id); if (!c || c.tile !== k.tile) civ.knownCities.delete(id); }
    const seen = {};
    for (const u of this.units.values()) {
      if (u.owner === civ.id || !vis[u.tile]) continue;
      const d = UNITS[u.type]; if (d.civilian) continue;
      seen[u.owner] = (seen[u.owner] || 0) + (d.atk + d.def) * (u.hp / u.maxHp);
    }
    for (const o of this.civs) {
      if (o === civ) continue;
      const prev = civ.intel[o.id] || { peak: 0, seen: 0, time: -1 };
      const now = seen[o.id] || 0;
      // last-known estimate decays slowly toward what is currently observed
      prev.peak = Math.max(now, prev.peak * 0.99995);
      prev.seen = now; if (now > 0) prev.time = this.time;
      civ.intel[o.id] = prev;
    }
  }

  // Build the per-civ messages for this tick. Returns [civId, msg] pairs.
  snapshots(onlyCiv = null) {
    const out = [];
    const w = this.world;
    const full = onlyCiv !== null;
    const econ = this.tickN % 10 === 0 || full;
    for (const civ of this.civs) {
      if (full ? civ.id !== onlyCiv : !civ.connected) continue;
      if (full) { civ.knownVer.fill(0); civ.knownOwner.fill(-2); civ.visKey = ''; civ.knownStab = false; }
      const vis = civ.visible;
      // terrain updates for tiles the civ can see whose state changed since it last looked
      const tiles = [];
      const stabOK = civ.techs.has('surveying');
      for (let i = 0; i < N; i++) {
        if (!vis[i] && !(full && civ.explored[i])) continue;
        if (civ.knownVer[i] !== w.ver[i] || civ.knownOwner[i] !== w.owner[i] || (stabOK && civ.knownStab !== true)) {
          civ.knownVer[i] = w.ver[i]; civ.knownOwner[i] = w.owner[i];
          tiles.push(tileRecord(w, i, stabOK));
        }
      }
      if (stabOK) civ.knownStab = true;
      const units = [];
      for (const u of this.units.values()) {
        if (u.owner !== civ.id && !vis[u.tile]) continue;
        units.push([u.id, u.owner, u.type, u.tile, u.next ?? -1, Math.round(u.prog * 100), Math.round((100 * u.hp) / u.maxHp), Math.round(u.supply),
          (this.time - u.lastCombat < 1.5 ? 1 : 0) | (isWater(w.terr[u.tile]) ? 2 : 0) | (u.outOfSupply ? 4 : 0)]);
      }
      const paths = {};
      for (const u of this.units.values()) if (u.owner === civ.id && u.path.length) paths[u.id] = u.path.slice(0, 40);
      const fx = this.fx.filter((f) => vis[f[1]] || vis[f[2]]);
      let visB64;
      const bytes = packBits(vis);
      const key = bytes.toString('base64');
      if (key !== civ.visKey) { civ.visKey = key; visB64 = key; }
      const msg = { t: 's', time: +this.time.toFixed(1), units, paths, fx };
      if (tiles.length) msg.tiles = tiles;
      if (visB64) msg.vis = visB64;
      if (econ) Object.assign(msg, this.econSnapshot(civ));
      out.push([civ.id, msg]);
    }
    return out;
  }

  econSnapshot(civ) {
    const vis = civ.visible;
    const buildings = [];
    for (const b of this.buildings.values()) {
      if (b.owner !== civ.id && !vis[b.tile]) continue;
      const own = b.owner === civ.id;
      buildings.push({ id: b.id, o: b.owner, ty: b.type, t: b.tile, hp: Math.round((100 * b.hp) / b.maxHp), d: b.done ? 1 : 0, p: Math.round(b.progress * 100),
        ...(own ? { s: b.staffed, q: b.queue.map((q) => [q.unit, Math.max(0, Math.round(q.left))]), c: b.cityId, r: b.rally } : {}) });
    }
    const cities = [];
    for (const c of this.cities.values()) {
      if (c.owner !== civ.id && !vis[c.tile]) continue;
      const own = c.owner === civ.id;
      cities.push({ id: c.id, o: c.owner, n: c.name, t: c.tile, pop: +c.pop.toFixed(1), cap: c.capital ? 1 : 0,
        ...(own ? { h: c.housing, st: Math.round(c.stability), jobs: c.jobs, un: Math.round(c.unemployed), fs: c.foodShort ? 1 : 0, dis: Math.round(c.disaster), occ: Math.round(c.occupied), unrest: c.stability < 20 ? 1 : 0, trade: c.tradeConnected ? 1 : 0 } : {}) });
    }
    const soldiers = [...this.units.values()].filter((u) => u.owner === civ.id).reduce((s, u) => s + UNITS[u.type].pop, 0);
    const me = {
      res: roundObj(civ.res), rates: roundObj(civ.rates, 2), research: civ.researching, progress: Math.round(civ.progress), researchRate: +civ.researchRate.toFixed(2),
      techs: [...civ.techs], age: civ.age, advancing: Math.round(civ.advancing), gov: civ.gov, govCooldown: Math.round(civ.govCooldown), policies: [...civ.policies],
      tax: civ.tax, focus: civ.focus, weariness: Math.round(civ.weariness), soldiers, wonder: civ.wonder ? Math.round(300 - (this.time - civ.wonder.since)) : null,
      roads: this.roadJobs.filter((j) => j.owner === civ.id).map((j) => j.tiles.slice(j.i)),
      proposals: civ.proposals,
    };
    // Other empires reveal only what this civilization could know: nothing before contact,
    // and afterwards only their age (publicly announced) and the cities this civ has seen.
    const civs = this.civs.map((c) => {
      const base = { id: c.id, name: c.name, color: c.color, alive: c.alive, human: c.human };
      if (c.id === civ.id) return { ...base, age: c.age, rel: null, summary: this.civSummary(c) };
      const rel = this.diplomacy.rel(civ.id, c.id);
      if (rel.state === 'unmet') return { ...base, rel: { state: 'unmet' } };
      const knownCities = [...civ.knownCities.values()].filter((k) => k.owner === c.id).length;
      return { ...base, age: c.age, rel, known: { cities: knownCities } };
    });
    return { econ: me, buildings, cities, civs, supply: packBits(civ.supply).toString('base64') };
  }

  // ----------------------------------------------------------------- commands
  command(civId, cmd) {
    const civ = this.civs[civId];
    if (!civ || !civ.alive || this.over) return { error: 'not active' };
    try {
      switch (cmd.c) {
        case 'move': return this.orderMove(civ, cmd.units, cmd.tile, !!cmd.attackMove);
        case 'attack': return this.orderAttack(civ, cmd.units, cmd.target);
        case 'stop': for (const id of cmd.units || []) { const u = this.units.get(id); if (u && u.owner === civ.id) { u.path = []; u.order = { kind: 'idle' }; u.goal = -1; } } return null;
        case 'build': {
          if (!this.canPlace(civ, cmd.type, cmd.tile)) return { error: 'Cannot build there' };
          this.placeBuilding(civ, cmd.type, cmd.tile); return null;
        }
        case 'placement': {
          const tiles = [];
          for (let i = 0; i < N; i++) if (civ.explored[i] && this.canPlace(civ, cmd.type, i, true)) tiles.push(i);
          return { reply: { t: 'placement', type: cmd.type, tiles, afford: this.canAfford(civ, this.buildingCost(civ, cmd.type)) } };
        }
        case 'road': return this.orderRoad(civ, cmd.from, cmd.to, cmd.rail ? 2 : 1);
        case 'demolish': { const b = this.buildings.get(cmd.id); if (b && b.owner === civ.id && b.type !== 'town') { this.removeBuilding(b); } return null; }
        case 'train': {
          const b = this.buildings.get(cmd.building);
          if (!b) return { error: 'no building' };
          const why = this.canTrain(civ, b, cmd.unit); if (why) return { error: why };
          this.pay(civ, this.unitCost(civ, cmd.unit));
          const city = this.cities.get(b.cityId); if (city) city.pop -= UNITS[cmd.unit].pop;
          b.queue.push({ unit: cmd.unit, left: UNITS[cmd.unit].time });
          return null;
        }
        case 'rally': { const b = this.buildings.get(cmd.building); if (b && b.owner === civ.id) b.rally = cmd.tile; return null; }
        case 'found': {
          const u = this.units.get(cmd.unit);
          if (!u || u.owner !== civ.id || u.type !== 'settler') return { error: 'need a settler' };
          const why = this.canFound(civ, u.tile); if (why) return { error: why };
          this.units.delete(u.id);
          const c = this.foundCity(civ, u.tile, civ.policies.has('frontier') ? 4 : 3);
          this.notify(civ.id, `New city founded: ${c.name}.`, { kind: 'city', tile: c.tile });
          recomputeTerritory(this);
          return null;
        }
        case 'research': {
          const tech = TECHS[cmd.tech];
          if (!tech || civ.techs.has(cmd.tech) || tech.age > civ.age) return { error: 'unavailable' };
          if (civ.researching !== cmd.tech) { civ.researching = cmd.tech; civ.progress = 0; }
          return null;
        }
        case 'advance': {
          const next = AGES[civ.age + 1]; if (!next || civ.advancing) return { error: 'cannot advance' };
          const have = [...civ.techs].filter((t) => TECHS[t].age === civ.age).length;
          if (have < next.techsNeeded) return { error: `need ${next.techsNeeded} ${AGES[civ.age].name} techs` };
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

  orderMove(civ, ids, tile, attackMove) {
    if (!(tile >= 0 && tile < N)) return { error: 'bad tile' };
    const units = (ids || []).map((id) => this.units.get(id)).filter((u) => u && u.owner === civ.id);
    // spread a group over the destination area so they do not all stack on one hex
    const spots = units.length > 1 ? disk(tile, units.length > 7 ? 2 : 1).filter((t) => Number.isFinite(TERRAIN[this.world.terr[t]].move) || isWater(this.world.terr[t])) : [tile];
    const results = { reached: 0, partial: 0, unreachable: 0 };
    units.forEach((u, k) => {
      const dest = spots[k % spots.length];
      const path = u.tile === dest ? [] : findPath(this, civ, u.tile, dest, u.type);
      u.path = path || [];
      u.goal = path && path.partial ? path[path.length - 1] : dest;
      u.order = { kind: attackMove ? 'attackMove' : 'move' };
      if (!path && u.tile !== dest) results.unreachable++;
      else if (path && path.partial) results.partial++;
      else results.reached++;
    });
    return { reply: { t: 'ack', order: results } };
  }

  orderAttack(civ, ids, target) {
    for (const id of ids || []) {
      const u = this.units.get(id);
      if (!u || u.owner !== civ.id || UNITS[u.type].atk <= 0) continue;
      u.order = { kind: 'attack', target };
      u.repathAt = 0;
    }
    return null;
  }

  orderRoad(civ, from, to, level) {
    if (level === 2 && !civ.techs.has('railroads')) return { error: 'requires Railroads' };
    const route = findRoadRoute(this, civ, from, to);
    if (!route) return { error: 'No valid road route (rivers need Engineering for bridges)' };
    const tiles = route.filter((t) => this.world.road[t] < level);
    if (!tiles.length) return null;
    const per = level === 2 ? { iron: 2, coal: 1 } : { wood: 2, stone: 1 };
    const mult = civ.policies.has('road_corvee') ? 0.5 : 1;
    const cost = {}; for (const k in per) cost[k] = Math.ceil(per[k] * tiles.length * mult);
    if (!this.canAfford(civ, cost)) return { error: `Road needs ${Object.entries(cost).map(([k, v]) => v + ' ' + k).join(', ')}` };
    if (this.roadJobs.filter((j) => j.owner === civ.id).length >= 4) return { error: 'Too many road projects at once' };
    this.pay(civ, cost);
    this.roadJobs.push({ owner: civ.id, tiles, i: 0, t: 1, level });
    return null;
  }

  clearPass(civ, t) {
    const w = this.world;
    if (w.terr[t] !== T.PEAK) return { error: 'only impassable peaks can be cleared' };
    if (!civ.techs.has('engineering')) return { error: 'requires Engineering' };
    if (!civ.supply[t] && !disk(t, 1).some((n) => civ.supply[n])) return { error: 'must be within your supply network' };
    const cost = civ.techs.has('explosives') ? { stone: 30, gold: 40 } : { stone: 120, gold: 120, equip: 20 };
    if (!this.canAfford(civ, cost)) return { error: 'cannot afford' };
    this.pay(civ, cost);
    w.elev[t] = 0.6; w.stab[t] = Math.max(0.1, w.stab[t] - 0.1); w.classify(t); w.touch(t);
    this.notify(civ.id, 'Engineers have blasted a passage through the peaks.', { kind: 'build', tile: t });
    return null;
  }
}

function packBits(arr) {
  const out = Buffer.alloc(Math.ceil(arr.length / 8));
  for (let i = 0; i < arr.length; i++) if (arr[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}
function roundObj(o, d = 0) { const r = {}; for (const k in o) r[k] = +(+o[k]).toFixed(d); return r; }
export { packBits, W, qOf, rOf };
