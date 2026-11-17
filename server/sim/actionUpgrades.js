// Functional upgrades and building levels (workstream B, 2026-11-16).
//
// Each upgrade changes behaviour rather than adding a flat percentage. actionCombat.js calls the hooks
// below; the client sees every upgrade as a civ-wide equipment bit (unit snapshot extra[7]) and the
// one-off actions as event flags (see docs/CHANGELOG_2026-11-16.md, workstream B):
//   grenades          launch event  gr:1   (area burst, radius .45, reaches troops in cover)
//   rocket_teams      launch event  rk:1   (one AT rocket per squad every 14 s at vehicles / structures)
//   body_armor        hit event     ar:1   (a lethal hit on a soldier is absorbed once per man)
//   marksmen          fire event    mk:1   (every 12 s a 1.45x-range precision shot at crews and squads)
//   heavy_armor       tracked vehicles ignore small arms, wheeled vehicles take half
//   field_engineering engineers work under fire; vehicles self-repair to 70% (actionEngineers.js)
//   improved_logistics new units move 35% faster to their rally point (u.hasteUntil)
//   networked_command +1.5 vision and 2.5-hex detection for every unit and structure (actionGame.js)
//   infantry_training halted infantry take cover .22 / .12 indirect wherever they stop (actionCombat.cover)
//   aircraft_systems  drop tanks: +50% endurance and patrol range, refuel twice as fast (actionAir.maxFuel)
import { WEAPON_KEYS, WEAPONS } from './weapons.js';
import { ACTION_UNITS } from './actionDefinitions.js';
import { distance, tileAt } from './actionNavigation.js';
import { emit } from './combat.js';

const VID = Object.fromEntries(WEAPON_KEYS.map((key, index) => [key, index]));
export const SMALL_ARMS = new Set(['carbine', 'rifle', 'smg_team', 'mg', 'mg_light', 'pistol']);
const ROCKET_SQUADS = new Set(['rifle_squad', 'militia', 'special_forces']);
const CREWS = new Set(['anti_armor', 'mortar_team', 'field_gun']);
export const HASTE = { factor: 1.35, seconds: 45 };

/** Living men in a squad: ceil(hp / maxHp × men). Single-model units report their `men` (0 for vehicles). */
export function menOf(u) {
  const men = ACTION_UNITS[u.type]?.men || 0;
  if (men <= 1) return u.hp > 0 ? men : 0;
  return Math.max(0, Math.ceil(u.hp / u.maxHp * men - 1e-6));
}

/** Firepower multiplier of a squad from its surviving men (a full squad fires at 1). */
export function squadFirepower(u) {
  const men = ACTION_UNITS[u.type]?.men || 0;
  return men > 1 ? Math.max(.25, menOf(u) / men) : 1;
}

/** Era level of a structure (1-3): defenses gain +25% firepower and +0.35 range per level. */
export const structureDamage = (b) => b && !b.isUnit && b.level > 1 && b.type !== 'town' ? 1 + .25 * (b.level - 1) : 1;
export const structureRange = (b) => b && !b.isUnit && b.level > 1 && b.type !== 'town' ? .35 * (b.level - 1) : 0;

/**
 * Damage after armour upgrades. Returns the damage to apply (0 = ignored). `d` is the target's unit def.
 * heavy_armor: tracked vehicles ignore small arms; wheeled take half. body_armor: the first hit that would
 * kill each soldier is absorbed (the man survives at 1 HP), at most once per man in the squad.
 */
export function armourDamage(game, target, d, weapon, damage) {
  if (!d || d.air) return damage;
  const techs = game.civs[target.owner]?.techs;
  if (!techs) return damage;
  if (techs.has('heavy_armor') && SMALL_ARMS.has(weapon)) {
    if (d.move === 'tracked') return 0;
    if (d.move === 'wheeled') damage = Math.max(1, Math.round(damage * .5));
  }
  // 2026-11-17: a save spares exactly ONE of the men the hit would kill (he is left at 1 HP); the rest of the
  // hit still lands. Before, a save capped the hit at the first man's remaining HP, so a squad left on
  // "n men + 1 HP" took 0 damage from every later lethal hit (tank shells, bunker bursts) until all its plates
  // were used: an armoured rifle squad shrugged off about eight shells of any size.
  if (d.move === 'infantry' && techs.has('body_armor')) {
    const men = Math.max(1, d.men || 1), per = target.maxHp / men;
    const before = Math.ceil(target.hp / per - 1e-6), after = Math.ceil(Math.max(0, target.hp - damage) / per - 1e-6);
    // a man already spared (left on 1 HP) is not spared twice: the save goes to the next man the hit kills
    const spared = target.hp - (before - 1) * per <= 1 + 1e-6 ? 1 : 0;
    if (before - after - spared > 0 && (target.plates || 0) < men) {
      target.plates = (target.plates || 0) + 1;
      target.armourSave = game.time;
      damage = Math.max(0, Math.min(damage, Math.floor(target.hp - (after * per + 1))));
    }
  }
  return damage;
}

