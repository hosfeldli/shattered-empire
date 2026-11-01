// Airfields as operational bases: home assignment, servicing slots, landing queue, refuel / rearm /
// repair from real national stock, launch eligibility, and what happens when a base is destroyed.
import { BUILDINGS, UNITS } from './constants.js';
import { dist } from './hex.js';
import { book } from './ledger.js';

// what each refill costs: fuel per second of endurance, munitions per round, steel per hit point
export const SERVICE_COST = { fuelPerSec: 0.15, steelPerHp: 0.08, munitions: { fighter: 1.5, support: 3, bomber: 18, strike: 6, recon: 0, oneway: 0 } };

export const isBase = (b) => !!(b && b.done && BUILDINGS[b.type].airbase && b.state !== 'planned');
// drone works only service drones; airfields take everything
export function compatible(b, unitType) {
  const d = BUILDINGS[b.type], u = UNITS[unitType];
  if (!d.airbase) return false;
  if (d.droneOnly) return u.role === 'recon' || u.role === 'oneway' || unitType === 'strike_swarm';
  return true;
}
export function baseSlots(g, b) {
  const civ = g.civs[b.owner];
  return (BUILDINGS[b.type].slots || 2) + (civ?.techs.has('improved_servicing') ? (BUILDINGS[b.type].droneOnly ? 1 : 2) : 0);
}
export function basesOf(g, civId) { const out = []; for (const b of g.buildings.values()) if (b.owner === civId && isBase(b)) out.push(b); return out; }

// nearest operational, compatible base (optionally with a free slot) within reach
export function nearestBase(g, u, { reach = Infinity, free = false, exclude = -1 } = {}) {
  let best = null, bd = Infinity;
  for (const b of g.buildings.values()) {
    if (b.owner !== u.owner || !isBase(b) || b.id === exclude || !compatible(b, u.type)) continue;
    const d = dist(u.tile, b.tile); if (d > reach) continue;
    if (free && occupancy(g, b) >= baseSlots(g, b)) continue;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
// aircraft currently using a servicing slot
export function occupancy(g, b) {
  let n = 0;
  for (const u of g.units.values()) if (u.air && u.air.home === b.id && (u.air.state === 'servicing' || u.air.state === 'landing' || u.air.state === 'awaiting')) n++;
  return n;
}

// What a full turnaround needs: fuel, munitions, steel for repairs, and how long it takes.
export function serviceNeeds(g, u) {
  const d = UNITS[u.type], civ = g.civs[u.owner], a = u.air;
  const fuel = Math.max(0, (d.fuel - a.fuel) * SERVICE_COST.fuelPerSec);
  const munitions = Math.max(0, (d.ammo - a.ammo) * (SERVICE_COST.munitions[d.role] || 0));
  const hpMissing = Math.max(0, u.maxHp - u.hp), steel = hpMissing * SERVICE_COST.steelPerHp;
  const share = Math.max((d.fuel - a.fuel) / d.fuel, d.ammo ? (d.ammo - a.ammo) / d.ammo : 0);
  let time = d.svc * Math.max(0.25, share) + (hpMissing / u.maxHp) * 12;
  if (civ.techs.has('improved_servicing')) time *= 0.67;
  const cost = {}; if (fuel > 0.05) cost.fuel = +fuel.toFixed(2); if (munitions > 0.05) cost.munitions = +munitions.toFixed(2); if (steel > 0.05) cost.steel = +steel.toFixed(2);
  return { cost, time: Math.max(2, time) };
}

// Start servicing: pay from the national stock (an airfield cannot conjure fuel or munitions).
export function beginService(g, u, b) {
  const civ = g.civs[u.owner];
  const { cost, time } = serviceNeeds(g, u);
  if (!g.canAfford(civ, cost, b.tile)) { u.air.state = 'awaiting'; u.air.note = `waiting for ${Object.keys(cost).filter((k) => (civ.res[k] || 0) < cost[k]).join(' and ')}`; return false; }
  g.pay(civ, cost, b.tile, 'army');
  u.air.state = 'servicing'; u.air.svcLeft = time; u.air.svcTotal = time; u.air.note = '';
  return true;
}
export function finishService(g, u) {
  const d = UNITS[u.type];
  u.air.fuel = d.fuel; u.air.ammo = d.ammo; u.hp = u.maxHp; u.air.state = 'ready'; u.air.svcLeft = 0; u.supply = 100;
}

// A base was destroyed: aircraft parked there scramble damaged; those under service are lost;
// everything airborne that called it home looks for another base.
export function baseLost(g, b) {
  for (const u of [...g.units.values()]) {
    if (!u.air || u.air.home !== b.id) continue;
    if (u.air.state === 'servicing' || u.air.state === 'landing') { g.damageUnit(u, u.hp + 1, null, 'combat'); continue; }
    if (u.air.state === 'ready' || u.air.state === 'awaiting') { u.hp = Math.max(1, u.hp * 0.7); u.air.state = 'diverting'; }
    else if (u.air.state !== 'diverting') u.air.state = 'diverting';
    u.air.home = -1;
    if (u.air.mission && u.air.mission.kind !== 'return') u.air.mission.suspended = true;
  }
  const civ = g.civs[b.owner];
  if (civ?.human) g.notify(b.owner, `${BUILDINGS[b.type].name} destroyed: its aircraft are diverting to other bases.`, { kind: 'loss', tile: b.tile, level: 'major' });
  void book;
}

export function baseSummary(g, b) {
  const s = { id: b.id, t: b.tile, type: b.type, slots: baseSlots(g, b), ready: 0, patrol: 0, mission: 0, returning: 0, servicing: 0, holding: 0, awaiting: 0, aircraft: [] };
  for (const u of g.units.values()) {
    if (!u.air || u.air.home !== b.id) continue;
    const st = u.air.state;
    if (st === 'ready') s.ready++;
    else if (st === 'servicing' || st === 'landing') s.servicing++;
    else if (st === 'holding') s.holding++;
    else if (st === 'awaiting') s.awaiting++;
    else if (st === 'returning' || st === 'diverting') s.returning++;
    else if (u.air.mission?.kind === 'patrol' || u.air.mission?.kind === 'scout') s.patrol++;
    else s.mission++;
    s.aircraft.push(u.id);
  }
  return s;
}
