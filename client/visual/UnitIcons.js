// A distinct silhouette for every unit type: a rifleman is not a tank is not a field gun, at any zoom
// and without reading a word. Icons are drawn in a ±6 box (facing right) through a tiny pen so the
// same shapes render into the map (PIXI.Graphics) and into the HUD (a cached canvas image).
// Badges carry the owner's colour; their shape says the class: round for infantry, a rounded box
// for vehicles, a diamond for aircraft.

// each icon: a list of [op, ...args]; 'p' polygon, 'c' circle, 'r' rect, 'l' polyline (stroked),
// 'e' ellipse. Everything is filled with the icon colour unless it is a polyline.
const person = (x, s = 1) => [['c', x, -3.6 * s, 1.35 * s], ['p', [x - 1.5 * s, -2 * s, x + 1.5 * s, -2 * s, x + 1.8 * s, 1.8 * s, x + 1.1 * s, 1.8 * s, x + 1.1 * s, 5 * s, x - 1.1 * s, 5 * s, x - 1.1 * s, 1.8 * s, x - 1.8 * s, 1.8 * s]]];
const wheel = (x, y, r = 1.6) => ['c', x, y, r];
export const ICONS = {
  militia: [...person(0), ['l', [-3.2, 3.6, 3.4, -5.4], 0.9], ['p', [-1.8, -4.6, 1.8, -4.6, 1.2, -5.6, -1.2, -5.6]]],
  rifle_squad: [...person(-2.4, 0.9), ...person(2.4, 0.9), ['l', [-5, 2.5, 0.2, -5.2], 0.8], ['l', [0, 2.5, 5.4, -5.2], 0.8]],
  special_forces: [['p', [-5.2, 0.6, 3.2, -0.9, 6, 0, 3.2, 0.9, -5.2, 0.9]], ['r', -5.6, -2.2, 1.2, 4.4], ['r', -7.4, -0.8, 2, 1.6], ['p', [-1, -5.4, 0, -3.4, 1, -5.4, 0, -4.8]]],
  exo_infantry: [['r', -1.6, -5.6, 3.2, 2.6], ['p', [-4.6, -2.6, 4.6, -2.6, 4, 1.6, 2.2, 1.6, 2.4, 5.4, 0.4, 5.4, 0, 2, -0.4, 5.4, -2.4, 5.4, -2.2, 1.6, -4, 1.6]], ['r', -5.6, -2.4, 1.4, 4.2], ['r', 4.2, -2.4, 1.4, 4.2]],
  engineer: [['l', [-4.6, 4.6, 2.2, -2.2], 1.6], ['c', 3.2, -3.2, 2.6], ['p', [2.4, -6.4, 4, -6.4, 3.6, -3.6, 2.8, -3.6]], ['l', [4.6, 4.6, -2.6, -2.6], 1.2], ['p', [-2, -2, -5.4, -5.4, -4.2, -6, -1.2, -3]]],
  colonist: [['p', [-5.6, 1.4, -5.6, -1.6, -4, -4.6, 4, -4.6, 5.6, -1.6, 5.6, 1.4]], wheel(-3.4, 3.2, 1.9), wheel(3.4, 3.2, 1.9)],
  mortar_team: [['p', [-2.4, 4.4, -0.8, 4.4, 3.8, -5, 2.4, -5.6]], ['r', -5, 4.2, 6.4, 1.4], ['l', [1.2, -0.6, 4, 4.8], 0.8], ['l', [1.2, -0.6, -1, 4.6], 0.8]],
  field_gun: [['p', [-1, -1.2, 6.2, -3.6, 6.2, -2.2, -0.6, 0.6]], ['p', [-6, 4, -1.4, -0.2, -0.4, 1, -5, 5]], ['c', 0, 2, 3], ['c', 0, 2, 1.1, 1]],
  scout_buggy: [['p', [-5.6, 1, -4, -1, 3.4, -1, 5.8, 0.6, 5.8, 1.6, -5.6, 1.6]], ['l', [-2.8, -1, -1.6, -4.2, 1.6, -4.2, 2.2, -1], 0.9], wheel(-3.4, 2.6, 2.1), wheel(3.6, 2.6, 2.1)],
  armored_car: [['p', [-5.8, 1.6, -5.8, -1.6, -3.6, -3, 4, -3, 5.8, -0.6, 5.8, 1.6]], ['r', -1.6, -5.2, 3.6, 2.4], ['r', 2, -4.6, 4, 0.9], wheel(-3.8, 2.8), wheel(0, 2.8), wheel(3.8, 2.8)],
  supply_truck: [['r', -6, -4, 7.6, 5.6], ['p', [2.2, 1.6, 2.2, -2.4, 4.6, -2.4, 6, -0.4, 6, 1.6]], wheel(-3.6, 2.8), wheel(3.8, 2.8)],
  missile_battery: [['r', -6, -0.4, 12, 2.2], ['p', [-4.4, -0.6, 3.6, -5.8, 4.6, -4.6, -3.4, 0.6]], ['p', [3.6, -5.8, 5.8, -6.6, 4.6, -4.6]], wheel(-3.6, 2.8), wheel(0, 2.8), wheel(3.6, 2.8)],
  air_defense: [['r', -6, -0.6, 12, 2.4], ['r', -2.6, -2.8, 4.4, 2.4], ['l', [-0.6, -2.6, 2.6, -6.4], 0.9], ['l', [0.8, -2.6, 4, -6.4], 0.9], ['p', [-5.6, -4.8, -3.4, -6.4, -3, -3]], wheel(-3.8, 2.8), wheel(3.8, 2.8)],
  mech_infantry: [['p', [-6, 1.2, -6, -2.8, -4.4, -4.4, 4.4, -4.4, 6.2, -1.4, 6.2, 1.2]], ['r', -4, -3.2, 1.6, 1.3, 1], ['r', -1.6, -3.2, 1.6, 1.3, 1], ['r', 0.8, -3.2, 1.6, 1.3, 1], ['r', 2.2, -5.8, 3.8, 0.9], ['e', 0, 3, 6.2, 1.8], ['c', -3.8, 3, 0.8, 1], ['c', 0, 3, 0.8, 1], ['c', 3.8, 3, 0.8, 1]],
  tank: [['p', [-5.6, 1.2, -5.6, -1.2, 5.6, -1.2, 5.6, 1.2]], ['p', [-3, -1.2, -2.2, -4, 2.6, -4, 3.2, -1.2]], ['r', 2.6, -3.2, 4.4, 1], ['e', 0, 2.8, 6.2, 1.9]],
  sp_artillery: [['p', [-5.6, 1.2, -5.6, -1.2, 5.6, -1.2, 5.6, 1.2]], ['r', -4.6, -4.6, 6, 3.4], ['p', [1.2, -4.2, 6.4, -7, 6.8, -6.2, 1.4, -3.2]], ['e', 0, 2.8, 6.2, 1.9]],
  autonomous_tank: [['p', [-6, 1.2, -4.6, -1.6, 5, -1.6, 6, 1.2]], ['p', [-2.8, -1.6, -1.2, -4.4, 2.6, -4.4, 3.4, -1.6]], ['r', 2.8, -3.6, 4.2, 0.9], ['l', [-2, -4.4, -3.4, -7], 0.6], ['c', -3.4, -7, 0.7], ['e', 0, 2.8, 6.2, 1.9]],
  helicopter: [['e', -0.6, 0, 3.6, 2.4], ['p', [2, -0.6, 6.4, -1.4, 6.4, 0.4, 2, 0.8]], ['r', 5.6, -3, 0.9, 3.4], ['l', [-6, -3.6, 4.6, -3.6], 0.8], ['r', -0.9, -3.6, 1, 1.6], ['l', [-4, 3.6, 2, 3.6], 0.8], ['l', [-2.6, 2, -2.6, 3.6], 0.6], ['l', [0.8, 2, 0.8, 3.6], 0.6]],
  recon_drone: [['l', [-4, -4, 4, 4], 1], ['l', [4, -4, -4, 4], 1], ['c', 0, 0, 1.5], ['c', -4.4, -4.4, 1.7], ['c', 4.4, -4.4, 1.7], ['c', -4.4, 4.4, 1.7], ['c', 4.4, 4.4, 1.7]],
  fighter: [['p', [6.4, 0, 3, -0.9, -0.6, -5.4, -2.4, -5.4, -1.4, -1, -4.6, -1.2, -6, -3.4, -6.6, -3.4, -5.8, 0, -6.6, 3.4, -6, 3.4, -4.6, 1.2, -1.4, 1, -2.4, 5.4, -0.6, 5.4, 3, 0.9]]],
  bomber: [['p', [6.2, 0, 4.4, -1, 1.4, -1, 0.6, -6.4, -1.4, -6.4, -1.6, -1, -4.8, -1, -6, -3, -6.6, -3, -6, 0, -6.6, 3, -6, 3, -4.8, 1, -1.6, 1, -1.4, 6.4, 0.6, 6.4, 1.4, 1, 4.4, 1]], ['c', 0.2, -3.4, 0.7, 1], ['c', 0.2, 3.4, 0.7, 1]],
  oneway_drone: [['p', [6, 0, -4.4, -5.4, -2.6, 0, -4.4, 5.4]], ['l', [-5.8, -2, -5.8, 2], 0.9]],
  strike_swarm: [['p', [0.4, -3.6, -4, -6, -3, -3.6, -4, -1.2]], ['p', [6.2, 0, 1.8, -2.4, 2.8, 0, 1.8, 2.4]], ['p', [0.4, 3.6, -4, 1.2, -3, 3.6, -4, 6]]],
};
const FALLBACK = [['c', 0, 0, 3]];

