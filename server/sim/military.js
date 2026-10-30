// Units: movement (flow fields, formations, tile/bridge capacity), combat (incl. air),
// supply networks & attrition, engineers, and damage that persists in the world.
import { N, T, TERRAIN, UNITS, BUILDINGS, MOVE, ROAD_TYPES, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';
import { findPath, stepCost, flowField } from './path.js';
import { MinHeap } from './world.js';
import { transferCity, recomputeTerritory } from './economy.js';

export function spawnUnit(g, civ, type, tile) {
  const def = UNITS[type];
  const maxHp = Math.round(def.hp);
  const u = { id: g.id_(), owner: civ.id, type, tile, next: -1, prog: 0, path: [], goal: -1, slot: -1, hp: maxHp, maxHp, supply: 100, cooldown: 0,
    order: { kind: 'idle' }, lastCombat: -99, outOfSupply: false, repathAt: 0, home: tile, stance: def.civilian ? 'passive' : 'defensive', field: false, wait: 0, status: 'ok', groupSpeed: 0 };
  g.units.set(u.id, u);
  return u;
}

const isAir = (u) => !!UNITS[u.type].air;
export function canHit(attDef, target) { return UNITS[target.type].air ? (attDef.aa || 0) > 0 : true; }

function targetTile(g, tg) {
  if (!tg) return -1;
  if (tg.kind === 'unit') { const t = g.units.get(tg.id); return t ? t.tile : -1; }
  const b = g.buildings.get(tg.id); return b ? b.tile : -1;
}
function targetOwner(g, tg) {
  if (tg.kind === 'unit') { const t = g.units.get(tg.id); return t ? t.owner : -1; }
  const b = g.buildings.get(tg.id); return b ? b.owner : -1;
}

function findEnemyNear(g, u, radius) {
  const def = UNITS[u.type];
  let best = null, bd = Infinity;
  for (const t of disk(u.tile, radius)) {
    const ids = g.tileUnits.get(t);
    if (ids) for (const id of ids) {
      const e = g.units.get(id);
      if (!e || !g.hostile(u.owner, e.owner) || !canHit(def, e) || !g.detects(u.owner, e)) continue;
      const d = dist(u.tile, t) + (UNITS[e.type].civilian ? 0.5 : 0);
      if (d < bd) { bd = d; best = { kind: 'unit', id }; }
    }
    const b = g.buildingAtTile(t);
    if (b && g.hostile(u.owner, b.owner)) { const d = dist(u.tile, t) + 0.8; if (d < bd) { bd = d; best = { kind: 'building', id: b.id }; } }
  }
  return best;
}

export function tileCapacity(g, t) {
  const w = g.world;
  if (g.tileB[t] >= 0 && g.buildings.get(g.tileB[t])?.type === 'town') return 14;
  const r = w.road[t];
  if (w.river[t] && r) return r >= 2 ? 5 : 3;          // bridges are bottlenecks
  if (r) return ROAD_TYPES[r].capacity;
  return 6;
}

export function unitsStep(g, dt) {
  const w = g.world;
  for (const u of [...g.units.values()]) {
    if (!g.units.has(u.id)) continue;
    const def = UNITS[u.type];
    const civ = g.civs[u.owner];
    u.cooldown -= dt;
    let holdPosition = false;
    // ------------------------------------------------ targeting
    if (def.atk > 0) {
      if (u.order.kind === 'attack') {
        const tt = targetTile(g, u.order.target);
        const to = tt >= 0 ? targetOwner(g, u.order.target) : -1;
        if (tt < 0 || !g.hostile(u.owner, to)) {
          if (u.order.resume !== undefined && u.order.resume >= 0) { const goal = u.order.resume; u.order = { kind: 'attackMove' }; u.goal = goal; u.path = findPath(g, civ, u.tile, goal, u.type) || []; }
          else { u.order = { kind: 'idle' }; u.path = []; }
        } else if (dist(u.tile, tt) <= def.range) {
          holdPosition = u.prog === 0;
          if (holdPosition) { u.path = []; u.next = -1; u.field = false; }
          if (u.cooldown <= 0 && holdPosition) attack(g, u, u.order.target, tt);
        } else if (u.stance === 'hold') {
          u.order = { kind: 'idle' };
        } else if (g.time >= u.repathAt) {
          u.repathAt = g.time + 2; u.field = false;
          u.path = findPath(g, civ, u.tile, tt, u.type, 6000) || [];
        }
      } else if ((g.tickN + u.id) % 5 === 0 && u.cooldown <= 0 && u.stance !== 'passive') {
        const k = u.order.kind;
        const scan = k === 'attackMove' || u.stance === 'aggressive' ? Math.max(def.range, def.vision) : k === 'idle' && u.stance !== 'hold' ? def.range + 1 : def.range;
        const tg = findEnemyNear(g, u, scan);
        if (tg) {
          const tt = targetTile(g, tg);
          if (k === 'move' || u.stance === 'hold') { if (dist(u.tile, tt) <= def.range) attack(g, u, tg, tt); }   // fire on the move / from position
          else { u.order = { kind: 'attack', target: tg, resume: k === 'attackMove' ? u.goal : undefined }; u.repathAt = 0; }
        }
      }
    }
    if (def.engineer && u.order.kind !== 'move' && !u.path.length) engineerWork(g, u, dt);
    if (holdPosition) continue;
    // ------------------------------------------------ steering: shared flow field, then own slot
    if (u.field && !u.path.length && u.goal >= 0) {
      if (u.tile === u.slot || dist(u.tile, u.slot) <= 2) {
        u.field = false;
        if (u.tile !== u.slot) u.path = findPath(g, civ, u.tile, u.slot, u.type, 3000) || [];
      } else {
        const field = flowField(g, civ, u.goal, u.type);
        let best = -1, bv = field[u.tile];
        for (let d = 0; d < 6; d++) {
          const n = NB[u.tile * 6 + d]; if (n < 0 || !Number.isFinite(field[n])) continue;
          const c = stepCost(g, civ, u.tile, n, u.type); if (!Number.isFinite(c)) continue;
          const v = field[n] + (isAir(u) ? 0 : (g.tileLoad.get(n) || 0) * 0.35);
          if (v < bv) { bv = v; best = n; }
        }
        if (best >= 0) u.path = [best];
        else { u.field = false; u.path = findPath(g, civ, u.tile, u.slot, u.type) || []; }
      }
    }
    // ------------------------------------------------ movement with capacity queues
    if (u.path.length) {
      const nxt = u.path[0];
      if (u.next !== nxt) { u.next = nxt; u.prog = 0; }
      const c = stepCost(g, civ, u.tile, nxt, u.type);
      if (!Number.isFinite(c)) {
        // terrain changed under us (lava, collapsed pass, ruined bridge, flooding) or border closed: re-route
        const goal = u.slot >= 0 ? u.slot : u.goal >= 0 ? u.goal : u.path[u.path.length - 1];
        u.field = false;
        u.path = findPath(g, civ, u.tile, goal, u.type) || [];
        u.next = -1; u.prog = 0;
        if (!u.path.length) { u.status = 'blocked'; if (civ.human && (g.tickN + u.id) % 30 === 0) g.notify(civ.id, `${def.name} is blocked: the route is no longer passable.`, { kind: 'error', tile: u.tile, quiet: true }); }
        continue;
      }
      if (!isAir(u) && u.prog === 0 && (g.tileLoad.get(nxt) || 0) >= tileCapacity(g, nxt) && !g.hostileAt(u.owner, nxt)) {
        // congestion: wait in line; after a while try another way; give up eventually
        u.wait += dt; u.status = 'waiting';
        if (u.wait > 4 && u.wait - dt <= 4) {
          const goal = u.slot >= 0 ? u.slot : u.goal;
          const alt = findPath(g, civ, u.tile, goal, u.type, 8000, new Set([nxt]));
          if (alt && alt[0] !== nxt) { u.path = alt; u.field = false; }
        }
        if (u.wait > 20) { u.path = []; u.field = false; u.status = 'blocked'; u.wait = 0; }
        continue;
      }
      u.wait = 0; u.status = 'ok';
      g.tileLoad.set(nxt, (g.tileLoad.get(nxt) || 0) + (u.prog === 0 && !isAir(u) ? 1 : 0));
      const onWater = isWater(w.terr[nxt]);
      let spd = (onWater && !isAir(u) ? 1.0 : def.speed) * (u.outOfSupply ? 0.75 : 1);
      if (u.groupSpeed) spd = Math.min(spd, u.groupSpeed);   // formations move at their slowest member's pace
      u.prog += (spd * dt) / c;
      if (u.prog >= 1) {
        if (!isAir(u)) g.roads.noteTraffic(u.tile, nxt, def.move === 'infantry' ? 0.5 : 1);
        u.tile = nxt; u.path.shift(); u.prog = 0; u.next = -1;
      }
    } else if (!u.field) {
      u.next = -1; u.prog = 0;
      if (u.order.kind === 'move' || u.order.kind === 'attackMove') { u.order = { kind: 'idle' }; u.groupSpeed = 0; u.home = u.tile; }
    }
  }
}

function engineerWork(g, u, dt) {
  const civ = g.civs[u.owner];
  // repair damaged road segments and buildings on or next to the engineer's hex
  for (const e of g.roads.edgesOf(u.tile)) {
    if (e.cond < 100 && civ.res.materials >= 0.5 * dt) { e.cond = Math.min(100, e.cond + 25 * dt); civ.res.materials -= 0.5 * dt; g.roads.refresh(e.a); g.roads.refresh(e.b); return; }
  }
  for (const t of disk(u.tile, 1)) {
    const b = g.buildingAtTile(t);
    if (b && b.owner === u.owner && b.done && b.hp < b.maxHp && civ.res.materials >= 0.5 * dt) { b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.04 * dt); civ.res.materials -= 0.5 * dt; return; }
    const r = g.ruins.get(t);
    if (r && (g.world.owner[t] === u.owner || g.world.owner[t] < 0)) { r.clear = (r.clear || 0) + dt; if (r.clear >= 6) { g.ruins.delete(t); g.world.touch(t); } return; }
  }
}

