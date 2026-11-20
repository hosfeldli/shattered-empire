// W3 (gameplay overhaul, 2026-11-17): squads with more men and a per-man simulation (R3 user decision: squads
// stay single entities), forest cleared by heavy tracked hulls (R5, directive Test E), storms and high relief for
// aircraft (§31) and missile defense (§44).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS, SQUAD_MEN } = await import('../server/sim/actionDefinitions.js');
const { addFacility } = await import('../server/sim/actionBases.js');
const { centerOf, distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { damageActionTarget, launchStrategic, MISSILE_DEFENSE } = await import('../server/sim/actionCombat.js');
const { menOf, woundedHp, squadHit, squadFirepower, killCap, suppress, SQUAD } = await import('../server/sim/actionUpgrades.js');
const { addWear, battlefieldStep, FOREST_CLEAR } = await import('../server/sim/battlefield.js');
const { AIR_WEATHER, airAccess, patrolCommand } = await import('../server/sim/actionAir.js');
const { serializeGame, restoreGame } = await import('../server/sim/persist.js');
const { T } = await import('../server/sim/constants.js');
const { disk } = await import('../server/sim/hex.js');

const create = (id = 'w3') => new ActionGame({ id, seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const hqOf = (g, owner) => [...g.buildings.values()].find((b) => b.owner === owner && b.type === 'town');
const run = (g, n) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; } };

// ------------------------------------------------------------------ squads
test('squads field more men; maxHp = men x HP per man; the snapshot carries the living men (extra[8])', () => {
  // 2026-11-18: exo_infantry is a vehicle (IFV) now; rifle HP per man 14 -> 9 (numbers below scaled to keep each case's men)
  assert.deepEqual(SQUAD_MEN, { rifle_squad: 12, militia: 10, special_forces: 8, anti_armor: 5, mortar_team: 4, engineer: 1 });
  assert.equal(ACTION_UNITS.rifle_squad.hp, 12 * 9);
  assert.equal(ACTION_UNITS.mortar_team.hp, 120);
  const g = create(), s = g.sites[0];
  g.units.clear();
  const squad = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 4, z: s.z }, .2);
  assert.equal(menOf(squad), 12);
  const row = () => g.unitSnapshot(g.civs[0], { god: true }).units.find((x) => x[0] === squad.id)[20][8];
  assert.equal(row(), 12);
  squad.hp -= squadHit(g, squad, ACTION_UNITS.rifle_squad, 'rifle', 20);
  assert.equal(menOf(squad), 10);
  assert.equal(row(), 10, 'the client draws exactly the living men');
});

test('casualties are discrete: the wounded man falls first, then whole men; a hit kills at most its cap', () => {
  const g = create(), s = g.sites[0];
  g.units.clear();
  const d = ACTION_UNITS.rifle_squad, u = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 4, z: s.z }, .2);
  // 13 damage from a rifle volley: one man dies (9), the next is wounded by 4
  u.hp -= squadHit(g, u, d, 'rifle', 13);
  assert.equal(menOf(u), 11);
  assert.ok(Math.abs(woundedHp(u) - 5) < 1e-6, `wounded man on 5 HP (${woundedHp(u)})`);
  // a small hit only wounds: nobody dies until the wounded man's HP is spent
  u.hp -= squadHit(g, u, d, 'rifle', 4);
  assert.equal(menOf(u), 11);
  assert.ok(Math.abs(woundedHp(u) - 1) < 1e-6);
  // a heavy single round (field gun: cap 2) kills two men however big it is; the rest of the hit is wasted
  assert.equal(killCap(u, 'atgun', 0, 11), 2);
  const before = u.hp, loss = squadHit(g, u, d, 'atgun', 200);
  u.hp -= loss;
  assert.equal(menOf(u), 9);
  assert.ok(Math.abs(loss - (1 + 9)) < 1e-6, `overkill wasted: lost ${loss} of ${before}`);
  // a volley never kills more men than its burst (rifle: 3)
  u.hp -= squadHit(g, u, d, 'rifle', 500);
  assert.equal(menOf(u), 6);
  // the hp pool and the men always agree: (men - 1) x perMan < hp <= men x perMan
  const per = u.maxHp / d.men;
  assert.ok(u.hp > (menOf(u) - 1) * per && u.hp <= menOf(u) * per + 1e-6);
});

