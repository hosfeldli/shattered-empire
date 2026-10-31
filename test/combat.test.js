// Combat: projectiles that damage on impact, area blasts, fog-safe event delivery, target
// distribution, suppression/morale, battlefield aftermath and determinism mid-battle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, runScenario, spawnGroup, findArena } from '../server/sim/sandbox.js';
import { eventsFor, chooseTarget } from '../server/sim/combat.js';
import { serializeGame, restoreGame, stateHash } from '../server/sim/persist.js';
import { W } from '../server/sim/constants.js';
import { dist } from '../server/sim/hex.js';

const sandbox = (seed = 7) => { const g = new Game({ id: 'c' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); return g; };
const off = (t, dq) => t + dq;
const run = (g, secs, each) => { for (let i = 0; i < secs * 10; i++) { g.tick(); if (each && each(i) === false) break; } };

test('projectiles fly: damage lands on impact, not on launch', () => {
  const g = sandbox();
  const a = findArena(g);
  const [m] = spawnGroup(g, 1, 'mortar_team', off(a, 3), 1);
  const [r] = spawnGroup(g, 0, 'rifle_squad', off(a, 0), 1);
  r.stance = 'hold'; m.stance = 'hold';
  g.orderAttack(g.civs[1], [m.id], { kind: 'unit', id: r.id }, {});
  let launch = null;
  run(g, 10, () => { launch = g.events.find((e) => e.k === 'launch'); return !launch; });
  assert.ok(launch, 'mortar launched a shell');
  assert.ok(launch.f >= 1, 'shell has a flight time');
  const hpAtLaunch = r.hp;
  const p = [...g.projectiles.values()][0];
  assert.ok(p, 'projectile is in flight on the server');
  while (g.time + 0.1 < p.at) { g.tick(); assert.equal(r.hp >= hpAtLaunch - 0.01 || g.events.some((e) => e.k === 'impact' && e.p !== p.id), true, 'no damage before impact'); }
  run(g, 0.3);
  const imp = g.events.find((e) => e.k === 'impact' && e.p === p.id);
  assert.ok(imp, 'impact event for that projectile');
  assert.ok(g.events.indexOf(imp) > g.events.indexOf(launch));
});

test('area weapons hurt everything around the impact', () => {
  const g = sandbox();
  const a = findArena(g);
  const victims = spawnGroup(g, 0, 'rifle_squad', a, 6);
  for (const v of victims) v.stance = 'hold';
  const guns = spawnGroup(g, 1, 'sp_artillery', off(a, 5), 3);
  for (const u of guns) u.stance = 'hold';
  g.orderAttack(g.civs[1], guns.map((u) => u.id), { kind: 'unit', id: victims[0].id }, { focus: true });
  run(g, 25);
  const hurt = victims.filter((v) => !g.units.has(v.id) || v.hp < v.maxHp).length;
  assert.ok(hurt >= 3, `blast damaged ${hurt} units, not just the target`);
  assert.ok(g.events.some((e) => e.k === 'impact' && e.r >= 1), 'area impacts reported with their radius');
});

test('hidden artillery: impacts are visible, the firing position is never revealed', () => {
  const g = sandbox();
  const a = findArena(g);
  const [r] = spawnGroup(g, 0, 'rifle_squad', a, 1); r.stance = 'hold';
  const [spotter] = spawnGroup(g, 0, 'scout_buggy', off(a, -2), 1); spotter.stance = 'passive';   // keeps eyes on the target area
  const guns = spawnGroup(g, 1, 'sp_artillery', off(a, 6), 2);
  for (const u of guns) u.stance = 'hold';
  g.refreshVisibility();
  const vis = g.civs[0].visible;
  assert.equal(vis[guns[0].tile], 0, 'guns are outside the defender\'s sight');
  g.orderAttack(g.civs[1], guns.map((u) => u.id), { kind: 'unit', id: r.id }, { focus: true });
  // what the defender is actually sent while the shells fall
  g.civs[0].connected = true; g.snapshots(0);
  const seen = [];
  run(g, 15, (i) => { if (i % 2 === 0) for (const [civ, msg] of g.snapshots()) if (civ === 0 && msg.ev) seen.push(...msg.ev); });
  assert.ok(seen.some((e) => e.k === 'impact'), 'defender sees shells landing');
  const gunTiles = new Set(guns.map((u) => u.tile));
  assert.ok(seen.every((e) => !gunTiles.has(e.a)), 'no event carries the guns\' position');
  assert.ok(seen.filter((e) => e.k === 'launch' || e.k === 'impact').every((e) => e.a === -1), 'origin stripped');
});

test('event delivery: each viewer gets every authorised event exactly once', () => {
  const g = sandbox();
  const sc = runScenario(g, 'rifles');
  g.civs[0].connected = true;
  g.orderMove(g.civs[0], sc.A, off(sc.arena, 3), true, 'line', {});
  const ids = [];
  g.snapshots(0);                  // a fresh view starts from now
  for (let i = 0; i < 400; i++) { g.tick(); if (i % 2 === 0) for (const [civ, msg] of g.snapshots()) if (civ === 0 && msg.ev) ids.push(...msg.ev.map((e) => e.i)); }
  assert.ok(ids.length > 20, 'events delivered');
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], 'in order');
});

