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
    /// The shell (docs/UI_DESIGN_SPEC.md § B2, B3, B13, C6; 2026-11-16 mockup): in the action ruleset the top bar
    /// floats (the match clock top centre, pause / menu and the observer controls top right) and the slim resource
    /// bars live on the minimap console (Hud.Console.cs); the legacy ruleset keeps the 56-px top bar. Resource
    /// bars (Materials, Power = the server's 'energy', Units = command capacity) show the balance and a compact net
    /// rate (EMA of Δamount/Δt beside the 10-second income EMA; consumption = income − net) with a pinnable
    /// breakdown; the status pill sits under the clock.
    /// Also the toast, the pause menu with
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
            public SlantBack Back;      // the slim slanted bar drawn behind the labels (minimap console)
            public Label Amount, Rate;
            public VisualElement BarFill;
            public float Shown, SampledAt = -1f, FlashUntil;
            public int ShownAmount = int.MinValue, ShownTenths = int.MinValue;   // what the labels show (format only on change)
            public int TargetAmount;           // the server's amount; the label counts toward it (no jumps)
            public UiKit.Tween AmountTween;
            // §33 net rate: a second EMA (τ 10 s of match time) of Δamount / Δt; consumption = income − net
            public float Net, NetSampledAt = -1f;
            public int NetLastAmount, ShownNetTenths = int.MinValue, ShownNetSign = int.MinValue;
            public float Consumption => Mathf.Max(0f, Mathf.Max(0f, Shown) - Net);
        }

        float tweenLast = -1f;

        /// <summary>
        /// Per frame: Materials and Energy count smoothly toward the server's amount (about 0.45 s, unscaled time, so
        /// also while paused). The text changes only when the shown integer does, from cached strings (no garbage).
        /// </summary>
        void TweenResources(float time)
        {
            float dt = tweenLast < 0f ? 0f : Mathf.Clamp(time - tweenLast, 0f, .1f);
            tweenLast = time;
            if (!session.ActionRts) return;
            foreach (var kind in ChipKinds)
            {
                if (!resChips.TryGetValue(kind, out var rc) || rc.ShownAmount == rc.TargetAmount && rc.AmountTween.Value == rc.TargetAmount) continue;
                rc.AmountTween.Step(rc.TargetAmount, dt, .45f);
                int shown = Mathf.RoundToInt(rc.AmountTween.Value);
                if (shown == rc.ShownAmount) continue;
                rc.ShownAmount = shown;
                rc.Amount.text = shown >= 100000 ? Amount(shown) : UiKit.IntText(shown);
            }
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
            chipRow = El("row", topLeft);    // (empty: the action ruleset's resource bars sit on the minimap console, Hud.Console.cs)
            chipRow.style.display = DisplayStyle.None;

            // the match clock, top centre (action ruleset; the top bar itself floats there, mockup 2026-11-16)
            clock = El("se-clock", topbar);
            clock.pickingMode = PickingMode.Ignore;
            clock.Add(new Glyph("clock", "se-clock-glyph"));
            clockText = L("0:00", "se-clock-text", clock);
            clockText.pickingMode = PickingMode.Ignore;
            clock.style.display = DisplayStyle.None;

            focusPill = UiKit.Fx(L("", "se-status-pill", topbar), "se-fx--cdown");
            focusPill.pickingMode = PickingMode.Ignore;

            // the decisive-domination countdown under the clock (action ruleset; econ dominance:[team, secondsLeft]); slides down in
            dominanceBanner = UiKit.Fx(El("se-dominance", topbar), "se-fx--cdown");
            dominanceBanner.pickingMode = PickingMode.Ignore;
            dominanceTitle = L("", "se-dominance-title", dominanceBanner);
            dominanceTitle.pickingMode = PickingMode.Ignore;
            dominanceText = L("", "se-dominance-text", dominanceBanner);
            dominanceText.pickingMode = PickingMode.Ignore;

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

            popover = UiKit.Fx(El("se-popover", root), "se-fx--quick");
            popover.pickingMode = PickingMode.Position;
            // a click anywhere else in the interface closes a pinned popover
            root.RegisterCallback<PointerDownEvent>(e =>
            {
                if (!popoverPinned || !UiKit.IsShown(popover)) return;
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

        /// <summary>
        /// A slim resource bar for the minimap console (mockup 2026-11-16): a dark slanted strip with the resource
        /// glyph, the amount and its rate (Command: used/cap, "+queued" and a thin load line). Hover for 0.35 s or
        /// click to pin the breakdown popover, as the old top-bar chips did.
        /// </summary>
        void AddResourceChip(string kind, VisualElement parent)
        {
            var chip = new Button { text = "", focusable = false };
            chip.AddToClassList("se-resbar");
            chip.AddToClassList("se-resbar--" + kind);
            var back = new SlantBack();
            chip.Add(back);
            var rc = new ResChip { Kind = kind, Chip = chip, Back = back };
            var icon = new IconElement(kind, "se-resbar-icon")
            {
                Tint = kind == "materials" ? new Color(.95f, .67f, .30f) : kind == "energy" ? new Color(.47f, .70f, 1f) : UiKit.Token("good"),
            };
            chip.Add(icon);
            rc.Amount = L("", "se-resbar-amount", chip);
            rc.Rate = L(kind == "command" ? "" : "0.0/s", "se-resbar-rate se-res-rate--zero", chip);
            if (kind == "command")
            {
                var bar = El("se-resbar-load", chip);
                bar.pickingMode = PickingMode.Ignore;
                rc.BarFill = El("se-resbar-load-fill", bar);
                rc.BarFill.pickingMode = PickingMode.Ignore;
            }
            rc.Amount.pickingMode = PickingMode.Ignore;
            rc.Rate.pickingMode = PickingMode.Ignore;
            chip.tooltip = null;
            chip.clicked += () => TogglePopover(kind, chip);
            chip.RegisterCallback<PointerEnterEvent>(e => { hoverChip = kind; hoverSince = now; back.Hover = true; });
            chip.RegisterCallback<PointerLeaveEvent>(e =>
            {
                back.Hover = false;
                if (hoverChip == kind) hoverChip = null;
                if (!popoverPinned && popoverKind == kind) ClosePopover();
            });
            parent.Add(chip);
            resChips[kind] = rc;
        }

        /// <summary>
        /// The slanted strip behind a resource bar: straight left edge (it docks against the minimap), the right
        /// edge cut at an angle. Repaints only when its state changes.
        /// </summary>
        sealed class SlantBack : VisualElement
        {
            bool hover, selected;
            int alert;   // 0 none, 1 warn, 2 bad

            public SlantBack()
            {
                pickingMode = PickingMode.Ignore;
                style.position = Position.Absolute;
                style.left = 0; style.top = 0; style.right = 0; style.bottom = 0;
                generateVisualContent += Paint;
            }

            public bool Hover { get => hover; set { if (hover != value) { hover = value; MarkDirtyRepaint(); } } }

            public void SetState(bool isSelected, int alertLevel)
            {
                if (isSelected == selected && alertLevel == alert) return;
                selected = isSelected; alert = alertLevel;
                MarkDirtyRepaint();
            }

            static readonly Color Fill = new Color(.05f, .075f, .085f, .86f), FillHover = new Color(.16f, .20f, .21f, .94f);
            static readonly Color Edge = new Color(1f, 1f, 1f, .10f);

            void Paint(MeshGenerationContext ctx)
            {
                var r = contentRect;
                if (r.width < 4 || r.height < 4) return;
                var p = ctx.painter2D;
                float slant = r.height * .45f;
                p.BeginPath();
                p.MoveTo(new Vector2(0, 0)); p.LineTo(new Vector2(r.width, 0));
                p.LineTo(new Vector2(r.width - slant, r.height)); p.LineTo(new Vector2(0, r.height)); p.ClosePath();
                p.fillColor = hover || selected ? FillHover : Fill;
                p.Fill();
                p.strokeColor = alert == 2 ? UiKit.Token("bad") : alert == 1 ? UiKit.Token("warn") : selected || hover ? UiKit.Token("accent") : Edge;
                p.lineWidth = alert > 0 || selected ? 1.5f : 1f;
                p.Stroke();
            }
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
            if (floatingShown != action)
            {
                // action ruleset (mockup 2026-11-16): no bar — only the clock (top centre) and the floating pause /
                // menu group (top right) remain; the strip itself lets clicks through to the world
                floatingShown = action;
                topbar.EnableInClassList("se-topbar--floating", action);
                topbar.pickingMode = action ? PickingMode.Ignore : PickingMode.Position;
                topLeft.style.display = action ? DisplayStyle.None : DisplayStyle.Flex;
                clock.style.display = action ? DisplayStyle.Flex : DisplayStyle.None;
            }
            chipRow.style.display = DisplayStyle.None;
            resRow.style.display = action ? DisplayStyle.None : DisplayStyle.Flex;
            if (action) TopBarAction(); else TopBar();
            UpdateRightGroup();
            if (UiKit.IsShown(popover) && popoverKind != null && PopoverSignature() != popoverFilledFor) FillPopover();
        }

        long popoverFilledFor = long.MinValue;
        bool? floatingShown;
        VisualElement clock;
        Label clockText;
        int clockShown = int.MinValue;

        /// <summary>Per frame: the match clock (server match time of the newest snapshot); text set only when the second changes.</summary>
        void UpdateClock()
        {
            if (clock == null || floatingShown != true) return;
            int s = Mathf.Max(0, Mathf.FloorToInt(session.Units.NewestTime));
            if (s == clockShown) return;
            clockShown = s;
            clockText.text = s >= 3600 ? $"{s / 3600}:{s / 60 % 60:00}:{s % 60:00}" : $"{s / 60}:{s % 60:00}";
        }

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
                if (rc != null) sig = sig * 31 + rc.ShownNetTenths;
            }
            else if (popoverKind == "observer") sig = sig * 31 + session.CivId * 2 + (session.ObserverFog ? 1 : 0);
            return sig;
        }

        static readonly string[] ChipKinds = { "materials", "energy" };
        int shownLoadPct = -1, shownLoadLevel = -1;
        int shownUsed = int.MinValue, shownCap = int.MinValue, shownQueued = int.MinValue, shownReserved = int.MinValue, shownRecovery = int.MinValue, shownHeld = int.MinValue;

        /// <summary>
        /// §33: the net rate, an EMA (τ 10 s) of Δamount/Δt over match time (the newest snapshot's clock), so a pause
        /// or a 2×/4× speed neither zeroes nor doubles it. Sampled with the refresh (4 Hz); no allocation.
        /// </summary>
        void SampleNet(ResChip rc, int amount, float income)
        {
            float t = session.Units.NewestTime;
            if (rc.NetSampledAt < 0f || t < rc.NetSampledAt - 1f)
            {
                // first sample (or a rejoin that rewound the clock): assume nothing is being spent yet
                rc.Net = income; rc.NetSampledAt = t; rc.NetLastAmount = amount;
                return;
            }
            float dt = t - rc.NetSampledAt;
            if (dt < .2f) return;   // no new match time (paused, or no fresh snapshot): keep the last value
            float instant = (amount - rc.NetLastAmount) / dt;
            rc.Net += (instant - rc.Net) * (1f - Mathf.Exp(-dt / 10f));
            rc.NetSampledAt = t; rc.NetLastAmount = amount;
        }

        /// <summary>Materials Processors, relays and pickups: Materials income per second over the last minute of pickups.</summary>
        void TopBarAction()
        {
            var res = Econ?["res"];
            var rates = Econ?["rates"];
            foreach (var kind in ChipKinds)
            {
                var rc = resChips[kind];
                int amount = ProtocolDecoder.Int(res?[kind]);
                rc.TargetAmount = amount;   // the label counts toward it every frame (TweenResources)
                float instant = ProtocolDecoder.Float(rates?[kind]) + (kind == "materials" ? PickupIncome(now) : 0f);
                // EMA, τ = 10 s, sampled at the refresh; spending never enters it so it does not flicker
                if (rc.SampledAt < 0) rc.Shown = instant;
                else rc.Shown += (instant - rc.Shown) * (1f - Mathf.Exp(-Mathf.Max(0f, now - rc.SampledAt) / 10f));
                rc.SampledAt = now;
                float shown = Mathf.Max(0f, rc.Shown);
                rc.ShownTenths = (int)Math.Round(shown * 10.0, MidpointRounding.AwayFromZero);   // the popover's signature
                SampleNet(rc, amount, shown);
                // the bar shows the net rate in tenths, signed: format only when the shown tenth changes
                int netTenths = (int)Math.Round(rc.Net * 10.0, MidpointRounding.AwayFromZero);
                if (netTenths != rc.ShownNetTenths)
                {
                    rc.ShownNetTenths = netTenths;
                    float v = Mathf.Abs(netTenths) / 10f;
                    rc.Rate.text = netTenths > 0 ? "+" + v.ToString("0.0") + "/s" : netTenths < 0 ? "-" + v.ToString("0.0") + "/s" : "0.0/s";
                }
                int sign = Math.Sign(netTenths);
                if (sign != rc.ShownNetSign)
                {
                    rc.ShownNetSign = sign;
                    rc.Rate.EnableInClassList("se-res-rate--zero", sign == 0);
                    rc.Rate.EnableInClassList("se-res-rate--neg", sign < 0);
                }
                rc.Back?.SetState(popoverPinned && popoverKind == kind, now < rc.FlashUntil ? 2 : 0);
            }
            var capacity = Econ?["capacity"];
            int used = ProtocolDecoder.Int(capacity?["used"]), queued = ProtocolDecoder.Int(capacity?["queued"]), cap = ProtocolDecoder.Int(capacity?["limit"]);
            // R3: population reserved before production starts (capacity.reserved once the server sends it; until
            // then everything queued counts as reserved). The bar reads "used/cap" and "+reserved (+queued beyond it)".
            int reserved = capacity?["reserved"] != null ? ProtocolDecoder.Int(capacity["reserved"]) : queued;
            int extra = Mathf.Max(0, queued - reserved);
            var cmd = resChips["command"];
            if (used != shownUsed || cap != shownCap) { shownUsed = used; shownCap = cap; cmd.Amount.text = $"{used}/{cap}"; }
            if (reserved != shownReserved || extra != shownQueued)
            {
                shownReserved = reserved; shownQueued = extra;
                cmd.Rate.text = reserved > 0 && extra > 0 ? $"+{reserved} (+{extra})" : reserved > 0 ? "+" + reserved : extra > 0 ? $"(+{extra})" : "";
                cmd.Rate.EnableInClassList("se-res-rate--zero", reserved <= 0);
            }
            float load = cap > 0 ? (used + Mathf.Max(queued, reserved)) / (float)cap : 0f;
            int loadPct = cap > 0 ? Mathf.RoundToInt(Mathf.Clamp01(used / (float)cap) * 100f) : 0;
            int loadLevel = load >= 1f ? 2 : load >= .85f ? 1 : 0;
            if (loadPct != shownLoadPct || loadLevel != shownLoadLevel)
            {
                shownLoadPct = loadPct; shownLoadLevel = loadLevel;
                cmd.BarFill.style.width = new Length(loadPct, LengthUnit.Percent);
                cmd.BarFill.style.backgroundColor = loadLevel == 2 ? UiKit.Token("bad") : loadLevel == 1 ? UiKit.Token("warn") : UiKit.Token("good");
            }
            bool flash = now < cmd.FlashUntil;
            cmd.Back?.SetState(popoverPinned && popoverKind == "command", flash ? 2 : cap > 0 && used + Mathf.Max(queued, reserved) >= cap ? 1 : 0);

            // the centred status pill: fixed width, hidden when empty (it is absolute: nothing shifts)
            int recovery = ProtocolDecoder.Int(Econ?["recovery"]), held = ProtocolDecoder.Int(Econ?["hold"]);
            string status = recovery > 0 ? $"Restore command in {recovery} s" : held > 0 ? $"Objective held {held} s" : session.Spectator ? "Observing: " + CivName(session.CivId) : "";
            if (focusPill.text != status) focusPill.text = status;
            focusPill.EnableInClassList("se-status--bad", recovery > 0);
            UiKit.SetShown(focusPill, status.Length > 0);
            UpdateDominance();
        }

        // ------------------------------------------------------------------ decisive domination (W2-S server rule)
        VisualElement dominanceBanner;
        Label dominanceTitle, dominanceText;
        int shownDomTeam = int.MinValue, shownDomSeconds = int.MinValue;

        /// <summary>
        /// The decisive-domination countdown: econ <c>dominance:[team, secondsLeft]</c> while a team holds
        /// RULESET.dominance.hqShare of the operational headquarters with armyRatio× its rivals' army. Ours reads as
        /// a victory countdown, a rival's as a defeat warning with what breaks it. Text changes once a second.
        /// </summary>
        void UpdateDominance()
        {
            var dom = Econ?["dominance"] as JArray;
            int team = dom != null && dom.Count >= 2 ? ProtocolDecoder.Int(dom[0], -1) : -1;
            int left = team >= 0 ? Mathf.Max(0, ProtocolDecoder.Int(dom[1])) : -1;
            if (team == shownDomTeam && left == shownDomSeconds) return;
            shownDomTeam = team; shownDomSeconds = left;
            if (team < 0)
            {
                UiKit.Hide(dominanceBanner);
                root.EnableInClassList("se-hud--dominance", false);
                focusPill.style.top = StyleKeyword.Null;
                return;
            }
            int mine = -1;
            foreach (var c in session.Welcome?.Civs ?? Array.Empty<CivInfo>()) if (c.Id == session.CivId) mine = c.Team;
            bool spectator = session.Spectator || mine < 0;
            bool ours = !spectator && mine == team;
            var rule = Defs?["RULESET"]?["dominance"];
            int hq = Mathf.RoundToInt(ProtocolDecoder.Float(rule?["hqShare"], .65f) * 100f);
            float army = ProtocolDecoder.Float(rule?["armyRatio"], 2.5f);
            string clockText = $"{left / 60}:{left % 60:00}";
            string who = TeamCivNames(team);
            dominanceTitle.text = ours ? $"DECISIVE DOMINATION · VICTORY IN {clockText}"
                : spectator ? $"DECISIVE DOMINATION · {who.ToUpperInvariant()} WINS IN {clockText}"
                : $"ENEMY DECISIVE DOMINATION · DEFEAT IN {clockText}";
            dominanceText.text = ours ? $"Keep {hq}% of the headquarters and {army:0.#}× the enemy army until the timer runs out"
                : spectator ? $"{who} holds {hq}% of the headquarters with {army:0.#}× the army"
                : $"{who} holds {hq}% of the headquarters with {army:0.#}× your army · retake a headquarters or rebuild to stop it";
            dominanceBanner.EnableInClassList("se-dominance--ours", ours);
            dominanceBanner.EnableInClassList("se-dominance--enemy", !ours && !spectator);
            UiKit.Show(dominanceBanner);
            focusPill.style.top = 116;   // the status pill steps below the banner
            root.EnableInClassList("se-hud--dominance", true);   // the toast and the critical banner too (SE.uss)
        }

        string TeamCivNames(int team)
        {
            var names = new List<string>();
            foreach (var c in session.Welcome?.Civs ?? Array.Empty<CivInfo>()) if (c.Team == team && !c.Rebel) names.Add(c.Name);
            return names.Count == 0 ? "Team " + (char)('A' + Mathf.Clamp(team, 0, 25)) : string.Join(" and ", names);
        }

        void UpdateRightGroup()
        {
            bool spectator = session.Spectator;
            bool showSpeed = SpeedDirect;
            UpdateSpeedVote();   // Hud.SpeedVote.cs: matches with several humans vote instead
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
            topDivider.style.display = showSpeed || spectator || invite || SpeedByVote ? DisplayStyle.Flex : DisplayStyle.None;
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
        /// <summary>A match with exactly one human seat (a skirmish against AIs): its player sets the speed directly (§42, server W4).</summary>
        bool SoloMatch => session.Welcome != null && !session.Spectator && HumanCount(session.Welcome.Civs) == 1;

        /// <summary>The 1×/2×/4× (and pause) control: spectators (also 8×), the sandbox and single-player matches.</summary>
        bool SpeedDirect => session.Spectator || session.Welcome?.Sandbox == true || SoloMatch;

        void SetSpeed(int s)
        {
            if (session.Spectator) { session.Net?.ObserverCommand(new JObject { ["c"] = "speed", ["speed"] = s }); return; }
            if (s == 0 && game.CanPause) game.SetPaused(true);
            else if (s == 0) Cmd(new JObject { ["c"] = "pause", ["on"] = true }, "Paused");
            else
            {
                if (session.Paused) Cmd(new JObject { ["c"] = "pause", ["on"] = false }, "Resumed");
                Cmd(new JObject { ["c"] = "speed", ["speed"] = s }, $"Speed {s}×");
            }
        }

        /// <summary>P / the pause button: pause or resume where allowed (spectators and the sandbox use the speed control's pause).</summary>
        void TogglePause()
        {
            if (SpeedDirect) { SetSpeed(session.Paused ? Mathf.Max(1, Mathf.RoundToInt(session.PlayRate)) : 0); return; }
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
            float rootH = root.layout.height;
            if (!float.IsNaN(rootH) && wb.center.y > rootH * .5f)
            {
                // a bar on the minimap console: open beside it, growing upward from its bottom edge
                popover.style.top = StyleKeyword.Auto;
                popover.style.bottom = Mathf.Max(8, rootH - wb.yMax);
                popover.style.left = Mathf.Max(8, Mathf.Min(wb.xMax + 10, root.layout.width - 272));
            }
            else
            {
                popover.style.bottom = StyleKeyword.Auto;
                popover.style.left = Mathf.Max(8, Mathf.Min(wb.xMin, root.layout.width - 272));
                popover.style.top = wb.yMax + 6;
            }
            if (!UiKit.IsShown(popover)) popover.BringToFront();
            UiKit.Show(popover);
            UiKit.Hide(tooltip);
        }

        void ClosePopover()
        {
            if (popover == null) return;
            UiKit.Hide(popover);
            popoverPinned = false;
            popoverKind = null;
            foreach (var rc in resChips.Values) rc.Chip.EnableInClassList("selected", false);
            observerChip?.EnableInClassList("selected", false);
        }

        /// <summary>Hover a chip for 0.35 s to see the breakdown without pinning it.</summary>
        void UpdateChipHover()
        {
            if (popoverPinned || hoverChip == null || now - hoverSince < .35f) return;
            if (popoverKind == hoverChip && UiKit.IsShown(popover)) return;
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
                case "energy": IncomeBreakdown("energy", "Power"); break;   // the server's 'energy', shown as Power (§33)
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
            if (resChips.TryGetValue(res, out var rc))
            {
                PopRow("Income, 10 s average", Rate(Mathf.Max(0, rc.Shown)), "small muted");
                float spend = rc.Consumption;
                PopRow("Consumption, 10 s average", spend >= .05f ? "-" + spend.ToString("0.0") + "/s" : "0.0/s", spend >= .05f ? "small bad" : "small muted");
                float net = rc.ShownNetTenths / 10f;
                PopRow("Net", (net > 0 ? "+" : net < 0 ? "-" : "") + Mathf.Abs(net).ToString("0.0") + "/s", net < 0 ? "small bad" : net > 0 ? "small good" : "small muted");
            }
        }

        void CommandBreakdown()
        {
            L("Units", "heading", popover);
            L("Command capacity", "small muted", popover);
            var capacity = Econ?["capacity"];
            int used = ProtocolDecoder.Int(capacity?["used"]), queued = ProtocolDecoder.Int(capacity?["queued"]), cap = ProtocolDecoder.Int(capacity?["limit"]);
            bool hasReserved = capacity?["reserved"] != null;
            int reserved = hasReserved ? ProtocolDecoder.Int(capacity["reserved"]) : queued;
            PopRow("In the field", used.ToString(), "small");
            PopRow("Reserved in production", reserved.ToString(), "small");
            if (hasReserved && queued > reserved) PopRow("Queued, not yet reserved", (queued - reserved).ToString(), "small muted");
            PopRow("Capacity", cap.ToString(), "small");
            PopRow("Free", Mathf.Max(0, cap - used - Mathf.Max(reserved, queued)).ToString(), "small muted");
            int tier = Mathf.Clamp(Age, 0, 2);
            string[] numerals = { "I", "II", "III" };
            string tierLine = $"Faction Tier {numerals[tier]} · cap {cap}" + (tier < 2 ? $" → Tier {numerals[tier + 1]}" : "");
            var tl = L(tierLine, "small muted", popover);
            tl.style.whiteSpace = WhiteSpace.Normal;
            var techs = Econ?["techs"] as JArray;
            if (techs != null && techs.Count > 0)
            {
                L("Upgrades", "small muted", popover).style.marginTop = 4;
                // one per unit class (2026-11-18): a lined upgrade names its path ("Hand Grenades (infantry path)")
                var names = techs.Select(t =>
                {
                    string line = ProtocolDecoder.UpgradeLineName(ProtocolDecoder.UpgradeLine(Defs?["TECHS"]?[(string)t]));
                    return NameOf("TECHS", (string)t) + (line != null ? $" ({line.ToLowerInvariant()} path)" : "");
                }).ToList();
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
            toast = UiKit.Fx(L("", "se-toast", root), "se-fx--cdown");   // slides down in, fades out
            toast.pickingMode = PickingMode.Ignore;
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
            UiKit.SetShown(toast, showToast);
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
            // the dimmer fades in and the frame pops (SE.uss .se-dimmer.se-fx); it fades out before it is removed
            pauseDimmer = UiKit.Fx(El("se-dimmer", root), "se-fx--fade");
            UiKit.Show(pauseDimmer);
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
            UiKit.HideAndRemove(pauseDimmer);
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
            if (popover != null && UiKit.IsShown(popover)) { ClosePopover(); return; }
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
            UpdateClock();
            TweenResources(time);
            UpdateChipHover();
            // clicking the world closes a pinned popover
            if (popoverPinned && Input.InputFacade.LeftDown && !IsPointerOverUi(Input.InputFacade.MousePosition)) ClosePopover();
        }
    }
}
