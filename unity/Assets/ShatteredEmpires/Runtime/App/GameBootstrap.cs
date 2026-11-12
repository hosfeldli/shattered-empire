using System.Collections.Generic;
using System;
using System.Diagnostics;
using System.Text;
using Newtonsoft.Json.Linq;
using SE.Core.Diagnostics;
using SE.Core.Protocol;
using SE.Core.Stress;
using SE.Net;
using SE.Runtime.Audio;
using SE.Runtime.Battlefields;
using SE.Runtime.CameraControl;
using SE.Runtime.Cities;
using SE.Runtime.Effects;
using SE.Runtime.Input;
using SE.Runtime.Landscape;
using SE.Runtime.Military;
using SE.Runtime.Rendering;
using SE.Runtime.Session;
using SE.Runtime.Social;
using SE.Runtime.UI;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;

namespace SE.Runtime.App
{
    /// <summary>
    /// The client's single entry point and frame loop. Order each frame: network (bounded apply, acks
    /// first) → playback clock → camera and input → effects and sound from combat events → incremental
    /// world rebuilds (jobs) → instance buffers → draw calls → interface. No per-object Update anywhere.
    /// </summary>
    public sealed partial class GameBootstrap : MonoBehaviour, IGameActions
    {
        enum Phase { Menu, Connecting, Playing, Stress, Intro }

        LaunchOptions opts;
        Phase phase = Phase.Menu;
        ClientSession session;
        GameConnection net;
        TerrainRenderer terrain;
        FogField fog;
        GroundField ground;
        CityRenderer city;
        WarzoneRenderer warzone;
        UnitRenderer units;
        EffectsRenderer fx;
        Atmosphere atmosphere;
        AudioDirector audioDirector;
        RtsCamera rts;
        Commander commander;
        Hud hud;
        UIDocument uiDocument;
        IntroDirector intro;
        readonly WrapImages images = new WrapImages();
        readonly PerfRecorder perf = new PerfRecorder();
        readonly FrameStats recent = new FrameStats();
        Light sun;
        readonly Stopwatch clock = Stopwatch.StartNew();
        double Now => clock.Elapsed.TotalSeconds;
        float time;
        string serverUrl = LaunchOptions.PublicServer, playerName = "Commander";
        string pendingMode;
        bool showDiag, hideUi;
        int ruinRev = -1, buildingRev = -1;
        readonly HashSet<int> buildingTiles = new HashSet<int>();

        // benchmarks
        StressScenario stress;
        CameraTour tour;
        float stressSeconds;
        string perfOut;
        string battleKey;
        JArray battleUnits;
        int arena = -1;
        float[] perfZooms;
        float perfSeconds;
        bool perfRunning;
        float probeAt;
        string shotSegment = "";
        float shotAt;
        double stallNet, stallPresent, stallTerrain, stallCity, stallUnits;
        int stallMsgs, gcLast, gc1Last;
        static double Ms(long since) => (Stopwatch.GetTimestamp() - since) * 1000.0 / Stopwatch.Frequency;

        // ------------------------------------------------------------------ IGameActions
        public string Server { get => serverUrl; set => serverUrl = value; }
        public string PlayerName { get => playerName; set => playerName = value; }
        public AudioDirector Audio => audioDirector;
        public bool CanInvite => phase == Phase.Playing && net?.SessionMatch != null && SocialPlatform.Current.Available;
        public void InviteFriends() => SocialPlatform.Current.InviteFriends(net?.SessionMatch, "");
        public void Quit() => Application.Quit();
        public void FocusTile(int tile, float distance) => rts.FocusTile(tile, distance);

        // ------------------------------------------------------------------ start-up
        void Awake()
        {
            opts = LaunchOptions.FromCommandLine();
            Application.runInBackground = true;
            bool bench = opts.Has("perf") || opts.Get("mode") == "stress";
            QualitySettings.vSyncCount = opts.Int("vsync", bench ? 0 : 1);
            Application.targetFrameRate = QualitySettings.vSyncCount == 0 ? 1000 : -1;
            var cam = Camera.main;
            if (cam == null) cam = new GameObject("Main Camera") { tag = "MainCamera" }.AddComponent<Camera>();
            if (cam.GetComponent<UniversalAdditionalCameraData>() == null) cam.gameObject.AddComponent<UniversalAdditionalCameraData>();
            cam.fieldOfView = 40f;
            sun = FindFirstObjectByType<Light>();
            if (sun == null) sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.transform.rotation = Quaternion.Euler(47f, -32f, 0f);
            sun.shadows = LightShadows.Soft;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            GraphicsSettings.lightsUseLinearIntensity = true;
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;

            RenderResources.Load();
            session = new ClientSession();
            terrain = new TerrainRenderer(session.World);
            fog = new FogField();
            ground = new GroundField();
            city = new CityRenderer(session.World, session.Structures) { CivColor = id => session.CivColor(id) };
            warzone = new WarzoneRenderer(session.World)
            {
                DefenceAt = t => buildingByTile.TryGetValue(t, out var b) && IsDefence(b.type) ? b.type : null,
                BuildingOwnerAt = t => buildingByTile.TryGetValue(t, out var b) ? b.owner : -1,
            };
            units = new UnitRenderer();
            units.InTrench = t => warzone.HasTrench(t);
            fx = new EffectsRenderer();
            atmosphere = new Atmosphere(cam, sun);
            rts = new RtsCamera(cam);
            rts.Bind(session.World);
            commander = new Commander(session, rts, units);
            session.BeforeGeometryChange = terrain.CompleteAll;
            session.Welcomed += OnWelcomed;
            session.Other += OnOther;
            if (!bench) audioDirector = new AudioDirector(cam);
            if (audioDirector != null) atmosphere.Thunder += delay => audioDirector.Play("thunder", new float3(rts.Focus.x, 4, rts.Focus.z), 0.8f, 30f, 3, rts.Distance);
            if (!opts.Has("no-ui")) BuildInterface();
            ApplyQuality(opts.Get("quality", PlayerPrefs.GetString("se.quality", "high")));
            serverUrl = opts.Has("server") ? opts.Get("server") : PlayerPrefs.GetString("se.server", LaunchOptions.PublicServer);
            playerName = opts.Get("name", PlayerPrefs.GetString("se.name", "Commander"));
        }

