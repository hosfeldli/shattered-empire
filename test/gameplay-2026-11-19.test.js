// 2026-11-19 gameplay requests: gradual supply pickups (5 a second per unit), energy caches that appear on the map,
// units coming out of the door of the facility that produced them, a lower infantry climb limit (with maxSlope in
// the unit definitions) and the removal of the troop upgrades.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame, FACILITY_DOORS } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS, ACTION_UPGRADES, REMOVED_UPGRADES } = await import('../server/sim/actionDefinitions.js');
const { distance, LIGHT_GROUND, MAX_GRADIENT, MAX_SLOPE_DEG, tileAt } = await import('../server/sim/actionNavigation.js');
const { addFacility, openSlots } = await import('../server/sim/actionBases.js');
const { CACHE_COLLECT, ENERGY_CACHES } = await import('../server/sim/actionEconomy.js');
const { serializeGame, restoreGame: deserializeGame, stateHash } = await import('../server/sim/persist.js');

const create = (seed = 41) => new ActionGame({ id: 'gp-1119', seed, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const ticks = (g, n) => { for (let i = 0; i < n; i++) g.tick(); };

/** Puts `n` units of `type` for civ 0 right on cache c (and nothing else of anyone's near it). */
function collectors(g, c, n, type = 'rifle_squad') {
  for (const u of g.movers.query(c.x, c.z, 2, [])) if (u.hp > 0 && !u.auto) { const x = u.x, z = u.z; u.x += 4; u.tile = tileAt(u.x, u.z); g.movers.moved(u, x, z); }
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = g.spawn(g.civs[0], type, c, .12 + i * .02);
    assert.ok(u, 'a collector fits beside the cache');
    out.push(u);
  }
  return out;
}

function quietCache(g, amount, resource = 'materials') {
  const c = [...g.materialCaches.values()].find((v) => v.active && !v.replenishes && (v.resource || 'materials') === 'materials');
  c.amount = amount; c.max = amount; c.resource = resource;
  return c;
}

test('supply caches are collected gradually: 5 a second per unit, partial amounts stay on the map', () => {
  assert.deepEqual([CACHE_COLLECT.rate, CACHE_COLLECT.chunk], [5, 5]);
  const g = create();
  const c = quietCache(g, 50);
  collectors(g, c, 1);
  let total = 0;
  const paid = () => 50 - c.amount - total;
  for (let i = 0; i < 40; i++) { g.tick(); total += paid(); }   // 4 s
  assert.ok(c.active, 'one unit has not emptied a 50 cache in 4 s');
  assert.ok(total >= 15 && total <= 20, `~20 materials in 4 s with one unit (got ${total})`);
  for (let i = 0; i < 65; i++) { g.tick(); total += paid(); }
  assert.ok(!c.active, 'one unit empties a 50 cache in ~10 s');
  assert.equal(total, 50);
});

test('two units collect twice as fast; leaving stops collection and the rest stays for later', () => {
  const g = create();
  const c = quietCache(g, 50);
  const [a, b] = collectors(g, c, 2);
  ticks(g, 30);   // 3 s at 10 a second
  const got = 50 - c.amount;
  assert.ok(got >= 25 && got <= 30, `two units: ~30 in 3 s (got ${got})`);
  // both walk away: nothing more is collected and the cache keeps the rest
  for (const u of [a, b]) { const x = u.x, z = u.z; u.x += 3; u.tile = tileAt(u.x, u.z); g.movers.moved(u, x, z); }
  const left = c.amount;
  ticks(g, 30);
  assert.equal(c.amount, left, 'no collection once the units left');
  assert.ok(c.active && c.amount > 0, 'the partial cache stays on the map');
  const wire = g.command(0, { c: 'collect', cache: c.id, units: [a.id] });
  assert.ok(!wire?.error, wire?.error);
});

test('energy caches spawn on neutral, walkable ground away from bases, deterministically, and survive a save', async () => {
  const run = () => {
    const g = create(7);
    ticks(g, Math.round((ENERGY_CACHES.first + ENERGY_CACHES.every * 2 + ENERGY_CACHES.jitter * 2 + 2) * 10));
    return g;
  };
  const g = run(), h = run();
  const energy = (game) => [...game.materialCaches.values()].filter((c) => c.resource === 'energy');
  assert.ok(energy(g).length >= 2, `energy caches appeared (${energy(g).length})`);
  assert.deepEqual(energy(g).map((c) => [c.id, c.x, c.z, c.amount]), energy(h).map((c) => [c.id, c.x, c.z, c.amount]), 'deterministic');
  for (const c of energy(g)) {
    assert.ok(g.world.owner[c.tile] < 0 || !c.active, 'placed on neutral ground');
    assert.ok(g.nav.canStand(c.x, c.z, LIGHT_GROUND), 'walkable');
    for (const s of g.sites.filter((s) => s.slots)) assert.ok(distance(s, c) >= ENERGY_CACHES.baseGap - 1e-6, 'away from bases');
    assert.ok(ENERGY_CACHES.amounts.includes(c.max));
  }
  assert.ok(energy(g).length <= ENERGY_CACHES.cap(2));
  // wire: visible as energy with its size
  g.civs[0].visible.fill(1);
  const { visibleCaches } = await import('../server/sim/actionEconomy.js');
  const wire = visibleCaches(g, g.civs[0]).filter((r) => r.resource === 'energy');
  assert.ok(wire.length && wire.every((r) => r.max >= r.amount && r.amount > 0));
  // save / restore keeps the schedule: both continue identically
  const copy = deserializeGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.equal(copy.energyCacheAt, g.energyCacheAt);
  ticks(g, 900); ticks(copy, 900);
  assert.equal(stateHash(copy), stateHash(g), 'a restored match spawns the same caches');
});

test('energy caches are collected into the Energy stockpile at the same pace', () => {
  const g = create(), civ = g.civs[0];
  const c = quietCache(g, 40, 'energy');
  collectors(g, c, 2);
  const energy0 = civ.res.energy;
  ticks(g, 41);
  assert.ok(!c.active, 'two units empty a 40 energy cache in ~4 s');
  assert.ok(civ.res.energy - energy0 >= 40, 'paid into the Energy stockpile');
  const events = g.events.filter((e) => e.k === 'pickup' && e.cache === c.id);
  assert.ok(events.length && events.every((e) => e.resource === 'energy' && e.amount === 5));
  assert.equal(events.at(-1).o, 'empty', 'the last chunk marks the cache emptied');
});

test('trained units come out of the producing facility door and walk to an assembly point in front of it', () => {
  const g = create(), civ = g.civs[0], site = g.sites[0];
  civ.res = { materials: 20000, energy: 20000 };
  const barracks = addFacility(g, civ, site, 'barracks', openSlots(g, site)[0], { instant: true });
  const known = new Set(g.units.keys());
  assert.ok(!g.command(0, { c: 'train', ids: [barracks.id], type: 'rifle_squad', count: 2 }).error);
  let u = null, emerged = null;
  for (let i = 0; i < 400 && !u; i++) {
    g.tick();
    u = [...g.units.values()].find((v) => !known.has(v.id) && v.type === 'rifle_squad');
    emerged ??= g.events.find((e) => e.k === 'emerge' && e.s);
  }
  assert.ok(u, 'a squad was produced');
  assert.ok(emerged && emerged.s === u.id, 'an emerge event for the client');
  const fx = Math.sin(barracks.yaw), fz = Math.cos(barracks.yaw);
  // it appeared against the facility's front face (towards the hub), not on a ring around it: since 2026-11-20 right
  // outside the modelled door of the Blender barracks (FACILITY_DOORS), clear of its walls
  const dx = u.x - barracks.x, dz = u.z - barracks.z;
  const along = dx * fx + dz * fz;
  const door = g.buildingPoint(barracks, ...FACILITY_DOORS.barracks[0]);
  assert.ok(along > FACILITY_DOORS.barracks[0][1], `in front of the facility (along ${along.toFixed(2)})`);
  // (a starting scout buggy stands just outside this door: the squad steps out beside it)
  assert.ok(distance(u, door) < .6, `right at the door (${distance(u, door).toFixed(2)})`);
  assert.ok(u.goal, 'it walks out to the assembly point');
  const goal = u.goal;
  assert.ok((goal.x - barracks.x) * fx + (goal.z - barracks.z) * fz > along, 'the assembly point is further out in front');
  // with a rally point it heads there instead
  const rally = { x: barracks.x + fx * 3, z: barracks.z + fz * 3 };
  barracks.rally = rally;
  const second = new Set(g.units.keys());
  let v = null;
  for (let i = 0; i < 400 && !v; i++) { g.tick(); v = [...g.units.values()].find((w) => !second.has(w.id) && w.type === 'rifle_squad'); }
  assert.ok(v && v.goal && distance(v.goal, rally) < 1, 'the rally point wins');
});

test('infantry climb less steep slopes: .50 (26.6 deg), still more than tracks and wheels; maxSlope reaches the client', () => {
  assert.equal(MAX_GRADIENT.infantry, .5);
  assert.ok(MAX_GRADIENT.infantry > MAX_GRADIENT.tracked && MAX_GRADIENT.tracked > MAX_GRADIENT.wheeled);
  assert.equal(MAX_SLOPE_DEG.infantry, 26.6);
  const g = create();
  assert.equal(g.defs.UNITS.rifle_squad.maxSlope, 26.6);
  assert.equal(g.defs.UNITS.tank.maxSlope, MAX_SLOPE_DEG.tracked);
  assert.equal(g.defs.UNITS.scout_buggy.maxSlope, MAX_SLOPE_DEG.wheeled);
  assert.equal(g.defs.UNITS.fighter.maxSlope, null);
});

test('every start and base stays reachable on foot across map styles with the lower climb limit', () => {
  for (const style of ['pangaea', 'continents', 'archipelago', 'inlandSea']) for (const seed of [3, 29]) {
    const g = new ActionGame({ id: `reach-${style}-${seed}`, seed, style, slots: [{ human: true }, { human: true }] });
    const starts = g.civs.map((c) => g.sites[c.id]);
    for (const s of starts) {
      for (const other of starts) {
        if (s === other) continue;
        const ok = g.nav.strategic(s.tile, other.tile, LIGHT_GROUND, false, true, 1e9);
        assert.ok(ok, `${style} seed ${seed}: ${s.name} reaches ${other.name} on foot`);
      }
    }
    for (const site of g.sites.filter((x) => x.slots))
      assert.ok(g.nav.strategic(starts[0].tile, site.tile, LIGHT_GROUND, false, true, 1e9), `${style} seed ${seed}: base ${site.name} reachable on foot`);
  }
});

test('troop upgrades are removed: refused, gone from the definitions, refunded from an older save', () => {
  for (const key of Object.keys(REMOVED_UPGRADES)) assert.equal(ACTION_UPGRADES[key], undefined, key);
  assert.deepEqual(Object.keys(ACTION_UPGRADES), [], 'the Armory command upgrades went too (2026-11-20)');
  const g = create(), civ = g.civs[0], site = g.sites[0];
  civ.res = { materials: 5000, energy: 5000 }; civ.age = 2;
  const slots = openSlots(g, site);
  const barracks = addFacility(g, civ, site, 'barracks', slots[0], { instant: true });
  for (const key of ['grenades', 'body_armor', 'heavy_armor', 'infantry_training', 'aircraft_systems']) {
    const r = g.command(0, { c: 'research', tech: key });
    assert.equal(r.code, 'upgrade_removed', key);
    assert.match(r.error, /removed/);
  }
  assert.ok(Object.keys(g.defs.TECHS).every((k) => !REMOVED_UPGRADES[k]), 'the client is offered none');
  // an older save: one removed upgrade owned, another in progress -> both refunded, techs dropped
  barracks.project = { kind: 'upgrade', key: 'heavy_armor', left: 10, total: 40 };
  civ.techs.add('grenades');
  const res = { ...civ.res };
  const copy = deserializeGame(JSON.parse(JSON.stringify(serializeGame(g))));
  const c0 = copy.civs[0];
  assert.ok(!c0.techs.has('grenades'));
  assert.equal(copy.buildings.get(barracks.id).project, null);
  assert.equal(c0.res.materials, res.materials + REMOVED_UPGRADES.grenades.cost.materials + REMOVED_UPGRADES.heavy_armor.cost.materials);
  assert.equal(c0.res.energy, res.energy + REMOVED_UPGRADES.grenades.cost.energy + REMOVED_UPGRADES.heavy_armor.cost.energy);
});
