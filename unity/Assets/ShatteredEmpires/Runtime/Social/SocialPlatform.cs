using System;
using System.Collections.Generic;
using UnityEngine;

namespace SE.Runtime.Social
{
    /// <summary>One player in the platform (Steam) lobby.</summary>
    public sealed class LobbyMember
    {
        public ulong Id;
        public string Name = "";
        public bool IsHost;
        public bool IsYou;
        /// <summary>The member's own "ready" flag (lobby member data; see <see cref="ISocialPlatform.SetReady"/>).</summary>
        public bool Ready;
        /// <summary>Medium Steam avatar (64x64), or null while Steam is still downloading it.</summary>
        public Texture2D Avatar;
    }

    /// <summary>The platform lobby this player is in (null when none). Rebuilt on every change.</summary>
    public sealed class LobbyState
    {
        public ulong Id;
        public bool IsHost;
        /// <summary>The game server's match code this lobby belongs to.</summary>
        public string MatchCode = "";
        /// <summary>The game server the match runs on (ws/wss URL), empty when the host did not say.</summary>
        public string Server = "";
        public string Name = "";
        public string HostName = "";
        public string Ruleset = "";
        public string MapSize = "";
        public int TeamSize = 1;
        /// <summary>"lobby" before the match starts, "running" after.</summary>
        public string Status = "lobby";
        /// <summary>The host's game version (lobby data se_version) and the room's format and map, as advertised.</summary>
        public string Version = "", Format = "", MapName = "";
        public IReadOnlyList<LobbyMember> Members = Array.Empty<LobbyMember>();
    }

    /// <summary>What the host tells the platform lobby about the server match.</summary>
    public sealed class LobbyRequest
    {
        public string MatchCode = "";
        public string Server = "";
        /// <summary>Lobby title shown to friends; defaults to "&lt;persona&gt;'s match".</summary>
        public string Name = "";
        public string Ruleset = "";
        public string MapSize = "";
        public int TeamSize = 1;
        /// <summary>Steam lobby capacity (players who can follow invites); 2..250.</summary>
        public int MaxMembers = 8;
        /// <summary>Open the Steam overlay invite dialog as soon as the lobby exists.</summary>
        public bool OpenInviteDialog;
        /// <summary>The room's format ("2v2", "ffa4") and map name, shown in lobby lists.</summary>
        public string Format = "", MapName = "";
        /// <summary>Listed in the public lobby search (same game and version) as well as to friends.</summary>
        public bool Public;
    }

    /// <summary>A request to join a server match that came from the platform (invite, friends list, launch argument).</summary>
    public sealed class SocialJoin
    {
        public string MatchCode = "";
        /// <summary>The host's game server URL (empty: use the configured server). Sanitise with LaunchOptions.ResolveServer.</summary>
        public string Server = "";
        public ulong LobbyId;
        /// <summary>"invite", "friends-list", "launch" or "lobby".</summary>
        public string Source = "";
    }

    /// <summary>
    /// Friends, lobbies and invites around a server-run match (Steam today). The platform never carries game
    /// traffic: the host's friends-only lobby carries the server's match code (and server URL), and accepting
    /// an invite, joining from the Steam friends list, or launching with +connect_lobby joins that lobby, reads
    /// the code and raises <see cref="JoinRequested"/>; the game then joins the match on the authoritative
    /// server with the ordinary "join" message. A match code typed by hand works with or without Steam.
    /// Callbacks are pumped every frame by a hidden object (see <see cref="SocialPlatform"/>); calling
    /// <see cref="Tick"/> again in the same frame does nothing.
    /// </summary>
    public interface ISocialPlatform
    {
        bool Available { get; }
        /// <summary>Human-readable state for the menu ("Steam: Alice", "Opening a Steam lobby…", why Steam is off).</summary>
        string Status { get; }
        string PlayerName { get; }
        ulong LocalId { get; }
        /// <summary>The lobby this player is in, or null.</summary>
        LobbyState Lobby { get; }
        /// <summary>True while a lobby is being created or joined.</summary>
        bool Busy { get; }
        /// <summary>The last join the platform asked for (server URL, lobby id), kept after <see cref="JoinRequested"/> fires.</summary>
        SocialJoin LastJoin { get; }

