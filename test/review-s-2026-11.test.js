// Review S (2026-11-16): regressions for the fixes made while reviewing the server side of the feedback
// round: save determinism (weather climate), perimeter level reset on capture, decisive-domination
// countdown in saves, functional Aircraft Systems / Infantry Training, per-tick stockpile on snapshots,
// team on the winner, per-player road project limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS, DOMINANCE } = await import('../server/sim/actionDefinitions.js');
const { addFacility } = await import('../server/sim/actionBases.js');
const { airSpeed, maxFuel, patrolRange } = await import('../server/sim/actionAir.js');
const { damageActionTarget } = await import('../server/sim/actionCombat.js');
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');

const create = (extra = {}) => new ActionGame({ id: 'review-s', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }], ...extra });

test('a restored save evolves the same weather (climate recomputed after the action map reshapes terrain)', () => {
  const g = create();
  for (let i = 0; i < 30; i++) g.tick();
  const r = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  for (const k of ['sea', 'relief', 'riv']) assert.deepEqual([...r.weather[k]], [...g.weather[k]], k);
  for (let i = 0; i < 40; i++) { g.tick(); r.tick(); }
  assert.equal(stateHash(r), stateHash(g));
});

test('a captured base does not inherit the previous owner\'s perimeter level or city AA', () => {
  const g = create(), s = g.sites[1];
  s.defenseLevel = 2;
  assert.equal(g.siteWire(s, g.civs[1], true).aa, 1);
  g.loseBuilding(g.buildings.get(s.hq));
  assert.equal(s.defenseLevel, 1);
  assert.equal(g.siteWire(s, g.civs[0], true).aa, undefined);
});

test('a running decisive-domination countdown survives a save and restore', () => {
  const g = create();
  for (const s of g.sites.filter((s) => s.slots && s.owner < 0).slice(0, 2)) { s.owner = 0; addFacility(g, g.civs[0], s, 'town', s.tile, { instant: true }); }
  for (const u of [...g.units.values()].filter((v) => v.owner === 1 && !v.auto).slice(1)) g.units.delete(u.id);
  g.time = DOMINANCE.after + 1; g.checkVictory();
  assert.ok(g.dominance);
  const r = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.deepEqual(r.dominance, g.dominance);
  r.time = g.dominance.since + DOMINANCE.hold + 1; r.checkVictory();
  assert.equal(r.winner?.how, 'Decisive Domination');
  assert.equal(r.winner.team, r.civs[0].team, 'the winner names the winning team');
});

test('snapshots between econ updates carry the stockpile so per-tick income shows smoothly', () => {
  const g = create(), civ = g.civs[0];
  const view = { civ, vis: civ.visible, explored: civ.explored, god: false };
  const quick = g.viewerSnapshot(civ, view, false, false);
  assert.deepEqual(quick.res, { materials: Math.floor(civ.res.materials), energy: Math.floor(civ.res.energy) });
  for (let i = 0; i < 10; i++) g.tick();
  const later = g.viewerSnapshot(civ, view, false, false).res.materials;
  assert.ok(later > quick.res.materials, 'income accrued between econ updates');
  assert.equal(g.viewerSnapshot(civ, view, false, true).res, undefined, 'the econ block carries it on econ ticks');
});

test('the road project limit is per player, and a fallen player\'s works are cleared', () => {
  const g = create();
  for (let i = 0; i < 24; i++) g.roadProjects.push({ id: 9000 + i, owner: 1, edges: [{ a: 0, b: 1 }], left: 5, total: 5 });
  const c0 = g.civs[0]; c0.res.materials = 5000; c0.visible.fill(1);
  const hq = g.sites[0];
  const r = g.command(0, { c: 'roadBuild', points: [{ x: hq.x + 3.2, z: hq.z - 1.5 }, { x: hq.x + 3.2, z: hq.z + 1.5 }] });
  assert.ok(!r.error || !/Finish an existing road project/.test(r.error), r.error);
  g.civs[1].alive = true;
  for (const b of [...g.buildings.values()].filter((b) => b.owner === 1)) g.loseBuilding(b);
  for (const u of [...g.units.values()].filter((u) => u.owner === 1)) g.units.delete(u.id);
  g.civs[1].res.materials = 0;
  g.time = 1; g.checkVictory(); g.time = 100; g.checkVictory();
  assert.equal(g.civs[1].alive, false);
  assert.ok(!g.roadProjects.some((p) => p.owner === 1));
});

test('command acks carry the refusal code (fieldBuild territory, roadBuild foundation) as the worker sends them', async () => {
  const { commandAck } = await import('../server/commandAck.js');
  const g = create(), c0 = g.civs[0]; c0.res = { materials: 5000, energy: 5000 }; c0.visible.fill(1);
  const enemy = g.sites[1];
  const field = commandAck(g.command(0, { c: 'fieldBuild', type: 'bunker', point: { x: enemy.x + .9, z: enemy.z } }), 7);
  assert.equal(field.t, 'ack'); assert.equal(field.rid, 7);
  assert.ok(field.error); assert.equal(field.code, 'territory');
  const home = g.sites[0];
  const road = commandAck(g.command(0, { c: 'roadBuild', points: [{ x: home.x - 2.2, z: home.z + .4 }, { x: home.x + 2.2, z: home.z - .4 }] }), 8);
  assert.ok(road.error, 'a road through the own base foundation is refused');
  assert.equal(road.code, 'foundation', road.error);
  const ok = commandAck({}, 9);
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), { t: 'ack', rid: 9 });
});
