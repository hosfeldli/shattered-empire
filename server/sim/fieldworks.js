// Field fortifications: trenches dug by infantry where they stand.
//
//  * One authoritative record per hex: owner, type (basic / reinforced), facing, construction
//    progress (excavation -> defensive works -> fortified), condition (hp), and who is digging.
//  * Built by stationary, unsuppressed infantry (engineers ~1.8x); several diggers on one hex
//    cooperate up to a cap. Materials are paid per segment when work starts there.
//  * Directional cover for infantry (front / flank / rear / indirect), scaled by completion and
//    condition; vehicles get little; never stacks additively with other cover.
//  * Explosives degrade it; diggers repair it; abandoned works slowly weather away.
//  * Never on buildings, water or developed city hexes. The city's developed (urban) footprint
//    is authoritative and only grows: when it reaches a trench, the trench is removed.
import { UNITS, BUILDINGS, TERRAIN, N, W, T, isWater } from './constants.js';
import { disk, dist, NB } from './hex.js';

export const FIELDWORKS = {
  basic: { name: 'Earthworks', time: 25, cost: { materials: 6 }, cover: { front: 0.25, flank: 0.10, rear: 0, indirect: 0.08 } },
  reinforced: { name: 'Reinforced trench', time: 30, cost: { materials: 10 }, cover: { front: 0.35, flank: 0.15, rear: 0.05, indirect: 0.12 }, tech: 'fortification' },
};
export const REPAIR = { time: 12, cost: { materials: 3 } };
const MAX_HP = 100;
const STAGE = (p) => (p >= 1 ? 3 : p >= 0.34 ? 2 : 1);          // 1 excavation, 2 defensive works, 3 fortified

export function fwInit(g) { g.fieldworks = new Map(); g.urban = new Uint8Array(N); g.urbanVer = 0; g.fwVer = 0; }

// who may dig: foot soldiers (not crew-served guns), and engineers
export function canDig(u) {
  const d = UNITS[u.type];
  if (d.engineer) return true;
  return d.move === 'infantry' && !d.civilian && d.cat !== 'artillery' && d.atk > 0;
}

export function siteProblem(g, civ, t) {
  if (t < 0 || t >= N) return 'off the map';
  const ter = g.world.terr[t];
  if (isWater(ter) || !Number.isFinite(TERRAIN[ter].move) || ter === T.LAVA) return 'water or impassable ground';
  if (g.urban[t]) return 'developed city district';
  if (g.tileB[t] >= 0) return 'a building stands there';
  const f = g.fieldworks.get(t);
  if (f && f.owner !== civ.id && f.progress > 0) return 'another empire\'s works';
  return null;
}

// facing as a unit vector (pixel space); dir index 0..5 for drawing
function dirIndex(fx, fy) { const a = Math.atan2(fy, fx); return ((Math.round(a / (Math.PI / 3)) % 6) + 6) % 6; }

// Plan segments on tiles. Returns { placed, skipped: [[tile, reason]], cost, seconds }.
export function fortify(g, civ, tiles, opts = {}) {
  const type = opts.type === 'reinforced' && civ.techs.has(FIELDWORKS.reinforced.tech) ? 'reinforced' : 'basic';
  const spec = FIELDWORKS[type];
  const [fx, fy] = opts.facing || [0, -1];
  const placed = [], skipped = [];
  for (const t of [...new Set(tiles)]) {
    const why = siteProblem(g, civ, t);
    if (why) { skipped.push([t, why]); continue; }
    const f = g.fieldworks.get(t);
    if (f && f.owner === civ.id) {
      // upgrade a finished basic trench to reinforced; otherwise keep what is there
      if (type === 'reinforced' && f.type === 'basic') { f.type = 'reinforced'; f.progress = Math.min(f.progress, 0.85); f.paid = false; f.state = 'constructing'; placed.push(t); }
      else skipped.push([t, f.progress >= 1 ? 'already fortified' : 'already under construction']);
      continue;
    }
    if (f) g.fieldworks.delete(t);      // an abandoned enemy excavation is simply re-dug
    g.fieldworks.set(t, { tile: t, owner: civ.id, type, fx: +fx.toFixed(3), fy: +fy.toFixed(3), dir: dirIndex(fx, fy), progress: 0, hp: MAX_HP, paid: false, state: 'planned', group: opts.group || 0, at: g.time, lastSeen: g.time });
    placed.push(t);
  }
  if (placed.length) g.fwVer++;
  const cost = {}; for (const [k, v] of Object.entries(spec.cost)) cost[k] = v * placed.length;
  const rate = digRate(civ, opts.diggers || 'infantry');
  return { type, placed, skipped, cost, seconds: Math.ceil(spec.time / rate) };
}

