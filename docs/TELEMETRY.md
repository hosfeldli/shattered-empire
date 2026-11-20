# Telemetry (BigQuery diagnostics and benchmarking)

Performance, pacing, gameplay, AI and client diagnostics land in the BigQuery dataset `stem-471602.se_telemetry`
(US), one table per kind of row, every row tagged with the server and client versions so any query can be cut by
release. Added 2026-11-18.

## Architecture

```
Unity client ──(existing WebSocket, {t:'telemetry'})──▶ main thread (server/matches.js → server/telemetry/index.js)
                                                          ▲  validate, rate-limit, add common columns
match worker (server/worker.js + telemetry/probe.js) ─────┘  {t:'tm', rows} once per wall minute
                                                          │
                                                          ▼  bounded buffer (6000 rows, oldest dropped)
                                         every 45 s: tabledata.insertAll (REST, metadata-server token)
```

* **Off unless configured.** `TELEMETRY_DATASET` unset (local dev, tests, the desktop edition) makes
  `createTelemetry()` return a no-op; workers get `telemetry: null` and never load the probe. `TELEMETRY_DISABLED=1`
  also turns it off. Production gets `TELEMETRY_DATASET=se_telemetry` from `tools/release.ps1` (`--update-env-vars`).
* **The client never holds credentials.** It sends rows over its game connection, only after the server's hello reply
  says `telemetry: true`, and only while *Settings > Interface > Share diagnostics* is on.
* **The server** authenticates as its runtime service account (`se-runtime`) with a token from the Cloud Run
  metadata server. No SDK: `fetch` + `tabledata.insertAll` (`server/telemetry/bigquery.js`). For local smoke tests a
  short-lived `TELEMETRY_ACCESS_TOKEN` can be supplied instead.
* **It never slows a match.** The probe runs in the match's worker on its own 1 s timer, reads state, keeps
  per-minute aggregates and posts one small message a minute. The tick loop only adds a few `performance.now()`
  calls. Flushes are async; a failure backs off exponentially (45 s → 10 min), rows of a failed request are retried
  once and then dropped, and a server error stops that flush so BigQuery is never hammered.
* **Determinism.** The probe never writes game state and never touches `game.rng`. Its only footprints are
  `game.tm` (the AI hook sink, not serialized) and a timing wrapper around the `game.nav.route` instance method.
  `test/telemetry-2026-11-18.test.js` runs two identical AI matches, one probed, and asserts equal `stateHash`.
* **AI hooks** are one line each, all `game.tm?.…` (no-ops when the probe is absent): `note()` and `objective()` in
  `server/sim/actionAI.js`, `note()` in `actionAIOps.js` (raids, missiles, strikes) and `place()` / `dig()` in
  `actionAIWorks.js`. Operation starts and task-force launches are read from `civ.aiPlan.op` by polling.

### Settings

| Env var | Meaning |
|---|---|
| `TELEMETRY_DATASET` | dataset id; unset = telemetry off |
| `TELEMETRY_DISABLED=1` | force off |
| `TELEMETRY_ENV` | `prod` / `dev` (default `prod` on Cloud Run, `dev` elsewhere) |
| `TELEMETRY_PROJECT` | project (default: `GOOGLE_CLOUD_PROJECT`, else the metadata server) |
| `TELEMETRY_ACCESS_TOKEN` | static token for local smoke tests only |
| `TELEMETRY_MINUTE_MS` | worker aggregation window (default 60000, minimum 5000; for tests) |

Limits (`LIMITS` in `server/telemetry/index.js`): buffer 6000 rows, 500 rows per request, client message ≤ 64 KB and
≤ 40 rows, 6-message burst per connection refilled one per 10 s, 3000 client rows per instance-minute, AI rows ≤ 40
per AI per minute (objective and operation rows are never capped), client errors one row per distinct stack per
session (25 max, 5 per minute, duplicates folded into `count`).

## Tables

Source of truth: `server/telemetry/schema.js`. All tables are partitioned by `DATE(event_time)` with a 180-day
partition expiration; server tables are clustered by `(server_version, match_id)`, client tables by
`(client_version, match_id)`.

**Common columns (every row):** `schema_version`, `event_time`, `ingest_time`, `env`, `server_version` (APP_VERSION,
the git sha), `client_build` (build_id.txt `build=`), `client_version` (build_id.txt `version=` / bundle version),
`platform`, `ruleset` + `ruleset_version`, `match_id`, `instance_id` (random per server process), `revision`
(K_REVISION), `install_id`, `seat`. On server rows of a match, `client_*` are the first connected player's.

