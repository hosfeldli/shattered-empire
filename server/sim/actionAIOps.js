// AI operations layer (2026-11-18, docs/gameplay-overhaul/AI_OPERATIONS.md). planActionAI (actionAI.js) still picks
// the objective (expand, attack, final assault, defend); this module carries it out:
//  - secureSite: a capture that sticks. Capture-capable infantry inside the zone are put on hold (braced: no
//    attack-move chase, no cover shuffling), more are brought in with an exact plain move, escorts screen the zone
//    and clear contesters. Before this the capture squad arrived on an attack-move, chased the first enemy it saw
//    out of the 1.35-radius zone, and the progress decayed (R7) — 56 % of all zone entries were abandoned.
//  - managePickets: troops passing a free or hostile outpost/ruin detach one squad to take it; a captured site keeps
//    a picket until it is settled. Bounded per difficulty.
//  - runOperation: an attack runs as 1–3 assault task forces on separate approach corridors (lateral rally points,
//    reachable for infantry, penalised for defences and for repeating earlier axes), plus raiders and a home
//    reserve. Forces muster at their rally points, then step off with staggered timing so the axes hit together.
//    Reinforcements join the nearest force at its rally point instead of streaming down the old route.
//  - strategicProgram: stalemate detection (front unchanged for N minutes, repeated failed assaults, late-game
//    parity) → Advanced Systems Lab, Strategic Missile Facility and missile through the player commands
//    (construct, missileBuild, missileLaunch), launched at the defended headquarters blocking the operation or at a
//    massed army, never with own troops in the blast; the operation's assault is timed to the impact.
// Determinism: no randomness at all (ties break on ids). Cost: per planning tick O(own units + seen enemies + sites);
// corridors are cached per operation (7 nav.nearest probes), region checks use the nav's cached components.
import { ACTION_BUILDINGS, ACTION_UNITS, MISSILE_PROJECT, TIERS } from './actionDefinitions.js';
import * as basesApi from './actionBases.js';
import * as engineersApi from './actionEngineers.js';
import { distance, tileAt } from './actionNavigation.js';
import { GROUND_PACE, moveGroup } from './actionOrders.js';

const { advanceBase, construct, demolish, facilitiesAt, headquarters, openSlots } = basesApi;

// Per difficulty. axes: assault task forces at most; raid: 0 never, 1 once the enemy turtles, 2 whenever the army
// is large enough; reserve: share of the ground army kept home; pickets: squads left on captured/passed sites;
// nukeAfter: earliest second a stalemate can start the strategic programme; frontStall: seconds without any base
// changing hands that count as a stalemate; failures: failed assaults on one target that count as a stalemate;
// cooldown: seconds between strategic launches; armyGate: the programme takes its next step (and banks for it) only
// with the army at this share of its floor (balance pass 2026-11-18: brutal's missile comes on top of a full army).
export const PROFILES = {
  easy: { axes: 1, raid: 0, reserve: 0, pickets: 1, nukeAfter: 2400, frontStall: 600, failures: 3, cooldown: 480 },
  normal: { axes: 2, raid: 1, reserve: .1, pickets: 3, nukeAfter: 1320, frontStall: 420, failures: 2, cooldown: 300 },
  hard: { axes: 3, raid: 2, reserve: .1, pickets: 4, nukeAfter: 1140, frontStall: 330, failures: 2, cooldown: 240 },
  expert: { axes: 3, raid: 2, reserve: .12, pickets: 5, nukeAfter: 1020, frontStall: 270, failures: 2, cooldown: 180 },
  brutal: { axes: 3, raid: 2, reserve: .12, pickets: 5, nukeAfter: 1020, frontStall: 240, failures: 2, cooldown: 150, armyGate: .9 },
};
export const profileOf = (civ) => PROFILES[civ.difficulty] || PROFILES.normal;

const INFANTRY = ACTION_UNITS.rifle_squad, TRACKED = ACTION_UNITS.tank, WHEELED = ACTION_UNITS.armored_car;
const strength = (u) => ACTION_UNITS[u.type].atk * Math.max(.25, u.hp / u.maxHp);
const sumStrength = (list) => list.reduce((n, u) => n + strength(u), 0);
const value = (type) => (ACTION_UNITS[type]?.cost.materials || 0) + (ACTION_UNITS[type]?.cost.energy || 0);
const isAir = (u) => !!ACTION_UNITS[u.type].air;
export const capturer = (u) => !!ACTION_UNITS[u.type].capture && u.type !== 'engineer';
const artillery = (u) => ACTION_UNITS[u.type].cat === 'artillery';
const angleGap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const bearing = (game, from, to) => Math.atan2(game.dx(from.x, to.x), to.z - from.z);
const toward = (p, angle, r) => ({ x: p.x + Math.sin(angle) * r, z: p.z + Math.cos(angle) * r });
const lerp = (game, a, b, f) => game.lerpPoint(a, b, f);
const SHARES = [[1], [.6, .4], [.48, .3, .22]];

function note(game, p, text) {
  game.tm?.aiNote(p, text);   // telemetry (read-only, docs/TELEMETRY.md): operation, raid and missile reasons
  p.notes.unshift({ time: Math.round(game.time), text });
  if (p.notes.length > 18) p.notes.pop();
}

/** Connected land region of a point for a movement class (cached by the navigation), -1 when unknown. */
function region(game, point, def) {
  const t = tileAt(point.x, point.z);
  return t < 0 ? -1 : game.nav.componentOf(t, def);
}
/** Can this unit's movement class reach the point at all (rivers without bridges, sea)? Unknown counts as yes. */
export function canReach(game, u, point) {
  const def = ACTION_UNITS[u.type];
  if (def.air) return true;
  const a = region(game, u, def), b = region(game, point, def);
  return a < 0 || b < 0 || a === b;
}

// ---------------------------------------------------------------- known defences
/** Hostile armed field works this civ has seen (remembered until seen gone). Refreshed at most every 10 s. */
export function knownDefences(game, civ, p) {
  if (p.defenceMemo && game.time - p.defenceMemo.at < 10) return p.defenceMemo.list;
  const seen = p.seenDefences ??= {};
  for (const id of Object.keys(seen)) {
    const b = game.buildings.get(+id);
    if (!b || b.hp <= 0) { if (!b && civ.visible[seen[id].tile]) delete seen[id]; else if (b) delete seen[id]; }
  }
  for (const b of game.buildings.values()) {
    const def = ACTION_BUILDINGS[b.type];
    if (!def?.field || !def.attack || b.done === false || !game.hostile(civ.id, b.owner) || !civ.visible[b.tile]) continue;
    seen[b.id] = { x: b.x, z: b.z, tile: b.tile, owner: b.owner };
  }
  const list = Object.values(seen);
  p.defenceMemo = { at: game.time, list };
  return list;
}

// ---------------------------------------------------------------- capture that sticks
/**
 * Take a capture zone and hold it until it flips. `holder` keeps the per-site order timers (the plan for the main
 * operation, a raid force for raids). Returns { holders, contested, captured }.
 */
