using System;
using System.Collections.Generic;
using SE.Runtime.Social;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    // The main menu's map builder page (MapBuilder.cs): reached from the root menu, New Skirmish's (and Watch
    // AI Match's) Battlefield and the lobby host's rules. "Use" puts the sketch into New Skirmish as the map "custom",
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
            builderView = new MapBuilderView(start, UseSketch, builderFor == "lobby" ? "Use in lobby" : builderFor == "watch" ? "Use in Watch AI Match" : "Use in New Skirmish", p.Footer);
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

        // ------------------------------------------------------------------ team ownership of the bases (2026-11-18)
        /// <summary>
        /// The team window's "Starting bases" block for a custom map (MAP_BUILDER_TEAMS.md): Automatic seating (the
        /// server's chooseStarts) or each base assigned to a team / left neutral. One row per base: its number (the same
        /// numbered marker the map builder and the preview show), where it stands, and its owner, which a click cycles
        /// (Team 1 … Team N, Neutral). <paramref name="changed"/> gets an edited copy; the problem line mirrors the server's
        /// refusal (every seat needs a base). Read-only when <paramref name="editable"/> is false (lobby guests).
        /// </summary>
        void BaseOwnerRows(VisualElement parent, MapSketch sketch, int seatCount, int teamSize, ulong closedMask, bool ffa, bool editable, Action<MapSketch> changed)
        {
            if (sketch == null || sketch.Bases.Count == 0) return;
            int ts = Mathf.Max(1, teamSize), teams = Mathf.Max(2, (seatCount + ts - 1) / ts);
            var block = Box("se-lobby-team", parent);
            var head = Box("se-lobby-team-head", block);
            Line("Starting bases", "se-lobby-team-title", head);
            Box("se-menu-spacer", head);
            bool owned = sketch.HasOwners;
            if (editable)
            {
                SmallButton(owned ? "Automatic" : "Assign to teams", () =>
                {
                    var next = sketch.Clone();
                    if (owned) next.Owners = null;
                    else
                    {
                        // start from the automatic seating's spirit: bases dealt round the teams in order
                        next.Owners = new int[next.Bases.Count];
                        for (int i = 0; i < next.Owners.Length; i++) next.Owners[i] = i < teams * ts ? i % teams : -1;
                    }
                    changed(next);
                }, head, owned ? "Let the server seat the players on the bases (rivals far apart)" : "Choose which team starts on each base; spare bases can stay neutral");
            }
            if (!owned)
            {
                Line("Automatic: players are seated on the bases with rivals far apart; spare bases stay neutral city ruins.", "se-menu-note", block);
                return;
            }
            for (int i = 0; i < sketch.Bases.Count; i++)
            {
                int index = i, team = sketch.Owners[i];
                var row = Box("se-ai-row", block);
                var dot = Box("se-team-dot", row);
                dot.style.backgroundColor = team < 0 ? (Color)new Color32(120, 120, 120, 255) : (Color)MapPreview.TeamColor(team);
                Line($"Base {i + 1} · {sketch.Where(i)}", "se-ai-row-name", row);
                string owner = team < 0 ? "Neutral" : MapSketch.TeamName(team, ffa);
                if (!editable) { Line(owner, "se-ai-row-tag", row); continue; }
                SmallButton(owner, () =>
                {
                    var next = sketch.Clone();
                    int t = next.Owners[index];
                    next.Owners[index] = t + 1 >= teams ? -1 : t + 1;   // Team 1 → … → Team N → Neutral → Team 1
                    changed(next);
                }, row, "Click to change who starts here: each team in turn, then neutral (a capturable city ruin)");
            }
            string problem = sketch.OwnersProblem(seatCount, ts, closedMask);
            var note = Line(problem ?? "Each team starts on its own bases, in base order; a team's spare bases and neutral bases stay city ruins.", "se-menu-note", block);
            if (problem != null) note.style.color = (Color)new Color32(232, 120, 96, 255);
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
