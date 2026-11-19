// The Warthog (unit key 'fighter') and the action-RTS flight model: strafing runs with walking cannon
// impacts, ground targets only, fragile under AA; fixed-wing aircraft turn smoothly (no heading snaps, no
// tight circling of a target); helicopters accelerate and brake smoothly. Deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { canEngage, damageActionTarget } = await import('../server/sim/actionCombat.js');
const { tileAt, distance } = await import('../server/sim/actionNavigation.js');
const { weaponVs, WEAPONS } = await import('../server/sim/weapons.js');
const { stateHash } = await import('../server/sim/persist.js');

const create = () => new ActionGame({ id: 'warthog', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
function reindex(g) { g.movers.clear(); for (const u of g.units.values()) if (!ACTION_UNITS[u.type].air) g.movers.add(u); }
function place(g, owner, type, point) {
  const u = g.spawn(g.civs[owner], type, point, .5);
  assert.ok(u, `spawn ${type}`);
  u.x = point.x; u.z = point.z; u.tile = tileAt(u.x, u.z); reindex(g); return u;
}
const angle = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// an empty arena in the middle of the map: a Warthog airborne at cruise, enemy armour some way ahead
function arena() {
  const g = create();
  g.units.clear(); g.projectiles.clear(); reindex(g);
  for (const c of g.civs) { c.revealAll = true; }
  const s = g.sites.find((x) => x.slots && x.owner < 0) || g.sites[2];
  const jet = place(g, 0, 'fighter', { x: s.x - 7, z: s.z });
  Object.assign(jet, { altitude: 1.25, yaw: Math.PI / 2, airspeed: ACTION_UNITS.fighter.speed, fuel: 999, grounded: false });
  const tanks = [place(g, 1, 'tank', { x: s.x, z: s.z }), place(g, 1, 'tank', { x: s.x + .3, z: s.z + .05 })];
  for (const t of tanks) { t.mode = 'guard'; t.braced = true; }
  g.sees = () => true;
  return { g, jet, tanks };
}

test('the Warthog: ground-attack cannon, cannot engage aircraft, slow for a jet and fragile under AA', () => {
  const w = ACTION_UNITS.fighter;
  assert.equal(w.name, 'Warthog');
  assert.equal(w.weapon, 'gau8');
  assert.ok(w.strafe && w.ability === 'gun_run');
  assert.equal(weaponVs('gau8', ACTION_UNITS.helicopter), 0, 'no air-to-air');
  assert.equal(weaponVs('gau8', ACTION_UNITS.bomber), 0, 'no air-to-air');
  assert.ok(WEAPONS.gau8.vsArmor > 1, 'built for armour');
  assert.ok(w.speed < ACTION_UNITS.bomber.speed && w.speed > ACTION_UNITS.helicopter.speed, 'slower than the bomber');
  assert.ok(w.hp < ACTION_UNITS.helicopter.hp, 'lighter than a helicopter');
  assert.equal(weaponVs('autocannon', w), 0, 'only dedicated anti-aircraft weapons reach it');
  const g = create(), s = g.sites[2];
  const jet = place(g, 0, 'fighter', s), heli = place(g, 0, 'helicopter', { x: s.x + .5, z: s.z });
  const aa = place(g, 1, 'air_defense', { x: s.x + 1, z: s.z });
  jet.hp = heli.hp = 1000;
  damageActionTarget(g, jet, aa, 40, 'flak'); damageActionTarget(g, heli, aa, 40, 'flak');
  assert.ok(1000 - jet.hp > 1000 - heli.hp, 'AA hurts the Warthog more');
  assert.ok(!canEngage(jet, { type: 'helicopter', isUnit: true }), 'cannot be ordered onto aircraft');
});

test('strafing runs: line up, a straight burst walking through the target, extend, smooth turn, come again', () => {
  const { g, jet, tanks } = arena();
  const hp0 = tanks.map((t) => t.hp);
  g.command(0, { c: 'attack', units: [jet.id], target: tanks[0].id });
  let bursts = 0, maxTurn = 0, maxRateChange = 0, prevYaw = jet.yaw, prevRate = 0, phases = new Set(), minAlt = 9;
  const yawAtBurst = [];
  for (let i = 0; i < 600; i++) {
    const seq = g.eventSeq;
    g.tick();
    for (const e of g.events) if (e.i > seq && e.k === 'strafe' && e.s === jet.id) {
      bursts++; yawAtBurst.push(jet.yaw);
      const along = Math.atan2(e.bx - e.ax, e.bz - e.az);
      assert.ok(Math.abs(angle(jet.yaw, along)) < .45, 'impacts walk along the flight path');
    }
    if (!g.units.has(jet.id)) break;
    const rate = angle(prevYaw, jet.yaw) / .1;
    maxTurn = Math.max(maxTurn, Math.abs(rate));
    maxRateChange = Math.max(maxRateChange, Math.abs(rate - prevRate));
    prevYaw = jet.yaw; prevRate = rate;
    if (jet.run) phases.add(jet.run.phase);
    minAlt = Math.min(minAlt, jet.altitude);
    if (tanks.every((t) => !g.units.has(t.id))) break;
  }
  assert.ok(bursts >= 2, `several passes (${bursts})`);
  assert.ok(['run', 'extend', 'reposition'].every((p) => phases.has(p)), `went through the run phases (${[...phases]})`);
  const speed = ACTION_UNITS.fighter.speed;
  assert.ok(maxTurn <= speed / 1.45 + 1e-6, `turn rate is limited (${maxTurn.toFixed(2)} rad/s)`);
  assert.ok(maxRateChange <= .31, `turns are rolled into, never snapped (${maxRateChange.toFixed(2)})`);
  assert.ok(minAlt < .8, 'dives on the run');
  const hit = tanks.filter((t, i) => !g.units.has(t.id) || t.hp < hp0[i]).length;
  assert.equal(hit, 2, 'the walk of impacts hits both tanks in the line');
  assert.ok(new Set(yawAtBurst.map((y) => Math.round(y * 2))).size >= 2, 'passes come from different headings');
});

test('helicopters accelerate and brake smoothly and fixed-wing jets never stop in the air', () => {
  const g = create(), s = g.sites[2];
  g.units.clear(); reindex(g);
  const heli = place(g, 0, 'helicopter', s); Object.assign(heli, { altitude: .75, fuel: 999 });
  const jet = place(g, 0, 'fighter', { x: s.x, z: s.z + 2 }); Object.assign(jet, { altitude: 1.25, fuel: 999, airspeed: ACTION_UNITS.fighter.speed });
  g.command(0, { c: 'move', units: [heli.id], point: { x: s.x + 6, z: s.z } });
  let maxAccel = 0, prev = 0, minJet = Infinity, closest = Infinity, slowAtArrival = Infinity;
  const point = { x: s.x + 6, z: s.z };
  for (let i = 0; i < 120; i++) {
    g.tick();
    const v = Math.hypot(heli.vx, heli.vz);
    maxAccel = Math.max(maxAccel, Math.abs(v - prev) / .1); prev = v;
    const d = distance(heli, point);
    if (d < closest) { closest = d; slowAtArrival = v; }
    if (i > 20) minJet = Math.min(minJet, Math.hypot(jet.vx, jet.vz));
  }
  assert.ok(maxAccel <= ACTION_UNITS.helicopter.speed * .85 + 1e-6, `helicopter acceleration is limited (${maxAccel.toFixed(2)})`);
  assert.ok(closest < .1, 'the helicopter arrives');
  assert.ok(slowAtArrival < ACTION_UNITS.helicopter.speed * .2, `and has braked on arrival (${slowAtArrival.toFixed(2)})`);
  assert.ok(minJet > ACTION_UNITS.fighter.speed * .5, 'the idle jet keeps flying its orbit');
});

test('a Gun Run order strafes whatever is around the point; a bomber makes bombing runs on an attack order', () => {
  const { g, jet, tanks } = arena();
  const r = g.command(0, { c: 'ability', ability: 'gun_run', units: [jet.id], point: { x: tanks[0].x + .4, z: tanks[0].z } });
  assert.ok(!r.error, r.error);
  let bursts = 0;
  for (let i = 0; i < 300; i++) { const seq = g.eventSeq; g.tick(); bursts += g.events.filter((e) => e.i > seq && e.k === 'strafe').length; }
  assert.ok(bursts >= 2, `gun run passes (${bursts})`);
  const b = arena();
  b.g.units.delete(b.jet.id);
  const bomber = place(b.g, 0, 'bomber', { x: b.tanks[0].x - 8, z: b.tanks[0].z });
  Object.assign(bomber, { altitude: 2.6, yaw: Math.PI / 2, airspeed: ACTION_UNITS.bomber.speed, fuel: 999 });
  b.g.command(0, { c: 'attack', units: [bomber.id], target: b.tanks[0].id });
  let drops = 0;
  for (let i = 0; i < 300; i++) { const seq = b.g.eventSeq; b.g.tick(); drops += b.g.events.filter((e) => e.i > seq && e.k === 'launch' && e.s === bomber.id).length; }
  assert.ok(drops >= 2, `bombing passes (${drops})`);
});

test('Warthog strafing is deterministic', () => {
  const sim = () => {
    const { g, jet, tanks } = arena();
    g.command(0, { c: 'attack', units: [jet.id], target: tanks[0].id });
    for (let i = 0; i < 250; i++) g.tick();
    return stateHash(g);
  };
  assert.equal(sim(), sim());
});
