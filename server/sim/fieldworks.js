// Field fortifications: trench lines planned like roads and built by the national construction
// system — no troops have to stand on the line.
//
//  * The player (or the AI, through the same planner) draws a line: Build -> Defenses -> Trench Line.
//    The preview lists every segment (valid or why not), the facing, the cost and an estimated
//    completion from the empire's construction capacity. Commit creates a project.
//  * One authoritative record per hex: owner, type (earthworks / reinforced), facing, construction
//    progress (excavation -> defensive works -> fortified), condition (hp), project.
//  * Several segments progress at once (one per construction crew). Materials are charged per
//    segment when work starts there; reinforcing earthworks charges only the difference.
//  * Directional cover for infantry (front / flank / rear / indirect), scaled by completion and
//    condition; vehicles get little; never stacks additively with other cover. Entrenched infantry
//    use little supply. Anyone standing in a trench uses it (captured works protect the captor).
//  * Explosives degrade it; crews repair damaged segments automatically; abandoned works weather.
//  * Never on buildings, water, enemy-held ground or developed city hexes. The urban footprint is
//    authoritative and only grows: when real development reaches a trench, the trench is removed.
//    Trenches on the rural outskirts inside a city's territory remain.
import { UNITS, BUILDINGS, TERRAIN, N, W, T, isWater } from './constants.js';
import { disk, dist, NB, hexLine } from './hex.js';
import { nativeRules, tempo } from './rulesets.js';

export const FIELDWORKS = {
  basic: { name: 'Earthworks', time: 10, cost: { materials: 6 }, cover: { front: 0.25, flank: 0.10, rear: 0, indirect: 0.08 } },
  reinforced: { name: 'Reinforced trench', time: 18, cost: { materials: 10 }, cover: { front: 0.35, flank: 0.15, rear: 0.05, indirect: 0.12 }, tech: 'fortification' },
};
// reinforcing an existing earthworks segment: only the difference
export const UPGRADE = { time: 8, cost: { materials: 4 } };
export const REPAIR = { time: 6, cost: { materials: 3 } };
const MAX_HP = 100;
const STAGE = (p) => (p >= 1 ? 3 : p >= 0.34 ? 2 : 1);          // 1 excavation, 2 defensive works, 3 fortified
const MAX_LINE = 80;

export function fwInit(g) { g.fieldworks = new Map(); g.trenchProjects = new Map(); g.urban = new Uint8Array(N); g.urbanVer = 0; g.fwVer = 0; }

// kept for save compatibility and the supply-activity check: who may still be "digging in"
export function canDig(u) { const d = UNITS[u.type]; return !!d.engineer || (d.move === 'infantry' && !d.civilian && d.cat !== 'artillery' && d.atk > 0); }

// construction capacity: how many segments an empire can work on at once
export function trenchCrews(g, civ) {
  let cities = 0; for (const c of g.cities.values()) if (c.owner === civ.id) cities++;
  return Math.max(2, Math.min(10, 2 + Math.floor(cities / 2) + (civ.techs.has('fortification') ? 1 : 0) + (civ.techs.has('civil_engineering') ? 1 : 0)));
}

export function siteProblem(g, civ, t) {
  if (t < 0 || t >= N) return 'off the map';
  const ter = g.world.terr[t];
  if (isWater(ter) || !Number.isFinite(TERRAIN[ter].move) || ter === T.LAVA) return 'water or impassable ground';
  if (g.urban[t]) return 'developed city district';
  if (g.tileB[t] >= 0) return 'a building stands there';
  const o = g.world.owner[t];
  if (!g.sandbox) {                       // the developer combat sandbox treats the whole arena as supplied
    if (o >= 0 && o !== civ.id) return 'foreign territory';
    if (o !== civ.id && !civ.supply[t]) return 'outside your territory and supply network';
  }
  for (const id of g.tileUnits.get(t) || []) { const u = g.units.get(id); if (u && !UNITS[u.type].air && g.hostile(civ.id, u.owner)) return 'enemy troops hold it'; }
  const f = g.fieldworks.get(t);
  if (f && f.owner !== civ.id && f.progress > 0) return 'another empire\'s works';
  return null;
}

