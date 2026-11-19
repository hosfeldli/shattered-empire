// BigQuery telemetry schema (docs/TELEMETRY.md). The single source of truth for the dataset's tables:
// tools/telemetry-setup.mjs creates or updates them from this file, the server shapes and validates rows
// against it, and the client's rows are whitelisted against its client tables.
//
// Rules for changing it:
//  * only ADD nullable columns (BigQuery cannot drop or retype a column in place); bump SCHEMA_VERSION;
//  * every row carries the COMMON columns (version filters, match id, event and ingest time);
//  * no names, emails, IP addresses or Steam ids: players are an anonymous install id plus a seat index.

export const SCHEMA_VERSION = 1;
export const DATASET = 'se_telemetry';
export const PARTITION_EXPIRATION_MS = 180 * 24 * 3600 * 1000;

const f = (name, type, description, mode = 'NULLABLE', fields) => (fields ? { name, type, mode, description, fields } : { name, type, mode, description });
const rec = (name, description, fields) => f(name, 'RECORD', description, 'REPEATED', fields);
const counts = (name, description) => rec(name, description, [f('type', 'STRING', 'unit, building or reason type'), f('count', 'INT64', 'how many')]);

export const COMMON = [
  f('schema_version', 'INT64', 'telemetry schema version (server/telemetry/schema.js)', 'REQUIRED'),
  f('event_time', 'TIMESTAMP', 'when it happened (client rows: the client clock, clamped to the server day)', 'REQUIRED'),
  f('ingest_time', 'TIMESTAMP', 'when the server sent the row to BigQuery', 'REQUIRED'),
  f('env', 'STRING', 'prod (Cloud Run) or dev (local, smoke tests)'),
  f('server_version', 'STRING', 'APP_VERSION of the server (git sha), dev locally'),
  f('client_build', 'STRING', 'build_id.txt build= of the client (git sha), editor or unknown'),
  f('client_version', 'STRING', 'release version of the client (build_id.txt version=, else bundle version)'),
  f('platform', 'STRING', 'server rows: node platform/arch; client rows: the client OS family'),
  f('ruleset', 'STRING', 'match ruleset id (action-v2)'),
  f('ruleset_version', 'STRING', 'version part of the ruleset id (v2)'),
  f('match_id', 'STRING', 'match id (6 hex), null outside a match'),
  f('instance_id', 'STRING', 'random id of the server process (one per Cloud Run instance start)'),
  f('revision', 'STRING', 'Cloud Run revision (K_REVISION)'),
  f('install_id', 'STRING', 'anonymous random id of the client install (only when its diagnostics are on)'),
  f('seat', 'INT64', 'seat index (civ id) in the match'),
];

const SYSTEM = [f('name', 'STRING', 'scheduler system'), f('calls', 'INT64', 'runs in the minute'), f('total_ms', 'FLOAT64', 'time spent in the minute'),
  f('avg_ms', 'FLOAT64', 'mean per run'), f('p50_ms', 'FLOAT64', 'recent p50'), f('p95_ms', 'FLOAT64', 'recent p95'), f('p99_ms', 'FLOAT64', 'recent p99'),
  f('max_ms', 'FLOAT64', 'max in the minute'), f('over_budget', 'INT64', 'runs over budget in the minute'), f('deferred', 'INT64', 'deferrals in the minute')];

const UNIT_SIDE = [f('seat', 'INT64', 'side (civ id)'), f('team', 'INT64', 'team'), f('human', 'BOOL', 'human player'),
  f('ai_difficulty', 'STRING', 'AI difficulty'), f('ai_personality', 'STRING', 'AI personality'),
  f('units_peak', 'INT64', 'most units of this side seen in the battle at once'), counts('units', 'peak units by type'),
  f('losses', 'INT64', 'units and buildings lost'), counts('lost', 'losses by type'), f('lost_value', 'FLOAT64', 'cost of what was lost (materials + energy)'),
  f('damage_taken', 'FLOAT64', 'damage taken'), rec('weapons', 'damage taken by weapon', [f('type', 'STRING', 'weapon'), f('damage', 'FLOAT64', 'damage')])];

