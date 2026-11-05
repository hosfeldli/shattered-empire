# Living World Engine: implementation contract

Updated 2026-11-04. This is the persistent checklist for the user's complete 30-section design,
including later corrections. The design describes the intended result; this checklist records
what is actually present and what still needs acceptance. A working first pass is not a passed
production-quality gate.

The later [native redesign](NATIVE_REDESIGN.md) explicitly authorizes versioned pacing and
gameplay simplification: native matches remove government/treaty management and all trading.
Those instructions supersede the original administration-parity and unchanged-balance goals.
Server authority, save compatibility and the complete visual/performance acceptance still apply.

## Scope and nonnegotiable rules

- Develop **Godot 4.7.2 native**, Windows and macOS, procedural 3D with an orthographic camera and
  native screen-space interface. `client/` and `desktop/` are reference material only. Do not add
  browser features or spend development effort maintaining a parallel renderer.
- The existing Node.js server owns gameplay, balance, terrain, ownership, movement, connectivity,
  formations, combat and visibility. Client presentation never changes these rules.
- Every output is gameplay-authoritative, state-derived visual, or purely decorative. Decorative
  paths, civilians, rubble and visual offsets cannot grant movement, cover, collision or attacks.
- Preserve authoritative IDs and individual selection even when geometry is combined.
- Generate only from information this viewer has received. Missing climate, historical impact or
  personnel information is an explicit data gap, not permission to invent authoritative facts.
- Context-aware, spatially continuous, deterministic, gameplay-faithful and scalable are required
  properties of every subsystem. No per-frame procedural regeneration of unchanged objects.
- Use stable world/object/recipe-version/purpose seeds. Camera movement, owner changes, ordinary
  HP changes and reconnects must not reshuffle established layouts.
- Prioritize controls, units, terrain/obstacles, orders, economic feedback, then decoration.
- No public release, deploy workflow changes, or retirement of existing files is implied by a
  development preview. Local commits and local builds are authorized.

All nine composition inputs remain in scope: identity, geography, adjacency, development,
condition, history, activity, visibility and presentation scale. History and climate support are
currently less complete than identity, geography and adjacency.

## Latest visual corrections: acceptance criteria

- [x] Fixed camera pitch: zoom changes magnification without stretching the world.
- [x] Keep previous district meshes until their replacements are ready; share wrapped copies.
- [x] Stable irregular house layouts and parcel offsets/headings instead of identical radial rows.
- [x] Remove broad building base plates. Foundations belong under individual structures.
- [x] Sample footprint heights; adapt foundations to slopes and reserve dry sites beside rivers.
- [x] Reject decorative connections across water where no authorized crossing exists.
- [x] Real-server reload regression: geometry, visibility and rendered land colors match after
  rejoining; 2,520 close-zoom city-center samples pass both before and after reload on the M3.
  Remove the validation driver's temporary pink/purple background; reset weather/overlay state
  and invalidate urban soil locally when a building completes.
- [ ] User confirmation of the original broad blue surface after **world reload**. It has not
  reproduced in the current verified test. Preserve the screenshot/report as an open observation
  rather than claiming a conclusively identified original cause.
- [ ] Review natural placement, clipping, pop-out and readability in a larger inhabited city.

## Traceability to the full design

Each numbered item corresponds to the original design section. File paths are relative to `godot/`.

### 1–5: meaning before geometry

1. **Executive design.** `WorldCompositionSystem` coordinates shared graph, recipes, identities,
   site planning, weather, LOD and generation. Buildings, actors and battlefield presentation
   consume these services. Remaining: production-quality coherence across the complete vertical
   slice, especially historical development and mixed-use compounds.
2. **Simulation truth.** `WorldState`, `WorldStateAdapter` and command tools mirror received state
   and send existing commands. Decorative agents do not become server units or collision bodies.
   Remaining: audit every new recipe and effect against visibility and authority constraints.
3. **Composition pipeline.** Changes invalidate graph/recipe/geometry work; cached meshes and
   cooperative jobs replace frame-driven regeneration. Remaining: safe immutable geometry work
   on workers where profiling justifies it; main-thread scene/resource commits stay controlled.
4. **Semantic graph.** `WorldSemanticGraph` includes settlements, districts, buildings,
   infrastructure, resource/geographic features, units, formations, armies and battle regions.
   Local topology changes avoid whole-world regrouping; ordinary progress does not regroup.
   Remaining: complete TerrainRegion/EnvironmentalRegion coverage, historical relationships,
   richer road/rail/bridge dependency invalidation and explanatory diagnostics for every output.
