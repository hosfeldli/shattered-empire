// Units: movement (flow fields, formations, tile/bridge capacity), combat (incl. air),
// supply networks & attrition, engineers, and damage that persists in the world.
import { stepBlock, reserve } from './tacticalOccupancy.js';
import { ACTIVITY, activityOf } from './logistics.js';
import { casualty } from './population.js';
import { N, T, TERRAIN, UNITS, BUILDINGS, MOVE, ROAD_TYPES, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';
import { findPath, stepCost, flowField } from './path.js';
import { MinHeap } from './world.js';
import { transferCity, recomputeTerritory } from './economy.js';
import { fireUnit, fireBuilding, chooseTarget, firingPosition, coverPosition, emit, onUnitLost, CS, lineOfFire } from './combat.js';
import { UNIT_WEAPON, WEAPONS } from './weapons.js';
import { addWreck, engineerClear, scarCost } from './battlefield.js';

export function spawnUnit(g, civ, type, tile) {
  const def = UNITS[type];
  const maxHp = Math.round(def.hp);
  const u = { id: g.id_(), owner: civ.id, type, tile, next: -1, prog: 0, path: [], goal: -1, slot: -1, hp: maxHp, maxHp, supply: 100, cooldown: 0,
    order: { kind: 'idle' }, lastCombat: -99, outOfSupply: false, repathAt: 0, home: tile, stance: def.civilian ? 'passive' : 'defensive', field: false, wait: 0, status: 'ok', groupSpeed: 0,
    supp: 0, morale: 100, cstat: 0, tgt: 0, auth: '', queue: [] };
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
  const wr = g.wrecks.get(t)?.length || 0;     // wrecks narrow the passage
  if (r) return Math.max(2, ROAD_TYPES[r].capacity - wr);
  return Math.max(2, 6 - wr);
}

export function unitsStep(g, dt) {
  const w = g.world;
  for (const u of [...g.units.values()]) {
    if (!g.units.has(u.id)) continue;
    const def = UNITS[u.type];
    const civ = g.civs[u.owner];
    u.cooldown -= dt;
    if (u.refitUntil > g.time) { u.cstat = 0; continue; }   // in the workshop
    let holdPosition = false;
    // ------------------------------------------------ targeting
    // combat status shown to the player: what this unit is doing and why
    let cstat = u.retreating ? CS.retreating : u.path.length || u.field ? CS.moving : CS.idle;
    u.tgt = 0;
    if (def.atk > 0) {
      const wpn = WEAPONS[UNIT_WEAPON[u.type]] || WEAPONS.carbine;
      if (u.order.kind === 'attack') {
        const tt = targetTile(g, u.order.target);
        const to = tt >= 0 ? targetOwner(g, u.order.target) : -1;
        if (tt < 0 || !g.hostile(u.owner, to)) {
          if (u.order.resume !== undefined && u.order.resume >= 0) { const goal = u.order.resume; u.order = { kind: 'attackMove' }; u.goal = goal; u.path = findPath(g, civ, u.tile, goal, u.type) || []; }
          else { u.order = { kind: 'idle' }; u.path = []; }
        } else {
          u.tgt = u.order.target.kind === 'unit' ? u.order.target.id : -u.order.target.id;
          const inRange = dist(u.tile, tt) <= def.range;
          const lof = inRange && (wpn.arc || lineOfFire(g, u.tile, tt, false, !!def.air || (u.order.target.kind === 'unit' && !!UNITS[g.units.get(u.order.target.id)?.type]?.air)).ok);
          if (inRange && lof) {
            holdPosition = u.prog === 0;
            if (holdPosition) { u.path = []; u.next = -1; u.field = false; }
            cstat = u.cooldown > 0.6 && wpn.mode === 'projectile' ? CS.reloading : CS.engaging;
            if (u.cooldown <= 0 && holdPosition) fireUnit(g, u, u.order.target, tt);
          } else if (inRange) {
            // in range but something is in the way: shift to a hex with a clear line (bounded)
            cstat = CS.no_los;
            if (u.stance !== 'hold' && g.time >= u.repathAt) {
              u.repathAt = g.time + 3; u.field = false;
              const fp = firingPosition(g, u, tt);
              if (fp >= 0) { u.path = findPath(g, civ, u.tile, fp, u.type, 2000) || []; cstat = CS.repositioning; }
            }
          } else if (u.stance === 'hold') {
            u.order = { kind: 'idle' }; cstat = CS.out_of_range;
          } else {
            cstat = CS.repositioning;
            // first take the assigned place in the line, then close with the target
            if (u.order.slot >= 0 && (u.tile === u.order.slot || dist(u.tile, tt) <= dist(u.order.slot, tt))) u.order.slot = -1;
            if (g.time >= u.repathAt) { u.repathAt = g.time + 2; u.field = false; u.path = findPath(g, civ, u.tile, u.order.slot >= 0 ? u.order.slot : tt, u.type, 6000) || []; }
          }
        }
      } else if ((g.tickN + u.id) % 5 === 0 && u.cooldown <= 0 && u.stance !== 'passive') {
        const k = u.order.kind;
        const scan = k === 'attackMove' || u.stance === 'aggressive' ? Math.max(def.range, def.vision) : k === 'idle' && u.stance !== 'hold' ? def.range + 1 : def.range;
        const pick = chooseTarget(g, u, scan);
        if (pick) {
          const { tg, tile: tt } = pick;
          // on the move, withdrawing or holding: shoot what is in range, do not chase
          if (k === 'move' || u.stance === 'hold' || u.retreating) { if (dist(u.tile, tt) <= def.range && fireUnit(g, u, tg, tt)) cstat = CS.engaging; }
          else { u.order = { kind: 'attack', target: tg, resume: k === 'attackMove' ? u.goal : u.order.resume }; u.repathAt = 0; }
        }
      }
      if (u.lowAmmo && cstat === CS.engaging) cstat = CS.low_ammo;
      if ((u.supp || 0) >= 60 && cstat !== CS.retreating) cstat = CS.suppressed;
    }
    // pinned infantry stay down (and crawl to cover) unless the player ordered the move
    if ((u.supp || 0) >= 75 && def.move === 'infantry' && !def.civilian && u.auth !== 'player' && u.order.kind !== 'move') {
      cstat = CS.pinned;
      if (!u.pinnedMove && g.rng() < 0.2) {
        const threat = u.order.kind === 'attack' ? targetTile(g, u.order.target) : -1;
        const cp = coverPosition(g, u, threat);
        if (cp >= 0) { u.path = [cp]; u.pinnedMove = true; }
      }
      if (!u.pinnedMove) { u.cstat = cstat; continue; }
    } else u.pinnedMove = false;
    // morale breaks: units not under a direct player order fall back toward home
    if ((u.morale ?? 100) < 20 && !u.retreating && !def.civilian && u.stance !== 'hold' && u.auth !== 'player') {
      const home = g.nearestCityTile ? g.nearestCityTile(u.owner, u.tile) : u.home;
      if (home >= 0 && dist(home, u.tile) > 2) { u.retreating = true; u.order = { kind: 'move', withdraw: true }; u.goal = home; u.slot = home; u.field = false; u.path = findPath(g, civ, u.tile, home, u.type) || []; cstat = CS.retreating; if (civ.human) g.notify(civ.id, `${def.name} is falling back: morale broken.`, { kind: 'unit', tile: u.tile, quiet: true, level: 'minor' }); }
    }
    if (u.retreating && (u.morale ?? 100) > 55 && !u.order.withdraw) u.retreating = false;
    u.cstat = cstat;
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
          if (stepBlock(g, u, n)) continue;          // enemy-held or controlled ground: steer around
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
      // occupancy and zones of control: never into an enemy-held hex, never sliding along a line
      if (!isAir(u) && u.prog === 0) {
        const blk = stepBlock(g, u, nxt);
        if (blk) {
          u.next = -1; u.field = false; u.status = 'contact'; u.contact = g.time;
          // a bounded reroute for movement orders; otherwise stop here and fight from the edge
          if ((u.order.kind === 'move' || u.order.kind === 'attackMove') && (u.blockTries || 0) < 3 && !(u.order.kind === 'attackMove' && blk !== 'contested')) {
            u.blockTries = (u.blockTries || 0) + 1;
            const goal = u.slot >= 0 ? u.slot : u.goal;
            const alt = goal >= 0 ? findPath(g, civ, u.tile, goal, u.type, 6000, new Set([nxt])) : null;
            u.path = alt && alt[0] !== nxt ? alt : [];
          } else u.path = [];
          if (!u.path.length && u.order.kind === 'move' && !u.order.withdraw) { u.order = { kind: 'idle' }; u.groupSpeed = 0; }
          continue;
        }
        reserve(g, u, nxt);
      }
      if (!isAir(u) && u.prog === 0 && (g.tileLoad.get(nxt) || 0) >= tileCapacity(g, nxt)) {
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
      // low supply slows an advance gradually (fuel, spares), not all at once
      let spd = (onWater && !isAir(u) ? 1.0 : def.speed) * (u.supply >= 50 ? 1 : u.supply >= 25 ? 0.9 : u.supply >= 10 ? 0.78 : 0.7);
      if (u.groupSpeed) spd = Math.min(spd, u.groupSpeed);   // formations move at their slowest member's pace
      if (u.supp > 30) spd *= 1 - 0.35 * (u.supp / 100);
      u.prog += (spd * dt) / c;
      if (u.prog >= 1) {
        if (!isAir(u)) g.roads.noteTraffic(u.tile, nxt, def.move === 'infantry' ? 0.5 : 1);
        u.tile = nxt; u.path.shift(); u.prog = 0; u.next = -1; u.blockTries = 0;

      }
    } else if (!u.field) {
      u.next = -1; u.prog = 0;
      if (u.order.kind === 'move' || u.order.kind === 'attackMove') {
        const withdrew = u.order.withdraw;
        u.order = { kind: 'idle' }; u.groupSpeed = 0; u.home = u.tile;
        if (withdrew) { u.retreating = (u.morale ?? 100) < 55; }
        // shift-queued waypoints: carry on with the next leg
        if (u.queue && u.queue.length && u.queue[0].deploy) { const nx = u.queue.shift(); g.runQueuedDeploy(u, nx.deploy); }
        else if (u.queue && u.queue.length) { const nx = u.queue.shift(); u.order = { kind: nx.attackMove ? 'attackMove' : 'move' }; u.goal = nx.tile; u.slot = nx.tile; u.path = findPath(g, civ, u.tile, nx.tile, u.type) || []; }
        if (!u.path.length && u.order.kind !== 'idle') u.order = { kind: 'idle' };
        if (u.auth === 'player' && u.order.kind === 'idle') u.auth = '';
      }
    }
  }
}

function engineerWork(g, u, dt) {
  const civ = g.civs[u.owner];
  if (engineerClear(g, u, dt)) return;
  // repair damaged road segments and buildings on or next to the engineer's hex
  for (const e of g.roads.edgesOf(u.tile)) {
    if (e.cond < 100 && civ.res.materials >= 0.5 * dt) { e.cond = Math.min(100, e.cond + 25 * dt); civ.res.materials -= 0.5 * dt; g.roads.refresh(e.a); g.roads.refresh(e.b); return; }
  }
  for (const t of disk(u.tile, 1)) {
    const b = g.buildingAtTile(t);
    if (b && b.owner === u.owner && b.fire > 0) { b.fire = Math.max(0, b.fire - 6 * dt); if (!b.fire) g.world.touch(b.tile); return; }
    if (b && b.owner === u.owner && b.done && b.hp < b.maxHp && civ.res.materials >= 0.5 * dt) { b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.04 * dt); civ.res.materials -= 0.5 * dt; g.refreshState(b); return; }
    if (b && b.owner === u.owner && !b.done && b.funded) { b.progress = Math.min(0.999, b.progress + (dt * 0.5) / BUILDINGS[b.type].time); return; }
    const r = g.ruins.get(t);
    if (r && (g.world.owner[t] === u.owner || g.world.owner[t] < 0)) { r.clear = (r.clear || 0) + dt; if (r.clear >= 6) { g.ruins.delete(t); g.world.touch(t); } return; }
  }
}