export const TABLES = {
  server_match_minute: {
    source: 'server', description: 'Per match-minute simulation performance: ticks, systems, routes, counts, memory, pace.',
    fields: [
      f('minute_index', 'INT64', 'minutes since the worker started'), f('wall_s', 'FLOAT64', 'wall seconds covered'), f('sim_time_s', 'FLOAT64', 'match clock at the end'),
      f('sim_advanced_s', 'FLOAT64', 'match seconds simulated in this minute'), f('game_speed', 'INT64', 'speed at the end (0 paused)'),
      f('pace', 'FLOAT64', 'sim seconds per real second'), f('paused_s', 'FLOAT64', 'wall seconds paused'), f('idle_s', 'FLOAT64', 'wall seconds with nobody connected (not ticking)'),
      f('ticks', 'INT64', 'simulation ticks'), f('intervals', 'INT64', 'tick intervals (10 Hz loop iterations that ran)'),
      f('tick_ms_avg', 'FLOAT64', 'mean ms per tick'), f('tick_ms_p50', 'FLOAT64', 'p50 ms per tick'), f('tick_ms_p95', 'FLOAT64', 'p95'), f('tick_ms_p99', 'FLOAT64', 'p99'), f('tick_ms_max', 'FLOAT64', 'max'),
      f('interval_ms_max', 'FLOAT64', 'longest whole loop iteration (ticks + snapshots)'), f('intervals_over_100ms', 'INT64', 'loop iterations over the 100 ms budget'),
      rec('systems', 'per-system timings (scheduler)', SYSTEM),
      f('snapshots', 'INT64', 'snapshot rounds built'), f('snapshot_ms_total', 'FLOAT64', 'ms building and encoding snapshots'), f('snapshot_ms_max', 'FLOAT64', 'longest snapshot round'),
      f('msgs_out', 'INT64', 'messages sent to clients'), f('bytes_out', 'INT64', 'JSON bytes sent to clients (before compression)'),
      f('commands', 'INT64', 'player and AI commands received from clients'),
      f('routes', 'INT64', 'nav.route calls'), f('route_ms_total', 'FLOAT64', 'ms routing'), f('route_ms_p50', 'FLOAT64', 'p50'), f('route_ms_p95', 'FLOAT64', 'p95'), f('route_ms_max', 'FLOAT64', 'max'),
      f('route_failures', 'INT64', 'routes returning no path'), counts('route_fail_reasons', 'failures by reason (cutoff, other)'), f('route_retries', 'INT64', 'coarse re-plans (navStats.routeRetry)'),
      counts('stuck', 'stuck-ladder steps and give-ups (navStats.stuck deltas)'), f('group_route_queue_max', 'INT64', 'largest group-route queue'), f('group_route_queue_end', 'INT64', 'queue at the end'),
      f('units', 'INT64', 'units at the end'), f('units_max', 'INT64', 'most units'), f('buildings', 'INT64', 'buildings at the end'), f('projectiles', 'INT64', 'projectiles at the end'), f('projectiles_max', 'INT64', 'most projectiles'),
      f('players_connected', 'INT64', 'humans connected'), f('spectators', 'INT64', 'spectators connected'), f('civs', 'INT64', 'nations'), f('alive', 'INT64', 'nations alive'),
      f('heap_used_mb', 'FLOAT64', 'worker heap used'), f('heap_total_mb', 'FLOAT64', 'worker heap size'), f('heap_limit_mb', 'FLOAT64', 'worker heap limit'),
      f('gc_count', 'INT64', 'worker GCs'), f('gc_ms_total', 'FLOAT64', 'worker GC pause total'), f('gc_ms_max', 'FLOAT64', 'longest worker GC pause'),
      f('loop_lag_p50_ms', 'FLOAT64', 'worker event-loop delay p50'), f('loop_lag_p99_ms', 'FLOAT64', 'p99'), f('loop_lag_max_ms', 'FLOAT64', 'max'), f('loop_utilization', 'FLOAT64', 'worker event-loop utilisation 0-1'),
      f('autosaves', 'INT64', 'autosaves'), f('autosave_ms_max', 'FLOAT64', 'longest synchronous serialize'),
    ] },
  server_instance_minute: {
    source: 'server', description: 'Per server-process minute: CPU, memory, event loop, matches, players, telemetry health.',
    fields: [
      f('uptime_s', 'FLOAT64', 'process uptime'), f('cpu_cores', 'INT64', 'cores visible'), f('cpu_util', 'FLOAT64', 'process CPU / (wall x cores), 0-1'), f('cpu_ms', 'FLOAT64', 'process CPU ms in the minute'),
      f('rss_mb', 'FLOAT64', 'resident memory'), f('heap_used_mb', 'FLOAT64', 'main-thread heap used'), f('external_mb', 'FLOAT64', 'external + array buffers'), f('free_mb', 'FLOAT64', 'free system memory'),
      f('loop_lag_p50_ms', 'FLOAT64', 'main event-loop delay p50'), f('loop_lag_p99_ms', 'FLOAT64', 'p99'), f('loop_lag_max_ms', 'FLOAT64', 'max'), f('loop_utilization', 'FLOAT64', 'main event-loop utilisation 0-1'),
      f('gc_count', 'INT64', 'main-thread GCs'), f('gc_ms_total', 'FLOAT64', 'main-thread GC pause total'),
      f('load_cores', 'FLOAT64', 'sum of running matches tick load in cores (admission control)'),
      f('matches', 'INT64', 'matches known'), f('matches_running', 'INT64', 'running'), f('matches_parked', 'INT64', 'parked'), f('matches_lobby', 'INT64', 'in lobby'),
      f('players', 'INT64', 'players connected'), f('spectators', 'INT64', 'spectators connected'), f('connections', 'INT64', 'WebSocket connections'),
      f('rows_buffered', 'INT64', 'telemetry rows waiting'), f('rows_sent', 'INT64', 'rows accepted by BigQuery (minute)'), f('rows_dropped', 'INT64', 'rows dropped: overflow or failed sends (minute)'),
      f('rows_rejected', 'INT64', 'rows BigQuery rejected (minute)'), f('flush_failures', 'INT64', 'failed insert requests (minute)'), f('bytes_sent', 'INT64', 'request bytes to BigQuery (minute)'),
      f('client_rows', 'INT64', 'client rows accepted (minute)'), f('client_rows_refused', 'INT64', 'client rows refused by validation or rate limits (minute)'),
      f('client_optouts', 'INT64', 'sessions that reported diagnostics turned off (anonymous count, minute)'),
    ] },
  match_lifecycle: {
    source: 'server', description: 'Match created / started / restored / parked / ended / abandoned, with every setting.',
    fields: [
      f('event', 'STRING', 'created, started, restored, parked, ended, abandoned, start_failed, lobby_closed'),
      f('mode', 'STRING', 'ai, pvp, observe, sandbox'), f('map', 'STRING', 'map id or random/custom'), f('map_size', 'INT64', 'side length'), f('format', 'STRING', '1v1, 2v2, ffa4...'),
      f('team_size', 'INT64', 'seats per team'), f('teams', 'INT64', 'teams'), f('humans', 'INT64', 'human seats'), f('ais', 'INT64', 'AI seats'), f('closed_seats', 'INT64', 'closed seats'),
      f('objective', 'STRING', 'domination, control, operation'), f('start_res', 'STRING', 'starting resources'), f('style', 'STRING', 'random-world style'),
      f('seed', 'INT64', 'world seed'), f('speed', 'INT64', 'starting speed (observe)'), f('observer_fog', 'BOOL', 'spectator fog'), f('tutorial', 'BOOL', 'tutorial'),
      f('fair_play', 'BOOL', 'AI fair play'), f('public', 'BOOL', 'listed lobby'), f('wait_for_ready', 'BOOL', 'lobby waits for ready'),
      rec('ai_seats', 'each AI seat', [f('seat', 'INT64', 'seat'), f('team', 'INT64', 'team'), f('difficulty', 'STRING', 'difficulty'), f('personality', 'STRING', 'personality')]),
      f('sim_time_s', 'FLOAT64', 'match clock at the event'), f('wall_s', 'FLOAT64', 'wall seconds since created'),
      f('winner_seat', 'INT64', 'winning civ (-1 draw)'), f('winner_team', 'INT64', 'winning team'), f('end_reason', 'STRING', 'how it ended (Military Domination, idle, ...)'),
      rec('eliminations', 'nations eliminated', [f('seat', 'INT64', 'seat'), f('team', 'INT64', 'team'), f('time_s', 'FLOAT64', 'match clock')]),
      f('details', 'STRING', 'JSON: anything else'),
    ] },
  match_results: {
    source: 'server', description: 'One row per seat when a match ends: win/loss, AI settings, totals.',
    fields: [
      f('team', 'INT64', 'team'), f('human', 'BOOL', 'human seat'), f('ai_difficulty', 'STRING', 'AI difficulty'), f('ai_personality', 'STRING', 'AI personality'),
      f('result', 'STRING', 'win, loss, draw'), f('eliminated_at_s', 'FLOAT64', 'match clock when eliminated'), f('sim_time_s', 'FLOAT64', 'match length'),
      f('end_reason', 'STRING', 'how the match ended'), f('winner_team', 'INT64', 'winning team'), f('mode', 'STRING', 'match mode'), f('map', 'STRING', 'map'), f('format', 'STRING', 'format'),
      f('kills', 'INT64', 'kills'), f('casualties', 'INT64', 'casualties'), f('bases_end', 'INT64', 'bases with an HQ at the end'),
      f('units_produced', 'INT64', 'units produced'), f('buildings_built', 'INT64', 'buildings completed'), f('buildings_lost', 'INT64', 'buildings lost'),
      counts('produced', 'units produced by type'), f('battles', 'INT64', 'battles fought'), f('battles_won', 'INT64', 'battles won'),
    ] },
  player_minute: {
    source: 'server', description: 'Per player per match-minute: economy, production, army, AI state.',
    fields: [
      f('minute_index', 'INT64', 'match-minute (sim clock / 60)'), f('sim_time_s', 'FLOAT64', 'match clock'), f('team', 'INT64', 'team'), f('human', 'BOOL', 'human'),
      f('ai_difficulty', 'STRING', 'AI difficulty'), f('ai_personality', 'STRING', 'AI personality'), f('alive', 'BOOL', 'alive'), f('age', 'INT64', 'tier / era'),
      f('materials', 'FLOAT64', 'stockpile'), f('energy', 'FLOAT64', 'stockpile'), f('income_materials', 'FLOAT64', 'gross income in the minute'), f('income_energy', 'FLOAT64', 'gross income'),
      f('spend_materials', 'FLOAT64', 'spent in the minute (income - change)'), f('spend_energy', 'FLOAT64', 'spent'),
      f('units', 'INT64', 'units'), f('army_value', 'FLOAT64', 'cost of units'), f('buildings', 'INT64', 'buildings'), f('bases', 'INT64', 'bases with an HQ'),
      counts('produced', 'units produced in the minute by type'), counts('lost', 'units lost in the minute by type'), f('kills', 'INT64', 'kills so far'), f('casualties', 'INT64', 'casualties so far'),
      f('ai_state', 'STRING', 'AI objective state'),
    ] },
  battles: {
    source: 'server', description: 'One row per engagement (combat clustered by owners and 10x10 area).',
    fields: [
      f('battle_key', 'STRING', 'engagement key'), f('tile', 'INT64', 'tile'), f('x', 'FLOAT64', 'map x'), f('z', 'FLOAT64', 'map z'), f('site', 'STRING', 'nearest site name'),
      f('start_s', 'FLOAT64', 'match clock'), f('end_s', 'FLOAT64', 'last shot'), f('duration_s', 'FLOAT64', 'length'), f('damage', 'FLOAT64', 'total damage'),
      f('winner_seat', 'INT64', 'side that lost less value (-1 even)'), f('winner_team', 'INT64', 'its team'), f('outcome', 'STRING', 'decisive, won, even'),
      rec('sides', 'each side', UNIT_SIDE),
    ] },
  gameplay_events: {
    source: 'server', description: 'Captures, buildings built and lost, upgrades, tiers, nukes, eliminations, speed changes.',
    fields: [
      f('event', 'STRING', 'capture, building_built, building_lost, upgrade, tier_up, nuke_launched, nuke_intercepted, eliminated, speed_change'),
      f('sim_time_s', 'FLOAT64', 'match clock'), f('type', 'STRING', 'building, unit, upgrade or weapon type'), f('tile', 'INT64', 'tile'),
      f('other_seat', 'INT64', 'previous owner / target owner'), f('value', 'FLOAT64', 'tier, speed, count...'), f('ai', 'BOOL', 'seat is an AI'), f('details', 'STRING', 'JSON'),
    ] },
  ai_decisions: {
    source: 'server', description: 'AI choices: objectives, operations, task forces, defences, trenches, notes with reasons.',
    fields: [
      f('sim_time_s', 'FLOAT64', 'match clock'), f('kind', 'STRING', 'objective, operation_start, operation_end, task_force, defense, trench, note'),
      f('state', 'STRING', 'objective state after'), f('prev_state', 'STRING', 'state before'), f('target_site', 'INT64', 'objective site id'), f('target_name', 'STRING', 'objective site name'),
      f('outcome', 'STRING', 'operation outcome'), f('text', 'STRING', 'the AI note (its reason)'), f('type', 'STRING', 'building type'), f('value', 'FLOAT64', 'units, hexes, seconds...'),
      f('ai_difficulty', 'STRING', 'difficulty'), f('ai_personality', 'STRING', 'personality'), f('details', 'STRING', 'JSON'),
    ] },
  client_minute: {
    source: 'client', description: 'Per client minute: frame pacing, phases, GC, camera, units, network, process.',
    fields: [
      f('in_match', 'BOOL', 'a match was shown'), f('wall_s', 'FLOAT64', 'seconds covered'), f('frames', 'INT64', 'frames'), f('fps_avg', 'FLOAT64', 'mean FPS'),
      f('frame_ms_p50', 'FLOAT64', 'p50'), f('frame_ms_p95', 'FLOAT64', 'p95'), f('frame_ms_p99', 'FLOAT64', 'p99'), f('frame_ms_max', 'FLOAT64', 'max'),
      f('frames_over_33ms', 'INT64', 'frames over 33 ms'), f('frames_over_50ms', 'INT64', 'over 50 ms'), f('frames_over_100ms', 'INT64', 'over 100 ms'),
      f('main_ms_avg', 'FLOAT64', 'main-thread work per frame'), f('main_ms_p95', 'FLOAT64', 'p95'), f('cpu_frame_ms_avg', 'FLOAT64', 'FrameTimingManager CPU'), f('gpu_frame_ms_avg', 'FLOAT64', 'FrameTimingManager GPU'),
      rec('phases', 'per-phase timings', [f('name', 'STRING', 'phase'), f('avg_ms', 'FLOAT64', 'mean per frame'), f('max_ms', 'FLOAT64', 'max')]),
      f('gc_alloc_kb_per_frame', 'FLOAT64', 'managed allocation per frame'), f('gc_collections', 'INT64', 'gen0 collections'), f('mono_heap_mb', 'FLOAT64', 'managed heap'),
      f('total_alloc_mb', 'FLOAT64', 'Unity total allocated'), f('process_mem_mb', 'FLOAT64', 'working set'), f('process_cpu_pct', 'FLOAT64', 'process CPU % of one core x cores'),
      f('zoom_band', 'STRING', 'close, mid, far, strategic (most of the minute)'), f('camera_distance', 'FLOAT64', 'mean camera distance'),
      f('visible_units', 'INT64', 'units drawn (mean)'), f('units_known', 'INT64', 'units in the client store'),
      f('net_bytes_in', 'INT64', 'bytes received'), f('snapshots', 'INT64', 'snapshots received'), f('rtt_ms', 'FLOAT64', 'ping round trip'), f('interp_delay_ms', 'FLOAT64', 'newest snapshot minus render time'),
      f('game_speed', 'FLOAT64', 'play rate'), f('paused', 'BOOL', 'paused at the end'), f('spectator', 'BOOL', 'spectating'),
      f('quality', 'STRING', 'quality preset'), f('resolution', 'STRING', 'WxH'),
    ] },
  client_session: {
    source: 'client', description: 'Once per client session: system information.',
    fields: [
      f('os', 'STRING', 'operating system'), f('os_family', 'STRING', 'Windows, MacOSX, Linux'), f('cpu_model', 'STRING', 'processor'), f('cpu_cores', 'INT64', 'logical cores'), f('cpu_mhz', 'INT64', 'frequency'),
      f('ram_mb', 'INT64', 'system memory'), f('gpu_model', 'STRING', 'graphics device'), f('gpu_vendor', 'STRING', 'vendor'), f('gpu_vram_mb', 'INT64', 'graphics memory'),
      f('graphics_api', 'STRING', 'D3D11, Vulkan...'), f('graphics_version', 'STRING', 'API version string'), f('resolution', 'STRING', 'WxH'), f('refresh_hz', 'FLOAT64', 'refresh rate'),
      f('fullscreen', 'STRING', 'fullscreen mode'), f('quality', 'STRING', 'quality preset'), f('vsync', 'INT64', 'vSyncCount'), f('target_fps', 'INT64', 'targetFrameRate'),
      f('unity_version', 'STRING', 'engine'), f('editor', 'BOOL', 'running in the editor'), f('debug_build', 'BOOL', 'development build'),
      f('process_mem_mb', 'FLOAT64', 'working set at report'), f('startup_s', 'FLOAT64', 'seconds since launch'),
    ] },
  client_errors: {
    source: 'client', description: 'Client exceptions (rate-limited, folded by stack hash).',
    fields: [
      f('kind', 'STRING', 'exception, error, assert'), f('message', 'STRING', 'first 300 chars, user paths scrubbed'), f('stack_hash', 'STRING', 'hash of the stack trace'),
      f('top_frame', 'STRING', 'first stack line'), f('count', 'INT64', 'occurrences folded into this row'), f('in_match', 'BOOL', 'during a match'),
    ] },
};

