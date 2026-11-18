# Optimisation plan (ranked)

Ranking factors:
- the measured impact on the player-visible symptom (freezes, p99, FPS decay)
- confidence in the diagnosis
- risk to gameplay, visuals and multiplayer
- effort

Every item is one isolated change, measured against the same deterministic scenario (seed 7, 4-AI observe) before it is kept.

## Wave 1: done in this pass

Client items, owned by the lead:

| # | Register | Change | Why it ranks here | Risk |
|---|---|---|---|---|
| 1 | C1 | Defer geometry updates instead of blocking on terrain jobs | Largest measured freezes (0.4–1.2 s); pure scheduling change, same final state | Crater/trench visuals appear a few frames later |
| 2 | C2 | Local base-compound cache key | 300–990 ms frames from early game on; the key changes were proven unnecessary by reading the compose inputs | A stale compound if an input was missed; inputs were audited |
| 3 | C3 | Per-hex street record/replay | 28–60 ms per cell compose, the dominant city cost after (2) | Same as (2); keyed on a 5×5 neighbourhood of all street inputs |
| 4 | C5 | Per-tile crater spoil cache | Warzone 100–300 ms; grows with match age | Same keys as the terrain sampling; identical order and cap |
| 5 | C6 | Threaded territory rebuild plus texel→hex cache | 60–130 ms per ownership change | Territory tint appears one or more frames later |
| 6 | C4 | Compare lane content before bumping `LaneRevision` | Removes forced warzone rebuilds | None |

Server items, owned by Impl:

| # | Register | Change | Why it ranks here |
|---|---|---|---|
| 7 | N1 | Per-unit re-route backoff | Largest production cost |
| 8 | N4 / S6 | Cheaper group orders | AI p99 spikes of 100–370 ms; order latency |
| 9 | N5 | Unreachable-order pre-check | — |
| 10 | N6 | Remove the duplicate invalidate | — |
| 11 | S2 | Per-team visibility stamping, byte-identical | Second steady server cost |
| 12 | S4 | Omit unchanged `bf`/`fw` per viewer | Also removes client work |
| 13 | S5 | Cached autosave encoding | — |

Each of these has its outcome recorded in [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md).

## Wave 2: next, in order of expected value

1. **C9: unit renderer frustum culling, then a Burst figure job.** `units` takes 4–6 ms on average with spikes late in the match; it is the largest steady client phase after Wave 1.
2. **C7: GC.** First take a Development-build Profiler capture with GC.Alloc callstacks to rank the allocators. Then:
   - decode snapshots with a streaming reader rather than a JObject tree;
   - remove per-frame LINQ and closures (`SetPickups`, `Commander.Update`, the HUD lambdas in `Present`).
3. **N2 / N3: navigation fast paths.**
   - A per-tile "plain ground" passability cache.
   - Let blocked units sleep.
   - Lazy route refinement.
   - These need deterministic replay tests.
4. **S3: per-team target index** for dense battles.
5. **C10: real bounds or a single wrap image** for world-wide batches.
   - Also turn off shadows on debris and clods.
   - Clamp the telephoto shadow distance.
   - This is a GPU-side change, worth more at 1440p/4K.
6. **C11: warm up effect resources and shaders at load**, with a capture of the first-combat hitch.
7. **IL2CPP for the player.** Every managed main-thread loop is Mono JIT today. It needs the toolchain and a full regression pass.

## Explicitly not planned
- **A Unity NavMesh or ECS rewrite.** There is no evidence for it; the costs are in algorithm and invalidation choices.
- **Lowering quality or capping unit counts.** That would hide symptoms rather than fix them.
