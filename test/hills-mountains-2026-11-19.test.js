// HILLS_MOUNTAINS (2026-11-19, user: "add a hill or mountain selection in the map builder, mountains shouldn't be
// passable, hills are but slower by infantry"). Mountains and peaks are walls for every ground class (aircraft fly
// over), refuse construction, and are painted by the map builder's Mountains brush; hills are passable, infantry climb
// them at HILL_PACE, routes weigh that, and the builder's new Hills brush (sketch class 'h') paints them. Older
// sketches (o / l / m only) load and seat exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 104;   // = a 'small' sketch
globalThis.SE_WRAP = false;
const S = await import('./action-pathing-scenarios.mjs');
const sim = await S.loadSim();
const { GROUND_PACE } = sim.orders;
const { decodeCells, encodeCells, parseSketch, sketchMetrics, sketchPreview, SKETCH_CLASS } = await import('../server/sim/sketchMaps.js');
const { pointUV } = await import('../server/sim/authoredMaps.js');
const { stateHash, serializeGame, restoreGame } = await import('../server/sim/persist.js');
const { actionDefinitions } = await import('../server/sim/actionDefinitions.js');
const { T, N, W, isWater, TERRAIN } = await import('../server/sim/constants.js');

const GROUND = [sim.LIGHT_GROUND, sim.HEAVY_GROUND, { move: 'wheeled', radius: .2 }];
const AIR = { move: 'infantry', radius: .2, air: true };
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds / sim.DT); i++) { g.tick(); g.outbox.length = 0; } };

// 64 x 64: land inside an ocean border; a mountain wall across the middle (x 30..34) with a pass in the north,
// a broad hill country in the south-east, four bases (one, as an older sketch allowed, on a mountain cell)
function sampleSketch(extra = {}) {
  const w = 64, h = 64, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = x < 3 || y < 3 || x >= w - 3 || y >= h - 3 ? 0 : 1;
    if (Math.abs(x - 32) < 3 && y > 16 && y < 58) c = 2;
    if (x >= 40 && x < 56 && y >= 36 && y < 54) c = 3;
    g[y * w + x] = c;
  }
  return { v: 1, name: 'Ridge and Downs', size: 'small', w, h, cells: encodeCells(g), bases: [[.15, .2], [.85, .2], [.15, .8], [.7, .62]], ...extra };
}
const cellOfUV = (sk, u, v) => Math.min(sk.h - 1, Math.max(0, Math.floor(v * sk.h))) * sk.w + Math.min(sk.w - 1, Math.max(0, Math.floor(u * sk.w)));
const tileUV = (t) => pointUV({ x: Math.sqrt(3) * (t % W + .5 * (((t / W) | 0) & 1)), z: 1.5 * ((t / W) | 0) });

test('sketch format: the hills class round-trips; older o/l/m sketches decode, measure and preview unchanged', () => {
  assert.deepEqual(SKETCH_CLASS, { ocean: 0, land: 1, mountain: 2, hills: 3 });
  const g = Uint8Array.from({ length: 400 }, (_, i) => (i * 7 >> 4) % 4);
  assert.deepEqual(decodeCells(encodeCells(g), 400), g);
  assert.equal(encodeCells(Uint8Array.from([3, 3, 1, 2, 0])), 'h2l1m1o1');
  assert.throws(() => decodeCells('x4', 4), /Map sketch/);
  // an older sketch (no 'h'): the same grid, metrics and preview as before the change
  const old = sampleSketch(), oldGrid = decodeCells(old.cells, 64 * 64);
  const flat = Uint8Array.from(oldGrid, (c) => (c === 3 ? 1 : c));
  const legacy = parseSketch({ ...old, cells: encodeCells(flat) });
  assert.ok(!/h/.test(legacy.cells));
  const m = sketchMetrics(legacy);
  assert.ok(m.steps[0][1] < 1e4 && m.steps[0][1] > 40, 'land route round the range through the pass');
  const p = sketchPreview(legacy);
  assert.equal(Buffer.from(p.cells, 'base64').length, 64 * 64);
  // hills count as land for the land share and as walkable for the seat metrics; mountains do not
  const hills = parseSketch(old);
  assert.equal(sketchMetrics(hills).steps[0][3], sketchMetrics(legacy).steps[0][3], 'hills walk like land');
  const cls = Buffer.from(sketchPreview(hills).cells, 'base64');
  assert.equal(cls[40 * 64 + 48], 5, 'painted hills preview as hills');
  assert.equal(cls[30 * 64 + 32], 6, 'painted mountains preview as mountains');
  const mostlyHills = new Uint8Array(32 * 32).fill(3);
  for (let i = 0; i < 32; i++) { mostlyHills[i] = 0; mostlyHills[32 * 31 + i] = 0; }
  assert.doesNotThrow(() => parseSketch({ w: 32, h: 32, size: 'small', cells: encodeCells(mostlyHills), bases: [[.2, .5], [.8, .5]] }), 'an all-hills map is land');
});

