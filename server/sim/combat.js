import { nativeRules, tempo } from './rulesets.js';
// Combat resolution: weapons fire (hitscan volleys or authoritative projectiles that damage on
// impact), area blasts, suppression and morale, cover and line of fire, target choice with
// overkill avoidance, and a sequenced combat-event stream that clients replay.
import { book } from './ledger.js';
import { trenchCover, damageFieldworks } from './fieldworks.js';
import { UNITS, BUILDINGS, TERRAIN, T, isWater, techFx } from './constants.js';
import { WEAPONS, UNIT_WEAPON, BUILDING_WEAPON, WEAPON_KEYS, ARMORED, weaponVs } from './weapons.js';
import { disk, dist, hexLine } from './hex.js';
import { damageUnit, damageBuilding, canHit } from './military.js';
import { addCrater, addSmoke, smokeAt, scarCover, fieldPosCover, addIntensity } from './battlefield.js';

export const CSTAT = ['idle', 'moving', 'engaging', 'repositioning', 'suppressed', 'out_of_range', 'no_los', 'reloading', 'low_ammo', 'retreating', 'pinned'];
export const CS = Object.fromEntries(CSTAT.map((k, i) => [k, i]));
const WIDX = Object.fromEntries(WEAPON_KEYS.map((k, i) => [k, i]));

// ------------------------------------------------------------------ events
// Every authoritative combat happening gets a sequence number. The match keeps a bounded buffer;
// each viewer receives what it is allowed to see since the last sequence it was sent.
export function emit(g, ev) {
  ev.i = ++g.eventSeq; ev.n = g.tickN;
  g.events.push(ev);
  if (g.events.length > 6000) g.events.splice(0, g.events.length - 4000);
}

// Fog-aware projection of the event stream for one viewer. A hidden shooter's position is never
// revealed: impacts in view arrive without an origin.
export function eventsFor(g, since, vis, god) {
  const out = [];
  const ev = g.events;
  let lo = 0, hi = ev.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].i <= since) lo = m + 1; else hi = m; }
  for (let k = lo; k < ev.length; k++) {
    const e = ev[k];
    if (god) { out.push(e); continue; }
    const seeA = e.a >= 0 && vis[e.a] === 1, seeB = e.b >= 0 && vis[e.b] === 1;
    if (e.k === 'fire' || e.k === 'launch') {
      if (seeA) out.push(e);
      else if (seeB) out.push({ ...e, a: -1, s: undefined });
    } else if (seeB) out.push(seeA ? e : { ...e, a: -1, s: undefined });
  }
  return out;
}

// ------------------------------------------------------------------ terrain & cover
export function coverAt(g, u, from = -1, indirect = false) {
  const def = UNITS[u.type];
  if (def.air) return 0;
  const w = g.world, t = u.tile;
  let c = 0;
  const b = g.buildingAtTile(t);
  if (b && b.owner === u.owner && b.done) c = b.type === 'fort' || b.type === 'bunker' ? 0.5 : b.type === 'town' ? 0.4 : 0.3;
  if (g.ruins.has(t)) c = Math.max(c, 0.3);
  c = Math.max(c, scarCover(g, t));
  if (w.terr[t] === T.FOREST) c = Math.max(c, 0.15);
  if (g.urban?.[t]) c = Math.max(c, 0.3);                // built-up districts: strong infantry positions
  // troops beside their own bunker or fortress shelter behind it (one source, never stacked)
  for (const n of disk(t, 1)) { if (n === t) continue; const o = g.buildingAtTile(n); if (o && o.owner === u.owner && o.done && BUILDINGS[o.type].shelter) c = Math.max(c, BUILDINGS[o.type].shelter * 2 * (o.hp / o.maxHp)); }
  c = Math.max(c, fieldPosCover(g, u));                   // a scraped foxhole
  c = def.move === 'infantry' ? c : c * 0.5;
  // field trenches: directional, and the best cover counts (sources never add up past a cap)
  if (g.fieldworks?.size) c = Math.max(c, trenchCover(g, u, from, indirect));
  return Math.min(0.6, c);
}