        void BuildInterface()
        {
            var go = new GameObject("SE Interface");
            uiDocument = go.AddComponent<UIDocument>();
            var ps = ScriptableObject.CreateInstance<PanelSettings>();
            ps.themeStyleSheet = Resources.Load<ThemeStyleSheet>("UI/SETheme");
            ps.scaleMode = PanelScaleMode.ScaleWithScreenSize;
            ps.referenceResolution = new Vector2Int(1920, 1080);
            ps.screenMatchMode = PanelScreenMatchMode.MatchWidthOrHeight;
            ps.match = 0.5f;
            ps.scale = GameSettings.UiScale;
            uiDocument.panelSettings = ps;
            hud = new Hud(uiDocument.rootVisualElement, session, commander, units, this);
            hud.TileScreen = tile =>
            {
                var g = session.World.Grid;
                float x = g.NearX(g.CenterX(tile), rts.Focus.x), z = g.CenterZ(tile);
                return rts.ToScreen(new Vector3(x, session.World.GroundHeight(x, z), z));
            };
            hud.CameraFocus = () => rts.Focus;
            hud.Map.FocusMap = (x, z) => { int t = session.World.Grid.TileAt(x, z); if (t >= 0) rts.FocusTile(t, rts.Distance); };
            var corners = new Vector2[4];
            hud.Map.ViewCorners = () =>
            {
                // where the screen's corners meet the ground (a little inside the top edge, which may see sky)
                Vector2[] screen = { new Vector2(0, 0), new Vector2(Screen.width, 0), new Vector2(Screen.width, Screen.height * 0.92f), new Vector2(0, Screen.height * 0.92f) };
                for (int k = 0; k < 4; k++)
                {
                    if (!rts.TryGround(screen[k], out var gp)) return null;
                    corners[k] = new Vector2(gp.x, gp.z);
                }
                return corners;
            };
        }

        void Start()
        {
            var mode = opts.Get("mode");
            if (mode == "stress") StartStress();
            else if (mode != "") StartMatch(mode, opts.Get("match"));
            else if ((opts.Has("review-intro") || PlayerPrefs.GetInt("se.intro.seen", 0) == 0) && hud != null) PlayIntro();
            else ShowMenu("");
            SocialPlatform.Current.JoinRequested += code => StartMatch("join", code);
        }

        public void ApplyUiScale(float scale)
        {
            if (uiDocument != null && uiDocument.panelSettings != null) uiDocument.panelSettings.scale = Mathf.Clamp(scale, 0.75f, 1.6f);
        }

        public void ApplyQuality(string preset)
        {
            var urp = GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;
            switch (preset)
            {
                case "low":
                    if (urp) { urp.shadowDistance = 45; urp.msaaSampleCount = 1; urp.renderScale = 0.85f; }
                    terrain.TreeDensity = 0.5f; terrain.TreeDistance = 60; terrain.LodDistance = 45; fx.Intensity = 0.5f;
                    units.OperationalDistance = 12f;
                    break;
                case "medium":
                    if (urp) { urp.shadowDistance = 80; urp.msaaSampleCount = 2; urp.renderScale = 1f; }
                    terrain.TreeDensity = 0.75f; terrain.TreeDistance = 85; terrain.LodDistance = 60; fx.Intensity = 0.75f;
                    units.OperationalDistance = 18f;
                    break;
                case "ultra":
                    if (urp) { urp.shadowDistance = 200; urp.msaaSampleCount = 4; urp.renderScale = 1f; }
                    terrain.TreeDensity = 1.25f; terrain.TreeDistance = 150; terrain.LodDistance = 100; fx.Intensity = 1.2f;
                    units.OperationalDistance = 31f;
                    break;
                default:
                    if (urp) { urp.shadowDistance = 130; urp.msaaSampleCount = 4; urp.renderScale = 1f; }
                    terrain.TreeDensity = 1f; terrain.TreeDistance = 110; terrain.LodDistance = 70; fx.Intensity = 1f;
                    units.OperationalDistance = 24f;
                    break;
            }
            terrain.MarkAllDirty();
        }

        // ------------------------------------------------------------------ menu with a living world behind it
        void ShowMenu(string status)
        {
            phase = Phase.Menu;
            rts.Cam.orthographic = false;
            net?.Dispose(); net = null;
            stress = null; perfRunning = false;
            var gen = StressWorld.Generate(80, 3);
            session.ApplyWelcome(new WelcomeMessage { W = 80, H = 80, Wrap = false, CivId = 0, Seed = 3, Match = "menu", Civs = new[] { new CivInfo { Id = 0, Name = "Reclamation Command", Color = 0x8a9276 } } });
            session.World.ActionLandscape = true;
            city.ActionRts = false;
            city.SetObjectives(Array.Empty<ObjectiveSite>());
            session.ApplyGeo(gen.Geo);
            for (int i = 0; i < session.World.Visible.Length; i++) session.World.Visible[i] = 0xff;
            session.World.ApplyVisibility(session.World.Visible);
            fog.Enabled = false;
            rts.UserControl = false;
            rts.PitchOverride = 34f;
            StageMenuWorld();
            hud?.ShowMenu(true, status);
        }

        public void PlayIntro()
        {
            if (uiDocument == null) return;
            hud.ShowMenu(false, null);
            hud.ShowGame(false);
            phase = Phase.Intro;
            atmosphere.GameplayMood();
            city.ActionRts = false; city.SetObjectives(Array.Empty<ObjectiveSite>()); city.SetShowcaseRoads(null);
            fog.Enabled = false;
            rts.PitchOverride = -1f;
            intro = new IntroDirector(session, rts, atmosphere, fx, audioDirector, city, uiDocument.rootVisualElement);
            intro.Finished += () => { intro = null; ShowMenu(""); };
            intro.Start();
        }

        // ------------------------------------------------------------------ matches
        public void StartMatch(string mode, string match)
        {
            if (string.IsNullOrEmpty(mode)) { ShowMenu(""); return; }
            if (!opts.Has("review") && !opts.Has("review-intro"))
            { PlayerPrefs.SetString("se.server", serverUrl); PlayerPrefs.SetString("se.name", playerName); PlayerPrefs.Save(); }
            net?.Dispose();
            net = new GameConnection(() => Now);
            session.Attach(net);
            pendingMode = mode;
            phase = Phase.Connecting;
            fog.Enabled = true;
            rts.PitchOverride = -1f;
            hud?.ShowMenu(false, null);
            hud?.ShowLoading(0);
            battleKey = opts.Get("battle", mode == "sandbox" ? "mixed" : "");
            perfZooms = opts.Floats("perf-zooms", 14f, 40f);
            perfSeconds = opts.Float("perf", 0);
            perfOut = opts.Get("perf-out");
            arena = -1;
            if (mode == "rejoin")
            {
                net.SessionMatch = PlayerPrefs.GetString("se.match", "");
                net.SessionToken = PlayerPrefs.GetString("se.token", "");
                if (net.SessionMatch == "") { ShowMenu("No earlier match to return to."); return; }
            }
            else if (mode == "join" || mode == "spectate")
                net.Send(new JObject { ["t"] = mode, ["match"] = match, ["name"] = playerName });
            else
            {
                string ruleset = opts.Get("ruleset", "action-v2");
                var msg = new JObject { ["t"] = "create", ["mode"] = mode, ["name"] = playerName, ["ruleset"] = ruleset, ["ais"] = mode == "observe" ? 4 : mode == "pvp" ? 0 : 1 };
                if (mode == "pvp")
                {
                    msg["teamSize"] = pendingTeamSize;
                    msg["humans"] = pendingTeamSize * 2;
                    pendingTeamSize = 1;
                }
                if (opts.Has("seed")) msg["seed"] = opts.Int("seed", 0);
                if (opts.Has("map")) msg["mapSize"] = opts.Get("map");
                if (opts.Has("objective")) msg["objective"] = opts.Get("objective");
                if (opts.Has("wrap")) msg["wrap"] = true;
                // the New Campaign screen's choices (server options: style, mapSize, ais, difficulty, seed)
                if (pendingCampaign != null && mode == "ai")
                {
                    var c = pendingCampaign;
                    msg["style"] = c.Style; msg["mapSize"] = c.MapSize; msg["ais"] = c.Rivals; msg["difficulty"] = c.Difficulty;
                    msg["objective"] = c.Objective; msg["wrap"] = c.Wrap; msg["tutorial"] = c.Tutorial;
                    if (int.TryParse(c.Seed, out int s)) msg["seed"] = s;
                    msg["title"] = c.Tutorial ? "Tutorial" : $"{playerName} · {c.Style}";
                }
                pendingCampaign = null;
                if (opts.Has("perf") || opts.Has("bench"))
                    msg["rivals"] = new JArray(new JObject { ["personality"] = "warlord" }, new JObject { ["personality"] = "merchant" }, new JObject { ["personality"] = "builder" });
                var connection = net;
                connection.Ready += () =>
                {
                    if (connection != net || connection.SessionMatch != null) return;
                    if (ruleset == "action-v2" && (Array.IndexOf(connection.Capabilities, "action-rts") < 0 || Array.IndexOf(connection.Capabilities, "ring-cities-v1") < 0))
                    {
                        hud?.ShowMenu(true, "This server needs the ring-city RTS update. Restart your local server or select an updated server in Multiplayer.");
                        return;
                    }
                    connection.Send(msg);
                };
            }
            net.Connect(serverUrl);
        }

