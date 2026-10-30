// Fog-of-war, AI-intelligence, determinism and order-feedback guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { T, isWater } from '../server/sim/constants.js';

test('snapshots reveal nothing about empires that have not been met', () => {
  const g = new Game({ id: 't', seed: 7, slots: [{ human: true }, { personality: 'builder' }] });
  g.civs[0].connected = true;
  for (let i = 0; i < 50; i++) g.tick();
  assert.equal(g.diplomacy.rel(0, 1).state, 'unmet');
  const [[, msg]] = g.snapshots(0);
  const other = msg.civs.find((c) => c.id === 1);
  assert.deepEqual(Object.keys(other).sort(), ['alive', 'color', 'human', 'id', 'name', 'rebel', 'rel']);
  assert.equal(other.rel.state, 'unmet');
  assert.ok(msg.units.every((u) => u[1] === 0 || g.civs[0].visible[u[3]]), 'only visible enemy units');
  assert.ok(msg.buildings.every((b) => b.o === 0 || g.civs[0].visible[b.t]), 'only visible enemy buildings');
  assert.ok(msg.cities.every((c) => c.o === 0 || g.civs[0].visible[c.t]));
  for (const c of msg.civs) if (c.id !== 0) assert.equal(c.summary, undefined, 'no score/pop/tech summary for others');
  assert.ok(msg.ruins.every(([t]) => g.civs[0].explored[t]), 'ruins only on explored ground');
  assert.ok(msg.traffic.every(([a, b]) => g.civs[0].visible[a] || g.civs[0].visible[b]), 'road traffic only where visible');
  for (const c of msg.cities) if (c.o !== 0) for (const k of ['stock', 'gov', 'st', 'jobs', 'iso']) assert.equal(c[k], undefined, 'no internal data for foreign cities: ' + k);
  for (const b of msg.buildings) if (b.o !== 0) for (const k of ['s', 'q', 'gov']) assert.equal(b[k], undefined, 'no internal data for foreign buildings: ' + k);
  assert.equal(JSON.stringify(msg).includes('token'), false, 'no session tokens in snapshots');
});

test('AI targets only cities it has actually seen', () => {
  const g = new Game({ id: 't', seed: 11, slots: [{ personality: 'warlord' }, { personality: 'builder' }] });
  // force war before any contact so the AI must find the enemy itself
  const r = g.diplomacy.rel(0, 1); r.state = 'war';
  for (let i = 0; i < 600; i++) {
    g.tick();
    const ai = g.civs[0].ai;
    const t = ai.pickTargetCity([g.civs[1]]);
    if (t) assert.ok(g.civs[0].knownCities.has(t.id), 'target must come from observations');
  }
  const ai = g.civs[0].ai;
  for (const [id, k] of g.civs[0].knownCities) assert.ok(g.civs[0].explored[k.tile], `known city ${id} was explored`);
});

test('identical seeds and commands produce identical matches', () => {
  const run = () => {
    const g = new Game({ id: 't', seed: 21, slots: [{ personality: 'merchant' }, { personality: 'warlord' }] });
    for (let i = 0; i < 4000; i++) { g.tick(); g.outbox.length = 0; }
    return JSON.stringify([g.civs.map((c) => [Math.round(c.res.food * 100), Math.round(c.res.credits * 100), [...c.techs], g.civSummary(c)]), [...g.units.values()].map((u) => [u.id, u.tile, Math.round(u.hp)]), g.log.map((e) => [e.kind, e.tile])]);
  };
  assert.equal(run(), run());
});

test('move orders report partial and unreachable destinations', () => {
  const g = new Game({ id: 't', seed: 3, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
  const w = g.world;
  const u = [...g.units.values()].find((x) => x.owner === 0 && x.type === 'militia');
  // an ocean tile far away: no route without sailing
  let sea = -1; for (let i = 0; i < w.terr.length; i++) if (w.terr[i] === T.DEEP) { sea = i; break; }
  const res = g.command(0, { c: 'move', units: [u.id], tile: sea });
  assert.ok(res.reply.order.partial + res.reply.order.unreachable === 1, JSON.stringify(res.reply.order));
  let land = -1; for (const t of g.freeTilesNear(u.tile, 3)) if (!isWater(w.terr[t])) { land = t; break; }
  const ok = g.command(0, { c: 'move', units: [u.id], tile: land });
  assert.equal(ok.reply.order.reached, 1);
});