// Direct fire needs a clear line: peaks and mountains block it, forests, buildings and smoke
// degrade it. Indirect fire and aircraft ignore it.
export function lineOfFire(g, from, to, indirect, air) {
  if (indirect || air || from === to) return { ok: true, acc: 1 };
  const w = g.world;
  const high = w.terr[from] === T.MOUNTAIN || w.terr[from] === T.HILLS;
  let acc = 1;
  const line = hexLine(from, to);
  for (let i = 1; i < line.length - 1; i++) {
    const t = line[i], tr = w.terr[t];
    if (tr === T.PEAK) return { ok: false, acc: 0 };
    if (tr === T.MOUNTAIN && !high) return { ok: false, acc: 0 };
    if (tr === T.FOREST) acc *= 0.85;
    const b = g.buildingAtTile(t); if (b && b.done && (b.type === 'town' || b.type === 'fort')) acc *= 0.7;
    const s = smokeAt(g, t); if (s) acc *= 1 - 0.4 * s;
  }
  return { ok: acc > 0.15, acc };
}

const targetKey = (tg) => (tg.kind === 'unit' ? tg.id : -tg.id);

// ------------------------------------------------------------------ veterancy & combined arms
export const VET = [0, 30, 80, 160];             // xp for regular, veteran, elite
export const vetLevel = (u) => { const x = u.xp || 0; return x >= VET[3] ? 3 : x >= VET[2] ? 2 : x >= VET[1] ? 1 : 0; };
// infantry, armour and artillery fighting together beat any one of them alone (cached for 2 s)
const ARMS = { infantry: 'inf', tracked: 'arm', wheeled: 'arm', artillery: 'art', air: 'air' };
function combinedArms(g, u) {
  if (u.caT != null && g.time - u.caT < 2) return u.ca;
  const kinds = new Set();
  for (const o of g.units.values()) if (o.owner === u.owner && dist(o.tile, u.tile) <= 3) { const k = ARMS[UNITS[o.type].cat]; if (k) kinds.add(k); }
  u.ca = kinds.size >= 3 ? 0.15 : kinds.size === 2 ? 0.06 : 0; u.caT = g.time;
  return u.ca;
}

// ------------------------------------------------------------------ firing
// Firing effectiveness by supply: 50-100 full, 25-49 reduced, 10-24 severe, under 10 barely.
export function supplyFire(s, hiTech) {
  const f = s >= 50 ? 1 : s >= 25 ? 0.85 + (s - 25) * 0.006 : s >= 10 ? 0.6 + (s - 10) * 0.0167 : 0.4 + s * 0.02;
  return hiTech ? 1 - (1 - f) * 1.35 : f;
}
// Recovery (healing, morale, suppression shaking-off) by supply and command cohesion.
export function recoveryFactor(u) { const s = u.supply ?? 100; return (s >= 80 ? 1 : s >= 50 ? 0.7 : s >= 25 ? 0.45 : 0.25) * (0.6 + 0.4 * (u.cohesion ?? 1)); }

// Attacker-side strength of one shot from a unit (supply, health, government, munitions, terrain).
function unitStrength(g, u) {
  const def = UNITS[u.type], civ = g.civs[u.owner], w = g.world;
  let a = def.atk;
  if (!nativeRules(civ) && civ.gov === 'corporate') a *= 0.9;
  if (!nativeRules(civ) && civ.gov === 'junta') a *= 1.1;
  if ((!nativeRules(civ) && civ.policies.has('total_war'))) a *= 1.2;
  { const fx = techFx(civ).atk; a *= 1 + (fx.all || 0) + (fx[def.cat] || 0); }      // what the nation has learned
  // supply bands: full strength above half supply, then a gradual decline (never zero: an
  // isolated defender can still resist); high-tech equipment feels it more
  a *= supplyFire(u.supply, def.age >= 2);
  a *= 1 + 0.1 * vetLevel(u);
  a *= 1 + combinedArms(g, u);
  a *= 0.5 + 0.5 * (u.hp / u.maxHp);
  u.lowAmmo = false;
  if (def.age >= 1) { const need = 0.05 * (def.cat === 'artillery' ? 3 : 1); if (civ.res.munitions >= need) { civ.res.munitions -= need; book(civ, 'army', 'munitions', -need); } else { a *= 0.6; u.lowAmmo = true; } }
  if (!def.air && w.river[u.tile] && !w.road[u.tile] && def.range <= 1) a *= 0.75;
  if (isWater(w.terr[u.tile]) && !def.air) a *= 0.6;
  // suppressed and shaken soldiers shoot worse
  a *= 1 - 0.45 * Math.min(1, (u.supp || 0) / 100);
  if ((u.morale ?? 100) < 30) a *= 0.75;
  return a;
}

