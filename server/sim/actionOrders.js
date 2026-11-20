import { DT, T } from './constants.js';
import { ACTION_UNITS } from './actionDefinitions.js';
import { distance, dxBetween, HILL_PACE, OPEN_COST, SpatialIndex, tileAt, wrapX, trenchPosition } from './actionNavigation.js';
import { addWear } from './battlefield.js';
import { flyAircraft } from './actionFlight.js';
import { dist } from './hex.js';

const SIDESTEPS = [.34, -.34, .66, -.66, 1.04, -1.04, 1.48, -1.48];
// unitMotion: the longest step over a sliver of unstandable ground on a lane (matches actionNavigation LANE_STRIDE)
const LANE_HOP = .07;
// Pass 5 (vehicles never block pathing). Other units and wrecks are soft obstacles for a unit with an order: they are
// avoided while a way round exists, but they never hold it. A unit whose step is refused only by a wreck hull for
// PUSH.wreck ticks drives through the wreck (wreck pass, PUSH.pass seconds, renewed while it is still inside one).
// A unit whose step is refused only by other units' bodies for PUSH.units ticks (allies) or PUSH.foes ticks (hostile
// units) passes through them (ghost) for PUSH.pass seconds. Not within PUSH.goal of its own goal, where the crowd is
// the destination and the near-arrival rules apply. A unit kept off a single-lane crossing by oncoming traffic for
// PUSH.cross ticks enters anyway (the traffic it waits for may itself be stuck).
// A wreck is pushed through after PUSH.wreckEarly ticks held by it alone when the unit's path was planned through wrecks
// (route() found no wreck-free way and tagged the path `soft`), else after PUSH.wreck ticks in a row (time for sidesteps
// and a collision re-route to find the way round first).
export const PUSH = Object.freeze({ wreck: 25, wreckEarly: 3, units: 12, foes: 25, pass: 1.5, goal: .9, cross: 80, crossPass: 3 });
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
  if (u.groupJob) u.groupJob = 0;   // Pass 3: a new order replaces a queued group route (groupRouteStep)
  const order = { goal, mode: opts.mode, facing: opts.facing ?? null, path, convoy: opts.convoy || 0, convoySpeed: opts.convoySpeed || 0, ...(opts.capture && { capture: opts.capture }) };
  if (opts.queue && (u.goal || u.airOrder || u.attack || u.captureWait != null)) {
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
  // 2026-11-20: a capture order (order.capture: the site id) holds the queue at the site until the capture is decided
  u.captureSite = order.capture || 0; u.captureWait = null;
  if (order.kind === 'attack') {
    const target = game.units.get(order.target) || game.buildings.get(order.target);
    u.goal = null; u.path = []; u.target = 0;
    u.mode = 'assault'; u.attack = target?.hp > 0 ? target.id : null;
    if (!u.attack && u.orders.length) startOrder(game, u, u.orders.shift());
    return;
  }
  u.goal = order.goal;
  u.path = order.path || game.nav.route(u, order.goal, ACTION_UNITS[u.type]);
  // NAV_REDESIGN (no silent failure): a goal with no route is not a reason to stand still. The best way that exists
  // (nav.fallback: the nearest standable spot, the coarse corridor, or the nearest reachable ground in the unit's own
  // region) is taken instead; the reason is counted in game.navStats (fallbackGoal / fallbackFine / fallbackCut).
  if (!u.path) u.path = game.nav.fallback(u, order.goal, ACTION_UNITS[u.type]).path || [];
  u.mode = order.mode;
  u.destinationFacing = order.facing;
  u.blocked = 0;
  u.convoy = order.convoy || 0; u.convoySpeed = order.convoySpeed || 0;
  // stuck recovery (stallCheck): a fresh order starts a fresh ladder
  u.stall = 0; u.stallAx = u.x; u.stallAz = u.z; u.stallWx = u.stallWz = null; u.stallBest = Infinity;
  u.stuckReplans = 0; u.blockedReplans = 0; u.stuckEpisodes = 0; u.navVer = game.nav.terrainVersion; u.goalBest = Infinity; u.goalStall = 0;
  settleRoute(game, u);   // Pass 6: a deferred route of the old order is not wanted any more
}

// Pass 6 (routing budget): deferrable routes ask nav.mayRoute first. DEFERRED is what budgetRoute returns when the tick's
// budget is spent: the caller keeps the unit doing what it was doing and asks again later (actionNavigation.ROUTE_BUDGET).
export const DEFERRED = false;
// a goal this close in a straight, clear line is walked to without a search, budget or not (route() would return the same)
const DIRECT = 2.5;

/** A deferrable route for unit u: a path, null (no way there) or DEFERRED. */
export function budgetRoute(game, u, from, to, def, strict = false) {
  const nav = game.nav;
  if (def.air || nav.mayRoute(u)) return strict ? strictRoute(game, from, to, def) : nav.route(from, to, def);
  if (distance(from, to) < DIRECT && nav.canStand(to.x, to.z, def) && nav.line(from, to, def)) return [to];
  return DEFERRED;
}

/** Forget a unit's pending deferred route (a new order, a halt). */
function settleRoute(game, u) {
  if (u.replanWant) u.replanWant = 0;
  if (u.routeWait != null) game.nav.unqueue(u);
}

