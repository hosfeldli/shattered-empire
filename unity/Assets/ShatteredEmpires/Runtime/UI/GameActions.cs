using System.Collections.Generic;

namespace SE.Runtime.UI
{
    /// <summary>What the New Skirmish screen chose (server match options: world style, size, rivals, difficulty, seed).</summary>
    public sealed class CampaignOptions
    {
        public string Style = "pangaea", MapSize = "medium", Difficulty = "normal", Seed = "", Objective = "domination";
        /// <summary>Starting resources: "low", "standard", "high", "max" (server START_RES in actionGame.js).</summary>
        public string StartRes = "standard";
        /// <summary>A hand-authored map id from the server catalog, or "random" (procedural).</summary>
        public string Map = "random";
        public int Rivals = 1;
        public bool Tutorial, Wrap;
        /// <summary>
        /// Teams and seats: "1v1", "2v2", "3v3", "4v4", "ffa3", "ffa4" (server FORMATS). Null: the old
        /// free-for-all of 1 + <see cref="Rivals"/>. A catalog map fixes it.
        /// </summary>
        public string Format;
        /// <summary>One entry per AI seat in seat order (seat 1 on): its difficulty and personality ("random" allowed).</summary>
        public List<AiSeatOption> Ais = new List<AiSeatOption>();
    }

    /// <summary>One AI of a New Skirmish (server 'rivals' entry).</summary>
    public sealed class AiSeatOption
    {
        public string Difficulty = "normal", Personality = "random";
        /// <summary>The seat is left empty (uneven sides on a random world; server create 'closed').</summary>
        public bool Closed;
    }

    /// <summary>What the interface asks the game to do (implemented by the bootstrap).</summary>
    public interface IGameActions
    {
        void StartMatch(string mode, string match);
        void StartStress();
        void Quit();
        void FocusTile(int tile, float distance);
        void ApplyQuality(string preset);
        void ApplyUiScale(float scale);
        void StartCampaign(CampaignOptions options);
        /// <summary>Open a match lobby: <paramref name="format"/> ("2v2", "ffa4"; null: teamSize v teamSize) on a catalog map or "random".</summary>
        void HostMultiplayer(int teamSize, string map = "random", string format = null);
        /// <summary>A lobby edit for the server (LobbyMessages.Seat/Team/AddAi/RemoveAi/AiSettings/Mode/Map).</summary>
        void SendLobby(Newtonsoft.Json.Linq.JObject message);
        void InviteFriends();
        bool CanInvite { get; }
        string Server { get; set; }
        string PlayerName { get; set; }
        Audio.AudioDirector Audio { get; }

        /// <summary>Host in a match lobby: start now (server 'start'; open human seats become AI).</summary>
        void StartLobbyMatch();
        /// <summary>Leave the match lobby: tell the server, disconnect, leave the platform lobby. The menu stays open.</summary>
        void LeaveLobby();
        /// <summary>This player's ready flag in the match lobby (server 'ready' and the platform lobby).</summary>
        void SetLobbyReady(bool ready);
        /// <summary>Friends, lobbies and invites (Steam, or a no-op platform).</summary>
        SE.Runtime.Social.ISocialPlatform Social { get; }
        /// <summary>A running single-player match whose rules allow pausing.</summary>
        bool CanPause { get; }
        /// <summary>Pause or resume the simulation (ignored when <see cref="CanPause"/> is false).</summary>
        void SetPaused(bool on);
    }

    /// <summary>
    /// Optional platform extension for the "Join a friend" page: friends currently in a Shattered Empires
    /// lobby. A social platform that implements it gets the list; without it the page explains how to join
    /// from the Steam friends list instead. (Spec C5 FriendSessions/RefreshFriends/OpenFriendsOverlay.)
    /// </summary>
    public interface IFriendLobbyList
    {
        IReadOnlyList<FriendLobby> FriendSessions();
        void RefreshFriends();
        void OpenFriendsOverlay();
    }

    public struct FriendLobby
    {
        public ulong LobbyId;
        public string FriendName, LobbyName;
        public int Members, MaxMembers;
        /// <summary>Found by the public lobby search (same game and version), not through a friend.</summary>
        public bool Public;
        /// <summary>Format and map as the host advertises them ("2v2 · Twin Rivers"); may be empty.</summary>
        public string Detail;
    }
}
