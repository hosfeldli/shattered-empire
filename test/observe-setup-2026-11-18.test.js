// Watch AI Match setup (2026-11-18, docs/gameplay-overhaul/WATCH_SETUP.md): the observe mode takes the same
// setup as New Skirmish (format and teams, map or random world, each AI's difficulty and personality, empty
// seats, victory, starting resources, seed) plus the exhibition's starting speed and the spectator's fog. Every
// seat is an AI. Impossible combinations are refused with a reason. The old create message (ais: 4, no format)
// that the benchmark and the release shots send keeps working unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MatchManager } from '../server/matches.js';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';
import { encodeCells } from '../server/sim/sketchMaps.js';

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
  ws.msg({ t: 'hello', proto: 2, caps: CAPS });
  return ws;
}

/** Create an observe match; returns the match, or the error text the creator was sent. */
function watch(extra = {}) {
  const mm = manager(), ws = socket(mm);
  const n = ws.sent.length;
  ws.msg({ t: 'create', mode: 'observe', name: 'Watcher', ruleset: 'action-v2', ...extra });
  const err = ws.sent.slice(n).find((m) => m.t === 'error');
  if (err) return { error: err.error, mm };
  const joined = ws.last('joined');
  return { m: mm.matches.get(joined.match), joined, mm };
}

function sketch(bases, extra = {}) {
  const w = 64, h = 64, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x < 3 || y < 3 || x >= w - 3 || y >= h - 3 ? 0 : 1;
  return { v: 1, name: 'Watch sketch', size: 'small', w, h, cells: encodeCells(g), bases, ...extra };
}

test('defaults: the old message (ais 4, no format) still makes the four-AI free-for-all the benchmark watches', () => {
  const { m, joined } = watch({ ais: 4, seed: 7 });
  assert.equal(joined.spectator, true);
  assert.equal(m.mode, 'observe');
  assert.equal(m.slots.length, 4);
  assert.ok(m.slots.every((s) => !s.human));
  assert.equal(m.teamSize, 1);
  assert.equal(m.seed, 7);
  assert.equal(m.speed, 1);
  assert.equal(m.observerFog, false);
  assert.equal(m.name, 'AI exhibition (4 empires)');
  // nothing at all: the same four AIs
  assert.equal(watch().m.slots.length, 4);
  // the legacy ruleset's exhibitions (spectator.test.js) are untouched by the new checks
  const legacy = manager(), ws = socket(legacy);
  ws.msg({ t: 'create', mode: 'observe', ais: 3, name: 'Watcher', seed: 11 });
  assert.equal(legacy.matches.get(ws.last('joined').match).slots.length, 3);
});

test('formats: team layouts with every seat an AI, per-AI difficulty and personality', () => {
  for (const [format, seats, teamSize] of [['1v1', 2, 1], ['2v2', 4, 2], ['3v3', 6, 3], ['4v4', 8, 4], ['ffa3', 3, 1], ['ffa4', 4, 1], ['ffa6', 6, 1]]) {
    const { m, error } = watch({ format, ais: seats });
    assert.equal(error, undefined, format);
    assert.equal(m.slots.length, seats, format);
    assert.equal(m.teamSize, teamSize, format);
    assert.ok(m.slots.every((s) => !s.human && !s.token), format);
  }
  const { m } = watch({ format: '2v2', difficulty: 'easy', rivals: [{ difficulty: 'brutal', personality: 'warlord' }, { personality: 'builder' }, {}, { difficulty: 'hard', personality: 'random' }] });
  assert.deepEqual(m.slots.map((s) => s.difficulty), ['brutal', 'easy', 'easy', 'hard']);
  assert.equal(m.slots[0].personality, 'warlord');
  assert.equal(m.slots[1].personality, 'builder');
  assert.ok(['warlord', 'merchant', 'builder'].includes(m.slots[3].personality));
});

test('rules and the random world: victory, starting resources, style, size, seed, speed and fog are honoured', () => {
  const { m } = watch({ format: 'ffa3', objective: 'control', startRes: 'high', style: 'archipelago', mapSize: 'large', seed: 4242, speed: 4, fog: true });
  assert.equal(m.objective, 'control');
  assert.equal(m.startRes, 'high');
  assert.equal(m.style, 'archipelago');
  assert.equal(m.mapSize, 208);
  assert.equal(m.seed, 4242);
  assert.equal(m.speed, 4);
  assert.equal(m.observerFog, true);
  // kept across a save (meta is what a parked or restored match is rebuilt from)
  const meta = new MatchManager(quiet, null).meta(m);
  assert.equal(meta.speed, 4);
  assert.equal(meta.observerFog, true);
});

