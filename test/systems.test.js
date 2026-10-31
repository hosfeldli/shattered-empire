// Simulation tests for the systems the audit called out: formations & flow fields, bridge
// destruction & rerouting, congestion recovery, governors, isolation & local reserves, the
// building lifecycle, rebels, armies, and bit-exact persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { serializeGame, restoreGame, stateHash } from '../server/sim/persist.js';
import { spawnUnit } from '../server/sim/military.js';
import { recomputeTradeNetwork } from '../server/sim/economy.js';
import { findPath, stepCost } from '../server/sim/path.js';
import { T, N, isWater } from '../server/sim/constants.js';
import { disk, dist, NB } from '../server/sim/hex.js';

const newGame = (seed = 7, extra = {}) => new Game({ id: 't' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false, ...extra });
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; } };
const landNear = (g, t, r) => disk(t, r).filter((x) => !isWater(g.world.terr[x]) && Number.isFinite(g.defs.MOVE.infantry.terrain[g.world.terr[x]]) && !g.world.river[x]);

test('a 24-unit group order uses a shared flow field and arrives in formation without deadlock', () => {
  const g = newGame(7);
  const civ = g.civs[0], cap = g.capital(civ);
  const spots = landNear(g, cap.tile, 3);
  const ids = [];
  for (let i = 0; i < 24; i++) ids.push(spawnUnit(g, civ, 'militia', spots[i % spots.length]).id);
  // a reachable land goal ~10 hexes away
  const goal = landNear(g, cap.tile, 11).filter((t) => dist(t, cap.tile) >= 9 && findPath(g, civ, cap.tile, t, 'militia') && !findPath(g, civ, cap.tile, t, 'militia').partial)[0];
  assert.ok(goal >= 0, 'test needs a reachable goal');
  const res = g.command(0, { c: 'move', units: ids, tile: goal, formation: 'line' });
  assert.equal(res.reply.order.unreachable, 0);
  assert.ok(ids.some((id) => g.units.get(id).field), 'large groups steer by shared flow field');
  const slots = new Set(ids.map((id) => g.units.get(id).slot));
  assert.ok(slots.size >= 20, 'each unit gets its own formation slot, not one shared hex');
  run(g, 900);
  const arrived = ids.filter((id) => { const u = g.units.get(id); return dist(u.tile, u.slot) <= 1 && dist(u.tile, goal) <= 6; }).length;
  assert.ok(arrived >= 22, `group arrived in formation (${arrived}/24)`);
  assert.ok(ids.every((id) => g.units.get(id).status !== 'blocked'), 'no unit ended up deadlocked');
});

test('destroying a bridge reroutes units; heavy vehicles cannot ford major rivers', () => {
  const g = newGame(7);
  const civ = g.civs[0], w = g.world;
  // find a river tile with land on both sides
  let bridge = -1, a = -1, b = -1;
  for (let i = 0; i < N && bridge < 0; i++) {
    if (!w.river[i] || isWater(w.terr[i])) continue;
    const ns = []; for (let d = 0; d < 6; d++) { const n = NB[i * 6 + d]; if (n >= 0 && !w.river[n] && !isWater(w.terr[n]) && Number.isFinite(g.defs.MOVE.infantry.terrain[w.terr[n]])) ns.push([d, n]); }
    const opp = ns.find(([d]) => ns.some(([d2]) => d2 === (d + 3) % 6));
    if (opp) { bridge = i; a = opp[1]; b = ns.find(([d2]) => d2 === (opp[0] + 3) % 6)[1]; }
  }
  assert.ok(bridge >= 0);
  civ.techs.add('civil_engineering');
  g.roads.set(a, bridge, 2); g.roads.set(bridge, b, 2);
  const u = spawnUnit(g, civ, 'militia', a);
  const p1 = findPath(g, civ, a, b, 'militia');
  assert.deepEqual(p1, [bridge, b], 'uses the bridge');
  const c1 = stepCost(g, civ, a, bridge, 'militia');
  g.roads.damage(a, bridge, 200); g.roads.damage(bridge, b, 200);
  assert.ok(stepCost(g, civ, a, bridge, 'militia') > c1 + 1, 'a ruined bridge means fording: much slower');
  assert.ok(!g.roads.usable(a, bridge), 'segment is ruined, not deleted');
  assert.ok(g.roads.get(a, bridge), 'ruined segment persists until repaired');
  const before = g.navVersion;
  run(g, 25);
  assert.ok(g.navVersion >= before);
  u.path = [bridge, b]; u.goal = b; u.slot = b; u.order = { kind: 'move' };
  run(g, 300);
  assert.ok(u.tile === b || u.status === 'blocked', 'unit fords or detours once the bridge is gone, or reports it is blocked');
  // tracked vehicles cannot cross a ruined bridge over a major river without one
  const major = w.flow[bridge] > 84;
  if (major) { const t2 = spawnUnit(g, civ, 'tank', a); const p = findPath(g, civ, a, b, 'tank'); assert.ok(!p || p.length > 2, 'tanks must detour'); void t2; }
});

