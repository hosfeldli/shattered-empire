import { DT } from './constants.js';
import { ACTION_UNITS } from './actionDefinitions.js';
import { distance, dxBetween, SpatialIndex, tileAt, wrapX } from './actionNavigation.js';
import { addWear } from './battlefield.js';

const SIDESTEPS = [.34, -.34, .66, -.66, 1.04, -1.04, 1.48, -1.48];
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
  const order = { goal, mode: opts.mode, facing: opts.facing ?? null, path };
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
}

export function stopUnit(game, u, advance = false) {
  u.goal = null;
  u.path = [];
  u.vx = u.vz = u.speed = 0;
  if (u.destinationFacing != null) u.yaw = u.destinationFacing;
  u.destinationFacing = null;
  u.mode = u.mode === 'move' ? 'guard' : u.mode;
  if (advance && u.orders.length) {
    const next = u.orders.shift();
    next.path = null;
    startOrder(game, u, next);
  }
}

function candidate(game, u, point, reserved, max, start = u, preview = false) {
  const d = ACTION_UNITS[u.type], near = [];
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
  const base = ground[0] || air[0], a = Math.atan2(dxBetween(base.x, point.x), point.z - base.z);
  const sideX = Math.cos(a), sideZ = -Math.sin(a), fx = Math.sin(a), fz = Math.cos(a);
  const cols = Math.max(1, Math.ceil(Math.sqrt(ground.length * 1.5)));
  const rows = Math.ceil(ground.length / cols);
  const spacing = Math.max(.43, ...ground.map((u) => ACTION_UNITS[u.type].radius * 2 + .11));
  const reserved = new SpatialIndex(.70);
  let placed = 0;
  ground.sort((a, b) => a.id - b.id);
  for (let i = 0; i < ground.length; i++) {
    const u = ground[i], row = Math.floor(i / cols), width = Math.min(cols, ground.length - row * cols);
    const side = (i % cols - (width - 1) * .5) * spacing, forward = ((rows - 1) * .5 - row) * spacing;
    const p = { x: point.x + sideX * side + fx * forward, z: point.z + sideZ * side + fz * forward };
    const pick = candidate(game, u, p, reserved, opts.exact ? .45 : 1.55);
    if (!pick) continue;
    if (assign(game, u, pick.slot, opts, pick.path)) placed++;
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
    if (def.air) {
      const target = u.grounded ? .045 : def.alt === 'high' ? u.type === 'bomber' ? 2.6 : 2 : u.type === 'helicopter' ? .75 : 1.05;
      u.altitude = Math.max(.045, u.altitude + Math.max(-.12, Math.min(.082, (target - u.altitude) * .15)));
    }
    if (!u.goal) { u.vx = u.vz = 0; continue; }
    if (!def.air && u.mode === 'assault' && u.target && game.time - u.lastCombat < 2.1) {
      const target = game.units.get(u.target) || game.buildings.get(u.target);
      if (target && distance(u, target) < def.range && game.sees(game.civs[u.owner], target)) { u.vx = u.vz = u.speed = 0; continue; }
    }
    let p = u.path[0];
    if (!p) { stopUnit(game, u, true); continue; }
    if (distance(u, p) <= .045) {
      u.path.shift();
      p = u.path[0];
      if (!p) { stopUnit(game, u, true); continue; }
    }
    const dx = dxBetween(u.x, p.x), dz = p.z - u.z;
    const desired = Math.atan2(dx, dz), length = Math.hypot(dx, dz);
    const c = game.nav.cost(u.tile, u.x, u.z, def);
    const pace = def.speed * (def.air && game.civs[u.owner].techs.has('aircraft_systems') ? 1.18 : 1) / Math.max(.65, Number.isFinite(c) ? c : 1);
    const targetSpeed = u.target && u.mode === 'assault' && !def.air ? pace * .45 : pace;
    u.speed += Math.max(-pace * DT * 4, Math.min(pace * DT * 3.5, targetSpeed - u.speed));
    const yaw = turn(u.yaw, desired, DT * (def.air ? 3.0 : def.move === 'infantry' ? 7 : 3.8));
    const diff = Math.abs(angleDelta(yaw, desired));
    const step = Math.min(length, u.speed * DT * (def.move === 'infantry' || def.air ? 1 : Math.max(.08, Math.cos(diff))));
    const ox = u.x, oz = u.z;
    u.yaw = yaw;
    if (!def.air) index.query(ox, oz, def.radius + .56 + step, near);
    const allowed = (x, z) => game.nav.canMove(u, x, z, def) && (def.air || near.every((v) => {
      if (v === u || v.hp <= 0) return true;
      const r = def.radius + ACTION_UNITS[v.type].radius + .016;
      const after = dxBetween(x, v.x) ** 2 + (v.z - z) ** 2;
      return after >= r * r || after > dxBetween(ox, v.x) ** 2 + (v.z - oz) ** 2 + .000001;
    }));
    const dir = def.air || def.move === 'infantry' || length < .12 ? desired : yaw;
    let nx = wrapX(ox + Math.sin(dir) * step), nz = oz + Math.cos(dir) * step;
    if (!game.nav.trafficAllows(u, nx, nz, def)) { u.waitingCrossing = true; u.vx = u.vz = 0; continue; }
    let ok = allowed(nx, nz);
    if (!ok && !def.air) {
      const bias = u.id % 2 ? 1 : -1;
      for (const a of SIDESTEPS) {
        const angle = desired + a * bias;
        nx = wrapX(ox + Math.sin(angle) * step * .83);
        nz = oz + Math.cos(angle) * step * .83;
        if (allowed(nx, nz)) { ok = true; u.yaw = turn(yaw, angle, DT * 3.7); break; }
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
      u.blocked++;
      if (!def.air && u.blocked > 8 && (phase + u.id) % 7 === 0) {
        for (const v of near) {
          if (v === u || v.goal || v.formation || v.braced || !game.allied(u.owner, v.owner) || distance(u, v) > .8) continue;
          const vd = ACTION_UNITS[v.type], side = (u.id + v.id) % 2 ? 1 : -1;
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
  }
}
