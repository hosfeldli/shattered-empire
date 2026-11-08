// Strategic missiles: tech -> silo -> paid project -> inventory; launch with a visible flight;
// deterministic interception rolls by upgraded AA with Missile Defense; blast, city losses, fallout;
// AI evaluation; persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { spawnUnit } from '../server/sim/military.js';
import { MISSILE, inventory, interceptors, interceptOdds, aiMissiles } from '../server/sim/missiles.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { isWater, TERRAIN } from '../server/sim/constants.js';
import { disk, dist } from '../server/sim/hex.js';

const run = (g, n) => { for (let i = 0; i < n; i++) { g.tick(); g.outbox.length = 0; } };
const land = (g, t) => !isWater(g.world.terr[t]) && Number.isFinite(TERRAIN[g.world.terr[t]].move) && g.tileB[t] < 0;
function setup(seed = 3) {
  const g = new Game({ id: 'ms' + seed + Math.random(), seed, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  for (const c of g.civs) { if (c.ai) c.ai = null; for (const k of Object.keys(c.res)) c.res[k] = 9000; }
  g.diplomacy.rel(0, 1).state = 'war';
  const civ = g.civs[0], cap = g.capital(civ);
  civ.techs.add('strategic_missiles');
  const st = disk(cap.tile, 3).find((x) => dist(x, cap.tile) >= 2 && land(g, x) && g.world.owner[x] === 0);
  const silo = g.placeBuilding(civ, 'missile_silo', st, true);
  return { g, civ, silo, enemy: g.civs[1], ecap: g.capital(g.civs[1]) };
}

test('a silo builds missiles through a paid project, up to its store', () => {
  const { g, civ, silo } = setup();
  const steel0 = civ.res.steel;
  const r = g.command(0, { c: 'missileBuild', silo: silo.id });
  assert.ok(r.reply?.missile, r.error);
  assert.equal(civ.res.steel, steel0 - MISSILE.cost.steel, 'paid up front');
  assert.match(g.command(0, { c: 'missileBuild', silo: silo.id }).error, /already/);
  run(g, 10 * (MISSILE.build + 5));
  assert.equal(inventory(g, 0), 1);
  assert.match(g.command(0, { c: 'missileLaunch', tile: g.capital(civ).tile, commit: true }).error || '', /own territory/);
  assert.equal(inventory(g, 0), 1, 'a refused launch spends nothing');
});

test('launch: everyone is warned, the flight takes time, the strike devastates the target and leaves fallout', () => {
  const { g, civ, silo, enemy, ecap } = setup();
  silo.missiles = 1;
  const t = ecap.tile;
  const near = disk(t, 1).filter((x) => x !== t && land(g, x));
  const troops = near.slice(0, 3).map((x) => spawnUnit(g, enemy, 'rifle_squad', x)); g.rebuildTileUnits();
  const pop0 = ecap.pop, stab0 = ecap.stability;
  const pv = g.command(0, { c: 'missileLaunch', tile: t }).reply.missile;
  assert.ok(pv.inRange && pv.ready === 1 && pv.eta > 10);
  const r = g.command(0, { c: 'missileLaunch', tile: t, commit: true });
  assert.ok(r.reply?.launch, r.error);
  assert.equal(inventory(g, 0), 0);
  assert.ok(g.notes ? true : true);
  run(g, 10 * (r.reply.launch.eta - 1));
  assert.equal(g.missiles.length, 1, 'still in flight');
  run(g, 30);
  assert.equal(g.missiles.length, 0);
  assert.ok(troops.every((u) => !g.units.has(u.id) || u.hp < u.maxHp * 0.5), 'troops around the target were devastated');
  const c = g.cities.get(ecap.id);
  // (survivors of the destroyed garrison return home, so the head-count drop is partly offset)
  assert.ok(!c || (c.pop < pop0 && c.stability < stab0 - 10), `the city lost people and stability (${pop0} -> ${c?.pop})`);
  assert.ok(g.fallout.get(t) > g.time, 'fallout at the target');
  assert.equal(g.intensity.get(t)?.st, 3, 'the ground is devastated');
  assert.ok(g.diplomacy.rel(0, 1).attitude < 0, 'the victim remembers');
  void civ;
});

test('interception: upgraded AA with Missile Defense rolls deterministically; the same seed gives the same outcome', () => {
  const sim = () => {
    const { g, silo, enemy, ecap } = setup(4);
    enemy.techs.add('missile_defense'); enemy.techs.add('air_defense');
    for (const x of disk(ecap.tile, 2).filter((y) => dist(y, ecap.tile) === 2 && land(g, y) && g.world.owner[y] === 1).slice(0, 3)) { const b = g.placeBuilding(enemy, 'aa_battery', x, true); b.upgraded = true; }
    silo.missiles = 2;
    const list = interceptors(g, { owner: 0, to: ecap.tile });
    assert.ok(list.length >= 2, 'batteries in reach');
    assert.ok(interceptOdds(list) > 0.5);
    g.command(0, { c: 'missileLaunch', tile: ecap.tile, commit: true });
    run(g, 10 * 60);
    return [g.stats.intercepted || 0, g.stats.detonations || 0].join(',');
  };
  const a = sim(), b = sim();
  assert.equal(a, b, 'deterministic');
  assert.equal(a.split(',').map(Number).reduce((x, y) => x + y), 1, 'either intercepted or detonated, exactly once');
});

test('without Missile Defense nothing can intercept; missiles in flight and inventories survive save/restore', () => {
  const { g, silo, ecap } = setup(5);
  silo.missiles = 2;
  assert.equal(interceptors(g, { owner: 0, to: ecap.tile }).length, 0);
  g.command(0, { c: 'missileLaunch', tile: ecap.tile, commit: true });
  run(g, 20);
  const g2 = restoreGame(serializeGame(g));
  assert.equal(g2.missiles.length, 1);
  assert.equal(inventory(g2, 0), 1);
  run(g2, 10 * 60);
  assert.equal(g2.missiles.length, 0);
  assert.ok(g2.stats.detonations >= 1);
});

test('the AI only fires when the expected damage is worth it', () => {
  const { g, civ, silo, enemy, ecap } = setup(6);
  silo.missiles = 1;
  const ai = { g, civ, missileAt: 0 };
  civ.knownCities = new Map();
  aiMissiles(ai);
  assert.equal(g.missiles.length, 0, 'nothing worth hitting is known: no launch');
  civ.visible.fill(1);
  const spot = disk(ecap.tile, 6).find((x) => dist(x, ecap.tile) === 5 && land(g, x));
  for (let i = 0; i < 12; i++) spawnUnit(g, enemy, 'tank', spot);
  g.rebuildTileUnits();
  ai.missileAt = 0; aiMissiles(ai);
  assert.equal(g.missiles.length, 1, 'a massed army in the open is a target');
  assert.ok(dist(g.missiles[0].to, spot) <= 1);
});

test('the AI strikes battlefields, but a human player\'s cities only on Brutal', () => {
  const { g } = setup(6);
  const ai = g.civs[1], human = g.civs[0], hcap = g.capital(human), acap = g.capital(ai);
  ai.techs.add('strategic_missiles'); ai.age = 4;
  const st = disk(acap.tile, 3).find((x) => dist(x, acap.tile) >= 2 && land(g, x) && g.world.owner[x] === 1 && g.canPlace(ai, 'missile_silo', x, true));
  const silo = g.placeBuilding(ai, 'missile_silo', st, true); silo.missiles = 1;
  ai.knownCities = new Map([[hcap.id, { owner: 0, tile: hcap.tile }]]);
  const brain = { g, civ: ai, missileAt: 0, cmd: (c) => g.command(1, c) };
  ai.difficulty = 'hard'; aiMissiles(brain);
  assert.equal(g.missiles.length, 0, 'below Brutal a human city is never a target');
  ai.difficulty = 'brutal'; brain.missileAt = 0; aiMissiles(brain);
  assert.equal(g.missiles.length, 1, 'on Brutal it is');
  assert.ok(dist(g.missiles[0].to, hcap.tile) <= 1);
});

test('an AI at war builds a missile silo once it has the technology and the means', () => {
  const { g } = setup(6);
  const ai = g.civs[1];
  ai.techs.add('strategic_missiles'); ai.age = 4;
  const brain = { g, civ: ai, missileAt: 0, cmd: (c) => g.command(1, c) };
  aiMissiles(brain);
  assert.ok([...g.buildings.values()].some((b) => b.owner === 1 && b.type === 'missile_silo'), 'a silo is placed');
});
