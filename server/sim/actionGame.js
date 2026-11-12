import { Game } from './game.js';
import { DT, N, T } from './constants.js';
import { ACTION_RULESET } from './rulesets.js';
import { disk, NB } from './hex.js';
import { Scheduler } from './scheduler.js';
import { addCrater, addSmoke, battlefieldSnapshot, battlefieldStep, rememberBattlefield, smokeAt } from './battlefield.js';
import { bridgesFor } from './bridges.js';
import { actionDefinitions, ACTION_BUILDINGS, ACTION_UNITS, OUTPOST_TYPES } from './actionDefinitions.js';
import { ActionNavigation, centerOf, distance, dxBetween, SpatialIndex, tileAt, wrapX } from './actionNavigation.js';
import { buildActionMap } from './actionMap.js';
import { deployLine, moveGroup, ownedUnits, stopUnit, unitMotion } from './actionOrders.js';
import { actionCombat, bombard, canEngage } from './actionCombat.js';
import {
  addFacility, advanceBase, armyCapacity, cancelTraining, construct, constructDefense, establish, headquarters,
  missileCommand, openSlots, productionStep, repairFacility, startUpgrade, train, trenchLine, useAbility,
} from './actionBases.js';
import { planActionAI } from './actionAI.js';
import { collectOrder, fieldEconomyStep, roadBuild, seedMaterialCaches, visibleCaches } from './actionEconomy.js';
import { emit } from './combat.js';

const round = (n, f = 100) => Math.round(n * f) / f;
const VALID_SCENARIOS = new Set(['domination', 'control', 'operation']);
const MAX_TEAMS = 12;
const VEHICLE_SPAWN_GAP = .035;

export class ActionGame extends Game {
  constructor(options) {
    super({ ...options, ruleset: ACTION_RULESET, restore: true });
    this.defs = actionDefinitions(this.defs);
    this.scenario = VALID_SCENARIOS.has(options.objective) ? options.objective : 'domination';
    this.tutorial = !!options.tutorial;
    this.tutorialSite = 0;
    this.teamSize = Number.isInteger(options.teamSize) ? Math.min(4, Math.max(1, options.teamSize)) : 1;
    this.nav = new ActionNavigation(this);
    this.movers = new SpatialIndex(.76);
    this.targets = new SpatialIndex(3.2);
    this.buildingCells = new Map();
    this.materialCaches = new Map();
    this.roadProjects = [];
    this.armyLimit = Math.max(80, Math.min(1600, Number(options.armyLimit) || 240));
    this.search = [];
    this.fogCache = new Map();
    this.teamHold = new Array(MAX_TEAMS).fill(0);
    this.engagements = new Map();
    this.reports = [];
    for (const civ of this.civs) {
      civ.team = Math.floor(civ.id / this.teamSize);
      civ.res = { materials: 500, energy: 100 };
      civ.rates = { materials: 0, energy: 0 };
      civ.siteIntel = new Map();
      civ.ruinIntel = new Map();
      civ.cacheIntel = new Map();
      civ.recoveryUntil = null;
      civ.emergencyUsed = false;
      civ.groups = new Map();
      civ.fairPlay = true;
      civ.aiPlan = civ.isAI ? { state: 'Opening', since: 0, next: 3, target: 0, troops: [], notes: [] } : null;
    }
    if (options.restore) return;
    this.setSites(buildActionMap(this));
    for (const civ of this.civs) this.begin(civ, this.sites[civ.id]);
    seedMaterialCaches(this);
    if (this.tutorial && this.civs.length > 1) {
      const start = this.sites[0];
      const site = this.sites.filter((s) => s.slots && s.owner < 0).sort((a, b) => distance(start, a) - distance(start, b))[0];
      if (site) {
        this.tutorialSite = site.id;
        this.spawn(this.civs[1], 'militia', site, .75);
        this.spawn(this.civs[1], 'militia', site, 1.3);
      }
    }
    this.refreshTerritory();
    this.refreshVisibility();
  }

  setSites(sites) {
    this.sites = sites;
    this.siteById = new Map(sites.map((s) => [s.id, s]));
    this.siteByTile = new Map(sites.map((s) => [s.tile, s]));
    this.reservedTiles = new Set(sites.flatMap((s) => [s.tile, ...(s.parcels || []).map((p) => p.tile)]));
    this.ringRoads = new Map();
    for (const site of sites) {
      if (!site.slots) continue;
      const nodes = site.parcels.filter((p) => p.id).map((p) => ({ x: site.x + (p.x - site.x) * .57, z: site.z + (p.z - site.z) * .57 }));
      for (let i = 0; i < 8; i++) {
        const p0 = nodes[(i + 7) % 8], p1 = nodes[i], p2 = nodes[(i + 1) % 8], p3 = nodes[(i + 2) % 8];
        let a = p1;
        for (let k = 1; k <= 8; k++) {
          const t = k / 8, t2 = t * t, t3 = t2 * t;
          const value = (key) => .5 * (2 * p1[key] + (-p0[key] + p2[key]) * t +
            (2 * p0[key] - 5 * p1[key] + 4 * p2[key] - p3[key]) * t2 + (-p0[key] + 3 * p1[key] - 3 * p2[key] + p3[key]) * t3);
          const b = { x: value('x'), z: value('z') }, tile = tileAt((a.x + b.x) * .5, (a.z + b.z) * .5);
          for (const n of [tile, ...Array.from({ length: 6 }, (_, d) => NB[tile * 6 + d])]) {
            if (n < 0) continue;
            if (!this.ringRoads.has(n)) this.ringRoads.set(n, []);
            this.ringRoads.get(n).push({ a, b });
          }
          a = b;
        }
      }
    }
  }

  begin(civ, site) {
    site.owner = civ.id;
    site.claimedAt = 0;
    site.reclaimed = true;
    site.everEstablished = true;
    site.developedAt = this.time;
    addFacility(this, civ, site, 'town', site.tile, { instant: true });
    for (const [i, type] of ['rifle_squad', 'rifle_squad', 'rifle_squad', 'engineer', 'scout_buggy'].entries())
      this.spawn(civ, type, site, 1.15 + i * .11);
  }