export function stopUnit(game, u, advance = false) {
  u.goal = null;
  settleRoute(game, u);
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
    if (resume.goal) {
      u.goal = resume.goal;
      const path = budgetRoute(game, u, u, resume.goal, ACTION_UNITS[u.type]);
      // Pass 6: deferred, the unit heads straight for its goal until the route comes (stallCheck, u.replanWant)
      if (path === DEFERRED) { u.path = [resume.goal]; u.replanWant = 1; } else u.path = path || [];
    }
    return;
  }
  // 2026-11-20 (queued capture): arrived at a site it was sent to capture, with more orders queued: it stays until the
  // capture is decided (captureWaitStep), then goes on
  if (advance && u.captureSite && u.orders.length && capturePending(game, u, game.time)) { u.captureWait = game.time; return; }
  if (advance && u.orders.length) {
    const next = u.orders.shift();
    next.path = null;
    startOrder(game, u, next);
  }
}

// N5 (perf): an order onto ground cut off from the unit (another island, across an unbridged river) made
// every unit exhaust a full A* search, twice. Once one route of a group order has failed, the connected
// land regions (nav.componentOf, built lazily) are consulted: when the unit and its slot lie in different
// regions the coarse search cannot succeed, so route() would only fall back to a straight line; that line
// test is all that is run. The result is identical to route()'s, without the search.
function groupRoute(game, from, to, d, ctx) {
  if (ctx) ctx.far = false;
  if (ctx && !d.air && (ctx.failed || game.nav.components?.[d.move])) {
    const ca = game.nav.componentOf(tileAt(from.x, from.z), d), cb = game.nav.componentOf(tileAt(to.x, to.z), d);
    if (ca >= 0 && cb >= 0 && ca !== cb) {
      const stats = game.navStats ??= {};
      stats.cutOff = (stats.cutOff || 0) + 1;
      return game.nav.canStand(to.x, to.z, d) && game.nav.line(from, to, d) ? [to] : null;
    }
  }
  // Pass 5: within one group order, a slot hex no corridor could thread from a start hex (the fine stage failed: a
  // pocket, a crowded court) is not searched again for the other members starting in the same hex. Late in a match
  // these repeated slot failures were all of the remaining failed routes (~190 a game minute, ~1 s of route time).
  const cls = d.move === 'infantry' ? 0 : d.move === 'wheeled' ? 1 : 2;
  const pair = ctx && !d.air ? tileAt(from.x, from.z) * 4194304 + tileAt(to.x, to.z) * 4 + cls : -1;
  if (pair >= 0 && ctx.fine?.has(pair)) { const stats = game.navStats ??= {}; stats.slotMemo = (stats.slotMemo || 0) + 1; return null; }
  // Pass 6: this class already failed from this start hex on the way (not at its slot), in this order: so would any slot
  const start = ctx && !d.air ? tileAt(from.x, from.z) * 4 + cls : -1;
  if (start >= 0 && ctx.away?.has(start)) { const stats = game.navStats ??= {}; stats.awayMemo = (stats.awayMemo || 0) + 1; ctx.far = true; return null; }
  const path = game.nav.route(from, to, d);
  if (!path && ctx && !d.air) {
    ctx.failed = true;
    if (game.nav.lastFail === 'fine') {
      (ctx.fine ??= new Set()).add(pair);
      // Pass 6: where the fine stage failed: more than SLOT_NEAR hexes from the slot (a lane on the way, a blocked
      // bridge deck), another slot nearby fails at the same step. Late in a match each such member cost six failed
      // routes (three slots, then three more in the wider ring), the largest share of all route time.
      const slot = tileAt(to.x, to.z), ft = game.nav.failTiles || [];
      ctx.far = ft.length > 0 && ft.every((t) => dist(t, slot) > SLOT_NEAR);
      if (ctx.far) (ctx.away ??= new Set()).add(start);
    }
  }
  return path;
}

function candidate(game, u, point, reserved, max, start = u, preview = false, ctx = null) {
  const d = ACTION_UNITS[u.type], near = [];
  if (d.move === 'infantry') point = trenchPosition(game, point, u.owner, .55) || point;
  // 2026-11-18: in a crowded court (a developed base) the nearest free spot can be a pocket between
  // structures that this hull cannot drive into. Try a few other spots (each failed one excluded) before
  // leaving the unit behind; bounded, so an unreachable order still costs at most `tries` searches.
  const failed = [], tries = d.air ? 1 : 3;
  for (let k = 0; k < tries; k++) {
    const slot = game.nav.nearest(point, d, max, (x, z) => {
      if (d.air) return true;
      if (failed.some((f) => (x - f.x) ** 2 + (z - f.z) ** 2 < .36)) return false;
      return reserved.query(x, z, .65, near).every((o) => distance(o, { x, z }) >= o.radius + d.radius + .06);
    });
    if (!slot) return null;
    const path = groupRoute(game, start, slot, d, ctx);
    if (!path) { failed.push(slot); if (ctx?.far) break; continue; }   // Pass 6: failed on the way: no other slot helps
    if (!d.air && !preview) reserved.add({ ...slot, radius: d.radius });
    return { slot, path };
  }
  return null;
}

function routeSlot(game, u, p, reserved, opts, routing) {
  if (routing) routing.far = false;
  return candidate(game, u, p, reserved, opts.exact ? .45 : 1.55, u, false, routing) || (!opts.exact && !routing?.far && candidate(game, u, p, reserved, 3.1, u, false, routing));
}
// Pass 6: a group route that failed farther than this (hexes) from its slot failed on the way there (groupRoute)
const SLOT_NEAR = 2;

// Pass 3 (perf, late game): an AI final assault or a large player selection used to route every member in the tick the
// order was given (40-80 fine routes: 400-900 ms ticks). The first `now` members are routed at once; the rest follow
// `perTick` a tick, oldest order first. Deterministic: the queue is part of the saved state (persist.js) and is worked
// at a fixed point of the tick (the start of unitMotion).
// `aiTick`: an AI plan that has already routed this many members in the tick (several group orders in one plan: an
// expansion sends many small groups) queues the members of its further orders whole, placed or not.
// Pass 6: `min`: queued members routed each tick even when the tick's routing budget (actionNavigation.ROUTE_BUDGET) is
// spent; past that they wait for a tick with budget left.
export const GROUP_ROUTE = Object.freeze({ now: 24, perTick: 16, aiTick: 48, min: 4 });

