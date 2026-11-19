// Roads and claims (2026-11-18, docs/gameplay-overhaul/ROADS_AND_CLAIMS.md): a match starts without roads between
// its sites (and, since NAV_BRIDGES.md, without bridges or other crossings), and establishing a headquarters on a captured city pays for and lays
// the road to the owner's nearest operational base.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SE_MAP_SIZE = 64;
globalThis.SE_WRAP = false;
const { ActionGame } = await import('../server/sim/actionGame.js');
const { ACTION_BUILDINGS, ACTION_UNITS } = await import('../server/sim/actionDefinitions.js');
const { headquarters } = await import('../server/sim/actionBases.js');
const { COMPOUND_SPOKE, ROAD_SEARCH, roadEdgesCost } = await import('../server/sim/actionMap.js');
const { distance, tileAt } = await import('../server/sim/actionNavigation.js');
const { NB, dist } = await import('../server/sim/hex.js');

const create = (seed = 41) => new ActionGame({ id: 'roads-claims', seed, style: 'pangaea', slots: [{ human: true }, { human: true }] });
function reindex(g) { g.movers.clear(); for (const u of g.units.values()) if (!ACTION_UNITS[u.type].air) g.movers.add(u); }
function place(g, owner, type, point) {
  const u = g.spawn(g.civs[owner], type, point, .5);
  assert.ok(u, `spawn ${type}`);
  u.x = point.x; u.z = point.z; u.tile = tileAt(u.x, u.z); reindex(g); return u;
}
// tiles reachable from `from` along usable road edges
function roadReach(g, from) {
  const seen = new Set([from]), queue = [from];
  for (let i = 0; i < queue.length; i++) for (let d = 0; d < 6; d++) {
    const n = NB[queue[i] * 6 + d];
    if (n >= 0 && !seen.has(n) && g.roads.usable(queue[i], n)) { seen.add(n); queue.push(n); }
  }
  return seen;
}
// capture the nearest neutral city with one rifle squad (the real capture path, which plans the claim road)
function claimNearest(g) {
  const home = g.sites[0];
  const site = g.sites.filter((s) => s.slots && s.owner < 0).sort((a, b) => distance(a, home) - distance(b, home) || a.id - b.id)[0];
  g.units.clear(); reindex(g);
  place(g, 0, 'rifle_squad', site);
  g.captureStep(site.captureTime + 1);
  assert.equal(site.owner, 0, 'captured');
  return { home, site };
}

for (const seed of [41, 7, 1234]) {
  test(`a fresh match has no road reaching any city or outpost (seed ${seed})`, () => {
    const g = create(seed), w = g.world;
    // a starting base's own compound streets reach no farther than COMPOUND_SPOKE hexes from its hub
    const starts = g.sites.filter((s) => s.owner >= 0);
    const street = (e) => starts.some((s) => dist(s.tile, e.a) <= COMPOUND_SPOKE && dist(s.tile, e.b) <= COMPOUND_SPOKE);
    // NAV_BRIDGES (2026-11-18): no bridge, causeway or cutting is laid at the start either: only compound streets
    for (const e of g.roads.edges.values()) assert.ok(street(e), `edge ${e.a}-${e.b} is a compound street`);
    for (let t = 0; t < w.road.length; t++) if (w.road[t]) assert.ok(!w.river[t] || w.lake[t], `no bridge at the start (hex ${t})`);
    for (const s of starts) assert.ok(g.roads.edgesOf(s.tile).length >= 1, `${s.name} has its compound streets`);
    for (const s of g.sites) {
      if (s.owner >= 0) continue;
      const near = [s.tile, ...(s.parcels || []).map((p) => p.tile)];
      for (const t of near) assert.equal(g.roads.edgesOf(t).length, 0, `${s.name} has no road`);
    }
    // every city is in reach on foot, and of a road (with its bridges) that vehicles could then follow
    const home = g.sites[0];
    for (const s of g.sites) if (s.slots && s !== home) {
      assert.ok(g.nav.strategic(home.tile, s.tile, { move: 'infantry', radius: .14 }, false, true, 1e9), `infantry reach ${s.name}`);
      assert.ok(g.nav.strategic(home.tile, s.tile, { move: 'tracked', radius: .22 }, true, false, ROAD_SEARCH), `a road can be built to ${s.name}`);
    }
  });
}

