// Air operations. One order runs a whole mission: the aircraft launches, flies out, patrols /
// strikes / supports / scouts, turns for home when fuel (by distance), ammunition or damage says so,
// lands (or holds, or diverts), is serviced from real stock, and relaunches while the mission stands.
//
//   ready -> launching -> outbound -> mission -> returning -> landing -> servicing -> ready
//   exceptional: holding (waiting for a slot, burning fuel), awaiting (no fuel/munitions at base),
//                diverting (base lost or full), lost (out of fuel: crash)
//
// Missions: patrol (fighters, helicopters), strike (any armed aircraft; one-way drones are consumed),
// support (helicopters and swarms over a friendly army), scout (recon drones), return.
// Everything here is authoritative; the client only smooths positions between server ticks.
import { UNITS, BUILDINGS, N } from './constants.js';
import { disk, dist, hexLine } from './hex.js';
import { isBase, compatible, nearestBase, occupancy, baseSlots, beginService, finishService, baseLost, baseSummary } from './airfields.js';

export const AIR_STATES = ['ready', 'launching', 'outbound', 'mission', 'returning', 'landing', 'holding', 'servicing', 'awaiting', 'diverting'];
export const MISSIONS = ['patrol', 'strike', 'support', 'scout', 'return'];
const GROUNDED = new Set(['ready', 'servicing', 'awaiting', 'landing', 'launching']);
const RESERVE = 6;                 // seconds of fuel kept in hand on the way home

// which missions an aircraft can fly
export function canFly(type, kind) {
  const r = UNITS[type].role;
  if (kind === 'return') return true;
  if (r === 'recon') return kind === 'scout' || kind === 'patrol';
  if (r === 'oneway') return kind === 'strike';
  if (r === 'bomber') return kind === 'strike';
  if (r === 'fighter') return kind === 'patrol' || kind === 'strike';
  if (r === 'strike') return kind === 'strike' || kind === 'support';
  return kind === 'patrol' || kind === 'strike' || kind === 'support';    // helicopters
}

export function initAircraft(g, u, baseId) {
  const d = UNITS[u.type];
  u.air = { home: baseId ?? -1, state: 'ready', fuel: d.fuel, ammo: d.ammo, mission: null, svcLeft: 0, note: '' };
  u.grounded = true; u.stance = 'passive';
  if (u.air.home < 0) { const b = nearestBase(g, u); if (b) u.air.home = b.id; }
  const b = g.buildings.get(u.air.home);
  if (b) u.tile = b.tile;
  else if (!g.sandbox) { u.air.state = 'diverting'; u.grounded = false; }   // spawned away from any base: it must find one
}

const speedOf = (u) => UNITS[u.type].speed;
// seconds of flight to a tile
const flightTime = (u, from, to) => dist(from, to) / speedOf(u);

// a ring of hexes at radius r around c, walked by adjacency, starting nearest to `from`
function ring(c, r, from) {
  const pts = disk(c, r).filter((t) => dist(t, c) === r);
  if (!pts.length) return [c];
  const out = [], left = new Set(pts);
  let cur = pts.reduce((b, t) => (dist(t, from) < dist(b, from) ? t : b), pts[0]);
  while (left.size) { out.push(cur); left.delete(cur); let nx = null, nd = Infinity; for (const t of left) { const d = dist(cur, t); if (d < nd) { nd = d; nx = t; } } if (nx == null) break; cur = nx; }
  return out;
}
function routeTo(u, to) { u.path = u.tile === to ? [] : hexLine(u.tile, to).slice(1); u.field = false; u.goal = to; u.slot = to; }

function targetTile(g, m) {
  if (!m.target) return m.tile;
  if (m.target.kind === 'unit') { const t = g.units.get(m.target.id); return t ? t.tile : -1; }
  if (m.target.kind === 'building') { const b = g.buildings.get(m.target.id); return b ? b.tile : -1; }
  return m.tile;
}