export function secureSite(game, civ, holder, group, site, enemy) {
  const live = game.siteById.get(site.id) || site;
  let st = holder.capture;
  if (!st || st.site !== live.id) st = holder.capture = { site: live.id, ordered: {}, escortAt: -99, best: 1e6, progressAt: game.time, issued: 0 };
  const capturers = group.filter(capturer).sort((a, b) => distance(a, live) - distance(b, live) || a.id - b.id);
  const inner = live.radius * .78;
  const holders = capturers.filter((u) => distance(u, live) <= inner);
  const want = Math.min(capturers.length, live.slots ? 3 : 2);
  // braced units neither chase on an attack-move nor shuffle for cover; any later order clears the brace
  const brace = holders.filter((u) => !u.braced || u.goal);
  if (brace.length) game.command(civ.id, { c: 'hold', units: brace.map((u) => u.id) });
  const bring = holders.length < want ? capturers.filter((u) => !holders.includes(u)).slice(0, want - holders.length) : [];
  // the last few metres on a plain move straight to the centre: an attack-move here is what pulled squads out
  const near = bring.filter((u) => distance(u, live) < 3.4 && game.time - (st.ordered[u.id] ?? -99) > 6);
  if (near.length) {
    moveGroup(game, near, live, { mode: 'move', exact: true });
    for (const u of near) st.ordered[u.id] = game.time;
  }
  const far = bring.filter((u) => distance(u, live) >= 3.4);
  if (far.length) advance(game, st, far, live, 'assault');
  // escorts: clear contesters first, otherwise screen the zone on the side the enemy comes from
  const busy = new Set([...holders, ...bring].map((u) => u.id));
  const escorts = group.filter((u) => !busy.has(u.id) && !isAir(u) && canReach(game, u, live));
  const threats = enemy.filter((e) => !isAir(e) && distance(e, live) < live.radius + 2.4);
  if (escorts.length && threats.length && game.time - st.escortAt > 6) {
    const front = threats.sort((a, b) => distance(a, live) - distance(b, live) || a.id - b.id)[0];
    const near = escorts.filter((u) => distance(u, live) < 10);
    if (near.length) moveGroup(game, near, front, { mode: 'assault' });
    st.escortAt = game.time;
  } else if (escorts.length && game.time - st.escortAt > 12) {
    const foe = enemy.filter((e) => !isAir(e) && distance(e, live) < 12).sort((a, b) => distance(a, live) - distance(b, live) || a.id - b.id)[0];
    const centre = escorts.reduce((c, u) => ({ x: c.x + game.dx(live.x, u.x) / escorts.length, z: c.z + (u.z - live.z) / escorts.length }), { x: live.x, z: live.z });
    const guard = foe ? lerp(game, live, foe, Math.min(.6, 2.3 / Math.max(.1, distance(live, foe)))) : lerp(game, live, centre, Math.min(.8, 2.3 / Math.max(.1, distance(live, centre))));
    const idle = escorts.filter((u) => !u.goal && !u.attack && distance(u, guard) > 2.6);
    if (idle.length) moveGroup(game, idle, guard, { mode: 'assault' });
    st.escortAt = game.time;
  }
  return { holders: holders.length, contested: !!live.contested, captured: live.owner === civ.id, coming: bring.length };
}

/** Order a group toward a point, re-issuing only when it stalls (shared by captures, raids and task forces). */
function advance(game, holder, group, point, mode) {
  if (!group.length) return false;
  if (group.filter((u) => distance(u, point) < 2.8).length >= Math.max(1, Math.ceil(group.length * .7))) { holder.progressAt = game.time; return true; }
  const nearest = Math.min(...group.map((u) => distance(u, point)));
  if ((holder.best ?? 1e6) > nearest + .65) { holder.best = nearest; holder.progressAt = game.time; }
  // moving toward *this* point: members still walking to a rally or stage need the order (counting any goal left
  // the front of a launched force parked at its rally while the rest marched in)
  const moving = group.some((u) => u.goal && distance(u.goal, point) < 4);
  if (holder.issued && (moving && game.time - holder.progressAt < 19 || game.time - holder.issued < 8)) return true;
  const result = moveGroup(game, group, point, { mode, exact: mode === 'assault' && group.length <= 12 });
  holder.issued = game.time;
  // a 'bridge' refusal (vehicles only, the river unbridged) is not a stall: the road is being built (bridgeToward)
  if (result.error && result.code === 'bridge') { holder.progressAt = game.time; return false; }
  if (result.error || holder.progressAt + 24 < game.time) {
    holder.failures = (holder.failures || 0) + 1;
    holder.progressAt = game.time;
  }
  return !result.error;
}

// ---------------------------------------------------------------- pickets
/** Units held by pickets (and the capture holders of the current operation) are not drafted elsewhere. */
export const picketIds = (p) => new Set((p.pickets || []).map((k) => k.unit));

/** Leave one of the squads that just took `site` there as a picket until the site is settled. */
export function leavePicket(game, civ, p, owned, site) {
  p.pickets ??= [];
  if (p.pickets.some((k) => k.site === site.id)) return;
  const taken = picketIds(p);
  const u = owned.filter((v) => capturer(v) && !taken.has(v.id) && distance(v, site) <= site.radius + .4)
    .sort((a, b) => ACTION_UNITS[a.type].atk - ACTION_UNITS[b.type].atk || a.id - b.id)[0];
  if (!u) return;
  p.pickets.push({ unit: u.id, site: site.id, since: game.time, securedAt: game.time });
  p.troops = p.troops.filter((id) => id !== u.id);
}

export function managePickets(game, civ, p, owned, enemy) {
  const prof = profileOf(civ);
  p.pickets = (p.pickets || []).filter((k) => {
    const u = game.units.get(k.unit), s = game.siteById.get(k.site);
    if (!u || u.hp <= 0 || u.owner !== civ.id || !s) return false;
    if (s.owner >= 0 && s.owner !== civ.id && game.allied(civ.id, s.owner)) return false;
    if (s.owner === civ.id) {
      k.securedAt ??= game.time;
      // an outpost is safe after 45 s; a city ruin once its headquarters stands (or after 100 s)
      if (game.time - k.securedAt > (s.slots ? (s.hq ? 0 : 100) : 45)) return false;
    } else {
      if (game.time - k.since > 120 && !(s.by === civ.id && s.progress > 0)) return false;   // bounded attempt
      if (sumStrength(enemy.filter((e) => !isAir(e) && distance(e, s) < 3.5)) > strength(u) * 3) return false;   // overrun: let it go
    }
    return true;
  });
  for (const k of p.pickets) {
    const u = game.units.get(k.unit), s = game.siteById.get(k.site);
    if (distance(u, s) > s.radius * .78) {
      if (game.time - (k.order ?? -99) > 8) { moveGroup(game, [u], s, { mode: 'move', exact: true }); k.order = game.time; }
    } else if (!u.braced || u.goal) game.command(civ.id, { c: 'hold', units: [u.id] });
  }
  if (game.time < (p.picketAt || 0)) return;
  p.picketAt = game.time + 6;
  const limit = Math.min(prof.pickets, 1 + Math.floor(owned.length / 12));
  if (p.pickets.length >= limit) return;
  const taken = picketIds(p), wounded = new Set(p.wounded || []);
  for (const s of game.sites) {
    if (s.hq || s.owner === civ.id || s.owner >= 0 && game.allied(civ.id, s.owner)) continue;
    // the operation's own objective is taken by the operation; raid targets by the raiders
    if (s.id === p.target || p.pickets.some((k) => k.site === s.id) || (p.op?.forces || []).some((f) => f.raid?.site === s.id)) continue;
    const mine = game.movers.query(s.x, s.z, 3.2, []).filter((u) => u.owner === civ.id && u.hp > 0 && !u.auto && capturer(u) &&
      !taken.has(u.id) && !wounded.has(u.id) && u.id !== p.scoutId);
    if (!mine.length) continue;
    const danger = enemy.filter((e) => !isAir(e) && distance(e, s) < 4.5);
    if (sumStrength(danger) > sumStrength(mine) * .8) continue;
    const u = mine.sort((a, b) => ACTION_UNITS[a.type].atk - ACTION_UNITS[b.type].atk || distance(a, s) - distance(b, s) || a.id - b.id)[0];
    p.pickets.push({ unit: u.id, site: s.id, since: game.time });
    taken.add(u.id);
    p.troops = p.troops.filter((id) => id !== u.id);
    moveGroup(game, [u], s, { mode: 'move', exact: true });
    if (p.pickets.length >= limit) break;
  }
}

