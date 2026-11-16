import { N, T } from './constants.js';
import { WEAPON_KEYS, WEAPONS, weaponVs } from './weapons.js';
import { ACTION_BUILDINGS, ACTION_UNITS, MISSILE_PROJECT, OUTPOST_TYPES } from './actionDefinitions.js';
import { addCrater, addIntensity, addSmoke, addWreck, scarCover } from './battlefield.js';
import { emit } from './combat.js';
import { centerOf, distance, dxBetween, tileAt, trenchPosition } from './actionNavigation.js';
import { chase, moveGroup, stopUnit } from './actionOrders.js';

const VID = Object.fromEntries(WEAPON_KEYS.map((key, index) => [key, index]));
const unitOf = (obj) => obj?.isUnit ? ACTION_UNITS[obj.type] : null;
const alive = (obj) => obj && obj.hp > 0;

function attackRange(game, actor, def, target) {
  const enemy = unitOf(target);
  const elevated = !enemy?.air && game.world.elev[actor.tile] - game.world.elev[target.tile] > .09;
  const marksman = def.move === 'infantry' && def.cat !== 'artillery' && game.civs[actor.owner]?.techs.has('marksmen') ? def.range * .1 : 0;
  return def.range + marksman + (actor.abilityUntil > game.time && def.ability === 'intercept' && enemy?.air ? 1.6 : 0) + (elevated ? .35 : 0);
}

function hitChance(game, shooter, profile, target, range) {
  const d = unitOf(target);
  if (!weaponVs(profile, d || { air: false })) return false;
  if (distance(shooter, target) > range) return false;
  return WEAPONS[profile].arc || unitOf(shooter)?.air || d?.air || game.nav.clearShot(shooter, target);
}

function cover(game, target, source, indirect) {
  const d = unitOf(target);
  if (!d || d.air) return 0;
  const tile = target.tile, w = game.world;
  let c = w.terr[tile] === T.FOREST ? (d.move === 'infantry' ? .22 : .09) : w.terr[tile] === T.HILLS ? .13 : 0;
  if (game.urban[tile] && d.move === 'infantry') c = Math.max(c, .18);
  if (d.move === 'infantry') {
    c = Math.max(c, scarCover(game, tile));
    const trench = trenchPosition(game, target, target.owner, .13);
    if (trench) {
      const a = trench.facing;
      const src = Math.atan2(dxBetween(target.x, source.x), source.z - target.z);
      c = Math.max(c, indirect ? .21 : Math.cos(src - a) > 0 ? .43 : .27);
    }
    if (d.ability === 'cover' && target.abilityUntil > game.time && !target.goal) c = Math.max(c, .40);
    // Friendly armor between the squad and the shooter is a moving wall: infantry tucked in behind a
    // tank or carrier (within half a hex, on the side away from the fire) take reduced fire.
    const armor = armorShield(game, target, source);
    if (armor) c = Math.max(c, indirect ? .12 : .34);
    for (const b of game.obstaclesAtTile(tile)) if (b.done && game.allied(target.owner, b.owner) &&
      ACTION_BUILDINGS[b.type].cover && distance(b, target) <= b.radius + .45) c = Math.max(c, ACTION_BUILDINGS[b.type].cover);
  }
  for (const s of game.sites) if (!s.slots && s.owner === target.owner && OUTPOST_TYPES[s.kind].cover && distance(s, target) <= s.radius + .45)
    c = Math.max(c, OUTPOST_TYPES[s.kind].cover);
  return c;
}

const ARMOR = (d) => d && !d.air && (d.move === 'tracked' || d.move === 'wheeled') && d.cat !== 'artillery' && d.hp >= 150;
function armorShield(game, unit, source) {
  const sx = dxBetween(unit.x, source.x), sz = source.z - unit.z, sl = Math.hypot(sx, sz) || 1;
  for (const v of game.movers.query(unit.x, unit.z, .55, [])) {
    if (v === unit || v.hp <= 0 || v.owner !== unit.owner || !ARMOR(ACTION_UNITS[v.type])) continue;
    const vx = dxBetween(unit.x, v.x), vz = v.z - unit.z, vl = Math.hypot(vx, vz);
    if (vl < .5 && (vx * sx + vz * sz) / (vl * sl || 1) > .55) return v;
  }
  return null;
}

