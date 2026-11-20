// Automatic base engineers (workstream B, 2026-11-16).
//
// Players no longer train engineers. Every base with an operational headquarters keeps its own team
// (2 / 3 / 4 by base tier). They walk out and build what the player places in the territory (field
// defenses, trench lines, roads, terrain works and new bases), repair damaged structures, and patch up
// idle vehicles near home. The player has no direct control: player commands skip them (actionGame
// .command) and the AI never drafts them. They can be killed; a base replaces a lost engineer for free
// every RESPAWN seconds. Engineers retreat home when hit unless the civ has Field Engineering.
//
// Units: u.auto = true, u.home = site id, u.job = job key ('b<id>' build/repair, 'f<tile>' trench,
// 'p<id>' road or terrain project, 'u<id>' vehicle) or null. Snapshot flag 4096 marks them.
import { N, T, isWater } from './constants.js';
import { disk, dist as hexDist, hexLine } from './hex.js';
import { ACTION_BUILDINGS, ACTION_UNITS, CAPTURE, RUIN_TYPES, TERRAIN_WORKS } from './actionDefinitions.js';
import { centerOf, distance, HEAVY_GROUND, tileAt } from './actionNavigation.js';
import { baseStreets, isBridgeSegment, planRing, ROAD_SEARCH } from './actionMap.js';
import { roadBuild } from './actionEconomy.js';
import { addFacility, canPay, connectSiteRoads, headquarters } from './actionBases.js';
import { moveGroup, stopUnit } from './actionOrders.js';
import { emit } from './combat.js';

export const ENGINEERS_BY_TIER = [2, 3, 4];
const RESPAWN = 25;
const BUILD_KINDS = new Set(['build', 'trench', 'road', 'terrain']);
const BASE_NAMES = ['Fort Haven', 'New Foundry', 'Bastion Rock', 'Far Crossing', 'Red Landing', 'High Ridge', 'Kestrel Field',
  'Eastgate', 'Westhold', 'Granite Point', 'Morrow Station', 'Lantern Hill'];

export const engineerQuota = (site) => ENGINEERS_BY_TIER[Math.max(0, Math.min(2, (site.tier || 1) - 1))];

function spawnEngineer(game, site, hq) {
  const u = game.spawn(game.civs[site.owner], 'engineer', hq, hq.radius + .38);
  if (!u) return null;
  u.auto = true; u.home = site.id; u.job = null; u.mode = 'guard';
  return u;
}

/** Fills a base's engineer team at once (a new or re-established headquarters). */
export function staffBase(game, site) {
  const hq = headquarters(game, site);
  if (!hq?.done || site.owner < 0) return;
  let have = 0;
  for (const u of game.units.values()) if (u.auto && u.hp > 0 && u.home === site.id && u.owner === site.owner) have++;
  for (let i = have; i < engineerQuota(site); i++) spawnEngineer(game, site, hq);
  site.engineerHq = hq.id; site.engineerAt = null;
}

function maintainEngineers(game) {
  const counts = new Map();
  for (const u of game.units.values()) if (u.auto && u.hp > 0) counts.set(u.home, (counts.get(u.home) || 0) + 1);
  for (const s of game.sites) {
    if (!s.slots || s.owner < 0) continue;
    const hq = headquarters(game, s);
    if (!hq?.done || !game.civs[s.owner]?.alive) continue;
    if (s.engineerHq !== hq.id) { staffBase(game, s); continue; }
    const have = counts.get(s.id) || 0, quota = engineerQuota(s);
    if (have >= quota) { s.engineerAt = null; continue; }
    if (s.engineerAt == null) s.engineerAt = game.time + RESPAWN;
    if (game.time < s.engineerAt) continue;
    spawnEngineer(game, s, hq);
    s.engineerAt = have + 1 < quota ? game.time + RESPAWN : null;
  }
}

// The base an engineer serves: its own, or (after its base fell) the nearest operational one.
function homeOf(game, u) {
  let s = game.siteById.get(u.home);
  if (s && s.owner === u.owner && headquarters(game, s)?.done) return s;
  s = null;
  for (const v of game.sites) if (v.slots && v.owner === u.owner && headquarters(game, v)?.done && (!s || distance(u, v) < distance(u, s))) s = v;
  if (s) u.home = s.id;
  return s;
}

