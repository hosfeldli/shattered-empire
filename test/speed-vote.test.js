// R6 game speed (directive Test F): single player and sandbox set speed directly; multiplayer needs a unanimous vote
// of the connected human players, any rejection or a 30 s timeout fails it, and a passed vote is applied at the next
// tick-interval boundary. server/sim/speedVote.js holds the rules the worker calls (no sockets needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castVote, dropVoter, setSpeedDirect, speedMode, sustainable, VOTE_SECONDS, voteStep, voteWire } from '../server/sim/speedVote.js';

const civ = (id, human, connected = human) => ({ id, human, connected, alive: true, name: `P${id}` });
const match = (civs, extra = {}) => ({ civs, speed: 1, resumeSpeed: 1, speedVote: null, pendingSpeed: 0, ...extra });
const T0 = 1_000_000;

test('single player and sandbox change speed directly; multiplayer must vote', () => {
  const solo = match([civ(0, true), civ(1, false), civ(2, false)]);
  assert.equal(speedMode(solo), 'direct');
  assert.deepEqual(setSpeedDirect(solo, 4), { speed: 4 });
  assert.equal(solo.speed, 4);
  assert.ok(setSpeedDirect(solo, 3).error, 'only 1×, 2×, 4×');
  // a speedVote command in single player just applies the speed
  assert.equal(castVote(solo, 0, { c: 'speedVote', speed: 2 }, T0).result, 'direct');
  assert.equal(solo.speed, 2);

  const sandbox = match([civ(0, true), civ(1, true)], { sandbox: true });
  assert.equal(speedMode(sandbox), 'direct');

  const mp = match([civ(0, true), civ(1, true), civ(2, false)]);
  assert.equal(speedMode(mp), 'vote');
  assert.match(setSpeedDirect(mp, 2).error, /vote/);
  assert.equal(mp.speed, 1, 'speed never changes without a vote');
});

test('unanimous approval passes, and the change waits for the next tick boundary', () => {
  const g = match([civ(0, true), civ(1, true), civ(2, true), civ(3, false)]);
  const r = castVote(g, 1, { speed: 2 }, T0);
  assert.equal(r.result, 'proposed');
  assert.deepEqual(voteWire(g, T0 + 2000), { speed: 2, by: 1, approvals: [1], eligible: [0, 1, 2], expiresIn: VOTE_SECONDS - 2 });
  assert.equal(castVote(g, 0, { speed: 2 }, T0 + 3000).result, 'approved');
  assert.equal(g.speed, 1);
  assert.match(castVote(g, 2, { speed: 4 }, T0 + 3500).error, /already running/, 'one vote at a time');
  assert.equal(castVote(g, 2, { speed: 2 }, T0 + 4000).result, 'passed');
  assert.equal(g.speedVote, null);
  assert.equal(voteWire(g), undefined, 'the econ field disappears once the vote is decided');
  assert.equal(g.speed, 1, 'not applied mid-interval');
  assert.deepEqual(voteStep(g, T0 + 4100), { applied: 2 });
  assert.equal(g.speed, 2); assert.equal(g.resumeSpeed, 2);
  assert.equal(voteStep(g, T0 + 4200), null, 'nothing left to do');
});

test('any rejection fails the vote; the proposer can withdraw', () => {
  const g = match([civ(0, true), civ(1, true), civ(2, true)]);
  castVote(g, 0, { speed: 4 }, T0);
  castVote(g, 1, { speed: 4 }, T0 + 100);
  const r = castVote(g, 2, { reject: true }, T0 + 200);
  assert.equal(r.result, 'rejected'); assert.equal(r.by, 2);
  assert.equal(g.speedVote, null); assert.equal(g.pendingSpeed, 0);
  assert.equal(voteStep(g, T0 + 300), null); assert.equal(g.speed, 1);
  castVote(g, 1, { speed: 2 }, T0 + 400);
  assert.equal(castVote(g, 1, { reject: true }, T0 + 500).result, 'withdrawn');
  assert.ok(castVote(g, 0, { reject: true }, T0 + 600).error, 'nothing to reject');
});

test('a vote without unanimity times out after 30 s', () => {
  const g = match([civ(0, true), civ(1, true)]);
  castVote(g, 0, { speed: 2 }, T0);
  assert.equal(voteStep(g, T0 + VOTE_SECONDS * 1000 - 1), null);
  const r = voteStep(g, T0 + VOTE_SECONDS * 1000);
  assert.equal(r.expired.speed, 2);
  assert.equal(g.speedVote, null); assert.equal(g.speed, 1);
});

test('eligibility: connected humans at proposal; spectators and AIs never vote; a leaver is dropped', () => {
  const g = match([civ(0, true), civ(1, true), civ(2, true, false), civ(3, false)]);
  castVote(g, 0, { speed: 2 }, T0);
  assert.deepEqual(g.speedVote.eligible, [0, 1], 'the disconnected player is not asked');
  assert.match(castVote(g, 3, { speed: 2 }, T0).error, /Only players/);
  g.civs[2].connected = true;   // reconnecting mid-vote does not join it
  assert.match(castVote(g, 2, { speed: 2 }, T0).error, /not voting/);
  // the only other voter disconnects: everyone left has approved, so it passes
  assert.equal(dropVoter(g, 1).result, 'passed');
  assert.equal(voteStep(g, T0 + 50).applied, 2);

  const h = match([civ(0, true), civ(1, true), civ(2, true)]);
  castVote(h, 1, { speed: 4 }, T0);
  assert.equal(dropVoter(h, 1).result, 'withdrawn', 'the proposer leaving withdraws the vote');
  assert.equal(h.speedVote, null);
  castVote(h, 0, { speed: 4 }, T0);
  assert.equal(dropVoter(h, 2), null, 'still waiting on player 1');
  assert.deepEqual(h.speedVote.eligible, [0, 1]);
});

test('refuses a speed the server cannot sustain, and a no-op proposal', () => {
  assert.equal(sustainable(2, 20), null);
  assert.match(sustainable(4, 20), /cannot sustain 4×/);
  const g = match([civ(0, true), civ(1, true)]);
  assert.match(castVote(g, 0, { speed: 4 }, T0, 25).error, /cannot sustain/);
  assert.match(castVote(g, 0, { speed: 1 }, T0).error, /already runs/);
  const solo = match([civ(0, true)]);
  assert.match(setSpeedDirect(solo, 4, 30).error, /cannot sustain/);
  assert.deepEqual(setSpeedDirect(solo, 2, 30), { speed: 2 }, '2 × 30 ms fits the 70 ms budget');
});

test('a paused match keeps its pause and resumes at the voted speed', () => {
  const g = match([civ(0, true), civ(1, true)], { speed: 0, resumeSpeed: 1 });
  castVote(g, 0, { speed: 2 }, T0); castVote(g, 1, { speed: 2 }, T0);
  voteStep(g, T0);
  assert.equal(g.speed, 0); assert.equal(g.resumeSpeed, 2);
});
