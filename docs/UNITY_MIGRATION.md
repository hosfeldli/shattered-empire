# Unity migration context

- **Type:** Architecture decision context
- **Updated:** 2026-11-13
- **Scope:** Current client direction; historical migration evidence is archived

Unity `6000.3.28f1` with URP is the current client. Godot development is frozen as a reference;
browser/Electron sources are legacy. Windows is the distributed preview; macOS remains a target.

This is a substantial RTS redesign, not feature parity with the civilization simulator.
Keep server authority while changing the server's actual gameplay rules: continuous movement,
Materials/Energy, captured ruins, fixed 4/6/8 rings, three tiers, military AI and revised victory.
Do not preserve civilian logistics/workforce or claim the Node.js simulation remains unchanged.

Use [architecture](ARCHITECTURE.md) for engineering contracts, [game design](GAME_DESIGN.md) for
requirements, [development](DEVELOPMENT.md) for commands and [current status](UNITY_PROGRESS.md)
for evidence. Production gates are in [verification](VERIFICATION.md).

The [original migration plan and benchmarks](archive/UNITY_MIGRATION_BEFORE_2026-11-13.md)
remain a historical decision record. Passing the early migration performance comparison did not
approve the present late-game client, all platforms or the completed Unity replacement.
