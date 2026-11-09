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
    /// The opening: a short film rendered in the engine over a generated world. It tells what happened
    /// (the cities, the Shattering, the silence), who is left (survivors carrying what they could), and
    /// what the game is about (what comes after). Letterboxed, graded, scored with a slow requiem, and
    /// skippable at any moment.
    /// </summary>
    public sealed class IntroDirector
    {
        sealed class Shot
        {
            public float Seconds;
            public string Caption;
            public float3 From, To;
            public float D0, D1, Yaw0, Yaw1, Pitch;
            public float Dim = 1f, Elevation = 40f, Azimuth = -32f, Tint;
            public Color Sun = Color.white, Ambient = Color.white;
            public float Rain, Cloud, Ash;
            public Action<float> Tick;
        }

        readonly ClientSession session;
        readonly RtsCamera cam;
        readonly Atmosphere atmosphere;
        readonly EffectsRenderer fx;
        readonly AudioDirector audio;
        readonly VisualElement overlay;
        readonly Label caption, title, skip;
        readonly VisualElement fade;
        readonly List<Shot> shots = new List<Shot>();
        readonly List<float3> fires = new List<float3>();
        readonly List<int> convoyPath = new List<int>();
        int shot = -1;
        float t, fireAt, snapAt, total;
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
            title = new Label("SHATTERED EMPIRES"); title.AddToClassList("menu-title"); title.style.position = Position.Absolute; title.style.left = 0; title.style.right = 0; title.style.top = new Length(40, LengthUnit.Percent); title.style.fontSize = 84; title.style.opacity = 0; overlay.Add(title);
            fade = new VisualElement(); fade.AddToClassList("fade"); fade.pickingMode = PickingMode.Ignore; overlay.Add(fade);
            skip = new Label("Esc to skip"); skip.AddToClassList("skip"); overlay.Add(skip);
            uiRoot.Add(overlay);
        }

        public void Start()
        {
            // a world that has been broken: ruined cities, a drowned coast, survivors on the road
            var gen = StressWorld.Generate(192, 11);
            session.ApplyWelcome(new WelcomeMessage
            {
                W = 192, H = 192, Wrap = true, CivId = 0, Seed = 11, Match = "intro", Ruleset = "native-v4",
                Civs = new[] { new CivInfo { Id = 0, Name = "Survivors", Color = 0x8a7a5a, Human = true } },
            });
            session.ApplyGeo(gen.Geo);
            w = session.World; g = w.Grid;
            for (int i = 0; i < w.Visible.Length; i++) w.Visible[i] = 0xff;
            w.ApplyVisibility(w.Visible);
            session.Age = 0;
            // places for the film: a coastal city (ruins), the sea (a wreck), a road inland, a camp, a valley
            int coast = FindCoastalLand();
            int sea = NearestSea(coast);
            var ruins = new List<RuinRecord>();
            var rng = new System.Random(4);
            foreach (int t2 in Disk(coast, 6))
            {
                if (w.IsSea(t2) || w.IsLake(t2) || rng.NextDouble() > 0.55) continue;
                ruins.Add(new RuinRecord { Tile = t2, Type = rng.NextDouble() < 0.4 ? "tower" : rng.NextDouble() < 0.6 ? "city" : "suburb", Flags = rng.NextDouble() < 0.3 ? 4 : 0 });
                if (rng.NextDouble() < 0.25) fires.Add(Centre(t2, 0.1f));
            }
            session.Ruins = ruins.ToArray(); session.RuinRevision++;
            // the road the survivors take
            int a2 = Walk(coast, 0, 7), b2 = Walk(a2, 0, 12);
            for (int t2 = a2, k = 0; k < 14; k++)
            {
                convoyPath.Add(t2);
                int n = g.Nb[t2 * 6 + 0];
                if (n < 0 || w.IsSea(n)) break;
                w.Road[t2] |= 1 << 0; w.Road[n] |= 1 << 12;
                t2 = n;
            }
            w.MarkRoadsChanged();
            int camp = Walk(b2, 4, 4), valley = Walk(b2, 0, 4);
            // the first homes of what comes after
            var homes = new List<BuildingRecord>();
            int id = 1;
            foreach (int t2 in Disk(valley, 2))
            {
                if (w.IsSea(t2) || w.IsLake(t2) || homes.Count > 7) continue;
                homes.Add(new BuildingRecord { Id = id++, Owner = 0, Type = homes.Count == 0 ? "town" : homes.Count < 5 ? "house" : "farm", Tile = t2, Hp = 100, Done = homes.Count < 6, Progress = homes.Count < 6 ? 100 : 40, Level = 1, State = "ok" });
            }
            var dirty = new HashSet<int>();
            session.Structures.ApplyBuildings(homes.ToArray(), w, dirty);
            foreach (var c in dirty) session.DirtyCells.Add(c);
            fires.Add(Centre(camp, 0.06f));
            var seaP = Centre(sea, 0); var coastP = Centre(coast, 0); var campP = Centre(camp, 0); var valleyP = Centre(valley, 0);
            var roadA = Centre(convoyPath[0], 0); var roadB = Centre(convoyPath[convoyPath.Count - 1], 0);
            var dusk = new Color(1f, 0.55f, 0.32f); var night = new Color(0.45f, 0.55f, 0.8f); var dawn = new Color(1f, 0.72f, 0.5f);
            shots.Add(new Shot { Seconds = 11f, Caption = "Before the Shattering, the cities never slept.", From = coastP + new float3(-6, 0, 4), To = coastP + new float3(-2, 0, 2), D0 = 34, D1 = 26, Yaw0 = 20, Yaw1 = 35, Pitch = 22, Dim = 0.75f, Elevation = 9, Azimuth = -60, Tint = 0.8f, Sun = dusk, Ambient = new Color(0.9f, 0.75f, 0.7f), Cloud = 0.4f });
            shots.Add(new Shot { Seconds = 10f, Caption = "Then the ground broke. The grids went dark, and the sea came for the coasts.", From = coastP + new float3(-1, 0, 1), To = coastP, D0 = 16, D1 = 9, Yaw0 = 50, Yaw1 = 70, Pitch = 16, Dim = 0.6f, Elevation = 6, Azimuth = -70, Tint = 0.9f, Sun = dusk, Ambient = new Color(0.75f, 0.62f, 0.6f), Cloud = 0.55f, Ash = 0.3f });
            shots.Add(new Shot { Seconds = 10f, Caption = "In a single winter, eight billion voices fell silent.", From = seaP + new float3(2, 0, 2), To = seaP, D0 = 11, D1 = 7, Yaw0 = 140, Yaw1 = 160, Pitch = 12, Dim = 0.55f, Elevation = 25, Tint = 0.4f, Sun = new Color(0.8f, 0.85f, 0.9f), Ambient = new Color(0.7f, 0.75f, 0.8f), Rain = 0.7f, Cloud = 0.95f });
            shots.Add(new Shot { Seconds = 12f, Caption = "Those who remained carried what they could. Seeds. Tools. The names of the dead.", From = roadA, To = math.lerp(roadA, roadB, 0.6f), D0 = 9, D1 = 9, Yaw0 = 70, Yaw1 = 85, Pitch = 18, Dim = 0.7f, Elevation = 20, Tint = 0.3f, Sun = new Color(0.85f, 0.85f, 0.85f), Ambient = new Color(0.8f, 0.8f, 0.8f), Cloud = 0.8f, Ash = 0.6f, Tick = Convoy });
            shots.Add(new Shot { Seconds = 9f, Caption = "Some nights, they still remember the lights.", From = campP + new float3(0.6f, 0, 0.6f), To = campP, D0 = 6, D1 = 4.5f, Yaw0 = -20, Yaw1 = -5, Pitch = 20, Dim = 0.12f, Elevation = 35, Azimuth = 120, Tint = 1f, Sun = night, Ambient = new Color(0.32f, 0.36f, 0.5f), Cloud = 0.2f });
            shots.Add(new Shot { Seconds = 11f, Caption = "This is not the end of the world.", From = valleyP + new float3(-4, 0, 3), To = valleyP, D0 = 22, D1 = 14, Yaw0 = -40, Yaw1 = -15, Pitch = 24, Dim = 0.95f, Elevation = 7, Azimuth = 80, Tint = 0.9f, Sun = dawn, Ambient = new Color(0.95f, 0.85f, 0.8f), Cloud = 0.3f });
            shots.Add(new Shot { Seconds = 12f, Caption = "It is what comes after.", From = valleyP, To = valleyP + new float3(4, 0, -2), D0 = 16, D1 = 120, Yaw0 = -15, Yaw1 = 10, Pitch = -1, Dim = 1f, Elevation = 22, Azimuth = 60, Tint = 0.4f, Sun = dawn, Cloud = 0.25f, Tick = TitleCard });
            foreach (var s in shots) total += s.Seconds;
            weather = new WeatherState { CellsW = 1, CellsH = 1, Cell = 1024, Cloud = new byte[1], Rain = new byte[1], Wet = new byte[1], Fog = new byte[1], Storm = new byte[1], WindAngle = 0.5f, WindSpeed = 0.5f };
            atmosphere.Grain.intensity.Override(0.35f);
            cam.UserControl = false;
            audio?.PlayMusic(true);
            shot = 0; t = 0;
        }

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

        int NearestSea(int t0) { foreach (var x in Disk(t0, 6)) if (w.IsSea(x)) return x; return t0; }

        float3 Centre(int tile, float lift) { float x = g.CenterX(tile), z = g.CenterZ(tile); return new float3(x, w.GroundHeight(x, z) + lift, z); }

        void Convoy(float u)
        {
            // a column of survivors moving along the road: a supply truck, carts and people on foot
            if (Time.unscaledTime < snapAt) return;
            snapAt = Time.unscaledTime + 0.2f;
            var list = new List<UnitWire>();
            float along = u * (convoyPath.Count - 2);
            string[] types = { "supply_truck", "colonist", "colonist", "militia", "colonist" };
            for (int k = 0; k < types.Length; k++)
            {
                float p = Mathf.Max(0, along - k * 0.7f);
                int i = Mathf.Min(convoyPath.Count - 2, (int)p);
                list.Add(new UnitWire { Id = 100 + k, Owner = 0, Type = types[k], Tile = convoyPath[i], Next = convoyPath[i + 1], Prog = p - i, Hp = 100, AirState = -1, AirMission = -1, AirMissionTile = -1 });
            }
            session.ApplySnapshot(new SnapshotMessage { Time = Time.unscaledTime, Units = list.ToArray() });
        }

        void TitleCard(float u)
        {
            title.style.opacity = Mathf.Clamp01((u - 0.45f) / 0.25f);
            caption.style.opacity = Mathf.Clamp01(1f - (u - 0.4f) / 0.15f) * caption.style.opacity.value;
        }

        public void Update(float dt)
        {
            if (Done || shot < 0) return;
            if (InputFacade.Pressed(KeyCode.Escape) || InputFacade.Pressed(KeyCode.Space)) { Finish(); return; }
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
            // fires in the ruins and at the camp, ash drifting in the grey shots
            fireAt -= dt;
            if (fireAt <= 0)
            {
                fireAt = 0.12f;
                foreach (var f in fires) fx.Fire(f, 0.25f);
                if (s.Ash > 0) fx.Rain(new float3(cam.Focus.x, 0, cam.Focus.z), s.Ash * 0.25f, new float3(0.3f, 0, 0.1f), (x, z) => w.GroundHeight(x, z), 6f);
            }
            s.Tick?.Invoke(u);
            // captions fade in after the shot settles and out before the cut; black between shots
            float cIn = Mathf.Clamp01((t - 1.2f) / 1.5f), cOut = Mathf.Clamp01((s.Seconds - t - 0.6f) / 1.2f);
            caption.text = s.Caption;
            caption.style.opacity = Mathf.Min(cIn, cOut);
            float edge = Mathf.Min(t, s.Seconds - t);
            fade.style.opacity = shot == 0 && t < 2.5f ? 1f - t / 2.5f : Mathf.Clamp01(1f - edge / 0.7f) * 0.9f;
            if (t >= s.Seconds)
            {
                shot++; t = 0;
                if (shot >= shots.Count) { Finish(); return; }
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
    }
}
