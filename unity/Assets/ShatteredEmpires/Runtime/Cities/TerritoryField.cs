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
        static readonly int InfluenceTexId = Shader.PropertyToID("_SE_InfluenceTex");
        static readonly int InfluenceParamsId = Shader.PropertyToID("_SE_InfluenceParams");
        static readonly int InfluenceColorId = Shader.PropertyToID("_SE_InfluenceColor");
        public const float TexelsPerUnit = 3f;
        /// <summary>Signed-distance encoding range (world units on each side of the border).</summary>
        public const float Range = 2.5f;
        /// <summary>Max distance between two of one owner's bases that a territory corridor joins.</summary>
        public float CorridorReach = 13f;
        public bool Enabled = true;

        // ---- Ring of influence edge (2026-11-18; server DEFENSE_INFLUENCE, actionBases.influenceRing) ----
        // A third map texture, _SE_InfluenceTex (R8: signed distance to the edge of InfluenceCiv's ring of influence, the
        // hexes within InfluenceReach of its territory), drawn by SE/Terrain with the territory border's own line in the
        // civ's team colour. Built in the same worker rebuild as the territory, so it changes only when ownership, the civ
        // or the reach does. Sides facing another player's territory are left to that border.
        /// <summary>Whose ring of influence is drawn (the local civ; -1: none).</summary>
        public int InfluenceCiv = -1;
        /// <summary>Hexes beyond the territory border (server RULESET.influence.reach; 0: none).</summary>
        public int InfluenceReach;
        float influenceStrength = -1f;
        /// <summary>How strongly the edge is drawn: faint while idle, full while placing a defense. Cheap: a shader global, set only on change.</summary>
        public void SetInfluenceStrength(float strength)
        {
            if (!Enabled || InfluenceCiv < 0 || InfluenceReach <= 0) strength = 0;
            if (Mathf.Abs(strength - influenceStrength) < .005f) return;
            influenceStrength = strength;
            Shader.SetGlobalVector(InfluenceParamsId, new Vector4(strength, Range, 0, 0));
        }
        Texture2D influence;
        byte[] ipx = Array.Empty<byte>(), hexInfluence = Array.Empty<byte>();
        float[] ibest = Array.Empty<float>();
        int[] influenceQueue = Array.Empty<int>();
        int builtInfluenceCiv = -1, builtInfluenceReach;
        Color builtInfluenceColour = Color.white;

        Texture2D territory, ground;
        Color32[] tpx, gpx;
        float[] best, apron, plaza, tier, upkeep, hexScore = Array.Empty<float>();
        int[] owner, texOwner = Array.Empty<int>(), hexOwner = Array.Empty<int>();
        int tw, th, epoch = -1;
        int[] texTile = new int[0];
        int texTileEpoch = -1, texTileW;
        float sx, sz;
        long signature = long.MinValue;
        bool tileMode;
        int tileModeEpoch = int.MinValue;   // world epoch in which the server sent territory (stays authoritative after)
        readonly List<(float x, float z, int owner, float r, bool hq)> claims = new List<(float, float, int, float, bool)>();

        public void Update(WorldModel world, IEnumerable<ObjectiveSite> sites, StructureStore structures, TeamPalette teams, bool actionRts)
        {
            if (!world.Ready) return;
            var g = world.Grid;
            long sig = 17;
            void Mix(long v) { unchecked { sig = sig * 1000003L ^ v; } }
            Mix(world.Epoch); Mix(teams.Key); Mix(Enabled ? 1 : 0); Mix(actionRts ? 1 : 0); Mix(InfluenceCiv); Mix(InfluenceReach);
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
            // TERRITORY_BORDERS.md: once the server has sent territory for this world, an empty owner map means "no
            // territory", never "fall back to the site/structure claims" (that fallback drew stale rings round
            // structures the server had released, e.g. after the last owned hex was lost).
            if (tileMode) tileModeEpoch = world.Epoch; else tileMode = tileModeEpoch == world.Epoch;
            Mix(tileMode ? 1 : 0);
            // (perf 2026-11-17) the rebuild walks every texel (~300k) and cost 60-130 ms on the main thread at each
            // ownership change: it now runs on a worker thread from a snapshot of its inputs, and the finished
            // textures are uploaded here. One rebuild at a time; a change meanwhile starts the next one after it.
            if (pendingBuild != null)
            {
                if (!pendingBuild.IsCompleted) return;
                var done = pendingBuild; pendingBuild = null;
                if (done.IsFaulted) Debug.LogException(done.Exception);
                else if (builtEpoch == epoch && territory != null) Upload(builtActionRts);
            }
            if (sig == signature && territory != null && epoch == world.Epoch) return;
            signature = sig;
            Allocate(g, world.Epoch);
            ResolveHexOwners(world, actionRts);
            EnsureTexTiles(g);
            // inputs the worker reads: the hex owners (copied), the base sites and the team colours
            if (ownerSnapshot.Length != hexOwner.Length) ownerSnapshot = new int[hexOwner.Length];
            Array.Copy(hexOwner, ownerSnapshot, hexOwner.Length);
            siteSnapshot.Clear();
            if (actionRts)
                foreach (var s in sites)
                    if (s.IsBase && s.Parcels != null && s.Parcels.Length >= 4) siteSnapshot.Add((s.X, s.Z, s.Headquarters != 0, s.Tier));
            colourSnapshot.Clear();
            foreach (int o in ownerSnapshot)
                if (o >= 0 && !colourSnapshot.ContainsKey(o))
                {
                    var c = math.saturate(teams.Color(o).xyz);
                    colourSnapshot[o] = new Color32((byte)(c.x * 255f), (byte)(c.y * 255f), (byte)(c.z * 255f), 255);
                }
            builtEpoch = epoch; builtActionRts = actionRts;
            builtInfluenceCiv = actionRts ? InfluenceCiv : -1; builtInfluenceReach = InfluenceReach;
            if (builtInfluenceCiv >= 0) { var ic = math.saturate(teams.Color(builtInfluenceCiv).xyz); builtInfluenceColour = new Color(ic.x, ic.y, ic.z, 1); }
            bool enabled = Enabled;
            if (PerfFlags.LegacyTerritory) { Rebuild(g, enabled); Upload(actionRts); return; }
            pendingBuild = System.Threading.Tasks.Task.Run(() => Rebuild(g, enabled));
        }

        System.Threading.Tasks.Task pendingBuild;
        int builtEpoch = -1; bool builtActionRts;
        int[] ownerSnapshot = Array.Empty<int>();
        readonly List<(float x, float z, bool hq, int tier)> siteSnapshot = new List<(float, float, bool, int)>();
        readonly Dictionary<int, Color32> colourSnapshot = new Dictionary<int, Color32>();

        void Upload(bool actionRts)
        {
            territory.SetPixels32(tpx); territory.Apply(false, false);
            ground.SetPixels32(gpx); ground.Apply(false, false);
            Shader.SetGlobalTexture(TerritoryTexId, territory);
            Shader.SetGlobalTexture(BaseGroundTexId, ground);
            Shader.SetGlobalVector(ParamsId, new Vector4(Enabled ? 1 : 0, Range, actionRts ? 1 : 0, 0));
            influence.SetPixelData(ipx, 0); influence.Apply(false, false);
            Shader.SetGlobalTexture(InfluenceTexId, influence);
            Shader.SetGlobalColor(InfluenceColorId, builtInfluenceColour);
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
                if (influence == null || influence.width != w || influence.height != h)
                {
                    if (influence != null) UnityEngine.Object.Destroy(influence);
                    influence = new Texture2D(w, h, TextureFormat.R8, false, true)
                    { name = "SE ring of influence", filterMode = FilterMode.Bilinear, wrapModeV = TextureWrapMode.Clamp };
                    ipx = new byte[w * h]; ibest = new float[w * h];
                }
                influence.wrapModeU = wrapU;
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

        void EnsureTexTiles(HexGrid g)
        {
            int n = tw * th;
            if (texOwner.Length != n) texOwner = new int[n];
            // the hex under each texel never changes for a given texture and map: computed once, not per rebuild
            if (texTile.Length != n || texTileEpoch != epoch || texTileW != tw)
            {
                if (texTile.Length != n) texTile = new int[n];
                texTileEpoch = epoch; texTileW = tw;
                for (int j = 0; j < th; j++)
                {
                    float mz = (j + .5f) / sz;
                    for (int i = 0; i < tw; i++) texTile[j * tw + i] = g.TileAt((i + .5f) / sx, mz);
                }
            }
        }

        /// <summary>Worker thread: the texel fields and pixels from the snapshot (no Unity API, no world access).</summary>
        void Rebuild(HexGrid g, bool enabled)
        {
            var hexOwner = ownerSnapshot;
            bool wrap = g.Wrap;
            int n = tw * th;
            for (int k = 0; k < n; k++)
            {
                best[k] = Range; owner[k] = -1;
                apron[k] = plaza[k] = tier[k] = upkeep[k] = 0;
            }
            // every texel takes the owner of the hex that holds its centre
            for (int k = 0; k < n; k++) { int t = texTile[k]; texOwner[k] = t >= 0 ? hexOwner[t] : -1; }
            if (enabled)
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
                foreach (var s in siteSnapshot)
                    {
                        bool hq = s.hq;
                        int t = Mathf.Clamp(s.tier, 1, 3);
                        float radius = hq ? 2.55f + .32f * (t - 1) : 2.35f;
                        float tierValue = hq ? t / 3f : 0f, keep = hq ? 1f : .3f;
                        float ox = s.x, oz = s.z;
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
            RebuildInfluence(g, enabled && builtActionRts, builtInfluenceCiv, builtInfluenceReach);
            var colours = colourSnapshot;
            for (int k = 0; k < n; k++)
            {
                int to = enabled ? texOwner[k] : -1;
                int o = to >= 0 ? to : owner[k];
                if (o < 0 || !enabled) { tpx[k] = new Color32(0, 0, 0, 0); }
                else
                {
                    float d = to >= 0 ? best[k] : -best[k];
                    if (!colours.TryGetValue(o, out var col)) col = new Color32(255, 255, 255, 255);
                    col.a = (byte)(math.saturate(.5f + d / (2f * Range)) * 255f);
                    tpx[k] = col;
                }
                gpx[k] = new Color32((byte)(apron[k] * 255f), (byte)(plaza[k] * 255f), (byte)(tier[k] * 255f), (byte)(upkeep[k] * 255f));
            }
        }

        /// <summary>
        /// Worker thread: the ring of influence edge (ipx). A BFS from every hex <paramref name="civ"/> owns, through any hex,
        /// capped at reach + 1 (as actionBases.influenceRing), marks the ring: hexes within reach that no other player owns.
        /// Each hex side between the ring and unowned ground outside it is stamped as a segment, and every texel near it keeps
        /// its distance, signed positive inside the ring and encoded like the territory alpha (0.5 = the edge).
        /// </summary>
        void RebuildInfluence(HexGrid g, bool enabled, int civ, int reach)
        {
            int n = tw * th;
            if (!enabled || civ < 0 || reach <= 0) { Array.Clear(ipx, 0, n); return; }
            var hexOwner = ownerSnapshot;
            int hexes = Math.Min(g.N, hexOwner.Length);
            if (hexInfluence.Length != g.N) { hexInfluence = new byte[g.N]; influenceQueue = new int[g.N]; }
            int head = 0, tail = 0, cap = Math.Min(254, reach + 1);
            for (int i = 0; i < g.N; i++)
            {
                bool own = i < hexes && hexOwner[i] == civ;
                hexInfluence[i] = own ? (byte)0 : (byte)255;
                if (own) influenceQueue[tail++] = i;
            }
            while (head < tail)
            {
                int t = influenceQueue[head++], d = hexInfluence[t] + 1;
                if (d > cap) continue;
                for (int k = 0; k < 6; k++)
                {
                    int nb = g.Nb[t * 6 + k];
                    if (nb >= 0 && hexInfluence[nb] > d) { hexInfluence[nb] = (byte)d; influenceQueue[tail++] = nb; }
                }
            }
            bool Inside(int t) => t >= 0 && t < hexes && hexInfluence[t] <= reach && (hexOwner[t] < 0 || hexOwner[t] == civ);
            for (int k = 0; k < n; k++) ibest[k] = Range;
            bool wrap = g.Wrap;
            const float Half = HexMath.Sqrt3 * .5f;
            for (int i = 0; i < hexes; i++)
            {
                if (!Inside(i)) continue;
                float cx = g.CenterX(i), cz = g.CenterZ(i);
                for (int d = 0; d < 6; d++)
                {
                    int nb = g.Nb[i * 6 + d];
                    if (nb < 0 || Inside(nb) || nb < hexes && hexOwner[nb] >= 0) continue;   // map edge, ring interior, another border
                    var mid = new float2(cx + HexMath.DirX[d] * Half, cz + HexMath.DirZ[d] * Half);
                    var along = new float2(-HexMath.DirZ[d], HexMath.DirX[d]) * .5f;
                    var a = mid - along; var ab = along * 2;
                    Stamp(mid.x, mid.y, .5f + Range, (k, mx, mz) =>
                    {
                        var p = new float2(mx, mz);
                        float s = math.saturate(math.dot(p - a, ab) / math.lengthsq(ab));
                        float dist = math.distance(p, a + ab * s);
                        if (dist < ibest[k]) ibest[k] = dist;
                    }, wrap);
                }
            }
            for (int k = 0; k < n; k++)
            {
                if (ibest[k] >= Range) { ipx[k] = 0; continue; }   // far from the edge: nothing to draw
                float d = Inside(texTile[k]) ? ibest[k] : -ibest[k];
                ipx[k] = (byte)Mathf.Clamp(Mathf.RoundToInt((.5f + d / (2f * Range)) * 255f), 1, 254);
            }
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
            try { pendingBuild?.Wait(); } catch (Exception) { }
            pendingBuild = null;
            if (territory != null) UnityEngine.Object.Destroy(territory);
            if (ground != null) UnityEngine.Object.Destroy(ground);
            if (influence != null) UnityEngine.Object.Destroy(influence);
            territory = ground = influence = null;
            Shader.SetGlobalVector(InfluenceParamsId, Vector4.zero);
            Shader.SetGlobalVector(ParamsId, Vector4.zero);
        }
    }
}