export function fireUnit(g, u, tg, tt) {
  const def = UNITS[u.type];
  const wk = UNIT_WEAPON[u.type] || 'carbine', wpn = WEAPONS[wk];
  if (u.air && def.ammo && u.air.ammo <= 0) return false;          // aircraft carry finite ammunition per sortie
  if (u.grounded) return false;
  const lof = lineOfFire(g, u.tile, tt, !!wpn.arc, !!def.air || (tg.kind === 'unit' && !!UNITS[g.units.get(tg.id)?.type]?.air));
  if (!lof.ok) return false;
  const strength = unitStrength(g, u);
  release(g, { kind: 'unit', obj: u, owner: u.owner, tile: u.tile, def, vsBuildings: def.vsBuildings || 1, bonus: def.bonus, wk }, wk, wpn, strength, lof.acc, tg, tt);
  u.cooldown = wpn.cooldown * (def.cat === 'artillery' && wk === 'howitzer' ? 1 : 1);
  u.lastCombat = g.time;
  if (u.air && def.ammo) u.air.ammo = Math.max(0, u.air.ammo - 1);
  return true;
}

// a one-way drone reaches its target: one warhead impact (same path as any real impact)
export function detonate(g, u, tile) {
  const def = UNITS[u.type], wk = UNIT_WEAPON[u.type] || 'warhead';
  const str = def.atk * (0.6 + 0.4 * (u.hp / u.maxHp)) * supplyFire(100, false);
  emit(g, { k: 'launch', s: u.id, sb: 0, t: 0, tb: 0, a: tile, b: tile, w: WIDX[wk], f: 0.1, x: 1, p: -u.id });
  impact(g, { id: g.id_(), owner: u.owner, src: u.id, sb: 0, w: wk, from: tile, to: tile, aim: tile, tg: { kind: 'tile', id: 0 }, at: g.time, launched: g.time, str, acc: 1, vsB: def.vsBuildings || 1, bonus: def.bonus || null });
}

export function fireBuilding(g, b, target) {
  const bd = BUILDINGS[b.type], civ = g.civs[b.owner];
  const wk = BUILDING_WEAPON[b.type] || 'mg', wpn = WEAPONS[wk];
  if (!weaponVs(wk, UNITS[target.type])) return false;
  const lof = lineOfFire(g, b.tile, target.tile, !!wpn.arc, !!UNITS[target.type].air);
  if (!lof.ok) return false;
  // installations that fire munitions (AA batteries) stop when the stockpile is empty
  if (bd.ammo) { if ((civ.res.munitions || 0) < bd.ammo) { b.noAmmo = true; return false; } civ.res.munitions -= bd.ammo; book(civ, 'army', 'munitions', -bd.ammo); b.noAmmo = false; }
  let a = bd.attack * ((!nativeRules(civ) && civ.policies.has('fortification')) && b.type !== 'town' && bd.defense === 'ground' ? 1.5 : 1) * (0.4 + 0.6 * b.hp / b.maxHp);
  if (b.upgraded) a *= 1.25;          // upgraded fire control (Air Defense)
  // diminishing returns when many static defenses pour fire on one target in the same moment
  const df = g.defFire || (g.defFire = new Map()), k = 'd' + target.id, n = (df.get(k) || 0) + 1; df.set(k, n);
  if (n > 2) a *= 1 / (1 + 0.35 * (n - 2));
  release(g, { kind: 'building', obj: b, owner: b.owner, tile: b.tile, def: null, vsBuildings: 1, bonus: null, wk }, wk, wpn, a, lof.acc * (b.upgraded ? 1.15 : 1), { kind: 'unit', id: target.id }, target.tile);
  b.cooldown = Math.max(2, wpn.cooldown);
  b.lastFire = g.time; b.aimAt = target.tile;
  return true;
}

