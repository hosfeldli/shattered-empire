// BLIGHT survival mode (objective 'horde', docs/gameplay-overhaul/HORDE_MODE.md).
//
// Every player (humans and any AI allies) stands on one team against The Blight: an extra, non-playing civ that owns
// the creatures and their hives. Waves come without end; each is planned from a points budget that grows with the
// wave number and the elapsed time (hordeDefs.js). The live creature count is capped for the server's sake: strength
// beyond the cap becomes elite levels (tougher, harder-hitting, bigger creatures), never more bodies.
//
// Creature AI is deliberately cheap and deterministic:
//  * two shared flow fields over the hex grid (multi-source Dijkstra from the players' structures and troops: 'soft',
//    from their structures with defenses first: 'hard'), rebuilt every few seconds, synchronously, from the public
//    navigation costs (nav.centreCost / crowding / edgeOk, or nav.stepCost);
//  * near a target a creature steers straight at it; swarms keep apart with a simple separation push;
//  * strikes resolve through actionCombat.damageActionTarget (cover, armour, squads losing men all apply).
// Infantry the Blight kills rise again as husks a few seconds later. Hives grow at the map's far edges, spread
// corrupted ground (horde regeneration and speed) and pay out supplies when burned.
//
// Determinism: game.rng only, fixed iteration orders, fields rebuilt on tick cadences and saved with the match
// (serializeHorde / restoreHorde).

import { DT, N, T } from './constants.js';
import { NB, disk } from './hex.js';
import { ACTION_BUILDINGS, ACTION_UNITS } from './actionDefinitions.js';
import { centerOf, distance, dxBetween, tileAt, wrapX, TILE_X, TILE_Z } from './actionNavigation.js';
import { damageActionTarget } from './actionCombat.js';
import { emit } from './combat.js';
import { menOf } from './actionUpgrades.js';
import { Diplomacy } from './diplomacy.js';
import {
  CREATURES, HORDE, HORDE_COLOR, HORDE_NAME, HORDE_OBJECTIVE, bossCount, breatherSeconds, eliteDmg, eliteHp, eliteSize, hordeLevel,
  hordeScale, isHordeType, killScore, planRoster,
} from './hordeDefs.js';

export { HORDE_OBJECTIVE, isHordeType };
const HORDE_TEAM = 11;
const FIELD_NONE = 7, FIELD_GOAL = 6;
const MOVE = { move: 'infantry', radius: .12 };
const DEFS = new Map();   // radius -> { move, radius } for standing tests
const defOf = (r) => { const k = Math.round(r * 1000); let d = DEFS.get(k); if (!d) DEFS.set(k, d = { move: 'infantry', radius: k / 1000 }); return d; };
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
// husks per man of an infantry squad the Blight wipes out (a 12-man rifle squad: ~2, an engineer: 1)
const RISE_SHARE = .17;
const PHASES = ['prep', 'breather', 'wave', 'over'];

// ------------------------------------------------------------------ setup

/** A new horde match: adds The Blight as the last civ and grows its first hives. Called by ActionGame (not on restore). */
export function setupHorde(game, options = {}) {
  const id = game.civs.length;
  const slot = { human: false, name: HORDE_NAME };
  game.slotsDef.push({ ...slot });
  // Keys are added in the order a restored save rebuilds them (Game: makeCiv, ruleset; ActionGame.initCiv; then the
  // saved extras), so the state hash of a live match equals that of its restored save.
  const civ = game.makeCiv(id, slot);
  civ.ruleset = game.ruleset;
  Object.assign(civ, { isAI: false, color: HORDE_COLOR, leader: HORDE_NAME });
  game.initCiv(civ, { materials: 0, energy: 0 });
  civ.team = HORDE_TEAM;
  civ.horde = true;
  game.civs.push(civ);
  game.diplomacy = new Diplomacy(game);   // the action ruleset never reads it; sized for every civ so saves stay regular
  const cap = Number.isInteger(options.hordeCap) ? Math.max(40, Math.min(400, options.hordeCap)) : HORDE.cap;
  game.horde = {
    v: 1, civ: id, cap, wave: 0, phase: 'prep', phaseEnd: game.time + (Number.isFinite(options.hordePrep) ? Math.max(5, options.hordePrep) : HORDE.prep),
    startedAt: game.time, waveStart: 0, waveTotal: 0, riseBudget: 6, warned: 0, groups: [], risings: [], hives: [], hiveLostAt: -999, carry: 0,
    stats: { score: 0, kills: {}, killed: 0, hivesBurned: 0, risen: 0, lost: 0, peak: 0, cleared: 0, bosses: 0, supplies: 0, endedAt: null },
    fields: { soft: null, hard: null, softAt: -1, hardAt: -1 },
  };
  const players = livePlayers(game).length;
  const first = Math.min(HORDE.hiveMax, HORDE.hiveFirst + Math.max(0, players - 1));
  for (let i = 0; i < first; i++) growHive(game, game.horde, true);
  rebuildTransient(game);
}

/** The players' civs (everyone but The Blight). */
export function players(game) { return game.civs.filter((c) => !c.horde); }
function livePlayers(game) { return game.civs.filter((c) => !c.horde && c.alive); }

// ------------------------------------------------------------------ persistence

const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const fromB64 = (s) => { const buf = Buffer.from(s, 'base64'); const out = new Uint8Array(buf.byteLength); out.set(buf); return out; };

export function serializeHorde(game) {
  const h = game.horde;
  if (!h) return null;
  const f = h.fields;
  const { blight, blightKey, seen, ...saved } = h;   // derived (rebuildTransient)
  void blight; void blightKey; void seen;
  return { ...saved, groups: h.groups.map((g) => ({ ...g, units: g.units.map((u) => [...u]) })), risings: h.risings.map((r) => ({ ...r })),
    hives: h.hives.map((v) => ({ ...v })), stats: JSON.parse(JSON.stringify(h.stats)),
    fields: { soft: f.soft ? b64(f.soft) : null, hard: f.hard ? b64(f.hard) : null, softAt: f.softAt, hardAt: f.hardAt } };
}

