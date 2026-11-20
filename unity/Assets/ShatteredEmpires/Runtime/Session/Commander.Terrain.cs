using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Terrain works as paint brushes (Terrain wheel, T): pick raise / lower / flatten / smooth, then drag across the
    /// ground. The brush footprint follows the cursor; while dragging, every hex within the brush radius of the stroke
    /// is painted, the server previews which hexes it accepts (green) or skips (red) and what it costs, and releasing
    /// sends one <c>terrain</c> order for the whole stroke (<c>points</c> + <c>radius</c>). A click without a drag paints
    /// one brush footprint. [ and ] (or Ctrl + mouse wheel) change the brush radius (0–2); Page Up / Page Down (or
    /// Alt + mouse wheel) change how many height steps a raise / lower moves the ground (1–4, sent as <c>amount</c>;
    /// the price and time scale with it); Shift keeps the tool armed; right-click or Escape cancels.
    /// </summary>
    public sealed partial class Commander
    {
        static int brushRadius = 1, brushHeight = 1;
        readonly List<Vector3> brushStroke = new List<Vector3>(72);
        readonly List<int> brushCentres = new List<int>(64);
        readonly HashSet<int> brushFootprint = new HashSet<int>();
        readonly HashSet<int> brushAccepted = new HashSet<int>(), brushRefused = new HashSet<int>();
        bool brushDragging, brushHoverChecked;
        int brushToken, brushHoverTile = -1, brushSentPoints = -1, brushSentRadius = -1, brushSentHeight = -1;
        float brushPreviewAt;

        /// <summary>True while a terrain op is armed (the Terrain wheel's raise / lower / flatten / smooth).</summary>
        public bool TerrainBrushActive => Current == Mode.Target && ProtocolDecoder.Str(TargetCommand?["c"]) == "terrain";

        /// <summary>Brush radius in hexes (0: a single hex, 1: 7 hexes, 2: 19 hexes per stroke hex).</summary>
        public int TerrainBrushRadius => brushRadius;
        int MaxBrushRadius => Mathf.Clamp(ProtocolDecoder.Int(session.Defs?["RULESET"]?["terrain"]?["maxRadius"], 2), 0, 4);

        /// <summary>Height steps a raise / lower brush moves the ground (1..RULESET.terrain.maxAmount).</summary>
        public int TerrainBrushHeight => brushHeight;
        int MaxBrushHeight => Mathf.Clamp(ProtocolDecoder.Int(session.Defs?["RULESET"]?["terrain"]?["maxAmount"], 1), 1, 8);
        bool BrushHasHeight { get { string op = ProtocolDecoder.Str(TargetCommand?["op"]); return op == "raise" || op == "lower"; } }

        /// <summary>The server's last preview of the stroke (or of the brush under the cursor): op, tiles, refused, cost, seconds, afford.</summary>
        public JObject TerrainPreview { get; private set; }

        /// <summary>Why the brush stroke was refused in preview (null while some hexes are accepted; shown at the cursor).</summary>
        public string TerrainPreviewReason { get; private set; }

        void ResetBrush()
        {
            brushStroke.Clear(); brushCentres.Clear(); brushFootprint.Clear(); brushAccepted.Clear(); brushRefused.Clear();
            brushDragging = false; brushHoverChecked = false; brushHoverTile = -1; brushToken++; brushSentPoints = brushSentRadius = brushSentHeight = -1;
            TerrainPreview = null; TerrainPreviewReason = null;
            cam.BrushScroll = false;
        }

        void TerrainBrushMode(float time, bool overUi)
        {
            cam.BrushScroll = true;   // Ctrl + wheel sizes the brush instead of zooming
            switch (StrokeRightClickInput(brushDragging))   // the shared stroke rules (Commander.Action.cs)
            {
                case StrokeRightClick.EndTool: Cancel(); return;
                case StrokeRightClick.DropStroke: ResetBrush(); return;   // right-click while painting drops the stroke
            }
            int max = MaxBrushRadius;
            int size = brushRadius;
            if (InputFacade.Action("brush_smaller")) size--;
            if (InputFacade.Action("brush_larger")) size++;
            if (InputFacade.Ctrl && !overUi)
            {
                float scroll = InputFacade.Scroll;
                if (scroll > .01f) size++; else if (scroll < -.01f) size--;
            }
            size = Mathf.Clamp(size, 0, max);
            if (size != brushRadius) { brushRadius = size; RebuildFootprint(); brushHoverChecked = false; brushAccepted.Clear(); brushRefused.Clear(); }
            // the height of a raise / lower (2026-11-20): Page Up / Page Down or Alt + wheel; re-previewed for the new price
            int height = brushHeight;
            if (BrushHasHeight)
            {
                if (InputFacade.Pressed(KeyCode.PageUp)) height++;
                if (InputFacade.Pressed(KeyCode.PageDown)) height--;
                if (InputFacade.Alt && !InputFacade.Ctrl && !overUi)
                {
                    float scroll = InputFacade.Scroll;
                    if (scroll > .01f) height++; else if (scroll < -.01f) height--;
                }
            }
            height = Mathf.Clamp(height, 1, MaxBrushHeight);
            if (height != brushHeight) { brushHeight = height; brushHoverChecked = false; }

            if (!brushDragging)
            {
                // the brush follows the cursor; its footprint is previewed (throttled) so a refusal shows before clicking
                if (overUi || cam.MouseRotating || hoverTile < 0) { brushFootprint.Clear(); brushHoverTile = -1; TerrainPreviewReason = null; return; }
                if (hoverTile != brushHoverTile)
                {
                    brushHoverChecked = false;
                    brushHoverTile = hoverTile;
                    brushStroke.Clear();
                    if (cam.TryGround(InputFacade.MousePosition, out var hp)) brushStroke.Add(hp);
                    RebuildFootprint();
                    brushAccepted.Clear(); brushRefused.Clear();
                }
                if (brushStroke.Count > 0 && !brushHoverChecked && time >= brushPreviewAt) { brushHoverChecked = true; SendBrush(true, time); }
                bool start = InputFacade.LeftDown && !InputFacade.Alt;
                if (start)
                {
                    brushDragging = true;
                    brushStroke.Clear(); brushAccepted.Clear(); brushRefused.Clear();
                    if (cam.TryGround(InputFacade.MousePosition, out var p0)) brushStroke.Add(p0);
                    RebuildFootprint();
                    brushPreviewAt = 0;
                }
                else if (InputFacade.Pressed(KeyCode.Return) && brushStroke.Count > 0) { CommitBrush(time); return; }
                else return;
            }

            // painting: extend the stroke under the cursor (the server caps the hexes; the preview shows what fits)
            if (!overUi && cam.TryGround(InputFacade.MousePosition, out var p))
            {
                int before = brushStroke.Count;
                var from = before > 0 ? brushStroke[before - 1] : p;
                AppendPoint(brushStroke, p, 72, .3f);
                if (brushStroke.Count != before) AddSegment(from, p);
            }
            if (InputFacade.LeftUp || InputFacade.Pressed(KeyCode.Return)) { CommitBrush(time); return; }
            // re-preview only when the stroke or the brush changed
            if (time >= brushPreviewAt && (brushStroke.Count != brushSentPoints || brushRadius != brushSentRadius || brushHeight != brushSentHeight)) SendBrush(true, time);
        }

        void CommitBrush(float time)
        {
            if (brushStroke.Count == 0) { ResetBrush(); return; }
            SendBrush(false, time);
            if (KeepToolAfterStroke) { ResetBrush(); cam.BrushScroll = true; }
            else Cancel();
        }

        void SendBrush(bool previewOnly, float time)
        {
            if (session.Net == null || TargetCommand == null) return;
            brushPreviewAt = time + (brushDragging ? .3f : .2f);   // throttled: hover once per hex / radius, painting ~3 per second
            brushSentPoints = brushStroke.Count; brushSentRadius = brushRadius; brushSentHeight = brushHeight;
            string op = ProtocolDecoder.Str(TargetCommand["op"]);
            var points = new JArray();
            foreach (var v in brushStroke) points.Add(new JObject { ["x"] = v.x, ["z"] = v.z });
            var cmd = new JObject { ["c"] = "terrain", ["op"] = op, ["points"] = points, ["radius"] = brushRadius, ["preview"] = previewOnly };
            if (op == "raise" || op == "lower") cmd["amount"] = Mathf.Clamp(brushHeight, 1, MaxBrushHeight);
            int token = ++brushToken;
            session.Net.Command(cmd, r =>
            {
                if (!previewOnly)
                {
                    int hexes = ProtocolDecoder.Int(r.Raw?["hexes"]), skipped = ProtocolDecoder.Int(r.Raw?["skipped"]);
                    Say(ReadableError(r) ?? (hexes > 0 ? $"Terrain works ordered · {hexes} hexes" + (skipped > 0 ? $" · {skipped} skipped" : "") : "Terrain works ordered"),
                        r.Error == null, Time.unscaledTime);
                    return;
                }
                if (token != brushToken || !TerrainBrushActive) return;
                var plan = r.Raw?["terrain"] as JObject;
                TerrainPreview = plan;
                TerrainPreviewReason = ReadableError(r);
                if (TerrainPreviewReason == null && plan != null && !ProtocolDecoder.Bool(plan["afford"], true))
                    TerrainPreviewReason = $"Not enough Materials · {ProtocolDecoder.Int(plan["cost"]?["materials"])} needed";
                brushAccepted.Clear(); brushRefused.Clear();
                if (plan?["tiles"] is JArray ok) foreach (var t in ok) brushAccepted.Add((int)t);
                if (plan?["refused"] is JArray no) foreach (var t in no) brushRefused.Add((int)t);
                if (r.Error != null) foreach (var t in brushFootprint) brushRefused.Add(t);
            });
        }

        void RebuildFootprint()
        {
            brushCentres.Clear(); brushFootprint.Clear();
            var g = session.World.Grid;
            for (int i = 0; i < brushStroke.Count; i++) AddSegment(i > 0 ? brushStroke[i - 1] : brushStroke[i], brushStroke[i]);
        }

        /// <summary>The stroke hexes from a to b, sampled finely enough that a fast drag leaves no gap (as the server joins them).</summary>
        void AddSegment(Vector3 a, Vector3 b)
        {
            var g = session.World.Grid;
            float dx = g.DxWrap(a.x, b.x), dz = b.z - a.z;
            int steps = Mathf.Clamp(Mathf.CeilToInt(Mathf.Sqrt(dx * dx + dz * dz) / .4f), 1, 96);
            for (int k = 1; k <= steps; k++) AddCentre(g.TileAt(a.x + dx * k / steps, a.z + dz * k / steps));
            if (steps == 1) AddCentre(g.TileAt(a.x, a.z));
        }

        void AddCentre(int tile)
        {
            if (tile < 0 || brushCentres.Contains(tile)) return;
            brushCentres.Add(tile);
            // the hexes within brushRadius of the centre (breadth-first over the neighbours)
            var g = session.World.Grid;
            var ring = new List<int> { tile };
            brushFootprint.Add(tile);
            for (int step = 0; step < brushRadius; step++)
            {
                var next = new List<int>();
                foreach (int t in ring)
                    for (int d = 0; d < 6; d++)
                    {
                        int n = g.Neighbor(t, d);
                        if (n >= 0 && brushFootprint.Add(n)) next.Add(n);
                    }
                ring = next;
            }
        }

        /// <summary>The brush footprint: hexes the server accepted (green), skipped (red) or not yet checked (amber).</summary>
        void DrawTerrainBrush(float time)
        {
            if (!TerrainBrushActive || brushFootprint.Count == 0) return;
            var w = session.World;
            var g = w.Grid;
            float pulse = .5f + .5f * Mathf.Sin(time * 6f);
            var accepted = new float4(.38f, .92f, .64f, .42f + .12f * pulse);
            var refused = new float4(1f, .31f, .23f, .55f);
            var pending = new float4(.98f, .72f, .27f, .38f);
            foreach (int t in brushFootprint)
            {
                var col = brushAccepted.Contains(t) ? accepted : brushRefused.Contains(t) ? refused : pending;
                float x = g.CenterX(t), z = g.CenterZ(t);
                discs.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + .03f, z)), 0, new float3(1.5f, 1f, 1.5f), col));
            }
            // the stroke itself, and a ring on the brush centre under the cursor
            foreach (int t in brushCentres)
            {
                float x = g.CenterX(t), z = g.CenterZ(t);
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + .04f, z)), 0, new float3(.7f), new float4(1f, .95f, .8f, .8f)));
            }
        }

        /// <summary>The tool chip's cost line: the previewed stroke's price and size, or the list price per brush.</summary>
        public string TerrainBrushChipText()
        {
            int size = brushRadius;
            string keys = InputFacade.KeyLabel("brush_smaller") + " " + InputFacade.KeyLabel("brush_larger") + " size " + (size + 1);
            if (BrushHasHeight) keys += " · PgUp PgDn height " + brushHeight + "/" + MaxBrushHeight;
            var plan = TerrainPreview;
            if (plan == null || brushFootprint.Count == 0) return keys;
            int hexes = (plan["tiles"] as JArray)?.Count ?? 0, skipped = (plan["refused"] as JArray)?.Count ?? 0;
            int cost = ProtocolDecoder.Int(plan["cost"]?["materials"]);
            float seconds = ProtocolDecoder.Float(plan["seconds"]);
            string text = $"{cost} Materials · {hexes} hexes" + (skipped > 0 ? $" ({skipped} skipped)" : "") + (seconds > 0 ? $" · {seconds:0}s" : "");
            if (ProtocolDecoder.Bool(plan["truncated"])) text += " · stroke full";
            return text + " · " + keys;
        }
    }
}