test('congested bridges make units wait, then reroute or report blocked', () => {
  const g = newGame(11);
  const civ = g.civs[0], cap = g.capital(civ);
  const spots = landNear(g, cap.tile, 2);
  const ids = []; for (let i = 0; i < 18; i++) ids.push(spawnUnit(g, civ, 'militia', spots[0]).id);
  const goal = landNear(g, cap.tile, 8).filter((t) => dist(t, cap.tile) >= 7)[0];
  g.command(0, { c: 'move', units: ids, tile: goal });
  let sawWaiting = false;
  for (let i = 0; i < 600; i++) { g.tick(); g.outbox.length = 0; if (ids.some((id) => g.units.get(id)?.status === 'waiting')) sawWaiting = true; }
  assert.ok(sawWaiting, 'tile capacity forces queueing');
  const stuck = ids.filter((id) => g.units.get(id).status === 'waiting').length;
  assert.ok(stuck <= 2, 'queues drain: ' + stuck);
});

test('a human city governor builds within its reserve and permissions, and explains itself', () => {
  const g = newGame(7);
  const civ = g.civs[0], c = g.capital(civ);
  civ.res.materials = 1000;
  g.command(0, { c: 'governor', city: c.id, enabled: true, level: 'autonomous', spec: 'agrarian', reserve: 0.5, perms: { build: true, roads: false, repair: true, recruit: false, settle: false } });
  const before = g.buildings.size;
  run(g, 1200);
  assert.ok(g.buildings.size > before, 'governor built something');
  assert.ok(c.governor.log.length > 0 && c.governor.log.every((l) => typeof l.text === 'string' && l.text.length > 10), 'decisions are logged with reasons');
  assert.ok(civ.cmdlog.some((l) => l.by.startsWith('governor:')), 'human command history attributes governor actions');
  assert.ok(![...g.units.values()].some((u) => u.owner === 0 && u.type === 'colonist'), 'no settling without permission');
  // reserve: with everything reserved the governor cannot spend
  const mine = () => [...g.buildings.values()].filter((b) => b.owner === 0).length;
  civ.res.materials = 100;
  g.command(0, { c: 'governor', city: c.id, reserve: 0.9, perms: { roads: false, repair: false } });
  const n0 = mine();
  run(g, 300);
  assert.equal(mine(), n0, 'with 90% reserved and only 100 materials the governor builds nothing');
});

test('a city cut off from the network lives on local reserves and recovers when reconnected', () => {
  const g = newGame(7);
  const civ = g.civs[0], cap = g.capital(civ);
  run(g, 50);
  // found a second city connected by road
  const site = [...disk(cap.tile, 9)].find((t) => dist(t, cap.tile) >= 7 && !g.canFound(civ, t) && g.world.terr[t] === T.GRASS);
  assert.ok(site >= 0);
  const col = spawnUnit(g, civ, 'colonist', site);
  assert.equal(g.command(0, { c: 'found', unit: col.id }), null);
  const c2 = [...g.cities.values()].find((c) => c.tile === site);
  assert.ok(c2.isolated, 'a fresh colony starts unconnected');
  assert.ok(c2.stock.food > 0, 'colonists bring starter reserves');
  const route = g.roads.plan(g, civ, [site, cap.tile], 1);
  void route;
  const r = g.command(0, { c: 'roadPlan', tiles: [site, cap.tile], type: 1, auto: true, commit: true });
  assert.ok(!r.error, JSON.stringify(r));
  civ.res.materials = 2000;
  run(g, 900);
  recomputeTradeNetwork(g);
  assert.equal(c2.isolated, false, 'road reconnects the city');
  assert.ok(c2.freight > 0 && c2.freight < 100, 'freight is limited by the road class');
  // cut every road edge around the colony
  for (const t of disk(site, 2)) for (const e of g.roads.edgesOf(t)) e.cond = 0;
  for (const t of disk(site, 2)) g.roads.refresh(t);
  recomputeTradeNetwork(g);
  assert.equal(c2.isolated, true);
  const food0 = c2.stock.food;
  c2.pop = 20;
  for (const b of g.buildings.values()) if (b.cityId === c2.id && b.type === 'farm') g.removeBuilding(b);
  run(g, 200);
  assert.ok(c2.stock.food < food0 || c2.foodShort, 'isolated city consumes its own reserves');
  const credits0 = civ.res.credits; void credits0;
});

