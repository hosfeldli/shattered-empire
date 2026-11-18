import { N, T, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';
import { ABILITIES, ACTION_BUILDINGS, ACTION_RESOURCES, ACTION_UNITS, ACTION_UPGRADES, CITY_DEFENSES, DEFENSE_INFLUENCE, MISSILE_PROJECT, NEW_BASE_GAP, OUTPOST_TYPES, TIERS } from './actionDefinitions.js';
import { centerOf, distance, HEAVY_GROUND, LIGHT_GROUND, structureOnSegment, tileAt } from './actionNavigation.js';
import { hubRoute, hubTiles, ROAD_SEARCH } from './actionMap.js';
import { launchStrategic } from './actionCombat.js';
import { moveGroup, stopUnit } from './actionOrders.js';
import { emit } from './combat.js';
import { newBaseRing } from './actionEngineers.js';
import { HASTE } from './actionUpgrades.js';

const ERA = [0, 1, 2, 4];
export const canPay = (civ, cost) => ACTION_RESOURCES.every((key) => civ.res[key] >= (cost[key] || 0));
function pay(civ, cost, factor = -1) {
  for (const key of ACTION_RESOURCES) civ.res[key] += (cost[key] || 0) * factor;
}
const affordable = (civ, cost) => canPay(civ, cost) ? null : { error: 'Insufficient materials or energy.' };

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
    yaw: point ? point.yaw || 0 : parcel?.yaw || 0, queue: [], rally: null, readyAt: 0, level: 1, era: ERA[site?.tier || civ.age + 1], fire: 0, lastCombat: -999, missiles: 0, project: null,
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
  game.nav.invalidate();
  game.clearFootprint(b);
  if (instant && site) growBase(game, site);
  return b;
}

