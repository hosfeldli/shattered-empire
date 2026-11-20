// Action-RTS air operations (workstream D, 2026-11-16):
//  - pseudo fuel: every aircraft type has an endurance in seconds of flight (ACTION_UNITS[type].fuel). Airborne
//    aircraft burn one second per second; at "bingo" (the fuel to fly home plus a reserve) they return to the
//    nearest friendly airfield or headquarters on their own, refuel there and resume the mission or patrol.
//    Never strict: nothing explodes. An aircraft that runs dry limps on at minimum speed and cannot attack,
//    still heading for a base.
//  - patrol routes: {c:'patrol', units, points:[{x,z},...]} flies a looping circuit through the waypoints;
//    waypoints beyond the fuel range of every base are clamped toward the nearest base, with feedback.
//  - flight paths: fixed-wing aircraft never hover. They fly wide racetrack orbits on station and strafing
//    passes over attack targets; helicopters and drones fly a loose circuit around their point.
//  - flak airbursts: AA rounds report the burst positions at altitude in a 'flak' event; upgraded city
//    defenses give a headquarters built-in AA fire.
import { DT } from './constants.js';
import { ACTION_UNITS } from './actionDefinitions.js';
import { WEAPON_KEYS, WEAPONS } from './weapons.js';
import { distance, dxBetween, tileAt, wrapX } from './actionNavigation.js';
import { moveGroup } from './actionOrders.js';
import { cityAA } from './actionBases.js';
import { emit } from './combat.js';

export const AIR = {
  reserve: 6,          // seconds of fuel kept in hand on the way home
  refuelTime: 10,      // seconds on the ground from empty to full
  dryPace: .35,        // share of top speed left once the tank is dry
  rangeShare: .32,     // a patrol waypoint must lie within speed x endurance x this of a refuelling base
  maxWaypoints: 8,
};
export const AIR_MISSIONS = ['patrol', 'route', 'intercept', 'scout', 'support', 'strike', 'return', 'orbit', 'gun_run'];
// Weather and relief for aircraft (§31, W3 2026-11-17). All checks are O(1) per airborne aircraft per tick
// (one weather-cell lookup and one elevation read at its own hex):
//  - storm cells (weather.stormAt >= storm): aircraft do not take off from, or land at, a base under a storm
//    (they wait on the pad, or divert to another base); aircraft flying inside a storm are slowed (stormPace of
//    top speed) and burn fuel stormBurn times as fast.
//  - high relief: low-flying aircraft (helicopters, drones: alt !== 'high') crossing hexes above `ridge` elevation
//    climb over them, slowed to ridgePace and burning ridgeBurn fuel; they cannot hold a patrol or station
//    waypoint over such peaks (the command is refused with feedback).
export const AIR_WEATHER = { storm: .5, stormPace: .6, stormBurn: 1.6, ridge: .66, ridgePace: .7, ridgeBurn: 1.3 };
const stormAt = (game, t) => t >= 0 && game.weather ? game.weather.stormAt(t) : 0;
export const stormy = (game, t) => stormAt(game, t) >= AIR_WEATHER.storm;
const lowFlyer = (d) => d.air && d.alt !== 'high';
/** Whether a low-flying aircraft can hold station over this point (not above the ridge line). */
export function overRidge(game, d, p) {
  const t = tileAt(wrapX(p.x), p.z);
  return lowFlyer(d) && t >= 0 && game.world.elev[t] > AIR_WEATHER.ridge;
}
/**
 * Whether an air order to `p` is possible for this aircraft type, with a reason when it is not or a warning
 * when it is but the weather is bad. {ok, error?, note?}. Used by patrolCommand; other commands may call it too.
 */
export function airAccess(game, d, p) {
  if (overRidge(game, d, p)) return { ok: false, error: `${d.name} cannot hold station over high mountains.` };
  const t = tileAt(wrapX(p.x), p.z);
  if (stormy(game, t)) return { ok: true, note: 'A storm covers that area: aircraft there fly slower and burn more fuel.' };
  return { ok: true };
}
// The state code in the unit snapshot's air array (own aircraft; other viewers see 0 grounded / 2 airborne).
export const AIR_STATE = { grounded: 0, refuelling: 1, airborne: 2, returning: 3, dry: 4 };
// Built-in AA of a headquarters whose city defenses were upgraded (the trigger is set by workstream B).
export const CITY_AA = { weapon: 'airburst', range: 4.6, attack: 15, cooldown: 1.8 };

