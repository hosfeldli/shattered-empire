// Field trenches: digging, cover, artillery on stacks in trenches, city growth, persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena, spawnGroup } from '../server/sim/sandbox.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { coverAt } from '../server/sim/combat.js';
import { urbanStep, districtRadius } from '../server/sim/fieldworks.js';
import { isWater, TERRAIN, H } from '../server/sim/constants.js';
import { idx, qOf, rOf, disk, dist } from '../server/sim/hex.js';

const sandbox = (seed = 7) => { const g = new Game({ id: 'f' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); for (const k of Object.keys(g.civs[0].res)) g.civs[0].res[k] = 2000; return g; };
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; } };
const along = (t, k) => idx(qOf(t) + k, rOf(t));
const open = (g, t) => !isWater(g.world.terr[t]) && TERRAIN[g.world.terr[t]].move <= 2 && !g.world.river[t] && g.tileB[t] < 0 && !g.urban[t];
function spot(g, len) { const a = findArena(g, 8); for (const c of disk(a, 6)) { let ok = true; for (let k = 0; k < len; k++) if (!open(g, along(c, k))) { ok = false; break; } if (ok) return c; } return a; }
const ids = (us) => us.map((u) => u.id);
const north = (t, k) => idx(qOf(t), rOf(t) - k);

test('six squads dig a six-hex line in parallel; engineers are faster but not instant', () => {
  const g = sandbox();
  const s = spot(g, 6);
  const us = []; for (let k = 0; k < 6; k++) { const [u] = spawnGroup(g, 0, 'rifle_squad', along(s, k), 1); u.tile = along(s, k); us.push(u); }
  g.rebuildTileUnits();
  let spent = 0; const pay = g.pay.bind(g); g.pay = (civ, c, t) => { if (civ.id === 0 && g.fieldworks.has(t)) spent += c.materials || 0; return pay(civ, c, t); };
  const r = g.command(0, { c: 'fortify', units: ids(us), facing: [0, -1] }).reply.fortify;
  assert.equal(r.placed, 6);
  run(g, 260);                                   // 26 s: the basic works take 25 s each, dug in parallel
  const segs = [...g.fieldworks.values()];
  assert.equal(segs.length, 6);
  assert.ok(segs.every((f) => f.progress >= 1), 'all six finished together');
  assert.equal(spent, 36, 'six materials per segment, charged once');
  g.pay = pay;
  // engineer on a fresh hex
  const t = along(s, 7) ; const [e] = spawnGroup(g, 0, 'engineer', t, 1); e.tile = t; g.rebuildTileUnits();
  g.command(0, { c: 'fortify', units: [e.id], tiles: [t], facing: [0, -1] });
  run(g, 100);
  const f = g.fieldworks.get(t);
  assert.ok(f.progress > 0.55 && f.progress < 1, `engineer digs faster, not instantly (${f.progress.toFixed(2)})`);
});

test('trench cover is directional, weaker for vehicles, and indirect fire still hurts', () => {
  const g = sandbox();
  const s = spot(g, 3);
  const [u] = spawnGroup(g, 0, 'rifle_squad', s, 1); u.tile = s; g.rebuildTileUnits();
  g.command(0, { c: 'fortify', units: [u.id], tiles: [s], facing: [0, -1] });
  run(g, 270);
  const front = coverAt(g, u, north(s, 3), false), rear = coverAt(g, u, idx(qOf(s), rOf(s) + 3), false), indirect = coverAt(g, u, north(s, 3), true);
  assert.ok(front >= 0.24, `front cover ${front}`);
  assert.ok(rear < front && indirect < front && indirect > 0, `rear ${rear}, indirect ${indirect}`);
  const [tk] = spawnGroup(g, 0, 'tank', s, 1); tk.tile = s; g.rebuildTileUnits();
  assert.ok(coverAt(g, tk, north(s, 3), false) < front / 2, 'a tank in a trench gets little of it');
});

