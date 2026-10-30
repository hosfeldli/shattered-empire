// Units, movement, combat, logistics (supply networks & attrition).
import { N, T, TERRAIN, UNITS, BUILDINGS, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';
import { findPath, stepCost } from './path.js';
import { MinHeap } from './world.js';
import { transferCity, recomputeTerritory } from './economy.js';

export function spawnUnit(g, civ, type, tile) {
  const def = UNITS[type];
  const maxHp = Math.round(def.hp * (civ.gov === 'monarchy' ? 1.15 : 1));
  const u = { id: g.id_(), owner: civ.id, type, tile, next: -1, prog: 0, path: [], goal: -1, hp: maxHp, maxHp, supply: 100, cooldown: 0,
    order: { kind: 'idle' }, lastCombat: -99, outOfSupply: false, repathAt: 0, home: tile };
  g.units.set(u.id, u);
  return u;
}

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
  let best = null, bd = Infinity;
  for (const t of disk(u.tile, radius)) {
    const ids = g.tileUnits.get(t);
    if (ids) for (const id of ids) {
      const e = g.units.get(id);
      if (!e || !g.hostile(u.owner, e.owner)) continue;
      const d = dist(u.tile, t) + (UNITS[e.type].civilian ? 0.5 : 0);
      if (d < bd) { bd = d; best = { kind: 'unit', id }; }
    }
    const b = g.buildingAtTile(t);
    if (b && g.hostile(u.owner, b.owner)) { const d = dist(u.tile, t) + 0.8; if (d < bd) { bd = d; best = { kind: 'building', id: b.id }; } }
  }
  return best;
}

export function unitsStep(g, dt) {
  const w = g.world;
  for (const u of [...g.units.values()]) {
    if (!g.units.has(u.id)) continue;
    const def = UNITS[u.type];
    const civ = g.civs[u.owner];
    u.cooldown -= dt;
    let holdPosition = false;
    // --- target acquisition
    if (def.atk > 0) {
      if (u.order.kind === 'attack') {
        const tt = targetTile(g, u.order.target);
        const to = tt >= 0 ? targetOwner(g, u.order.target) : -1;
        if (tt < 0 || !g.hostile(u.owner, to)) {
          if (u.order.resume >= 0 && u.order.resume !== undefined) { u.order = { kind: 'attackMove' }; u.path = findPath(g, civ, u.tile, u.order.resume ?? u.goal, u.type) || []; }
          else { u.order = { kind: 'idle' }; u.path = []; }
        } else if (dist(u.tile, tt) <= def.range) {
          holdPosition = u.prog === 0;
          if (holdPosition) { u.path = []; u.next = -1; }
          if (u.cooldown <= 0 && holdPosition) attack(g, u, u.order.target, tt);
        } else if (g.time >= u.repathAt) {
          u.repathAt = g.time + 2;
          u.path = findPath(g, civ, u.tile, tt, u.type, 6000) || [];
        }
      } else if ((g.tickN + u.id) % 5 === 0 && u.cooldown <= 0) {
        const scan = u.order.kind === 'idle' ? def.range + 2 : u.order.kind === 'attackMove' ? Math.max(def.range, def.vision) : def.range;
        if (u.order.kind !== 'move' || def.range > 1) {
          const tg = findEnemyNear(g, u, scan);
          if (tg) {
            if (u.order.kind === 'move') { // ranged units shoot while moving past, without stopping
              const tt = targetTile(g, tg); if (dist(u.tile, tt) <= def.range) attack(g, u, tg, tt);
            } else {
              u.order = { kind: 'attack', target: tg, resume: u.order.kind === 'attackMove' ? u.goal : undefined };
              u.repathAt = 0;
            }
          }
        }
      }
    }
    // --- movement
    if (!holdPosition && u.path.length) {
      const nxt = u.path[0];
      if (u.next !== nxt) { u.next = nxt; u.prog = 0; }
      const c = stepCost(g, civ, u.tile, nxt, u.type);
      if (!Number.isFinite(c)) {
        // terrain changed under us (lava, collapsed pass, flooding) or border closed: re-route
        const goal = u.goal >= 0 ? u.goal : u.path[u.path.length - 1];
        u.path = findPath(g, civ, u.tile, goal, u.type) || [];
        u.next = -1; u.prog = 0;
        if (!u.path.length && civ.human && (g.tickN + u.id) % 20 === 0) g.notify(civ.id, `${def.name} is blocked: the route is no longer passable.`, { kind: 'error', tile: u.tile, quiet: true });
        continue;
      }
      const onWater = isWater(w.terr[nxt]);
      const spd = (onWater ? 1.0 : def.speed) * (u.outOfSupply ? 0.75 : 1);
      u.prog += (spd * dt) / c;
      if (u.prog >= 1) { u.tile = nxt; u.path.shift(); u.prog = 0; u.next = -1; }
    } else if (!u.path.length) { u.next = -1; u.prog = 0; if (u.order.kind === 'move' || u.order.kind === 'attackMove') u.order = { kind: 'idle' }; }
  }
}