const TAU = Math.PI * 2;
const FIXED_WING = new Set(['fighter', 'bomber']);
const hash = (a, b, c = 0) => {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// (2026-11-19: the Aircraft Systems troop upgrade, drop tanks with +50% endurance and twice-as-fast refuelling, was removed.)
/** Full tank of this aircraft in seconds of flight. */
export const maxFuel = (game, u) => ACTION_UNITS[u.type]?.fuel || 0;
export const fuelOf = (u, game = null) => u.fuel ?? maxFuel(game, u);
export function airSpeed(game, u) { return ACTION_UNITS[u.type].speed; }
/** How far from a refuelling base this aircraft may patrol (map units). */
export function patrolRange(game, u) { return airSpeed(game, u) * maxFuel(game, u) * AIR.rangeShare; }

function refuels(b, u) {
  if (b.owner !== u.owner || !b.done || b.hp <= 0) return false;
  return b.type === 'airfield' || b.type === 'town' || b.type === 'advanced_lab' && (u.type.includes('drone') || u.type === 'strike_swarm');
}

/** The nearest friendly airfield, drone lab or headquarters to `from` (airfields are preferred by 1.5 units). */
export function nearestRefuel(game, u, from = u) {
  let best = null, score = Infinity;
  for (const b of game.buildings.values()) {
    if (!refuels(b, u)) continue;
    // a base under a storm cannot take landings (§31): it is only the choice when every base is storm-bound
    const s = distance(from, b) + (b.type === 'airfield' ? 0 : 1.5) + (stormy(game, b.tile) ? 1e4 : 0);
    if (s < score || s === score && b.id < best.id) { score = s; best = b; }
  }
  return best;
}

function landingPoint(game, u, b) {
  const d = ACTION_UNITS[u.type], a = u.id * 2.39996;
  const r = b.type === 'airfield' ? .18 + (u.id % 3) * .09 : (b.radius || .5) + .45;
  const ox = b.type === 'airfield' ? .32 : 0, oz = b.type === 'airfield' ? .27 : 0;
  return game.nav.nearest({ x: wrapX(b.x + ox + Math.sin(a) * r), z: b.z + oz + Math.cos(a) * r }, d, 2);
}

/** What to resume after refuelling: the current mission, the attack target, or the station it was flying. */
function resumeOf(game, u) {
  const o = u.airOrder;
  if (o?.kind === 'return') return o.resume || null;
  if (o) return { ...o, point: o.point && { ...o.point }, route: o.route?.map((p) => ({ ...p })), leg: 0, axis: undefined };
  const target = u.attack && (game.units.get(u.attack) || game.buildings.get(u.attack));
  if (target?.hp > 0) return { kind: 'attack', target: target.id, point: { x: target.x, z: target.z } };
  const goal = u.goal ? u.path?.[u.path.length - 1] || u.goal : null;
  return { kind: 'orbit', point: goal ? { x: goal.x, z: goal.z } : { x: u.x, z: u.z } };
}

/**
 * Send an aircraft to the nearest refuelling base. `resume` (optional) is relaunched once it is full again.
 * With no base at all it keeps orbiting where it is. Returns whether it is now heading home.
 */
export function returnToBase(game, u, resume = null) {
  const b = nearestRefuel(game, u);
  if (!b) {
    if (!u.airOrder || u.airOrder.kind === 'return') u.airOrder = { kind: 'orbit', point: { x: u.x, z: u.z }, phase: 0 };
    return false;
  }
  const point = landingPoint(game, u, b);
  if (!point) return false;
  const result = moveGroup(game, [u], point, { mode: 'move' });
  if (result.error) return false;
  u.airOrder = { kind: 'return', point, base: b.id, resume };
  u.airBase = b.id;
  return true;
}

function relaunch(game, u, base) {
  const r = u.airResume;
  u.airResume = null;
  const target = r.kind === 'attack' ? game.units.get(r.target) || game.buildings.get(r.target) : null;
  const point = r.kind === 'route' ? r.route[0] : target?.hp > 0 ? target : r.point || base;
  if (!point) return;
  const result = moveGroup(game, [u], { x: point.x, z: point.z }, { mode: 'assault' });
  if (result.error) return;
  if (r.kind === 'attack') { if (target?.hp > 0) u.attack = target.id; else u.airOrder = { kind: 'orbit', point: { x: point.x, z: point.z }, phase: 0 }; }
  else u.airOrder = { ...r, phase: 0, leg: 0 };
}

// ------------------------------------------------------------------ flight paths
function onMap(game, d, p) {
  if (tileAt(wrapX(p.x), p.z) >= 0) return { x: wrapX(p.x), z: p.z };
  return game.nav.nearest(p, d, 3);
}

/** Rotate a closed loop so the aircraft carries on from the point ahead of it instead of turning back. */
function fromNearest(u, loop) {
  if (!loop.length) return loop;
  const fx = Math.sin(u.yaw || 0), fz = Math.cos(u.yaw || 0);
  let best = 0, score = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const dx = dxBetween(u.x, loop[i].x), dz = loop[i].z - u.z, l = Math.hypot(dx, dz);
    const s = l - (l > 1e-6 ? (dx * fx + dz * fz) / l : 0) * .9;
    if (s < score) { score = s; best = i; }
  }
  return [...loop.slice(best), ...loop.slice(0, best)];
}

