import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { serializeGame, restoreGame, stateHash } from '../server/sim/persist.js';
import { NATIVE_RULESET, LEGACY_RULESET, TEMPO, movementRate, REMOVED_COMMANDS } from '../server/sim/rulesets.js';
import { BUILDINGS, TECHS, UNITS, T } from '../server/sim/constants.js';
import { growthRate } from '../server/sim/population.js';
import { fieldworksStep, fieldworksFor, commitTrench, planTrench, trenchCover } from '../server/sim/fieldworks.js';
import { idx, NB } from '../server/sim/hex.js';
import { rivalIntel } from '../server/sim/rivals.js';
const create = (ruleset = NATIVE_RULESET) => new Game({ id: 'rules', seed: 4, slots: [{ human: true }, { human: true }], rebels: false, ruleset });

test('rulesets survive saves; old saves remain legacy; unsupported rules fail explicitly', () => {
  const g = create();
  const saved = serializeGame(g);
  assert.equal(saved.ruleset, NATIVE_RULESET);
  const restored = restoreGame(saved);
  assert.equal(restored.ruleset, NATIVE_RULESET);
  assert.equal(stateHash(restored), stateHash(g));
  const old = serializeGame(create(LEGACY_RULESET)); delete old.ruleset;
  const legacy = restoreGame(old);
  assert.equal(legacy.ruleset, LEGACY_RULESET);
  assert.equal(legacy.civs[0].gov, 'council');
  assert.throws(() => create('future-rules'), /Unsupported/);
});

test('native trading and administration are unavailable at the authoritative boundary', () => {
  const g = create(), civ = g.civs[0];
  for (const c of REMOVED_COMMANDS) assert.match(g.command(0, { c })?.error || '', /not part/, c);
  g.diplomacy.rel(0, 1).state = 'peace';
  for (const action of ['trade', 'borders', 'alliance', 'tribute', 'demand', 'peace', 'payoff']) assert.ok(g.command(0, { c: 'diplo', to: 1, action }).error, action);
  assert.equal(g.command(0, { c: 'diplo', to: 1, action: 'war' }), null);
  assert.ok(g.hostile(0, 1));
  assert.equal(civ.gov, null); assert.equal(civ.policies.size, 0);
  for (const key of ['GOVS', 'POLICIES', 'FOCI', 'TAX', 'IMPORT_PRICE']) assert.equal(g.defs[key], undefined);
  const report = g.resourcesFor(civ);
  assert.ok(Object.values(report).every((r) => r.actions.every((a) => !['import', 'tax', 'diplomacy'].includes(a.a))));
});

test('dead civic technologies are excluded without mutating the legacy definitions', () => {
  const g = create();
  for (const tech of ['corporate_charter', 'federal_union']) {
    assert.equal(g.defs.TECHS[tech], undefined);
    assert.ok(TECHS[tech]);
    assert.ok(g.command(0, { c: 'research', tech }).error);
  }
  assert.ok(Object.values(g.defs.TECHS).every((t) => t.req.every((key) => g.defs.TECHS[key])));
  for (const age of [2, 3]) {
    const meaningful = Object.values(g.defs.TECHS).filter((t) => t.age === age).length;
    const original = Object.values(TECHS).filter((t) => t.age === age).length;
    assert.ok(g.defs.AGES[age + 1].techsNeeded / meaningful <= create(LEGACY_RULESET).defs.AGES[age + 1].techsNeeded / original);
  }
});

test('movement and growth use distinct authoritative tempo rates', () => {
  const g = create(), legacy = create(LEGACY_RULESET);
  assert.equal(movementRate(g, { move: 'infantry' }), TEMPO.infantryMovement);
  assert.equal(movementRate(g, { move: 'tracked' }), TEMPO.trackedMovement);
  assert.equal(movementRate(g, { move: 'wheeled' }), TEMPO.wheeledMovement);
  assert.equal(movementRate(g, { move: 'wheeled', logistics: true }), TEMPO.logisticsMovement);
  assert.equal(movementRate(g, { air: true }), TEMPO.aircraftMovement);
  assert.equal(movementRate(legacy, { move: 'infantry' }), 1);
  const city = [...g.cities.values()][0], civ = g.civs[0];
  const context = { starving: false, foodBalance: 1, foodStock: 500, services: false, enemyNear: false };
  const a = growthRate(g, civ, city, context);
  const b = growthRate(legacy, { ...civ, ruleset: LEGACY_RULESET }, city, context);
  assert.ok(Math.abs(a / b - .65) < 1e-9);
});

