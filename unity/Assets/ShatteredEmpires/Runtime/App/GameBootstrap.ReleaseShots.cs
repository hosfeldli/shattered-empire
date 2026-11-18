using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using Unity.Mathematics;

namespace SE.Runtime.App
{
    /// <summary>
    /// Release-notes screenshots (docs/RELEASING.md; inert unless launched with -release-shots):
    ///   -release-shots FOLDER       where the PNGs go (e.g. docs\releases\0.5.0)
    ///   -release-shots-wait MIN     real minutes the observed match develops first (default 6, at 4x speed)
    /// Starts an AI-only observe match (seed 7 unless -seed is given), lets it develop, then frames a fixed list of
    /// views and writes each as a 1280x720 PNG of the game camera without the interface (re-encoded with fewer
    /// colour bits, then at 960x540, until it is under 580 KB, so it fits the release-notes image cap). A view with
    /// nothing to show (no IFV built yet, no trench dug) is skipped and logged ("RELEASE-SHOTS ..."). Then it quits.
    /// </summary>
    public sealed partial class GameBootstrap
    {
        const long ShotMaxBytes = 580 * 1024;
        bool shotsStarted;

        /// <summary>Awake: -release-shots implies an observe match with seed 7 (both can be overridden).</summary>
        void PrepareReleaseShots()
        {
            if (!opts.Has("release-shots")) return;
            opts.Default("mode", "observe");
            opts.Default("seed", "7");
        }

        void StepReleaseShots()
        {
            if (shotsStarted || !opts.Has("release-shots")) return;
            if (phase != Phase.Playing || session.Snapshots < 8) return;
            shotsStarted = true;
            StartCoroutine(ReleaseShots());
        }

        IEnumerator ReleaseShots()
        {
            string dir = opts.Get("release-shots");
            if (string.IsNullOrEmpty(dir) || dir == "1") dir = Path.Combine(Application.persistentDataPath, "release-shots");
            Directory.CreateDirectory(dir);
            float wait = Mathf.Max(0f, opts.Float("release-shots-wait", 6f)) * 60f;
            if (session.Spectator) session.Net?.ObserverCommand(new Newtonsoft.Json.Linq.JObject { ["c"] = "speed", ["speed"] = 4 });
            Debug.Log($"RELEASE-SHOTS waiting {wait / 60f:0.#} real minutes for the match to develop -> {Path.GetFullPath(dir)}");
            float until = Time.realtimeSinceStartup + wait;
            while (Time.realtimeSinceStartup < until) yield return null;
            while (terrain.DirtyCount > 0 || descentT >= 0) yield return null;
            rts.FollowTarget = null;
            rts.UserControl = false;
            reviewCapturing = true;
            var g = session.World.Grid;
            var taken = new List<string>(); var skipped = new List<string>();

            // the most developed held base
            var bases = session.Objectives.Values.Where(s => s.IsBase && s.Owner >= 0 && !s.Memory)
                .OrderByDescending(s => s.Tier).ThenByDescending(s => s.DefenseCount).ThenByDescending(s => s.Tenure).ToList();
            Vector3? basePos = bases.Count > 0 ? new Vector3(bases[0].X, 0, bases[0].Z) : (Vector3?)null;

            // a finished defence on or beside a road
            Vector3? roadDefence = null;
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (!b.Done || !IsDefence(b.Type) || b.Tile < 0 || b.Tile >= g.N) continue;
                bool road = session.World.Road[b.Tile] != 0;
                for (int d = 0; d < 6 && !road; d++) { int nb = g.Neighbor(b.Tile, d); road = nb >= 0 && session.World.Road[nb] != 0; }
                if (!road) continue;
                roadDefence = b.HasPosition ? new Vector3(b.X, 0, b.Z) : new Vector3(g.CenterX(b.Tile), 0, g.CenterZ(b.Tile));
                break;
            }

            // the trench node with the most links (a junction reads best)
            Vector3? trench = null; int bestLinks = -1;
            foreach (var t in session.Trenches)
            {
                if (!t.Built || !t.HasPosition) continue;
                int links = math.countbits(t.Route & 63);
                if (links > bestLinks) { bestLinks = links; trench = new Vector3(t.X, 0, t.Z); }
            }

            // a river reach near the base (not a bridge)
            Vector3? river = null; float nearest = float.MaxValue;
            var near = basePos ?? new Vector3(g.CenterX(g.N / 2), 0, g.CenterZ(g.N / 2));
            for (int tile = 0; tile < g.N; tile++)
            {
                if (!session.World.IsRiver(tile) || session.World.Road[tile] != 0) continue;
                float dx = g.DxWrap(near.x, g.CenterX(tile)), dz = g.CenterZ(tile) - near.z, dd = dx * dx + dz * dz;
                if (dd < nearest) { nearest = dd; river = new Vector3(g.CenterX(tile), 0, g.CenterZ(tile)); }
            }

