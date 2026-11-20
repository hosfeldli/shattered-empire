using System.Collections.Generic;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Base facility identity (2026-11-19, user: "the different base buildings are still not distinct enough, they need
    /// to be very obvious" and "the building type decal should go directly on top of it, not in front of it").
    ///
    /// Every base facility gets three things on top of its model, all static and composed with the building:
    /// <list type="bullet">
    /// <item>a per-type accent colour (<see cref="FacilityAccent"/>): green barracks, blue vehicle works, red heavy
    /// weapons, sky airfield, yellow generator, orange materials processor, teal lab, magenta silo. It
    /// rims the building's pad (SocketPad) and fills the roof emblem, so a base reads by colour even at operational zoom;</item>
    /// <item>a roof emblem: an accent plate with a dark rim and the type's white sign, laid flat on the highest broad
    /// part of the roof (found by sampling the authored mesh, or from the recipe's known roof) and turned so it reads
    /// upright from the default camera. It replaces the painted glyph that sat on the causeway in front of the pad;</item>
    /// <item>a landmark silhouette (<see cref="FacilityLandmark"/>): a tall flag at the barracks, cooling towers at the
    /// generator, silos and a conveyor at the processor, accent door frames and a vehicle pad at the vehicle works, a
    /// tower crane at the heavy weapons facility, a parked jet and runway thresholds at the airfield, a radome at the lab,
    /// a missile on its erector at the silo.</item>
    /// </list>
    /// Composed after the footprint is recorded (ComposeBuilding), so none of it changes the collision footprints.
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        /// <summary>The per-type accent colour of a base facility; false for anything else (HQ, defenses, city fabric).</summary>
        public static bool FacilityAccent(string type, out float3 color)
        {
            switch (type)
            {
                case "barracks": case "camp": color = new float3(.36f, .86f, .30f); return true;
                case "motor_works": color = new float3(.26f, .52f, 1f); return true;
                case "heavy_weapons": case "heavy_assembly": color = new float3(.96f, .24f, .20f); return true;
                case "airfield": color = new float3(.62f, .90f, 1f); return true;
                case "power_plant": color = new float3(1f, .86f, .14f); return true;
                case "depot": color = new float3(1f, .55f, .10f); return true;
                case "advanced_lab": color = new float3(.18f, .95f, .80f); return true;
                case "missile_silo": color = new float3(1f, .30f, .74f); return true;
                case "defense_works": color = new float3(.86f, .74f, .48f); return true;
                default: color = default; return false;
            }
        }

        // ------------------------------------------------------------------ roof spots
        struct RoofSpot { public float X, Z, Y, Size; }
        static readonly Dictionary<string, RoofSpot> roofSpots = new Dictionary<string, RoofSpot>();
        static readonly Dictionary<Part, (Vector3[] v, int[] t)> meshTops = new Dictionary<Part, (Vector3[], int[])>();

        /// <summary>Recipe facilities (CityRenderer.Facilities.cs): the main roof's centre, top (with its team band) and the emblem size.</summary>
        static readonly Dictionary<string, RoofSpot> RecipeRoofs = new Dictionary<string, RoofSpot>
        {
            ["airfield"] = new RoofSpot { X = -.31f, Z = -.29f, Y = .307f, Size = .25f },          // the first hangar
            ["heavy_weapons"] = new RoofSpot { X = -.12f, Z = -.18f, Y = .432f, Size = .28f },
            ["defense_works"] = new RoofSpot { X = -.22f, Z = -.24f, Y = .292f, Size = .27f },
            ["advanced_lab"] = new RoofSpot { X = -.22f, Z = -.10f, Y = .518f, Size = .24f },      // the institute, in front of its dish mast
            ["missile_silo"] = new RoofSpot { X = .39f, Z = .17f, Y = .192f, Size = .19f },        // the control block
        };

        static readonly Dictionary<Part, string> BaseModelNames = new Dictionary<Part, string>
        {
            [Part.BaseTown] = "Base_town", [Part.BaseBarracks] = "Base_barracks", [Part.BaseDepot] = "Base_depot",
            [Part.BaseMotorWorks] = "Base_motor_works", [Part.BasePower] = "Base_power_plant",
        };

        /// <summary>
        /// An authored model's positions and triangles for roof sampling. The runtime meshes are uploaded without a CPU
        /// copy (ModelLibrary), so the SEM1 file is read again here, positions and indices only, once per type.
        /// </summary>
        static (Vector3[] v, int[] t) MeshTopData(Part part)
        {
            if (meshTops.TryGetValue(part, out var data)) return data;
            data = BaseModelNames.TryGetValue(part, out var name) ? MeshTopData(name) : (null, null);
            meshTops[part] = data;
            return data;
        }

        static readonly Dictionary<string, (Vector3[] v, int[] t)> meshTopsByName = new Dictionary<string, (Vector3[], int[])>();

        /// <summary>A model's positions and triangles by name (base models and the staged Bld_* stages), cached.</summary>
        static (Vector3[] v, int[] t) MeshTopData(string name)
        {
            if (meshTopsByName.TryGetValue(name, out var data)) return data;
            data = (null, null);
            {
                var asset = Resources.Load<TextAsset>("Models/" + name);
                if (asset != null)
                {
                    var bytes = asset.bytes;
                    if (bytes.Length >= 12 && bytes[0] == 'S' && bytes[1] == 'E' && bytes[2] == 'M' && bytes[3] == '1')
                    {
                        int v = System.BitConverter.ToInt32(bytes, 4), n = System.BitConverter.ToInt32(bytes, 8);
                        if (v > 0 && n > 0 && bytes.Length == 12 + v * 40 + n * 4)
                        {
                            var positions = new Vector3[v];
                            for (int i = 0, o = 12; i < v; i++, o += 12)
                                positions[i] = new Vector3(System.BitConverter.ToSingle(bytes, o), System.BitConverter.ToSingle(bytes, o + 4), System.BitConverter.ToSingle(bytes, o + 8));
                            var index = new int[n];
                            bool ok = true;
                            for (int i = 0, o = 12 + v * 40; i < n; i++, o += 4) { index[i] = System.BitConverter.ToInt32(bytes, o); ok &= (uint)index[i] < (uint)v; }
                            if (ok) data = (positions, index);
                        }
                    }
                    Resources.UnloadAsset(asset);
                }
            }
            meshTopsByName[name] = data;
            return data;
        }

        /// <summary>
        /// The top of an authored model at (lx, lz) in the recipe frame (layout x is mirrored: lx = -model X), or -1
        /// where nothing covers that point.
        /// </summary>
        static float MeshTop(Vector3[] v, int[] tri, float lx, float lz)
        {
            float px = -lx, pz = lz, best = -1f;
            for (int i = 0; i + 2 < tri.Length; i += 3)
            {
                var a = v[tri[i]]; var b = v[tri[i + 1]]; var c = v[tri[i + 2]];
                if (px < Mathf.Min(a.x, Mathf.Min(b.x, c.x)) || px > Mathf.Max(a.x, Mathf.Max(b.x, c.x))
                    || pz < Mathf.Min(a.z, Mathf.Min(b.z, c.z)) || pz > Mathf.Max(a.z, Mathf.Max(b.z, c.z))) continue;
                float d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
                if (Mathf.Abs(d) < 1e-9f) continue;
                float l1 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / d;
                float l2 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / d;
                float l3 = 1 - l1 - l2;
                if (l1 < -1e-4f || l2 < -1e-4f || l3 < -1e-4f) continue;
                float y = l1 * a.y + l2 * b.y + l3 * c.y;
                if (y > best) best = y;
            }
            return best;
        }

        /// <summary>
        /// Where a facility's roof emblem goes (recipe frame): for an authored model, the broadest high part of its
        /// roof, searched once per type: the plate's nine sample points must all stand on roof, and a flat, high
        /// spot beats one straddling a chimney or a ridge. The plate then sits just over the highest sample.
        /// </summary>
        static bool RoofSpotOf(string type, out RoofSpot spot)
        {
            if (roofSpots.TryGetValue(type, out spot)) return spot.Size > 0;
            spot = default;
            if (BaseParts.TryGetValue(type, out var part))
            {
                var (v, t) = MeshTopData(part);
                if (v != null)
                {
                    const float Size = .27f, Half = Size * .5f;
                    float bestScore = float.NegativeInfinity;
                    for (float lz = -.40f; lz <= .20f; lz += .05f)
                        for (float lx = -.35f; lx <= .35f; lx += .05f)
                        {
                            float lo = float.MaxValue, hi = 0;
                            for (int sx = -1; sx <= 1; sx++)
                                for (int sz = -1; sz <= 1; sz++)
                                {
                                    float y = MeshTop(v, t, lx + sx * Half, lz + sz * Half);
                                    lo = Mathf.Min(lo, y); hi = Mathf.Max(hi, y);
                                }
                            if (lo < .12f) continue;
                            float score = lo - .8f * (hi - lo) - .05f * Mathf.Abs(lx);
                            if (score > bestScore) { bestScore = score; spot = new RoofSpot { X = lx, Z = lz, Y = hi + .004f, Size = Size }; }
                        }
                }
            }
            else if (RecipeRoofs.TryGetValue(type, out var recipe)) spot = recipe;
            roofSpots[type] = spot;
            return spot.Size > 0;
        }

        /// <summary>The roof top at (lx, lz) of a base facility (recipe frame), for damage marks; false when unknown.</summary>
        static bool RoofTopAt(string type, float lx, float lz, out float y, int stage = -1, int tier = 1)
        {
            y = 0;
            if (stage >= 0 && StagedKey(type, tier) is string key)
            {
                // the staged model's actual roof at this stage: char lands on what is left of it
                string stageName = "Bld_" + key + "_s" + Mathf.Clamp(stage, 0, 2);
                var (sv, st) = MeshTopData(stageName + "_lo");      // the LOD where there is one: same roofs, fewer triangles to scan
                if (sv == null) (sv, st) = MeshTopData(stageName);
                if (sv == null) return false;
                y = MeshTop(sv, st, lx, lz);
                return y > .1f;
            }
            if (BaseParts.TryGetValue(type, out var part))
            {
                var (v, t) = MeshTopData(part);
                if (v == null) return false;
                y = MeshTop(v, t, lx, lz);
                return y > .1f;
            }
            if (RecipeRoofs.TryGetValue(type, out var r) && math.abs(lx - r.X) < r.Size * .6f && math.abs(lz - r.Z) < r.Size * .6f)
            { y = r.Y; return true; }
            return false;
        }

        // ------------------------------------------------------------------ the identity
        /// <summary>Accent, roof emblem and landmark of a positioned base facility (called from ComposeBuilding).</summary>
        void FacilityIdentity(in Ctx c, string type, bool memory)
        {
            if (!FacilityAccent(type, out var accent)) return;
            float glow = memory ? 0f : 1f;
            // a staged model carries its landmark (cooling towers, silos, gantry, radome...) and its roof emblem, modelled on
            // its own roof, turned with the building and kept through the damage stages (tools/blender/build_buildings.py)
            if (StagedKey(type, 1) != null) return;
            FacilityLandmark(c, type, accent, glow);
            if (RoofSpotOf(type, out var spot)) RoofEmblem(c, spot, type, accent, glow);
        }

        /// <summary>
        /// The roof emblem: a dark rim, an accent plate and the type's white sign, flat on the roof. The sign is laid
        /// out in screen terms (x right, y up, plate units ±.5) and turned to map -z = up, so it reads upright from the
        /// default camera whichever way the building faces.
        /// </summary>
        void RoofEmblem(in Ctx c, in RoofSpot spot, string type, float3 accent, float glow)
        {
            math.sincos(c.Yaw, out float sn, out float cs);
            var centre = new float2(c.X + spot.X * cs + spot.Z * sn, c.Z - spot.X * sn + spot.Z * cs);
            float y = c.GroundY + spot.Y, s = spot.Size;
            Put(Part.Box, new float3(centre.x, y, centre.y), 0, new float3(s + .036f, .012f, s + .036f), PaintDark * c.Tint);
            Put(Part.Box, new float3(centre.x, y + .004f, centre.y), 0, new float3(s, .012f, s), accent * c.Tint, .55f * glow);
            float top = y + .016f;
            var ink = new float3(.98f, .97f, .93f) * c.Tint;
            var right = new float2(1, 0); var up = new float2(0, -1);
            void Bar(float ox, float oy, float angle, float w, float h)
            {
                var p = centre + (right * ox + up * oy) * s;
                math.sincos(angle, out float a, out float b);
                var dir = up * b + right * a;
                Put(Part.Box, new float3(p.x, top, p.y), math.atan2(dir.x, dir.y), new float3(w * s, .005f, h * s), ink, .35f * glow);
            }
            const float T = .13f, Diag = .785f, Across = 1.5708f;
            switch (type)
            {
                case "barracks": case "camp":                        // crossed rifles
                    Bar(0, 0, Diag, T, .8f); Bar(0, 0, -Diag, T, .8f); break;
                case "motor_works":                                  // a track: two runs and the end wheels
                    Bar(0, .18f, Across, T, .66f); Bar(0, -.18f, Across, T, .66f);
                    Bar(-.3f, 0, 0, T, .48f); Bar(.3f, 0, 0, T, .48f); break;
                case "heavy_weapons": case "heavy_assembly":          // a shell on a gun barrel
                    Bar(0, .1f, Diag, .26f, .26f); Bar(0, -.2f, Across, T, .62f); break;
                case "airfield":                                     // an aircraft in plan
                    Bar(0, 0, 0, T, .76f); Bar(0, .08f, Across, T, .78f); Bar(0, -.28f, Across, T, .34f); break;
                case "power_plant":                                  // a lightning bolt
                    Bar(.08f, .17f, -.5f, T, .38f); Bar(0, 0, 1.2f, T, .32f); Bar(-.08f, -.17f, -.5f, T, .38f); break;
                case "depot":                                        // a crate
                    Bar(0, .25f, Across, T, .62f); Bar(0, -.25f, Across, T, .62f);
                    Bar(-.25f, 0, 0, T, .62f); Bar(.25f, 0, 0, T, .62f); Bar(0, 0, Diag, T * .8f, .66f); break;
                case "advanced_lab":                                 // an orbit (octagon) round a core
                    for (int k = 0; k < 8; k++)
                    {
                        float a = k * math.PI / 4;
                        Bar(math.sin(a) * .29f, math.cos(a) * .29f, a + math.PI * .5f, T * .9f, .25f);
                    }
                    Bar(0, 0, Diag, .15f, .15f); break;
                case "missile_silo":                                 // an arrow up
                    Bar(0, -.08f, 0, T, .62f); Bar(-.1f, .14f, -Diag, T, .34f); Bar(.1f, .14f, Diag, T, .34f); break;
                case "defense_works":                                // battlements
                    Bar(0, -.15f, Across, .16f, .66f);
                    for (int k = -1; k <= 1; k++) Bar(k * .24f, .06f, 0, .14f, .2f);
                    break;
            }
        }

        /// <summary>The per-type landmark silhouette, in the building's own frame (+lz: the front, facing the HQ).</summary>
        void FacilityLandmark(in Ctx c, string type, float3 accent, float glow)
        {
            var concrete = new float3(.72f, .71f, .66f);
            var center = new float2(c.X, c.Z);
            switch (type)
            {
                case "barracks":
                    // a tall flag pole on the parade ground at the front corner, an accent collar at its foot
                    Flag(c, -.40f, .36f, .78f);
                    Sig(c, Part.Cylinder, -.40f, .36f, 0, new float3(.07f, .03f, .07f), accent, 0, .4f * glow);
                    break;
                case "depot":
                {
                    // the processor: two tall ore silos on the left with accent bands, a conveyor gantry onto the hall roof
                    for (int k = 0; k < 2; k++)
                    {
                        float z = -.16f - k * .2f;
                        Sig(c, Part.Silo, -.40f, z, 0, new float3(.17f, .42f, .17f), new float3(.70f, .71f, .68f));
                        Sig(c, Part.Cylinder, -.40f, z, .30f, new float3(.177f, .035f, .177f), accent, 0, .35f * glow);
                    }
                    for (int s = -1; s <= 1; s += 2) Sig(c, Part.Box, -.27f, -.26f + s * .035f, 0, new float3(.012f, .40f, .012f), SteelGrey);
                    Sig(c, Part.Box, -.25f, -.26f, .40f, new float3(.26f, .035f, .06f), new float3(.40f, .42f, .40f));
                    Sig(c, Part.Box, -.25f, -.26f, .435f, new float3(.26f, .008f, .045f), accent, 0, .3f * glow);
                    break;
                }
                case "power_plant":
                {
                    // two cooling towers at the front left, open at the top and breathing steam
                    for (int k = 0; k < 2; k++)
                    {
                        float lx = -.36f, lz = k == 0 ? .25f : -.04f, size = k == 0 ? .30f : .25f, h = k == 0 ? .52f : .44f;
                        Sig(c, Part.Chimney, lx, lz, 0, new float3(size, h, size), concrete);
                        Sig(c, Part.Cylinder, lx, lz, h * .74f, new float3(size * .80f, .035f, size * .80f), accent, 0, .35f * glow);
                        Sig(c, Part.Cylinder, lx, lz, h - .004f, new float3(size * .62f, .008f, size * .62f), PaintDark);
                        Stack(c, lx, lz, h + .02f, true, k == 0 ? .5f : .4f);
                    }
                    break;
                }
                case "motor_works":
                {
                    // accent frames over the bay doors, and a vehicle pad with exit chevrons in front of the hall
                    Sig(c, Part.Box, .10f, .12f, .21f, new float3(.66f, .04f, .02f), accent, 0, .4f * glow);
                    for (int k = 0; k < 4; k++) Sig(c, Part.Box, -.21f + k * .205f, .125f, 0, new float3(.022f, .22f, .022f), Hazard);
                    var pad = LocalToMap(center, c.Yaw, .20f, .30f);
                    GroundRect(pad, c.Yaw, 0, 0, .40f, .22f, -.0016f, new float3(.46f, .47f, .46f) * c.Tint, SurfaceKind.Concrete);
                    GroundRoundOutline(pad, c.Yaw, .40f, .22f, .03f, .018f, -.0010f, accent * c.Tint, SurfaceKind.Plain);
                    for (int k = 0; k < 2; k++)
                        for (int s = -1; s <= 1; s += 2)
                            GroundRect(LocalToMap(center, c.Yaw, .20f + s * .028f, .27f + k * .08f), c.Yaw - s * .8f, 0, 0, .016f, .085f, -.0009f, accent * c.Tint, SurfaceKind.Plain);
                    break;
                }
                case "heavy_weapons":
                {
                    // a tower crane over the hall's rear corner: the tallest thing in the base after the HQ
                    float x = -.43f, z = -.44f;
                    Sig(c, Part.Concrete, x, z, 0, new float3(.10f, .03f, .10f), concrete);
                    Sig(c, Part.Box, x, z, .03f, new float3(.04f, .68f, .04f), accent * .9f);
                    Sig(c, Part.Box, x + .17f, z, .70f, new float3(.50f, .035f, .035f), accent * .9f);          // jib, over the hall
                    Sig(c, Part.Box, x - .13f, z, .70f, new float3(.14f, .035f, .035f), accent * .9f);          // counter-jib
                    Sig(c, Part.Box, x - .17f, z, .655f, new float3(.06f, .05f, .05f), concrete * .8f);         // counterweight
                    Sig(c, Part.Box, x, z, .735f, new float3(.05f, .05f, .05f), accent, 0, .9f * glow);         // cab light
                    Sig(c, Part.Box, x + .33f, z, .48f, new float3(.004f, .22f, .004f), SteelGrey);             // hoist line
                    Sig(c, Part.Box, x + .33f, z, .46f, new float3(.05f, .025f, .05f), Hazard);                 // hook block
                    break;
                }
                case "airfield":
                {
                    // threshold bars at both runway ends, accent edge lights and a parked jet on the apron
                    for (int end = -1; end <= 1; end += 2)
                        for (int k = 0; k < 4; k++)
                            Sig(c, Part.Box, .11f + end * .46f, .19f + (k - 1.5f) * .045f, .002f, new float3(.07f, .004f, .026f), new float3(.95f, .95f, .92f), 0, .15f * glow);
                    for (int k = 0; k < 6; k++)
                        for (int s = -1; s <= 1; s += 2)
                            Sig(c, Part.Box, -.36f + k * .19f, .19f + s * .125f, .002f, new float3(.018f, .014f, .018f), accent, 0, .9f * glow);
                    var hull = new float3(.66f, .68f, .70f);
                    Sig(c, Part.Box, .20f, -.03f, .02f, new float3(.26f, .035f, .04f), hull);                      // fuselage along x
                    Sig(c, Part.Box, .17f, -.03f, .03f, new float3(.07f, .012f, .26f), hull * .95f);               // wings
                    Sig(c, Part.Box, .31f, -.03f, .03f, new float3(.04f, .01f, .11f), hull * .95f);                // tailplane
                    Sig(c, Part.Box, .315f, -.03f, .045f, new float3(.04f, .055f, .01f), accent, 0, .3f * glow);   // fin in the accent
                    Sig(c, Part.Box, .08f, -.03f, .045f, new float3(.04f, .015f, .03f), new float3(.25f, .35f, .40f));   // canopy
                    break;
                }
                case "advanced_lab":
                    // a radome on a drum at the front corner, an accent ring at its waist
                    Sig(c, Part.Cylinder, .30f, .30f, 0, new float3(.20f, .09f, .20f), concrete * .95f);
                    Sig(c, Part.Cylinder, .30f, .30f, .085f, new float3(.215f, .03f, .215f), accent, 0, .55f * glow);
                    Sig(c, Part.Dome, .30f, .30f, .10f, new float3(.22f, .22f, .22f), new float3(.90f, .91f, .90f));
                    break;
                case "missile_silo":
                {
                    // a missile standing on its erector beside the control block, with a service tower
                    float x = .42f, z = -.34f;
                    Sig(c, Part.Concrete, x, z, 0, new float3(.16f, .03f, .16f), concrete);
                    Sig(c, Part.Box, x + .07f, z, .03f, new float3(.035f, .60f, .035f), SteelGrey);
                    for (int k = 0; k < 4; k++) Sig(c, Part.Box, x + .045f, z, .12f + k * .14f, new float3(.05f, .01f, .01f), SteelGrey);
                    Sig(c, Part.Cylinder, x, z, .03f, new float3(.065f, .46f, .065f), new float3(.92f, .92f, .90f));
                    Sig(c, Part.Cylinder, x, z, .33f, new float3(.069f, .05f, .069f), accent, 0, .5f * glow);
                    Sig(c, Part.Cone, x, z, .49f, new float3(.065f, .11f, .065f), new float3(.92f, .92f, .90f));
                    for (int k = 0; k < 4; k++)
                        Sig(c, Part.Box, x, z, .03f, new float3(.012f, .07f, .11f), accent * .85f, k * math.PI * .25f);
                    break;
                }
            }
        }
    }
}
