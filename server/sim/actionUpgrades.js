// Functional upgrades and building levels (workstream B, 2026-11-16).
//
// 2026-11-19 (user: "Remove the upgrade system for troops"): the troop upgrades and their hooks are gone: barracks kit
// (grenades, rocket teams, marksmen, body armour), Infantry Training, Heavy Armor, Field Engineering and Aircraft
// Systems (actionDefinitions REMOVED_UPGRADES).
// 2026-11-20 (user: "Remove the armory from the game"): the Armory's two command upgrades went with it: Improved
// Logistics (reinforcement haste, u.hasteUntil) and Networked Command (the vision net in actionGame.revealSource).
import { WEAPONS } from './weapons.js';
import { ACTION_UNITS } from './actionDefinitions.js';
import { distance } from './actionNavigation.js';

export const SMALL_ARMS = new Set(['carbine', 'rifle', 'smg_team', 'mg', 'mg_light', 'pistol']);

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
 * Apply `damage` (after cover and armour multipliers) to a squad, man by man. Returns the hp the squad loses.
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