const projectPoint = (game, p) => {
  if (p.kind === 'terrain') return terrainWorkPoint(p);
  const total = p.total || p.left || 1, i = Math.max(0, Math.min(p.edges.length - 1, Math.floor((1 - p.left / total) * p.edges.length)));
  const e = p.edges[i];
  return game.lerpPoint(centerOf(e.a), centerOf(e.b), .5);
};

// 2026-11-19 (user: "the engineers keep trying to go build old stuff in enemy territory and die"): build, repair, trench,
// road and terrain jobs on ground a hostile civ now holds are not offered, and a job within reach of a visible hostile
// armed unit or finished defense is marked dangerous and not taken (repairs at the engineer's own base excepted, see
// pickJob). Nothing is cancelled: the work is picked up again once the ground is retaken or the threat has gone.
const DANGER_PAD = 1.6;
function threatsFor(game, civ) {
  const out = [], seen = civ.visible;
  for (const v of game.units.values()) {
    if (v.hp <= 0 || !game.hostile(v.owner, civ.id)) continue;
    const d = ACTION_UNITS[v.type];
    if (!d?.atk || d.air || v.type === 'engineer') continue;
    if (seen && !seen[tileAt(v.x, v.z)]) continue;
    out.push(v.x, v.z, Math.min(4.2, Math.max(2.2, d.range || 0)) + DANGER_PAD);   // long-range guns: only their near reach counts
  }
  for (const b of game.buildings.values()) {
    if (b.hp <= 0 || !b.done || !game.hostile(b.owner, civ.id)) continue;
    const d = ACTION_BUILDINGS[b.type];
    if (!d?.attack || b.type === 'aa_battery') continue;
    if (seen && !seen[tileAt(b.x, b.z)]) continue;
    out.push(b.x, b.z, Math.min(4.2, d.range || 2) + DANGER_PAD);
  }
  return out;
}
const hostileGround = (game, civ, x, z) => { const o = game.world.owner[tileAt(x, z)]; return o >= 0 && game.hostile(o, civ.id); };
function underThreat(game, threats, x, z) {
  for (let i = 0; i < threats.length; i += 3) {
    const r = threats[i + 2];
    if (Math.abs(game.dx(threats[i], x)) > r || Math.abs(threats[i + 1] - z) > r) continue;
    if (distance({ x: threats[i], z: threats[i + 1] }, { x, z }) <= r) return true;
  }
  return false;
}
const dangerous = (j, hq) => j.danger && !(hq && (j.kind === 'repair' || j.kind === 'fix') && distance(hq, j) <= hq.radius + 3);

function jobsFor(game, civ) {
  const jobs = [], threats = threatsFor(game, civ);
  for (const j of rawJobsFor(game, civ)) {
    if (j.kind !== 'fix' && hostileGround(game, civ, j.x, j.z)) continue;
    if (threats.length && underThreat(game, threats, j.x, j.z)) j.danger = true;
    jobs.push(j);
  }
  return jobs;
}

function rawJobsFor(game, civ) {
  const jobs = [];
  for (const b of game.buildings.values()) {
    if (b.owner !== civ.id || b.hp <= 0) continue;
    const def = ACTION_BUILDINGS[b.type];
    if (!b.done) { if (def.field && !b.perimeterSlot) jobs.push({ key: 'b' + b.id, kind: 'build', x: b.x, z: b.z, reach: b.radius + .5, target: b }); }
    else if (b.hp < b.maxHp - 1 && b.project?.kind !== 'repair') jobs.push({ key: 'b' + b.id, kind: 'repair', x: b.x, z: b.z, reach: b.radius + .55, target: b });
  }
  for (const f of game.fieldworks.values()) if (f.owner === civ.id && f.progress < 1)
    jobs.push({ key: 'f' + f.tile, kind: 'trench', x: f.x, z: f.z, reach: .45, target: f });
  for (const p of game.roadProjects) {
    if (p.owner !== civ.id || p.auto || !p.edges) continue;
    if (p.kind !== 'terrain' && !p.edges.length) continue;
    p.id ??= game.id_();
    p.total ??= p.left;
    const point = projectPoint(game, p);
    jobs.push({ key: 'p' + p.id, kind: p.kind === 'terrain' ? 'terrain' : 'road', x: point.x, z: point.z, reach: p.kind === 'terrain' ? .9 : .75, target: p });
  }
  for (const v of game.units.values()) {
    const d = ACTION_UNITS[v.type];
    if (v.owner !== civ.id || v.hp <= 0 || v.hp >= v.maxHp * .97 || d.air || (d.move !== 'tracked' && d.move !== 'wheeled') || v.goal) continue;
    if (game.time - v.lastCombat < 4) continue;
    jobs.push({ key: 'u' + v.id, kind: 'fix', x: v.x, z: v.z, reach: v.radius + .42, target: v });
  }
  return jobs;
}

