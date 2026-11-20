import { N, T } from './constants.js';
import { WEAPON_KEYS, WEAPONS, weaponVs as baseVs } from './weapons.js';
import { ACTION_BUILDINGS, ACTION_UNITS, MISSILE_PROJECT, nukeFalloff, OUTPOST_TYPES } from './actionDefinitions.js';
import { disk } from './hex.js';
import { addCrater, addIntensity, addSmoke, addWreck, scarCover } from './battlefield.js';
import { blastForest, blastTrees } from './shockwave.js';
import { emit } from './combat.js';
import { centerOf, distance, dxBetween, tileAt, trenchPosition, wrapX } from './actionNavigation.js';
import { budgetRoute, chase, DEFERRED, moveGroup, stanceOf, stopUnit } from './actionOrders.js';
import { airStep, CITY_AA, cityHasAA, flakBurst } from './actionAir.js';
import { attackRuns } from './actionFlight.js';
import { SMALL_ARMS, squadFirepower, squadHit, structureDamage, structureRange, suppress } from './actionUpgrades.js';
import { firingSlot, garrisonRange, shelterBlast, sightFrom } from './actionGarrison.js';
import { GARRISON } from './actionDefinitions.js';
// 2026-11-20 per-building upgrades (BASE_MENU_REWORK.md): the mechanics' combat hooks
import { afterFire, afterHit, blastRadius, fireMul, incoming, rofMul, salvoExtra, structureDef, suppressMul } from './actionUnitUpgrades.js';

const VID = Object.fromEntries(WEAPON_KEYS.map((key, index) => [key, index]));
const unitOf = (obj) => obj?.isUnit ? ACTION_UNITS[obj.type] : null;
const alive = (obj) => obj && obj.hp > 0;
// W2 (2026-11-16): in the action ruleset small arms and machine guns also engage low-flying aircraft (helicopters,
// drones) at a heavy penalty, so helicopters are no longer immune to everything but dedicated AA. The shared
// WEAPONS table (legacy ruleset) is unchanged.
export const SMALL_ARMS_VS_LOWAIR = { carbine: .1, rifle: .12, smg_team: .15, mg: .3, mg_light: .2, pistol: 0 };
const weaponVs = (wk, d) => baseVs(wk, d) || (d?.air && d.alt !== 'high' ? SMALL_ARMS_VS_LOWAIR[wk] || 0 : 0);

function attackRange(game, actor, def, target) {
  const enemy = unitOf(target);
  const elevated = !enemy?.air && game.world.elev[actor.tile] - game.world.elev[target.tile] > .09;
  // era-upgraded defenses reach further (B: building levels); marksmen fire their own shots (actionUpgrades)
  return def.range + structureRange(actor) + garrisonRange(actor) + (actor.abilityUntil > game.time && def.ability === 'intercept' && enemy?.air ? 1.6 : 0) + (elevated ? .35 : 0);
}

function hitChance(game, shooter, profile, target, range) {
  const d = unitOf(target);
  if (!weaponVs(profile, d || { air: false })) return false;
  const len = distance(shooter, target);
  if (len > range) return false;
  // 2026-11-19 minimum range (def.minRange, the missile battery): nothing inside the dead zone is engaged
  if (len < (unitOf(shooter)?.minRange || 0)) return false;
  return WEAPONS[profile].arc || unitOf(shooter)?.air || d?.air || game.nav.clearShot(sightFrom(game, shooter), target, towerOf(shooter));
}
// 2026-11-20: a raised gun tower (def.tower: its eye height) sees over low rises and over its own side's structures
const towerOf = (s) => { const rise = !s.isUnit && ACTION_BUILDINGS[s.type]?.tower; return rise ? { rise, owner: s.owner } : null; };

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

// Structure armour (2026-11-17). Fortified defenses (`def.armor === 'fortified'`: bunkers, outposts, gun and AA
// emplacements, towers, sandbags, headquarters) shrug off most small-arms fire and light explosives; demolition
// is the job of tanks, field guns, artillery, missiles and aircraft. `kit` is the barracks kit (grenade, rocket).
// Other structures (ring facilities, support posts) take full damage. Applied after the shooter's antiBuilding.
export const FORTIFIED_VS = { smallArms: .35, autocannon: .6, flak: .5, mortar: .65, grenade: .4, rocket: .55 };
export function structureArmour(target, weapon, kit) {
  if (ACTION_BUILDINGS[target.type]?.armor !== 'fortified') return 1;
  if (kit) return FORTIFIED_VS[kit] ?? 1;
  if (SMALL_ARMS.has(weapon)) return FORTIFIED_VS.smallArms;
  return FORTIFIED_VS[weapon] ?? 1;
}

