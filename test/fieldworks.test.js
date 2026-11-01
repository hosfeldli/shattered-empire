// Trench lines: planned like roads, built by national crews (no troops on the line), cover,
// artillery on stacks in trenches, city growth, persistence, the legacy alias and deployments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena, spawnGroup } from '../server/sim/sandbox.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { coverAt } from '../server/sim/combat.js';
import { urbanStep, districtRadius, trenchCrews, FIELDWORKS } from '../server/sim/fieldworks.js';
import { activityOf } from '../server/sim/logistics.js';
import { isWater, TERRAIN, H } from '../server/sim/constants.js';
import { idx, qOf, rOf, disk, dist } from '../server/sim/hex.js';

const sandbox = (seed = 7) => { const g = new Game({ id: 'f' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); for (const k of Object.keys(g.civs[0].res)) g.civs[0].res[k] = 2000; return g; };
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; } };
const along = (t, k) => idx(qOf(t) + k, rOf(t));
const open = (g, t) => !isWater(g.world.terr[t]) && TERRAIN[g.world.terr[t]].move <= 2 && !g.world.river[t] && g.tileB[t] < 0 && !g.urban[t];
function spot(g, len) { const a = findArena(g, 8); for (const c of disk(a, 6)) { let ok = true; for (let k = 0; k < len; k++) if (!open(g, along(c, k)) || (g.world.owner[along(c, k)] !== 0 && !g.civs[0].supply[along(c, k)])) { ok = false; break; } if (ok) return c; } return a; }
const north = (t, k) => idx(qOf(t), rOf(t) - k);

test('a drawn trench line is built by national crews: no troops needed, preview matches commit, several segments at once', () => {
  const g = sandbox();
  const s = spot(g, 6);
  const civ = g.civs[0];
  let spent = 0; const pay = g.pay.bind(g); g.pay = (c2, cost, t, cat) => { if (c2.id === 0 && g.fieldworks.has(t)) spent += cost.materials || 0; return pay(c2, cost, t, cat); };
  const preview = g.command(0, { c: 'trenchPlan', points: [s, along(s, 5)], type: 'basic' }).reply.trench;
  assert.equal(preview.build, 6, 'six valid segments');
  assert.deepEqual(preview.cost, { materials: 36 }, 'six materials per earthworks segment');
  assert.ok(preview.seconds > 0 && preview.crews >= 2);
  const units0 = g.units.size;
  const r = g.command(0, { c: 'trenchPlan', points: [s, along(s, 5)], type: 'basic', commit: true }).reply;
  assert.deepEqual(r.trench.segments.map((x) => x.t), preview.segments.map((x) => x.t), 'the committed line is the previewed one');
  assert.equal(g.fieldworks.size, 6);
  assert.equal(g.units.size, units0, 'no builder units were created');
  run(g, 20);
  const working = [...g.fieldworks.values()].filter((f) => f.progress > 0).length;
  assert.ok(working >= 2 && working <= trenchCrews(g, civ), `several segments progress concurrently (${working})`);
  run(g, Math.ceil(preview.seconds * 10) + 30);
  assert.ok([...g.fieldworks.values()].every((f) => f.progress >= 1), 'all finished within the estimate');
  assert.equal(spent, 36, 'charged once per segment');
  // reinforcing charges only the difference
  civ.techs.add('fortification'); spent = 0;
  const up = g.command(0, { c: 'trenchPlan', points: [s, along(s, 5)], type: 'reinforced' }).reply.trench;
  assert.equal(up.segments.filter((x) => x.upgrade).length, 6);
  assert.deepEqual(up.cost, { materials: 24 }, 'four per segment to reinforce earthworks');
  g.command(0, { c: 'trenchPlan', points: [s, along(s, 5)], type: 'reinforced', commit: true });
  run(g, 200);
  assert.equal(spent, 24);
  assert.ok([...g.fieldworks.values()].every((f) => f.type === 'reinforced' && f.progress >= 1));
  g.pay = pay;
});

test('invalid segments are reported, never built: water, buildings, enemy troops, foreign land', () => {
  const g = sandbox();
  const civ = g.civs[0], s = spot(g, 4);
  const [e] = spawnGroup(g, 1, 'rifle_squad', along(s, 2), 1); e.tile = along(s, 2); g.rebuildTileUnits();
  const p = g.command(0, { c: 'trenchPlan', points: [s, along(s, 3)] }).reply.trench;
  const seg = p.segments.find((x) => x.t === along(s, 2));
  assert.equal(seg.ok, false); assert.match(seg.reason, /enemy/);
  void civ;
});

