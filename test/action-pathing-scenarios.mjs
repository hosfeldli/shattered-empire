// Reproducible movement scenarios for the action RTS (workstream C, 2026-11-16).
// Each scenario paints a controlled patch of terrain (flat grass, a river with one road bridge, a lake,
// a mountain, terrain strips) far from the generated landmass, or uses a real developed base, then
// issues an ordinary player order and measures what the group actually did:
//   stuck   - units that never reached the destination area
//   ratio   - distance each unit drove / the shortest passable route for its movement class
//   spread  - seconds between the first and the last arrival
// Used by test/action-pathing.test.js (assertions) and by bench scripts (before/after numbers).
// Import only after setting globalThis.SE_MAP_SIZE / SE_WRAP (the sim reads them at load).

const root = new URL('../server/sim/', import.meta.url);
const load = (file) => import(new URL(file, root).href);

export async function loadSim() {
  const [{ ActionGame }, defs, nav, constants, hex, world, bases, orders] = await Promise.all([
    load('actionGame.js'), load('actionDefinitions.js'), load('actionNavigation.js'), load('constants.js'), load('hex.js'), load('world.js'),
    load('actionBases.js'), load('actionOrders.js')]);
  return { ActionGame, ACTION_UNITS: defs.ACTION_UNITS, ...nav, T: constants.T, W: constants.W, H: constants.H, N: constants.N, DT: constants.DT,
    isWater: constants.isWater, NB: hex.NB, disk: hex.disk, MinHeap: world.MinHeap, bases, orders };
}

export function makeGame(sim, seed = 9) {
  const g = new sim.ActionGame({ id: 'pathing-' + seed, seed, style: 'pangaea', slots: [{ human: true }, { human: true }] });
  g.tick(); g.outbox.length = 0;
  return g;
}

const tileOf = (sim, r, c) => r * sim.W + c;

/** Paint a flat, empty grass rectangle (rows x cols, offset coordinates) and return a helper for it. */
export function paintArea(sim, g, r0, c0, rows, cols) {
  const w = g.world, tiles = [];
  for (let r = r0; r < r0 + rows; r++) for (let c = c0; c < c0 + cols; c++) {
    const t = tileOf(sim, r, c);
    tiles.push(t);
    w.terr[t] = sim.T.GRASS; w.elev[t] = .36; w.river[t] = 0; w.lake[t] = 0; w.flow[t] = 0;
    for (const e of g.roads.edgesOf(t)) g.roads.edges.delete(e.a < e.b ? e.a * sim.N + e.b : e.b * sim.N + e.a);
  }
  for (const t of tiles) g.roads.refresh(t);
  for (const t of tiles) { g.fieldworks.delete(t); g.wrecks.delete(t); }
  g.nav.invalidate();
  return { tiles, at: (r, c) => tileOf(sim, r0 + r, c0 + c), point: (r, c) => sim.centerOf(tileOf(sim, r0 + r, c0 + c)) };
}

export function paintTerrain(sim, g, tiles, terrain, elev = null) {
  for (const t of tiles) { g.world.terr[t] = terrain; if (elev != null) g.world.elev[t] = elev; }
  g.nav.invalidate();
}

/** A river along consecutive neighbouring tiles; each tile flows into the next. */
export function paintRiver(sim, g, tiles, flow = 120) {
  const w = g.world;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i], next = tiles[i + 1] ?? -1;
    w.river[t] = 1; w.flow[t] = flow;
    let dir = -1;
    for (let d = 0; d < 6; d++) if (sim.NB[t * 6 + d] === next) dir = d;
    if (dir < 0) { const prev = tiles[i - 1]; for (let d = 0; d < 6; d++) if (sim.NB[t * 6 + d] === prev) dir = (d + 3) % 6; }
    w.flowDir[t] = dir;
  }
  g.nav.invalidate();
}

export function paintRoad(sim, g, tiles, type = 1) {
  for (let i = 1; i < tiles.length; i++) g.roads.set(tiles[i - 1], tiles[i], type, 100);
  g.nav.invalidate();
}

export function paintLake(sim, g, tiles) {
  for (const t of tiles) { g.world.terr[t] = sim.T.SHALLOW; g.world.lake[t] = 1; }
  g.nav.invalidate();
}

export function reindex(sim, g) {
  g.movers.clear();
  for (const u of g.units.values()) if (!sim.ACTION_UNITS[u.type].air) g.movers.add(u);
}

export function place(sim, g, owner, type, point) {
  const d = sim.ACTION_UNITS[type];
  const spot = g.nav.nearest(point, d, 1.2, (x, z) => g.movers.query(x, z, .7, []).every((v) => sim.distance(v, { x, z }) >= d.radius + v.radius + .03));
  if (!spot) return null;
  const u = g.spawn(g.civs[owner], type, spot, .3);
  if (!u) return null;
  const old = { x: u.x, z: u.z };
  u.x = spot.x; u.z = spot.z; u.tile = sim.tileAt(u.x, u.z);
  g.movers.moved(u, old.x, old.z);
  return u;
}