/** Routes queued members of earlier group orders, at most GROUP_ROUTE.perTick a tick. */
export function groupRouteStep(game) {
  const jobs = game.groupJobs;
  if (!jobs?.length) return;
  let budget = GROUP_ROUTE.perTick, routed = 0;
  while (budget > 0 && jobs.length) {
    if (routed >= GROUP_ROUTE.min && game.nav.budgetLeft() <= 0) break;   // Pass 6
    const job = jobs[0];
    // members still waiting for this job (alive, not given another order since); a member given a new move/deploy
    // order (assign) or a field order (ActionGame.command) has its groupJob cleared
    const live = job.rest.filter(([id]) => game.units.get(id)?.groupJob === job.id && game.units.get(id).hp > 0);
    if (!live.length) { jobs.shift(); continue; }
    const take = live.slice(0, budget);
    job.rest = live.slice(take.length);
    budget -= take.length;
    const members = take.map(([id]) => game.units.get(id));
    const reserved = new SpatialIndex(.70);
    for (const [x, z, radius] of job.slots) reserved.add({ x, z, radius });
    game.nav.beginBatch();
    try {
      // the flow field is primed for every member still to come, as the original order primed it for the whole group
      game.nav.primeGroup([...members, ...job.rest.map(([id]) => game.units.get(id)).filter(Boolean)], job);
      const routing = { failed: job.failed };
      for (let i = 0; i < take.length; i++) {
        // Pass 6: the tick's routing budget is spent: the rest of this chunk goes back to the front of the job
        if (routed >= GROUP_ROUTE.min && game.nav.budgetLeft() <= 0) { job.rest = take.slice(i).concat(job.rest); budget = 0; break; }
        routed++;
        const u = members[i]; u.groupJob = 0;
        const pick = routeSlot(game, u, { x: take[i][1], z: take[i][2] }, reserved, job.opts, routing);
        if (!pick && job.opts.unknown) { unknownGoal(game, u, { x: job.x, z: job.z }, job.opts); continue; }   // VISION
        if (!pick) continue;
        if (!ACTION_UNITS[u.type].air) job.slots.push([pick.slot.x, pick.slot.z, ACTION_UNITS[u.type].radius]);
        assign(game, u, pick.slot, job.opts, pick.path);
      }
      job.failed = routing.failed;
      game.nav.activeFlows.clear();
    } finally { game.nav.endBatch(); }
    if (!job.rest.length) jobs.shift();
  }
}

/** VISION: a member of an order into undiscovered ground with no route there: the nearest reachable ground toward it. */
function unknownGoal(game, u, point, opts) {
  const r = game.nav.routeOrNearest(u, point, ACTION_UNITS[u.type]);
  return assign(game, u, r.goal || { x: point.x, z: point.z }, opts, r.path || []);
}

/**
 * True while unit u should stay at the site of its capture order (u.captureSite) before its next queued order: the site
 * exists, has no headquarters, is not yet held by u's side, u can capture (def.capture) and stands in the zone, and it
 * has waited less than twice the capture time plus 30 s (a zone contested for ever does not hold the queue for ever).
 */
export function capturePending(game, u, since) {
  const site = game.siteById?.get(u.captureSite), def = ACTION_UNITS[u.type];
  if (!site || site.hq || !def.capture) return false;
  if (site.owner >= 0 && (site.owner === u.owner || game.allied(site.owner, u.owner))) return false;
  if (distance(u, site) > site.radius) return false;
  return game.time - since <= (site.captureTime || 20) * 2 + 30;
}

/** A unit waiting at a site it was capturing: once the capture is decided (taken, lost, left), its next order starts. */
function captureWaitStep(game, u) {
  if (u.orders.length && capturePending(game, u, u.captureWait)) return;
  u.captureWait = null; u.captureSite = 0;
  if (!u.orders.length) return;
  const next = u.orders.shift();
  next.path = null;
  startOrder(game, u, next);
}

export function moveGroup(game, group, point, opts = {}) {
  if (!group.length) return { error: 'Select units to give an order.' };
  game.nav.beginBatch();
  try { return moveGroupBatched(game, group, point, opts); } finally { game.nav.endBatch(); }
}

