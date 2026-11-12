using SE.Core.World;
using UnityEngine;

namespace SE.Runtime.Landscape
{
    /// <summary>
    /// Fog of war as one small texture sampled by every world shader: visible hexes bright, explored
    /// ones dimmed. Updated only when the server's visibility bits change (a few hundred µs).
    /// </summary>
    public sealed class FogField : System.IDisposable
    {
        static readonly int FogTex = Shader.PropertyToID("_SE_FogTex");
        static readonly int FogParams = Shader.PropertyToID("_SE_FogParams");
        Texture2D tex;
        byte[] pixels;
        int revision = -1;
        public bool Enabled = true;

        public void Update(WorldModel world)
        {
            if (!world.Ready) return;
            var g = world.Grid;
            if (tex == null || tex.width != g.W || tex.height != g.H)
            {
                if (tex != null) Object.Destroy(tex);
                tex = new Texture2D(g.W, g.H, TextureFormat.R8, false, true)
                {
                    name = "SE fog", filterMode = FilterMode.Bilinear, wrapModeU = g.Wrap ? TextureWrapMode.Repeat : TextureWrapMode.Clamp, wrapModeV = TextureWrapMode.Clamp,
                };
                pixels = new byte[g.N];
                revision = -1;
                Shader.SetGlobalTexture(FogTex, tex);
            }
            Shader.SetGlobalVector(FogParams, new Vector4(1f / g.Period, 1f / g.Depth, Enabled ? 1 : 0, 0.35f));
            if (revision == world.VisibilityRevision) return;
            revision = world.VisibilityRevision;
            for (int i = 0; i < g.N; i++) pixels[i] = world.IsVisible(i) ? (byte)255 : (byte)0;
            tex.SetPixelData(pixels, 0);
            tex.Apply(false, false);
        }

        public void Dispose() { if (tex != null) Object.Destroy(tex); }
    }
}
