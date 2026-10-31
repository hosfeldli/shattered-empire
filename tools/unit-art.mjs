// Purpose-built unit artwork: top-down illustrated sprites for every unit type, drawn as SVG
// (facing right = heading 0), plus an accent mask per unit that the game tints with the owner's
// colour, plus role symbols for strategic zoom. `node tools/unit-art.mjs` renders them into a
// texture atlas (client/assets/units/atlas.webp + atlas.json) with the bundled Chromium.
import fs from 'node:fs';
import path from 'node:path';

const C = { olive: '#56603f', olive2: '#6b7550', dark: '#1b2016', metal: '#7b7f78', steel: '#5d625c', tire: '#161616', khaki: '#8a7b55', skin: '#c79b77', brown: '#6a4b2c', canvas: '#b4a77c', light: '#c9cfb9', glass: '#7fa6b8', red: '#b8432f', yellow: '#d8b13a' };
const S = 128;   // frame size; units are drawn in a 64-unit box scaled 2x

// one soldier seen from above at (x,y), facing right; `acc` marks the helmet as faction accent
function soldier(x, y, o = {}) {
  const r = o.r ?? 3.4, body = o.body ?? C.olive, helmet = o.helmet ?? C.olive2;
  const gun = o.gun === false ? '' : `<line x1="${x + 1}" y1="${y + 1.6}" x2="${x + 7.5}" y2="${y + 1.6}" stroke="${C.dark}" stroke-width="1.1" stroke-linecap="round"/>`;
  return {
    base: `<ellipse cx="${x - 0.6}" cy="${y}" rx="${r * 0.95}" ry="${r * 1.35}" fill="${body}" stroke="${C.dark}" stroke-width="0.7"/>${o.pack ? `<rect x="${x - r - 1.6}" y="${y - 1.6}" width="2.4" height="3.2" rx="0.6" fill="${C.khaki}" stroke="${C.dark}" stroke-width="0.4"/>` : ''}${gun}<circle cx="${x + 0.4}" cy="${y}" r="${r * 0.62}" fill="${helmet}" stroke="${C.dark}" stroke-width="0.6"/>`,
    acc: o.acc === false ? '' : `<circle cx="${x + 0.4}" cy="${y}" r="${r * 0.62}" fill="#fff"/>`,
  };
}
const squad = (pts, o) => pts.map(([x, y]) => soldier(x, y, o)).reduce((a, s) => ({ base: a.base + s.base, acc: a.acc + s.acc }), { base: '', acc: '' });
const wheels = (xs, y1, y2, w = 6, h = 3) => xs.map((x) => `<rect x="${x - w / 2}" y="${y1 - h / 2}" width="${w}" height="${h}" rx="1" fill="${C.tire}"/><rect x="${x - w / 2}" y="${y2 - h / 2}" width="${w}" height="${h}" rx="1" fill="${C.tire}"/>`).join('');
const tracks = (x, y, w, h) => `<rect x="${x}" y="${y - h / 2 - 3.2}" width="${w}" height="4.6" rx="1.4" fill="${C.tire}"/><rect x="${x}" y="${y + h / 2 - 1.4}" width="${w}" height="4.6" rx="1.4" fill="${C.tire}"/>${Array.from({ length: Math.floor(w / 3) }, (_, i) => `<line x1="${x + 1.5 + i * 3}" y1="${y - h / 2 - 3}" x2="${x + 1.5 + i * 3}" y2="${y - h / 2 + 1.4}" stroke="#2c2c2a" stroke-width="0.8"/><line x1="${x + 1.5 + i * 3}" y1="${y + h / 2 - 1.2}" x2="${x + 1.5 + i * 3}" y2="${y + h / 2 + 3.2}" stroke="#2c2c2a" stroke-width="0.8"/>`).join('')}`;
const shadow = (rx, ry, dx = 1.5, dy = 2) => `<ellipse cx="${32 + dx}" cy="${32 + dy}" rx="${rx}" ry="${ry}" fill="#000" opacity="0.22"/>`;

