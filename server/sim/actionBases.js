import { N, T, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';
import { ABILITIES, ACTION_BUILDINGS, ACTION_RESOURCES, ACTION_UNITS, ACTION_UPGRADES, CITY_DEFENSES, DEFENSE_INFLUENCE, MISSILE_PROJECT, NEW_BASE_GAP, OUTPOST_TYPES, PLACEMENT, REMOVED_UPGRADES, TIERS } from './actionDefinitions.js';
import { centerOf, distance, dxBetween, HEAVY_GROUND, isMountain, LIGHT_GROUND, structureOnSegment, tileAt, wrapX } from './actionNavigation.js';
import { baseStreets, hubRoute, hubTiles, roadEdgesCost, ROAD_SEARCH } from './actionMap.js';
import { launchStrategic } from './actionCombat.js';
import { moveGroup, stopUnit } from './actionOrders.js';
import { emit } from './combat.js';
import { newBaseRing } from './actionEngineers.js';
import { beginProduction, productionQueues as queuesOf, runProduction } from './actionProduction.js';

const ERA = [0, 1, 2, 4];
export const canPay = (civ, cost) => ACTION_RESOURCES.every((key) => civ.res[key] >= (cost[key] || 0));
function pay(civ, cost, factor = -1) {
  for (const key of ACTION_RESOURCES) civ.res[key] += (cost[key] || 0) * factor;
}
const affordable = (civ, cost) => canPay(civ, cost) ? null : { error: 'Insufficient materials or energy.', code: 'funds' };

export const headquarters = (game, site) => site?.hq ? game.buildings.get(site.hq) : null;
export function openSlots(game, site) {
  const count = Math.min(7, 3 + (site.tier - 1) * 2);   // 3 / 5 / 7 ring sites by base tier
  const occupied = new Set([...game.buildings.values()].filter((b) => b.site === site.id && b.slot).map((b) => b.slot));
  return site.slots.slice(0, count).filter((id) => !occupied.has(id));
}
export const facilitiesAt = (game, site) => [...game.buildings.values()].filter((b) => b.site === site.id && b.slot);
export const hasFacility = (game, site, type) => facilitiesAt(game, site).some((b) => b.type === type && b.done);

export function addFacility(game, civ, site, type, tile, { instant = false, point, duration } = {}) {
  const def = ACTION_BUILDINGS[type], parcel = def.field ? null : site.parcels.find((p) => type === 'town' ? p.id === 0 : p.id === tile);
  const pos = point || parcel || centerOf(tile), slot = type !== 'town' && !def.field ? parcel.id : 0;
  tile = parcel?.tile ?? tile;
  const hp = def.hp * (type === 'town' && site.kind === 'metro' ? 1.15 : 1);
  const b = { id: game.id_(), owner: civ.id, site: site?.id || 0, slot, type, tile, x: pos.x, z: pos.z, radius: def.radius,
    hp: instant ? hp : hp * .34, maxHp: hp, done: instant, progress: instant ? 1 : 0, buildTime: duration || def.time,
    yaw: point ? point.yaw || 0 : parcel?.yaw || 0, queues: [], rally: null, readyAt: 0, level: 1, era: ERA[site?.tier || civ.age + 1], fire: 0, lastCombat: -999, missiles: 0, project: null,
    state: instant ? 'operational' : 'construction' };
  game.buildings.set(b.id, b);
  game.registerBuilding(b);
  if (type === 'town') {
    site.hq = b.id;
    if (instant) {
      site.everEstablished = true;
      site.visualTier = Math.max(site.visualTier || 1, site.tier);
      site.developedAt = game.time;
      site.maturityElapsed = null;
    }
  }
  if (instant) game.ruins.delete(tile);
  game.world.touch(tile);
  const wrecks = game.wrecks.get(tile);
  if (wrecks?.length) {
    const remaining = wrecks.filter((w) => w.x != null && distance(w, b) > b.radius + .12);
    if (remaining.length) game.wrecks.set(tile, remaining); else game.wrecks.delete(tile);
    game.bfVer++;
  }
  // Pass 6: only the caches around the new building (actionNavigation.invalidateNear); a placement that also cleared
  // wrecks freed ground too and is checked as a change both ways
  game.nav.invalidate([tile], wrecks?.length ? null : 'added');
  game.clearFootprint(b);
  if (instant && site) growBase(game, site);
  return b;
}

export function establish(game, civ, site) {
  if (!site?.slots || site.owner !== civ.id) return { error: 'Capture a city ruin before establishing a headquarters.' };
  if (site.hq) return { error: 'This site already has a headquarters.' };
  if (site.contested || game.hasEnemyAt(site, civ.id)) return { error: 'Clear hostile ground troops from the command zone first.' };
  const recovery = civ.recoveryUntil > game.time && !civ.emergencyUsed;
  const def = ACTION_BUILDINGS.town;
  if (game.obstaclesAtTile(site.tile).some((b) => distance(b, site) < b.radius + .51)) return { error: 'The headquarters parcel is occupied.' };
  // 2026-11-18 (ROADS_AND_CLAIMS.md): the settlement price includes the road to the nearest own base. The road is
  // planned only once the headquarters itself is affordable, and a plan is reused for CLAIM_PLAN_TTL seconds.
  const townError = affordable(civ, settlementCost(game, civ, null));
  if (townError) return townError;
  const plan = claimRoadFor(game, site, civ.id);
  const cost = settlementCost(game, civ, plan);
  const error = affordable(civ, cost);
  if (error) return plan?.edges.length
    ? { ...error, error: `Establishing ${site.name} costs ${cost.materials} Materials${cost.energy ? ` and ${cost.energy} Energy` : ''}, including ${plan.cost.materials} for the road to ${plan.name}.` }
    : error;
  const b = addFacility(game, civ, site, 'town', site.tile, { duration: site.kind === 'town' ? def.time * .8 : def.time });
  if (recovery) civ.emergencyUsed = true;
  pay(civ, cost);
  // the road lays itself while the headquarters is built (an automatic project, like the outpost links)
  site.claimRoadBuilt = true;
  site.claimRoad = null;
  // with the base's own compound streets (actionMap.baseStreets, free: part of the headquarters)
  const queued = new Set([...pendingRoadEdges(game), ...(plan?.edges || []).map((e) => edgeKey(e.a, e.b))]);
  const edges = [...(plan?.edges || []), ...baseStreets(game, site).filter((e) => !queued.has(edgeKey(e.a, e.b)))];
  if (edges.length) game.roadProjects.push({ owner: civ.id, edges, left: claimRoadSeconds(edges.length), auto: true, claim: site.id,
    label: plan ? `Road from ${site.name} to ${plan.name} complete.` : `${site.name} streets complete.` });
  return { building: b.id, road: plan?.edges.length || 0 };
}

/** The price of establishing a headquarters: the headquarters (or the one-time recovery price) plus its claim road. */
export function settlementCost(game, civ, plan) {
  const base = civ.recoveryUntil > game.time && !civ.emergencyUsed ? { materials: 140 } : ACTION_BUILDINGS.town.cost;
  const road = plan && plan.owner === civ.id ? plan.cost.materials : 0;
  return { ...base, materials: (base.materials || 0) + road };
}

export function construct(game, civ, site, type, tile) {
  const def = Object.hasOwn(ACTION_BUILDINGS, type) ? ACTION_BUILDINGS[type] : null;
  if (!def || def.field || type === 'town') return { error: 'Choose a base facility.' };
  if (site?.owner !== civ.id || !headquarters(game, site)?.done) return { error: 'An operational headquarters is required.' };
  if (civ.age + 1 < def.tier) return { error: `This facility requires global Tier ${TIERS[def.tier - 1].label} technology.` };
  if (def.needs && !hasFacility(game, site, def.needs)) return { error: `Requires ${ACTION_BUILDINGS[def.needs].name} at this base.` };
  const slots = openSlots(game, site);
  if (tile == null) tile = slots[0];
  if (!slots.includes(tile)) return { error: 'Choose an open construction parcel at this base.' };
  const error = affordable(civ, def.cost);
  if (error) return error;
  if (game.hasEnemyAt({ ...site.parcels.find((p) => p.id === tile), radius: .62 }, civ.id)) return { error: 'Hostile forces occupy this parcel.' };
  const b = addFacility(game, civ, site, type, tile);
  pay(civ, def.cost);
  return { building: b.id };
}

// Ring of influence (DEFENSE_INFLUENCE): per civ, the hex distance from its nearest territory hex, capped at
// reach + 1 (255 = farther, or no territory at all). One BFS per civ per tick, run only when a placement asks.
const influenceCache = new WeakMap();
export function influenceRing(game, civ) {
  let byCiv = influenceCache.get(game);
  if (!byCiv || byCiv.tick !== game.tickN) influenceCache.set(game, byCiv = { tick: game.tickN, rings: new Map() });
  let ring = byCiv.rings.get(civ.id);
  if (ring) return ring;
  const cap = DEFENSE_INFLUENCE.reach + 1, owner = game.world.owner, queue = [];
  ring = new Uint8Array(N).fill(255);
  for (let t = 0; t < N; t++) if (owner[t] === civ.id) { ring[t] = 0; queue.push(t); }
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head], d = ring[t] + 1;
    if (d > cap) continue;
    for (let k = t * 6; k < t * 6 + 6; k++) { const n = NB[k]; if (n >= 0 && ring[n] > d) { ring[n] = d; queue.push(n); } }
  }
  byCiv.rings.set(civ.id, ring);
  return ring;
}
/** A build site counts as known when it is visible now or lies in your own territory. */
const known = (game, civ, t) => !!civ.visible[t] || game.world.owner[t] === civ.id;
/** Build-wheel ground: your own territory, and for defenses (def.defense) and neutral infrastructure (def.neutral,
 *  W2 2026-11-17: radar / repair posts) also neutral ground; never another player's land. */
