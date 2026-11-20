# Telemetry analysis: 0.6.0 AI games (2026-11-19)

Source: BigQuery `stem-471602.se_telemetry`. Window: 2026-11-19 22:37 UTC to 2026-11-20 01:11 UTC, server build
`9700bb8`, Cloud Run revision `shattered-empires-00031-jzw`, client 0.6.0. Only `env = 'prod'` rows were used; smoke
rows (`env = 'dev'`, `server_version = 'smoke-2026-11-18'`) are excluded. Queries were read-only `SELECT`s plus a
read of Cloud Run `WARNING`+ logs and the service's resource settings.

Each finding is marked **[data]** when the telemetry shows it directly, or **[inference]** when it is a conclusion
drawn from the data and the code.

## 1. What was played

| Match | Mode | Format / map | Seats | Speed asked | Sim length | Wall time | Result |
|---|---|---|---|---|---|---|---|
| 59f3a8 | observe | 4v4, random, size 104, max start res | 8 brutal AIs | 8x (1x for 3 min) | 56.0 min | 23.1 min | team 1 win, Decisive Domination |
| 05a938 | observe | ffa3, ring_of_fire, size 104 | 3 normal AIs | 8x, then 1x from sim 25 min | 50.8 min | 28.8 min | seat 2 (builder) win |
| 62fbe2 | ai | 1v1, random, size 152 | 1 human + normal merchant | 1x | 8.4 min | 20.6 min (parked while idle) | human eliminated |
| 94950a | ai | 1v1, random, size 152 | 1 human + normal builder | 1x | 13.7 min | 13.7 min | human eliminated |
| ff70a9 | observe | ffa4, random, size 152 | 4 normal AIs | 1x | 5.4 min | parked (idle) | unfinished |
| 0ed268 | pvp | 2v2 | 2 humans + 2 AIs | 1x | 12+ min | still running at cut-off | — |

Two client machines reported: a 6-core i5-8600K + RX 7600 XT at 144 Hz (Ultra, VSync on) and a 16-core
Ryzen 9 7950X + RTX 4070 at 60 Hz (Ultra, VSync on). All matches ran on one Cloud Run instance; at most 2 matches ran
at once.

The only heavy match is **59f3a8** (up to 562 units, 8 AIs). Most of the performance findings come from it; the other
matches had no server performance problems.

## 2. Ranked bottlenecks

| # | Bottleneck | Kind | Impact |
|---|---|---|---|
| 1 | Simulation throughput in large AI matches (routing + AI planning on one core) | server perf | 8x asked, **2.4x delivered** on average; tick p99 up to 927 ms, max 1.6 s; 32 % of loop intervals over budget |
| 2 | AI planner starvation: the 8th brutal AI never plans | gameplay bug | seat 7 built nothing, trained nothing, was eliminated at 6.7 min with 5,921 materials banked |
| 3 | Client hitches from `WarzoneRenderer` full rebuilds | client perf | single frames up to **5.0 s**; 937 frames over 100 ms in 26 min; warzone phase 10.2 ms/frame average |
| 4 | Client CPU frame time creeps up over a long session, outside the measured phases | client perf | i5: CPU frame 19 ms to 33 ms over 80 idle minutes; next match 22 to 30 fps with under 30 units on screen |
| 5 | Spectator snapshots are not delta-encoded | network / server perf | 100 KB per snapshot, 550 KB/s raw JSON (4v4); 35 KB per snapshot with only 50 units; snapshot work is 21 to 61 % of worker time in observed matches |
| 6 | AI-vs-AI stalemate after minute 10 | gameplay pacing | 4v4: 42 captures in the first 10 sim-min, then 4, 2, 5 per 10 min; 18 % of operations captured anything |
| 7 | Observer speed is not checked for sustainability, and the UI shows 8x | UX | players see "8x" while the match runs at 1.1 to 2.4x |
| 8 | Normal AI overruns a new human in 8 to 14 minutes | gameplay pacing | 2 of 2 human-vs-normal matches lost; small sample |

Details follow.

---

### B1. Simulation throughput in large AI matches

**[data] Server tick, per match** (Q1):

| Match | Peak units | Tick mean | Tick p95 (median minute) | Tick p99 (median / worst minute) | Tick max | Pace (sim s per wall s) | Intervals > 100 ms | CPU ms per sim second |
|---|---|---|---|---|---|---|---|---|
| 59f3a8 | 562 | 32.4 ms | 135 ms | 379 / 927 ms | 1,590 ms | 2.42 (speed 8) | 32.4 % | 323 |
| 05a938 | 151 | 4.4 ms | 10.9 ms | 38 / 51 ms | 112 ms | 7.97 at 8x for the first 3 min | 0 % | 44 |
| 62fbe2 / 94950a / ff70a9 / 0ed268 | 35 to 121 | 1.0 to 1.5 ms | 1.7 to 3.0 ms | 4 to 7 / ≤ 64 ms | ≤ 64 ms | 1.0 | 0 % | 10 to 15 |

**[data] Tick cost against game minute and unit count, 59f3a8** (selected minutes of `server_match_minute`):