function attack(g, u, tg, tt) {
  const def = UNITS[u.type];
  const civ = g.civs[u.owner];
  const w = g.world;
  let a = def.atk;
  if (civ.gov === 'corporate') a *= 0.9;
  if (civ.gov === 'junta') a *= 1.1;
  if (civ.policies.has('total_war')) a *= 1.2;
  a *= 0.4 + 0.6 * (u.supply / 100);
  a *= 0.5 + 0.5 * (u.hp / u.maxHp);
  if (def.age >= 1) { const need = 0.05 * (def.cat === 'artillery' ? 3 : 1); if (civ.res.munitions >= need) civ.res.munitions -= need; else a *= 0.6; }
  if (!def.air && w.river[u.tile] && !w.road[u.tile] && def.range <= 1) a *= 0.75;
  if (isWater(w.terr[u.tile]) && !def.air) a *= 0.6;
  const rand = 0.85 + g.rng() * 0.3;
  if (tg.kind === 'unit') {
    const e = g.units.get(tg.id); if (!e) return;
    const ed = UNITS[e.type];
    if (ed.air) { if (!def.aa) return; a *= def.aa; }
    if (def.bonus && def.bonus[ed.cat]) a *= def.bonus[ed.cat];
    let d = ed.def * (ed.air ? 1 : 1 + TERRAIN[w.terr[e.tile]].def);
    const fortB = g.buildingAtTile(e.tile); if (fortB && fortB.owner === e.owner && (fortB.type === 'fort' || fortB.type === 'bunker')) d *= 1.5;
    if (isWater(w.terr[e.tile]) && !ed.air) d *= 0.5;
    damageUnit(g, e, a * 1.6 * rand * (10 / (10 + d)), u.owner, 'combat');
  } else {
    const b = g.buildings.get(tg.id); if (!b) return;
    const bd = BUILDINGS[b.type];
    let d = bd.attack ? 12 : 6;
    if ((b.type === 'fort' || b.type === 'bunker') && g.civs[b.owner].policies.has('fortification')) d *= 1.5;
    damageBuilding(g, b, a * 1.6 * rand * (def.vsBuildings || 1) * (10 / (10 + d)), u.owner, 'combat');
  }
  // heavy weapons crater the roads around their target
  if (def.cat === 'artillery' && g.rng() < 0.3) g.roads.damageTile(tt, 12, g.rng, 0.5);
  u.cooldown = def.cat === 'artillery' ? 3 : def.range > 1 ? 1.8 : 1.5;
  u.lastCombat = g.time;
  g.fx.push([def.range > 1 ? (def.cat === 'artillery' ? 'shell' : 'shot') : 'melee', u.tile, tt]);
}

