// AI military planning by missions. Every combat unit belongs to one mission (defend a city's
// zone, an offensive, its scouting run) or to the reserve. A mission keeps its purpose until it
// completes, fails or is invalidated; a commitment period and hysteresis stop armies reversing on
// every planning tick; local threats change targeting inside a zone, not strategic destinations.
import { UNITS, TERRAIN, isWater, N } from './constants.js';
import { dist, disk, hexLine } from './hex.js';

const COMMIT = { defend: 15, offensive: 90, scout: 60 };
const DIFF = { easy: { react: 1.0, switch: 2.0, commit: 1.4 }, normal: { react: 1.3, switch: 1.5, commit: 1 }, hard: { react: 1.6, switch: 1.3, commit: 0.8 } };

export class MilitaryPlanner {
  constructor(ai) { this.ai = ai; this.missions = new Map(); this.nextId = 1; this.memory = new Map(); this.cooldown = {}; this.reversals = 0; }

  owner(id) { for (const m of this.missions.values()) if (m.units.has(id)) return m.id; return 0; }
  get g() { return this.ai.g; }
  get civ() { return this.ai.civ; }
  get tune() { return DIFF[this.civ.difficulty] || DIFF.normal; }

  serialize() { return { missions: [...this.missions.values()].map((m) => ({ ...m, units: [...m.units] })), nextId: this.nextId, memory: [...this.memory.entries()], cooldown: this.cooldown, reversals: this.reversals }; }
  load(o) { if (!o) return; this.missions = new Map(o.missions.map((m) => [m.id, { ...m, units: new Set(m.units) }])); this.nextId = o.nextId; this.memory = new Map(o.memory); this.cooldown = o.cooldown || {}; this.reversals = o.reversals || 0; }

  // Threat memory: what was seen near our cities in the last 30 s (legitimately observed only).
  assess(threats) {
    const g = this.g;
    for (const u of threats) {
      let city = null, bd = Infinity;
      for (const c of this.ai.cities) { const d = dist(c.tile, u.tile); if (d < bd) { bd = d; city = c; } }
      this.memory.set(u.id, { tile: u.tile, str: (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp), seen: g.time, city: city ? city.id : -1 });
    }
    for (const [id, m] of this.memory) if (g.time - m.seen > 30 || !g.units.has(id)) this.memory.delete(id);
    const regions = new Map();
    for (const m of this.memory.values()) {
      if (m.city < 0) continue;
      const r = regions.get(m.city) || { city: m.city, str: 0, tiles: [] };
      r.str += m.str; r.tiles.push(m.tile); regions.set(m.city, r);
    }
    return regions;
  }

  order(m, ids, tile, attackMove, formation = 'line') {
    if (!ids.length || !(tile >= 0)) return;
    // the same objective again keeps routes (and the server de-duplicates too)
    if (m.lastTile === tile && m.lastKind === (attackMove ? 'a' : 'm') && this.g.time - (m.lastAt || 0) < 20) {
      const idle = ids.filter((id) => { const u = this.g.units.get(id); return u && !u.path.length && !u.field && u.order.kind === 'idle' && dist(u.tile, tile) > 3; });
      if (!idle.length) return;
      ids = idle;
    } else if (m.lastTile >= 0 && m.lastTile !== undefined && dist(m.lastTile, tile) > 8 && this.g.time - (m.lastAt || 0) < 10) this.reversals++;
    m.lastTile = tile; m.lastKind = attackMove ? 'a' : 'm'; m.lastAt = this.g.time;
    this.ai.cmd({ c: 'move', units: ids, tile, attackMove, formation, auth: 'mission' });
  }

  strength(ids) { let s = 0; for (const id of ids) { const u = this.g.units.get(id); if (u) s += (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp); } return s; }

