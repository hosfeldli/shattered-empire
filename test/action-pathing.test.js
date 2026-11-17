// Workstream C (2026-11-16): group pathfinding, bridges, base compounds, unit speed, stances,
// attack-move, rally actions and the reachability query. Scenarios are painted on a controlled patch
// of terrain (test/action-pathing-scenarios.mjs) so they do not depend on map generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 104;
globalThis.SE_WRAP = false;
const S = await import('./action-pathing-scenarios.mjs');
const sim = await S.loadSim();
const { GROUND_PACE } = sim.orders;
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds / sim.DT); i++) { g.tick(); g.outbox.length = 0; } };
const report = (m) => `arrived ${m.arrived}/${m.units}, ratio ${m.ratioMean.toFixed(2)}/${m.ratioMax.toFixed(2)}, spread ${m.spread.toFixed(1)}s, stuck: ${m.stuckTypes.join(' ')}`;

test('a dozen tanks cross a river by a dirt-road bridge, together and without getting stuck', () => {
  const g = S.makeGame(sim);
  const s = S.riverBridgeScenario(sim, g, { roadType: 1 });
  assert.equal(s.units.length, 12);
  const m = S.runOrder(sim, g, s.units, s.to, { seconds: 180 });
  assert.ok(!m.reply.error, m.reply.error);
  assert.equal(m.stuck, 0, report(m));
  assert.ok(m.ratioMean < 1.25 && m.ratioMax < 1.4, report(m));
});

test('tanks never take a bridge sideways: coarse routes enter and leave river tiles along the road', () => {
  const g = S.makeGame(sim);
  const s = S.riverBridgeScenario(sim, g, { roadType: 1, count: 1 });
  const def = sim.ACTION_UNITS.tank, nav = g.nav;
  const coarse = nav.strategic(sim.tileAt(s.from.x, s.from.z), sim.tileAt(s.to.x, s.to.z), def, false, true);
  assert.ok(coarse, 'a route over the bridge exists');
  for (let i = 1; i < coarse.length; i++) {
    const a = coarse[i - 1], b = coarse[i];
    if (g.world.river[a] || g.world.river[b]) assert.ok(g.roads.usable(a, b), `step ${a}->${b} follows the road`);
  }
  assert.ok(coarse.some((t) => g.world.river[t]), 'the route crosses the river');
});

test('large units leave and re-enter a developed friendly base', () => {
  const g = S.makeGame(sim);
  const site = S.developBase(sim, g);
  const facilities = [...g.buildings.values()].filter((b) => b.site === site.id && b.slot);
  assert.ok(facilities.length >= 3);
  const units = [];
  for (let i = 0; i < 8; i++) { const u = g.spawn(g.civs[0], i % 2 ? 'tank' : 'sp_artillery', facilities[i % facilities.length]); if (u) units.push(u); }
  assert.ok(units.length >= 6);
  const out = g.nav.nearest({ x: site.x + 7.5, z: site.z + 1.2 }, sim.ACTION_UNITS.tank, 3) || g.nav.nearest({ x: site.x - 7.5, z: site.z }, sim.ACTION_UNITS.tank, 3);
  const leave = S.runOrder(sim, g, units, out, { seconds: 120 });
  assert.equal(leave.stuck, 0, 'leaving: ' + report(leave));
  const enter = S.runOrder(sim, g, units, { x: site.x + .9, z: site.z + .9 }, { seconds: 120, arriveRadius: 3 });
  assert.equal(enter.stuck, 0, 'entering: ' + report(enter));
});

test('a mixed group routes around a lake and mountain spur on one sensible line', () => {
  const g = S.makeGame(sim);
  const s = S.lakeScenario(sim, g);
  const m = S.runOrder(sim, g, s.units, s.to, { seconds: 200 });
  assert.equal(m.stuck, 0, report(m));
  assert.ok(m.ratioMax < 1.35, report(m));
  assert.ok(m.spread < 40, report(m));
});

