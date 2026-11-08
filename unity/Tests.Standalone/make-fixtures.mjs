// Fixtures for the Unity client's engine-independent core, produced by the authoritative server code
// itself: hex topology and distances (server/sim/hex.js), a real generated world's terrain geometry
// in the 'geo' wire format (server/sim/terrainGeo.js), and a udelta snapshot stream from the
// server's own encoder (server/delta.js) next to the full unit sets it must reconstruct.
//   node unity/Tests.Standalone/make-fixtures.mjs [out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.SE_MAP_SIZE = 64;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const imp = (p) => import(new URL('file:///' + path.join(root, p).replace(/\\/g, '/')).href);
const { W, H, N } = await imp('server/sim/constants.js');
const hex = await imp('server/sim/hex.js');
const { Game } = await imp('server/sim/game.js');
const { geoMessage, geoViewer, decodeGeo } = await imp('server/sim/terrainGeo.js');
const { deltaEncoder } = await imp('server/delta.js');

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ---- hex topology
const tiles = [0, 1, W - 1, W, W * 2 - 1, (H - 1) * W, N - 1, 130, 777, 2049];
for (let k = 0; k < 40; k++) tiles.push(Math.floor(rand() * N));
const neighbors = tiles.map((t) => [t, ...Array.from({ length: 6 }, (_, d) => hex.NB[t * 6 + d])]);
const centers = tiles.map((t) => [t, ...hex.center(t)]);
const dists = [];
for (let k = 0; k < 300; k++) { const a = Math.floor(rand() * N), b = Math.floor(rand() * N); dists.push([a, b, hex.dist(a, b)]); }

// ---- terrain geometry from a real world
const game = new Game({ id: 'fixture', seed: 4242, slots: [{ human: true }, { personality: 'builder' }], rebels: false });
const all = new Uint8Array(N).fill(1);
const geo = geoMessage(game, geoViewer(), all, all, true);
const decoded = decodeGeo(geo);
const geoSamples = [];
for (const t of tiles) if (decoded.has(t)) geoSamples.push([t, ...decoded.get(t)]);

// ---- udelta stream: the server's encoder, and the full sets it must reproduce
const enc = deltaEncoder(50);
const types = ['rifle_squad', 'tank', 'helicopter', 'field_gun', 'engineer'];
let units = new Map(); let nextId = 1;
const stream = [], truth = [];
for (let s = 0; s < 160; s++) {
  // spawn, remove and move units
  for (let k = 0; k < 4; k++) if (units.size < 120 || rand() < 0.3) { const id = nextId++; units.set(id, [id, Math.floor(rand() * 3), types[id % types.length], Math.floor(rand() * N), -1, 0, 100, 50, 0]); }
  for (const id of [...units.keys()]) if (rand() < 0.02) units.delete(id);
  for (const r of units.values()) {
    if (rand() < 0.35) { r[4] = hex.NB[r[3] * 6 + Math.floor(rand() * 6)]; r[5] = Math.min(100, r[5] + 25); if (r[5] >= 100) { if (r[4] >= 0) r[3] = r[4]; r[4] = -1; r[5] = 0; } }
    if (rand() < 0.05) r[6] = Math.max(1, r[6] - 10);
  }
  const list = [...units.values()].map((r) => [...r]);
  const paths = {}; for (const r of list.slice(0, 10)) if (r[4] >= 0) paths[r[0]] = [r[4], r[3]];
  const msg = enc({ t: 's', time: +(s * 0.2).toFixed(1), tick: s * 2, units: list, paths });
  stream.push(JSON.stringify(msg));
  truth.push(list.map((r) => [r[0], r[1], r[3], r[4], r[5], r[6]]).sort((a, b) => a[0] - b[0]));
}

const out = { W, H, wrap: hex.WRAP, neighbors, centers, dists, geo: JSON.stringify(geo), geoSamples, stream, truth };
const file = process.argv[2] || path.join(here, 'fixtures.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${file}: ${tiles.length} tiles, ${dists.length} distances, ${geo.chunks.length} geo chunks, ${stream.length} snapshots`);