        void OnWelcomed()
        {
            if (phase == Phase.Connecting) phase = Phase.Playing;
            if (session.Rejoined && phase == Phase.Playing)
            {
                // a reconnect: everything stays on screen, the selection and orders in progress included
                commander.Say("Reconnected", true, time);
                return;
            }
            terrain.SetSeed(session.Welcome.Seed);
            city.Seed = session.Welcome.Seed;
            city.ActionRts = session.ActionRts;
            city.SetShowcaseRoads(null);
            if (phase != Phase.Intro && phase != Phase.Menu) atmosphere.GameplayMood();
            rts.Cam.orthographic = session.ActionRts;
            fx.ClearPersistent();
            units.Selected.Clear();
            commander.Cancel();
            commander.ResetAction();
            if (phase != Phase.Playing) return;
            hud?.ShowMenu(false, null);
            // a new match opens with the descent onto the capital (visual design bible §9); a sandbox,
            // a benchmark or a spectator starts straight away
            bool descend = pendingMode != "rejoin-same" && session.Welcome.Start >= 0 && !session.Welcome.Sandbox && !session.Spectator && !perfRunning && !opts.Has("perf");
            if (descend) BeginDescent();
            else { rts.UserControl = true; hud?.ShowGame(true); hud?.ShowLoading(-1); }
            if (net != null && !opts.Has("review") && !opts.Has("review-intro"))
            {
                PlayerPrefs.SetString("se.match", net.SessionMatch ?? "");
                PlayerPrefs.SetString("se.token", net.SessionToken ?? "");
                PlayerPrefs.Save();
            }
            // a rejoin of the same match keeps the camera where it was; a new match starts at home
            if (session.Welcome.Start >= 0 && pendingMode != "rejoin-same" && !descend) rts.FocusTile(session.Welcome.Start, 30f);
            pendingMode = "rejoin-same";
            if (!string.IsNullOrEmpty(battleKey) && session.Welcome.Sandbox && arena < 0) StageBattle();
        }

        // ------------------------------------------------------------------ campaign start, loading and the descent
        CampaignOptions pendingCampaign;
        int pendingTeamSize = 1;

        public void HostMultiplayer(int teamSize)
        {
            pendingTeamSize = Mathf.Clamp(teamSize, 1, 4);
            StartMatch("pvp", "");
        }

        public void StartCampaign(CampaignOptions options)
        {
            pendingCampaign = new CampaignOptions { Style = options.Style, MapSize = options.MapSize, Difficulty = options.Difficulty,
                Seed = options.Seed, Rivals = options.Rivals, Tutorial = options.Tutorial, Wrap = options.Wrap, Objective = options.Objective };
            StartMatch("ai", "");
        }

        /// <summary>
        /// Loading stages, reported honestly (bible §8): each lights when that work has really happened,
        /// never a fabricated percentage.
        /// </summary>
        int LoadingStage()
        {
            if (net == null || net.State != GameConnection.Status.Ready) return 0;          // connecting
            if (!session.Ready || session.Welcome == null) return 1;                          // the server generates the world
            if (session.GeoMessages == 0 || session.Snapshots < 2) return 2;                  // synchronising terrain and state
            if (terrain.DirtyCount > 0) return 3;                                             // building the landscape
            return 4;                                                                         // entering the match
        }

        float descentT = -1f;
        Vector3 descentTarget;

        void BeginDescent()
        {
            int start = session.Welcome.Start;
            var g = session.World.Grid;
            descentTarget = new Vector3(g.CenterX(start), 0, g.CenterZ(start));
            rts.UserControl = false;
            rts.Focus = descentTarget + new Vector3(0, 0, 6f);
            rts.Distance = rts.TargetDistance = 230f;
            rts.Apply();
            descentT = 0f;
            hud?.ShowGame(false);
            string eraName = ProtocolDecoder.Str((session.Defs?["AGES"] as JArray)?[0]?["name"], "The Reclamation");
            string nation = "";
            foreach (var c in session.Welcome.Civs) if (c.Id == session.CivId) nation = c.Name;
            hud?.ShowTitleCard(session.ActionRts ? "Secure the surrounding ruins" : $"{eraName} · Year One", nation);
        }

        /// <summary>
        /// The opening descent: the continent from high above, a smooth fall toward the capital while the
        /// landscape builds, the camera settling at the gameplay angle, then the interface enters.
        /// It waits (honestly) while the terrain is still being built, and any key or click ends it.
        /// </summary>
        void StepDescent(float dt)
        {
            if (descentT < 0) return;
            bool ready = LoadingStage() >= 4;
            hud?.ShowLoading(ready ? -1 : LoadingStage());
            if (ready) descentT += dt;
            float u = Mathf.Clamp01(descentT / (session.ActionRts ? 4.5f : 6.5f)), e = Mathf.SmoothStep(0, 1, u);
            rts.Focus = Vector3.Lerp(descentTarget + new Vector3(0, 0, 6f), descentTarget, e);
            rts.Distance = rts.TargetDistance = Mathf.Lerp(230f, 30f, e * e * (3f - 2f * e));
            rts.Yaw = Mathf.Lerp(-12f, 0f, e);
            rts.Apply();
            hud?.TitleCardOpacity(Mathf.Clamp01(u * 4f) * Mathf.Clamp01((1f - u) * 3f));
            bool skip = ready && descentT > 0.3f && (InputFacade.LeftDown || InputFacade.Pressed(KeyCode.Escape) || InputFacade.Pressed(KeyCode.Space));
            if (u >= 1f || skip)
            {
                descentT = -1f;
                rts.Focus = descentTarget; rts.Distance = rts.TargetDistance = 30f; rts.Yaw = 0f; rts.Apply();
                rts.UserControl = true;
                hud?.TitleCardOpacity(0f);
                hud?.ShowGame(true);
            }
        }