export function damageActionTarget(game, target, source, amount, weapon, indirect = false) {
  if (!alive(target) || !game.hostile(source.owner, target.owner)) return;
  const d = unitOf(target), profile = WEAPONS[weapon];
  let mult = profile ? weaponVs(weapon, d || { air: false }) : 1;
  if (!mult) return;
  if (d?.move === 'tracked' || d?.move === 'wheeled') mult *= profile?.vsArmor ?? 1;
  else if (d?.move === 'infantry' && weapon === 'atgun') mult *= .58;
  if (d?.move === 'tracked' && game.civs[target.owner].techs.has('heavy_armor')) mult *= .84;
  if (d?.move === 'infantry' && game.civs[target.owner].techs.has('body_armor')) mult *= .88;
  if (d) mult *= 1 - cover(game, target, source, indirect);
  const damage = Math.max(1, Math.round(amount * mult - (d?.def || 0) * .20));
  target.hp = Math.max(0, target.hp - damage);
  target.lastCombat = game.time;
  if (d) target.hitAt = game.time;
  const tile = target.tile;
  game.recordEngagement(source, target, weapon, damage);
  if (d) {
    if (target.hp <= 0) {
      game.units.delete(target.id);
      game.civs[target.owner].casualties++;
      if (game.civs[source.owner]) game.civs[source.owner].kills++;
      const unit = game.units.get(source.id);
      if (unit) unit.kills++;
      if (!d.air || target.z >= 0) addWreck(game, tile, target.type, target.owner, { x: target.x, z: target.z, yaw: target.yaw, air: d.air });
      emit(game, { k: 'kill', a: source.tile, b: tile, s: source.id, t: target.id, ow: target.owner, ty: target.type, bx: target.x, bz: target.z });
    } else if (damage >= 6 && (game.tickN + target.id) % 3 === 0)
      emit(game, { k: 'hit', a: source.tile, b: tile, s: source.id, t: target.id, w: VID[weapon], d: damage, bx: target.x, bz: target.z });
  } else {
    if (target.hp < target.maxHp * .35) target.fire = Math.max(target.fire, 9);
    emit(game, { k: 'bhit', a: source.tile, b: tile, s: source.id, t: target.id, d: damage, bx: target.x, bz: target.z, o: target.hp <= 0 ? 'destroyed' : 'damaged' });
    if (target.hp <= 0) game.loseBuilding(target);
  }
  addIntensity(game, tile, Math.min(6, damage * .045));
}

function projectile(game, shooter, target, weapon, damage, radius = null) {
  const w = WEAPONS[weapon], index = VID[weapon];
  const flight = (w?.flight || .7) + Math.min(.65, distance(shooter, target) * .04);
  const id = game.id_();
  const point = { x: target.x, z: target.z };
  const t = tileAt(point.x, point.z);
  if (t < 0) return;
  game.projectiles.set(id, {
    id, owner: shooter.owner, shooter: shooter.id, from: shooter.tile, ax: shooter.x, az: shooter.z, to: t,
    ...point, weapon, damage, radius: radius ?? (w.blast ? w.blast * .92 : 0),
    arrive: game.time + flight, target: target.id || 0, air: !!unitOf(target)?.air || !!w?.airburst,
  });
  emit(game, { k: 'launch', a: shooter.tile, b: t, s: shooter.id, t: target.id, w: index, f: flight,
    ax: shooter.x, az: shooter.z, bx: point.x, bz: point.z, ab: w?.airburst ? 1 : undefined });
}

export function bombard(game, shooter, point, bonus = 1) {
  const def = ACTION_UNITS[shooter.type];
  const radius = shooter.type === 'bomber' ? 1.28 : shooter.type === 'oneway_drone' ? .85 : .97;
  projectile(game, shooter, point, def.weapon, def.atk * 1.75 * bonus, radius);
  shooter.lastCombat = game.time;
}

