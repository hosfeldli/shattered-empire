// Headless reproduction of the bridge and city pathing faults (2026-11-18, docs/gameplay-overhaul/NAV_BRIDGES.md).
// Real procedural maps, seeded: the main sites are joined by roads (actionMap.connect, which lays the bridges with
// the road, so the scenario is the same before and after the "no crossings at match start" change), then ordinary
// player move orders are issued and simulated:
//   bridge   each wide-river bridge (flow >= 94, road-only for vehicles): a group of one class (or mixed) on one bank
//            ordered to the far bank, both directions, and two groups crossing against each other
//   city     player 0's developed start base (every parcel built, perimeter): groups ordered into the court, to the
//            HQ, out through the far side, and straight through the compound
// Per order: arrived / units (stopped within the group radius of the point, or within 1 of its own order slot), never (still moving at the end), halted (stopped short of the destination), gave up
// (stuck ladder), ratio (driven / shortest passable), seconds, route() calls and their ms.
// Usage: node tools/nav-bridge-city-repro.mjs [--size=96] [--seeds=3,7,11,41] [--bridges=3] [--seconds=150] [--only=bridge|city|wrecks|nowrecks] [--trace] [--verbose]
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
globalThis.SE_MAP_SIZE = Number(flags.size || 96);
globalThis.SE_WRAP = false;
const S = await import('../test/action-pathing-scenarios.mjs');
const sim = await S.loadSim();
const { connect } = await import('../server/sim/actionMap.js');
const seeds = String(flags.seeds || '3,7,11,41').split(',').map(Number);
const perSeed = Number(flags.bridges || 3), seconds = Number(flags.seconds || 150), verbose = !!flags.verbose;
const { NB, N, ACTION_UNITS, distance, centerOf, tileAt } = sim;

const GROUPS = {
  tanks: Array(6).fill('tank'),
  wheeled: ['armored_car', 'armored_car', 'scout_buggy', 'supply_truck', 'field_gun', 'armored_car'],
  infantry: Array(8).fill('rifle_squad'),
  mixed: ['tank', 'tank', 'armored_car', 'armored_car', 'rifle_squad', 'rifle_squad', 'rifle_squad', 'anti_armor', 'mech_infantry', 'scout_buggy'],
};

// The wreck hull as the client draws it (WarzoneRenderer.WreckScale x the WorldMeshes.Wreck / LightVehicleWreck extents),
// independent of the server's collision model: { hw, hl } half-width and half-length in world units.
function drawnHull(type) {
  const tracked = type.includes('tank') || type === 'sp_artillery';
  const s = tracked ? .235 : type === 'mech_infantry' || type === 'exo_infantry' ? .22 : ['supply_truck', 'missile_battery', 'air_defense'].includes(type) ? .2
    : type === 'armored_car' ? .19 : type === 'field_gun' ? .16 : type === 'scout_buggy' ? .14 : .17;
  return tracked ? { hw: .44 * s, hl: .5 * s } : { hw: .37 * s, hl: .455 * s };
}
// how deep a unit's disc reaches into a wreck's drawn hull (> 0: overlapping)
function wreckDepth(u, w, radius) {
  const dx = u.x - w.x, dz = u.z - w.z, sn = Math.sin(w.yaw || 0), cs = Math.cos(w.yaw || 0);
  const along = dx * sn + dz * cs, side = dx * cs - dz * sn, h = drawnHull(w.type);
  const ox = Math.max(0, Math.abs(side) - h.hw), oz = Math.max(0, Math.abs(along) - h.hl);
  const out = Math.hypot(ox, oz);
  return out > 0 ? radius - out : radius + Math.min(h.hw - Math.abs(side), h.hl - Math.abs(along));
}

function instrument(g) {
  const box = { routes: 0, ms: 0 }, route = g.nav.route.bind(g.nav);
  g.nav.route = (...a) => { const t0 = performance.now(); try { return route(...a); } finally { box.routes++; box.ms += performance.now() - t0; } };
  return box;
}

function clearUnits(g) { g.units.clear(); S.reindex(sim, g); }