// ------------------------------------------------------------------ orders
// Assign a mission to aircraft (validated). Returns { assigned, refused: [[id, reason]] }.
export function airMission(g, civ, ids, mission, auth = 'player') {
  const kind = mission.kind;
  if (!MISSIONS.includes(kind)) return { error: 'unknown mission' };
  const out = { assigned: 0, refused: [] };
  for (const id of ids) {
    const u = g.units.get(id);
    if (!u || u.owner !== civ.id || !UNITS[u.type].air) continue;
    if (!u.air) initAircraft(g, u, -1);
    if (!canFly(u.type, kind)) { out.refused.push([id, `${UNITS[u.type].name} cannot fly ${kind} missions`]); continue; }
    if (kind === 'return') { u.air.mission = { kind: 'return' }; if (!GROUNDED.has(u.air.state)) setReturning(g, u); out.assigned++; continue; }
    const tt = mission.target ? targetTile(g, mission) : mission.tile;
    if (!(tt >= 0 && tt < N)) { out.refused.push([id, 'no target']); continue; }
    // never launch (or re-task) an aircraft that cannot complete the mission and get home
    const home = g.buildings.get(u.air.home);
    const back = home ? flightTime(u, tt, home.tile) : 0;
    const need = flightTime(u, u.tile, tt) + back + RESERVE + (kind === 'strike' ? 4 : 12);
    const fuel = GROUNDED.has(u.air.state) && u.air.state !== 'launching' ? UNITS[u.type].fuel : u.air.fuel;
    if (!UNITS[u.type].oneWay && need > fuel) { out.refused.push([id, `out of range (needs ${Math.ceil(need)}s of fuel, has ${Math.floor(fuel)}s)`]); continue; }
    if (UNITS[u.type].oneWay && flightTime(u, u.tile, tt) + 2 > fuel) { out.refused.push([id, 'beyond its range']); continue; }
    if (kind === 'strike' && UNITS[u.type].ammo && u.air.ammo <= 0 && !GROUNDED.has(u.air.state)) { out.refused.push([id, 'no ammunition left: it must rearm first']); continue; }
    u.air.mission = { kind, tile: tt, target: mission.target || null, radius: Math.max(1, Math.min(6, mission.radius || (kind === 'scout' ? 2 : kind === 'support' ? 2 : 3))), army: mission.army || 0, repeat: mission.repeat !== false && kind !== 'strike' ? true : !!mission.repeat, auth, since: g.time, passes: 0 };
    u.auth = auth;
    if (GROUNDED.has(u.air.state)) { if (u.air.state === 'ready') launch(g, u); }
    else { u.air.state = 'outbound'; routeTo(u, tt); u.order = { kind: 'idle' }; }
    out.assigned++;
  }
  return out;
}

function launch(g, u) {
  u.air.state = 'launching'; u.air.at = g.time + (g.civs[u.owner].techs.has('air_operations') ? 1 : 1.5);
}
function setReturning(g, u) {
  let b = g.buildings.get(u.air.home);
  if (!isBase(b) || b.owner !== u.owner) { b = nearestBase(g, u, { reach: (u.air.fuel - 2) * speedOf(u) }); u.air.home = b ? b.id : -1; }
  if (!b) { u.air.state = 'diverting'; u.air.note = 'no airfield in reach'; return; }
  u.air.state = 'returning'; routeTo(u, b.tile); u.order = { kind: 'idle' }; u.stance = 'passive';
}