export function launchStrategic(game, b, point) {
  const id = game.id_();
  const flight = 5 + distance(b, point) * .09;
  const t = tileAt(point.x, point.z);
  game.projectiles.set(id, { id, owner: b.owner, shooter: b.id, from: b.tile, ax: b.x, az: b.z, to: t, ...point,
    strategic: true, weapon: 'warhead', damage: 480, radius: MISSILE_PROJECT.radius, arrive: game.time + flight, target: 0 });
  emit(game, { k: 'launch', a: b.tile, b: t, s: b.id, ax: b.x, az: b.z, bx: point.x, bz: point.z, f: flight, w: VID.warhead });
  for (const civ of game.civs) if (civ.visible[t] || civ.id === b.owner)
    game.notify(civ.id, 'Strategic missile inbound.', { kind: 'warning', tile: t, level: 'critical' });
}

function resolveProjectiles(game, near) {
  for (const p of game.projectiles.values()) {
    if (p.arrive > game.time + .00001) continue;
    game.projectiles.delete(p.id);
    const target = game.units.get(p.target) || game.buildings.get(p.target);
    const w = WEAPONS[p.weapon];
    // Guided and proximity-fused rounds track their target; fast aircraft get a wider tracking envelope
    // so faster planes are not immune to air defenses.
    const fast = unitOf(target)?.air ? 1.8 : 0;
    const aim = (w.guided || w.airburst) && alive(target) && distance(p, target) < (w.airburst ? 3.8 : 2) + fast ? target : p;
    const t = tileAt(aim.x, aim.z);
    if (t < 0 || t >= N) continue;
    const source = { id: p.shooter, owner: p.owner, tile: p.from, x: p.ax, z: p.az };
    if (p.strategic) {
      const intercept = game.targets.query(aim.x, aim.z, 5, near).filter((v) => alive(v) && v.done && v.type === 'aa_battery' && game.hostile(p.owner, v.owner));
      if (intercept.length && game.rng() < 1 - .62 ** intercept.length) {
        emit(game, { k: 'impact', a: p.from, b: t, bx: aim.x, bz: aim.z, w: VID.warhead, r: 2, ab: 1 });
        game.notify(p.owner, 'Strategic missile intercepted.', { kind: 'war', tile: t });
        continue;
      }
    }
    if (p.radius > 0) {
      for (const v of game.targets.query(aim.x, aim.z, p.radius + .57, near)) {
        if (unitOf(v)?.air || !alive(v)) continue;
        const range = Math.max(0, distance(aim, v) - v.radius);
        if (range > p.radius) continue;
        damageActionTarget(game, v, source, p.damage * (1 - range / p.radius * .66), p.weapon, true);
      }
    } else if (alive(target) && distance(aim, target) <= target.radius + .32)
      damageActionTarget(game, target, source, p.damage, p.weapon, !!w.arc);
    emit(game, { k: p.strategic ? 'mimpact' : 'impact', a: p.from, b: t, ax: p.ax, az: p.az, bx: aim.x, bz: aim.z,
      t: target?.id, w: VID[p.weapon], r: p.radius, ab: p.air ? 1 : undefined });
    if (p.air) continue;
    const ctr = centerOf(t);
    if (p.radius > 0 || ['cannon', 'atgun', 'fortgun', 'rockets'].includes(p.weapon))
      addCrater(game, t, p.strategic ? 2.6 : p.radius > 0 ? .63 : .26, p.strategic ? 'strategic' : p.weapon === 'mortar' ? 'mortar' : p.weapon === 'bombs' ? 'bomb' : p.weapon === 'missile' ? 'missile' : 'shell',
        { x: dxBetween(ctr.x, aim.x), z: aim.z - ctr.z });
    if (p.radius > 0) addSmoke(game, t, p.strategic ? .89 : .36, p.strategic ? 50 : 13);
    if (p.strategic || p.radius >= 1.0) {
      game.roads.damageTile(t, p.strategic ? 110 : 16, game.rng, .7);
      game.nav.invalidate();
    }
    const trench = game.fieldworks.get(t);
    if (trench && p.radius > .6) {
      trench.hp = Math.max(0, trench.hp - (p.strategic ? 100 : 13));
      if (!trench.hp) game.fieldworks.delete(t);
      game.fwVer++;
    }
  }
}

