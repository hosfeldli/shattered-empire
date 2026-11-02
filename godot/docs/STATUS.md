# Native edition: status after the first session (2026-11-02)

Covers Phase 0 (baseline), Phase 1 (Godot foundation) and a first pass at the Section 17 vertical
slice. Everything was run on an Apple M3 MacBook (macOS 26, Godot 4.7.2 official, Forward+ on Metal)
against the real server from this branch.

## Phase 1 acceptance: met

The client connects to a real running match and shows synchronized state without creating or
changing rules. Checked by `--probe`, which runs headless and reports what was received:

- Handshake: protocol 2 with the `geo` capability accepted; 4.9 snapshots/s; local RTT 7–17 ms.
- Synchronized: map, terrain geometry (only explored hexes: 130 at the start of a fogged match, all
  16 384 in a spectated one), units, buildings, cities, weather, battlefield, fieldworks.
- Orders: a move order through the normal command path was acknowledged by the server, and the scout
  arrived at the server-chosen hex 3 hexes away. Attack-move, fortify (trench digging) and sandbox
  staging also go through server commands only.
- Picking: 918 of 918 hex picks correct (100 %) at three zoom levels over the most rugged terrain
  on the map (relief to 2.6 units), right at the east–west seam.
- Reconnect: the server was restarted mid-session. The client rejoined with its token, and the
  match resumed from its save and kept streaming.
- The server suite is 127/127 green, including 4 new tests (`test/geo.test.js`) for the handshake,
  fog filtering (unexplored and out-of-sight terrain never sent) and an unchanged protocol-1 client.

## Frame times

### Phase 0: PixiJS baseline

Built-in browser pane, 1024×768 CSS at 2× DPR, early AI match. CPU is `view.frame` plus
`renderer.render`; GPU time is not measurable from the page.

| phase | fps | interval p50 / p99 | frames > 50 ms | CPU per frame avg / p99 |
| --- | --- | --- | --- | --- |
| idle, 10 s | 60 | 16.7 / 18 ms | 0 | 1.4–2.2 / ≤ 5.3 ms |
| continuous zoom, 8 s | 45.5 | 16.7 / **283 ms** | **8** (worst 400 ms) | — |

### Godot: same early match (seed 7), 1024×768 window, medium quality

CPU is all script `_process` work, including network decode, plus the renderer's CPU time.

| phase | fps | interval p50 / p99 / max | frames > 50 ms | script avg / p99 | render CPU avg |
| --- | --- | --- | --- | --- | --- |
| idle | 58.8 | 16.7 / 30.0 / 34 ms | 0 | 1.26 / 2.95 ms | 0.47 ms |
| continuous zoom | 59.8 | 16.7 / 25.3 / 34 ms | 0 | 1.42 / 3.39 ms | 0.55 ms |
| pan across the seam | 59.4 | 16.7 / 24.9 / 27 ms | 0 | 1.64 / 2.99 ms | 0.51 ms |

High quality (soft 4k shadows, SSAO) gave practically the same figures in this scene.

### Godot: developed late scene

AI exhibition with seed 5, measured at 12.5 game-minutes at normal speed: about 300 buildings, 97
units, the biggest city in view.

| | fps | interval p50 / p99 | frames > 50 ms | script avg / p99 | render CPU |
| --- | --- | --- | --- | --- | --- |
| first version | 33–36 | 29–33 / 50 ms | 2–5 per 10 s | 3.7 / 13 ms | 1.1–1.4 ms |
| after the fixes below | 49–50 | 18 / 49–52 ms | 3–5 per 10 s | 3.1 / 14 ms | 0.8 ms |

This scene is GPU-bound. Toggling layers off showed that forest instances (especially their
shadows), about 40 separate GPU particle emitters and the sun's shadows each cost 12–14 ms. Tree
shadows now only draw close up, chimney smoke is one shared instance batch, and forests are
lighter. The p99 script spikes (about 14 ms) come from rebuilding district meshes when a
building's progress or state changes once a second.

### Caveats (read before quoting)

- **Resolution:** Godot rendered at 1× (1024×768 pixels) and PixiJS at 2× DPR (2048×1536).
- **GPU timings:** Godot's GPU timestamps read 0 on Metal here, and vsync could not be disabled,
  so absolute GPU cost is inferred from frame pacing and from toggling layers.
- **No PixiJS late-scene number:** I tried, but the browser pane was being throttled to about 1.5
  frames/s (window not in view), so that run is discarded. Repeat with the pane visible: Watch the
  AI with seed 5, speed 8 until 12 game-minutes, back to speed 1, centre on the largest city, then
  the same rAF and `zoomAt` loop.
- **Machine load:** leftover server matches on the same machine cut Godot to about 48 fps even in an
  empty scene. Benchmarks must run against a clean server (`native-bench` in `.claude/launch.json`).

## Vertical slice (Section 17): where it stands