/** A block of units in a loose grid centred on a point. */
export function placeBlock(sim, g, owner, types, center, spacing = .62) {
  const cols = Math.ceil(Math.sqrt(types.length));
  return types.map((type, i) => place(sim, g, owner, type, {
    x: center.x + (i % cols - (cols - 1) / 2) * spacing, z: center.z + (Math.floor(i / cols) - (Math.ceil(types.length / cols) - 1) / 2) * spacing,
  })).filter(Boolean);
}

/** Shortest passable route length between two points for a movement class (tile graph, edge midpoints must be passable). */
export function optimalLength(sim, g, from, to, def) {
  const a = sim.tileAt(from.x, from.z), b = sim.tileAt(to.x, to.z);
  if (a < 0 || b < 0) return Infinity;
  if (a === b) return sim.distance(from, to);
  const passable = (t) => Number.isFinite(g.nav.cost(t, sim.centerOf(t).x, sim.centerOf(t).z, def));
  const best = new Float64Array(sim.N).fill(Infinity), heap = new sim.MinHeap();
  best[a] = 0; heap.push(a, 0);
  while (heap.size) {
    const t = heap.pop();
    if (t === b) break;
    for (let d = 0; d < 6; d++) {
      const n = sim.NB[t * 6 + d];
      if (n < 0 || !passable(n)) continue;
      const ct = sim.centerOf(t), cn = sim.centerOf(n), mid = { x: (ct.x + cn.x) / 2, z: (ct.z + cn.z) / 2 };
      if (!Number.isFinite(g.nav.cost(sim.tileAt(mid.x, mid.z), mid.x, mid.z, def)) && !Number.isFinite(g.nav.cost(n, mid.x, mid.z, def))) continue;
      const v = best[t] + sim.distance(ct, cn);
      if (v < best[n]) { best[n] = v; heap.push(n, v); }
    }
  }
  // tile-centre chains overestimate a straight run by up to ~15%; scale toward Euclidean for fairness
  const chain = best[b] - sim.distance(sim.centerOf(a), sim.centerOf(b)) + sim.distance(from, to);
  return Number.isFinite(best[b]) ? Math.max(sim.distance(from, to), chain * .93) : Infinity;
}

/**
 * Issue a move order and simulate. Returns per-group metrics.
 * `arriveRadius`: a unit counts as arrived when it has no goal and stands within this distance of the
 * order point (group formations spread around the point).
 */
export function runOrder(sim, g, units, point, { attackMove = false, seconds = 120, arriveRadius = null, command = null } = {}) {
  const start = new Map(units.map((u) => [u.id, { x: u.x, z: u.z }]));
  const optimal = new Map(units.map((u) => [u.id, optimalLength(sim, g, u, point, sim.ACTION_UNITS[u.type])]));
  const reply = command ? command() : g.command(0, { c: 'move', units: units.map((u) => u.id), point, attackMove });
  const travelled = new Map(units.map((u) => [u.id, 0])), arrival = new Map(), blockedTicks = new Map(units.map((u) => [u.id, 0]));
  const speedSamples = new Map(units.map((u) => [u.id, []]));
  const radius = arriveRadius ?? 1.4 + Math.sqrt(units.length) * .32;
  let last = new Map(units.map((u) => [u.id, { x: u.x, z: u.z }]));
  const ticks = Math.round(seconds / sim.DT);
  let tick = 0;
  for (; tick < ticks; tick++) {
    g.tick(); g.outbox.length = 0;
    for (const u of units) {
      const p = last.get(u.id), step = sim.distance(p, u);
      travelled.set(u.id, travelled.get(u.id) + step);
      if (u.goal && step > 1e-5) speedSamples.get(u.id).push(step / sim.DT);
      if (u.goal && step < 1e-5) blockedTicks.set(u.id, blockedTicks.get(u.id) + 1);
      last.set(u.id, { x: u.x, z: u.z });
      if (!arrival.has(u.id) && !u.goal && u.hp > 0 && sim.distance(u, point) <= radius) arrival.set(u.id, (tick + 1) * sim.DT);
    }
    if (units.every((u) => arrival.has(u.id) || !u.goal && sim.distance(u, point) > radius && tick > 50)) break;
  }
  const arrived = units.filter((u) => arrival.has(u.id));
  const ratios = arrived.map((u) => travelled.get(u.id) / Math.max(.5, optimal.get(u.id))).filter(Number.isFinite);
  const times = arrived.map((u) => arrival.get(u.id));
  return {
    reply, units: units.length, arrived: arrived.length, stuck: units.length - arrived.length,
    stuckTypes: units.filter((u) => !arrival.has(u.id)).map((u) => `${u.type}@${sim.distance(u, point).toFixed(1)}${u.goal ? '(moving)' : ''}`),
    ratioMean: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : NaN, ratioMax: ratios.length ? Math.max(...ratios) : NaN,
    first: times.length ? Math.min(...times) : NaN, last: times.length ? Math.max(...times) : NaN,
    spread: times.length ? Math.max(...times) - Math.min(...times) : NaN,
    blockedTicks: [...blockedTicks.values()].reduce((a, b) => a + b, 0),
    seconds: tick * sim.DT, travelled, start, speedSamples, arrival,
  };
}

