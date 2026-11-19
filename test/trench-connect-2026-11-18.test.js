// "The trenches don't connect" (2026-11-18): the route bits of action trench lines must join every stroke into
// one network, join strokes that touch or cross older works, and draw no triangles or ladders. The client links
// two neighbouring nodes when either end carries the bit (TrenchNetwork.Linked, routed reach 3.8).
// See docs/gameplay-overhaul/TRENCHES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { fieldworksFor } = await import('../server/sim/fieldworks.js');
const { centerOf, tileAt } = await import('../server/sim/actionNavigation.js');
const { NB } = await import('../server/sim/hex.js');

const CLIENT_REACH = 3.8;   // TrenchNetwork.RoutedReach

function create() {
  const g = new ActionGame({ id: 'trench-connect', seed: 41, style: 'pangaea', slots: [{ human: true }, { human: true }] });
  const civ = g.civs[0];
  civ.res = { materials: 1e9, energy: 1e9 };
  civ.visible.fill(1);
  return g;
}
const clear = (g) => { for (const t of [...g.fieldworks.keys()]) g.fieldworks.delete(t); };
const dirTo = (a, b) => { for (let d = 0; d < 6; d++) if (NB[a * 6 + d] === b) return d; return -1; };

/** The network as the client sees it: the wire records (fw element 8) and positions, linked by TrenchNetwork.Linked. */
function network(g, civ = g.civs[0]) {
  const recs = new Map(fieldworksFor(g, civ, civ.visible).map((r) => [r[0], r]));
  const linked = (a, b) => {
    const d = dirTo(a, b), ra = recs.get(a), rb = recs.get(b);
    if (d < 0 || !ra || !rb || ra[1] !== rb[1]) return false;
    if (!((ra[8] >> d) & 1) && !((rb[8] >> ((d + 3) % 6)) & 1)) return false;
    const fa = g.fieldworks.get(a), fb = g.fieldworks.get(b);
    return Math.hypot(fa.x - fb.x, fa.z - fb.z) <= CLIENT_REACH;
  };
  const components = (edge) => {
    const seen = new Set(); let n = 0;
    for (const t of recs.keys()) {
      if (seen.has(t)) continue;
      n++; seen.add(t);
      const stack = [t];
      while (stack.length) { const a = stack.pop(); for (let d = 0; d < 6; d++) { const b = NB[a * 6 + d]; if (b >= 0 && recs.has(b) && !seen.has(b) && edge(a, b)) { seen.add(b); stack.push(b); } } }
    }
    return n;
  };
  let triangles = 0;
  for (const a of recs.keys()) for (let d = 0; d < 6; d++) {
    const b = NB[a * 6 + d], c = NB[a * 6 + ((d + 1) % 6)];   // two neighbours of a that touch each other
    if (b >= 0 && c >= 0 && linked(a, b) && linked(a, c) && linked(b, c)) triangles++;
  }
  return { recs, linked, nodes: recs.size, pieces: components(linked), touching: components((a, b) => recs.get(a)[1] === recs.get(b)[1]), triangles };
}

const stroke = (g, points) => g.command(0, { c: 'trenchWorld', points });
// a stroke laid whole: every hex dug, or skipped only because an earlier line of ours is already there
const laidWhole = (g, points) => {
  const preview = g.command(0, { c: 'trenchWorld', points, preview: true });
  if (preview.error || preview.reply?.trench?.skipped?.some((s) => s.why !== 'dug')) return false;
  return !stroke(g, points).error;
};
const relief = (g) => { let lo = Infinity, hi = -Infinity; for (const t of g.fieldworks.keys()) { lo = Math.min(lo, g.world.elev[t]); hi = Math.max(hi, g.world.elev[t]); } return hi - lo; };

// shapes relative to a hex centre c: each case is a list of strokes drawn one after the other
const SHAPES = {
  straight: (c) => [[c, { x: c.x + 8, z: c.z }]],
  diagonal: (c) => [[c, { x: c.x + 5, z: c.z + 5 }]],
  bent: (c) => [[c, { x: c.x + 5, z: c.z }, { x: c.x + 5, z: c.z + 6 }]],
  // a hand-drawn line wobbling along a row boundary re-enters hexes it left
  wobble: (c) => [Array.from({ length: 22 }, (_, i) => ({ x: c.x + i * .38, z: c.z + .75 + (i % 3 === 1 ? .3 : -.25) }))],
  cross: (c) => [[c, { x: c.x + 7, z: c.z }], [{ x: c.x + 3.5, z: c.z - 3.5 }, { x: c.x + 3.5, z: c.z + 3.5 }]],
  tee: (c) => [[c, { x: c.x + 7, z: c.z }], [{ x: c.x + 3.3, z: c.z + 5 }, { x: c.x + 3.3, z: c.z + 1.1 }]],
  extend: (c) => [[c, { x: c.x + 4, z: c.z }], [{ x: c.x + 5.2, z: c.z + .3 }, { x: c.x + 9, z: c.z + 2 }]],
  overlapEnd: (c) => [[c, { x: c.x + 4, z: c.z }], [{ x: c.x + 3.6, z: c.z }, { x: c.x + 3.8, z: c.z + 5 }]],
  // two lines with a gap, then the gap drawn in: one work (before, the filler joined one side only)
  gapFill: (c) => [[c, { x: c.x + 3, z: c.z }], [{ x: c.x + 6.5, z: c.z }, { x: c.x + 9, z: c.z }], [{ x: c.x + 3.2, z: c.z }, { x: c.x + 6.3, z: c.z }]],
};

