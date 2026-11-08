// Large-battle performance contracts (backlog P5): a shared per-tick path-search budget,
// snapshot backpressure that holds (never drops) incremental state for congested viewers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { findPath, PATH_BUDGET } from '../server/sim/path.js';
import { disk, dist } from '../server/sim/hex.js';

const newGame = () => new Game({ id: 'perf' + Math.random(), seed: 5, slots: [{ human: true }, { human: true }], rebels: false, ruleset: WORKS_RULESET });

test('path searches share a per-tick budget and never exceed it badly', () => {
  const g = newGame(), civ = g.civs[0], cap = g.capital(civ).tile;
  const far = disk(cap, 20).sort((a, b) => dist(b, cap) - dist(a, cap))[0];
  g.tickN = 1000; findPath(g, civ, cap, far, 'militia');           // a new tick resets the budget
  assert.ok(g.pathBudget <= PATH_BUDGET && g.pathBudget > 0);
  g.pathBudget = 0;
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) findPath(g, civ, cap, far, 'militia');
  assert.ok(performance.now() - t0 < 200, 'an exhausted budget keeps further searches short');
});

test('a congested viewer gets no snapshot, keeps its pending tile updates, then catches up', () => {
  const g = newGame(); for (const c of g.civs) c.connected = true;
  g.snapshots(null, true);                                           // both viewers synced
  const t = g.capital(g.civs[0]).tile; g.world.touch(t);              // a change the viewer must see
  const held = g.snapshots(null, false, new Set([0]));
  assert.ok(!held.some(([id]) => id === 0), 'nothing is built for the congested viewer');
  g.civs[0].catchUp = true;
  const later = g.snapshots(null, false, new Set());
  const mine = later.find(([id]) => id === 0)[1];
  assert.ok(mine.tiles.some((r) => r[0] === t), 'the held tile update is delivered later');
  assert.ok(mine.econ, 'catch-up includes the economy');
});

test('snapshot deltas (udelta) reproduce the full view exactly and send far less', async () => {
  const { deltaEncoder } = await import('../server/delta.js');
  const { Game } = await import('../server/sim/game.js');
  const { WORKS_RULESET } = await import('../server/sim/rulesets.js');
  const { spawnGroup } = await import('../server/sim/sandbox.js');
  const g = new Game({ id: 'delta' + Math.random(), seed: 5, slots: [{ human: true }, { human: true }], rebels: false, ruleset: WORKS_RULESET });
  for (const c of g.civs) c.connected = true;
  const cap = g.capital(g.civs[0]).tile;
  const us = spawnGroup(g, 0, 'rifle_squad', cap, 60);
  g.rebuildTileUnits();
  g.command(0, { c: 'move', units: us.slice(0, 20).map((u) => u.id), tile: cap + 6 });
  const enc = deltaEncoder(50);
  const mirror = { units: new Map(), paths: {} };
  let fullBytes = 0, deltaBytes = 0;
  for (let i = 0; i < 120; i++) {
    g.tick();
    if (i % 2) continue;
    const [[, msg]] = g.snapshots(0);
    const out = enc(JSON.parse(JSON.stringify(msg)));
    fullBytes += JSON.stringify([msg.units, msg.paths]).length; deltaBytes += JSON.stringify([out.units, out.paths, out.ug, out.pg]).length;
    if (!out.d) { mirror.units = new Map(out.units.map((r) => [r[0], r])); mirror.paths = { ...out.paths }; }
    else {
      for (const r of out.units) mirror.units.set(r[0], r);
      for (const id of out.ug || []) mirror.units.delete(id);
      Object.assign(mirror.paths, out.paths);
      for (const id of out.pg || []) delete mirror.paths[id];
    }
    assert.deepEqual(JSON.stringify([...mirror.units.values()].sort((a, b) => a[0] - b[0])), JSON.stringify(msg.units.slice().sort((a, b) => a[0] - b[0])), `units match at ${i}`);
    assert.deepEqual(mirror.paths, msg.paths, `paths match at ${i}`);
    g.outbox.length = 0;
  }
  assert.ok(deltaBytes < fullBytes * 0.5, `units and paths: delta ${deltaBytes} vs full ${fullBytes}`);
});
