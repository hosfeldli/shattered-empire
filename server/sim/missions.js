// AI military planning by missions. Every combat unit belongs to one mission (defend a city's
// zone, an offensive, its scouting run) or to the reserve. A mission keeps its purpose until it
// completes, fails or is invalidated; a commitment period and hysteresis stop armies reversing on
// every planning tick; local threats change targeting inside a zone, not strategic destinations.
import { UNITS, TERRAIN, isWater, N, W, H, aiProfile } from './constants.js';
import { dist, disk, hexLine, WRAP } from './hex.js';
import { lineAcross } from './deploy.js';

const COMMIT = { defend: 15, offensive: 90, scout: 60 };

export class MilitaryPlanner {
  constructor(ai) { this.ai = ai; this.missions = new Map(); this.nextId = 1; this.memory = new Map(); this.cooldown = {}; this.reversals = 0; }

  owner(id) { for (const m of this.missions.values()) if (m.units.has(id)) return m.id; return 0; }
  get g() { return this.ai.g; }
  get civ() { return this.ai.civ; }
  get tune() { return aiProfile(this.civ).skill; }

  serialize() { return { missions: [...this.missions.values()].map((m) => ({ ...m, units: [...m.units] })), nextId: this.nextId, memory: [...this.memory.entries()], cooldown: this.cooldown, reversals: this.reversals }; }
  load(o) { if (!o) return; this.missions = new Map(o.missions.map((m) => [m.id, { ...m, units: new Set(m.units) }])); this.nextId = o.nextId; this.memory = new Map(o.memory); this.cooldown = o.cooldown || {}; this.reversals = o.reversals || 0; }

  // Threat memory: what was seen near our cities in the last 30 s (legitimately observed only).
  assess(threats) {
    const g = this.g;
    for (const u of threats) {
      let city = null, bd = Infinity;
      for (const c of this.ai.cities) { const d = dist(c.tile, u.tile); if (d < bd) { bd = d; city = c; } }
      this.memory.set(u.id, { tile: u.tile, str: (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp), seen: g.time, city: city ? city.id : -1, art: UNITS[u.type].cat === 'artillery' });
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
    this.ai.cmd({ c: 'move', units: ids, tile, attackMove, formation, auth: 'mission', by: 'mission:' + m.id });
  }

  // Mission state machine: every transition is recorded with its reason (diagnostics), and a flip
  // straight back to the state just left counts as an oscillation (tracked; the planner's commitment
  // periods and hysteresis exist to keep this near zero).
  setState(m, state, why = '') {
    if (m.state === state) return false;
    const g = this.g, h = m.history || (m.history = []);
    const prev = h[h.length - 1];
    if (prev && prev[2] === m.state && prev[1] === state && g.time - prev[0] < 15) { this.oscillations = (this.oscillations || 0) + 1; g.stats.oscillations = (g.stats.oscillations || 0) + 1; }
    h.push([+g.time.toFixed(1), m.state || 'new', state, why]); if (h.length > 8) h.shift();
    m.state = state; m.stateAt = g.time;
    return true;
  }

  strength(ids) { let s = 0; for (const id of ids) { const u = this.g.units.get(id); if (u) s += (UNITS[u.type].atk + UNITS[u.type].def) * (u.hp / u.maxHp); } return s; }

  step(army, threats, enemies, desired, opts = {}) {
    const g = this.g, civ = this.civ, T = this.tune;
    // drop the dead; find who is free
    const alive = new Set(army.map((u) => u.id));
    for (const m of this.missions.values()) for (const id of m.units) if (!alive.has(id)) m.units.delete(id);
    // missions whose units are all gone end (scouts that died used to leave empty missions behind forever)
    for (const m of [...this.missions.values()]) if (!m.units.size && ['scout', 'screen', 'raid', 'regroup', 'front'].includes(m.kind)) this.missions.delete(m.id);
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
        this.setState(m, 'respond', 'threat in the zone');
      } else if (g.time > m.commitUntil && g.time - (m.lastThreat || 0) > 12) {
        if (m.state !== 'consolidate') { this.setState(m, 'consolidate', 'zone quiet'); m.consolidateAt = g.time; this.order(m, ids, city.tile, false, 'line'); }
        else if (g.time - m.consolidateAt > 10) release(m);
      }
      // anyone who wandered past the zone comes back
      const strays = ids.filter((id) => { const u = g.units.get(id); return u && dist(u.tile, m.zone) > m.radius + 3 && u.order.kind !== 'attack'; });
      if (strays.length) this.ai.cmd({ c: 'move', units: strays, tile: m.zone, attackMove: true, auth: 'mission', by: 'mission:' + m.id });
    }

