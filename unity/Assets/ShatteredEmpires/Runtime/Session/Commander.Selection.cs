using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Cities;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Footprint-fitted selection rings for buildings and turrets (overhaul §36, workstream C-D). The size comes from
    /// the building definition's radius (the same <c>BUILDINGS[type].radius</c> that <see cref="SpatialBuildingAt"/>
    /// picks with): turrets and other field defenses get a round ring, a field structure with an explicit
    /// width and depth (the barricade) and every base building get corner brackets turned to the building's yaw.
    /// Footprints are cached per type (the definitions are only re-read when the server sends new ones), the round
    /// ring is one instance of the shared ring mesh and a bracket set is eight line instances, so a full selection
    /// costs at most <see cref="MaxRingedBuildings"/> × 8 instances and no allocation.
    /// </summary>
    public sealed partial class Commander
    {
        /// <summary>
        /// Radius: the round ring (the larger of the server radius and the drawn body). Pick*: the click target, the
        /// drawn extent (<see cref="CityRenderer.VisualExtent"/>, never below the server radius) and the height of the
        /// tallest readable part. Pickable: a gameplay structure (ambient city fabric and ruins are never picked).
        /// </summary>
        struct Footprint { public float Radius, Width, Depth, PickRadius, PickHeight; public bool Round, Pickable; }

        readonly Dictionary<string, Footprint> footprintByType = new Dictionary<string, Footprint>();
        JToken footprintDefs;
        const int MaxRingedBuildings = 48;
        static readonly float4 SelectedOwnBuilding = new float4(.43f, .77f, .65f, 0f);
        static readonly float4 SelectedOtherBuilding = new float4(.93f, .42f, .36f, 0f);

        Footprint BuildingFootprint(string type)
        {
            var defs = session.Defs?["BUILDINGS"];
            if (!ReferenceEquals(defs, footprintDefs)) { footprintByType.Clear(); footprintDefs = defs; }
            if (string.IsNullOrEmpty(type)) return new Footprint { Radius = .5f, Width = 1.02f, Depth = 1.02f, PickRadius = .5f, PickHeight = .4f };
            if (footprintByType.TryGetValue(type, out var f)) return f;
            var def = defs?[type];
            float radius = ProtocolDecoder.Float(def?["radius"], .5f);
            float width = ProtocolDecoder.Float(def?["width"], 0f), depth = ProtocolDecoder.Float(def?["depth"], 0f);
            bool rectangle = width > 0 && depth > 0;
            bool round = !rectangle && (ProtocolDecoder.Bool(def?["field"]) || ProtocolDecoder.Bool(def?["defense"]) || type.Contains("turret"));
            // a base building's brackets enclose its footprint circle with a little air; a field rectangle its own size
            float side = Mathf.Max(.5f, radius * 2f) + .05f;
            float visual = CityRenderer.VisualExtent(type, out float height);
            bool pickable = def != null || CityRenderer.IsGameplayType(type) || (defs == null && visual > 0);
            f = new Footprint
            {
                // a defense's ring hugs its drawn body (berm, sandbags) rather than the server's smaller radius
                Radius = round && visual > 0 ? Mathf.Max(radius, visual - .04f) : radius, Round = round,
                Width = rectangle ? width + .08f : side, Depth = rectangle ? depth + .08f : side,
                PickRadius = Mathf.Max(radius, visual), PickHeight = height, Pickable = pickable,
            };
            footprintByType[type] = f;
            return f;
        }

        /// <summary>The selected buildings' rings (called from DrawActionOverlay, Commander.Action.cs).</summary>
        void DrawSelectedBuildingRings()
        {
            DrawBuildingHover();   // the hover highlight before a click (below)
            if (SelectedBuildings.Count == 0) return;
            var w = session.World;
            int drawn = 0;
            foreach (int id in SelectedBuildings)
            {
                if (drawn >= MaxRingedBuildings) break;
                if (!session.Structures.Buildings.TryGetValue(id, out var b)) continue;
                drawn++;
                var fp = BuildingFootprint(b.Type);
                var color = b.Owner == session.CivId || !session.IsHostile(b.Owner) ? SelectedOwnBuilding : SelectedOtherBuilding;
                if (fp.Round)
                {
                    // one ring instance laid at the highest ground under its edge (it would sink into a slope otherwise)
                    float r = fp.Radius + .05f, h = w.GroundHeight(b.X, b.Z);
                    h = Mathf.Max(h, w.GroundHeight(b.X + r, b.Z)); h = Mathf.Max(h, w.GroundHeight(b.X - r, b.Z));
                    h = Mathf.Max(h, w.GroundHeight(b.X, b.Z + r)); h = Mathf.Max(h, w.GroundHeight(b.X, b.Z - r));
                    rings.Add(InstanceData.TRS(MapSpace.W(new float3(b.X, h + .03f, b.Z)), 0, new float3(r * 2f, 1, r * 2f), new float4(color.xyz, .35f)));
                }
                else FootprintBrackets(b.X, b.Z, b.HasYaw ? b.Yaw : 0f, fp.Width, fp.Depth, color);
            }
        }

        // ------------------------------------------------------------------ building picking and hover (workstream B, 2026-11-18)
        // A structure is picked against what is drawn, not a screen circle round its centre: the cursor ray is cut by
        // the structure's ground plane and the plane of its tallest readable part, and the plan-view segment between the
        // two is tested against its drawn footprint (a disc of the drawn radius, or the barricade's rotated rectangle),
        // with a margin and a minimum on-screen size so a perimeter turret stays clickable when zoomed out. Several
        // candidates: the one whose footprint the cursor is deepest inside wins (normalised by size, so a turret beside
        // a headquarters still wins on the turret). Only gameplay structures are candidates (Footprint.Pickable): ambient
        // houses, ruins and the passive base dressing (CityRenderer.BaseDevelopment.cs, no server record) never pick.
        // Memoised per frame and mouse position: the cursor context, the click and the hover ring share one pass.

        const float PickMarginWorld = .04f, PickMinPixels = 13f;
        int pickFrame = -1;
        Vector2 pickMouse;
        BuildingRecord? pickResult;
        float pickDepth;   // the winner's normalised distance (0 at its centre, 1 at its pick edge)

        BuildingRecord? PickBuilding(Vector2 mouse)
        {
            if (pickFrame == Time.frameCount && pickMouse == mouse) return pickResult;
            pickFrame = Time.frameCount; pickMouse = mouse; pickResult = null; pickDepth = float.MaxValue;
            var camera = cam.Cam;
            if (camera == null) return null;
            var ray = camera.ScreenPointToRay(mouse);
            Vector3 o = MapSpace.ToMap(ray.origin), d = MapSpace.ToMap(ray.direction);
            if (d.y > -1e-4f) return null;
            var w = session.World;
            // pixels per map unit at distance t along the ray (perspective) or everywhere (orthographic)
            float focal = camera.orthographic ? camera.pixelHeight / (2f * camera.orthographicSize)
                : camera.pixelHeight / (2f * Mathf.Tan(camera.fieldOfView * .5f * Mathf.Deg2Rad));
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (!b.HasPosition) continue;
                var fp = BuildingFootprint(b.Type);
                if (!fp.Pickable) continue;
                float bx = w.Grid.NearX(b.X, o.x), gy = w.GroundHeight(b.X, b.Z);
                float tBottom = (gy - o.y) / d.y;
                if (tBottom <= 0) continue;
                // cheap reject: the ground hit far from the building (beyond any footprint plus the height lean)
                float gx = o.x + d.x * tBottom - bx, gz = o.z + d.z * tBottom - b.Z;
                float reachMax = fp.PickRadius + fp.PickHeight * 2.5f + 1.2f;
                if (gx * gx + gz * gz > reachMax * reachMax) continue;
                float tTop = Mathf.Max(0f, (gy + fp.PickHeight - o.y) / d.y);
                float ax = o.x + d.x * tTop - bx, az = o.z + d.z * tTop - b.Z;   // the segment a..g, relative to the building
                float ppu = camera.orthographic ? focal : focal / tBottom;
                float minimum = PickMinPixels / Mathf.Max(1e-4f, ppu);
                float depth;
                if (fp.Round || !(fp.Width > 0 && fp.Depth > 0) || !b.HasYaw)
                {
                    float r = Mathf.Max(fp.PickRadius + PickMarginWorld, minimum);
                    depth = Mathf.Sqrt(SegmentPointDistanceSq(ax, az, gx, gz)) / r;
                }
                else
                {
                    // the rotated rectangle (barricade), sampled along the segment in the building's frame
                    math.sincos(b.Yaw, out float sn, out float cs);
                    float hw = fp.Width * .5f, hd = fp.Depth * .5f;
                    float margin = Mathf.Max(PickMarginWorld, minimum - Mathf.Min(hw, hd));
                    float best = float.MaxValue, centre = float.MaxValue;
                    for (int k = 0; k <= 4; k++)
                    {
                        float px = Mathf.Lerp(ax, gx, k * .25f), pz = Mathf.Lerp(az, gz, k * .25f);
                        float lx = px * cs - pz * sn, lz = px * sn + pz * cs;   // inverse of the building frame
                        float ex = Mathf.Max(0f, Mathf.Abs(lx) - hw), ez = Mathf.Max(0f, Mathf.Abs(lz) - hd);
                        best = Mathf.Min(best, ex * ex + ez * ez);
                        centre = Mathf.Min(centre, (lx * lx) / (hw * hw) + (lz * lz) / (hd * hd));
                    }
                    if (best > margin * margin) continue;
                    depth = best > 0 ? .7f + .3f * Mathf.Sqrt(best) / margin : .7f * Mathf.Min(1f, Mathf.Sqrt(centre * .5f));
                }
                if (depth > 1f || depth >= pickDepth) continue;
                pickDepth = depth; pickResult = b;
            }
            return pickResult;
        }

        /// <summary>Squared plan distance from the origin to the segment a → g.</summary>
        static float SegmentPointDistanceSq(float ax, float az, float gx, float gz)
        {
            float sx = gx - ax, sz = gz - az, len = sx * sx + sz * sz;
            float t = len > 1e-8f ? Mathf.Clamp01(-(ax * sx + az * sz) / len) : 0f;
            float x = ax + sx * t, z = az + sz * t;
            return x * x + z * z;
        }

        /// <summary>
        /// True when the cursor is well inside a structure's drawn body (the inner 60 % of its pick radius): a click
        /// there selects the structure rather than a unit standing more than 9 px away (Commander.cs, SelectMode).
        /// </summary>
        bool StructureFirmlyUnderCursor(Vector2 mouse) => PickBuilding(mouse) != null && pickDepth < .6f;

        int hoverBuildingId, hoverBuildingFrame = -10;

        /// <summary>The structure under the cursor in select mode (0 when none, over the interface or while dragging).</summary>
        public int HoverBuildingId => hoverBuildingFrame >= Time.frameCount - 1 ? hoverBuildingId : 0;

        static readonly float4 HoverOwnBuilding = new float4(.86f, .96f, .92f, .55f);
        static readonly float4 HoverHostileBuilding = new float4(1f, .58f, .48f, .55f);
        static readonly float4 HoverNeutralBuilding = new float4(.95f, .88f, .62f, .5f);

        /// <summary>
        /// The hover highlight (called each frame from DrawActionOverlay with the selection rings): a bright ring (or
        /// brackets) at the pick footprint of the structure under the cursor, before any click. Pale for own and allied,
        /// red for hostile, sand for neutral. One pick pass per frame (memoised), at most two ring instances.
        /// </summary>
        void DrawBuildingHover()
        {
            hoverBuildingFrame = Time.frameCount;
            hoverBuildingId = 0;
            if (!session.ActionRts || Current != Mode.Select || hoverTile < 0 || dragging || cam.MouseRotating) return;
            if (!(PickBuilding(InputFacade.MousePosition) is BuildingRecord b)) return;
            hoverBuildingId = b.Id;
            var fp = BuildingFootprint(b.Type);
            var color = b.Owner < 0 ? HoverNeutralBuilding : session.IsHostile(b.Owner) ? HoverHostileBuilding : HoverOwnBuilding;
            bool selected = SelectedBuildings.Contains(b.Id);
            var w = session.World;
            if (fp.Round || !b.HasYaw)
            {
                float r = fp.PickRadius + PickMarginWorld, h = w.GroundHeight(b.X, b.Z);
                h = Mathf.Max(h, w.GroundHeight(b.X + r, b.Z)); h = Mathf.Max(h, w.GroundHeight(b.X - r, b.Z));
                h = Mathf.Max(h, w.GroundHeight(b.X, b.Z + r)); h = Mathf.Max(h, w.GroundHeight(b.X, b.Z - r));
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(b.X, h + .035f, b.Z)), 0, new float3(r * 2f, 1, r * 2f), color));
                if (!selected) rings.Add(InstanceData.TRS(MapSpace.W(new float3(b.X, h + .033f, b.Z)), 0, new float3(r * 2f + .07f, 1, r * 2f + .07f), new float4(color.xyz, color.w * .45f)));
            }
            else
            {
                FootprintBrackets(b.X, b.Z, b.Yaw, fp.Width + .06f, fp.Depth + .06f, color);
                if (!selected) FootprintBrackets(b.X, b.Z, b.Yaw, fp.Width + .14f, fp.Depth + .14f, new float4(color.xyz, color.w * .45f));
            }
        }

        /// <summary>Corner brackets of an oriented rectangle (arms a sixth of the side, at most .15), draped on the ground.</summary>
        void FootprintBrackets(float x, float z, float yaw, float width, float depth, float4 color)
        {
            math.sincos(yaw, out float sn, out float cs);
            float arm = Mathf.Min(.15f, Mathf.Min(width, depth) / 6f);
            for (int i = -1; i <= 1; i += 2)
                for (int j = -1; j <= 1; j += 2)
                {
                    float a = i * width * .5f, b = j * depth * .5f;
                    SelectionLine(x, z, sn, cs, a, b, a - i * arm, b, color);
                    SelectionLine(x, z, sn, cs, a, b, a, b - j * arm, color);
                }
        }

        void SelectionLine(float x, float z, float sn, float cs, float a0, float b0, float a1, float b1, float4 color)
        {
            var w = session.World;
            float ax = x + a0 * cs + b0 * sn, az = z - a0 * sn + b0 * cs;
            float bx = x + a1 * cs + b1 * sn, bz = z - a1 * sn + b1 * cs;
            float dx = w.Grid.DxWrap(ax, bx), dz = bz - az;
            float length = math.length(new float2(dx, dz));
            if (length < .02f) return;
            float mx = ax + dx * .5f, mz = az + dz * .5f;
            var pos = new float3(mx, w.GroundHeight(mx, mz) + .058f, mz);
            routeLines.Add(InstanceData.TRS(MapSpace.W(pos), MapSpace.Yaw(Mathf.Atan2(dx, dz)), new float3(.006f, .018f, length), color));
        }
    }
}
