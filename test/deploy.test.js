// Line deployment, formation density, formations over time, and area damage on stacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena, spawnGroup } from '../server/sim/sandbox.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { planDeployment, hexXY } from '../server/sim/deploy.js';
import { UNITS, W, H, isWater, TERRAIN } from '../server/sim/constants.js';
import { idx, qOf, rOf, dist, disk, WRAP } from '../server/sim/hex.js';

const sandbox = (seed = 7) => { const g = new Game({ id: 'd' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); return g; };
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; } };
const along = (t, k) => idx(qOf(t) + k, rOf(t));
const flat = (g, t) => !isWater(g.world.terr[t]) && TERRAIN[g.world.terr[t]].move <= 2 && !g.world.river[t];
// an arena with a straight run of open ground
function lineSpot(g, len) {
  const a = findArena(g, 8);
  for (const c of disk(a, 6)) { let ok = true; for (let k = 0; k < len; k++) if (!flat(g, along(c, k)) || g.tileB[along(c, k)] >= 0) { ok = false; break; } if (ok) return c; }
  return a;
}
const ids = (us) => us.map((u) => u.id);

test('twelve squads on a twelve-hex line spread one per hex; on two hexes they stack six deep', () => {
  const g = sandbox();
  const s = lineSpot(g, 13);
  const us = spawnGroup(g, 0, 'rifle_squad', idx(qOf(s) + 4, rOf(s) + 4 < H ? rOf(s) + 4 : rOf(s) - 4), 12);
  let r = g.command(0, { c: 'deploy', units: ids(us), line: [s, along(s, 11)] }).reply.deploy;
  assert.equal(r.slots.length, 12);
  assert.equal(new Set(r.slots.map(([, t]) => t)).size, 12, 'one squad per hex');
  assert.equal(r.label, 'dispersed');
  r = g.command(0, { c: 'deploy', units: ids(us), line: [s, along(s, 1)] }).reply.deploy;
  const per = new Map(r.perHex);
  assert.equal(r.slots.length + r.overflow.length, 12, 'nothing silently dropped');
  assert.ok(Math.max(...per.values()) >= 4, 'a short line concentrates the force');
  assert.equal(r.label, 'dense');
  for (const [t, n] of per) assert.ok(n <= 6, `never above legal capacity (${n} on ${t})`);
  // spread density refuses to stack: the rest go to rear ranks
  r = g.command(0, { c: 'deploy', units: ids(us), line: [s, along(s, 1)], density: 'spread' }).reply.deploy;
  assert.ok(Math.max(...new Map(r.perHex).values()) === 1);
});

test('the same order is deterministic and reversing the drag does not make units cross', () => {
  const g = sandbox();
  const s = lineSpot(g, 9);
  const us = spawnGroup(g, 0, 'rifle_squad', idx(qOf(s) + 4, rOf(s) + 3), 8);
  const plan = (line) => g.command(0, { c: 'deploy', units: ids(us), line }).reply.deploy.slots;
  const a = plan([s, along(s, 7)]), b = plan([s, along(s, 7)]);
  assert.deepEqual(a, b, 'deterministic');
  // left-to-right order of units (by column) matches left-to-right order of slots both ways
  const X = (t) => hexXY(t, W)[0];
  const crossings = (slots) => { const m = new Map(slots); let n = 0; for (const a of us) for (const b of us) if (X(a.tile) < X(b.tile) - 1e-6 && X(m.get(a.id)) > X(m.get(b.id)) + 1e-6) n++; return n; };
  const fwd = crossings(plan([s, along(s, 7)])), rev = crossings(plan([along(s, 7), s]));
  const sorted = (n) => n === 0;
  assert.ok(sorted(fwd) && sorted(rev), 'no path crossing in either drag direction');
});

test('mixed forces form ranks: infantry in front, artillery and trucks behind', () => {
  const g = sandbox();
  const s = lineSpot(g, 6);
  const start = idx(qOf(s) + 2, rOf(s) + 4);
  const inf = spawnGroup(g, 0, 'rifle_squad', start, 4), art = spawnGroup(g, 0, 'field_gun', start, 2), trk = spawnGroup(g, 0, 'supply_truck', start, 1);
  const r = g.command(0, { c: 'deploy', units: ids([...inf, ...art, ...trk]), line: [s, along(s, 5)], mode: 'depth' }).reply.deploy;
  const m = new Map(r.slots);
  const front = new Set(inf.map((u) => m.get(u.id)));
  for (const u of [...art, ...trk]) assert.ok(!front.has(m.get(u.id)), 'support stands behind the line');
});

