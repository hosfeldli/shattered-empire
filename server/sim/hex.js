// Odd-r offset hex grid helpers (pointy-top hexes, odd rows shoved right).
import { W, H } from './constants.js';

const DIRS_EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const DIRS_ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

// The world is a cylinder: travelling off the east edge brings you onto the west edge. North and
// south stay bounded. A process decides once (SE_WRAP), since neighbour tables are global; saves
// from bounded worlds keep their topology.
export const WRAP = (globalThis.SE_WRAP ?? (typeof process !== 'undefined' && process.env.SE_WRAP === '0' ? false : true)) !== false;
export const wrapQ = (q) => (WRAP ? ((q % W) + W) % W : q);
export const idx = (q, r) => r * W + wrapQ(q);
export const qOf = (i) => i % W;
export const rOf = (i) => (i / W) | 0;
export const inBounds = (q, r) => r >= 0 && r < H && (WRAP || (q >= 0 && q < W));

// Precomputed neighbour table: NB[i*6+d] = neighbour index or -1.
export const NB = new Int32Array(W * H * 6).fill(-1);
for (let r = 0; r < H; r++) {
  const dirs = r & 1 ? DIRS_ODD : DIRS_EVEN;
  for (let q = 0; q < W; q++) {
    const i = idx(q, r);
    for (let d = 0; d < 6; d++) {
      const nq = q + dirs[d][0], nr = r + dirs[d][1];
      if (inBounds(nq, nr)) NB[i * 6 + d] = idx(nq, nr);
    }
  }
}

export function neighbors(i, out = []) {
  out.length = 0;
  for (let d = 0; d < 6; d++) { const n = NB[i * 6 + d]; if (n >= 0) out.push(n); }
  return out;
}

export function toCube(i) {
  const q = qOf(i), r = rOf(i);
  const x = q - ((r - (r & 1)) >> 1);
  return [x, r, -x - r];
}

// allocation-free (the hottest function in pathfinding, targeting and AI)
export function dist(a, b) {
  const ar = (a / W) | 0, br = (b / W) | 0;
  const ax = a - ar * W - ((ar - (ar & 1)) >> 1), bx = b - br * W - ((br - (br & 1)) >> 1);
  const ay = ar, by = br, az = -ax - ar, bz = -bx - br;
  const d0 = Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
  if (!WRAP) return d0;
  // shortest of the equivalent images east and west (x shifts by W, z by -W)
  const d1 = Math.max(Math.abs(ax - bx - W), Math.abs(ay - by), Math.abs(az - bz + W));
  const d2 = Math.max(Math.abs(ax - bx + W), Math.abs(ay - by), Math.abs(az - bz - W));
  return Math.min(d0, d1, d2);
}

// Signed shortest column offset from a to b (for directions and centroids across the seam).
export function dqWrap(qa, qb) { let d = qb - qa; if (WRAP) { if (d > W / 2) d -= W; else if (d < -W / 2) d += W; } return d; }

// Centre of a set of tiles that may straddle the seam (circular mean of columns).
export function centroid(tiles) {
  if (!tiles.length) return -1;
  const q0 = qOf(tiles[0]); let sq = 0, sr = 0;
  for (const t of tiles) { sq += dqWrap(q0, qOf(t)); sr += rOf(t); }
  const r = Math.max(0, Math.min(H - 1, Math.round(sr / tiles.length)));
  return idx(Math.round(q0 + sq / tiles.length), r);
}

// Tiles within radius rad of center (inclusive), cached offsets per (radius, parity).
const diskCache = new Map();
export function disk(center, rad) {
  const r0 = rOf(center), q0 = qOf(center);
  const key = rad * 2 + (r0 & 1);
  let offs = diskCache.get(key);
  if (!offs) {
    offs = [];
    const [cx, cy, cz] = [q0 - ((r0 - (r0 & 1)) >> 1), r0, 0];
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dq = -rad - 1; dq <= rad + 1; dq++) {
        const r = r0 + dr, q = q0 + dq;
        const x = q - ((r - (r & 1)) >> 1);
        const y = r, z = -x - y;
        const czz = -cx - cy;
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - czz)) <= rad) offs.push([dq, dr]);
      }
    }
    void cz;
    diskCache.set(key, offs);
  }
  const res = [];
  for (const [dq, dr] of offs) {
    const q = q0 + dq, r = r0 + dr;
    if (inBounds(q, r)) res.push(idx(q, r));
  }
  return res;
}

// Write `val` into arr for every tile within rad of center, without allocating (vision, fog).
export function stamp(arr, center, rad, val = 1) {
  const r0 = rOf(center), q0 = qOf(center);
  const key = rad * 2 + (r0 & 1);
  if (!diskCache.has(key)) disk(center, rad);
  const offs = diskCache.get(key);
  const inner = q0 - rad - 1 >= 0 && q0 + rad + 1 < W && r0 - rad >= 0 && r0 + rad < H;
  if (inner) { for (let k = 0; k < offs.length; k++) { const o = offs[k]; arr[(r0 + o[1]) * W + q0 + o[0]] = val; } return; }
  for (let k = 0; k < offs.length; k++) { const o = offs[k], q = q0 + o[0], r = r0 + o[1]; if (inBounds(q, r)) arr[idx(q, r)] = val; }
}

// Pixel-space centre for a hex of "size" (radius) — used for continuous positions.
export function center(i, size = 1) {
  const q = qOf(i), r = rOf(i);
  return [size * Math.sqrt(3) * (q + 0.5 * (r & 1)), size * 1.5 * r];
}

// Hexes on the straight line from a to b (inclusive), by cube-coordinate interpolation.
export function hexLine(a, b) {
  const n = dist(a, b); if (!n) return [a];
  const [ax, ay, az] = toCube(a);
  let [bx, by, bz] = toCube(b);
  if (WRAP) { const dx = bx - ax; if (dx > W / 2) { bx -= W; bz += W; } else if (dx < -W / 2) { bx += W; bz -= W; } }   // toward the nearer image
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let x = ax + (bx - ax) * t + 1e-6, y = ay + (by - ay) * t + 1e-6, z = az + (bz - az) * t - 2e-6;
    let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz;
    const r = ry, q = rx + ((r - (r & 1)) >> 1);
    if (!inBounds(q, r)) continue;
    out.push(idx(q, r));
  }
  return out;
}
