// Thin network layer: every game decision happens on the server.
import { WS_URL } from './config.js';
export class Net {
  constructor(handlers) {
    this.h = handlers; this.rid = 1; this.pending = new Map(); this.ws = null; this.rtt = 0; this.retry = 0; this.session = null; this.closedByUser = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      ws.onopen = () => { this.retry = 0; this.h.onStatus?.('connected'); if (this.session) this.send({ t: 'rejoin', ...this.session }); resolve(); };
      ws.onerror = () => reject(new Error('Could not reach the game server'));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'pong') { this.rtt = Math.round(performance.now() - m.at); return; }
        if (m.rid && this.pending.has(m.rid)) { const p = this.pending.get(m.rid); this.pending.delete(m.rid); p(m); if (m.t === 'ack') return; }
        this.h.onMessage(m);
      };
      ws.onclose = () => {
        this.h.onStatus?.('disconnected');
        if (this.closedByUser) return;
        const wait = Math.min(8000, 500 * 2 ** this.retry++);
        setTimeout(() => this.connect().catch(() => {}), wait);
      };
    });
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  cmd(c) {
    const rid = this.rid++;
    return new Promise((resolve) => {
      this.pending.set(rid, resolve);
      this.send({ t: 'cmd', rid, cmd: c });
      setTimeout(() => { if (this.pending.has(rid)) { this.pending.delete(rid); resolve({ error: 'The server did not answer in time' }); } }, 6000);
    });
  }
  ping() { this.send({ t: 'ping', at: performance.now() }); }
  close() { this.closedByUser = true; this.ws?.close(); }
}
