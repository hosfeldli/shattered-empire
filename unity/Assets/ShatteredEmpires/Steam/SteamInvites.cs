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
    public sealed class SteamInvites : ISocialPlatform, IFriendLobbyList, IFriendInvites
    {
        // Every Steam step is logged with this prefix (Player.log: %USERPROFILE%/AppData/LocalLow/Shattered Empires/Shattered Empires/Player.log)
        static void Log(string message) => Debug.Log("[Steam] " + message);
        static void Warn(string message) => Debug.LogWarning("[Steam] " + message);

        public const uint DefaultAppId = 480;
        const string GameKey = "shattered-empires";
        /// <summary>
        /// Lobby data 'se_version': on Spacewar (480) every Steamworks sample shares one lobby namespace, so our
        /// lobbies carry the game key and this build's version, and lists, invites and friend joins only accept
        /// lobbies with both (AddRequestLobbyListStringFilter for the public search).
        /// </summary>
        static string GameVersion => string.IsNullOrEmpty(Application.version) ? "dev" : Application.version;

        // SteamAPI.Init loads gameoverlayrenderer64.dll, which hooks the swap chain's Present: start Steam as early
        // as managed code runs (before the splash screen and the first scene) so the overlay sees every frame.
        static SteamInvites early;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterAssembliesLoaded)]
        static void StartEarly()
        {
            if (early == null) early = new SteamInvites();
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void RegisterPlatform()
        {
            Log("registering the Steam platform (SE.Steam is in this build)");
            SocialPlatform.Register(() => { var s = early ?? new SteamInvites(); early = null; return s; });
        }

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
        CallResult<LobbyMatchList_t> listed;
        Callback<GameOverlayActivated_t> overlayActivated;
        bool hostPublic;
        string persona = "";
        // the overlay hooks the swap chain a few frames after SteamAPI.Init; checked again after start-up
        bool overlayReady, overlayChecked, overlaySeen, pumpLogged;
        float startedAt;
        readonly HashSet<ulong> invited = new HashSet<ulong>();
        readonly List<SocialFriend> onlineFriends = new List<SocialFriend>();
        public bool OverlayReady => ready && (overlayReady || overlaySeen);

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
                Log("starting · game v" + GameVersion + " · graphics " + SystemInfo.graphicsDeviceType + " · cwd " + Directory.GetCurrentDirectory() +
                    " · Steam launch args: " + SteamArgs());
                if (!Packsize.Test() || !DllCheck.Test())
                {
                    status = "Steam libraries are missing from this build; join with a match code instead";
                    Warn("Packsize/DllCheck failed: steam_api64.dll is missing or the wrong version (" + status + ")");
                    return;
                }
                EnsureAppId();
                var init = SteamAPI.InitEx(out string why);
                ready = init == ESteamAPIInitResult.k_ESteamAPIInitResult_OK;
                Log("SteamAPI.InitEx = " + init + (string.IsNullOrEmpty(why) ? "" : " (" + why + ")") + " · SteamAppId env " + Environment.GetEnvironmentVariable("SteamAppId"));
                if (!ready)
                {
                    status = init == ESteamAPIInitResult.k_ESteamAPIInitResult_NoSteamClient
                        ? "Steam is not running; start Steam and sign in, then restart the game (Join by code still works)"
                        : "Steam is not available (" + (string.IsNullOrEmpty(why) ? init.ToString() : why) + "); Join by code still works";
                    Warn(status);
                    return;
                }
                me = SteamUser.GetSteamID();
                persona = SteamFriends.GetPersonaName();
                startedAt = Time.realtimeSinceStartup;
                overlayReady = SteamUtils.IsOverlayEnabled();
                Log("signed in as \"" + persona + "\" (" + me.m_SteamID + ") · logged on " + SteamUser.BLoggedOn() + " · app " + SteamUtils.GetAppID() +
                    " · overlay enabled (at init) " + overlayReady + " · friends " + SteamFriends.GetFriendCount(EFriendFlags.k_EFriendFlagImmediate));
                status = IdleStatus();
                lobbyJoinRequested = Callback<GameLobbyJoinRequested_t>.Create(OnLobbyJoinRequested);
                presenceJoinRequested = Callback<GameRichPresenceJoinRequested_t>.Create(OnPresenceJoinRequested);
                chatUpdate = Callback<LobbyChatUpdate_t>.Create(OnLobbyChatUpdate);
                dataUpdate = Callback<LobbyDataUpdate_t>.Create(OnLobbyDataUpdate);
                personaChange = Callback<PersonaStateChange_t>.Create(OnPersonaChange);
                avatarLoaded = Callback<AvatarImageLoaded_t>.Create(OnAvatarLoaded);
                created = CallResult<LobbyCreated_t>.Create(OnLobbyCreated);
                entered = CallResult<LobbyEnter_t>.Create(OnLobbyEntered);
                listed = CallResult<LobbyMatchList_t>.Create(OnLobbyList);
                overlayActivated = Callback<GameOverlayActivated_t>.Create(OnOverlayActivated);
                SteamFriends.ClearRichPresence();
                // launched by Steam from an invite or "Join Game": +connect_lobby <id> [+se_match <code>]
                if (!ParseConnect(string.Join(" ", Environment.GetCommandLineArgs()), "launch"))
                {
                    if (SteamApps.GetLaunchCommandLine(out string line, 1024) > 0 && !string.IsNullOrEmpty(line))
                    {
                        Log("launch command line from Steam: " + line);
                        ParseConnect(line, "launch");
                    }
                }
            }
            catch (Exception e)
            {
                ready = false;
                status = "Steam is not available: " + e.Message + " (Join by code still works)";
                Debug.LogError("[Steam] start-up failed: " + e);
            }
        }

        /// <summary>Only the '+' arguments Steam passes (+connect_lobby, +se_match); never the whole line, which can hold tokens.</summary>
        static string SteamArgs()
        {
            var keep = new List<string>();
            var args = Environment.GetCommandLineArgs();
            for (int i = 1; i < args.Length; i++)
                if (args[i].StartsWith("+", StringComparison.Ordinal)) { keep.Add(args[i]); if (i + 1 < args.Length) keep.Add(args[++i]); }
            return keep.Count == 0 ? "(none)" : string.Join(" ", keep);
        }

        /// <summary>The status line while nothing is in progress: who is signed in and whether the overlay works.</summary>
        string IdleStatus() =>
            "Steam: " + persona + (OverlayReady ? " · overlay ready (Shift+Tab)"
                : overlayChecked ? " · Steam overlay unavailable: invite friends from the lobby's friend list" : "");

        void OnOverlayActivated(GameOverlayActivated_t r)
        {
            overlaySeen = true;
            Log("overlay " + (r.m_bActive != 0 ? "opened" : "closed") + (r.m_bUserInitiated ? " by the player" : ""));
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
            if (!pumpLogged || frame % 18000 == 0) { pumpLogged = true; Log("RunCallbacks pumping (frame " + frame + ")"); }
            try { SteamAPI.RunCallbacks(); }
            catch (Exception e) { Debug.LogError("[Steam] a callback failed: " + e); }
            if (!overlayChecked && Time.realtimeSinceStartup - startedAt > 4f)
            {
                // the overlay renderer hooks the swap chain after init; ask again once it has had time
                overlayChecked = true;
                overlayReady = SteamUtils.IsOverlayEnabled();
                Log("overlay enabled (after start-up) " + overlayReady + " · graphics " + SystemInfo.graphicsDeviceType +
                    (overlayReady ? "" : " · enable it in Steam › Settings › In Game, or use the lobby's friend list to invite"));
                if (lobby == CSteamID.Nil && !creating && !joining) status = IdleStatus();
                Changed();
            }
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
            hostPublic = request.Public;
            var type = request.Public ? ELobbyType.k_ELobbyTypePublic : ELobbyType.k_ELobbyTypeFriendsOnly;
            created.Set(SteamMatchmaking.CreateLobby(type, max));
            Log("CreateLobby " + type + " max " + max + " for match " + request.MatchCode + " on " + request.Server);
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
                status = "Steam could not create a lobby (" + (failure ? "connection failure" : r.m_eResult.ToString()) + "); friends can still use Join by code";
                Warn("LobbyCreated failed: ioFailure " + failure + " · result " + r.m_eResult + " · request " + (request != null));
                Changed();
                return;
            }
            lobby = new CSteamID(r.m_ulSteamIDLobby);
            isHost = true;
            invited.Clear();
            Log("LobbyCreated OK: lobby " + lobby.m_SteamID + " · owner is me " + (SteamMatchmaking.GetLobbyOwner(lobby) == me));
            ApplyHostData(request);
            status = OverlayReady ? "Steam lobby open: invite friends (overlay or the friend list below)" : "Steam lobby open: invite friends from the list below";
            if (request.OpenInviteDialog) OpenInviteDialog();
            Changed();
        }

        void ApplyHostData(LobbyRequest r)
        {
            lobbyMatch = r.MatchCode;
            string name = string.IsNullOrEmpty(r.Name) ? SteamFriends.GetPersonaName() + "'s match" : r.Name;
            SteamMatchmaking.SetLobbyData(lobby, "se_game", GameKey);
            SteamMatchmaking.SetLobbyData(lobby, "se_version", GameVersion);
            SteamMatchmaking.SetLobbyData(lobby, "se_format", r.Format ?? "");
            SteamMatchmaking.SetLobbyData(lobby, "se_mapname", r.MapName ?? "");
            SteamMatchmaking.SetLobbyData(lobby, "se_match", r.MatchCode);
            // the room's seat count can change (format, map): followers beyond it would find no seat
            SteamMatchmaking.SetLobbyMemberLimit(lobby, Mathf.Clamp(r.MaxMembers, 2, 250));
            if (r.Public != hostPublic)
            {
                hostPublic = r.Public;
                SteamMatchmaking.SetLobbyType(lobby, r.Public ? ELobbyType.k_ELobbyTypePublic : ELobbyType.k_ELobbyTypeFriendsOnly);
            }
            SteamMatchmaking.SetLobbyData(lobby, "se_server", r.Server ?? "");
            SteamMatchmaking.SetLobbyData(lobby, "se_host", SteamFriends.GetPersonaName());
            SteamMatchmaking.SetLobbyData(lobby, "se_ruleset", r.Ruleset ?? "");
            SteamMatchmaking.SetLobbyData(lobby, "se_map", r.MapSize ?? "");
            SteamMatchmaking.SetLobbyData(lobby, "se_team", Mathf.Max(1, r.TeamSize).ToString());
            SteamMatchmaking.SetLobbyData(lobby, "se_status", "lobby");
            SteamMatchmaking.SetLobbyData(lobby, "name", name);
            bool joinable = SteamMatchmaking.SetLobbyJoinable(lobby, true);
            UpdatePresence("lobby");
            Rebuild();
            Log("lobby data set: lobby " + lobby.m_SteamID + " · se_match " + SteamMatchmaking.GetLobbyData(lobby, "se_match") + " · se_version " +
                SteamMatchmaking.GetLobbyData(lobby, "se_version") + " · se_server " + SteamMatchmaking.GetLobbyData(lobby, "se_server") +
                " · format " + r.Format + " · limit " + SteamMatchmaking.GetLobbyMemberLimit(lobby) + " · public " + hostPublic + " · joinable " + joinable +
                " · members " + SteamMatchmaking.GetNumLobbyMembers(lobby));
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
            bool enabled = SteamUtils.IsOverlayEnabled();
            Log("ActivateGameOverlayInviteDialog lobby " + lobby.m_SteamID + " · overlay enabled " + enabled + " · needs present " + SteamUtils.BOverlayNeedsPresent());
            if (!enabled)
                status = "The Steam overlay is not available in this game: invite friends from the list below, or share the match code " + lobbyMatch;
            SteamFriends.ActivateGameOverlayInviteDialog(lobby);
            Changed();
        }

        // ------------------------------------------------------------------ direct invites (no overlay needed)

        public IReadOnlyList<SocialFriend> OnlineFriends()
        {
            onlineFriends.Clear();
            if (!ready) return onlineFriends;
            var app = SteamUtils.GetAppID();
            var members = new HashSet<ulong>();
            if (lobby != CSteamID.Nil)
                for (int i = 0, n = SteamMatchmaking.GetNumLobbyMembers(lobby); i < n; i++) members.Add(SteamMatchmaking.GetLobbyMemberByIndex(lobby, i).m_SteamID);
            int count = SteamFriends.GetFriendCount(EFriendFlags.k_EFriendFlagImmediate);
            for (int i = 0; i < count; i++)
            {
                var f = SteamFriends.GetFriendByIndex(i, EFriendFlags.k_EFriendFlagImmediate);
                if (SteamFriends.GetFriendPersonaState(f) == EPersonaState.k_EPersonaStateOffline) continue;
                bool inGame = SteamFriends.GetFriendGamePlayed(f, out FriendGameInfo_t g) && g.m_gameID.IsValid() && g.m_gameID.AppID() == app;
                onlineFriends.Add(new SocialFriend
                {
                    Id = f.m_SteamID, Name = SteamFriends.GetFriendPersonaName(f), InGame = inGame,
                    InLobby = members.Contains(f.m_SteamID), Invited = invited.Contains(f.m_SteamID),
                });
            }
            onlineFriends.Sort((a, b) => a.InGame != b.InGame ? (a.InGame ? -1 : 1) : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
            return onlineFriends;
        }

        public bool InviteFriend(ulong friendId)
        {
            if (!ready || friendId == 0) return false;
            if (lobby == CSteamID.Nil)
            {
                status = creating ? "The Steam lobby is still opening; try again in a moment" : "Host a lobby first, then invite friends";
                Warn("InviteUserToLobby skipped: no lobby yet (creating " + creating + ")");
                Changed();
                return false;
            }
            var friend = new CSteamID(friendId);
            bool ok = SteamMatchmaking.InviteUserToLobby(lobby, friend);
            string name = SteamFriends.GetFriendPersonaName(friend);
            Log("InviteUserToLobby " + name + " (" + friendId + ") to lobby " + lobby.m_SteamID + " match " + lobbyMatch + " = " + ok);
            if (ok) invited.Add(friendId);
            status = ok ? "Invite sent to " + name + ": they accept it in Steam chat while Shattered Empires is running (or join with code " + lobbyMatch + ")"
                        : "Steam did not send the invite to " + name + "; share the match code " + lobbyMatch;
            Changed();
            return ok;
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
            Log("rich presence: " + phase + (open ? " · connect +connect_lobby " + lobby.m_SteamID + " +se_match " + lobbyMatch : ""));
        }

        // ------------------------------------------------------------------ guest

        void OnLobbyJoinRequested(GameLobbyJoinRequested_t r)
        {
            Log("GameLobbyJoinRequested_t: lobby " + r.m_steamIDLobby.m_SteamID + " from " + SteamFriends.GetFriendPersonaName(r.m_steamIDFriend));
            InviteAccepted?.Invoke(SteamFriends.GetFriendPersonaName(r.m_steamIDFriend));
            Join(r.m_steamIDLobby, "", "invite");
        }

        void OnPresenceJoinRequested(GameRichPresenceJoinRequested_t r)
        {
            Log("GameRichPresenceJoinRequested_t: \"" + r.m_rgchConnect + "\" from " + SteamFriends.GetFriendPersonaName(r.m_steamIDFriend));
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
            if (lobbyId != 0 || code != "") Log("connect line (" + source + "): lobby " + lobbyId + " · code " + code);
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
            Log("JoinLobby " + id.m_SteamID + " (" + source + (string.IsNullOrEmpty(fallbackCode) ? "" : ", fallback code " + fallbackCode) + ")");
            status = "Joining a friend's match…";
            Changed();
        }

        void OnLobbyEntered(LobbyEnter_t r, bool failure)
        {
            joining = false;
            string fallback = joinFallbackCode;
            joinFallbackCode = "";
            var id = new CSteamID(r.m_ulSteamIDLobby);
            Log("LobbyEnter_t: lobby " + id.m_SteamID + " · ioFailure " + failure + " · response " + (EChatRoomEnterResponse)r.m_EChatRoomEnterResponse +
                (failure ? "" : " · se_game " + SteamMatchmaking.GetLobbyData(id, "se_game") + " · se_version " + SteamMatchmaking.GetLobbyData(id, "se_version") +
                    " · se_match " + SteamMatchmaking.GetLobbyData(id, "se_match") + " · se_server " + SteamMatchmaking.GetLobbyData(id, "se_server") +
                    " · se_status " + SteamMatchmaking.GetLobbyData(id, "se_status") + " · members " + SteamMatchmaking.GetNumLobbyMembers(id)));
            if (failure || r.m_EChatRoomEnterResponse != (uint)EChatRoomEnterResponse.k_EChatRoomEnterResponseSuccess)
            {
                if (!failure && id != CSteamID.Nil) SteamMatchmaking.LeaveLobby(id);
                if (fallback != "")
                {
                    status = "The Steam lobby is gone; joining match " + fallback + " directly";
                    Deliver(fallback, "", 0, joinSource);
                }
                else status = "Could not join that Steam lobby (" + (failure ? "no answer from Steam" : ((EChatRoomEnterResponse)r.m_EChatRoomEnterResponse).ToString().Replace("k_EChatRoomEnterResponse", "")) +
                    "); ask the host for the match code and use Join by code";
                Warn(status);
                Changed();
                return;
            }
            lobby = id;
            isHost = SteamMatchmaking.GetLobbyOwner(lobby) == me;
            if (SteamMatchmaking.GetLobbyData(lobby, "se_game") != GameKey)
            {
                status = "That Steam lobby is not a Shattered Empires match";
                Warn(status + " (se_game \"" + SteamMatchmaking.GetLobbyData(lobby, "se_game") + "\")");
                LeaveSteamLobby();
                Changed();
                return;
            }
            string hostVersion = SteamMatchmaking.GetLobbyData(lobby, "se_version");
            if (hostVersion != GameVersion)
            {
                // a different build: the server would refuse it or the rules would differ; say which to update
                status = string.IsNullOrEmpty(hostVersion)
                    ? "That lobby is from an older Shattered Empires build; both players need the same version (you have v" + GameVersion + ")"
                    : "Version mismatch: the host runs v" + hostVersion + ", you have v" + GameVersion + "; update so both match";
                Warn(status);
                LeaveSteamLobby();
                Changed();
                return;
            }
            string code = LobbyMessages.NormalizeCode(SteamMatchmaking.GetLobbyData(lobby, "se_match"));
            if (code == "") code = fallback;
            if (code == "")
            {
                status = "That Steam lobby has no match code yet; ask the host for the code and use Join by code";
                Warn(status);
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
            Log("join match " + code + " on " + (string.IsNullOrEmpty(SafeServer(server)) ? "(the configured server)" : SafeServer(server)) + " · source " + source +
                " · " + (joinRequested != null ? "delivered" : "held until the game listens"));
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
            Log("LobbyChatUpdate_t: " + SteamFriends.GetFriendPersonaName(new CSteamID(r.m_ulSteamIDUserChanged)) + " " + (EChatMemberStateChange)r.m_rgfChatMemberStateChange +
                " · members now " + SteamMatchmaking.GetNumLobbyMembers(lobby));
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
                Version = SteamMatchmaking.GetLobbyData(lobby, "se_version"),
                Format = SteamMatchmaking.GetLobbyData(lobby, "se_format"),
                MapName = SteamMatchmaking.GetLobbyData(lobby, "se_mapname"),
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
                if (!Listable(id)) continue;
                string name = SteamMatchmaking.GetLobbyData(id, "name");
                friendSessions.Add(new FriendLobby
                {
                    LobbyId = kv.Key,
                    FriendName = SteamFriends.GetFriendPersonaName(kv.Value),
                    LobbyName = string.IsNullOrEmpty(name) ? SteamFriends.GetFriendPersonaName(kv.Value) + "'s match" : name,
                    Members = Mathf.Max(1, SteamMatchmaking.GetNumLobbyMembers(id)),
                    MaxMembers = SteamMatchmaking.GetLobbyMemberLimit(id),
                    Detail = Detail(id),
                });
            }
            // public lobbies of this game and version (the search is already filtered on both)
            foreach (var key in publicLobbies)
            {
                if (friendLobbies.ContainsKey(key)) continue;
                var id = new CSteamID(key);
                if (!Listable(id)) continue;
                string host = SteamMatchmaking.GetLobbyData(id, "se_host");
                string name = SteamMatchmaking.GetLobbyData(id, "name");
                friendSessions.Add(new FriendLobby
                {
                    LobbyId = key,
                    FriendName = string.IsNullOrEmpty(host) ? "Public lobby" : host,
                    LobbyName = string.IsNullOrEmpty(name) ? "Public match" : name,
                    Members = Mathf.Max(1, SteamMatchmaking.GetNumLobbyMembers(id)),
                    MaxMembers = SteamMatchmaking.GetLobbyMemberLimit(id),
                    Public = true,
                    Detail = Detail(id),
                });
            }
            return friendSessions;
        }

        /// <summary>A lobby to offer: ours (game key and version), open, and not the one we are in.</summary>
        bool Listable(CSteamID id)
        {
            if (id == lobby) return false;
            if (SteamMatchmaking.GetLobbyData(id, "se_game") != GameKey) return false;       // not ours, or no data yet
            if (SteamMatchmaking.GetLobbyData(id, "se_version") != GameVersion) return false; // another build
            string st = SteamMatchmaking.GetLobbyData(id, "se_status");
            return string.IsNullOrEmpty(st) || st == "lobby";                                // already playing: no seats
        }

        static string Detail(CSteamID id)
        {
            string format = SteamMatchmaking.GetLobbyData(id, "se_format"), map = SteamMatchmaking.GetLobbyData(id, "se_mapname");
            if (format.StartsWith("ffa", StringComparison.Ordinal)) format = "FFA " + format.Substring(3);
            return string.IsNullOrEmpty(map) ? format : string.IsNullOrEmpty(format) ? map : format + " · " + map;
        }

        // ------------------------------------------------------------------ public lobby search (Spacewar subset)
        readonly List<ulong> publicLobbies = new List<ulong>();
        bool searching;

        /// <summary>
        /// Ask Steam for public lobbies carrying this game's key and version (a Spacewar lobby search returns
        /// every Steamworks sample's lobbies otherwise). Results arrive by LobbyMatchList_t.
        /// </summary>
        void SearchPublicLobbies()
        {
            if (!ready || searching) return;
            searching = true;
            SteamMatchmaking.AddRequestLobbyListStringFilter("se_game", GameKey, ELobbyComparison.k_ELobbyComparisonEqual);
            SteamMatchmaking.AddRequestLobbyListStringFilter("se_version", GameVersion, ELobbyComparison.k_ELobbyComparisonEqual);
            SteamMatchmaking.AddRequestLobbyListStringFilter("se_status", "lobby", ELobbyComparison.k_ELobbyComparisonEqual);
            SteamMatchmaking.AddRequestLobbyListDistanceFilter(ELobbyDistanceFilter.k_ELobbyDistanceFilterWorldwide);
            SteamMatchmaking.AddRequestLobbyListResultCountFilter(50);
            listed.Set(SteamMatchmaking.RequestLobbyList());
        }

        void OnLobbyList(LobbyMatchList_t r, bool failure)
        {
            searching = false;
            publicLobbies.Clear();
            Log("LobbyMatchList_t: " + (failure ? "ioFailure" : r.m_nLobbiesMatching + " lobbies of " + GameKey + " v" + GameVersion));
            if (failure) { Changed(); return; }
            for (int i = 0; i < (int)r.m_nLobbiesMatching; i++)
            {
                var id = SteamMatchmaking.GetLobbyByIndex(i);
                if (id.IsValid() && id.IsLobby()) publicLobbies.Add(id.m_SteamID);
            }
            Changed();
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
                if (!friendLobbies.ContainsKey(id.m_SteamID)) Log("friend " + SteamFriends.GetFriendPersonaName(friend) + " is in lobby " + id.m_SteamID + "; requesting its data");
                friendLobbies[id.m_SteamID] = friend;
                SteamMatchmaking.RequestLobbyData(id);    // the data (se_game, name, members) arrives by LobbyDataUpdate_t
            }
            SearchPublicLobbies();
        }

        public void OpenFriendsOverlay()
        {
            if (!ready) return;
            Log("ActivateGameOverlay Friends · overlay enabled " + SteamUtils.IsOverlayEnabled());
            if (!SteamUtils.IsOverlayEnabled())
            {
                status = "The Steam overlay is not available in this game: use the Steam window's friends list (Join Game), or Join by code";
                Changed();
            }
            SteamFriends.ActivateGameOverlay("Friends");
        }

        // ------------------------------------------------------------------ leaving

        public void LeaveLobby()
        {
            if (!ready) return;
            pendingHost = null;
            LeaveSteamLobby();
            status = IdleStatus();
            Changed();
        }

        void LeaveSteamLobby()
        {
            if (lobby != CSteamID.Nil) { Log("LeaveLobby " + lobby.m_SteamID); SteamMatchmaking.LeaveLobby(lobby); }
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
            Log("SteamAPI.Shutdown");
            SteamAPI.Shutdown();
        }
    }
}
