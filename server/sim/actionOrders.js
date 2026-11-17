import { DT } from './constants.js';
import { ACTION_UNITS } from './actionDefinitions.js';
import { distance, dxBetween, OPEN_COST, SpatialIndex, tileAt, wrapX, trenchPosition } from './actionNavigation.js';
import { addWear } from './battlefield.js';

const SIDESTEPS = [.34, -.34, .66, -.66, 1.04, -1.04, 1.48, -1.48];
// 2026-11-16: every ground unit moves ~30% slower than its definition speed (Rowen: 20-50% slower),
// and terrain only nudges pace (roads +20%, rough ground at most -20%) so a unit type keeps a consistent speed.
export const GROUND_PACE = .7;
// open ground (grass and plains, within 10% of the class's best) is one cruising speed
const TERRAIN_PACE = (c) => !Number.isFinite(c) || c >= 1 && c <= 1.1 ? 1 : 1 / Math.min(1.25, Math.max(.83, c));
export const STANCES = ['aggressive', 'defensive', 'holdFire'];
export const stanceOf = (u) => STANCES.includes(u.stance) ? u.stance : 'defensive';
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const turn = (from, to, max) => {
  const d = angleDelta(from, to), value = from + Math.max(-max, Math.min(max, d));
  return Math.atan2(Math.sin(value), Math.cos(value));
};

export function ownedUnits(game, civ, ids) {
  if (!Array.isArray(ids)) return [];
  const group = [];
  for (const id of new Set(ids.slice(0, 1024))) {
    const u = game.units.get(id);
    if (u?.owner === civ.id) group.push(u);
  }
  return group;
}

function assign(game, u, goal, opts, path) {
  const order = { goal, mode: opts.mode, facing: opts.facing ?? null, path, convoy: opts.convoy || 0, convoySpeed: opts.convoySpeed || 0 };
  if (opts.queue && (u.goal || u.airOrder || u.attack)) {
    if (u.orders.length >= 8) return false;
    u.orders.push(order); return true;
  }
  if (!opts.queue) u.orders.length = 0;
  u.airOrder = null;
  u.attack = null;
  u.formation = opts.formation || 0;
  u.braced = opts.facing != null;
  u.coverAnchor = null;
  u.manned = false;
  u.tacticalResume = null;
  u.tacticalUntil = 0;
  u.alignFacing = null;
  u.pursuit = null;
  if (u.grounded) u.grounded = false;
  startOrder(game, u, order);
  return true;
}

function startOrder(game, u, order) {
  if (order.kind === 'attack') {
    const target = game.units.get(order.target) || game.buildings.get(order.target);
    u.goal = null; u.path = []; u.target = 0;
    u.mode = 'assault'; u.attack = target?.hp > 0 ? target.id : null;
    if (!u.attack && u.orders.length) startOrder(game, u, u.orders.shift());
    return;
  }
  u.goal = order.goal;
  u.path = order.path || game.nav.route(u, order.goal, ACTION_UNITS[u.type]) || [];
  u.mode = order.mode;
  u.destinationFacing = order.facing;
  u.blocked = 0;
  u.convoy = order.convoy || 0; u.convoySpeed = order.convoySpeed || 0;
  u.stall = 0; u.stallLen = -1; u.stallBest = Infinity;
}

export function stopUnit(game, u, advance = false) {
  u.goal = null;
  u.convoy = 0;
  u.path = [];
  u.vx = u.vz = u.speed = 0;
  if (advance && u.destinationFacing != null) {
    if (ACTION_UNITS[u.type].move === 'infantry') u.yaw = u.destinationFacing;
    else u.alignFacing = u.destinationFacing;
  }
  u.destinationFacing = null;
  u.mode = u.mode === 'move' ? 'guard' : u.mode;
  if (!advance) { u.tacticalResume = null; u.tacticalUntil = 0; u.alignFacing = null; }
  if (advance && u.tacticalResume) {
    const resume = u.tacticalResume;
    u.tacticalResume = null; u.tacticalUntil = 0;
    if (resume.goal) { u.goal = resume.goal; u.path = game.nav.route(u, resume.goal, ACTION_UNITS[u.type]) || []; }
    return;
  }
  if (advance && u.orders.length) {
    const next = u.orders.shift();
    next.path = null;
    startOrder(game, u, next);
  }
}

