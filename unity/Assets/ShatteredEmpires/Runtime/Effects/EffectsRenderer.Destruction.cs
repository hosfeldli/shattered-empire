using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Destruction: buildings that collapse storey by storey (a dust burst rolling out from the base, masonry
    /// chunks falling on ballistic arcs that land, bounce and rest, then lingering smoke columns and fires over
    /// a rubble spill that persists), vehicles that blow apart (hull pieces thrown, a scorched patch, a burning
    /// wreck pouring oily smoke and cooking off secondary explosions) and charred scorch marks. Everything is
    /// pooled in fixed arrays (timed stages, long-lived emitters, a rubble ring buffer) and emits through the
    /// shared particle budget, so nothing allocates per frame and cost stays bounded however much is destroyed.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        const int MaxRubble = 2400, MaxPending = 96, MaxEmitters = 48;
        const byte StageCollapse = 0, StageSecondary = 1;
        const byte EmitterSmoke = 0, EmitterFire = 1, EmitterWreck = 2;

        struct Pending { public float At, Scale, Floor; public float3 Point; public byte Kind; }
        struct Emitter { public float3 Point; public float Size, Age, Life, Next; public byte Kind; }

        readonly InstanceBatch rubble;
        int rubbleHead;
        readonly Pending[] pending = new Pending[MaxPending];
        int pendingCount;
        readonly Emitter[] emitters = new Emitter[MaxEmitters];
        int emitterCount;

        float GroundOr(float3 p) => GroundAt != null ? GroundAt(p.x, p.z) : p.y;

        /// <summary>
        /// A building collapsing at a map point (e.g. the server's 'demolish' event, or a building destroyed).
        /// scale: the building's footprint radius in map units (about .15 for a hut, .3 a block, .6 a works).
        /// </summary>
        public void BuildingCollapse(float3 point, float scale)
        {
            float r = math.clamp(scale, .08f, 1.2f);
            float floor = GroundOr(point);
            var g = new float3(point.x, floor, point.z);
            Blast?.Invoke(g, r * 2f);
            FlashLight(g + new float3(0, .08f, 0), .4f + r);
            Shake = Mathf.Max(Shake, .1f + r * .25f);
            // the structure gives way: a dense dust wave bursts out along the ground from its base
            int ring = 10 + (int)(r * 14);
            for (int k = 0; k < ring; k++)
            {
                float a = k / (float)ring * 6.283f + R() * .5f;
                float shade = .38f + R() * .12f;
                Emit(g + new float3(math.cos(a) * r * .4f, .03f, math.sin(a) * r * .4f), new float3(math.cos(a), .06f + R() * .08f, math.sin(a)) * (.45f + R() * .35f) * (.5f + r),
                    (.09f + R() * .05f) * (.6f + r), .26f * (.6f + r), 3.5f + R() * 2.5f, new float3(shade, shade * .94f, shade * .86f), new float3(.56f, .54f, .5f), .62f, false, 0, 1.4f, .015f);
            }
            // then it comes down storey by storey: each stage drops masonry and lifts more dust
            int stages = 3 + (int)(r * 4);
            float at = .05f;
            for (int k = 0; k < stages; k++)
            {
                Schedule(StageCollapse, at, g, r * (1f - k * .1f), floor);
                at += .28f + R() * .22f;
            }
            // what is left: a rubble spill beyond the walls, a scorched patch, fires in the wreckage, a smoke column
            SpillRubble(g, r, 14 + (int)(r * 26), false);
            Scorch(g, r * 1.5f);
            AddEmitter(g + new float3((R() - .5f) * r * .3f, .05f, (R() - .5f) * r * .3f), r * .55f, 60f + R() * 40f, EmitterSmoke);
            int fires = 1 + (r > .3f ? 1 : 0) + (r > .55f ? 1 : 0);
            for (int k = 0; k < fires; k++)
                AddEmitter(g + new float3((R() - .5f) * r * .9f, .04f, (R() - .5f) * r * .9f), math.min(.35f, r * .5f), 20f + R() * 25f, EmitterFire);
        }

        /// <summary>
        /// A vehicle destroyed at a map point: a catastrophic blast, hull pieces (and the turret) thrown on arcs,
        /// a scorched patch with scattered fragments, and a wreck that burns and cooks off a few secondary explosions.
        /// scale: the vehicle's size class (about .2 for a tank, .12 a light vehicle).
        /// </summary>
        public void VehicleDestroyed(float3 point, float yaw, float scale)
        {
            float k = math.clamp(scale / .2f, .5f, 1.6f);
            float floor = GroundOr(point);
            var g = new float3(point.x, floor, point.z);
            Explosion(g + new float3(0, .03f, 0), .85f * k);
            for (int i = 0; i < 9; i++)
            {
                float a = R() * 6.283f;
                float speed = (.35f + R() * .55f) * k;
                float shade = .08f + R() * .1f;
                EmitDebris(g + new float3(0, .05f * k, 0), new float3(math.cos(a) * speed, (1f + R() * 1.3f) * k, math.sin(a) * speed),
                    (.010f + R() * .014f) * k, 2f + R() * 1.5f, new float3(shade, shade * .95f, shade * .9f), floor);
            }
            // the turret (or cab roof) lifted off and dropped beside the hull
            float ta = yaw + (R() - .5f) * 2.4f;
            EmitDebris(g + new float3(0, .08f * k, 0), new float3(math.sin(ta) * .35f, 2f, math.cos(ta) * .35f) * k, .036f * k, 3.2f, new float3(.12f, .12f, .11f), floor);
            Scorch(g, .24f * k);
            SpillRubble(g, .18f * k, 6 + (int)(k * 4), true);
            AddEmitter(g + new float3(0, .04f, 0), .15f * k, 35f + R() * 25f, EmitterWreck);
            int cookOffs = 1 + (int)(R() * 2.6f);
            float at = 1.2f + R() * 1.5f;
            for (int i = 0; i < cookOffs; i++) { Schedule(StageSecondary, at, g, k, floor); at += 1.5f + R() * 4f; }
        }

        /// <summary>A cook-off: stored rounds or fuel going up in a burning wreck.</summary>
        public void SecondaryExplosion(float3 p)
        {
            float floor = GroundOr(p);
            var g = new float3(p.x + (R() - .5f) * .03f, floor + .03f, p.z + (R() - .5f) * .03f);
            Emit(g + new float3(0, .03f, 0), float3.zero, .07f, .36f, .09f, new float3(1f, .8f, .45f), new float3(.9f, .3f, .06f), .9f, true, 1.4f);
            for (int i = 0; i < 6; i++)
                Emit(g, RandDir() * (1f + R()) + new float3(0, .8f, 0), .006f, 0, .5f + R() * .4f, new float3(1f, .8f, .4f), new float3(1f, .35f, .1f), 1f, true, 2f, .6f, -2.2f, Streak, default, true);
            for (int i = 0; i < 3; i++)
                Emit(g + new float3(0, .04f, 0), new float3((R() - .5f) * .1f, .22f + R() * .1f, (R() - .5f) * .1f), .06f, .16f, 4f + R() * 2f,
                    new float3(.06f, .055f, .05f), new float3(.25f, .24f, .23f), .6f, false, 0, .5f, .06f);
            for (int i = 0; i < 3; i++)
                EmitDebris(g, new float3(R() - .5f, 1.2f + R(), R() - .5f) * .5f, .008f + R() * .008f, 1.5f, new float3(.22f, .21f, .19f), floor);
            FlashLight(g, .35f);
            Shake = Mathf.Max(Shake, .05f);
        }

        /// <summary>A charred blast mark on the ground (persists with the craters).</summary>
        public void Scorch(float3 p, float radius)
        {
            float y = GroundOr(p);
            float shade = .2f + R() * .04f;   // burnt earth (a near-black disc read as a hole in the map)
            var d = InstanceData.TRS(MapSpace.W(new float3(p.x, y, p.z)) + new float3(0, .007f, 0), R() * 6.28f,
                new float3(radius * 2f, 1, radius * 2f * (.75f + R() * .4f)) * MarkScale, MarkColor(new float3(shade, shade * .9f, shade * .78f), .8f));
            if (craters.Count < MaxCraters) craters.Add(d);
            else { craters.Data[craterHead] = d; craterHead = (craterHead + 1) % MaxCraters; craters.MarkDirty(); }
        }

        void SpillRubble(float3 g, float r, int n, bool metal)
        {
            for (int i = 0; i < n; i++)
            {
                float a = R() * 6.283f, dist = r * (.3f + R() * .85f);
                float x = g.x + math.cos(a) * dist, z = g.z + math.sin(a) * dist;
                float s = (metal ? .006f + R() * .012f : .01f + R() * .028f) * math.min(1.2f, .5f + r * 1.5f);
                var size = new float3(s * (1f + R()), s * (.3f + R() * .5f), s * (.7f + R() * .7f));
                float y = (GroundAt != null ? GroundAt(x, z) : g.y) + size.y * .2f;   // half buried
                var rot = quaternion.EulerZXY((R() - .5f) * .9f, R() * 6.283f, (R() - .5f) * .9f);
                float3 color;
                if (metal) { float m = .22f + R() * .12f; color = new float3(m, m * .95f, m * .88f); }
                else if (R() < .22f) { float c = .2f + R() * .08f; color = new float3(c, c * .9f, c * .8f); }   // charred timber
                else { float c = .36f + R() * .2f; color = new float3(c, c * .95f, c * (.85f + R() * .1f)); }   // masonry, brick dust
                var d = InstanceData.TRS(MapSpace.W(new float3(x, y, z)), rot, size, new float4(color, 0));
                if (rubble.Count < MaxRubble) rubble.Add(d);
                else { rubble.Data[rubbleHead] = d; rubbleHead = (rubbleHead + 1) % MaxRubble; rubble.MarkDirty(); }
            }
        }

        void Schedule(byte kind, float delay, float3 point, float scale, float floor)
        {
            if (pendingCount >= MaxPending) return;
            pending[pendingCount++] = new Pending { At = delay, Point = point, Scale = scale, Floor = floor, Kind = kind };
        }

        void AddEmitter(float3 point, float size, float life, byte kind)
        {
            int slot = emitterCount;
            if (emitterCount >= MaxEmitters)
            {
                // full: replace the one nearest its end
                slot = 0;
                float left = float.MaxValue;
                for (int i = 0; i < emitterCount; i++)
                {
                    float remaining = emitters[i].Life - emitters[i].Age;
                    if (remaining < left) { left = remaining; slot = i; }
                }
            }
            else emitterCount++;
            emitters[slot] = new Emitter { Point = point, Size = size, Age = 0, Life = life, Next = 0, Kind = kind };
        }

        void CollapseStage(in Pending stage)
        {
            float r = stage.Scale;
            var g = stage.Point;
            // masonry and timbers falling out of the storey that gives way, on arcs, landing around the base
            int chunks = 6 + (int)(r * 12 * Intensity);
            for (int i = 0; i < chunks; i++)
            {
                float a = R() * 6.283f, dist = R() * r * .55f;
                var from = g + new float3(math.cos(a) * dist, r * (.25f + R() * .55f), math.sin(a) * dist);
                var vel = new float3(math.cos(a) * (.1f + R() * .45f) * r, .1f + R() * .45f, math.sin(a) * (.1f + R() * .45f) * r);
                float c = R() < .25f ? .12f + R() * .06f : .34f + R() * .2f;
                EmitDebris(from, vel, (.012f + R() * .022f) * math.min(1.3f, .5f + r * 1.4f), 2.4f + R() * 1.6f, new float3(c, c * .94f, c * .86f), stage.Floor, -3f);
            }
            // dust boils up out of the falling storey and spreads low around it
            for (int i = 0; i < 4 + (int)(r * 6); i++)
            {
                float a = R() * 6.283f;
                float shade = .4f + R() * .12f;
                Emit(g + new float3(math.cos(a) * r * .5f * R(), .03f + R() * r * .3f, math.sin(a) * r * .5f * R()),
                    new float3(math.cos(a) * .25f, .1f + R() * .12f, math.sin(a) * .25f) * (.5f + r),
                    (.12f + R() * .06f) * (.5f + r), .3f * (.5f + r), 5f + R() * 4f, new float3(shade, shade * .95f, shade * .88f), new float3(.6f, .58f, .55f), .55f, false, 0, .9f, .03f);
            }
            Shake = Mathf.Max(Shake, .04f + r * .08f);
            Blast?.Invoke(g, r);
        }

        void UpdateDestruction(float dt)
        {
            if (dt <= 0) return;
            for (int i = 0; i < pendingCount; i++)
            {
                pending[i].At -= dt;
                if (pending[i].At > 0) continue;
                var stage = pending[i];
                pending[i--] = pending[--pendingCount];
                if (stage.Kind == StageCollapse) CollapseStage(stage);
                else SecondaryExplosion(stage.Point + new float3((R() - .5f) * .04f * stage.Scale, 0, (R() - .5f) * .04f * stage.Scale));
            }
            for (int i = 0; i < emitterCount; i++)
            {
                ref var e = ref emitters[i];
                e.Age += dt;
                if (e.Age >= e.Life) { emitters[i--] = emitters[--emitterCount]; continue; }
                e.Next -= dt;
                if (e.Next > 0) continue;
                // fires die down and smoke thins over the emitter's life
                float vigour = 1f - Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(.55f, 1f, e.Age / e.Life));
                switch (e.Kind)
                {
                    case EmitterSmoke:
                    {
                        e.Next = .3f + R() * .15f;
                        float g = .20f + R() * .07f;   // final pass: grey, not black (it stacked into sheets that hid units)
                        Emit(e.Point + new float3((R() - .5f) * e.Size * .4f, 0, (R() - .5f) * e.Size * .4f), Wind * .06f + new float3(0, .16f + R() * .08f, 0),
                            e.Size * (.5f + R() * .3f), e.Size * .55f, 9f + R() * 4f, new float3(g, g * .97f, g * .93f), new float3(.46f, .44f, .41f), .42f * vigour, false, 0, .3f, .045f);
                        break;
                    }
                    case EmitterFire:
                        e.Next = .14f + R() * .06f;
                        Fire(e.Point, math.max(.05f, e.Size * vigour), false);
                        break;
                    default:
                    {
                        // a burning wreck: low flames and a thick, oily black plume
                        e.Next = .16f + R() * .08f;
                        if (vigour > .25f) Fire(e.Point, e.Size * vigour, true);
                        float g = .13f + R() * .05f;   // dark oily smoke, but no longer a black sheet over the units
                        Emit(e.Point + new float3(0, .04f, 0), Wind * .08f + new float3((R() - .5f) * .03f, .2f + R() * .07f, (R() - .5f) * .03f),
                            .05f, .14f, 6f + R() * 3f, new float3(g, g * .95f, g * .9f), new float3(.34f, .33f, .31f), .48f * vigour + .08f, false, 0, .35f, .05f);
                        break;
                    }
                }
            }
        }

        void ClearDestruction()
        {
            rubble.Clear(); rubbleHead = 0;
            pendingCount = 0; emitterCount = 0;
        }
    }
}
