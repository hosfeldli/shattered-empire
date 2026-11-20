// Ticket 4 (2026-11-20): game creation settings (matchRules.js: starting stockpile, unit speed / range / health,
// per-player resource multipliers) and the map builder's generation options and points of interest
// (sketchMaps.js gen / pois). Validation refuses bad values with a readable reason; the lobby carries the rules;
// the simulation applies them deterministically and keeps them in saves; old sketches load unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { parseIncome, parseRules, normalizeRules, startResources, describeRules } from '../server/sim/matchRules.js';
import { encodeCells, parseSketch, sketchGen, SKETCH_GEN, SKETCH_SIZES, forestLevelOf } from '../server/sim/sketchMaps.js';
import { MatchManager } from '../server/matches.js';

const SIM = new URL('../server/sim/', import.meta.url).href;

function sampleSketch(extra = {}) {
  const w = 64, h = 64, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = x < 3 || y < 3 || x >= w - 3 || y >= h - 3 ? 0 : 1;
    if (Math.hypot(x - 32, y - 32) < 6) c = 3;
    if (Math.abs(x - 50) < 2 && y > 10 && y < 24) c = 2;
    g[y * w + x] = c;
  }
  return { v: 1, name: 'Gen Test', size: 'small', w, h, cells: encodeCells(g), bases: [[.15, .2], [.85, .8]], ...extra };
}

test('match rules: valid values are canonicalised, standard ones dropped', () => {
  assert.deepEqual(parseRules(undefined), {});
  assert.deepEqual(parseRules({ unitSpeed: 1, unitRange: 1, unitHealth: 1 }), {});
  assert.deepEqual(parseRules({ startMaterials: 0, startEnergy: 2000, unitSpeed: 1.504, unitHealth: .25 }), { startMaterials: 0, startEnergy: 2000, unitSpeed: 1.5, unitHealth: .25 });
  // merge with the lobby's rules; null restores the standard
  assert.deepEqual(parseRules({ unitRange: 2, unitSpeed: null }, { unitSpeed: 1.5 }), { unitRange: 2 });
  assert.deepEqual(normalizeRules({ unitSpeed: 2 }), { unitSpeed: 2, unitRange: 1, unitHealth: 1 });
  assert.deepEqual(startResources({ materials: 500, energy: 100 }, { startEnergy: 7 }), { materials: 500, energy: 7 });
  assert.match(describeRules({ unitSpeed: 1.5, startMaterials: 900 }, [1, 2]), /speed 1\.5×.*P2 2×|Start: 900.*speed 1\.5×.*P2 2×/);
  assert.equal(parseIncome(2), 2);
});

test('match rules: out-of-range and malformed values are refused with the reason', () => {
  const bad = [[{ unitSpeed: 3 }, /Unit speed must be between/], [{ unitSpeed: .1 }, /Unit speed/], [{ unitRange: 'far' }, /Unit range must be a number/],
    [{ unitHealth: 5 }, /Unit health/], [{ startMaterials: -5 }, /Starting materials/], [{ startMaterials: 60000 }, /Starting materials/],
    [{ startEnergy: 1.5 }, /whole number/], [{ cheat: 1 }, /Unknown match rule/], [[1], /rules must be an object/], ['x', /rules must be an object/],
    [{ unitSpeed: NaN }, /must be a number/], [{ unitSpeed: Infinity }, /must be a number/]];
  for (const [raw, why] of bad) assert.throws(() => parseRules(raw), why, JSON.stringify(raw));
  for (const v of [0, .1, 5, 'x', null, NaN]) assert.throws(() => parseIncome(v), /Resource multiplier/);
});

