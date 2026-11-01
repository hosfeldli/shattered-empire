// The Steam bridge tunnels the game's WebSocket over Steam P2P packets. Here a fake Steam network
// joins two bridges, and a real game server answers through the tunnel (HTTP and WebSocket).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { SteamBridge, frame, parse, CHUNK } = require('../desktop/steam.cjs');

// a minimal in-memory Steam: two users, one lobby, reliable ordered packets
function fakeSteam() {
  const queues = new Map(), lobbies = [];
  const user = (id, name) => {
    queues.set(id, []);
    return {
      localplayer: { getSteamId: () => ({ steamId64: id }), getName: () => name },
      networking: {
        sendP2PPacket: (to, _t, buf) => { queues.get(to).push({ data: Buffer.from(buf), steamId: { steamId64: id } }); return true; },
        isP2PPacketAvailable: () => (queues.get(id)[0]?.data.length || 0),
        readP2PPacket: () => queues.get(id).shift(),
        acceptP2PSession: () => {},
      },
      matchmaking: {
        LobbyType: { FriendsOnly: 1 },
        createLobby: async () => { const data = {}, members = [id]; const l = { id: 900n, setData: (k, v) => { data[k] = v; }, getData: (k) => data[k], getMembers: () => members.map((m) => ({ steamId64: m })), getMemberCount: () => members.length, getOwner: () => ({ steamId64: id }), openInviteDialog: () => {}, leave: () => {}, members }; lobbies.push(l); return l; },
        joinLobby: async (lid) => { const l = lobbies.find((x) => x.id === lid); l.members.push(id); return l; },
        getLobbies: async () => lobbies,
      },
      callback: { register: () => {} },
    };
  };
  return { user, SendType: { Reliable: 2 }, SteamCallback: {} };
}

test('frames split and reassemble large messages', () => {
  const p = parse(frame(2, 7, 3, true, Buffer.from('hello')));
  assert.deepEqual([p.kind, p.ch, p.chunk, p.last, p.payload.toString()], [2, 7, 3, true, 'hello']);
  assert.ok(CHUNK <= 1024 * 1024, 'within Steam reliable packet limits');
});

test('a guest reaches the host\'s game server through the Steam tunnel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-steam-'));
  const srv = fork(new URL('../server/index.js', import.meta.url).pathname, [], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', SNAPSHOT_DIR: dir }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const port = await new Promise((r) => srv.on('message', (m) => m.t === 'listening' && r(m.port)));
  try {
    const net = fakeSteam();
    const mk = (id, name) => { const u = net.user(id, name); return { ...net, init: () => u }; };
    const host = new SteamBridge({ steamworks: mk(1n, 'Host') }), guest = new SteamBridge({ steamworks: mk(2n, 'Guest') });
    await host.host(port);
    const proxy = await guest.join(port, 900n);
    // static client through the proxy
    const html = await (await fetch(`http://127.0.0.1:${proxy}/`)).text();
    assert.match(html, /Shattered Empires/);
    // WebSocket round trip through Steam packets to the host's server
    const ws = new WebSocket(`ws://127.0.0.1:${proxy}/ws`);
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    const got = new Promise((r) => ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'pong') r(m); }));
    ws.send(JSON.stringify({ t: 'ping', at: 42 }));
    const pong = await Promise.race([got, new Promise((_, j) => setTimeout(() => j(new Error('no reply through the tunnel')), 5000))]);
    assert.equal(pong.at, 42);
    assert.equal(host.status().role, 'host'); assert.equal(guest.status().role, 'guest');
    ws.close(); host.leave(); guest.leave(); clearInterval(host.poll); clearInterval(guest.poll);
  } finally { srv.kill(); }
});
