// Telemetry to BigQuery (docs/TELEMETRY.md). Main-thread side: a bounded row buffer, a periodic async flush with
// back-off, the per-instance minute sampler, match-lifecycle rows, and validated, rate-limited client rows.
//
// Off unless TELEMETRY_DATASET is set (local development and tests never send anything): createTelemetry then
// returns a no-op whose methods do nothing. Telemetry never blocks or slows a match: the match workers post compact
// per-minute aggregates (server/telemetry/probe.js), the flush is async and a failed flush backs off and drops.
import crypto from 'node:crypto';
import os from 'node:os';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { CLIENT_TABLES, COMMON, SCHEMA_VERSION, TABLES, fieldsOf } from './schema.js';
import { insertAll, projectId, tokenSource } from './bigquery.js';

export const LIMITS = Object.freeze({
  bufferRows: 6000,          // rows kept in memory; the oldest are dropped beyond this
  batchRows: 500,            // rows per insertAll request
  flushSeconds: 45,          // flush period
  flushAtRows: 1500,         // flush early when this many rows wait
  maxBackoffSeconds: 600,    // a failing BigQuery is retried at most every 10 minutes
  clientMessageBytes: 64 * 1024,   // one client telemetry message
  clientRowsPerMessage: 40,
  clientBurst: 6,            // client messages: a bucket of 6, refilled one per 10 s
  clientRefillMs: 10_000,
  clientRowsPerMinute: 3000, // all clients together, per instance
  stringChars: 1024, detailsChars: 4000, repeated: 64,
});

const FIELD_INDEX = new Map(Object.keys(TABLES).map((t) => [t, fieldsOf(t)]));
const COMMON_NAMES = new Set(COMMON.map((x) => x.name));
const SAFE = /[^\w .,:;+\-()/#@[\]]/g;
const clean = (v, n = 64) => (typeof v === 'string' ? v.replace(SAFE, '').slice(0, n) : null);
const INSTALL = /^[0-9a-f]{32}$/;
// user names inside paths (C:\Users\name\..., /home/name/..., /Users/name/...) never leave the machine
export const scrub = (s) => String(s).replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1<user>').replace(/(\/(?:home|Users)\/)[^/\s"']+/g, '$1<user>')
  .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '<email>').replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>').replace(/\b7656119\d{10}\b/g, '<steamid>');
export const rulesetVersion = (r) => (typeof r === 'string' && /-(v\d+)$/.exec(r)?.[1]) || null;

/** Coerce one value to a BigQuery field (undefined when it does not fit). */
function coerce(field, v, client) {
  if (v === undefined || v === null) return undefined;
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(v)) return undefined;
    const out = [];
    for (const item of v.slice(0, LIMITS.repeated)) {
      if (field.type === 'RECORD') { const o = coerceRecord(field.fields, item, client); if (o) out.push(o); }
      else { const x = coerce({ ...field, mode: 'NULLABLE' }, item, client); if (x !== undefined) out.push(x); }
    }
    return out;
  }
  switch (field.type) {
    case 'INT64': { const n = Number(v); return typeof v !== 'boolean' && Number.isFinite(n) ? Math.round(n) : undefined; }
    case 'FLOAT64': { const n = Number(v); return typeof v !== 'boolean' && Number.isFinite(n) ? Math.round(n * 10000) / 10000 : undefined; }
    case 'BOOL': return typeof v === 'boolean' ? v : v === 1 || v === 0 ? !!v : undefined;
    case 'STRING': {
      if (typeof v === 'object') v = JSON.stringify(v);
      const s = String(v).slice(0, field.name === 'details' ? LIMITS.detailsChars : LIMITS.stringChars);
      return client ? scrub(s) : s;
    }
    case 'TIMESTAMP': { const d = new Date(typeof v === 'number' ? v : String(v)); return Number.isFinite(d.getTime()) ? d.toISOString() : undefined; }
    case 'RECORD': return coerceRecord(field.fields, v, client);
    default: return undefined;
  }
}
function coerceRecord(fields, v, client) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = {};
  for (const fd of fields) { const x = coerce(fd, v[fd.name], client); if (x !== undefined) o[fd.name] = x; }
  return o;
}

