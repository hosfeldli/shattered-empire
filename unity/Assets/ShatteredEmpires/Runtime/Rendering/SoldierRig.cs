using System;
using UnityEngine;

namespace SE.Runtime.Rendering
{
    /// <summary>
    /// A rigged, animated infantry model from tools/blender/build_soldiers.py: the rest mesh
    /// (Models/Soldier&lt;role&gt;, uv0.x = bone) and its baked bone animation (Models/SoldierAnim&lt;role&gt;,
    /// SEA1), uploaded as a float texture that SE/InstancedLit samples per vertex. Each instance chooses
    /// its own frame (instance colour alpha = 2 + frame), so every soldier animates independently in one
    /// instanced draw.
    /// </summary>
    public sealed class SoldierRig : IDisposable
    {
        /// <summary>
        /// Baked clips. Kneel, Hop and Deploy were added later: an older bake lacks them, so callers check
        /// <see cref="Has"/> and fall back (Kneel/Deploy to Aim, Hop to Walk).
        /// </summary>
        public enum Clip { Idle, Walk, Run, Aim, Fire, Die, Kneel, Hop, Deploy }
        public struct ClipInfo { public int Start, Count; public float Fps; public bool Loop; }

        public Mesh Mesh;
        /// <summary>Team-colour overlay (helmet / cap, shoulder pads) on the same bones (Models/SoldierTeam&lt;role&gt;), or null.</summary>
        public Mesh TeamMesh;
        public Material Material;
        public Texture2D Animation;
        public readonly ClipInfo[] Clips = new ClipInfo[9];

        static readonly string[] ClipNames = { "idle", "walk", "run", "aim", "fire", "die", "kneel", "hop", "deploy" };

        /// <summary>Whether this bake contains the clip.</summary>
        public bool Has(Clip clip) => Clips[(int)clip].Count > 0;

        /// <summary>The clip's length in seconds (0 when absent).</summary>
        public float Duration(Clip clip)
        {
            var c = Clips[(int)clip];
            return c.Count > 0 && c.Fps > 0 ? c.Count / c.Fps : 0;
        }

        /// <summary>The role's rig, or null when its model or animation is missing or unreadable.</summary>
        public static SoldierRig Load(int role)
        {
            var mesh = ModelLibrary.Get("Soldier" + role);
            var asset = Resources.Load<TextAsset>("Models/SoldierAnim" + role);
            if (mesh == null || asset == null) return null;
            try
            {
                var rig = new SoldierRig { Mesh = mesh, TeamMesh = ModelLibrary.Get("SoldierTeam" + role) };
                rig.Decode(asset.bytes, role);
                Resources.UnloadAsset(asset);
                return rig;
            }
            catch (Exception e)
            {
                Debug.LogWarning("Shattered Empires: soldier animation " + role + " unreadable (" + e.Message + "); using the procedural figure");
                return null;
            }
        }

        void Decode(byte[] d, int role)
        {
            if (d.Length < 16 || d[0] != 'S' || d[1] != 'E' || d[2] != 'A' || d[3] != '1') throw new FormatException("not SEA1");
            int bones = BitConverter.ToInt32(d, 4), frames = BitConverter.ToInt32(d, 8), clips = BitConverter.ToInt32(d, 12);
            int o = 16;
            for (int c = 0; c < clips; c++, o += 32)
            {
                string name = System.Text.Encoding.ASCII.GetString(d, o, 16).TrimEnd('\0');
                int index = Array.IndexOf(ClipNames, name);
                if (index < 0) continue;
                Clips[index] = new ClipInfo { Start = BitConverter.ToInt32(d, o + 16), Count = BitConverter.ToInt32(d, o + 20),
                    Fps = BitConverter.ToSingle(d, o + 24), Loop = BitConverter.ToInt32(d, o + 28) != 0 };
            }
            int floats = bones * frames * 12;
            if (bones <= 0 || frames <= 0 || d.Length != o + floats * 4) throw new FormatException("size mismatch");
            var data = new float[floats];
            Buffer.BlockCopy(d, o, data, 0, floats * 4);
            Animation = new Texture2D(bones * 3, frames, TextureFormat.RGBAFloat, false, true)
            { name = "Soldier animation " + role, filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, hideFlags = HideFlags.DontUnloadUnusedAsset };
            Animation.SetPixelData(data, 0);
            Animation.Apply(false, true);
            // never unloaded behind our back (an unused-asset sweep would leave every soldier invisible)
            Material = new Material(RenderResources.Instanced) { name = "SE Soldier " + role, enableInstancing = true, hideFlags = HideFlags.DontUnloadUnusedAsset };
            Material.SetFloat("_Skinned", 1);
            Material.SetTexture("_SE_AnimTex", Animation);
        }

        /// <summary>The baked frame (fractional) for a clip at a time in seconds (loops or holds the last frame).</summary>
        public float Frame(Clip clip, float seconds)
        {
            var c = Clips[(int)clip];
            if (c.Count <= 0) return 0;
            float f = seconds * c.Fps;
            f = c.Loop ? Mathf.Repeat(f, c.Count) : Mathf.Min(f, c.Count - 1.001f);
            return c.Start + f;
        }

        /// <summary>A looping clip at a cycle phase in [0, 1) (gaits follow the distance walked, not the clock).</summary>
        public float Cycle(Clip clip, float phase01)
        {
            var c = Clips[(int)clip];
            return c.Start + Mathf.Repeat(phase01, 1f) * c.Count;
        }

        public void Dispose()
        {
            if (Material != null) UnityEngine.Object.Destroy(Material);
            if (Animation != null) UnityEngine.Object.Destroy(Animation);
        }
    }
}
