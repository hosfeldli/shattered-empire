// Ring of influence (2026-11-17): defenses may be placed on your territory or neutral ground. Within
// DEFENSE_INFLUENCE.reach hexes of your territory they cost their listed price; beyond it, factor ×.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, DEFENSE_INFLUENCE, actionDefinitions } = await import('../server/sim/actionDefinitions.js');
const { fieldCost, influenceRing } = await import('../server/sim/actionBases.js');
const { centerOf, tileAt } = await import('../server/sim/actionNavigation.js');
const { disk, dist } = await import('../server/sim/hex.js');

const create = () => new ActionGame({ id: 'influence', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const rich = (g, id = 0) => { g.civs[id].res = { materials: 20000, energy: 20000 }; g.civs[id].visible.fill(1); };
const doubled = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.ceil(v * DEFENSE_INFLUENCE.factor)]));
const REACH = DEFENSE_INFLUENCE.reach;

// points where `type` previews cleanly for civ 0, filtered by owner and ring distance
function spot(g, type, keep) {
  const ring = influenceRing(g, g.civs[0]);
  for (let t = 0; t < g.world.owner.length; t++) {
    if (!keep(g.world.owner[t], ring[t])) continue;
    const p = centerOf(t);
    if (!g.command(0, { c: 'fieldPreview', type, point: p }).error) return p;
  }
  return null;
}
const preview = (g, type, p) => g.command(0, { c: 'fieldPreview', type, point: p });

test('defensive structures are flagged and the ring is published to the client', () => {
  for (const key of ['barricade', 'guard_post', 'bunker', 'turret', 'aa_battery', 'artillery_post', 'fort']) assert.ok(ACTION_BUILDINGS[key].defense, key);
  for (const key of ['sensor_post', 'repair_point', 'base_site', 'depot']) assert.ok(!ACTION_BUILDINGS[key].defense, key);
  assert.equal(actionDefinitions({}).RULESET.influence.reach, REACH);
});

test('the influence ring is the hex distance from the nearest own territory hex, capped past the reach', () => {
  const g = create(), ring = influenceRing(g, g.civs[0]);
  const owned = [...ring.keys()].filter((t) => g.world.owner[t] === 0);
  assert.ok(owned.length >= 7 && owned.every((t) => ring[t] === 0));
  for (const t of disk(g.sites[0].tile, 13)) {
    const d = Math.min(...owned.map((c) => dist(c, t)));
    if (d <= REACH) assert.equal(ring[t], d, `tile ${t}`);
    else assert.ok(ring[t] > REACH, `tile ${t} beyond the ring`);
  }
  assert.equal(influenceRing(g, g.civs[0]), ring, 'cached within a tick');
});

test('own territory and neutral ground inside the ring: list price; non-defenses stay territory-only', () => {
  const g = create(); rich(g);
  const home = spot(g, 'bunker', (o) => o === 0);
  assert.ok(home, 'a bunker spot in own territory');
  assert.deepEqual(preview(g, 'bunker', home).reply.placement.cost, ACTION_BUILDINGS.bunker.cost);
  const near = spot(g, 'guard_post', (o, d) => o < 0 && d >= 2 && d <= REACH);
  assert.ok(near, 'a watchtower spot on neutral ground inside the ring');
  const r = preview(g, 'guard_post', near).reply.placement;
  assert.deepEqual(r.cost, ACTION_BUILDINGS.guard_post.cost);
  assert.equal(r.note, undefined);
  g.civs[0].age = 1;   // radar posts are Tier II
  assert.equal(preview(g, 'sensor_post', near).code, 'territory', 'support posts stay territory-only');
  g.civs[0].age = 0;
  const before = g.civs[0].res.materials;
  assert.ok(g.command(0, { c: 'fieldBuild', type: 'guard_post', point: near }).building);
  assert.equal(before - g.civs[0].res.materials, ACTION_BUILDINGS.guard_post.cost.materials);
});

test('neutral ground outside the ring: double price, with the reason, and that is what is charged', () => {
  const g = create(); rich(g);
  const far = spot(g, 'guard_post', (o, d) => o < 0 && d > REACH);
  assert.ok(far, 'a watchtower spot outside the ring');
  const quote = preview(g, 'guard_post', far).reply.placement;
  assert.deepEqual(quote.cost, doubled(ACTION_BUILDINGS.guard_post.cost));
  assert.equal(quote.surcharge, DEFENSE_INFLUENCE.factor);
  assert.match(quote.note, /Outside your influence: ×2 cost/);
  const before = { ...g.civs[0].res };
  assert.ok(g.command(0, { c: 'fieldBuild', type: 'guard_post', point: far }).building);
  assert.equal(before.materials - g.civs[0].res.materials, quote.cost.materials);
  assert.equal(before.energy - g.civs[0].res.energy, quote.cost.energy);
  assert.equal(fieldCost(g, g.civs[0], 'guard_post', tileAt(far.x, far.z)).surcharge, DEFENSE_INFLUENCE.factor, 'the AI price check sees it');
});

test('enemy territory stays forbidden; a funds refusal outside the ring names the surcharge', () => {
  const g = create(); rich(g);
  const hostile = disk(g.sites[1].tile, 3).map(centerOf).find((p) => g.world.owner[tileAt(p.x, p.z)] === 1
    && !g.sites.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < 1.2));
  assert.equal(preview(g, 'bunker', hostile).code, 'territory');
  const far = spot(g, 'bunker', (o, d) => o < 0 && d > REACH);
  assert.ok(far);
  g.civs[0].res = { materials: ACTION_BUILDINGS.bunker.cost.materials + 10, energy: 9999 };   // enough at list price only
  const r = g.command(0, { c: 'fieldBuild', type: 'bunker', point: far });
  assert.equal(r.code, 'influence');
  assert.match(r.error, /Outside your influence/);
  assert.equal(fieldCost(g, g.civs[0], 'bunker', g.sites[0].tile).surcharge, 1);
});