// Choose suitable ready aircraft for a mission ordered from a base (or anywhere).
//   air target -> fighters; armour -> helicopters / strike swarms; a concentration -> bombers;
//   unknown region -> recon; a precise expendable strike -> one-way drones
export function autoSelect(g, civ, mission, { base = null, max = 4, prefer = null } = {}) {
  const tt = mission.target ? targetTile(g, mission) : mission.tile;
  const tgtUnit = mission.target?.kind === 'unit' ? g.units.get(mission.target.id) : null;
  const tdef = tgtUnit ? UNITS[tgtUnit.type] : null;
  let order;
  if (mission.kind === 'scout') order = ['recon_drone'];
  else if (mission.kind === 'patrol') order = tdef?.air ? ['fighter', 'helicopter'] : ['fighter', 'helicopter', 'recon_drone'];
  else if (mission.kind === 'support') order = ['helicopter', 'strike_swarm'];
  else if (tdef?.air) order = ['fighter'];
  else if (prefer === 'oneway') order = ['oneway_drone'];
  else if (tdef && (tdef.cat === 'tracked' || tdef.cat === 'wheeled')) order = ['helicopter', 'strike_swarm', 'bomber', 'oneway_drone'];
  else {
    // a concentration of troops or a structure: bombers first
    let n = 0; if (tt >= 0) for (const t of disk(tt, 1)) for (const id of g.tileUnits.get(t) || []) { const e = g.units.get(id); if (e && g.hostile(civ.id, e.owner)) n++; }
    order = n >= 3 || mission.target?.kind === 'building' ? ['bomber', 'strike_swarm', 'helicopter', 'oneway_drone'] : ['helicopter', 'strike_swarm', 'bomber', 'oneway_drone'];
  }
  const pool = [...g.units.values()].filter((u) => u.owner === civ.id && u.air && u.air.state === 'ready' && (!base || u.air.home === base.id) && canFly(u.type, mission.kind));
  const picked = [];
  for (const type of order) {
    for (const u of pool.filter((x) => x.type === type).sort((a, b) => (tt >= 0 ? dist(a.tile, tt) - dist(b.tile, tt) : 0) || a.id - b.id)) {
      if (picked.length >= max) break;
      const home = g.buildings.get(u.air.home);
      const need = (home ? flightTime(u, home.tile, tt) * 2 : 0) + RESERVE;
      if (!UNITS[u.type].oneWay && need > UNITS[u.type].fuel) continue;
      picked.push(u.id);
      if (type === 'oneway_drone' && picked.length >= 1 && mission.kind === 'strike' && prefer !== 'oneway') break;
    }
    if (picked.length) break;
  }
  return picked;
}