test('establishing a captured city charges the headquarters plus its road and builds that road to the nearest own base', () => {
  const g = create(), civ = g.civs[0];
  const { home, site } = claimNearest(g);
  const plan = site.claimRoad;
  assert.ok(plan && plan.edges.length > 2, 'a road is planned at capture');
  assert.equal(plan.to, home.id, 'to the nearest own base');
  assert.equal(plan.cost.materials, roadEdgesCost(g.world, plan.edges), 'ROAD_EDGE_COST a segment, ROAD_BRIDGE_COST a bridge segment');
  const town = ACTION_BUILDINGS.town.cost, total = town.materials + plan.cost.materials;
  // the price is published on the ruin
  const wire = g.siteWire(site, civ, true);
  assert.deepEqual({ materials: wire.settle.materials, energy: wire.settle.energy, road: wire.settle.road }, { materials: total, energy: town.energy || 0, road: plan.edges.length });
  // one material short: refused, nothing paid, the road named in the refusal
  civ.res = { materials: total - 1, energy: 1000 };
  const refused = g.command(0, { c: 'establish', site: site.id });
  assert.ok(refused.error && /road/.test(refused.error), refused.error);
  assert.equal(civ.res.materials, total - 1);
  assert.equal(site.hq, 0);
  // exactly enough: the headquarters starts and the road is queued, paid in full
  civ.res = { materials: total, energy: 1000 };
  const ok = g.command(0, { c: 'establish', site: site.id });
  assert.ok(!ok.error, ok.error);
  assert.equal(civ.res.materials, 0);
  assert.equal(civ.res.energy, 1000 - (town.energy || 0));
  const project = g.roadProjects.find((p) => p.auto && p.claim === site.id);
  assert.ok(project && plan.edges.every((e, i) => project.edges[i] === e), 'the claim road is an automatic road project');
  const inCompound = (e) => dist(site.tile, e.a) <= COMPOUND_SPOKE && dist(site.tile, e.b) <= COMPOUND_SPOKE;
  assert.ok(project.edges.slice(plan.edges.length).every(inCompound), 'plus the free compound streets');
  for (let i = 0; i < 400 && g.roadProjects.includes(project); i++) g.tick();
  assert.ok(!g.roadProjects.includes(project), 'the road is finished within a short time');
  assert.ok(roadReach(g, site.tile).has(home.tile), 'the claimed city is joined to the home base by road');
  // the finished headquarters does not lay a second, free link
  for (let i = 0; i < 1400 && !headquarters(g, site)?.done; i++) g.tick();
  assert.ok(headquarters(g, site)?.done, 'the headquarters is finished');
  assert.ok(!g.roadProjects.some((p) => p.auto && p.label?.startsWith(`Road from ${site.name}`)), 'no second link');
  // still no road to any unclaimed city
  for (const s of g.sites) if (s.slots && s.owner < 0) assert.equal(g.roads.edgesOf(s.tile).length, 0, `${s.name} stays unconnected`);
});

test('a city with no road route to its owner (an island) is established at the plain headquarters price, without a road', () => {
  const g = create(), civ = g.civs[0];
  const strategic = g.nav.strategic.bind(g.nav);
  g.nav.strategic = () => null;   // no heavy-vehicle route anywhere: the claimed city stands on another island
  const { site } = claimNearest(g);
  assert.equal(site.claimRoad?.edges.length || 0, 0, 'no road planned');
  assert.equal(g.siteWire(site, civ, true).settle.materials, ACTION_BUILDINGS.town.cost.materials);
  civ.res = { materials: ACTION_BUILDINGS.town.cost.materials, energy: 1000 };
  const ok = g.command(0, { c: 'establish', site: site.id });
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.road, 0);
  assert.equal(civ.res.materials, 0);
  const streets = g.roadProjects.filter((p) => p.claim === site.id).flatMap((p) => p.edges);
  assert.ok(streets.every((e) => dist(site.tile, e.a) <= COMPOUND_SPOKE && dist(site.tile, e.b) <= COMPOUND_SPOKE), 'only its own compound streets');
  g.nav.strategic = strategic;
});
