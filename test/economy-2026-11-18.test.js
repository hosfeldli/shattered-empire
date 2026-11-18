// 2026-11-18: strategic missiles cost 3x; units queue without funds and start when funds arrive (every producing
// building, train / batchTrain / legacy shapes); one upgrade per unit class (UPGRADES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS, ACTION_UPGRADES, MISSILE_PROJECT } = await import('../server/sim/actionDefinitions.js');
const { addFacility, openSlots, upgradeLineHolder } = await import('../server/sim/actionBases.js');
const { beginProduction, runProduction } = await import('../server/sim/actionProduction.js');
const { commandAck } = await import('../server/commandAck.js');

const create = () => new ActionGame({ id: 'econ-1118', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });

test('strategic missiles cost three times the old price; the missile battery vehicle is unchanged', () => {
  assert.deepEqual(MISSILE_PROJECT.cost, { materials: 1440, energy: 1140 });
  assert.deepEqual(ACTION_UNITS.missile_battery.cost, { materials: 310, energy: 185 });
  const g = create(), civ = g.civs[0], site = g.sites[0], slots = openSlots(g, site);
  civ.age = 2;
  addFacility(g, civ, site, 'advanced_lab', slots[0], { instant: true });
  const silo = addFacility(g, civ, site, 'missile_silo', slots[1], { instant: true });
  civ.res = { materials: 1439, energy: 5000 };
  assert.ok(g.command(0, { c: 'missileBuild', id: silo.id }).error, 'the old price no longer suffices');
  civ.res = { materials: 2000, energy: 1200 };
  assert.ok(!g.command(0, { c: 'missileBuild', id: silo.id }).error);
  assert.deepEqual(civ.res, { materials: 560, energy: 60 });
  assert.equal(g.defs.MISSILE.cost.materials, 1440, 'the client reads the price from defs');
});

test('every trainable unit queues with an empty stockpile and starts once funds arrive (train, batchTrain, legacy)', () => {
  const facilities = [...new Set(Object.values(ACTION_UNITS).filter((d) => !d.auto && d.facility).map((d) => d.facility))];
  for (const type of facilities) {
    assert.ok(ACTION_BUILDINGS[type]?.trains, type);
    const g = create(), civ = g.civs[0], site = g.sites[0];
    civ.age = 2;
    const [s0, s1] = openSlots(g, site);
    const a = addFacility(g, civ, site, type, s0, { instant: true }), b = addFacility(g, civ, site, type, s1, { instant: true });
    for (const unit of ACTION_BUILDINGS[type].trains) {
      if (ACTION_UNITS[unit].auto) continue;
      civ.res = { materials: 0, energy: 0 };
      const r1 = g.command(0, { c: 'train', ids: [a.id], type: unit, count: 1 });
      assert.ok(!r1.error, `${unit}: train refused with no funds: ${r1.error}`);
      assert.ok(commandAck(r1, 1).training.waiting.includes('resources'), `${unit}: advisory waiting`);
      const r2 = g.command(0, { c: 'batchTrain', buildings: [a.id, b.id], unit, count: 2 });
      assert.ok(!r2.error, `${unit}: batchTrain refused: ${r2.error}`);
      const r3 = g.command(0, { c: 'train', building: b.id, unit });
      assert.ok(!r3.error, `${unit}: legacy train refused: ${r3.error}`);
      beginProduction(); runProduction(g, civ, a, .3);
      assert.equal(a.queues.find((q) => q.unit === unit).state, 'resources');
      assert.equal(a.queues.find((q) => q.unit === unit).work, 0);
    }
    // funds arrive: work starts and the first items are delivered
    civ.res = { materials: 1e6, energy: 1e6 };
    const before = g.units.size;
    for (let i = 0; i < 2000 && g.units.size === before; i++) { beginProduction(); runProduction(g, civ, a, .3); g.movers.clear(); }
    assert.ok(g.units.size > before, `${type}: production resumed when funds arrived`);
  }
});

test('one upgrade per unit class: a taken line is refused, cancelling frees it, AI respects it, old saves keep theirs', () => {
  assert.equal(ACTION_UPGRADES.grenades.line, 'infantry');
  assert.equal(ACTION_UPGRADES.heavy_armor.line, 'vehicle');
  assert.equal(ACTION_UPGRADES.aircraft_systems.line, 'air');
  assert.equal(ACTION_UPGRADES.improved_logistics.line, undefined);
  const g = create(), civ = g.civs[0], site = g.sites[0], slots = openSlots(g, site);
  civ.age = 2; civ.res = { materials: 1e5, energy: 1e5 };
  addFacility(g, civ, site, 'barracks', slots[0], { instant: true });
  addFacility(g, civ, site, 'barracks', slots[1], { instant: true });
  addFacility(g, civ, site, 'armory', slots[2], { instant: true });
  assert.ok(!g.command(0, { c: 'research', tech: 'grenades' }).error);
  const taken = g.command(0, { c: 'research', tech: 'rocket_teams' });
  assert.equal(taken.code, 'upgrade_line_taken');
  assert.match(taken.error, /infantry already follow the Hand Grenades path/);
  assert.equal(commandAck(taken, 2).reason, 'upgrade_line_taken');
  assert.ok(g.command(0, { c: 'research', tech: 'infantry_training' }).code === 'upgrade_line_taken', 'armory infantry upgrade too');
  assert.ok(!g.command(0, { c: 'research', tech: 'improved_logistics' }).error, 'unrestricted upgrades are unaffected');
  // cancelling frees the line, without refund
  const res = { ...civ.res };
  const cancel = g.command(0, { c: 'cancelResearch', tech: 'grenades' });
  assert.deepEqual(cancel.reply.cancelled.lost, ACTION_UPGRADES.grenades.cost);
  assert.deepEqual(civ.res, res, 'no refund');
  assert.equal(upgradeLineHolder(g, civ, 'rocket_teams'), null);
  assert.ok(!g.command(0, { c: 'research', tech: 'rocket_teams' }).error);
  // researched upgrades hold the line; grandfathered extra upgrades stay
  civ.techs.add('body_armor'); civ.techs.add('marksmen');
  assert.ok(civ.techs.has('body_armor') && civ.techs.has('marksmen'));
  g.command(0, { c: 'cancelResearch', tech: 'improved_logistics' });   // free the armory
  assert.equal(g.command(0, { c: 'research', tech: 'heavy_armor' }).error, undefined, 'the vehicle line is still free');
  assert.equal(g.command(0, { c: 'research', tech: 'field_engineering' }).code, 'upgrade_line_taken');
  assert.ok(g.defs.TECHS.grenades.line === 'infantry' && g.defs.RULESET.upgradeLines, 'line reaches the client in defs');
});
