using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        struct AnimatedFlag { public float3 Position, Color; public float Scale; public int Seed; }
        InstanceBatch activityBoxes, activityRotors, activityDishes;
        public void Animate(float time, float simulationTime, float3 focus, float distance, float3 wind = default)
        {
            if (activityBoxes == null)
            {
                var bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f);
                activityBoxes = new InstanceBatch(MeshKit.Box, RenderResources.Instanced, 512) { Bounds = bounds };
                activityRotors = new InstanceBatch(MilitaryMeshes.Rotor, RenderResources.Instanced, 64) { Bounds = bounds };
                activityDishes = new InstanceBatch(satelliteDish, RenderResources.Instanced, 32) { Bounds = bounds };
            }
            activityBoxes.Clear(); activityRotors.Clear(); activityDishes.Clear();
            float windSpeed = math.clamp(math.length(wind), .1f, 3f);
            var direction = math.normalizesafe(new float2(wind.x, wind.z), new float2(1, .3f));
            float flagYaw = math.atan2(-direction.y, direction.x);
            float reach = math.min(35, math.max(9, distance));
            foreach (var cell in cells.Values) foreach (var flag in cell.Flags)
            {
                if (math.abs(world.Grid.DxWrap(focus.x, flag.Position.x)) + math.abs(focus.z - flag.Position.z) > reach) continue;
                for (int k = 0; k < 8; k++)
                {
                    float along = (k + .5f) / 8f;
                    float wave = math.sin(time * (2.8f + windSpeed) - along * 6 + flag.Seed);
                    float stretch = .65f + math.min(1, windSpeed) * .35f;
                    var p = flag.Position + new float3(direction.x * along * .12f * flag.Scale * stretch - direction.y * wave * along * .012f,
                        -.009f * along + wave * along * .004f, direction.y * along * .12f * flag.Scale * stretch + direction.x * wave * along * .012f);
                    activityBoxes.Add(InstanceData.TRS(MapSpace.W(p), MapSpace.Yaw(flagYaw), new float3(.017f * flag.Scale, .058f, .003f), new float4(flag.Color, 0)));
                }
            }
            if (distance > 42) return;
            int budget = 0;
            foreach (var b in structures.Buildings.Values)
            {
                if (b.Memory || b.Tile < 0 || b.Tile >= world.Grid.N || ++budget > 256) continue;
                float x = b.HasPosition ? b.X : world.Grid.CenterX(b.Tile), z = b.HasPosition ? b.Z : world.Grid.CenterZ(b.Tile);
                float dx = world.Grid.DxWrap(focus.x, x), dz = z - focus.z;
                if (dx * dx + dz * dz > reach * reach) continue;
                float y = b.HasPosition ? BuildingDatum(x, z, b.Yaw) : Ground(x, z), phase = simulationTime * .34f + b.Id * 1.78f;
                float facing = b.HasYaw ? b.Yaw : 0;
                math.sincos(facing, out float sn, out float cs);
                float3 Local(float lx, float lz, float lift) => new float3(x + lx * cs + lz * sn, y + lift, z - lx * sn + lz * cs);
                if (!b.Done && b.Progress > 0 && b.Progress < 100 && b.State != "paused")
                {
                    // Slow crane slew and traveling load reflect an active project only.
                    if (b.Progress >= 25 && b.Progress <= 85)
                    {
                        var pivot = Local(.36f, .27f, .43f);
                        float angle = facing + math.sin(phase * .40f) * .8f;
                        activityBoxes.Add(InstanceData.TRS(MapSpace.W(pivot), MapSpace.Yaw(angle), new float3(.012f, .016f, .43f), new float4(.85f, .63f, .24f, 0)));
                        var load = pivot + new float3(math.sin(angle) * .13f, -.09f - (math.sin(phase) + 1) * .05f, math.cos(angle) * .13f);
                        ActivityBox(load, new float3(.05f, .03f, .04f), new float3(.52f, .50f, .46f));
                        ActivityBox(new float3(load.x, load.y + .03f, load.z), new float3(.002f, pivot.y - load.y - .03f, .002f), new float3(.35f));
                    }
                }
                if (b.Done && b.Active && b.HasPosition && (b.Type == "motor_works" || b.Type == "advanced_lab" || b.Type == "power_plant"))
                {
                    float lx = b.Type == "motor_works" ? -.07f : .28f, lz = b.Type == "motor_works" ? -.39f : b.Type == "advanced_lab" ? -.25f : .27f;
                    float height = b.Type == "motor_works" ? .398f : b.Type == "advanced_lab" ? .328f : .163f;
                    int count = b.Type == "power_plant" ? 1 : 2;
                    for (int k = 0; k < count; k++)
                        activityRotors.Add(InstanceData.TRS(MapSpace.W(Local(lx + (k - (count - 1) * .5f) * .095f, lz, height)),
                            MapSpace.Yaw(time * 11 + b.Id), new float3(.039f, .028f, .039f), new float4(.52f, .55f, .53f, 0)));
                }
                if (b.Done && (b.Type == "aa_battery" || b.Type == "comms_tower"))
                {
                    var p = Local(.12f, 0, .30f);
                    activityDishes.Add(InstanceData.TRS(MapSpace.W(p), MapSpace.Yaw(phase), new float3(.13f), new float4(.84f, .86f, .81f, 0)));
                }
            }
        }

        void ActivityBox(float3 position, float3 size, float3 color) => activityBoxes.Add(InstanceData.TRS(MapSpace.W(position), 0, size, new float4(color, 0)));
    }
}
