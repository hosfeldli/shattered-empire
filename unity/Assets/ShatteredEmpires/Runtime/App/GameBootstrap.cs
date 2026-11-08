using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Newtonsoft.Json.Linq;
using SE.Core.Diagnostics;
using SE.Core.Protocol;
using SE.Core.Stress;
using SE.Net;
using SE.Runtime.CameraControl;
using SE.Runtime.Cities;
using SE.Runtime.Effects;
using SE.Runtime.Input;
using SE.Runtime.Landscape;
using SE.Runtime.Military;
using SE.Runtime.Rendering;
using SE.Runtime.Session;
using SE.Runtime.Social;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using Debug = UnityEngine.Debug;

namespace SE.Runtime.App
{
    /// <summary>
    /// The client's single entry point and frame loop. Order each frame: network (bounded apply, acks
    /// first) → playback clock → camera and input → effects from combat events → incremental world
    /// rebuilds (jobs) → instance buffers → draw calls. There is no per-object Update anywhere.
    /// </summary>
    public sealed class GameBootstrap : MonoBehaviour
    {
        enum Phase { Menu, Connecting, Playing, Stress }

        LaunchOptions opts;
        Phase phase = Phase.Menu;
        ClientSession session;
        GameConnection net;
        TerrainRenderer terrain;
        FogField fog;
        CityRenderer city;
        UnitRenderer units;
        EffectsRenderer fx;
        RtsCamera rts;
        Commander commander;
        readonly WrapImages images = new WrapImages();
        readonly PerfRecorder perf = new PerfRecorder();
        readonly FrameStats recent = new FrameStats();
        InstanceBatch marks;
        Light sun;
        readonly Stopwatch clock = Stopwatch.StartNew();
        double Now => clock.Elapsed.TotalSeconds;
        float time;

        // menu state
        string serverUrl = LaunchOptions.PublicServer, playerName = "Commander", joinCode = "", menuStatus = "";
        string pendingMode;
        bool showDiag, hideUi;

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

        // ------------------------------------------------------------------ start-up
        void Awake()
        {
            opts = LaunchOptions.FromCommandLine();
            Application.runInBackground = true;
            QualitySettings.vSyncCount = opts.Int("vsync", opts.Has("perf") || opts.Get("mode") == "stress" ? 0 : 1);
            Application.targetFrameRate = QualitySettings.vSyncCount == 0 ? 1000 : -1;
            var cam = Camera.main;
            if (cam == null) { cam = new GameObject("Main Camera") { tag = "MainCamera" }.AddComponent<Camera>(); }
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.55f, 0.62f, 0.7f);
            cam.fieldOfView = 40f;
            sun = FindFirstObjectByType<Light>();
            if (sun == null) sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.transform.rotation = Quaternion.Euler(47f, -32f, 0f);
            sun.color = new Color(1f, 0.95f, 0.86f);
            sun.intensity = 1.25f;
            sun.shadows = LightShadows.Soft;
            sun.shadowStrength = 0.85f;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.56f, 0.63f, 0.72f);
            RenderSettings.ambientEquatorColor = new Color(0.44f, 0.44f, 0.4f);
            RenderSettings.ambientGroundColor = new Color(0.22f, 0.2f, 0.17f);
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = new Color(0.6f, 0.66f, 0.72f);
            Shader.SetGlobalFloat("_SE_Wetness", 0f);

