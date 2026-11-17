// Lobby controls (2026-11-16, workstream K): the host edits the pre-game room — formats (team modes and
// free-for-all), the map, AI seats with difficulty and personality, and who sits in which team — and
// players pick their own team. Every edit is validated (host-only where it changes someone else) and
// answered with a fresh 'room' for everyone. Runs MatchManager directly with fake sockets; starting a
// match is stubbed so no simulation worker is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchManager } from '../server/matches.js';
import { MAP_CATALOG } from '../server/sim/mapCatalog.js';

const CAPS = ['geo', 'udelta', 'action-rts', 'ring-cities-v1'];
const quiet = { info() {}, warn() {}, error() {} };

function manager() {
  const mm = new MatchManager(quiet, null);
  clearInterval(mm.janitor);
  mm.admit = () => null;
  mm.started = [];
  mm.start = (m) => { m.status = 'running'; mm.started.push(m.id); };
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

function lobby(format = '2v2', extra = {}) {
  const mm = manager();
  const host = socket(mm);
  host.msg({ t: 'create', mode: 'pvp', name: 'Host', ruleset: 'action-v2', format, waitForReady: true, ...extra });
  return { mm, host, code: host.last('joined').match };
}

const names = (room) => room.slots.map((s) => (s.human ? (s.taken ? s.name : 'open') : `AI:${s.difficulty}`));

test('formats: team modes and free-for-all create the right seats and teams', () => {
  for (const [format, seats, teams, teamSize] of [['1v1', 2, 2, 1], ['2v2', 4, 2, 2], ['3v3', 6, 2, 3], ['4v4', 8, 2, 4], ['ffa3', 3, 3, 1], ['ffa4', 4, 4, 1]]) {
    const { host } = lobby(format);
    const room = host.last('room');
    assert.equal(room.slots.length, seats, format);
    assert.equal(room.teams, teams, format); assert.equal(room.teamSize, teamSize, format); assert.equal(room.format, format);
    assert.deepEqual(room.slots.map((s) => s.team), room.slots.map((_, i) => Math.floor(i / teamSize)));
    assert.equal(room.open, seats - 1, 'every other seat waits for a player');
  }
  // New Skirmish (mode 'ai') with a format: the human plus exactly the AIs it needs, per-AI settings
  const mm = manager(), p = socket(mm);
  mm.start = () => {};
  p.msg({ t: 'create', mode: 'ai', name: 'Solo', ruleset: 'action-v2', format: 'ffa4', ais: 3,
    rivals: [{ difficulty: 'hard', personality: 'warlord' }, { difficulty: 'easy', personality: 'builder' }, { difficulty: 'brutal', personality: 'merchant' }] });
  const m = mm.matches.get(p.last('joined').match);
  assert.equal(m.slots.length, 4); assert.equal(m.teamSize, 1);
  assert.deepEqual(m.slots.slice(1).map((s) => [s.difficulty, s.personality]), [['hard', 'warlord'], ['easy', 'builder'], ['brutal', 'merchant']]);
  const two = manager(), q = socket(two); two.start = () => {};
  q.msg({ t: 'create', mode: 'ai', name: 'Solo', ruleset: 'action-v2', format: '2v2' });
  const m2 = two.matches.get(q.last('joined').match);
  assert.equal(m2.slots.length, 4); assert.equal(m2.teamSize, 2); assert.equal(m2.slots.filter((s) => s.human).length, 1);
});

test('AI seats: the host adds, tunes and removes AIs; values and permissions are validated', () => {
  const { mm, host, code } = lobby('2v2');
  const guest = socket(mm);
  guest.msg({ t: 'join', match: code, name: 'Guest' });

  host.msg({ t: 'addAi', team: 1, difficulty: 'hard', personality: 'warlord' });
  let room = host.last('room');
  assert.deepEqual(names(room), ['Host', 'Guest', 'AI:hard', 'open']);
  assert.equal(room.slots[2].personality, 'warlord');
  host.msg({ t: 'addAi', seat: 3 });
  room = host.last('room');
  assert.equal(room.slots[3].difficulty, 'normal');
  assert.ok(['warlord', 'merchant', 'builder'].includes(room.slots[3].personality), 'a random personality');
  assert.match(host.error({ t: 'addAi' }), /No open seat/);

  host.msg({ t: 'aiDifficulty', seat: 3, difficulty: 'expert', personality: 'merchant' });
  room = guest.last('room');
  assert.equal(room.slots[3].difficulty, 'expert'); assert.equal(room.slots[3].personality, 'merchant');
  assert.match(host.error({ t: 'aiDifficulty', seat: 3, difficulty: 'godlike' }), /Unknown AI difficulty/);
  assert.match(host.error({ t: 'aiDifficulty', seat: 3, personality: 'pacifist' }), /Unknown AI personality/);
  assert.match(host.error({ t: 'aiDifficulty', seat: 1, difficulty: 'easy' }), /not an AI/);
  assert.match(host.error({ t: 'aiDifficulty', seat: 9, difficulty: 'easy' }), /No such seat/);

  // guests cannot change AIs
  assert.match(guest.error({ t: 'addAi' }), /Only the host/);
  assert.match(guest.error({ t: 'removeAi', seat: 2 }), /Only the host/);
  assert.match(guest.error({ t: 'aiDifficulty', seat: 2, difficulty: 'easy' }), /Only the host/);

  host.msg({ t: 'removeAi', seat: 2 });
  assert.deepEqual(names(host.last('room')), ['Host', 'Guest', 'open', 'AI:expert']);
  assert.match(host.error({ t: 'removeAi', seat: 0 }), /not an AI/);
  // a removed AI's seat takes the next player
  const late = socket(mm);
  late.msg({ t: 'join', match: code, name: 'Late' });
  assert.deepEqual(names(late.last('room')), ['Host', 'Guest', 'Late', 'AI:expert']);
  assert.equal(late.last('room').you, 2);
});

test('teams: players pick their own team, the host moves anyone, full teams are refused', () => {
  const { mm, host, code } = lobby('2v2');
  const a = socket(mm), b = socket(mm);
  a.msg({ t: 'join', match: code, name: 'A' });
  // A (seat 1, team 0) moves to team 1: the first open seat there
  a.msg({ t: 'team', team: 1 });
  let room = a.last('room');
  assert.deepEqual(names(room), ['Host', 'open', 'A', 'open']);
  assert.equal(room.you, 2); assert.equal(room.slots[2].team, 1);
  assert.equal(host.last('room').isHost, true);
  assert.match(a.error({ t: 'team', team: 5 }), /No such team/);
  assert.match(a.error({ t: 'team', seat: 0, team: 1 }), /Only the host/);

  b.msg({ t: 'join', match: code, name: 'B' });
  host.msg({ t: 'addAi', seat: 3, difficulty: 'easy' });
  // B (team 0) asks for team 1: only the AI's seat is free there, so B swaps with it
  b.msg({ t: 'team', team: 1 });
  assert.deepEqual(names(b.last('room')), ['Host', 'AI:easy', 'A', 'B']);
  // the host moves itself; the host role follows the player, not seat 0
  assert.match(host.error({ t: 'team', team: 1 }), /Team 2 is full/);
  host.msg({ t: 'seat', seat: 0, to: 2 });
  room = host.last('room');
  assert.deepEqual(names(room), ['A', 'AI:easy', 'Host', 'B']);
  assert.equal(room.you, 2); assert.equal(room.isHost, true); assert.equal(room.host, 'Host');
  assert.equal(a.last('room').isHost, false);
  assert.equal(room.slots[2].host, true);
  // a player can only take a free seat
  assert.match(a.error({ t: 'seat', to: 3 }), /taken/);
  a.msg({ t: 'seat', to: 1 });
  assert.deepEqual(names(a.last('room')), ['AI:easy', 'A', 'Host', 'B']);
  assert.match(a.error({ t: 'seat', seat: 2, to: 0 }), /Only the host/);
  // only the host (wherever it sits) starts
  assert.match(a.error({ t: 'start' }), /Only the host/);
  host.msg({ t: 'start' });
  assert.equal(mm.started.length, 1);
});

test('format changes keep the seated players and their teams; too small a format is refused', () => {
  const { mm, host, code } = lobby('2v2');
  const a = socket(mm), b = socket(mm);
  a.msg({ t: 'join', match: code, name: 'A' });
  b.msg({ t: 'join', match: code, name: 'B' });
  b.msg({ t: 'team', team: 1 });
  host.msg({ t: 'addAi', difficulty: 'hard' });
  assert.deepEqual(names(host.last('room')), ['Host', 'A', 'B', 'AI:hard']);

  host.msg({ t: 'mode', mode: 'ffa4' });
  let room = host.last('room');
  assert.equal(room.format, 'ffa4'); assert.equal(room.teams, 4); assert.equal(room.teamSize, 1);
  assert.deepEqual(names(room), ['Host', 'B', 'A', 'AI:hard'], 'each keeps its old team where it can');
  host.msg({ t: 'mode', mode: '3v3' });
  room = host.last('room');
  assert.equal(room.slots.length, 6);
  assert.equal(room.slots.filter((s) => s.human && s.taken).length, 3);
  assert.equal(room.slots.filter((s) => !s.human).length, 1);
  assert.match(host.error({ t: 'mode', mode: '1v1' }), /3 players are seated/);
  assert.equal(host.last('room').slots.length, 6, 'a refused change leaves the room as it was');
  assert.match(host.error({ t: 'mode', mode: '7v7' }), /Unknown format/);
  assert.match(a.error({ t: 'mode', mode: 'ffa3' }), /Only the host/);
  host.msg({ t: 'mode', mode: 'ffa3' });
  room = host.last('room');
  assert.deepEqual(room.slots.map((s) => s.human && s.taken), [true, true, true], 'the AI gave way to the players');
  assert.ok(mm.matches.get(code).slots.every((s, i) => s === mm.matches.get(code).slots[i]));
});

test('maps: the host picks any catalog map (it sets the format and size) or a random world', () => {
  const { mm, host, code } = lobby('1v1');
  const guest = socket(mm);
  const byFormat = (players, teamSize) => MAP_CATALOG.find((d) => d.players === players && d.teamSize === teamSize);
  const duel = byFormat(2, 1), fours = byFormat(4, 2);
  assert.ok(duel && fours, 'the catalog has a 1v1 and a 2v2 map');
  host.msg({ t: 'map', map: fours.id });
  let room = host.last('room');
  assert.equal(room.map, fours.id); assert.equal(room.mapName, fours.name); assert.equal(room.mapSize, fours.size);
  assert.equal(room.slots.length, 4); assert.equal(room.teamSize, 2);
  assert.match(host.error({ t: 'map', map: 'atlantis' }), /Unknown map/);
  assert.match(host.error({ t: 'map', map: '__proto__' }), /Unknown map/);
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  assert.match(guest.error({ t: 'map', map: duel.id }), /Only the host/);
  // a format that does not fit the map falls back to a random world
  host.msg({ t: 'mode', mode: 'ffa3' });
  room = host.last('room');
  assert.equal(room.map, 'random'); assert.equal(room.format, 'ffa3');
  host.msg({ t: 'map', map: duel.id });
  room = host.last('room');
  assert.equal(room.map, duel.id); assert.equal(room.slots.length, 2);
  // two players cannot squeeze onto a map that has fewer seats than are taken
  const big = MAP_CATALOG.find((d) => d.players >= 4);
  host.msg({ t: 'map', map: big.id });
  const third = socket(mm); third.msg({ t: 'join', match: code, name: 'Third' });
  assert.match(host.error({ t: 'map', map: duel.id }), /players are seated/);
  host.msg({ t: 'map', map: 'random' });
  assert.equal(host.last('room').map, 'random');
  assert.equal(host.last('room').slots.length, big.players, 'a random world keeps the seats');
});

test('ready lobbies start when every seat is taken and every player is ready (or when the host starts)', () => {
  const { mm, host, code } = lobby('1v1');
  const guest = socket(mm);
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  assert.equal(mm.started.length, 0, 'a full lobby waits for ready');
  host.msg({ t: 'ready', on: true });
  assert.equal(mm.started.length, 0);
  guest.msg({ t: 'ready', on: true });
  assert.deepEqual(mm.started, [code]);
  // edits only in the lobby
  assert.match(host.error({ t: 'mode', mode: '2v2' }), /Not in a match lobby/);
});

test('lobby edits from someone outside a lobby are refused; acks carry the request id', () => {
  const mm = manager();
  const ws = socket(mm);
  assert.match(ws.error({ t: 'team', team: 1 }), /Not in a match lobby/);
  const { host } = lobby('2v2');
  host.msg({ t: 'addAi', rid: 7 });
  assert.equal(host.last('ack').rid, 7);
});

test('spectators: commands in the obsCmd envelope reach the match worker (observer speed buttons)', () => {
  const mm = manager();
  const ws = socket(mm);
  const m = mm.create({ mode: 'observe', ruleset: 'action-v2', ais: 2 });
  const posted = [];
  m.status = 'running'; m.ready = true; m.worker = { postMessage: (x) => posted.push(x) };
  ws.msg({ t: 'spectate', match: m.id, name: 'Watcher' });
  ws.msg({ t: 'obsCmd', rid: 3, cmd: { c: 'speed', speed: 4 } });
  assert.deepEqual(posted.filter((x) => x.t === 'obsCmd'), [{ t: 'obsCmd', cmd: { c: 'speed', speed: 4 }, rid: 3 }]);
  // a player cannot use the spectator envelope
  const { host } = lobby('1v1');
  assert.match(host.error({ t: 'obsCmd', cmd: { c: 'speed', speed: 8 } }), /Not spectating/);
});

test('match options: victory, starting resources and a random world; host only, validated, in every room', () => {
  const { mm, host, code } = lobby('2v2');
  const guest = socket(mm);
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  let room = host.last('room');
  assert.equal(room.objective, 'domination'); assert.equal(room.startRes, 'standard'); assert.equal(room.public, false);
  host.msg({ t: 'options', objective: 'control', startRes: 'high', style: 'archipelago', size: 'large', public: true });
  room = guest.last('room');
  assert.deepEqual([room.objective, room.startRes, room.style, room.size, room.public], ['control', 'high', 'archipelago', 'large', true]);
  assert.equal(room.mapSize, 208, 'a random world takes the chosen size');
  assert.match(guest.error({ t: 'options', startRes: 'low' }), /Only the host/);
  assert.match(host.error({ t: 'options', startRes: 'infinite' }), /Unknown starting resources/);
  assert.match(host.error({ t: 'options', objective: 'kill-all' }), /Unknown victory/);
  // the public lobby list carries listed lobbies only
  const listed = mm.lobbies();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, code); assert.equal(listed[0].format, '2v2'); assert.equal(listed[0].players, 2);
  host.msg({ t: 'options', public: false });
  assert.equal(mm.lobbies().length, 0);
  // New Skirmish passes them at create
  const solo = manager(), p = socket(solo); solo.start = () => {};
  p.msg({ t: 'create', mode: 'ai', name: 'Solo', ruleset: 'action-v2', format: '1v1', startRes: 'max', objective: 'operation' });
  const m = solo.matches.get(p.last('joined').match);
  assert.equal(m.startRes, 'max'); assert.equal(m.objective, 'operation');
});

