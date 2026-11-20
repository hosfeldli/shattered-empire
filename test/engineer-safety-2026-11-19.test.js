// 2026-11-19 (user: "the engineers keep trying to go build old stuff in enemy territory and die"): automatic engineers
// skip unfinished work on ground a hostile civ now holds, and work within reach of a visible hostile armed unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { centerOf, distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { disk } = await import('../server/sim/hex.js');

const create = () => new ActionGame({ id: 'eng-safety', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const rich = (g, id) => { g.civs[id].res = { materials: 20000, energy: 20000 }; g.civs[id].visible.fill(1); };
const engineers = (g, owner) => [...g.units.values()].filter((u) => u.owner === owner && u.auto);
function spot(g, owner, type) {
  for (const t of disk(g.sites[owner].tile, 4)) {
    if (g.world.owner[t] !== owner) continue;
    const p = centerOf(t);
    if (!g.command(owner, { c: 'fieldPreview', type, point: p }).error) return { p, t };
  }
  return null;
}
function placeBunker(g) {
  const s = spot(g, 0, 'bunker');
  const placed = g.command(0, { c: 'fieldBuild', type: 'bunker', point: s.p });
  assert.ok(!placed.error, placed.error);
  return { b: g.buildings.get(placed.building), tile: s.t };
}

test('unfinished work on ground a hostile civ now holds is left alone', () => {
  const g = create(); rich(g, 0); rich(g, 1);
  const { b } = placeBunker(g);
  const tile = tileAt(b.x, b.z);
  g.refreshTerritory = () => {};               // hold the map as set below
  g.world.owner[tile] = 1;                     // the ground under the blueprint changes hands
  for (let i = 0; i < 300; i++) g.tick();
  assert.equal(b.done, false, 'nobody builds on enemy ground');
  assert.ok(engineers(g, 0).every((u) => u.job !== 'b' + b.id), 'no engineer holds the job');
});

test('engineers do not walk into a visible enemy gun to reach a job, and finish once it has gone', () => {
  const g = create(); rich(g, 0); rich(g, 1);
  const { b } = placeBunker(g);
  // just outside its own gun range of the blueprint (so it does not shoot the site) but inside the danger margin
  const off = Math.min(4.2, ACTION_UNITS.tank.range) + .6;
  const tank = g.spawn(g.civs[1], 'tank', { x: b.x + off, z: b.z, radius: .1 }, .01);
  tank.mode = 'hold';
  for (let i = 0; i < 200; i++) { g.tick(); tank.hp = tank.maxHp; tank.goal = null; }
  assert.ok(g.buildings.has(b.id), 'the blueprint still stands');
  assert.ok(b.progress < .05, 'no work done under the gun');
  assert.ok(engineers(g, 0).every((u) => u.job !== 'b' + b.id), 'the dangerous job is not taken');
  tank.hp = 0; g.units.delete(tank.id);
  let done = false;
  for (let i = 0; i < 1500 && !done; i++) { g.tick(); done = b.done; }
  assert.ok(done, 'the job resumes once the threat leaves');
  assert.ok(engineers(g, 0).length >= 1 && distance(engineers(g, 0)[0], b) < 40);
});
