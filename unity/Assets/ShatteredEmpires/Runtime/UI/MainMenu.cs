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
    public sealed class MainMenuView : VisualElement
    {
        readonly IGameActions game;
        readonly Func<VisualElement> settingsFactory;
        readonly VisualElement frame, pageHost;
        readonly Label statusLabel;
        readonly UiKit.PageStack pages;
        readonly CampaignOptions skirmish = new CampaignOptions();

        static readonly HashSet<string> WidePages = new HashSet<string> { "skirmish", "lobby", "settings", "guide" };

        int hostTeamSize = 1;
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
            Line($"v{Application.version} · Windows preview", "se-menu-version", foot);

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
            skirmish.Wrap = false;
        }

        // ------------------------------------------------------------------ contract (Hud)
        public bool Visible => style.display != DisplayStyle.None;

        /// <summary>Show or hide the menu; <paramref name="status"/> null keeps the current status line.</summary>
        public void Show(bool on, string status)
        {
            style.display = on ? DisplayStyle.Flex : DisplayStyle.None;
            if (status != null) SetStatus(status);
            // the root page reflects whether there is a match to continue
            if (on && pages.Top == "root") { pages.Reset("root", BuildRoot); SyncWide(); }
            if (on) OnSocialChanged();
        }

        /// <summary>Pop one page. Leaving the lobby page leaves the lobby. False at the root (nothing to do).</summary>
        public bool HandleEscape()
        {
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

        /// <summary>Review captures: "root", "skirmish", "multiplayer", "lobby", "training", "settings", "guide", "friends", "code".</summary>
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
                        ["mode"] = "pvp", ["mapSize"] = 96, ["teamSize"] = 1, ["host"] = "Commander", ["you"] = 0, ["isHost"] = true,
                        ["canStart"] = true, ["open"] = 1,
                        ["slots"] = new JArray(
                            new JObject { ["name"] = "Commander", ["human"] = true, ["taken"] = true, ["connected"] = true, ["ready"] = true },
                            new JObject { ["name"] = "Open seat", ["human"] = true, ["taken"] = false, ["connected"] = false, ["ready"] = false }),
                    });
                    break;
                case "friends": case "code": Go("multiplayer"); Go(id); break;
                case "guide": Go("training"); Go("guide"); break;
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
                case "multiplayer": return BuildMultiplayer;
                case "friends": return BuildFriends;
                case "code": return BuildCode;
                case "lobby": return BuildLobby;
                case "training": return BuildTraining;
                case "settings": return BuildSettings;
                case "guide": return BuildGuide;
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
            Btn("Back", Back, parts.Footer, "back");
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

        VisualElement BuildSkirmish()
        {
            var p = SubPage("New Skirmish");
            var columns = Box("se-menu-columns", p.Content);
            var left = Box("se-menu-column", columns);
            var right = Box("se-menu-column", columns);

            Line("World", "se-menu-label", left);
            var worldSeg = UiKit.Segmented(Options(("continents", "Continents"), ("pangaea", "Pangaea"), ("archipelago", "Archipelago"), ("inlandSea", "Inland Sea")),
                skirmish.Style, v => skirmish.Style = v, left, 99);
            Line("Map size", "se-menu-label", left);
            var sizeSeg = UiKit.Segmented(Options(("small", "Skirmish"), ("medium", "Standard"), ("large", "Epic"), ("huge", "Total War")),
                skirmish.MapSize, v => skirmish.MapSize = v, left, 99);
            Line("Rivals", "se-menu-label", left);
            var rivalsSeg = UiKit.Segmented(Options(("1", "1"), ("2", "2"), ("3", "3"), ("4", "4"), ("5", "5")),
                skirmish.Rivals.ToString(), v => { if (int.TryParse(v, out int n)) skirmish.Rivals = Mathf.Clamp(n, 1, 5); }, left, 79);
            Line("Difficulty", "se-menu-label", left);
            Label difficultyHelp = null;
            UiKit.Segmented(Options(("easy", "Relaxed"), ("normal", "Standard"), ("hard", "Hard"), ("expert", "Expert"), ("brutal", "Brutal")),
                skirmish.Difficulty, v => { skirmish.Difficulty = v; if (difficultyHelp != null) difficultyHelp.text = HelpFor(DifficultyHelp, v); }, left, 79);
            difficultyHelp = Line(HelpFor(DifficultyHelp, skirmish.Difficulty), "se-menu-help-line", left);

            Line("Victory", "se-menu-label", right);
            Label victoryHelp = null;
            UiKit.Segmented(Options(("domination", "Domination"), ("control", "Territory"), ("operation", "Operation")),
                skirmish.Objective, v => { skirmish.Objective = v; if (victoryHelp != null) victoryHelp.text = HelpFor(VictoryHelp, v); }, right, 132);
            victoryHelp = Line(HelpFor(VictoryHelp, skirmish.Objective), "se-menu-help-line", right);

            // Map: a new procedural world, or one of the server's hand-authored maps (which fix the
            // teams: the rival count, world style and size then come from the map)
            Line("Map", "se-menu-label", right);
            skirmishMapList = Box("se-map-list", right);
            skirmishMapHelp = Line("", "se-map-help", right);
            skirmishLocked = new VisualElement[] { worldSeg, sizeSeg, rivalsSeg };
            FillMapChoices(skirmishMapList, 0, skirmish.Map, id => { skirmish.Map = id; SyncSkirmishMap(); });
            SyncSkirmishMap();
            RequestMaps();
            Line("Commander name", "se-menu-label", right);
            var nameField = Field(game.PlayerName, right);
            nameField.maxLength = 24;
            nameField.RegisterValueChangedCallback(e => game.PlayerName = e.newValue);
            Line("Seed (blank for a new world each time)", "se-menu-label", right);
            var seedRow = Box("se-menu-row", right);
            var seedField = Field(skirmish.Seed, seedRow, "se-menu-grow");
            seedField.maxLength = 9;
            seedField.RegisterValueChangedCallback(e => skirmish.Seed = (e.newValue ?? "").Trim());
            Btn("New seed", () => seedField.value = UnityEngine.Random.Range(1, 999999).ToString(), seedRow);

            Btn("Start", () => { skirmish.Wrap = false; game.StartCampaign(skirmish); }, p.Footer, "play", true);
            return p.Root;
        }

        // ------------------------------------------------------------------ multiplayer
        Label mpSocial;
        Button mpFriends;

        VisualElement BuildMultiplayer()
        {
            var p = SubPage("Multiplayer");

            var hostRow = Box("se-menu-host-row", p.Content);
            var host = Item("invite", "Host lobby", () => game.HostMultiplayer(hostTeamSize, hostMap), hostRow);
            host.AddToClassList("se-menu-grow");
            host.AddToClassList("se-menu-item--primary");
            host.tooltip = "Open a match lobby; share its code or invite Steam friends";
            UiKit.Segmented(Options(("1", "1v1"), ("2", "2v2"), ("3", "3v3"), ("4", "4v4")), hostTeamSize.ToString(),
                v => { if (int.TryParse(v, out int n)) hostTeamSize = Mathf.Clamp(n, 1, 4); FillHostMaps(); }, hostRow, 44).AddToClassList("se-menu-team-size");
            // the lobby's map: maps drawn for the chosen team size, or a new procedural world
            hostMapList = Box("se-map-list se-map-list--host", p.Content);
            FillHostMaps();
            RequestMaps();

            mpFriends = Item("friends", "Join a friend", () => Go("friends"), p.Content);
            Item("code", "Join by code", () => { codeMode = "join"; Go("code"); }, p.Content);
            Item("observer", "Spectate by code", () => { codeMode = "spectate"; Go("code"); }, p.Content);
            mpSocial = Line("", "se-menu-note", p.Content);
            UpdateMultiplayer();

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

        void UpdateMultiplayer()
        {
            var social = game?.Social;
            if (mpFriends != null)
            {
                bool steam = social != null && social.Available;
                mpFriends.SetEnabled(steam);
                mpFriends.tooltip = steam ? "Friends hosting a Shattered Empires lobby" : social?.Status;
            }
            if (mpSocial != null)
            {
                mpSocial.text = social?.Status ?? "";
                mpSocial.tooltip = mpSocial.text;
            }
        }

        // ------------------------------------------------------------------ maps
        /// <summary>A hand-authored map from the server's catalog (server/sim/mapCatalog.js: GET /api/maps,
        /// the 'hello' reply's maps, or a 'maps' request). Team size fixes the players: 2 × TeamSize.</summary>
        sealed class MapInfo
        {
            public string Id, Name, Description;
            public int TeamSize, Size;
        }

        // shown until the server's catalog arrives (it replaces this list; ids must match the server)
        static readonly MapInfo[] BuiltInMaps =
        {
            new MapInfo { Id = "twin_rivers", Name = "Twin Rivers", TeamSize = 1, Size = 76,
                Description = "Two rivers frame a central ridge. Coastal roads bridge both rivers; the direct route wades the fords to the Ridgeway saddle." },
            new MapInfo { Id = "saltmarsh_estuary", Name = "Saltmarsh Estuary", TeamSize = 2, Size = 108,
                Description = "A tidal sound splits the coast. Land bridges cross it north and south; causeways reach Tidewater Isle in the middle." },
            new MapInfo { Id = "continental_divide", Name = "Continental Divide", TeamSize = 3, Size = 140,
                Description = "A mountain divide runs around Lake Meridian. Two high passes and the lakeshore gates are the only ways across." },
        };
        const string RandomMapHelp = "A new procedurally generated world each time.";

        readonly List<MapInfo> maps = new List<MapInfo>(BuiltInMaps);
        bool mapsRequested;
        string hostMap = "random";
        VisualElement skirmishMapList, hostMapList;
        Label skirmishMapHelp;
        VisualElement[] skirmishLocked;

        MapInfo FindMap(string id)
        {
            foreach (var m in maps) if (m.Id == id) return m;
            return null;
        }

        /// <summary>The server's map catalog (a JSON array of { id, name, teamSize, size, description }).</summary>
        public void SetMaps(JArray list)
        {
            if (list == null) return;
            var next = new List<MapInfo>();
            foreach (var t in list)
            {
                if (!(t is JObject o)) continue;
                string id = (string)o["id"];
                int team = o["teamSize"] != null ? (int)o["teamSize"] : 0;
                if (string.IsNullOrEmpty(id) || id == "random" || team < 1) continue;
                next.Add(new MapInfo { Id = id, Name = (string)o["name"] ?? id, Description = (string)o["description"] ?? "", TeamSize = team,
                    Size = o["size"] != null ? (int)o["size"] : 0 });
            }
            if (next.Count == 0) return;
            maps.Clear();
            maps.AddRange(next);
            if (FindMap(skirmish.Map) == null) skirmish.Map = "random";
            if (skirmishMapList != null && skirmishMapList.panel != null)
            {
                FillMapChoices(skirmishMapList, 0, skirmish.Map, id => { skirmish.Map = id; SyncSkirmishMap(); });
                SyncSkirmishMap();
            }
            if (hostMapList != null && hostMapList.panel != null) FillHostMaps();
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

        /// <summary>One row per choice: Random, then the maps for <paramref name="teamSize"/> (0: every map).</summary>
        void FillMapChoices(VisualElement list, int teamSize, string selected, Action<string> pick)
        {
            list.Clear();
            var rows = new List<(string id, Button row)>();
            void Add(string id, string name, string mode, string tip)
            {
                var row = new Button { text = "" };
                row.AddToClassList("se-map-option");
                row.tooltip = tip;
                Line(name, "se-map-name", row);
                Line(mode, "se-map-mode", row);
                row.clicked += () =>
                {
                    foreach (var (rid, r) in rows) r.EnableInClassList("selected", rid == id);
                    pick(id);
                };
                row.EnableInClassList("selected", id == selected);
                rows.Add((id, row));
                list.Add(row);
            }
            Add("random", "Random", "Any", RandomMapHelp);
            foreach (var m in maps)
                if (teamSize == 0 || m.TeamSize == teamSize)
                    Add(m.Id, m.Name, $"{m.TeamSize}v{m.TeamSize}", m.Description);
        }

        void SyncSkirmishMap()
        {
            var m = FindMap(skirmish.Map);
            if (skirmishLocked != null)
                foreach (var e in skirmishLocked)
                {
                    if (e == null) continue;
                    e.SetEnabled(m == null);
                    e.tooltip = m == null ? null : $"Set by the map: {m.Name} is a {m.TeamSize}v{m.TeamSize} map";
                }
            if (skirmishMapHelp == null) return;
            skirmishMapHelp.text = m == null ? RandomMapHelp
                : $"{m.TeamSize}v{m.TeamSize}: you{(m.TeamSize > 1 ? $" and {Plural(m.TeamSize - 1, "AI ally", "AI allies")}" : "")} against {Plural(m.TeamSize, "AI rival", "AI rivals")}. {m.Description}";
            skirmishMapHelp.tooltip = skirmishMapHelp.text;
        }

        static string Plural(int n, string one, string many) => n == 1 ? $"1 {one}" : $"{n} {many}";

        void FillHostMaps()
        {
            if (hostMapList == null) return;
            var m = FindMap(hostMap);
            if (m != null && m.TeamSize != hostTeamSize) hostMap = "random";
            FillMapChoices(hostMapList, hostTeamSize, hostMap, id => hostMap = id);
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
            friendRows.Clear();
            var social = game.Social;
            IReadOnlyList<FriendLobby> sessions = (social as IFriendLobbyList)?.FriendSessions();
            if (sessions == null || sessions.Count == 0)
            {
                Line(social is IFriendLobbyList ? "No friends are hosting right now" : "Friends who host appear in your Steam friends list",
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
                Line(s.LobbyName, "se-menu-friend-lobby", names);
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
        Label lobbyTitle, lobbyCodeLabel, lobbyMap, lobbySocial, lobbyWaiting;
        VisualElement lobbySeats;
        Button lobbyStart, lobbyReady, lobbyInvite;
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
            lobbyInvite = Btn("Invite Steam friends", InviteFromLobby, codeRow, "invite");
            lobbySeats = Box("se-lobby-teams", p.Content);
            lobbyMap = Line("", "se-lobby-map", p.Content);
            lobbySocial = Line("", "se-menu-note", p.Content);

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

        void UpdateLobby()
        {
            if (lobbySeats == null || lobbySeats.panel == null && pages.Top != "lobby") return;
            var r = lobby;
            string code = r?.Code ?? lobbyCode;
            if (lobbyTitle != null) lobbyTitle.text = r != null && !string.IsNullOrEmpty(r.Name) ? "Lobby · " + r.Name : "Lobby";
            lobbyCodeLabel.text = string.IsNullOrEmpty(code) ? "······" : code;

            // seats grouped by team (server: team = seat index / team size)
            lobbySeats.Clear();
            int humans = 0;
            if (r == null || r.Seats.Count == 0)
                Line("Joining the lobby…", "se-menu-note", lobbySeats);
            else
            {
                int teamSize = Mathf.Max(1, r.TeamSize);
                int teams = (r.Seats.Count + teamSize - 1) / teamSize;
                for (int t = 0; t < teams; t++)
                {
                    var team = Box("se-lobby-team", lobbySeats);
                    Line("Team " + (t + 1), "se-lobby-team-title", team);
                    for (int i = t * teamSize; i < Mathf.Min(r.Seats.Count, (t + 1) * teamSize); i++)
                        SeatRow(r, i, team);
                }
                foreach (var s in r.Seats) if (s.Human && s.Taken) humans++;
            }

            lobbyMap.text = r == null ? "" : (!string.IsNullOrEmpty(lobbyMapName) ? lobbyMapName + " · " : "") + (r.MapSize > 0 ? $"Map {r.MapSize}×{r.MapSize} · " : "") + $"{r.TeamSize}v{r.TeamSize}" +
                (r.Open > 0 ? $" · {r.Open} open seat{(r.Open == 1 ? "" : "s")}" : "");

            var social = game.Social;
            bool steam = social != null && social.Available;
            lobbyInvite.SetEnabled(steam && !string.IsNullOrEmpty(code));
            lobbyInvite.tooltip = steam ? "Opens the Steam overlay invite dialog" : social?.Status;
            var sl = social?.Lobby;
            lobbySocial.text = !steam ? "Share the match code; friends join with Multiplayer › Join by code"
                : sl != null && sl.MatchCode == code ? $"Steam lobby open · {sl.Members.Count} member{(sl.Members.Count == 1 ? "" : "s")} · {social.Status}"
                : social.Status;
            lobbySocial.tooltip = lobbySocial.text;

            bool isHost = r != null && r.IsHost;
            lobbyStart.style.display = isHost ? DisplayStyle.Flex : DisplayStyle.None;
            lobbyWaiting.style.display = isHost ? DisplayStyle.None : DisplayStyle.Flex;
            bool canStart = isHost && r.CanStart && humans >= 2;
            lobbyStart.SetEnabled(canStart);
            lobbyStart.tooltip = canStart ? "Start now; open seats are filled by AI" : "At least two players must be seated (the match also starts by itself when every seat is taken)";
            lobbyReady.SetEnabled(r != null && r.You >= 0);
            lobbyReady.EnableInClassList("selected", lobbyReadyOn);
            lobbyReady.tooltip = lobbyReadyOn ? "You are ready (click to undo)" : "Tell the others you are ready";
        }

        void SeatRow(MatchRoom r, int i, VisualElement parent)
        {
            var s = r.Seats[i];
            var row = Box("se-lobby-seat", parent);
            bool you = i == r.You;
            var dot = Box("se-lobby-dot", row);
            dot.EnableInClassList("se-lobby-dot--you", you);
            dot.EnableInClassList("se-lobby-dot--taken", s.Taken || !s.Human);
            dot.EnableInClassList("se-lobby-dot--open", s.Human && !s.Taken);
            string text = !s.Human ? (string.IsNullOrEmpty(s.Name) ? "AI" : s.Name)
                : !s.Taken ? "Waiting for player…" : s.Name;
            var name = Line(text, "se-lobby-seat-name", row);
            name.EnableInClassList("se-lobby-seat-name--open", s.Human && !s.Taken);
            string tags = (i == 0 && s.Human ? "host" : "") + (you ? (i == 0 ? " · you" : "you") : "");
            if (s.Human && s.Taken && !s.Connected) tags += (tags.Length > 0 ? " · " : "") + "offline";
            Line(tags, "se-lobby-seat-tags", row);
            if (!s.Human) Line(string.IsNullOrEmpty(s.Difficulty) ? "AI" : "AI · " + s.Difficulty, "se-lobby-chip", row);
            else if (s.Taken)
            {
                var ready = new IconElement(s.Ready ? "check" : "queued");
                ready.AddToClassList("se-lobby-ready");
                ready.EnableInClassList("se-lobby-ready--on", s.Ready);
                ready.tooltip = s.Ready ? "Ready" : "Not ready yet";
                ready.pickingMode = PickingMode.Position;
                row.Add(ready);
            }
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
            Item("observer", "Watch AI Match", () => game.StartMatch("observe", ""), p.Content).tooltip = "Watch AI nations fight; follow any of them";
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
            if (pages.Top == "lobby") UpdateLobby();
            if (pages.Top == "friends") FillFriends();
        }

        void OnInviteAccepted(string friend) =>
            SetStatus(string.IsNullOrEmpty(friend) ? "Joining the lobby…" : "Joining " + friend + "'s lobby…");
    }
}