for (const [name, shape] of Object.entries(SHAPES)) test(`trench strokes join into one work: ${name}`, () => {
  const g = create();
  let cases = 0, hilly = 0;
  const broken = [];
  for (let t = 0; t < 64 * 64; t += 5) {
    clear(g);
    let ok = true;
    for (const s of shape(centerOf(t))) if (!laidWhole(g, s)) { ok = false; break; }
    if (!ok) continue;   // only strokes laid whole (skipped hexes leave deliberate gaps)
    cases++;
    if (relief(g) >= .08) hilly++;
    const n = network(g);
    if (n.pieces !== n.touching) broken.push({ t, nodes: n.nodes, pieces: n.pieces, touching: n.touching });
    assert.equal(n.triangles, 0, `${name} at ${t}: a stroke drew a triangle of links`);
  }
  assert.ok(cases >= 10, `${name}: only ${cases} cases laid`);
  assert.ok(hilly >= 1, `${name}: no case crossed a height change`);
  assert.deepEqual(broken, [], `${name}: lines broken into pieces`);
});

test('a single straight stroke is one chain: every interior node has two links, the ends one', () => {
  const g = create();
  for (let t = 0; t < 64 * 64; t += 3) {
    clear(g);
    const c = centerOf(t);
    const r = stroke(g, [c, { x: c.x + 8.5, z: c.z }]);
    if (r.error || r.skipped || r.hexes < 5) continue;
    const n = network(g);
    const degrees = [...n.recs.keys()].map((a) => { let k = 0; for (let d = 0; d < 6; d++) if (n.linked(a, NB[a * 6 + d])) k++; return k; }).sort();
    assert.deepEqual(degrees, [1, 1, ...Array(degrees.length - 2).fill(2)]);
    return;
  }
  assert.fail('no clear ground for a straight line');
});

test('route bits are on the wire while the line is still planned, and a destroyed hex redrawn rejoins both sides', () => {
  const g = create();
  for (let t = 0; t < 64 * 64; t += 3) {
    clear(g);
    const c = centerOf(t);
    const r = stroke(g, [c, { x: c.x + 8.5, z: c.z }]);
    if (r.error || r.skipped || r.hexes < 5) continue;
    let n = network(g);
    assert.equal(n.pieces, 1);
    for (const rec of n.recs.values()) { assert.equal(rec[4], 0, 'not dug yet'); assert.ok(rec[8] > 0, 'planned nodes carry their links'); }
    // dig some of it: the links do not depend on progress
    let k = 0; for (const f of g.fieldworks.values()) if (k++ % 2) { f.progress = 1; f.state = 'built'; }
    assert.equal(network(g).pieces, 1);
    // shell out a middle hex: its neighbours stop pointing at it (masked on the wire)
    const middle = tileAt(c.x + 4.3, c.z);
    assert.ok(g.fieldworks.has(middle));
    g.fieldworks.delete(middle);
    n = network(g);
    for (let d = 0; d < 6; d++) { const rec = n.recs.get(NB[middle * 6 + d]); if (rec) assert.equal((rec[8] >> ((d + 3) % 6)) & 1, 0); }
    assert.equal(n.pieces, 2);
    // redraw just that hex: it joins both sides again
    const re = stroke(g, [{ x: c.x + 3.6, z: c.z }, { x: c.x + 5, z: c.z }]);
    assert.ok(!re.error, re.error);
    assert.equal(network(g).pieces, 1);
    return;
  }
  assert.fail('no clear ground for a straight line');
});