// facing as a unit vector (pixel space); dir index 0..5 for drawing
function dirIndex(fx, fy) { const a = Math.atan2(fy, fx); return ((Math.round(a / (Math.PI / 3)) % 6) + 6) % 6; }
const xy = (t) => { const r = (t / W) | 0, q = t % W; return [Math.sqrt(3) * (q + 0.5 * (r & 1)), 1.5 * r]; };
const P = Math.sqrt(3) * W;

// waypoints -> a continuous chain of hexes (straight hex lines between consecutive waypoints)
export function traceLine(points) {
  const out = [];
  const pts = points.filter((t) => Number.isInteger(t) && t >= 0 && t < N);
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) { out.push(pts[0]); continue; }
    const seg = hexLine(pts[i - 1], pts[i]);
    for (let k = 1; k < seg.length; k++) if (out[out.length - 1] !== seg[k]) out.push(seg[k]);
    if (out.length > MAX_LINE) break;
  }
  return [...new Set(out)].slice(0, MAX_LINE);
}

// The protected side: perpendicular to the line, toward the known threat (or away from the capital).
export function lineFacing(g, civ, tiles, reverse) {
  if (!tiles.length) return [0, -1];
  const [ax, ay] = xy(tiles[0]); let [bx, by] = xy(tiles[tiles.length - 1]); bx += Math.round((ax - bx) / P) * P;
  let dx = bx - ax, dy = by - ay; const l = Math.hypot(dx, dy);
  const mid = tiles[Math.floor(tiles.length / 2)];
  const threat = g.threatFacing(civ, mid);                 // unit vector toward the nearest known threat
  let n;
  if (l < 0.5) n = threat;                                  // a single hex faces the threat directly
  else {
    dx /= l; dy /= l; n = [dy, -dx];                          // a normal of the line
    if (n[0] * threat[0] + n[1] * threat[1] < 0) n = [-n[0], -n[1]];
  }
  if (reverse) n = [-n[0], -n[1]];
  return [+n[0].toFixed(3), +n[1].toFixed(3)];
}

// Preview (and the exact basis of a commit): every segment, its validity, the cost and the time.
export function planTrench(g, civ, points, opts = {}) {
  const type = opts.type === 'reinforced' && civ.techs.has(FIELDWORKS.reinforced.tech) ? 'reinforced' : 'basic';
  const tiles = traceLine(points || []);
  const facing = Array.isArray(opts.facing) && opts.facing.length === 2 ? opts.facing.map(Number) : lineFacing(g, civ, tiles, !!opts.reverse);
  const segments = [];
  const cost = {}; let work = 0;
  for (const t of tiles) {
    const why = siteProblem(g, civ, t);
    if (why) { segments.push({ t, ok: false, reason: why }); continue; }
    const f = g.fieldworks.get(t);
    if (f && f.owner === civ.id) {
      if (type === 'reinforced' && f.type === 'basic') { segments.push({ t, ok: true, upgrade: true }); for (const [k, v] of Object.entries(UPGRADE.cost)) cost[k] = (cost[k] || 0) + v; work += UPGRADE.time; }
      else segments.push({ t, ok: true, skip: true, reason: f.progress >= 1 ? 'already built' : 'already planned' });
      continue;
    }
    segments.push({ t, ok: true });
    for (const [k, v] of Object.entries(FIELDWORKS[type].cost)) cost[k] = (cost[k] || 0) + v;
    work += FIELDWORKS[type].time;
  }
  const crews = nativeRules(g) ? Math.min(2, tiles.length >= 8 && (g.sandbox || civ.supply[tiles.at(-1)]) && (g.sandbox || civ.supply[tiles[0]]) ? 2 : 1) : trenchCrews(g, civ), rate = crewRate(civ) * tempo(g, 'trenchConstruction');
  const build = segments.filter((s) => s.ok && !s.skip).length;
  // estimated completion: the work shared over the crews, plus whatever is already queued ahead
  const queued = queuedWork(g, civ);
  const seconds = build ? Math.ceil((queued + work) / (crews * rate)) : 0;
  return { type, name: FIELDWORKS[type].name, tiles, segments, facing, dir: dirIndex(facing[0], facing[1]), cost, build, invalid: segments.filter((s) => !s.ok).length, seconds, crews };
}

