# Economy design (W1)

## Resources
- There are two stockpiles: **materials** and **energy**.
- Income comes from processors (depots), generators, the headquarters and outposts. `productionStep` sets the rates every 3 ticks, and `incomeStep` credits them every tick. That part is unchanged.
- Command capacity is the population cap: 140 / 220 / 300 by era, capped by the lobby army limit.

## Production (R1, R2)
Production is a **flow**, not a purchase. See [PRODUCTION_SCHEDULER.md](PRODUCTION_SCHEDULER.md) for the exact rules and the wire contract.

- **Throughput:** a facility's throughput is one shared budget (work/s). Levels and site bonuses raise it. Queueing more unit types splits it; it never multiplies it.
- **Payment:** cost is paid while an item is built, in proportion to its progress. Money in the bank is never locked up by a long queue, and a stalled economy slows production instead of refusing orders.
- **Cancelling:** the work already paid for is lost. Nothing else was ever charged. The same holds when a facility is destroyed.
- **Command capacity:** it is reserved when an item starts, not when it is queued. Players may queue ahead of their cap and their wallet. The queue shows why it is waiting.
- **Priorities:** priorities (high, normal, low) decide who gets the budget first. Equal priorities split it evenly.

## Balance intent
- At default priority with one queue, unit times are exactly as before (capacity 1.0 = the old timer). Unit costs, HP and times belong to W3 and are untouched.
- Spending is smoother. The old up-front charge is spread over the build time, so effective spending per second is cost ÷ time per busy queue.

## AI
The AI's production section (`actionAI.js`):
- Treats what is already queued as a commitment against the stockpile (`productionCommitment`), so it only queues what it can sustain. Under the old up-front model that reserve was implicit.
- Keeps at most two items per facility.
- Gives urgent answers (air defence, anti-armour, tanks against armour) high priority and scouts low priority.

Its army composition logic is unchanged.
