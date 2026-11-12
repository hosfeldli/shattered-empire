using System;
using SE.Runtime.Social;
using Steamworks;
using UnityEngine;

namespace SE.Steam
{
    /// <summary>
    /// Steam friends, lobbies and invites (Steamworks.NET). Same design as desktop/steam.cjs: the
    /// host's friends-only lobby carries the server's match code ('se_match'); accepting an invite in
    /// the overlay or chat, or launching with +connect_lobby, joins the lobby, reads the code and joins
    /// that match on the game server. No game traffic goes through Steam.
    /// Uses Spacewar (480) until the game has its own app id; steam_appid.txt sits next to the player.
    /// </summary>
    public sealed class SteamInvites : ISocialPlatform
    {
        public const uint AppId = 480;
        const string GameKey = "shattered-empires";

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void RegisterPlatform() => SocialPlatform.Register(() => new SteamInvites());

        bool ready;
        string status = "Steam is starting…";
        CSteamID lobby = CSteamID.Nil;
        string lobbyMatch;
        string pendingMatch, pendingName;
        Callback<GameLobbyJoinRequested_t> joinRequested;
        CallResult<LobbyCreated_t> created;
        CallResult<LobbyEnter_t> entered;

        public bool Available => ready;
        public string Status => status;
        public string PlayerName => ready ? SteamFriends.GetPersonaName() : "";
        public event Action<string> JoinRequested;

        public SteamInvites()
        {
            try
            {
                if (!Packsize.Test() || !DllCheck.Test()) { status = "Steam libraries are missing from this build"; return; }
                ready = SteamAPI.Init();
                if (!ready) { status = "Steam is not available (is the Steam client running and signed in?)"; return; }
                status = "Steam: " + SteamFriends.GetPersonaName();
                joinRequested = Callback<GameLobbyJoinRequested_t>.Create(OnJoinRequested);
                created = CallResult<LobbyCreated_t>.Create(OnLobbyCreated);
                entered = CallResult<LobbyEnter_t>.Create(OnLobbyEntered);
                // launched by Steam from an invite: +connect_lobby <id>
                var args = Environment.GetCommandLineArgs();
                for (int i = 0; i + 1 < args.Length; i++)
                    if (args[i] == "+connect_lobby" && ulong.TryParse(args[i + 1], out ulong id)) Join(new CSteamID(id));
            }
            catch (Exception e)
            {
                ready = false;
                status = "Steam is not available: " + e.Message;
            }
        }

        public void Tick() { if (ready) SteamAPI.RunCallbacks(); }

        public void InviteFriends(string matchCode, string matchName)
        {
            if (!ready || string.IsNullOrEmpty(matchCode)) return;
            if (lobby != CSteamID.Nil && lobbyMatch == matchCode) { SteamFriends.ActivateGameOverlayInviteDialog(lobby); return; }
            Leave();
            pendingMatch = matchCode;
            pendingName = string.IsNullOrEmpty(matchName) ? SteamFriends.GetPersonaName() + "'s match" : matchName;
            created.Set(SteamMatchmaking.CreateLobby(ELobbyType.k_ELobbyTypeFriendsOnly, 8));
            status = "Opening a Steam lobby…";
        }

        void OnLobbyCreated(LobbyCreated_t r, bool failure)
        {
            if (failure || r.m_eResult != EResult.k_EResultOK) { status = "Steam could not create a lobby (" + r.m_eResult + ")"; return; }
            lobby = new CSteamID(r.m_ulSteamIDLobby);
            lobbyMatch = pendingMatch;
            SteamMatchmaking.SetLobbyData(lobby, "se_game", GameKey);
            SteamMatchmaking.SetLobbyData(lobby, "se_match", pendingMatch);
            SteamMatchmaking.SetLobbyData(lobby, "name", pendingName);
            status = "Invite friends from the Steam overlay";
            SteamFriends.ActivateGameOverlayInviteDialog(lobby);
        }

        void OnJoinRequested(GameLobbyJoinRequested_t r) => Join(r.m_steamIDLobby);

        void Join(CSteamID id)
        {
            Leave();
            entered.Set(SteamMatchmaking.JoinLobby(id));
            status = "Joining a friend's match…";
        }

        void OnLobbyEntered(LobbyEnter_t r, bool failure)
        {
            if (failure) { status = "Could not join that Steam lobby"; return; }
            lobby = new CSteamID(r.m_ulSteamIDLobby);
            if (SteamMatchmaking.GetLobbyData(lobby, "se_game") != GameKey) { status = "That Steam lobby is not a Shattered Empires match"; Leave(); return; }
            string code = SteamMatchmaking.GetLobbyData(lobby, "se_match");
            if (string.IsNullOrEmpty(code)) { status = "The lobby has no match"; Leave(); return; }
            lobbyMatch = code;
            status = "Joining match " + code;
            JoinRequested?.Invoke(code);
        }

        void Leave()
        {
            if (lobby != CSteamID.Nil) { SteamMatchmaking.LeaveLobby(lobby); lobby = CSteamID.Nil; lobbyMatch = null; }
        }

        public void Shutdown()
        {
            if (!ready) return;
            Leave();
            SteamAPI.Shutdown();
            ready = false;
        }
    }
}
