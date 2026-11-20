// 2026-11-20 (user: "Remove the armory from the game"): the Armory and its two command upgrades (Improved Logistics,
// Networked Command) are gone. It cannot be built, its upgrades are refused, and an older save that holds one loads
// with the building removed and its full cost (plus any upgrade owned or in progress) refunded.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UPGRADES, REMOVED_BUILDINGS, REMOVED_UPGRADES } = await import('../server/sim/actionDefinitions.js');
const { addFacility, openSlots } = await import('../server/sim/actionBases.js');
const { serializeGame, restoreGame, stateHash } = await import('../server/sim/persist.js');

const create = () => new ActionGame({ id: 'armory-1120', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
const home = (g, civ) => g.sites.find((s) => s.owner === civ.id && s.hq);

test('the Armory cannot be built and its upgrades are refused', () => {
  assert.equal(ACTION_BUILDINGS.armory, undefined);
  assert.equal(ACTION_UPGRADES.improved_logistics, undefined);
  assert.equal(ACTION_UPGRADES.networked_command, undefined);
  const g = create(), civ = g.civs[0], site = home(g, civ);
  civ.age = 2; civ.res = { materials: 1e5, energy: 1e5 };
  assert.ok(!g.defs.BUILDINGS.armory, 'not offered to the client');
  const slot = openSlots(g, site)[0];
  const res = { ...civ.res };
  const r = g.command(0, { c: 'baseBuild', site: site.id, type: 'armory', slot });
  assert.ok(r.error, 'building an Armory is refused');
  assert.ok(![...g.buildings.values()].some((b) => b.type === 'armory'));
  assert.deepEqual(civ.res, res, 'nothing paid');
  for (const tech of ['improved_logistics', 'networked_command']) assert.equal(g.command(0, { c: 'research', tech }).code, 'upgrade_removed');
});

test('an older save with an Armory loads with it removed and refunded in full, deterministically', () => {
  const g = create(), civ = g.civs[0], site = home(g, civ);
  civ.age = 2; civ.res = { materials: 3000, energy: 2000 };
  const [s0, s1] = openSlots(g, site);
  // stand-ins for what an older save holds: a finished Armory researching Networked Command, a second one still
  // under construction, Improved Logistics owned, and the ruin of a third
  const a = addFacility(g, civ, site, 'barracks', s0, { instant: true });
  const b = addFacility(g, civ, site, 'barracks', s1);
  civ.techs.add('improved_logistics');
  const data = JSON.parse(JSON.stringify(serializeGame(g)));
  for (const w of data.buildings) {
    if (w.id === a.id) { w.type = 'armory'; w.project = { kind: 'upgrade', key: 'networked_command', left: 20, total: 52 }; }
    if (w.id === b.id) w.type = 'armory';
  }
  const ruinTile = data.ruins[0]?.[0] ?? site.tile;
  data.ruins = [...data.ruins.filter(([t]) => t !== ruinTile), [ruinTile, { type: 'armory', owner: 0, name: site.name, time: 0 }]];
  const res = { ...civ.res };

  const copy = restoreGame(JSON.parse(JSON.stringify(data)));
  const c0 = copy.civs[0];
  assert.ok(![...copy.buildings.values()].some((x) => x.type === 'armory'), 'the Armories are gone');
  assert.ok(!copy.buildings.has(a.id) && !copy.buildings.has(b.id));
  assert.ok(openSlots(copy, copy.siteById.get(site.id)).includes(s0), 'its ring site is free again');
  assert.ok(!c0.techs.has('improved_logistics'));
  const cost = REMOVED_BUILDINGS.armory.cost, il = REMOVED_UPGRADES.improved_logistics.cost, nc = REMOVED_UPGRADES.networked_command.cost;
  assert.equal(c0.res.materials, res.materials + 2 * cost.materials + il.materials + nc.materials);
  assert.equal(c0.res.energy, res.energy + 2 * cost.energy + il.energy + nc.energy);
  assert.ok(![...copy.ruins.values()].some((r) => r.type === 'armory'), 'no Armory ruin is sent to clients');

  // deterministic: the same save loads to the same state, which then runs on
  const again = restoreGame(JSON.parse(JSON.stringify(data)));
  assert.equal(stateHash(copy), stateHash(again));
  for (let i = 0; i < 60; i++) { copy.tick(); again.tick(); }
  assert.equal(stateHash(copy), stateHash(again));
});