// Pass 5: a build job much nearer another of the civ's bases is left to that base's team (by more than FAR_JOB_SLACK).
// pickJob had no distance bound for build jobs: an engineer was seen walking ~170 units across the map, a long route
// request and a long exposed march, while the job's own base had engineers to spare.
const FAR_JOB_SLACK = 8;
function pickJob(game, u, hq, jobs, load, homes = null) {
  let best = null, score = Infinity;
  for (const j of jobs) {
    if (u.skip === j.key && u.skipUntil > game.time) continue;
    if (dangerous(j, hq)) continue;
    const n = load.get(j.key) || 0;
    if (n >= (j.kind === 'fix' || j.kind === 'trench' ? 1 : 3)) continue;
    const fromHome = hq ? distance(hq, j) : 0;
    if (j.kind === 'fix' && fromHome > 9 || j.kind === 'repair' && fromHome > 14) continue;
    if (hq && homes && homes.length > 1 && BUILD_KINDS.has(j.kind)) {
      if (j.nearHome === undefined) { let m = Infinity; for (const h of homes) m = Math.min(m, distance(h, j)); j.nearHome = m; }
      if (fromHome > j.nearHome + FAR_JOB_SLACK) continue;
    }
    const s = distance(u, j) + fromHome * .5 + n * 4 - (BUILD_KINDS.has(j.kind) ? 1.5 : 0);
    if (s < score) { score = s; best = j; }
  }
  return best;
}

function goNear(game, u, target, reach) {
  const angle = Math.atan2(game.dx(target.x, u.x), u.z - target.z);
  const p = game.nav.nearest({ x: target.x + Math.sin(angle) * reach * .8, z: target.z + Math.cos(angle) * reach * .8 }, ACTION_UNITS.engineer, .9);
  return !!p && !moveGroup(game, [u], p, { mode: 'move' }).error;
}

/** A field structure finished by the engineers. A finished New Base becomes a real base site. */
export function completeField(game, b) {
  const def = ACTION_BUILDINGS[b.type];
  b.done = true; b.progress = 1; b.state = 'operational';
  game.ruins.delete(b.tile);
  game.world.touch(b.tile);
  if (def.claims) game.territoryDirty = true;
  if (def.newBase) foundBase(game, b);
}

function work(game, civ, u, job, working, dt) {
  const n = working.get(job.key) || 0;
  working.set(job.key, n + 1);
  const rate = n ? .6 : 1, t = job.target;
  if (job.kind === 'build') {
    if (t.done) return;
    const add = Math.min(1 - t.progress, dt * rate / t.buildTime);
    t.progress += add;
    t.hp = Math.min(t.maxHp, t.hp + t.maxHp * .66 * add);
    if (t.progress >= .999999) completeField(game, t);
  } else if (job.kind === 'repair') t.hp = Math.min(t.maxHp, t.hp + dt * 13 * (game.time - (t.hitAt ?? -99) < 5 ? .4 : 1)); // W2: slower under fire
  else if (job.kind === 'fix') t.hp = Math.min(t.maxHp, t.hp + dt * 4.5);
  else if (job.kind === 'trench') {
    // a dug section takes ~4 s; an engineer digs every unfinished section within reach of the spade
    for (const tile of disk(tileAt(u.x, u.z), 1)) {
      const f = game.fieldworks.get(tile);
      if (!f || f.owner !== civ.id || f.progress >= 1 || distance(u, f) > 1.3) continue;
      f.progress = Math.min(1, f.progress + dt / 4);
      if (f.progress >= .99999) { f.progress = 1; f.state = 'built'; game.territoryDirty = true; }
    }
  } else {
    t.left = Math.max(0, t.left - dt * rate);   // road or terrain project: completed by fieldEconomyStep
    if (t.kind === 'terrain') advanceTerrain(game, t);   // a brush stroke is reshaped step by step as the engineers move along it
  }
}

