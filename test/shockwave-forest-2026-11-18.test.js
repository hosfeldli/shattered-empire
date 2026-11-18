// Effects pass (2026-11-18): a nuclear blast flattens every forest hex in its core and fells more along a
// height-aware shock front (server/sim/shockwave.js): far down a valley, little up its walls, less behind a
// ridge than on open ground. The clearing is permanent: it survives save / restore. docs/gameplay-overhaul/EFFECTS.md
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { T, W } = await import('../server/sim/constants.js');
const { disk } = await import('../server/sim/hex.js');
const { TILE_X, TILE_Z } = await import('../server/sim/actionNavigation.js');
const { SHOCK, blastForest, shockField, worldHeightAt } = await import('../server/sim/shockwave.js');
const { launchStrategic } = await import('../server/sim/actionCombat.js');
const { serializeGame, restoreGame } = await import('../server/sim/persist.js');

const create = () => new ActionGame({ id: 'shock', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const W0 = W;

/** Paint a forested test landscape around the map centre; elevAt(dx, dz) gives the elevation. */
function landscape(g, elevAt) {
  const w = g.world, c = (W0 / 2 | 0) * W0 + (W0 / 2 | 0), x = TILE_X[c], z = TILE_Z[c];
  for (const t of disk(c, 24)) {
    w.elev[t] = elevAt(TILE_X[t] - x, TILE_Z[t] - z);
    w.terr[t] = T.FOREST; w.moist[t] = .7;
    if (w.dense) w.dense[t] = 0;
  }
  return { c, x, z };
}
function cleared(g, x, z, keep) {
  let n = 0;
  for (const t of disk((W0 / 2 | 0) * W0 + (W0 / 2 | 0), 24)) {
    const dx = TILE_X[t] - x, dz = TILE_Z[t] - z;
    if (keep(dx, dz, Math.hypot(dx, dz)) && g.world.terr[t] !== T.FOREST) n++;
  }
  return n;
}
const flat = () => .1;
const valley = (dx, dz) => .1 + Math.min(.85, Math.max(0, Math.abs(dz) - 2.5) * .3);   // a valley running east-west
const ridge = (dx) => (dx > 5 && dx < 7.5 ? .8 : .1);                                   // a ridge east of the burst

test('shock field: a valley channels the front both ways along it and stops it on its walls', () => {
  const g = create(); const { x, z } = landscape(g, valley);
  const f = shockField(worldHeightAt(g.world), x, z);
  const along = Math.min(f.reach[0], f.reach[SHOCK.rays / 2]);               // east and west
  const across = Math.max(f.reach[SHOCK.rays / 4], f.reach[SHOCK.rays * 3 / 4]);   // south and north
  assert.ok(f.e0 > 1.2, `blocked walls push energy down the valley (e0 ${f.e0})`);
  assert.ok(along > SHOCK.reach, `the front runs farther down the valley than on open ground (${along})`);
  assert.ok(across < along / 2.5, `and only a little way up the walls (${across} vs ${along})`);
  const open = create(); const o = landscape(open, flat);
  const fo = shockField(worldHeightAt(open.world), o.x, o.z);
  assert.ok(Math.abs(fo.e0 - 1) < 1e-6, 'open ground: no channelling');
  for (let i = 0; i < SHOCK.rays; i++) assert.ok(Math.abs(fo.reach[i] - SHOCK.reach) <= SHOCK.step * 2, 'open ground: the same reach every way');
});

test('a nuclear blast flattens every forest hex in its core and fells more on open ground than behind a ridge', () => {
  const g = create(); const { x, z } = landscape(g, flat);
  blastForest(g, x, z);
  let coreTiles = 0, coreForest = 0;
  for (const t of disk((W0 / 2 | 0) * W0 + (W0 / 2 | 0), 6)) {
    if (Math.hypot(TILE_X[t] - x, TILE_Z[t] - z) > SHOCK.core) continue;
    coreTiles++; if (g.world.terr[t] === T.FOREST) coreForest++;
  }
  assert.ok(coreTiles > 10);
  assert.equal(coreForest, 0, 'no tree survives in the core');
  const east = cleared(g, x, z, (dx, dz, d) => d > 6 && d < 13 && dx > Math.abs(dz));
  const west = cleared(g, x, z, (dx, dz, d) => d > 6 && d < 13 && -dx > Math.abs(dz));
  assert.ok(east > 3 && west > 3, `open ground: trees fall in every direction (${east}, ${west})`);
  // a ridge to the east shelters the forest behind it
  const r = create(); const q = landscape(r, ridge);
  blastForest(r, q.x, q.z);
  const behind = cleared(r, q.x, q.z, (dx, dz, d) => dx > 8 && d < 15 && dx > Math.abs(dz));
  const exposed = cleared(r, q.x, q.z, (dx, dz, d) => -dx > 8 && d < 15 && -dx > Math.abs(dz));
  assert.ok(behind < exposed, `less behind the ridge (${behind}) than on the open side (${exposed})`);
  // a valley: far down it trees still fall, up the walls they do not
  const v = create(); const p = landscape(v, valley);
  blastForest(v, p.x, p.z);
  const down = cleared(v, p.x, p.z, (dx, dz, d) => Math.abs(dz) < 2 && Math.abs(dx) > 13 && Math.abs(dx) < 22);
  const up = cleared(v, p.x, p.z, (dx, dz, d) => Math.abs(dx) < 2.5 && Math.abs(dz) > 8 && Math.abs(dz) < 17);
  assert.ok(down > up + 2, `down the valley (${down}) rather than up its walls (${up})`);
  // deterministic
  const v2 = create(); landscape(v2, valley); blastForest(v2, p.x, p.z);
  assert.deepEqual([...v2.world.terr], [...v.world.terr]);
});

test('a strategic missile clears the forest for good: replicated, saved and restored', () => {
  const g = create(); const { c, x, z } = landscape(g, flat);
  const silo = { id: 999999, owner: 1, tile: c - 30, x: x - 40, z };
  launchStrategic(g, silo, { x, z });
  for (const p of g.projectiles.values()) if (p.strategic) p.mint = 0;   // not shot down
  for (let i = 0; i < 400 && [...g.projectiles.values()].some((p) => p.strategic); i++) { g.tick(); g.outbox.length = 0; }
  assert.notEqual(g.world.terr[c], T.FOREST, 'ground zero is bare');
  assert.ok(g.forestCleared > 20, `the blast felled many forest hexes (${g.forestCleared})`);
  const before = [...g.world.terr];
  const back = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.deepEqual([...back.world.terr], before, 'the clearing survives save / restore');
  assert.notEqual(back.world.terr[c], T.FOREST);
});
