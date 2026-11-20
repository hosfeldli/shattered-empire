using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Damage is shown on the building itself (no health bar: the staged models break apart, CityRenderer.StagedModels.cs),
    /// with the whole body darkened by band (ComposeBuilding) and charred patches on the roof, in three stages
    /// (StructureStore bands):
    ///
    /// 1. Light (below 85%): soot streaks above the openings, hairline cracks, charred ground and debris.
    /// 2. Heavy (below 60%): a missing corner (charred cavity, jagged slab, rubble spilling down), more cracks,
    ///    rubble heaps and a smoke plume.
    /// 3. Critical (below 35%): a collapsed section, broken beams, heaps all round, open fires and heavy smoke.
    ///
    /// The marks go on the faces of the building's recorded walls (its footprint: authored layout walls or
    /// the recipe's solid modules), so they sit on the building rather than around it. Deterministic per
    /// building. Smoke and fire sources are published in <see cref="DamageEmitters"/> for the effects layer.
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        public struct DamageEmitter { public float3 Pos; public bool Fire; public float Size; }
        /// <summary>Smoke and fire sources of damaged buildings (map space), by building id.</summary>
        public readonly Dictionary<int, List<DamageEmitter>> DamageEmitters = new Dictionary<int, List<DamageEmitter>>();

        // greys and browns rather than near-black (2026-11-20, user: "they get too dark")
        static readonly float3 Soot = new float3(.40f, .38f, .35f);
        static readonly float3 Crack = new float3(.30f, .28f, .26f);
        static readonly float3 Charred = new float3(.34f, .31f, .28f);
        static readonly float3 Rubble = new float3(.55f, .52f, .47f);

        /// <summary>A roof colour lifted to a readable floor (no near-black roofs at any zoom).</summary>
        static float3 RoofFloor(float3 color)
        {
            const float Floor = .46f;
            float luma = math.dot(color, new float3(.30f, .59f, .11f));
            if (luma >= Floor) return color;
            return math.saturate(math.lerp(color * (Floor / math.max(luma, .05f)), new float3(Floor), .25f));
        }

        static float WallHeight(string type)
        {
            switch (type)
            {
                case "town": return .34f;
                case "barracks": return .26f;
                case "depot": return .23f;
                case "motor_works": return .29f;
                case "power_plant": return .28f;
                case "bunker": return .16f;
                case "fort": case "outpost": return .17f;
                case "guard_post": case "watchtower": return .1f;
                case "aa_battery": case "turret": case "city_turret": case "artillery_post": case "at_emplacement": return .07f;
                case "barricade": case "sandbags": return .06f;
                default: return .22f;
            }
        }

        void AddEmitter(int id, float3 pos, bool fire, float size)
        {
            if (id < 0) return;
            if (!DamageEmitters.TryGetValue(id, out var list)) DamageEmitters[id] = list = new List<DamageEmitter>(3);
            list.Add(new DamageEmitter { Pos = pos, Fire = fire, Size = size });
        }

        void DamageOverlay(in BuildingRecord b, float cx, float cz, float yaw, int seed)
        {
            int band = StructureStore.DamageBand(b.Hp);
            if (band == 0 || !b.Done) return;
            var c = new Ctx { X = cx, Z = cz, Yaw = yaw, Seed = seed, Tint = new float3(1), Civ = new float3(.5f), Era = 1, Level = 1, Scale = parcelScale };
            float k = S(c);
            math.sincos(yaw, out float sn, out float cs);
            float3 World(float lx, float lz, float lift)
            {
                float x = cx + lx * k * cs + lz * k * sn, z = cz - lx * k * sn + lz * k * cs;
                return new float3(x, Ground(x, z) + lift, z);
            }
            float height = WallHeight(b.Type);
            // staged Blender models show their own holes, collapse and rubble (CityRenderer.StagedModels.cs): the cavity and
            // collapse modules below are left out for them; soot, cracks, roof char, smoke and fire stay
            int tier = b.City > 0 ? SiteTier(b.City) : 1;
            bool staged = b.HasPosition && StagedKey(b.Type, tier) != null;
            int meshStage = MeshStage(band);

            // the building's solid walls; the two largest carry the marks
            FootRect main = new FootRect { HalfW = .26f, HalfD = .22f }, second = main;
            bool any = false;
            if (Footprints.TryGetValue(b.Type, out var rects))
                foreach (var r in rects)
                {
                    float area = r.HalfW * r.HalfD;
                    if (!any || area > main.HalfW * main.HalfD) { second = main; main = r; any = true; }
                    else if (area > second.HalfW * second.HalfD) second = r;
                }
            if (!any) second = main;

            // A point on a wall face: side 0 front (+d), 1 back, 2 right (+w), 3 left; t across the face (-1..1).
            void Face(in FootRect r, int side, float t, out float lx, out float lz, out float faceYaw, out float span)
            {
                math.sincos(r.Yaw, out float rs, out float rc);
                float u, v;
                if (side < 2) { u = t * r.HalfW * .8f; v = (side == 0 ? 1 : -1) * (r.HalfD + .006f); span = r.HalfW * 2; }
                else { v = t * r.HalfD * .8f; u = (side == 2 ? 1 : -1) * (r.HalfW + .006f); span = r.HalfD * 2; }
                lx = r.X + u * rc + v * rs; lz = r.Z - u * rs + v * rc;
                faceYaw = r.Yaw + (side < 2 ? 0 : math.PI * .5f);
            }

            // 1. soot streaks and hairline cracks on the faces, charred ground and debris at the foot
            int marks = 1 + band * 2;
            for (int i = 0; i < marks; i++)
            {
                var r = i % 3 == 2 ? second : main;
                int side = (int)(Hash(seed, 400 + i) * 4) & 3;
                Face(r, side, Hash(seed, 410 + i) * 2 - 1, out float lx, out float lz, out float faceYaw, out float span);
                float w = math.min(span * .4f, .06f + Hash(seed, 420 + i) * .08f);
                float h = height * (.35f + Hash(seed, 430 + i) * .4f);
                Module(c, Part.Box, lx, lz, new float3(w, h, .006f), Soot * (.9f + .2f * Hash(seed, 440 + i)), faceYaw, height - h - .01f);
                // a crack: two thin strokes at an angle, on the same face
                float roll = (Hash(seed, 450 + i) - .5f) * 1.4f;
                float ch = height * (.25f + Hash(seed, 460 + i) * .25f);
                ModuleRot(c, Part.Box, lx + .03f, lz + .03f, new float3(.006f, ch, .005f), Crack, 0, roll, faceYaw, height * .2f);
                ModuleRot(c, Part.Box, lx + .03f, lz + .03f, new float3(.005f, ch * .7f, .005f), Crack, 0, -roll * .8f, faceYaw, height * .2f + ch * .8f);
            }
            for (int i = 0; i < 1 + band; i++)
            {
                float a = Hash(seed, 470 + i) * 6.283f, d = .32f + Hash(seed, 480 + i) * .22f;
                var at = World(math.sin(a) * d, math.cos(a) * d, 0);
                if (!OverWater(at.xz))
                    GroundSector(at.xz, 0, .07f + Hash(seed, 490 + i) * .08f * band, 0, 2 * math.PI, -.0009f, new float3(.33f, .30f, .26f), SurfaceKind.Soil);
            }
            int heaps = band == 1 ? 2 : band == 2 ? 4 : 6;
            for (int i = 0; i < heaps; i++)
            {
                var r = i % 2 == 0 ? main : second;
                Face(r, (int)(Hash(seed, 500 + i) * 4) & 3, Hash(seed, 510 + i) * 2 - 1, out float lx, out float lz, out float faceYaw, out _);
                float s = (.05f + Hash(seed, 520 + i) * .05f) * (.7f + band * .25f);
                Module(c, Part.Cone, lx, lz, new float3(s * 1.7f, s * .55f, s * 1.7f), Rubble * (.85f + .2f * Hash(seed, 530 + i)));
                Module(c, Part.Box, lx + s * .6f, lz - s * .4f, new float3(s * .5f, s * .3f, s * .4f), Rubble * .9f, Hash(seed, 540 + i) * 3, 0);
            }
            // charred patches on the roof (2026-11-19): the face the RTS camera actually sees. Base facilities know their
            // roof (the authored mesh, or the recipe roof: CityRenderer.FacilityIdentity.cs); 2 / 4 / 7 patches by band
            // (staged models are scorched in the mesh itself: no flat patches over their pitched and arched roofs)
            if (b.HasPosition && b.City > 0 && !staged)
            {
                float datum = BuildingDatum(cx, cz, yaw);
                int patches = band == 1 ? 1 : band == 2 ? 2 : 4;
                for (int i = 0; i < patches * 2 && patches > 0; i++)
                {
                    float lx = main.X + (Hash(seed, 600 + i) * 2 - 1) * main.HalfW * .8f;
                    float lz = main.Z + (Hash(seed, 620 + i) * 2 - 1) * main.HalfD * .8f;
                    if (!RoofTopAt(b.Type, lx, lz, out float top, staged ? meshStage : -1, tier)) continue;
                    patches--;
                    float x = cx + lx * cs + lz * sn, z = cz - lx * sn + lz * cs;
                    float size = (.07f + Hash(seed, 640 + i) * .07f) * (.8f + band * .2f);
                    var scorch = Hash(seed, 660 + i) < .5f ? new float3(.30f, .28f, .25f) : new float3(.36f, .33f, .29f);
                    Put(Part.Box, new float3(x, datum + top - .002f, z), Hash(seed, 680 + i) * 3f, new float3(size, .008f, size * .75f), scorch);
                    Put(Part.Box, new float3(x, datum + top - .001f, z), Hash(seed, 700 + i) * 3f, new float3(size * .55f, .008f, size * 1.1f), scorch * .8f);
                }
            }
            if (band < 2) return;

            // 2. a missing corner on the main wall: charred cavity, a jagged slab, rubble spilling down
            {
                math.sincos(main.Yaw, out float rs, out float rc);
                float su = Hash(seed, 550) < .5f ? -1 : 1, sv = Hash(seed, 551) < .5f ? -1 : 1;
                float u = su * (main.HalfW - .05f), v = sv * (main.HalfD - .05f);
                float lx = main.X + u * rc + v * rs, lz = main.Z - u * rs + v * rc;
                float bite = math.min(.13f, math.min(main.HalfW, main.HalfD) * .9f);
                if (!staged)
                {
                    Module(c, Part.Box, lx, lz, new float3(bite, height * .45f, bite), Charred, main.Yaw, height * .6f);
                    Module(c, Part.Broken, lx + su * .04f, lz + sv * .04f, new float3(bite * 1.2f, height * .55f, bite), Rubble * .95f, main.Yaw + .4f);
                    Module(c, Part.Collapse, lx + su * .1f, lz + sv * .1f, new float3(bite * 1.8f, .07f + band * .02f, bite * 1.5f), Rubble);
                }
                var top = World(lx, lz, height * .9f);
                AddEmitter(b.Id, top, false, band == 2 ? .32f : .45f);
                if (band >= 3) AddEmitter(b.Id, top + new float3(0, -.05f, 0), true, .26f);
            }
            if (band < 3) return;

            // 3. a collapsed section and broken beams on the second wall, a second fire
            {
                Face(second, 1, Hash(seed, 560) * 2 - 1, out float lx, out float lz, out float faceYaw, out float span);
                if (!staged) Module(c, Part.Collapse, lx, lz, new float3(math.min(span, .34f), .12f, .22f), Rubble * .92f, faceYaw);
                for (int i = 0; i < 3 && !staged; i++)
                    ModuleRot(c, Part.Box, lx + (i - 1) * .05f, lz, new float3(.014f, height * .8f, .014f), Charred * 1.2f,
                        .5f + Hash(seed, 570 + i) * .5f, (Hash(seed, 580 + i) - .5f) * .6f, faceYaw, .02f);
                AddEmitter(b.Id, World(lx, lz, .08f), true, .22f);
                AddEmitter(b.Id, World(main.X, main.Z, height + .04f), false, .55f);
            }
        }
    }
}
