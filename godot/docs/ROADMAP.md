# Native edition: guide to the remaining steps

Where things stand is recorded in [STATUS.md](STATUS.md): Phase 0, Phase 1 and a first pass at the
vertical slice are done. This guide covers what comes next, in order. Each step lists the files to
touch, how to do it and how to know it's finished.

Rules that hold for every step:

- **Server authority:** the server stays authoritative and the client stays a view. New data comes
  from the server through a new protocol capability (see `server/protocol.js`), never from a rule
  re-implemented in GDScript.
- **No gameplay changes:** no gameplay or balance changes ride along with client work.
- **PixiJS fallback:** the PixiJS client in `client/` keeps working unchanged until the very last
  phase.
- **Committing:** commit locally. Pushing to `main` deploys the live server, so only push when you
  mean to ship the server change.

The working setup for all steps:

```bash
# a clean server for native-client work (own snapshot folder, port 8139)
SERVE_CLIENT=1 ADMIT_OFF=1 PORT=8139 SNAPSHOT_DIR=/tmp/se-native-bench node server/index.js
godot --path godot -- --server=ws://127.0.0.1:8139/ws --mode=ai
ADMIT_OFF=1 node --test test/*.test.js        # server suite, must stay green
```

---

## Part A: the decision-gate iteration

These four steps answer the gate question honestly. Do them before committing to the migration.

### A1. Make the benchmark fair

The current comparison has three gaps:

- Godot rendered at 1× and PixiJS at 2×.
- The PixiJS late scene is missing.
- Godot reports no GPU time on Metal.

1. **Equal pixels:**
   - In `godot/project.godot` set `display/window/dpi/allow_hidpi=true`.
   - In `Diagnostics._finish()`, check that the `pixels` field reads 2048×1536 for a 1024×768
     window.
   - Or run PixiJS at 1×: `window.__view().app.renderer.resolution = 1` before measuring.
2. **A scripted PixiJS benchmark:**
   - Add `test/perf/pixi-bench.mjs` (Playwright, headed Chromium with the real GPU: no
     `--use-angle=swiftshader`).
   - It should run the same three scenes as Godot's `--bench`: idle, continuous `zoomAt`, and a pan
     across the seam.
   - It should cover the early AI match (seed 7) and the AI exhibition (seed 5, speed 8 until 12
     game-minutes, then speed 1, centred on the largest city).
   - Write the same JSON fields as `Diagnostics._summary()`.
   - Reuse the rAF interval loop and the `view.frame` / `renderer.render` timing wrap from STATUS.md.
3. **GPU time:**
   - Profile one late-scene frame with Xcode's Metal frame capture (run Godot from Xcode, or attach
     to the process).
   - Or measure on a Windows / Linux machine, where Godot's Vulkan driver reports
     `viewport_get_measured_render_time_gpu`.
   - Record the top passes: shadow, opaque, transparent.
4. **Clean machine:** run both clients with nothing else loading the machine (no leftover matches;
   use the 8139 server) and with the window in view.

**Done when** `docs/STATUS.md` has one table with both clients, the same scenes, equal pixels, and
fps, p50 / p99 interval, frames over 50 ms and CPU per frame.

### A2. Performance and level of detail

Target: the late scene at 60 fps with a p99 interval under 25 ms and script p99 under 5 ms, at
equal pixels on the M3.

1. **Amortized district rebuilds** (`SettlementRenderer.gd`):
   - Split `_signature()` into a *structure* key (ids, types, levels, done/ruined state) and a
     *progress* key (construction %, fire, activity).
   - Only structure changes rebuild the district mesh.
   - Draw construction scaffolds and fires as small separate meshes keyed by building id.
   - Put district rebuilds in a queue with a per-frame time budget, like
     `WorldRenderer._build_some()`.
   - This removes the ~14 ms script spikes.
