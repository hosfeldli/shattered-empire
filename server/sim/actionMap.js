import { N, T, W, H, isWater } from './constants.js';
import { NB, disk, dist, hexLine, rOf, qOf, WRAP } from './hex.js';
import { hash2 } from './rng.js';
import { OUTPOST_TYPES, RUIN_TYPES } from './actionDefinitions.js';
import { centerOf, distance, dxBetween, HEAVY_GROUND, tileAt } from './actionNavigation.js';
import { MAP_SEED, mirrorTile, siteTiles, tileOf } from './authoredMaps.js';

const NAMES = ['Ironford', 'Ashby Crossing', 'Gantry', 'Saltreach', 'Signal Point', 'Northlight', 'Hollowgate',
  'Cinderhold', 'Pylon Ridge', 'Dry Dock', 'Ember Station', 'Scrapton', 'Clearwater', 'Terminal', 'Quarry Nine',
  'Copperline', 'Last Bridge', 'Waystation', 'Coldwater', 'Cedar Valley', 'Breakwater', 'New Haven', 'Rustwater', 'Fallow Yard'];
const land = (w, t) => t >= 0 && !isWater(w.terr[t]) && !w.lake[t] && w.terr[t] < T.MOUNTAIN;
const parcel = (w, t) => land(w, t) && !w.river[t] && w.terr[t] !== T.MARSH;

function planRing(w, tile, seed, siteId = 0) {
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

export function buildActionMap(game) {
  const { world: w, civs, seed } = game;
  if (w.mapDef) return buildAuthoredMap(game, w.mapDef);
  massifs(w);
  const starts = civs.length;
  // Bigger maps carry proportionally more cities and outposts, so larger armies have more to fight over.
  const density = Math.min(1.8, .55 + W / 140);
  const desired = Math.min(24, Math.round((4 + starts * 2) * density));
  const area = districts(w)[0] || [];
  const candidates = area.filter((t) => {
    const q = qOf(t), r = rOf(t);
    // A city needs a connected land apron for its buildings and army. Thin spits
    // surrounded by several lake cells produced flooded-looking compounds and
    // bridge tangles, even when the centre happened to be legally dry.
    return parcel(w, t) && r >= 3 && r < H - 3 && (WRAP || q >= 3 && q < W - 3)
      && disk(t, 1).filter((n) => parcel(w, n)).length >= 5
      && disk(t, 2).every((n) => parcel(w, n)) && planRing(w, t, seed) != null;
  }).map((tile) => ({ tile, ...centerOf(tile), ...quality(w, tile), noise: hash2(qOf(tile), rOf(tile), seed) }));
  if (candidates.length < starts + 2) throw new Error('This world does not have enough connected land for an action RTS match.');
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
  const reach = reachable(game, central.tile, HEAVY_GROUND);
  const angle = hash2(27, 13, seed) * Math.PI * 2;
  const occupied = new Set();
  const locations = [];
  for (let i = 0; i < starts; i++) {
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
    const start = ranked.find(({ p }) => reach[p.tile])?.p || ranked[0].p;
    locations.push({ ...start, start: i });
    occupied.add(start.tile);
  }
  if (!occupied.has(central.tile)) { locations.push(central); occupied.add(central.tile); }
  // Give each start a nearby expansion with room to maneuver, then fill the contested region.
  for (let i = 0; i < starts && locations.length < desired; i++) {
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
  while (locations.length < desired) {
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

  const sites = locations.map((p, i) => {
    const kind = p.start !== undefined ? RUIN_TYPES[1] : p.tile === central.tile ? RUIN_TYPES[2] :
      p.coast >= 4 ? RUIN_TYPES[4] : p.river >= 2 ? RUIN_TYPES[1] : p.hill >= 5 ? RUIN_TYPES[3] : p.noise > .71 ? RUIN_TYPES[5] : RUIN_TYPES[0];
    const ring = planRing(w, p.tile, seed, i + 1);
    if (!ring || ring.length !== 8) throw new Error('A city ruin must support its complete eight-site ring.');
    const slots = [...ring].sort((a, b) => a.tier - b.tier || a.index - b.index).map((p) => p.id);
    for (const lot of ring) occupied.add(lot.tile);
    const name = NAMES[(i + Math.abs(seed % NAMES.length)) % NAMES.length];
    return { id: i + 1, tile: p.tile, x: p.x, z: p.z, name, kind: kind.key, ruin: kind.ruin, start: p.start,
      radius: 1.35, captureTime: 16, owner: -1, by: -1, progress: 0, last: 0, contested: false, hq: 0, tier: 1,
      slots, core: 4, ringVersion: 1, developedAt: 0, visualTier: 1,
      parcels: [{ id: 0, index: -1, tile: p.tile, x: p.x, z: p.z, yaw: ring[0].yaw, tier: 1, width: 1.12, depth: 1.12 }, ...ring], claimedAt: -1 };
  });
  gradeSites(w, sites);
  game.nav.invalidate();
  const outposts = ['energy', 'supply', 'radar', 'repair', 'defense'];
  const count = Math.min(28, Math.round((starts * 2 + 3) * density));
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
      radius: .91, captureTime: 10, owner: -1, by: -1, progress: 0, last: 0, contested: false, claimedAt: -1 });
  }

  w.starts = sites.slice(0, starts).map((s) => s.tile);
  const main = sites.filter((s) => s.slots);
  const corridors = [];
  const hubs = main.map((s) => s.tile);
  const link = (a, b) => corridors.push(...connect(game, a, b, 2, hubs));
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
  compactBattlefield(game, sites, corridors);
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

export const hubTiles = (game) => (game.sites || []).filter((s) => s.slots).map((s) => s.tile);
const HUB_REACH = 2;
const spokeTile = (w, t) => t >= 0 && !isWater(w.terr[t]) && !w.lake[t] && w.terr[t] < T.MOUNTAIN;

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
  return { id, tile, x, z, name, kind: kind.key, ruin: kind.ruin, start, radius: 1.35, captureTime: 16, owner: -1, by: -1, progress: 0, last: 0,
    contested: false, hq: 0, tier: 1, slots, core: 4, ringVersion: 1, developedAt: 0, visualTier: 1,
    parcels: [{ id: 0, index: -1, tile, x, z, yaw: ring[0].yaw, tier: 1, width: 1.12, depth: 1.12 }, ...ring], claimedAt: -1 };
}

function buildAuthoredMap(game, def) {
  const w = game.world, players = def.players, team = def.teamSize;
  if (game.civs.length !== players) throw new Error(`${def.name} is a ${team}v${team} map for ${players} players (this match has ${game.civs.length}).`);
  const { half, center } = siteTiles(def);
  const placed = [];
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
    const start = p.s.start !== undefined ? p.s.start + (p.mirrored ? team : 0) : undefined;
    return mainSite(id, p.tile, c.x, c.z, name, p.s.kind, start, ring);
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
      radius: .91, captureTime: 10, owner: -1, by: -1, progress: 0, last: 0, contested: false, claimedAt: -1 });
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
      for (let k = 1; k < path.length; k++) {
        game.roads.set(path[k - 1], path[k], 2);
        game.roads.set(mirrorTile(path[k - 1]), mirrorTile(path[k]), 2);
      }
      game.nav.invalidate();
    }
  }
  w.starts = sites.slice(0, players).map((s) => s.tile);
  for (const site of sites) game.addRuin(site.tile, site.ruin, -1, site.name);
  game.nav.invalidate();
  return sites;
}
