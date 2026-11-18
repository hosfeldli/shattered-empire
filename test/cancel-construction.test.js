// Cancelling a base facility under construction (gameplay overhaul §12): the built share of its cost is spent
// (REQUIREMENTS R2: consumed resources are never refunded), the unbuilt share comes back, and the pad is free again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionGame } from '../server/sim/actionGame.js';
import { ACTION_BUILDINGS } from '../server/sim/actionDefinitions.js';
import { construct, openSlots } from '../server/sim/actionBases.js';

test('cancelling construction refunds only the unbuilt share and frees the pad', () => {
  const g = new ActionGame({ id: 'cc', seed: 3, slots: [{ human: true }, { human: false }], rebels: false });
  const civ = g.civs[0];
  civ.res.materials = 5000; civ.res.energy = 5000;
  const site = [...g.sites.values()].find((s) => s.owner === civ.id && s.kind === 'base') || [...g.sites.values()].find((s) => s.owner === civ.id);
  assert.ok(site, 'own base');
  const pad = openSlots(g, site)[0];
  const before = { ...civ.res };
  const r = construct(g, civ, site, 'barracks', pad);
  assert.ok(r.building, JSON.stringify(r));
  const b = g.buildings.get(r.building);
  const cost = ACTION_BUILDINGS.barracks.cost;
  b.progress = .4;
  const res = g.command(civ.id, { c: 'cancelConstruction', id: b.id });
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(g.buildings.has(b.id), false);
  assert.equal(civ.res.materials, before.materials - cost.materials + Math.floor(cost.materials * .6));
  assert.ok(openSlots(g, site).includes(pad), 'pad free again');
  // completed structures and the HQ cannot be cancelled
  const hq = [...g.buildings.values()].find((x) => x.owner === civ.id && x.type === 'town');
  assert.ok(g.command(civ.id, { c: 'cancelConstruction', id: hq.id }).error);
});
