using System.Collections.Generic;
using System.Globalization;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Authored base facilities (tools/blender/build_bases.py): one baked Blender model per positioned
    /// headquarters, barracks, supply centre, vehicle works and generator, plus Models/BaseLayout.txt with
    /// each model's walls (collision and infantry avoidance), faction-coloured panels, flag poles and smoke
    /// stacks. Field defenses (tools/blender/build_defenses.py) add Models/DefenseLayout.txt with the same records
    /// plus turret mounts and rank-bar plates (CityRenderer.Defenses.cs). Types without a model keep their recipe.
    /// Frame note: a building recipe's +lx maps to the model's -X under MapSpace.Yaw, so layout x is mirrored.
    /// </summary>
    public sealed partial class CityRenderer
    {
        sealed class BaseLayout
        {
            public readonly List<FootRect> Walls = new List<FootRect>();
            public readonly List<float4> Flags = new List<float4>();                       // lx, lz, height
            public readonly List<(float3 at, float3 size)> Marks = new List<(float3, float3)>();
            public readonly List<(float3 at, bool steam, float size)> Smoke = new List<(float3, bool, float)>();
            public readonly List<float3> Mounts = new List<float3>();                      // turret pivots: lx, height, lz
            public readonly List<float3> Plates = new List<float3>();                      // rank-bar plates: lx, height, lz
        }

        static Dictionary<string, BaseLayout> baseLayouts;
        static readonly Dictionary<string, Part> BaseParts = new Dictionary<string, Part>
        {
            ["town"] = Part.BaseTown, ["barracks"] = Part.BaseBarracks, ["depot"] = Part.BaseDepot,
            ["motor_works"] = Part.BaseMotorWorks, ["power_plant"] = Part.BasePower,
        };

        static Mesh AuthoredMesh(Part part, Mesh fallback) => part switch
        {
            Part.BaseTown => ModelLibrary.Or("Base_town", fallback),
            Part.BaseBarracks => ModelLibrary.Or("Base_barracks", fallback),
            Part.BaseDepot => ModelLibrary.Or("Base_depot", fallback),
            Part.BaseMotorWorks => ModelLibrary.Or("Base_motor_works", fallback),
            Part.BasePower => ModelLibrary.Or("Base_power_plant", fallback),
            Part.DefBarricade => ModelLibrary.Or("Def_barricade", fallback),
            Part.DefGuardPost => ModelLibrary.Or("Def_guard_post", fallback),
            Part.DefBunker => ModelLibrary.Or("Def_bunker", fallback),
            Part.DefAtBase => ModelLibrary.Or("Def_at_base", fallback),
            Part.DefAaBase => ModelLibrary.Or("Def_aa_base", fallback),
            Part.DefMgBase => ModelLibrary.Or("Def_mg_base", fallback),
            Part.DefFort => ModelLibrary.Or("Def_fort", fallback),
            Part.DefSensor => ModelLibrary.Or("Def_sensor_post", fallback),
            Part.DefArtilleryBase => ModelLibrary.Or("Def_artillery_base", fallback),
            Part.DefRepair => ModelLibrary.Or("Def_repair_point", fallback),
            Part.DefWall => ModelLibrary.Or("Def_wall", fallback),
            _ => fallback
        };

        static Dictionary<string, BaseLayout> Layouts()
        {
            if (baseLayouts != null) return baseLayouts;
            baseLayouts = new Dictionary<string, BaseLayout>();
            foreach (var file in new[] { "Models/BaseLayout", "Models/DefenseLayout" })
            {
                var text = Resources.Load<TextAsset>(file);
                if (text == null) continue;
                foreach (var raw in text.text.Split('\n'))
                {
                    var f = raw.Trim().Split(' ');
                    if (f.Length < 5) continue;
                    if (!baseLayouts.TryGetValue(f[1], out var l)) baseLayouts[f[1]] = l = new BaseLayout();
                    float F(int i) => float.Parse(f[i], CultureInfo.InvariantCulture);
                    switch (f[0])
                    {
                        case "wall" when f.Length >= 7: l.Walls.Add(new FootRect { X = -F(2), Z = F(3), HalfW = F(4), HalfD = F(5), Yaw = -F(6) }); break;
                        case "flag": l.Flags.Add(new float4(-F(2), F(3), F(4), 0)); break;
                        case "mark" when f.Length >= 8: l.Marks.Add((new float3(-F(2), F(4), F(3)), new float3(F(5), F(6), F(7)))); break;
                        case "smoke" when f.Length >= 7: l.Smoke.Add((new float3(-F(2), F(4), F(3)), f[5] == "1", F(6))); break;
                        case "mount": l.Mounts.Add(new float3(-F(2), F(4), F(3))); break;
                        case "plate": l.Plates.Add(new float3(-F(2), F(4), F(3))); break;
                    }
                }
            }
            return baseLayouts;
        }

        /// <summary>Draw the authored model for a positioned facility; false keeps the module recipe.</summary>
        bool AuthoredBase(in Ctx c, string type, float heightScale = 1f)
        {
            if (!BaseParts.TryGetValue(type, out var part) || AuthoredMesh(part, null) == null) return false;
            Layouts().TryGetValue(type, out var layout);
            // heightScale: the headquarters stands taller with each tier (layout heights follow it)
            Put(part, new float3(c.X, c.GroundY, c.Z), c.Yaw, new float3(1, heightScale, 1), c.Tint);
            if (layout == null) return true;
            math.sincos(c.Yaw, out float sn, out float cs);
            foreach (var (at, size) in layout.Marks)
            {
                float x = c.X + at.x * cs + at.z * sn, z = c.Z - at.x * sn + at.z * cs;
                Put(Part.Box, new float3(x, c.GroundY + at.y * heightScale - size.y * .5f, z), c.Yaw, size, c.Civ * c.Tint, .25f);
            }
            foreach (var f in layout.Flags) Flag(c, f.x, f.y, f.z * heightScale);
            foreach (var (at, steam, size) in layout.Smoke) Stack(c, at.x, at.z, at.y * heightScale, steam, size);
            if (recording != null) foreach (var w in layout.Walls) if (!recording.Contains(w)) recording.Add(w);
            return true;
        }
    }
}