export const placeableBy = (game, civ, def, t) => { const o = game.world.owner[t]; return o === civ.id || !!(def.defense || def.neutral) && o < 0; };
/** The price of a build-wheel structure at a tile: defenses and neutral infrastructure outside the ring of influence
 *  cost DEFENSE_INFLUENCE.factor ×. */
export function fieldCost(game, civ, type, tile) {
  const def = ACTION_BUILDINGS[type];
  if (!(def?.defense || def?.neutral) || tile < 0 || influenceRing(game, civ)[tile] <= DEFENSE_INFLUENCE.reach) return { cost: def?.cost, surcharge: 1 };
  const f = DEFENSE_INFLUENCE.factor;
  return { cost: Object.fromEntries(Object.entries(def.cost).map(([k, v]) => [k, Math.ceil(v * f)])), surcharge: f };
}

/** Build-wheel refusal codes (W2, 2026-11-17) and the player-facing reason for each. The client preview colours
 *  and labels the ghost by `code`. Others in use: 'influence' (funds, with the surcharge), 'road' / 'spacing' /
 *  'ring' (New Base). */
export const PLACEMENT_REASONS = {
  hidden: 'Scout the construction site so it is currently visible.',
  territory: 'Build only on your own territory or neutral ground, never in another player\'s territory.',
  base: 'Too close to a base or outpost: keep its command zone and approaches clear.',
  pad: 'Keep clear of the base\'s building pads.',
  trench: 'A trench already runs here.',
  water: 'Structures cannot stand in water or on a bridge.',
  slope: 'The ground is too steep here.',
  mountain: 'Mountains are impassable: nothing can be built on them.',   // HILLS_MOUNTAINS (2026-11-19)
  blocked: 'Something is in the way: choose clear ground.',
  enemy: 'Hostile troops contest the position.',
  // 2026-11-18: defenses other than the sandbag barricade keep off roads (they are offset, never rerouted around)
  road: 'Defenses cannot block a road: place it beside the road (sandbag barricades may go on roads).',
  forest: 'Dense forest: infantry engineers cannot reach it. Clear it with tanks first, or build at its edge.',
  funds: 'Insufficient materials or energy.',
  tech: 'This defense requires more advanced global technology.',
  invalid: 'Choose a tactical defense, a location and a valid rotation.',
};
const refuse = (code, error = PLACEMENT_REASONS[code]) => ({ error, code });

/** Refusals the server resolves by moving the structure to the nearest valid spot nearby (2026-11-18). Never
 *  snapped: hidden, territory, base, enemy (the player must choose again), and funds. */
const SNAP_CODES = new Set(['road', 'slope', 'blocked', 'water', 'trench', 'pad', 'forest', 'mountain']);
// Snap rule (contract mirrored by the client preview, CONSTRUCTION_DESIGN.md): the candidates are the centres of the
// hexes within PLACEMENT.snapHexes (2) of the requested hex, the requested hex's own centre included, ordered by
// straight-line distance from the requested point (rounded to 1e-6), ties broken by the lowest tile id. The first
// candidate that passes every placement rule is used. Deterministic, no RNG.
function snapCandidates(point) {
  const t = tileAt(point.x, point.z);
  if (t < 0) return [];
  return disk(t, PLACEMENT.snapHexes).filter((n) => n >= 0)
    .map((n) => ({ n, d: Math.round(distance(centerOf(n), point) * 1e6) })).sort((p, q) => p.d - q.d || p.n - q.n).map((c) => c.n);
}

/** Whether tile t carries any road edge (usable or ruined: a ruined road can be repaired, so it stays clear). */
const roadTile = (game, t) => { for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && game.roads.get(t, n)) return true; } return false; };
const segDistSq = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, px = x - ax, pz = z - az;
  const s = Math.max(0, Math.min(1, (dx * px + dz * pz) / (dx * dx + dz * dz || 1)));
  return (px - dx * s) ** 2 + (pz - dz * s) ** 2;
};
/**
 * True when a structure of radius r at (x, z) stands on a road: its centre is on a road hex, or its disc comes
 * within the road's half-width (PLACEMENT.roadClear) of a road edge (centre to centre of the two hexes) or of a base
 * ring road. Checks the centre hex and its six neighbours only (r + roadClear < one hex inradius of .87).
 */
export function onRoad(game, x, z, r) {
  const t = tileAt(wrapX(x), z);
  if (t < 0) return false;
  if (roadTile(game, t)) return true;
  const reach = (r + PLACEMENT.roadClear) ** 2;
  for (let i = -1; i < 6; i++) {
    const a = i < 0 ? t : NB[t * 6 + i];
    if (a < 0) continue;
    for (const e of game.ringRoads?.get(a) || []) {
      const ex = x + dxBetween(x, e.a.x);
      if (segDistSq(x, z, ex, e.a.z, ex + dxBetween(e.a.x, e.b.x), e.b.z) < reach) return true;
    }
    const ca = centerOf(a), ax = x + dxBetween(x, ca.x);
    for (let d = 0; d < 6; d++) {
      const n = NB[a * 6 + d];
      if (n < 0 || !game.roads.get(a, n)) continue;
      const cn = centerOf(n);
      if (segDistSq(x, z, ax, ca.z, ax + dxBetween(ca.x, cn.x), cn.z) < reach) return true;
    }
  }
  return false;
}

/**
 * Why the ground at (x, z) cannot carry a structure of radius r ('water' | 'slope' | 'blocked'), or null.
 * Water, rivers too deep to ford and cliffs are sampled at the centre and at PLACEMENT.edge × r in the four
 * cardinal directions; other structures and wrecks at the full radius (as nav.canStand does), so a structure
 * never overlaps another and footpaths stay open. A structure never stands on water, even on a bridge deck.
 */