test('two parallel lines a hex apart stay separate works (no ladder)', () => {
  const g = create();
  for (let t = 0; t < 64 * 64; t += 3) {
    clear(g);
    const c = centerOf(t);
    const a = stroke(g, [c, { x: c.x + 7, z: c.z }]);
    if (a.error || a.skipped || a.hexes < 4) continue;
    const b = stroke(g, [{ x: c.x + .9, z: c.z + 1.5 }, { x: c.x + 6, z: c.z + 1.5 }]);   // the next row up, inside the first line's ends
    if (b.error || b.skipped) continue;
    const n = network(g);
    assert.equal(n.triangles, 0);
    let rungs = 0;
    for (const x of n.recs.keys()) for (let d = 0; d < 6; d++) { const y = NB[x * 6 + d]; if (y > x && n.linked(x, y) && Math.abs(g.fieldworks.get(x).z - g.fieldworks.get(y).z) > .7) rungs++; }
    assert.ok(rungs <= 2, `parallel lines laddered together (${rungs} rungs)`);
    return;
  }
  assert.fail('no clear ground for two parallel lines');
});

// 2026-11-18 follow-up ("allow trenches to be built connected to roads"): a road hex of the line is dug as a covered
// crossing, so a line across a road is one work, a line drawn up to a road ends in it, and the road stays open.
test('a trench line across a road is one work through the road hex, and vehicles still drive the road', async () => {
  const { connect } = await import('../server/sim/actionMap.js');
  const { HEAVY_GROUND, distance } = await import('../server/sim/actionNavigation.js');
  const g = create(), civ = g.civs[0];
  g.world.owner.fill(0);
  const cities = g.sites.filter((s) => s.slots);
  for (let i = 1; i < cities.length; i++) connect(g, cities[0].tile, cities[i].tile);
  const clearOf = (t) => g.sites.every((s) => distance(s, centerOf(t)) > 4.5);
  const edges = [...g.roads.edges.values()].filter((e) => e.cond > 0 && clearOf(e.a) && clearOf(e.b) && !g.world.river[e.a] && !g.world.river[e.b]);
  let checked = 0;
  for (const edge of edges) {
    clear(g);
    const a = centerOf(edge.a), b = centerOf(edge.b), len = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
    // the road's course a few hexes either way, driven by a tank before and after the trench is dug
    const from = { x: a.x - (b.x - a.x) * 2, z: a.z - (b.z - a.z) * 2 }, to = { x: b.x + (b.x - a.x) * 2, z: b.z + (b.z - a.z) * 2 };
    const before = g.nav.route(from, to, HEAVY_GROUND);
    if (!before?.length) continue;
    const across = [{ x: a.x - nx * 3, z: a.z - nz * 3 }, { x: a.x + nx * 3, z: a.z + nz * 3 }];
    const preview = g.command(0, { c: 'trenchWorld', points: across, preview: true });
    if (preview.error || preview.reply.trench.skipped.length) continue;
    const r = stroke(g, across);
    assert.ok(!r.error, r.error);
    assert.ok(r.crossings >= 1, 'the road hex is dug as a crossing');
    assert.ok(g.fieldworks.has(edge.a), 'no refusal or skip for the road');
    const n = network(g);
    assert.equal(n.pieces, 1, 'one work across the road');
    // trenches never change movement: the same road route, at the same cost
    g.nav.invalidate();
    const after = g.nav.route(from, to, HEAVY_GROUND);
    assert.ok(after?.length, 'the road is still driveable');
    assert.deepEqual(after.map((p) => tileAt(p.x, p.z)), before.map((p) => tileAt(p.x, p.z)));
    if (++checked >= 3) break;
  }
  assert.ok(checked >= 1, 'no road to cross');
});

test('a line drawn up to a road joins a trench crossing it; a bridge deck is never dug', async () => {
  const g = create();
  g.world.owner.fill(0);
  // a road hex with clear ground around it (a painted road: placement only reads world.road)
  for (let t = 0; t < 64 * 64; t += 7) {
    clear(g);
    const c = centerOf(t);
    if (!laidWhole(g, [{ x: c.x - 4, z: c.z }, { x: c.x + 4, z: c.z }])) continue;
    clear(g);
    g.world.road[t] = 1;
    const line = [{ x: c.x - 4, z: c.z }, { x: c.x + 4, z: c.z }];
    const r = stroke(g, line);
    assert.ok(!r.error && !r.skipped, 'the road hex is dug with the rest');
    assert.ok(g.fieldworks.has(t));
    // a line from the north ending against the road hex: one network
    const side = stroke(g, [{ x: c.x + .3, z: c.z + 4 }, { x: c.x + .3, z: c.z + 1.1 }]);
    if (side.error) { g.world.road[t] = 0; continue; }
    assert.equal(network(g).pieces, 1);
    // a road over a river is a bridge deck: skipped with its own reason, the line either side still joined
    clear(g);
    const river = g.world.river[t];
    g.world.river[t] = 1;
    const deck = g.command(0, { c: 'trenchWorld', points: line, preview: true });
    assert.ok(deck.reply.trench.skipped.some((s) => s.tile === t && s.why === 'bridge'));
    g.world.river[t] = river; g.world.road[t] = 0;
    return;
  }
  assert.fail('no clear ground for a road crossing');
});
