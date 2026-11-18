# Gameplay overhaul: requirements and confirmed rules

**Source:** the gameplay overhaul directive (2026-11-17).

The seven rules below are final. Every workstream implements them the same way across the server simulation, AI, UI, serialization, networking and tests.

| # | System | Rule | Invariant to test |
|---|---|---|---|
| R1 | Production capacity | A building has one production-capacity budget, in work units per simulation second. Its unit-type queues share that budget. Adding queues never raises total throughput. | Summed work across a building's queues within an interval ≤ capacity × dt |
| R2 | Cancellation | Resources already consumed are never refunded. Resources not yet consumed were never charged (or a reservation is released). This also applies when a building is destroyed, its queue is cleared, it is captured, or a prerequisite is lost. | Consumed resources equal work done × cost per work. Refund on cancel = 0. |
| R3 | Infantry | Infantry are produced in squads (batch size is data-driven). Each soldier is an independent, controllable entity. | One finished batch creates N independent units, and N population is reserved before production starts. |
| R4 | Garrison | Garrisoned units get protection, plus firing bonuses only where the structure provides firing slots. | Garrisoned units are never duplicated or invulnerable. Firing slots are capped. |
| R5 | Terrain | Tank-cleared forest and other terrain changes persist for the whole match, including through save/load and multiplayer replication. | Server state, client view, navigation and the save file all agree. |
| R6 | Multiplayer speed | A speed change needs approval from every eligible active player. Any rejection, or a timeout, fails the vote. The change is applied at a synchronized boundary. | Speed never changes without unanimous approval. |
| R7 | Capture | When capturing stops, progress decays gradually (it is not reset instantly). Default: capture takes 20 s, and full progress decays to zero in 15 s. | Progress at t+dt is greater than 0 and less than progress at t whenever nobody is capturing and progress is above 0. |

**Performance invariant**
- No feature may add unbounded per-unit, per-building or per-frame work without a benchmark. Use the tools in `docs/performance/BASELINE.md`.
- New client visuals must be instanced or batched, never one GameObject per entity.
- New server systems run on the scheduler, with metrics.

Requirement status per item is tracked in [AGENT_TASKS.md](AGENT_TASKS.md).
