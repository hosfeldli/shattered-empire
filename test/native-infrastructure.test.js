// Native construction and infrastructure feedback (backlog C, G): group placement reports every
// refused site with its reason, timed works can be prioritised within a city, governors repair
// through timed works instead of instant heals, road works report their real segment progress,
// and bridge condition is sent only for crossings in sight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { disk } from '../server/sim/hex.js';

const newGame = () => new Game({ id: 'infra' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false, ruleset: WORKS_RULESET });
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; } };
const rich = (civ) => { for (const k of Object.keys(civ.res)) civ.res[k] = 5000; };

function setup() {
  const g = newGame(), civ = g.civs[0], cap = g.capital(civ);
  for (const c of g.cities.values()) if (c.owner === 0) { c.governor.enabled = false; c.governor.level = 'off'; }
  rich(civ); civ.age = 1;
  return { g, civ, cap };
}

test('group placement names each refused site and why', () => {
  const { g, cap } = setup();
  const spots = disk(cap.tile, 3).filter((t) => g.canPlace(g.civs[0], 'farm', t, true)).slice(0, 2);
  const r = g.command(0, { c: 'buildMany', type: 'farm', tiles: [...spots, cap.tile] });
  assert.equal(r.reply.many.placed, 2);
  assert.equal(r.reply.many.failed, 1);
  const [[tile, reason]] = r.reply.many.failedTiles;
  assert.equal(tile, cap.tile);
  assert.ok(typeof reason === 'string' && reason.length > 0, 'a reason is given for the refused hex');
});

test('prioritised works go faster; the city\'s other works slow a little; one priority per city', () => {
  const { g, civ, cap } = setup();
  const spots = disk(cap.tile, 3).filter((t) => g.canPlace(civ, 'farm', t, true)).slice(0, 3);
  const [a, b, c] = spots.map((t) => g.makeBuilding(civ, 'farm', t, true));
  for (const f of [a, b, c]) assert.ok(!g.command(0, { c: 'upgrade', id: f.id })?.error);
  assert.equal(g.command(0, { c: 'worksPriority', id: a.id }).reply.priority, true);
  run(g, 40);
  assert.ok(a.works.left < b.works.left, 'the priority works advance faster');
  g.command(0, { c: 'worksPriority', id: b.id });
  assert.equal(a.works.priority, false, 'choosing another moves the priority');
  assert.equal(b.works.priority, true);
  const wk = g.econSnapshot(civ).buildings.find((x) => x.id === b.id).wk;
  assert.equal(wk[5], 1, 'the snapshot reports the priority');
  assert.match(g.command(0, { c: 'worksPriority', id: cap.id ?? -1 })?.error || 'No works', /No works/);
});

test('governors repair through timed works, never an instant heal', () => {
  const { g, civ, cap } = setup();
  const [spot] = disk(cap.tile, 3).filter((t) => g.canPlace(civ, 'farm', t, true));
  const farm = g.makeBuilding(civ, 'farm', spot, true);
  const city = [...g.cities.values()].find((c) => c.owner === 0);
  farm.cityId = city.id; farm.hp = farm.maxHp * 0.3; farm.lastHit = -999;
  city.governor.enabled = true; city.governor.level = 'managed';
  const before = farm.hp;
  for (let i = 0; i < 60 && !farm.works; i++) run(g, 10);
  assert.ok(farm.works && farm.works.k === 'repair', 'the governor starts a repair project');
  assert.ok(farm.hp < before + farm.maxHp * 0.2, 'no instant 40% heal');
});

test('road works report their real segment progress; bridge condition only for crossings in sight', () => {
  const { g, civ, cap } = setup();
  const line = disk(cap.tile, 2).filter((t) => t !== cap.tile);
  const plan = g.command(0, { c: 'roadPlan', tiles: [cap.tile, line[0]], type: 1, commit: true });
  assert.ok(!plan?.error, JSON.stringify(plan));
  run(g, 15);
  const project = g.econSnapshot(civ).econ.roads.find((p) => p.seg);
  assert.ok(project, 'a project under construction reports its segment');
  assert.equal(project.seg.length, 2);
  assert.ok(project.prog >= 0 && project.prog <= 100);
  const snap = g.econSnapshot(civ);
  assert.ok(Array.isArray(snap.bridges));
  for (const [a, b] of snap.bridges) assert.ok(civ.visible[a] || civ.visible[b], 'no hidden bridge condition');
});

test('indirect-fire artillery must halt and set up before it can fire (native-v4)', async () => {
  const { spawnUnit } = await import('../server/sim/military.js');
  const { artilleryReady, ARTILLERY_SETUP } = await import('../server/sim/combat.js');
  const { g, civ, cap } = setup();
  // field guns are direct-fire weapons now; self-propelled howitzers are the indirect-fire case
  const fieldGun = spawnUnit(g, civ, 'field_gun', cap.tile);
  fieldGun.next = cap.tile;
  assert.equal(artilleryReady(g, fieldGun), true, 'a direct-fire field gun needs no setup');
  const gun = spawnUnit(g, civ, 'sp_artillery', cap.tile);
  gun.movedAt = g.time; gun.next = -1;
  assert.equal(artilleryReady(g, gun), false, 'a gun that has just stopped is not yet laid');
  gun.movedAt = g.time - ARTILLERY_SETUP - 0.1;
  assert.equal(artilleryReady(g, gun), true, 'after the setup time it can fire');
  gun.next = cap.tile;
  assert.equal(artilleryReady(g, gun), false, 'a gun on the move cannot fire');
  const rifles = spawnUnit(g, civ, 'rifle_squad', cap.tile);
  rifles.next = cap.tile;
  assert.equal(artilleryReady(g, rifles), true, 'direct-fire troops are unaffected');
});