// ---------------------------------------------------------------- approach corridors
/**
 * Up to `count` rally points around the target on genuinely different bearings (>= 55° apart), each reachable by
 * infantry from home. Scored by detour length, known defences near the rally, roads (a bonus), and the axes used in
 * the last 15 minutes against this target or near this rally (a penalty that fades with time). Cached 2 minutes.
 */
export function corridors(game, civ, p, home, target, count) {
  const key = `${home.id ?? home.x}:${target.id}:${count}`;
  if (p.corridorCache?.key === key && game.time - p.corridorCache.at < 120) return p.corridorCache.list;
  const length = distance(home, target), R = Math.max(5.5, Math.min(8.5, length * .32));
  const direct = bearing(game, target, home);
  const homeRegion = region(game, home, INFANTRY);
  const memory = (p.axisLog || []).filter((a) => game.time - a.time < 900);
  const defences = knownDefences(game, civ, p).filter((d) => distance(d, target) < R + 6);
  const candidates = [];
  for (const delta of [0, .7, -.7, 1.3, -1.3, 1.9, -1.9]) {
    const angle = direct + delta;
    const spot = game.nav.nearest(toward(target, angle, R), INFANTRY, 2.2);
    if (!spot) continue;
    const r = region(game, spot, INFANTRY);
    if (homeRegion > 0 && r > 0 && r !== homeRegion) continue;
    const t = tileAt(spot.x, spot.z);
    let score = distance(home, spot) + distance(spot, target) * .5 + defences.filter((d) => distance(d, spot) < 4.5).length * 3;
    for (const m of memory) if ((m.target === target.id || distance(m.point, spot) < 6) && angleGap(m.angle, angle) < .6)
      score += 2 + 7 * (1 - (game.time - m.time) / 900);
    if (t >= 0 && game.world.road[t]) score -= 1.5;
    const vehicles = { tracked: region(game, home, TRACKED) === region(game, spot, TRACKED), wheeled: region(game, home, WHEELED) === region(game, spot, WHEELED) };
    // a wide flank goes round through a stage point first, so it does not walk the main axis and turn at the end
    const stage = Math.abs(delta) >= 1.25 ? game.nav.nearest(toward(target, direct + delta * .55, R * 1.7), INFANTRY, 2.2) : null;
    candidates.push({ angle, delta, rally: spot, stage: stage && region(game, stage, INFANTRY) === r ? stage : null, score, vehicles });
  }
  candidates.sort((a, b) => a.score - b.score || Math.abs(a.delta) - Math.abs(b.delta) || a.delta - b.delta);
  const list = [];
  for (const c of candidates) {
    if (list.length >= count) break;
    if (list.every((q) => angleGap(q.angle, c.angle) >= .95)) list.push(c);
  }
  p.corridorCache = { key, at: game.time, list };
  return list;
}

// ---------------------------------------------------------------- roads and bridges
/**
 * Order an engineer road (with bridges) from `from` toward `to` through NAVIGATION's roadRouteBetween, under player
 * rules. Deduped per key (an operation or expansion target): a preview first, checked against the bank (the
 * strategic reserve plus 120), then the order; a refusal backs off 90 s, 180 s, ... up to 8 min; an ordered road is
 * not re-planned for 10 minutes. One map-wide search per call, so this runs only when a crossing is needed.
 */
export function bridgeToward(game, civ, p, from, to, key) {
  const route = engineersApi.roadRouteBetween || basesApi.roadRouteBetween;
  if (typeof route !== 'function') return null;
  const roads = p.roads ??= {};
  const r = roads[key] ??= { tries: 0, next: 0 };
  if (r.ok && game.time - r.at < 600 || game.time < r.next) return r;
  const backoff = (code) => { r.ok = false; r.error = code; r.tries++; r.next = game.time + Math.min(480, 45 * 2 ** r.tries); return r; };
  let plan = route(game, civ, from, to, { preview: true });
  // the far end may lie in hostile, unseen or other players' ground: then bridge as far as the rules allow (60 %, 35 %)
  const far = to;
  for (const f of [.6, .35]) {
    if (!plan?.error || !['territory', 'hostile', 'hidden', 'length', 'foundation', 'blocked'].includes(plan.code)) break;
    to = game.lerpPoint(from, far, f);
    plan = route(game, civ, from, to, { preview: true });
  }
  if (plan?.error) return backoff(plan.code);
  const reserve = (p.nuke?.saving && p.nuke.reserve?.materials) || 0;
  if (civ.res.materials - (plan.cost?.materials || 0) < reserve + 120) { r.error = 'funds'; r.next = game.time + 30; return r; }
  const done = route(game, civ, from, to);
  if (done?.error) return backoff(done.code);
  r.ok = true; r.at = game.time; r.tries = 0; r.error = null;
  if (done.bridges) note(game, p, `Engineers ordered to bridge the river (${done.bridges} bridge segment${done.bridges > 1 ? 's' : ''}).`);
  return r;
}
/** Ground vehicles in `units` that cannot reach `point` without a bridge (infantry wade, aircraft fly). */
export const cutOff = (game, units, point) => units.filter((u) => !isAir(u) && ACTION_UNITS[u.type].move !== 'infantry' && !canReach(game, u, point));

// ---------------------------------------------------------------- task forces
function poolOf(game, civ, p, owned) {
  const wounded = new Set(p.wounded || []), pickets = picketIds(p);
  const guard = p.guard && p.guard.until > game.time ? new Set(p.guard.ids) : null;
  return owned.filter((u) => !u.grounded && u.airOrder?.kind !== 'return' && !wounded.has(u.id) && u.id !== p.scoutId && !pickets.has(u.id) &&
    !guard?.has(u.id) && ACTION_UNITS[u.type].ability !== 'repair' && u.type !== 'engineer' && ACTION_UNITS[u.type].atk > 0 &&
    u.type !== 'scout_buggy' && u.type !== 'recon_drone');
}

const ROLE_ORDER = (u) => artillery(u) ? 3 : ACTION_UNITS[u.type].move === 'infantry' ? 2 : isAir(u) ? 4 : 1;