test('maps: a catalog map takes any format up to its starts; a format it cannot hold is refused by name', () => {
  const four = MAP_CATALOG.find((d) => d.players === 4);
  const two = MAP_CATALOG.find((d) => d.players === 2);
  const ok = watch({ map: four.id, format: '2v2' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.m.map, four.id);
  assert.equal(ok.m.slots.length, 4);
  assert.equal(ok.m.mapSize, four.size);
  // a duel on a four-start map (the spare starts stay neutral)
  assert.equal(watch({ map: four.id, format: '1v1' }).m.slots.length, 2);
  // without a format, the map's own players
  assert.equal(watch({ map: four.id }).m.slots.length, 4);
  const bad = watch({ map: two.id, format: '2v2' });
  assert.match(bad.error, new RegExp(`${two.name} has 2 starting bases; a 2v2 match needs 4`));
  assert.match(watch({ map: 'atlantis' }).error, /Unknown map "atlantis"/);
});

test('empty seats: any seat may be left empty while two sides keep an AI nation', () => {
  const { m } = watch({ format: '2v2', closed: [0] });
  assert.equal(m.slots.length, 4);
  assert.equal(m.slots.filter((s) => s.closed).length, 1);
  assert.equal(m.slots[0].closed, true);
  assert.equal(m.name, 'AI exhibition (3 empires)');
  // closed seats leave when the match starts; the rest keep their team
  const mm = new MatchManager(quiet, null); clearInterval(mm.janitor);
  mm.dropClosed(m);
  assert.deepEqual(m.teamOf, [0, 1, 1]);
  // a whole team emptied leaves one side: refused
  assert.match(watch({ format: '2v2', closed: [0, 1] }).error, /At least two sides must keep an AI nation/);
  assert.match(watch({ format: '1v1', closed: [5] }).error, /no seat 5/);
  assert.match(watch({ ais: 4, closed: [1] }).error, /Choose a format/);
});

test('impossible or unknown options are refused with a clear reason', () => {
  const cases = [
    [{ format: '5v5' }, /Unknown format "5v5"/],
    [{ format: '2v2', ais: 3 }, /2v2 match has 4 AI nations, not 3/],
    [{ ais: 1 }, /between 2 and 12/],
    [{ ais: 40 }, /between 2 and 12/],
    [{ format: '1v1', rivals: [{}, {}, {}] }, /3 AI settings for 2 seats/],
    [{ format: '1v1', rivals: [{ difficulty: 'godlike' }] }, /AI 1: unknown difficulty "godlike"/],
    [{ format: '1v1', rivals: [{}, { personality: 'pacifist' }] }, /AI 2: unknown personality "pacifist"/],
    [{ format: '1v1', rivals: 'all hard' }, /rivals must be a list/],
    [{ difficulty: 'impossible' }, /Unknown AI difficulty/],
    [{ objective: 'wonder' }, /Unknown victory condition "wonder"/],
    [{ startRes: 'infinite' }, /Unknown starting resources/],
    [{ style: 'moon' }, /Unknown world style "moon"/],
    [{ mapSize: 'colossal' }, /Unknown map size "colossal"/],
    [{ speed: 3 }, /Game speed must be 1×, 2×, 4× or 8×/],
    [{ speed: 0 }, /Game speed/],
    [{ fog: 'yes' }, /fog must be true or false/],
    [{ seed: 'abc' }, /seed must be a whole number/],
  ];
  for (const [extra, re] of cases) {
    const r = watch(extra);
    assert.ok(r.error, `expected a refusal for ${JSON.stringify(extra)}`);
    assert.match(r.error, re, JSON.stringify(extra));
    assert.equal(r.mm.matches.size, 0, 'a refused setup creates no match');
  }
});

test('a built map: its bases fit the format, and team-owned bases must give every AI a base', () => {
  const four = sketch([[.15, .2], [.85, .8], [.85, .2], [.15, .75]]);
  const ok = watch({ map: 'custom', sketch: four, format: '2v2' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.m.map, 'custom');
  assert.equal(ok.m.slots.length, 4);
  assert.match(watch({ map: 'custom', sketch: sketch([[.2, .2], [.8, .8]]), format: '2v2' }).error, /has 2 starting bases; a 2v2 match needs 4/);
  // Team 2 owns one base for two AIs
  const owned = watch({ map: 'custom', sketch: { ...four, owners: [0, 0, 1, -1] }, format: '2v2' });
  assert.match(owned.error, /Team 2 has 2 players but only 1 starting base/);
  // with one of Team 2's seats left empty it fits
  assert.equal(watch({ map: 'custom', sketch: { ...four, owners: [0, 0, 1, -1] }, format: '2v2', closed: [3] }).error, undefined);
});

function nextMessage(worker, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off('message', onMessage); reject(new Error('worker message timed out')); }, timeout);
    function onMessage(message) {
      const messages = message.t === 'out' ? message.msgs.map((entry) => JSON.parse(entry[1])) : [message];
      const found = messages.find(predicate);
      if (found) { clearTimeout(timer); worker.off('message', onMessage); resolve(found); }
    }
    worker.on('message', onMessage);
  });
}

test('the worker starts the exhibition at the chosen speed, behind the followed nation\'s fog', { timeout: 30000 }, async () => {
  const worker = new Worker(new URL('../server/worker.js', import.meta.url), { workerData: {
    id: 'watch-setup', seed: 9, mapSize: 128, wrap: true, rebels: false, observe: true, speed: 4, observerFog: true,
    slots: [{ human: false, leader: 'AI 1' }, { human: false, leader: 'AI 2' }],
  } });
  try {
    await nextMessage(worker, (m) => m.t === 'ready');
    const welcome = nextMessage(worker, (m) => m.t === 'welcome');
    const snap = nextMessage(worker, (m) => m.obs);
    worker.postMessage({ t: 'obsWelcome' });
    assert.equal((await welcome).speed, 4);
    const s = await snap;
    assert.equal(s.obs.fog, true);
    assert.equal(s.obs.speed, 4);
  } finally { await worker.terminate(); }
});
