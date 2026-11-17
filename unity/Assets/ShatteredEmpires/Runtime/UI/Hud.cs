using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Session;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The interface, built with UI Toolkit. The world stays the focus: a compact top bar, a rail of
    /// tools, one contextual card for the selection, panels that open beside the world, and a quiet
    /// alert feed. Text refreshes four times a second; nothing is rebuilt unless what it shows changed.
    /// Training follows the Halo Wars model: select any number of production buildings and queue units
    /// once; the order is shared across all of them.
    /// </summary>
    public sealed partial class Hud
    {
        readonly VisualElement root;
        readonly ClientSession session;
        readonly Commander commander;
        readonly Military.UnitRenderer units;
        readonly IGameActions game;
        readonly JArray catalogue;

        VisualElement topbar, resRow, rail, panel, card, feed, banner, tooltip, coach, highlight, pointer;
        Label bannerText, coachText, focusPill;
        MainMenuView mainMenu;
        string openPanel = "";
        string panelTab = "";
        float refreshAt, bannerUntil;
        int quantity = 1;
        string cardSignature = "", panelSignature = "";
        long noteCount;
        public bool MenuVisible => mainMenu != null && mainMenu.Visible;

        public Hud(VisualElement rootElement, ClientSession s, Commander c, Military.UnitRenderer u, IGameActions actions)
        {
            root = rootElement; session = s; commander = c; units = u; game = actions;
            // one shared sheet (tokens and shell) then each owner's sheet; a missing sheet is skipped
            foreach (var path in new[] { "UI/SE", "UI/SE.Command", "UI/SE.Minimap", "UI/SE.Menu" })
            {
                var sheet = Resources.Load<StyleSheet>(path);
                if (sheet != null && !root.styleSheets.Contains(sheet)) root.styleSheets.Add(sheet);
            }
            root.pickingMode = PickingMode.Ignore;
            // Interface feedback for every button, wherever it was built: a click on press and a very
            // quiet tick when the pointer moves onto a different enabled button.
            root.RegisterCallback<ClickEvent>(e => { if (FindButton(e.target) != null) game?.Audio?.Ui("click"); }, TrickleDown.TrickleDown);
            root.RegisterCallback<PointerOverEvent>(e =>
            {
                var b = FindButton(e.target);
                if (b == null || b == hovered || !b.enabledInHierarchy) return;
                hovered = b; game?.Audio?.Ui("hover", .5f);
            }, TrickleDown.TrickleDown);
            var text = Resources.Load<TextAsset>("Data/ui_actions");
            catalogue = text != null ? JArray.Parse(text.text) : new JArray();
            Build();
            commander.SelectionChanged += () => { cardSignature = ""; };
            // one ground marker per order (Commander.Markers.cs): green move, red attack move / attack, fading in 1.5 s
            commander.OrderIssued += (kind, point) => Session.Commander.AddOrderMarker(kind, point);
        }

        // ------------------------------------------------------------------ helpers
        static VisualElement El(string cls = null, VisualElement parent = null)
        {
            var e = new VisualElement();
            if (cls != null) foreach (var c in cls.Split(' ')) e.AddToClassList(c);
            parent?.Add(e);
            return e;
        }

        static Label L(string text, string cls = null, VisualElement parent = null)
        {
            var l = new Label(text);
            if (cls != null) foreach (var c in cls.Split(' ')) l.AddToClassList(c);
            parent?.Add(l);
            return l;
        }

        Button hovered;
        static Button FindButton(IEventHandler target)
        {
            for (var e = target as VisualElement; e != null; e = e.parent) if (e is Button b) return b;
            return null;
        }

        /// <summary>A button with an optional icon beside its label (laid out in a row, never overlapping).</summary>
        static Button B(string label, Action click, VisualElement parent = null, string icon = null, string cls = null)
        {
            // in-game buttons never take keyboard focus: Space (jump to alert) and Enter would click them again
            var b = new Button(click) { text = "", focusable = false };
            b.tooltip = DefaultActionTip(label);
            b.AddToClassList("btn");
            if (cls != null) foreach (var c in cls.Split(' ')) b.AddToClassList(c);
            if (icon != null) b.Add(new IconElement(icon));
            if (!string.IsNullOrEmpty(label)) L(label, "label", b);
            parent?.Add(b);
            return b;
        }

        /// <summary>A bounded vertical scroll view (kept for existing callers; same as <see cref="UiKit.BoundedScroll"/>).</summary>
        static ScrollView Scroll(VisualElement into) => UiKit.BoundedScroll(into);

        JObject Defs => session.Defs;
        JObject Econ => session.Econ;

        string NameOf(string table, string key) => ProtocolDecoder.Str(Defs?[table]?[key]?["name"], key);

        static string CostText(JToken cost)
        {
            if (!(cost is JObject o)) return "";
            return string.Join(" · ", o.Properties().Where(p => ProtocolDecoder.Float(p.Value) > 0).Select(p => $"{Mathf.RoundToInt(ProtocolDecoder.Float(p.Value))} {p.Name}"));
        }

        bool Affordable(JToken cost)
        {
            if (!(cost is JObject o) || !(Econ?["res"] is JObject res)) return true;
            foreach (var p in o.Properties()) if (ProtocolDecoder.Float(res[p.Name]) < ProtocolDecoder.Float(p.Value)) return false;
            return true;
        }

        HashSet<string> Techs()
        {
            var set = new HashSet<string>();
            if (Econ?["techs"] is JArray t) foreach (var x in t) set.Add((string)x);
            return set;
        }

        int Age => ProtocolDecoder.Int(Econ?["age"], 0);

        public bool IsPointerOverUi(Vector2 screen)
        {
            if (root.panel == null) return false;
            var p = RuntimePanelUtils.ScreenToPanel(root.panel, new Vector2(screen.x, Screen.height - screen.y));
            var picked = PickCached(p);
            return picked != null && picked != root;
        }

        // One panel pick per frame and point: the bootstrap, the tooltip, the wheel hover and the tool chip all
        // ask where the pointer is; a pick walks the tree (and can force a layout pass), so it is shared.
        int pickFrame = -1;
        Vector2 pickPoint;
        VisualElement pickResult;

        VisualElement PickCached(Vector2 panelPoint)
        {
            if (root.panel == null) return null;
            if (pickFrame == Time.frameCount && pickPoint == panelPoint) return pickResult;
            pickFrame = Time.frameCount; pickPoint = panelPoint;
            pickResult = root.panel.Pick(panelPoint);
            return pickResult;
        }

        Vector2 ToPanel(Vector3 screen) => root.panel == null ? Vector2.zero : RuntimePanelUtils.ScreenToPanel(root.panel, new Vector2(screen.x, Screen.height - screen.y));

        // ------------------------------------------------------------------ layout
        void Build()
        {
            BuildTopBar();   // Hud.Shell.cs: top bar (resource chips, status pill, speed, pause, menu)

            // the legacy ruleset's tool rail (hidden in the action ruleset)
            rail = El("rail", root);
            B("Build", () => Toggle("build"), rail, "build").name = "rail-build";
            B("Army", () => Toggle("army"), rail, "army").name = "rail-army";
            B("Research", () => Toggle("research"), rail, "research").name = "rail-research";
            B("Overview", () => Toggle("overview"), rail, "overview").name = "rail-overview";
            B("Settings", () => Toggle("settings"), rail, "settings").name = "rail-settings";

            panel = El("panel glass", root); panel.style.display = DisplayStyle.None;
            card = El("card glass", root); card.style.display = DisplayStyle.None;
            feed = El("feed", root); feed.pickingMode = PickingMode.Ignore;
            banner = El("banner glass", root); banner.style.display = DisplayStyle.None;
            bannerText = L("", "heading", banner);
            BuildToast();   // Hud.Shell.cs
            tooltip = El("tooltip", root); tooltip.style.display = DisplayStyle.None; tooltip.pickingMode = PickingMode.Ignore;
            coach = El("coach glass", root); coach.style.display = DisplayStyle.None;
            L("Getting started", "heading", coach);
            coachText = L("", "", coach); coachText.style.whiteSpace = WhiteSpace.Normal;
            var coachRow = El("row", coach);
            B("Skip tutorial", () => { tutorialStep = -1; coach.style.display = DisplayStyle.None; PlayerPrefs.SetInt("se.tutorial.done", 1); }, coachRow);
            highlight = El("highlight", root); highlight.pickingMode = PickingMode.Ignore; highlight.style.display = DisplayStyle.None;
            // the tutorial pointer: a drawn triangle (no font glyph)
            pointer = El(null, root); pointer.style.position = Position.Absolute; pointer.pickingMode = PickingMode.Ignore; pointer.style.display = DisplayStyle.None;
            pointer.style.left = 0; pointer.style.top = 0;   // placed with translate (MovePointer)
            pointer.Add(new IconElement("pointer", "se-pointer") { Tint = new Color(0.96f, 0.77f, 0.35f) });
            // the minimap: always shown with the game (both rulesets); it styles itself (SE.Minimap.uss)
            Map = new Minimap(session); Map.style.display = DisplayStyle.None;
            Map.OrderAt = (x, z, queue) => { if (units.Selected.Count > 0) commander.MinimapOrder(x, z, queue); };
            root.Add(Map);
            BuildConsole();   // Hud.Console.cs: the docked minimap console (era, resources, idle, attack banner) and the Build/Terrain dock
            BuildCommandUi();   // Hud.Base.cs (Impl-2): wheels, defense bar, tool chip
            BuildCommandGroups();   // Hud.Command.cs
            // the main menu (MainMenu.cs) with the shared settings view
            mainMenu = new MainMenuView(game, () =>
            {
                var view = new SettingsView(game);
                view.Back = () => mainMenu?.HandleEscape();
                return view;
            });
            mainMenu.style.display = DisplayStyle.None;
            root.Add(mainMenu);
        }

        /// <summary>The minimap (the bootstrap wires its camera hooks); shown whenever the game interface is.</summary>
        public Minimap Map;

        /// <summary>Global shortcuts (remappable): legacy panels and the jump to the latest alert.</summary>
        void Shortcuts()
        {
            if (!session.ActionRts)
            {
                if (Input.InputFacade.Action("build")) Toggle("build");
                if (Input.InputFacade.Action("research")) Toggle("research");
                if (Input.InputFacade.Action("overview")) Toggle("overview");
            }
            if (Input.InputFacade.Action("alert") && session.LastAlertTile >= 0) game.FocusTile(session.LastAlertTile, 22f);
        }

        /// <summary>Opens or closes a legacy side panel (the action ruleset has no side panels).</summary>
        void Toggle(string name)
        {
            if (session.ActionRts) return;
            openPanel = openPanel == name ? "" : name;
            panelTab = "";
            panelSignature = "";
            if (name == "army" && openPanel == "army") { openPanel = "overview"; panelTab = "Armies"; }
            Refresh(true);
        }

        public void ShowGame(bool on)
        {
            var d = on ? DisplayStyle.Flex : DisplayStyle.None;
            bool legacy = session.Welcome != null && !session.ActionRts;
            topbar.style.display = d; feed.style.display = d;
            rail.style.display = on && legacy ? DisplayStyle.Flex : DisplayStyle.None;
            Map.style.display = d;
            if (groupsBar != null && !on) groupsBar.style.display = DisplayStyle.None;
            if (!on) { ClosePauseMenu(false); ClosePopover(); toast.style.display = DisplayStyle.None; }
            ShowCommandUi(on);   // Hud.Base.cs (Impl-2)
            ShowConsole(on);   // Hud.Console.cs
            if (on)
                foreach (var el in new VisualElement[] { topbar, rail, Map })
                {
                    // the interface enters gradually instead of snapping over the world
                    el.style.opacity = 0;
                    var e2 = el; e2.schedule.Execute(() => e2.style.opacity = 1).StartingIn(60);
                }
            if (objectiveLayer != null) objectiveLayer.style.display = on && session.ActionRts ? DisplayStyle.Flex : DisplayStyle.None;
            if (on) ApplyRulesetLayout();
            if (!on) { panel.style.display = DisplayStyle.None; card.style.display = DisplayStyle.None; coach.style.display = DisplayStyle.None; }
            else if (!session.Spectator && (session.ActionRts ? ProtocolDecoder.Int(Econ?["tutorialSite"]) > 0 : PlayerPrefs.GetInt("se.tutorial.done", 0) == 0))
            {
                tutorialStep = 0; stepAt = 0; coachShownStep = -1; coach.style.display = DisplayStyle.Flex;
            }
            else tutorialStep = -1;
        }

        // ------------------------------------------------------------------ strategic badge counts (bible §29)
        readonly List<Label> badgeLabels = new List<Label>();
        readonly List<int> badgeLabelCount = new List<int>();
        readonly List<Vector2> badgeLabelAt = new List<Vector2>();
        VisualElement badgeLayer;

        /// <summary>
        /// Counts beside the strategic badges that stand for several units; pooled, never more than 160. Moved with
        /// translate (no layout pass), text set only when the count changes.
        /// </summary>
        public void BadgeCounts(IList<Military.UnitRenderer.Badge> badges, Func<Unity.Mathematics.float3, Vector3> toScreen)
        {
            if (badgeLayer == null) { badgeLayer = El("se-root", root); badgeLayer.pickingMode = PickingMode.Ignore; badgeLayer.SendToBack(); }
            int used = 0;
            if (!MenuVisible && root.panel != null)
                for (int k = 0; k < badges.Count; k++)
                {
                    var b = badges[k];
                    if (b.Count < 2 || used >= 160) continue;
                    var s = toScreen(b.MapPos);
                    if (s.z <= 0 || s.x < 0 || s.y < 0 || s.x > Screen.width || s.y > Screen.height) continue;
                    if (used >= badgeLabels.Count)
                    {
                        var nl = L("", "badge-count"); nl.pickingMode = PickingMode.Ignore;
                        nl.style.left = 0; nl.style.top = 0; nl.usageHints = UsageHints.DynamicTransform;   // hints before attaching
                        badgeLayer.Add(nl);
                        badgeLabels.Add(nl); badgeLabelCount.Add(-1); badgeLabelAt.Add(new Vector2(float.NaN, float.NaN));
                    }
                    int i = used++;
                    var l = badgeLabels[i];
                    var p = RuntimePanelUtils.ScreenToPanel(root.panel, new Vector2(s.x, Screen.height - s.y));
                    if (badgeLabelCount[i] != b.Count) { badgeLabelCount[i] = b.Count; l.text = b.Count.ToString(); }
                    var at = new Vector2(p.x + 8, p.y - 18);
                    if (!((at - badgeLabelAt[i]).sqrMagnitude <= .0025f)) { badgeLabelAt[i] = at; l.style.translate = new Translate(at.x, at.y); }
                    if (l.style.display != DisplayStyle.Flex) l.style.display = DisplayStyle.Flex;
                }
            for (int i = used; i < badgeLabels.Count; i++) if (badgeLabels[i].style.display != DisplayStyle.None) badgeLabels[i].style.display = DisplayStyle.None;
        }

        // ------------------------------------------------------------------ placement card (bible §28)
        VisualElement placeCard;
        Label placeName, placeCost, placeWhy;
        int placeFor = -2;

        /// <summary>A small card beside the cursor while placing: the building, its cost and build time, or why the site is refused.</summary>
        void PlacementCard()
        {
            int tile = commander.PlacementTile;
            if (tile < 0) { if (placeCard != null) placeCard.style.display = DisplayStyle.None; placeFor = -2; return; }
            if (placeCard == null)
            {
                placeCard = El("place-card glass", root); placeCard.pickingMode = PickingMode.Ignore;
                placeCard.style.left = 0; placeCard.style.top = 0;   // follows the cursor by translate (no layout pass)
                placeName = L("", "heading", placeCard); placeCost = L("", "small", placeCard); placeWhy = L("", "small", placeCard);
                placeWhy.style.whiteSpace = WhiteSpace.Normal;
            }
            var site = commander.PlacementSite;
            int key = tile * 7 + (site == null ? 0 : site.GetHashCode() & 0xffff);
            if (key != placeFor)
            {
                placeFor = key;
                var def = Defs?["BUILDINGS"]?[commander.Option];
                placeName.text = NameOf("BUILDINGS", commander.Option);
                var cost = site?["cost"] ?? def?["cost"];
                int seconds = ProtocolDecoder.Int(site?["seconds"], ProtocolDecoder.Int(def?["time"]));
                placeCost.text = CostText(cost) + (seconds > 0 ? $" · {seconds}s" : "");
                bool valid = commander.PlacementLegal && (site == null || ProtocolDecoder.Bool(site["valid"], true));
                string reason = ProtocolDecoder.Str(site?["reason"]);
                bool queued = ProtocolDecoder.Bool(site?["queued"]);
                placeWhy.text = !valid ? (reason ?? "This parcel is unavailable") : session.ActionRts ? "Click to begin construction" :
                    queued ? "Not enough now: the site will wait for materials" : "Click to place · drag for several · Shift keeps placing";
                placeWhy.EnableInClassList("bad", !valid); placeWhy.EnableInClassList("warn", valid && queued); placeWhy.EnableInClassList("good", valid && !queued);
            }
            placeCard.style.display = DisplayStyle.Flex;
            var mouse = Input.InputFacade.MousePosition;
            var p = RuntimePanelUtils.ScreenToPanel(root.panel, new Vector2(mouse.x, Screen.height - mouse.y));
            // offset so the card never covers the site itself
            placeCard.style.translate = new Translate(Mathf.Min(p.x + 28, root.layout.width - 280), p.y + 24);
        }

        // ------------------------------------------------------------------ loading and the title card
        VisualElement loading, titleCard;
        Label titleMain, titleSub;
        readonly List<Label> loadingSteps = new List<Label>();
        static readonly string[] LoadingStages = { "Connecting to the server", "Generating the world", "Synchronising the world", "Building the landscape", "Entering the match" };

        /// <summary>The loading screen: a quiet strip of real stages over the world (stage −1 hides it).</summary>
        public void ShowLoading(int stage)
        {
            if (loading == null)
            {
                loading = El("loading glass", root);
                L("SHATTERED EMPIRES", "loading-title", loading);
                foreach (var s in LoadingStages) loadingSteps.Add(L(s, "loading-step", loading));
                var bar = El("loading-bar", loading); El("loading-bar-run", bar);
            }
            loading.style.display = stage < 0 ? DisplayStyle.None : DisplayStyle.Flex;
            for (int i = 0; i < loadingSteps.Count; i++)
            {
                loadingSteps[i].EnableInClassList("done", i < stage);
                loadingSteps[i].EnableInClassList("current", i == stage);
            }
        }

        /// <summary>The restrained title card of the opening descent: the era and the year, the nation beneath.</summary>
        public void ShowTitleCard(string main, string sub)
        {
            if (titleCard == null)
            {
                titleCard = El("title-card", root); titleCard.pickingMode = PickingMode.Ignore;
                titleMain = L("", "title-card-main", titleCard);
                titleSub = L("", "title-card-sub", titleCard);
            }
            titleMain.text = main; titleSub.text = sub;
            titleCard.style.display = DisplayStyle.Flex;
            titleCard.style.opacity = 0;
        }

        public void TitleCardOpacity(float a)
        {
            if (titleCard == null) return;
            titleCard.style.opacity = a;
            titleCard.style.display = a <= 0.001f ? DisplayStyle.None : DisplayStyle.Flex;
        }

        public void ShowMenu(bool on, string status = "")
        {
            if (on) ShowLoading(-1);
            mainMenu.Show(on, status);
            if (on) mainMenu.BringToFront();
            if (on) ShowGame(false);
        }

        /// <summary>A server 'room' message (match lobby) for the main menu's lobby page.</summary>
        public void ShowLobby(JObject room) => mainMenu.ShowLobby(room);

        /// <summary>Review captures: open one main-menu page ("root", "skirmish", "multiplayer", "lobby", "training", "settings", "guide").</summary>
        public void ReviewMenuPage(string page) => mainMenu.ReviewPage(page);

        // ------------------------------------------------------------------ per frame
        public void Update(float time)
        {
            UpdateRuntimeHelp(time);
            // no game keys while a text field (search, chat, code) has focus or a shortcut is being rebound
            Input.InputFacade.Typing = root.panel?.focusController?.focusedElement is TextField || SettingsView.Capturing;
            if (MenuVisible)
            {
                if (Input.InputFacade.Pressed(KeyCode.Escape) && !SettingsView.Capturing) mainMenu.HandleEscape();
                return;
            }
            if (!session.Ready) return;
            UpdateShell(time);   // Hud.Shell.cs: clock, chip hover, popover
            if (session.ActionRts) UpdateConsole(time);   // Hud.Console.cs: minimap console and dock
            UpdateToast(time);
            if (time > bannerUntil) banner.style.display = DisplayStyle.None;
            if (Map.resolvedStyle.display != DisplayStyle.None) Map.Tick(time);
            PlacementCard();
            if (Input.InputFacade.Pressed(KeyCode.Escape)) HandleEscape();
            if (session.ActionRts) UpdateCommandUi(time);   // Hud.Base.cs (Impl-2)
            if (Input.InputFacade.Action("pause") && !commander.PatrolKeyClaimed) TogglePause();   // P patrols when aircraft are selected (D)
            SpeedHotkeys();
            UpdateCommandGroups(time);
            Shortcuts();
            TileReadout();
            if (session.ActionRts) ActionTutorial(time); else Tutorial(time);
            if (time < refreshAt) return;
            refreshAt = time + 0.25f;
            Refresh(false);
        }

        // ------------------------------------------------------------------ tile readout (only while Alt is held)
        Label tileInfo;
        int tileInfoFor = -2;

        void TileReadout()
        {
            if (tileInfo == null)
            {
                tileInfo = new Label(""); tileInfo.AddToClassList("tooltip"); tileInfo.AddToClassList("small");
                tileInfo.pickingMode = PickingMode.Ignore; tileInfo.style.position = Position.Absolute; tileInfo.style.display = DisplayStyle.None;
                tileInfo.style.left = 0; tileInfo.style.top = 0;
                root.Add(tileInfo);
            }
            var mouse = Input.InputFacade.MousePosition;
            if (!Input.InputFacade.Alt || IsPointerOverUi(mouse)) { tileInfo.style.display = DisplayStyle.None; tileInfoFor = -2; return; }
            int t = commander.HoverTile();
            if (t < 0 || session.World.Known[t] == 0) { tileInfo.style.display = DisplayStyle.None; return; }
            if (t != tileInfoFor)
            {
                tileInfoFor = t;
                var w = session.World;
                var sb = new System.Text.StringBuilder();
                string terrain = TerrainName(w.Terrain[t], w.Biome[t]);
                sb.Append(terrain);
                if (w.IsRiver(t)) sb.Append(" · river");
                if ((w.GeoFlags[t] & 128) != 0) sb.Append(" · stream");
                int owner = w.Owner[t];
                sb.Append('\n').Append(owner < 0 ? "Unclaimed" : owner == session.CivId ? "Your territory" : CivName(owner) + " territory");
                if (w.Resource[t] != 0) sb.Append('\n').Append("Resource: ").Append(ResourceName(w.Resource[t]));
                int roads = 0, best = 0;
                for (int d = 0; d < 6; d++) { int c = w.RoadClass(t, d); if (c != 0) { roads++; best = Math.Max(best, c); } }
                if (roads > 0) sb.Append('\n').Append(best switch { 1 => "Dirt road", 2 => "Paved road", 3 => "Highway", _ => "Railway" }).Append(roads >= 3 ? " junction" : "");
                if (w.IsUrban(t)) sb.Append('\n').Append("Developed district");
                tileInfo.text = sb.ToString();
            }
            tileInfo.style.display = DisplayStyle.Flex;
            var panelPos = RuntimePanelUtils.ScreenToPanel(root.panel, new Vector2(mouse.x, Screen.height - mouse.y));
            tileInfo.style.translate = new Translate(panelPos.x + 18, panelPos.y + 12);   // follows the cursor: no layout pass
        }

        // server constants.js T / TERRAIN and RES / RESOURCE (the definitions win when the server sends them)
        string TerrainName(int terrain, int biome)
        {
            if (Defs?["TERRAIN"] is JArray defs && terrain >= 0 && terrain < defs.Count) return ProtocolDecoder.Str(defs[terrain]?["name"], "Land");
            string[] names = { "Deep Ocean", "Shallow Sea", "Grassland", "Plains", "Forest", "Desert", "Tundra", "Marsh", "Hills", "Mountains", "Peaks", "Lava", "Ash" };
            return terrain >= 0 && terrain < names.Length ? names[terrain] : "Land";
        }

        string ResourceName(int r)
        {
            if (Defs?["RESOURCE"] is JArray defs && r >= 0 && r < defs.Count) return ProtocolDecoder.Str(defs[r]?["name"], "Deposit");
            string[] names = { "", "Oil field", "Iron ore", "Coal", "Rare earths", "Stone", "Fish", "Old-world ruins" };
            return r >= 0 && r < names.Length ? names[r] : "Deposit";
        }

        string CivName(int id)
        {
            foreach (var c in session.Welcome?.Civs ?? Array.Empty<CivInfo>()) if (c.Id == id) return c.Name;
            return "Foreign";
        }

        static readonly string[] RailNames = { "build", "army", "research", "overview", "settings" };
        Button[] railButtons;

        void Refresh(bool force)
        {
            // the rail shows which panel is open (legacy ruleset only: the rail is hidden in action matches)
            if (!session.ActionRts || force)
            {
                if (railButtons == null)
                {
                    railButtons = new Button[RailNames.Length];
                    for (int i = 0; i < RailNames.Length; i++) railButtons[i] = rail.Q<Button>("rail-" + RailNames[i]);
                }
                for (int i = 0; i < RailNames.Length; i++)
                {
                    string name = RailNames[i];
                    railButtons[i]?.EnableInClassList("selected", openPanel == name || (name == "army" && openPanel == "overview" && panelTab == "Armies"));
                }
            }
            UpdateTopBar();   // Hud.Shell.cs: action chips or the legacy goods, status pill, right group
            Notes();
            if (session.ActionRts) ActionCard(force);
            else { Card(force); Panel(force); }
        }

        // ------------------------------------------------------------------ top bar: what you have, what flows, what is short
        static readonly string[] Goods = { "food", "materials", "ore", "steel", "fuel", "electronics", "munitions", "credits" };
        readonly Dictionary<string, (VisualElement box, Label amount, Label rate)> resEls = new Dictionary<string, (VisualElement, Label, Label)>();
        Label powerLabel, peopleLabel, eraLabel, eraNext;
        VisualElement powerFill;

        void TopBar()
        {
            var res = Econ?["res"] as JObject;
            var rates = Econ?["rates"] as JObject;
            var reports = Econ?["resources"] as JArray;
            string worst = null;
            // the era, always in view (with how far the next one is)
            if (eraLabel == null)
            {
                var eraBox = new VisualElement(); eraBox.AddToClassList("era-pill");
                eraLabel = L("", "era-name", eraBox);
                eraNext = L("", "era-next", eraBox);
                topLeft.Insert(0, eraBox);
            }
            // action matches show tier on the base itself (markers, wheel hub pips, base dressing), not in the top bar
            eraLabel.parent.style.display = session.ActionRts ? DisplayStyle.None : DisplayStyle.Flex;
            var ages = Defs?["AGES"] as JArray;
            eraLabel.text = ProtocolDecoder.Str(ages?[Age]?["name"], "Era " + (Age + 1)).ToUpperInvariant();
            if (ages != null && Age + 1 < ages.Count)
            {
                int need = ProtocolDecoder.Int(ages[Age + 1]["techsNeeded"]);
                int have = 0;
                var techs = Techs();
                if (Defs?["TECHS"] is JObject all) foreach (var p in all.Properties()) if (ProtocolDecoder.Int(p.Value["age"]) == Age && techs.Contains(p.Name)) have++;
                eraNext.text = $"{Math.Min(have, need)}/{need} techs to {ProtocolDecoder.Str(ages[Age + 1]["name"], "next era")}";
            }
            else eraNext.text = "";
            foreach (var g in Goods)
            {
                if (res == null || res[g] == null) continue;
                if (!resEls.TryGetValue(g, out var el))
                {
                    var box = El("res", resRow);
                    var dot = El("dot", box); dot.style.backgroundColor = Icons.ResourceColor(g);
                    var amount = L("", "amount", box);
                    var rate = L("", "rate", box);
                    string good = g;
                    box.RegisterCallback<PointerEnterEvent>(e => ShowResourceTip(good, box));
                    box.RegisterCallback<PointerLeaveEvent>(e => tooltip.style.display = DisplayStyle.None);
                    el = (box, amount, rate);
                    resEls[g] = el;
                }
                el.amount.text = Mathf.RoundToInt(ProtocolDecoder.Float(res[g])).ToString();
                float r = ProtocolDecoder.Float(rates?[g]);
                el.rate.text = Mathf.Abs(r) < 0.05f ? "" : (r > 0 ? "+" : "") + r.ToString("0.#");
                el.rate.EnableInClassList("good", r > 0.05f); el.rate.EnableInClassList("bad", r < -0.05f);
                var report = reports?.FirstOrDefault(x => (string)x["good"] == g);
                string status = (string)report?["status"] ?? "ok";
                el.box.EnableInClassList("short", status == "empty" || status == "deficit");
                if ((status == "empty" || status == "deficit") && worst == null) worst = ProtocolDecoder.Str(report?["title"], g);
            }
            // power: generation against use, at a glance
            if (powerLabel == null)
            {
                var box = El("res", resRow);
                var dot = El("dot", box); dot.style.backgroundColor = Icons.ResourceColor("power");
                powerLabel = L("", "amount", box);
                var gauge = El("gauge", box); powerFill = El("gauge-fill", gauge);
                box.RegisterCallback<PointerEnterEvent>(e => ShowPowerTip(box));
                box.RegisterCallback<PointerLeaveEvent>(e => tooltip.style.display = DisplayStyle.None);
                var pbox = El("res", resRow);
                L("People", "muted", pbox);
                peopleLabel = L("", "amount", pbox);
                pbox.RegisterCallback<PointerEnterEvent>(e => ShowPeopleTip(pbox));
                pbox.RegisterCallback<PointerLeaveEvent>(e => tooltip.style.display = DisplayStyle.None);
            }
            int gen = ProtocolDecoder.Int(Econ?["power"]?["gen"]), use = ProtocolDecoder.Int(Econ?["power"]?["use"]);
            powerLabel.text = $"{use}/{gen}";
            powerLabel.EnableInClassList("bad", use > gen);
            powerFill.style.width = new Length(gen > 0 ? Mathf.Clamp01(use / (float)gen) * 100f : (use > 0 ? 100f : 0f), LengthUnit.Percent);
            powerFill.style.backgroundColor = use > gen ? new Color(0.9f, 0.35f, 0.25f) : use > gen * 0.85f ? new Color(0.95f, 0.75f, 0.3f) : new Color(0.55f, 0.85f, 0.45f);
            if (use > gen && worst == null) worst = "power";
            int pop = 0, jobs = 0, idle = 0;
            foreach (var city in session.Structures.Cities.Values) if (city.Owner == session.CivId) { pop += Mathf.RoundToInt(city.Pop); jobs += city.Jobs; idle += city.Unemployed; }
            peopleLabel.text = $"{pop}" + (idle > 0 ? $" ({idle} idle)" : jobs > pop ? " (short of workers)" : "");
            if (jobs > pop * 1.1f && worst == null) worst = "workers";
            focusPill.style.display = worst != null ? DisplayStyle.Flex : DisplayStyle.None;
            focusPill.text = worst != null ? "Short of " + worst.ToLowerInvariant() : "";
            var invite = topbar.Q<Button>("invite");
            if (invite != null) invite.style.display = game.CanInvite ? DisplayStyle.Flex : DisplayStyle.None;
        }

        void PlaceTip(VisualElement anchor)
        {
            var wb = anchor.worldBound;
            tooltip.style.left = Mathf.Max(8, Mathf.Min(wb.xMin, root.layout.width - TooltipWidth() - 8));
            tooltip.style.top = wb.yMax + 6;
            tooltip.style.display = DisplayStyle.Flex;
        }

        /// <summary>What produces and what consumes a resource, why it is short, and what to do.</summary>
        void ShowResourceTip(string good, VisualElement anchor)
        {
            tooltip.Clear();
            var r = (Econ?["resources"] as JArray)?.FirstOrDefault(x => (string)x["good"] == good) as JObject;
            L(ProtocolDecoder.Str(r?["title"], good), "heading", tooltip);
            if (r == null) { L("No report yet.", "muted", tooltip); PlaceTip(anchor); return; }
            Flow("In stock", $"{r["stock"]}" + (ProtocolDecoder.Int(r["reserved"]) > 0 ? $" ({r["reserved"]} reserved)" : ""));
            Flow("Net per second", ProtocolDecoder.Float(r["net"]).ToString("+0.##;-0.##;0"));
            if (r["lasts"] != null && r["lasts"].Type != JTokenType.Null) Flow("Runs out in", $"{Mathf.RoundToInt(ProtocolDecoder.Float(r["lasts"]) / 60f)} min");
            if (r["cats"] is JObject cats && cats.Count > 0)
            {
                L("Where it goes", "muted", tooltip);
                foreach (var p in cats.Properties().OrderBy(p => ProtocolDecoder.Float(p.Value))) Flow("  " + p.Name, ProtocolDecoder.Float(p.Value).ToString("+0.##;-0.##;0"));
            }
            if (r["producers"] is JArray prod && prod.Count > 0)
            {
                L("Produced by", "muted", tooltip);
                foreach (var p in prod.Take(4)) Flow("  " + ProtocolDecoder.Str(p["name"], ""), $"{p["count"] ?? p["built"]} built");
            }
            if (r["consumers"] is JArray cons && cons.Count > 0)
            {
                L("Used by", "muted", tooltip);
                foreach (var p in cons.Take(5)) Flow("  " + ProtocolDecoder.Str(p["name"], ""), $"{p["count"]} · {ProtocolDecoder.Float(p["rate"]):0.##}/s");
            }
            if (r["blocked"] is JArray bl && bl.Count > 0) L("Waiting for it: " + string.Join(", ", bl.Select(x => (string)x)), "warn small", tooltip).style.whiteSpace = WhiteSpace.Normal;
            string head = ProtocolDecoder.Str(r["headline"], ""), cause = ProtocolDecoder.Str(r["cause"], "");
            if (head.Length + cause.Length > 0) L((head + " " + cause).Trim(), "warn small", tooltip).style.whiteSpace = WhiteSpace.Normal;
            if (r["actions"] is JArray acts && acts.Count > 0) L("Try: " + string.Join("; ", acts.Take(3).Select(a => ProtocolDecoder.Str(a["label"], ""))), "good small", tooltip).style.whiteSpace = WhiteSpace.Normal;
            PlaceTip(anchor);
        }

        void ShowPowerTip(VisualElement anchor)
        {
            tooltip.Clear();
            L("Power", "heading", tooltip);
            int gen = ProtocolDecoder.Int(Econ?["power"]?["gen"]), use = ProtocolDecoder.Int(Econ?["power"]?["use"]);
            Flow("Generated", gen.ToString());
            Flow("Used", use.ToString());
            Flow("Spare", (gen - use).ToString());
            var plants = new Dictionary<string, int>(); var users = new Dictionary<string, int>();
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (b.Owner != session.CivId || !b.Done) continue;
                var def = Defs?["BUILDINGS"]?[b.Type];
                if (ProtocolDecoder.Float(def?["power"]) > 0) plants[b.Type] = plants.TryGetValue(b.Type, out int n) ? n + 1 : 1;
                else if (ProtocolDecoder.Bool(def?["needsPower"]) || b.Why == "power" || ProtocolDecoder.Float(def?["powerUse"]) > 0) users[b.Type] = users.TryGetValue(b.Type, out int m) ? m + 1 : 1;
            }
            if (plants.Count > 0) { L("Plants", "muted", tooltip); foreach (var kv in plants) Flow("  " + NameOf("BUILDINGS", kv.Key), $"{kv.Value} × {ProtocolDecoder.Float(Defs?["BUILDINGS"]?[kv.Key]?["power"])}"); }
            if (users.Count > 0) { L("Using power", "muted", tooltip); foreach (var kv in users) Flow("  " + NameOf("BUILDINGS", kv.Key), kv.Value.ToString()); }
            int dark = session.Structures.Buildings.Values.Count(b => b.Owner == session.CivId && b.Why == "power");
            if (dark > 0) L($"{dark} buildings are idle for lack of power: build a power plant.", "bad small", tooltip).style.whiteSpace = WhiteSpace.Normal;
            else if (use > gen * 0.85f) L("Close to the limit: plan another plant before you add industry.", "warn small", tooltip).style.whiteSpace = WhiteSpace.Normal;
            PlaceTip(anchor);
        }

        void ShowPeopleTip(VisualElement anchor)
        {
            tooltip.Clear();
            L("People and work", "heading", tooltip);
            foreach (var c in session.Structures.Cities.Values.Where(c => c.Owner == session.CivId))
                Flow(c.Name, $"{Mathf.RoundToInt(c.Pop)} people · {c.Jobs} jobs · {c.Unemployed} idle · homes {c.Housing}");
            int unstaffed = session.Structures.Buildings.Values.Count(b => b.Owner == session.CivId && b.Done && b.Why == "staff");
            if (unstaffed > 0) L($"{unstaffed} buildings lack workers: grow housing (Guide Growth → Housing) or pause less important work.", "warn small", tooltip).style.whiteSpace = WhiteSpace.Normal;
            PlaceTip(anchor);
        }

        void Flow(string a, string b)
        {
            var row = El("flow-row", tooltip);
            L(a, "small", row); L(b, "small", row);
        }

        // ------------------------------------------------------------------ alerts: quiet unless it matters
        void Notes()
        {
            // three tiers (target spec §30): critical interrupts with a banner; major is a compact,
            // actionable notice (Go there); everything else goes to the chronicle only. Concluded
            // battles and other outcomes get a result card.
            var notes = session.Notes;
            long total = session.NotesTotal;
            if (total == noteCount) return;
            long first = total - notes.Count;   // the index of notes[0] in the running count
            for (long k = Math.Max(noteCount, first); k < total; k++)
            {
                int i = (int)(k - first);
                var (t, text, level) = notes[i];
                var meta = i < session.NoteMeta.Count ? session.NoteMeta[i] : default;
                if (text.StartsWith("(earlier)")) continue;
                bool outcome = meta.Kind == "result" || !string.IsNullOrEmpty(meta.Title);
                if (outcome && !session.ActionRts) ResultCard(meta.Title ?? "Outcome", text, meta.Tile);
                if (level != "critical" && level != "major" && !(outcome && session.ActionRts)) continue;
                int tile = meta.Tile;
                string title = meta.Title ?? "Outcome", body = text;
                bool critical = level == "critical";
                // one row: severity bar · text (two lines at most) · Go; clicking the text also acts
                var n = El("se-note" + (critical ? " se-note--critical" : ""), feed);
                El("se-note-bar", n).pickingMode = PickingMode.Ignore;
                var label = L(text, "se-note-text", n);
                label.pickingMode = PickingMode.Ignore;
                n.RegisterCallback<ClickEvent>(e =>
                {
                    if (outcome && session.ActionRts) ResultCard(title, body, tile);
                    else if (tile >= 0) game.FocusTile(tile, 22f);
                });
                if (tile >= 0)
                {
                    var go = UiKit.IconButton("target", () => game.FocusTile(tile, 22f), "Go there (Space)", n, 28);
                    go.RegisterCallback<ClickEvent>(e => e.StopPropagation());
                    if (critical || level == "major") Map.Ping(tile);
                }
                n.schedule.Execute(() => n.RemoveFromHierarchy()).StartingIn(8000);
                if (critical) { bannerText.text = text; banner.style.display = DisplayStyle.Flex; bannerUntil = now + 4f; }
                while (feed.childCount > 3) feed.RemoveAt(0);
            }
            noteCount = total;
        }

        VisualElement resultCard;

        /// <summary>A concise outcome card (battle won or lost, a city taken…): title, summary, Go there, dismiss.</summary>
        void ResultCard(string title, string text, int tile)
        {
            resultCard?.RemoveFromHierarchy();
            resultCard = El("result-card glass", root);
            L(title, "title", resultCard);
            L(text, "", resultCard).style.whiteSpace = WhiteSpace.Normal;
            var row = El("row", resultCard);
            if (tile >= 0) B("Go there", () => { game.FocusTile(tile, 22f); resultCard?.RemoveFromHierarchy(); }, row, null, "primary");
            B("Dismiss", () => resultCard?.RemoveFromHierarchy(), row);
            var card0 = resultCard;
            card0.schedule.Execute(() => card0.RemoveFromHierarchy()).StartingIn(15000);
        }

        // ------------------------------------------------------------------ contextual card
        void Card(bool force)
        {
            string sig = $"{units.Selected.Count}|{string.Join(",", commander.SelectedBuildings)}|{commander.SelectedCity}|{quantity}|{session.Structures.Revision}|{session.Units.MembershipRevision}";
            if (!force && sig == cardSignature) { UpdateCardLive(); return; }
            cardSignature = sig;
            card.Clear();
            if (commander.SelectedCity >= 0 && session.Structures.Cities.TryGetValue(commander.SelectedCity, out var city)) CityCard(city);
            else if (commander.SelectedBuildings.Count > 0) BuildingCard();
            else if (units.Selected.Count > 0) UnitCard();
            card.style.display = card.childCount > 0 ? DisplayStyle.Flex : DisplayStyle.None;
        }

        readonly List<(Label label, Func<string> text)> live = new List<(Label, Func<string>)>();
        void UpdateCardLive() { foreach (var (l, f) in live) l.text = f(); }

        void UnitCard()
        {
            live.Clear();
            var counts = new Dictionary<string, int>();
            float hp = 0; int n = 0;
            foreach (var id in units.Selected)
                if (session.Units.TryGet(id, out var r)) { var t = session.Units.Types.Name(r.TypeIndex); counts[t] = counts.TryGetValue(t, out int c) ? c + 1 : 1; hp += r.Hp; n++; }
            var head = El("row", card);
            L($"{n} unit{(n == 1 ? "" : "s")} selected", "heading grow", head);
            var cond = L("", "muted", head);
            live.Add((cond, () => $"condition {Mathf.RoundToInt(AvgHp())}%"));
            var row = El("row wrap", card);
            foreach (var kv in counts.OrderByDescending(k => k.Value))
            {
                var b = El("queue-item", row);
                b.Add(new IconElement(kv.Key));
                L(kv.Value.ToString(), "count", b);
                b.tooltip = NameOf("UNITS", kv.Key);
            }
            var orders = El("row wrap", card);
            B("Attack-move", () => commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "move", ["units"] = "@units", ["tile"] = "@map", ["attackMove"] = true }), orders);
            B("Hold (H)", () => commander.UnitCommand("hold", null, "Holding position"), orders);
            B("Stop", () => commander.UnitCommand("stop", null, "Orders cleared"), orders);
            B("Withdraw (X)", () => commander.UnitCommand("withdraw", null, "Withdrawing"), orders);
            B("Dig in", () => commander.UnitCommand("fortify", null, "Digging in"), orders, "trench");
            B("Explore", () => commander.UnitCommand("stance", new JObject { ["stance"] = "explore" }, "Exploring on their own"), orders);
            B("Defend", () => commander.UnitCommand("stance", new JObject { ["stance"] = "defensive" }, "Defending"), orders);
            B("Form army", () => commander.UnitCommand("army", new JObject { ["op"] = "create", ["name"] = "New Army" }, "Army formed"), orders, "army");
        }

        float AvgHp()
        {
            float hp = 0; int n = 0;
            foreach (var id in units.Selected) if (session.Units.TryGet(id, out var r)) { hp += r.Hp; n++; }
            return n > 0 ? hp / n : 0;
        }

        void BuildingCard()
        {
            live.Clear();
            var list = commander.SelectedBuildings.Where(id => session.Structures.Buildings.ContainsKey(id)).Select(id => session.Structures.Buildings[id]).ToList();
            if (list.Count == 0) return;
            var trainers = list.Where(b => b.Done && b.Owner == session.CivId && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray t && t.Count > 0).ToList();
            var first = list[0];
            var head = El("row", card);
            head.Add(new IconElement(Icons.BuildingKind(first.Type)));
            L(list.Count == 1 ? NameOf("BUILDINGS", first.Type) : $"{list.Count} buildings selected", "heading grow", head);
            if (list.Count == 1)
            {
                var b = first;
                string state = !b.Done ? $"under construction {b.Progress}%" : b.Hp < 100 ? $"damaged ({b.Hp}%)" : "operational";
                if (b.WorksKind != null) state += $" · {b.WorksKind} {b.WorksPct}%";
                if (b.Why != null && b.Done) state += $" · {WhyText(b.Why)}";
                L(state, "muted", card);
                var row = El("row wrap", card);
                if (b.Owner == session.CivId && b.Done && b.UpgradeCost != null) B($"Upgrade ({CostText(b.UpgradeCost)})", () => Cmd(new JObject { ["c"] = "upgrade", ["id"] = b.Id }, "Upgrade under way"), row);
                if (b.Owner == session.CivId && b.Done && b.RepairCost > 0) B($"Repair ({b.RepairCost} materials)", () => Cmd(new JObject { ["c"] = "repair", ["id"] = b.Id }, "Repairs started"), row);
                if (b.Owner == session.CivId && !b.Done) B("Build next", () => Cmd(new JObject { ["c"] = "buildNext", ["id"] = b.Id }, "Moved to the front of the queue"), row);
                if (b.Owner == session.CivId) B("Demolish", () => Cmd(new JObject { ["c"] = "demolish", ["id"] = b.Id }, "Demolished"), row);
            }
            if (trainers.Count > 0) TrainingPanel(trainers);
        }

        static string WhyText(string w) => w == "staff" ? "no workers" : w == "power" ? "no power" : w == "full" ? "storage full" : w.StartsWith("input:") ? "missing " + w.Substring(6) : w;

        /// <summary>
        /// Halo Wars-style training: one grid of every unit the selected buildings can make; a click
        /// queues the chosen quantity spread across all of them (the server balances it); right-click
        /// cancels one. The queue shows stacked counts, not a long list.
        /// </summary>
        void TrainingPanel(List<BuildingRecord> trainers)
        {
            var techs = Techs();
            int age = Age;
            var types = new List<string>();
            foreach (var b in trainers)
                foreach (var t in (JArray)Defs["BUILDINGS"][b.Type]["trains"])
                    if (!types.Contains((string)t)) types.Add((string)t);
            var qrow = El("row", card);
            L(trainers.Count > 1 ? $"Train across {trainers.Count} buildings" : "Train", "muted grow", qrow);
            foreach (var q in new[] { 1, 5, 10 })
            {
                int qq = q;
                var b = B("×" + q, () => { quantity = qq; cardSignature = ""; }, qrow);
                b.EnableInClassList("selected", quantity == q);
            }
            B("Rally point", () => commander.Begin(Commander.Mode.Rally), qrow);
            var grid = El("train-grid", card);
            var ids = new JArray(trainers.Select(b => b.Id).ToArray());
            foreach (var type in types)
            {
                var def = Defs?["UNITS"]?[type];
                string tech = ProtocolDecoder.Str(def?["tech"]);
                bool unlocked = (tech == null || techs.Contains(tech)) && ProtocolDecoder.Int(def?["age"]) <= age;
                string t = type;
                var btn = new Button(() =>
                {
                    Cmd(new JObject { ["c"] = "batchTrain", ["buildings"] = ids, ["unit"] = t, ["count"] = quantity, ["policy"] = "partial" }, $"Queued {quantity} × {NameOf("UNITS", t)}");
                }) { text = "" };
                btn.AddToClassList("btn"); btn.AddToClassList("train-btn");
                btn.Add(new IconElement(type));
                L(NameOf("UNITS", type), "label", btn);
                L(CostText(def?["cost"]), "cost", btn);
                int queued = trainers.Sum(b => b.Queue?.Count(x => x == type) ?? 0);
                if (queued > 0) L(queued.ToString(), "badge", btn);
                btn.SetEnabled(unlocked);
                if (!unlocked) btn.tooltip = tech != null ? "Research " + NameOf("TECHS", tech) : "A later era";
                btn.RegisterCallback<PointerDownEvent>(e =>
                {
                    if (e.button != 1) return;
                    // right-click: cancel the most recently queued one of this type
                    foreach (var b in trainers)
                    {
                        int idx = b.Queue == null ? -1 : Array.LastIndexOf(b.Queue, t);
                        if (idx >= 0) { Cmd(new JObject { ["c"] = "cancelTrain", ["building"] = b.Id, ["index"] = idx }, "Cancelled one"); break; }
                    }
                }, TrickleDown.TrickleDown);
                grid.Add(btn);
            }
            // the combined queue, stacked by type
            var queue = El("queue", card);
            var stacked = new Dictionary<string, int>();
            foreach (var b in trainers) if (b.Queue != null) foreach (var x in b.Queue) stacked[x] = stacked.TryGetValue(x, out int c) ? c + 1 : 1;
            foreach (var kv in stacked)
            {
                var it = El("queue-item", queue);
                it.Add(new IconElement(kv.Key));
                L(kv.Value.ToString(), "count", it);
            }
            if (stacked.Count > 0)
            {
                var prog = El("progress", card); var fill = El("progress-fill", prog);
                fill.style.width = new Length(trainers.Max(b => b.TrainProgress), LengthUnit.Percent);
                var r = El("row", card);
                B("Clear queues", () => Cmd(new JObject { ["c"] = "clearQueue", ["buildings"] = ids }, "Queues cleared"), r);
            }
        }

        void CityCard(CityRecord city)
        {
            live.Clear();
            var head = El("row", card);
            head.Add(new IconElement("city"));
            var names = El(null, head); names.style.flexGrow = 1;
            L(city.Name, "title", names);
            string tier = city.Tier >= 3 ? "Megacity" : city.Tier == 2 ? "Metropolis" : city.Tier == 1 ? "Town" : "Settlement";
            string condition = city.Stability < 0 ? "" : city.Stability >= 60 ? " · Stable" : city.Stability >= 35 ? " · Uneasy" : " · Unrest";
            L(tier + condition + (city.Capital ? " · Capital" : ""), "muted", names);
            if (city.Owner != session.CivId) { L($"{Mathf.RoundToInt(city.Pop)} people", "muted", head); return; }
            // the summary first (bible §31): population, housing used, development and the mayor
            var facts = El("city-facts", card);
            void Fact(string label, string value, string cls = "")
            {
                var f = El("city-fact", facts);
                L(label, "muted small", f);
                L(value, "fact-value " + cls, f);
            }
            int pop = Mathf.RoundToInt(city.Pop);
            Fact("Population", $"{pop:N0}" + (city.GrowthRate != 0 ? $"  {city.GrowthRate:+0.#;-0.#}/min" : ""));
            int used = city.Housing > 0 ? Mathf.RoundToInt(100f * pop / city.Housing) : 0;
            Fact("Housing", city.Housing > 0 ? $"{Mathf.Min(used, 999)}% used" : "—", used >= 95 ? "bad" : used >= 80 ? "warn" : "");
            Fact("Development", string.IsNullOrEmpty(city.Priority) ? "Balanced" : char.ToUpper(city.Priority[0]) + city.Priority.Substring(1));
            Fact("Mayor", city.MayorOn ? "Enabled" : "Off");
            if (city.GrowthKind != null)
            {
                L($"Current plan: expand {city.GrowthKind}", "small", card);
                var bar = El("progress", card); var fill = El("progress-fill", bar);
                fill.style.width = new Length(city.GrowthTarget > 0 ? Mathf.Clamp01((float)city.GrowthBuilt / city.GrowthTarget) * 100f : 0f, LengthUnit.Percent);
                L($"{city.GrowthBuilt} / {city.GrowthTarget} buildings", "muted small", card);
            }
            // the limiting factor in plain words, with the action that addresses it
            if (used >= 95) L("Growth has stopped: every home is full. Guide Growth → Housing, or upgrade homes.", "warn small", card).style.whiteSpace = WhiteSpace.Normal;
            else if (city.Unemployed > 0 && city.Jobs < pop) L($"{city.Unemployed} people have no work: build workplaces (Guide Growth → Industry).", "warn small", card).style.whiteSpace = WhiteSpace.Normal;
            L($"{city.Housing} homes · {city.Jobs} jobs · {city.Unemployed} idle" + (city.Stability >= 0 ? $" · stability {city.Stability}" : ""), "muted small", card);
            var g = El("row wrap", card);
            L("Guide Growth:", "small", g);
            B("Housing", () => commander.Begin(Commander.Mode.Growth, "housing"), g, "house").name = "growth-housing";
            B("Industry", () => commander.Begin(Commander.Mode.Growth, "industry"), g, "industry");
            B("Farming", () => commander.Begin(Commander.Mode.Growth, "farming"), g, "farm");
            if (city.GrowthKind != null)
                B("Cancel plan", () => Cmd(new JObject { ["c"] = "cityGrowth", ["city"] = city.Id, ["clear"] = true }, "Plan cancelled"), card);
            var mayor = El("row wrap", card);
            L(city.MayorOn ? "Mayor builds for you" : "Mayor off: you place every building", "small grow", mayor);
            B(city.MayorOn ? "Turn mayor off" : "Turn mayor on", () => Cmd(new JObject { ["c"] = "cityDevelopment", ["city"] = city.Id, ["on"] = !city.MayorOn }, "Mayor updated"), mayor);
            if (city.MayorOn)
            {
                var pr = El("row wrap", card);
                foreach (var p in new[] { "balanced", "industry", "agriculture", "military" })
                {
                    string pp = p;
                    B(char.ToUpper(p[0]) + p.Substring(1), () => Cmd(new JObject { ["c"] = "cityDevelopment", ["city"] = city.Id, ["priority"] = pp }, "Priority set"), pr).EnableInClassList("selected", city.Priority == p);
                }
                if (!string.IsNullOrEmpty(city.Activity)) L("Now: " + city.Activity, "muted small", card);
            }
        }

        void Cmd(JObject cmd, string ok)
        {
            session.Net?.Command(cmd, r => { commander.Say(r.Error ?? ok, r.Error == null, Time.unscaledTime); cardSignature = ""; panelSignature = ""; });
        }

        // ------------------------------------------------------------------ panels
        void Panel(bool force)
        {
            panel.style.display = openPanel == "" ? DisplayStyle.None : DisplayStyle.Flex;
            if (openPanel == "") return;
            // the signature says when the panel's structure changes; live values (research progress)
            // update in place, so typing in a panel's search box is never interrupted by a rebuild
            bool typingHere = Input.InputFacade.Typing;
            string sig = openPanel + panelTab + "|" + (openPanel == "research" ? Econ?["research"] + "|" + (Econ?["queue"] as JArray)?.Count + "|" + (Econ?["techs"] as JArray)?.Count : openPanel == "build" ? Age + "|" + (Econ?["techs"] as JArray)?.Count : openPanel == "overview" ? panelTab + "|" + (panelTab == "Observe" || panelTab == "Map Lenses" ? "" : (session.Snapshots / 20).ToString()) : "");
            if (openPanel == "research") ResearchProgressLive();
            if (!force && (sig == panelSignature || typingHere)) return;
            panelSignature = sig;
            panel.Clear();
            panel.EnableInClassList("wide", openPanel == "research" || openPanel == "overview" || openPanel == "settings" || openPanel == "guide");
            var close = UiKit.IconButton("close", () => { openPanel = ""; Refresh(true); }, "Close (Esc)", panel, 28);
            close.AddToClassList("panel-close");
            if (openPanel == "settings" || openPanel == "guide")
            {
                // these fill a fixed-height frame and scroll inside themselves
                var page = openPanel == "settings" ? new SettingsView(game) { OpenCredits = () => { openPanel = "guide"; Refresh(true); } } : FieldGuide.Build(false, false);
                page.style.height = 640;
                page.style.marginTop = 30;
                panel.Add(page);
                close.BringToFront();
                return;
            }
            var frame = panel;
            panel = Scroll(frame).contentContainer;
            switch (openPanel)
            {
                case "build": BuildPanel(); break;
                case "research": ResearchPanel(); break;
                case "overview": OverviewPanel(); break;
            }
            panel = frame;
        }

        static readonly (string title, string[] types)[] BuildGroups =
        {
            ("Homes and civic", new[] { "house", "market", "academy", "university" }),
            ("Food and raw materials", new[] { "farm", "lumber", "quarry", "salvage", "mine", "oil_well", "port" }),
            ("Industry and power", new[] { "steel_mill", "refinery", "munitions_plant", "electronics_plant", "power_plant", "nuclear_plant", "fusion_plant", "depot" }),
            ("Military", new[] { "barracks", "motor_works", "heavy_assembly", "airfield", "drone_works", "robotics_complex", "missile_silo" }),
            ("Defences", new[] { "guard_post", "bunker", "fort", "aa_battery", "shield_generator", "comms_tower" }),
        };

        void BuildPanel()
        {
            L("Build", "title", panel);
            var search = new TextField { value = buildQuery };
            search.AddToClassList("field"); search.AddToClassList("search");
            search.textEdition.placeholder = "Search buildings…";
            panel.Add(search);
            var scroll = El("menu-list", panel);
            var techs = Techs();
            int age = Age;
            var defs = Defs?["BUILDINGS"] as JObject;
            var entries = new List<(VisualElement el, string text, VisualElement heading)>();
            search.RegisterValueChangedCallback(e =>
            {
                buildQuery = e.newValue ?? "";
                FilterBuild(entries);
            });
            foreach (var (title, types) in BuildGroups)
            {
                var heading = L(title, "heading", scroll);
                var grid = El("row wrap", scroll);
                foreach (var type in types)
                {
                    var def = defs?[type];
                    if (def == null) continue;
                    string tech = ProtocolDecoder.Str(def["tech"]);
                    int need = ProtocolDecoder.Int(def["age"]);
                    if (need > age + 1) continue;
                    bool ok = need <= age && (tech == null || techs.Contains(tech));
                    string t = type;
                    var b = B(NameOf("BUILDINGS", type), () => { commander.Begin(Commander.Mode.Place, t); openPanel = ""; Refresh(true); }, grid, Icons.BuildingKind(type));
                    b.style.width = 190;
                    b.tooltip = (ok ? CostText(def["cost"]) : tech != null && !techs.Contains(tech) ? "Research " + NameOf("TECHS", tech) : "Requires a later era") + (Affordable(def["cost"]) ? "" : " · not enough now: it will wait in the queue");
                    b.SetEnabled(ok);
                    b.name = "build-" + type;
                    entries.Add((b, (NameOf("BUILDINGS", type) + " " + title + " " + type).ToLowerInvariant(), heading));
                }
            }
            FilterBuild(entries);
            L("Roads and fortifications", "heading", scroll);
            var tools = El("row wrap", scroll);
            B("Dirt road", () => { commander.Begin(Commander.Mode.Road, "1"); openPanel = ""; }, tools, "road");
            if (techs.Contains("civil_engineering")) B("Paved road", () => { commander.Begin(Commander.Mode.Road, "2"); openPanel = ""; }, tools, "road");
            if (techs.Contains("highways")) B("Highway", () => { commander.Begin(Commander.Mode.Road, "3"); openPanel = ""; }, tools, "road");
            if (techs.Contains("railways")) B("Railway", () => { commander.Begin(Commander.Mode.Road, "4"); openPanel = ""; }, tools, "road");
            B("Bridge", () => { commander.Begin(Commander.Mode.Bridge, "road"); openPanel = ""; }, tools, "road");
            B("Trench line", () => { commander.Begin(Commander.Mode.Trench, "basic"); openPanel = ""; }, tools, "trench");
            if (techs.Contains("fortification")) B("Reinforced trench", () => { commander.Begin(Commander.Mode.Trench, "reinforced"); openPanel = ""; }, tools, "trench");
        }

        void ResearchPanel()
        {
            var techs = Techs();
            string current = ProtocolDecoder.Str(Econ?["research"]);
            var queue = (Econ?["queue"] as JArray)?.Select(x => (string)x).ToList() ?? new List<string>();
            var head = El("row", panel);
            L("Research", "title grow", head);
            if (current != null)
            {
                float cost = ProtocolDecoder.Float(Defs?["TECHS"]?[current]?["cost"], 1);
                float prog = ProtocolDecoder.Float(Econ?["progress"]);
                var box = El(null, head); box.style.width = 320;
                researchLabel = L($"Researching {NameOf("TECHS", current)} · {Mathf.RoundToInt(100 * prog / Mathf.Max(1, cost))}%", "small", box);
                var bar = El("progress", box); researchFill = El("progress-fill", bar);
                researchFill.style.width = new Length(Mathf.Clamp01(prog / Mathf.Max(1, cost)) * 100, LengthUnit.Percent);
            }
            else { researchLabel = null; researchFill = null; }
            if (queue.Count > 0) L("Queued: " + string.Join(" → ", queue.Select(q => NameOf("TECHS", q))), "muted small", panel);
            L("Click an available technology to research it now; Shift+click to add it (and what it needs) to the queue. Hover to see what it needs and what it leads to.", "muted small", panel);
            // search by name, effect or unlock: matches are outlined, the rest fade
            var search = new TextField { value = researchQuery };
            search.AddToClassList("field"); search.AddToClassList("search");
            search.textEdition.placeholder = "Search technologies, units or buildings…";
            panel.Add(search);
            var techButtons = new Dictionary<string, Button>();
            var techText = new Dictionary<string, string>();
            search.RegisterValueChangedCallback(e => { researchQuery = e.newValue ?? ""; ApplyResearchFilter(techButtons, techText); });
            var ages = Defs?["AGES"] as JArray;
            var row = El("row", panel);
            row.style.alignItems = Align.FlexStart;
            var all = Defs?["TECHS"] as JObject;
            if (all == null) return;
            var cats = Defs?["TECH_CAT"] as JObject;
            string[] branchOrder = { "civ", "industry", "infra", "logistics", "military", "advanced", "society" };
            // what each technology unlocks, from the unit and building definitions
            var unlocks = new Dictionary<string, List<string>>();
            foreach (var group in new[] { "UNITS", "BUILDINGS" })
                if (Defs?[group] is JObject defsOf)
                    foreach (var d in defsOf.Properties())
                    {
                        string tech = ProtocolDecoder.Str(d.Value["tech"]);
                        if (tech == null) continue;
                        if (!unlocks.TryGetValue(tech, out var list)) unlocks[tech] = list = new List<string>();
                        list.Add(ProtocolDecoder.Str(d.Value["name"], d.Name));
                    }
            // legend of branches
            var legend = El("row", panel);
            foreach (var b in branchOrder)
            {
                if (cats == null || !cats.Properties().Any(p => (string)p.Value == b)) continue;
                var chip = L(BranchName(b), "branch-chip small", legend);
                chip.AddToClassList("branch-" + b);
            }
            for (int a = 0; a <= 4; a++)
            {
                var col = El("era", row);
                L(ProtocolDecoder.Str(ages?[a]?["name"], "Era " + (a + 1)), "heading", col);
                var inEra = all.Properties().Where(p => ProtocolDecoder.Int(p.Value["age"]) == a).ToList();
                int known = inEra.Count(p => techs.Contains(p.Name));
                int needed = a + 1 < (ages?.Count ?? 0) ? ProtocolDecoder.Int(ages[a + 1]["techsNeeded"]) : 0;
                if (needed > 0) L($"{Math.Min(known, needed)}/{needed} to advance", known >= needed ? "small good" : "muted small", col);
                inEra.Sort((x, y) =>
                {
                    int bx = Array.IndexOf(branchOrder, ProtocolDecoder.Str(cats?[x.Name], "society")), by = Array.IndexOf(branchOrder, ProtocolDecoder.Str(cats?[y.Name], "society"));
                    return bx != by ? bx.CompareTo(by) : ProtocolDecoder.Int(x.Value["cost"]).CompareTo(ProtocolDecoder.Int(y.Value["cost"]));
                });
                foreach (var p in inEra)
                {
                    string k = p.Name;
                    var req = (p.Value["req"] as JArray)?.Select(x => (string)x).ToList() ?? new List<string>();
                    bool done = techs.Contains(k), available = !done && req.All(techs.Contains);
                    var t = new Button(() =>
                    {
                        if (done) return;
                        bool shift = Input.InputFacade.Shift;
                        if (available && !shift) Cmd(new JObject { ["c"] = "research", ["tech"] = k }, "Researching " + NameOf("TECHS", k));
                        else Cmd(new JObject { ["c"] = "researchQueue", ["op"] = "add", ["tech"] = k }, "Queued " + NameOf("TECHS", k));
                    }) { text = "" };
                    t.AddToClassList("tech");
                    t.EnableInClassList("done", done); t.EnableInClassList("current", k == current); t.EnableInClassList("queued", queue.Contains(k)); t.EnableInClassList("locked", !done && !available);
                    t.AddToClassList("branch-" + ProtocolDecoder.Str(cats?[k], "society"));
                    L(NameOf("TECHS", k), "small", t).style.whiteSpace = WhiteSpace.Normal;
                    if (unlocks.TryGetValue(k, out var what) && what.Count > 0)
                        L(string.Join(" · ", what.Take(3)), "unlocks", t).style.whiteSpace = WhiteSpace.Normal;
                    if (!done) L(k == current ? "researching" : queue.Contains(k) ? $"queued #{queue.IndexOf(k) + 1}" : $"{ProtocolDecoder.Int(p.Value["cost"])} pts", "muted", t);
                    t.tooltip = ProtocolDecoder.Str(p.Value["desc"], "")
                        + (what != null && what.Count > 0 ? "\nUnlocks: " + string.Join(", ", what) : "")
                        + (req.Count > 0 ? "\nNeeds: " + string.Join(", ", req.Select(r => NameOf("TECHS", r) + (techs.Contains(r) ? " ✓" : ""))) : "")
                        + (done ? "" : available ? "\nClick to research now · Shift+click to queue" : "\nShift+click to queue it with what it needs");
                    techButtons[k] = t;
                    techText[k] = (NameOf("TECHS", k) + " " + ProtocolDecoder.Str(p.Value["desc"], "") + " " + (what != null ? string.Join(" ", what) : "")).ToLowerInvariant();
                    string key = k;
                    t.RegisterCallback<PointerEnterEvent>(e => HighlightRelated(all, key, techButtons, true));
                    t.RegisterCallback<PointerLeaveEvent>(e => HighlightRelated(all, key, techButtons, false));
                    col.Add(t);
                }
            }
            ApplyResearchFilter(techButtons, techText);
        }

        string buildQuery = "";

        void FilterBuild(List<(VisualElement el, string text, VisualElement heading)> entries)
        {
            string q = buildQuery.Trim().ToLowerInvariant();
            var visibleHeadings = new HashSet<VisualElement>();
            foreach (var (el, text, heading) in entries)
            {
                bool show = q.Length == 0 || text.Contains(q);
                el.style.display = show ? DisplayStyle.Flex : DisplayStyle.None;
                if (show) visibleHeadings.Add(heading);
            }
            foreach (var (_, _, heading) in entries) heading.style.display = visibleHeadings.Contains(heading) ? DisplayStyle.Flex : DisplayStyle.None;
        }

        string researchQuery = "";
        Label researchLabel;
        VisualElement researchFill;

        /// <summary>Progress of the current research, updated in place (the panel is not rebuilt for it).</summary>
        void ResearchProgressLive()
        {
            string current = ProtocolDecoder.Str(Econ?["research"]);
            if (researchLabel == null || researchFill == null || current == null) return;
            float cost = ProtocolDecoder.Float(Defs?["TECHS"]?[current]?["cost"], 1), prog = ProtocolDecoder.Float(Econ?["progress"]);
            researchLabel.text = $"Researching {NameOf("TECHS", current)} · {Mathf.RoundToInt(100 * prog / Mathf.Max(1, cost))}%";
            researchFill.style.width = new Length(Mathf.Clamp01(prog / Mathf.Max(1, cost)) * 100, LengthUnit.Percent);
        }

        void ApplyResearchFilter(Dictionary<string, Button> buttons, Dictionary<string, string> text)
        {
            string q = researchQuery.Trim().ToLowerInvariant();
            foreach (var kv in buttons)
            {
                bool hit = q.Length > 0 && text.TryGetValue(kv.Key, out var s) && s.Contains(q);
                kv.Value.EnableInClassList("match", hit);
                kv.Value.style.opacity = q.Length == 0 || hit ? StyleKeyword.Null : new StyleFloat(0.3f);
            }
        }

        /// <summary>Hovering a technology lights up everything it needs (all the way down) and everything that needs it.</summary>
        void HighlightRelated(JObject all, string key, Dictionary<string, Button> buttons, bool on)
        {
            var related = new HashSet<string>();
            void Down(string k) { if (all[k]?["req"] is JArray req) foreach (var r in req) { string s = (string)r; if (related.Add(s)) Down(s); } }
            void Up(string k) { foreach (var p in all.Properties()) if (p.Value["req"] is JArray req && req.Any(x => (string)x == k) && related.Add(p.Name)) Up(p.Name); }
            Down(key); Up(key);
            foreach (var r in related) if (buttons.TryGetValue(r, out var b)) b.EnableInClassList("related", on);
        }

        static string BranchName(string b) => b switch
        {
            "civ" => "Civic", "industry" => "Industry", "infra" => "Infrastructure", "logistics" => "Logistics",
            "military" => "Military", "advanced" => "Advanced", _ => "Society",
        };

        void OverviewPanel()
        {
            var tabs = El("tabs", panel);
            var tabNames = new List<string> { "Economy", "Cities", "Armies", "Rivals", "Chronicle", "Actions" };
            if (session.Spectator) tabNames.Insert(0, "Observe");
            foreach (var t in tabNames)
            {
                string tt = t;
                B(t, () => { panelTab = tt; Refresh(true); }, tabs).EnableInClassList("selected", (panelTab == "" ? "Economy" : panelTab) == t);
            }
            var scroll = El("menu-list", panel);
            switch (panelTab == "" ? "Economy" : panelTab)
            {
                case "Economy":
                    if (Econ?["resources"] is JArray reports)
                        foreach (JObject r in reports)
                        {
                            var item = El("list-item", scroll);
                            var head = El("row", item);
                            var dot = El("dot", head); dot.style.width = 12; dot.style.height = 12; dot.style.borderTopLeftRadius = 6; dot.style.borderTopRightRadius = 6; dot.style.borderBottomLeftRadius = 6; dot.style.borderBottomRightRadius = 6; dot.style.marginRight = 6;
                            dot.style.backgroundColor = Icons.ResourceColor((string)r["good"]);
                            L(ProtocolDecoder.Str(r["title"], ""), "heading grow", head);
                            L($"{r["stock"]} · {ProtocolDecoder.Float(r["net"]):+0.##;-0.##;0}/s", "", head);
                            string status = ProtocolDecoder.Str(r["status"], "ok");
                            var prod = (r["producers"] as JArray)?.Where(p => ProtocolDecoder.Int(p["count"] ?? p["built"]) > 0).Select(p => $"{p["name"]} ×{p["count"] ?? p["built"]}");
                            var cons = (r["consumers"] as JArray)?.Select(p => $"{p["name"]} ×{p["count"]}");
                            if (prod != null && prod.Any()) L("From: " + string.Join(", ", prod), "muted small", item).style.whiteSpace = WhiteSpace.Normal;
                            if (cons != null && cons.Any()) L("Used by: " + string.Join(", ", cons), "muted small", item).style.whiteSpace = WhiteSpace.Normal;
                            if (status != "ok") L((ProtocolDecoder.Str(r["headline"], "") + " " + ProtocolDecoder.Str(r["cause"], "")).Trim(), status == "empty" ? "bad small" : "warn small", item).style.whiteSpace = WhiteSpace.Normal;
                        }
                    break;
                case "Cities":
                    foreach (var c in session.Structures.Cities.Values.Where(c => c.Owner == session.CivId).OrderByDescending(c => c.Pop))
                    {
                        var cc = c;
                        var item = El("list-item row", scroll);
                        L(c.Name, "heading grow", item);
                        L($"{Mathf.RoundToInt(c.Pop)} people · {c.Jobs} jobs · {c.Unemployed} idle", "muted", item);
                        B("Go", () => game.FocusTile(cc.Tile, 22f), item);
                    }
                    break;
                case "Armies":
                    if (Econ?["armies"] is JArray armies)
                        foreach (var a in armies)
                        {
                            var item = El("list-item row", scroll);
                            L(ProtocolDecoder.Str(a["name"], "Army"), "heading grow", item);
                            L($"{ProtocolDecoder.Int(a["units"] ?? a["n"])} units · {ProtocolDecoder.Str(a["order"] ?? a["state"], "")}", "muted", item);
                            int tile = ProtocolDecoder.Int(a["tile"], -1);
                            if (tile >= 0) B("Go", () => game.FocusTile(tile, 26f), item);
                        }
                    else L("No armies yet: select troops and choose Form army.", "muted", scroll);
                    break;
                case "Rivals":
                    foreach (var civ in session.Welcome.Civs)
                    {
                        if (civ.Id == session.CivId || civ.Rebel) continue;
                        var item = El("list-item row", scroll);
                        var dot = El(null, item); dot.style.width = 14; dot.style.height = 14; dot.style.marginRight = 8;
                        dot.style.backgroundColor = new Color(((civ.Color >> 16) & 255) / 255f, ((civ.Color >> 8) & 255) / 255f, (civ.Color & 255) / 255f);
                        L(civ.Name, "heading grow", item);
                        int seen = session.Structures.Cities.Values.Count(c => c.Owner == civ.Id);
                        L(seen > 0 ? $"{seen} cities seen" : "not yet met", "muted", item);
                        int cid = civ.Id;
                        B("Declare war", () => Cmd(new JObject { ["c"] = "diplo", ["to"] = cid, ["action"] = "war" }, "Hostilities begin"), item);
                        B("Disengage", () => Cmd(new JObject { ["c"] = "diplo", ["to"] = cid, ["action"] = "disengage" }, "Pulling back"), item);
                    }
                    break;
                case "Chronicle":
                    for (int i = session.Notes.Count - 1; i >= Math.Max(0, session.Notes.Count - 80); i--)
                    {
                        var (t, text, level) = session.Notes[i];
                        var row = El("row", scroll);
                        L($"{(int)(t / 60)}:{(int)(t % 60):00}  {text}", (level == "critical" ? "bad small" : level == "major" ? "warn small" : "small") + " grow", row).style.whiteSpace = WhiteSpace.Normal;
                        int tile = i < session.NoteMeta.Count ? session.NoteMeta[i].Tile : -1;
                        if (tile >= 0) B("Go", () => game.FocusTile(tile, 22f), row);
                    }
                    break;
                case "Observe":
                    ObservePanel(scroll);
                    break;
                case "Actions":
                    ActionsCatalogue(scroll);
                    break;
            }
        }

        /// <summary>
        /// AI observation (spectators): follow a nation, its fog of war or the whole map, the match
        /// speed, and that nation's current plan from the server's AI inspector.
        /// </summary>
        void ObservePanel(VisualElement scroll)
        {
            var net = session.Net;
            if (net == null) return;
            L("Follow a nation", "heading", scroll);
            var row = El("row wrap", scroll);
            foreach (var civ in session.Welcome.Civs)
            {
                int id = civ.Id;
                var b = B(civ.Name, () => net.ObserverCommand(new JObject { ["c"] = "follow", ["civ"] = id }, r => { if (r.Error != null) commander.Say(r.Error, false, Time.unscaledTime); }), row);
                b.EnableInClassList("selected", session.CivId == id);
            }
            L("What you see", "heading section", scroll);
            var fog = El("row", scroll);
            B("Whole map", () => net.ObserverCommand(new JObject { ["c"] = "fog", ["on"] = false }), fog);
            B("Their fog of war", () => net.ObserverCommand(new JObject { ["c"] = "fog", ["on"] = true }), fog);
            L("Match speed", "heading section", scroll);
            var speed = El("row", scroll);
            foreach (var s in new[] { 0, 1, 2, 4, 8 })
            {
                int sp = s;
                B(s == 0 ? "Pause" : s + "×", () => net.ObserverCommand(new JObject { ["c"] = "speed", ["speed"] = sp }, r => commander.Say(r.Error ?? (sp == 0 ? "Paused" : $"Speed {sp}×"), r.Error == null, Time.unscaledTime)), speed)
                    .EnableInClassList("selected", Mathf.Approximately(session.PlayRate, sp));
            }
            L("Their plan", "heading section", scroll);
            var plan = L("Ask the AI inspector what this nation is doing and why.", "muted small", scroll);
            plan.style.whiteSpace = WhiteSpace.Normal;
            B("Inspect AI decisions", () => net.ObserverCommand(new JObject { ["c"] = "aiDiag", ["civ"] = session.CivId }, r =>
            {
                var d = r.Raw?["diag"];
                plan.text = d == null || d.Type == JTokenType.Null ? "No AI plan for this nation (a human player, or no report yet)." : Summarise(d);
            }), scroll);
        }

        static string Summarise(JToken diag)
        {
            // the inspector report is free-form: show its top-level facts briefly
            var sb = new System.Text.StringBuilder();
            if (diag is JObject o)
                foreach (var p in o.Properties().Take(14))
                {
                    string v = p.Value.Type == JTokenType.Object || p.Value.Type == JTokenType.Array ? p.Value.ToString(Newtonsoft.Json.Formatting.None) : p.Value.ToString();
                    if (v.Length > 160) v = v.Substring(0, 157) + "…";
                    sb.Append(p.Name).Append(": ").Append(v).Append('\n');
                }
            else sb.Append(diag.ToString());
            return sb.ToString();
        }

        /// <summary>Every remaining game action, from the catalogue shared with the Godot client.</summary>
        void ActionsCatalogue(VisualElement scroll)
        {
            L("Every order the server accepts, grouped as in the original interface. Orders that need a place ask for a click on the map; orders for selected units or buildings use the current selection.", "muted small", scroll).style.whiteSpace = WhiteSpace.Normal;
            string page = "";
            foreach (JObject a in catalogue)
            {
                string audience = ProtocolDecoder.Str(a["audience"]);
                if (audience == "observer" && !session.Spectator) continue;
                if (audience == "sandbox" && !session.Welcome.Sandbox) continue;
                if (a["tool"] != null) continue;   // placement tools live in the Build panel
                string pg = ProtocolDecoder.Str(a["page"], "");
                if (pg != page) { page = pg; L(page, "heading", scroll); }
                var row = El("list-item row", scroll);
                L(ProtocolDecoder.Str(a["title"], ""), "grow", row);
                var form = new Dictionary<string, Func<JToken>>();
                if (a["fields"] is JArray fields)
                    foreach (JObject f in fields)
                    {
                        string key = ProtocolDecoder.Str(f["key"], "");
                        var choices = Choices(f);
                        if (choices == null) continue;
                        if (choices.Count == 0) continue;
                        var dd = new DropdownField(choices.Select(c => c.label).ToList(), 0); dd.style.width = 160; row.Add(dd);
                        form["@" + key] = () => choices[Math.Max(0, dd.index)].value;
                    }
                var spec = a;
                B("Do", () => RunAction(spec, form), row);
            }
        }

        List<(string label, JToken value)> Choices(JObject f)
        {
            var list = new List<(string, JToken)>();
            if (f["choices"] is JArray ch)
            {
                foreach (var c in ch) list.Add(c is JArray pair ? ((string)pair[1], pair[0]) : ((string)c, c));
                return list;
            }
            if (ProtocolDecoder.Str(f["kind"]) == "number") { foreach (var v in new[] { ProtocolDecoder.Int(f["default"], 1), 1, 5, 10, 20 }.Distinct()) list.Add((v.ToString(), v)); return list; }
            if (ProtocolDecoder.Str(f["kind"]) == "bool") { list.Add(("Yes", true)); list.Add(("No", false)); return list; }
            if (ProtocolDecoder.Str(f["kind"]) == "text") { list.Add(("New Army", "New Army")); return list; }
            switch (ProtocolDecoder.Str(f["source"]))
            {
                case "cities": foreach (var c in session.Structures.Cities.Values.Where(c => c.Owner == session.CivId)) list.Add((c.Name, c.Id)); break;
                case "buildings": return null;   // the selection supplies it
                case "TECHS": if (Defs?["TECHS"] is JObject t) foreach (var p in t.Properties()) list.Add((ProtocolDecoder.Str(p.Value["name"], p.Name), p.Name)); break;
                case "UNITS": if (Defs?["UNITS"] is JObject u) foreach (var p in u.Properties()) list.Add((ProtocolDecoder.Str(p.Value["name"], p.Name), p.Name)); break;
                case "training_types": if (Defs?["UNITS"] is JObject u2) foreach (var p in u2.Properties()) list.Add((ProtocolDecoder.Str(p.Value["name"], p.Name), p.Name)); break;
                case "STANCES": foreach (var s in new[] { "aggressive", "defensive", "hold", "explore" }) list.Add((s, s)); break;
                case "FORMATIONS": foreach (var s in new[] { "line", "column", "wedge", "box" }) list.Add((s, s)); break;
                case "ENGAGE_POLICIES": foreach (var s in new[] { "nearest", "weakest", "armor", "infantry" }) list.Add((s, s)); break;
                case "armies": case "armies_optional":
                    if (ProtocolDecoder.Str(f["source"]) == "armies_optional") list.Add(("none", 0));
                    if (Econ?["armies"] is JArray ar) foreach (var x in ar) list.Add((ProtocolDecoder.Str(x["name"], "Army"), x["id"]));
                    break;
                case "nations": case "all_nations": foreach (var c in session.Welcome.Civs.Where(c => !c.Rebel && (c.Id != session.CivId || f["source"].ToString() == "all_nations"))) list.Add((c.Name, c.Id)); break;
                default: return null;
            }
            return list;
        }

        void RunAction(JObject spec, Dictionary<string, Func<JToken>> form)
        {
            var cmd = (JObject)spec["command"]?.DeepClone() ?? new JObject();
            foreach (var p in cmd.Properties().ToList())
                if (p.Value.Type == JTokenType.String && form.TryGetValue((string)p.Value, out var get)) p.Value = get();
            string map = ProtocolDecoder.Str(spec["map"]);
            if (map == "point" || map == "line" || map == "enemy") { commander.Begin(Commander.Mode.Target, "", cmd); openPanel = ""; Refresh(true); return; }
            commander.Bind(cmd, -1);
            Cmd(cmd, ProtocolDecoder.Str(spec["title"], "Done"));
        }

        // ------------------------------------------------------------------ tutorial with on-screen pointers
        int tutorialStep = -1;
        float stepAt;
        int startBuildings, startUnits;
        Vector3 startFocus;

        public Func<int, Vector3?> TileScreen;   // map tile to screen position (set by the bootstrap)
        public Func<Vector3> CameraFocus;

        void Tutorial(float time)
        {
            if (tutorialStep < 0) { highlight.style.display = DisplayStyle.None; pointer.style.display = DisplayStyle.None; return; }
            int home = session.Welcome?.Start ?? -1;
            int own = session.Structures.Buildings.Values.Count(b => b.Owner == session.CivId);
            int ownUnits = 0; for (int s = 0; s < session.Units.SlotCount; s++) if (session.Units.Records[s].InUse && session.Units.Records[s].Owner == session.CivId) ownUnits++;
            string text; VisualElement target = null; int worldTile = -1; bool advance = false;
            switch (tutorialStep)
            {
                case 0:
                    text = "Welcome, commander. Move the camera with the arrow keys or by pushing the mouse to the screen edge (Alt + drag turns it), and zoom with the mouse wheel.";
                    if (stepAt == 0) { stepAt = time; startFocus = CameraFocus?.Invoke() ?? Vector3.zero; }
                    advance = time - stepAt > 3f && Vector3.Distance(CameraFocus?.Invoke() ?? Vector3.zero, startFocus) > 3f;
                    break;
                case 1:
                    text = "This is your town. Click it to select it.";
                    worldTile = session.Structures.Cities.Values.FirstOrDefault(c => c.Owner == session.CivId).Tile;
                    advance = commander.SelectedCity >= 0;
                    break;
                case 2:
                    text = "Guide Growth tells the mayor where to build. Choose Housing, then click open ground near the town.";
                    target = card.Q<Button>("growth-housing");
                    advance = session.Structures.Cities.Values.Any(c => c.Owner == session.CivId && c.GrowthKind != null);
                    break;
                case 3:
                    text = "Now build something yourself. Open Build on the left.";
                    target = rail.Q<Button>("rail-build");
                    advance = openPanel == "build" || commander.Current == Commander.Mode.Place;
                    break;
                case 4:
                    text = "Choose a Farm. Food feeds your people and lets the town grow.";
                    target = panel.Q<Button>("build-farm");
                    if (stepAt == 0) { stepAt = time; startBuildings = own; }
                    advance = commander.Current == Commander.Mode.Place;
                    break;
                case 5:
                    text = "Click one of the glowing sites to place it. Drag across several sites to place more than one.";
                    advance = own > startBuildings;
                    break;
                case 6:
                    text = "Open Research and pick a technology. Research never stops for lack of goods.";
                    target = rail.Q<Button>("rail-research");
                    advance = (Econ?["queue"] as JArray)?.Count > 0 || openPanel == "research" && time - stepAt > 6f;
                    break;
                case 7:
                    text = "Train troops: click your town or a barracks, then click a unit. Select several buildings (double-click) to share one order across all of them.";
                    if (stepAt == 0) { stepAt = time; startUnits = ownUnits; }
                    advance = ownUnits > startUnits || session.Structures.Buildings.Values.Any(b => b.Owner == session.CivId && b.QueueLength > 0);
                    break;
                case 8:
                    text = "Drag a box around troops to select them, right-click to move. Shift + right-click attacks anything on the way.";
                    advance = commander.Orders.Any(o => o.State == "accepted");
                    break;
                case 9:
                    text = "The top bar shows each resource and its rate. Hover one to see who makes it, who uses it, and why it is short. The red pill says what to fix first.";
                    if (stepAt == 0) stepAt = time;
                    advance = time - stepAt > 10f;
                    break;
                default:
                    tutorialStep = -1; coach.style.display = DisplayStyle.None; PlayerPrefs.SetInt("se.tutorial.done", 1);
                    return;
            }
            coachText.text = $"{tutorialStep + 1}/10 · {text}";
            if (advance) { tutorialStep++; stepAt = 0; }
            // the pointer: a frame around an interface element, or an arrow over a place in the world
            if (target != null && target.panel != null)
            {
                var wb = target.worldBound;
                highlight.style.left = wb.xMin - 4; highlight.style.top = wb.yMin - 4; highlight.style.width = wb.width + 8; highlight.style.height = wb.height + 8;
                highlight.style.display = DisplayStyle.Flex;
                highlight.style.opacity = 0.6f + 0.4f * Mathf.Sin(time * 5f);
            }
            else highlight.style.display = DisplayStyle.None;
            if (worldTile >= 0 && TileScreen?.Invoke(worldTile) is Vector3 sp && sp.z > 0)
            {
                var p = ToPanel(sp);
                MovePointer(p.x - 12, p.y - 70 - 8 * Mathf.Abs(Mathf.Sin(time * 4f)));
                pointer.style.display = DisplayStyle.Flex;
            }
            else pointer.style.display = DisplayStyle.None;
        }
    }
}
