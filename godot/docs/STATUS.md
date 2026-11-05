# Native edition: status

## Streamlined native redesign and water revision

See [NATIVE_REDESIGN.md](NATIVE_REDESIGN.md) for the new ruleset, eight-workspace UI, complete
trading removal, ordered trenches and water/atmosphere implementation. This replaces the earlier
government/diplomacy parity goals. Current visual artifacts are in `ui-validation/` and
`water-validation/`; use each JSON report's source hash and fixture notes when interpreting them.
Production remains gated by [RELEASE_GATES.md](RELEASE_GATES.md).

## Living World Engine checkpoint (2026-11-04)

**Godot is the sole development target.** The browser/Electron sources are reference only.
[LWE_REQUIREMENTS.md](LWE_REQUIREMENTS.md) is the requirement-by-requirement implementation and
acceptance checklist for the complete design and subsequent corrections. The complete engine
and production-quality review have **not** passed all gates.

Implemented native foundations now include:

- A shared authorized-state adapter, semantic graph, recipe registry, deterministic purpose seeds,
  bounded generation scheduler, site planner, weather context and LOD budgets.
- Blender-authored residential GLBs and military components, original PBR material maps/audio,
  stable irregular housing/parcel layouts, slope-aware foundations and river setbacks. Broad
  building plates are removed; decorative connections do not invent crossings.
- Atomic district mesh handoffs and shared wrapped instances, fixed-pitch zoom, stable terrain
  instances and safe optional terrain overlay reads.
- Native building/road/rail/bridge/trench/deployment/training controls; selection, attack/movement,
  empire workspace tabs, strategic lenses/labels, minimap and F4 composition diagnostics. Detailed
  panel parity, a complete army/economy workspace and final UX polish remain open.
- Bounded decorative civilian activity, modular military poses/turrets, event-driven combat/audio,
  continuous battlefield scars and shared wetness/wind. These are first passes; full animation,
  material-specific destruction, historical growth and regional ecology are incomplete.
- Separate native CI checks and local Windows/macOS development exports. No `deploy.yml` change,
  public upload, project signing/notarization or Windows runtime acceptance has occurred.

### Reload/ground investigation

The user narrowed the disappearance to city-center hexes in the Godot window, then supplied a
desktop screenshot showing a broad blue surface after world reload. Pink/purple unexplored space
was also reported after reload. The visual validation driver had temporarily used a magenta
background to detect holes; that diagnostic change is removed, and test windows are named clearly.

World reset now invalidates height caches, clears old economic/weather/path state and cancels
stale overlay/battlefield/weather presentation. Optional fog texture reads are bounds checked.
Completing a building now invalidates the local urban soil tint, which previously changed only
after reconnecting. A real-server same-match rejoin test compares received geometry/visibility
and rendered land colors, then repeats close zoom over city-center hexes. Keep the original
blue-ground report open for user confirmation if it cannot be reproduced in the current build;
the reset hardening and passing checks are evidence, not proof of its exact original cause.

### Validation and performance evidence

Headless checks: rendering 43, composition 33, LWE 62 (138 total). Server suite: 127/127 pass;
server sources are unchanged. Real-server checks exercise placement,
construction, individual selection, training, roads, trenches, deployment and a built bridge.
Rendered evidence and reload results are recorded in `lwe-validation/validation.json`.
The current rendered run passes 20 checks, including 2,520 city-center samples before reload,
2,520 after reload and 53 matching land-color samples across the rejoin. Both received geometry
and visibility match the paused match's original state; the runtime-source hash stayed constant.
`lwe-validation/terrain-zoom.json` records 6,525 actual M3 GPU terrain samples with no holes across
zoom levels, eased zoom, viewport shapes, invalidation and horizontal wrapping.

Earlier provisional 1920×1080 runs are retained as dated checkpoints, **not current-source final
acceptance**. `lwe-godot-1080p-final.json` is an earlier filename, despite the word “final”:

| checkpoint | mean FPS across idle/zoom/pan | script p99 (ms) | frame interval p99 (ms) |
| --- | --- | --- | --- |
| native late, earlier optimized slice | ~60 / ~60 / ~60 | 8.48 / 9.71 / 13.76 | 21.61 / 22.38 / 23.52 |
| native 256×256, earlier slice | ~60 / ~60 / ~60 | 10.45 / 10.95 / 11.08 | 22.91 / 23.15 / 22.24 |
| current native reload checkpoint, late | 59.90 / 59.90 / 60.00 | 5.04 / 13.25 / 13.98 | 22.04 / 30.40 / 27.44 |

`lwe-native-reload-1080p.json` records the current-source late scene, including its source hash and
`source_changed_during_run: false`: 277.89 MB static memory, maximum terrain build slice 3.08 ms
including warmup, GPU timing unavailable. Current zoom/pan p99 results still exceed strict targets.