// draw an icon through a pen: { poly(pts), circle(x,y,r), rect(x,y,w,h), ellipse(x,y,rx,ry), line(pts,w), fill(), hole() }
function trace(pen, type) {
  for (const op of ICONS[type] || FALLBACK) {
    const [k, ...a] = op;
    if (k === 'l') { pen.line(a[0], a[1]); continue; }
    if (k === 'p') pen.poly(a[0]);
    else if (k === 'c') pen.circle(a[0], a[1], a[2]);
    else if (k === 'r') pen.rect(a[0], a[1], a[2], a[3]);
    else if (k === 'e') pen.ellipse(a[0], a[1], a[2], a[3]);
    // a trailing 1 cuts the shape out of the badge colour (a wheel hub, an engine)
    if (a[k === 'c' ? 3 : k === 'p' ? 1 : 4] === 1) pen.hole(); else pen.fill();
  }
}

// Map: the icon into a PIXI.Graphics (local ±6 box, scaled by k)
export function drawUnitIcon(g, type, color = 0xffffff, k = 1, holeColor = 0x000000) {
  const pen = {
    poly: (p) => { g.poly(p.map((v) => v * k)); },
    circle: (x, y, r) => { g.circle(x * k, y * k, r * k); },
    rect: (x, y, w, h) => { g.rect(x * k, y * k, w * k, h * k); },
    ellipse: (x, y, rx, ry) => { g.ellipse(x * k, y * k, rx * k, ry * k); },
    line: (p, w) => { g.moveTo(p[0] * k, p[1] * k); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] * k, p[i + 1] * k); g.stroke({ width: w * k, color, cap: 'round', join: 'round' }); },
    fill: () => { g.fill({ color }); }, hole: () => { g.fill({ color: holeColor }); },
  };
  trace(pen, type);
}

