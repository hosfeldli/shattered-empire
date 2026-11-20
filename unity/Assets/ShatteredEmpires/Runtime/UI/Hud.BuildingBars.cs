using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Runtime.Cities;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// Structure health bars (2026-11-19, user: "all buildings need health bars, specifically defensive buildings when
    /// not at max HP"). A compact bar over every damaged gameplay structure we can see (defenses, base facilities, the
    /// headquarters; never fog memories or city fabric), and over a selected or hovered one at any health. The fill is
    /// the owner's colour over a dark trough, so who lost how much reads at once; a thin strip under it goes green,
    /// amber, red with the condition, quarter ticks mark 25% steps, and a critical structure (below 35%) pulses a red
    /// frame. Readable at gameplay zoom (wider when closer); hidden at strategic zoom unless selected. One vector
    /// canvas, repainted only when a bar moved or changed (like the unit overlay, Hud.Overlay.cs).
    /// </summary>
    public sealed partial class Hud
    {
        sealed class BuildingBarCanvas : VisualElement
        {
            public struct Bar { public Vector2 P; public float Hp, Width; public Color Team; public bool Selected, Critical; }
            public readonly List<Bar> Bars = new List<Bar>(64);
            public float Pulse;
            int paintedHash = int.MinValue;

            public BuildingBarCanvas()
            {
                pickingMode = PickingMode.Ignore; generateVisualContent += Paint;
                style.position = Position.Absolute; style.left = style.top = style.right = style.bottom = 0;
            }

            static int Mix(int h, float v) => unchecked(h * 31 + (int)Mathf.Round(v * 4f));

            public void RepaintIfChanged()
            {
                int h = Bars.Count * 17;
                bool critical = false;
                foreach (var b in Bars)
                {
                    h = Mix(Mix(Mix(Mix(h, b.P.x), b.P.y), b.Hp * 100f), b.Width) * 31 + (b.Selected ? 1 : 0) + b.Team.GetHashCode();
                    critical |= b.Critical;
                }
                if (critical) h = Mix(h, Pulse * 8f);
                if (h == paintedHash) return;
                paintedHash = h;
                MarkDirtyRepaint();
            }

            static void Rect(Painter2D p, float x, float y, float w, float h, Color c)
            {
                if (w <= 0 || h <= 0) return;
                p.fillColor = c;
                p.BeginPath(); p.MoveTo(new Vector2(x, y)); p.LineTo(new Vector2(x + w, y)); p.LineTo(new Vector2(x + w, y + h)); p.LineTo(new Vector2(x, y + h)); p.ClosePath(); p.Fill();
            }

            void Paint(MeshGenerationContext ctx)
            {
                var p = ctx.painter2D;
                foreach (var b in Bars)
                {
                    float w = b.Width, h = 6f, x = Mathf.Round(b.P.x - w * .5f), y = Mathf.Round(b.P.y - h * .5f);
                    var frame = b.Critical ? Color.Lerp(new Color(.55f, .08f, .06f, .9f), new Color(1f, .25f, .2f, 1f), Pulse)
                        : b.Selected ? new Color(.96f, .95f, .88f, .95f) : new Color(0, 0, 0, .75f);
                    Rect(p, x - 2, y - 2, w + 4, h + 7, frame);
                    Rect(p, x - 1, y - 1, w + 2, h + 5, new Color(.05f, .05f, .06f, .92f));
                    Rect(p, x, y, w, h, new Color(.20f, .07f, .06f, .95f));                      // the lost part: a dark red trough
                    float hp = Mathf.Clamp01(b.Hp);
                    Rect(p, x, y, w * hp, h, b.Team);
                    Rect(p, x, y, w * hp, 1.5f, Color.Lerp(b.Team, Color.white, .45f));           // a lit top edge
                    var condition = hp > .6f ? new Color(.45f, .88f, .42f) : hp > .35f ? new Color(.97f, .78f, .26f) : new Color(.96f, .30f, .24f);
                    Rect(p, x, y + h + 1, w * hp, 2f, condition);
                    for (int k = 1; k < 4; k++) Rect(p, Mathf.Round(x + w * k * .25f), y, 1f, h, new Color(0, 0, 0, .55f));
                }
            }
        }

        BuildingBarCanvas buildingBars;
        const int MaxBuildingBars = 160;
        const float BarStrategicZoom = 52f;   // UnitRenderer.StrategicDistance

        /// <summary>Per frame, from DrawBattleOverlay: collect and draw the structure health bars.</summary>
        void DrawBuildingBars(Func<Vector3, Vector3> toScreen, float zoom, float time)
        {
            bool on = session.ActionRts && !MenuVisible && topbar.style.display != DisplayStyle.None && session.Structures != null;
            if (!on)
            {
                if (buildingBars != null) buildingBars.style.display = DisplayStyle.None;
                return;
            }
            if (buildingBars == null) { buildingBars = new BuildingBarCanvas(); root.Insert(0, buildingBars); }
            buildingBars.style.display = DisplayStyle.Flex;
            buildingBars.Bars.Clear();
            buildingBars.Pulse = .5f + .5f * Mathf.Sin(Time.unscaledTime * 7f);
            var world = session.World;
            if (!world.Ready) { buildingBars.RepaintIfChanged(); return; }
            var grid = world.Grid;
            bool strategic = zoom >= BarStrategicZoom;
            int hover = commander.HoverBuildingId;
            float baseWidth = Mathf.Clamp(92f - zoom * .95f, 40f, 72f);
            var defs = session.Defs?["BUILDINGS"];
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (!b.Done || b.Memory || b.Hp <= 0) continue;
                bool selected = commander.SelectedBuildings.Contains(b.Id), hovered = b.Id == hover && hover != 0;
                if (b.Hp >= 100 && !selected && !hovered) continue;
                if (strategic && !selected) continue;
                if (!CityRenderer.IsGameplayType(b.Type)) continue;
                float x = b.HasPosition ? b.X : grid.CenterX(b.Tile), z = b.HasPosition ? b.Z : grid.CenterZ(b.Tile);
                if (CityRenderer.VisualExtent(b.Type, out float height) < 0) height = .4f;
                var sp = toScreen(new Vector3(x, world.GroundHeight(x, z) + height + .12f, z));
                if (sp.z <= 0 || sp.x < -40 || sp.y < -40 || sp.x > Screen.width + 40 || sp.y > Screen.height + 40) continue;
                var c = session.CivColor(b.Owner);
                bool field = ProtocolDecoder.Bool(defs?[b.Type]?["field"]);
                buildingBars.Bars.Add(new BuildingBarCanvas.Bar
                {
                    P = ToPanel(sp), Hp = b.Hp / 100f, Width = field ? baseWidth * .78f : baseWidth,
                    Team = new Color(c.x, c.y, c.z).gamma, Selected = selected, Critical = b.Hp < 35,
                });
                if (buildingBars.Bars.Count >= MaxBuildingBars) break;
            }
            buildingBars.RepaintIfChanged();
        }
    }
}
