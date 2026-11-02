// Acceptance tests for the world/economy overhaul: population ledger, workforce locks, batch
// production, governors, peaceful geology, the wrapped world and fair starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { spawnUnit } from '../server/sim/military.js';
import { findPath } from '../server/sim/path.js';
import { demobilize, casualty, recruitable } from '../server/sim/population.js';
import { BUILDINGS, TECHS, isWater, W, aiProfile } from '../server/sim/constants.js';
import { disk, dist, idx, qOf, rOf, WRAP, NB } from '../server/sim/hex.js';

const newGame = (seed = 7, extra = {}) => new Game({ id: 'o' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false, ...extra });
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) { g.tick(); g.outbox.length = 0; } };
const TECHS_AGE0 = () => Object.fromEntries(Object.entries(TECHS).filter(([, t]) => t.age === 0));
const rich = (civ) => { for (const k of Object.keys(civ.res)) civ.res[k] = 5000; };
const twoBarracks = (g) => {
  const civ = g.civs[0], cap = g.capital(civ);
  const spots = disk(cap.tile, 3).filter((t) => g.canPlace(civ, 'barracks', t, true));
  return [g.makeBuilding(civ, 'barracks', spots[0], true), g.makeBuilding(civ, 'barracks', spots[spots.length - 1], true)];
};

test('batch training spreads one order over facilities, charges once per unit, and is idempotent', () => {
  const g = newGame(7);
  const civ = g.civs[0]; rich(civ);
  const cap = g.capital(civ); cap.pop = 60;
  const [a, b] = twoBarracks(g);
  const food0 = civ.res.food;
  const r = g.command(0, { c: 'batchTrain', buildings: [a.id, b.id], unit: 'militia', count: 6, requestId: 'x1' });
  assert.equal(r.reply.batch.queued, 6);
  assert.equal(a.queue.length + b.queue.length, 6);
  assert.ok(Math.abs(a.queue.length - b.queue.length) <= 1, 'earliest-finish spreads evenly');
  const per = g.unitCost(civ, 'militia').food;
  assert.equal(food0 - civ.res.food, per * 6, 'charged exactly once per queued unit');
  // a retried request (same id) is not charged again
  const again = g.command(0, { c: 'batchTrain', buildings: [a.id, b.id], unit: 'militia', count: 6, requestId: 'x1' });
  assert.equal(again.reply.repeat, true);
  assert.equal(a.queue.length + b.queue.length, 6);
  // "per building": exactly that many in each
  const r2 = g.command(0, { c: 'batchTrain', buildings: [a.id, b.id], unit: 'militia', count: 2, each: 1, requestId: 'x2' });
  assert.deepEqual(Object.values(r2.reply.batch.per), [1, 1]);
});

test('batch training queues what it can and explains the rest', () => {
  const g = newGame(7);
  const civ = g.civs[0]; rich(civ);
  g.capital(civ).pop = 60;
  const [a, b] = twoBarracks(g);
  const per = g.unitCost(civ, 'militia');
  civ.res.food = per.food * 3 + 1;
  const r = g.command(0, { c: 'batchTrain', buildings: [a.id, b.id], unit: 'militia', count: 8, policy: 'partial', requestId: 'p' });
  assert.equal(r.reply.batch.queued, 3);
  assert.match(r.reply.batch.text, /3 of 8 queued.*cannot afford/);
  // all-or-nothing refuses the whole order
  const r2 = g.command(0, { c: 'batchTrain', buildings: [a.id, b.id], unit: 'militia', count: 8, policy: 'all', requestId: 'q' });
  assert.ok(r2.error);
});