test('blasts kill several men at once, in proportion to blast radius versus squad spread', () => {
  const g = create(), s = g.sites[0];
  g.units.clear();
  const d = ACTION_UNITS.rifle_squad;
  const halted = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 4, z: s.z }, .2);
  // a mortar shell (radius .92) catches the whole halted squad: 38 damage kills four men (4 x 9 = 36)
  halted.hp -= squadHit(g, halted, d, 'mortar', 38, .92);
  assert.equal(menOf(halted), 8);
  // the same 60 as a direct anti-tank round kills two
  const direct = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 4, z: s.z + 1 }, .2);
  direct.hp -= squadHit(g, direct, d, 'atgun', 60);
  assert.equal(menOf(direct), 10);
  // a grenade (radius .45) catches fewer men of a spread-out squad than of one bunched on the move
  const spread = killCap(halted, 'mortar', .45, 12);
  const moving = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 4, z: s.z + 2 }, .2);
  moving.goal = { x: moving.x + 3, z: moving.z };
  const bunched = killCap(moving, 'mortar', .45, 12);
  assert.ok(spread >= 1 && bunched > spread, `halted ${spread} < moving ${bunched}`);
  // through damageActionTarget: a blast on a squad in the open kills several men
  const foe = g.spawn(g.civs[1], 'mortar_team', { x: s.x + 8, z: s.z }, .2);
  const target = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 6, z: s.z - 2 }, .2);
  damageActionTarget(g, target, foe, 120, 'howitzer', true, .92);
  assert.ok(menOf(target) <= 12 - 3, `artillery killed ${12 - menOf(target)} men`);
});

test('firepower is living men x per-man weapon, falls off with range and under suppression', () => {
  const g = create(), s = g.sites[0];
  g.units.clear();
  const d = ACTION_UNITS.rifle_squad, u = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 4, z: s.z }, .2);
  const near = { x: u.x + d.range * .3, z: u.z }, far = { x: u.x + d.range, z: u.z };
  assert.equal(squadFirepower(u, g, d, near), 1);
  assert.ok(Math.abs(squadFirepower(u, g, d, far) - SQUAD.accuracyFar) < 1e-9, 'max range: accuracy falls to accuracyFar');
  u.hp = u.maxHp / 2;
  assert.equal(menOf(u), 6);
  assert.ok(Math.abs(squadFirepower(u, g, d, near) - .5) < 1e-9, 'half the men, half the fire');
  suppress(u, g.time, 100);
  assert.ok(Math.abs(squadFirepower(u, g, d, near) - .5 * (1 - SQUAD.suppressFire)) < 1e-9, 'suppressed');
  g.time += 100 / SQUAD.suppressDecay + 1;
  assert.ok(Math.abs(squadFirepower(u, g, d, near) - .5) < 1e-9, 'suppression wears off');
  // a crew-served mortar fires at full rate while two men can work the tube
  const m = g.spawn(g.civs[0], 'mortar_team', { x: s.x + 4, z: s.z + 2 }, .2);
  m.hp = m.maxHp / 4 * 2;
  assert.equal(squadFirepower(m, g), 1);
});

// ------------------------------------------------------------------ forest clearing (directive Test E)
function forestPocket(g, from) {
  // the nearest forest hex with a non-forest, land neighbour, both standable for a tank
  const def = ACTION_UNITS.tank;
  let best = null, score = Infinity;
  for (let t = 0; t < g.world.terr.length; t++) {
    if (g.world.terr[t] !== T.FOREST || g.world.road[t]) continue;
    const c = centerOf(t);
    if (!g.nav.canStand(c.x, c.z, def)) continue;
    const out = disk(t, 1).find((n) => n !== t && g.world.terr[n] !== T.FOREST && !g.world.road[n] && g.world.terr[n] !== T.SHALLOW && g.world.terr[n] !== T.DEEP && g.nav.canStand(centerOf(n).x, centerOf(n).z, def));
    if (out == null) continue;
    const s = distance(from, c);
    if (s < score) { score = s; best = { forest: t, open: out }; }
  }
  return best;
}

