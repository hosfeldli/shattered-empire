// Render the generated continent to a PNG (debug tool): node test/preview.mjs <seed> <out.png>
import zlib from 'node:zlib';
import fs from 'node:fs';
import { World } from '../server/sim/world.js';
import { tileColor } from '../server/sim/render.js';
import { W, H } from '../server/sim/constants.js';
const seed = +(process.argv[2] || 1), out = process.argv[3] || 'preview.png';
const w = new World(seed); w.generate(2);
const S = 6, PW = W * S + S, PH = H * S;
const px = Buffer.alloc((PW * 3 + 1) * PH);
for (let y = 0; y < PH; y++) {
  px[y * (PW * 3 + 1)] = 0;
  const r = Math.floor(y / S);
  for (let x = 0; x < PW; x++) {
    const q = Math.floor((x - (r & 1) * S / 2) / S);
    let c = 0;
    if (q >= 0 && q < W) {
      const i = r * W + q; c = tileColor(w, i);
      if (w.river[i]) c = 0x3a78b8;
      if (w.starts.includes(i)) c = 0xff00ff;
      if (w.volcanoes.some((v) => v.tile === i)) c = 0xff3300;
    }
    const o = y * (PW * 3 + 1) + 1 + x * 3; px[o] = c >> 16; px[o + 1] = (c >> 8) & 255; px[o + 2] = c & 255;
  }
}
const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(PW, 0); ihdr.writeUInt32BE(PH, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', out, 'starts', w.starts);