test('navigation: mountains and peaks are walls for every ground class, road or not; aircraft fly over', () => {
  const g = S.makeGame(sim, 9);
  const area = S.paintArea(sim, g, 70, 40, 10, 10);
  const mt = area.at(5, 5), pk = area.at(5, 6);
  S.paintTerrain(sim, g, [mt], T.MOUNTAIN, .6);
  S.paintTerrain(sim, g, [pk], T.PEAK, .8);
  for (const t of [mt, pk]) {
    const c = sim.centerOf(t);
    for (const def of GROUND) {
      assert.equal(g.nav.cost(t, c.x, c.z, def), Infinity, `${def.move} cannot enter terrain ${g.world.terr[t]}`);
      assert.equal(g.nav.canStand(c.x, c.z, def), false);
    }
    assert.ok(Number.isFinite(g.nav.cost(t, c.x, c.z, AIR)), 'aircraft fly over');
  }
  // a road over the mountain does not open it
  S.paintRoad(sim, g, [area.at(5, 4), mt, area.at(5, 7)], 2);
  const c = sim.centerOf(mt);
  for (const def of GROUND) assert.equal(g.nav.cost(mt, c.x, c.z, def), Infinity, `${def.move}: a road does not cut a mountain`);
  assert.ok(sim.isMountain(T.MOUNTAIN) && sim.isMountain(T.PEAK) && !sim.isMountain(T.HILLS));
  // the order feedback calls a mountain point impassable
  const u = S.place(sim, g, 0, 'rifle_squad', area.point(2, 2));
  const reach = g.command(0, { c: 'reach', units: [u.id], point: c }).reply.reach;
  assert.equal(reach.ok, false);
  assert.equal(reach.reason, 'impassable');
});

