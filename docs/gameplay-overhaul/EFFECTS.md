# Effects pass (workstream E, 2026-11-18)

Three user requests: weapon recoil; better missile launch, flight and interception effects; a height-sensitive,
volumetric ground shock that knocks trees down (none survive a nuclear blast).

## 1. Recoil

`Runtime/Military/UnitRenderer.Recoil.cs` (new partial) holds the curves; `UnitRenderer.cs` calls them in five small
hunks. Every `fire` / `launch` event already restarts the shooter's shot age (`NoteShot`); recoil is a function of
that age: a run-back over ~20 ms, then an exponential return to battery.

| What | Close detail | Mid zoom (batched) |
|---|---|---|
| Tank / autonomous tank gun | barrel runs back 0.21 model units (was 0.16), returns in ~0.6 s; hull rocks on its suspension (impulse 1.5, was 1.1) and settles back 1.2% of scale | turret mesh runs back 40% of the barrel stroke |
| SP howitzer | barrel 0.30, slow counter-recoil (~1 s); hull impulse 2.4 (was 1.6); body back 2.5% | turret mesh |
| Towed field gun | whole gun jumps back 7% of scale on its trail, returns over ~1 s; impulse 1.2 | same jump |
| Rocket / missile launcher | shoved 1.5%, rocks (impulse 0.9, was 0.45) | – |
| Gun truck MG | unchanged (0.12 impulse) | – |
| Infantry | unchanged: the existing subtle rifle kick (AddFigure) and the rig's Fire clip | – |

Defense turret heads (`CityRenderer.Defenses.cs`, `HeadRecoil`): the head runs back along its aim on each shot:
artillery 0.055, fortress 0.04, AT 0.03, AA 0.012, MG 0.006 world units (a shudder). No allocation; a few flops per
drawn vehicle/head.

## 2. Missile systems

`Runtime/Effects/EffectsRenderer.Missiles.cs` (new) and the flight loop in `EffectsRenderer.Combat.cs`.

- **Launch** (`MissileLaunch`): flash + pooled point light, exhaust smoke billowing back along the ground (a silo vents
  it all round), a low dust skirt, sparks. Strategic: 22 exhaust puffs living 6–10 s, 12 dust, a steam column welling out
  of the silo, camera shake 0.25. Battery round: 9 + 5. Interceptor: 4 + 2.
- **Trajectories** (`FlightPosition`): battery rounds climb out steeply, apex at ~40% of the flight, a long dive (arc
  0.45 + 0.13·distance, max 2.4; was a flat 0.03). Strategic missiles leave the silo almost vertically (smoothstep
  horizontal progress), arc high (unchanged height) and re-enter steeply. Arrival times are unchanged (the server's
  flight time), so impacts still line up.
- **Travel** (`MissileTravel`): body, hot motor streak and an additive glow; the smoke trail is laid **by distance**
  (strategic every 0.2, battery 0.07, interceptor 0.06 units, ≤ 4 puffs per frame, spacing grows when the effects
  intensity is low), so a fast missile leaves an unbroken line. Puffs live 3–4.5 s (battery), 8–15 s (strategic, thicker in
  the boost phase) and drift and spread with the wind through the normal smoke physics.
- **Interception** (`MissileIntercept`, `InterceptBurst`): the server's `mintercept` event (it had no client visual) is
  now drawn: the visible missile nearest the intercept point is marked to die when an interceptor launched now reaches
  it (0.3–0.9 s); the interceptor flies from the defender (small launch, white trail) and the missile breaks up: flash,
  fireball, shrapnel, a smoke ball lingering 5–8 s and falling debris that lands and rests (strategic: bigger, burning
  fragments, flash 0.25, shake). If the launch was off screen, the interceptor bursts at the intercept point.
  `GameBootstrap.Shock.cs: PresentIntercept`, one `case "mintercept"` line in `GameBootstrap.cs`. Strategic is told
  from the event's weapon (`warhead`); no decoder change.

## 3. Height-aware volumetric shock wave

### Propagation (shared spirit, server and client)

`server/sim/shockwave.js` and `Runtime/Effects/EffectsRenderer.TerrainShock.cs` run the same algorithm with the same
constants (`SHOCK`: 48 rays, step 0.5, reach 16, up 0.45, down 0.12, channel 0.8, boost 1.7, core 4.5; all lengths
× scale):

1. March 48 rays from the burst over the height field (server: hex elevation mapped exactly like the client's
   `TileHeightFromGeo`, sea at 0; client: `GroundAt`, sea clamped to 0).
2. Each ray carries energy E from E0. Level ground spends `step/reach` per step (dies at `reach` on flat ground);
   climbing spends `up · dh / scale`; descending refunds `down · |dh| / scale`, never above E0. Lost energy stays lost,
   so the far side of a ridge is sheltered.
3. Channelling: pass 1 (E0 = 1) measures the blocked share of the front b = 1 − mean(min(reach_i, R))/R; pass 2 runs
   with E0 = min(1.7, 1 + 0.8·b). In a valley half the front dies on the walls, so the floor rays get ~1.4–1.6× the open
   reach, both ways.
4. One 1-2-1 smoothing pass across neighbouring rays.

Cost: 2 × 48 × 55 height samples once per blast (server and client); nothing per frame.

### Gameplay (server-authoritative, persistent)