export function restoreHorde(game, data) {
  if (!data) return;
  const f = data.fields || {};
  game.horde = { ...data, fields: { soft: f.soft ? fromB64(f.soft) : null, hard: f.hard ? fromB64(f.hard) : null, softAt: f.softAt ?? -1, hardAt: f.hardAt ?? -1 } };
  rebuildTransient(game);
}

/** Derived state (not saved): the corrupted-ground map and the creatures last seen alive. */
function rebuildTransient(game) {
  const h = game.horde;
  h.blight = new Uint8Array(N);
  h.blightKey = '';
  refreshBlight(game, h);
  h.seen = new Map();
  for (const u of game.units.values()) if (u.owner === h.civ && u.hp > 0) h.seen.set(u.id, { type: u.type, elite: u.elite || 0, x: u.x, z: u.z, wave: u.wave || 0 });
}

// ------------------------------------------------------------------ the step

/** Optional timing of the two heavy parts (tests / perf probes; never read by the simulation). */
export const PROFILE = { on: false, field: [], creatures: [], settled: [] };

/** One simulation tick of The Blight (scheduled last in ActionGame.tick). */
export function hordeStep(game) {
  const h = game.horde;
  if (!h || game.over || h.phase === 'over') return;
  const time = game.time;
  noteDeaths(game, h);
  phaseStep(game, h, time);
  spawnGroups(game, h, time);
  risingStep(game, h, time);
  hiveStep(game, h, time);
  const p0 = PROFILE.on ? performance.now() : 0;
  if (game.tickN % 25 === 3 || !h.fields.soft) buildField(game, h, 'soft');
  if (game.tickN % 50 === 28 || !h.fields.hard) buildField(game, h, 'hard');
  const p1 = PROFILE.on ? performance.now() : 0;
  creatureStep(game, h, time);
  if (PROFILE.on) { PROFILE.field.push(p1 - p0); PROFILE.creatures.push(performance.now() - p1); }
  let live = 0;
  h.seen.clear();
  for (const u of game.units.values()) if (u.owner === h.civ && u.hp > 0) {
    h.seen.set(u.id, { type: u.type, elite: u.elite || 0, x: u.x, z: u.z, wave: u.wave || 0 });
    if (u.type !== 'blight_hive') live++;
  }
  if (live > h.stats.peak) h.stats.peak = live;
}

/** Creatures that died since the last tick: score, broodsac bursts, burned hives. */
function noteDeaths(game, h) {
  for (const [id, s] of h.seen) {
    const u = game.units.get(id);
    if (u && u.hp > 0) continue;
    if (s.type === 'blight_hive') { hiveBurned(game, h, id, s); continue; }
    h.stats.killed++;
    h.stats.kills[s.type] = (h.stats.kills[s.type] || 0) + 1;
    h.stats.score += killScore(s.type, s.elite);
    if (s.type === 'blight_colossus') h.stats.bosses++;
    if (s.type === 'blight_broodsac') {
      const n = CREATURES.blight_broodsac.brood + s.elite * 2;
      const tile = tileAt(s.x, s.z);
      emit(game, { k: 'horde', o: 'burst', a: tile, b: tile, bx: r3(s.x), bz: r3(s.z), d: n, ty: s.type });
      for (let i = 0; i < n; i++) {
        const a = i * 2.39996 + id, p = standNear(game, { x: s.x + Math.sin(a) * .25, z: s.z + Math.cos(a) * .25 }, CREATURES.blight_crawler.radius, .8);
        if (p) spawnCreature(game, h, 'blight_crawler', Math.max(0, s.elite - 1), p.x, p.z, s.wave);
      }
    }
  }
}

// ------------------------------------------------------------------ waves

function level(game, h) { return hordeLevel(h.wave, game.time - h.startedAt); }

function phaseStep(game, h, time) {
  if (h.phase === 'prep' || h.phase === 'breather') {
    if (time >= h.phaseEnd - 10 && h.warned !== h.wave + 1) {
      h.warned = h.wave + 1;
      for (const c of livePlayers(game)) game.notify(c.id, `Wave ${h.wave + 1} in 10 seconds.`, { kind: 'warning', level: 'major', title: 'The Blight stirs' });
    }
    if (time >= h.phaseEnd) startWave(game, h, time);
    return;
  }
  // a wave: over when everything it brought is dead, or after its time limit (stragglers stay on the field)
  let left = 0;
  for (const g of h.groups) left += g.units.length;
  for (const u of game.units.values()) if (u.owner === h.civ && u.wave === h.wave && u.type !== 'blight_hive' && u.hp > 0) left++;
  const limit = HORDE.maxWaveSeconds + 2.5 * h.wave;
  if (left > 0 && time - h.waveStart < limit) return;
  endWave(game, h, time, left === 0);
}

