import { LEGACY_RULESET, actionRules, nativeRules, normalizeNativeCiv } from './rulesets.js';
// Full match serialization: everything needed to resume a match bit-for-bit (including the RNG),
// so live games survive deploys, restarts and crashes, and replays can be verified.
import { Game } from './game.js';
import { ActionGame } from './actionGame.js';
import { migrateProduction, orderOf } from './actionProduction.js';
import { setLevel } from './actionBases.js';
import { markDenseForest } from './actionMap.js';
import { ACTION_BUILDINGS, ACTION_UNITS, ACTION_UPGRADES, REMOVED_BUILDINGS, REMOVED_PERIMETER_LEVELS, REMOVED_UPGRADES } from './actionDefinitions.js';
import { WRAP } from './hex.js';
import { BUILDINGS, TECHS, POLICIES } from './constants.js';
import { AI } from './ai.js';
import { RebelAI } from './rebels.js';
import { getNextArmyId, setNextArmyId } from './armies.js';
import { serializeBattlefield, restoreBattlefield } from './battlefield.js';
import { serializeFieldworks, restoreFieldworks } from './fieldworks.js';
import { battleBacklog } from './battles.js';
import { restoreHorde, serializeHorde } from './horde.js';

const WORLD_ARRAYS = ['elev', 'stab', 'moist', 'temp', 'rate', 'stress', 'plate', 'terr', 'res', 'river', 'lake', 'flowDir', 'flow', 'road', 'soil', 'lava', 'ash', 'drought', 'owner', 'ver'];
const CIV_ARRAYS = ['explored', 'lastOwner', 'visible', 'detect', 'supply', 'airSupply'];
const TRANSIENT = new Set(['ai', 'knownStab', 'visKey', 'connected', 'token', 'evSeq', 'readinessCache', 'importUsedNext']);

const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
function fromB64(str, Ctor) { const buf = Buffer.from(str, 'base64'); const out = new Ctor(buf.byteLength / Ctor.BYTES_PER_ELEMENT); new Uint8Array(out.buffer).set(buf); return out; }
const mapOut = (m) => (m ? [...m.entries()] : []);