test('each unit type keeps one cruising speed (30% slower overall); terrain only nudges it', () => {
  const g = S.makeGame(sim);
  const s = S.terrainStrips(sim, g);
  for (const type of ['tank', 'rifle_squad', 'armored_car']) {
    const base = sim.ACTION_UNITS[type].speed * GROUND_PACE, cruise = {};
    for (const name of ['grass', 'plains', 'road']) {
      const [u] = S.placeBlock(sim, g, 0, [type], s.start(name));
      const m = S.runOrder(sim, g, [u], s.end(name), { seconds: 90, arriveRadius: .5 });
      assert.equal(m.stuck, 0, `${type} on ${name}`);
      const samples = m.speedSamples.get(u.id).slice(15, -15);
      cruise[name] = samples.reduce((a, b) => a + b, 0) / samples.length / base;
      g.units.delete(u.id); S.reindex(sim, g);
    }
    assert.ok(Math.abs(cruise.grass - 1) < .04 && Math.abs(cruise.plains - 1) < .04, `${type} open ground ${JSON.stringify(cruise)}`);
    assert.ok(cruise.road > 1.05 && cruise.road < 1.25, `${type} road ${JSON.stringify(cruise)}`);
  }
});

test('a mixed group moves at its slowest member\'s pace and arrives together', () => {
  const g = S.makeGame(sim);
  const area = S.paintArea(sim, g, 70, 6, 20, 40);
  const types = ['rifle_squad', 'rifle_squad', 'rifle_squad', 'tank', 'tank', 'armored_car', 'scout_buggy', 'mortar_team', 'sp_artillery', 'anti_armor'];
  const units = S.placeBlock(sim, g, 0, types, area.point(10, 6));
  const m = S.runOrder(sim, g, units, area.point(10, 30), { seconds: 150 });
  assert.equal(m.stuck, 0, report(m));
  assert.ok(m.spread < 25, report(m));
  const slowest = Math.min(...types.map((t) => sim.ACTION_UNITS[t].speed)) * GROUND_PACE;
  const buggy = units.find((u) => u.type === 'scout_buggy');
  const samples = m.speedSamples.get(buggy.id).slice(40, -40);
  const median = samples.sort((a, b) => a - b)[samples.length >> 1];
  assert.ok(median < slowest * 1.15, `buggy cruises with the convoy (${median.toFixed(3)} vs ${slowest.toFixed(3)})`);
});

function duel(stanceA, gap) {
  const g = S.makeGame(sim);
  const area = S.paintArea(sim, g, 70, 6, 20, 30);
  const [own] = S.placeBlock(sim, g, 0, ['tank'], area.point(10, 8));
  const range = sim.ACTION_UNITS.tank.range;
  const [foe] = S.placeBlock(sim, g, 1, ['rifle_squad'], { x: own.x + range + gap, z: own.z });
  assert.ok(!g.command(1, { c: 'stance', units: [foe.id], stance: 'holdFire' }).error);
  assert.ok(!g.command(0, { c: 'stance', units: [own.id], stance: stanceA }).error);
  return { g, own, foe, start: { x: own.x, z: own.z }, area };
}

test('stances: aggressive pursues on a leash and returns, defensive holds ground, hold fire never fires', () => {
  assert.match(S.makeGame(sim).command(0, { c: 'stance', units: [], stance: 'berserk' }).error, /aggressive/);
  {
    const { g, own, foe, start } = duel('aggressive', 1.6);
    const before = foe.hp;
    run(g, 20);
    assert.ok(foe.hp < before || !g.units.has(foe.id), 'the aggressive tank closed in and fired');
    run(g, 25);
    assert.ok(sim.distance(own, start) < 1.4, `returned to its post (${sim.distance(own, start).toFixed(2)})`);
  }
  {
    const { g, own, foe, start } = duel('defensive', 1.6);
    run(g, 12);
    assert.ok(sim.distance(own, start) < .2, 'a defensive tank does not chase');
    assert.equal(foe.hp, foe.maxHp);
  }
  {
    const { g, own, foe } = duel('holdFire', -1.2);
    run(g, 10);
    assert.equal(foe.hp, foe.maxHp, 'hold fire: no shots at a target in range');
    assert.equal(own.target, 0);
    // an explicit attack order still fires
    g.command(0, { c: 'attack', units: [own.id], target: foe.id });
    run(g, 8);
    assert.ok(foe.hp < foe.maxHp || !g.units.has(foe.id));
  }
});

