// Formations: a deployment order turns a selection into a persistent formation plan (who stands
// where, facing, density, behaviour). Units walk to their slots; afterwards the plan decides
// whether they hold, defend nearby and return, or advance. A unit moved by hand is detached (the
// rest keep their places) and can rejoin; new units can reinforce the line.
import { UNITS, MOVE, TERRAIN, W, H, N, isWater } from './constants.js';
import { WRAP, dist } from './hex.js';
import { findPath } from './path.js';
import { tileCapacity } from './military.js';
import { planDeployment, deployRole, shiftFormation } from './deploy.js';

export const BEHAVIORS = ['hold', 'defend', 'attackMove'];
export const MODES = ['line', 'compact', 'depth', 'preserve'];

function env(g, civ, selection) {
  const sel = new Set(selection.map((u) => u.id));
  return {
    W, H, wrap: WRAP,
    passable: (t, u) => {
      if (t < 0 || t >= N) return false;
      const ter = g.world.terr[t]; if (isWater(ter) || !Number.isFinite(TERRAIN[ter].move)) return false;
      if (u && !Number.isFinite(MOVE[UNITS[u.type]?.move || 'infantry']?.terrain?.[ter] ?? 1)) return false;
      return !g.hostileAt || !g.hostileAt(civ.id, t);
    },
    capacity: (t) => tileCapacity(g, t),
    // own units already standing there and not part of this order still take room
    occupied: (t) => { let n = 0; for (const id of g.tileUnits.get(t) || []) { const o = g.units.get(id); if (o && !sel.has(id) && !UNITS[o.type].air && !o.path.length) n++; } return n; },
  };
}

const plannable = (u) => ({ id: u.id, tile: u.tile, type: u.type, role: deployRole(UNITS[u.type]), air: !!UNITS[u.type].air });

// the own city nearest a line: lines face away from it unless told otherwise
export function homeOf(g, civ, line) {
  let best = -1, bd = Infinity;
  for (const c of g.cities.values()) if (c.owner === civ.id) { const d = Math.min(dist(c.tile, line[0]), dist(c.tile, line[1])); if (d < bd) { bd = d; best = c.tile; } }
  return bd <= 25 ? best : -1;
}

export function formationOf(g, u) { return u.formation ? g.formations.get(u.formation) : null; }

// remove units from any formation they belong to (the formation dissolves when empty)
function release(g, ids) {
  for (const id of ids) {
    const u = g.units.get(id); if (!u || !u.formation) continue;
    const f = g.formations.get(u.formation);
    u.formation = 0; u.detached = false;
    if (!f) continue;
    f.units = f.units.filter((x) => x !== id); delete f.slots[id];
    if (!f.units.length) g.formations.delete(f.id);
  }
}

// send a unit to its slot (path or stay), with the formation's movement behaviour
function sendToSlot(g, civ, u, slot, f, groupSpeed) {
  u.order = { kind: f.behavior === 'attackMove' ? 'attackMove' : 'move' };
  u.auth = f.auth || ''; u.queue = []; u.retreating = false;
  u.goal = slot; u.slot = slot; u.wait = 0; u.status = 'ok'; u.field = false;
  u.groupSpeed = UNITS[u.type].air ? 0 : groupSpeed;
  if (f.behavior === 'hold' && !UNITS[u.type].civilian) u.stance = 'hold';
  else if (u.stance === 'hold') u.stance = 'defensive';
  const path = u.tile === slot ? [] : findPath(g, civ, u.tile, slot, u.type);
  u.path = path || [];
  if (path && path.partial) { u.slot = path[path.length - 1]; return 'partial'; }
  if (!path && u.tile !== slot) return 'unreachable';
  return 'ok';
}

