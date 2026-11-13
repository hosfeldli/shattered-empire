# Shattered Empires

Large-scale modern military RTS with capturable ruined cities, compact headquarters districts,
free-moving armies and persistent battlefield destruction.

- **Status:** Windows Unity preview. The redesign is a functional prototype with incomplete visuals;
it has not received final art, balance, performance or production acceptance.

**Stack:** Unity `6000.3.28f1`, URP and C#; authoritative Node.js simulation; `action-v2` gameplay.
macOS remains a target platform. Public distribution offers the Windows Unity ZIP.
Godot, Electron and browser clients are historical references.

[Download the Windows preview](https://game.liamhosfeld.com/download) ·
[Documentation](docs/README.md) · [Current status](docs/UNITY_PROGRESS.md) ·
[Development queue](docs/DEVELOPMENT_QUEUE.md)

## The game

Scout → Capture → Rebuild → Deploy → Conquer.

Players begin with a secured headquarters, infantry, an engineer and a scout. Infantry capture
designated city ruins. Each headquarters has eight predetermined development parcels:
four unlocked initially, then six and eight after local upgrades.

Materials and Energy are the only spendable resources. Command Capacity limits army size.
Ground troops collect Materials drops; captured abandoned energy plants supply extra Energy.
Economy, production and research facilities compete for city-ring sites. Roads remain buildable
and also connect cities automatically. Field construction requires legal visible terrain,
without requiring an engineer selection. Idle engineers repair and assist outside combat.

The [game design](docs/GAME_DESIGN.md) consolidates the latest gameplay, visual and interaction
requirements. The [status report](docs/UNITY_PROGRESS.md) separates implementation from verification.
Civilian workforce, housing and production-chain management do not belong to the current RTS.

## Develop

Install Node.js 20 or newer (CI uses Node.js 22), then run from the repository root:

```powershell
npm ci
$env:PORT = '8137'
$env:SNAPSHOT_DIR = Join-Path $env:TEMP 'se-local-development'
npm start
```

Open `unity/` with the pinned Editor, run **Shattered Empires → Set up project**, and press Play.
An explicit local player connection is:

```text
ShatteredEmpires.exe -server ws://127.0.0.1:8137/ws -mode ai -seed 41
```

Normal released players use `wss://game.liamhosfeld.com/ws`.
See [development](docs/DEVELOPMENT.md), the [Unity guide](unity/README.md),
[verification](docs/VERIFICATION.md) and [release](docs/RELEASE.md).

## Repository

| Path | Purpose |
| --- | --- |
| [server/](server/) | Match hosting, authoritative rules, networking and persistence |
| [unity/](unity/) | Current client, rendering, interaction, audio and builds |
| [test/](test/) | Simulation, protocol, integration and performance checks |
| [tools/](tools/) | Asset preparation, build and distribution tools |
| [docs/](docs/) | Current design, status, engineering guides, backlog and reports |
| [godot/](godot/) | Frozen reference client and historical evidence |
| [client/](client/), [desktop/](desktop/) | Legacy browser and Electron clients |

Earlier civilian-economy, five-era, wrapping-world and installer instructions are preserved in
the [archive](docs/archive/README.md). They do not define the Unity RTS.
