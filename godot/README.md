# Shattered Empires: native client (Godot 4.7)

A second client for the same authoritative Node.js server. It draws an orthographic 3D world with a
2D interface on top. It sends intents and renders what the server tells it; it simulates nothing.
The PixiJS / Electron client in `client/` and `desktop/` is unchanged and remains the shipping client.

Status: **Phase 0, Phase 1 and a first pass at the Section 17 vertical slice**. Next steps: [docs/ROADMAP.md](docs/ROADMAP.md). See
[docs/STATUS.md](docs/STATUS.md) for measurements, what is left and the decision-gate assessment.

## Running it

```bash
brew install --cask godot          # Godot 4.7.2
SERVE_CLIENT=1 ADMIT_OFF=1 PORT=8139 SNAPSHOT_DIR=/tmp/se-native-bench node server/index.js
godot --path godot                 # start panel: server address, name, play / watch / rejoin
```

The `.claude/launch.json` entry `native-bench` starts the same server (port 8139, its own snapshot
directory). Command-line options (after `--`):

| option | effect |
| --- | --- |
| `--server=ws://host:port/ws` | server to connect to (default `ws://127.0.0.1:8137/ws`) |
| `--mode=ai\|observe\|sandbox\|rejoin\|spectate` | start straight away (`--seed`, `--name`, `--map`, `--match`) |
| `--speed=N` | spectators: run the AI exhibition faster (1, 2, 4, 8) |
| `--battle=large\|armor\|artillery\|…` | sandbox: stage a scenario, dig in, attack-move |
| `--quality=low\|medium\|high` | shadows / SSAO / antialiasing (default medium) |
| `--bench=SECONDS [--bench-wait=T] [--bench-out=PATH]` | scripted idle / zoom / seam-pan benchmark, JSON out |
| `--probe=SECONDS [--probe-out=PATH] [--order-test=S] [--pick-test]` | report what was synchronized, then quit |
| `--tour=DIR [--tour-wait=T]` | save screenshots at several zoom levels and across the seam |

Controls: WASD / arrows pan (Shift faster), the wheel zooms about the cursor, middle-drag pans,
left click or drag selects, right click moves, Ctrl+right click attack-moves, H holds, T toggles a
defensive / aggressive stance, Escape cancels, F3 shows frame and network statistics.

## Protocol

The client opens every connection with `{ t: 'hello', proto: 2, caps: ['geo'] }`
(`server/protocol.js`). With `geo` the server also streams terrain geometry (`server/sim/terrainGeo.js`):
six quantized bytes per hex in 16×16 chunks, with every explored hex on the initial sync and only
hexes in sight afterwards. Clients that never say hello (the PixiJS client) are protocol 1 and see
exactly the messages they always did. Tests: `test/geo.test.js`.

## Layout

| subsystem | file | role |
| --- | --- | --- |
| GameBootstrap | `scripts/core/GameBootstrap.gd` | builds and wires everything; fixed per-frame order (camera first) |
| NetworkClient | `scripts/net/NetworkClient.gd` | WebSocket, handshake, request ids, reconnect and rejoin |
| WorldState | `scripts/world/WorldState.gd` | mirror of server state; snapshot buffer and unit interpolation |
| HexGrid | `scripts/world/HexGrid.gd` | the server's odd-r hex layout; the single wrapped coordinate system |
| WorldRenderer | `scripts/render/WorldRenderer.gd` | 16×16-hex `ArrayMesh` terrain chunks, water, rivers, fog in the shader |
| CameraController | `scripts/render/CameraController.gd` | orthographic oblique camera, zoom about the cursor, ray picking |
| SettlementRenderer | `scripts/render/SettlementRenderer.gd` | buildings merged into districts; per-building selection |
| InfrastructureRenderer | `scripts/render/InfrastructureRenderer.gd` | roads, railways, bridges, traffic |
| MilitaryRenderer | `scripts/render/MilitaryRenderer.gd` | unit models, interpolated movement, selection, paths |
| EnvironmentRenderer | `scripts/render/EnvironmentRenderer.gd` | sun, sky, clouds, wet ground, forests, deposits |
| CombatRenderer | `scripts/render/CombatRenderer.gd` | craters, wrecks, trenches, smoke, combat-event effects |
| InputController | `scripts/input/InputController.gd` | selection and orders (intents only) |
| GameHUD | `scripts/ui/GameHUD.gd` | start panel, top bar, selection, notes, feedback |
| Diagnostics | `scripts/debug/Diagnostics.gd` | F3 overlay, benchmark, probe, picking test |
| MaterialLibrary / MeshKit | `scripts/render/` | shared materials (timber, brick, stone, concrete, steel, glass…) and procedural geometry |
