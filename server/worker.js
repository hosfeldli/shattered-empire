// One match = one worker thread. The simulation, fog-of-war filtering and JSON encoding all run
// here, so a heavy battle in one match cannot stall the event loop of another.
import { deltaEncoder } from './delta.js';
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

globalThis.SE_MAP_SIZE = workerData.mapSize;
globalThis.SE_WRAP = workerData.wrap !== false;   // bounded only for matches saved before wrapping existed
const { Game } = await import('./sim/game.js');
const { GAME_DEFS, TICK_HZ, aiProfile } = await import('./sim/constants.js');
const { serializeGame, restoreGame } = await import('./sim/persist.js');
const { geoViewer, geoMessage } = await import('./sim/terrainGeo.js');

let game;
if (workerData.restore) {
  game = restoreGame(JSON.parse(zlib.gunzipSync(Buffer.from(workerData.restore)).toString()));
} else {
  game = new Game({ id: workerData.id, seed: workerData.seed, slots: workerData.slots, rebels: false, style: workerData.style, ruleset: workerData.ruleset });
  if (workerData.sandbox) { const { makeSandbox } = await import('./sim/sandbox.js'); makeSandbox(game); }
}
// live matches let AI planning slide a tick when a tick runs long (tests and replays stay strict)
game.adaptive = process.env.SE_ADAPTIVE !== '0';
if (workerData.sandbox) { game.sandbox = true; game.sandboxReveal = true; for (const c of game.civs) if (!c.human) c.ai = null; }
const post = (m) => parentPort.postMessage(m);
const out = [];
const deltas = new Map();               // civId -> snapshot delta encoder (capability 'udelta')
const sendSnap = (civId, msg) => { const enc = deltas.get(civId); send(civId, enc ? enc(msg) : msg); };
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
  if (out.length) { post({ t: 'out', msgs: out.splice(0) }); }
}

let tickMs = 0, maxMs = 0, ticks = 0, overSent = false, frames = 0;
let congested = new Set();     // civ ids (-2: observers) whose connection is backed up

