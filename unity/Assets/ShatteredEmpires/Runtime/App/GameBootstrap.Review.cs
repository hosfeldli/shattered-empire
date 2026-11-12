using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace SE.Runtime.App
{
    public sealed partial class GameBootstrap
    {
        bool reviewStarted, reviewCapturing;
        IEnumerator ReviewScenes()
        {
            string directory = opts.Get("review");
            Directory.CreateDirectory(directory);
            // The opening camera owns its full descent. Reviewing before it finishes
            // lets that animation re-enable input and overwrite the review camera.
            while (terrain.DirtyCount > 0 || phase == Phase.Playing && descentT >= 0) yield return null;
            rts.FollowTarget = null;
            rts.UserControl = false;
            reviewCapturing = true;
            var frames = new List<(string name, Vector3 focus, float distance)>();
            if (phase == Phase.Menu) frames.Add(("menu", rts.Focus, rts.Distance));
            else
            {
                var g = session.World.Grid;
                int start = session.Welcome.Start >= 0 ? session.Welcome.Start : arena;
                if (start < 0) start = g.N / 2;
                var home = new Vector3(g.CenterX(start), 0, g.CenterZ(start));
                frames.Add(("01_headquarters_tactical", home, 7));
                frames.Add(("01b_headquarters_architecture", home, 3.3f));
                frames.Add(("02_base_operational", home, 12));
                foreach (var site in session.Objectives.Values) if (site.IsBase && site.Owner < 0 && !site.Memory)
                {
                    frames.Add(("03_city_ruins", new Vector3(site.X, 0, site.Z), 9));
                    frames.Add(("03d_ruin_architecture", new Vector3(site.X, 0, site.Z), 3.2f));
                    break;
                }
                int bank = -1, crossing = -1;
                float nearestBank = float.MaxValue, nearestCrossing = float.MaxValue;
                for (int tile = 0; tile < g.N; tile++)
                {
                    if (session.World.Known[tile] == 0) continue;
                    float dx = g.DxWrap(home.x, g.CenterX(tile)), dz = g.CenterZ(tile) - home.z;
                    float d = dx * dx + dz * dz;
                    if (session.World.IsLake(tile) && d < nearestBank) { bank = tile; nearestBank = d; }
                    if (session.World.IsRiver(tile) && session.World.Road[tile] != 0 && d < nearestCrossing) { crossing = tile; nearestCrossing = d; }
                }
                if (bank >= 0) frames.Add(("08_lake_and_banks", new Vector3(g.CenterX(bank), 0, g.CenterZ(bank)), 4.8f));
                if (crossing >= 0) frames.Add(("09_river_crossing", new Vector3(g.CenterX(crossing), 0, g.CenterZ(crossing)), 4.2f));
                int i = 0; float x = 0, z = 0;
                foreach (var id in session.Units.SlotOf.Keys)
                    if (units.TryGetPosition(session.Units, id, out var p)) { x += p.x; z += p.y; if (++i >= 48) break; }
                if (i > 0)
                {
                    var battle = new Vector3(x / i, 0, z / i);
                    frames.Add(("04_army_tactical", battle, 5));
                    frames.Add(("05_combined_arms", battle, 17));
                    frames.Add(("06_strategic", battle, 85));
                    frames.Add(("07_battlefield_aftermath", battle, 8));
                }
                foreach (var id in session.Units.SlotOf.Keys) if (session.Units.TryGet(id, out var unit) && session.Units.Types.Name(unit.TypeIndex) == "tank" && units.TryGetPosition(session.Units, id, out var armor))
                { frames.Insert(3, ("03b_armor_detail", new Vector3(armor.x, 0, armor.y), 2.8f)); break; }
                foreach (var id in session.Units.SlotOf.Keys) if (session.Units.TryGet(id, out var unit) && session.Units.Types.Name(unit.TypeIndex) == "rifle_squad" && units.TryGetPosition(session.Units, id, out var infantry))
                { frames.Insert(4, ("03c_infantry_detail", new Vector3(infantry.x, 0, infantry.y), 2.5f)); break; }
            }
            foreach (var frame in frames)
            {
                if (frame.name.Contains("armor_detail") || frame.name.Contains("infantry_detail"))
                {
                    string type = frame.name.Contains("armor_detail") ? "tank" : "rifle_squad";
                    foreach (var id in session.Units.SlotOf.Keys)
                        if (session.Units.TryGet(id, out var u) && u.Owner == session.CivId && session.Units.Types.Name(u.TypeIndex) == type && units.TryGetPosition(session.Units, id, out var p))
                        { rts.Focus = new Vector3(p.x, 0, p.y); break; }
                }
                else rts.Focus = frame.focus;
                rts.Distance = rts.TargetDistance = frame.distance;
                rts.Yaw = -22; rts.Apply();
                yield return new WaitForSecondsRealtime(frame.name.Contains("aftermath") ? 12 : 3);
                yield return new WaitForEndOfFrame();
                CaptureReviewFrame(Path.Combine(directory, frame.name + ".png"));
                if (frame.name == "02_base_operational" || frame.name == "03_city_ruins")
                {
                    var site = session.Objectives.Values.Where(s => s.IsBase).OrderBy(s => (s.X - frame.focus.x) * (s.X - frame.focus.x) + (s.Z - frame.focus.z) * (s.Z - frame.focus.z)).FirstOrDefault();
                    if (site.Id > 0) commander.SelectObjective(site.Id);
                    yield return CaptureReviewHud(Path.Combine(directory, frame.name + "_hud.png"));
                    if (frame.name == "02_base_operational" && site.Owner == session.CivId && site.Slots?.Length > 0)
                    {
                        commander.SelectRingSlot(site.Id, site.Slots[0]);
                        yield return CaptureReviewHud(Path.Combine(directory, "02b_ring_construction_hud.png"));
                        commander.PreviewRingFacility(site.Id, site.Slots[0], "depot");
                        yield return new WaitForSecondsRealtime(.4f);
                        CaptureReviewFrame(Path.Combine(directory, "02c_ring_facility_preview.png"));
                        commander.ClearRingPreview();
                    }
                }
                if (frame.name == "05_combined_arms")
                {
                    commander.SelectProduction(System.Array.Empty<int>());
                    foreach (int id in session.Units.SlotOf.Keys)
                        if (units.Selected.Count < 12 && session.Units.TryGet(id, out var u) && u.Owner == session.CivId) units.Selected.Add(id);
                    yield return CaptureReviewHud(Path.Combine(directory, frame.name + "_hud.png"));
                    if (!session.Spectator)
                    {
                        commander.BeginFieldConstruction("bunker");
                        yield return CaptureReviewHud(Path.Combine(directory, "05b_field_construction_context.png"));
                        commander.Cancel();
                    }
                }
                yield return new WaitForSecondsRealtime(.5f);
            }
            foreach (var b in session.Structures.Buildings.Values.Where(b => b.HasPosition && b.Done && b.Owner == session.CivId && b.Type != "town" && b.Type != "depot" && b.Type != "barracks").GroupBy(b => b.Type).Select(g => g.First()).ToArray())
            {
                rts.Focus = new Vector3(b.X, 0, b.Z); rts.Distance = rts.TargetDistance = 3.6f; rts.Apply();
                commander.SelectProduction(new[] { b.Id });
                yield return new WaitForSecondsRealtime(2.5f);
                CaptureReviewFrame(Path.Combine(directory, "10_facility_" + b.Type + ".png"));
                yield return CaptureReviewHud(Path.Combine(directory, "10_facility_" + b.Type + "_hud.png"));
            }
            Debug.Log("Unity visual review captured to " + Path.GetFullPath(directory));
            reviewCapturing = false; rts.UserControl = true;
            if (opts.Get("review-quit", "1") != "0") Application.Quit();
            else rts.UserControl = true;
        }

        IEnumerator ReviewIntroScenes()
        {
            string directory = opts.Get("review-intro"); Directory.CreateDirectory(directory);
            for (int beat = 0; beat < 8 && phase == Phase.Intro; beat++)
            {
                while (phase == Phase.Intro && intro != null && (intro.Beat < beat || intro.BeatProgress < .64f)) yield return null;
                if (phase != Phase.Intro || intro == null) break;
                yield return new WaitForEndOfFrame();
                CaptureReviewFrame(Path.Combine(directory, "intro_" + (beat + 1) + ".png"));
                yield return CaptureReviewHud(Path.Combine(directory, "intro_" + (beat + 1) + "_captions.png"));
                while (phase == Phase.Intro && intro != null && intro.Beat == beat) yield return null;
            }
            yield return new WaitForSecondsRealtime(4);
            CaptureReviewFrame(Path.Combine(directory, "menu_world.png"));
            yield return CaptureReviewHud(Path.Combine(directory, "menu_interface.png"));
            Debug.Log("Unity cinematic review captured to " + Path.GetFullPath(directory));
            if (opts.Get("review-quit", "1") != "0") Application.Quit();
        }

        IEnumerator CaptureReviewHud(string path)
        {
            if (uiDocument == null || uiDocument.panelSettings == null) yield break;
            var ps = uiDocument.panelSettings; var previous = ps.targetTexture;
            var ui = RenderTexture.GetTemporary(1920, 1080, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            bool clear = ps.clearColor; Color clearValue = ps.colorClearValue;
            ps.targetTexture = ui; ps.clearColor = true; ps.colorClearValue = Color.clear;
            yield return new WaitForEndOfFrame(); yield return new WaitForEndOfFrame();
            CaptureReviewFrame(path, ui);
            ps.targetTexture = previous; ps.clearColor = clear; ps.colorClearValue = clearValue;
            RenderTexture.ReleaseTemporary(ui);
        }

        void CaptureReviewFrame(string path, RenderTexture ui = null)
        {
            // A hidden desktop window has no readable swap chain. Render the actual gameplay
            // camera through URP into an explicit target instead; use the same scene and quality.
            var target = RenderTexture.GetTemporary(1920, 1080, 24, RenderTextureFormat.ARGB32);
            var before = RenderTexture.active;
            float aspect = rts.Cam.aspect;
            var pixels = new Texture2D(1920, 1080, TextureFormat.RGB24, false);
            try
            {
                rts.Cam.aspect = 1920f / 1080f;
                RenderPipeline.SubmitRenderRequest(rts.Cam, new UniversalRenderPipeline.SingleCameraRequest { destination = target });
                if (ui != null)
                {
                    var composite = new Material(Resources.Load<Shader>("Shaders/ReviewComposite"));
                    Graphics.Blit(ui, target, composite); Destroy(composite);
                }
                RenderTexture.active = target;
                pixels.ReadPixels(new Rect(0, 0, 1920, 1080), 0, 0); pixels.Apply();
                File.WriteAllBytes(path, pixels.EncodeToPNG());
            }
            finally
            {
                rts.Cam.aspect = aspect;
                RenderTexture.active = before;
                RenderTexture.ReleaseTemporary(target); Destroy(pixels);
            }
        }
    }
}