export function establish(game, civ, site) {
  if (!site?.slots || site.owner !== civ.id) return { error: 'Capture a city ruin before establishing a headquarters.' };
  if (site.hq) return { error: 'This site already has a headquarters.' };
  if (site.contested || game.hasEnemyAt(site, civ.id)) return { error: 'Clear hostile ground troops from the command zone first.' };
  const recovery = civ.recoveryUntil > game.time && !civ.emergencyUsed;
  const def = ACTION_BUILDINGS.town, cost = recovery ? { materials: 140 } : def.cost;
  const error = affordable(civ, cost);
  if (error) return error;
  if (game.obstaclesAtTile(site.tile).some((b) => distance(b, site) < b.radius + .51)) return { error: 'The headquarters parcel is occupied.' };
  const b = addFacility(game, civ, site, 'town', site.tile, { duration: site.kind === 'town' ? def.time * .8 : def.time });
  if (recovery) civ.emergencyUsed = true;
  pay(civ, cost);
  return { building: b.id };
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
/** Build-wheel ground: your own territory, and for defenses (def.defense) also neutral ground; never another player's land. */
/** A build site counts as known when it is visible now or lies in your own territory. */
const known = (game, civ, t) => !!civ.visible[t] || game.world.owner[t] === civ.id;
export const placeableBy = (game, civ, def, t) => { const o = game.world.owner[t]; return o === civ.id || !!def.defense && o < 0; };
/** The price of a build-wheel structure at a tile: defenses outside the ring of influence cost DEFENSE_INFLUENCE.factor ×. */
export function fieldCost(game, civ, type, tile) {
  const def = ACTION_BUILDINGS[type];
  if (!def?.defense || tile < 0 || influenceRing(game, civ)[tile] <= DEFENSE_INFLUENCE.reach) return { cost: def?.cost, surcharge: 1 };
  const f = DEFENSE_INFLUENCE.factor;
  return { cost: Object.fromEntries(Object.entries(def.cost).map(([k, v]) => [k, Math.ceil(v * f)])), surcharge: f };
}

export function constructDefense(game, civ, type, point, preview = false, yaw = 0) {
  const def = Object.hasOwn(ACTION_BUILDINGS, type) ? ACTION_BUILDINGS[type] : null;
  if (!def?.field || !point) return { error: 'Choose a tactical defense and a location.' };
  if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return { error: 'Choose a valid structure rotation.' };
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  const tile = tileAt(point.x, point.z);
  if (civ.age + 1 < def.tier) return { error: 'This defense requires more advanced global technology.' };
  // 2026-11-17: ground in your own territory need not be in sight (fogged corners of a settlement no longer block
  // its defenses); neutral ground must still be scouted.
  if (tile < 0 || !known(game, civ, tile)) return { error: 'Scout the construction site so it is currently visible.' };
  if (!placeableBy(game, civ, def, tile)) return def.defense
    ? { error: 'Defenses go on your own territory or neutral ground, never in another player\'s territory.', code: 'territory' }
    : { error: 'Build only inside your own territory.', code: 'territory' };
  if (def.newBase) return placeNewBase(game, civ, type, tile, preview);
  // a pending New Base keeps its whole building ring clear
  if ([...game.buildings.values()].some((b) => b.type === 'base_site' && distance(b, point) < 2.75 + def.radius)) return { error: 'Keep clear of the new base being built.' };
  const protectedZone = game.sites.some((s) => distance(s, point) < s.radius + def.radius + .10 ||
    s.slots && (s.parcels.some((p) => distance(p, point) < def.radius + .62) || s.owner >= 0 && game.hostile(civ.id, s.owner) && s.hq && distance(s, point) < 2.65 + def.radius));
  if (protectedZone || game.fieldworks.has(tile) ||
    !game.nav.canStand(point.x, point.z, { ...LIGHT_GROUND, radius: def.radius })) return { error: 'Choose clear ground outside a base parcel or road.' };
  if (def.width) for (const [sx, sz] of [[-1,-1],[-1,1],[1,-1],[1,1],[0,-1],[0,1],[-1,0],[1,0]]) {
    const x = point.x + sx * def.width * .5 * Math.cos(yaw) + sz * def.depth * .5 * Math.sin(yaw);
    const z = point.z - sx * def.width * .5 * Math.sin(yaw) + sz * def.depth * .5 * Math.cos(yaw), t = tileAt(x, z);
    if (t < 0 || !known(game, civ, t) || !placeableBy(game, civ, def, t) || !game.nav.canStand(x,z,{...LIGHT_GROUND,radius:.025}) || Math.abs(game.world.elev[t] - game.world.elev[tile]) > .10)
      return { error: 'The rotated footprint needs visible, level and unobstructed ground.' };
  }
  if (game.hasEnemyAt({ ...point, radius: .75 }, civ.id)) return { error: 'The position is contested.' };
  const { cost, surcharge } = fieldCost(game, civ, type, tile), note = surcharge > 1 ? DEFENSE_INFLUENCE.note : null;
  if (!canPay(civ, cost)) return note ? { error: `Insufficient materials or energy · ${note}.`, code: 'influence' } : { error: 'Insufficient materials or energy.' };
  if (preview) return { reply: { t: 'ack', placement: { valid: true, cost, seconds: def.time, ...(note && { surcharge, note }) } } };
  const b = addFacility(game, civ, null, type, tile, { point: { ...point, yaw } });
  pay(civ, cost);
  return { building: b.id };
}

// New Base (build wheel): own territory, on or beside a road, NEW_BASE_GAP from every base site, 3.5 from
// outposts, and room for a full building ring. The engineers build it; on completion it becomes a real
// base site with an operational headquarters (actionEngineers.foundBase).
function placeNewBase(game, civ, type, tile, preview) {
  const def = ACTION_BUILDINGS[type], point = centerOf(tile), w = game.world;
  if (!w.road[tile] && !NB.slice(tile * 6, tile * 6 + 6).some((n) => n >= 0 && w.road[n])) return { error: 'A new base must connect to a road: place it on or beside one.', code: 'road' };
  if (game.sites.some((s) => distance(s, point) < (s.slots ? NEW_BASE_GAP : 3.5)) ||
    [...game.buildings.values()].some((b) => b.type === 'base_site' && distance(b, point) < NEW_BASE_GAP)) return { error: 'Too close to another base or outpost.', code: 'spacing' };
  if (!game.nav.canStand(point.x, point.z, { ...LIGHT_GROUND, radius: def.radius }) || game.fieldworks.has(tile) || game.buildingAtTile(tile)) return { error: 'Choose clear, open ground.' };
  const plan = newBaseRing(game, tile);
  if (plan.error) return { error: plan.error, code: 'ring' };
  if (game.hasEnemyAt({ ...point, radius: 1.5 }, civ.id)) return { error: 'The position is contested.' };
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
    for (const offset of [0, .16, -.16]) for (const radius of [3.0, 3.35, 3.7]) {
      const a = angle + offset, p = { x: site.x + Math.sin(a) * radius, z: site.z + Math.cos(a) * radius, yaw: a };
      const tile = tileAt(p.x, p.z);
      if (point || tile < 0 || game.hasEnemyAt({ ...p, radius: .7 }, civ.id) ||
        plans.some((q) => distance(q.point, p) < def.radius + ACTION_BUILDINGS[q.type].radius + .15) ||
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

export function startUpgrade(game, civ, key, buildingId = 0) {
  const def = Object.hasOwn(ACTION_UPGRADES, key) ? ACTION_UPGRADES[key] : null;
  if (!def || civ.techs.has(key)) return { error: 'That upgrade is unavailable.' };
  const facility = def?.at || 'armory';
  const armories = [...game.buildings.values()].filter((b) => b.type === facility && b.done && b.owner === civ.id);
  if (armories.some((b) => b.project?.key === key)) return { error: 'This upgrade is already in progress.' };
  const b = civ.age + 1 >= def.tier ? armories.find((b) => !b.project && (!buildingId || b.id === buildingId)) : null;
  if (!b) return { error: `An idle Tier ${TIERS[def.tier - 1].label} ${facility === 'barracks' ? 'Barracks' : 'Armory'} is required.` };
  const error = affordable(civ, def.cost);
  if (error) return error;
  const duration = def.time * (game.siteById.get(b.site).kind === 'research' ? .88 : 1);
  b.project = { kind: 'upgrade', key, left: duration, total: duration };
  pay(civ, def.cost);
  return {};
}

export function armyCapacity(game, civ) {
  let used = 0, queued = 0;
  for (const u of game.units.values()) if (u.owner === civ.id && !u.auto) used += ACTION_UNITS[u.type].capacity;   // base engineers are free
  for (const b of game.buildings.values()) {
    if (b.owner !== civ.id || !b.done) continue;
    for (const q of b.queue) queued += ACTION_UNITS[q.unit].capacity;
  }
  // Era capacities sized for large combined-arms battles.
  const limit = [140, 220, 300][Math.max(0, Math.min(2, civ.age))];
  return { used, queued, limit: Math.min(game.armyLimit, limit) };
}

export function train(game, civ, ids, type, count, perBuilding = false) {
  const def = Object.hasOwn(ACTION_UNITS, type) ? ACTION_UNITS[type] : null;
  if (!def || def.auto || !Array.isArray(ids) || !Number.isInteger(count) || count < 1 || count > 40) return { error: 'Choose a unit and training quantity.' };
  const buildings = [...new Set(ids.slice(0, 40))].map((id) => game.buildings.get(id)).filter((b) =>
    b?.owner === civ.id && b.done && b.type === def.facility && civ.age + 1 >= def.tier);
  if (!buildings.length) return { error: 'Select an operational facility at the required tier.' };
  const cap = armyCapacity(game, civ);
  let free = cap.limit - cap.used - cap.queued, queued = 0, reason = '';
  const ready = new Map(buildings.map((b) => [b.id, b.queue.reduce((n, q) => n + q.left, 0)]));
  for (let i = 0; i < (perBuilding ? count * buildings.length : count); i++) {
    if (free < def.capacity) { reason = 'Command capacity reached.'; break; }
    if (!canPay(civ, def.cost)) { reason = 'Insufficient materials or energy.'; break; }
    const b = perBuilding ? buildings[i % buildings.length] :
      buildings.filter((b) => b.queue.length < 8).sort((a, b) => ready.get(a.id) - ready.get(b.id) || a.id - b.id)[0];
    if (!b || b.queue.length >= 8) { reason = 'Production queue full.'; if (perBuilding) continue; break; }
    const site = game.siteById.get(b.site);
    const bonus = (site.kind === 'industrial' && def.facility === 'motor_works') || (site.kind === 'military' && def.facility === 'barracks') ||
      (site.kind === 'coastal' && def.facility === 'airfield');
    const total = def.time * (bonus ? .88 : 1) * (1 - .15 * ((b.level || 1) - 1));   // production level: -15% per level
    pay(civ, def.cost);
    b.queue.push({ unit: type, left: total, total });
    ready.set(b.id, ready.get(b.id) + total);
    free -= def.capacity;
    queued++;
  }
  return queued ? { reply: { t: 'ack', training: { queued, reason } } } : { error: reason || 'Nothing was queued.' };
}

export function cancelTraining(game, civ, id, index) {
  const b = game.buildings.get(id);
  if (b?.owner !== civ.id || !Number.isInteger(index) || index < 0 || index >= b.queue.length) return { error: 'That queue entry is no longer available.' };
  const [q] = b.queue.splice(index, 1);
  pay(civ, ACTION_UNITS[q.unit].cost, 1);
  return {};
}

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
  const pending = new Set(game.roadProjects.flatMap((p) => p.edges.map((e) => Math.min(e.a, e.b) + ':' + Math.max(e.a, e.b))));
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
    civ.techs.add(p.key);
    game.notify(civ.id, `${ACTION_UPGRADES[p.key].name} complete.`, { kind: 'tech', tile: b.tile });
  } else if (p.kind === 'missile') {
    b.missiles = 1;
    game.notify(civ.id, 'Strategic missile ready.', { kind: 'warning', tile: b.tile });
  }
}

export function productionStep(game, dt) {
  const rates = game.civs.map(() => ({ materials: 0, energy: 0 }));
  for (const b of game.buildings.values()) {
    const civ = game.civs[b.owner], site = game.siteById.get(b.site), def = ACTION_BUILDINGS[b.type];
    const helpers = game.movers.query(b.x, b.z, b.radius + 1, []).filter((u) => u.owner === b.owner && u.type === 'engineer' && game.time - u.lastCombat > 4 && !u.attack && distance(u, b) < b.radius + 1).length;
    const buildRate = (civ.techs.has('field_engineering') ? 1.25 : 1) * (1 + Math.min(2, helpers) * .20);
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
          connectSiteRoads(game, site);
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
    if (!b.queue.length && b.repeat && (game.tickN + b.id) % 10 < 3) train(game, civ, [b.id], b.repeat, 1);
    const q = b.queue[0];
    if (!q) continue;
    q.left = Math.max(0, q.left - dt);
    if (q.left > .0001) continue;
    const u = game.spawn(civ, q.unit, b);
    if (!u) { b.state = 'exit blocked'; continue; }
    b.state = 'operational';
    b.queue.shift();
    game.reinforce(b, u);
    if (civ.techs.has('improved_logistics') && u.goal) u.hasteUntil = game.time + HASTE.seconds;
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
      if (t >= 0 && !byTile.has(t) && byTile.size < 22) {
        const front = Math.atan2(-(b.z - a.z), game.dx(a.x, b.x)) + (reverse ? Math.PI : 0);
        byTile.set(t, { tile: t, ...p, facing: front });
      }
    }
  }
  // 2026-11-17: forgiving strokes, like the terrain brush. Every hex of the line that can be dug is kept; the
  // others are skipped and listed in `skipped` ({ tile, x, z, why }), and the order is refused only when no hex
  // remains. Roads stay open as crossings (see trenchRoadMask); a hex inside a structure's walls or an outpost
  // compound is skipped (before, a stroke across a building was refused as a whole).
  const skipped = [], why = {};
  let crossings = 0, outside = 0, blockedBy = null;
  const valid = [];
  for (const p of byTile.values()) {
    let code = null;
    if (p.tile < 0 || p.tile >= N) code = 'ground';
    else if (game.world.road[p.tile]) { code = 'road'; crossings++; }
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
    else valid.push(p);
  }
  const cost = { materials: valid.length * 35 };
  if (!valid.length) {
    const code = Object.entries(why).sort((x, y) => y[1] - x[1])[0]?.[0];
    const error = code === 'territory' ? "Trenches go on your own territory or neutral ground, never in another player's territory."
      : code === 'road' ? 'Trenches leave roads open: draw the line across open ground beside the road.'
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
  for (const p of valid) {
    let route = 0;
    for (let d = 0; d < 6; d++) if (valid.some((n) => n.tile === NB[p.tile * 6 + d])) route |= 1 << d;
    game.fieldworks.set(p.tile, { ...p, owner: civ.id, type: 'basic', dir: ((Math.round((Math.PI / 2 - p.facing) / (Math.PI / 3)) % 6) + 6) % 6,
      route, progress: 0, hp: 100, state: 'building' });
  }
  game.fwVer++;
  return { hexes: valid.length, skipped: skipped.length, ...(crossings && { crossings }) };
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
  if (changed) game.nav.invalidate();
}

// Demolition: the owner tears down a finished facility or field work (never a headquarters), recovering
// part of its materials. The ring parcel it stood on becomes an open construction site again.
export const DEMOLISH_REFUND = .35;
export function demolish(game, civ, id) {
  const b = game.buildings.get(id);
  if (!b || b.owner !== civ.id) return { error: 'Select one of your structures to demolish.' };
  if (b.type === 'town') return { error: 'Headquarters cannot be demolished.' };
  if (!b.done) return { error: 'Only completed structures can be demolished.' };
  if (b.queue.length || b.project) return { error: 'Cancel production or projects in this structure first.' };
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
  let used = 0;
  for (const u of group) {
    const spec = ACTION_UNITS[u.type];
    if (spec.ability !== kind || u.abilityReady > game.time) continue;
    if (kind === 'bombard') {
      if (distance(u, point) > spec.range * 1.35 || !civ.explored[tileAt(point.x, point.z)]) continue;
      game.bombard(u, point);
    } else if (kind === 'repair') { game.repairAround(civ, u, 2.35, 39, true); repairInfrastructure(game, civ, u); }
    else if (kind === 'patrol' || kind === 'strike') {
      const issued = moveGroup(game, [u], point, { mode: 'assault' });
      if (issued.error) continue;
      u.airOrder = { kind, point };
    } else if (kind === 'cover') { u.attack = null; u.orders.length = 0; stopUnit(game, u); u.mode = 'guard'; }
    u.abilityReady = game.time + def.cooldown;
    u.abilityUntil = game.time + (def.duration || 0);
    used++;
  }
  return used ? { used } : { error: 'No selected unit can use that ability here.' };
}