// Fire a weapon: hitscan volleys resolve now, projectiles resolve when they land.
function release(g, src, wk, wpn, strength, acc, tg, tt) {
  const smoke = smokeAt(g, tt);
  acc *= 1 - 0.5 * smoke;
  const sid = src.obj.id, sb = src.kind === 'building' ? 1 : 0;
  if (wpn.mode === 'hitscan') {
    emit(g, { k: 'fire', s: sid, sb, t: tg.id, tb: tg.kind === 'building' ? 1 : 0, a: src.tile, b: tt, w: WIDX[wk], x: wpn.burst });
    resolveHit(g, src, wpn, strength, acc, tg, tt, 1);
    return;
  }
  const salvo = wpn.salvo || 1;
  const flight = wpn.flight * (wpn.arc ? 0.7 + 0.12 * dist(src.tile, tt) : 1);
  // indirect fire scatters: poor accuracy can drop the shell on a neighbouring hex
  let impact = tt;
  if (wpn.arc && g.rng() > 0.55 + 0.45 * acc) { const ring = disk(tt, 1).filter((t) => t !== tt); impact = ring[Math.floor(g.rng() * ring.length)] ?? tt; }
  const p = { id: g.id_(), owner: src.owner, src: sid, sb, w: wk, from: src.tile, to: impact, aim: tt, tg, at: g.time + flight, launched: g.time,
    str: strength / salvo, acc, vsB: src.vsBuildings, bonus: src.bonus || null, wk };
  for (let s = 0; s < salvo; s++) {
    const q = s ? { ...p, id: g.id_(), at: p.at + s * 0.12 } : p;
    g.projectiles.set(q.id, q);
    const key = targetKey(tg);
    g.pending.set(key, (g.pending.get(key) || 0) + expectedDamage(g, q.str, tg));
  }
  emit(g, { k: 'launch', s: sid, sb, t: tg.id, tb: tg.kind === 'building' ? 1 : 0, a: src.tile, b: impact, w: WIDX[wk], f: +flight.toFixed(2), x: wpn.airburst ? wpn.burst : salvo, p: p.id });
}

function expectedDamage(g, str, tg) {
  if (tg.kind !== 'unit') return str;
  const e = g.units.get(tg.id); if (!e) return 0;
  return str * 1.6 * (10 / (10 + UNITS[e.type].def));
}

// Damage to one target from one shot/volley; returns damage dealt.
function resolveHit(g, src, wpn, strength, acc, tg, tt, factor) {
  const w = g.world;
  const rand = 0.85 + g.rng() * 0.3;
  if (tg.kind === 'unit') {
    const e = g.units.get(tg.id); if (!e) return 0;
    const ed = UNITS[e.type];
    // the weapon's target classes decide: a ground-only gun never touches an aircraft
    const vs = weaponVs(src.wk, ed);
    if (!vs) return 0;
    let a = strength * vs;
    if (src.bonus && src.bonus[ed.cat]) a *= src.bonus[ed.cat];
    if (ARMORED.has(ed.cat)) a *= wpn.vsArmor;
    let d = ed.def * (ed.air ? 1 : 1 + TERRAIN[w.terr[e.tile]].def) * (1 + 0.08 * vetLevel(e));
    const fortB = g.buildingAtTile(e.tile); if (fortB && fortB.owner === e.owner && (fortB.type === 'fort' || fortB.type === 'bunker')) d *= 1.5;
    if (isWater(w.terr[e.tile]) && !ed.air) d *= 0.5;
    const cover = coverAt(g, e, src.tile, !!wpn.arc);
    const dmg = a * 1.6 * rand * (10 / (10 + d)) * acc * factor * (1 - cover);
    suppress(g, e, wpn.supp * factor * (1 - Math.min(0.8, cover * 1.4)));
    if (dmg <= 0.05) { emit(g, { k: 'hit', t: e.id, b: e.tile, d: 0, o: 'blocked', a: src.tile }); return 0; }
    e.morale = Math.max(0, (e.morale ?? 100) - (dmg / e.maxHp) * 25);
    const dies = e.hp - dmg <= 0;
    emit(g, { k: 'hit', s: src.obj.id, t: e.id, a: src.tile, b: e.tile, d: Math.round(dmg), o: dies ? 'destroyed' : 'hit', c: cover >= 0.25 ? 1 : 0 });
    if (src.kind === 'unit') src.obj.xp = (src.obj.xp || 0) + dmg * 0.15 + (dies ? 8 : 0);
    e.xp = (e.xp || 0) + 0.5;                       // surviving fire is experience too
    damageUnit(g, e, dmg, src.owner, 'combat');
    return dmg;
  }
  const b = g.buildings.get(tg.id); if (!b) return 0;
  if (!WEAPONS[src.wk]?.targets.includes('ground')) return 0;      // anti-air guns cannot hit structures
  const bd = BUILDINGS[b.type];
  let d = bd.attack ? 12 : 6;
  if ((b.type === 'fort' || b.type === 'bunker') && g.civs[b.owner].policies.has('fortification')) d *= 1.5;
  const dmg = strength * 1.6 * rand * (src.vsBuildings || 1) * (wpn.he ? 1 + wpn.he * 0.3 : 0.6) * (10 / (10 + d)) * acc * factor;
  const dies = b.hp - dmg <= 0;
  emit(g, { k: 'bhit', s: src.obj.id, t: b.id, a: src.tile, b: b.tile, d: Math.round(dmg), o: dies ? 'destroyed' : 'hit' });
  damageBuilding(g, b, dmg, src.owner, 'combat');
  return dmg;
}