test('hills: infantry cruise at HILL_PACE (0.7) and routes go round a hill block when that is faster', () => {
  assert.equal(sim.HILL_PACE.infantry, .7);
  const cruise = {};
  for (const name of ['grass', 'hills']) {
    // a road-free patch, all grass or all hill country (beside grass or a road the route rightly leaves the hills)
    const g = S.makeGame(sim, 9);
    const area = S.paintArea(sim, g, 70, 40, 9, 20);
    if (name === 'hills') S.paintTerrain(sim, g, area.tiles, T.HILLS);
    const [u] = S.placeBlock(sim, g, 0, ['rifle_squad'], area.point(4, 2));
    const m = S.runOrder(sim, g, [u], area.point(4, 17), { seconds: 120, arriveRadius: .5 });
    assert.equal(m.stuck, 0, `rifle squad on ${name}`);
    const samples = m.speedSamples.get(u.id).slice(15, -15);
    cruise[name] = samples.reduce((a, b) => a + b, 0) / samples.length / (sim.ACTION_UNITS.rifle_squad.speed * GROUND_PACE);
  }
  assert.ok(Math.abs(cruise.grass - 1) < .05, `grass ${JSON.stringify(cruise)}`);
  assert.ok(cruise.hills > .64 && cruise.hills < .74, `infantry on hills at ~0.7: ${JSON.stringify(cruise)}`);
  // coarse routes: a long hill block straight ahead is skirted (hills cost infantry ~1.43 x open ground)
  const g2 = S.makeGame(sim, 9);
  const area = S.paintArea(sim, g2, 60, 30, 16, 24);
  const block = [];
  for (let r = 6; r < 10; r++) for (let c = 6; c < 18; c++) block.push(area.at(r, c));
  S.paintTerrain(sim, g2, block, T.HILLS);
  const path = g2.nav.strategic(area.at(8, 3), area.at(8, 20), sim.LIGHT_GROUND, false, true, 1e9);
  assert.ok(path && path.length, 'a route exists');
  const onHills = path.filter((t) => g2.world.terr[t] === T.HILLS).length;
  assert.ok(onHills <= 1, `infantry skirt the hill block (${onHills} hill hexes on the route)`);
  // ...and a thin hill strip that would take a long detour is crossed
  const g3 = S.makeGame(sim, 9);
  const a3 = S.paintArea(sim, g3, 60, 30, 16, 24);
  const strip = [];
  for (let r = 0; r < 16; r++) strip.push(a3.at(r, 12));
  S.paintTerrain(sim, g3, strip, T.HILLS);
  const p3 = g3.nav.strategic(a3.at(8, 3), a3.at(8, 20), sim.LIGHT_GROUND, false, true, 1e9);
  assert.ok(p3 && p3.some((t) => g3.world.terr[t] === T.HILLS), 'crossing one hill row beats walking round');
});

test('construction: a structure is never placed on a mountain (refused, or snapped off it with reason "mountain")', () => {
  const g = S.makeGame(sim, 9);
  g.civs[0].res = { materials: 1e5, energy: 1e5 }; g.civs[0].visible.fill(1); g.civs[0].age = 2;
  const home = g.sites.find((s) => s.owner === 0 && s.hq);
  // the neutral or own ground a few hexes out from the base, turned into a mountain spur
  const spur = sim.disk(home.tile, 6).filter((t) => sim.disk(home.tile, 4).indexOf(t) < 0 && !isWater(g.world.terr[t]) && !g.world.lake[t] && (g.world.owner[t] === 0 || g.world.owner[t] < 0)).slice(0, 12);
  assert.ok(spur.length >= 4);
  S.paintTerrain(sim, g, spur, T.MOUNTAIN);
  let seen = 0;
  for (const t of spur) {
    const r = g.command(0, { c: 'fieldPreview', type: 'guard_post', point: sim.centerOf(t), yaw: 0 });
    const code = r.code ?? r.reply?.placement?.reason;
    const at = r.reply?.placement;
    if (at && !r.error) assert.ok(!sim.isMountain(g.world.terr[at.tile]), `hex ${t}: never placed on a mountain (${JSON.stringify(at)})`);
    if (['territory', 'base', 'hidden', 'pad', 'enemy', 'road'].includes(code)) continue;   // rules judged before the ground
    seen++;
    assert.equal(code, 'mountain', `hex ${t}: ${JSON.stringify(r)}`);
  }
  assert.ok(seen > 0, 'some spur hex was judged on its ground');
});

