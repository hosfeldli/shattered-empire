# Unity client

- **Type:** Client entry guide
- **Updated:** 2026-11-13
- **Scope:** Unity `6000.3.28f1` / URP / `action-v2`

The Unity client presents authorized state from the Node.js server. It handles rendering,
input, UI, sound and interpolation; the server owns outcomes. The current military RTS is
a redesign, not parity with the old civilization simulator.

[Documentation index](../docs/README.md) · [Design](../docs/GAME_DESIGN.md) ·
[Current status](../docs/UNITY_PROGRESS.md) · [Development](../docs/DEVELOPMENT.md)

## Open and run

Open this directory with the pinned Unity Editor. Run **Shattered Empires → Set up project** once,
then press Play or choose **Shattered Empires → Build Windows x64**.

Released players use `wss://game.liamhosfeld.com/ws`. An explicit development connection is:

```text
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode ai -seed 41
```

See [Development](../docs/DEVELOPMENT.md) for the isolated local server, batch builds and supported
switches. Normal boot plays the skippable intro and opens the menu. Normal startup targets borderless
fullscreen. Developer modes/review flags can deliberately bypass the normal entry flow.

## Assemblies

| Path | Assembly / purpose |
| --- | --- |
| `Assets/ShatteredEmpires/Core/` | `SE.Core`: engine-independent state, terrain, protocol and interpolation |
| `Assets/ShatteredEmpires/Net/` | `SE.Net`: WebSocket transport, ordered decoding, commands and rejoin |
| `Assets/ShatteredEmpires/Runtime/` | `SE.Runtime`: app, rendering, input, UI, effects and audio |
| `Assets/ShatteredEmpires/Steam/` | `SE.Steam`: optional Steam integration |
| `Assets/ShatteredEmpires/Editor/` | `SE.Editor`: project setup and platform builds |
| `Tests.Standalone/` | Core/Net parity and explicit live integration checks |

Map coordinates are `x` east and `z` south. [MapSpace.cs](Assets/ShatteredEmpires/Runtime/Rendering/MapSpace.cs)
converts to Unity `(x, y, -z)`. See [Architecture](../docs/ARCHITECTURE.md).

## Controls and interaction direction

WASD/edge pan, middle drag and cursor-centered wheel zoom control the camera. Left-click/drag
selects; right-click issues contextual orders. Controls are remappable. Q/E rotates the camera,
with defense placement taking precedence for structure rotation.

The current design puts city construction on world parcels and upgrades on selected buildings,
removing redundant Army/Objectives tabs, a global upgrade menu and permanent bottom build bars.
Some follow-up implementation is still pending; consult [Current status](../docs/UNITY_PROGRESS.md).

## Review and release

[Verification](../docs/VERIFICATION.md) owns the check commands, visual-only manual scope, full-camera
capture requirements and approval vocabulary. [Release](../docs/RELEASE.md) owns packaging and
publication. Capture/export stalls are not ordinary frame-time measurements.

The public client is a Windows preview. A macOS build entry point is not macOS runtime acceptance.
Godot and macOS downloads are retired. No final art, late-game performance or production approval
is implied by a successful build.