| Wall min | Sim time | Units | Speed | Pace | Tick avg | p95 | p99 | Max | Routes | Route ms | Route fails | AI ms | Worker ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 7.9 min | 362 | 8 | 7.83 | 4.4 | 11 | 24 | 113 | 2,301 | 2,080 | 7 | 5,033 | 0.39 |
| 2 | 14.6 min | 450 | 1 | 1.00 | 22.2 | 54 | 72 | 131 | 1,229 | 3,003 | 2 | 2,870 | 0.28 |
| 5 | 21.1 min | 507 | 8 | 4.31 | 19.5 | 64 | 134 | 362 | 10,089 | 19,003 | 5,134 | 13,898 | 0.89 |
| 8 | 28.0 min | 500 | 8 | 1.13 | 83.8 | 290 | 927 | 1,107 | 2,903 | 44,117 | 498 | 15,883 | 0.98 |
| 13 | 37.3 min | 515 | 8 | 1.75 | 53.1 | 210 | 443 | 853 | 4,744 | 37,556 | 487 | 19,796 | 0.96 |
| 19 | 49.5 min | 477 | 8 | 2.21 | 40.9 | 117 | 701 | 1,590 | 6,511 | 32,213 | 1,667 | 26,641 | 0.94 |
| 22 | 56.0 min | 420 | 8 | 2.42 | 36.1 | 123 | 279 | 489 | 3,920 | 24,465 | 78 | 8,713 | 0.92 |

* At 1x the 4v4 holds its budget (tick avg 18 to 22 ms, p99 60 to 72 ms with 410 to 450 units). Cost per simulated
  second rises from about 45 ms (early, ~360 units) to **470 to 840 ms** from sim minute 25 on, so the late 4v4 can
  sustain only about 1.2x to 2x no matter what speed is asked. The worker's event-loop utilisation sits at 0.92 to 0.98.
* Missed loop intervals also starve the snapshot cadence: 162 to 230 snapshot rounds a minute instead of 300 (the
  spectator client received 3.2 snapshots/s, interpolation delay median 315 ms, max 706 ms).

**[data] Where the time goes, 59f3a8** (Q2; share of all scheduler system time, 1,086 s in total):

| System | Share | Avg per run | p99 worst minute | Max | Runs over budget |
|---|---|---|---|---|---|
| navigation (`unitMotion`) | 41.6 % | 13.5 ms | 394 ms | 634 ms | 3,347 |
| ai (`runAI` → `planActionAI`) | 34.8 % | 33.8 ms | 1,491 ms | 1,567 ms | 2,572 (647 deferred) |
| combat | 11.4 % | 3.7 ms | 59 ms | 243 ms | 362 |
| visibility | 4.9 % | 6.4 ms | 13 ms | 51 ms | 485 |
| field economy | 3.8 % | 2.4 ms | 14 ms | 37 ms | 2,352 |
| production | 3.2 % | 3.1 ms | 205 ms | 358 ms | 1,277 |
| everything else | < 0.5 % | | | | |

Snapshot building was 3.9 % of worker time, GC 1.0 s per wall minute (895 scavenges a minute, longest 34 ms),
autosave serialisation at most 42 ms. None of these is a bottleneck.

**[data] Routing.** `nav.route` time (which is spent inside navigation, combat, AI and orders) was **55 % of all
tick time** in 59f3a8: 114,572 routes, 5.26 ms per route on average, per-minute route p95 up to 96 ms, slowest route
278 ms, 17.1 % failed (19,573), 33,723 coarse re-plans (`routeRetry`). In minutes 5 and 6 there were 5,134 and 2,078
failures, of which 2,360 and 1,937 were region cut-offs (`cutoff`); from then on almost all failures are `other`
(450 to 1,670 a minute). Stuck-ladder give-ups: 84 in the match (0 in every other match). Group-route queue: max 3,
end 0 or 1, so the group queue is not a bottleneck. In every other match route time was 5 to 11 % of tick time,
0.4 to 0.7 ms per route, failure rate ≤ 0.7 %.

**[data] AI spikes in the Cloud Run log.** 179 `WARNING` lines, all of them the worker's own slow-tick warning for
59f3a8, e.g. "avg tick 106 ms (max 343 ms); slowest: ai p95 280 ms, navigation p95 136 ms" and, late in the match,
"ai p95 632 ms, navigation p95 15 ms". No errors, no crashes.

**[inference] Why.**
* Route failures and retries are the expensive part of routing. `ActionNav.route()` memoises failures for 30 ticks
  (`FAIL_MEMO_TICKS`, `server/sim/actionNavigation.js:185`), but `invalidate()` (`actionNavigation.js:289`) clears
  the failed-route memo, the corridors and the flow fields on **every** building change. The 4v4 had 799 buildings
  built and 517 lost (plus trenches, craters and bridges, which invalidate from `actionBases.js`, `actionCombat.js:279`
  and `:328`, `actionEngineers.js`, `actionMap.js`, `battlefield.js:153`), so these caches are wiped every few
  simulated seconds in the late game, and every chase re-route, ladder replan and AI order pays a full budgeted
  search again (coarse search up to `N >> 1` nodes plus up to 3 fine attempts of `ROUTE_LOCAL_BUDGET = 3200` nodes).
