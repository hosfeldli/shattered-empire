# Godot → Unity client migration

Adopted 2026-11-08. **Switch the client architecture, preserve the game.** Unity 6.3 LTS
(6000.3.x) with URP and C# becomes a high-performance presentation layer for the existing
authoritative Node.js simulation. Initial platform: Windows x64; secondary: macOS.

Feature work requested on the same day is queued in [DEVELOPMENT_QUEUE.md](DEVELOPMENT_QUEUE.md).

## What stays and what is replaced

Everything that decides the game stays on the Node.js server, unchanged: world generation and
seeds, civilizations and cities, resources and workforce, research and eras, construction, units,
movement, combat, military AI, governors, roads, bridges and logistics, battlefield damage and
trenches, fog of war, match management, persistence and reconnects. Unity never decides the
outcome of any of these. It presents authorized state, interprets input, shows predictions and
submits commands.

Unity replaces the Godot implementation of world rendering, terrain, procedural cities, building
and vehicle presentation, animation and effects, camera and selection, input, UI, audio and
desktop packaging. The `godot/` client stays in the repository, unmodified, as the behavioural
reference. Do not use Unity Netcode or Mirror, and do not write a new game server.

## Layout

```
server/  test/   existing Node.js game server and simulation tests (unchanged)
godot/           preserved reference client (frozen once M2 passes)
client/ desktop/ legacy browser and Electron clients
unity/           the new Unity client  ← this migration
docs/            migration plan, development queue, baselines
```

Development branch: `feature/unity-client`. Reference tag: `godot-reference-2026-11-08`
(`d2f1e79`, the last Godot-only commit on `main`).

## Non-negotiable performance rules

1. Performance is designed in from the first prototype. Every subsystem has a budget and a
   benchmark.
2. No per-object `Update()` loops for soldiers, trees, vehicles or props. Use centralised,
   data-oriented loops and instanced drawing.
3. Decoration never interferes with command processing. Reduce detail before responsiveness.
4. Changes are incremental. One building does not rebuild a city, one crater does not rebuild the
   terrain, and the camera does not rebuild data.
5. Profile standalone Windows player builds, not Editor Play mode.
6. Graphics scale through Low/Medium/High/Ultra. Gameplay information is identical across presets.
7. Never drop authoritative state for FPS. Cosmetic work can be deferred; unit deltas, accepted
   commands and fog rules cannot.
8. Engine comparisons use equivalent visual configurations.

## Architecture (implemented in `unity/Assets/ShatteredEmpires`)

| Assembly | Responsibility |
| --- | --- |
| `SE.Core` (no UnityEngine) | Hex grid, world wrap, terrain heights, geo decoding, unit records and delta application, interpolation, command bookkeeping, frame statistics. Also compiled by the .NET test project in `unity/Tests.Standalone`, so parity with the server runs without the Editor. |
| `SE.Networking` | Background `ClientWebSocket` receive loop, bounded off-thread JSON decoding, wire-order dispatch on the main thread, request ids, ack timeouts and priorities, session rejoin. |
| `SE.Runtime` | Bootstrap, camera, chunked terrain (Burst jobs), instanced unit and building renderers, effects, diagnostics overlay, stress scenario. |
| `SE.Editor` | Scene creation, build-settings and command-line build entry points. |
| `SE.Tests` | EditMode tests (Unity Test Framework). |

Rules carried over from the Godot client:

- Pointy-top, odd-row-offset hexes. X runs east and wraps with period √3·W, Z runs south, Y is up,
  one unit is one hex radius. Every position-based system uses the same nearest-image calculation
  (`WorldWrap.NearX`).
- Terrain, roads, buildings, units and craters sample one height function (`TerrainHeights`),
  an exact port of `WorldState.gd`'s sector triangulation.
- `udelta` snapshots are applied strictly in wire order. A delta is never discarded because a
  newer packet arrived, since later deltas depend on it. Only presentation work is coalesced.
- Command acknowledgments and connection traffic bypass the cosmetic queue.

## Milestones and gates

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| M0 Baseline | Preserved Godot build and real Windows performance traces | Failure is reproducible |
| M1 Foundation | Project, URP, camera, basic world, diagnostics | Standalone Windows build works |
| M2 Performance proof | 256×256 world, city, 1,000-unit stress scene | Measurably better frame pacing than Godot on the same PC |
| M3 Multiplayer | Server connection, snapshot/delta, commands, rejoin, Steam invites | A real match synchronizes |
| M4 Living world | Terrain, environment, roads, districts, growth | City-world scenario passes |
| M5 Military | Units, formations, combat visuals, performance LOD | Large playable battles |
| M6 Full UI | Build, Army, Research, contextual cards, opportunities | Core gameplay flows work |
| M7 Warzone and polish | Damage, weather, audio, feedback, visual quality | Integrated battle/recovery scenario |
| M8 Release | Windows distribution, macOS validation, preview hosting | Player tests and release gates pass |

