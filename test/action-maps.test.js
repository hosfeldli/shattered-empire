import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAP_CATALOG, MAPS_BY_ID, mapList, mapMode } from '../server/sim/mapCatalog.js';
import { MAP_PREVIEWS } from '../server/sim/mapPreviews.js';

// Each authored map has its own size, and the map size is fixed per process (constants.js), so every
// map is built in its own worker thread, as a live match would be.
const SIM = new URL('../server/sim/', import.meta.url).href;
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { mirrorTile } = await import(workerData.sim + 'authoredMaps.js');
const { HEAVY_GROUND } = await import(workerData.sim + 'actionNavigation.js');
const { mapPreview } = await import(workerData.sim + 'actionMap.js');
const slots = Array.from({ length: workerData.players }, () => ({ human: false, difficulty: 'normal' }));
const make = (seed) => new ActionGame({ id: 'map-' + seed, seed, map: workerData.id, slots });
const t0 = performance.now();
const g = make(11);
const genMs = performance.now() - t0;
const w = g.world, N = w.elev.length;
let asym = 0;
for (let i = 0; i < N; i++) {
  const m = mirrorTile(i);
  if (Math.abs(w.elev[i] - w.elev[m]) > 1e-4 || w.terr[i] !== w.terr[m] || w.river[i] !== w.river[m] || !!w.road[i] !== !!w.road[m]) asym++;
}
const twin = make(98765);
let same = twin.roads.edges.size === g.roads.edges.size && twin.sites.length === g.sites.length;
for (let i = 0; same && i < N; i++) if (twin.world.elev[i] !== w.elev[i] || twin.world.terr[i] !== w.terr[i] || twin.world.river[i] !== w.river[i]) same = false;
for (let i = 0; same && i < g.sites.length; i++) if (twin.sites[i].tile !== g.sites[i].tile || twin.sites[i].name !== g.sites[i].name) same = false;
const starts = g.sites.filter((s) => s.start !== undefined);
const unreachable = g.sites.filter((s) => !g.nav.strategic(starts[0].tile, s.tile, HEAVY_GROUND, false, true, 1e9)).map((s) => s.name);
let fords = 0, bridges = 0, rivers = 0;
for (let i = 0; i < N; i++) if (w.river[i]) { rivers++; if (w.flow[i] < 94) fords++; if (w.road[i]) bridges++; }
// fairness: every seat's heavy-vehicle route lengths to the other seats and to the main sites
// 2026-11-18: the shortest heavy-vehicle drive between two sites in hexes of ground distance: the path the units
// drive (nav.route, pulled taut), direct or by way of one other main site, whichever is shorter. A match now starts
// without country roads (ROADS_AND_CLAIMS.md), so counting coarse planner tiles (which followed the roads) no longer
// measures the ground: on a turned sector a straight run counts more hex steps along a zigzag bearing than along a
// hex axis, and the tile-count planner can prefer a detour to the straight way over a central objective.
const { centerOf, distance } = await import(workerData.sim + 'actionNavigation.js');
const drives = new Map();
const drive = (a, b) => {
  const key = Math.min(a, b) * N + Math.max(a, b);
  if (drives.has(key)) return drives.get(key);
  let len = Infinity;
  const p = g.nav.nearest(centerOf(a), HEAVY_GROUND, 3), q = g.nav.nearest(centerOf(b), HEAVY_GROUND, 3);
  const path = p && q && g.nav.strategic(a, b, HEAVY_GROUND, false, true, 1e9) && g.nav.route(p, q, HEAVY_GROUND);
  if (path) { len = 0; let at = p; for (const pt of path) { len += distance(at, pt); at = pt; } len /= Math.sqrt(3); }
  drives.set(key, len);
  return len;
};
const hubs = g.sites.filter((s) => s.slots).map((s) => s.tile);
const route = (a, b) => Math.round(Math.min(drive(a, b), ...hubs.filter((m) => m !== a && m !== b).map((m) => drive(a, m) + drive(m, b))));
const seats = [...starts].sort((a, b) => a.start - b.start);
const rivals = seats.map((s) => seats.filter((o) => o !== s).map((o) => route(s.tile, o.tile)).sort((a, b) => a - b));
const preview = mapPreview(g);
let error = null;
try { for (let i = 0; i < 600; i++) g.tick(); } catch (e) { error = String(e.stack || e); }
parentPort.postMessage({ genMs, asym, same, unreachable, rivers, fords, bridges, error, mapId: g.mapId, teamSize: g.teamSize,
  starts: starts.map((s) => ({ start: s.start, owner: s.owner, hq: !!g.buildings.get(s.hq) })), main: g.sites.filter((s) => s.slots).length,
  outposts: g.sites.filter((s) => !s.slots).length, rings: g.sites.filter((s) => s.slots).every((s) => s.parcels.length === 9),
  wstarts: w.starts.length, teams: g.civs.map((c) => c.team), units: g.units.size, rivals, preview });
