// Garrisons (requirement R4, W4 2026-11-17; docs/gameplay-overhaul/CAPTURE_AND_GARRISON.md).
//
// Structures with `def.garrison` (actionDefinitions GARRISON) shelter up to that many infantry squads. A squad that
// enters gets `u.inside = b.id`, sits at the structure's position and leaves the movement, spatial and targeting
// indexes: unitMotion skips it, combat cannot select it (actionCombat rebuilds `targets` without it, `sees()` hides it
// from rivals), capture zones do not count it (they query `movers`). It still exists: population, vision (from the
// structure) and the owner's roster count it once, as before.
//
// Protection: direct fire hits the structure, never the occupants. A blast that hits the structure also hits each
// occupant for (1 - GARRISON.protection) of its damage. When the structure is destroyed (or removed: demolished, or
// its base's headquarters lost) the occupants are thrown out around it; on destruction each loses GARRISON.ejectDamage
// of its max HP. Structures never change owner in this ruleset, so there is no capture-with-occupants case.
//
// Firing: only the first `def.firingSlots` occupants (in order of entry) fire, from the structure's position, with
// +GARRISON.rangeBonus range and ×GARRISON.fireBonus damage, needing line of sight from the structure. The rest are
// sheltered and silent, so a structure is never an unlimited firing platform.
import { ACTION_BUILDINGS, ACTION_UNITS, GARRISON } from './actionDefinitions.js';
import { distance, tileAt } from './actionNavigation.js';
import { moveGroup, stopUnit } from './actionOrders.js';

/** Can this unit enter a garrison at all (capture-capable infantry squads, not the automatic engineers)? */
export const canGarrison = (u) => {
  const d = ACTION_UNITS[u?.type];
  return !!d && d.capture && !d.auto && !d.air && u.hp > 0;
};
export const capacityOf = (b) => ACTION_BUILDINGS[b?.type]?.garrison || 0;
const occupants = (b) => b.garrison || (b.garrison = []);

function unindex(index, o) {
  const cell = index.cells.get(index.key(o.x, o.z));
  if (!cell) return;
  const i = cell.indexOf(o);
  if (i >= 0) cell.splice(i, 1);
}

const queueOf = (game) => game.garrisonQueue ??= new Set([...game.units.values()].filter((u) => u.enter).map((u) => u.id));

/** Put `u` inside `b` now (no distance check). Returns false when full or not allowed. */
export function enterBuilding(game, u, b) {
  if (!canGarrison(u) || !b?.done || b.hp <= 0 || u.owner !== b.owner || u.inside) return false;
  const list = occupants(b);
  if (list.length >= capacityOf(b)) return false;
  unindex(game.movers, u); unindex(game.targets, u);
  stopUnit(game, u);
  u.orders.length = 0; u.pursuit = null; u.tacticalResume = null; u.supportTask = null; u.manned = false;
  u.deployed = false; u.setupUntil = 0; u.target = 0; u.enter = 0;
  u.inside = b.id;
  u.x = b.x; u.z = b.z; u.tile = b.tile;
  list.push(u.id);
  queueOf(game).delete(u.id);
  return true;
}

/** Take `u` out of its structure, placing it beside it. `hurt` is a share of max HP lost (destruction). */
export function leaveBuilding(game, u, hurt = 0) {
  if (!u?.inside) return false;
  const b = game.buildings.get(u.inside);
  if (b?.garrison) b.garrison = b.garrison.filter((id) => id !== u.id);
  u.inside = 0;
  const d = ACTION_UNITS[u.type], from = b || u;
  const a = u.id * 2.39996, r = (from.radius || .3) + d.radius + .12;
  const spot = game.nav.nearest({ x: from.x + Math.sin(a) * r, z: from.z + Math.cos(a) * r }, d, 1.8) || { x: from.x, z: from.z };
  u.x = spot.x; u.z = spot.z; u.tile = tileAt(u.x, u.z);
  if (hurt > 0) {
    u.hp = Math.max(0, u.hp - u.maxHp * hurt);
    u.lastCombat = game.time;
    if (u.hp <= 0) {
      game.units.delete(u.id);
      if (game.civs[u.owner]) game.civs[u.owner].casualties++;
      return true;
    }
  }
  game.movers.add(u);
  game.targets.add(u);
  return true;
}

/** A structure is going away: everyone inside gets out (hurt if it was destroyed). */
export function ejectAll(game, b) {
  if (!b.garrison?.length) return [];
  const out = [];
  for (const id of [...b.garrison]) {
    const u = game.units.get(id);
    if (u?.inside === b.id) { leaveBuilding(game, u, b.hp <= 0 ? GARRISON.ejectDamage : 0); if (game.units.has(id)) out.push(u); }
  }
  b.garrison = [];
  return out;
}