* The combat system calls `nav.route` directly for chase and reposition (`actionCombat.js:442`, `:516`, `:570`) with
  no per-tick cap, so a big battle generates a burst of synchronous routes in one tick.
* `planActionAI` (`server/sim/actionAI.js:424`) does several full scans per call: all units (`owned`, `enemy` with a
  `game.sees` check each), then sorts candidate sites with a comparator that filters `enemy` and `defences` inside the
  sort (`rank`/`garrisonAt`, `actionAI.js:531`), then `aiWorks` (`actionAIWorks.js:428`) loops sites ×
  enemy units (`recordAttacks`), all buildings and all fieldworks every call. With ~500 units and ~500 buildings this
  is O(sites × units) per plan, and AI planning runs as one indivisible task, which is how a single call reaches
  0.6 to 1.5 s.

**Recommended fixes (in order of payoff).**
1. **Scope `nav.invalidate()`** (`actionNavigation.js:289`): a building placed or removed should drop only the failed
   memo entries and corridors whose coarse tiles touch the changed hexes (keep a tile → corridor index), not every
   cache. At minimum keep the failed-route memo across building-only invalidations whose footprint is not on the
   failed corridor. Expected: most of the 450 to 1,670 failed routes a minute become memo hits.
2. **Budget routes per tick**: give `route()` a per-tick node/ms allowance shared by combat chases and ladder replans;
   when it is spent, queue the request (as `groupJobs` already does for group orders, `actionOrders.js:243`) and let
   the unit keep its current path for a tick or two. Chases in `actionCombat.js` should prefer a straight `line()`
   check and a short local search before a full route.
3. **Slice the AI**: split `planActionAI` into stages (perception, works, operations, army, orders) that each run
   inside the scheduler's budget and resume next tick; cache per-call scans once per tick for all AIs (enemy lists per
   team, unit buckets per coarse tile) instead of per civ; move the `filter` calls out of the `rank` comparator (compute
   the key once per site).
4. Longer term, the worker uses one of the instance's 4 vCPUs; AI planning for different civs is independent of the
   tick and could run in a second worker thread on a snapshot (results applied as commands at a tick boundary to keep
   determinism).

---

### B2. AI planner starvation (the 8th AI never plays)

**[data]** Q3 joined `match_results` with `ai_decisions`:

| 59f3a8 seat | Difficulty / personality | AI decisions | First decision | Units produced | Buildings built |
|---|---|---|---|---|---|
| 0 | brutal builder | 290 | 3.0 s | 788 | 187 |
| 1 | brutal merchant | 96 | 3.3 s | 221 | 41 |
| 2 | brutal builder | 235 | 3.6 s | 478 | 120 |
| 3 | brutal warlord | 49 | 3.9 s | 80 | 16 |
| 4 | brutal merchant | 302 | 4.2 s | 637 | 201 |
| 5 | brutal builder | 271 | 4.5 s | 770 | 198 |
| 6 | brutal merchant | 81 | 4.8 s | 354 | 36 |
| **7** | **brutal merchant** | **0** | **never** | **0** | **0** |

Seat 7 stayed in state `Opening` with 5,921 materials and 2,079 energy unspent, lost its town at 394.8 s to seat 0's
28-unit force (it had 2 rifle squads, a buggy and 2 engineers) and was eliminated at 401.8 s.

**[inference, confirmed in code]** `runAI()` (`server/sim/actionGame.js:525`) plans for
`this.civs.find((c) => c.alive && c.aiPlan?.next <= this.time)`, the first due civ **by index**, once per AI task run.
The task runs every 3 ticks (`actionGame.js:519`), i.e. 3.33 plans per simulated second, fewer when the adaptive
scheduler defers it (647 deferrals). Brutal and expert AIs re-plan every 2 s (`actionAI.js:426`), so 8 of them need
4 plans per second. The first decisions above are exactly 0.3 s apart; by the time seat 7's slot would come (5.1 s),
seat 0 is due again (5.0 s), and the lowest index always wins, so seat 7 is never served. The same arithmetic means
any game with more than 6 expert/brutal AIs (or more than 10 normal) starves its last seats, and the lower seats get
proportionally more plans than the higher ones even when nobody starves outright.

**Fix:** in `runAI()` pick the due civ with the **smallest `aiPlan.next`** (oldest request first), or keep a
round-robin cursor; and either run the AI task every tick when more civs are due than slots, or stretch `p.next` by
the number of AIs so the total demand fits the slots. Add a test with 8 brutal AIs that asserts every seat records an
objective within the first 30 s.

---

### B3. Client hitches from `WarzoneRenderer` full rebuilds

**[data]** Client minutes (Q4), i5-8600K / RX 7600 XT, spectating:

