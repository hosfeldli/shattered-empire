using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Session;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The circular minimap (docs/UI_DESIGN_SPEC.md B4): bottom-left, 240 across, north up. The map fills
    /// the circle (its shorter side spans the inner 224, so there is no small square with dark corners); the
    /// view slides toward the camera only as far as needed to keep the camera footprint inside the circle, so
    /// the clipped corners come into view when the camera goes there. Wrapping maps scroll sideways so the
    /// circle stays centred on the camera. Layers, bottom to top: terrain + territory + fog (a texture
    /// redrawn twice a second), buildings and units as relation-coloured dots (gathered eight times a
    /// second; one owner's units sharing a 4 px cell merge into a dot that grows with the count), bases shape-coded (friendly circle, enemy diamond, neutral hollow
    /// ring), the camera footprint (a filled trapezoid) and alert pings. Z (minimap_zoom) switches to a local view
    /// around the camera, 2.25 times closer. Left-click or drag moves the camera; right-click
    /// orders the selection there (<see cref="OrderAt"/>). Nothing here allocates per frame, and the dot and
    /// mark meshes are regenerated only when their content changes.
    /// </summary>
    public sealed class Minimap : VisualElement
    {
        const float Outer = 240f, Bezel = 8f, Inner = Outer - 2f * Bezel, InnerR = Inner * 0.5f;
        const float CellPx = 4f;               // unit aggregation cell
        const int MaxUnitDots = 1500, MaxBuildingDots = 900, MaxDots = MaxUnitDots + MaxBuildingDots;
        const int MaxEmit = MaxDots * 2;       // wrap copies near the seam
        const int MaxPings = 8;

        readonly ClientSession session;
        readonly VisualElement clip, storms, dots, marks, bezel;
        readonly Image[] terrain = new Image[3];
        Texture2D tex;
        Color32[] px;
        HexGrid grid;
        float drawAt, gatherAt;
        bool dragging;

        // projection (clip-local panel units): screen = (mapLeft + x * scale, mapTop + z * scale)
        float scale = 1f, mapW, mapH, mapLeft, mapTop, focusX, focusZ, baseScale = 1f;
        // the local view (Z): the circle shows a smaller section around the camera, ZoomFactor times closer
        // (relative to the filled whole-map view: about 3.2x the old diagonal fit)
        const float ZoomFactor = 2.25f;
        // whole-map view: the camera footprint centre stays at least this far inside the rim (px)
        const float FollowMargin = 22f;
        bool zoomed, zoomDirty;
        // the Z switch eases: 0 whole map … 1 local view, smoothstepped over ZoomSeconds of unscaled (panel) time
        const float ZoomSeconds = .3f;
        float zoomT, zoomTickAt = -1f;
        float ZoomEase => zoomT * zoomT * (3f - 2f * zoomT);
        readonly float[] terrainLeft = { float.NaN, float.NaN, float.NaN };
        float terrainTop = float.NaN;
        readonly Vector2[] foot = new Vector2[4];
        bool hasFoot;

        // gathered dots in map space (refreshed at 8 Hz, projected every frame)
        readonly float[] dotX = new float[MaxDots], dotZ = new float[MaxDots];
        readonly Color32[] dotC = new Color32[MaxDots];
        readonly byte[] dotSize = new byte[MaxDots];
        readonly ushort[] dotN = new ushort[MaxDots];   // units merged into this dot (drawn larger, never hidden)
        int dotCount;
        // per-frame projected quads
        readonly float[] emitX = new float[MaxEmit], emitY = new float[MaxEmit];
        readonly Color32[] emitC = new Color32[MaxEmit];
        readonly byte[] emitS = new byte[MaxEmit];
        int emitCount;
        // aggregation stamps: one per (cell, colour key)
        int[] stamp = Array.Empty<int>(), cellDot = Array.Empty<int>();
        int stampGen, cellsX, cellsZ;
        readonly Dictionary<int, Color32> ownerColor = new Dictionary<int, Color32>();

        // alert pings and under-fire detection
        struct PingMark { public float X, Z, Start; public Color32 C; }
        readonly PingMark[] pings = new PingMark[MaxPings];
        int pingNext;
        float now, underFireAt = -99f;
        int lastAlertSeen = int.MinValue;
        int[] lastUnitId = Array.Empty<int>(), lastUnitHp = Array.Empty<int>();
        readonly Dictionary<int, int> lastBuildingHp = new Dictionary<int, int>();
        readonly List<int> buildingGone = new List<int>();
        readonly HashSet<int> buildingSeen = new HashSet<int>();

        static readonly Color32 Unknown = new Color32(14, 18, 20, 255);
        static readonly Color32 DotBack = new Color32(6, 9, 10, 170);
        static readonly Color BezelColor = new Color(8 / 255f, 12 / 255f, 14 / 255f, 0.80f);
        static readonly Color AccentDim = new Color(226 / 255f, 182 / 255f, 96 / 255f, 0.35f);
        static readonly Color FootColor = new Color(1f, 236 / 255f, 180 / 255f, 0.95f);
        static readonly Color FootFill = new Color(1f, 236 / 255f, 180 / 255f, 0.10f);
        static readonly Color32 PingAlert = new Color32(242, 116, 96, 255);   // --se-bad
        static readonly Color32 PingFire = new Color32(240, 188, 86, 255);    // --se-warn
        static readonly Color ContestedColor = new Color(0.95f, 0.26f, 0.2f, 1f);

        /// <summary>The camera footprint on the ground, as map (x, z) of the four screen corners.</summary>
        public Func<Vector2[]> ViewCorners;
        /// <summary>Move the camera to map (x, z).</summary>
        public Action<float, float> FocusMap;
        /// <summary>Right-click on the map: order the selection to map (x, z); the flag queues (Shift).</summary>
        public Action<float, float, bool> OrderAt;
        /// <summary>One of our units or buildings started taking damage at map (x, z) (at most every 2.5 s; also pinged).</summary>
        public Action<float, float> UnderAttack;

        /// <summary>
        /// The storm layer (WeatherPresenter.MinimapTexture: one texel per weather cell, north at the top, refreshed
        /// by its owner): heavy cloud a pale veil, rain blue, storms dark violet. Drawn over each terrain image as a
        /// stretched child, so it follows the scroll, the zoom and the wrap copies with no work here.
        /// </summary>
        public Texture Weather
        {
            set
            {
                for (int k = 0; k < terrain.Length; k++)
                {
                    if (weatherLayer[k] == null)
                    {
                        if (value == null) continue;
                        var img = new Image { scaleMode = ScaleMode.StretchToFill, pickingMode = PickingMode.Ignore };
                        img.AddToClassList("se-minimap__weather");
                        img.style.position = Position.Absolute;
                        img.style.left = 0; img.style.top = 0; img.style.right = 0; img.style.bottom = 0;
                        weatherLayer[k] = img;
                        terrain[k].Add(img);
                    }
                    if (weatherLayer[k].image != value) weatherLayer[k].image = value;
                    weatherLayer[k].style.display = value != null ? DisplayStyle.Flex : DisplayStyle.None;
                }
            }
        }
        readonly Image[] weatherLayer = new Image[3];

        /// <summary>Repaint the storm layer after its texture changed.</summary>
        public void WeatherChanged() { foreach (var img in weatherLayer) img?.MarkDirtyRepaint(); }

        /// <summary>True while the circle shows the local section around the camera instead of the whole map.</summary>
        public bool Zoomed => zoomed;

        /// <summary>Z: switch between the whole map (default) and the local view around the camera.</summary>
        public void ToggleZoom() { zoomed = !zoomed; zoomDirty = true; }

        /// <summary>The disc's outer diameter including the bezel (panel units; SE.Minimap.uss places it at 240).</summary>
        public const float Diameter = Outer;

        /// <summary>
        /// The rightmost x of the bezel's outer circle over the horizontal band [<paramref name="top"/>,
        /// <paramref name="bottom"/>] (both measured from the minimap's top edge), relative to its left edge:
        /// r + sqrt(r² − dy²) with dy the band's distance from the centre row (0 when it straddles it). Things
        /// docked to the right of the disc (the console's resource bars) start here plus a gap, so they follow
        /// the chord instead of overlapping the bezel. A band clear of the disc returns 0.
        /// </summary>
        public static float RightEdgeOver(float top, float bottom)
        {
            float r = Outer * .5f;
            float dy = top > r ? top - r : bottom < r ? r - bottom : 0f;
            return dy >= r ? 0f : r + Mathf.Sqrt(r * r - dy * dy);
        }

        public Minimap(ClientSession s)
        {
            session = s;
            AddToClassList("se-minimap");
            var sheet = Resources.Load<StyleSheet>("UI/SE.Minimap");
            if (sheet != null) styleSheets.Add(sheet);
            // the stylesheet owns the look; these keep the geometry right even before it loads
            style.position = Position.Absolute;
            style.width = Outer; style.height = Outer;
            pickingMode = PickingMode.Position;

            clip = new VisualElement { pickingMode = PickingMode.Ignore };
            clip.AddToClassList("se-minimap__clip");
            clip.style.position = Position.Absolute;
            clip.style.left = Bezel; clip.style.top = Bezel;
            clip.style.width = Inner; clip.style.height = Inner;
            clip.style.overflow = Overflow.Hidden;
            Add(clip);
            for (int k = 0; k < terrain.Length; k++)
            {
                var img = new Image { scaleMode = ScaleMode.StretchToFill, pickingMode = PickingMode.Ignore };
                img.AddToClassList("se-minimap__terrain");
                img.style.position = Position.Absolute;
                img.style.left = 0; img.style.top = 0;   // placed by translate (it follows the camera in the local view)
                img.usageHints = UsageHints.DynamicTransform;
                img.style.display = DisplayStyle.None;
                terrain[k] = img;
                clip.Add(img);
            }
            storms = Layer("se-minimap__storms");
            storms.generateVisualContent += DrawStorms;
            clip.Add(storms);
            dots = Layer("se-minimap__dots");
            dots.generateVisualContent += DrawDots;
            clip.Add(dots);
            marks = Layer("se-minimap__marks");
            marks.generateVisualContent += DrawMarks;
            clip.Add(marks);
            bezel = Layer("se-minimap__bezel");
            bezel.generateVisualContent += DrawBezel;
            Add(bezel);

            RegisterCallback<PointerDownEvent>(OnDown);
            RegisterCallback<PointerMoveEvent>(OnMove);
            RegisterCallback<PointerUpEvent>(OnUp);
            RegisterCallback<PointerCaptureOutEvent>(_ => dragging = false);
        }

        static VisualElement Layer(string cls)
        {
            var e = new VisualElement { pickingMode = PickingMode.Ignore };
            e.AddToClassList(cls);
            e.style.position = Position.Absolute;
            e.style.left = 0; e.style.top = 0; e.style.right = 0; e.style.bottom = 0;
            return e;
        }

        // ---------------------------------------------------------------- input

        /// <summary>Only the disc picks: the square's corners stay clickable for the world below.</summary>
        public override bool ContainsPoint(Vector2 localPoint)
        {
            float r = Outer * 0.5f, dx = localPoint.x - r, dy = localPoint.y - r;
            return dx * dx + dy * dy <= r * r;
        }

        /// <summary>Panel-local pointer → clip-local point; false outside the inner circle.</summary>
        static bool Inside(Vector2 local, out Vector2 c)
        {
            c = new Vector2(local.x - Bezel, local.y - Bezel);
            float dx = c.x - InnerR, dy = c.y - InnerR;
            return dx * dx + dy * dy <= InnerR * InnerR;
        }

        bool ToMap(Vector2 c, out float x, out float z)
        {
            x = z = 0;
            var g = grid;
            if (g == null || !session.World.Ready || scale <= 0) return false;
            x = (c.x - mapLeft) / scale;
            z = (c.y - mapTop) / scale;
            if (g.Wrap) x = g.BaseX(x);
            else x = Mathf.Clamp(x, 0f, g.Period - 0.01f);
            z = Mathf.Clamp(z, 0f, 1.5f * (g.H - 1));
            return true;
        }

        void OnDown(PointerDownEvent e)
        {
            if (!Inside(e.localPosition, out var c)) return;
            if (e.button == 0)
            {
                dragging = true;
                this.CapturePointer(e.pointerId);
                Jump(c);
                e.StopPropagation();
            }
            else if (e.button == 1)
            {
                if (OrderAt != null && ToMap(c, out float x, out float z)) OrderAt(x, z, e.shiftKey);
                e.StopPropagation();
            }
        }

        void OnMove(PointerMoveEvent e)
        {
            if (!dragging) return;
            Jump(new Vector2(e.localPosition.x - Bezel, e.localPosition.y - Bezel));
        }

        void OnUp(PointerUpEvent e)
        {
            if (e.button != 0 || !dragging) return;
            dragging = false;
            if (this.HasPointerCapture(e.pointerId)) this.ReleasePointer(e.pointerId);
        }

        void Jump(Vector2 c)
        {
            if (FocusMap == null || !ToMap(c, out float x, out float z)) return;
            FocusMap(x, z);
        }

        // ---------------------------------------------------------------- pings

        /// <summary>An alert ping (expanding ring) at a tile. Repeats at the same spot within a second merge.</summary>
        public void Ping(int tile)
        {
            var g = grid;
            if (g == null || tile < 0 || tile >= g.N) return;
            AddPing(g.CenterX(tile), g.CenterZ(tile), PingAlert);
        }

        void AddPing(float x, float z, Color32 c)
        {
            var g = grid;
            for (int i = 0; i < MaxPings; i++)
            {
                ref var p = ref pings[i];
                if (p.Start <= 0 || now - p.Start > 1f) continue;
                float dx = g != null ? g.DxWrap(p.X, x) : x - p.X, dz = z - p.Z;
                if (dx * dx + dz * dz < 9f) return;
            }
            pings[pingNext] = new PingMark { X = x, Z = z, Start = Mathf.Max(now, 0.001f), C = c };
            pingNext = (pingNext + 1) % MaxPings;
        }

        // ---------------------------------------------------------------- per frame

        public void Tick(float time)
        {
            now = time;
            var w = session.World;
            if (!w.Ready) return;
            var g = w.Grid;
            if (g != grid) SetGrid(g);

            // alerts the session marked (critical / major notes with a place)
            if (lastAlertSeen == int.MinValue) lastAlertSeen = session.LastAlertTile;
            else if (session.LastAlertTile != lastAlertSeen)
            {
                lastAlertSeen = session.LastAlertTile;
                if (lastAlertSeen >= 0) Ping(lastAlertSeen);
            }

            // camera footprint and (wrapping maps) the centre the circle follows
            bool hadFoot = hasFoot, footMoved = false;
            hasFoot = false;
            var corners = ViewCorners?.Invoke();
            if (corners != null && corners.Length == 4)
            {
                float sum = 0, sumZ = corners[0].y;
                for (int k = 1; k < 4; k++) { sum += g.DxWrap(corners[0].x, corners[k].x); sumZ += corners[k].y; }
                float cx = corners[0].x + sum * 0.25f;
                focusX = g.Wrap ? g.BaseX(cx) : cx;
                focusZ = sumZ * 0.25f;
                for (int k = 0; k < 4; k++)
                {
                    if ((foot[k] - corners[k]).sqrMagnitude > 1e-6f) footMoved = true;
                    foot[k] = corners[k];
                }
                hasFoot = true;
            }
            if (hasFoot != hadFoot) footMoved = true;
            bool rescaled = false;
            if (zoomDirty) { zoomDirty = false; gatherAt = 0; }
            float zdt = zoomTickAt < 0f ? 0f : Mathf.Clamp(time - zoomTickAt, 0f, .1f);
            zoomTickAt = time;
            float zoomTarget = zoomed ? 1f : 0f;
            if (zoomT != zoomTarget)
            {
                zoomT = App.GameSettings.ReduceUiMotion ? zoomTarget : Mathf.MoveTowards(zoomT, zoomTarget, zdt / ZoomSeconds);
                ApplyScale();   // terrain size and cells follow the eased scale (cells were sized once for the closest view)
                rescaled = true;
            }
            // whole map: the map fills the circle around its centre and slides toward the camera only when the
            // footprint centre would leave the circle (wrapping maps follow the camera sideways); local view:
            // centred on the camera
            float viewX = focusX, viewZ = focusZ;
            float ze = ZoomEase;
            if (ze < 1f)
            {
                float midX = g.Wrap ? focusX : g.Period * 0.5f, midZ = g.H * 0.75f;
                float dx = g.Wrap ? 0f : focusX - midX, dz = focusZ - midZ;
                float reach = Mathf.Max(1f, InnerR - FollowMargin) / Mathf.Max(1e-4f, scale);
                float dist = Mathf.Sqrt(dx * dx + dz * dz);
                float slide = dist > reach ? 1f - reach / dist : 0f;
                // blended toward the camera-centred local view while the zoom eases
                viewX = Mathf.Lerp(g.Wrap ? focusX : Mathf.Clamp(midX + dx * slide, 0f, g.Period), focusX, ze);
                viewZ = Mathf.Lerp(Mathf.Clamp(midZ + dz * slide, 0f, g.H * 1.5f), focusZ, ze);
            }
            float left = InnerR - viewX * scale;
            float top = InnerR - viewZ * scale;
            bool scrolled = rescaled || Mathf.Abs(left - mapLeft) > 0.01f || Mathf.Abs(top - mapTop) > 0.01f;
            mapLeft = left; mapTop = top;
            PlaceTerrain(g.Wrap);

            bool gathered = false;
            if (time >= gatherAt)
            {
                gatherAt = time + 0.125f;
                Gather(w);
                gathered = true;
            }
            if (time >= drawAt)
            {
                drawAt = time + 0.5f;
                Redraw(w);
            }
            // regenerate the meshes only when they change: dots move at the 8 Hz gather (or when a wrapping map
            // scrolls); marks also follow the camera footprint and animate only while a ping or contest pulses
            if (gathered || scrolled) dots.MarkDirtyRepaint();
            if (gathered || scrolled || footMoved || anyContested || AnyPing()) marks.MarkDirtyRepaint();
            // storm systems turn and pulse: redrawn every frame while one is shown (a few quads and short paths)
            int stormCount = Storms != null ? Storms.Count : 0;
            if (stormCount > 0 || stormsShown) storms.MarkDirtyRepaint();
            stormsShown = stormCount > 0;
        }

        bool anyContested;

        bool AnyPing()
        {
            for (int i = 0; i < MaxPings; i++) if (pings[i].Start > 0) return true;
            return false;
        }

        void SetGrid(HexGrid g)
        {
            grid = g;
            float depth = g.H * 1.5f;
            // the map fills the circle: its shorter side spans the inner disc (no dark corners); the clipped
            // corners are reached by sliding toward the camera (Tick)
            baseScale = Inner / Mathf.Max(1f, Mathf.Min(g.Period, depth));
            focusX = g.Period * 0.5f;
            focusZ = depth * 0.5f;
            // aggregation cells sized once for the closest view, so toggling the local view never allocates
            int maxCells = (Mathf.CeilToInt(g.Period * baseScale * ZoomFactor / CellPx) + 1) * (Mathf.CeilToInt(depth * baseScale * ZoomFactor / CellPx) + 1) * 8;
            if (stamp.Length < maxCells) { stamp = new int[maxCells]; cellDot = new int[maxCells]; }
            else Array.Clear(stamp, 0, stamp.Length);
            stampGen = 0;
            dotCount = 0;
            for (int i = 0; i < MaxPings; i++) pings[i] = default;
            lastBuildingHp.Clear();
            Array.Clear(lastUnitId, 0, lastUnitId.Length);
            lastAlertSeen = int.MinValue;
            drawAt = gatherAt = 0;

            if (tex == null || tex.width != g.W || tex.height != g.H)
            {
                if (tex != null) UnityEngine.Object.Destroy(tex);
                tex = new Texture2D(g.W, g.H, TextureFormat.RGBA32, false)
                {
                    filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp, name = "SE minimap",
                };
                px = new Color32[g.N];
            }
            for (int k = 0; k < terrain.Length; k++)
            {
                var img = terrain[k];
                img.image = tex;
                // wrapping maps draw the neighbouring images too so the seam never shows
                img.style.display = k == 1 || g.Wrap ? DisplayStyle.Flex : DisplayStyle.None;
            }
            ApplyScale();
            mapLeft = (Inner - mapW) * 0.5f;
            mapTop = (Inner - mapH) * 0.5f;
        }

        /// <summary>The whole-map or local-view scale: sizes the terrain images and the aggregation grid (on a toggle only).</summary>
        void ApplyScale()
        {
            var g = grid;
            if (g == null) return;
            scale = baseScale * Mathf.Lerp(1f, ZoomFactor, ZoomEase);
            mapW = g.Period * scale;
            mapH = g.H * 1.5f * scale;
            cellsX = Mathf.CeilToInt(mapW / CellPx) + 1;
            cellsZ = Mathf.CeilToInt(mapH / CellPx) + 1;
            if (cellsX * cellsZ * 8 > stamp.Length) { stamp = new int[cellsX * cellsZ * 8]; cellDot = new int[stamp.Length]; stampGen = 0; }
            for (int k = 0; k < terrain.Length; k++)
            {
                terrain[k].style.width = mapW;
                terrain[k].style.height = mapH;
                terrainLeft[k] = float.NaN;
            }
            terrainTop = float.NaN;
        }

        void PlaceTerrain(bool wrap)
        {
            bool topMoved = !(Mathf.Abs(mapTop - terrainTop) < 0.01f);   // NaN never compares, so the first call sets it
            if (topMoved) terrainTop = mapTop;
            for (int k = 0; k < terrain.Length; k++)
            {
                if (!wrap && k != 1) continue;
                float left = mapLeft + (k - 1) * mapW;
                if (!topMoved && Mathf.Abs(left - terrainLeft[k]) < 0.01f) continue;
                terrainLeft[k] = left;
                terrain[k].style.translate = new Translate(left, mapTop);
            }
        }

        // ---------------------------------------------------------------- texture (2 Hz)

        void Redraw(WorldModel w)
        {
            var g = w.Grid;
            if (px == null || px.Length != g.N) return;
            int lastOwner = int.MinValue;
            Color civ = default;
            for (int i = 0; i < g.N; i++)
            {
                int q = i % g.W, r = i / g.W;
                int p = (g.H - 1 - r) * g.W + q;   // texture rows run bottom-up; north (z = 0) at the top
                if (w.Known[i] == 0) { px[p] = Unknown; continue; }
                Color c = Terrain(w, i);
                if (w.IsUrban(i)) c = Color.Lerp(c, new Color(0.82f, 0.8f, 0.74f), 0.45f);
                int owner = w.Owner[i];
                if (owner >= 0)
                {
                    if (owner != lastOwner) { civ = Rel(owner); lastOwner = owner; }
                    bool border = false;
                    for (int d = 0; d < 6 && !border; d++) { int n = g.Nb[i * 6 + d]; border = n >= 0 && w.Owner[n] != owner; }
                    c = Color.Lerp(c, civ, border ? 0.85f : 0.25f);
                }
                if (!w.IsVisible(i)) c *= 0.55f;   // known but not seen now
                c.a = 1f;
                px[p] = c;
            }
            tex.SetPixels32(px);
            tex.Apply(false, false);
            for (int k = 0; k < terrain.Length; k++) terrain[k].MarkDirtyRepaint();
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

        // ---------------------------------------------------------------- colours

        /// <summary>Relation colour (sRGB) of an owner: you blue, team teal, enemies their hue, unowned sand.</summary>
        Color32 Rel(int owner)
        {
            if (owner < 0) return ClientSession.PaletteNeutral;
            if (owner == session.CivId) return ClientSession.PaletteFriendly;
            if (ownerColor.TryGetValue(owner, out var known)) return known;
            var c = session.CivColor(owner);
            Color32 col = new Color(c.x, c.y, c.z).gamma;
            ownerColor[owner] = col;
            return col;
        }

        static bool IsFieldDefense(string type)
        {
            switch (type)
            {
                case "barricade": case "guard_post": case "bunker": case "turret": case "aa_battery":
                case "sensor_post": case "repair_point": case "artillery_post": case "fort": case "city_turret":
                    return true;
                default: return false;
            }
        }

        // ---------------------------------------------------------------- dots (8 Hz gather)

        void Gather(WorldModel w)
        {
            var g = w.Grid;
            ownerColor.Clear();   // the relation table may have changed (observer follow)
            dotCount = 0;
            if (++stampGen == int.MaxValue) { Array.Clear(stamp, 0, stamp.Length); stampGen = 1; }
            int me = session.CivId;
            bool underFire = false;
            float fireX = 0, fireZ = 0;

            // buildings first (drawn underneath units)
            buildingSeen.Clear();
            int buildings = 0;
            foreach (var pair in session.Structures.Buildings)
            {
                var b = pair.Value;
                if (b.Tile < 0 || b.Tile >= g.N) continue;
                float x = b.HasPosition ? b.X : g.CenterX(b.Tile), z = b.HasPosition ? b.Z : g.CenterZ(b.Tile);
                if (b.Owner == me && me >= 0)
                {
                    buildingSeen.Add(b.Id);
                    if (lastBuildingHp.TryGetValue(b.Id, out int hp) && b.Hp < hp && !underFire) { underFire = true; fireX = x; fireZ = z; }
                    lastBuildingHp[b.Id] = b.Hp;
                }
                if (buildings >= MaxBuildingDots) continue;
                var c = Rel(b.Owner);
                if (b.Memory) c.a = 140;
                if (AddDot(g, x, z, c, (byte)(IsFieldDefense(b.Type) ? 3 : 4), b.Owner, false)) buildings++;
            }
            buildingGone.Clear();
            foreach (var id in lastBuildingHp.Keys) if (!buildingSeen.Contains(id)) buildingGone.Add(id);
            for (int i = 0; i < buildingGone.Count; i++) lastBuildingHp.Remove(buildingGone[i]);

            // units: own always, others only where we see them now
            var units = session.Units;
            if (lastUnitId.Length < units.Records.Length)
            {
                Array.Resize(ref lastUnitId, units.Records.Length);
                Array.Resize(ref lastUnitHp, units.Records.Length);
            }
            int unitDots = 0;
            for (int s = 0; s < units.SlotCount && s < units.Records.Length; s++)
            {
                ref var u = ref units.Records[s];
                if (!u.InUse || u.Tile < 0 || u.Tile >= g.N) { lastUnitId[s] = 0; continue; }
                bool own = u.Owner == me && me >= 0;
                if (!own && !w.IsVisible(u.Tile)) continue;
                units.Position(s, out float x, out float z);
                if (own)
                {
                    if (lastUnitId[s] == u.Id + 1 && u.Hp < lastUnitHp[s] && !underFire) { underFire = true; fireX = x; fireZ = z; }
                    lastUnitId[s] = u.Id + 1;
                    lastUnitHp[s] = u.Hp;
                }
                if (unitDots >= MaxUnitDots) continue;
                if (AddDot(g, x, z, Rel(u.Owner), 3, u.Owner, true)) unitDots++;
            }

            anyContested = false;
            foreach (var pair in session.Objectives) if (pair.Value.Contested) { anyContested = true; break; }

            if (underFire && now - underFireAt > 2.5f)
            {
                underFireAt = now;
                AddPing(fireX, fireZ, PingAlert);
                UnderAttack?.Invoke(fireX, fireZ);
            }
        }

        /// <summary>
        /// Add a dot; units of one owner sharing a 4 px cell merge into one dot that grows with the count (a
        /// platoon reads as a bigger mark, not as a single unit). False when merged or full.
        /// </summary>
        bool AddDot(HexGrid g, float x, float z, Color32 c, byte size, int owner, bool aggregate)
        {
            if (dotCount >= MaxDots) return false;
            x = g.Wrap ? g.BaseX(x) : Mathf.Clamp(x, 0, g.Period);
            z = Mathf.Clamp(z, 0, g.H * 1.5f);
            if (aggregate)
            {
                int cx = Mathf.Clamp((int)(x * scale / CellPx), 0, cellsX - 1);
                int cz = Mathf.Clamp((int)(z * scale / CellPx), 0, cellsZ - 1);
                int key = ((cz * cellsX + cx) << 3) | ((owner + 1) & 7);
                if (key < 0 || key >= stamp.Length) return false;
                if (stamp[key] == stampGen)
                {
                    int at = cellDot[key];
                    if (at >= 0 && at < dotCount && dotN[at] < ushort.MaxValue) dotN[at]++;
                    return false;
                }
                stamp[key] = stampGen;
                cellDot[key] = dotCount;
            }
            dotX[dotCount] = x; dotZ[dotCount] = z; dotC[dotCount] = c; dotSize[dotCount] = size; dotN[dotCount] = 1;
            dotCount++;
            return true;
        }

        /// <summary>Drawn size of a dot: the base size, one pixel more at 2, 4, 8 and 16 merged units.</summary>
        int DotPixels(int i)
        {
            int n = dotN[i], s = dotSize[i];
            if (n >= 2) s++;
            if (n >= 4) s++;
            if (n >= 8) s++;
            if (n >= 16) s++;
            return s;
        }

        // ---------------------------------------------------------------- drawing

        /// <summary>Project map x to every on-circle clip x (wrap copies); returns how many were written.</summary>
        int ProjectX(float x, float margin, out float a, out float b)
        {
            a = b = 0;
            float baseX = mapLeft + x * scale;
            int n = 0;
            int from = grid != null && grid.Wrap ? -1 : 0, to = grid != null && grid.Wrap ? 1 : 0;
            for (int k = from; k <= to; k++)
            {
                float sx = baseX + k * mapW;
                if (sx < -margin || sx > Inner + margin) continue;
                if (n == 0) a = sx; else b = sx;
                if (++n == 2) break;
            }
            return n;
        }

        static bool InCircle(float x, float y, float margin)
        {
            float dx = x - InnerR, dy = y - InnerR, r = InnerR + margin;
            return dx * dx + dy * dy <= r * r;
        }

        void DrawDots(MeshGenerationContext ctx)
        {
            if (grid == null || dotCount == 0) return;
            emitCount = 0;
            for (int i = 0; i < dotCount && emitCount < MaxEmit; i++)
            {
                float y = mapTop + dotZ[i] * scale;
                int n = ProjectX(dotX[i], 4, out float a, out float b);
                for (int k = 0; k < n && emitCount < MaxEmit; k++)
                {
                    float x = k == 0 ? a : b;
                    if (!InCircle(x, y, 3)) continue;
                    emitX[emitCount] = x; emitY[emitCount] = y; emitC[emitCount] = dotC[i]; emitS[emitCount] = (byte)DotPixels(i);
                    emitCount++;
                }
            }
            if (emitCount == 0) return;
            // two quads a dot: a dark backing one pixel wider all round, then the colour
            var mesh = ctx.Allocate(emitCount * 8, emitCount * 12);
            ushort v = 0;
            for (int i = 0; i < emitCount; i++)
            {
                float h = emitS[i] * 0.5f;
                var back = DotBack;
                back.a = (byte)(DotBack.a * emitC[i].a / 255);
                Quad(mesh, ref v, emitX[i], emitY[i], h + 1f, back);
            }
            for (int i = 0; i < emitCount; i++) Quad(mesh, ref v, emitX[i], emitY[i], emitS[i] * 0.5f, emitC[i]);
        }

        static void Quad(MeshWriteData m, ref ushort v, float x, float y, float h, Color32 c)
        {
            m.SetNextVertex(new Vertex { position = new Vector3(x - h, y - h, Vertex.nearZ), tint = c });
            m.SetNextVertex(new Vertex { position = new Vector3(x + h, y - h, Vertex.nearZ), tint = c });
            m.SetNextVertex(new Vertex { position = new Vector3(x + h, y + h, Vertex.nearZ), tint = c });
            m.SetNextVertex(new Vertex { position = new Vector3(x - h, y + h, Vertex.nearZ), tint = c });
            m.SetNextIndex(v); m.SetNextIndex((ushort)(v + 1)); m.SetNextIndex((ushort)(v + 2));
            m.SetNextIndex(v); m.SetNextIndex((ushort)(v + 2)); m.SetNextIndex((ushort)(v + 3));
            v += 4;
        }

        void DrawMarks(MeshGenerationContext ctx)
        {
            var g = grid;
            if (g == null || !session.World.Ready) return;
            var p = ctx.painter2D;
            int me = session.CivId;
            float pulse = 0.5f + 0.5f * Mathf.Sin(now * 6f);

            // objectives and bases, shape-coded
            foreach (var pair in session.Objectives)
            {
                var site = pair.Value;
                float sx = site.X, sz = site.Z;
                if (sx == 0 && sz == 0 && site.Tile >= 0 && site.Tile < g.N) { sx = g.CenterX(site.Tile); sz = g.CenterZ(site.Tile); }
                if (g.Wrap) sx = g.BaseX(sx);
                float y = mapTop + sz * scale;
                int n = ProjectX(sx, 12, out float a, out float b);
                float alpha = site.Memory ? 0.6f : 1f;
                for (int k = 0; k < n; k++)
                {
                    var c = new Vector2(k == 0 ? a : b, y);
                    if (!InCircle(c.x, c.y, 10)) continue;
                    DrawSite(p, site, c, me, alpha);
                    if (site.Contested)
                    {
                        p.strokeColor = new Color(ContestedColor.r, ContestedColor.g, ContestedColor.b, 0.45f + 0.5f * pulse);
                        p.lineWidth = 1.5f;
                        p.BeginPath(); p.Arc(c, 7.5f + 2f * pulse, 0f, 360f); p.ClosePath(); p.Stroke();
                    }
                }
            }

            // camera footprint: the ground under the screen's corners (a trapezoid under a perspective camera),
            // a faint fill so the view reads at a glance, then the outline
            if (hasFoot)
            {
                float refX = g.Wrap || zoomT > 0f ? focusX : 0f;
                for (int pass = 0; pass < 2; pass++)
                {
                    p.BeginPath();
                    for (int k = 0; k < 4; k++)
                    {
                        float x = g.Wrap ? refX + g.DxWrap(refX, foot[k].x) : foot[k].x;
                        var v = new Vector2(mapLeft + x * scale, mapTop + Mathf.Clamp(foot[k].y, -g.H, g.H * 2.5f) * scale);
                        if (k == 0) p.MoveTo(v); else p.LineTo(v);
                    }
                    p.ClosePath();
                    if (pass == 0) { p.fillColor = FootFill; p.Fill(); }
                    else { p.strokeColor = FootColor; p.lineWidth = 1.5f; p.lineJoin = LineJoin.Round; p.Stroke(); }
                }
            }

            // alert pings: an expanding ring 12 → 36 across over 1.2 s
            for (int i = 0; i < MaxPings; i++)
            {
                ref var ping = ref pings[i];
                if (ping.Start <= 0) continue;
                float t = (now - ping.Start) / 1.2f;
                if (t < 0f || t >= 1f) { if (t >= 1f) ping.Start = 0; continue; }
                float y = mapTop + ping.Z * scale;
                int n = ProjectX(g.Wrap ? g.BaseX(ping.X) : ping.X, 16, out float a, out float b);
                Color col = ping.C;
                for (int k = 0; k < n; k++)
                {
                    var c = new Vector2(k == 0 ? a : b, y);
                    p.strokeColor = new Color(col.r, col.g, col.b, 1f - t);
                    p.lineWidth = 2f;
                    p.BeginPath(); p.Arc(c, 6f + 12f * t, 0f, 360f); p.ClosePath(); p.Stroke();
                    p.fillColor = new Color(col.r, col.g, col.b, 0.9f * (1f - t));
                    p.BeginPath(); p.Arc(c, 2f, 0f, 360f); p.ClosePath(); p.Fill();
                }
            }
        }

        void DrawSite(Painter2D p, in ObjectiveSite site, Vector2 c, int me, float alpha)
        {
            Color col = Rel(site.Owner);
            col.a = alpha;
            if (site.IsBase && site.Owner >= 0)
            {
                bool friendly = site.Owner == me && me >= 0 || !session.IsHostile(site.Owner);
                if (friendly)
                {
                    // own (blue) or allied (teal) base: 10 px circle, white outline
                    p.fillColor = col;
                    p.BeginPath(); p.Arc(c, 5f, 0f, 360f); p.ClosePath(); p.Fill();
                    p.strokeColor = new Color(1f, 1f, 1f, alpha);
                    p.lineWidth = 1f;
                    p.BeginPath(); p.Arc(c, 5.5f, 0f, 360f); p.ClosePath(); p.Stroke();
                }
                else
                {
                    // enemy base: diamond (a square turned 45°) in that enemy's hue
                    const float h = 6.5f;
                    p.fillColor = col;
                    p.BeginPath();
                    p.MoveTo(new Vector2(c.x, c.y - h)); p.LineTo(new Vector2(c.x + h, c.y));
                    p.LineTo(new Vector2(c.x, c.y + h)); p.LineTo(new Vector2(c.x - h, c.y));
                    p.ClosePath(); p.Fill();
                    p.strokeColor = new Color(0.04f, 0.05f, 0.06f, 0.9f * alpha);
                    p.lineWidth = 1f;
                    p.Stroke();
                }
            }
            else if (site.IsBase)
            {
                // neutral ruin: 7 px hollow sand ring
                p.strokeColor = col;
                p.lineWidth = 1.5f;
                p.BeginPath(); p.Arc(c, 3.5f, 0f, 360f); p.ClosePath(); p.Stroke();
            }
            else
            {
                // capturable outpost: 6 px hollow ring in its holder's colour
                p.strokeColor = col;
                p.lineWidth = 1.25f;
                p.BeginPath(); p.Arc(c, 3f, 0f, 360f); p.ClosePath(); p.Stroke();
            }
        }

        void DrawBezel(MeshGenerationContext ctx)
        {
            var p = ctx.painter2D;
            var centre = new Vector2(Outer * 0.5f, Outer * 0.5f);
            p.strokeColor = BezelColor;
            p.lineWidth = Bezel;
            p.BeginPath(); p.Arc(centre, Outer * 0.5f - Bezel * 0.5f, 0f, 360f); p.ClosePath(); p.Stroke();
            p.strokeColor = AccentDim;
            p.lineWidth = 1f;
            p.BeginPath(); p.Arc(centre, InnerR + 0.5f, 0f, 360f); p.ClosePath(); p.Stroke();
            // north tick
            p.fillColor = new Color(AccentDim.r, AccentDim.g, AccentDim.b, 0.9f);
            p.BeginPath();
            p.MoveTo(new Vector2(centre.x, 1.5f));
            p.LineTo(new Vector2(centre.x + 3.5f, Bezel - 1f));
            p.LineTo(new Vector2(centre.x - 3.5f, Bezel - 1f));
            p.ClosePath(); p.Fill();
        }

        // ---------------------------------------------------------------- storm systems

        /// <summary>
        /// The live storm systems (WeatherPresenter.Systems). Each is drawn every frame, under the dots and marks,
        /// as a silhouette in its real shape (a hurricane's spiral bands, central dense overcast and clear eye; a
        /// squall line's bowed convective band, shelf and trailing deck) from a texture built once per kind: a pale
        /// cloud fill with a dark rim and a soft dark halo, so it reads over any terrain or territory colour while
        /// the ground still shows through. A hurricane turns with its flow and carries the tropical-cyclone symbol
        /// at its eye; a squall line carries front pips along its leading edge and a flickering bolt; both show
        /// their forecast track (amber dots every 20 s for four minutes, an arrowhead at the end).
        /// </summary>
        public SE.Runtime.Effects.StormSystems Storms;
        bool stormsShown;
        Texture2D hurricaneTex, squallTex;
        const int HurRes = 192, SqW = 224, SqH = 144;
        const float HurExtent = 1.12f;                         // the hurricane quad spans ±this × radius
        const float SqU = 1.1f, SqB0 = -1.0f, SqB1 = 0.4f;     // squall quad (× radius): along the line ±SqU, along the motion SqB0..SqB1
        static readonly Color StormInk = new Color(.08f, .09f, .15f, 1f);
        static readonly Color StormTrack = new Color(1f, .84f, .42f, 1f);
        static readonly Color StormPip = new Color(.46f, .34f, .86f, 1f);

        void DrawStorms(MeshGenerationContext ctx)
        {
            var g = grid; var sys = Storms;
            if (g == null || sys == null || sys.Count == 0 || !session.World.Ready) return;
            if (hurricaneTex == null) hurricaneTex = BuildStormTex(true);
            if (squallTex == null) squallTex = BuildStormTex(false);
            var p = ctx.painter2D;
            bool still = App.GameSettings.ReduceUiMotion;
            float pulse = still ? .5f : .5f + .5f * Mathf.Sin(now * 2.2f);
            for (int i = 0; i < sys.Count; i++)
            {
                var s = sys[i];
                if (s.Intensity < .02f || s.Radius <= 0) continue;
                float fade = Mathf.Clamp01(s.Intensity * 2.5f);
                float R = Mathf.Max(s.Radius * scale, 14f);
                float y = mapTop + s.Z * scale;
                int n = ProjectX(g.Wrap ? g.BaseX(s.X) : s.X, R * 1.5f, out float a, out float b);
                for (int k = 0; k < n; k++)
                {
                    var c = new Vector2(k == 0 ? a : b, y);
                    if (!InCircle(c.x, c.y, R * 1.5f)) continue;
                    var tint = new Color(1f, 1f, 1f, fade * (.9f + .1f * pulse));
                    if (s.Hurricane)
                    {
                        float turn = still ? 0f : -s.Spin * now * .35f;   // counter-clockwise on screen for spin +1
                        var ex = new Vector2(Mathf.Cos(turn), Mathf.Sin(turn)) * (R * HurExtent);
                        var ey = new Vector2(-Mathf.Sin(turn), Mathf.Cos(turn)) * (R * HurExtent);
                        Quad(ctx, hurricaneTex, c - ex - ey, c + ex - ey, c + ex + ey, c - ex + ey, tint, s.Spin < 0);
                        StormTrackMarks(p, sys, i, c, fade);
                        HurricaneGlyph(p, c, turn, s.Spin < 0 ? -1f : 1f, fade, pulse);
                    }
                    else
                    {
                        var f = new Vector2(Mathf.Cos(s.Heading), Mathf.Sin(s.Heading));
                        var l = new Vector2(-f.y, f.x);
                        Vector2 At(float u, float bb) => c + (l * u + f * bb) * R;
                        Quad(ctx, squallTex, At(-SqU, SqB1), At(SqU, SqB1), At(SqU, SqB0), At(-SqU, SqB0), tint, false);
                        StormTrackMarks(p, sys, i, c, fade);
                        // front pips along the leading edge, pointing where it is going
                        for (int q = -2; q <= 2; q++)
                        {
                            float u = q * .28f, e0 = .2f * (1 - u * u) - .06f;
                            var o = At(u, e0);
                            float w = Mathf.Clamp(R * .07f, 2.6f, 4.5f);
                            var tip = o + f * (w * 1.5f);
                            p.BeginPath(); p.MoveTo(o - l * w); p.LineTo(tip); p.LineTo(o + l * w); p.ClosePath();
                            p.fillColor = new Color(StormPip.r, StormPip.g, StormPip.b, .95f * fade); p.Fill();
                            p.strokeColor = new Color(StormInk.r, StormInk.g, StormInk.b, .8f * fade); p.lineWidth = 1f; p.Stroke();
                        }
                        // a bolt in the middle of the convective line, flickering
                        float flick = still ? 1f : Mathf.Sin(now * 9.3f + i) > .55f ? .55f : 1f;
                        BoltGlyph(p, At(0f, .2f - .08f - .07f), Mathf.Clamp(R * .12f, 5f, 8f), fade * flick);
                    }
                }
            }
        }

        // a textured quad: TL, TR, BR, BL on screen; the texture's top row at the TL–TR edge (mirrored in u if asked)
        static void Quad(MeshGenerationContext ctx, Texture2D t, Vector2 tl, Vector2 tr, Vector2 br, Vector2 bl, Color tint, bool mirror)
        {
            var mw = ctx.Allocate(4, 6, t);
            var r = mw.uvRegion;
            float u0 = mirror ? 1f : 0f, u1 = 1f - u0;
            Vector2 Uv(float u, float v) => new Vector2(r.x + u * r.width, r.y + v * r.height);
            mw.SetNextVertex(new Vertex { position = new Vector3(tl.x, tl.y, Vertex.nearZ), tint = tint, uv = Uv(u0, 1f) });
            mw.SetNextVertex(new Vertex { position = new Vector3(tr.x, tr.y, Vertex.nearZ), tint = tint, uv = Uv(u1, 1f) });
            mw.SetNextVertex(new Vertex { position = new Vector3(br.x, br.y, Vertex.nearZ), tint = tint, uv = Uv(u1, 0f) });
            mw.SetNextVertex(new Vertex { position = new Vector3(bl.x, bl.y, Vertex.nearZ), tint = tint, uv = Uv(u0, 0f) });
            mw.SetNextIndex(0); mw.SetNextIndex(1); mw.SetNextIndex(2);
            mw.SetNextIndex(0); mw.SetNextIndex(2); mw.SetNextIndex(3);
        }

        // the forecast track: amber dots every 20 s for the next four minutes (fading), an arrowhead at the end
        void StormTrackMarks(Painter2D p, SE.Runtime.Effects.StormSystems sys, int i, Vector2 c, float fade)
        {
            var s = sys[i];
            if (s.Speed <= .01f) return;
            var g = grid;
            Vector2 prev = c, last = c;
            int count = 0;
            for (int k = 1; k <= 12; k++)
            {
                if (k * 20f > sys.Remaining(i)) break;
                var at = sys.Track(i, k * 20f);
                var v = c + new Vector2(g.DxWrap(s.X, at.x), at.y - s.Z) * scale;
                float al = fade * (1f - k * .05f);
                p.fillColor = new Color(StormInk.r, StormInk.g, StormInk.b, .7f * al);
                p.BeginPath(); p.Arc(v, k % 3 == 0 ? 2.6f : 2f, 0f, 360f); p.ClosePath(); p.Fill();
                p.fillColor = new Color(StormTrack.r, StormTrack.g, StormTrack.b, al);
                p.BeginPath(); p.Arc(v, k % 3 == 0 ? 1.7f : 1.2f, 0f, 360f); p.ClosePath(); p.Fill();
                prev = last; last = v; count++;
            }
            if (count < 2) return;
            var d = last - prev;
            if (d.sqrMagnitude < 1e-4f) return;
            d.Normalize();
            var side = new Vector2(-d.y, d.x);
            var tip = last + d * 6f;
            p.BeginPath(); p.MoveTo(last + d * .5f + side * 3.5f); p.LineTo(tip); p.LineTo(last + d * .5f - side * 3.5f); p.ClosePath();
            p.fillColor = new Color(StormTrack.r, StormTrack.g, StormTrack.b, .85f * fade); p.Fill();
            p.strokeColor = new Color(StormInk.r, StormInk.g, StormInk.b, .75f * fade); p.lineWidth = 1f; p.Stroke();
        }

        // the tropical-cyclone symbol at the eye: a ring with two curved hooks, turning with the storm
        static void HurricaneGlyph(Painter2D p, Vector2 c, float turn, float spin, float fade, float pulse)
        {
            p.lineCap = LineCap.Round;
            for (int pass = 0; pass < 2; pass++)
            {
                p.strokeColor = pass == 0 ? new Color(StormInk.r, StormInk.g, StormInk.b, .85f * fade) : new Color(1f, .93f, .78f, fade);
                p.lineWidth = pass == 0 ? 3.6f : 1.8f;
                for (int h = 0; h < 2; h++)
                {
                    float b0 = turn + h * Mathf.PI;
                    // a hook from the ring outward, curling back against the flow (screen y down: +spin turns clockwise)
                    Vector2 P(float rr, float ang) => c + new Vector2(Mathf.Cos(b0 + ang), Mathf.Sin(b0 + ang)) * rr;
                    p.BeginPath();
                    p.MoveTo(P(3.6f, 0f));
                    p.BezierCurveTo(P(8f, spin * .25f), P(10.5f, spin * .95f), P(9.5f, spin * 1.55f));
                    p.Stroke();
                }
                p.BeginPath(); p.Arc(c, 3.6f, 0f, 360f); p.ClosePath(); p.Stroke();
            }
            p.fillColor = new Color(StormInk.r, StormInk.g, StormInk.b, (.55f + .3f * pulse) * fade);
            p.BeginPath(); p.Arc(c, 2.4f, 0f, 360f); p.ClosePath(); p.Fill();
        }

        // a small lightning bolt (yellow, dark rim)
        static void BoltGlyph(Painter2D p, Vector2 c, float h, float alpha)
        {
            Vector2 B(float x, float y) => c + new Vector2(x, y) * h;
            p.BeginPath();
            p.MoveTo(B(.12f, -1f)); p.LineTo(B(-.42f, .12f)); p.LineTo(B(-.04f, .12f)); p.LineTo(B(-.2f, 1f));
            p.LineTo(B(.46f, -.2f)); p.LineTo(B(.06f, -.2f)); p.LineTo(B(.3f, -1f));
            p.ClosePath();
            p.strokeColor = new Color(StormInk.r, StormInk.g, StormInk.b, .9f * alpha); p.lineWidth = 2.2f; p.lineJoin = LineJoin.Round; p.Stroke();
            p.fillColor = new Color(1f, .9f, .35f, alpha); p.Fill();
        }

        // fbm from Unity's Perlin noise (0..1), for the silhouettes' ragged edges and lumps
        static float StormFbm(float x, float y)
        {
            float s = 0, a = .5f, nrm = 0;
            for (int o = 0; o < 4; o++) { s += a * Mathf.PerlinNoise(x + o * 17.3f, y + o * 9.1f); nrm += a; a *= .5f; x *= 2.03f; y *= 2.03f; }
            return s / nrm;
        }

        static float Sm(float a, float b, float x) { float t = Mathf.Clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

        // A storm silhouette, built once per kind: density D from the system's shape (SECommon SE_SysProfile, frayed
        // by noise), then a pale cloud fill where D is high, a dark rim around it and a soft dark halo outside.
        // Hurricane: spin +1 (mirrored in u for the other hemisphere), x and y in radius units, y down.
        // Squall: x along the line (u), y along the motion (b), both in radius units.
        static Texture2D BuildStormTex(bool hurricane)
        {
            int w = hurricane ? HurRes : SqW, h = hurricane ? HurRes : SqH;
            var px = new Color32[w * h];
            var body = new Color(.95f, .96f, .985f);
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    float D, core;
                    if (hurricane)
                    {
                        float xn = (2f * (x + .5f) / w - 1f) * HurExtent, yn = (1f - 2f * (y + .5f) / h) * HurExtent;
                        float k = Mathf.Sqrt(xn * xn + yn * yn), psi = Mathf.Atan2(yn, xn);
                        float nz = StormFbm(xn * 2.6f + 11f, yn * 2.6f + 7f), n2 = StormFbm(xn * 5.5f + 3f, yn * 5.5f + 21f);
                        float eye = Sm(.05f, .085f, k);
                        float cdo = 1f - Sm(.26f, .4f, k + (nz - .5f) * .14f);
                        float sp = .5f + .5f * Mathf.Cos(2f * (psi - 1.5f * Mathf.Log(Mathf.Max(k, .05f))) + (nz - .5f) * 1.8f);
                        float arms = Sm(.48f, .8f, sp) * Sm(.2f, .34f, k) * (1f - Sm(.72f, 1.04f, k + (nz - .5f) * .22f));
                        arms *= Mathf.Lerp(1f, Sm(.32f, .58f, n2), Sm(.45f, .9f, k));   // the outer bands break up
                        D = eye * Mathf.Max(cdo, arms);
                        float wq = (k - .1f) / .05f;
                        core = Mathf.Exp(-wq * wq) * .8f + (1f - Sm(.15f, .3f, k)) * .2f;
                    }
                    else
                    {
                        float u = (2f * (x + .5f) / w - 1f) * SqU, bb = SqB0 + (y + .5f) / h * (SqB1 - SqB0);
                        float nz = StormFbm(u * 3f + 5f, bb * 3f + 13f), cells = StormFbm(u * 7f + 31f, bb * 7f + 2f);
                        float lat = 1f - Sm(.6f, 1f, Mathf.Abs(u) + (nz - .5f) * .16f);
                        float e = bb - (.2f * (1f - u * u) - .08f);
                        float c1 = (e + .07f) / .09f, c2 = (e - .01f) / .04f;
                        float conv = Mathf.Exp(-c1 * c1), shelf = Mathf.Exp(-c2 * c2);
                        float trail = e < 0 ? Mathf.Exp(e / .45f) * Sm(.02f, -.04f, e) : 0f;
                        D = lat * Mathf.Max(conv * (.7f + .6f * cells), Mathf.Max(shelf * .72f, trail * (.3f + .75f * nz)));
                        core = conv * Sm(.4f, .72f, cells) * lat;
                    }
                    float fill = Sm(.42f, .5f, D);
                    float rim = Sm(.3f, .42f, D);
                    float halo = Sm(.06f, .3f, D);
                    Color col = StormInk; float a = halo * .3f;
                    col = Color.Lerp(col, StormInk, rim); a = Mathf.Lerp(a, .85f, rim);
                    var bc = Color.Lerp(body, new Color(.56f, .55f, .72f), core);
                    col = Color.Lerp(col, bc, fill); a = Mathf.Lerp(a, .66f + .12f * core, fill);
                    px[y * w + x] = new Color(col.r, col.g, col.b, a);
                }
            var t = new Texture2D(w, h, TextureFormat.RGBA32, false) { name = hurricane ? "SE minimap hurricane" : "SE minimap squall", filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            t.SetPixels32(px);
            t.Apply(false, true);
            return t;
        }

        public void Dispose()
        {
            if (tex != null) UnityEngine.Object.Destroy(tex);
            tex = null;
            if (hurricaneTex != null) UnityEngine.Object.Destroy(hurricaneTex);
            if (squallTex != null) UnityEngine.Object.Destroy(squallTex);
            hurricaneTex = squallTex = null;
        }
    }
}