function crewRate(civ) { return civ.techs.has('fortification') ? 1.2 : 1; }
function queuedWork(g, civ) {
  let w = 0;
  for (const f of g.fieldworks.values()) if (f.owner === civ.id && f.progress < 1) w += (1 - f.progress) * (f.upgrading ? UPGRADE.time : FIELDWORKS[f.type].time);
  return w;
}

// Commit a plan exactly as previewed. Returns { project, placed, skipped, cost, seconds }.
export function commitTrench(g, civ, plan, by = 'player') {
  if (!plan.build) return { error: plan.invalid ? `no valid segments: ${plan.segments.find((s) => !s.ok)?.reason}` : 'nothing new to build on that line' };
  if (nativeRules(g) && plan.invalid) return { error: 'A continuous trench needs a valid route. Adjust the line around blocked ground.' };
  const id = (g.trenchSeq = (g.trenchSeq || 0) + 1);
  const pr = { id, owner: civ.id, type: plan.type, tiles: [], facing: plan.facing, created: g.time, by, status: 'queued' };
  if (nativeRules(g)) {
    pr.path = [...plan.tiles];
    const access = (tile) => (g.sandbox || civ.supply[tile] ? 2 : 0) + (g.world.road[tile] ? 4 : 0);
    if (access(pr.path.at(-1)) > access(pr.path[0])) pr.path.reverse();
    pr.twoFronts = pr.path.length >= 8 && access(pr.path[0]) > 0 && access(pr.path.at(-1)) > 0;
  }
  const [fx, fy] = plan.facing;
  for (const s of plan.segments) {
    if (!s.ok || s.skip) continue;
    const f = g.fieldworks.get(s.t);
    if (s.upgrade && f) { f.type = 'reinforced'; f.upgrading = true; f.progress = 0; f.paid = false; f.state = 'planned'; f.project = id; f.fx = fx; f.fy = fy; f.dir = dirIndex(fx, fy); pr.tiles.push(s.t); continue; }
    if (f) g.fieldworks.delete(s.t);       // an abandoned enemy excavation is simply re-dug
    g.fieldworks.set(s.t, { tile: s.t, owner: civ.id, type: plan.type, fx, fy, dir: dirIndex(fx, fy), progress: 0, hp: MAX_HP, paid: false, state: 'planned', project: id, at: g.time, lastSeen: g.time });
    pr.tiles.push(s.t);
  }
  if (pr.path) pr.tiles.sort((a, b) => pr.path.indexOf(a) - pr.path.indexOf(b));
  g.trenchProjects.set(id, pr);
  if (nativeRules(g)) updateTrenchRoutes(g);
  g.fwVer++;
  return { project: id, placed: pr.tiles.length, skipped: plan.segments.filter((s) => !s.ok || s.skip).map((s) => [s.t, s.reason]), cost: plan.cost, seconds: plan.seconds, type: plan.type };
}

// Kept as an alias for the old "fortify" network command (saves, older clients, scripts): the same
// planner and rules as a drawn line, never a second construction path.
export function fortify(g, civ, tiles, opts = {}) {
  const plan = planTrench(g, civ, tiles, { type: opts.type, facing: opts.facing });
  const r = commitTrench(g, civ, plan, opts.by || 'player');
  if (r.error) return { type: plan.type, placed: [], skipped: plan.segments.filter((s) => !s.ok).map((s) => [s.t, s.reason]), cost: {}, seconds: 0 };
  return { type: plan.type, placed: plan.segments.filter((s) => s.ok && !s.skip).map((s) => s.t), skipped: r.skipped, cost: r.cost, seconds: r.seconds };
}