export function damageUnit(g, u, amount, attackerCivId, cause) {
  if (!g.units.has(u.id)) return;
  u.hp -= amount;
  if (attackerCivId != null) u.lastCombat = g.time;
  if (u.hp <= 0) {
    g.units.delete(u.id);
    const civ = g.civs[u.owner];
    civ.casualties++;
    civ.weariness += UNITS[u.type].pop * 2;
    if (attackerCivId != null && g.civs[attackerCivId]) g.civs[attackerCivId].kills++;
    if (cause === 'lava' || cause === 'flood' || cause === 'fuel') g.notify(civ.id, `${UNITS[u.type].name} lost ${cause === 'lava' ? 'to the lava' : cause === 'fuel' ? '(out of fuel)' : 'to the rising waters'}.`, { kind: 'loss', tile: u.tile, quiet: true });
    g.fx.push(['die', u.tile, u.tile]);
  }
}

export function damageBuilding(g, b, amount, attackerCivId, cause) {
  if (!g.buildings.has(b.id)) return;
  b.hp -= amount; b.lastHit = g.time;
  if (b.hp > 0) return;
  const owner = g.civs[b.owner];
  if (b.type === 'town') {
    const city = [...g.cities.values()].find((c) => c.buildingId === b.id);
    if (attackerCivId != null && city) {
      const capturer = [...g.units.values()].find((u) => u.owner === attackerCivId && !UNITS[u.type].civilian && !UNITS[u.type].air && dist(u.tile, b.tile) <= 1);
      if (capturer) {
        b.hp = b.maxHp * 0.3; city.pop *= 0.6;
        const conq = g.civs[attackerCivId];
        g.notify(owner.id, `${city.name} has fallen to ${conq.name}!`, { kind: 'city', tile: b.tile });
        g.notify(conq.id, `You have captured ${city.name}!`, { kind: 'city', tile: b.tile });
        transferCity(g, city, conq);
        return;
      }
      b.hp = 1; return;
    }
    if ((cause === 'lava' || cause === 'flood') && city) {
      g.notify(owner.id, `${city.name} has been destroyed by ${cause === 'lava' ? 'the eruption' : 'the sea'}!`, { kind: 'city', tile: b.tile });
      g.cities.delete(city.id); g.removeBuilding(b);
      g.addRuin(b.tile, 'town', b.owner, city.name);
      for (const o of g.buildings.values()) if (o.cityId === city.id) o.cityId = g.nearestCityId(o.owner, o.tile);
      recomputeTerritory(g);
      if (!g.cityOf(owner).length) g.eliminate(owner);
      else if (!g.cityOf(owner).some((c) => c.capital)) g.cityOf(owner)[0].capital = true;
      return;
    }
    b.hp = 1; return;
  }
  g.removeBuilding(b);
  if (cause !== 'flood' && cause !== 'demolish') g.addRuin(b.tile, b.type, b.owner);
  g.notify(owner.id, `${BUILDINGS[b.type].name} destroyed${cause === 'combat' ? ' by enemy forces' : cause === 'quake' ? ' in the earthquake' : cause === 'lava' ? ' by lava' : ''}.`, { kind: 'loss', tile: b.tile, quiet: cause !== 'combat' });
  g.fx.push(['boom', b.tile, b.tile]);
}