function candidate(game, u, point, reserved, max, start = u, preview = false) {
  const d = ACTION_UNITS[u.type], near = [];
  if (d.move === 'infantry') point = trenchPosition(game, point, u.owner, .55) || point;
  const slot = game.nav.nearest(point, d, max, (x, z) => {
    if (d.air) return true;
    return reserved.query(x, z, .65, near).every((o) => distance(o, { x, z }) >= o.radius + d.radius + .06);
  });
  if (!slot) return null;
  const path = game.nav.route(start, slot, d);
  if (!path) return null;
  if (!d.air && !preview) reserved.add({ ...slot, radius: d.radius });
  return { slot, path };
}

export function moveGroup(game, group, point, opts = {}) {
  if (!group.length) return { error: 'Select units to give an order.' };
  game.nav.primeGroup(group, point);
  const ground = group.filter((u) => !ACTION_UNITS[u.type].air), air = group.filter((u) => ACTION_UNITS[u.type].air);
  // The formation faces from the group's centre to the destination (not from whichever unit was listed first).
  const base = ground[0] || air[0], members = ground.length ? ground : air;
  let cx = 0, cz = 0;
  for (const u of members) { cx += dxBetween(base.x, u.x); cz += u.z - base.z; }
  const centre = { x: base.x + cx / members.length, z: base.z + cz / members.length };
  const a = Math.atan2(dxBetween(centre.x, point.x), point.z - centre.z);
  const sideX = Math.cos(a), sideZ = -Math.sin(a), fx = Math.sin(a), fz = Math.cos(a);
  const cols = Math.max(1, Math.ceil(Math.sqrt(ground.length * 1.5)));
  const rows = Math.ceil(ground.length / cols);
  const spacing = Math.max(.43, ...ground.map((u) => ACTION_UNITS[u.type].radius * 2 + .11));
  const reserved = new SpatialIndex(.70);
  let placed = 0;
  // Slots keep the group's arrangement: the units furthest along the line of travel take the front row,
  // left-to-right order is preserved, so paths do not cross and early arrivals never wall in later ones.
  const along = (u) => dxBetween(centre.x, u.x) * fx + (u.z - centre.z) * fz;
  const across = (u) => dxBetween(centre.x, u.x) * sideX + (u.z - centre.z) * sideZ;
  ground.sort((p, q) => along(q) - along(p) || p.id - q.id);
  for (let r = 0; r < rows; r++) {
    const row = ground.slice(r * cols, (r + 1) * cols).sort((p, q) => across(p) - across(q) || p.id - q.id);
    ground.splice(r * cols, row.length, ...row);
  }
  // A group moves at its slowest member's pace (lagging members may catch up; see unitMotion).
  const convoy = ground.length > 1 && !opts.formation ? (game.nextConvoy = (game.nextConvoy || 0) + 1) : 0;
  const convoySpeed = convoy ? Math.min(...ground.map((u) => ACTION_UNITS[u.type].speed)) * GROUND_PACE : 0;
  const orderOpts = convoy ? { ...opts, convoy, convoySpeed } : opts;
  for (let i = 0; i < ground.length; i++) {
    const u = ground[i], row = Math.floor(i / cols), width = Math.min(cols, ground.length - row * cols);
    const side = (i % cols - (width - 1) * .5) * spacing, forward = ((rows - 1) * .5 - row) * spacing;
    const p = { x: point.x + sideX * side + fx * forward, z: point.z + sideZ * side + fz * forward };
    // a crowded destination (a base court, a bridgehead) widens the slot search instead of leaving the unit behind
    const pick = candidate(game, u, p, reserved, opts.exact ? .45 : 1.55) || (!opts.exact && candidate(game, u, p, reserved, 3.1));
    if (!pick) continue;
    if (assign(game, u, pick.slot, orderOpts, pick.path)) placed++;
  }
  for (let i = 0; i < air.length; i++) {
    const u = air[i], offset = (i - (air.length - 1) / 2) * Math.min(.32, 4 / air.length);
    const goal = game.nav.nearest({ x: point.x + sideX * offset, z: point.z + sideZ * offset }, ACTION_UNITS[u.type], .67);
    if (!goal) continue;
    if (assign(game, u, goal, opts, [goal])) placed++;
  }
  game.nav.activeFlows.clear();
  return placed ? { placed, blocked: group.length - placed } : { error: 'No selected unit can reach that ground.' };
}

