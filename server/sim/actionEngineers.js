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
import { disk } from './hex.js';
import { ACTION_BUILDINGS, ACTION_UNITS, RUIN_TYPES, TERRAIN_WORKS } from './actionDefinitions.js';
import { centerOf, distance, tileAt } from './actionNavigation.js';
import { planRing } from './actionMap.js';
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
  if (p.kind === 'terrain') return p.point;
  const total = p.total || p.left || 1, i = Math.max(0, Math.min(p.edges.length - 1, Math.floor((1 - p.left / total) * p.edges.length)));
  const e = p.edges[i];
  return game.lerpPoint(centerOf(e.a), centerOf(e.b), .5);
};

function jobsFor(game, civ) {
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

function pickJob(game, u, hq, jobs, load) {
  let best = null, score = Infinity;
  for (const j of jobs) {
    if (u.skip === j.key && u.skipUntil > game.time) continue;
    const n = load.get(j.key) || 0;
    if (n >= (j.kind === 'fix' || j.kind === 'trench' ? 1 : 3)) continue;
    const fromHome = hq ? distance(hq, j) : 0;
    if (j.kind === 'fix' && fromHome > 9 || j.kind === 'repair' && fromHome > 14) continue;
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
  } else t.left = Math.max(0, t.left - dt * rate);   // road or terrain project: completed by fieldEconomyStep
}

function runEngineer(game, civ, u, jobs, byKey, load, working, dt) {
  u.assisting = false;
  const home = homeOf(game, u), hq = home ? headquarters(game, home) : null;
  const hardened = civ.techs.has('field_engineering');
  if (!hardened && game.time - (u.hitAt ?? -99) < 2.5) {
    if (u.job) load.set(u.job, Math.max(0, (load.get(u.job) || 1) - 1));
    u.job = null; u.retreatUntil = game.time + 6;
  }
  if (u.retreatUntil > game.time) {
    if (hq && !u.goal && distance(u, hq) > hq.radius + 1.3) goNear(game, u, hq, hq.radius + 1.1);
    return;
  }
  let job = u.job ? byKey.get(u.job) : null;
  if (!job) {
    u.job = null;
    job = pickJob(game, u, hq, jobs, load);
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
    for (const u of list) runEngineer(game, civ, u, jobs, byKey, load, working, dt);
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
  const site = { id, tile, x: c.x, z: c.z, name, kind: kind.key, ruin: kind.ruin, radius: 1.35, captureTime: 16, owner: civ.id, by: -1,
    progress: 0, last: 0, contested: false, hq: 0, tier: 1, slots: [...ring].sort((a, b) => a.tier - b.tier || a.index - b.index).map((p) => p.id),
    core: 4, ringVersion: 1, developedAt: game.time, visualTier: 1, founded: true, reclaimed: true, everEstablished: true, claimedAt: game.time,
    parcels: [{ id: 0, index: -1, tile, x: c.x, z: c.z, yaw: ring[0].yaw, tier: 1, width: 1.12, depth: 1.12 }, ...ring] };
  game.setSites([...game.sites, site]);
  addFacility(game, civ, site, 'town', tile, { instant: true });
  staffBase(game, site);
  game.refreshTerritory();
  connectSiteRoads(game, site);
  emit(game, { k: 'found', b: tile, bx: site.x, bz: site.z, ow: civ.id, site: id });
  game.notify(civ.id, `${name} founded: a new headquarters is operational.`, { kind: 'city', tile, site: id, level: 'major' });
  return site;
}

// ---- terrain works ---------------------------------------------------------------------------

function editable(game, civ, t) {
  const w = game.world;
  return t >= 0 && t < N && w.owner[t] === civ.id && !isWater(w.terr[t]) && !w.lake[t] && !w.river[t] && w.terr[t] < T.MOUNTAIN &&
    !game.reservedTiles.has(t) && !game.buildingAtTile(t) && !game.fieldworks.has(t);
}

/** Command `terrain`: queue a terrain work for the engineers (or preview it). */
export function terrainOrder(game, civ, op, point, preview = false) {
  const W = TERRAIN_WORKS;
  if (!W.ops.includes(op) || !point) return { error: 'Choose raise, lower, flatten or smooth, and a location.' };
  const tile = tileAt(point.x, point.z);
  if (tile < 0 || game.world.owner[tile] !== civ.id) return { error: 'Terrain can only be reshaped inside your own territory.' };
  if (!editable(game, civ, tile)) return { error: 'Choose open dry ground: not water, mountains, bases, structures or trenches.' };
  const tiles = disk(tile, 1).filter((t) => editable(game, civ, t));
  if (game.roadProjects.some((p) => p.kind === 'terrain' && p.tiles.some((t) => tiles.includes(t)))) return { error: 'Engineers are already reshaping that ground.' };
  if (game.roadProjects.filter((p) => p.kind === 'terrain' && p.owner === civ.id).length >= 6) return { error: 'Finish an existing terrain project first.' };
  if (!canPay(civ, W.cost)) return { error: `Terrain works require ${W.cost.materials} Materials.` };
  if (preview) return { reply: { t: 'ack', terrain: { op, tile, tiles, cost: W.cost, seconds: W.time } } };
  civ.res.materials -= W.cost.materials;
  game.roadProjects.push({ id: game.id_(), owner: civ.id, kind: 'terrain', op, tile, tiles, point: centerOf(tile), edges: [], left: W.time, total: W.time,
    label: 'Terrain works complete.' });
  return {};
}

/** Applies a finished terrain work: the centre moves a full step, the ring half a step. */
export function applyTerrain(game, p) {
  const w = game.world, W = TERRAIN_WORKS, civ = game.civs[p.owner];
  const tiles = p.tiles.filter((t) => editable(game, civ, t) || t === p.tile && !isWater(w.terr[t]) && !w.river[t]);
  const before = new Map(tiles.map((t) => [t, w.elev[t]])), centre = w.elev[p.tile];
  for (const t of tiles) {
    const e0 = before.get(t), k = t === p.tile ? 1 : .5;
    let e = e0;
    if (p.op === 'raise') e += W.step * k;
    else if (p.op === 'lower') e -= W.step * k;
    else if (p.op === 'flatten') e = centre;
    else {
      const around = disk(t, 1).filter((n) => n !== t && !isWater(w.terr[n]) && !w.lake[n]);
      if (around.length) e = (e0 + around.reduce((s, n) => s + (before.get(n) ?? w.elev[n]), 0) / around.length) / 2;
    }
    w.elev[t] = Math.max(Math.min(W.min, e0), Math.min(Math.max(W.max, e0), e));
    w.classify(t); w.touch(t);
  }
  game.nav.invalidate();
}