`blastForest` (called from `actionCombat.resolveProjectiles` on a strategic impact):
- every FOREST hex whose centre is within `core` (4.5 units, ~1.7 × the warhead's damage radius) is cleared;
- beyond it, each forest hex falls with chance `smoothstep(0.12, 0.6, E)` where E is the front's energy at that hex
  (direction + distance interpolated), rolled from a tile hash (not `game.rng`, so blasts do not shift the match's
  random stream).

`blastTrees`: a heavy conventional blast (radius ≥ 0.9: missile, warhead drone, bombard) fells the forest of the hex it
hits with 10% chance, 30% for radius ≥ 1.2 (bomber). Both go through `battlefield.clearForest`: terr → GRASS, moisture
below the forest band, dense flag cleared, `world.touch` (geo delta replicates it), `forestNavDirty` (navigation
invalidated by `battlefieldStep` at most every 3 s; the strategic impact already invalidates nav once). terr / moist are
saved world arrays, so the clearing survives save/restore and never regrows. Legacy ruleset (`missiles.js`) unchanged.

### Client visual

`EffectsRenderer.TerrainShock` replaces the strategic flat ring (radius 22) and the 48 uniform radial dust puffs. Per live
shock (max 4) the front radius grows as far·√t over 6.5 s (reactor 5.5 s); on each ray the front stops where its energy
is spent. Drawn in one pooled dynamic mesh (`SE/GroundWave` shader, one draw per wrap image):
- a bright ground band along the front,
- a dust wall whose height is 1.15 × scale × the ray's energy there (leaning back),
- a taller, fainter billow behind it,
plus particles: every 0.06 s, dust puffs on half the rays (alternating), sized and faded by the energy, moving outward
at a fraction of the front speed (≈ 400/s, ≤ ~1300 alive per blast), and a pale condensation ring in the first 20%.
No per-frame allocation. A short flat 5-unit ring stays for the first instant at ground zero.

### Trees on the client

- Forest hexes cleared by the server lose their trees through the normal geo path: biome becomes grassland, the chunk
  rebuilds (`TerrainRenderer` places 5.5–9.5 trees on forest, 0.12–2.5 grove trees on grassland).
- The trees the server does not track (grove trees on grassland — including those a cleared forest hex keeps —, hills,
  tundra, marsh) are knocked down by the client (`GameBootstrap.Shock.cs: KnockTrees`): it applies
  `ShockFallChance` (1 in the core, then `smoothstep(0.05, 0.5, E)` per tree) to the terrain's sticky `TreeScars` bits
  and marks those chunks dirty. Nothing survives in the core; beyond it the forest is thinned with distance and terrain.
  Uses only `TerrainRenderer`'s public `TreeScars` / `MarkDirty` (no edit to that file). Requires the sticky-scar mode
  (default; `PerfFlags.LegacyTrees` off).
- Limitation: these sparse-tree knock-downs are client state; a reconnect or reload regrows them (the cleared forest
  itself stays cleared). Making them persistent needs a server "blasted ground" tile set on the wire and a TerrainRenderer
  check (owned by the perf agent).

## Wire changes

None. `mintercept` already carried interceptor (ax, az), intercept point (bx, bz) and weapon (w); forest clearing uses
the existing geo delta.

## Budgets

| Item | Bound |
|---|---|
| Terrain shocks | 4 live (oldest replaced), 48 rays × 3 quads each, one mesh |
| Shock dust | ~400 particles/s per blast from the shared 16 000 pool |
| Missile trail | ≤ 4 puffs/frame/missile; strategic ~360 puffs over a full flight |
| Launch | ≤ 22 + 12 + 10 + 6 particles (strategic) |
| Interception | ≤ 50 particles, 1 pooled light |
| Server blast | 2 × 48 × 55 height samples + ~1100 hex checks per warhead |

## Tests

`test/shockwave-forest-2026-11-18.test.js`: valley channelling (reach along the valley > open reach, walls < along/2.5),
open ground isotropy; nuke clears every forest hex in the core; trees fall in every direction on open ground; fewer
fall behind a ridge than on the open side; more far down a valley than up its walls; deterministic; a real strategic
missile (`launchStrategic` + ticks) clears ground zero and > 20 hexes, and the clearing survives save/restore.

## In-game checks

1. Tanks / SP guns firing close up: barrel runs back and returns, hull rocks back; SP gun clearly more. Mid zoom: the
   turret twitches back. Towed field guns hop back. Defense heads kick (artillery post most, MG a shudder).
2. Missile battery salvo: launch flash, back-blast smoke along the ground, missiles climb, cruise and dive, white
   trails that linger 3–4 s and drift downwind.
3. Strategic launch from a silo: ground venting cloud, near-vertical boost with a thick plume, high arc, trail visible
   ~10 s, steep re-entry; impact still lines up with the blast.
4. AA battery / air defense intercepting: an interceptor streaks up, the missile bursts in the air, debris falls.
   Off-screen launches: the interceptor bursts at the intercept point.
5. Nuke on open ground: the dust wall spreads evenly; in a valley: it runs both ways down the valley and dies a short
   way up the slopes; behind a ridge: weak. Forest hexes in the core vanish (geo update), sparse trees around are
   knocked down, nothing stands at ground zero. Navigation through the cleared hexes updates within ~3 s.
6. Performance: frame time during a nuke + a missile salvo (particle `Live` / `Skipped` counters).
