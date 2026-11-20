// Flight for the action RTS: authoritative and deterministic (fixed DT, no randomness).
//
// Fixed-wing aircraft (the Warthog and the bomber) never stop in the air and never snap their
// heading. They fly at speed with a turn rate that is limited by their turning radius and that
// itself changes smoothly (they roll into and out of turns), so every change of direction is a wide,
// banked curve. With nothing to do they loiter on a wide orbit. They attack in runs:
//
//   reposition -> fly to an initial point well short of the target, on the chosen attack heading
//   run        -> line up on the attack line (cross-track guidance) and fly it straight over the
//                 target; the Warthog fires a one-second cannon burst whose impacts walk along its
//                 ground track through the target, the bomber releases as it passes over
//   extend     -> carry on straight past the target, climbing out
//   reposition -> swing round onto a new attack heading (offset from the reciprocal, alternating
//                 sides as geometry suits) and come again until the target is destroyed
//
// Helicopters and drones steer their velocity with limited acceleration: they speed up and slow
// down smoothly, brake on arrival and curve between headings instead of turning on the spot.
import { DT, H } from './constants.js';
import { WEAPON_KEYS } from './weapons.js';
import { ACTION_UNITS } from './actionDefinitions.js';
import { distance, dxBetween, tileAt, wrapX } from './actionNavigation.js';
import { emit } from './combat.js';

// radius: tightest turn (world units); roll: how fast the turn rate may change (rad/s^2);
// cruise / runAlt: altitudes; runSpeed: fraction of cruise speed held on the attack line;
// loiter: orbit radius when idle
const FLIGHT = {
  fighter: { radius: 1.45, roll: 3.0, cruise: 1.25, runAlt: .52, runSpeed: .9, loiter: 2.0 },
  bomber: { radius: 2.0, roll: 2.0, cruise: 2.6, runAlt: 2.25, runSpeed: 1, loiter: 2.6 },
};
export const isFixedWing = (type) => Object.hasOwn(FLIGHT, type);

