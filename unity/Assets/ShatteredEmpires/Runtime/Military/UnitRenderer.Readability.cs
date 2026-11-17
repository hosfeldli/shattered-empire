using System;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Military
{
    /// <summary>
    /// Readability (2026-11-16 feedback): every ground unit has a team-coloured outline circle that keeps a
    /// minimum on-screen size at any zoom; enemy units carry a floating role glyph (what the unit is); soldiers
    /// wear their team colour on the helmet and shoulders (a skinned overlay mesh on the same bones); squads show
    /// as many men as they have left (the server's man count follows squad health, so casualties remove men).
    /// Nothing here allocates per frame and every instance count is bounded by the units drawn.
    /// </summary>
    public sealed partial class UnitRenderer
    {
        /// <summary>Whether an owner is hostile to the viewer (enemy role glyphs). Unset: no glyphs.</summary>
        public Func<int, bool> IsHostile;
        /// <summary>
        /// Optional exact men count for a unit id (a server field when one exists); -1 or unset falls back to the
        /// squad's full strength scaled by its health, which is how the server scales squad HP with its men.
        /// </summary>
        public Func<int, int> MenOf;

        // team overlay (helmet / cap and shoulder pads) per rig role, drawn with the same baked animation frame
        readonly InstanceBatch[] soldierTeam = new InstanceBatch[7];
        // floating role glyphs: billboarded plates, no shadows
        InstanceBatch glyphs;
        byte[] menMax = new byte[0];
        float3 figureTeam = new float3(.8f, .8f, .8f);
        quaternion cameraRotation = quaternion.identity;
        Func<int, float4> lastCivColor;

        /// <summary>
        /// Full strength of each squad type in men, matching the server (actionDefinitions.js SQUAD_MEN, B/E): its
        /// HP is men x HP per man and the living count is ceil(hp / maxHp x men), which AliveMen mirrors.
        /// </summary>
        public static int SquadMen(string type) => type switch
        {
            "rifle_squad" => 8, "militia" => 6, "special_forces" => 5, "exo_infantry" => 4, "anti_armor" => 3,
            "mortar_team" => 3, "engineer" => 1, _ => 6,
        };

        void CreateReadability()
        {
            for (int r = 0; r < rigs.Length; r++)
                if (rigs[r] != null && rigs[r].TeamMesh != null)
                    soldierTeam[r] = new InstanceBatch(rigs[r].TeamMesh, rigs[r].Material, 128)
                    { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3, Shadows = ShadowCastingMode.Off };
            glyphs = new InstanceBatch(MeshKit.Box, RenderResources.Instanced, 256)
            { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3, Shadows = ShadowCastingMode.Off };
        }

        void EnsureReadability(int s)
        {
            if (menMax.Length < s) Array.Resize(ref menMax, s);
        }

        void BeginReadability(Func<int, float4> civColor)
        {
            lastCivColor = civColor;
            foreach (var b in soldierTeam) b?.Clear();
            glyphs?.Clear();
            var cam = Camera.main;
            if (cam != null) { var q = cam.transform.rotation; cameraRotation = new quaternion(q.x, q.y, q.z, q.w); }
        }

        void UploadReadability() { foreach (var b in soldierTeam) b?.Upload(); glyphs?.Upload(); }
        void DrawReadability() { foreach (var b in soldierTeam) b?.Draw(); glyphs?.Draw(); }
        void DisposeReadability() { foreach (var b in soldierTeam) b?.Dispose(); glyphs?.Dispose(); }
        int ReadabilityInstances()
        {
            int n = glyphs != null ? glyphs.Count : 0;
            foreach (var b in soldierTeam) if (b != null) n += b.Count;
            return n;
        }

        /// <summary>The team colour as worn: strong and saturated, never dark.</summary>
        static float3 TeamWear(float3 team) => math.saturate(team * 1.08f + .05f);

        /// <summary>Men still standing in a squad (at least one while it lives).</summary>
        int AliveMen(int slot, int id, int hp)
        {
            int full = Math.Max(1, Math.Min(MaxFigures, (int)menMax[slot]));
            int exact = MenOf != null ? MenOf(id) : -1;
            if (exact >= 0) return Math.Max(1, Math.Min(full, exact));
            // the wire carries hp as a rounded percentage: allow its half-percent error at the boundaries
            return Math.Max(1, Math.Min(full, (int)Math.Ceiling(full * Mathf.Clamp01(hp / 100f) - .05f)));
        }

        /// <summary>Whether figure f of a full-strength squad has fallen (a fixed, id-seeded order, so the rest keep their places).</summary>
        static bool Fallen(int f, int id, int full, int alive) => (f * 7 + (id & 1023)) % full >= alive;

        /// <summary>
        /// The team outline circle under a ground unit. It keeps a minimum on-screen size as the camera pulls back,
        /// so troops are easy to find at any zoom; the selection ring replaces it when selected.
        /// </summary>
        /// <summary>World diameter of a squad's team ring (outer edge; the thin band's inner edge is 0.93 of it).</summary>
        const float SquadRingSize = .6f;
        /// <summary>The farthest a squad's man (his feet) may stand from the squad's centre: inside the ring's band, less his width.</summary>
        const float SquadRingReach = SquadRingSize * .465f - .035f;

        /// <summary>
        /// The height the flat team ring is laid at: the highest ground under its edge (four points), so on a
        /// slope the uphill side is not buried (it read as an open "C" with the men standing past it).
        /// </summary>
        static float RingGround(in SE.Core.World.TerrainView view, float x, float ground, float z, Kind kind)
        {
            bool troop = kind == Kind.Infantry || kind == Kind.Mortar || kind == Kind.Exo;
            float r = (troop ? SquadRingSize : .30f) * .5f;
            float h = ground;
            h = Mathf.Max(h, view.GroundHeight(x + r, z)); h = Mathf.Max(h, view.GroundHeight(x - r, z));
            h = Mathf.Max(h, view.GroundHeight(x, z + r)); h = Mathf.Max(h, view.GroundHeight(x, z - r));
            return h;
        }

        void GroundRing(float x, float ground, float z, Kind kind, float4 team, bool selected, float camDist)
        {
            bool troop = kind == Kind.Infantry || kind == Kind.Mortar || kind == Kind.Exo;
            // one fixed world size per kind, centred on the unit's (interpolated) position: it never follows the
            // men's spread, casualties or formation. A squad's men are kept inside it (SquadRingReach, AddSquad).
            // Only far out does a minimum on-screen size take over, and that changes only with the zoom.
            float baseSize = troop ? SquadRingSize : .30f;
            float size = Mathf.Max(baseSize, camDist * (troop ? .0105f : .0095f)) * (HighContrast ? 1.15f : 1f);
            float lift = .012f + camDist * .0004f;
            var colour = selected ? new float4(.54f, .92f, .62f, .35f)
                : new float4(TeamWear(team.xyz), HighContrast ? .9f : .3f);
            // a squad's ring is wide, so it uses the thin band (the same line weight as a vehicle's ring)
            batches[(int)(troop ? Model.RingThin : Model.Ring)].Add(T(new float3(x, ground + lift, z), 0, new float3(selected && !troop ? size * 1.12f : size), colour));
        }

        // ------------------------------------------------------------------ role glyphs
        const int GlyphRifle = 0, GlyphMilitia = 1, GlyphEngineer = 2, GlyphSpecial = 3, GlyphExo = 4, GlyphAntiArmor = 5, GlyphMortar = 6,
            GlyphArmor = 7, GlyphCarrier = 8, GlyphRecon = 9, GlyphArtillery = 10, GlyphAirDefense = 11, GlyphSupply = 12;

        int GlyphOf(int slot, Kind kind)
        {
            switch (kind)
            {
                case Kind.Infantry:
                    switch (torsoOf[slot])
                    {
                        case Detail.Engineer: return GlyphEngineer;
                        case Detail.Militia: return GlyphMilitia;
                        case Detail.Special: return GlyphSpecial;
                        case Detail.AntiArmor: return GlyphAntiArmor;
                        default: return GlyphRifle;
                    }
                case Kind.Exo: return GlyphExo;
                case Kind.Mortar: return GlyphMortar;
                case Kind.Tank: case Kind.AutoTank: return GlyphArmor;
                case Kind.Apc: return GlyphCarrier;
                case Kind.ArmoredCar: case Kind.Buggy: return GlyphRecon;
                case Kind.FieldGun: case Kind.SpGun: case Kind.Launcher: return GlyphArtillery;
                case Kind.AirDefense: return GlyphAirDefense;
                default: return GlyphSupply;
            }
        }

        /// <summary>One plate of a glyph: centre (Unity space), in-plane angle, width and height, layer toward the camera.</summary>
        void GlyphBar(float3 centre, float angle, float w, float h, float layer, float depth, float4 colour)
        {
            var q = math.mul(cameraRotation, quaternion.RotateZ(angle));
            var at = centre + math.rotate(q, new float3(0, -h * .5f, -layer));
            glyphs.Add(InstanceData.TRS(at, q, new float3(w, h, depth), colour));
        }

        /// <summary>
        /// A floating role glyph above an enemy unit, NATO-style on a dark card with a team-coloured frame: X rifles,
        /// / militia, Π engineers, Λ anti-armour, ↑ with a base mortars, an oval armour, a dot artillery, and so on.
        /// It faces the camera and keeps a constant on-screen size. Six plates at most.
        /// </summary>
        void RoleGlyph(int slot, Kind kind, float3 mapPos, float4 team, float camDist)
        {
            if (glyphs == null) return;
            float s = Mathf.Clamp(camDist * .0075f, .07f, 1.1f);   // about a strategic badge's size: constant on screen
            var centre = MapSpace.W(mapPos) + new float3(0, .16f + s * .85f, 0);
            float th = s * .04f;
            var frame = new float4(TeamWear(team.xyz), .25f);
            var card = new float4(.10f, .11f, .12f, 0);
            var ink = new float4(.96f, .96f, .93f, .2f);
            GlyphBar(centre, 0, s * 1.08f, s * .80f, 0, th, frame);
            GlyphBar(centre, 0, s * .92f, s * .64f, th, th, card);
            float L = 2.2f * th, w = s * .085f;
            const float diag = .6f;   // atan(.64 / .92)
            switch (GlyphOf(slot, kind))
            {
                case GlyphRifle:
                    GlyphBar(centre, diag, w, s * 1.0f, L, th, ink); GlyphBar(centre, -diag, w, s * 1.0f, L, th, ink); break;
                case GlyphExo:
                    GlyphBar(centre, diag, w * 1.8f, s * 1.0f, L, th, ink); GlyphBar(centre, -diag, w * 1.8f, s * 1.0f, L, th, ink); break;
                case GlyphSpecial:
                    GlyphBar(centre, diag, w, s * .9f, L, th, ink); GlyphBar(centre, -diag, w, s * .9f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, s * .24f, 0)), 1.5708f, w, s * .7f, L, th, ink); break;
                case GlyphMilitia:
                    GlyphBar(centre, -diag, w, s * 1.0f, L, th, ink); break;
                case GlyphAntiArmor:
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(-s * .17f, 0, 0)), -.55f, w, s * .66f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(s * .17f, 0, 0)), .55f, w, s * .66f, L, th, ink); break;
                case GlyphEngineer:
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, s * .1f, 0)), 1.5708f, w, s * .62f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(-s * .27f, -s * .05f, 0)), 0, w, s * .3f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(s * .27f, -s * .05f, 0)), 0, w, s * .3f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, -s * .05f, 0)), 0, w, s * .3f, L, th, ink); break;
                case GlyphMortar:
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, s * .06f, 0)), 0, w, s * .42f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, -s * .17f, 0)), 0, s * .17f, s * .17f, L, th, ink); break;
                case GlyphArmor:
                case GlyphCarrier:
                case GlyphRecon:
                    // the tracks oval, as two rails closed by short ends
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, s * .15f, 0)), 1.5708f, w, s * .5f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, -s * .15f, 0)), 1.5708f, w, s * .5f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(-s * .27f, 0, 0)), 0, w, s * .3f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(s * .27f, 0, 0)), 0, w, s * .3f, L, th, ink);
                    if (kind == Kind.ArmoredCar || kind == Kind.Buggy) GlyphBar(centre, -diag, w * .8f, s * .9f, L * 1.4f, th, ink);
                    else if (kind == Kind.Apc) GlyphBar(centre, 0, w * .8f, s * .3f, L * 1.4f, th, ink);
                    break;
                case GlyphArtillery:
                    GlyphBar(centre, .785f, s * .22f, s * .22f, L, th, ink); break;
                case GlyphAirDefense:
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(-s * .13f, s * .02f, 0)), -.62f, w, s * .5f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(s * .13f, s * .02f, 0)), .62f, w, s * .5f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, -s * .19f, 0)), 1.5708f, w, s * .6f, L, th, ink); break;
                default:
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(0, s * .05f, 0)), 1.5708f, w, s * .62f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(-s * .18f, -s * .15f, 0)), .785f, s * .12f, s * .12f, L, th, ink);
                    GlyphBar(centre + math.rotate(cameraRotation, new float3(s * .18f, -s * .15f, 0)), .785f, s * .12f, s * .12f, L, th, ink); break;
            }
        }

        /// <summary>The team-colour overlay for one rigged soldier (same transform and animation frame as the body).</summary>
        void AddTeamGear(int role, in InstanceData body, float frame)
        {
            var batch = soldierTeam[role];
            if (batch == null) return;
            var d = body;
            d.Color = new float4(figureTeam, 2 + frame);
            batch.Add(d);
        }
    }
}
