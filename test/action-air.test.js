// Action-RTS air operations (2026-11-16, workstream D): fuel endurance with automatic return, refuel and
// resume; out-of-fuel limping; patrol routes with a fuel-range clamp; long flight paths (racetracks, circuits)
// instead of hovering; flak airburst events from AA units and upgraded city defenses.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { distance } = await import('../server/sim/actionNavigation.js');
const { AIR, AIR_STATE, patrolRange, stationPath } = await import('../server/sim/actionAir.js');

const create = () => new ActionGame({ id: 'action-air', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const hqOf = (g, owner) => [...g.buildings.values()].find((b) => b.owner === owner && b.type === 'town');
const airOf = (g, civ, u) => g.unitSnapshot(g.civs[civ], { god: false }).units.find((x) => x[0] === u.id)?.[18];
function run(g, ticks, each) {
  for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; if (each && each(i) === false) break; }
}
function setup() {
  const g = create(), hq = hqOf(g, 0), enemy = hqOf(g, 1);
  return { g, hq, enemy, mid: { x: (hq.x + enemy.x) / 2, z: (hq.z + enemy.z) / 2 } };
}

test('aircraft have endurance by role: fighters ~60 s, bombers ~90 s, helicopters ~120 s, drones less', () => {
  assert.equal(ACTION_UNITS.fighter.fuel, 60);
  assert.equal(ACTION_UNITS.bomber.fuel, 90);
  assert.equal(ACTION_UNITS.helicopter.fuel, 120);
  for (const t of ['recon_drone', 'oneway_drone', 'strike_swarm']) assert.ok(ACTION_UNITS[t].fuel < 60, t);
  for (const [k, d] of Object.entries(ACTION_UNITS)) if (!d.air) assert.equal(d.fuel, undefined, k);
});

test('a patrol runs on fuel: bingo return with fuel in hand, refuel at the base, then the patrol resumes', () => {
  const { g, hq, mid } = setup();
  const f = g.spawn(g.civs[0], 'fighter', hq, 1.2);
  const r = g.command(0, { c: 'patrol', units: [f.id], points: [mid, { x: mid.x + 4, z: mid.z - 3 }] });
  assert.equal(r.patrol, 1); assert.equal(r.waypoints, 2); assert.equal(r.clamped, 0);
  const states = new Set(); let minFuel = Infinity, relaunched = 0, last = -1;
  run(g, 1500, () => {
    const air = airOf(g, 0, f);
    states.add(air[0]);
    if (last === AIR_STATE.refuelling && air[0] === AIR_STATE.airborne) relaunched++;
    last = air[0];
    assert.ok(air[1] >= 0 && air[1] <= 255, 'fuel is a 0-255 byte');
    if (!f.grounded) minFuel = Math.min(minFuel, f.fuel);
  });
  for (const s of [AIR_STATE.airborne, AIR_STATE.returning, AIR_STATE.refuelling]) assert.ok(states.has(s), `went through state ${s}`);
  assert.ok(minFuel > 0, 'turned for home before the tank ran dry');
  assert.ok(relaunched >= 1, 'took off again once refuelled');
  assert.equal(f.airOrder?.kind === 'route' || f.airOrder?.kind === 'return' || f.grounded, true);
  assert.ok(!f.grounded ? true : f.airResume?.kind === 'route', 'the patrol survives refuelling');
  // fuel is shown to the owner only
  assert.equal(airOf(g, 1, f) ? airOf(g, 1, f)[1] : -1, -1);
});

test('out of fuel an aircraft never explodes: it limps home at minimum speed and cannot attack', () => {
  const { g, hq, enemy } = setup();
  const h = g.spawn(g.civs[0], 'helicopter', hq, 1.2);
  const target = g.spawn(g.civs[1], 'rifle_squad', enemy, 1.2);
  h.x = target.x + .5; h.z = target.z; h.altitude = .75;
  h.fuel = .05;
  run(g, 3);
  assert.equal(h.fuel, 0);
  assert.equal(airOf(g, 0, h)[0], AIR_STATE.dry);
  run(g, 10);
  assert.equal(h.airOrder?.kind, 'return', 'heading for a base');
  const hp = target.hp, before = { x: h.x, z: h.z };
  run(g, 20);
  const speed = distance(before, h) / 2;
  assert.ok(speed > 0, 'still flying');
  assert.ok(speed <= ACTION_UNITS.helicopter.speed * AIR.dryPace * 1.25, `crawls (${speed.toFixed(2)} u/s)`);
  assert.equal(target.hp, hp, 'a dry aircraft does not fire');
  assert.ok(g.units.has(h.id));
});

test('patrol waypoints beyond fuel range are pulled back toward the nearest base, with feedback', () => {
  const { g, hq, enemy } = setup();
  const d = g.spawn(g.civs[0], 'recon_drone', hq, 1.2);
  const saved = ACTION_UNITS.recon_drone.fuel;
  try {
    ACTION_UNITS.recon_drone.fuel = 8;
    const range = patrolRange(g, d);
    assert.ok(distance(hq, enemy) > range * 1.5, 'the enemy base is out of range');
    const r = g.command(0, { c: 'patrol', units: [d.id], points: [{ x: enemy.x, z: enemy.z }, { x: hq.x + 1, z: hq.z }] });
    assert.equal(r.clamped, 1);
    assert.match(r.note, /fuel range/);
    assert.ok(distance(d.airOrder.route[0], hq) <= range + .3, 'the far waypoint was clamped to the range');
    assert.ok(distance(d.airOrder.route[1], { x: hq.x + 1, z: hq.z }) < .3, 'the near waypoint is untouched');
  } finally { ACTION_UNITS.recon_drone.fuel = saved; }
  const tank = g.spawn(g.civs[0], 'tank', hq, 1.5);
  assert.ok(g.command(0, { c: 'patrol', units: [tank.id], points: [{ x: hq.x, z: hq.z }] }).error);
  assert.ok(g.command(0, { c: 'patrol', units: [d.id], points: [] }).error);
});

test('jets fly wide racetracks and helicopters loose circuits; no aircraft hovers on station', () => {
  const { g, hq, mid } = setup();
  const len = (pts) => pts.reduce((s, p, i) => s + distance(p, pts[(i + 1) % pts.length]), 0);
  const jets = g.spawn(g.civs[0], 'fighter', hq, 1.2), heli = g.spawn(g.civs[0], 'helicopter', hq, 1.2);
  const lap = stationPath(g, jets, mid, 'patrol', {});
  assert.ok(len(lap) > 18, `racetrack lap ${len(lap).toFixed(1)}`);
  assert.ok(Math.max(...lap.map((p) => distance(p, mid))) > 3.5, 'spans several hexes');
  const ring = stationPath(g, heli, mid, 'patrol', {});
  const radii = ring.map((p) => distance(p, mid));
  assert.ok(Math.min(...radii) > 1.5 && Math.max(...radii) < 3.2, `circuit radius ${Math.min(...radii).toFixed(2)}-${Math.max(...radii).toFixed(2)}`);
  g.command(0, { c: 'airMission', units: [jets.id, heli.id], mission: 'patrol', point: mid });
  const still = new Map();
  run(g, 500, () => {
    for (const u of [jets, heli]) if (!u.grounded && u.altitude > .3) {
      const s = !u.vx && !u.vz ? (still.get(u.id) || 0) + 1 : 0;
      still.set(u.id, s);
      assert.ok(s < 3, `${u.type} hovered for ${s} ticks`);
    }
  });
});

test('AA fire bursts in the sky: flak events carry the burst centre at altitude and the puff offsets', () => {
  const { g, hq, enemy } = setup();
  const aa = g.spawn(g.civs[1], 'air_defense', enemy, 1.5);
  const heli = g.spawn(g.civs[0], 'helicopter', hq, 1.2);
  heli.hp = heli.maxHp = 50000;
  g.command(0, { c: 'patrol', units: [heli.id], points: [{ x: aa.x, z: aa.z }] });
  const flak = [];
  run(g, 600, () => { for (const e of g.events.splice(0)) if (e.k === 'flak') flak.push(e); });
  const own = flak.filter((e) => e.s === aa.id);
  assert.ok(own.length > 3, `AA unit fired flak (${own.length})`);
  for (const e of own) {
    assert.ok(e.y > .3 && e.y < 3, 'bursts at altitude');
    assert.ok(Array.isArray(e.p) && e.p.length >= 9 && e.p.length % 3 === 0, 'puff offsets');
    assert.ok(Number.isFinite(e.bx) && Number.isFinite(e.bz));
  }
  // upgraded city defenses: the headquarters fires AA airbursts too
  const before = flak.filter((e) => e.s === enemy.id).length;
  assert.equal(before, 0, 'no city AA before the defense upgrade');
  g.siteById.get(enemy.site).defenseLevel = 2;   // B's perimeter upgrade to the AA level (actionBases.cityAA)
  heli.hp = heli.maxHp;
  g.command(0, { c: 'patrol', units: [heli.id], points: [{ x: enemy.x, z: enemy.z }] });
  run(g, 400, () => { for (const e of g.events.splice(0)) if (e.k === 'flak') flak.push(e); });
  assert.ok(flak.filter((e) => e.s === enemy.id).length > 2, 'city AA fires once its defenses are upgraded');
});
