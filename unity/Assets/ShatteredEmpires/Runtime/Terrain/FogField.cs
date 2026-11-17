using SE.Core.World;
using UnityEngine;

namespace SE.Runtime.Landscape
{
    /// <summary>
    /// Fog of war as one small texture sampled by every world shader. R: visible hexes bright, explored-but-unseen
    /// ones dimmed by SE_ApplyFog (no cloud over them). G: explored; hexes on the explored boundary are
    /// half-explored, so the volumetric shroud (SE/Shroud), which covers only never-explored ground, also rolls
    /// over the edge of known ground and hides the cut terrain beyond it. B: the ground
    /// height the shroud must bury (a hex's own height, or for unexplored hexes the tallest known neighbour),
    /// so the bank hugs the land instead of standing as a wall. Updated only when visibility or known terrain change.
    /// </summary>
    public sealed class FogField : System.IDisposable
    {
        static readonly int FogTex = Shader.PropertyToID("_SE_FogTex");
        static readonly int FogParams = Shader.PropertyToID("_SE_FogParams");
        public const float HeightRange = 8f;   // B channel: 0..1 = 0..8 world units
        Texture2D tex;
        byte[] pixels;
        float[] bury, blur;
        int revision = -1, knownSum = -1;
        public bool Enabled = true;

        public void Update(WorldModel world)
        {
            if (!world.Ready) return;
            var g = world.Grid;
            if (tex == null || tex.width != g.W || tex.height != g.H)
            {
                if (tex != null) Object.Destroy(tex);
                tex = new Texture2D(g.W, g.H, TextureFormat.RGBA32, false, true)
                {
                    name = "SE fog", filterMode = FilterMode.Bilinear, wrapModeU = g.Wrap ? TextureWrapMode.Repeat : TextureWrapMode.Clamp, wrapModeV = TextureWrapMode.Clamp,
                };
                pixels = new byte[g.N * 4];
                revision = knownSum = -1;
                Shader.SetGlobalTexture(FogTex, tex);
            }
            // explored-but-unseen ground is clearly darker than what is in sight (Rowen: "the whole map is visible")
            Shader.SetGlobalVector(FogParams, new Vector4(1f / g.Period, 1f / g.Depth, Enabled ? 1 : 0, UnseenDim));
            // The action RTS sends the whole landscape up front (every hex is "known"), so known ground cannot
            // say what this player has discovered. The client remembers every hex it has seen this match
            // instead, and the shroud's cloud bank covers the rest.
            if (explored == null || explored.Length != g.N || exploredEpoch != world.Epoch)
            {
                explored = new byte[g.N]; exploredEpoch = world.Epoch; exploredCount = 0; knownSum = -1;
            }
            // known terrain only grows; a cheap periodic checksum notices new ground without a full scan per frame
            int sum = Count(world.Known) + exploredCount * 7;
            if (revision == world.VisibilityRevision && sum == knownSum) return;
            // Visibility changes whenever units move: that only rewrites R. The explored channel and the smoothed
            // burial heights (G, B: six blur passes over the whole map) are rebuilt only when known ground changes,
            // or now and then so terrain height changes (craters) still reach the shroud.
            revision = world.VisibilityRevision;
            bool discovered = false;
            for (int i = 0; i < g.N; i++)
            {
                bool seen = world.IsVisible(i);
                pixels[i * 4] = seen ? (byte)255 : (byte)0;
                if (seen && explored[i] == 0) { explored[i] = 1; exploredCount++; discovered = true; }
            }
            sum = Count(world.Known) + exploredCount * 7;
            bool geography = discovered || sum != knownSum || bury == null || bury.Length != g.N || ++visibilityOnly >= 24;
            knownSum = sum;
            discoveredOnly = world.ActionLandscape;
            if (geography) RebuildGeography(world);
            tex.SetPixelData(pixels, 0);
            tex.Apply(false, false);
        }

        int visibilityOnly;
        /// <summary>Explored-but-unseen dimming strength (SE_ApplyFog: grey and darker; 0.35 read as fully visible).</summary>
        public float UnseenDim = 0.62f;
        byte[] explored;
        int exploredEpoch = -1, exploredCount;
        bool discoveredOnly;

        /// <summary>Ground this player has discovered: known terrain, and in the action RTS (whole landscape known) seen at least once.</summary>
        bool Discovered(byte[] known, int i) => known[i] != 0 && (!discoveredOnly || explored[i] != 0);

        void RebuildGeography(WorldModel world)
        {
            visibilityOnly = 0;
            var g = world.Grid;
            var known = world.Known; var height = world.Height;
            if (bury == null || bury.Length != g.N) { bury = new float[g.N]; blur = new float[g.N]; }
            for (int i = 0; i < g.N; i++)
            {
                byte e = 0;
                float h = known[i] != 0 ? height[i] : 0;
                if (Discovered(known, i))
                {
                    e = 255;
                    for (int d = 0; d < 6; d++) { int n = g.Neighbor(i, d); if (n < 0 || !Discovered(known, n)) { e = 120; break; } }
                }
                else
                    for (int d = 0; d < 6; d++) { int n = g.Neighbor(i, d); if (n >= 0 && known[n] != 0) h = Mathf.Max(h, height[n]); }
                pixels[i * 4 + 1] = e;
                bury[i] = Mathf.Max(0, h);
                pixels[i * 4 + 3] = 255;
            }
            // six smoothing passes (the bank slopes away over several hexes), never below the hex's own burial height, so the bank's crown rolls
            // instead of stepping in hexagons
            for (int pass = 0; pass < 6; pass++)
            {
                for (int i = 0; i < g.N; i++)
                {
                    float total = bury[i] * 2, w = 2;
                    for (int d = 0; d < 6; d++) { int n = g.Neighbor(i, d); if (n >= 0) { total += bury[n]; w++; } }
                    blur[i] = Mathf.Max(known[i] != 0 && pixels[i * 4 + 1] == 255 ? 0 : bury[i] * .85f, total / w);
                }
                (bury, blur) = (blur, bury);
            }
            for (int i = 0; i < g.N; i++) pixels[i * 4 + 2] = (byte)Mathf.Clamp(Mathf.RoundToInt(bury[i] / HeightRange * 255f), 0, 255);
        }

        int lastCount = -1, countFrame;
        int Count(byte[] known)
        {
            // full count every 15 frames (≈ 0.1 ms on a 160² map); geography arrives far slower than that
            if (++countFrame % 15 != 0 && lastCount >= 0) return lastCount;
            int c = 0;
            for (int i = 0; i < known.Length; i++) c += known[i];
            return lastCount = c;
        }

        public void Dispose() { if (tex != null) Object.Destroy(tex); }
    }
}