function simulate(g, orders, { radius = null } = {}) {
  // orders: [{ units, point }] issued together
  const box = instrument(g), stuck0 = { ...(g.navStats?.stuck || {}) };
  for (const o of orders) {
    // members whose ground region (nav.componentOf) does not hold the destination cannot get there at all (a plateau,
    // the far side of an unbridged wide river): counted as cut off, not as failures
    o.cut = new Set(o.units.filter((u) => { const d = ACTION_UNITS[u.type], a = g.nav.componentOf(u.tile, d), b = g.nav.componentOf(tileAt(o.point.x, o.point.z), d); return a >= 0 && b >= 0 && a !== b; }).map((u) => u.id));
    o.reply = g.command(0, { c: 'move', units: o.units.map((u) => u.id), point: o.point });
    o.slot = new Map(o.units.filter((u) => u.goal).map((u) => [u.id, { ...u.goal }]));
    o.r = radius ?? 1.4 + Math.sqrt(o.units.length) * .32;
    o.arrival = new Map(); o.path = new Map(o.units.map((u) => [u.id, 0])); o.last = new Map(o.units.map((u) => [u.id, { x: u.x, z: u.z }]));
    o.optimal = new Map(o.units.map((u) => [u.id, S.optimalLength(sim, g, u, o.point, ACTION_UNITS[u.type])]));
  }
  let waiting = 0, tick = 0, overlap = 0, depthMax = 0;
  const wrecked = g.wrecks.size > 0;
  const ticks = Math.round(seconds / sim.DT);
  for (; tick < ticks; tick++) {
    g.tick(); g.outbox.length = 0;
    for (const o of orders) for (const u of o.units) {
      const p = o.last.get(u.id); o.path.set(u.id, o.path.get(u.id) + distance(p, u)); o.last.set(u.id, { x: u.x, z: u.z });
      if (u.waitingCrossing) waiting++;
      if (wrecked) for (let k = -1; k < 6; k++) {
        const t = k < 0 ? u.tile : NB[u.tile * 6 + k], list = t >= 0 && g.wrecks.get(t);
        if (list) for (const w of list) { const d = wreckDepth(u, w, ACTION_UNITS[u.type].radius); if (d > .03) overlap++; depthMax = Math.max(depthMax, d); }
      }
      if (flags.trace && tick % 15 === 0) { const h = (o.trace ??= new Map()).get(u.id) || []; h.push(`${tick}:${u.x.toFixed(2)},${u.z.toFixed(2)} t${u.tile}${g.world.river[u.tile] ? 'R' : ''}${g.world.road[u.tile] ? 'r' : ''} b${u.blocked} s${u.stall} p${u.path?.length ?? 0}${u.path?.[0] ? '>' + u.path[0].x.toFixed(2) + ',' + u.path[0].z.toFixed(2) : ''}${u.waitingCrossing ? ' W' : ''}${u.goal ? '' : ' X'}`); if (h.length > 30) h.shift(); o.trace.set(u.id, h); }
      if (!o.arrival.has(u.id) && !u.goal && u.hp > 0 && (distance(u, o.point) <= o.r || o.slot.has(u.id) && distance(u, o.slot.get(u.id)) <= 1)) o.arrival.set(u.id, (tick + 1) * sim.DT);
    }
    if (orders.every((o) => o.units.every((u) => o.arrival.has(u.id) || !u.goal))) break;
  }
  const out = { overlap, depthMax, cut: 0, units: 0, arrived: 0, never: 0, halted: 0, refused: 0, ratioMax: 0, ratioSum: 0, ratioN: 0, last: 0, waiting, routes: box.routes, routeMs: box.ms, detail: [] };
  for (const o of orders) {
    if (o.reply?.error) out.refused += o.units.length - o.cut.size;
    for (const u of o.units) {
      if (o.cut.has(u.id)) { out.cut++; continue; }
      out.units++;
      if (o.arrival.has(u.id)) {
        out.arrived++; out.last = Math.max(out.last, o.arrival.get(u.id));
        const ratio = o.path.get(u.id) / Math.max(.5, o.optimal.get(u.id));
        if (Number.isFinite(ratio)) { out.ratioMax = Math.max(out.ratioMax, ratio); out.ratioSum += ratio; out.ratioN++; }
      } else if (u.goal) {
        if (o.trace) out.detail.push(...o.trace.get(u.id).map((x) => '      ' + x)); out.never++; out.detail.push(`${u.type}#${u.id} moving ${distance(u, o.point).toFixed(1)} from goal at tile ${u.tile}`); }
      else { if (o.trace) out.detail.push(...o.trace.get(u.id).map((x) => '      ' + x)); out.halted++; out.detail.push(`${u.type}#${u.id} halted ${distance(u, o.point).toFixed(1)} from goal at tile ${u.tile}`); }
    }
  }
  const st = g.navStats?.stuck || {};
  out.gaveUp = (st.gaveUp || 0) - (stuck0.gaveUp || 0);
  out.unstick = (st.unstick || 0) - (stuck0.unstick || 0);
  out.seconds = tick * sim.DT;
  return out;
}