        void OnOther(ServerMessage m)
        {
            if (m.T == "error" && phase == Phase.Connecting) hud?.ShowMenu(true, m.Error);
            if (m.T == "joined" && ProtocolDecoder.Str(m.Raw["status"]) == "lobby") hud?.ShowMenu(true, "Waiting in the match lobby (code " + ProtocolDecoder.Str(m.Raw["match"], "") + "). Share the code, or invite friends on Steam.");
            if (m.T == "over" && phase == Phase.Playing) hud?.MatchEnded(m.Raw?["winner"] as JObject);
        }

        void StageBattle()
        {
            net.Command(new JObject { ["c"] = "sandbox", ["op"] = "scenario", ["key"] = battleKey }, r =>
            {
                var sc = r.Raw?["scenario"] as JObject;
                if (sc == null) { Debug.LogWarning("battle: " + (r.Error ?? r.Raw?.ToString())); return; }
                battleUnits = sc["A"] as JArray;
                arena = ProtocolDecoder.Int(sc["arena"], -1);
                rts.FocusTile(arena, 24f);
                var all = new List<int>();
                foreach (var t in battleUnits) all.Add((int)t);
                net.Command(new JObject { ["c"] = "fortify", ["units"] = new JArray(all.GetRange(0, all.Count / 3).ToArray()) });
                Invoke(nameof(Advance), 6f);
                if (perfSeconds > 0 && !perfRunning) StartCoroutine(LivePerf());
            });
        }

        void Advance()
        {
            if (battleUnits == null || net == null) return;
            var all = new List<int>();
            foreach (var t in battleUnits) all.Add((int)t);
            int third = all.Count / 3;
            net.Command(new JObject { ["c"] = "move", ["units"] = new JArray(all.GetRange(third, all.Count - third).ToArray()), ["tile"] = arena, ["attackMove"] = true });
        }

        System.Collections.IEnumerator LivePerf()
        {
            perfRunning = true;
            while (session.Snapshots < 8) yield return null;
            yield return new WaitForSecondsRealtime(10f);
            foreach (var zoom in perfZooms)
            {
                rts.FocusTile(arena, zoom);
                yield return new WaitForSecondsRealtime(1f);
                perf.Begin("zoom_" + (int)zoom);
                yield return new WaitForSecondsRealtime(perfSeconds);
                perf.Pause();
            }
            PerfRecorder.Save(perfOut, perf.Report(j =>
            {
                j.Str("scenario", "live-sandbox-" + battleKey).Num("units_visible", session.Units.Count).Str("server", serverUrl)
                 .Dist("command_ack_ms", net.Commands.AckMs).Num("command_timeouts", net.Commands.Timeouts).Num("rtt_ms", net.RttMs);
            }));
            Application.Quit();
        }

        // ------------------------------------------------------------------ offline stress scene (M2)
        public void StartStress()
        {
            hud?.ShowMenu(false, null);
            hud?.ShowGame(false);
            phase = Phase.Stress;
            rts.PitchOverride = -1f;
            int seed = opts.Int("seed", 7);
            int size = opts.Int("stress-size", 256);
            stressSeconds = opts.Float("stress-seconds", 60);
            perfOut = opts.Get("perf-out");
            var gen = StressWorld.Generate(size, seed);
            session.ApplyWelcome(new WelcomeMessage
            {
                W = size, H = size, Wrap = true, CivId = 0, Seed = seed, Match = "stress", Ruleset = "native-v4",
                Civs = new[] { new CivInfo { Id = 0, Name = "Meridian Reclamation", Color = 0x3f7fbf, Human = true }, new CivInfo { Id = 1, Name = "Ashfall Directorate", Color = 0xbf4a3a } },
            });
            session.ApplyGeo(gen.Geo);
            stress = new StressScenario(seed);
            stress.Setup(session.World, opts.Int("stress-units", 1000), opts.Int("stress-buildings", 450));
            session.World.MarkRoadsChanged();
            session.Age = opts.Int("stress-age", 3);
            fog.Enabled = false;
            rts.UserControl = false;
            int city0 = stress.CityTile, front = stress.ArenaTile;
            tour = new CameraTour(session.World.Grid)
                .Add("city_strategic", city0, city0, 150, 120, 0, 6)
                .Add("city_tactical", city0, city0, 14, 12, 18, 8, () => stress.BurstBuild(10))
                .Add("fast_pan", city0, front, 35, 35, 0, 4)
                .Add("battle_tactical", front, front, 12, 12, 22, 10)
                .Add("battle_operational", front, front, 40, 40, 6, 6)
                .Add("strategic_sweep", front, -1, 240, 240, 0, 8)
                .Add("zoom_dive", front, front, 240, 10, 0, 4);
        }

        void StepStress(float dt)
        {
            var snap = stress.Step(dt);
            if (snap != null) session.ApplySnapshot(snap);
            tour.Update(dt, rts, out string segment);
            if (time > 4f) perf.Begin(segment);
            if (opts.Has("shots") && segment != shotSegment && time > 4f) { shotSegment = segment; shotAt = time + 1.5f; }
            if (shotAt > 0 && time >= shotAt)
            {
                shotAt = 0;
                var dir = opts.Get("shots");
                System.IO.Directory.CreateDirectory(dir);
                ScreenCapture.CaptureScreenshot(System.IO.Path.Combine(dir, shotSegment + ".png"));
            }
            if (time >= stressSeconds + 4f)
            {
                Debug.Log("PHASES avg/max ms: " + PhaseSummary(false));
                PerfRecorder.Save(perfOut, perf.Report(j =>
                {
                    j.Str("scenario", "offline-stress").Num("map", session.World.Grid.W).Num("units", stress.UnitCount).Num("buildings", stress.BuildingCount)
                     .Num("terrain_chunks_built", terrain.ChunksBuilt).Num("city_cells", city.CellCount).Num("particles_skipped", fx.Skipped);
                }));
                if (!Application.isEditor) Application.Quit();
                ShowMenu("");
            }
        }