test('Test E: a tank driving through forest clears it; only those hexes change; it persists through save and never regrows', () => {
  const g = create('w3-forest'), hq = hqOf(g, 0);
  g.units.clear();
  const pocket = forestPocket(g, hq);
  assert.ok(pocket, 'the map has forest');
  const terr0 = Uint8Array.from(g.world.terr);
  const tank = g.spawn(g.civs[0], 'tank', centerOf(pocket.open), .05);
  const into = centerOf(pocket.forest), back = centerOf(pocket.open);
  let entries = 0;
  for (let lap = 0; lap < 12 && g.world.terr[pocket.forest] === T.FOREST; lap++) {
    for (const p of [into, back]) {
      g.command(0, { c: 'move', units: [tank.id], point: p });
      for (let i = 0; i < 120 && distance(tank, p) > .2; i++) {
        const t0 = tank.tile; run(g, 1); if (tank.tile === pocket.forest && t0 !== pocket.forest) entries++;
      }
    }
  }
  run(g, 40);   // the 1 Hz warzone step processes the cleared hex
  assert.ok(entries >= FOREST_CLEAR.passes, `the tank entered the forest ${entries} times`);
  assert.notEqual(g.world.terr[pocket.forest], T.FOREST, 'the forest hex is cleared');
  assert.equal(g.world.terr[pocket.forest], T.GRASS);
  assert.ok(g.world.moist[pocket.forest] <= FOREST_CLEAR.moist);
  // only hexes heavy hulls drove into changed (no stray terrain edits)
  for (let t = 0; t < terr0.length; t++) if (terr0[t] !== g.world.terr[t]) {
    assert.equal(terr0[t], T.FOREST, `hex ${t} changed but was not forest`);
    assert.ok((g.wear.get(t)?.h || 0) >= FOREST_CLEAR.passes, `hex ${t} changed without enough tank passes`);
  }
  // persists through serialize / restore, and never regrows
  const restored = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.equal(restored.world.terr[pocket.forest], T.GRASS);
  assert.ok(restored.world.moist[pocket.forest] <= FOREST_CLEAR.moist);
  run(restored, 300);
  assert.equal(restored.world.terr[pocket.forest], T.GRASS, 'no regrowth');
});

test('forest clearing: passes are counted per hex, light vehicles and infantry never clear, nav invalidation is batched', () => {
  const g = create('w3-forest2');
  const forests = [];
  for (let t = 0; t < g.world.terr.length && forests.length < 4; t++) if (g.world.terr[t] === T.FOREST && !g.world.road[t]) forests.push(t);
  assert.equal(forests.length, 4);
  const [a, b, c, e] = forests;
  for (let k = 0; k < FOREST_CLEAR.passes - 1; k++) addWear(g, a, 'tracked', ACTION_UNITS.tank);
  for (let k = 0; k < 10; k++) addWear(g, b, 'wheeled', ACTION_UNITS.armored_car);
  for (let k = 0; k < 10; k++) addWear(g, b, 'infantry', ACTION_UNITS.rifle_squad);
  for (let k = 0; k < 10; k++) addWear(g, c, 'tracked', ACTION_UNITS.mech_infantry);   // a light tracked hull
  let invalidations = 0;
  const inv = g.nav.invalidate.bind(g.nav);
  g.nav.invalidate = () => { invalidations++; inv(); };
  battlefieldStep(g, 1, { fieldPositions: false });
  for (const t of [a, b, c]) assert.equal(g.world.terr[t], T.FOREST);
  assert.equal(invalidations, 0, 'nothing cleared, no invalidation');
  addWear(g, a, 'tracked', ACTION_UNITS.tank);
  for (let k = 0; k < FOREST_CLEAR.passes; k++) addWear(g, e, 'tracked', ACTION_UNITS.autonomous_tank);
  const ver = g.world.ver[a];
  battlefieldStep(g, 1, { fieldPositions: false });
  assert.equal(g.world.terr[a], T.GRASS);
  assert.equal(g.world.terr[e], T.GRASS);
  assert.notEqual(g.world.ver[a], ver, 'world.touch: the change replicates to clients');
  assert.equal(invalidations, 1, 'two hexes cleared in one step: one navigation invalidation');
});