const RIVER = { rows: 26, cols: 34 };
/** 12 tanks west of a broad river; the only crossing is one road bridge well south of the straight line. */
export function riverBridgeScenario(sim, g, { roadType = 1, count = 12, type = 'tank' } = {}) {
  const area = paintArea(sim, g, 70, 6, RIVER.rows, RIVER.cols);
  const riverCol = 17, river = [];
  for (let r = 0; r < RIVER.rows; r++) river.push(area.at(r, riverCol));
  paintRiver(sim, g, river, 130);
  const bridgeRow = 20, road = [];
  for (let c = riverCol - 6; c <= riverCol + 6; c++) road.push(area.at(bridgeRow, c));
  paintRoad(sim, g, road, roadType);
  const west = area.point(7, riverCol - 9), east = area.point(7, riverCol + 9);
  const units = placeBlock(sim, g, 0, Array(count).fill(type), west, .66);
  return { area, units, from: west, to: east, bridge: area.point(bridgeRow, riverCol) };
}

/** A mixed group on one side of a lake with a mountain spur; the target lies straight across the water. */
export function lakeScenario(sim, g) {
  const area = paintArea(sim, g, 70, 44, 28, 34);
  const lake = [], mountain = [];
  for (let r = 6; r < 22; r++) for (let c = 13; c < 20; c++) lake.push(area.at(r, c));
  for (let r = 2; r < 6; r++) for (let c = 14; c < 18; c++) mountain.push(area.at(r, c));
  paintLake(sim, g, lake);
  paintTerrain(sim, g, mountain, sim.T.MOUNTAIN, 1.25);
  const types = ['rifle_squad', 'rifle_squad', 'rifle_squad', 'rifle_squad', 'tank', 'tank', 'tank', 'armored_car', 'armored_car', 'mortar_team', 'scout_buggy', 'anti_armor'];
  const west = area.point(13, 6), east = area.point(13, 27);
  const units = placeBlock(sim, g, 0, types, west, .62);
  return { area, units, from: west, to: east };
}

/** Straight strips of one terrain each; a single unit drives the length of each strip. */
export function terrainStrips(sim, g) {
  const area = paintArea(sim, g, 70, 80, 22, 20);
  const strips = { grass: 2, plains: 6, forest: 10, hills: 14, road: 18 };
  const row = (r) => Array.from({ length: 16 }, (_, c) => area.at(r, c + 2));
  for (const r of [strips.forest - 1, strips.forest, strips.forest + 1]) paintTerrain(sim, g, row(r), sim.T.FOREST);
  for (const r of [strips.plains - 1, strips.plains, strips.plains + 1]) paintTerrain(sim, g, row(r), sim.T.PLAINS);
  for (const r of [strips.hills - 1, strips.hills, strips.hills + 1]) paintTerrain(sim, g, row(r), sim.T.HILLS);
  paintRoad(sim, g, row(strips.road), 2);
  return { area, strips, start: (name) => area.point(strips[name], 3), end: (name) => area.point(strips[name], 15) };
}

/** Player 0's start base, developed: every open slot built, plus a perimeter. Returns the site. */
export function developBase(sim, g) {
  const civ = g.civs[0], site = g.sites.find((s) => s.owner === 0 && s.hq);
  site.tier = 3;
  const pending = ['motor_works', 'power_plant', 'barracks', 'depot', 'heavy_weapons', 'airfield', 'advanced_lab'];
  for (const tile of sim.bases.openSlots(g, site)) {
    const type = pending.shift(); if (!type) break;
    sim.bases.addFacility(g, civ, site, type, tile, { instant: true });
  }
  civ.res.materials = 10000; civ.res.energy = 10000;
  const hq = sim.bases.headquarters(g, site);
  if (hq) hq.project = null;
  sim.bases.fortifyBase(g, civ, site);
  for (const b of g.buildings.values()) if (b.site === site.id) { b.done = true; b.progress = 1; b.hp = b.maxHp; }
  if (hq) hq.project = null;
  g.nav.invalidate();
  return site;
}