        // ------------------------------------------------------------------ frame
        void Update()
        {
            long t0 = Stopwatch.GetTimestamp();
            float dt = Mathf.Min(Time.unscaledDeltaTime, 0.25f);
            time += dt;
            double lastFrameMs = Time.unscaledDeltaTime * 1000.0;
            int gcNow = System.GC.CollectionCount(0);
            if (lastFrameMs > 50 && time > 2f && (phase == Phase.Stress || perfRunning))
                Debug.Log($"STALL {lastFrameMs:F0} ms: net {stallNet:F1} present {stallPresent:F1} [{PhaseSummary(true)}] units pos {units.PositionsMs:F1} build {units.BuildMs:F1} upload {units.UploadMs:F1} gc0 +{gcNow - gcLast} gc1 +{System.GC.CollectionCount(1) - gc1Last} msgs {stallMsgs} particles {fx.Live}");
            gcLast = gcNow; gc1Last = System.GC.CollectionCount(1);
            long tn = Stopwatch.GetTimestamp();
            int before = session.Snapshots + session.GeoMessages;
            net?.Update(4.0);
            stallNet = Ms(tn); stallMsgs = session.Snapshots + session.GeoMessages - before;
            if (phase == Phase.Connecting && net != null && net.State == GameConnection.Status.Retrying) hud?.ShowMenu(true, "Cannot reach " + serverUrl + "; retrying…");
            else if (phase == Phase.Connecting && !(hud?.MenuVisible ?? true)) hud?.ShowLoading(LoadingStage());
            StepDescent(dt);
            if (phase == Phase.Playing) SocialPlatform.Current.Tick();
            if (stress != null) StepStress(dt);
            intro?.Update(dt);
            if (phase == Phase.Menu) { AnimateMenuWorld(); rts.Yaw += dt * .4f; rts.Apply(); }
            if (InputFacade.Pressed(KeyCode.F3)) showDiag = !showDiag;
            if (InputFacade.Pressed(KeyCode.F10)) hideUi = !hideUi;
            long tp = Stopwatch.GetTimestamp();
            if (session.Ready) Present(dt);
            if (!reviewStarted && opts.Has("review") && time > 5 && (phase == Phase.Menu || phase == Phase.Playing && session.Snapshots >= 8))
            { reviewStarted = true; StartCoroutine(ReviewScenes()); }
            if (!reviewStarted && opts.Has("review-intro") && phase == Phase.Intro)
            { reviewStarted = true; StartCoroutine(ReviewIntroScenes()); }
            stallPresent = Ms(tp);
            hud?.Update(time);
            if (perfRunning && net != null && net.State == GameConnection.Status.Ready && time > probeAt)
            {
                probeAt = time + 0.5f;
                net.Command(new JObject { ["c"] = "stance", ["units"] = new JArray(), ["stance"] = "defensive" });
            }
            double frameMs = Time.unscaledDeltaTime * 1000.0;
            recent.Add(frameMs);
            perf.Sample(frameMs, (Stopwatch.GetTimestamp() - t0) * 1000.0 / Stopwatch.Frequency);
        }

        void Present(float dt)
        {
            var world = session.World;
            session.Units.AdvanceClock(dt, session.PlayRate, session.Paused);
            if (session.DirtyChunks.Count > 0) { terrain.MarkDirty(session.DirtyChunks); session.DirtyChunks.Clear(); }
            if (session.DirtyCells.Count > 0) { city.MarkDirty(session.DirtyCells); session.DirtyCells.Clear(); }
            if (ruinRev != session.RuinRevision)
            {
                ruinRev = session.RuinRevision;
                city.Ruins.Clear();
                foreach (var r in session.Ruins) if (r.Tile >= 0 && r.Tile < world.Grid.N) { city.Ruins[r.Tile] = r; city.MarkDirty(new[] { world.ChunkOf(r.Tile) }); }
            }
            bool overUi = hud != null && hud.IsPointerOverUi(InputFacade.MousePosition);
            if (phase == Phase.Playing && !(hud?.MenuVisible ?? false))
            { if (reviewCapturing) rts.UserControl = false; rts.Update(dt); }
            // comfort settings: shake, flashes, edge pan, pan speed, weather, marker contrast
            rts.Shake = fx.Shake * GameSettings.ShakeScale;
            if (GameSettings.ReducedMotion) fx.Flash = Mathf.Min(fx.Flash, 0.15f);
            rts.EdgePan = GameSettings.EdgePan;
            rts.PanSpeed = GameSettings.CameraSpeed;
            atmosphere.VisualIntensity = GameSettings.WeatherIntensity;
            units.HighContrast = GameSettings.HighContrastMarkers;
            if (phase == Phase.Playing && !reviewCapturing) commander.Update(time, overUi);
            long tq = Stopwatch.GetTimestamp();
            PresentEvents();
            Mark(0, ref tq);
            fog.Update(world);
            if (ground.Update(world, session.Battlefield, session.BattlefieldRevision, session.Weather, session.WeatherRevision, world.UrbanRevision))
                for (int i = 0; i < world.Grid.N; i++) if (ground.IsWasteland(i)) terrain.SetBlocked(i, true);
            Mark(1, ref tq);
            var camMap = rts.MapPosition;
            long ts = Stopwatch.GetTimestamp();
            terrain.Update(camMap);
            stallTerrain = Ms(ts); ts = Stopwatch.GetTimestamp();
            Mark(2, ref tq);
            city.Age = session.Age;
            city.SimulationTime = session.Units.RenderTime;
            if (city.ActionRts) city.SetObjectives(session.Objectives.Values);
            city.SetPickups(session.Pickups.Values);
            city.Update(camMap, terrain);
            // the building being placed, drawn where it would stand (green: allowed, red: not)
            if (phase == Phase.Playing && commander.RingPreviewParcel is BaseParcel ringParcel) city.SetGhost(commander.RingPreviewType, ringParcel.Tile, session.CivId, true, ringParcel);
            else if (phase == Phase.Playing && commander.FieldPreviewParcel is BaseParcel fieldParcel) city.SetGhost(commander.Option, fieldParcel.Tile, session.CivId, commander.FieldPreviewValid, fieldParcel);
            else if (phase == Phase.Playing && commander.PlacementTile >= 0) city.SetGhost(commander.Option, commander.PlacementTile, session.CivId, commander.PlacementLegal && (commander.PlacementSite == null || ProtocolDecoder.Bool(commander.PlacementSite["valid"], true)), commander.PlacementParcel);
            else city.ClearGhost();
            Mark(3, ref tq);
            warzone.Update(session.Trenches, session.TrenchRevision, session.Battlefield, session.BattlefieldRevision, DefenceSignature(), ground.IsWasteland);
            Mark(4, ref tq);
            Mark(5, ref tq);
            stallCity = Ms(ts); ts = Stopwatch.GetTimestamp();
            var cam = rts.Cam;
            float camX = cam.transform.position.x;
            units.Update(session.Units, world, session.CivColor, camX, rts.Focus, rts.Distance, time, dt, session.Structures);
            city.Animate(time, session.Units.RenderTime, rts.Focus, rts.Distance, atmosphere.WindMap);
            hud?.BadgeCounts(units.Badges, p => rts.ToScreen(new Vector3(p.x, p.y, p.z)));
            hud?.DrawObjectives(s =>
            {
                float x = world.Grid.NearX(s.X, rts.Focus.x);
                return rts.ToScreen(new Vector3(x, world.GroundHeight(x, s.Z) + .55f, s.Z));
            }, rts.Distance);
            hud?.DrawPickupRewards(p => rts.ToScreen(p), time);
            stallUnits = Ms(ts);
            Mark(6, ref tq);
            atmosphere.Update(world, session.Weather, new float3(rts.Focus.x, rts.Focus.y, rts.Focus.z), rts.Distance, fx, time, dt);
            Mark(7, ref tq);
            fx.Wind = atmosphere.WindMap;
            if (fx.GroundAt == null) fx.GroundAt = world.GroundHeight;
            fx.Update(dt, camX, world.Grid.Period, world.Grid.Wrap, phase == Phase.Playing ? session.Paused ? 0 : session.PlayRate : 1);
            Mark(8, ref tq);
            if (audioDirector != null) UpdateAudio(dt);
            images.Begin(cam, world.Grid.Period, world.Grid.Wrap);
            terrain.Draw(images, cam.transform.position);
            city.Draw(images);
            warzone.Draw(images);
            units.Draw();
            fx.Draw(images);
            if (phase == Phase.Playing) commander.DrawOverlay(images, time);
            Mark(9, ref tq);
            phaseFrames++;
        }

