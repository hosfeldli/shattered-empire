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
    /// </summary>
    public sealed class WeatherPresenter : IDisposable
    {
        public readonly WeatherField Field = new WeatherField();
        public readonly StormClouds Clouds = new StormClouds();

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

        public float StormNear => Clouds.StormNear;
        public float ViewFlash => Clouds.ViewFlash;

        public void Update(WorldModel world, WeatherState wx, int wxRevision, float3 focusMap, Vector3 eye, float camDistance, float time, float dt, float simRate, float intensity)
        {
            if (world == null || !world.Ready) { Field.Update(null, wxRevision, 1, 1, 1, 1, time, intensity); Clouds.Update(null, focusMap, eye, camDistance, false, time, dt, simRate, intensity, null); return; }
            var g = world.Grid;
            mapW = g.W;
            Field.Update(wx, wxRevision, g.W, g.H, g.Period, g.Depth, time, intensity);
            Clouds.Update(Field, focusMap, eye, camDistance, g.Wrap, time, dt, simRate, intensity, world.GroundHeight);
            if (time >= minimapAt) { minimapAt = time + .5f; Minimap(); }
        }

        public void Draw() => Clouds.Draw();

        // ------------------------------------------------------------------ minimap
        void Minimap()
        {
            if (!Field.Active) return;
            int cw = Field.CellsW, ch = Field.CellsH, n = cw * ch;
            if (minimapTex == null || minimapTex.width != cw || minimapTex.height != ch)
            {
                if (minimapTex != null) UnityEngine.Object.Destroy(minimapTex);
                minimapTex = new Texture2D(cw, ch, TextureFormat.RGBA32, false) { name = "SE minimap weather", filterMode = FilterMode.Bilinear, wrapModeU = TextureWrapMode.Repeat, wrapModeV = TextureWrapMode.Clamp };
                minimapPx = new Color32[n];
            }
            for (int cy = 0; cy < ch; cy++)
                for (int cx = 0; cx < cw; cx++)
                {
                    float gx = cx + .5f, gy = cy + .5f;
                    float cloud = Field.SampleCells(WeatherField.Channel.Cloud, gx, gy), rain = Field.SampleCells(WeatherField.Channel.Rain, gx, gy),
                        storm = Field.SampleCells(WeatherField.Channel.Storm, gx, gy);
                    // thick cloud a pale veil, rain blue, storms a dark violet that reads over any terrain
                    float c = Mathf.Clamp01((cloud - .5f) * 1.6f) * .28f, r = Mathf.Clamp01((rain - .3f) * 1.6f) * .42f, s = Mathf.Clamp01((storm - .2f) * 1.5f) * .82f;
                    var col = Color.Lerp(new Color(.86f, .88f, .92f), new Color(.34f, .52f, .86f), r / Mathf.Max(.001f, c + r));
                    col = Color.Lerp(col, new Color(.22f, .14f, .40f), s / Mathf.Max(.001f, Mathf.Max(c, r) + s));
                    col.a = Mathf.Clamp01(Mathf.Max(Mathf.Max(c, r), s));
                    minimapPx[(ch - 1 - cy) * cw + cx] = col;
                }
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
        }

        public void Dispose()
        {
            Field.Dispose(); Clouds.Dispose();
            if (minimapTex != null) UnityEngine.Object.Destroy(minimapTex);
        }
    }
}
