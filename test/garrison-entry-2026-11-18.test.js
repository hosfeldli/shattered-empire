// Garrison entry in play (2026-11-18; docs/gameplay-overhaul/CAPTURE_AND_GARRISON.md, "Fix 2026-11-18").
// The player's report: "the troops never actually garrison, they just go over to the building". The cause was the
// client's right-click on an own structure (Garrison cursor) sending a plain `move`, which also clears `u.enter`.
// These tests replay exactly what the client sends now (Commander.GarrisonOrder / Hud.GarrisonInto):
//   {c:'garrison', units:[eligible ids], building:id}  (+ {c:'move', units:[rest], point} for the rest of the selection)
// on real map structures (the starting headquarters, a placed bunker and watchtower, a parcel barracks), from far
// away and from several directions, and check that the squads end up inside (flag 16384, econ `gar`).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { addFacility } = await import('../server/sim/actionBases.js');
const { tileAt, distance } = await import('../server/sim/actionNavigation.js');

const create = (seed = 7) => new ActionGame({ id: 'garrison-entry', seed, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const hqOf = (g, owner) => [...g.buildings.values()].find((b) => b.owner === owner && b.type === 'town');

function clearArmy(g) {
  for (const u of [...g.units.values()]) if (!u.auto) g.units.delete(u.id);
  for (const b of g.buildings.values()) if (b.garrison) b.garrison = [];
  g.garrisonQueue = undefined;
  g.movers.clear(); g.targets.clear();
  for (const u of g.units.values()) { g.movers.add(u); g.targets.add(u); }
  for (const b of g.buildings.values()) g.targets.add(b);
}

/** Exactly the client's right-click: eligible squads get `garrison`, the rest of the selection a plain move. */
function rightClick(g, selection, b) {
  // the client's Commander.GarrisonEligible: defs UNITS capture && !auto && !air
  const eligible = selection.filter((u) => { const d = ACTION_UNITS[u.type]; return d.capture && !d.auto && !d.air; });
  const rest = selection.filter((u) => !eligible.includes(u));
  const reply = g.command(0, { c: 'garrison', units: eligible.map((u) => u.id), building: b.id });
  if (rest.length) g.command(0, { c: 'move', units: rest.map((u) => u.id), point: { x: b.x, z: b.z } });
  return reply;
}

function structures(g) {
  const civ = g.civs[0], hq = hqOf(g, 0);
  const list = [hq];
  for (const [type, dx, dz] of [['bunker', 3, 2], ['guard_post', -3, 2]]) {
    const p = { x: hq.x + dx, z: hq.z + dz, yaw: 0 };
    list.push(addFacility(g, civ, null, type, tileAt(p.x, p.z), { instant: true, point: p }));
  }
  const site = g.siteById.get(hq.site);
  const parcel = site.parcels.find((p) => p.id > 0 && ![...g.buildings.values()].some((b) => b.site === site.id && b.slot === p.id));
  if (parcel) list.push(addFacility(g, civ, site, 'barracks', parcel.id, { instant: true }));
  return list;
}

test('right-click garrison from far away: squads walk to real structures and end up inside', () => {
  for (const seed of [7, 41]) {
    const g = create(seed), civ = g.civs[0], hq = hqOf(g, 0);
    for (const b of structures(g)) {
      for (const dir of [0, 3, 5]) {
        clearArmy(g);
        const a = dir * Math.PI / 4;
        const from = { x: hq.x + Math.sin(a) * 9, z: hq.z + Math.cos(a) * 9 };
        const squads = ['rifle_squad', 'rifle_squad', 'anti_armor', 'militia'].map((t) => g.spawn(civ, t, from, 1.2)).filter(Boolean);
        const tank = g.spawn(civ, 'tank', from, 1.5);
        assert.ok(squads.length >= 3, 'spawned squads');
        const cap = ACTION_BUILDINGS[b.type].garrison, want = Math.min(cap, squads.length);
        const r = rightClick(g, [...squads, tank].filter(Boolean), b);
        assert.ok(!r.error, `${b.type}: ${r.error}`);
        assert.equal(r.moving + r.entered, want);
        for (let t = 0; t < 900 && (b.garrison?.length || 0) < want; t++) g.tick();
        assert.equal(b.garrison.length, want, `seed ${seed} ${b.type} dir ${dir}: ${b.garrison.length}/${want} inside; out: ${squads.filter((u) => !u.inside).map((u) => distance(u, b).toFixed(2)).join(',')}`);
        // on the wire: the owner's units snapshot flags them inside, the econ lists them on the structure
        const rows = g.unitSnapshot(civ, { god: false }).units;
        for (const id of b.garrison) assert.ok(rows.find((row) => row[0] === id)[8] & 16384, 'flag 16384');
        const econ = g.econSnapshot(civ, { vis: civ.visible, god: false, explored: civ.explored });
        assert.deepEqual(econ.buildings.find((x) => x.id === b.id).gar, b.garrison);
        if (tank) assert.ok(!tank.inside, 'vehicles never enter');
      }
    }
  }
});

test('the old right-click (a plain move onto the structure) does not garrison, and cancels a garrison walk', () => {
  const g = create(), civ = g.civs[0], hq = hqOf(g, 0);
  clearArmy(g);
  const from = { x: hq.x + 8, z: hq.z + 3 };
  const squads = [0, 1].map(() => g.spawn(civ, 'rifle_squad', from, 1));
  g.command(0, { c: 'garrison', units: squads.map((u) => u.id), building: hq.id });
  g.command(0, { c: 'move', units: squads.map((u) => u.id), point: { x: hq.x, z: hq.z } });
  for (let t = 0; t < 400; t++) g.tick();
  assert.equal(hq.garrison?.length || 0, 0, 'a move never garrisons');
  assert.ok(squads.every((u) => !u.enter && !u.inside));
});

test('refusals: full, wrong unit type, already inside; ungarrison brings them out', () => {
  const g = create(), civ = g.civs[0], hq = hqOf(g, 0);
  const [, bunker] = structures(g);
  clearArmy(g);
  const near = { x: bunker.x + .9, z: bunker.z };
  const squads = [0, 1, 2].map(() => g.spawn(civ, 'rifle_squad', near, .5));
  const r = rightClick(g, squads, bunker);
  assert.equal(r.refused, 1, 'third squad turned away (2 places)');
  for (let t = 0; t < 200 && bunker.garrison.length < 2; t++) g.tick();
  assert.equal(bunker.garrison.length, 2);
  assert.match(g.command(0, { c: 'garrison', units: [squads.find((u) => !u.inside).id], building: bunker.id }).error, /full/);
  assert.match(g.command(0, { c: 'garrison', units: squads.filter((u) => u.inside).map((u) => u.id), building: bunker.id }).error, /already inside/);
  const mortar = g.spawn(civ, 'mortar_team', { x: hq.x + 1.5, z: hq.z }, .8);
  assert.match(g.command(0, { c: 'garrison', units: [mortar.id], building: hq.id }).error, /Only infantry/);
  const out = g.command(0, { c: 'ungarrison', building: bunker.id, all: true });
  assert.equal(out.ungarrisoned, 2);
  assert.equal(bunker.garrison.length, 0);
  assert.ok(squads.every((u) => !u.inside));
  g.tick();
  for (const u of squads) assert.ok(g.movers.query(u.x, u.z, .5, []).includes(u), 'back in movement');
});