        /// <summary>Host: open a friends-only lobby for this server match (or update the one already hosted).</summary>
        void HostLobby(LobbyRequest request);
        /// <summary>Open the Steam overlay invite dialog for the current lobby.</summary>
        void InviteFriends();
        /// <summary>Open (or reuse) a lobby for this match code and show the invite dialog (in-game invite button).</summary>
        void InviteFriends(string matchCode, string matchName);
        /// <summary>Join a Steam lobby by id; on success <see cref="JoinRequested"/> fires with its match code.</summary>
        void JoinLobby(ulong lobbyId);
        /// <summary>Leave the platform lobby and clear rich presence (does not leave the server match).</summary>
        void LeaveLobby();
        /// <summary>This player's ready flag, mirrored in the lobby member list.</summary>
        void SetReady(bool ready);
        /// <summary>"lobby" or "running": host marks the lobby (a running match takes no more invites); everyone's rich presence follows.</summary>
        void SetLobbyStatus(string status);

        /// <summary>
        /// Join this server match (code). Fires once per accepted invite / friends-list join / +connect_lobby
        /// launch; a request that arrives before anyone subscribes is delivered on subscription.
        /// </summary>
        event Action<string> JoinRequested;
        /// <summary>An invite was accepted (argument: the friend's name); the lobby join is in progress.</summary>
        event Action<string> InviteAccepted;
        /// <summary>Lobby, members, ready flags, avatars or <see cref="Status"/> changed.</summary>
        event Action LobbyChanged;

        void Tick();
        void Shutdown();
    }

    /// <summary>An online Steam friend the host can invite straight from the lobby page (no overlay needed).</summary>
    public sealed class SocialFriend
    {
        public ulong Id;
        public string Name = "";
        /// <summary>Running this game (the Steam app id) right now: an invite reaches them in the game.</summary>
        public bool InGame;
        /// <summary>Already a member of our platform lobby.</summary>
        public bool InLobby;
        /// <summary>Invited from this lobby already (this session).</summary>
        public bool Invited;
    }

    /// <summary>
    /// Optional platform extension: invite a friend to the current lobby directly (Steam
    /// ISteamMatchmaking::InviteUserToLobby). Works when the Steam overlay cannot hook the game; the friend
    /// gets the invite in Steam chat and accepting it while Shattered Empires runs joins the lobby.
    /// </summary>
    public interface IFriendInvites
    {
        /// <summary>Online friends, those running this game first.</summary>
        IReadOnlyList<SocialFriend> OnlineFriends();
        /// <summary>Send a lobby invite to this friend; false when there is no lobby yet or Steam refused.</summary>
        bool InviteFriend(ulong friendId);
        /// <summary>The Steam overlay hooked this game (Shift+Tab works, the invite dialog can open).</summary>
        bool OverlayReady { get; }
    }

    public static class SocialPlatform
    {
        sealed class None : ISocialPlatform
        {
            public bool Available => false;
            public string Status => "Steam is not part of this build; share the match code instead";
            public string PlayerName => "";
            public ulong LocalId => 0;
            public LobbyState Lobby => null;
            public bool Busy => false;
            public SocialJoin LastJoin => null;
            public void HostLobby(LobbyRequest request) { }
            public void InviteFriends() { }
            public void InviteFriends(string matchCode, string matchName) { }
            public void JoinLobby(ulong lobbyId) { }
            public void LeaveLobby() { }
            public void SetReady(bool ready) { }
            public void SetLobbyStatus(string status) { }
            public event Action<string> JoinRequested { add { } remove { } }
            public event Action<string> InviteAccepted { add { } remove { } }
            public event Action LobbyChanged { add { } remove { } }
            public void Tick() { }
            public void Shutdown() { }
        }

        /// <summary>The platform if it has been created (the pump never creates one).</summary>
        internal static ISocialPlatform Created => current;

        static ISocialPlatform current;
        static Func<ISocialPlatform> factory;
        static GameObject pump;

        /// <summary>Platform assemblies (SE.Steam) register themselves at start-up.</summary>
        public static void Register(Func<ISocialPlatform> create) => factory = create;

        public static ISocialPlatform Current
        {
            get
            {
                if (current == null)
                {
                    try { current = factory != null ? factory() : new None(); }
                    catch (Exception e) { Debug.LogError("[Steam] Social platform failed to start: " + e); current = new None(); }
                    Debug.Log("[Steam] Social platform: " + current.GetType().Name + (factory == null ? " (no platform assembly registered)" : "") +
                        " · available=" + current.Available + " · " + current.Status);
                    EnsurePump();
                }
                return current;
            }
        }

        static void EnsurePump()
        {
            if (pump != null || !Application.isPlaying) return;
            pump = new GameObject("SocialPlatform") { hideFlags = HideFlags.HideInHierarchy };
            UnityEngine.Object.DontDestroyOnLoad(pump);
            pump.AddComponent<SocialPlatformPump>();
        }

        // statics survive between play sessions when domain reload is off
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics() { current = null; factory = null; pump = null; }

        // start Steam as the first scene opens so an invite accepted (or +connect_lobby) is handled from the menu on
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot() { _ = Current; }
    }
}
