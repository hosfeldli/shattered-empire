// Server administration over the game's WebSocket: list every match on this server and close any of
// them. Unlocked for one connection by the administrator's player name and PIN, both checked here
// on the server (the client never knows the PIN). Failed attempts are rate-limited per address and
// across the server, because a short numeric PIN is guessable otherwise.
//   ADMIN_NAME  (default Liam6642)  the player name allowed to administer
//   ADMIN_PIN   (default 6642)      the PIN; set it in the service's environment to change it
import crypto from 'node:crypto';

const NAME = process.env.ADMIN_NAME || 'Liam6642';
const digest = (s) => crypto.createHash('sha256').update('se-admin:' + s).digest();
const PIN_HASH = digest(process.env.ADMIN_PIN || '6642');
const WINDOW_MS = 15 * 60 * 1000, PER_ADDR = 5, GLOBAL = 25;

export class Admin {
  constructor(manager, log = console) {
    this.manager = manager; this.log = log;
    this.fails = new Map();      // address -> [times]
    this.global = [];
  }
  recent(list, now) { while (list.length && now - list[0] > WINDOW_MS) list.shift(); return list; }

  // returns { ok } or { error }
  login(ws, name, pin, now = Date.now()) {
    const addr = ws.addr || 'unknown';
    const mine = this.recent(this.fails.get(addr) || [], now), all = this.recent(this.global, now);
    if (mine.length >= PER_ADDR || all.length >= GLOBAL) return { error: 'Too many wrong attempts. Try again in 15 minutes.' };
    const nameOk = String(name || '') === NAME;
    const pinOk = crypto.timingSafeEqual(digest(String(pin || '')), PIN_HASH);
    if (!nameOk || !pinOk) {
      mine.push(now); this.fails.set(addr, mine); all.push(now);
      this.log.warn?.(`admin login refused for "${String(name).slice(0, 24)}" from ${addr}`);
      return { error: 'Wrong name or PIN.' };
    }
    ws.isAdmin = true;
    this.log.info?.(`admin signed in from ${addr}`);
    return { ok: true };
  }

  matches() {
    return [...this.manager.matches.values()].map((m) => ({
      id: m.id, name: m.name, mode: m.mode, status: m.status, created: m.created, mapSize: m.mapSize,
      time: Math.round(m.stats?.time || 0), tickMs: m.stats?.avg ?? null, heapMb: m.stats?.heapMb ?? null,
      players: m.slots.filter((s) => s.human).map((s) => ({ name: s.name || '', connected: !!s.ws })),
      watchers: (m.watchers || []).filter((w) => w.ws).length,
    }));
  }

  // end a match for everyone in it: they are told why and sent back to the menu; its save is deleted
  close(id, reason = 'This match was closed by the server administrator.') {
    const m = this.manager.matches.get(id); if (!m) return false;
    for (const s of [...m.slots, ...(m.watchers || [])]) if (s.ws) { this.manager.send(s.ws, { t: 'closed', match: m.id, reason }); s.ws.ctx = { match: null, slot: null }; s.ws = null; }
    this.manager.stopWorker(m);
    this.manager.matches.delete(m.id);
    this.manager.store?.remove(m.id).catch(() => {});
    this.log.info?.(`admin closed match ${m.id} (${m.name})`);
    return true;
  }

  handle(ws, msg) {
    const send = (o) => this.manager.send(ws, { t: 'admin', rid: msg.rid, ...o });
    if (msg.action === 'login') { const r = this.login(ws, msg.name, msg.pin); return send(r.ok ? { ok: true, matches: this.matches() } : { error: r.error }); }
    if (!ws.isAdmin) return send({ error: 'Sign in as the administrator first.' });
    if (msg.action === 'list') return send({ ok: true, matches: this.matches() });
    if (msg.action === 'close') { const ok = this.close(String(msg.match || '')); return send(ok ? { ok: true, closed: [msg.match], matches: this.matches() } : { error: 'No such match.' }); }
    if (msg.action === 'closeAll') { const ids = [...this.manager.matches.keys()]; for (const id of ids) this.close(id); return send({ ok: true, closed: ids, matches: this.matches() }); }
    return send({ error: 'Unknown admin action.' });
  }
}
