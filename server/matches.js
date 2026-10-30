// Match lobby & lifecycle. Each running match ticks at 10 Hz on the server and
// streams per-civilization, fog-of-war-filtered snapshots at 5 Hz.
import crypto from 'node:crypto';
import { Game } from './sim/game.js';
import { GAME_DEFS, TICK_HZ } from './sim/constants.js';

const MAX_MATCHES = +(process.env.MAX_MATCHES || 24);
const IDLE_MS = 5 * 60 * 1000;

export class MatchManager {
  constructor(log = console) {
    this.matches = new Map();
    this.log = log;
    this.janitor = setInterval(() => this.cleanup(), 30_000);
    this.janitor.unref?.();
  }

  list() {
    return [...this.matches.values()].map((m) => ({
      id: m.id, name: m.name, status: m.status, mode: m.mode, created: m.created,
      slots: m.slots.map((s) => ({ name: s.name, human: s.human, taken: !!s.token, connected: !!s.ws })),
      time: m.game ? Math.round(m.game.time) : 0,
    }));
  }

  create(opts) {
    if (this.matches.size >= MAX_MATCHES) throw new Error('Server is full, try again shortly');
    const id = crypto.randomBytes(3).toString('hex');
    const humans = Math.max(1, Math.min(4, opts.mode === 'pvp' ? (opts.humans | 0) || 2 : 1));
    const ais = Math.max(opts.mode === 'pvp' ? 0 : 1, Math.min(4 - humans, opts.ais ?? 1));
    const personalities = ['warlord', 'merchant', 'builder'];
    const slots = [];
    for (let i = 0; i < humans; i++) slots.push({ human: true, name: i === 0 ? String(opts.name || 'Player').slice(0, 24) : 'Open seat', token: null, ws: null });
    for (let i = 0; i < ais; i++) slots.push({ human: false, name: 'AI', personality: opts.aiPersonality && opts.aiPersonality !== 'random' ? opts.aiPersonality : personalities[(Math.random() * 3) | 0] });
    const m = { id, name: String(opts.title || `${opts.name || 'Player'}'s match`).slice(0, 40), mode: opts.mode === 'pvp' ? 'pvp' : 'ai', status: 'lobby', created: Date.now(), lastActive: Date.now(),
      seed: Number.isFinite(+opts.seed) && opts.seed !== '' && opts.seed != null ? +opts.seed | 0 : (Math.random() * 2 ** 31) | 0, slots, game: null, interval: null };
    this.matches.set(id, m);
    this.log.info?.(`match ${id} created (${humans} humans, ${ais} AI)`);
    return m;
  }

  seat(m, name) {
    const slot = m.slots.find((s) => s.human && !s.token);
    if (!slot) throw new Error('Match is full');
    slot.token = crypto.randomBytes(16).toString('hex');
    if (name) slot.name = String(name).slice(0, 24);
    return slot;
  }

  start(m) {
    if (m.status !== 'lobby') return;
    // unfilled human seats become AI
    for (const s of m.slots) if (s.human && !s.token) { s.human = false; s.name = 'AI'; s.personality = 'builder'; }
    const game = new Game({ id: m.id, seed: m.seed, slots: m.slots.map((s) => ({ human: s.human, name: undefined, leader: s.name, personality: s.personality })) });
    m.game = game; m.status = 'running';
    m.slots.forEach((s, i) => { s.civId = i; game.civs[i].token = s.token; });
    let tick = 0;
    m.interval = setInterval(() => {
      try {
        const t0 = performance.now();
        game.tick(); tick++;
        this.flushOutbox(m);
        if (tick % 2 === 0) for (const [civId, msg] of game.snapshots()) this.sendCiv(m, civId, msg);
        const dt = performance.now() - t0;
        if (dt > 60) this.log.warn?.(`match ${m.id} slow tick ${dt.toFixed(1)}ms`);
        if (game.over && m.status !== 'over') { m.status = 'over'; m.overAt = Date.now(); this.flushOutbox(m); }
        if (m.status === 'over' && Date.now() - m.overAt > 2000) { clearInterval(m.interval); m.interval = null; }
      } catch (e) {
        this.log.error?.(`match ${m.id} tick error`, e);
      }
    }, 1000 / TICK_HZ);
    for (const s of m.slots) if (s.ws) this.welcome(m, s);
    this.log.info?.(`match ${m.id} started seed=${m.seed}`);
  }

