using SE.Core.Protocol;
using SE.Core.World;
using UnityEngine;

namespace SE.Runtime.Landscape
{
    /// <summary>
    /// Per-hex ground state for the terrain shader, one small RGBA texture: developed city ground
    /// (r), shelled no-man's land (g), rain-wet ground (b) and crater density (a). Rebuilt only when the
    /// urban districts, the battlefield or the weather change.
    /// </summary>
    public sealed class GroundField : System.IDisposable
    {
        static readonly int GroundTex = Shader.PropertyToID("_SE_GroundTex");
        Texture2D tex;
        Color32[] px;
        int urbanRev = -1, bfRev = -1, wxRev = -1, epoch = -1;
        float[] scar = new float[0], crater = new float[0];

        /// <summary>Hexes scarred enough to clear trees (no-man's land stage 2+).</summary>
        public bool IsWasteland(int tile) => tile >= 0 && tile < scar.Length && scar[tile] >= 0.45f;

        public bool Update(WorldModel world, BattlefieldState bf, int bfRevision, WeatherState wx, int wxRevision, int urbanRevision)
        {
            if (!world.Ready) return false;
            var g = world.Grid;
            bool resized = false;
            if (tex == null || tex.width != g.W || tex.height != g.H || epoch != world.Epoch)
            {
                if (tex == null || tex.width != g.W || tex.height != g.H)
                {
                    if (tex != null) Object.Destroy(tex);
                    tex = new Texture2D(g.W, g.H, TextureFormat.RGBA32, false, true)
                    {
                        name = "SE ground", filterMode = FilterMode.Bilinear,
                        wrapModeU = g.Wrap ? TextureWrapMode.Repeat : TextureWrapMode.Clamp, wrapModeV = TextureWrapMode.Clamp,
                    };
                    px = new Color32[g.N];
                    scar = new float[g.N]; crater = new float[g.N];
                    Shader.SetGlobalTexture(GroundTex, tex);
                }
                epoch = world.Epoch;
                urbanRev = bfRev = wxRev = -1;
                resized = true;
            }
            if (urbanRev == urbanRevision && bfRev == bfRevision && wxRev == wxRevision) return false;
            bool bfChanged = bfRev != bfRevision;
            urbanRev = urbanRevision; bfRev = bfRevision; wxRev = wxRevision;
            if (bfChanged && bf != null)
            {
                System.Array.Clear(scar, 0, scar.Length);
                System.Array.Clear(crater, 0, crater.Length);
                foreach (var t in bf.Intensity) if (t.Tile >= 0 && t.Tile < scar.Length) scar[t.Tile] = Mathf.Clamp01(t.Value / 4f);
                foreach (var c in bf.Craters) if (c.Tile >= 0 && c.Tile < crater.Length) crater[c.Tile] = Mathf.Clamp01(c.Depth / 3f);
            }
            for (int i = 0; i < g.N; i++)
            {
                byte wet = wx != null ? (byte)(wx.Sample(wx.Wet, i, g.W) * 255) : (byte)0;
                px[i] = new Color32(world.IsUrban(i) ? (byte)255 : (byte)0, (byte)(scar[i] * 255), wet, (byte)(crater[i] * 255));
            }
            tex.SetPixels32(px);
            tex.Apply(false, false);
            return bfChanged || resized;
        }

        public void Dispose() { if (tex != null) Object.Destroy(tex); }
    }
}
