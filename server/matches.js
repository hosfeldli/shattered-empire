// Lobby, matchmaking and match lifecycle. Each running match lives in its own worker thread;
// this process only routes messages between WebSocket clients and match workers, and persists
// match snapshots so games survive deploys, restarts and worker crashes.
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';

const MAX_MATCHES = +(process.env.MAX_MATCHES || Math.max(4, os.cpus().length * 4));
const MAX_CIVS = 12;
const IDLE_MS = 10 * 60 * 1000;
const SIZES = { small: 128, medium: 192, large: 256 };
const autoSize = (n) => (n <= 4 ? 128 : n <= 8 ? 192 : 256);
// Admission control (inside this process: no change to how many instances run). A new match is
// refused, with a clear message, when the running matches already use most of the CPU time the
// tick loops have, or when free memory would not hold another worker of that map size.
const ADMIT_CPU = +(process.env.ADMIT_CPU_SHARE || 0.85);
const WORKER_MB = { 128: 140, 192: 260, 256: 420 };

// the three systems with the highest p95 in a match (for /api/health and the logs)
const slowest = (sys = {}) => Object.entries(sys).filter(([k]) => k !== 'tick').sort((a, b) => b[1].p95 - a[1].p95).slice(0, 3).map(([k, v]) => ({ system: k, p50: v.p50, p95: v.p95, p99: v.p99 }));

export class MatchManager {
  constructor(log = console, store = null) {
    this.matches = new Map();
    this.log = log;
    this.store = store;
    this.janitor = setInterval(() => this.cleanup(), 30_000);
    this.janitor.unref?.();
  }

  list() {
    return [...this.matches.values()].map((m) => ({
      id: m.id, name: m.name, status: m.status, mode: m.mode, created: m.created, mapSize: m.mapSize, watchers: (m.watchers || []).filter((w) => w.ws).length,
      slots: m.slots.map((s) => ({ name: s.name, human: s.human, taken: !!s.token, connected: !!s.ws })),
      time: m.stats?.time || 0,
    }));
  }

  create(opts) {
    if (this.matches.size >= MAX_MATCHES) throw new Error('Server is full, try again shortly');
    const why = this.admit(SIZES[opts.mapSize] || 192);
    if (why) throw new Error(why);
    const id = crypto.randomBytes(3).toString('hex');
    const pvp = opts.mode === 'pvp';
    const observe = opts.mode === 'observe';   // AI-only match watched by spectators (no fog, speed control)
    const sandbox = opts.mode === 'sandbox';   // developer combat sandbox: one player, one passive opponent
    const humans = observe ? 0 : Math.max(1, Math.min(MAX_CIVS, pvp ? (opts.humans | 0) || 2 : 1));
    const ais = sandbox ? 1 : observe ? Math.max(2, Math.min(MAX_CIVS, opts.ais ?? 4)) : Math.max(pvp ? 0 : 1, Math.min(MAX_CIVS - humans, opts.ais ?? 1));
    const personalities = ['warlord', 'merchant', 'builder'];
    const slots = [];
    for (let i = 0; i < humans; i++) slots.push({ human: true, name: i === 0 ? String(opts.name || 'Player').slice(0, 24) : 'Open seat', token: null, ws: null });
    for (let i = 0; i < ais; i++) slots.push({ human: false, name: 'AI', personality: opts.aiPersonality && opts.aiPersonality !== 'random' ? opts.aiPersonality : personalities[(i + ((Math.random() * 3) | 0)) % 3], difficulty: ['easy', 'normal', 'hard', 'brutal'].includes(opts.difficulty) ? opts.difficulty : 'normal' });
    const mapSize = SIZES[opts.mapSize] || autoSize(slots.length);
    const m = { id, name: String(opts.title || (observe ? `AI exhibition (${ais} empires)` : `${opts.name || 'Player'}'s match`)).slice(0, 40), mode: pvp ? 'pvp' : observe ? 'observe' : sandbox ? 'sandbox' : 'ai', status: 'lobby', watchers: [], created: Date.now(), lastActive: Date.now(),
      seed: Number.isFinite(+opts.seed) && opts.seed !== '' && opts.seed != null ? +opts.seed | 0 : (Math.random() * 2 ** 31) | 0, slots, mapSize: sandbox ? 128 : mapSize, rebels: sandbox ? false : opts.rebels !== false, worker: null, stats: null,
      wrap: true, style: ['continents', 'pangaea', 'archipelago', 'inlandSea'].includes(opts.style) ? opts.style : null,
      cataclysm: opts.cataclysm && !sandbox ? { on: true, freq: { rare: 0.5, normal: 1, frequent: 2 }[opts.cataclysmFreq] || 1, sev: 1 } : null };
    this.matches.set(id, m);
    this.log.info?.(`match ${id} created (${humans} humans, ${ais} AI, ${mapSize}x${mapSize})`);
    return m;
  }

