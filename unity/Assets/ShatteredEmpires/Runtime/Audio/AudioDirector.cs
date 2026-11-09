using System;
using System.Collections.Generic;
using SE.Core.Units;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Audio
{
    /// <summary>
    /// Spatial sound for the world. One-shots (weapons, blasts, collapses, thunder) play from a pooled
    /// set of 3D voices at their map positions, with distance attenuation, a low-pass that muffles far
    /// sounds, voice stealing and per-sound rate limits so a 1,000-unit battle stays legible. Engines
    /// follow the nearest vehicles and aircraft. Ambience follows what the camera is looking at: city
    /// life near developed districts, wind and birds over open country, running water near rivers, rain
    /// in the weather, a distant battle bed when fighting is near. Purely presentation.
    /// </summary>
    public sealed class AudioDirector : IDisposable
    {
        sealed class Voice { public AudioSource Src; public AudioLowPassFilter Lp; public float Until; public int Priority; }
        sealed class Engine { public AudioSource Src; public int Unit = -1; public string Clip; }

        readonly GameObject root;
        readonly Transform listener;
        readonly List<Voice> voices = new List<Voice>();
        readonly List<Engine> engines = new List<Engine>();
        readonly Dictionary<string, AudioSource> beds = new Dictionary<string, AudioSource>();
        readonly Dictionary<string, float> lastPlayed = new Dictionary<string, float>();
        readonly Dictionary<string, int> burst = new Dictionary<string, int>();
        readonly AudioSource music;
        readonly System.Random rng = new System.Random(3);
        public float Master = 1f, Effects = 1f, Ambience = 0.8f, MusicVolume = 0.7f;
        float time, birdAt, battleHeat;

        public AudioDirector(Camera cam)
        {
            AudioSynth.Build();
            root = new GameObject("SE Audio");
            listener = cam.transform;
            if (cam.GetComponent<AudioListener>() == null) cam.gameObject.AddComponent<AudioListener>();
            var reverb = cam.GetComponent<AudioReverbFilter>();
            if (reverb == null) reverb = cam.gameObject.AddComponent<AudioReverbFilter>();
            reverb.reverbPreset = AudioReverbPreset.Plain;
            for (int i = 0; i < 32; i++)
            {
                var go = new GameObject("voice" + i);
                go.transform.SetParent(root.transform);
                var s = go.AddComponent<AudioSource>();
                s.playOnAwake = false; s.spatialBlend = 1f; s.rolloffMode = AudioRolloffMode.Logarithmic; s.dopplerLevel = 0f; s.maxDistance = 900f;
                var lp = go.AddComponent<AudioLowPassFilter>();
                voices.Add(new Voice { Src = s, Lp = lp });
            }
            for (int i = 0; i < 8; i++)
            {
                var go = new GameObject("engine" + i);
                go.transform.SetParent(root.transform);
                var s = go.AddComponent<AudioSource>();
                s.playOnAwake = false; s.loop = true; s.spatialBlend = 1f; s.rolloffMode = AudioRolloffMode.Logarithmic; s.dopplerLevel = 0.3f; s.maxDistance = 400f; s.minDistance = 3f;
                engines.Add(new Engine { Src = s });
            }
            foreach (var name in new[] { "wind", "rain", "river", "city", "battle" }) beds[name] = Bed(AudioSynth.Loops[name]);
            var nature = Resources.Load<AudioClip>("Audio/countryside");
            beds["nature"] = Bed(nature != null ? nature : AudioSynth.Loops["wind"]);
            music = root.AddComponent<AudioSource>();
            music.playOnAwake = false; music.spatialBlend = 0f; music.loop = false;
            Load();
        }

        AudioSource Bed(AudioClip clip)
        {
            var s = root.AddComponent<AudioSource>();
            s.clip = clip; s.loop = true; s.spatialBlend = 0f; s.volume = 0f; s.playOnAwake = false;
            s.Play();
            return s;
        }

        public void Load()
        {
            Master = PlayerPrefs.GetFloat("se.vol.master", 1f); Effects = PlayerPrefs.GetFloat("se.vol.fx", 1f);
            Ambience = PlayerPrefs.GetFloat("se.vol.amb", 0.8f); MusicVolume = PlayerPrefs.GetFloat("se.vol.music", 0.7f);
        }

        public void Save()
        {
            PlayerPrefs.SetFloat("se.vol.master", Master); PlayerPrefs.SetFloat("se.vol.fx", Effects);
            PlayerPrefs.SetFloat("se.vol.amb", Ambience); PlayerPrefs.SetFloat("se.vol.music", MusicVolume);
            PlayerPrefs.Save();
        }

        /// <summary>Play a one-shot at a map position. Priority decides voice stealing when all are busy.</summary>
        public void Play(string name, float3 mapPos, float volume = 1f, float minDistance = 2f, int priority = 1, float camDistance = 40f)
        {
            if (!AudioSynth.OneShots.TryGetValue(name, out var clips)) return;
            // rate limit: the same sound at most a few times per 0.1 s (big battles stay readable)
            int cap = name == "rifle" || name == "mg" ? 4 : 3;
            if (lastPlayed.TryGetValue(name, out float last) && time - last < 0.1f) { if (burst[name] >= cap) return; burst[name]++; }
            else { lastPlayed[name] = time; burst[name] = 1; }
            Voice v = null;
            foreach (var x in voices) if (!x.Src.isPlaying) { v = x; break; }
            if (v == null)
            {
                foreach (var x in voices) if (x.Priority < priority && (v == null || x.Until < v.Until)) v = x;
                if (v == null) return;
            }
            var u = MapSpace.W(mapPos);
            v.Src.transform.position = new Vector3(u.x, u.y, u.z);
            v.Src.clip = clips[rng.Next(clips.Length)];
            // keep battles audible at operational zoom: the sound "reaches" further when zoomed out
            v.Src.minDistance = minDistance * Mathf.Max(1f, camDistance / 22f);
            v.Src.volume = volume * Effects * Master;
            v.Src.pitch = 0.94f + (float)rng.NextDouble() * 0.12f;
            float dist = Vector3.Distance(listener.position, v.Src.transform.position);
            v.Lp.cutoffFrequency = Mathf.Lerp(22000f, 1400f, Mathf.Clamp01((dist - v.Src.minDistance) / 260f));
            v.Priority = priority;
            v.Until = time + v.Src.clip.length;
            v.Src.Play();
            if (priority >= 2) battleHeat = Mathf.Min(1f, battleHeat + 0.08f);
        }

        public void PlayMusic(bool on)
        {
            if (on) { music.clip = AudioSynth.Music; music.volume = MusicVolume * Master; music.Play(); }
            else music.Stop();
        }

        public float MusicTime => music.isPlaying ? music.time : 0f;

        /// <summary>Per frame: engines on the nearest vehicles and aircraft, and the ambience mix.</summary>
        public void Update(float dt, UnitStore units, Func<int, Vector2?> unitPos, WorldModel world, float3 focusMap, float camDistance, float urbanNear, float riverNear, float rain, float wind)
        {
            time += dt;
            battleHeat = Mathf.Max(0, battleHeat - dt * 0.15f);
            if (units != null && world.Ready) Engines(units, unitPos, world, focusMap, camDistance);
            float close = Mathf.Clamp01(1f - (camDistance - 8f) / 70f);
            float strategic = Mathf.Clamp01((camDistance - 60f) / 140f);
            float a = Ambience * Master;
            Fade("wind", (0.12f + strategic * 0.35f + wind * 0.25f) * a, dt);
            Fade("nature", close * (1f - urbanNear) * (1f - rain) * 0.55f * a, dt);
            Fade("city", close * urbanNear * 0.6f * a, dt);
            Fade("river", close * riverNear * 0.6f * a, dt);
            Fade("rain", rain * (0.25f + close * 0.55f) * a, dt);
            Fade("battle", battleHeat * 0.5f * a * (0.4f + strategic * 0.6f), dt);
            music.volume = MusicVolume * Master;
            // birdsong in quiet countryside
            if (close > 0.4f && urbanNear < 0.4f && rain < 0.2f && time > birdAt)
            {
                birdAt = time + 2f + (float)rng.NextDouble() * 6f;
                var p = focusMap + new float3(((float)rng.NextDouble() - 0.5f) * 8f, 1f, ((float)rng.NextDouble() - 0.5f) * 8f);
                Play("bird", p, 0.25f * Ambience, 4f, 0, camDistance);
            }
        }

        void Fade(string bed, float target, float dt)
        {
            var s = beds[bed];
            s.volume = Mathf.MoveTowards(s.volume, target, dt * 0.6f);
        }

        void Engines(UnitStore units, Func<int, Vector2?> unitPos, WorldModel world, float3 focusMap, float camDistance)
        {
            // the eight loudest nearby engines (aircraft count from further away)
            var picks = new List<(float d, int id, string clip)>();
            float reach = Mathf.Max(20f, camDistance * 1.5f);
            for (int s = 0; s < units.SlotCount; s++)
            {
                ref var u = ref units.Records[s];
                if (!u.InUse) continue;
                string type = units.Types.Name(u.TypeIndex);
                string clip = EngineClip(type);
                if (clip == null) continue;
                var p = unitPos(u.Id);
                if (p == null) continue;
                float dx = world.Grid.DxWrap(focusMap.x, p.Value.x), dz = p.Value.y - focusMap.z;
                float d = Mathf.Sqrt(dx * dx + dz * dz) * (clip == "jet" || clip == "rotor" ? 0.6f : 1f);
                if (d > reach) continue;
                picks.Add((d, u.Id, clip));
            }
            picks.Sort((x, y) => x.d.CompareTo(y.d));
            var keep = new HashSet<int>();
            for (int k = 0; k < Math.Min(engines.Count, picks.Count); k++) keep.Add(picks[k].id);
            foreach (var e in engines) if (e.Unit >= 0 && !keep.Contains(e.Unit)) { e.Unit = -1; e.Src.Stop(); }
            for (int k = 0; k < Math.Min(engines.Count, picks.Count); k++)
            {
                var (d, id, clip) = picks[k];
                Engine e = null;
                foreach (var en in engines) if (en.Unit == id) { e = en; break; }
                if (e == null) foreach (var en in engines) if (en.Unit < 0) { e = en; break; }
                if (e == null) continue;
                if (e.Unit != id || e.Clip != clip)
                {
                    e.Unit = id; e.Clip = clip;
                    e.Src.clip = AudioSynth.Loops[clip];
                    e.Src.time = (float)rng.NextDouble() * e.Src.clip.length * 0.9f;
                    e.Src.pitch = 0.92f + (float)rng.NextDouble() * 0.16f;
                    e.Src.Play();
                }
                var p = unitPos(id).Value;
                float x = world.Grid.NearX(p.x, focusMap.x);
                float alt = clip == "jet" ? 2f : clip == "rotor" ? 0.8f : clip == "drone" ? 1.2f : 0f;
                var u = MapSpace.W(new float3(x, world.GroundHeight(x, p.y) + alt, p.y));
                e.Src.transform.position = new Vector3(u.x, u.y, u.z);
                e.Src.minDistance = (clip == "jet" ? 6f : 2.5f) * Mathf.Max(1f, camDistance / 25f);
                e.Src.volume = (clip == "jet" ? 0.7f : clip == "rotor" ? 0.6f : 0.45f) * Effects * Master;
            }
        }

        static string EngineClip(string type)
        {
            switch (type)
            {
                case "tank": case "autonomous_tank": case "mech_infantry": case "sp_artillery": return "tank";
                case "armored_car": case "supply_truck": case "scout_buggy": case "field_gun": case "missile_battery": case "air_defense": return "truck";
                case "fighter": case "bomber": return "jet";
                case "helicopter": return "rotor";
                case "recon_drone": case "oneway_drone": case "strike_swarm": return "drone";
                default: return null;
            }
        }

        public void Dispose() { if (root != null) UnityEngine.Object.Destroy(root); }
    }
}