function runEngineer(game, civ, u, jobs, byKey, load, working, dt, homes = null) {
  u.assisting = false;
  const home = homeOf(game, u), hq = home ? headquarters(game, home) : null;
  const hardened = civ.techs.has('field_engineering');
  if (!hardened && game.time - (u.hitAt ?? -99) < 2.5) {
    // the job that got it shot is avoided for a minute instead of being walked straight back into
    if (u.job) { load.set(u.job, Math.max(0, (load.get(u.job) || 1) - 1)); u.skip = u.job; u.skipUntil = game.time + 60; }
    u.job = null; u.retreatUntil = game.time + 6;
  }
  if (u.retreatUntil > game.time) {
    if (hq && !u.goal && distance(u, hq) > hq.radius + 1.3) goNear(game, u, hq, hq.radius + 1.1);
    return;
  }
  let job = u.job ? byKey.get(u.job) : null;
  if (job && dangerous(job, hq)) {             // the way or the site turned dangerous: drop it and pick something safe
    load.set(job.key, Math.max(0, (load.get(job.key) || 1) - 1));
    job = null; if (u.goal) stopUnit(game, u);
  }
  if (!job) {
    u.job = null;
    job = pickJob(game, u, hq, jobs, load, homes);
    if (job) { u.job = job.key; u.jobAt = game.time; load.set(job.key, (load.get(job.key) || 0) + 1); }
  }
  if (!job) {
    if (hq && !u.goal && distance(u, hq) > hq.radius + 2.2) goNear(game, u, hq, hq.radius + 1.1);
    else if (!u.goal) u.mode = 'guard';
    return;
  }
  if (distance(u, job) <= job.reach) {
    if (u.goal) stopUnit(game, u);
    u.mode = 'guard'; u.assisting = true; u.jobAt = game.time;
    u.yaw = Math.atan2(game.dx(u.x, job.x), job.z - u.z);
    work(game, civ, u, job, working, dt);
    return;
  }
  if (game.time - u.jobAt > 45) {             // stuck on the way: give the job up for a while
    u.skip = job.key; u.skipUntil = game.time + 20; u.job = null; if (u.goal) stopUnit(game, u); return;
  }
  if (!u.goal || distance(u.goal, job) > job.reach + .35) {
    if (!goNear(game, u, job, job.reach)) { u.skip = job.key; u.skipUntil = game.time + 15; u.job = null; }
  }
}

// Field Engineering: idle damaged vehicles patch themselves up to 70%. Improved Logistics haste ends
// once a reinforcement has reached its rally point.
function fieldUpkeep(game, dt) {
  for (const u of game.units.values()) {
    if (u.hasteUntil && (!u.goal || u.hasteUntil <= game.time)) u.hasteUntil = 0;
    const d = ACTION_UNITS[u.type];
    if (d.air || (d.move !== 'tracked' && d.move !== 'wheeled') || u.hp >= u.maxHp * .7 || u.hp <= 0) continue;
    if (game.civs[u.owner]?.techs.has('field_engineering')) u.hp = Math.min(u.maxHp * .7, u.hp + dt * 1.2);
  }
}