/**
 * {c:'reach', units, point} -> { t:'ack', reach: { ok, all, reachable, units, reason } }.
 * Cheap (connected-region lookup, no route search). Without units it answers for `move`
 * ('infantry' | 'wheeled' | 'tracked', default infantry).
 */
export function reachQuery(game, group, point, move = 'infantry') {
  const ground = group.filter((u) => !ACTION_UNITS[u.type].air);
  const air = group.length - ground.length;
  const probes = ground.length ? ground : group.length ? [] : [{ x: point.x, z: point.z, probe: { move: ['infantry', 'wheeled', 'tracked'].includes(move) ? move : 'infantry', radius: .14 } }];
  let reachable = air, blocked = 0;
  for (const u of probes) {
    const def = u.probe || ACTION_UNITS[u.type];
    const r = game.nav.reachability(u.probe ? { x: u.x, z: u.z, unknown: true } : u, point, def);
    if (r === 'ok') reachable++; else if (r === 'blocked') blocked++;
  }
  const total = probes.length + air;
  const reason = reachable === total ? null : blocked ? 'impassable' : 'unreachable';
  return { reply: { t: 'ack', reach: { ok: reachable > 0, all: reachable === total, reachable, units: total, reason } } };
}

function polyline(points) {
  const segments = [];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = dxBetween(a.x, b.x), dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < .015) continue;
    segments.push({ a, dx, dz, len, at: length });
    length += len;
  }
  return { segments, length };
}

function frontPoint(front, t, rear, reverse) {
  const seg = front.segments.find((s) => t <= s.at + s.len) || front.segments.at(-1);
  const u = Math.max(0, Math.min(1, (t - seg.at) / seg.len));
  const normal = reverse ? -1 : 1;
  const fx = -seg.dz / seg.len * normal, fz = seg.dx / seg.len * normal;
  return { x: wrapX(seg.a.x + seg.dx * u - fx * rear), z: seg.a.z + seg.dz * u - fz * rear, facing: Math.atan2(fx, fz) };
}

export function deployLine(game, group, points, opts) {
  const line = polyline(points);
  if (line.length < .12 || line.length > 145) return { error: 'Draw a battle line across valid ground.' };
  game.nav.primeGroup(group, points[Math.floor(points.length / 2)]);
  const rows = [[], [], []];
  for (const u of group) {
    const d = ACTION_UNITS[u.type];
    if (!d.air) rows[d.cat === 'artillery' || d.cat === 'support' && !d.capture ? 2 : d.move === 'infantry' ? 0 : 1].push(u);
  }
  const reserved = new SpatialIndex(.7), placements = [], overflow = [];
  let unreachable = 0, placed = 0;
  for (let row = 0; row < rows.length; row++) {
    const list = rows[row];
    if (!list.length) continue;
    const first = line.segments[0], last = frontPoint(line, line.length, 0, opts.reverse);
    const dx = dxBetween(first.a.x, last.x), dz = last.z - first.a.z;
    list.sort((a, b) => (dxBetween(b.x, a.x) * dx + (a.z - b.z) * dz) || a.id - b.id);
    const space = row === 0 ? .40 : .60, fit = Math.min(list.length, Math.floor(line.length / space) + 1);
    const width = Math.min(line.length, Math.max((fit - 1) * space, line.length * .82));
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (i >= fit) { overflow.push(u.id); continue; }
      const at = fit === 1 ? line.length * .5 : (line.length - width) * .5 + i * width / (fit - 1);
      const p = frontPoint(line, at, row === 0 ? 0 : row === 1 ? .64 : 1.3, opts.reverse);
      const start = opts.queue && u.goal ? u.goal : u;
      const pick = candidate(game, u, p, reserved, .52, start);
      if (!pick) { placements.push([u.id, p.x, p.z, p.facing, 0]); unreachable++; continue; }
      placements.push([u.id, pick.slot.x, pick.slot.z, p.facing, distance(p, pick.slot) > .15 ? 2 : 1]);
      placed++;
      if (!opts.preview) assign(game, u, pick.slot, { ...opts, facing: p.facing }, pick.path);
    }
  }
  game.nav.activeFlows.clear();
  if (!opts.preview && !placed) return { error: 'No ground units fit that battle line.' };
  return { reply: { t: 'ack', deploy: { label: 'frontage', placed, unreachable, overflow, positions: placements } } };
}

