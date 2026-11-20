// One match = one worker thread. The simulation, fog-of-war filtering and JSON encoding all run
// here, so a heavy battle in one match cannot stall the event loop of another.
import { deltaEncoder, KEYED_CAP } from './delta.js';
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

globalThis.SE_MAP_SIZE = workerData.mapSize;
globalThis.SE_WRAP = workerData.wrap !== false;   // bounded only for matches saved before wrapping existed
const { Game } = await import('./sim/game.js');
const { ActionGame } = await import('./sim/actionGame.js');
const { ACTION_RULESET } = await import('./sim/rulesets.js');
const { GAME_DEFS, TICK_HZ, aiProfile } = await import('./sim/constants.js');
const { serializeGame, restoreGame } = await import('./sim/persist.js');
const { geoViewer, geoMessage } = await import('./sim/terrainGeo.js');
const { commandAck } = await import('./commandAck.js');
const { castVote, dropVoter, setSpeedDirect, speedMode, sustainable, voteStep } = await import('./sim/speedVote.js');

let game;
if (workerData.restore) {
  game = restoreGame(JSON.parse(zlib.gunzipSync(Buffer.from(workerData.restore)).toString()));
} else {
  const Simulation = workerData.ruleset === ACTION_RULESET ? ActionGame : Game;
  game = new Simulation({ ...workerData, restore: false, rebels: false });
  if (workerData.sandbox && game.ruleset !== ACTION_RULESET) { const { makeSandbox } = await import('./sim/sandbox.js'); makeSandbox(game); }
}
// live matches let AI planning slide a tick when a tick runs long (tests and replays stay strict)
game.adaptive = process.env.SE_ADAPTIVE !== '0';
if (workerData.sandbox) { game.sandbox = true; game.sandboxReveal = true; for (const c of game.civs) if (!c.human) c.ai = null; game.refreshVisibility(); }
const post = (m) => parentPort.postMessage(m);
// Telemetry (docs/TELEMETRY.md): only when the server has it on. The probe reads the game, never writes it.
let probe = null;
if (workerData.telemetry) {
  const { createProbe } = await import('./telemetry/probe.js');
  const defs = await import('./sim/actionDefinitions.js'), navMod = game.ruleset === ACTION_RULESET ? await import('./sim/actionNavigation.js') : null;
  probe = createProbe(game, { post, units: defs.ACTION_UNITS, buildings: defs.ACTION_BUILDINGS, centerOf: navMod?.centerOf, minuteMs: workerData.telemetry.minuteMs || 60_000 });
  setInterval(() => { try { probe?.second(); } catch (e) { post({ t: 'error', error: 'telemetry: ' + String(e && e.stack || e) }); probe = null; } }, 1000).unref();
}
const out = [];
const deltas = new Map();               // civId (or -2: the spectators' shared channel) -> snapshot delta encoder ('udelta')
// Effective pace (B7, 2026-11-19): simulated seconds per wall second over the last few intervals. The loop caps the
// work per interval, so a big match asked to run at 8x may deliver 2x; the econ snapshots carry the real rate ('pace')
// so the HUD can show it and the client clock can follow it. Omitted until a window has been measured.
const PACE_N = 30;                       // intervals (3 s of wall time)
const paceRing = [];
let pace = null;
function paceSample(wallMs) {
  paceRing.push([wallMs, game.time]);
  if (paceRing.length > PACE_N) paceRing.shift();
  if (paceRing.length < 10) { pace = null; return; }
  const [w0, s0] = paceRing[0], [w1, s1] = paceRing[paceRing.length - 1];
  pace = w1 > w0 ? Math.round(((s1 - s0) * 1000 / (w1 - w0)) * 10) / 10 : null;
}
const paceReset = () => { paceRing.length = 0; pace = null; };
const sendSnap = (civId, msg) => {
  if (msg.econ && pace != null) msg.pace = pace;
  const enc = deltas.get(civId);
  if (!probe) { send(civId, enc ? enc(msg) : msg); return; }
  // v3 telemetry (Pass 7): delta-encode and stringify timed apart, bytes tagged snap / econ
  const t0 = performance.now(), m = enc ? enc(msg) : msg, t1 = performance.now(), json = JSON.stringify(m), t2 = performance.now();
  probe.span('snapshot.delta', t1 - t0); probe.span('snapshot.stringify', t2 - t1);
  out.push([civId, json, null, msg.econ ? 'econ' : 'snap']);
};
const newEncoder = (caps) => deltaEncoder(50, 10, { keyed: !!caps?.includes(KEYED_CAP) });
const send = (civId, msg, cap) => out.push(cap ? [civId, JSON.stringify(msg), cap] : [civId, JSON.stringify(msg)]);
// viewers whose connection negotiated terrain geometry (civ id, or -2 for spectators): what they were sent
const geoViewers = new Map();
function geoView(civId) {
  if (civId === -2) { const o = game.setObserver(), c = game.civs[o.follow]; if (!game.allSeen) game.allSeen = new Uint8Array(c.visible.length).fill(1); return o.fog ? [c.visible, c.explored] : [game.allSeen, game.allSeen]; }
  const c = game.civs[civId]; return [c.visible, c.explored];
}
function sendGeo(civId, full) {
  const v = geoViewers.get(civId); if (!v) return;
  const [vis, explored] = geoView(civId);
  const msg = geoMessage(game, v, vis, explored, full);
  if (msg) send(civId, msg, 'geo');
}
function geoStep() { for (const civId of geoViewers.keys()) if (civId === -2 ? game.observer?.connected : game.civs[civId]?.connected) sendGeo(civId, false); }
function flush() {
  for (const [civId, msg] of game.outbox) send(civId, msg);
  game.outbox.length = 0;
  if (out.length) {
    if (!probe) { post({ t: 'out', msgs: out.splice(0) }); return; }
    probe.out(out);
    const t0 = performance.now(); post({ t: 'out', msgs: out.splice(0) }); probe.span('post.out', performance.now() - t0);
  }
}

