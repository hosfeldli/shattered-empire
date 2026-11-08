// City Plan placement (backlog P1, Q3.B): cities grow as districts. Homes join homes near the
// centre with street frontage, industry gathers on freight roads away from housing, farms take
// the outer fertile ring. The scoring is authoritative (governors and AI share it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { districtScore } from '../server/sim/governor.js';
import { disk, dist, hexLine } from '../server/sim/hex.js';

const setup = () => {
  const g = new Game({ id: 'plan' + Math.random(), seed: 7, slots: [{ human: true }, { human: true }], rebels: false, ruleset: WORKS_RULESET });
  const civ = g.civs[0], city = [...g.cities.values()].find((c) => c.owner === 0);
  for (const k of Object.keys(civ.res)) civ.res[k] = 1e5;
  return { g, civ, city };
};

test('homes prefer joining existing homes; industry avoids them', () => {
  const { g, civ, city } = setup();
  const ring = disk(city.tile, 2).filter((t) => t !== city.tile && g.canPlace(civ, 'house', t, true));
  const home = g.makeBuilding(civ, 'house', ring[0], true);
  const near = ring.find((t) => t !== home.tile && dist(t, home.tile) === 1 && dist(t, city.tile) === dist(home.tile, city.tile));
  const far = ring.find((t) => dist(t, home.tile) >= 3 && dist(t, city.tile) === dist(home.tile, city.tile));
  if (near == null || far == null) return;      // map without a suitable pair at this seed
  assert.ok(districtScore(g, civ, city, 'house', near) > districtScore(g, civ, city, 'house', far), 'a home beside a home scores higher');
  assert.ok(districtScore(g, civ, city, 'steel_mill', near) < districtScore(g, civ, city, 'steel_mill', far), 'heavy industry keeps away from homes');
});

test('districts settle at their ring: homes near the centre, farms on the outer ring', () => {
  const { g, civ, city } = setup();
  const inner = disk(city.tile, 1).find((t) => t !== city.tile);
  const outer = disk(city.tile, 3).find((t) => dist(t, city.tile) === 3);
  assert.ok(districtScore(g, civ, city, 'house', inner) > districtScore(g, civ, city, 'house', outer));
  assert.ok(districtScore(g, civ, city, 'farm', outer) > districtScore(g, civ, city, 'farm', inner));
});

test('a drawn road keeps the drawn stroke instead of an optimal shortcut', async () => {
  const { followStroke } = await import('../server/sim/path.js');
  const { g, civ, city } = setup();
  civ.techs.add('civil_engineering');
  const ring = disk(city.tile, 3).filter((t) => dist(t, city.tile) === 3 && g.world.owner[t] === 0);
  if (ring.length < 4) return;
  const clear = (a, b) => { const line = hexLine(a, b); for (let i = 1; i < line.length; i++) { const why = g.roads.validateSegment(g, civ, line[i - 1], line[i], 1); if (why && why !== 'already built') return false; } return true; };
  let stroke = null;
  for (const v of disk(city.tile, 2).filter((t) => dist(t, city.tile) === 2)) for (const e of ring) if (!stroke && dist(v, e) >= 2 && clear(city.tile, v) && clear(v, e)) stroke = [city.tile, v, e];
  if (!stroke) return;
  const route = followStroke(g, civ, stroke, 1);
  assert.ok(route.includes(stroke[1]), 'the hex the player drew through is kept');
  const via = [stroke[1]];
  assert.equal(route[0], city.tile);
  // jitter: drawing back over a hex removes the loop instead of keeping a dead end
  const jitter = followStroke(g, civ, [city.tile, via[0], city.tile, via[0], ring[0]], 1);
  assert.equal(new Set(jitter).size, jitter.length, 'no hex is visited twice');
});

test('a curved right-drag deploys along the drawn curve, not its chord', async () => {
  const { planDeployment } = await import('../server/sim/deploy.js');
  const Wd = 40, Hd = 30;
  const env = { W: Wd, H: Hd, wrap: false, passable: () => true, capacity: () => 4 };
  const at = (q, r) => r * Wd + q;
  const path = [at(5, 10), at(10, 5), at(15, 10)];         // an arc bowing north
  const units = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, tile: at(10, 20), role: 'line' }));
  const curved = planDeployment(env, units, [path[0], path[2]], { mode: 'line', path });
  const straight = planDeployment(env, units, [path[0], path[2]], { mode: 'line' });
  const rows = (plan) => [...plan.slots.values()].map((t) => Math.floor(t / Wd));
  assert.ok(Math.min(...rows(curved)) < 9, 'some slots lie up the arc');
  assert.ok(rows(straight).every((r) => r === 10), 'a straight line stays on its row');
});

test('Guide Growth: a player plan steers the mayor to build its kind in the marked area, then reports', async () => {
  const { governorStep, GROWTH_RADIUS } = await import('../server/sim/governor.js');
  const { g, civ, city } = setup();
  civ.res.materials = 5000; civ.res.food = 5000; civ.res.credits = 5000;
  city.pop = 120; city.housing = 60;
  const site = disk(city.tile, 2).find((t) => dist(t, city.tile) === 2 && g.world.owner[t] === 0 && g.canPlace(civ, 'house', t, true));
  assert.equal(g.command(0, { c: 'cityGrowth', city: city.id, kind: 'housing', tile: site })?.error, undefined);
  assert.equal(g.command(0, { c: 'cityGrowth', city: city.id, kind: 'castles', tile: site }).error, 'choose housing, industry or farming');
  assert.match(g.command(0, { c: 'cityGrowth', city: city.id, kind: 'housing', tile: city.tile + 40 * 128 }).error || '', /reach|explored|borders/);
  for (let i = 0; i < 40; i++) { city.governor.cooldown = 0; city.governor.queue = []; governorStep(g, 1); }
  const homes = [...g.buildings.values()].filter((b) => b.owner === 0 && b.type === 'house' && dist(b.tile, site) <= GROWTH_RADIUS);
  assert.ok(homes.length >= 1, 'homes go up in the planned area');
  const [[, snap]] = g.snapshots(0, true);
  const mine = snap.cities.find((c) => c.id === city.id);
  assert.ok(!city.plan || (mine.gz && mine.gz[0] === 'housing'), 'the plan is visible to its owner');
  assert.equal(g.command(0, { c: 'cityGrowth', city: city.id, clear: true })?.error, undefined);
});

test('Opportunity Director: visible, actionable, at most two, and quiet once dismissed', async () => {
  const { opportunityStep } = await import('../server/sim/opportunities.js');
  const { g, civ, city } = setup();
  civ.researching = null;
  city.pop = 100; city.housing = 100;
  opportunityStep(g);
  assert.ok(civ.opps.length >= 1 && civ.opps.length <= 2);
  assert.ok(civ.opps.every((o) => o.actions.length >= 1 && o.title));
  const key = civ.opps[0].key;
  g.command(0, { c: 'oppQuiet', key });
  opportunityStep(g);
  assert.ok(!civ.opps.some((o) => o.key === key), 'a dismissed suggestion stays quiet');
  // enemy troops it cannot see never produce a threat suggestion
  const { spawnGroup } = await import('../server/sim/sandbox.js');
  g.diplomacy.rel(0, 1).state = 'war';
  const near = disk(city.tile, 6).find((t) => dist(t, city.tile) === 6 && g.world.owner[t] !== 0);
  spawnGroup(g, 1, 'rifle_squad', near, 8); g.rebuildTileUnits();
  civ.visible.fill(0);
  opportunityStep(g);
  assert.ok(!civ.opps.some((o) => o.k === 'threat'), 'fog of war is respected');
});
