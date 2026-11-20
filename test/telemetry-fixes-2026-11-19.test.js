// Telemetry fixes (2026-11-19, docs/performance/TELEMETRY_ANALYSIS_2026-11-19.md section 5): cpu_cores from the cgroup
// quota instead of the host's processors, idle_s no longer counting loop overruns (overrun_s), AI plans per seat,
// resync / catch-up / congestion counts, spectator bytes, and battles counting base engineers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { createProbe } = await import('../server/telemetry/probe.js');
const { shapeRow } = await import('../server/telemetry/index.js');
const { cgroupCores, effectiveCores } = await import('../server/cpuCores.js');
const { TICK_HZ } = await import('../server/sim/constants.js');

test('cpu cores: the cgroup quota (v2 and v1), an override, else the host', () => {
  const files = (m) => (p) => m[p] ?? null;
  assert.equal(cgroupCores(files({ '/sys/fs/cgroup/cpu.max': '400000 100000' })), 4);
  assert.equal(cgroupCores(files({ '/sys/fs/cgroup/cpu.max': 'max 100000' })), null);
  assert.equal(cgroupCores(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' })), 2);
  assert.equal(cgroupCores(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' })), null);
  assert.equal(effectiveCores({ SE_CPU_CORES: '4' }, files({})), 4);
  assert.equal(effectiveCores({}, files({ '/sys/fs/cgroup/cpu.max': '100000 100000' })), 1);
  assert.ok(effectiveCores({}, files({})) >= 1);
});

test('probe: idle and overrun are separate, AI plans per seat, network counters', () => {
  const g = new ActionGame({ id: 'tmfix', seed: 3, style: 'pangaea', slots: [{ human: false, difficulty: 'brutal' }, { human: false, difficulty: 'normal' }] });
  const rows = [];
  const probe = createProbe(g, { post: (m) => rows.push(...m.rows), minuteMs: 600_000 });
  for (let i = 0; i < 30 * TICK_HZ; i++) {
    g.tick(); g.outbox.length = 0;
    probe.interval(5, 1, false);
    if (i % 10 === 0) probe.second();
  }
  for (let i = 0; i < 50; i++) probe.idle();
  probe.resync(); probe.catchUp(); probe.snapshot(2, 3);
  probe.out([[-2, 'x'.repeat(100)], [0, 'y'.repeat(40)]]);
  probe.minute(true); probe.flush();
  const mm = rows.find(([t]) => t === 'server_match_minute')[1];
  assert.equal(mm.idle_s, 5, 'idle is the skipped iterations only');
  assert.ok(mm.overrun_s >= 0, 'overrun is the rest of the wall time');
  assert.equal(mm.resyncs, 1); assert.equal(mm.catch_ups, 1); assert.equal(mm.congestion_skips, 3);
  assert.equal(mm.bytes_out_spectators, 100); assert.equal(mm.bytes_out, 140);
  const shaped = shapeRow('server_match_minute', { schema_version: 2, event_time: Date.now(), ingest_time: Date.now(), ...mm });
  for (const k of ['overrun_s', 'resyncs', 'catch_ups', 'congestion_skips', 'bytes_out_spectators']) assert.ok(k in shaped, `${k} is a column`);
  const players = rows.filter(([t]) => t === 'player_minute').map(([, r]) => r);
  const brutal = players.find((r) => r.seat === 0), normal = players.find((r) => r.seat === 1);
  // brutal plans every 2 s, normal every 3 s, over 30 s (the first at 3 s)
  assert.ok(brutal.ai_plans >= 11 && brutal.ai_plans <= 15, `brutal planned ${brutal.ai_plans} times`);
  assert.ok(normal.ai_plans >= 7 && normal.ai_plans <= 11, `normal planned ${normal.ai_plans} times`);
  assert.ok('ai_plans' in shapeRow('player_minute', brutal));
  probe.stop();
});

test('schema: the new client columns are accepted', () => {
  const row = shapeRow('client_minute', { in_match: false, game_pace: 2.4, snapshot_decode_ms_avg: 1.5, snapshot_decode_ms_max: 9, snapshot_apply_ms_avg: 0.7, snapshot_apply_ms_max: 3, keyed_resyncs: 1 }, true);
  assert.deepEqual(row, { in_match: false, game_pace: 2.4, snapshot_decode_ms_avg: 1.5, snapshot_decode_ms_max: 9, snapshot_apply_ms_avg: 0.7, snapshot_apply_ms_max: 3, keyed_resyncs: 1 });
  const inst = shapeRow('server_instance_minute', { cpu_cores: 4, cpu_cores_effective: 4, cpu_cores_host: 9, wire_bytes_out: 1234 });
  assert.deepEqual(inst, { cpu_cores: 4, cpu_cores_effective: 4, cpu_cores_host: 9, wire_bytes_out: 1234 });
});
