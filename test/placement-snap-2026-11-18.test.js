// 2026-11-18: defenses (except the sandbag barricade) keep off roads and snap to the nearest valid hex centre within
// PLACEMENT.snapHexes (ties: lowest tile id); every refusal carries code + reason + text. CONSTRUCTION_DESIGN.md
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { PLACEMENT } = await import('../server/sim/actionDefinitions.js');
const { onRoad, PLACEMENT_REASONS } = await import('../server/sim/actionBases.js');
const { centerOf, distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { disk, NB } = await import('../server/sim/hex.js');
const { commandAck } = await import('../server/commandAck.js');

const create = () => {
  const g = new ActionGame({ id: 'snap-check', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
  g.civs[0].res = { materials: 1e5, energy: 1e5 }; g.civs[0].visible.fill(1); g.civs[0].age = 1;
  return g;
};
const preview = (g, type, point, yaw = 0) => g.command(0, { c: 'fieldPreview', type, point, yaw });
const roadTile = (g, t) => [0, 1, 2, 3, 4, 5].some((d) => NB[t * 6 + d] >= 0 && g.roads.get(t, NB[t * 6 + d]));

// an own-territory hex where a bunker previews cleanly at the centre, with a land neighbour also previewing cleanly
function cleanPair(g) {
  for (let t = 0; t < g.world.owner.length; t++) {
    if (g.world.owner[t] !== 0 || roadTile(g, t)) continue;
    const r = preview(g, 'bunker', centerOf(t)).reply?.placement;
    if (!r || r.snapped) continue;
    for (let d = 0; d < 6; d++) {
      const n = NB[t * 6 + d];
      if (n < 0 || g.world.owner[n] !== 0 || roadTile(g, n)) continue;
      const q = preview(g, 'barricade', centerOf(n)).reply?.placement;
      if (q && !q.snapped) return [t, n];
    }
  }
  return null;
}

test('a bunker on a road snaps off it (nearest valid hex, lowest id on ties); the barricade may stay on the road', () => {
  const g = create(), pair = cleanPair(g);
  assert.ok(pair, 'found clean ground');
  const [t, n] = pair;
  g.roads.set(t, n, 1); g.roads.refresh(t); g.roads.refresh(n); g.nav.invalidate();
  const at = centerOf(t);
  assert.ok(onRoad(g, at.x, at.z, .32));
  const r = preview(g, 'bunker', at).reply.placement;
  assert.equal(r.snapped, true);
  assert.equal(r.reason, 'road');
  assert.ok(r.tile !== t && !roadTile(g, r.tile), 'placed off the road hex');
  assert.ok(!onRoad(g, r.x, r.z, .32));
  // the contract: first hex centre within snapHexes passing every rule, by distance then tile id
  const order = disk(t, PLACEMENT.snapHexes).filter((k) => k >= 0)
    .map((k) => ({ k, d: Math.round(distance(centerOf(k), at) * 1e6) })).sort((a, b) => a.d - b.d || a.k - b.k).map((c) => c.k);
  const first = order.find((k) => { const p = preview(g, 'bunker', centerOf(k)).reply?.placement; return p && !p.snapped; });
  assert.equal(r.tile, first);
  // build: ack carries tile + snapped + reason, and a quiet note says why
  g.outbox.length = 0;
  const res = g.command(0, { c: 'fieldBuild', type: 'bunker', point: at, yaw: 0 });
  const ack = commandAck(res, 7);
  assert.equal(ack.tile, first); assert.equal(ack.snapped, true); assert.equal(ack.reason, 'road'); assert.ok(ack.building);
  assert.equal(g.buildings.get(ack.building).tile, first);
  const note = g.outbox.map(([, m]) => m).find((m) => m.t === 'note' && m.snapped);
  assert.ok(note && note.reason === 'road' && note.tile === first, 'snap notice');
  // the barricade is exempt: on the road hex it stays where asked (no snap for the road)
  const b = preview(g, 'barricade', centerOf(n)).reply?.placement;
  assert.ok(b && b.tile === n && !b.snapped, 'barricade allowed on a road');
});

test('every placement refusal carries a code, a matching reason and text', () => {
  const g = create();
  const enemy = g.sites.find((s) => s.owner === 1);
  const refusal = preview(g, 'bunker', { x: enemy.x, z: enemy.z });
  assert.ok(refusal.error && refusal.code, 'refused with a code');
  const ack = commandAck(refusal, 3);
  assert.equal(ack.reason, ack.code);
  assert.ok(ack.error.length > 10);
  for (const code of ['road', 'forest', 'funds', 'tech', 'invalid']) assert.ok(PLACEMENT_REASONS[code], code);
  assert.equal(preview(g, 'bunker', null).code, 'invalid');
  const [t] = cleanPair(g);
  g.civs[0].res = { materials: 0, energy: 0 };
  assert.equal(preview(g, 'bunker', centerOf(t)).code, 'funds');
});

test('an unresolvable spot (another player\'s territory) is refused, never snapped', () => {
  const g = create();
  const t = g.world.owner.findIndex((o) => o === 1);
  const r = preview(g, 'bunker', centerOf(t));
  assert.equal(r.code, 'territory');
});