// ------------------------------------------------------------------ simulation
export function airStep(g, dt) {
  for (const u of [...g.units.values()]) {
    const d = UNITS[u.type]; if (!d.air) continue;
    if (!u.air) initAircraft(g, u, -1);
    const a = u.air, m = a.mission;
    const home = g.buildings.get(a.home);
    const homeOk = isBase(home) && home.owner === u.owner;
    u.grounded = GROUNDED.has(a.state) && (homeOk || !g.sandbox);
    // the developer combat sandbox has no logistics: aircraft there neither need bases nor burn fuel
    if (g.sandbox && !homeOk) { if (a.state === 'ready' && m && m.kind !== 'return') { a.state = 'outbound'; u.grounded = false; } a.fuel = d.fuel; if (d.ammo && a.ammo <= 0) a.ammo = d.ammo; if (a.state === 'returning' || a.state === 'diverting' || a.state === 'launching') a.state = m && m.kind !== 'return' ? 'outbound' : 'ready'; }
    if (!u.grounded) {
      a.fuel -= dt;
      if (a.fuel <= 0) { crash(g, u); continue; }
    }
    u.supply = Math.round((100 * Math.max(0, a.fuel)) / d.fuel);   // shown as the aircraft's fuel
    switch (a.state) {
      case 'ready': {
        u.order = { kind: 'idle' }; u.path = [];
        if (homeOk && u.tile !== home.tile) u.tile = home.tile;
        if (m && m.kind !== 'return' && !m.suspended) launch(g, u);
        break;
      }
      case 'launching':
        if (!homeOk) { a.state = 'diverting'; break; }
        if (g.time >= a.at) { if (!m || m.kind === 'return' || m.suspended) { a.state = 'ready'; break; } a.state = 'outbound'; u.grounded = false; routeTo(u, targetTile(g, m) >= 0 ? targetTile(g, m) : m.tile); }
        break;
      case 'outbound': case 'mission': {
        if (!m || m.kind === 'return') { setReturning(g, u); break; }
        // turn for home when the fuel to get back (plus a reserve) is all that is left, when the
        // magazines are empty, or when badly damaged; one-way drones never come back
        const back = homeOk ? flightTime(u, u.tile, home.tile) : 0;
        if (!d.oneWay && (a.fuel <= back + RESERVE || (d.ammo && a.ammo <= 0 && m.kind !== 'scout') || u.hp < u.maxHp * 0.35)) {
          a.note = a.fuel <= back + RESERVE ? 'fuel' : a.ammo <= 0 ? 'out of ammunition' : 'damaged';
          setReturning(g, u); break;
        }
        flyMission(g, u, m, dt);
        break;
      }
      case 'returning': case 'diverting': {
        if (!homeOk) {
          const nb = nearestBase(g, u, { reach: (a.fuel - 1) * speedOf(u) });
          if (nb) { a.home = nb.id; a.state = 'returning'; routeTo(u, nb.tile); }
          else if (a.state !== 'diverting' || !u.path.length) { a.state = 'diverting'; a.note = 'no airfield in reach'; if (!a.warned && g.civs[u.owner].human) { a.warned = true; g.notify(u.owner, `${d.name} has no airfield in reach and will be lost when its fuel runs out.`, { kind: 'warning', tile: u.tile, level: 'major' }); } const c = nearestCity(g, u); if (c >= 0 && !u.path.length) routeTo(u, c); }
          break;
        }
        if (u.tile !== home.tile && !u.path.length) routeTo(u, home.tile);
        if (u.tile === home.tile) {
          if (occupancy(g, home) < baseSlots(g, home)) { a.state = 'landing'; a.at = g.time + 1; u.path = []; }
          else { a.state = 'holding'; a.holdSince = g.time; }
        }
        break;
      }
      case 'holding': {
        // a bounded landing queue: orbit the base, land in arrival order, divert before it is too late
        if (!homeOk) { a.state = 'diverting'; break; }
        const queue = [...g.units.values()].filter((o) => o.air && o.air.home === home.id && o.air.state === 'holding').sort((x, y) => x.air.holdSince - y.air.holdSince || x.id - y.id);
        if (occupancy(g, home) < baseSlots(g, home) && queue[0] === u) { u.path = []; u.tile = home.tile; a.state = 'landing'; a.at = g.time + 1; break; }
        if (a.fuel < RESERVE + 4 || g.time - a.holdSince > 40) {
          const alt = nearestBase(g, u, { reach: (a.fuel - 1) * speedOf(u), free: true, exclude: home.id });
          if (alt) { a.home = alt.id; a.state = 'returning'; routeTo(u, alt.tile); a.note = 'diverted: base full'; break; }
        }
        if (!u.path.length) u.path = ring(home.tile, 1, u.tile).concat([home.tile]).slice(0, 7).filter((t) => t !== u.tile);
        break;
      }
      case 'landing':
        if (!homeOk) { a.state = 'diverting'; break; }
        u.path = []; u.tile = home.tile;
        if (g.time >= a.at) beginService(g, u, home);
        break;
      case 'awaiting':
        if (!homeOk) { a.state = 'diverting'; break; }
        beginService(g, u, home);
        break;
      case 'servicing':
        if (!homeOk) { a.state = 'diverting'; break; }
        a.svcLeft -= dt;
        if (a.svcLeft <= 0) {
          finishService(g, u);
          // the mission continues after servicing (patrols, support, scouting, repeated strikes)
          if (m && m.kind !== 'return' && !m.suspended && (m.repeat || m.kind === 'patrol' || m.kind === 'support' || m.kind === 'scout') && targetTile(g, m) >= 0) launch(g, u);
          else if (m && m.kind === 'strike' && !m.repeat) u.air.mission = null;
        }
        break;
      default: a.state = 'ready';
    }
  }
}

