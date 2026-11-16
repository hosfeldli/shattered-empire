using System.Collections.Generic;
using UnityEngine;

namespace SE.Runtime.Audio
{
    /// <summary>
    /// Selected recordings. Committed clips live in Audio/Recorded (provenance beside them); the owner's
    /// Asset Store sound libraries are converted into Workshop/Audio by tools/ingest-workshop-assets.cjs
    /// and, when present, enlarge every pool (more takes per weapon, distant variants, echo tails,
    /// material impacts, a full score). Every key still resolves with only the committed clips.
    /// </summary>
    static class RecordedAudio
    {
        public static readonly Dictionary<string, AudioClip[]> Shots = new Dictionary<string, AudioClip[]>();
        public static readonly Dictionary<string, AudioClip> Loops = new Dictionary<string, AudioClip>();
        /// <summary>Music playlists by mood: "calm", "combat", "menu", "dread".</summary>
        public static readonly Dictionary<string, AudioClip[]> Playlists = new Dictionary<string, AudioClip[]>();

        /// <summary>
        /// Seconds of lead-in before each take's transient (measured with ffmpeg: first 10 ms window within
        /// 12 dB of the take's peak). AudioDirector starts these takes early, or skips into them, so the
        /// blast is heard on the event rather than up to a second after it.
        /// </summary>
        static readonly Dictionary<string, float> Onsets = new Dictionary<string, float>
        {
            ["debris_01"] = .20f, ["thunder_01"] = 1.22f, ["thunder_10"] = .81f, ["thunder_11"] = .77f, ["thunder_12"] = 1.21f, ["thunder_13"] = .10f,
            ["ak_01"] = .08f, ["ak_05"] = .10f, ["explosion_01"] = .88f, ["explosion_02"] = .45f, ["explosion_03"] = .57f, ["explosion_04"] = .57f,
            ["explosion_05"] = .63f, ["explosion_06"] = .37f, ["explosion_07"] = .89f, ["explosion_08"] = .57f, ["explosion_09"] = .32f, ["explosion_10"] = .63f,
            ["flame_01"] = .66f, ["flame_03"] = .10f, ["quake_01"] = .70f, ["quake_02"] = .99f, ["rumble_01"] = .55f, ["rumble_02"] = .17f, ["rumble_03"] = .25f,
            ["shout_01"] = .07f, ["throw_01"] = .12f,
        };
        public static float Onset(AudioClip clip) => clip != null && Onsets.TryGetValue(clip.name, out var o) ? o : 0f;

        static AudioClip Clip(string name)
        {
            var c = Resources.Load<AudioClip>("Workshop/Audio/" + name);
            return c != null ? c : Resources.Load<AudioClip>("Audio/Recorded/" + name);
        }

