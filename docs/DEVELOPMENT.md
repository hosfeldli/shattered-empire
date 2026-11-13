# Development

- **Type:** Developer guide
- **Updated:** 2026-11-13
- **Scope:** Local Unity / authoritative server
- **Related:** [Architecture](ARCHITECTURE.md), [verification](VERIFICATION.md)

## Prerequisites

- Unity `6000.3.28f1`, the appropriate build module and an activated license.
- Node.js 20 or newer; CI uses Node.js 22. Install through the checked-in lock with `npm ci`.
- .NET SDK for standalone Core/Net checks.
- Windows for Windows runtime and Explorer extraction checks; macOS requires separate acceptance.

Use the pinned Editor. Do not upgrade Unity or packages during an unrelated change.

## Local server

Run from the repository root in PowerShell:

```powershell
npm ci
$env:PORT = '8137'
$env:SNAPSHOT_DIR = Join-Path $env:TEMP 'se-local-development'
npm start
```

Use a dedicated local state directory and port. Keep experiments separate from production saves
and the real player's Continue session. Check ownership before stopping a process or reusing a
port. `ADMIT_OFF=1` is a local profiling convenience, not a production setting.

The package's `dev` and `start:dev` scripts use POSIX environment syntax and serve the legacy
browser client. The explicit PowerShell assignments above avoid that shell ambiguity and are
sufficient for Unity development.

## Editor and player

Open `unity/`, run **Shattered Empires → Set up project**, then press Play. Normal connection uses
the hosted server. Explicit local examples:

```text
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode ai -seed 41
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode sandbox -battle mixed -seed 41
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode observe -seed 41
```

Restart the local server after simulation changes. Ruleset/capabilities must match the client.
`-mode rejoin` uses an existing session; never feed a real player's credentials into automated
review. Normal boot plays the intro and opens the menu. Explicit mode/review flags are developer
entry points. Normal startup targets borderless fullscreen; review can request a window.

## Build Windows

On the current workstation:

```powershell
$unityEditor = 'C:/Program Files/Unity/Hub/Editor/6000.3.28f1/Editor/Unity.exe'
New-Item -ItemType Directory -Path Build -Force | Out-Null
& $unityEditor -batchmode -quit -projectPath unity -executeMethod SE.EditorTools.BuildScript.BuildWindows -buildOutput Build/Windows/ShatteredEmpires.exe -logFile Build/windows.log
```

Interactive builds use **Shattered Empires → Build Windows x64**. The build entry point accepts
`-development 1`; normal builds use `BuildOptions.None`. Choose the scripting backend through
actual project/build settings. The earlier README's unsupported `-il2cpp` switch is not a build API.

Build logs and managed player data establish a rebuild; the executable stub timestamp alone does
not. Avoid rebuilding files held by a running review player. A `BuildMac` entry point exists, but
that does not establish macOS runtime acceptance or a public macOS download.

## Existing check commands

Choose checks through [verification](VERIFICATION.md), respecting the current visual-only manual
scope. Reference commands:

```powershell
node --test test/action-rts.test.js
npm test
npm run test:e2e
node unity/Tests.Standalone/make-fixtures.mjs
dotnet run -c Release --project unity/Tests.Standalone
dotnet run -c Release --project unity/Tests.Standalone -- --live ws://127.0.0.1:8141/ws 45
```

The live command requires a dedicated server on that port; browser checks require Playwright's
browser installation. This list does not authorize expanding a graphics review into a soak/load
campaign. Documentation-only changes need documentation checks.

## Assets and records

Keep source attribution and redistribution terms beside external assets. A free download or
marketplace listing is not sufficient license evidence. Preserve editable sources and bounded
texture/audio budgets; use consistent physical scale.

Update [design](GAME_DESIGN.md), [status](UNITY_PROGRESS.md) and [queue](DEVELOPMENT_QUEUE.md)
according to their separate responsibilities. Scope dated reports to the actual captured build.
