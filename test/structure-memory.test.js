// Last-seen structures: a foreign building stays on a viewer's map exactly as it was last seen,
// without activity; hidden damage, upgrades or destruction are not revealed until the hex is
// seen again; the memory survives save/restore and never includes the viewer's own buildings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { WORKS_RULESET } from '../server/sim/rulesets.js';
import { disk } from '../server/sim/hex.js';

const newGame = () => new Game({ id: 'mem' + Math.random(), seed: 7, slots: [{ human: true }, { human: true }], rebels: false, ruleset: WORKS_RULESET });
const seen = (g, civ, id) => g.econSnapshot(civ).buildings.find((b) => b.id === id);

function setup() {
  const g = newGame(), me = g.civs[0], them = g.civs[1];
  const theirs = [...g.buildings.values()].find((b) => b.owner === 1 && b.done);
  assert.ok(theirs, 'the other empire has a building');
  return { g, me, them, theirs };
}
const reveal = (g, civ, tile, on) => { for (const t of disk(tile, 1)) civ.visible[t] = on ? 1 : 0; g.rememberStructures(civ); };

test('a foreign building seen once stays on the map as a quiet memory', () => {
  const { g, me, theirs } = setup();
  me.visible.fill(0);
  assert.equal(seen(g, me, theirs.id), undefined, 'never seen: unknown');
  reveal(g, me, theirs.tile, true);
  const live = seen(g, me, theirs.id);
  assert.ok(live && !live.mem);
  reveal(g, me, theirs.tile, false);
  const memory = seen(g, me, theirs.id);
  assert.ok(memory, 'remembered after sight is lost');
  assert.equal(memory.mem, 1);
  assert.equal(memory.a, 0, 'no hidden activity');
  assert.equal(memory.ty, theirs.type);
});

test('hidden changes are not revealed until the ground is seen again', () => {
  const { g, me, theirs } = setup();
  me.visible.fill(0);
  reveal(g, me, theirs.tile, true);
  const hp = seen(g, me, theirs.id).hp;
  reveal(g, me, theirs.tile, false);
  theirs.hp = theirs.maxHp * 0.2;                         // damaged out of sight
  assert.equal(seen(g, me, theirs.id).hp, hp, 'damage stays hidden');
  g.removeBuilding(theirs);                               // destroyed out of sight
  assert.ok(seen(g, me, theirs.id), 'destruction stays hidden');
  reveal(g, me, theirs.tile, true);
  assert.equal(seen(g, me, theirs.id), undefined, 'seen again: the memory is corrected');
});

test('memory survives a save and excludes the viewer\'s own buildings', () => {
  const { g, me, theirs } = setup();
  me.visible.fill(0);
  reveal(g, me, theirs.tile, true);
  reveal(g, me, theirs.tile, false);
  const restored = restoreGame(serializeGame(g));
  const r = restored.econSnapshot(restored.civs[0]).buildings.find((b) => b.id === theirs.id);
  assert.ok(r && r.mem === 1);
  assert.ok([...me.seenB.values()].every((rec) => rec.o !== me.id));
});