// ------------------------------------------------------------------ storms and mountains (§31)
test('storms ground aircraft at a stormbound base, and slow and drain aircraft flying inside them', () => {
  const g = create('w3-storm'), hq = hqOf(g, 0);
  g.units.clear();
  const heli = g.spawn(g.civs[0], 'helicopter', hq, 1.2);
  const clear = () => g.weather.storm.fill(0), storm = () => g.weather.storm.fill(1);
  // airborne in clear air vs in a storm: fuel burned and distance flown over the same ticks
  const leg = (stormy) => {
    const u = g.spawn(g.civs[0], 'helicopter', hq, 1.2);
    u.grounded = false; u.onPad = false; u.altitude = .75;
    const enemy = hqOf(g, 1);
    g.command(0, { c: 'move', units: [u.id], point: { x: enemy.x, z: enemy.z } });
    for (let i = 0; i < 10; i++) { (stormy ? storm : clear)(); run(g, 1); }
    const fuel0 = u.fuel, at = { x: u.x, z: u.z };
    for (let i = 0; i < 20; i++) { (stormy ? storm : clear)(); run(g, 1); }
    return { burn: fuel0 - u.fuel, flown: distance(at, u) };
  };
  const calm = leg(false), rough = leg(true);
  assert.ok(rough.burn > calm.burn * 1.3, `storm burns more fuel (${rough.burn.toFixed(2)} vs ${calm.burn.toFixed(2)})`);
  assert.ok(rough.flown < calm.flown * .8, `storm slows (${rough.flown.toFixed(2)} vs ${calm.flown.toFixed(2)})`);
  // grounded at a base under a storm: an order does not get it off the pad until the storm passes
  heli.grounded = true; heli.airBase = hq.id; heli.altitude = .045; heli.fuel = ACTION_UNITS.helicopter.fuel;
  storm(); run(g, 2);
  const pad = { x: heli.x, z: heli.z };
  g.command(0, { c: 'move', units: [heli.id], point: { x: hq.x + 8, z: hq.z } });
  for (let i = 0; i < 30; i++) { storm(); run(g, 1); }
  assert.ok(distance(pad, heli) < .05, 'held on the pad');
  assert.equal(heli.stormHeld, true, 'the owner is told it is storm-bound');
  for (let i = 0; i < 40; i++) { clear(); run(g, 1); }
  assert.ok(distance(pad, heli) > .5, 'takes off once the storm passes');
});

test('helicopters and drones cannot hold station over high mountains: the patrol is refused with feedback', () => {
  const g = create('w3-ridge'), hq = hqOf(g, 0);
  g.units.clear();
  const heli = g.spawn(g.civs[0], 'helicopter', hq, 1.2), jet = g.spawn(g.civs[0], 'fighter', hq, 1.4);
  // raise a hex near the base above the ridge line
  const t = tileAt(hq.x + 5, hq.z);
  g.world.elev[t] = AIR_WEATHER.ridge + .1;
  const peak = centerOf(t);
  assert.equal(airAccess(g, ACTION_UNITS.helicopter, peak).ok, false);
  assert.equal(airAccess(g, ACTION_UNITS.fighter, peak).ok, true, 'jets fly high');
  const r = patrolCommand(g, g.civs[0], [heli], { points: [peak] });
  assert.ok(r.error && /mountain/i.test(r.error), r.error);
  const ok = patrolCommand(g, g.civs[0], [jet], { points: [peak] });
  assert.equal(ok.patrol, 1);
  const mixed = patrolCommand(g, g.civs[0], [heli], { points: [peak, { x: hq.x + 2, z: hq.z + 2 }] });
  assert.equal(mixed.patrol, 1);
  assert.ok(/mountains skipped/.test(mixed.note), mixed.note);
});