| Match | FPS | Frame p50 / p95 (median minute) | Frame p99 (median minute) | Worst frame | Frames > 33 ms / > 100 ms | Main thread | CPU frame | GPU frame | Warzone phase avg / max |
|---|---|---|---|---|---|---|---|---|---|
| 59f3a8 (≈500 units) | 34.7 | 20.8 / 27.8 ms | 1,035 ms | 4,993 ms | 2,305 / 937 | 20.1 ms | 30.8 ms | 17.2 ms | **10.2 ms / 4,973 ms** |
| 05a938 (≈130 units) | 47.7 | 20.8 / 34.8 ms | 42 ms | 847 ms | 28,334 / 834 | 5.2 ms | 20.9 ms | 12.5 ms | 1.0 ms / 832 ms |

The worst frames line up with the warzone phase maximum minute by minute (e.g. 23:00 UTC: frame max 4,993 ms, warzone
max 4,973 ms). Other phases (units 3.5 ms, fx 2.8 ms, city 2.0 ms, draw 1.1 ms average) are not the hitch source. The
7950X / RTX 4070 client never showed the issue in its (smaller, mostly close-zoom) matches: p99 17 ms, 0 to 1 frames
over 100 ms per match.

**[inference]** `WarzoneRenderer.Update` (`unity/Assets/ShatteredEmpires/Runtime/Battlefields/WarzoneRenderer.cs:176`)
returns early only if the trench, battlefield, structure and road revisions are all unchanged; any change clears every
batch and rebuilds **all** trenches (`Works.Build`), all no-man's-land patches and every wreck with its scorch and five
debris pieces, on the main thread, in one frame. In a 4v4 the battlefield revision changes several times a second and
the wreck count is in the hundreds (559 engineers alone were lost in battles), so each rebuild grows with the match.

**Fix:** rebuild incrementally: key wrecks, scorch and no-man's-land by tile/wreck id and add or remove only the
changed ones (the server already sends keyed battlefield deltas, `econ-delta-v1`); rebuild trenches only on a trench
or road revision change, not a battlefield one; cap rebuild work per frame (time-sliced over several frames) and
coalesce revisions (at most one rebuild per 0.5 s). Report `warzone.Rebuilds` and `PartMs` (already kept for the bench,
`GameBootstrap.Bench.cs:226`) in `client_minute`.

---

### B4. Client CPU frame time creeps up over a session, outside the measured phases

**[data]** The i5 client ran one session from 22:30 to past 01:10 UTC (no new `client_session` row). Every fifth
minute:

| UTC | State | FPS | Main thread | CPU frame | GPU frame | Unity allocated | Units known / drawn |
|---|---|---|---|---|---|---|---|
| 23:35 | 05a938 over, scene static | 52 | 2.7 ms | 19.2 ms | 10.5 ms | 402 MB | 119 / 119 |
| 00:00 | same | 43 | 2.7 ms | 23.3 ms | 18.7 ms | 423 MB | 119 / 119 |
| 00:30 | same | 36 | 2.7 ms | 27.6 ms | 13.8 ms | 443 MB | 119 / 119 |
| 00:55 | same | 30 | 2.8 ms | 33.1 ms | 18.8 ms | 457 MB | 119 / 119 |
| 01:05 | new PvP match 0ed268 | 23 | 3.4 ms | 44.0 ms | 9.9 ms | 353 MB | 50 / 19 |

With a static scene and no network traffic, CPU frame time rose about 0.17 ms per minute and Unity's allocated memory
about 0.7 MB per minute, while the instrumented main-thread phases stayed at 2.7 ms and GC collections were ~0. In the
next match the i5 ran at 22 to 30 fps (frame p50 35 to 42 ms, 1,150 to 1,340 frames over 33 ms a minute) with fewer
than 30 units on screen and a 6 to 10 ms GPU frame; the 7950X client in the same match held 60 fps.

**[inference]** 30 to 40 ms of CPU frame time is spent outside `GameBootstrap.Update`'s phase markers
(`GameBootstrap.cs:833`/`:947`; `main_ms` covers only that method, `GameBootstrap.cs:798`), and it grows with session
age, not with what is on screen. Candidates: per-frame work over something that accumulates across matches (HUD/UI
elements, notes or logs, audio sources, GameObjects or meshes from the previous match not destroyed when it ends), or
render-thread submission of objects that keep accumulating. In 59f3a8 the same client was also CPU-bound in-match
(CPU 31 to 49 ms vs GPU 17 to 20 ms, process CPU ~300 %).

**Fix:** run the existing soak harness (`SoakSample`, `GameBootstrap.cs:800`) for 2 to 3 hours across two matches and a
post-match screen with the Unity profiler attached; diff object counts (GameObjects, renderers, meshes, materials, UI
elements) at the start and end; make match teardown destroy everything the match created. Add telemetry for the gap
(`cpu_frame_ms - main_ms`), render-thread ms, draw calls / batches, and live GameObject count.

---

### B5. Spectator snapshots are not delta-encoded

**[data]** (Q1)

| Match | Viewer | Units | Raw JSON out | Per snapshot message | Snapshot share of worker time |
|---|---|---|---|---|---|
| 59f3a8 | 1 spectator | ~500 | 550 KB/s | 100 KB | 3.9 % |
| 05a938 | 1 spectator | ~130 | 287 KB/s | 50 KB | 21.4 % |
| ff70a9 | 1 spectator | 32 to 70 | 161 KB/s | 35 KB | 60.8 % |
| 94950a | 1 player | 14 to 72 | 10 KB/s | 1.5 KB | 25.8 % |
| 0ed268 | 2 players | 29 to 119 | 26 KB/s | 1.7 KB | 38.2 % |