export function damageActionTarget(game, target, source, amount, weapon, indirect = false, blast = 0) {
  if (!alive(target) || !game.hostile(source.owner, target.owner)) return;
  const d = unitOf(target), profile = WEAPONS[weapon];
  // W4: a blast on a garrisoned structure reaches its occupants, reduced by GARRISON.protection (actionGarrison.js)
  if (!d && blast > 0 && target.garrison?.length) shelterBlast(game, target, source, amount, weapon, blast, damageActionTarget);
  // suppression (W3): every round that reaches a squad pins it a little, whether or not it hurts
  if (d?.move === 'infantry' && d.men > 1 && profile?.supp) suppress(target, game.time, profile.supp * (blast > 0 ? 1.5 : 1) * suppressMul(game, target, source));
  let mult = profile ? weaponVs(weapon, d || { air: false }) : 1;
  if (mult && target.mods) mult *= incoming(game, target, source, weapon);   // body armour, reactive armour, flares
  if (!mult) return;
  // the low, slow Warthog (def.aaVulnerable) takes extra damage from anti-aircraft weapons
  if (d?.aaVulnerable && profile && (profile.targets.includes('air') || profile.targets.includes('lowair'))) mult *= d.aaVulnerable;
  if (d?.move === 'tracked' || d?.move === 'wheeled') mult *= profile?.vsArmor ?? 1;
  // 2026-11-17: tracked armour shrugs off small arms (rifles, carbines, machine guns) at half their vehicle rate
  if (d?.move === 'tracked' && SMALL_ARMS.has(weapon)) mult *= .5;
  else if (d?.move === 'infantry' && weapon === 'atgun') mult *= .58;
  if (!d) mult *= structureArmour(target, weapon, source.kit);
  if (d) mult *= 1 - cover(game, target, source, indirect);
  let damage = Math.max(1, Math.round(amount * mult - (d?.def || 0) * .20));
  // squads lose men one at a time, a hit killing at most its weapon's cap (actionUpgrades.squadHit, W3)
  if (d?.move === 'infantry' && d.men > 1 && damage > 0) {
    const shooter = game.units.get(source.id);
    damage = squadHit(game, target, d, weapon, damage, blast, !!(shooter && ACTION_UNITS[shooter.type]?.vsInfantry));
  }
  if (damage <= 0) { target.lastCombat = game.time; return; }
  target.hp = Math.max(0, target.hp - damage);
  target.lastCombat = game.time;
  target.hitAt = game.time; // W2: structures too (repairs slow down under fire)
  if (target.mods) afterHit(game, target);   // smoke launchers
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
  if (MISSILE_DEFENSE.tactical.has(weapon)) armIntercept(game, game.projectiles.get(id), game.time);
}

// ---- Missile defense (§44, W3 2026-11-17) ----
// AA batteries and mobile air defense shoot down strategic missiles and tactical guided missiles (missile
// battery rounds). The outcome is decided ONCE per projectile, at launch: one spatial query around the aim
// point finds hostile interceptors in range, each ready one (lowest id first, at most maxShots) spends its
// cooldown on the missile and kills it with its chance, drawn from game.rng (deterministic, saved). A killed
// missile is resolved early, at `at` of its flight, with the event
//   {k:'mintercept', a: launch tile, b: intercept tile, s: interceptor id, t: missile id, ax, az: interceptor
//    position, bx, bz: intercept point, w: weapon index, st: 1 strategic / 0 tactical}
// Counterplay: saturation (every interceptor fires once per cooldown, so salvos get through) and range.
export const MISSILE_DEFENSE = {
  interceptors: { aa_battery: { range: 5.5, strategic: .38, tactical: .3 }, air_defense: { range: 5, strategic: .3, tactical: .4 } },
  cooldown: { strategic: 8, tactical: 3.5 }, maxShots: 4, at: .82, tactical: new Set(['missile']),
};
const INTERCEPT_REACH = Math.max(...Object.values(MISSILE_DEFENSE.interceptors).map((s) => s.range));

/** Decide whether projectile `p` is shot down (call once, when it is created). Returns the interceptor or null. */
export function interceptMissile(game, p) {
  const kind = p.strategic ? 'strategic' : 'tactical';
  const shooters = [];
  for (const v of game.targets.query(p.x, p.z, INTERCEPT_REACH + .5, [])) {
    const spec = MISSILE_DEFENSE.interceptors[v.type];
    if (!spec || !alive(v) || !game.hostile(p.owner, v.owner) || (v.mintReady || 0) > game.time) continue;
    if (v.isUnit ? !!v.grounded : !v.done) continue;
    if (distance(v, p) <= spec.range) shooters.push(v);
  }
  shooters.sort((a, b) => a.id - b.id);
  for (const v of shooters.slice(0, MISSILE_DEFENSE.maxShots)) {
    v.mintReady = game.time + MISSILE_DEFENSE.cooldown[kind];
    if (game.rng() < MISSILE_DEFENSE.interceptors[v.type][kind]) return v;
  }
  return null;
}

function armIntercept(game, p, launched) {
  const v = interceptMissile(game, p);
  p.mint = 0;
  if (!v) return;
  const k = MISSILE_DEFENSE.at, ix = wrapX(p.ax + dxBetween(p.ax, p.x) * k), iz = p.az + (p.z - p.az) * k;
  p.mint = { by: v.id, x: ix, z: iz, vx: v.x, vz: v.z };
  p.arrive = launched + (p.arrive - launched) * k;
}