function nearestCity(g, u) { let best = -1, bd = Infinity; for (const c of g.cities.values()) if (c.owner === u.owner) { const d2 = dist(c.tile, u.tile); if (d2 < bd) { bd = d2; best = c.tile; } } return best; }

function crash(g, u) {
  const d = UNITS[u.type];
  if (g.civs[u.owner]?.human) g.notify(u.owner, `${d.name} ran out of fuel and was lost.`, { kind: 'loss', tile: u.tile, level: 'minor' });
  g.damageUnit(u, u.hp + 1, null, 'fuel');
}

function flyMission(g, u, m, dt) {
  const d = UNITS[u.type], a = u.air;
  const tt = targetTile(g, m);
  if (tt < 0) { a.mission = { kind: 'return', done: true }; setReturning(g, u); return; }     // target destroyed or gone: complete
  const center = m.kind === 'support' && m.army ? armyCenter(g, u.owner, m.army) ?? m.tile : tt;
  const inArea = dist(u.tile, center) <= m.radius + 1;
  if (a.state === 'outbound' && inArea) a.state = 'mission';
  if (a.state === 'outbound') { if (!u.path.length || u.goal !== center) routeTo(u, center); return; }
  switch (m.kind) {
    case 'patrol': case 'scout': case 'support': {
      // engagement bounded by the assigned area: no chasing distant enemies
      u.stance = d.role === 'recon' ? 'passive' : 'aggressive';
      if (u.order.kind === 'attack') {
        const tg = u.order.target, tu = tg.kind === 'unit' ? g.units.get(tg.id) : null;
        const tile = tu ? tu.tile : g.buildings.get(tg.id)?.tile ?? -1;
        const ground = tu ? !UNITS[tu.type].air : true;
        if (tile < 0 || dist(tile, center) > m.radius + (m.kind === 'support' ? 2 : 4) || (d.role === 'fighter' && ground)) { u.order = { kind: 'idle' }; u.path = []; }
        else return;     // engaging: the combat system flies the attack
      }
      // fighters on patrol intercept detected aircraft inside the sector; helicopters on support
      // hit ground threats near the army they cover
      const threat = sectorThreat(g, u, center, m.radius + (d.role === 'fighter' ? 3 : 1), d.role === 'fighter' ? 'air' : m.kind === 'support' ? 'ground' : 'any');
      if (threat && d.atk > 0 && (a.ammo > 0 || !d.ammo)) { u.order = { kind: 'attack', target: threat, resume: undefined }; u.repathAt = 0; return; }
      if (!u.path.length) u.path = ring(center, m.radius, u.tile).filter((t) => t !== u.tile);
      break;
    }
    case 'strike': {
      u.stance = 'passive';
      if (d.oneWay) {
        // one-way drones dive into the target and are consumed by the impact
        if (dist(u.tile, tt) <= 0 || (dist(u.tile, tt) <= 1 && u.prog > 0.5)) { detonate(g, u, tt); return; }
        if (!u.path.length || u.goal !== tt) routeTo(u, tt);
        return;
      }
      const tg = m.target && m.target.kind !== 'tile' ? m.target : pickAreaTarget(g, u, tt);
      if (!tg) { a.mission = { kind: 'return', done: true }; setReturning(g, u); return; }
      if (d.role === 'bomber') {
        // bombing passes: release over the target, overfly, come round again
        if (dist(u.tile, tt) <= d.range && u.cooldown <= 0 && a.ammo > 0) {
          g.fireForAir(u, tg, tt); m.passes++;
          const beyond = overfly(u, tt); u.path = hexLine(u.tile, beyond).slice(1); u.goal = beyond;
        } else if (!u.path.length) routeTo(u, tt);
        return;
      }
      // helicopters, swarms and fighters on a strike: the combat system handles the attack run
      if (u.order.kind !== 'attack') { u.order = { kind: 'attack', target: tg, resume: undefined }; u.repathAt = 0; }
      break;
    }
    default: break;
  }
  void dt;
}

