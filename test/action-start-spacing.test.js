// Random worlds keep capitals apart (2026-11-16 menus pass): on an archipelago seed whose road-reachable
// land is one compact island, the soft separation penalty in buildActionMap let three capitals land on
// neighbouring hexes (a 3 v 2 lobby started with the HQs stacked). Starts now keep a hard minimum gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 208;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');

test('random-world capitals never stack (archipelago seed that used to)', () => {
  for (const n of [5, 6]) {
    const g = new ActionGame({ id: 'gap', seed: 641880640, style: 'archipelago', teamSize: 3, slots: Array.from({ length: n }, (_, i) => ({ human: i === 0 })) });
    const hq = g.civs.map((c) => g.sites.find((s) => s.owner === c.id && s.slots));
    assert.ok(hq.every(Boolean), 'every civ has a capital');
    let min = Infinity;
    for (let a = 0; a < hq.length; a++) for (let b = a + 1; b < hq.length; b++) min = Math.min(min, Math.hypot(hq[a].x - hq[b].x, hq[a].z - hq[b].z));
    assert.ok(min >= 13, `${n} capitals at least a base gap apart (closest ${min.toFixed(1)})`);
  }
});
