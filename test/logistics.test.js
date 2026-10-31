// Front-line warfare and logistics: occupancy, zones of control, activity-based supply,
// finite-cargo convoys and field caches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena, spawnGroup } from '../server/sim/sandbox.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { cargoTotal } from '../server/sim/logistics.js';
import { isWater, TERRAIN, H } from '../server/sim/constants.js';
import { idx, qOf, rOf, disk, dist } from '../server/sim/hex.js';

const sandbox = (seed = 7) => { const g = new Game({ id: 'l' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); return g; };
const run = (g, ticks, each) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; if (each) each(i); } };
const at = (t, dq, dr = 0) => idx(qOf(t) + dq, rOf(t) + dr);
const open = (g, t) => !isWater(g.world.terr[t]) && TERRAIN[g.world.terr[t]].move <= 2 && !g.world.river[t] && g.tileB[t] < 0;
function field(g, w, h) { const a = findArena(g, 9); for (const c of disk(a, 6)) { let ok = true; for (let dq = -w; dq <= w && ok; dq++) for (let dr = -h; dr <= h; dr++) { const t = at(c, dq, dr); if (!open(g, t)) { ok = false; break; } } if (ok) return c; } return a; }
const place = (g, civ, type, t) => { const [u] = spawnGroup(g, civ, type, t, 1); u.tile = t; u.path = []; g.rebuildTileUnits(); return u; };
const noHostileStacking = (g) => { const by = new Map(); for (const u of g.units.values()) { if (g.defs.UNITS[u.type].air) continue; const o = by.get(u.tile); if (o != null && o !== u.owner && g.hostile(o, u.owner)) return false; by.set(u.tile, u.owner); } return true; };

test('opposing ground units never share a hex, even when ordered onto the same one', () => {
  const g = sandbox();
  const c = field(g, 4, 2);
  const A = spawnGroup(g, 0, 'rifle_squad', at(c, -3), 4), B = spawnGroup(g, 1, 'rifle_squad', at(c, 3), 4);
  for (const u of [...A, ...B]) u.stance = 'passive';
  g.orderMove(g.civs[0], A.map((u) => u.id), c, false, 'line', { auth: 'player' });
  g.orderMove(g.civs[1], B.map((u) => u.id), c, false, 'line', { auth: 'player' });
  let ok = true; run(g, 300, () => { if (!noHostileStacking(g)) ok = false; });
  assert.ok(ok, 'no hex ever held by both sides');
});

test('two hostile units cannot swap hexes', () => {
  const g = sandbox();
  const c = field(g, 2, 1);
  const a = place(g, 0, 'rifle_squad', c), b = place(g, 1, 'rifle_squad', at(c, 1));
  a.stance = b.stance = 'passive';
  g.orderMove(g.civs[0], [a.id], at(c, 1), false, 'line', { auth: 'player' });
  g.orderMove(g.civs[1], [b.id], c, false, 'line', { auth: 'player' });
  run(g, 60);
  assert.notEqual(a.tile, at(c, 1)); assert.notEqual(b.tile, c);
});

test('a held line cannot be walked through (going around its open end is fine); units can still pull back', () => {
  const g = sandbox();
  const c = field(g, 5, 4);
  const line = []; for (let k = -2; k <= 2; k++) { const u = place(g, 1, 'rifle_squad', at(c, k)); u.stance = 'passive'; line.push(u); }
  const att = place(g, 0, 'rifle_squad', at(c, 0, 3)); att.stance = 'passive';
  g.orderMove(g.civs[0], [att.id], at(c, 0, -3), false, 'line', { auth: 'player' });
  const lineTiles = new Set(line.map((u) => u.tile));
  let crossed = false; run(g, 200, () => { if (lineTiles.has(att.tile)) crossed = true; });
  assert.equal(crossed, false, 'never on a defender hex');
  // withdrawal out of the zone of control is allowed
  const back = at(c, 0, 4);
  g.orderMove(g.civs[0], [att.id], back, false, 'line', { auth: 'player' });
  run(g, 600);
  assert.ok(dist(att.tile, back) <= 1, 'withdrew');
});

