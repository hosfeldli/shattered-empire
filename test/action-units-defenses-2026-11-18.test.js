// Units and defenses (workstream G, 2026-11-18): bunker MG bursts, the 3-hex ring of influence, the exo squad turned
// Infantry Fighting Vehicle (autocannon + anti-tank missile), and cheaper, frailer line infantry.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS, DEFENSE_INFLUENCE, SQUAD_MEN, SQUAD_HP_PER_MAN, actionDefinitions } = await import('../server/sim/actionDefinitions.js');
const { addFacility, influenceRing } = await import('../server/sim/actionBases.js');
const { tileAt } = await import('../server/sim/actionNavigation.js');
const { damageActionTarget } = await import('../server/sim/actionCombat.js');
const { menOf } = await import('../server/sim/actionUpgrades.js');
const { serializeGame, restoreGame } = await import('../server/sim/persist.js');
const { WEAPON_KEYS } = await import('../server/sim/weapons.js');
const { disk, dist } = await import('../server/sim/hex.js');

const create = (id = 'g-1118') => new ActionGame({ id, seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const clean = (g) => { g.units.clear(); g.projectiles.clear(); for (const c of g.civs) { c.visible.fill(1); c.detect?.fill(1); } };

// ------------------------------------------------------------------ bunker bursts
test('the bunker fires sustained bursts: 6 rounds 0.3 s apart, then a pause; DPS within 20% of the old volley', () => {
  const g = create(), s = g.sites[0];
  clean(g);
  const def = ACTION_BUILDINGS.bunker;
  assert.deepEqual(def.burst, { shots: 6, gap: .3, rest: 2.7, share: .39 });
  const bunker = addFacility(g, g.civs[0], null, 'bunker', tileAt(s.x + 3, s.z + 2), { instant: true, point: { x: s.x + 3, z: s.z + 2, yaw: 0 } });
  const foe = g.spawn(g.civs[1], 'rifle_squad', { x: bunker.x + 1.6, z: bunker.z }, .05);
  assert.ok(foe, 'a target in range');
  foe.maxHp = foe.hp = 1e7;
  foe.goal = null;
  const shots = [];
  for (let i = 0; i < 200; i++) {
    const seen = g.events.length;
    g.tick();
    for (const e of g.events.slice(seen)) if (e.k === 'fire' && e.s === bunker.id) shots.push({ t: g.time, bu: e.bu });
    g.outbox.length = 0;
  }
  assert.ok(shots.length >= 18, `the bunker keeps firing (${shots.length} rounds in 20 s)`);
  // rounds within a burst are 0.3 s apart and numbered 1..6; bursts are separated by the 2.7 s rest
  const first = shots.findIndex((x) => x.bu === 1);
  const burst = shots.slice(first, first + 6);
  assert.deepEqual(burst.map((x) => x.bu), [1, 2, 3, 4, 5, 6]);
  for (let k = 1; k < 6; k++) assert.ok(Math.abs(burst[k].t - burst[k - 1].t - .3) < .051, `gap ${burst[k].t - burst[k - 1].t}`);
  const next = shots[first + 6];
  assert.equal(next.bu, 1, 'a new burst follows');
  const cycle = next.t - burst[0].t;
  assert.ok(cycle >= 4.1 && cycle <= 4.8, `burst cycle ${cycle.toFixed(2)} s`);
  // sustained damage per second: 6 x share x attack / cycle vs the old one volley of 14 every 1.8 s
  const dps = 6 * def.burst.share * def.attack * 1.65 / cycle, old = 14 * 1.65 / 1.8;
  assert.ok(dps > old * .9 && dps < old * 1.25, `bunker DPS ${dps.toFixed(1)} vs ${old.toFixed(1)}`);
});

// ------------------------------------------------------------------ ring of influence
test('the ring of influence reaches 3 hexes past the territory border and is published to the client', () => {
  assert.equal(DEFENSE_INFLUENCE.reach, 3);
  assert.equal(actionDefinitions({}).RULESET.influence.reach, 3);
  const g = create(), ring = influenceRing(g, g.civs[0]);
  const owned = [...ring.keys()].filter((t) => g.world.owner[t] === 0);
  for (const t of disk(g.sites[0].tile, 10)) {
    const d = Math.min(...owned.map((c) => dist(c, t)));
    if (d <= 3) assert.ok(ring[t] <= 3, `tile ${t} at ${d} is inside`);
    else assert.ok(ring[t] > 3, `tile ${t} at ${d} is outside`);
  }
});

// ------------------------------------------------------------------ IFV
test('exo_infantry is an Infantry Fighting Vehicle: tracked, autocannon, anti-tank missile, no squad', () => {
  const d = ACTION_UNITS.exo_infantry, apc = ACTION_UNITS.mech_infantry, tank = ACTION_UNITS.tank;
  assert.equal(d.name, 'Infantry Fighting Vehicle');
  assert.equal(d.move, 'tracked');
  assert.equal(d.cat, 'tracked');
  assert.equal(d.facility, 'motor_works');
  assert.ok(ACTION_BUILDINGS.motor_works.trains.includes('exo_infantry') && !ACTION_BUILDINGS.barracks.trains.includes('exo_infantry'));
  assert.equal(d.weapon, 'autocannon');
  assert.deepEqual(d.atgm, { damage: 62, cooldown: 10, range: 3.6 });
  assert.equal(d.capture, false, 'vehicles do not capture or garrison');
  assert.equal(d.men, undefined, 'no men: not in the squad casualty model');
  assert.ok(!('exo_infantry' in SQUAD_MEN) && !('exo_infantry' in SQUAD_HP_PER_MAN));
  assert.ok(!d.clearsForest, 'a light hull does not flatten forest');
  // cost and time between the carrier and the tank (2026-11-18 tuning: atk 18 -> 15, 215/75 -> 235/85)
  assert.deepEqual(d.cost, { materials: 235, energy: 85 });   // tuned after the sims: the tank's materials, a little more energy
  assert.equal(d.atk, 15); assert.equal(d.hp, 240);   // tuned with the sims (were 18 and 270)
  assert.ok(d.cost.materials > apc.cost.materials && d.cost.materials <= tank.cost.materials);
  assert.ok(d.time >= apc.time && d.time <= tank.time);
  assert.ok(d.hp > apc.hp && d.hp < tank.hp);
  const g = create(), s = g.sites[0];
  clean(g);
  const ifv = g.spawn(g.civs[0], 'exo_infantry', { x: s.x + 4, z: s.z }, .1);
  assert.equal(menOf(ifv), 0);
  assert.equal(ifv.maxHp, 240);
});

test('the IFV autocannon chews through infantry; its missile goes for armour on a reload', () => {
  const g = create('g-ifv'), s = g.sites[0];
  clean(g);
  const ifv = g.spawn(g.civs[0], 'exo_infantry', { x: s.x + 3, z: s.z }, .05);
  const tank = g.spawn(g.civs[1], 'tank', { x: ifv.x + 3.2, z: ifv.z }, .05);
  const squad = g.spawn(g.civs[1], 'rifle_squad', { x: ifv.x + 1.8, z: ifv.z + .3 }, .05);
  assert.ok(ifv && tank && squad);
  tank.maxHp = tank.hp = 1e6; squad.maxHp = squad.hp = 1e6;   // keep both alive: count shots
  g.command(1, { c: 'stance', units: [tank.id], stance: 'holdFire' });   // 2026-11-20: the tank (reach 3.49) would kill the IFV
  const launches = [], bursts = [];
  for (let i = 0; i < 260; i++) {
    const seen = g.events.length;
    g.tick();
    for (const e of g.events.slice(seen)) {
      if (e.s !== ifv.id) continue;
      if (e.k === 'launch' && e.tw) launches.push({ t: g.time, target: e.t, w: WEAPON_KEYS[e.w] });
      if (e.k === 'fire') bursts.push(e.t);
    }
    g.outbox.length = 0;
  }
  assert.ok(bursts.length >= 8, `the autocannon fires (${bursts.length})`);
  assert.ok(launches.length >= 2, `missiles launched (${launches.length})`);
  assert.ok(launches.every((l) => l.target === tank.id && l.w === 'missile'), 'missiles only at armour');
  for (let k = 1; k < launches.length; k++) assert.ok(launches[k].t - launches[k - 1].t >= 10 - 1e-6, 'one missile per 10 s reload');
});

test('IFV damage: autocannon vs a rifle squad, missile vs a tank, rifles barely scratch it', () => {
  const g = create(), s = g.sites[0];
  clean(g);
  const ifv = g.spawn(g.civs[0], 'exo_infantry', { x: s.x + 4, z: s.z }, .05);
  const tank = g.spawn(g.civs[1], 'tank', { x: s.x + 6, z: s.z }, .05);
  const squad = g.spawn(g.civs[1], 'rifle_squad', { x: s.x + 6, z: s.z + 1 }, .05);
  // one autocannon burst (atk 15 x 1.65) kills at least two 9-HP riflemen
  const men = menOf(squad);
  damageActionTarget(g, squad, ifv, 15 * 1.65, 'autocannon');
  assert.ok(menOf(squad) <= men - 2, `${men} -> ${menOf(squad)} men`);
  // a missile (62 x vsArmor 1.3 - def 18 x .2 = 77) takes nearly a quarter of a tank
  const before = tank.hp;
  damageActionTarget(g, tank, ifv, ACTION_UNITS.exo_infantry.atgm.damage, 'missile');
  assert.equal(before - tank.hp, Math.round(62 * 1.3 - 18 * .2));
  // a rifle volley at the IFV: x .35 vsArmor x .5 tracked
  const hp = ifv.hp;
  damageActionTarget(g, ifv, squad, 9 * 1.65, 'rifle');
  assert.ok(hp - ifv.hp <= 2, `rifles do ${hp - ifv.hp}`);
});

test('a save from before the change: an exo squad loads as an IFV at the same health fraction; squads rescale', () => {
  const g = create('g-save'), s = g.sites[0];
  clean(g);
  const exo = g.spawn(g.civs[0], 'exo_infantry', { x: s.x + 4, z: s.z }, .05);
  const rifle = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 4, z: s.z + 1 }, .05);
  // forge the old squad stats
  Object.assign(exo, { maxHp: 510, hp: 255, radius: .139, supp: 40, suppAt: 1, plates: 2 });
  Object.assign(rifle, { maxHp: 168, hp: 84 });
  const back = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  const e2 = back.units.get(exo.id), r2 = back.units.get(rifle.id);
  assert.equal(e2.maxHp, 240); assert.equal(e2.hp, 120);
  assert.equal(e2.radius, ACTION_UNITS.exo_infantry.radius);
  assert.equal(e2.supp, undefined); assert.equal(e2.plates, undefined);
  assert.equal(r2.maxHp, 108); assert.equal(r2.hp, 54);
  assert.equal(menOf(r2), 6);
});

