// Tank pass (2026-11-20, user: "Tanks are too weak and too small"): health x1.5, range x1.25, cost x1.25, speed and
// hitbox unchanged; a slower main gun whose rounds are area blasts (sustained DPS vs armour ~x1.5); a coaxial machine
// gun that fires on its own at nearby infantry; the autonomous tank clearly the best ground unit for its cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { UNITS } = await import('../server/sim/constants.js');
const { WEAPONS, WEAPON_KEYS } = await import('../server/sim/weapons.js');
const { killCap } = await import('../server/sim/actionUpgrades.js');

const create = (id = 'g-tank') => new ActionGame({ id, seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const clean = (g) => { g.units.clear(); g.projectiles.clear(); for (const c of g.civs) { c.visible.fill(1); c.detect?.fill(1); } };
const runFor = (g, seconds, each) => {
  const t0 = g.time;
  while (g.time - t0 < seconds) {
    const seen = g.events.length;
    g.tick();
    if (each) for (const e of g.events.slice(seen)) each(e);
    g.outbox.length = 0;
  }
};
// sustained main-gun damage per second against a target with `def` (vsArmor and the flat armour deduction)
const dps = (atk, cooldown, armour, def = 18) => (atk * 1.65 * (armour ? WEAPONS.cannon.vsArmor : 1) - (armour ? def * .2 : 0)) / cooldown;

test('tank numbers: health x1.5, range x1.25, cost x1.25, speed and hitbox unchanged', () => {
  const t = ACTION_UNITS.tank, a = ACTION_UNITS.autonomous_tank;
  assert.equal(t.hp, 495); assert.equal(a.hp, 760);
  assert.deepEqual(t.cost, { materials: 295, energy: 100 });
  assert.deepEqual(a.cost, { materials: 425, energy: 190 });
  assert.equal(t.range, 3.49); assert.equal(a.range, 4.95);
  // speed: the shared conversion of the legacy table, untouched
  assert.equal(t.speed, UNITS.tank.speed * .92);
  assert.equal(a.speed, UNITS.autonomous_tank.speed * .92);
  // hitbox: unchanged (the client draws the hulls 25% larger)
  assert.equal(t.radius, .25); assert.equal(a.radius, .255);
  assert.equal(t.weapon, 'cannon'); assert.equal(a.weapon, 'cannon');
  assert.ok(t.fireCooldown > WEAPONS.cannon.cooldown * 1.5, 'the main gun fires slower');
  assert.ok(t.blast > 0 && a.blast > t.blast, 'area-blast rounds, wider on the autonomous tank');
});

test('the slower main gun keeps ~1.5x its sustained damage vs armour', () => {
  const t = ACTION_UNITS.tank, a = ACTION_UNITS.autonomous_tank;
  const tank = dps(t.atk, t.fireCooldown, true) / dps(28, 2.2, true);
  const auto = dps(a.atk, a.fireCooldown, true) / dps(40, 2.2, true);
  assert.ok(tank > 1.45 && tank < 1.65, `tank x${tank.toFixed(2)}`);
  assert.ok(auto > 1.6, `autonomous x${auto.toFixed(2)}`);
});

test('the autonomous tank is the best ground unit for its cost', () => {
  const t = ACTION_UNITS.tank, a = ACTION_UNITS.autonomous_tank;
  const price = (d) => d.cost.materials + (d.cost.energy || 0);
  const strength = (d) => d.hp * dps(d.atk, d.fireCooldown ?? 2.2, true);
  assert.ok(strength(a) / price(a) > strength(t) / price(t) * 1.4, 'more strength per resource than the tank');
  assert.ok(a.range > t.range + 1 && a.coax.atk > t.coax.atk && a.def > t.def);
  for (const [key, d] of Object.entries(ACTION_UNITS)) {
    if (d.air || key === 'autonomous_tank' || !d.weapon) continue;
    assert.ok(d.hp < a.hp, `${key} has less health`);
  }
});

test('a tank round is an area blast: it hits the squad beside its target, and the impact carries the radius', () => {
  const g = create('g-tank-aoe'), s = g.sites[0];
  clean(g);
  const tank = g.spawn(g.civs[0], 'tank', { x: s.x + 3, z: s.z }, .05);
  const a = g.spawn(g.civs[1], 'rifle_squad', { x: tank.x + 3, z: tank.z }, .05);
  const b = g.spawn(g.civs[1], 'rifle_squad', { x: tank.x + 3, z: tank.z + .3 }, .05);
  assert.ok(tank && a && b);
  for (const u of [a, b]) g.command(1, { c: 'stance', units: [u.id], stance: 'holdFire' });
  tank.coaxReady = 1e9;   // main gun only
  const impacts = [];
  runFor(g, 4, (e) => { if (e.k === 'impact' && WEAPON_KEYS[e.w] === 'cannon') impacts.push(e); });
  assert.ok(impacts.length >= 1, 'the gun fired');
  assert.ok(Math.abs(impacts[0].r - ACTION_UNITS.tank.blast) < 1e-9, `impact radius ${impacts[0].r}`);
  assert.ok(a.hp < a.maxHp && b.hp < b.maxHp, `both squads hit (${a.hp}, ${b.hp})`);
});

test('a tank HE blast kills more men than the old direct hit cap (6 for the cannon)', () => {
  const halted = { goal: null, maxHp: 108, hp: 108 };
  assert.equal(killCap(halted, 'cannon', .46, 12, true), 6);
  assert.ok(killCap(halted, 'cannon', .46, 12, false) < 6, 'other blasts keep the radius rule');
  assert.equal(killCap(halted, 'cannon', .46, 3, true), 3);
});

test('the coaxial machine gun fires on its own at nearby infantry, never at vehicles', () => {
  const g = create('g-tank-coax'), s = g.sites[0];
  clean(g);
  const tank = g.spawn(g.civs[0], 'tank', { x: s.x + 3, z: s.z }, .05);
  const squad = g.spawn(g.civs[1], 'rifle_squad', { x: tank.x + 1.5, z: tank.z }, .05);
  const car = g.spawn(g.civs[1], 'armored_car', { x: tank.x - 1.5, z: tank.z }, .05);
  assert.ok(tank && squad && car);
  squad.maxHp = squad.hp = 1e6; car.maxHp = car.hp = 1e6; tank.maxHp = tank.hp = 1e6;
  for (const u of [squad, car]) g.command(1, { c: 'stance', units: [u.id], stance: 'holdFire' });
  const coax = [], cannon = [];
  runFor(g, 8, (e) => {
    if (e.s !== tank.id) return;
    if (e.k === 'fire' && WEAPON_KEYS[e.w] === 'coax') coax.push(e.t);
    if (e.k === 'launch' && WEAPON_KEYS[e.w] === 'cannon') cannon.push(e.t);
  });
  assert.ok(coax.length >= 5, `coax bursts (${coax.length}): ~one per ${ACTION_UNITS.tank.coax.cooldown} s`);
  assert.ok(coax.every((t) => t === squad.id), 'only at infantry');
  assert.ok(cannon.length >= 2, 'the main gun keeps firing on its own cooldown');
  // out of coax range: no bursts
  const g2 = create('g-tank-coax2'), s2 = g2.sites[0];
  clean(g2);
  const t2 = g2.spawn(g2.civs[0], 'tank', { x: s2.x + 3, z: s2.z }, .05);
  const far = g2.spawn(g2.civs[1], 'rifle_squad', { x: t2.x + ACTION_UNITS.tank.coax.range + .6, z: t2.z }, .05);
  far.maxHp = far.hp = 1e6;
  let bursts = 0;
  runFor(g2, 5, (e) => { if (e.s === t2.id && e.k === 'fire' && WEAPON_KEYS[e.w] === 'coax') bursts++; });
  assert.equal(bursts, 0);
});

test('hold fire silences the coax', () => {
  const g = create('g-tank-hold'), s = g.sites[0];
  clean(g);
  const tank = g.spawn(g.civs[0], 'tank', { x: s.x + 3, z: s.z }, .05);
  const squad = g.spawn(g.civs[1], 'rifle_squad', { x: tank.x + 1.4, z: tank.z }, .05);
  squad.maxHp = squad.hp = 1e6;
  g.command(0, { c: 'stance', units: [tank.id], stance: 'holdFire' });
  g.command(1, { c: 'stance', units: [squad.id], stance: 'holdFire' });
  let bursts = 0;
  runFor(g, 5, (e) => { if (e.s === tank.id && e.k === 'fire') bursts++; });
  assert.equal(bursts, 0);
});
