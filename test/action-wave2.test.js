// Wave 2 server fixes (2026-11-16, W2-S): roads kept out of base foundations, field guns that set up under
// attack-move, small arms against low-flying aircraft, slower repairs under fire, the AI's air mix and the
// decisive-domination victory rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS, DOMINANCE } = await import('../server/sim/actionDefinitions.js');
const { addFacility, productionStep } = await import('../server/sim/actionBases.js');
const { centerOf, distance } = await import('../server/sim/actionNavigation.js');
const { canEngage } = await import('../server/sim/actionCombat.js');
const { airChoice } = await import('../server/sim/actionAI.js');
const { ROAD_FOUNDATION } = await import('../server/sim/actionEconomy.js');
const { disk } = await import('../server/sim/hex.js');
const { N } = await import('../server/sim/constants.js');

const create = () => new ActionGame({ id: 'b-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });

test('player roads are refused inside a base foundation with code "foundation"', () => {
  const g = create();
  g.civs[0].res = { materials: 20000, energy: 20000 }; g.civs[0].visible.fill(1);
  const home = g.sites[0];
  const ring = disk(home.tile, 4).filter((t) => g.world.owner[t] === 0).map(centerOf).filter((c) => distance(c, home) > 2.9);
  let refused = null, allowed = null;
  for (const a of ring) for (const b of ring) {
    if (refused && allowed) break;
    const r = g.command(0, { c: 'roadBuild', points: [a, b], preview: true });
    if (r.code === 'foundation') refused ??= { a, b, r };
    else if (!r.error) allowed ??= r.reply.road;
  }
  assert.ok(refused, 'a route across the base centre is refused');
  assert.match(refused.r.error, /foundation/);
  assert.equal(g.command(0, { c: 'roadBuild', points: [refused.a, refused.b] }).code, 'foundation', 'the build is refused like the preview');
  assert.ok(allowed, 'routes around the base are still allowed');
  for (const p of allowed.positions) for (const t of [0, .5, 1])
    assert.ok(distance(home, { x: p.from.x + (p.to.x - p.from.x) * t, z: p.from.z + (p.to.z - p.from.z) * t }) >= ROAD_FOUNDATION - 1e-6);
});

// a flat, empty field between the two capitals
function arena() {
  const g = create();
  g.sandbox = true;
  const centre = { x: (g.sites[0].x + g.sites[1].x) / 2, z: (g.sites[0].z + g.sites[1].z) / 2 };
  for (const b of [...g.buildings.values()]) if (distance(b, centre) < 14) g.removeBuilding(b);
  const w = g.world;
  for (let t = 0; t < N; t++) {
    if (distance(centerOf(t), centre) > 11) continue;
    w.elev[t] = .15; w.moist[t] = .4; w.river[t] = 0; w.flow[t] = 0; w.terr[t] = 255; w.classify(t); w.touch(t);
  }
  g.units.clear(); g.movers.clear(); g.nav.invalidate();
  for (const c of g.civs) c.visible.fill(1);
  return { g, centre };
}

test('a field gun on attack-move halts and sets up at range instead of driving into the tank it engages', () => {
  const { g, centre } = arena();
  const gun = g.spawn(g.civs[0], 'field_gun', { x: centre.x - 4, z: centre.z }, .05);
  const tank = g.spawn(g.civs[1], 'tank', { x: centre.x + 3.8, z: centre.z }, .05);
  assert.ok(gun && tank);
  g.command(1, { c: 'hold', units: [tank.id] });
  g.command(0, { c: 'move', units: [gun.id], point: { x: centre.x + 8, z: centre.z }, attackMove: true });
  let deployedAt = null;
  for (let i = 0; i < 150 && deployedAt == null; i++) { g.tick(); g.outbox.length = 0; if (gun.deployed) deployedAt = distance(gun, tank); }
  assert.ok(deployedAt != null, 'the gun set up');
  assert.ok(deployedAt > ACTION_UNITS.tank.range + .8, `set up at ${deployedAt?.toFixed(2)}, outside the tank's reach`);
  for (let i = 0; i < 60; i++) { g.tick(); g.outbox.length = 0; }
  assert.ok(tank.hp < tank.maxHp, 'the gun fired');
  assert.ok(distance(gun, tank) > ACTION_UNITS.tank.range, 'and kept its standoff range');
});

test('small arms engage helicopters (weakly); tank cannons still cannot', () => {
  const { g, centre } = arena();
  const rifles = g.spawn(g.civs[0], 'rifle_squad', centre, .05);
  const tank = g.spawn(g.civs[0], 'tank', { x: centre.x, z: centre.z + 1 }, .05);
  const heli = g.spawn(g.civs[1], 'helicopter', { x: centre.x + 1, z: centre.z }, .05);
  const fighter = g.spawn(g.civs[1], 'fighter', { x: centre.x + 1, z: centre.z + .5 }, .05);
  assert.equal(canEngage(rifles, heli), true);
  assert.equal(canEngage(rifles, fighter), false, 'jets (the Warthog included) stay out of small-arms reach');
  assert.equal(canEngage(tank, heli), false);
});

test('repairs slow to 30% while the structure is under fire', () => {
  const g = create();
  const hq = g.buildings.get(g.sites[0].hq);
  const gain = (underFire) => {
    hq.hp = hq.maxHp * .4; hq.project = { kind: 'repair', left: 17, total: 17 };
    hq.hitAt = underFire ? g.time : -99;
    const before = hq.hp; productionStep(g, 1); return hq.hp - before;
  };
  const calm = gain(false), shelled = gain(true);
  assert.ok(calm > 0);
  assert.ok(Math.abs(shelled / calm - .3) < .02, `ratio ${(shelled / calm).toFixed(2)}`);
});

test('AI airfields build a mix: helicopters and Warthogs (never extra jets against enemy air), capped share', () => {
  const army = (types) => types.map((type, id) => ({ id, type }));
  const counter = (own) => (type) => own.filter((u) => u.type === type).length;
  const ground = Array(24).fill('rifle_squad');
  let own = army([...ground, 'recon_drone']);
  assert.equal(airChoice(own, counter(own), 0, 2), 'helicopter');
  own = army([...ground, 'recon_drone', 'helicopter']);
  assert.equal(airChoice(own, counter(own), 0, 2), 'fighter');
  const jet = army([...ground, 'recon_drone', 'fighter']);
  assert.equal(airChoice(jet, counter(jet), 4, 2), 'helicopter', 'enemy air does not call for Warthogs: they cannot intercept');
  own = army([...ground, 'recon_drone', 'helicopter', 'helicopter', 'fighter', 'fighter']);
  assert.equal(airChoice(own, counter(own), 0, 2), null, 'air stays near 18% of the army');
});

test('decisive domination: 65% of headquarters and 2.5x the army for 90 s wins from minute 18', () => {
  const g = create();
  const free = g.sites.filter((s) => s.slots && s.owner < 0).slice(0, 2);
  assert.equal(free.length, 2);
  for (const s of free) {
    s.owner = 0;
    const hq = addFacility(g, g.civs[0], s, 'town', s.tile, { instant: true });
    s.hq = hq.id;
  }
  // civ 1 keeps one rifle squad: civ 0's start roster (3 squads and a buggy) is then over 3x its army
  for (const u of [...g.units.values()].filter((v) => v.owner === 1 && !v.auto).slice(1)) g.units.delete(u.id);
  const alive = () => g.civs.filter((c) => c.alive);
  g.time = DOMINANCE.after - 10;
  g.checkVictory();
  assert.equal(g.dominance, null, 'not before minute 18');
  g.time = DOMINANCE.after + 1;
  g.checkVictory();
  assert.equal(g.dominance?.team, g.civs[0].team);
  g.time += DOMINANCE.hold - 1; g.checkVictory();
  assert.equal(g.over, false);
  g.time += 2; g.checkVictory();
  assert.equal(g.over, true);
  assert.equal(g.winner.how, 'Decisive Domination', JSON.stringify(g.winner));
  assert.equal(g.winner.civ, 0);
  assert.equal(alive().length, 2, 'the beaten side still had a headquarters');
});
