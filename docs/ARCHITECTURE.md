# Architecture

- **Type:** Engineering contract
- **Updated:** 2026-11-13
- **Scope:** Unity client / Node.js server / `action-v2`
- **Related:** [Design](GAME_DESIGN.md), [implementation map](ACTION_RTS_IMPLEMENTATION.md)

## Authority

The existing Node.js simulation owns gameplay truth. Extend it for the RTS redesign; do not
build a second client simulation or preserve civilian economics behind a simpler interface.

The server owns movement, navigation, collision, combat, fog, resources, capacity, capture,
buildings, production, technology, AI, roads, bridge damage, persistence and victory. Unity renders
authorized state, interprets input, sends commands, interpolates motion and shows pending-order
feedback. Prediction and decoration never decide outcomes.

## Components

| Path / assembly | Responsibility |
| --- | --- |
| [server/matches.js](../server/matches.js) | Match creation, hosting and workers |
| [server/sim/actionGame.js](../server/sim/actionGame.js) | RTS lifecycle, commands, snapshots and scenarios |
| [server/sim/actionDefinitions.js](../server/sim/actionDefinitions.js) | Units, facilities, upgrades and balance definitions |
| [Core/](../unity/Assets/ShatteredEmpires/Core/) — `SE.Core` | Engine-independent protocol, world data, units, deltas and interpolation |
| [Net/](../unity/Assets/ShatteredEmpires/Net/) — `SE.Net` | WebSockets, decoding, ordered dispatch, command tracking and rejoin |
| [Runtime/](../unity/Assets/ShatteredEmpires/Runtime/) — `SE.Runtime` | App, input, terrain, cities, military, effects, audio and UI |
| [Editor/](../unity/Assets/ShatteredEmpires/Editor/) — `SE.Editor` | URP setup and platform builds |
| [Tests.Standalone/](../unity/Tests.Standalone/) | Core/server parity and explicit live integration checks |

[ProjectVersion.txt](../unity/ProjectSettings/ProjectVersion.txt) pins Unity to `6000.3.28f1`.
URP is the rendering baseline. Package pins live in
[manifest.json](../unity/Packages/manifest.json) and
[packages-lock.json](../unity/Packages/packages-lock.json). CI uses the same Editor pin.

## Rulesets and persistence

Current RTS contracts: `action-v2`, ring layout version 1, save schema 5; capabilities include
`action-rts` and `ring-cities-v1`. See [rulesets.js](../server/sim/rulesets.js) and
[protocol.js](../server/protocol.js).

Do not silently convert `action-v1` or civilization saves into the new economy. Use an explicitly
compatible legacy mode or a clear compatibility error. Preserve parcels, ownership, construction,
tiers, queues, caches, defenses, road projects, motion and battlefield changes through save/rejoin.
Compilation or connection alone does not prove deterministic continuation or synchronization.

## State categories

| Record | Authority | Examples |
| --- | --- | --- |
| Functional entity | Server | HQ, ring facility, field defense, unit, cache |
| Static gameplay geometry | Server | Footprints, traversal, interrupted bridge, real cover |
| Decorative accessory | Presentation from authorized state | Annex detail, paving, landscaping, equipment |

Decoration cannot unexpectedly block movement, provide cover, generate resources or expose
unseen enemies. District updates preserve stable identities and unaffected composition.
Remembered structures use last-seen state rather than omniscient generation.

## Space and navigation

Map coordinates use `x` east and `z` south; Unity conversion is `(x, y, -z)` at the rendering
boundary. Grid data supports terrain, indexing and shared strategic routing. Authoritative
positions and occupancy remain continuous.

Use strategic corridors, shared group routes and local steering with bounded collision/crossing
work. Vehicle heading constrains movement. Formation goals are individual destinations, and
rendered soldiers must move independently rather than rotate as a rigid group. Roads, water,
units and bridge decks share consistent height contracts.

Parcel identity is separate from terrain-cell identity; several objects can share a coarse cell.
Local HQ tier controls sites and appearance. Global faction tier controls unlocks and capacity.
Decorative tenure and additional HQ count do not multiply capacity.

## Presentation and scheduling

Use central loops, instancing, shared materials, LOD, pooling and bounded incremental generation.
Avoid an expensive Update loop per soldier, tree or prop. Keep old geometry until its replacement
is ready. Camera motion must not rebuild city identity. Damage updates only affected regions.

Bound AI, pathfinding, effects, animation and audio work; preserve command feedback when cosmetic
work is deferred. Keep foliage diffuse/nonemissive, normalize safely and reject invalid HDR values.
Visual review must include camera-stack volume updates; see [verification](VERIFICATION.md).

## Hosted endpoint and distribution

Released players default to `wss://game.liamhosfeld.com/ws`. Localhost is an explicit development
override. The website serves downloads/APIs; gameplay stays hosted. Source deployment and the
Windows ZIP are separate artifacts.

Private snapshots can share infrastructure with download objects. Do not expose the whole bucket
to publish a build. Use the existing download routes and verified manifest, following
[release](RELEASE.md).