// Projectiles land in id order on the tick they arrive, so replays stay deterministic.
export function projectilesStep(g) {
  if (!g.projectiles.size) return;
  for (const p of [...g.projectiles.values()]) {
    if (g.time + 1e-9 < p.at) continue;
    g.projectiles.delete(p.id);
    const key = targetKey(p.tg);
    const left = (g.pending.get(key) || 0) - expectedDamage(g, p.str, p.tg);
    if (left > 0.5) g.pending.set(key, left); else g.pending.delete(key);
    impact(g, p);
  }
}

function impact(g, p) {
  const wpn = WEAPONS[p.w];
  const src = { kind: p.sb ? 'building' : 'unit', obj: { id: p.src }, owner: p.owner, tile: p.from, vsBuildings: p.vsB, bonus: p.bonus, wk: p.w };
  if (wpn.airburst) return airburst(g, p, src, wpn);
  let to = p.to;
  // guided munitions follow a target that moved a little; unguided direct fire misses it
  const tgt = p.tg.kind === 'unit' ? g.units.get(p.tg.id) : g.buildings.get(p.tg.id);
  if (tgt && p.tg.kind === 'unit' && wpn.guided && dist(tgt.tile, p.aim) <= 2) to = tgt.tile;
  let hitDirect = 0;
  const direct = tgt && (p.tg.kind === 'building' ? tgt.tile === to : tgt.tile === to);
  if (!wpn.blast) {
    if (direct) hitDirect = resolveHit(g, src, wpn, p.str, p.acc, p.tg, to, 1);
    emit(g, { k: 'impact', a: p.from, b: to, w: WIDX[p.w], o: direct ? (hitDirect > 0 ? 'hit' : 'blocked') : 'miss', p: p.id, t: p.tg.id });
  } else {
    // area weapon: the target hex takes full effect, the ring around it a share
    emit(g, { k: 'impact', a: p.from, b: to, w: WIDX[p.w], o: direct ? 'hit' : to === p.aim ? 'area' : 'miss', p: p.id, t: p.tg.id, r: wpn.blast });
    blast(g, src, wpn, p.str, p.acc, to, p.tg);
  }
  // high explosives scar the ground, the roads and the air
  if (wpn.he >= 0.5 && g.fieldworks?.size) for (const t of disk(to, wpn.blast || 0)) if (g.fieldworks.has(t)) damageFieldworks(g, t, (t === to ? 14 : 6) * wpn.he);
  if (wpn.he >= 0.5) addIntensity(g, to, 0.8 * wpn.he);     // every explosion adds to the battlefield's wear
  if (wpn.he >= 1 && !isWater(g.world.terr[to])) {
    if (g.rng() < 0.35 * wpn.he) addCrater(g, to, wpn.he >= 1.5 ? 2 : 1);
    if (g.rng() < 0.3) g.roads.damageTile(to, 10 * wpn.he, g.rng, 0.5);
    addSmoke(g, to, 0.25 + 0.15 * wpn.he, 8 + 6 * wpn.he);
  } else if (wpn.he >= 0.5) addSmoke(g, to, 0.15, 5);
}