function startWave(game, h, time) {
  h.wave++;
  h.phase = 'wave';
  h.waveStart = time;
  const L = level(game, h), live = livePlayers(game);
  const roster = planRoster(L, live.length, game.rng, h.cap);
  // shuffle (Fisher-Yates on game.rng) so every group carries a mix
  for (let i = roster.length - 1; i > 0; i--) { const j = Math.floor(game.rng() * (i + 1)); const t = roster[i]; roster[i] = roster[j]; roster[j] = t; }
  const window = 6 + Math.min(24, .6 * h.wave);
  const sources = spawnSources(game, h);
  const groups = [];
  // burrowing ambush: from wave HORDE.burrowFrom a share of the wave tunnels up close to a base
  let burrow = [];
  if (h.wave >= HORDE.burrowFrom && game.rng() < Math.min(.85, .4 + .03 * (h.wave - HORDE.burrowFrom))) {
    const take = Math.max(3, Math.floor(roster.length * .25));
    burrow = roster.splice(0, take);
  }
  const size = 8;
  const count = Math.max(1, Math.ceil(roster.length / size));
  const start = Math.floor(game.rng() * Math.max(1, sources.length));
  for (let g = 0; g < count; g++) {
    const src = sources[(start + g) % sources.length];
    groups.push({ at: r2(time + window * g / count), kind: src.hive ? 'hive' : 'edge', hive: src.hive || 0, x: src.x, z: src.z, units: roster.slice(g * size, (g + 1) * size) });
  }
  const bosses = bossCount(h.wave);
  for (let b = 0; b < bosses; b++) {
    const src = sources[(start + b + 1) % sources.length];
    groups.push({ at: r2(time + window * .5 + b * 3), kind: src.hive ? 'hive' : 'edge', hive: src.hive || 0, x: src.x, z: src.z, boss: 1,
      units: [['blight_colossus', Math.floor(L / 12)]] });
  }
  if (burrow.length) {
    const p = burrowPoint(game, h);
    if (p) {
      const at = r2(time + Math.min(window, 8) + 4);
      groups.push({ at, kind: 'burrow', hive: 0, x: p.x, z: p.z, warn: r2(at - 4), units: burrow });
    } else groups.push({ at: r2(time + window), kind: sources[0].hive ? 'hive' : 'edge', hive: sources[0].hive || 0, x: sources[0].x, z: sources[0].z, units: burrow });
  }
  groups.sort((a, b) => a.at - b.at);
  h.groups.push(...groups);
  h.waveTotal = groups.reduce((s, g) => s + g.units.length, 0);
  // stragglers of earlier waves join this one (they count toward it), and the dead it may raise are bounded
  for (const u of game.units.values()) if (u.owner === h.civ && u.type !== 'blight_hive' && u.hp > 0) u.wave = h.wave;
  h.riseBudget = Math.max(6, Math.ceil(h.waveTotal * .4));
  const where = direction(game, sources);
  for (const c of live) game.notify(c.id, `Wave ${h.wave}: ${h.waveTotal} creatures${bosses ? `, ${bosses === 1 ? 'a Colossus' : `${bosses} Colossi`}` : ''}${where ? ` from the ${where}` : ''}.`,
    { kind: 'war', level: 'critical', title: `Wave ${h.wave}` });
}

function endWave(game, h, time, cleared) {
  h.phase = 'breather';
  h.phaseEnd = r2(time + breatherSeconds(h.wave));
  const s = HORDE.supply, share = cleared ? 1 : .5;
  const mats = Math.round((s.materials + s.perWaveMaterials * h.wave) * share), energy = Math.round((s.energy + s.perWaveEnergy * h.wave) * share);
  if (cleared) { h.stats.cleared++; h.stats.score += 100 * h.wave; }
  h.stats.supplies += mats + energy;
  for (const c of livePlayers(game)) {
    c.res.materials += mats; c.res.energy += energy;
    game.notify(c.id, `${cleared ? `Wave ${h.wave} cleared.` : `Wave ${h.wave} is thinning out.`} Supply drop: +${mats} materials, +${energy} energy. Next wave in ${Math.round(h.phaseEnd - time)} s.`,
      { kind: 'info', level: 'major', title: cleared ? 'Wave cleared' : 'Breather' });
  }
  // the Blight grows back: one new hive per breather while it is below its target (not right after one was burned)
  const target = Math.min(HORDE.hiveMax, HORDE.hiveFirst + Math.max(0, livePlayers(game).length - 1) + Math.floor(h.wave / HORDE.hiveEvery));
  if (h.hives.length < target && time - h.hiveLostAt > 45) growHive(game, h, false);
}

/** Where a wave comes from: the hives, or (with every hive burned) the far ground they would grow on. */
function spawnSources(game, h) {
  const out = [];
  for (const v of h.hives) { const u = game.units.get(v.id); if (u && u.hp > 0) out.push({ hive: v.id, x: v.x, z: v.z }); }
  if (out.length) return out;
  const spots = hiveSpots(game, h, 2);
  if (spots.length) return spots.map((t) => ({ hive: 0, ...centerOf(t) }));
  const any = [...game.buildings.values()].find((b) => !game.civs[b.owner]?.horde) || game.sites[0];
  return [{ hive: 0, x: any.x, z: any.z + 8 }];
}