test('trench cover is directional, weaker for vehicles, and indirect fire still hurts; occupants use less supply', () => {
  const g = sandbox();
  const s = spot(g, 3);
  g.command(0, { c: 'trenchPlan', points: [s], facing: [0, -1], commit: true });
  const f0 = g.fieldworks.get(s); f0.fx = 0; f0.fy = -1;
  run(g, 140);
  const [u] = spawnGroup(g, 0, 'rifle_squad', s, 1); u.tile = s; g.rebuildTileUnits();
  const front = coverAt(g, u, north(s, 3), false), rear = coverAt(g, u, idx(qOf(s), rOf(s) + 3), false), indirect = coverAt(g, u, north(s, 3), true);
  assert.ok(front >= 0.24, `front cover ${front}`);
  assert.ok(rear < front && indirect < front && indirect > 0, `rear ${rear}, indirect ${indirect}`);
  assert.equal(activityOf(g, u), 'trench', 'an infantry squad in a finished trench is entrenched (low consumption)');
  const [tk] = spawnGroup(g, 0, 'tank', s, 1); tk.tile = s; g.rebuildTileUnits();
  assert.ok(coverAt(g, tk, north(s, 3), false) < front / 2, 'a tank in a trench gets little of it');
});

test('a shell on six squads in a trench hits all six, and degrades the trench', () => {
  const g = sandbox();
  const s = spot(g, 2);
  g.command(0, { c: 'trenchPlan', points: [s], commit: true });
  run(g, 140);
  assert.ok(g.fieldworks.get(s).progress >= 1);
  const us = []; for (let i = 0; i < 6; i++) { const [u] = spawnGroup(g, 0, 'rifle_squad', s, 1); u.tile = s; u.stance = 'passive'; us.push(u); }
  g.rebuildTileUnits();
  const hp0 = new Map(us.map((u) => [u.id, u.hp]));
  g.areaImpactForTest(1, s, 'howitzer');
  assert.equal(us.filter((u) => !g.units.has(u.id) || g.units.get(u.id).hp < hp0.get(u.id)).length, 6, 'every squad in the stack takes the blast');
  assert.ok(!g.fieldworks.has(s) || g.fieldworks.get(s).hp < 100, 'the trench is damaged');
});

test('no trenches on buildings or city districts; growth removes them; borders alone do not', () => {
  const g = new Game({ id: 'u' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], cap = g.capital(civ);
  for (const k of Object.keys(civ.res)) civ.res[k] = 2000;
  urbanStep(g);
  assert.equal(g.urban[cap.tile], 1);
  const r1 = g.command(0, { c: 'trenchPlan', points: [cap.tile] }).reply.trench;
  assert.equal(r1.build, 0); assert.match(r1.segments[0].reason, /developed city|building/);
  // a rural hex inside the borders, two rings out
  const ring = disk(cap.tile, 2).filter((t) => dist(t, cap.tile) === 2 && open(g, t) && g.world.owner[t] === 0);
  const t = ring[0];
  g.command(0, { c: 'trenchPlan', points: [t], commit: true });
  run(g, 200);
  assert.ok(g.fieldworks.has(t), 'trench inside the borders but outside the districts stays');
  const [u] = spawnGroup(g, 0, 'rifle_squad', t, 1); u.tile = t; g.rebuildTileUnits();
  cap.pop = 130; for (let i = 0; i < 4; i++) urbanStep(g);
  assert.ok(districtRadius(cap) >= 2);
  if (g.urban[t]) {
    assert.ok(!g.fieldworks.has(t), 'development removed the trench');
    assert.ok(g.units.has(u.id) && g.units.get(u.id).tile === t, 'the squad standing there stays put');
  }
  cap.pop = 5; urbanStep(g);
  assert.ok(!g.fieldworks.has(t), 'shrinking does not bring it back');
});

test('trenches, projects and progress survive save and restore', () => {
  const g = sandbox();
  const s = spot(g, 3);
  g.command(0, { c: 'trenchPlan', points: [s, along(s, 2)], facing: [1, 0], commit: true });
  run(g, 40);
  const p = g.fieldworks.get(s).progress;
  assert.ok(p > 0 && p < 1);
  const g2 = restoreGame(serializeGame(g));
  assert.equal(g2.fieldworks.get(s).progress, p);
  assert.equal(g2.trenchProjects.size, g.trenchProjects.size);
  assert.deepEqual([...g2.urban], [...g.urban]);
  run(g2, 200);
  assert.ok([...g2.fieldworks.values()].every((f) => f.progress >= 1), 'construction resumes after restore');
});

test('legacy fortify uses the same planner; deploying troops never creates construction', () => {
  const g = sandbox();
  const s = spot(g, 5);
  const us = spawnGroup(g, 0, 'rifle_squad', idx(qOf(s) + 2, Math.min(H - 1, rOf(s) + 3)), 4);
  g.command(0, { c: 'deploy', units: us.map((u) => u.id), line: [s, along(s, 3)], behavior: 'hold', fortify: true });
  run(g, 400);
  assert.equal(g.fieldworks.size, 0, 'a deployment alone digs nothing');
  const r = g.command(0, { c: 'fortify', units: [], tiles: [s, along(s, 1)] });
  assert.equal(r.reply.fortify.placed, 2, 'the alias plans through the trench planner');
  assert.ok(FIELDWORKS.basic.time <= 12 && FIELDWORKS.reinforced.time <= 20);
});
