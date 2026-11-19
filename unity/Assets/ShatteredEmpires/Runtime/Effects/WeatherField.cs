using System;
using SE.Core.Protocol;
using UnityEngine;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// The server's regional weather as two tiny GPU textures (one texel per 8x8-hex weather cell; r cloud,
    /// g rain, b storm, a wetness): the previous and the latest snapshot. Between snapshots (every 5 simulated
    /// seconds) the shown field is interpolated along the prevailing wind: prev(x - u f) blended into
    /// next(x + u (1 - f)), so cloud banks glide instead of cross-fading in place. Every world shader reads
    /// it (SECommon SE_WeatherAt: storm darkening, cloud shadows, lightning light), the storm clouds draw from
    /// it, and the CPU samples the same interpolation for audio, notices and the minimap.
    /// The textures are rewritten only when a new snapshot arrives; per frame only five shader globals change.
    /// </summary>
    public sealed class WeatherField : IDisposable
    {
        static readonly int PrevId = Shader.PropertyToID("_SE_WxPrev"), NextId = Shader.PropertyToID("_SE_WxNext"),
            ParamsId = Shader.PropertyToID("_SE_WxParams"), ScaleId = Shader.PropertyToID("_SE_WxScale"), AdvectId = Shader.PropertyToID("_SE_WxAdvect");

        Texture2D prevTex, nextTex;
        Color32[] px = Array.Empty<Color32>();
        WeatherState prev, next;
        int version = int.MinValue, revision = -1;
        float receivedAt = -1f, interval = 5f;
        /// <summary>Blend between the previous and the latest snapshot (0..1).</summary>
        public float Blend { get; private set; } = 1f;
        /// <summary>Wind displacement over one server weather step, in cells (x east, y south).</summary>
        public Vector2 StepCells { get; private set; }
        /// <summary>Real seconds between weather snapshots (measured; about 5 s at normal speed).</summary>
        public float Interval => interval;
        public bool Active => next != null && next.CellsW > 0 && next.CellsH > 0;
        public WeatherState Latest => next;
        public int CellsW => next?.CellsW ?? 0;
        public int CellsH => next?.CellsH ?? 0;
        int mapW, mapH;
        float period = 1, depth = 1;
        /// <summary>Changes whenever a new snapshot has been uploaded (the minimap overlay rebuilds on it).</summary>
        public int Revision { get; private set; }

        /// <summary>World size of one weather cell (Unity x, map z).</summary>
        public float CellWorldX => next == null || mapW <= 0 ? 1f : period * next.Cell / mapW;
        public float CellWorldZ => next == null || mapH <= 0 ? 1f : depth * next.Cell / mapH;
        public float Period => period;
        public float Depth => depth;

        public void Update(WeatherState wx, int wxRevision, int w, int h, float gridPeriod, float gridDepth, float time, float intensity)
        {
            mapW = w; mapH = h; period = Mathf.Max(1f, gridPeriod); depth = Mathf.Max(1f, gridDepth);
            if (wx == null || wx.CellsW <= 0 || wx.CellsH <= 0)
            {
                if (next != null) { prev = next = null; version = int.MinValue; }
                Shader.SetGlobalVector(ParamsId, new Vector4(1, 0, 0, time));
                return;
            }
            if (wxRevision != revision && wx.Version != version)
            {
                bool first = next == null || next.CellsW != wx.CellsW || next.CellsH != wx.CellsH;
                if (!first && receivedAt >= 0)
                {
                    float gap = time - receivedAt;
                    if (gap > .3f && gap < 30f) interval = Mathf.Lerp(interval, Mathf.Clamp(gap, 1f, 15f), .5f);
                }
                receivedAt = time;
                prev = first ? wx : next;
                next = wx;
                version = wx.Version;
                Upload(first);
            }
            revision = wxRevision;
            Blend = receivedAt < 0 ? 1f : Mathf.Clamp01((time - receivedAt) / Mathf.Max(.5f, interval));
            // the server's prevailing flow per step (weather.js step: vx, vy in cells)
            float spd = .25f + next.WindSpeed * .55f;
            StepCells = new Vector2(Mathf.Cos(next.WindAngle) * spd, Mathf.Sin(next.WindAngle) * spd * .6f);
            float cw = next.CellsW, ch = next.CellsH;
            var u = new Vector2(StepCells.x / cw, StepCells.y / ch);
            Shader.SetGlobalVector(AdvectId, new Vector4(-u.x * Blend, -u.y * Blend, u.x * (1 - Blend), u.y * (1 - Blend)));
            Shader.SetGlobalVector(ScaleId, new Vector4((float)mapW / (cw * next.Cell) / period, (float)mapH / (ch * next.Cell) / depth, 0, 0));
            Shader.SetGlobalVector(ParamsId, new Vector4(Blend, Mathf.Clamp01(intensity), 1, time));
        }

        void Upload(bool first)
        {
            int cw = next.CellsW, ch = next.CellsH, n = cw * ch;
            if (nextTex == null || nextTex.width != cw || nextTex.height != ch)
            {
                Destroy(ref prevTex); Destroy(ref nextTex);
                prevTex = Make(cw, ch, "SE weather prev"); nextTex = Make(cw, ch, "SE weather next");
                first = true;
            }
            if (px.Length != n) px = new Color32[n];
            if (first) { Fill(prev, prevTex); Fill(next, nextTex); }
            else
            {
                // the previous "next" becomes "prev" without re-uploading it
                var t = prevTex; prevTex = nextTex; nextTex = t;
                Fill(next, nextTex);
            }
            Shader.SetGlobalTexture(PrevId, prevTex);
            Shader.SetGlobalTexture(NextId, nextTex);
            Revision++;
        }

        void Fill(WeatherState s, Texture2D tex)
        {
            int n = s.CellsW * s.CellsH;
            for (int i = 0; i < n; i++)
                px[i] = new Color32(B(s.Cloud, i), B(s.Rain, i), B(s.Storm, i), B(s.Wet, i));
            tex.SetPixels32(px);
            tex.Apply(false, false);
        }

        static byte B(byte[] f, int i) => f != null && i < f.Length ? f[i] : (byte)0;

        static Texture2D Make(int w, int h, string name) => new Texture2D(w, h, TextureFormat.RGBA32, false, true)
        {
            name = name, filterMode = FilterMode.Bilinear, wrapModeU = TextureWrapMode.Repeat, wrapModeV = TextureWrapMode.Clamp, anisoLevel = 0,
        };

        static void Destroy(ref Texture2D t) { if (t != null) UnityEngine.Object.Destroy(t); t = null; }

        // ------------------------------------------------------------------ CPU sampling (same as the shaders)
        public enum Channel { Cloud, Rain, Storm, Wet }

        static byte[] Field(WeatherState s, Channel c) => c == Channel.Cloud ? s.Cloud : c == Channel.Rain ? s.Rain : c == Channel.Storm ? s.Storm : s.Wet;

        /// <summary>The shown (interpolated, advected) value at a map position (x east, z south), 0..1.</summary>
        public float Sample(Channel c, float mapX, float mapZ)
        {
            if (!Active) return 0f;
            float gx = mapX / period * mapW / next.Cell, gy = mapZ / depth * mapH / next.Cell;   // in cells
            float a = Bilinear(Field(prev, c), prev, gx - StepCells.x * Blend, gy - StepCells.y * Blend);
            float b = Bilinear(Field(next, c), next, gx + StepCells.x * (1 - Blend), gy + StepCells.y * (1 - Blend));
            return a + (b - a) * Blend;
        }

        /// <summary>Like <see cref="Sample"/> but at cell coordinates (cell centres at integer + .5).</summary>
        public float SampleCells(Channel c, float gx, float gy)
        {
            if (!Active) return 0f;
            float a = Bilinear(Field(prev, c), prev, gx - StepCells.x * Blend, gy - StepCells.y * Blend);
            float b = Bilinear(Field(next, c), next, gx + StepCells.x * (1 - Blend), gy + StepCells.y * (1 - Blend));
            return a + (b - a) * Blend;
        }

        static float Bilinear(byte[] f, WeatherState s, float gx, float gy)
        {
            if (f == null) return 0f;
            int cw = s.CellsW, ch = s.CellsH;
            gx -= .5f; gy -= .5f;
            int x0 = Mathf.FloorToInt(gx), y0 = Mathf.FloorToInt(gy);
            float tx = gx - x0, ty = gy - y0;
            int xa = ((x0 % cw) + cw) % cw, xb = (xa + 1) % cw;
            int ya = Mathf.Clamp(y0, 0, ch - 1), yb = Mathf.Clamp(y0 + 1, 0, ch - 1);
            float v00 = At(f, ya * cw + xa), v10 = At(f, ya * cw + xb), v01 = At(f, yb * cw + xa), v11 = At(f, yb * cw + xb);
            return (v00 + (v10 - v00) * tx) * (1 - ty) + (v01 + (v11 - v01) * tx) * ty;
        }

        static float At(byte[] f, int i) => i >= 0 && i < f.Length ? f[i] * (1f / 255f) : 0f;

        /// <summary>
        /// The storm value the server's air rules read for a hex (its weather cell, not blended): aircraft do
        /// not take off from or land at a base where this is at least .5 (actionAir.js AIR_WEATHER.storm).
        /// </summary>
        public float StormCell(int tile)
        {
            if (!Active || next.Storm == null || mapW <= 0) return 0f;
            int q = tile % mapW, r = tile / mapW;
            int c = (r / next.Cell) * next.CellsW + q / next.Cell;
            return At(next.Storm, c);
        }

        /// <summary>The latest snapshot's raw storm value at a cell, a few steps upwind (where the weather here will come from).</summary>
        public float StormUpwind(int tile, float steps)
        {
            if (!Active || next.Storm == null || mapW <= 0) return 0f;
            int q = tile % mapW, r = tile / mapW;
            float gx = (q + .5f) / next.Cell - StepCells.x * steps, gy = (r + .5f) / next.Cell - StepCells.y * steps;
            int cx = ((Mathf.FloorToInt(gx) % next.CellsW) + next.CellsW) % next.CellsW, cy = Mathf.Clamp(Mathf.FloorToInt(gy), 0, next.CellsH - 1);
            return At(next.Storm, cy * next.CellsW + cx);
        }

        public void Dispose() { Destroy(ref prevTex); Destroy(ref nextTex); }
    }
}
