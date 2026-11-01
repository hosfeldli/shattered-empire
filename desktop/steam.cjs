// Steam networking for the desktop edition (Steamworks via steamworks.js, Spacewar test app 480).
//
// Same architecture as online play: one authoritative game server (the host's local server) and the
// unchanged browser client. Steam only replaces the network path:
//   guest client --WebSocket--> guest proxy (127.0.0.1) ==Steam P2P==> host bridge --WebSocket--> host server
// The guest's proxy also serves the static client from the guest's own local server, so only the game's
// /ws traffic crosses Steam. Lobbies carry the session; invites come through the Steam overlay.
//
// Wire format of each Steam packet: [kind u8][channel u32][chunk u16][last u8][payload...]
//   kind 1 open (guest -> host), 2 data, 3 close. Messages above CHUNK are split and reassembled.
const http = require('node:http');
const net = require('node:net');
const { WebSocket, WebSocketServer } = require('ws');

const APP_ID = 480;
const GAME_KEY = 'shattered-empires';
const CHUNK = 512 * 1024;
const OPEN = 1, DATA = 2, CLOSE = 3;

function frame(kind, ch, chunk, last, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt8(kind, 0); head.writeUInt32BE(ch >>> 0, 1); head.writeUInt16BE(chunk, 5); head.writeUInt8(last ? 1 : 0, 7);
  return payload ? Buffer.concat([head, payload]) : head;
}
function parse(buf) { return { kind: buf.readUInt8(0), ch: buf.readUInt32BE(1), chunk: buf.readUInt16BE(5), last: buf.readUInt8(7) === 1, payload: buf.subarray(8) }; }

class SteamBridge {
  constructor({ log = () => {}, onStatus = () => {}, onInvite = () => {}, steamworks = null } = {}) {
    this.log = log; this.onStatus = onStatus; this.onInvite = onInvite; this.inject = steamworks;
    this.client = null; this.sw = null; this.lobby = null; this.role = null; this.hostId = null;
    this.channels = new Map();   // key -> { ws, parts: [] }
    this.nextCh = 1; this.poll = null; this.error = '';
  }

  init() {
    if (this.client) return true;
    try {
      this.sw = this.inject || require('steamworks.js');
      this.client = this.sw.init(APP_ID);
      this.me = this.client.localplayer.getSteamId().steamId64;
      const cb = this.sw.SteamCallback || {};
      // accept sessions from players in our lobby; accept invites from the overlay
      if (cb.P2PSessionRequest != null) this.client.callback.register(cb.P2PSessionRequest, (v) => { const id = v?.remote?.steamId64 ?? v?.steam_id_remote ?? v?.remote; if (id != null) this.accept(BigInt(id)); });
      if (cb.GameLobbyJoinRequested != null) this.client.callback.register(cb.GameLobbyJoinRequested, (v) => { const id = v?.lobby_steam_id ?? v?.lobbySteamId; if (id != null) this.onInvite(BigInt(id)); });
      this.poll = setInterval(() => this.pump(), 4);
      this.log('initialised as', String(this.me));
      return true;
    } catch (e) {
      this.error = 'Steam is not available: ' + (e && e.message ? e.message : e) + ' (is the Steam client running and logged in?)';
      this.client = null;
      return false;
    }
  }
  status() {
    return { available: !!this.client, error: this.error, name: this.client ? this.client.localplayer.getName() : '', role: this.role, lobby: this.lobby ? String(this.lobby.id) : null, members: this.lobby ? this.members().length : 0, channels: this.channels.size };
  }
  members() { try { return (this.lobby?.getMembers?.() || []).map((m) => m.steamId64 ?? m); } catch { return []; } }
  accept(id) { try { this.client.networking.acceptP2PSession(id); } catch (e) { this.log('accept failed', e.message); } }
  send(to, buf) {
    const reliable = this.sw.SendType?.Reliable ?? 2;
    if (!this.client.networking.sendP2PPacket(to, reliable, buf)) this.log('send failed to', String(to));
  }
  sendMessage(to, kind, ch, data) {
    if (to == null || !this.client) return;           // closing after leave(): nobody to tell
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    if (kind !== DATA) return this.send(to, frame(kind, ch, 0, true, payload));
    const n = Math.max(1, Math.ceil(payload.length / CHUNK));
    for (let i = 0; i < n; i++) this.send(to, frame(DATA, ch, i, i === n - 1, payload.subarray(i * CHUNK, (i + 1) * CHUNK)));
  }

  // ------------------------------------------------------------------------- host
  async host(localPort) {
    if (!this.init()) throw new Error(this.error);
    this.leave();
    const M = this.client.matchmaking;
    const type = M.LobbyType?.FriendsOnly ?? 1;
    this.lobby = await M.createLobby(type, 8);
    this.lobby.setData?.('se_game', GAME_KEY);
    this.lobby.setData?.('se_host', String(this.me));
    this.lobby.setData?.('name', `${this.client.localplayer.getName()}'s Shattered Empires`);
    this.role = 'host'; this.localPort = localPort;
    this.log('hosting lobby', String(this.lobby.id));
    this.invite();
    this.onStatus(this.status());
    return this.lobby.id;
  }
  invite() { try { this.lobby?.openInviteDialog?.(); } catch (e) { this.log('invite dialog failed', e.message); } }

