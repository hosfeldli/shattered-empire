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
        sealed class Voice { public AudioSource Src; public AudioLowPassFilter Lp; public float Until, Gain; public int Priority; public string Key; }
        sealed class Engine { public AudioSource Src, Tracks; public AudioLowPassFilter Lp; public int Unit = -1; public string Clip; }

        readonly GameObject root;
        readonly Transform listener;
        readonly Transform cameraTransform;
        readonly AudioListener previousListener;
        readonly List<Voice> voices = new List<Voice>();
        readonly List<Engine> engines = new List<Engine>();
        readonly Dictionary<string, AudioSource> beds = new Dictionary<string, AudioSource>();
        readonly Dictionary<string, float> lastPlayed = new Dictionary<string, float>();
        readonly Dictionary<string, int> burst = new Dictionary<string, int>();
        readonly List<(float d, int id, string clip)> enginePicks = new List<(float, int, string)>(64);
        readonly HashSet<int> engineKeep = new HashSet<int>();
        readonly AudioSource music;
        bool cinematicMusic, menuMusic;
        float cinematicGain = 1, cinematicCityGain;
        float3 cinematicCityPoint;
        readonly System.Random rng = new System.Random(3);
        public float Master = 1f, Effects = 1f, Ambience = .65f, MusicVolume = .4f;
        float time, battleHeat, voiceGain = 1, environmentAt;

        public AudioDirector(Camera cam)
        {
            RecordedAudio.Load();
            root = new GameObject("SE Audio");
            cameraTransform = cam.transform;
            previousListener = cam.GetComponent<AudioListener>();
            if (previousListener != null) previousListener.enabled = false;
            var ear = new GameObject("Camera focus listener"); ear.transform.SetParent(root.transform);
            ear.AddComponent<AudioListener>(); listener = ear.transform;
            listener.SetPositionAndRotation(cam.transform.position, cam.transform.rotation);
            for (int i = 0; i < 28; i++)
            {
                var go = new GameObject("voice" + i);
                go.transform.SetParent(root.transform);
                var s = go.AddComponent<AudioSource>();
                s.playOnAwake = false; s.spatialBlend = 1f; s.rolloffMode = AudioRolloffMode.Logarithmic; s.dopplerLevel = 0f; s.maxDistance = 180f;
                s.spread = 0; s.reverbZoneMix = .15f;
                var lp = go.AddComponent<AudioLowPassFilter>();
                voices.Add(new Voice { Src = s, Lp = lp });
            }
            for (int i = 0; i < 8; i++)
            {
                var go = new GameObject("engine" + i);
                go.transform.SetParent(root.transform);
                var s = go.AddComponent<AudioSource>();
                s.playOnAwake = false; s.loop = true; s.spatialBlend = 1f; s.rolloffMode = AudioRolloffMode.Logarithmic; s.dopplerLevel = .08f; s.maxDistance = 90f; s.minDistance = .9f;
                var tracks = go.AddComponent<AudioSource>(); tracks.playOnAwake = false; tracks.loop = true;
                tracks.spatialBlend = 1; tracks.minDistance = .55f; tracks.maxDistance = 22; tracks.dopplerLevel = 0;
                tracks.rolloffMode = AudioRolloffMode.Logarithmic;
                if (RecordedAudio.Loops.TryGetValue("tracks", out var trackClip)) tracks.clip = trackClip;
                engines.Add(new Engine { Src = s, Tracks = tracks, Lp = go.AddComponent<AudioLowPassFilter>() });
            }
            foreach (var name in new[] { "wind", "rain", "river", "industry", "nature", "music_calm", "music_combat", "music_menu", "river_close", "construction", "city", "fire" })
                beds[name] = Bed(RecordedAudio.Loops.TryGetValue(name, out var clip) ? clip : null,
                    name == "river" || name == "river_close" || name == "industry" || name == "construction" || name == "city" || name == "fire");
            music = root.AddComponent<AudioSource>();
            music.playOnAwake = false; music.spatialBlend = 0f; music.loop = false;
            Load();
        }

        AudioSource Bed(AudioClip clip, bool spatial = false)
        {
            var go = new GameObject("Ambience " + (clip != null ? clip.name : "silent")); go.transform.SetParent(root.transform);
            var s = go.AddComponent<AudioSource>();
            s.clip = clip; s.loop = true; s.spatialBlend = spatial ? 1f : 0f; s.volume = 0f; s.playOnAwake = false;
            s.minDistance = 1.8f; s.maxDistance = 35f; s.dopplerLevel = 0; s.rolloffMode = AudioRolloffMode.Logarithmic;
            if (clip != null) s.Play();
            return s;
        }

        public void Load()
        {
            Master = PlayerPrefs.GetFloat("se.vol.master", 1f); Effects = PlayerPrefs.GetFloat("se.vol.fx", 1f);
            Ambience = PlayerPrefs.GetFloat("se.vol.amb", .65f); MusicVolume = PlayerPrefs.GetFloat("se.vol.music", .4f);
        }

        public void Save()
        {
            PlayerPrefs.SetFloat("se.vol.master", Master); PlayerPrefs.SetFloat("se.vol.fx", Effects);
            PlayerPrefs.SetFloat("se.vol.amb", Ambience); PlayerPrefs.SetFloat("se.vol.music", MusicVolume);
            PlayerPrefs.Save();
        }

        /// <summary>Play a one-shot at a map position. Priority decides voice stealing when all are busy.</summary>
        public void Play(string name, float3 mapPos, float volume = 1f, float minDistance = 2f, int priority = 1, float camDistance = 40f, float delay = 0)
        {
            if (!RecordedAudio.Shots.TryGetValue(name, out var clips)) return;
            var u = MapSpace.W(mapPos);
            float reach = name == "strategic" || name == "thunder" || name == "distant_blast" ? 500 : name.Contains("explosion") || name == "siren" ? 130 : 85;
            if (Vector3.Distance(listener.position, u) > reach) return;
            // rate limit: the same sound at most a few times per 0.1 s (big battles stay readable)
            int cap = name == "rifle" || name == "mg" ? 3 : 2;
            if (lastPlayed.TryGetValue(name, out float last) && time - last < 0.1f) { if (burst[name] >= cap) return; burst[name]++; }
            else { lastPlayed[name] = time; burst[name] = 1; }
            Voice v = null;
            foreach (var x in voices) if (x.Until <= time && !x.Src.isPlaying) { v = x; break; }
            if (v == null)
            {
                foreach (var x in voices) if (x.Priority < priority && (v == null || x.Until < v.Until)) v = x;
                if (v == null) return;
            }
            v.Src.Stop();
            v.Src.transform.position = new Vector3(u.x, u.y, u.z);
            v.Src.clip = clips[rng.Next(clips.Length)];
            // keep battles audible at operational zoom: the sound "reaches" further when zoomed out
            v.Src.minDistance = Mathf.Clamp(minDistance * .45f, .7f, 12f) * Mathf.Max(1f, camDistance / 65f);
            v.Src.maxDistance = reach;
            v.Gain = volume * (name == "rifle" || name == "mg" ? .42f : .60f);
            v.Src.volume = v.Gain * Effects * Master * voiceGain;
            v.Src.pitch = name == "strategic" ? .64f : name == "autocannon" ? 1.28f : name == "flak" ? 1.25f : .97f + (float)rng.NextDouble() * .06f;
            v.Src.priority = Mathf.Clamp(180 - priority * 24, 16, 220);
            float dist = Vector3.Distance(listener.position, v.Src.transform.position);
            v.Lp.cutoffFrequency = Mathf.Lerp(18000f, 1100f, Mathf.Clamp01((dist - v.Src.minDistance) / 70f));
            v.Priority = priority; v.Key = name;
            v.Until = time + delay + v.Src.clip.length / v.Src.pitch;
            if (delay > 0) v.Src.PlayDelayed(delay); else v.Src.Play();
            if (priority >= 2) battleHeat = Mathf.Min(1f, battleHeat + 0.08f);
        }

        public void PlayMusic(bool on)
        {
            cinematicMusic = on;
            if (on && RecordedAudio.Loops.TryGetValue("music_intro", out var score)) { music.clip = score; music.volume = MusicVolume * Master * .70f; music.Play(); }
            else music.Stop();
        }

        public float MusicTime => music.isPlaying ? music.time : 0f;
        public void CinematicCity(float level, float3 position) { cinematicCityGain = Mathf.Clamp01(level); cinematicCityPoint = position; }
        public void CinematicDynamics(float intensity) { cinematicGain = Mathf.Clamp01(intensity); }
        public void StopCue(string key) { foreach (var voice in voices) if (voice.Key == key) { voice.Src.Stop(); voice.Until = 0; } }
        public void MenuScore(bool on)
        {
            if (on && !menuMusic && beds.TryGetValue("music_menu", out var score) && score.clip != null)
            { score.time = 0; score.Play(); }
            menuMusic = on;
        }

        /// <summary>Per frame: engines on the nearest vehicles and aircraft, and the ambience mix.</summary>
        public void Update(float dt, UnitStore units, Func<int, Vector2?> unitPos, WorldModel world, float3 focusMap, float camDistance, float urbanNear, float riverNear, float rain, float wind, StructureStore structures = null, IReadOnlyList<float3> burningWrecks = null)
        {
            time += dt;
            listener.SetPositionAndRotation((Vector3)MapSpace.W(focusMap) + new Vector3(0, Mathf.Clamp(camDistance * .065f, 1.2f, 6f), 0), cameraTransform.rotation);
            int active = 0; foreach (var v in voices) if (v.Src.isPlaying) active++;
            voiceGain = Mathf.Lerp(voiceGain, 1f / Mathf.Sqrt(1 + active * .13f), 1 - Mathf.Exp(-dt * 4));
            foreach (var v in voices) if (v.Src.isPlaying) v.Src.volume = v.Gain * Effects * Master * voiceGain;
            battleHeat = Mathf.Max(0, battleHeat - dt * 0.15f);
            if (units != null && world.Ready) Engines(units, unitPos, world, focusMap, camDistance);
            float close = Mathf.Clamp01(1f - (camDistance - 8f) / 70f);
            float strategic = Mathf.Clamp01((camDistance - 60f) / 140f);
            float a = Ambience * Master;
            Fade("wind", (.08f + wind * .15f) * a, dt);
            Fade("nature", close * (1f - urbanNear) * (1f - rain) * .26f * a * (1 - battleHeat * .65f) * (1 - cinematicCityGain), dt);
            Fade("river", localRiver ? close * riverNear * .32f * a : 0, dt);
            float riverDetail = Mathf.Pow(Mathf.Clamp01((14 - camDistance) / 11), 1.4f);
            Fade("river_close", localRiver ? riverDetail * riverNear * .52f * a : 0, dt);
            Fade("rain", rain * (.10f + close * .24f) * a, dt);
            float score = cinematicMusic || menuMusic ? 0 : MusicVolume * Master * .30f;
            Fade("music_calm", score * (1 - battleHeat), dt * .25f);
            Fade("music_combat", score * battleHeat, dt * .25f);
            Fade("music_menu", menuMusic && !cinematicMusic ? MusicVolume * Master * .58f : 0, dt * .4f);
            music.volume = MusicVolume * Master * .70f * cinematicGain;
            beds["city"].transform.position = MapSpace.W(cinematicCityPoint);
            Fade("city", cinematicMusic ? cinematicCityGain * .42f * a : 0, dt);
            // Local water and machinery remain anchored; only the broad weather bed is stereo.
            if (world.Ready && time >= environmentAt)
            {
                environmentAt = time + .35f;
                UpdateLocalAmbience(world, structures, focusMap, burningWrecks);
            }
            Fade("industry", localIndustry ? close * .34f * a : 0, dt);
            Fade("construction", localConstruction ? close * .34f * a : 0, dt);
            Fade("fire", localFire ? close * .33f * a : 0, dt);
        }

        void Fade(string bed, float target, float dt)
        {
            var s = beds[bed];
            s.volume = Mathf.MoveTowards(s.volume, target, dt * 0.6f);
        }

        void Engines(UnitStore units, Func<int, Vector2?> unitPos, WorldModel world, float3 focusMap, float camDistance)
        {
            // the eight loudest nearby engines (aircraft count from further away)
            var picks = enginePicks; picks.Clear();
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
            var keep = engineKeep; keep.Clear();
            for (int k = 0; k < Math.Min(engines.Count, picks.Count); k++) keep.Add(picks[k].id);
            foreach (var e in engines) if (e.Unit >= 0 && !keep.Contains(e.Unit)) { e.Unit = -1; e.Src.Stop(); e.Tracks.Stop(); }
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
                    if (!RecordedAudio.Loops.TryGetValue(clip, out var loop)) continue;
                    e.Src.clip = loop;
                    e.Src.time = (float)rng.NextDouble() * e.Src.clip.length * 0.9f;
                    e.Src.pitch = clip == "drone" ? 1.85f : .97f + (float)rng.NextDouble() * .06f;
                    e.Src.Play();
                    if (clip == "tank" && e.Tracks.clip != null) e.Tracks.Play(); else e.Tracks.Stop();
                }
                var p = unitPos(id).Value;
                float x = world.Grid.NearX(p.x, focusMap.x);
                float alt = clip == "jet" ? 2f : clip == "rotor" ? 0.8f : clip == "drone" ? 1.2f : 0f;
                var u = MapSpace.W(new float3(x, world.GroundHeight(x, p.y) + alt, p.y));
                e.Src.transform.position = new Vector3(u.x, u.y, u.z);
                e.Src.minDistance = (clip == "jet" ? 2.4f : .9f) * Mathf.Max(1f, camDistance / 70f);
                e.Src.volume = (clip == "jet" ? .22f : clip == "rotor" ? .24f : .15f) * Effects * Master * voiceGain;
                e.Lp.cutoffFrequency = Mathf.Lerp(9000, 900, Mathf.Clamp01(d / 65));
                if (units.TryGet(id, out var record))
                {
                    float movement = Mathf.Clamp01(Mathf.Sqrt(record.Motion.Vx * record.Motion.Vx + record.Motion.Vz * record.Motion.Vz) / .20f);
                    float targetPitch = clip == "drone" ? 1.85f : clip == "jet" || clip == "rotor" ? .94f + movement * .10f : .84f + movement * .26f;
                    e.Src.pitch = Mathf.Lerp(e.Src.pitch, targetPitch, .06f);
                    e.Tracks.volume = clip == "tank" ? movement * .23f * Effects * Master * (1 - Mathf.Clamp01(d / 22)) : 0;
                    e.Tracks.pitch = .78f + movement * .40f;
                    if (record.Motion.Present && record.Motion.Altitude < .08f && (clip == "jet" || clip == "rotor")) e.Src.volume *= .25f;
                }
            }
        }

        bool localIndustry, localRiver, localConstruction, localFire;
        void UpdateLocalAmbience(WorldModel world, StructureStore structures, float3 focus, IReadOnlyList<float3> burningWrecks)
        {
            var g = world.Grid; int center = g.TileAt(focus.x, focus.z); float best = float.MaxValue;
            localRiver = false;
            if (center >= 0) for (int d = -1; d < 6; d++)
            {
                int tile = d < 0 ? center : g.Nb[center * 6 + d];
                if (tile < 0 || world.Known[tile] == 0 || !world.IsRiver(tile)) continue;
                float x = g.NearX(g.CenterX(tile), focus.x), z = g.CenterZ(tile);
                float dist = math.distancesq(new float2(focus.x, focus.z), new float2(x, z));
                if (dist >= best) continue; best = dist; localRiver = true;
                beds["river"].transform.position = MapSpace.W(new float3(x, world.GroundHeight(x, z), z));
                beds["river_close"].transform.position = beds["river"].transform.position;
            }
            best = 36; localIndustry = false; localConstruction = false; localFire = false;
            float constructionDistance = 25, fireDistance = 36;
            if (burningWrecks != null) foreach (var fire in burningWrecks)
            {
                float d = math.distancesq(fire.xz, focus.xz); if (d > fireDistance) continue;
                fireDistance = d; localFire = true; beds["fire"].transform.position = MapSpace.W(fire);
            }
            if (structures == null) return;
            foreach (var b in structures.Buildings.Values)
            {
                if (b.Memory) continue;
                float x = g.NearX(b.HasPosition ? b.X : g.CenterX(b.Tile), focus.x), z = b.HasPosition ? b.Z : g.CenterZ(b.Tile);
                float dist = math.distancesq(new float2(focus.x, focus.z), new float2(x, z));
                if (!b.Done && b.Progress > 0 && dist < constructionDistance)
                { constructionDistance = dist; localConstruction = true; beds["construction"].transform.position = MapSpace.W(new float3(x, world.GroundHeight(x, z), z)); }
                if (b.Fire && dist < fireDistance)
                { fireDistance = dist; localFire = true; beds["fire"].transform.position = MapSpace.W(new float3(x, world.GroundHeight(x, z), z)); }
                if (!b.Done || !b.Active || b.Type != "power_plant" && b.Type != "motor_works" && b.Type != "steel_mill") continue;
                if (dist >= best) continue; best = dist; localIndustry = true;
                beds["industry"].transform.position = MapSpace.W(new float3(x, world.GroundHeight(x, z) + .10f, z));
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

        public void Dispose() { if (previousListener != null) previousListener.enabled = true; if (root != null) UnityEngine.Object.Destroy(root); }
    }
}
