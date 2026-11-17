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
        /// <summary>Seat index (= the civ id in the match) and its team (seat / team size).</summary>
        public int Seat, Team;
        /// <summary>This seat's player hosts the room (the host keeps the role when seats move).</summary>
        public bool IsHost;
        /// <summary>The host left this seat empty: it leaves the match when it starts (uneven sides).</summary>
        public bool Closed;
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
        /// <summary>Number of teams (2 for team modes, 3+ for free-for-all) and the format id ("2v2", "ffa4").</summary>
        public int Teams = 2;
        public string Format = "";
        /// <summary>Catalog map id ("random": a procedural world) and its display name.</summary>
        public string Map = "random", MapName = "";
        /// <summary>With Map "custom": the host's map-builder sketch (server sketchMaps.js, canonical), for the preview.</summary>
        public JObject Sketch;
        /// <summary>The match starts by itself only when every seat is taken and everyone is ready.</summary>
        public bool WaitForReady;
        /// <summary>Your seat index in <see cref="Seats"/>.</summary>
        public int You = -1;
        /// <summary>Human seats still open.</summary>
        public int Open;
        public bool IsHost, CanStart;
        public readonly List<MatchRoomSeat> Seats = new List<MatchRoomSeat>();
        /// <summary>Match rules (host 'options'): victory, starting resources, a random world's style and size key, public listing.</summary>
        public string Objective = "domination", StartRes = "standard", Style = "", SizeKey = "";
        public bool Public;
        /// <summary>You watch this lobby from a spectator seat (You is -1).</summary>
        public bool Spectator;
        /// <summary>Names of the lobby's spectators.</summary>
        public readonly List<string> Spectators = new List<string>();

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
                Map = Str(raw["map"], "random"),
                MapName = Str(raw["mapName"]),
                WaitForReady = Bool(raw["waitForReady"]),
                Objective = Str(raw["objective"], "domination"),
                StartRes = Str(raw["startRes"], "standard"),
                Style = Str(raw["style"]),
                SizeKey = Str(raw["size"]),
                Public = Bool(raw["public"]),
                Spectator = Bool(raw["spectator"]),
                Sketch = raw["sketch"] as JObject,
            };
            if (raw["spectators"] is JArray watchers)
                foreach (var w in watchers) if (w is JObject wo) r.Spectators.Add(Str(wo["name"], "Spectator"));
            int ts = Math.Max(1, r.TeamSize);
            if (raw["slots"] is JArray slots)
                foreach (var t in slots)
                {
                    if (!(t is JObject s)) continue;
                    int seat = r.Seats.Count;
                    r.Seats.Add(new MatchRoomSeat
                    {
                        Seat = seat,
                        Team = Int(s["team"], seat / ts),
                        IsHost = Bool(s["host"]),
                        Name = Str(s["name"]),
                        Human = Bool(s["human"]),
                        Taken = Bool(s["taken"]),
                        Connected = Bool(s["connected"]),
                        Ready = Bool(s["ready"]),
                        Difficulty = Str(s["difficulty"]),
                        Personality = Str(s["personality"]),
                        Closed = Bool(s["closed"]),
                    });
                }
            if (r.Open == 0 && raw["open"] == null)
                foreach (var s in r.Seats) if (s.Human && !s.Taken) r.Open++;
            r.Teams = Int(raw["teams"], Math.Max(1, (r.Seats.Count + ts - 1) / ts));
            r.Format = Str(raw["format"], ts > 1 || r.Teams == 2 ? ts + "v" + ts : "ffa" + r.Teams);
            // older servers: the host is seat 0
            bool anyHost = false;
            foreach (var s in r.Seats) anyHost |= s.IsHost;
            if (!anyHost && r.Seats.Count > 0 && r.Seats[0].Human) r.Seats[0].IsHost = true;
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

        // Room editing (server/matches.js editLobby). The host may edit anything; a player may only move
        // themselves to a free seat (open, or an AI's). Each change comes back as a fresh 'room'.
        /// <summary>Move yourself to seat <paramref name="to"/> (host: <paramref name="seat"/> moves any seat).</summary>
        public static JObject Seat(int to, int seat = -1)
        {
            var o = new JObject { ["t"] = "seat", ["to"] = to };
            if (seat >= 0) o["seat"] = seat;
            return o;
        }
        /// <summary>Move yourself (or, host, <paramref name="seat"/>) to a free seat of <paramref name="team"/> (0-based).</summary>
        public static JObject Team(int team, int seat = -1)
        {
            var o = new JObject { ["t"] = "team", ["team"] = team };
            if (seat >= 0) o["seat"] = seat;
            return o;
        }
        /// <summary>Host: an open seat becomes an AI (that seat, or the first open one).</summary>
        public static JObject AddAi(int seat = -1, string difficulty = null, string personality = null)
        {
            var o = new JObject { ["t"] = "addAi" };
            if (seat >= 0) o["seat"] = seat;
            if (!string.IsNullOrEmpty(difficulty)) o["difficulty"] = difficulty;
            if (!string.IsNullOrEmpty(personality)) o["personality"] = personality;
            return o;
        }
        /// <summary>Host: an AI seat becomes an open seat again.</summary>
        public static JObject RemoveAi(int seat) => new JObject { ["t"] = "removeAi", ["seat"] = seat };
        /// <summary>Host: an AI's difficulty and/or personality (null leaves it).</summary>
        public static JObject AiSettings(int seat, string difficulty, string personality = null)
        {
            var o = new JObject { ["t"] = "aiDifficulty", ["seat"] = seat };
            if (!string.IsNullOrEmpty(difficulty)) o["difficulty"] = difficulty;
            if (!string.IsNullOrEmpty(personality)) o["personality"] = personality;
            return o;
        }
        /// <summary>Host: the format: "1v1", "2v2", "3v3", "4v4", "ffa3", "ffa4" (seated players keep their teams).</summary>
        public static JObject Mode(string format) => new JObject { ["t"] = "mode", ["mode"] = format };
        /// <summary>Host: a catalog map id (sets the format) or "random".</summary>
        public static JObject Map(string map) => new JObject { ["t"] = "map", ["map"] = string.IsNullOrEmpty(map) ? "random" : map };
        /// <summary>Host: play the map-builder sketch (MapSketch.Encode); the server validates it and sends it to everyone in the room.</summary>
        public static JObject CustomMap(JObject sketch) => new JObject { ["t"] = "map", ["map"] = "custom", ["sketch"] = sketch };
        /// <summary>Host: one match rule: "objective", "startRes", "style", "size" (string values) or "public" (bool).</summary>
        public static JObject Option(string key, JToken value) => new JObject { ["t"] = "options", [key] = value };
        /// <summary>Host: leave an empty seat out of the match (uneven sides, random worlds) or open it again.</summary>
        public static JObject CloseSeat(int seat, bool closed) => new JObject { ["t"] = "closeSeat", ["seat"] = seat, ["closed"] = closed };
        /// <summary>A seated player (not the host) moves to the lobby's spectator seats.</summary>
        public static JObject Watch() => new JObject { ["t"] = "watch" };
        /// <summary>A lobby spectator takes an open seat (that one, or the first open seat).</summary>
        public static JObject Sit(int to = -1)
        {
            var o = new JObject { ["t"] = "sit" };
            if (to >= 0) o["to"] = to;
            return o;
        }

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