// The deploy command. Returns the assignment (what the preview showed, now authoritative).
export function deployOrder(g, civ, cmd, auth = '') {
  const units = (cmd.units || []).map((id) => g.units.get(id)).filter((u) => u && u.owner === civ.id && !UNITS[u.type].civilian && UNITS[u.type].atk >= 0);
  if (!units.length) return { error: 'select units to deploy' };
  const line = Array.isArray(cmd.line) && cmd.line.length === 2 && cmd.line.every((t) => Number.isInteger(t) && t >= 0 && t < N) ? cmd.line : null;
  if (!line) return { error: 'draw a line to deploy on' };
  const mode = MODES.includes(cmd.mode) ? cmd.mode : 'line';
  const behavior = BEHAVIORS.includes(cmd.behavior) ? cmd.behavior : 'defend';
  const density = ['auto', 'spread', 'balanced', 'tight'].includes(cmd.density) ? cmd.density : 'auto';
  const depth = [1, 2, 3].includes(cmd.depth) ? cmd.depth : 'auto';
  // queued deployments wait behind the current order
  if (cmd.queue) {
    const key = (g.deployKey = (g.deployKey || 0) + 1);
    for (const u of units) { (u.queue || (u.queue = [])).push({ deploy: { ...cmd, queue: false, key, units: units.map((x) => x.id) }, tile: line[0] }); if (u.order.kind === 'idle' && !u.path.length) { u.queue.pop(); } }
    if (units.every((u) => u.order.kind === 'idle' && !u.path.length)) return deployOrder(g, civ, { ...cmd, queue: false }, auth);
    return { reply: { t: 'ack', deploy: { queued: units.length } } };
  }
  const e = env(g, civ, units);
  const away = cmd.away === false ? -1 : homeOf(g, civ, line);
  let plan;
  if (mode === 'preserve') {
    // keep relative positions: translate/rotate the current arrangement onto the new line
    const cur = new Map(units.map((u) => [u.id, u.slot >= 0 && u.formation ? u.slot : u.tile]));
    const old = units[0].formation && g.formations.get(units[0].formation);
    const fromLine = old ? old.line : [units[0].tile, units[units.length - 1].tile];
    const slots = shiftFormation(e, cur, fromLine, line);
    const perHex = new Map(); for (const t of slots.values()) perHex.set(t, (perHex.get(t) || 0) + 1);
    plan = { slots, perHex, overflow: units.filter((u) => !slots.has(u.id)).map((u) => u.id), invalid: [], label: Math.max(0, ...perHex.values()) >= 4 ? 'dense' : Math.max(0, ...perHex.values()) >= 2 ? 'concentrated' : 'dispersed', ranks: 0, line };
  } else plan = planDeployment(e, units.map(plannable), line, { mode, density, depth, reverse: !!cmd.reverse, away });
  release(g, units.map((u) => u.id));
  const id = g.nextFormationId = (g.nextFormationId || 0) + 1;
  const f = { id, owner: civ.id, units: [], mode, density, depth, behavior, line: plan.line?.length ? [plan.line[0], plan.line[plan.line.length - 1]] : line, reverse: !!cmd.reverse, away,
    slots: {}, status: 'moving', auth, since: g.time, facing: plan.facing || null };      // deploying never creates a construction job
  g.formations.set(id, f);
  const ground = units.filter((u) => !UNITS[u.type].air);
  const groupSpeed = ground.length >= 3 ? Math.min(...ground.map((u) => UNITS[u.type].speed)) : 0;
  const result = { formation: id, placed: 0, partial: 0, unreachable: 0, overflow: plan.overflow, invalid: plan.invalid.length, label: plan.label, perHex: [...plan.perHex.entries()], slots: [] };
  for (const u of units) {
    const slot = plan.slots.get(u.id);
    if (slot == null) continue;            // overflow: stays where it is, reported
    f.units.push(u.id); f.slots[u.id] = slot; u.formation = id; u.detached = false;
    const r = sendToSlot(g, civ, u, slot, f, groupSpeed);
    if (r === 'ok') result.placed++; else if (r === 'partial') result.partial++; else result.unreachable++;
    result.slots.push([u.id, slot]);
  }
  if (!f.units.length) g.formations.delete(id);
  return { reply: { t: 'ack', deploy: result } };
}

