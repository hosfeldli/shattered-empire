import { DT, N } from './constants.js';
import { NB } from './hex.js';
import { hash2 } from './rng.js';
import { ACTION_UNITS, ACTION_BUILDINGS } from './actionDefinitions.js';
import { centerOf, distance, HEAVY_GROUND, LIGHT_GROUND, structureOnSegment, tileAt } from './actionNavigation.js';
import { moveGroup, stopUnit } from './actionOrders.js';
import { emit } from './combat.js';
import { applyTerrain, engineerStep as baseEngineers } from './actionEngineers.js';
import { roadEdgesCost } from './actionMap.js';

export function seedMaterialCaches(game) {
  const add = (site, index, amount, radius, replenishes = false) => {
    const angle = hash2(site.tile, index, game.seed + 1783) * Math.PI * 2;
    const point = game.nav.nearest({ x: site.x + Math.sin(angle) * radius, z: site.z + Math.cos(angle) * radius }, LIGHT_GROUND, 1.1);
    if (!point || [...game.materialCaches.values()].some((c) => distance(c, point) < .8)) return;
    const id = game.id_();
    game.materialCaches.set(id, { id, ...point, tile: tileAt(point.x, point.z), amount, active: true, replenishes, respawnAt: 0, collectedBy: -1 });
  };
  for (const site of game.sites.filter((s) => s.slots)) {
    if (site.start !== undefined) { add(site, 0, 55, 3.2); add(site, 1, 55, 4.4); add(site, 2, 110, 6.1); }
    else { add(site, 3, 110, 2.9); if (site.kind === 'industrial' || site.kind === 'military') add(site, 4, 55, 3.6, true); }
  }
}

export function visibleCaches(game, civ, god = false) {
  const result = [];
  for (const c of game.materialCaches.values()) {
    if (god || civ.visible[c.tile]) {
      if (!c.active) { civ.cacheIntel.delete(c.id); continue; }
      const record = { id: c.id, tile: c.tile, x: c.x, z: c.z, resource: 'materials', amount: c.amount, memory: false, replenishes: c.replenishes };
      civ.cacheIntel.set(c.id, record); result.push(record);
    } else if (civ.cacheIntel.has(c.id)) result.push({ ...civ.cacheIntel.get(c.id), memory: true });
  }
  return result;
}

export function collectOrder(game, civ, ids, cache, queue) {
  const c = game.materialCaches.get(cache);
  if (!c?.active || !civ.visible[c.tile]) return { error: 'Choose a currently visible Materials cache.' };
  const group = ids.filter((u) => !ACTION_UNITS[u.type].air);
  if (!group.length) return { error: 'Mobile ground units collect Materials. Aircraft cannot collect ground caches.' };
  return moveGroup(game, group, c, { mode: 'move', exact: true, queue });
}

function cacheStep(game) {
  for (const c of game.materialCaches.values()) {
    if (!c.active) {
      if (!c.replenishes || game.time < c.respawnAt) continue;
      // Supply drops never appear beneath a waiting army.
      if (game.movers.query(c.x, c.z, 1.5, []).some((u) => u.hp > 0)) { c.respawnAt = game.time + 12; continue; }
      c.active = true; continue;
    }
    const near = game.movers.query(c.x, c.z, .64, []).filter((u) => u.hp > 0 && !ACTION_UNITS[u.type].air &&
      game.civs[u.owner].alive && distance(c, u) <= .25 + u.radius);
    near.sort((a, b) => distance(c, a) - distance(c, b) || (a.id ^ c.id) - (b.id ^ c.id));
    const collector = near[0]; if (!collector) continue;
    const civ = game.civs[collector.owner]; civ.res.materials += c.amount;
    c.active = false; c.collectedBy = collector.owner; c.respawnAt = c.replenishes ? game.time + 180 : 0;
    civ.cacheIntel.delete(c.id);
    emit(game, { k: 'pickup', a: c.tile, ax: c.x, az: c.z, ow: collector.owner, s: collector.id, cache: c.id, amount: c.amount, resource: 'materials' });
  }
}