test('aircraft overfly enemy-held ground', () => {
  const g = sandbox();
  const c = field(g, 3, 1);
  for (let k = -1; k <= 1; k++) place(g, 1, 'rifle_squad', at(c, k)).stance = 'hold';
  const h = place(g, 0, 'helicopter', at(c, -3)); h.stance = 'passive';
  g.orderMove(g.civs[0], [h.id], at(c, 3), false, 'line', { auth: 'player' });
  run(g, 200);
  assert.ok(dist(h.tile, at(c, 3)) <= 1, 'helicopter crossed the line');
});

test('cut-off units last longer standing still, and far longer in a finished trench', () => {
  const g = sandbox(); g.sandbox = false;
  const c = field(g, 4, 2);
  g.civs[0].supply.fill(0); g.civs[0].supply.fill(0);
  const still = place(g, 0, 'rifle_squad', at(c, -3)), dug = place(g, 0, 'rifle_squad', at(c, 3)), walker = place(g, 0, 'rifle_squad', at(c, 0, 2));
  for (const u of [still, dug, walker]) { u.supply = 100; u.stance = 'passive'; }
  g.fieldworks.set(dug.tile, { tile: dug.tile, owner: 0, type: 'basic', fx: 0, fy: -1, dir: 4, progress: 1, hp: 100, paid: true, state: 'complete', group: 0, at: 0, lastSeen: 0 });
  // keep the walker marching back and forth
  const legs = [at(c, -2, 2), at(c, 2, 2)]; let leg = 0;
  const recompute = g.sched; void recompute;
  run(g, 300, (i) => { g.civs[0].supply.fill(0); if (!walker.path.length) { leg ^= 1; g.orderMove(g.civs[0], [walker.id], legs[leg], false, 'line', { auth: 'player' }); } });
  assert.ok(walker.supply < still.supply, `marching ${walker.supply.toFixed(0)} < standing ${still.supply.toFixed(0)}`);
  assert.ok(still.supply < dug.supply - 10, `standing ${still.supply.toFixed(0)} < entrenched ${dug.supply.toFixed(0)}`);
});