        // per-phase cost of Present (diagnostics: logged with stalls and summarised after a benchmark)
        static readonly string[] PhaseNames = { "events", "fog+ground", "terrain", "city", "warzone", "traffic", "units", "atmosphere", "fx", "draw" };
        readonly double[] phaseMs = new double[10], phaseSum = new double[10], phaseMax = new double[10];
        long phaseFrames;
        void Mark(int k, ref long since)
        {
            long now = Stopwatch.GetTimestamp();
            double ms = (now - since) * 1000.0 / Stopwatch.Frequency;
            since = now;
            phaseMs[k] = ms; phaseSum[k] += ms; if (ms > phaseMax[k]) phaseMax[k] = ms;
        }

        string PhaseSummary(bool last)
        {
            var sb = new StringBuilder();
            for (int k = 0; k < PhaseNames.Length; k++)
                sb.Append(PhaseNames[k]).Append(' ').Append((last ? phaseMs[k] : phaseSum[k] / Mathf.Max(1, phaseFrames)).ToString("0.00"))
                  .Append(last ? "" : "/" + phaseMax[k].ToString("0.0")).Append("  ");
            return sb.ToString();
        }

        // Trenches join the defences beside them: rebuild them only when the defences themselves change,
        // not whenever any building's health or progress ticks.
        int defenceRev = -1, defenceSig;
        readonly Dictionary<int, (string type, int owner)> buildingByTile = new Dictionary<int, (string, int)>();
        int DefenceSignature()
        {
            if (defenceRev == session.Structures.Revision) return defenceSig;
            defenceRev = session.Structures.Revision;
            buildingByTile.Clear();
            unchecked
            {
                int sig = 17;
                foreach (var b in session.Structures.Buildings.Values)
                {
                    if (b.Tile < 0) continue;
                    buildingByTile[b.Tile] = (b.Type, b.Owner);
                    if (IsDefence(b.Type)) sig = sig * 31 + b.Tile * 7 + b.Owner + (b.Done ? 1 : 0);
                }
                defenceSig = sig;
            }
            return defenceSig;
        }

        static bool IsDefence(string type) => type == "bunker" || type == "guard_post" || type == "fort" || type == "aa_battery";

        void UpdateAudio(float dt)
        {
            var w = session.World;
            int focusTile = w.Grid.TileAt(rts.Focus.x, rts.Focus.z);
            float urban = 0, river = 0; int n = 0;
            if (focusTile >= 0)
                for (int d = -1; d < 6; d++)
                {
                    int t = d < 0 ? focusTile : w.Grid.Nb[focusTile * 6 + d];
                    if (t < 0) continue;
                    n++;
                    if (w.IsUrban(t) || HasBuilding(t)) urban++;
                    if (w.IsRiver(t) || (w.GeoFlags[t] & 128) != 0) river = 1;
                }
            float wind = Mathf.Clamp01(atmosphere.WindMap.x * atmosphere.WindMap.x + atmosphere.WindMap.z * atmosphere.WindMap.z);
            audioDirector.Update(dt, session.Units, id => units.TryGetPosition(session.Units, id, out var p) ? p : (Vector2?)null, w,
                new float3(rts.Focus.x, rts.Focus.y, rts.Focus.z), rts.Distance, n > 0 ? urban / n : 0, river, atmosphere.Rain, wind, session.Structures);
        }

        bool HasBuilding(int tile)
        {
            if (buildingRev != session.Structures.Revision)
            {
                buildingRev = session.Structures.Revision;
                buildingTiles.Clear();
                foreach (var b in session.Structures.Buildings.Values) buildingTiles.Add(b.Tile);
            }
            return buildingTiles.Contains(tile);
        }

