// Logistics: activity-based supply consumption, finite-cargo supply convoys and field caches.
//
// Activity (derived each second from what a unit is actually doing) sets how fast a cut-off unit
// burns its own reserves and what it costs the nation in food and fuel: prepared positions are
// cheap to hold, marching is dear. Fixed maintenance (credits) is unaffected; ammunition is
// still spent per shot.
//
// Supply trucks no longer project an endless aura. A truck loads a finite package from a real
// source (a connected city's national stock, an isolated city's local stock, or a depot), drives
// to a safe point behind the force, hands out supplies by need, leaves the rest as a small
// field cache, and comes back. Cargo exists in exactly one place: source, truck, cache or units.
import { book } from './ledger.js';
import { UNITS, N, isWater, TERRAIN } from './constants.js';
import { dist, disk, centroid } from './hex.js';
import { findPath } from './path.js';
import { hostileGroundAt, zocAt } from './tacticalOccupancy.js';

// ------------------------------------------------------------------ activity
export const ACTIVITY = {
  //               isolated supply loss/s   food x   fuel x
  moving:          { loss: 2.5,  food: 1,    fuel: 1 },
  movingFight:     { loss: 3.0,  food: 1.15, fuel: 1.15 },
  stationary:      { loss: 1.25, food: 0.5,  fuel: 0.2 },
  stationaryFight: { loss: 1.6,  food: 0.8,  fuel: 0.4 },
  trench:          { loss: 0.4,  food: 0.2,  fuel: 0.15 },
  trenchFight:     { loss: 1.0,  food: 0.35, fuel: 0.15 },
  construct:       { loss: 2.5,  food: 1,    fuel: 0.2 },
  parked:          { loss: 1.25, food: 0.5,  fuel: 0.15 },
};
export function activityOf(g, u) {
  const d = UNITS[u.type];
  const moving = u.path.length > 0 || u.field || u.prog > 0;
  const fighting = g.time - (u.lastCombat ?? -99) < 3;
  if (moving) return fighting ? 'movingFight' : 'moving';
  const fw = g.fieldworks?.get(u.tile);
  // troops no longer dig: an occupied (finished or reinforcing) trench is what conserves supply
  if (fw && d.move === 'infantry' && !d.civilian && (fw.progress >= 1 || fw.upgrading) && fw.hp >= 50) return fighting ? 'trenchFight' : 'trench';
  if (fighting) return 'stationaryFight';
  return d.move === 'infantry' ? 'stationary' : 'parked';
}

// ------------------------------------------------------------------ cargo
export const CARGO_CAP = 120;
export const CARGO_WEIGHT = { food: 1, munitions: 1.5, fuel: 1.2, materials: 1, steel: 1.5 };
// supply points one cargo unit restores (a full refill of an empty unit is ~5 cargo)
const PTS_PER_CARGO = 20;
export const PRESETS = {
  auto: { name: 'Automatic' },
  infantry: { name: 'Infantry', mix: { food: 0.6, munitions: 0.4 } },
  armored: { name: 'Armored', mix: { fuel: 0.5, munitions: 0.35, steel: 0.15 } },
  fortification: { name: 'Fortification', mix: { materials: 0.4, food: 0.35, munitions: 0.25 } },
  emergency: { name: 'Emergency' },
};
const cargoTotal = (c) => Object.entries(c || {}).reduce((s, [k, v]) => s + v * (CARGO_WEIGHT[k] || 1), 0);
// what a unit eats from cargo when it refills
const needOf = (u) => (UNITS[u.type].move === 'infantry' ? { food: 0.6, munitions: 0.4 } : UNITS[u.type].air ? { fuel: 0.7, munitions: 0.3 } : { fuel: 0.6, munitions: 0.4 });

export function lInit(g) { g.caches = g.caches || new Map(); g.convoySeq = g.convoySeq || 0; }

