// BLIGHT survival mode (objective 'horde', docs/gameplay-overhaul/HORDE_MODE.md): wave scaling, infection,
// determinism with save/restore mid-wave, the live-creature cap at high waves, the snapshot wire and the outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 104;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');
const { tileAt } = await import('../server/sim/actionNavigation.js');
const H = await import('../server/sim/hordeDefs.js');
const { PROFILE } = await import('../server/sim/horde.js');

const create = (extra = {}) => new ActionGame({ id: 'horde', seed: 7, style: 'pangaea', objective: 'horde', slots: [{ human: true }], hordePrep: 15, ...extra });
const run = (g, ticks, each) => { for (let i = 0; i < ticks && !g.over; i++) { g.tick(); g.outbox.length = 0; if (each?.(i) === false) break; } };
const creatures = (g) => [...g.units.values()].filter((u) => u.owner === g.horde.civ && u.type !== 'blight_hive');

test('scaling: budget, toughness and damage grow without bound; speed levels off; breathers shorten to a floor', () => {
  let last = { pts: 0, hp: 0, dmg: 0 };
  for (const w of [1, 2, 5, 10, 20, 50, 100, 200]) {
    const L = H.hordeLevel(w, 0), s = H.hordeScale(L), pts = H.wavePoints(L, 1);
    assert.ok(pts > last.pts && s.hp > last.hp && s.dmg > last.dmg, `wave ${w} must be stronger than the one before`);
    assert.ok(s.speed >= 1 && s.speed < 1.35, 'speed approaches +35%');
    last = { pts, hp: s.hp, dmg: s.dmg };
  }
  assert.equal(H.wavePoints(0, 1), 30);
  assert.ok(H.wavePoints(5, 4) > H.wavePoints(5, 1) * 2.5, 'co-op squads face larger waves');
  assert.ok(H.hordeLevel(5, 480) > H.hordeLevel(5, 0) + 1.9, 'elapsed time adds pressure (a level per 4 minutes)');
  assert.equal(H.breatherSeconds(1), H.HORDE.breather.first);
  assert.ok(H.breatherSeconds(10) < H.breatherSeconds(2));
  assert.equal(H.breatherSeconds(500), H.HORDE.breather.min);
  assert.equal(H.bossCount(4), 0); assert.equal(H.bossCount(5), 1); assert.equal(H.bossCount(30), 3);
});