export function serializeGame(g) {
  const w = g.world;
  const world = { arrays: {}, wiped: [...w.wiped], dirty: w.dirty.size > 0 ? 1 : 0, volcanoes: w.volcanoes, riftTiles: w.riftTiles, faultTiles: w.faultTiles, starts: w.starts, stab0: w.stab0 ? b64(w.stab0) : null };
  for (const k of WORLD_ARRAYS) world.arrays[k] = b64(w[k]);
  if (w.dense) world.arrays.dense = b64(w.dense);   // §30 dense forest (action ruleset)
  const civs = g.civs.map((c) => {
    const o = {};
    for (const [k, v] of Object.entries(c)) {
      if (v instanceof Uint8Array || v instanceof Int8Array || v instanceof Uint16Array || TRANSIENT.has(k)) continue;
      if (v instanceof Set) o[k] = { $set: [...v] };
      else if (v instanceof Map) o[k] = { $map: [...v.entries()] };
      else o[k] = v;
    }
    o.$arrays = {}; for (const k of CIV_ARRAYS) o.$arrays[k] = b64(c[k]);
    if (c.ai) {
      const a = c.ai;
      o.$ai = c.isRebel ? { kind: 'rebel', nextCamp: a.nextCamp, nextSpawn: a.nextSpawn, raid: a.raid } : { kind: 'ai', campaign: a.campaign, lastTrade: a.lastTrade, colonists: mapOut(a.colonists), mil: a.mil.serialize(), econ: a.econ ? a.econ.serialize() : null, brain: a.brain ? a.brain.serialize() : null };
    }
    o.$token = c.token;
    o.armies = { $map: [...(c.armies || new Map()).entries()] };
    if (c.colonistGoals) o.colonistGoals = { $map: [...c.colonistGoals.entries()] };
    return o;
  });
  const diplo = [];
  for (let a = 0; a < g.civs.length; a++) for (let b = a + 1; b < g.civs.length; b++) diplo.push([a, b, g.diplomacy.m[a][b]]);
  return {
    v: actionRules(g) ? 5 : 3, ruleset: g.ruleset, id: g.id, seed: g.seed, size: w.elev.length, time: g.time, tickN: g.tickN, nextId: g.nextId, rng: g.rng.getState(), cityNameIdx: g.cityNameIdx,
    ...(actionRules(g) ? { action: { sites: g.sites, objective: g.scenario, teamSize: g.teamSize, map: g.mapId, tutorial: g.tutorial,
      tutorialSite: g.tutorialSite, teamHold: g.teamHold, engagements: mapOut(g.engagements), reports: g.reports,
      materialCaches: mapOut(g.materialCaches), energyCacheAt: g.energyCacheAt ?? null,
      // Ticket 4: the match rules and a custom map's generation options (matchRules.js, sketchMaps.js)
      ...(g.rules && { rules: g.rules }), ...(g.mapGen && { mapGen: g.mapGen }), roadProjects: g.roadProjects, armyLimit: g.armyLimit,
      dominance: g.dominance || null, territoryDirty: !!g.territoryDirty, groupJobs: g.groupJobs || [], nextGroupJob: g.nextGroupJob || 0,
      // Pass 3: convoy pace (actionOrders.unitMotion) reads last tick's lead distance; unsaved, a restored match drove
      // its convoys at a different speed on the first tick and diverged from the uninterrupted one (Infinity -> null)
      convoys: [...(g.convoys || new Map())].map(([id, c]) => [id, Number.isFinite(c.lead) ? c.lead : null, Number.isFinite(c.next) ? c.next : null, c.tick]),
      // Pass 3: units compare a path's u.navVer with the navigation's terrain version (stuck ladder: replan a path planned
      // before a terrain change); the counter restarted on restore, so every moving unit replanned at its first stall check
      navTerrainVersion: g.nav?.terrainVersion ?? 0, nextConvoy: g.nextConvoy || 0,
      // BLIGHT survival mode (horde.js): waves, pending spawns, risings, hives, statistics and the shared flow fields
      ...(g.horde ? { horde: serializeHorde(g) } : {}) } } : {}),
    over: g.over, winner: g.winner, log: g.log.slice(-60), navVersion: g.navVersion, nextArmyId: getNextArmyId(),
    // v2: wrapped topology and world style
    wrap: WRAP, worldStyle: g.worldStyle, style: g.world.style,
    slots: g.slotsDef, world, roads: { ...g.roads.serialize(), traffic: mapOut(g.roads.traffic) },
    fieldworks: serializeFieldworks(g), logistics: { caches: [...(g.caches || new Map())], seq: g.convoySeq || 0 },
    formations: { list: [...(g.formations || new Map()).values()], nextId: g.nextFormationId || 0 },
    weather: g.weather ? g.weather.serialize() : null,
    combat: { projectiles: [...g.projectiles.values()], pending: [...g.pending.entries()], eventSeq: g.eventSeq, battlefield: serializeBattlefield(g), missiles: g.missiles || [], fallout: [...(g.fallout || new Map())], missileSeq: g.missileSeq || 1, battles: g.battles || [], nextBattle: g.nextBattle || 1, battleSeq: g.battleSeq || 0, battleBacklog: battleBacklog(g) },
    units: [...g.units.values()], buildings: [...g.buildings.values()], cities: [...g.cities.values()], ruins: mapOut(g.ruins),
    civs, diplomacy: { pairs: diplo, nextProposal: g.diplomacy.nextProposal },
  };
}

const revive = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v.$set ? new Set(v.$set) : v.$map ? new Map(v.$map) : v) : v);

