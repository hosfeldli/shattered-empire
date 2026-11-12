using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Military
{
    public sealed partial class UnitRenderer
    {
        struct Casualty { public int Epoch; public float3 Point; public float Facing, At; public Detail Torso; public float4 Color; }
        readonly Casualty[] casualties = new Casualty[96];
        int casualtyHead;
        public void NoteCasualty(int id, string type, int owner, float3 point, int epoch, float time)
        {
            if (type != "rifle_squad" && type != "engineer" && type != "militia" && type != "anti_armor" && type != "special_forces" && type != "exo_infantry" && type != "mortar_team") return;
            float facing = id * 2.39996f;
            for (int s = 0; s < ids.Length; s++) if (ids[s] == id) { facing = yaw[s]; break; }
            casualties[casualtyHead++ % casualties.Length] = new Casualty { Epoch = epoch, Point = point, Facing = facing, At = time, Torso = Torso(type), Color = new float4(Paint(owner, Kind.Infantry, new float3(.40f, .42f, .35f)), 0) };
        }

        void DrawCasualties(float time, WorldModel world, Vector3 focus, float distance)
        {
            if (distance > OperationalDistance) return;
            foreach (var c in casualties)
            {
                float age = time - c.At;
                if (c.Epoch != world.Epoch || age < 0 || age > 6) continue;
                float dx = world.Grid.DxWrap(focus.x, c.Point.x), dz = c.Point.z - focus.z;
                if (dx * dx + dz * dz > 900) continue;
                float fall = Mathf.SmoothStep(0, 1, age / .72f), scale = .069f;
                var rot = quaternion.EulerZXY(fall * 1.51f, MapSpace.Yaw(c.Facing), fall * .17f);
                var root = MapSpace.W(new float3(c.Point.x, world.GroundHeight(c.Point.x, c.Point.z) + fall * .015f, c.Point.z));
                DetailPart(c.Torso, root, rot, scale, c.Color);
                for (int side = -1; side <= 1; side += 2)
                {
                    var hip = root + math.rotate(rot, new float3(side * .072f, .454f, 0) * scale);
                    var thigh = math.mul(rot, quaternion.RotateX(side * fall * .26f));
                    DetailPart(Detail.Thigh, hip, thigh, scale, c.Color);
                    DetailPart(Detail.Shin, hip + math.rotate(thigh, new float3(0, -.245f, 0) * scale), thigh, scale, c.Color);
                    var shoulder = root + math.rotate(rot, new float3(side * .161f, .715f, .01f) * scale);
                    var upper = math.mul(rot, quaternion.RotateZ(side * fall * .4f));
                    DetailPart(Detail.UpperArm, shoulder, upper, scale, c.Color);
                    DetailPart(Detail.Forearm, shoulder + math.rotate(upper, new float3(0, -.155f, 0) * scale), upper, scale, c.Color);
                }
            }
        }
    }
}