function moveGroupBatched(game, group, point, opts) {
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
  const routing = { failed: false }, left = [];
  // Pass 3 (perf, late game): a large group is routed GROUP_ROUTE.now units at a time. Once a member is placed, the
  // rest are queued in game.groupJobs and routed GROUP_ROUTE.perTick a tick (groupRouteStep), in the same order and
  // against the same reserved slots. Waiting members keep their current order until their turn.
  const ai = !!game.civs[ground[0]?.owner]?.isAI, spent = game.groupSpent ??= { tick: -1, n: 0 };
  if (spent.tick !== game.tickN) { spent.tick = game.tickN; spent.n = 0; }
  const defer = Array.isArray(game.groupJobs) && (ground.length > GROUP_ROUTE.now || ai) ? [] : null, slots = defer ? [] : null;
  if (slots) { const add = reserved.add.bind(reserved); reserved.add = (o) => { slots.push([o.x, o.z, o.radius]); add(o); }; }
  for (let i = 0; i < ground.length; i++) {
    const u = ground[i], row = Math.floor(i / cols), width = Math.min(cols, ground.length - row * cols);
    const side = (i % cols - (width - 1) * .5) * spacing, forward = ((rows - 1) * .5 - row) * spacing;
    const p = { x: point.x + sideX * side + fx * forward, z: point.z + sideZ * side + fz * forward };
    // Pass 6: an AI's order also queues its further members once the tick's routing budget is spent (one placed first)
    if (defer && (placed && i >= GROUP_ROUTE.now || ai && spent.n >= GROUP_ROUTE.aiTick || ai && placed && game.nav.budgetLeft() <= 0)) { defer.push([u.id, p.x, p.z]); continue; }
    spent.n++;
    // a crowded destination (a base court, a bridgehead) widens the slot search instead of leaving the unit behind
    const pick = routeSlot(game, u, p, reserved, opts, routing);
    if (!pick) { left.push(u); continue; }
    if (assign(game, u, pick.slot, orderOpts, pick.path)) placed++;
  }
  if (defer?.length) {
    const id = game.nextGroupJob = (game.nextGroupJob || 0) + 1;
    for (const [uid] of defer) game.units.get(uid).groupJob = id;
    game.groupJobs.push({ id, x: point.x, z: point.z, opts: { ...orderOpts }, rest: defer, slots, failed: routing.failed });
    placed += defer.length;   // reported as placed: each is routed within a few ticks (or left where it is)
  }
  for (let i = 0; i < air.length; i++) {
    const u = air[i], offset = (i - (air.length - 1) / 2) * Math.min(.32, 4 / air.length);
    const goal = game.nav.nearest({ x: point.x + sideX * offset, z: point.z + sideZ * offset }, ACTION_UNITS[u.type], .67);
    if (!goal) continue;
    if (assign(game, u, goal, opts, [goal])) placed++;
  }
  game.nav.activeFlows.clear();
  // VISION (2026-11-20): an order into ground the player has never discovered must not reveal whether that ground can
  // be reached (water, cliffs, a cut-off island). Members with no route there head for the best way that exists
  // (nav.routeOrNearest: the nearest reachable ground toward it) and the order is answered as placed, with no note.
  if (opts.unknown) {
    for (const u of left) if (unknownGoal(game, u, point, orderOpts)) placed++;
    return { placed, blocked: group.length - placed };
  }
  // NAV_BRIDGES (2026-11-18): say why vehicles stayed behind when only a road (a bridge) would let them through
  let crossing = 0;
  if (left.length) {
    const goalTile = tileAt(point.x, point.z);
    for (const u of left) if (game.nav.needsCrossing(u.tile, goalTile, ACTION_UNITS[u.type])) crossing++;
  }
  const why = crossing ? `${crossing === 1 ? 'A vehicle' : crossing + ' vehicles'} cannot cross there without a bridge: build a road across the river (or marsh) first.` : null;
  if (!placed) return { error: why || 'No selected unit can reach that ground: the way is blocked (water, cliffs, structures or wrecks).', ...(crossing && { code: 'bridge' }) };
  return { placed, blocked: group.length - placed, ...(crossing && { crossing, note: why }) };
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
  let reachable = air, blocked = 0, crossing = 0;
  const goalTile = tileAt(point.x, point.z);
  for (const u of probes) {
    const def = u.probe || ACTION_UNITS[u.type];
    const r = game.nav.reachability(u.probe ? { x: u.x, z: u.z, unknown: true } : u, point, def);
    if (r === 'ok') reachable++; else if (r === 'blocked') blocked++;
    else if (!u.probe && game.nav.needsCrossing(tileAt(u.x, u.z), goalTile, def)) crossing++;
  }
  const total = probes.length + air;
  // 'bridge' (NAV_BRIDGES.md): every unit that cannot reach is a vehicle a road across a river or marsh would let through
  const reason = reachable === total ? null : blocked ? 'impassable' : crossing === total - reachable ? 'bridge' : 'unreachable';
  return { reply: { t: 'ack', reach: { ok: reachable > 0, all: reachable === total, reachable, units: total, reason, ...(crossing && { crossing }) } } };
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
  game.nav.beginBatch();
  try { return deployLineBatched(game, group, points, opts); } finally { game.nav.endBatch(); }
}