// cancel unfinished work (finished segments stay) or demolish finished ones too
export function clearFieldworks(g, civ, tiles, { finished = false } = {}) {
  let n = 0;
  for (const t of tiles) { const f = g.fieldworks.get(t); if (!f || f.owner !== civ.id) continue; if (f.progress >= 1 && !f.upgrading && !finished) continue; g.fieldworks.delete(t); n++; }
  if (n) g.fwVer++;
  return n;
}
export function cancelTrenchProject(g, civ, id) {
  const pr = g.trenchProjects.get(id); if (!pr || pr.owner !== civ.id) return { error: 'no such project' };
  let n = 0;
  for (const t of pr.tiles) { const f = g.fieldworks.get(t); if (f && f.project === id && f.progress < 1) { if (f.upgrading) { f.type = 'basic'; f.upgrading = false; f.progress = 1; f.state = 'complete'; } else g.fieldworks.delete(t); n++; } }
  g.trenchProjects.delete(id); g.fwVer++;
  return { cancelled: n };
}

// cover a trench gives one unit against fire from `from` (or from above for indirect fire)
export function trenchCover(g, u, from, indirect) {
  const f = g.fieldworks.get(u.tile);
  if (!f || f.progress <= 0 && !f.upgrading) return 0;
  const d = UNITS[u.type];
  if (d.air) return 0;
  const spec = FIELDWORKS[f.upgrading ? 'basic' : f.type].cover;
  let c;
  if (indirect || from == null || from < 0 || from === u.tile) c = spec.indirect;
  else {
    const [ax, ay] = xy(u.tile), [bx0, by] = xy(from);
    const bx = bx0 + Math.round((ax - bx0) / P) * P;
    const vx = bx - ax, vy = by - ay, l = Math.hypot(vx, vy) || 1;
    // occupants who captured the works face the other way: their front is the trench's rear
    const sign = u.owner === f.owner ? 1 : -1;
    const cos = sign * (vx * f.fx + vy * f.fy) / l;
    c = cos > 0.5 ? spec.front : cos > -0.5 ? spec.flank : spec.rear;
  }
  // unfinished and damaged works protect less; vehicles barely fit
  const stage = f.upgrading ? 3 : STAGE(f.progress);
  c *= stage === 1 ? 0.3 : stage === 2 ? 0.65 : 1;
  c *= Math.max(0, f.hp / MAX_HP);
  if (d.move !== 'infantry') c *= 0.25;
  return c;
}

// explosives tear at the works
export function damageFieldworks(g, t, amount) {
  const f = g.fieldworks.get(t); if (!f) return;
  f.hp = Math.max(0, f.hp - amount);
  if (f.hp <= 0 && f.progress >= 1) { g.fieldworks.delete(t); g.fwVer++; return; }      // collapsed
  if (f.progress >= 1) f.state = f.hp < MAX_HP * 0.6 ? 'damaged' : 'complete';
  g.fwVer++;
}