/** A racetrack (stadium) orbit: two straight legs of 2*half joined by turns of `radius`. */
export function racetrack(center, axis, half, radius) {
  const ax = Math.sin(axis), az = Math.cos(axis), px = az, pz = -ax, pts = [];
  const leg = (s, sign) => { for (let k = 0; k <= 2; k++) { const t = (k / 2 * 2 - 1) * half * s; pts.push({ x: center.x + ax * t + px * radius * sign, z: center.z + az * t + pz * radius * sign }); } };
  // a half turn around the `end` (+1 / -1) of the track, from the +perp side (end +1) or the -perp side (end -1)
  const turn = (end) => {
    for (let k = 1; k <= 4; k++) {
      const a = k / 5 * Math.PI, along = end * (half + radius * Math.sin(a)), across = end * radius * Math.cos(a);
      pts.push({ x: center.x + ax * along + px * across, z: center.z + az * along + pz * across });
    }
  };
  leg(1, 1); turn(1); leg(-1, -1); turn(-1);
  return pts;
}

/** A loose circuit: a ring of points with some radial jitter, so helicopters and drones never hold one spot. */
export function circuit(center, radius, seed, n = 8) {
  const pts = [], start = hash(seed, 7) * TAU;
  for (let k = 0; k < n; k++) {
    const a = start + k / n * TAU, r = radius * (.82 + hash(seed, k, 3) * .36);
    pts.push({ x: center.x + Math.sin(a) * r, z: center.z + Math.cos(a) * r });
  }
  return pts;
}

const ORBIT = {
  fighter: { half: 3.2, radius: 1.6 },
  bomber: { half: 3.6, radius: 2.0 },
};
const CIRCUIT = { helicopter: 2.2, recon_drone: 2.2, strike_swarm: 1.7, oneway_drone: 1.4 };
const KIND_SCALE = { scout: 1.3, intercept: 1.15, support: .9, patrol: 1, orbit: 1, route: 1 };

/** The station pattern flown around a point: a racetrack for jets, a loose circuit for everything else. */
export function stationPath(game, u, center, kind = 'orbit', order = null) {
  const d = ACTION_UNITS[u.type], scale = KIND_SCALE[kind] ?? 1;
  let loop;
  if (FIXED_WING.has(u.type)) {
    let axis = order?.axis;
    if (axis == null) {
      const dx = dxBetween(u.x, center.x), dz = center.z - u.z;
      axis = Math.hypot(dx, dz) > 1 ? Math.atan2(dx, dz) : u.yaw || 0;
      if (order) order.axis = axis;
    }
    const o = ORBIT[u.type];
    loop = racetrack(center, axis, o.half * scale, o.radius * scale);
  } else {
    const lap = order ? order.lap = (order.lap || 0) + 1 : 0;
    loop = circuit(center, (CIRCUIT[u.type] || 1.8) * scale, u.id * 31 + lap);
  }
  return fromNearest(u, loop.map((p) => onMap(game, d, p)).filter(Boolean));
}