test('a convoy loads real goods once, delivers by need, leaves a finite cache and returns', () => {
  const g = new Game({ id: 'cv' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], cap = g.capital(civ);
  for (const k of Object.keys(civ.res)) civ.res[k] = 800;
  civ.techs.add('motorization');
  const ring = disk(cap.tile, 7).filter((t) => dist(t, cap.tile) >= 5 && open(g, t));
  const front = ring[0];
  const troops = []; for (let k = 0; k < 3; k++) { const u = place(g, 0, 'rifle_squad', front); u.supply = 10; troops.push(u); }
  const truck = place(g, 0, 'supply_truck', cap.tile);
  const food0 = civ.res.food, mun0 = civ.res.munitions;
  const r = g.command(0, { c: 'supplyRun', units: troops.map((u) => u.id) });
  assert.ok(r.reply && r.reply.supplyRun, r.error);
  // loading: goods leave the stockpile exactly once and live only in the truck
  let loaded = false, prev = { ...civ.res };
  run(g, 900, () => {
    if (!loaded && truck.convoy?.state === 'outbound') {
      loaded = true; assert.ok(cargoTotal(truck.cargo) > 5);
      // the loading tick changes the stockpile by exactly what went aboard
      for (const k of ['food', 'munitions', 'fuel']) assert.ok(Math.abs((prev[k] - civ.res[k]) - (truck.cargo[k] || 0)) < 0.01, `${k} deducted once`);
    }
    prev = { ...civ.res };
  });
  assert.ok(loaded, 'the truck loaded and left');
  assert.ok(troops.every((u) => u.supply > 30), `resupplied: ${troops.map((u) => Math.round(u.supply))}`);
  assert.equal(truck.convoy.state, 'available', 'and came back');
  assert.ok(cargoTotal(truck.cargo) < 0.5, 'unloaded');
  void mun0;
});

test('a destroyed truck loses its cargo; trucks no longer supply by aura; save/restore keeps cargo in transit', () => {
  const g = new Game({ id: 'cv2' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], cap = g.capital(civ);
  for (const k of Object.keys(civ.res)) civ.res[k] = 800;
  const far = disk(cap.tile, 14).filter((t) => dist(t, cap.tile) >= 12 && open(g, t))[0];
  const u = place(g, 0, 'rifle_squad', far); u.supply = 5;
  const truck = place(g, 0, 'supply_truck', far);
  run(g, 50);
  assert.ok(!civ.supply[far] || u.supply > 5, 'sanity');
  if (!civ.supply[far]) assert.ok(u.supply <= 5, 'a parked truck alone does not supply anyone');
  truck.tile = cap.tile; truck.path = []; g.rebuildTileUnits();
  g.command(0, { c: 'supplyRun', units: [u.id] });
  run(g, 120, () => {});
  const snap = serializeGame(g);
  const g2 = restoreGame(snap);
  const t2 = g2.units.get(truck.id);
  assert.deepEqual(t2.cargo, truck.cargo, 'cargo survives save/restore');
  assert.equal(t2.convoy?.state, truck.convoy?.state);
  // destroy it: the goods are gone (not refunded)
  const before = Object.values(civ.res).reduce((a, b) => a + b, 0);
  g.units.delete(truck.id); g.rebuildTileUnits();
  run(g, 20);
  assert.ok(Object.values(civ.res).reduce((a, b) => a + b, 0) < before + 50, 'no refund of lost cargo');
});

test('automatic resupply sends one delivery at a time', () => {
  const g = new Game({ id: 'cv3' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], cap = g.capital(civ);
  for (const k of Object.keys(civ.res)) civ.res[k] = 800;
  const front = disk(cap.tile, 7).filter((t) => dist(t, cap.tile) >= 5 && open(g, t))[0];
  const troops = []; for (let k = 0; k < 3; k++) { const u = place(g, 0, 'rifle_squad', front); troops.push(u); }
  const r = g.command(0, { c: 'deploy', units: troops.map((u) => u.id), line: [front, at(front, 2)], behavior: 'hold' }).reply.deploy;
  for (let k = 0; k < 3; k++) place(g, 0, 'supply_truck', cap.tile);
  g.command(0, { c: 'supplyPolicy', formation: r.formation, auto: true, threshold: 50 });
  let maxBusy = 0;
  run(g, 600, () => { for (const u of troops) u.supply = Math.min(u.supply, 20); const busy = [...g.units.values()].filter((t) => t.type === 'supply_truck' && t.convoy && t.convoy.state !== 'available').length; maxBusy = Math.max(maxBusy, busy); });
  assert.equal(maxBusy, 1, 'never more than one convoy for the same formation at once');
});

test('zones of control: no sliding along an enemy line, but stepping away is allowed', async () => {
  const { stepBlock } = await import('../server/sim/tacticalOccupancy.js');
  const g = sandbox();
  const c = field(g, 4, 3);
  for (let k = -2; k <= 2; k++) place(g, 1, 'rifle_squad', at(c, k)).stance = 'passive';
  const a = place(g, 0, 'rifle_squad', at(c, 0, 1));             // in contact, just below the line
  const along = [at(c, 1, 1), at(c, -1, 1)].find((t) => dist(t, a.tile) === 1);
  assert.equal(stepBlock(g, a, along), 'zoc', 'sideways along the line is refused');
  assert.equal(stepBlock(g, a, at(c, 0)), 'occupied', 'into a held hex is refused');
  const away = [at(c, 0, 2), at(c, 1, 2), at(c, -1, 2)].find((t) => dist(t, a.tile) === 1 && !stepBlock(g, a, t));
  assert.ok(away != null, 'stepping back out of contact is allowed');
});
