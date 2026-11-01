// Front-line warfare: occupancy and zones of control; troops are always supplied.
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
  const h = place(g, 0, 'recon_drone', at(c, -3));        // unarmed: it simply flies over the line
  g.orderMove(g.civs[0], [h.id], at(c, 3), false, 'line', { auth: 'player' });
  let closest = Infinity;
  for (let i = 0; i < 200; i++) { g.tick(); g.outbox.length = 0; if (g.units.has(h.id)) closest = Math.min(closest, dist(h.tile, at(c, 3))); }
  assert.ok(closest <= 2, `the drone crossed the enemy line to its scouting area (closest ${closest})`);
});

test('troops are always supplied: no attrition deep in enemy land, recovery out of combat, no supply runs', () => {
  const g = sandbox();
  // far from any friendly territory, out of reach of anyone's guns
  const cap = g.capital(g.civs[0]);
  const away = [...Array(g.world.owner.length).keys()].find((t) => g.world.owner[t] < 0 && open(g, t) && dist(t, cap.tile) > 15 && ![...g.buildings.values()].some((b) => dist(b.tile, t) < 7) && ![...g.units.values()].some((x) => dist(x.tile, t) < 7));
  const u = place(g, 0, 'rifle_squad', away);
  u.stance = 'passive'; u.hp = u.maxHp * 0.5; u.lastCombat = -999;
  const hp0 = u.hp;
  run(g, 300, () => { u.lastCombat = -999; });
  assert.ok(g.units.has(u.id), 'no attrition far from home');
  assert.equal(u.supply, 100); assert.equal(u.outOfSupply, false);
  assert.ok(u.hp > hp0, 'recovering out of combat');
  assert.match(g.command(0, { c: 'supplyRun', units: [u.id] }).error, /supplied automatically/);
  assert.ok(!g.defs.BUILDINGS.town.trains.includes('supply_truck'), 'no supply trucks to raise');
  void serializeGame; void restoreGame; void cargoTotal; void H; void dist;
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