function resolveIntercept(game, p) {
  const m = p.mint, t = tileAt(m.x, m.z);
  emit(game, { k: 'mintercept', a: p.from, b: t, s: m.by, t: p.id, ax: m.vx, az: m.vz, bx: m.x, bz: m.z, w: VID[p.weapon], st: p.strategic ? 1 : 0 });
  if (p.strategic) {
    game.notify(p.owner, 'Strategic missile intercepted.', { kind: 'war', tile: p.to });
    const by = game.units.get(m.by) || game.buildings.get(m.by);
    if (by && game.civs[by.owner]) game.notify(by.owner, 'Air defenses shot down a strategic missile.', { kind: 'war', tile: t >= 0 ? t : p.to });
  }
}

export function bombard(game, shooter, point, bonus = 1) {
  const def = ACTION_UNITS[shooter.type];
  const radius = shooter.type === 'bomber' ? 1.28 : shooter.type === 'oneway_drone' ? .85 : .97;
  projectile(game, shooter, point, def.weapon, def.atk * 1.75 * bonus, blastRadius(shooter, def.weapon, radius));
  for (let k = salvoExtra(shooter); k > 0; k--) projectile(game, shooter, { x: point.x + (k % 2 ? .3 : -.3), z: point.z + (k > 1 ? .3 : -.2) }, def.weapon, def.atk * 1.75 * bonus, blastRadius(shooter, def.weapon, radius));
  shooter.lastCombat = game.time;
}

export function launchStrategic(game, b, point) {
  const id = game.id_();
  const flight = 5 + distance(b, point) * .09;
  const t = tileAt(point.x, point.z);
  game.projectiles.set(id, { id, owner: b.owner, shooter: b.id, from: b.tile, ax: b.x, az: b.z, to: t, ...point,
    strategic: true, weapon: 'warhead', damage: MISSILE_PROJECT.damage, radius: MISSILE_PROJECT.radius, arrive: game.time + flight, target: 0 });
  emit(game, { k: 'launch', a: b.tile, b: t, s: b.id, ax: b.x, az: b.z, bx: point.x, bz: point.z, f: flight, w: VID.warhead });
  for (const civ of game.civs) if (civ.visible[t] || civ.id === b.owner)
    game.notify(civ.id, 'Strategic missile inbound.', { kind: 'warning', tile: t, level: 'critical' });
  armIntercept(game, game.projectiles.get(id), game.time);
}

// ---- Strategic blast (2026-11-19, docs/gameplay-overhaul/NUKES.md) ----
// Every hostile ground unit and structure within MISSILE_PROJECT.radius of ground zero (distance to its edge, as for
// any blast) takes nukeFalloff(d) of the full blast: units MISSILE_PROJECT.damage (then armour, cover, squads man by
// man with no kill cap), structures a share of their own max HP (structure / hq, so tiers and upgrades never make a
// city nuke-proof). Structures are hit before units and headquarters last, so a city whose headquarters falls
// leaves ruins of the facilities the blast already levelled. Aircraft in flight are spared (as before). The order is
// the spatial query's (deterministic); no rng.
const isHeadquarters = (b) => b.type === 'town' || !!ACTION_BUILDINGS[b.type]?.newBase;
function strategicBlast(game, aim, source, near) {
  const M = MISSILE_PROJECT;
  const hit = [];
  for (const v of game.targets.query(aim.x, aim.z, M.radius + .6, near)) {
    if (unitOf(v)?.air || !alive(v)) continue;
    const f = nukeFalloff(Math.max(0, distance(aim, v) - (v.radius || 0)));
    if (f > 0) hit.push({ v, f, order: v.isUnit ? 2 : isHeadquarters(v) ? 1 : 0 });
  }
  hit.sort((a, b) => a.order - b.order || a.v.id - b.v.id);
  const struck = new Set();
  for (const { v, f } of hit) {
    if (!alive(v) || (v.isUnit ? !game.units.has(v.id) : !game.buildings.has(v.id))) continue;   // gone with its headquarters
    if (v.isUnit) { damageActionTarget(game, v, source, M.damage * f, 'warhead', true, M.radius); continue; }
    const share = isHeadquarters(v) ? M.hq : M.structure;
    damageActionTarget(game, v, source, (v.maxHp || v.hp) * share * f, 'warhead', true, M.radius);
    const site = game.siteById?.get(v.site);
    if (site && isHeadquarters(v) && game.civs[v.owner] && !struck.has(site.id)) {
      struck.add(site.id);
      game.notify(v.owner, `${site.name} was struck by a strategic missile.`, { kind: 'loss', tile: site.tile, level: 'critical' });
    }
  }
}

// Ground effects of a strategic burst beyond the crater, smoke and forest: roads are torn up across the core (the
// centre hex hardest) and trenches lose falloff x 100 HP across the whole blast (was the centre hex only).
function strategicGround(game, t, aim) {
  const M = MISSILE_PROJECT;
  for (const x of disk(t, Math.ceil(M.radius / 1.5))) {
    const c = centerOf(x), d = Math.hypot(dxBetween(aim.x, c.x), c.z - aim.z);
    if (d <= M.core) game.roads.damageTile(x, x === t ? 110 : 80, game.rng, .7);
    const trench = game.fieldworks.get(x), f = nukeFalloff(d);
    if (trench && f > 0) {
      trench.hp = Math.max(0, trench.hp - 100 * f);
      if (!trench.hp) game.fieldworks.delete(x);
      game.fwVer++;
    }
  }
  game.nav.invalidate();
}