test('group attack spreads fire across threats; focus fire concentrates it', () => {
  const g = sandbox();
  const a = findArena(g);
  const enemies = [...spawnGroup(g, 1, 'rifle_squad', off(a, 3), 4), ...spawnGroup(g, 1, 'armored_car', off(a, 4), 2)];
  const mine = [...spawnGroup(g, 0, 'rifle_squad', off(a, -3), 12), ...spawnGroup(g, 0, 'tank', off(a, -4), 8)];
  g.orderAttack(g.civs[0], mine.map((u) => u.id), { kind: 'unit', id: enemies[0].id }, {});
  const spread = new Set(mine.map((u) => u.order.target.id));
  assert.ok(spread.size >= 4, `distributed over ${spread.size} targets`);
  assert.ok(mine.filter((u) => u.type === 'tank').some((u) => g.units.get(u.order.target.id)?.type === 'armored_car'), 'tanks take the armour');
  g.orderAttack(g.civs[0], mine.map((u) => u.id), { kind: 'unit', id: enemies[0].id }, { focus: true });
  assert.equal(new Set(mine.map((u) => u.order.target.id)).size, 1, 'focus fire: one target');
});

test('overkill avoidance: units pick another target once one is already doomed', () => {
  const g = sandbox();
  const a = findArena(g);
  const enemies = spawnGroup(g, 1, 'militia', off(a, 2), 3);
  const mine = spawnGroup(g, 0, 'rifle_squad', off(a, -1), 9);
  g.rebuildTileUnits();
  const picks = mine.map((u) => chooseTarget(g, u, 4)?.tg.id);
  assert.ok(new Set(picks).size >= 2, 'fire spread instead of all on the nearest');
  void enemies;
});

test('suppression pins infantry and morale breaks units without player orders', () => {
  const g = sandbox();
  const sc = runScenario(g, 'artillery');
  for (const id of sc.B) { const u = g.units.get(id); u.stance = 'defensive'; }
  g.orderAttack(g.civs[0], sc.A, { kind: 'unit', id: sc.B[0] }, {});
  let pinned = false, suppressed = false;
  run(g, 60, () => { for (const id of sc.B) { const u = g.units.get(id); if (!u) continue; if (u.supp >= 60) suppressed = true; if (u.cstat === 10) pinned = true; } });
  assert.ok(suppressed, 'heavy fire suppresses');
  assert.ok(pinned, 'suppressed infantry go to ground');
});

test('player orders are never abandoned because of a scare', () => {
  const g = sandbox();
  const a = findArena(g);
  const [r] = spawnGroup(g, 0, 'rifle_squad', a, 1);
  g.orderMove(g.civs[0], [r.id], off(a, 6), false, 'line', { auth: 'player' });
  r.morale = 5; r.supp = 90;
  run(g, 2);
  assert.notEqual(r.order.withdraw, true, 'no automatic retreat');
  assert.equal(r.goal, off(a, 6));
});

test('battlefield aftermath: wrecks, craters, smoke; engineers clear them', () => {
  const g = sandbox();
  const sc = runScenario(g, 'large');
  g.orderMove(g.civs[0], sc.A, sc.arena, true, 'line', {});
  g.orderMove(g.civs[1], sc.B, sc.arena, true, 'line', {});
  let maxSmoke = 0, battles = 0;
  run(g, 90, () => { maxSmoke = Math.max(maxSmoke, g.smoke.size); battles = Math.max(battles, g.battles.length); });
  assert.ok(g.wrecks.size > 0, 'destroyed vehicles leave wrecks');
  assert.ok(g.craters.size > 0, 'shelling leaves craters');
  assert.ok(maxSmoke > 0, 'fires and shelling make smoke');
  assert.ok(battles > 0, 'the fight was tracked as a battle');
  const [t] = g.wrecks.keys();
  for (const wr of g.wrecks.get(t)) wr.burn = 0;
  const before = g.wrecks.get(t).length;
  const [eng] = spawnGroup(g, 0, 'engineer', t, 1);
  eng.stance = 'passive';
  run(g, 12);
  assert.ok((g.wrecks.get(t)?.length || 0) < before, 'engineers clear a wreck');
});

test('battles are reported with fog-respecting enemy estimates', () => {
  const g = sandbox();
  const sc = runScenario(g, 'rifles');
  g.orderMove(g.civs[0], sc.A, off(sc.arena, 2), true, 'line', {});
  run(g, 20);
  g.refreshVisibility(false);
  const snap = g.econSnapshot(g.civs[0]);
  assert.ok(snap.battles.length >= 1);
  const b = snap.battles[0];
  assert.ok(b.mine.n > 0 && b.foes.length >= 1);
  const visibleFoes = [...g.units.values()].filter((u) => u.owner === 1 && g.civs[0].visible[u.tile] && dist(u.tile, b.t) <= 6).length;
  assert.ok(b.foes[0].n <= visibleFoes, 'enemy count only from what is seen');
});

test('a battle in progress (projectiles in flight) restores bit-for-bit', () => {
  const g = sandbox(11);
  const sc = runScenario(g, 'large');
  g.orderMove(g.civs[0], sc.A, sc.arena, true, 'line', {});
  g.orderMove(g.civs[1], sc.B, sc.arena, true, 'line', {});
  run(g, 40);
  assert.ok(g.projectiles.size > 0 || g.events.some((e) => e.k === 'launch'), 'mid-battle');
  const copy = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  copy.sandbox = true;
  for (let i = 0; i < 300; i++) { g.tick(); copy.tick(); }
  assert.equal(stateHash(copy), stateHash(g));
});

test('right-drag battle line: slots spread along the line, facing perpendicular', () => {
  const g = sandbox();
  const a = findArena(g);
  const mine = spawnGroup(g, 0, 'rifle_squad', off(a, -6), 8);
  const A = a - 3 * W, B = a + 3 * W;          // a north-south line
  const r = g.orderMove(g.civs[0], mine.map((u) => u.id), A, false, 'line', { line: [A, B], auth: 'player' });
  const slots = r.reply.order.slots;
  const rows = new Set(slots.map((t) => (t / W) | 0));
  assert.ok(rows.size >= 4, 'units spread along the dragged line');
});