function groundRefusal(game, x, z, r, edgeFactor = PLACEMENT.edge) {
  const w = game.world, nav = game.nav;
  x = wrapX(x);
  const t = tileAt(x, z);
  if (t < 0) return 'blocked';
  const e = r * edgeFactor;
  for (const [ox, oz] of [[0, 0], [e, 0], [-e, 0], [0, e], [0, -e]]) {
    const xx = wrapX(x + ox), zz = z + oz, n = tileAt(xx, zz);
    if (n < 0) return 'blocked';
    if (isWater(w.terr[n]) || w.lake[n]) return 'water';
    if (isMountain(w.terr[n])) return 'mountain';   // HILLS_MOUNTAINS (2026-11-19)
    if (!Number.isFinite(nav.cost(n, xx, zz, LIGHT_GROUND))) return w.river[n] ? 'water' : w.dense?.[n] && w.terr[n] === T.FOREST ? 'forest' : 'slope';
  }
  if (nav.obstacleAt(t, x, z, r)) return 'blocked';
  for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
    const xx = wrapX(x + ox), zz = z + oz, n = tileAt(xx, zz);
    if (n >= 0 && n !== t && nav.obstacleAt(n, xx, zz, 0)) return 'blocked';
  }
  return null;
}

export function constructDefense(game, civ, type, point, preview = false, yaw = 0) {
  const def = Object.hasOwn(ACTION_BUILDINGS, type) ? ACTION_BUILDINGS[type] : null;
  if (!def?.field || !point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return refuse('invalid', 'Choose a tactical defense and a location.');
  if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return refuse('invalid', 'Choose a valid structure rotation.');
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  const tile = tileAt(point.x, point.z);
  if (civ.age + 1 < def.tier) return refuse('tech');
  // 2026-11-17: ground in your own territory need not be in sight (fogged corners of a settlement no longer block
  // its defenses); neutral ground must still be scouted.
  if (tile < 0 || !known(game, civ, tile)) return refuse('hidden');
  if (!placeableBy(game, civ, def, tile)) return def.defense || def.neutral
    ? { error: `${def.defense ? 'Defenses' : 'This structure'} go${def.defense ? '' : 'es'} on your own territory or neutral ground, never in another player's territory.`, code: 'territory' }
    : { error: 'Build only inside your own territory.', code: 'territory' };
  if (def.newBase) return placeNewBase(game, civ, type, tile, preview);
  // 2026-11-18: a refusal the ground can resolve (SNAP_CODES: a road, a slope, an overlap, water, a trench, a pad)
  // moves the structure to the nearest valid hex centre within PLACEMENT.snapHexes instead (snapCandidates); the ack
  // and the build report it (`tile`, `snapped: true`, `reason`).
  const pending = [...game.buildings.values()].filter((b) => b.type === 'base_site');
  let at = { x: wrapX(point.x), z: point.z }, from = null;
  const refusal = siteRefusal(game, civ, def, type, at, yaw, pending);
  if (refusal) {
    if (!SNAP_CODES.has(refusal.code)) return refusal;
    for (const n of snapCandidates(at)) {
      const p = centerOf(n);
      if (!siteRefusal(game, civ, def, type, p, yaw, pending)) { from = refusal.code; at = p; break; }
    }
    if (!from) return refusal;
  }
  const site = tileAt(at.x, at.z);
  const { cost, surcharge } = fieldCost(game, civ, type, site), note = surcharge > 1 ? DEFENSE_INFLUENCE.note : null;
  if (!canPay(civ, cost)) return note ? { error: `Insufficient materials or energy · ${note}.`, code: 'influence' } : refuse('funds');
  const placement = { valid: true, cost, seconds: def.time, tile: site, x: round3(at.x), z: round3(at.z), yaw: round3(yaw),
    ...(from && { snapped: true, reason: from, moved: round3(distance(at, point)) }), ...(note && { surcharge, note }) };
  if (preview) return { reply: { t: 'ack', placement } };
  const b = addFacility(game, civ, null, type, site, { point: { ...point, x: at.x, z: at.z, yaw } });
  pay(civ, cost);
  if (from) game.notify(civ.id, `${def.name} placed ${placement.moved.toFixed(1)} away: ${SNAPPED_TEXT[from]}.`,
    { kind: 'build', tile: site, quiet: true, building: b.id, x: placement.x, z: placement.z, snapped: true, reason: from });
  return { building: b.id, reply: { t: 'ack', building: b.id, tile: site, ...(from && { snapped: true, reason: from }), placement } };
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const SNAPPED_TEXT = { road: 'kept off the road', slope: 'moved to level ground', blocked: 'moved to clear ground', water: 'moved out of the water',
  trench: 'moved off the trench', pad: 'kept clear of the building pads', forest: 'moved out of the dense forest', mountain: 'moved off the mountain' };

/** Why a build-wheel structure (not a New Base) cannot stand at `point` (a refusal with code), or null. */
function siteRefusal(game, civ, def, type, point, yaw, pending) {
  const tile = tileAt(point.x, point.z);
  if (tile < 0) return refuse('blocked');
  if (!known(game, civ, tile)) return refuse('hidden');
  if (!placeableBy(game, civ, def, tile)) return refuse('territory');
  // a pending New Base keeps its whole building ring clear
  if (pending.some((b) => distance(b, point) < 2.75 + def.radius)) return refuse('base', 'Keep clear of the new base being built.');
  // W2 (2026-11-17): every refusal carries a code for the client preview (PLACEMENT_REASONS).
  const P = PLACEMENT;
  if (game.sites.some((s) => distance(s, point) < s.radius + def.radius + P.hubMargin ||
    s.slots && s.owner >= 0 && s.hq && game.hostile(civ.id, s.owner) && distance(s, point) < P.hostileHq + def.radius)) return refuse('base');
  if (game.sites.some((s) => s.slots && s.parcels.some((p) => distance(p, point) < def.radius + P.parcelMargin))) return refuse('pad');
  if (game.fieldworks.has(tile)) return refuse('trench');
  // 2026-11-18: every defense but the sandbag barricade keeps off roads (offset beside them, never rerouting them)
  if (def.defense && type !== 'barricade' && onRoad(game, point.x, point.z, def.radius)) return refuse('road');
  const ground = groundRefusal(game, point.x, point.z, def.radius);
  if (ground) return refuse(ground);
  if (def.width) {
    // the rotated footprint: corners and edge midpoints; level within a tolerance that grows with its size
    const tolerance = P.slope.base + P.slope.perSpan * Math.hypot(def.width, def.depth) * .5;
    for (const [sx, sz] of [[-1,-1],[-1,1],[1,-1],[1,1],[0,-1],[0,1],[-1,0],[1,0]]) {
      const x = point.x + sx * def.width * .5 * Math.cos(yaw) + sz * def.depth * .5 * Math.sin(yaw);
      const z = point.z - sx * def.width * .5 * Math.sin(yaw) + sz * def.depth * .5 * Math.cos(yaw), t = tileAt(wrapX(x), z);
      if (t < 0) return refuse('blocked');
      if (!known(game, civ, t)) return refuse('hidden');
      if (!placeableBy(game, civ, def, t)) return refuse('territory', 'The rotated footprint crosses into another player\'s territory.');
      if (t !== tile && game.fieldworks.has(t)) return refuse('trench');
      const edge = groundRefusal(game, x, z, .025, 1);
      if (edge) return refuse(edge);
      if (Math.abs(game.world.elev[t] - game.world.elev[tile]) > tolerance) return refuse('slope');
    }
  }
  if (game.hasEnemyAt({ ...point, radius: P.contest }, civ.id)) return refuse('enemy');
  return null;
}

// New Base (build wheel): own territory, on or beside a road, NEW_BASE_GAP from every base site, 3.5 from
// outposts, and room for a full building ring. The engineers build it; on completion it becomes a real
// base site with an operational headquarters (actionEngineers.foundBase).
function placeNewBase(game, civ, type, tile, preview) {
  const def = ACTION_BUILDINGS[type], point = centerOf(tile), w = game.world;
  if (!w.road[tile] && !NB.slice(tile * 6, tile * 6 + 6).some((n) => n >= 0 && w.road[n])) return { error: 'A new base must connect to a road: place it on or beside one.', code: 'road' };
  if (game.sites.some((s) => distance(s, point) < (s.slots ? NEW_BASE_GAP : 3.5)) ||
    [...game.buildings.values()].some((b) => b.type === 'base_site' && distance(b, point) < NEW_BASE_GAP)) return { error: 'Too close to another base or outpost.', code: 'spacing' };
  if (!game.nav.canStand(point.x, point.z, { ...LIGHT_GROUND, radius: def.radius }) || game.fieldworks.has(tile) || game.buildingAtTile(tile)) return { error: 'Choose clear, open ground.', code: 'blocked' };
  const plan = newBaseRing(game, tile);
  if (plan.error) return { error: plan.error, code: 'ring' };
  if (game.hasEnemyAt({ ...point, radius: 1.5 }, civ.id)) return { error: 'The position is contested.', code: 'enemy' };
  const error = affordable(civ, def.cost);
  if (error) return error;
  if (preview) return { reply: { t: 'ack', placement: { valid: true, cost: def.cost, seconds: def.time, x: point.x, z: point.z,
    parcels: plan.ring.map((p) => [p.tile, p.x, p.z, p.yaw]) } } };
  const b = addFacility(game, civ, null, type, tile, { point: { ...point, yaw: 0 } });
  pay(civ, def.cost);
  return { building: b.id };
}

// Era level of a structure: defenses gain health here (+30% per level); firepower and range in combat.
function setLevel(b, level) {
  const def = ACTION_BUILDINGS[b.type];
  if (def.levels?.effect === 'defense') {
    const scale = (1 + .3 * (level - 1)) / (1 + .3 * ((b.level || 1) - 1));
    b.maxHp *= scale; b.hp = Math.min(b.maxHp, b.hp * scale);
  }
  b.level = level;
}

/** Command upgradeBuilding: buy the next era level of a production, power, supply or defensive structure. */
export function upgradeBuilding(game, civ, id) {
  const b = game.buildings.get(id), def = b && ACTION_BUILDINGS[b.type];
  if (b?.owner !== civ.id || !b.done || !def.levels) return { error: 'Select a structure that can be upgraded.' };
  if (b.perimeterSlot) return { error: 'Upgrade perimeter positions together from the headquarters.' };
  const next = (b.level || 1) + 1;
  if (next > def.levels.max) return { error: 'This structure is fully upgraded.' };
  if (civ.age + 1 < next) return { error: `Level ${next} requires Era ${TIERS[next - 1].label}.`, code: 'era' };
  if (b.project) return { error: 'This structure already has a project underway.' };
  const cost = def.levels.cost[next - 2], error = affordable(civ, cost);
  if (error) return error;
  pay(civ, cost);
  b.project = { kind: 'level', level: next, left: def.levels.time[next - 2], total: def.levels.time[next - 2] };
  return {};
}

/** Command upgradeDefenses: harden a base perimeter (level 2 adds built-in city anti-aircraft fire). */
export function upgradeDefenses(game, civ, site) {
  const hq = headquarters(game, site), spec = CITY_DEFENSES.upgrade;
  if (!site?.slots || site.owner !== civ.id || !hq?.done) return { error: 'Select an operational headquarters.' };
  if (![...game.buildings.values()].some((b) => b.site === site.id && b.owner === civ.id && b.perimeterSlot)) return { error: 'Build the perimeter defenses first.' };
  const next = (site.defenseLevel || 1) + 1;
  if (next > spec.max) return { error: 'The perimeter is fully upgraded.' };
  if (civ.age + 1 < next) return { error: `Perimeter level ${next} requires Era ${TIERS[next - 1].label}.`, code: 'era' };
  if (hq.project) return { error: 'Finish the current headquarters project first.' };
  const cost = spec.cost[next - 2], error = affordable(civ, cost);
  if (error) return error;
  pay(civ, cost);
  hq.project = { kind: 'defenses', level: next, left: spec.time[next - 2], total: spec.time[next - 2] };
  return {};
}

/** True when a city's upgraded perimeter gives it built-in anti-aircraft fire (D fires it). */
export const cityAA = (site) => (site?.defenseLevel || 1) >= CITY_DEFENSES.upgrade.aaLevel;

/** Income accrues every tick (10 Hz) at the rates productionStep last computed. */
export function incomeStep(game, dt) {
  for (const civ of game.civs) if (civ.alive && civ.rates) pay(civ, civ.rates, dt);
}

export function advanceBase(game, civ, site) {
  const b = headquarters(game, site), tier = site?.tier;
  if (b?.owner !== civ.id || !b.done || tier >= 3) return { error: 'Select a headquarters that can advance.' };
  if (b.project) return { error: 'A headquarters project is already underway.' };
  const def = TIERS[tier], error = affordable(civ, def.cost);
  if (error) return error;
  b.project = { kind: 'tier', tier: tier + 1, left: def.time, total: def.time };
  pay(civ, def.cost);
  return {};
}

export function fortifyBase(game, civ, site) {
  const hq = headquarters(game, site);
  if (!site?.slots || site.owner !== civ.id || !hq?.done) return { error: 'Select an operational headquarters.' };
  if (hq.project) return { error: 'Finish the current headquarters project first.' };
  const existing = [...game.buildings.values()].filter((b) => b.owner === civ.id && b.site === site.id && b.perimeterSlot);
  const missing = Array.from({ length: 6 }, (_, i) => i + 1).filter((i) => !existing.some((b) => b.perimeterSlot === i));
  if (!missing.length) return { error: 'All six perimeter positions already exist. Repair damaged defenses from their controls.' };
  // 2026-11-17: your own base's perimeter lots need not be in sight (a fogged outer lot no longer blocks the
  // purchase), and a lot that is blocked or contested is skipped: the positions that fit are built and paid for
  // pro rata; the rest can be added later. Refused only when none fits.
  const plans = [];
  for (const slot of missing) {
    const type = slot <= 4 ? 'barricade' : 'city_turret', def = ACTION_BUILDINGS[type];
    const angle = hq.yaw + Math.PI / 8 + (slot <= 4 ? (slot - 1) * Math.PI / 2 : Math.PI / 4 + (slot - 5) * Math.PI);
    let point;
    // 2026-11-18: turrets keep off roads (barricades may stand on them); two wider bearings give them room
    for (const offset of [0, .16, -.16, .32, -.32]) for (const radius of [3.0, 3.35, 3.7]) {
      const a = angle + offset, p = { x: site.x + Math.sin(a) * radius, z: site.z + Math.cos(a) * radius, yaw: a };
      const tile = tileAt(p.x, p.z);
      if (point || tile < 0 || game.hasEnemyAt({ ...p, radius: .7 }, civ.id) ||
        plans.some((q) => distance(q.point, p) < def.radius + ACTION_BUILDINGS[q.type].radius + .15) ||
        type !== 'barricade' && onRoad(game, p.x, p.z, def.radius) ||
        !game.nav.canStand(p.x, p.z, { ...LIGHT_GROUND, radius: def.radius })) continue;
      point = p;
    }
    if (point) plans.push({ type, point, slot });
  }
  if (!plans.length) return { error: 'Clear the outer perimeter lots before purchasing defenses.' };
  const cost = Object.fromEntries(Object.entries(CITY_DEFENSES.cost).map(([key, value]) => [key, Math.ceil(value * plans.length / 6)]));
  const error = affordable(civ, cost); if (error) return error;
  pay(civ, cost);
  for (const plan of plans) {
    const b = addFacility(game, civ, site, plan.type, tileAt(plan.point.x, plan.point.z), { point: plan.point, duration: CITY_DEFENSES.time });
    b.perimeterSlot = plan.slot;
    if (site.defenseLevel > 1) setLevel(b, site.defenseLevel);
  }
  hq.project = { kind: 'perimeter', total: CITY_DEFENSES.time, left: CITY_DEFENSES.time };
  return { placed: plans.length, skipped: missing.length - plans.length };
}

/** The upgrade that already holds `key`'s line for this civ. Always null since the troop upgrades (the only
 *  upgrades with a line, one per unit class) were removed on 2026-11-19; kept for existing importers (actionAI). */
export function upgradeLineHolder() { return null; }

export const UPGRADE_REMOVED = 'Upgrades have been removed: every unit now fights with its standard equipment.';

/** Command research { tech }. Every upgrade has been removed (the troop upgrades 2026-11-19; the Armory and its
 *  command upgrades 2026-11-20), so this only refuses: 'upgrade_removed' for a former upgrade. */
export function startUpgrade(game, civ, key) {
  if (Object.hasOwn(REMOVED_UPGRADES, key)) return { error: UPGRADE_REMOVED, code: 'upgrade_removed' };
  return { error: 'That upgrade is unavailable.' };
}

/** Command cancelResearch { tech }: abandons an upgrade in progress. Its cost was paid up front and is not refunded (R2). */
export function cancelUpgrade(game, civ, key) {
  const b = [...game.buildings.values()].find((b) => b.owner === civ.id && b.project?.kind === 'upgrade' && b.project.key === key);
  if (!b) return { error: 'That upgrade is not in progress.', code: 'not_researching' };
  b.project = null;
  const lost = { ...(ACTION_UPGRADES[key] || REMOVED_UPGRADES[key])?.cost };
  return { reply: { t: 'ack', cancelled: { tech: key, lost } } };
}

// Production (W1, gameplay overhaul R1/R2): the shared-capacity scheduler, progressive payment, command-capacity
// reservations and the production commands live in actionProduction.js; re-exported here for existing importers.
export { armyCapacity, cancelProduction, cancelTraining, clearQueue, pauseProduction, productionCapacity, productionQueues, productionWire,
  queuedCount, setPriority, setRepeat, train } from './actionProduction.js';

export function repairFacility(game, civ, id) {
  const b = game.buildings.get(id);
  if (b?.owner !== civ.id || !b.done || b.hp >= b.maxHp) return { error: 'Select a damaged operational facility.' };
  if (b.project) return { error: 'This facility already has a project underway.' };
  const cost = { materials: Math.ceil(20 + (1 - b.hp / b.maxHp) * 70) };
  if (!canPay(civ, cost)) return { error: 'Insufficient materials.' };
  pay(civ, cost);
  b.project = { kind: 'repair', left: 17, total: 17 };
  return {};
}

export function missileCommand(game, civ, id, point) {
  const b = game.buildings.get(id);
  if (b?.owner !== civ.id || b.type !== 'missile_silo' || !b.done) return { error: 'Select an operational Missile Facility.' };
  if (point) {
    const tile = tileAt(point.x, point.z);
    if (tile < 0 || !civ.explored[tile] || distance(b, point) > MISSILE_PROJECT.range) return { error: 'Select a known target within range.' };
    if (!b.missiles) return { error: 'There is no missile ready.' };
    b.missiles--;
    launchStrategic(game, b, point);
    return {};
  }
  if (b.project || b.missiles) return { error: 'This facility already has a missile or a project.' };
  if (!hasFacility(game, game.siteById.get(b.site), 'advanced_lab')) return { error: 'An Advanced Systems Lab is required.' };
  const error = affordable(civ, MISSILE_PROJECT.cost);
  if (error) return error;
  pay(civ, MISSILE_PROJECT.cost);
  b.project = { kind: 'missile', left: MISSILE_PROJECT.time, total: MISSILE_PROJECT.time };
  return {};
}

function growBase(game, site) {
  const hq = headquarters(game, site);
  if (!hq?.done) return;
  let changed = false;
  for (const t of disk(site.tile, site.tier === 3 ? 3 : 2)) {
    if (isWater(game.world.terr[t]) || game.world.river[t] || game.world.terr[t] >= T.MOUNTAIN) continue;
    const other = game.siteByTile.get(t);
    if (other && other !== site) continue;
    if (!game.urban[t]) { game.urban[t] = 1; game.world.touch(t); changed = true; }
  }
  if (changed) game.urbanVer++;
  if (site.tier > 1) {
    for (const t of new Set(site.parcels.map((p) => p.tile))) for (const edge of game.roads.edgesOf(t)) {
      if (edge.cond > 35 && edge.type >= 2) continue;
      if (dist(site.tile, edge.a) > 3 || dist(site.tile, edge.b) > 3) continue;
      game.roads.set(edge.a, edge.b, Math.max(edge.type, 2));
      game.nav.invalidate();
    }
  }
}

// Re-settled positions are tied back into the owner's road network. When a headquarters becomes
// operational (or an outpost is captured) the nearest friendly operational bases are linked by a
// terrain-following route (the same heavy-vehicle planner as the map's original roads: valleys and
// passes, never open water; rivers are crossed by bridges, which the client derives from road edges
// over rivers). Missing or ruined segments are laid by a free automatic road project; existing
// healthy roads are reused. The new edges reach clients in the per-tile road field (tile record [4]).
export function connectSiteRoads(game, site, links = site.slots ? 2 : 1) {
  if (site.owner < 0) return 0;
  const hostileCompound = (t) => { const c = centerOf(t); return game.sites.some((s) => s.hq && s.owner >= 0 && game.hostile(site.owner, s.owner) && distance(s, c) < 2.7); };
  const pending = pendingRoadEdges(game);
  const limit = site.slots ? 46 : 18;
  const others = game.sites.filter((s) => s !== site && s.slots && s.owner >= 0 && game.allied(s.owner, site.owner) &&
    headquarters(game, s)?.done && distance(s, site) <= limit).sort((a, b) => distance(site, a) - distance(site, b) || a.id - b.id).slice(0, links);
  let laid = 0;
  for (const other of others) {
    const route = hubRoute(game.world, game.nav.strategic(site.tile, other.tile, HEAVY_GROUND, true, false, ROAD_SEARCH), hubTiles(game));
    if (!route || route.some(hostileCompound)) continue;
    const edges = [];
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i], key = Math.min(a, b) + ':' + Math.max(a, b), e = game.roads.get(a, b);
      if (pending.has(key) || e && e.cond >= 60 && e.type >= 2) continue;
      pending.add(key); edges.push({ a, b });
    }
    if (!edges.length) continue;
    game.roadProjects.push({ owner: site.owner, edges, left: Math.max(4, Math.min(30, edges.length * .5)), auto: true,
      label: `Road from ${site.name} to ${other.name} complete.` });
    laid += edges.length;
  }
  return laid;
}