function attack(g, u, tg, tt) {
  const def = UNITS[u.type];
  const civ = g.civs[u.owner];
  const w = g.world;
  let a = def.atk;
  if (civ.gov === 'republic') a *= 0.9;
  if (civ.gov === 'junta') a *= 1.1;
  if (civ.policies.has('total_mobilization')) a *= 1.2;
  a *= 0.4 + 0.6 * (u.supply / 100);
  a *= 0.5 + 0.5 * (u.hp / u.maxHp);
  if (w.river[u.tile] && !w.road[u.tile] && def.range <= 1) a *= 0.75; // attacking out of a river ford
  if (isWater(w.terr[u.tile])) a *= 0.6;
  const rand = 0.85 + g.rng() * 0.3;
  if (tg.kind === 'unit') {
    const e = g.units.get(tg.id); if (!e) return;
    const ed = UNITS[e.type];
    if (def.bonus && ed.cls && def.bonus[ed.cls]) a *= def.bonus[ed.cls];
    let d = ed.def * (1 + TERRAIN[w.terr[e.tile]].def);
    const fortB = g.buildingAtTile(e.tile); if (fortB && fortB.owner === e.owner && (fortB.type === 'fort' || fortB.type === 'tower')) d *= 1.5;
    if (isWater(w.terr[e.tile])) d *= 0.5;
    damageUnit(g, e, a * 1.6 * rand * (10 / (10 + d)), u.owner, 'combat');
  } else {
    const b = g.buildings.get(tg.id); if (!b) return;
    const bd = BUILDINGS[b.type];
    let d = bd.attack ? 12 : 6;
    if ((b.type === 'fort' || b.type === 'tower') && g.civs[b.owner].policies.has('fortification')) d *= 1.5;
    damageBuilding(g, b, a * 1.6 * rand * (def.vsBuildings || 1) * (10 / (10 + d)), u.owner, 'combat');
  }
  u.cooldown = def.cls === 'siege' ? 3 : def.range > 1 ? 1.8 : 1.5;
  u.lastCombat = g.time;
  g.fx.push([def.range > 1 ? 'shot' : 'melee', u.tile, tt]);
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
    if (cause === 'lava' || cause === 'flood') g.notify(civ.id, `${UNITS[u.type].name} lost to the ${cause === 'lava' ? 'lava' : 'rising waters'}.`, { kind: 'loss', tile: u.tile, quiet: true });
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
      const capturer = [...g.units.values()].find((u) => u.owner === attackerCivId && !UNITS[u.type].civilian && UNITS[u.type].range <= 1 && dist(u.tile, b.tile) <= 1);
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
      for (const o of g.buildings.values()) if (o.cityId === city.id) o.cityId = g.nearestCityId(o.owner, o.tile);
      recomputeTerritory(g);
      if (!g.cityOf(owner).length) g.eliminate(owner);
      else if (!g.cityOf(owner).some((c) => c.capital)) g.cityOf(owner)[0].capital = true;
      return;
    }
    b.hp = 1; return;
  }
  g.removeBuilding(b);
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
      for (const id of ids) { const e = g.units.get(id); if (e && g.hostile(b.owner, e.owner)) { const d = dist(b.tile, t); if (d < bd) { bd = d; best = e; } } }
    }
    if (!best) continue;
    let a = def.attack * (g.civs[b.owner].policies.has('fortification') && b.type !== 'town' ? 1.5 : 1) * (0.4 + 0.6 * b.hp / b.maxHp);
    const ed = UNITS[best.type];
    damageUnit(g, best, a * 1.6 * (10 / (10 + ed.def)), b.owner, 'combat');
    b.cooldown = 2;
    g.fx.push(['shot', b.tile, best.tile]);
  }
}