// three hexes past the target along the line of the run, for the next pass
function overfly(u, tt) {
  const line = hexLine(u.tile, tt);
  let prev = line.length > 1 ? line[line.length - 2] : u.tile, cur = tt;
  for (let i = 0; i < 3; i++) { const n = mirror(prev, cur); if (n === cur) break; prev = cur; cur = n; }
  return cur;
}
// the neighbour of b on the far side from a
function mirror(a, b) {
  let best = b, bd = -1;
  for (const n of disk(b, 1)) { if (n === b) continue; const d = dist(n, a); if (d > bd) { bd = d; best = n; } }
  return best;
}

function pickAreaTarget(g, u, tt) {
  let best = null, bs = -1;
  for (const t of disk(tt, 1)) {
    for (const id of g.tileUnits.get(t) || []) { const e = g.units.get(id); if (e && g.hostile(u.owner, e.owner) && !UNITS[e.type].air && g.civs[u.owner].visible[t]) { const s = (t === tt ? 2 : 1) + (g.tileUnits.get(t)?.length || 0) * 0.3; if (s > bs) { bs = s; best = { kind: 'unit', id }; } } }
    const b = g.buildingAtTile(t); if (b && g.hostile(u.owner, b.owner)) { const s = t === tt ? 2.5 : 0.8; if (s > bs) { bs = s; best = { kind: 'building', id: b.id }; } }
  }
  return best;
}

function sectorThreat(g, u, center, radius, kind) {
  const civ = g.civs[u.owner];
  let best = null, bd = Infinity;
  for (const t of disk(center, radius)) {
    if (!civ.visible[t]) continue;
    for (const id of g.tileUnits.get(t) || []) {
      const e = g.units.get(id); if (!e || !g.hostile(u.owner, e.owner) || e.grounded || !g.detects(u.owner, e)) continue;
      const ed = UNITS[e.type];
      if (kind === 'air' && !ed.air) continue;
      if (kind === 'ground' && ed.air) continue;
      if (!g.canHitUnit(u, e)) continue;
      const dd = dist(u.tile, t) - (ed.air ? 2 : 0);
      if (dd < bd) { bd = dd; best = { kind: 'unit', id }; }
    }
  }
  return best;
}

function armyCenter(g, civId, armyId) {
  const army = g.civs[civId].armies?.get(armyId); if (!army) return null;
  const us = army.units.map((id) => g.units.get(id)).filter(Boolean); if (!us.length) return null;
  return us[Math.floor(us.length / 2)].tile;
}

function detonate(g, u, tt) {
  g.detonateForAir(u, tt);
  g.units.delete(u.id);     // consumed by the strike (not a combat loss)
}

// aircraft newly built at a base start there, ready
export function onAircraftBuilt(g, u, b) { initAircraft(g, u, b && BUILDINGS[b.type].airbase && compatible(b, u.type) ? b.id : -1); }
export function onBuildingLost(g, b) { if (BUILDINGS[b.type].airbase) baseLost(g, b); }

// for the economy/military snapshot
export function airSnapshot(g, civ) {
  const bases = []; for (const b of g.buildings.values()) if (b.owner === civ.id && isBase(b)) bases.push(baseSummary(g, b));
  const craft = [];
  for (const u of g.units.values()) if (u.owner === civ.id && u.air) craft.push({ id: u.id, type: u.type, state: u.air.state, fuel: Math.round((100 * Math.max(0, u.air.fuel)) / UNITS[u.type].fuel), ammo: u.air.ammo, ammoMax: UNITS[u.type].ammo, mission: u.air.mission ? { kind: u.air.mission.kind, tile: u.air.mission.tile ?? -1, radius: u.air.mission.radius || 0, suspended: !!u.air.mission.suspended } : null, home: u.air.home, svc: u.air.state === 'servicing' ? Math.round(100 * (1 - u.air.svcLeft / Math.max(1, u.air.svcTotal || 1))) : null, note: u.air.note || '' });
  return { bases, craft };
}
export const stateCode = (s) => AIR_STATES.indexOf(s);