// --- Claim roads (2026-11-18, docs/gameplay-overhaul/ROADS_AND_CLAIMS.md) --------------------------------------
// A match starts without roads between its sites, and without bridges (NAV_BRIDGES.md). When a player establishes a headquarters
// on a captured city, a road from that city to the player's nearest operational base is planned with the map's road
// planner (hubRoute over nav.strategic, heavy-vehicle ground, bridges over rivers), priced at ROAD_EDGE_COST per
// missing or ruined segment (ROAD_BRIDGE_COST for a bridge segment, which is laid with the road), added to the settlement price and laid by an automatic road project. Existing healthy
// roads and segments already under construction are reused at no charge. No route (an island): no road, no charge.
const CLAIM_ROAD_TRIES = 3;     // nearest own bases tried, by distance
const CLAIM_PLAN_TTL = 20;      // seconds a plan is reused (repeated establish attempts, the site wire)
const edgeKey = (a, b) => Math.min(a, b) + ':' + Math.max(a, b);
const pendingRoadEdges = (game) => new Set(game.roadProjects.flatMap((p) => (p.edges || []).map((e) => edgeKey(e.a, e.b))));
export const claimRoadSeconds = (edges) => Math.max(4, Math.min(30, edges * .5));

/** Plan the claim road of `site` for `owner`: { owner, at, to, name, edges: [{ a, b }], cost } or null without a route. */
export function planClaimRoad(game, site, owner = site.owner) {
  if (owner < 0) return null;
  const hostileCompound = (t) => { const c = centerOf(t); return game.sites.some((s) => s.hq && s.owner >= 0 && game.hostile(owner, s.owner) && distance(s, c) < 2.7); };
  const bases = game.sites.filter((s) => s !== site && s.slots && s.owner === owner && headquarters(game, s)?.done)
    .sort((a, b) => distance(site, a) - distance(site, b) || a.id - b.id).slice(0, CLAIM_ROAD_TRIES);
  // the road meets the hubs of this city and of the owner's bases only: it never takes a spoke into an unclaimed city
  const pending = pendingRoadEdges(game), hubs = game.sites.filter((s) => s.slots && (s === site || s.owner === owner)).map((s) => s.tile);
  for (const other of bases) {
    const route = hubRoute(game.world, game.nav.strategic(site.tile, other.tile, HEAVY_GROUND, true, false, ROAD_SEARCH), hubs);
    if (!route || route.length < 2 || route.some(hostileCompound)) continue;
    const edges = [];
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i], key = edgeKey(a, b), e = game.roads.get(a, b);
      if (pending.has(key) || e && e.cond >= 60 && e.type >= 2) continue;
      pending.add(key); edges.push({ a, b });
    }
    return { owner, at: game.time, to: other.id, name: other.name, edges, cost: { materials: roadEdgesCost(game.world, edges) } };
  }
  return { owner, at: game.time, to: 0, name: '', edges: [], cost: { materials: 0 } };
}

