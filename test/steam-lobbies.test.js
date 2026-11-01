// Steam in the desktop app is the social layer only: a host's Steam lobby carries the game server's
// match code, and joining a friend's lobby (or accepting an invite) hands that code to the client,
// which joins the match on the server. A fake Steam stands in for steamworks.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SteamLobbies, GAME_KEY } = require('../desktop/steam.cjs');

function fakeSteam() {
  const lobbies = []; let invites = 0;
  const user = (id, name) => ({
    localplayer: { getSteamId: () => ({ steamId64: id }), getName: () => name },
    matchmaking: {
      LobbyType: { FriendsOnly: 1 },
      createLobby: async () => { const data = {}, members = [id]; const l = { id: 900n + BigInt(lobbies.length), setData: (k, v) => { data[k] = v; }, getData: (k) => data[k], getMemberCount: () => members.length, openInviteDialog: () => { invites++; }, leave: () => {}, members }; lobbies.push(l); return l; },
      joinLobby: async (lid) => { const l = lobbies.find((x) => x.id === lid); if (!l) throw new Error('no such lobby'); l.members.push(id); return l; },
      getLobbies: async () => lobbies,
    },
    callback: { register: () => {} },
  });
  return { make: (id, name) => ({ init: () => user(id, name), SteamCallback: {} }), invites: () => invites, lobbies };
}

test('a host opens a Steam lobby for a server match; a friend joins it and gets the match code', async () => {
  const net = fakeSteam();
  const host = new SteamLobbies({ steamworks: net.make(1n, 'Host') });
  let joined = null;
  const guest = new SteamLobbies({ steamworks: net.make(2n, 'Guest'), onJoinMatch: (code) => { joined = code; } });
  assert.equal(host.status().available, true);
  const lobby = await host.host('abc123', "Host's war");
  assert.equal(net.invites(), 1, 'the invite dialog opens');
  assert.equal(net.lobbies[0].getData('se_game'), GAME_KEY);
  const list = await guest.friendLobbies();
  assert.deepEqual(list.map((l) => [l.name, l.match]), [["Host's war", 'abc123']]);
  const code = await guest.joinLobby(lobby);
  assert.equal(code, 'abc123'); assert.equal(joined, 'abc123', 'the client is told which server match to join');
  // inviting again for the same match reuses the lobby
  await host.host('abc123'); assert.equal(net.lobbies.length, 1); assert.equal(net.invites(), 2);
});

test('no Steam: the app still plays on the server; Steam features report why they are off', async () => {
  const s = new SteamLobbies({ steamworks: { init: () => { throw new Error('Steam not running'); } } });
  const st = s.status();
  assert.equal(st.available, false); assert.match(st.error, /Steam/);
  await assert.rejects(s.host('abc123'), /Steam/);
  assert.deepEqual(await s.friendLobbies(), []);
});

test('lobbies that are not Shattered Empires matches are refused', async () => {
  const net = fakeSteam();
  const other = new SteamLobbies({ steamworks: net.make(3n, 'X') });
  await other.host('zzz999'); net.lobbies[0].setData('se_game', 'spacewar');
  const guest = new SteamLobbies({ steamworks: net.make(4n, 'Y') });
  await assert.rejects(guest.joinLobby(net.lobbies[0].id), /not a Shattered Empires match/);
});