5. **Recipes.** `RecipeRegistry`, `recipes/buildings.json` and `VisualIdentityCache` provide
   validated priorities, preconditions, material mappings, explicit versions and purpose seeds.
   Remaining: richer declarative environmental/adjacency/damage/animation grammars for every
   category, including explicit validation when hard constraints leave no physical site.

### 6–11: terrain, settlement and asset vocabulary

6. **Physical terrain.** `WorldRenderer` uses received quantized elevation, shared corner samples
   and chunked meshes. `SitePlanner` samples slope and visible hydrology. Wrapped chunks retain
   stable instances. Remaining: landscape art review of ridge continuity, passes and river beds;
   smoother shared river curves, richer retaining structures, climate-supported snow/scree, and
   terrain-change acceptance with connected infrastructure. Decorative relief must stay small.
7. **Biomes.** `EnvironmentRenderer` partitions vegetation/props spatially with deterministic
   placement and distant canopy detail. Remaining: gradual ecological transitions, coherent
   clearings, regional identities, climate-aware vegetation and destruction/recovery of forests.
8. **Districts.** Compatible buildings group through the semantic graph; selection keeps each ID.
   Replacements hand off atomically. Housing and farmland have stable local variation and water
   setbacks. Remaining: streets-first settlement planning, shared courtyards/walls/grounds,
   physically convincing mixed-use transitions, port/industry integration and district art review.
9. **Growth/history.** Identity seeds survive ownership, camera changes and reconnects. Existing
   pieces are reused while changed districts build. Remaining: gradual architectural additions,
   recognizable mixed-era growth, persistent birth-era/layout metadata where reconstruction alone
   is insufficient, and visible reconstruction history without reshuffling neighbors.
10. **Buildings.** `AssetLibrary`, `SettlementRenderer` and Blender-authored residential GLBs
    establish the modular asset path. Other types have procedural first-pass silhouettes and site
    adaptation. Remaining: the full authored library, mine/quarry/industrial geographic variants,
    machinery, distinctive level/era additions and production-quality damage components.
11. **Materials/crispness.** `MaterialLibrary`, authored albedo/normal/roughness maps and
    `shaders/world_surface.gdshader` share material families, stable world-space scale, triplanar
    mapping and wetness. Labels remain native screen-space text. Remaining: complete material
    coverage, disciplined weathering/rust/scorch layers, wrap-phase review, close-zoom texture
    quality review and authored asset polish. Automated asset generation is not an art-budget
    estimate; actual artist hours and the remaining production budget have not been established.

### 12–20: a world that changes coherently

12. **Construction/destruction.** Actual progress, HP and ruin state drive construction and basic
    damage geometry independently of production effects. Remaining: material-specific damaged
    components, convincing local collapses, bounded significant-impact metadata if necessary,
    independently damaged shared walls and persistent reconstruction visuals. Rubble never adds
    unauthorized movement obstacles.
13. **Living cities.** `CivilianActivitySystem` has a bounded visual-agent budget, deterministic
    local/road routes and activity derived from received population, condition, staffing and rain.
    Remaining: a complete activity graph with meaningful destinations, economic freight context,
    construction crews, occupied-city behavior and more varied industrial animation.
14. **Military generation.** Authored infantry poses, tracked hull/turret, scout vehicle, artillery
    and aircraft components retain authoritative positions/IDs. Turret aiming uses received
    targets; suppression and grounded aircraft use actual state. Remaining: full animation state
    machines, richer equipment/faction/era variants, terrain pitch/roll, city movement clipping,
    reliable casualty representation and a broader recognizable asset library.
15. **Formations/armies.** Native tools send existing deployment and movement-shape commands;
    graph membership and far-zoom groups use authorized records. Remaining: polished rank/slot
    presentation, coherent marching transitions, support positioning, army command coverage,
    facing/frontage overlays and readability with very large mixed formations.
16. **Combat director.** `CombatPresentationDirector`, pooled effects and bounded original audio
    consume actual events and camera/quality budgets. Remaining: richer event-linked weapon,
    reaction, suppression and destruction animation, plus occlusion/readability review during
    sustained large combat. Cosmetic figures cannot generate extra fire or damage.
17. **No man's land.** `BattlefieldComposer` adds a continuous scar field to received intensity,
    craters and wrecks; graph battle regions connect adjacent activity. Remaining: merged crater
    geometry, damaged vegetation/infrastructure, spatially partitioned persistent field meshes,
    local terrain adaptation and convincing server-driven recovery.