function digRate(civ, kind) { return (kind === 'engineer' ? 1.8 : 1) * (civ.techs.has('fortification') ? 1.2 : 1); }

// stop unfinished work (finished segments stay); or remove finished ones too
export function clearFieldworks(g, civ, tiles, { finished = false } = {}) {
  let n = 0;
  for (const t of tiles) { const f = g.fieldworks.get(t); if (!f || f.owner !== civ.id) continue; if (f.progress >= 1 && !finished) continue; g.fieldworks.delete(t); n++; }
  if (n) g.fwVer++;
  return n;
}

// cover a trench gives one unit against fire from `from` (or from above for indirect fire)
export function trenchCover(g, u, from, indirect) {
  const f = g.fieldworks.get(u.tile);
  if (!f || f.progress <= 0) return 0;
  const d = UNITS[u.type];
  if (d.air) return 0;
  const spec = FIELDWORKS[f.type].cover;
  let c;
  if (indirect || from == null || from < 0 || from === u.tile) c = spec.indirect;
  else {
    const [ax, ay] = xy(u.tile), [bx0, by] = xy(from);
    const P = Math.sqrt(3) * W; const bx = bx0 + Math.round((ax - bx0) / P) * P;
    const vx = bx - ax, vy = by - ay, l = Math.hypot(vx, vy) || 1;
    const cos = (vx * f.fx + vy * f.fy) / l;
    c = cos > 0.5 ? spec.front : cos > -0.5 ? spec.flank : spec.rear;
  }
  // unfinished and damaged works protect less; vehicles barely fit
  const stage = STAGE(f.progress);
  c *= stage === 1 ? 0.3 : stage === 2 ? 0.65 : 1;
  c *= Math.max(0, f.hp / MAX_HP);
  if (d.move !== 'infantry') c *= 0.25;
  return c;
}
const xy = (t) => { const r = (t / W) | 0, q = t % W; return [Math.sqrt(3) * (q + 0.5 * (r & 1)), 1.5 * r]; };

// explosives tear at the works
export function damageFieldworks(g, t, amount) {
  const f = g.fieldworks.get(t); if (!f) return;
  f.hp = Math.max(0, f.hp - amount);
  if (f.progress >= 1) f.state = f.hp < MAX_HP * 0.6 ? 'damaged' : 'complete';
  g.fwVer++;
}

// Every second: dig, repair, weather, and keep cities clear.
export function fieldworksStep(g, dt) {
  if (!g.fieldworks.size) return;
  let changed = false;
  for (const f of [...g.fieldworks.values()]) {
    const civ = g.civs[f.owner];
    if (!civ || !civ.alive) { g.fieldworks.delete(f.tile); changed = true; continue; }
    // diggers: own eligible units standing still on the hex and not pinned down
    let rate = 0, n = 0;
    for (const id of g.tileUnits.get(f.tile) || []) {
      const u = g.units.get(id);
      if (!u || u.owner !== f.owner || !canDig(u) || u.path.length || u.prog > 0 || u.field || (u.supp || 0) >= 50 || u.retreating) continue;
      rate += UNITS[u.type].engineer ? 1.8 : 1; n++;
    }
    let occupied = n > 0;
    if (!occupied) for (const id of g.tileUnits.get(f.tile) || []) { const u = g.units.get(id); if (u && u.owner === f.owner) { occupied = true; break; } }
    if (occupied) f.lastSeen = g.time;
    const spec = FIELDWORKS[f.type];
    rate = Math.min(rate, 2.4) * (civ.techs.has('fortification') ? 1.2 : 1);       // crowding: cooperation is capped
    if (f.progress < 1) {
      if (rate > 0) {
        if (!f.paid) {
          // materials for the segment are paid when the first spade goes in
          const c = spec.cost; if (!g.canAfford(civ, c, f.tile)) { f.state = 'materials'; continue; }
          g.pay(civ, c, f.tile); f.paid = true;
        }
        const before = STAGE(f.progress);
        f.progress = Math.min(1, f.progress + (rate * dt) / spec.time);
        f.state = f.progress >= 1 ? 'complete' : 'constructing';
        if (STAGE(f.progress) !== before || f.progress >= 1) changed = true;
        if (f.progress >= 1) f.hp = MAX_HP;
      } else if (f.state === 'constructing') { f.state = 'paused'; changed = true; }
    } else if (f.hp < MAX_HP && rate > 0) {
      // repair
      if (!f.repairing) { if (!g.canAfford(civ, REPAIR.cost, f.tile)) continue; g.pay(civ, REPAIR.cost, f.tile); f.repairing = true; }
      f.hp = Math.min(MAX_HP, f.hp + (MAX_HP * rate * dt) / REPAIR.time);
      if (f.hp >= MAX_HP) { f.repairing = false; f.state = 'complete'; changed = true; }
    }
    // abandoned works weather slowly; unpaid plans nobody works on lapse
    const idle = g.time - f.lastSeen;
    if (!f.paid && f.progress === 0 && idle > 180) { g.fieldworks.delete(f.tile); changed = true; continue; }
    if (idle > 600) { f.hp -= 0.04 * dt; if (f.hp <= 0) { g.fieldworks.delete(f.tile); changed = true; } }
  }
  if (changed) g.fwVer++;
}