export function chase(game, u, target, range) {
  const d = ACTION_UNITS[u.type], len = distance(u, target);
  if (len <= range * .90 && game.nav.clearShot(u, target)) return;
  const a = Math.atan2(dxBetween(target.x, u.x), u.z - target.z);
  const angles = [0, .55, -.55, 1.08, -1.08];
  for (const delta of angles) {
    const p = { x: wrapX(target.x + Math.sin(a + delta) * range * .72), z: target.z + Math.cos(a + delta) * range * .72 };
    const spot = game.nav.nearest(p, d, .50);
    if (!spot || !d.air && !game.nav.clearShot(spot, target)) continue;
    const path = game.nav.route(u, spot, d);
    if (!path) continue;
    startOrder(game, u, { goal: spot, mode: 'assault', path });
    return;
  }
}

export function unitMotion(game) {
  const near = [], index = game.movers;
  index.clear();
  for (const u of game.units.values()) if (!ACTION_UNITS[u.type].air) index.add(u);
  const phase = game.tickN;
  game.nav.beginTraffic(game.units);
  for (const u of game.units.values()) {
    u.waitingCrossing = false;
    const def = ACTION_UNITS[u.type];
    if (u.tacticalResume && game.time >= u.tacticalUntil) stopUnit(game, u, true);
    if (def.air) {
      const target = u.grounded ? .045 : def.alt === 'high' ? u.type === 'bomber' ? 2.6 : 2 : u.type === 'helicopter' ? .75 : 1.05;
      u.altitude = Math.max(.045, u.altitude + Math.max(-.12, Math.min(.082, (target - u.altitude) * .15)));
    }
    if (!u.goal) {
      if (u.alignFacing != null) { u.yaw = turn(u.yaw, u.alignFacing, DT * 1.25); if (Math.abs(angleDelta(u.yaw,u.alignFacing)) < .015) u.alignFacing = null; }
      u.vx = u.vz = u.speed = 0; continue;
    }
    // W2: crew-served guns (def.setup) halt for their target even while an attack-move has turned them aside
    // (tacticalResume), at the full range they acquire at (+.45), stay set up while the target is only hidden
    // by battlefield smoke. Direct-fire guns (def.setupHold) also keep their position for a moment after a shot, so
    // they retarget once the target dies instead of packing up and walking into the enemy (mortars still re-lay).
    if (!def.air && (!u.tacticalResume || def.setup) && u.mode === 'assault') {
      const target = u.target && (game.units.get(u.target) || game.buildings.get(u.target));
      if (target && (game.time - u.lastCombat < 2.1 || def.setup && (u.setupUntil || u.deployed)) &&
        distance(u, target) < def.range + (def.setup ? .45 : 0) && (game.sees(game.civs[u.owner], target) || def.setup && u.deployed)) { u.vx = u.vz = u.speed = 0; continue; }
      if (def.setupHold && u.deployed && game.time - u.lastCombat < def.setupHold) { u.vx = u.vz = u.speed = 0; continue; }
    }
    let p = u.path[0];
    if (!p) { stopUnit(game, u, true); continue; }
    if (distance(u, p) <= (u.path.length > 1 ? Math.max(.045, Math.min(.12, u.speed * .36)) : .045)) {
      u.path.shift();
      p = u.path[0];
      if (!p) { stopUnit(game, u, true); continue; }
    }
    const dx = dxBetween(u.x, p.x), dz = p.z - u.z;
    let desired = Math.atan2(dx, dz);
    const length = Math.hypot(dx, dz), vehicle = !def.air && def.move !== 'infantry';
    let followingSpeed = Infinity;
    if (vehicle) {
      index.query(u.x,u.z,def.radius + .85,near);
      const sn = Math.sin(desired), cs = Math.cos(desired);
      const front = near.find((v) => {
        if (v === u || v.hp <= 0) return false;
        const x = dxBetween(u.x,v.x), z = v.z-u.z, gap = x*sn+z*cs;
        return gap > 0 && gap < def.radius+ACTION_UNITS[v.type].radius+.23 && Math.abs(x*cs-z*sn) < def.radius+ACTION_UNITS[v.type].radius+.03;
      });
      if (front) {
        const sameDirection = (front.vx*sn+front.vz*cs) > .035;
        if (sameDirection && game.allied(u.owner,front.owner) && ACTION_UNITS[front.type].move !== 'infantry') {
          // match the vehicle ahead; only ease off when closer than a comfortable gap (no compounding slow-down down a column)
          const x = dxBetween(u.x,front.x), z = front.z-u.z, gap = x*sn+z*cs, tight = gap < def.radius+ACTION_UNITS[front.type].radius+.10;
          followingSpeed = Math.max(.015,Math.hypot(front.vx,front.vz)*(tight ? .8 : 1));
        }
        else { u.avoidSide ||= 1; u.avoidUntil = game.time+.60; desired += .70*u.avoidSide; }
      } else if (u.avoidUntil > game.time) desired += .40*u.avoidSide*(u.avoidUntil-game.time)/.60;
    }
    const c = game.nav.cost(u.tile, u.x, u.z, def);
    const terrainPace = def.air ? 1 : TERRAIN_PACE(c / (OPEN_COST[def.move] || 1));
    let pace = def.air ? def.speed : def.speed * GROUND_PACE * terrainPace;   // aircraft_systems is drop tanks now (actionAir)
    if (u.convoy && u.convoySpeed && !def.air) {
      // Convoy pace: the group's leader (the member nearest its slot) holds the slowest member's speed;
      // members lagging well behind drive at their own speed until they close up.
      const convoys = game.convoys ??= new Map();
      let cv = convoys.get(u.convoy);
      if (!cv) { cv = { lead: Infinity, next: Infinity, tick: phase }; convoys.set(u.convoy, cv); }
      if (cv.tick !== phase) { cv.lead = cv.next; cv.next = Infinity; cv.tick = phase; }
      const remaining = distance(u, u.goal);
      cv.next = Math.min(cv.next, remaining);
      if (!(remaining > cv.lead + 1.3)) pace = Math.min(pace, u.convoySpeed * terrainPace);
      if (phase % 200 === 0) for (const [id, other] of convoys) if (phase - other.tick > 50) convoys.delete(id);
    }
    if (u.hasteUntil > game.time) pace *= 1.35;   // B: Improved Logistics, fresh reinforcements heading to their rally point
    const turnRate = def.air ? 3 : !vehicle ? 7 : def.move === 'wheeled' ? 1.65 : 1.25;
    const headingError = Math.abs(angleDelta(u.yaw, desired));
    const corner = vehicle ? Math.max(0, Math.cos(headingError)) ** 2 : 1;
    const braking = vehicle && u.path.length === 1 ? Math.min(1, Math.sqrt(Math.max(.015, length) / .35)) : 1;
    const targetSpeed = Math.min(followingSpeed,(u.target && u.mode === 'assault' && !def.air ? pace * .45 : pace) * corner * braking);
    u.speed += Math.max(-pace * DT * 3.0, Math.min(pace * DT * 1.7, targetSpeed - u.speed));
    const yaw = turn(u.yaw, desired, DT * turnRate);
    const diff = Math.abs(angleDelta(yaw, desired));
    const step = Math.min(length, u.speed * DT * (def.move === 'infantry' || def.air ? 1 : Math.max(.08, Math.cos(diff))));
    const ox = u.x, oz = u.z;
    u.yaw = yaw;
    if (!def.air) index.query(ox, oz, def.radius + .56 + step, near);
    // Friendly ground: inside our own team's territory allied units may brush past each other (half
    // the clearance), and a unit that has made no progress for a while briefly ghosts through allies.
    const owner = game.world.owner?.[u.tile] ?? -1;
    const homeGround = owner >= 0 && game.allied(u.owner, owner), ghost = u.ghostUntil > game.time;
    const allowed = (x, z) => game.nav.canMove(u, x, z, def) && (def.air || near.every((v) => {
      if (v === u || v.hp <= 0) return true;
      const friend = game.allied(u.owner, v.owner);
      if (ghost && friend) return true;
      const r = (def.radius + ACTION_UNITS[v.type].radius) * (homeGround && friend ? .5 : 1) + .016;
      const after = dxBetween(x, v.x) ** 2 + (v.z - z) ** 2;
      return after >= r * r || after > dxBetween(ox, v.x) ** 2 + (v.z - oz) ** 2 + .000001;
    }));
    const dir = vehicle ? yaw : desired;
    let nx = wrapX(ox + Math.sin(dir) * step), nz = oz + Math.cos(dir) * step;
    if (!game.nav.trafficAllows(u, nx, nz, def)) { u.waitingCrossing = true; u.vx = u.vz = 0; continue; }
    let ok = allowed(nx, nz);
    if (!ok && !def.air) {
      const bias = u.id % 2 ? 1 : -1;
      for (const a of SIDESTEPS) {
        const angle = vehicle ? yaw + Math.sign(a) * turnRate * DT * bias : desired + a * bias;
        nx = wrapX(ox + Math.sin(angle) * step * .83);
        nz = oz + Math.cos(angle) * step * .83;
        if (allowed(nx, nz)) { ok = true; u.yaw = vehicle ? angle : turn(yaw, angle, DT * 3.7); break; }
      }
    }
    if (ok && step > .0001) {
      u.x = nx; u.z = nz;
      u.vx = dxBetween(ox, nx) / DT; u.vz = (nz - oz) / DT;
      const nextTile = tileAt(nx, nz);
      if (nextTile !== u.tile && !def.air) addWear(game, nextTile, def.move);
      u.tile = nextTile;
      if (!def.air) index.moved(u, ox, oz);
      u.blocked = 0;
    } else {
      u.vx = u.vz = 0;
      if (vehicle) u.speed = Math.max(0, u.speed - pace * DT * 3);
      u.blocked++;
      if (vehicle && u.blocked % 9 === 0) { u.avoidSide = -(u.avoidSide || 1); u.avoidUntil = game.time + .8; }
      if (!def.air && u.blocked > 8 && (phase + u.id) % 7 === 0) {
        for (const v of near) {
          if (v === u || v.goal || v.formation || v.braced || !game.allied(u.owner, v.owner) || distance(u, v) > .8) continue;
          const vd = ACTION_UNITS[v.type], side = (u.id + v.id) % 2 ? 1 : -1;
          if (vd.move !== 'infantry') continue;
          for (const sign of [side, -side]) {
            const vx = wrapX(v.x + Math.cos(desired) * .06 * sign), vz = v.z - Math.sin(desired) * .06 * sign;
            if (!game.nav.canMove(v, vx, vz, vd) || index.query(vx, vz, .65, []).some((q) => q !== v && q !== u && distance(q, { x: vx, z: vz }) < q.radius + vd.radius + .015)) continue;
            const oldX = v.x, oldZ = v.z;
            v.x = vx; v.z = vz; v.tile = tileAt(vx, vz); index.moved(v, oldX, oldZ);
            break;
          }
          break;
        }
      }
      if (u.blocked >= 7 && distance(u, u.goal) < .25) stopUnit(game, u, true);
      else if (u.blocked > 12 && (phase + u.id) % 13 === 0) {
        const route = game.nav.route(u, u.goal, def);
        if (route) u.path = route;
        else if (u.blocked > 60) stopUnit(game, u, true);
      }
    }
    if (!def.air && u.goal) stallCheck(game, u, def);
  }
}

