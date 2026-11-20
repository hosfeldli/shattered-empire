// 2026-11-19 (user: "make it so that missile trucks need to setup"): the missile battery (ACTION_UNITS.missile_battery.setup)
// halts and sets up for 5 s before its first salvo, packs up when it moves, and its Area Bombardment waits for the set-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { centerOf, distance } = await import('../server/sim/actionNavigation.js');
const { N } = await import('../server/sim/constants.js');

const SETUP = ACTION_UNITS.missile_battery.setup;

// a flat, empty, fully scouted field between the two capitals (as action-wave2.test.js)
function arena() {
  const g = new ActionGame({ id: 'missile-setup', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
  g.sandbox = true;
  const centre = { x: (g.sites[0].x + g.sites[1].x) / 2, z: (g.sites[0].z + g.sites[1].z) / 2 };
  for (const b of [...g.buildings.values()]) if (distance(b, centre) < 16) g.removeBuilding(b);
  const w = g.world;
  for (let t = 0; t < N; t++) {
    if (distance(centerOf(t), centre) > 13) continue;
    w.elev[t] = .15; w.moist[t] = .4; w.river[t] = 0; w.flow[t] = 0; w.terr[t] = 255; w.classify(t); w.touch(t);
  }
  g.units.clear(); g.movers.clear(); g.nav.invalidate();
  for (const c of g.civs) { c.visible.fill(1); c.explored.fill(1); }
  return { g, centre };
}
const launches = (g, u) => g.events.filter((e) => e.k === 'launch' && e.s === u.id).length;
const step = (g) => { g.tick(); g.outbox.length = 0; };

test('missile battery: set-up time is 5 s', () => {
  assert.equal(SETUP, 5);
});

test('a moving missile battery does not fire until it has stood still for the full set-up', () => {
  const { g, centre } = arena();
  const mb = g.spawn(g.civs[0], 'missile_battery', { x: centre.x - 9, z: centre.z }, .05);
  const tank = g.spawn(g.civs[1], 'tank', { x: centre.x + 5, z: centre.z }, .05);
  assert.ok(mb && tank);
  g.command(1, { c: 'hold', units: [tank.id] });
  g.command(0, { c: 'move', units: [mb.id], point: { x: centre.x + 8, z: centre.z }, attackMove: true });
  let stoppedAt = null, firedAt = null, firedWhileMoving = false;
  for (let i = 0; i < 400 && firedAt == null; i++) {
    const before = launches(g, mb);
    step(g);
    const moving = !!(mb.vx || mb.vz);
    if (moving) stoppedAt = null; else stoppedAt ??= g.time;
    if (launches(g, mb) > before) { firedAt = g.time; firedWhileMoving = moving; }
  }
  assert.ok(firedAt != null, 'the battery fired');
  assert.ok(!firedWhileMoving, 'never fires on the move');
  assert.ok(stoppedAt != null && firedAt - stoppedAt >= SETUP - .25, `stood still ${(firedAt - stoppedAt).toFixed(2)} s before firing`);
  assert.equal(mb.deployed, true);
  assert.ok(distance(mb, tank) < ACTION_UNITS.missile_battery.range + .5, 'halted at range instead of driving on');
});

test('a deployed missile battery packs up when it moves', () => {
  const { g, centre } = arena();
  // inside its own sight (vision ~5.7): a missile battery needs the target spotted
  const mb = g.spawn(g.civs[0], 'missile_battery', { x: centre.x + .5, z: centre.z }, .05);
  const tank = g.spawn(g.civs[1], 'tank', { x: centre.x + 5, z: centre.z }, .05);
  g.command(1, { c: 'hold', units: [tank.id] });
  for (let i = 0; i < 300 && !mb.deployed; i++) step(g);
  assert.equal(mb.deployed, true, 'set up against the tank');
  g.command(0, { c: 'move', units: [mb.id], point: { x: centre.x - 9, z: centre.z + 2 } });
  for (let i = 0; i < 60 && !(mb.vx || mb.vz); i++) step(g);
  step(g);
  assert.equal(mb.deployed, false, 'moving packs the launcher up');
  assert.equal(mb.setupUntil, 0);
});

test('Area Bombardment waits for the missile battery to set up; moving cancels it and returns the cooldown', () => {
  const { g, centre } = arena();
  const mb = g.spawn(g.civs[0], 'missile_battery', { x: centre.x - 3, z: centre.z }, .05);
  const point = { x: centre.x + 4, z: centre.z + 1 };
  // not deployed: the order is accepted but nothing launches before the set-up is complete
  let r = g.command(0, { c: 'ability', ability: 'bombard', units: [mb.id], point });
  assert.ok(!r?.error, JSON.stringify(r));
  assert.ok(mb.bombardAt, 'bombardment pending');
  const t0 = g.time;
  while (g.time < t0 + SETUP - .3) { step(g); assert.equal(launches(g, mb), 0, `no launch at ${(g.time - t0).toFixed(2)} s`); }
  for (let i = 0; i < 20 && !launches(g, mb); i++) step(g);
  assert.equal(launches(g, mb), 1, 'the salvo goes once set up');
  assert.equal(mb.deployed, true);
  assert.ok(!mb.bombardAt);
  assert.ok([...g.projectiles.values()].some((p) => p.shooter === mb.id || p.weapon === 'missile'), 'a missile is in flight');

  // a deployed battery bombards at once
  mb.abilityReady = 0;
  const n = launches(g, mb);
  g.command(0, { c: 'ability', ability: 'bombard', units: [mb.id], point });
  assert.equal(launches(g, mb), n + 1, 'deployed: immediate salvo');

  // ordered while driving: it halts, and a move before the set-up completes cancels the salvo and refunds the cooldown
  const mb2 = g.spawn(g.civs[0], 'missile_battery', { x: centre.x - 4, z: centre.z - 2 }, .05);
  g.command(0, { c: 'move', units: [mb2.id], point: { x: centre.x - 9, z: centre.z - 2 } });
  for (let i = 0; i < 10; i++) step(g);
  assert.ok(mb2.vx || mb2.vz, 'driving');
  g.command(0, { c: 'ability', ability: 'bombard', units: [mb2.id], point });
  assert.ok(mb2.bombardAt && !mb2.goal, 'halted to set up');
  for (let i = 0; i < 10; i++) step(g);
  assert.ok(mb2.setupUntil > 0 && !mb2.deployed, 'setting up');
  assert.ok(mb2.abilityReady > g.time, 'cooldown running');
  g.command(0, { c: 'move', units: [mb2.id], point: { x: centre.x - 9, z: centre.z - 3 } });
  for (let i = 0; i < 10; i++) step(g);
  assert.ok(!mb2.bombardAt, 'the move cancelled the bombardment');
  assert.equal(launches(g, mb2), 0);
  assert.ok(mb2.abilityReady <= g.time, 'cooldown returned');
});

// 2026-11-19 (user: "make it so that missile trucks cannot attack close in troops"): ACTION_UNITS.missile_battery.minRange
const MIN = ACTION_UNITS.missile_battery.minRange;

test('missile battery: a minimum range of about a third of its reach', () => {
  assert.ok(MIN >= 3 && MIN <= ACTION_UNITS.missile_battery.range * .4, `minRange ${MIN}`);
  assert.ok(MIN > ACTION_UNITS.tank.range, 'a tank in its own gun range is inside the dead zone');
});

test('a missile battery never fires on troops inside its minimum range', () => {
  const { g, centre } = arena();
  const mb = g.spawn(g.civs[0], 'missile_battery', { x: centre.x, z: centre.z }, .05);
  const squad = g.spawn(g.civs[1], 'rifle_squad', { x: centre.x + MIN - 1.2, z: centre.z }, .05);
  assert.ok(mb && squad);
  mb.stance = 'defensive';   // stays put: only the targeting is under test
  g.command(1, { c: 'stance', units: [squad.id], stance: 'holdFire' });
  g.command(1, { c: 'hold', units: [squad.id] });
  mb.deployed = true;
  for (let i = 0; i < 120; i++) { step(g); assert.ok(distance(mb, squad) < MIN); }
  assert.equal(launches(g, mb), 0, 'no salvo into the dead zone');
  assert.equal(mb.target, 0);
});

test('an attack order on a target inside the minimum range backs the battery off, then it fires', () => {
  const { g, centre } = arena();
  const mb = g.spawn(g.civs[0], 'missile_battery', { x: centre.x, z: centre.z }, .05);
  const tank = g.spawn(g.civs[1], 'tank', { x: centre.x + 2, z: centre.z }, .05);
  g.command(1, { c: 'stance', units: [tank.id], stance: 'holdFire' });
  g.command(1, { c: 'hold', units: [tank.id] });
  const r = g.command(0, { c: 'attack', target: tank.id, units: [mb.id] });
  assert.ok(!r?.error, JSON.stringify(r));
  let firedAt = null;
  for (let i = 0; i < 500 && firedAt == null; i++) {
    const before = launches(g, mb);
    step(g);
    if (launches(g, mb) > before) firedAt = distance(mb, tank);
  }
  assert.ok(firedAt != null, 'fired once clear of the dead zone');
  assert.ok(firedAt >= MIN, `fired from ${firedAt?.toFixed(2)} hexes`);
});

test('Area Bombardment inside the minimum range is refused with a reason', () => {
  const { g, centre } = arena();
  const mb = g.spawn(g.civs[0], 'missile_battery', { x: centre.x, z: centre.z }, .05);
  const r = g.command(0, { c: 'ability', ability: 'bombard', units: [mb.id], point: { x: centre.x + MIN - 1, z: centre.z } });
  assert.match(r?.error || '', /Too close/);
  assert.ok(!mb.bombardAt);
  assert.ok(!(mb.abilityReady > g.time), 'no cooldown spent');
  const ok = g.command(0, { c: 'ability', ability: 'bombard', units: [mb.id], point: { x: centre.x + MIN + 1, z: centre.z } });
  assert.ok(!ok?.error, JSON.stringify(ok));
});