// tables whose rows the client may send (everything else is server-only)
export const CLIENT_TABLES = Object.keys(TABLES).filter((t) => TABLES[t].source === 'client');

/** Full BigQuery field list of a table (common columns first). */
export function fieldsOf(table) { return [...COMMON, ...TABLES[table].fields]; }

/** BigQuery table resource (tables.insert / tables.patch body). */
export function tableResource(project, table) {
  const t = TABLES[table];
  return {
    tableReference: { projectId: project, datasetId: DATASET, tableId: table },
    description: `${t.description} Schema v${SCHEMA_VERSION}.`,
    schema: { fields: fieldsOf(table) },
    timePartitioning: { type: 'DAY', field: 'event_time', expirationMs: String(PARTITION_EXPIRATION_MS) },
    clustering: { fields: [t.source === 'client' ? 'client_version' : 'server_version', 'match_id'] },
    labels: { app: 'shattered-empires', kind: 'telemetry' },
  };
}

// Saved views: the most-used benchmark questions, version-filterable.
export const VIEWS = {
  v_server_perf_by_version: `
SELECT server_version, DATE(event_time) AS day, COUNT(*) AS match_minutes,
  ROUND(AVG(tick_ms_avg), 2) AS tick_ms_avg, ROUND(APPROX_QUANTILES(tick_ms_p95, 100)[OFFSET(50)], 2) AS tick_ms_p95_median,
  ROUND(MAX(tick_ms_max), 1) AS tick_ms_worst, ROUND(AVG(pace), 3) AS pace_avg, ROUND(AVG(heap_used_mb), 1) AS heap_mb_avg,
  ROUND(APPROX_QUANTILES(route_ms_p95, 100)[OFFSET(50)], 3) AS route_ms_p95_median, SUM(route_failures) AS route_failures
FROM \`{project}.${DATASET}.server_match_minute\`
WHERE env = 'prod'
GROUP BY server_version, day`,
  v_client_fps_by_gpu: `
SELECT s.client_version, s.gpu_model, s.graphics_api, COUNT(*) AS minutes, ROUND(AVG(m.fps_avg), 1) AS fps_avg,
  ROUND(APPROX_QUANTILES(m.frame_ms_p95, 100)[OFFSET(50)], 1) AS frame_ms_p95_median, SUM(m.frames_over_33ms) AS frames_over_33ms
FROM \`{project}.${DATASET}.client_minute\` m
JOIN (SELECT install_id, client_version, ANY_VALUE(gpu_model) AS gpu_model, ANY_VALUE(graphics_api) AS graphics_api
      FROM \`{project}.${DATASET}.client_session\` GROUP BY install_id, client_version) s
  USING (install_id, client_version)
WHERE m.in_match AND m.env = 'prod'
GROUP BY s.client_version, s.gpu_model, s.graphics_api`,
};
