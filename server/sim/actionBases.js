import { N, T, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';
import { ABILITIES, ACTION_BUILDINGS, ACTION_RESOURCES, ACTION_UNITS, ACTION_UPGRADES, MISSILE_PROJECT, OUTPOST_TYPES, TIERS } from './actionDefinitions.js';
import { centerOf, distance, LIGHT_GROUND, tileAt } from './actionNavigation.js';
import { launchStrategic } from './actionCombat.js';
import { moveGroup, stopUnit } from './actionOrders.js';

const ERA = [0, 1, 2, 4];
export const canPay = (civ, cost) => ACTION_RESOURCES.every((key) => civ.res[key] >= (cost[key] || 0));
function pay(civ, cost, factor = -1) {
  for (const key of ACTION_RESOURCES) civ.res[key] += (cost[key] || 0) * factor;
}
const affordable = (civ, cost) => canPay(civ, cost) ? null : { error: 'Insufficient materials or energy.' };

export const headquarters = (game, site) => site?.hq ? game.buildings.get(site.hq) : null;
export function openSlots(game, site) {
  const count = Math.min(8, 4 + (site.tier - 1) * 2);
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
    yaw: point ? 0 : parcel?.yaw || 0, queue: [], rally: null, readyAt: 0, level: 1, era: ERA[site?.tier || civ.age + 1], fire: 0, lastCombat: -999, missiles: 0, project: null,
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

export function constructDefense(game, civ, type, point, preview = false) {
  const def = Object.hasOwn(ACTION_BUILDINGS, type) ? ACTION_BUILDINGS[type] : null;
  if (!def?.field || !point) return { error: 'Choose a tactical defense and a location.' };
  const tile = tileAt(point.x, point.z);
  if (civ.age + 1 < def.tier) return { error: 'This defense requires more advanced global technology.' };
  if (tile < 0 || !civ.visible[tile]) return { error: 'Scout the construction site so it is currently visible.' };
  const protectedZone = game.sites.some((s) => distance(s, point) < s.radius + def.radius + .10 ||
    s.slots && (s.parcels.some((p) => distance(p, point) < def.radius + .62) || s.owner >= 0 && game.hostile(civ.id, s.owner) && s.hq && distance(s, point) < 2.65 + def.radius));
  if (protectedZone || game.fieldworks.has(tile) ||
    !game.nav.canStand(point.x, point.z, { ...LIGHT_GROUND, radius: def.radius })) return { error: 'Choose clear ground outside a base parcel or road.' };
  if (game.hasEnemyAt({ ...point, radius: .75 }, civ.id)) return { error: 'The position is contested.' };
  const error = affordable(civ, def.cost);
  if (error) return error;
  if (preview) return { reply: { t: 'ack', placement: { valid: true, cost: def.cost, seconds: def.time } } };
  const b = addFacility(game, civ, null, type, tile, { point });
  pay(civ, def.cost);
  return { building: b.id };
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

export function startUpgrade(game, civ, key) {
  const def = Object.hasOwn(ACTION_UPGRADES, key) ? ACTION_UPGRADES[key] : null;
  if (!def || civ.techs.has(key)) return { error: 'That upgrade is unavailable.' };
  const armories = [...game.buildings.values()].filter((b) => b.type === 'armory' && b.done && b.owner === civ.id);
  if (armories.some((b) => b.project?.key === key)) return { error: 'This upgrade is already in progress.' };
  const b = civ.age + 1 >= def.tier ? armories.find((b) => !b.project) : null;
  if (!b) return { error: `An idle Tier ${TIERS[def.tier - 1].label} Armory is required.` };
  const error = affordable(civ, def.cost);
  if (error) return error;
  const duration = def.time * (game.siteById.get(b.site).kind === 'research' ? .88 : 1);
  b.project = { kind: 'upgrade', key, left: duration, total: duration };
  pay(civ, def.cost);
  return {};
}

export function armyCapacity(game, civ) {
  let used = 0, queued = 0;
  for (const u of game.units.values()) if (u.owner === civ.id) used += ACTION_UNITS[u.type].capacity;
  for (const b of game.buildings.values()) {
    if (b.owner !== civ.id || !b.done) continue;
    for (const q of b.queue) queued += ACTION_UNITS[q.unit].capacity;
  }
  const limit = [80, 120, 160][Math.max(0, Math.min(2, civ.age))];
  return { used, queued, limit: Math.min(game.armyLimit, limit + (civ.techs.has('networked_command') ? 20 : 0)) };
}

export function train(game, civ, ids, type, count, perBuilding = false) {
  const def = Object.hasOwn(ACTION_UNITS, type) ? ACTION_UNITS[type] : null;
  if (!def || !Array.isArray(ids) || !Number.isInteger(count) || count < 1 || count > 40) return { error: 'Choose a unit and training quantity.' };
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
    const total = def.time * (bonus ? .88 : 1);
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
    game.notify(civ.id, `${site.name} advanced to Tier ${TIERS[p.tier - 1].label}.`, { kind: 'age', tile: site.tile });
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
          game.notify(civ.id, `${site.name} headquarters operational.`, { kind: 'city', tile: b.tile });
        }
      }
      continue;
    }
    if (def.materials) rates[b.owner].materials += b.type === 'depot' && civ.techs.has('improved_logistics') ? 175 / 60 : def.materials;
    if (def.energy) rates[b.owner].energy += b.type === 'power_plant' && civ.techs.has('improved_logistics') ? 100 / 60 : def.energy;
    if (def.repair) game.repairAround(civ, b, 2.4, def.repair * dt);
    const p = b.project;
    if (p) {
      p.left = Math.max(0, p.left - dt * (p.kind === 'repair' ? buildRate : 1));
      if (p.kind === 'repair') b.hp = Math.min(b.maxHp, b.hp + b.maxHp * dt * buildRate / p.total * .83);
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
  }
  for (const site of game.sites) {
    if (site.owner < 0 || site.slots) continue;
    const def = OUTPOST_TYPES[site.kind];
    if (def.materials) rates[site.owner].materials += def.materials;
    if (def.energy) rates[site.owner].energy += def.energy;
    if (def.repair) game.repairAround(game.civs[site.owner], site, 2.3, def.repair * dt);
  }
  for (const civ of game.civs) {
    if (!civ.alive) continue;
    const rate = rates[civ.id];
    civ.rates = rate;
    pay(civ, rate, dt);
  }
  for (const f of game.fieldworks.values()) {
    if (f.progress >= 1) continue;
    if (game.hasEnemyAt({ ...f, radius: .75 }, f.owner)) continue;
    f.progress = Math.min(1, f.progress + dt / 7 * (game.hasEngineer(game.civs[f.owner], f, 1.1) ? 1.2 : 1));
    if (f.progress >= .99999) { f.progress = 1; f.state = 'built'; }
  }
}

