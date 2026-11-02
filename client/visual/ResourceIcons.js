// Small coloured pictures for goods and deposits (wheat for food, logs for materials, an I-beam for
// steel, a barrel for fuel, a coin for credits; an oil drop, ore, coal, crystals, quarried stone, a
// fish and a broken column for deposits), drawn in a ±6 box through one pen so the same pictures
// render on the map (PIXI.Graphics) and in the HUD (a cached canvas image).

// ops: [kind, ...geometry, fill, stroke?]; kinds: p polygon, c circle, e ellipse, r rect, rr round rect, l polyline (stroked)
const GOOD = {
  food: [['l', [0, 6, 0, -4], 0.9, 0x8a6a2a], ['e', -1.4, -3.4, 1.2, 2, 0xe8c24a], ['e', 1.4, -3.4, 1.2, 2, 0xe8c24a], ['e', -1.5, -0.2, 1.2, 2, 0xd9b03e], ['e', 1.5, -0.2, 1.2, 2, 0xd9b03e], ['e', -1.5, 2.8, 1.1, 1.8, 0xc99f34], ['e', 1.5, 2.8, 1.1, 1.8, 0xc99f34], ['e', 0, -5.2, 0.9, 1.5, 0xf0d060]],
  materials: [['rr', -5.6, -1.2, 11.2, 3.2, 1.4, 0x8a5a32, 0x4a2e18], ['rr', -4.4, -4.4, 8.8, 3.2, 1.4, 0x9a6a3a, 0x4a2e18], ['rr', -5.6, 2, 11.2, 3.2, 1.4, 0x7a4e2a, 0x4a2e18], ['c', 5.2, 0.4, 1.4, 0xd8b88a, 0x4a2e18], ['c', 4, -2.8, 1.4, 0xd8b88a, 0x4a2e18], ['c', 5.2, 3.6, 1.4, 0xd8b88a, 0x4a2e18]],
  ore: [['p', [-5.4, 3, -3.6, -3, 0.4, -5, 4.8, -2, 5.4, 3.2, 0.6, 5], 0x7a6e66, 0x2e2a26], ['c', -1.6, -0.6, 1.1, 0xb8643a], ['c', 2.2, 1.4, 0.9, 0xb8643a], ['c', 0.6, -2.8, 0.7, 0xc8784a]],
  steel: [['p', [-5.4, -4.6, 5.4, -4.6, 5.4, -2.8, 1.2, -2.8, 1.2, 2.8, 5.4, 2.8, 5.4, 4.6, -5.4, 4.6, -5.4, 2.8, -1.2, 2.8, -1.2, -2.8, -5.4, -2.8], 0x9aa8b4, 0x3a4450]],
  fuel: [['rr', -3.8, -5.4, 7.6, 10.8, 1.6, 0xa83a2a, 0x401812], ['r', -3.8, -2.4, 7.6, 1, 0x60201a], ['r', -3.8, 1.6, 7.6, 1, 0x60201a], ['c', 1.6, -4.2, 0.7, 0xe8d0a0]],
  electronics: [['r', -4, -4, 8, 8, 0x2e6a3a, 0x0e2a16], ['r', -2, -2, 4, 4, 0x1a1e1c], ...[-3, -1, 1, 3].flatMap((y) => [['r', -6, y - 0.4, 2, 0.8, 0xd8c070], ['r', 4, y - 0.4, 2, 0.8, 0xd8c070]])],
  munitions: [['p', [-1.8, 5.4, -1.8, -1.4, 0, -5.6, 1.8, -1.4, 1.8, 5.4], 0xd8a84a, 0x5a3e12], ['r', -1.8, 3.2, 3.6, 0.8, 0x8a6a2a]],
  credits: [['c', 0, 0, 5.4, 0xe8b83a, 0x7a5a12], ['c', 0, 0, 3.6, 0xf4d070, 0xb88a22], ['r', -0.6, -2.2, 1.2, 4.4, 0xb88a22]],
  research: [['p', [-1.4, -5.4, 1.4, -5.4, 1.4, -1.6, 4.8, 4.4, -4.8, 4.4, -1.4, -1.6], 0xdfeaf0, 0x3a5060], ['p', [-3.2, 1.4, 3.2, 1.4, 4.8, 4.4, -4.8, 4.4], 0x5ab4e0]],
};
const DEPOSIT = {
  1: [['p', [0, -5.8, 3.8, 0.6, 3.6, 3, 0, 5.4, -3.6, 3, -3.8, 0.6], 0x1a1816, 0x0a0908], ['e', -1.2, 0.6, 0.9, 1.6, 0x6a6a7a]],
  2: [['p', [-5.4, 3, -3.6, -3, 0.4, -5, 4.8, -2, 5.4, 3.2, 0.6, 5], 0x8a4a32, 0x3a1a10], ['c', -1.6, -0.6, 1.2, 0xd88a5a], ['c', 2.2, 1.4, 1, 0xd88a5a]],
  3: [['p', [-5.6, 4, -4, -1, -0.6, -1.6, 0.4, 4], 0x262422, 0x0a0908], ['p', [-0.8, 4, 0.6, -3.8, 4.4, -4.4, 5.6, 4], 0x1a1816, 0x0a0908], ['e', 2.6, -1, 0.7, 1.4, 0x6a6a6a]],
  4: [['p', [-1, 5, -3.6, -1, -1.6, -5.6, 0.6, -1], 0xa66ae0, 0x40206a], ['p', [0.4, 5, 1.2, -2, 3.8, -4, 4.4, 2], 0xc89af0, 0x40206a], ['p', [-4.6, 5, -5.4, 1, -3.2, -0.6, -2, 5], 0x8a52c8, 0x40206a]],
  5: [['r', -5.4, 0.4, 5, 4.6, 0xcfc6b2, 0x5a5242], ['r', 0.4, 0.4, 5, 4.6, 0xbab09a, 0x5a5242], ['r', -2.6, -4.6, 5.2, 4.6, 0xdcd4c2, 0x5a5242]],
  6: [['e', -1, 0, 4.2, 2.6, 0x4a9ad0, 0x103050], ['p', [2.8, 0, 5.8, -2.8, 5.8, 2.8], 0x4a9ad0, 0x103050], ['c', -3.2, -0.6, 0.6, 0x0a1a28]],
  7: [['r', -4.6, -4.2, 2.4, 9.2, 0xd8c8a0, 0x5a4a2a], ['r', 2.2, -1.2, 2.4, 6.2, 0xd8c8a0, 0x5a4a2a], ['r', -5.6, 4.6, 11.2, 1.2, 0xb8a880, 0x5a4a2a], ['p', [-5.4, -4.2, -1.4, -4.2, 0.6, -5.6, -5.4, -5.6], 0xc8b890, 0x5a4a2a]],
};