/** Split the army into the operation's forces (first call) and file new units into the nearest one (later calls). */
function assignForces(game, civ, p, op, pool, home, target) {
  const prof = profileOf(civ);
  const inForce = new Map(), present = new Set(pool.map((u) => u.id));
  for (const f of op.forces) {
    f.ids = f.ids.filter((id) => present.has(id));
    for (const id of f.ids) inForce.set(id, f);
    // forget members that left (dead, wounded, detached): the per-unit memories stay as small as the force
    for (const memo of [f.joined, f.reached]) if (memo) for (const id of Object.keys(memo)) if (!inForce.has(+id)) delete memo[id];
  }
  const ground = pool.filter((u) => !isAir(u));
  const fresh = pool.filter((u) => !inForce.has(u.id)).sort((a, b) => ROLE_ORDER(a) - ROLE_ORDER(b) || strength(b) - strength(a) || a.id - b.id);
  if (!op.forces.length) {
    const axes = Math.min(prof.axes, ground.length >= 30 ? 3 : ground.length >= 14 ? 2 : 1);
    let lanes = corridors(game, civ, p, home, target, axes);
    if (!lanes.length) {
      // no rally point reachable from home: take the straight line (a target over water fails and is avoided)
      const R = Math.max(5.5, Math.min(8.5, distance(home, target) * .32));
      lanes = [{ angle: bearing(game, target, home), delta: 0, rally: lerp(game, target, home, Math.min(.5, R / Math.max(.1, distance(home, target)))), stage: null, vehicles: { tracked: true, wheeled: true } }];
      op.unreachable = true;
    }
    const shares = SHARES[lanes.length - 1];
    lanes.forEach((lane, i) => op.forces.push({ role: i ? 'flank' : 'main', share: shares[i], ids: [], ...lane, failures: 0, progressAt: game.time, best: 1e6, issued: 0 }));
    const turtled = isTurtled(game, civ, p, target);
    if (prof.raid === 2 && ground.length >= 18 || prof.raid >= 1 && turtled && ground.length >= 14)
      op.forces.push({ role: 'raid', share: 0, ids: [], failures: 0, progressAt: game.time, best: 1e6, issued: 0 });
    if (prof.reserve && ground.length >= 16) op.forces.push({ role: 'reserve', share: 0, ids: [], post: lerp(game, home, target, .1) });
  }
  const assault = op.forces.filter((f) => f.role === 'main' || f.role === 'flank');
  const raid = op.forces.find((f) => f.role === 'raid' && !f.closed), reserve = op.forces.find((f) => f.role === 'reserve' && !f.closed);
  const total = () => op.forces.reduce((n, f) => n + f.ids.length, 0) || 1;
  for (const u of fresh) {
    const air = isAir(u);
    // the home reserve fills first from what stands near home; raiders take fast vehicles and a few capture squads
    if (reserve && !air && reserve.ids.length < Math.round(ground.length * prof.reserve) && distance(u, home) < 9 && ROLE_ORDER(u) <= 2) { reserve.ids.push(u.id); continue; }
    if (raid && !air && raid.ids.length < Math.max(3, Math.min(6, Math.round(ground.length * .12))) &&
      (capturer(u) && raid.ids.filter((id) => game.units.get(id) && capturer(game.units.get(id))).length < 2 || ACTION_UNITS[u.type].speed >= 1.2 && ROLE_ORDER(u) === 1)) { raid.ids.push(u.id); continue; }
    const options = assault.filter((f) => air || canReach(game, u, f.rally));
    if (!options.length) { (reserve || assault[0]).ids.push(u.id); continue; }   // a river cuts this unit off: home duty
    let best = null, score = Infinity;
    for (const f of options) {
      const over = f.ids.length / total() / f.share;
      const s = (op.launched ? distance(u, f.rally) : 0) + over * 12;
      if (s < score) { score = s; best = f; }
    }
    best.ids.push(u.id);
  }
  for (const f of op.forces) { f.joined ??= {}; for (const id of f.ids) f.joined[id] ??= game.time; }
}

function isTurtled(game, civ, p, target) {
  const failed = Object.values(p.failedAt || {}).reduce((n, v) => n + v, 0);
  return failed >= 1 || knownDefences(game, civ, p).filter((d) => distance(d, target) < 7).length >= 4;
}

/**
 * Waypoint a force member heads for next: the stage (wide flanks), then the rally, then the objective. Each member's
 * progress is remembered (f.reached: 1 = stage passed, 2 = rally reached), so a squad that cut a corner near the
 * objective still forms up at its own rally instead of joining whichever axis it happened to walk along.
 */
function nextLeg(f, u) {
  const reached = (f.reached ??= {});
  let leg = reached[u.id] || (f.stage ? 0 : 1);
  if (leg === 0 && (distance(u, f.stage) < 3 || distance(u, f.rally) < 3.5)) leg = 1;
  if (leg === 1 && distance(u, f.rally) < 3.5) leg = 2;
  reached[u.id] = leg;
  return leg === 0 ? f.stage : leg === 1 ? f.rally : null;
}

/** March members toward their next waypoint; returns the members already at or past the rally. */
function march(game, f, units, target) {
  const ahead = [], legs = new Map();
  for (const u of units) {
    const leg = isAir(u) ? null : nextLeg(f, u);
    if (!leg) ahead.push(u); else { const list = legs.get(leg) || []; list.push(u); legs.set(leg, list); }
  }
  if (game.time - (f.marchAt ?? -99) > 11) {
    let ordered = false;
    for (const [leg, list] of legs) {
      const idle = list.filter((u) => !u.goal || distance(u.goal, leg) > 3.5);
      if (!idle.length) continue;
      // the march fights its way (attack-move). Only a wide flank's leg from its stage round the objective to its rally
      // is a plain move, or that column is drawn into the defences it is meant to bypass. (Plain moves on every axis
      // cost fights: 7 of 15 test matches ended in 30 min against 10 of 15 with attack-moves.)
      const close = f.stage && leg === f.rally ? idle.filter((u) => distance(u, target) < distance(f.rally, target) + 5) : [];
      if (close.length) moveGroup(game, close, leg, { mode: 'move' });
      if (close.length < idle.length) moveGroup(game, idle.filter((u) => !close.includes(u)), leg, { mode: 'assault' });
      ordered = true;
    }
    if (ordered) f.marchAt = game.time;
  }
  return ahead;
}

function positionArtillery(game, f, guns, target, home) {
  if (!guns.length || game.time < (f.artilleryAt || 0)) return;
  f.artilleryAt = game.time + 10;
  const idle = guns.filter((u) => !u.goal && !u.attack && distance(u, target) > ACTION_UNITS[u.type].range * .95);
  if (!idle.length) return;
  const from = f.rally || home, length = Math.max(.1, distance(from, target)), reach = Math.min(...idle.map((u) => ACTION_UNITS[u.type].range)) * .8;
  moveGroup(game, idle, lerp(game, target, from, Math.min(.9, reach / length)), { mode: 'assault' });
}

