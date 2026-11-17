using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Two map-wide textures for SE/Terrain, sampled with the same map UV as the fog of war:
    ///
    /// _SE_TerritoryTex (rgb: owner team colour, sRGB values; a: signed distance to the territory border,
    /// 0.5 = the border, encoded over ±Range world units). The border is hexagonal: it runs along the hex sides
    /// between differently owned hexes (the server's per-hex territory, or site claims rasterised onto hexes
    /// with corridors joining one owner's nearby bases), in the owner's team colour on both sides of the line.
    ///
    /// _SE_BaseGroundTex (r: base apron ramp, 0.5 at the apron edge; g: headquarters plaza ramp;
    /// b: tier/3; a: maintained (1) or abandoned (0.3) compound). The terrain shader turns this into
    /// compacted, paved ground under each ring base, so a base reads as one place, not a building collage.
    ///
    /// Rebuilt only when the claim set changes (owners, tiers, field structures, who "we" are).
    /// </summary>
    public sealed class TerritoryField : IDisposable
    {
        static readonly int TerritoryTexId = Shader.PropertyToID("_SE_TerritoryTex");
        static readonly int BaseGroundTexId = Shader.PropertyToID("_SE_BaseGroundTex");
        static readonly int ParamsId = Shader.PropertyToID("_SE_TerritoryParams");
        public const float TexelsPerUnit = 3f;
        /// <summary>Signed-distance encoding range (world units on each side of the border).</summary>
        public const float Range = 2.5f;
        /// <summary>Max distance between two of one owner's bases that a territory corridor joins.</summary>
        public float CorridorReach = 13f;
        public bool Enabled = true;

        Texture2D territory, ground;
        Color32[] tpx, gpx;
        float[] best, apron, plaza, tier, upkeep, hexScore = Array.Empty<float>();
        int[] owner, texOwner = Array.Empty<int>(), hexOwner = Array.Empty<int>();
        int tw, th, epoch = -1;
        float sx, sz;
        long signature = long.MinValue;
        bool tileMode;
        readonly List<(float x, float z, int owner, float r, bool hq)> claims = new List<(float, float, int, float, bool)>();

        public void Update(WorldModel world, IEnumerable<ObjectiveSite> sites, StructureStore structures, TeamPalette teams, bool actionRts)
        {
            if (!world.Ready) return;
            var g = world.Grid;
            long sig = 17;
            void Mix(long v) { unchecked { sig = sig * 1000003L ^ v; } }
            Mix(world.Epoch); Mix(teams.Key); Mix(Enabled ? 1 : 0); Mix(actionRts ? 1 : 0);
            claims.Clear();
            if (actionRts)
            {
                foreach (var s in sites)
                {
                    Mix(s.Id); Mix(s.Owner); Mix(s.Tier); Mix(s.Headquarters != 0 ? 1 : 0); Mix(s.IsBase ? 1 : 0);
                    Mix(Mathf.RoundToInt(s.X * 16)); Mix(Mathf.RoundToInt(s.Z * 16));
                    if (s.Owner < 0) continue;
                    float r = s.IsBase ? (s.Headquarters != 0 ? 3.1f + .55f * Mathf.Clamp(s.Tier, 1, 3) : 2.2f) : 1.6f;
                    claims.Add((s.X, s.Z, s.Owner, r, s.IsBase && s.Headquarters != 0));
                }
                foreach (var b in structures.Buildings.Values)
                {
                    if (!b.HasPosition || b.Owner < 0 || !b.Done || b.City > 0 || b.Type == "barricade") continue;
                    Mix(b.Id); Mix(b.Owner); Mix(Mathf.RoundToInt(b.X * 16)); Mix(Mathf.RoundToInt(b.Z * 16));
                    claims.Add((b.X, b.Z, b.Owner, .95f, false));
                }
            }
            // The server's per-hex territory (TileRecord.Owner) is authoritative when present; the
            // site claims above only stand in for it (older servers) and still draw the corridors.
            tileMode = false;
            var own = world.Owner;
            for (int i = 0; i < own.Length && i < g.N; i++) if (own[i] >= 0) { Mix(i); Mix(own[i]); tileMode = true; }
            Mix(tileMode ? 1 : 0);
            if (sig == signature && territory != null && epoch == world.Epoch) return;
            signature = sig;
            Allocate(g, world.Epoch);
            Rebuild(world, sites, teams, actionRts);
        }

        void Allocate(HexGrid g, int worldEpoch)
        {
            int w = Mathf.Clamp(Mathf.CeilToInt(g.Period * TexelsPerUnit), 16, 2048);
            int h = Mathf.Clamp(Mathf.CeilToInt(g.Depth * TexelsPerUnit), 16, 2048);
            var wrapU = g.Wrap ? TextureWrapMode.Repeat : TextureWrapMode.Clamp;
            if (territory == null || territory.width != w || territory.height != h || epoch != worldEpoch)
            {
                if (territory == null || territory.width != w || territory.height != h)
                {
                    if (territory != null) UnityEngine.Object.Destroy(territory);
                    if (ground != null) UnityEngine.Object.Destroy(ground);
                    territory = new Texture2D(w, h, TextureFormat.RGBA32, false, true)
                    { name = "SE territory", filterMode = FilterMode.Bilinear, wrapModeU = wrapU, wrapModeV = TextureWrapMode.Clamp };
                    ground = new Texture2D(w, h, TextureFormat.RGBA32, false, true)
                    { name = "SE base ground", filterMode = FilterMode.Bilinear, wrapModeU = wrapU, wrapModeV = TextureWrapMode.Clamp };
                    int n = w * h;
                    tpx = new Color32[n]; gpx = new Color32[n];
                    best = new float[n]; apron = new float[n]; plaza = new float[n]; tier = new float[n]; upkeep = new float[n];
                    owner = new int[n];
                }
                territory.wrapModeU = wrapU; ground.wrapModeU = wrapU;
                epoch = worldEpoch;
            }
            tw = w; th = h;
            sx = w / g.Period; sz = h / g.Depth;
        }

        /// <summary>Visit the texels within reach of a point (map units); the callback gets the index and the texel centre.</summary>
        void Stamp(float cx, float cz, float reach, Action<int, float, float> visit, bool wrap)
        {
            int i0 = Mathf.FloorToInt((cx - reach) * sx), i1 = Mathf.CeilToInt((cx + reach) * sx);
            int j0 = Mathf.Max(0, Mathf.FloorToInt((cz - reach) * sz)), j1 = Mathf.Min(th - 1, Mathf.CeilToInt((cz + reach) * sz));
            for (int j = j0; j <= j1; j++)
            {
                float mz = (j + .5f) / sz;
                for (int i = i0; i <= i1; i++)
                {
                    int ii = i;
                    if (ii < 0 || ii >= tw) { if (!wrap) continue; ii = HexMath.PosMod(ii, tw); }
                    visit(j * tw + ii, (i + .5f) / sx, mz);
                }
            }
        }

        void Rebuild(WorldModel world, IEnumerable<ObjectiveSite> sites, TeamPalette teams, bool actionRts)
        {
            var g = world.Grid;
            bool wrap = g.Wrap;
            int n = tw * th;
            for (int k = 0; k < n; k++)
            {
                best[k] = Range; owner[k] = -1;
                apron[k] = plaza[k] = tier[k] = upkeep[k] = 0;
            }
            ResolveHexOwners(world, actionRts);
            // every texel takes the owner of the hex that holds its centre
            if (texOwner.Length != n) texOwner = new int[n];
            for (int j = 0; j < th; j++)
            {
                float mz = (j + .5f) / sz;
                for (int i = 0; i < tw; i++)
                {
                    int t = g.TileAt((i + .5f) / sx, mz);
                    texOwner[j * tw + i] = t >= 0 ? hexOwner[t] : -1;
                }
            }
            if (Enabled)
            {
                // The border follows the hex sides exactly: every side between two different owners (or an owner
                // and no one) is stamped as a segment, and each texel keeps its distance to the nearest side of
                // its own region. Inside that is the inward distance; outside, the distance to the nearest owned
                // side in that owner's colour, so the line is centred on the hex side and stays straight.
                const float Half = HexMath.Sqrt3 * .5f;
                for (int i = 0; i < g.N; i++)
                {
                    int o = hexOwner[i];
                    if (o < 0) continue;
                    float cx = g.CenterX(i), cz = g.CenterZ(i);
                    for (int d = 0; d < 6; d++)
                    {
                        int nb = g.Nb[i * 6 + d];
                        int on = nb >= 0 ? hexOwner[nb] : -1;
                        if (on == o || on >= 0 && nb < i) continue;   // one visit per side
                        var mid = new float2(cx + HexMath.DirX[d] * Half, cz + HexMath.DirZ[d] * Half);
                        var along = new float2(-HexMath.DirZ[d], HexMath.DirX[d]) * .5f;
                        var a = mid - along; var ab = along * 2;
                        int inner = o, outer = on;
                        Stamp(mid.x, mid.y, .5f + Range, (k, mx, mz) =>
                        {
                            int to = texOwner[k];
                            if (to != inner && to != outer) return;
                            var p = new float2(mx, mz);
                            float s = math.saturate(math.dot(p - a, ab) / math.lengthsq(ab));
                            float dist = math.distance(p, a + ab * s);
                            if (dist >= best[k]) return;
                            best[k] = dist;
                            owner[k] = to >= 0 ? to : inner;
                        }, wrap);
                    }
                }
                if (actionRts)
                    foreach (var s in sites)
                    {
                        if (!s.IsBase || s.Parcels == null || s.Parcels.Length < 4) continue;
                        bool hq = s.Headquarters != 0;
                        int t = Mathf.Clamp(s.Tier, 1, 3);
                        float radius = hq ? 2.55f + .32f * (t - 1) : 2.35f;
                        float tierValue = hq ? t / 3f : 0f, keep = hq ? 1f : .3f;
                        float ox = s.X, oz = s.Z;
                        Stamp(ox, oz, radius + .8f, (k, mx, mz) =>
                        {
                            // compounds are slightly oval like their parcel ring (x 1.055, z .965)
                            float dx = (mx - ox) / 1.04f, dz = (mz - oz) / .975f;
                            float d = math.sqrt(dx * dx + dz * dz);
                            float ramp = math.saturate(.5f + (radius - d) / 1.2f);
                            if (ramp > apron[k]) { apron[k] = ramp; tier[k] = tierValue; upkeep[k] = keep; }
                            plaza[k] = math.max(plaza[k], math.saturate(.5f + (1.02f - d) / .5f) * (hq ? 1f : .55f));
                        }, wrap);
                    }
            }
            var colours = new Dictionary<int, Color32>();
            for (int k = 0; k < n; k++)
            {
                int to = Enabled ? texOwner[k] : -1;
                int o = to >= 0 ? to : owner[k];
                if (o < 0 || !Enabled) { tpx[k] = new Color32(0, 0, 0, 0); }
                else
                {
                    float d = to >= 0 ? best[k] : -best[k];
                    if (!colours.TryGetValue(o, out var col))
                    {
                        var c = math.saturate(teams.Color(o).xyz);
                        colours[o] = col = new Color32((byte)(c.x * 255f), (byte)(c.y * 255f), (byte)(c.z * 255f), 255);
                    }
                    col.a = (byte)(math.saturate(.5f + d / (2f * Range)) * 255f);
                    tpx[k] = col;
                }
                gpx[k] = new Color32((byte)(apron[k] * 255f), (byte)(plaza[k] * 255f), (byte)(tier[k] * 255f), (byte)(upkeep[k] * 255f));
            }
            territory.SetPixels32(tpx); territory.Apply(false, false);
            ground.SetPixels32(gpx); ground.Apply(false, false);
            Shader.SetGlobalTexture(TerritoryTexId, territory);
            Shader.SetGlobalTexture(BaseGroundTexId, ground);
            Shader.SetGlobalVector(ParamsId, new Vector4(Enabled ? 1 : 0, Range, actionRts ? 1 : 0, 0));
        }

        /// <summary>
        /// The owner of every hex: the server's per-hex territory when it sends one; otherwise (older servers)
        /// each hex goes to the strongest site claim over its centre, and corridors join one owner's
        /// neighbouring headquarters, so the outline is still drawn on hex sides.
        /// </summary>
        void ResolveHexOwners(WorldModel world, bool actionRts)
        {
            var g = world.Grid;
            if (hexOwner.Length != g.N) { hexOwner = new int[g.N]; hexScore = new float[g.N]; }
            for (int i = 0; i < g.N; i++) { hexOwner[i] = -1; hexScore[i] = 0; }
            if (!Enabled) return;
            if (tileMode)
            {
                var own = world.Owner;
                for (int i = 0; i < own.Length && i < g.N; i++) hexOwner[i] = own[i];
                return;
            }
            if (!actionRts || claims.Count == 0) return;
            for (int i = 0; i < g.N; i++)
            {
                float cx = g.CenterX(i), cz = g.CenterZ(i);
                foreach (var c in claims)
                {
                    float dx = g.DxWrap(c.x, cx), dz = cz - c.z;
                    float margin = c.r - math.sqrt(dx * dx + dz * dz);
                    if (margin > hexScore[i]) { hexScore[i] = margin; hexOwner[i] = c.owner; }
                }
            }
            for (int a = 0; a < claims.Count; a++)
            {
                if (!claims[a].hq) continue;
                for (int b = a + 1; b < claims.Count; b++)
                {
                    if (!claims[b].hq || claims[b].owner != claims[a].owner) continue;
                    var pa = new float2(claims[a].x, claims[a].z);
                    var pb = new float2(g.NearX(claims[b].x, claims[a].x), claims[b].z);
                    float length = math.distance(pa, pb);
                    if (length > CorridorReach || length < .01f) continue;
                    const float Corridor = 1.15f;
                    var ab = pb - pa;
                    int who = claims[a].owner;
                    for (int i = 0; i < g.N; i++)
                    {
                        var p = new float2(g.NearX(g.CenterX(i), pa.x), g.CenterZ(i));
                        float t = math.saturate(math.dot(p - pa, ab) / math.lengthsq(ab));
                        float waist = Corridor * (1f - .25f * math.sin(t * math.PI));
                        float margin = waist - math.distance(p, pa + ab * t);
                        if (margin > hexScore[i] && (hexOwner[i] < 0 || hexOwner[i] == who)) { hexScore[i] = margin; hexOwner[i] = who; }
                    }
                }
            }
        }

        public void Dispose()
        {
            if (territory != null) UnityEngine.Object.Destroy(territory);
            if (ground != null) UnityEngine.Object.Destroy(ground);
            territory = ground = null;
            Shader.SetGlobalVector(ParamsId, Vector4.zero);
        }
    }
}