// formation management: reinforce, shift (keep shape), rejoin, behaviour, dissolve
export function formationCommand(g, civ, cmd, auth = '') {
  const f = g.formations.get(cmd.id);
  if (!f || f.owner !== civ.id) return { error: 'no such formation' };
  const members = () => f.units.map((id) => g.units.get(id)).filter(Boolean);
  switch (cmd.op) {
    case 'behavior': {
      if (!BEHAVIORS.includes(cmd.behavior)) return { error: 'unknown behaviour' };
      f.behavior = cmd.behavior;
      for (const u of members()) { if (cmd.behavior === 'hold') u.stance = 'hold'; else if (u.stance === 'hold') u.stance = 'defensive'; }
      return null;
    }
    case 'dissolve': release(g, [...f.units]); g.formations.delete(f.id); return null;
    case 'rejoin': {
      const ids = new Set(cmd.units || f.units);
      const e = env(g, civ, members());
      for (const u of members()) {
        if (!ids.has(u.id)) continue;
        let slot = f.slots[u.id];
        if (!(slot >= 0) || !e.passable(slot, u)) { const p = planDeployment(e, [plannable(u)], f.line, { mode: f.mode, density: f.density, away: f.away, reverse: f.reverse, keep: new Map(Object.entries(f.slots).filter(([k]) => +k !== u.id).map(([k, v]) => [+k, v])) }); slot = p.slots.get(u.id); }
        if (slot == null) continue;
        f.slots[u.id] = slot; u.detached = false; sendToSlot(g, civ, u, slot, f, 0);
      }
      return null;
    }
    case 'reinforce': {
      // new units fill free capacity on the existing line (and rear ranks) without moving the others
      const add = (cmd.units || []).map((id) => g.units.get(id)).filter((u) => u && u.owner === civ.id && !f.units.includes(u.id) && !UNITS[u.type].civilian);
      if (!add.length) return { error: 'select units to add' };
      release(g, add.map((u) => u.id));
      const keep = new Map(Object.entries(f.slots).map(([k, v]) => [+k, v]));
      const e = env(g, civ, [...members(), ...add]);
      const p = planDeployment(e, [...members().map(plannable), ...add.map(plannable)], f.line, { mode: f.mode, density: f.density, depth: f.depth, reverse: f.reverse, away: f.away, keep });
      let placed = 0;
      for (const u of add) { const s = p.slots.get(u.id); if (s == null) continue; f.units.push(u.id); f.slots[u.id] = s; u.formation = f.id; sendToSlot(g, civ, u, s, f, 0); placed++; }
      return { reply: { t: 'ack', reinforce: { placed, overflow: add.length - placed } } };
    }
    case 'shift': {
      const line = Array.isArray(cmd.line) && cmd.line.length === 2 && cmd.line.every((t) => Number.isInteger(t) && t >= 0 && t < N) ? cmd.line : null;
      if (!line) return { error: 'bad line' };
      const e = env(g, civ, members());
      const cur = new Map(Object.entries(f.slots).map(([k, v]) => [+k, v]));
      const slots = shiftFormation(e, cur, f.line, line);
      f.line = line; f.status = 'moving';
      const ground = members().filter((u) => !UNITS[u.type].air);
      const gs = ground.length >= 3 ? Math.min(...ground.map((u) => UNITS[u.type].speed)) : 0;
      for (const u of members()) { const s = slots.get(u.id); if (s == null) continue; f.slots[u.id] = s; if (!u.detached) sendToSlot(g, civ, u, s, f, gs); }
      return null;
    }
    default: return { error: 'unknown formation operation' };
  }
}

// A direct order to some formation members detaches just those units (the rest keep their places
// and the detached can rejoin). Ordering the whole formation somewhere else simply ends it: the
// units go where they were sent and stay there, instead of being pulled back to an old line.
export function detach(g, ids) {
  const set = new Set(ids);
  const ended = [];
  for (const id of ids) {
    const u = g.units.get(id); if (!u || !u.formation) continue;
    const f = g.formations.get(u.formation); if (!f) continue;
    if (f.units.every((x) => set.has(x) || !g.units.has(x))) ended.push(id); else u.detached = true;
  }
  if (ended.length) release(g, ended);
}

// Every second: drop the dead, mark arrival, keep holders in place and bring defenders back.
export function formationsStep(g) {
  for (const f of [...g.formations.values()]) {
    const civ = g.civs[f.owner];
    f.units = f.units.filter((id) => { const u = g.units.get(id); if (!u || u.owner !== f.owner) { delete f.slots[id]; return false; } return true; });
    if (!f.units.length) { g.formations.delete(f.id); continue; }
    let arrived = 0, n = 0;
    for (const id of f.units) {
      const u = g.units.get(id); const slot = f.slots[id];
      if (u.detached) continue;
      n++;
      if (u.tile === slot) arrived++;
      const idle = !u.path.length && !u.field && (u.order.kind === 'idle' || u.order.kind === 'move' || u.order.kind === 'attackMove');
      if (!idle || u.retreating) continue;
      if (u.tile === slot) { if (u.order.kind !== 'idle' && f.status !== 'moving') u.order = { kind: 'idle' }; continue; }
      // defenders that chased a target come back once the area is quiet; holders never wander
      if (f.status === 'deployed' && (f.behavior !== 'attackMove')) {
        if (!u.tgt && dist(u.tile, slot) <= 8) { u.path = findPath(g, civ, u.tile, slot, u.type) || []; u.goal = slot; u.slot = slot; u.order = { kind: 'move' }; }
      }
    }
    if (f.status === 'moving' && n && arrived >= Math.ceil(n * 0.8)) {
      f.status = 'deployed';
      for (const id of f.units) { const u = g.units.get(id); if (u && !u.detached && u.tile === f.slots[id]) { u.order = { kind: 'idle' }; if (f.behavior === 'hold') u.stance = 'hold'; } }
    }
  }
}

export function formationsSnapshot(g, civId) {
  const out = [];
  for (const f of g.formations.values()) if (f.owner === civId) out.push({ id: f.id, units: f.units, mode: f.mode, density: f.density, behavior: f.behavior, line: f.line, status: f.status, slots: f.slots, detached: f.units.filter((id) => g.units.get(id)?.detached) });
  return out;
}
