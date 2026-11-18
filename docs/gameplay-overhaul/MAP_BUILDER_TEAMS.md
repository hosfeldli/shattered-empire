# Map builder: team ownership of the starting bases (2026-11-18)

**User request:** "Have a system where you can, after building a map in the team window, change the team ownership of starting bases."

**Code**
- Server:
  - `server/sim/sketchMaps.js`: `parseSketch` accepts `owners`. New exports: `baseOwnersProblem`, `sketchForTeams`, `ownedStarts`. `sketchPreview` includes `startOwners`.
  - `server/sim/actionMap.js`: one line in `buildActionMap`.
  - `server/matches.js`: `create` and `start`.
- Client:
  - `Runtime/UI/MapBuilder.cs` (`MapSketch.Owners`, `HasOwners`, `SyncOwners`, `OwnersProblem`, `Where`; builder markers in team colours)
  - `Runtime/UI/MapPreview.cs` (`MapPreviewData.StartOwners`, `MapPreview.OwnedStarts`; seated preview)
  - `Runtime/UI/MainMenu.Builder.cs` (`BaseOwnerRows`)
  - `Runtime/UI/MainMenu.cs` (the rows in the New Skirmish team panel and the lobby)

**Tests:** `test/map-builder-teams-2026-11-18.test.js`.

## Wire

The sketch (`create { map:'custom', sketch }` and the lobby's `{ t:'map', map:'custom', sketch }`) may carry an optional field:

```
owners: [team | -1, ...]   // one entry per base, in base order
```

- **team** is the lobby team, 0-based: seat index / team size. In a free-for-all, each player is their own team.
- **-1** means the base stays neutral, as a capturable city ruin.
- **No `owners`, or all -1,** means automatic seating as before (`chooseStarts` over the sketch metrics).
- **Validation (`parseSketch`):** an array of exactly one integer per base, each from -1 to 7. Anything else refuses the sketch ("Map sketch: owners must give one team per base").
- The canonical sketch keeps `owners`, so the room, saves and `meta` carry it to every client.

## Rules

- **Seating:** the k-th player of team T, in seat order, starts on T's k-th base, in base order.
  - A team's surplus bases stay neutral.
  - Neutral bases are never starts.
  - Each player still gets exactly one starting HQ and army.
- **Validation (`baseOwnersProblem(sketch, slots, teamSize)`):**
  - Every team with an active (not closed) seat needs at least as many bases as it has active seats. This keeps at least one base per seat.
  - A base may not name a team the format does not have.

  The refusals read:
  - "Team 2 has 2 players but only 1 starting base: give every player a base in the team window."
  - "Base 3 belongs to Team 3, which this format does not have: reassign it in the team window."
  - In a free-for-all of three or more, "Player N" replaces "Team N".
- **When it is checked:**
  - **New Skirmish `create`** refuses at once.
  - **The lobby `map` message accepts an unfinished assignment.** The host edits one base at a time, and every client shows the same warning under the rows.
  - **`start`** re-checks, because seats and formats may have changed. It refuses before anything starts, and the lobby stays a lobby.
- **Closed seats:** when closed seats leave, `dropClosed` renumbers the teams in order. `sketchForTeams` renumbers `owners` the same way before the sketch goes to the worker. A base of a team that has no seat left becomes neutral.
- **The simulation:** `buildActionMap` uses `ownedStarts(sketch.owners, civ teams)` in place of `chooseStarts` when `owners` is present. Everything else is unchanged: base placement, neutral cities and outposts.

## Client: the team window

The "Starting bases" block appears in two places:
- under the seats in **New Skirmish**, when the map is the builder's custom map;
- under the teams in the **lobby**, when the room's map is `custom`.

What it shows:
- **Header button.** "Assign to teams" or "Automatic". Assigning starts from a round-robin deal (base i goes to team i mod teams, and bases beyond the seat count are neutral).
- **One row per base.** Each row has a team-colour dot, "Base 3 · north-east" (the same number the builder's markers show), and a button with the owner. A click cycles Team 1 → … → Team N → Neutral → Team 1.
- **Lobby edits.** Only the host can edit. Each click sends the edited sketch as the room's custom map, and guests see the owners read-only.
- **Problem line.** It mirrors `baseOwnersProblem` word for word, in red while the assignment cannot start.
- **Seated preview.** The map picker draws each base in its owner's team colour (`MapPreview.OwnedStarts`, which mirrors the server). Spare bases are drawn as hollow neutral rings. The builder canvas colours its numbered base markers by owner too, and neutral ones grey.
- **Builder edits.** Adding a base in the builder while bases are assigned makes it neutral. Removing one drops its entry.