        public static void Load()
        {
            if (Shots.Count > 0) return;
            void Shot(string key, params string[] names)
            {
                var clips = new List<AudioClip>();
                foreach (string n in names) { var c = Clip(n); if (c != null) clips.Add(c); }
                if (clips.Count > 0) Shots[key] = clips.ToArray();
            }
            Shot("rifle", "rifle_01", "rifle_02", "rifle_03", "ak_01", "ak_02", "ak_03", "ak_04", "ak_05", "rifle_3p_01", "rifle_3p_02");
            Shot("rifle_far", "rifle_far_01", "rifle_far_02");
            Shot("pistol", "pistol_01", "pistol_02", "pistol_03", "pistol_04", "pistol_05", "pistol_06");
            Shot("mg", "mg_burst_01", "mg_burst_02", "autocannon_burst");
            Shot("mg_far", "rifle_far_01", "rifle_far_02", "shotgun_far_01");
            Shot("autocannon", "cannon_01", "autocannon_burst", "heavy_rifle_01", "heavy_rifle_02");
            Shot("autocannon_far", "heavy_far_01", "heavy_far_02");
            Shot("cannon", "cannon_02", "cannon_03", "cannon_01");
            Shot("cannon_far", "heavy_far_01", "heavy_far_02", "distant_blast");
            Shot("launch", "blast_02");
            Shot("explosion", "blast_04", "blast_02", "mechanical_blast", "explosion_01", "explosion_02", "explosion_03", "explosion_04",
                "explosion_05", "explosion_06", "explosion_07", "explosion_08", "explosion_09", "explosion_10");
            Shot("explosion_big", "blast_01", "blast_03", "explosion_04", "explosion_08");
            Shot("rumble", "rumble_01", "rumble_02", "rumble_03", "quake_01");
            Shot("strategic", "blast_01");
            Shot("quake", "quake_01", "quake_02", "rumble_01");
            Shot("flak", "flak_01");
            Shot("pickup", "pickup_01"); Shot("energy", "energy_01");
            Shot("siren", "siren_01"); Shot("distant_blast", "distant_blast");
            Shot("collapse", "debris_01", "debris_02", "rumble_02");
            Shot("metal", "metal_01", "impact_metal"); Shot("wood", "wood_01", "impact_wood"); Shot("glass", "glass_01", "impact_glass");
            Shot("thunder", "thunder_01", "thunder_10", "thunder_11", "thunder_12", "thunder_13");
            Shot("capture", "confirm_01");
            Shot("ricochet", "ricochet_01", "ricochet_02");
            Shot("shell", "shell_01", "shell_02", "shell_03");
            Shot("tail_valley", "tail_valley"); Shot("tail_street", "tail_street");
            Shot("impact_dirt", "impact_dirt", "impact_grass", "impact_sand"); Shot("impact_stone", "impact_stones", "impact_concrete");
            Shot("casualty", "casualty_01"); Shot("shout", "shout_01");
            Shot("flame", "flame_01", "flame_02", "flame_03");
            Shot("ui_click", "ui_click"); Shot("ui_confirm", "ui_confirm", "confirm_01"); Shot("ui_denied", "ui_denied");
            Shot("ui_notify", "ui_notify"); Shot("ui_hover", "ui_hover");
            foreach (var pair in new[] {
                ("tank", "engine_tank"), ("truck", "engine_truck"), ("jet", "engine_jet"), ("rotor", "engine_rotor"),
                ("drone", "engine_rotor"), ("wind", "amb_wind"), ("rain", "amb_rain"), ("river", "amb_river"),
                ("nature", "amb_forest"), ("industry", "amb_industry"), ("music_calm", "music_calm"), ("music_combat", "music_combat"), ("music_intro", "music_intro"), ("music_menu", "music_menu"),
                ("city", "amb_city"), ("construction", "amb_construction"), ("river_close", "amb_river_close"), ("tracks", "tracks_detail"), ("fire", "amb_fire"),
                ("dread", "amb_dread"), ("wind_high", "amb_wind_high"), ("storm", "amb_wind_storm"), ("rain_heavy", "amb_rain_heavy"),
                ("fire_large", "amb_fire_large"), ("coast", "amb_coast"), ("stream", "amb_stream") })
            {
                var clip = Clip(pair.Item2);
                if (clip != null) Loops[pair.Item1] = clip;
            }
            void List(string mood, params string[] names)
            {
                var clips = new List<AudioClip>();
                foreach (string n in names) { var c = Clip(n); if (c != null) clips.Add(c); }
                if (clips.Count > 0) Playlists[mood] = clips.ToArray();
            }
            List("calm", "music_calm", "music_highlands", "music_wasteland_bass", "music_tension");
            List("combat", "music_combat", "music_battlefield", "music_battle_begins", "music_blood_steel", "music_incursion", "music_last_stand");
            List("menu", "music_at_the_gates", "music_menu", "music_wasteland_menu");
            List("dread", "music_dread", "music_tension_high", "music_ominous");
        }
    }
}