2. **Tree LOD** (`EnvironmentRenderer.gd`):
   - Set `visibility_range_end` on each chunk's tree `MultiMeshInstance3D` (about 60 units of
     camera size).
   - Add a far "canopy" mesh per forest chunk: one low hex-quilt surface with a foliage colour,
     with `visibility_range_begin` at the same value.
   - Keep tree shadows close-up only (already done).
3. **Shadows:**
   - Tie `sun.directional_shadow_max_distance` to the visible footprint, and turn sun shadows off
     beyond a camera size of about 120, where they're sub-pixel.
   - Only buildings and units cast shadows; terrain receives them.
4. **Units** (`MilitaryRenderer.gd`, `WorldState.unit_position`):
   - Find the snapshot bracket once per frame instead of once per unit.
   - Switch to one `MultiMesh` per model key once unit counts pass about 200.
5. **Chimney smoke and battlefield smoke:** already batched. Cap the puff count by camera size.
6. **Large maps:**
   - Run `--mode=observe --map=large --probe=60` and check the chunk build time
     (`terrain.last_build_ms`), memory (`Performance.MEMORY_STATIC`) and the 5 ms chunk budget on a
     256×256 map.
   - If initial build is slow, spread the first sync over more frames or move `_build_chunk` to a
     `WorkerThreadPool` task that only fills arrays, then commit meshes on the main thread.

**Done when** the A1 harness shows the target in the late scene and on a large map.

### A3. One district with modelled art

The quality ceiling is unknown until there are real assets. Do residential first: it's the most
common district.

1. **Pipeline:**
   - Model in Blender, export `.glb` into `godot/assets/buildings/res/`.
   - Scale: 1 unit = one hex radius, origin at the base centre, forward +X.
   - Name each mesh's material slots after `MaterialLibrary.SPECS` keys (`brick`, `roof_tile`,
     `glass`, …).
2. **Import:**
   - Add `scripts/render/AssetLibrary.gd`, which loads the scenes once.
   - Replace each imported surface material with `MaterialLibrary.get_mat(slot_name)`, so imported
     buildings share the library and its tinting.
   - Extract the `ArrayMesh` so it can be appended into a district's mesh.
3. **Use it:**
   - In `SettlementRenderer._building()` (case `"house"`) and in the residential
     `_connect()` terraces, place asset meshes instead of `kit.box` and `kit.gable`.
   - Either add a `MeshKit.append_mesh(mesh, transform, tint)` that copies the surface arrays into
     the matching material part, or use a MultiMesh per asset per district.
   - Keep three or four variants per level, chosen by the existing per-tile RNG.
4. **Textures:**
   - One trim sheet each for brick, plaster, roof tile and slate (albedo, normal, roughness, 1k)
     on the library materials.
   - Use triplanar mapping on the terrain shader for rock and soil detail.

**Done when** you have a side-by-side screenshot set (`--tour`) of the same residential district in
PixiJS and Godot, judged by you, plus the asset cost in hours. That cost decides the art budget for
the full migration.

### A4. The interaction layer: placement, roads, trenches

The second big unknown is how much interface work parity needs. Build the three core map
interactions. They're all existing server commands; nothing new on the server.

| interaction | server commands (`server/sim/game.js`) | PixiJS reference |
| --- | --- | --- |
| building placement | `placement` (valid tiles), `build` (`tile`, `type`, `plan`) | `client/hud.js` `buildbar()` / `placePanel()`, `client/main.js` build mode |
| road drawing | `roadPlan` (`tiles`, `type`, `auto`, `commit`) | `hud.js` `roadPanel()`, `onRoadClick()` |
| bridge | `bridgePlan` | `hud.js` `bridgePanel()` |
| trench line | `trenchPlan` (`points`, `type`, `commit`), `trenchCancel` | `hud.js` `trenchPanel()` |
| formations | `formation`, `move` with `formation` | `hud.js` `formationHtml()`, `deployBar()` |
| training | `train`, `batchTrain` | `hud.js` `trainPanel()` |

