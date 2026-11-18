// Game speed control (requirement R6, docs/gameplay-overhaul/MULTIPLAYER_RULES.md, server section).
//
// Pure rules over a game-like object ({ civs, sandbox, speed, resumeSpeed, speedVote, pendingSpeed }) so they can be
// unit-tested without a worker or sockets. The worker (server/worker.js) calls these from its message handler and
// once per tick interval (`voteStep`), which costs one property check while no vote is open.
//
// - Sandbox, and single-player matches (exactly one human seat): speed is set directly ({c:'speed'}).
// - Multiplayer (two or more human seats, not sandbox): a speed change is a vote. Eligible voters are the human
//   players connected and alive when the vote is proposed. The proposer counts as approving. Unanimous approval
//   passes; any rejection, or VOTE_SECONDS without unanimity, fails. One vote at a time. A voter who disconnects
//   leaves the eligible list (a proposer who disconnects withdraws the vote); a player who joins or reconnects
//   during the vote is not added. A passed vote is applied at the next tick-interval boundary (`voteStep`), so
//   every client sees the change between two whole simulation intervals.

export const SPEEDS = [1, 2, 4];
export const VOTE_SECONDS = 30;
// the worker runs at most this many ms of simulation per 100 ms interval (worker.js); a speed whose measured
// cost (average tick ms × speed) is above it cannot be kept up
export const TICK_BUDGET_MS = 70;

export const humanSeats = (game) => game.civs.filter((c) => c.human).length;
/** 'direct' (sandbox, single player) or 'vote' (multiplayer). */
export const speedMode = (game) => game.sandbox || humanSeats(game) === 1 ? 'direct' : humanSeats(game) >= 2 ? 'vote' : 'none';
export const eligibleVoters = (game) => game.civs.filter((c) => c.human && c.connected && c.alive !== false).map((c) => c.id);

/** An error string when the server cannot keep up `speed` given the measured average tick cost, else null. */
export function sustainable(speed, avgTickMs) {
  if (speed <= 1 || !(avgTickMs > 0)) return null;
  return avgTickMs * speed > TICK_BUDGET_MS ? `The server cannot sustain ${speed}× right now (${avgTickMs.toFixed(1)} ms per tick).` : null;
}

/** Direct speed change (sandbox / single player). Returns { speed } or { error }. */
export function setSpeedDirect(game, speed, avgTickMs = 0) {
  if (speedMode(game) !== 'direct') return { error: 'Propose a speed vote: every player must agree in multiplayer.' };
  if (!SPEEDS.includes(speed)) return { error: 'Choose 1×, 2× or 4× speed' };
  const slow = speed > (game.speed || game.resumeSpeed || 1) ? sustainable(speed, avgTickMs) : null;
  if (slow) return { error: slow };
  game.resumeSpeed = speed; game.speed = speed;
  return { speed };
}

/**
 * {c:'speedVote', speed} proposes, or approves the open vote for that speed; {c:'speedVote', reject:true} rejects
 * (the proposer's reject withdraws). `now` is wall-clock ms. Returns { error } or { result, vote? } where result is
 * 'proposed' | 'approved' | 'passed' | 'rejected' | 'withdrawn' | 'direct'.
 */
export function castVote(game, civId, cmd, now, avgTickMs = 0) {
  const mode = speedMode(game);
  if (mode === 'direct') {
    if (cmd.reject) return { error: 'There is no speed vote to reject.' };
    const r = setSpeedDirect(game, Number(cmd.speed), avgTickMs);
    return r.error ? r : { result: 'direct', speed: r.speed };
  }
  if (mode !== 'vote') return { error: 'Game speed is fixed in this match.' };
  const civ = game.civs[civId];
  if (!civ?.human) return { error: 'Only players can vote on the game speed.' };
  const v = game.speedVote;
  if (cmd.reject) {
    if (!v) return { error: 'There is no speed vote to reject.' };
    if (!v.eligible.includes(civId)) return { error: 'You are not voting on this change.' };
    game.speedVote = null;
    return { result: civId === v.by ? 'withdrawn' : 'rejected', vote: v, by: civId };
  }
  const speed = Number(cmd.speed);
  if (!SPEEDS.includes(speed)) return { error: 'Choose 1×, 2× or 4× speed' };
  if (v) {
    if (v.speed !== speed) return { error: `A vote for ${v.speed}× is already running.` };
    if (!v.eligible.includes(civId)) return { error: 'You are not voting on this change.' };
    if (!v.approvals.includes(civId)) v.approvals.push(civId);
    return settle(game, v) || { result: 'approved', vote: v };
  }
  if (speed === (game.pendingSpeed || game.speed || game.resumeSpeed || 1)) return { error: `The game already runs at ${speed}×.` };
  const slow = speed > (game.speed || 1) ? sustainable(speed, avgTickMs) : null;
  if (slow) return { error: slow };
  const eligible = eligibleVoters(game);
  if (!eligible.includes(civId)) eligible.push(civId);
  const vote = { speed, by: civId, approvals: [civId], eligible, expires: now + VOTE_SECONDS * 1000 };
  game.speedVote = vote;
  return settle(game, vote) || { result: 'proposed', vote };
}

// unanimity: every eligible voter approved -> the change waits for the next interval boundary
function settle(game, v) {
  if (!v.eligible.every((id) => v.approvals.includes(id))) return null;
  game.speedVote = null;
  game.pendingSpeed = v.speed;
  return { result: 'passed', vote: v };
}

/** A voter disconnected: drop them from the vote (the proposer leaving withdraws it). Returns an outcome or null. */
export function dropVoter(game, civId) {
  const v = game.speedVote;
  if (!v || !v.eligible.includes(civId)) return null;
  if (v.by === civId) { game.speedVote = null; return { result: 'withdrawn', vote: v, by: civId }; }
  v.eligible = v.eligible.filter((id) => id !== civId);
  v.approvals = v.approvals.filter((id) => id !== civId);
  return settle(game, v);
}

/**
 * Called once per worker tick interval, before the simulation runs: expires a timed-out vote and applies a passed
 * one (the synchronized boundary). Returns { expired: vote } | { applied: speed } | null. O(1) with no vote.
 */
export function voteStep(game, now) {
  if (game.pendingSpeed) {
    const speed = game.pendingSpeed;
    game.pendingSpeed = 0;
    game.resumeSpeed = speed;
    if (game.speed) game.speed = speed;   // a paused match keeps its pause and resumes at the new speed
    return { applied: speed };
  }
  const v = game.speedVote;
  if (v && now >= v.expires) { game.speedVote = null; return { expired: v }; }
  return null;
}

/** The econ field `speedVote` (MULTIPLAYER_RULES.md contract), or undefined when no vote is open. */
export function voteWire(game, now = Date.now()) {
  const v = game.speedVote;
  if (!v) return undefined;
  return { speed: v.speed, by: v.by, approvals: [...v.approvals], eligible: [...v.eligible], expiresIn: Math.max(0, Math.round((v.expires - now) / 100) / 10) };
}