function trace(pen, ops) {
  for (const op of ops) {
    const [k, ...a] = op;
    if (k === 'l') { pen.line(a[0], a[1], a[2]); continue; }
    let fill, stroke;
    if (k === 'p') { pen.poly(a[0]); [fill, stroke] = [a[1], a[2]]; }
    else if (k === 'c') { pen.circle(a[0], a[1], a[2]); [fill, stroke] = [a[3], a[4]]; }
    else if (k === 'e') { pen.ellipse(a[0], a[1], a[2], a[3]); [fill, stroke] = [a[4], a[5]]; }
    else if (k === 'r') { pen.rect(a[0], a[1], a[2], a[3]); [fill, stroke] = [a[4], a[5]]; }
    else if (k === 'rr') { pen.rrect(a[0], a[1], a[2], a[3], a[4]); [fill, stroke] = [a[5], a[6]]; }
    pen.paint(fill, stroke);
  }
}
const opsOf = (key) => GOOD[key] || DEPOSIT[key] || null;

// onto a PIXI.Graphics, centred at (x, y), k = scale (the icon is ~12k across)
export function drawResIcon(g, key, x = 0, y = 0, k = 1, alpha = 1) {
  const ops = opsOf(key); if (!ops) return;
  const pen = {
    poly: (p) => g.poly(p.map((v, i) => (i % 2 ? y : x) + v * k)),
    circle: (cx, cy, r) => g.circle(x + cx * k, y + cy * k, r * k),
    ellipse: (cx, cy, rx, ry) => g.ellipse(x + cx * k, y + cy * k, rx * k, ry * k),
    rect: (rx, ry, w, h) => g.rect(x + rx * k, y + ry * k, w * k, h * k),
    rrect: (rx, ry, w, h, r) => g.roundRect(x + rx * k, y + ry * k, w * k, h * k, r * k),
    line: (p, w, col) => { g.moveTo(x + p[0] * k, y + p[1] * k); for (let i = 2; i < p.length; i += 2) g.lineTo(x + p[i] * k, y + p[i + 1] * k); g.stroke({ width: w * k, color: col, alpha }); },
    paint: (fill, stroke) => { g.fill({ color: fill, alpha }); if (stroke != null) g.stroke({ width: 0.6 * k, color: stroke, alpha }); },
  };
  trace(pen, ops);
}

// HUD: a cached image (data URL)
const cache = new Map();
export function resIconURL(key) {
  if (cache.has(key)) return cache.get(key);
  if (typeof document === 'undefined' || !opsOf(key)) return '';
  const S = 4, size = 14 * S, c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d'); x.translate(size / 2, size / 2); x.scale(S, S); x.lineJoin = 'round'; x.lineCap = 'round';
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  const pen = {
    poly: (p) => { x.beginPath(); x.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]); x.closePath(); },
    circle: (cx, cy, r) => { x.beginPath(); x.arc(cx, cy, r, 0, 7); },
    ellipse: (cx, cy, rx, ry) => { x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, 7); },
    rect: (rx, ry, w, h) => { x.beginPath(); x.rect(rx, ry, w, h); },
    rrect: (rx, ry, w, h, r) => { x.beginPath(); x.roundRect(rx, ry, w, h, r); },
    line: (p, w, col) => { x.beginPath(); x.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]); x.lineWidth = w; x.strokeStyle = hex(col); x.stroke(); },
    paint: (fill, stroke) => { x.fillStyle = hex(fill); x.fill(); if (stroke != null) { x.lineWidth = 0.6; x.strokeStyle = hex(stroke); x.stroke(); } },
  };
  trace(pen, opsOf(key));
  const url = c.toDataURL(); cache.set(key, url); return url;
}