function fire(game, actor, def, target) {
  const w = WEAPONS[def.weapon];
  let damage = (def.atk ?? def.attack) * 1.65;
  if (!unitOf(target)) damage *= def.antiBuilding || .85;
  if (actor.abilityUntil > game.time && (def.ability === 'focused_fire' || def.ability === 'intercept' && unitOf(target)?.air)) damage *= 1.40;
  if (def.move === 'infantry' && game.civs[actor.owner].techs.has('infantry_training')) damage *= 1.15;
  // barracks kit: grenades at close quarters, a disposable rocket against vehicles and works
  const kit = def.move === 'infantry' && def.cat !== 'artillery' ? game.civs[actor.owner].techs : null;
  if (kit?.has('grenades') && distance(actor, target) < 1.2 && !unitOf(target)?.air) damage *= 1.2;
  if (kit?.has('rocket_teams') && (actor.type === 'rifle_squad' || actor.type === 'special_forces' || actor.type === 'militia') &&
    (!unitOf(target) || ['tracked', 'wheeled'].includes(unitOf(target).move))) damage *= 1.45;
  if (actor.kills) damage *= 1 + Math.min(3, Math.floor(actor.kills / 4)) * .04;
  actor.readyAt = game.time + w.cooldown;
  actor.lastCombat = game.time;
  if (def.ability === 'infiltrate') actor.abilityUntil = 0;
  if (w.mode === 'projectile') projectile(game, actor, target, def.weapon, damage);
  else {
    emit(game, { k: 'fire', a: actor.tile, b: target.tile, ax: actor.x, az: actor.z, bx: target.x, bz: target.z,
      s: actor.id, t: target.id, w: VID[def.weapon] });
    damageActionTarget(game, target, actor, damage, def.weapon);
  }
}

// Troops under fire look for better cover nearby: trenches, forest, ruins, sandbags, or friendly armor
// to crouch behind. Only units actually taking fire move, they only move for a clear gain, and each
// squad re-evaluates at most every ~10-14 s, so engaged lines settle instead of shuffling.
function seekCover(game, u, target) {
  const def = ACTION_UNITS[u.type];
  if (u.braced || u.formation || u.tacticalResume || u.coverReady > game.time || def.air || def.defensiveOnly ||
    def.cat === 'artillery' || u.goal && u.mode !== 'assault' || distance(u, target) > def.range ||
    game.time - (u.hitAt ?? -99) > 4) return;
  u.coverReady = game.time + 10 + u.id % 5;
  const infantry = def.move === 'infantry', anchor = u.coverAnchor || { x: u.x, z: u.z };
  const score = (p) => {
    const range = distance(p, target);
    if (range > def.range || range < (infantry ? .38 : .7) || !game.nav.clearShot(p, target)) return -100;
    const density = game.movers.query(p.x, p.z, .42, []).filter((v) => v.id !== u.id && game.allied(v.owner, u.owner)).length;
    return cover(game, { ...u, ...p, tile: tileAt(p.x, p.z) }, target, false) * 2 - density * .20
      - Math.abs(range - def.range * .76) * .12 - distance(u, p) * .06;
  };
  let best = null, quality = score(u) + .16;
  const candidates = [];
  const trench = infantry && trenchPosition(game, u, u.owner, 1.05);
  if (trench) candidates.push(trench);
  for (let k = 0; k < 10; k++) {
    const a = k * Math.PI / 5, r = infantry ? .65 : .85;
    candidates.push({ x: anchor.x + Math.sin(a) * r, z: anchor.z + Math.cos(a) * r });
  }
  // Infantry near a friendly tank tuck in on its far side from the shooter.
  if (infantry) for (const v of game.movers.query(u.x, u.z, 1.3, [])) {
    if (v.owner !== u.owner || v.hp <= 0 || !ARMOR(ACTION_UNITS[v.type])) continue;
    const dx = dxBetween(target.x, v.x), dz = v.z - target.z, l = Math.hypot(dx, dz) || 1, gap = v.radius + def.radius + .06;
    candidates.push({ x: v.x + dx / l * gap, z: v.z + dz / l * gap });
  }
  for (const p of candidates) {
    if (distance(anchor, p) > 1.4 || !game.nav.canStand(p.x, p.z, def)) continue;
    const value = score(p);
    if (value > quality) { quality = value; best = p; }
  }
  if (!best) return;
  const path = game.nav.route(u, best, def);
  if (!path) return;
  // A short local maneuver retains the player's destination, attack target and queue.
  // It cannot permanently replace an operation with an unrelated cover order.
  u.tacticalResume = { goal: u.goal }; u.tacticalUntil = game.time + 9;
  u.goal = best; u.path = path; u.blocked = 0; u.coverAnchor = anchor;
}

