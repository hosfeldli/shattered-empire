using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.Stress;
using SE.Core.World;
using SE.Runtime.Audio;
using SE.Runtime.CameraControl;
using SE.Runtime.Cities;
using SE.Runtime.Effects;
using SE.Runtime.Input;
using SE.Runtime.Session;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.App
{
    /// <summary>
    /// The opening cinematic (visual design bible §3–5): eight beats of about six seconds, rendered in the
    /// engine with the game's own assets over a generated world.
    ///
    ///  1 The World Before — a modern city at dusk, windows lighting the streets.
    ///  2 The Catastrophe — three bright trails, distant flashes, a delayed shock, the light goes.
    ///  3 The Long Winter — the same skyline as ruins under falling ash.
    ///  4 The World Returns — rain, then green: the ruins overgrown, the light warming.
    ///  5 The Reclamation — a secured headquarters in a valley; troops on the road; a flag.
    ///  6 The Rival Empires — a fortified neighbour; tanks rolling toward the border.
    ///  7 The Warning — a silent missile silo; one red beacon. Nothing launches.
    ///  8 Shattered Empires — the valley at dawn, and the title.
    ///
    /// Shots 1–4 share the same city and framing so the change reads as one history. Captions only (no
    /// narration needed), letterboxed, graded; Space, Enter or Escape skips at once and nothing keeps running.
    /// </summary>
    public sealed class IntroDirector
    {
        sealed class Shot
        {
            public float Seconds = 6f;
            public string Caption;
            public float3 From, To;
            public float D0, D1, Yaw0, Yaw1, Pitch;
            public float Dim = 1f, Elevation = 40f, Azimuth = -32f, Tint;
            public Color Sun = Color.white, Ambient = Color.white;
            public float Rain, Cloud, Ash;
            public Action Enter;
            public Action<float> Tick;
        }

        readonly ClientSession session;
        readonly RtsCamera cam;
        readonly Atmosphere atmosphere;
        readonly EffectsRenderer fx;
        readonly AudioDirector audio;
        readonly CityRenderer cityView;
        readonly VisualElement overlay;
        readonly Label caption, title, subtitle, skip;
        readonly VisualElement fade;
        readonly List<Shot> shots = new List<Shot>();
        readonly List<float3> fires = new List<float3>();
        readonly List<int> roadA = new List<int>(), roadB = new List<int>();
        readonly List<BuildingRecord> city = new List<BuildingRecord>(), valley = new List<BuildingRecord>(), rival = new List<BuildingRecord>();
        readonly List<BuildingRecord> strategic = new List<BuildingRecord>();
        readonly List<Vector2[]> sceneRoads = new List<Vector2[]>();
        readonly Dictionary<int, Vector2[]> militaryApproaches = new Dictionary<int, Vector2[]>();
        readonly List<int> cityTiles = new List<int>();
        int shot = -1, nextId = 1;
        float t, fireAt, snapAt;
        bool struck1, struck2, struck3;
        readonly bool[] incoming = new bool[3];
        float3 cityP, siloP;
        public bool Done { get; private set; }
        public int Beat => shot;
        public float BeatProgress => shot >= 0 && shot < shots.Count ? Mathf.Clamp01(t / shots[shot].Seconds) : 0;
        public event Action Finished;
        WeatherState weather;
        HexGrid g;
        WorldModel w;

        public IntroDirector(ClientSession s, RtsCamera c, Atmosphere a, EffectsRenderer e, AudioDirector au, CityRenderer cities, VisualElement uiRoot)
        {
            session = s; cam = c; atmosphere = a; fx = e; audio = au; cityView = cities;
            overlay = new VisualElement(); overlay.AddToClassList("se-root"); overlay.pickingMode = PickingMode.Ignore;
            var top = new VisualElement(); top.AddToClassList("letterbox"); top.style.top = 0; overlay.Add(top);
            var bottom = new VisualElement(); bottom.AddToClassList("letterbox"); bottom.style.bottom = 0; overlay.Add(bottom);
            caption = new Label(""); caption.AddToClassList("caption"); overlay.Add(caption);
            title = new Label("SHATTERED EMPIRES"); title.AddToClassList("menu-title"); title.style.position = Position.Absolute; title.style.left = 0; title.style.right = 0; title.style.top = new Length(38, LengthUnit.Percent); title.style.fontSize = 84; title.style.opacity = 0; overlay.Add(title);
            subtitle = new Label("Reclaim the ruins. Command an empire."); subtitle.AddToClassList("menu-sub"); subtitle.style.position = Position.Absolute; subtitle.style.left = 0; subtitle.style.right = 0; subtitle.style.top = new Length(52, LengthUnit.Percent); subtitle.style.opacity = 0; overlay.Add(subtitle);
            fade = new VisualElement(); fade.AddToClassList("fade"); fade.pickingMode = PickingMode.Ignore; overlay.Add(fade);
            skip = new Label("Space · Enter · Esc to skip"); skip.AddToClassList("skip"); overlay.Add(skip);
            uiRoot.Add(overlay);
        }

        // ------------------------------------------------------------------ the set
        public void Start()
        {
            var gen = StressWorld.Generate(128, 11);
            session.ApplyWelcome(new WelcomeMessage
            {
                W = 128, H = 128, Wrap = true, CivId = 0, Seed = 11, Match = "intro", Ruleset = "native-v4",
                Civs = new[] { new CivInfo { Id = 0, Name = "Survivors", Color = 0x7a8a5a, Human = true }, new CivInfo { Id = 1, Name = "Ashfall Directorate", Color = 0x9a4a3a } },
            });
            session.ApplyGeo(gen.Geo);
            w = session.World; g = w.Grid;
            for (int i = 0; i < w.Visible.Length; i++) w.Visible[i] = 0xff;
            w.ApplyVisibility(w.Visible);
            session.Age = 0;

            // the city of the world before, on a coast: towers, a centre, markets, streets
            int coast = DryDistrict(FindCoastalLand());
            cityP = Centre(coast, 0);
            BuildModernCity(coast);
            // the valley of shot 5 and 8: a modest settlement, fields, a gravel road
            int valleyT = DryDistrict(Walk(Walk(coast, 0, 12), 5, 3));
            BuildMilitaryDistrict(valleyT, 0, 1, valley);
            for (int t2 = Walk(valleyT, 3, 5), k = 0; k < 10; k++) { roadA.Add(t2); int n = g.Nb[t2 * 6 + 0]; if (n < 0 || w.IsSea(n)) break; Road(t2, 0, 1); t2 = n; }
            // the rival's industrial town and its border road (shot 6)
            int rivalT = DryDistrict(Walk(Walk(valleyT, 1, 9), 0, 4));
            BuildMilitaryDistrict(rivalT, 1, 2, rival);
            for (int t2 = Walk(rivalT, 3, 1), k = 0; k < 12; k++) { roadB.Add(t2); int n = g.Nb[t2 * 6 + 3]; if (n < 0 || w.IsSea(n)) break; Road(t2, 3, 2); t2 = n; }
            // the silo in a quiet, damaged industrial place (shot 7)
            int siloT = DryDistrict(Walk(Walk(coast, 4, 6), 5, 4));
            siloP = Centre(siloT, 0);
            var silo = MilitaryBuilding(siloT, "missile_silo", 1, 3);
            strategic.Add(silo);
            w.MarkRoadsChanged();
            w.ApplyUrban(w.Urban);
            Stage(city, valley, rival, strategic);
            cityView.SetShowcaseRoads(sceneRoads);

            var valleyP = Centre(valleyT, 0); var rivalP = Centre(rivalT, 0);
            var dusk = new Color(1f, 0.58f, 0.34f); var dawn = new Color(1f, 0.74f, 0.52f); var grey = new Color(0.72f, 0.74f, 0.78f);
            // 1 — The World Before
            shots.Add(new Shot { Caption = "There was a world before.", From = cityP + new float3(-1, 0, 1), To = cityP + new float3(-.3f, 0, .3f), D0 = 12, D1 = 9, Yaw0 = 20, Yaw1 = 30, Pitch = 29,
                Dim = 0.9f, Elevation = 14, Azimuth = -62, Tint = 0.65f, Sun = dusk, Ambient = new Color(0.95f, 0.85f, 0.83f), Cloud = 0.25f });
            // 2 — The Catastrophe
            shots.Add(new Shot { Caption = "And then, in a single generation, it was broken.", From = cityP + new float3(-.3f, 0, .3f), To = cityP + new float3(-.3f, 0, .3f), D0 = 9, D1 = 12, Yaw0 = 30, Yaw1 = 34, Pitch = 29,
                Dim = 0.7f, Elevation = 6, Azimuth = -66, Tint = 0.9f, Sun = dusk, Ambient = new Color(0.75f, 0.62f, 0.62f), Cloud = 0.35f, Enter = () => { struck1 = struck2 = struck3 = false; Array.Clear(incoming, 0, incoming.Length); }, Tick = Catastrophe });
            // 3 — The Long Winter (same skyline, ruined)
            shots.Add(new Shot { Caption = "The skies darkened. The old nations disappeared.", From = cityP + new float3(-.3f, 0, .3f), To = cityP + new float3(.6f, 0, .5f), D0 = 12, D1 = 9, Yaw0 = 34, Yaw1 = 42, Pitch = 29,
                Dim = 0.65f, Elevation = 22, Tint = 0.5f, Sun = grey, Ambient = new Color(0.72f, 0.74f, 0.78f), Cloud = 0.95f, Ash = 0.8f, Enter = Ruin });
            // 4 — The World Returns
            shots.Add(new Shot { Caption = "But the world did not end.", From = cityP + new float3(.6f, 0, .5f), To = cityP + new float3(1.0f, 0, .7f), D0 = 9, D1 = 13, Yaw0 = 42, Yaw1 = 48, Pitch = 29,
                Dim = 0.85f, Elevation = 30, Tint = 0.3f, Sun = new Color(0.95f, 0.92f, 0.85f), Ambient = new Color(0.9f, 0.92f, 0.9f), Cloud = 0.5f, Rain = 0.6f, Enter = Regrow, Tick = Clearing });
            // 5 — The Reclamation
            shots.Add(new Shot { Caption = "From the ruins, your people began again.", From = valleyP + new float3(-2, 0, 1.5f), To = valleyP + new float3(-.4f, 0, .4f), D0 = 17, D1 = 10, Yaw0 = -35, Yaw1 = -15, Pitch = 30,
                Dim = 1f, Elevation = 14, Azimuth = 70, Tint = 0.6f, Sun = dawn, Ambient = new Color(0.95f, 0.9f, 0.85f), Cloud = 0.25f, Tick = u => Column(roadA, 0, u, new[] { "engineer", "rifle_squad", "rifle_squad" }) });
            // 6 — The Rival Empires
            shots.Add(new Shot { Caption = "And every empire sought a future of its own.", From = rivalP + new float3(.5f, 0, .5f), To = rivalP + new float3(-.7f, 0, .1f), D0 = 7.4f, D1 = 6.1f, Yaw0 = 100, Yaw1 = 115, Pitch = 26,
                Dim = 0.85f, Elevation = 28, Azimuth = 10, Tint = 0.35f, Sun = new Color(0.85f, 0.88f, 0.95f), Ambient = new Color(0.8f, 0.82f, 0.9f), Cloud = 0.55f,
                Tick = u => Column(roadB, 1, u, new[] { "tank", "tank", "tank", "rifle_squad", "rifle_squad" }) });
            // 7 — The Warning
            shots.Add(new Shot { Caption = "And the power to destroy it all remained.", From = siloP + new float3(-2, 0, 2), To = siloP + new float3(-0.6f, 0, 0.6f), D0 = 9, D1 = 5.5f, Yaw0 = 30, Yaw1 = 34, Pitch = 22,
                Dim = 0.65f, Elevation = 25, Tint = 0.45f, Sun = grey, Ambient = new Color(0.7f, 0.72f, 0.76f), Cloud = 0.85f, Tick = Beacon });
            // 8 — Shattered Empires
            shots.Add(new Shot { Seconds = 8f, Caption = "", From = valleyP, To = valleyP + new float3(5, 0, -3), D0 = 18, D1 = 95, Yaw0 = -15, Yaw1 = 8, Pitch = 34,
                Dim = 1f, Elevation = 12, Azimuth = 75, Tint = 0.55f, Sun = dawn, Cloud = 0.3f, Tick = TitleCard });
            weather = new WeatherState { CellsW = 1, CellsH = 1, Cell = 1024, Cloud = new byte[1], Rain = new byte[1], Wet = new byte[1], Fog = new byte[1], Storm = new byte[1], WindAngle = 0.5f, WindSpeed = 0.5f };
            atmosphere.Grain.intensity.Override(.035f);
            cam.UserControl = false;
            audio?.PlayMusic(true);
            shot = 0; t = 0;
            shots[0].Enter?.Invoke();
        }

        BuildingRecord Building(int tile, string type, int owner, int level, int era) =>
            new BuildingRecord { Id = nextId++, Owner = owner, Type = type, Tile = tile, Hp = 100, Done = true, Active = true, Progress = 100, Level = level, Era = era, State = "ok" };

        void BuildModernCity(int center)
        {
            var origin = new Vector2(g.CenterX(center), g.CenterZ(center));
            Vector2 P(float x, float z) => origin + new Vector2(x, z);
            sceneRoads.Add(new[] { P(-4.1f, -.85f), P(-2, -.43f), P(0, 0), P(1.9f, .40f), P(4, 1.0f) });
            sceneRoads.Add(new[] { P(-1.1f, -3.1f), P(-.54f, -1.4f), P(0, 0), P(.65f, 1.6f), P(.9f, 3.2f) });
            for (int i = 0; i < 9; i++) for (int side = -1; side <= 1; side += 2)
            {
                float x = -3.35f + i * .83f;
                var point = P(x - side * .13f, x * .22f + side * .69f);
                if (Mathf.Abs(point.x - origin.x - (point.y - origin.y) * .38f) < .44f) continue;
                int tile = g.TileAt(point.x, point.y);
                if (tile < 0 || w.IsSea(tile) || w.IsLake(tile) || w.IsRiver(tile)) continue;
                var b = Building(tile, i % 4 == 0 ? "modern_office" : "modern_block", 0, 2 + (i * 3 + (side > 0 ? 1 : 0)) % 5, 2);
                b.HasPosition = b.HasYaw = true; b.X = point.x; b.Z = point.y;
                b.Yaw = Mathf.Atan2(side * .22f, -side); b.Slot = b.Id;
                city.Add(b); if (!cityTiles.Contains(tile)) cityTiles.Add(tile); SetUrban(tile, true);
            }
        }

        void BuildMilitaryDistrict(int center, int owner, int tier, List<BuildingRecord> buildings)
        {
            var origin = new Vector2(g.CenterX(center), g.CenterZ(center));
            var hq = MilitaryBuilding(center, "town", owner, tier); hq.Yaw = .52f; buildings.Add(hq); SetUrban(center, true);
            string[] types = { "barracks", "depot", "power_plant", "armory", "motor_works", "airfield" };
            var loop = new Vector2[9];
            for (int i = 0; i < 8; i++)
            {
                float angle = .52f + i * math.PI / 4, radius = 1.91f + math.sin(i * 2.7f) * .09f;
                var radial = new Vector2(math.sin(angle) * 1.04f, math.cos(angle) * .97f);
                var point = origin + radial * radius; loop[i] = origin + radial * radius * .57f;
                int ordinal = i % 2 == 0 ? i / 2 : i == 1 ? 4 : i == 5 ? 5 : 9;
                if (ordinal >= (tier == 1 ? 4 : 6)) continue;
                int tile = g.TileAt(point.x, point.y); if (tile < 0 || w.IsSea(tile) || w.IsLake(tile)) continue;
                var b = MilitaryBuilding(tile, types[ordinal], owner, tier);
                b.X = point.x; b.Z = point.y; b.Yaw = Mathf.Atan2(-radial.x, -radial.y); b.Slot = b.Id;
                buildings.Add(b); SetUrban(tile, true);
                sceneRoads.Add(new[] { loop[i], point - radial.normalized * .45f });
            }
            loop[8] = loop[0]; sceneRoads.Add(loop);
            float gapAngle = .52f + math.PI / 8;
            var gap = new Vector2(math.sin(gapAngle), math.cos(gapAngle));
            var approach = new[] { origin + gap * 5.0f, origin + gap * 3.0f, origin + gap * 1.03f };
            sceneRoads.Add(approach); militaryApproaches[owner] = approach;
        }

        BuildingRecord MilitaryBuilding(int tile, string type, int owner, int tier)
        {
            var b = Building(tile, type, owner, 1, 1);
            b.HasPosition = b.HasYaw = b.Active = true; b.X = g.CenterX(tile); b.Z = g.CenterZ(tile);
            b.Yaw = math.PI / 6; b.Tier = tier; return b;
        }

        void Road(int t2, int d, int cls)
        {
            int n = g.Nb[t2 * 6 + d]; if (n < 0 || w.IsSea(t2) || w.IsSea(n) || w.IsLake(t2) || w.IsLake(n)) return;
            int back = (d + 3) % 6;
            w.Road[t2] = (w.Road[t2] & ~(15 << (d * 4))) | (cls << (d * 4));
            w.Road[n] = (w.Road[n] & ~(15 << (back * 4))) | (cls << (back * 4));
        }

        void SetUrban(int t2, bool on) { if (on) w.Urban[t2 >> 3] |= (byte)(1 << (t2 & 7)); else w.Urban[t2 >> 3] &= (byte)~(1 << (t2 & 7)); }

        void Stage(params List<BuildingRecord>[] sets)
        {
            var all = new List<BuildingRecord>();
            foreach (var s in sets) all.AddRange(s);
            var dirty = new HashSet<int>();
            session.Structures.ApplyBuildings(all.ToArray(), w, dirty);
            foreach (var c in dirty) session.DirtyCells.Add(c);
        }

        // ------------------------------------------------------------------ beat actions
        void Catastrophe(float u)
        {
            // three bright trails cross the distant sky; flashes; a delayed shock that pushes dust over the roofs
            void Strike(ref bool done, int index, float at, float3 offset)
            {
                var target = cityP + offset; target.y = w.GroundHeight(target.x, target.z) + .04f;
                if (!incoming[index] && u >= at - .16f)
                {
                    incoming[index] = true;
                    fx.Projectile(target + new float3(-7, 14, -5), target, "warhead", .96f);
                }
                if (done || u < at) return;
                done = true;
                fx.Strategic(target, .31f);
                audio?.Play("strategic", target, 1f, 60f, 5, cam.Distance);
            }
            Strike(ref struck1, 0, .25f, new float3(5, 0, -4));
            Strike(ref struck2, 1, .45f, new float3(-4, 0, -5));
            Strike(ref struck3, 2, .65f, new float3(1, 0, -7));
            atmosphere.Dim = Mathf.Lerp(0.7f, 0.35f, Mathf.Clamp01((u - 0.6f) / 0.4f));
        }

        void Ruin()
        {
            // the same city, long afterwards: shells of towers, roads broken, a few fires
            fx.ClearPersistent();
            var rng = new System.Random(9);
            for (int i = 0; i < city.Count; i++)
            {
                var b = city[i]; b.State = "ruin"; b.Hp = 10; b.Active = false; city[i] = b;
                if (rng.NextDouble() < 0.2) fires.Add(Centre(b.Tile, 0.1f));
            }
            foreach (var t2 in cityTiles) { SetUrban(t2, false); for (int d = 0; d < 6; d++) if (((w.Road[t2] >> (d * 4)) & 7) != 0 && rng.NextDouble() < 0.6) w.Road[t2] |= 8 << (d * 4); }
            w.MarkRoadsChanged(); w.ApplyUrban(w.Urban);
            session.Ruins = Array.Empty<RuinRecord>(); session.RuinRevision++;
            cityView.SetShowcaseDamage(1);
            Stage(city, valley, rival, strategic);
        }

        void Regrow()
        {
            // vegetation returns: the ruins overgrown, the fires out
            var ruins = session.Ruins;
            for (int i = 0; i < ruins.Length; i++) ruins[i].Flags |= 4;
            session.Ruins = (RuinRecord[])ruins.Clone(); session.RuinRevision++;
            for (int i = 0; i < city.Count; i++) { var b = city[i]; b.State = "overgrown"; city[i] = b; }
            cityView.SetShowcaseDamage(.7f); Stage(city, valley, rival, strategic);
            fires.Clear();
        }

        void Clearing(float u)
        {
            // rain eases to sun across the shot
            weather.Rain[0] = (byte)(Mathf.Clamp01(0.6f - u * 0.9f) * 255);
            atmosphere.Dim = Mathf.Lerp(0.75f, 1f, u);
        }

        void Column(List<int> path, int owner, float u, string[] types)
        {
            if (militaryApproaches.TryGetValue(owner, out var route)) { MilitaryColumn(route, owner, u, types); return; }
            if (path.Count < 2 || Time.unscaledTime < snapAt) return;
            snapAt = Time.unscaledTime + 0.2f;
            var list = new List<UnitWire>();
            float along = 2.1f + u * 1.2f;
            for (int k = 0; k < types.Length; k++)
            {
                float p = Mathf.Max(0, along - k * .48f);
                int i = Mathf.Min(path.Count - 2, (int)p);
                int enter = -1, exit = -1;
                for (int d = 0; d < 6; d++) { int n = g.Nb[path[i] * 6 + d]; if (n == path[i + 1]) exit = d; if (i > 0 && n == path[i - 1]) enter = d; }
                if (enter < 0) enter = (exit + 3) % 6;
                RoadCurve.Route(w, path[i], enter, exit, Mathf.Clamp01(p - i), out float x, out float z, out float yaw);
                list.Add(new UnitWire { Id = 100 + owner * 20 + k, Owner = owner, Type = types[k], Tile = path[i], Next = -1, Hp = 100,
                    AirState = -1, AirMission = -1, AirMissionTile = -1,
                    Motion = new WorldMotion { Present = true, X = x, Z = z, Yaw = yaw, Vx = math.sin(yaw) * .35f, Vz = math.cos(yaw) * .35f } });
            }
            session.ApplySnapshot(new SnapshotMessage { Time = Time.unscaledTime, Units = list.ToArray() });
        }

        void MilitaryColumn(Vector2[] route, int owner, float progress, string[] types)
        {
            if (Time.unscaledTime < snapAt) return; snapAt = Time.unscaledTime + .16f;
            var actors = new UnitWire[types.Length];
            var direction = (route[2] - route[0]).normalized;
            for (int i = 0; i < actors.Length; i++)
            {
                float t = Mathf.Clamp01(.42f + progress * .30f - i * .13f);
                var p = Vector2.Lerp(route[0], route[2], t);
                actors[i] = new UnitWire { Id = 100 + owner * 20 + i, Owner = owner, Type = types[i], Tile = g.TileAt(p.x, p.y), Next = -1, Hp = 100, AirState = -1,
                    Motion = new WorldMotion { Present = true, X = p.x, Z = p.y, Yaw = Mathf.Atan2(direction.x, direction.y), Vx = direction.x * .20f, Vz = direction.y * .20f } };
            }
            session.ApplySnapshot(new SnapshotMessage { Time = Time.unscaledTime, Units = actors });
        }

        void Beacon(float u)
        {
            // one red warning light, pulsing; the silence is the point
            float pulse = Mathf.Pow(.5f + .5f * Mathf.Sin(u * math.PI * 4), 2);
            if (pulse > .1f) fx.WarningBeacon(siloP + new float3(.32f, .46f, -.16f), pulse);
        }

        void TitleCard(float u)
        {
            title.style.opacity = Mathf.Clamp01((u - 0.35f) / 0.25f);
            subtitle.style.opacity = Mathf.Clamp01((u - 0.55f) / 0.25f);
        }

        // ------------------------------------------------------------------ playback
        public void Update(float dt)
        {
            if (Done || shot < 0) return;
            if (InputFacade.Pressed(KeyCode.Escape) || InputFacade.Pressed(KeyCode.Space) || InputFacade.Pressed(KeyCode.Return)) { Finish(); return; }
            var s = shots[shot];
            t += dt;
            float u = Mathf.Clamp01(t / s.Seconds), e = Mathf.SmoothStep(0, 1, u);
            cam.Focus = Vector3.Lerp(s.From, s.To, e);
            cam.Distance = cam.TargetDistance = Mathf.Lerp(s.D0, s.D1, e);
            cam.Yaw = Mathf.Lerp(s.Yaw0, s.Yaw1, e);
            cam.PitchOverride = s.Pitch;
            cam.Apply();
            atmosphere.Dim = s.Dim; atmosphere.SunElevation = s.Elevation; atmosphere.SunAzimuth = s.Azimuth;
            atmosphere.SunTint = s.Sun; atmosphere.SunTintAmount = s.Tint; atmosphere.AmbientTint = s.Ambient;
            weather.Cloud[0] = (byte)(s.Cloud * 255); weather.Rain[0] = (byte)(s.Rain * 255); weather.Wet[0] = (byte)(s.Rain * 255);
            session.Weather = weather; session.WeatherRevision++;
            fireAt -= dt;
            if (fireAt <= 0)
            {
                fireAt = 0.12f;
                foreach (var f in fires) fx.Fire(f, 0.25f);
                if (s.Ash > 0) fx.Rain(new float3(cam.Focus.x, 0, cam.Focus.z), s.Ash * 0.25f, new float3(0.2f, 0, 0.1f), (x, z) => w.GroundHeight(x, z), 8f);
            }
            s.Tick?.Invoke(u);
            // captions fade in after the shot settles and out before the cut; shots 1–4 dissolve into one
            // another (one continuous history), later shots cut through a brief black
            float cIn = Mathf.Clamp01((t - 0.8f) / 1.0f), cOut = Mathf.Clamp01((s.Seconds - t - 0.4f) / 0.8f);
            caption.text = s.Caption;
            caption.style.opacity = Mathf.Min(cIn, cOut);
            float edge = Mathf.Min(t, s.Seconds - t);
            float cut = shot < 3 ? 0.35f : 0.9f;
            fade.style.opacity = shot == 0 && t < 2f ? 1f - t / 2f : Mathf.Clamp01(1f - edge / 0.5f) * cut;
            if (t >= s.Seconds)
            {
                shot++; t = 0;
                if (shot >= shots.Count) { Finish(); return; }
                shots[shot].Enter?.Invoke();
            }
        }

        void Finish()
        {
            if (Done) return;
            Done = true;
            overlay.RemoveFromHierarchy();
            atmosphere.Grain.intensity.Override(0f);
            atmosphere.Dim = 1f; atmosphere.SunTintAmount = 0f; atmosphere.SunElevation = 47f; atmosphere.SunAzimuth = -32f; atmosphere.AmbientTint = Color.white;
            cam.PitchOverride = -1f; cam.UserControl = true;
            audio?.PlayMusic(false);
            PlayerPrefs.SetInt("se.intro.seen", 1);
            Finished?.Invoke();
        }

        // ------------------------------------------------------------------ helpers
        IEnumerable<int> Disk(int c, int r)
        {
            var seen = new HashSet<int> { c }; var front = new List<int> { c };
            yield return c;
            for (int k = 0; k < r; k++)
            {
                var next = new List<int>();
                foreach (var x in front) for (int d = 0; d < 6; d++) { int n = g.Nb[x * 6 + d]; if (n >= 0 && seen.Add(n)) { next.Add(n); } }
                foreach (var n in next) yield return n;
                front = next;
            }
        }

        int Walk(int t0, int dir, int steps) { for (int k = 0; k < steps; k++) { int n = g.Nb[t0 * 6 + dir]; if (n >= 0 && !w.IsSea(n)) t0 = n; } return t0; }

        int FindCoastalLand()
        {
            int best = g.N / 2 + g.W / 2; float score = float.MaxValue;
            for (int i = 0; i < g.N; i += 7)
            {
                if (w.IsSea(i) || w.Biome[i] >= 8) continue;
                int sea = 0; for (int d = 0; d < 6; d++) { int n = g.Nb[i * 6 + d]; if (n >= 0 && w.IsSea(n)) sea++; }
                int dry = 0, wet = 0;
                foreach (int t2 in Disk(i, 2)) { if (w.IsSea(t2) || w.IsLake(t2)) wet++; else if (w.Biome[t2] < 8) dry++; }
                if (dry < 14 || wet < 1) continue;
                float candidate = Math.Abs(i / g.W - g.H * .5f) + Math.Abs(i % g.W - g.W * .5f) * .3f + w.Height[i] * 8;
                if (candidate < score) { score = candidate; best = i; }
            }
            return best;
        }

        int DryDistrict(int target)
        {
            int best = target; float score = float.MaxValue;
            foreach (int tile in Disk(target, 6))
            {
                if (w.IsSea(tile) || w.IsLake(tile) || w.Biome[tile] >= 8) continue;
                int dry = 0; foreach (int n in Disk(tile, 2)) if (!w.IsSea(n) && !w.IsLake(n) && w.Biome[n] < 8) dry++;
                float candidate = -dry * 2 + w.Height[tile] * 5 + math.distance(new float2(g.CenterX(tile), g.CenterZ(tile)), new float2(g.CenterX(target), g.CenterZ(target)));
                if (candidate < score) { score = candidate; best = tile; }
            }
            return best;
        }

        void ConnectStreets(int center, List<int> parcels)
        {
            var district = new HashSet<int>(parcels); var linked = new HashSet<int> { center }; var queue = new Queue<int>(); queue.Enqueue(center);
            int[] directions = { 0, 3, 1, 4, 2, 5 };
            while (queue.Count > 0)
            {
                int tile = queue.Dequeue();
                foreach (int d in directions)
                {
                    int n = g.Nb[tile * 6 + d];
                    if (n < 0 || !district.Contains(n) || !linked.Add(n)) continue;
                    Road(tile, d, d == 0 || d == 3 ? 3 : 2); queue.Enqueue(n);
                }
            }
        }

        float3 Centre(int tile, float lift) { float x = g.CenterX(tile), z = g.CenterZ(tile); return new float3(x, w.GroundHeight(x, z) + lift, z); }
    }
}