/** Automatic engineers: staffing every ~1 s, jobs every call (fieldEconomyStep, every 2 ticks). */
export function engineerStep(game, dt) {
  if (game.tickN % 10 < 2) maintainEngineers(game);
  const byCiv = new Map();
  for (const u of game.units.values()) {
    if (!u.auto || u.hp <= 0) continue;
    let list = byCiv.get(u.owner);
    if (!list) byCiv.set(u.owner, list = []);
    list.push(u);
  }
  for (const [owner, list] of byCiv) {
    const civ = game.civs[owner];
    if (!civ?.alive) continue;
    const jobs = jobsFor(game, civ), byKey = new Map(jobs.map((j) => [j.key, j])), load = new Map(), working = new Map();
    for (const u of list) if (u.job && byKey.has(u.job)) load.set(u.job, (load.get(u.job) || 0) + 1);
    // the civ's staffed headquarters (bases with engineers of their own), for pickJob's far-job rule
    const staffed = new Set(list.map((u) => u.home)), homes = [];
    for (const s of game.sites) if (s.slots && s.owner === owner && staffed.has(s.id)) { const hq = headquarters(game, s); if (hq?.done) homes.push(hq); }
    for (const u of list) runEngineer(game, civ, u, jobs, byKey, load, working, dt, homes);
  }
  fieldUpkeep(game, dt);
}

// ---- new bases -------------------------------------------------------------------------------

/** Ring layout for a new base at tile, or an error. Shared by placement and completion. */
export function newBaseRing(game, tile) {
  const id = game.sites.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  const ring = planRing(game.world, tile, game.seed, id);
  if (!ring || ring.length !== 8) return { error: 'A new base needs level, dry ground for its whole building ring.' };
  for (const p of ring) {
    if (game.reservedTiles.has(p.tile) || game.fieldworks.has(p.tile)) return { error: 'The building ring overlaps another base or a trench.' };
    if (game.obstaclesAtTile(p.tile).some((b) => b.type !== 'base_site' && distance(b, p) < b.radius + .55)) return { error: 'Structures stand where the building ring would go.' };
  }
  return { id, ring };
}

function foundBase(game, b) {
  const civ = game.civs[b.owner], tile = b.tile, c = centerOf(tile);
  game.removeBuilding(b);
  const plan = newBaseRing(game, tile);
  if (plan.error) {
    civ.res.materials += ACTION_BUILDINGS.base_site.cost.materials;
    game.notify(civ.id, `New base abandoned: ${plan.error} Materials refunded.`, { kind: 'warning', tile });
    return null;
  }
  const { id, ring } = plan, kind = RUIN_TYPES[0];
  const used = new Set(game.sites.map((s) => s.name));
  const name = BASE_NAMES.find((n) => !used.has(n)) || `Forward Base ${id}`;
  const site = { id, tile, x: c.x, z: c.z, name, kind: kind.key, ruin: kind.ruin, radius: 1.35, captureTime: CAPTURE.base, owner: civ.id, by: -1,
    progress: 0, last: 0, contested: false, hq: 0, tier: 1, slots: [...ring].sort((a, b) => a.tier - b.tier || a.index - b.index).map((p) => p.id),
    core: 4, ringVersion: 1, developedAt: game.time, visualTier: 1, founded: true, reclaimed: true, everEstablished: true, claimedAt: game.time,
    parcels: [{ id: 0, index: -1, tile, x: c.x, z: c.z, yaw: ring[0].yaw, tier: 1, width: 1.12, depth: 1.12 }, ...ring] };
  game.setSites([...game.sites, site]);
  addFacility(game, civ, site, 'town', tile, { instant: true });
  // 2026-11-18 (ROADS_AND_CLAIMS.md): its own compound streets, laid with the headquarters
  for (const e of baseStreets(game, site)) game.roads.set(e.a, e.b, 2);
  game.nav.invalidate();
  staffBase(game, site);
  game.refreshTerritory();
  connectSiteRoads(game, site);
  emit(game, { k: 'found', b: tile, bx: site.x, bz: site.z, ow: civ.id, site: id });
  game.notify(civ.id, `${name} founded: a new headquarters is operational.`, { kind: 'city', tile, site: id, level: 'major' });
  return site;
}

// ---- terrain works ---------------------------------------------------------------------------

/** W2 (2026-11-17): terrain works go on your own territory or, with TERRAIN_WORKS.neutral, on neutral ground;
 *  never on another player's land. Neutral ground must be in sight (refusal: 'hidden'). */
const workable = (game, civ, t) => { const o = game.world.owner[t]; return o === civ.id || !!TERRAIN_WORKS.neutral && o < 0; };

function editable(game, civ, t) {
  const w = game.world;
  return t >= 0 && t < N && workable(game, civ, t) && !isWater(w.terr[t]) && !w.lake[t] && !w.river[t] && w.terr[t] < T.MOUNTAIN &&
    !game.reservedTiles.has(t) && !game.buildingAtTile(t) && !game.fieldworks.has(t);
}