How to do it:

1. **Modes:**
   - Add a mode state to `InputController.gd`: `select | place(type) | road | trench`.
   - Escape returns to `select`. Right click in a mode cancels it.
2. **Build palette:** a `GameHUD` panel built from `world.defs.BUILDINGS` (name, cost, tech lock
   from `world.econ.techs`).
3. **Placement:**
   - On entering place mode, send `placement` and keep the returned tile list.
   - Draw it as a per-hex highlight: an R8 texture like `vis_bits`, sampled in the terrain shader,
     so it's one uniform update with no new meshes.
   - Show a ghost of the building model on the hovered hex (the SettlementRenderer recipe in a
     translucent material).
   - Left click sends `build`.
4. **Roads, bridges and trenches:**
   - Collect hexes while dragging (`cam.pick_tile`).
   - Send the preview command (`commit: false`) as the path changes, at most a few times a second.
   - Draw the returned plan as a coloured ribbon (InfrastructureRenderer strip code).
   - Release sends `commit: true`.
5. **Formations:** expose line, column, wedge and box on the selection panel; pass them as
   `formation` on `move`. Draw the planned slot positions the server returns in `paths`.

**Done when** an early game can be played start to finish in Godot alone: house, farm, lumber mill,
a road between two cities, a bridge, training and moving a formation, and a trench line.

### A5. The gate review

Re-run A1 and fill in the gate table in STATUS.md:

| axis | pass if |
| --- | --- |
| frame time | ≥ PixiJS fps in every scene at equal pixels, and no stalls |
| quality | the A3 district is clearly better than its PixiJS counterpart (your judgement) |
| readability | city, terrain and battle lines read at least as well at far zoom, with borders and overlays (B2) |
| responsiveness | order-to-screen no slower than PixiJS (same server path; check interpolation delay) |
| asset complexity | the A3 hours per district type × the number of types fit the budget |
| stability | 2-hour session with no errors, memory flat, a reconnect, and a large map |

If it passes, continue to Part B. If it doesn't, stop and put the effort into the PixiJS client. The
server capability work costs nothing to keep.

---

## Part B: full migration, only after the gate passes

### B1. Interface parity

Port the PixiJS HUD panel by panel. Each is its own piece of work.

| area | PixiJS source | notes |
| --- | --- | --- |
| top bar, alerts, toasts | `hud.js` `topbar`, `alert*`, `toast` | partly done in `GameHUD.gd` |
| minimap | `hud.js` `minimap` | render the 2D map into a `SubViewport` or build an `Image` from tile colours |
| selection, buildings, cities | `hud.js` `selection`, `buildingPanel`, `cityOverview` | many fields already arrive in econ snapshots |
| economy workspace | `client/economy/EconomyWorkspace.js` | stockpiles, ledger, resources report |
| research | `client/research/ResearchWorkspace.js` | tech tree from `defs.TECHS` |
| government, diplomacy | `hud.js` workspaces | |
| logistics, air, missiles | `hud.js` `airfieldPanel`, `siloPanel`, logistics panels | |
| tutorial, finder, command bar | `client/tutorial.js`, `finder.js`, `commandBar.js` | |
| lobby, multiplayer, rejoin | `client/main.js` screens | the start panel exists; add multiplayer rooms |

Build it as Godot `Control` scenes (`.tscn`) with a shared `Theme` resource rather than hand-placed
labels, and keep every panel a reader of `WorldState` plus a sender of `NetworkClient.cmd`.

### B2. Strategic layer

- **Borders:**
  - Owner per hex is already in `WorldState.tile_owner`.
  - Draw borders as edge ribbons between hexes of different owners, in civ colours, rebuilt per
    chunk on `tiles_changed`.
- **Overlays:** territory, supply (`econ.supply` bits), stability, resources. Each is an R8 texture
  plus a terrain-shader mode.