test('formations persist through save/restore; hold-line units stay; detach and rejoin', () => {
  const g = sandbox();
  const s = lineSpot(g, 7);
  const us = spawnGroup(g, 0, 'rifle_squad', idx(qOf(s) + 3, rOf(s) + 3), 6);
  const r = g.command(0, { c: 'deploy', units: ids(us), line: [s, along(s, 5)], behavior: 'hold' }).reply.deploy;
  run(g, 400);
  const f = g.formations.get(r.formation);
  assert.equal(f.status, 'deployed');
  assert.ok(us.every((u) => u.tile === f.slots[u.id]), 'everyone reached their slot');
  assert.ok(us.every((u) => u.stance === 'hold'), 'hold line');
  // move one by hand: only it detaches
  g.command(0, { c: 'move', units: [us[0].id], tile: idx(qOf(s) + 2, rOf(s) + 5) });
  assert.equal(us[0].detached, true); assert.ok(us.slice(1).every((u) => !u.detached));
  const g2 = restoreGame(serializeGame(g));
  const f2 = g2.formations.get(r.formation);
  assert.ok(f2 && f2.units.length === 6, 'formation survives save/restore');
  assert.equal(g2.units.get(us[0].id).detached, true);
  g2.command(0, { c: 'formation', id: r.formation, op: 'rejoin' });
  run(g2, 300);
  assert.equal(g2.units.get(us[0].id).tile, f2.slots[us[0].id], 'rejoined its slot');
});

test('reinforcing a formation fills free room without moving the original units', () => {
  const g = sandbox();
  const s = lineSpot(g, 5);
  const us = spawnGroup(g, 0, 'rifle_squad', idx(qOf(s) + 2, rOf(s) + 3), 4);
  const r = g.command(0, { c: 'deploy', units: ids(us), line: [s, along(s, 3)] }).reply.deploy;
  const before = { ...g.formations.get(r.formation).slots };
  const more = spawnGroup(g, 0, 'rifle_squad', idx(qOf(s) + 2, rOf(s) + 4), 4);
  const rr = g.command(0, { c: 'formation', id: r.formation, op: 'reinforce', units: ids(more) });
  assert.equal(rr.reply.reinforce.placed, 4);
  const after = g.formations.get(r.formation).slots;
  for (const u of us) assert.equal(after[u.id], before[u.id], 'original slots unchanged');
});

test('a mortar shell on a stacked hex damages every squad there, not one', () => {
  const g = sandbox();
  const s = lineSpot(g, 4);
  const stack = spawnGroup(g, 1, 'rifle_squad', s, 1);
  for (let i = 0; i < 5; i++) { const [u] = spawnGroup(g, 1, 'rifle_squad', s, 1); g.units.get(u.id); stack.push(u); }
  for (const u of stack) { u.tile = s; u.path = []; u.stance = 'passive'; }
  const apart = [];
  for (let k = 3; k < 9; k++) { const [u] = spawnGroup(g, 1, 'rifle_squad', along(s, k + 2), 1); u.tile = along(s, k + 2); u.stance = 'passive'; apart.push(u); }
  g.rebuildTileUnits();
  const blast = g.defs.blastAt || null; void blast;
  const hp0 = new Map([...stack, ...apart].map((u) => [u.id, u.hp]));
  g.areaImpactForTest(0, s, 'mortar');
  const hitStack = stack.filter((u) => !g.units.has(u.id) || g.units.get(u.id).hp < hp0.get(u.id)).length;
  assert.equal(hitStack, 6, 'all six squads in the stack were hit');
  const hitApart = apart.filter((u) => dist(u.tile, s) > 1 && g.units.get(u.id).hp < hp0.get(u.id)).length;
  assert.equal(hitApart, 0, 'squads outside the blast are untouched');
});

test('the browser planner and the server agree (pure planner, same inputs)', () => {
  const env = { W: 20, H: 20, wrap: true, passable: () => true, capacity: () => 6, occupied: () => 0 };
  const units = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, tile: 5 * 20 + i, role: 'front', air: false }));
  const a = planDeployment(env, units, [10 * 20 + 18, 10 * 20 + 2]), b = planDeployment(env, units, [10 * 20 + 18, 10 * 20 + 2]);
  assert.deepEqual([...a.slots], [...b.slots]);
  // across the wrap seam
  const s = planDeployment(env, units, [10 * 20 + 17, 10 * 20 + 3]);
  assert.equal(s.overflow.length, 0);
  assert.ok([...s.slots.values()].some((t) => t % 20 >= 17) && [...s.slots.values()].some((t) => t % 20 <= 3), 'a line across the seam stays whole');
});
