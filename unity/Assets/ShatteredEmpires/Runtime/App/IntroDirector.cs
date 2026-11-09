using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.Stress;
using SE.Core.World;
using SE.Runtime.Audio;
using SE.Runtime.CameraControl;
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
    ///  1 The World Before — a living city at dusk, traffic on its roads.
    ///  2 The Catastrophe — three bright trails, distant flashes, a delayed shock, the light goes.
    ///  3 The Long Winter — the same skyline as ruins under falling ash.
    ///  4 The World Returns — rain, then green: the ruins overgrown, the light warming.
    ///  5 The Reclamation — a surviving settlement in a valley; a truck on the gravel road; a flag.
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
        readonly VisualElement overlay;
        readonly Label caption, title, subtitle, skip;
        readonly VisualElement fade;
        readonly List<Shot> shots = new List<Shot>();
        readonly List<float3> fires = new List<float3>();
        readonly List<int> roadA = new List<int>(), roadB = new List<int>();
        readonly List<BuildingRecord> city = new List<BuildingRecord>(), valley = new List<BuildingRecord>(), rival = new List<BuildingRecord>();
        readonly List<int> cityTiles = new List<int>();
        int shot = -1, nextId = 1;
        float t, fireAt, snapAt;
        bool struck1, struck2, struck3;
        float3 cityP, siloP;
        public bool Done { get; private set; }
        public event Action Finished;
        WeatherState weather;
        HexGrid g;
        WorldModel w;

        public IntroDirector(ClientSession s, RtsCamera c, Atmosphere a, EffectsRenderer e, AudioDirector au, VisualElement uiRoot)
        {
            session = s; cam = c; atmosphere = a; fx = e; audio = au;
            overlay = new VisualElement(); overlay.AddToClassList("se-root"); overlay.pickingMode = PickingMode.Ignore;
            var top = new VisualElement(); top.AddToClassList("letterbox"); top.style.top = 0; overlay.Add(top);
            var bottom = new VisualElement(); bottom.AddToClassList("letterbox"); bottom.style.bottom = 0; overlay.Add(bottom);
            caption = new Label(""); caption.AddToClassList("caption"); overlay.Add(caption);
            title = new Label("SHATTERED EMPIRES"); title.AddToClassList("menu-title"); title.style.position = Position.Absolute; title.style.left = 0; title.style.right = 0; title.style.top = new Length(38, LengthUnit.Percent); title.style.fontSize = 84; title.style.opacity = 0; overlay.Add(title);
            subtitle = new Label("Rebuild civilization. Command its future."); subtitle.AddToClassList("menu-sub"); subtitle.style.position = Position.Absolute; subtitle.style.left = 0; subtitle.style.right = 0; subtitle.style.top = new Length(52, LengthUnit.Percent); subtitle.style.opacity = 0; overlay.Add(subtitle);
            fade = new VisualElement(); fade.AddToClassList("fade"); fade.pickingMode = PickingMode.Ignore; overlay.Add(fade);
            skip = new Label("Space · Enter · Esc to skip"); skip.AddToClassList("skip"); overlay.Add(skip);
            uiRoot.Add(overlay);
        }

        // ------------------------------------------------------------------ the set
        public void Start()
        {
            var gen = StressWorld.Generate(192, 11);
            session.ApplyWelcome(new WelcomeMessage
            {
                W = 192, H = 192, Wrap = true, CivId = 0, Seed = 11, Match = "intro", Ruleset = "native-v4",
                Civs = new[] { new CivInfo { Id = 0, Name = "Survivors", Color = 0x7a8a5a, Human = true }, new CivInfo { Id = 1, Name = "Ashfall Directorate", Color = 0x9a4a3a } },
            });
            session.ApplyGeo(gen.Geo);
            w = session.World; g = w.Grid;
            for (int i = 0; i < w.Visible.Length; i++) w.Visible[i] = 0xff;
            w.ApplyVisibility(w.Visible);
            session.Age = 0;

            // the city of the world before, on a coast: towers, a centre, markets, streets
            int coast = FindCoastalLand();
            cityP = Centre(coast, 0);
            var rng = new System.Random(4);
            foreach (int t2 in Disk(coast, 3))
            {
                if (w.IsSea(t2) || w.IsLake(t2) || w.Biome[t2] >= 9) continue;
                cityTiles.Add(t2);
                SetUrban(t2, true);
                for (int d = 0; d < 6; d++) if (rng.NextDouble() < 0.5) Road(t2, d, 2);
                if (rng.NextDouble() < 0.7)
                    city.Add(Building(t2, t2 == coast ? "town" : rng.NextDouble() < 0.7 ? "house" : rng.NextDouble() < 0.5 ? "market" : "power_plant", 0, 3, rng.NextDouble() < 0.6 ? 3 : 2));
            }
            // the valley of shot 5 and 8: a modest settlement, fields, a gravel road
            int valleyT = Walk(Walk(coast, 0, 12), 5, 3);
            foreach (int t2 in Disk(valleyT, 2))
            {
                if (w.IsSea(t2) || w.IsLake(t2) || valley.Count > 9) continue;
                var type = valley.Count == 0 ? "town" : valley.Count < 6 ? "house" : "farm";
                valley.Add(Building(t2, type, 0, 1, 0));
                if (valley.Count < 6) SetUrban(t2, true);
            }
            for (int t2 = Walk(valleyT, 3, 5), k = 0; k < 10; k++) { roadA.Add(t2); int n = g.Nb[t2 * 6 + 0]; if (n < 0 || w.IsSea(n)) break; Road(t2, 0, 1); t2 = n; }
            // the rival's industrial town and its border road (shot 6)
            int rivalT = Walk(Walk(valleyT, 1, 9), 0, 4);
            foreach (int t2 in Disk(rivalT, 2))
            {
                if (w.IsSea(t2) || w.IsLake(t2) || rival.Count > 8) continue;
                string type = rival.Count == 0 ? "fort" : rival.Count < 3 ? "barracks" : rival.Count < 5 ? "steel_mill" : rival.Count < 6 ? "guard_post" : "house";
                rival.Add(Building(t2, type, 1, 1, 2));
                SetUrban(t2, true);
            }
            for (int t2 = Walk(rivalT, 3, 1), k = 0; k < 12; k++) { roadB.Add(t2); int n = g.Nb[t2 * 6 + 3]; if (n < 0 || w.IsSea(n)) break; Road(t2, 3, 2); t2 = n; }
            // the silo in a quiet, damaged industrial place (shot 7)
            int siloT = Walk(Walk(coast, 4, 6), 5, 4);
            siloP = Centre(siloT, 0);
            var silo = Building(siloT, "missile_silo", 1, 1, 3);
            w.MarkRoadsChanged();
            w.ApplyUrban(w.Urban);
            Stage(city, valley, rival, new List<BuildingRecord> { silo });

            var valleyP = Centre(valleyT, 0); var rivalP = Centre(rivalT, 0);
            var dusk = new Color(1f, 0.58f, 0.34f); var dawn = new Color(1f, 0.74f, 0.52f); var grey = new Color(0.72f, 0.74f, 0.78f);
            // 1 — The World Before
            shots.Add(new Shot { Caption = "There was a world before.", From = cityP + new float3(-7, 0, 5), To = cityP + new float3(-3, 0, 2), D0 = 36, D1 = 27, Yaw0 = 20, Yaw1 = 32, Pitch = 24,
                Dim = 0.8f, Elevation = 8, Azimuth = -62, Tint = 0.85f, Sun = dusk, Ambient = new Color(0.85f, 0.75f, 0.78f), Cloud = 0.25f });
            // 2 — The Catastrophe
            shots.Add(new Shot { Caption = "And then, in a single generation, it was broken.", From = cityP + new float3(-3, 0, 2), To = cityP + new float3(-2, 0, 1), D0 = 27, D1 = 24, Yaw0 = 32, Yaw1 = 38, Pitch = 22,
                Dim = 0.7f, Elevation = 6, Azimuth = -66, Tint = 0.9f, Sun = dusk, Ambient = new Color(0.75f, 0.62f, 0.62f), Cloud = 0.35f, Enter = () => { struck1 = struck2 = struck3 = false; }, Tick = Catastrophe });
            // 3 — The Long Winter (same skyline, ruined)
            shots.Add(new Shot { Caption = "The skies darkened. The old nations disappeared.", From = cityP + new float3(-1, 0, 3), To = cityP + new float3(3, 0, 3), D0 = 20, D1 = 18, Yaw0 = 40, Yaw1 = 70, Pitch = 18,
                Dim = 0.5f, Elevation = 22, Tint = 0.5f, Sun = grey, Ambient = new Color(0.62f, 0.64f, 0.68f), Cloud = 0.95f, Ash = 0.8f, Enter = Ruin });
            // 4 — The World Returns
            shots.Add(new Shot { Caption = "But the world did not end.", From = cityP + new float3(2, 0, 3), To = cityP + new float3(4, 0, 6), D0 = 18, D1 = 40, Yaw0 = 70, Yaw1 = 85, Pitch = 26,
                Dim = 0.85f, Elevation = 30, Tint = 0.3f, Sun = new Color(0.95f, 0.92f, 0.85f), Ambient = new Color(0.9f, 0.92f, 0.9f), Cloud = 0.5f, Rain = 0.6f, Enter = Regrow, Tick = Clearing });
            // 5 — The Reclamation
            shots.Add(new Shot { Caption = "From the ruins, your people began again.", From = valleyP + new float3(-5, 0, 4), To = valleyP + new float3(-1, 0, 1), D0 = 30, D1 = 16, Yaw0 = -35, Yaw1 = -15, Pitch = 30,
                Dim = 1f, Elevation = 14, Azimuth = 70, Tint = 0.6f, Sun = dawn, Ambient = new Color(0.95f, 0.9f, 0.85f), Cloud = 0.25f, Tick = u => Column(roadA, 0, u, new[] { "supply_truck", "colonist", "colonist" }) });
            // 6 — The Rival Empires
            shots.Add(new Shot { Caption = "And every empire sought a future of its own.", From = rivalP + new float3(1, 0, 1), To = rivalP + new float3(-3, 0, 0), D0 = 12, D1 = 12, Yaw0 = 100, Yaw1 = 115, Pitch = 16,
                Dim = 0.85f, Elevation = 28, Azimuth = 10, Tint = 0.35f, Sun = new Color(0.85f, 0.88f, 0.95f), Ambient = new Color(0.8f, 0.82f, 0.9f), Cloud = 0.55f,
                Tick = u => Column(roadB, 1, u, new[] { "tank", "tank", "tank", "rifle_squad", "rifle_squad" }) });
            // 7 — The Warning
            shots.Add(new Shot { Caption = "And the power to destroy it all remained.", From = siloP + new float3(-2, 0, 2), To = siloP + new float3(-0.6f, 0, 0.6f), D0 = 9, D1 = 5.5f, Yaw0 = 30, Yaw1 = 34, Pitch = 22,
                Dim = 0.65f, Elevation = 25, Tint = 0.45f, Sun = grey, Ambient = new Color(0.7f, 0.72f, 0.76f), Cloud = 0.85f, Tick = Beacon });
            // 8 — Shattered Empires
            shots.Add(new Shot { Seconds = 8f, Caption = "", From = valleyP, To = valleyP + new float3(5, 0, -3), D0 = 18, D1 = 95, Yaw0 = -15, Yaw1 = 8, Pitch = 34,
                Dim = 1f, Elevation = 12, Azimuth = 75, Tint = 0.55f, Sun = dawn, Cloud = 0.3f, Tick = TitleCard });
            weather = new WeatherState { CellsW = 1, CellsH = 1, Cell = 1024, Cloud = new byte[1], Rain = new byte[1], Wet = new byte[1], Fog = new byte[1], Storm = new byte[1], WindAngle = 0.5f, WindSpeed = 0.5f };
            atmosphere.Grain.intensity.Override(0.3f);
            cam.UserControl = false;
            audio?.PlayMusic(true);
            shot = 0; t = 0;
            shots[0].Enter?.Invoke();
        }

        BuildingRecord Building(int tile, string type, int owner, int level, int era) =>
            new BuildingRecord { Id = nextId++, Owner = owner, Type = type, Tile = tile, Hp = 100, Done = true, Progress = 100, Level = level, Era = era, State = "ok" };

        void Road(int t2, int d, int cls)
        {
            int n = g.Nb[t2 * 6 + d]; if (n < 0) return;
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
            void Strike(ref bool done, float at, float3 offset)
            {
                if (done || u < at) return;
                done = true;
                var target = cityP + offset;
                fx.Tracer(target + new float3(-30, 40, -10), target, true);
                fx.Strategic(target + new float3(0, w.GroundHeight(target.x, target.z), 0), 0.45f);
                audio?.Play("strategic", target, 1f, 60f, 5, cam.Distance);
            }
            Strike(ref struck1, 0.25f, new float3(14, 0, -10));
            Strike(ref struck2, 0.42f, new float3(-12, 0, -14));
            Strike(ref struck3, 0.6f, new float3(3, 0, -18));
            atmosphere.Dim = Mathf.Lerp(0.7f, 0.35f, Mathf.Clamp01((u - 0.6f) / 0.4f));
        }

        void Ruin()
        {
            // the same city, long afterwards: shells of towers, roads broken, a few fires
            var ruins = new List<RuinRecord>();
            var rng = new System.Random(9);
            foreach (var b in city)
            {
                ruins.Add(new RuinRecord { Tile = b.Tile, Type = b.Type == "house" && b.Era >= 2 ? (rng.NextDouble() < 0.5 ? "tower" : "city") : b.Type == "power_plant" ? "plant" : "suburb", Flags = 0 });
                if (rng.NextDouble() < 0.2) fires.Add(Centre(b.Tile, 0.1f));
            }
            foreach (var t2 in cityTiles) { SetUrban(t2, false); for (int d = 0; d < 6; d++) if (((w.Road[t2] >> (d * 4)) & 7) != 0 && rng.NextDouble() < 0.6) w.Road[t2] |= 8 << (d * 4); }
            w.MarkRoadsChanged(); w.ApplyUrban(w.Urban);
            session.Ruins = ruins.ToArray(); session.RuinRevision++;
            city.Clear();
            Stage(valley, rival);
        }

        void Regrow()
        {
            // vegetation returns: the ruins overgrown, the fires out
            var ruins = session.Ruins;
            for (int i = 0; i < ruins.Length; i++) ruins[i].Flags |= 4;
            session.Ruins = (RuinRecord[])ruins.Clone(); session.RuinRevision++;
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
            if (path.Count < 2 || Time.unscaledTime < snapAt) return;
            snapAt = Time.unscaledTime + 0.2f;
            var list = new List<UnitWire>();
            float along = u * (path.Count - 2);
            for (int k = 0; k < types.Length; k++)
            {
                float p = Mathf.Max(0, along - k * 0.6f);
                int i = Mathf.Min(path.Count - 2, (int)p);
                list.Add(new UnitWire { Id = 100 + owner * 20 + k, Owner = owner, Type = types[k], Tile = path[i], Next = path[i + 1], Prog = p - i, Hp = 100, AirState = -1, AirMission = -1, AirMissionTile = -1 });
            }
            session.ApplySnapshot(new SnapshotMessage { Time = Time.unscaledTime, Units = list.ToArray() });
        }

        void Beacon(float u)
        {
            // one red warning light, pulsing; the silence is the point
            if (Mathf.Repeat(u * 6f, 1f) < 0.12f) fx.Muzzle(siloP + new float3(0, w.GroundHeight(siloP.x, siloP.z) + 0.1f, 0), false);
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
            int best = g.N / 2 + g.W / 2;
            for (int i = 0; i < g.N; i += 3)
            {
                if (w.IsSea(i) || w.Biome[i] >= 8) continue;
                int sea = 0; for (int d = 0; d < 6; d++) { int n = g.Nb[i * 6 + d]; if (n >= 0 && w.IsSea(n)) sea++; }
                if (sea >= 2 && Math.Abs(i / g.W - g.H / 2) < g.H / 4) return i;
            }
            return best;
        }

        float3 Centre(int tile, float lift) { float x = g.CenterX(tile), z = g.CenterZ(tile); return new float3(x, w.GroundHeight(x, z) + lift, z); }
    }
}