// ------------------------------------------------------------------ missile defense (§44)
function defended(seed = 41) {
  const g = new ActionGame({ id: 'w3-mint', seed, style: 'pangaea', slots: [{ human: true }, { human: true }] });
  const hq = hqOf(g, 0), foe = hqOf(g, 1);
  g.units.clear();
  const point = { x: hq.x + 3, z: hq.z + 1 };
  addFacility(g, g.civs[0], null, 'aa_battery', tileAt(point.x + 1.5, point.z), { instant: true, point: { x: point.x + 1.5, z: point.z, yaw: 0 } });
  g.spawn(g.civs[0], 'air_defense', { x: point.x - 1.5, z: point.z }, .1);
  run(g, 1);   // the combat step indexes targets
  return { g, hq, foe, point };
}
const events = (g, k) => g.events.filter((e) => e.k === k);

test('missile defense: the outcome is decided once at launch, deterministic, and shown with a mintercept event', () => {
  const outcome = () => {
    const { g, foe, point } = defended();
    g.events.length = 0;
    launchStrategic(g, foe, point);
    const p = [...g.projectiles.values()].find((x) => x.strategic);
    assert.ok(p.mint !== undefined, 'decided at launch');
    for (let i = 0; i < 200 && g.projectiles.has(p.id); i++) g.tick();
    return { mint: !!p.mint, ev: events(g, 'mintercept').length, impact: events(g, 'mimpact').length };
  };
  const a = outcome(), b = outcome();
  assert.deepEqual(a, b, 'same seed, same outcome');
  assert.equal(a.ev + a.impact, 1, 'either intercepted or it lands');
  // forced success: the missile dies short of its target and does no damage
  const { g, hq, foe, point } = defended();
  g.rng = () => 0;
  const hp = hq.hp;
  g.events.length = 0;
  launchStrategic(g, foe, point);
  for (let i = 0; i < 300; i++) g.tick();
  const ev = events(g, 'mintercept');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].st, 1);
  assert.ok(Number.isFinite(ev[0].bx) && Number.isFinite(ev[0].bz) && ev[0].s > 0);
  assert.equal(events(g, 'mimpact').length, 0);
  assert.equal(hq.hp, hp);
});

test('missile defense: saturation beats it (one shot per interceptor per cooldown) and range limits it', () => {
  const { g, foe, point } = defended();
  g.rng = () => 0;   // every shot that is taken hits
  for (let k = 0; k < 4; k++) launchStrategic(g, foe, point);
  const salvo = [...g.projectiles.values()].filter((p) => p.strategic);
  const killed = salvo.filter((p) => p.mint).length;
  assert.equal(killed, 2, 'two interceptors stop two of a four-missile salvo');
  assert.equal(MISSILE_DEFENSE.cooldown.strategic > 0, true);
  // far outside every interceptor's range nothing is shot down
  const far = { x: point.x + 20, z: point.z };
  launchStrategic(g, foe, far);
  g.time += 60;
  launchStrategic(g, foe, far);
  assert.ok([...g.projectiles.values()].filter((p) => p.strategic && p.x === far.x).every((p) => !p.mint));
  // tactical guided missiles (missile battery rounds) are engaged too
  const { g: g2, foe: f2, point: p2 } = defended();
  g2.rng = () => 0;
  const battery = g2.spawn(g2.civs[1], 'missile_battery', { x: f2.x + 1, z: f2.z }, .3);
  g2.bombard(battery, p2);
  const round = [...g2.projectiles.values()].find((p) => p.weapon === 'missile');
  assert.ok(round?.mint, 'missile battery round intercepted');
});
