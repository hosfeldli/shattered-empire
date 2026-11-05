# Shattered Empires: native client (Godot 4.7.2)

A second client for the same authoritative Node.js server. It draws an orthographic 3D world with a
2D interface on top. Gameplay is simulated by the server; bounded water, weather and activity
simulation on the client is cosmetic.
Godot is the development target. The PixiJS / Electron sources in `client/` and `desktop/` are kept
as reference material; native work does not develop the browser version.

The Living World Engine has working semantic graph, recipe, scheduling, terrain/site, district,
activity, military and native-command foundations. It is a development preview, not the complete
production-quality engine. [LWE_REQUIREMENTS.md](docs/LWE_REQUIREMENTS.md) tracks all thirty design
sections and later visual corrections. See [STATUS.md](docs/STATUS.md) for evidence and remaining
gates, and the original [ROADMAP.md](docs/ROADMAP.md) for the migration/release checklist.
The [streamlined redesign](docs/NATIVE_REDESIGN.md) supersedes government/treaty parity and removes
all trading from new, versioned native matches. Older saves retain explicit legacy rules.

## Running it

```bash
brew install --cask godot          # Godot 4.7.2
ADMIT_OFF=1 PORT=8139 SNAPSHOT_DIR=/tmp/se-native-bench node server/index.js
godot --path godot -- --server=ws://127.0.0.1:8139/ws
```

The `.claude/launch.json` entry `native-bench` starts the same server (port 8139, its own snapshot
directory). Command-line options (after `--`):

| option | effect |
| --- | --- |
| `--server=ws://host:port/ws` | server to connect to (default `ws://127.0.0.1:8137/ws`) |
| `--mode=ai\|observe\|sandbox\|rejoin\|spectate` | start straight away (`--seed`, `--name`, `--map`, `--match`) |
| `--speed=N` | spectators: run the AI exhibition faster (1, 2, 4, 8) |
| `--battle=large\|armor\|artillery\|…` | sandbox: stage a scenario, dig in, attack-move |
| `--quality=low\|medium\|high\|ultra` | rendering, activity and effect budgets (default medium) |
| `--bench=SECONDS [--bench-wait=T] [--bench-out=PATH]` | scripted idle / zoom / seam-pan benchmark, JSON out |
| `--probe=SECONDS [--probe-out=PATH] [--order-test=S] [--pick-test]` | report what was synchronized, then quit |
| `--tour=DIR [--tour-wait=T]` | save screenshots at several zoom levels and across the seam |
| `--water-test=DIR` | developer water/cloud captures; use `node godot/tests/lwe-live.mjs --water --visible` |
| `--session-file=PATH` | isolate test/rejoin session storage from the player's session |

Native benchmarks start a clean port-8139 server for each scene. Existing Pixi measurements remain
reference evidence in `docs/benchmarks/`; native development does not require opening the browser.

```bash
npm run bench:godot -- --resolution=1920x1080 --out=/tmp/godot-bench.json
npm run bench:godot -- --scenario=large --resolution=1920x1080 --out=/tmp/godot-large-bench.json
```

Keep that window visible. Use `--scenario=early` or `--scenario=late` for one scene, and
`--seconds=30` to set the total duration of the three equal-length phases. `--scale=2` keeps a
1024x768 CSS viewport and renders 2048x1536 pixels when comparing against a Godot run whose `meta.pixels` is that
size. `--url=URL` uses an already-running server instead of the isolated server; do that only when
it has no other matches.

The runners own port 8139; stop a manually started benchmark server before running them. Both pin
the AI personalities to warlord / merchant / builder (only warlord in the early two-player match),
use medium graphics, and run the late scene from 720 game-seconds at normal speed. Godot's benchmark
is capped at 60 fps and records monotonic wall-clock intervals, not Godot's smoothed process delta.
GPU values of zero on Metal mean unavailable measurements, not free GPU work.

Renderer regression checks (no server or display required):

```bash
godot --headless --path godot -s res://tests/render_regressions.gd
godot --headless --path godot -s res://tests/composition_regressions.gd
godot --headless --path godot -s res://tests/lwe_regressions.gd
node godot/tests/lwe-live.mjs
node godot/tests/network-smoke.mjs
```

The live check builds/trains/draws infrastructure through existing server commands and verifies
same-match reload. The network check restarts its isolated server and verifies protocol/geo,
picking, a real move order and automatic rejoin. Large JSON packets decode in workers; results are
applied in wire order on the main thread. The protocol and server commands are unchanged.

Actual-GPU visual checks (temporary native test windows; run these one at a time):

```bash
node godot/tests/lwe-live.mjs --visible --out=/tmp/se-live-visual
godot --path godot --resolution 1024x768 -s res://tests/terrain_zoom_visual.gd -- --out=/tmp/se-terrain-zoom
```

`tools/art/README.md` documents original Blender GLBs, procedural PBR maps and audio source scripts.
To build local development previews with installed official export templates:

```bash
node tools/build-native.mjs --platform=all --smoke
```

Outputs go to ignored `dist/native/`. macOS bundles use an ad-hoc local development signature;
Windows previews are unsigned. These are not notarized/trusted signed public releases. Windows
execution and public signing/distribution remain acceptance work. The separate
`.github/workflows/godot-smoke.yml` runs headless checks without touching `deploy.yml`.

Controls: WASD / arrows pan (Shift faster), the wheel zooms about the cursor, middle-drag pans,
left click or drag selects, right click moves, Ctrl+right click attack-moves, H holds, T toggles a
defensive / aggressive stance, Escape cancels, B opens construction/orders, F2 opens empire
workspaces, M toggles audio, F3 shows statistics, and F4 shows generation/recipe diagnostics.
The camera keeps a fixed 60-degree pitch while zooming so terrain proportions do not stretch.

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