test('population ledger: training reserves people, cancelling returns them, casualties are lost', () => {
  const g = newGame(7);
  const civ = g.civs[0]; rich(civ);
  const cap = g.capital(civ); cap.pop = 40;
  const [a] = twoBarracks(g);
  const rec0 = recruitable(civ, cap), res0 = cap.reserved || 0;
  g.command(0, { c: 'batchTrain', buildings: [a.id], unit: 'militia', count: 3, requestId: 'l1' });
  assert.equal(cap.reserved - res0, 3, 'queued recruits are reserved');
  assert.ok(recruitable(civ, cap) < rec0);
  const food = civ.res.food;
  g.command(0, { c: 'cancelTrain', building: a.id, index: 2 });
  assert.equal(cap.reserved - res0, 2, 'cancelling releases the reservation');
  assert.ok(civ.res.food > food, 'and refunds the cost');
  // finish training: reserved civilians become serving soldiers
  const mil0 = cap.mil || 0;
  run(g, 400);
  assert.equal(cap.reserved, res0);
  assert.ok(cap.mil >= mil0 + 2, 'trained units count as serving');
  // demobilise one (most come home) and lose another (a real loss)
  const mine = [...g.units.values()].filter((u) => u.owner === 0 && u.type === 'militia' && u.home === cap.id);
  const pop0 = cap.pop, milA = cap.mil;
  const back = demobilize(g, mine[0]);
  assert.ok(back.back > 0 && back.back < back.men + 1e-9);
  assert.ok(cap.pop > pop0 && cap.mil < milA);
  const milB = cap.mil;
  casualty(g, mine[1]);
  assert.ok(cap.mil < milB);
});

test('workforce locks survive save/restore and are respected by a managed governor', () => {
  const g = newGame(7);
  const civ = g.civs[0], cap = g.capital(civ);
  const farm = [...g.buildings.values()].find((b) => b.owner === 0 && b.type === 'farm');
  assert.equal(g.command(0, { c: 'workforce', city: cap.id, building: farm.id, lock: 1 }), null);
  g.command(0, { c: 'governor', city: cap.id, level: 'managed' });
  run(g, 200);
  assert.equal(farm.lock, 1);
  assert.ok(farm.staffed <= 1, 'a locked workplace is never staffed above its lock');
  const g2 = restoreGame(serializeGame(g));
  const f2 = g2.buildings.get(farm.id);
  assert.equal(f2.lock, 1, 'locks survive save & restore');
  run(g2, 50);
  assert.ok(f2.staffed <= 1);
});

test('governors do not pile up buildings nobody can staff', () => {
  const g = newGame(13);
  const civ = g.civs[0];
  for (const k of Object.keys(civ.res)) civ.res[k] = Math.max(civ.res[k], 300);   // well funded, storage not full
  for (const c of g.cities.values()) if (c.owner === 0) g.command(0, { c: 'governor', city: c.id, level: 'autonomous' });
  run(g, 4000);
  const work = [...g.buildings.values()].filter((b) => b.owner === 0 && b.done && BUILDINGS[b.type].jobs && !b.off);
  // idle because its storage is full is not "nobody to staff it"
  const empty = work.filter((b) => !b.staffed && b.why !== 'full').length;
  assert.ok(work.length >= 4, 'the governor developed the city');
  assert.ok(empty <= Math.max(2, work.length * 0.3), `unstaffed workplaces ${empty}/${work.length}`);
});

test('the world is peaceful: no quakes, eruptions or moving land', () => {
  const g = newGame(21);
  const elev = Float32Array.from(g.world.elev), water = (w) => { let n = 0; for (let i = 0; i < w.terr.length; i++) if (isWater(w.terr[i])) n++; return n; };
  const w0 = water(g.world);
  const kinds = new Set();
  for (let i = 0; i < 3000; i++) { g.tick(); for (const m of g.outbox) if (m[1]?.t === 'event' || m[1]?.kind) kinds.add(m[1].kind); g.outbox.length = 0; }
  let moved = 0; for (let i = 0; i < elev.length; i++) if (Math.abs(g.world.elev[i] - elev[i]) > 1e-6) moved++;
  assert.equal(moved, 0, 'terrain height never changes in a peaceful world');
  assert.equal(water(g.world), w0, 'no flooding or new lakes');
  for (const k of ['quake', 'eruption', 'drought', 'rift', 'uplift']) assert.ok(!kinds.has(k), `no ${k}`);
});

