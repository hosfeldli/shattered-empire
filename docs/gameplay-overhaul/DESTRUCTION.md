# Destruction: bounded, fading battlefield damage (2026-11-18)

User report: "Deformed terrain and debris build up over a match and never clear. I think this is killing
performance. Use textures or decals for destruction, not many Unity primitives, and fade debris out over time."

## What accumulated before
| Item | Where | Bound before | Lifetime before |
|---|---|---|---|
| Crater impact records (terrain bowls, lips, scorch, spoil colour) | server `g.impacts`, client `WorldModel.Impacts` | 6 per hex, 6000 total | removed one per crater level: 15 min per level off-road, so up to 45 min |
| Crater spoil clods (instanced boxes, each sampling the terrain) | `WarzoneRenderer.CraterSpoil` | 14 000 instances | as long as the impact |
| Scorch / crater decals (vehicle and building deaths) | `EffectsRenderer.craters` | 4000 (ring) | never faded |
| Building and vehicle rubble (instanced boxes) | `EffectsRenderer.rubble` | 2400 (ring) | never faded |
| Blood decals | `EffectsRenderer.Decals` | 900 (ring) | never faded |
| Legacy-ruleset wrecks (client only) | `EffectsRenderer.wrecks` | 800 (ring) | never faded |
| Server wrecks (obstacles, cover) | `g.wrecks` | 3 per hex, no total | 25 min |
| No-man's-land intensity (stumps, wire, debris props) | `g.intensity` | per hex | ~40–50 min to recover |

## Design
### 1. Crater spoil is drawn by the terrain, not by instances
The terrain chunk mesh already paints each crater: `ChunkMeshJob.CraterRelief` returns a spoil and a scorch
weight that tint the vertex colour, and raises the lip and the clod bumps in the relief. The 14k clod
instances on top of it are removed, along with the per-tile spoil cache (`SpoilKey` / `SpoilEntry`, perf pass
C4). That cache only made the re-placement cheaper; with nothing to place there is no cost left.
`WarzoneRenderer.PartMs[2]` (bench `spoilMs`) now always reads 0, and `-perf-legacy spoil` no longer does anything.

### 2. Crater healing is server-authoritative and replicated
- Each impact record holds full depth for `IMPACT.hold` = 60 s. It then fills in linearly over
  `IMPACT.heal` = 240 s and is removed. Total life is 5 minutes.
- The heal level is derived from the record's own `at` (already saved) and a map-wide heal clock:
  `healClock = floor(time / 30) * 30`. Nothing new is saved. Every client, a restored save and the server
  get the same value. The value changes only on a 30 s tick for the whole map. This is the batching that
  keeps chunk re-meshing low: each cratered chunk is rebuilt at most once per 30 s, through the normal
  deferred geometry queue (perf C1). Nothing rebuilds per frame or per second.
- `impactStep` (run in `battlefieldStep`, which runs at 1 Hz) removes the healed records once per tick.
- The total cap drops from 6000 to 3000 records. At a 5-minute life that still allows 10 impacts a second
  sustained.
- The crater aggregate `c.d` controls gameplay: cover (`scarCover`) and vehicle cost (`scarCost`). It now
  softens one level every 180 s, or every 90 s on roads (`CRATER_HEAL`). Before, this was 900 s and 300 s.
  Crater healing no longer deletes impact records: a half-healed bowl used to vanish in one frame. Records
  heal on their own clock. Engineers filling a crater still clear its records, as a deliberate action.
- Fog memory: a remembered impact row now stores its `at` (6th element). Remembered craters heal on the same
  public schedule, and once per tick `rememberBattlefield` forgets the healed ones. Memory rows from older
  saves have no time and count as healed.
- No change to forest clearing. Cleared forest stays cleared (wear `h` passes and terrain changes are untouched).

