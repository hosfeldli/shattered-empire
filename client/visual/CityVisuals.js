// Districts: a city's footprint fills with residential, commercial and industrial blocks as it
// grows. Layout is derived deterministically from the city id and its hexes, so it only changes
// when population, damage, era or ownership change. Streets join real roads; decor never implies
// passability that the navigation system does not have (it is drawn inside owned land hexes only).
/* global PIXI */
import { h } from './VisualLOD.js';

const STYLE = [
  { res: [0x7a5b3e, 0x8a6a48, 0x6b5a4a], com: [0x8f7a55], ind: [0x5e5148], tall: 1 },   // Reclamation: patched shacks
  { res: [0x8c4a34, 0x9b5a3c, 0x7d4b3b], com: [0xa06a45], ind: [0x5a4a42], tall: 1.3 }, // Industrial: brick
  { res: [0x8d8f91, 0x9a9c9e, 0x7e8183], com: [0xb0a99a], ind: [0x6a6e72], tall: 1.6 }, // Mechanization: concrete
  { res: [0x7a95a8, 0x8aa3b5, 0x6d8698], com: [0x93b6cc], ind: [0x5f7180], tall: 2.0 }, // Networked: glass
  { res: [0xd6e2e6, 0xc2d6d9, 0xe7ecec], com: [0x9fe0d8], ind: [0x7ab0b0], tall: 2.6 }, // Advanced: white towers
];
const INDUSTRIAL = new Set(['mine', 'steel_mill', 'power_plant', 'munitions_plant', 'oil_well', 'motor_works', 'heavy_assembly', 'electronics_plant', 'fusion_plant', 'robotics_complex', 'drone_works', 'salvage', 'quarry']);

export class CityVisuals {
  constructor(view, S) { this.view = view; this.S = S; this.cities = new Map(); }

  eraOf(o) { const S = this.S; return o === S.civId ? S.econ?.age || 0 : S.civInfo[o]?.age ?? S.econ?.age ?? 0; }

  update() {
    const S = this.S, v = this.view;
    for (const [id, rec] of this.cities) if (!S.cities.has(id)) { rec.g.destroy(); this.cities.delete(id); }
    for (const c of S.cities.values()) {
      const era = this.eraOf(c.o);
      const key = [c.o, Math.floor(c.pop / 3), Math.round((c.dmg || 0) / 10), era, c.r, S.buildingsVersion, S.ruinsVersion, S.urbanVersion || 0].join('|');
      let rec = this.cities.get(c.id);
      if (rec && rec.key === key) continue;
      if (!rec) { rec = { g: new PIXI.Graphics() }; v.districtLayer.addChild(rec.g); v.mirrorOf?.(rec.g); this.cities.set(c.id, rec); }
      rec.key = key;
      this.build(rec, c, era);
    }
  }