// refill a unit from a cargo store (truck or cache); returns supply points restored
function refillFrom(store, u, maxPts = 100) {
  const want = Math.min(maxPts, 100 - u.supply); if (want < 1) return 0;
  const need = needOf(u);
  // how many points the store can pay for, given the unit's mix
  let pts = want;
  for (const [k, share] of Object.entries(need)) { const have = store[k] || 0; pts = Math.min(pts, (have / share) * PTS_PER_CARGO); }
  if (pts < 1) {
    // partial: anything the unit can use at all
    for (const k of Object.keys(need)) if ((store[k] || 0) > 0.05) { const p = Math.min(want, store[k] * PTS_PER_CARGO); store[k] -= p / PTS_PER_CARGO; u.supply = Math.min(100, u.supply + p * 0.6); return p * 0.6; }
    return 0;
  }
  for (const [k, share] of Object.entries(need)) store[k] = Math.max(0, (store[k] || 0) - (pts / PTS_PER_CARGO) * share);
  u.supply = Math.min(100, u.supply + pts);
  return pts;
}

// ------------------------------------------------------------------ recipients and sources
export function recipientsOf(g, civ, target) {
  let ids = [];
  if (target.kind === 'formation') ids = g.formations.get(target.id)?.units || [];
  else if (target.kind === 'army') ids = civ.armies?.get(target.id)?.units || [];
  else ids = target.units || [];
  return ids.map((id) => g.units.get(id)).filter((u) => u && u.owner === civ.id && !UNITS[u.type].civilian);
}
function sources(g, civ) {
  const out = [];
  for (const c of g.cities.values()) if (c.owner === civ.id) out.push({ kind: 'city', id: c.id, tile: c.tile, isolated: !!c.isolated });
  for (const b of g.buildings.values()) if (b.owner === civ.id && b.done && b.type === 'depot' && b.state !== 'damaged') out.push({ kind: 'depot', id: b.id, tile: b.tile, isolated: g.cities.get(b.cityId)?.isolated });
  return out;
}
function stockOf(g, civ, src) { if (src.kind === 'city' && src.isolated) return g.cities.get(src.id).stock || {}; return civ.res; }

// the package for this delivery: shortages decide the mix, capacity bounds the amount
function planCargo(g, civ, recips, preset, stock) {
  let mix = PRESETS[preset]?.mix;
  let pts = recips.reduce((s, u) => s + (100 - u.supply), 0);
  if (!mix) {
    const m = {}; for (const u of recips) for (const [k, v] of Object.entries(needOf(u))) m[k] = (m[k] || 0) + v * (100 - u.supply + 10);
    const t = Object.values(m).reduce((a, b) => a + b, 0) || 1; mix = {}; for (const [k, v] of Object.entries(m)) mix[k] = v / t;
    if (preset === 'emergency') { const top = Object.entries(mix).sort((a, b) => b[1] - a[1])[0]; mix = { [top[0]]: 0.7, ...Object.fromEntries(Object.entries(mix).filter(([k]) => k !== top[0]).map(([k, v]) => [k, v * 0.3])) }; }
  }
  const units = Math.min(CARGO_CAP, Math.max(20, (pts / PTS_PER_CARGO) * 1.25 + 10));
  const cargo = {}; let used = 0;
  for (const [k, share] of Object.entries(mix)) {
    const want = (units * share) / (CARGO_WEIGHT[k] || 1);
    const take = Math.floor(Math.min(want, (stock[k] || 0) - 5) * 10) / 10;
    if (take > 0) { cargo[k] = take; used += take * (CARGO_WEIGHT[k] || 1); }
  }
  return used > 0.5 ? cargo : null;
}