/** The siege at a headquarters for one force; true when the force is fighting there (no approach order needed). */
function engage(game, civ, p, f, units, target, enemy) {
  const visible = game.buildings.get(target.hq);
  if (!visible || !game.sees(civ, visible)) return false;
  const local = units.filter((u) => distance(u, target) < 10);
  if (!local.length) return false;
  const progress = () => { f.progressAt = game.time; p.progressAt = game.time; };
  const pressure = [...game.buildings.values()].filter((b) => game.hostile(civ.id, b.owner) && distance(b, target) < 5 && game.sees(civ, b))
    .reduce((sum, b) => sum + b.hp, 0);
  if (f.pressure != null && pressure < f.pressure - 2) progress();
  f.pressure = pressure;
  // Fight the defenders first: troops locked onto the headquarters would ignore the units and emplacements shooting them.
  const threats = enemy.filter((e) => !isAir(e) && distance(e, target) < 7 && local.some((u) => distance(u, e) < 4.5));
  const emplacements = [...game.buildings.values()].filter((b) => game.hostile(civ.id, b.owner) && b.done !== false && b.hp > 0 &&
    ACTION_BUILDINGS[b.type]?.field && ACTION_BUILDINGS[b.type].attack && distance(b, target) < 6 && game.sees(civ, b));
  if (threats.length && local.length >= 3) {
    if (game.time - (f.threatAt ?? -30) > 7) {
      const front = threats.sort((a, b) => Math.min(...local.map((u) => distance(u, a))) - Math.min(...local.map((u) => distance(u, b))) || a.id - b.id)[0];
      const assault = local.filter((u) => !artillery(u));
      if (assault.length) moveGroup(game, assault, front, { mode: 'assault' });
      for (const u of local) if (artillery(u) && ACTION_UNITS[u.type].ability === 'bombard' && (u.abilityReady || 0) <= game.time)
        game.command(civ.id, { c: 'ability', ability: 'bombard', units: [u.id], point: { x: front.x, z: front.z } });
      f.threatAt = game.time; progress();
    }
  } else if (emplacements.length && local.length >= 3 && game.time - (f.attackAt ?? -30) > 13) {
    const nearest = emplacements.sort((a, b) => Math.min(...local.map((u) => distance(u, a))) - Math.min(...local.map((u) => distance(u, b))) || a.id - b.id)[0];
    game.command(civ.id, { c: 'attack', target: nearest.id, units: local.map((u) => u.id) });
    f.attackAt = game.time;
    if (nearest.hp < (f.lastEmplacementHp ?? Infinity)) progress();
    f.lastEmplacementHp = nearest.hp;
  } else if (local.length >= 3 && game.time - (f.attackAt ?? -30) > 13) {
    game.command(civ.id, { c: 'attack', target: visible.id, units: local.map((u) => u.id) });
    for (const u of local) if (ACTION_UNITS[u.type].ability === 'bombard') game.command(civ.id, { c: 'ability', ability: 'bombard', units: [u.id], point: target });
    f.attackAt = game.time;
    if (visible.hp < (f.lastHp ?? Infinity)) progress();
    f.lastHp = visible.hp;
  }
  if (local.length < Math.min(5, units.length)) return false;
  const late = units.filter((u) => !u.goal && !u.attack && distance(u, target) >= 10);
  if (late.length && game.time > (f.reinforceAt || 0)) {
    // reinforcements come in along this force's own axis (via its rally), not down the shortest route from home
    const ahead = march(game, f, late, target);
    if (ahead.length) moveGroup(game, ahead, lerp(game, target, f.rally, Math.min(.5, 3.5 / Math.max(.1, distance(f.rally, target)))), { mode: 'assault' });
    f.reinforceAt = game.time + 14;
  }
  return true;
}

function runRaid(game, civ, p, op, f, units, home, target, enemy) {
  if (!units.length) return;
  const centre = { x: units[0].x, z: units[0].z };
  let raid = f.raid && game.siteById.get(f.raid.site);
  if (raid && (f.raid.kind === 'capture' ? raid.owner === civ.id : !raid.hq || raid.owner < 0) || raid && game.time > f.raid.until) { f.raid = null; raid = null; }
  if (!raid && game.time >= (f.raidAt || 0)) {
    f.raidAt = game.time + 15;
    p.raidAvoid ??= {};
    const defences = knownDefences(game, civ, p);
    const options = [];
    for (const s of game.sites) {
      if (!civ.siteIntel.has(s.id) || s.id === target.id || (p.raidAvoid[s.id] || 0) > game.time || distance(s, target) < 7) continue;
      if (!units.some((u) => canReach(game, u, s))) continue;
      const hostile = s.owner >= 0 && game.hostile(civ.id, s.owner);
      const danger = sumStrength(enemy.filter((e) => distance(e, s) < 6)) + defences.filter((d) => distance(d, s) < 5).length * 25;
      if (danger > sumStrength(units) * 1.1) continue;
      if (!s.slots && !s.hq && (hostile || s.owner < 0 && distance(s, home) > 9)) options.push({ s, kind: 'capture', score: distance(centre, s) + danger * .2 - (hostile ? 6 : 0) });
      else if (s.hq && hostile) options.push({ s, kind: 'strike', score: distance(centre, s) + danger * .2 + 4 });
    }
    options.sort((a, b) => a.score - b.score || a.s.id - b.s.id);
    if (options[0]) {
      raid = options[0].s;
      f.raid = { site: raid.id, kind: options[0].kind, until: game.time + 180 };
      note(game, p, `Raiders sent to ${raid.name}.`);
    }
  }
  if (!raid) {
    // nothing to raid: shadow the main force's rally as its extra flank
    const main = op.forces.find((x) => x.role === 'main');
    if (main && game.time - (f.marchAt ?? -99) > 15) { const idle = units.filter((u) => !u.goal && distance(u, main.rally) > 4); if (idle.length) moveGroup(game, idle, main.rally, { mode: 'assault' }); f.marchAt = game.time; }
    return;
  }
  const opposed = enemy.filter((e) => units.some((u) => distance(u, e) < 5));
  if (opposed.length && sumStrength(opposed) > sumStrength(units) * 1.3) {
    p.raidAvoid[raid.id] = game.time + 180;
    f.raid = null;
    moveGroup(game, units, lerp(game, home, target, .2), { mode: 'move' });
    note(game, p, `Raiders pulled back from ${raid.name}.`);
    return;
  }
  if (f.raid.kind === 'capture') { secureSite(game, civ, f, units, raid, enemy); return; }
  // strike: the economy (Materials Processors, Energy Generators) of a lightly held base
  const economy = [...game.buildings.values()].filter((b) => b.site === raid.id && game.hostile(civ.id, b.owner) && (b.type === 'depot' || b.type === 'power_plant') &&
    b.hp > 0 && game.sees(civ, b)).sort((a, b) => distance(a, centre) - distance(b, centre) || a.id - b.id)[0];
  if (economy) {
    if (game.time - (f.attackAt ?? -30) > 12) { game.command(civ.id, { c: 'attack', target: economy.id, units: units.map((u) => u.id) }); f.attackAt = game.time; }
  } else advance(game, f, units, lerp(game, raid, centre, Math.min(.6, 3 / Math.max(.1, distance(raid, centre)))), 'assault');
}

/**
 * The attack on `target` (an enemy headquarters site, or the ruin left after it fell) by task forces. Keeps
 * p.troops = the assault forces' units (the withdrawal check and the scout read it) and p.progressAt / p.failures
 * for planActionAI's bounded-operation rule.
 */
