import { N, T, W, H, isWater } from './constants.js';
import { NB, disk, dist, hexLine, rOf, qOf, WRAP } from './hex.js';
import { hash2 } from './rng.js';
import { CAPTURE, OUTPOST_TYPES, RUIN_TYPES } from './actionDefinitions.js';
import { centerOf, distance, dxBetween, HEAVY_GROUND, LIGHT_GROUND, tileAt } from './actionNavigation.js';
import { MAP_SEED, mapPoint, mirrorTile, rotatePoint, rotateTile, siteTiles, symmetryOf, tileOf } from './authoredMaps.js';
import { ownedStarts, sketchGen, sketchMetrics } from './sketchMaps.js';

const NAMES = ['Ironford', 'Ashby Crossing', 'Gantry', 'Saltreach', 'Signal Point', 'Northlight', 'Hollowgate',
  'Cinderhold', 'Pylon Ridge', 'Dry Dock', 'Ember Station', 'Scrapton', 'Clearwater', 'Terminal', 'Quarry Nine',
  'Copperline', 'Last Bridge', 'Waystation', 'Coldwater', 'Cedar Valley', 'Breakwater', 'New Haven', 'Rustwater', 'Fallow Yard'];
const land = (w, t) => t >= 0 && !isWater(w.terr[t]) && !w.lake[t] && w.terr[t] < T.MOUNTAIN;
const parcel = (w, t) => land(w, t) && !w.river[t] && w.terr[t] !== T.MARSH;

export function planRing(w, tile, seed, siteId = 0) {
  const origin = centerOf(tile), phase = hash2(qOf(tile), rOf(tile), seed + 319) * Math.PI * 2;
  const parcels = [];
  let low = w.elev[tile], high = low;
  for (let i = 0; i < 8; i++) {
    const angle = phase + i * Math.PI / 4 + (hash2(tile, i, seed + 731) - .5) * .09;
    const radius = 1.88 + (hash2(tile, i, seed + 911) - .5) * .24;
    const x = origin.x + Math.sin(angle) * radius * 1.055, z = origin.z + Math.cos(angle) * radius * .965;
    const t = tileAt(x, z);
    for (const [ox, oz] of [[0, 0], [-.57, 0], [.57, 0], [0, -.57], [0, .57], [-.40, -.40], [.40, .40]]) {
      const n = tileAt(x + ox, z + oz);
      if (!parcel(w, n)) return null;
      low = Math.min(low, w.elev[n]); high = Math.max(high, w.elev[n]);
    }
    parcels.push({ id: siteId * 16 + i + 1, index: i, tile: t, x: +x.toFixed(4), z: +z.toFixed(4),
      yaw: +Math.atan2(origin.x - x, origin.z - z).toFixed(4), tier: i % 2 === 0 ? 1 : i === 1 || i === 5 ? 2 : 3,
      width: +(.92 + hash2(tile, i, seed + 441) * .09).toFixed(3), depth: +(.85 + hash2(tile, i, seed + 645) * .08).toFixed(3) });
  }
  return high - low > .30 ? null : parcels;
}

function districts(world) {
  const flags = new Uint8Array(N);
  const regions = [];
  for (let t = 0; t < N; t++) {
    if (flags[t] || !land(world, t)) continue;
    const group = [t];
    flags[t] = 1;
    for (let i = 0; i < group.length; i++) for (let d = 0; d < 6; d++) {
      const n = NB[group[i] * 6 + d];
      if (!land(world, n) || flags[n]) continue;
      flags[n] = 1;
      group.push(n);
    }
    regions.push(group);
  }
  return regions.sort((a, b) => b.length - a.length);
}

function quality(w, t) {
  let river = 0, coast = 0, hill = 0;
  for (const n of disk(t, 2)) {
    if (w.river[n]) river++;
    if (isWater(w.terr[n]) || w.lake[n]) coast++;
    if (w.terr[n] === T.HILLS || w.terr[n] === T.MOUNTAIN) hill++;
  }
  const parks = w.terr[t] === T.GRASS || w.terr[t] === T.PLAINS ? .9 : 0;
  return { river, coast, hill, score: Math.min(3, river) * .70 + Math.min(3, coast) * .20 + Math.min(4, hill) * .21 + parks };
}

// Natural relief: a mountain is a massif, not one hex standing as a spire. Lone spikes are capped near their
// neighbours, then high ground spreads outward in steps (shoulders, then foothills), so every peak rises
// from slopes several hexes wide. Water, lakes and rivers are never raised.
function massifs(w) {
  const wet = (t) => isWater(w.terr[t]) || w.lake[t] || w.river[t];
  const touched = new Set();
  for (let t = 0; t < N; t++) {
    if (wet(t) || w.elev[t] < .3) continue;
    let high = -1, sum = 0, n = 0;
    for (const m of disk(t, 1)) if (m !== t) { high = Math.max(high, w.elev[m]); sum += w.elev[m]; n++; }
    const cap = Math.max(high + .16, sum / Math.max(1, n) + .24);
    if (w.elev[t] > cap) { w.elev[t] = cap; touched.add(t); }
  }
  for (let pass = 0; pass < 4; pass++) {
    const next = Float32Array.from(w.elev);
    for (let t = 0; t < N; t++) {
      if (wet(t)) continue;
      let need = w.elev[t];
      for (const m of disk(t, 1)) if (m !== t && w.elev[m] > .3) need = Math.max(need, w.elev[m] - (w.elev[m] > .55 ? .12 : .16));
      if (need > w.elev[t] + 1e-4) { next[t] = need; touched.add(t); }
    }
    w.elev.set(next);
  }
  for (const t of touched) { w.classify(t); w.touch(t); }
}