// Multi-source Dijkstra from cities, depots, ports, forts and wagons. Hostile armies and
// forts cut the network, roads and rails extend it — the core of regional logistics.
export function recomputeSupply(g) {
  const w = g.world;
  const blocked = new Map();
  for (const civ of g.civs) {
    if (!civ.alive) continue;
    const bl = new Uint8Array(N);
    for (const u of g.units.values()) if (g.hostile(civ.id, u.owner) && !UNITS[u.type].civilian) bl[u.tile] = 1;
    for (const b of g.buildings.values()) if (g.hostile(civ.id, b.owner) && BUILDINGS[b.type].blocksSupply && b.done) for (const t of disk(b.tile, BUILDINGS[b.type].blocksSupply)) bl[t] = 1;
    blocked.set(civ.id, bl);
  }
  for (const civ of g.civs) {
    if (!civ.alive) continue;
    const bl = blocked.get(civ.id);
    const bonus = (civ.techs.has('logistics') ? 2 : 0) + (civ.techs.has('telegraph') ? 1 : 0);
    const best = new Float32Array(N).fill(-1);
    const heap = new MinHeap();
    const addSrc = (t, budget) => { if (budget > best[t]) { best[t] = budget; heap.push(t, -budget); } };
    for (const c of g.cities.values()) if (c.owner === civ.id) addSrc(c.tile, 6 + civ.age + bonus);
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
        if (isWater(t)) c = civ.techs.has('navigation') ? 0.6 : civ.techs.has('sailing') && t === T.SHALLOW ? 1.2 : Infinity;
        else c = TERRAIN[t].move;
        if (!Number.isFinite(c)) continue;
        if (w.road[n] === 2) c = 0.1; else if (w.road[n]) c = 0.3;
        else if (w.river[n] && !w.river[i]) c += 1;
        if (w.owner[n] >= 0 && g.hostile(civ.id, w.owner[n])) c *= 2;
        const nb = budget - c;
        if (nb >= 0 && nb > best[n]) { best[n] = nb; heap.push(n, -nb); }
      }
    }
  }
}

export function supplyStep(g, dt) {
  for (const u of g.units.values()) {
    const civ = g.civs[u.owner];
    const def = UNITS[u.type];
    const inSup = civ.supply[u.tile] === 1;
    const fed = civ.res.food > 0;
    u.outOfSupply = !inSup || !fed;
    if (inSup && fed) {
      u.supply = Math.min(100, u.supply + 15 * dt);
      if (g.time - u.lastCombat > 5 && u.hp < u.maxHp) {
        let heal = u.maxHp * 0.03 * dt;
        const nearFort = [...disk(u.tile, 1)].some((t) => { const b = g.buildingAtTile(t); return b && b.owner === u.owner && BUILDINGS[b.type].heals; });
        if (nearFort) heal *= 2;
        if (def.age >= 1) { if (civ.res.equip >= 0.05) civ.res.equip -= 0.05 * dt; else heal *= 0.4; }
        u.hp = Math.min(u.maxHp, u.hp + heal);
      }
    } else {
      u.supply = Math.max(0, u.supply - 2.5 * dt);
      if (u.supply <= 0 && !def.civilian) damageUnit(g, u, u.maxHp * 0.015 * dt, null, 'attrition');
    }
  }
}