function acquire(game, actor, def, near) {
  const civ = game.civs[actor.owner];
  const range = def.range + (def.ability === 'intercept' && actor.abilityUntil > game.time ? 1.7 : .45);
  let best = null, score = Infinity;
  for (const v of game.targets.query(actor.x, actor.z, range, near)) {
    if (!alive(v) || !game.hostile(actor.owner, v.owner) || !game.sees(civ, v)) continue;
    const r = attackRange(game, actor, def, v);
    if (!hitChance(game, actor, def.weapon, v, r)) continue;
    const targetDef = unitOf(v), armored = targetDef?.move === 'tracked' || targetDef?.move === 'wheeled';
    const profile = WEAPONS[def.weapon];
    const counter = targetDef?.air ? weaponVs(def.weapon, targetDef) * .20 : armored && profile.vsArmor >= 1.1 ? .48 : 0;
    const d = distance(actor, v) + (targetDef ? 0 : .31) - counter - (v.id === actor.target ? .26 : 0) - (v.hp < 20 ? .18 : 0);
    if (d < score) { score = d; best = v; }
  }
  return best;
}

function aircraftMission(game, u) {
  const order = u.airOrder;
  if (u.goal) return false;
  const d = ACTION_UNITS[u.type];
  if (u.grounded) {
    const base = game.buildings.get(u.airBase);
    if (!base?.done) { u.grounded = false; u.airOrder = null; }
    else if (u.altitude < .16) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * .015);
    return true;
  }
  if (!order) {
    if (d.alt === 'high' && !u.orders.length) u.airOrder = { kind: 'patrol', point: { x: u.x, z: u.z }, phase: 0 };
    return false;
  }
  if (order.kind === 'strike') {
    bombard(game, u, order.point);
    u.airOrder = null;
    if (u.type === 'oneway_drone') { game.units.delete(u.id); return true; }
    game.returnAircraft(u);
  } else if (order.kind === 'return') {
    const base = game.buildings.get(order.base);
    if (!base?.done) { u.airOrder = null; game.returnAircraft(u); }
    else { u.grounded = true; u.airBase = base.id; u.airOrder = null; u.target = 0; }
  } else if (order.kind === 'patrol' || order.kind === 'intercept' || order.kind === 'scout' || order.kind === 'support') {
    order.phase = ((order.phase || 0) + 1) % 6;
    const a = order.phase * Math.PI / 3;
    const r = order.kind === 'scout' ? 2.7 : order.kind === 'intercept' ? 1.8 : 1.38;
    const p = game.nav.nearest({ x: order.point.x + Math.sin(a) * r, z: order.point.z + Math.cos(a) * r }, d);
    if (p) { u.goal = p; u.path = [p]; }
  }
  return false;
}