The spectating client received 488 KB/s (59f3a8), 138 KB/s (05a938) and 146 KB/s (ff70a9); a player 4 to 13 KB/s.
RTT stayed at 25 to 50 ms.

**[inference, confirmed in code]** The per-viewer delta encoder (`server/delta.js`, capability `udelta`, keyed econ
deltas) is created only for players (`server/worker.js:188`). The spectator (`-2`) is welcomed at `worker.js:196`
without one, so `sendSnap(-2, …)` (`worker.js:40`) sends every 200 ms snapshot whole: all units with every field (god
view), up to 16 path points per unit (`game.js:869`), and whole sites/buildings/battlefield every econ round. The god
view also scans all N tiles and base64-packs the full visibility bitmap every round (`game.js:880` to `:894`), a fixed
cost that dominates small observed matches. The bytes are deflated on the WebSocket (`server/index.js:87`,
`perMessageDeflate`), so the wire cost is lower, but the server still builds and compresses them and the client still
parses them.

**Fix:** register a delta encoder for `-2` on `obsWelcome` when the spectator's caps include `udelta`; skip the tile
loop and visibility packing for the god view (nothing changes visibility; tiles can use a changed-tile list kept by
`w.ver` updates); send paths only for selected or followed units. Log compressed wire bytes.

---

### B6. AI-vs-AI stalemate after the opening

**[data]** Captures, buildings and nukes per 10 simulated minutes (Q5):

| Match | Sim min | Captures | Buildings built | Buildings lost | Nukes |
|---|---|---|---|---|---|
| 59f3a8 | 0 to 10 | 42 | 142 | 4 | 0 |
| | 10 to 20 | **4** | 159 | 38 | 0 |
| | 20 to 30 | **2** | 151 | 51 | 3 |
| | 30 to 40 | **5** | 81 | 99 | 6 |
| | 40 to 50 | 9 | 152 | 166 | 4 |
| | 50 to 56 | 10 | 114 | 159 | 1 |
| 05a938 | 0 to 10 | 23 | 48 | 2 | 0 |
| | 10 to 50 | 10 to 15 per 10 min | 56 to 100 | 32 to 112 | 0 |

* Battles kept happening (59f3a8: 111, 88, 96, 73 per 10 sim-min; median 49 units, longest engagement 804 s), but they
  stopped changing ownership. AI objective state was "Final Assault" in 109 of 140 live AI-minutes (78 %) in 59f3a8.
* Operations (Q6): 59f3a8 49 ended: 9 captured (18 %), 28 withdrew, 9 recalled to defend, 3 escalated; 05a938 41 ended:
  12 captured (29 %), 20 recalled to defend. Top AI notes: "Flank force merged into the main thrust" (55),
  "Regrouping after a stalled approach" (43), "Operation ended after bounded recovery" (29), "Withdrawing to repair"
  (23), and 19 "Stalemate …: strategic strike programme" notes, followed by 14 nuke launches.
* The AIs fortified heavily: 553 defence placements (barricade 286, bunker 208, turret 162, guard post 67) and 229
  trench lines across the two observed matches; barricades were the most-built building of all (358).
* Stockpiles: late in 59f3a8 several AIs sat on 10,000 to 16,900 materials while energy stayed at 150 to 500 (seat 4
  ended with 16,912 materials, seat 0 peaked at 15,583). Army size plateaued at ~80 to 110 units per AI (total ~500).
* Unit mix fielded in battles: rifle squads 11,403 unit-battles, armoured cars 5,489, field guns 5,414, anti-armour
  2,014, tanks 1,442. Damage by weapon: AT gun 41.6 %, cannon 13.3 %, rifle 10.4 %, MG 9.8 %, warheads 6.4 %. No unit
  type stands out in win rate (side-won 0.45 to 0.51 for every type with > 100 appearances).

**[inference]** The stalemate is a combination of cheap static defence (barricades, bunkers, trench lines and field
guns that dominate damage) against operations that give up early (withdraw / recall) and economies that are
energy-bound, so surplus materials are not converted into decisive force. The B2 bug also skewed the 4v4 (team 0
lost a whole seat early).

**Recommendations:** in `actionAIWorks.js` `budget()` (around line 150), taper the works share once a base has N
defences or after minute 20, and stop spending on barricades around bases not attacked in the last 5 min; let the AI
convert banked materials (> 3,000 with energy low) into energy plants or material-only units; in `actionAIOps.js`
require a force-ratio re-check before `withdrew`/`recalled_to_defend` and escalate (artillery, sappers) against
trench lines instead of withdrawing; consider a stronger catch-up or attrition mechanic after 30 minutes of an
unchanged front (the strategic programme exists but arrives at ~24 min and launches only ~1 nuke per 3 min).

---

### B7. Observer speed is accepted without a sustainability check

**[data]** 59f3a8 reported `game_speed = 8` for 20 minutes while delivering 1.1 to 2.4x; 05a938 delivered 7.97x for
3 minutes at ~100 units, after which the viewer switched to 1x.