const AUTOSAVE_S = +(process.env.AUTOSAVE_SECONDS || 60);
let nextSave = game.time + AUTOSAVE_S;
// Spectated AI-only matches can run faster than real time (or pause) for testing.
const OBSERVE = !!workerData.observe;
game.speed = 1;
const timer = setInterval(() => {
  try {
    // A connected observer is a human too: exhibitions continue while watched. Keep the
    // requested speed intact so reconnecting resumes the same match, including a manual pause.
    // The manager later saves and parks the worker after its existing idle timeout.
    if (!game.civs.some((c) => c.human && c.connected) && !game.observer?.connected) return;
    const t0 = performance.now();
    // at higher speeds, run several ticks per interval but never let one interval overrun
    let n = 0;
    while (n < game.speed && (n === 0 || performance.now() - t0 < 70) && !game.over) { game.tick(); n++; }
    if (!game.speed) {
      // paused: keep the view alive (orders given now show up and run when play resumes)
      frames++;
      if (frames % 5 === 0) { for (const [civId, msg] of game.snapshots(null, frames % 10 === 0, congested)) sendSnap(civId, msg); geoStep(); }   // includes the spectator
      flush(); return;
    }
    frames++;
    // 5 Hz snapshots, economy every second, regardless of how many ticks ran
    if (frames % 2 === 0) { for (const [civId, msg] of game.snapshots(null, frames % 10 === 0, congested)) sendSnap(civId, msg); geoStep(); }
    flush();
    const dt = (performance.now() - t0) / n;
    tickMs = tickMs * 0.98 + dt * 0.02; maxMs = Math.max(maxMs, dt); ticks += n;
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
  const json = JSON.stringify(serializeGame(game));
  zlib.gzip(json, { level: 6 }, (err, buf) => { saving = false; if (err) post({ t: 'error', error: 'save failed: ' + err.message }); else done(buf); });
}

parentPort.on('message', (m) => {
  try {
    if (m.t === 'congestion') {
      const next = new Set(m.civs || []);
      // a connection that drained gets a full catch-up on the next snapshot round
      for (const id of congested) if (!next.has(id) && id >= 0 && game.civs[id]) game.civs[id].catchUp = true;
      congested = next; return;
    }
    if (m.t === 'cmd' && m.cmd && m.cmd.c === 'speed') {
      const eligible = game.civs.filter((c) => c.human).length === 1 || !!game.sandbox;
      const requested = Number(m.cmd.speed);
      if (!eligible) send(m.civId, { t: 'ack', rid: m.rid, error: 'Only single-player matches can change speed' });
      else if (![1, 2, 4].includes(requested)) send(m.civId, { t: 'ack', rid: m.rid, error: 'Choose 1×, 2× or 4× speed' });
      else { game.resumeSpeed = requested; game.speed = requested; send(m.civId, { t: 'ack', rid: m.rid, speed: requested }); send(m.civId, { t: 'paused', on: false, speed: requested }); }
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
        send(m.civId, { t: 'paused', on: !game.speed, speed: game.speed });
      }
      flush();
    } else if (m.t === 'cmd') {
      const res = game.command(m.civId, m.cmd || {});
      if (res && res.reply) send(m.civId, { ...res.reply, rid: m.rid });
      else send(m.civId, { t: 'ack', rid: m.rid, error: res ? res.error : undefined });
      flush();
    } else if (m.t === 'connect') {
      const c = game.civs[m.civId]; if (c) c.connected = !!m.on;
      if (!m.on) { geoViewers.delete(m.civId); deltas.delete(m.civId); }
    } else if (m.t === 'welcome') {
      const civ = game.civs[m.civId];
      civ.connected = true;
      send(m.civId, { t: 'welcome', match: game.id, ruleset: game.ruleset, speed: game.speed, civId: m.civId, seed: game.seed, defs: game.defs, world: { wrap: globalThis.SE_WRAP, style: game.world.style }, sandbox: !!game.sandbox, canPause: game.civs.filter((c) => c.human).length === 1 || !!game.sandbox, paused: !game.speed,
        civs: game.civs.map((c) => ({ id: c.id, name: c.name, color: c.color, human: c.human, leader: c.leader, rebel: c.isRebel, ai: !c.human && !c.isRebel ? { difficulty: c.difficulty, personality: c.personality, profile: c.diffProfile, advantages: aiProfile(c).adv } : undefined })), start: game.world.starts[m.civId], time: game.time });
      if (m.caps?.includes('udelta')) deltas.set(m.civId, deltaEncoder()); else deltas.delete(m.civId);
      for (const [, msg] of game.snapshots(m.civId)) sendSnap(m.civId, msg);
      if (m.caps?.includes('geo')) { geoViewers.set(m.civId, geoViewer()); sendGeo(m.civId, true); } else geoViewers.delete(m.civId);
      for (const e of game.log.slice(-15)) if (e.kind) send(m.civId, { t: 'note', time: Math.round(e.time), text: '(earlier) ' + e.text, kind: 'history', quiet: true, level: 'info' });
      flush();
    } else if (m.t === 'observe') {
      game.setObserver({ connected: m.on });
      if (!m.on) geoViewers.delete(-2);
    } else if (m.t === 'obsWelcome') {
      const o = game.setObserver({ connected: true });
      send(-2, { t: 'welcome', match: game.id, ruleset: game.ruleset, speed: game.speed, civId: o.follow, spectator: true, seed: game.seed, defs: game.defs, world: { wrap: globalThis.SE_WRAP, style: game.world.style },
        civs: game.civs.map((c) => ({ id: c.id, name: c.name, color: c.color, human: c.human, leader: c.leader, rebel: c.isRebel, ai: !c.human && !c.isRebel ? { difficulty: c.difficulty, personality: c.personality, profile: c.diffProfile, advantages: aiProfile(c).adv } : undefined })), start: game.world.starts[o.follow], time: game.time });
      send(-2, game.observerSnapshot(true));
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
        if (c.c === 'fog' || before !== o.follow) { send(-2, { ...game.observerSnapshot(true), reset: 1 }); sendGeo(-2, true); }
      } else if (c.c === 'aiDiag') {
        // the developer inspector: a spectator may read any AI's full plan and decision record
        const civ = game.civs[c.civ | 0];
        send(-2, { t: 'ack', rid: m.rid, diag: civ?.ai?.brain ? civ.ai.brain.report(true) : null });
      } else if (c.c === 'speed') {
        if (!OBSERVE) error = 'Speed control is only available when spectating an AI match';
        else { game.speed = [0, 1, 2, 4, 8].includes(+c.speed) ? +c.speed : 1; send(-2, { t: 'ack', rid: m.rid, speed: game.speed }); }
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