  step(army, threats, enemies, desired) {
    const g = this.g, civ = this.civ, T = this.tune;
    // drop the dead; find who is free
    const alive = new Set(army.map((u) => u.id));
    for (const m of this.missions.values()) for (const id of m.units) if (!alive.has(id)) m.units.delete(id);
    const assigned = new Set(); for (const m of this.missions.values()) for (const id of m.units) assigned.add(id);
    const reserve = () => army.filter((u) => !assigned.has(u.id));
    const take = (m, units) => { for (const u of units) { m.units.add(u.id); assigned.add(u.id); } };
    const release = (m) => { for (const id of m.units) assigned.delete(id); this.missions.delete(m.id); };

    // ---------------------------------------------------------------- defense
    const regions = this.assess(threats);
    for (const [cityId, r] of regions) {
      const city = g.cities.get(cityId); if (!city) continue;
      let m = [...this.missions.values()].find((x) => x.kind === 'defend' && x.city === cityId);
      if (!m) { m = { id: this.nextId++, kind: 'defend', city: cityId, zone: city.tile, radius: 6, units: new Set(), commitUntil: g.time + COMMIT.defend * T.commit, state: 'respond', created: g.time }; this.missions.set(m.id, m); }
      m.lastThreat = g.time;
      const need = r.str * T.react;
      let have = this.strength(m.units);
      if (have < need) {
        const pool = reserve().sort((a, b) => dist(a.tile, city.tile) - dist(b.tile, city.tile));
        for (const u of pool) { if (have >= need) break; if (dist(u.tile, city.tile) > 24) break; take(m, [u]); have += (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp); }
      }
      // emergency: a city about to fall may pull units off an offensive (the one allowed interruption)
      if (have < need * 0.5 && r.str > 30) {
        const off = [...this.missions.values()].find((x) => x.kind === 'offensive');
        if (off) { const pull = [...off.units].map((id) => g.units.get(id)).filter((u) => u && dist(u.tile, city.tile) < 16).slice(0, 6); for (const u of pull) off.units.delete(u.id); take(m, pull); }
      }
    }
    for (const m of [...this.missions.values()].filter((x) => x.kind === 'defend')) {
      const city = g.cities.get(m.city);
      if (!city || city.owner !== civ.id) { release(m); continue; }
      const r = regions.get(m.city);
      const ids = [...m.units];
      if (r) {
        // engage inside the zone only: aim at the threat closest to the city, never chase beyond the zone
        const tile = r.tiles.slice().sort((a, b) => dist(a, city.tile) - dist(b, city.tile))[0];
        const aim = dist(tile, city.tile) <= m.radius ? tile : clampToward(city.tile, tile, m.radius);
        this.order(m, ids, aim, true, 'line');
        m.state = 'respond';
      } else if (g.time > m.commitUntil && g.time - (m.lastThreat || 0) > 12) {
        if (m.state !== 'consolidate') { m.state = 'consolidate'; m.consolidateAt = g.time; this.order(m, ids, city.tile, false, 'line'); }
        else if (g.time - m.consolidateAt > 10) release(m);
      }
      // anyone who wandered past the zone comes back
      const strays = ids.filter((id) => { const u = g.units.get(id); return u && dist(u.tile, m.zone) > m.radius + 3 && u.order.kind !== 'attack'; });
      if (strays.length) this.ai.cmd({ c: 'move', units: strays, tile: m.zone, attackMove: true, auth: 'mission' });
    }

    // ---------------------------------------------------------------- offensive
    let off = [...this.missions.values()].find((x) => x.kind === 'offensive');
    if (!enemies.length) { if (off) { this.order(off, [...off.units], this.home(), false, 'column'); release(off); } return; }
    const target = this.ai.pickTargetCity(enemies);
    if (off && target && off.target !== target.id && g.time > off.commitUntil) {
      // hysteresis: only switch for a clearly better objective
      const cap = g.capital(civ);
      const cur = cap ? dist(cap.tile, off.tile) : 0, alt = cap ? dist(cap.tile, target.tile) : 0;
      if (alt * T.switch < cur) { this.order(off, [...off.units], off.staging, false, 'column'); release(off); off = null; }
    }
    if (off) {
      const tc = g.cities.get(off.target);
      if (!tc || tc.owner === civ.id || !g.hostile(civ.id, tc.owner)) { off.state = 'done'; this.order(off, [...off.units], tc ? tc.tile : this.home(), false, 'line'); release(off); off = null; }
    }
    if (!off) {
      if (!target || (this.cooldown[target.id] || 0) > g.time) return;
      const free = reserve();
      if (free.length < Math.max(4, desired * 0.7)) return;
      const staging = stagingTile(g, civ, target.tile);
      off = { id: this.nextId++, kind: 'offensive', target: target.id, tile: target.tile, buildingId: target.buildingId, staging, units: new Set(), state: 'assemble', commitUntil: g.time + COMMIT.offensive * T.commit, created: g.time };
      take(off, free);
      off.start = this.strength(off.units);
      this.missions.set(off.id, off);
      this.ai.campaign = { city: target.id, start: off.units.size, stage: staging };
      this.order(off, [...off.units], staging, false, 'column');
      return;
    }
    const ids = [...off.units];
    const units = ids.map((id) => g.units.get(id)).filter(Boolean);
    const supply = units.length ? units.reduce((s, u) => s + u.supply, 0) / units.length : 0;
    if (off.state !== 'regroup' && (this.strength(ids) < off.start * 0.35 || supply < 15)) {
      off.state = 'regroup'; off.regroupAt = g.time;
      this.cooldown[off.target] = g.time + 180;          // do not throw the same failed attack straight back
      this.order(off, ids, off.staging >= 0 ? off.staging : this.home(), false, 'column');
      return;
    }
    if (off.state === 'regroup') { if (g.time - off.regroupAt > 40) { this.ai.campaign = null; release(off); } return; }
    if (off.state === 'assemble') {
      const near = units.filter((u) => dist(u.tile, off.staging) <= 3).length;
      // reinforcements join while assembling
      const extra = reserve().filter((u) => dist(u.tile, off.staging) < 30).slice(0, 4);
      if (extra.length) { take(off, extra); this.ai.cmd({ c: 'move', units: extra.map((u) => u.id), tile: off.staging, formation: 'column', auth: 'mission' }); }
      if (near >= units.length * 0.8 || g.time - off.created > 120) { off.state = 'execute'; off.startedAt = g.time; this.order(off, ids, off.tile, true, 'line'); }
      return;
    }
    // execute: hold the objective; local targeting is left to the units and the server
    const town = off.buildingId >= 0 ? g.buildings.get(off.buildingId) : null;
    const close = units.filter((u) => dist(u.tile, off.tile) <= 5 && u.order.kind !== 'attack');
    if (town && close.length) this.ai.cmd({ c: 'attack', units: close.map((u) => u.id), target: { kind: 'building', id: town.id }, auth: 'mission' });
    this.order(off, ids, off.tile, true, 'line');
  }