test('the world wraps east-west: distance, neighbours and paths cross the seam', { skip: !WRAP && 'wrap disabled' }, () => {
  const g = newGame(7);
  const r = 40, a = idx(W - 1, r), b = idx(0, r);
  assert.equal(dist(a, b), 1, 'the seam is one step');
  assert.equal(idx(W, r), b);
  let seamNb = false; for (let d = 0; d < 6; d++) if (NB[a * 6 + d] >= 0 && qOf(NB[a * 6 + d]) === 0) seamNb = true;
  assert.ok(seamNb, 'tiles on the east edge neighbour the west edge');
  // a land path that crosses the seam is short
  const land = (q) => { for (let rr = 20; rr < 80; rr++) { const t = idx(q, rr); if (!isWater(g.world.terr[t]) && Number.isFinite(g.defs.MOVE.infantry.terrain[g.world.terr[t]])) return t; } return -1; };
  const civ = g.civs[0];
  for (let q = 0; q < 6; q++) {
    const s = land(W - 3 + q % 3), e = land(q % 3 + 1);
    if (s < 0 || e < 0) continue;
    civ.explored.fill(1);
    const p = findPath(g, civ, s, e, 'militia');
    if (!p || p.partial) continue;
    assert.ok(p.length < W / 2, `path across the seam is short (${p.length})`);
    return;
  }
});

test('starting positions are fair across seeds and styles', () => {
  for (const [seed, style] of [[3, 'continents'], [9, 'pangaea'], [17, 'archipelago'], [29, 'inlandSea'], [41, null]]) {
    const g = new Game({ id: 'f' + seed, seed, style, slots: [{ human: true }, { personality: 'builder' }, { personality: 'warlord' }, { personality: 'trader' }], rebels: false });
    const f = g.world.fairness;
    assert.ok(f && f.length >= 4, 'fairness report');
    for (const s of f) {
      assert.ok(s.food >= 4, `seed ${seed}: food near every start (${s.food})`);
      assert.ok(s.materials >= 1, `seed ${seed}: materials near every start`);
    }
    const caps = g.civs.map((c) => g.capital(c).tile);
    for (let i = 0; i < caps.length; i++) for (let j = i + 1; j < caps.length; j++) assert.ok(dist(caps[i], caps[j]) >= 12, `seed ${seed}: starts are spread apart`);
    void rOf;
  }
});

test('repeat production re-queues when a queue empties and pauses when resources are short', () => {
  const g = newGame(7);
  const civ = g.civs[0]; rich(civ);
  g.capital(civ).pop = 80;
  const [a] = twoBarracks(g);
  g.command(0, { c: 'repeat', buildings: [a.id], unit: 'militia' });
  run(g, 30);
  assert.ok(a.queue.length >= 1, 'an idle facility starts its repeat unit');
  for (const k of Object.keys(civ.res)) civ.res[k] = 0;
  a.queue.length = 0; run(g, 30);
  assert.equal(a.queue.length, 0, 'repeat pauses when it cannot afford a double order');
  g.command(0, { c: 'repeat', buildings: [a.id], unit: null });
  assert.equal(a.repeat, null);
});

test('refits and veterancy: a unit keeps its experience through a refit', () => {
  const g = newGame(7);
  const civ = g.civs[0]; rich(civ);
  civ.techs.add('small_arms');
  const cap = g.capital(civ);
  const [a] = twoBarracks(g);
  const u = spawnUnit(g, civ, 'militia', a.tile);
  u.xp = 90;
  const r = g.command(0, { c: 'refit', units: [u.id], to: 'rifle_squad' });
  assert.ok(!r || !r.error, r && r.error);
  run(g, 400);
  assert.equal(g.units.get(u.id).type, 'rifle_squad');
  assert.equal(g.units.get(u.id).xp >= 90, true);
  void cap;
});