/**
 * The current claim-road plan of `site` (cached on site.claimRoad for CLAIM_PLAN_TTL s, then re-planned). A cached
 * plan drops the segments built or queued since, so it never charges twice. Returns null when there is no road.
 */
export function claimRoadFor(game, site, owner = site.owner) {
  let plan = site.claimRoad;
  if (!plan || plan.owner !== owner || game.time - plan.at > CLAIM_PLAN_TTL || game.time < plan.at) plan = site.claimRoad = planClaimRoad(game, site, owner);
  else if (plan.edges.length) {
    const pending = pendingRoadEdges(game);
    const edges = plan.edges.filter(({ a, b }) => { const e = game.roads.get(a, b); return !pending.has(edgeKey(a, b)) && !(e && e.cond >= 60 && e.type >= 2); });
    if (edges.length !== plan.edges.length) plan = site.claimRoad = { ...plan, edges, cost: { materials: roadEdgesCost(game.world, edges) } };
  }
  return plan?.edges.length ? plan : null;
}

function completeProject(game, civ, b, p) {
  const site = game.siteById.get(b.site);
  if (p.kind === 'tier') {
    site.tier = p.tier;
    site.visualTier = Math.max(site.visualTier || 1, p.tier);
    site.developedAt = game.time;
    site.maturityElapsed = null;
    b.level = p.tier;
    b.maxHp += 240;
    b.hp = Math.min(b.maxHp, b.hp + 240);
    civ.age = Math.max(civ.age, p.tier - 1);
    growBase(game, site);
    game.refreshTerritory();
    game.notify(civ.id, `${site.name} advanced to Tier ${TIERS[p.tier - 1].label}.`, { kind: 'age', tile: site.tile });
  } else if (p.kind === 'level') {
    setLevel(b, p.level);
    game.notify(civ.id, `${ACTION_BUILDINGS[b.type].name} upgraded to level ${p.level}.`, { kind: 'building', tile: b.tile });
  } else if (p.kind === 'defenses') {
    site.defenseLevel = p.level;
    for (const d of game.buildings.values()) if (d.site === site.id && d.owner === civ.id && d.perimeterSlot) setLevel(d, p.level);
    game.notify(civ.id, `${site.name} perimeter upgraded to level ${p.level}${cityAA(site) ? ': the city now has anti-aircraft defenses' : ''}.`, { kind: 'building', tile: site.tile });
  } else if (p.kind === 'perimeter') {
    game.notify(civ.id, `${site.name} perimeter defenses constructed.`, { kind: 'building', tile: site.tile });
  } else if (p.kind === 'upgrade') {
    if (!ACTION_UPGRADES[p.key]) return;   // a removed troop upgrade (persist.js refunds these on load)
    civ.techs.add(p.key);
    game.notify(civ.id, `${ACTION_UPGRADES[p.key].name} complete.`, { kind: 'tech', tile: b.tile });
  } else if (p.kind === 'missile') {
    b.missiles = 1;
    game.notify(civ.id, 'Strategic missile ready.', { kind: 'warning', tile: b.tile });
  }
}