const ART = {
  militia: () => { const s = squad([[24, 22], [30, 30], [22, 36], [34, 41], [27, 46]], { body: '#6b5a3c', helmet: '#4b3a26', r: 3.2 }); return { base: s.base, acc: s.acc }; },
  rifle_squad: () => { const s = squad([[38, 32], [31, 25], [31, 39], [24, 20], [24, 44]], { pack: true }); return s; },
  special_forces: () => { const s = squad([[36, 30], [29, 36], [27, 26]], { body: '#2f3a2c', helmet: '#262e22', r: 3.1, pack: true }); return { base: s.base + `<line x1="38" y1="30.5" x2="46" y2="30.5" stroke="${C.dark}" stroke-width="1.6"/>`, acc: s.acc }; },
  exo_infantry: () => {
    let base = '', acc = '';
    for (const [x, y] of [[38, 32], [28, 24], [28, 40]]) {
      base += `<rect x="${x - 5.5}" y="${y - 6}" width="10" height="12" rx="3" fill="${C.steel}" stroke="${C.dark}" stroke-width="0.8"/><rect x="${x - 3}" y="${y - 3.2}" width="6" height="6.4" rx="2" fill="${C.metal}" stroke="${C.dark}" stroke-width="0.6"/><line x1="${x + 3}" y1="${y + 3.5}" x2="${x + 10}" y2="${y + 3.5}" stroke="${C.dark}" stroke-width="1.8" stroke-linecap="round"/>`;
      acc += `<rect x="${x - 5.5}" y="${y - 6}" width="3" height="12" rx="1.4" fill="#fff"/>`;
    }
    return { base, acc };
  },
  engineer: () => { const s = squad([[36, 26], [28, 36], [38, 40]], { gun: false, helmet: C.yellow }); return { base: `<rect x="20" y="22" width="9" height="6" rx="1" fill="${C.brown}" stroke="${C.dark}" stroke-width="0.6"/><line x1="44" y1="22" x2="52" y2="30" stroke="${C.brown}" stroke-width="1.6"/><rect x="50.5" y="28.5" width="4" height="3.5" fill="${C.metal}" transform="rotate(45 52 30)"/>` + s.base, acc: s.acc.replace(/fill="#fff"/g, 'fill="#fff" opacity="0.65"') }; },
  colonist: () => {
    const base = `${shadow(18, 10)}<rect x="16" y="23" width="26" height="18" rx="7" fill="${C.canvas}" stroke="${C.dark}" stroke-width="0.9"/>${[21, 27, 33, 39].map((x) => `<line x1="${x}" y1="23.5" x2="${x}" y2="40.5" stroke="#8d8160" stroke-width="0.8"/>`).join('')}${wheels([20, 37], 22, 42, 6, 2.6)}<line x1="42" y1="32" x2="50" y2="32" stroke="${C.brown}" stroke-width="1.4"/>` + squad([[52, 28], [52, 36]], { gun: false, body: '#7d6a4b', helmet: '#5b4a33', r: 2.8 }).base;
    return { base, acc: `<rect x="16" y="29" width="26" height="6" fill="#fff"/>` };
  },
  mortar_team: () => { const s = squad([[26, 24], [24, 40], [36, 42]], { gun: false }); return { base: `<circle cx="38" cy="30" r="4.5" fill="${C.steel}" stroke="${C.dark}" stroke-width="0.8"/><rect x="38" y="28.6" width="12" height="2.8" rx="1.2" fill="${C.dark}"/><line x1="33" y1="35" x2="38" y2="30" stroke="${C.dark}" stroke-width="1"/><line x1="43" y1="35" x2="38" y2="30" stroke="${C.dark}" stroke-width="1"/>` + s.base + `<rect x="16" y="30" width="6" height="5" fill="${C.khaki}" stroke="${C.dark}" stroke-width="0.5"/>`, acc: s.acc }; },
  field_gun: () => ({
    base: `${shadow(16, 10)}<line x1="14" y1="24" x2="30" y2="31" stroke="${C.olive2}" stroke-width="2.4" stroke-linecap="round"/><line x1="14" y1="40" x2="30" y2="33" stroke="${C.olive2}" stroke-width="2.4" stroke-linecap="round"/>${wheels([32], 21, 43, 7, 3.4)}<rect x="27" y="23" width="9" height="18" rx="2" fill="${C.olive}" stroke="${C.dark}" stroke-width="0.9"/><rect x="34" y="30" width="22" height="3.6" rx="1.4" fill="${C.dark}"/><rect x="54" y="29.3" width="4" height="5" rx="1" fill="${C.dark}"/>` + squad([[20, 30], [24, 46]], { gun: false, r: 2.8 }).base,
    acc: `<rect x="27" y="23" width="4" height="18" rx="1.4" fill="#fff"/>`,
  }),
  scout_buggy: () => ({
    base: `${shadow(14, 9)}${wheels([22, 41], 22, 42, 7, 3.4)}<path d="M17 26 L44 25 L50 32 L44 39 L17 38 Z" fill="${C.olive}" stroke="${C.dark}" stroke-width="0.9"/><rect x="25" y="27" width="12" height="10" rx="1.5" fill="${C.dark}" opacity="0.55"/><path d="M24 26 L38 26 M24 38 L38 38" stroke="${C.metal}" stroke-width="1.4"/><circle cx="29" cy="32" r="2.2" fill="${C.olive2}"/><line x1="33" y1="32" x2="46" y2="32" stroke="${C.dark}" stroke-width="1.3"/>`,
    acc: `<path d="M44 25 L50 32 L44 39 Z" fill="#fff"/>`,
  }),
  armored_car: () => ({
    base: `${shadow(17, 10)}${wheels([18, 30, 42], 20, 44, 7, 3.6)}<path d="M13 23 L46 23 L53 28 L53 36 L46 41 L13 41 Z" fill="${C.olive}" stroke="${C.dark}" stroke-width="1"/><rect x="40" y="27" width="6" height="10" fill="${C.glass}" opacity="0.5"/><circle cx="29" cy="32" r="6" fill="${C.olive2}" stroke="${C.dark}" stroke-width="0.9"/><rect x="34" y="30.8" width="13" height="2.4" rx="1" fill="${C.dark}"/>`,
    acc: `<circle cx="29" cy="32" r="6" fill="#fff"/>`,
  }),
  supply_truck: () => ({
    base: `${shadow(19, 10)}${wheels([16, 24, 42], 21, 43, 6, 3.2)}<rect x="10" y="22" width="28" height="20" rx="1.5" fill="${C.canvas}" stroke="${C.dark}" stroke-width="0.9"/>${[15, 21, 27, 33].map((x) => `<line x1="${x}" y1="22.5" x2="${x}" y2="41.5" stroke="#8d8160" stroke-width="0.8"/>`).join('')}<rect x="39" y="23" width="13" height="18" rx="2.5" fill="${C.olive}" stroke="${C.dark}" stroke-width="0.9"/><rect x="47" y="25" width="4" height="14" rx="1" fill="${C.glass}" opacity="0.6"/>`,
    acc: `<rect x="39" y="23" width="8" height="18" rx="2" fill="#fff"/>`,
  }),
  missile_battery: () => ({
    base: `${shadow(20, 10)}${wheels([14, 22, 34, 44], 21, 43, 6, 3.2)}<rect x="9" y="23" width="35" height="18" rx="1.5" fill="${C.olive}" stroke="${C.dark}" stroke-width="0.9"/><rect x="12" y="25" width="24" height="14" rx="1" fill="${C.steel}" stroke="${C.dark}" stroke-width="0.8"/><circle cx="15" cy="28.5" r="2" fill="${C.dark}"/><circle cx="15" cy="35.5" r="2" fill="${C.dark}"/><line x1="17" y1="28.5" x2="35" y2="28.5" stroke="#3a3d38" stroke-width="0.8"/><line x1="17" y1="35.5" x2="35" y2="35.5" stroke="#3a3d38" stroke-width="0.8"/><rect x="44" y="24" width="10" height="16" rx="2.5" fill="${C.olive2}" stroke="${C.dark}" stroke-width="0.9"/><rect x="50" y="26" width="3.4" height="12" fill="${C.glass}" opacity="0.6"/>`,
    acc: `<rect x="44" y="24" width="6" height="16" rx="2" fill="#fff"/>`,
  }),
  air_defense: () => ({
    base: `${shadow(17, 10)}${wheels([18, 30, 42], 20, 44, 7, 3.4)}<rect x="12" y="23" width="38" height="18" rx="3" fill="${C.olive}" stroke="${C.dark}" stroke-width="0.9"/><circle cx="30" cy="32" r="7" fill="${C.olive2}" stroke="${C.dark}" stroke-width="0.9"/><rect x="35" y="27.5" width="16" height="2" fill="${C.dark}"/><rect x="35" y="34.5" width="16" height="2" fill="${C.dark}"/><ellipse cx="20" cy="32" rx="2.5" ry="6.5" fill="${C.light}" stroke="${C.dark}" stroke-width="0.7"/>`,
    acc: `<circle cx="30" cy="32" r="7" fill="#fff"/>`,
  }),
  mech_infantry: () => ({
    base: `${shadow(19, 12)}${tracks(11, 32, 42, 18)}<path d="M12 24 L46 24 L53 29 L53 35 L46 40 L12 40 Z" fill="${C.olive}" stroke="${C.dark}" stroke-width="1"/><rect x="12" y="27" width="6" height="10" fill="${C.olive2}" stroke="${C.dark}" stroke-width="0.6"/><rect x="28" y="27" width="11" height="10" rx="2" fill="${C.olive2}" stroke="${C.dark}" stroke-width="0.9"/><rect x="38" y="31" width="15" height="2" fill="${C.dark}"/>`,
    acc: `<rect x="28" y="27" width="11" height="10" rx="2" fill="#fff"/>`,
  }),
  tank: () => ({
    base: `${shadow(21, 13)}${tracks(9, 32, 46, 20)}<rect x="10" y="22" width="44" height="20" rx="2.5" fill="${C.olive}" stroke="${C.dark}" stroke-width="1"/><rect x="12" y="25" width="8" height="14" fill="${C.olive2}" opacity="0.6"/><path d="M22 25 L36 24 L40 28 L40 36 L36 40 L22 39 Z" fill="${C.olive2}" stroke="${C.dark}" stroke-width="1"/><circle cx="27" cy="29" r="2.2" fill="${C.olive}" stroke="${C.dark}" stroke-width="0.6"/><rect x="39" y="30.6" width="22" height="2.8" rx="1" fill="${C.dark}"/><rect x="58" y="30" width="4" height="4" rx="0.8" fill="${C.dark}"/>`,
    acc: `<path d="M22 25 L36 24 L40 28 L40 36 L36 40 L22 39 Z" fill="#fff"/>`,
  }),
  sp_artillery: () => ({
    base: `${shadow(21, 13)}${tracks(8, 32, 46, 20)}<rect x="9" y="22" width="45" height="20" rx="2.5" fill="${C.olive}" stroke="${C.dark}" stroke-width="1"/><rect x="13" y="23.5" width="22" height="17" rx="2" fill="${C.olive2}" stroke="${C.dark}" stroke-width="1"/><rect x="35" y="30.3" width="27" height="3.4" rx="1.2" fill="${C.dark}"/><rect x="58" y="29.4" width="5" height="5.2" rx="1" fill="${C.dark}"/><rect x="46" y="25" width="6" height="4" fill="${C.khaki}"/>`,
    acc: `<rect x="13" y="23.5" width="22" height="17" rx="2" fill="#fff"/>`,
  }),
  autonomous_tank: () => ({
    base: `${shadow(21, 13)}${tracks(9, 32, 46, 20)}<path d="M9 24 L48 22 L56 28 L56 36 L48 42 L9 40 Z" fill="#454b45" stroke="${C.dark}" stroke-width="1"/><path d="M20 26 L38 25 L44 32 L38 39 L20 38 Z" fill="#5a615a" stroke="${C.dark}" stroke-width="1"/><rect x="43" y="30.8" width="18" height="2.4" fill="${C.dark}"/><line x1="18" y1="31.5" x2="44" y2="31.5" stroke="#5fd3ff" stroke-width="1.1" opacity="0.9"/><circle cx="24" cy="28" r="1.8" fill="#5fd3ff"/>`,
    acc: `<path d="M9 24 L16 24 L16 40 L9 40 Z" fill="#fff"/><path d="M48 22 L56 28 L52 30 L45 25 Z" fill="#fff"/>`,
  }),
  helicopter: () => ({
    base: `<ellipse cx="34" cy="40" rx="18" ry="6" fill="#000" opacity="0.18"/><rect x="6" y="30.5" width="24" height="3" rx="1.5" fill="${C.olive}" stroke="${C.dark}" stroke-width="0.6"/><rect x="5" y="27" width="3" height="10" rx="1" fill="${C.olive2}"/><path d="M26 25 L46 26 C52 27 54 30 54 32 C54 34 52 37 46 38 L26 39 Z" fill="${C.olive}" stroke="${C.dark}" stroke-width="1"/><path d="M45 27.5 C50 28.5 52 30 52 32 C52 34 50 35.5 45 36.5 Z" fill="${C.glass}" opacity="0.7"/><rect x="32" y="20" width="4" height="24" rx="1.2" fill="${C.olive2}" stroke="${C.dark}" stroke-width="0.6"/><circle cx="36" cy="32" r="17" fill="none" stroke="${C.dark}" stroke-width="0.6" opacity="0.4"/><line x1="20" y1="22" x2="52" y2="42" stroke="${C.dark}" stroke-width="1.6" opacity="0.55"/><line x1="20" y1="42" x2="52" y2="22" stroke="${C.dark}" stroke-width="1.6" opacity="0.55"/>`,
    acc: `<rect x="26" y="29.5" width="18" height="5" fill="#fff"/>`,
  }),
  recon_drone: () => ({
    base: `<ellipse cx="34" cy="38" rx="10" ry="4" fill="#000" opacity="0.15"/><path d="M22 32 L40 30 L46 32 L40 34 Z" fill="${C.light}" stroke="${C.dark}" stroke-width="0.8"/><path d="M28 31 L33 16 L36 16 L35 31 Z M28 33 L33 48 L36 48 L35 33 Z" fill="#9aa38e" stroke="${C.dark}" stroke-width="0.7"/><path d="M20 31.5 L22 26 L24 26 L23 31.5 Z M20 32.5 L22 38 L24 38 L23 32.5 Z" fill="#9aa38e" stroke="${C.dark}" stroke-width="0.5"/><circle cx="44" cy="32" r="1.6" fill="${C.glass}"/>`,
    acc: `<path d="M28 31 L33 16 L36 16 L35 31 Z" fill="#fff"/>`,
  }),
  strike_swarm: () => {
    let base = '', acc = '';
    for (const [x, y, s] of [[44, 32, 1], [34, 22, 0.85], [34, 42, 0.85], [24, 28, 0.75], [24, 38, 0.75]]) {
      base += `<path transform="translate(${x} ${y}) scale(${s})" d="M7 0 L-5 -6 L-2 0 L-5 6 Z" fill="#5c6457" stroke="${C.dark}" stroke-width="0.8"/>`;
      acc += `<path transform="translate(${x} ${y}) scale(${s})" d="M7 0 L-1 -2.4 L-1 2.4 Z" fill="#fff"/>`;
    }
    return { base: `<ellipse cx="34" cy="38" rx="16" ry="6" fill="#000" opacity="0.12"/>` + base, acc };
  },
};