        float fireAt;
        void PresentEvents()
        {
            var world = session.World;
            var store = session.Units;
            float reach = Mathf.Max(60f, rts.Distance * 3f);
            foreach (var e in session.Events)
            {
                switch (e.Kind)
                {
                    case "pickup":
                        var pickupPoint = EventPoint(e, true, .11f);
                        fx.Capture(pickupPoint, new float3(.73f, .62f, .40f));
                        audioDirector?.Play("capture", pickupPoint, .24f, 4, 0, rts.Distance);
                        if (e.Owner == session.CivId) hud?.ShowPickupReward(pickupPoint, e.Amount, time);
                        break;
                    case "capture":
                        var capturePoint = EventPoint(e, false, 0);
                        fx.Capture(capturePoint, session.CivColor(e.Owner).xyz);
                        audioDirector?.Play("capture", capturePoint, .75f, 8, 0, rts.Distance);
                        break;
                    case "fire":
                    {
                        var p = EventPoint(e, true, .06f);
                        if (!Near(p, reach)) break;
                        bool heavy = false, aa = false; string sound = "rifle";
                        if (store.TryGet(e.Shooter, out var shooter))
                        {
                            var type = store.Types.Name(shooter.TypeIndex);
                            heavy = type.Contains("tank") || type == "field_gun" || type == "sp_artillery" || type == "armored_car";
                            aa = type == "air_defense";
                            sound = type == "engineer" ? "pistol" : type.Contains("tank") || type == "field_gun" ? "cannon" : type == "armored_car" || type == "scout_buggy" ? "mg" : type == "mech_infantry" ? "autocannon" : aa ? "flak" : "rifle";
                        }
                        else if (session.Structures.Buildings.TryGetValue(e.Shooter, out var emplacement))
                        {
                            heavy = emplacement.Type == "turret" || emplacement.Type == "artillery_post" || emplacement.Type == "fort";
                            aa = emplacement.Type == "aa_battery";
                            sound = aa ? "flak" : heavy ? "cannon" : "mg";
                        }
                        fx.Muzzle(p, heavy);
                        var target = EventPoint(e, false, .05f);
                        p = WeaponMuzzle(e.Shooter, p, target);
                        fx.Tracer(p, target, heavy);
                        units.NoteShot(e.Shooter, e.Target, time, new Vector2(target.x, target.z));
                        audioDirector?.Play(sound, p, heavy ? 0.9f : 0.5f, heavy ? 4f : 1.5f, heavy ? 2 : 1, rts.Distance);
                        if (aa || IsAirTarget(e.Target))
                        {
                            // anti-aircraft fire bursts in the sky around the target
                            fx.AirBurst(target);
                            audioDirector?.Play("flak", target, 0.7f, 5f, 2, rts.Distance);
                        }
                        break;
                    }
                    case "launch":
                    {
                        var p = EventPoint(e, true, .08f);
                        if (!Near(p, reach)) break;
                        var target = EventPoint(e, false, .05f);
                        p = WeaponMuzzle(e.Shooter, p, target);
                        string weapon = ProtocolDecoder.Str(session.Defs?["WEAPON_KEYS"]?[e.Weapon], "cannon");
                        fx.Muzzle(p, true);
                        fx.Projectile(p, target, weapon, e.Flight);
                        units.NoteShot(e.Shooter, e.Target, time, new Vector2(target.x, target.z));
                        audioDirector?.Play(weapon == "cannon" || weapon == "howitzer" || weapon == "atgun" || weapon == "fortgun" ? "cannon" : "launch", p, 0.9f, 5f, 2, rts.Distance);
                        break;
                    }
                    case "impact":
                    {
                        var p = EventPoint(e, false, .01f);
                        if (!Near(p, reach)) break;
                        float scale = Mathf.Max(0.6f, e.Radius > 0 ? e.Radius * 1.4f : 0.7f);
                        if (e.Airburst) { fx.AirBurst(p + new float3(0, IsAirTarget(e.Target) ? 0 : 1.6f, 0)); audioDirector?.Play("flak", p, 0.8f, 5f, 2, rts.Distance); }
                        else
                        {
                            fx.Impact(p, scale, e.To >= 0 && e.To < world.Grid.N ? world.Biome[e.To] : 2);
                            if (!session.ActionRts) fx.Crater(p, .16f * scale + .06f);
                            audioDirector?.Play(scale > 1.1f ? "explosion_big" : "explosion", p, 1f, 6f, 3, rts.Distance);
                        }
                        break;
                    }
                    case "hit":
                        if (e.Damage >= 8 && UnityEngine.Random.value < 0.5f)
                        {
                            var p = EventPoint(e, false, .035f);
                            if (Near(p, reach)) fx.Impact(p, .3f, 2, true);
                        }
                        break;
                    case "bhit":
                    {
                        var p = EventPoint(e, false, .1f);
                        if (!Near(p, reach)) break;
                        fx.Explosion(p, 0.7f);
                        audioDirector?.Play(e.Outcome == "destroyed" ? "collapse" : "explosion", p, 1f, 6f, 3, rts.Distance);
                        break;
                    }
                    case "kill":
                    {
                        var p = EventPoint(e, false, 0);
                        p.y = world.GroundHeight(p.x, p.z);
                        var t = e.UnitType ?? "";
                        units.NoteCasualty(e.Target, t, e.Owner, p, world.Epoch, time);
                        if (t.Contains("tank") || t.Contains("car") || t.Contains("truck") || t.Contains("buggy") || t.Contains("artillery") || t == "mech_infantry" || t == "air_defense" || t == "missile_battery")
                        {
                            if (!session.ActionRts) fx.Wreck(p, UnityEngine.Random.value * 6.28f, 0.16f);
                            if (Near(p, reach)) { fx.Explosion(p, 0.9f); audioDirector?.Play("explosion_big", p, 1f, 6f, 3, rts.Distance); }
                        }
                        break;
                    }
                    case "mimpact":
                    {
                        // a strategic warhead or (half strength) a destroyed reactor: seen and heard from afar
                        var p = EventPoint(e, false, 0);
                        fx.Strategic(p, e.Half ? 0.5f : 1f);
                        audioDirector?.Play("strategic", p, 1f, 60f, 5, rts.Distance);
                        break;
                    }
                }
            }
            session.Events.Clear();
            // burning buildings and burning wrecks
            fireAt -= Time.unscaledDeltaTime;
            if (fireAt <= 0)
            {
                fireAt = 0.15f;
                bool closeEnough = rts.Distance < 70f;
                foreach (var b in session.Structures.Buildings.Values)
                {
                    if (b.Tile < 0) continue;
                    if (b.Fire)
                    {
                        var p = b.HasPosition ? new float3(b.X, world.GroundHeight(b.X, b.Z) + .12f, b.Z) : TileCentre(b.Tile, .12f);
                        if (Near(p, reach)) fx.Fire(p + Jitter(0.25f), 0.35f);
                        continue;
                    }
                    // working industry breathes: soot from stacks, steam from cooling towers
                    if (!closeEnough || !b.Done || b.Staffed == 0 && b.Owner == session.CivId) continue;
                    if (!city.Stacks.TryGetValue(b.Id, out var stacks) || UnityEngine.Random.value > 0.45f) continue;
                    var c = TileCentre(b.Tile, 0f);
                    if (!Near(c, Mathf.Min(reach, 45f))) continue;
                    foreach (var s in stacks)
                    {
                        // stacks are composed in the base image; bring them next to the camera
                        var sp = s.Pos; sp.x = world.Grid.NearX(sp.x, rts.Focus.x);
                        fx.Smoke(sp, atmosphere.WindMap, s.Steam, s.Size);
                    }
                }
                foreach (var p in warzone.BurningWrecks) if (Near(p, reach)) fx.Fire(p, 0.15f);
                if (rts.Distance < 32)
                {
                    int budget = 0;
                    for (int slot = 0; slot < store.SlotCount && budget < 24; slot++)
                    {
                        ref var unit = ref store.Records[slot];
                        if (!unit.InUse || !unit.Motion.Present || IsAirTarget(unit.Id)) continue;
                        string type = store.Types.Name(unit.TypeIndex);
                        if (type.Contains("squad") || type.Contains("infantry") || type == "engineer" || type == "militia" || type == "anti_armor" || type == "special_forces" || type == "mortar_team") continue;
                        if (!units.TryGetPosition(store, unit.Id, out var xz)) continue;
                        var position = new float3(xz.x, world.GroundHeight(xz.x, xz.y), xz.y);
                        if (!Near(position, 17)) continue;
                        fx.EngineTrail(position, new float3(unit.Motion.Vx, 0, unit.Motion.Vz), unit.Hp < 35, atmosphere.Rain < .35f);
                        budget++;
                    }
                }
            }
        }

        bool IsAirTarget(int id)
        {
            var store = session.Units;
            if (!store.TryGet(id, out var r)) return false;
            var t = store.Types.Name(r.TypeIndex);
            return t == "helicopter" || t == "fighter" || t == "bomber" || t.Contains("drone") || t == "strike_swarm";
        }

        float3 Jitter(float r) => new float3(UnityEngine.Random.Range(-r, r), 0, UnityEngine.Random.Range(-r, r));