const RUN_IN = 3.2;          // the run must be lined up this far short of the target
const IP_EXTRA = 2.4;        // the initial point sits this much further out
const EXTEND = 3.0;          // distance flown past the target before turning back
const REATTACK = .5;         // new attack heading: the reciprocal, offset by this much (rad)
const GUN_OPEN = 2.5, GUN_CLOSE = .6;   // the cannon opens fire between these distances short of the target
const BURST_TICKS = 10;      // one-second burst
const IMPACT_BEFORE = .85, IMPACT_AFTER = .6;   // the walk of impacts around the target, along the track
const HIT_R = .22;           // impact spread either side of the track
const STRAFE_TICK = .55;     // share of attack per burst tick on each target under the impacts
const VID_GAU8 = WEAPON_KEYS.indexOf('gau8');
const ORBIT_ORDERS = new Set(['patrol', 'intercept', 'scout', 'support', 'orbit', 'route']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const turn = (from, to, max) => norm(from + clamp(angleDelta(from, to), -max, max));

function climb(u, target, up = .055, down = .075) {
  u.altitude = Math.max(.045, (u.altitude || 0) + clamp((target - (u.altitude || 0)) * .12, -down, up));
}

// Stop at the end of a route without losing airspeed or heading (stopUnit zeroes both).
function settle(game, u, stopUnit) {
  const yaw = u.yaw;
  u.destinationFacing = null;
  stopUnit(game, u, true);
  u.yaw = yaw;
}

// ------------------------------------------------------------------ motion

export function flyAircraft(game, u, def, stopUnit) {
  const pace = def.speed;
  if (isFixedWing(u.type)) fixedWing(game, u, pace, FLIGHT[u.type], stopUnit);
  else rotary(game, u, pace, stopUnit);
}

// Heading error toward a point, or 0 (hold course) while the point is inside the turning circle on
// that side: the aircraft extends until it can turn onto it instead of circling it forever.
function steer(u, p, radius) {
  const dx = dxBetween(u.x, p.x), dz = p.z - u.z;
  const err = angleDelta(u.yaw, Math.atan2(dx, dz));
  if (Math.abs(err) < .3) return err;
  const side = err > 0 ? 1 : -1, cx = Math.cos(u.yaw) * radius * side, cz = -Math.sin(u.yaw) * radius * side;
  return (dx - cx) ** 2 + (dz - cz) ** 2 < radius * radius * .92 ? 0 : err;
}

// Heading error that holds a circle of radius R round c (dir 1: turning right, -1: left).
function orbit(u, c, R, dir) {
  const fx = dxBetween(c.x, u.x), fz = u.z - c.z, r = Math.hypot(fx, fz);
  if (r < 1e-6) return 0;
  return angleDelta(u.yaw, Math.atan2(fx, fz) + dir * (Math.PI / 2 + Math.atan((r - R) * 1.1)));
}

// Position relative to the attack line through the target: s along the attack heading (negative
// short of the target), ct across it (positive to the right).
export function runFrame(u, run) {
  const px = dxBetween(run.tx, u.x), pz = u.z - run.tz, sh = Math.sin(run.h), ch = Math.cos(run.h);
  return { s: px * sh + pz * ch, ct: px * ch - pz * sh };
}
const entryPoint = (run) => ({ x: wrapX(run.tx - Math.sin(run.h) * (RUN_IN + IP_EXTRA)), z: run.tz - Math.cos(run.h) * (RUN_IN + IP_EXTRA) });

function fixedWing(game, u, pace, spec, stopUnit) {
  u.airspeed ??= u.speed || 0;
  if (u.grounded) {
    u.airspeed = 0; u.turnRate = 0; u.vx = u.vz = u.speed = 0;
    climb(u, .045);
    return;
  }
  const radius = spec.radius * 1.1;
  let err = 0, want = pace, alt = spec.cruise;
  const run = u.run;
  if (run) {
    if (run.phase === 'run') {
      const { ct } = runFrame(u, run);
      err = angleDelta(u.yaw, run.h - clamp(ct * 1.3, -.9, .9));
      alt = spec.runAlt; want = pace * spec.runSpeed;
    } else if (run.phase === 'extend') err = angleDelta(u.yaw, run.h);
    else err = steer(u, entryPoint(run), radius);
  } else if (u.goal) {
    let p = u.path[0] || u.goal;
    const reached = (q) => {
      const d = distance(u, q);
      return d < Math.max(.3, u.airspeed * DT * 1.6) || d < 1.1 && Math.abs(angleDelta(u.yaw, Math.atan2(dxBetween(u.x, q.x), q.z - u.z))) > 1.6;
    };
    while (p && reached(p)) { u.path.shift(); p = u.path[0]; }
    if (!p) {
      const goal = u.goal;
      settle(game, u, stopUnit);
      if (!u.goal) u.anchor = { x: goal.x, z: goal.z };
      p = u.goal ? u.path[0] || u.goal : null;
    }
    if (p) {
      err = steer(u, p, radius);
      // on finals for its airfield: slow down and descend so the landing is not a stop from cruise
      if (u.airOrder?.kind === 'return' && u.path.length <= 1 && distance(u, p) < 2.6) { want = pace * .5; alt = .35; }
    } else err = orbit(u, u.anchor, spec.loiter, u.id % 2 ? 1 : -1);
  } else {
    if (!u.anchor) u.anchor = { x: wrapX(u.x + Math.sin(u.yaw) * 1.2), z: u.z + Math.cos(u.yaw) * 1.2 };
    err = orbit(u, u.anchor, spec.loiter, u.id % 2 ? 1 : -1);
  }
  // never fly off the top or bottom of the map: turn back toward its middle
  const ahead = tileAt(wrapX(u.x + Math.sin(u.yaw) * .9), u.z + Math.cos(u.yaw) * .9);
  if (ahead < 0) err = angleDelta(u.yaw, u.z < H * .75 ? 0 : Math.PI);
  // airspeed eases toward what the phase wants (a takeoff run from a standstill included)
  u.airspeed += clamp(want - u.airspeed, -pace * .5 * DT, pace * .7 * DT);
  // the turn rate is capped by speed / radius and changes at the roll rate: banked, never snapped
  const maxTurn = Math.max(.15, u.airspeed / spec.radius);
  const rate = clamp(err * 2.2, -maxTurn, maxTurn);
  u.turnRate = clamp((u.turnRate || 0) + clamp(rate - (u.turnRate || 0), -spec.roll * DT, spec.roll * DT), -maxTurn, maxTurn);
  u.yaw = norm(u.yaw + u.turnRate * DT);
  const step = u.airspeed * DT, sx = Math.sin(u.yaw) * step, sz = Math.cos(u.yaw) * step;
  let nx = wrapX(u.x + sx), nz = u.z + sz, tile = tileAt(nx, nz);
  if (tile < 0) { nz = u.z; tile = tileAt(nx, nz); }
  if (tile < 0) { nx = u.x; tile = u.tile; }
  u.vx = dxBetween(u.x, nx) / DT; u.vz = (nz - u.z) / DT;
  u.x = nx; u.z = nz; u.tile = tile; u.speed = u.airspeed;
  climb(u, alt);
}

function rotary(game, u, pace, stopUnit) {
  const heli = u.type === 'helicopter';
  if (u.grounded) { u.fvx = u.fvz = 0; u.vx = u.vz = u.speed = 0; climb(u, .045, .082, .12); return; }
  climb(u, heli ? .75 : 1.05, .082, .12);
  const accel = pace * (heli ? .85 : 1.3);
  let vx = u.fvx || 0, vz = u.fvz || 0, wx = 0, wz = 0;
  if (u.goal) {
    // on station (patrol, scouting, support) the craft flies through its orbit points without braking
    const through = ORBIT_ORDERS.has(u.airOrder?.kind);
    let p = u.path[0];
    while (p && distance(u, p) <= (u.path.length > 1 || through ? .3 : .05)) { u.path.shift(); p = u.path[0]; }
    if (!p) { stopUnit(game, u, true); p = u.goal ? u.path[0] || u.goal : null; }
    if (p) {
      const dx = dxBetween(u.x, p.x), dz = p.z - u.z, d = Math.hypot(dx, dz) || 1;
      const final = u.path.length <= 1 && !ORBIT_ORDERS.has(u.airOrder?.kind);
      const speed = final ? Math.min(pace, Math.sqrt(2 * accel * .8 * Math.max(0, d - .02))) : ORBIT_ORDERS.has(u.airOrder?.kind) ? pace * .6 : pace;
      wx = dx / d * speed; wz = dz / d * speed;
    }
  }
  // the velocity turns toward what is wanted with limited acceleration: curves, no snaps
  let ax = wx - vx, az = wz - vz;
  const a = Math.hypot(ax, az), max = accel * DT;
  if (a > max) { ax *= max / a; az *= max / a; }
  vx += ax; vz += az;
  if (!u.goal && Math.hypot(vx, vz) < .01) vx = vz = 0;
  const nx = wrapX(u.x + vx * DT), nz = u.z + vz * DT, tile = tileAt(nx, nz);
  if (tile < 0) vx = vz = 0;
  else { u.x = nx; u.z = nz; u.tile = tile; }
  u.fvx = vx; u.fvz = vz; u.vx = vx; u.vz = vz;
  const sp = Math.hypot(vx, vz);
  u.speed = sp;
  // nose along the flight path when moving; toward what it is engaging when hovering
  let face = null;
  if (sp > pace * .18) face = Math.atan2(vx, vz);
  else if (u.target) {
    const t = game.units.get(u.target) || game.buildings.get(u.target);
    if (t) face = Math.atan2(dxBetween(u.x, t.x), t.z - u.z);
  }
  if (face != null) u.yaw = turn(u.yaw, face, DT * (heli ? 1.9 : 2.8));
}

// ------------------------------------------------------------------ attack runs

function startRun(game, u, target) {
  const dx = dxBetween(u.x, target.x), dz = target.z - u.z, d = Math.hypot(dx, dz);
  const toward = Math.atan2(dx, dz);
  u.run = { t: target.id, tx: target.x, tz: target.z, h: u.yaw, phase: 'extend', fired: 0, since: game.time, burst: null, passes: 0 };
  if (d > RUN_IN + .6 && Math.abs(angleDelta(u.yaw, toward)) < 1.25) Object.assign(u.run, { phase: 'run', h: toward });
  else if (d > RUN_IN + .6) reposition(game, u, u.run);
}

// Choose the next attack heading and its initial point: back toward the target from the side the
// aircraft is on, offset either way; the one needing the smaller turn now wins.
function reposition(game, u, run) {
  const out = Math.atan2(dxBetween(run.tx, u.x), u.z - run.tz);
  let best = null;
  for (const side of [1, -1]) {
    const h = norm(out + Math.PI + side * REATTACK);
    const ip = entryPoint({ ...run, h });
    const err = Math.abs(angleDelta(u.yaw, Math.atan2(dxBetween(u.x, ip.x), ip.z - u.z)));
    if (!best || err < best.err - 1e-9) best = { h, err };
  }
  Object.assign(run, { phase: 'reposition', h: best.h, fired: 0, since: game.time, passes: run.passes + 1 });
}

function acquireGround(game, u, civ, near) {
  const order = u.airOrder;
  const focused = order?.point && (order.kind === 'gun_run' || order.kind === 'strike');
  const c = order?.point && order.kind !== 'return' ? order.point : !u.goal && u.anchor ? u.anchor : u;
  const radius = focused ? 3.3 : c === u ? 4.2 : 4.8;
  let best = null, score = Infinity;
  for (const v of game.targets.query(c.x, c.z, radius, near)) {
    if (!(v.hp > 0) || !game.hostile(u.owner, v.owner) || !game.sees(civ, v)) continue;
    const vd = v.isUnit ? ACTION_UNITS[v.type] : null;
    if (vd?.air) continue;
    const armored = vd && (vd.move === 'tracked' || vd.move === 'wheeled');
    const s = distance(c, v) + (v.isUnit ? 0 : 1.2) - (armored ? .9 : 0) - (v.id === u.run?.t ? .5 : 0);
    if (s < score) { score = s; best = v; }
  }
  return best;
}

function startBurst(game, u, run, target, ct) {
  const sh = Math.sin(run.h), ch = Math.cos(run.h);
  // the impacts walk along the aircraft's own ground track, through the target
  const ox = run.tx + ch * ct, oz = run.tz - sh * ct;
  const x0 = wrapX(ox - sh * IMPACT_BEFORE), z0 = oz - ch * IMPACT_BEFORE, x1 = wrapX(ox + sh * IMPACT_AFTER), z1 = oz + ch * IMPACT_AFTER;
  run.burst = { x0, z0, x1, z1, k: 0 };
  run.fired = 1;
  u.lastCombat = game.time;
  emit(game, { k: 'strafe', a: tileAt(x0, z0), b: tileAt(x1, z1), s: u.id, t: target.id, w: VID_GAU8, f: BURST_TICKS * DT,
    ax: x0, az: z0, bx: x1, bz: z1 });
}

function burstStep(game, u, def, run, damage) {
  const b = run.burst, dx = dxBetween(b.x0, b.x1), dz = b.z1 - b.z0;
  const f0 = b.k / BURST_TICKS, f1 = (b.k + 1) / BURST_TICKS;
  b.k++;
  const ax = b.x0 + dx * f0, az = b.z0 + dz * f0, sx = dx * (f1 - f0), sz = dz * (f1 - f0);
  const len2 = sx * sx + sz * sz || 1;
  let amount = def.atk * STRAFE_TICK;
  if (u.kills) amount *= 1 + Math.min(3, Math.floor(u.kills / 4)) * .04;
  const near = [];
  for (const v of game.targets.query(wrapX(ax + sx / 2), az + sz / 2, Math.sqrt(len2) / 2 + HIT_R + .6, near)) {
    if (!(v.hp > 0) || !game.hostile(u.owner, v.owner) || v.isUnit && ACTION_UNITS[v.type].air) continue;
    const px = dxBetween(ax, v.x), pz = v.z - az, t = clamp((px * sx + pz * sz) / len2, 0, 1);
    if ((px - sx * t) ** 2 + (pz - sz * t) ** 2 > (HIT_R + (v.radius || .2)) ** 2) continue;
    damage(game, v, u, amount * (v.isUnit ? 1 : .55), 'gau8');
  }
  u.lastCombat = game.time;
  if (b.k >= BURST_TICKS) run.burst = null;
}

// Combat side of fixed-wing attack runs; called every tick. Returns true when it has handled the
// aircraft (the Warthog always: its cannon only fires on runs), false to fall back to ordinary fire.
export function attackRuns(game, u, def, hooks, stopUnit) {
  if (!isFixedWing(u.type)) return false;
  const strafe = !!def.strafe;
  if (u.run?.burst) burstStep(game, u, def, u.run, hooks.damage);
  if (u.grounded || u.fuel <= 0 || u.airOrder?.kind === 'return') { u.run = null; return strafe; }
  const civ = game.civs[u.owner], near = [];
  let explicit = u.attack ? game.units.get(u.attack) || game.buildings.get(u.attack) : null;
  if (u.attack && !(explicit?.hp > 0)) {
    u.attack = null; explicit = null;
    if (u.run) u.anchor = { x: u.run.tx, z: u.run.tz };
    settle(game, u, stopUnit);
  }
  const ground = (v) => v?.hp > 0 && (!v.isUnit || !ACTION_UNITS[v.type].air) && game.sees(civ, v);
  let target = ground(explicit) ? explicit : null;
  if (!target && u.run && !explicit) {
    const t = game.units.get(u.run.t) || game.buildings.get(u.run.t);
    const order = u.airOrder?.point && u.airOrder.kind !== 'return' ? u.airOrder.point : u.anchor || t;
    if (ground(t) && game.hostile(u.owner, t.owner) && distance(t, order || t) < 6.5) target = t;
  }
  // looking for a new target is staggered (every third tick per aircraft): a spatial query, not every tick
  if (!target && strafe && !explicit && u.mode !== 'move' && (game.tickN + u.id) % 3 === 0) target = acquireGround(game, u, civ, near);
  if (!target) {
    if (u.run) {
      if (!u.goal && !u.airOrder?.point) u.anchor = { x: u.run.tx, z: u.run.tz };
      if (u.run.burst) u.run.phase = 'extend'; else u.run = null;
    }
    // a gun run with nothing left in the area becomes a patrol over it
    if (strafe && (u.airOrder?.kind === 'gun_run' || u.airOrder?.kind === 'strike') && !u.run)
      u.airOrder = { kind: 'patrol', point: u.airOrder.point, phase: 0 };
    if (strafe) u.target = 0;
    return strafe || !!explicit;
  }
  if (!u.run || u.run.t !== target.id) startRun(game, u, target);
  const run = u.run;
  run.tx = target.x; run.tz = target.z;
  u.target = target.id;
  const { s, ct } = runFrame(u, run);
  if (run.phase === 'run') {
    const aligned = Math.abs(angleDelta(u.yaw, run.h));
    if (strafe) {
      if (!run.fired && s >= -GUN_OPEN && s <= -GUN_CLOSE && Math.abs(ct) < .4 && aligned < .4) startBurst(game, u, run, target, ct);
    } else if (!run.fired && s >= -.7 && s <= .25 && Math.abs(ct) < .7) {
      hooks.fire(game, u, def, target);
      run.fired = 1;
    }
    if (s > .45) Object.assign(run, { phase: 'extend', since: game.time });
    else if (game.time - run.since > 20) reposition(game, u, run);
  } else if (run.phase === 'extend') {
    if (s > EXTEND || game.time - run.since > 4.5) reposition(game, u, run);
  } else {
    const ip = entryPoint(run);
    if (distance(u, ip) < 1.0 || s < -RUN_IN && Math.abs(ct) < 1.0 && Math.abs(angleDelta(u.yaw, run.h)) < .9)
      Object.assign(run, { phase: 'run', since: game.time, fired: 0 });
    else if (game.time - run.since > 16) reposition(game, u, run);
  }
  return true;
}
