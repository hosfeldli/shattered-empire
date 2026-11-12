using System;
using SE.Core.Protocol;
using SE.Core.World;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.App
{
    public sealed partial class IntroDirector
    {
        readonly float[] attackAt = { .34f, .56f, .76f };
        readonly float3[] attackTargets = new float3[3];
        readonly bool[] districtCollapsed = new bool[3];

        // This is an authored cinematic set using the normal terrain packet and renderer.
        // It does not change map generation, navigation or terrain in playable matches.
        static void AuthorCinematicGeography(GeoMessage geography)
        {
            var grid = new HexGrid(128, 128, false);
            float centerX = grid.CenterX(58 * 128 + 64), centerZ = grid.CenterZ(58 * 128 + 64);
            foreach (var chunk in geography.Chunks)
                for (int i = 0; i < 256; i++)
                {
                    int q = chunk.Cx * 16 + i % 16, r = chunk.Cy * 16 + i / 16, tile = r * 128 + q, at = i * 6;
                    float x = grid.CenterX(tile) - centerX, z = grid.CenterZ(tile) - centerZ;
                    float urban = Mathf.Max(Mathf.Abs(x) / 36f, Mathf.Abs(z + 3) / 25f);
                    bool compound = math.distance(new float2(q, r), new float2(42, 84)) < 5
                        || math.distance(new float2(q, r), new float2(91, 90)) < 5
                        || math.distance(new float2(q, r), new float2(80, 73)) < 4;
                    if (urban > 1.15f && !compound) continue;
                    // Estuary, sheltered waterfront and wooded uplands shape the city, rather
                    // than flattening its entire surroundings into a rectangular plain.
                    float shore = -15.5f + Mathf.Sin(x * .13f) * 1.6f
                        + 6.5f * Mathf.Exp(-Mathf.Pow((x - 18) / 4.2f, 2));
                    bool sea = !compound && z < shore;
                    float upland = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(8, 23, z))
                        * (4 + 5 * Mathf.Pow(Mathf.Sin(x * .09f + .8f), 2));
                    byte height = sea ? (byte)116 : (byte)(140 + Mathf.RoundToInt(upland + Mathf.Sin(x * .14f) * .7f));
                    float blend = compound ? 1 : 1 - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(.90f, 1.15f, urban));
                    chunk.Data[at] = (byte)Mathf.RoundToInt(Mathf.Lerp(chunk.Data[at], height, blend));
                    if (blend < .6f) continue;
                    bool woods = z > 15 + Mathf.Sin(x * .21f) * 2 || x < -29 && z > 3;
                    chunk.Data[at + 1] = sea ? (byte)1 : woods ? (byte)4 : (byte)3;
                    chunk.Data[at + 2] = sea ? (byte)24 : (byte)0;
                    chunk.Data[at + 3] = chunk.Data[at + 4] = chunk.Data[at + 5] = 0;
                }
        }

        void DirectCollapseSequence()
        {
            shots[0].Seconds = 7;
            shots[0].From = cityP + new float3(-4, .30f, 2); shots[0].To = cityP + new float3(1, .25f, 0);
            shots[0].D0 = 10; shots[0].D1 = 18; shots[0].Yaw0 = 8; shots[0].Yaw1 = 25; shots[0].Pitch = 21;
            shots[0].Dim = .64f; shots[0].Elevation = 4; shots[0].Caption = "A connected world. Millions of lives. One fragile peace.";
            shots[0].Enter = () => Shader.SetGlobalFloat("_SE_CityPower", 3);
            shots[1].Seconds = 12; shots[1].D0 = 26; shots[1].D1 = 42; shots[1].Pitch = 32;
            shots[1].From = cityP + new float3(3, 3, -1); shots[1].To = cityP + new float3(5, 0, -1);
            shots[1].Caption = "The warning came too late. The missiles were already inbound.";
            shots[1].Enter = () => {
                Array.Clear(incoming, 0, incoming.Length); Array.Clear(districtCollapsed, 0, districtCollapsed.Length);
                struck1 = struck2 = struck3 = false;
                audio?.Play("siren", cityP, .80f, 18, 5, 30);
            };
            shots[2].Seconds = 7; shots[2].D0 = 20; shots[2].D1 = 13;
            shots[2].Caption = "Cities fell together. Winter outlived the nations.";
            shots[2].Enter = () => { Shader.SetGlobalFloat("_SE_CityPower", 0); audio?.StopCue("siren"); Ruin(); };
            shots[3].Caption = "The earth endured. So did we.";
            shots[6].Seconds = 7; shots[6].D0 = 4.8f; shots[6].D1 = 3.4f; shots[6].Pitch = 27;
            shots[6].Azimuth = 110; shots[6].Elevation = 36;
            shots[6].Caption = "The launch systems survived. So did the choice.";
            shots[6].Enter = () => { fx.ClearPersistent(); fires.Clear(); Shader.SetGlobalFloat("_SE_CityPower", .08f); };
        }

        void BuildSiloSurroundings(int center)
        {
            var origin = new Vector2(g.CenterX(center), g.CenterZ(center));
            var points = new[] { new Vector2(-1.1f, -.65f), new Vector2(.95f, -.82f), new Vector2(-1.05f, .91f) };
            var types = new[] { "bunker", "power_plant", "guard_post" };
            for (int i = 0; i < points.Length; i++)
            {
                var p = origin + points[i]; int tile = g.TileAt(p.x, p.y);
                var b = MilitaryBuilding(tile, types[i], 1, 1); b.X = p.x; b.Z = p.y; b.Slot = b.Id;
                if (i != 1) { b.State = "ruin"; b.Active = false; b.Hp = 12; }
                strategic.Add(b); SetUrban(tile, true);
            }
            sceneRoads.Add(new[] { origin + new Vector2(-1.4f, .6f), origin + new Vector2(-.7f, .47f), origin + new Vector2(.3f, .46f), origin + new Vector2(1.25f, .65f) });
            sceneRoads.Add(new[] { origin + new Vector2(.72f, -1.4f), origin + new Vector2(.71f, -.3f), origin + new Vector2(.55f, .46f) });
        }

        void MetropolitanAttack(float u)
        {
            bool changed = false;
            for (int i = 0; i < attackAt.Length; i++)
            {
                float at = attackAt[i]; var target = attackTargets[i];
                if (!incoming[i] && u >= at - .22f)
                {
                    incoming[i] = true;
                    // Large, coherent reentry tracks converge on population centers, from beyond
                    // the frame. Three separated impacts let the viewer understand the geography.
                    fx.Projectile(target + new float3(-10 + i * 4, 16, -8 - i * 2), target, "warhead", 2.64f);
                    for (int j = 1; j <= 2; j++)
                        fx.Projectile(target + new float3(-10 + i * 4 + j * 1.3f, 17 + j, -8 - i * 2), target + new float3(j * .9f, 0, j * -.5f), "warhead", 2.64f + j * .12f);
                }
                if (!districtCollapsed[i] && u >= at)
                {
                    districtCollapsed[i] = true; changed = true;
                    fx.Strategic(target, 2.1f + i * .15f);
                    audio?.Play("strategic", target, 1.0f, 22, 5, cam.Distance, .35f + i * .12f);
                    audio?.Play("distant_blast", target, .85f, 28, 4, cam.Distance, 1.05f + i * .18f);
                    for (int n = 0; n < city.Count; n++)
                    {
                        var b = city[n];
                        if (math.distancesq(new float2(b.X, b.Z), target.xz) > 110) continue;
                        b.State = "ruin"; b.Active = false; b.Hp = 0; city[n] = b;
                        if (fires.Count < 18 && n % 11 == 0) fires.Add(new float3(b.X, w.GroundHeight(b.X, b.Z) + .05f, b.Z));
                    }
                }
            }
            if (changed)
            {
                cityView.SetShowcaseDamage(.55f);
                Stage(city, valley, rival, strategic);
            }
            Shader.SetGlobalFloat("_SE_CityPower", u < .34f ? 3 : u < .56f ? (Mathf.Sin(u * 180) > 0 ? .6f : .05f) : 0);
            atmosphere.Dim = Mathf.Lerp(.64f, .28f, Mathf.Clamp01((u - .34f) / .5f));
            atmosphere.Haze = .25f + Mathf.Clamp01((u - .34f) / .5f) * .45f;
        }

        void UpdateCinematicSound(float u)
        {
            float cityLevel = shot == 0 ? 1 : shot == 1 ? Mathf.Clamp01(1 - u * 1.7f) : 0;
            audio?.CinematicCity(cityLevel, cityP);
            audio?.CinematicDynamics(shot == 1 ? .66f : shot == 6 ? .38f : 1);
        }
    }
}