### 3. Other server lifetimes
| What | Before | Now |
|---|---|---|
| Wreck life (`WRECK.life`) | 1500 s | 600 s |
| Wrecks per hex / map-wide | 3 / unbounded | 3 / 400; the oldest on the map is dropped first |
| Intensity recovery | 0.025 per s above 40, 0.05 below | 0.1 per s above 40, 0.2 below. A stage-3 waste is clear in about 8 min; the 60 s quiet grace is unchanged |
| Scorch fade | 0.0015 per s after 120 s | 0.004 per s after 60 s (about 4 min) |
| Historical scars | 0.00025 per s | 0.001 per s (about 16 min) |
| Ground wear | unchanged | unchanged (it carries the forest-clearing pass counter) |

### 4. Client-only marks fade (`Runtime/Effects/FadingMarks.cs`)
This is a fixed-capacity ring in age order. Each mark holds, then fades, then is dropped. Decals fade their
opacity (instance colour `w`). Opaque instanced debris sinks into the ground and shrinks to 40%, because the
instanced lit material has no alpha. The GPU batch is rewritten only when a mark was added or expired, or
while marks are fading, at most twice a second of game time. Nothing is allocated after construction. The
clock is game time scaled by the simulation rate, so marks hold while the game is paused.

| Mark | Cap (before → now) | Hold + fade |
|---|---|---|
| Scorch / crater decals | 4000 → 1500 | 60 s + 120 s |
| Rubble and vehicle fragments | 2400 → 1600 | 45 s + 75 s |
| Blood | 900 → 600 | 40 s + 50 s |
| Legacy wrecks | 800 → 300 | 180 s + 60 s |

The wreck scorch decal and the fragments drawn by `WarzoneRenderer` go away with the server wreck. Their
count is bounded by `WRECK.total`.

## Wire and save changes
- `bf.m` rows go from `[tile, class, x, z, severity, seed]` to `[tile, class, x, z, severity, seed, heal]`,
  where heal is the percent of depth left (1..100). Fully healed rows are not sent.
  - Unity reads the 7th field when present (`ImpactRecord.Heal`). Against an older server it defaults to 1.
  - Godot reads the first 6 fields and ignores the rest. It shows no gradual fade, but healed craters still disappear.
- In the client, `WorldModel.ApplyImpacts` stores depth as `radius * TerrainView.ImpactDepthPerRadius (0.25) * heal`.
  A fresh crater's depth is now 0.25 × radius instead of `0.035 + 0.10 × power`, which is almost the same.
  `ChunkMeshJob.CraterRelief` recovers heal as `depth / (radius * 0.25)`. The spoil tint fades over the first
  half of the heal and the scorch tint with the bowl. The record stays 4 floats, so `TerrainView` and the job
  layout are unchanged.
- Saves: no format change. `impacts[].at` already existed. Fog-memory impact rows gain a 6th element (`at`).
  On restore, `impactCount` is recomputed from the records instead of trusting the saved counter.
- `delta.js`: unchanged. The bf block's JSON changes at most once per heal tick from healing, so the existing
  identical-block suppression still applies (see the test).

## Verified
- C# type-check: the `check.csproj` copy builds with 0 warnings and 0 errors.
- Server: `node --test test/*.test.js`. New test: `test/destruction-healing.test.js` covers hold, heal and
  removal; steps only on the tick; crater softening; exact save/restore; fogged memory healing and pruning;
  bf delta suppression inside a tick; wreck life and cap.

## Needs an in-game check (Unity)
1. Shell a field and watch for about 5 minutes. The bowls should hold for 1 minute, then visibly fill in
   every 30 s, with the paler spoil tint fading by about 3 minutes and the whole crater gone at 5 minutes.
   Look for a frame hitch on the 30 s heal tick when many chunks are cratered (profile `terrain` / the
   `impacts` geometry apply).
2. With no clod instances, check that crater lips still read as broken ground at mid zoom. If they look too
   bare, increase the spoil tint or the clod relief in `CraterRelief`; do not add instances back.
3. Check that destroyed buildings' rubble sinks smoothly over 45–120 s without popping, and that the scorch and
   blood decals fade instead of disappearing all at once.
4. Wrecks now clear after 10 minutes. Check that this feels right for gameplay (they are cover and obstacles).
5. Check that the `.meta` file for the new `Runtime/Effects/FadingMarks.cs` is generated on import and committed.