test('AI difficulty: fair play by default, skill differs, advantages only when disclosed, legacy saves keep theirs', () => {
  const mk = (difficulty, fairPlay) => new Game({ id: 'd' + difficulty + Math.random(), seed: 5, slots: [{ human: true }, { personality: 'builder', difficulty, fairPlay }], rebels: false });
  for (const d of ['easy', 'normal', 'hard', 'expert', 'brutal']) {
    const g = mk(d);
    const p = aiProfile(g.civs[1]);
    assert.deepEqual(p.adv, { econ: 1, research: 1, army: 1 }, `${d}: no numerical advantage under Fair Play`);
    assert.equal(g.civs[1].difficulty, d);
  }
  assert.ok(aiProfile(mk('brutal').civs[1]).skill.level > aiProfile(mk('normal').civs[1]).skill.level, 'skill rises with difficulty');
  const unfair = mk('brutal', false);
  assert.ok(aiProfile(unfair.civs[1]).adv.econ > 1, 'Brutal advantages only with Fair Play off');
  assert.equal(aiProfile(mk('hard', false).civs[1]).adv.econ, 1, 'Hard never cheats');
  // a save from before profile v2 keeps its old multipliers
  const g = mk('hard'); const snap = serializeGame(g); for (const c of snap.civs) delete c.diffProfile;
  const old = restoreGame(snap);
  assert.equal(old.civs[1].diffProfile, 'legacy');
  assert.ok(aiProfile(old.civs[1]).legacy && aiProfile(old.civs[1]).adv.econ > 1);
  assert.equal(g.civs[0].difficulty, 'normal');
});

test('construction queue: unaffordable orders wait in order, crews build a few sites at a time, "build next" jumps the queue', () => {
  const g = newGame(7);
  const civ = g.civs[0], cap = g.capital(civ);
  const spots = disk(cap.tile, 3).filter((t) => g.canPlace(civ, 'barracks', t, true)).slice(0, 6);
  assert.ok(spots.length >= 6);
  civ.res.materials = 0;
  const ids = spots.map((t) => { const r = g.command(0, { c: 'build', type: 'barracks', tile: t }); assert.ok(!r?.error, JSON.stringify(r)); return r.reply.built.id; });
  assert.ok(ids.every((id) => g.buildings.get(id).state === 'planned'), 'unaffordable orders are queued, not refused');
  // funds for exactly one: the first ordered gets it, not whichever the loop meets first
  civ.res.materials = BUILDINGS.barracks.cost.materials; run(g, 10);
  assert.equal(g.buildings.get(ids[0]).funded, true);
  assert.ok(ids.slice(1).every((id) => !g.buildings.get(id).funded));
  // "build next" moves the last one to the front of the line
  assert.equal(g.command(0, { c: 'buildNext', id: ids[5] }), null);
  civ.res.materials = BUILDINGS.barracks.cost.materials; run(g, 10);
  assert.equal(g.buildings.get(ids[5]).funded, true, 'the site moved to the front is funded next');
  // everything funded: only a few sites progress at once, the rest wait their turn
  civ.res.materials = 5000; run(g, 20);
  const sites = ids.map((id) => g.buildings.get(id));
  const moving = sites.filter((b) => !b.waiting && b.progress > 0).length, waiting = sites.filter((b) => b.waiting).length;
  assert.ok(moving >= 1 && moving <= 3, `active sites ${moving}`);
  assert.ok(waiting >= 3, `waiting sites ${waiting}`);
  run(g, 3000);
  assert.ok(sites.every((b) => b.done), 'the queue works through every site');
});

test('batch upgrade levels any upgradable buildings, not only housing', () => {
  const g = newGame(7);
  const civ = g.civs[0], cap = g.capital(civ);
  rich(civ); civ.age = 1;                     // level 2 needs the Industrial era, level 3 the next one
  const spots = disk(cap.tile, 3).filter((t) => g.canPlace(civ, 'farm', t, true)).slice(0, 3);
  const farms = spots.map((t) => g.makeBuilding(civ, 'farm', t, true));
  const r = g.command(0, { c: 'batchUpgrade', ids: farms.map((b) => b.id), policy: 'affordable' });
  assert.ok(!r?.error, JSON.stringify(r));
  assert.equal(r.reply.upgrade.upgraded.length, 3);
  assert.ok(farms.every((b) => b.level === 2));
  // the next level needs the next era: skipped with the reason, nothing charged
  const r2 = g.command(0, { c: 'batchUpgrade', ids: farms.map((b) => b.id), policy: 'affordable' });
  assert.ok(r2.error || r2.reply.upgrade.upgraded.length === 0);
});