**[inference, confirmed in code]** Player speed changes go through `sustainable()` (`server/sim/speedVote.js:27`),
but the spectator's `speed` command (`server/worker.js:218`) sets `game.speed` directly, and the tick loop silently
caps work at 70 ms per interval (`worker.js:97`). **Fix:** apply `sustainable()` to the observer path, send the
effective pace (sim seconds per wall second over the last 10 s) in snapshots and show it beside the requested speed.

### B8. Normal AI overruns a new human quickly

**[data]** 62fbe2: the human issued 99 commands in the first 4 minutes and none after; trained 0 units and was
eliminated at 8.4 sim-min (AI: 21 units). 94950a: the human trained 23 units and kept 600 to 2,000 materials banked
while the normal builder AI went from 13 to 53 units, attacked from 7 min and eliminated the human at 13.7 min.

**[inference]** One of the two humans was inactive, so the sample says little about balance. Still, a normal AI that
attacks at minute 6 to 7 with 3 to 5 times the human's army is fast for a newcomer. Worth watching as more human games
arrive; consider a later first attack (or a smaller one) for `normal`.

---

## 3. Server instance

**[data]** (Q7) Cloud Run: 4 vCPU, 4 GiB, `maxScale=1`, CPU always allocated, session affinity. Peak busy cores 1.12
(one match worker saturated); RSS ≤ 279 MB; main-thread event loop utilisation ≤ 0.02 and lag p99 21 ms; at most 2
matches running, 2 players and 1 spectator; telemetry dropped and rejected 0 rows. The 4v4's worker was at ELU 0.92 to
0.98 while the instance as a whole used about 28 % of its 4 vCPUs.

**[inference]** Capacity is bounded by the single-threaded worker per match, not by the instance: with `maxScale=1`,
about 3 matches of 59f3a8's weight fit before admission control (`load_cores`) should refuse more.

## 4. Anomalies

* **[data]** Seat 7 inert (B2).
* **[data]** No server errors, no client exceptions (`client_errors` has 0 prod rows), no telemetry drops.
* **[data]** 62fbe2: the human disconnected at sim 490 s, the match parked as `idle` after 18 wall minutes, was
  restored 2 minutes later and ended 11 s after (human eliminated).
* **[data]** The i5 client kept reporting `in_match = true` for 30 minutes after 05a938 ended and then for 52 minutes
  with no match id (see telemetry gaps).
* **[data]** Stuck units: stuck-ladder give-ups 84 in 59f3a8 (up to 10 a minute), 0 elsewhere; `pushPast` and
  `wreckPass` dominate the ladder steps (hundreds a minute in the 4v4).
* Desyncs/resyncs and congestion skips are not logged, so they cannot be assessed.

## 5. Telemetry gaps and bugs

Bugs in what is logged:
1. `client_minute.in_match` is hard-coded `true` (`ClientTelemetry.cs`, `["in_match"] = true`): post-match and menu
   minutes are counted as match minutes.
2. `client_minute.process_mem_mb` and `client_session.process_mem_mb` are always 0 (`Process.WorkingSet64` returns 0
   in the player build); `gc_alloc_kb_per_frame` is always 0 (the GC-allocation recorder is only valid in development
   builds).
3. `server_instance_minute.cpu_cores` reports 9 (host CPUs) on a 4-vCPU service, so `cpu_util` understates load by
   ~2.25x; use the cgroup quota.
4. `server_match_minute.idle_s` is `wall - (intervals + paused)/10`, so loop overruns show up as "idle" (20 to 31 s a
   minute in 59f3a8 while a spectator was connected). Split it into `idle_s` (nobody connected) and `overrun_s`.
5. The worker's stats warning prints "avg tick Infinityms" at match end (`server/matches.js:353`; `n = 0` in the last
   interval).
6. `client_minute.spectator` was `false` in the observed match ff70a9.
7. `battles.sides[].units` omits engineers (559 engineers lost, 0 fielded).
8. `player_minute` is written once per wall minute, so at 8x it samples every 2 to 8 sim minutes; the docs call it
   per match-minute.

Missing measurements:
1. Route failures by actual reason (`lastFail`: memo, goal, cut, coarse, fine) and by caller (unit order, combat
   chase, ladder replan, AI); `nav.invalidate()` count and cause; failed-memo and corridor-cache hit rates.
2. AI planning sub-phase timings (perception, works, operations, army, orders) and plans per civ per minute (would
   have exposed B2 at once).
3. Compressed WebSocket bytes, per-viewer bytes (spectator vs player), resync / catch-up / congestion-skip counts.
4. Client: snapshot receive-to-apply time and JSON parse time, warzone rebuild count and ms, render-thread ms, draw
   calls, GameObject count, and the `cpu_frame_ms - main_ms` gap.
5. Effective vs requested speed shown to the player.

## 6. SQL used

All queries ran against `stem-471602.se_telemetry`. Rows were also exported per table with
`SELECT * EXCEPT(install_id) FROM se_telemetry.<table> WHERE env = 'prod' AND IFNULL(server_version, '') != 'smoke-2026-11-18'`
and aggregated locally for the per-minute tables above.