/** Shape a row for `table`: known columns only, coerced to their types. Exported for tests. */
export function shapeRow(table, row, client = false) {
  const fields = FIELD_INDEX.get(table);
  if (!fields) return null;
  return coerceRecord(fields, row, client);
}

class NullTelemetry {
  get enabled() { return false; }
  start() {} stop() { return Promise.resolve(); } record() {} hello() {} client() {} lifecycle() {} fromWorker() {} flush() { return Promise.resolve(); }
  helloReply() { return undefined; }
  workerOptions() { return null; }
}

export class Telemetry {
  constructor({ env = process.env, log = console, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.env = env; this.log = log; this.fetch = fetchImpl; this.now = now;
    this.dataset = env.TELEMETRY_DATASET;
    this.envName = env.TELEMETRY_ENV || (env.K_SERVICE ? 'prod' : 'dev');
    this.serverVersion = env.APP_VERSION || 'dev';
    this.revision = env.K_REVISION || null;
    this.instance = crypto.randomBytes(6).toString('hex');
    this.platform = `${process.platform}-${process.arch}`;
    this.buffer = [];
    this.token = tokenSource({ env, fetchImpl });
    this.project = null;
    this.backoffUntil = 0; this.backoffS = 0; this.flushing = null;
    this.minute = this.freshMinute();
    this.timers = [];
    this.manager = null; this.connections = () => 0;
  }
  get enabled() { return true; }
  freshMinute() { return { sent: 0, dropped: 0, rejected: 0, failures: 0, bytes: 0, clientRows: 0, clientRefused: 0, optouts: 0 }; }

  /** Start the flush timer and the per-instance minute sampler. */
  start({ manager = null, connections = null } = {}) {
    this.manager = manager; if (connections) this.connections = connections;
    const flush = setInterval(() => { this.flush().catch(() => {}); }, LIMITS.flushSeconds * 1000); flush.unref?.();
    this.lag = monitorEventLoopDelay({ resolution: 20 }); this.lag.enable();
    this.elu = performance.eventLoopUtilization();
    this.cpu = process.cpuUsage(); this.cpuAt = performance.now();
    this.gc = { count: 0, ms: 0 };
    try { this.gcObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) { this.gc.count++; this.gc.ms += e.duration; } }); this.gcObs.observe({ entryTypes: ['gc'] }); } catch { /* unsupported */ }
    const sample = setInterval(() => { try { this.sampleInstance(); } catch (e) { this.log.warn?.(`telemetry sample: ${e.message}`); } }, 60_000); sample.unref?.();
    this.timers.push(flush, sample);
    this.log.info?.(`telemetry on: dataset ${this.dataset} (${this.envName}), instance ${this.instance}`);
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.lag?.disable(); this.gcObs?.disconnect();
    try { this.sampleInstance(); } catch { /* best effort */ }
    await Promise.race([this.flush(true), new Promise((r) => setTimeout(r, 4000).unref?.())]);
  }

  /** Add one row. `row` holds the table's own columns plus any common ones known to the caller. */
  record(table, row, client = false) {
    if (!TABLES[table]) return;
    const r = { ...row };
    r.schema_version = SCHEMA_VERSION;
    r.event_time ??= this.now();
    r.env = this.envName;
    r.server_version = this.serverVersion;
    r.instance_id = this.instance;
    r.revision = this.revision;
    if (!client) r.platform ??= this.platform;
    if (r.ruleset && !r.ruleset_version) r.ruleset_version = rulesetVersion(r.ruleset);
    const shaped = shapeRow(table, r, client);
    if (!shaped) return;
    this.buffer.push({ table, json: shaped, insertId: crypto.randomUUID(), tries: 0 });
    this.trim();
    if (this.buffer.length >= LIMITS.flushAtRows && !this.flushing) this.flush().catch(() => {});
  }

  /** Send everything buffered (one request per table batch). Concurrent calls share one flush. */
  flush(final = false) {
    if (this.flushing) return this.flushing;
    if (!this.buffer.length || (!final && this.now() < this.backoffUntil)) return Promise.resolve();
    this.flushing = this.flushNow().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async flushNow() {
    const rows = this.buffer.splice(0);
    let token;
    try { this.project ??= await projectId({ env: this.env, fetchImpl: this.fetch }); token = await this.token(); }
    catch (e) { this.fail(rows, `token: ${e.message}`, true); return; }
    const ingest = new Date(this.now()).toISOString();
    const byTable = new Map();
    for (const r of rows) { r.json.ingest_time = ingest; (byTable.get(r.table) || byTable.set(r.table, []).get(r.table)).push(r); }
    const batches = [];
    for (const [table, list] of byTable) for (let i = 0; i < list.length; i += LIMITS.batchRows) batches.push([table, list.slice(i, i + LIMITS.batchRows)]);
    let failed = false;
    for (let k = 0; k < batches.length; k++) {
      const [table, batch] = batches[k];
      const res = await insertAll({ project: this.project, dataset: this.dataset, table, rows: batch, token, fetchImpl: this.fetch });
      this.minute.bytes += res.bytes;
      if (res.ok) {
        this.minute.sent += res.inserted; this.minute.rejected += res.rejected;
        if (res.rejected) this.warnOnce(`telemetry: ${res.rejected} ${table} rows rejected: ${res.error}`);
        continue;
      }
      failed = true;
      this.fail(batch, `${table}: ${res.error}`, res.retry);
      // BigQuery or the network is down: keep the rest for after the back-off instead of hammering it
      if (res.retry) { const rest = batches.slice(k + 1).flatMap(([, b]) => b); if (rest.length) { this.buffer.unshift(...rest); this.trim(); } break; }
    }
    if (!failed) this.backoffS = 0;
  }

  // drop the oldest rows beyond the bound
  trim() { if (this.buffer.length > LIMITS.bufferRows) { const n = this.buffer.length - LIMITS.bufferRows; this.buffer.splice(0, n); this.minute.dropped += n; } }

  // a failed request: retry its rows once on the next flush (if retryable), then drop; back off exponentially
  fail(rows, why, retry) {
    this.minute.failures++;
    const again = retry ? rows.filter((r) => ++r.tries < 2) : [];
    this.minute.dropped += rows.length - again.length;
    if (again.length) { this.buffer.unshift(...again); this.trim(); }
    this.backoffS = Math.min(LIMITS.maxBackoffSeconds, Math.max(LIMITS.flushSeconds, this.backoffS * 2 || LIMITS.flushSeconds));
    this.backoffUntil = this.now() + this.backoffS * 1000;
    this.warnOnce(`telemetry flush failed (${why}); backing off ${this.backoffS}s`);
  }

  warnOnce(text) {
    const t = this.now();
    if (t - (this.lastWarn || 0) < 300_000) return;
    this.lastWarn = t; this.log.warn?.(text);
  }

  // ---------------------------------------------------------------- server rows
  /** The common columns of a match's rows: id, ruleset, and the first connected human's client version. */
  matchCommon(m) {
    const c = [...(m.slots || []), ...(m.watchers || [])].map((s) => s.ws?.ctx?.client).find(Boolean) || {};
    return { match_id: m.id, ruleset: m.ruleset, client_build: c.build, client_version: c.version };
  }
  installOf(m, seat) { const s = m.slots?.[seat]; return s?.human ? s.ws?.ctx?.telemetryInstall || undefined : undefined; }

  /** Rows a match worker posted ({t:'tm', rows: [[table, row], ...]}). */
  fromWorker(m, rows) {
    if (!Array.isArray(rows)) return;
    const common = this.matchCommon(m);
    for (const [table, row] of rows.slice(0, 2000)) {
      if (!TABLES[table] || TABLES[table].source !== 'server' || !row) continue;
      if (table === 'match_lifecycle') { const { event, ...rest } = row; this.lifecycle(m, event, rest); continue; }   // the worker's 'ended' + the lobby settings
      const install = row.seat != null ? this.installOf(m, row.seat) : undefined;
      const extra = table === 'server_match_minute' ? { players_connected: m.slots.filter((s) => s.ws).length, spectators: (m.watchers || []).filter((w) => w.ws).length } : null;
      this.record(table, { ...common, ...extra, ...row, install_id: install });
    }
  }

  /** A match lifecycle row with every setting. */
  lifecycle(m, event, extra = {}) {
    const slots = m.slots || [];
    const aiSeats = slots.map((s, i) => (!s.human && !s.closed ? { seat: i, team: m.teamOf?.[i] ?? Math.floor(i / Math.max(1, m.teamSize || 1)), difficulty: s.difficulty, personality: s.personality } : null)).filter(Boolean);
    const teams = Math.max(1, Math.ceil(slots.length / Math.max(1, m.teamSize || 1)));
    this.record('match_lifecycle', {
      ...this.matchCommon(m), event, mode: m.mode, map: m.map || 'random', map_size: m.mapSize, team_size: m.teamSize, teams,
      format: m.teamSize > 1 || teams === 2 ? `${m.teamSize || 1}v${m.teamSize || 1}` : `ffa${teams}`,
      humans: slots.filter((s) => s.human).length, ais: aiSeats.length, closed_seats: slots.filter((s) => s.closed).length,
      objective: m.objective, start_res: m.startRes, style: m.style, seed: m.seed, speed: m.speed, observer_fog: m.observerFog, tutorial: m.tutorial,
      fair_play: slots.find((s) => !s.human && !s.closed)?.fairPlay, public: m.public, wait_for_ready: m.waitForReady, ai_seats: aiSeats,
      sim_time_s: m.stats?.time, wall_s: m.created ? (this.now() - m.created) / 1000 : undefined, ...extra,
    });
  }

  // ---------------------------------------------------------------- clients
  /** The handshake: remember the client's build and platform for the rows of its matches. */
  hello(ctx, msg) {
    ctx.client = { build: clean(msg.build) || undefined, version: clean(msg.version) || undefined, platform: clean(msg.platform) || undefined };
  }
  /** Added to the hello reply: tells a client this server accepts its diagnostics. */
  helloReply() { return true; }

  /**
   * One client telemetry message {t:'telemetry', install, build, version, platform, rows:[{table, ...}]} or the
   * anonymous {t:'telemetry', optOut:true}. Returns the number of rows accepted (or a refusal reason string).
   */
  client(ws, msg, bytes = 0) {
    const ctx = ws.ctx || (ws.ctx = {});
    const t = this.now();
    if (msg.optOut === true) { if (!ctx.optOutCounted) { ctx.optOutCounted = true; this.minute.optouts++; } return 0; }
    // token bucket per connection
    const b = ctx.tmBucket ||= { tokens: LIMITS.clientBurst, at: t };
    b.tokens = Math.min(LIMITS.clientBurst, b.tokens + (t - b.at) / LIMITS.clientRefillMs); b.at = t;
    const rows = Array.isArray(msg.rows) ? msg.rows : [];
    const refuse = (why) => { this.minute.clientRefused += rows.length || 1; return why; };
    if (b.tokens < 1) return refuse('rate');
    b.tokens -= 1;
    if (bytes > LIMITS.clientMessageBytes) return refuse('size');
    if (!INSTALL.test(String(msg.install || ''))) return refuse('install');
    if (rows.length > LIMITS.clientRowsPerMessage) return refuse('rows');
    if (this.minute.clientRows + rows.length > LIMITS.clientRowsPerMinute) return refuse('busy');
    ctx.telemetryInstall = msg.install;
    const client = { build: clean(msg.build) || ctx.client?.build, version: clean(msg.version) || ctx.client?.version, platform: clean(msg.platform) || ctx.client?.platform };
    ctx.client = client;
    const m = ctx.match, seat = ctx.slot && !ctx.slot.spectator ? ctx.slot.civId : undefined;
    let n = 0;
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object' || !CLIENT_TABLES.includes(raw.table)) { this.minute.clientRefused++; continue; }
      const own = {};
      for (const [k, v] of Object.entries(raw)) if (k !== 'table' && !COMMON_NAMES.has(k)) own[k] = v;
      const at = Number(raw.event_time);
      const event = Number.isFinite(at) && at > t - 24 * 3600_000 && at < t + 300_000 ? at : t;
      this.record(raw.table, { ...own, event_time: event, install_id: msg.install, client_build: client.build, client_version: client.version, platform: client.platform,
        match_id: m?.id, ruleset: m?.ruleset, seat }, true);
      n++;
    }
    this.minute.clientRows += n;
    return n;
  }

  // ---------------------------------------------------------------- instance minute
  sampleInstance() {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(this.cpu), at = performance.now(), wall = Math.max(1, at - this.cpuAt);
    this.cpu = process.cpuUsage(); this.cpuAt = at;
    const cores = os.cpus().length || 1, cpuMs = (cpu.user + cpu.system) / 1000;
    const elu = performance.eventLoopUtilization(this.elu); this.elu = performance.eventLoopUtilization();
    const lag = this.lag; const ms = (n) => (Number.isFinite(n) ? n / 1e6 : null);
    const st = this.manager?.stats?.() || {}, ms2 = this.manager ? [...this.manager.matches.values()] : [];
    const mi = this.minute; this.minute = this.freshMinute();
    const gc = this.gc || { count: 0, ms: 0 }; this.gc = { count: 0, ms: 0 };
    this.record('server_instance_minute', {
      uptime_s: process.uptime(), cpu_cores: cores, cpu_util: cpuMs / (wall * cores), cpu_ms: cpuMs,
      rss_mb: mem.rss / 1048576, heap_used_mb: mem.heapUsed / 1048576, external_mb: (mem.external + (mem.arrayBuffers || 0)) / 1048576, free_mb: os.freemem() / 1048576,
      loop_lag_p50_ms: ms(lag?.percentile(50)), loop_lag_p99_ms: ms(lag?.percentile(99)), loop_lag_max_ms: ms(lag?.max), loop_utilization: elu.utilization,
      gc_count: gc.count, gc_ms_total: gc.ms, load_cores: st.load?.cores,
      matches: st.matches, matches_running: st.running, matches_parked: st.parked, matches_lobby: ms2.filter((m) => m.status === 'lobby').length,
      players: st.players, spectators: st.spectators, connections: this.connections(),
      rows_buffered: this.buffer.length, rows_sent: mi.sent, rows_dropped: mi.dropped, rows_rejected: mi.rejected, flush_failures: mi.failures, bytes_sent: mi.bytes,
      client_rows: mi.clientRows, client_rows_refused: mi.clientRefused, client_optouts: mi.optouts,
    });
    lag?.reset();
  }

  /** Options the match workers get (workerData.telemetry): null when off. */
  workerOptions() { return { minuteMs: Math.max(5000, +this.env.TELEMETRY_MINUTE_MS || 60_000) }; }
}

/** The process telemetry: a Telemetry when TELEMETRY_DATASET is set, otherwise a no-op. */
export function createTelemetry(opts = {}) {
  const env = opts.env || process.env;
  if (!env.TELEMETRY_DATASET || env.TELEMETRY_DISABLED === '1') return new NullTelemetry();
  return new Telemetry({ ...opts, env });
}
