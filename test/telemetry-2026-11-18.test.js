// Telemetry (docs/TELEMETRY.md): row shape and version columns, bounded buffering and batching, client validation
// and rate limits, off when unconfigured, and the probe leaves the simulation bit-for-bit unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { createTelemetry, shapeRow, scrub, LIMITS, Telemetry } = await import('../server/telemetry/index.js');
const { TABLES, COMMON, CLIENT_TABLES, SCHEMA_VERSION, tableResource, fieldsOf } = await import('../server/telemetry/schema.js');
const { createProbe } = await import('../server/telemetry/probe.js');
const { ActionGame } = await import('../server/sim/actionGame.js');
const defs = await import('../server/sim/actionDefinitions.js');
const { centerOf } = await import('../server/sim/actionNavigation.js');
const { stateHash } = await import('../server/sim/persist.js');
const { MatchManager } = await import('../server/matches.js');

const ENV = { TELEMETRY_DATASET: 'se_telemetry', TELEMETRY_PROJECT: 'p', TELEMETRY_ACCESS_TOKEN: 't', APP_VERSION: 'abc123', TELEMETRY_ENV: 'dev' };
const quiet = { info() {}, warn() {}, error() {} };
// a fake BigQuery: records insertAll calls, answers with `reply`
function fakeFetch(reply = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const r = reply(url, body, calls.length);
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const fakeWs = (ctx = {}) => ({ ctx: { match: null, slot: null, ...ctx } });

test('telemetry is off when unconfigured: no-op object, nothing recorded, no worker options', async () => {
  const t = createTelemetry({ env: {} });
  assert.equal(t.enabled, false);
  t.record('server_match_minute', { ticks: 1 });
  t.lifecycle({ id: 'x', slots: [] }, 'created');
  assert.equal(t.client(fakeWs(), { rows: [] }), undefined);
  assert.equal(t.workerOptions(), null);
  assert.equal(t.helloReply(), undefined);
  await t.flush(); await t.stop();
  assert.equal(createTelemetry({ env: { ...ENV, TELEMETRY_DISABLED: '1' } }).enabled, false);
  assert.equal(createTelemetry({ env: ENV, log: quiet }).enabled, true);
  // the match manager without telemetry (tests, local dev) starts workers with telemetry: null
  const m = new MatchManager(quiet);
  assert.equal(m.telemetry, undefined);
  clearInterval(m.janitor);
});

test('schema: every table has the common version columns, partitioning, 180-day expiry and clustering', () => {
  for (const name of ['schema_version', 'event_time', 'ingest_time', 'env', 'server_version', 'client_build', 'client_version', 'platform', 'ruleset', 'ruleset_version', 'match_id', 'install_id', 'seat'])
    assert.ok(COMMON.some((f) => f.name === name), name);
  for (const name of Object.keys(TABLES)) {
    const r = tableResource('p', name);
    assert.equal(r.timePartitioning.field, 'event_time');
    assert.equal(+r.timePartitioning.expirationMs, 180 * 86400_000);
    assert.equal(r.clustering.fields[1], 'match_id');
    assert.ok(/_version$/.test(r.clustering.fields[0]));
    const names = fieldsOf(name).map((f) => f.name);
    assert.equal(new Set(names).size, names.length, `${name}: duplicate column`);
    // privacy: no name, email, ip or steam columns anywhere
    assert.ok(!names.some((n) => /(^|_)(name|email|ip|steam|address)($|_)/.test(n) && n !== 'target_name'), `${name}: personal column`);
  }
  assert.deepEqual(CLIENT_TABLES.sort(), ['client_errors', 'client_minute', 'client_session']);
});

test('rows are shaped to the schema with version fields; unknown columns dropped, types coerced', async () => {
  const fetch = fakeFetch();
  const t = new Telemetry({ env: ENV, log: quiet, fetchImpl: fetch });
  t.record('server_match_minute', { match_id: 'm1', ruleset: 'action-v2', ticks: '12.4', pace: 0.99999, bogus: 1, systems: [{ name: 'ai', calls: 3, total_ms: 1.5, nope: 1 }], event_time: 1_700_000_000_000 });
  t.record('no_such_table', { a: 1 });
  assert.equal(t.buffer.length, 1);
  const row = t.buffer[0].json;
  assert.equal(row.schema_version, SCHEMA_VERSION);
  assert.equal(row.server_version, 'abc123');
  assert.equal(row.env, 'dev');
  assert.equal(row.ruleset_version, 'v2');
  assert.equal(row.ticks, 12);
  assert.equal(row.bogus, undefined);
  assert.deepEqual(row.systems, [{ name: 'ai', calls: 3, total_ms: 1.5 }]);
  assert.equal(row.event_time, new Date(1_700_000_000_000).toISOString());
  assert.ok(row.instance_id && row.platform);
  await t.flush();
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].url, /projects\/p\/datasets\/se_telemetry\/tables\/server_match_minute\/insertAll$/);
  const sent = fetch.calls[0].body.rows[0];
  assert.ok(sent.insertId && sent.json.ingest_time);
  assert.equal(fetch.calls[0].body.skipInvalidRows, true);
  assert.equal(t.minute.sent, 1);
  assert.equal(shapeRow('battles', { sides: [{ seat: 1, units: [{ type: 'tank', count: 2 }] }] }).sides[0].units[0].count, 2);
});