The late scene is seeded and staged identically to the original benchmark. Desktop activity was
present. GPU timestamps on this Metal setup report zero/unavailable, and Xcode frame capture is
not available with only Command Line Tools installed. Strict CPU/chunk p99 targets, quiet-machine
GPU measurement, sustained combat/load, integrated-GPU fallback and long-session stability remain
open. Do not infer these gates from average 60 FPS. Asset production hours and the full art budget
also remain unmeasured; the reproducible authored-source pipeline is not an estimate of them.

### Distribution and remaining gates

`node tools/build-native.mjs --platform=all --smoke` produces local development artifacts and a
source/hash manifest under ignored `dist/native/`, checks the macOS ad-hoc signature and exercises
the embedded native pack. The current build completed for both targets with unchanged runtime
source hash; macOS embedded-pack command/reload checks passed, as did a server-restart test with
two connections, 120 snapshots, a completed move and correct picking. Windows execution requires
a Windows machine. Trusted signing,
notarization, public opt-in distribution and a full default-release cycle are future gates.

The next integrated acceptance scenario remains the complete river-valley city and adjoining
battlefield from design §29, including mountains/mine, economic activity, upgrade/destruction,
weather, reconstruction and reload continuity. See the contract for gaps in every subsystem.

## Historical Part A checkpoint (2026-11-03)

The remainder of this document preserves the original measurements and starting-state assessment;
“not started” entries below describe that historical checkpoint, not current implementation.

The prototype is still a native Godot client. The browser window used by `bench:pixi` is the
existing shipping client, measured as the control. No server rules, balance, protocol formats or
deployment workflows changed in this iteration. **The migration gate has not passed.**

The reported zoom stretching came from changing the camera pitch from 50° to 80° as the zoom
changed. Zoom now keeps a fixed 60° pitch and preserves the cursor anchor. Regression checks project
perpendicular ground vectors at five zoom levels and verify that their proportions stay constant.

| step | state | remaining acceptance work |
| --- | --- | --- |
| A1 | harnesses and equal-pixel comparison implemented | real GPU timings; repeat on a quiet machine |
| A2 | renderer optimizations implemented, acceptance still open | strict script-p99 and chunk-budget targets must pass reliably |
| A3 | not started | modelled residential assets, comparison images, actual hours and budget judgement |
| A4 | not started | placement, roads, bridges, trenches, formations and training in the native HUD |
| A5 | not passed | full quality/readability/responsiveness/asset/stability review, including the two-hour session |

### Repeatable measurements

`npm run bench:pixi` and `npm run bench:godot` each own an isolated port-8139 server and restart it
between scenes. Early: seed 7 with one warlord rival. Late: seed 5 with warlord, merchant and builder,
speed 8 until 720 game-seconds, then speed 1, centred on the largest city. Each phase lasts ten
seconds. The common zoom sweep covers native camera sizes 16–110 (converted to Pixi's 12× world
coordinates), followed by a 30-units/s seam pan at size 30. Godot's benchmark is capped at 60 fps.

Both render **1024×768 pixels**, medium graphics. HiDPI is allowed in Godot, but this machine still
reports a 1024×768 render target for the benchmark command, so Pixi uses the roadmap's 1× fallback.
The JSON records actual pixel dimensions. Godot frame intervals now use the monotonic clock;
its earlier smoothed-process-delta interval figures should not be used as wall-clock pacing data.

The measurements below were taken on the Apple M3 with Godot 4.7.2 / Metal and headed Chromium 130
/ Pixi 8.6.6. Each runner used one match and a visible window. Other desktop activity was present,
so these are **provisional desktop measurements**, not the clean-machine sign-off required by A1.