// Progress watchdog. Sidesteps keep `blocked` at zero while a unit jiggles in place, so progress is
// measured against the current waypoint instead: no gain for 2.5 s near the destination means the
// slot is taken (halt there, the formation is close enough); no gain for 4 s elsewhere means a jam
// (ghost through allies and re-plan); a minute with no progress gives up.
function stallCheck(game, u, def) {
  const wp = u.path[0] || u.goal, d = distance(u, wp);
  if (u.path.length !== u.stallLen || d < (u.stallBest ?? Infinity) - .04) { u.stallLen = u.path.length; u.stallBest = d; u.stall = 0; return; }
  u.stall = (u.stall || 0) + 1;
  const toGoal = distance(u, u.goal);
  if (u.stall >= 25 && toGoal < .9 + def.radius * 2) { stopUnit(game, u, true); return; }
  if (u.stall % 40 === 0) {
    u.ghostUntil = game.time + 2.5;
    // wedged against a structure (a new wreck or building placed on top of it): step to the nearest free spot
    if (!game.nav.canStand(u.x, u.z, def)) {
      const spot = game.nav.nearest(u, def, .7);
      if (spot) { const ox = u.x, oz = u.z; u.x = spot.x; u.z = spot.z; u.tile = tileAt(u.x, u.z); game.movers.moved(u, ox, oz); }
    }
    const route = game.nav.route(u, u.goal, def);
    if (route) { u.path = route; u.stallLen = route.length; u.stallBest = distance(u, route[0]); }
  }
  if (u.stall > 600) stopUnit(game, u, true);
}