test('buffer is bounded (oldest dropped), batches split per table, failures back off and drop', async () => {
  let fail = true;
  const fetch = fakeFetch(() => (fail ? { status: 503, body: { error: { message: 'down' } } } : { status: 200, body: {} }));
  let now = 1_000_000;
  const t = new Telemetry({ env: ENV, log: quiet, fetchImpl: fetch, now: () => now });
  t.flushing = Promise.resolve(); // hold early flushes while filling
  for (let i = 0; i < LIMITS.bufferRows + 50; i++) t.record('gameplay_events', { event: 'capture', value: i });
  assert.equal(t.buffer.length, LIMITS.bufferRows);
  assert.equal(t.minute.dropped, 50);
  assert.equal(t.buffer[0].json.value, 50, 'the oldest rows went first');
  t.flushing = null;
  t.buffer.splice(1200);
  await t.flush();
  assert.equal(fetch.calls.length, 1, 'a server error stops the flush; the rest waits for the back-off');
  assert.equal(t.buffer.length, 1200, 'nothing lost on the first failure');
  assert.ok(t.backoffUntil > now, 'backs off');
  const before = fetch.calls.length;
  await t.flush();
  assert.equal(fetch.calls.length, before, 'no request during back-off');
  now += LIMITS.maxBackoffSeconds * 1000 + 1;
  fail = false;
  await t.flush();
  assert.ok(fetch.calls.slice(before).every((c) => c.body.rows.length <= LIMITS.batchRows));
  assert.equal(t.buffer.length, 0);
  // rows of a failed request are retried once, then dropped
  fail = true; now += 1e9;
  t.record('gameplay_events', { event: 'x' });
  await t.flush(); now += 1e9; await t.flush();
  assert.equal(t.buffer.length, 0);
});

test('client rows: validated, server owns the common columns, size and rate limits, opt-out is an anonymous count', () => {
  const t = new Telemetry({ env: ENV, log: quiet, fetchImpl: fakeFetch() });
  const match = { id: 'abc', ruleset: 'action-v2' }, ws = fakeWs({ match, slot: { civId: 2 } });
  t.hello(ws.ctx, { build: 'deadbeef', version: '0.5.0', platform: 'Windows' });
  const install = 'a'.repeat(32);
  const ok = t.client(ws, { install, rows: [
    { table: 'client_minute', fps_avg: 58.2, frames: 3500, server_version: 'forged', match_id: 'forged', seat: 9, bogus: 1 },
    { table: 'server_match_minute', ticks: 1 },
    { table: 'client_errors', message: 'NullReference at C:\\Users\\liam\\game\\x.cs', count: 2 },
  ] }, 500);
  assert.equal(ok, 2);
  const [minute, err] = t.buffer.map((b) => b.json);
  assert.equal(minute.server_version, 'abc123');
  assert.equal(minute.match_id, 'abc');
  assert.equal(minute.seat, 2);
  assert.equal(minute.install_id, install);
  assert.equal(minute.client_build, 'deadbeef');
  assert.equal(minute.client_version, '0.5.0');
  assert.equal(minute.bogus, undefined);
  assert.ok(!err.message.includes('liam'), 'user path scrubbed');
  assert.equal(ws.ctx.telemetryInstall, install);
  // refusals
  assert.equal(t.client(fakeWs(), { install: 'nope', rows: [] }), 'install');
  assert.equal(t.client(fakeWs(), { install, rows: [] }, LIMITS.clientMessageBytes + 1), 'size');
  assert.equal(t.client(fakeWs(), { install, rows: new Array(LIMITS.clientRowsPerMessage + 1).fill({ table: 'client_minute' }) }), 'rows');
  const flood = fakeWs();
  const results = []; for (let i = 0; i < LIMITS.clientBurst + 3; i++) results.push(t.client(flood, { install, rows: [] }));
  assert.ok(results.filter((r) => r === 'rate').length >= 3, 'token bucket');
  // opt-out: counted once per connection, no id, no row
  const n = t.buffer.length, out = fakeWs();
  t.client(out, { optOut: true }); t.client(out, { optOut: true });
  assert.equal(t.minute.optouts, 1);
  assert.equal(t.buffer.length, n);
  assert.equal(out.ctx.telemetryInstall, undefined);
  assert.ok(scrub('/home/bob/x 10.0.0.1 a@b.com 76561198000000000').match(/<user>.*<ip>.*<email>.*<steamid>/));
});

