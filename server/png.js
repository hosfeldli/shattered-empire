// Minimal PNG encoder + server-side continent preview renderer (lobby art is computed in the cloud).
import zlib from 'node:zlib';
import { World } from './sim/world.js';
import { tileColor } from './sim/render.js';
import { W, H } from './sim/constants.js';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc(buf) { let x = 0xffffffff; for (const v of buf) x = CRC[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); }

export function encodePNG(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const cache = new Map();
export function continentPreview(seed, scale = 6) {
  const key = seed + ':' + scale;
  if (cache.has(key)) return cache.get(key);
  const w = new World(seed); w.generate(2);
  const PW = Math.round(W * scale + scale / 2), PH = H * scale;
  const rgb = Buffer.alloc(PW * PH * 3);
  for (let y = 0; y < PH; y++) {
    const r = Math.floor(y / scale);
    for (let x = 0; x < PW; x++) {
      const q = Math.floor((x - (r & 1) * scale / 2) / scale);
      let c = 0x10181b;
      if (q >= 0 && q < W) { const i = r * W + q; c = w.river[i] ? 0x3f86c4 : tileColor(w, i); }
      const o = (y * PW + x) * 3; rgb[o] = c >> 16; rgb[o + 1] = (c >> 8) & 255; rgb[o + 2] = c & 255;
    }
  }
  const png = encodePNG(PW, PH, rgb);
  if (cache.size > 30) cache.clear();
  cache.set(key, png);
  return png;
}