let tickMs = 0, maxMs = 0, ticks = 0, overSent = false, frames = 0;
let congested = new Set();     // civ ids (-2: observers) whose connection is backed up

const AUTOSAVE_S = +(process.env.AUTOSAVE_SECONDS || 60);
let nextSave = game.time + AUTOSAVE_S;
// Spectated AI-only matches can run faster than real time (or pause) for testing.
const OBSERVE = !!workerData.observe;
game.speed = 1;
// Watch AI Match setup: the exhibition's starting speed and the spectator's fog (both still change in the match)
if (OBSERVE) {
  if ([1, 2, 4, 8].includes(workerData.speed)) game.speed = workerData.speed;
  if (workerData.observerFog && typeof game.setObserver === 'function') game.setObserver({ fog: true });
}
// R6 speed votes (sim/speedVote.js): results are announced to everyone; a passed vote is applied here, at the
// start of a tick interval, so the change lands on a boundary between two whole intervals
const civName = (id) => game.civs[id]?.name || 'A player';
function announceVote(r) {
  if (!r?.result && !r?.expired && !r?.applied) return;
  const note = (text, level = 'info') => send(-1, { t: 'note', time: Math.round(game.time), text, kind: 'speed', level, quiet: level === 'info' });
  if (r.applied) { paceReset(); send(-1, { t: 'paused', on: !game.speed, speed: game.speed }); note(`Game speed is now ${r.applied}×.`, 'minor'); }
  else if (r.expired) note(`The vote for ${r.expired.speed}× ran out of time.`);
  else if (r.result === 'proposed') note(`${civName(r.vote.by)} proposes ${r.vote.speed}× speed.`, 'minor');
  else if (r.result === 'passed') note(`Everyone agreed to ${r.vote.speed}× speed.`);
  else if (r.result === 'rejected') note(`${civName(r.by)} rejected ${r.vote.speed}× speed.`);
  else if (r.result === 'withdrawn') note(`The vote for ${r.vote.speed}× was withdrawn.`);
}
const timer = setInterval(() => {
  try {
    if (game.speedVote || game.pendingSpeed) { announceVote(voteStep(game, Date.now())); flush(); }
    // A connected observer is a human too: exhibitions continue while watched. Keep the
    // requested speed intact so reconnecting resumes the same match, including a manual pause.
    // The manager later saves and parks the worker after its existing idle timeout.
    if (!game.civs.some((c) => c.human && c.connected) && !game.observer?.connected) { paceReset(); probe?.idle(); return; }
    const t0 = performance.now();
    // at higher speeds, run several ticks per interval but never let one interval overrun
    let n = 0;
    while (n < game.speed && (n === 0 || performance.now() - t0 < 70) && !game.over) { game.tick(); n++; }
    if (!game.speed) {
      paceReset();
      // paused: keep the view alive (orders given now show up and run when play resumes)
      frames++;
      if (frames % 5 === 0) { for (const [civId, msg] of game.snapshots(null, frames % 10 === 0, congested)) sendSnap(civId, msg); geoStep(); }   // includes the spectator
      flush(); probe?.interval(0, 0, true); return;
    }
    frames++;
    paceSample(performance.now());
    // 5 Hz snapshots, economy every second, regardless of how many ticks ran
    const ts = probe ? performance.now() : 0;
    if (frames % 2 === 0) {
      const list = game.snapshots(null, frames % 10 === 0, congested);
      if (probe) probe.span('snapshot.build', performance.now() - ts);
      for (const [civId, msg] of list) sendSnap(civId, msg);
      if (probe) { const tg = performance.now(); geoStep(); probe.span('snapshot.geo', performance.now() - tg); } else geoStep();
      probe?.snapshot(performance.now() - ts, congested.size);
    }
    flush();
    probe?.interval(performance.now() - t0, n, false);
    // n is 0 once the match is over (nothing ticks): no per-tick figure then ("avg tick Infinityms" at match end)
    if (n > 0) { const dt = (performance.now() - t0) / n; tickMs = tickMs * 0.98 + dt * 0.02; maxMs = Math.max(maxMs, dt); ticks += n; }
    if (game.time >= nextSave) { nextSave = game.time + AUTOSAVE_S; const time = game.time; saveAsync((buf) => post({ t: 'autosave', buf, time })); }
    if (game.over && !overSent) { overSent = true; const winner = game.winner; saveAsync((buf) => post({ t: 'over', winner, buf })); }
  } catch (e) {
    post({ t: 'error', error: String(e && e.stack || e) });
  }
}, 1000 / TICK_HZ);
setInterval(() => {
  const mem = process.memoryUsage();
  post({ t: 'stats', avg: +tickMs.toFixed(2), max: +maxMs.toFixed(1), time: Math.round(game.time), units: game.units.size, civs: game.civs.length, heapMb: Math.round(mem.heapUsed / 1048576), systems: game.sched ? game.sched.metrics() : {} });
  maxMs = 0; game.sched?.resetMax();
}, 5000).unref();