test('extraction sites yield from the land without workers; woods around a timber mill raise it', () => {
  const g = newGame(7);
  const civ = g.civs[0];
  const mill = [...g.buildings.values()].find((b) => b.owner === 0 && b.type === 'lumber');
  assert.ok(mill);
  for (const c of g.cities.values()) if (c.owner === 0) { c.governor.enabled = false; c.governor.level = 'off'; }
  mill.lock = 0;                                   // nobody works it
  const m0 = civ.res.materials; run(g, 100);
  assert.equal(mill.staffed || 0, 0);
  assert.ok(civ.res.materials > m0 + 15, `an unstaffed mill still yields (${(civ.res.materials - m0).toFixed(1)} in 10 s)`);
  assert.ok(mill.active, 'and counts as working');
});

test('research picks itself when nothing is chosen; eras begin on their own; later techs wait for goods', () => {
  const g = newGame(7);
  const civ = g.civs[0];
  run(g, 20);
  assert.ok(civ.researching, 'something is being researched without a pick');
  for (const k of Object.keys(TECHS_AGE0())) civ.techs.add(k);
  run(g, 10);
  assert.equal(civ.age, 1, 'the next era begins as soon as enough of this era is known, at no cost');
  // an Industrial technology needs its goods before work starts
  civ.researching = 'metallurgy'; civ.res.materials = 0; civ.res.ore = 0;
  const p0 = civ.techProgress.metallurgy || 0; run(g, 30);
  if (civ.researching === 'metallurgy') assert.equal(civ.techProgress.metallurgy || 0, p0, 'no progress without the goods');
  rich(civ); civ.researching = 'metallurgy'; run(g, 20);
  assert.ok((civ.techProgress.metallurgy || 0) > 0 || civ.techs.has('metallurgy'), 'with the goods it proceeds');
});

test('drag placement: one order places many, queues what cannot be paid, refuses bad hexes', () => {
  const g = newGame(7);
  const civ = g.civs[0], cap = g.capital(civ);
  const spots = disk(cap.tile, 3).filter((t) => g.canPlace(civ, 'barracks', t, true)).slice(0, 4);
  civ.res.materials = BUILDINGS.barracks.cost.materials * 2;
  const r = g.command(0, { c: 'buildMany', type: 'barracks', tiles: [...spots, cap.tile] });
  assert.equal(r.reply.many.placed, 4);
  assert.equal(r.reply.many.planned, 2, 'two paid now, two queued');
  assert.equal(r.reply.many.failed, 1, 'the town hex is refused');
});

test('Explore troops scout on their own; idle engineers go and repair damage', () => {
  const g = newGame(7);
  const civ = g.civs[0];
  const scouts = [...g.units.values()].filter((u) => u.owner === 0 && (u.type === 'scout_buggy' || u.type === 'militia'));
  const seen = () => civ.explored.reduce((a, b) => a + b, 0);
  const e0 = seen();
  assert.equal(g.command(0, { c: 'stance', units: scouts.map((u) => u.id), stance: 'explore' }), null);
  run(g, 900);
  assert.ok(seen() > e0 * 3, `explored ${e0} -> ${seen()}`);
  // engineers: governors off, a damaged building is reached and repaired
  for (const c of g.cities.values()) if (c.owner === 0) { c.governor.enabled = false; c.governor.level = 'off'; }
  const eng = [...g.units.values()].find((u) => u.owner === 0 && u.type === 'engineer');
  const b = [...g.buildings.values()].find((x) => x.owner === 0 && x.type !== 'town' && x.done);
  b.hp = b.maxHp * 0.6; b.lastHit = g.time - 100;
  run(g, 900);
  assert.ok(dist(eng.tile, b.tile) <= 2, 'the engineer went to the damaged building');
});
