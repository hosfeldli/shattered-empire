# Watch AI Match setup (2026-11-18)

"Watch AI Match" (Training & Extras) now opens a setup page instead of starting a fixed four-AI match. It is
the **New Skirmish page itself** (`MainMenuView.BuildSetup`, `MainMenu.cs`) in a "watching" mode, so every
control, preview and validation rule is shared. The only differences are that there is no seat for you and
that the page adds two spectator options.

## What you can set

| Control | Notes |
|---|---|
| Format | 1v1, 2v2, 3v3, 4v4, FFA 3, FFA 4. The default is **FFA 4**, which is the old four-AI exhibition. |
| Nations | One row per seat (Nation N · Team T), each with its own difficulty and personality chips. ✕ leaves a seat empty for uneven sides, as long as two sides keep an AI. The number of AI nations is the format's seats minus the empty ones (2–8). |
| Every AI | Sets every AI's difficulty in one click. |
| Victory, Starting resources | The same segments as New Skirmish. |
| Watching → Match speed | 1× / 2× / 4× / 8×: the match starts at this speed. The in-match observer speed buttons still work. |
| Watching → Spectator view | **Whole map** or **Their fog of war**, the same options as the in-match observer toggle. The view starts this way. |
| Battlefield | The map picker with its preview (catalog maps filtered by format), a random world (style, size, seed with Roll and Clear), and the **Map builder** ("Use in Watch AI Match"). On a built map, the starting-base owners rows apply (MAP_BUILDER_TEAMS.md). |

Choices are remembered in PlayerPrefs under `se.watch.setup` (JSON) and saved when you press **Watch**. If a
remembered built map is gone, the page uses the builder's last sketch, or a random world if there is none.
New Skirmish keeps its own separate choices.

## Protocol (`create`, `mode: 'observe'`, action ruleset)

The client sends the New Skirmish fields with these changes:

- `ais` equals the format's seats.
- `rivals[i]` is seat *i*. There is no human seat 0.
- `closed` holds seat indices, and seat 0 is allowed.
- `speed` is 1, 2, 4 or 8.
- `fog` is a boolean.
- There is no `title`. The server names the match "AI exhibition (N empires)".

`MatchManager.checkObserve` (server/matches.js) **refuses** these impossible combinations with a reason,
where the other modes would silently fall back:

- an unknown format;
- a format the map cannot hold ("Twin Rivers has 2 starting bases; a 2v2 match needs 4…");
- an `ais` count that does not match the format, or a count outside 2–12;
- an unknown difficulty or personality (named by AI number);
- an unknown objective, starting resources, style or size;
- a speed outside 1/2/4/8;
- a fog value that is not a boolean, or a seed that is not a number;
- empty seats without a format or map, a seat that does not exist, or empty seats that leave a single side;
- base owners that leave an AI without a base.

The match stores `speed` and `observerFog` and keeps them in the snapshot meta. The worker (server/worker.js)
starts the game at that speed and sets the observer fog.

The old message (`ais: 4`, no format) is unchanged, so `-perf-soak`, `-mode observe`, `-seed`,
`-release-shots` and the legacy-ruleset exhibitions still produce the same four-AI free-for-all at 1×.

Tests: `test/observe-setup-2026-11-18.test.js`.

## In-game checklist

1. Main menu → Training & Extras → **Watch AI Match**. The wide page "Watch AI Match" opens with FFA 4, four
   Nation rows, the Watching section and the Battlefield preview. There is no Commander name field and no "You" row.
2. Press **Watch** with the defaults. A four-AI free-for-all starts at 1× on the whole map, as before.
3. Back in the menu, choose **2v2**. Four rows read "Nation 1 · Team 1" … "Nation 4 · Team 2", and the preview shows two teams.
4. Set Nation 1 to Brutal / Warlord and Nation 3 to Relaxed / Builder. Start. In the match, the observer
   nation list shows those settings.
5. ✕ on Nation 1 makes the sides read "1 v 2". ✕ on Nation 2 as well is refused ("At least two sides need an AI nation").
6. Choose a two-player catalog map and then 3v3. The format falls back to the map's own (the same rule as New Skirmish).
7. Set Match speed to 4× and Spectator view to Their fog of war. Start. The match runs at 4× behind the
   followed nation's fog, and the in-match buttons can still change both.
8. Random world: set Archipelago / Large and seed 1234. Start twice: the same world both times.
9. Map builder → Use in Watch AI Match. You return to the setup page with the custom map selected. Assign the
   bases to teams and check that the problem line matches the server refusal.
10. Quit to the menu and reopen Watch AI Match. The last choices are still selected.
11. Open New Skirmish. Its choices are separate: 1v1, a You row and the Commander name field.
12. Headless: `-perf-soak -mode observe -seed 7` and `-release-shots` still run the four-AI match.