        float3 TileCentre(int tile, float lift)
        {
            var g = session.World.Grid;
            if (tile < 0 || tile >= g.N) return new float3(rts.Focus.x, -100, rts.Focus.z);
            float x = g.CenterX(tile), z = g.CenterZ(tile);
            return new float3(x, session.World.GroundHeight(x, z) + lift, z);
        }

        float3 UnitOrTile(int id, int tile, float lift)
        {
            if (id > 0 && units.TryGetPosition(session.Units, id, out var xz))
                return new float3(xz.x, session.World.GroundHeight(xz.x, xz.y) + lift, xz.y);
            return TileCentre(tile, lift);
        }

        bool Near(float3 p, float reach)
        {
            float dx = session.World.Grid.DxWrap(rts.Focus.x, p.x), dz = p.z - rts.Focus.z;
            return dx * dx + dz * dz < reach * reach;
        }

        void OnDestroy()
        {
            terrain?.Dispose(); city?.Dispose(); warzone?.Dispose(); units?.Dispose(); fx?.Dispose(); fog?.Dispose(); ground?.Dispose();
            atmosphere?.Dispose(); audioDirector?.Dispose(); commander?.Dispose();
            net?.Dispose();
            session?.World.Dispose();
        }

        void OnApplicationQuit() { if (phase != Phase.Stress) SocialPlatform.Current.Shutdown(); }

        // ------------------------------------------------------------------ diagnostics overlay (F3)
        GUIStyle small, box;
        string diagText = "";
        float diagAt;

        void OnGUI()
        {
            if (!(showDiag || phase == Phase.Stress) || hideUi) return;
            if (small == null)
            {
                small = new GUIStyle(GUI.skin.label) { fontSize = 12, wordWrap = true, normal = { textColor = new Color(0.85f, 0.88f, 0.84f) } };
                var bg = new Texture2D(1, 1); bg.SetPixel(0, 0, new Color(0.05f, 0.08f, 0.09f, 0.8f)); bg.Apply();
                box = new GUIStyle(GUI.skin.box) { normal = { background = bg } };
            }
            if (time > diagAt) { diagAt = time + 0.25f; diagText = Diagnostics(); }
            GUI.Box(new Rect(Screen.width - 446, 48, 438, 236), GUIContent.none, box);
            GUI.Label(new Rect(Screen.width - 438, 54, 424, 226), diagText, small);
        }

        string Diagnostics()
        {
            var sb = new StringBuilder(256);
            var f = recent.Frames;
            sb.Append("FPS ").Append((1000.0 / Mathf.Max(0.01f, (float)f.Average())).ToString("0")).Append("   frame p50 ").Append(f.Percentile(0.5).ToString("0.0"))
              .Append(" p95 ").Append(f.Percentile(0.95).ToString("0.0")).Append(" p99 ").Append(f.Percentile(0.99).ToString("0.0")).Append(" ms   stalls>100ms ").Append(recent.Over100).Append('\n');
            sb.Append("units ").Append(session.Units.Count).Append(" drawn ").Append(units.Drawn).Append(" instances ").Append(units.Instances)
              .Append("   buildings ").Append(session.Structures.Buildings.Count).Append(" cells ").Append(city.CellCount).Append('\n');
            sb.Append("terrain chunks built ").Append(terrain.ChunksBuilt).Append(" dirty ").Append(terrain.DirtyCount).Append(" drawn ").Append(terrain.DrawnChunks)
              .Append("   particles ").Append(fx.Live).Append('\n');
            sb.Append("camera ").Append(rts.Distance.ToString("0")).Append("   snapshots ").Append(session.Snapshots).Append(" apply ").Append(session.ApplyMs.ToString("0.00")).Append(" ms\n");
            sb.Append("weather cloud ").Append(atmosphere.Cloud.ToString("0.00")).Append(" rain ").Append(atmosphere.Rain.ToString("0.00")).Append("   trenches ").Append(session.Trenches.Length).Append('\n');
            if (net != null)
            {
                sb.Append("net ").Append(net.State).Append(" proto ").Append(net.ProtocolVersion).Append(" [").Append(string.Join(",", net.Capabilities)).Append("] rtt ").Append(net.RttMs.ToString("0")).Append(" ms\n");
                sb.Append("backlog ").Append(net.Link.Backlog).Append(" decode ").Append(net.Link.LastDecodeMs.ToString("0.0")).Append(" ms  in ").Append((net.Link.BytesIn / 1048576.0).ToString("0.0")).Append(" MB\n");
                sb.Append("commands in flight ").Append(net.Commands.InFlight).Append("  ack p95 ").Append(net.Commands.AckMs.Percentile(0.95).ToString("0")).Append(" ms  timeouts ").Append(net.Commands.Timeouts).Append('\n');
            }
            sb.Append("GPU ").Append(SystemInfo.graphicsDeviceName).Append("  F3 diagnostics  F10 hide");
            return sb.ToString();
        }
    }

    /// <summary>A scripted camera path for repeatable benchmarks (pan, zoom, orbit, seam crossing).</summary>
    public sealed class CameraTour
    {
        struct Leg { public string Name; public int From, To; public float D0, D1, YawSpeed, Seconds; public System.Action OnStart; }
        readonly List<Leg> legs = new List<Leg>();
        readonly SE.Core.World.HexGrid grid;
        int index = -1;
        float t;

        public CameraTour(SE.Core.World.HexGrid g) { grid = g; }

        /// <summary>to = -1 sweeps east by 1.2 world periods (crossing the wrap seam).</summary>
        public CameraTour Add(string name, int from, int to, float d0, float d1, float yawSpeed, float seconds, System.Action onStart = null)
        {
            legs.Add(new Leg { Name = name, From = from, To = to, D0 = d0, D1 = d1, YawSpeed = yawSpeed, Seconds = seconds, OnStart = onStart });
            return this;
        }

        public void Update(float dt, RtsCamera cam, out string segment)
        {
            if (index < 0 || t >= legs[index].Seconds)
            {
                index = (index + 1) % legs.Count;
                t = 0;
                legs[index].OnStart?.Invoke();
            }
            var leg = legs[index];
            t += dt;
            float k = Mathf.SmoothStep(0, 1, Mathf.Clamp01(t / leg.Seconds));
            float ax = grid.CenterX(leg.From), az = grid.CenterZ(leg.From);
            float bx, bz;
            if (leg.To < 0) { bx = ax + grid.Period * 1.2f; bz = az; }
            else { bx = ax + grid.DxWrap(ax, grid.CenterX(leg.To)); bz = grid.CenterZ(leg.To); }
            cam.Focus = new Vector3(Mathf.Lerp(ax, bx, k), cam.Focus.y, Mathf.Lerp(az, bz, k));
            cam.Distance = cam.TargetDistance = Mathf.Lerp(leg.D0, leg.D1, k);
            cam.Yaw += leg.YawSpeed * dt;
            cam.Apply();
            segment = leg.Name;
        }
    }
}