// ------------------------------------------------------------------ urban footprint
// Developed districts grow with a city (and never shrink back), so trenches outside a city stay
// even when its borders grow, and are removed only when real development reaches them.
export function districtRadius(c) { return c.pop >= 120 ? 3 : c.pop >= 50 ? 2 : c.pop >= 16 ? 1 : 0; }
const URBAN_TYPES = new Set(['town', 'house', 'market', 'academy', 'hospital', 'university', 'research_lab', 'wonder']);
export function urbanStep(g) {
  const w = g.world;
  let grew = 0;
  const mark = (t) => { if (!g.urban[t]) { g.urban[t] = 1; grew++; const f = g.fieldworks.get(t); if (f) { g.fieldworks.delete(t); g.fwVer++; if (g.civs[f.owner]?.human) g.notify(f.owner, 'City growth built over a field trench.', { kind: 'build', tile: t, quiet: true, level: 'info' }); } } };
  for (const c of g.cities.values()) {
    mark(c.tile);
    const R = districtRadius(c);
    if (R) for (const t of disk(c.tile, R)) {
      if (isWater(w.terr[t]) || !Number.isFinite(TERRAIN[w.terr[t]].move) || w.owner[t] !== c.owner) continue;
      const b = g.buildingAtTile(t);
      if (b && !URBAN_TYPES.has(b.type)) continue;          // farms, mines and factories are not districts
      // districts grow outward contiguously from what is already developed
      let touch = false; for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && g.urban[n]) { touch = true; break; } }
      if (touch || dist(t, c.tile) <= 1) mark(t);
    }
  }
  for (const b of g.buildings.values()) if (URBAN_TYPES.has(b.type) && b.done) mark(b.tile);
  if (grew) g.urbanVer++;
}

// a building or city placed on a trench takes the hex
export function buildOver(g, t) { if (g.fieldworks.delete(t)) g.fwVer++; }

export function fieldworksFor(g, civ, vis) {
  const out = [];
  for (const f of g.fieldworks.values()) if (f.owner === civ.id || vis[f.tile]) out.push([f.tile, f.owner, f.type === 'reinforced' ? 1 : 0, f.dir, Math.round(f.progress * 100), Math.round(f.hp), f.state === 'materials' ? 1 : f.state === 'paused' ? 2 : 0]);
  return out;
}

export function serializeFieldworks(g) { return { list: [...g.fieldworks.values()], urban: Buffer.from(g.urban.buffer, g.urban.byteOffset, g.urban.byteLength).toString('base64') }; }
export function restoreFieldworks(g, d) {
  fwInit(g);
  if (!d) return;
  for (const f of d.list || []) g.fieldworks.set(f.tile, f);
  if (d.urban) { const buf = Buffer.from(d.urban, 'base64'); if (buf.length === N) g.urban.set(buf); }
}
void BUILDINGS;
