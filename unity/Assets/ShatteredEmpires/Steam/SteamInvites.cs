using System;
using System.Collections.Generic;
using System.IO;
using SE.Runtime.Social;
using SE.Runtime.UI;
using Steamworks;
using UnityEngine;

namespace SE.Steam
{
    /// <summary>
    /// Steam friends, lobbies and invites (Steamworks.NET). Same design as desktop/steam.cjs: the host's
    /// friends-only lobby carries the server's match code ('se_match') and server URL ('se_server'); rich
    /// presence 'connect' = "+connect_lobby &lt;id&gt; +se_match &lt;code&gt;" lets friends join from the Steam
    /// friends list. Accepting an invite in the overlay or chat (GameLobbyJoinRequested_t), "Join Game"
    /// (GameRichPresenceJoinRequested_t), or launching with +connect_lobby joins the lobby, reads the code
    /// and raises JoinRequested so the game joins that match on the game server. No game traffic goes
    /// through Steam. Uses Spacewar (480) unless steam_appid.txt / the SteamAppId variable says otherwise.
    /// </summary>
    public sealed class SteamInvites : ISocialPlatform, IFriendLobbyList
    {
        public const uint DefaultAppId = 480;
        const string GameKey = "shattered-empires";

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void RegisterPlatform() => SocialPlatform.Register(() => new SteamInvites());

        bool ready;
        int lastTick = -1;
        string status = "Steam is starting…";
        CSteamID me = CSteamID.Nil;
        CSteamID lobby = CSteamID.Nil;
        bool isHost, creating, joining;
        string lobbyMatch = "";
        LobbyRequest pendingHost;
        string joinFallbackCode = "", joinSource = "";
        LobbyState state;
        SocialJoin lastJoin;
        string pendingJoin;          // a resolved join nobody was listening for yet
        readonly Dictionary<ulong, Texture2D> avatars = new Dictionary<ulong, Texture2D>();

        Callback<GameLobbyJoinRequested_t> lobbyJoinRequested;
        Callback<GameRichPresenceJoinRequested_t> presenceJoinRequested;
        Callback<LobbyChatUpdate_t> chatUpdate;
        Callback<LobbyDataUpdate_t> dataUpdate;
        Callback<PersonaStateChange_t> personaChange;
        Callback<AvatarImageLoaded_t> avatarLoaded;
        CallResult<LobbyCreated_t> created;
        CallResult<LobbyEnter_t> entered;

        Action<string> joinRequested;
        public event Action<string> JoinRequested
        {
            add
            {
                joinRequested += value;
                if (value != null && pendingJoin != null) { var code = pendingJoin; pendingJoin = null; value(code); }
            }
            remove { joinRequested -= value; }
        }
        public event Action<string> InviteAccepted;
        public event Action LobbyChanged;

        public bool Available => ready;
        public string Status => status;
        public string PlayerName => ready ? SteamFriends.GetPersonaName() : "";
        public ulong LocalId => me.m_SteamID;
        public LobbyState Lobby => state;
        public bool Busy => creating || joining;
        public SocialJoin LastJoin => lastJoin;

        public SteamInvites()
        {
            try
            {
                if (!Packsize.Test() || !DllCheck.Test()) { status = "Steam libraries are missing from this build; share the match code instead"; return; }
                EnsureAppId();
                var init = SteamAPI.InitEx(out string why);
                ready = init == ESteamAPIInitResult.k_ESteamAPIInitResult_OK;
                if (!ready)
                {
                    status = init == ESteamAPIInitResult.k_ESteamAPIInitResult_NoSteamClient
                        ? "Steam is not running; start Steam and sign in to invite friends (match codes still work)"
                        : "Steam is not available (" + (string.IsNullOrEmpty(why) ? init.ToString() : why) + "); match codes still work";
                    return;
                }
                me = SteamUser.GetSteamID();
                status = "Steam: " + SteamFriends.GetPersonaName();
                lobbyJoinRequested = Callback<GameLobbyJoinRequested_t>.Create(OnLobbyJoinRequested);
                presenceJoinRequested = Callback<GameRichPresenceJoinRequested_t>.Create(OnPresenceJoinRequested);
                chatUpdate = Callback<LobbyChatUpdate_t>.Create(OnLobbyChatUpdate);
                dataUpdate = Callback<LobbyDataUpdate_t>.Create(OnLobbyDataUpdate);
                personaChange = Callback<PersonaStateChange_t>.Create(OnPersonaChange);
                avatarLoaded = Callback<AvatarImageLoaded_t>.Create(OnAvatarLoaded);
                created = CallResult<LobbyCreated_t>.Create(OnLobbyCreated);
                entered = CallResult<LobbyEnter_t>.Create(OnLobbyEntered);
                SteamFriends.ClearRichPresence();
                // launched by Steam from an invite or "Join Game": +connect_lobby <id> [+se_match <code>]
                if (!ParseConnect(string.Join(" ", Environment.GetCommandLineArgs()), "launch"))
                {
                    if (SteamApps.GetLaunchCommandLine(out string line, 1024) > 0 && !string.IsNullOrEmpty(line)) ParseConnect(line, "launch");
                }
            }
            catch (Exception e)
            {
                ready = false;
                status = "Steam is not available: " + e.Message + " (match codes still work)";
            }
        }