/** Why a hex cannot be reshaped by this civ ('territory' | 'hidden' | 'ground'), or null when it can. */
function refusal(game, civ, t) {
  if (t < 0 || t >= N || !workable(game, civ, t)) return 'territory';
  if (civ.visible && !civ.visible[t]) return 'hidden';
  return editable(game, civ, t) ? null : 'ground';
}

const TERRAIN_REASONS = {
  territory: 'Terrain can only be reshaped in your own territory or on neutral ground.',
  hidden: 'Paint over ground you can see.',
  ground: 'Choose open dry ground: not water, mountains, bases, structures or trenches.',
  busy: 'Engineers are already reshaping that ground.',
};

/**
 * The hexes a brush stroke paints: the stroke's centre hexes in drawing order (consecutive points joined by hex
 * lines, so a fast drag leaves no gaps), each widened to `radius`, deduplicated and capped at maxHexes.
 */
export function terrainStroke(points, radius, maxHexes = TERRAIN_WORKS.maxHexes) {
  const centres = [];
  let last = -1;
  for (const p of points) {
    const t = tileAt(p.x, p.z);
    if (t < 0) continue;
    for (const s of last >= 0 && last !== t ? hexLine(last, t) : [t]) if (s !== centres[centres.length - 1] && !centres.includes(s)) centres.push(s);
    last = t;
  }
  const tiles = [], seen = new Set();
  let truncated = false;
  for (const c of centres) {
    for (const t of disk(c, radius)) {
      if (seen.has(t)) continue;
      if (tiles.length >= maxHexes) { truncated = true; break; }
      seen.add(t); tiles.push(t);
    }
    if (truncated) break;
  }
  return { centres, tiles, truncated };
}

/**
 * Command `terrain`: queue terrain works for the engineers (or preview them).
 * Brush stroke: `points` (world points along the drag, ≤72) and `radius` (0..maxRadius, default 1); every hex
 * within `radius` of the stroke that can be reshaped is painted, the others are skipped (listed in `refused`).
 * Legacy single point: `point` only; reshapes the 7 hexes around it for the flat cost, refused as a whole when the
 * centre cannot be reshaped or overlaps works under way.
 */