/** {c:'garrison', units, building}: eligible units walk to the structure and enter on arrival. */
export function garrisonCommand(game, civ, group, id) {
  const b = game.buildings.get(id);
  if (!b || b.owner !== civ.id) return { error: 'Select one of your structures.' };
  const cap = capacityOf(b);
  if (!cap) return { error: 'That structure cannot be garrisoned.' };
  if (!b.done) return { error: 'The structure is not finished yet.' };
  const eligible = group.filter((u) => canGarrison(u) && u.inside !== b.id);
  if (!eligible.length) return { error: 'Only infantry squads can garrison structures.' };
  const heading = [...queueOf(game)].filter((uid) => game.units.get(uid)?.enter === b.id && !eligible.some((u) => u.id === uid)).length;
  let free = cap - occupants(b).filter((uid) => game.units.has(uid)).length - heading;
  if (free <= 0) return { error: 'That structure is full.' };
  const send = [], entered = [];
  for (const u of eligible) {
    if (free <= 0) break;
    if (u.inside) leaveBuilding(game, u);
    free--;
    if (distance(u, b) <= b.radius + GARRISON.reach) { enterBuilding(game, u, b); entered.push(u.id); continue; }
    send.push(u);
  }
  if (send.length) {
    moveGroup(game, send, { x: b.x, z: b.z }, { mode: 'move' });
    for (const u of send) { u.enter = b.id; queueOf(game).add(u.id); }
  }
  return { garrison: b.id, entered: entered.length, moving: send.length, refused: group.length - entered.length - send.length };
}

/** {c:'ungarrison', building, units?, all?}: occupants step out (all of them unless `units` names some). */
export function ungarrisonCommand(game, civ, id, ids) {
  const b = id ? game.buildings.get(id) : null;
  if (id && (!b || b.owner !== civ.id)) return { error: 'Select one of your structures.' };
  const pick = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  if (!b && !pick) return { error: 'Select a garrisoned structure or squads.' };
  const list = b ? [...occupants(b)] : [...pick];
  const out = [];
  for (const uid of list) {
    if (pick && !pick.has(uid)) continue;
    const u = game.units.get(uid);
    if (!u || u.owner !== civ.id || !u.inside || b && u.inside !== b.id) continue;
    const home = game.buildings.get(u.inside);
    leaveBuilding(game, u);
    out.push(u);
    if (home?.exitRally) moveGroup(game, [u], home.exitRally, { mode: 'move' });
  }
  return out.length ? { ungarrisoned: out.length } : { error: 'Nobody is inside.' };
}

/** {c:'garrisonRally', building, x, z}: where occupants go when they step out (no point clears it). */
export function garrisonRally(game, civ, id, point) {
  const b = game.buildings.get(id);
  if (!b || b.owner !== civ.id || !capacityOf(b)) return { error: 'Select one of your garrisonable structures.' };
  b.exitRally = point ? { x: point.x, z: point.z } : null;
  return {};
}

/** Scheduler step (every 2 ticks): squads walking to a structure enter once close enough. O(walkers). */
export function garrisonStep(game) {
  const queue = queueOf(game);
  if (!queue.size) return;
  for (const id of queue) {
    const u = game.units.get(id), b = u && game.buildings.get(u.enter);
    if (!u || !b || u.inside || b.owner !== u.owner || b.hp <= 0) { if (u) u.enter = 0; queue.delete(id); continue; }
    // a squad that halted at its slot beside the structure (moveGroup spreads a group around it) may enter from a little further
    if (distance(u, b) <= b.radius + GARRISON.reach + (u.goal ? 0 : .8)) {
      if (!enterBuilding(game, u, b)) { u.enter = 0; queue.delete(id); }
    } else if (!u.goal) { u.enter = 0; queue.delete(id); }   // stopped short (blocked, or a new order): give up
  }
}

/** True when `u` is inside and holds one of its structure's firing slots. */
export function firingSlot(game, u) {
  const b = u.inside && game.buildings.get(u.inside);
  if (!b) return false;
  const slots = ACTION_BUILDINGS[b.type].firingSlots || 0;
  if (!slots) return false;
  let n = 0;
  for (const id of b.garrison) {
    if (!game.units.has(id)) continue;
    if (id === u.id) return true;
    if (++n >= slots) return false;
  }
  return false;
}
export const garrisonRange = (u) => u.inside ? GARRISON.rangeBonus : 0;
/** Where line of sight is traced from: the structure for an occupant (its own walls do not block it). */
export const sightFrom = (game, u) => u.inside ? game.buildings.get(u.inside) || u : u;

/** A blast hit structure `b`: occupants take (1 - protection) of it through `damage` (actionCombat.damageActionTarget). */
export function shelterBlast(game, b, source, amount, weapon, blast, damage) {
  for (const id of [...b.garrison]) {
    const u = game.units.get(id);
    if (u?.inside === b.id) damage(game, u, source, amount * (1 - GARRISON.protection), weapon, true, blast);
  }
  b.garrison = b.garrison.filter((id) => game.units.has(id));
}

/** Econ wire: living occupant ids, in order of entry (the first `firingSlots` fire). */
export const garrisonWire = (game, b) => b.garrison?.length ? b.garrison.filter((id) => game.units.has(id)) : undefined;