// Dense forest (directive §30, 2026-11-18). Ordinary infantry (move class 'infantry') cannot enter a dense-forest
// hex (actionNavigation.cost / roadOnly); vehicles can, and heavy hulls clear it as before (battlefield.js
// FOREST_CLEAR), after which the hex is grass and open to everyone. A road through dense forest stays open along it.
// Which hexes are dense is decided once, at map creation, and saved (world.dense, persist.js):
//  - interior forest only: a FOREST hex whose six neighbours are all FOREST, so every dense core sits inside a
//    passable fringe of ordinary (lighter) forest and a detour around it is always short;
//  - never on a road, river or lake hex, nor within `siteGap` hexes of a base or outpost;
//  - every `lane`-th hex row and column stays open (a footpath grid), which splits large forests into groves of at
//    most (lane - 1) hexes across: the longest possible detour around one is a few hexes;
//  - cores smaller than `minCore` hexes are dropped (no scattered single dense hexes);
//  - on authored (symmetric) maps a hex stays dense only if all its symmetric images are (no seat is favoured);
//  - guarantee: infantry connectivity is unchanged. Every hex infantry could reach from another before still
//    reaches it: any pocket the cores would enclose has its surrounding cores opened (repeated until none remain).
// Cleared or terrain-changed hexes stop being dense because the check also requires terr === FOREST.
export const DENSE_FOREST = Object.freeze({ siteGap: 3, lane: 5, minCore: 3, rounds: 12 });
// Ticket 4: `opts` overrides the constants (a custom map's thick dense forest: wider lanes, so bigger groves)
export function markDenseForest(game, opts = {}) {
  const w = game.world, nav = game.nav, dense = new Uint8Array(N), { siteGap, lane, minCore } = { ...DENSE_FOREST, ...opts };
  const keep = new Uint8Array(N);
  for (const s of game.sites || []) for (const t of disk(s.tile, siteGap)) if (t >= 0) keep[t] = 1;
  const roadTile = (t) => { for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && game.roads.get(t, n)) return true; } return false; };
  for (let t = 0; t < N; t++) {
    if (w.terr[t] !== T.FOREST || keep[t] || w.river[t] || w.lake[t] || qOf(t) % lane === 0 || rOf(t) % lane === 0 || roadTile(t)) continue;
    let interior = true;
    for (let d = 0; d < 6 && interior; d++) { const n = NB[t * 6 + d]; if (n < 0 || w.terr[n] !== T.FOREST) interior = false; }
    if (interior) dense[t] = 1;
  }
  // drop small cores
  const seen = new Uint8Array(N), stack = [], group = [];
  for (let s = 0; s < N; s++) {
    if (!dense[s] || seen[s]) continue;
    group.length = 0; seen[s] = 1; stack.push(s);
    while (stack.length) {
      const t = stack.pop(); group.push(t);
      for (let d = 0; d < 6; d++) { const n = NB[t * 6 + d]; if (n >= 0 && dense[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
    }
    if (group.length < minCore) for (const t of group) dense[t] = 0;
  }
  symmetrize(w, dense);
  // connectivity guarantee: infantry regions before (no dense forest) and after
  w.dense = null; nav.invalidate();
  nav.componentOf(0, LIGHT_GROUND);
  const before = nav.components.infantry;
  w.dense = dense;
  for (let round = 0; round <= DENSE_FOREST.rounds; round++) {
    nav.invalidate();
    nav.componentOf(0, LIGHT_GROUND);
    const after = nav.components.infantry;
    // the main post-dense region of each pre-dense region: the one holding most of its hexes (ties: lower id)
    const tally = new Map();
    for (let t = 0; t < N; t++) if (before[t] > 0 && after[t] > 0) { const k = before[t] * 4194304 + after[t]; tally.set(k, (tally.get(k) || 0) + 1); }
    const main = new Map();
    for (const [k, n] of tally) {
      const b = Math.floor(k / 4194304), a = k % 4194304, m = main.get(b);
      if (!m || n > m.n || n === m.n && a < m.a) main.set(b, { a, n });
    }
    let opened = 0;
    for (let t = 0; t < N; t++) {
      if (!(before[t] > 0) || dense[t] && w.terr[t] === T.FOREST || after[t] === main.get(before[t])?.a) continue;
      // t is cut off: open the dense hexes around it (the last round opens every core that touches a pocket)
      for (let d = 0; d < 6; d++) {
        const n = NB[t * 6 + d];
        if (n < 0 || !dense[n]) continue;
        if (round < DENSE_FOREST.rounds) { dense[n] = 0; opened++; continue; }
        stack.push(n); dense[n] = 0; opened++;
        while (stack.length) { const c = stack.pop(); for (let e = 0; e < 6; e++) { const m = NB[c * 6 + e]; if (m >= 0 && dense[m]) { dense[m] = 0; opened++; stack.push(m); } } }
      }
    }
    if (!opened) break;
  }
  symmetrize(w, dense);   // opening never encloses anything, so connectivity still holds
  nav.invalidate();
  return dense;
}

// Authored maps are symmetric (mirror, or 3- / 4-fold rotation); the lane grid is not. A hex stays dense only when
// all its symmetric images are dense too, so no seat gets a different forest.
function symmetrize(w, dense) {
  if (!w.mapDef) return;
  const n = symmetryOf(w.mapDef), drop = [];
  for (let t = 0; t < N; t++) if (dense[t]) for (let k = 1; k < n; k++) { const m = rotateTile(t, k, n); if (m < 0 || !dense[m]) { drop.push(t); break; } }
  for (const t of drop) dense[t] = 0;
}

/** Wire form of world.dense for the welcome message (`world.dense`): base64 of a bitset, hex t = bit (t & 7) of byte
 *  t >> 3. Sent once; a hex is dense while its bit is set AND its terrain is still FOREST (clearing only removes). */
export function denseWire(w) {
  if (!w.dense) return undefined;
  const bits = new Uint8Array((N + 7) >> 3);
  for (let t = 0; t < N; t++) if (w.dense[t] && w.terr[t] === T.FOREST) bits[t >> 3] |= 1 << (t & 7);
  return Buffer.from(bits).toString('base64');
}

/** Whether infantry are barred from hex t by dense forest (world.dense, still FOREST). */
export const denseForest = (w, t) => !!w.dense?.[t] && w.terr[t] === T.FOREST;

export function buildActionMap(game) {
  const { world: w, civs, seed } = game;
  if (w.mapDef) return buildAuthoredMap(game, w.mapDef);
  massifs(w);
  // a map-builder sketch (sketchMaps.js): every painted base is a start; fewer players leave spares neutral
  const sketch = w.sketch || null;
  // Ticket 4: a sketch's generation options and hand-placed points of interest (sketchMaps.js SKETCH_GEN, pois)
  const gen = sketch ? sketchGen(sketch) : null;
  const pois = gen ? gen.pois : [];
  if (sketch && civs.length > sketch.bases.length) throw new Error(`This custom map has ${sketch.bases.length} bases (this match has ${civs.length} players).`);
  const starts = sketch ? sketch.bases.length : civs.length;
  // Bigger maps carry proportionally more cities and outposts, so larger armies have more to fight over.
  const density = Math.min(1.8, .55 + W / 140);
  const desired = Math.min(24, Math.round((4 + starts * 2) * density));
  // a procedural world plays on its largest landmass; a sketch's bases may stand on any painted continent
  // or island (only the largest one gave a base on a second continent a site on the first)
  const area = sketch ? districts(w).flat() : districts(w)[0] || [];
  const candidates = area.filter((t) => {
    const q = qOf(t), r = rOf(t);
    // A city needs a connected land apron for its buildings and army. Thin spits
    // surrounded by several lake cells produced flooded-looking compounds and
    // bridge tangles, even when the centre happened to be legally dry.
    return parcel(w, t) && r >= 3 && r < H - 3 && (WRAP || q >= 3 && q < W - 3)
      && disk(t, 1).filter((n) => parcel(w, n)).length >= 5
      && disk(t, 2).every((n) => parcel(w, n)) && planRing(w, t, seed) != null;
  }).map((tile) => ({ tile, ...centerOf(tile), ...quality(w, tile), noise: hash2(qOf(tile), rOf(tile), seed) }));
  if (candidates.length < starts + 2) throw new Error(sketch ? 'This custom map has too little open land for its bases: paint broader landmasses.' : 'This world does not have enough connected land for an action RTS match.');
  // Bases stand clearly apart: the minimum gap between city ruins grows with the world (the compact
  // 64-hex test/sandbox map keeps its original spacing), and starts sit on a wider ring.
  const gap = W <= 64 ? 6.2 : Math.min(13, 8.2 + (W - 80) * .045);
  const goalRadius = (starts <= 2 ? 20 : starts <= 4 ? 24 : 31) * Math.max(1, W / 90) * (W <= 64 ? 1 : 1.18);
  const central = candidates.reduce((a, b) => {
    const rating = (p) => p.score + p.noise * .4 - Math.hypot(qOf(p.tile) - W / 2, rOf(p.tile) - H / 2) * .15
      + Math.min(18, disk(p.tile, 4).filter((t) => parcel(w, t)).length) * .09;
    return rating(b) > rating(a) ? b : a;
  });
  // One flood fill answers "can a road reach this candidate from the centre" for every candidate. The
  // former per-candidate A* (capped at a few thousand nodes) failed thousands of times on large maps.
  let reach = reachable(game, central.tile, HEAVY_GROUND);
  const angle = hash2(27, 13, seed) * Math.PI * 2;
  const occupied = new Set();
  const locations = [];
  if (sketch) {
    // each painted base takes the nearest buildable city site, the bases kept a city gap apart
    for (let i = 0; i < starts; i++) {
      const at = mapPoint(sketch.bases[i]);
      let best = null, bd = Infinity;
      for (const c of candidates) {
        if (occupied.has(c.tile) || !locations.every((o) => distance(o, c) >= gap)) continue;
        const d = distance(at, c);
        if (d < bd) { bd = d; best = c; }
      }
      if (!best) throw new Error(`This custom map has no room for base ${i + 1}: give it more open land.`);
      locations.push({ ...best, start: i });
      occupied.add(best.tile);
    }
    // the bases' own landmasses (islands too) are where expansions, outposts and roads may go
    reach = Uint8Array.from(reach);
    for (const b of locations) { const r = reachable(game, b.tile, HEAVY_GROUND); for (let t = 0; t < N; t++) reach[t] |= r[t]; }
    // Ticket 4: the neutral cities the builder placed take the nearest free city site (a little closer than the base gap)
    for (const [u, v, kind] of pois) {
      if (kind !== 'city') continue;
      const at = mapPoint([u, v]);
      let best = null, bd = Infinity;
      for (const c of candidates) {
        if (occupied.has(c.tile) || !locations.every((o) => distance(o, c) >= gap * .9)) continue;
        const d = distance(at, c);
        if (d < bd) { bd = d; best = c; }
      }
      if (!best || bd > gap * 1.5) continue;   // no room near that point: skipped rather than moved far away
      locations.push({ ...best, manual: true });
      occupied.add(best.tile);
      const r = reachable(game, best.tile, HEAVY_GROUND); for (let t = 0; t < N; t++) reach[t] |= r[t];
    }
  }
  const autoCities = gen?.cities !== false;
  for (let i = 0; i < starts && !sketch; i++) {
    const a = angle + i * Math.PI * 2 / starts, tx = Math.cos(a), tz = Math.sin(a);
    const broad = candidates.filter((p) => disk(p.tile, 1).filter((n) => parcel(w, n)).length >= 6);
    const ranked = (broad.length >= starts ? broad : candidates).filter((p) => !occupied.has(p.tile)).map((p) => {
      const x = dxBetween(central.x, p.x), z = p.z - central.z;
      const range = Math.hypot(x, z);
      const sep = locations.length ? Math.min(...locations.map((o) => distance(o, p))) : goalRadius * 1.7;
      const score = -Math.hypot(x - tx * goalRadius, z - tz * goalRadius) - Math.max(0, goalRadius * .96 - sep) * 4
        - Math.max(0, goalRadius * .63 - range) * 5 + p.noise + p.score * .22;
      return { p, score };
    }).sort((a, b) => b.score - a.score || a.p.tile - b.p.tile);
    // Starts keep a hard minimum distance (the ring's chord, a little relaxed): the separation term above is
    // only a penalty, and on a world whose road-reachable land is one compact island (archipelago seeds) the
    // best-scored reachable candidates could stack three capitals on neighbouring hexes. Relax the gap step
    // step by step down to the base gap; below that a start apart from the others beats a reachable one.
    let start = null;
    const apart = (p, min) => Math.min(...locations.map((o) => distance(o, p))) >= min;
    if (locations.length) {
      for (let minSep = goalRadius * Math.min(1, 2 * Math.sin(Math.PI / starts)) * .9; !start && minSep >= gap; minSep *= .85)
        start = ranked.find(({ p }) => reach[p.tile] && apart(p, minSep))?.p || null;
      start ||= ranked.find(({ p }) => apart(p, gap * 1.6))?.p || ranked.find(({ p }) => apart(p, gap))?.p || null;
    }
    start ||= ranked.find(({ p }) => reach[p.tile])?.p || ranked[0].p;
    locations.push({ ...start, start: i });
    occupied.add(start.tile);
  }
  if (autoCities && !occupied.has(central.tile) && (!sketch || locations.every((o) => distance(o, central) >= gap * 1.5))) { locations.push(central); occupied.add(central.tile); }
  // Give each start a nearby expansion with room to maneuver, then fill the contested region.
  for (let i = 0; i < starts && autoCities && locations.length < desired; i++) {
    const start = locations[i];
    const preferred = { x: start.x + dxBetween(start.x, central.x) * .48, z: start.z + (central.z - start.z) * .48 };
    // the best-ranked candidate (score, then tile), found in one pass rather than by sorting them all
    let p = null, top = -Infinity;
    for (const c of candidates) {
      if (!reach[c.tile] || !locations.every((o) => distance(o, c) >= gap * .9)) continue;
      const score = c.score + c.noise * .7 - distance(c, preferred) * .42;
      if (score > top || score === top && c.tile < p.tile) { top = score; p = c; }
    }
    if (p) { locations.push(p); occupied.add(p.tile); }
  }
  while (autoCities && locations.length < desired) {
    let p = null, top = -Infinity;
    for (const c of candidates) {
      if (!reach[c.tile]) continue;
      let sep = Infinity;
      for (const o of locations) { const d = distance(o, c); if (d < sep) sep = d; if (d < gap) break; }
      if (sep < gap) continue;
      const score = c.score * 1.5 + c.noise + Math.min(gap * 2.1, sep) * .41 - Math.max(0, distance(c, central) - goalRadius * 1.13) * .7;
      if (score > top || score === top && c.tile < p.tile) { top = score; p = c; }
    }
    if (!p) break;
    locations.push(p);
    occupied.add(p.tile);
  }
  if (sketch) {
    // Seat the civs on the bases (chooseStarts over the sketch's own metrics, as the lobby preview does):
    // their starts first in civ order, the spare bases next as neutral cities, then everything else.
    const { steps, reach: baseReach } = sketchMetrics(sketch);
    // 2026-11-18: a sketch that assigns its bases to teams seats each team on its own bases (MAP_BUILDER_TEAMS.md)
    const civStart = sketch.owners ? ownedStarts(sketch.owners, civs.map((c) => c.team)) : chooseStarts(steps, baseReach, sketch.bases.map((_, i) => i), civs.map((c) => c.team));
    const taken = new Set(civStart);
    const bases = locations.slice(0, starts), rest = locations.slice(starts);
    locations.length = 0;
    locations.push(...civStart.map((b, civ) => ({ ...bases[b], start: civ })),
      ...bases.filter((_, b) => !taken.has(b)).map((p) => ({ ...p, start: undefined })), ...rest);
  }

  // Ticket 4: without generated cities the placed city nearest the centre is the metropolis (the Operation objective)
  const metroTile = autoCities ? central.tile : locations.filter((p) => p.start === undefined && p.manual).sort((a, b) => distance(a, central) - distance(b, central) || a.tile - b.tile)[0]?.tile;
  const sites = locations.map((p, i) => {
    const natural = () => p.coast >= 4 ? RUIN_TYPES[4] : p.river >= 2 ? RUIN_TYPES[1] : p.hill >= 5 ? RUIN_TYPES[3] : p.noise > .71 ? RUIN_TYPES[5] : RUIN_TYPES[0];
    // Ticket 4: a sketch's ruins setting picks the neutral cities' kind (city: metropolitan and industrial ruins,
    // residential: provincial towns, farm: farmsteads; mixed: from the ground, as before)
    const styled = () => gen?.ruins === 'city' ? (p.noise > .5 ? RUIN_TYPES[2] : RUIN_TYPES[1]) : gen?.ruins === 'residential' ? RUIN_TYPES[0]
      : gen?.ruins === 'farm' ? RUIN_BY_KEY.farm : natural();
    const kind = p.start !== undefined ? RUIN_TYPES[1] : p.tile === metroTile ? RUIN_TYPES[2] : styled();
    const ring = planRing(w, p.tile, seed, i + 1);
    if (!ring || ring.length !== 8) throw new Error('A city ruin must support its complete eight-site ring.');
    const slots = [...ring].sort((a, b) => a.tier - b.tier || a.index - b.index).map((p) => p.id);
    for (const lot of ring) occupied.add(lot.tile);
    const name = NAMES[(i + Math.abs(seed % NAMES.length)) % NAMES.length];
    return { id: i + 1, tile: p.tile, x: p.x, z: p.z, name, kind: kind.key, ruin: kind.ruin, start: p.start,
      radius: 1.35, captureTime: CAPTURE.base, owner: -1, by: -1, progress: 0, last: 0, contested: false, hq: 0, tier: 1,
      slots, core: 4, ringVersion: 1, developedAt: 0, visualTier: 1,
      parcels: [{ id: 0, index: -1, tile: p.tile, x: p.x, z: p.z, yaw: ring[0].yaw, tier: 1, width: 1.12, depth: 1.12 }, ...ring], claimedAt: -1 };
  });
  gradeSites(w, sites);
  game.nav.invalidate();
  const outposts = ['energy', 'supply', 'radar', 'repair', 'defense'];
  const count = gen?.outposts === false ? 0 : Math.min(28, Math.round((starts * 2 + 3) * density));
  // Outposts keep their distance from the cities in proportion to the wider base spacing.
  const spread = gap / 6.2;
  for (let i = 0; i < count; i++) {
    const base = sites[i % locations.length];
    let p = null, top = Infinity;
    for (const c of candidates) {
      const d = distance(c, base);
      if (d < 3.6 * spread || d >= 10 * spread || occupied.has(c.tile) || !reach[c.tile]) continue;
      const key = Math.abs(d - 5 * spread);
      if (key > top || key === top && c.noise <= p.noise) continue;
      if (!sites.every((s) => distance(s, c) >= (s.slots ? 3.5 : 4.6) * spread)) continue;
      top = key; p = c;
    }
    if (!p) continue;
    const kind = i < starts ? 'energy' : outposts[(i - starts + 1) % outposts.length], info = OUTPOST_TYPES[kind];
    occupied.add(p.tile);
    sites.push({ id: sites.length + 1, tile: p.tile, x: p.x, z: p.z, name: info.name, kind, ruin: info.ruin,
      radius: .91, captureTime: CAPTURE.outpost, owner: -1, by: -1, progress: 0, last: 0, contested: false, claimedAt: -1 });
  }

  // Ticket 4: the outposts the builder placed, each on the nearest free buildable ground to its point
  for (const [u, v, kind] of pois) {
    if (!OUTPOST_TYPES[kind]) continue;
    const at = mapPoint([u, v]);
    let p = null, bd = Infinity;
    for (const c of candidates) {
      if (occupied.has(c.tile) || !sites.every((s) => distance(s, c) >= (s.slots ? 3.4 : 2.2))) continue;
      const d = distance(at, c);
      if (d < bd || d === bd && c.tile < p.tile) { bd = d; p = c; }
    }
    if (!p || bd > 6) continue;
    const info = OUTPOST_TYPES[kind];
    occupied.add(p.tile);
    sites.push({ id: sites.length + 1, tile: p.tile, x: p.x, z: p.z, name: info.name, kind, ruin: info.ruin,
      radius: .91, captureTime: CAPTURE.outpost, owner: -1, by: -1, progress: 0, last: 0, contested: false, claimedAt: -1 });
  }
  // ... and its supply caches and power supplies (laid by actionEconomy.seedMaterialCaches)
  game.manualCaches = pois.filter(([, , kind]) => kind === 'cache' || kind === 'power').map(([u, v, kind]) => ({ ...mapPoint([u, v]), kind }));

  w.starts = sites.slice(0, civs.length).map((s) => s.tile);
  const main = sites.filter((s) => s.slots);
  const corridors = [];
  const hubs = main.map((s) => s.tile);
  // 2026-11-18 (roads & claims, docs/gameplay-overhaul/ROADS_AND_CLAIMS.md): the corridors between the cities
  // are planned (they still shape the coast) but not paved: no road leads to an unclaimed city, so roads cannot
  // be followed to find one. Nor are their crossings laid any more (NAV_BRIDGES.md, 2026-11-18): a bridge, causeway
  // or cutting exists only once a road through it is built (a claim road, a player's road, an engineer's road).
  const link = (a, b) => corridors.push(...(hubRoute(w, game.nav.strategic(a, b, HEAVY_GROUND, true, false, ROAD_SEARCH), hubs) || []));
  const linked = new Set([main.find((s) => s.tile === central.tile) || main[0]]);
  while (linked.size < main.length) {
    let pair = null, best = Infinity;
    for (const a of linked) for (const b of main) {
      if (linked.has(b)) continue;
      const d = distance(a, b);
      if (d < best) { best = d; pair = [a, b]; }
    }
    if (!pair) break;
    link(pair[0].tile, pair[1].tile);
    linked.add(pair[1]);
  }
  for (const s of main) {
    // A second connection gives a flank even when a bridge on the shortest route falls.
    const other = main.filter((b) => b !== s).sort((a, b) => distance(s, a) - distance(s, b))[1];
    if (other && distance(s, other) < 24 * Math.max(1, gap / 6.2)) link(s.tile, other.tile);
  }
  // a sketch's coast is the player's design: it is not pulled in around the objectives
  if (!sketch) compactBattlefield(game, sites, corridors);
  for (const site of sites) game.addRuin(site.tile, site.ruin, -1, site.name);
  game.nav.invalidate();
  return sites;
}

function reachable(game, from, def) {
  const w = game.world, seen = new Uint8Array(N), queue = [from];
  seen[from] = 1;
  for (let i = 0; i < queue.length; i++) for (let d = 0; d < 6; d++) {
    const n = NB[queue[i] * 6 + d];
    if (n < 0 || seen[n]) continue;
    const c = centerOf(n);
    // Same passability as road planning: dry ground a heavy vehicle can climb, or a bridgeable river.
    if (!Number.isFinite(game.nav.cost(n, c.x, c.z, def)) && !(w.river[n] && !w.lake[n] && !isWater(w.terr[n]))) continue;
    seen[n] = 1; queue.push(n);
  }
  return seen;
}

export const ROAD_SEARCH = N;
/** Materials per paved road segment (hex edge): player roads (actionEconomy.roadBuild) and claim roads (actionBases). */
export const ROAD_EDGE_COST = 15;
/**
 * NAV_BRIDGES (2026-11-18): a road segment with an end on a river hex is a bridge, laid with the road (matches start
 * without bridges). It costs ROAD_BRIDGE_COST instead of ROAD_EDGE_COST: a crossing of one river hex is two such
 * segments (bank, river, bank), 80 Materials against 30 for the same length of plain road. Marsh causeways and slope
 * cuttings are ordinary road segments. Shared by player roads (actionEconomy.roadBuild, actionEngineers.roadRouteBetween)
 * and claim roads (actionBases.planClaimRoad).
 */
export const ROAD_BRIDGE_COST = 40;
export const isBridgeSegment = (w, a, b) => !!(w.river[a] && !w.lake[a] || w.river[b] && !w.lake[b]);
export const roadEdgeCost = (w, a, b) => (isBridgeSegment(w, a, b) ? ROAD_BRIDGE_COST : ROAD_EDGE_COST);
/** Materials for a list of road segments [{ a, b }]. */
export const roadEdgesCost = (w, edges) => { let c = 0; for (const e of edges) c += roadEdgeCost(w, e.a, e.b); return c; };

export const hubTiles = (game) => (game.sites || []).filter((s) => s.slots).map((s) => s.tile);
const HUB_REACH = 2;
const spokeTile = (w, t) => t >= 0 && !isWater(w.terr[t]) && !w.lake[t] && w.terr[t] < T.MOUNTAIN;

/**
 * 2026-11-18 (ROADS_AND_CLAIMS.md): a base's own compound streets. Three straight spokes from the hub along alternate
 * hex directions, each COMPOUND_SPOKE hexes long: they end just past the compound edge (the client's 3.6 skip
 * radius), so heavy hulls have drivable corridors between the facilities, and they point at nothing (the same
 * star at every base; the triple with more buildable spokes, ties by a hash of the tile). Returns the missing edges
 * [{ a, b }]; the caller lays them (map start) or queues them (a newly established base).
 */
export const COMPOUND_SPOKE = 3;
export function compoundSpokes(game, site) {
  const w = game.world, spokes = [];
  for (let d = 0; d < 6; d++) {
    const line = [site.tile];
    // NAV_BRIDGES (2026-11-18): never over a river hex either, so no street is a bridge at the start
    for (let k = 0; k < COMPOUND_SPOKE; k++) { const n = NB[line[line.length - 1] * 6 + d]; if (!spokeTile(w, n) || w.river[n]) break; line.push(n); }
    spokes.push(line.length === COMPOUND_SPOKE + 1 ? line : null);
  }
  const count = (from) => [0, 2, 4].filter((k) => spokes[from + k]).length;
  // ties: the triple with a spoke toward the map centre, so a half-turned twin base takes the half-turned star
  const c = centerOf(site.tile), mid = { x: W * Math.sqrt(3) / 2, z: H * .75 };
  let inward = 0, top = -Infinity;
  for (let d = 0; d < 6; d++) {
    const n = NB[site.tile * 6 + d]; if (n < 0) continue;
    const p = centerOf(n), dot = dxBetween(c.x, p.x) * dxBetween(c.x, mid.x) + (p.z - c.z) * (mid.z - c.z);
    if (dot > top) { top = dot; inward = d; }
  }
  const first = count(0) !== count(1) ? (count(0) > count(1) ? 0 : 1) : inward % 2;
  const edges = [];
  for (const k of [0, 2, 4]) {
    const line = spokes[first + k]; if (!line) continue;
    for (let i = 1; i < line.length; i++) {
      const e = game.roads.get(line[i - 1], line[i]);
      if (!(e && e.cond >= 60 && e.type >= 2)) edges.push({ a: line[i - 1], b: line[i] });
    }
  }
  return edges;
}

/**
 * The compound streets a held base lays (map start, establish, New Base): the canonical star (compoundSpokes), the
 * same at every base, so it points at nothing (the old spokes ran toward the neighbouring cities, which on a small
 * map covered half the way to the nearest one). An edge within a hex of another site is dropped, so no street
 * touches a city or outpost. Returns the missing or ruined edges [{ a, b }].
 */
export function baseStreets(game, site) {
  const edges = compoundSpokes(game, site);
  const others = (game.sites || []).filter((s) => s !== site);
  return edges.filter(({ a, b }) => {
    const e = game.roads.get(a, b);
    if (e && e.cond >= 60 && e.type >= 2) return false;
    return others.every((s) => dist(s.tile, a) > 1 && dist(s.tile, b) > 1);
  });
}

// Roads meet a base at its hub. Inside a compound (two hexes of the centre) a route runs as a straight
// spoke to the centre tile and leaves by another spoke, so every road that reaches a base joins the
// others at one junction inside the ring road: no tangents along the ring, no parallel approaches
// and no stub that stops at the ring. Spokes only cross dry, buildable ground; otherwise the planned
// course inside that compound is kept.
export function hubRoute(w, route, hubs) {
  if (!route || route.length < 2 || !hubs?.length) return route;
  const out = [];
  for (let i = 0; i < route.length;) {
    const hub = hubs.find((h) => dist(h, route[i]) <= HUB_REACH);
    if (hub === undefined) { out.push(route[i++]); continue; }
    let j = i;
    while (j + 1 < route.length && dist(hub, route[j + 1]) <= HUB_REACH) j++;
    const before = out.length ? out[out.length - 1] : -1, after = j + 1 < route.length ? route[j + 1] : -1;
    const into = before >= 0 ? hexLine(before, hub).slice(1) : hexLine(route[i], hub);
    const away = after >= 0 ? hexLine(hub, after).slice(1, -1) : [];
    const spoke = [...into, ...away];
    if (spoke.every((t) => spokeTile(w, t)) && new Set(spoke).size === spoke.length) out.push(...spoke);
    else out.push(...route.slice(i, j + 1));
    i = j + 1;
  }
  // a spoke can revisit a tile the route already used just before the compound: drop such loops
  const clean = [];
  for (const t of out) {
    const k = clean.indexOf(t);
    if (k >= 0) clean.length = k + 1; else clean.push(t);
  }
  return clean;
}

export function connect(game, a, b, kind = 2, hubs = hubTiles(game)) {
  const road = hubRoute(game.world, game.nav.strategic(a, b, HEAVY_GROUND, true, false, ROAD_SEARCH), hubs);
  if (!road) return [];
  for (let i = 1; i < road.length; i++) {
    const from = road[i - 1], to = road[i];
    game.roads.set(from, to, game.world.river[from] || game.world.river[to] ? 2 : kind);
  }
  return road;
}

// Keep the coast close to the actual objective network instead of surrounding a
// compact RTS with an unused civilization-sized continent. Preserve every base,
// resource objective and real road corridor, plus a generous flanking apron.
function compactBattlefield(game, sites, corridors) {
  if (WRAP) return;
  const points = [...sites.map((s) => ({ x: s.x, z: s.z })), ...corridors.map(centerOf)]
    .sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const half = (list) => {
    const result = [];
    for (const p of list) {
      while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], p) <= 0) result.pop();
      result.push(p);
    }
    return result;
  };
  const lower = half(points), upper = half([...points].reverse());
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return;
  const w = game.world;
  for (let tile = 0; tile < N; tile++) {
    const p = centerOf(tile); let inside = true, distance = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      if (cross(a, b, p) < 0) inside = false;
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      distance = Math.min(distance, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
    }
    if (inside || distance < 7.5) continue;
    const coast = Math.max(0, Math.min(1, (distance - 7.5) / 5));
    const ceiling = .13 * (1 - 2 * coast) - .20 * coast * coast;
    if (w.elev[tile] <= ceiling) continue;
    w.elev[tile] = ceiling;
    // Reclassification is authoritative: the ocean is neither a cosmetic overlay
    // nor an invisible movement wall. Hydrology can drain into the new coastline.
    if (ceiling < 0) { w.river[tile] = w.lake[tile] = w.res[tile] = w.soil[tile] = 0; w.flow[tile] = 0; w.flowDir[tile] = -1; }
    w.classify(tile); w.touch(tile);
  }
}

