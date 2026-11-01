// Air operations and anti-air: one mission order drives launch -> mission -> return -> landing ->
// servicing from real stock -> relaunch; finite fuel and ammunition; bases, holding and diversion;
// explicit weapon target classes; AA batteries and airburst events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { spawnUnit } from '../server/sim/military.js';
import { onAircraftBuilt } from '../server/sim/airOperations.js';
import { weaponVs } from '../server/sim/weapons.js';
import { UNITS, isWater, TERRAIN } from '../server/sim/constants.js';
import { disk, dist } from '../server/sim/hex.js';

const run = (g, ticks, each) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; if (each && each(i) === false) break; } };
function world(seed = 11) {
  const g = new Game({ id: 'a' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0];
  for (const k of Object.keys(civ.res)) civ.res[k] = 3000;
  for (const t of ['aviation', 'air_operations', 'drones', 'air_defense', 'metallurgy', 'petroleum', 'computing']) civ.techs.add(t);
  civ.age = 3;
  // war with the other empire so targets are hostile
  g.diplomacy.rel(0, 1).state = 'war';
  return g;
}
const land = (g, t) => !isWater(g.world.terr[t]) && Number.isFinite(TERRAIN[g.world.terr[t]].move) && g.tileB[t] < 0;
function airfield(g, civId = 0) {
  const cap = g.capital(g.civs[civId]);
  const t = disk(cap.tile, 3).find((x) => dist(x, cap.tile) >= 2 && land(g, x) && g.world.owner[x] === civId);
  const b = g.placeBuilding(g.civs[civId], 'airfield', t, true); b.cityId = cap.id;
  return b;
}
function aircraft(g, type, base) { const u = spawnUnit(g, g.civs[base.owner], type, base.tile); onAircraftBuilt(g, u, base); return u; }
const away = (g, from, d) => disk(from, d).find((t) => dist(t, from) === d && land(g, t));

test('a fighter patrol is one order: launch, orbit, return on fuel, land, service from real stock, relaunch', () => {
  const g = world();
  const base = airfield(g), civ = g.civs[0];
  const f = aircraft(g, 'fighter', base);
  assert.equal(f.air.state, 'ready'); assert.ok(f.grounded);
  const spot = away(g, base.tile, 8);
  const r = g.command(0, { c: 'airMission', units: [f.id], kind: 'patrol', tile: spot });
  assert.equal(r.reply.air.assigned, 1);
  const seen = new Set(); let minFuel = 999;
  const fuel0 = civ.res.fuel;
  run(g, 1800, () => { seen.add(f.air.state); if (!f.grounded) minFuel = Math.min(minFuel, f.air.fuel); });
  for (const s of ['launching', 'outbound', 'mission', 'returning', 'servicing']) assert.ok(seen.has(s), `went through ${s} (${[...seen]})`);
  assert.ok(minFuel > 0, 'turned for home before the tank ran dry');
  assert.ok(g.units.has(f.id), 'still flying missions');
  assert.ok(civ.res.fuel < fuel0, 'refuelling drew on the national fuel stock');
  assert.ok(f.air.mission && f.air.mission.kind === 'patrol', 'the patrol mission survives servicing');
});

test('aircraft do not get free fuel from a supply radius: aloft, the tank always drains', () => {
  const g = world();
  const base = airfield(g);
  const f = aircraft(g, 'fighter', base);
  g.command(0, { c: 'airMission', units: [f.id], kind: 'patrol', tile: away(g, base.tile, 2) });
  run(g, 60);
  const a = f.air.fuel; run(g, 30);
  assert.ok(!f.grounded && f.air.fuel < a, 'burning fuel right next to its own airfield');
});

test('servicing needs real resources: an empty stockpile keeps the aircraft waiting', () => {
  const g = world();
  const base = airfield(g), civ = g.civs[0];
  const f = aircraft(g, 'fighter', base);
  f.air.fuel = 10; f.air.state = 'landing'; f.air.at = g.time;
  civ.res.fuel = 0;
  run(g, 20);
  assert.equal(f.air.state, 'awaiting');
  civ.res.fuel = 500; run(g, 30);
  assert.ok(f.air.state === 'servicing' || f.air.state === 'ready');
});

test('a bomber strike: passes over the target, drops its finite load, returns to rearm; area damage hits the whole stack', () => {
  const g = world();
  const base = airfield(g);
  const bomber = aircraft(g, 'bomber', base);
  const tgtTile = away(g, base.tile, 9);
  const stack = []; for (let i = 0; i < 4; i++) { const e = spawnUnit(g, g.civs[1], 'rifle_squad', tgtTile); e.stance = 'hold'; stack.push(e); }
  g.rebuildTileUnits(); g.refreshVisibility();
  const hp0 = stack.map((e) => e.hp);
  g.command(0, { c: 'airMission', units: [bomber.id], kind: 'strike', tile: tgtTile });
  let returned = false;
  run(g, 900, () => { if (bomber.air.state === 'returning' || bomber.air.state === 'servicing') returned = true; });
  assert.ok(returned, 'came home after the load was spent');
  const hit = stack.filter((e, i) => !g.units.has(e.id) || e.hp < hp0[i]).length;
  assert.ok(hit >= 3, `bombs hit the stacked squads (${hit} of 4)`);
});

test('a one-way drone is consumed by its strike', () => {
  const g = world();
  const base = g.placeBuilding(g.civs[0], 'drone_works', airfield(g).tile + 2 < 0 ? 0 : away(g, g.capital(g.civs[0]).tile, 2), true);
  const d = aircraft(g, 'oneway_drone', base);
  const tgt = away(g, base.tile, 6); const e = spawnUnit(g, g.civs[1], 'rifle_squad', tgt); g.rebuildTileUnits(); g.refreshVisibility();
  const hp0 = e.hp;
  g.command(0, { c: 'airMission', units: [d.id], kind: 'strike', tile: tgt, target: { kind: 'unit', id: e.id } });
  run(g, 400, () => g.units.has(d.id));
  assert.ok(!g.units.has(d.id), 'the drone is gone');
  assert.ok(!g.units.has(e.id) || e.hp < hp0, 'its warhead hit the target');
});

test('a full airfield queues landings and diverts when it must; a destroyed base sends aircraft elsewhere', () => {
  const g = world();
  const a = airfield(g), civ = g.civs[0];
  const b2 = g.placeBuilding(civ, 'airfield', away(g, a.tile, 4), true);
  const craft = []; for (let i = 0; i < 6; i++) craft.push(aircraft(g, 'fighter', a));
  // all come home at once with low fuel
  for (const u of craft) { u.air.state = 'returning'; u.air.fuel = 14; u.tile = away(g, a.tile, 1); u.path = []; u.grounded = false; }
  run(g, 80);
  const busy = (b) => craft.filter((u) => g.units.has(u.id) && u.air.home === b.id && ['servicing', 'landing', 'awaiting'].includes(u.air.state)).length;
  assert.ok(busy(a) <= 4 && busy(b2) <= 4, 'no more than the slots service at once at either base');
  assert.ok(craft.some((u) => g.units.has(u.id) && u.air.home === b2.id), 'some diverted to the other base');
  // destroy the second base: its aircraft divert back
  g.damageBuilding(b2, 1e9, 1, 'combat');
  run(g, 10);
  assert.ok(craft.every((u) => !g.units.has(u.id) || u.air.home !== b2.id), 'nothing still calls the destroyed base home');
});

test('explicit target classes: small arms and tank guns never hit aircraft; fighters and AA do; bombers cannot fight fighters', () => {
  for (const t of ['militia', 'rifle_squad', 'tank', 'field_gun', 'scout_buggy', 'armored_car', 'helicopter', 'bomber', 'strike_swarm']) assert.equal(weaponVs(t === 'helicopter' ? 'rockets' : t === 'bomber' ? 'bombs' : t === 'strike_swarm' ? 'drone_strike' : { militia: 'carbine', rifle_squad: 'rifle', tank: 'cannon', field_gun: 'howitzer', scout_buggy: 'mg', armored_car: 'mg' }[t], UNITS.fighter), 0, `${t} cannot target a fighter`);
  assert.ok(weaponVs('aam', UNITS.bomber) > 1, 'fighters intercept bombers');
  assert.ok(weaponVs('flak', UNITS.fighter) > 1 && weaponVs('airburst', UNITS.helicopter) > 1, 'air defense engages aircraft');
  assert.equal(weaponVs('airburst', UNITS.tank), 0, 'an AA battery cannot target tanks');
  assert.ok(weaponVs('autocannon', UNITS.helicopter) > 0 && weaponVs('autocannon', UNITS.fighter) === 0, 'mechanized infantry: low-flying aircraft only');
  assert.equal(weaponVs('mg', UNITS.helicopter), 0, 'bunker machine guns are ground-only');
  assert.ok(weaponVs('aam', UNITS.tank) < 0.5, 'a fighter is inefficient against ground forces');
});

test('an AA battery fires airbursts at a detected aircraft, never at ground units, and stops without munitions', () => {
  const g = world();
  const civ = g.civs[0], cap = g.capital(civ);
  const t = disk(cap.tile, 2).find((x) => dist(x, cap.tile) === 2 && land(g, x) && g.world.owner[x] === 0);
  const aa = g.placeBuilding(civ, 'aa_battery', t, true);
  const heli = spawnUnit(g, g.civs[1], 'helicopter', away(g, t, 2)); heli.air = { home: -1, state: 'mission', fuel: 999, ammo: 6, mission: { kind: 'patrol', tile: heli.tile, radius: 1 } }; heli.grounded = false; heli.stance = 'passive';
  const tank = spawnUnit(g, g.civs[1], 'tank', away(g, t, 1)); tank.stance = 'passive';
  g.rebuildTileUnits(); g.refreshVisibility();
  const evs0 = g.eventSeq, tankHp = tank.hp, mun0 = civ.res.munitions;
  run(g, 60, () => { tank.supply = 100; });
  const shots = g.events.filter((e) => e.i > evs0 && e.k === 'launch' && e.sb === 1 && e.s === aa.id);
  assert.ok(shots.length >= 3, `the battery engaged the helicopter (${shots.length} volleys)`);
  assert.ok(g.events.some((e) => e.i > evs0 && e.k === 'impact' && e.ab), 'airburst impacts');
  void tankHp; // the capital's own garrison may shoot the tank; the battery must not
  assert.equal(g.events.filter((e) => e.i > evs0 && e.s === aa.id && e.sb === 1 && (e.k === 'launch' || e.k === 'fire') && e.t === tank.id).length, 0, 'the tank beside it was never targeted by the battery');
  assert.ok(civ.res.munitions < mun0, 'each volley spends munitions');
  civ.res.munitions = 0; const n0 = g.eventSeq;
  run(g, 40, () => { tank.supply = 100; });
  assert.equal(g.events.filter((e) => e.i > n0 && e.k === 'launch' && e.sb === 1 && e.s === aa.id).length, 0, 'no munitions: no fire');
  assert.ok(aa.noAmmo, 'it reports that it needs munitions');
});

test('air operations are deterministic', () => {
  const sim = () => { const g = world(21); const base = airfield(g); const f = aircraft(g, 'fighter', base); g.command(0, { c: 'airMission', units: [f.id], kind: 'patrol', tile: away(g, base.tile, 7) }); run(g, 500); return [f.tile, f.air.state, +f.air.fuel.toFixed(3)].join('|'); };
  assert.equal(sim(), sim());
});

test('the AI runs an air force: builds aircraft at its airfield, keeps patrols up, strikes unprotected concentrations, avoids AA', async () => {
  const { aaThreat } = await import('../server/sim/airPlanner.js');
  const g = new Game({ id: 'ai' + Math.random(), seed: 11, slots: [{ personality: 'warlord' }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0];
  for (const k of Object.keys(civ.res)) civ.res[k] = 4000;
  for (const t of ['aviation', 'air_operations', 'drones', 'air_defense', 'metallurgy', 'petroleum', 'computing', 'motorization', 'mechanization']) civ.techs.add(t);
  civ.age = 3;
  const base = airfield(g);
  g.diplomacy.rel(0, 1).state = 'war'; g.civs[1].ai = null;   // a passive enemy: its troops stay put
  // an enemy concentration near the AI's border, in the open
  const cap = g.capital(civ), tgt = away(g, cap.tile, 7);
  for (let i = 0; i < 4; i++) { const e = spawnUnit(g, g.civs[1], 'rifle_squad', tgt); e.stance = 'hold'; }
  g.rebuildTileUnits(); g.refreshVisibility();
  let maxAir = 0, patrolled = false, struck = false;
  run(g, 2400, () => { g.diplomacy.rel(0, 1).state = 'war'; for (const u of g.units.values()) if (u.owner === 0 && u.air?.mission) { if (u.air.mission.kind === 'patrol') patrolled = true; if (u.air.mission.kind === 'strike') struck = true; } maxAir = Math.max(maxAir, [...g.units.values()].filter((u) => u.owner === 0 && u.air).length); });
  assert.ok(maxAir >= 2, `aircraft were built (${maxAir})`);
  assert.ok(patrolled, 'a patrol was flown');
  assert.ok(struck, 'a strike was flown at the exposed troops');
  // a target under AA cover scores as a threat the planner avoids for helicopters
  const aa = g.placeBuilding(g.civs[1], 'aa_battery', away(g, tgt, 1), true);
  civ.explored[aa.tile] = 1;
  assert.ok(aaThreat(g, civ, tgt) > 0, 'known AA coverage is counted');
  void base;
});