            RenderResources.Load();
            session = new ClientSession();
            terrain = new TerrainRenderer(session.World);
            fog = new FogField();
            city = new CityRenderer(session.World, session.Structures) { CivColor = id => session.CivColor(id) };
            units = new UnitRenderer();
            fx = new EffectsRenderer();
            rts = new RtsCamera(cam);
            rts.Bind(session.World);
            commander = new Commander(session, rts, units);
            marks = new InstanceBatch(MeshKit.Ring, RenderResources.Instanced, 64) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off };
            session.BeforeGeometryChange = terrain.CompleteAll;
            session.Welcomed += OnWelcomed;
            session.Other += OnOther;
            ApplyQuality(opts.Get("quality", "high"));
            if (opts.Has("server")) serverUrl = opts.Get("server");
            if (opts.Has("name")) playerName = opts.Get("name");
        }

        void Start()
        {
            var mode = opts.Get("mode");
            if (mode == "stress") StartStress();
            else if (mode != "") StartMatch(mode, opts.Get("match"));
            if (phase == Phase.Menu && mode != "stress")
                SocialPlatform.Current.JoinRequested += code => StartMatch("join", code);
        }

        public void ApplyQuality(string preset)
        {
            var urp = GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;
            switch (preset)
            {
                case "low":
                    if (urp) { urp.shadowDistance = 45; urp.msaaSampleCount = 1; urp.renderScale = 0.85f; }
                    terrain.TreeDensity = 0.5f; terrain.TreeDistance = 60; terrain.LodDistance = 45; fx.Intensity = 0.5f;
                    break;
                case "medium":
                    if (urp) { urp.shadowDistance = 80; urp.msaaSampleCount = 2; urp.renderScale = 1f; }
                    terrain.TreeDensity = 0.75f; terrain.TreeDistance = 85; terrain.LodDistance = 60; fx.Intensity = 0.75f;
                    break;
                case "ultra":
                    if (urp) { urp.shadowDistance = 200; urp.msaaSampleCount = 4; urp.renderScale = 1f; }
                    terrain.TreeDensity = 1.25f; terrain.TreeDistance = 150; terrain.LodDistance = 100; fx.Intensity = 1.2f;
                    break;
                default:
                    if (urp) { urp.shadowDistance = 130; urp.msaaSampleCount = 4; urp.renderScale = 1f; }
                    terrain.TreeDensity = 1f; terrain.TreeDistance = 110; terrain.LodDistance = 70; fx.Intensity = 1f;
                    break;
            }
        }

        // ------------------------------------------------------------------ matches
        void StartMatch(string mode, string match)
        {
            net?.Dispose();
            net = new GameConnection(() => Now);
            session.Attach(net);
            pendingMode = mode;
            phase = Phase.Connecting;
            menuStatus = "Connecting to " + serverUrl + "…";
            battleKey = opts.Get("battle");
            perfZooms = opts.Floats("perf-zooms", 14f, 40f);
            perfSeconds = opts.Float("perf", 0);
            perfOut = opts.Get("perf-out");
            if (mode == "rejoin")
            {
                net.SessionMatch = PlayerPrefs.GetString("se.match", "");
                net.SessionToken = PlayerPrefs.GetString("se.token", "");
                if (net.SessionMatch == "") { menuStatus = "No earlier match to return to."; phase = Phase.Menu; return; }
            }
            else if (mode == "join" || mode == "spectate")
                net.Send(new JObject { ["t"] = mode, ["match"] = match, ["name"] = playerName });
            else
            {
                var msg = new JObject { ["t"] = "create", ["mode"] = mode, ["name"] = playerName, ["ruleset"] = "native-v4", ["ais"] = mode == "observe" ? 3 : 1 };
                if (opts.Has("seed")) msg["seed"] = opts.Int("seed", 0);
                if (opts.Has("map")) msg["mapSize"] = opts.Get("map");
                if (opts.Has("perf") || opts.Has("bench"))
                    msg["rivals"] = new JArray(new JObject { ["personality"] = "warlord" }, new JObject { ["personality"] = "merchant" }, new JObject { ["personality"] = "builder" });
                net.Send(msg);
            }
            net.Connect(serverUrl);
        }

        void OnWelcomed()
        {
            phase = phase == Phase.Stress ? Phase.Stress : Phase.Playing;
            terrain.SetSeed(session.Welcome.Seed);
            fx.ClearPersistent();
            units.Selected.Clear();
            if (net != null)
            {
                PlayerPrefs.SetString("se.match", net.SessionMatch ?? "");
                PlayerPrefs.SetString("se.token", net.SessionToken ?? "");
                PlayerPrefs.Save();
            }
            // a rejoin of the same match keeps the camera where it was; a new match starts at home
            if (session.Welcome.Start >= 0 && (rts.Distance <= 0 || pendingMode != "rejoin-same")) rts.FocusTile(session.Welcome.Start, 30f);
            pendingMode = "rejoin-same";
            if (!string.IsNullOrEmpty(battleKey) && session.Welcome.Sandbox && arena < 0) StageBattle();
        }

        void OnOther(ServerMessage m)
        {
            if (m.T == "error" && phase == Phase.Connecting) { menuStatus = m.Error; }
            if (m.T == "joined" && ProtocolDecoder.Str(m.Raw["status"]) == "lobby") menuStatus = "Waiting in the match lobby (code " + ProtocolDecoder.Str(m.Raw["match"], "") + ")";
        }

        /// <summary>The Godot client's --battle staging, through the same server commands.</summary>
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
                int third = all.Count / 3;
                net.Command(new JObject { ["c"] = "fortify", ["units"] = new JArray(all.GetRange(0, third).ToArray()) });
                Invoke(nameof(Advance), 6f);
                if (perfSeconds > 0 && !perfRunning) StartCoroutine(LivePerf());
            });
        }

        void Advance()
        {
            if (battleUnits == null) return;
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
        void StartStress()
        {
            phase = Phase.Stress;
            int seed = opts.Int("seed", 7);
            int size = opts.Int("stress-size", 256);
            stressSeconds = opts.Float("stress-seconds", 60);
            perfOut = opts.Get("perf-out");
            var gen = StressWorld.Generate(size, seed);
            session.ApplyWelcome(new WelcomeMessage
            {
                W = size, H = size, Wrap = true, CivId = 0, Seed = seed, Match = "stress", Ruleset = "native-v4",
                Civs = new[] { new CivInfo { Id = 0, Name = "Ironford Compact", Color = 0x3f7fbf, Human = true }, new CivInfo { Id = 1, Name = "Ashen Directorate", Color = 0xbf4a3a } },
            });
            session.ApplyGeo(gen.Geo);
            stress = new StressScenario(seed);
            stress.Setup(session.World, opts.Int("stress-units", 1000), opts.Int("stress-buildings", 450));
            session.Age = opts.Int("stress-age", 3);
            fog.Enabled = false;
            rts.UserControl = false;
            var g = session.World.Grid;
            int city0 = stress.CityTile, front = stress.ArenaTile;
            tour = new CameraTour(g)
                .Add("city_strategic", city0, city0, 150, 120, 0, 6)
                .Add("city_tactical", city0, city0, 14, 12, 18, 8, () => stress.BurstBuild(10))
                .Add("fast_pan", city0, front, 35, 35, 0, 4)
                .Add("battle_tactical", front, front, 12, 12, 22, 10)
                .Add("battle_operational", front, front, 40, 40, 6, 6)
                .Add("strategic_sweep", front, -1, 240, 240, 0, 8)
                .Add("zoom_dive", front, front, 240, 10, 0, 4);
            menuStatus = "Stress scene: " + stress.UnitCount + " units, " + stress.BuildingCount + " buildings";
        }

        void StepStress(float dt)
        {
            var snap = stress.Step(dt);
            if (snap != null) session.ApplySnapshot(snap);
            tour.Update(dt, rts, out string segment);
            // the first seconds build every chunk; measure the steady state, as a player would see it
            if (time > 4f) perf.Begin(segment);
            if (time >= stressSeconds + 4f)
            {
                PerfRecorder.Save(perfOut, perf.Report(j =>
                {
                    j.Str("scenario", "offline-stress").Num("map", session.World.Grid.W).Num("units", stress.UnitCount).Num("buildings", stress.BuildingCount)
                     .Num("terrain_chunks_built", terrain.ChunksBuilt).Num("city_cells", city.CellCount).Num("particles_skipped", fx.Skipped);
                }));
                if (!Application.isEditor) Application.Quit();
                stress = null;
                rts.UserControl = true;
                phase = Phase.Playing;
            }
        }

        // ------------------------------------------------------------------ frame
        void Update()
        {
            long t0 = Stopwatch.GetTimestamp();
            float dt = Mathf.Min(Time.unscaledDeltaTime, 0.25f);
            time += dt;
            net?.Update(4.0);
            if (phase == Phase.Connecting && net != null && net.State == GameConnection.Status.Retrying) menuStatus = "Cannot reach " + serverUrl + "; retrying…";
            if (phase != Phase.Stress && phase != Phase.Menu) SocialPlatform.Current.Tick();
            if (stress != null) StepStress(dt);
            if (InputFacade.Pressed(KeyCode.F3)) showDiag = !showDiag;
            if (InputFacade.Pressed(KeyCode.F10)) hideUi = !hideUi;
            if (session.Ready) Present(dt);
            // live probe for command acknowledgment latency during benchmarks (a no-op order)
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
            if (phase != Phase.Stress) rts.Update(dt);
            commander.Update(time, PointerOverUi());
            PresentEvents();
            fog.Update(world);
            var camMap = rts.MapPosition;
            terrain.Update(camMap);
            city.Age = session.Age;
            city.Update(camMap, terrain);
            var cam = rts.Cam;
            float camX = cam.transform.position.x;
            units.Update(session.Units, world, session.CivColor, camX, rts.Distance, time, dt);
            fx.Update(dt, camX, world.Grid.Period, world.Grid.Wrap);
            RenderSettings.fogStartDistance = rts.Distance * 2.5f;
            RenderSettings.fogEndDistance = rts.Distance * 6f + 250f;
            images.Begin(cam, world.Grid.Period, world.Grid.Wrap);
            terrain.Draw(images, cam.transform.position);
            city.Draw(images);
            units.Draw();
            fx.Draw(images);
            DrawOrders(world);
        }

        float fireAt;
        void PresentEvents()
        {
            var world = session.World;
            var g = world.Grid;
            var store = session.Units;
            float reach = Mathf.Max(60f, rts.Distance * 3f);
            foreach (var e in session.Events)
            {
                switch (e.Kind)
                {
                    case "fire":
                    {
                        var p = UnitOrTile(e.Shooter, e.From, 0.06f);
                        if (!Near(p, reach)) break;
                        bool heavy = false, aa = false;
                        if (store.TryGet(e.Shooter, out var shooter))
                        {
                            var type = store.Types.Name(shooter.TypeIndex);
                            heavy = type.Contains("tank") || type == "field_gun" || type == "sp_artillery" || type == "armored_car";
                            aa = type == "air_defense";
                        }
                        fx.Muzzle(p, heavy);
                        units.NoteShot(e.Shooter, e.Target, time);
                        if (aa || IsAirTarget(e.Target))
                        {
                            // anti-aircraft fire bursts in the sky around the target
                            var t = UnitOrTile(e.Target, e.To, 0f);
                            for (int k = 0; k < 3; k++)
                                fx.AirBurst(t + new float3(UnityEngine.Random.Range(-0.4f, 0.4f), 1.1f + UnityEngine.Random.Range(0f, 0.9f), UnityEngine.Random.Range(-0.4f, 0.4f)));
                        }
                        break;
                    }
                    case "launch":
                    {
                        var p = TileCentre(e.From, 0.08f);
                        if (Near(p, reach)) fx.Muzzle(p, true);
                        break;
                    }
                    case "impact":
                    {
                        var p = TileCentre(e.To, 0f) + Jitter(0.35f);
                        p.y = world.GroundHeight(p.x, p.z);
                        if (!Near(p, reach)) { fx.Crater(p, 0.2f); break; }
                        float scale = Mathf.Max(0.6f, e.Radius > 0 ? e.Radius * 1.4f : 0.7f);
                        if (e.Airburst) fx.AirBurst(p + new float3(0, 0.6f, 0));
                        else { fx.Explosion(p, scale); fx.Crater(p, 0.16f * scale + 0.06f); }
                        break;
                    }
                    case "hit":
                        if (e.Damage >= 8 && UnityEngine.Random.value < 0.5f)
                        {
                            var p = UnitOrTile(e.Target, e.To, 0f) + Jitter(0.1f);
                            if (Near(p, reach)) fx.Explosion(p, 0.3f);
                        }
                        break;
                    case "bhit":
                    {
                        var p = TileCentre(e.To, 0.1f) + Jitter(0.3f);
                        if (Near(p, reach)) fx.Explosion(p, 0.7f);
                        break;
                    }
                    case "kill":
                    {
                        var p = TileCentre(e.To, 0f) + Jitter(0.3f);
                        p.y = world.GroundHeight(p.x, p.z);
                        var t = e.UnitType ?? "";
                        if (t.Contains("tank") || t.Contains("car") || t.Contains("truck") || t.Contains("buggy") || t.Contains("artillery") || t == "mech_infantry" || t == "air_defense" || t == "missile_battery")
                        {
                            fx.Wreck(p, UnityEngine.Random.value * 6.28f, 0.16f);
                            if (Near(p, reach)) fx.Explosion(p, 0.9f);
                        }
                        break;
                    }
                }
            }
            session.Events.Clear();
            // burning buildings
            fireAt -= Time.unscaledDeltaTime;
            if (fireAt <= 0)
            {
                fireAt = 0.15f;
                foreach (var b in session.Structures.Buildings.Values)
                {
                    if (!b.Fire || b.Tile < 0) continue;
                    var p = TileCentre(b.Tile, 0.12f);
                    if (Near(p, reach)) fx.Fire(p + Jitter(0.25f), 0.35f);
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

        void DrawOrders(SE.Core.World.WorldModel world)
        {
            marks.Clear();
            foreach (var o in commander.Orders)
            {
                float a = 1f - Mathf.Clamp01((time - o.Time) / (o.State == "pending" ? 8f : 1.5f));
                var col = o.State == "pending" ? new float4(1f, 0.82f, 0.25f, 0.6f) : o.State == "accepted" ? new float4(0.35f, 1f, 0.45f, 0.6f * a) : new float4(1f, 0.3f, 0.25f, 0.8f * a);
                float pulse = o.State == "pending" ? 0.5f + 0.1f * Mathf.Sin(time * 8f) : 0.5f + (1f - a) * 0.3f;
                var p = MapSpace.W(new float3(o.MapPoint.x, world.GroundHeight(o.MapPoint.x, o.MapPoint.z) + 0.02f, o.MapPoint.z));
                marks.Add(InstanceData.TRS(p, 0, new float3(pulse), col));
            }
            marks.DrawImages(images);
        }

        bool PointerOverUi()
        {
            var m = InputFacade.MousePosition;
            float y = Screen.height - m.y;
            return y < 34 || (y > Screen.height - 28);
        }

        void OnDestroy()
        {
            terrain?.Dispose(); city?.Dispose(); units?.Dispose(); fx?.Dispose(); fog?.Dispose(); marks?.Dispose();
            net?.Dispose();
            session?.World.Dispose();
        }

        void OnApplicationQuit() { if (phase != Phase.Stress) SocialPlatform.Current.Shutdown(); }

        // ------------------------------------------------------------------ interface (minimal; UI Toolkit HUD arrives in M6)
        GUIStyle title, label, small, button, field, panel;
        string hudText = "", diagText = "";
        float hudAt;

        void Styles()
        {
            if (title != null) return;
            title = new GUIStyle(GUI.skin.label) { fontSize = 46, alignment = TextAnchor.MiddleCenter, normal = { textColor = new Color(0.93f, 0.9f, 0.82f) } };
            label = new GUIStyle(GUI.skin.label) { fontSize = 15, normal = { textColor = new Color(0.92f, 0.9f, 0.84f) } };
            small = new GUIStyle(GUI.skin.label) { fontSize = 12, wordWrap = true, normal = { textColor = new Color(0.8f, 0.83f, 0.8f) } };
            button = new GUIStyle(GUI.skin.button) { fontSize = 15, fixedHeight = 34 };
            field = new GUIStyle(GUI.skin.textField) { fontSize = 14, fixedHeight = 26 };
            var bg = new Texture2D(1, 1); bg.SetPixel(0, 0, new Color(0.07f, 0.11f, 0.12f, 0.82f)); bg.Apply();
            panel = new GUIStyle(GUI.skin.box) { normal = { background = bg } };
        }

        void OnGUI()
        {
            Styles();
            if (phase == Phase.Menu || phase == Phase.Connecting) { Menu(); return; }
            if (time > hudAt) { hudAt = time + 0.25f; BuildTexts(); }
            if (!hideUi && phase == Phase.Playing)
            {
                GUI.Box(new Rect(0, 0, Screen.width, 32), GUIContent.none, panel);
                GUI.Label(new Rect(10, 6, Screen.width - 240, 24), hudText, small);
                var social = SocialPlatform.Current;
                if (social.Available && net?.SessionMatch != null && GUI.Button(new Rect(Screen.width - 170, 2, 160, 28), "Invite friends")) social.InviteFriends(net.SessionMatch, "");
                if (commander.Dragging(out var r)) GUI.Box(new Rect(r.x, Screen.height - r.yMax, r.width, r.height), GUIContent.none);
                if (time < commander.FeedbackUntil) GUI.Label(new Rect(Screen.width / 2 - 250, Screen.height - 70, 500, 24), commander.Feedback, label);
                if (InputFacade.Alt && rts.TryGround(InputFacade.MousePosition, out var gp))
                {
                    // tile details only while Alt is held
                    int t = session.World.Grid.TileAt(gp.x, gp.z);
                    if (t >= 0) GUI.Label(new Rect(InputFacade.MousePosition.x + 16, Screen.height - InputFacade.MousePosition.y, 260, 22), TileName(t), small);
                }
            }
            if (showDiag || phase == Phase.Stress)
            {
                GUI.Box(new Rect(8, 40, 430, 250), GUIContent.none, panel);
                GUI.Label(new Rect(16, 46, 420, 240), diagText, small);
            }
        }

        static readonly string[] Biomes = { "Deep sea", "Shallows", "Grassland", "Plains", "Forest", "Desert", "Tundra", "Marsh", "Hills", "Mountains", "Peaks", "Lava fields", "Ash waste" };
        string TileName(int t)
        {
            var w = session.World;
            string b = w.Biome[t] < Biomes.Length ? Biomes[w.Biome[t]] : "Unknown";
            if (w.IsLake(t)) b = "Lake"; else if (w.IsRiver(t)) b += ", river";
            return b;
        }

        void BuildTexts()
        {
            var sb = new StringBuilder(256);
            if (session.Econ?["res"] is JObject res)
            {
                var rates = session.Econ["rates"] as JObject;
                foreach (var p in res.Properties())
                {
                    float rate = ProtocolDecoder.Float(rates?[p.Name]);
                    sb.Append(p.Name).Append(' ').Append(Mathf.RoundToInt(ProtocolDecoder.Float(p.Value)));
                    if (Mathf.Abs(rate) >= 0.05f) sb.Append(rate > 0 ? " +" : " ").Append(rate.ToString("0.#"));
                    sb.Append("    ");
                }
            }
            else sb.Append(session.StatusText);
            hudText = sb.ToString();
            sb.Clear();
            var f = recent.Frames;
            sb.Append("FPS ").Append((1000.0 / Mathf.Max(0.01f, (float)f.Average())).ToString("0")).Append("   frame p50 ").Append(f.Percentile(0.5).ToString("0.0"))
              .Append(" p95 ").Append(f.Percentile(0.95).ToString("0.0")).Append(" p99 ").Append(f.Percentile(0.99).ToString("0.0")).Append(" ms   stalls>100ms ").Append(recent.Over100).Append('\n');
            sb.Append("units ").Append(session.Units.Count).Append(" drawn ").Append(units.Drawn).Append(" instances ").Append(units.Instances)
              .Append("   buildings ").Append(session.Structures.Buildings.Count).Append(" cells ").Append(city.CellCount).Append('\n');
            sb.Append("terrain chunks built ").Append(terrain.ChunksBuilt).Append(" dirty ").Append(terrain.DirtyCount).Append(" drawn ").Append(terrain.DrawnChunks)
              .Append("   particles ").Append(fx.Live).Append('\n');
            sb.Append("camera ").Append(rts.Distance.ToString("0")).Append("   snapshots ").Append(session.Snapshots).Append(" apply ").Append(session.ApplyMs.ToString("0.00")).Append(" ms\n");
            if (net != null)
            {
                sb.Append("net ").Append(net.State).Append(" proto ").Append(net.ProtocolVersion).Append(" [").Append(string.Join(",", net.Capabilities)).Append("] rtt ").Append(net.RttMs.ToString("0")).Append(" ms\n");
                sb.Append("backlog ").Append(net.Link.Backlog).Append(" decode ").Append(net.Link.LastDecodeMs.ToString("0.0")).Append(" ms  in ").Append((net.Link.BytesIn / 1048576.0).ToString("0.0")).Append(" MB\n");
                sb.Append("commands in flight ").Append(net.Commands.InFlight).Append("  ack p95 ").Append(net.Commands.AckMs.Percentile(0.95).ToString("0")).Append(" ms  timeouts ").Append(net.Commands.Timeouts).Append('\n');
            }
            if (stress != null) sb.Append(menuStatus).Append('\n');
            sb.Append("GPU ").Append(SystemInfo.graphicsDeviceName).Append("  F3 diagnostics  F10 hide UI");
            diagText = sb.ToString();
        }

        void Menu()
        {
            float w = 420, x = (Screen.width - w) / 2, y = Screen.height * 0.16f;
            GUI.Box(new Rect(0, 0, Screen.width, Screen.height), GUIContent.none, panel);
            GUI.Label(new Rect(0, y, Screen.width, 60), "SHATTERED EMPIRES", title);
            y += 80;
            GUI.Label(new Rect(x, y, w, 22), "Server", label); y += 24;
            serverUrl = GUI.TextField(new Rect(x, y, w, 26), serverUrl, field); y += 30;
            if (GUI.Button(new Rect(x, y, w / 2 - 4, 24), "Public server")) serverUrl = LaunchOptions.PublicServer;
            if (GUI.Button(new Rect(x + w / 2 + 4, y, w / 2 - 4, 24), "Local server")) serverUrl = LaunchOptions.LocalServer;
            y += 32;
            GUI.Label(new Rect(x, y, w, 22), "Name", label); y += 24;
            playerName = GUI.TextField(new Rect(x, y, w, 26), playerName, field); y += 40;
            GUI.enabled = phase == Phase.Menu;
            if (GUI.Button(new Rect(x, y, w, 34), "Campaign against the AI", button)) StartMatch("ai", ""); y += 40;
            if (GUI.Button(new Rect(x, y, w, 34), "Watch AI empires", button)) StartMatch("observe", ""); y += 40;
            if (GUI.Button(new Rect(x, y, w, 34), "Return to my last match", button)) StartMatch("rejoin", ""); y += 40;
            if (GUI.Button(new Rect(x, y, w, 34), "Combat sandbox (1,000 units)", button)) { battleKey = "massive"; opts = LaunchOptions.Parse(new[] { "", "-battle", "massive" }); StartMatch("sandbox", ""); }
            y += 40;
            joinCode = GUI.TextField(new Rect(x, y, w * 0.6f, 30), joinCode, field);
            if (GUI.Button(new Rect(x + w * 0.62f, y, w * 0.38f, 30), "Join match code")) StartMatch("join", joinCode.Trim().ToLowerInvariant());
            y += 40;
            if (GUI.Button(new Rect(x, y, w, 34), "Performance stress scene", button)) StartStress(); y += 40;
            if (GUI.Button(new Rect(x, y, w, 34), "Quit", button)) Application.Quit(); y += 44;
            GUI.enabled = true;
            if (phase == Phase.Connecting && GUI.Button(new Rect(x, y, w, 28), "Cancel")) { net?.Close(); phase = Phase.Menu; menuStatus = ""; }
            y += 32;
            var social = SocialPlatform.Current;
            GUI.Label(new Rect(x, y, w, 60), menuStatus + (social.Available ? "\n" + social.Status : ""), small);
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
