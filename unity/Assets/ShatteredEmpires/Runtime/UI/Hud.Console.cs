using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The minimap console and the bottom-centre dock (workstream F, docs/design/hud_mockup_2026-11-16.png).
    /// Bottom-left, docked to the minimap: the slim Materials / Power / Units bars with
    /// their net rates (their left edges follow the bezel), the idle-units button, an all-production button, the local-view (Z) toggle, and the attack
    /// banner ("CINDERHOLD UNDER ATTACK · Space to jump") raised with a minimap ping on every new attack.
    /// Bottom centre: the Build (B) and Terrain (T) buttons, which toggle workstream G's radial wheels
    /// (Hud.Base.cs: ToggleBuildWheel / ToggleTerrainWheel, BuildWheelOpen / TerrainWheelOpen); the console, dock and
    /// selection panel are registered with G's RegisterWheelKeepOut so no wheel covers them. Everything is built
    /// once; text changes only when its value does; counts are refreshed four times a second.
    /// </summary>
    public sealed partial class Hud
    {
        // ------------------------------------------------------------------ dock contract with G (Hud.Base.cs)
        // G may assign these (it does, in UpdateCommandUi); when unset the dock calls ToggleBuildWheel /
        // ToggleTerrainWheel and reads BuildWheelOpen / TerrainWheelOpen directly.
        Action DockBuildPressed, DockTerrainPressed;
        Func<bool> DockBuildActive, DockTerrainActive;

        /// <summary>The console's footprint (panel units, from the bottom-left corner): wheels and markers keep clear of it.</summary>
        public const float ConsoleWidth = 420f, ConsoleHeight = 312f;
        /// <summary>The dock's footprint at the bottom centre (panel units).</summary>
        public const float DockWidth = 172f, DockHeight = 80f;

        VisualElement console, dock, attackBanner, idleButton, productionButton, zoomButton;
        Label idleCount, attackText, attackHint;
        Button dockBuild, dockTerrain;
        int idleShown = int.MinValue, productionShown = int.MinValue;
        bool zoomShown, dockBuildShown, dockTerrainShown;
        float consoleAt, attackUntil, lastAttackAt = -99f;
        Vector2 lastAttackPoint = new Vector2(float.NaN, float.NaN);
        int idleCycle;
        readonly List<int> idleIds = new List<int>(64), productionIds = new List<int>(16);

        void BuildConsole()
        {
            console = UiKit.Fx(El("se-console", root), "se-fx--up");   // eases up into place with the game interface
            console.pickingMode = PickingMode.Ignore;

            // attack banner (above the minimap, left-aligned with it)
            attackBanner = UiKit.Fx(El("se-attack-banner", console), "se-fx--left");   // slides in from the left
            attackBanner.Add(new Glyph("dot", "se-attack-dot"));
            attackText = L("", "se-attack-text", attackBanner);
            attackHint = L("", "se-attack-hint", attackBanner);
            attackText.pickingMode = PickingMode.Ignore; attackHint.pickingMode = PickingMode.Ignore;
            attackBanner.RegisterCallback<ClickEvent>(e => JumpToAlert());

            // 2026-11-19: no era badge over the minimap rim any more (the era stays in the base wheel and the Field Guide)

            // the three resource bars beside the circle
            var bars = El("se-resbars", console);
            bars.pickingMode = PickingMode.Ignore;
            AddResourceChip("materials", bars);
            AddResourceChip("energy", bars);
            AddResourceChip("command", bars);
            LayoutResourceBars();

            // idle units, all production, local view
            idleButton = new Button(SelectIdle) { text = "", focusable = false };
            idleButton.AddToClassList("se-console-round");
            idleButton.AddToClassList("se-idle-button");
            UiKit.Fx(idleButton, "se-fx--pop");
            idleButton.Add(new Glyph("person", "se-idle-glyph"));
            idleCount = L("0", "se-idle-count", idleButton);
            idleCount.pickingMode = PickingMode.Ignore;
            idleButton.tooltip = "Idle units\nClick selects every idle unit and jumps to one; click again for the next.";
            console.Add(idleButton);

            productionButton = new Button(() => SelectAllProduction()) { text = "", focusable = false };   // G's wheel then batch-queues across them
            productionButton.AddToClassList("se-console-round");
            productionButton.AddToClassList("se-production-button");
            UiKit.Fx(productionButton, "se-fx--pop");
            productionButton.Add(new IconElement("barracks", "se-console-icon"));
            productionButton.tooltip = "All production\nSelect every production building: units queued from the wheel are spread across all of them.";
            console.Add(productionButton);

            zoomButton = new Button(() => Map?.ToggleZoom()) { text = "", focusable = false };
            zoomButton.AddToClassList("se-console-round");
            zoomButton.AddToClassList("se-zoom-button");
            zoomButton.Add(new Glyph("zoom", "se-zoom-glyph"));
            console.Add(zoomButton);
            BuildDefenseRangeButton();   // the defensive ranges toggle (Hud.DefenseRanges.cs)

            if (Map != null) Map.UnderAttack = OnUnderAttack;

            // bottom centre: Build · B and Terrain · T
            dock = UiKit.Fx(El("se-dock", root), "se-fx--cup");   // rises into place (centred by translate -50%)
            dock.pickingMode = PickingMode.Ignore;
            dockBuild = DockButton("build", null, () => { if (DockBuildPressed != null) DockBuildPressed(); else ToggleBuildWheel(false); });
            dockTerrain = DockButton(null, "hex", () => { if (DockTerrainPressed != null) DockTerrainPressed(); else ToggleTerrainWheel(false); });
            // the wheels (G) keep clear of everything docked
            RegisterWheelKeepOut(console); RegisterWheelKeepOut(dock); RegisterWheelKeepOut(card);

            // §45: a small "update available — installs from the menu" notice while a match shows (UpdateBanner.cs)
            updateNotice = UpdateNotice.Attach(root);
        }

        UpdateNotice updateNotice;

        // the resource bars' rows (console units): a compact stack over the disc's upper-right quadrant
        const float ResRowTop = 108f, ResRowHeight = 22f, ResRowGap = 3f, ResChordGap = 4f;

        /// <summary>
        /// §33: the Materials / Power / Units bars form one unit with the 240-px minimap. Each row's left edge follows
        /// the bezel's chord at that row (minimapLeft + r + sqrt(r² − dy²) + gap; Minimap.RightEdgeOver) instead of
        /// a fixed column that overlapped the bezel by 7–15 px. Placed once (the console has a fixed size).
        /// </summary>
        void LayoutResourceBars()
        {
            // 2026-11-18: each strip's left edge is cut along the bezel's circle (SlantBack.ArcCx/Cy/R), so the bars
            // meet the minimap rim along their whole height instead of touching it at one corner with a wedge gap
            float r = Minimap.Diameter * .5f, cx = r, cy = ConsoleHeight - r;   // the disc sits at the console's bottom-left
            float rim = r + ResChordGap * .5f;
            int row = 0;
            foreach (var kind in ResRowOrder)
            {
                if (!resChips.TryGetValue(kind, out var rc)) continue;
                float top = ResRowTop + row++ * (ResRowHeight + ResRowGap), bottom = top + ResRowHeight;
                float At(float y) { float dy = y - cy; return Mathf.Abs(dy) >= rim ? cx : cx + Mathf.Sqrt(rim * rim - dy * dy); }
                float near = Mathf.Min(At(top), At(bottom)), far = Mathf.Max(At(top), At(bottom));
                float left = Mathf.Floor(near);
                rc.Chip.style.top = top;
                rc.Chip.style.left = left;
                rc.Chip.style.width = 150f + (far - left);
                rc.Chip.style.paddingLeft = 6f + (far - left);   // the icon starts clear of the curve
                rc.Back.ArcCx = cx - left; rc.Back.ArcCy = cy - top; rc.Back.ArcR = rim;
                rc.Back.MarkDirtyRepaint();
            }
        }

        static readonly string[] ResRowOrder = { "materials", "energy", "command" };

        Button DockButton(string icon, string glyph, Action click)
        {
            // not focusable: a focused button would also fire on Space (jump to alert) and Enter
            var b = new Button(click) { text = "", focusable = false };
            b.AddToClassList("se-dock-button");
            if (icon != null) b.Add(new IconElement(icon, "se-dock-icon"));
            else b.Add(new Glyph(glyph, "se-dock-icon"));
            L("", "se-dock-label", b).pickingMode = PickingMode.Ignore;
            dock.Add(b);
            return b;
        }

        static string HudKey(string action, string fallback)
        {
            var k = InputFacade.KeyFor(action);
            return k == KeyCode.None ? fallback : SettingsView.KeyName(k);
        }

        /// <summary>From ShowGame: the console and dock exist in the action ruleset only (the legacy ruleset keeps its top bar).</summary>
        void ShowConsole(bool on)
        {
            if (console == null) return;
            if (updateNotice != null) updateNotice.InMatch = on;   // both rulesets; also tells the updater (never restarts mid-match)
            bool action = on && session.ActionRts;
            UiKit.SetShown(console, action);
            UiKit.SetShown(dock, action && !session.Spectator);
            // ruleset-scoped layout (SE.uss): the toast, banners and alert feed move clear of the clock and console
            root.EnableInClassList("se-hud--action", action);
            if (!action) { UiKit.HideNow(attackBanner); attackUntil = 0; }
            if (action)
            {
                SetDockLabel(dockBuild, "Build · " + HudKey("build", "B"));
                SetDockLabel(dockTerrain, "Terrain · " + HudKey("terrain", "T"));
                dockBuild.tooltip = "Build\nDefenses, roads, trenches, outposts and new bases. Defenses, sandbags, roads and trenches can also go on neutral ground.";
                dockTerrain.tooltip = "Terrain (" + HudKey("terrain", "T") + ")\nPick raise, lower, flatten or smooth, then drag across your own territory like a brush (" + HudKey("brush_smaller", "[") + " " + HudKey("brush_larger", "]") + " or Ctrl + wheel: size). The cost grows with the hexes painted.";
                zoomButton.tooltip = "Local view (" + HudKey("minimap_zoom", "Z") + ")\nCycle the minimap: whole map, the area around the camera, then a closer view.";
            }
        }

        static void SetDockLabel(Button b, string text)
        {
            var l = b?.Q<Label>(className: "se-dock-label");
            if (l != null && l.text != text) l.text = text;
        }

        /// <summary>Per frame from Update (action ruleset): keys, the banner timer and the dock state; counts at 4 Hz.</summary>
        void UpdateConsole(float time)
        {
            if (console == null || !UiKit.IsShown(console)) return;
            // Z: whole map → local view → close view (the minimap_zoom action; Z when it isn't bound)
            var zoomKey = InputFacade.KeyFor("minimap_zoom");
            if (InputFacade.Pressed(zoomKey == KeyCode.None ? KeyCode.Z : zoomKey) && Map != null) Map.ToggleZoom();
            if (Map != null && Map.Zoomed != zoomShown) { zoomShown = Map.Zoomed; zoomButton.EnableInClassList("selected", zoomShown); }
            UpdateDefenseRangeButton();
            if (attackUntil > 0 && time > attackUntil) { attackUntil = 0; UiKit.Hide(attackBanner); }
            bool b = DockBuildActive?.Invoke() ?? BuildWheelOpen, t = DockTerrainActive?.Invoke() ?? TerrainWheelOpen;
            if (b != dockBuildShown) { dockBuildShown = b; dockBuild.EnableInClassList("selected", b); }
            if (t != dockTerrainShown) { dockTerrainShown = t; dockTerrain.EnableInClassList("selected", t); }
            if (time < consoleAt) return;
            consoleAt = time + .25f;
            // idle units and production
            bool player = !session.Spectator;
            CountIdle();
            int idle = player ? idleIds.Count : -1;
            if (idle != idleShown)
            {
                idleShown = idle;
                UiKit.SetShown(idleButton, player);
                idleCount.text = Mathf.Max(0, idle).ToString();
                idleButton.EnableInClassList("se-console-round--empty", idle <= 0);
            }
            CountProduction();
            int production = player ? productionIds.Count : 0;
            if (production != productionShown)
            {
                productionShown = production;
                UiKit.SetShown(productionButton, production > 0);
            }
        }

        static string Roman(int n) => n switch { 1 => "I", 2 => "II", 3 => "III", 4 => "IV", 5 => "V", 6 => "VI", _ => n.ToString() };

        /// <summary>
        /// Idle: our ground units that are not moving, have no path, no target and have not fired in the last
        /// moments (flag 1). Engineers work on their own (base AI) and aircraft patrol, so neither counts.
        /// </summary>
        void CountIdle()
        {
            idleIds.Clear();
            if (session.Spectator) return;
            var store = session.Units;
            int me = session.CivId;
            for (int s = 0; s < store.SlotCount; s++)
            {
                ref var u = ref store.Records[s];
                // holding position (2048) or standing in a battle line (512) is an order, not idleness; automatic
                // base engineers (4096) work on their own
                if (!u.InUse || u.Owner != me || u.Target != 0 || (u.Flags & (1 | 512 | 2048 | 4096)) != 0) continue;
                if (u.Motion.Present && u.Motion.Vx * u.Motion.Vx + u.Motion.Vz * u.Motion.Vz > .0004f) continue;
                if (store.WorldPaths.ContainsKey(u.Id)) continue;
                string type = store.Types.Name(u.TypeIndex);
                if (type == "engineer" || IdleExempt(type)) continue;
                idleIds.Add(u.Id);
            }
        }

        readonly Dictionary<string, bool> idleExempt = new Dictionary<string, bool>();

        bool IdleExempt(string type)
        {
            if (idleExempt.TryGetValue(type, out bool v)) return v;
            var d = Defs?["UNITS"]?[type];
            v = ProtocolDecoder.Bool(d?["air"]) || ProtocolDecoder.Bool(d?["civilian"]);
            if (d != null) idleExempt[type] = v;
            return v;
        }

        /// <summary>Select every finished production building we own (the console button and the base wheel's "All production"); G's wheel then batch-queues across them.</summary>
        public void SelectAllProduction()
        {
            CountProduction();
            if (productionIds.Count == 0) { commander.Say("No production buildings yet", false, now); return; }
            commander.SelectProduction(productionIds);
        }

        void CountProduction()
        {
            productionIds.Clear();
            if (session.Spectator) return;
            foreach (var b in session.Structures.Buildings.Values)
                if (b.Owner == session.CivId && b.Done && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray t && t.Count > 0) productionIds.Add(b.Id);
        }

        void SelectIdle()
        {
            CountIdle();
            if (idleIds.Count == 0) { commander.Say("No idle units", false, now); return; }
            commander.SelectUnits(idleIds);
            // jump to one of them, the next one on each click
            int id = idleIds[idleCycle++ % idleIds.Count];
            if (units.TryGetPosition(session.Units, id, out var p)) commander.JumpCamera(new Vector3(p.x, 0, p.y));
        }


        // ------------------------------------------------------------------ attack warnings
        /// <summary>
        /// The minimap saw our forces take damage at map (x, z) (throttled there to 2.5 s). A new attack — a
        /// different place, or the same one after 20 s of quiet — raises the banner for 6 s; Space (the alert
        /// key) or a click on the banner jumps there. The minimap pings it either way.
        /// </summary>
        void OnUnderAttack(float x, float z)
        {
            if (!session.ActionRts || session.Spectator || !session.World.Ready) return;
            var g = session.World.Grid;
            int tile = g.TileAt(x, z);
            if (tile >= 0) session.LastAlertTile = tile;
            bool samePlace = !float.IsNaN(lastAttackPoint.x) && Mathf.Abs(g.DxWrap(lastAttackPoint.x, x)) < 10f && Mathf.Abs(lastAttackPoint.y - z) < 10f;
            bool fresh = !samePlace || now - lastAttackAt > 20f;
            lastAttackAt = now;
            lastAttackPoint = new Vector2(x, z);
            if (!fresh) return;
            // name the base it is at, else the forces
            string place = null;
            float best = float.MaxValue;
            foreach (var s in session.Objectives.Values)
            {
                if (!s.IsBase || s.Owner != session.CivId) continue;
                float dx = g.DxWrap(s.X, x), dz = s.Z - z, d = dx * dx + dz * dz;
                float reach = Mathf.Max(6f, s.Radius * 2f);
                if (d < reach * reach && d < best) { best = d; place = s.Name; }
            }
            attackText.text = (string.IsNullOrEmpty(place) ? "FORCES" : place.ToUpperInvariant()) + " UNDER ATTACK";
            attackHint.text = HudKey("alert", "Space") + " to jump";
            UiKit.Show(attackBanner);
            attackUntil = now + 6f;
            game?.Audio?.Ui("alert");
        }

        void JumpToAlert()
        {
            if (session.LastAlertTile >= 0) game.FocusTile(session.LastAlertTile, 22f);
        }

        // ------------------------------------------------------------------ painted pieces
        /// <summary>The Era badge: a pointy-top hexagon in the accent colour with a dark rim.</summary>
        sealed class HexBadge : VisualElement
        {
            public HexBadge() { generateVisualContent += Paint; }

            static readonly Color Fill = new Color(.93f, .70f, .27f, 1f), Rim = new Color(.07f, .08f, .08f, .92f);

            void Paint(MeshGenerationContext ctx)
            {
                var r = contentRect;
                if (r.width < 4) return;
                var p = ctx.painter2D;
                Hexagon(p, r.center, Mathf.Min(r.width * .5f / .866f, r.height * .5f) - 1.5f, true);
                p.fillColor = Fill; p.Fill();
                p.strokeColor = Rim; p.lineWidth = 2.5f; p.Stroke();
            }
        }

        /// <summary>A pointy-top (or flat-top) hexagon path of circumradius <paramref name="rad"/>.</summary>
        static void Hexagon(Painter2D p, Vector2 c, float rad, bool pointy)
        {
            p.BeginPath();
            for (int k = 0; k < 6; k++)
            {
                float a = Mathf.Deg2Rad * (60f * k + (pointy ? -90f : 0f));
                var v = c + new Vector2(Mathf.Cos(a), Mathf.Sin(a)) * rad;
                if (k == 0) p.MoveTo(v); else p.LineTo(v);
            }
            p.ClosePath();
        }

        /// <summary>Small line glyphs the icon set lacks: "clock", "hex", "person", "zoom", "dot".</summary>
        sealed class Glyph : VisualElement
        {
            readonly string kind;
            public Color Tint = new Color(.93f, .89f, .80f);

            public Glyph(string kind, string cls)
            {
                this.kind = kind;
                pickingMode = PickingMode.Ignore;
                if (!string.IsNullOrEmpty(cls)) foreach (var c in cls.Split(' ')) AddToClassList(c);
                generateVisualContent += Paint;
            }

            void Paint(MeshGenerationContext ctx)
            {
                var r = contentRect;
                if (r.width < 2 || r.height < 2) return;
                var p = ctx.painter2D;
                var c = r.center;
                float s = Mathf.Min(r.width, r.height) * .5f;
                p.strokeColor = Tint; p.fillColor = Tint; p.lineWidth = Mathf.Max(1.2f, s * .16f);
                p.lineCap = LineCap.Round; p.lineJoin = LineJoin.Round;
                switch (kind)
                {
                    case "clock":
                        p.BeginPath(); p.Arc(c, s * .82f, 0f, 360f); p.ClosePath(); p.Stroke();
                        p.BeginPath(); p.MoveTo(c + new Vector2(0, -s * .5f)); p.LineTo(c); p.LineTo(c + new Vector2(s * .38f, s * .1f)); p.Stroke();
                        break;
                    case "hex":
                        Hexagon(p, c, s * .86f, true); p.lineWidth = Mathf.Max(1.5f, s * .14f); p.Stroke();
                        break;
                    case "person":
                        p.BeginPath(); p.Arc(c + new Vector2(0, -s * .38f), s * .27f, 0f, 360f); p.ClosePath(); p.Fill();
                        p.BeginPath(); p.Arc(c + new Vector2(0, s * .62f), s * .55f, 180f, 360f); p.ClosePath(); p.Fill();
                        break;
                    case "zoom":
                        p.BeginPath(); p.Arc(c + new Vector2(-s * .15f, -s * .15f), s * .5f, 0f, 360f); p.ClosePath(); p.Stroke();
                        p.BeginPath(); p.MoveTo(c + new Vector2(s * .22f, s * .22f)); p.LineTo(c + new Vector2(s * .75f, s * .75f)); p.Stroke();
                        break;
                    case "dot":
                        p.fillColor = new Color(.95f, .36f, .28f);
                        p.BeginPath(); p.Arc(c, s * .7f, 0f, 360f); p.ClosePath(); p.Fill();
                        break;
                }
            }
        }
    }
}