function deployLineBatched(game, group, points, opts) {
  const line = polyline(points);
  if (line.length < .12 || line.length > 145) return { error: 'Draw a battle line across valid ground.' };
  game.nav.primeGroup(group, points[Math.floor(points.length / 2)]);
  const rows = [[], [], []];
  for (const u of group) {
    const d = ACTION_UNITS[u.type];
    if (!d.air) rows[d.cat === 'artillery' || d.cat === 'support' && !d.capture ? 2 : d.move === 'infantry' ? 0 : 1].push(u);
  }
  const reserved = new SpatialIndex(.7), placements = [], overflow = [], routing = { failed: false };
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
      const pick = candidate(game, u, p, reserved, .52, start, false, routing);
      // VISION (2026-11-20): a line slot on undiscovered ground is shown as placed (its reachability is unseen terrain)
      if (!pick && opts.unknown?.(p)) {
        placements.push([u.id, p.x, p.z, p.facing, 1]); placed++;
        if (!opts.preview) unknownGoal(game, u, p, { ...opts, facing: p.facing, unknown: undefined });
        continue;
      }
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

// NAV_BRIDGES (2026-11-18, late game): a chase that found no firing spot (the target across a river, inside a compound,
// on a cliff) is not tried again for the same target position for CHASE_BACKOFF ticks. Attack orders and attack-moves
// re-chase every 9 ticks per unit, and each attempt is up to five route searches: with many units facing an
// unreachable target this was a standing repath storm that grew with the armies.
const CHASE_BACKOFF = 40;
export function chase(game, u, target, range) {
  const d = ACTION_UNITS[u.type], len = distance(u, target);
  // inside a minimum range (def.minRange) the unit backs off: the stand-off spots below lie at range * .72 from the target
  if (len <= range * .90 && len >= (d.minRange || 0) && game.nav.clearShot(u, target)) return;
  const f = u.chaseFail;
  if (f && game.tickN - f.tick < CHASE_BACKOFF && (f.x - target.x) ** 2 + (f.z - target.z) ** 2 < 1 && (f.ux - u.x) ** 2 + (f.uz - u.z) ** 2 < 1) return;
  u.chaseFail = null;
  const a = Math.atan2(dxBetween(target.x, u.x), u.z - target.z);
  const angles = [0, .55, -.55, 1.08, -1.08];
  for (const delta of angles) {
    const p = { x: wrapX(target.x + Math.sin(a + delta) * range * .72), z: target.z + Math.cos(a + delta) * range * .72 };
    const spot = game.nav.nearest(p, d, .50);
    if (!spot || !d.air && !game.nav.clearShot(spot, target)) continue;
    const path = budgetRoute(game, u, u, spot, d);
    if (path === DEFERRED) return DEFERRED;   // Pass 6: asked again on the unit's next chase turn
    if (!path) continue;
    startOrder(game, u, { goal: spot, mode: 'assault', path });
    return;
  }
  u.chaseFail = { tick: game.tickN, x: target.x, z: target.z, ux: u.x, uz: u.z };
}

export function unitMotion(game) {
  const near = [], index = game.movers;
  index.clear();
  for (const u of game.units.values()) if (!ACTION_UNITS[u.type].air && !u.inside) index.add(u);
  const phase = game.tickN;
  game.nav.beginTraffic(game.units);
  groupRouteStep(game);   // Pass 3: queued members of large group orders
  for (const u of game.units.values()) {
    if (u.inside) continue;   // W4: garrisoned squads do not move (actionGarrison.js)
    u.waitingCrossing = false;
    const def = ACTION_UNITS[u.type];
    if (u.tacticalResume && game.time >= u.tacticalUntil) stopUnit(game, u, true);
    // aircraft fly their own flight model: banked turns and attack runs, smooth rotor flight (actionFlight.js)
    if (def.air) { flyAircraft(game, u, def, stopUnit); continue; }
    if (!u.goal) {
      if (u.captureWait != null) captureWaitStep(game, u);
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
    const ghost = u.ghostUntil > game.time;
    if (vehicle && !ghost) {
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
    // HILLS_MOUNTAINS (2026-11-19): infantry climb hills at HILL_PACE off a road (a road keeps its own, faster pace)
    const hillPace = !def.air && HILL_PACE[def.move] && game.world.terr[u.tile] === T.HILLS && c >= (OPEN_COST[def.move] || 1) ? HILL_PACE[def.move] : Infinity;
    const terrainPace = def.air ? 1 : Math.min(hillPace, TERRAIN_PACE(c / (OPEN_COST[def.move] || 1)));
    let pace = def.air ? def.speed : def.speed * GROUND_PACE * terrainPace;
    // 2026-11-20 upgrades (actionUnitUpgrades.speedMul): the engineers' utility car, the infantry carrier's sprint
    if (u.mods) pace *= u.mods.speed || (u.mods.mech === 'sprint' && u.sprintUntil > game.time ? u.mods.mult : 1);   // aircraft_systems is drop tanks now (actionAir)
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
    const homeGround = owner >= 0 && game.allied(u.owner, owner);
    const nav = game.nav;
    // Pass 5: a ghosting unit passes through every unit's body (allies and hostiles); a unit with a wreck pass ignores
    // wreck hulls (nav.softWrecks)
    const unitsOk = (x, z) => def.air || ghost || near.every((v) => {
      if (v === u || v.hp <= 0) return true;
      const friend = game.allied(u.owner, v.owner);
      const r = (def.radius + ACTION_UNITS[v.type].radius) * (homeGround && friend ? .5 : 1) + .016;
      const after = dxBetween(x, v.x) ** 2 + (v.z - z) ** 2;
      return after >= r * r || after > dxBetween(ox, v.x) ** 2 + (v.z - oz) ** 2 + .000001;
    });
    const groundOk = (x, z, soft) => {
      if (!soft || def.air) return nav.canMove(u, x, z, def);
      nav.softWrecks = true;
      try { return nav.canMove(u, x, z, def); } finally { nav.softWrecks = false; }
    };
    const wreckPass = !def.air && u.wreckPassUntil > game.time;
    const allowed = (x, z) => groundOk(x, z, wreckPass) && unitsOk(x, z);
    const dir = vehicle ? yaw : desired;
    let nx = wrapX(ox + Math.sin(dir) * step), nz = oz + Math.cos(dir) * step;
    const px = nx, pz = nz;
    if (!(u.crossPassUntil > game.time) && !nav.trafficAllows(u, nx, nz, def)) {
      u.waitingCrossing = true; u.vx = u.vz = 0;
      if ((u.crossWait = (u.crossWait || 0) + 1) >= PUSH.cross) { u.crossWait = 0; u.crossPassUntil = game.time + PUSH.crossPass; stuckStats(game).crossPass++; }
      continue;
    }
    u.crossWait = 0;
    let ok = allowed(nx, nz);
    // NAV_BRIDGES (2026-11-18): standing is tested on a sampled body (centre and four rim points), so along a narrow
    // lane (a bridge end, a gap between facilities) the standable ground has slivers a few hundredths wide where a
    // short step fails although the planned line (sampled at LANE_HOP) is clear. A unit facing its waypoint steps
    // over such a sliver instead of waiting for a stuck ladder that replans the same line.
    if (!ok && !def.air && step > .0001 && step < LANE_HOP && Math.abs(angleDelta(yaw, desired)) < .35) {
      const hx = wrapX(ox + Math.sin(desired) * Math.min(LANE_HOP, length)), hz = oz + Math.cos(desired) * Math.min(LANE_HOP, length);
      if (allowed(hx, hz)) { nx = hx; nz = hz; ok = true; }
    }
    if (!ok && !def.air) {
      const bias = u.id % 2 ? 1 : -1;
      for (const a of SIDESTEPS) {
        const angle = vehicle ? yaw + Math.sign(a) * turnRate * DT * bias : desired + a * bias;
        nx = wrapX(ox + Math.sin(angle) * step * .83);
        nz = oz + Math.cos(angle) * step * .83;
        if (allowed(nx, nz)) { ok = true; u.yaw = vehicle ? angle : turn(yaw, angle, DT * 3.7); break; }
      }
    }
    // Pass 5: no way round. Push through what holds the unit, if it is only wrecks and/or other units (never terrain or
    // structures), once it has been held long enough to have tried going round.
    if (!ok && !def.air && step > .0001 && distance(u, u.goal) > PUSH.goal) {
      const held = u.blocked + 1;
      const wreckFree = groundOk(px, pz, false), softFree = wreckFree || groundOk(px, pz, true);
      const bodies = softFree && unitsOk(px, pz);
      // ticks in a row held by a wreck alone (not by the crowd queueing beside one)
      u.wreckHeld = softFree && !wreckFree && bodies ? (u.wreckHeld || 0) + 1 : 0;
      if (softFree) {
        const passWreck = !wreckFree && (u.wreckHeld >= PUSH.wreck || u.wreckHeld >= PUSH.wreckEarly && !!u.path?.soft), passUnits = !bodies && held >= (near.some((v) => v !== u && v.hp > 0 && !game.allied(u.owner, v.owner)) ? PUSH.foes : PUSH.units);
        if ((wreckFree || passWreck) && (bodies || passUnits)) {
          const S = stuckStats(game);
          if (passWreck) { u.wreckPassUntil = game.time + PUSH.pass; S.wreckPass++; }
          if (passUnits) { u.ghostUntil = game.time + PUSH.pass; S.pushPast++; }
          nx = px; nz = pz; ok = true;
        }
      }
    }
    if (ok && step > .0001) {
      u.x = nx; u.z = nz;
      u.vx = dxBetween(ox, nx) / DT; u.vz = (nz - oz) / DT;
      const nextTile = tileAt(nx, nz);
      if (nextTile !== u.tile && !def.air) addWear(game, nextTile, def.move, def);
      u.tile = nextTile;
      if (!def.air) index.moved(u, ox, oz);
      u.blocked = 0; if (u.wreckHeld) u.wreckHeld = 0;
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
        // capped between progress (stallCheck resets the count): past the cap the stuck ladder takes over
        u.blockedReplans = (u.blockedReplans || 0) + 1;
        if (u.blockedReplans > STUCK.blockedReplans) { if (u.blockedReplans === STUCK.blockedReplans + 1) stuckStats(game).blockedCapped++; }
        else {
          // Pass 5: a failed collision re-route no longer halts the unit (it did once blocked 6 s, often only behind a
          // wreck or another unit); the push-through above and the stuck ladder (stallCheck) handle it
          const route = budgetRoute(game, u, u, u.goal, def, true);
          if (route === DEFERRED) u.blockedReplans--;   // Pass 6: not counted; asked again 13 ticks on
          else if (route) { u.path = route; u.navVer = game.nav.terrainVersion; }
        }
      }
    }
    if (!def.air && u.goal) stallCheck(game, u, def);
  }
}

// Stuck recovery (directive §24/§25/§30, 2026-11-18). The old watchdog measured progress against the current
// waypoint and reset whenever the path changed length. A blocked unit re-routes every 1.3 s, and each re-route
// returns a slightly different path, so the counter kept resetting: a jammed unit never ghosted, never stepped out
// of a wedge and never gave up. It just re-planned forever, and N1's backoff could not help because the resets were
// what kept it in that loop. Progress is now displacement: the unit has moved STUCK.move from its anchor, or has
// closed in on the same waypoint. A path change alone is not progress. With no progress the unit climbs a bounded
// ladder, one rung at a time, all O(1) per unit per tick apart from the rung's own (rate-limited) route call:
//   near     close to the goal: the slot is taken, halt there (as before)
//   ghost    ghost through allies for 2.5 s (mutual blocking, congested formations); step out of a wedge (a wreck or
//            structure placed on it); replan at once if the path predates a terrain change (path invalidation)
//   replan   one controlled replan; if the goal itself is now unreachable or occupied, an alternate goal nearby
//   escape   a local escape waypoint to the side (narrow passages, dynamic obstacles), then on to the goal
//   unstick  vehicles pinned by terrain or structures: move to the nearest free standing spot within
//            unstickRadius. At most once per unstickCooldown ticks, never in combat, never across a region boundary.
//   every    after that, ghost + replan every `every` ticks, at most `replans` per order
//   giveUp   no progress at all for a minute: halt and tell the owner (quiet notice, rate-limited)
//   close    (independent of the ladder) within closeRadius of the goal with no closeGain net approach for closeTicks:
//            arrived. A unit wandering in a crowded court keeps resetting the displacement watchdog, so this catches it.
// Collision re-routes (unitMotion, blocked > 12) are kept, because N1 showed they nudge jams apart. They are
// capped at blockedReplans between progress, so a wedged unit never asks for paths without end. Counters are in
// game.navStats.stuck; the last give-ups are in game.navStats.stuckLog.
export const STUCK = Object.freeze({ move: .5, near: 25, ghost: 30, replan: 55, escape: 90, unstick: 130, every: 60, replans: 6,
  giveUp: 600, blockedReplans: 10, unstickRadius: .9, unstickCooldown: 300, closeRadius: 1.5, closeGain: .15, closeTicks: 60 });
const stuckStats = (game) => (game.navStats ??= {}).stuck ??= { ghost: 0, wedge: 0, invalidated: 0, replan: 0, replanFail: 0, altGoal: 0,
  escape: 0, unstick: 0, gaveUp: 0, arrivedNear: 0, repeat: 0, blockedCapped: 0, wreckPass: 0, pushPast: 0, crossPass: 0, coarse: 0 };

/**
 * NAV_BRIDGES (2026-11-18): a blocked unit's re-route checks its lines finely beside structures and wrecks too
 * (nav.strict, actionNavigation.tight). The ordinary planner samples lines .28 apart; a line grazing a facility's
 * corner passed those samples while the unit's own steps hit the corner, so it stood blocked and every re-route
 * returned the same path until it gave up. Only blocked and stuck units pay for the fine check.
 */
export function strictRoute(game, from, to, def) {
  const nav = game.nav, was = nav.strict;
  nav.strict = true;
  try { return nav.route(from, to, def); } finally { nav.strict = was; }
}

function relocate(game, u, spot) {
  const ox = u.x, oz = u.z;
  u.x = spot.x; u.z = spot.z; u.tile = tileAt(u.x, u.z); game.movers.moved(u, ox, oz);
}

function replan(game, u, def, S, gate = true) {
  // Pass 6: with the tick's routing budget spent the replan waits (u.replanWant, asked again each tick by stallCheck);
  // the unit keeps its current path meanwhile
  if (gate && !game.nav.mayRoute(u)) { u.replanWant = 2; return true; }
  if (u.replanWant) u.replanWant = 0;
  u.stuckReplans = (u.stuckReplans || 0) + 1;
  S.replan++;
  const route = strictRoute(game, u, u.goal, def);
  u.navVer = game.nav.terrainVersion;
  if (route) { u.path = route; return true; }
  S.replanFail++;
  const alt = alternateGoal(game, u, def);
  if (!alt) {
    // Pass 5: last resort, the coarse corridor's hex centres as waypoints (same region only): the unit keeps working
    // its way along with local avoidance instead of standing still until it gives up
    const hubs = game.nav.coarsePath(u, u.goal, def);
    if (!hubs) return false;
    S.coarse++;
    u.path = hubs;
    return true;
  }
  S.altGoal++;
  u.goal = alt.goal; u.path = alt.path; u.goalBest = Infinity; u.goalStall = 0;
  return true;
}

/** A standable goal within 1.35 of the current one, reachable in the unit's region: at most two route searches. */
function alternateGoal(game, u, def) {
  const nav = game.nav, home = nav.componentOf(tileAt(u.x, u.z), def);
  let tries = 0;
  for (const r of [.45, .9, 1.35]) for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4 + (r === .9 ? Math.PI / 8 : 0);
    const p = { x: wrapX(u.goal.x + Math.sin(a) * r), z: u.goal.z + Math.cos(a) * r };
    if (!nav.canStand(p.x, p.z, def)) continue;
    const c = nav.componentOf(tileAt(p.x, p.z), def);
    if (home >= 0 && c >= 0 && c !== home) continue;
    if (++tries > 2) return null;
    const path = nav.route(u, p, def);
    if (path) return { goal: p, path };
  }
  return null;
}

/** A free spot .6 or 1.0 to the side of (or behind) the unit's heading, in a straight line from it. */
function escapePoint(game, u, def) {
  const wp = u.path[0] || u.goal, heading = Math.atan2(dxBetween(u.x, wp.x), wp.z - u.z), side = u.id % 2 ? 1 : -1, near = [];
  for (const off of [Math.PI / 2, -Math.PI / 2, 2.3, -2.3, Math.PI]) for (const r of [.6, 1.0]) {
    const a = heading + off * side, p = { x: wrapX(u.x + Math.sin(a) * r), z: u.z + Math.cos(a) * r };
    if (!game.nav.canStand(p.x, p.z, def) || !game.nav.line(u, p, def)) continue;
    game.movers.query(p.x, p.z, def.radius + .3, near);
    if (near.some((v) => v !== u && v.hp > 0 && distance(v, p) < def.radius + ACTION_UNITS[v.type].radius + .02)) continue;
    return p;
  }
  return null;
}

/** Pinned by terrain or structures (not by units): it cannot stand where it is, or no short step is open. */
function pinned(game, u, def) {
  if (!game.nav.canStand(u.x, u.z, def)) return true;
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4, x = wrapX(u.x + Math.sin(a) * .2), z = u.z + Math.cos(a) * .2;
    if (game.nav.canMove(u, x, z, def)) return false;
  }
  return true;
}

