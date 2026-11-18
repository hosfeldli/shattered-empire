# Architecture audit: performance-critical systems

**Status:** Phase 1 reconnaissance, 2026-11-17, branch `feature/unity-client` at 4bd3f1d.

Every hypothesis below started unverified. Its current status, and the measurement behind it, is in [BOTTLENECK_REGISTER.md](BOTTLENECK_REGISTER.md).

Detailed specialist findings:
- [findings/server-simulation.md](findings/server-simulation.md)
- [findings/server-navigation.md](findings/server-navigation.md)
- [findings/client-rendering-destruction.md](findings/client-rendering-destruction.md)
- [findings/client-memory-lifecycle.md](findings/client-memory-lifecycle.md)

## 1. System overview

```
 Node server (authoritative, one worker thread per match, server/worker.js)
   ActionGame.tick() @ 10 Hz (TICK_HZ, constants.js); runs several ticks per interval at 2x/4x speed (cap 70 ms)
     Scheduler systems (scheduler.js, per-system p50/p95/p99, budget "over" counters, exposed at /api/metrics):
       navigation  (every tick)  actionOrders.unitMotion   -> actionNavigation.route / canMove / spatial index
       combat      (every tick)  actionCombat              -> targets index, acquire, damage, wrecks, craters
       capture, field economy, production (moveGroup rally), income
       visibility  (every 4th)   actionGame.refreshVisibility -> reveal() disks per source x team member
       weather, warzone (battlefieldStep), ai (planActionAI, one civ per call -> moveGroup -> route), victory
     Human orders: worker message handler -> moveGroup -> route, synchronously, outside the scheduler
   Snapshots: every 2nd tick (5 Hz) per viewer: game.snapshots() -> delta.js (units/paths only) -> JSON -> ws
     every 10th tick (1 Hz) an "econ" frame: buildings, cities, econ, fw (trenches), bf (whole battlefield)
     geo deltas (terrainGeo.geoStep) when terrain changes
   Autosave: every 60 game-s, JSON.stringify(serializeGame()) synchronously on the tick thread, then gzip async

 Unity 6.3 URP client (Mono backend, single main thread plus Burst terrain jobs)
   WebSocketLink: receive thread, decode >= 8 KB off the main thread (Newtonsoft JObject trees)
   GameBootstrap.Update: net.Update(4 ms drain budget) -> ClientSession.Apply (geo / snapshot / econ)
     ApplySnapshot: tiles, visibility, units (UnitStore, struct records, interpolation ring)
     econ: trenches -> WorldModel.ApplyTrenches; bf -> WorldModel.ApplyImpacts; buildings -> StructureStore
           (both world mutations used to call terrain.CompleteAll first: a blocking wait on Burst chunk jobs)
   Present (timed per phase): events, fog+ground, terrain (chunk jobs), city (CityRenderer cells + territory),
     warzone (trenches, wrecks, crater spoil), units (UnitRenderer, VAT soldiers), atmosphere, fx (16k particles), draw
   Hud (UI Toolkit), Minimap (2 Hz texture), battle overlay (Painter2D)
```

**Release clients always play on the remote Cloud Run server, even single-player against AI.** Server tick spikes therefore reach the player directly: units freeze and snapshots and order acknowledgements arrive late.

## 2. Battle lifecycle and where work cascades

Each step below lists the server-side work, then what it sets off on the client.

**1. Move order.** `moveGroup` primes a flow field, then for every unit runs `candidate` → `route()` (A* plus fine path), synchronously.
- Client effect: order latency. Measured at 0.5–2 s for 500–1000 units.

**2. Movement.** Each tick, `unitMotion` runs `allowed()` (`canMove`, `canStand`, `cost`) for every moving unit. Blocked units re-route every 13 ticks for as long as they stay blocked.
- Client effect: none directly, but tick time grows superlinearly and snapshots arrive late.

**3. Target acquisition.** `acquire` runs on about U/3 units per tick, using `targets.query` over all owners.
- Client effect: none directly; tick time grows with density.

**4. Shots and damage.** Damage events are emitted.
- Client effect: particles, audio, decals, overlay bars.