| element | state |
| --- | --- |
| one developed city, residential / industrial / civic districts merged | done: union–find districts per group and owner, one mesh per district with shared ground and connectors (terraces, pipe runs and rail spurs, paved paths, market streets, haul tracks); 68 of 177 districts were multi-building in the late scene |
| each building individually selectable | done in code: hex pick → building id, outline ring, HUD panel. The hex picking is verified; clicking a building with the mouse was not exercised by automation |
| countryside: farms, forest, hills, river, ore deposit | done: aligned field rows, forests and scattered trees, relief with slope rock and snow, river ribbons along the server's flow directions, deposit markers by resource type |
| one bridge | done: road edges over river or water become decks on piers; 2 drawn in the late scene |
| working economy with visible activity | done: smoke from working plants and burning buildings, trucks on busy road edges (20 in the late scene), stockpiles and rates in the HUD |
| one formation that can move, defend and engage | partly: move, attack-move, hold, stance, fortify (trenches) and multi-select. Formation shapes and the `formation` command are not exposed yet |
| battlefield: trenches, artillery, craters, persistent damage | done: zigzag trenches with parapets and sandbags, craters, scorch and wrecks from the server's battlefield state; shells on ballistic arcs, flashes, tracers, dust |
| weather: moving clouds, wet terrain | done: cloud layer and cloud shadows driven by the server's fields and wind, cross-faded on updates; wet ground darker and glossier in the terrain shader. Wetness is the least visible effect so far |
| shared materials, stylized realism, one sun | done: 22 materials (timber, brick, stone, concrete, steel, glass, roof tile and slate, …) with per-vertex tint; permanent daylight from a single directional light |

## What is left

1. **Performance:**
   - LOD (fewer trees and plumes far out, impostor districts).
   - Amortized district rebuilds, so a progress tick doesn't rebuild the whole district.
   - Shadow distance tied to the view.
   - A GPU profile on hardware with timestamp support.
   - Then remeasure both clients at the same pixel count.
2. **Gameplay surface:** the PixiJS HUD is large (economy, research, cities, government, diplomacy,
   build placement, roads, trenches, air, missiles, logistics); this client has only a top bar,
   selection, notes and orders. Building placement and road drawing are the next must-haves.
3. **Art:**
   - Everything is procedural box geometry; a real look needs a modelled asset set (glTF) on the
     same material library, and textures (normal and roughness).
   - Better water (shoreline foam, flow on rivers).
   - Visible rain or wet sheen.
4. **Units:** formation shapes, health and status markers, aircraft states, naval units, death
   animations from `kill` events.
5. **Distribution:** an export preset, packaging next to the Electron app, update channel.
6. **Robustness:**
   - Large maps (256×256: about 256 chunks; build budget and memory untested).
   - Spectator follow and fog switching in the HUD.
   - Long-session memory (effects pool, tracer meshes).

## Decision gate: a candid view

The gate asks whether this is a substantial improvement over PixiJS in quality, frame time,
readability, responsiveness, asset complexity and stability. **Not yet proven; promising on the
technical axes, unproven on the visual one.**

- **Frame time / stability of pacing: better where PixiJS is weakest.**
  - Continuous zoom, panning and crossing the seam stay at 60 fps with no stalls, while PixiJS
    stalls up to 400 ms when zooming.
  - CPU per frame is a few milliseconds even in a large scene.
  - In dense late scenes it is GPU-bound at about 50 fps on an M3 at 1×, which needs LOD work
    before it can be called a win.
- **Readability:** relief, real shadows and 3D buildings make terrain, cities and battle lines read
  as places, and the merged districts make city structure legible. At far zoom it is not yet
  clearer than PixiJS's tuned 2D map (no strategic overlays or borders yet).
- **Responsiveness:** the same server round trip. Picking is exact over relief, and orders show on
  screen on the next snapshot. No regression.
- **Quality:** honestly comparable today, not superior. PixiJS has many mature visual systems built
  over time (pedestrians, traffic, ocean surface, city visuals); this slice is a well-organized
  first pass in programmer art. The upside is real, but it depends on an asset pipeline that
  doesn't exist yet.
- **Asset complexity:** the main cost. Reaching the design's quality bar means modelling and
  texturing a building and unit set, which PixiJS mostly avoids. The code side is modest: about
  4,600 lines of GDScript in 16 files, with no simulation duplicated.
- **Stability:** no script errors across many runs; it reconnects after a server restart; the
  server change is additive and covered by tests. Untested on large maps and long sessions.

**Recommendation:** don't commit to the full migration yet. Spend one more focused iteration on:

1. LOD and performance in a dense late scene, measured against PixiJS at equal pixels.
2. A small modelled asset set for one district type, to see the real quality ceiling.
3. Building placement and road drawing, to see the cost of the interaction layer.

If those three come out clearly ahead, the case for the migration is strong. If the art pass does
not, the PixiJS client remains the better investment.
