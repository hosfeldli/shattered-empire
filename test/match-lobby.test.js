// The pre-game lobby of a multiplayer (pvp) match, as the Steam invite flow uses it: the host creates
// the match and shares its code (through a Steam lobby or by voice), a friend joins with the code,
// both see the room (seats, ready state, who may start), and the match starts when the host presses
// Start or when every human seat is taken. Runs MatchManager directly with fake sockets; starting a
// match is stubbed so no simulation worker is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchManager } from '../server/matches.js';

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
  ws.msg({ t: 'hello', proto: 2, caps: CAPS });
  return ws;
}

test('pvp lobby: host shares the code, a friend joins by code, the match starts when every seat is taken', () => {
  const mm = manager();
  const host = socket(mm), guest = socket(mm);
  host.msg({ t: 'create', mode: 'pvp', name: 'Host', ruleset: 'action-v2', humans: 2, teamSize: 1, ais: 0 });
  const joined = host.last('joined');
  assert.equal(joined.status, 'lobby');
  const code = joined.match;
  let room = host.last('room');
  assert.equal(room.code, code, 'the room carries the code to share');
  assert.equal(room.isHost, true); assert.equal(room.canStart, true); assert.equal(room.you, 0);
  assert.equal(room.open, 1, 'one seat waits for the friend');
  assert.equal(mm.started.length, 0, 'a pvp match waits in the lobby');

  // codes typed by hand: case, spaces and a leading '#'
  guest.msg({ t: 'join', match: `  #${code.toUpperCase()} `, name: 'Guest' });
  assert.equal(guest.last('joined').match, code);
  assert.deepEqual(mm.started, [code], 'the last free seat starts the match');
});

test('pvp lobby: ready state, host-only start, guest leaving frees the seat, host starts early', () => {
  const mm = manager();
  const host = socket(mm), guest = socket(mm), late = socket(mm);
  host.msg({ t: 'create', mode: 'pvp', name: 'Host', ruleset: 'action-v2', humans: 3, teamSize: 2, ais: 0 });
  const code = host.last('joined').match;
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  let room = guest.last('room');
  assert.equal(room.you, 1); assert.equal(room.isHost, false); assert.equal(room.canStart, false);
  assert.equal(room.host, 'Host');

  guest.msg({ t: 'ready', on: true });
  room = host.last('room');
  assert.equal(room.slots[1].ready, true); assert.equal(room.slots[1].connected, true); assert.equal(room.slots[0].ready, false);

  // asking to join the same match again keeps the seat (a second invite click)
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  assert.equal(host.last('room').open, 1);

  // only the host starts
  guest.msg({ t: 'start' });
  assert.match(guest.last('error').error, /Only the host/);
  assert.equal(mm.started.length, 0);

  // a guest leaving frees the seat for someone else
  guest.msg({ t: 'leave' });
  assert.equal(guest.last('left').match, code);
  assert.equal(host.last('room').open, 2);
  late.msg({ t: 'join', match: code, name: 'Late' });
  assert.equal(late.last('room').slots[1].name, 'Late');

  // the room can be asked for again (a menu opening late)
  const before = late.sent.length; late.msg({ t: 'room' }); assert.equal(late.sent.length, before + 1);

  // the host starts early: remaining open seats become AI
  host.msg({ t: 'start' });
  assert.deepEqual(mm.started, [code]);
});

test('pvp lobby: the host leaving closes the lobby for everyone; unknown codes are explained', () => {
  const mm = manager();
  const host = socket(mm), guest = socket(mm);
  host.msg({ t: 'create', mode: 'pvp', name: 'Host', ruleset: 'action-v2', humans: 3, teamSize: 2, ais: 0 });
  const code = host.last('joined').match;
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  host.msg({ t: 'leave' });
  assert.match(guest.last('lobbyClosed').error, /host closed/);
  assert.equal(mm.matches.has(code), false);
  guest.msg({ t: 'join', match: code, name: 'Guest' });
  assert.match(guest.last('error').error, /No match with the code/);
});