/** A looping patrol through waypoints, corners eased so jets bank through them instead of reversing in place. */
export function routePath(game, u, route, order = null) {
  const d = ACTION_UNITS[u.type];
  if (route.length === 1) return stationPath(game, u, route[0], 'patrol', order);
  let loop;
  if (route.length === 2) {
    const [a, b] = route, dx = dxBetween(a.x, b.x), dz = b.z - a.z, half = Math.hypot(dx, dz) / 2;
    const center = { x: a.x + dx / 2, z: a.z + dz / 2 };
    loop = racetrack(center, Math.atan2(dx, dz), half, FIXED_WING.has(u.type) ? 1.4 : .8);
  } else {
    loop = [];
    for (let i = 0; i < route.length; i++) {
      const prev = route[(i + route.length - 1) % route.length], p = route[i], next = route[(i + 1) % route.length];
      const ix = dxBetween(prev.x, p.x), iz = p.z - prev.z, il = Math.hypot(ix, iz) || 1;
      const ox = dxBetween(p.x, next.x), oz = next.z - p.z, ol = Math.hypot(ox, oz) || 1;
      const fi = Math.min(1, il / 3), fo = Math.min(1, ol / 3);
      loop.push({ x: p.x - ix / il * fi, z: p.z - iz / il * fi }, { x: p.x + ox / ol * fo, z: p.z + oz / ol * fo });
    }
  }
  return fromNearest(u, loop.map((p) => onMap(game, d, p)).filter(Boolean));
}

/** Strafing pass: through the target and on past it, then a wide turn back for the next run. */
export function strafePath(game, u, target) {
  const d = ACTION_UNITS[u.type];
  if (!FIXED_WING.has(u.type)) {
    // gunships and drones circle the target inside their weapon range instead of hanging over it
    const ring = circuit(target, Math.max(.8, Math.min(1.7, d.range * .6)), u.id * 17 + Math.floor(game.time / 8), 6);
    return fromNearest(u, ring.map((p) => onMap(game, d, p)).filter(Boolean));
  }
  const dx = dxBetween(u.x, target.x), dz = target.z - u.z, l = Math.hypot(dx, dz) || 1;
  const fx = dx / l, fz = dz / l, side = u.id % 2 ? 1 : -1, run = u.type === 'bomber' ? 3.4 : 3;
  const pts = [
    { x: target.x, z: target.z },
    { x: target.x + fx * run, z: target.z + fz * run },
    { x: target.x + fx * (run + 1.4) + fz * side * 1.6, z: target.z + fz * (run + 1.4) - fx * side * 1.6 },
    { x: target.x + fx * run + fz * side * 3.2, z: target.z + fz * run - fx * side * 3.2 },
  ];
  return pts.map((p) => onMap(game, d, p)).filter(Boolean);
}

function fly(u, path) {
  if (!path.length) return;
  u.path = path;
  u.goal = path[path.length - 1];
  u.blocked = 0;
}

// ------------------------------------------------------------------ per-tick step
/**
 * One aircraft for one tick (called from actionCombat before its weapons). Returns true when the aircraft
 * is on the ground and must not engage this tick.
 */
