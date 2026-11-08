import { nativeRules, tempo } from './rulesets.js';
// Road network as a graph of edges between adjacent hexes. Each edge has a class
// (dirt/paved/highway/rail), a condition (0 = ruined) and may be a bridge over a river.
// Damage hits individual segments; ruined segments persist until repaired.
import { N, T, ROAD_TYPES, BRIDGE_MULT, isWater } from './constants.js';
import { NB, dist, toCube, idx } from './hex.js';

const key = (a, b) => (a < b ? a * N + b : b * N + a);

export class RoadNet {
  constructor(world) {
    this.w = world;
    this.edges = new Map();     // key -> { a, b, type, cond }
    this.projects = [];
    this.nextPid = 1;
    this.traffic = new Map();   // key -> recent usage (decays)
  }

  get(a, b) { return this.edges.get(key(a, b)); }
  usable(a, b) { const e = this.edges.get(key(a, b)); return e && e.cond > 0 ? e : null; }
  dirOf(a, b) { for (let d = 0; d < 6; d++) if (NB[a * 6 + d] === b) return d; return -1; }

  set(a, b, type, cond = 100) {
    const k = key(a, b);
    const e = this.edges.get(k);
    if (e) { e.type = Math.max(e.type, type); e.cond = cond; }
    else this.edges.set(k, { a: Math.min(a, b), b: Math.max(a, b), type, cond });
    this.refresh(a); this.refresh(b);
  }

