using System.Collections.Generic;
using SE.Runtime.Social;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    // The main menu's map builder page (MapBuilder.cs): reached from the root menu, New Skirmish's
    // Battlefield and the lobby host's rules. "Use" puts the sketch into New Skirmish as the map "custom",
    // or sends it to the lobby (server sketchMaps.js validates it and every client previews the room's copy).
    public sealed partial class MainMenuView
    {
        MapBuilderView builderView;
        MapSketch skirmishSketch, lobbySketch;
        MapCatalogEntry skirmishCustom, lobbyCustom;
        string builderFor = "root", lobbySketchKey;

        /// <summary>The catalog with the custom sketch's entry first (when there is one).</summary>
        IReadOnlyList<MapCatalogEntry> WithCustom(MapCatalogEntry custom)
        {
            if (custom == null) return maps;
            var list = new List<MapCatalogEntry>(maps.Count + 1) { custom };
            list.AddRange(maps);
            return list;
        }

        void OpenBuilder(string from)
        {
            builderFor = from;
            Go("builder");
        }

        VisualElement BuildBuilder()
        {
            var p = SubPage("Map builder");
            // continue the sketch on the bench; else the one in use here; else the last one used; else a fresh one
            var start = builderView?.Sketch ?? (builderFor == "lobby" ? lobbySketch : skirmishSketch) ?? MapSketch.Load(-1) ?? MapSketch.Default();
            builderView = new MapBuilderView(start, UseSketch, builderFor == "lobby" ? "Use in lobby" : "Use in New Skirmish", p.Footer);
            p.Content.Add(builderView);
            return p.Root;
        }

        void UseSketch(MapSketch sketch)
        {
            if (builderFor == "lobby")
            {
                lobbySketch = sketch;
                game.SendLobby(LobbyMessages.CustomMap(sketch.Encode()));
                if (pages.Pop()) SyncWide();
                SetStatus("Custom map sent to the lobby: " + sketch.Name);
                return;
            }
            skirmishSketch = sketch;
            skirmishCustom = sketch.ToEntry();
            if (pages.Pop()) SyncWide();
            if (builderFor == "root") Go("skirmish");
            OnSkirmishMap("custom");
            SetStatus("Map builder sketch in use: " + sketch.Name);
        }

        /// <summary>The room's custom sketch (server canonical) as a picker entry, rebuilt only when it changes.</summary>
        void SyncLobbySketch(MatchRoom room)
        {
            if (room == null || room.Map != "custom" || room.Sketch == null) { lobbyCustom = null; lobbySketchKey = null; return; }
            string key = room.Sketch.ToString(Newtonsoft.Json.Formatting.None);
            if (key == lobbySketchKey && lobbyCustom != null) return;
            var s = MapSketch.Decode(room.Sketch);
            lobbySketchKey = key;
            lobbyCustom = s?.ToEntry();
            if (s != null) lobbySketch = s;
        }
    }
}