**5. Destruction.** Wrecks, craters, impacts, scorch and wear are added to the battlefield. Buildings are lost, which triggers `invalidate()` and clears every navigation cache.
- Client effects:
  - The `bf` block is resent whole every second, so `BattlefieldRevision++` fires every econ frame.
  - `ApplyImpacts` blocks on terrain jobs (`CompleteAll`).
  - The warzone does a full rebuild (up to 14k clods).
  - The ground texture is rebuilt.
  - City cells near the impacts go dirty, which recomposes base compounds.

**6. Terrain change.** Geo deltas are sent.
- Client effect: `ApplyGeo`, which used to block on terrain jobs, recomputes water across the whole map, and rebuilds terrain chunks.

**7. Ownership and territory change.**
- Client effect: `TerritoryField` rebuilds a full-map texture (about 290k texels) on the main thread.

**8. Rendering cleanup.** Ring buffers cap craters, wrecks and rubble. Server wrecks last 1,500 s. No GameObjects are created per entity: everything is instanced.

**Feedback loops identified**

1. **Blocked units re-route against the obstacle that is blocking them.** Combat adds wrecks, wrecks block units, the units re-route endlessly, ticks get longer, and snapshots arrive late.
2. **Destruction triggers whole-map client work.** Combat produces impacts, the 1 Hz full `bf` triggers full warzone, ground and crater rebuilds plus a blocking job wait, and the cost grows with accumulated impacts (up to 6,000) for the rest of the match.
3. **Building changes recompose whole base compounds.**
   - A visual-key change (construction or damage) dirties the cell, which recomposes the compound.
   - The compound cache signature mixed in the map-wide road revision and maturity, so it missed whenever anyone, anywhere, built a road.
   - Neighbouring base cells are composed together with no budget, giving 300–990 ms frames.

## 3. Existing safeguards
- **Server:**
  - Scheduler with per-system budgets and metrics.
  - Path cache (384 entries) and flow fields.
  - Fog cache (3,500 entries).
  - Capped events (6,000), impacts (6,000), wear (8,000) and command log.
  - Delta-encoded unit snapshots.
  - Autosave gzip runs asynchronously.
- **Client:**
  - Instanced rendering throughout, with persistent GPU buffers.
  - Burst terrain jobs (at most 6) with hi/lo LOD and tree bands.
  - City compose budget of 5 ms, max 6 cells per frame, plus a base hold-off and replay cache.
  - Particle pool (16k) and ring buffers for craters (4k), wrecks (800), rubble (2.4k) and decals (900).
  - UnitStore with struct records.
  - Decode off the main thread.
  - Revision gating on terrain, city, fog, ground and territory.
- **No GameObject, collider or material accumulation was found.** Counts stay flat over 80 game-minutes (measured: about 59 GameObjects, 489 meshes, 175 textures, 112 materials).

## 4. Initial hypotheses, ranked before measurement

| # | Hypothesis | Outcome (see register) |
|---|---|---|
| H1 | Client main-thread rebuilds that grow with match age (warzone, impacts, territory, base compounds) cause the late-game collapse | **Verified**, largest client factor |
| H2 | Client blocks on terrain jobs when geometry changes | **Verified**: 0.3–1.2 s frames |
| H3 | Server navigation (blocked re-routing, collision tests) grows superlinearly | **Verified** in prod and in benchmarks |
| H4 | AI and order planning (`moveGroup` → `route` per unit) causes server tick spikes | **Verified**: AI p99 up to 372 ms |
| H5 | Visibility stamping per source per team member | **Verified**, second-largest steady server system |
| H6 | GPU-bound: draw calls, shadows, overdraw | Minor so far: GPU p95 8 → 20 ms while CPU frames reach 300–1,300 ms |
| H7 | Leaks or accumulation of GameObjects, meshes, materials or textures | **Rejected**: counts flat |
| H8 | GC pressure from JSON trees and per-frame allocation | Partly verified: 0.1 → 2 MB/frame allocated; effect on pauses not isolated |
| H9 | Physics or colliders | **Rejected**: none used (auto-simulation still runs empty FixedUpdates) |

## 5. Unknowns needing profiling
- Production navigation is about 10× the local AI-match numbers. The cause is not yet reproduced: possibly the slower vCPU, human orders, or the map.
- GPU frame cost at 1440p/4K and on lower-end GPUs. Only one RX 7600 XT at 1080p has been measured.
- Mono vs IL2CPP for the client's managed loops; IL2CPP is not yet built.
- Effect of Cloud Run CPU throttling on the 5 Hz snapshot cadence under load.
