// Telemetry schema v3 (Pass 7, docs/performance/IMPLEMENTATION_LOG.md): route failures by nav.lastFail with memo hits
// apart, routes by calling system, sub-timings, AI plan time per seat, GC by kind, bytes by message kind, the deflate
// sample; and the client's v3 columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { createProbe } = await import('../server/telemetry/probe.js');
const { shapeRow } = await import('../server/telemetry/index.js');
const { SCHEMA_VERSION } = await import('../server/telemetry/schema.js');
const { TICK_HZ } = await import('../server/sim/constants.js');

test('probe v3: memo hits are not failures, reasons from nav.lastFail, callers, sub-timings, AI seats, bytes by kind', () => {
  const g = new ActionGame({ id: 'tmv3', seed: 5, style: 'pangaea', slots: [{ human: false, difficulty: 'brutal' }, { human: false, difficulty: 'normal' }] });
  const rows = [];
  const probe = createProbe(g, { post: (m) => rows.push(...m.rows), minuteMs: 600_000 });
  for (let i = 0; i < 20 * TICK_HZ; i++) { g.tick(); g.outbox.length = 0; probe.interval(5, 1, false); if (i % 10 === 0) probe.second(); }
  // a route to an impossible goal fails with a reason, the same request again within the memo window is a memo hit
  const def = { move: 'infantry', radius: 0.12 }, u = [...g.units.values()].find((x) => !x.auto) || [...g.units.values()][0];
  const far = { x: -50, z: -50 };
  const r1 = g.nav.route(u, far, { ...def, ...u }), r2 = g.nav.route(u, far, { ...def, ...u });
  assert.equal(r1, null); assert.equal(r2, null);
  probe.span('snapshot.build', 2); probe.span('snapshot.build', 4);
  probe.out([[0, '{"t":"s","units":[]}', null, 'snap'], [0, '{"t":"note","text":"x"}'], [0, '{"t":"geo"}', 'geo'], [-2, '{"t":"s","econ":{}}'.padEnd(4096, ' '), null, 'econ']]);
  probe.minute(true); probe.flush();
  const mm = rows.find(([t]) => t === 'server_match_minute')[1];
  const fails = Object.fromEntries(mm.route_fail_reasons.map((r) => [r.type, r.count]));
  assert.ok(!('memo' in fails), 'memo hits are not failure reasons');
  assert.ok(mm.route_memo_hits >= 1, 'the repeated failed request is a memo hit');
  assert.equal(mm.route_failures, Object.values(fails).reduce((a, b) => a + b, 0));
  const outside = mm.routes_by_caller.find((c) => c.name === 'outside');
  assert.ok(outside && outside.calls >= 2 && outside.memo_hits >= 1, 'routes outside a tick are attributed to outside');
  assert.ok(mm.routes_by_caller.some((c) => c.name === 'navigation' || c.name === 'ai'), 'routes inside the tick carry their system');
  const build = mm.subsystems.find((s) => s.name === 'snapshot.build');
  assert.deepEqual([build.calls, build.total_ms, build.max_ms], [2, 6, 4]);
  assert.ok(mm.subsystems.some((s) => s.name === 'visibility.stamp') && mm.subsystems.some((s) => s.name === 'combat.projectiles'));
  assert.ok(mm.ai_seats.length === 2 && mm.ai_seats.every((s) => s.plans > 0 && s.total_ms >= 0), 'AI plan time per seat');
  const bytes = Object.fromEntries(mm.bytes_by_kind.map((r) => [r.type, r.count]));
  assert.equal(bytes.snap, 20); assert.equal(bytes.note, 23); assert.equal(bytes.geo, 11); assert.equal(bytes.econ, 4096);
  const shaped = shapeRow('server_match_minute', { schema_version: SCHEMA_VERSION, event_time: Date.now(), ingest_time: Date.now(), ...mm });
  for (const k of ['route_memo_hits', 'nav_counters', 'routes_by_caller', 'subsystems', 'ai_seats', 'gc_kinds', 'heap_old_space_mb', 'bytes_by_kind', 'msgs_by_kind'])
    assert.ok(k in shaped, `${k} is a column`);
  assert.equal(shaped.routes_by_caller[0].name, mm.routes_by_caller[0].name);
  probe.stop();
  assert.equal(g.tm.span.length, 2, 'the sim hook stays installed for the match');
});

test('schema v3: the new client columns are accepted', () => {
  const row = shapeRow('client_minute', { main_thread_ms_avg: 21, render_thread_ms_avg: 18, present_wait_ms_avg: 3, untracked_ms_avg: 12,
    loop_phases: [{ name: 'render', avg_ms: 9.5, max_ms: 30 }], draw_calls_avg: 1200, batches_avg: 900, setpass_calls_avg: 80, triangles_avg: 2e6,
    objects: [{ type: 'mesh', count: 974 }], post_match_s: 12.5 }, true);
  assert.equal(row.loop_phases[0].name, 'render'); assert.equal(row.objects[0].count, 974); assert.equal(row.post_match_s, 12.5); assert.equal(row.untracked_ms_avg, 12);
});