export function trenchLine(game, civ, points, reverse, preview) {
  const byTile = new Map();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const len = distance(a, b);
    if (len > 38) return { error: 'Draw a shorter trench line on visible, buildable ground.' };
    const steps = Math.max(1, Math.ceil(len / .38));
    for (let n = 0; n <= steps; n++) {
      const p = game.lerpPoint(a, b, n / steps);
      const t = tileAt(p.x, p.z);
      if (t >= 0 && !byTile.has(t) && byTile.size < 22) {
        const front = Math.atan2(-(b.z - a.z), game.dx(a.x, b.x)) + (reverse ? Math.PI : 0);
        byTile.set(t, { tile: t, ...p, facing: front });
      }
    }
  }
  const valid = [...byTile.values()].filter((p) => p.tile >= 0 && p.tile < N && civ.visible[p.tile] && !game.fieldworks.has(p.tile) &&
    game.nav.canStand(p.x, p.z, LIGHT_GROUND) && !game.sites.some((s) => distance(s, p) < s.radius + .25 ||
      s.slots && s.parcels.some((lot) => distance(lot, p) < .75)) && !game.hasEnemyAt({ ...p, radius: .75 }, civ.id));
  const cost = { materials: valid.length * 35 };
  if (preview) return { reply: { t: 'ack', trench: { positions: valid, cost } } };
  if (!valid.length) return { error: 'Choose visible, clear ground outside protected city sites.' };
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
  return {};
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