function direction(game, sources) {
  const mine = [...game.buildings.values()].filter((b) => b.type === 'town' && !game.civs[b.owner]?.horde);
  if (!mine.length || !sources.length) return '';
  let bx = 0, bz = 0, sx = 0, sz = 0;
  for (const b of mine) { bx += b.x; bz += b.z; }
  bx /= mine.length; bz /= mine.length;
  for (const s of sources) { sx += dxBetween(bx, s.x); sz += s.z - bz; }
  // world +z is south on the map (rows grow downward); the compass reads it as the client draws it
  const a = Math.atan2(sx, -sz), names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

function spawnGroups(game, h, time) {
  if (!h.groups.length) return;
  let live = liveCount(game, h);
  const L = level(game, h);
  for (let i = 0; i < h.groups.length; i++) {
    const g = h.groups[i];
    if (g.kind === 'burrow' && g.warn != null && time >= g.warn && !g.warned) {
      g.warned = 1;
      const tile = tileAt(g.x, g.z);
      emit(game, { k: 'horde', o: 'tremor', a: tile, b: tile, bx: r3(g.x), bz: r3(g.z), d: g.units.length });
      for (const c of livePlayers(game)) game.notify(c.id, 'The ground is moving near your lines. Something is tunnelling up.', { kind: 'warning', level: 'major', tile, title: 'Tremors' });
    }
    if (time < g.at) continue;
    let spawned = 0;
    while (g.units.length && live < h.cap) {
      const [type, elite] = g.units[0];
      const c = CREATURES[type], a = (g.units.length * 2.39996 + h.wave * 1.3) % (Math.PI * 2), rr = .6 + (g.units.length % 4) * .32;
      const p = standNear(game, { x: g.x + Math.sin(a) * rr, z: g.z + Math.cos(a) * rr }, c.radius * eliteSize(elite), 1.6);
      g.units.shift();
      if (!p) continue;
      const u = spawnCreature(game, h, type, elite, p.x, p.z, h.wave, L);
      if (g.kind === 'burrow') u.readyAt = time + 1.2;   // a moment to claw out of the ground
      live++; spawned++;
    }
    if (spawned) {
      const tile = tileAt(g.x, g.z);
      emit(game, { k: 'horde', o: g.kind === 'burrow' ? 'burrow' : g.boss ? 'roar' : 'spawn', a: tile, b: tile, bx: r3(g.x), bz: r3(g.z), d: spawned });
    }
    if (!g.units.length) { h.groups.splice(i, 1); i--; }
    else g.at = r2(time + 1);   // the live cap is full: the rest wait their turn
  }
}

function liveCount(game, h) {
  let n = 0;
  for (const u of game.units.values()) if (u.owner === h.civ && u.hp > 0 && u.type !== 'blight_hive') n++;
  return n;
}

function spawnCreature(game, h, type, elite, x, z, wave, L = level(game, h)) {
  const c = CREATURES[type], sc = hordeScale(L), hive = type === 'blight_hive';
  const hp = Math.round(c.hp * (hive ? 1 + .15 * L : sc.hp * eliteHp(elite)));
  const tile = tileAt(x, z);
  const u = { id: game.id_(), owner: h.civ, type, isUnit: true, x, z, tile, yaw: r3((x * 7.31 + z * 3.17) % (Math.PI * 2)), vx: 0, vz: 0, speed: 0,
    hp, maxHp: hp, radius: r3(c.radius * (hive ? 1 : eliteSize(elite))), mode: 'assault', goal: null, path: [], orders: [], lastCombat: -999,
    readyAt: game.time + .5, abilityReady: 0, abilityUntil: 0, blocked: 0, target: 0, kills: 0, altitude: 0, airBase: 0, grounded: false, formation: 0,
    stance: 'aggressive', elite, wave, dmg: r2(c.dmg * sc.dmg * eliteDmg(elite)), spd: r3(c.speed * (hive ? 0 : sc.speed)), hNext: 0, hTarget: 0 };
  game.units.set(u.id, u);
  game.movers.add(u);
  return u;
}

function standNear(game, p, radius, max) {
  const q = game.nav.nearest({ x: wrapX(p.x), z: p.z }, defOf(radius), max);
  return q && tileAt(q.x, q.z) >= 0 ? q : null;
}

// ------------------------------------------------------------------ infection

function risingStep(game, h, time) {
  if (!h.risings.length) return;
  let live = -1;
  for (let i = 0; i < h.risings.length; i++) {
    const r = h.risings[i];
    if (time < r.at) continue;
    h.risings.splice(i, 1); i--;
    if (live < 0) live = liveCount(game, h);
    for (let k = 0; k < r.n && live < h.cap; k++) {
      const a = k * 2.39996 + r.x, p = standNear(game, { x: r.x + Math.sin(a) * .18 * k, z: r.z + Math.cos(a) * .18 * k }, CREATURES.blight_husk.radius, .8);
      if (!p) continue;
      const u = spawnCreature(game, h, 'blight_husk', 0, p.x, p.z, h.phase === 'wave' ? h.wave : 0);
      u.readyAt = time + 1;
      const tile = tileAt(p.x, p.z);
      emit(game, { k: 'horde', o: 'rise', a: tile, b: tile, s: u.id, bx: r3(p.x), bz: r3(p.z), ty: r.from });
      h.stats.risen++;
      live++;
    }
  }
}

/** Damage dealt by a creature (strike, acid, slam). Infantry it kills rise again (risings). */
function wound(game, h, u, target, amount) {
  if (!target || target.hp <= 0) return;
  const d = target.isUnit ? ACTION_UNITS[target.type] : null;
  const infantry = d && d.move === 'infantry' && !d.horde && !d.air;
  damageActionTarget(game, target, u, amount, 'claws');
  if (!d) return;
  if (target.hp <= 0) h.stats.lost++;
  if (!infantry) return;
  // a squad the Blight wipes out rises again: a husk for every ~7 men (a 12-man rifle squad: 2), at least one
  if (target.hp > 0 || (h.riseBudget ?? 6) <= 0) return;
  h.carry += Math.max(1, (d.men || 1) * RISE_SHARE);
  const n = Math.floor(h.carry + 1e-9);
  if (n <= 0) return;
  h.carry = r3(h.carry - n);
  h.riseBudget = (h.riseBudget ?? 6) - n;
  h.risings.push({ at: r2(game.time + HORDE.riseDelay), x: r3(target.x), z: r3(target.z), n, from: target.type });
  emit(game, { k: 'horde', o: 'infect', a: target.tile, b: target.tile, bx: r3(target.x), bz: r3(target.z), d: n, ty: target.type });
}

// ------------------------------------------------------------------ hives and corrupted ground

/** Candidate hive tiles: passable ground far from every player base, joined to them by land. */
function hiveSpots(game, h, want) {
  const anchors = [];
  for (const s of game.sites) if (s.owner >= 0 && !game.civs[s.owner]?.horde) anchors.push(s);
  for (const b of game.buildings.values()) if (b.type === 'town' && !game.civs[b.owner]?.horde) anchors.push(b);
  if (!anchors.length) for (const c of players(game)) { const s = game.sites[c.id]; if (s) anchors.push(s); }
  const nav = game.nav, comp = typeof nav.componentOf === 'function' && anchors.length ? nav.componentOf(tileAt(anchors[0].x, anchors[0].z), MOVE) : null;
  const others = h.hives.map((v) => ({ x: v.x, z: v.z }));
  const scored = [];
  const stride = N > 20000 ? 3 : 2;
  for (let t = (game.tickN + h.wave) % stride; t < N; t += stride) {
    const w = game.world.terr[t];
    if (w === T.DEEP || w === T.SHALLOW || w === T.MOUNTAIN || w === T.PEAK || w === T.LAVA) continue;
    if (game.world.river?.[t] || game.world.lake?.[t]) continue;
    const p = centerOf(t);
    let near = Infinity;
    for (const a of anchors) { const d = distance(p, a); if (d < near) near = d; }
    if (near < 17) continue;
    let crowd = Infinity;
    for (const o of others) { const d = distance(p, o); if (d < crowd) crowd = d; }
    if (crowd < 11) continue;
    if (game.buildingAtTile(t) || game.sites.some((s) => s.tile === t)) continue;
    scored.push([t, near]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const out = [];
  for (const [t] of scored) {
    if (out.length >= Math.max(want, 1) * 6) break;
    if (comp != null && nav.componentOf(t, MOVE) !== comp) continue;
    if (!nav.canStand(TILE_X[t], TILE_Z[t], defOf(CREATURES.blight_hive.radius))) continue;
    out.push(t);
  }
  return out;
}

function growHive(game, h, initial) {
  const spots = hiveSpots(game, h, 1);
  if (!spots.length) return null;
  // the far half of the candidates, picked with game.rng
  const t = spots[Math.floor(game.rng() * Math.min(spots.length, 6))];
  const p = centerOf(t);
  const u = spawnCreature(game, h, 'blight_hive', 0, p.x, p.z, 0);
  h.hives.push({ id: u.id, x: r3(p.x), z: r3(p.z), tile: t, r: HORDE.blightRadius.start, born: r2(game.time) });
  emit(game, { k: 'horde', o: 'hive', a: t, b: t, s: u.id, bx: r3(p.x), bz: r3(p.z) });
  if (!initial) for (const c of livePlayers(game)) game.notify(c.id, 'A new Blight hive has erupted. Burn it before the rot spreads.', { kind: 'warning', level: 'major', tile: t, title: 'New hive' });
  refreshBlight(game, h);
  return u;
}

function hiveBurned(game, h, id, s) {
  const i = h.hives.findIndex((v) => v.id === id);
  if (i < 0) return;
  const v = h.hives[i];
  h.hives.splice(i, 1);
  h.hiveLostAt = r2(game.time);
  h.stats.hivesBurned++;
  const R = HORDE.hiveReward, scale = 1 + .08 * h.wave;
  const mats = Math.round(R.materials * scale), energy = Math.round(R.energy * scale);
  h.stats.score += Math.round(R.score * scale);
  h.stats.supplies += mats + energy;
  for (const c of livePlayers(game)) {
    c.res.materials += mats; c.res.energy += energy;
    game.notify(c.id, `Hive burned! The rot recedes. +${mats} materials, +${energy} energy.`, { kind: 'result', level: 'major', tile: v.tile, title: 'Hive destroyed' });
  }
  emit(game, { k: 'horde', o: 'burn', a: v.tile, b: v.tile, bx: r3(s.x), bz: r3(s.z), amount: mats });
  refreshBlight(game, h);
}

function hiveStep(game, h, time) {
  if (game.tickN % 10 !== 6) return;   // once a second
  const maxR = Math.min(10, HORDE.blightRadius.max + Math.floor(h.wave / 6));
  let changed = false;
  for (const v of h.hives) {
    const u = game.units.get(v.id);
    if (!u) continue;
    if (u.hp < u.maxHp && time - u.lastCombat > 4) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * .01);
    const r = Math.min(maxR, HORDE.blightRadius.start + Math.floor((time - v.born) / HORDE.blightRadius.grow));
    if (r !== v.r) { v.r = r; changed = true; }
  }
  if (changed) refreshBlight(game, h);
  // corrupted ground: creatures on it regenerate (2 % a second)
  for (const u of game.units.values()) if (u.owner === h.civ && u.hp > 0 && u.hp < u.maxHp && u.type !== 'blight_hive' && h.blight[u.tile])
    u.hp = Math.min(u.maxHp, r2(u.hp + u.maxHp * .02));
}

function refreshBlight(game, h) {
  if (!h.blight) return;
  const key = h.hives.map((v) => `${v.tile}:${v.r}`).join(',');
  if (key === h.blightKey) return;
  h.blightKey = key;
  h.blight.fill(0);
  for (const v of h.hives) for (const t of disk(v.tile, v.r)) h.blight[t] = 1;
}

/** Whether a tile is corrupted ground (blight). */
export function blighted(game, tile) { return !!game.horde?.blight?.[tile]; }

function burrowPoint(game, h) {
  const targets = [...game.buildings.values()].filter((b) => !game.civs[b.owner]?.horde && game.civs[b.owner]?.alive);
  if (!targets.length) return null;
  const b = targets[Math.floor(game.rng() * targets.length)];
  for (let k = 0; k < 6; k++) {
    const a = game.rng() * Math.PI * 2, r = 3.6 + game.rng() * 2.6;
    const p = standNear(game, { x: b.x + Math.sin(a) * r, z: b.z + Math.cos(a) * r }, .2, 1.2);
    if (p) return { x: r3(p.x), z: r3(p.z) };
  }
  return null;
}

// ------------------------------------------------------------------ flow fields

// Scratch for the field search (N is fixed per process).
let FW = null, HEAP_T = null, HEAP_K = null, WANT = null;
function heapPush(n, t, k) {
  if (n >= HEAP_T.length) { const t2 = new Int32Array(HEAP_T.length * 2); t2.set(HEAP_T); HEAP_T = t2; const k2 = new Float64Array(HEAP_K.length * 2); k2.set(HEAP_K); HEAP_K = k2; }
  let i = n;
  while (i > 0) { const p = (i - 1) >> 1; if (HEAP_K[p] < k || HEAP_K[p] === k && HEAP_T[p] <= t) break; HEAP_T[i] = HEAP_T[p]; HEAP_K[i] = HEAP_K[p]; i = p; }
  HEAP_T[i] = t; HEAP_K[i] = k;
  return n + 1;
}
function heapPop(n) {
  const t = HEAP_T[0], k = HEAP_K[0];
  n--;
  if (n > 0) {
    const lt = HEAP_T[n], lk = HEAP_K[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && (HEAP_K[c + 1] < HEAP_K[c] || HEAP_K[c + 1] === HEAP_K[c] && HEAP_T[c + 1] < HEAP_T[c])) c++;
      if (lk < HEAP_K[c] || lk === HEAP_K[c] && lt <= HEAP_T[c]) break;
      HEAP_T[i] = HEAP_T[c]; HEAP_K[i] = HEAP_K[c]; i = c;
    }
    HEAP_T[i] = lt; HEAP_K[i] = lk;
  }
  POP.t = t; POP.k = k;
  return n;
}
const POP = { t: 0, k: 0 };

/**
 * One shared flow field: for every hex, the neighbour direction (0-5) that leads toward the nearest source (6 at a
 * source, 7 unreached). Sources: 'soft' = player structures and ground troops; 'hard' = player structures, defenses
 * (and headquarters) first. Built from the navigation's public coarse costs, so it honours rivers, cliffs, mountains,
 * bridges and crowded compounds exactly as unit routes do.
 */
function buildField(game, h, kind) {
  if (!FW) { WANT = new Uint8Array(N); FW = new Float64Array(N); HEAP_T = new Int32Array(N * 2); HEAP_K = new Float64Array(N * 2); }
  // nothing to steer: keep the old field (saves the work during the build-up)
  let movers = 0;
  for (const u of game.units.values()) if (u.owner === h.civ && u.spd > 0) { movers++; break; }
  const f = h.fields;
  if (!movers && f[kind]) return;
  const dir = f[kind] || new Uint8Array(N);
  dir.fill(FIELD_NONE);
  FW.fill(Infinity);
  // the search stops once every creature's hex is settled (with a floor, so fresh spawns nearby are covered too):
  // hexes beyond them keep 'unreached' and a creature that wanders there steers at the nearest structure
  WANT.fill(0);
  let want = 0;
  for (const u of game.units.values()) if (u.owner === h.civ && u.spd > 0 && u.tile >= 0 && !WANT[u.tile]) { WANT[u.tile] = 1; want++; }
  for (const v of h.hives) if (!WANT[v.tile]) { WANT[v.tile] = 1; want++; }
  let settled = 0;
  let n = 0;
  const seed = (t, w) => { if (t >= 0 && w < FW[t]) { FW[t] = w; dir[t] = FIELD_GOAL; n = heapPush(n, t, w); } };
  for (const b of game.buildings.values()) {
    const owner = game.civs[b.owner];
    if (!owner || owner.horde || !owner.alive) continue;
    const def = ACTION_BUILDINGS[b.type];
    const defense = !!(def?.attack || def?.armor === 'fortified' || b.type === 'barricade');
    seed(b.tile, kind === 'hard' ? (defense ? 0 : 4) : 0);
  }
  if (kind === 'soft') for (const u of game.units.values()) {
    if (u.inside || u.hp <= 0 || u.owner === h.civ) continue;
    const owner = game.civs[u.owner];
    if (!owner || owner.horde || ACTION_UNITS[u.type]?.air) continue;
    seed(u.tile, .5);
  }
  const nav = game.nav;
  const fast = typeof nav.centreCost === 'function' && typeof nav.crowding === 'function' && typeof nav.edgeOk === 'function';
  while (n > 0) {
    n = heapPop(n);
    const t = POP.t, wt = POP.k;
    if (wt > FW[t]) continue;
    settled++;
    if (WANT[t]) { WANT[t] = 0; if (--want <= 0 && settled > 600) break; }
    // the price of entering t (same for every neighbour stepping into it)
    let enter = NaN;
    for (let d = 0; d < 6; d++) {
      const m = NB[t * 6 + d];
      if (m < 0) continue;
      let c;
      if (fast) {
        if (!Number.isFinite(nav.centreCost(m, MOVE)) || !nav.edgeOk(m, t, MOVE)) continue;
        if (enter !== enter) {
          enter = nav.centreCost(t, MOVE);
          if (Number.isFinite(enter)) { const crowd = nav.crowding(t, MOVE); if (crowd >= 1) enter *= 4; else if (crowd > 0) enter *= 1 + crowd * 1.6; }
        }
        c = enter;
      } else c = nav.stepCost(m, t, MOVE);
      if (!Number.isFinite(c)) continue;
      const w = wt + c;
      if (w >= FW[m]) continue;
      FW[m] = w;
      // direction from m to t
      let back = 0;
      for (let e = 0; e < 6; e++) if (NB[m * 6 + e] === t) { back = e; break; }
      dir[m] = back;
      n = heapPush(n, m, w);
    }
  }
  if (PROFILE.on) PROFILE.settled.push(settled);
  f[kind] = dir;
  f[kind + 'At'] = game.tickN;
}

// ------------------------------------------------------------------ creatures

const NEAR = [];
function creatureStep(game, h, time) {
  // nearest-structure fallback when a creature stands where the fields do not reach
  let anchors = null;
  for (const u of game.units.values()) {
    if (u.owner !== h.civ || u.hp <= 0 || u.type === 'blight_hive') continue;
    const c = CREATURES[u.type];
    if (!c) continue;
    // targets: re-chosen twice a second (staggered by id), kept while valid
    let target = u.hTarget ? game.units.get(u.hTarget) || game.buildings.get(u.hTarget) : null;
    if (target && (target.hp <= 0 || target.inside || !game.hostile(u.owner, target.owner) || distance(u, target) > c.aggro + 2.5)) { target = null; u.hTarget = 0; }
    if ((game.tickN + u.id) % 5 === 0) { target = pickTarget(game, h, u, c, target); u.hTarget = target ? target.id : 0; }
    u.target = target ? target.id : 0;
    let reach = Infinity;
    if (target) reach = distance(u, target) - (target.isUnit ? target.radius || .12 : target.radius || .3) - u.radius;
    if (target && reach <= c.reach) {
      u.vx = u.vz = u.speed = 0;
      u.yaw = r3(Math.atan2(dxBetween(u.x, target.x), target.z - u.z));
      if (time >= u.readyAt) strike(game, h, u, c, target, time);
      continue;
    }
    let tx, tz;
    if (target && reach < 4.5) { tx = target.x; tz = target.z; }
    else {
      const field = c.role === 'brute' || c.role === 'boss' ? h.fields.hard || h.fields.soft : h.fields.soft;
      const d = field ? field[u.tile] : FIELD_NONE;
      if (d < 6) {
        const m = NB[u.tile * 6 + d];
        // aim past the next hex centre with a per-creature offset, so a swarm spreads over the corridor
        const off = ((u.id * .618034) % 1 - .5) * .7;
        const ax = dxBetween(u.x, TILE_X[m]), az = TILE_Z[m] - u.z, al = Math.hypot(ax, az) || 1;
        tx = TILE_X[m] - az / al * off; tz = TILE_Z[m] + ax / al * off;
      } else {
        anchors ??= anchorList(game, h);
        let best = null, bd = Infinity;
        for (const a of anchors) { const dd = distance(u, a); if (dd < bd) { bd = dd; best = a; } }
        if (!best) { u.vx = u.vz = u.speed = 0; continue; }
        tx = best.x; tz = best.z;
      }
    }
    step(game, h, u, c, tx, tz, target, time);
  }
}

function anchorList(game, h) {
  const out = [];
  for (const b of game.buildings.values()) if (!game.civs[b.owner]?.horde && game.civs[b.owner]?.alive) out.push(b);
  if (!out.length) for (const u of game.units.values()) if (u.owner !== h.civ && u.hp > 0 && !u.inside) out.push(u);
  return out;
}

/** The best target in reach of the creature's senses for its role, or the current one. */
function pickTarget(game, h, u, c, current) {
  const near = game.targets.query(u.x, u.z, c.aggro, NEAR);
  let best = null, bestScore = Infinity;
  for (let i = 0; i < near.length; i++) {
    const v = near[i];
    if (v.hp <= 0 || v.inside || v.owner === h.civ || !game.hostile(u.owner, v.owner)) continue;
    const vd = v.isUnit ? ACTION_UNITS[v.type] : null;
    if (vd?.air && (v.altitude || 0) > .05) continue;
    const d = distance(u, v);
    if (d > c.aggro) continue;
    let score = d;
    if (c.role === 'brute' || c.role === 'boss') {
      if (v.isUnit) score += c.role === 'boss' ? 1 : 2.2;
      else { const bd = ACTION_BUILDINGS[v.type]; if (bd?.attack || bd?.armor === 'fortified' || v.type === 'barricade') score -= 1.2; }
    } else {
      if (!v.isUnit) score += 1.6;   // swarms and spitters want soft targets: troops first
      else if (vd?.move === 'infantry') score -= .5;
    }
    if (current && v.id === current.id) score -= .6;   // stickiness
    if (score < bestScore || score === bestScore && best && v.id < best.id) { bestScore = score; best = v; }
  }
  return best || current;
}

function strike(game, h, u, c, target, time) {
  u.readyAt = r2(time + c.cd * (.9 + ((u.id * 7 + game.tickN) % 5) * .05));
  u.lastCombat = time;
  const tile = target.tile;
  if (c.role === 'ranged') {
    emit(game, { k: 'horde', o: 'spit', a: u.tile, b: tile, s: u.id, t: target.id, ax: r3(u.x), az: r3(u.z), bx: r3(target.x), bz: r3(target.z), ty: u.type });
    wound(game, h, u, target, u.dmg * (target.isUnit ? 1 : c.vsB));
    // acid splash on whatever else stands close to the target
    const near = game.targets.query(target.x, target.z, c.splash, NEAR);
    for (let i = 0; i < near.length; i++) {
      const v = near[i];
      if (v === target || !v.isUnit || v.hp <= 0 || v.inside || !game.hostile(u.owner, v.owner) || distance(v, target) > c.splash) continue;
      if (ACTION_UNITS[v.type]?.air) continue;
      wound(game, h, u, v, u.dmg * .45);
    }
    return;
  }
  if (c.role === 'boss') {
    emit(game, { k: 'horde', o: 'slam', a: u.tile, b: u.tile, s: u.id, t: target.id, ax: r3(u.x), az: r3(u.z), bx: r3(target.x), bz: r3(target.z), r: c.slam, ty: u.type });
    wound(game, h, u, target, u.dmg * (target.isUnit ? 1 : c.vsB));
    const near = game.targets.query(u.x, u.z, c.slam + .5, NEAR).slice();
    for (const v of near) {
      if (v === target || v.hp <= 0 || v.inside || !game.hostile(u.owner, v.owner) || distance(v, u) > c.slam + (v.radius || 0)) continue;
      if (v.isUnit && ACTION_UNITS[v.type]?.air) continue;
      wound(game, h, u, v, u.dmg * (v.isUnit ? .6 : c.vsB * .5));
    }
    return;
  }
  emit(game, { k: 'horde', o: 'strike', a: u.tile, b: tile, s: u.id, t: target.id, ax: r3(u.x), az: r3(u.z), bx: r3(target.x), bz: r3(target.z), ty: u.type });
  wound(game, h, u, target, u.dmg * (target.isUnit ? 1 : c.vsB));
}

const PACE = { [T.FOREST]: .8, [T.HILLS]: .82, [T.MARSH]: .72, [T.DESERT]: .95, [T.TUNDRA]: .92 };
function step(game, h, u, c, tx, tz, target, time) {
  let dx = dxBetween(u.x, tx), dz = tz - u.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) { u.vx = u.vz = u.speed = 0; return; }
  dx /= len; dz /= len;
  // twitch: the heading jitters a little, differently per creature (the swarm never marches in step)
  const jitter = Math.sin(time * (2.3 + (u.id % 7) * .37) + u.id) * (c.role === 'swarm' ? .32 : .14);
  const js = Math.sin(jitter), jc = Math.cos(jitter);
  let vx = dx * jc + dz * js, vz = -dx * js + dz * jc;
  // separation from nearby creatures (and a softer push off anything else)
  const near = game.movers.query(u.x, u.z, u.radius + .35, NEAR);
  let sx = 0, sz = 0;
  for (let i = 0; i < near.length; i++) {
    const v = near[i];
    if (v === u || v.hp <= 0) continue;
    const ox = dxBetween(v.x, u.x), oz = u.z - v.z, d = Math.hypot(ox, oz), want = u.radius + (v.radius || .12) + .02;
    if (d >= want || d < 1e-5) continue;
    const push = (want - d) / want * (v.owner === u.owner ? 1 : .5);
    sx += ox / d * push; sz += oz / d * push;
  }
  vx += sx * 1.6; vz += sz * 1.6;
  const vl = Math.hypot(vx, vz) || 1;
  const pace = (PACE[game.world.terr[u.tile]] || 1) * (h.blight[u.tile] ? 1.15 : 1);
  const sp = u.spd * pace;
  vx = vx / vl * sp; vz = vz / vl * sp;
  const def = defOf(u.radius);
  const ox = u.x, oz = u.z;
  let moved = false;
  for (const turn of [0, .55, -.55, 1.2, -1.2]) {
    const cs = Math.cos(turn), sn = Math.sin(turn);
    const mx = vx * cs + vz * sn, mz = -vx * sn + vz * cs;
    const nx = wrapX(u.x + mx * DT), nz = u.z + mz * DT;
    if (game.nav.canStand(nx, nz, def)) { u.x = r3(nx); u.z = r3(nz); u.vx = r3(mx); u.vz = r3(mz); moved = true; break; }
  }
  if (!moved) {
    u.vx = u.vz = u.speed = 0;
    u.blocked = (u.blocked || 0) + 1;
    // walled in by a player structure: tear into it
    if (!target || target.isUnit) {
      const t = tileAt(wrapX(u.x + vx * .4), u.z + vz * .4);
      const wall = t >= 0 ? game.obstaclesAtTile(t).find((b) => b.hp > 0 && game.hostile(u.owner, b.owner)) : null;
      if (wall) u.hTarget = wall.id;
    }
    // stuck for a few seconds: step to the nearest open spot
    if (u.blocked > 30) {
      const p = game.nav.nearest(u, def, .9);
      if (p) { u.x = r3(p.x); u.z = r3(p.z); }
      u.blocked = 0;
    }
  } else {
    u.blocked = 0;
    u.speed = r3(sp);
    u.yaw = r3(Math.atan2(u.vx, u.vz));
  }
  const tile = tileAt(u.x, u.z);
  if (tile >= 0) u.tile = tile;
  if (u.x !== ox || u.z !== oz) game.movers.moved(u, ox, oz);
}