// --- bridge spans ------------------------------------------------------------------------------------------------
const wide = (g, t) => !!g.world.river[t] && !g.world.lake[t] && g.world.flow[t] >= 94;
function bridgeSpans(g) {
  const seen = new Set(), spans = [];
  for (const e of g.roads.edges.values()) for (const t of [e.a, e.b]) {
    if (seen.has(t) || !wide(g, t) || !g.world.road[t]) continue;
    // the span: road-connected wide-river tiles
    const tiles = [t]; seen.add(t);
    for (let i = 0; i < tiles.length; i++) for (let d = 0; d < 6; d++) {
      const n = NB[tiles[i] * 6 + d];
      if (n >= 0 && !seen.has(n) && wide(g, n) && g.roads.usable(tiles[i], n)) { seen.add(n); tiles.push(n); }
    }
    // the banks: road tiles off the span, walked 4 road steps out
    const banks = [];
    for (const s of tiles) for (let d = 0; d < 6; d++) {
      const n = NB[s * 6 + d];
      if (n < 0 || tiles.includes(n) || !g.roads.usable(s, n)) continue;
      let at = n, prev = s;
      for (let k = 0; k < 4; k++) {
        let next = -1;
        for (let dd = 0; dd < 6; dd++) { const m = NB[at * 6 + dd]; if (m >= 0 && m !== prev && !tiles.includes(m) && g.roads.usable(at, m) && !g.world.river[m]) { next = m; break; } }
        if (next < 0) break;
        prev = at; at = next;
      }
      banks.push(at);
    }
    if (banks.length >= 2) spans.push({ tiles, a: banks[0], b: banks[banks.length - 1] });
  }
  return spans;
}

// a standable spot beside the road near a bank tile, off the road by `off`
function bankPoint(g, t, def, off = .9) {
  const c = centerOf(t);
  for (const a of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const p = { x: c.x + Math.sin(a * Math.PI / 4) * off, z: c.z + Math.cos(a * Math.PI / 4) * off };
    if (g.nav.canStand(p.x, p.z, def) && !g.world.river[tileAt(p.x, p.z)]) return p;
  }
  return g.nav.nearest(c, def, 1.5);
}

const wreckNote = (r) => r.overlap || r.depthMax ? ` overlap ${r.overlap} depthMax ${r.depthMax.toFixed(3)}` : '';
function report(label, r) {
  const line = `${label.padEnd(44)} ${String(r.arrived).padStart(3)}/${String(r.units).padEnd(3)} cut ${r.cut} never ${r.never} halted ${r.halted} refused ${r.refused} gaveUp ${r.gaveUp} ratioMax ${r.ratioMax.toFixed(2)} last ${r.last.toFixed(0)}s wait ${r.waiting} routes ${r.routes} (${r.routeMs.toFixed(0)} ms)${wreckNote(r)}`;
  console.log(line);
  if (verbose) for (const d of r.detail) console.log('    ' + d);
}

const totals = {};
const add = (key, r) => {
  const t = totals[key] ??= { overlap: 0, depthMax: 0, cut: 0, units: 0, arrived: 0, never: 0, halted: 0, refused: 0, gaveUp: 0, ratioMax: 0, routes: 0, routeMs: 0, orders: 0, waiting: 0 };
  t.depthMax = Math.max(t.depthMax, r.depthMax);
  for (const k of ['overlap', 'cut', 'units', 'arrived', 'never', 'halted', 'refused', 'gaveUp', 'routes', 'routeMs', 'waiting']) t[k] += r[k];
  t.ratioMax = Math.max(t.ratioMax, r.ratioMax); t.orders++;
};