test('map builder: painted mountains become impassable walls, painted hills become hills; starts stay reachable; deterministic', { timeout: 120_000 }, () => {
  const sk = parseSketch(sampleSketch());
  const grid = decodeCells(sk.cells, sk.w * sk.h);
  const make = (seed) => new sim.ActionGame({ id: 'hm-sketch', seed, map: 'custom', sketch: sk, slots: [{ human: true }, { human: false }, { human: false }, { human: false }] });
  const g = make(7), w = g.world;
  const per = { 1: [0, 0], 2: [0, 0], 3: [0, 0] };
  for (let t = 0; t < N; t++) {
    const [u, v] = tileUV(t), c = grid[cellOfUV(sk, u, v)];
    if (c === 0) continue;
    // judge each hex by the class of its cell when the whole neighbourhood is painted alike (edges are warped)
    const x = Math.floor(u * sk.w), y = Math.floor(v * sk.h);
    let interior = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < sk.w && ny < sk.h && grid[ny * sk.w + nx] !== c) interior = false; }
    if (!interior) continue;
    const terr = w.terr[t];
    const ok = c === 2 ? sim.isMountain(terr) : c === 3 ? terr === T.HILLS || w.river[t] || w.lake[t] : !sim.isMountain(terr) && !isWater(terr);
    per[c][1]++; if (ok) per[c][0]++;
  }
  for (const [c, [ok, n]] of Object.entries(per)) assert.ok(n > 30 && ok / n > (c === '3' ? .75 : .9), `class ${c}: ${ok}/${n} hexes honoured`);
  // every interior mountain hex is a wall for every ground class
  let walls = 0;
  for (let t = 0; t < N; t++) if (sim.isMountain(w.terr[t])) { walls++; for (const def of GROUND) assert.equal(g.nav.centreCost(t, def), Infinity); }
  assert.ok(walls > 100, `${walls} mountain hexes`);
  // starts: four, none on a mountain, all reachable from each other on foot (round the range through its pass)
  const starts = g.sites.filter((s) => s.start !== undefined);
  assert.equal(starts.length, 4);
  for (const s of starts) assert.ok(!sim.isMountain(w.terr[s.tile]), `start ${s.start} off the mountains`);
  for (const s of g.sites) assert.ok(g.nav.strategic(starts[0].tile, s.tile, sim.LIGHT_GROUND, false, true, 1e9), `${s.name} reachable on foot`);
  // deterministic: the same seed is the same world and the same simulation
  const twin = make(7);
  assert.equal(stateHash(twin), stateHash(g));
  run(g, 5); run(twin, 5);
  assert.equal(stateHash(twin), stateHash(g), 'same ticks, same state');
  // save / load keeps the ground (terrain classes) and the rules
  const back = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.deepEqual([...back.world.terr], [...g.world.terr]);
  const mt = [...g.world.terr.keys()].find((t) => sim.isMountain(g.world.terr[t]));
  assert.equal(back.nav.centreCost(mt, sim.LIGHT_GROUND), Infinity);
});

test('definitions tell the client: mountains impassable, the hill pace', () => {
  const payload = actionDefinitions({ W, H: W, TERRAIN });
  assert.deepEqual(payload.RULESET.mobility.impassableTerrain, ['mountain', 'peak']);
  assert.equal(payload.RULESET.mobility.hillPace.infantry, .7);
});

test('an older sketch with a base painted on a mountain still loads and seats every player on open, connected ground', { timeout: 120_000 }, () => {
  const old = sampleSketch(), grid = decodeCells(old.cells, 64 * 64);
  const legacy = { ...old, cells: encodeCells(Uint8Array.from(grid, (c) => (c === 3 ? 1 : c))), bases: [[.15, .2], [.85, .8], [.5, .5]] };
  const sk = parseSketch(legacy);
  assert.equal(decodeCells(sk.cells, 64 * 64)[cellOfUV(sk, .5, .5)], 2, 'the third base stands on a painted mountain cell');
  const g = new sim.ActionGame({ id: 'hm-legacy', seed: 3, map: 'custom', sketch: sk, slots: [{ human: true }, { human: false }, { human: false }] });
  const starts = g.sites.filter((s) => s.start !== undefined);
  assert.equal(starts.length, 3);
  for (const s of starts) assert.ok(!sim.isMountain(g.world.terr[s.tile]), `start ${s.start} off the mountains`);
  for (const s of g.sites) assert.ok(g.nav.strategic(starts[0].tile, s.tile, sim.LIGHT_GROUND, false, true, 1e9), `${s.name} reachable on foot`);
  run(g, 3);
});