// An anti-aircraft round bursts in the air where its target was aimed. It hits only if the aircraft
// is still close to that point; a burst never scars the ground, damages trenches or reveals anything.
function airburst(g, p, src, wpn) {
  const tgt = p.tg.kind === 'unit' ? g.units.get(p.tg.id) : null;
  const close = tgt && UNITS[tgt.type].air && dist(tgt.tile, p.aim) <= 1;
  let d = 0;
  if (close) d = resolveHit(g, src, wpn, p.str, p.acc * (tgt.tile === p.aim ? 1 : 0.6), p.tg, tgt.tile, 1);
  emit(g, { k: 'impact', a: p.from, b: tgt ? tgt.tile : p.to, w: WIDX[p.w], o: d > 0 ? 'hit' : 'miss', p: p.id, t: p.tg.id, ab: 1 });
}

// tests and the sandbox: one shell of a weapon lands on a hex (same path as a real impact)
export function testImpact(g, owner, tile, wk, str = 20) {
  impact(g, { id: g.id_(), owner, src: 0, sb: 0, w: wk, from: tile, to: tile, aim: tile, tg: { kind: 'tile', id: 0 }, at: g.time, launched: g.time, str, acc: 1, vsB: 1, bonus: null });
}

function blast(g, src, wpn, str, acc, center, tg) {
  for (const t of disk(center, wpn.blast)) {
    const f = t === center ? 1 : wpn.falloff ?? 0.4;
    const ids = g.tileUnits.get(t);
    if (ids) for (const id of [...ids]) {
      const e = g.units.get(id);
      if (!e || !g.hostile(src.owner, e.owner)) continue;
      if (!weaponVs(src.wk, UNITS[e.type]) || e.grounded) continue;           // bombs and shells do not hit aircraft overhead
      e.blastAt = g.time;
      resolveHit(g, src, wpn, str, acc, { kind: 'unit', id }, t, f);
    }
    // nearby friendly troops are rattled, not hurt
    if (ids) for (const id of ids) { const e = g.units.get(id); if (e && e.owner !== src.owner && !g.hostile(src.owner, e.owner)) suppress(g, e, wpn.supp * f * 0.3); }
    const b = g.buildingAtTile(t);
    if (b && g.hostile(src.owner, b.owner) && (t === center || tg.kind === 'building')) resolveHit(g, src, wpn, str, acc, { kind: 'building', id: b.id }, t, f * (t === center ? 1 : 0.5));
  }
}

// ------------------------------------------------------------------ suppression & morale
export function suppress(g, u, amount) {
  if (!(amount > 0) || UNITS[u.type].civilian) return;
  const before = u.supp || 0;
  u.supp = Math.min(100, before + amount);
  u.suppAt = g.time;
  if (before < 60 && u.supp >= 60) emit(g, { k: 'supp', t: u.id, b: u.tile, o: 'on' });
}

// Losses nearby shake a unit; a quiet moment and comrades around it steady it again.
export function onUnitLost(g, u) {
  for (const t of disk(u.tile, 2)) {
    const ids = g.tileUnits.get(t); if (!ids) continue;
    for (const id of ids) { const f = g.units.get(id); if (f && f.owner === u.owner && f.id !== u.id) f.morale = Math.max(0, (f.morale ?? 100) - (t === u.tile ? 15 : 9)); }
  }
}

export function moraleStep(g, dt) {
  for (const u of g.units.values()) {
    if (UNITS[u.type].civilian) continue;
    if (u.supp > 0 && g.time - (u.suppAt || 0) > 2) {
      const before = u.supp;
      u.supp = Math.max(0, u.supp - 12 * dt * (coverAt(g, u) > 0.2 ? 1.5 : 1) * (0.6 + 0.4 * (u.cohesion ?? 1)));
      if (before >= 60 && u.supp < 60) emit(g, { k: 'supp', t: u.id, b: u.tile, o: 'off' });
    }
    const m = u.morale ?? 100;
    if (g.time - u.lastCombat > 6) u.morale = Math.min(100, m + (u.outOfSupply ? 0.5 : 3) * recoveryFactor(u) * dt);
    else if (u.outOfSupply) u.morale = Math.max(0, m - 0.5 * dt);
  }
}

