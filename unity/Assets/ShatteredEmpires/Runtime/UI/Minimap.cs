using System;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Session;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The minimap: terrain, territory (tinted by owner, borders brighter), fog of war, units as dots
    /// (yours, allies' and enemies' at a glance) and the camera's footprint. Click or drag to move the
    /// camera. The texture is redrawn twice a second from the world mirror; nothing here is simulated.
    /// </summary>
    public sealed class Minimap : VisualElement
    {
        readonly ClientSession session;
        readonly Image image;
        readonly VisualElement overlay;
        Texture2D tex;
        Color32[] px;
        float drawAt;
        bool dragging;

        /// <summary>The camera footprint on the ground, as map (x, z) of the four screen corners.</summary>
        public Func<Vector2[]> ViewCorners;
        /// <summary>Move the camera to map (x, z).</summary>
        public Action<float, float> FocusMap;

        public Minimap(ClientSession s)
        {
            session = s;
            AddToClassList("minimap");
            AddToClassList("glass");
            image = new Image { scaleMode = ScaleMode.StretchToFill };
            image.AddToClassList("minimap-image");
            Add(image);
            overlay = new VisualElement { pickingMode = PickingMode.Ignore };
            overlay.AddToClassList("minimap-image");
            overlay.generateVisualContent += DrawOverlay;
            Add(overlay);
            image.RegisterCallback<PointerDownEvent>(e => { dragging = true; image.CapturePointer(e.pointerId); Jump(e.localPosition); });
            image.RegisterCallback<PointerMoveEvent>(e => { if (dragging) Jump(e.localPosition); });
            image.RegisterCallback<PointerUpEvent>(e => { dragging = false; image.ReleasePointer(e.pointerId); });
        }

        void Jump(Vector2 local)
        {
            var w = session.World;
            if (!w.Ready || FocusMap == null) return;
            var r = image.contentRect;
            if (r.width <= 0 || r.height <= 0) return;
            float x = Mathf.Clamp01(local.x / r.width) * w.Grid.Period;
            float z = Mathf.Clamp01(local.y / r.height) * w.Grid.H * 1.5f;
            FocusMap(x, z);
        }

        public void Tick(float time)
        {
            overlay.MarkDirtyRepaint();
            if (time < drawAt) return;
            drawAt = time + 0.5f;
            var w = session.World;
            if (!w.Ready) return;
            var g = w.Grid;
            if (tex == null || tex.width != g.W || tex.height != g.H)
            {
                if (tex != null) UnityEngine.Object.Destroy(tex);
                tex = new Texture2D(g.W, g.H, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp, name = "SE minimap" };
                px = new Color32[g.N];
                image.image = tex;
                // keep the map's true proportions (hexes are √3 wide, 1.5 tall)
                style.height = Mathf.Clamp(resolvedStyle.width > 0 ? resolvedStyle.width : 260f, 120f, 400f) * (g.H * 1.5f) / g.Period + 12f;
            }
            int me = session.CivId;
            for (int i = 0; i < g.N; i++)
            {
                int q = i % g.W, r = i / g.W;
                int p = (g.H - 1 - r) * g.W + q;   // texture rows run bottom-up
                if (w.Known[i] == 0) { px[p] = new Color32(14, 18, 20, 255); continue; }
                Color c = Terrain(w, i);
                int owner = w.Owner[i];
                if (owner >= 0)
                {
                    Color civ = CivColor(owner);
                    bool border = false;
                    for (int d = 0; d < 6 && !border; d++) { int n = g.Nb[i * 6 + d]; border = n >= 0 && w.Owner[n] != owner; }
                    c = Color.Lerp(c, civ, border ? 0.85f : 0.32f);
                }
                if (w.IsUrban(i)) c = Color.Lerp(c, new Color(0.82f, 0.8f, 0.74f), 0.45f);
                if (!w.IsVisible(i)) c *= 0.55f;
                c.a = 1f;
                px[p] = c;
            }
            // units: a dot each, coloured by side
            var units = session.Units;
            for (int s = 0; s < units.SlotCount; s++)
            {
                ref var u = ref units.Records[s];
                if (!u.InUse || u.Tile < 0 || u.Tile >= g.N) continue;
                int q = u.Tile % g.W, r = u.Tile / g.W;
                int p = (g.H - 1 - r) * g.W + q;
                px[p] = u.Owner == me ? new Color32(120, 240, 130, 255) : new Color32(255, 84, 64, 255);
            }
            tex.SetPixels32(px);
            tex.Apply(false, false);
        }

        Color CivColor(int id)
        {
            var c = session.CivColor(id);
            return new Color(c.x, c.y, c.z).gamma;
        }

        static Color Terrain(WorldModel w, int i)
        {
            uint sc = w.ServerColor[i];
            if (sc != 0) return new Color(((sc >> 16) & 255) / 255f, ((sc >> 8) & 255) / 255f, (sc & 255) / 255f);
            if (w.IsSea(i)) return w.Elevation(i) < -0.25f ? new Color(0.09f, 0.2f, 0.33f) : new Color(0.16f, 0.36f, 0.5f);
            if (w.IsLake(i)) return new Color(0.2f, 0.42f, 0.52f);
            switch (w.Biome[i])
            {
                case 10: return new Color(0.86f, 0.86f, 0.88f);
                case 9: return new Color(0.48f, 0.45f, 0.42f);
                case 8: return new Color(0.5f, 0.52f, 0.34f);
                case 4: return new Color(0.24f, 0.4f, 0.22f);
                case 5: return new Color(0.74f, 0.66f, 0.46f);
                default: return new Color(0.42f, 0.55f, 0.32f);
            }
        }

        void DrawOverlay(MeshGenerationContext ctx)
        {
            var w = session.World;
            if (!w.Ready || ViewCorners == null) return;
            var corners = ViewCorners();
            if (corners == null || corners.Length != 4) return;
            var r = overlay.contentRect;
            float sx = r.width / w.Grid.Period, sz = r.height / (w.Grid.H * 1.5f);
            var p = ctx.painter2D;
            p.strokeColor = new Color(1f, 0.92f, 0.7f, 0.95f);
            p.lineWidth = 1.5f;
            p.BeginPath();
            for (int k = 0; k < 4; k++)
            {
                float x = w.Grid.BaseX(corners[k].x) * sx, y = Mathf.Clamp(corners[k].y * sz, 0, r.height);
                var v = new Vector2(Mathf.Clamp(x, 0, r.width), y);
                if (k == 0) p.MoveTo(v); else p.LineTo(v);
            }
            p.ClosePath();
            p.Stroke();
        }

        public void Dispose() { if (tex != null) UnityEngine.Object.Destroy(tex); }
    }
}
