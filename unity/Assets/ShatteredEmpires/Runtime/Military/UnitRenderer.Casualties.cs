using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Military
{
    public sealed partial class UnitRenderer
    {
        struct Casualty { public int Epoch; public float3 Point; public float Facing, At; public Detail Torso; public float4 Color; public float3 Team; }
        readonly Casualty[] casualties = new Casualty[96];
        int casualtyHead;
        public void NoteCasualty(int id, string type, int owner, float3 point, int epoch, float time)
        {
            if (type != "rifle_squad" && type != "engineer" && type != "militia" && type != "anti_armor" && type != "special_forces" && type != "mortar_team") return;   // exo_infantry is a vehicle (IFV) since 2026-11-18
            float facing = id * 2.39996f;
            for (int s = 0; s < ids.Length; s++) if (ids[s] == id) { facing = yaw[s]; break; }
            casualties[casualtyHead++ % casualties.Length] = new Casualty { Epoch = epoch, Point = point, Facing = facing, At = time, Torso = Torso(type), Color = new float4(Paint(owner, Kind.Infantry, new float3(.40f, .42f, .35f)), 0),
                Team = lastCivColor != null ? TeamWear(lastCivColor(owner).xyz) * .85f : new float3(.6f, .6f, .58f) };
        }

        void DrawCasualties(float time, WorldModel world, Vector3 focus, float distance)
        {
            if (distance > OperationalDistance) return;
            foreach (var c in casualties)
            {
                float age = time - c.At;
                if (c.Epoch != world.Epoch || age < 0 || age > (RigFor(c.Torso, out _) != null ? 22 : 6)) continue;
                float dx = world.Grid.DxWrap(focus.x, c.Point.x), dz = c.Point.z - focus.z;
                if (dx * dx + dz * dz > 900) continue;
                float fall = Mathf.SmoothStep(0, 1, age / .72f), scale = .069f;
                var rig = RigFor(c.Torso, out int role);
                if (rig != null)
                {
                    // The death clip, then the body lies where it fell and finally settles into the ground.
                    float sink = Mathf.SmoothStep(0, 1, (age - 19f) / 3f) * .05f;
                    var at = MapSpace.W(new float3(c.Point.x, world.GroundHeight(c.Point.x, c.Point.z) - sink, c.Point.z));
                    float deathFrame = rig.Frame(SoldierRig.Clip.Die, age);
                    var fallen = InstanceData.TRS(at, quaternion.RotateY(MapSpace.Yaw(c.Facing)), new float3(scale), new float4(c.Color.xyz, 2 + deathFrame));
                    soldiers[role].Add(fallen);
                    figureTeam = c.Team;
                    AddTeamGear(role, fallen, deathFrame);
                    continue;
                }
                // Procedural (no baked rig): the knees give first, then the body topples (accelerating, like a
                // falling weight) backward or forward, settles with a small bounce and sinks out of view.
                float seed = math.frac(math.sin(c.At * 12.9898f + c.Point.x * 78.233f) * 43758.5453f);
                float dir = seed < .6f ? -1f : 1f;   // most fall back, away from the fire
                float buckle = Mathf.SmoothStep(0, 1, age / .25f);
                float t = Mathf.Clamp01((age - .12f) / .55f);
                fall = t * t;
                float settle = age - .67f;
                float bounce = settle > 0 ? Mathf.Exp(-settle * 9f) * Mathf.Sin(settle * 22f) * .06f : 0f;
                float sinkProc = age > 4.5f ? (age - 4.5f) / 1.5f : 0f;
                var rot = quaternion.EulerZXY(dir * (fall * 1.48f - bounce), MapSpace.Yaw(c.Facing + (seed - .5f) * .9f), (seed - .5f) * .5f * fall);
                float drop = buckle * (1f - fall) * .14f * scale;
                var root = MapSpace.W(new float3(c.Point.x, world.GroundHeight(c.Point.x, c.Point.z) + fall * .015f - drop - sinkProc * .02f, c.Point.z));
                DetailPart(c.Torso, root, rot, scale, c.Color);
                float knees = buckle * (1f - .75f * fall);
                for (int side = -1; side <= 1; side += 2)
                {
                    var hip = root + math.rotate(rot, new float3(side * .072f, .454f, 0) * scale);
                    var thigh = math.mul(rot, quaternion.EulerZXY(-knees * .7f, 0, side * fall * .12f));
                    DetailPart(Detail.Thigh, hip, thigh, scale, c.Color);
                    DetailPart(Detail.Shin, hip + math.rotate(thigh, new float3(0, -.245f, 0) * scale), math.mul(thigh, quaternion.RotateX(knees * 1.1f)), scale, c.Color);
                    var shoulder = root + math.rotate(rot, new float3(side * .161f, .715f, .01f) * scale);
                    // arms fly out as the body goes over, then lie loose
                    float fling = Mathf.Sin(t * math.PI) * .9f + fall * .3f;
                    var upper = math.mul(rot, quaternion.EulerZXY(dir * fling * (.6f + .4f * seed), 0, side * (.25f + fall * .4f)));
                    DetailPart(Detail.UpperArm, shoulder, upper, scale, c.Color);
                    DetailPart(Detail.Forearm, shoulder + math.rotate(upper, new float3(0, -.155f, 0) * scale), math.mul(upper, quaternion.RotateX(-.5f * buckle)), scale, c.Color);
                }
            }
        }
    }
}
