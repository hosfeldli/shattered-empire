using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.Input
{
    /// <summary>
    /// Hotkeys for any button (Ticket 4, 2026-11-20: "Every button needs to be hotkey-bindable"). Nothing has to be
    /// registered by hand: buttons are discovered as they appear and every one can be given a key in
    /// Settings › Controls › Buttons.
    ///  - Interface buttons (UI Toolkit <see cref="Button"/>s of the HUD and the menus) are found by a scan of the live
    ///    panels every two seconds (<see cref="ButtonHotkeyDriver"/>). Their id is "ui:" + group + ":" + the button's
    ///    name, label, tooltip or icon, with numbers and costs stripped, so "Train (3)" and "Train (4)" are one button.
    ///    An option inside a segmented control is named after the label in front of the control ("Victory=Blight").
    ///  - Wheel commands (<see cref="SE.Runtime.UI.RadialMenu"/> items) register when a ring is laid out, as
    ///    "wheel:" + the item id with numeric parts removed ("train:rifle_squad"); a bound key runs the item while it
    ///    is on the open ring (with the wheel's own checks: disabled items explain why).
    /// A binding is a key plus optional Ctrl / Shift / Alt (exact match), saved in PlayerPrefs ("se.bkey.&lt;id&gt;").
    /// The catalog of discovered buttons is saved too ("se.bcat", at most <see cref="MaxEntries"/>), so the settings
    /// list buttons seen in earlier sessions. Nothing fires while a text field is focused or a key is being captured.
    /// No button has a key by default: the existing shortcuts (<see cref="InputFacade.Actions"/>) are unchanged.
    /// </summary>
    public static class ButtonHotkeys
    {
        public const int MaxEntries = 400;
        public const string GroupHud = "HUD", GroupWheel = "Command wheels", GroupMenu = "Menus";

        public struct Chord
        {
            public KeyCode Key; public bool Ctrl, Shift, Alt;
            public bool IsNone => Key == KeyCode.None;
            public int Encode() => (int)Key | (Ctrl ? 1 << 20 : 0) | (Shift ? 1 << 21 : 0) | (Alt ? 1 << 22 : 0);
            public static Chord Decode(int v) => new Chord { Key = (KeyCode)(v & 0xfffff), Ctrl = (v & (1 << 20)) != 0, Shift = (v & (1 << 21)) != 0, Alt = (v & (1 << 22)) != 0 };
            public bool Same(Chord o) => Key == o.Key && Ctrl == o.Ctrl && Shift == o.Shift && Alt == o.Alt;
            public bool Plain => !Ctrl && !Shift && !Alt;
        }

        public sealed class Entry { public string Id, Label, Group; }

        static readonly Dictionary<string, Entry> catalog = new Dictionary<string, Entry>();
        static readonly List<Entry> order = new List<Entry>();
        static readonly Dictionary<string, Chord> binds = new Dictionary<string, Chord>();
        static readonly List<string> fired = new List<string>();
        static int firedFrame = -1;
        static bool loaded, catalogDirty;
        static float savedAt;

        /// <summary>Bumped whenever the catalog or a binding changes (the settings list refreshes on it).</summary>
        public static int Revision { get; private set; }

        static void Load()
        {
            if (loaded) return;
            loaded = true;
            foreach (var line in PlayerPrefs.GetString("se.bcat", "").Split('\n'))
            {
                var p = line.Split('\t');
                if (p.Length < 3 || p[1].Length == 0 || catalog.ContainsKey(p[1]) || order.Count >= MaxEntries || Clean(p[2]) == null) continue;
                var e = new Entry { Group = p[0], Id = p[1], Label = p[2] };
                catalog[e.Id] = e; order.Add(e);
            }
            foreach (var id in PlayerPrefs.GetString("se.bkeys", "").Split('\n'))
                if (id.Length > 0 && PlayerPrefs.HasKey("se.bkey." + id)) binds[id] = Chord.Decode(PlayerPrefs.GetInt("se.bkey." + id, 0));
        }

        /// <summary>Every known bindable button (discovered now or in earlier sessions, plus any bound one), in discovery order.</summary>
        public static IReadOnlyList<Entry> Entries { get { Load(); return order; } }

        /// <summary>Adds a button to the catalog (or refreshes its label). Ids are stable keys; labels are what Settings shows.</summary>
        public static void Register(string id, string label, string group)
        {
            if (string.IsNullOrEmpty(id)) return;
            Load();
            if (catalog.TryGetValue(id, out var e))
            {
                if (!string.IsNullOrEmpty(label) && e.Label != label) { e.Label = label; catalogDirty = true; Revision++; }
                return;
            }
            if (order.Count >= MaxEntries)
            {
                // full: forget the oldest entry that has no key
                int drop = order.FindIndex(x => !binds.ContainsKey(x.Id));
                if (drop < 0) return;
                catalog.Remove(order[drop].Id); order.RemoveAt(drop);
            }
            e = new Entry { Id = id, Label = string.IsNullOrEmpty(label) ? id : label, Group = group ?? GroupHud };
            catalog[id] = e; order.Add(e);
            catalogDirty = true; Revision++;
        }

        /// <summary>A wheel item (RadialItem.Id) as a bindable id: "wheel:" + the id without purely numeric parts; null for per-object items.</summary>
        public static string WheelId(string itemId)
        {
            if (string.IsNullOrEmpty(itemId)) return null;
            var parts = itemId.Split(':');
            var sb = new StringBuilder("wheel:");
            int kept = 0;
            foreach (var p in parts)
            {
                if (p.Length == 0) continue;
                bool numeric = true;
                foreach (char c in p) if (!char.IsDigit(c) && c != '-' && c != '.') { numeric = false; break; }
                if (numeric) continue;
                if (kept++ > 0) sb.Append(':');
                sb.Append(p);
            }
            return kept == 0 ? null : sb.ToString();
        }

        /// <summary>Registers a wheel item (called by RadialMenu when it lays out a ring).</summary>
        public static void RegisterWheel(string itemId, string title, string subject)
        {
            string id = WheelId(itemId);
            if (id == null) return;
            string label = Clean(title);
            if (string.IsNullOrEmpty(label)) label = id.Substring(6).Replace('_', ' ');
            string where = Clean(subject);
            Register(id, string.IsNullOrEmpty(where) ? label : where + ": " + label, GroupWheel);
        }

        // ------------------------------------------------------------------ bindings
        public static bool TryGet(string id, out Chord chord) { Load(); return binds.TryGetValue(id, out chord) && !chord.IsNone; }

        public static void Bind(string id, Chord chord)
        {
            Load();
            if (chord.IsNone) { Unbind(id); return; }
            binds[id] = chord;
            PlayerPrefs.SetInt("se.bkey." + id, chord.Encode());
            SaveIndex();
            Revision++;
        }

        public static void Unbind(string id)
        {
            Load();
            if (!binds.Remove(id)) return;
            PlayerPrefs.DeleteKey("se.bkey." + id);
            SaveIndex();
            Revision++;
        }

        /// <summary>Removes every button key (Settings › Controls › Restore defaults). The catalog is kept.</summary>
        public static void ClearAll()
        {
            Load();
            foreach (var id in binds.Keys) PlayerPrefs.DeleteKey("se.bkey." + id);
            binds.Clear();
            SaveIndex();
            Revision++;
        }

        static void SaveIndex()
        {
            PlayerPrefs.SetString("se.bkeys", string.Join("\n", binds.Keys));
            PlayerPrefs.Save();
        }

        /// <summary>Writes the catalog when it changed (at most every few seconds; the driver calls this).</summary>
        public static void SaveCatalog(bool force = false)
        {
            if (!catalogDirty || (!force && Time.realtimeSinceStartup - savedAt < 5f)) return;
            catalogDirty = false; savedAt = Time.realtimeSinceStartup;
            var sb = new StringBuilder();
            foreach (var e in order) sb.Append(e.Group).Append('\t').Append(e.Id).Append('\t').Append(e.Label.Replace('\t', ' ').Replace('\n', ' ')).Append('\n');
            PlayerPrefs.SetString("se.bcat", sb.ToString());
            PlayerPrefs.Save();
        }

        /// <summary>The label of a catalog entry (or the id).</summary>
        public static string LabelOf(string id) { Load(); return catalog.TryGetValue(id, out var e) ? e.Label : id; }

        /// <summary>The button ids whose key chord was pressed this frame (empty while typing or capturing a key).</summary>
        public static IReadOnlyList<string> Fired()
        {
            if (firedFrame == Time.frameCount) return fired;
            firedFrame = Time.frameCount;
            fired.Clear();
            Load();
            if (binds.Count == 0 || InputFacade.Typing || SE.Runtime.UI.SettingsView.Capturing) return fired;
            bool ctrl = InputFacade.Ctrl, shift = InputFacade.Shift, alt = InputFacade.Alt;
            foreach (var kv in binds)
            {
                var c = kv.Value;
                if (c.IsNone || c.Ctrl != ctrl || c.Shift != shift || c.Alt != alt) continue;
                if (InputFacade.Pressed(c.Key)) fired.Add(kv.Key);
            }
            return fired;
        }

        /// <summary>True when this id's chord was pressed this frame.</summary>
        public static bool Pressed(string id)
        {
            var f = Fired();
            for (int i = 0; i < f.Count; i++) if (f[i] == id) return true;
            return false;
        }

        /// <summary>"Ctrl+Shift+K", or "—" for none.</summary>
        public static string ChordName(Chord c)
        {
            if (c.IsNone) return "—";
            var sb = new StringBuilder();
            if (c.Ctrl) sb.Append("Ctrl+");
            if (c.Alt) sb.Append("Alt+");
            if (c.Shift) sb.Append("Shift+");
            sb.Append(InputFacade.KeyName(c.Key));
            return sb.ToString();
        }

        /// <summary>The shortcut actions and other buttons that share this chord (for the amber "Also:" note).</summary>
        public static string ConflictFor(string selfId, Chord c)
        {
            if (c.IsNone) return null;
            if (c.Plain)
                foreach (var a in InputFacade.Actions)
                    if (InputFacade.KeyFor(a.Id) == c.Key) return a.Label;
            foreach (var kv in binds)
                if (kv.Key != selfId && kv.Value.Same(c)) return LabelOf(kv.Key);
            return null;
        }

        /// <summary>A shortcut action's key also used by a button bind (no modifiers), or null.</summary>
        public static string ButtonOnKey(KeyCode key)
        {
            if (key == KeyCode.None) return null;
            Load();
            foreach (var kv in binds) if (kv.Value.Plain && kv.Value.Key == key) return LabelOf(kv.Key);
            return null;
        }

        // ------------------------------------------------------------------ interface buttons
        /// <summary>Tidies a label for an id or display: no digits, costs or bracketed counts; null when it is too long to be a command.</summary>
        public static string Clean(string s)
        {
            if (string.IsNullOrEmpty(s)) return null;
            int cut = s.IndexOfAny(new[] { '·', '\n', '(', '[', '—' });
            if (cut > 0) s = s.Substring(0, cut);
            var sb = new StringBuilder(s.Length);
            foreach (char ch in s) if (!char.IsDigit(ch) && ch != '×' && ch != '%' && ch != '+' && ch != '/') sb.Append(ch);
            string t = sb.ToString().Trim(' ', '-', ':', ',', '.', '…');
            while (t.Contains("  ")) t = t.Replace("  ", " ");
            int letters = 0;
            foreach (char ch in t) if (char.IsLetter(ch)) letters++;
            return letters < 2 || t.Length > 40 ? null : t;   // "8s" leaves "s": a timer, not a command
        }

        /// <summary>The bindable id and display label of an interface button, or null when it has nothing stable to be named by.</summary>
        public static string IdOf(Button b, out string label, out string group)
        {
            label = null; group = GroupHud;
            for (var p = b.parent; p != null; p = p.parent)
            {
                // the settings view (its own key caps and rows) is never bound
                if (p.ClassListContains("se-settings")) return null;
                if (group == GroupHud) foreach (var c in p.GetClasses()) if (c.StartsWith("se-menu") || c.StartsWith("se-builder") || c.StartsWith("se-lobby")) { group = GroupMenu; break; }
            }
            string name = null;
            if (!string.IsNullOrEmpty(b.viewDataKey)) name = b.viewDataKey;
            if (name == null) { var l = b.Q<Label>(className: "se-btn-label"); name = Clean(l?.text); }
            if (name == null) name = Clean(b.text);
            if (name == null) { foreach (var child in b.Children()) if (child is Label cl) { name = Clean(cl.text); if (name != null) break; } }
            if (name == null) name = Clean(b.tooltip);
            if (name == null && !string.IsNullOrEmpty(b.name) && !b.name.StartsWith("unity-")) name = b.name;
            if (name == null) { var ic = b.Q<SE.Runtime.UI.IconElement>(); if (ic != null && !string.IsNullOrEmpty(ic.Kind)) name = ic.Kind.Replace('_', ' '); }
            if (name == null) return null;
            // an option of a segmented control: named after the label in front of the control
            if (b.parent is SE.Runtime.UI.Segmented seg)
            {
                string ctx = null;
                var host = seg.parent;
                if (host != null)
                {
                    int i = host.IndexOf(seg);
                    for (int k = i - 1; k >= 0 && ctx == null; k--) if (host[k] is Label hl) ctx = Clean(hl.text);
                    if (ctx == null && host.ClassListContains("se-setting-row")) foreach (var c in host.Children()) if (c is Label rl) { ctx = Clean(rl.text); break; }
                }
                if (ctx != null) { label = ctx + ": " + name; return "ui:" + group + ":" + ctx.ToLowerInvariant() + "=" + name.ToLowerInvariant(); }
            }
            label = name;
            return "ui:" + group + ":" + name.ToLowerInvariant();
        }

        /// <summary>Displayed, enabled and attached (no hidden or faded-out ancestor).</summary>
        public static bool Showing(VisualElement e)
        {
            if (e.panel == null || !e.enabledInHierarchy) return false;
            var wb = e.worldBound;
            if (wb.width < 1f || wb.height < 1f || float.IsNaN(wb.width)) return false;
            for (var p = e; p != null; p = p.parent)
            {
                var rs = p.resolvedStyle;
                if (rs.display == DisplayStyle.None || rs.visibility == Visibility.Hidden || rs.opacity < .05f) return false;
            }
            return true;
        }

        /// <summary>Clicks a button the way a keyboard submit does (Button handles NavigationSubmitEvent like a click).</summary>
        public static void Click(Button b)
        {
            using (var ev = NavigationSubmitEvent.GetPooled())
            {
                ev.target = b;
                b.SendEvent(ev);
            }
        }
    }

    /// <summary>
    /// Discovers interface buttons and clicks the bound ones (<see cref="ButtonHotkeys"/>). Created once at startup,
    /// survives scene loads; scans every UIDocument every two seconds (registration only) and, on a bound key, the
    /// first showing button with that id.
    /// </summary>
    public sealed class ButtonHotkeyDriver : MonoBehaviour
    {
        static ButtonHotkeyDriver instance;
        float nextScan;
        readonly List<Button> scratch = new List<Button>();

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Create()
        {
            if (instance != null) return;
            var go = new GameObject("SE Button Hotkeys") { hideFlags = HideFlags.HideInHierarchy };
            DontDestroyOnLoad(go);
            instance = go.AddComponent<ButtonHotkeyDriver>();
        }

        void Update()
        {
            float now = Time.realtimeSinceStartup;
            if (now >= nextScan) { nextScan = now + 2f; Scan(); }
            ButtonHotkeys.SaveCatalog();
            var fired = ButtonHotkeys.Fired();
            if (fired.Count == 0) return;
            foreach (var id in fired)
            {
                if (!id.StartsWith("ui:")) continue;
                var b = Find(id);
                if (b != null) ButtonHotkeys.Click(b);
            }
        }

        void OnApplicationQuit() => ButtonHotkeys.SaveCatalog(true);

        void Collect()
        {
            scratch.Clear();
            foreach (var doc in FindObjectsByType<UIDocument>(FindObjectsSortMode.None))
            {
                var root = doc != null ? doc.rootVisualElement : null;
                if (root == null) continue;
                root.Query<Button>().ForEach(b => scratch.Add(b));
            }
        }

        void Scan()
        {
            Collect();
            foreach (var b in scratch)
            {
                if (!ButtonHotkeys.Showing(b)) continue;
                string id = ButtonHotkeys.IdOf(b, out string label, out string group);
                if (id != null) ButtonHotkeys.Register(id, label, group);
            }
        }

        Button Find(string id)
        {
            Collect();
            foreach (var b in scratch)
                if (ButtonHotkeys.Showing(b) && ButtonHotkeys.IdOf(b, out _, out _) == id) return b;
            return null;
        }
    }
}
