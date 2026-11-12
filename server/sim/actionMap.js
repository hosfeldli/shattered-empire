import { N, T, W, H, isWater } from './constants.js';
import { NB, disk, dist, rOf, qOf, WRAP } from './hex.js';
import { hash2 } from './rng.js';
import { OUTPOST_TYPES, RUIN_TYPES } from './actionDefinitions.js';
import { centerOf, distance, dxBetween, HEAVY_GROUND, tileAt } from './actionNavigation.js';

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

export function buildActionMap(game) {
  const { world: w, civs, seed } = game;
  const starts = civs.length;
  const desired = Math.min(24, 4 + starts * 2);
  const area = districts(w)[0] || [];
  const candidates = area.filter((t) => {
    const q = qOf(t), r = rOf(t);
    // A city needs a connected land apron for its buildings and army. Thin spits
    // surrounded by several lake cells produced flooded-looking compounds and
    // bridge tangles, even when the centre happened to be legally dry.
    return parcel(w, t) && r >= 3 && r < H - 3 && (WRAP || q >= 3 && q < W - 3)
      && disk(t, 1).filter((n) => parcel(w, n)).length >= 5
      && disk(t, 2).filter((n) => parcel(w, n)).length >= 12 && planRing(w, t, seed) != null;
  }).map((tile) => ({ tile, ...centerOf(tile), ...quality(w, tile), noise: hash2(qOf(tile), rOf(tile), seed) }));
  if (candidates.length < starts + 2) throw new Error('This world does not have enough connected land for an action RTS match.');
  const goalRadius = starts <= 2 ? 20 : starts <= 4 ? 24 : 31;
  const central = candidates.reduce((a, b) => {
    const rating = (p) => p.score + p.noise * .4 - Math.hypot(qOf(p.tile) - W / 2, rOf(p.tile) - H / 2) * .15
      + Math.min(18, disk(p.tile, 4).filter((t) => parcel(w, t)).length) * .09;
    return rating(b) > rating(a) ? b : a;
  });
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
    const start = ranked.find(({ p }) => game.nav.strategic(central.tile, p.tile, HEAVY_GROUND, true))?.p || ranked[0].p;
    locations.push({ ...start, start: i });
    occupied.add(start.tile);
  }
  if (!occupied.has(central.tile)) { locations.push(central); occupied.add(central.tile); }
  // Give each start a nearby expansion with room to maneuver, then fill the contested region.
  for (let i = 0; i < starts && locations.length < desired; i++) {
    const start = locations[i];
    const preferred = { x: start.x + dxBetween(start.x, central.x) * .48, z: start.z + (central.z - start.z) * .48 };
    const ranked = candidates.filter((p) => locations.every((o) => distance(o, p) >= 5.6))
      .map((p) => ({ p, score: p.score + p.noise * .7 - distance(p, preferred) * .42 }))
      .sort((a, b) => b.score - a.score || a.p.tile - b.p.tile);
    const p = ranked.find(({ p }) => game.nav.strategic(start.tile, p.tile, HEAVY_GROUND, true))?.p;
    if (p) { locations.push(p); occupied.add(p.tile); }
  }
  while (locations.length < desired) {
    const ranked = candidates.filter((p) => locations.every((o) => distance(o, p) >= 6.2))
      .map((p) => {
        const sep = Math.min(...locations.map((o) => distance(o, p)));
        return { p, score: p.score * 1.5 + p.noise + Math.min(13, sep) * .41 - Math.max(0, distance(p, central) - goalRadius * 1.13) * .7 };
      }).sort((a, b) => b.score - a.score || a.p.tile - b.p.tile);
    const p = ranked.find(({ p }) => game.nav.strategic(central.tile, p.tile, HEAVY_GROUND, true))?.p;
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
  const outposts = ['energy', 'supply', 'radar', 'repair', 'defense'];
  const count = Math.min(16, starts * 2 + 3);
  for (let i = 0; i < count; i++) {
    const base = sites[i % locations.length];
    const close = candidates.filter((p) => !occupied.has(p.tile) && distance(p, base) >= 3.6 && distance(p, base) < 10 &&
      sites.every((s) => distance(s, p) >= (s.slots ? 3.5 : 4.6)));
    close.sort((a, b) => Math.abs(distance(a, base) - 5) - Math.abs(distance(b, base) - 5) || b.noise - a.noise);
    const p = close[0];
    if (!p) continue;
    const kind = i < starts ? 'energy' : outposts[(i - starts + 1) % outposts.length], info = OUTPOST_TYPES[kind];
    occupied.add(p.tile);
    sites.push({ id: sites.length + 1, tile: p.tile, x: p.x, z: p.z, name: info.name, kind, ruin: info.ruin,
      radius: .91, captureTime: 10, owner: -1, by: -1, progress: 0, last: 0, contested: false, claimedAt: -1 });
  }

  w.starts = sites.slice(0, starts).map((s) => s.tile);
  const main = sites.filter((s) => s.slots);
  const linked = new Set([main.find((s) => s.tile === central.tile) || main[0]]);
  while (linked.size < main.length) {
    let pair = null, best = Infinity;
    for (const a of linked) for (const b of main) {
      if (linked.has(b)) continue;
      const d = distance(a, b);
      if (d < best) { best = d; pair = [a, b]; }
    }
    if (!pair) break;
    connect(game, pair[0].tile, pair[1].tile);
    linked.add(pair[1]);
  }
  for (const s of main) {
    // A second connection gives a flank even when a bridge on the shortest route falls.
    const other = main.filter((b) => b !== s).sort((a, b) => distance(s, a) - distance(s, b))[1];
    if (other && distance(s, other) < 24) connect(game, s.tile, other.tile);
  }
  for (const site of sites) game.addRuin(site.tile, site.ruin, -1, site.name);
  game.nav.invalidate();
  return sites;
}

function connect(game, a, b, kind = 2) {
  const road = game.nav.strategic(a, b, HEAVY_GROUND, true);
  if (!road) return;
  for (let i = 1; i < road.length; i++) {
    const from = road[i - 1], to = road[i];
    game.roads.set(from, to, game.world.river[from] || game.world.river[to] ? 2 : kind);
  }
}