// a safe hex behind the force to stop and unload: own side, not enemy-held or contested, reachable
function deliveryPoint(g, civ, recips, truck) {
  const c = centroid(recips.map((u) => u.tile));
  const enemies = [...g.units.values()].filter((e) => g.hostile(civ.id, e.owner) && civ.visible[e.tile] && !UNITS[e.type].civilian);
  let best = -1, bs = -Infinity;
  for (const t of disk(c, 3)) {
    const ter = g.world.terr[t];
    if (isWater(ter) || !Number.isFinite(TERRAIN[ter].move) || hostileGroundAt(g, civ.id, t) || zocAt(g, civ.id, t)) continue;
    const near = enemies.length ? Math.min(...enemies.map((e) => dist(e.tile, t))) : 9;
    const s = Math.min(near, 8) * 1.5 - dist(t, c) * 0.8 - dist(t, truck.tile) * 0.02 + (civ.supply[t] ? 1 : 0);
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

// ------------------------------------------------------------------ dispatch
export function supplyRun(g, civ, target, opts = {}) {
  const recips = recipientsOf(g, civ, target);
  if (!recips.length) return { error: 'no units to supply' };
  const trucks = [...g.units.values()].filter((u) => u.owner === civ.id && u.type === 'supply_truck' && (!u.convoy || u.convoy.state === 'available') && (opts.truck == null || u.id === opts.truck));
  if (!trucks.length) return { error: 'no available supply truck (train one at a motor works or settlement)', train: true };
  const srcs = sources(g, civ);
  if (!srcs.length) return { error: 'no supply source: a city or a depot' };
  const c = centroid(recips.map((u) => u.tile));
  // the best truck/source pair: short trip, and a source that has the goods
  let pick = null;
  for (const tr of trucks) for (const s of srcs) {
    const cargo = planCargo(g, civ, recips, opts.preset || 'auto', stockOf(g, civ, s));
    if (!cargo) continue;
    const d = dist(tr.tile, s.tile) + dist(s.tile, c);
    if (!pick || d < pick.d) pick = { tr, s, cargo, d };
  }
  if (!pick) return { error: 'not enough supplies at any source you can reach (food, fuel or munitions)' };
  const dest = deliveryPoint(g, civ, recips, pick.tr);
  if (dest < 0) return { error: 'no safe unloading position near those units' };
  const probe = findPath(g, civ, pick.s.tile, dest, 'supply_truck', 12000);
  if (dest !== pick.s.tile && (!probe || probe.partial)) return { error: 'route to the front is blocked' };
  const id = ++g.convoySeq;
  pick.tr.convoy = { id, state: 'toSource', src: pick.s, dest, target: { kind: target.kind, id: target.id, units: target.kind === 'units' ? recips.map((u) => u.id) : undefined }, plan: pick.cargo, preset: opts.preset || 'auto', since: g.time, tries: 0, auto: !!opts.auto };
  pick.tr.cargo = pick.tr.cargo || {};
  routeTo(g, civ, pick.tr, pick.s.tile);
  return { reply: { t: 'ack', supplyRun: { id, truck: pick.tr.id, cargo: pick.cargo, dest } } };
}

function routeTo(g, civ, u, tile) {
  u.order = { kind: 'move' }; u.auth = 'logistics'; u.goal = tile; u.slot = tile; u.field = false; u.queue = [];
  u.path = u.tile === tile ? [] : findPath(g, civ, u.tile, tile, u.type) || [];
  return u.tile === tile || u.path.length > 0;
}

export function cancelRun(g, civ, truckId, home = true) {
  const u = g.units.get(truckId);
  if (!u || u.owner !== civ.id || !u.convoy) return { error: 'that truck has no delivery' };
  const src = u.convoy.src;
  u.convoy.state = 'returning'; u.convoy.cancelled = true;
  if (home && src) routeTo(g, civ, u, src.tile);
  return null;
}

// ------------------------------------------------------------------ per second
export function logisticsStep(g, dt) {
  lInit(g);
  for (const u of g.units.values()) {
    if (u.type !== 'supply_truck' || !u.convoy) continue;
    const civ = g.civs[u.owner], cv = u.convoy;
    const arrived = (t) => u.tile === t && !u.path.length;
    if (cv.state === 'toSource') {
      if (arrived(cv.src.tile) || dist(u.tile, cv.src.tile) <= 1 && !u.path.length) { cv.state = 'loading'; cv.loadLeft = 2 + cargoTotal(cv.plan) / 40; }
      else if (!u.path.length && !routeTo(g, civ, u, cv.src.tile)) cv.state = 'blocked';
    } else if (cv.state === 'loading') {
      cv.loadLeft -= dt;
      if (cv.loadLeft <= 0) {
        // goods leave the source exactly once, bounded by what is actually there and by capacity
        const stock = stockOf(g, civ, cv.src);
        let room = CARGO_CAP - cargoTotal(u.cargo);
        for (const [k, v] of Object.entries(cv.plan)) {
          const take = Math.max(0, Math.min(v, stock[k] || 0, room / (CARGO_WEIGHT[k] || 1)));
          stock[k] = (stock[k] || 0) - take; u.cargo[k] = (u.cargo[k] || 0) + take; room -= take * (CARGO_WEIGHT[k] || 1);
          if (stock === civ.res) book(civ, 'convoys', k, -take);    // a transfer out of the stockpile, not consumption
        }
        cv.loaded = cargoTotal(u.cargo);
        if (cv.loaded < 0.5) { cv.state = 'available'; cv.note = 'source had nothing to load'; continue; }
        cv.state = 'outbound';
        if (!routeTo(g, civ, u, cv.dest)) cv.state = 'blocked';
      }
    } else if (cv.state === 'outbound') {
      // keep the destination safe; if it turned hostile, pick another point behind the force
      if (hostileGroundAt(g, civ.id, cv.dest) || zocAt(g, civ.id, cv.dest)) { const r = recipientsOf(g, civ, cv.target); const d = r.length ? deliveryPoint(g, civ, r, u) : -1; if (d >= 0) { cv.dest = d; routeTo(g, civ, u, d); } else { cv.state = 'returning'; cv.note = 'no safe unloading point'; routeTo(g, civ, u, cv.src.tile); } }
      if (arrived(cv.dest)) { cv.state = 'unloading'; cv.unloadLeft = 2 + cargoTotal(u.cargo) / 60; }
      else if (!u.path.length) {
        cv.tries++;
        if (cv.tries > 3 || !routeTo(g, civ, u, cv.dest)) { cv.state = 'returning'; cv.note = 'route blocked'; routeTo(g, civ, u, cv.src.tile); if (civ.human) g.notify(civ.id, 'A supply convoy could not get through and is returning with its cargo.', { kind: 'warning', tile: u.tile, level: 'minor' }); }
      }
    } else if (cv.state === 'unloading') {
      cv.unloadLeft -= dt;
      if (cv.unloadLeft <= 0) { deliver(g, civ, u, cv); cv.state = 'returning'; routeTo(g, civ, u, cv.src.tile); }
    } else if (cv.state === 'returning') {
      if (arrived(cv.src.tile) || (dist(u.tile, cv.src.tile) <= 1 && !u.path.length)) {
        // anything still aboard goes back into the source it came from
        const stock = stockOf(g, civ, cv.src);
        for (const [k, v] of Object.entries(u.cargo || {})) if (v > 0) { stock[k] = (stock[k] || 0) + v; if (stock === civ.res) book(civ, 'convoys', k, v); }
        u.cargo = {};
        u.convoy = { state: 'available', last: cv.id, note: cv.note || 'delivered' };
        u.order = { kind: 'idle' }; u.auth = '';
      } else if (!u.path.length) routeTo(g, civ, u, cv.src.tile);
    } else if (cv.state === 'blocked') {
      if ((cv.tries = (cv.tries || 0) + 1) % 10 === 0) { cv.state = 'returning'; routeTo(g, civ, u, cv.src.tile); }
    }
  }
  // field caches serve friendly units within two hexes until empty; enemy troops on the hex seize them
  for (const [t, c] of [...g.caches]) {
    const civ = g.civs[c.owner];
    const enemy = (g.tileUnits.get(t) || []).map((id) => g.units.get(id)).find((e) => e && g.hostile(c.owner, e.owner) && !UNITS[e.type].air);
    if (enemy) {
      const cap = g.civs[enemy.owner];
      for (const [k, v] of Object.entries(c.cargo)) { cap.res[k] = (cap.res[k] || 0) + v * 0.5; book(cap, 'salvage', k, v * 0.5); }      // half is salvaged, half spoiled
      g.caches.delete(t); if (civ.human) g.notify(c.owner, 'A field supply cache was captured.', { kind: 'loss', tile: t, level: 'minor' }); continue;
    }
    for (const n of disk(t, 2)) for (const id of g.tileUnits.get(n) || []) {
      const u = g.units.get(id); if (!u || u.owner !== c.owner || UNITS[u.type].civilian || civ.supply[u.tile] || u.supply >= 70) continue;
      refillFrom(c.cargo, u, 8 * dt);
    }
    if (cargoTotal(c.cargo) < 0.5 || g.time - c.at > 1200) g.caches.delete(t);
  }
}

// hand out by need (lowest supply and units in combat first); leave the rest as a cache
function deliver(g, civ, u, cv) {
  const recips = recipientsOf(g, civ, cv.target).filter((r) => dist(r.tile, u.tile) <= 4)
    .sort((a, b) => (a.supply - b.supply) - ((g.time - (b.lastCombat ?? -99) < 5 ? 15 : 0) - (g.time - (a.lastCombat ?? -99) < 5 ? 15 : 0)) || a.id - b.id);
  const before = recips.reduce((s, r) => s + r.supply, 0);
  for (const r of recips) refillFrom(u.cargo, r);
  const gained = recips.reduce((s, r) => s + r.supply, 0) - before;
  const left = cargoTotal(u.cargo);
  if (left >= 3) {
    const c = g.caches.get(cv.dest) || { owner: civ.id, cargo: {}, at: g.time };
    for (const [k, v] of Object.entries(u.cargo)) c.cargo[k] = (c.cargo[k] || 0) + v;
    c.at = g.time; g.caches.set(cv.dest, c); u.cargo = {};
  }
  const full = recips.every((r) => r.supply >= 95);
  cv.note = recips.length ? `${full ? 'resupplied' : 'partly resupplied'} ${recips.length} unit${recips.length > 1 ? 's' : ''} (+${Math.round(gained)} supply)${left >= 3 ? ', rest left as a field cache' : ''}` : 'no units in reach: left a field cache';
  if (civ.human && !cv.auto) g.notify(civ.id, `Supply convoy ${cv.note}.`, { kind: 'unit', tile: u.tile, level: 'info' });
}

// automatic resupply policies (players and AI alike)
export function policyStep(g) {
  for (const civ of g.civs) {
    if (!civ.alive || !civ.logPolicies) continue;
    for (const [key, p] of civ.logPolicies) {
      if (!p.auto) continue;
      const target = { kind: key[0] === 'f' ? 'formation' : 'army', id: +key.slice(2) };
      const r = recipientsOf(g, civ, target);
      if (!r.length) { civ.logPolicies.delete(key); continue; }
      const avg = r.reduce((s, u) => s + u.supply, 0) / r.length;
      if (avg >= (p.threshold || 40)) { p.note = ''; continue; }
      // one delivery at a time per force; a nearby cache with cargo counts as covered
      const enroute = [...g.units.values()].some((t) => t.owner === civ.id && t.convoy && t.convoy.state !== 'available' && t.convoy.target?.kind === target.kind && t.convoy.target?.id === target.id);
      if (enroute) continue;
      const c = centroid(r.map((u) => u.tile));
      if ([...g.caches].some(([t, k]) => k.owner === civ.id && dist(t, c) <= 3 && cargoTotal(k.cargo) > 15)) continue;
      if (g.time < (p.retryAt || 0)) continue;
      const res = supplyRun(g, civ, target, { preset: p.preset || 'auto', auto: true });
      if (res.error) { p.note = res.error; p.retryAt = g.time + 30; } else p.note = 'delivery dispatched';
    }
  }
}

export function convoysFor(g, civ) {
  const out = [];
  for (const u of g.units.values()) if (u.owner === civ.id && u.type === 'supply_truck') {
    const cv = u.convoy || { state: 'available' };
    const eta = u.path.length ? Math.round(u.path.length * 1.1) : 0;
    out.push({ truck: u.id, state: cv.state, dest: cv.state === 'outbound' || cv.state === 'unloading' ? cv.dest : -1, cargo: Math.round(cargoTotal(u.cargo)), target: cv.target ? `${cv.target.kind}:${cv.target.id ?? ''}` : '', note: cv.note || '', eta: cv.state === 'outbound' && u.path.length ? eta : null });
  }
  return out;
}
export function cachesFor(g, civ) { const out = []; lInit(g); for (const [t, c] of g.caches) if (c.owner === civ.id) out.push({ t, cargo: Math.round(cargoTotal(c.cargo)) }); return out; }
export { cargoTotal };