test('a shell on six squads in a trench hits all six, and degrades the trench', () => {
  const g = sandbox();
  const s = spot(g, 2);
  const us = []; for (let i = 0; i < 6; i++) { const [u] = spawnGroup(g, 0, 'rifle_squad', s, 1); u.tile = s; u.stance = 'passive'; us.push(u); }
  g.rebuildTileUnits();
  g.command(0, { c: 'fortify', units: ids(us), tiles: [s], facing: [0, -1] });
  run(g, 200);
  assert.ok(g.fieldworks.get(s).progress >= 1);
  for (const u of us) u.tile = s; g.rebuildTileUnits();
  const hp0 = new Map(us.map((u) => [u.id, u.hp]));
  g.areaImpactForTest(1, s, 'howitzer');
  assert.equal(us.filter((u) => !g.units.has(u.id) || g.units.get(u.id).hp < hp0.get(u.id)).length, 6, 'every squad in the stack takes the blast');
  assert.ok(g.fieldworks.get(s).hp < 100, 'the trench is damaged');
});

test('no trenches on buildings or city districts; growth removes them; borders alone do not', () => {
  const g = new Game({ id: 'u' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const civ = g.civs[0], cap = g.capital(civ);
  for (const k of Object.keys(civ.res)) civ.res[k] = 2000;
  urbanStep(g);
  assert.equal(g.urban[cap.tile], 1);
  const r1 = g.command(0, { c: 'fortifyPreview', units: [], tiles: [cap.tile] }).reply.fortify;
  assert.equal(r1.valid, 0); assert.match(r1.skipped[0][1], /developed city|building/);
  // a rural hex inside the borders, two rings out
  const ring = disk(cap.tile, 2).filter((t) => dist(t, cap.tile) === 2 && open(g, t) && g.world.owner[t] === 0);
  const t = ring[0];
  const [u] = spawnGroup(g, 0, 'rifle_squad', t, 1); u.tile = t; g.rebuildTileUnits();
  g.command(0, { c: 'fortify', units: [u.id], tiles: [t] });
  run(g, 300);
  assert.ok(g.fieldworks.has(t), 'trench inside the borders but outside the districts stays');
  // the city grows until its districts reach the trench
  cap.pop = 130; for (let i = 0; i < 4; i++) urbanStep(g);
  assert.ok(districtRadius(cap) >= 2);
  if (g.urban[t]) {
    assert.ok(!g.fieldworks.has(t), 'development removed the trench');
    assert.ok(g.units.has(u.id) && g.units.get(u.id).tile === t, 'the squad standing there stays put');
  }
  // shrinking does not bring it back
  cap.pop = 5; urbanStep(g);
  assert.ok(!g.fieldworks.has(t));
});

test('trenches and their progress survive save and restore', () => {
  const g = sandbox();
  const s = spot(g, 2);
  const [u] = spawnGroup(g, 0, 'rifle_squad', s, 1); u.tile = s; g.rebuildTileUnits();
  g.command(0, { c: 'fortify', units: [u.id], tiles: [s], facing: [1, 0] });
  run(g, 120);
  const p = g.fieldworks.get(s).progress;
  assert.ok(p > 0 && p < 1);
  const g2 = restoreGame(serializeGame(g));
  assert.equal(g2.fieldworks.get(s).progress, p);
  assert.deepEqual([...g2.urban], [...g.urban]);
});

test('Deploy & Fortify: a drawn line becomes trenches once the troops arrive', () => {
  const g = sandbox();
  const s = spot(g, 5);
  const us = spawnGroup(g, 0, 'rifle_squad', idx(qOf(s) + 2, Math.min(H - 1, rOf(s) + 3)), 4);
  g.command(0, { c: 'deploy', units: ids(us), line: [s, along(s, 3)], behavior: 'hold', fortify: true });
  run(g, 700);
  assert.ok(g.fieldworks.size >= 3, `segments dug: ${g.fieldworks.size}`);
  assert.ok([...g.fieldworks.values()].every((f) => f.fy < 0), 'facing the front of the drawn line');
});