export function runOperation(game, civ, p, owned, enemy, home, target) {
  if (!p.op || p.op.target !== target.id) {
    // an operation interrupted by a defence or a short recovery resumes with its forces and corridors
    p.op = p.lastOp?.target === target.id && game.time - p.lastOp.endedAt < 120 ? p.lastOp : { target: target.id, started: game.time, forces: [], launched: false };
    p.lastOp = null;
    if (p.op.musterLimit) p.op.musterLimit = Math.max(p.op.musterLimit, game.time + 45);
  }
  const op = p.op;
  const pool = poolOf(game, civ, p, owned);
  assignForces(game, civ, p, op, pool, home, target);
  if (op.unreachable && !op.noted) {
    op.noted = true;
    note(game, p, 'No ground route to the objective.');
  }
  const byId = new Map(pool.map((u) => [u.id, u]));
  const unitsOf = (f) => f.ids.map((id) => byId.get(id)).filter(Boolean);
  const assault = op.forces.filter((f) => f.role === 'main' || f.role === 'flank');
  // a Final Assault (clear superiority, finishing a rival) throws everything in: the home reserve and the raiders join the
  // main thrust, and new units are no longer held back for them
  if (p.state === 'Final Assault' && assault[0]) for (const f of op.forces) if ((f.role === 'reserve' || f.role === 'raid') && f.ids.length) {
    assault[0].ids.push(...f.ids); f.ids = []; f.closed = true;
  }
  p.troops = assault.flatMap((f) => f.ids);
  // RIVERS (NAV_BRIDGES, 2026-11-18): no bridges exist at match start, so vehicles may be cut off from the axis by a
  // river or marsh (infantry wade). Infantry (and whatever can reach) attack; cut-off vehicles stay on home duty while
  // the engineers build a road with bridges (bridgeToward), and rejoin the main thrust once it is open.
  const rally = assault[0]?.rally || target;
  const cut = pool.filter((u) => !isAir(u) && ACTION_UNITS[u.type].move !== 'infantry' && !canReach(game, u, rally));
  if (cut.length) {
    const road = bridgeToward(game, civ, p, home, rally, 'op:' + target.id);
    if (!op.riverNoted) { op.riverNoted = true; note(game, p, `${cut.length} vehicles cannot cross the river; infantry lead the attack.`); }
    op.cutOff = road?.ok ? 'road' : 'waiting';
  } else if (op.cutOff) {
    // the crossing is open: vehicles parked on home duty beyond the reserve's quota join the main thrust
    op.cutOff = null;
    const reserve = op.forces.find((x) => x.role === 'reserve'), main = assault[0];
    if (reserve && main) {
      const keep = Math.round(pool.filter((u) => !isAir(u)).length * profileOf(civ).reserve);
      const movers = reserve.ids.filter((id) => { const u = byId.get(id); return u && ACTION_UNITS[u.type].move !== 'infantry'; }).slice(0, Math.max(0, reserve.ids.length - keep));
      reserve.ids = reserve.ids.filter((id) => !movers.includes(id)); main.ids.push(...movers);
      if (movers.length) note(game, p, 'Bridge open: the armour joins the attack.');
    }
  }
  const strike = p.nuke?.aim && p.nuke.aim.site === target.id && game.time < p.nuke.aim.until ? p.nuke.aim : null;
  // ---- the objective has fallen (headquarters destroyed): take the ruin with everyone at hand
  if (!target.hq) {
    const all = assault.flatMap(unitsOf);
    const result = secureSite(game, civ, p, all, target, enemy);
    if (result.holders && !result.contested) p.progressAt = game.time;
    else if ((p.capture?.progressAt ?? 0) > p.progressAt) p.progressAt = p.capture.progressAt;
    p.failures = p.capture?.failures || 0;
    return;
  }
  // ---- muster: every assault force gathers at its own rally point
  if (!op.launched) {
    let ready = true, maxEta = 0;
    for (const f of assault) {
      const units = unitsOf(f), ground = units.filter((u) => !isAir(u));
      if (!ground.length) continue;
      march(game, f, units, target);
      // readiness counts the force as formed at the start; reinforcements that joined later catch up on their own
      const core = ground.filter((u) => (f.joined?.[u.id] ?? 0) <= op.started + 3), counted = core.length ? core : ground;
      const there = counted.filter((u) => distance(u, f.rally) < 4.2).length;
      f.ready = there >= Math.ceil(counted.length * .65);
      if (!f.ready) ready = false;
      const nearest = Math.min(...ground.map((u) => distance(u, f.rally)));
      if ((f.best ?? 1e6) > nearest + .65) { f.best = nearest; f.progressAt = game.time; p.progressAt = game.time; }
      maxEta = Math.max(maxEta, distance(home, f.rally) / pace(ground));
    }
    // a Final Assault (clear superiority) waits at most a minute for stragglers: pressure matters more than form
    op.musterLimit ??= game.time + Math.min(p.state === 'Final Assault' ? 60 : 220, 30 + maxEta * 1.15);
    if (ready) p.progressAt = game.time;
    if (strike || !ready && game.time < op.musterLimit) return;
    // step off: the force with the longest way in leaves first, so all axes reach the objective together
    const etas = assault.map((f) => { const g = unitsOf(f).filter((u) => !isAir(u)); return g.length ? distance(f.rally, target) / pace(g) : 0; });
    const longest = Math.max(0, ...etas);
    const impact = op.impact && op.impact > game.time ? op.impact : 0;
    assault.forEach((f, i) => { f.goAt = impact ? Math.max(game.time, impact - etas[i] * .6) : game.time + (longest - etas[i]); f.best = 1e6; f.issued = 0; f.progressAt = game.time; });
    op.launched = true;
    p.axisLog = [...(p.axisLog || []), ...assault.map((f) => ({ target: target.id, angle: f.angle, point: f.rally, time: game.time }))].slice(-12);
    if (assault.length > 1) note(game, p, `${assault.length}-axis assault on ${game.siteById.get(target.id)?.name || 'the objective'}.`);
  }
  // ---- assault
  let failures = 0, latest = 0;
  for (const f of assault) {
    const units = unitsOf(f);
    if (!units.length) continue;
    if (strike) {
      // a strategic strike is coming: hold at the rally and keep clear of the blast
      // 2026-11-19 (NUKES.md): the blast now reaches 7.5, past the rally points (5.5-8.5 out), so the force falls
      // back along its own axis to a hold point outside the blast and waits there instead of at the rally
      const danger = MISSILE_PROJECT.radius + 2.5;
      const close = units.filter((u) => distance(u, target) < danger);
      if (close.length && game.time - (f.clearAt ?? -99) > 6) {
        const hold = game.nav.nearest(toward(target, bearing(game, target, f.rally), danger + .6), INFANTRY, 2.2) || f.rally;
        moveGroup(game, close, hold, { mode: 'move' }); f.clearAt = game.time;
      }
      if (distance(f.rally, target) >= danger) march(game, f, units.filter((u) => !close.includes(u)), target);
      p.progressAt = game.time;
      continue;
    }
    if (game.time < (f.goAt || 0)) { march(game, f, units, target); p.progressAt = Math.max(p.progressAt, game.time - 1); continue; }
    // a force beaten back regroups at its rally (the others carry on); after two setbacks it folds into the main force
    const opposed = enemy.filter((e) => units.some((u) => distance(e, u) < 5.5));
    if (units.length >= 3 && opposed.length >= 3 && sumStrength(opposed) > sumStrength(units) * 1.85 && game.time > (f.regroupUntil || 0)) {
      f.regroupUntil = game.time + 25; f.setbacks = (f.setbacks || 0) + 1;
      moveGroup(game, units.filter((u) => !isAir(u)), f.rally, { mode: 'move' });
      if (f.role === 'flank' && f.setbacks >= 2) {
        const main = assault.find((x) => x.role === 'main');
        if (main && main !== f) { main.ids.push(...f.ids); f.ids = []; note(game, p, 'Flank force merged into the main thrust.'); }
      }
      continue;
    }
    if (game.time < (f.regroupUntil || 0)) continue;
    if (engage(game, civ, p, f, units, target, enemy)) { latest = Math.max(latest, f.progressAt); continue; }
    const ahead = march(game, f, units, target);
    // the long march in (stage, rally) is progress too: the nearest member or the force's mean distance closing in
    const ground = units.filter((u) => !isAir(u));
    if (ground.length) {
      const nearest = Math.min(...ground.map((u) => distance(u, target))), mean = ground.reduce((n, u) => n + distance(u, target), 0) / ground.length;
      if ((f.closest ?? 1e6) > nearest + .65 || (f.meanBest ?? 1e6) > mean + .65) { f.progressAt = game.time; }
      f.closest = Math.min(f.closest ?? 1e6, nearest); f.meanBest = Math.min(f.meanBest ?? 1e6, mean);
    }
    const guns = ahead.filter(artillery), line = ahead.filter((u) => !artillery(u));
    if (line.length >= 3) positionArtillery(game, f, guns, target, home);
    advance(game, f, line.length >= 3 ? line : ahead, target, 'assault');
    failures = Math.max(failures, f.failures || 0);
    latest = Math.max(latest, f.progressAt || 0);
  }
  if (latest > p.progressAt) p.progressAt = latest;
  p.failures = failures;
  for (const f of op.forces) {
    if (f.role === 'raid') runRaid(game, civ, p, op, f, unitsOf(f), home, target, enemy);
    else if (f.role === 'reserve' && game.time - (f.postAt ?? -99) > 20) {
      const idle = unitsOf(f).filter((u) => !u.goal && !u.attack && distance(u, f.post) > 3.5);
      if (idle.length) moveGroup(game, idle, f.post, { mode: 'assault' });
      f.postAt = game.time;
    }
  }
}