function resolveProjectiles(game, near) {
  for (const p of game.projectiles.values()) {
    if (p.arrive > game.time + .00001) continue;
    game.projectiles.delete(p.id);
    // §44: a missile shot down at launch-time decision ends here, short of its target
    if (p.mint) { resolveIntercept(game, p); continue; }
    const target = game.units.get(p.target) || game.buildings.get(p.target);
    const w = WEAPONS[p.weapon];
    // Guided and proximity-fused rounds track their target; fast aircraft get a wider tracking envelope
    // so faster planes are not immune to air defenses.
    const fast = unitOf(target)?.air ? 1.8 : 0;
    const aim = (w.guided || w.airburst) && alive(target) && distance(p, target) < (w.airburst ? 3.8 : 2) + fast ? target : p;
    const t = tileAt(aim.x, aim.z);
    if (t < 0 || t >= N) continue;
    const source = { id: p.shooter, owner: p.owner, tile: p.from, x: p.ax, z: p.az, kit: p.kit };
    // a strategic missile from a save made before §44 (no launch-time decision): decide now, at impact
    if (p.strategic && p.mint === undefined) {
      const v = interceptMissile(game, p);
      if (v) { p.mint = { by: v.id, x: aim.x, z: aim.z, vx: v.x, vz: v.z }; resolveIntercept(game, p); continue; }
    }
    if (p.strategic) strategicBlast(game, aim, source, near);
    else if (p.radius > 0) {
      for (const v of game.targets.query(aim.x, aim.z, p.radius + .57, near)) {
        if (unitOf(v)?.air || !alive(v)) continue;
        const range = Math.max(0, distance(aim, v) - v.radius);
        if (range > p.radius) continue;
        damageActionTarget(game, v, source, p.damage * (1 - range / p.radius * .66), p.weapon, true, p.radius);
      }
    } else if (alive(target) && distance(aim, target) <= target.radius + .32)
      damageActionTarget(game, target, source, p.damage, p.weapon, !!w.arc);
    emit(game, { k: p.strategic ? 'mimpact' : 'impact', a: p.from, b: t, ax: p.ax, az: p.az, bx: aim.x, bz: aim.z,
      t: target?.id, w: VID[p.weapon], r: p.strategic ? MISSILE_PROJECT.radius : p.radius, ab: p.air ? 1 : undefined });
    if (w.airburst) flakBurst(game, source, target, aim, p.weapon, aim === target);
    if (p.air || p.small) continue;
    const ctr = centerOf(t);
    if (p.radius > 0 || ['cannon', 'atgun', 'fortgun', 'rockets'].includes(p.weapon))
      addCrater(game, t, p.strategic ? 2.6 : p.radius > .6 ? .63 : p.radius > 0 ? .4 : .26, p.strategic ? 'strategic' : p.weapon === 'mortar' ? 'mortar' : p.weapon === 'bombs' ? 'bomb' : p.weapon === 'missile' ? 'missile' : 'shell',
        { x: dxBetween(ctr.x, aim.x), z: aim.z - ctr.z });
    if (p.radius > 0) addSmoke(game, t, p.strategic ? .89 : .36, p.strategic ? 50 : 13);
    // effects pass (2026-11-18): a warhead flattens the forest in its core and fells more along its height-aware
    // shock front (shockwave.js); a heavy conventional blast may fell the forest on the hex it hits
    if (p.strategic) blastForest(game, aim.x, aim.z);
    else if (p.radius > 0) blastTrees(game, t, p.radius, aim.x, aim.z);
    if (p.strategic) { strategicGround(game, t, aim); continue; }
    if (p.radius >= 1.0) {
      game.roads.damageTile(t, 16, game.rng, .7);
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
  // 2026-11-17: tanks fire high-explosive at infantry (def.vsInfantry: tank 1.25, autonomous tank 1.2)
  else if (def.vsInfantry && unitOf(target).move === 'infantry') damage *= def.vsInfantry;
  if (actor.abilityUntil > game.time && (def.ability === 'focused_fire' || def.ability === 'intercept' && unitOf(target)?.air)) damage *= 1.40;
  // squads fire with the men still standing; era-upgraded defenses hit harder (B)
  damage *= (actor.isUnit ? squadFirepower(actor, game, def, target) : structureDamage(actor));
  if (actor.kills) damage *= 1 + Math.min(3, Math.floor(actor.kills / 4)) * .04;
  if (actor.inside) damage *= GARRISON.fireBonus;   // W4: firing from a garrisoned structure (steadier aim)
  damage *= fireMul(game, actor, target);   // upgrades: an ambush from camouflage, the heavy centre gun, sabot
  actor.readyAt = game.time + (def.fireCooldown ?? w.cooldown) * rofMul(actor);   // per-unit override (mortar team, 2026-11-17)
  // Sustained bursts (2026-11-18, the bunker: def.burst): `shots` rounds `gap` s apart on one target, each `share` of a
  // volley, then `rest` s. The building loop polls a structure mid-burst every 3 ticks (BURST_GATE) instead of 6.
  // Event flag bu: the round's place in the burst (1..shots), so the client can draw one continuous stream.
  let round;
  if (def.burst && !actor.isUnit) {
    const left = (actor.burstLeft > 0 ? actor.burstLeft : def.burst.shots) - 1;
    round = def.burst.shots - left;
    actor.burstLeft = left; actor.burstTarget = left > 0 ? target.id : 0;
    actor.readyAt = game.time + (left > 0 ? def.burst.gap : def.burst.rest) - .01;
    damage *= def.burst.share;
  }
  actor.lastCombat = game.time;
  if (def.ability === 'infiltrate') actor.abilityUntil = 0;
  // 2026-11-20 tank pass: def.blast turns a unit's direct-fire round into an area blast of that radius (both tanks)
  if (w.mode === 'projectile') {
    const radius = blastRadius(actor, def.weapon, actor.isUnit ? def.blast ?? null : null);
    projectile(game, actor, target, def.weapon, damage, radius);
    for (let k = salvoExtra(actor); k > 0; k--) projectile(game, actor, target, def.weapon, damage, radius);   // extra salvo / munitions
  }
  else {
    emit(game, { k: 'fire', a: actor.tile, b: target.tile, ax: actor.x, az: actor.z, bx: target.x, bz: target.z,
      s: actor.id, t: target.id, w: VID[def.weapon], bu: round });
    damageActionTarget(game, target, actor, damage, def.weapon);
    if (def.weapon === 'flak' && unitOf(target)?.air) flakBurst(game, actor, target, target, 'flak', true);
  }
  if (def.atgm && actor.isUnit) fireAtgm(game, actor, def, target);
  if (actor.mods || !actor.isUnit) afterFire(game, actor, def, target);   // grenades, squad rockets, turret secondaries
}

// ---- Coaxial machine gun (2026-11-20 tank pass: def.coax = { atk, range, cooldown }, weapon 'coax') ----
// A secondary that fires on its own cooldown, independently of the main gun: one burst at the hostile infantry squad
// within coax.range it can see and has a line of fire to, the main gun's target when that is such a squad, otherwise
// the nearest (one spatial query, only while the gun is ready). Hold fire silences it unless the unit is attacking
// infantry by order. Event: an ordinary 'fire' (hitscan) with w = the coax weapon index.
const COAX = VID.coax;
function coaxStep(game, u, def) {
  const spec = def.coax;
  if ((u.coaxReady || 0) > game.time || (game.tickN + u.id) % 3 !== 1) return;
  const civ = game.civs[u.owner];
  const usable = (v) => alive(v) && !v.inside && unitOf(v)?.move === 'infantry' && game.hostile(u.owner, v.owner) &&
    distance(u, v) <= spec.range && game.sees(civ, v) && game.nav.clearShot(u, v);
  const main = game.units.get(u.target);
  let pick = main && usable(main) ? main : null;
  if (!pick && stanceOf(u) === 'holdFire' && !(u.goal && u.mode === 'assault')) return;
  if (!pick) {
    let best = Infinity;
    for (const v of game.targets.query(u.x, u.z, spec.range + .2, [])) {
      if (!v.isUnit || !usable(v)) continue;
      const d = distance(u, v);
      if (d < best) { best = d; pick = v; }
    }
  }
  if (!pick) return;
  u.coaxReady = game.time + spec.cooldown;
  u.lastCombat = game.time;
  emit(game, { k: 'fire', a: u.tile, b: pick.tile, ax: u.x, az: u.z, bx: pick.x, bz: pick.z, s: u.id, t: pick.id, w: COAX });
  damageActionTarget(game, pick, u, spec.atk * 1.65, 'coax');
}

// ---- IFV anti-tank missile (2026-11-18, exo_infantry as an Infantry Fighting Vehicle: def.atgm) ----
// After its autocannon fires, a ready IFV launches a wire-guided missile at an armoured vehicle (tracked / wheeled,
// not aircraft) or a fortified structure within atgm.range it can see and has a line of fire to: its current target
// when that qualifies, otherwise the nearest such target (one spatial query, only while the missile is ready).
// A guided 'missile' projectile (vsArmor 1.3) that is never intercepted (not a battery round); launch flag tw:1.
const atgmTarget = (v) => { const d = unitOf(v); return d ? !d.air && (d.move === 'tracked' || d.move === 'wheeled') : ACTION_BUILDINGS[v.type]?.armor === 'fortified'; };
export function fireAtgm(game, actor, def, target) {
  if ((actor.atgmReady || 0) > game.time) return;
  const spec = def.atgm, civ = game.civs[actor.owner];
  const usable = (v) => alive(v) && game.hostile(actor.owner, v.owner) && atgmTarget(v) && distance(actor, v) <= spec.range && game.sees(civ, v) && game.nav.clearShot(actor, v);
  let pick = usable(target) ? target : null;
  if (!pick) {
    let score = Infinity;
    for (const v of game.targets.query(actor.x, actor.z, spec.range, [])) {
      if (!usable(v)) continue;
      const s = distance(actor, v) + (v.isUnit ? 0 : 1.5);   // armour first, then bunkers
      if (s < score) { score = s; pick = v; }
    }
  }
  if (!pick) return;
  actor.atgmReady = game.time + spec.cooldown;
  const t = tileAt(pick.x, pick.z);
  if (t < 0) return;
  const flight = .45 + Math.min(.6, distance(actor, pick) * .1), id = game.id_();
  game.projectiles.set(id, { id, owner: actor.owner, shooter: actor.id, from: actor.tile, ax: actor.x, az: actor.z, to: t,
    x: pick.x, z: pick.z, weapon: 'missile', damage: spec.damage, radius: 0, arrive: game.time + flight, target: pick.id, air: false, small: true });
  emit(game, { k: 'launch', a: actor.tile, b: t, s: actor.id, t: pick.id, w: VID.missile, f: flight,
    ax: actor.x, az: actor.z, bx: pick.x, bz: pick.z, tw: 1 });
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
  const path = budgetRoute(game, u, u, best, def);
  if (path === DEFERRED) { u.coverReady = game.time + 1; return; }   // Pass 6: the tick's routing budget is spent; again in 1 s
  if (!path) return;
  // A short local maneuver retains the player's destination, attack target and queue.
  // It cannot permanently replace an operation with an unrelated cover order.
  u.tacticalResume = { goal: u.goal }; u.tacticalUntil = game.time + 9;
  u.goal = best; u.path = path; u.blocked = 0; u.coverAnchor = anchor;
}

function acquire(game, actor, def, near) {
  const civ = game.civs[actor.owner];
  const range = def.range + structureRange(actor) + garrisonRange(actor) + (def.ability === 'intercept' && actor.abilityUntil > game.time ? 1.7 : .45);
  let best = null, score = Infinity, bestRank = Infinity;
  const profile = WEAPONS[def.weapon];
  // Pass 7 (perf): only the other sides' entries are read (TargetIndex.hostileQuery), each with its rank in the order the
  // full query() would have listed it; a tie in score goes to the lower rank, i.e. the one the full list met first. The
  // score is worked out first, and a candidate that cannot beat the best so far is skipped before the visibility, range
  // and line-of-sight checks (all side-effect free). The target chosen is the same as walking the full list.
  const ix = game.targets, side = ix.hostileQuery ? ix.sideOf(actor.owner) : undefined;
  const list = side !== undefined ? ix.hostileQuery(actor.x, actor.z, range, near, side) : ix.query(actor.x, actor.z, range, near);
  const ranks = side !== undefined ? ix.ranks : null;
  for (let i = 0; i < list.length; i++) {
    const v = list[i], rank = ranks ? ranks[i] : i;
    if (!alive(v) || !game.hostile(actor.owner, v.owner)) continue;
    const targetDef = unitOf(v), armored = targetDef?.move === 'tracked' || targetDef?.move === 'wheeled';
    const counter = targetDef?.air ? weaponVs(def.weapon, targetDef) * .20 : armored && profile?.vsArmor >= 1.1 ? .48 : 0;
    const d = distance(actor, v) + (targetDef ? 0 : .31) - counter - (v.id === actor.target ? .26 : 0) - (v.hp < 20 ? .18 : 0);
    if (!(d < score || (d === score && rank < bestRank))) continue;
    if (!game.sees(civ, v)) continue;
    const r = attackRange(game, actor, def, v);
    if (!hitChance(game, actor, def.weapon, v, r)) continue;
    score = d; best = v; bestRank = rank;
  }
  return best;
}

// W4 garrison (actionGarrison.js): an occupant never moves, chases or seeks cover. Only the holders of the
// structure's firing slots shoot, from the structure (garrisonRange / sightFrom / GARRISON.fireBonus); an explicit
// attack target is preferred while it is in reach, and hold fire keeps them silent unless ordered.
function garrisonShot(game, u, def, near) {
  if (!def.weapon || u.hp <= 0 || u.readyAt > game.time || (game.tickN + u.id) % 3 !== 0) return;
  if (!firingSlot(game, u)) { u.target = 0; return; }
  const explicit = u.attack ? game.units.get(u.attack) || game.buildings.get(u.attack) : null;
  let target = alive(explicit) && game.sees(game.civs[u.owner], explicit) && hitChance(game, u, def.weapon, explicit, attackRange(game, u, def, explicit)) ? explicit : null;
  if (!target && stanceOf(u) !== 'holdFire') target = acquire(game, u, def, near);
  u.target = target?.id || 0;
  if (target) fire(game, u, def, target);
}

// Aircraft missions, fuel, refuelling, patrol routes and flight paths live in actionAir.js (D).
const aircraftMission = airStep;
// Fixed-wing attack runs (strafing passes, bombing runs) live in actionFlight.js.
const RUN_HOOKS = { fire: (game, u, def, target) => fire(game, u, def, target), damage: (...args) => damageActionTarget(...args) };

// Upgraded city defenses give a headquarters built-in AA (actionAir.cityHasAA): flak airbursts at aircraft.
function cityAntiAir(game, b, near) {
  if ((b.aaReadyAt || 0) > game.time || !cityHasAA(game, b)) return;
  const target = acquire(game, b, CITY_AA, near);
  if (!target || !unitOf(target)?.air) return;
  b.aaReadyAt = game.time + CITY_AA.cooldown;
  b.lastCombat = game.time;
  projectile(game, b, target, CITY_AA.weapon, CITY_AA.attack * 1.65);
}

// Idle infantry beside a friendly trench man it: each squad takes a free firing position along the line
// (spreading out rather than piling onto one spot), so a dug line is held by troops standing in it.
// A squad does this once per halt (`u.manned`, cleared by any new order): squads already in the
// trench, or already placed, never reshuffle along the line.
function manTrenches(game) {
  if (!game.fieldworks?.size || game.tickN % 20 !== 0) return;
  for (const u of game.units.values()) {
    const def = ACTION_UNITS[u.type];
    if (u.manned || u.inside || def.move !== 'infantry' || def.air || u.goal || u.attack || u.mode === 'move' || u.hp <= 0) continue;
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
    const path = budgetRoute(game, u, u, pick, def);
    if (path === DEFERRED) { u.manned = false; continue; }   // Pass 6: asked again on the next trench round
    if (!path) continue;
    u.goal = pick; u.path = path; u.blocked = 0; u.mode = u.mode || 'guard';
  }
}

// ---- Stances and attack-move (workstream C, 2026-11-16) ----
// aggressive: idle units pursue hostiles they can see (leashed to where they stood);
// defensive (default): fire at what comes into range, never pursue; holdFire: never choose targets
// (explicit attack orders and attack-moves still fire). Hold position (`hold` command, `braced`) never moves.
const PURSUIT_LEASH = 4.5;
function nearestHostile(game, u, def, radius) {
  const civ = game.civs[u.owner];
  let best = null, score = Infinity;
  for (const v of game.targets.query(u.x, u.z, radius, [])) {
    if (!alive(v) || !game.hostile(u.owner, v.owner) || !game.sees(civ, v) || !weaponVs(def.weapon, unitOf(v) || { air: false })) continue;
    if (def.defensiveOnly && !v.isUnit) continue;
    const d = distance(u, v) + (v.isUnit ? 0 : .6);
    if (d < score) { score = d; best = v; }
  }
  return best;
}

function stanceStep(game, u, def) {
  if (def.defensiveOnly || u.braced || u.formation && u.goal) return;
  const range = def.range;
  // Attack-move: an enemy seen near the line of advance (but out of range) draws the unit off its path to
  // engage; the original destination resumes afterwards (tacticalResume), as in a normal RTS attack-move.
  if (u.goal && u.mode === 'assault' && !u.tacticalResume && !u.target) {
    const foe = nearestHostile(game, u, def, Math.min(def.vision || 5, range + 2.6));
    if (foe && distance(u, foe) > range * .95) {
      const resume = u.goal, convoy = u.convoy, convoySpeed = u.convoySpeed;
      chase(game, u, foe, range);
      if (u.goal !== resume) {
        u.tacticalResume = { goal: resume }; u.tacticalUntil = game.time + 9;
        u.convoy = convoy; u.convoySpeed = convoySpeed;
      }
    }
    return;
  }
  if (stanceOf(u) !== 'aggressive') { u.pursuit = null; return; }
  if (u.goal && !u.pursuit) return;
  const anchor = u.pursuit || { x: u.x, z: u.z };
  const away = distance(u, anchor);
  const foe = away < PURSUIT_LEASH ? nearestHostile(game, u, def, Math.min(def.vision || 5, 6.5)) : null;
  if (foe && distance(foe, anchor) < PURSUIT_LEASH + range) {
    // (a foe inside a minimum range is not "in reach": chase() backs the unit off to its stand-off distance)
    if (distance(u, foe) <= range * .9 && distance(u, foe) >= (def.minRange || 0) && game.nav.clearShot(u, foe)) { if (u.goal && u.pursuit) stopUnit(game, u); u.pursuit = anchor; return; }
    u.pursuit = anchor;
    chase(game, u, foe, range);
    return;
  }
  if (!u.pursuit) return;
  if (away < .9) { u.pursuit = null; if (u.goal) stopUnit(game, u); return; }
  if (!u.goal || u.goal.x !== anchor.x || u.goal.z !== anchor.z) {
    const path = budgetRoute(game, u, u, anchor, def);
    if (path === DEFERRED) return;   // Pass 6: asked again on the unit's next stance turn
    if (!path) { u.pursuit = null; return; }
    u.goal = { x: anchor.x, z: anchor.z }; u.path = path; u.blocked = 0; u.mode = 'guard';
  }
}

// A bombardment ordered while a setup weapon (def.setup: mortar, field gun, missile battery) was not yet deployed
// (actionBases useAbility): the unit faces the point and sets up, then fires. A new move order (or any motion) cancels it
// and returns the cooldown.
function pendingBombard(game, u, def) {
  if (!def.setup || !alive(u) || u.grounded || u.inside) { u.bombardAt = null; return; }
  if (u.vx || u.vz || u.goal) { u.bombardAt = null; u.abilityReady = Math.min(u.abilityReady || 0, game.time); return; }
  const p = u.bombardAt;
  u.yaw = Math.atan2(dxBetween(u.x, p.x), p.z - u.z);
  if (!u.deployed) {
    if (!u.setupUntil) u.setupUntil = game.time + def.setup;
    if (game.time < u.setupUntil) return;
    u.deployed = true; u.setupUntil = 0;
  }
  u.bombardAt = null;
  game.bombard(u, p);
}

export function actionCombat(game) {
  manTrenches(game);
  const near = [];
  game.targets.clear();
  for (const u of game.units.values()) if (!u.inside) game.targets.add(u);   // W4: occupants are not targets
  for (const b of game.buildings.values()) game.targets.add(b);
  const tm = game.tm, t0 = tm ? performance.now() : 0;   // Pass 7 diagnostics: projectile sub-timing for telemetry
  resolveProjectiles(game, near);
  if (tm) tm.span('combat.projectiles', performance.now() - t0);
  for (const u of game.units.values()) {
    const def = ACTION_UNITS[u.type];
    if (u.inside) { garrisonShot(game, u, def, near); continue; }
    if (def.air && aircraftMission(game, u)) continue;
    if (def.air && attackRuns(game, u, def, RUN_HOOKS, stopUnit)) continue;
    if (def.setup && (u.vx || u.vz) && (u.deployed || u.setupUntil)) { u.deployed = false; u.setupUntil = 0; }
    // a set-up that ran its course while the target slipped out of sight still completes (no endless "setting up")
    else if (def.setup && u.setupUntil && game.time >= u.setupUntil && !u.goal) { u.deployed = true; u.setupUntil = 0; }
    if (u.bombardAt) pendingBombard(game, u, def);
    if (!def.weapon || u.mode === 'move' || u.grounded || !alive(u) || def.air && u.fuel <= 0) continue;
    if (def.coax) coaxStep(game, u, def);
    const civ = game.civs[u.owner];
    const explicit = u.attack ? game.units.get(u.attack) || game.buildings.get(u.attack) : null;
    const seen = alive(explicit) && game.sees(civ, explicit);
    if (seen && !def.defensiveOnly && (game.tickN + u.id) % 9 === 0) {
      const r = attackRange(game, u, def, explicit);
      if (!hitChance(game, u, def.weapon, explicit, r)) {
        // Pass 6: a chase deferred by the routing budget is asked again on the unit's next turn (u.chase left as it was)
        if ((!u.goal || !u.chase || distance(u.chase, explicit) > 1.6) && chase(game, u, explicit, r) !== DEFERRED) u.chase = { x: explicit.x, z: explicit.z };
      } else if (u.goal && !def.air && !u.tacticalResume) stopUnit(game, u);
    } else if (u.attack && (!explicit || explicit.hp <= 0)) { u.attack = null; stopUnit(game, u, true); }
    if (!def.air && !u.attack && (game.tickN + u.id) % 9 === 4) stanceStep(game, u, def);
    if (u.readyAt > game.time || (game.tickN + u.id) % 3 !== 0) continue;
    let target = seen && hitChance(game, u, def.weapon, explicit, attackRange(game, u, def, explicit)) ? explicit : null;
    // hold fire: no self-chosen targets, except while carrying out an attack-move
    if (!target && (stanceOf(u) !== 'holdFire' || u.goal && u.mode === 'assault')) target = acquire(game, u, def, near);
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
    const def = structureDef(b);   // a perimeter turret on a path fights with its path's weapon (BASE_MENU_REWORK.md)
    if (b.type === 'town' && b.done && (game.tickN + b.id) % 6 === 3) cityAntiAir(game, b, near);
    // a structure mid-burst (def.burst, the bunker) is polled every 3 ticks and keeps its target while it stays valid
    const bursting = def.burst && b.burstLeft > 0;
    if (!b.done || !def.attack || b.readyAt > game.time || (game.tickN + b.id) % (bursting ? 3 : 6) !== 0) continue;
    let target = null;
    if (bursting) {
      const held = game.units.get(b.burstTarget) || game.buildings.get(b.burstTarget);
      if (alive(held) && !held.inside && game.hostile(b.owner, held.owner) && game.sees(game.civs[b.owner], held) && hitChance(game, b, def.weapon, held, attackRange(game, b, def, held))) target = held;
    }
    target ||= acquire(game, b, def, near);
    if (target) fire(game, b, def, target);
    else if (bursting) { b.burstLeft = 0; b.burstTarget = 0; }
  }
}

export function canEngage(unit, target) {
  const def = ACTION_UNITS[unit.type];
  if (def.defensiveOnly && (!target.isUnit || distance(unit, target) > def.range + .4)) return false;
  return !!def.weapon && !!weaponVs(def.weapon, unitOf(target) || { air: false });
}

