# Client rendering and destruction audit (Agent 4, read-only)

The audit covered:
- `unity/Assets/ShatteredEmpires/Runtime/**`
- `Settings/SE_URP.asset` and `SE_Renderer.asset`
- `ProjectSettings/QualitySettings.asset`

It is a code reading only: no timings were measured. "Verified" means the code path exists as described; "Suspected" means the cost has not been measured.

The project has no ProfilerMarkers. It only has the Stopwatch phase timers in `GameBootstrap.Present` and a STALL log that is active in perf/stress mode. The player uses the Mono backend; IL2CPP is opt-in in `Editor/ProjectSetup.cs:97-100`.

| ID | Finding | Status |
|---|---|---|
| R1 | Warzone, crater spoil and ground texture rebuilt on every econ frame (1 Hz), even when nothing changed | Trigger verified; cost suspected |
| R2 | Batches with `Bounds(0, 1e5)` are drawn at all 3 wrap images, and shadows are never culled | 3× submission verified |
| R3 | Units are not frustum-culled; every unit gets full figure work each frame | Verified mechanism |
| R4 | `terrain.CompleteAll` blocks the main thread when trenches or impacts change | Verified mechanism |
| R5 | Combat dirties city cells; base composes take 15–170 ms (code comments); every compose scans all buildings | Verified mechanism |
| R6 | Territory field: O(N) signature every frame; full-texture main-thread rebuild on any ownership change | Verified |
| R7 | First combat: lazily created effect resources, no shader or PSO warm-up, URP opaque texture toggled per big explosion | Lazy creation verified |
| R8 | 16k-particle managed simulation on the main thread; cosmetic emission has no visibility gate | Verified mechanism |
| R9 | URP settings: MSAA 4× plus SMAA; shadow distance follows telephoto zoom (whole map shadowed at strategic zoom); full-screen 18-step shroud ray-march; VSync on | Verified from settings |
| R10 | Panning: no geometry rebuilds; minimap re-tessellates and the overlay repaints every frame | Suspected contributor |
| R11 | Per-frame batches use `Buffering = 1`; GraphicsBuffers are reallocated on growth | Minor |
| R12 | Steady GC churn: closures, LINQ, `ApplyImpacts`/`ApplyTrenches` scratch allocations | Low |

## Details

**R1 – full warzone rebuild every econ frame**
- Every econ frame carries `bf`. `ClientSession.cs:292,296` bumps `BattlefieldRevision` and `TrenchRevision` unconditionally.
- `WarzoneRenderer.cs:199-246` then rebuilds everything:
  - all trenches, intensity tiles and wrecks;
  - `CraterSpoil()` (`:162-197`), which loops over all N tiles and places up to 14,000 clods, each doing a `Surface()` → `CraterRelief` sample.
- `GroundField` rewrites the full W×H texture and calls Apply.
- The bootstrap then loops over all N tiles calling `IsWasteland`.
- Cost grows with match age.

**R2 – oversized bounds**
- Affected batches:
  - warzone (15 batches, most casting shadows);
  - craters (4,000), wrecks (800) and rubble (2,400);
  - decals (900);
  - turrets;
  - commander rings;
  - city activity.
- Because the bounds are so large, every instance is submitted 3 times on wrapping maps, and shadow cascade culling is defeated.

**R3 – units not culled** (`UnitRenderer.cs:264-547`)
- Per figure: `AddSquad` with `TrenchNearest`, up to 6 `FigureBlocked` attempts (each scanning the footprints of 7 tiles), and `GroundHeight`.
- About 77 batches use 1e5 bounds and cast shadows into both cascades.

**R4 – CompleteAll on every geometry change**
- `GameBootstrap.cs:190` sets `session.BeforeGeometryChange = terrain.CompleteAll`.
- It is called from `ApplyTrenches`, `ApplyImpacts` and `ApplyGeo`.
- It completes up to 6 Burst chunk jobs plus their `Finish` (mesh apply).

**R5 – city recomposes during combat**
- `WorldModel.cs:191-192,229-230` adds impact and trench tiles' chunks to `DirtyCells`.
- `InvalidateRingDistricts` re-dirties nearby base cells.
- `StructureStore.cs:78` bumps `Revision` whenever `dirtyCells` is non-empty, which re-runs:
  - the `DistrictPlanner` union-find;
  - unit footprints;
  - `DefenceSignature`.
- `Compose` (`CityRenderer.cs:288-298`) loops over all buildings.

**R6 – territory field** (`TerritoryField.cs:46-79` signature; `:142-223` rebuild)
- The rebuild iterates every texel at 3 texels per unit, stamps through a capturing lambda, and uploads 2 RGBA textures.

**R7 – first combat**
- Lazily created resources:
  - shockwave and dome meshes and materials;
  - missile bodies;
  - light GameObjects;
  - decal textures and materials via `Resources.Load`.
- `Atmosphere.cs:183` toggles `requiresColorOption`, which adds or removes URP's opaque copy pass.
- No ShaderVariantCollection or GraphicsStateCollection warm-up exists.
- Side note: additional lights are disabled in the URP asset, so the 4 pooled flash Lights do nothing.

## Safeguards already in place
- `InstanceBatch` uses `RenderMeshPrimitives` with structured buffers and uploads only when dirty.
- Terrain uses Burst jobs (at most 6), hi/lo LOD and tree bands.
- City:
  - 5 ms compose budget and 6 cells per frame;
  - base-recompose hold-off and BaseCache replay;
  - frustum test per cell;
  - VisualKey damage bands.
- Effects caps: particles 16k, craters 4k, wrecks 800, rubble 2.4k, decals 900.
- Units: VAT-skinned soldiers, badge aggregation at strategic zoom.
- Minimap: 8 Hz gather, 2 Hz texture.

## Suggested order
1. R1/R5/R6 gating: rebuild only on real change.
2. R2: real bounds, or a single wrap image.
3. R3: frustum-cull units.
4. R4: remove `CompleteAll` from the snapshot path.
5. R7: warm-up.
6. R9: one AA method and a capped shadow distance.
7. IL2CPP.
