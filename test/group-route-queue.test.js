// Pass 3 (perf, late game, 2026-11-18): a large group order routes GROUP_ROUTE.now members at once and queues the rest
// (game.groupJobs), routed GROUP_ROUTE.perTick a tick at the start of unitMotion. The queue is saved state: a match
// saved with members still queued must continue exactly as the uninterrupted one. A new order for a queued member
// replaces its queued route.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 104; globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');
const { GROUP_ROUTE, moveGroup } = await import('../server/sim/actionOrders.js');
const { distance } = await import('../server/sim/actionNavigation.js');

function staged() {
  const g = new ActionGame({ id: 'gq', seed: 5, map: 'crossroads', slots: [0, 1, 2, 3].map(() => ({ human: false, difficulty: 'normal' })) });
  for (const c of g.civs) c.aiPlan = null;
  const home = g.sites[0];
  const types = ['rifle_squad', 'rifle_squad', 'tank', 'armored_car', 'mortar_team'];
  for (let i = 0; i < 64; i++) g.spawn(g.civs[0], types[i % types.length], home, 1.4 + (i % 12) * .2);
  g.tick();
  const group = [...g.units.values()].filter((u) => u.owner === 0 && !u.auto);
  const target = g.sites.filter((s) => s.id !== home.id).sort((a, b) => distance(a, home) - distance(b, home))[0];
  return { g, group, point: { x: target.x, z: target.z } };
}

test('a large group order is routed in chunks over the following ticks', () => {
  const { g, group, point } = staged();
  assert.ok(group.length > GROUP_ROUTE.now + GROUP_ROUTE.perTick, `only ${group.length} units`);
  const r = moveGroup(g, group, point, { mode: 'move' });
  assert.ok(!r.error, r.error);
  assert.equal(g.groupJobs.length, 1);
  const queued = group.filter((u) => u.groupJob);
  assert.ok(queued.length >= group.length - GROUP_ROUTE.now - 4, `queued ${queued.length}`);
  assert.ok(queued.every((u) => !u.goal || distance(u.goal, point) > 4), 'queued members keep their previous order');
  for (let i = 0; i < Math.ceil(queued.length / GROUP_ROUTE.perTick) + 1; i++) g.tick();
  assert.equal(g.groupJobs.length, 0);
  const routed = queued.filter((u) => u.goal && distance(u.goal, point) < 4);
  assert.ok(routed.length >= queued.length * .8, `routed ${routed.length} of ${queued.length}`);
});

test('chunked routing is deterministic and the queue is saved with the match', () => {
  const run = () => { const s = staged(); moveGroup(s.g, s.group, s.point, { mode: 'assault' }); return s; };
  const a = run(), b = run();
  assert.equal(stateHash(a.g), stateHash(b.g));
  for (let i = 0; i < 30; i++) { a.g.tick(); b.g.tick(); }
  assert.equal(stateHash(a.g), stateHash(b.g));
  // a save taken while members are still queued carries the queue; the restored match routes them
  const { g, group, point } = run();
  const queued = group.filter((u) => u.groupJob).map((u) => u.id);
  assert.ok(queued.length);
  const restored = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.equal(stateHash(restored), stateHash(g));
  assert.deepEqual(restored.groupJobs, g.groupJobs);
  for (let i = 0; i < 6; i++) restored.tick();
  assert.equal(restored.groupJobs.length, 0);
  const routed = queued.map((id) => restored.units.get(id)).filter((u) => u?.goal && distance(u.goal, point) < 4);
  assert.ok(routed.length >= queued.length * .8, `routed ${routed.length} of ${queued.length}`);
});

test('a new order replaces a queued group route', () => {
  const { g, group, point } = staged();
  moveGroup(g, group, point, { mode: 'move' });
  const waiting = group.filter((u) => u.groupJob).slice(0, 3);
  assert.equal(waiting.length, 3);
  const elsewhere = { x: g.sites[0].x + 1.5, z: g.sites[0].z + 1.5 };
  assert.ok(!moveGroup(g, waiting, elsewhere, { mode: 'move' }).error);
  for (let i = 0; i < 8; i++) g.tick();
  for (const u of waiting) assert.ok(!u.goal || distance(u.goal, elsewhere) < 2.5, `unit ${u.id} was moved by the stale queued order`);
});
