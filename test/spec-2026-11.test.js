// Server support for the Unity target specification (docs/UNITY_GAP_ANALYSIS.md): a dry-run battle-line
// preview that shows exactly what a deployment will do without changing anything, and buildings that
// remember the era they were built (or last upgraded) in, so cities keep their history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena, spawnGroup } from '../server/sim/sandbox.js';
import { H, isWater, TERRAIN } from '../server/sim/constants.js';
import { idx, qOf, rOf, disk } from '../server/sim/hex.js';

const sandbox = (seed = 7) => { const g = new Game({ id: 'sp' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); return g; };
const along = (t, k) => idx(qOf(t) + k, rOf(t));
const flat = (g, t) => !isWater(g.world.terr[t]) && TERRAIN[g.world.terr[t]].move <= 2 && !g.world.river[t];
function lineSpot(g, len) {
  const a = findArena(g, 8);
  for (const c of disk(a, 6)) { let ok = true; for (let k = 0; k < len; k++) if (!flat(g, along(c, k)) || g.tileB[along(c, k)] >= 0) { ok = false; break; } if (ok) return c; }
  return a;
}

test('a deploy preview plans the same slots as the real order and changes nothing', () => {
  const g = sandbox();
  const s = lineSpot(g, 9);
  const us = spawnGroup(g, 0, 'rifle_squad', idx(qOf(s) + 3, rOf(s) + 4 < H ? rOf(s) + 4 : rOf(s) - 4), 8);
  const ids = us.map((u) => u.id);
  const before = us.map((u) => [u.tile, u.path.length, u.formation || 0]);
  const p = g.command(0, { c: 'deploy', units: ids, line: [s, along(s, 7)], preview: true }).reply;
  assert.equal(p.t, 'deployPreview');
  assert.equal(p.slots.length + p.overflow.length, 8, 'every unit is accounted for');
  assert.deepEqual(us.map((u) => [u.tile, u.path.length, u.formation || 0]), before, 'a preview moves nobody and forms nothing');
  assert.equal(g.formations.size, 0);
  const r = g.command(0, { c: 'deploy', units: ids, line: [s, along(s, 7)] }).reply.deploy;
  assert.deepEqual(new Set(r.slots.map(([, t]) => t)), new Set(p.slots.map(([, t]) => t)), 'the preview showed what the order did');
});

test('buildings remember the era they were built in, and an upgrade brings them up to date', () => {
  const g = sandbox();
  const civ = g.civs[0];
  civ.age = 1;
  const site = disk(findArena(g, 8), 5).find((t) => flat(g, t) && g.tileB[t] < 0);
  const b = g.makeBuilding(civ, 'house', site, true);
  assert.equal(b.era, 1);
  civ.age = 3;
  assert.equal(b.era, 1, 'reaching a new era does not rebuild old districts');
  g.applyLevel(b);
  assert.equal(b.era, 3, 'an upgraded building takes on the current era');
  const rec = JSON.stringify(g.viewerSnapshot(civ, { civ, vis: civ.visible, explored: civ.explored, god: false }, true, true));
  assert.match(rec, /"ea":3/, 'the era is sent to clients');
});