**M2 is the decision gate.** If Unity does not clearly beat the troublesome Godot scene on frame
pacing *and* interaction reliability, stop before M3 and re-examine the shared workload.

### M2 acceptance targets (reference PC)

| Metric | Target |
| --- | --- |
| 1080p ordinary play | ≥ 60 FPS |
| Frame time p95 | ≤ 16.7 ms |
| Frame time p99 | < 25 ms |
| Long freezes | No repeated 100+ ms stalls |
| Local command ack p95 | < 250 ms |
| Memory | Stabilizes under repeated battles |
| Detail | Comparable to Godot at the same resolution |

Reference PC (the development machine where the problems were reported): Intel Core i5-8600K
(6 cores), AMD Radeon RX 7600 XT, 32 GB RAM, Windows 11.

### Unity results on the reference PC (2026-11-08)

Standalone Windows player, Mono with Burst, Direct3D 12, 1920×1080, high preset, vsync off. Reports are in
[docs/benchmarks](benchmarks/).

| Scenario | Avg FPS | p50 | p95 | p99 | Worst | > 100 ms | Command ack p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Offline stress: 256×256, ~480 buildings, 1,000 units, scripted camera tour | 252 | 3.8 ms | 6.9 ms | 10.9 ms | 28 ms | 0 | — |
| Live sandbox `massive` (1,000 units), local server, zooms 14 and 40, run A | 152 | 5.8 ms | 12.3 ms | 16.8 ms | 43 ms | 0 | 70 ms |
| Same, run B | 144 | 6.2 ms | 12.7 ms | 19.1 ms | 74 ms | 0 | 29 ms |

All M2 frame-pacing targets are met in these runs. Measurement notes:

- Earlier live runs, before per-frame GPU buffers were triple-buffered, showed 1–5 frames over
  100 ms.
- Direct3D 11 was clearly worse than Direct3D 12 (p99 19–23 ms, more hitches), so Direct3D 12
  stays the default.
- Screenshot capture (`-shots`) causes its own 100–200 ms frames. Never benchmark with it on.
- Remaining 50–85 ms live hitches do not involve garbage collection. They are logged as `STALL`
  lines with a per-phase breakdown.

**Gate decision (2026-11-08): proceed with Unity.** After seeing the Unity results, the project
owner committed fully to Unity and chose not to run the matched Godot benchmark. The decision rests
on the Unity measurements above and the Godot problems already experienced in play (frame drops
when panning, construction lag, long-game slowdown, city rendering resets). No side-by-side Godot
numbers from this PC were recorded.

Consequences, per this plan:

- New Godot client development is frozen. `godot/` stays as the behavioural reference and remains
  the official download until the Unity client passes M8.
- Work continues with M3 (live multiplayer in Unity).

## Progress and target

- [UNITY_PROGRESS.md](UNITY_PROGRESS.md) records what has been built, changed, verified and
  deployed, with commits, benchmarks and known issues.
- [UNITY_GAP_ANALYSIS.md](UNITY_GAP_ANALYSIS.md) condenses the owner's complete target
  specification (received 2026-11-08) and marks each requirement done, partial or missing.

## Feature parity

Parity means working game actions, not buttons. The parity matrix is
[godot/docs/PARITY_MATRIX.md](../godot/docs/PARITY_MATRIX.md) plus
[godot/docs/SIMPLE_UI.md](../godot/docs/SIMPLE_UI.md). Each server command and Godot interaction
gets a Unity implementation and a regression test before the migration counts as complete.

## CI and distribution

- `.github/workflows/unity.yml` compiles the Unity project, runs EditMode tests, builds Windows
  x64, and publishes a `unity-preview-<hash>` artifact kind. Publishing updates the download
  manifest only after the upload succeeds and validates. It needs the repository secrets
  `UNITY_LICENSE` (or `UNITY_SERIAL`), `UNITY_EMAIL` and `UNITY_PASSWORD`.
- `.github/workflows/native.yml` builds the Godot client on every `main` change and publishes it
  as the official download until the Unity client passes M8.
- Electron installers are no longer built automatically or listed on the download page. Earlier
  files stay in storage.
- Cloud Run keeps serving the API, multiplayer server and download page. Unity builds never
  replace the Cloud Run container, and a Unity client that needs an incompatible protocol is
  never published.

## What not to do

Do not rewrite the backend, move AI into Unity, replace server movement or combat, use one
GameObject per soldier or prop, add physics vehicles without gameplay need, regenerate whole
cities per economic update, rebuild the terrain per impact, adopt ECS everywhere without
measuring, add gameplay systems before M2, change production Cloud Run for an unfinished client,
or remove Godot before Unity is stable.