export function damageUnit(g, u, amount, attackerCivId, cause) {
  if (!g.units.has(u.id)) return;
  u.hp -= amount;
  if (attackerCivId != null) u.lastCombat = g.time;
  if (u.hp <= 0) {
    g.units.delete(u.id);
    onUnitLost(g, u); casualty(g, u);
    if (cause === 'combat' || cause === 'fuel') addWreck(g, u.tile, u.type, u.owner);
    const civ = g.civs[u.owner];
    civ.casualties++;
    civ.weariness += UNITS[u.type].pop * 2;
    if (attackerCivId != null && g.civs[attackerCivId]) g.civs[attackerCivId].kills++;
    if (cause === 'lava' || cause === 'flood' || cause === 'fuel') g.notify(civ.id, `${UNITS[u.type].name} lost ${cause === 'lava' ? 'to the lava' : cause === 'fuel' ? '(out of fuel)' : 'to the rising waters'}.`, { kind: 'loss', tile: u.tile, quiet: true });
    emit(g, { k: 'kill', t: u.id, b: u.tile, ty: u.type, o: cause, ow: u.owner });
  }
}

export function damageBuilding(g, b, amount, attackerCivId, cause) {
  if (!g.buildings.has(b.id)) return;
  if (hardened(g, b)) amount *= 0.6;                  // a crustal stabilizer nearby hardens infrastructure
  b.hp -= amount; b.lastHit = g.time;
  if (b.hp > 0) { if (cause === 'combat' || cause === 'quake' || cause === 'lava') g.ignite(b, cause === 'lava' ? 1 : 0.15); g.refreshState(b); return; }
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
  if (cause !== 'flood' && cause !== 'demolish') { g.addRuin(b.tile, b.type, b.owner); const r = g.ruins.get(b.tile); if (r) r.smoke = 60; }
  g.notify(owner.id, `${BUILDINGS[b.type].name} destroyed${cause === 'combat' ? ' by enemy forces' : cause === 'quake' ? ' in the earthquake' : cause === 'lava' ? ' by lava' : ''}.`, { kind: 'loss', tile: b.tile, quiet: cause !== 'combat' });
  emit(g, { k: 'bkill', t: b.id, b: b.tile, ty: b.type, o: cause });
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
    fireBuilding(g, b, best);
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
    // supply trucks no longer project an aura: they deliver finite cargo (logistics.js)
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
    u.activity = activityOf(g, u);
    const civ = g.civs[u.owner];
    const def = UNITS[u.type];
    const air = !!def.air;
    const inSup = g.sandbox || (air ? civ.airSupply[u.tile] === 1 : civ.supply[u.tile] === 1);
    const fed = civ.res.food > 0 && (!air || civ.res.fuel > 0);
    u.outOfSupply = !inSup || !fed;
    if (inSup && fed) {
      u.supply = Math.min(100, u.supply + (air ? 25 : 15) * dt);
      if (air) civ.res.fuel = Math.max(0, civ.res.fuel - 0.03 * dt);
      if (g.time - u.lastCombat > 5 && u.hp < u.maxHp) {
        let heal = u.maxHp * 0.03 * dt * (u.supply >= 80 ? 1 : u.supply >= 50 ? 0.6 : 0.3);
        const nearFort = disk(u.tile, 1).some((t) => { const b = g.buildingAtTile(t); return b && b.owner === u.owner && BUILDINGS[b.type].heals; });
        if (nearFort) heal *= 2;
        const part = def.move === 'infantry' ? 'food' : 'steel';
        if (def.age >= 1) { if (civ.res[part] >= 0.05) civ.res[part] -= 0.05 * dt; else heal *= 0.4; }
        u.hp = Math.min(u.maxHp, u.hp + heal);
      }
    } else {
      // cut off: reserves drain by what the unit is doing (entrenched troops last far longer)
      u.supply = Math.max(0, u.supply - (air ? 6 : ACTIVITY[u.activity]?.loss ?? 2.5) * dt);
      if (u.supply <= 0 && air) damageUnit(g, u, u.maxHp * 0.06 * dt, null, 'fuel');
      else if (u.supply <= 0 && !def.civilian) damageUnit(g, u, u.maxHp * 0.015 * dt, null, 'attrition');
    }
  }
}
void MOVE;

export function hardened(g, b) {
  for (const s of g.buildings.values()) if (s.owner === b.owner && s.type === 'stabilizer' && s.done && s.state !== 'damaged' && dist(s.tile, b.tile) <= 4) return true;
  return false;
}