export function terrainOrder(game, civ, op, point, preview = false, stroke = null, radius = 1) {
  const W = TERRAIN_WORKS;
  const legacy = !Array.isArray(stroke) || !stroke.length;
  const points = legacy ? (point ? [point] : []) : stroke;
  if (!W.ops.includes(op) || !points.length) return { error: 'Choose raise, lower, flatten or smooth, and a location.' };
  for (let i = 1; i < points.length; i++) if (distance(points[i - 1], points[i]) > 38) return { error: 'Paint a shorter stroke.' };
  const r = legacy ? 1 : Math.max(0, Math.min(W.maxRadius ?? 2, Math.round(Number.isFinite(radius) ? radius : 1)));
  const { centres, tiles: footprint, truncated } = terrainStroke(points, r, W.maxHexes ?? 60);
  const first = centres[0] ?? -1;
  const busy = new Set();
  for (const p of game.roadProjects) if (p.kind === 'terrain') for (const t of p.tiles) busy.add(t);
  if (legacy) {
    // unchanged single-point rules (whole order refused)
    if (first < 0 || !workable(game, civ, first)) return { error: TERRAIN_REASONS.territory, code: 'territory' };
    if (game.world.owner[first] !== civ.id && civ.visible && !civ.visible[first]) return { error: TERRAIN_REASONS.hidden, code: 'hidden' };
    if (!editable(game, civ, first)) return { error: TERRAIN_REASONS.ground, code: 'ground' };
    if (footprint.some((t) => busy.has(t) && editable(game, civ, t))) return { error: TERRAIN_REASONS.busy, code: 'busy' };
  }
  const tiles = [], refused = [], why = {};
  for (const t of footprint) {
    const no = busy.has(t) ? 'busy' : refusal(game, civ, t);
    // a legacy point order may include fogged hexes of your own territory (never fogged neutral ground)
    if (no && !(legacy && no === 'hidden' && game.world.owner[t] === civ.id)) { refused.push(t); why[no] = (why[no] || 0) + 1; }
    else tiles.push(t);
  }
  if (!tiles.length) {
    const code = why.territory && !why.ground && !why.busy && !why.hidden ? 'territory' : why.busy ? 'busy' : why.hidden && !why.ground ? 'hidden' : 'ground';
    return { error: TERRAIN_REASONS[code], code };
  }
  if (game.roadProjects.filter((p) => p.kind === 'terrain' && p.owner === civ.id).length >= 6) return { error: 'Finish an existing terrain project first.' };
  const cost = legacy ? W.cost : { materials: Math.max(W.minCost ?? 10, Math.round(tiles.length * W.cost.materials / 7)) };
  const seconds = legacy ? W.time : Math.round(W.time * Math.max(1, tiles.length / 7) * 10) / 10;
  const plan = { op, tile: first, tiles, refused, cost, seconds, radius: r, truncated: truncated || undefined };
  if (preview) return { reply: { t: 'ack', terrain: { ...plan, afford: canPay(civ, cost) } } };
  if (!canPay(civ, cost)) return { error: `Terrain works require ${cost.materials} Materials.` };
  civ.res.materials -= cost.materials;
  // the engineers work through the stroke in drawing order: each centre hex with the brush hexes it adds
  const valid = new Set(tiles), assigned = new Set(), steps = [];
  for (const c of centres) {
    const group = disk(c, r).filter((t) => valid.has(t) && !assigned.has(t));
    for (const t of group) assigned.add(t);
    if (group.length) steps.push({ t: c, tiles: group });
  }
  // full step on the stroke itself, easing to half a step at the brush edge (a single point: centre 1, ring .5)
  const weights = tiles.map((t) => { let d = r; for (const c of centres) d = Math.min(d, hexDist(t, c)); return 1 - .5 * d / Math.max(1, r); });
  game.roadProjects.push({ id: game.id_(), owner: civ.id, kind: 'terrain', op, tile: first, tiles, weights, steps, applied: 0,
    level: game.world.elev[first], point: centerOf(steps[0]?.t ?? first), edges: [], left: seconds, total: seconds,
    label: 'Terrain works complete.' });
  return { hexes: tiles.length, skipped: refused.length, cost };
}

/** The point the engineers work at: the stroke step matching the project's progress. */
export function terrainWorkPoint(p) {
  if (!p.steps?.length) return p.point;
  const k = Math.max(0, Math.min(p.steps.length - 1, Math.floor((1 - p.left / (p.total || 1)) * p.steps.length)));
  return centerOf(p.steps[k].t);
}

/** Applies the stroke steps the engineers have finished (all of them once the project completes). */
export function advanceTerrain(game, p, all = false) {
  if (!p.steps?.length) return;
  const done = all ? p.steps.length : Math.floor((1 - p.left / (p.total || 1)) * p.steps.length);
  if (done <= (p.applied || 0)) return;
  const tiles = [];
  for (let i = p.applied || 0; i < done; i++) tiles.push(...p.steps[i].tiles);
  p.applied = done;
  reshape(game, p, tiles);
}

/** Applies a finished terrain work: every hex not yet reshaped (a legacy point: the centre a full step, the ring half). */
export function applyTerrain(game, p) {
  if (p.steps?.length) { advanceTerrain(game, p, true); return; }
  reshape(game, p, p.tiles);
}

function reshape(game, p, list) {
  const w = game.world, W = TERRAIN_WORKS, civ = game.civs[p.owner];
  const weight = new Map(p.tiles.map((t, i) => [t, p.weights?.[i] ?? (t === p.tile ? 1 : .5)]));
  const tiles = list.filter((t) => editable(game, civ, t) || t === p.tile && !isWater(w.terr[t]) && !w.river[t]);
  if (!tiles.length) return;
  const before = new Map(tiles.map((t) => [t, w.elev[t]]));
  // flatten levels to the stroke's first hex as it was when ordered (a legacy point: its centre now)
  const level = p.steps?.length ? p.level ?? w.elev[p.tile] : w.elev[p.tile];
  for (const t of tiles) {
    const e0 = before.get(t), k = weight.get(t) ?? .5;
    let e = e0;
    if (p.op === 'raise') e += W.step * k;
    else if (p.op === 'lower') e -= W.step * k;
    else if (p.op === 'flatten') e = level;
    else {
      const around = disk(t, 1).filter((n) => n !== t && !isWater(w.terr[n]) && !w.lake[n]);
      if (around.length) e = (e0 + around.reduce((s, n) => s + (before.get(n) ?? w.elev[n]), 0) / around.length) / 2;
    }
    w.elev[t] = Math.max(Math.min(W.min, e0), Math.min(Math.max(W.max, e0), e));
    w.classify(t); w.touch(t);
  }
  game.nav.invalidate();
}