            // the densest crater field (most impacts within 1.5 units of one impact)
            Vector3? craters = null; int bestCount = 0;
            var impacts = session.Battlefield.Impacts;
            for (int i = 0; i < impacts.Length; i += System.Math.Max(1, impacts.Length / 400))
            {
                int c = 0;
                for (int k = 0; k < impacts.Length; k++)
                {
                    float dx = g.DxWrap(impacts[i].X, impacts[k].X), dz = impacts[k].Z - impacts[i].Z;
                    if (dx * dx + dz * dz < 2.25f) c++;
                }
                if (c > bestCount) { bestCount = c; craters = new Vector3(impacts[i].X, 0, impacts[i].Z); }
            }

            // units: an IFV (exo_infantry) if one is on the map, and the busiest block for an army view
            Vector3? ifv = null;
            foreach (var id in session.Units.SlotOf.Keys)
                if (session.Units.TryGet(id, out var u) && session.Units.Types.Name(u.TypeIndex) == "exo_infantry" && units.TryGetPosition(session.Units, id, out var p))
                { ifv = new Vector3(p.x, 0, p.y); break; }
            int busy = BusiestTile();
            Vector3? army = session.Units.Count > 0 ? new Vector3(g.CenterX(busy), 0, g.CenterZ(busy)) : (Vector3?)null;

            var views = new List<(string file, Vector3? at, float distance, bool blast)>
            {
                ("base_closeup.png", basePos, 3.6f, false),
                ("base_overview.png", basePos, 9f, false),
                ("defenses_road.png", roadDefence, 2.4f, false),
                ("trenches.png", trench, 2.0f, false),
                ("river.png", river, 5f, false),
                ("crater_field.png", craters, 3.4f, false),
                ("units_ifv.png", ifv, 1.6f, false),
                ("army.png", army, 6f, false),
                ("shockwave.png", craters ?? army ?? basePos, 4f, true),
            };
            foreach (var v in views)
            {
                if (!v.at.HasValue) { skipped.Add(v.file); Debug.Log("RELEASE-SHOTS skipped " + v.file + " (nothing on the map to frame)"); continue; }
                rts.Focus = v.at.Value;
                rts.Distance = rts.TargetDistance = v.distance;
                rts.Yaw = -22; rts.Apply();
                yield return new WaitForSecondsRealtime(3f);
                while (terrain.DirtyCount > 0) yield return null;
                if (v.blast)
                {
                    // a staged, client-only blast: the heavy-explosion shock front is what the shot shows
                    var ground = v.at.Value; ground.y = session.World.GroundHeight(ground.x, ground.z);
                    fx.Explosion(new float3(ground.x, ground.y, ground.z), 1.4f);
                    yield return new WaitForSecondsRealtime(.18f);
                }
                yield return new WaitForEndOfFrame();
                long bytes = CaptureReleaseShot(Path.Combine(dir, v.file));
                taken.Add($"{v.file} ({bytes / 1024} KB)");
                yield return new WaitForSecondsRealtime(.3f);
            }
            Debug.Log($"RELEASE-SHOTS done: {taken.Count} captured [{string.Join(", ", taken)}], {skipped.Count} skipped [{string.Join(", ", skipped)}] -> {Path.GetFullPath(dir)}");
            reviewCapturing = false; rts.UserControl = true;
            if (!Application.isEditor) Application.Quit();
        }

        /// <summary>Render the game camera (no interface) to a PNG under <see cref="ShotMaxBytes"/>; returns its size.</summary>
        long CaptureReleaseShot(string path)
        {
            byte[] png = null;
            foreach (var (w, h) in new[] { (1280, 720), (960, 540) })
            {
                var pixels = RenderShot(w, h);
                for (int bits = 8; bits >= 5; bits--)
                {
                    var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
                    tex.SetPixels32(Quantize(pixels, bits)); tex.Apply();
                    png = tex.EncodeToPNG(); Destroy(tex);
                    if (png.Length <= ShotMaxBytes) { File.WriteAllBytes(path, png); return png.Length; }
                }
            }
            File.WriteAllBytes(path, png);   // still too large: the validator will say so
            Debug.LogWarning($"RELEASE-SHOTS {Path.GetFileName(path)} is {png.Length / 1024} KB (over the cap)");
            return png.Length;
        }

        Color32[] RenderShot(int w, int h)
        {
            var target = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            target.antiAliasing = 1;
            var before = RenderTexture.active;
            float aspect = rts.Cam.aspect;
            var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
            try
            {
                rts.Cam.aspect = w / (float)h;
                RenderPipeline.SubmitRenderRequest(rts.Cam, new RenderPipeline.StandardRequest { destination = target });
                RenderTexture.active = target;
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0); tex.Apply();
                return tex.GetPixels32();
            }
            finally
            {
                rts.Cam.aspect = aspect;
                RenderTexture.active = before;
                RenderTexture.ReleaseTemporary(target); Destroy(tex);
            }
        }

        static Color32[] Quantize(Color32[] src, int bits)
        {
            if (bits >= 8) return src;
            var dst = new Color32[src.Length];
            int drop = 8 - bits; byte mask = (byte)(0xFF << drop), half = (byte)(1 << (drop - 1));
            for (int i = 0; i < src.Length; i++)
            {
                var c = src[i];
                dst[i] = new Color32(Q(c.r), Q(c.g), Q(c.b), 255);
            }
            return dst;
            byte Q(byte v) => (byte)System.Math.Min(255, (v & mask) | half);
        }
    }
}