`;

function build(def) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(probe, { eval: true, type: 'module', workerData: { size: def.size, id: def.id, players: def.players, sim: SIM } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', reject);
  });
}

test('the lobby lists the authored maps with their team sizes, after the procedural default', () => {
  const list = mapList();
  assert.equal(list[0].id, 'random');
  assert.ok(MAP_CATALOG.length >= 3);
  for (const size of [1, 2, 3]) assert.ok(MAP_CATALOG.some((m) => m.teamSize === size), `a ${size}v${size} map`);
  for (const m of MAP_CATALOG) {
    const ffa = (m.symmetry ?? 2) !== 2;
    if (ffa) assert.ok(m.teamSize === 1 && m.players === m.symmetry, `${m.id}: a free-for-all map seats one player per turned sector`);
    else assert.equal(m.players, m.teamSize * 2);
    assert.equal(m.size % 2, 0, 'an even number of rows keeps the half-turn exact');
    const entry = list.find((x) => x.id === m.id);
    assert.ok(entry && entry.name && entry.description && entry.mode === mapMode(m) && entry.ffa === ffa);
    assert.ok(entry.mode === (ffa ? `ffa${m.players}` : `${m.teamSize}v${m.teamSize}`));
    // every map has a lobby preview: a 64 x 64 class grid with the seats, bases and outposts
    const p = entry.preview;
    assert.ok(p && p.w === 64 && p.h === 64 && Buffer.from(p.cells, 'base64').length === 64 * 64, `${m.id} has a preview grid`);
    assert.equal(p.starts.length, m.players);
    assert.ok(Buffer.from(p.cells, 'base64').every((c) => c < p.classes.length));
  }
  // not too big (plan 2026-11-16), and at least two maps for every format
  const range = { '1v1': [72, 88], '2v2': [96, 110], '3v3': [120, 136], ffa3: [88, 112], ffa4: [96, 120] };
  for (const [mode, [lo, hi]] of Object.entries(range)) {
    const maps = MAP_CATALOG.filter((m) => mapMode(m) === mode);
    assert.ok(maps.length >= 2, `at least two ${mode} maps`);
    for (const m of maps) assert.ok(m.size >= lo && m.size <= hi, `${m.id} is ${m.size}, ${mode} maps are ${lo}-${hi}`);
  }
});

for (const def of MAP_CATALOG) {
  test(`${def.name}: deterministic, point-symmetric, connected and playable`, async () => {
    const r = await build(def);
    assert.equal(r.error, null, r.error);
    assert.equal(r.mapId, def.id);
    assert.equal(r.teamSize, def.teamSize);
    assert.deepEqual(r.teams, Array.from({ length: def.players }, (_, i) => Math.floor(i / def.teamSize)));
    assert.ok(r.same, 'the same map is the same ground, sites and roads whatever the match seed');
    if ((def.symmetry ?? 2) === 2) {
      // only the single central objective (not mirrored onto itself) may differ from its half-turn
      assert.ok(r.asym <= 40, `${r.asym} tiles break the symmetry`);
    } else {
      // turned sectors are sampled per hex: each seat's routes to its rivals match within a few hexes
      for (let k = 0; k < r.rivals[0].length; k++) {
        const lengths = r.rivals.map((list) => list[k]);
        assert.ok(Math.max(...lengths) - Math.min(...lengths) <= Math.max(4, Math.min(...lengths) * .08), `unequal routes between rivals: ${JSON.stringify(r.rivals)}`);
      }
    }
    for (const list of r.rivals) assert.ok(list.every(Number.isFinite), 'every seat can drive to every rival');
    // the stored lobby preview is up to date (regenerate with node tools/map-previews.mjs)
    const stored = MAP_PREVIEWS[def.id], fresh = r.preview;
    assert.ok(stored, `${def.id} has a stored preview`);
    const a = Buffer.from(stored.cells, 'base64'), b = Buffer.from(fresh.cells, 'base64');
    let differ = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
    assert.ok(differ <= a.length * .03, `${differ} preview cells are stale: run node tools/map-previews.mjs`);
    assert.deepEqual(stored.starts.map((s) => [s.u, s.v]), fresh.starts.map((s) => [s.u, s.v]));
    assert.deepEqual(r.unreachable, [], 'every ruin and outpost can be reached by heavy vehicles');
    assert.equal(r.starts.length, def.players);
    assert.ok(r.starts.every((s, i) => s.start === i && s.owner === i && s.hq), 'each seat starts at its own operational base');
    assert.equal(r.wstarts, def.players);
    assert.ok(r.rings, 'every city ruin has its full ring of parcels');
    assert.ok(r.main >= def.players + 3 && r.outposts >= def.players * 2);
    assert.ok(r.rivers > 0 && r.fords > 0 && r.bridges > 0, `rivers ${r.rivers}, fords ${r.fords}, bridges ${r.bridges}`);
    assert.ok(r.genMs < 8000, `generation took ${r.genMs} ms`);
  });
}

test('matches on an authored map take its size and teams; unknown maps are refused', async () => {
  const { MatchManager } = await import('../server/matches.js');
  const mm = new MatchManager({ info() {}, warn() {}, error() {} });
  try {
    const def = MAPS_BY_ID.saltmarsh_estuary;
    const ai = mm.create({ ruleset: 'action-v2', mode: 'ai', map: def.id, name: 'P', ais: 1, teamSize: 1 });
    assert.equal(ai.map, def.id);
    assert.equal(ai.mapSize, def.size);
    assert.equal(ai.teamSize, def.teamSize);
    assert.equal(ai.slots.length, def.players);
    assert.equal(ai.slots.filter((s) => s.human).length, 1);
    const pvp = mm.create({ ruleset: 'action-v2', mode: 'pvp', map: 'twin_rivers', humans: 4, teamSize: 2 });
    assert.equal(pvp.teamSize, 1);
    assert.equal(pvp.slots.length, 2);
    assert.equal(mm.meta(pvp).map, 'twin_rivers');
    assert.throws(() => mm.create({ ruleset: 'action-v2', mode: 'ai', map: 'atlantis' }), /Unknown map/);
    for (const ffa of MAP_CATALOG.filter((m) => (m.symmetry ?? 2) !== 2)) {
      const free = mm.create({ ruleset: 'action-v2', mode: 'ai', map: ffa.id, name: 'P' });
      assert.equal(free.teamSize, 1);
      assert.equal(free.slots.length, ffa.players, `${ffa.id} seats every player`);
      assert.equal(free.mapSize, ffa.size);
    }
    const random = mm.create({ ruleset: 'action-v2', mode: 'ai' });
    assert.equal(random.map, 'random');
  } finally { clearInterval(mm.janitor); }
});
