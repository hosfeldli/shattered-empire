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

// ---- Squad simulation (W3, 2026-11-17; user decision R3: a squad stays ONE entity, O(1) per squad) ----
// A squad's hp is a pool of `men` soldiers of maxHp / men each. The living men are the full-health men plus the
// one "wounded man" whose hp is what is left over: hp = (alive - 1) × perMan + wounded, wounded in (0, perMan].
// Every hit goes through squadHit, which kills men one at a time (the wounded man first, then whole men) and
// caps how many men a single hit can kill:
//   - direct small-arms volleys: the weapon's burst (rifle 3, carbine 2, MG 6 ...): a volley never wipes a squad;
//   - direct single rounds (AT guns, cannon, rockets): 1 + HE share; tanks firing HE (def.vsInfantry) double it;
//   - blasts (mortar, artillery, bombs, grenades): the men inside the lethal core, in proportion to the blast's
//     radius versus the squad's spread (a squad on the move bunches up, halted it spreads out).
// Damage beyond the cap is wasted (overkill), so heavy single rounds no longer delete squads by pooled hp.
// Firepower is per man: living men / men, with accuracy falling off with range and under suppression.
export const SQUAD = {
  spreadMoving: .34,        // radius (world units) of a squad on the move (bunched in a column)
  spreadHalted: .52,        // radius of a halted / deployed squad (men spread out, in their scrapes)
  lethalShare: .6,          // share of a blast's radius that kills outright
  accuracyNear: .4,         // full accuracy out to this share of the weapon's range ...
  accuracyFar: .7,          // ... falling linearly to this at maximum range
  suppressDecay: 5,         // suppression points lost per second
  suppressFire: .35,        // a fully suppressed squad (100) fires at 1 - this
};
const CREW_SERVED = new Set(['mortar_team']);   // one tube: full rate while two men can work it

const perManOf = (u, men) => u.maxHp / men;

/** Living men in a squad: ceil(hp / perMan) (the wounded man counts). Single-model units report their `men` (0 for vehicles). */
export function menOf(u) {
  const men = ACTION_UNITS[u.type]?.men || 0;
  if (men <= 1) return u.hp > 0 ? men : 0;
  return Math.max(0, Math.ceil(u.hp / perManOf(u, men) - 1e-6));
}

/** HP of the squad's wounded man (the next to fall), in (0, perMan]. 0 for a dead squad. */
export function woundedHp(u) {
  const men = ACTION_UNITS[u.type]?.men || 0;
  if (men <= 1) return Math.max(0, u.hp);
  const alive = menOf(u);
  return alive ? u.hp - (alive - 1) * perManOf(u, men) : 0;
}

/** Suppression 0..100 now (decays lazily: stored value and the time it was set). */
export function suppressionOf(u, time) {
  if (!u.supp) return 0;
  return Math.max(0, u.supp - (time - (u.suppAt || 0)) * SQUAD.suppressDecay);
}
export function suppress(u, time, points) {
  u.supp = Math.min(100, suppressionOf(u, time) + points);
  u.suppAt = time;
}

/** Most men one hit may kill. `blast` is the blast radius (0 for a direct hit); `heavy` a tank's HE round. */
export function killCap(u, weapon, blast, alive, heavy = false) {
  if (blast > 0) {
    const spread = u.goal ? SQUAD.spreadMoving : SQUAD.spreadHalted;
    const share = Math.min(1, (blast * SQUAD.lethalShare / spread) ** 2);
    return Math.max(1, Math.min(alive, Math.ceil(alive * share - 1e-9)));
  }
  const w = WEAPONS[weapon];
  if (!w) return alive;
  if (w.mode === 'hitscan') return Math.max(1, w.burst || 1);
  return Math.max(1, Math.round((w.he || 0) * 5)) * (heavy ? 2 : 1);
}

/**
 * Apply `damage` (after cover and armour multipliers) to a squad, man by man. Returns the hp the squad loses
 * (0 when nothing landed or body armour saved the only man it would kill). Handles Body Armour: a hit that kills
 * men spares one of them (left on 1 HP), at most once per man; a man already spared is not spared twice.
 */
export function squadHit(game, u, d, weapon, damage, blast = 0, heavy = false) {
  const men = d.men || 1;
  if (men <= 1 || damage <= 0 || u.hp <= 0) return Math.max(0, Math.min(u.hp, damage));
  const per = perManOf(u, men);
  const alive = menOf(u);
  const wounded = u.hp - (alive - 1) * per;
  const cap = killCap(u, weapon, blast, alive, heavy);
  let left = damage, kills = 0, next = wounded;
  while (kills < alive && left >= next - 1e-9) {
    if (kills >= cap) { left = 0; break; }
    left -= next; kills++; next = per;
  }
  if (kills >= cap) left = 0;   // overkill past the cap is wasted
  // Body Armour: one of the men this hit kills is spared, on 1 HP (never the same man twice)
  const techs = game.civs[u.owner]?.techs;
  if (kills > 0 && techs?.has('body_armor') && (u.plates || 0) < men) {
    const alreadySpared = wounded <= 1 + 1e-6 ? 1 : 0;
    if (kills - alreadySpared > 0) {
      u.plates = (u.plates || 0) + 1;
      u.armourSave = game.time;
      kills--; left = 0;
      const after = alive - kills;
      const hp = (after - 1) * per + 1;
      return Math.max(0, u.hp - hp);
    }
  }
  const after = alive - kills;
  if (after <= 0) return u.hp;
  // the next man takes what is left of the hit (always < his hp, by the loop)
  const woundedAfter = (kills ? per : wounded) - left;
  const hp = (after - 1) * per + Math.max(woundedAfter, 1e-3);
  return Math.max(0, u.hp - hp);
}

/**
 * Firepower multiplier of a squad (a full, unsuppressed squad firing at close range fires at 1): its living men,
 * accuracy falling off over the outer part of its range, and suppression. Crew-served weapons fire at full rate
 * while two men can work them. Pass `game`, `def` and `target` for range and suppression (optional).
 */
export function squadFirepower(u, game = null, def = null, target = null) {
  def ||= ACTION_UNITS[u.type];
  const men = def?.men || 0;
  if (men <= 1) return 1;
  const alive = menOf(u);
  let f = CREW_SERVED.has(u.type) ? (alive >= 2 ? 1 : alive ? .6 : 0) : alive / men;
  if (target && def.range > 0 && WEAPONS[def.weapon]?.mode === 'hitscan') {
    const r = distance(u, target) / def.range;
    const k = Math.max(0, Math.min(1, (r - SQUAD.accuracyNear) / (1 - SQUAD.accuracyNear)));
    f *= 1 - (1 - SQUAD.accuracyFar) * k;
  }
  if (game) f *= 1 - SQUAD.suppressFire * suppressionOf(u, game.time) / 100;
  return f;
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
  // squads of several men get their saves inside squadHit (W3), man by man; this covers single-man units
  if (d.move === 'infantry' && (d.men || 1) <= 1 && techs.has('body_armor')) {
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