// Player-controlled engineers from older saves keep their former support behaviour; base engineers
// (u.auto) are driven by actionEngineers.js.
function engineerStep(game, dt) {
  for (const u of game.units.values()) {
    if (u.type !== 'engineer' || u.auto) continue;
    u.assisting = false;
    if (game.time - u.lastCombat < 4 || u.attack || u.orders.length || u.mode === 'assault') {
      if (u.supportTask && u.goal && !u.attack && !u.orders.length) { stopUnit(game, u); u.mode = 'guard'; }
      u.supportTask = null; continue;
    }
    let target = u.supportTask ? game.units.get(u.supportTask) || game.buildings.get(u.supportTask) : null;
    const eligible = (v) => v.id !== u.id && v.hp > 0 && game.allied(u.owner, v.owner) &&
      (v.isUnit ? ['tracked', 'wheeled'].includes(ACTION_UNITS[v.type].move) && game.time - v.lastCombat > 4 && v.hp < v.maxHp : !v.done || v.hp < v.maxHp);
    if (!target || !eligible(target) || distance(u, target) > 7) { target = null; u.supportTask = null; }
    if (!target && !u.goal && game.time >= (u.supportBlockedUntil || 0) && ['guard', 'hold', 'defend', 'move'].includes(u.mode)) {
      const options = game.targets.query(u.x, u.z, 5.5, []).filter((v) => eligible(v) && game.sees(game.civs[u.owner], v) && (u.mode !== 'hold' || distance(u, v) <= v.radius + .70));
      options.sort((a, b) => distance(u, a) - distance(u, b) + (a.done === false ? -.6 : 0) - (b.done === false ? -.6 : 0) || a.id - b.id);
      target = options[0]; if (target) { u.supportTask = target.id; u.supportAt = game.time; }
    }
    if (!target) continue;
    const reach = target.radius + .70;
    if (distance(u, target) <= reach) {
      if (u.goal) { stopUnit(game, u); u.mode = 'guard'; }
      u.assisting = true;
      if (target.done !== false) target.hp = Math.min(target.maxHp, target.hp + dt * (target.isUnit ? 4.5 : 13) * (game.civs[u.owner].techs.has('field_engineering') ? 1.25 : 1));
      continue;
    }
    if (game.time - u.supportAt > 18) {
      stopUnit(game, u); u.mode = 'guard'; u.supportTask = null; u.supportBlockedUntil = game.time + 5; continue;
    }
    if (u.mode === 'hold' || u.goal) continue;
    const angle = Math.atan2(u.x - target.x, u.z - target.z);
    const point = game.nav.nearest({ x: target.x + Math.sin(angle) * reach * .85, z: target.z + Math.cos(angle) * reach * .85 }, ACTION_UNITS.engineer, .5);
    if (point) moveGroup(game, [u], point, { mode: 'move' });
  }
}

// W2: player roads stay out of base foundations. An edge whose segment passes within ROAD_FOUNDATION of any base
// site's centre would cross the building ring's pads; the automatic hub spokes (connectSiteRoads) already run
// straight to the centre, and the client hides street geometry within 3.6 of a base.
export const ROAD_FOUNDATION = 2.7;
function crossesFoundation(game, a, b) {
  const p = centerOf(a), q = centerOf(b);
  return game.sites.find((s) => s.slots && [0, .25, .5, .75, 1].some((t) =>
    distance(s, { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }) < ROAD_FOUNDATION)) || null;
}

// Why a road edge was skipped (2026-11-17: a stroke builds every edge it can and skips the rest, like the
// terrain brush; the order is refused only when no edge remains). Codes match the earlier whole-stroke refusals.
const ROAD_SKIP = {
  route: 'No suitable road or bridge route connects those locations.',
  hidden: 'Scout the road route so its construction sites are currently visible.',
  territory: "Roads go on your own territory or neutral ground, never through another player's territory.",
  hostile: 'Road construction cannot enter an active hostile headquarters compound.',
  foundation: 'Roads cannot be built through a base foundation; the base links its own roads to the hub.',
  blocked: 'The road route runs through a structure: draw it around the structure.',
};

/**
 * Command `roadBuild`: lay a paved road along a drawn stroke. Every edge of the route that can be built is
 * kept; edges that cannot (not visible, outside your territory, in a base foundation, through a building, a
 * hostile compound) are skipped and listed in `skipped` ({ from, to, why }). Refused only when nothing remains.
 */