// Every second: national crews build queued segments (several at once), repair damage, weather.
export function fieldworksStep(g, dt) {
  if (!g.fieldworks.size) return;
  let changed = false;
  const byCiv = new Map();
  for (const f of g.fieldworks.values()) {
    const civ = g.civs[f.owner];
    if (!civ || !civ.alive) { g.fieldworks.delete(f.tile); changed = true; continue; }
    let a = byCiv.get(f.owner); if (!a) byCiv.set(f.owner, a = []); a.push(f);
    // an occupied trench is a used trench (it does not weather)
    for (const id of g.tileUnits.get(f.tile) || []) { const u = g.units.get(id); if (u && u.owner === f.owner) { f.lastSeen = g.time; break; } }
  }
  for (const [owner, list] of byCiv) {
    const civ = g.civs[owner];
    const rate = crewRate(civ) * tempo(g, 'trenchConstruction');
    let crews = trenchCrews(g, civ);
    // work in order: segments already under way, then the oldest project's next segments, then repairs
    let work = list.filter((f) => f.progress < 1 || f.upgrading).sort((a, b) => (b.paid - a.paid) || (a.project || 0) - (b.project || 0) || a.at - b.at || a.tile - b.tile);
    if (nativeRules(g)) {
      // Only each project's endpoint fronts may advance; a blocked front cannot be skipped.
      const fronts = new Set();
      for (const project of [...g.trenchProjects.values()].filter((p) => p.owner === owner).sort((a, b) => a.id - b.id)) {
        const remaining = (project.path || project.tiles).map((t) => g.fieldworks.get(t)).filter((f) => f && f.project === project.id && (f.progress < 1 || f.upgrading));
        if (remaining.length) fronts.add(remaining[0].tile);
        if (project.twoFronts && remaining.length > 1) fronts.add(remaining.at(-1).tile);
        project.fronts = [...fronts].filter((t) => g.fieldworks.get(t)?.project === project.id);
      }
      work = work.filter((f) => fronts.has(f.tile));
    }
    for (const f of work) {
      if (crews <= 0) { if (f.state === 'constructing') { f.state = 'queued'; changed = true; } continue; }
      const spec = f.upgrading ? UPGRADE : FIELDWORKS[f.type];
      if (!f.paid) {
        if (!g.canAfford(civ, spec.cost, f.tile)) { if (f.state !== 'materials') { f.state = 'materials'; changed = true; } continue; }
        g.pay(civ, spec.cost, f.tile, 'construction'); f.paid = true;
      }
      crews--;
      const before = STAGE(f.progress);
      f.progress = Math.min(1, f.progress + (rate * dt) / spec.time);
      f.state = f.progress >= 1 ? 'complete' : 'constructing';
      if (STAGE(f.progress) !== before || f.progress >= 1) changed = true;
      if (f.progress >= 1) { f.hp = MAX_HP; f.upgrading = false; f.lastSeen = g.time; }
    }
    for (const f of list) {
      if (f.progress < 1 || f.hp >= MAX_HP * 0.95 || crews <= 0) continue;
      // repair: cost and time by damage
      if (!f.repairing) { const c = { materials: Math.max(1, Math.ceil(REPAIR.cost.materials * (1 - f.hp / MAX_HP) * 2)) }; if (!g.canAfford(civ, c, f.tile)) continue; g.pay(civ, c, f.tile, 'maintenance'); f.repairing = true; }
      crews--;
      f.hp = Math.min(MAX_HP, f.hp + (MAX_HP * rate * dt) / (REPAIR.time - 2 * (f.hp / MAX_HP)));
      if (f.hp >= MAX_HP) { f.repairing = false; f.state = 'complete'; changed = true; }
    }
    // abandoned works weather slowly; plans that never got materials lapse after a long wait
    for (const f of list) {
      const idle = g.time - f.lastSeen;
      if (!f.paid && f.progress === 0 && idle > 600) { g.fieldworks.delete(f.tile); changed = true; continue; }
      if (f.progress >= 1 && idle > 900) { f.hp -= 0.03 * dt; if (f.hp <= 0) { g.fieldworks.delete(f.tile); changed = true; } }
    }
  }
  // projects: done when every segment is finished (or gone)
  for (const [id, pr] of g.trenchProjects) {
    const left = pr.tiles.filter((t) => { const f = g.fieldworks.get(t); return f && f.project === id && (f.progress < 1 || f.upgrading); }).length;
    const st = left ? (pr.tiles.some((t) => g.fieldworks.get(t)?.state === 'materials') ? 'materials' : 'constructing') : 'complete';
    if (st !== pr.status) { pr.status = st; changed = true; if (st === 'complete') { pr.done = g.time; const civ = g.civs[pr.owner]; if (civ?.human) g.notify(pr.owner, `Trench line completed (${pr.tiles.length} segment${pr.tiles.length === 1 ? '' : 's'}).`, { kind: 'build', tile: pr.tiles[Math.floor(pr.tiles.length / 2)], quiet: true, level: 'info' }); } }
    if (st === 'complete' && g.time - (pr.done || g.time) > 120) g.trenchProjects.delete(id);
  }
  if (changed) g.fwVer++;
}

