using System.Collections.Generic;
using UnityEngine;

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
        /// <summary>With Map "custom": the map-builder sketch (MapSketch.Encode; server sketchMaps.js).</summary>
        public Newtonsoft.Json.Linq.JObject Sketch;
        public int Rivals = 1;
        public bool Tutorial, Wrap;
        /// <summary>
        /// Teams and seats: "1v1", "2v2", "3v3", "4v4", "ffa3", "ffa4" (server FORMATS). Null: the old
        /// free-for-all of 1 + <see cref="Rivals"/>. A catalog map fixes it.
        /// </summary>
        public string Format;
        /// <summary>One entry per AI seat in seat order (seat 1 on): its difficulty and personality ("random" allowed).</summary>
        public List<AiSeatOption> Ais = new List<AiSeatOption>();
        /// <summary>
        /// Watch AI Match: every seat is an AI and you spectate (server mode 'observe'); <see cref="Ais"/> then
        /// starts at seat 0. <see cref="Speed"/> is the starting match speed (1, 2, 4, 8) and
        /// <see cref="ObserverFog"/> starts the view behind the followed nation's fog (WATCH_SETUP.md).
        /// </summary>
        public bool Observe;
        public int Speed = 1;
        public bool ObserverFog;
        /// <summary>Ticket 4: custom match rules (server matchRules.js): starting stockpile, unit speed / range / health.</summary>
        public MatchRulesOptions Rules = new MatchRulesOptions();
        /// <summary>Ticket 4: your seat's resource multiplier (server rules.income[0]); the AI seats carry their own.</summary>
        public float PlayerIncome = 1f;
    }

    /// <summary>
    /// Game creation settings (Ticket 4, server/sim/matchRules.js): starting Materials and Energy (-1: the
    /// starting-resources preset), and multipliers on every unit's speed, weapon range and health. The server validates
    /// the same ranges (RULE_LIMITS) and refuses anything outside them.
    /// </summary>
    public sealed class MatchRulesOptions
    {
        public const int MaxMaterials = 50000, MaxEnergy = 20000;
        public const float MinSpeed = .5f, MaxSpeed = 2f, MinRange = .5f, MaxRange = 2f, MinHealth = .25f, MaxHealth = 4f, MinIncome = .25f, MaxIncome = 4f;
        public int StartMaterials = -1, StartEnergy = -1;
        public float UnitSpeed = 1f, UnitRange = 1f, UnitHealth = 1f;

        /// <summary>Per-seat resource multipliers offered by the setup screens.</summary>
        public static readonly float[] IncomeSteps = { .25f, .5f, .75f, 1f, 1.25f, 1.5f, 2f, 3f, 4f };

        public bool CustomStart => StartMaterials >= 0 || StartEnergy >= 0;
        public bool Standard => !CustomStart && Mathf.Approximately(UnitSpeed, 1f) && Mathf.Approximately(UnitRange, 1f) && Mathf.Approximately(UnitHealth, 1f);

        public MatchRulesOptions Clone() => (MatchRulesOptions)MemberwiseClone();

        static float Round2(float v) => Mathf.Round(v * 100f) / 100f;

        /// <summary>The server's rules object (only the non-standard values; null values clear a lobby rule when <paramref name="explicitNulls"/>).</summary>
        public Newtonsoft.Json.Linq.JObject ToJson(bool explicitNulls = false)
        {
            var o = new Newtonsoft.Json.Linq.JObject();
            void Put(string k, bool on, Newtonsoft.Json.Linq.JToken v) { if (on) o[k] = v; else if (explicitNulls) o[k] = Newtonsoft.Json.Linq.JValue.CreateNull(); }
            Put("startMaterials", StartMaterials >= 0, Mathf.Clamp(StartMaterials, 0, MaxMaterials));
            Put("startEnergy", StartEnergy >= 0, Mathf.Clamp(StartEnergy, 0, MaxEnergy));
            Put("unitSpeed", !Mathf.Approximately(UnitSpeed, 1f), Round2(Mathf.Clamp(UnitSpeed, MinSpeed, MaxSpeed)));
            Put("unitRange", !Mathf.Approximately(UnitRange, 1f), Round2(Mathf.Clamp(UnitRange, MinRange, MaxRange)));
            Put("unitHealth", !Mathf.Approximately(UnitHealth, 1f), Round2(Mathf.Clamp(UnitHealth, MinHealth, MaxHealth)));
            return o;
        }

        /// <summary>Rules from the server (the lobby room's 'rules', the welcome's defs.MATCH_RULES); standard when absent.</summary>
        public static MatchRulesOptions FromJson(Newtonsoft.Json.Linq.JToken t)
        {
            var r = new MatchRulesOptions();
            if (!(t is Newtonsoft.Json.Linq.JObject o)) return r;
            int I(string k, int d) => o[k] != null && (o[k].Type == Newtonsoft.Json.Linq.JTokenType.Integer || o[k].Type == Newtonsoft.Json.Linq.JTokenType.Float) ? (int)(double)o[k] : d;
            float F(string k) => o[k] != null && (o[k].Type == Newtonsoft.Json.Linq.JTokenType.Integer || o[k].Type == Newtonsoft.Json.Linq.JTokenType.Float) ? (float)(double)o[k] : 1f;
            r.StartMaterials = I("startMaterials", -1); r.StartEnergy = I("startEnergy", -1);
            r.UnitSpeed = F("unitSpeed"); r.UnitRange = F("unitRange"); r.UnitHealth = F("unitHealth");
            return r;
        }

        public static string Mult(float v) => (Mathf.Round(v * 100f) / 100f).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + "×";

        /// <summary>"Start 2,000 Materials · Units: speed 1.5×, health 2×" (empty for the standard game).</summary>
        public string Summary()
        {
            var parts = new List<string>();
            if (CustomStart) parts.Add($"Start {(StartMaterials >= 0 ? StartMaterials.ToString("N0") : "preset")} Materials, {(StartEnergy >= 0 ? StartEnergy.ToString("N0") : "preset")} Energy");
            var units = new List<string>();
            if (!Mathf.Approximately(UnitSpeed, 1f)) units.Add("speed " + Mult(UnitSpeed));
            if (!Mathf.Approximately(UnitRange, 1f)) units.Add("range " + Mult(UnitRange));
            if (!Mathf.Approximately(UnitHealth, 1f)) units.Add("health " + Mult(UnitHealth));
            if (units.Count > 0) parts.Add("Units: " + string.Join(", ", units));
            return string.Join(" · ", parts);
        }
    }

    /// <summary>One AI of a New Skirmish (server 'rivals' entry).</summary>
    public sealed class AiSeatOption
    {
        public string Difficulty = "normal", Personality = "random";
        /// <summary>Ticket 4: this seat's resource multiplier (server rules.income).</summary>
        public float Income = 1f;
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
