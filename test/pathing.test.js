// Movement failures carry a standardized reason; friendly units queued nose to nose pass each other
// instead of waiting until they give up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena } from '../server/sim/sandbox.js';
import { spawnUnit, tileCapacity } from '../server/sim/military.js';
import { PATH_FAIL, PATH_FAIL_CODES } from '../server/sim/path.js';
import { isWater, TERRAIN } from '../server/sim/constants.js';
import { neighbors, dist, disk } from '../server/sim/hex.js';

const run = (g, n) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; } };
const sandbox = () => { const g = new Game({ id: 'p' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); return g; };
const open = (g, t) => !isWater(g.world.terr[t]) && TERRAIN[g.world.terr[t]].move <= 2 && g.tileB[t] < 0 && !g.world.road[t] && !g.world.river[t];

test('two full hexes swapping places do not deadlock', () => {
  const g = sandbox();
  const arena = findArena(g);
  const a = disk(arena, 4).find((t) => open(g, t) && neighbors(t).some((n) => n >= 0 && open(g, n)));
  const b = neighbors(a).find((n) => n >= 0 && open(g, n));
  const cap = tileCapacity(g, a);
  const A = [], B = [];
  for (let i = 0; i < cap; i++) { A.push(spawnUnit(g, g.civs[0], 'rifle_squad', a)); B.push(spawnUnit(g, g.civs[0], 'rifle_squad', b)); }
  for (const u of [...A, ...B]) u.stance = 'passive';
  g.rebuildTileUnits();
  for (const u of A) { u.order = { kind: 'move' }; u.goal = b; u.slot = b; u.path = [b]; }
  for (const u of B) { u.order = { kind: 'move' }; u.goal = a; u.slot = a; u.path = [a]; }
  run(g, 300);
  assert.ok(A.every((u) => u.tile === b) && B.every((u) => u.tile === a), `everyone got through (${A.filter((u) => u.tile === b).length}/${cap}, ${B.filter((u) => u.tile === a).length}/${cap})`);
  assert.ok(g.stats.deadlocks >= 1, 'the deadlock was detected and resolved');
  assert.ok(![...A, ...B].some((u) => u.status === 'blocked'));
});

test('an unreachable destination says why, in standard words, and reaches the client', () => {
  const g = sandbox();
  const arena = findArena(g);
  const u = spawnUnit(g, g.civs[0], 'rifle_squad', disk(arena, 2).find((t) => open(g, t)));
  g.rebuildTileUnits();
  // the sea, far from any shore
  let sea = -1; for (let t = 0; t < g.world.terr.length; t++) if (isWater(g.world.terr[t]) && disk(t, 3).every((x) => isWater(g.world.terr[x]))) { sea = t; break; }
  const r = g.command(0, { c: 'move', units: [u.id], tile: sea }).reply.order;
  assert.ok(r.unreachable + r.partial >= 1);
  assert.ok(['no_route', 'partial'].includes(u.pathFail.code));
  assert.ok(PATH_FAIL[u.pathFail.code].length > 10);
  assert.equal(PATH_FAIL_CODES.length, Object.keys(PATH_FAIL).length);
  void dist;
});
