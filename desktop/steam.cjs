// Steam for the desktop app (steamworks.js, Spacewar test app 480 until the game has its own app id).
//
// The game stays server-run: every match lives on the authoritative game server. Steam provides the
// social layer around it — friends, lobbies, invites and the overlay. A host's Steam lobby carries
// the server's match code; accepting an invite (from the overlay, Steam chat, or "+connect_lobby"
// when Steam launches the game) joins the Steam lobby, reads the code and joins that match on the
// server. No game traffic goes through Steam.
const APP_ID = 480;
const GAME_KEY = 'shattered-empires';

class SteamLobbies {
  constructor({ log = () => {}, onJoinMatch = () => {}, steamworks = null } = {}) {
    this.log = log; this.onJoinMatch = onJoinMatch; this.inject = steamworks;
    this.client = null; this.sw = null; this.lobby = null; this.error = '';
  }

  init() {
    if (this.client) return true;
    try {
      this.sw = this.inject || require('steamworks.js');
      this.client = this.sw.init(APP_ID);
      const cb = this.sw.SteamCallback || {};
      // an invite accepted in Steam while the game is running
      if (cb.GameLobbyJoinRequested != null) this.client.callback.register(cb.GameLobbyJoinRequested, (v) => { const id = v?.lobby_steam_id ?? v?.lobbySteamId; if (id != null) this.joinLobby(BigInt(id)).catch((e) => this.log('join failed', e.message)); });
      return true;
    } catch (e) {
      this.error = 'Steam is not available (is the Steam client running and signed in?)';
      this.log(this.error, e && e.message);
      this.client = null;
      return false;
    }
  }
  status() {
    if (!this.client) this.init();
    return { available: !!this.client, error: this.client ? '' : this.error, name: this.client ? this.client.localplayer.getName() : '', lobby: this.lobby ? String(this.lobby.id) : null, match: this.lobby?.getData?.('se_match') || null };
  }

  // host: open a Steam lobby for a match that already exists on the game server, then invite friends
  async host(matchCode, matchName = '') {
    if (!this.init()) throw new Error(this.error);
    if (!/^[a-z0-9]{3,12}$/i.test(matchCode)) throw new Error('no match to invite friends to');
    if (this.lobby && this.lobby.getData?.('se_match') === matchCode) { this.invite(); return this.lobby.id; }
    this.leave();
    const M = this.client.matchmaking;
    this.lobby = await M.createLobby(M.LobbyType?.FriendsOnly ?? 1, 8);
    this.lobby.setData?.('se_game', GAME_KEY);
    this.lobby.setData?.('se_match', matchCode);
    this.lobby.setData?.('name', matchName || `${this.client.localplayer.getName()}'s match`);
    this.log('lobby', String(this.lobby.id), 'for match', matchCode);
    this.invite();
    return this.lobby.id;
  }
  invite() { try { this.lobby?.openInviteDialog?.(); } catch (e) { this.log('invite dialog failed', e.message); } }

  // guest: join the Steam lobby and hand its match code to the game (which joins on the server)
  async joinLobby(lobbyId) {
    if (!this.init()) throw new Error(this.error);
    this.leave();
    this.lobby = await this.client.matchmaking.joinLobby(BigInt(lobbyId));
    if (this.lobby.getData?.('se_game') !== GAME_KEY) { this.leave(); throw new Error('that Steam lobby is not a Shattered Empires match'); }
    const code = this.lobby.getData?.('se_match');
    if (!code) { this.leave(); throw new Error('the lobby has no match'); }
    this.onJoinMatch(code);
    return code;
  }
  async friendLobbies() {
    if (!this.init()) return [];
    try {
      const all = await this.client.matchmaking.getLobbies();
      return all.filter((l) => l.getData?.('se_game') === GAME_KEY && l.getData?.('se_match'))
        .map((l) => ({ id: String(l.id), name: l.getData?.('name') || 'Shattered Empires', match: l.getData('se_match'), members: l.getMemberCount?.() ?? 0 }));
    } catch (e) { this.log('lobby list failed', e.message); return []; }
  }
  leave() { if (this.lobby) { try { this.lobby.leave?.(); } catch { /* already gone */ } this.lobby = null; } }
}

module.exports = { SteamLobbies, APP_ID, GAME_KEY };
