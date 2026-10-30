// One match = one worker thread. The simulation, fog-of-war filtering and JSON encoding all run
// here, so a heavy battle in one match cannot stall the event loop of another.
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

globalThis.SE_MAP_SIZE = workerData.mapSize;
const { Game } = await import('./sim/game.js');
const { GAME_DEFS, TICK_HZ } = await import('./sim/constants.js');
const { serializeGame, restoreGame } = await import('./sim/persist.js');

let game;
if (workerData.restore) {
  game = restoreGame(JSON.parse(zlib.gunzipSync(Buffer.from(workerData.restore)).toString()));
} else {
  game = new Game({ id: workerData.id, seed: workerData.seed, slots: workerData.slots, rebels: workerData.rebels !== false });
}
const post = (m) => parentPort.postMessage(m);
const out = [];
const send = (civId, msg) => out.push([civId, JSON.stringify(msg)]);
function flush() {
  for (const [civId, msg] of game.outbox) send(civId, msg);
  game.outbox.length = 0;
  if (out.length) { post({ t: 'out', msgs: out.splice(0) }); }
}

let tickMs = 0, maxMs = 0, ticks = 0, overSent = false;
const AUTOSAVE_S = +(process.env.AUTOSAVE_SECONDS || 60);
let nextSave = game.time + AUTOSAVE_S;
const timer = setInterval(() => {
  try {
    const t0 = performance.now();
    game.tick();
    if (game.tickN % 2 === 0) for (const [civId, msg] of game.snapshots()) send(civId, msg);
    flush();
    const dt = performance.now() - t0;
    tickMs = tickMs * 0.98 + dt * 0.02; maxMs = Math.max(maxMs, dt); ticks++;
    if (game.time >= nextSave) { nextSave = game.time + AUTOSAVE_S; post({ t: 'autosave', buf: save(), time: game.time }); }
    if (game.over && !overSent) { overSent = true; post({ t: 'over', winner: game.winner, buf: save() }); }
  } catch (e) {
    post({ t: 'error', error: String(e && e.stack || e) });
  }
}, 1000 / TICK_HZ);
setInterval(() => { post({ t: 'stats', avg: +tickMs.toFixed(2), max: +maxMs.toFixed(1), time: Math.round(game.time), units: game.units.size, civs: game.civs.length }); maxMs = 0; }, 5000).unref();

function save() { return zlib.gzipSync(JSON.stringify(serializeGame(game))); }

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
      send(m.civId, { t: 'welcome', match: game.id, civId: m.civId, seed: game.seed, defs: GAME_DEFS,
        civs: game.civs.map((c) => ({ id: c.id, name: c.name, color: c.color, human: c.human, leader: c.leader, rebel: c.isRebel })), start: game.world.starts[m.civId], time: game.time });
      for (const [, msg] of game.snapshots(m.civId)) send(m.civId, msg);
      for (const e of game.log.slice(-15)) if (e.kind) send(m.civId, { t: 'note', time: Math.round(e.time), text: '(earlier) ' + e.text, kind: 'history', quiet: true, level: 'info' });
      flush();
    } else if (m.t === 'save') {
      post({ t: 'saved', buf: save(), time: game.time, rid: m.rid });
    } else if (m.t === 'stop') {
      clearInterval(timer);
      post({ t: 'stopped' });
    }
  } catch (e) {
    post({ t: 'error', error: String(e && e.stack || e) });
  }
});
post({ t: 'ready', time: game.time, mapSize: workerData.mapSize });
