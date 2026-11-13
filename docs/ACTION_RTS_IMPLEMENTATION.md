# RTS implementation map

- **Type:** Source navigation
- **Updated:** 2026-11-13
- **Scope:** `action-v2`; source presence is not acceptance
- **Status:** [Current status](UNITY_PROGRESS.md)

| System | Source |
| --- | --- |
| Definitions, costs, tiers, counters | [actionDefinitions.js](../server/sim/actionDefinitions.js) |
| Maps, ruins, parcels and transport layout | [actionMap.js](../server/sim/actionMap.js) |
| Capture, HQ, facilities, recruitment and construction | [actionBases.js](../server/sim/actionBases.js) |
| Continuous orders and steering | [actionOrders.js](../server/sim/actionOrders.js) |
| Navigation, footprints, visibility and cover queries | [actionNavigation.js](../server/sim/actionNavigation.js) |
| Combat and local tactical behavior | [actionCombat.js](../server/sim/actionCombat.js) |
| Military AI | [actionAI.js](../server/sim/actionAI.js) |
| Command dispatch, snapshots, lifecycle and sandbox | [actionGame.js](../server/sim/actionGame.js) |
| Hosting and capability handshake | [matches.js](../server/matches.js), [protocol.js](../server/protocol.js) |
| Client state and decoding | [Core/](../unity/Assets/ShatteredEmpires/Core/), [Net/](../unity/Assets/ShatteredEmpires/Net/) |
| Bootstrap, menus and intro | [Runtime/App/](../unity/Assets/ShatteredEmpires/Runtime/App/) |
| Terrain, water, roads and cities | [Runtime/Terrain/](../unity/Assets/ShatteredEmpires/Runtime/Terrain/), [Runtime/Cities/](../unity/Assets/ShatteredEmpires/Runtime/Cities/) |
| Military meshes and animation | [Runtime/Military/](../unity/Assets/ShatteredEmpires/Runtime/Military/) |
| Input, selection and contextual interface | [Runtime/Session/](../unity/Assets/ShatteredEmpires/Runtime/Session/), [Runtime/UI/](../unity/Assets/ShatteredEmpires/Runtime/UI/) |
| Materials, atmosphere, effects and sound | [Runtime/Rendering/](../unity/Assets/ShatteredEmpires/Runtime/Rendering/), [Runtime/Effects/](../unity/Assets/ShatteredEmpires/Runtime/Effects/), [Runtime/Audio/](../unity/Assets/ShatteredEmpires/Runtime/Audio/) |

See [architecture](ARCHITECTURE.md) for authority and compatibility, [development](DEVELOPMENT.md)
for commands, [verification](VERIFICATION.md) for evidence and [release](RELEASE.md) for artifacts.

The [earlier action-v1 implementation report](archive/ACTION_RTS_IMPLEMENTATION_BEFORE_2026-11-13.md)
is preserved with its original measurements. Its Supplies/Power economy, starting facilities,
save format and earlier automated results do not validate the ring-city `action-v2` rules.
