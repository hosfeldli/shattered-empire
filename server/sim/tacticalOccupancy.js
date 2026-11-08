// Ground occupancy and zones of control.
//
//  * A hex holding a hostile ground unit is never a legal destination for a ground unit. Allies
//    share hexes within capacity; aircraft overfly.
//  * Entries are reserved deterministically within a tick (units move in id order): two hostile
//    units cannot enter the same empty hex together, and opposing units cannot swap hexes (each
//    still occupies its origin until it arrives).
//  * Zones of control: a combat-capable hostile ground unit controls its hex and the six around
//    it. Stepping from one hostile-controlled hex straight into another is refused, so a line
//    cannot be slipped along or through; stepping out of control (withdrawal) or into it
//    (contact) is allowed. Routed, retreating or broken units (and empty trenches) exert none.
import { UNITS } from './constants.js';
import { NB } from './hex.js';

const ground = (u) => !UNITS[u.type].air;
// does this unit contest the ground around it?
export function exertsZoc(u) {
  const d = UNITS[u.type];
  return !d.air && !d.civilian && d.atk > 0 && !u.retreating && u.hp > u.maxHp * 0.15 && (u.morale ?? 100) >= 20;
}

// built once per tick (with tileUnits): who is entering which hex
export function rebuildEntering(g) {
  const m = g.entering || (g.entering = new Map()); m.clear();
  for (const u of g.units.values()) if (u.next >= 0 && u.prog > 0 && ground(u)) m.set(u.next, u.owner);
}

export function hostileGroundAt(g, owner, t) {
  const ids = g.tileUnits.get(t);
  if (ids) for (const id of ids) { const o = g.units.get(id); if (o && ground(o) && g.hostile(owner, o.owner)) return true; }
  return false;
}

export function zocAt(g, owner, t) {
  const z = (x) => { const ids = g.tileUnits.get(x); if (ids) for (const id of ids) { const o = g.units.get(id); if (o && g.hostile(owner, o.owner) && exertsZoc(o)) return true; } return false; };
  if (z(t)) return true;
  for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && z(n)) return true; }
  return false;
}

// May unit u step from its tile into `to` right now? Returns null or the reason it may not.
export function stepBlock(g, u, to) {
  if (!ground(u)) return null;
  if (hostileGroundAt(g, u.owner, to)) return 'occupied';
  const ent = g.entering?.get(to);
  if (ent != null && ent !== u.owner && g.hostile(u.owner, ent)) return 'contested';
  if (zocAt(g, u.owner, u.tile) && zocAt(g, u.owner, to)) return 'zoc';
  return null;
}

// claim the hex a unit starts moving into (so a hostile unit later this tick cannot)
export function reserve(g, u, to) { if (ground(u)) (g.entering || (g.entering = new Map())).set(to, u.owner); }

// for routing: what this civ can see of hostile occupation and control (never hidden units)
export function knownBlocked(g, civ, t) {
  if (!civ.visible[t]) return false;
  const ids = g.tileUnits.get(t);
  if (ids) for (const id of ids) { const o = g.units.get(id); if (o && ground(o) && g.hostile(civ.id, o.owner) && g.detects(civ.id, o)) return true; }
  return false;
}
export function knownZoc(g, civ, t) {
  if (!civ.visible[t]) return false;
  const z = (x) => { const ids = g.tileUnits.get(x); if (ids) for (const id of ids) { const o = g.units.get(id); if (o && g.hostile(civ.id, o.owner) && exertsZoc(o) && civ.visible[x] && g.detects(civ.id, o)) return true; } return false; };
  if (z(t)) return true;
  for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && z(n)) return true; }
  return false;
}

// per civ and tick: hexes it knows are hostile-held, and the hostile control around them
export function knownSets(g, civ) {
  const c = g.knownCache || (g.knownCache = new Map());
  let k = c.get(civ.id);
  if (k && k.tick === g.tickN) return k;
  // the same in a byte mask (1 held, 2 controlled) for the path search's inner loop
  k = { tick: g.tickN, occ: new Set(), zoc: new Set(), mask: k?.mask || new Uint8Array(NB.length / 6) };
  k.mask.fill(0);
  for (const o of g.units.values()) {
    if (!ground(o) || !g.hostile(civ.id, o.owner) || !civ.visible[o.tile] || !g.detects(civ.id, o)) continue;
    k.occ.add(o.tile); k.mask[o.tile] |= 1;
    if (exertsZoc(o)) { k.zoc.add(o.tile); k.mask[o.tile] |= 2; for (let d = 0; d < 6; d++) { const n = NB[o.tile * 6 + d]; if (n >= 0) { k.zoc.add(n); k.mask[n] |= 2; } } }
  }
  c.set(civ.id, k);
  return k;
}