export function restoreGame(data) {
  const savedWrap = data.wrap === undefined ? false : !!data.wrap;
  if (savedWrap !== WRAP) throw new Error(`snapshot topology (${savedWrap ? 'wrapped' : 'bounded'}) does not match this worker`);
  const action = actionRules(data);
  if (data.ruleset === 'action-v1') throw new Error('This save uses the earlier action-v1 economy. Ring cities require a new action-v2 match; the save has not been converted.');
  if (action && (data.v !== 5 || !Array.isArray(data.action?.sites) || data.action.sites.some((s) => s.slots && (s.ringVersion !== 1 || s.slots.length !== 8))))
    throw new Error('Unsupported ring-city RTS save format.');
  const Simulation = action ? ActionGame : Game;
  const g = new Simulation({ ...data.action, id: data.id, seed: data.seed, slots: data.slots, ruleset: data.ruleset || LEGACY_RULESET,
    restore: true, rebels: data.civs.some((c) => c.isRebel), style: data.style || data.worldStyle || null });
  g.worldStyle = data.worldStyle ?? null;
  const w = g.world;
  if (w.elev.length !== data.size) throw new Error(`snapshot map size ${data.size} does not match this worker (${w.elev.length})`);
  for (const k of WORLD_ARRAYS) w[k] = fromB64(data.world.arrays[k], w[k].constructor);
  Object.assign(w, { volcanoes: data.world.volcanoes, riftTiles: data.world.riftTiles, faultTiles: data.world.faultTiles, starts: data.world.starts });
  if (data.world.stab0) w.stab0 = fromB64(data.world.stab0, Float32Array);
  w.dirty.clear(); w.wiped.clear(); if (data.world.dirty) w.dirty.add(-1); for (const t of data.world.wiped || []) w.wiped.add(t);
  Object.assign(g, { time: data.time, tickN: data.tickN, nextId: data.nextId, cityNameIdx: data.cityNameIdx, over: data.over, winner: data.winner, log: data.log, navVersion: data.navVersion });
  g.rng.setState(data.rng);
  setNextArmyId(Math.max(getNextArmyId(), data.nextArmyId || 1));
  g.roads.load(data.roads); g.roads.traffic = new Map(data.roads.traffic || []);
  g.units = new Map(data.units.map((u) => [u.id, u]));
  // buildings whose type has since left the game (seismic stations, stabilizers) are dropped; an action-mode one listed
  // in REMOVED_BUILDINGS (the Armory, 2026-11-20) is refunded below, once the civs are restored
  const retired = action ? data.buildings.filter((b) => Object.hasOwn(REMOVED_BUILDINGS, b.type)) : [];
  g.buildings = new Map(data.buildings.filter((b) => (action ? ACTION_BUILDINGS : BUILDINGS)[b.type]).map((b) => [b.id, b]));
  g.cities = new Map(data.cities.map((c) => [c.id, { ...c, freight: c.capital ? Infinity : c.freight ?? 0 }]));
  // players' cities run themselves by default now: an older save's untouched advisor becomes autonomous
  for (const c of g.cities.values()) { const gv = c.governor, civ = data.civs[c.owner]; if (gv && civ && civ.human && !gv.chosen && (gv.level === 'advisor' || !gv.level)) { gv.level = 'autonomous'; gv.enabled = true; } }
  g.ruins = new Map(data.ruins);
  const cb = data.combat || {};
  g.projectiles = new Map((cb.projectiles || []).map((p) => [p.id, p])); g.pending = new Map(cb.pending || []);
  g.eventSeq = cb.eventSeq || 0; g.events = [];
  restoreBattlefield(g, cb.battlefield);
  if (g.weather) { g.weather.climate(); if (data.weather) g.weather.load(data.weather); }
  g.missiles = cb.missiles || []; g.fallout = new Map(cb.fallout || []); g.missileSeq = cb.missileSeq || 1;
  g.battles = cb.battles || []; g.nextBattle = cb.nextBattle || 1; g.battleSeq = cb.battleSeq ?? g.eventSeq; g.battleBacklog = cb.battleBacklog || [];
  restoreFieldworks(g, data.fieldworks);
  g.caches = new Map(data.logistics?.caches || []); g.convoySeq = data.logistics?.seq || 0;
  g.formations = new Map((data.formations?.list || []).map((f) => [f.id, f])); g.nextFormationId = data.formations?.nextId || 0;
  g.tileB.fill(-1); for (const b of g.buildings.values()) g.tileB[b.tile] = b.id;
  data.civs.forEach((o, i) => {
    const c = g.civs[i];
    for (const [k, v] of Object.entries(o)) { if (k.startsWith('$')) continue; c[k] = revive(v); }
    for (const k of CIV_ARRAYS) c[k] = fromB64(o.$arrays[k], c[k].constructor);
    // saves from before difficulty profile v2 keep the multipliers they were started with
    if (o.diffProfile === undefined && c.isAI && !c.isRebel) { c.diffProfile = 'legacy'; c.fairPlay = false; }
    // technologies and policies that have since left the game are forgotten; a removed upgrade the save owned (the
    // troop upgrades 2026-11-19, the Armory's Improved Logistics and Networked Command 2026-11-20) is refunded in full
    if (action && c.techs instanceof Set) for (const t of c.techs) if (Object.hasOwn(REMOVED_UPGRADES, t)) refundUpgrade(c, t);
    if (c.techs instanceof Set) for (const t of [...c.techs]) if (!(action ? ACTION_UPGRADES : TECHS)[t]) c.techs.delete(t);
    if (c.policies instanceof Set) for (const t of [...c.policies]) if (!POLICIES[t]) c.policies.delete(t);
    if (Array.isArray(c.queue)) c.queue = c.queue.filter((t) => TECHS[t]);
    if (c.researching && !TECHS[c.researching]) c.researching = null;
    // saves from before per-technology progress: keep the active project's progress
    if (!c.techProgress) c.techProgress = {};
    if (c.researching && c.progress > 0 && c.techProgress[c.researching] == null) c.techProgress[c.researching] = c.progress;
    c.ruleset = g.ruleset; if (nativeRules(g)) normalizeNativeCiv(c);
    c.knownVer.fill(0); c.knownOwner.fill(-2); c.visKey = ''; c.knownStab = false; c.connected = false; c.token = o.$token || null;
    if (o.$ai) {
      if (o.$ai.kind === 'rebel') { c.ai = new RebelAI(g, c); Object.assign(c.ai, { nextCamp: o.$ai.nextCamp, nextSpawn: o.$ai.nextSpawn, raid: o.$ai.raid }); }
      else { c.ai = new AI(g, c); Object.assign(c.ai, { campaign: o.$ai.campaign, lastTrade: o.$ai.lastTrade, colonists: new Map(o.$ai.colonists) }); c.ai.mil.load(o.$ai.mil); if (o.$ai.brain) c.ai.brain.load(o.$ai.brain); if (c.ai.econ && o.$ai.econ) c.ai.econ.load(o.$ai.econ); }
    }
  });
  for (const [a, b, r] of data.diplomacy.pairs) { g.diplomacy.m[a][b] = r; g.diplomacy.m[b][a] = r; }
  g.diplomacy.nextProposal = data.diplomacy.nextProposal;
  if (action) {
    g.setSites(data.action.sites);
    // §30 dense forest: saved since 2026-11-18; an older save derives it from its (possibly cleared) terrain
    if (data.world.arrays.dense) { w.dense = fromB64(data.world.arrays.dense, Uint8Array); g.nav.invalidate(); } else markDenseForest(g);
    g.rebuildBuildingIndex();
    migrateProduction(g);   // W1: pre-scheduler saves carry one FIFO `queue` per building
    // 2026-11-19: a removed troop upgrade in progress is abandoned and its cost (paid up front) refunded
    for (const b of g.buildings.values())
      if (b.project?.kind === 'upgrade' && Object.hasOwn(REMOVED_UPGRADES, b.project.key)) {
        if (g.civs[b.owner]) refundUpgrade(g.civs[b.owner], b.project.key);
        b.project = null;
      }
    retireBuildings(g, retired);
    migrateBaseMenu(g);   // 2026-11-20 base menu rework (BASE_MENU_REWORK.md §9)
    g.materialCaches = new Map(data.action.materialCaches || []);
    // energy caches (2026-11-19): the spawn schedule; a save from before them starts it at its first step
    if (data.action.energyCacheAt != null) g.energyCacheAt = data.action.energyCacheAt;
    g.roadProjects = data.action.roadProjects || [];
    for (const civ of g.civs) civ.cacheIntel ??= new Map();
    g.tutorialSite = data.action.tutorialSite || 0;
    g.teamHold = data.action.teamHold;
    g.engagements = new Map(data.action.engagements || []);
    g.reports = data.action.reports || [];
    // review S: a running decisive-domination countdown survives a save; the territory refresh flag too
    g.dominance = data.action.dominance || null;
    g.territoryDirty = !!data.action.territoryDirty;
    g.groupJobs = data.action.groupJobs || []; g.nextGroupJob = data.action.nextGroupJob || 0;   // Pass 3 (actionOrders.groupRouteStep)
    g.nextConvoy = data.action.nextConvoy || 0;   // Pass 3: convoy ids continue (moveGroup), as in the uninterrupted match
    if (data.action.convoys) g.convoys = new Map(data.action.convoys.map(([id, lead, next, tick]) => [id, { lead: lead ?? Infinity, next: next ?? Infinity, tick }]));
    // 2026-11-18 unit rebalance: a unit whose type changed its health (infantry squads lost HP per man; exo_infantry
    // became an Infantry Fighting Vehicle) keeps its health fraction at the new maximum. The former exo squad also takes
    // the vehicle's footprint, drops its squad-only state (suppression, armour plates) and leaves any garrison.
    for (const u of g.units.values()) {
      const d = ACTION_UNITS[u.type];
      // Ticket 4: the match's unit health multiplier is part of every unit's maximum (actionGame.spawn)
      const health = g.rules?.unitHealth ?? 1, base = d ? (health === 1 ? d.hp : Math.max(1, Math.round(d.hp * health))) : 0;
      const max = d ? base * (u.mods?.hp || 1) : 0;   // an upgraded unit's own maximum (actionUnitUpgrades.setMods)
      if (!d || d.air || !(u.maxHp > 0) || Math.abs(u.maxHp - max) < 1e-6) continue;
      u.hp = u.hp > 0 ? Math.max(1, Math.round(u.hp / u.maxHp * max * 1000) / 1000) : 0;
      u.maxHp = max;
      if (!d.men) {
        u.radius = d.radius; delete u.supp; delete u.suppAt; delete u.plates;
        if (u.inside) {
          const b = g.buildings.get(u.inside);
          if (b?.garrison) b.garrison = b.garrison.filter((id) => id !== u.id);
          u.inside = 0;
        }
      }
    }
    for (const u of g.units.values()) {
      if (u.inside) continue;   // W4: garrisoned squads stay out of the movement and target indexes
      if (!ACTION_UNITS[u.type].air) g.movers.add(u);
      g.targets.add(u);
    }
    for (const b of g.buildings.values()) g.targets.add(b);
    if (data.action.navTerrainVersion != null) g.nav.terrainVersion = data.action.navTerrainVersion;
    if (data.action.horde) restoreHorde(g, data.action.horde);
  } else g.rebuildTileUnits();
  return g;
}