export function buildingCombatStep(g, dt) {
  for (const b of g.buildings.values()) {
    const def = BUILDINGS[b.type];
    if (!def.attack || !b.done) continue;
    b.cooldown -= dt;
    if (b.cooldown > 0) continue;
    let best = null, bd = Infinity;
    for (const t of disk(b.tile, def.range)) {
      const ids = g.tileUnits.get(t); if (!ids) continue;
      for (const id of ids) {
        const e = g.units.get(id);
        if (!e || !g.hostile(b.owner, e.owner) || !g.detects(b.owner, e)) continue;
        if (UNITS[e.type].air && !def.aa) continue;
        const d = dist(b.tile, t); if (d < bd) { bd = d; best = e; }
      }
    }
    if (!best) continue;
    let a = def.attack * (g.civs[b.owner].policies.has('fortification') && b.type !== 'town' ? 1.5 : 1) * (0.4 + 0.6 * b.hp / b.maxHp);
    if (UNITS[best.type].air) a *= def.aa;
    damageUnit(g, best, a * 1.6 * (10 / (10 + UNITS[best.type].def)), b.owner, 'combat');
    b.cooldown = 2;
    g.fx.push(['shot', b.tile, best.tile]);
  }
}

// Multi-source Dijkstra from cities, depots, ports, forts and trucks along roads, rails and terrain.
// Hostile armies and fortresses cut the network. Aircraft draw on airfields instead.
export function recomputeSupply(g) {
  const w = g.world, roads = g.roads;
  for (const civ of g.civs) {
    if (!civ.alive) continue;
    const bl = new Uint8Array(N);
    for (const u of g.units.values()) if (g.hostile(civ.id, u.owner) && !UNITS[u.type].civilian && !UNITS[u.type].air) bl[u.tile] = 1;
    for (const b of g.buildings.values()) if (g.hostile(civ.id, b.owner) && BUILDINGS[b.type].blocksSupply && b.done) for (const t of disk(b.tile, BUILDINGS[b.type].blocksSupply)) bl[t] = 1;
    const bonus = (civ.techs.has('logistics') ? 2 : 0) + (civ.techs.has('networked_command') ? 1 : 0);
    const best = new Float32Array(N).fill(-1);
    const heap = new MinHeap();
    const addSrc = (t, budget) => { if (budget > best[t]) { best[t] = budget; heap.push(t, -budget); } };
    for (const c of g.cities.values()) if (c.owner === civ.id) addSrc(c.tile, 6 + Math.min(2, civ.age) + bonus);
    for (const b of g.buildings.values()) {
      if (b.owner !== civ.id || !b.done) continue;
      const s = BUILDINGS[b.type].supply; if (s) addSrc(b.tile, s + bonus);
      if (b.type === 'fort') addSrc(b.tile, 2 + bonus);
    }
    for (const u of g.units.values()) if (u.owner === civ.id && UNITS[u.type].supplyRadius && civ.res.food > 0) addSrc(u.tile, UNITS[u.type].supplyRadius + (bonus ? 1 : 0));
    const sup = civ.supply; sup.fill(0);
    while (heap.size) {
      const i = heap.pop();
      if (sup[i]) continue;
      sup[i] = 1;
      const budget = best[i];
      for (let d = 0; d < 6; d++) {
        const n = NB[i * 6 + d]; if (n < 0 || sup[n] || bl[n]) continue;
        const t = w.terr[n];
        let c;
        const e = roads.usable(i, n);
        if (e) c = [0, 0.3, 0.22, 0.15, 0.1][e.type];
        else if (isWater(t)) c = civ.techs.has('seafaring') ? (t === T.SHALLOW ? 1.2 : 1.6) : Infinity;
        else { c = TERRAIN[t].move; if (w.river[n] && !w.river[i]) c += 1; }
        if (!Number.isFinite(c)) continue;
        if (w.owner[n] >= 0 && g.hostile(civ.id, w.owner[n])) c *= 2;
        const nb = budget - c;
        if (nb >= 0 && nb > best[n]) { best[n] = nb; heap.push(n, -nb); }
      }
    }
    // air supply: radius around airfields (and a short hop around cities)
    const air = civ.airSupply; air.fill(0);
    for (const b of g.buildings.values()) { if (b.owner !== civ.id || !b.done) continue; const r = BUILDINGS[b.type].airSupply; if (r) for (const t of disk(b.tile, r + bonus)) air[t] = 1; }
    for (const c of g.cities.values()) if (c.owner === civ.id) for (const t of disk(c.tile, 3)) air[t] = 1;
  }
}

