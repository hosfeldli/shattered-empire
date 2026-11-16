using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The shell (docs/UI_DESIGN_SPEC.md § B2, B3, B13, C6): the 56-px top bar (Materials, Energy and
    /// Command chips with a 10-second average income rate and a pinnable breakdown; the centred status
    /// pill; speed control, observer, invite, pause and menu on the right), the toast, the pause menu with
    /// its page stack, and the Escape back-chain.
    /// </summary>
    public sealed partial class Hud
    {
        // ------------------------------------------------------------------ top bar
        VisualElement topLeft, chipRow, topRight, topDivider;
        Segmented speedControl;
        bool speedForSpectator;
        Button observerChip, inviteButton, pauseButton, menuButton;
        Label observerName;
        VisualElement observerDot;
        float now;

        sealed class ResChip
        {
            public string Kind;
            public Button Chip;
            public Label Amount, Rate;
            public VisualElement BarFill;
            public float Shown, SampledAt = -1f, FlashUntil;
            public int ShownAmount = int.MinValue, ShownTenths = int.MinValue;   // what the labels show (format only on change)
        }

        readonly Dictionary<string, ResChip> resChips = new Dictionary<string, ResChip>();
        string hoverChip;
        float hoverSince;
        string popoverKind;      // "materials" | "energy" | "command" | "observer"
        bool popoverPinned;
        VisualElement popover;

        void BuildTopBar()
        {
            topbar = El("se-topbar", root);
            topLeft = El("se-topbar-left", topbar);
            resRow = El("row", topLeft);     // legacy ruleset goods
            chipRow = El("row", topLeft);    // action ruleset chips
            chipRow.style.display = DisplayStyle.None;
            AddResourceChip("materials", "se-res-chip");
            AddResourceChip("energy", "se-res-chip");
            AddResourceChip("command", "se-res-chip se-res-chip--command");

            focusPill = L("", "se-status-pill", topbar);
            focusPill.pickingMode = PickingMode.Ignore;
            focusPill.style.display = DisplayStyle.None;

            topRight = El("se-topbar-right", topbar);
            // the speed control is built once the ruleset is known (spectators get 8×)
            observerChip = UiKit.Chip(null, topRight);
            observerChip.AddToClassList("se-observer-chip");
            observerDot = El("se-civ-dot", observerChip);
            observerName = L("", "se-observer-name", observerChip);
            observerChip.clicked += () => TogglePopover("observer", observerChip);
            observerChip.tooltip = "Observer: follow a nation, choose the fog";
            observerChip.style.display = DisplayStyle.None;
            inviteButton = UiKit.IconButton("invite", () => game.InviteFriends(), "Invite friends", topRight);
            inviteButton.name = "invite";
            inviteButton.style.display = DisplayStyle.None;
            topDivider = El("se-topbar-divider", topRight);
            pauseButton = UiKit.IconButton("pause", TogglePause, "Pause (" + SettingsView.KeyName(Input.InputFacade.KeyFor("pause")) + ")", topRight);
            pauseButton.style.display = DisplayStyle.None;
            menuButton = UiKit.IconButton("menu", OpenPauseMenu, "Menu (Esc)", topRight);

            popover = El("se-popover", root);
            popover.pickingMode = PickingMode.Position;
            popover.style.display = DisplayStyle.None;
            // a click anywhere else in the interface closes a pinned popover
            root.RegisterCallback<PointerDownEvent>(e =>
            {
                if (!popoverPinned || popover.style.display == DisplayStyle.None) return;
                var t = e.target as VisualElement;
                if (t != null && (popover.Contains(t) || Owns(t))) return;
                ClosePopover();
            }, TrickleDown.TrickleDown);
        }

        bool Owns(VisualElement t)
        {
            if (popoverKind == "observer") return observerChip.Contains(t);
            return popoverKind != null && resChips.TryGetValue(popoverKind, out var rc) && rc.Chip.Contains(t);
        }

        void AddResourceChip(string kind, string cls)
        {
            var chip = UiKit.Chip(kind, chipRow);
            foreach (var c in cls.Split(' ')) chip.AddToClassList(c);
            var rc = new ResChip { Kind = kind, Chip = chip };
            if (kind == "command")
            {
                rc.Amount = L("", "se-res-amount se-res-cap", chip);
                rc.Rate = L("", "se-res-queued", chip);
                var hourglass = new IconElement("queued", "se-res-queued-icon") { Tint = UiKit.Token("text-dim") };
                chip.Add(hourglass);
                var bar = El("se-res-bar", chip);
                bar.pickingMode = PickingMode.Ignore;
                rc.BarFill = El("se-res-bar-fill", bar);
            }
            else
            {
                rc.Amount = L("", "se-res-amount", chip);
                rc.Rate = L("+0.0/s", "se-res-rate se-res-rate--zero", chip);
            }
            rc.Amount.pickingMode = PickingMode.Ignore;
            rc.Rate.pickingMode = PickingMode.Ignore;
            chip.clicked += () => TogglePopover(kind, chip);
            chip.RegisterCallback<PointerEnterEvent>(e => { hoverChip = kind; hoverSince = now; });
            chip.RegisterCallback<PointerLeaveEvent>(e =>
            {
                if (hoverChip == kind) hoverChip = null;
                if (!popoverPinned && popoverKind == kind) ClosePopover();
            });
            resChips[kind] = rc;
        }

        /// <summary>Flash a resource chip red for 1.2 s ("materials", "energy" or "command"): a command failed for lack of it.</summary>
        public void FlashResource(string res)
        {
            if (res != null && resChips.TryGetValue(res, out var rc)) rc.FlashUntil = now + 1.2f;
        }

        static string Amount(int v) => v >= 100000 ? (v / 1000) + "k" : v.ToString("N0");

        /// <summary>Per refresh (4 Hz): the chips or legacy goods, the status pill and the right group.</summary>
        void UpdateTopBar()
        {
            bool action = session.ActionRts;
            chipRow.style.display = action ? DisplayStyle.Flex : DisplayStyle.None;
            resRow.style.display = action ? DisplayStyle.None : DisplayStyle.Flex;
            if (action) TopBarAction(); else TopBar();
            UpdateRightGroup();
            if (popover.style.display == DisplayStyle.Flex && popoverKind != null && PopoverSignature() != popoverFilledFor) FillPopover();
        }

        long popoverFilledFor = long.MinValue;

        /// <summary>
        /// What the open popover shows depends on: rebuild its rows only when this changes (they used to be rebuilt
        /// four times a second, which also reset hover on the observer popover's buttons).
        /// </summary>
        long PopoverSignature()
        {
            long sig = (popoverKind?.GetHashCode() ?? 0) * 1000003L + (popoverKind == "observer" ? 0 : session.Snapshots);
            if (popoverKind == "materials" || popoverKind == "energy")
            {
                float avg = resChips.TryGetValue(popoverKind, out var rc) ? Mathf.Max(0, rc.Shown) : 0f;
                float pickups = popoverKind == "materials" ? PickupIncome(now) : 0f;
                sig = sig * 31 + Mathf.RoundToInt(avg * 10f);
                sig = sig * 31 + Mathf.RoundToInt(pickups * 10f);
            }
            else if (popoverKind == "observer") sig = sig * 31 + session.CivId * 2 + (session.ObserverFog ? 1 : 0);
            return sig;
        }

        static readonly string[] ChipKinds = { "materials", "energy" };
        IconElement commandHourglass;
        int shownUsed = int.MinValue, shownCap = int.MinValue, shownQueued = int.MinValue, shownRecovery = int.MinValue, shownHeld = int.MinValue;

        /// <summary>Materials Processors, relays and pickups: Materials income per second over the last minute of pickups.</summary>
        void TopBarAction()
        {
            var res = Econ?["res"];
            var rates = Econ?["rates"];
            foreach (var kind in ChipKinds)
            {
                var rc = resChips[kind];
                int amount = ProtocolDecoder.Int(res?[kind]);
                if (amount != rc.ShownAmount) { rc.ShownAmount = amount; rc.Amount.text = Amount(amount); }
                float instant = ProtocolDecoder.Float(rates?[kind]) + (kind == "materials" ? PickupIncome(now) : 0f);
                // EMA, τ = 10 s, sampled at the refresh; spending never enters it so it does not flicker
                if (rc.SampledAt < 0) rc.Shown = instant;
                else rc.Shown += (instant - rc.Shown) * (1f - Mathf.Exp(-Mathf.Max(0f, now - rc.SampledAt) / 10f));
                rc.SampledAt = now;
                float shown = Mathf.Max(0f, rc.Shown);
                // the label shows tenths: format only when the shown tenth changes
                int tenths = (int)Math.Round(shown * 10.0, MidpointRounding.AwayFromZero);
                if (tenths != rc.ShownTenths) { rc.ShownTenths = tenths; rc.Rate.text = "+" + shown.ToString("0.0") + "/s"; }
                rc.Rate.EnableInClassList("se-res-rate--zero", shown < 0.05f);
                rc.Chip.EnableInClassList("se-alert-bad", now < rc.FlashUntil);
            }
            var capacity = Econ?["capacity"];
            int used = ProtocolDecoder.Int(capacity?["used"]), queued = ProtocolDecoder.Int(capacity?["queued"]), cap = ProtocolDecoder.Int(capacity?["limit"]);
            var cmd = resChips["command"];
            if (used != shownUsed || cap != shownCap) { shownUsed = used; shownCap = cap; cmd.Amount.text = $"{used}/{cap}"; }
            if (queued != shownQueued)
            {
                shownQueued = queued;
                cmd.Rate.text = queued > 0 ? "+" + queued : "";
                if (commandHourglass == null) commandHourglass = cmd.Chip.Q<IconElement>(className: "se-res-queued-icon");
                if (commandHourglass != null) commandHourglass.style.visibility = queued > 0 ? Visibility.Visible : Visibility.Hidden;
            }
            float load = cap > 0 ? (used + queued) / (float)cap : 0f;
            cmd.BarFill.style.width = new Length(cap > 0 ? Mathf.Clamp01(used / (float)cap) * 100f : 0f, LengthUnit.Percent);
            cmd.BarFill.style.backgroundColor = load >= 1f ? UiKit.Token("bad") : load >= .85f ? UiKit.Token("warn") : UiKit.Token("good");
            bool flash = now < cmd.FlashUntil;
            cmd.Chip.EnableInClassList("se-alert-bad", flash);
            cmd.Chip.EnableInClassList("se-alert-warn", !flash && cap > 0 && used + queued >= cap);

            // the centred status pill: fixed width, hidden when empty (it is absolute: nothing shifts)
            int recovery = ProtocolDecoder.Int(Econ?["recovery"]), held = ProtocolDecoder.Int(Econ?["hold"]);
            string status = recovery > 0 ? $"Restore command in {recovery} s" : held > 0 ? $"Objective held {held} s" : session.Spectator ? "Observing: " + CivName(session.CivId) : "";
            focusPill.text = status;
            focusPill.EnableInClassList("se-status--bad", recovery > 0);
            focusPill.style.display = status.Length > 0 ? DisplayStyle.Flex : DisplayStyle.None;
        }

        void UpdateRightGroup()
        {
            bool spectator = session.Spectator;
            bool showSpeed = spectator || session.Welcome?.Sandbox == true;
            if (showSpeed && (speedControl == null || speedForSpectator != spectator))
            {
                speedControl?.RemoveFromHierarchy();
                var items = new List<(string id, string label, string icon)> { ("0", "Pause (" + SettingsView.KeyName(Input.InputFacade.KeyFor("pause")) + ")", "pause"), ("1", "1×", null), ("2", "2×", null), ("4", "4×", null) };
                if (spectator) items.Add(("8", "8×", null));
                speedControl = UiKit.Segmented(items, "1", id => SetSpeed(int.Parse(id)));
                topRight.Insert(0, speedControl);
                speedForSpectator = spectator;
            }
            if (speedControl != null)
            {
                speedControl.style.display = showSpeed ? DisplayStyle.Flex : DisplayStyle.None;
                if (showSpeed) speedControl.Value = session.Paused ? "0" : Mathf.Max(1, Mathf.RoundToInt(session.PlayRate)).ToString();
            }
            observerChip.style.display = spectator ? DisplayStyle.Flex : DisplayStyle.None;
            if (spectator)
            {
                observerName.text = CivName(session.CivId);
                observerDot.style.backgroundColor = UiKit.RelationColor(session, session.CivId);
            }
            bool invite = game.CanInvite && (session.ActionRts ? session.Welcome != null && HumanCount(session.Welcome.Civs) > 1 : true);
            inviteButton.style.display = invite ? DisplayStyle.Flex : DisplayStyle.None;
            bool canPause = !showSpeed && game.CanPause;
            pauseButton.style.display = canPause ? DisplayStyle.Flex : DisplayStyle.None;
            topDivider.style.display = showSpeed || spectator || invite ? DisplayStyle.Flex : DisplayStyle.None;
            if (pauseIcon == null) pauseIcon = UiKit.IconOf(pauseButton) as IconElement;
            if (pauseIcon != null) pauseIcon.Kind = session.Paused ? "play" : "pause";
            // the tooltip string is rebuilt only when the state or the binding changes
            var pauseKey = Input.InputFacade.KeyFor("pause");
            if (pauseTipPaused != session.Paused || pauseTipKey != pauseKey || pauseButton.tooltip == null)
            {
                pauseTipPaused = session.Paused; pauseTipKey = pauseKey;
                pauseButton.tooltip = (session.Paused ? "Resume (" : "Pause (") + SettingsView.KeyName(pauseKey) + ")";
            }
        }

        IconElement pauseIcon;
        bool pauseTipPaused;
        KeyCode pauseTipKey = KeyCode.None;

        static int HumanCount(CivInfo[] civs)
        {
            int n = 0;
            if (civs != null) foreach (var c in civs) if (c.Human) n++;
            return n;
        }

        // ------------------------------------------------------------------ speed and pause
        void SetSpeed(int s)
        {
            if (session.Spectator) { session.Net?.ObserverCommand(new JObject { ["c"] = "speed", ["speed"] = s }); return; }
            if (s == 0) Cmd(new JObject { ["c"] = "pause", ["on"] = true }, "Paused");
            else
            {
                if (session.Paused) Cmd(new JObject { ["c"] = "pause", ["on"] = false }, "Resumed");
                Cmd(new JObject { ["c"] = "speed", ["speed"] = s }, $"Speed {s}×");
            }
        }

        /// <summary>P / the pause button: pause or resume where allowed (spectators and the sandbox use the speed control's pause).</summary>
        void TogglePause()
        {
            if (session.Spectator || session.Welcome?.Sandbox == true) { SetSpeed(session.Paused ? Mathf.Max(1, Mathf.RoundToInt(session.PlayRate)) : 0); return; }
            if (game.CanPause) game.SetPaused(!session.Paused);
        }

        // ------------------------------------------------------------------ breakdown popover
        void TogglePopover(string kind, VisualElement anchor)
        {
            if (popoverPinned && popoverKind == kind) { ClosePopover(); return; }
            popoverKind = kind;
            popoverPinned = true;
            ShowPopover(anchor);
            if (resChips.TryGetValue(kind, out var rc)) rc.Chip.EnableInClassList("selected", true);
        }

        void ShowPopover(VisualElement anchor)
        {
            foreach (var rc in resChips.Values) rc.Chip.EnableInClassList("selected", false);
            observerChip.EnableInClassList("selected", popoverKind == "observer" && popoverPinned);
            FillPopover();
            var wb = anchor.worldBound;
            popover.style.left = Mathf.Max(8, Mathf.Min(wb.xMin, root.layout.width - 272));
            popover.style.top = wb.yMax + 6;
            popover.style.display = DisplayStyle.Flex;
            popover.BringToFront();
            tooltip.style.display = DisplayStyle.None;
        }

        void ClosePopover()
        {
            if (popover == null) return;
            popover.style.display = DisplayStyle.None;
            popoverPinned = false;
            popoverKind = null;
            foreach (var rc in resChips.Values) rc.Chip.EnableInClassList("selected", false);
            observerChip?.EnableInClassList("selected", false);
        }

        /// <summary>Hover a chip for 0.35 s to see the breakdown without pinning it.</summary>
        void UpdateChipHover()
        {
            if (popoverPinned || hoverChip == null || now - hoverSince < .35f) return;
            if (popoverKind == hoverChip && popover.style.display == DisplayStyle.Flex) return;
            if (!resChips.TryGetValue(hoverChip, out var rc)) return;
            popoverKind = hoverChip;
            ShowPopover(rc.Chip);
        }

        void PopRow(string a, string b, string cls = null)
        {
            var row = El("se-flow-row", popover);
            L(a, cls, row); L(b, cls, row);
        }

        void FillPopover()
        {
            popoverFilledFor = PopoverSignature();
            popover.Clear();
            switch (popoverKind)
            {
                case "materials": IncomeBreakdown("materials", "Materials"); break;
                case "energy": IncomeBreakdown("energy", "Energy"); break;
                case "command": CommandBreakdown(); break;
                case "observer": ObserverPopover(); break;
            }
        }

        void IncomeBreakdown(string res, string title)
        {
            L(title, "heading", popover);
            var buildings = Defs?["BUILDINGS"];
            var outposts = Defs?["OUTPOST_TYPES"];
            int hq = 0, processors = 0, generators = 0, relays = 0;
            float hqRate = 0, procRate = 0, genRate = 0, relayRate = 0;
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (b.Owner != session.CivId || !b.Done) continue;
                float r = ProtocolDecoder.Float(buildings?[b.Type]?[res]);
                if (b.Type == "town") { hq++; hqRate += r; }
                else if (b.Type == "depot") { processors++; procRate += r; }
                else if (b.Type == "power_plant") { generators++; genRate += r; }
            }
            foreach (var s in session.Objectives.Values)
            {
                if (s.Owner != session.CivId || s.IsBase || s.Kind == null) continue;
                float r = ProtocolDecoder.Float(outposts?[s.Kind]?[res]);
                if (r > 0) { relays++; relayRate += r; }
            }
            string Rate(float r) => "+" + r.ToString("0.0") + "/s";
            PopRow($"Headquarters ×{hq}", Rate(hqRate), "small");
            if (res == "materials") PopRow($"Processors ×{processors}", Rate(procRate), "small");
            else PopRow($"Generators ×{generators}", Rate(genRate), "small");
            PopRow($"Relays ×{relays}", Rate(relayRate), "small");
            float pickups = res == "materials" ? PickupIncome(now) : 0f;
            if (res == "materials") PopRow("Pickups (60 s)", Rate(pickups), "small");
            float total = ProtocolDecoder.Float(Econ?["rates"]?[res]) + pickups;
            PopRow("Total", $"{Rate(total)} · {total * 60f:0}/min", "small good");
            if (resChips.TryGetValue(res, out var rc)) PopRow("10 s average", Rate(Mathf.Max(0, rc.Shown)), "small muted");
        }

        void CommandBreakdown()
        {
            L("Command", "heading", popover);
            var capacity = Econ?["capacity"];
            int used = ProtocolDecoder.Int(capacity?["used"]), queued = ProtocolDecoder.Int(capacity?["queued"]), cap = ProtocolDecoder.Int(capacity?["limit"]);
            PopRow("In the field", used.ToString(), "small");
            PopRow("Reserved in production", queued.ToString(), "small");
            PopRow("Capacity", cap.ToString(), "small");
            int tier = Mathf.Clamp(Age, 0, 2);
            string[] numerals = { "I", "II", "III" };
            string tierLine = $"Faction Tier {numerals[tier]} · cap {cap}" + (tier < 2 ? $" → Tier {numerals[tier + 1]}" : "");
            var tl = L(tierLine, "small muted", popover);
            tl.style.whiteSpace = WhiteSpace.Normal;
            var techs = Econ?["techs"] as JArray;
            if (techs != null && techs.Count > 0)
            {
                L("Upgrades", "small muted", popover).style.marginTop = 4;
                var names = techs.Select(t => NameOf("TECHS", (string)t)).ToList();
                var ul = L(string.Join(", ", names), "small", popover);
                ul.style.whiteSpace = WhiteSpace.Normal;
            }
        }

        void ObserverPopover()
        {
            var net = session.Net;
            L("Follow", "heading", popover);
            foreach (var civ in session.Welcome?.Civs ?? Array.Empty<CivInfo>())
            {
                if (civ.Rebel) continue;
                int id = civ.Id;
                var b = UiKit.Button(civ.Name, () =>
                {
                    net?.ObserverCommand(new JObject { ["c"] = "follow", ["civ"] = id }, r => { if (r.Error != null) commander.Say(r.Error, false, now); });
                    ClosePopover();
                }, popover, null, "se-popover-row");
                b.EnableInClassList("selected", session.CivId == id);
                var dot = El("se-civ-dot");
                dot.style.backgroundColor = UiKit.RelationColor(session, id);
                b.Insert(0, dot);
            }
            L("Fog of war", "heading", popover).style.marginTop = 6;
            UiKit.Button("Whole map", () => { net?.ObserverCommand(new JObject { ["c"] = "fog", ["on"] = false }); ClosePopover(); }, popover, null, "se-popover-row")
                .EnableInClassList("selected", !session.ObserverFog);
            UiKit.Button("Their fog of war", () => { net?.ObserverCommand(new JObject { ["c"] = "fog", ["on"] = true }); ClosePopover(); }, popover, null, "se-popover-row")
                .EnableInClassList("selected", session.ObserverFog);
        }

        // ------------------------------------------------------------------ toast (B3)
        Label toast;
        float toastUntil, lastFeedbackUntil;
        string lastFeedback = "";

        void BuildToast()
        {
            toast = L("", "se-toast", root);
            toast.pickingMode = PickingMode.Ignore;
            toast.style.display = DisplayStyle.None;
        }

        /// <summary>Positive feedback worth a toast in the action ruleset; everything else that succeeds stays quiet.</summary>
        static bool ToastWorthy(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            if (text.StartsWith("Construction started") || text.StartsWith("Upgrade started") || text.StartsWith("Rally point set")) return true;
            // "N queued" / "Queued N × …"
            if (text.StartsWith("Queued ")) return true;
            int sp = text.IndexOf(' ');
            return sp > 0 && int.TryParse(text.Substring(0, sp), out _) && text.Substring(sp + 1).StartsWith("queued");
        }

        void UpdateToast(float time)
        {
            if (commander.FeedbackUntil != lastFeedbackUntil || commander.Feedback != lastFeedback)
            {
                lastFeedbackUntil = commander.FeedbackUntil;
                lastFeedback = commander.Feedback ?? "";
                bool good = commander.FeedbackGood;
                if (!good || !session.ActionRts || ToastWorthy(lastFeedback))
                {
                    if (lastFeedback.Length > 0)
                    {
                        toast.text = lastFeedback;
                        toast.EnableInClassList("se-toast--bad", !good);
                        toast.EnableInClassList("se-toast--good", good);
                        toastUntil = time + (good ? 1.5f : 3f);
                    }
                }
            }
            bool showToast = time < toastUntil;
            if (!showToast && !session.ActionRts)
            {
                // the legacy ruleset keeps its placement hints ("Click to place…") when no message is due
                string hint = commander.ModeHint();
                if (!string.IsNullOrEmpty(hint))
                {
                    if (toast.text != hint) toast.text = hint;
                    toast.EnableInClassList("se-toast--bad", false);
                    toast.EnableInClassList("se-toast--good", false);
                    showToast = true;
                }
            }
            toast.style.display = showToast ? DisplayStyle.Flex : DisplayStyle.None;
        }

        // ------------------------------------------------------------------ pause menu (B13)
        VisualElement pauseDimmer, pauseFrame;
        UiKit.PageStack pausePages;
        bool pausedByMenu;

        public bool PauseMenuOpen => pauseDimmer != null;

        void OpenPauseMenu()
        {
            if (pauseDimmer != null || MenuVisible) return;
            ClosePopover();
            pauseDimmer = El("se-dimmer", root);
            pauseFrame = El("se-frame se-pause-frame", pauseDimmer);
            pausePages = new UiKit.PageStack(pauseFrame);
            pausePages.WideChanged += wide => pauseFrame?.EnableInClassList("se-frame--wide", wide);
            pausePages.Reset("root", PauseRoot);
            pauseDimmer.BringToFront();
            // pausing only where single-player rules allow it; resuming restores the previous speed
            if (game.CanPause && !session.Paused) { game.SetPaused(true); pausedByMenu = true; }
        }

        void ClosePauseMenu(bool resume)
        {
            if (pauseDimmer == null) return;
            pauseDimmer.RemoveFromHierarchy();
            pauseDimmer = null; pauseFrame = null; pausePages = null;
            if (resume && pausedByMenu && game.CanPause && session.Paused) game.SetPaused(false);
            pausedByMenu = false;
        }

        static VisualElement PageHeader(VisualElement page, string title, Action back)
        {
            var head = UiKit.El("se-page-header", page);
            if (back != null) UiKit.IconButton("back", back, "Back (Esc)", head);
            UiKit.Text(title, "se-page-title", head);
            return head;
        }

        void PopPause() { if (pausePages != null && !pausePages.Pop()) ClosePauseMenu(true); }

        VisualElement PauseRoot()
        {
            var page = El("se-page");
            PageHeader(page, "PAUSED", null);
            UiKit.Button("Resume", () => ClosePauseMenu(true), page, "play", "se-pause-item");
            UiKit.Button("Settings", () => pausePages.Push("settings", PauseSettings, true), page, "settings", "se-pause-item");
            UiKit.Button("Field guide", () => pausePages.Push("guide", () => PauseGuide(false), true), page, "guide", "se-pause-item");
            bool multiplayer = session.Welcome != null && session.Welcome.Civs.Count(c => c.Human) > 1;
            if (game.CanInvite && multiplayer) UiKit.Button("Invite friends", () => game.InviteFriends(), page, "invite", "se-pause-item");
            UiKit.Button("Leave match", () => pausePages.Push("leave", () => ConfirmPage("Leave match?", "Your forces stay on the server; Continue returns to this match.", "Leave", () =>
            {
                ClosePauseMenu(false);
                game.StartMatch("", "");
            })), page, "back", "se-pause-item");
            UiKit.Button("Quit to desktop", () => pausePages.Push("quit", () => ConfirmPage("Quit to desktop?", "The match state remains on the server for rejoining.", "Quit", () => game.Quit())), page, "quit", "se-pause-item");
            return page;
        }

        VisualElement PauseSettings()
        {
            var view = new SettingsView(game) { OpenCredits = () => pausePages?.Push("credits", () => PauseGuide(true), true) };
            view.Back = PopPause;
            return view;
        }

        VisualElement PauseGuide(bool credits)
        {
            var page = El("se-page");
            PageHeader(page, "FIELD GUIDE", PopPause);
            var guide = FieldGuide.Build(session.ActionRts, credits);
            guide.style.flexGrow = 1;
            guide.style.minHeight = 0;
            page.Add(guide);
            return page;
        }

        VisualElement ConfirmPage(string title, string text, string confirm, Action yes)
        {
            var page = El("se-page");
            PageHeader(page, title, PopPause);
            L(text, "se-confirm-text muted", page);
            var row = El("se-confirm-row", page);
            UiKit.Button("Cancel", PopPause, row);
            UiKit.Button(confirm, yes, row, null, "se-danger");
            return page;
        }

        // ------------------------------------------------------------------ Escape back-chain (C6)
        void HandleEscape()
        {
            // 1. a shortcut waiting for its key takes Escape itself (it cancels)
            if (SettingsView.Capturing) return;
            // 2. the commander consumed it this frame (tool, battle line)
            if (commander.EscapeFrame == Time.frameCount) return;
            // (the commander runs after the HUD: a running tool or battle line is its Escape this frame)
            if (pauseDimmer == null && (commander.Current != Session.Commander.Mode.Select || commander.DrawingLine)) return;
            // 3. pause menu: back one page, at the root resume
            if (pauseDimmer != null) { PopPause(); return; }
            // 4. a pinned or hovered breakdown / observer popover
            if (popover != null && popover.style.display == DisplayStyle.Flex) { ClosePopover(); return; }
            // 5. picker → sub-ring → armed defense bar → wheel (Hud.Base.cs)
            if (session.ActionRts && CloseCommandContext()) return;
            // 6. a legacy side panel
            if (openPanel != "") { openPanel = ""; Refresh(true); return; }
            // 7. the selection
            if (commander.ClearSelection()) return;
            // 8. nothing open: the pause menu
            OpenPauseMenu();
        }

        /// <summary>Called every frame from Update (keeps the shell's clock and hover popover current).</summary>
        void UpdateShell(float time)
        {
            now = time;
            UpdateChipHover();
            // clicking the world closes a pinned popover
            if (popoverPinned && Input.InputFacade.LeftDown && !IsPointerOverUi(Input.InputFacade.MousePosition)) ClosePopover();
        }
    }
}
