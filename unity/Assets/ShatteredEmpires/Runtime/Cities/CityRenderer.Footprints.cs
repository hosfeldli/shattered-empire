using System.Collections.Generic;
using System.Globalization;
using System.Text;
using SE.Core.Protocol;
using SE.Core.World;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>One solid wall-height box of a building, in the building's own frame (x right, z forward).</summary>
    public struct FootRect { public float X, Z, HalfW, HalfD, Yaw; }

    /// <summary>
    /// Building collision footprints recorded from what is actually drawn. While a positioned building
    /// is composed, every solid ground-standing module (halls, wings, towers; not glazing, roofs, decals or
    /// parked vehicles) is recorded as an oriented rectangle in the building frame. The union per type is
    /// used to keep infantry figures out of walls, and is exported (ExportJson) to the server's
    /// server/sim/actionFootprints.json so authoritative collision matches the art.
    /// </summary>
    public sealed partial class CityRenderer
    {
        public static readonly Dictionary<string, List<FootRect>> Footprints = new Dictionary<string, List<FootRect>>();
        static readonly HashSet<long> footKeys = new HashSet<long>();
        List<FootRect> recording;
        string recordingType;
        float recordX, recordZ, recordYaw;

        void BeginFootprint(in BuildingRecord b, float x, float z, float yaw)
        {
            if (!b.HasPosition || !b.Done || b.State == "ruin") { recording = null; return; }
            recordingType = b.Type; recordX = x; recordZ = z; recordYaw = yaw;
            if (!Footprints.TryGetValue(b.Type, out recording)) Footprints[b.Type] = recording = new List<FootRect>();
        }

        void EndFootprint() { recording = null; recordingType = null; }

        /// <summary>Called by Module with the module's world centre, scaled size and world yaw.</summary>
        void RecordFootprint(Part part, float x, float z, float3 size, float worldYaw, float lift)
        {
            if (recording == null || recording.Count >= 64) return;
            if (lift > .03f || size.y < .05f || math.min(size.x, size.z) < .035f) return;
            if (part is Part.Glass or Part.Tree or Part.Asphalt or Part.Wire or Part.Car or Part.Truck) return;
            math.sincos(recordYaw, out float sn, out float cs);
            float dx = x - recordX, dz = z - recordZ;
            // inverse of the building frame: world = (lx*cs + lz*sn, -lx*sn + lz*cs)
            float lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
            var r = new FootRect { X = lx, Z = lz, HalfW = size.x * .5f, HalfD = size.z * .5f, Yaw = Mathf.Repeat(worldYaw - recordYaw + Mathf.PI, 2 * Mathf.PI) - Mathf.PI };
            long key = ((long)recordingType.GetHashCode() << 32) ^ ((long)Mathf.RoundToInt(lx * 50) * 73856093) ^ ((long)Mathf.RoundToInt(lz * 50) * 19349663)
                ^ ((long)Mathf.RoundToInt(r.HalfW * 100) * 83492791) ^ Mathf.RoundToInt(r.HalfD * 100);
            if (footKeys.Add(key)) recording.Add(r);
        }

        /// <summary>True if (x, z) lies within pad of the building's recorded walls.</summary>
        public static bool InsideFootprint(in BuildingRecord b, float x, float z, float pad, float period, bool wrap)
        {
            if (!Footprints.TryGetValue(b.Type, out var rects) || rects.Count == 0) return false;
            float dx = HexMath.DxWrap(b.X, x, period, wrap), dz = z - b.Z;
            math.sincos(b.HasYaw ? b.Yaw : 0, out float sn, out float cs);
            float lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
            foreach (var r in rects)
            {
                math.sincos(r.Yaw, out float rs, out float rc);
                float ox = lx - r.X, oz = lz - r.Z;
                float u = Mathf.Abs(ox * rc - oz * rs), v = Mathf.Abs(ox * rs + oz * rc);
                if (u < r.HalfW + pad && v < r.HalfD + pad) return true;
            }
            return false;
        }

        /// <summary>The recorded footprints as JSON: { type: [[x, z, halfW, halfD, yaw], …] }.</summary>
        public static string ExportJson()
        {
            var sb = new StringBuilder("{\n");
            bool first = true;
            foreach (var pair in Footprints)
            {
                if (pair.Value.Count == 0) continue;
                if (!first) sb.Append(",\n");
                first = false;
                sb.Append("  \"").Append(pair.Key).Append("\": [");
                for (int i = 0; i < pair.Value.Count; i++)
                {
                    var r = pair.Value[i];
                    if (i > 0) sb.Append(", ");
                    sb.Append('[').Append(F(r.X)).Append(", ").Append(F(r.Z)).Append(", ").Append(F(r.HalfW)).Append(", ").Append(F(r.HalfD)).Append(", ").Append(F(r.Yaw)).Append(']');
                }
                sb.Append(']');
            }
            return sb.Append("\n}\n").ToString();
            static string F(float v) => v.ToString("0.###", CultureInfo.InvariantCulture);
        }
    }
}