/** Ground pace of a group (its slowest member), in world units per second. */
function pace(ground) {
  return Math.max(.2, Math.min(...ground.map((u) => ACTION_UNITS[u.type].speed)) * GROUND_PACE);
}

// ---------------------------------------------------------------- strategic missiles
/**
 * Stalemate detection and the strategic missile programme. Uses only the player commands: construct (Advanced
 * Systems Lab, Strategic Missile Facility), demolish (a redundant facility when no ring site is free),
 * missileBuild and missileLaunch. Sets p.nuke.saving (buildArmy keeps the missile's price in reserve) and
 * p.nuke.aim (runOperation holds the assault clear of the blast, then times it to the impact).
 */
export function strategicProgram(game, civ, p, owned, enemy, bases) {
  const prof = profileOf(civ);
  const n = p.nuke ??= { frontKey: '', frontAt: game.time, launches: 0, next: 0, stalemate: false, saving: false };
  if (game.time >= (n.checkAt || 0)) {
    n.checkAt = game.time + 15;
    const key = game.sites.filter((s) => s.slots && s.owner >= 0).map((s) => s.id + ':' + s.owner).join(',');
    if (key !== n.frontKey) { n.frontKey = key; n.frontAt = game.time; }
  }
  const rivals = game.civs.some((c) => c.alive && c.id !== civ.id && game.hostile(civ.id, c.id));
  const failures = Math.max(0, ...Object.values(p.failedAt || {}));
  const ratio = sumStrength(owned) / Math.max(1, p.enemyPeak || 0);
  const late = game.time >= prof.nukeAfter && rivals;
  const reasons = [];
  if (late && game.time - n.frontAt >= prof.frontStall) reasons.push(`front unchanged for ${Math.round((game.time - n.frontAt) / 60)} min`);
  if (late && failures >= prof.failures) reasons.push(`${failures} failed assaults`);
  if (late && game.time >= prof.nukeAfter + 240 && ratio > .7 && ratio < 1.45 && game.time - n.frontAt >= prof.frontStall / 2) reasons.push('forces at parity');
  const was = n.stalemate;
  // hysteresis: a declared stalemate holds for 3 minutes, so the programme does not flicker on and off
  if (reasons.length) n.stalemateAt = game.time;
  n.stalemate = reasons.length > 0 || was && game.time - (n.stalemateAt ?? -1e9) < 180;
  if (n.stalemate && !was) note(game, p, `Stalemate (${reasons.join(', ')}): strategic strike programme.`);
  const silos = [...game.buildings.values()].filter((b) => b.owner === civ.id && b.type === 'missile_silo');
  const silo = silos.find((b) => b.done) || silos[0];
  // n.reserve: the price of the programme's next step, which buildArmy keeps in the bank (above the army floor)
  n.saving = false; n.reserve = null;
  // preparation: a front quiet for half the stalemate time, or one failed assault, already buys Tier III and the lab
  // (the silo and the missile wait for the stalemate itself), so the strike is not 15 minutes behind the stalemate.
  // Preparation buys only from surplus: it banks nothing, so the army is not starved before a stalemate is certain.
  const preparing = late && !n.stalemate && (game.time - n.frontAt >= prof.frontStall / 2 || failures >= 1);
  const funded = !prof.armyGate || owned.length >= Math.min(40, 8 + Math.floor(game.time / 60)) * prof.armyGate;
  if (!funded) {
    // the army is below the gate: no step and no bank until it has recovered (a missile already built still flies)
  } else if ((n.stalemate || preparing) && civ.age < 2) {
    // Tier III first (global Advanced Warfare: the silo is a tier-3 facility), on the main base
    const main = bases[0], hq = headquarters(game, main);
    if (main && hq?.done && main.tier < 3) {
      if (n.stalemate) { n.saving = true; n.reserve = TIERS[2].cost; }
      if (!hq.project && !advanceBase(game, civ, main).error) note(game, p, `Advancing ${main.name} to Tier III for the strategic programme.`);
    }
  } else if (preparing && !silo) {
    buildSilo(game, civ, p, n, bases, true);
  } else if (n.stalemate) {
    if (!silo) { n.reserve = buildSilo(game, civ, p, n, bases); n.saving = !!n.reserve; }
    else if (!silo.done) { n.saving = true; n.reserve = MISSILE_PROJECT.cost; }   // bank the missile while the silo goes up
    else if (!silo.project && !silo.missiles) {
      if (game.time >= n.next - MISSILE_PROJECT.time) {
        if (!game.command(civ.id, { c: 'missileBuild', id: silo.id }).error) note(game, p, 'Strategic missile under construction.');
        else { n.saving = true; n.reserve = MISSILE_PROJECT.cost; }
      }
    }
  } else if (silo?.done && !silo.project && !silo.missiles && civ.res.materials > MISSILE_PROJECT.cost.materials + 720 && civ.res.energy > MISSILE_PROJECT.cost.energy + 270)
    game.command(civ.id, { c: 'missileBuild', id: silo.id });   // the old opportunistic rule: a silo with spare funds
  if (!silo?.done) { n.aim = null; return; }
  const ready = silo.missiles > 0, soon = silo.project?.kind === 'missile' && silo.project.left < 25;
  if (!ready && !soon || game.time < n.next) { if (!soon) n.aim = null; return; }
  const strike = pickStrike(game, civ, p, silo, enemy, n.stalemate);
  if (!strike) { n.aim = null; return; }
  // the operation holds its forces clear while the missile is readied and the blast area empties
  n.aim = strike.site ? { site: strike.site, until: game.time + 60 } : null;
  if (!ready || strike.clear) return;
  const result = game.command(civ.id, { c: 'missileLaunch', id: silo.id, point: { x: strike.x, z: strike.z } });
  if (result.error) return;
  n.launches++;
  n.next = game.time + prof.cooldown;
  n.aim = null;
  const flight = 5 + distance(silo, strike) * .09;
  if (p.op && strike.site === p.op.target) {
    // follow-up: the assault steps off so that it arrives just after the impact
    p.op.impact = game.time + flight;
    p.op.launched = false;
    p.op.musterLimit = game.time;
  }
  note(game, p, `Strategic strike on ${strike.label}.`);
}