export const badgeShape = (def) => (def.move === 'aircraft' ? 'air' : def.move === 'infantry' ? 'inf' : 'veh');
const shadeC = (c, f) => (Math.min(255, ((c >> 16) & 255) * f) << 16) | (Math.min(255, ((c >> 8) & 255) * f) << 8) | Math.min(255, (c & 255) * f);
export const badgeFill = (col) => shadeC(col, 0.55);

// the badge behind the icon: shape by class, filled with a darkened owner colour, rimmed in it
export function drawBadge(g, def, col, r = 8) {
  const fill = badgeFill(col), dark = 0x0b1518;
  const shape = badgeShape(def);
  if (shape === 'inf') g.circle(0, 0, r);
  else if (shape === 'air') g.poly([0, -r * 1.12, r * 1.12, 0, 0, r * 1.12, -r * 1.12, 0]);
  else g.roundRect(-r * 1.15, -r * 0.82, r * 2.3, r * 1.64, r * 0.3);
  g.fill({ color: fill }).stroke({ width: 1.3, color: col });
  if (shape === 'inf') g.circle(0, 0, r + 0.9).stroke({ width: 0.8, color: dark, alpha: 0.8 });
  else if (shape === 'air') g.poly([0, -r * 1.12 - 1, r * 1.12 + 1, 0, 0, r * 1.12 + 1, -r * 1.12 - 1, 0]).stroke({ width: 0.8, color: dark, alpha: 0.8 });
  else g.roundRect(-r * 1.15 - 0.9, -r * 0.82 - 0.9, r * 2.3 + 1.8, r * 1.64 + 1.8, r * 0.3 + 0.9).stroke({ width: 0.8, color: dark, alpha: 0.8 });
  return fill;
}

// HUD: a cached image (data URL) of a unit's icon on a neutral badge
const urlCache = new Map();
export function unitIconURL(type, def, col = 0x8fd19e) {
  const key = type + ':' + col;
  if (urlCache.has(key)) return urlCache.get(key);
  if (typeof document === 'undefined') return '';
  const S = 3, size = 22 * S, c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d'); x.translate(size / 2, size / 2); x.scale(S * 1.25, S * 1.25);
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  const fill = badgeFill(col), shape = badgeShape(def || {});
  x.beginPath();
  if (shape === 'inf') x.arc(0, 0, 7.4, 0, 7);
  else if (shape === 'air') { x.moveTo(0, -8.2); x.lineTo(8.2, 0); x.lineTo(0, 8.2); x.lineTo(-8.2, 0); x.closePath(); }
  else x.roundRect(-8.2, -6, 16.4, 12, 2.4);
  x.fillStyle = hex(fill); x.fill(); x.lineWidth = 1; x.strokeStyle = hex(col); x.stroke();
  x.fillStyle = '#ffffff'; x.strokeStyle = '#ffffff'; x.lineCap = 'round'; x.lineJoin = 'round';
  x.scale(0.95, 0.95);
  const pen = {
    poly: (p) => { x.beginPath(); x.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]); x.closePath(); },
    circle: (cx, cy, r) => { x.beginPath(); x.arc(cx, cy, r, 0, 7); },
    rect: (rx, ry, w, h) => { x.beginPath(); x.rect(rx, ry, w, h); },
    ellipse: (ex, ey, rx, ry) => { x.beginPath(); x.ellipse(ex, ey, rx, ry, 0, 0, 7); },
    line: (p, w) => { x.beginPath(); x.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]); x.lineWidth = w; x.stroke(); },
    fill: () => { x.fillStyle = '#ffffff'; x.fill(); }, hole: () => { x.fillStyle = hex(fill); x.fill(); },
  };
  trace(pen, type);
  const url = c.toDataURL();
  urlCache.set(key, url);
  return url;
}