test('sketch generation options and points of interest: canonical, validated; old sketches unchanged', () => {
  const old = parseSketch(sampleSketch());
  assert.deepEqual(Object.keys(old).sort(), ['bases', 'cells', 'h', 'name', 'size', 'v', 'w'], 'a sketch without options keeps its old shape');
  assert.deepEqual(sketchGen(old), { ...SKETCH_GEN, pois: [] });
  const sk = parseSketch(sampleSketch({ gen: { forest: 1.5, dense: 'thick', season: 'winter', treeHeight: 1.3, rivers: false, power: 1, cities: true, ruins: 'farm', hillGradient: .9 },
    pois: [[.5, .2, 'city'], [.3, .7, 'radar'], { u: .7, v: .3, kind: 'power' }, [.78, .27, 'cache']] }));
  assert.deepEqual(sk.gen, { forest: 1.5, dense: 'thick', season: 'winter', treeHeight: 1.3, rivers: false, ruins: 'farm', hillGradient: .9 }, 'standard values are dropped');
  assert.deepEqual(sk.pois, [[.5, .2, 'city'], [.3, .7, 'radar'], [.7, .3, 'power'], [.78, .27, 'cache']]);
  assert.equal(parseSketch(sampleSketch({ gen: { forest: 1, rivers: true } })).gen, undefined, 'an all-standard gen is dropped');
  assert.equal(forestLevelOf(SKETCH_GEN), .53, 'standard forest threshold');
  assert.equal(forestLevelOf({ forest: 0 }), 9, 'no forest');
  const good = sampleSketch();
  const bad = [{ gen: 'lots' }, { gen: [] }, { gen: { forest: 3 } }, { gen: { forest: '1' } }, { gen: { season: 'monsoon' } }, { gen: { rivers: 1 } }, { gen: { weather: true } },
    { gen: { power: -1 } }, { gen: { hillHeight: 2 } }, { pois: 'x' }, { pois: [[.5, .5, 'castle']] }, { pois: [[.5, .5]] }, { pois: [[1.5, .5, 'city']] },
    { pois: [[.01, .01, 'radar']] },                       // in the sea
    { pois: [[50.5 / 64, 15.5 / 64, 'city']] },            // a city on a mountain
    { pois: Array.from({ length: 25 }, (_, i) => [.2 + i * .02, .5, 'cache']) }];
  for (const b of bad) assert.throws(() => parseSketch({ ...good, ...b }), /Map sketch/, JSON.stringify(b).slice(0, 80));
  // caches and power supplies may stand on a mountain (units collect them from its edge)
  assert.equal(parseSketch({ ...good, pois: [[50.5 / 64, 15.5 / 64, 'power']] }).pois.length, 1);
});

// ---- lobby
const CAPS = ['geo', 'udelta', 'action-rts', 'ring-cities-v1'];
const quiet = { info() {}, warn() {}, error() {} };
function manager() {
  const mm = new MatchManager(quiet, null);
  clearInterval(mm.janitor);
  mm.admit = () => null;
  mm.start = (m) => { m.status = 'running'; };
  return mm;
}
function socket(mm) {
  const handlers = {};
  const ws = { readyState: 1, bufferedAmount: 0, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, on(ev, fn) { handlers[ev] = fn; }, close() { handlers.close?.(); } };
  mm.attach(ws);
  ws.msg = (o) => handlers.message(JSON.stringify(o));
  ws.last = (t) => [...ws.sent].reverse().find((m) => m.t === t);
  ws.error = (o) => { const n = ws.sent.length; ws.msg(o); const e = ws.sent.slice(n).find((m) => m.t === 'error'); return e ? e.error : null; };
  ws.msg({ t: 'hello', proto: 2, caps: CAPS });
  return ws;
}

test('lobby: the host sets rules and seat multipliers; guests may not; bad values are refused; the room shows them', () => {
  const mm = manager();
  const host = socket(mm);
  host.msg({ t: 'create', mode: 'pvp', name: 'Host', ruleset: 'action-v2', format: '1v1', waitForReady: true });
  const code = host.last('joined').match;
  const guest = socket(mm);
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  assert.equal(host.error({ t: 'options', rules: { unitSpeed: 1.5, startMaterials: 2000 } }), null);
  assert.deepEqual(host.last('room').rules, { unitSpeed: 1.5, startMaterials: 2000 });
  assert.equal(host.error({ t: 'options', rules: { unitSpeed: null, unitHealth: 2 } }), null);
  assert.deepEqual(guest.last('room').rules, { startMaterials: 2000, unitHealth: 2 });
  assert.match(host.error({ t: 'options', rules: { unitRange: 9 } }), /Unit range must be between/);
  assert.deepEqual(host.last('room').rules, { startMaterials: 2000, unitHealth: 2 }, 'a refused change changes nothing');
  assert.match(guest.error({ t: 'options', rules: { unitSpeed: 2 } }), /Only the host/);
  assert.equal(host.error({ t: 'income', seat: 1, income: 2 }), null);
  assert.equal(host.last('room').slots[1].income, 2);
  assert.match(host.error({ t: 'income', seat: 1, income: 10 }), /Resource multiplier/);
  assert.match(guest.error({ t: 'income', seat: 0, income: 2 }), /Only the host/);
  // the income travels with the player when seats are swapped, and into the saved match meta
  const m = mm.matches.get(code);
  assert.equal(mm.meta(m).slots[1].income, 2);
  assert.deepEqual(mm.meta(m).rules, { startMaterials: 2000, unitHealth: 2 });
});