export function productionStep(game, dt) {
  const rates = game.civs.map(() => ({ materials: 0, energy: 0 }));
  beginProduction();
  for (const b of game.buildings.values()) {
    const civ = game.civs[b.owner], site = game.siteById.get(b.site), def = ACTION_BUILDINGS[b.type];
    const helpers = game.movers.query(b.x, b.z, b.radius + 1, []).filter((u) => u.owner === b.owner && u.type === 'engineer' && game.time - u.lastCombat > 4 && !u.attack && distance(u, b) < b.radius + 1).length;
    const buildRate = 1 + Math.min(2, helpers) * .20;
    b.fire = Math.max(0, b.fire - dt);
    // field structures are built by the base engineers (actionEngineers.js); perimeter pieces by the HQ project
    if (!b.done && def.field && !b.perimeterSlot) continue;
    if (!b.done) {
      const add = Math.min(1 - b.progress, dt * buildRate / b.buildTime);
      b.progress += add;
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * .66 * add);
      if (b.progress >= .999999) {
        b.done = true;
        b.progress = 1;
        b.state = 'operational';
        game.ruins.delete(b.tile);
        game.world.touch(b.tile);
        if (site) growBase(game, site);
        if (b.type === 'town') {
          if (site.maturityElapsed != null) site.developedAt = game.time - site.maturityElapsed;
          else if (!site.everEstablished) site.developedAt = game.time;
          site.everEstablished = true;
          site.maturityElapsed = null;
          civ.recoveryUntil = null;
          game.refreshTerritory();
          // a headquarters paid with its claim road (establish) is already connected; older saves link for free
          if (!site.claimRoadBuilt) connectSiteRoads(game, site);
          game.notify(civ.id, `${site.name} headquarters operational.`, { kind: 'city', tile: b.tile });
        }
      }
      continue;
    }
    // era levels: processors and generators produce +40% per level
    const output = def.levels?.effect === 'output' ? 1 + .4 * ((b.level || 1) - 1) : 1;
    if (def.materials) rates[b.owner].materials += def.materials * output;
    if (def.energy) rates[b.owner].energy += def.energy * output;
    if (def.repair) game.repairAround(civ, b, 2.4, def.repair * dt);
    const p = b.project;
    if (p) {
      p.left = Math.max(0, p.left - dt * (p.kind === 'repair' ? buildRate : 1));
      // W2: a structure under fire (hit in the last 5 s) repairs at 30%, so a besieged headquarters can't out-heal the siege
      if (p.kind === 'repair') b.hp = Math.min(b.maxHp, b.hp + b.maxHp * dt * buildRate / p.total * .83 * (game.time - (b.hitAt ?? -99) < 5 ? .3 : 1));
      if (p.left <= .0001) { completeProject(game, civ, b, p); b.project = null; }
    }
    // W1: shared-capacity production scheduler (actionProduction.runProduction); repeat lives on the queue
    if (def.trains) runProduction(game, civ, b, dt);
  }
  for (const site of game.sites) {
    if (site.owner < 0 || site.slots) continue;
    const def = OUTPOST_TYPES[site.kind];
    if (def.materials) rates[site.owner].materials += def.materials;
    if (def.energy) rates[site.owner].energy += def.energy;
    if (def.repair) game.repairAround(game.civs[site.owner], site, 2.3, def.repair * dt);
  }
  // income itself accrues every tick in incomeStep; trenches are dug by the engineers
  for (const civ of game.civs) if (civ.alive) civ.rates = rates[civ.id];
  // defenses and trenches claim territory: refresh when one is finished or lost, and every ~5 s
  if (game.territoryDirty || game.tickN % 50 < 3) { game.territoryDirty = false; game.refreshTerritory(); }
}

