using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Makes the server's regional weather legible (docs/gameplay-overhaul/WEATHER_VISUALS.md): the weather texture
    /// every world shader darkens under (<see cref="WeatherField"/>), the cloud masses, rain curtains and lightning
    /// over each weather cell (<see cref="StormClouds"/>), a storm layer for the minimap, the storm ambience and
    /// directional thunder (through <see cref="Strike"/>), and notices when a storm nears or covers one of our air
    /// bases (aircraft cannot take off or land there: server actionAir.js AIR_WEATHER). Purely presentation.
    /// Storm systems (rare squall lines and hurricanes, server weather.js) are drawn by the cloud deck
    /// (<see cref="StormSky"/>) from their parameters (<see cref="StormSystems"/>); this class also marks them and
    /// their forecast track on the minimap, describes them on the hover card, adds their wind to the effects, and
    /// lets them be heard coming (rising storm wind, distant thunder).
    /// </summary>
    public sealed class WeatherPresenter : IDisposable
    {
        public readonly WeatherField Field = new WeatherField();
        public readonly StormClouds Clouds = new StormClouds();
        public readonly StormSystems Systems = new StormSystems();
        public readonly StormSky Sky = new StormSky();

        /// <summary>A lightning strike: map position, thunder delay (s), loudness 0..1.</summary>
        public event Action<float3, float, float> Strike { add => Clouds.Strike += value; remove => Clouds.Strike -= value; }
        /// <summary>A notice for the player: text, level ("major" / "info"), tile.</summary>
        public event Action<string, string, int> Notice;

        /// <summary>Minimap storm layer: one texel per weather cell (rows bottom-up, north at the top), refreshed twice a second.</summary>
        public Texture2D MinimapTexture => minimapTex;
        /// <summary>Changes each time the minimap layer is rewritten.</summary>
        public int MinimapRevision { get; private set; }
        Texture2D minimapTex;
        Color32[] minimapPx = Array.Empty<Color32>();
        float minimapAt, watchAt;
        int mapW;

        /// <summary>Strongest storm within earshot (0..1): the storm cells near the focus, or a storm system closing in.</summary>
        public float StormNear => Mathf.Max(Clouds.StormNear, approach);
        /// <summary>The storm systems' wind at the camera focus (map x/z, world units per second): add to the effects' wind.</summary>
        public float3 SystemWind { get; private set; }
        float approach, rumbleAt;
        readonly System.Random rumbleRng = new System.Random(4021);
        WorldModel world;
        public float ViewFlash => Clouds.ViewFlash;

        public void Update(WorldModel world, WeatherState wx, int wxRevision, float3 focusMap, Vector3 eye, float camDistance, float time, float dt, float simRate, float intensity)
        {
            this.world = world;
            if (world == null || !world.Ready)
            {
                Field.Update(null, wxRevision, 1, 1, 1, 1, time, intensity); Systems.Update(Field, false, intensity);
                Clouds.Update(null, focusMap, eye, camDistance, false, time, dt, simRate, intensity, null); Sky.Update(null, Systems, focusMap, eye, camDistance, false, intensity);
                approach = 0; SystemWind = float3.zero; return;
            }
            var g = world.Grid;
            mapW = g.W;
            Field.Update(wx, wxRevision, g.W, g.H, g.Period, g.Depth, time, intensity);
            Systems.Update(Field, g.Wrap, intensity);
            Clouds.Update(Field, focusMap, eye, camDistance, g.Wrap, time, dt, simRate, intensity, world.GroundHeight);
            Sky.Update(Field, Systems, focusMap, eye, camDistance, g.Wrap, intensity);
            Hear(focusMap, camDistance, time, simRate);
            var w = Systems.Wind(focusMap.x, focusMap.z);
            SystemWind = new float3(w.x, 0, w.y) * .5f;
            if (time >= minimapAt) { minimapAt = time + .5f; Minimap(); }
        }

        public void Draw() { Clouds.Draw(); Sky.Draw(); }

        // ------------------------------------------------------------------ hearing a system coming
        void Hear(float3 focus, float camDistance, float time, float simRate)
        {
            approach = 0;
            float hear = Mathf.Max(90f, camDistance * 1.5f);
            int loudest = -1; float best = 0, bestD = 0;
            for (int i = 0; i < Systems.Count; i++)
            {
                var s = Systems[i];
                float d = Systems.EdgeDistance(i, focus.x, focus.z);
                // its wind rises as the edge nears and fills in underneath it
                float a = s.Intensity * Mathf.Clamp01(1f - d / hear) * (d < 0 ? 1f : .7f);
                if (a > approach) approach = a;
                float far = s.Intensity * (1 - d / (hear * 2.2f));
                if (d > 0 && d < hear * 2.2f && far > best) { best = far; loudest = i; bestD = d; }
            }
            // distant thunder from a system still beyond the strike range: low and late, every few seconds
            if (loudest < 0 || simRate <= 0 || time < rumbleAt) return;
            rumbleAt = time + 3.5f + (float)rumbleRng.NextDouble() * 7f / Mathf.Max(.3f, best);
            var sy = Systems[loudest];
            float dx = Field.Period > 0 ? Mathf.Repeat(sy.X - focus.x + Field.Period * .5f, Field.Period) - Field.Period * .5f : sy.X - focus.x;
            float dz = sy.Z - focus.z, len = Mathf.Max(1e-3f, Mathf.Sqrt(dx * dx + dz * dz));
            float along = Mathf.Min(len, Mathf.Max(0, bestD) + 20f);
            var at = new float3(focus.x + dx / len * along, focus.y + 8f, focus.z + dz / len * along);
            if (sy.Intensity > .35f) Clouds.Rumble(at, Mathf.Clamp(bestD / 30f, 1.5f, 7f), Mathf.Clamp01(best * .55f));
        }

        // ------------------------------------------------------------------ hover
        /// <summary>
        /// The storm system over a hex, for the hover card: {name, kind line, effects, track} or null. Within the
        /// system's cloud (not only where aircraft are grounded), so it can be inspected as it approaches.
        /// </summary>
        public string[] SystemInfo(int tile)
        {
            if (tile < 0 || world == null || !world.Ready || Systems.Count == 0) return null;
            var g = world.Grid;
            float x = g.CenterX(tile), z = g.CenterZ(tile);
            int i = Systems.Over(x, z, .25f);
            if (i < 0) return null;
            var s = Systems[i];
            float storm = StormAtTile(tile);
            var here = Systems.Sample(x, z);
            float hexPerMin = s.Speed / 1.7320508f * 60f;
            string name = s.Hurricane ? $"Hurricane {s.Name}" : "Squall line";
            string kind = s.Hurricane ? $"Weather · category {StormSystems.Category(s.Intensity)}" : s.Intensity > .6f ? "Weather · severe" : "Weather";
            string effect = storm >= .5f ? "Aircraft cannot take off or land here; troops see one hex less"
                : s.Hurricane && here.y < .05f && here.x < .1f ? "The eye: calm for now, the eyewall follows"
                : "Rain slows off-road movement; the core grounds aircraft";
            float left = Systems.Remaining(i);
            string track = $"Moving {StormSystems.Compass(s.Heading)} at {hexPerMin:0} hexes a minute · {(left > 150 ? "holding strength" : "weakening")}";
            return new[] { name, kind, effect, track };
        }

        // ------------------------------------------------------------------ minimap
        // the storm layer at three texels per weather cell: sharp enough for a system's outline and its track
        const int MiniRes = 3;

        void Minimap()
        {
            if (!Field.Active) return;
            int cw = Field.CellsW * MiniRes, ch = Field.CellsH * MiniRes, n = cw * ch;
            if (minimapTex == null || minimapTex.width != cw || minimapTex.height != ch)
            {
                if (minimapTex != null) UnityEngine.Object.Destroy(minimapTex);
                minimapTex = new Texture2D(cw, ch, TextureFormat.RGBA32, false) { name = "SE minimap weather", filterMode = FilterMode.Bilinear, wrapModeU = TextureWrapMode.Repeat, wrapModeV = TextureWrapMode.Clamp };
                minimapPx = new Color32[n];
            }
            float cellX = Field.CellWorldX, cellZ = Field.CellWorldZ;
            for (int cy = 0; cy < ch; cy++)
                for (int cx = 0; cx < cw; cx++)
                {
                    float gx = (cx + .5f) / MiniRes, gy = (cy + .5f) / MiniRes;
                    float cloud = Field.SampleCells(WeatherField.Channel.Cloud, gx, gy), rain = Field.SampleCells(WeatherField.Channel.Rain, gx, gy),
                        storm = Field.SampleCells(WeatherField.Channel.Storm, gx, gy);
                    if (Systems.Count > 0)
                    {
                        var sys = Systems.Sample(gx * cellX, gy * cellZ);
                        cloud = Mathf.Max(cloud, sys.x); storm = Mathf.Max(storm, sys.y); rain = Mathf.Max(rain, sys.z);
                    }
                    // thick cloud a pale veil, rain blue, storms a dark violet that reads over any terrain
                    float c = Mathf.Clamp01((cloud - .5f) * 1.6f) * .28f, r = Mathf.Clamp01((rain - .3f) * 1.6f) * .42f, s = Mathf.Clamp01((storm - .2f) * 1.5f) * .82f;
                    var col = Color.Lerp(new Color(.86f, .88f, .92f), new Color(.34f, .52f, .86f), r / Mathf.Max(.001f, c + r));
                    col = Color.Lerp(col, new Color(.22f, .14f, .40f), s / Mathf.Max(.001f, Mathf.Max(c, r) + s));
                    col.a = Mathf.Clamp01(Mathf.Max(Mathf.Max(c, r), s));
                    minimapPx[(ch - 1 - cy) * cw + cx] = col;
                }
            // the systems themselves (silhouette, symbol, forecast track) are drawn as vectors by Minimap.DrawStorms
            minimapTex.SetPixels32(minimapPx);
            minimapTex.Apply(false, false);
            MinimapRevision++;
        }

        // ------------------------------------------------------------------ hover
        /// <summary>The storm value the server's air rules use at a hex (0..1; aircraft are grounded at .5 and above).</summary>
        public float StormAtTile(int tile) => tile < 0 ? 0f : Field.StormCell(tile);

        // ------------------------------------------------------------------ air bases under storms
        readonly Dictionary<int, int> baseState = new Dictionary<int, int>();       // 0 clear, 1 approaching, 2 covered
        readonly Dictionary<int, float> approachNoted = new Dictionary<int, float>();
        readonly List<int> baseGone = new List<int>();
        readonly HashSet<int> baseSeen = new HashSet<int>();

        static bool Aircraft(string type) => type == "fighter" || type == "bomber" || type == "helicopter" || type == "recon_drone" || type == "oneway_drone" || type == "strike_swarm";

        /// <summary>Once a second: notices when a storm approaches or covers one of our airfields (or, while we have
        /// aircraft, a headquarters or drone lab they refuel at).</summary>
        public void WatchBases(StructureStore structures, SE.Core.Units.UnitStore units, int civ, float time)
        {
            if (time < watchAt || structures == null || civ < 0) return;
            watchAt = time + 1f;
            if (!Field.Active) return;
            bool flyers = false;
            if (units != null)
                for (int s = 0; s < units.SlotCount && !flyers; s++)
                {
                    ref var u = ref units.Records[s];
                    if (u.InUse && u.Owner == civ && Aircraft(units.Types.Name(u.TypeIndex))) flyers = true;
                }
            baseSeen.Clear();
            int notes = 0;
            foreach (var b in structures.Buildings.Values)
            {
                if (b.Owner != civ || !b.Done || b.Memory || b.Tile < 0) continue;
                bool airfield = b.Type == "airfield";
                if (!airfield && !(flyers && (b.Type == "town" || b.Type == "advanced_lab"))) continue;
                baseSeen.Add(b.Id);
                float now = Field.StormCell(b.Tile);
                float soon = Mathf.Max(Field.StormUpwind(b.Tile, 2f), Field.StormUpwind(b.Tile, 5f));
                baseState.TryGetValue(b.Id, out int was);
                // hysteresis: a base stays "covered" until the storm has thinned and nothing more is blowing in
                int state = now >= .5f ? 2 : was == 2 && (now >= .4f || soon >= .5f) ? 2 : soon >= .5f ? 1 : 0;
                if (state == was) continue;
                baseState[b.Id] = state;
                if (notes >= 3) continue;
                string what = airfield ? "airfield" : b.Type == "town" ? "headquarters" : "drone lab";
                bool recent = approachNoted.TryGetValue(b.Id, out float at) && time - at < 90f;
                if (state == 2)
                {
                    if (recent && was == 0) continue;   // a storm flickering at the threshold says it once
                    approachNoted[b.Id] = time;
                    Notice?.Invoke($"Storm over your {what}: aircraft there cannot take off or land; returning aircraft divert.", "major", b.Tile); notes++;
                }
                else if (state == 1 && was == 0)
                {
                    if (recent) continue;
                    approachNoted[b.Id] = time;
                    Notice?.Invoke($"Storm approaching your {what}: aircraft there will be grounded while it passes.", "major", b.Tile); notes++;
                }
                else if (state == 0 && was == 2) { Notice?.Invoke($"The storm over your {what} has passed: flights resume.", "info", b.Tile); notes++; }
            }
            baseGone.Clear();
            foreach (var id in baseState.Keys) if (!baseSeen.Contains(id)) baseGone.Add(id);
            foreach (var id in baseGone) baseState.Remove(id);
            // notices older than the 90 s hold no longer matter (memory pass 8: never pruned before)
            if (approachNoted.Count > 0)
            {
                baseGone.Clear();
                foreach (var pair in approachNoted) if (time - pair.Value >= 90f || pair.Value > time) baseGone.Add(pair.Key);
                foreach (var id in baseGone) approachNoted.Remove(id);
            }
        }

        public void Dispose()
        {
            Field.Dispose(); Clouds.Dispose(); Sky.Dispose();
            if (minimapTex != null) UnityEngine.Object.Destroy(minimapTex);
        }
    }
}