  welcome(m, slot) {
    const g = m.game;
    const civ = g.civs[slot.civId];
    civ.connected = true;
    this.send(slot.ws, { t: 'welcome', match: m.id, civId: slot.civId, seed: m.seed, defs: GAME_DEFS,
      civs: g.civs.map((c) => ({ id: c.id, name: c.name, color: c.color, human: c.human, leader: c.leader })), start: g.world.starts[slot.civId], time: g.time });
    for (const [, msg] of g.snapshots(slot.civId)) this.send(slot.ws, msg);
    for (const e of g.log.slice(-15)) if (e.kind) this.send(slot.ws, { t: 'note', time: Math.round(e.time), text: '(earlier) ' + e.text, kind: 'history', quiet: true });
  }

  flushOutbox(m) {
    const g = m.game;
    for (const [civId, msg] of g.outbox) {
      if (civId < 0) for (const s of m.slots) { if (s.ws) this.send(s.ws, msg); }
      else this.sendCiv(m, civId, msg);
    }
    g.outbox.length = 0;
  }

  sendCiv(m, civId, msg) { const s = m.slots[civId]; if (s && s.ws) this.send(s.ws, msg); }
  send(ws, msg) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ } } }
  roomUpdate(m) { for (const s of m.slots) if (s.ws) this.send(s.ws, { t: 'room', match: m.id, name: m.name, status: m.status, slots: m.slots.map((x) => ({ name: x.name, human: x.human, taken: !!x.token })) }); }

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
        if (match.game && slot.civId != null) match.game.civs[slot.civId].connected = false;
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
        const slot = this.seat(m, msg.name);
        this.bind(ws, m, slot);
        if (m.mode === 'ai') this.start(m); else this.roomUpdate(m);
        return;
      }
      case 'join': {
        const m = this.matches.get(msg.match); if (!m) throw new Error('No such match');
        if (m.status !== 'lobby') throw new Error('Match already started');
        const slot = this.seat(m, msg.name);
        this.bind(ws, m, slot);
        this.roomUpdate(m);
        if (m.slots.every((s) => !s.human || s.token)) this.start(m);
        return;
      }
      case 'rejoin': {
        const m = this.matches.get(msg.match); if (!m) throw new Error('Match no longer exists');
        const slot = m.slots.find((s) => s.token && s.token === msg.token); if (!slot) throw new Error('Invalid session');
        if (slot.ws && slot.ws !== ws) { try { slot.ws.close(4000, 'replaced'); } catch { /* ignore */ } }
        this.bind(ws, m, slot);
        if (m.status === 'lobby') this.roomUpdate(m); else this.welcome(m, slot);
        return;
      }
      case 'start': { if (ctx.match && ctx.match.status === 'lobby' && ctx.match.slots[0] === ctx.slot) this.start(ctx.match); return; }
      case 'cmd': {
        const m = ctx.match; if (!m || !m.game || ctx.slot.civId == null) throw new Error('Not in a running match');
        m.lastActive = Date.now();
        const res = m.game.command(ctx.slot.civId, msg.cmd || {});
        if (res && res.reply) this.send(ws, { ...res.reply, rid: msg.rid });
        else this.send(ws, { t: 'ack', rid: msg.rid, error: res ? res.error : undefined });
        this.flushOutbox(m);
        return;
      }
      default: throw new Error('Unknown message');
    }
  }

  bind(ws, m, slot) {
    slot.ws = ws; ws.ctx = { match: m, slot };
    m.lastActive = Date.now();
    this.send(ws, { t: 'joined', match: m.id, token: slot.token, status: m.status, mode: m.mode });
  }

  cleanup() {
    const now = Date.now();
    for (const m of this.matches.values()) {
      const anyone = m.slots.some((s) => s.ws);
      const idle = !anyone && now - m.lastActive > IDLE_MS;
      const done = m.status === 'over' && now - (m.overAt || now) > 10 * 60 * 1000;
      if (idle || done) {
        if (m.interval) clearInterval(m.interval);
        this.matches.delete(m.id);
        this.log.info?.(`match ${m.id} removed (${done ? 'finished' : 'idle'})`);
      }
    }
  }

  stats() {
    return { matches: this.matches.size, running: [...this.matches.values()].filter((m) => m.status === 'running').length, players: [...this.matches.values()].reduce((s, m) => s + m.slots.filter((x) => x.ws).length, 0) };
  }

  shutdown() { for (const m of this.matches.values()) if (m.interval) clearInterval(m.interval); clearInterval(this.janitor); }
}