  // spectator seat: watches the whole map, cannot give orders
  watch(m, name) {
    if ((m.watchers || (m.watchers = [])).length >= 8) throw new Error('Too many spectators');
    const w = { token: crypto.randomBytes(16).toString('hex'), ws: null, name: String(name || 'Spectator').slice(0, 24), spectator: true };
    m.watchers.push(w);
    return w;
  }

  seat(m, name) {
    const slot = m.slots.find((s) => s.human && !s.token);
    if (!slot) throw new Error('Match is full');
    slot.token = crypto.randomBytes(16).toString('hex');
    if (name) slot.name = String(name).slice(0, 24);
    return slot;
  }

  meta(m) { return { id: m.id, name: m.name, mode: m.mode, created: m.created, seed: m.seed, mapSize: m.mapSize, rebels: m.rebels, wrap: m.wrap !== false, style: m.style, cataclysm: m.cataclysm, slots: m.slots.map((s) => ({ human: s.human, name: s.name, personality: s.personality, difficulty: s.difficulty, token: s.token, civId: s.civId })), watchers: (m.watchers || []).map((w) => ({ token: w.token, name: w.name })) }; }

  start(m, restoreBuf = null) {
    if (m.status === 'running' && m.worker) return;
    if (!restoreBuf) for (const s of m.slots) if (s.human && !s.token) { s.human = false; s.name = 'AI'; s.personality = 'builder'; }
    m.slots.forEach((s, i) => { s.civId = i; });
    m.status = 'running';
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { id: m.id, seed: m.seed, mapSize: m.mapSize, rebels: m.rebels, restore: restoreBuf, observe: m.mode === 'observe', wrap: m.wrap !== false, style: m.style, cataclysm: m.cataclysm, sandbox: m.mode === 'sandbox',
        slots: m.slots.map((s) => ({ human: s.human, name: undefined, leader: s.name, personality: s.personality, difficulty: s.difficulty })) },
      resourceLimits: { maxOldGenerationSizeMb: m.mapSize >= 256 ? 1024 : 512 },
    });
    m.worker = worker; m.ready = false; m.pending = [];
    worker.on('message', (msg) => this.onWorker(m, msg));
    worker.on('error', (e) => this.log.error?.(`match ${m.id} worker error`, e));
    worker.on('exit', (code) => {
      if (m.worker !== worker) return;
      m.worker = null;
      if (m.status === 'running' && !this.stopping) {
        this.log.warn?.(`match ${m.id} worker exited (${code}); recovering from last snapshot`);
        this.recover(m);
      }
    });
    this.log.info?.(`match ${m.id} ${restoreBuf ? 'restored' : 'started'} seed=${m.seed} size=${m.mapSize}`);
  }

  async recover(m) {
    try {
      const buf = m.lastSnapshot || (this.store && (await this.store.load(m.id)));
      if (!buf) throw new Error('no snapshot');
      const meta = JSON.parse(zlib.gunzipSync(buf).toString()).meta;
      void meta;
      this.start(m, this.gameBuf(buf));
    } catch (e) {
      this.log.error?.(`match ${m.id} could not be recovered`, e);
      m.status = 'over';
      for (const s of [...m.slots, ...(m.watchers || [])]) if (s.ws) this.send(s.ws, { t: 'error', error: 'This match could not be recovered after a server fault.' });
    }
  }

  // snapshot file = { meta, game } gzipped; the worker only needs the game part
  pack(m, gameBuf) { return zlib.gzipSync(JSON.stringify({ meta: this.meta(m), game: JSON.parse(zlib.gunzipSync(gameBuf).toString()) })); }
  gameBuf(packed) { return zlib.gzipSync(JSON.stringify(JSON.parse(zlib.gunzipSync(packed).toString()).game)); }

  async persist(m, gameBuf) {
    const packed = this.pack(m, Buffer.from(gameBuf));
    m.lastSnapshot = packed;
    if (this.store) try { await this.store.save(m.id, packed); m.savedAt = Date.now(); } catch (e) { this.log.warn?.(`snapshot ${m.id} failed: ${e.message}`); }
  }

  onWorker(m, msg) {
    switch (msg.t) {
      case 'ready':
        m.ready = true;
        for (const s of m.slots) if (s.ws) this.welcome(m, s);
        for (const w of m.watchers || []) if (w.ws) this.welcome(m, w);
        for (const p of m.pending.splice(0)) m.worker.postMessage(p);
        break;
      case 'out':
        for (const [civId, str] of msg.msgs) {
          if (civId === -2) { for (const w of m.watchers || []) if (w.ws && w.ws.readyState === 1) w.ws.send(str); continue; }
          if (civId < 0) { for (const s of [...m.slots, ...(m.watchers || [])]) if (s.ws && s.ws.readyState === 1) s.ws.send(str); }
          else { const s = m.slots[civId]; if (s && s.ws && s.ws.readyState === 1) s.ws.send(str); }
        }
        break;
      case 'stats': m.stats = msg; if (msg.avg > 50) this.log.warn?.(`match ${m.id} avg tick ${msg.avg}ms (max ${msg.max}ms); slowest: ${slowest(msg.systems).map((x) => `${x.system} p95 ${x.p95}ms`).join(', ')}`); break;
      case 'autosave': this.persist(m, msg.buf); break;
      case 'saved': this.persist(m, msg.buf).then(() => { const r = m.saveWaiters?.shift(); if (r) r(); }); break;
      case 'over': m.status = 'over'; m.overAt = Date.now(); this.persist(m, msg.buf); setTimeout(() => this.stopWorker(m), 5000); break;
      case 'error': this.log.error?.(`match ${m.id} sim error`, msg.error); break;
      default: break;
    }
  }

  toWorker(m, msg) { if (!m.worker) return; if (m.ready) m.worker.postMessage(msg); else m.pending.push(msg); }
  welcome(m, slot) { this.toWorker(m, slot.spectator ? { t: 'obsWelcome' } : { t: 'welcome', civId: slot.civId }); }
  send(ws, msg) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch { /* closing */ } } }
  roomUpdate(m) { for (const s of m.slots) if (s.ws) this.send(s.ws, { t: 'room', match: m.id, name: m.name, status: m.status, mapSize: m.mapSize, slots: m.slots.map((x) => ({ name: x.name, human: x.human, taken: !!x.token })) }); }

  attach(ws) {
    ws.ctx = { match: null, slot: null };
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      try { this.handle(ws, msg); } catch (e) { this.send(ws, { t: 'error', error: e.message, rid: msg.rid }); }
    });
    ws.on('close', () => {
      const { match, slot } = ws.ctx;
      if (match && slot && slot.ws === ws) {
        slot.ws = null;
        if (slot.spectator) { if (!match.watchers.some((w) => w.ws)) this.toWorker(match, { t: 'observe', on: false }); }
        else if (slot.civId != null) this.toWorker(match, { t: 'connect', civId: slot.civId, on: false });
        match.lastActive = Date.now();
        if (match.status === 'lobby') this.roomUpdate(match);
      }
    });
  }

  handle(ws, msg) {
    const ctx = ws.ctx;
    switch (msg.t) {
      case 'ping': return this.send(ws, { t: 'pong', at: msg.at });
      case 'list': return this.send(ws, { t: 'lobby', matches: this.list() });
      case 'create': {
        const m = this.create(msg);
        const slot = m.mode === 'observe' ? this.watch(m, msg.name) : this.seat(m, msg.name);
        this.bind(ws, m, slot);
        if (m.mode === 'ai' || m.mode === 'observe' || m.mode === 'sandbox') this.start(m); else this.roomUpdate(m);
        return;
      }
      case 'spectate': {
        // watch any running match (no fog, no orders)
        const m = this.matches.get(String(msg.match || '').toLowerCase()); if (!m) throw new Error('No such match');
        if (m.status === 'lobby') throw new Error('Match has not started yet');
        const w = this.watch(m, msg.name);
        this.bind(ws, m, w);
        this.wake(m); this.welcome(m, w);
        return;
      }
      case 'join': {
        const m = this.matches.get(String(msg.match || '').toLowerCase()); if (!m) throw new Error('No such match');
        if (m.status !== 'lobby') throw new Error('Match already started');
        const slot = this.seat(m, msg.name);
        this.bind(ws, m, slot);
        this.roomUpdate(m);
        if (m.slots.every((s) => !s.human || s.token)) this.start(m);
        return;
      }
      case 'rejoin': {
        const m = this.matches.get(msg.match); if (!m) throw new Error('Match no longer exists');
        const slot = [...m.slots, ...(m.watchers || [])].find((s) => s.token && s.token === msg.token); if (!slot) throw new Error('Invalid session');
        if (slot.ws && slot.ws !== ws) { try { slot.ws.close(4000, 'replaced'); } catch { /* ignore */ } }
        this.bind(ws, m, slot);
        if (m.status === 'lobby') this.roomUpdate(m); else { this.wake(m); this.welcome(m, slot); }
        return;
      }
      case 'start': { if (ctx.match && ctx.match.status === 'lobby' && ctx.match.slots[0] === ctx.slot) this.start(ctx.match); return; }
      case 'cmd': {
        const m = ctx.match; if (!m || !m.worker || !ctx.slot || (ctx.slot.civId == null && !ctx.slot.spectator)) throw new Error('Not in a running match');
        m.lastActive = Date.now();
        if (ctx.slot.spectator) this.toWorker(m, { t: 'obsCmd', cmd: msg.cmd || {}, rid: msg.rid });
        else this.toWorker(m, { t: 'cmd', civId: ctx.slot.civId, cmd: msg.cmd || {}, rid: msg.rid });
        return;
      }
      default: throw new Error('Unknown message');
    }
  }

  bind(ws, m, slot) {
    slot.ws = ws; ws.ctx = { match: m, slot };
    m.lastActive = Date.now();
    this.send(ws, { t: 'joined', match: m.id, token: slot.token, status: m.status, mode: m.mode, mapSize: m.mapSize, spectator: !!slot.spectator });
  }

  stopWorker(m) { if (m.worker) { const w = m.worker; m.worker = null; w.terminate(); } }

  cleanup() {
    const now = Date.now();
    for (const m of this.matches.values()) {
      const anyone = m.slots.some((s) => s.ws) || (m.watchers || []).some((w) => w.ws);
      const idle = !anyone && now - m.lastActive > IDLE_MS;
      const done = m.status === 'over' && now - (m.overAt || now) > 10 * 60 * 1000;
      if (idle && m.status === 'running') {
        // park idle matches: save and stop the worker; a player rejoining resumes them
        this.requestSave(m).then(() => { this.stopWorker(m); m.status = 'parked'; this.log.info?.(`match ${m.id} parked`); });
      } else if ((idle && m.status !== 'parked') || done) {
        this.stopWorker(m); this.matches.delete(m.id);
        if (this.store && done) this.store.remove(m.id).catch(() => {});
        this.log.info?.(`match ${m.id} removed (${done ? 'finished' : 'idle'})`);
      }
    }
  }

  requestSave(m, timeoutMs = 6000) {
    if (!m.worker) return Promise.resolve();
    return new Promise((resolve) => {
      (m.saveWaiters = m.saveWaiters || []).push(resolve);
      m.worker.postMessage({ t: 'save' });
      setTimeout(resolve, timeoutMs);
    });
  }

  // Resume every match that was running (or parked) when the previous server instance stopped.
  async restoreAll() {
    if (!this.store) return 0;
    const list = await this.store.list();
    let n = 0;
    for (const { id, updated } of list) {
      if (Date.now() - updated > 24 * 3600 * 1000) { this.store.remove(id).catch(() => {}); continue; }
      try {
        const buf = await this.store.load(id);
        const { meta, game } = JSON.parse(zlib.gunzipSync(buf).toString());
        if (game.over) continue;
        const m = { ...meta, wrap: meta.wrap === true, status: 'parked', lastActive: Date.now(), worker: null, stats: null, lastSnapshot: buf, slots: meta.slots.map((s) => ({ ...s, ws: null })), watchers: (meta.watchers || []).map((w) => ({ ...w, ws: null, spectator: true })) };
        this.matches.set(id, m); n++;
      } catch (e) { this.log.warn?.(`could not restore ${id}: ${e.message}`); }
    }
    this.log.info?.(`restored ${n} saved matches from ${this.store.kind}`);
    return n;
  }

  // parked matches wake up when a player comes back
  wake(m) { if (m.status === 'parked' && m.lastSnapshot) this.start(m, this.gameBuf(m.lastSnapshot)); }

  // load = sum over running matches of (average tick time / tick interval), in CPU cores
  load() {
    let cores = 0, heap = 0;
    for (const m of this.matches.values()) if (m.status === 'running' && m.stats) { cores += (m.stats.avg || 0) / 100; heap += m.stats.heapMb || 0; }
    return { cores: +cores.toFixed(2), capacity: os.cpus().length, heapMb: heap, freeMb: Math.round(os.freemem() / 1048576) };
  }
  admit(mapSize) {
    if (process.env.ADMIT_OFF === '1') return null;
    const l = this.load();
    if (l.cores > l.capacity * ADMIT_CPU) return 'The server is busy running other matches; try again in a minute.';
    if (l.freeMb < (WORKER_MB[mapSize] || 260) * 1.2) return 'The server is short of memory for another match right now; try a smaller map or try again shortly.';
    return null;
  }

  // per-match, per-system tick timings (p50 / p95 / p99 / max, budget overruns, deferrals)
  metrics() { return { load: this.load(), matches: [...this.matches.values()].filter((m) => m.stats).map((m) => ({ id: m.id, status: m.status, avg: m.stats.avg, max: m.stats.max, units: m.stats.units, heapMb: m.stats.heapMb, systems: m.stats.systems || {} })) }; }

  stats() {
    const ms = [...this.matches.values()];
    return { matches: ms.length, running: ms.filter((m) => m.status === 'running').length, parked: ms.filter((m) => m.status === 'parked').length,
      players: ms.reduce((s, m) => s + m.slots.filter((x) => x.ws).length, 0), spectators: ms.reduce((s, m) => s + (m.watchers || []).filter((x) => x.ws).length, 0), maxMatches: MAX_MATCHES, cpus: os.cpus().length,
      ticks: ms.filter((m) => m.stats).map((m) => ({ id: m.id, avg: m.stats.avg, max: m.stats.max, units: m.stats.units, heapMb: m.stats.heapMb, slowest: slowest(m.stats.systems) })), store: this.store?.kind || 'none', load: this.load(),
      memMB: Math.round(process.memoryUsage().rss / 1e6) };
  }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.janitor);
    await Promise.all([...this.matches.values()].filter((m) => m.worker && m.status === 'running').map((m) => this.requestSave(m, 7000)));
    for (const m of this.matches.values()) this.stopWorker(m);
  }
}
