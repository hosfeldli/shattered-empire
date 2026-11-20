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
        /// <summary>Machine-readable refusal reason the action server may attach (territory, road, spacing, ring, era, foundation); null otherwise.</summary>
        public string ErrorCode;
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
        /// <summary>Action RTS: own aircraft fuel 0-255 (air[1]); -1 when not shown (enemy aircraft, ground units).</summary>
        public int Fuel;
        public WorldMotion Motion;
    }

    public readonly struct WorldPoint
    {
        public readonly float X, Z;
        public WorldPoint(float x, float z) { X = x; Z = z; }
    }

    public struct WorldMotion
    {
        public bool Present;
        public float X, Z, Yaw, Vx, Vz, Cooldown, Altitude;
        public int Equipment;
        /// <summary>Action RTS squads: living men (extra[8]); -1 when not sent.</summary>
        public int Men;
    }

    public struct ObjectiveSite
    {
        public int Id, Tile, Owner, Capturing, Headquarters, Tier, Capacity, RingVersion, VisualTier, DefenseCount;
        /// <summary>Action RTS own bases: perimeter upgrade level (1..3, server `defenseLevel`); 0 when not sent.</summary>
        public int DefenseLevel;
        /// <summary>Own bases (2026-11-20): engineers alive, the tier's quota, the engineer upgrade level (0..3) and seconds until the next replacement (-1: none due).</summary>
        public int Engineers, EngineerQuota, EngineerLevel;
        public float EngineerNext;
        public float X, Z, Radius, Capture, Build, DevelopedAt, Tenure, Maturity;
        /// <summary>
        /// Keyed deltas (Pass 4, capability econ-delta-v1): the server sends the claim time ('ta') instead of a tenure that
        /// changes every frame, and 'ml' while the maturity still grows; <see cref="Rederive"/> recomputes both for a time.
        /// </summary>
        public bool HasTenureAnchor, MaturityLive;
        public float TenureAnchor;
        /// <summary>Tenure and maturity at a snapshot time, from their anchors (a no-op for a site sent with plain values).</summary>
        public void Rederive(float time)
        {
            if (HasTenureAnchor) Tenure = System.Math.Max(0f, time - TenureAnchor);
            if (MaturityLive) Maturity = System.Math.Min(35f, System.Math.Max(0f, time - DevelopedAt));
        }
        public bool IsBase, Contested, Operational, Memory, Starting;
        /// <summary>Capture (W2, R7): progress fell during the last server step (nobody capturing, or a rival draining the claim).</summary>
        public bool Decaying;
        /// <summary>Own captured city without a headquarters (server `settle`, 2026-11-18): the settlement price with its
        /// claim road included, the road's segment count and the base it leads to. SettleMaterials is 0 when not sent.</summary>
        public int SettleMaterials, SettleEnergy, SettleRoad;
        public string SettleTo;
        public string Name, Kind;
        public int[] Slots;
        public BaseParcel[] Parcels;
    }
    public struct BaseParcel { public int Tile, Id, Tier; public float X, Z, Yaw, Width, Depth; public string PreviousType; }
    /// <summary>A supply cache on the map: Amount left of Max; Collecting = units gathering at it now (5 a second each).</summary>
    public struct ResourcePickup { public int Id, Tile, Amount, Max, Collecting; public float X, Z; public bool Memory, Replenishes; public string Resource; }

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
        public bool HasPosition, HasYaw;
        public float X, Z, Yaw;
        public int Missiles, Slot;
        public int RallyGroup;
        /// <summary>Own production: the rally point (econ `ra:[x, z, mode]`), mode 1 attack-move, 0 move.</summary>
        public bool HasRally, RallyAttackMove;
        public float RallyX, RallyZ;
        public string Project;
        /// <summary>
        /// Own production (W1 scheduler, econ <c>qs</c>): one entry per unit type in queue order. Synthesized from the
        /// legacy <c>q</c>/<c>tr</c>/<c>rp</c> fields for older servers (then <see cref="QueuesFromServer"/> is false and
        /// every <see cref="ProductionQueue.State"/> is null). Null when nothing is queued.
        /// </summary>
        public ProductionQueue[] Queues;
        public bool QueuesFromServer;
        /// <summary>Own production: the building's shared production capacity, work units per second (econ <c>cap</c>); 0 when not sent.</summary>
        public float ProductionCapacity;
        /// <summary>W4 garrison (own buildings, econ <c>gar</c>): occupant unit ids in entry order (the first def.firingSlots fire); null when empty.</summary>
        public int[] Garrison;
        /// <summary>W4 garrison exit rally point (econ <c>ge:[x, z]</c>).</summary>
        public bool HasGarrisonExit;
        public float GarrisonExitX, GarrisonExitZ;
        /// <summary>
        /// Base menu rework (2026-11-20, BASE_MENU_REWORK.md). Perimeter turret path (econ <c>pa</c>: "aa", "ai", "av"; null
        /// before one is chosen), the headquarters centre-turret level (<c>gn</c>, 0..3), the perimeter position (<c>ps</c>,
        /// 1..6; 0 for anything else), and for a facility on an outpost plot the outpost's id and plot index (<c>ol</c>, <c>pi</c>).
        /// </summary>
        public string Path;
        public int Gun, PerimeterSlot, OutpostId, Plot;
        /// <summary>Own buildings: the per-building unit upgrade tiers (econ <c>ug</c>: unit type to 1..3); null when none.</summary>
        public System.Collections.Generic.Dictionary<string, int> UnitUpgrades;
        /// <summary>Own buildings: the upgrade being researched (econ <c>rs:[kind, key, level, pct]</c>: kind unit / engineer / gun / path).</summary>
        public string ResearchKind, ResearchKey;
        public int ResearchLevel, ResearchPct;
        /// <summary>Own production: the items in the order they were queued (econ <c>qo</c>); production follows this order.</summary>
        public string[] Order;
        public int UnitUpgrade(string unit) => UnitUpgrades != null && unit != null && UnitUpgrades.TryGetValue(unit, out int t) ? t : 0;
    }

    /// <summary>One unit-type queue of a producing building (server actionProduction.js productionWire <c>qs[i]</c>).</summary>
    public struct ProductionQueue
    {
        public string Unit;
        /// <summary>Items queued, including the one in progress.</summary>
        public int Count;
        /// <summary>0 low, 1 normal, 2 high.</summary>
        public int Priority;
        /// <summary>Progress of the current item, 0..100.</summary>
        public float Progress;
        /// <summary>producing, resources, capacity, prerequisites, exit, paused, waiting, idle; null from a legacy server.</summary>
        public string State;
        public bool Repeat;
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
        public string Kind, Outcome, UnitType, Resource;
        public int Seq, From, To, Shooter, Target, Weapon, Damage, Owner, Amount;
        public float Flight, Radius;
        public bool Airburst;
        /// <summary>'flak' events: burst altitude above ground (y) and puff offsets [dx,dy,dz,...] from the burst centre (p).</summary>
        public float Altitude;
        public float[] Bursts;
        /// <summary>A half-strength strategic blast (a destroyed reactor).</summary>
        public bool Half;
        /// <summary>Barracks upgrades (server actionUpgrades.js): a grenade lob (gr), a squad AT rocket (rk), a marksman shot (mk), a hit absorbed by body armour (ar).</summary>
        public bool Grenade, Rocket, Marksman, Armoured;
        /// <summary>2026-11-18: a sustained-burst round from a bunker MG (bu: its place in the burst, 1..shots; 0 = a single volley) and an IFV anti-tank missile launch (tw).</summary>
        public int BurstRound;
        public bool Tow;
        public bool HasOrigin, HasDestination;
        public WorldPoint Origin, Destination;
    }

    /// <summary>
    /// Server performance on econ snapshots (scale pass 2026-11-20, 'perf'): ticks per wall second achieved against the
    /// target (10 x speed) and mean ms per tick by system group over the last second (-1: not sent). Synthetic marks the
    /// offline stress scene's invented figures.
    /// </summary>
    public sealed class ServerPerf
    {
        public float Tps = -1, Target = -1;
        public float TickMs = -1, PathMs = -1, SimMs = -1, CombatMs = -1, VisMs = -1, AiMs = -1, EconMs = -1, NetMs = -1;
        public bool Synthetic;
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
        public Dictionary<int, WorldPoint[]> WorldPaths = new Dictionary<int, WorldPoint[]>();
        public int[] WorldPathsGone = System.Array.Empty<int>();
        public ObjectiveSite[] Objectives;
        public ResourcePickup[] Pickups;
        public TileRecord[] Tiles;
        public byte[] Visibility;
        public byte[] Urban;
        public CombatEvent[] Events;
        public JObject Weather;
        public bool HasEcon;
        public JObject Econ;
        /// <summary>The stockpile, sent in every snapshot (income accrues per tick; econ only once a second).</summary>
        public JToken Res;
        public BuildingRecord[] Buildings;
        public CityRecord[] Cities;
        public JToken Fieldworks;
        public JObject Battlefield;
        public JObject Observer;
        /// <summary>B7 (2026-11-19): the server's measured pace on econ snapshots (simulated s per real s); -1 when absent.</summary>
        public float Pace = -1;
        /// <summary>Scale pass (2026-11-20): the server's per-second performance block on econ snapshots ('perf'); null when absent.</summary>
        public ServerPerf Perf;
        public JObject ActionPlan;
        // typed presentation records (decoded off the main thread)
        public TrenchRecord[] Trenches;
        public RuinRecord[] Ruins;
        public BattlefieldState BattlefieldState;
        public WeatherState WeatherState;
        // Pass 4 keyed deltas (capability econ-delta-v1, server/delta.js). A full field carries its version (-1: a server
        // without the capability); a delta applies only on top of version Version - 1 (ClientSession checks).
        public int SitesVersion = -1, BuildingsVersion = -1, BattlefieldVersion = -1;
        public KeyedDelta<ObjectiveSite> SitesDelta;
        public KeyedDelta<BuildingRecord> BuildingsDelta;
        public BattlefieldDelta BattlefieldDelta;
    }

    /// <summary>Changed or added records of a keyed field and the keys that left it (server delta.js keyedList).</summary>
    public sealed class KeyedDelta<T>
    {
        public int Version;
        public T[] Updated = System.Array.Empty<T>();
        public int[] Removed = System.Array.Empty<int>();
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
        public int Team;
    }

    public sealed class WelcomeMessage
    {
        public string Match = "", Ruleset = "legacy-v1";
        public int CivId, Seed, W = 128, H = 128, Start = -1;
        public float Speed = 1;
        public bool Wrap = true, Spectator, Sandbox, Paused, CanPause;
        public CivInfo[] Civs = System.Array.Empty<CivInfo>();
        public JObject Defs;
        /// <summary>§30 dense forest (world.dense): bitset, hex t = bit (t &amp; 7) of byte t &gt;&gt; 3; null when the server sends none.</summary>
        public byte[] Dense;
    }
}