for (const seed of seeds) {
  let g;
  try { g = S.makeGame(sim, seed); } catch (e) { console.log(`seed ${seed}: ${e.message}`); continue; }
  g.sandbox = true;   // no victory checks: the harness clears units between orders
  const main = g.sites.filter((s) => s.slots);
  // the old country network: every main site joined to its nearest neighbour and to the centre ordering
  for (const s of main) {
    const others = main.filter((o) => o !== s).sort((a, b) => distance(s, a) - distance(s, b)).slice(0, 2);
    for (const o of others) connect(g, s.tile, o.tile);
  }
  g.nav.invalidate();
  if (!flags.only || flags.only === 'bridge' || flags.only === 'nowrecks') {
    const spans = bridgeSpans(g).slice(0, perSeed);
    console.log(`seed ${seed}: ${spans.length} wide-river bridges`);
    for (const [i, span] of spans.entries()) {
      for (const [name, types] of Object.entries(GROUPS)) for (const dir of [0, 1]) {
        clearUnits(g);
        const from = dir ? span.b : span.a, to = dir ? span.a : span.b;
        const d0 = ACTION_UNITS[types[0]];
        const start = bankPoint(g, from, d0, 1.1), goal = bankPoint(g, to, d0, .8);
        if (!start || !goal) continue;
        const units = S.placeBlock(sim, g, 0, types, start, .62);
        const r = simulate(g, [{ units, point: goal }]);
        report(`s${seed} bridge${i} ${name} ${dir ? 'B>A' : 'A>B'}`, r); add('bridge:' + name, r);
      }
      // two-way: tanks one way, wheeled the other, at once
      clearUnits(g);
      const dT = ACTION_UNITS.tank, pa = bankPoint(g, span.a, dT, 1.1), pb = bankPoint(g, span.b, dT, 1.1);
      if (pa && pb) {
        const west = S.placeBlock(sim, g, 0, GROUPS.tanks, pa, .62), east = S.placeBlock(sim, g, 0, GROUPS.wheeled, pb, .62);
        const r = simulate(g, [{ units: west, point: bankPoint(g, span.b, dT, .8) }, { units: east, point: bankPoint(g, span.a, dT, .8) }]);
        report(`s${seed} bridge${i} two-way`, r); add('bridge:two-way', r);
      }
      if (flags.only !== 'nowrecks') {
        // wrecks at both bridge ends (a fight at the crossing): beside the road, leaving one lane
        g.wrecks.clear();
        for (const s0 of span.tiles) for (let d = 0; d < 6; d++) {
          const n = NB[s0 * 6 + d];
          if (n < 0 || span.tiles.includes(n) || !g.roads.usable(s0, n)) continue;
          const c = centerOf(n), sc = centerOf(s0), ax = c.x - sc.x, az = c.z - sc.z, len = Math.hypot(ax, az), px = -az / len, pz = ax / len, yaw = Math.atan2(ax, az);
          g.wrecks.set(n, [{ type: 'tank', owner: 1, burn: 0, at: g.time, x: c.x + px * .42, z: c.z + pz * .42, yaw },
            { type: 'armored_car', owner: 1, burn: 0, at: g.time, x: c.x - px * .45 + ax / len * .3, z: c.z - pz * .45 + az / len * .3, yaw: yaw + .6 }]);
        }
        g.bfVer++; g.nav.invalidate();
        for (const name of ['tanks', 'wheeled', 'mixed']) for (const dir of [0, 1]) {
          clearUnits(g);
          const types = GROUPS[name], d0 = ACTION_UNITS[types[0]], from = dir ? span.b : span.a, to = dir ? span.a : span.b;
          const start = bankPoint(g, from, d0, 1.1), goal = bankPoint(g, to, d0, .8);
          if (!start || !goal) continue;
          const units = S.placeBlock(sim, g, 0, types, start, .62);
          const r = simulate(g, [{ units, point: goal }]);
          report(`s${seed} bridge${i} wrecked ${name} ${dir ? 'B>A' : 'A>B'}`, r); add('wrecks:bridge:' + name, r);
        }
        g.wrecks.clear(); g.bfVer++; g.nav.invalidate();
      }
    }
  }
  if (!flags.only || flags.only === 'city') {
    clearUnits(g);
    const site = S.developBase(sim, g);
    const hq = sim.bases.headquarters(g, site);
    const ring = (r, a) => ({ x: site.x + Math.sin(a) * r, z: site.z + Math.cos(a) * r });
    for (const [name, types] of Object.entries(GROUPS)) for (const a of [0, 2.1, 4.2]) {
      const def = ACTION_UNITS[types[0]];
      // in: from 6 out to the court beside the HQ
      clearUnits(g);
      let start = g.nav.nearest(ring(6, a), def, 1.5), goal = g.nav.nearest(ring(1.2, a + Math.PI), def, 1);
      if (start && goal) {
        const units = S.placeBlock(sim, g, 0, types, start, .62);
        const r = simulate(g, [{ units, point: goal }]); report(`s${seed} city in ${name} a${a}`, r); add('city:in:' + name, r);
      }
      // out: from the court to 6 out on the far side
      clearUnits(g);
      start = g.nav.nearest(ring(1.4, a), def, 1); goal = g.nav.nearest(ring(6, a + Math.PI), def, 1.5);
      if (start && goal) {
        const units = S.placeBlock(sim, g, 0, types, start, .5);
        const r = simulate(g, [{ units, point: goal }]); report(`s${seed} city out ${name} a${a}`, r); add('city:out:' + name, r);
      }
      // through: 6 out to 6 out on the other side
      clearUnits(g);
      start = g.nav.nearest(ring(6, a), def, 1.5); goal = g.nav.nearest(ring(6, a + Math.PI), def, 1.5);
      if (start && goal) {
        const units = S.placeBlock(sim, g, 0, types, start, .62);
        const r = simulate(g, [{ units, point: goal }]); report(`s${seed} city through ${name} a${a}`, r); add('city:through:' + name, r);
      }
    }
    void hq;
  }
  if (!flags.only || flags.only === 'wrecks') {
    // an open field strewn with wrecks (a finished tank battle), crossed west to east
    clearUnits(g);
    const area = S.paintArea(sim, g, sim.H - 30, 8, 24, 34);
    g.wrecks.clear();
    let k = 0;
    for (let r = 1; r < 23; r++) for (let c = 12; c <= 22; c += 2) {
      const p = area.point(r, c), h = ((seed * 7919 + k * 104729) % 1000) / 1000, t = sim.tileAt(p.x, p.z);
      const w = { type: k % 3 ? 'tank' : 'armored_car', owner: 1, burn: 0, at: g.time, x: p.x + (h - .5) * .8, z: p.z + ((h * 7) % 1 - .5) * .8, yaw: h * 6.28 };
      g.wrecks.set(sim.tileAt(w.x, w.z), [...(g.wrecks.get(sim.tileAt(w.x, w.z)) || []), w]); k++; void t;
    }
    g.bfVer++; g.nav.invalidate();
    for (const [name, types] of Object.entries(GROUPS)) for (const row of [6, 12, 18]) {
      clearUnits(g);
      const units = S.placeBlock(sim, g, 0, types, area.point(row, 4), .62);
      const r = simulate(g, [{ units, point: area.point(row, 30) }]);
      report(`s${seed} wreck field ${name} row${row}`, r); add('wrecks:field:' + name, r);
    }
    g.wrecks.clear(); g.bfVer++; g.nav.invalidate();
  }
}
console.log('\nTOTALS');
for (const [k, t] of Object.entries(totals)) console.log(`${k.padEnd(24)} arrived ${t.arrived}/${t.units} cut ${t.cut} never ${t.never} halted ${t.halted} refused ${t.refused} gaveUp ${t.gaveUp} ratioMax ${t.ratioMax.toFixed(2)} wait ${t.waiting} routes ${t.routes} ${t.routeMs.toFixed(0)} ms / ${t.orders} orders${wreckNote(t)}`);
if (flags.json) console.log(JSON.stringify(totals));