        /// <summary>
        /// SteamAPI.Init reads steam_appid.txt from the working directory, which is not the game folder when
        /// the game is started from a shortcut. Point Steam at the app id explicitly (Steam itself sets it
        /// when it launches the game).
        /// </summary>
        static void EnsureAppId()
        {
            if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SteamAppId"))) return;
            uint id = DefaultAppId;
            try
            {
                foreach (var dir in new[] { Directory.GetCurrentDirectory(), Path.GetDirectoryName(Application.dataPath) })
                {
                    if (string.IsNullOrEmpty(dir)) continue;
                    var file = Path.Combine(dir, "steam_appid.txt");
                    if (File.Exists(file) && uint.TryParse(File.ReadAllText(file).Trim(), out uint v) && v > 0) { id = v; break; }
                }
            }
            catch (Exception) { /* fall back to the default id */ }
            Environment.SetEnvironmentVariable("SteamAppId", id.ToString());
            Environment.SetEnvironmentVariable("SteamGameId", id.ToString());
        }

        public void Tick()
        {
            if (!ready) return;
            int frame = Time.frameCount;
            if (frame == lastTick) return;
            lastTick = frame;
            SteamAPI.RunCallbacks();
        }

        // ------------------------------------------------------------------ host

        public void HostLobby(LobbyRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.MatchCode)) return;
            if (!ready) { Changed(); return; }
            if (lobby != CSteamID.Nil && isHost)
            {
                ApplyHostData(request);
                if (request.OpenInviteDialog) OpenInviteDialog();
                Changed();
                return;
            }
            pendingHost = request;
            if (creating) return;   // the lobby on its way takes the newest request
            LeaveSteamLobby();
            creating = true;
            int max = Mathf.Clamp(request.MaxMembers, 2, 250);
            created.Set(SteamMatchmaking.CreateLobby(ELobbyType.k_ELobbyTypeFriendsOnly, max));
            status = "Opening a Steam lobby…";
            Changed();
        }

        void OnLobbyCreated(LobbyCreated_t r, bool failure)
        {
            creating = false;
            var request = pendingHost;
            pendingHost = null;
            if (failure || r.m_eResult != EResult.k_EResultOK || request == null)
            {
                status = "Steam could not create a lobby (" + (failure ? "connection failure" : r.m_eResult.ToString()) + "); share the match code instead";
                Changed();
                return;
            }
            lobby = new CSteamID(r.m_ulSteamIDLobby);
            isHost = true;
            ApplyHostData(request);
            status = "Steam lobby open: invite friends from the Steam overlay";
            if (request.OpenInviteDialog) OpenInviteDialog();
            Changed();
        }

        void ApplyHostData(LobbyRequest r)
        {
            lobbyMatch = r.MatchCode;
            string name = string.IsNullOrEmpty(r.Name) ? SteamFriends.GetPersonaName() + "'s match" : r.Name;
            SteamMatchmaking.SetLobbyData(lobby, "se_game", GameKey);
            SteamMatchmaking.SetLobbyData(lobby, "se_match", r.MatchCode);
            SteamMatchmaking.SetLobbyData(lobby, "se_server", r.Server ?? "");
            SteamMatchmaking.SetLobbyData(lobby, "se_host", SteamFriends.GetPersonaName());
            SteamMatchmaking.SetLobbyData(lobby, "se_ruleset", r.Ruleset ?? "");
            SteamMatchmaking.SetLobbyData(lobby, "se_map", r.MapSize ?? "");
            SteamMatchmaking.SetLobbyData(lobby, "se_team", Mathf.Max(1, r.TeamSize).ToString());
            SteamMatchmaking.SetLobbyData(lobby, "se_status", "lobby");
            SteamMatchmaking.SetLobbyData(lobby, "name", name);
            SteamMatchmaking.SetLobbyJoinable(lobby, true);
            UpdatePresence("lobby");
            Rebuild();
        }

        public void InviteFriends()
        {
            if (!ready) return;
            if (lobby == CSteamID.Nil)
            {
                status = creating ? "The Steam lobby is still opening…" : "Host a match first, then invite friends";
                if (creating && pendingHost != null) pendingHost.OpenInviteDialog = true;
                Changed();
                return;
            }
            OpenInviteDialog();
        }

        public void InviteFriends(string matchCode, string matchName)
        {
            if (!ready || string.IsNullOrEmpty(matchCode)) return;
            if (lobby != CSteamID.Nil && lobbyMatch == matchCode) { OpenInviteDialog(); return; }
            if (lobby != CSteamID.Nil && !isHost)
            {
                // a guest in someone else's lobby for another match: open our own for this one
                LeaveSteamLobby();
            }
            HostLobby(new LobbyRequest { MatchCode = matchCode, Name = matchName, OpenInviteDialog = true });
        }

        void OpenInviteDialog()
        {
            if (!SteamUtils.IsOverlayEnabled())
                status = "The Steam overlay is off for this game; enable it in Steam, or share the match code " + lobbyMatch;
            SteamFriends.ActivateGameOverlayInviteDialog(lobby);
            Changed();
        }

        public void SetLobbyStatus(string newStatus)
        {
            if (!ready || lobby == CSteamID.Nil || string.IsNullOrEmpty(newStatus)) return;
            if (isHost)
            {
                SteamMatchmaking.SetLobbyData(lobby, "se_status", newStatus);
                // a started match takes no more players: no more lobby joins from the friends list
                SteamMatchmaking.SetLobbyJoinable(lobby, newStatus == "lobby");
            }
            UpdatePresence(newStatus);
            Changed();
        }

        void UpdatePresence(string phase)
        {
            if (lobby == CSteamID.Nil) { SteamFriends.ClearRichPresence(); return; }
            bool open = phase == "lobby";
            SteamFriends.SetRichPresence("connect", open ? "+connect_lobby " + lobby.m_SteamID + " +se_match " + lobbyMatch : "");
            SteamFriends.SetRichPresence("status", open ? "In a match lobby (code " + lobbyMatch + ")" : "In a match");
            // groups the party together in friends lists
            SteamFriends.SetRichPresence("steam_player_group", lobby.m_SteamID.ToString());
            SteamFriends.SetRichPresence("steam_player_group_size", Mathf.Max(1, SteamMatchmaking.GetNumLobbyMembers(lobby)).ToString());
        }

        // ------------------------------------------------------------------ guest

        void OnLobbyJoinRequested(GameLobbyJoinRequested_t r)
        {
            InviteAccepted?.Invoke(SteamFriends.GetFriendPersonaName(r.m_steamIDFriend));
            Join(r.m_steamIDLobby, "", "invite");
        }

        void OnPresenceJoinRequested(GameRichPresenceJoinRequested_t r)
        {
            InviteAccepted?.Invoke(SteamFriends.GetFriendPersonaName(r.m_steamIDFriend));
            ParseConnect(r.m_rgchConnect, "friends-list");
        }

        /// <summary>"+connect_lobby &lt;id&gt; [+se_match &lt;code&gt;]" (also a bare "+se_match &lt;code&gt;").</summary>
        bool ParseConnect(string line, string source)
        {
            if (string.IsNullOrEmpty(line)) return false;
            var parts = line.Split(new[] { ' ', '\t', '\r', '\n', '"' }, StringSplitOptions.RemoveEmptyEntries);
            ulong lobbyId = 0;
            string code = "";
            for (int i = 0; i + 1 < parts.Length; i++)
            {
                if (parts[i] == "+connect_lobby" && ulong.TryParse(parts[i + 1], out ulong id)) lobbyId = id;
                else if (parts[i] == "+se_match") code = LobbyMessages.NormalizeCode(parts[i + 1]);
            }
            if (lobbyId != 0) { Join(new CSteamID(lobbyId), code, source); return true; }
            if (code != "") { Deliver(code, "", 0, source); return true; }
            return false;
        }

        public void JoinLobby(ulong lobbyId)
        {
            if (!ready || lobbyId == 0) return;
            Join(new CSteamID(lobbyId), "", "lobby");
        }

        void Join(CSteamID id, string fallbackCode, string source)
        {
            if (lobby == id && lobby != CSteamID.Nil)
            {
                // already here (a second click on the same invite): ask again for the same match
                if (!isHost && lobbyMatch != "") Deliver(lobbyMatch, state?.Server ?? "", id.m_SteamID, source);
                return;
            }
            LeaveSteamLobby();
            joining = true;
            joinFallbackCode = fallbackCode ?? "";
            joinSource = source;
            entered.Set(SteamMatchmaking.JoinLobby(id));
            status = "Joining a friend's match…";
            Changed();
        }

        void OnLobbyEntered(LobbyEnter_t r, bool failure)
        {
            joining = false;
            string fallback = joinFallbackCode;
            joinFallbackCode = "";
            var id = new CSteamID(r.m_ulSteamIDLobby);
            if (failure || r.m_EChatRoomEnterResponse != (uint)EChatRoomEnterResponse.k_EChatRoomEnterResponseSuccess)
            {
                if (!failure && id != CSteamID.Nil) SteamMatchmaking.LeaveLobby(id);
                if (fallback != "")
                {
                    status = "The Steam lobby is gone; joining match " + fallback + " directly";
                    Deliver(fallback, "", 0, joinSource);
                }
                else status = "Could not join that Steam lobby (it may be full or closed); ask for the match code";
                Changed();
                return;
            }
            lobby = id;
            isHost = SteamMatchmaking.GetLobbyOwner(lobby) == me;
            if (SteamMatchmaking.GetLobbyData(lobby, "se_game") != GameKey)
            {
                status = "That Steam lobby is not a Shattered Empires match";
                LeaveSteamLobby();
                Changed();
                return;
            }
            string code = LobbyMessages.NormalizeCode(SteamMatchmaking.GetLobbyData(lobby, "se_match"));
            if (code == "") code = fallback;
            if (code == "")
            {
                status = "That Steam lobby has no match yet";
                LeaveSteamLobby();
                Changed();
                return;
            }
            lobbyMatch = code;
            string lobbyStatus = SteamMatchmaking.GetLobbyData(lobby, "se_status");
            UpdatePresence(string.IsNullOrEmpty(lobbyStatus) ? "lobby" : lobbyStatus);
            status = "Joining match " + code;
            Rebuild();
            Deliver(code, SteamMatchmaking.GetLobbyData(lobby, "se_server"), lobby.m_SteamID, joinSource);
        }

        void Deliver(string code, string server, ulong lobbyId, string source)
        {
            lastJoin = new SocialJoin { MatchCode = code, Server = SafeServer(server), LobbyId = lobbyId, Source = source ?? "" };
            Changed();
            if (joinRequested != null) joinRequested(code);
            else pendingJoin = code;
        }

        /// <summary>Only a ws:// or wss:// URL from a lobby is passed on (the game still sanitises it).</summary>
        static string SafeServer(string server)
        {
            if (string.IsNullOrEmpty(server)) return "";
            if (!Uri.TryCreate(server.Trim(), UriKind.Absolute, out var uri)) return "";
            return uri.Scheme == "ws" || uri.Scheme == "wss" ? uri.AbsoluteUri : "";
        }

        // ------------------------------------------------------------------ lobby state

        public void SetReady(bool on)
        {
            if (!ready || lobby == CSteamID.Nil) return;
            SteamMatchmaking.SetLobbyMemberData(lobby, "ready", on ? "1" : "0");
            Rebuild();
            Changed();
        }

        void OnLobbyChatUpdate(LobbyChatUpdate_t r)
        {
            if (lobby == CSteamID.Nil || r.m_ulSteamIDLobby != lobby.m_SteamID) return;
            isHost = SteamMatchmaking.GetLobbyOwner(lobby) == me;    // the owner leaving hands the lobby on
            SteamFriends.SetRichPresence("steam_player_group_size", Mathf.Max(1, SteamMatchmaking.GetNumLobbyMembers(lobby)).ToString());
            Rebuild();
            Changed();
        }

        void OnLobbyDataUpdate(LobbyDataUpdate_t r)
        {
            // a friend's lobby answered RequestLobbyData: the Join a friend list can show it now
            if (friendLobbies.ContainsKey(r.m_ulSteamIDLobby) && r.m_ulSteamIDLobby != lobby.m_SteamID) { Changed(); return; }
            if (lobby == CSteamID.Nil || r.m_ulSteamIDLobby != lobby.m_SteamID) return;
            Rebuild();
            Changed();
        }

        void OnPersonaChange(PersonaStateChange_t r)
        {
            if (state == null) return;
            if ((r.m_nChangeFlags & EPersonaChange.k_EPersonaChangeAvatar) != 0) avatars.Remove(r.m_ulSteamID);
            foreach (var m in state.Members)
                if (m.Id == r.m_ulSteamID) { Rebuild(); Changed(); return; }
        }

        void OnAvatarLoaded(AvatarImageLoaded_t r)
        {
            if (state == null) return;
            foreach (var m in state.Members)
                if (m.Id == r.m_steamID.m_SteamID) { avatars.Remove(m.Id); Rebuild(); Changed(); return; }
        }

        void Rebuild()
        {
            if (lobby == CSteamID.Nil) { state = null; return; }
            var owner = SteamMatchmaking.GetLobbyOwner(lobby);
            var members = new List<LobbyMember>();
            int n = SteamMatchmaking.GetNumLobbyMembers(lobby);
            for (int i = 0; i < n; i++)
            {
                var id = SteamMatchmaking.GetLobbyMemberByIndex(lobby, i);
                if (id == CSteamID.Nil) continue;
                members.Add(new LobbyMember
                {
                    Id = id.m_SteamID,
                    Name = SteamFriends.GetFriendPersonaName(id),
                    IsHost = id == owner,
                    IsYou = id == me,
                    Ready = SteamMatchmaking.GetLobbyMemberData(lobby, id, "ready") == "1",
                    Avatar = AvatarOf(id),
                });
            }
            int.TryParse(SteamMatchmaking.GetLobbyData(lobby, "se_team"), out int team);
            string st = SteamMatchmaking.GetLobbyData(lobby, "se_status");
            state = new LobbyState
            {
                Id = lobby.m_SteamID,
                IsHost = isHost,
                MatchCode = lobbyMatch,
                Server = SafeServer(SteamMatchmaking.GetLobbyData(lobby, "se_server")),
                Name = SteamMatchmaking.GetLobbyData(lobby, "name"),
                HostName = SteamMatchmaking.GetLobbyData(lobby, "se_host"),
                Ruleset = SteamMatchmaking.GetLobbyData(lobby, "se_ruleset"),
                MapSize = SteamMatchmaking.GetLobbyData(lobby, "se_map"),
                TeamSize = Mathf.Max(1, team),
                Status = string.IsNullOrEmpty(st) ? "lobby" : st,
                Members = members,
            };
        }

        Texture2D AvatarOf(CSteamID id)
        {
            if (avatars.TryGetValue(id.m_SteamID, out var cached) && cached != null) return cached;
            int image = SteamFriends.GetMediumFriendAvatar(id);    // 0: none, -1: still loading (AvatarImageLoaded_t follows)
            if (image <= 0) return null;
            if (!SteamUtils.GetImageSize(image, out uint w, out uint h) || w == 0 || h == 0 || w > 512 || h > 512) return null;
            int size = (int)(w * h * 4);
            var rgba = new byte[size];
            if (!SteamUtils.GetImageRGBA(image, rgba, size)) return null;
            // Steam images are top row first; Unity textures are bottom row first
            var flipped = new byte[size];
            int row = (int)w * 4;
            for (int y = 0; y < (int)h; y++) Buffer.BlockCopy(rgba, y * row, flipped, ((int)h - 1 - y) * row, row);
            var tex = new Texture2D((int)w, (int)h, TextureFormat.RGBA32, false) { name = "SteamAvatar" };
            tex.LoadRawTextureData(flipped);
            tex.Apply(false, true);
            avatars[id.m_SteamID] = tex;
            return tex;
        }

        // ------------------------------------------------------------------ friends' lobbies (Join a friend page)

        // friends seen in a lobby of this app at the last refresh: lobby -> friend
        readonly Dictionary<ulong, CSteamID> friendLobbies = new Dictionary<ulong, CSteamID>();
        readonly List<FriendLobby> friendSessions = new List<FriendLobby>();

        /// <summary>
        /// Friends in a Shattered Empires lobby, from the last <see cref="RefreshFriends"/>. A lobby is listed once
        /// Steam has its data (RequestLobbyData, answered within a refresh or two) and it says it is ours and open.
        /// </summary>
        public IReadOnlyList<FriendLobby> FriendSessions()
        {
            friendSessions.Clear();
            if (!ready) return friendSessions;
            foreach (var kv in friendLobbies)
            {
                var id = new CSteamID(kv.Key);
                if (id == lobby) continue;                                              // the lobby we are in
                if (SteamMatchmaking.GetLobbyData(id, "se_game") != GameKey) continue;  // not ours, or no data yet
                string st = SteamMatchmaking.GetLobbyData(id, "se_status");
                if (!string.IsNullOrEmpty(st) && st != "lobby") continue;               // already playing: no seats
                string name = SteamMatchmaking.GetLobbyData(id, "name");
                friendSessions.Add(new FriendLobby
                {
                    LobbyId = kv.Key,
                    FriendName = SteamFriends.GetFriendPersonaName(kv.Value),
                    LobbyName = string.IsNullOrEmpty(name) ? SteamFriends.GetFriendPersonaName(kv.Value) + "'s match" : name,
                    Members = Mathf.Max(1, SteamMatchmaking.GetNumLobbyMembers(id)),
                    MaxMembers = SteamMatchmaking.GetLobbyMemberLimit(id),
                });
            }
            return friendSessions;
        }

        /// <summary>Scan friends for ones in a lobby of this game and ask Steam for those lobbies' data.</summary>
        public void RefreshFriends()
        {
            if (!ready) return;
            friendLobbies.Clear();
            var app = SteamUtils.GetAppID();
            int n = SteamFriends.GetFriendCount(EFriendFlags.k_EFriendFlagImmediate);
            for (int i = 0; i < n; i++)
            {
                var friend = SteamFriends.GetFriendByIndex(i, EFriendFlags.k_EFriendFlagImmediate);
                if (!SteamFriends.GetFriendGamePlayed(friend, out FriendGameInfo_t game)) continue;
                if (!game.m_gameID.IsValid() || game.m_gameID.AppID() != app) continue;
                var id = game.m_steamIDLobby;
                if (!id.IsValid() || !id.IsLobby()) continue;
                friendLobbies[id.m_SteamID] = friend;
                SteamMatchmaking.RequestLobbyData(id);    // the data (se_game, name, members) arrives by LobbyDataUpdate_t
            }
        }

        public void OpenFriendsOverlay()
        {
            if (!ready) return;
            SteamFriends.ActivateGameOverlay("Friends");
        }

        // ------------------------------------------------------------------ leaving

        public void LeaveLobby()
        {
            if (!ready) return;
            pendingHost = null;
            LeaveSteamLobby();
            status = "Steam: " + SteamFriends.GetPersonaName();
            Changed();
        }

        void LeaveSteamLobby()
        {
            if (lobby != CSteamID.Nil) SteamMatchmaking.LeaveLobby(lobby);
            lobby = CSteamID.Nil;
            isHost = false;
            lobbyMatch = "";
            state = null;
            if (ready) SteamFriends.ClearRichPresence();
        }

        void Changed() => LobbyChanged?.Invoke();

        public void Shutdown()
        {
            if (!ready) return;
            LeaveSteamLobby();
            foreach (var t in avatars.Values) if (t != null) UnityEngine.Object.Destroy(t);
            avatars.Clear();
            ready = false;
            SteamAPI.Shutdown();
        }
    }
}