// ------------------------------------------------------------------ outcome

/** Called from ActionGame.checkVictory in a horde match: the players lose once every one of them has fallen. */
export function hordeOutcome(game) {
  const h = game.horde;
  if (!h || game.over) return;
  if (livePlayers(game).length) return;
  h.phase = 'over';
  h.stats.endedAt = r2(game.time);
  const civ = game.civs[h.civ];
  game.endGame(civ, `Overrun on wave ${h.wave}`);
  if (game.winner) game.winner.horde = summary(game);
}

/** The run's result for the defeat screen and best-score tables. */
export function summary(game) {
  const h = game.horde;
  return { wave: h.wave, score: h.stats.score, seconds: Math.round((h.stats.endedAt ?? game.time) - h.startedAt), killed: h.stats.killed, kills: { ...h.stats.kills },
    hives: h.stats.hivesBurned, risen: h.stats.risen, lost: h.stats.lost, peak: h.stats.peak, cleared: h.stats.cleared, bosses: h.stats.bosses, supplies: h.stats.supplies,
    map: game.mapId, players: players(game).length };
}

// ------------------------------------------------------------------ wire

/**
 * The horde block of a viewer snapshot ('horde'): wave counter and phase, countdown, creatures left, score, hives with
 * their corrupted-ground radius, threat clusters (where the creatures are massing: the HUD's edge arrows and minimap
 * pings), tunnelling warnings, and once a second (econ) the elite levels and the run's statistics.
 */
