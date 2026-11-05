import { LEGACY_RULESET, nativeRules, normalizeNativeCiv } from './rulesets.js';
// Full match serialization: everything needed to resume a match bit-for-bit (including the RNG),
// so live games survive deploys, restarts and crashes, and replays can be verified.
import { Game } from './game.js';
import { WRAP } from './hex.js';
import { BUILDINGS, TECHS, POLICIES } from './constants.js';
import { AI } from './ai.js';
import { RebelAI } from './rebels.js';
import { getNextArmyId, setNextArmyId } from './armies.js';
import { serializeBattlefield, restoreBattlefield } from './battlefield.js';
import { serializeFieldworks, restoreFieldworks } from './fieldworks.js';

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
    v: 3, ruleset: g.ruleset, id: g.id, seed: g.seed, size: w.elev.length, time: g.time, tickN: g.tickN, nextId: g.nextId, rng: g.rng.getState(), cityNameIdx: g.cityNameIdx,
    over: g.over, winner: g.winner, log: g.log.slice(-60), navVersion: g.navVersion, nextArmyId: getNextArmyId(),
    // v2: wrapped topology and world style
    wrap: WRAP, worldStyle: g.worldStyle, style: g.world.style,
    slots: g.slotsDef, world, roads: { ...g.roads.serialize(), traffic: mapOut(g.roads.traffic) },
    fieldworks: serializeFieldworks(g), logistics: { caches: [...(g.caches || new Map())], seq: g.convoySeq || 0 },
    formations: { list: [...(g.formations || new Map()).values()], nextId: g.nextFormationId || 0 },
    weather: g.weather ? g.weather.serialize() : null,
    combat: { projectiles: [...g.projectiles.values()], pending: [...g.pending.entries()], eventSeq: g.eventSeq, battlefield: serializeBattlefield(g), missiles: g.missiles || [], fallout: [...(g.fallout || new Map())], missileSeq: g.missileSeq || 1 },
    units: [...g.units.values()], buildings: [...g.buildings.values()], cities: [...g.cities.values()], ruins: mapOut(g.ruins),
    civs, diplomacy: { pairs: diplo, nextProposal: g.diplomacy.nextProposal },
  };
}

const revive = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v.$set ? new Set(v.$set) : v.$map ? new Map(v.$map) : v) : v);

export function restoreGame(data) {
  const savedWrap = data.wrap === undefined ? false : !!data.wrap;
  if (savedWrap !== WRAP) throw new Error(`snapshot topology (${savedWrap ? 'wrapped' : 'bounded'}) does not match this worker`);
  const g = new Game({ id: data.id, seed: data.seed, slots: data.slots, ruleset: data.ruleset || LEGACY_RULESET, restore: true, rebels: data.civs.some((c) => c.isRebel), style: data.style || data.worldStyle || null });
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
  // buildings whose type has since left the game (seismic stations, stabilizers) are dropped
  g.buildings = new Map(data.buildings.filter((b) => BUILDINGS[b.type]).map((b) => [b.id, b]));
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
    // technologies and policies that have since left the game are forgotten
    if (c.techs instanceof Set) for (const t of [...c.techs]) if (!TECHS[t]) c.techs.delete(t);
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
  g.rebuildTileUnits();
  return g;
}

// A compact fingerprint of the full state, for determinism tests.
export function stateHash(g) {
  const snap = serializeGame(g); delete snap.id; for (const c of snap.civs) delete c.$token;
  const s = JSON.stringify(snap, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