export function supplyStep(g, dt) {
  for (const u of g.units.values()) {
    const civ = g.civs[u.owner];
    const def = UNITS[u.type];
    const air = !!def.air;
    const inSup = air ? civ.airSupply[u.tile] === 1 : civ.supply[u.tile] === 1;
    const fed = civ.res.food > 0 && (!air || civ.res.fuel > 0);
    u.outOfSupply = !inSup || !fed;
    if (inSup && fed) {
      u.supply = Math.min(100, u.supply + (air ? 25 : 15) * dt);
      if (air) civ.res.fuel = Math.max(0, civ.res.fuel - 0.03 * dt);
      if (g.time - u.lastCombat > 5 && u.hp < u.maxHp) {
        let heal = u.maxHp * 0.03 * dt;
        const nearFort = disk(u.tile, 1).some((t) => { const b = g.buildingAtTile(t); return b && b.owner === u.owner && BUILDINGS[b.type].heals; });
        if (nearFort) heal *= 2;
        const part = def.move === 'infantry' ? 'food' : 'steel';
        if (def.age >= 1) { if (civ.res[part] >= 0.05) civ.res[part] -= 0.05 * dt; else heal *= 0.4; }
        u.hp = Math.min(u.maxHp, u.hp + heal);
      }
    } else {
      u.supply = Math.max(0, u.supply - (air ? 6 : 2.5) * dt);
      if (u.supply <= 0 && air) damageUnit(g, u, u.maxHp * 0.06 * dt, null, 'fuel');
      else if (u.supply <= 0 && !def.civilian) damageUnit(g, u, u.maxHp * 0.015 * dt, null, 'attrition');
    }
  }
}
void MOVE;