  // Scouts keep an exploration objective until it is reached or no longer unexplored.
  scouts(scouts) {
    const g = this.g, civ = this.civ;
    for (const s of scouts) {
      let m = [...this.missions.values()].find((x) => x.kind === 'scout' && x.units.has(s.id));
      const valid = m && !civ.explored[m.tile] && g.time < m.commitUntil + 60;
      const moving = s.path.length || s.field;
      if (m && valid && (moving || dist(s.tile, m.tile) > 1)) { if (!moving) this.ai.cmd({ c: 'move', units: [s.id], tile: m.tile, auth: 'mission' }); continue; }
      if (m) this.missions.delete(m.id);
      const t = this.ai.randomUnexplored(); if (t < 0) continue;
      m = { id: this.nextId++, kind: 'scout', tile: t, units: new Set([s.id]), commitUntil: g.time + COMMIT.scout, created: g.time };
      this.missions.set(m.id, m);
      this.ai.cmd({ c: 'move', units: [s.id], tile: t, auth: 'mission' });
    }
  }

  home() { const c = this.g.capital(this.civ); return c ? c.tile : -1; }
  assignedIds() { const s = new Set(); for (const m of this.missions.values()) for (const id of m.units) s.add(id); return s; }
  summary() { return [...this.missions.values()].map((m) => ({ id: m.id, kind: m.kind, state: m.state, units: m.units.size, tile: m.kind === 'defend' ? m.zone : m.tile, staging: m.staging })); }
}

function clampToward(from, to, r) { const line = hexLine(from, to); return line[Math.min(line.length - 1, r)]; }

// A staging point short of the objective, on our side of it.
function stagingTile(g, civ, target) {
  const cap = g.capital(civ); if (!cap) return target;
  const line = hexLine(target, cap.tile);
  for (let i = Math.min(line.length - 1, 7); i >= 3; i--) { const t = line[i]; const ter = g.world.terr[t]; if (!isWater(ter) && Number.isFinite(TERRAIN[ter].move)) return t; }
  return line[Math.min(line.length - 1, 4)];
}
void disk; void N;