test('rosters stay under the count limit at any wave and keep their strength as elites', () => {
  for (const w of [1, 10, 50, 200]) {
    const L = H.hordeLevel(w, 0), rand = (() => { let s = 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    const roster = H.planRoster(L, 2, rand);
    assert.ok(roster.length <= H.waveCountLimit(L), `wave ${w}: ${roster.length} creatures`);
    const budget = H.wavePoints(L, 2);
    assert.ok(H.rosterPoints(roster) >= budget * .9 && H.rosterPoints(roster) <= budget, `wave ${w}: strength kept (${H.rosterPoints(roster)} of ${budget})`);
    if (w >= 50) assert.ok(roster.some(([, e]) => e >= 2), 'late waves field elites');
    if (w === 1) assert.ok(roster.every(([t]) => t === 'blight_crawler'), 'wave 1 is all crawlers');
  }
});

test('a horde match: The Blight is the last civ, alone on its team, with hives far from the players', () => {
  const g = create({ slots: [{ human: true }, { human: false }] });
  const blight = g.civs[g.horde.civ];
  assert.equal(blight.horde, true);
  assert.equal(g.horde.civ, g.civs.length - 1);
  assert.deepEqual(g.civs.filter((c) => !c.horde).map((c) => c.team), [0, 0]);
  assert.ok(g.horde.hives.length >= 2);
  for (const v of g.horde.hives) for (const b of g.buildings.values()) assert.ok(Math.hypot(v.x - b.x, v.z - b.z) > 15, 'hive away from bases');
  assert.ok(g.units.get(g.horde.hives[0].id)?.type === 'blight_hive');
  const msg = g.snapshots(0, true).find(([id]) => id === 0)[1];
  assert.equal(msg.horde.w, 0);
  assert.equal(msg.horde.ph, 0);   // prep
  assert.equal(msg.horde.hv.length, g.horde.hives.length);
});

test('waves arrive, creatures hunt the base, and a cleared wave pays a supply drop', () => {
  const g = create();
  run(g, 160);
  assert.equal(g.horde.wave, 1);
  assert.equal(g.horde.phase, 'wave');
  run(g, 60);
  const live = creatures(g);
  assert.ok(live.length > 0);
  // they move toward the players
  const hq = [...g.buildings.values()].find((b) => b.type === 'town');
  const before = live.map((u) => Math.hypot(u.x - hq.x, u.z - hq.z));
  run(g, 50);
  const after = live.filter((u) => g.units.has(u.id)).map((u) => Math.hypot(u.x - hq.x, u.z - hq.z));
  assert.ok(after.reduce((a, b) => a + b, 0) / after.length < before.reduce((a, b) => a + b, 0) / before.length - 1, 'the wave closes in');
  // clear the wave by hand: the breather starts and every player is paid
  const res = g.civs[0].res.materials;
  for (const u of creatures(g)) { u.hp = 0; g.units.delete(u.id); }
  g.horde.groups.length = 0;
  run(g, 2);
  assert.equal(g.horde.phase, 'breather');
  assert.equal(g.horde.stats.cleared, 1);
  assert.ok(g.civs[0].res.materials >= res + H.HORDE.supply.materials);
});

test('infection: infantry the Blight kills rise again as husks', () => {
  const g = create({ hordePrep: 9999 });
  const hq = [...g.buildings.values()].find((b) => b.type === 'town');
  const squad = [...g.units.values()].find((u) => u.owner === 0 && u.type === 'rifle_squad');
  const h = g.horde;
  // a pack of crawlers right on top of the squad
  for (let i = 0; i < 14; i++) {
    const p = g.nav.nearest({ x: squad.x + Math.sin(i) * .5, z: squad.z + Math.cos(i) * .5 }, { move: 'infantry', radius: .1 }, 1.5);
    if (!p) continue;
    const u = { id: g.id_(), owner: h.civ, type: 'blight_crawler', isUnit: true, x: p.x, z: p.z, tile: tileAt(p.x, p.z), yaw: 0, vx: 0, vz: 0, speed: 0, hp: 400, maxHp: 400,
      radius: .1, mode: 'assault', goal: null, path: [], orders: [], lastCombat: -999, readyAt: 0, abilityReady: 0, abilityUntil: 0, blocked: 0, target: 0, kills: 0,
      altitude: 0, airBase: 0, grounded: false, formation: 0, stance: 'aggressive', elite: 0, wave: 0, dmg: 12, spd: 1, hNext: 0, hTarget: squad.id };
    g.units.set(u.id, u); g.movers.add(u);
  }
  let infected = 0, risen = 0;
  run(g, 400, () => {
    for (const e of g.events) if (e.k === 'horde' && e.i > (g.lastSeen || 0)) { if (e.o === 'infect') infected++; if (e.o === 'rise') risen++; }
    g.lastSeen = g.eventSeq;
    return !(risen >= 2 && !g.units.has(squad.id));
  });
  assert.ok(!g.units.has(squad.id), 'the squad was overrun');
  assert.ok(infected >= 1 && risen >= 2, `infected ${infected}, risen ${risen}`);
  assert.ok(creatures(g).some((u) => u.type === 'blight_husk'), 'husks stand among the horde');
  assert.equal(h.stats.risen, risen);
  void hq;
});

test('determinism: two runs match, and a save restored mid-wave continues identically', () => {
  const a = create(), b = create();
  run(a, 230); run(b, 230);
  assert.equal(a.horde.phase, 'wave');
  assert.equal(stateHash(a), stateHash(b));
  const restored = restoreGame(JSON.parse(JSON.stringify(serializeGame(a))));
  assert.equal(stateHash(restored), stateHash(a));
  assert.equal(restored.horde.wave, a.horde.wave);
  run(a, 150); run(restored, 150);
  assert.equal(stateHash(restored), stateHash(a), 'restored match diverged');
  assert.equal(restored.horde.stats.score, a.horde.stats.score);
});

test('performance: wave 50 holds the live cap, converts strength into elites and keeps the step cheap', () => {
  const g = create({ slots: [{ human: true }, { human: true }] });
  const h = g.horde;
  h.wave = 49; h.phaseEnd = g.time + .1;
  // a defended base keeps the fight going
  for (const hq of [...g.buildings.values()].filter((b) => b.type === 'town')) for (let i = 0; i < 25; i++) g.spawn(g.civs[hq.owner], 'tank', hq, 1.4 + (i % 8) * .3);
  PROFILE.on = true; PROFILE.creatures.length = 0; PROFILE.field.length = 0;
  let worst = 0;
  run(g, 450, () => { worst = Math.max(worst, creatures(g).length); for (const b of g.buildings.values()) if (b.type === 'town') b.hp = b.maxHp; });
  PROFILE.on = false;
  assert.equal(h.wave, 50);
  assert.ok(worst <= h.cap, `live ${worst} <= cap ${h.cap}`);
  assert.ok(worst >= h.cap * .6, `the wave fields a big army (${worst})`);
  assert.ok(creatures(g).some((u) => u.elite >= 2), 'elites');
  const sorted = [...PROFILE.creatures].sort((x, y) => x - y), median = sorted[Math.floor(sorted.length / 2)];
  // generous: CI and busy machines; a quiet machine measures ~0.5 ms
  assert.ok(median < 15, `creature step median ${median.toFixed(2)} ms`);
});

test('the run ends when every player has fallen, with a summary for the defeat screen', () => {
  const g = create();
  run(g, 200);
  const sent = [];
  g.civs[0].alive = false;
  g.checkVictory();
  assert.equal(g.over, true);
  assert.equal(g.winner.civ, g.horde.civ);
  assert.match(g.winner.how, /Overrun on wave \d+/);
  assert.equal(g.winner.horde.wave, g.horde.wave);
  assert.ok(Number.isFinite(g.winner.horde.score));
  void sent;
});

test('a creature type never appears in any training list', async () => {
  const { ACTION_BUILDINGS, ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
  for (const t of H.HORDE_TYPES) {
    assert.ok(ACTION_UNITS[t]?.auto, t);
    for (const b of Object.values(ACTION_BUILDINGS)) assert.ok(!(b.trains || []).includes(t), t);
  }
});

test('New Skirmish / Watch AI: the format sets the co-op squad (1v1 solo, 2v2 one ally, up to four)', async () => {
  const { MatchManager } = await import('../server/matches.js');
  const mm = new MatchManager({ info() {}, warn() {}, error() {} }, null);
  const seats = (mode, format) => mm.create({ mode, format, ruleset: 'action-v2', objective: 'horde', name: 'T' }).slots.map((s) => s.human ? 'H' : 'A').join('');
  assert.equal(seats('ai', '1v1'), 'H');
  assert.equal(seats('ai', '2v2'), 'HA');
  assert.equal(seats('ai', '4v4'), 'HAAA');
  assert.equal(seats('ai', 'ffa3'), 'HAA');
  assert.equal(seats('observe', '2v2'), 'AA');
  assert.equal(mm.create({ mode: 'ai', format: '1v1', ruleset: 'action-v2', objective: 'horde', name: 'T' }).objective, 'horde');
});
