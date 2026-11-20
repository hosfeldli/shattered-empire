using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Core.Units;
using UnityEngine;

namespace SE.Runtime.Horde
{
    /// <summary>The Blight's creature kinds (server sim/hordeDefs.js CREATURES).</summary>
    public enum CreatureKind { Crawler, Husk, Spitter, Mauler, Broodsac, Colossus, Hive, None }

    /// <summary>Unit types of the Blight (prefix 'blight_'), cached per type index so the unit renderer can skip them cheaply.</summary>
    public static class HordeTypes
    {
        public const string Prefix = "blight_";
        static sbyte[] cache = new sbyte[64];
        static UnitTypes cachedFor;

        public static bool Is(string type) => type != null && type.StartsWith(Prefix, StringComparison.Ordinal);

        /// <summary>Whether a unit type index (of this store's type table) is a Blight creature.</summary>
        public static bool Is(UnitTypes types, int index)
        {
            if (index < 0 || types == null) return false;
            if (!ReferenceEquals(types, cachedFor)) { cachedFor = types; Array.Clear(cache, 0, cache.Length); }
            if (index >= cache.Length) Array.Resize(ref cache, Math.Max(index + 1, cache.Length * 2));
            sbyte c = cache[index];
            if (c == 0) cache[index] = c = (sbyte)(Is(types.Name(index)) ? 1 : -1);
            return c > 0;
        }

        public static CreatureKind KindOf(string type)
        {
            switch (type)
            {
                case "blight_crawler": return CreatureKind.Crawler;
                case "blight_husk": return CreatureKind.Husk;
                case "blight_spitter": return CreatureKind.Spitter;
                case "blight_mauler": return CreatureKind.Mauler;
                case "blight_broodsac": return CreatureKind.Broodsac;
                case "blight_colossus": return CreatureKind.Colossus;
                case "blight_hive": return CreatureKind.Hive;
                default: return CreatureKind.None;
            }
        }

        public static string Name(CreatureKind k) => k switch
        {
            CreatureKind.Crawler => "Crawler", CreatureKind.Husk => "Husk", CreatureKind.Spitter => "Spitter", CreatureKind.Mauler => "Mauler",
            CreatureKind.Broodsac => "Broodsac", CreatureKind.Colossus => "Colossus", CreatureKind.Hive => "Blight Hive", _ => "Creature",
        };
    }

    /// <summary>
    /// The snapshot's 'horde' block (server sim/horde.js hordeWire): wave counter and phase, countdown, creatures left,
    /// score, hives with their corrupted-ground radius, threat clusters, tunnelling warnings, elite levels and statistics.
    /// </summary>
    public sealed class HordeState
    {
        public const int Prep = 0, Breather = 1, Wave = 2, Over = 3;
        public struct Hive { public int Id; public float X, Z; public int Radius, Hp; }
        public struct Threat { public float X, Z; public int Count, Heavy; }

        public bool Active;
        public int WaveNo, Phase, Countdown, Left, Live, Cap, Total, Score, Survived;
        public float Level;
        public bool BossNext;
        public int Killed, HivesBurned, Risen, Lost, Peak, Cleared, Bosses;
        public readonly List<Hive> Hives = new List<Hive>();
        public readonly List<Threat> Threats = new List<Threat>();
        public readonly List<Vector2> Burrows = new List<Vector2>();
        public readonly Dictionary<int, int> Elite = new Dictionary<int, int>();
        /// <summary>Bumped when the hive list (positions or blight radii) changes: the corrupted ground is rebuilt.</summary>
        public int HiveRevision;
        public float ReceivedAt;
        string hiveKey = "";

        public void Reset()
        {
            Active = false; WaveNo = Phase = Countdown = Left = Live = Total = Score = Survived = 0;
            Hives.Clear(); Threats.Clear(); Burrows.Clear(); Elite.Clear(); hiveKey = ""; HiveRevision++;
        }

        public void Apply(JObject h, float time)
        {
            if (h == null) return;
            Active = true;
            ReceivedAt = time;
            WaveNo = ProtocolDecoder.Int(h["w"]);
            Phase = ProtocolDecoder.Int(h["ph"]);
            Countdown = ProtocolDecoder.Int(h["t"]);
            Left = ProtocolDecoder.Int(h["left"]);
            Live = ProtocolDecoder.Int(h["live"]);
            Cap = ProtocolDecoder.Int(h["cap"], 160);
            Total = ProtocolDecoder.Int(h["total"]);
            Score = ProtocolDecoder.Int(h["sc"]);
            Survived = ProtocolDecoder.Int(h["st"]);
            Level = ProtocolDecoder.Float(h["lvl"]);
            BossNext = ProtocolDecoder.Int(h["boss"]) == 1;
            if (h["hv"] is JArray hv)
            {
                Hives.Clear();
                var key = new System.Text.StringBuilder();
                foreach (var t in hv)
                {
                    if (!(t is JArray a) || a.Count < 5) continue;
                    var hive = new Hive { Id = ProtocolDecoder.Int(a[0]), X = ProtocolDecoder.Float(a[1]), Z = ProtocolDecoder.Float(a[2]), Radius = ProtocolDecoder.Int(a[3]), Hp = ProtocolDecoder.Int(a[4]) };
                    Hives.Add(hive);
                    key.Append(hive.Id).Append(':').Append(hive.Radius).Append(',');
                }
                string k = key.ToString();
                if (k != hiveKey) { hiveKey = k; HiveRevision++; }
            }
            Threats.Clear();
            if (h["th"] is JArray th)
                foreach (var t in th)
                    if (t is JArray a && a.Count >= 4)
                        Threats.Add(new Threat { X = ProtocolDecoder.Float(a[0]), Z = ProtocolDecoder.Float(a[1]), Count = ProtocolDecoder.Int(a[2]), Heavy = ProtocolDecoder.Int(a[3]) });
            Burrows.Clear();
            if (h["bw"] is JArray bw)
                foreach (var t in bw)
                    if (t is JArray a && a.Count >= 2) Burrows.Add(new Vector2(ProtocolDecoder.Float(a[0]), ProtocolDecoder.Float(a[1])));
            if (h["el"] is JObject el)
            {
                Elite.Clear();
                foreach (var p in el) if (int.TryParse(p.Key, out int id)) Elite[id] = ProtocolDecoder.Int(p.Value);
            }
            if (h["stats"] is JObject st)
            {
                Killed = ProtocolDecoder.Int(st["killed"]); HivesBurned = ProtocolDecoder.Int(st["hives"]); Risen = ProtocolDecoder.Int(st["risen"]);
                Lost = ProtocolDecoder.Int(st["lost"]); Peak = ProtocolDecoder.Int(st["peak"]); Cleared = ProtocolDecoder.Int(st["cleared"]); Bosses = ProtocolDecoder.Int(st["bosses"]);
            }
        }

        public int EliteOf(int id) => Elite.TryGetValue(id, out int e) ? e : 0;

        /// <summary>0 (calm) to 1 (a big wave on top of you): drives the music, the gloom and the camera.</summary>
        public float Pressure => !Active ? 0f : Phase == Wave ? Mathf.Clamp01(.45f + .55f * Live / Mathf.Max(20f, Cap * .6f)) : Phase == Over ? 0f : Mathf.Clamp01(.15f + .25f * Live / Mathf.Max(20f, Cap * .6f));
    }
}