    // ---------------------------------------------------------------- battle lines
    this.fronts(reserve, take, release, enemies);

    // ---------------------------------------------------------------- offensive
    let off = [...this.missions.values()].find((x) => x.kind === 'offensive');
    if (!enemies.length) { if (off) { this.order(off, [...off.units], this.home(), false, 'column'); release(off); } this.support(army, reserve, take, release, enemies); return; }
    const target = this.ai.pickTargetCity(enemies);
    if (off && target && off.target !== target.id && g.time > off.commitUntil) {
      // hysteresis: only switch for a clearly better objective
      const cap = g.capital(civ);
      const cur = cap ? dist(cap.tile, off.tile) : 0, alt = cap ? dist(cap.tile, target.tile) : 0;
      if (alt * T.switch < cur) { this.order(off, [...off.units], off.staging, false, 'column'); release(off); off = null; }
    }
    if (off) {
      const tc = g.cities.get(off.target);
      if (!tc || tc.owner === civ.id || !g.hostile(civ.id, tc.owner)) { this.setState(off, 'done', tc && tc.owner === civ.id ? 'objective taken' : 'objective no longer valid'); this.order(off, [...off.units], tc ? tc.tile : this.home(), false, 'line'); release(off); off = null; }
    }
    if (!off) {
      if (!target || (this.cooldown[target.id] || 0) > g.time || opts.allowOffensive === false) { this.support(army, reserve, take, release, enemies); return; }
      // Final Campaign: an enemy down to its last cities gets everything (no home reserve, longer commitment)
      const tOwner = g.cities.get(target.id)?.owner;
      const final = tOwner != null && !g.civs[tOwner]?.isRebel && g.cityOf(g.civs[tOwner]).length <= 2;
      // a deliberate reserve stays home (skill): not every unit joins every offensive
      // the line facing this enemy goes forward with the offensive (a push, not a separate army)
      for (const fm of [...this.missions.values()].filter((x) => x.kind === 'front' && x.enemy === tOwner)) release(fm);
      const all = reserve();
      const free = final ? all : all.slice(0, Math.max(0, Math.ceil(all.length * (1 - T.reserve))));
      if (free.length < Math.max(4, desired * (final ? 0.3 : 0.45))) { this.support(army, reserve, take, release, enemies); return; }
      const staging = stagingTile(g, civ, target.tile);
      off = { id: this.nextId++, kind: 'offensive', target: target.id, tile: target.tile, buildingId: target.buildingId, staging, units: new Set(), state: 'assemble', commitUntil: g.time + COMMIT.offensive * T.commit * (final ? 2 : 1), created: g.time, final };
      if (final) g.notify(-1, `${civ.name} launches its final campaign against ${g.civs[tOwner].name}.`, { kind: 'war', tile: target.tile, quiet: true });
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
    // retreat judgment (skill): losses, supply, and the visible enemy strength near the objective
    const seenNear = T.level >= 1 ? [...g.units.values()].filter((e) => g.hostile(civ.id, e.owner) && civ.visible[e.tile] && dist(e.tile, off.tile) <= 6 && !UNITS[e.type].civilian) : [];
    const odds = seenNear.length ? this.strength(ids) / Math.max(1, this.strength(seenNear.map((e) => e.id))) : 9;
    if (off.state !== 'regroup' && (this.strength(ids) < off.start * T.retreat * (off.final ? 0.6 : 1) || supply < 15 || (off.state === 'execute' && T.level >= 2 && odds < 0.6))) {
      this.setState(off, 'regroup', supply < 15 ? 'out of supply' : odds < 0.6 && off.state === 'execute' ? 'outmatched at the objective' : 'heavy losses'); off.regroupAt = g.time;
      this.cooldown[off.target] = g.time + (off.final ? 45 : 90);          // do not throw the same failed attack straight back
      this.order(off, ids, off.staging >= 0 ? off.staging : this.home(), false, 'column');
      return;
    }
    if (off.state === 'regroup') { if (g.time - off.regroupAt > 25) { this.ai.campaign = null; release(off); } this.support(army, reserve, take, release, enemies); return; }
    if (off.state === 'assemble') {
      const near = units.filter((u) => dist(u.tile, off.staging) <= 3).length;
      // reinforcements join while assembling
      const extra = reserve().filter((u) => dist(u.tile, off.staging) < 30).slice(0, 4);
      if (extra.length) { take(off, extra); this.ai.cmd({ c: 'move', units: extra.map((u) => u.id), tile: off.staging, formation: 'column', auth: 'mission', by: 'mission:' + off.id }); }
      if (near >= units.length * 0.6 || g.time - off.created > 45) { this.setState(off, 'execute', near >= units.length * 0.6 ? 'assembled' : 'assembly timed out'); off.startedAt = g.time; this.order(off, ids, off.tile, true, 'line'); }
      return;
    }
    // execute: first suppress the defenses covering the objective with the guns (bunkers, forts,
    // guard posts, AA), then the assault; local targeting is otherwise left to the units and the server
    const defenses = [...g.buildings.values()].filter((b) => g.hostile(civ.id, b.owner) && b.done && civ.visible[b.tile] && g.defs.BUILDINGS[b.type].attack && b.type !== 'town' && dist(b.tile, off.tile) <= 6);
    if (defenses.length) {
      const guns = units.filter((u) => UNITS[u.type].cat === 'artillery' && u.order.kind !== 'attack');
      for (const u of guns) {
        const d = defenses.slice().sort((a, b) => dist(a.tile, u.tile) - dist(b.tile, u.tile))[0];
        this.ai.cmd({ c: 'attack', units: [u.id], target: { kind: 'building', id: d.id }, auth: 'mission' });
      }
      off.suppressing = defenses.length;
    } else off.suppressing = 0;
    // execute as a horde: the force rushes the objective at once, split into prongs that come in
    // from the front and both flanks (better commanders use more prongs) while the guns follow the
    // main body and shell what covers the town; stragglers and fresh troops are thrown back in
    // every few seconds, so the pressure never lets up. Close in, the assault on the town takes over.
    const broken = (() => { const t = off.buildingId >= 0 ? g.buildings.get(off.buildingId) : null; return t && t.hp <= t.maxHp * 0.25; })();
    if ((off.state === 'execute' || off.state === 'advance') && !broken) {
      const toObj = dist(units.length ? units[Math.floor(units.length / 2)].tile : off.staging, off.tile);
      if (toObj > 4) {
        if (off.wave == null) {
          const prongs = Math.min(3, Math.max(1, T.level + 1), Math.floor(units.length / 3) || 1);
          const W2 = { W, H, wrap: WRAP };
          const path = hexLine(off.staging >= 0 ? off.staging : units[0].tile, off.tile);
          const mid = path[Math.floor(path.length * 0.55)] ?? off.tile;
          const across = lineAcross(W2, mid, off.tile, Math.max(5, Math.min(11, Math.round(toObj * 0.6))), 0);
          const fighters = units.filter((u) => UNITS[u.type].cat !== 'artillery');
          const guns = units.filter((u) => UNITS[u.type].cat === 'artillery' && u.order.kind !== 'attack');
          // prongs by position: whoever is already on a side takes that side
          const groups = Array.from({ length: prongs }, () => []);
          fighters.forEach((u, i) => groups[i % prongs].push(u.id));
          const flank = across && prongs > 1 ? [null, across[0], across[1]] : [null];
          groups.forEach((ids, i) => {
            if (!ids.length) return;
            if (flank[i] >= 0 && flank[i] != null) {
              this.ai.cmd({ c: 'move', units: ids, tile: flank[i], attackMove: true, formation: 'wedge', auth: 'mission', by: 'mission:' + off.id });
              this.ai.cmd({ c: 'move', units: ids, tile: off.tile, attackMove: true, queue: true, formation: 'wedge', auth: 'mission', by: 'mission:' + off.id });
            } else this.ai.cmd({ c: 'move', units: ids, tile: off.tile, attackMove: true, formation: 'wedge', auth: 'mission', by: 'mission:' + off.id });
          });
          if (guns.length) { const back = hexLine(off.tile, off.staging >= 0 ? off.staging : guns[0].tile)[4] ?? mid; this.ai.cmd({ c: 'move', units: guns.map((u) => u.id), tile: back, attackMove: true, auth: 'mission', by: 'mission:' + off.id }); }
          off.wave = g.time; off.prongs = prongs;
          this.setState(off, 'advance', prongs > 1 ? `the horde attacks from ${prongs} directions` : 'the horde attacks');
          return;
        }
        if (g.time - off.wave > 10) {
          off.wave = g.time;
          // reinforcements from the reserve join the rush; idle members go again
          const extra = reserve().filter((u) => dist(u.tile, off.tile) < 30 && UNITS[u.type].cat !== 'artillery').slice(0, 6);
          if (extra.length) take(off, extra);
          const idle = [...off.units].map((id) => g.units.get(id)).filter((u) => u && !u.path.length && !u.field && u.order.kind !== 'attack' && UNITS[u.type].cat !== 'artillery');
          if (idle.length) this.ai.cmd({ c: 'move', units: idle.map((u) => u.id), tile: off.tile, attackMove: true, formation: 'wedge', auth: 'mission', by: 'mission:' + off.id });
        }
        return;
      }
    }
    const town = off.buildingId >= 0 ? g.buildings.get(off.buildingId) : null;
    // siege termination: once the town is broken, troops walk in to take it (a capture needs ground
    // troops next to the town); shelling alone would only end in ruins
    if (town && town.hp <= town.maxHp * 0.25) {
      const adjacent = units.filter((u) => dist(u.tile, off.tile) <= 1 && UNITS[u.type].cat !== 'artillery').length;
      if (!adjacent) {
        const takers = units.filter((u) => UNITS[u.type].cat !== 'artillery' && !UNITS[u.type].civilian).sort((a, b) => dist(a.tile, off.tile) - dist(b.tile, off.tile)).slice(0, 3);
        const spot = disk(off.tile, 1).find((t) => t !== off.tile && !isWater(g.world.terr[t]) && Number.isFinite(TERRAIN[g.world.terr[t]].move));
        if (takers.length && spot >= 0 && (off.captureAt ?? -1) <= g.time) { off.captureAt = g.time + 8; this.ai.cmd({ c: 'move', units: takers.map((u) => u.id), tile: spot, attackMove: false, auth: 'mission' }); this.setState(off, 'capture', 'town broken: moving in'); }
      }
    }
    const close = units.filter((u) => dist(u.tile, off.tile) <= 5 && u.order.kind !== 'attack' && !(off.state === 'capture' && dist(u.tile, off.tile) <= 2));
    if (town && close.length) this.ai.cmd({ c: 'attack', units: close.map((u) => u.id), target: { kind: 'building', id: town.id }, auth: 'mission' });
    // units with a target of their own (guns on defenses, troops on the town) keep it
    if (off.state === 'capture' && town && town.hp > town.maxHp * 0.5) this.setState(off, 'execute', 'the town recovered');
    this.order(off, ids.filter((id) => { const u = g.units.get(id); return u && u.order.kind !== 'attack' && !(off.state === 'capture' && dist(u.tile, off.tile) <= 2); }), off.tile, true, 'line');
    this.support(army, reserve, take, release, enemies);
  }