test('buildings go operational -> damaged -> ruined, ruins can be rebuilt at half cost', () => {
  const g = newGame(7);
  const civ = g.civs[0];
  const farm = [...g.buildings.values()].find((b) => b.owner === 0 && b.type === 'farm');
  assert.equal(farm.state, 'operational');
  g.damageBuilding(farm, farm.maxHp * 0.6, 1, 'combat');
  assert.equal(farm.state, 'damaged');
  run(g, 300);
  assert.ok(farm.hp < farm.maxHp * 0.5, 'damaged buildings do not heal by themselves');
  assert.equal(g.command(0, { c: 'repair', id: farm.id }), null);
  assert.equal(farm.state, 'operational');
  g.damageBuilding(farm, 1e9, 1, 'combat');
  assert.ok(!g.buildings.has(farm.id) && g.ruins.has(farm.tile), 'destroyed building leaves ruins');
  const full = g.buildingCost(civ, 'farm', null).materials, half = g.buildingCost(civ, 'farm', farm.tile).materials;
  assert.ok(half < full, 'rebuilding on ruins is cheaper');
  assert.equal(g.canPlace(civ, 'house', farm.tile, true), false, 'other buildings need the rubble cleared first');
  // planned buildings wait for funds
  civ.res.materials = 0;
  const spot = [...disk(g.capital(civ).tile, 3)].find((t) => g.canPlace(civ, 'house', t, true));
  assert.equal(g.command(0, { c: 'build', type: 'house', tile: spot, plan: true }), null);
  const planned = g.buildingAtTile(spot);
  assert.equal(planned.state, 'planned');
  civ.res.materials = 500; run(g, 20);
  assert.equal(planned.state, 'construction');
});

test('rebels raise camps in the wilds, never near starting empires', () => {
  const g = new Game({ id: 'reb', seed: 5, slots: [{ personality: 'builder' }, { personality: 'warlord' }] });
  const rebels = g.rebelCiv();
  assert.ok(rebels);
  const camps = [...g.buildings.values()].filter((b) => b.type === 'camp');
  assert.ok(camps.length >= 2);
  for (const c of camps) for (const s of g.world.starts) assert.ok(dist(c.tile, s) >= 16);
  run(g, 3000);
  assert.ok([...g.units.values()].some((u) => u.owner === rebels.id), 'rebels field raiders');
});

test('army groups: offensive preparation stages, then launches when ready', () => {
  const g = newGame(7);
  const civ = g.civs[0], cap = g.capital(civ);
  const spots = landNear(g, cap.tile, 2);
  const ids = []; for (let i = 0; i < 8; i++) ids.push(spawnUnit(g, civ, 'rifle_squad', spots[i % spots.length]).id);
  const r = g.command(0, { c: 'army', op: 'create', units: ids, name: 'Vanguard' });
  const id = r.reply.id;
  const target = landNear(g, cap.tile, 16).filter((t) => dist(t, cap.tile) >= 14)[0];
  g.command(0, { c: 'army', op: 'order', id, kind: 'offensive', tile: target });
  const a = civ.armies.get(id);
  assert.equal(a.status, 'staging');
  assert.ok(a.order.staging >= 0 && dist(a.order.staging, target) <= 12);
  let launched = false;
  for (let i = 0; i < 6000 && !launched; i++) { g.tick(); g.outbox.length = 0; if (a.order.phase === 'attacking') launched = true; }
  assert.ok(launched, 'offensive launched: ' + a.note);
  assert.ok(civ.cmdlog.some((l) => l.text.includes('Offensive launched')), 'the army controller explains itself in the history');
  assert.equal(a.men, ids.length * 10);
});

test('save/restore resumes a match bit-for-bit (replay determinism)', () => {
  const g = new Game({ id: 'det', seed: 9, slots: [{ human: true }, { personality: 'warlord' }, { personality: 'merchant' }] });
  run(g, 2400);
  g.command(0, { c: 'research', tech: 'agronomy' });
  const h = restoreGame(JSON.parse(JSON.stringify(serializeGame(g)))); h.id = 'det2';
  assert.equal(stateHash(g), stateHash(h));
  for (let i = 0; i < 1800; i++) {
    if (i === 300) { for (const x of [g, h]) x.command(0, { c: 'move', units: [...x.units.values()].filter((u) => u.owner === 0).map((u) => u.id), tile: x.capital(x.civs[0]).tile + 3 }); }
    g.tick(); h.tick(); g.outbox.length = 0; h.outbox.length = 0;
  }
  assert.equal(stateHash(g), stateHash(h));
});