/**
 * 2026-11-20: a building whose type has left the game (actionDefinitions REMOVED_BUILDINGS: the Armory) was dropped
 * from the save above; its owner gets its full cost back (construction is paid when ordered, so a site still under
 * construction too), plus any removed upgrade it was researching. Ruins, lot history and fog-of-war memory of the
 * type are forgotten so no client is sent a building type it no longer knows. Deterministic: save order.
 */
function retireBuildings(g, retired) {
  for (const b of retired) {
    const civ = g.civs[b.owner];
    if (!civ?.res) continue;
    for (const [k, v] of Object.entries(REMOVED_BUILDINGS[b.type].cost)) civ.res[k] = (civ.res[k] || 0) + v;
    if (b.project?.kind === 'upgrade' && Object.hasOwn(REMOVED_UPGRADES, b.project.key)) refundUpgrade(civ, b.project.key);
  }
  const gone = (type) => Object.hasOwn(REMOVED_BUILDINGS, type);
  for (const [tile, r] of [...g.ruins]) if (gone(r.type)) g.ruins.delete(tile);
  for (const s of g.sites) if (s.history) for (const [slot, h] of Object.entries(s.history)) if (gone(h?.type)) delete s.history[slot];
  for (const civ of g.civs) {
    if (civ.ruinIntel instanceof Map) for (const [tile, type] of [...civ.ruinIntel]) if (gone(type)) civ.ruinIntel.delete(tile);
    if (civ.siteIntel instanceof Map) for (const wire of civ.siteIntel.values()) for (const v of wire?.parcels || []) if (gone(v[8])) v[8] = null;
  }
}