export function trenchLine(game, civ, points, reverse, preview, { anywhere = false } = {}) {
  const byTile = new Map(), walls = new Map();   // walls: tile -> the structure the stroke crosses inside it
  const visits = [];   // every hex the stroke enters, in drawing order (re-entries included): trenchRoutes
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const len = distance(a, b);
    if (len > 38) return { error: 'Draw a shorter trench line on visible, buildable ground.' };
    const steps = Math.max(1, Math.ceil(len / .38));
    let last = null;
    for (let n = 0; n <= steps; n++) {
      const p = game.lerpPoint(a, b, n / steps);
      const t = tileAt(p.x, p.z);
      // the stretch of stroke since the last sample: a structure on it blocks the hexes at both ends
      const wall = last && structureOnSegment(game, last, p, .14);
      if (wall) for (const q of [last, p]) { const k = tileAt(q.x, q.z); if (k >= 0 && !walls.has(k)) walls.set(k, wall.label); }
      last = p;
      if (t >= 0 && t !== visits.at(-1) && (byTile.has(t) || byTile.size < 22)) visits.push(t);
      if (t >= 0 && !byTile.has(t) && byTile.size < 22) {
        const front = Math.atan2(-(b.z - a.z), game.dx(a.x, b.x)) + (reverse ? Math.PI : 0);
        byTile.set(t, { tile: t, ...p, facing: front });
      }
    }
  }
  // 2026-11-17: forgiving strokes, like the terrain brush. Every hex of the line that can be dug is kept; the
  // others are skipped and listed in `skipped` ({ tile, x, z, why }), and the order is refused only when no hex
  // remains. A hex inside a structure's walls or an outpost compound is skipped (before, a stroke across a building
  // was refused as a whole).
  // 2026-11-18: trenches are dug on roads and beside them like anywhere else. A road hex of the line is a covered
  // crossing: the trench runs up to the carriageway on both sides and passes under timber and steel plates, so the
  // road stays open (trenches never change movement: no vehicle is slowed or blocked by one). Only a bridge or
  // causeway deck (a road over water) is skipped: there is no ground to dig.
  const skipped = [], why = {};
  let crossings = 0, outside = 0, blockedBy = null;
  const valid = [];
  for (const p of byTile.values()) {
    let code = null;
    if (p.tile < 0 || p.tile >= N) code = 'ground';
    else if (game.world.road[p.tile] && (game.world.river[p.tile] || game.world.lake[p.tile] || isWater(game.world.terr[p.tile]))) code = 'bridge';
    // 2026-11-17: trenches may be dug on your own or neutral ground, never in another player's territory
    else if (!anywhere && game.world.owner[p.tile] >= 0 && game.world.owner[p.tile] !== civ.id) { code = 'territory'; outside++; }
    else if (!civ.visible[p.tile]) code = 'hidden';
    else if (game.fieldworks.has(p.tile)) code = 'dug';
    else {
      if (walls.has(p.tile)) { code = 'blocked'; blockedBy ??= walls.get(p.tile); }
      else if (!game.nav.canStand(p.x, p.z, LIGHT_GROUND)) code = 'ground';
      else if (game.sites.some((s) => distance(s, p) < s.radius + .25 || s.slots && s.parcels.some((lot) => distance(lot, p) < .75))) code = 'base';
      else if (game.hasEnemyAt({ ...p, radius: .75 }, civ.id)) code = 'contested';
    }
    if (code) { skipped.push({ tile: p.tile, x: p.x, z: p.z, why: code }); why[code] = (why[code] || 0) + 1; }
    else { valid.push(p); if (game.world.road[p.tile]) crossings++; }
  }
  const cost = { materials: valid.length * 35 };
  if (!valid.length) {
    const code = Object.entries(why).sort((x, y) => y[1] - x[1])[0]?.[0];
    const error = code === 'territory' ? "Trenches go on your own territory or neutral ground, never in another player's territory."
      : code === 'bridge' ? 'A trench cannot be dug through a bridge: draw the line on dry ground.'
      : code === 'blocked' ? `The trench line runs through ${blockedBy}: draw it around the structure.`
      : code === 'hidden' ? 'Scout the trench line so its ground is currently visible.'
      : code === 'contested' ? 'The trench line is contested by enemy troops.'
      : 'Choose visible, clear ground outside protected city sites.';
    const refusal = { error, ...((code === 'territory' || code === 'blocked') && { code }) };
    // a preview still carries the skipped hexes so the client can draw them red under the refusal
    return preview ? { ...refusal, reply: { t: 'ack', ...refusal, trench: { positions: [], skipped, cost, crossings, outside } } } : refusal;
  }
  if (preview) return { reply: { t: 'ack', trench: { positions: valid.map((p) => ({ ...p, road: trenchRoadMask(game, p.tile) })), skipped, cost, crossings, outside } } };
  const error = affordable(civ, cost);
  if (error) return error;
  pay(civ, cost);
  const routes = trenchRoutes(game, civ, visits, byTile, new Set(valid.map((p) => p.tile)));
  for (const p of valid) {
    game.fieldworks.set(p.tile, { ...p, owner: civ.id, type: 'basic', dir: ((Math.round((Math.PI / 2 - p.facing) / (Math.PI / 3)) % 6) + 6) % 6,
      route: routes.get(p.tile) || 0, progress: 0, hp: 100, state: 'building' });
  }
  game.fwVer++;
  return { hexes: valid.length, skipped: skipped.length, ...(crossings && { crossings }) };
}

/**
 * Presentation links of a new trench line (bit d of a node's route: joined to NB[tile * 6 + d]; clients draw
 * the trench along these links only). Gameplay never reads the route.
 *
 * 2026-11-18 (second pass, "the trenches don't connect"): the links follow the stroke hex by hex as drawn. Each
 * hex the stroke enters for the first time is joined to the hex it came from (the last of the owner's trench
 * hexes on the stroke, so a stroke that clips a road or another skipped hex keeps going when the hexes either
 * side touch). Before, only consecutive hexes of the first-entry list were linked: a stroke that wiggled back into
 * a hex lost the link, and the line ran on as separate pieces. An existing trench the stroke runs through is
 * joined in on both sides (a crossing is one network), and every end of a dug run joins the owner's works beside
 * it: one end, the nearest; a lone hex (a gap redrawn between two works), both sides. No link closes a triangle,
 * so a stroke over a hex corner or along an older line draws no triangles or ladders.
 * @param visits every hex the stroke enters, in drawing order (re-entries included)
 * @param byTile the stroke's hexes (first sample each)
 * @param dug the hexes being dug
 */
function trenchRoutes(game, civ, visits, byTile, dug) {
  const routes = new Map();
  const dirTo = (a, b) => { for (let d = 0; d < 6; d++) if (NB[a * 6 + d] === b) return d; return -1; };
  const own = (t) => dug.has(t) || game.fieldworks.get(t)?.owner === civ.id;
  const bits = (t) => dug.has(t) ? routes.get(t) || 0 : game.fieldworks.get(t)?.owner === civ.id ? game.fieldworks.get(t).route || 0 : 0;
  const linked = (a, b) => { const d = dirTo(a, b); return d >= 0 && own(a) && own(b) && !!((bits(a) >> d & 1) || (bits(b) >> ((d + 3) % 6) & 1)); };
  const degree = (t) => { let n = 0; for (let d = 0; d < 6; d++) if (linked(t, NB[t * 6 + d])) n++; return n; };
  // a link a-b would close a triangle when a common neighbour is already joined to both
  const triangle = (a, b) => { for (let d = 0; d < 6; d++) { const x = NB[a * 6 + d]; if (x >= 0 && x !== b && linked(a, x) && linked(b, x)) return true; } return false; };
  const link = (a, b) => {
    const d = dirTo(a, b);
    if (d < 0 || a === b || !own(a) || !own(b) || linked(a, b) || triangle(a, b)) return false;
    for (const [x, k] of [[a, d], [b, (d + 3) % 6]]) {
      if (dug.has(x)) routes.set(x, (routes.get(x) || 0) | (1 << k));
      else { const f = game.fieldworks.get(x); f.route = (f.route || 0) | (1 << k); }
    }
    return true;
  };
  // 1. along the stroke: each hex joins the hex it was entered from (or, failing that, the latest hex beside it)
  const entered = new Set(), trail = [];
  for (const t of visits) {
    if (!own(t)) continue;   // skipped (road, hidden, blocked...): the hexes either side may still touch
    const first = !entered.has(t);
    entered.add(t);
    if (first && trail.length && (dug.has(t) || dug.has(trail.at(-1)))) {
      if (!link(trail.at(-1), t) && dug.has(t))
        for (let k = trail.length - 2; k >= 0; k--) if (dirTo(trail[k], t) >= 0 && link(trail[k], t)) break;
    }
    trail.push(t);
  }
  // 2. the ends of the dug runs join the owner's works beside them (nearest first): an end once, a lone hex twice
  for (const t of entered) {
    if (!dug.has(t)) continue;
    const p = byTile.get(t);
    const near = [];
    for (let d = 0; d < 6; d++) {
      const f = game.fieldworks.get(NB[t * 6 + d]);
      if (f && f.owner === civ.id && !dug.has(f.tile) && !linked(t, f.tile)) near.push({ tile: f.tile, gap: distance(p, f) });
    }
    near.sort((x, y) => x.gap - y.gap || x.tile - y.tile);
    for (const n of near) { if (degree(t) >= 2) break; link(t, n.tile); }
  }
  // 3. a free end of an older line beside the new one joins it (a T where the old line stops at the new)
  for (const t of entered) {
    if (!dug.has(t)) continue;
    for (let d = 0; d < 6; d++) {
      const f = game.fieldworks.get(NB[t * 6 + d]);
      if (!f || f.owner !== civ.id || dug.has(f.tile) || degree(f.tile) >= 2 || linked(t, f.tile)) continue;
      let best = -1, gap = Infinity;
      for (let e = 0; e < 6; e++) {
        const n = NB[f.tile * 6 + e];
        if (!dug.has(n)) continue;
        const q = byTile.get(n), m = distance(q, f);
        if (m < gap || m === gap && n < best) { best = n; gap = m; }
      }
      if (best >= 0) link(f.tile, best);
    }
  }
  return routes;
}