test('closed seats make uneven teams on a random world; at least two sides remain; dropped at the start', () => {
  const { mm, host } = lobby('2v2');
  host.msg({ t: 'closeSeat', seat: 1 });                       // 1 (host) v 2
  let room = host.last('room');
  assert.equal(room.slots[1].closed, true); assert.equal(room.players, 3); assert.equal(room.open, 2);
  assert.match(host.error({ t: 'addAi', seat: 1 }), /not open/);
  host.msg({ t: 'closeSeat', seat: 2 });                       // 1 v 1 (seats 0 and 3)
  assert.match(host.error({ t: 'closeSeat', seat: 3 }), /two sides/);
  host.msg({ t: 'closeSeat', seat: 2, closed: false });
  host.msg({ t: 'addAi', seat: 2, difficulty: 'hard' });
  host.msg({ t: 'addAi', seat: 3, difficulty: 'easy' });
  const m = [...mm.matches.values()][0];
  mm.dropClosed(m);
  assert.equal(m.slots.length, 3);
  assert.deepEqual(m.teamOf, [0, 1, 1], 'the host alone against two AIs');
  // a catalog map opens closed seats again and refuses closing
  const second = lobby('2v2');
  second.host.msg({ t: 'closeSeat', seat: 3 });
  const map = MAP_CATALOG.find((d) => d.players === 4 && d.teamSize === 2);
  second.host.msg({ t: 'map', map: map.id });
  assert.ok(second.host.last('room').slots.every((s) => !s.closed));
  assert.match(second.host.error({ t: 'closeSeat', seat: 3 }), /catalog map/);
  // New Skirmish: 'closed' seat indices at create (you and an ally against one AI)
  const solo = manager(), p = socket(solo); solo.start = () => {};
  p.msg({ t: 'create', mode: 'ai', name: 'Solo', ruleset: 'action-v2', format: '2v2', closed: [3] });
  const s = solo.matches.get(p.last('joined').match);
  solo.dropClosed(s);
  assert.equal(s.slots.length, 3); assert.deepEqual(s.teamOf, [0, 0, 1]);
});