// Barracks kit numbers (2026-11-17 balance pass: rocket 34 dmg / 14 s -> 20 / 24 s).
export const KIT = { grenade: { damage: 24, cooldown: 9 }, rocket: { damage: 20, cooldown: 24 } };

function lob(game, shooter, target, weapon, damage, radius, flag, extra = {}) {
  const w = WEAPONS[weapon], t = tileAt(target.x, target.z);
  if (t < 0) return;
  const flight = (w.flight || .7) * .55 + Math.min(.5, distance(shooter, target) * .04);
  const id = game.id_();
  game.projectiles.set(id, { id, owner: shooter.owner, shooter: shooter.id, from: shooter.tile, ax: shooter.x, az: shooter.z, to: t,
    x: target.x, z: target.z, weapon, damage, radius, arrive: game.time + flight, target: radius ? 0 : target.id || 0, air: false, small: true, ...extra });
  emit(game, { k: 'launch', a: shooter.tile, b: t, s: shooter.id, t: target.id, w: VID[weapon], f: flight,
    ax: shooter.x, az: shooter.z, bx: target.x, bz: target.z, [flag]: 1 });
}

/**
 * Barracks kit, called after an infantry squad fires its main weapon. Each piece of kit has its own
 * cooldown on the unit (grenadeReady, rocketReady, marksmanReady).
 */
export function infantryKit(game, actor, def, target, damageTarget) {
  if (!actor.isUnit || def.move !== 'infantry' || def.cat === 'artillery') return;
  const techs = game.civs[actor.owner]?.techs;
  if (!techs || !menOf(actor)) return;
  const enemy = target.isUnit ? ACTION_UNITS[target.type] : null;
  if (enemy?.air) return;
  const range = distance(actor, target);
  if (techs.has('grenades') && (actor.grenadeReady || 0) <= game.time && range < 1.4 && (!enemy || enemy.move === 'infantry')) {
    actor.grenadeReady = game.time + KIT.grenade.cooldown;
    lob(game, actor, target, 'mortar', KIT.grenade.damage, .45, 'gr', { kit: 'grenade' });
  }
  // 2026-11-17: one light rocket per squad, inside the squad's own rifle range (it outranged the tank's gun at
  // 1.1x) and on a longer reload; six kitted squads one-shot a tank every 14 s before.
  if (techs.has('rocket_teams') && ROCKET_SQUADS.has(actor.type) && (actor.rocketReady || 0) <= game.time &&
    (!enemy || enemy.move === 'tracked' || enemy.move === 'wheeled') && range <= def.range) {
    actor.rocketReady = game.time + KIT.rocket.cooldown;
    lob(game, actor, target, 'atgun', KIT.rocket.damage, 0, 'rk', { kit: 'rocket' });
  }
  if (techs.has('marksmen') && (actor.marksmanReady || 0) <= game.time) {
    const reach = def.range * 1.45, civ = game.civs[actor.owner];
    let best = null, score = Infinity;
    for (const v of game.targets.query(actor.x, actor.z, reach, [])) {
      const vd = v.isUnit ? ACTION_UNITS[v.type] : null;
      if (!vd || vd.air || v.hp <= 0 || !game.hostile(actor.owner, v.owner) || !game.sees(civ, v)) continue;
      if (vd.move !== 'infantry' && !CREWS.has(v.type) && vd.cat !== 'artillery') continue;
      const r = distance(actor, v);
      if (r > reach || !game.nav.clearShot(actor, v)) continue;
      const s = r - (CREWS.has(v.type) || vd.cat === 'artillery' ? 3 : 0);
      if (s < score) { score = s; best = v; }
    }
    if (best) {
      actor.marksmanReady = game.time + 12;
      emit(game, { k: 'fire', a: actor.tile, b: best.tile, ax: actor.x, az: actor.z, bx: best.x, bz: best.z, s: actor.id, t: best.id, w: VID.rifle, mk: 1 });
      damageTarget(game, best, actor, 24, 'rifle', true);
    }
  }
}