export function airStep(game, u) {
  const d = ACTION_UNITS[u.type];
  const full = maxFuel(game, u);
  if (u.fuel == null) u.fuel = full;
  if (u.grounded) {
    u.onPad = true;   // the next airborne tick is the take-off (§31 storm hold)
    const base = game.buildings.get(u.airBase);
    if (!base?.done || base.owner !== u.owner) { u.grounded = false; u.airOrder = null; return true; }
    if (u.altitude < .16) {
      u.hp = Math.min(u.maxHp, u.hp + u.maxHp * .015);
      u.fuel = Math.min(full, u.fuel + full / AIR.refuelTime * DT);
    }
    if (u.fuel >= full) {
      u.bingo = false;
      if (stormy(game, base.tile)) return true;   // storm-bound: no take-off until the storm passes (§31)
      // AI aircraft go back up once serviced: the planner only commands airborne aircraft.
      if (!u.airResume && !game.civs[u.owner]?.human && u.hp >= u.maxHp * .9) u.airResume = { kind: 'orbit', point: { x: base.x, z: base.z } };
      if (u.airResume) relaunch(game, u, base);
    }
    return true;
  }
  if (u.airResume) u.airResume = null;   // ordered off the pad before it finished refuelling
  // §31 weather and relief: one storm-cell lookup and one elevation read at the aircraft's own hex
  const storm = stormy(game, u.tile);
  if (u.onPad && storm) {
    // ordered off the pad under a storm: hold on the ground, order kept, until it passes
    const x = wrapX(u.x - u.vx * DT), z = u.z - u.vz * DT, t = tileAt(x, z);
    if (t >= 0) { u.x = x; u.z = z; u.tile = t; }
    u.vx = u.vz = 0; u.altitude = .045;
    if (!u.stormHeld && game.civs[u.owner]?.human) game.notify(u.owner, `${d.name} is grounded by a storm and will take off when it passes.`, { kind: 'warning', tile: u.tile, level: 'minor' });
    u.stormHeld = true;
    return true;
  }
  u.stormHeld = false; u.onPad = false;
  const ridge = lowFlyer(d) && game.world.elev[u.tile] > AIR_WEATHER.ridge;
  const pace = (storm ? AIR_WEATHER.stormPace : 1) * (ridge ? AIR_WEATHER.ridgePace : 1);
  if (pace < 1 && (u.vx || u.vz)) {
    const k = 1 - pace;
    const x = wrapX(u.x - u.vx * DT * k), z = u.z - u.vz * DT * k, t = tileAt(x, z);
    if (t >= 0) { u.x = x; u.z = z; u.tile = t; u.vx *= pace; u.vz *= pace; }
  }
  // burn
  const wasDry = u.fuel <= 0;
  u.fuel = Math.max(0, u.fuel - DT * (storm ? AIR_WEATHER.stormBurn : 1) * (ridge ? AIR_WEATHER.ridgeBurn : 1));
  const order = u.airOrder;
  if (u.fuel <= 0) {
    // limping: undo part of this tick's movement so the aircraft crawls at minimum speed
    const k = 1 - AIR.dryPace;
    const x = wrapX(u.x - u.vx * DT * k), z = u.z - u.vz * DT * k, t = tileAt(x, z);
    if (t >= 0) { u.x = x; u.z = z; u.tile = t; u.vx *= AIR.dryPace; u.vz *= AIR.dryPace; }
    if (!wasDry) {
      u.target = 0;
      if (game.civs[u.owner]?.human) game.notify(u.owner, `${d.name} is out of fuel and limping home.`, { kind: 'warning', tile: u.tile, level: 'minor' });
    }
    if (order?.kind !== 'return' && (game.tickN + u.id) % 10 === 0) returnToBase(game, u, resumeOf(game, u));
  } else if (order?.kind !== 'return' && !u.bingo && (game.tickN + u.id) % 5 === 0) {
    const base = nearestRefuel(game, u);
    if (base && u.fuel <= distance(u, base) / airSpeed(game, u) + AIR.reserve) {
      u.bingo = true;
      returnToBase(game, u, resumeOf(game, u));
    }
  }
  const current = u.airOrder;
  if (u.goal) {
    // queue the next lap before the last point is reached, so the aircraft never pauses between laps
    if (u.path.length === 1 && current && (current.kind === 'route' || current.point && !['strike', 'return'].includes(current.kind))
      && distance(u, u.path[0]) < airSpeed(game, u) * .5) {
      const here = { ...u, ...u.path[0] };
      const lap = current.kind === 'route' ? routePath(game, here, current.route, current) : stationPath(game, here, current.point, current.kind, current);
      const next = lap.filter((p) => distance(p, here) > .3);
      if (next.length) { u.path.push(...next); u.goal = u.path[u.path.length - 1]; }
    }
    return false;
  }
  if (!current) {
    if (u.orders.length) return false;
    const target = u.attack && (game.units.get(u.attack) || game.buildings.get(u.attack));
    if (target?.hp > 0) { fly(u, strafePath(game, u, target)); return false; }
    // nothing to do: never hover in place, orbit the spot instead
    u.airOrder = { kind: 'orbit', point: { x: u.x, z: u.z }, phase: 0 };
    fly(u, stationPath(game, u, u.airOrder.point, 'orbit', u.airOrder));
    return false;
  }
  // the Warthog has no bombs: a strike order becomes a gun run (strafing passes, actionFlight.js) over the point
  if (current.kind === 'strike' && d.strafe) current.kind = 'gun_run';
  if (current.kind === 'strike') {
    if (u.fuel <= 0) return false;
    game.bombard(u, current.point);
    u.airOrder = null;
    if (u.type === 'oneway_drone') { game.units.delete(u.id); return true; }
    returnToBase(game, u);
  } else if (current.kind === 'return') {
    const base = game.buildings.get(current.base);
    if (!base?.done || base.owner !== u.owner) returnToBase(game, u, current.resume);
    else if (stormy(game, base.tile) && u.fuel > AIR.reserve) {
      // §31: no landing under a storm. Divert to a clear base, or hold off in an orbit until it passes
      // (an aircraft down to its fuel reserve makes an emergency landing anyway).
      const other = nearestRefuel(game, u);
      if (other && other.id !== base.id && !stormy(game, other.tile)) returnToBase(game, u, current.resume);
      else { u.airOrder = { kind: 'orbit', point: { x: base.x, z: base.z }, phase: 0 }; u.bingo = false; }
    } else {
      u.grounded = true; u.airBase = base.id; u.airOrder = null; u.target = 0; u.attack = null;
      u.airResume = current.resume || null;
    }
  } else if (current.kind === 'route') fly(u, routePath(game, u, current.route, current));
  else if (current.point) fly(u, stationPath(game, u, current.point, current.kind, current));
  return false;
}