test('the stance shows in the unit snapshot (index 10) and hold position in flag 2048', () => {
  const { g, own } = duel('aggressive', 3);
  const row = () => g.unitSnapshot(g.civs[0], { god: false }).units.find((r) => r[0] === own.id);
  assert.equal(row()[10], 0);
  g.command(0, { c: 'stance', units: [own.id], stance: 'holdFire' });
  assert.equal(row()[10], 2);
  g.command(0, { c: 'hold', units: [own.id] });
  assert.ok(row()[8] & 2048);
  const enemyView = g.unitSnapshot(g.civs[1], { god: true }).units.find((r) => r[0] === own.id);
  assert.equal(enemyView[10], 2, 'stance is visible to everyone (hover card)');
});

test('attack-move engages enemies met on the way, then continues to the destination', () => {
  const g = S.makeGame(sim);
  const area = S.paintArea(sim, g, 70, 6, 20, 36);
  const [own] = S.placeBlock(sim, g, 0, ['tank'], area.point(10, 4));
  const range = sim.ACTION_UNITS.tank.range;
  const [foe] = S.placeBlock(sim, g, 1, ['rifle_squad'], { x: area.point(10, 14).x, z: area.point(10, 14).z + range + 1.4 });
  g.command(1, { c: 'stance', units: [foe.id], stance: 'holdFire' });
  const dest = area.point(10, 28);
  assert.ok(!g.command(0, { c: 'move', units: [own.id], point: dest, attackMove: true }).error);
  let engaged = false;
  for (let i = 0; i < 1500 && (own.goal || !engaged); i++) { g.tick(); g.outbox.length = 0; if (foe.hp < foe.maxHp || !g.units.has(foe.id)) engaged = true; }
  assert.ok(engaged, 'the enemy beside the route was engaged');
  assert.ok(sim.distance(own, dest) < 1.2, `continued to the destination (${sim.distance(own, dest).toFixed(2)})`);
});

test('rally points carry an action: move or attack-move', () => {
  const g = S.makeGame(sim);
  const site = S.developBase(sim, g);
  const barracks = [...g.buildings.values()].find((b) => b.site === site.id && sim.bases && b.type === 'barracks')
    || [...g.buildings.values()].find((b) => b.site === site.id && g.defs.BUILDINGS[b.type]?.trains);
  assert.ok(barracks, 'a production building');
  const p = { x: site.x + 5, z: site.z };
  assert.ok(!g.command(0, { c: 'rally', id: barracks.id, point: p, action: 'move' }).error);
  assert.equal(barracks.rallyMode, 'move');
  let u = g.spawn(g.civs[0], 'rifle_squad', barracks); g.reinforce(barracks, u);
  assert.equal(u.mode, 'move');
  g.command(0, { c: 'rally', id: barracks.id, point: p, attackMove: true });
  u = g.spawn(g.civs[0], 'rifle_squad', barracks); g.reinforce(barracks, u);
  assert.equal(u.mode, 'assault');
  const wire = g.econSnapshot(g.civs[0], { vis: g.civs[0].visible, god: false }).buildings.find((b) => b.id === barracks.id);
  assert.equal(wire.ra[2], 1);
});

test('reachability query: impassable water, cut-off ground and a bridge', () => {
  const g = S.makeGame(sim);
  const s = S.riverBridgeScenario(sim, g, { roadType: 1, count: 2 });
  const ask = (point, units = s.units) => g.command(0, { c: 'reach', units: units.map((u) => u.id), point }).reply.reach;
  assert.deepEqual(ask(s.to), { ok: true, all: true, reachable: 2, units: 2, reason: null });
  const river = s.area.point(-4, 5);   // open sea beside the painted patch
  assert.equal(ask(river).reason, 'impassable');
  // cut the bridge: the far bank becomes unreachable for vehicles
  for (const e of [...g.roads.edges.values()]) if (g.world.river[e.a] || g.world.river[e.b]) e.cond = 0;
  g.nav.invalidate();
  assert.equal(ask(s.to).reason, 'unreachable');
  assert.equal(g.command(0, { c: 'reach', units: [], point: river }).reply.reach.reason, 'impassable');
});