test('lifecycle rows carry every setting and AI seat; worker rows get the match columns and seat install ids', () => {
  const t = new Telemetry({ env: ENV, log: quiet, fetchImpl: fakeFetch() });
  const ws = fakeWs(); ws.ctx.client = { build: 'b1', version: '0.5.1' }; ws.ctx.telemetryInstall = 'f'.repeat(32);
  const m = { id: 'm9', ruleset: 'action-v2', mode: 'ai', map: 'random', mapSize: 104, teamSize: 1, objective: 'domination', startRes: 'standard', seed: 5, created: Date.now() - 1000,
    slots: [{ human: true, ws }, { human: false, difficulty: 'hard', personality: 'warlord', fairPlay: true }] };
  t.lifecycle(m, 'created');
  t.fromWorker(m, [['player_minute', { seat: 0, units: 4 }], ['player_minute', { seat: 1, units: 5 }], ['client_minute', { fps_avg: 1 }],
    ['match_lifecycle', { event: 'ended', winner_seat: 1, end_reason: 'Military Domination', eliminations: [{ seat: 0, team: 0, time_s: 300 }] }]]);
  const rows = t.buffer.map((b) => [b.table, b.json]);
  assert.equal(rows.length, 4, 'a worker may not write client tables');
  const created = rows[0][1];
  assert.equal(created.event, 'created'); assert.equal(created.format, '1v1'); assert.equal(created.ais, 1); assert.equal(created.humans, 1);
  assert.deepEqual(created.ai_seats, [{ seat: 1, team: 1, difficulty: 'hard', personality: 'warlord' }]);
  assert.equal(created.client_version, '0.5.1');
  assert.equal(rows[1][1].install_id, 'f'.repeat(32));
  assert.equal(rows[2][1].install_id, undefined, 'AI seats have no install id');
  assert.equal(rows[3][1].event, 'ended'); assert.equal(rows[3][1].map_size, 104); assert.equal(rows[3][1].eliminations[0].time_s, 300);
});

test('the probe reads the match without changing it: identical state hash with telemetry on and off, and useful rows', () => {
  const opts = { id: 'tm', seed: 7, style: 'pangaea', slots: [{ human: false, difficulty: 'hard', personality: 'warlord' }, { human: false, difficulty: 'normal', personality: 'builder' }] };
  const a = new ActionGame(opts), b = new ActionGame(opts);
  const rows = [];
  const probe = createProbe(a, { post: (m) => rows.push(...m.rows), units: defs.ACTION_UNITS, buildings: defs.ACTION_BUILDINGS, centerOf, minuteMs: 1e12 });
  for (let i = 1; i <= 1800 && !a.over; i++) {
    a.tick(); b.tick();
    probe.interval(3, 1, false);
    if (i % 10 === 0) probe.second();
    if (i % 600 === 0) probe.minute();
  }
  probe.flush(); probe.stop();
  assert.equal(stateHash(a), stateHash(b));
  assert.equal(a.rng.getState?.() ?? 0, b.rng.getState?.() ?? 0);
  const by = (t) => rows.filter(([x]) => x === t).map(([, r]) => r);
  const mm = by('server_match_minute');
  assert.equal(mm.length, 3);
  assert.ok(mm[0].ticks > 0 && mm[0].systems.some((s) => s.name === 'navigation') && mm[0].heap_used_mb > 0);
  assert.ok(mm.some((r) => r.routes > 0), 'route timings');
  assert.equal(by('player_minute').length, 6);
  assert.ok(by('ai_decisions').some((r) => r.kind === 'objective' && r.state), 'AI objective changes');
  assert.ok(by('gameplay_events').some((r) => r.event === 'building_built'));
  for (const [table, row] of rows) assert.ok(TABLES[table] && shapeRow(table, row), table);
});