// strategic role symbols (white; tinted and framed in the game)
const ICONS = {
  role_infantry: `<rect x="10" y="18" width="44" height="28" rx="2" fill="none" stroke="#fff" stroke-width="4"/><path d="M10 18 L54 46 M54 18 L10 46" stroke="#fff" stroke-width="4"/>`,
  role_armor: `<rect x="10" y="18" width="44" height="28" rx="2" fill="none" stroke="#fff" stroke-width="4"/><ellipse cx="32" cy="32" rx="14" ry="7" fill="none" stroke="#fff" stroke-width="4"/>`,
  role_mech: `<rect x="10" y="18" width="44" height="28" rx="2" fill="none" stroke="#fff" stroke-width="4"/><path d="M10 18 L54 46 M54 18 L10 46" stroke="#fff" stroke-width="3"/><ellipse cx="32" cy="32" rx="12" ry="6" fill="none" stroke="#fff" stroke-width="3"/>`,
  role_artillery: `<rect x="10" y="18" width="44" height="28" rx="2" fill="none" stroke="#fff" stroke-width="4"/><circle cx="32" cy="32" r="6" fill="#fff"/>`,
  role_recon: `<rect x="10" y="18" width="44" height="28" rx="2" fill="none" stroke="#fff" stroke-width="4"/><path d="M10 46 L54 18" stroke="#fff" stroke-width="4"/>`,
  role_air: `<path d="M8 34 L32 22 L56 34 L32 30 Z" fill="#fff"/><rect x="29" y="20" width="6" height="24" rx="2" fill="#fff"/><path d="M24 44 L40 44" stroke="#fff" stroke-width="4"/>`,
  role_support: `<rect x="10" y="18" width="44" height="28" rx="2" fill="none" stroke="#fff" stroke-width="4"/><path d="M10 40 L54 40" stroke="#fff" stroke-width="4"/><circle cx="32" cy="29" r="4" fill="#fff"/>`,
  role_civil: `<circle cx="32" cy="32" r="14" fill="none" stroke="#fff" stroke-width="4"/><circle cx="32" cy="32" r="4" fill="#fff"/>`,
};

