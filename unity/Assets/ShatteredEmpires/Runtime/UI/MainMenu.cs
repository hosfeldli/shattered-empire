using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Runtime.Social;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The main menu (UI spec B15/B16): one frame anchored to the full height on the left, over the living
    /// world. Its size never follows its text: root pages are 460 wide, wide pages (New Skirmish, Lobby,
    /// Settings, Field Guide) 880; the content scrolls inside. Escape (and the mouse back button) goes back
    /// exactly one level on every page. The multiplayer pages work without Steam (match codes); with Steam
    /// they add hosting a friends lobby, the invite overlay and joining friends.
    /// </summary>
    public sealed partial class MainMenuView : VisualElement
    {
        readonly IGameActions game;
        readonly Func<VisualElement> settingsFactory;
        readonly VisualElement frame, pageHost;
        readonly Label statusLabel;
        readonly UiKit.PageStack pages;
        // New Skirmish and Watch AI Match share one setup page (BuildSetup); each keeps its own choices
        readonly CampaignOptions soloSetup = new CampaignOptions(), watchSetup = new CampaignOptions { Observe = true, Format = "ffa4" };
        bool watching;   // the setup page is Watch AI Match: every seat an AI, no seat of yours
        CampaignOptions skirmish => watching ? watchSetup : soloSetup;

        static readonly HashSet<string> WidePages = new HashSet<string> { "skirmish", "watch", "lobby", "settings", "guide", "browse", "builder" };

        bool advancedOpen;
        string codeMode = "join";

        public MainMenuView(IGameActions game, Func<VisualElement> settingsFactory)
        {
            this.game = game;
            this.settingsFactory = settingsFactory;
            var sheet = Resources.Load<StyleSheet>("UI/SE.Menu");
            if (sheet != null) styleSheets.Add(sheet);
            AddToClassList("se-menu");
            pickingMode = PickingMode.Ignore;

            frame = Box("se-menu-frame", this);
            frame.pickingMode = PickingMode.Position;
            pageHost = Box("se-menu-page-host", frame);
            var foot = Box("se-menu-foot", frame);
            statusLabel = Line("", "se-menu-status", foot);
            Line($"v{Application.version} · Windows preview" + (App.Updater.CurrentBuild.Length > 0 ? " · build " + App.Updater.CurrentBuild : ""), "se-menu-version", foot);
            UpdateBanner.Attach(frame, foot);   // in-app updater (App/Updater.cs): hidden unless an update is on offer
            ReleaseNotes.Attach(this, foot);    // "What's new" link; the notes window after an update (UI/ReleaseNotes.cs)

            // the mouse's back button pops a page like Escape
            frame.RegisterCallback<PointerDownEvent>(e =>
            {
                if (e.button != 3) return;
                HandleEscape();
                e.StopPropagation();
            });

            pages = new UiKit.PageStack(pageHost);
            pages.WideChanged += wide => SetWide(wide);
            pages.Reset("root", BuildRoot);
            SyncWide();

            var social = game?.Social;
            if (social != null)
            {
                social.LobbyChanged += OnSocialChanged;
                social.InviteAccepted += OnInviteAccepted;
            }
            soloSetup.Wrap = false;
            watchSetup.Wrap = false;
            LoadWatchSetup();
        }

        // ------------------------------------------------------------------ contract (Hud)
        public bool Visible => style.display != DisplayStyle.None;

        /// <summary>Show or hide the menu; <paramref name="status"/> null keeps the current status line.</summary>
        public void Show(bool on, string status)
        {
            if (on && style.display == DisplayStyle.None) UiKit.Enter(frame);   // the frame eases in when the menu opens
            style.display = on ? DisplayStyle.Flex : DisplayStyle.None;
            if (status != null) SetStatus(status);
            // the root page reflects whether there is a match to continue
            if (on && pages.Top == "root") { pages.Reset("root", BuildRoot); SyncWide(); }
            if (on) OnSocialChanged();
        }

        /// <summary>Pop one page. Leaving the lobby page leaves the lobby. False at the root (nothing to do).</summary>
        public bool HandleEscape()
        {
            if (ReleaseNotes.Close()) return true;
            if (quitArmed) { DisarmQuit(); return true; }
            if (pages.Top == "lobby") { LeaveLobbyPage(); return true; }
            if (pages.Pop()) { SyncWide(); return true; }
            return false;
        }

        /// <summary>A server 'room' message: open (or update) the lobby page.</summary>
        public void ShowLobby(JObject room)
        {
            var parsed = MatchRoom.Parse(room);
            if (parsed == null) return;
            // the server names a hand-authored map (mapName); "Random" is a procedural world
            lobbyMapName = room["map"] != null && (string)room["map"] != "random" ? (string)room["mapName"] ?? (string)room["map"] : "";
            lobby = parsed;
            lobbyCode = parsed.Code;
            SyncLobbySketch(parsed);   // MainMenu.Builder.cs
            // the server's copy of your ready flag is the truth
            if (parsed.You >= 0 && parsed.You < parsed.Seats.Count) lobbyReadyOn = parsed.Seats[parsed.You].Ready;
            OpenLobbyPage();
        }

        /// <summary>Seated in a lobby (server 'joined', status lobby) before the first 'room' message arrives.</summary>
        public void ShowLobbyJoining(string code)
        {
            if (lobby != null && lobby.Code != code) lobby = null;
            lobbyCode = code ?? "";
            OpenLobbyPage();
        }

        /// <summary>The lobby is gone (left, closed by the host, or the connection failed): back to Multiplayer.</summary>
        public void ShowMultiplayer()
        {
            lobby = null; lobbyCode = "";
            pages.Reset("root", BuildRoot);
            pages.Push("multiplayer", BuildMultiplayer, false);
            SyncWide();
        }

        /// <summary>Back to the first page (a match ended or was left).</summary>
        public void ResetToRoot()
        {
            DisarmQuit();
            lobby = null; lobbyCode = "";
            pages.Reset("root", BuildRoot);
            SyncWide();
        }

        /// <summary>Review captures: "root", "skirmish", "watch", "multiplayer", "lobby", "training", "settings", "guide", "friends", "code".</summary>
        public void ReviewPage(string id)
        {
            Show(true, null);
            ResetToRoot();
            switch (id)
            {
                case "root": break;
                case "lobby":
                    Go("multiplayer");
                    ShowLobby(new JObject
                    {
                        ["t"] = "room", ["code"] = "k3x9qa", ["match"] = "k3x9qa", ["name"] = "Commander's match", ["status"] = "lobby",
                        ["mode"] = "pvp", ["mapSize"] = 152, ["teamSize"] = 2, ["teams"] = 2, ["format"] = "2v2", ["map"] = "random", ["mapName"] = "Random",
                        ["host"] = "Commander", ["you"] = 0, ["isHost"] = true, ["canStart"] = true, ["open"] = 1, ["waitForReady"] = true,
                        ["slots"] = new JArray(
                            new JObject { ["name"] = "Commander", ["human"] = true, ["taken"] = true, ["connected"] = true, ["ready"] = true, ["host"] = true },
                            new JObject { ["name"] = "AI", ["human"] = false, ["difficulty"] = "hard", ["personality"] = "warlord" },
                            new JObject { ["name"] = "Guest", ["human"] = true, ["taken"] = true, ["connected"] = true, ["ready"] = false },
                            new JObject { ["name"] = "Open seat", ["human"] = true, ["taken"] = false, ["connected"] = false, ["ready"] = false }),
                    });
                    break;
                case "friends": case "code": case "browse": Go("multiplayer"); Go(id); break;
                case "guide": Go("training"); Go("guide"); break;
                case "watch": Go("training"); Go("watch"); break;
                default: Go(id); break;
            }
        }

        // ------------------------------------------------------------------ navigation
        void Go(string id)
        {
            pages.Push(id, Builder(id), WidePages.Contains(id));
            SyncWide();
        }

        Func<VisualElement> Builder(string id)
        {
            switch (id)
            {
                case "skirmish": return BuildSkirmish;
                case "watch": return BuildWatch;
                case "multiplayer": return BuildMultiplayer;
                case "friends": return BuildFriends;
                case "browse": return BuildBrowse;
                case "code": return BuildCode;
                case "lobby": return BuildLobby;
                case "training": return BuildTraining;
                case "settings": return BuildSettings;
                case "guide": return BuildGuide;
                case "builder": return BuildBuilder;   // MainMenu.Builder.cs
                default: return BuildRoot;
            }
        }

        void SyncWide() => SetWide(WidePages.Contains(pages.Top ?? ""));

        void SetWide(bool wide)
        {
            frame.EnableInClassList("se-frame--wide", wide);
            frame.EnableInClassList("se-menu-frame--wide", wide);
        }

        void Back() => HandleEscape();

        void SetStatus(string text)
        {
            statusLabel.text = text ?? "";
            statusLabel.tooltip = string.IsNullOrEmpty(text) ? null : text;   // the full line when it is cut off
        }

        // ------------------------------------------------------------------ building blocks
        static VisualElement Box(string cls, VisualElement parent)
        {
            var e = new VisualElement();
            if (cls != null) foreach (var c in cls.Split(' ')) e.AddToClassList(c);
            parent?.Add(e);
            return e;
        }

        static Label Line(string text, string cls, VisualElement parent)
        {
            var l = new Label(text ?? "");
            if (cls != null) foreach (var c in cls.Split(' ')) l.AddToClassList(c);
            parent?.Add(l);
            return l;
        }

        static Button Item(string icon, string label, Action click, VisualElement parent)
        {
            var b = UiKit.Button(label, click, parent, icon, "se-menu-item");
            b.AddToClassList("se-menu-item");
            return b;
        }

        static Button Btn(string label, Action click, VisualElement parent, string icon = null, bool primary = false)
        {
            var b = UiKit.Button(label, click, parent, icon, "se-menu-action");
            b.AddToClassList("se-menu-action");
            if (primary) b.AddToClassList("primary");
            if (primary) b.AddToClassList("se-menu-action--primary");
            return b;
        }

        static TextField Field(string value, VisualElement parent, string cls = null)
        {
            var f = new TextField { value = value ?? "" };
            f.AddToClassList("field");
            f.AddToClassList("se-menu-field");
            if (cls != null) f.AddToClassList(cls);
            parent?.Add(f);
            return f;
        }

        static IReadOnlyList<(string id, string label, string icon)> Options(params (string id, string label)[] options)
        {
            var list = new List<(string id, string label, string icon)>(options.Length);
            foreach (var o in options) list.Add((o.id, o.label, null));
            return list;
        }

        sealed class PageParts
        {
            public VisualElement Root, Content, Footer;
            public Label Title;
        }

        /// <summary>A sub-page: header 56 (back arrow + title) · content (scrolls, flex 1) · footer 64 (Back left).</summary>
        PageParts SubPage(string title, bool scroll = true, bool header = true)
        {
            var parts = new PageParts { Root = Box("se-menu-page", null) };
            if (header)
            {
                var head = Box("se-menu-header", parts.Root);
                UiKit.IconButton("back", Back, "Back (Esc)", head, 36);
                parts.Title = Line(title, "se-menu-page-title", head);
            }
            if (scroll)
            {
                var sv = new ScrollView(ScrollViewMode.Vertical)
                {
                    horizontalScrollerVisibility = ScrollerVisibility.Hidden,
                    verticalScrollerVisibility = ScrollerVisibility.Auto,
                    mouseWheelScrollSize = 38,
                };
                sv.AddToClassList("bounded-scroll");
                sv.AddToClassList("se-menu-content");
                parts.Root.Add(sv);
                parts.Content = sv.contentContainer;
            }
            else parts.Content = Box("se-menu-content se-menu-content--fill", parts.Root);
            parts.Footer = Box("se-menu-footer", parts.Root);
            Btn("Back", Back, parts.Footer, "back").AddToClassList("se-menu-action--lead");
            Box("se-menu-spacer", parts.Footer);
            return parts;
        }

        // ------------------------------------------------------------------ root
        Button quitButton;
        VisualElement quitConfirm;
        bool quitArmed;
        float quitUntil;

        VisualElement BuildRoot()
        {
            quitArmed = false;
            var page = Box("se-menu-page se-menu-page--root", null);
            var titleBlock = Box("se-menu-title-block", page);
            Line("SHATTERED", "se-menu-title", titleBlock);
            Line("EMPIRES", "se-menu-title", titleBlock);

            var list = Box("se-menu-list", page);
            bool hasMatch = PlayerPrefs.GetString("se.match", "") != "";
            var resume = Item("continue", "Continue", () => game.StartMatch("rejoin", ""), list);
            resume.SetEnabled(hasMatch);
            resume.tooltip = hasMatch ? null : "No match to continue";
            var fresh = Item("skirmish", "New Skirmish", () => Go("skirmish"), list);
            (hasMatch ? resume : fresh).AddToClassList("se-menu-item--primary");
            Item("multiplayer", "Multiplayer", () => Go("multiplayer"), list);
            Item("terrain", "Map builder", () => OpenBuilder("root"), list);
            Item("training", "Training & Extras", () => Go("training"), list);
            Item("settings", "Settings", () => Go("settings"), list);

            // Quit asks inline for four seconds: "Quit? [Yes] [No]" in the same 56 px slot
            var quitSlot = Box("se-menu-quit-slot", list);
            quitButton = Item("quit", "Quit", ArmQuit, quitSlot);
            quitConfirm = Box("se-menu-quit-confirm", quitSlot);
            Line("Quit?", "se-menu-quit-label", quitConfirm);
            Box("se-menu-spacer", quitConfirm);
            Btn("Yes", () => game.Quit(), quitConfirm, null, true);
            Btn("No", DisarmQuit, quitConfirm);
            quitConfirm.style.display = DisplayStyle.None;
            return page;
        }

        void ArmQuit()
        {
            if (quitButton == null || quitConfirm == null) return;
            quitArmed = true;
            quitUntil = Time.realtimeSinceStartup + 4f;
            quitButton.style.display = DisplayStyle.None;
            quitConfirm.style.display = DisplayStyle.Flex;
            quitConfirm.schedule.Execute(() => { if (quitArmed && Time.realtimeSinceStartup >= quitUntil - 0.05f) DisarmQuit(); }).ExecuteLater(4000);
        }

        void DisarmQuit()
        {
            quitArmed = false;
            if (quitButton != null) quitButton.style.display = DisplayStyle.Flex;
            if (quitConfirm != null) quitConfirm.style.display = DisplayStyle.None;
        }

        // ------------------------------------------------------------------ new skirmish
        static readonly (string id, string text)[] DifficultyHelp =
        {
            ("easy", "Forgiving reactions and simpler strategy."),
            ("normal", "Coherent economic and military play."),
            ("hard", "Better preparation, defence and counter-composition."),
            ("expert", "Stronger planning, reconnaissance and combined arms."),
            ("brutal", "Highly optimised strategy; any bonuses are disclosed."),
        };

        static readonly (string id, string text)[] VictoryHelp =
        {
            ("domination", "Destroy every rival headquarters."),
            ("control", "Hold most of the command zones for a while."),
            ("operation", "Secure the operation's objective first."),
        };

        static string HelpFor((string id, string text)[] table, string id)
        {
            foreach (var (key, text) in table) if (key == id) return text;
            return table[0].text;
        }

        // formats offered by New Skirmish and the lobby (server FORMATS in matches.js)
        static readonly (string id, string label)[] Formats =
            { ("1v1", "1v1"), ("2v2", "2v2"), ("3v3", "3v3"), ("4v4", "4v4"), ("ffa3", "FFA 3"), ("ffa4", "FFA 4") };
        static readonly string[] DifficultyIds = { "easy", "normal", "hard", "expert", "brutal" };
        static readonly string[] DifficultyNames = { "Relaxed", "Standard", "Hard", "Expert", "Brutal" };
        static readonly string[] PersonalityIds = { "random", "warlord", "merchant", "builder" };
        static readonly string[] PersonalityNames = { "Any style", "Warlord", "Merchant", "Builder" };

        static string NameOf(string[] ids, string[] names, string id)
        {
            int i = Array.IndexOf(ids, id);
            return i >= 0 ? names[i] : string.IsNullOrEmpty(id) ? names[0] : id;
        }

        /// <summary>
        /// A compact chip that cycles through choices: click for the next, right-click for the previous (AI
        /// difficulty and personality in the AI lists; fixed width, so rows never change size).
        /// </summary>
        static Button Cycle(string[] ids, string[] names, string current, Action<string> set, VisualElement parent, string tip)
        {
            var b = new Button { text = NameOf(ids, names, current) };
            b.AddToClassList("se-cycle");
            b.tooltip = tip + " (click: next, right-click: previous)";
            string value = current;
            void Step(int d)
            {
                int i = Array.IndexOf(ids, value);
                i = ((i < 0 ? 0 : i) + d + ids.Length) % ids.Length;
                value = ids[i];
                b.text = names[i];
                set(value);
            }
            b.clicked += () => Step(1);
            b.RegisterCallback<PointerDownEvent>(e => { if (e.button == 1) { Step(-1); e.StopPropagation(); } });
            parent?.Add(b);
            return b;
        }

        Segmented skirmishFormatSeg;
        VisualElement skirmishAiList, skirmishRandomBox;
        Label skirmishSides;
        MapPicker skirmishPicker;

        string SkirmishFormat => string.IsNullOrEmpty(skirmish.Format) ? (watching ? "ffa4" : "1v1") : skirmish.Format;
        /// <summary>The seat of AI entry 0: 1 in New Skirmish (seat 0 is yours), 0 when watching.</summary>
        int SeatBase => watching ? 0 : 1;
        bool SkirmishRandom => FindMap(skirmish.Map) == null;

        static readonly (string id, string text)[] StartResHelp =
        {
            ("low", "300 Materials, 50 Energy: a slow, careful opening."),
            ("standard", "500 Materials, 100 Energy: the usual opening."),
            ("high", "1,500 Materials, 500 Energy: armies in the field early."),
            ("max", "5,000 Materials, 2,000 Energy: straight to a big battle."),
        };
        static readonly (string id, string label)[] StartResOptions = { ("low", "Low"), ("standard", "Standard"), ("high", "High"), ("max", "Max") };
        static readonly (string id, string label)[] StyleOptions = { ("continents", "Continents"), ("pangaea", "Pangaea"), ("archipelago", "Archipelago"), ("inlandSea", "Inland Sea") };
        static readonly (string id, string label)[] SizeOptions = { ("small", "Small"), ("medium", "Standard"), ("large", "Large"), ("huge", "Huge") };
        // the lobby's random world follows the seat count unless the host picks a size
        static readonly (string id, string label)[] LobbySizeOptions = { ("auto", "Auto"), ("small", "Small"), ("medium", "Standard"), ("large", "Large"), ("huge", "Huge") };
        static readonly (string id, string label)[] VictoryOptions = { ("domination", "Domination"), ("control", "Territory"), ("operation", "Operation") };

        /// <summary>A section heading inside a menu column (Sides, Rules, Battlefield).</summary>
        static Label Section(string text, VisualElement parent, bool first = false)
        {
            var l = Line(text.ToUpperInvariant(), "se-menu-section", parent);
            if (first) l.AddToClassList("se-menu-section--first");
            return l;
        }

        VisualElement BuildSkirmish() { watching = false; return BuildSetup(); }

        /// <summary>Watch AI Match: the New Skirmish page with every seat an AI, plus speed and the spectator's view.</summary>
        VisualElement BuildWatch()
        {
            watching = true;
            // a built map remembered from last time: the builder's last sketch, else a random world
            if (watchSetup.Map == "custom" && skirmishCustom == null)
            {
                var last = MapSketch.Load(-1);
                if (last != null) { skirmishSketch = last; skirmishCustom = last.ToEntry(); }
                else watchSetup.Map = "random";
            }
            return BuildSetup();
        }

        VisualElement BuildSetup()
        {
            var p = SubPage(watching ? "Watch AI Match" : "New Skirmish");
            var columns = Box("se-menu-columns", p.Content);
            var left = Box("se-menu-column", columns);
            var right = Box("se-menu-column", columns);
            if (string.IsNullOrEmpty(skirmish.Format)) skirmish.Format = watching ? "ffa4" : "1v1";

            // ---- sides: the format, then one row per seat (you, allies, rivals) with each AI's settings
            Section(watching ? "Nations" : "Sides", left, true);
            skirmishFormatSeg = UiKit.Segmented(Options(Formats), SkirmishFormat, v => SetSkirmishFormat(v), left, 66);
            skirmishAiList = Box("se-ai-list se-ai-list--seats", left);
            skirmishSides = Line("", "se-menu-help-line", left);
            Line("Every AI", "se-menu-label", left);
            Label difficultyHelp = null;
            UiKit.Segmented(Options(("easy", "Relaxed"), ("normal", "Standard"), ("hard", "Hard"), ("expert", "Expert"), ("brutal", "Brutal")),
                skirmish.Difficulty, v =>
                {
                    skirmish.Difficulty = v;
                    foreach (var ai in skirmish.Ais) ai.Difficulty = v;
                    FillSkirmishAis();
                    if (difficultyHelp != null) difficultyHelp.text = HelpFor(DifficultyHelp, v);
                }, left, 79);
            difficultyHelp = Line(HelpFor(DifficultyHelp, skirmish.Difficulty), "se-menu-help-line", left);

            // ---- rules
            Section("Rules", left);
            Line("Victory", "se-menu-label", left);
            Label victoryHelp = null;
            UiKit.Segmented(Options(VictoryOptions), skirmish.Objective,
                v => { skirmish.Objective = v; if (victoryHelp != null) victoryHelp.text = HelpFor(VictoryHelp, v); }, left, 132);
            victoryHelp = Line(HelpFor(VictoryHelp, skirmish.Objective), "se-menu-help-line", left);
            Line("Starting resources", "se-menu-label", left);
            Label resHelp = null;
            UiKit.Segmented(Options(StartResOptions), string.IsNullOrEmpty(skirmish.StartRes) ? "standard" : skirmish.StartRes,
                v => { skirmish.StartRes = v; if (resHelp != null) resHelp.text = HelpFor(StartResHelp, v); }, left, 99);
            resHelp = Line(HelpFor(StartResHelp, string.IsNullOrEmpty(skirmish.StartRes) ? "standard" : skirmish.StartRes), "se-menu-help-line", left);
            if (watching) WatchRules(left);

            // ---- battlefield: a catalog map with a start for every seat, or a random world (style, size, seed)
            Section("Battlefield", right, true);
            skirmishPicker = new MapPicker(() => WithCustom(skirmishCustom), OnSkirmishMap);
            right.Add(skirmishPicker);
            Btn("Map builder", () => OpenBuilder(watching ? "watch" : "skirmish"), right, "terrain").tooltip = "Paint your own map: sea, land, mountains and the bases";
            RequestMaps();
            skirmishRandomBox = Box("se-menu-random", right);
            Line("World style", "se-menu-label", skirmishRandomBox);
            UiKit.Segmented(Options(StyleOptions), skirmish.Style, v => { skirmish.Style = v; SyncSkirmish(); }, skirmishRandomBox, 99);
            Line("World size", "se-menu-label", skirmishRandomBox);
            UiKit.Segmented(Options(SizeOptions), skirmish.MapSize, v => skirmish.MapSize = v, skirmishRandomBox, 99);
            Line("Seed (blank: a new world each time)", "se-menu-label", skirmishRandomBox);
            var seedRow = Box("se-menu-row", skirmishRandomBox);
            var seedField = Field(skirmish.Seed, seedRow, "se-menu-grow");
            seedField.maxLength = 9;
            seedField.RegisterValueChangedCallback(e => skirmish.Seed = (e.newValue ?? "").Trim());
            Btn("Roll", () => seedField.value = UnityEngine.Random.Range(1, 999999).ToString(), seedRow).tooltip = "A random seed you can note down and share";
            UiKit.IconButton("close", () => seedField.value = "", "Clear the seed", seedRow, 36);

            if (!watching)
            {
                Line("Commander name", "se-menu-label", right);
                var nameField = Field(game.PlayerName, right);
                nameField.maxLength = 24;
                nameField.RegisterValueChangedCallback(e => game.PlayerName = e.newValue);
            }

            SyncSkirmish();
            bool watch = watching;
            var start = Btn(watch ? "Watch" : "Start", () =>
            {
                skirmish.Wrap = false;
                EnsureSkirmishAis();
                skirmish.Rivals = skirmish.Ais.Count;
                skirmish.Sketch = skirmish.Map == "custom" ? skirmishSketch?.Encode() : null;
                if (watch) { SaveWatchSetup(); SetStatus("Starting the AI match…"); }
                game.StartCampaign(skirmish);
            }, p.Footer, watch ? "observer" : "play", true);
            if (watch) start.tooltip = "Start the AI match and watch it as a spectator; speed and view change in the match too";
            return p.Root;
        }

        // ---- Watch AI Match: the exhibition's starting speed and what the spectator sees (both change in the match)
        static readonly (string id, string label)[] WatchSpeedOptions = { ("1", "1×"), ("2", "2×"), ("4", "4×"), ("8", "8×") };
        static readonly (string id, string text)[] WatchSpeedHelp =
        {
            ("1", "Real time: every battle at the speed players fight it."),
            ("2", "Twice as fast: the opening passes quickly."),
            ("4", "Four times as fast: a whole war in a coffee break."),
            ("8", "Eight times as fast: for long experiments; battles blur."),
        };
        static readonly (string id, string label)[] WatchViewOptions = { ("map", "Whole map"), ("fog", "Their fog of war") };
        static readonly (string id, string text)[] WatchViewHelp =
        {
            ("map", "See every nation and every unit (the camera follows the nation you pick)."),
            ("fog", "See only what the followed nation sees: scouting and surprise as it plays."),
        };

        void WatchRules(VisualElement parent)
        {
            Section("Watching", parent);
            Line("Match speed", "se-menu-label", parent);
            Label speedHelp = null;
            string speed = (watchSetup.Speed == 2 || watchSetup.Speed == 4 || watchSetup.Speed == 8 ? watchSetup.Speed : 1).ToString();
            UiKit.Segmented(Options(WatchSpeedOptions), speed, v =>
            {
                watchSetup.Speed = int.TryParse(v, out int n) ? n : 1;
                if (speedHelp != null) speedHelp.text = HelpFor(WatchSpeedHelp, v);
            }, parent, 66);
            speedHelp = Line(HelpFor(WatchSpeedHelp, speed), "se-menu-help-line", parent);
            Line("Spectator view", "se-menu-label", parent);
            Label viewHelp = null;
            string view = watchSetup.ObserverFog ? "fog" : "map";
            UiKit.Segmented(Options(WatchViewOptions), view, v =>
            {
                watchSetup.ObserverFog = v == "fog";
                if (viewHelp != null) viewHelp.text = HelpFor(WatchViewHelp, v);
            }, parent, 132);
            viewHelp = Line(HelpFor(WatchViewHelp, view), "se-menu-help-line", parent);
        }

        const string WatchSetupKey = "se.watch.setup";

        /// <summary>The last Watch AI Match choices (PlayerPrefs, like the other menu settings); defaults: four AIs, free for all.</summary>
        void LoadWatchSetup()
        {
            string json = PlayerPrefs.GetString(WatchSetupKey, "");
            if (string.IsNullOrEmpty(json)) return;
            try
            {
                var o = JObject.Parse(json);
                var w = watchSetup;
                string Str(string key, string fallback) => (string)o[key] is string v && v.Length > 0 ? v : fallback;
                w.Format = Str("format", w.Format);
                if (MapPreview.Seats(w.Format) < 2) w.Format = "ffa4";
                w.Map = Str("map", w.Map);
                w.Style = Str("style", w.Style);
                w.MapSize = Str("mapSize", w.MapSize);
                w.Difficulty = Str("difficulty", w.Difficulty);
                w.Objective = Str("objective", w.Objective);
                w.StartRes = Str("startRes", w.StartRes);
                w.Seed = (string)o["seed"] ?? "";
                w.Speed = (int?)o["speed"] ?? 1;
                w.ObserverFog = (bool?)o["fog"] ?? false;
                w.Ais.Clear();
                if (o["ais"] is JArray ais)
                    foreach (var t in ais)
                        if (t is JObject a)
                            w.Ais.Add(new AiSeatOption { Difficulty = (string)a["difficulty"] ?? w.Difficulty, Personality = (string)a["personality"] ?? "random", Closed = (bool?)a["closed"] ?? false });
            }
            catch (Exception e) { Debug.LogWarning("Watch AI Match: could not read the saved setup (" + e.Message + ")"); }
        }

        void SaveWatchSetup()
        {
            var w = watchSetup;
            var ais = new JArray();
            foreach (var ai in w.Ais) ais.Add(new JObject { ["difficulty"] = ai.Difficulty, ["personality"] = ai.Personality, ["closed"] = ai.Closed });
            var o = new JObject
            {
                ["format"] = w.Format, ["map"] = w.Map, ["style"] = w.Style, ["mapSize"] = w.MapSize, ["difficulty"] = w.Difficulty,
                ["objective"] = w.Objective, ["startRes"] = w.StartRes, ["seed"] = w.Seed ?? "", ["speed"] = w.Speed, ["fog"] = w.ObserverFog, ["ais"] = ais,
            };
            PlayerPrefs.SetString(WatchSetupKey, o.ToString(Newtonsoft.Json.Formatting.None));
            PlayerPrefs.Save();
        }

        void SetSkirmishFormat(string format)
        {
            skirmish.Format = format;
            // a catalog map stays while it has a start for every seat; one with fewer starts gives way to a random world
            var m = FindMap(skirmish.Map);
            if (m != null && !m.Fits(MapPreview.Seats(format))) skirmish.Map = "random";
            SyncSkirmish();
        }

        void OnSkirmishMap(string id)
        {
            skirmish.Map = id;
            // the format stays when the map has room for it (spare starts stay neutral); otherwise the map's own
            var m = FindMap(id);
            if (m != null && !m.Fits(MapPreview.Seats(SkirmishFormat))) skirmish.Format = m.Format;
            SyncSkirmish();
        }

        /// <summary>One AI entry per AI seat of the format (kept when the format changes, so choices survive).</summary>
        void EnsureSkirmishAis()
        {
            int need = watching ? Mathf.Max(2, MapPreview.Seats(SkirmishFormat)) : Mathf.Max(1, MapPreview.Seats(SkirmishFormat) - 1);
            while (skirmish.Ais.Count < need) skirmish.Ais.Add(new AiSeatOption { Difficulty = skirmish.Difficulty });
            if (skirmish.Ais.Count > need) skirmish.Ais.RemoveRange(need, skirmish.Ais.Count - need);
            if (!SidesPlayable()) foreach (var ai in skirmish.Ais) ai.Closed = false;
        }

        /// <summary>At least two sides keep a seat (in New Skirmish you are always seated): the server's rule for closed seats.</summary>
        bool SidesPlayable(int extraClosed = -1)
        {
            int ts = MapPreview.TeamSizeOf(SkirmishFormat);
            var sides = new HashSet<int>();
            if (!watching) sides.Add(0);
            for (int i = 0; i < skirmish.Ais.Count; i++)
                if (!skirmish.Ais[i].Closed && i != extraClosed) sides.Add((i + SeatBase) / ts);
            return sides.Count >= 2;
        }

        ulong SkirmishClosedMask()
        {
            ulong mask = 0;
            for (int i = 0; i < skirmish.Ais.Count && i + SeatBase < 63; i++) if (skirmish.Ais[i].Closed) mask |= 1UL << (i + SeatBase);
            return mask;
        }

        void SyncSkirmish()
        {
            EnsureSkirmishAis();
            if (skirmishFormatSeg != null) skirmishFormatSeg.Value = SkirmishFormat;
            if (skirmishRandomBox != null) skirmishRandomBox.style.display = SkirmishRandom ? DisplayStyle.Flex : DisplayStyle.None;
            if (skirmishPicker != null)
            {
                skirmishPicker.Seats = MapPreview.Seats(SkirmishFormat);
                skirmishPicker.Format = SkirmishFormat;
                skirmishPicker.RandomStyle = skirmish.Style;
                skirmishPicker.ClosedSeats = SkirmishClosedMask();
                skirmishPicker.Selected = skirmish.Map;
                skirmishPicker.Refresh();
            }
            FillSkirmishAis();
        }

        /// <summary>"2 v 1" / "Free for all · 3 players": who plays whom once closed seats are left out.</summary>
        static string SidesText(IReadOnlyList<int> perTeam, bool ffa, string who = "players")
        {
            int total = 0, teams = 0;
            foreach (int n in perTeam) if (n > 0) { total += n; teams++; }
            if (ffa) return $"Free for all · {total} {who}";
            var parts = new List<string>();
            foreach (int n in perTeam) if (n > 0) parts.Add(n.ToString());
            return string.Join(" v ", parts) + (teams == perTeam.Count ? "" : " · a side is empty");
        }

        void FillSkirmishAis()
        {
            if (skirmishAiList == null) return;
            UiKit.EnterAdded(skirmishAiList, skirmishAiList.childCount);   // added seats ease in
            skirmishAiList.Clear();
            string format = SkirmishFormat;
            int ts = MapPreview.TeamSizeOf(format);
            bool ffa = format.StartsWith("ffa", StringComparison.Ordinal);
            bool random = SkirmishRandom;
            int teams = Mathf.Max(2, MapPreview.Seats(format) / Mathf.Max(1, ts));
            var perTeam = new int[teams];

            // you: seat 0, team 1 (Watch AI Match has no seat of yours: every seat is an AI)
            if (!watching)
            {
                perTeam[0] = 1;
                var you = Box("se-ai-row se-ai-row--you", skirmishAiList);
                Box("se-team-dot", you).style.backgroundColor = (Color)MapPreview.TeamColor(0);
                Line(ffa ? "You" : "You · Team 1", "se-ai-row-name", you);
                Line(string.IsNullOrEmpty(game.PlayerName) ? "Commander" : game.PlayerName, "se-ai-row-tag", you);
            }

            for (int i = 0; i < skirmish.Ais.Count; i++)
            {
                var ai = skirmish.Ais[i];
                int seat = i + SeatBase, team = seat / ts, index = i;
                bool closed = ai.Closed;
                if (!closed && team < teams) perTeam[team]++;
                var row = Box("se-ai-row", skirmishAiList);
                row.EnableInClassList("se-ai-row--closed", closed);
                var dot = Box("se-team-dot", row);
                dot.style.backgroundColor = closed ? (Color)new Color32(0, 0, 0, 0) : (Color)MapPreview.TeamColor(team);
                dot.EnableInClassList("se-team-dot--empty", closed);
                string who = watching ? (ffa ? $"Nation {seat + 1}" : $"Nation {seat + 1} · Team {team + 1}")
                    : ffa ? $"Rival {seat}" : team == 0 ? "Ally" : $"Rival · Team {team + 1}";
                if (closed)
                {
                    Line(who + " · seat left empty", "se-ai-row-name se-ai-row-name--closed", row);
                    SmallButton("+ AI", () => { ai.Closed = false; SyncSkirmish(); }, row, "Put an AI in this seat again");
                    continue;
                }
                Line(who, "se-ai-row-name", row);
                Cycle(DifficultyIds, DifficultyNames, ai.Difficulty, v => ai.Difficulty = v, row, "Difficulty");
                Cycle(PersonalityIds, PersonalityNames, ai.Personality, v => ai.Personality = v, row, "Personality: Warlord attacks early, Merchant builds an economy, Builder fortifies");
                var remove = UiKit.IconButton("close", () =>
                {
                    if (!SidesPlayable(index)) { SetStatus(watching ? "At least two sides need an AI nation" : "Both sides need at least one player"); return; }
                    ai.Closed = true;
                    SyncSkirmish();
                }, "Leave this seat empty (uneven sides: 2 v 1, 1 v 3 …)", row, 26);
                remove.AddToClassList("se-lobby-icon");
                remove.SetEnabled(SidesPlayable(index));
            }
            // a custom map: which team starts on which base (MainMenu.Builder.cs, MAP_BUILDER_TEAMS.md)
            if (!random && skirmish.Map == "custom" && skirmishSketch != null)
                BaseOwnerRows(skirmishAiList, skirmishSketch, MapPreview.Seats(format), ts, SkirmishClosedMask(), ffa, true,
                    next => { skirmishSketch = next; skirmishCustom = next.ToEntry(); SyncSkirmish(); });
            if (skirmishSides != null)
                skirmishSides.text = SidesText(perTeam, ffa, watching ? "AI nations" : "players") + (skirmish.Ais.Count < 2 ? "" : " · ✕ leaves a seat empty for uneven sides") +
                    (!random && FindMap(skirmish.Map) is MapCatalogEntry sm && sm.Players > MapPreview.Seats(format) ? $" · {sm.Name} has {sm.Players} starts; the spare ones stay neutral" : "");
        }

        // ------------------------------------------------------------------ multiplayer
        Label mpSocial;
        Button mpFriends;

        VisualElement BuildMultiplayer()
        {
            var p = SubPage("Multiplayer");

            Section("Host", p.Content, true);
            var hostRow = Box("se-menu-host-row", p.Content);
            var host = Item("invite", "Host a lobby", () => game.HostMultiplayer(MapPreview.TeamSizeOf(hostFormat), "random", hostFormat), hostRow);
            host.AddToClassList("se-menu-grow");
            host.AddToClassList("se-menu-item--primary");
            host.tooltip = "Open a match lobby; choose the map, teams, AI and rules there, then share its code or invite Steam friends";
            Line("Opening format (change it in the lobby)", "se-menu-help-line", p.Content);
            // the format to open with (the host can change it, the map and the AI seats in the lobby)
            UiKit.Segmented(Options(Formats), hostFormat, v => hostFormat = v, p.Content, 66).AddToClassList("se-menu-team-size");

            Section("Join", p.Content);
            Item("overview", "Browse public lobbies", () => Go("browse"), p.Content).tooltip = "Lobbies their hosts listed publicly on this server";
            mpFriends = Item("friends", "Join a friend", () => Go("friends"), p.Content);
            Item("code", "Join by code", () => { codeMode = "join"; Go("code"); }, p.Content);
            Item("observer", "Spectate by code", () => { codeMode = "spectate"; Go("code"); }, p.Content).tooltip = "Watch a match, or sit in a lobby's spectator seats";
            mpSocial = Line("", "se-menu-note", p.Content);
            UpdateMultiplayer();
            RequestMaps();

            // Advanced ▸ : name and server (rarely needed; collapsed)
            var toggle = Btn(advancedOpen ? "Advanced ▾" : "Advanced ▸", null, p.Content);
            toggle.AddToClassList("se-menu-disclosure");
            var advanced = Box("se-menu-advanced", p.Content);
            var toggleLabel = toggle.Q<Label>();
            toggle.clicked += () =>
            {
                advancedOpen = !advancedOpen;
                advanced.style.display = advancedOpen ? DisplayStyle.Flex : DisplayStyle.None;
                if (toggleLabel != null) toggleLabel.text = advancedOpen ? "Advanced ▾" : "Advanced ▸";
            };
            advanced.style.display = advancedOpen ? DisplayStyle.Flex : DisplayStyle.None;
            Line("Commander name", "se-menu-label", advanced);
            var nameField = Field(game.PlayerName, advanced);
            nameField.maxLength = 24;
            nameField.RegisterValueChangedCallback(e => game.PlayerName = e.newValue);
            Line("Server", "se-menu-label", advanced);
            var srv = Box("se-menu-row", advanced);
            var serverField = Field(game.Server, srv, "se-menu-grow");
            serverField.RegisterValueChangedCallback(e => game.Server = e.newValue);
            Btn("Public", () => serverField.value = App.LaunchOptions.PublicServer, srv);
            if (Application.isEditor || Debug.isDebugBuild) Btn("Local", () => serverField.value = App.LaunchOptions.LocalServer, srv);
            return p.Root;
        }

        // ------------------------------------------------------------------ public lobby browser (server /api/lobbies)
        VisualElement browseRows;
        Label browseNote;
        bool browseLoading;

        VisualElement BuildBrowse()
        {
            var p = SubPage("Public lobbies");
            browseNote = Line("Looking for lobbies…", "se-menu-note", p.Content);
            browseRows = Box("se-menu-friends", p.Content);
            RefreshBrowse();
            // refresh every 4 s while the page is open (scheduled items stop when it is detached)
            browseRows.schedule.Execute(RefreshBrowse).Every(4000);
            Btn("Refresh", RefreshBrowse, p.Footer);
            return p.Root;
        }

        void RefreshBrowse()
        {
            if (browseLoading || game == null || browseRows == null) return;
            if (!Uri.TryCreate(game.Server ?? "", UriKind.Absolute, out var ws) || (ws.Scheme != "ws" && ws.Scheme != "wss"))
            { browseNote.text = "Set a server in Multiplayer › Advanced"; return; }
            var url = new UriBuilder(ws) { Scheme = ws.Scheme == "wss" ? "https" : "http", Path = "/api/lobbies", Query = "" };
            if (url.Port == (ws.Scheme == "wss" ? 443 : 80)) url.Port = -1;
            browseLoading = true;
            var request = UnityEngine.Networking.UnityWebRequest.Get(url.Uri);
            request.timeout = 6;
            request.SendWebRequest().completed += _ =>
            {
                browseLoading = false;
                try
                {
                    if (browseRows == null || browseRows.panel == null) return;
                    if (request.result != UnityEngine.Networking.UnityWebRequest.Result.Success)
                    { browseNote.text = "The server's lobby list is unavailable (" + request.error + ")"; return; }
                    FillBrowse(JArray.Parse(request.downloadHandler.text));
                }
                catch (Exception e) { if (browseNote != null) browseNote.text = "Could not read the lobby list: " + e.Message; }
                finally { request.Dispose(); }
            };
        }

        void FillBrowse(JArray list)
        {
            UiKit.EnterAdded(browseRows, browseRows.childCount);   // new lobbies ease in; the 4 s refresh never flashes
            browseRows.Clear();
            int shown = 0;
            foreach (var t in list)
            {
                if (!(t is JObject o)) continue;
                string code = (string)o["id"] ?? "";
                if (code == "") continue;
                shown++;
                int open = (int?)o["open"] ?? 0, seats = (int?)o["seats"] ?? 0, players = (int?)o["players"] ?? 0, watching = (int?)o["spectators"] ?? 0;
                var row = Box("se-menu-friend", browseRows);
                var avatar = Box("se-menu-avatar", row);
                avatar.Add(new IconElement("multiplayer"));
                var names = Box("se-menu-friend-names", row);
                Line((string)o["name"] ?? code, "se-menu-friend-name", names);
                string mapName = (string)o["map"] == "random" ? "Random world" : (string)o["mapName"] ?? "";
                Line($"{MapPreview.FormatLabel((string)o["format"])} · {mapName} · {HelpFor(VictoryHelpShort, (string)o["objective"] ?? "domination")} · host {(string)o["host"]}" + (watching > 0 ? $" · {watching} watching" : ""),
                    "se-menu-friend-lobby", names);
                Line($"{players}/{seats}", "se-menu-friend-slots", row).tooltip = $"{players} players seated, {open} open seat{(open == 1 ? "" : "s")}";
                string c = code;
                Btn("Watch", () => { SetStatus("Opening lobby " + c + " as a spectator…"); game.StartMatch("spectate", c); }, row).tooltip = "Take a spectator seat; you watch the match when it starts";
                var join = Btn("Join", () => { SetStatus("Joining lobby " + c + "…"); game.StartMatch("join", c); }, row, null, true);
                join.AddToClassList("se-menu-friend-join");
                join.SetEnabled(open > 0);
                if (open == 0) join.tooltip = "Every seat is taken";
            }
            browseNote.text = shown == 0 ? "No public lobbies right now. Host one and set it to Public, or join a friend by code." : $"{shown} public lobb{(shown == 1 ? "y" : "ies")} · updated every few seconds";
        }

        static readonly (string id, string text)[] VictoryHelpShort = { ("domination", "Domination"), ("control", "Territory"), ("operation", "Operation") };

        void UpdateMultiplayer()
        {
            var social = game?.Social;
            if (mpFriends != null)
            {
                bool steam = social != null && social.Available;
                mpFriends.SetEnabled(steam);
                mpFriends.tooltip = steam ? "Friends hosting a Shattered Empires lobby, and public lobbies of this version" : social?.Status;
            }
            if (mpSocial != null)
            {
                mpSocial.text = social?.Status ?? "";
                mpSocial.tooltip = mpSocial.text;
            }
        }

        // ------------------------------------------------------------------ maps
        // Shown until the server's catalog (/api/maps) arrives, which replaces it; ids must match server/sim/mapCatalog.js.
        // Same order as SetMaps sorts: fewest players first, then by size.
        static readonly MapCatalogEntry[] BuiltInMaps =
        {
            new MapCatalogEntry { Id = "twin_rivers", Name = "Twin Rivers", Players = 2, TeamSize = 1, Size = 76,
                Description = "Two rivers frame a central ridge. Roads built along the coast bridge both rivers; the direct route wades the fords to the Ridgeway saddle." },
            new MapCatalogEntry { Id = "serpentine", Name = "Serpentine", Players = 2, TeamSize = 1, Size = 80,
                Description = "Long ridges fold the valley into an S around the Coil; river fords cut the bends and a saddle lets infantry climb straight over." },
            new MapCatalogEntry { Id = "mirefen_gap", Name = "Mirefen Gap", Players = 2, TeamSize = 1, Size = 84,
                Description = "Two fen lakes cut the map coast to coast. Mirefen holds the dry gap between them; bridges you build on the coast and upstream fords open the flanks." },
            new MapCatalogEntry { Id = "fortress_pass", Name = "Fortress Pass", Players = 2, TeamSize = 1, Size = 84,
                Description = "A wall of impassable peaks splits the map: one winding canyon to the Keep, and two narrow goat trails far to the north and south." },
            new MapCatalogEntry { Id = "three_crowns", Name = "Three Crowns", Players = 3, TeamSize = 1, Size = 96,
                Description = "Free for all. Three realms around the Crown plateau, each split from the next by a border river with one bridge site and one ford." },
            new MapCatalogEntry { Id = "shattered_delta", Name = "Shattered Delta", Players = 3, TeamSize = 1, Size = 104,
                Description = "Free for all. Three rivers run into a central lagoon, one between each pair of realms; delta towns hold the crossings." },
            new MapCatalogEntry { Id = "ring_of_fire", Name = "Ring of Fire", Players = 3, TeamSize = 1, Size = 104,
                Description = "Free for all. A ring of volcanic peaks walls in a rich caldera; three gates breach it, each between two realms." },
            new MapCatalogEntry { Id = "highland_fork", Name = "Highland Fork", Players = 4, TeamSize = 2, Size = 100,
                Description = "Rivers fall north and south from the Fork plateau: the flanks need bridges and fords while the centre climbs open hills." },
            new MapCatalogEntry { Id = "crossroads", Name = "Crossroads", Players = 4, TeamSize = 1, Size = 104,
                Description = "Free for all. Four realms around the Hub; lakes on the diagonals split the approaches into lanes." },
            new MapCatalogEntry { Id = "stepping_stones", Name = "Stepping Stones", Players = 4, TeamSize = 2, Size = 104,
                Description = "Every capital on its own island; causeways and bridges, once roads are built, chain the islands into three lanes. Long ground routes: air matters." },
            new MapCatalogEntry { Id = "king_of_the_hill", Name = "King of the Hill", Players = 4, TeamSize = 1, Size = 104,
                Description = "Free for all. A sheer-sided plateau with one ramp per realm: hold the Summit and see everything, but every ramp leads to you." },
            new MapCatalogEntry { Id = "saltmarsh_estuary", Name = "Saltmarsh Estuary", Players = 4, TeamSize = 2, Size = 108,
                Description = "A tidal sound splits the coast. Land bridges cross it north and south; causeways built with roads reach Tidewater Isle in the middle." },
            new MapCatalogEntry { Id = "fjordmark", Name = "Fjordmark", Players = 4, TeamSize = 2, Size = 108,
                Description = "Two cliff-walled fjords cut deep into the land; the centre is reached around a fjord head or over the Narrows rock bridge." },
            new MapCatalogEntry { Id = "quarry_highlands", Name = "Quarry Highlands", Players = 4, TeamSize = 1, Size = 112,
                Description = "Free for all. An impassable massif fills the centre; four passes cross its shoulders between neighbouring realms." },
            new MapCatalogEntry { Id = "iron_basin", Name = "Iron Basin", Players = 6, TeamSize = 3, Size = 128,
                Description = "Two lakes split the basin into three fronts; the centre lane narrows to the Iron Gate mountain pass." },
            new MapCatalogEntry { Id = "twin_continents", Name = "Twin Continents", Players = 6, TeamSize = 3, Size = 128,
                Description = "Two continents across an inland sea, joined by thin isthmuses far north and south and by causeways to Midsea. Air does not take the long way." },
            new MapCatalogEntry { Id = "continental_divide", Name = "Continental Divide", Players = 6, TeamSize = 3, Size = 132,
                Description = "A mountain divide runs around Lake Meridian. Two high passes and the lakeshore gates are the only ways across." },
        };

        readonly List<MapCatalogEntry> maps = new List<MapCatalogEntry>(BuiltInMaps);
        bool mapsRequested;
        string hostFormat = "1v1";
        VisualElement[] skirmishLocked;

        MapCatalogEntry FindMap(string id)
        {
            if (string.IsNullOrEmpty(id) || id == "random") return null;
            if (id == "custom") return skirmishCustom;   // the map builder's sketch (MainMenu.Builder.cs)
            foreach (var m in maps) if (m.Id == id) return m;
            return null;
        }

        /// <summary>The server's map catalog (a JSON array of { id, name, players, teamSize, size, description, preview }).</summary>
        public void SetMaps(JArray list)
        {
            if (list == null) return;
            var next = new List<MapCatalogEntry>();
            foreach (var t in list)
            {
                var e = MapCatalogEntry.Parse(t);
                if (e != null) next.Add(e);
            }
            if (next.Count == 0) return;
            // fewest players first, then by size: the list reads 1v1 → FFA → team maps
            next.Sort((a, b) => a.Players != b.Players ? a.Players.CompareTo(b.Players) : a.Size.CompareTo(b.Size));
            maps.Clear();
            maps.AddRange(next);
            foreach (var setup in new[] { soloSetup, watchSetup }) if (FindMap(setup.Map) == null) setup.Map = "random";
            if (skirmishPicker != null && skirmishPicker.panel != null) SyncSkirmish();
            if (lobbyPicker != null && lobbyPicker.panel != null) UpdateLobby();
        }

        // The catalog over HTTP from the configured server (wss://host/ws → https://host/api/maps), once.
        void RequestMaps()
        {
            if (mapsRequested || game == null) return;
            if (!Uri.TryCreate(game.Server ?? "", UriKind.Absolute, out var ws) || (ws.Scheme != "ws" && ws.Scheme != "wss")) return;
            mapsRequested = true;
            var url = new UriBuilder(ws) { Scheme = ws.Scheme == "wss" ? "https" : "http", Path = "/api/maps", Query = "" };
            if (url.Port == (ws.Scheme == "wss" ? 443 : 80)) url.Port = -1;
            var request = UnityEngine.Networking.UnityWebRequest.Get(url.Uri);
            request.timeout = 8;
            request.SendWebRequest().completed += _ =>
            {
                try
                {
                    if (request.result == UnityEngine.Networking.UnityWebRequest.Result.Success)
                        SetMaps(JArray.Parse(request.downloadHandler.text));
                    else mapsRequested = false;   // offline: keep the built-in list, try again next time
                }
                catch (Exception) { mapsRequested = false; }
                finally { request.Dispose(); }
            };
        }

        // ------------------------------------------------------------------ join a friend (Steam)
        VisualElement friendRows;

        VisualElement BuildFriends()
        {
            var p = SubPage("Join a friend");
            friendRows = Box("se-menu-friends", p.Content);
            if (game.Social is IFriendLobbyList list)
            {
                list.RefreshFriends();
                // refresh every 5 s while the page is open (scheduled items stop when it is detached)
                friendRows.schedule.Execute(() => { list.RefreshFriends(); FillFriends(); }).Every(5000);
            }
            FillFriends();
            Btn("Open Steam friends", OpenFriends, p.Footer, "friends").tooltip = "Join a friend's game from the Steam friends list";
            // always possible, with or without Steam: the host reads the code off their lobby page
            Btn("Join by code", () => { codeMode = "join"; Go("code"); }, p.Footer, "code").tooltip = "Type the match code your host shares (shown on their lobby page)";
            return p.Root;
        }

        void OpenFriends()
        {
            if (game.Social is IFriendLobbyList list) list.OpenFriendsOverlay();
            else SetStatus("Open Steam with Shift+Tab, then choose Join Game on a friend who is hosting");
        }

        void FillFriends()
        {
            if (friendRows == null) return;
            UiKit.EnterAdded(friendRows, friendRows.childCount);
            friendRows.Clear();
            var social = game.Social;
            IReadOnlyList<FriendLobby> sessions = (social as IFriendLobbyList)?.FriendSessions();
            if (sessions == null || sessions.Count == 0)
            {
                Line(social is IFriendLobbyList ? "No lobbies of this version right now (v" + Application.version + ")" : "Friends who host appear in your Steam friends list",
                    "se-menu-empty", friendRows);
                Line("Accept a friend's invite, or choose Join Game on them in the Steam friends list, and the game opens their lobby.",
                    "se-menu-note se-menu-note--wrap", friendRows);
                return;
            }
            foreach (var s in sessions)
            {
                ulong id = s.LobbyId;
                var row = Box("se-menu-friend", friendRows);
                var avatar = Box("se-menu-avatar", row);
                avatar.Add(new IconElement("friends"));
                var names = Box("se-menu-friend-names", row);
                Line(s.FriendName, "se-menu-friend-name", names);
                Line(s.LobbyName + (string.IsNullOrEmpty(s.Detail) ? "" : " · " + s.Detail) + (s.Public ? " · public" : ""), "se-menu-friend-lobby", names);
                Line($"{s.Members}/{Mathf.Max(s.Members, s.MaxMembers)}", "se-menu-friend-slots", row);
                Btn("Join", () => { SetStatus("Joining the Steam lobby…"); game.Social.JoinLobby(id); }, row, null, true).AddToClassList("se-menu-friend-join");
            }
        }

        // ------------------------------------------------------------------ join / spectate by code
        VisualElement BuildCode()
        {
            bool watch = codeMode == "spectate";
            string mode = codeMode;
            var p = SubPage(watch ? "Spectate by code" : "Join by code");
            Line(watch ? "The code of a match that has started" : "The match code your host shared", "se-menu-label", p.Content);
            var row = Box("se-menu-row", p.Content);
            var field = Field("", row, "se-menu-code-field");
            field.AddToClassList("se-menu-grow");
            field.maxLength = 16;
            field.RegisterValueChangedCallback(e =>
            {
                string lower = (e.newValue ?? "").ToLowerInvariant();
                if (lower != e.newValue) field.SetValueWithoutNotify(lower);
            });
            void Submit()
            {
                string code = LobbyMessages.NormalizeCode(field.value);
                if (code == "") { SetStatus("Enter the match code: six letters and digits, for example k3x9qa"); return; }
                SetStatus(watch ? "Opening match " + code + "…" : "Joining match " + code + "…");
                game.StartMatch(mode, code);
            }
            UiKit.IconButton("copy", () => { field.value = (GUIUtility.systemCopyBuffer ?? "").Trim(); field.Focus(); }, "Paste", row, 36);
            field.RegisterCallback<KeyDownEvent>(e =>
            {
                if (e.keyCode != KeyCode.Return && e.keyCode != KeyCode.KeypadEnter) return;
                e.StopPropagation();
                Submit();
            }, TrickleDown.TrickleDown);
            Btn(watch ? "Watch" : "Join", Submit, p.Footer, watch ? "observer" : "play", true);
            field.schedule.Execute(() => field.Focus()).ExecuteLater(30);
            return p.Root;
        }

        // ------------------------------------------------------------------ lobby (B16)
        MatchRoom lobby;
        string lobbyCode = "", lobbyMapName = "";
        Label lobbyTitle, lobbyCodeLabel, lobbyMap, lobbySocial, lobbyWaiting, lobbySides, lobbyRules, lobbySpectatorNames;
        VisualElement lobbySeats, lobbyFormatRow, lobbyRulesHost, lobbyRandomBox;
        Segmented lobbyFormatSeg, lobbyVictorySeg, lobbyResSeg, lobbyStyleSeg, lobbySizeSeg;
        Label lobbyFormatLabel;
        MapPicker lobbyPicker;
        Button lobbyStart, lobbyReady, lobbyInvite, lobbyVisibility, lobbyWatch;
        bool lobbyReadyOn;

        void OpenLobbyPage()
        {
            if (pages.Top == "lobby") UpdateLobby();
            else Go("lobby");
        }

        VisualElement BuildLobby()
        {
            var p = SubPage("Lobby");
            lobbyTitle = p.Title;
            var codeRow = Box("se-lobby-code-row", p.Content);
            Line("Match code", "se-menu-label se-lobby-code-caption", codeRow);
            lobbyCodeLabel = Line("", "se-lobby-code", codeRow);
            UiKit.IconButton("copy", CopyCode, "Copy the match code", codeRow, 36);
            Box("se-menu-spacer", codeRow);
            lobbyVisibility = Btn("Private", ToggleVisibility, codeRow, "lock");
            lobbyInvite = Btn("Invite Steam friends", InviteFromLobby, codeRow, "invite");

            // format: the host picks it; everyone else sees it
            lobbyFormatRow = Box("se-lobby-format-row", p.Content);
            Line("Format", "se-menu-label se-lobby-format-caption", lobbyFormatRow);
            lobbyFormatSeg = UiKit.Segmented(Options(Formats), lobby?.Format ?? "1v1", v => game.SendLobby(LobbyMessages.Mode(v)), lobbyFormatRow, 66);
            lobbyFormatLabel = Line("", "se-lobby-format", lobbyFormatRow);

            var columns = Box("se-menu-columns", p.Content);
            var left = Box("se-menu-column", columns);
            var right = Box("se-menu-column", columns);

            // ---- players by team, then the spectator seats
            Section("Players", left, true);
            lobbySeats = Box("se-lobby-teams", left);
            lobbySides = Line("", "se-menu-help-line", left);
            Section("Spectators", left);
            var watchRow = Box("se-lobby-watch-row", left);
            lobbySpectatorNames = Line("", "se-lobby-spectators", watchRow);
            lobbyWatch = Btn("Watch instead", ToggleWatch, watchRow, "observer");

            // ---- battlefield and rules: editable by the host, a summary for everyone else
            Section("Battlefield", right, true);
            lobbyPicker = new MapPicker(() => WithCustom(lobbyCustom), id => game.SendLobby(id == "custom" && lobbySketch != null ? LobbyMessages.CustomMap(lobbySketch.Encode()) : LobbyMessages.Map(id)));
            right.Add(lobbyPicker);
            RequestMaps();
            lobbyRulesHost = Box("se-lobby-rules", right);
            Btn("Map builder", () => OpenBuilder("lobby"), lobbyRulesHost, "terrain").tooltip = "Paint your own map for this lobby; everyone sees its preview";
            lobbyRandomBox = Box("se-menu-random", lobbyRulesHost);
            Line("World style", "se-menu-label", lobbyRandomBox);
            lobbyStyleSeg = UiKit.Segmented(Options(StyleOptions), "pangaea", v => game.SendLobby(LobbyMessages.Option("style", v)), lobbyRandomBox, 99);
            Line("World size", "se-menu-label", lobbyRandomBox);
            lobbySizeSeg = UiKit.Segmented(Options(LobbySizeOptions), "auto", v => game.SendLobby(LobbyMessages.Option("size", v)), lobbyRandomBox, 79);
            Section("Rules", lobbyRulesHost);
            Line("Victory", "se-menu-label", lobbyRulesHost);
            lobbyVictorySeg = UiKit.Segmented(Options(VictoryOptions), "domination", v => game.SendLobby(LobbyMessages.Option("objective", v)), lobbyRulesHost, 132);
            Line("Starting resources", "se-menu-label", lobbyRulesHost);
            lobbyResSeg = UiKit.Segmented(Options(StartResOptions), "standard", v => game.SendLobby(LobbyMessages.Option("startRes", v)), lobbyRulesHost, 99);
            lobbyRules = Line("", "se-lobby-rules-text", right);

            lobbyMap = Line("", "se-lobby-map", p.Content);
            lobbySocial = Line("", "se-menu-note", p.Content);
            // Steam friends with an Invite button each: works even when the Steam overlay cannot open in the game
            lobbyFriendsBox = Box("se-lobby-steam-friends", p.Content);
            Section("Invite Steam friends", lobbyFriendsBox);
            var friendTools = Box("se-menu-row", lobbyFriendsBox);
            Btn("Copy match code", CopyCode, friendTools, "copy");
            lobbyFriendsHint = Line("", "se-menu-note se-menu-note--wrap", lobbyFriendsBox);
            lobbyFriendRows = Box("se-menu-friends", lobbyFriendsBox);
            lobbyFriendRows.schedule.Execute(FillLobbyFriends).Every(3000);
            FillLobbyFriends();

            // footer: [Back] is Leave here (it leaves the lobby); Ready; Start (host) or Waiting
            var back = p.Footer.Q<Button>();
            var backLabel = back?.Q<Label>();
            if (backLabel != null) backLabel.text = "Leave";
            lobbyReady = Btn("Ready", ToggleReady, p.Footer, "check");
            lobbyWaiting = Line("Waiting for host", "se-lobby-waiting", p.Footer);
            lobbyStart = Btn("Start match", () => game.StartLobbyMatch(), p.Footer, "play", true);
            UpdateLobby();
            return p.Root;
        }

        void CopyCode()
        {
            string code = lobby?.Code ?? lobbyCode;
            if (string.IsNullOrEmpty(code)) return;
            GUIUtility.systemCopyBuffer = code;
            SetStatus("Match code " + code + " copied");
        }

        void InviteFromLobby()
        {
            var social = game.Social;
            if (social == null || !social.Available) { SetStatus(social?.Status ?? "Share the match code instead"); return; }
            string code = lobby?.Code ?? lobbyCode;
            if (social.Lobby != null && social.Lobby.MatchCode == code) social.InviteFriends();
            else social.InviteFriends(code, lobby?.Name ?? "");
        }

        /// <summary>Host: list the lobby publicly (the server's lobby browser, and Steam lobbies of this version) or keep it private.</summary>
        void ToggleVisibility()
        {
            bool on = lobby != null ? lobby.Public : PlayerPrefs.GetInt("se.lobby.public", 0) == 1;
            PlayerPrefs.SetInt("se.lobby.public", on ? 0 : 1);
            PlayerPrefs.Save();
            // the server answers with a fresh room; the bootstrap re-applies the Steam lobby on it
            game.SendLobby(LobbyMessages.Option("public", !on));
        }

        /// <summary>A player steps out to the spectator seats; a spectator takes the first open seat.</summary>
        void ToggleWatch()
        {
            if (lobby == null) return;
            if (lobby.Spectator) game.SendLobby(LobbyMessages.Sit());
            else game.SendLobby(LobbyMessages.Watch());
        }

        void ToggleReady()
        {
            lobbyReadyOn = !lobbyReadyOn;
            game.SetLobbyReady(lobbyReadyOn);
            UpdateLobby();
        }

        void LeaveLobbyPage()
        {
            game.LeaveLobby();
            lobbyReadyOn = false;
            ShowMultiplayer();
        }

        static string OptionLabel((string id, string label)[] options, string id)
        {
            foreach (var (key, label) in options) if (key == id) return label;
            return string.IsNullOrEmpty(id) ? options[0].label : id;
        }

        void UpdateLobby()
        {
            if (lobbySeats == null || lobbySeats.panel == null && pages.Top != "lobby") return;
            var r = lobby;
            string code = r?.Code ?? lobbyCode;
            bool isHost = r != null && r.IsHost;
            bool spectator = r != null && r.Spectator;
            if (lobbyTitle != null) lobbyTitle.text = r != null && !string.IsNullOrEmpty(r.Name) ? "Lobby · " + r.Name : "Lobby";
            lobbyCodeLabel.text = string.IsNullOrEmpty(code) ? "······" : code;

            // format: editable by the host; a format the buttons do not offer (ffa5) still reads correctly
            string format = r?.Format ?? "";
            lobbyFormatRow.style.display = r == null ? DisplayStyle.None : DisplayStyle.Flex;
            lobbyFormatSeg.Value = format;
            lobbyFormatSeg.style.display = isHost ? DisplayStyle.Flex : DisplayStyle.None;
            lobbyFormatLabel.text = isHost ? "" : MapPreview.FormatLabel(format) + (r != null && r.Teams > 2 ? " · free for all" : "");
            lobbyFormatLabel.style.display = isHost ? DisplayStyle.None : DisplayStyle.Flex;

            // seats grouped by team (server: team = seat index / team size)
            UiKit.EnterAdded(lobbySeats, lobbySeats.childCount <= 1 ? 0 : lobbySeats.childCount);   // the teams ease in once filled
            lobbySeats.Clear();
            int humans = 0;
            bool random = r == null || string.IsNullOrEmpty(r.Map) || r.Map == "random";
            ulong closedMask = 0;
            if (r == null || r.Seats.Count == 0)
                Line("Joining the lobby…", "se-menu-note", lobbySeats);
            else
            {
                int teamSize = Mathf.Max(1, r.TeamSize);
                int teams = Mathf.Max(r.Teams, (r.Seats.Count + teamSize - 1) / teamSize);
                int myTeam = r.You >= 0 && r.You < r.Seats.Count ? r.Seats[r.You].Team : -1;
                var perTeam = new int[teams];
                for (int t = 0; t < teams; t++)
                {
                    var team = Box("se-lobby-team", lobbySeats);
                    var head = Box("se-lobby-team-head", team);
                    var swatch = Box("se-team-dot", head);
                    swatch.style.backgroundColor = (Color)MapPreview.TeamColor(t);
                    Line(teamSize == 1 && teams > 2 ? "Player " + (t + 1) : "Team " + (t + 1), "se-lobby-team-title", head);
                    Box("se-menu-spacer", head);
                    if (t != myTeam && myTeam >= 0 && HasFreeSeat(r, t))
                    {
                        int target = t;
                        SmallButton("Join team", () => game.SendLobby(LobbyMessages.Team(target)), head, "Move to this team");
                    }
                    for (int i = t * teamSize; i < Mathf.Min(r.Seats.Count, (t + 1) * teamSize); i++)
                    {
                        if (!r.Seats[i].Closed) perTeam[t]++;
                        else if (i < 63) closedMask |= 1UL << i;
                        SeatRow(r, i, team, random);
                    }
                }
                foreach (var s in r.Seats) if (s.Human && s.Taken) humans++;
                // a custom map: the host assigns the bases to teams (sent as the room's sketch; guests see it)
                if (r.Map == "custom" && lobbySketch != null)
                    BaseOwnerRows(lobbySeats, lobbySketch, r.Seats.Count, teamSize, closedMask, teamSize == 1 && teams > 2, isHost,
                        next => game.SendLobby(LobbyMessages.CustomMap(next.Encode())));
                var lm = r.Map == "custom" ? lobbyCustom : FindMap(r.Map);
                lobbySides.text = SidesText(perTeam, format.StartsWith("ffa", StringComparison.Ordinal)) +
                    (isHost ? " · Close leaves an empty seat out (uneven sides)" : "") +
                    (lm != null && lm.Players > r.Seats.Count ? $" · {lm.Name} has {lm.Players} starts; the spare ones stay neutral" : "");
            }

            // spectators
            if (r != null)
            {
                lobbySpectatorNames.text = r.Spectators.Count == 0 ? "No one is watching" : string.Join(", ", r.Spectators) + (spectator ? " (you)" : "");
                lobbySpectatorNames.tooltip = lobbySpectatorNames.text;
                UiKit.SetText(lobbyWatch, spectator ? "Take a seat" : "Watch instead");
                lobbyWatch.style.display = isHost ? DisplayStyle.None : DisplayStyle.Flex;
                lobbyWatch.SetEnabled(spectator ? r.Open > 0 : r.You >= 0);
                lobbyWatch.tooltip = spectator ? (r.Open > 0 ? "Sit in the first open seat" : "Every seat is taken") : "Give up your seat and watch the match as a spectator";
            }

            // map: the host picks from every map (filtered by format); guests see the preview of the choice
            if (lobbyPicker != null)
            {
                lobbyPicker.Editable = isHost;
                lobbyPicker.Seats = r?.Seats.Count ?? 0;
                lobbyPicker.Format = r?.Format;
                lobbyPicker.RandomStyle = string.IsNullOrEmpty(r?.Style) ? "pangaea" : r.Style;
                lobbyPicker.ClosedSeats = closedMask;
                lobbyPicker.Selected = r?.Map ?? "random";
                lobbyPicker.FallbackName = r?.MapName ?? "";
                lobbyPicker.Refresh();
            }
            // rules: segments for the host (random-world controls only on a random world), a summary for the rest
            lobbyRulesHost.style.display = isHost ? DisplayStyle.Flex : DisplayStyle.None;
            lobbyRandomBox.style.display = isHost && random ? DisplayStyle.Flex : DisplayStyle.None;
            if (r != null)
            {
                lobbyVictorySeg.Value = r.Objective;
                lobbyResSeg.Value = r.StartRes;
                lobbyStyleSeg.Value = string.IsNullOrEmpty(r.Style) ? "pangaea" : r.Style;
                lobbySizeSeg.Value = string.IsNullOrEmpty(r.SizeKey) ? "auto" : r.SizeKey;
            }
            lobbyRules.text = r == null ? "" : $"Victory: {OptionLabel(VictoryOptions, r.Objective)} · Start: {OptionLabel(StartResOptions, r.StartRes)}" +
                (random ? $" · World: {OptionLabel(StyleOptions, string.IsNullOrEmpty(r.Style) ? "pangaea" : r.Style)}" : "");
            lobbyRules.tooltip = r == null ? null : HelpFor(VictoryHelp, r.Objective) + " " + HelpFor(StartResHelp, r.StartRes);

            lobbyMap.text = r == null ? "" : (!string.IsNullOrEmpty(lobbyMapName) ? lobbyMapName + " · " : "Random world · ") + (r.MapSize > 0 ? $"{r.MapSize}×{r.MapSize} · " : "") +
                MapPreview.FormatLabel(r.Format) + (r.Open > 0 ? $" · {r.Open} open seat{(r.Open == 1 ? "" : "s")}" : "") +
                (r.WaitForReady ? " · starts when everyone is ready" : "");

            var social = game.Social;
            bool steam = social != null && social.Available;
            lobbyInvite.style.display = steam ? DisplayStyle.Flex : DisplayStyle.None;
            lobbyInvite.SetEnabled(steam && !string.IsNullOrEmpty(code));
            lobbyInvite.tooltip = steam ? "Opens the Steam overlay invite dialog (if the overlay does not open, use Invite on a friend below)" : social?.Status;
            if (lobbyFriendsBox != null) lobbyFriendsBox.style.display = steam ? DisplayStyle.Flex : DisplayStyle.None;
            bool pub = r != null && r.Public;
            lobbyVisibility.style.display = isHost ? DisplayStyle.Flex : DisplayStyle.None;
            UiKit.SetText(lobbyVisibility, pub ? "Public" : "Private");
            lobbyVisibility.EnableInClassList("selected", pub);
            lobbyVisibility.tooltip = pub ? "Listed in Browse public lobbies (and for Steam players of this version). Click: private" : "Only players with the code, friends and invited players can join. Click: list it publicly";
            var sl = social?.Lobby;
            lobbySocial.text = !steam ? (pub ? "Listed in Browse public lobbies; friends can also join with the code" : "Share the match code; friends join with Multiplayer › Join by code")
                : sl != null && sl.MatchCode == code ? $"Steam lobby open · {sl.Members.Count} member{(sl.Members.Count == 1 ? "" : "s")} · v{(string.IsNullOrEmpty(sl.Version) ? Application.version : sl.Version)} · {WithoutLobbyLead(social.Status)}"
                : social.Status;
            lobbySocial.tooltip = lobbySocial.text;

            lobbyStart.style.display = isHost ? DisplayStyle.Flex : DisplayStyle.None;
            lobbyWaiting.style.display = isHost ? DisplayStyle.None : DisplayStyle.Flex;
            lobbyWaiting.text = spectator ? "Watching · waiting for the host" : "Waiting for the host";
            bool canStart = isHost && r.CanStart;
            lobbyStart.SetEnabled(canStart);
            lobbyStart.tooltip = !canStart ? "Waiting for the lobby" : r.Open > 0 ? $"Start now; {r.Open} open seat{(r.Open == 1 ? " is" : "s are")} filled by AI" : "Start now";
            lobbyReady.style.display = spectator ? DisplayStyle.None : DisplayStyle.Flex;
            lobbyReady.SetEnabled(r != null && r.You >= 0);
            lobbyReady.EnableInClassList("selected", lobbyReadyOn);
            lobbyReady.tooltip = lobbyReadyOn ? "You are ready (click to undo)" : humans >= 2 && r != null && r.Open == 0 ? "The match starts when everyone is ready" : "Tell the others you are ready";
        }

        static bool HasFreeSeat(MatchRoom r, int team)
        {
            foreach (var s in r.Seats) if (s.Team == team && !s.Closed && (!s.Human || !s.Taken)) return true;
            return false;
        }

        void SeatRow(MatchRoom r, int i, VisualElement parent, bool random)
        {
            var s = r.Seats[i];
            var row = Box("se-lobby-seat", parent);
            bool you = i == r.You, host = r.IsHost;
            int seat = i;
            var dot = Box("se-lobby-dot", row);
            if (s.Closed)
            {
                row.AddToClassList("se-lobby-seat--closed");
                dot.AddToClassList("se-lobby-dot--open");
                Line("Empty · left out of the match", "se-lobby-seat-name se-lobby-seat-name--open", row);
                if (host) SmallButton("Open", () => game.SendLobby(LobbyMessages.CloseSeat(seat, false)), row, "Open this seat again for a player or an AI");
                return;
            }
            dot.EnableInClassList("se-lobby-dot--you", you);
            dot.EnableInClassList("se-lobby-dot--taken", s.Taken || !s.Human);
            dot.EnableInClassList("se-lobby-dot--open", s.Human && !s.Taken);
            string text = !s.Human ? "AI" : !s.Taken ? "Open seat" : s.Name;
            var name = Line(text, "se-lobby-seat-name", row);
            name.EnableInClassList("se-lobby-seat-name--open", s.Human && !s.Taken);
            string tags = (s.IsHost && s.Human ? "host" : "") + (you ? (s.IsHost ? " · you" : "you") : "");
            if (s.Human && s.Taken && !s.Connected) tags += (tags.Length > 0 ? " · " : "") + "offline";
            if (tags.Length > 0) Line(tags, "se-lobby-seat-tags", row);
            if (!s.Human)
            {
                if (host)
                {
                    Cycle(DifficultyIds, DifficultyNames, s.Difficulty, v => game.SendLobby(LobbyMessages.AiSettings(seat, v)), row, "AI difficulty");
                    Cycle(PersonalityIds, PersonalityNames, string.IsNullOrEmpty(s.Personality) ? "random" : s.Personality,
                        v => game.SendLobby(LobbyMessages.AiSettings(seat, null, v == "random" ? RandomPersonality() : v)), row, "AI personality");
                    UiKit.IconButton("close", () => game.SendLobby(LobbyMessages.RemoveAi(seat)), "Remove this AI (the seat opens for a player)", row, 26)
                        .AddToClassList("se-lobby-icon");
                }
                else Line(NameOf(DifficultyIds, DifficultyNames, s.Difficulty) + (string.IsNullOrEmpty(s.Personality) ? "" : " · " + NameOf(PersonalityIds, PersonalityNames, s.Personality)),
                    "se-lobby-chip", row);
                if (!you && r.You >= 0)
                    SmallButton("Sit", () => game.SendLobby(LobbyMessages.Seat(seat)), row, "Take this seat (the AI moves to yours)");
            }
            else if (!s.Taken)
            {
                if (host)
                {
                    SmallButton("+ AI", () => game.SendLobby(LobbyMessages.AddAi(seat, "normal")), row, "Fill this seat with an AI");
                    SmallButton("Close", () => game.SendLobby(LobbyMessages.CloseSeat(seat, true)), row,
                        "Leave this seat out of the match (uneven sides: 2 v 1, 3 v 2 …)");
                }
                if (r.You >= 0) SmallButton("Sit", () => game.SendLobby(LobbyMessages.Seat(seat)), row, "Move to this seat");
                else if (r.Spectator) SmallButton("Sit", () => game.SendLobby(LobbyMessages.Sit(seat)), row, "Leave the spectator seats and play here");
            }
            else
            {
                // the host may move another player to the next team
                if (host && !you && r.Teams > 1)
                {
                    int next = (s.Team + 1) % r.Teams;
                    SmallButton("Team ›", () => game.SendLobby(LobbyMessages.Team(next, seat)), row, $"Move {s.Name} to team {next + 1} (swaps with a free seat there)");
                }
                var ready = new IconElement(s.Ready ? "check" : "queued");
                ready.AddToClassList("se-lobby-ready");
                ready.EnableInClassList("se-lobby-ready--on", s.Ready);
                ready.tooltip = s.Ready ? "Ready" : "Not ready yet";
                ready.pickingMode = PickingMode.Position;
                row.Add(ready);
            }
        }

        static string RandomPersonality() => PersonalityIds[UnityEngine.Random.Range(1, PersonalityIds.Length)];

        static Button SmallButton(string text, Action click, VisualElement parent, string tip)
        {
            var b = new Button(click) { text = text };
            b.AddToClassList("se-lobby-small");
            b.tooltip = tip;
            parent.Add(b);
            return b;
        }

        // ------------------------------------------------------------------ training & extras
        VisualElement BuildTraining()
        {
            var p = SubPage("Training & Extras");
            Item("training", "Tutorial", () =>
            {
                PlayerPrefs.SetInt("se.tutorial.done", 0);
                game.StartCampaign(new CampaignOptions { MapSize = "small", Rivals = 1, Difficulty = "easy", Tutorial = true });
            }, p.Content).tooltip = "A small guided match against one forgiving rival";
            Item("skirmish", "Combat Sandbox", () => game.StartMatch("sandbox", ""), p.Content).tooltip = "Stage a battle at once and try tactics";
            Item("observer", "Watch AI Match", () => Go("watch"), p.Content).tooltip = "Set up a match between AI nations (map, teams, each AI, rules, speed) and watch it";
            Item("guide", "Field Guide", () => Go("guide"), p.Content);
            if (Application.isEditor || Debug.isDebugBuild) Item("overview", "Performance stress scene", () => game.StartStress(), p.Content);
            return p.Root;
        }

        // ------------------------------------------------------------------ settings and the field guide
        VisualElement BuildSettings()
        {
            // SettingsView has its own title row; no page header here (one title)
            var p = SubPage("Settings", false, false);
            VisualElement view = null;
            try { view = settingsFactory?.Invoke(); }
            catch (Exception e) { Debug.LogException(e); }
            if (view != null)
            {
                view.style.flexGrow = 1;
                p.Content.Add(view);
            }
            else Line("Settings are unavailable.", "se-menu-note", p.Content);
            return p.Root;
        }

        VisualElement BuildGuide()
        {
            var p = SubPage("Field Guide", false);
            p.Content.Add(FieldGuide.Build(true));
            return p.Root;
        }

        // ------------------------------------------------------------------ platform events
        void OnSocialChanged()
        {
            UpdateMultiplayer();
            if (pages.Top == "lobby") { UpdateLobby(); FillLobbyFriends(); }
            if (pages.Top == "friends") FillFriends();
        }

        // ------------------------------------------------------------------ lobby: invite Steam friends directly
        VisualElement lobbyFriendsBox, lobbyFriendRows;
        Label lobbyFriendsHint;

        void FillLobbyFriends()
        {
            if (lobbyFriendRows == null) return;
            lobbyFriendRows.Clear();
            var social = game.Social;
            string code = lobby?.Code ?? lobbyCode;
            if (!(social is IFriendInvites invites) || !social.Available)
            {
                lobbyFriendsHint.text = (social?.Status ?? "Steam is not available") + ". Friends join with Multiplayer › Join by code " + code;
                return;
            }
            bool hasLobby = social.Lobby != null && social.Lobby.MatchCode == code;
            lobbyFriendsHint.text = (hasLobby ? "Invite sends a Steam chat invite; your friend starts Shattered Empires first, then accepts it."
                    : social.Busy ? "Opening the Steam lobby…" : "The Steam lobby opens with the match lobby…") +
                " Or they use Multiplayer › Join by code " + code + "." + (invites.OverlayReady ? "" : " (Steam overlay unavailable in this game.)");
            var friends = invites.OnlineFriends();
            if (friends.Count == 0) { Line("No Steam friends online", "se-menu-empty", lobbyFriendRows); return; }
            int shown = 0;
            foreach (var fr in friends)
            {
                if (shown++ >= 12) break;
                ulong id = fr.Id;
                var row = Box("se-menu-friend", lobbyFriendRows);
                var avatar = Box("se-menu-avatar", row);
                avatar.Add(new IconElement("friends"));
                var names = Box("se-menu-friend-names", row);
                Line(fr.Name, "se-menu-friend-name", names);
                Line(fr.InLobby ? "In this lobby" : fr.InGame ? "Playing Shattered Empires (Spacewar)" : "Online", "se-menu-friend-lobby", names);
                if (fr.InLobby) continue;
                var invite = Btn(fr.Invited ? "Invite again" : "Invite", () =>
                {
                    if (invites.InviteFriend(id)) SetStatus("Invite sent to " + fr.Name + "; or tell them the code " + code);
                    else SetStatus(social.Status);
                    FillLobbyFriends();
                }, row, "invite", !fr.Invited);
                invite.AddToClassList("se-menu-friend-join");
                invite.AddToClassList("se-menu-friend-invite");
                invite.SetEnabled(hasLobby);
            }
        }

        // the lobby note already opens with "Steam lobby open · ...": drop the platform status's own lead-in
        static string WithoutLobbyLead(string status)
        {
            const string lead = "Steam lobby open: ";
            if (string.IsNullOrEmpty(status) || !status.StartsWith(lead, StringComparison.Ordinal)) return status ?? "";
            string rest = status.Substring(lead.Length);
            return rest.Length > 0 ? char.ToUpperInvariant(rest[0]) + rest.Substring(1) : rest;
        }

        void OnInviteAccepted(string friend) =>
            SetStatus(string.IsNullOrEmpty(friend) ? "Joining the lobby…" : "Joining " + friend + "'s lobby…");
    }
}
