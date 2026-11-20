using SE.Runtime.App;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The defensive ranges toggle on the minimap console (2026-11-19, user: "the game needs a toggle down by the
    /// minimap to enable/disable defensive ranges"): a small round button over the bezel's upper right, beside the
    /// local-view button. On, every defense in view draws its weapon range on the ground (Commander.DefenseRanges.cs);
    /// off, only a selected defense does. The choice is saved (GameSettings.ShowDefenseRanges).
    /// </summary>
    public sealed partial class Hud
    {
        Button rangeButton;
        bool rangeShown;

        void BuildDefenseRangeButton()
        {
            rangeButton = new Button(ToggleDefenseRanges) { text = "", focusable = false };
            rangeButton.AddToClassList("se-console-round");
            rangeButton.AddToClassList("se-range-button");
            // placed here rather than in SE.uss: just above the local-view button (.se-zoom-button, left 192 top 82), clear of the bezel
            rangeButton.style.left = 172; rangeButton.style.top = 44;
            rangeButton.style.width = 30; rangeButton.style.height = 30;
            rangeButton.style.borderTopLeftRadius = rangeButton.style.borderTopRightRadius =
                rangeButton.style.borderBottomLeftRadius = rangeButton.style.borderBottomRightRadius = 15;
            rangeButton.Add(new RangeGlyph());
            rangeButton.tooltip = "Defensive ranges\nShow the weapon range of every defense in view: yours, and enemy defenses you can see (red). "
                + "Off: only a selected defense shows its range.";
            console.Add(rangeButton);
            commander.ShowDefenseRanges = GameSettings.ShowDefenseRanges;
            rangeShown = !commander.ShowDefenseRanges;   // the first update sets the class
        }

        void ToggleDefenseRanges()
        {
            commander.ShowDefenseRanges = !commander.ShowDefenseRanges;
            GameSettings.ShowDefenseRanges = commander.ShowDefenseRanges;
        }

        void UpdateDefenseRangeButton()
        {
            if (rangeButton == null || commander.ShowDefenseRanges == rangeShown) return;
            rangeShown = commander.ShowDefenseRanges;
            rangeButton.EnableInClassList("selected", rangeShown);
        }

        /// <summary>The toggle's icon: a turret dot inside two range rings with a sight line.</summary>
        sealed class RangeGlyph : VisualElement
        {
            public RangeGlyph()
            {
                pickingMode = PickingMode.Ignore;
                style.width = 16; style.height = 16;
                generateVisualContent += Paint;
            }

            void Paint(MeshGenerationContext ctx)
            {
                var r = contentRect;
                if (r.width < 2) return;
                var p = ctx.painter2D;
                var c = r.center;
                float s = Mathf.Min(r.width, r.height) * .5f;
                var ink = new Color(.93f, .89f, .80f);
                p.strokeColor = ink; p.fillColor = ink; p.lineCap = LineCap.Round;
                p.lineWidth = Mathf.Max(1.3f, s * .16f);
                p.BeginPath(); p.Arc(c, s * .9f, 0f, 360f); p.ClosePath(); p.Stroke();
                p.lineWidth = Mathf.Max(1f, s * .11f);
                p.strokeColor = new Color(ink.r, ink.g, ink.b, .6f);
                p.BeginPath(); p.Arc(c, s * .55f, 0f, 360f); p.ClosePath(); p.Stroke();
                p.BeginPath(); p.Arc(c, s * .22f, 0f, 360f); p.ClosePath(); p.Fill();
                p.strokeColor = ink;
                p.BeginPath(); p.MoveTo(c); p.LineTo(c + new Vector2(s * .64f, -s * .64f)); p.Stroke();
            }
        }
    }
}