// ------------------------------------------------------------------ commands
/** Clamp a waypoint to the patrol range of the refuelling base nearest to it. */
function clampToRange(game, u, p) {
  const base = nearestRefuel(game, u, p);
  if (!base) return { point: p, clamped: false };
  const range = patrolRange(game, u), dx = dxBetween(base.x, p.x), dz = p.z - base.z, l = Math.hypot(dx, dz);
  if (l <= range) return { point: p, clamped: false };
  const k = range / l;
  const q = onMap(game, ACTION_UNITS[u.type], { x: base.x + dx * k, z: base.z + dz * k });
  return { point: q || p, clamped: true };
}

/**
 * {c:'patrol', units, points:[{x,z},...] (1-8)} - selected aircraft fly a looping patrol through the waypoints
 * (one waypoint: a station orbit around it), refuelling on their own and resuming. Waypoints beyond fuel range
 * are pulled in toward the nearest base. Reply: {patrol, waypoints, clamped, range, note?}.
 */
export function patrolCommand(game, civ, group, cmd) {
  const air = group.filter((u) => ACTION_UNITS[u.type].air && u.type !== 'oneway_drone');
  if (!air.length) return { error: group.some((u) => u.type === 'oneway_drone') ? 'One-way drones cannot patrol.' : 'Select aircraft to patrol.' };
  const raw = Array.isArray(cmd.points) ? cmd.points.slice(0, AIR.maxWaypoints) : [cmd.point || null];
  const asked = raw.map((p, i) => game.point(p, i === 0 && !Array.isArray(cmd.points) ? cmd.tile : undefined)).filter(Boolean);
  if (!asked.length) return { error: 'Choose patrol waypoints.' };
  // §31: low flyers cannot hold station over high mountains; storms are allowed, with a warning
  const low = air.some((u) => lowFlyer(ACTION_UNITS[u.type]));
  const points = asked.filter((p) => !air.some((u) => overRidge(game, ACTION_UNITS[u.type], p)));
  if (!points.length) return { error: low ? 'Helicopters and drones cannot patrol over high mountains: choose lower ground.' : 'Choose patrol waypoints.' };
  const dropped = asked.length - points.length;
  const stormNote = points.some((p) => stormy(game, tileAt(wrapX(p.x), p.z))) ? 'A storm covers part of that patrol: aircraft there fly slower and burn more fuel.' : null;
  let patrol = 0, clamped = 0, range = Infinity, shown = null;
  for (const u of air) {
    let n = 0;
    const route = points.map((p) => { const c = clampToRange(game, u, p); if (c.clamped) n++; return c.point; });
    const result = moveGroup(game, [u], route[0], { mode: 'assault' });
    if (result.error) continue;
    u.airOrder = { kind: 'route', route, leg: 0, phase: 0 };
    u.airResume = null; u.bingo = false;
    clamped = Math.max(clamped, n);
    const r = patrolRange(game, u);
    if (r < range) { range = r; shown = route; }
    patrol++;
  }
  if (!patrol) return { error: 'No selected aircraft can fly that patrol.' };
  const out = { patrol, waypoints: points.length, clamped, range: Math.round(range * 10) / 10,
    route: shown.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100]),
    ...(dropped ? { dropped } : {}) };
  const notes = [clamped ? `${clamped} waypoint${clamped > 1 ? 's' : ''} pulled back within fuel range.` : null,
    dropped ? `${dropped} waypoint${dropped > 1 ? 's' : ''} over high mountains skipped.` : null, stormNote].filter(Boolean);
  if (notes.length) out.note = notes.join(' ');
  // the worker sends only `reply` back to the client
  return { ...out, reply: { t: 'ack', patrol: out } };
}