// ------------------------------------------------------------------ target choice
// Score the hostile targets a unit can engage. Policies change what matters; damage already on
// its way to a target (projectiles in flight, shots assigned this tick) discourages overkill.
export function chooseTarget(g, u, radius, policy) {
  const def = UNITS[u.type];
  const wk = UNIT_WEAPON[u.type] || 'carbine', wpn = WEAPONS[wk];
  policy = policy || u.policy || defaultPolicy(u.type);
  let best = null, bs = -Infinity, bt = -1;
  const myShot = def.atk * 1.6;
  for (const t of disk(u.tile, radius)) {
    const ids = g.tileUnits.get(t);
    const d = dist(u.tile, t);
    if (ids) for (const id of ids) {
      const e = g.units.get(id);
      if (!e || !g.hostile(u.owner, e.owner) || !canHit(def, e) || !g.detects(u.owner, e)) continue;
      const ed = UNITS[e.type];
      let s = 10 - d * 1.2;
      const threat = (ed.atk || 0) / 10;
      s += threat;
      if (policy === 'threat') s += threat * 3;
      if (policy === 'antiArmor' && ARMORED.has(ed.cat)) s += 5;
      if (policy === 'counterBattery' && ed.cat === 'artillery') s += 7;
      if (policy === 'defensive' && d > def.range) s -= 6;
      const vs = weaponVs(wk, ed);
      if (ed.air && vs >= 1.4) s += 6;
      if (!ed.air && vs < 0.5) s -= 4;                // a fighter's guns are wasted on ground targets
      if (ed.civilian) s -= 2;
      if (ARMORED.has(ed.cat) && wpn.vsArmor < 0.6) s -= 2;
      s += 2 * (1 - e.hp / e.maxHp);
      const incoming = (g.pending.get(id) || 0) + (g.assigned.get(id) || 0);
      if (incoming >= e.hp * 1.1) s -= 9;
      if (d <= def.range && !wpn.arc && !lineOfFire(g, u.tile, t, false, !!def.air || !!ed.air).ok) s -= 6;
      if (s > bs) { bs = s; best = { kind: 'unit', id }; bt = t; }
    }
    const b = g.buildingAtTile(t);
    if (b && g.hostile(u.owner, b.owner)) {
      let s = 10 - d * 1.2 - 1.5 + (BUILDINGS[b.type].attack ? 2 : 0) + ((def.vsBuildings || 1) > 1.4 ? 3 : 0);
      if ((g.pending.get(-b.id) || 0) >= b.hp * 1.1) s -= 9;
      if (s > bs) { bs = s; best = { kind: 'building', id: b.id }; bt = t; }
    }
  }
  if (best && best.kind === 'unit') g.assigned.set(best.id, (g.assigned.get(best.id) || 0) + myShot);
  return best ? { tg: best, tile: bt } : null;
}

export function defaultPolicy(type) {
  const d = UNITS[type];
  if (d.cat === 'artillery') return 'counterBattery';
  if (UNIT_WEAPON[type] === 'cannon' || UNIT_WEAPON[type] === 'missile') return 'antiArmor';
  if ((d.aa || 0) >= 2) return 'threat';
  return 'balanced';
}

// A nearby hex from which a unit can actually shoot its target (bounded search).
export function firingPosition(g, u, tt) {
  const def = UNITS[u.type];
  let best = -1, bd = Infinity;
  for (const t of disk(u.tile, 2)) {
    if (t === u.tile || dist(t, tt) > def.range) continue;
    const ter = g.world.terr[t];
    if (isWater(ter) || !Number.isFinite(TERRAIN[ter].move)) continue;
    if (!lineOfFire(g, t, tt, false, false).ok) continue;
    const d = dist(u.tile, t) + (g.tileLoad.get(t) || 0) * 0.5;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

// Best covered hex within one step for a pinned infantry unit (never toward the enemy's side).
export function coverPosition(g, u, threatTile) {
  let best = -1, bc = coverAt(g, u) + 0.1;
  for (const t of disk(u.tile, 1)) {
    if (t === u.tile) continue;
    const ter = g.world.terr[t];
    if (isWater(ter) || !Number.isFinite(TERRAIN[ter].move)) continue;
    if (threatTile >= 0 && dist(t, threatTile) < dist(u.tile, threatTile)) continue;
    const fw = g.fieldworks?.get(t);
    const c = scarCover(g, t) + (g.ruins.has(t) ? 0.3 : 0) + (ter === T.FOREST ? 0.15 : 0) + (fw && fw.progress >= 1 ? 0.25 * fw.hp / 100 : 0);
    if (c > bc) { bc = c; best = t; }
  }
  return best;
}
