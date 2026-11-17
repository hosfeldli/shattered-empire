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
        readonly VisualElement clip, dots, marks, bezel;
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

        /// <summary>True while the circle shows the local section around the camera instead of the whole map.</summary>
        public bool Zoomed => zoomed;

        /// <summary>Z: switch between the whole map (default) and the local view around the camera.</summary>
        public void ToggleZoom() { zoomed = !zoomed; zoomDirty = true; }

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

        public void Dispose()
        {
            if (tex != null) UnityEngine.Object.Destroy(tex);
            tex = null;
        }
    }
}