/** The snapshot's air array: [state, fuel 0-255, 0, mission index, mission tile, -1, 0]. Fuel is owner-only (-1 otherwise). */
export function airWire(u, own, game = null) {
  if (!own) return [u.grounded ? AIR_STATE.grounded : AIR_STATE.airborne, -1, 0, -1, -1, -1, 0];
  const full = maxFuel(game, u) || 1;
  const fuel = Math.round(255 * Math.max(0, Math.min(1, fuelOf(u, game) / full)));
  const o = u.airOrder;
  const state = u.grounded ? fuel < 255 ? AIR_STATE.refuelling : AIR_STATE.grounded
    : fuel <= 0 ? AIR_STATE.dry : o?.kind === 'return' ? AIR_STATE.returning : AIR_STATE.airborne;
  const point = o?.kind === 'route' ? o.route[0] : o?.point;
  return [state, fuel, 0, o ? AIR_MISSIONS.indexOf(o.kind) : -1, point ? tileAt(point.x, point.z) : -1, -1, o?.kind === 'route' ? o.route.length : 0];
}

// ------------------------------------------------------------------ flak
/**
 * A flak volley bursting at altitude around an aircraft. Event:
 * {k:'flak', a, b, s, t, w, bx, bz, y, p:[dx,dy,dz,...], o} - (bx, y, bz) is the burst centre in map units
 * (y = altitude above ground), p the puff offsets from it, o 'hit' or 'miss'.
 */
export function flakBurst(game, shooter, target, point, weapon, hit) {
  const y = target?.isUnit && ACTION_UNITS[target.type]?.air ? Math.max(.3, target.altitude || 1.2) : 1.6;
  const n = Math.max(3, Math.min(6, WEAPONS[weapon]?.burst || 4)), p = [];
  for (let k = 0; k < n; k++) {
    const close = hit && k === 0, spread = close ? .1 : .48;
    const r = (x) => Math.round((hash(game.tickN, shooter.id * 7 + k, x) - .5) * 2 * spread * 100) / 100;
    p.push(r(1), Math.round(r(2) * 50) / 100, r(3));
  }
  emit(game, { k: 'flak', a: shooter.tile, b: tileAt(point.x, point.z), s: shooter.id, t: target?.id || 0,
    w: WEAPON_KEYS.indexOf(weapon), bx: Math.round(point.x * 1000) / 1000, bz: Math.round(point.z * 1000) / 1000, y: Math.round(y * 100) / 100, p, o: hit ? 'hit' : 'miss' });
}

/** Whether this headquarters has built-in AA: its city defenses were upgraded (B sets site.cityAA / b.cityAA, or a perimeter piece reaches level 2). */
export function cityHasAA(game, b) {
  if (b.type !== 'town' || !b.done) return false;
  if (b.cityAA) return true;
  const site = game.siteById?.get(b.site);
  if (site?.cityAA === true || cityAA(site)) return true;   // B: perimeter upgraded to defenseLevel >= 2
  for (const o of game.buildings.values()) if (o.site === b.site && o.owner === b.owner && o.perimeterSlot && o.done && (o.level || 1) >= 2) return true;
  return false;
}