export function hordeWire(game, econ) {
  const h = game.horde;
  if (!h) return undefined;
  const time = game.time;
  let left = 0, live = 0;
  for (const g of h.groups) left += g.units.length;
  const cells = new Map();
  const elite = econ ? {} : undefined;
  for (const u of game.units.values()) {
    if (u.owner !== h.civ || u.hp <= 0 || u.type === 'blight_hive') continue;
    live++;
    if (u.wave === h.wave) left++;
    if (elite && u.elite) elite[u.id] = u.elite;
    const key = Math.floor(u.x / 7) * 4096 + Math.floor(u.z / 7);
    const cell = cells.get(key);
    if (cell) { cell[0] += u.x; cell[1] += u.z; cell[2]++; cell[3] = Math.max(cell[3], u.type === 'blight_colossus' ? 2 : u.elite ? 1 : 0); }
    else cells.set(key, [u.x, u.z, 1, u.type === 'blight_colossus' ? 2 : u.elite ? 1 : 0]);
  }
  const threats = [...cells.values()].sort((a, b) => b[2] - a[2] || a[0] - b[0]).slice(0, 10).map((c) => [r2(c[0] / c[2]), r2(c[1] / c[2]), c[2], c[3]]);
  const hives = h.hives.map((v) => { const u = game.units.get(v.id); return [v.id, v.x, v.z, v.r, u ? Math.round(u.hp / u.maxHp * 100) : 0]; });
  const warn = h.groups.filter((g) => g.kind === 'burrow' && g.warned).map((g) => [g.x, g.z]);
  const out = { w: h.wave, ph: PHASES.indexOf(h.phase), t: h.phase === 'wave' ? Math.round(time - h.waveStart) : Math.max(0, Math.ceil(h.phaseEnd - time)),
    left, live, cap: h.cap, total: h.waveTotal, lvl: r2(level(game, h)), sc: h.stats.score, st: Math.round((h.stats.endedAt ?? time) - h.startedAt),
    boss: bossCount(h.phase === 'wave' ? h.wave : h.wave + 1) ? 1 : 0, hv: hives, th: threats, bw: warn.length ? warn : undefined };
  if (econ) {
    out.el = elite;
    out.stats = { killed: h.stats.killed, hives: h.stats.hivesBurned, risen: h.stats.risen, lost: h.stats.lost, peak: h.stats.peak, cleared: h.stats.cleared, bosses: h.stats.bosses };
  }
  return out;
}
