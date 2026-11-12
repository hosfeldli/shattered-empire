using System.Collections.Generic;
using UnityEngine;

namespace SE.Runtime.Audio
{
    /// <summary>Selected free recordings. Provenance and edits live beside the clips.</summary>
    static class RecordedAudio
    {
        public static readonly Dictionary<string, AudioClip[]> Shots = new Dictionary<string, AudioClip[]>();
        public static readonly Dictionary<string, AudioClip> Loops = new Dictionary<string, AudioClip>();
        public static void Load()
        {
            if (Shots.Count > 0) return;
            void Shot(string key, params string[] paths)
            {
                var clips = new List<AudioClip>();
                foreach (string path in paths) { var c = Resources.Load<AudioClip>("Audio/Recorded/" + path); if (c != null) clips.Add(c); }
                if (clips.Count > 0) Shots[key] = clips.ToArray();
            }
            Shot("rifle", "rifle_01", "rifle_02", "rifle_03");
            Shot("pistol", "pistol_01");
            Shot("mg", "mg_01", "mg_02");
            Shot("autocannon", "cannon_01");
            Shot("cannon", "cannon_01");
            Shot("launch", "blast_02");
            Shot("explosion", "blast_02", "blast_01");
            Shot("explosion_big", "blast_01");
            Shot("strategic", "blast_01");
            Shot("flak", "blast_02");
            Shot("collapse", "debris_01", "debris_02");
            Shot("metal", "metal_01"); Shot("wood", "wood_01"); Shot("glass", "glass_01");
            Shot("thunder", "thunder_01"); Shot("capture", "confirm_01");
            foreach (var pair in new[] {
                ("tank", "engine_tank"), ("truck", "engine_truck"), ("jet", "engine_jet"), ("rotor", "engine_rotor"),
                ("drone", "engine_rotor"), ("wind", "amb_wind"), ("rain", "amb_rain"), ("river", "amb_river"),
                ("nature", "amb_forest"), ("industry", "amb_industry"), ("music_calm", "music_calm"), ("music_combat", "music_combat") })
            {
                var clip = Resources.Load<AudioClip>("Audio/Recorded/" + pair.Item2);
                if (clip != null) Loops[pair.Item1] = clip;
            }
        }
    }
}