| Table | Grain | Highlights |
|---|---|---|
| `server_match_minute` | match × wall minute | tick p50/p95/p99/max (every tick, from the scheduler rings), `systems[]` (navigation, combat, capture, garrison, income, field economy, production, visibility, weather, warzone, ai, victory: calls, total, p50/p95/p99/max, over budget, deferred), snapshot build ms, msgs/bytes out, commands, routes (count, p50/p95/max ms, failures by reason, retries), stuck-ladder steps (`stuck[]`), group-route queue, units/buildings/projectiles, game speed, **pace** (sim s per real s), paused/idle seconds, worker heap, GC, event-loop lag and utilisation, autosave cost |
| `server_instance_minute` | process × minute | CPU utilisation, RSS/heap, event-loop lag, GC, admission load, matches by status, players, spectators, connections, telemetry health (sent, dropped, rejected, failures, bytes), client rows refused, anonymous opt-out count |
| `match_lifecycle` | event | `created`, `started`, `restored`, `parked`, `ended`, `abandoned`, `start_failed`, `lobby_closed`, with mode, map, size, format, teams, humans/AIs, `ai_seats[]` (difficulty, personality), objective, start resources, style, seed, speed, fog; `ended` adds winner seat/team, end reason, sim time and `eliminations[]` |
| `match_results` | seat × ended match | win/loss/draw, AI difficulty/personality, eliminated at, kills, casualties, bases held, units produced (by type), buildings built/lost, battles fought/won |
| `player_minute` | seat × wall minute | stockpiles, income (from income rates), net spend (income − stockpile change, ≥ 0), units, army value, buildings, bases, produced and lost by type, kills, AI state |
| `battles` | engagement | the sim's own engagement clusters (same owners, same 10×10 area, closed 16 s after the last shot, ≥ 110 damage): place, start/end, damage, `sides[]` with peak units by type, losses by type and value, damage taken by weapon; winner = side that lost less value (`decisive` at 3×) |
| `gameplay_events` | event | `capture`, `building_built`, `building_lost`, `upgrade`, `tier_up`, `age_up`, `nuke_launched`, `nuke_intercepted`, `eliminated`, `speed_change` |
| `ai_decisions` | decision | `objective` (prev → new state, target), `operation_start` / `operation_end` (outcome: captured, withdrew, recalled_to_defend, escalated, retargeted; duration; forces), `task_force` (forces by role and unit type at launch), `defense` (type, forward), `trench` (hexes), `note` (the AI's own reason text) |
| `client_minute` | client × minute in a match | FPS, frame ms p50/p95/p99/max, frames over 33/50/100 ms, main-thread ms, FrameTimingManager CPU/GPU ms, Present phases (`phases[]`), GC KB per frame and collections, managed heap, process memory and CPU, zoom band and camera distance, drawn units, network bytes, snapshots, RTT, interpolation delay, speed, quality, resolution |
| `client_session` | client session | OS, CPU model/cores/MHz, RAM, GPU model/vendor/VRAM, graphics API and version, resolution, refresh rate, fullscreen mode, quality preset, VSync, target FPS, Unity version, editor/debug flags |
| `client_errors` | distinct exception | kind, message (300 chars, user paths scrubbed), stack hash, top frame, folded count |

Saved views: `v_server_perf_by_version`, `v_client_fps_by_gpu` (both `env = 'prod'`).

### Changing the schema

Only add nullable columns (BigQuery cannot drop or retype one in place), bump `SCHEMA_VERSION`, run the setup tool,
then deploy. Unknown columns are ignored on insert (`ignoreUnknownValues`), so a server that ships before the setup
runs loses only the new columns, not rows.

**Schema v2 (2026-11-19, docs/performance/TELEMETRY_ANALYSIS_2026-11-19.md section 5):** added columns only.
`server_match_minute`: `overrun_s` (loop time lost to long iterations; `idle_s` now counts only time with nobody
connected), `bytes_out_spectators`, `resyncs`, `catch_ups`, `congestion_skips`. `server_instance_minute`: `cpu_cores`
is now the cgroup quota (or `SE_CPU_CORES`), plus `cpu_cores_effective`, `cpu_cores_host` and `wire_bytes_out`
(after permessage-deflate). `player_minute`: `ai_plans`. `client_minute`: `game_pace`, `snapshot_decode_ms_avg/max`,
`snapshot_apply_ms_avg/max`, `keyed_resyncs`; `in_match` is false for minutes spent on a finished match's screen;
`process_mem_mb` comes from the OS on Windows (null where unknown) and `gc_alloc_kb_per_frame` from
`GC.GetAllocatedBytesForCurrentThread` (main thread) in player builds. Battles' `sides[].units` include base engineers.
Run `node tools/telemetry-setup.mjs` before (or soon after) deploying to add the columns.

**Schema v3 (2026-11-19, Pass 7 in docs/performance/IMPLEMENTATION_LOG.md):** added columns only (not yet created in
BigQuery: run `node tools/telemetry-setup.mjs --dry-run`, then without `--dry-run`, before the deploy that ships them;
the tool only ever adds columns).
`server_match_minute`:
* Routing: `route_fail_reasons` now uses `nav.lastFail` (`goal`, `cut`, `coarse`, `fine`, `air`, `other`); a failed-route
  memo hit is no longer a failure (v1/v2 counted memo hits as `other` failures, which made the late 4v4 look like 17 %
  of routes failing) and goes to `route_memo_hits`. `routes_by_caller[]` (name, calls, total_ms, failures, memo_hits):
  the scheduler system that was running (`navigation`, `combat`, `ai`, `field economy`, `production`, ...), `command`
  (a player order) or `outside`. `nav_counters[]`: every other `game.navStats` counter's delta (deferrals, refusals,
  admitted, wait ticks, local / full invalidations, memo and corridor kept / dropped, soft-wreck routes...).