  registerBuilding(b) {
    for (const tile of [b.tile, ...Array.from({ length: 6 }, (_, d) => NB[b.tile * 6 + d])]) {
      if (tile < 0) continue;
      if (!this.buildingCells.has(tile)) this.buildingCells.set(tile, new Set());
      this.buildingCells.get(tile).add(b.id);
    }
    this.tileB[b.tile] = b.id;
  }

  obstaclesAtTile(tile) { return [...(this.buildingCells.get(tile) || [])].map((id) => this.buildings.get(id)).filter(Boolean); }
  buildingAtTile(tile) { return this.obstaclesAtTile(tile).find((b) => b.tile === tile) || null; }
  rebuildBuildingIndex() {
    this.buildingCells.clear(); this.tileB.fill(-1);
    for (const b of this.buildings.values()) this.registerBuilding(b);
  }
  removeBuilding(b) {
    this.buildings.delete(b.id);
    for (const tile of [b.tile, ...Array.from({ length: 6 }, (_, d) => NB[b.tile * 6 + d])]) {
      const set = this.buildingCells.get(tile); if (!set) continue;
      set.delete(b.id); if (!set.size) this.buildingCells.delete(tile);
    }
    this.tileB[b.tile] = this.buildingAtTile(b.tile)?.id ?? -1;
    this.world.touch(b.tile);
    this.nav.invalidate();
  }

  dx(a, b) { return dxBetween(a, b); }
  lerpPoint(a, b, t) { return { x: wrapX(a.x + dxBetween(a.x, b.x) * t), z: a.z + (b.z - a.z) * t }; }
  allied(a, b) { return a === b || a >= 0 && b >= 0 && this.civs[a]?.team === this.civs[b]?.team; }
  hostile(a, b) { return a !== b && !this.allied(a, b); }
  detects(id, u) { return this.sees(this.civs[id], u); }

  spawn(civ, type, from, outer = 1.2) {
    const d = ACTION_UNITS[type], near = this.search;
    const occupied = (x, z) => this.movers.query(x, z, .73, near).some((u) =>
      u.hp > 0 && distance({ x, z }, u) < d.radius + ACTION_UNITS[u.type].radius + VEHICLE_SPAWN_GAP);
    let point = null;
    const start = this.nextId * 2.39996;
    for (let ring = 0; ring < 3 && !point; ring++) for (let n = 0; n < 8; n++) {
      const a = start + n * Math.PI / 4, r = outer + ring * .46;
      const x = wrapX(from.x + Math.sin(a) * r), z = from.z + Math.cos(a) * r;
      if (this.nav.canStand(x, z, d) && (d.air || !occupied(x, z))) { point = { x, z }; break; }
    }
    if (!point) return null;
    const u = { id: this.id_(), owner: civ.id, type, isUnit: true, ...point, tile: tileAt(point.x, point.z),
      yaw: Math.atan2(dxBetween(from.x, point.x), point.z - from.z), vx: 0, vz: 0, speed: 0,
      hp: d.hp, maxHp: d.hp, radius: d.radius, mode: 'guard', goal: null, path: [], orders: [], lastCombat: -999,
      readyAt: 0, abilityReady: 0, abilityUntil: 0, blocked: 0, target: 0, kills: 0,
      altitude: d.air ? from.type === 'airfield' || from.type === 'advanced_lab' ? .06 : d.alt === 'high' ? 2 : .8 : 0,
      airBase: d.air && from.type ? from.id : 0, grounded: false, formation: 0 };
    this.units.set(u.id, u);
    if (!d.air) this.movers.add(u);
    return u;
  }

  clearFootprint(b) {
    for (const u of this.movers.query(b.x, b.z, b.radius + .30, []).filter((u) => u.hp > 0 && distance(u, b) < b.radius + u.radius)) {
      const d = ACTION_UNITS[u.type];
      const spot = this.nav.nearest(u, d, 1.6, (x, z) => this.movers.query(x, z, .65, this.search).every((v) =>
        v === u || v.hp <= 0 || distance(v, { x, z }) > d.radius + v.radius));
      if (!spot) continue;
      const x = u.x, z = u.z;
      Object.assign(u, spot);
      u.tile = tileAt(u.x, u.z);
      this.movers.moved(u, x, z);
      if (u.goal) u.path = this.nav.route(u, u.goal, d) || [];
    }
  }

  loseBuilding(b) {
    if (!this.buildings.has(b.id)) return;
    const site = this.siteById.get(b.site);
    if (b.slot && site) (site.history ??= {})[b.slot] = { type: b.type, owner: b.owner, at: this.time };
    this.removeBuilding(b);
    this.addRuin(b.tile, b.type === 'town' ? site.ruin : b.type, b.owner, site?.name || 'Field position');
    this.nav.invalidate();
    if (b.type !== 'town') return;
    this.notify(b.owner, `${site.name} headquarters lost.`, { kind: 'loss', level: 'critical', tile: site.tile });
    for (const other of [...this.buildings.values()]) if (other.site === site.id && !ACTION_BUILDINGS[other.type].field) {
      if (other.slot) (site.history ??= {})[other.slot] = { type: other.type, owner: other.owner, at: this.time };
      this.removeBuilding(other);
      this.addRuin(other.tile, other.type, other.owner, site.name);
    }
    site.hq = 0;
    site.maturityElapsed = Math.min(35, Math.max(0, this.time - site.developedAt));
    site.owner = -1;
    site.progress = 0;
    site.by = -1;
    site.tier = 1;
    site.contested = false;
    site.claimedAt = -1;
    site.visualTier = Math.max(site.visualTier || 1, site.tier);
    addCrater(this, b.tile, .65, 'shell', { x: 0, z: 0 });
    addSmoke(this, b.tile, .73, 28);
    this.refreshTerritory();
  }

  hasEnemyAt(site, owner) {
    return this.movers.query(site.x, site.z, site.radius, this.search).some((u) => u.hp > 0 && this.hostile(owner, u.owner));
  }

