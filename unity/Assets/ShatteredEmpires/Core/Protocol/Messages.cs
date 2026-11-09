using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace SE.Core.Protocol
{
    /// <summary>
    /// A decoded server message. Decoding (JSON parse, base64 and array conversion) runs off the main
    /// thread; the main thread only applies the typed result, in wire order.
    /// </summary>
    public sealed class ServerMessage
    {
        public string T = "";
        public int Rid = -1;
        public string Error;
        /// <summary>The parsed JSON, for UI panels and command replies that need fields not typed here.</summary>
        public JObject Raw;
        public SnapshotMessage Snapshot;
        public GeoMessage Geo;
        public WelcomeMessage Welcome;
        /// <summary>Wire size in bytes and decode time, for diagnostics.</summary>
        public int Bytes;
        public double DecodeMs;
        public long Sequence;

        public bool IsReply => Rid >= 0;
    }

    /// <summary>One unit record of an 's' message (server game.js viewerSnapshot).</summary>
    public struct UnitWire
    {
        public int Id, Owner, Tile, Next, Hp, Supply, Flags, Target, Formation, Veteran, Morale, Stance;
        public float Prog;
        public string Type;
        /// <summary>Aircraft state code (owner view: air[0]; others: 0 grounded, 2 airborne), -1 for ground units.</summary>
        public int AirState;
        public int AirMission, AirMissionTile, AirRadius;
    }

    public struct TileRecord
    {
        public int Index, Terrain, Color, Resource, Roads, Flags, FlowDir, FlowBucket, Owner, Stability;
    }

    public struct BuildingRecord
    {
        public int Id, Owner, Tile, Hp, Progress, Level, Tier, City;
        /// <summary>The era the building was built (or last upgraded) in; -1 when the server didn't say (older saves).</summary>
        public int Era;
        public string Type, State;
        public bool Done, Fire, Memory, Active;
        /// <summary>Training queue length and progress of the head item (own buildings).</summary>
        public int QueueLength, TrainProgress;
        /// <summary>Own buildings: the training queue (unit types and seconds left), repeat production.</summary>
        public string[] Queue;
        public string Repeat;
        /// <summary>Own buildings: staffing, why output is limited, upgrade and repair costs, works in progress.</summary>
        public int Staffed, WorksPct;
        public string Why, WorksKind;
        public Newtonsoft.Json.Linq.JObject UpgradeCost;
        public int RepairCost;
    }

    public struct CityRecord
    {
        public int Id, Owner, Tile, Radius, Tier;
        public float Pop;
        public string Name;
        public bool Capital;
        /// <summary>Own cities: Guide Growth plan (kind, tile, built, target) and the mayor.</summary>
        public string GrowthKind, Priority, Activity;
        public int GrowthTile, GrowthBuilt, GrowthTarget, Housing, Jobs, Unemployed, Stability;
        public bool MayorOn;
        public float GrowthRate;
    }

    /// <summary>A combat event (server combat.js emit): fire, launch, hit, bhit, impact, supp, kill.</summary>
    public struct CombatEvent
    {
        public string Kind, Outcome, UnitType;
        public int Seq, From, To, Shooter, Target, Weapon, Damage, Owner;
        public float Flight, Radius;
        public bool Airburst;
        /// <summary>A half-strength strategic blast (a destroyed reactor).</summary>
        public bool Half;
    }

    public sealed class SnapshotMessage
    {
        public float Time;
        public int Tick;
        public bool Reset;
        /// <summary>Capability 'udelta': only changed unit records are listed; Gone lists ids that left view.</summary>
        public bool Delta;
        public UnitWire[] Units = System.Array.Empty<UnitWire>();
        public int[] Gone = System.Array.Empty<int>();
        public Dictionary<int, int[]> Paths = new Dictionary<int, int[]>();
        public int[] PathsGone = System.Array.Empty<int>();
        public TileRecord[] Tiles;
        public byte[] Visibility;
        public byte[] Urban;
        public CombatEvent[] Events;
        public JObject Weather;
        public bool HasEcon;
        public JObject Econ;
        public BuildingRecord[] Buildings;
        public CityRecord[] Cities;
        public JToken Fieldworks;
        public JObject Battlefield;
        public JObject Observer;
        // typed presentation records (decoded off the main thread)
        public TrenchRecord[] Trenches;
        public RuinRecord[] Ruins;
        public BattlefieldState BattlefieldState;
        public WeatherState WeatherState;
    }

    public sealed class GeoChunk
    {
        public int Cx, Cy;
        public byte[] Mask, Data;
    }

    public sealed class GeoMessage
    {
        public bool Full;
        public int ChunkSize = 16, Stride = 6, W, H;
        public List<GeoChunk> Chunks = new List<GeoChunk>();
    }

    public struct CivInfo
    {
        public int Id;
        public string Name;
        public uint Color;   // 0xRRGGBB
        public bool Human, Rebel;
    }

    public sealed class WelcomeMessage
    {
        public string Match = "", Ruleset = "legacy-v1";
        public int CivId, Seed, W = 128, H = 128, Start = -1;
        public float Speed = 1;
        public bool Wrap = true, Spectator, Sandbox, Paused, CanPause;
        public CivInfo[] Civs = System.Array.Empty<CivInfo>();
        public JObject Defs;
    }
}
