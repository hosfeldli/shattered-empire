using System.Collections.Generic;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Level dressing for the staged facility models (2026-11-20, Ticket 2: "every building upgrade needs a visible
    /// effect on the building"). The Blender facilities (CityRenderer.StagedModels.cs) have one model per destruction
    /// stage but none per upgrade level, so each level above 1 adds props on top of the model. Generic on purpose:
    /// it reads only the level count (BuildingRecord.Level, carried in Ctx.Level), so per-building upgrade schemes
    /// that raise a level all show without a table here.
    /// <list type="bullet">
    /// <item>Every level: a glowing team rank bar on the front apron, one per level (level 3 shows three).</item>
    /// <item>Level 2+: armour plating down both long sides (steel slabs with a team band), and a lattice mast with a
    /// red beacon at a rear roof corner.</item>
    /// <item>Level 3+: a second mast with a dish, a row of floodlights along the front roof edge and a team banner on
    /// a pole at the front corner.</item>
    /// <item>Level 4+: each further level adds a sandbagged gun pit (or crate stack) beside the building.</item>
    /// </list>
    /// Masts, lights and banners go with heavy damage (stage 2); plating and bars stay. The headquarters is excluded:
    /// its tiers are separate models (town, town_t2, town_t3) with walls and flags of their own; field defenses
    /// carry their own level dressing (CityRenderer.Defenses.cs).
    /// </summary>
    public sealed partial class CityRenderer
    {
        struct LevelFrame { public float HalfX, HalfZ, Height; public float4 Roofs; }   // roofs: rear-left, rear-right, front-left, front-right heights (0: none)
        static readonly Dictionary<(string, int), LevelFrame> levelFrames = new Dictionary<(string, int), LevelFrame>();

        /// <summary>The body's half extents (from the layout walls) and the roof height at four corners, per model and stage (cached).</summary>
        static LevelFrame LevelFrameOf(string type, string key, BaseLayout l, int stage)
        {
            if (levelFrames.TryGetValue((key, stage), out var f)) return f;
            float hx = 0, hz = 0;
            if (l != null)
                foreach (var w in l.Walls)
                {
                    float r = math.max(w.HalfW, w.HalfD);
                    hx = math.max(hx, math.abs(w.X) + (math.abs(w.Yaw) < .3f ? w.HalfW : r));
                    hz = math.max(hz, math.abs(w.Z) + (math.abs(w.Yaw) < .3f ? w.HalfD : r));
                }
            float extent = VisualExtent(type, out float height);
            if (hx < .1f) hx = extent > 0 ? extent * .75f : .4f;
            if (hz < .1f) hz = extent > 0 ? extent * .75f : .4f;
            hx = math.min(hx, .55f); hz = math.min(hz, .55f);
            float Roof(float lx, float lz) => RoofTopAt(type, lx, lz, out float y, stage) && y > .08f ? y : 0f;
            f = new LevelFrame
            {
                HalfX = hx, HalfZ = hz, Height = height,
                Roofs = new float4(Roof(-hx * .72f, -hz * .72f), Roof(hx * .72f, -hz * .72f), Roof(-hx * .72f, hz * .72f), Roof(hx * .72f, hz * .72f)),
            };
            levelFrames[(key, stage)] = f;
            return f;
        }

        /// <summary>Props for each upgrade level of a staged facility (after its model and layout records).</summary>
        void LevelDressing(in Ctx c, string type, string key, BaseLayout l)
        {
            int level = c.Level;
            if (level < 2 || type == "town") return;
            int stage = c.Stage;
            var f = LevelFrameOf(type, key, l, math.min(stage, 2));
            var cc = c;
            math.sincos(cc.Yaw, out float sn, out float cs);
            float3 Map(float lx, float y, float lz) => new float3(cc.X + lx * cs + lz * sn, cc.GroundY + y, cc.Z - lx * sn + lz * cs);
            var team = c.Civ * c.Tint;
            var bright = math.lerp(c.Civ, new float3(1f), .25f) * c.Tint;
            var steel = new float3(.44f, .46f, .45f) * c.Tint;
            var dark = new float3(.17f, .18f, .18f) * c.Tint;
            float glow = c.Tint.x > .7f ? 1f : 0f;   // fog memories don't glow
            float hx = f.HalfX, hz = f.HalfZ;

            // rank bars on the front apron: one per level, so any level count reads at a glance
            int bars = math.min(level, 8);
            Put(Part.Box, Map(0, .001f, hz + .085f), c.Yaw, new float3(bars * .06f + .03f, .010f, .085f), dark);
            for (int k = 0; k < bars; k++)
                Put(Part.Box, Map((k - (bars - 1) * .5f) * .06f, .006f, hz + .085f), c.Yaw, new float3(.036f, .012f, .062f), bright, .8f * glow);

            // level 2: armour plating down both sides (slabs leaning on the walls, a team band along their tops)
            float plateH = math.clamp(f.Height * .38f, .1f, .2f);
            for (int side = -1; side <= 1; side += 2)
            {
                int slabs = 3;
                for (int i = 0; i < slabs; i++)
                {
                    float lz = (i - (slabs - 1) * .5f) * (hz * 1.6f / slabs);
                    if (stage >= 2 && i == 1) continue;   // one slab blown off
                    Put(Part.Concrete, Map(side * (hx + .022f), -.005f, lz), c.Yaw + side * .06f, new float3(.03f, plateH, hz * 1.6f / slabs - .02f), steel);
                    Put(Part.Box, Map(side * (hx + .024f), plateH - .028f, lz), c.Yaw, new float3(.034f, .016f, hz * 1.6f / slabs - .03f), team, .3f * glow);
                }
            }

            if (stage >= 2) { ExtraPits(c, level, hx, hz, Map, steel); return; }
            // a lattice mast and red beacon at the rear-left roof corner (or beside the building where there is no roof)
            Mast(Map, -hx * .72f, -hz * .72f, f.Roofs.x, -hx - .09f, -hz * .5f, .30f, steel, glow, false);
            if (level >= 3)
            {
                Mast(Map, hx * .72f, -hz * .72f, f.Roofs.y, hx + .09f, -hz * .5f, .24f, steel, glow, true);
                // floodlights along the front roof edge
                float roofFront = math.max(f.Roofs.z, f.Roofs.w);
                float y = roofFront > 0 ? roofFront : f.Height * .8f;
                if (stage == 0)
                    for (int k = 0; k < 3; k++)
                    {
                        float lx = (k - 1) * hx * .55f;
                        Put(Part.Box, Map(lx, y, hz * .78f), c.Yaw, new float3(.05f, .022f, .03f), dark);
                        Put(Part.Box, Map(lx, y + .004f, hz * .78f + .017f), c.Yaw, new float3(.04f, .015f, .006f), new float3(1f, .93f, .74f) * c.Tint, 2.2f * glow);
                    }
                // a team banner on a pole at the front-right corner
                Flag(c, hx + .08f, hz + .06f, .42f);
            }
            ExtraPits(c, level, hx, hz, Map, steel);
        }

        /// <summary>A thin mast on the roof at (lx, lz) when there is roof there, else on the ground at (gx, gz); a beacon or a dish on top.</summary>
        void Mast(System.Func<float, float, float, float3> map, float lx, float lz, float roof, float gx, float gz, float height, float3 steel, float glow, bool dish)
        {
            bool onRoof = roof > 0;
            float x = onRoof ? lx : gx, z = onRoof ? lz : gz, y = onRoof ? roof - .005f : -.005f;
            float h = onRoof ? height : height + .22f;
            var foot = map(x, y, z);
            Put(Part.Cylinder, foot, 0, new float3(.016f, h, .016f), steel);
            Put(Part.Box, foot + new float3(0, h * .45f, 0), 0, new float3(.07f, .008f, .008f), steel);   // cross arms
            Put(Part.Box, foot + new float3(0, h * .7f, 0), 0, new float3(.05f, .008f, .008f), steel);
            if (dish) Put(Part.Dish, foot + new float3(0, h * .82f, 0), 0, new float3(.09f, .09f, .09f), new float3(.88f, .88f, .85f) * (steel / .44f));
            else Put(Part.Box, foot + new float3(0, h, 0), 0, new float3(.026f, .026f, .026f), new float3(1f, .16f, .1f), 2.6f * glow);
        }

        /// <summary>Level 4 and up: a sandbagged pit or a crate stack per extra level, round the building's flanks.</summary>
        void ExtraPits(in Ctx c, int level, float hx, float hz, System.Func<float, float, float, float3> map, float3 steel)
        {
            for (int k = 0; k < math.min(level - 3, 4); k++)
            {
                float side = k % 2 == 0 ? -1f : 1f;
                float lz = k < 2 ? hz * .55f : -hz * .55f;
                var at = map(side * (hx + .2f), 0, lz);
                for (int s = 0; s < 6; s++)
                {
                    float a = s * math.PI / 3f;
                    Put(Part.Sandbag, at + new float3(math.sin(a) * .08f, -.004f, math.cos(a) * .08f), c.Yaw + a + math.PI * .5f, new float3(.07f, .035f, .04f), new float3(.55f, .5f, .38f) * c.Tint);
                }
                Put(Part.Box, at, c.Yaw, new float3(.05f, .05f, .05f), steel);
            }
        }
    }
}