  // Battle lines: against each enemy within reach the AI holds a deployed, entrenched line across
  // the approach between its nearest city and the enemy's, like a player would, and moves the line
  // when the front moves. Units on the line belong to the 'front' mission (not the reserve).
  fronts(reserve, take, release, enemies) {
    const g = this.g, civ = this.civ, T = this.tune;
    if ((this.frontAt || 0) > g.time) return;
    this.frontAt = g.time + 20;
    const mine = this.ai.cities; if (!mine.length) return;
    const W2 = { W, H, wrap: WRAP };
    for (const e of enemies) {
      // the closest pair of (our city, their known city): the axis of this front
      let best = null;
      for (const [, k] of civ.knownCities) if (k.owner === e.id) for (const c of mine) { const d = dist(c.tile, k.tile); if (d < 40 && (!best || d < best.d)) best = { d, ours: c, theirs: k }; }
      let m = [...this.missions.values()].find((x) => x.kind === 'front' && x.enemy === e.id);
      if (!best) { if (m) release(m); continue; }
      // the line stands a third of the way out from our city (never beyond our side of the middle)
      const ahead = Math.max(2, Math.min(Math.floor(best.d * 0.35), 7));
      const want = Math.max(3, Math.min(10, Math.round(reserve().length * (0.35 + 0.1 * T.level))));
      if (!m) {
        const free = reserve().filter((u) => UNITS[u.type].cat !== 'artillery').slice(0, want);
        if (free.length < 3) continue;
        m = { id: this.nextId++, kind: 'front', enemy: e.id, city: best.ours.id, toward: best.theirs.tile, units: new Set(), state: 'deploy', created: g.time, commitUntil: g.time + 120 };
        this.missions.set(m.id, m); take(m, free);
      }
      const ids = [...m.units].filter((id) => g.units.has(id));
      if (!ids.length) { release(m); continue; }
      const moved = m.anchor == null || dist(m.anchor, best.ours.tile) > 0 || dist(m.toward, best.theirs.tile) > 3;
      if (moved || g.time - (m.deployedAt || -999) > 240) {
        const line = lineAcross(W2, best.ours.tile, best.theirs.tile, Math.max(3, Math.min(8, Math.ceil(ids.length / 1.5) + 1)), ahead);
        if (!line) continue;
        m.anchor = best.ours.tile; m.toward = best.theirs.tile; m.line = line; m.deployedAt = g.time;
        this.ai.cmd({ c: 'deploy', units: ids, line, mode: 'depth', behavior: 'defend', density: 'auto', auth: 'mission' });
        this.setState(m, 'holding', 'line deployed toward ' + (g.civs[e.id]?.name || 'the enemy'));
        m.dug = false;
      }
      // dig the line in once the troops are on it (every difficulty; better ones reinforce it)
      if (!m.dug && m.line && g.time - m.deployedAt > 15 && civ.res.materials > (T.level >= 1 ? 80 : 160)) {
        const r = this.ai.cmd({ c: 'trenchPlan', points: m.line, type: civ.techs.has('fortification') && T.level >= 1 ? 'reinforced' : 'basic', commit: true, by: 'mission' });
        if (!(r && r.error)) { m.dug = true; this.setState(m, 'entrenched', 'trench line dug'); }
      }
      // keep the line manned: reinforce from the reserve up to the wanted strength
      if (ids.length < want) { const more = reserve().slice(0, want - ids.length); if (more.length) { take(m, more); m.deployedAt = -999; } }
    }
    for (const m of [...this.missions.values()]) if (m.kind === 'front' && !enemies.some((e) => e.id === m.enemy)) release(m);
  }