// The state is captured synchronously (so it is consistent), then compressed off the tick loop.
function save() { return zlib.gzipSync(JSON.stringify(serializeGame(game))); }
let saving = false;
function saveAsync(done) {
  if (saving) return;                       // one compression in flight at a time
  saving = true;
  const t0 = performance.now();
  const snap = serializeGame(game), t1 = performance.now();
  const json = JSON.stringify(snap), t2 = performance.now();
  probe?.autosave(t2 - t0);
  if (probe) { probe.span('autosave.serialize', t1 - t0); probe.span('autosave.stringify', t2 - t1); }
  // the gzip runs on the libuv pool; its wall time (start to callback) is reported as autosave.gzip_wall
  zlib.gzip(json, { level: 6 }, (err, buf) => { saving = false; probe?.span('autosave.gzip_wall', performance.now() - t2); if (err) post({ t: 'error', error: 'save failed: ' + err.message }); else done(buf); });
}

parentPort.on('message', (m) => {
  try {
    if (m.t === 'congestion') {
      const next = new Set(m.civs || []);
      // a connection that drained gets a full catch-up on the next snapshot round
      for (const id of congested) {
        if (next.has(id)) continue;
        if (id >= 0 && game.civs[id]) { game.civs[id].catchUp = true; deltas.get(id)?.resyncEcon?.(); probe?.catchUp(); }
        else if (id === -2 && game.observer) { game.observer.catchUp = true; deltas.get(-2)?.resyncEcon?.(); probe?.catchUp(); }
      }
      congested = next; return;
    }
    if (m.t === 'cmd' && m.cmd && m.cmd.c === 'resync') {
      // Pass 4: a keyed-delta client saw a version gap; its next snapshot carries sites, buildings and battlefield whole
      const enc = deltas.get(m.civId), civ = game.civs[m.civId];
      if (enc?.resyncEcon) { enc.resyncEcon(); if (civ) civ.catchUp = true; }
      probe?.resync();
      send(m.civId, { t: 'ack', rid: m.rid, resync: !!enc?.keyed });
      flush();
    } else if (m.t === 'cmd' && m.cmd && m.cmd.c === 'speed') {
      // R6: the sandbox and single-player matches set speed directly; multiplayer goes through {c:'speedVote'}
      const r = setSpeedDirect(game, Number(m.cmd.speed), tickMs);
      if (r.error) send(m.civId, { t: 'ack', rid: m.rid, error: r.error });
      else { paceReset(); send(m.civId, { t: 'ack', rid: m.rid, speed: r.speed }); send(m.civId, { t: 'paused', on: false, speed: r.speed }); }
      flush();
    } else if (m.t === 'cmd' && m.cmd && m.cmd.c === 'speedVote') {
      const r = castVote(game, m.civId, m.cmd, Date.now(), tickMs);
      if (r.error) send(m.civId, { t: 'ack', rid: m.rid, error: r.error });
      else if (r.result === 'direct') { paceReset(); send(m.civId, { t: 'ack', rid: m.rid, speed: r.speed }); send(m.civId, { t: 'paused', on: false, speed: r.speed }); }
      else { send(m.civId, { t: 'ack', rid: m.rid, vote: r.result }); announceVote(r); }
      flush();
    } else if (m.t === 'cmd' && m.cmd && m.cmd.c === 'pause') {
      // single-player matches (one human against the AI) and the sandbox can be paused
      const humans = game.civs.filter((c) => c.human).length;
      if (humans !== 1 && !game.sandbox) send(m.civId, { t: 'ack', rid: m.rid, error: 'Only single-player matches can be paused' });
      else {
        const pause = m.cmd.on == null ? !!game.speed : !!m.cmd.on;
        if (game.speed) game.resumeSpeed = game.speed;
        game.speed = pause ? 0 : game.resumeSpeed || 1;
        send(m.civId, { t: 'ack', rid: m.rid, paused: !game.speed });
        paceReset(); send(m.civId, { t: 'paused', on: !game.speed, speed: game.speed });
      }
      flush();
    } else if (m.t === 'cmd') {
      probe?.command();
      probe?.commandBegin();
      let res;
      try { res = game.command(m.civId, m.cmd || {}); } finally { probe?.commandEnd(); }
      send(m.civId, commandAck(res, m.rid));   // refusals carry their `code` (review S / U)
      flush();
    } else if (m.t === 'connect') {
      const c = game.civs[m.civId]; if (c) c.connected = !!m.on;
      if (!m.on) { geoViewers.delete(m.civId); deltas.delete(m.civId); announceVote(dropVoter(game, m.civId)); flush(); }
    } else if (m.t === 'welcome') {
      const civ = game.civs[m.civId];
      civ.connected = true;
      send(m.civId, { t: 'welcome', match: game.id, ruleset: game.ruleset, speed: game.speed, civId: m.civId, seed: game.seed, defs: game.defs, world: { wrap: globalThis.SE_WRAP, style: game.world.style, map: game.mapId || 'random', dense: game.denseWire?.() }, sandbox: !!game.sandbox, canPause: game.civs.filter((c) => c.human).length === 1 || !!game.sandbox, canSpeed: speedMode(game) === 'direct', speedVote: speedMode(game) === 'vote', paused: !game.speed,
        civs: game.civs.map((c) => ({ id: c.id, team: c.team, name: c.name, color: c.color, human: c.human, leader: c.leader, rebel: c.isRebel, ai: !c.human && !c.isRebel ? { difficulty: c.difficulty, personality: c.personality, profile: c.diffProfile, advantages: aiProfile(c).adv } : undefined })), start: game.world.starts[m.civId], time: game.time });
      // Pass 4: keyed deltas for sites / buildings / battlefield when the client negotiated them (server/delta.js)
      if (m.caps?.includes('udelta')) deltas.set(m.civId, newEncoder(m.caps)); else deltas.delete(m.civId);
      for (const [, msg] of game.snapshots(m.civId)) sendSnap(m.civId, msg);
      if (m.caps?.includes('geo')) { geoViewers.set(m.civId, geoViewer()); sendGeo(m.civId, true); } else geoViewers.delete(m.civId);
      for (const e of game.log.slice(-15)) if (e.kind) send(m.civId, { t: 'note', time: Math.round(e.time), text: '(earlier) ' + e.text, kind: 'history', quiet: true, level: 'info' });
      flush();
    } else if (m.t === 'observe') {
      game.setObserver({ connected: m.on });
      if (!m.on) { geoViewers.delete(-2); deltas.delete(-2); }
    } else if (m.t === 'obsWelcome') {
      const o = game.setObserver({ connected: true });
      send(-2, { t: 'welcome', match: game.id, ruleset: game.ruleset, speed: game.speed, civId: o.follow, spectator: true, seed: game.seed, defs: game.defs, world: { wrap: globalThis.SE_WRAP, style: game.world.style, map: game.mapId || 'random', dense: game.denseWire?.() },
        civs: game.civs.map((c) => ({ id: c.id, team: c.team, name: c.name, color: c.color, human: c.human, leader: c.leader, rebel: c.isRebel, ai: !c.human && !c.isRebel ? { difficulty: c.difficulty, personality: c.personality, profile: c.diffProfile, advantages: aiProfile(c).adv } : undefined })), start: game.world.starts[o.follow], time: game.time });
      // B5 (2026-11-19): spectators get the same per-viewer deltas as players. They share one channel (-2), so the
      // manager passes `shared`: the capabilities every connected spectator negotiated (an old client among them keeps
      // everyone on whole snapshots). A new encoder starts with a full set, which the others simply apply.
      const caps = m.shared || m.caps;
      if (caps?.includes('udelta')) deltas.set(-2, newEncoder(caps)); else deltas.delete(-2);
      sendSnap(-2, game.observerSnapshot(true));
      // spectators share one channel: a full sync for a newcomer is harmless to the others
      if (m.caps?.includes('geo')) { if (!geoViewers.has(-2)) geoViewers.set(-2, geoViewer()); sendGeo(-2, true); }
      for (const e of game.log.slice(-15)) if (e.kind) send(-2, { t: 'note', time: Math.round(e.time), text: '(earlier) ' + e.text, kind: 'history', quiet: true, level: 'info' });
      flush();
    } else if (m.t === 'obsCmd') {
      // spectators can only change what they watch and how fast the match runs
      const c = m.cmd || {};
      let error;
      if (c.c === 'follow' || c.c === 'fog') {
        const before = game.observer?.follow;
        const o = game.setObserver(c.c === 'follow' ? { follow: c.civ } : { fog: c.on });
        send(-2, { t: 'ack', rid: m.rid, follow: o.follow, fog: o.fog });
        if (c.c === 'fog' || before !== o.follow) {
          // the client clears its view on a reset: start a fresh encoder so this message is a full set
          const enc = deltas.get(-2); if (enc) deltas.set(-2, deltaEncoder(50, 10, { keyed: enc.keyed }));
          sendSnap(-2, { ...game.observerSnapshot(true), reset: 1 }); sendGeo(-2, true);
        }
      } else if (c.c === 'resync') {
        // a keyed-delta spectator saw a version gap: the next snapshot carries sites, buildings and battlefield whole
        const enc = deltas.get(-2);
        if (enc?.resyncEcon) { enc.resyncEcon(); if (game.observer) game.observer.catchUp = true; }
        probe?.resync();
        send(-2, { t: 'ack', rid: m.rid, resync: !!enc?.keyed });
      } else if (c.c === 'aiDiag') {
        // the developer inspector: a spectator may read any AI's full plan and decision record
        const civ = game.civs[c.civ | 0];
        send(-2, { t: 'ack', rid: m.rid, diag: civ?.aiPlan ?? (civ?.ai?.brain ? civ.ai.brain.report(true) : null) });
      } else if (c.c === 'speed') {
        if (!OBSERVE) error = 'Speed control is only available when spectating an AI match';
        else {
          // B7 (2026-11-19): the same sustainability check as players (speedVote.js): a faster speed than the measured
          // tick cost allows is refused instead of being shown while the match runs far slower
          const speed = [0, 1, 2, 4, 8].includes(+c.speed) ? +c.speed : 1;
          const slow = speed > (game.speed || 1) ? sustainable(speed, tickMs) : null;
          if (slow) error = slow;
          else { game.speed = speed; paceReset(); send(-2, { t: 'ack', rid: m.rid, speed: game.speed }); send(-2, { t: 'paused', on: !game.speed, speed: game.speed }); }
        }
      } else error = 'Spectators cannot give orders';
      if (error) send(-2, { t: 'ack', rid: m.rid, error });
      flush();
    } else if (m.t === 'save') {
      const time = game.time; saving = false; saveAsync((buf) => post({ t: 'saved', buf, time, rid: m.rid }));
    } else if (m.t === 'stop') {
      clearInterval(timer);
      post({ t: 'stopped' });
    }
  } catch (e) {
    post({ t: 'error', error: String(e && e.stack || e) });
  }
});
post({ t: 'ready', time: game.time, mapSize: workerData.mapSize });