test('create: rules and per-seat incomes are validated before anything is built', () => {
  const mm = manager();
  const m = mm.create({ mode: 'ai', ruleset: 'action-v2', format: '1v1', rules: { unitHealth: 3, income: [1.5, .5] } });
  assert.deepEqual(m.rules, { unitHealth: 3 });
  assert.deepEqual(m.slots.map((s) => s.income ?? 1), [1.5, .5]);
  assert.throws(() => mm.create({ mode: 'ai', ruleset: 'action-v2', format: '1v1', rules: { unitHealth: 30 } }), /Unit health/);
  assert.throws(() => mm.create({ mode: 'ai', ruleset: 'action-v2', format: '1v1', rules: { income: [9] } }), /Resource multiplier/);
  assert.throws(() => mm.create({ mode: 'ai', ruleset: 'action-v2', format: '1v1', rules: { income: 2 } }), /income must be a list/);
  assert.equal(mm.create({ mode: 'ai', ruleset: 'action-v2', format: '1v1' }).rules, undefined, 'no rules: the standard game');
});

// ---- simulation (a worker: the map size is fixed per process)
const probe = `
const { parentPort, workerData } = await import('node:worker_threads');
globalThis.SE_MAP_SIZE = workerData.size; globalThis.SE_WRAP = false;
const { ActionGame } = await import(workerData.sim + 'actionGame.js');
const { ACTION_UNITS } = await import(workerData.sim + 'actionDefinitions.js');
const { serializeGame, restoreGame } = await import(workerData.sim + 'persist.js');
const { pointUV } = await import(workerData.sim + 'authoredMaps.js');
const slots = [{ human: true, income: workerData.income }, { human: false, difficulty: 'normal', personality: 'builder' }];
const speed0 = ACTION_UNITS.rifle_squad.speed, range0 = ACTION_UNITS.rifle_squad.range;
const g = new ActionGame({ id: 't4', seed: 9, map: 'custom', sketch: workerData.sketch, slots, teamSize: 1, rules: workerData.rules });
const sq = [...g.units.values()].find((u) => u.type === 'rifle_squad' && u.owner === 0);
const out = { error: null, res: g.civs.map((c) => ({ ...c.res })), income: g.civs.map((c) => c.income),
  hp: sq.maxHp, defHp: ACTION_UNITS.rifle_squad.hp, speed: ACTION_UNITS.rifle_squad.speed / speed0, range: ACTION_UNITS.rifle_squad.range / range0,
  rivers: g.world.river.reduce((a, b) => a + b, 0), lakes: g.world.lake.reduce((a, b) => a + b, 0),
  dense: g.world.dense ? g.world.dense.reduce((a, b) => a + b, 0) : 0,
  kinds: g.sites.filter((s) => s.slots && s.start === undefined).map((s) => s.kind), outposts: g.sites.filter((s) => !s.slots).map((s) => ({ kind: s.kind, uv: pointUV(s) })),
  cities: g.sites.filter((s) => s.slots && s.start === undefined).map((s) => pointUV(s)),
  caches: [...g.materialCaches.values()].map((c) => ({ resource: c.resource, uv: pointUV(c), replenishes: c.replenishes })),
  style: g.defs.MAP_STYLE, matchRules: JSON.parse(JSON.stringify(g.defs.MATCH_RULES)) };
try {
  for (let i = 0; i < 200; i++) { g.tick(); g.outbox.length = 0; }
  out.rates = g.civs.map((c) => ({ ...c.rates }));
  const back = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  out.restored = { rules: back.rules, mapGen: back.mapGen && { season: back.mapGen.season, power: back.mapGen.power }, income: back.civs.map((c) => c.income), forestLevel: back.world.forestLevel };
  for (let i = 0; i < 20; i++) { g.tick(); back.tick(); g.outbox.length = 0; back.outbox.length = 0; }
  out.same = JSON.stringify([...g.units.values()].map((u) => [u.id, +u.x.toFixed(5), +u.z.toFixed(5), u.hp])) === JSON.stringify([...back.units.values()].map((u) => [u.id, +u.x.toFixed(5), +u.z.toFixed(5), u.hp]));
} catch (e) { out.error = String(e.stack || e); }
parentPort.postMessage(out);
`;
function run(sketch, rules, income = 1) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(probe, { eval: true, type: 'module', workerData: { size: SKETCH_SIZES[sketch.size], sketch, rules, income, sim: SIM } });
    worker.once('message', (m) => { resolve(m); worker.terminate(); });
    worker.once('error', reject);
  });
}
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test('the simulation applies the rules, the generation options and the placed points of interest; saves keep them', { timeout: 240_000 }, async () => {
  const sk = parseSketch(sampleSketch({
    gen: { rivers: false, lakes: false, dense: 'off', ruins: 'farm', outposts: false, season: 'autumn', treeHeight: 1.3, power: 0 },
    pois: [[.5, .15, 'city'], [.3, .7, 'radar'], [.7, .3, 'power'], [.3, .35, 'cache']] }));
  const rules = { startMaterials: 1234, startEnergy: 77, unitSpeed: 1.5, unitRange: 2, unitHealth: 2 };
  const [r, std] = await Promise.all([run(sk, rules, 2), run(parseSketch(sampleSketch()), {})]);
  assert.equal(r.error, null, r.error);
  assert.equal(std.error, null, std.error);
  // rules
  assert.deepEqual(r.res.map((x) => [x.materials, x.energy]), [[1234, 77], [1234, 77]], 'the custom stockpile for every player, the AI too');
  assert.deepEqual(r.income, [2, 1]);
  assert.equal(r.hp, r.defHp * 2, 'units are created with twice the health');
  assert.ok(Math.abs(r.speed - 1.5) < 1e-9 && Math.abs(r.range - 2) < 1e-9, 'speed and range scale the unit definitions');
  assert.equal(std.speed, 1, 'a standard match in another process: definitions untouched');
  assert.deepEqual(r.matchRules, { unitSpeed: 1.5, unitRange: 2, unitHealth: 2, startMaterials: 1234, startEnergy: 77, income: [2, 1] });
  // both start with one headquarters (the AI may already have taken a relay, so compare Energy): twice the income
  assert.ok(r.rates[0].energy > 0 && Math.abs(r.rates[0].energy / Math.max(1e-9, r.rates[1].energy) - 2) < 1e-6, `player 0 earns twice the AI's Energy (${JSON.stringify(r.rates)})`);
  // generation options
  assert.equal(r.rivers, 0, 'no rivers');
  assert.equal(r.lakes, 0, 'no lakes');
  assert.equal(r.dense, 0, 'no dense forest');
  assert.ok(std.rivers > 0, 'the standard generator makes rivers on the same land');
  assert.deepEqual(r.style, { season: 'autumn', treeHeight: 1.3 });
  assert.deepEqual(std.style, { season: 'summer', treeHeight: 1 });
  assert.ok(r.kinds.length > 0 && r.kinds.every((k) => k === 'farm' || k === 'metro'), `farm ruins (the metropolis stays): ${r.kinds}`);
  // points of interest: the placed city, the radar (generated outposts off), the cache and the power supply
  assert.ok(r.cities.some((c) => near(c, [.5, .15]) < .08), 'the placed city');
  assert.deepEqual(r.outposts.map((o) => o.kind), ['radar'], 'only the placed outpost');
  assert.ok(near(r.outposts[0].uv, [.3, .7]) < .08);
  assert.ok(r.caches.some((c) => c.resource === 'energy' && c.replenishes && near(c.uv, [.7, .3]) < .05), 'the placed power supply');
  assert.ok(r.caches.some((c) => c.resource === 'materials' && c.replenishes && near(c.uv, [.3, .35]) < .05), 'the placed supply cache');
  // saves
  assert.deepEqual(r.restored.rules, { unitSpeed: 1.5, unitRange: 2, unitHealth: 2, startMaterials: 1234, startEnergy: 77 });
  assert.deepEqual(r.restored.mapGen, { season: 'autumn', power: 0 });
  assert.deepEqual(r.restored.income, [2, 1]);
  assert.equal(r.same, true, 'a restored match continues exactly as the live one');
});
