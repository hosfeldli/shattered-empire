// Terrain geometry for 3D clients (protocol capability 'geo'). The PixiJS client never asks for it:
// it gets shaded colours in the tile records instead. A 3D client needs the shape of the land, so
// each known tile is sent as six quantized bytes, grouped in 16x16-hex chunks:
//   0 elevation    round((elev + 1) * 127.5), 0..255 (sea level = 127.5)
//   1 biome        terrain id (T.*)
//   2 water depth  sea: -elev * 400 (at least 1), lake: 24, river: 8 per flow bucket, else 0
//   3 flags        river | lake<<1 | volcanic soil<<2 | ruin<<3 | drought<<4 | ash<<5 | lava<<6
//   4 deposit      resource id (RES.*) | river flow bucket<<4
//   5 flow         river flow direction + 1 (0 = none)
// Fog of war: the initial sync carries every explored tile and nothing else; afterwards a tile is
// re-sent only while the viewer can see it, so land that changes out of sight keeps its last-known
// shape until it is seen again (the same rule as the tile records). The client keeps no rules.
import { N, W, H, T } from './constants.js';
import { RIVER_FLOW } from './world.js';

export const GEO_VERSION = 1;
export const GEO_CHUNK = 16;
export const GEO_STRIDE = 6;
const CW = Math.ceil(W / GEO_CHUNK), CH = Math.ceil(H / GEO_CHUNK);
const CELLS = GEO_CHUNK * GEO_CHUNK;

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// the six bytes of tile i, written into out at offset o
export function geoBytes(game, i, out, o) {
  const w = game.world, t = w.terr[i], e = w.elev[i];
  const fb = w.river[i] ? Math.min(4, Math.floor(Math.log2(Math.max(1, w.flow[i] / 42))) + 1) : 0;
  out[o] = clampByte((e + 1) * 127.5);
  out[o + 1] = t;
  out[o + 2] = t === T.DEEP || t === T.SHALLOW ? (w.lake[i] ? 24 : Math.max(1, clampByte(-e * 400))) : w.lake[i] ? 24 : fb * 8;
  // bit 7: a headwater stream (flow too small for a river, draining into one) so clients can draw
  // rivers tapering into the hills instead of starting abruptly; presentation only
  const stream = !w.river[i] && !w.lake[i] && t !== T.DEEP && t !== T.SHALLOW && w.flow[i] > RIVER_FLOW * 0.3 && w.flowDir[i] >= 0 ? 128 : 0;
  out[o + 3] = w.river[i] | (w.lake[i] << 1) | (w.soil[i] << 2) | (game.ruins.has(i) ? 8 : 0) | (w.drought[i] > 0 ? 16 : 0) | (w.ash[i] > 0 ? 32 : 0) | (w.lava[i] > 0 || t === T.LAVA ? 64 : 0) | stream;
  out[o + 4] = (w.res[i] & 15) | (fb << 4);
  out[o + 5] = w.flowDir[i] + 1;
}

// per-viewer record of what has been sent (the client's last-known terrain)
export function geoViewer() { return { sent: new Uint8Array(N), bytes: new Uint8Array(N * GEO_STRIDE) }; }

// One 'geo' message for a viewer, or null when nothing changed. full: initial sync (or a reset after a
// spectator changes whose fog they watch): every explored tile, and the client drops all it knew.
export function geoMessage(game, viewer, vis, explored, full) {
  const tmp = new Uint8Array(GEO_STRIDE);
  if (full) viewer.sent.fill(0);
  const byChunk = new Map();
  for (let i = 0; i < N; i++) {
    if (full ? !explored[i] : !vis[i]) continue;
    geoBytes(game, i, tmp, 0);
    const o = i * GEO_STRIDE;
    if (viewer.sent[i]) {
      let same = true;
      for (let k = 0; k < GEO_STRIDE; k++) if (viewer.bytes[o + k] !== tmp[k]) { same = false; break; }
      if (same) continue;
    }
    viewer.sent[i] = 1; viewer.bytes.set(tmp, o);
    const q = i % W, r = (i / W) | 0, c = ((r / GEO_CHUNK) | 0) * CW + ((q / GEO_CHUNK) | 0);
    let list = byChunk.get(c); if (!list) byChunk.set(c, (list = []));
    list.push(i);
  }
  if (!full && !byChunk.size) return null;
  // each chunk: [chunk x, chunk y, 256-bit mask of the hexes it carries, their bytes in row-major order]
  const chunks = [];
  for (const [c, list] of [...byChunk].sort((a, b) => a[0] - b[0])) {
    const cx = c % CW, cy = (c / CW) | 0;
    const mask = new Uint8Array(CELLS / 8), data = Buffer.alloc(list.length * GEO_STRIDE);
    list.forEach((i, n) => {
      const lq = (i % W) - cx * GEO_CHUNK, lr = ((i / W) | 0) - cy * GEO_CHUNK, cell = lr * GEO_CHUNK + lq;
      mask[cell >> 3] |= 1 << (cell & 7);
      data.set(viewer.bytes.subarray(i * GEO_STRIDE, i * GEO_STRIDE + GEO_STRIDE), n * GEO_STRIDE);
    });
    chunks.push([cx, cy, Buffer.from(mask).toString('base64'), data.toString('base64')]);
  }
  const msg = { t: 'geo', v: GEO_VERSION, chunks };
  if (full) Object.assign(msg, { full: 1, w: W, h: H, cs: GEO_CHUNK, stride: GEO_STRIDE, cw: CW, ch: CH });
  return msg;
}

// decoding helper (tests and tools): tile index -> bytes, for every hex a message carries
export function decodeGeo(msg, w = W) {
  const out = new Map(), cs = msg.cs || GEO_CHUNK, stride = msg.stride || GEO_STRIDE;
  for (const [cx, cy, maskB64, dataB64] of msg.chunks) {
    const mask = Buffer.from(maskB64, 'base64'), data = Buffer.from(dataB64, 'base64');
    let n = 0;
    for (let cell = 0; cell < cs * cs; cell++) {
      if (!(mask[cell >> 3] & (1 << (cell & 7)))) continue;
      const i = (cy * cs + ((cell / cs) | 0)) * w + cx * cs + (cell % cs);
      out.set(i, [...data.subarray(n * stride, n * stride + stride)]); n++;
    }
  }
  return out;
}