// ------------------------------------------------------------------ infantry as grunts
test('line infantry are cheap, quick and frail; specialists stay valuable', () => {
  const r = ACTION_UNITS.rifle_squad, m = ACTION_UNITS.militia, at = ACTION_UNITS.anti_armor, sf = ACTION_UNITS.special_forces;
  assert.equal(r.hp, 12 * 9); assert.equal(r.cost.materials, 65); assert.equal(r.time, 7); assert.equal(r.atk, 9);
  assert.equal(m.hp, 10 * 8); assert.equal(m.cost.materials, 40); assert.equal(m.time, 5); assert.equal(m.atk, 6);
  assert.equal(at.hp, 5 * 22); assert.equal(at.atk, 16);
  assert.equal(sf.hp, 8 * 26); assert.equal(sf.atk, 24);
  assert.equal(ACTION_UNITS.mortar_team.hp, 120);
  // specialists cost clearly more per squad than the line
  for (const sp of [at, sf, ACTION_UNITS.mortar_team]) assert.ok(sp.cost.materials > r.cost.materials * 1.6);
  // a tank shell (HE, x1.25 vs infantry: ~56 damage) kills several 9-HP riflemen at once (cap 4)
  const g = create(), s = g.sites[0];
  clean(g);
  const tank = g.spawn(g.civs[1], 'tank', { x: s.x + 6, z: s.z }, .05);
  const squad = g.spawn(g.civs[0], 'rifle_squad', { x: s.x + 4, z: s.z }, .05);
  damageActionTarget(g, squad, tank, 28 * 1.65 * 1.25, 'cannon');
  assert.ok(menOf(squad) <= 12 - 3 && menOf(squad) >= 12 - 4, `${menOf(squad)} men left`);
});
