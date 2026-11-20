// AI plan cost and stalemate pacing (2026-11-19, docs/gameplay-overhaul/AI_OPERATIONS.md "Plan cost and stalemate
// pass"; docs/performance/TELEMETRY_ANALYSIS_2026-11-19.md B1, B6): the plan's perception index answers exactly what
// the old list filters answered, a plan call routes nothing itself, the AI never blocks a road-only hex with a field
// structure, barricades are capped, and the plan stays deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { distance, centerOf } = await import('../server/sim/actionNavigation.js');
const { UnitGrid, nearAny, needsOrder } = await import('../server/sim/actionAIOps.js');
const { blocksVehicleRoad } = await import('../server/sim/actionAIWorks.js');
const { planActionAI } = await import('../server/sim/actionAI.js');
const { stateHash } = await import('../server/sim/persist.js');
const { NB } = await import('../server/sim/hex.js');

const create = (seed = 41, difficulty = 'brutal') => new ActionGame({ id: 'aisp-' + seed, seed, style: 'pangaea',
  slots: [{ human: false, difficulty, personality: 'builder' }, { human: false, difficulty, personality: 'warlord' }] });

test('UnitGrid.near returns exactly the filtered list, in list order', () => {
  const pts = [];
  for (let i = 0; i < 400; i++) pts.push({ id: i, x: ((i * 37) % 97) * 1.03, z: ((i * 53) % 89) * .91 });
  const grid = new UnitGrid(pts);
  for (const [x, z, r] of [[10, 10, 3], [50, 40, 7.5], [0, 0, 12], [90, 70, 1], [33.3, 21.7, 0]]) {
    const want = pts.filter((u) => distance(u, { x, z }) < r);
    assert.deepEqual(grid.near({ x, z }, r).map((u) => u.id), want.map((u) => u.id));
  }
  const units = pts.slice(0, 20);
  assert.deepEqual(nearAny(pts, units, 4).map((u) => u.id), pts.filter((e) => units.some((u) => distance(e, u) < 4)).map((u) => u.id));
});

test('needsOrder: a unit already on its way, queued for a route or in a firefight is not ordered again', () => {
  const g = create();
  const u = [...g.units.values()].find((v) => v.owner === 0 && !ACTION_UNITS[v.type].air);
  const far = { x: u.x + 8, z: u.z };
  assert.equal(needsOrder(g, u, far), !u.groupJob && (!u.goal || distance(u.goal, far) > 3.5));
  u.goal = { x: far.x + 1, z: far.z };
  assert.equal(needsOrder(g, u, far), false);
  u.goal = null; u.groupJob = 7;
  assert.equal(needsOrder(g, u, far), false);
  u.groupJob = 0; u.target = 99; u.lastCombat = g.time;
  assert.equal(needsOrder(g, u, far), false);
  u.target = 0;
  assert.equal(needsOrder(g, u, far), true);
  assert.equal(needsOrder(g, u, { x: u.x + .5, z: u.z }), false);
});