// Idle infantry beside a friendly trench man it: each squad takes a free firing position along the line
// (spreading out rather than piling onto one spot), so a dug line is held by troops standing in it.
// A squad does this once per halt (`u.manned`, cleared by any new order): squads already in the
// trench, or already placed, never reshuffle along the line.
function manTrenches(game) {
  if (!game.fieldworks?.size || game.tickN % 20 !== 0) return;
  for (const u of game.units.values()) {
    const def = ACTION_UNITS[u.type];
    if (u.manned || def.move !== 'infantry' || def.air || u.goal || u.attack || u.mode === 'move' || u.hp <= 0) continue;
    const spot = trenchPosition(game, u, u.owner, .8);
    if (!spot) continue;
    u.manned = true;
    if (trenchPosition(game, u, u.owner, .13)) continue;
    const sn = Math.sin(spot.facing), cs = Math.cos(spot.facing);
    let pick = null;
    for (const shift of [0, .16, -.16, .32, -.32, .48, -.48]) {
      const p = { x: spot.x - cs * shift, z: spot.z + sn * shift };
      const taken = game.movers.query(p.x, p.z, .1, []).some((v) => v.id !== u.id && v.owner === u.owner && ACTION_UNITS[v.type].move === 'infantry');
      if (!taken && game.nav.canStand(p.x, p.z, def)) { pick = p; break; }
    }
    if (!pick || distance(u, pick) < .07) continue;
    const path = game.nav.route(u, pick, def);
    if (!path) continue;
    u.goal = pick; u.path = path; u.blocked = 0; u.mode = u.mode || 'guard';
  }
}

export function actionCombat(game) {
  manTrenches(game);
  const near = [];
  game.targets.clear();
  for (const u of game.units.values()) game.targets.add(u);
  for (const b of game.buildings.values()) game.targets.add(b);
  resolveProjectiles(game, near);
  for (const u of game.units.values()) {
    const def = ACTION_UNITS[u.type];
    if (def.air && aircraftMission(game, u)) continue;
    if (def.setup && (u.vx || u.vz) && (u.deployed || u.setupUntil)) { u.deployed = false; u.setupUntil = 0; }
    if (!def.weapon || u.mode === 'move' || u.grounded || !alive(u)) continue;
    const civ = game.civs[u.owner];
    const explicit = u.attack ? game.units.get(u.attack) || game.buildings.get(u.attack) : null;
    const seen = alive(explicit) && game.sees(civ, explicit);
    if (seen && !def.defensiveOnly && (game.tickN + u.id) % 9 === 0) {
      const r = attackRange(game, u, def, explicit);
      if (!hitChance(game, u, def.weapon, explicit, r)) {
        if (!u.goal || !u.chase || distance(u.chase, explicit) > 1.6) { chase(game, u, explicit, r); u.chase = { x: explicit.x, z: explicit.z }; }
      } else if (u.goal && !def.air && !u.tacticalResume) stopUnit(game, u);
    } else if (u.attack && (!explicit || explicit.hp <= 0)) { u.attack = null; stopUnit(game, u, true); }
    if (u.readyAt > game.time || (game.tickN + u.id) % 3 !== 0) continue;
    let target = seen && hitChance(game, u, def.weapon, explicit, attackRange(game, u, def, explicit)) ? explicit : null;
    if (!target) target = acquire(game, u, def, near);
    u.target = target?.id || 0;
    if (target) {
      if (!u.goal && !def.air) u.yaw = Math.atan2(dxBetween(u.x, target.x), target.z - u.z);
      // Mortars and towed guns halt (unitMotion holds them while a target is in range), set up, then fire.
      if (def.setup && !u.deployed) {
        if (!u.setupUntil) u.setupUntil = game.time + def.setup;
        if (game.time < u.setupUntil || u.vx || u.vz) continue;
        u.deployed = true; u.setupUntil = 0;
      }
      fire(game, u, def, target);
      if ((game.tickN + u.id) % 9 === 0) seekCover(game, u, target);
    }
  }
  for (const b of game.buildings.values()) {
    const def = ACTION_BUILDINGS[b.type];
    if (!b.done || !def.attack || b.readyAt > game.time || (game.tickN + b.id) % 6 !== 0) continue;
    const target = acquire(game, b, def, near);
    if (target) fire(game, b, def, target);
  }
}

export function canEngage(unit, target) {
  const def = ACTION_UNITS[unit.type];
  if (def.defensiveOnly && (!target.isUnit || distance(unit, target) > def.range + .4)) return false;
  return !!def.weapon && !!weaponVs(def.weapon, unitOf(target) || { air: false });
}