  // Secondary missions, by skill: regroup the battered, fortify held defensive lines, spread out
  // under artillery, keep a picket screen toward the enemy, and raid exposed enemy economy.
  support(army, reserve, take, release, enemies) {
    const g = this.g, civ = this.civ, T = this.tune;
    if (g.time - (this.supportAt || 0) < 6) return;
    this.supportAt = g.time;
    const mission = (kind) => [...this.missions.values()].filter((m) => m.kind === kind);
    // regroup: badly damaged or unsupplied units in the reserve recover at the nearest city
    for (const m of mission('regroup')) {
      const us = [...m.units].map((id) => g.units.get(id)).filter(Boolean);
      for (const u of us) if (u.hp > u.maxHp * 0.75 && u.supply > 50) m.units.delete(u.id);
      if (!m.units.size || g.time - m.created > 240) release(m);
    }
    const battered = reserve().filter((u) => u.hp < u.maxHp * 0.4 || u.supply < 20);
    if (battered.length) {
      const home = this.home();
      if (home >= 0) { const m = { id: this.nextId++, kind: 'regroup', tile: home, units: new Set(), created: g.time, commitUntil: g.time + 60 }; take(m, battered); this.missions.set(m.id, m); this.ai.cmd({ c: 'move', units: battered.map((u) => u.id), tile: home, formation: 'column', auth: 'mission' }); }
    }
    // defensive lines: hold the approach in a deployed, dug-in line instead of a blob
    if (T.fortify) for (const m of mission('defend')) {
      if (m.state !== 'respond' || m.fortified || g.time - m.created < 20) continue;
      const us = [...m.units].map((id) => g.units.get(id)).filter((u) => u && !u.path.length && !u.field);
      if (us.length < 3 || us.length < m.units.size * 0.7) continue;
      const city = g.cities.get(m.city); if (!city) continue;
      const r = this.memoryToward(city.tile); if (r < 0) continue;
      const line = perpendicularLine(g, city.tile, r, Math.min(6, Math.ceil(us.length / 2) + 1));
      if (!line) continue;
      const artillery = [...this.memory.values()].some((x) => x.art);
      this.ai.cmd({ c: 'deploy', units: us.map((u) => u.id), line, mode: 'depth', behavior: 'defend', density: artillery ? 'spread' : 'auto', auth: 'mission' });
      // the line is entrenched through the same trench planner players use (cost, crews, rules)
      if (civ.res.materials > 120) this.ai.cmd({ c: 'trenchPlan', points: line, type: civ.techs.has('fortification') ? 'reinforced' : 'basic', commit: true, by: 'mission' });
      m.fortified = g.time;
    }
    // under artillery: spread out a stacked group that keeps getting shelled
    if (T.disperse) {
      const byTile = new Map();
      for (const u of army) if (u.blastAt && g.time - u.blastAt < 12 && !u.path.length) { const a = byTile.get(u.tile) || []; a.push(u); byTile.set(u.tile, a); }
      for (const [t, us] of byTile) {
        const stacked = (g.tileUnits.get(t) || []).filter((id) => g.units.get(id)?.owner === civ.id).length;
        if (stacked < 3 || (this.dispersed?.[t] || 0) > g.time) continue;
        (this.dispersed || (this.dispersed = {}))[t] = g.time + 30;
        const ids = (g.tileUnits.get(t) || []).filter((id) => g.units.get(id)?.owner === civ.id);
        const line = perpendicularLine(g, t, this.memoryToward(t), Math.max(3, ids.length));
        if (line) this.ai.cmd({ c: 'deploy', units: ids, line, density: 'spread', behavior: 'defend', auth: 'mission' });
        void us;
      }
    }
    if (!enemies.length) return;
    // screen: one fast unit watches the most likely approach
    if (T.screen && !mission('screen').length) {
      const target = this.ai.pickTargetCity(enemies), cap = g.capital(civ);
      const fast = reserve().filter((u) => ['armored_car', 'scout_buggy', 'recon_drone'].includes(u.type))[0];
      if (target && cap && fast) {
        const line = hexLine(cap.tile, target.tile); const t = line[Math.floor(line.length * 0.4)];
        if (t >= 0 && !isWater(g.world.terr[t])) { const m = { id: this.nextId++, kind: 'screen', tile: t, units: new Set(), created: g.time, commitUntil: g.time + 120 }; take(m, [fast]); this.missions.set(m.id, m); this.ai.cmd({ c: 'move', units: [fast.id], tile: t, auth: 'mission' }); this.ai.cmd({ c: 'stance', units: [fast.id], stance: 'hold' }); }
      }
    }
    for (const m of mission('screen')) if (g.time > m.commitUntil + 120) release(m);
    // raid: a small fast group hits an exposed enemy economic site, then comes home
    if (T.raid) {
      for (const m of mission('raid')) {
        const us = [...m.units].map((id) => g.units.get(id)).filter(Boolean);
        const b = g.buildings.get(m.target);
        if (!b || !g.hostile(civ.id, b.owner) || g.time > m.commitUntil || us.length < 2 || us.some((u) => u.hp < u.maxHp * 0.5)) { this.order(m, us.map((u) => u.id), this.home(), false, 'column'); release(m); continue; }
        if (us.some((u) => dist(u.tile, b.tile) <= 3)) this.ai.cmd({ c: 'attack', units: us.map((u) => u.id), target: { kind: 'building', id: b.id }, auth: 'mission' });
      }
      if (!mission('raid').length && (this.raidAt || 0) < g.time) {
        this.raidAt = g.time + 150;
        const fast = reserve().filter((u) => ['armored_car', 'helicopter', 'special_forces', 'strike_swarm'].includes(u.type) && u.hp > u.maxHp * 0.8).slice(0, 4);
        if (fast.length >= 2) {
          // an exposed site: seen, not a city hub, with no hostile troops seen near it
          let best = null, bd = Infinity;
          for (const b of g.buildings.values()) {
            if (!g.hostile(civ.id, b.owner) || !civ.explored[b.tile] || b.type === 'town' || g.defs.BUILDINGS[b.type].attack) continue;
            if ([...g.units.values()].some((e) => e.owner === b.owner && civ.visible[e.tile] && dist(e.tile, b.tile) <= 4)) continue;
            const d = dist(fast[0].tile, b.tile); if (d < bd && d < 40) { bd = d; best = b; }
          }
          if (best) { const m = { id: this.nextId++, kind: 'raid', target: best.id, tile: best.tile, units: new Set(), created: g.time, commitUntil: g.time + 120 }; take(m, fast); this.missions.set(m.id, m); this.ai.cmd({ c: 'move', units: fast.map((u) => u.id), tile: best.tile, attackMove: true, formation: 'column', auth: 'mission' }); }
        }
      }
    }
  }

  // direction of the nearest remembered threat (or -1)
  memoryToward(tile) {
    let best = -1, bd = Infinity;
    for (const m of this.memory.values()) { const d = dist(m.tile, tile); if (d < bd) { bd = d; best = m.tile; } }
    if (best < 0) { const t = this.ai.pickTargetCity(this.ai.enemies()); if (t) best = t.tile; }
    return best;
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
  summary() { return [...this.missions.values()].map((m) => ({ id: m.id, kind: m.kind, state: m.state, units: m.units.size, tile: m.kind === 'defend' ? m.zone : m.tile, staging: m.staging, since: m.stateAt ?? m.created, history: m.history || [], suppressing: m.suppressing || 0 })); }
  missionOf(unitId) { for (const m of this.missions.values()) if (m.units.has(unitId)) return m; return null; }
}

// a defensive line of n hexes across the approach from `toward`, a few hexes out from `center`,
// facing the threat (shared orientation frame with the deployment planner; seam-safe)
function perpendicularLine(g, center, toward, n) {
  return lineAcross({ W, H, wrap: WRAP }, center, toward, n, 3);
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