function buildSilo(game, civ, p, n, bases, labOnly = false) {
  if (game.time < (n.buildAt || 0)) return n.siloReserve;
  n.buildAt = game.time + 10;
  return (n.siloReserve = siloStep(game, civ, p, n, bases, labOnly));
}

function siloStep(game, civ, p, n, bases, labOnly) {
  const silo = ACTION_BUILDINGS.missile_silo.cost, labCost = ACTION_BUILDINGS.advanced_lab.cost;
  // only bases with a known enemy headquarters within missile range can host the programme (when any can)
  const enemies = [...civ.siteIntel.values()].filter((s) => s.hq && game.hostile(civ.id, s.owner));
  const inRange = (s) => enemies.some((e) => distance(e, s) < MISSILE_PROJECT.range - 4);
  const operational = bases.filter((s) => headquarters(game, s)?.done);
  const ready = operational.some(inRange) ? operational.filter(inRange) : operational;
  const lab = (s) => facilitiesAt(game, s).find((b) => b.type === 'advanced_lab');
  if (labOnly && ready.some(lab)) return null;
  for (const s of ready) if (lab(s)?.done && openSlots(game, s).length) {
    n.host = s.id;
    if (!construct(game, civ, s, 'missile_silo').error) { note(game, p, `Strategic Missile Facility under construction at ${s.name}.`); return null; }
    return silo;
  }
  if (ready.some((s) => lab(s) && !lab(s).done)) return labOnly ? null : silo;   // a lab is being built: wait for it, saving for the silo
  // a lab where a second ring site will be free for the silo (research cities first)
  const host = ready.filter((s) => s.tier >= 2).sort((a, b) => Number(b.kind === 'research') - Number(a.kind === 'research') ||
    openSlots(game, b).length - openSlots(game, a).length || a.id - b.id)[0];
  if (!host) return null;
  n.host = host.id;   // buildArmy leaves this base's free ring sites to the programme
  if (lab(host)?.done || openSlots(game, host).length >= (lab(host) ? 1 : 2)) {
    if (!lab(host) && !construct(game, civ, host, 'advanced_lab').error) { note(game, p, `Advanced Systems Lab under construction at ${host.name}.`); return labOnly ? null : silo; }
    return labCost;
  }
  // no ring site free: demolish one redundant facility (a type the AI holds two of), as a player would
  const all = bases.flatMap((s) => facilitiesAt(game, s)).filter((b) => b.done);
  const count = (type) => all.filter((b) => b.type === type).length;
  const spare = facilitiesAt(game, host).filter((b) => b.done && !b.project && ['barracks', 'heavy_weapons', 'airfield', 'motor_works', 'armory'].includes(b.type) && count(b.type) >= 2)
    .sort((a, b) => ['barracks', 'heavy_weapons', 'airfield', 'motor_works', 'armory'].indexOf(a.type) - ['barracks', 'heavy_weapons', 'airfield', 'motor_works', 'armory'].indexOf(b.type) || a.id - b.id)[0];
  if (spare && !demolish(game, civ, spare.id).error) note(game, p, `Cleared a ring site at ${host.name} for the strategic programme.`);
  return labCost;
}

/**
 * The best strike in range: an enemy headquarters (worth more when defended, when it is the operation's target or
 * has beaten assaults back) or a massed army in view. Never a point with own or allied units/buildings in the blast
 * (+1 safety margin); when the operation's own troops stand there the strike is returned with `clear` set so the
 * operation pulls them back first.
 */
function pickStrike(game, civ, p, silo, enemy, stalemate) {
  const R = MISSILE_PROJECT.radius, safe = R + 1;
  const friendly = [...game.units.values()].filter((u) => !game.hostile(civ.id, u.owner) && !isAir(u));
  const friendlyBuildings = [...game.buildings.values()].filter((b) => !game.hostile(civ.id, b.owner));
  const hostileBuildings = [...game.buildings.values()].filter((b) => game.hostile(civ.id, b.owner) && b.hp > 0);
  const options = [];
  const consider = (point, worth, extra) => {
    if (distance(silo, point) > MISSILE_PROJECT.range - .5) return;
    const t = tileAt(point.x, point.z);
    if (t < 0 || !civ.explored[t]) return;
    if (friendlyBuildings.some((b) => distance(b, point) < safe)) return;
    const near = friendly.filter((u) => distance(u, point) < safe);
    // only the operation's own troops may be standing there, and only at its own objective: they are pulled back first
    const ours = new Set(p.troops), clearable = extra.site && extra.site === p.op?.target;
    if (near.some((u) => u.owner !== civ.id || !ours.has(u.id) || !clearable)) return;
    const units = enemy.filter((e) => !isAir(e) && distance(e, point) < R);
    const structures = hostileBuildings.filter((b) => distance(b, point) < R);
    const score = worth + units.reduce((s, u) => s + value(u.type), 0) + structures.reduce((s, b) => s + (ACTION_BUILDINGS[b.type]?.field ? 260 : 120), 0);
    options.push({ x: point.x, z: point.z, score, clear: near.length > 0, ...extra });
  };
  for (const s of civ.siteIntel.values()) {
    if (!s.hq || !game.hostile(civ.id, s.owner) || !game.civs[s.owner]?.alive) continue;
    const blocked = (p.failedAt?.[s.id] || 0) * 500 + (p.op?.target === s.id && stalemate ? 1200 : 0);
    consider(s, 700 + (s.tier || 1) * 250 + blocked, { site: s.id, label: s.name });
  }
  const ground = enemy.filter((e) => !isAir(e)).sort((a, b) => a.id - b.id).slice(0, 60);
  for (const u of ground) {
    const cluster = ground.filter((v) => distance(v, u) < R * .8);
    if (cluster.length < 6) continue;
    const c = { x: cluster.reduce((n, v) => n + v.x, 0) / cluster.length, z: cluster.reduce((n, v) => n + v.z, 0) / cluster.length };
    consider(c, 0, { site: 0, label: 'a massed army' });
  }
  options.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);
  const best = options[0];
  return best && best.score >= (stalemate ? 1400 : 2400) ? best : null;
}
