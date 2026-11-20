// W2 construction (overhaul §13-14): neutral infrastructure, terrain works on neutral ground, placement codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS, DEFENSE_INFLUENCE, PLACEMENT } = await import('../server/sim/actionDefinitions.js');
const { influenceRing, PLACEMENT_REASONS } = await import('../server/sim/actionBases.js');
const { centerOf, distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { isWater, T } = await import('../server/sim/constants.js');

const create = () => new ActionGame({ id: 'neutral-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const rich = (g) => { g.civs[0].res = { materials: 1e5, energy: 1e5 }; g.civs[0].visible.fill(1); g.civs[0].age = 1; };
function reindex(g) { g.movers.clear(); for (const u of g.units.values()) if (!ACTION_UNITS[u.type].air) g.movers.add(u); }
const preview = (g, type, point, yaw = 0) => g.command(0, { c: 'fieldPreview', type, point, yaw });
// the first tile (by index) passing `keep` where `type` previews cleanly
function spot(g, type, keep) {
  for (let t = 0; t < g.world.owner.length; t++) {
    if (!keep(t)) continue;
    const p = centerOf(t);
    // 2026-11-18: an unsnapped spot (with the 3-hex ring a snap can carry a spot past the ring's edge)
    const r = preview(g, type, p);
    if (!r.error && !r.reply?.placement?.snapped) return p;
  }
  return null;
}
const neutralNear = (g) => { const ring = influenceRing(g, g.civs[0]); return (t) => g.world.owner[t] < 0 && ring[t] >= 2 && ring[t] <= DEFENSE_INFLUENCE.reach; };
const finish = (g, id) => { const b = g.buildings.get(id); b.done = true; b.progress = 1; b.hp = b.maxHp; b.state = 'operational'; return b; };

test('radar and repair posts are neutral infrastructure; defenses and New Base keep their own rules', () => {
  for (const key of ['sensor_post', 'repair_point']) {
    assert.ok(ACTION_BUILDINGS[key].neutral, key);
    assert.ok(!ACTION_BUILDINGS[key].defense && !ACTION_BUILDINGS[key].claims, `${key} claims no territory`);
  }
  for (const key of ['base_site', 'guard_post', 'bunker', 'depot']) assert.ok(!ACTION_BUILDINGS[key].neutral, key);
});

for (const type of ['sensor_post', 'repair_point']) test(`${type} builds on neutral ground without claiming territory`, () => {
  const g = create(); rich(g);
  const p = spot(g, type, neutralNear(g));
  assert.ok(p, 'a neutral spot inside the ring');
  const quote = preview(g, type, p).reply.placement;
  assert.deepEqual(quote.cost, ACTION_BUILDINGS[type].cost, 'list price inside the ring of influence');
  const r = g.command(0, { c: 'fieldBuild', type, point: p });
  assert.ok(r.building, r.error);
  const before = Int8Array.from(g.world.owner);
  finish(g, r.building);
  g.refreshTerritory();
  assert.deepEqual(g.world.owner, before, 'a finished support post claims nothing');
  assert.equal(g.world.owner[tileAt(p.x, p.z)], -1);
  // sanity: a watchtower (claims: 1) on the same kind of ground does claim. TERRITORY_BORDERS.md: only when its
  // claim touches your territory (2 hexes out), since a pocket not connected to a site you hold is released.
  const q = spot(g, 'guard_post', (t) => neutralNear(g)(t) && influenceRing(g, g.civs[0])[t] === 2 && distance(centerOf(t), p) > 3);
  finish(g, g.command(0, { c: 'fieldBuild', type: 'guard_post', point: q }).building);
  g.refreshTerritory();
  assert.equal(g.world.owner[tileAt(q.x, q.z)], 0);
});

test('neutral infrastructure: enemy territory refused, fogged neutral ground refused, surcharge beyond the ring', () => {
  const g = create(); rich(g);
  const enemy = (t) => g.world.owner[t] === 1 && !g.sites.some((s) => distance(s, centerOf(t)) < 2.2);
  const hostile = [...g.world.owner.keys()].find(enemy);
  assert.equal(preview(g, 'sensor_post', centerOf(hostile)).code, 'territory');
  assert.equal(preview(g, 'repair_point', centerOf(hostile)).code, 'territory');
  assert.equal(preview(g, 'bunker', centerOf(hostile)).code, 'territory', 'defenses unchanged');
  const ring = influenceRing(g, g.civs[0]);
  const far = spot(g, 'sensor_post', (t) => g.world.owner[t] < 0 && ring[t] > DEFENSE_INFLUENCE.reach);
  assert.ok(far);
  const q = preview(g, 'sensor_post', far).reply.placement;
  assert.equal(q.surcharge, DEFENSE_INFLUENCE.factor);
  const near = spot(g, 'sensor_post', neutralNear(g));
  g.civs[0].visible[tileAt(near.x, near.z)] = 0;
  assert.equal(preview(g, 'sensor_post', near).code, 'hidden');
  // a New Base stays territory-only
  const n = spot(g, 'guard_post', neutralNear(g));
  assert.equal(preview(g, 'base_site', n).code, 'territory');
});

test('placement refusals carry precise codes', () => {
  const g = create(); rich(g);
  // 2026-11-18: ground refusals (pad, water, slope, trench, blocked) now snap to the nearest valid hex when one is
  // near; the resolved code is then the ack's placement.reason (CONSTRUCTION_DESIGN.md)
  const why = (r) => r.code ?? r.reply?.placement?.reason;
  for (const code of ['slope', 'water', 'blocked', 'territory', 'base', 'pad', 'trench', 'enemy', 'hidden']) assert.ok(PLACEMENT_REASONS[code], code);
  const home = g.sites[0];
  assert.equal(preview(g, 'bunker', { x: home.x + .5, z: home.z }).code, 'base', 'inside the command zone');
  const parcel = home.parcels[1];
  assert.equal(why(preview(g, 'bunker', { x: parcel.x, z: parcel.z })), 'pad', 'on a building pad');
  const water = [...g.world.owner.keys()].find((t) => isWater(g.world.terr[t]) && g.world.owner[t] < 0 && !g.sites.some((s) => distance(s, centerOf(t)) < 3));
  assert.equal(why(preview(g, 'guard_post', centerOf(water))), 'water');
  const codes = new Set();
  for (let t = 0; t < g.world.terr.length; t++) if (g.world.terr[t] >= T.MOUNTAIN && g.world.owner[t] !== 1) codes.add(why(preview(g, 'guard_post', centerOf(t))));
  // HILLS_MOUNTAINS (2026-11-19): mountains and peaks refuse with their own code (impassable, never built on)
  assert.ok(codes.has('mountain'), `mountains refuse as mountain (${[...codes]})`);
  // a valid spot, then blockers
  const p = spot(g, 'bunker', (t) => g.world.owner[t] === 0);
  const t = tileAt(p.x, p.z);
  g.fieldworks.set(t, { owner: 0, tile: t, x: p.x, z: p.z, progress: 0, facing: 0 });
  assert.equal(why(preview(g, 'bunker', p)), 'trench');
  g.fieldworks.delete(t);
  const foe = g.spawn(g.civs[1], 'rifle_squad', p, .5);
  foe.x = p.x + .2; foe.z = p.z; foe.tile = tileAt(foe.x, foe.z); reindex(g);
  assert.equal(preview(g, 'bunker', p).code, 'enemy');
  g.units.delete(foe.id); reindex(g);
  assert.ok(g.command(0, { c: 'fieldBuild', type: 'bunker', point: p }).building);
  assert.equal(why(preview(g, 'guard_post', { x: p.x + .1, z: p.z })), 'blocked', 'overlapping another structure');
});

test('rotated footprints tolerate gentle slopes in proportion to their size', () => {
  const b = ACTION_BUILDINGS.barricade;
  const tolerance = PLACEMENT.slope.base + PLACEMENT.slope.perSpan * Math.hypot(b.width, b.depth) * .5;
  assert.ok(tolerance > .15 && tolerance < .25, `sandbag wall tolerance ${tolerance}`);
  assert.ok(PLACEMENT.parcelMargin < .62 && PLACEMENT.parcelMargin >= .57, 'pads stay clear of the largest facility');
});

test('terrain works: own territory and neutral ground, never another player\'s territory', () => {
  const g = create(); rich(g);
  const ring = influenceRing(g, g.civs[0]);
  const ok = (t) => g.world.owner[t] < 0 && ring[t] >= 2 && !isWater(g.world.terr[t]) && !g.world.lake[t] && !g.world.river[t] && g.world.terr[t] < T.MOUNTAIN && !g.reservedTiles.has(t);
  const n = [...g.world.owner.keys()].find(ok);
  const r = g.command(0, { c: 'terrain', op: 'raise', points: [centerOf(n)], radius: 0, preview: true });
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.reply.terrain.tiles, [n]);
  const legacy = g.command(0, { c: 'terrain', op: 'flatten', point: centerOf(n), preview: true });
  assert.ok(!legacy.error, legacy.error);
  const hostile = [...g.world.owner.keys()].find((t) => g.world.owner[t] === 1 && !g.reservedTiles.has(t) && !isWater(g.world.terr[t]));
  assert.equal(g.command(0, { c: 'terrain', op: 'raise', points: [centerOf(hostile)], radius: 0, preview: true }).code, 'territory');
  g.civs[0].visible[n] = 0;
  assert.equal(g.command(0, { c: 'terrain', op: 'raise', points: [centerOf(n)], radius: 0, preview: true }).code, 'hidden', 'neutral ground must be in sight');
  assert.equal(g.command(0, { c: 'terrain', op: 'raise', point: centerOf(n), preview: true }).code, 'hidden');
  // a real order is paid and queued for the engineers
  g.civs[0].visible[n] = 1;
  const order = g.command(0, { c: 'terrain', op: 'raise', points: [centerOf(n)], radius: 0 });
  assert.equal(order.hexes, 1, order.error);
});
