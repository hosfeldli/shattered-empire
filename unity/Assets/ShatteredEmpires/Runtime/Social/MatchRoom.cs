using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace SE.Runtime.Social
{
    /// <summary>One seat of a multiplayer match that has not started (server 'room' message).</summary>
    public sealed class MatchRoomSeat
    {
        public string Name = "";
        public bool Human;
        /// <summary>A player holds this human seat (false: open, waiting for a friend).</summary>
        public bool Taken;
        public bool Connected;
        public bool Ready;
        /// <summary>AI seats only.</summary>
        public string Difficulty = "", Personality = "";
    }

    /// <summary>
    /// The server's pre-game lobby for a pvp match, as this player sees it (server/matches.js roomUpdate):
    /// the code to share, the seats, which one is yours and whether you may start. The server sends a
    /// 'room' message on every change while the match is in the lobby; the match starts when the host
    /// sends <see cref="LobbyMessages.Start"/> (open seats become AI) or when every human seat is taken,
    /// and the usual 'welcome' follows.
    /// </summary>
    public sealed class MatchRoom
    {
        public string Code = "";
        public string Name = "";
        public string Status = "lobby";
        public string Mode = "";
        public string Ruleset = "";
        public string Host = "";
        public int MapSize, TeamSize = 1;
        /// <summary>Your seat index in <see cref="Seats"/>.</summary>
        public int You = -1;
        /// <summary>Human seats still open.</summary>
        public int Open;
        public bool IsHost, CanStart;
        public readonly List<MatchRoomSeat> Seats = new List<MatchRoomSeat>();

        /// <summary>Parse a server 'room' message (ServerMessage.Raw); null for anything else.</summary>
        public static MatchRoom Parse(JObject raw)
        {
            if (raw == null || Str(raw["t"]) != "room") return null;
            var r = new MatchRoom
            {
                Code = Str(raw["code"], Str(raw["match"])),
                Name = Str(raw["name"]),
                Status = Str(raw["status"], "lobby"),
                Mode = Str(raw["mode"]),
                Ruleset = Str(raw["ruleset"]),
                Host = Str(raw["host"]),
                MapSize = Int(raw["mapSize"], 0),
                TeamSize = Int(raw["teamSize"], 1),
                You = Int(raw["you"], -1),
                Open = Int(raw["open"], 0),
                IsHost = Bool(raw["isHost"]),
                CanStart = Bool(raw["canStart"]),
            };
            if (raw["slots"] is JArray slots)
                foreach (var t in slots)
                {
                    if (!(t is JObject s)) continue;
                    r.Seats.Add(new MatchRoomSeat
                    {
                        Name = Str(s["name"]),
                        Human = Bool(s["human"]),
                        Taken = Bool(s["taken"]),
                        Connected = Bool(s["connected"]),
                        Ready = Bool(s["ready"]),
                        Difficulty = Str(s["difficulty"]),
                        Personality = Str(s["personality"]),
                    });
                }
            if (r.Open == 0 && raw["open"] == null)
                foreach (var s in r.Seats) if (s.Human && !s.Taken) r.Open++;
            return r;
        }

        static string Str(JToken t, string fallback = "") => t != null && t.Type != JTokenType.Null ? (string)t ?? fallback : fallback;
        static int Int(JToken t, int fallback) => t != null && (t.Type == JTokenType.Integer || t.Type == JTokenType.Float) ? (int)t : fallback;
        static bool Bool(JToken t) => t != null && t.Type == JTokenType.Boolean && (bool)t;
    }

    /// <summary>Lobby control messages for GameConnection.Send (server/matches.js).</summary>
    public static class LobbyMessages
    {
        /// <summary>Host only: start now; open human seats become AI.</summary>
        public static JObject Start() => new JObject { ["t"] = "start" };
        /// <summary>Your ready flag in the room.</summary>
        public static JObject Ready(bool on) => new JObject { ["t"] = "ready", ["on"] = on };
        /// <summary>Ask for the room again (the server answers with a 'room' message).</summary>
        public static JObject Room() => new JObject { ["t"] = "room" };
        /// <summary>Leave before the match starts: a guest frees the seat; the host closes the lobby ('lobbyClosed' to the others).</summary>
        public static JObject Leave() => new JObject { ["t"] = "leave" };

        /// <summary>
        /// A match code as typed or pasted ("#AB12CD ", "ab12cd") in the form the server uses; empty when it
        /// cannot be a code. Server codes are 6 lowercase hex characters.
        /// </summary>
        public static string NormalizeCode(string code)
        {
            if (string.IsNullOrWhiteSpace(code)) return "";
            var s = code.Trim().TrimStart('#').Trim().ToLowerInvariant();
            if (s.Length == 0 || s.Length > 32) return "";
            foreach (char c in s) if (!(c >= '0' && c <= '9' || c >= 'a' && c <= 'z')) return "";
            return s;
        }
    }
}
