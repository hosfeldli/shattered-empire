using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.Horde
{
    /// <summary>
    /// BLIGHT survival HUD: the wave counter, countdown or creatures left, score and survival time at the top of the
    /// screen; the big wave-start warning; arrows on the screen edges toward off-screen masses of creatures (red for
    /// heavies and bosses) and tunnelling warnings; and the defeat screen with the run's statistics and this map's best
    /// runs (kept locally in PlayerPrefs).
    /// </summary>
    public sealed class HordeHud : IDisposable
    {
        static readonly Color Sick = new Color(.72f, .84f, .3f), Blood = new Color(.9f, .28f, .2f), Dim = new Color(.82f, .84f, .74f);
        readonly VisualElement root, banner, arrows;
        readonly Label waveLabel, statusLabel, scoreLabel, announce, announceSub;
        readonly List<Label> arrowPool = new List<Label>();
        VisualElement defeat;
        float announceAt = -100f;
        public bool Visible { get; private set; }

        public HordeHud(VisualElement parent)
        {
            root = new VisualElement { name = "se-blight-hud", pickingMode = PickingMode.Ignore };
            root.style.position = Position.Absolute; root.style.left = 0; root.style.top = 0; root.style.right = 0; root.style.bottom = 0;
            parent.Add(root);
            banner = new VisualElement { pickingMode = PickingMode.Ignore };
            banner.style.position = Position.Absolute; banner.style.top = 52; banner.style.left = Length.Percent(50); banner.style.width = 360; banner.style.marginLeft = -180;
            banner.style.alignItems = Align.Center;
            banner.style.backgroundColor = new Color(.05f, .06f, .03f, .62f);
            banner.style.borderBottomLeftRadius = banner.style.borderBottomRightRadius = banner.style.borderTopLeftRadius = banner.style.borderTopRightRadius = 6;
            banner.style.paddingTop = 4; banner.style.paddingBottom = 6;
            banner.style.borderBottomWidth = 2; banner.style.borderBottomColor = new Color(.45f, .55f, .15f, .9f);
            root.Add(banner);
            waveLabel = Text(banner, 26, Sick, FontStyle.Bold);
            statusLabel = Text(banner, 15, Dim, FontStyle.Normal);
            scoreLabel = Text(banner, 12, new Color(.7f, .72f, .62f), FontStyle.Normal);
            arrows = new VisualElement { pickingMode = PickingMode.Ignore };
            arrows.style.position = Position.Absolute; arrows.style.left = 0; arrows.style.top = 0; arrows.style.right = 0; arrows.style.bottom = 0;
            root.Add(arrows);
            announce = Text(root, 54, Blood, FontStyle.Bold);
            announce.style.position = Position.Absolute; announce.style.top = Length.Percent(28); announce.style.left = 0; announce.style.right = 0;
            announce.style.unityTextAlign = TextAnchor.MiddleCenter;
            announce.style.unityTextOutlineColor = new Color(0, 0, 0, .9f); announce.style.unityTextOutlineWidth = 1.2f;
            announceSub = Text(root, 20, Dim, FontStyle.Italic);
            announceSub.style.position = Position.Absolute; announceSub.style.top = Length.Percent(28); announceSub.style.marginTop = 70; announceSub.style.left = 0; announceSub.style.right = 0;
            announceSub.style.unityTextAlign = TextAnchor.MiddleCenter;
            SetVisible(false);
        }

        static Label Text(VisualElement parent, int size, Color color, FontStyle style)
        {
            var l = new Label { pickingMode = PickingMode.Ignore };
            l.style.fontSize = size; l.style.color = color; l.style.unityFontStyleAndWeight = style;
            l.style.marginTop = l.style.marginBottom = 0; l.style.paddingTop = l.style.paddingBottom = 0;
            parent.Add(l);
            return l;
        }

        public void SetVisible(bool on)
        {
            Visible = on;
            root.style.display = on ? DisplayStyle.Flex : DisplayStyle.None;
        }

        static string Clock(int seconds) => $"{seconds / 60}:{seconds % 60:00}";

        /// <summary>The big warning in the middle of the screen (wave start, boss, cleared).</summary>
        public void Announce(string text, string sub, Color color, float time)
        {
            announce.text = text; announceSub.text = sub; announce.style.color = color;
            announceAt = time;
        }

        /// <summary>Per frame: the banner, the announcement fade and the edge arrows.</summary>
        public void Update(HordeState s, float time, Func<Vector3, Vector3> toScreen, Func<float, float, float> ground, Vector2 focus, float camDistance)
        {
            if (!s.Active) { SetVisible(false); return; }
            if (!Visible) SetVisible(true);
            waveLabel.text = s.WaveNo == 0 ? "THE BLIGHT STIRS" : $"WAVE {s.WaveNo}";
            switch (s.Phase)
            {
                case HordeState.Prep: statusLabel.text = $"First wave in {Clock(s.Countdown)}  ·  fortify"; break;
                case HordeState.Breather: statusLabel.text = $"Next wave in {Clock(s.Countdown)}{(s.BossNext ? "  ·  a Colossus is coming" : "")}"; break;
                case HordeState.Wave: statusLabel.text = $"{s.Left} remaining  ·  {s.Live} on the field"; break;
                default: statusLabel.text = "Overrun"; break;
            }
            statusLabel.style.color = s.Phase == HordeState.Wave ? new Color(.95f, .55f, .45f) : s.Countdown <= 10 && s.Phase != HordeState.Over ? Blood : Dim;
            scoreLabel.text = $"Score {s.Score:N0}  ·  survived {Clock(s.Survived)}  ·  hives {s.Hives.Count}";
            float age = time - announceAt;
            float alpha = age < 0 ? 0 : age < .25f ? age / .25f : age < 3.2f ? 1f : Mathf.Max(0, 1 - (age - 3.2f) / .8f);
            float shudder = age < 1f ? Mathf.Sin(age * 60f) * (1 - age) * 6f : 0f;
            announce.style.opacity = alpha; announceSub.style.opacity = alpha;
            announce.style.translate = new Translate(shudder, 0);
            // edge arrows toward creature masses that are off screen, and toward tunnelling warnings
            var panel = root.panel;
            int used = 0;
            if (panel != null)
            {
                float w = root.resolvedStyle.width, h = root.resolvedStyle.height;
                if (w > 10 && h > 10)
                {
                    foreach (var t in s.Threats)
                        if (t.Count >= 3 || t.Heavy > 0) used = Arrow(used, panel, toScreen, new Vector3(t.X, ground(t.X, t.Z), t.Z), w, h, t.Heavy >= 2 ? Blood : t.Heavy == 1 ? new Color(.95f, .5f, .3f) : Sick, Mathf.Clamp(12 + t.Count, 14, 34), time, t.Heavy >= 2 ? "☠" : null);
                    foreach (var b in s.Burrows) used = Arrow(used, panel, toScreen, new Vector3(b.x, ground(b.x, b.y), b.y), w, h, Blood, 26, time, "⚠", true);
                }
            }
            for (int i = used; i < arrowPool.Count; i++) arrowPool[i].style.display = DisplayStyle.None;
        }

        int Arrow(int used, IPanel panel, Func<Vector3, Vector3> toScreen, Vector3 map, float w, float h, Color color, float size, float time, string glyph, bool always = false)
        {
            var sp = toScreen(map);
            bool behind = sp.z < 0;
            var pp = RuntimePanelUtils.ScreenToPanel(panel, new Vector2(sp.x, Screen.height - sp.y));
            if (behind) pp = new Vector2(w - pp.x, h - pp.y);
            const float margin = 34f;
            bool inside = !behind && pp.x > margin && pp.x < w - margin && pp.y > margin && pp.y < h - margin;
            if (inside && !always) return used;
            if (used >= arrowPool.Count)
            {
                var l = new Label { pickingMode = PickingMode.Ignore };
                l.style.position = Position.Absolute; l.style.unityFontStyleAndWeight = FontStyle.Bold;
                l.style.unityTextAlign = TextAnchor.MiddleCenter; l.style.width = 40; l.style.height = 40;
                l.style.unityTextOutlineColor = new Color(0, 0, 0, .85f); l.style.unityTextOutlineWidth = 1f;
                arrows.Add(l);
                arrowPool.Add(l);
            }
            var a = arrowPool[used];
            a.style.display = DisplayStyle.Flex;
            var c = new Vector2(w * .5f, h * .5f);
            var d = pp - c;
            float ang = Mathf.Atan2(d.y, d.x);
            Vector2 at;
            if (inside) at = pp;
            else
            {
                // clamp onto the screen border along the direction from the centre
                float sx = Mathf.Abs(d.x) > 1e-3f ? (w * .5f - margin) / Mathf.Abs(d.x) : float.MaxValue, sy = Mathf.Abs(d.y) > 1e-3f ? (h * .5f - margin) / Mathf.Abs(d.y) : float.MaxValue;
                at = c + d * Mathf.Min(sx, sy);
            }
            float pulse = .7f + .3f * Mathf.Sin(time * 7f + used);
            a.text = inside ? glyph ?? "▼" : glyph != null && always ? glyph : "➤";
            a.style.fontSize = size;
            a.style.color = new Color(color.r, color.g, color.b, pulse);
            a.style.left = at.x - 20; a.style.top = at.y - 20;
            a.style.rotate = new Rotate(new Angle(inside || glyph != null && always ? 0 : ang * Mathf.Rad2Deg));
            return used + 1;
        }

        // ------------------------------------------------------------------ defeat and best runs

        const string BestKey = "se.blight.best.";

        /// <summary>Saves a finished run in this map's local best-runs table; returns the table (best first) and the run's place.</summary>
        public static List<JObject> RecordBest(string map, JObject run, out int place)
        {
            var list = LoadBest(map);
            var entry = new JObject { ["score"] = run["score"], ["wave"] = run["wave"], ["seconds"] = run["seconds"], ["killed"] = run["killed"], ["players"] = run["players"], ["at"] = DateTime.Now.ToString("yyyy-MM-dd") };
            list.Add(entry);
            list.Sort((a, b) => ProtocolDecoder.Int(b["score"]).CompareTo(ProtocolDecoder.Int(a["score"])));
            if (list.Count > 5) list.RemoveRange(5, list.Count - 5);
            place = list.IndexOf(entry);
            PlayerPrefs.SetString(BestKey + map, new JArray(list).ToString(Newtonsoft.Json.Formatting.None));
            PlayerPrefs.Save();
            return list;
        }

        public static List<JObject> LoadBest(string map)
        {
            var list = new List<JObject>();
            try
            {
                var raw = PlayerPrefs.GetString(BestKey + map, "");
                if (!string.IsNullOrEmpty(raw)) foreach (var t in JArray.Parse(raw)) if (t is JObject o) list.Add(o);
            }
            catch (Exception) { list.Clear(); }
            return list;
        }

        /// <summary>The defeat screen: wave reached, score, time survived, kills by creature, losses, hives burned, best runs.</summary>
        public void ShowDefeat(JObject run, float time)
        {
            if (run == null) return;
            defeat?.RemoveFromHierarchy();
            string map = ProtocolDecoder.Str(run["map"], "random");
            var best = RecordBest(map, run, out int place);
            defeat = new VisualElement();
            defeat.style.position = Position.Absolute; defeat.style.top = Length.Percent(14); defeat.style.left = Length.Percent(50);
            defeat.style.width = 440; defeat.style.marginLeft = -220;
            defeat.style.backgroundColor = new Color(.04f, .05f, .03f, .93f);
            defeat.style.borderTopWidth = defeat.style.borderBottomWidth = defeat.style.borderLeftWidth = defeat.style.borderRightWidth = 2;
            defeat.style.borderTopColor = defeat.style.borderBottomColor = defeat.style.borderLeftColor = defeat.style.borderRightColor = new Color(.45f, .55f, .15f);
            defeat.style.paddingLeft = defeat.style.paddingRight = 22; defeat.style.paddingTop = 16; defeat.style.paddingBottom = 16;
            root.Add(defeat);
            Text(defeat, 34, Blood, FontStyle.Bold).text = "OVERRUN";
            Text(defeat, 15, Dim, FontStyle.Italic).text = "The Blight has taken the last of you.";
            int seconds = ProtocolDecoder.Int(run["seconds"]);
            Line(defeat, "Wave reached", ProtocolDecoder.Int(run["wave"]).ToString());
            Line(defeat, "Score", ProtocolDecoder.Int(run["score"]).ToString("N0") + (place == 0 ? "  · new best!" : place > 0 ? $"  · #{place + 1} on this map" : ""));
            Line(defeat, "Survived", Clock(seconds));
            Line(defeat, "Creatures slain", ProtocolDecoder.Int(run["killed"]).ToString("N0"));
            if (run["kills"] is JObject kills)
            {
                var parts = new List<string>();
                foreach (var p in kills) parts.Add($"{HordeTypes.Name(HordeTypes.KindOf(p.Key))} {ProtocolDecoder.Int(p.Value)}");
                if (parts.Count > 0) { var l = Text(defeat, 12, new Color(.66f, .68f, .58f), FontStyle.Normal); l.text = string.Join(" · ", parts); l.style.whiteSpace = WhiteSpace.Normal; }
            }
            Line(defeat, "Colossi felled", ProtocolDecoder.Int(run["bosses"]).ToString());
            Line(defeat, "Hives burned", ProtocolDecoder.Int(run["hives"]).ToString());
            Line(defeat, "Troops lost to the Blight", ProtocolDecoder.Int(run["lost"]).ToString());
            Line(defeat, "Fallen who rose again", ProtocolDecoder.Int(run["risen"]).ToString());
            Line(defeat, "Waves cleared", ProtocolDecoder.Int(run["cleared"]).ToString());
            Line(defeat, "Largest horde on the field", ProtocolDecoder.Int(run["peak"]).ToString());
            var head = Text(defeat, 16, Sick, FontStyle.Bold); head.text = "Best runs on this map"; head.style.marginTop = 12;
            for (int i = 0; i < best.Count; i++)
            {
                var b = best[i];
                var l = Text(defeat, 13, i == place ? Sick : Dim, i == place ? FontStyle.Bold : FontStyle.Normal);
                l.text = $"{i + 1}.  {ProtocolDecoder.Int(b["score"]):N0}  ·  wave {ProtocolDecoder.Int(b["wave"])}  ·  {Clock(ProtocolDecoder.Int(b["seconds"]))}  ·  {ProtocolDecoder.Str(b["at"], "")}";
            }
            var close = new Button(() => { defeat?.RemoveFromHierarchy(); defeat = null; }) { text = "Close" };
            close.style.marginTop = 12; close.style.alignSelf = Align.FlexEnd;
            defeat.Add(close);
            Announce("OVERRUN", $"Wave {ProtocolDecoder.Int(run["wave"])} · score {ProtocolDecoder.Int(run["score"]):N0}", Blood, time);
        }

        static void Line(VisualElement parent, string label, string value)
        {
            var row = new VisualElement();
            row.style.flexDirection = FlexDirection.Row; row.style.justifyContent = Justify.SpaceBetween; row.style.marginTop = 3;
            parent.Add(row);
            Text(row, 14, new Color(.72f, .74f, .64f), FontStyle.Normal).text = label;
            Text(row, 14, new Color(.92f, .92f, .82f), FontStyle.Bold).text = value;
        }

        public void Dispose() { root?.RemoveFromHierarchy(); }
    }
}
