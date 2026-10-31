// One match = one worker thread. The simulation, fog-of-war filtering and JSON encoding all run
// here, so a heavy battle in one match cannot stall the event loop of another.
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

globalThis.SE_MAP_SIZE = workerData.mapSize;
globalThis.SE_WRAP = workerData.wrap !== false;   // bounded only for matches saved before wrapping existed
const { Game } = await import('./sim/game.js');
const { GAME_DEFS, TICK_HZ, aiProfile } = await import('./sim/constants.js');
const { serializeGame, restoreGame } = await import('./sim/persist.js');

let game;
if (workerData.restore) {
  game = restoreGame(JSON.parse(zlib.gunzipSync(Buffer.from(workerData.restore)).toString()));
} else {
  game = new Game({ id: workerData.id, seed: workerData.seed, slots: workerData.slots, rebels: workerData.rebels !== false, cataclysm: workerData.cataclysm, style: workerData.style });
  if (workerData.sandbox) { const { makeSandbox } = await import('./sim/sandbox.js'); makeSandbox(game); }
}
// live matches let AI planning slide a tick when a tick runs long (tests and replays stay strict)
game.adaptive = process.env.SE_ADAPTIVE !== '0';
if (workerData.sandbox) { game.sandbox = true; game.sandboxReveal = true; for (const c of game.civs) if (!c.human) c.ai = null; }
const post = (m) => parentPort.postMessage(m);
const out = [];
const send = (civId, msg) => out.push([civId, JSON.stringify(msg)]);
function flush() {
  for (const [civId, msg] of game.outbox) send(civId, msg);
  game.outbox.length = 0;
  if (out.length) { post({ t: 'out', msgs: out.splice(0) }); }
}

let tickMs = 0, maxMs = 0, ticks = 0, overSent = false, frames = 0;
const AUTOSAVE_S = +(process.env.AUTOSAVE_SECONDS || 60);
let nextSave = game.time + AUTOSAVE_S;
// Spectated AI-only matches can run faster than real time (or pause) for testing.
const OBSERVE = !!workerData.observe;
game.speed = 1;
const timer = setInterval(() => {
  try {
    const t0 = performance.now();
    // at higher speeds, run several ticks per interval but never let one interval overrun
    let n = 0;
    while (n < game.speed && (n === 0 || performance.now() - t0 < 70) && !game.over) { game.tick(); n++; }
    if (!game.speed) { frames++; if (frames % 5 === 0 && game.observer?.connected) send(-2, game.observerSnapshot(false, frames % 10 === 0)); flush(); return; }
    frames++;
    // 5 Hz snapshots, economy every second, regardless of how many ticks ran
    if (frames % 2 === 0) for (const [civId, msg] of game.snapshots(null, frames % 10 === 0)) send(civId, msg);
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
    if (m.t === 'cmd') {
      const res = game.command(m.civId, m.cmd || {});
      if (res && res.reply) send(m.civId, { ...res.reply, rid: m.rid });
      else send(m.civId, { t: 'ack', rid: m.rid, error: res ? res.error : undefined });
      flush();
    } else if (m.t === 'connect') {
      const c = game.civs[m.civId]; if (c) c.connected = !!m.on;
    } else if (m.t === 'welcome') {
      const civ = game.civs[m.civId];
      civ.connected = true;
      send(m.civId, { t: 'welcome', match: game.id, civId: m.civId, seed: game.seed, defs: GAME_DEFS, world: { wrap: globalThis.SE_WRAP, style: game.world.style, cataclysm: !!game.cataclysm }, sandbox: !!game.sandbox,
        civs: game.civs.map((c) => ({ id: c.id, name: c.name, color: c.color, human: c.human, leader: c.leader, rebel: c.isRebel, ai: !c.human && !c.isRebel ? { difficulty: c.difficulty, personality: c.personality, profile: c.diffProfile, advantages: aiProfile(c).adv } : undefined })), start: game.world.starts[m.civId], time: game.time });
      for (const [, msg] of game.snapshots(m.civId)) send(m.civId, msg);
      for (const e of game.log.slice(-15)) if (e.kind) send(m.civId, { t: 'note', time: Math.round(e.time), text: '(earlier) ' + e.text, kind: 'history', quiet: true, level: 'info' });
      flush();
    } else if (m.t === 'observe') {
      game.setObserver({ connected: m.on });
    } else if (m.t === 'obsWelcome') {
      const o = game.setObserver({ connected: true });
      send(-2, { t: 'welcome', match: game.id, civId: o.follow, spectator: true, seed: game.seed, defs: GAME_DEFS, world: { wrap: globalThis.SE_WRAP, style: game.world.style, cataclysm: !!game.cataclysm },
        civs: game.civs.map((c) => ({ id: c.id, name: c.name, color: c.color, human: c.human, leader: c.leader, rebel: c.isRebel, ai: !c.human && !c.isRebel ? { difficulty: c.difficulty, personality: c.personality, profile: c.diffProfile, advantages: aiProfile(c).adv } : undefined })), start: game.world.starts[o.follow], time: game.time });
      send(-2, game.observerSnapshot(true));
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
        if (c.c === 'fog' || before !== o.follow) send(-2, { ...game.observerSnapshot(true), reset: 1 });
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