```sql
-- Q1 server tick, pace, routing and bandwidth per match
SELECT match_id, COUNT(*) AS minutes, MAX(units_max) AS units_peak,
  ROUND(SUM(ticks * tick_ms_avg) / SUM(ticks), 1) AS tick_ms_mean,
  ROUND(APPROX_QUANTILES(tick_ms_p95, 100)[OFFSET(50)], 1) AS tick_p95_median,
  ROUND(APPROX_QUANTILES(tick_ms_p99, 100)[OFFSET(50)], 0) AS tick_p99_median,
  ROUND(MAX(tick_ms_p99), 0) AS tick_p99_worst, ROUND(MAX(tick_ms_max), 0) AS tick_max,
  ROUND(SUM(sim_advanced_s) / SUM(wall_s), 2) AS pace, MAX(game_speed) AS speed_max,
  ROUND(100 * SUM(intervals_over_100ms) / SUM(intervals), 1) AS pct_intervals_over_100ms,
  ROUND(SUM(ticks * tick_ms_avg) / SUM(sim_advanced_s), 0) AS cpu_ms_per_sim_s,
  ROUND(100 * SUM(route_ms_total) / SUM(ticks * tick_ms_avg), 0) AS route_pct_of_tick,
  SUM(routes) AS routes, ROUND(100 * SUM(route_failures) / SUM(routes), 1) AS route_fail_pct, SUM(route_retries) AS route_retries,
  ROUND(SUM(route_ms_total) / SUM(routes), 2) AS ms_per_route, ROUND(MAX(route_ms_max), 0) AS route_worst_ms,
  ROUND(100 * SUM(snapshot_ms_total) / (SUM(ticks * tick_ms_avg) + SUM(snapshot_ms_total)), 1) AS snapshot_pct,
  ROUND(SUM(bytes_out) / SUM(wall_s) / 1024, 0) AS kb_per_s, ROUND(SUM(bytes_out) / SUM(msgs_out) / 1024, 1) AS kb_per_msg,
  ROUND(AVG(loop_utilization), 2) AS worker_elu, ROUND(MAX(heap_used_mb), 0) AS heap_mb_max
FROM `stem-471602.se_telemetry.server_match_minute`
WHERE env = 'prod' AND server_version != 'smoke-2026-11-18' AND DATE(event_time) BETWEEN '2026-11-19' AND '2026-11-20'
GROUP BY match_id ORDER BY MIN(event_time);

-- Q2 share of scheduler time by system, per match
SELECT match_id, name, total_s, ROUND(100 * total_s / SUM(total_s) OVER (PARTITION BY match_id), 1) AS pct,
  avg_ms, p99_worst, max_ms, over_budget, deferred
FROM (
  SELECT match_id, s.name, SUM(s.total_ms) / 1000 AS total_s, ROUND(SUM(s.total_ms) / SUM(s.calls), 2) AS avg_ms,
    ROUND(MAX(s.p99_ms), 1) AS p99_worst, ROUND(MAX(s.max_ms), 0) AS max_ms, SUM(s.over_budget) AS over_budget, SUM(s.deferred) AS deferred
  FROM `stem-471602.se_telemetry.server_match_minute`, UNNEST(systems) s
  WHERE env = 'prod' AND server_version != 'smoke-2026-11-18' AND DATE(event_time) BETWEEN '2026-11-19' AND '2026-11-20'
  GROUP BY match_id, s.name)
ORDER BY match_id, pct DESC;

-- Q3 AI planning per seat (starvation check)
SELECT r.match_id, r.seat, r.ai_difficulty, r.ai_personality, r.result, r.units_produced, r.buildings_built,
  COUNT(d.kind) AS ai_decisions, MIN(d.sim_time_s) AS first_decision_s
FROM `stem-471602.se_telemetry.match_results` r
LEFT JOIN `stem-471602.se_telemetry.ai_decisions` d ON d.match_id = r.match_id AND d.seat = r.seat AND d.env = 'prod'
WHERE r.env = 'prod' AND NOT r.human AND DATE(r.event_time) BETWEEN '2026-11-19' AND '2026-11-20'
GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2;

-- Q4 client frame pacing per match and hardware
SELECT IFNULL(m.match_id, '(none)') AS match_id, s.cpu_model, s.gpu_model, s.refresh_hz, COUNT(*) AS minutes,
  ROUND(SUM(m.frames) / SUM(m.wall_s), 1) AS fps,
  APPROX_QUANTILES(m.frame_ms_p50, 100)[OFFSET(50)] AS p50_median, APPROX_QUANTILES(m.frame_ms_p95, 100)[OFFSET(50)] AS p95_median,
  ROUND(APPROX_QUANTILES(m.frame_ms_p99, 100)[OFFSET(50)], 0) AS p99_median, ROUND(MAX(m.frame_ms_max), 0) AS worst_frame_ms,
  SUM(m.frames_over_33ms) AS over_33, SUM(m.frames_over_100ms) AS over_100,
  ROUND(AVG(m.main_ms_avg), 1) AS main_ms, ROUND(AVG(m.cpu_frame_ms_avg), 1) AS cpu_ms, ROUND(AVG(m.gpu_frame_ms_avg), 1) AS gpu_ms,
  ROUND(MAX(m.mono_heap_mb), 0) AS mono_mb_max, ROUND(SUM(m.net_bytes_in) / SUM(m.wall_s) / 1024, 0) AS net_kb_s,
  ROUND(SUM(m.snapshots) / SUM(m.wall_s), 1) AS snaps_per_s, ROUND(APPROX_QUANTILES(m.interp_delay_ms, 100)[OFFSET(50)], 0) AS interp_ms,
  ROUND(AVG((SELECT p.avg_ms FROM UNNEST(m.phases) p WHERE p.name = 'warzone')), 2) AS warzone_ms_avg,
  ROUND(MAX((SELECT p.max_ms FROM UNNEST(m.phases) p WHERE p.name = 'warzone')), 0) AS warzone_ms_max
FROM `stem-471602.se_telemetry.client_minute` m
LEFT JOIN (SELECT install_id, ANY_VALUE(cpu_model) AS cpu_model, ANY_VALUE(gpu_model) AS gpu_model, ANY_VALUE(refresh_hz) AS refresh_hz
           FROM `stem-471602.se_telemetry.client_session` WHERE env = 'prod' GROUP BY install_id) s USING (install_id)
WHERE m.env = 'prod' AND DATE(m.event_time) BETWEEN '2026-11-19' AND '2026-11-20'
GROUP BY 1, 2, 3, 4 ORDER BY MIN(m.event_time);

-- Q4b client drift over one session (every fifth minute, 144 Hz client)
SELECT FORMAT_TIMESTAMP('%H:%M', m.event_time) AS t, IFNULL(m.match_id, '-') AS match_id, ROUND(m.fps_avg, 0) AS fps,
  ROUND(m.main_ms_avg, 1) AS main_ms, ROUND(m.cpu_frame_ms_avg, 1) AS cpu_ms, ROUND(m.gpu_frame_ms_avg, 1) AS gpu_ms,
  ROUND(m.total_alloc_mb, 0) AS unity_mb, m.gc_collections, m.units_known, m.visible_units
FROM `stem-471602.se_telemetry.client_minute` m
JOIN (SELECT install_id, ANY_VALUE(refresh_hz) AS hz FROM `stem-471602.se_telemetry.client_session` GROUP BY install_id) s USING (install_id)
WHERE m.env = 'prod' AND s.hz = 144 AND MOD(EXTRACT(MINUTE FROM m.event_time), 5) = 0
ORDER BY m.event_time;

-- Q5 game pace: captures, buildings and nukes per 10 match-minutes
SELECT match_id, CAST(FLOOR(sim_time_s / 600) * 10 AS INT64) AS sim_min,
  COUNTIF(event = 'capture') AS captures, COUNTIF(event = 'building_built') AS built, COUNTIF(event = 'building_lost') AS lost,
  COUNTIF(event = 'nuke_launched') AS nukes
FROM `stem-471602.se_telemetry.gameplay_events`
WHERE env = 'prod' AND server_version != 'smoke-2026-11-18' AND DATE(event_time) BETWEEN '2026-11-19' AND '2026-11-20'
  AND match_id IN ('59f3a8', '05a938')
GROUP BY 1, 2 ORDER BY 1, 2;

-- Q6 AI operation outcomes
SELECT match_id, outcome, COUNT(*) AS operations, ROUND(AVG(value), 0) AS avg_value
FROM `stem-471602.se_telemetry.ai_decisions`
WHERE env = 'prod' AND kind = 'operation_end' AND DATE(event_time) BETWEEN '2026-11-19' AND '2026-11-20'
GROUP BY 1, 2 ORDER BY 1, operations DESC;

-- Q7 instance CPU, memory and concurrency
SELECT MAX(cpu_cores) AS cpu_cores_seen, ROUND(MAX(cpu_util), 2) AS cpu_util_max,
  ROUND(MAX(cpu_util * cpu_cores), 2) AS busy_cores_max, ROUND(MAX(load_cores), 2) AS load_cores_max,
  ROUND(MAX(rss_mb), 0) AS rss_mb_max, MAX(matches_running) AS running_max, MAX(players) AS players_max,
  MAX(spectators) AS spectators_max, SUM(rows_dropped) AS rows_dropped, SUM(rows_rejected) AS rows_rejected
FROM `stem-471602.se_telemetry.server_instance_minute`
WHERE env = 'prod' AND DATE(event_time) BETWEEN '2026-11-19' AND '2026-11-20';

-- Q8 battles, unit types and weapons (aggregated locally from these rows)
SELECT match_id, start_s, duration_s, damage, outcome, winner_seat, sides
FROM `stem-471602.se_telemetry.battles`
WHERE env = 'prod' AND DATE(event_time) BETWEEN '2026-11-19' AND '2026-11-20';
```

Cloud Run log read (read-only): `resource.type=cloud_run_revision AND resource.labels.service_name=shattered-empires AND
timestamp>="2026-11-19T22:00:00Z" AND severity>=WARNING` (179 entries, all slow-tick warnings and two favicon 404s).