test('lobby spectators: watch a lobby by code, a player steps out to watch and back in to sit', () => {
  const { mm, host, code } = lobby('1v1');
  const fan = socket(mm);
  fan.msg({ t: 'spectate', match: code, name: 'Fan' });
  assert.equal(fan.last('joined').spectator, true);
  let room = fan.last('room');
  assert.equal(room.you, -1); assert.equal(room.spectator, true);
  assert.deepEqual(host.last('room').spectators.map((s) => s.name), ['Fan']);
  const guest = socket(mm);
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  guest.msg({ t: 'watch' });
  room = host.last('room');
  assert.equal(room.open, 1); assert.equal(room.spectators.length, 2);
  assert.match(host.error({ t: 'watch' }), /host plays/);
  fan.msg({ t: 'sit' });
  room = host.last('room');
  assert.equal(room.slots[1].name, 'Fan'); assert.equal(room.spectators.length, 1);
  assert.equal(fan.last('room').you, 1);
  // the host leaving tells the spectators too
  host.msg({ t: 'leave' });
  assert.ok(guest.last('lobbyClosed'));
});

test('the simulation takes explicit teams and starting resources', async () => {
  globalThis.SE_MAP_SIZE = 64; globalThis.SE_WRAP = false;
  const { ActionGame, START_RES } = await import('../server/sim/actionGame.js');
  const g = new ActionGame({ id: 't', seed: 5, style: 'pangaea', teamSize: 2, teamOf: [0, 1, 1], startRes: 'high',
    slots: [{ human: true }, { human: false, difficulty: 'normal', personality: 'builder' }, { human: false, difficulty: 'normal', personality: 'warlord' }] });
  assert.deepEqual(g.civs.map((c) => c.team), [0, 1, 1]);
  assert.deepEqual(g.civs[0].res, START_RES.high);
});

test('a random world size of auto follows the seat count again', () => {
  const { host } = lobby('3v3');
  host.msg({ t: 'options', size: 'small' });
  assert.equal(host.last('room').size, 'small'); assert.equal(host.last('room').mapSize, 104);
  host.msg({ t: 'options', size: 'auto' });
  assert.equal(host.last('room').size, null); assert.equal(host.last('room').mapSize, 208, 'six seats: the large world');
});