| scene | phase | client | fps | interval p50 / p99 (ms) | max (ms) | >50 ms | script avg / p99 (ms) | render CPU avg (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| early | idle | PixiJS | 60.0 | 16.70 / 17.60 | 17.70 | 0 | 0.66 / 2.10 | 0.64 |
| early | idle | Godot | 60.0 | 16.67 / 18.28 | 24.23 | 0 | 1.49 / 2.80 | 1.01 |
| early | zoom | PixiJS | 60.0 | 16.70 / 17.70 | 17.70 | 0 | 0.83 / 2.20 | 0.74 |
| early | zoom | Godot | 60.0 | 16.67 / 18.01 | 18.30 | 0 | 1.78 / 2.64 | 1.18 |
| early | pan | PixiJS | 60.0 | 16.70 / 17.60 | 18.00 | 0 | 0.70 / 2.00 | 0.66 |
| early | pan | Godot | 60.0 | 16.67 / 18.35 | 26.41 | 0 | 1.84 / 2.93 | 1.12 |
| late | idle | PixiJS | 59.6 | 16.70 / 17.70 | 67.70 | 1 | 1.64 / 7.10 | 1.94 |
| late | idle | Godot | 60.0 | 16.66 / 21.52 | 31.66 | 0 | 4.30 / 8.06 | 1.00 |
| late | zoom | PixiJS | 58.7 | 16.70 / 49.00 | 50.90 | 2 | 1.72 / 24.50 | 2.43 |
| late | zoom | Godot | 60.0 | 16.64 / 21.38 | 31.83 | 0 | 4.22 / 7.63 | 0.99 |
| late | pan | PixiJS | 58.6 | 16.70 / 34.40 | 66.60 | 3 | 1.51 / 21.70 | 2.42 |
| late | pan | Godot | 60.0 | 16.67 / 23.02 | 31.11 | 0 | 4.67 / 10.69 | 0.93 |

Raw results: [PixiJS](benchmarks/pixi-2026-11-03.json), [Godot](benchmarks/godot-2026-11-03.json).

Godot held approximately 60 fps in the late scene, with frame p99 below 25 ms and no frames over
50 ms in this run. However, late script p99 is **7.63–10.69 ms**, above A2's 5 ms target. The
late run also recorded a worst terrain build slice of **7.16 ms**, so the scheduling budget is not
a hard upper bound yet. A2 is **not passed**; the queue/LOD improvements are not a migration approval.

CPU columns keep the two sources explicit: Godot script time covers main-thread `_process` work,
including state application; Pixi wraps `view.frame` and `renderer.render`, so its snapshot/HUD
work outside those wrappers is not included. Worker JSON-decode time is reported separately under
`script.async_json_decode` and is not part of Godot's main-thread script time. Render CPU is not
GPU time. GPU zeros mean **unavailable**: this Mac has Command Line Tools, but no Xcode Metal frame
debugger / `xctrace`; a real capture or Vulkan measurement on another machine remains outstanding.

### Developed 256×256 map

| phase | fps | interval p50 / p99 (ms) | >50 ms | script avg / p99 (ms) |
| --- | --- | --- | --- | --- |
| idle | 60.0 | 16.62 / 22.38 | 0 | 4.47 / 10.35 |
| zoom | 60.0 | 16.61 / 23.17 | 0 | 4.59 / 9.03 |
| pan | 60.0 | 16.60 / 22.84 | 0 | 4.80 / 9.14 |

Static memory at the end was **289.37 MB** (Godot's `MEMORY_STATIC`, not total
process/GPU memory). The initial terrain build drained before measurement; the worst terrain build
slice across warm-up and measurement was **9.96 ms**, above the intended 5 ms bound.
This run also met the approximately-60-fps / frame-p99 target, but missed the script-p99 target.
Raw result: [developed large map](benchmarks/godot-large-2026-11-03.json).

### Changes and verification

- District structure, progress/fire visuals and smoke/activity are separate. Refresh work uses a
  queue; merged districts assemble over several frames under a 1 ms scheduling budget. Regrouping,
  geometry generation and heavy state dispatch do not deliberately stack in one frame.
- Forest chunks switch from detailed trees to canopy quilts at camera size 60. This uses explicit
  camera-size LOD because the orthographic camera's boom distance stays fixed; distance-based
  `visibility_range_*` would not respond to zoom. Sun shadows stop beyond size 120; terrain receives
  shadows without casting them. Chimney and battlefield smoke have far-zoom caps.
- Unit interpolation finds the snapshot bracket once per frame. Stationary ground samples are
  cached until position/terrain changes. Above 200 units, models share per-type/owner MultiMeshes
  while selection and path positions remain per unit.
- Terrain arrays build incrementally, and mesh upload uses its own slice. Updates arriving during
  a build retain a newer revision instead of being discarded at commit. Geometry deltas recalculate
  only the heights they carry instead of scanning the whole map.
- Large JSON packets parse in workers. Scene/state access stays on the main thread in wire order.
  This follows measured decode costs of roughly 3 ms at p99 in the developed large-map scene;
  there is no compact/binary protocol change.
- Native regression script: **33 checks passed**, including zoom proportions/anchoring, progress
  invalidation, seam interpolation, batches/selection, terrain revisions, LOD/shadows and worker
  decoding. Live smoke: **two connections, 122 snapshots, 7 ms RTT**, a real move reaching its
  destination, accurate picking, and rejoin after restarting the server. This is not a two-hour soak.
- Server suite: **127/127 passed** (`ADMIT_OFF=1 node --test test/*.test.js`).

Commands and runner options are in [../README.md](../README.md). The remaining acceptance work is
still governed by [ROADMAP.md](ROADMAP.md); Part B has not begun.

---

## Historical first-session report (2026-11-02)

The original report below is retained as history. The checkpoint above supersedes its benchmark
methodology and statements about work still untested.

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