test('AI structures never block a road-only hex; barricades stay off roads and beside road-only hexes', () => {
  const g = create();
  const w = g.world, tank = ACTION_UNITS.tank;
  // a road hex vehicles can only use along the road (a steep cutting or a river crossing), and a plain road hex
  let only = -1, plain = -1;
  for (let t = 0; t < w.road.length && (only < 0 || plain < 0); t++) {
    if (only < 0 && g.nav.roadOnly(t, tank) && !w.lake[t] && w.terr[t] > 1) only = t;
  }
  assert.ok(only >= 0, 'the map has a hex vehicles can only cross along a road');
  w.road[only] = 1;
  for (let t = 0; t < w.road.length; t++) if (!g.nav.roadOnly(t, tank) && !g.nav.roadOnly(t, ACTION_UNITS.armored_car) && w.terr[t] > 1 &&
    [0, 1, 2, 3, 4, 5].every((d) => NB[t * 6 + d] < 0 || !w.road[NB[t * 6 + d]] && !g.nav.roadOnly(NB[t * 6 + d], tank))) { plain = t; break; }
  assert.ok(blocksVehicleRoad(g, 'barricade', centerOf(only)), 'no barricade on a bridge deck or cutting');
  assert.ok(blocksVehicleRoad(g, 'bunker', centerOf(only)), 'no structure at all on a road-only hex');
  const beside = [0, 1, 2, 3, 4, 5].map((d) => NB[only * 6 + d]).find((n) => n >= 0 && !w.road[n]);
  if (beside != null) assert.ok(blocksVehicleRoad(g, 'barricade', centerOf(beside)), 'no barricade next to a road-only hex');
  const was = w.road[plain];
  w.road[plain] = 1;
  assert.ok(blocksVehicleRoad(g, 'barricade', centerOf(plain)), 'AI barricades go beside roads, not on them');
  w.road[plain] = was;
  assert.ok(!blocksVehicleRoad(g, 'barricade', centerOf(plain)), 'open ground away from roads is fine');
});

test('brutal AIs: no plan call routes, barricades are capped and placed off roads, the match is deterministic', { timeout: 600000 }, () => {
  const run = () => {
    const g = create(7);
    let routes = 0, inPlan = false;
    const route = g.nav.route.bind(g.nav);
    g.nav.route = (...a) => { if (inPlan) routes++; return route(...a); };
    const run = g.runAI.bind(g);
    g.runAI = () => { inPlan = true; try { run(); } finally { inPlan = false; } };
    const barricades = new Map();
    for (let i = 1; i <= 14 * 600 && !g.over; i++) {
      g.tick(); g.outbox.length = 0;
      if (i % 50) continue;
      for (const b of g.buildings.values()) if (b.type === 'barricade' && !b.perimeterSlot && !barricades.has(b.id)) barricades.set(b.id, { owner: b.owner, road: !!g.world.road[b.tile], site: b.tile });
    }
    return { g, routes, barricades, hash: stateHash(g) };
  };
  const a = run();
  // group orders are queued (game.groupJobs); only a stray single route (an attack order's chase, an engineer road)
  // may still be searched inside a plan call. Before this pass, about one route per plan call was searched in the call.
  assert.ok(a.routes <= 10, `${a.routes} routes searched inside plan calls`);
  for (const [id, b] of a.barricades) assert.ok(!b.road, `AI barricade ${id} stands on a road hex`);
  for (const c of a.g.civs) {
    const armed = [...a.g.buildings.values()].filter((b) => b.owner === c.id && ACTION_BUILDINGS[b.type].field && ACTION_BUILDINGS[b.type].attack && !b.perimeterSlot).length;
    const bars = [...a.g.buildings.values()].filter((b) => b.owner === c.id && b.type === 'barricade' && !b.perimeterSlot).length;
    assert.ok(bars <= Math.max(2, armed + 2), `civ ${c.id}: ${bars} barricades against ${armed} armed structures`);
  }
  const b = run();
  assert.equal(a.hash, b.hash, 'same seed, same match');
  assert.ok(typeof planActionAI === 'function');
});

test('a plan restored from a save carries on: the stage rotation is saved with the plan', async () => {
  const { serializeGame, restoreGame } = await import('../server/sim/persist.js');
  const g = create(11);
  for (let i = 0; i < 1500; i++) { g.tick(); g.outbox.length = 0; }
  const stage = g.civs[0].aiPlan.stage;
  assert.ok(stage === 0 || stage === 1);
  const copy = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.equal(copy.civs[0].aiPlan.stage, stage);
  for (let i = 0; i < 300; i++) { g.tick(); g.outbox.length = 0; copy.tick(); copy.outbox.length = 0; }
  assert.equal(stateHash(copy), stateHash(g), 'restored and uninterrupted games stay identical');
});
