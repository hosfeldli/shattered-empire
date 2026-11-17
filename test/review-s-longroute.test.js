// Review S (2026-11-16): a large group ordered across a large map gets a route for every member. Before,
// the group's flow field stopped after 4300 hexes and members beyond it fell back to bounded A*, which
// gave up on long routes (an AI final assault on a 208 world left 18 of 68 units with no order, and the
// order took ~600 ms). The field now expands until every member is covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 208;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { moveGroup } = await import('../server/sim/actionOrders.js');
const { distance } = await import('../server/sim/actionNavigation.js');

test('a 68-unit assault across a 208 map places every member', () => {
  const g = new ActionGame({ id: 'longroute', seed: 7, teamSize: 1, style: 'pangaea', slots: Array.from({ length: 6 }, () => ({ human: false })) });
  const home = g.sites[0];
  const far = g.sites.filter((s) => s.slots).sort((a, b) => distance(home, b) - distance(home, a))[0];
  assert.ok(distance(home, far) > 150);
  const types = ['rifle_squad', 'rifle_squad', 'tank', 'anti_armor', 'mortar_team', 'armored_car'];
  const group = [];
  for (let i = 0; i < 68; i++) { const u = g.spawn(g.civs[0], types[i % 6], home, 1.5 + (i % 10) * .3); if (u) group.push(u); }
  const t0 = performance.now();
  const r = moveGroup(g, group, { x: far.x, z: far.z }, { mode: 'assault', exact: true });
  const ms = performance.now() - t0;
  assert.equal(r.blocked, 0, JSON.stringify(r));
  assert.ok(group.every((u) => u.goal && distance(u.goal, far) < 4), 'every member heads for the objective');
  assert.ok(ms < 1500, `order resolved in ${ms.toFixed(0)} ms`);
});