/**
 * 2026-11-20 base menu rework (BASE_MENU_REWORK.md §9), for a save from before it:
 *  - a queue of a unit its building no longer trains (militia and scout buggies left the Barracks, the Support Truck
 *    the Vehicle Works, the Missile Battery Heavy Weapons) is dropped and what it had consumed refunded;
 *  - the old perimeter levels (site.defenseLevel 2-3, and one under way) are refunded and the pieces return to level 1
 *    (each perimeter turret now chooses a path);
 *  - every producing building gets its production order (b.order) from its queues.
 * The New Base under construction is refunded by retireBuildings (REMOVED_BUILDINGS). Deterministic: save order.
 */
function migrateBaseMenu(g) {
  const give = (owner, cost) => { const civ = g.civs[owner]; if (civ?.res) for (const [k, v] of Object.entries(cost || {})) civ.res[k] = (civ.res[k] || 0) + v; };
  for (const b of g.buildings.values()) {
    const trains = ACTION_BUILDINGS[b.type]?.trains || [];
    if (b.queues?.length) {
      for (const q of b.queues) if (!trains.includes(q.unit)) { give(b.owner, q.paid); q.count = 0; if (b.repeat === q.unit) b.repeat = null; }
      b.queues = b.queues.filter((q) => q.count > 0);
      b.order = null;
    }
    if (b.queues?.length) orderOf(b);
    if (b.project?.kind === 'defenses') { give(b.owner, REMOVED_PERIMETER_LEVELS[(b.project.level || 2) - 2]); b.project = null; }
  }
  for (const s of g.sites) {
    const level = s.defenseLevel || 1;
    if (level <= 1) continue;
    for (let l = 2; l <= level; l++) give(s.owner, REMOVED_PERIMETER_LEVELS[l - 2]);
    s.defenseLevel = 1;
    for (const b of g.buildings.values()) if (b.site === s.id && b.perimeterSlot && (b.level || 1) > 1 && !b.path) setLevel(b, 1);
  }
}

/** Gives a civ back what a removed upgrade cost (actionDefinitions REMOVED_UPGRADES). */
function refundUpgrade(civ, key) {
  if (!civ.res) return;
  for (const [k, v] of Object.entries(REMOVED_UPGRADES[key].cost)) civ.res[k] = (civ.res[k] || 0) + v;
}

// A compact fingerprint of the full state, for determinism tests.
export function stateHash(g) {
  const snap = serializeGame(g); delete snap.id; for (const c of snap.civs) delete c.$token;
  const s = JSON.stringify(snap, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
