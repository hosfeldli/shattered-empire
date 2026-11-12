# Shattered Empires — Unity client

Unity 6.3 LTS (6000.3.28f1), URP, C#. A presentation layer for the authoritative Node.js server.
It renders authorized state, takes input, shows pending orders and sends intents. It never decides
an outcome. Plan and rules: [docs/UNITY_MIGRATION.md](../docs/UNITY_MIGRATION.md).

## Layout

```
Assets/ShatteredEmpires/
  Core/      SE.Core   engine-independent (no UnityEngine): hex grid and wrap, terrain heights
                       (exact port of WorldState.gd), geo decoding, protocol decoder, unit store with
                       udelta application and interpolation, command tracker, stats, stress world
  Net/       SE.Net    WebSocket transport (background receive, off-thread decode, wire-order apply,
                       priority acks), handshake/capabilities, reconnect and rejoin
  Runtime/   SE.Runtime  bootstrap and frame loop, camera, terrain chunks (Burst jobs), cities,
                       units (GPU-instanced, three LODs), effects, diagnostics, benchmarks
    Resources/Shaders  SE/InstancedLit, SE/Terrain, SE/Water, SE/Billboard (URP HLSL)
  Steam/     SE.Steam  Steam friends and invites (Steamworks.NET); compiled only when the package is present
  Editor/    SE.Editor project setup (URP asset, player settings, scene) and command-line builds
  Tests/     SE.Tests  EditMode tests
Tests.Standalone/      .NET project compiling Core and Net, checked against server fixtures and a live server
```

Map coordinates are the server's (x east, z south, right-handed). Unity world space is
(x, y, −z), converted only in `Runtime/Rendering/Space.cs`, so the map is never mirrored.

## Run

Open `unity/` in Unity 6000.3.28f1, then run **Shattered Empires → Set up project** once. This
creates the URP asset, the player settings and `Scenes/Main.unity`. Press Play, or build with
**Shattered Empires → Build Windows x64**.

Command line (same option names as the Godot client where they overlap):

```
ShatteredEmpires.exe                                   main menu (public server by default)
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode ai
ShatteredEmpires.exe -mode stress -stress-seconds 60 -perf-out stress.json        offline M2 stress scene
ShatteredEmpires.exe -server ws://127.0.0.1:8139/ws -mode sandbox -battle massive -perf 20 -perf-zooms 14,40 -perf-out live.json
```

In game: WASD or the screen edges pan, the wheel zooms toward the cursor, Q/E rotate, and middle
drag pans. Left click or drag selects, double-click selects every unit of that type on screen.
Right click moves; Shift or Ctrl + right click attack-moves. H holds position. Hold Alt to see the
tile type. F3 shows diagnostics, F10 hides the interface.

## Checks without the Editor

```
node unity/Tests.Standalone/make-fixtures.mjs
dotnet run -c Release --project unity/Tests.Standalone
dotnet run -c Release --project unity/Tests.Standalone -- --live ws://127.0.0.1:8141/ws 45
```

The first command writes fixtures from the server's own hex, terrain-geometry and delta code. The
second checks the core against them, including terrain continuity across chunk and wrap seams and
the 1,000-unit stress scenario. The third plays a sandbox match against a running server: handshake,
geometry, deltas, the 1,000-unit battle, a forced reconnect that must rejoin, and command-ack latency.

## Batch mode

```
Unity -batchmode -quit -projectPath unity -executeMethod SE.EditorTools.ProjectSetup.RunBatch -logFile -
Unity -batchmode -quit -projectPath unity -runTests -testPlatform EditMode -testResults results.xml
Unity -batchmode -quit -projectPath unity -executeMethod SE.EditorTools.BuildScript.BuildWindows -buildOutput Build/Windows/ShatteredEmpires.exe
```

Batch mode needs an activated license: sign in to Unity Hub and add a Personal license under
Preferences → Licenses. CI uses the `UNITY_LICENSE`/`UNITY_SERIAL`, `UNITY_EMAIL` and
`UNITY_PASSWORD` secrets (`.github/workflows/unity.yml`).

## Status

Unity now defaults to the versioned `action-v2` RTS ruleset: city-ruin capture, fixed 4/6/8
headquarters rings, Materials/Energy, faction-wide command capacity and technology,
buildable roads, independent field defenses and continuous authoritative armies.
Ground units collect Materials caches; capturable abandoned energy plants provide Energy.
Construction does not require engineer selection. Engineers repair and assist nearby allies
automatically outside combat. See [the ring-city redesign](../docs/RING_CITY_REDESIGN.md).
The model, material, animation, city, HUD and effects pass accompanies this rules change.
See [implementation and acceptance report](../docs/ACTION_RTS_IMPLEMENTATION.md) for the exact
scope and remaining approval gates. Older matches retain their own rules; use `-ruleset native-v4`
only when creating an intentional legacy match.

Use `-review DIRECTORY` in a live sandbox to capture actual gameplay at close, operational and
strategic scales. Visual review and performance measurement are separate runs.

Builds default to Mono. Pass `-il2cpp` to the build to use IL2CPP, which requires the Visual
Studio C++ build tools. Use `-shots DIR` with `-mode stress` to capture one screenshot per tour
segment, for visual checks only: capture causes long frames. Every frame over 50 ms is logged as a
`STALL` line with a per-phase breakdown.