/**
 * Road crossing mask of a trench tile: bit d (0-5, the server's NB direction order) is set when the
 * neighbour in direction d carries a road. Clients end the trench square on that side and keep the
 * road surface clear (the trench line itself is never dug on a road tile).
 */
export function trenchRoadMask(game, tile) {
  let mask = 0;
  for (let d = 0; d < 6; d++) { const n = NB[tile * 6 + d]; if (n >= 0 && game.world.road[n]) mask |= 1 << d; }
  return mask;
}

function repairInfrastructure(game, civ, engineer) {
  let changed = false, repaired = 0, cleared = 0;
  const seen = new Set();
  for (const tile of disk(engineer.tile, 1)) for (const edge of game.roads.edgesOf(tile)) {
    if (seen.has(edge) || edge.cond >= 95 || repaired >= 4) continue;
    seen.add(edge);
    if ([edge.a, edge.b].some((t) => game.world.owner[t] >= 0 && !game.allied(civ.id, game.world.owner[t]))) continue;
    const middle = game.lerpPoint(centerOf(edge.a), centerOf(edge.b), .5);
    if (distance(engineer, middle) > 2.3 || !canPay(civ, { materials: 20 })) continue;
    pay(civ, { materials: 20 });
    game.roads.set(edge.a, edge.b, edge.type, Math.min(100, edge.cond + 65)); changed = true; repaired++;
  }
  for (const tile of disk(engineer.tile, 1)) {
    const list = game.wrecks.get(tile); if (!list) continue;
    const remaining = [];
    for (const w of list) {
      if (cleared >= 3 || w.x == null || distance(w, engineer) > 1.2 || !canPay(civ, { materials: 10 })) { remaining.push(w); continue; }
      pay(civ, { materials: 10 }); cleared++; changed = true;
    }
    if (remaining.length !== list.length) {
      if (remaining.length) game.wrecks.set(tile, remaining); else game.wrecks.delete(tile);
      game.world.touch(tile); game.bfVer++;
    }
  }
  if (changed) game.nav.invalidate(disk(engineer.tile, 1));   // Pass 6: only the caches around the cleared wrecks
}

// Demolition: the owner tears down a finished facility or field work (never a headquarters), recovering
// part of its materials. The ring parcel it stood on becomes an open construction site again.
export const DEMOLISH_REFUND = .35;
// Cancel a structure still under construction (overhaul §12). Construction is paid when ordered; the share of the
// cost matching the work already done is spent and not refunded (the production rule, REQUIREMENTS R2), the
// unbuilt share comes back.
export function cancelConstruction(game, civ, id) {
  const b = game.buildings.get(id);
  if (!b || b.owner !== civ.id) return { error: 'Select one of your structures under construction.' };
  if (b.done) return { error: 'This structure is already complete.' };
  if (b.type === 'town') return { error: 'Headquarters construction cannot be cancelled.' };
  const def = ACTION_BUILDINGS[b.type];
  const left = Math.max(0, Math.min(1, 1 - (b.progress || 0)));
  const refund = {};
  for (const [k, v] of Object.entries(def?.cost || {})) { refund[k] = Math.floor(v * left); civ.res[k] = (civ.res[k] || 0) + refund[k]; }
  const site = game.siteById.get(b.site);
  game.removeBuilding(b);
  game.notify(civ.id, `${def?.name || 'Construction'} cancelled (${Math.round((1 - left) * 100)}% built; +${refund.materials || 0} Materials returned).`, { kind: 'building', tile: b.tile });
  return { cancelled: b.id, refund, slot: b.slot || 0, site: site?.id || 0 };
}

export function demolish(game, civ, id) {
  const b = game.buildings.get(id);
  if (!b || b.owner !== civ.id) return { error: 'Select one of your structures to demolish.' };
  if (b.type === 'town') return { error: 'Headquarters cannot be demolished.' };
  if (!b.done) return { error: 'Only completed structures can be demolished.' };
  if (queuesOf(b, game).length || b.project) return { error: 'Cancel production or projects in this structure first.' };
  const refund = Math.floor((ACTION_BUILDINGS[b.type].cost.materials || 0) * DEMOLISH_REFUND);
  civ.res.materials += refund;
  const site = game.siteById.get(b.site);
  emit(game, { k: 'demolish', a: b.tile, b: b.tile, bx: b.x, bz: b.z, t: b.id, ow: b.owner, ty: b.type });
  game.removeBuilding(b);
  game.notify(civ.id, `${ACTION_BUILDINGS[b.type].name} demolished (+${refund} Materials).`, { kind: 'building', tile: b.tile });
  return { refund, slot: b.slot || 0, site: site?.id || 0 };
}

export function useAbility(game, civ, group, kind, point) {
  const def = Object.hasOwn(ABILITIES, kind) ? ABILITIES[kind] : null;
  if (!def || def.point && !point) return { error: 'Choose an ability and its target.' };
  let used = 0, tooClose = null;
  for (const u of group) {
    const spec = ACTION_UNITS[u.type];
    if (spec.ability !== kind || u.abilityReady > game.time) continue;
    if (kind === 'bombard') {
      if (distance(u, point) > spec.range * 1.35 || !civ.explored[tileAt(point.x, point.z)]) continue;
      if (spec.minRange && distance(u, point) < spec.minRange) { tooClose = spec; continue; }   // inside the dead zone
      // Crew weapons and launchers (spec.setup) must be set up first: halt, and actionCombat fires the salvo once
      // the unit has stood still for spec.setup seconds (moving again cancels it and returns the cooldown).
      if (spec.setup && (!u.deployed || u.vx || u.vz)) {
        if (!u.bombardAt) { u.orders.length = 0; u.pursuit = null; stopUnit(game, u); }
        u.bombardAt = { x: point.x, z: point.z };
      } else game.bombard(u, point);
    } else if (kind === 'repair') { game.repairAround(civ, u, 2.35, 39, true); repairInfrastructure(game, civ, u); }
    else if (kind === 'patrol' || kind === 'strike' || kind === 'gun_run') {
      const issued = moveGroup(game, [u], point, { mode: 'assault' });
      if (issued.error) continue;
      u.airOrder = { kind, point };
    } else if (kind === 'cover') { u.attack = null; u.orders.length = 0; stopUnit(game, u); u.mode = 'guard'; }
    u.abilityReady = game.time + def.cooldown;
    u.abilityUntil = game.time + (def.duration || 0);
    used++;
  }
  if (!used && tooClose) return { error: `Too close: the ${tooClose.name} cannot fire within ${tooClose.minRange} hexes.`, code: 'minRange' };
  return used ? { used } : { error: 'No selected unit can use that ability here.' };
}
