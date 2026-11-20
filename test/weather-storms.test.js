// Storm systems (WEATHER_VISUALS.md "Storm systems"): rare scheduled squall lines and hurricanes that move
// deterministically, rebuildable on the client from the compact snapshot, and saved with the match.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { Weather, STORM_KIND, STORM_SCHEDULE, WX_STEP, systemProfile, systemTrackAt } = await import('../server/sim/weather.js');
const { W, N, T } = await import('../server/sim/constants.js');
const { ActionGame } = await import('../server/sim/actionGame.js');
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');

// a synthetic world: the western part sea, the rest grassland
const world = (seaShare) => {
  const terr = new Uint8Array(N), river = new Uint8Array(N), temp = new Float32Array(N).fill(.5);
  for (let i = 0; i < N; i++) terr[i] = i % W < W * seaShare ? T.DEEP : T.GRASS;
  return { terr, river, temp };
};
const MATCH = 45 * 60 / WX_STEP;   // a 45-minute match, in weather steps

test('storm systems are rare: one to three per 45-minute match, none in the opening, never two at once', () => {
  for (const sea of [0.1, 0.5]) {
    let total = 0, busy = 0, hurricanes = 0;
    const seeds = 24;
    for (let seed = 1; seed <= seeds; seed++) {
      const w = new Weather(world(sea), seed), seen = new Set();
      for (let k = 0; k < MATCH; k++) {
        w.step(WX_STEP);
        assert.ok(w.systems.length <= 1, 'at most one large system at a time');
        if (w.systems.length) busy++;
        for (const s of w.systems) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          if (s.kind === STORM_KIND.HURRICANE) hurricanes++;
          if (seen.size === 1) assert.ok(k >= STORM_SCHEDULE.first - 1, `no storm in the first ${STORM_SCHEDULE.first * WX_STEP / 60} minutes (step ${k})`);
        }
      }
      assert.ok(seen.size >= 1 && seen.size <= 3, `seed ${seed}: ${seen.size} systems`);
      total += seen.size;
    }
    const perMatch = total / seeds, busyShare = busy / (seeds * MATCH);
    assert.ok(perMatch >= 1.4 && perMatch <= 3, `about two systems a match (${perMatch.toFixed(2)})`);
    assert.ok(busyShare < 0.4, `most of the match is storm-free (${(busyShare * 100).toFixed(0)}% with a system)`);
    if (sea >= 0.5) assert.ok(hurricanes / total > 0.4, 'hurricanes are common on watery maps');
    else assert.ok(hurricanes / total < 0.4, 'squall lines dominate on dry maps');
  }
});

test('a system moves deterministically along its forecast track, intensifies and dies away', () => {
  const a = new Weather(world(0.5), 7), b = new Weather(world(0.5), 7);
  let forecast = null, at = 0, peak = 0, sy0 = null;
  for (let k = 0; k < MATCH; k++) {
    a.step(WX_STEP); b.step(WX_STEP);
    assert.deepEqual(JSON.stringify(a.systems), JSON.stringify(b.systems));
    const s = a.systems[0];
    if (!s) continue;
    if (!sy0) { sy0 = s.id; forecast = { ...s }; at = k; }
    if (s.id !== sy0) break;
    peak = Math.max(peak, s.s);
    if (k - at === 24) {
      // the snapshot's parameters predict where the system is two minutes later (no random steering)
      const p = systemTrackAt(forecast, 24 * WX_STEP);
      const P = Math.sqrt(3) * W;
      const dx = Math.abs(p.x - s.x), wrapped = Math.min(dx, Math.abs(dx - P));
      assert.ok(wrapped < 1e-6 && Math.abs(p.z - s.z) < 1e-6, `forecast ${p.x.toFixed(2)},${p.z.toFixed(2)} vs ${s.x.toFixed(2)},${s.z.toFixed(2)}`);
      const moved = Math.hypot(s.x - forecast.x, s.z - forecast.z);
      assert.ok(moved > 10, `it travels (${moved.toFixed(1)} world units in two minutes)`);
    }
  }
  assert.ok(sy0, 'a system arrived');
  assert.ok(peak > 0.45, `it intensifies (peak ${peak.toFixed(2)})`);
});

test('the field: a hurricane has a calm eye inside a grounding eyewall; a squall line storms along its leading edge', () => {
  const h = { kind: STORM_KIND.HURRICANE, r: 50, s: 0.9, h: 0 };
  assert.ok(systemProfile(h, 0, 0)[1] < 0.05, 'the eye is calm');
  assert.ok(systemProfile(h, 10, 0)[1] >= 0.5, 'the eyewall grounds aircraft');
  assert.ok(systemProfile(h, 40, 0)[1] < 0.3, 'the outer bands do not');
  assert.equal(systemProfile(h, 60, 0)[0], 0, 'nothing beyond the system');
  const q = { kind: STORM_KIND.SQUALL, r: 60, s: 0.9, h: 0 };   // moving east
  const lead = 0.2 * 60 - 0.08 * 60 - 0.07 * 60;                  // the convective line at the middle of the bow
  assert.ok(systemProfile(q, lead, 0)[1] >= 0.5, 'storms along the line');
  assert.ok(systemProfile(q, -30, 0)[2] > 0.1 && systemProfile(q, -30, 0)[1] < 0.1, 'trailing rain behind it, no storm');
  assert.ok(systemProfile(q, 20, 0)[0] < 0.05, 'clear ahead of the shelf cloud');
});

test('storm systems survive a save and restore mid-storm (and legacy saves schedule one)', () => {
  const w = new Weather(world(0.5), 3);
  w.spawnSystem(STORM_KIND.HURRICANE);
  for (let k = 0; k < 30; k++) w.step(WX_STEP);
  assert.equal(w.systems.length, 1);
  const r = new Weather(world(0.5), 99);
  r.load(JSON.parse(JSON.stringify(w.serialize())));
  for (let k = 0; k < 120; k++) { w.step(WX_STEP); r.step(WX_STEP); }
  assert.deepEqual(r.serialize(), w.serialize());
  // a save from before storm systems: none alive, the next one scheduled after the restore
  const old = w.serialize(); delete old.systems; delete old.nextSys; delete old.sysAt;
  const l = new Weather(world(0.5), 5); l.load(old);
  assert.equal(l.systems.length, 0);
  assert.ok(l.sysAt > l.ver, 'scheduled in the future');
});

test('a match restored during a storm evolves the same state', () => {
  const g = new ActionGame({ id: 'storm-save', seed: 23, style: 'pangaea', slots: [{ human: true }, { human: true }] });
  g.weather.spawnSystem(STORM_KIND.SQUALL);
  for (let i = 0; i < 120; i++) g.tick();
  assert.ok(g.weather.systems.length === 1 && g.weather.systems[0].s > 0, 'the squall is under way');
  const snap = g.weather.snapshot();
  assert.equal(snap.sys.length, 1);
  assert.ok(['id', 'k', 'x', 'z', 'h', 'v', 't', 'r', 's', 'sp', 'a', 'l', 'n'].every((k) => k in snap.sys[0]), 'the snapshot carries the system');
  const r = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  for (let i = 0; i < 150; i++) { g.tick(); r.tick(); }
  assert.equal(stateHash(r), stateHash(g));
  assert.deepEqual(r.weather.systems, g.weather.systems);
});
