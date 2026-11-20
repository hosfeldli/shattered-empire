using System;
using SE.Core.Protocol;
using UnityEngine;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// The server's storm systems (weather.js: rare squall lines and hurricanes) as the client shows them: each is
    /// a handful of parameters, eased between the previous and the latest weather snapshot exactly like the weather
    /// texture (<see cref="WeatherField.Blend"/>), so the analytic clouds, the texture-driven rain and the ground
    /// shade stay together. Publishes them to every shader (SECommon _SE_WxSys), and mirrors the server's field
    /// (systemProfile), wind and track (systemTrackAt) on the CPU for the minimap, the hover card and the audio.
    /// Map coordinates throughout (x east, z south, world units), except the shader vectors (Unity world).
    /// </summary>
    public sealed class StormSystems
    {
        public const int Max = 4;
        const float Step = 5f;   // server weather step (s)
        static readonly int SysId = Shader.PropertyToID("_SE_WxSys"), SysNId = Shader.PropertyToID("_SE_WxSysN");

        public struct Shown
        {
            public int Id, Kind, Spin;
            public float X, Z, Heading, Speed, Turn, Radius, Intensity, Age, Life;
            public string Name;
            public bool Hurricane => Kind == 1;
        }

        readonly Shown[] shown = new Shown[Max];
        readonly Vector4[] gpu = new Vector4[Max * 2];
        public int Count { get; private set; }
        public Shown this[int i] => shown[i];
        float period = 1, depth = 1;
        bool wrap;

        public void Update(WeatherField field, bool mapWraps, float intensity)
        {
            Count = 0;
            period = field.Period; depth = field.Depth; wrap = mapWraps;
            var next = field.Active ? field.Latest?.Systems : null;
            var prev = field.Active ? field.Previous?.Systems : null;
            float f = field.Blend;
            if (next != null)
                foreach (var n in next)
                {
                    if (Count >= Max) break;
                    var s = From(n);
                    int k = Find(prev, n.Id);
                    if (k >= 0)
                    {
                        var p = prev[k];
                        float dx = n.X - p.X;
                        dx -= period * Mathf.Round(dx / period);
                        s.X = p.X + dx * f; s.Z = p.Z + (n.Z - p.Z) * f;
                        s.Heading = p.Heading + Mathf.DeltaAngle(p.Heading * Mathf.Rad2Deg, n.Heading * Mathf.Rad2Deg) * Mathf.Deg2Rad * f;
                        s.Intensity = Mathf.Lerp(p.Intensity, n.Intensity, f);
                        s.Radius = Mathf.Lerp(p.Radius, n.Radius, f);
                        s.Age = Mathf.Lerp(p.Age, n.Age, f);
                    }
                    else
                    {
                        // just born: slide in from where it was a step ago, fading up
                        s.X -= Mathf.Cos(n.Heading) * n.Speed * Step * (1 - f); s.Z -= Mathf.Sin(n.Heading) * n.Speed * Step * (1 - f);
                        s.Intensity *= f;
                    }
                    shown[Count++] = s;
                }
            if (prev != null)
                foreach (var p in prev)
                {
                    // gone (died or left the map): carry it on along its track, fading out, instead of popping
                    if (Count >= Max || Find(next, p.Id) >= 0) continue;
                    var s = From(p);
                    s.X += Mathf.Cos(p.Heading) * p.Speed * Step * f; s.Z += Mathf.Sin(p.Heading) * p.Speed * Step * f;
                    s.Intensity *= 1 - f;
                    shown[Count++] = s;
                }
            float vis = Mathf.Clamp01(intensity);
            for (int i = 0; i < Max; i++)
            {
                if (i < Count)
                {
                    var s = shown[i];
                    gpu[2 * i] = new Vector4(s.X, -s.Z, s.Radius, s.Intensity);
                    gpu[2 * i + 1] = new Vector4(s.Kind, s.Spin, -s.Heading, (s.Id * 2.399963f) % 6.2831853f);
                }
                else { gpu[2 * i] = Vector4.zero; gpu[2 * i + 1] = Vector4.zero; }
            }
            Shader.SetGlobalVectorArray(SysId, gpu);
            Shader.SetGlobalVector(SysNId, new Vector4(vis > .001f ? Count : 0, mapWraps ? 1 : 0, period, 0));
        }

        static int Find(StormSystemRecord[] list, int id)
        {
            if (list == null) return -1;
            for (int i = 0; i < list.Length; i++) if (list[i].Id == id) return i;
            return -1;
        }

        static Shown From(in StormSystemRecord r) => new Shown
        {
            Id = r.Id, Kind = r.Kind, Spin = r.Spin, X = r.X, Z = r.Z, Heading = r.Heading, Speed = r.Speed, Turn = r.Turn,
            Radius = r.Radius, Intensity = r.Intensity, Age = r.Age, Life = r.Life, Name = r.Name,
        };

        float Dx(float from, float to)
        {
            float d = to - from;
            if (wrap && period > 0) d -= period * Mathf.Round(d / period);
            return d;
        }

        // ------------------------------------------------------------------ the server's field (weather.js systemProfile)
        static float Smooth(float a, float b, float x) { float t = Mathf.Clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

        /// <summary>(cloud, storm, rain) of one system at an offset (map x east, z south) from its centre.</summary>
        public static Vector3 Profile(in Shown sy, float dx, float dz)
        {
            float R = sy.Radius, s = sy.Intensity;
            if (s <= 0 || R <= 0) return Vector3.zero;
            if (sy.Kind == 1)
            {
                float r = Mathf.Sqrt(dx * dx + dz * dz), k = r / R;
                if (k > 1.1f) return Vector3.zero;
                float rm = .2f * R, eye = Smooth(.3f * rm, .55f * rm, r);
                float q = (r - rm) / (.42f * rm), wall = Mathf.Exp(-q * q);
                float bands = Smooth(.9f * rm, 1.6f * rm, r) * (1 - Smooth(.55f, 1f, k));
                float shield = 1 - Smooth(.35f, 1.05f, k);
                float grow = Mathf.Clamp01(.35f + s);
                return new Vector3(eye * Mathf.Clamp01(Mathf.Max(wall, .32f * bands + .62f * shield)) * grow, eye * Mathf.Clamp01(wall + .22f * bands) * s,
                    eye * Mathf.Clamp01(wall * .95f + .3f * bands + .2f * shield) * Mathf.Clamp01(s * 1.2f));
            }
            float fx = Mathf.Cos(sy.Heading), fz = Mathf.Sin(sy.Heading);
            float a = (dx * -fz + dz * fx) / R, b = dx * fx + dz * fz;
            if (a > 1.05f || a < -1.05f || b > .3f * R || b < -.95f * R) return Vector3.zero;
            float lat = 1 - Smooth(.62f, 1f, Mathf.Abs(a));
            float e = b - (.2f * R * (1 - a * a) - .08f * R);
            float c1 = (e + .07f * R) / (.075f * R), c2 = (e - .01f * R) / (.035f * R);
            float conv = Mathf.Exp(-c1 * c1), shelf = Mathf.Exp(-c2 * c2);
            float trail = e < 0 ? Mathf.Exp(e / (.45f * R)) * Smooth(.02f * R, -.04f * R, e) : 0;
            return new Vector3(lat * Mathf.Clamp01(conv + shelf * .7f + trail * .72f) * Mathf.Clamp01(.35f + s), lat * conv * s, lat * Mathf.Clamp01(conv * .95f + trail * .75f) * s);
        }

        /// <summary>The strongest (cloud, storm, rain) of all shown systems at a map position.</summary>
        public Vector3 Sample(float mapX, float mapZ)
        {
            var o = Vector3.zero;
            for (int i = 0; i < Count; i++) o = Vector3.Max(o, Profile(shown[i], Dx(shown[i].X, mapX), mapZ - shown[i].Z));
            return o;
        }

        /// <summary>The system covering a map position (its cloud at least <paramref name="minCloud"/>), or -1.</summary>
        public int Over(float mapX, float mapZ, float minCloud = .2f)
        {
            int best = -1; float bc = minCloud;
            for (int i = 0; i < Count; i++)
            {
                float dx = Dx(shown[i].X, mapX), dz = mapZ - shown[i].Z;
                float c = Profile(shown[i], dx, dz).x;
                // a hurricane's clear eye still belongs to it
                if (shown[i].Hurricane && dx * dx + dz * dz < shown[i].Radius * shown[i].Radius * .04f) c = Mathf.Max(c, minCloud);
                if (c >= bc) { bc = c; best = i; }
            }
            return best;
        }

        /// <summary>Distance from a map position to a system's edge (negative inside), world units.</summary>
        public float EdgeDistance(int i, float mapX, float mapZ)
        {
            var s = shown[i];
            float dx = Dx(s.X, mapX), dz = mapZ - s.Z;
            return Mathf.Sqrt(dx * dx + dz * dz) - s.Radius * (s.Hurricane ? .9f : .75f);
        }

        /// <summary>The systems' wind at a map position (world units per second, map x/z): a hurricane's swirl and inflow, a squall's gust front.</summary>
        public Vector2 Wind(float mapX, float mapZ)
        {
            var o = Vector2.zero;
            for (int i = 0; i < Count; i++)
            {
                var s = shown[i];
                float dx = Dx(s.X, mapX), dz = mapZ - s.Z, r = Mathf.Sqrt(dx * dx + dz * dz);
                if (r > s.Radius * 1.3f || r < 1e-3f) continue;
                float env = 1 - Smooth(.7f, 1.3f, r / s.Radius);
                if (s.Hurricane)
                {
                    float rm = .2f * s.Radius, vt = 2.2f * s.Intensity * (r < rm ? r / rm : Mathf.Pow(rm / r, .6f)) * env;
                    float tx = dz / r * s.Spin, tz = -dx / r * s.Spin;
                    o += new Vector2(tx * vt - dx / r * vt * .25f, tz * vt - dz / r * vt * .25f);
                }
                else
                {
                    float g = 1.6f * s.Intensity * Mathf.Min(1f, Profile(s, dx, dz).x * 1.5f);
                    o += new Vector2(Mathf.Cos(s.Heading), Mathf.Sin(s.Heading)) * g;
                }
            }
            return o;
        }

        /// <summary>Where system i will be after <paramref name="seconds"/> (server systemTrackAt: constant speed and turn rate).</summary>
        public Vector2 Track(int i, float seconds)
        {
            var s = shown[i];
            float x = s.X, z = s.Z, h = s.Heading;
            int steps = Mathf.Max(0, Mathf.RoundToInt(seconds / Step));
            for (int k = 0; k < steps; k++) { x += Mathf.Cos(h) * s.Speed * Step; z += Mathf.Sin(h) * s.Speed * Step; h += s.Turn * Step; }
            return new Vector2(x, z);
        }

        /// <summary>Seconds of life left (the system dies away near the end of it).</summary>
        public float Remaining(int i) => Mathf.Max(0, shown[i].Life - shown[i].Age);

        /// <summary>Eight-point compass direction a system is heading (north is -z).</summary>
        public static string Compass(float heading)
        {
            float deg = Mathf.Atan2(Mathf.Cos(heading), -Mathf.Sin(heading)) * Mathf.Rad2Deg;   // bearing: 0 north, 90 east
            int k = Mathf.RoundToInt(Mathf.Repeat(deg, 360f) / 45f) % 8;
            return Dirs[k];
        }
        static readonly string[] Dirs = { "north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west" };

        /// <summary>Saffir–Simpson-like category (1..5) from intensity, for the hover card.</summary>
        public static int Category(float intensity) => Mathf.Clamp(1 + Mathf.FloorToInt(Mathf.Clamp01((intensity - .3f) / .65f) * 4.999f), 1, 5);
    }
}
