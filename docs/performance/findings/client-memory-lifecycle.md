# Client memory, GC, physics and lifecycle audit (Agent 5, read-only)

These findings come from reading the code only; none were measured. Cost estimates are inferred from the code.
- **Verified** means the code path exists as described.
- **Suspected** means the frequency or magnitude is not confirmed.

## Environment and wire cadence

**Environment:**
- Unity 6000.3.28f1.
- Mono scripting backend, so the Boehm GC (not generational) applies.
- Incremental GC is on.

**Wire cadence** (`server/worker.js:77-78`):
- A snapshot goes out every 2nd tick (5 Hz).
- An econ frame goes out every 10th tick (1 Hz). It carries buildings, cities, econ, `fw` and the entire `bf` battlefield section.
- Only units and paths are delta-encoded (`server/delta.js`).
- `bf` is sent in full every econ frame (`game.js:984`, `actionGame.js:870`). The server keeps `g.bfVer` (`battlefield.js:9`) but never uses it to gate sending.

## Ranked findings

| # | Finding | Impact | Status |
|---|---|---|---|
| M1 | Whole battlefield is rebuilt every econ frame (1 Hz). `ClientSession.cs:294-297` bumps `BattlefieldRevision` unconditionally. | High | Verified path |
| M2 | Impacts trigger `terrain.CompleteAll`, which blocks on jobs, then dirty 7 chunks and 7 city cells per tile. | High | Verified path; magnitude suspected |
| M3 | Every message becomes a full Newtonsoft JToken tree, and `bf` grows with match age. | High (GC) | Verified alloc; pauses suspected |
| M4 | `ApplyGeo` does whole-map water recompute plus `CompleteAll`. | Medium | Verified per message; frequency suspected |
| M5 | Steady per-frame allocations. | Medium | Verified |
| M6 | O(N) scans and texture uploads per frame or on a timer. | Medium | Verified |
| M7 | Battle overlay Painter2D regenerates every frame while panning or in combat (`Hud.Overlay.cs:145-233`). | Medium | Verified |
| M8 | Econ frame applied whole regardless of the 4 ms drain budget (`WebSocketLink.cs:172-180`). | Low–Med | Verified |
| M9 | `DamageEmitters` and `Stacks` keep entries for destroyed buildings (`CityRenderer.Damage.cs:63`, `CityRenderer.cs:99`). | Low | Verified |
| M10 | No physics is used, but auto-simulation still runs FixedUpdate at 50 Hz, up to ~16 steps after a hitch (`DynamicsManager.asset`). | Low | Verified |
| M11 | Audio is pooled. Silent streaming beds still play. `Engines()` loops all slots each frame with a lock. | Low | Verified |

### Details

**M1: whole battlefield rebuilt every econ frame**
- `WarzoneRenderer.cs:199-243` rebuilds every trench, tile and wreck.
- `CraterSpoil()` (`:166-196`) scans all N tiles and places up to 14,000 clods.
- `GroundField.cs:46-62` rebuilds an N-pixel texture and calls Apply.
- `GameBootstrap.Present` then calls `IsWasteland` for all N tiles.
- Cost grows with craters, wrecks, wear and impacts. The server caps impacts at 6,000 and wear at 8,000.

**M2: impacts block terrain jobs and recompose cells** (`WorldModel.ApplyImpacts` `:198-234`)
- It allocates a Dictionary, Lists, a HashSet and a `float[24]` for each candidate tile.
- It calls `terrain.CompleteAll`, blocking on in-flight jobs.
- It marks 7 chunks and 7 city cells dirty per changed tile.
- A non-empty `DirtyCells` also bumps `Structures.Revision` (`StructureStore.cs:78`). That triggers:
  - footprint rebuilds in UnitRenderer;
  - `DefenceSignature`;
  - possibly a warzone rebuild;
  - base recompose, which can take about 50 ms by the code's own comment (`CityRenderer.cs:133-135`).

**M3: full JToken tree per message**
- `WebSocketLink.cs:107` builds a UTF-16 string for each message.
- `JObject.Load` has no `PropertyNameTable`.
- `Econ["res"].DeepClone()` runs every snapshot.
- Worker-thread allocations still trigger stop-the-world collections.

**M4: geo messages** (`WorldModel.ApplyGeo` `:264-323`)
- It copies two N-float arrays and runs `RecomputeWater()`, which allocates `bool[N]`.
- It scans the whole map for basins.
- `ClientSession.ApplyGeo` always calls `CompleteAll` first.

**M5: steady per-frame allocations**
- `CityRenderer.SetPickups` uses HashSet, LINQ and ToArray every frame.
- `SetObjectives` and `Territory.Update` use a boxed `IEnumerable`.
- `Commander.cs:194-200`: `RemoveAll` with a lambda and a new List.
- `Present` builds capturing lambdas for the HUD draw calls.
- `AudioDirector` uses `name + "_far"` and `AudioClip.name`.

**M6: O(N) scans and texture uploads**
- `TerritoryField.cs:75` hashes every tile owner every frame.
- `Minimap.cs:328-332, 428-455` redraws the full map texture every 0.5 s regardless of change.
- `FogField` rebuilds on every visibility change (up to 5 Hz), with a 6-pass blur every 24th change.

## Existing safeguards
- The WebSocket receive thread and large-message decode run off the main thread, with a priority lane.
- The drain has a budget and applies back-pressure.
- `UnitStore` uses struct records in stable slots with no per-unit allocation.
- Rendering is revision-gated: terrain, city per-cell, fog, ground, warzone.
- `EffectsRenderer` uses a fixed 16k particle pool and ring-buffered craters, wrecks and rubble.
- `InstanceBatch` keeps persistent NativeArrays and GraphicsBuffers.
- Meshes and textures are destroyed on rebuild.
- The HUD pools its elements.