  hasEngineer(civ, p, range) {
    return this.movers.query(p.x, p.z, range, this.search).some((u) => u.hp > 0 && u.owner === civ.id && u.type === 'engineer');
  }

  repairAround(civ, p, range, amount, includeBuildings = false) {
    const budget = amount * (civ.techs.has('field_engineering') ? 1.25 : 1);
    const options = this.targets.query(p.x, p.z, range, this.search).filter((v) =>
      v.id !== p.id && v.hp > 0 && this.allied(civ.id, v.owner) && v.hp < v.maxHp && (v.isUnit || includeBuildings && v.done));
    options.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id - b.id);
    for (const v of options.slice(0, 4)) v.hp = Math.min(v.maxHp, v.hp + budget);
  }

  bombard(u, point) { bombard(this, u, point); }

  returnAircraft(u) {
    const available = [...this.buildings.values()].filter((b) => b.owner === u.owner && b.done &&
      (b.type === 'airfield' || b.type === 'advanced_lab' && u.type.includes('drone')));
    available.sort((a, b) => distance(u, a) - distance(u, b) || a.id - b.id);
    const b = available[0];
    if (!b) { u.airOrder = { kind: 'patrol', point: { x: u.x, z: u.z }, phase: 0 }; return false; }
    const point = this.nav.nearest({ x: b.x + .32, z: b.z + .27 }, ACTION_UNITS[u.type]);
    if (!point) return false;
    const result = moveGroup(this, [u], point, { mode: 'move' });
    if (result.error) return false;
    u.airOrder = { kind: 'return', point, base: b.id };
    u.airBase = b.id;
    return true;
  }

  reinforce(b, u) {
    const civ = this.civs[b.owner];
    const group = b.rallyGroup ? civ.groups.get(b.rallyGroup) : null;
    const members = group ? group.units.map((id) => this.units.get(id)).filter((v) => v?.owner === b.owner) : [];
    if (members.length) {
      const first = members[0], d = ACTION_UNITS[u.type];
      const compatible = members.filter((v) => ACTION_UNITS[v.type].air === d.air);
      const target = compatible[0] || first;
      const position = target.goal || target;
      const radius = .4 + Math.sqrt(compatible.length) * .11;
      const a = u.id * 2.39996;
      const point = this.nav.nearest({ x: wrapX(position.x + Math.sin(a) * radius), z: position.z + Math.cos(a) * radius }, d);
      if (point) moveGroup(this, [u], point, { mode: 'assault' });
      group.units.push(u.id);
      u.formation = b.rallyGroup;
      return;
    }
    if (b.rally) moveGroup(this, [u], b.rally, { mode: 'assault' });
  }

  recordEngagement(source, target, weapon, damage) {
    const owners = [source.owner, target.owner].sort((a, b) => a - b);
    const key = `${owners[0]}:${owners[1]}:${Math.floor(target.x / 10)}:${Math.floor(target.z / 10)}`;
    let battle = this.engagements.get(key);
    if (!battle) {
      if (this.engagements.size >= 96) return;
      const site = this.sites.reduce((a, b) => distance(target, a) < distance(target, b) ? a : b);
      battle = { key, owners, tile: target.tile, name: site.name, from: this.time, last: this.time, losses: {}, weapons: {}, cover: {}, damage: 0 };
      this.engagements.set(key, battle);
    }
    battle.last = this.time;
    battle.damage += damage;
    const side = String(target.owner);
    const attacker = this.units.get(source.id);
    if (attacker && ACTION_UNITS[attacker.type].move === 'infantry' && this.world.terr[source.tile] === T.FOREST && this.civs[target.owner]?.visible[source.tile])
      battle.cover[target.owner] = 'Attackers fired from forest cover.';
    (battle.weapons[side] ??= {})[weapon] = ((battle.weapons[side] || {})[weapon] || 0) + damage;
    if (target.hp <= 0) battle.losses[side] = (battle.losses[side] || 0) + 1;
    if (!target.isUnit && this.time - (this.civs[target.owner].underAttackAt || -30) > 25) {
      this.civs[target.owner].underAttackAt = this.time;
      this.notify(target.owner, `${this.siteById.get(target.site)?.name || ACTION_BUILDINGS[target.type]?.name || 'Forward position'} is under attack.`, { kind: 'war', tile: target.tile, level: 'major' });
    }
  }

  engagementReports() {
    const descriptions = { atgun: 'anti-armor fire', howitzer: 'artillery', mortar: 'mortar fire', bombs: 'air strikes',
      cannon: 'armored fire', rifle: 'rifle fire', rockets: 'rocket strikes', flak: 'air defenses', missile: 'guided missiles' };
    for (const [key, battle] of this.engagements) {
      if (this.time - battle.last < 16) continue;
      this.engagements.delete(key);
      if (battle.damage < 110) continue;
      this.reports.push(battle);
      if (this.reports.length > 30) this.reports.shift();
      for (const id of battle.owners) {
        const own = battle.losses[id] || 0;
        if (!own && !this.civs[id]?.visible[battle.tile]) continue;
        const causes = Object.entries(battle.weapons[id] || {}).sort((a, b) => b[1] - a[1]);
        const cause = causes.length ? descriptions[causes[0][0]] || 'direct fire' : 'enemy fire';
        this.notify(id, `${own} friendly units lost near ${battle.name}. ${cause.charAt(0).toUpperCase() + cause.slice(1)} caused the most damage.${battle.cover[id] ? ' ' + battle.cover[id] : ''}`,
          { kind: 'result', title: `Battle near ${battle.name}`, tile: battle.tile });
      }
    }
  }

  captureStep(dt) {
    let ownershipChanged = false;
    for (const site of this.sites) {
      if (site.hq) continue;
      const nearby = this.movers.query(site.x, site.z, site.radius, this.search).filter((u) => u.hp > 0 && this.civs[u.owner].alive);
      const teams = new Set(nearby.map((u) => this.civs[u.owner].team));
      site.contested = teams.size > 1;
      if (site.contested) {
        site.last = this.time;
        if (site.owner >= 0 && (site.contestedNotice ?? -20) + 18 < this.time) {
          site.contestedNotice = this.time;
          this.notify(site.owner, `${site.name} is contested.`, { kind: 'warning', tile: site.tile });
        }
        continue;
      }
      const claimant = nearby.find((u) => u.owner === site.by && ACTION_UNITS[u.type].capture) ||
        nearby.find((u) => ACTION_UNITS[u.type].capture && (site.owner < 0 || this.hostile(site.owner, u.owner)));
      if (!claimant || site.owner >= 0 && !this.hostile(site.owner, claimant.owner)) {
        if (this.time - site.last > 3.5) {
          site.progress = Math.max(0, site.progress - dt * 1.45);
          if (!site.progress) site.by = -1;
        }
        continue;
      }
      if (site.by !== claimant.owner && (site.by < 0 || !this.allied(site.by, claimant.owner))) site.progress = 0;
      site.by = claimant.owner;
      site.last = this.time;
      site.progress += dt;
      if (site.progress + .00001 < site.captureTime) continue;
      const prev = site.owner;
      site.owner = claimant.owner;
      if (!site.reclaimed) {
        site.reclaimed = true;
        this.civs[site.owner].res.materials += site.slots ? 75 : 30;
      }
      site.claimedAt = this.time;
      emit(this, { k: 'capture', b: site.tile, bx: site.x, bz: site.z, ow: site.owner });
      site.progress = 0;
      site.by = -1;
      ownershipChanged = true;
      this.notify(site.owner, site.slots ? `${site.name} secured. Establish a headquarters.` : `${site.name} secured. ${OUTPOST_TYPES[site.kind].benefit}.`,
        { kind: 'capture', site: site.id, tile: site.tile, level: 'major' });
      if (prev >= 0) this.notify(prev, `${site.name} was captured.`, { kind: 'loss', tile: site.tile });
    }
    if (ownershipChanged) this.refreshTerritory();
  }

  refreshTerritory() {
    const next = new Int8Array(N).fill(-1);
    for (const s of this.sites) if (s.owner >= 0) {
      const rad = s.slots ? headquarters(this, s)?.done ? 3 : 2 : 1;
      for (const t of disk(s.tile, rad)) if (next[t] < 0 || t === s.tile) next[t] = s.owner;
    }
    for (let t = 0; t < N; t++) if (this.world.owner[t] !== next[t]) {
      this.world.owner[t] = next[t];
      this.world.touch(t);
    }
  }

  sees(civ, entity) {
    if (!civ || entity.hp <= 0) return false;
    if (this.allied(civ.id, entity.owner) || this.sandboxReveal && civ.human) return true;
    if (!civ.visible[entity.tile]) return false;
    const stealth = entity.type === 'special_forces' && entity.abilityUntil > this.time;
    return !entity.isUnit || (!stealth && smokeAt(this, entity.tile) < .55) || !!civ.detect[entity.tile];
  }

  reveal(source, radius, buffer) {
    const reach = Math.ceil(radius / 1.49) + 1;
    const quantX = Math.round(source.x * 2), quantZ = Math.round(source.z * 2);
    const key = `${source.tile}:${quantX}:${quantZ}:${radius}`;
    let tiles = this.fogCache.get(key);
    if (!tiles) {
      tiles = disk(source.tile, reach).filter((t) => distance({ x: quantX * .5, z: quantZ * .5 }, centerOf(t)) <= radius + .38);
      if (this.fogCache.size >= 3500) this.fogCache.delete(this.fogCache.keys().next().value);
      this.fogCache.set(key, tiles);
    }
    for (const t of tiles) buffer[t] = 1;
    buffer[source.tile] = 1;
  }

  refreshVisibility() {
    for (const civ of this.civs) { civ.visible.fill(0); civ.detect.fill(0); }
    const sources = [...this.units.values(), ...this.buildings.values()];
    for (const source of sources) {
      const own = this.civs[source.owner], d = source.isUnit ? ACTION_UNITS[source.type] : ACTION_BUILDINGS[source.type];
      let vision = d.vision || 5.1;
      if (!d.air && this.world.terr[source.tile] === T.HILLS) vision += 1.05;
      if (this.weather.fogAt(source.tile) > .55) vision -= .9;
      const scan = d.ability === 'scan' && source.abilityUntil > this.time;
      if (scan) vision += 3.5;
      for (const civ of this.civs) if (civ.alive && civ.team === own.team) {
        this.reveal(source, vision, civ.visible);
        this.reveal(source, scan ? vision : 1.52, civ.detect);
      }
    }
    for (const s of this.sites) if (s.owner >= 0) {
      const radar = !s.slots && OUTPOST_TYPES[s.kind].vision;
      for (const civ of this.civs) if (civ.alive && this.allied(civ.id, s.owner)) {
        this.reveal(s, radar || (s.slots ? 3.8 : 2.5), civ.visible);
        if (radar) this.reveal(s, radar, civ.detect);
      }
    }
    for (const civ of this.civs) {
      if (!civ.alive) continue;
      if (this.sandboxReveal && civ.human) { civ.visible.fill(1); civ.detect.fill(1); }
      if (this.tutorial && civ.human && this.tutorialSite) this.reveal(this.siteById.get(this.tutorialSite), 2.2, civ.visible);
      for (let t = 0; t < N; t++) if (civ.visible[t]) {
        civ.explored[t] = 1;
        civ.lastOwner[t] = this.world.owner[t];
      }
      for (const s of this.sites) if (civ.visible[s.tile]) civ.siteIntel.set(s.id, this.siteWire(s, civ, true));
      for (const [tile] of civ.ruinIntel) if (civ.visible[tile] && !this.ruins.has(tile)) civ.ruinIntel.delete(tile);
      for (const [tile, r] of this.ruins) if (civ.visible[tile]) civ.ruinIntel.set(tile, r.type);
      if (civ.human || this.observer?.follow === civ.id) { rememberBattlefield(this, civ); this.rememberStructures(civ); }
    }
  }

  tick() {
    if (this.over) return;
    this.tickN++;
    this.time = this.tickN * DT;
    if (!this.sched) this.sched = new Scheduler([
      { name: 'navigation', fn: () => unitMotion(this), budget: 15 },
      { name: 'combat', fn: () => actionCombat(this), budget: 15 },
      { name: 'capture', every: 2, fn: () => this.captureStep(DT * 2), budget: 4 },
      { name: 'field economy', every: 2, fn: () => fieldEconomyStep(this, DT * 2), budget: 4 },
      { name: 'production', every: 3, phase: 1, fn: () => productionStep(this, DT * 3), budget: 4 },
      { name: 'visibility', every: 4, phase: 1, fn: () => this.refreshVisibility(), budget: 9 },
      { name: 'weather', every: 10, phase: 2, fn: () => this.weather.step(1, (this.time / 600) % 1), budget: 3 },
      { name: 'warzone', every: 10, phase: 5, fn: () => {
        battlefieldStep(this, 1, { fieldPositions: false });
        this.engagementReports();
        this.world.dirty.clear();
      }, budget: 4 },
      { name: 'ai', every: 3, deferrable: true, fn: () => this.runAI(), budget: 15 },
      { name: 'victory', every: 10, fn: () => this.checkVictory(), budget: 4 },
    ], { adaptive: !!this.adaptive });
    this.sched.run(this.tickN, this);
  }

  runAI() {
    if (this.sandbox) return;
    const next = this.civs.find((c) => c.alive && c.aiPlan?.next <= this.time);
    if (next) planActionAI(this, next);
  }

  checkVictory() {
    if (this.sandbox || this.civs.length < 2) return;
    for (const civ of this.civs) {
      if (!civ.alive) continue;
      const sites = this.sites.filter((s) => s.owner === civ.id && s.slots);
      if (sites.some((s) => headquarters(this, s)?.done)) { civ.recoveryUntil = null; continue; }
      if (civ.recoveryUntil == null) {
        civ.recoveryUntil = this.time + 58;
        this.notify(civ.id, 'Command lost. Secure a ruin and restore a headquarters.', { kind: 'loss', level: 'critical' });
      }
      if (sites.some((s) => s.hq)) continue;
      const captureForce = [...this.units.values()].some((u) => u.owner === civ.id && ACTION_UNITS[u.type].capture);
      const secured = sites.some((s) => !s.hq) && civ.res.materials >= (civ.emergencyUsed ? ACTION_BUILDINGS.town.cost.materials : 140);
      if ((captureForce || secured) && this.time < civ.recoveryUntil) continue;
      civ.alive = false;
      for (const u of this.units.values()) if (u.owner === civ.id) { u.hp = 0; this.units.delete(u.id); }
      for (const b of [...this.buildings.values()]) if (b.owner === civ.id) this.loseBuilding(b);
      for (const s of this.sites) if (s.owner === civ.id) { s.owner = -1; s.claimedAt = -1; s.tier = 1; }
      this.refreshTerritory();
      this.notify(-1, `${civ.name} has fallen.`, { kind: 'fall' });
    }
    const alive = this.civs.filter((c) => c.alive);
    const teams = new Set(alive.map((c) => c.team));
    if (teams.size <= 1) {
      if (alive.length) this.endGame(alive[0], 'Military Domination');
      else {
        this.over = true;
        this.winner = { civ: -1, name: 'Draw', how: 'Both sides lost command' };
        this.outbox.push([-1, { t: 'over', winner: this.winner }]);
      }
      return;
    }
    if (this.scenario === 'domination') return;
    const objectives = this.scenario === 'operation' ? this.sites.filter((s) => s.kind === 'metro') : this.sites.filter((s) => s.slots);
    if (!objectives.length) return;
    for (const team of teams) {
      const count = objectives.filter((s) => s.owner >= 0 && this.civs[s.owner].team === team && !s.contested).length;
      this.teamHold[team] = count > objectives.length / 2 ? this.teamHold[team] + 1 : 0;
      if (this.teamHold[team] >= (this.scenario === 'operation' ? 80 : 105)) {
        this.endGame(alive.find((c) => c.team === team), this.scenario === 'operation' ? 'Operation secured' : 'Territorial Control');
        break;
      }
    }
  }

  civSummary(c) {
    const sites = this.sites.filter((s) => s.owner === c.id && headquarters(this, s)?.done).length;
    return { id: c.id, name: c.name, team: c.team, alive: c.alive, cities: sites, age: c.age, kills: c.kills,
      casualties: c.casualties, posture: c.aiPlan?.state, score: sites * 40 + c.kills * 3 };
  }

  point(raw, tile) {
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.z) && Math.abs(raw.x) < 10000 && Math.abs(raw.z) < 1000) {
      const point = { x: wrapX(raw.x), z: raw.z };
      if (tileAt(point.x, point.z) >= 0) return point;
    }
    if (Number.isInteger(tile) && tile >= 0 && tile < N) return centerOf(tile);
    return null;
  }

  command(civId, cmd) {
    const civ = this.civs[civId];
    if (!civ?.alive || this.over) return { error: 'Your faction is no longer active.' };
    const p = this.point(cmd.point || cmd, cmd.tile), group = ownedUnits(this, civ, cmd.units);
    if (['move', 'capture', 'attack', 'hold', 'withdraw', 'deploy', 'collect'].includes(cmd.c)) for (const u of group) u.supportTask = null;
    const site = this.siteById.get(cmd.site) || this.siteById.get(this.buildings.get(cmd.id)?.site);
    switch (cmd.c) {
      case 'move': return p ? moveGroup(this, group, p, { mode: cmd.attackMove ? 'assault' : 'move', queue: cmd.queue === true }) : { error: 'Choose a destination.' };
      case 'collect': return collectOrder(this, civ, group, cmd.cache, cmd.queue === true);
      case 'capture': {
        if (!site || !civ.siteIntel.has(site.id) && !civ.visible[site.tile]) return { error: 'Scout that objective first.' };
        return moveGroup(this, group, site, { mode: 'assault', exact: true, queue: cmd.queue === true });
      }
      case 'attack': {
        const target = this.units.get(cmd.target) || this.buildings.get(cmd.target);
        if (!target || !this.hostile(civ.id, target.owner) || !this.sees(civ, target)) return { error: 'Select a visible hostile target.' };
        const eligible = group.filter((u) => canEngage(u, target));
        if (!eligible.length) return { error: 'Selected weapons cannot engage that target.' };
        let ordered = 0;
        for (const u of eligible) {
          if (cmd.queue === true && (u.goal || u.attack || u.airOrder)) {
            if (u.orders.length < 8) { u.orders.push({ kind: 'attack', target: target.id }); ordered++; }
            continue;
          }
          u.orders.length = 0;
          stopUnit(this, u);
          u.mode = 'assault';
          u.attack = target.id;
          u.airOrder = null;
          ordered++;
        }
        return ordered ? {} : { error: 'The order queue is full.' };
      }
      case 'deploy': {
        const points = (Array.isArray(cmd.points) ? cmd.points : []).slice(0, 96).map((v) => this.point(v)).filter(Boolean);
        if (points.length < 2) return { error: 'Draw a battle line.' };
        return deployLine(this, group, points, { mode: cmd.behavior === 'attackMove' ? 'assault' : 'guard', reverse: cmd.reverse === true,
          preview: cmd.preview === true, queue: cmd.queue === true });
      }
      case 'hold':
      case 'fortify':
        for (const u of group) { u.orders.length = 0; u.attack = null; u.target = 0; u.airOrder = null; u.braced = true; stopUnit(this, u); u.mode = 'guard'; }
        return {};
      case 'withdraw': {
        const back = p || this.sites.filter((s) => s.slots && s.owner === civ.id && headquarters(this, s)?.done)
          .sort((a, b) => group.length ? distance(a, group[0]) - distance(b, group[0]) : a.id - b.id)[0];
        return back ? moveGroup(this, group, back, { mode: 'move' }) : { error: 'Choose a retreat point.' };
      }
      case 'establish': return establish(this, civ, site);
      case 'baseBuild': return construct(this, civ, site, cmd.type, cmd.slot ?? cmd.tile);
      case 'fieldBuild': return constructDefense(this, civ, cmd.type, p);
      case 'fieldPreview': return constructDefense(this, civ, cmd.type, p, true);
      case 'roadBuild': {
        const stroke = (Array.isArray(cmd.points) ? cmd.points : []).slice(0, 96);
        const samples = stroke.length <= 12 ? stroke : Array.from({ length: 12 }, (_, i) => stroke[Math.round(i * (stroke.length - 1) / 11)]);
        return roadBuild(this, civ, samples.map((v) => this.point(v)).filter(Boolean), cmd.preview === true);
      }
      case 'trenchWorld': {
        const points = (Array.isArray(cmd.points) ? cmd.points : []).slice(0, 72).map((v) => this.point(v)).filter(Boolean);
        return points.length >= 2 ? trenchLine(this, civ, points, cmd.reverse === true, cmd.preview === true) : { error: 'Draw a trench line.' };
      }
      case 'advance': return advanceBase(this, civ, site);
      case 'research': return startUpgrade(this, civ, cmd.tech);
      case 'batchTrain': return train(this, civ, cmd.buildings, cmd.unit, cmd.count, cmd.policy === 'each');
      case 'train': return train(this, civ, [cmd.id ?? cmd.building], cmd.unit, cmd.count ?? 1);
      case 'cancelTrain': return cancelTraining(this, civ, cmd.id ?? cmd.building, cmd.index ?? 0);
      case 'repeat': {
        const b = this.buildings.get(cmd.id), d = ACTION_UNITS[cmd.unit];
        if (b?.owner !== civ.id || !b.done || cmd.unit != null && (!d || d.facility !== b.type))
          return { error: 'Select a valid production facility and unit.' };
        b.repeat = cmd.unit || null;
        return {};
      }
      case 'detach': {
        const ids = new Set(group.map((u) => u.id));
        for (const roster of civ.groups.values()) roster.units = roster.units.filter((id) => !ids.has(id));
        for (const u of group) u.formation = 0;
        return {};
      }
      case 'group': {
        const id = cmd.group;
        if (!Number.isInteger(id) || id < 1 || id > 9) return { error: 'Choose a control group from 1 to 9.' };
        civ.groups.set(id, { id, units: group.map((u) => u.id) });
        return {};
      }
      case 'rallyGroup': {
        if (!civ.groups.has(cmd.group)) return { error: 'Save a control group first.' };
        const ids = Array.isArray(cmd.buildings) ? cmd.buildings.slice(0, 40) : [];
        for (const id of ids) {
          const b = this.buildings.get(id);
          if (b?.owner === civ.id && b.done && ACTION_BUILDINGS[b.type].trains) b.rallyGroup = cmd.group;
        }
        return {};
      }
      case 'repair': return repairFacility(this, civ, cmd.id);
      case 'rally': {
        if (!p) return { error: 'Choose a rally point.' };
        const ids = Array.isArray(cmd.buildings) ? cmd.buildings.slice(0, 40) : [cmd.id ?? cmd.building];
        let count = 0;
        for (const id of ids) {
          const b = this.buildings.get(id);
          if (b?.owner === civ.id && b.done && ACTION_BUILDINGS[b.type].trains) { b.rally = p; count++; }
        }
        return count ? {} : { error: 'Select production facilities.' };
      }
      case 'ability': return useAbility(this, civ, group, cmd.ability, p);
      case 'airMission': {
        const air = group.filter((u) => ACTION_UNITS[u.type].air);
        if (!air.length) return { error: 'Select aircraft.' };
        if (cmd.mission === 'return') { for (const u of air) this.returnAircraft(u); return {}; }
        if (!p || !['patrol', 'scout', 'strike', 'intercept', 'support'].includes(cmd.mission)) return { error: 'Choose a flight objective.' };
        let dispatched = 0;
        for (const u of air) {
          const d = ACTION_UNITS[u.type];
          if (cmd.mission === 'strike' && !d.weapon) continue;
          const result = moveGroup(this, [u], p, { mode: 'assault' });
          if (result.error) continue;
          u.airOrder = { kind: cmd.mission, point: p, phase: 0 };
          dispatched++;
        }
        return dispatched ? { dispatched } : { error: 'Selected aircraft cannot perform that mission.' };
      }
      case 'missileBuild': return missileCommand(this, civ, cmd.id, null);
      case 'missileLaunch': return p ? missileCommand(this, civ, cmd.id, p) : { error: 'Choose a strategic target.' };
      case 'sandbox': return this.sandbox && cmd.op === 'scenario' ? this.stageScenario(cmd.key) : { error: 'This action requires the combat sandbox.' };
      default: return { error: 'This command is unavailable in the action RTS ruleset.' };
    }
  }

  stageScenario(key) {
    const count = { rifles: 10, mixed: 20, armor: 18, artillery: 24, air: 24, strategic: 30, stronghold: 36, large: 30, massive: 500, stress: 1000 }[key];
    if (!Number.isInteger(count)) return { error: 'Unknown combat scenario.' };
    if (key === 'stronghold') {
      // An explicit sandbox setup: developed bases and equipment can be inspected
      // alongside the real terrain, streets and authoritative combined-arms battle.
      const civ = this.civs[0], home = this.sites.find((s) => s.owner === civ.id && s.hq) || this.sites.find((s) => s.slots);
      const sites = this.sites.filter((s) => s.slots && (s.owner === civ.id || s.owner < 0))
        .sort((a, b) => distance(a, home) - distance(b, home)).slice(0, 3);
      const pending = ['motor_works', 'power_plant', 'airfield', 'armory', 'heavy_weapons', 'advanced_lab', 'missile_silo', 'barracks', 'depot'];
      civ.age = 2; civ.res = { materials: 4500, energy: 1800 };
      for (const tech of ['infantry_training', 'heavy_armor', 'aircraft_systems', 'field_engineering', 'networked_command']) civ.techs.add(tech);
      for (const site of sites) {
        site.owner = civ.id; site.tier = 3;
        if (!site.hq) addFacility(this, civ, site, 'town', site.tile, { instant: true });
        for (const tile of openSlots(this, site)) {
          const type = pending.shift(); if (!type) break;
          addFacility(this, civ, site, type, tile, { instant: true });
        }
      }
    }
    this.units.clear();
    this.movers.clear();
    this.projectiles.clear();
    const center = this.sites.find((s) => s.kind === 'metro') || this.sites.find((s) => s.owner < 0);
    const rosters = {
      rifles: ['rifle_squad'], armor: ['tank', 'mech_infantry', 'anti_armor'], artillery: ['mortar_team', 'rifle_squad', 'sp_artillery'],
      air: ['helicopter', 'fighter', 'air_defense', 'recon_drone', 'bomber'],
      mixed: ['rifle_squad', 'scout_buggy', 'engineer', 'tank', 'mortar_team'],
    };
    const types = rosters[key] || ['rifle_squad', 'rifle_squad', 'tank', 'armored_car', 'mortar_team', 'sp_artillery', 'helicopter', 'air_defense'];
    const ids = [[], []], cols = Math.ceil(Math.sqrt(count * 1.5));
    for (let side = 0; side < 2; side++) for (let i = 0; i < count; i++) {
      const x = wrapX(center.x + (side ? 1 : -1) * (3.8 + Math.floor(i / cols) * .51)), z = center.z + (i % cols - cols * .5) * .54;
      const type = types[(i + side) % types.length];
      const u = this.spawn(this.civs[side], type, { x, z }, .13) || this.spawn(this.civs[side], type, center, 2 + i * .017);
      if (!u) continue;
      u.yaw = side === 0 ? Math.PI * .5 : -Math.PI * .5;
      ids[side].push(u.id);
    }
    for (const id of ids[1]) this.units.get(id).mode = 'guard';
    this.refreshVisibility();
    return { reply: { t: 'ack', scenario: { name: key, arena: center.tile, A: ids[0], B: ids[1] } } };
  }

  unitSnapshot(civ, view) {
    const units = [], wp = {};
    const equipment = this.civs.map((c) => (c.techs.has('infantry_training') ? 1 : 0) | (c.techs.has('heavy_armor') ? 2 : 0) |
      (c.techs.has('aircraft_systems') ? 4 : 0) | (c.techs.has('field_engineering') ? 8 : 0) | (c.techs.has('networked_command') ? 16 : 0));
    for (const u of this.units.values()) {
      if (!view.god && !this.sees(civ, u)) continue;
      const own = u.owner === civ.id || view.god;
      const d = ACTION_UNITS[u.type];
      const target = this.units.get(u.target) || this.buildings.get(u.target);
      units.push([u.id, u.owner, u.type, u.tile, -1, 0, Math.round(u.hp / u.maxHp * 100), 100,
        (this.time - u.lastCombat < 1.5 ? 1 : 0) | (u.blocked > 9 ? 16 : 0) | (d.cat === 'artillery' && !u.goal ? 64 : 0) | (u.waitingCrossing ? 128 : 0) | (u.assisting ? 256 : 0),
        own ? u.mode : null, 0, own && target && (view.god || this.sees(civ, target)) ? u.target : 0, 0, 100, Math.min(3, Math.floor(u.kills / 4)), 0, 0, 0,
        d.air ? [u.grounded ? 0 : 2, 100, 0, -1, -1, -1, 0] : null, -1,
        [round(u.x, 1000), round(u.z, 1000), round(u.yaw, 1000), round(u.vx), round(u.vz), own ? round(Math.max(0, u.abilityReady - this.time), 2) : 0,
          round(u.altitude || 0, 1000), equipment[u.owner]]]);
      if (own && u.path.length) wp[u.id] = u.path.slice(0, 18).map((p) => [round(p.x, 100), round(p.z, 100)]);
    }
    return { units, paths: {}, wp };
  }

  siteWire(s, civ, live, god = false) {
    const hq = headquarters(this, s);
    const own = s.owner === civ.id;
    return { id: s.id, tile: s.tile, x: s.x, z: s.z, name: s.name, kind: s.kind, base: !!s.slots, radius: s.radius, owner: s.owner,
      by: live ? s.by : -1, capture: live ? round(s.progress / s.captureTime * 100, 1) : 0, contested: live && s.contested,
      hq: hq?.id || 0, operational: !!hq?.done, build: hq ? round(hq.progress * 100, 1) : 0, tier: s.tier,
      slots: own && s.slots ? openSlots(this, s) : undefined, capacity: s.slots ? 4 + (s.tier - 1) * 2 : undefined,
      ringVersion: s.ringVersion, developedAt: s.developedAt, visualTier: s.visualTier, tenure: Math.max(0, this.time - (s.claimedAt ?? this.time)),
      maturity: s.everEstablished ? s.maturityElapsed ?? Math.min(35, Math.max(0, this.time - s.developedAt)) : 0,
      // Historical foundations are public geometry once this site is discovered.
      // Occupancy and available construction slots remain owner-only information.
      parcels: s.parcels ? s.parcels.map((p) => [p.tile, p.x, p.z, p.yaw, p.id, p.tier, p.width, p.depth,
        own || god || civ.visible[p.tile] ? s.history?.[p.id]?.type || null : civ.siteIntel.get(s.id)?.parcels?.find((v) => v[4] === p.id)?.[8] || null]) : undefined,
      memory: !live, starting: s.start !== undefined };
  }

  viewerSnapshot(civ, view, full, econ) {
    const msg = super.viewerSnapshot(civ, view, full, econ);
    msg.pickups = visibleCaches(this, civ, view.god);
    msg.sites = this.sites.flatMap((s) => {
      if (view.god || s.owner === civ.id || view.vis[s.tile]) return [this.siteWire(s, civ, true, view.god)];
      const memory = civ.siteIntel.get(s.id);
      return memory ? [{ ...memory, slots: undefined, by: -1, capture: 0, contested: false, memory: true }] : [];
    });
    if (econ) msg.trenchWorld = [...this.fieldworks.values()].filter((f) => view.god || f.owner === civ.id || view.vis[f.tile])
      .map((f) => [f.tile, f.x, f.z, f.facing]);
    return msg;
  }

  econSnapshot(civ, view) {
    const vis = view.vis, god = view.god;
    const buildings = [];
    for (const b of this.buildings.values()) {
      if (!god && b.owner !== civ.id && !vis[b.tile]) continue;
      const own = god || b.owner === civ.id, site = this.siteById.get(b.site), q = b.queue[0], p = b.project;
      buildings.push({ id: b.id, o: b.owner, ty: b.type, t: b.tile, px: b.x, pz: b.z, yaw: b.yaw, hp: round(b.hp / b.maxHp * 100, 1),
        d: b.done ? 1 : 0, p: round(b.progress * 100, 1), st: b.state, lv: b.level, ea: b.era, ti: site?.tier || this.civs[b.owner].age + 1, slot: b.slot,
        f: b.fire > 0 ? 1 : 0, a: b.done && (ACTION_BUILDINGS[b.type].materials || ACTION_BUILDINGS[b.type].energy || q) ? 1 : 0,
        ...(own ? { c: b.site, s: 1, q: b.queue.map((q) => [q.unit, Math.ceil(q.left)]), tr: q ? round((1 - q.left / q.total) * 100, 1) : 0,
          wk: p ? [p.kind === 'repair' ? 'r' : 'u', round((1 - p.left / p.total) * 100, 1)] : undefined, project: p?.kind,
          mi: b.missiles, rp: b.repeat, rg: b.rallyGroup, rc: b.done && b.hp < b.maxHp ? Math.ceil(20 + (1 - b.hp / b.maxHp) * 70) : 0 } : {}) });
    }
    if (!god && civ.seenB) for (const b of civ.seenB.values()) if (!vis[b.t]) buildings.push({ ...b, mem: 1 });
    const cities = this.sites.filter((s) => s.slots && s.hq && (god || s.owner === civ.id || vis[s.tile])).map((s) =>
      ({ id: s.id, o: s.owner, n: s.name, t: s.tile, ti: s.tier, r: s.tier, cap: s.start === s.owner ? 1 : 0 }));
    const ruins = god ? [...this.ruins].map(([tile, r]) => [tile, r.type, 0]) : [...civ.ruinIntel].map(([tile, type]) => [tile, type, 0]);
    const econ = {
      res: { materials: Math.floor(civ.res.materials), energy: Math.floor(civ.res.energy) }, rates: civ.rates, age: civ.age,
      capacity: armyCapacity(this, civ), techs: [...civ.techs], objective: this.scenario, hold: this.teamHold[civ.team],
      recovery: civ.recoveryUntil == null ? 0 : Math.max(0, Math.ceil(civ.recoveryUntil - this.time)), tutorialSite: this.tutorialSite,
      research: [...this.buildings.values()].filter((b) => b.owner === civ.id && b.project?.kind === 'upgrade')
        .map((b) => ({ key: b.project.key, progress: round((1 - b.project.left / b.project.total) * 100, 1) })),
      groups: [...civ.groups.values()].map((g) => ({ id: g.id, units: g.units.filter((id) => this.units.has(id)) })),
    };
    const civs = this.civs.map((c) => ({ id: c.id, name: c.name, color: c.color, team: c.team, alive: c.alive, human: c.human,
      ...(c.id === civ.id || god ? { age: c.age, summary: this.civSummary(c), posture: c.aiPlan?.state } : {}) }));
    const ms = [...this.projectiles.values()].filter((p) => p.strategic && (god || p.owner === civ.id || vis[p.to]))
      .map((p) => ({ id: p.id, t: p.to, x: p.x, z: p.z, left: Math.max(0, round(p.arrive - this.time)) }));
    return { econ, buildings, cities, civs, ruins, bridges: bridgesFor(this, civ, vis), ms,
      bf: battlefieldSnapshot(this, vis, view.explored, civ.battlefieldMemory, god),
      ...(god && civ.aiPlan ? { actionPlan: civ.aiPlan } : {}) };
  }
}
