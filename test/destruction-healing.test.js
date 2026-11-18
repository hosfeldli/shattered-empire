// Destruction healing (docs/gameplay-overhaul/DESTRUCTION.md): crater impact records fill in on a
// server-authoritative, map-wide heal clock and are removed; the heal level is replicated in the 'm' rows,
// survives save/restore exactly, heals remembered (fogged) craters on the same schedule, and changes only
// once per heal tick. Wrecks rust away and are capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { makeSandbox, findArena } from '../server/sim/sandbox.js';
import { addCrater, addWreck, battlefieldSnapshot, battlefieldStep, rememberBattlefield, impactHeal, healClock, IMPACT, WRECK, CRATER_HEAL } from '../server/sim/battlefield.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { deltaEncoder } from '../server/delta.js';

const sandbox = () => { const g = new Game({ id: 'dh' + Math.random(), seed: 7, slots: [{ human: true }, { personality: 'builder' }], rebels: false }); makeSandbox(g); return g; };
const all = (g) => { const v = new Uint8Array(g.world.terr.length).fill(1); return battlefieldSnapshot(g, v, v, null, true); };
const rows = (g, t) => all(g).m.filter((r) => r[0] === t);
const at = (g, time) => { g.time = time; battlefieldStep(g, 1, { fieldPositions: false }); };

test('impact records hold, heal on the map-wide clock, and are removed', () => {
  const g = sandbox(), t = findArena(g);
  g.time = IMPACT.tick * 10;                       // on a tick boundary
  addCrater(g, t, 1, 'shell');
  const born = g.time;
  assert.equal(rows(g, t).length, 1);
  assert.equal(rows(g, t)[0].length, 7, 'heal level is the 7th field');
  assert.equal(rows(g, t)[0][6], 100, 'fresh');
  at(g, born + IMPACT.hold);
  assert.equal(rows(g, t)[0][6], 100, 'held at full depth');
  // half way through the heal (hold + heal/2 is a whole number of ticks with the shipped constants)
  at(g, born + IMPACT.hold + IMPACT.heal / 2);
  assert.equal(rows(g, t)[0][6], Math.round(impactHeal(born, healClock(g)) * 100));
  assert.ok(rows(g, t)[0][6] > 30 && rows(g, t)[0][6] < 70, 'half filled in');
  // within one heal tick the replicated value does not move (clients re-mesh at most once per tick)
  const f = rows(g, t)[0][6];
  at(g, born + IMPACT.hold + IMPACT.heal / 2 + IMPACT.tick - 0.5);
  assert.equal(rows(g, t)[0][6], f, 'steps only on the heal tick');
  at(g, born + IMPACT.hold + IMPACT.heal + IMPACT.tick);
  assert.equal(rows(g, t).length, 0, 'healed impacts leave the wire');
  assert.ok(!g.impacts.has(t), 'and are removed from the state');
  assert.equal(g.impactCount, 0);
});

test('crater depth (cover and cost) softens within minutes', () => {
  const g = sandbox(), t = findArena(g);
  g.time = 1000;
  addCrater(g, t, 3, 'bomb');
  const d0 = g.craters.get(t).d;
  for (let s = 1; s <= CRATER_HEAL.every * d0 + 5; s++) at(g, 1000 + s);
  assert.ok(!g.craters.has(t), 'a fully cratered hex is gone after levels x interval');
});

test('heal state is exact across save and restore', () => {
  const g = sandbox(), t = findArena(g);
  g.time = 600;
  addCrater(g, t, 1, 'mortar');
  at(g, 600 + IMPACT.hold + 75);
  const before = all(g).m;
  const copy = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.deepEqual(all(copy).m, before, 'same rows, same heal level');
  copy.time = g.time = 600 + IMPACT.hold + IMPACT.heal + IMPACT.tick;
  battlefieldStep(g, 1, { fieldPositions: false }); battlefieldStep(copy, 1, { fieldPositions: false });
  assert.deepEqual(all(copy).m, all(g).m);
  assert.equal(copy.impactCount, g.impactCount);
});

test('remembered craters heal on the same schedule outside sight and are forgotten', () => {
  const g = sandbox(), civ = g.civs[0], t = findArena(g);
  civ.visible.fill(0); civ.explored.fill(0); civ.visible[t] = 1; civ.explored[t] = 1;
  g.time = 300;
  addCrater(g, t, 1, 'shell');
  rememberBattlefield(g, civ);
  civ.visible[t] = 0;
  const snap = () => battlefieldSnapshot(g, civ.visible, civ.explored, civ.battlefieldMemory).m.filter((r) => r[0] === t);
  assert.equal(snap()[0][6], 100);
  g.time = 300 + IMPACT.hold + IMPACT.heal / 2;
  assert.equal(snap()[0][6], rows(g, t)[0][6], 'fogged crater heals like the real one');
  g.time = 300 + IMPACT.hold + IMPACT.heal + IMPACT.tick;
  assert.equal(snap().length, 0, 'healed memory is not drawn');
  rememberBattlefield(g, civ);
  assert.equal(civ.battlefieldMemory.get(t)?.impacts?.length || 0, 0, 'and is pruned from memory');
});

test('the econ bf block is only resent when the heal clock steps', () => {
  const g = sandbox(), t = findArena(g);
  g.time = IMPACT.tick * 4;
  addCrater(g, t, 1, 'shell');
  const enc = deltaEncoder(1000, 1000);
  const send = () => enc({ t: 's', units: [], econ: true, bf: all(g) });
  send(); send();                                  // welcome + the encoder's first periodic full copy
  assert.equal(send().bf, undefined, 'an identical block is left out');
  g.time += IMPACT.hold + IMPACT.tick; assert.ok(send().bf, 'a heal step resends');
  g.time += 1; assert.equal(send().bf, undefined, 'unchanged inside the tick');
});

test('wrecks rust away and are capped map-wide', () => {
  const g = sandbox(), t = findArena(g);
  g.time = 50;
  addWreck(g, t, 'tank', 1);
  for (const wr of g.wrecks.get(t)) wr.burn = 0;
  at(g, 50 + WRECK.life + 1);
  assert.ok(!g.wrecks.has(t), 'gone after its life');
  // the cap: spread wrecks over many land hexes
  for (let x = 0; x < WRECK.total + 40; x++) addWreck(g, x, 'tank', 1);
  let n = 0; for (const l of g.wrecks.values()) n += l.length;
  assert.ok(n <= WRECK.total, `at most ${WRECK.total} wrecks (${n})`);
});