  hostPacket(from, p) {
    const key = String(from) + ':' + p.ch;
    if (p.kind === OPEN) {
      if (!this.members().some((m) => String(m) === String(from))) { this.log('ignoring a peer outside the lobby', String(from)); return; }
      const ws = new WebSocket(`ws://127.0.0.1:${this.localPort}/ws`);
      const c = { ws, parts: [], queue: [] };
      this.channels.set(key, c);
      ws.on('open', () => { for (const m of c.queue) ws.send(m); c.queue = []; });
      ws.on('message', (data, isBinary) => this.sendMessage(from, DATA, p.ch, isBinary ? data : Buffer.from(data.toString())));
      ws.on('close', () => { this.channels.delete(key); this.sendMessage(from, CLOSE, p.ch); this.onStatus(this.status()); });
      ws.on('error', () => {});
      this.onStatus(this.status());
      return;
    }
    const c = this.channels.get(key); if (!c) return;
    if (p.kind === CLOSE) { c.ws.close(); this.channels.delete(key); return; }
    c.parts.push(p.payload);
    if (!p.last) return;
    const msg = Buffer.concat(c.parts).toString(); c.parts = [];
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg); else c.queue.push(msg);
  }

  // ------------------------------------------------------------------------- guest
  // Join a lobby (by id, or the first friend lobby found) and start the local proxy. Returns its port.
  async join(localPort, lobbyId) {
    if (!this.init()) throw new Error(this.error);
    this.leave();
    const M = this.client.matchmaking;
    if (lobbyId == null) { const list = await this.friendLobbies(); if (!list.length) throw new Error('no Shattered Empires lobby found: ask the host for an invite'); lobbyId = BigInt(list[0].id); }
    this.lobby = await M.joinLobby(BigInt(lobbyId));
    const hostStr = this.lobby.getData?.('se_host');
    this.hostId = hostStr ? BigInt(hostStr) : (this.lobby.getOwner?.().steamId64);
    if (!this.hostId) throw new Error('the lobby has no host');
    this.accept(this.hostId);
    this.role = 'guest'; this.localPort = localPort;
    const port = await this.startProxy(localPort);
    this.log('joined lobby', String(this.lobby.id), 'host', String(this.hostId), 'proxy', port);
    this.onStatus(this.status());
    return port;
  }
  async friendLobbies() {
    if (!this.init()) return [];
    try {
      const all = await this.client.matchmaking.getLobbies();
      return all.filter((l) => l.getData?.('se_game') === GAME_KEY).map((l) => ({ id: String(l.id), name: l.getData?.('name') || 'Shattered Empires', members: l.getMemberCount?.() ?? 0 }));
    } catch (e) { this.log('lobby list failed', e.message); return []; }
  }
  // HTTP: forwarded to the guest's own local server (static client). /ws: tunnelled to the host.
  startProxy(localPort) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const up = http.request({ host: '127.0.0.1', port: localPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
        up.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(up);
      });
      const wss = new WebSocketServer({ server: srv, path: '/ws' });
      wss.on('connection', (ws) => {
        const ch = this.nextCh++, key = 'g:' + ch, c = { ws, parts: [] };
        this.channels.set(key, c);
        this.sendMessage(this.hostId, OPEN, ch);
        ws.on('message', (data) => this.sendMessage(this.hostId, DATA, ch, Buffer.from(data.toString())));
        ws.on('close', () => { this.channels.delete(key); this.sendMessage(this.hostId, CLOSE, ch); });
        ws.on('error', () => {});
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => { this.proxy = srv; resolve(srv.address().port); });
    });
  }
  guestPacket(from, p) {
    if (String(from) !== String(this.hostId)) return;
    const c = this.channels.get('g:' + p.ch); if (!c) return;
    if (p.kind === CLOSE) { c.ws.close(); this.channels.delete('g:' + p.ch); return; }
    c.parts.push(p.payload);
    if (!p.last) return;
    const msg = Buffer.concat(c.parts).toString(); c.parts = [];
    if (c.ws.readyState === 1) c.ws.send(msg);
  }

  // ------------------------------------------------------------------------- common
  pump() {
    if (!this.client) return;
    const N = this.client.networking;
    for (let i = 0; i < 256; i++) {
      const size = N.isP2PPacketAvailable();
      if (!size) break;
      const pkt = N.readP2PPacket(size);
      const from = pkt.steamId?.steamId64 ?? pkt.steamId;
      let p; try { p = parse(Buffer.from(pkt.data)); } catch { continue; }
      if (this.role === 'host') this.hostPacket(from, p);
      else if (this.role === 'guest') this.guestPacket(from, p);
    }
  }
  leave() {
    for (const c of this.channels.values()) { try { c.ws.close(); } catch { /* closing */ } }
    this.channels.clear();
    if (this.proxy) { this.proxy.close(); this.proxy = null; }
    if (this.lobby) { try { this.lobby.leave?.(); } catch { /* left */ } this.lobby = null; }
    this.role = null; this.hostId = null;
  }
}

module.exports = { SteamBridge, frame, parse, CHUNK, OPEN, DATA, CLOSE, net };