export function roadBuild(game, civ, points, preview = false) {
  if (points.length < 2) return { error: 'Draw a road between two known locations.' };
  const edges = new Map(), skipped = [], why = {}, labels = {};
  let seenTiles = 0;
  const skip = (from, to, code, label) => {
    skipped.push({ a: from, b: to, from: centerOf(from), to: centerOf(to), why: code });
    why[code] = (why[code] || 0) + 1;
    if (label) labels[code] ??= label;
  };
  for (let i = 1; i < points.length; i++) {
    const a = tileAt(points[i - 1].x, points[i - 1].z), b = tileAt(points[i].x, points[i].z);
    if (a < 0 || b < 0 || distance(points[i - 1], points[i]) > 42) return { error: 'Choose a shorter road route on the map.' };
    const route = game.nav.strategic(a, b, HEAVY_GROUND, true);
    if (!route) { why.route = (why.route || 0) + 1; continue; }
    for (let k = 1; k < route.length; k++) {
      const from = route[k - 1], to = route[k];
      const key = Math.min(from, to) + ':' + Math.max(from, to);
      if (edges.has(key)) continue;
      if (!civ.visible[from] || !civ.visible[to]) { skip(from, to, 'hidden'); continue; }
      // 2026-11-17: roads may cross your own or neutral ground, never another player's territory
      const foreign = (t) => game.world.owner[t] >= 0 && game.world.owner[t] !== civ.id;
      if (foreign(from) || foreign(to)) { skip(from, to, 'territory'); continue; }
      if (game.sites.some((s) => s.hq && game.hostile(civ.id, s.owner) && (distance(s, centerOf(from)) < 2.7 || distance(s, centerOf(to)) < 2.7))) { skip(from, to, 'hostile'); continue; }
      const existing = game.roads.usable(from, to); if (existing?.type >= 2 && existing.cond >= 95) continue;
      const foundation = crossesFoundation(game, from, to);
      if (foundation) {
        if (existing) continue;   // a hub spoke already serves the base: the route joins it, nothing is laid inside
        skip(from, to, 'foundation', `Roads cannot be built through the ${foundation.name || 'base'} foundation; the base links its own roads to the hub.`);
        continue;
      }
      // nor through a building's walls (any owner, ruins too)
      const wall = structureOnSegment(game, centerOf(from), centerOf(to), .16, { outposts: false });
      if (wall) { skip(from, to, 'blocked', `The road route runs through ${wall.label}: draw it around the structure.`); continue; }
      if (game.roadProjects.some((p) => p.edges?.some((e) => e.a === from && e.b === to || e.a === to && e.b === from))) continue;
      edges.set(key, { a: from, b: to });
      if (++seenTiles > 120) return { error: 'Draw the road in shorter sections.' };
    }
  }
  if (!edges.size && (skipped.length || why.route)) {
    // nothing buildable: refuse with the reason that covers most of the stroke
    const code = Object.entries(why).sort((x, y) => y[1] - x[1])[0][0];
    const refusal = { error: labels[code] || ROAD_SKIP[code], ...(['territory', 'foundation', 'blocked'].includes(code) && { code }) };
    // a preview still carries the skipped edges so the client can draw them red under the refusal
    return preview ? { ...refusal, reply: { t: 'ack', ...refusal, road: { positions: [], skipped, cost: { materials: 0 }, seconds: 0 } } } : refusal;
  }
  // NAV_BRIDGES.md: bridge segments (an end on a river hex) cost ROAD_BRIDGE_COST, the rest ROAD_EDGE_COST
  const cost = roadEdgesCost(game.world, edges.values());
  const positions = [...edges.values()].map((e) => ({ ...e, from: centerOf(e.a), to: centerOf(e.b) }));
  const seconds = Math.max(3, Math.min(14, edges.size * 1.1));
  if (preview) return { reply: { t: 'ack', road: { positions, skipped, cost: { materials: cost }, seconds } } };
  if (!edges.size) return { error: 'That route already has an operational paved road or construction in progress.' };
  if (civ.res.materials < cost) return { error: `Road construction requires ${cost} Materials.` };
  // review S: the project limit is per player, not shared by every player
  if (game.roadProjects.filter((p) => !p.auto && p.owner === civ.id && p.kind !== 'terrain').length >= 24) return { error: 'Finish an existing road project first.' };
  civ.res.materials -= cost;
  // built by the base engineers, edge by edge (actionEngineers.js)
  game.roadProjects.push({ id: game.id_(), owner: civ.id, edges: [...edges.values()], left: seconds, total: seconds });
  return { edges: edges.size, skipped: skipped.length, cost: { materials: cost } };
}

export function fieldEconomyStep(game, dt) {
  cacheStep(game); engineerStep(game, dt); baseEngineers(game, dt);
  for (let i = game.roadProjects.length - 1; i >= 0; i--) {
    // automatic links lay themselves; player roads and terrain works advance only while engineers work them
    const p = game.roadProjects[i]; if (p.auto) p.left -= dt;
    if (p.left > 0) continue;
    if (p.kind === 'terrain') {
      applyTerrain(game, p); game.roadProjects.splice(i, 1);
      game.notify(p.owner, p.label || 'Terrain works complete.', { kind: 'build', tile: p.tile });
      continue;
    }
    for (const e of p.edges) game.roads.set(e.a, e.b, 2);
    // a finished road crossing a trench keeps it (2026-11-18): the trench hex becomes a covered crossing (plates
    // carry the road over the slot, TRENCHES.md); trenches never affect movement. The trench records' road masks
    // change with the road, so the works are re-sent.
    if (game.fieldworks?.size) game.fwVer++;
    game.nav.invalidate(); game.roadProjects.splice(i, 1);
    game.notify(p.owner, p.label || 'Road connection complete.', { kind: 'build', tile: p.edges[0].a });
  }
}