// --- roadRouteBetween (NAV_BRIDGES.md, 2026-11-18) ---------------------------------------------------------------
// Matches start without bridges: a wide river (flow >= 94) stops every vehicle until a road with its bridge is built
// across it. This plans the road between two points with the road planner (heavy-vehicle ground, rivers bridged,
// never across open water or a lake) and orders it exactly as a player's road stroke (actionEconomy.roadBuild): the
// same visibility, territory, hostile-compound, foundation and structure rules, the same price (ROAD_EDGE_COST a
// segment, ROAD_BRIDGE_COST a bridge segment), the same per-player project limit, and it is built by the base
// engineers. For the AI (and tests); players draw strokes.
/** Longest road roadRouteBetween orders in one project (segments); the same cap as a drawn stroke. */
export const ROAD_ROUTE_MAX = 120;
/**
 * roadRouteBetween(game, civ, from, to, { preview = false } = {})
 *   from, to: tile indices or points { x, z }.
 * Returns { ok: true, edges, bridges, skipped, cost: { materials }, route: [tiles] } (preview: nothing is paid or
 * queued), or { error, code } with code 'points' | 'route' | 'length' | 'funds' | 'projects' | a roadBuild refusal
 * code ('territory', 'foundation', 'blocked', 'hidden', 'hostile', 'built').
 */
export function roadRouteBetween(game, civ, from, to, { preview = false } = {}) {
  const point = (p) => (typeof p === 'number' ? (p >= 0 && p < N ? centerOf(p) : null) : p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: p.x, z: p.z } : null);
  const a = point(from), b = point(to);
  const ta = a ? tileAt(a.x, a.z) : -1, tb = b ? tileAt(b.x, b.z) : -1;
  if (!civ || ta < 0 || tb < 0) return { error: 'Choose two points on the map for the road.', code: 'points' };
  if (ta === tb) return { error: 'Choose two points farther apart for the road.', code: 'points' };
  const route = game.nav.strategic(ta, tb, HEAVY_GROUND, true, false, ROAD_SEARCH);
  if (!route) return { error: 'No suitable road or bridge route connects those locations.', code: 'route' };
  if (route.length - 1 > ROAD_ROUTE_MAX) return { error: `That road would be ${route.length - 1} segments: build it in sections of at most ${ROAD_ROUTE_MAX}.`, code: 'length' };
  // the planned tiles as a stroke: each step is one hex edge, so roadBuild lays exactly this route
  const r = roadBuild(game, civ, route.map(centerOf), preview);
  const w = game.world;
  if (preview) {
    const road = r.reply?.road;
    if (!road || r.error) return { error: r.error || 'No suitable road or bridge route connects those locations.', code: r.code || 'route' };
    return { ok: true, preview: true, edges: road.positions.length, bridges: road.positions.filter((e) => isBridgeSegment(w, e.a, e.b)).length,
      skipped: road.skipped.length, cost: road.cost, route };
  }
  if (r.error) {
    const code = r.code || (/requires d+ Materials/.test(r.error) ? 'funds' : /Finish an existing road project/.test(r.error) ? 'projects'
      : /already has an operational/.test(r.error) ? 'built' : 'route');
    return { error: r.error, code };
  }
  const project = game.roadProjects[game.roadProjects.length - 1];
  const bridges = project?.edges ? project.edges.filter((e) => isBridgeSegment(w, e.a, e.b)).length : 0;
  return { ok: true, edges: r.edges, bridges, skipped: r.skipped, cost: r.cost, route };
}