function stallCheck(game, u, def) {
  // Pass 6: a route deferred by the routing budget (1: the way back after a chase, 2: a stuck-ladder replan)
  if (u.replanWant && game.nav.mayRoute(u)) {
    if (u.replanWant === 2) replan(game, u, def, stuckStats(game), false);
    else {
      u.replanWant = 0;
      u.path = game.nav.route(u, u.goal, def) || []; u.navVer = game.nav.terrainVersion;
      if (!u.path.length) return;   // no way back: unitMotion halts it next tick, as an empty resume route always did
    }
  }
  const wp = u.path[0] || u.goal, d = distance(u, wp);
  // Close to the goal but circling it (a crowded court, the slot taken, paths that keep wandering): moving resets
  // the displacement watchdog, so net progress toward the goal itself is tracked as well. Within STUCK.closeRadius
  // and no STUCK.closeGain closer for STUCK.closeTicks, the unit has arrived (as near as the crowd allows).
  const toGoalNow = distance(u, u.goal);
  if (u.goalBx !== u.goal.x || u.goalBz !== u.goal.z) { u.goalBx = u.goal.x; u.goalBz = u.goal.z; u.goalBest = Infinity; }   // any new goal (order, resume, chase)
  if (!(toGoalNow > (u.goalBest ?? Infinity) - STUCK.closeGain)) { u.goalBest = toGoalNow; u.goalStall = 0; }
  else if ((u.goalStall = (u.goalStall || 0) + 1) >= STUCK.closeTicks && toGoalNow < STUCK.closeRadius + def.radius * 2) {
    stuckStats(game).arrivedNear++; stopUnit(game, u, true); return;
  }
  let progress = u.stallAx == null || dxBetween(u.stallAx, u.x) ** 2 + (u.z - u.stallAz) ** 2 > STUCK.move * STUCK.move;
  if (u.stallWx !== wp.x || u.stallWz !== wp.z) { u.stallWx = wp.x; u.stallWz = wp.z; u.stallBest = d; }   // a new waypoint is not progress by itself
  else if (d < (u.stallBest ?? Infinity) - .04) { u.stallBest = d; progress = true; }
  if (progress) {
    u.stallAx = u.x; u.stallAz = u.z; u.stall = 0; u.blockedReplans = 0;
    return;
  }
  const S = stuckStats(game), n = u.stall = (u.stall || 0) + 1;
  const toGoal = distance(u, u.goal);
  if (n >= STUCK.near && toGoal < .9 + def.radius * 2) { S.arrivedNear++; stopUnit(game, u, true); return; }
  if (n === STUCK.ghost) {
    S.ghost++;
    u.ghostUntil = game.time + 2.5;
    u.stuckEpisodes = (u.stuckEpisodes || 0) + 1;
    if (u.stuckEpisodes === 3) S.repeat++;   // the same order got stuck three times: repeated movement failure
    // wedged against a structure (a new wreck or building placed on top of it): step to the nearest free spot
    if (!game.nav.canStand(u.x, u.z, def)) {
      const spot = game.nav.nearest(u, def, .7);
      if (spot) { S.wedge++; relocate(game, u, spot); }
    }
    // the path was planned before a terrain change (forest cleared, crater, trench, building): plan it again
    if (u.navVer !== game.nav.terrainVersion) { S.invalidated++; replan(game, u, def, S); }
    return;
  }
  if (n === STUCK.replan) { replan(game, u, def, S); return; }
  if (n === STUCK.escape) {
    const p = escapePoint(game, u, def);
    if (p) {
      S.escape++;
      const onward = budgetRoute(game, u, p, u.goal, def, true);
      u.path = onward ? [p, ...onward] : [p, ...u.path];   // deferred (Pass 6): on along the old path
      u.ghostUntil = u.wreckPassUntil = game.time + 3;
    }
    return;
  }
  if (n === STUCK.unstick && def.move !== 'infantry' && game.tickN - (u.unstuckAt ?? -Infinity) >= STUCK.unstickCooldown &&
    !(game.time - (u.lastCombat ?? -Infinity) < 3) && pinned(game, u, def)) {
    const home = game.nav.componentOf(tileAt(u.goal.x, u.goal.z), def);
    const spot = game.nav.nearest(u, def, STUCK.unstickRadius, (x, z) => {
      const c = game.nav.componentOf(tileAt(x, z), def);
      return (home < 0 || c < 0 || c === home) && !pinned(game, { ...u, x, z }, def);
    });
    if (spot) { S.unstick++; u.unstuckAt = game.tickN; relocate(game, u, spot); replan(game, u, def, S); }
    return;
  }
  if (n > STUCK.unstick && (n - STUCK.unstick) % STUCK.every === 0 && (u.stuckReplans || 0) < STUCK.replans) {
    u.ghostUntil = u.wreckPassUntil = game.time + 2.5;
    replan(game, u, def, S);
    return;
  }
  // Pass 5: the escape rung moves the unit .6 to the side, which counts as displacement progress and restarted the
  // ladder: a unit on ground it could not leave (a flooded hex, a pocket) climbed ghost/replan/escape for ever and never
  // gave up. Net progress toward the goal is the backstop: stuck three times or more and not STUCK.closeGain closer to
  // the goal for STUCK.giveUp ticks (a long detour away from the goal is not stuck episodes), it gives up all the same.
  if (n > STUCK.giveUp || (u.goalStall || 0) >= STUCK.giveUp && (u.stuckEpisodes || 0) >= 3 && n >= STUCK.ghost) {
    S.gaveUp++;
    const log = game.navStats.stuckLog ??= [];
    log.push({ t: Math.round(game.time), id: u.id, type: u.type, tile: u.tile, goal: tileAt(u.goal.x, u.goal.z), replans: u.stuckReplans || 0 });
    if (log.length > 32) log.shift();
    const civ = game.civs[u.owner];
    // VISION: no note about a destination on undiscovered ground
    if (civ?.human && civ.explored?.[tileAt(u.goal.x, u.goal.z)] && game.time - (civ.stuckNoteAt ?? -Infinity) >= 10) {
      civ.stuckNoteAt = game.time;
      game.notify(u.owner, `${ACTION_UNITS[u.type].name} could not reach its destination and halted.`, { kind: 'unit', quiet: true, tile: u.tile, unit: u.id });
    }
    stopUnit(game, u, true);
  }
}