18. **Unified environment.** Shared `EnvironmentContext` drives wet surfaces, rain, activity and
    smoke wind; clouds/water have native presentation. Remaining: coherent shoreline foam,
    wind-responsive water, climate-authorized snow/fog/temperature, environmental transitions
    across wrap, and weather response in every future asset. Do not fabricate missing records.
19. **Infrastructure.** Existing road/rail/bridge/trench records render natively and can be drawn
    with native tools. Paths sample terrain; decorative links respect water. Remaining: smoother
    intersections/approaches, more convincing terrain integration, structural bridge damage,
    material/class variants, continuous defensive parapets and full visual connectivity review.
20. **Historical memory.** Stable IDs and deterministic identities preserve appearance across
    ordinary state/ownership changes. Remaining: compact versioned historical layout/impact
    records where needed, occupation/reconstruction transitions and historical front-line recovery.

### 21–27: scale, contracts, tools and acceptance

21. **LOD/readability.** Shared tactical/operational/strategic scales, four quality budgets, native
    labels and far military symbols exist. Remaining: complete building/formation/army LOD,
    continuous transitions, selection/target clarity review and useful far-zoom borders/overlays.
22. **Godot architecture.** Current modules implement the proposed service responsibilities;
    existing renderer names need not be replaced with empty Composer shells. `GenerationScheduler`
    prioritizes/cancels superseded work and separates preparation from commit. Remaining: profiling
    and partitioning of every expensive stage, safe worker preparation, richer priority/camera
    relevance and strict generation budget acceptance.
23. **Performance.** Provisional M3 1920×1080 late/256-map runs averaged approximately 60 FPS;
    see checkpoint JSONs and STATUS. Remaining: current-source quiet-machine repeat, meaningful
    GPU timing, strict p99/chunk/memory budgets, integrated-GPU fallback, long-session stability,
    worst-case combat and input latency. Average FPS does not prove these gates.
24. **Data contracts.** Existing negotiated `geo` records and server command formats are used.
    Native client changes do not alter server gameplay or the reference client. Remaining:
    visibility-filtered optional climate, stable layout and significant-impact metadata only where
    necessary. Compact/binary formats remain conditional on measured network cost.
25. **Save/reconnection.** Server saves truth; the native client reconstructs from authorized state
    and versioned seeds. Real network tests cover rejoin after server restart. Remaining: rendered
    reload acceptance, recipe-version migrations and persistence of irreconstructible identities.
26. **Authoring tools.** F4 exposes graph/recipe/seed/site/budget diagnostics; fixed-seed tests,
    screenshots and repeatable Blender/material/audio source scripts exist. Remaining: all twelve
    standardized development scenes, detailed rule/dependency failure overlays and a maintained
    visual regression baseline with controlled animation time.
27. **Acceptance tests.** Headless rendering/composition/LWE checks, real-server command tests,
    network restart tests and actual-GPU zoom sampling exist. Remaining: all qualitative terrain,
    city, population, military, combat and performance criteria in the original specification.
    Local passing tests do not imply that this entire acceptance matrix has passed.

### 28–30: phased proof and final quality

28. **Implementation gates.** Foundation/network/controls are usable; semantic graph/recipes and
    terrain/building/district systems have working implementations. Living cities, military,
    combat/destruction, environment/history and final optimization have partial first passes.
    No phase is production-approved merely because a module exists.
29. **Integrated vertical slice.** A fixed-seed river-city test builds housing, trains a unit, draws
    roads/trenches/formation frontage and builds a real bridge through existing commands. Remaining:
    the complete mountain/mine/river/city/economy/defense/battle/weather region, upgrades,
    destruction/recovery and save/reload continuity in one sustained playable scenario.
30. **Final standard.** Every system must look like part of one physical, readable, historically
    evolving environment. Remaining: production art direction, broader playtesting and explicit
    quality/readability/responsiveness/stability review. The full LWE is not finished.

## Checkpoint and release rules

The original [ROADMAP.md](ROADMAP.md) preserves the A1–A5 and B1–B7 review sequence. The later user
direction makes Godot the sole development target; the browser is now reference only. Full native
UI parity, strategic overlays, audio/animation polish, CI, distribution and retirement are still
tracked. Local development exports are not trusted signed/notarized public releases; Windows
runtime acceptance requires a Windows machine. Never modify `deploy.yml` for these checks.

Use [STATUS.md](STATUS.md) for measured results and known limits, [../README.md](../README.md) for
run/check commands, and [../../tools/art/README.md](../../tools/art/README.md) for asset authoring.
