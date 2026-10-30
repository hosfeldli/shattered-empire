// Odd-r offset hex grid helpers (pointy-top hexes, odd rows shoved right).
import { W, H } from './constants.js';

const DIRS_EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const DIRS_ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

export const idx = (q, r) => r * W + q;
export const qOf = (i) => i % W;
export const rOf = (i) => (i / W) | 0;
export const inBounds = (q, r) => q >= 0 && r >= 0 && q < W && r < H;

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

export function dist(a, b) {
  const [ax, ay, az] = toCube(a), [bx, by, bz] = toCube(b);
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
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

// Pixel-space centre for a hex of "size" (radius) — used for continuous positions.
export function center(i, size = 1) {
  const q = qOf(i), r = rOf(i);
  return [size * Math.sqrt(3) * (q + 0.5 * (r & 1)), size * 1.5 * r];
}
