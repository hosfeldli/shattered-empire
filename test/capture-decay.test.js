// W2 capture rules (requirement R7, directive Test G): capture takes 20 s (outposts 12 s), abandoned progress decays
// gradually (full to zero in 15 s), contested zones freeze, a rival claimant drains the old claim before building its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_UNITS, CAPTURE, actionDefinitions } = await import('../server/sim/actionDefinitions.js');
const { tileAt } = await import('../server/sim/actionNavigation.js');

const STEP = .2;   // the scheduler runs captureStep every 2 ticks with DT * 2
const create = () => new ActionGame({ id: 'capture-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
function reindex(g) { g.movers.clear(); for (const u of g.units.values()) if (!ACTION_UNITS[u.type].air) g.movers.add(u); }
function place(g, owner, type, point) {
  const u = g.spawn(g.civs[owner], type, point, .5);
  assert.ok(u, `spawn ${type}`);
  u.x = point.x; u.z = point.z; u.tile = tileAt(u.x, u.z); reindex(g); return u;
}
const remove = (g, ...units) => { for (const u of units) g.units.delete(u.id); reindex(g); };
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds / STEP); i++) { g.time += STEP; g.captureStep(STEP); } };
function setup() {
  const g = create(), s = g.sites.find((x) => x.slots && x.owner < 0);
  g.units.clear(); reindex(g);
  return { g, s };
}

test('capture constants are data-driven and published in the ruleset', () => {
  assert.deepEqual(CAPTURE, { base: 20, outpost: 12, decay: 15 });
  assert.deepEqual(actionDefinitions({}).RULESET.capture, CAPTURE);
  const g = create();
  for (const s of g.sites) assert.equal(s.captureTime, s.slots ? CAPTURE.base : CAPTURE.outpost, s.name);
});

test('progress rises steadily, never completes on entry, and a city ruin falls after ~20 s', () => {
  const { g, s } = setup();
  place(g, 0, 'rifle_squad', { x: s.x + .2, z: s.z });
  run(g, STEP);
  assert.ok(s.progress > 0 && s.progress <= STEP + 1e-9, 'one step of progress, not an instant capture');
  assert.equal(s.owner, -1);
  let t = STEP, last = s.progress;
  while (s.owner < 0 && t < 60) {
    run(g, STEP); t += STEP;
    if (s.owner < 0) { assert.ok(s.progress > last, 'monotonic while uncontested'); last = s.progress; }
  }
  assert.equal(s.owner, 0);
  assert.ok(Math.abs(t - CAPTURE.base) <= STEP + 1e-9, `captured after ${t.toFixed(1)} s`);
});

test('an outpost takes ~12 s', () => {
  const g = create(), o = g.sites.find((x) => !x.slots && x.owner < 0);
  g.units.clear(); reindex(g);
  place(g, 0, 'rifle_squad', { x: o.x + .1, z: o.z });
  let t = 0;
  while (o.owner < 0 && t < 60) { run(g, STEP); t += STEP; }
  assert.ok(Math.abs(t - CAPTURE.outpost) <= STEP + 1e-9, `captured after ${t.toFixed(1)} s`);
});

test('withdrawing decays progress gradually (no instant reset, no grace); returning continues from there', () => {
  const { g, s } = setup();
  const squad = place(g, 0, 'rifle_squad', { x: s.x + .2, z: s.z });
  run(g, 12);
  assert.ok(Math.abs(s.progress - 12) < 1e-6);
  remove(g, squad);
  let prev = s.progress;
  for (let i = 0; i < 5; i++) {
    run(g, STEP);
    assert.ok(s.progress > 0 && s.progress < prev, `R7: strictly decaying, step ${i}`);
    assert.equal(s.decaying, true);
    assert.equal(g.siteWire(s, g.civs[0], true).decaying, true, 'the client is told the capture is decaying');
    prev = s.progress;
  }
  // full progress decays to zero in CAPTURE.decay seconds: rate = captureTime / decay
  const rate = s.captureTime / CAPTURE.decay;
  assert.ok(Math.abs(s.progress - (12 - 1 * rate)) < 1e-6, `decayed at ${rate.toFixed(3)}/s`);
  assert.equal(s.by, 0, 'the claim survives while progress remains');
  const kept = s.progress;
  place(g, 0, 'rifle_squad', { x: s.x - .2, z: s.z });
  run(g, STEP);
  assert.ok(s.progress > kept, 'returning continues the existing progress');
  assert.equal(s.decaying, false);
  // abandoned for good: reaches zero within CAPTURE.decay seconds and clears the claim
  remove(g, ...[...g.units.values()]);
  run(g, CAPTURE.decay * s.progress / s.captureTime + STEP);
  assert.equal(s.progress, 0);
  assert.equal(s.by, -1);
  assert.equal(s.decaying, false);
  assert.equal(s.owner, -1);
});

test('full progress decays to zero in ~15 s', () => {
  const { g, s } = setup();
  s.by = 0; s.progress = s.captureTime - 1e-6;
  let t = 0;
  while (s.progress > 0 && t < 60) { run(g, STEP); t += STEP; }
  assert.ok(Math.abs(t - CAPTURE.decay) <= STEP + 1e-6, `decayed in ${t.toFixed(1)} s`);
});

test('a contested zone freezes progress: no gain and no decay', () => {
  const { g, s } = setup();
  place(g, 0, 'rifle_squad', { x: s.x + .2, z: s.z });
  run(g, 8);
  const saved = s.progress;
  const hostile = place(g, 1, 'rifle_squad', { x: s.x - .2, z: s.z });
  run(g, 10);
  assert.equal(s.contested, true);
  assert.equal(s.progress, saved);
  assert.equal(s.decaying, false);
  assert.equal(g.siteWire(s, g.civs[0], true).contested, true);
  remove(g, hostile);
  run(g, STEP);
  assert.ok(s.progress > saved, 'progress resumes once the zone is clear');
});

test('a rival claimant first drains the old claim to zero, then builds its own', () => {
  const { g, s } = setup();
  const mine = place(g, 0, 'rifle_squad', { x: s.x + .2, z: s.z });
  run(g, 10);
  remove(g, mine);
  place(g, 1, 'rifle_squad', { x: s.x - .2, z: s.z });
  run(g, STEP);
  assert.ok(s.progress > 0 && s.progress < 10, 'not reset instantly');
  assert.equal(s.by, 0, 'still civ 0\'s claim while it drains');
  assert.equal(s.decaying, true);
  const rate = s.captureTime / CAPTURE.decay;
  let t = STEP;
  while (s.by === 0 && t < 60) { run(g, STEP); t += STEP; }
  assert.ok(Math.abs(t - 10 / rate) <= 2 * STEP, `drained in ${t.toFixed(1)} s`);
  while (s.owner < 0 && t < 120) { run(g, STEP); t += STEP; }
  assert.equal(s.owner, 1);
  assert.ok(Math.abs(t - (10 / rate + CAPTURE.base)) <= 3 * STEP, `rival captured after ${t.toFixed(1)} s`);
});

test('ineligible units do not capture and headquarters sites are never captured here', () => {
  const { g, s } = setup();
  place(g, 0, 'tank', { x: s.x + .2, z: s.z });
  run(g, 30);
  assert.equal(s.progress, 0);
  assert.equal(s.owner, -1);
  const home = g.sites[1];
  place(g, 0, 'rifle_squad', { x: home.x + .2, z: home.z });
  run(g, 30);
  assert.equal(home.owner, 1);
  assert.equal(home.progress, 0);
});