test('automatic city development has a small explicit command surface and rejects foreign cities', () => {
  const g = create(), city = [...g.cities.values()][0];
  assert.equal(g.command(0, { c: 'cityDevelopment', city: city.id, on: false, priority: 'agriculture' }), null);
  assert.equal(city.governor.enabled, false);
  assert.equal(city.development, 'agriculture');
  assert.ok(g.command(1, { c: 'cityDevelopment', city: city.id, on: true }).error);
  assert.ok(g.command(0, { c: 'cityDevelopment', city: city.id, priority: 'commerce' }).error);
});

function trenchFixture() {
  const g = create(); g.sandbox = true;
  const civ = g.civs[0]; civ.res.materials = 1000;
  const line = Array.from({ length: 12 }, (_, q) => idx(q, 15));
  for (const t of line) { g.world.terr[t] = T.GRASS; g.tileB[t] = -1; g.urban[t] = 0; g.world.owner[t] = 0; civ.supply[t] = 1; }
  const plan = planTrench(g, civ, [line[0], line.at(-1)]);
  assert.equal(plan.invalid, 0);
  commitTrench(g, civ, plan);
  return { g, civ, line };
}

test('trench excavation advances from endpoints, stalls on material shortages and resumes contiguously', () => {
  const { g, civ, line } = trenchFixture();
  fieldworksStep(g, 1);
  assert.deepEqual(line.filter((t) => g.fieldworks.get(t).progress > 0), [line[0], line.at(-1)]);
  // Finish endpoint segments; next fronts cannot skip unfunded neighbors.
  for (let i = 0; i < 20; i++) { g.time++; fieldworksStep(g, 1); }
  civ.res.materials = 0;
  for (let i = 0; i < 40; i++) { g.time++; fieldworksStep(g, 1); }
  const before = line.map((t) => g.fieldworks.get(t).progress);
  assert.ok(before.slice(3, -3).every((p) => p === 0));
  civ.res.materials = 1000;
  for (let i = 0; i < 150; i++) { g.time++; fieldworksStep(g, 1); }
  assert.ok(line.every((t) => g.fieldworks.get(t).progress === 1));
  const saved = serializeGame(g), restored = restoreGame(saved);
  assert.deepEqual([...restored.fieldworks.values()], [...g.fieldworks.values()]);
});

test('trench wire topology is continuous and reading a snapshot cannot change saved state', () => {
  const { g, civ, line } = trenchFixture();
  const before = stateHash(g), wire = fieldworksFor(g, civ, civ.visible);
  assert.equal(stateHash(g), before);
  for (const t of line.slice(1, -1)) {
    const bits = wire.find((r) => r[0] === t)[8];
    assert.ok(bits & 1); assert.ok(bits & (1 << 3));
    assert.equal(NB[t * 6], t + 1);
  }
  const f = g.fieldworks.get(line[0]); f.progress = .2;
  const unit = { tile: f.tile, type: 'rifle_squad', owner: 0 };
  const shallow = trenchCover(g, unit, null, true); f.progress = 1;
  assert.ok(trenchCover(g, unit, null, true) > shallow);
});

test('Rivals never exposes a hidden opponent plan or troop count', () => {
  const g = create(), civ = g.civs[0], other = g.civs[1];
  g.diplomacy.rel(0, 1).state = 'peace'; civ.visible.fill(0);
  other.posture = 'invade secret location';
  const intel = rivalIntel(g, civ, other);
  assert.equal(intel.posture, 'Focus unknown'); assert.equal(intel.focus, null);
  assert.ok(!JSON.stringify(intel).includes('secret')); assert.equal(intel.units, undefined);
});

test('Rivals does not identify an undetected stealth force through another civilization’s target order', () => {
  const g = new Game({ id: 'intel', seed: 4, slots: [{ human: true }, { human: true }, { human: true }], rebels: false, ruleset: NATIVE_RULESET });
  const viewer = g.civs[0]; viewer.visible.fill(1); viewer.detect.fill(0);
  g.diplomacy.rel(0, 1).state = 'peace'; g.diplomacy.rel(0, 2).state = 'peace';
  const stealth = Object.keys(UNITS).find((key) => UNITS[key].stealth);
  assert.ok(stealth);
  g.units.clear();
  g.units.set(9001, { id: 9001, owner: 1, tile: 10, type: 'rifle_squad', order: { kind: 'attack', target: { kind: 'unit', id: 9002 } } });
  g.units.set(9002, { id: 9002, owner: 2, tile: 11, type: stealth, order: { kind: 'idle' } });
  assert.equal(rivalIntel(g, viewer, g.civs[1]).focus, null);
  viewer.detect[11] = 1;
  assert.equal(rivalIntel(g, viewer, g.civs[1]).focus, 2);
});
