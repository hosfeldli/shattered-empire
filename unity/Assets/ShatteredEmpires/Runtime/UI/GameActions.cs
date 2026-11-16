using System.Collections.Generic;

namespace SE.Runtime.UI
{
    /// <summary>What the New Skirmish screen chose (server match options: world style, size, rivals, difficulty, seed).</summary>
    public sealed class CampaignOptions
    {
        public string Style = "pangaea", MapSize = "medium", Difficulty = "normal", Seed = "", Objective = "domination";
        /// <summary>A hand-authored map id from the server catalog, or "random" (procedural).</summary>
        public string Map = "random";
        public int Rivals = 1;
        public bool Tutorial, Wrap;
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
        void HostMultiplayer(int teamSize, string map = "random");
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
    }
}
