// City Plan placement (backlog P1, Q3.B): cities grow as districts. Homes join homes near the
// centre with street frontage, industry gathers on freight roads away from housing, farms take
// the outer fertile ring. The scoring is authoritative (governors and AI share it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { districtScore } from '../server/sim/governor.js';
import { disk, dist } from '../server/sim/hex.js';

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
  const { hexLine } = await import('../server/sim/hex.js');
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
  void hexLine;
});