// Grade the authoritative terrain before any geographic packet or navigation cache
// is published. Buildings, roads, sight lines and unit grounding then share one plain.
// Watercourses outside the compound are preserved, with a gently blended apron.
function gradeSites(w, sites) {
  for (const site of sites) {
    const cells = disk(site.tile, 4).filter((t) => parcel(w, t));
    const core = cells.filter((t) => distance(centerOf(t), site) <= 3.7);
    const levels = core.map((t) => w.elev[t]).sort((a, b) => a - b);
    const datum = Math.max(.045, Math.min(.24, levels[Math.floor(levels.length / 2)] ?? w.elev[site.tile]));
    site.groundDatum = datum;
    for (const t of cells) {
      const r = distance(centerOf(t), site), blend = Math.max(0, Math.min(1, (5.6 - r) / 1.9));
      const eased = blend * blend * (3 - 2 * blend);
      w.elev[t] += (datum - w.elev[t]) * eased;
      if (r <= 3.7) w.terr[t] = T.PLAINS;
      w.touch(t);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Hand-authored maps (mapCatalog.js). The terrain was painted by World.generate; here the explicit
// site list becomes ruins and outposts, and the authored roads are routed. Team 0's half is placed as
// written and team 1's is its exact half-turn: mirrored tiles, mirrored ring parcels and the mirrored
// road tiles, so neither side has a different ring, approach or bridge.
const RUIN_BY_KEY = Object.fromEntries(RUIN_TYPES.map((r) => [r.key, r]));

function nearestLand(w, tile, test) {
  if (tile >= 0 && test(tile)) return tile;
  for (let r = 1; r <= 4; r++) {
    const ring = disk(tile, r).filter((t) => dist(t, tile) === r && test(t)).sort((a, b) => a - b);
    if (ring.length) return ring[0];
  }
  return -1;
}

function mirroredRing(ring, mid, id) {
  return ring.map((p) => {
    const x = 2 * mid.x - p.x, z = 2 * mid.z - p.z;
    let yaw = p.yaw + Math.PI; if (yaw > Math.PI) yaw -= 2 * Math.PI;
    return { ...p, id: id * 16 + p.index + 1, tile: tileAt(x, z), x: +x.toFixed(4), z: +z.toFixed(4), yaw: +yaw.toFixed(4) };
  });
}

function mainSite(id, tile, x, z, name, kindKey, start, ring) {
  const kind = RUIN_BY_KEY[kindKey] || RUIN_TYPES[0];
  const slots = [...ring].sort((a, b) => a.tier - b.tier || a.index - b.index).map((p) => p.id);
  return { id, tile, x, z, name, kind: kind.key, ruin: kind.ruin, start, radius: 1.35, captureTime: CAPTURE.base, owner: -1, by: -1, progress: 0, last: 0,
    contested: false, hq: 0, tier: 1, slots, core: 4, ringVersion: 1, developedAt: 0, visualTier: 1,
    parcels: [{ id: 0, index: -1, tile, x, z, yaw: ring[0].yaw, tier: 1, width: 1.12, depth: 1.12 }, ...ring], claimedAt: -1 };
}

// ---------------------------------------------------------------------------------------------------
// Flexible player counts (maps wave 3). A catalog map can be played by fewer players than it has starts,
// and with any team arrangement up to its number of starts (2 v 1, 2 v 2 on a free-for-all map, a duel
// on a 3 v 3 map). Every civ gets one authored start; the starts nobody takes stay on the map as
// ordinary neutral city ruins (capturable, no head start). The choice is deterministic and depends only
// on the map and the teams:
//   - when every start is taken by the teams the map was drawn for, seat i takes start i (unchanged);
//   - otherwise every civ -> start assignment is scored and the lowest score wins:
//       side:   on team maps, allies on the same authored side and rivals on opposite sides;
//       fair:   every civ's nearest rival as far away as every other civ's, and the same reach to the
//               neutral bases around it (starts that are symmetric twins score exactly the same);
//       spread: rivals as far apart as possible (a duel on a six-start map takes opposite starts);
//       close:  allies next to each other.
// Distances are ground steps for a heavy vehicle (rivers count as crossable: they will be bridged).
function groundField(w, from) {
  const d = new Int32Array(N).fill(-1), queue = new Int32Array(N);
  let head = 0, tail = 0;
  d[from] = 0; queue[tail++] = from;
  while (head < tail) {
    const t = queue[head++];
    for (let k = 0; k < 6; k++) {
      const n = NB[t * 6 + k];
      if (n < 0 || d[n] >= 0 || !(land(w, n) || (w.river[n] && !w.lake[n] && !isWater(w.terr[n])))) continue;
      d[n] = d[t] + 1; queue[tail++] = n;
    }
  }
  return d;
}

/**
 * Ground metrics of a map's authored starts, which decide how fewer (or other) teams are seated:
 * `steps[i][j]`, ground steps from start i to start j (1e4: unreachable), and `reach[i]`, the mean steps
 * from start i to its three nearest neutral main sites. They depend only on the map, so the lobby
 * preview carries them (mapPreview) and the client seats a preview exactly as the match will.
 */
export function startMetrics(w, starts, others) {
  const fields = starts.map((t) => groundField(w, t));
  const far = (v) => (v < 0 ? 1e4 : v);
  const steps = starts.map((_, i) => starts.map((t) => far(fields[i][t])));
  const reach = fields.map((f) => {
    const v = others.map((t) => far(f[t])).sort((a, b) => a - b).slice(0, 3);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  });
  return { steps, reach };
}

const isDesigned = (sides, teams) => teams.length === sides.length && teams.every((_, a) => teams.every((__, b) => (teams[a] === teams[b]) === (sides[a] === sides[b])));

/**
 * Which authored start each civ takes. `starts`: the start tiles (index = designed seat); `sides`: the
 * designed team of each start; `others`: tiles of the neutral main sites; `teams`: each civ's team.
 * Returns civ -> start index.
 */
export function assignStarts(w, starts, sides, others, teams) {
  const P = starts.length, C = teams.length;
  if (C > P) throw new Error(`${C} players on a map with ${P} starts`);
  if (isDesigned(sides, teams)) return teams.map((_, i) => i);
  const { steps, reach } = startMetrics(w, starts, others);
  return chooseStarts(steps, reach, sides, teams);
}

/** The scoring half of assignStarts over startMetrics (ported to the client's lobby preview, MapPreview.cs SeatStarts). */
export function chooseStarts(D, reachSteps, sides, teams) {
  const P = D.length, C = teams.length;
  if (C > P) throw new Error(`${C} players on a map with ${P} starts`);
  if (isDesigned(sides, teams)) return teams.map((_, i) => i);
  let sum = 0, pairs = 0;
  for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) if (D[i][j] < 1e4) { sum += D[i][j]; pairs++; }
  const unit = pairs ? sum / pairs : 1;
  // reach: mean steps to the three nearest neutral bases, in units of the mean start-to-start distance
  const reach = reachSteps.map((r) => r / unit);
  const teamSided = new Set(sides).size < P;
  const spread = (v) => (v.length ? Math.max(...v) - Math.min(...v) : 0);
  const pick = new Array(C), used = new Array(P).fill(false);
  let best = null, bestScore = Infinity;
  const score = () => {
    let side = 0, close = 0, allies = 0;
    const near = new Array(C).fill(Infinity);
    for (let a = 0; a < C; a++) for (let b = a + 1; b < C; b++) {
      const d = D[pick[a]][pick[b]] / unit, ally = teams[a] === teams[b];
      if (ally) { close += d; allies++; } else { near[a] = Math.min(near[a], d); near[b] = Math.min(near[b], d); }
      if (teamSided && ally !== (sides[pick[a]] === sides[pick[b]])) side++;
    }
    const e = near.filter(Number.isFinite);
    return side * 4 + spread(e) * 3 + spread(pick.map((p) => reach[p])) * 3 + (allies ? close / allies : 0) - (e.length ? Math.min(...e) : 0) * 1.5;
  };
  const walk = (c) => {
    if (c === C) { const v = score(); if (v < bestScore - 1e-9) { bestScore = v; best = [...pick]; } return; }
    for (let p = 0; p < P; p++) if (!used[p]) { used[p] = true; pick[c] = p; walk(c + 1); used[p] = false; }
  };
  walk(0);
  return best;
}

// Orders the placed sites so the civs' starts come first (in civ order, each with its `seat`); the
// authored starts nobody takes follow as neutral ruins, then everything else as placed.
function seatStarts(game, def, placed, designedOf) {
  const civs = game.civs.length, players = def.players;
  if (civs > players) throw new Error(`${def.name} has ${players} starts (this match has ${civs} players).`);
  const startAt = new Array(players);
  placed.forEach((p) => { const d = designedOf(p); if (d !== undefined) startAt[d] = p; });
  const sides = startAt.map((_, i) => Math.floor(i / Math.max(1, def.teamSize)));
  const rest = placed.filter((p) => designedOf(p) === undefined);
  const civStart = assignStarts(game.world, startAt.map((p) => p.tile), sides, rest.map((p) => p.tile), game.civs.map((c) => c.team));
  const taken = new Set(civStart);
  return [...civStart.map((d, civ) => ({ ...startAt[d], seat: civ })), ...startAt.filter((_, d) => !taken.has(d)).map((p) => ({ ...p, seat: undefined })),
    ...rest.map((p) => ({ ...p, seat: undefined }))];
}

function buildAuthoredMap(game, def) {
  if (symmetryOf(def) !== 2) return buildRotatedMap(game, def);
  const w = game.world, team = def.teamSize;
  const { half, center } = siteTiles(def);
  let placed = [];
  const place = (s, mirrored) => {
    const tile = nearestLand(w, s.tile, (t) => parcel(w, t) && planRing(w, t, MAP_SEED) != null);
    if (tile < 0) throw new Error(`${def.name}: no room for a city ring at ${s.key}`);
    placed.push({ s, mirrored, tile: mirrored ? mirrorTile(tile) : tile });
  };
  const starts = half.filter((s) => s.start !== undefined).sort((a, b) => a.start - b.start);
  if (starts.length !== team) throw new Error(`${def.name}: expected ${team} starts per team`);
  for (const s of starts) place(s, false);
  for (const s of starts) place(s, true);
  for (const s of half.filter((x) => x.start === undefined)) { place(s, false); place(s, true); }
  for (const s of center) place(s, false);
  placed = seatStarts(game, def, placed, (p) => (p.s.start !== undefined ? p.s.start + (p.mirrored ? team : 0) : undefined));
  const sites = placed.map((p, i) => {
    const id = i + 1, c = centerOf(p.tile);
    let ring;
    if (!p.mirrored) ring = planRing(w, p.tile, MAP_SEED, id);
    else {
      // the exact half-turn of the twin's ring (so both teams build on the same layout)
      const twin = placed.find((q) => q.s === p.s && !q.mirrored), tc = centerOf(twin.tile);
      ring = mirroredRing(planRing(w, twin.tile, MAP_SEED, placed.indexOf(twin) + 1), { x: (tc.x + c.x) / 2, z: (tc.z + c.z) / 2 }, id);
    }
    if (!ring || ring.length !== 8 || ring.some((lot) => !parcel(w, lot.tile))) throw new Error(`${def.name}: the ring at ${p.s.key} does not fit`);
    const name = p.mirrored ? def.names?.[p.s.key] || `${p.s.name} East` : p.s.name;
    return mainSite(id, p.tile, c.x, c.z, name, p.s.kind, p.seat, ring);
  });
  gradeSites(w, sites);
  game.nav.invalidate();
  const occupied = new Set(sites.flatMap((s) => s.parcels.map((p) => p.tile)));
  // objectives and road waypoints stand where a heavy vehicle can drive
  const drivable = (t) => land(w, t) && !w.river[t] && Number.isFinite(game.nav.cost(t, centerOf(t).x, centerOf(t).z, HEAVY_GROUND));
  const addOutpost = (tile, kind, name) => {
    const key = OUTPOST_TYPES[kind] ? kind : 'supply', info = OUTPOST_TYPES[key], c = centerOf(tile);
    occupied.add(tile);
    sites.push({ id: sites.length + 1, tile, x: c.x, z: c.z, name: name || info.name, kind: key, ruin: info.ruin,
      radius: .91, captureTime: CAPTURE.outpost, owner: -1, by: -1, progress: 0, last: 0, contested: false, claimedAt: -1 });
  };
  for (const o of def.outposts || []) {
    const tile = nearestLand(w, tileOf(o.at), (t) => drivable(t) && !occupied.has(t) && !occupied.has(mirrorTile(t)) && mirrorTile(t) !== t);
    if (tile < 0) throw new Error(`${def.name}: no ground for the outpost at ${o.at}`);
    addOutpost(tile, o.kind, o.name);
    if (!o.center) addOutpost(mirrorTile(tile), o.kind, o.name);
  }
  // Roads: route team 0's half with the road planner, then lay the half-turn of the same tiles.
  const keyTile = new Map();
  placed.forEach((p, i) => keyTile.set((p.mirrored ? '~' : '') + p.s.key, sites[i].tile));
  const waypoint = (wp) => {
    if (typeof wp === 'string') { const t = keyTile.get(wp); if (t === undefined) throw new Error(`${def.name}: road waypoint ${wp} is not a site`); return t; }
    return nearestLand(w, tileOf(wp), drivable);
  };
  const hubs = sites.filter((s) => s.slots).map((s) => s.tile);
  for (const road of def.roads || []) {
    const tiles = road.map(waypoint);
    for (let i = 1; i < tiles.length; i++) {
      const path = hubRoute(w, game.nav.strategic(tiles[i - 1], tiles[i], HEAVY_GROUND, true, false, ROAD_SEARCH), hubs);
      if (!path) throw new Error(`${def.name}: no road route between ${JSON.stringify(road[i - 1])} and ${JSON.stringify(road[i])}`);
      // 2026-11-18: the authored roads are validated only; they are built when a city is claimed (ROADS_AND_CLAIMS.md),
      // their bridges with them (NAV_BRIDGES.md)
    }
  }
  w.starts = sites.slice(0, game.civs.length).map((s) => s.tile);
  for (const site of sites) game.addRuin(site.tile, site.ruin, -1, site.name);
  game.nav.invalidate();
  return sites;
}

// A ring turned k steps about the map centre (free-for-all maps).
function turnedRing(ring, k, n, id) {
  return ring.map((p) => {
    const q = rotatePoint(p, k, n);
    return { ...p, id: id * 16 + p.index + 1, tile: tileAt(q.x, q.z), x: +q.x.toFixed(4), z: +q.z.toFixed(4) };
  });
}

// Free-for-all maps (symmetry 3 or 4): the authored sector is placed once per seat, turned about the
// centre, and each turned road is routed on its own ground. Centre sites and outposts are shared.
function buildRotatedMap(game, def) {
  const w = game.world, players = def.players, n = symmetryOf(def);
  if (players % n) throw new Error(`${def.name}: ${players} players do not divide into ${n} turned sectors`);
  const perSector = players / n;
  const { half, center } = siteTiles(def);
  const ringFits = (t) => parcel(w, t) && planRing(w, t, MAP_SEED) != null;
  let placed = [];
  const place = (s, k) => {
    const tile = nearestLand(w, k ? rotateTile(s.tile, k, n) : s.tile, ringFits);
    if (tile < 0) throw new Error(`${def.name}: no room for a city ring at ${s.key} (turn ${k})`);
    placed.push({ s, k, tile });
  };
  const starts = half.filter((s) => s.start !== undefined).sort((a, b) => a.start - b.start);
  if (starts.length !== perSector) throw new Error(`${def.name}: expected ${perSector} starts per sector`);
  for (let k = 0; k < n; k++) for (const s of starts) place(s, k);
  for (const s of half.filter((x) => x.start === undefined)) for (let k = 0; k < n; k++) place(s, k);
  for (const s of center) {
    const tile = nearestLand(w, s.tile, ringFits);
    if (tile < 0) throw new Error(`${def.name}: no room for the central city ring at ${s.key}`);
    placed.push({ s, k: -1, tile });
  }
  placed = seatStarts(game, def, placed, (p) => (p.s.start !== undefined && p.k >= 0 ? p.s.start + p.k * perSector : undefined));
  const sites = placed.map((p, i) => {
    const id = i + 1, c = centerOf(p.tile);
    let ring = null;
    if (p.k > 0) {
      // the turned ring of the sector-0 twin, so every seat builds on the same layout where it fits
      const twin = placed.find((q) => q.s === p.s && q.k === 0);
      const base = planRing(w, twin.tile, MAP_SEED, placed.indexOf(twin) + 1);
      if (base) {
        // re-centred on the placed tile (the turned centre can sit a fraction of a hex away)
        const tc = rotatePoint(centerOf(twin.tile), p.k, n), dx = c.x - tc.x, dz = c.z - tc.z;
        ring = turnedRing(base, p.k, n, id).map((lot) => {
          const x = lot.x + dx, z = lot.z + dz;
          return { ...lot, tile: tileAt(x, z), x: +x.toFixed(4), z: +z.toFixed(4), yaw: +Math.atan2(c.x - x, c.z - z).toFixed(4) };
        });
        if (!ring.every((lot) => parcel(w, lot.tile))) ring = null;
      }
    }
    ring ??= planRing(w, p.tile, MAP_SEED, id);
    if (!ring || ring.length !== 8 || ring.some((lot) => !parcel(w, lot.tile))) throw new Error(`${def.name}: the ring at ${p.s.key} does not fit`);
    const name = p.k > 0 ? def.names?.[p.s.key]?.[p.k - 1] || `${p.s.name} ${p.k + 1}` : p.s.name;
    return mainSite(id, p.tile, c.x, c.z, name, p.s.kind, p.seat, ring);
  });
  gradeSites(w, sites);
  game.nav.invalidate();
  const occupied = new Set(sites.flatMap((s) => s.parcels.map((p) => p.tile)));
  const drivable = (t) => land(w, t) && !w.river[t] && Number.isFinite(game.nav.cost(t, centerOf(t).x, centerOf(t).z, HEAVY_GROUND));
  const addOutpost = (tile, kind, name) => {
    const key = OUTPOST_TYPES[kind] ? kind : 'supply', info = OUTPOST_TYPES[key], c = centerOf(tile);
    occupied.add(tile);
    sites.push({ id: sites.length + 1, tile, x: c.x, z: c.z, name: name || info.name, kind: key, ruin: info.ruin,
      radius: .91, captureTime: CAPTURE.outpost, owner: -1, by: -1, progress: 0, last: 0, contested: false, claimedAt: -1 });
  };
  const turnUV = (uv, k) => { const p = rotatePoint(mapPoint(uv), k, n); return tileAt(p.x, p.z); };
  for (const o of def.outposts || []) for (let k = 0; k < (o.center ? 1 : n); k++) {
    const tile = nearestLand(w, turnUV(o.at, k), (t) => drivable(t) && !occupied.has(t));
    if (tile < 0) throw new Error(`${def.name}: no ground for the outpost at ${o.at} (turn ${k})`);
    addOutpost(tile, o.kind, o.name);
  }
  // Roads: 'key' is the site in the same sector, '~key' the one in the next sector clockwise; centre
  // sites are shared by every sector.
  const keyTile = new Map();
  placed.forEach((p, i) => keyTile.set(p.k < 0 ? p.s.key : `${p.s.key}@${p.k}`, sites[i].tile));
  const hubs = sites.filter((s) => s.slots).map((s) => s.tile);
  for (const road of def.roads || []) for (let k = 0; k < n; k++) {
    const waypoint = (wp) => {
      if (typeof wp !== 'string') return nearestLand(w, turnUV(wp, k), drivable);
      const next = wp.startsWith('~'), key = next ? wp.slice(1) : wp;
      const t = keyTile.get(key) ?? keyTile.get(`${key}@${(k + (next ? 1 : 0)) % n}`);
      if (t === undefined) throw new Error(`${def.name}: road waypoint ${wp} is not a site`);
      return t;
    };
    const tiles = road.map(waypoint);
    for (let i = 1; i < tiles.length; i++) {
      const path = hubRoute(w, game.nav.strategic(tiles[i - 1], tiles[i], HEAVY_GROUND, true, false, ROAD_SEARCH), hubs);
      if (!path) throw new Error(`${def.name}: no road route between ${JSON.stringify(road[i - 1])} and ${JSON.stringify(road[i])} (turn ${k})`);
      // validated only (see the team-map loop above)
    }
  }
  w.starts = sites.slice(0, game.civs.length).map((s) => s.tile);
  for (const site of sites) game.addRuin(site.tile, site.ruin, -1, site.name);
  game.nav.invalidate();
  return sites;
}

// ---------------------------------------------------------------------------------------------------
// Map preview for the lobby (mapCatalog.mapList → `preview`, stored in mapPreviews.js by
// tools/map-previews.mjs). A PREVIEW_SIZE × PREVIEW_SIZE grid over the whole world rectangle:
// cell (col, row) covers u ∈ [col/64, (col+1)/64) west → east and v ∈ [row/64, (row+1)/64) north → south.
// `cells` is base64 of one byte per cell, row-major from the north-west corner, holding a class index
// into PREVIEW_CLASSES. A cell shows a bridge, road or river when any of its hexes has one, otherwise
// its most common terrain. The world is √3 : 1.5 (`aspect` 1.1547) wider than tall, so draw the grid
// that much wider than high. Sites are listed with normalised [u, v] (multiply by 64 for grid cells).
export const PREVIEW_SIZE = 64;
export const PREVIEW_CLASSES = ['deep', 'shallow', 'open', 'forest', 'marsh', 'hills', 'mountains', 'peaks', 'river', 'ford', 'road', 'bridge'];
const previewClass = (w, t) => {
  if (w.road[t]) return w.river[t] ? 11 : 10;
  if (w.river[t]) return w.flow[t] < 94 ? 9 : 8;
  const c = w.terr[t];
  return c === T.DEEP ? 0 : c === T.SHALLOW || w.lake[t] ? 1 : c === T.FOREST ? 3 : c === T.MARSH ? 4 : c === T.HILLS ? 5
    : c === T.MOUNTAIN ? 6 : c === T.PEAK || c === T.LAVA ? 7 : 2;
};
export function mapPreview(game, size = PREVIEW_SIZE) {
  const w = game.world, n = size * size, votes = new Uint16Array(n * PREVIEW_CLASSES.length);
  const XS = Math.sqrt(3) * W, ZS = 1.5 * H, CX = Math.sqrt(3) * (W - .5) / 2, CZ = 1.5 * (H - 1) / 2;
  const uv = (p) => [(p.x - CX) / XS + .5, (p.z - CZ) / ZS + .5];
  const cellOf = (p) => { const [u, v] = uv(p); return Math.min(size - 1, Math.max(0, Math.floor(v * size))) * size + Math.min(size - 1, Math.max(0, Math.floor(u * size))); };
  for (let t = 0; t < N; t++) votes[cellOf(centerOf(t)) * PREVIEW_CLASSES.length + previewClass(w, t)]++;
  const cells = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = votes.subarray(i * PREVIEW_CLASSES.length, (i + 1) * PREVIEW_CLASSES.length);
    let best = -1;
    for (const line of [11, 10, 8, 9]) if (v[line]) { best = line; break; }
    if (best < 0) {
      let top = 0;
      for (let k = 0; k < 8; k++) if (v[k] > top) { top = v[k]; best = k; }
    }
    if (best < 0) {
      // no hex centre fell in this cell: sample the hex under its middle
      const col = i % size, row = (i / size) | 0;
      const t = tileAt(CX + ((col + .5) / size - .5) * XS, CZ + ((row + .5) / size - .5) * ZS);
      best = t >= 0 ? previewClass(w, t) : 0;
    }
    cells[i] = best;
  }
  const at = (s) => uv(s).map((x) => +x.toFixed(4));
  // seating metrics (startMetrics): with fewer players than starts, the client picks the starts the match will use
  const startSites = game.sites.filter((s) => s.start !== undefined).sort((a, b) => a.start - b.start);
  const metrics = startMetrics(w, startSites.map((s) => s.tile), game.sites.filter((s) => s.slots && s.start === undefined).map((s) => s.tile));
  return {
    w: size, h: size, aspect: +(Math.sqrt(3) / 1.5).toFixed(4), classes: PREVIEW_CLASSES,
    cells: Buffer.from(cells).toString('base64'),
    starts: game.sites.filter((s) => s.start !== undefined).sort((a, b) => a.start - b.start).map((s) => { const [u, v] = at(s); return { seat: s.start, u, v, name: s.name }; }),
    bases: game.sites.filter((s) => s.slots && s.start === undefined).map((s) => { const [u, v] = at(s); return { u, v, name: s.name, kind: s.kind }; }),
    outposts: game.sites.filter((s) => !s.slots).map((s) => { const [u, v] = at(s); return { u, v, kind: s.kind }; }),
    startSteps: metrics.steps, startReach: metrics.reach,
  };
}