  // Per-tile summary used by renderer/fast lookups: world.road = best usable class touching the tile.
  refresh(t) {
    let best = 0;
    for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n < 0) continue; const e = this.edges.get(key(t, n)); if (e && e.cond > 0 && e.type > best) best = e.type; }
    if (this.w.road[t] !== best) this.w.road[t] = best;
    this.w.touch(t);
  }

  // Packed per-tile edge description for clients: for each of 6 directions 3 bits type + 1 bit ruined.
  packTile(t) {
    let p = 0;
    for (let d = 0; d < 6; d++) {
      const n = NB[t * 6 + d]; if (n < 0) continue;
      const e = this.edges.get(key(t, n)); if (!e) continue;
      p |= ((e.type & 7) | (e.cond <= 0 ? 8 : 0) | (e.cond > 0 && e.cond < 50 ? 0 : 0)) << (d * 4);
    }
    return p;
  }

  damage(a, b, amount) {
    const e = this.edges.get(key(a, b)); if (!e || e.cond <= 0) return false;
    e.cond = Math.max(0, e.cond - amount);
    this.refresh(a); this.refresh(b);
    return e.cond === 0;
  }
  damageTile(t, amount, rng, prob = 1) {
    let ruined = 0;
    for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && (!rng || rng() < prob) && this.damage(t, n, amount)) ruined++; }
    return ruined;
  }
  // Lava / flooding wipe segments entirely.
  obliterate(t) {
    for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n < 0) continue; if (this.edges.delete(key(t, n))) this.refresh(n); }
    this.refresh(t);
  }
  edgesOf(t) { const out = []; for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n < 0) continue; const e = this.edges.get(key(t, n)); if (e) out.push(e); } return out; }

  noteTraffic(a, b, amt = 1) { if (a === b) return; const k = key(a, b); if (this.edges.has(k)) this.traffic.set(k, Math.min(40, (this.traffic.get(k) || 0) + amt)); }
  decayTraffic() { for (const [k, v] of this.traffic) { const nv = v * 0.9; if (nv < 0.2) this.traffic.delete(k); else this.traffic.set(k, nv); } }
  tileTraffic(t) { let m = 0; for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n < 0) continue; const v = this.traffic.get(key(t, n)); if (v > m) m = v; } return m; }

  // ---------------------------------------------------------------- planning
  // Turn a drawn polyline of hexes into adjacent steps (fills gaps with hex lines).
  static densify(tiles) {
    const out = [];
    for (const t of tiles) {
      if (!(t >= 0 && t < N)) continue;
      if (!out.length) { out.push(t); continue; }
      const prev = out[out.length - 1];
      if (prev === t) continue;
      const line = hexLine(prev, t);
      for (let i = 1; i < line.length; i++) if (line[i] !== out[out.length - 1]) out.push(line[i]);
    }
    return out;
  }

  validateSegment(g, civ, a, b, type, bridge = false) {
    const w = this.w;
    if (this.dirOf(a, b) < 0) return 'not adjacent';
    for (const t of [a, b]) {
      const ter = w.terr[t];
      if (isWater(ter) && !(bridge && ter === T.SHALLOW)) return bridge ? 'deep water: no bridge can stand there' : 'water';
      if (ter === T.PEAK) return 'impassable peaks';
      if (ter === T.LAVA) return 'lava';
      if (w.owner[t] >= 0 && w.owner[t] !== civ.id) return 'foreign territory';
      if (w.owner[t] < 0 && !civ.supply[t] && !civ.explored[t]) return 'unexplored land';
    }
    const rt = ROAD_TYPES[type];
    if (rt.tech && !civ.techs.has(rt.tech)) return `${rt.name} needs ${g.defs.TECHS[rt.tech].name}`;
    const river = w.river[a] || w.river[b];
    if (river) {
      const major = Math.max(w.river[a] ? riverSize(w, a) : 0, w.river[b] ? riverSize(w, b) : 0) >= 2;
      if (major && type < 2) return 'major river: needs a paved (Civil Engineering) bridge';
    }
    const e = this.get(a, b);
    if (e && e.type >= type && e.cond >= 100) return 'already built';
    return null;
  }

  segmentCost(civ, a, b, type) {
    const w = this.w;
    const rt = ROAD_TYPES[type];
    const e = this.get(a, b);
    const span = isWater(w.terr[a]) || isWater(w.terr[b]);
    let mult = (span ? BRIDGE_MULT * 1.6 : w.river[a] || w.river[b] ? BRIDGE_MULT : 1) * (w.terr[a] === T.MOUNTAIN || w.terr[b] === T.MOUNTAIN ? 2 : 1);
    if (e && e.type >= type) mult *= 0.4;              // repair of a damaged/ruined segment
    else if (e && e.cond > 0) mult *= 0.7;             // upgrade
    if ((!nativeRules(civ) && civ.policies.has('public_works'))) mult *= 0.5;
    const cost = {}; for (const k in rt.cost) cost[k] = Math.ceil(rt.cost[k] * mult);
    return { cost, time: rt.time * (span ? 3 : w.river[a] || w.river[b] ? 2 : 1) };
  }

  plan(g, civ, tiles, type, bridge = false) {
    const path = RoadNet.densify(tiles);
    const segs = [];
    const total = {}; let time = 0, bridges = 0, ok = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const why = this.validateSegment(g, civ, a, b, type, bridge);
      const s = { a, b, ok: !why || why === 'already built', reason: why, bridge: !!(this.w.river[a] || this.w.river[b] || isWater(this.w.terr[a]) || isWater(this.w.terr[b])), skip: why === 'already built' };
      if (!why) {
        const { cost, time: t } = this.segmentCost(civ, a, b, type);
        for (const k in cost) total[k] = (total[k] || 0) + cost[k];
        time += t; ok++; if (s.bridge) bridges++;
      }
      segs.push(s);
    }
    return { tiles: path, type, bridge, segments: segs, cost: total, time: Math.round(time / tempo(civ, 'infrastructureConstruction') * ((!nativeRules(civ) && civ.policies.has('public_works')) ? 0.5 : 1)), bridges, buildable: ok, blocked: segs.filter((s) => !s.ok).length, length: path.length - 1 };
  }

  startProject(g, civ, plan) {
    const segs = plan.segments.filter((s) => s.ok && !s.skip).map((s) => ({ a: s.a, b: s.b }));
    if (!segs.length) return { error: 'Nothing to build on that route' };
    if (this.projects.filter((p) => p.owner === civ.id && p.status !== 'complete').length >= 6) return { error: 'Too many road projects; finish or cancel some first' };
    const p = { id: this.nextPid++, owner: civ.id, type: plan.type, segs, i: 0, t: 0, status: 'funded', paid: false, by: plan.by || 'player', tiles: plan.tiles, bridge: !!plan.bridge };
    this.projects.push(p);
    return { project: p.id };
  }

  cancel(civ, id) { const p = this.projects.find((x) => x.id === id && x.owner === civ.id); if (!p) return { error: 'No such project' }; this.projects = this.projects.filter((x) => x !== p); return null; }

  // One simulated second of road construction. Segments are paid when work starts on them.
  step(g, dt) {
    const active = new Map();
    for (const p of this.projects) {
      if (p.status === 'complete') continue;
      const civ = g.civs[p.owner];
      if (!civ || !civ.alive) { p.status = 'complete'; continue; }
      const n = active.get(p.owner) || 0;
      if (n >= 3) { p.status = p.status === 'constructing' ? 'constructing' : 'funded'; continue; }
      active.set(p.owner, n + 1);
      const seg = p.segs[p.i];
      if (!seg) { p.status = 'complete'; continue; }
      if (!p.paid) {
        const why = this.validateSegment(g, civ, seg.a, seg.b, p.type, p.bridge);
        if (why === 'already built') { p.i++; continue; }
        if (why) {
          seg.blocked = why; p.blockedCount = (p.blockedCount || 0) + 1; p.i++; p.status = 'blocked';
          // never fail silently: say which stretch and why, with its location
          if (p.by === 'player') g.notify(p.owner, `Road works blocked: ${why}. Redraw around it or cancel the project.`, { kind: 'build', tile: seg.a, level: 'major' });
          continue;
        }
        const { cost, time } = this.segmentCost(civ, seg.a, seg.b, p.type);
        if (!g.canAfford(civ, cost)) {
          if (p.status !== 'paused' && p.by === 'player') g.notify(p.owner, 'Road works paused: waiting for materials.', { kind: 'build', tile: seg.a, level: 'minor' });
          p.status = 'paused'; continue;
        }
        g.pay(civ, cost); p.paid = true; p.t = time; p.total = time; p.status = 'constructing';
      }
      p.t -= dt * tempo(g, 'infrastructureConstruction') * ((!nativeRules(civ) && civ.policies.has('public_works')) ? 2 : 1);
      if (p.t <= 0) {
        this.set(seg.a, seg.b, p.type);
        p.i++; p.paid = false;
        if (p.i >= p.segs.length) {
          p.status = p.blockedCount ? 'blocked' : 'complete';
          p.done = true;
          g.notify(p.owner, `${p.bridge ? (p.type >= 4 ? 'Rail Bridge' : p.type >= 2 ? 'Reinforced Road Bridge' : 'Timber Bridge') : ROAD_TYPES[p.type].name} finished (${p.segs.length - (p.blockedCount || 0)} segments${p.blockedCount ? `, ${p.blockedCount} blocked` : ''}).`, { kind: 'build', tile: seg.b, quiet: p.by !== 'player' });
        }
      }
    }
    this.projects = this.projects.filter((p) => !p.done || g.time - (p.doneAt ?? (p.doneAt = g.time)) < 20);
  }

  projectsFor(civId) {
    return this.projects.filter((p) => p.owner === civId).map((p) => ({ id: p.id, type: p.type, bridge: p.bridge ? 1 : undefined, status: p.done ? (p.blockedCount ? 'blocked' : 'complete') : p.status, done: p.i, total: p.segs.length, tiles: p.segs.slice(p.i).flatMap((s, k) => (k === 0 ? [s.a, s.b] : [s.b])), by: p.by, blocked: p.segs.filter((s) => s.blocked).slice(0, 20).map((s) => [s.a, s.b, s.blocked]), ...(p.paid && p.segs[p.i] ? { seg: [p.segs[p.i].a, p.segs[p.i].b], prog: Math.round(100 * (1 - Math.max(0, p.t) / (p.total || 1))) } : {}) }));
  }

  serialize() { return { edges: [...this.edges.values()].map((e) => [e.a, e.b, e.type, Math.round(e.cond)]), projects: this.projects, nextPid: this.nextPid }; }
  load(o) { this.edges.clear(); for (const [a, b, type, cond] of o.edges) this.edges.set(key(a, b), { a, b, type, cond }); this.projects = o.projects; this.nextPid = o.nextPid; }
}

export function riverSize(w, t) { return w.river[t] ? Math.min(4, Math.floor(Math.log2(Math.max(1, w.flow[t] / 42))) + 1) : 0; }

// Hex line between two tiles (cube-coordinate lerp).
export function hexLine(a, b) {
  const n = dist(a, b);
  const [ax, ay, az] = toCube(a), [bx, by, bz] = toCube(b);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    let x = ax + (bx - ax) * t + 1e-6, y = ay + (by - ay) * t + 2e-6, z = az + (bz - az) * t - 3e-6;
    let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
    // cube (x=q-axial, y=r) -> odd-r offset
    const r = ry, q = rx + ((r - (r & 1)) >> 1);
    out.push(idx(q, r));
  }
  return out;
}
