# Production scheduler: rules and wire contract (W1)

**Code:** `server/sim/actionProduction.js`. It is re-exported from `actionBases.js`, and `actionBases.productionStep` drives it every 3 ticks.
**Rules:** R1 (shared capacity) and R2 (no refunds) in [REQUIREMENTS.md](REQUIREMENTS.md).
**Tests:** `test/production-scheduler.test.js`.

## Model

Each producing building (any `ACTION_BUILDINGS` entry with `trains`) has one **production capacity** budget, in work units per simulation second:

```
capacity = def.production (1.0) / (siteBonus ? 0.88 : 1) / (1 - 0.15 × (level - 1))
```

- An item of unit `u` needs `ACTION_UNITS[u].time` work units.
- At capacity 1.0, a single queue builds exactly as fast as the old FIFO did.
- The site bonus and the era level change only the shared budget.

`b.queues` is an ordered list with at most one entry per unit type:

| field | meaning |
|---|---|
| `unit` | unit type |
| `count` | items queued, including the one in progress |
| `priority` | 0 low, 1 normal (default), 2 high |
| `work` | progress on the current item (0 .. time) |
| `paid` | `{ materials, energy }` consumed by the current item so far |
| `reserved` | command capacity held by the current item (0 until it starts) |
| `ready` | the current item is finished and waiting for a free exit |
| `paused`, `repeat` | player flags |
| `state` | see below |

A building holds at most `PRODUCTION.maxQueued` items in total (20).

### Scheduler, once per interval (dt = 0.3 s)
1. Finished items that are waiting for an exit retry their spawn.
2. The budget `capacity × dt` goes out by priority tier: 2, then 1, then 0.
3. Within a tier, each eligible queue gets an equal share.
4. A queue that cannot use its whole share (out of resources, no command capacity, or its item finished) drops out of the round. The others re-share the remainder.
5. A queue that delivered an item stays in the round and starts its next item with what is left.
6. Summed work is always ≤ capacity × dt. More queues never add throughput.

### Payment
- Cost is consumed in proportion to work: `paid = cost × work / time`. It is recomputed from the totals, not accumulated, so it cannot drift. It settles to exactly `cost` at completion.
- A queue advances only as far as the stockpile can fund. When short, it shows `resources` and resumes on its own once funds arrive.
- An item never completes until it is fully paid.

### Command capacity
- An item starts only when its `capacity` can be reserved.
- `armyCapacity` counts every reservation. Within a step, a per-civ free-capacity counter is decremented as reservations are made, so two buildings can never claim the same capacity.
- A finished item that is waiting for its exit keeps its reservation and is never charged again. On spawn, the reservation becomes the unit.
- Queueing is allowed beyond the cap and without resources.

### Cancellation
- Unstarted items are removed first. They were never charged.
- Cancelling the item in progress loses what it consumed (no refund) and releases its reservation.
- The same applies to `clearQueue` and to a destroyed building: the queues vanish with the building, and nothing was charged beyond the work done.
- In the action ruleset, buildings never change owner. A lost HQ removes every facility at the site.
- Prerequisites cannot be lost in the current ruleset. If they are, the queue shows `prerequisites`: it holds its progress, gives back the reservation of an unstarted item, and resumes on its own.

### Queue states (`qs[i][4]`)

| state | meaning |
|---|---|
| `producing` | received work this interval |
| `resources` | stockpile cannot fund (further) work |
| `capacity` | the next item cannot reserve command capacity |
| `prerequisites` | the unit's tier or facility is no longer met |
| `exit` | finished, waiting for a clear exit (`b.state` is `exit blocked`) |
| `paused` | paused by the player |
| `waiting` | eligible, but higher priorities used the whole budget |
| `idle` | nothing queued (transient) |

## Commands

| command | effect |
|---|---|
| `train { ids:[id], type, count, priority? }` | add `count` to that type's queue. Legacy `{ id\|building, unit }` is still accepted. |
| `batchTrain { buildings, unit\|type, count, policy:'each'?, priority? }` | spread over buildings by earliest finish, or `count` in each |
| `cancelTrain { id, type, count \| all:true \| count:'all' }` | cancel unstarted items first, then the one in progress. Reply: `{ cancelled: { count, lost:{materials,energy} } }` |
| `cancelTrain { id, index }` | legacy: the index into the flattened `q` list picks the type, and one item is cancelled |
| `setPriority { id, type, priority }` | 0, 1 or 2 |
| `clearQueue { id }` | drop every queue. Reply: `{ cancelled: { lost } }` |
| `pauseTrain { id, type, on }` | pause or resume one queue. `pause` is already the game-pause command in worker.js. |
| `repeat { id, unit\|null }` | that type's queue keeps one item queued forever. It is created if missing. |

`train`/`batchTrain` reply `{ training: { queued, reason, waiting?: ['resources','capacity'] } }`. `waiting` is advisory: the order is queued and simply waits.

## Wire (econSnapshot, own buildings)

New fields:
- `qs: [[unit, count, priority, progressPct, state, repeat 0|1], ...]`, in queue order.
- `cap`: production capacity in work units per second.

Legacy fields, kept until the client migrates:
- `q: [[unit, secondsLeft], ...]` is flattened: each queue contributes `count` entries. The first entry's seconds left is computed at full capacity.
- `tr`: the first queue's progress %.
- `rp`: the repeat unit.

`econ.capacity` is `{ used, queued, reserved, pending, limit }`:
- `queued = reserved + pending` is the whole pipeline (the HUD shows it).
- `reserved` is what started items hold.
- Free capacity = `limit − used − reserved`.

## Saves

- `persist.restoreGame` calls `migrateProduction`. Old buildings carry `queue: [{ unit, left, total }]`, with every item paid in full.
- The first item of each type becomes that type's queue with its progress, `paid` = full cost, and its reservation.
- Later items of the same type were prepaid but never started, so their cost goes back to the owner, and they will be paid progressively.
- `b.queue` is deleted. The migration is idempotent and deterministic (no RNG).