// foot units are drawn larger so a squad reads at normal zoom
const ZOOM = { militia: 1.35, rifle_squad: 1.35, special_forces: 1.45, engineer: 1.35, mortar_team: 1.3, exo_infantry: 1.12, colonist: 1.1 };
const z = (k, svg) => (ZOOM[k] ? `<g transform="translate(32 32) scale(${ZOOM[k]}) translate(-32 -32)">${svg}</g>` : svg);
export function frames() {
  const out = [];
  for (const [k, f] of Object.entries(ART)) { const a = f(); out.push([k, z(k, a.base)], [k + '_accent', z(k, a.acc)]); }
  for (const [k, svg] of Object.entries(ICONS)) out.push([k, svg]);
  return out;
}
const wrapSvg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 64 64">${inner}</svg>`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { chromium } = await import('playwright');
  const list = frames(), cols = 8, rows = Math.ceil(list.length / cols);
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  const data = await page.evaluate(async ({ list, S, cols, rows }) => {
    const cv = document.createElement('canvas'); cv.width = cols * S; cv.height = rows * S; const ctx = cv.getContext('2d');
    const frames = {};
    for (let i = 0; i < list.length; i++) {
      const [name, svg] = list[i];
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const x = (i % cols) * S, y = Math.floor(i / cols) * S;
      ctx.drawImage(img, x, y, S, S);
      frames[name] = { frame: { x, y, w: S, h: S }, sourceSize: { w: S, h: S }, spriteSourceSize: { x: 0, y: 0, w: S, h: S } };
    }
    return { url: cv.toDataURL('image/webp', 0.92), frames, w: cv.width, h: cv.height };
  }, { list: list.map(([n, s]) => [n, wrapSvg(s)]), S, cols, rows });
  await browser.close();
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'client', 'assets', 'units');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'atlas.webp'), Buffer.from(data.url.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(dir, 'atlas.json'), JSON.stringify({ frames: data.frames, meta: { image: 'atlas.webp', size: { w: data.w, h: data.h }, scale: 1, note: 'generated by tools/unit-art.mjs' } }, null, 1));
  // a contact sheet for review
  fs.writeFileSync(path.join(dir, 'README.txt'), `Unit sprite atlas: ${list.length} frames (${S}px), facing right. Base art + *_accent masks (tinted with the owner's colour) + role_* strategic symbols.\nRegenerate: node tools/unit-art.mjs\n`);
  console.log('atlas', data.w, 'x', data.h, list.length, 'frames');
}
