// 2026-11-17: terrain works as paint brushes. A `terrain` order may carry a stroke (`points` + `radius`): every
// reshapeable hex within the brush radius of the stroke is painted, the cost scales with the hexes, the engineers
// work along the stroke, and the single-point order keeps its old rules and flat cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { TERRAIN_WORKS } = await import('../server/sim/actionDefinitions.js');
const { terrainStroke } = await import('../server/sim/actionEngineers.js');
const { centerOf } = await import('../server/sim/actionNavigation.js');
const { disk, dist } = await import('../server/sim/hex.js');

const create = () => new ActionGame({ id: 'brush-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const rich = (g, id = 0) => { g.civs[id].res = { materials: 20000, energy: 20000 }; g.civs[id].visible.fill(1); };
const ticks = (g, n, until) => { for (let i = 0; i < n; i++) { g.tick(); if (until?.()) return true; } return !!until?.(); };

// two own-territory hexes a few apart that preview cleanly at radius 0
function strokeEnds(g, owner = 0) {
  const ok = (t) => !g.command(owner, { c: 'terrain', op: 'raise', points: [centerOf(t)], radius: 0, preview: true }).error;
  const near = disk(g.sites[owner].tile, 4).filter(ok);
  for (const a of near) for (const b of near) if (dist(a, b) >= 3) return [a, b];
  return null;
}

test('terrainStroke joins the drawn points into a gap-free, deduplicated, capped hex footprint', () => {
  const g = create();
  const a = g.sites[0].tile, far = disk(a, 4).find((t) => dist(a, t) === 4);
  const s0 = terrainStroke([centerOf(a), centerOf(far)], 0);
  assert.equal(s0.centres.length, 5, 'a hex line from end to end, no gaps');
  assert.deepEqual(s0.tiles, s0.centres);
  const s1 = terrainStroke([centerOf(a), centerOf(a), centerOf(far)], 1);
  assert.equal(new Set(s1.tiles).size, s1.tiles.length, 'deduplicated');
  assert.ok(s1.tiles.length > s0.tiles.length);
  const capped = terrainStroke([centerOf(a), centerOf(far)], 2, 10);
  assert.equal(capped.tiles.length, 10);
  assert.equal(capped.truncated, true);
});

test('a brush stroke previews its hexes and cost, skips refused hexes and scales the cost', () => {
  const g = create(); rich(g);
  const ends = strokeEnds(g);
  assert.ok(ends, 'two reshapeable hexes in own territory');
  const points = ends.map(centerOf);
  const thin = g.command(0, { c: 'terrain', op: 'raise', points, radius: 0, preview: true }).reply.terrain;
  const wide = g.command(0, { c: 'terrain', op: 'raise', points, radius: 2, preview: true }).reply.terrain;
  assert.ok(thin.tiles.length >= 2 && wide.tiles.length > thin.tiles.length);
  assert.ok(wide.cost.materials > thin.cost.materials, 'cost grows with the hexes painted');
  assert.equal(wide.cost.materials, Math.max(TERRAIN_WORKS.minCost, Math.round(wide.tiles.length * TERRAIN_WORKS.cost.materials / 7)));
  assert.ok(wide.tiles.length <= TERRAIN_WORKS.maxHexes);
  for (const t of wide.tiles) assert.equal(g.world.owner[t], 0, 'only own territory is painted');
  assert.equal(wide.radius, 2);
  // radius is clamped
  assert.equal(g.command(0, { c: 'terrain', op: 'raise', points, radius: 9, preview: true }).reply.terrain.radius, TERRAIN_WORKS.maxRadius);
  // a stroke wholly in someone else's territory is refused with the territory reason
  const hostile = disk(g.sites[1].tile, 2).filter((t) => g.world.owner[t] === 1).map(centerOf);
  const r = g.command(0, { c: 'terrain', op: 'raise', points: hostile, radius: 0 });
  assert.equal(r.code, 'territory', r.error);
  // the base hex itself is never painted
  const onBase = g.command(0, { c: 'terrain', op: 'raise', points: [centerOf(g.sites[0].tile)], radius: 1, preview: true });
  if (!onBase.error) assert.ok(!onBase.reply.terrain.tiles.includes(g.sites[0].tile));
});

test('a committed stroke charges per hex and the engineers reshape the whole stroke', () => {
  const g = create(); rich(g);
  const civ = g.civs[0];
  const points = strokeEnds(g).map(centerOf);
  const plan = g.command(0, { c: 'terrain', op: 'raise', points, radius: 1, preview: true }).reply.terrain;
  const before = new Map(plan.tiles.map((t) => [t, g.world.elev[t]]));
  const m0 = civ.res.materials;
  const r = g.command(0, { c: 'terrain', op: 'raise', points, radius: 1 });
  assert.ok(!r.error, r.error);
  assert.equal(m0 - civ.res.materials, plan.cost.materials);
  assert.equal(r.hexes, plan.tiles.length);
  // the same ground cannot be ordered twice while it is being worked
  assert.equal(g.command(0, { c: 'terrain', op: 'raise', points, radius: 1 }).code, 'busy');
  const project = g.roadProjects.find((p) => p.kind === 'terrain' && p.owner === 0);
  assert.ok(project.steps.length >= 2, 'the engineers work through the stroke step by step');
  assert.ok(ticks(g, 4000, () => !g.roadProjects.includes(project)), 'the engineers finish the stroke');
  const raised = plan.tiles.filter((t) => g.world.elev[t] > before.get(t) + .01);
  assert.ok(raised.length >= plan.tiles.length * .8, `${raised.length}/${plan.tiles.length} hexes raised`);
});

test('the legacy single-point order keeps its flat cost and 7-hex footprint', () => {
  const g = create(); rich(g);
  const civ = g.civs[0];
  let tile = -1;
  for (const t of disk(g.sites[0].tile, 3)) if (!g.command(0, { c: 'terrain', op: 'lower', point: centerOf(t), preview: true }).error) { tile = t; break; }
  assert.ok(tile >= 0);
  const plan = g.command(0, { c: 'terrain', op: 'lower', point: centerOf(tile), preview: true }).reply.terrain;
  assert.ok(plan.tiles.length <= 7 && plan.tiles.includes(tile));
  const m0 = civ.res.materials;
  assert.ok(!g.command(0, { c: 'terrain', op: 'lower', point: centerOf(tile) }).error);
  assert.equal(m0 - civ.res.materials, TERRAIN_WORKS.cost.materials);
  assert.ok(g.command(0, { c: 'terrain', op: 'lower', point: centerOf(tile) }).error, 'overlapping works are refused as a whole');
});