- **Fog:** remembered terrain is already dimmed. Add last-seen ghost buildings, like PixiJS.
- **Far-zoom readability:** icons for cities and armies above a camera size threshold
  (`client/visual/UnitIcons.js`, `ResourceIcons.js` are the reference).

### B3. Units, combat and effects polish

- Formation shapes and slot spreading, health and morale markers, status icons
  (out of supply, waiting, blocked: the unit flags bits).
- Aircraft states (`ar` array), naval units afloat, death and wreck animations from `kill` events.
- Building damage stages and ruins with real assets; fire and smoke sized by `hp`.
- Audio: port the cues in `client/audio` to `AudioStreamPlayer` / `AudioStreamPlayer3D`.

### B4. Protocol evolution

Only when profiling shows the network as a cost:

- A `units2` capability with compact binary unit records (positions quantized, sent as deltas).
- A `bin` capability for binary WebSocket frames instead of JSON for snapshots.

Every new capability works like `geo`: optional, negotiated in the handshake, invisible to protocol-1
clients, covered by a test in the style of `test/geo.test.js` (fog, legacy client unchanged).

### B5. Tests and CI

- GDScript unit tests with gdUnit4 or GUT for `HexGrid` (`tile_at` / `center` round trips, wrap,
  `dist` against `server/sim/hex.js`), `WorldState.apply_geo` and interpolation.
- A headless smoke test in CI as a new workflow, **not** `deploy.yml`:
  1. Start the server.
  2. Run `godot --headless --path godot -- --mode=ai --probe=15 --order-test=6`.
  3. Assert on the JSON (protocol 2, geo, snapshots > 50, order acknowledged).
- Keep `test/geo.test.js` and the rest of the server suite green.

### B6. Distribution

1. **Export presets:** export presets for macOS (universal, signed and notarized) and Windows.
2. **Ship next to Electron:**
   - Ship the native client next to the Electron app first, as an opt-in "native edition".
   - The downloads page and manifest come from `server/downloads.js`; add the new artifacts there.
3. **Server address:** reuse the desktop app's server address logic (`client/config.js`) for the
   default `--server`.
4. **Updates:** an update check against the same manifest the desktop app uses
   (`test/desktop-update.test.js` shows the format).

### B7. Retiring the PixiJS client

Only after native parity, at least one release cycle as the default, and no open native-only bugs:

- Make the native edition the default download.
- Keep the PixiJS client available for one more cycle.
- Then remove it and the `SERVE_CLIENT` development path that serves it.

---

## Quick reference: how to check your work

| check | command |
| --- | --- |
| synchronized state, order, picking | `godot --headless --path godot -- --server=ws://127.0.0.1:8139/ws --mode=observe --probe=15 --order-test=6 --pick-test` |
| frame times | `godot --path godot --resolution 1024x768 -- --server=ws://127.0.0.1:8139/ws --mode=ai --seed=7 --bench=30 --bench-out=bench.json` |
| isolated PixiJS comparison (early + late) | `npm run bench:pixi -- --out=pixi-bench.json` |
| isolated Godot comparison (early + late) | `npm run bench:godot -- --out=godot-bench.json` |
| isolated developed large-map benchmark | `npm run bench:godot -- --scenario=large --out=godot-large-bench.json` |
| renderer regressions | `godot --headless --path godot -s res://tests/render_regressions.gd` |
| native network / order / reconnect smoke | `node godot/tests/network-smoke.mjs` |
| late-scene frame times | same with `--mode=observe --seed=5 --speed=8 --bench-wait=720` |
| what costs the GPU | add `--hide=trees`, `shadows`, `smoke`, `clouds,water` or `buildings` and compare |
| screenshots | `--tour=DIR [--tour-wait=T]`, add `--mode=sandbox --battle=large` for a battle |
| live stats | F3 in the client |