  build(rec, c, era) {
    const S = this.S, v = this.view, g = rec.g; g.clear();
    const base = v.cx0 || v.cx, X = (t) => (v.near ? v.near(base[t], base[c.t]) : base[t]);
    const st = STYLE[Math.min(4, era)];
    const rad = Math.min(3, c.r || 3);
    const cand = [];
    for (let q = -rad - 1; q <= rad + 1; q++) for (let r = -rad; r <= rad; r++) {
      const r0 = (c.t / v.W) | 0, rr2 = r0 + r; if (rr2 < 0 || rr2 >= v.H) continue;
      let q2 = (c.t % v.W) + q; if (v.wrap) q2 = (q2 + v.W) % v.W; else if (q2 < 0 || q2 >= v.W) continue;
      const t = rr2 * v.W + q2;
      const d = hexDist(v, c.t, t); if (d < 1 || d > rad) continue;
      const ter = S.terr[t];
      if (ter === 255 || ter <= 1 || ter >= 9 || S.owner[t] !== c.o || S.buildingTiles.has(t) || S.ruins.has(t)) continue;
      cand.push([t, d + h(c.id, t) * 0.6]);
    }
    cand.sort((a, b) => a[1] - b[1]);
    // the server's developed footprint is authoritative (trenches cannot exist there); draw
    // districts exactly on it, falling back to a population estimate before it is known
    const urban = S.urban ? cand.filter(([t]) => S.urban[t]).map((x) => x[0]) : [];
    const nHex = Math.max(1, Math.min(cand.length, Math.round(c.pop / 5)));
    const hexes = urban.length ? urban : cand.slice(0, nHex).map((x) => x[0]);
    const set = new Set(hexes);
    rec.blocks = []; rec.streets = []; rec.hexes = hexes;
    // streets: between developed hexes and from the town centre; they reuse real road directions where present
    for (const t of [c.t, ...hexes]) for (let d = 0; d < 3; d++) {
      const n = v.nb(t, d); if (n < 0 || !(set.has(n) || n === c.t) || !(set.has(t) || t === c.t)) continue;
      rec.streets.push([X(t), v.cy[t], X(n), v.cy[n]]);
    }
    for (const s of rec.streets) g.moveTo(s[0], s[1]).lineTo(s[2], s[3]);
    if (rec.streets.length) g.stroke({ width: 1.6, color: 0x5d5a52, alpha: 0.75 });
    const dens = Math.min(7, 2 + Math.floor(c.pop / 18));
    const dmg = (c.dmg || 0) / 100;
    for (const t of hexes) {
      let ind = false;
      for (let d = 0; d < 6; d++) { const n = v.nb(t, d); const b = n >= 0 ? S.buildingAtTile.get(n) : null; if (b && INDUSTRIAL.has(b.ty)) ind = true; }
      const dist = hexDist(v, c.t, t);
      const type = ind ? 'ind' : dist === 1 && era >= 1 ? 'com' : 'res';
      const pal = st[type];
      for (let k = 0; k < dens; k++) {
        const a = h(c.id, t, k) * Math.PI * 2, rr = 2.5 + h(t, k, 7) * 6.5;
        const x = X(t) + Math.cos(a) * rr, y = v.cy[t] + Math.sin(a) * rr;
        const w = (type === 'ind' ? 4 : 2.6) + h(t, k, 3) * 2, hh = (type === 'ind' ? 3 : 2.2) + h(t, k, 5) * 1.6;
        const ruined = h(c.id, t, k + 99) < dmg;
        const tall = st.tall * (type === 'com' ? 1.4 : 1) * (0.7 + h(t, k, 9) * 0.6);
        if (ruined) { g.rect(x - w / 2, y - hh / 2, w, hh).fill({ color: 0x3a3430 }); g.circle(x + 0.6, y, 0.8).fill({ color: 0x7c7062 }); rec.blocks.push({ x, y, w, h: hh, ruined: true }); continue; }
        g.rect(x - w / 2 + tall, y - hh / 2 + tall, w, hh).fill({ color: 0x000000, alpha: 0.25 });          // shadow grows with height
        g.rect(x - w / 2, y - hh / 2, w, hh).fill({ color: pal[(k + t) % pal.length] }).stroke({ width: 0.4, color: 0x1b1b1b, alpha: 0.6 });
        rec.blocks.push({ x, y, w, h: hh, type, tall });
      }
      if (era >= 2 && type === 'res' && h(c.id, t, 51) < 0.35) g.circle(X(t) + 4, v.cy[t] + 4, 2.2).fill({ color: 0x4f7a3a, alpha: 0.9 }); // a park
    }
  }
}

export function hexDist(v, a, b) {
  const cube = (i) => { const q = i % v.W, r = (i / v.W) | 0; const x = q - ((r - (r & 1)) >> 1); return [x, r, -x - r]; };
  const [ax, ay, az] = cube(a), [bx, by, bz] = cube(b);
  const d0 = Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
  if (!v.wrap) return d0;
  const Wd = v.W;
  return Math.min(d0, Math.max(Math.abs(ax - bx - Wd), Math.abs(ay - by), Math.abs(az - bz + Wd)), Math.max(Math.abs(ax - bx + Wd), Math.abs(ay - by), Math.abs(az - bz - Wd)));
}
