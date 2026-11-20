// TERRITORY_BORDERS.md (2026-11-19): territory counts (and draws a border) only where it is connected, through its
// owner's own contiguous hexes, to a site that owner holds (a city, base or captured outpost).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { addFacility, influenceRing } = await import('../server/sim/actionBases.js');
const { centerOf } = await import('../server/sim/actionNavigation.js');
const { disk, dist } = await import('../server/sim/hex.js');
const { isWater } = await import('../server/sim/constants.js');
const { stateHash } = await import('../server/sim/persist.js');

const create = () => new ActionGame({ id: 'borders', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const land = (g, t) => !isWater(g.world.terr[t]);
function tower(g, owner, tile) {
  const b = addFacility(g, g.civs[owner], null, 'guard_post', tile, { point: centerOf(tile) });
  b.done = true; b.progress = 1; b.hp = b.maxHp; b.state = 'operational';
  return b;
}
const owned = (g, tiles, o) => tiles.every((t) => g.world.owner[t] === o);
// every hex of the disk is unclaimed land (unowned sites claim nothing, so only the tested structures claim it)
const clear = (g, t, r = 1) => disk(t, r).every((n) => land(g, n) && g.world.owner[n] < 0);

test('a tower far beyond the border claims nothing; one two hexes out extends the territory', () => {
  const g = create();
  g.refreshTerritory();
  const ring = influenceRing(g, g.civs[0]);
  const far = [...g.world.owner.keys()].find((t) => ring[t] === 255 && clear(g, t, 2));
  assert.ok(far >= 0);
  tower(g, 0, far);
  g.refreshTerritory();
  assert.ok(owned(g, disk(far, 1), -1), 'a disconnected pocket is released: no territory, no border');
  const near = [...g.world.owner.keys()].find((t) => ring[t] === 2 && land(g, t) && disk(t, 1).every((n) => land(g, n) && g.world.owner[n] < 0 || g.world.owner[n] === 0));
  assert.ok(near >= 0);
  tower(g, 0, near);
  g.refreshTerritory();
  assert.equal(g.world.owner[near], 0, 'a claim touching your territory still counts');
});

test('a pocket cut off from its base loses ownership and is reclaimed when the link is rebuilt', () => {
  const g = create(), home = g.sites[0];
  g.refreshTerritory();
  const ring = influenceRing(g, g.civs[0]);
  // a link tower two hexes out, and a far tower two hexes beyond the link's claim
  let link = -1, far = -1;
  for (let t = 0; t < g.world.owner.length && far < 0; t++) {
    if (ring[t] !== 2 || !clear(g, t)) continue;
    const f = disk(t, 3).find((n) => dist(n, t) === 3 && ring[n] === 4 && dist(n, home.tile) > dist(t, home.tile) && clear(g, n));
    if (f !== undefined) { link = t; far = f; }
  }
  assert.ok(far >= 0, 'a link / far tower pair');
  const a = tower(g, 0, link);
  tower(g, 0, far);
  g.refreshTerritory();
  assert.ok(owned(g, disk(far, 1), 0), 'connected through the link tower to the base');
  g.removeBuilding(a);
  g.refreshTerritory();
  assert.ok(owned(g, disk(far, 1), -1), 'cut off: the pocket is neutral again');
  assert.ok(g.buildings.size && [...g.buildings.values()].some((b) => b.tile === far), 'the structure itself stays');
  tower(g, 0, link);
  g.refreshTerritory();
  assert.ok(owned(g, disk(far, 1), 0), 'reconnected: the pocket is claimed again');
});

test('a captured outpost anchors territory; losing it releases the structures claims around it', () => {
  const g = create();
  g.refreshTerritory();
  const out = g.sites.find((s) => !s.slots && s.owner < 0 && clear(g, s.tile, 3));
  assert.ok(out, 'a neutral outpost on open ground');
  const t = disk(out.tile, 2).find((n) => dist(n, out.tile) === 2);
  tower(g, 0, t);
  g.refreshTerritory();
  assert.ok(owned(g, disk(t, 1), -1), 'a tower beside a neutral outpost claims nothing');
  out.owner = 0;
  g.refreshTerritory();
  assert.equal(g.world.owner[out.tile], 0);
  assert.ok(owned(g, disk(t, 1), 0), 'the captured outpost anchors the tower claim');
  out.owner = 1;   // the rival takes it
  g.refreshTerritory();
  assert.equal(g.world.owner[out.tile], 1);
  assert.ok(disk(t, 1).every((n) => g.world.owner[n] !== 0), 'no stale civ-0 ring is left round the tower');
});

test('released ground can be claimed by a rival structure that connects; recompute is idempotent and deterministic', () => {
  const g = create();
  g.refreshTerritory();
  const out = g.sites.find((s) => !s.slots && s.owner < 0 && clear(g, s.tile, 4));
  assert.ok(out);
  out.owner = 1;
  // civ 0's stranded tower three hexes from the outpost, civ 1's tower between them: both claim the shared hexes
  const t0 = disk(out.tile, 3).find((n) => dist(n, out.tile) === 3);
  const t1 = disk(out.tile, 2).find((n) => dist(n, out.tile) === 2 && dist(n, t0) === 1);
  tower(g, 0, t0);   // built first, so it wins the first-come pass
  tower(g, 1, t1);
  g.refreshTerritory();
  assert.equal(g.world.owner[t0], 1, 'the stranded civ-0 claim is released and the rival tower takes the hex');
  assert.ok(disk(t1, 1).every((n) => g.world.owner[n] === 1));
  const before = Int8Array.from(g.world.owner), hash = stateHash(g);
  g.refreshTerritory();
  assert.deepEqual(g.world.owner, before);
  assert.equal(stateHash(g), hash);
});

test('losing a headquarters leaves no stale rings round the defenses and trenches it anchored', () => {
  const g = create(), home = g.sites[0];
  g.refreshTerritory();
  const ring = influenceRing(g, g.civs[0]);
  const edge = [...g.world.owner.keys()].find((t) => ring[t] === 2 && clear(g, t));
  tower(g, 0, edge);
  const trench = [...g.world.owner.keys()].find((t) => ring[t] === 1 && dist(t, edge) > 3 && clear(g, t));
  g.fieldworks.set(trench, { tile: trench, ...centerOf(trench), owner: 0, progress: 1, facing: 0, hp: 100 });
  g.refreshTerritory();
  assert.ok(owned(g, disk(edge, 1), 0) && owned(g, disk(trench, 1), 0), 'both extend the base territory');
  const hq = [...g.buildings.values()].find((b) => b.site === home.id && b.type === 'town');
  g.loseBuilding(hq);
  assert.equal(home.owner, -1);
  assert.ok([...disk(edge, 1), ...disk(trench, 1)].every((t) => g.world.owner[t] !== 0), 'the leftover structures claim nothing');
});