export function trenchProjectsFor(g, civ) {
  const out = [];
  const crews = trenchCrews(g, civ), rate = crewRate(civ) * tempo(g, 'trenchConstruction');
  let ahead = 0;     // work queued in earlier projects is done first
  for (const pr of [...g.trenchProjects.values()].filter((p) => p.owner === civ.id).sort((a, b) => a.id - b.id)) {
    let done = 0, left = 0;
    for (const t of pr.tiles) { const f = g.fieldworks.get(t); if (!f || f.project !== pr.id) { done++; continue; } if (f.progress >= 1 && !f.upgrading) done++; else left += (1 - f.progress) * (f.upgrading ? UPGRADE.time : FIELDWORKS[f.type].time); }
    ahead += left;
    out.push({ id: pr.id, type: pr.type, total: pr.tiles.length, done, status: pr.status, eta: left ? Math.ceil(ahead / ((nativeRules(g) ? pr.twoFronts ? 2 : 1 : crews) * rate)) : 0, tiles: pr.tiles.slice(0, 120), by: pr.by, ...(nativeRules(g) ? { path: pr.path || pr.tiles, fronts: pr.fronts || [], stages: pr.tiles.map((t) => { const f = g.fieldworks.get(t); const p = f?.progress || 0; return [t, p >= 1 ? 'complete' : p >= .75 ? 'reinforcement' : p >= .4 ? 'deep_excavation' : p > 0 ? 'earth_removal' : 'survey']; }) } : {}) });
  }
  return { projects: out, crews };
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
    if (c.ruined) continue;
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

function updateTrenchRoutes(g) {
  const routes = new Map();
  if (nativeRules(g)) for (const pr of g.trenchProjects.values()) {
    const path = pr.path || pr.tiles;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if (!g.fieldworks.has(a) || !g.fieldworks.has(b)) continue;
      for (let d = 0; d < 6; d++) {
        if (NB[a * 6 + d] === b) routes.set(a, (routes.get(a) || 0) | (1 << d));
        if (NB[b * 6 + d] === a) routes.set(b, (routes.get(b) || 0) | (1 << d));
      }
    }
  }
  // Retain route topology on completed segments after project records expire.
  for (const [t, bits] of routes) g.fieldworks.get(t).route = bits;
}

export function fieldworksFor(g, civ, vis) {
  const out = [];
  for (const f of g.fieldworks.values()) if (f.owner === civ.id || vis[f.tile]) {
    let route = f.route || 0;
    for (let d = 0; d < 6; d++) if (!g.fieldworks.has(NB[f.tile * 6 + d])) route &= ~(1 << d);
    // Endpoints meeting existing works form a junction. Interior parallel lines stay separate.
    if (nativeRules(g) && (!route || (route & (route - 1)) === 0)) for (let d = 0; d < 6; d++) {
      const neighbor = g.fieldworks.get(NB[f.tile * 6 + d]);
      if (neighbor && neighbor.owner === f.owner && neighbor.project !== f.project) route |= 1 << d;
    }
    out.push([f.tile, f.owner, f.type === 'reinforced' && !f.upgrading ? 1 : 0, f.dir, Math.round(f.progress * 100), Math.round(f.hp), f.state === 'materials' ? 1 : f.state === 'queued' || f.state === 'planned' ? 2 : 0, f.upgrading ? 1 : 0, ...(nativeRules(g) ? [route] : [])]);
  }
  return out;
}

export function serializeFieldworks(g) { return { list: [...g.fieldworks.values()], projects: [...g.trenchProjects.values()], seq: g.trenchSeq || 0, urban: Buffer.from(g.urban.buffer, g.urban.byteOffset, g.urban.byteLength).toString('base64') }; }
export function restoreFieldworks(g, d) {
  fwInit(g);
  if (!d) return;
  for (const f of d.list || []) {
    // older saves: trenches dug by troops keep their full defensive value; unfinished ones join a project
    if (f.state === 'paused') f.state = 'queued';
    g.fieldworks.set(f.tile, f);
  }
  for (const p of d.projects || []) g.trenchProjects.set(p.id, p);
  g.trenchSeq = d.seq || 0;
  if (d.urban) { const buf = Buffer.from(d.urban, 'base64'); if (buf.length === N) g.urban.set(buf); }
}
void BUILDINGS;