* `subsystems[]` (name, calls, total_ms, avg_ms, max_ms): `snapshot.build`, `snapshot.delta`, `snapshot.stringify`,
  `snapshot.geo`, `post.out` (postMessage to the main thread), `autosave.serialize`, `autosave.stringify`,
  `autosave.gzip_wall` (pool thread, start to callback), `visibility.stamp` (sources into team bitmaps),
  `visibility.civs` (explored, intel, battlefield memory), `combat.projectiles`, `ai.plan`. AI planning code can add its
  own phases with `game.tm?.span('ai.<phase>', ms)` (the hook is null when telemetry is off).
* `ai_seats[]` (seat, plans, total_ms, max_ms): planner runs and time per seat (B2-style starvation shows at once).
* `gc_kinds[]` (minor, major, incremental, weak: calls, total_ms, max_ms), `heap_old_space_mb`.
* `bytes_by_kind[]` / `msgs_by_kind[]` (snap, econ, geo, note, ack, ...), `deflate_sample_ratio` and
  `deflate_sample_ms_per_mb` (1 in 64 messages over 1 KB is deflated in the worker to estimate wire size and the main
  thread's permessage-deflate cost).

`client_minute`:
* `main_thread_ms_avg`, `render_thread_ms_avg`, `present_wait_ms_avg` (FrameTimingManager) and `untracked_ms_avg`
  (main thread minus present wait minus `main_ms`: the B4 gap). `cpu_frame_ms_avg` turned out to track the whole frame
  interval, so it cannot tell CPU from waiting on its own.
* `loop_phases[]` (name, avg_ms, max_ms per frame): player-loop phases timed by markers inserted into the player loop
  (`Runtime/App/FrameLoopTimer.cs`): `initialization`, `early_update`, `fixed_update`, `pre_update`, `update`,
  `pre_late_update`, `post_late_update`, and inside them `scripts` (all MonoBehaviour Updates), `ui` (UI Toolkit panel
  update + repaint), `render` (FinishFrameRendering: culling and draw submission), `present`, plus `between_frames`.
* `draw_calls_avg`, `batches_avg`, `setpass_calls_avg`, `triangles_avg` (profiler render counters; null where a release
  player does not report them).
* `objects[]`: live counts at the end of the minute (`game_object`, `object`, `mesh`, `material`, `texture`, `asset`
  from the memory profiler counters; `ui_element` every fifth minute), for the long-session creep.
* `post_match_s`: seconds of the minute spent on a finished match's screen.

## Privacy

* No names, emails, IP addresses or Steam ids are collected; there are no such columns. Civ names and player names
  never leave the server. Map site names (e.g. "Ember Station") are game content.
* Players are an anonymous random **install id** (32 hex digits, generated on first use, `PlayerPrefs`
  `se.telemetry.install`) plus their **seat** index. Server rows of a seat carry the install id only when that
  player's client has diagnostics on.
* Free text (client error messages, stack lines) is scrubbed on the client and again on the server: user folders in
  paths, emails, IPv4 addresses and Steam ids are replaced.
* **Opt-out:** *Settings > Interface > Share diagnostics* (default on; "Sends anonymous performance, system and match
  statistics to the game server to help fix bugs and lag. No names or accounts."). Off means nothing is collected or
  sent. Once per session the client sends `{t:'telemetry', optOut:true}` with no id at all, which only increments
  `server_instance_minute.client_optouts`.
* Rows expire after 180 days.

## Cost estimate

Prices (US multi-region): legacy streaming inserts $0.05/GB billed at ≥ 1 KB per row; active storage $0.02/GB-month
after 10 GB free; queries $6.25/TB after 1 TB/month free.

A typical match-hour (1 human, 1–3 AIs) produces about 60 match-minute rows, about 240 player-minute rows, about 600
AI decisions, about 300 gameplay events, about 60 battles, 60 client minutes and a few lifecycle rows: roughly
**1,400 rows, about 2 MB billed**. Each server instance adds 60 instance rows an hour.

| Load | Streaming | Storage (steady state at 180 days) | Queries | Total |
|---|---|---|---|---|
| 20 match-hours/day | $0.06/mo | 0 (under 10 GB) | free tier | **< $0.25/mo** |
| 100 match-hours/day | $0.30/mo | ~36 GB → $0.50/mo | free tier | **≈ $1/mo** |
| 500 match-hours/day | $1.50/mo | ~180 GB → $3.40/mo | free tier with clustered filters | **≈ $5/mo** |

That is well under the $10/month approved. Worst-case bounds: AI rows are capped per AI-minute, client rows per
instance-minute, and the buffer per process. Queries filtered on `event_time` (partitions) and `server_version` /
`match_id` (clustering) scan megabytes. Optionally add a billing budget alert at $10 on the project.

## Setup (done 2026-11-18)

```powershell
# as an account with BigQuery admin on the project (CLOUDSDK_CONFIG honoured)
node tools/telemetry-setup.mjs --project stem-471602             # --dry-run to preview
```

Idempotent: creates the dataset (US, 180-day default partition expiry), the tables (or adds new columns and refreshes
description, expiry and clustering), the views, and grants **`roles/bigquery.dataEditor` on the dataset only** to
`se-runtime@stem-471602.iam.gserviceaccount.com` (dataset access entry `WRITER`). `roles/bigquery.jobUser` is not
needed: streaming inserts run no jobs.

Then the next `tools/release.ps1` deploy sets `TELEMETRY_DATASET=se_telemetry` on the Cloud Run service.

### Smoke test

Start a local server with `TELEMETRY_DATASET=se_telemetry TELEMETRY_PROJECT=stem-471602 TELEMETRY_ENV=dev
TELEMETRY_MINUTE_MS=10000 APP_VERSION=smoke-<date> TELEMETRY_ACCESS_TOKEN=$(gcloud auth print-access-token)`, open an
AI exhibition over WebSocket, send a `telemetry` message, stop the server (it flushes on shutdown), then query by
`server_version`. Smoke rows are `env = 'dev'`; rows in the streaming buffer cannot be deleted for about 90 minutes,
after which:

```sql
-- per table
DELETE FROM se_telemetry.ai_decisions WHERE server_version LIKE 'smoke-%';
```

## Turning it off

* Server: remove the variable (`gcloud run services update shattered-empires --region us-east1
  --remove-env-vars TELEMETRY_DATASET`) or set `TELEMETRY_DISABLED=1`. Clients then stop sending (the hello no longer
  advertises telemetry).
* Player: *Settings > Interface > Share diagnostics* off.
* Everything: delete the dataset (`bq rm -r -d stem-471602:se_telemetry`).

## Example queries

Always filter `env = 'prod'` and a date range (partition pruning).

**Server performance by version**
```sql
SELECT server_version, COUNT(*) AS match_minutes,
  ROUND(AVG(tick_ms_avg), 2) AS tick_avg, ROUND(APPROX_QUANTILES(tick_ms_p95, 100)[OFFSET(50)], 2) AS tick_p95_median,
  ROUND(APPROX_QUANTILES(tick_ms_p99, 100)[OFFSET(95)], 1) AS tick_p99_p95, ROUND(AVG(pace / NULLIF(game_speed, 0)), 3) AS pace_vs_speed,
  ROUND(AVG(heap_used_mb), 1) AS heap_mb
FROM se_telemetry.server_match_minute
WHERE env = 'prod' AND event_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY) AND game_speed > 0
GROUP BY server_version ORDER BY MIN(event_time) DESC;
```

**Slowest systems in one release**
```sql
SELECT s.name, ROUND(SUM(s.total_ms) / SUM(s.calls), 3) AS avg_ms, ROUND(MAX(s.max_ms), 1) AS worst_ms, SUM(s.over_budget) AS over
FROM se_telemetry.server_match_minute, UNNEST(systems) s
WHERE env = 'prod' AND server_version = @sha AND DATE(event_time) >= CURRENT_DATE() - 7
GROUP BY s.name ORDER BY avg_ms DESC;
```

**Route p95 by version**
```sql
SELECT server_version, SUM(routes) AS routes, ROUND(APPROX_QUANTILES(route_ms_p95, 100)[OFFSET(50)], 3) AS route_p95_median,
  ROUND(MAX(route_ms_max), 1) AS route_worst, ROUND(SUM(route_failures) / NULLIF(SUM(routes), 0), 4) AS fail_rate,
  SUM((SELECT SUM(count) FROM UNNEST(stuck) WHERE type = 'gaveUp')) AS stuck_give_ups
FROM se_telemetry.server_match_minute
WHERE env = 'prod' AND event_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY server_version ORDER BY MIN(event_time) DESC;
```

**Client FPS by GPU and version**
```sql
SELECT m.client_version, s.gpu_model, COUNT(*) AS minutes, ROUND(AVG(m.fps_avg), 1) AS fps,
  ROUND(APPROX_QUANTILES(m.frame_ms_p95, 100)[OFFSET(50)], 1) AS frame_p95, SUM(m.frames_over_33ms) AS hitches
FROM se_telemetry.client_minute m
JOIN (SELECT install_id, ANY_VALUE(gpu_model) AS gpu_model FROM se_telemetry.client_session
      WHERE DATE(event_time) >= CURRENT_DATE() - 30 GROUP BY install_id) s USING (install_id)
WHERE m.env = 'prod' AND DATE(m.event_time) >= CURRENT_DATE() - 30
GROUP BY m.client_version, s.gpu_model HAVING minutes >= 10 ORDER BY m.client_version DESC, fps;
```

**Win rates by AI difficulty (human vs AI)**
```sql
SELECT r.ai_difficulty, COUNT(*) AS seats, ROUND(AVG(IF(r.result = 'win', 1, 0)), 3) AS ai_win_rate
FROM se_telemetry.match_results r
WHERE r.env = 'prod' AND NOT r.human AND r.match_id IN (SELECT match_id FROM se_telemetry.match_results WHERE human)
  AND DATE(r.event_time) >= CURRENT_DATE() - 60
GROUP BY r.ai_difficulty ORDER BY seats DESC;
```

**Unit-type battle outcomes**
```sql
SELECT u.type, COUNT(*) AS battles, ROUND(AVG(IF(b.winner_seat = s.seat, 1, 0)), 3) AS side_won,
  SUM(u.count) AS units_fielded, SUM((SELECT SUM(l.count) FROM UNNEST(s.lost) l WHERE l.type = u.type)) AS units_lost
FROM se_telemetry.battles b, UNNEST(b.sides) s, UNNEST(s.units) u
WHERE b.env = 'prod' AND DATE(b.event_time) >= CURRENT_DATE() - 30
GROUP BY u.type ORDER BY battles DESC;
```

**Match length and end reasons by version**
```sql
SELECT server_version, end_reason, COUNT(*) AS matches, ROUND(AVG(sim_time_s) / 60, 1) AS sim_minutes
FROM se_telemetry.match_lifecycle
WHERE env = 'prod' AND event = 'ended' AND DATE(event_time) >= CURRENT_DATE() - 30
GROUP BY server_version, end_reason ORDER BY matches DESC;
```

**What an AI did in one match**
```sql
SELECT sim_time_s, seat, kind, prev_state, state, target_name, outcome, text
FROM se_telemetry.ai_decisions WHERE match_id = @match ORDER BY sim_time_s;
```

**Top client exceptions in a release**
```sql
SELECT stack_hash, ANY_VALUE(message) AS message, ANY_VALUE(top_frame) AS frame, SUM(count) AS hits, COUNT(DISTINCT install_id) AS installs
FROM se_telemetry.client_errors WHERE env = 'prod' AND client_version = @version
GROUP BY stack_hash ORDER BY installs DESC, hits DESC;
```
