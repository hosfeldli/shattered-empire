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
      const key = [c.o, Math.floor(c.pop / 3), Math.round((c.dmg || 0) / 10), era, c.r, c.ti || 0, S.buildingsVersion, S.ruinsVersion, S.urbanVersion || 0, S.bordersVersion || 0, (S.roadVersion || 0) >> 3].join('|');
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
    const tier = c.ti || 0;                                  // Town 0, City 1, Metropolis 2, Megacity 3
    const rad = Math.min(4, (c.r || 3) + (tier >= 2 ? 1 : 0));
    const cand = [], rural = [];
    const ribbon = [];          // road hexes beyond the district: where the town spills out along its roads
    const reach = rad + 2 + Math.min(4, Math.floor((c.pop || 0) / 60) + tier);
    for (let q = -reach; q <= reach; q++) for (let r = -reach; r <= reach; r++) {
      const r0 = (c.t / v.W) | 0, rr2 = r0 + r; if (rr2 < 0 || rr2 >= v.H) continue;
      let q2 = (c.t % v.W) + q; if (v.wrap) q2 = (q2 + v.W) % v.W; else if (q2 < 0 || q2 >= v.W) continue;
      const t = rr2 * v.W + q2;
      const d = hexDist(v, c.t, t); if (d < 1 || d > reach) continue;
      const ter = S.terr[t];
      if (ter === 255 || ter <= 1 || ter >= 9 || S.owner[t] !== c.o || S.buildingTiles.has(t) || S.ruins.has(t)) continue;
      if (d > rad + 1) { if (S.road[t]) ribbon.push([t, d]); continue; }
      if (d <= rad) cand.push([t, d + h(c.id, t) * 0.6]); else rural.push(t);
    }
    cand.sort((a, b) => a[1] - b[1]);
    // the server's developed footprint is authoritative (trenches cannot exist there); draw
    // districts exactly on it, falling back to a population estimate before it is known
    const urban = S.urban ? cand.filter(([t]) => S.urban[t]).map((x) => x[0]) : [];
    const nHex = Math.max(1, Math.min(cand.length, Math.round(c.pop / 5)));
    const hexes = urban.length ? urban : cand.slice(0, nHex).map((x) => x[0]);
    const set = new Set(hexes);
    for (const [t] of cand) if (!set.has(t)) rural.push(t);
    rec.blocks = []; rec.streets = []; rec.hexes = hexes;
    const dmg = (c.dmg || 0) / 100;
    const GROUND = [0x6b5a44, 0x6a5a4c, 0x77756f, 0x5d6266, 0x8a9396];
    const ROAD = [0x8a7656, 0x6e655a, 0x56585a, 0x45494c, 0x9aa3a6];
    // the urban ground: soft, overlapping patches of yard and paving that thicken toward the middle
    // of each developed hex and feather out over its edges (the terrain beneath is already cleared
    // and worn), so a district reads as one continuous place grown into the land, never as plates
    const gA = (era === 0 ? 0.1 : 0.14) + 0.025 * Math.min(3, tier);
    for (const t of hexes) {
      const x = X(t), y = v.cy[t];
      for (let k = 0; k < 4; k++) {
        const a = h(c.id, t, 200 + k) * 6.283, d = k ? 3 + h(c.id, t, 210 + k) * 3 : 0, rr = (k ? 6.5 : 10.5) + h(c.id, t, 220 + k) * 2;
        g.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.85, rr, rr * 0.86).fill({ color: GROUND[Math.min(4, era)], alpha: gA });
      }
    }
    // streets: between developed hexes and to the town centre, then a small grid inside each hex
    for (const t of [c.t, ...hexes]) for (let d = 0; d < 3; d++) {
      const n = v.nb(t, d); if (n < 0 || !(set.has(n) || n === c.t) || !(set.has(t) || t === c.t)) continue;
      rec.streets.push([X(t), v.cy[t], X(n), v.cy[n]]);
    }
    // the civic centre: a paved square round the town hall, with market stalls on market days
    { const cx = X(c.t), cy = v.cy[c.t], sq = [0x8a7a62, 0x9a8e7c, 0xa8a49a, 0x9aa4aa, 0xd2d8d8][Math.min(4, era)];
      for (const [rx, a] of [[14, 0.18], [11.5, 0.22], [9, 0.3]]) g.ellipse(cx, cy + 1, rx, rx * 0.85).fill({ color: sq, alpha: a });
      if (c.pop > 12) for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + h(c.id, 9), r = 11; g.rect(cx + Math.cos(a) * r - 1, cy + Math.sin(a) * r * 0.82 - 0.8, 2, 1.6).fill({ color: [0xc0503a, 0xd8b04a, 0x3a7ab0][k % 3] }); } }
    const inner = [];
    for (const t of hexes) {
      const x = X(t), y = v.cy[t], a = Math.floor(h(c.id, t, 70) * 3) * (Math.PI / 3), ca = Math.cos(a), sa = Math.sin(a);
      inner.push([x - ca * 8, y - sa * 8, x + ca * 8, y + sa * 8], [x + sa * 7, y - ca * 7, x - sa * 7, y + ca * 7]);
    }
    rec.streets.push(...inner);
    for (const sx of rec.streets) g.moveTo(sx[0], sx[1]).lineTo(sx[2], sx[3]);
    if (rec.streets.length) g.stroke({ width: era >= 2 ? 2 : 1.6, color: ROAD[Math.min(4, era)], alpha: 0.9 });
    // trees kept along the streets and in back yards: canopy over the ground, shadow to the south-east
    const trees = [];
    for (const t of hexes) {
      const x = X(t), y = v.cy[t];
      for (let k = 0; k < 5; k++) {
        if (h(c.id, t, 400 + k) < 0.35 + 0.08 * tier) continue;              // denser cities keep fewer
        const a = h(c.id, t, 410 + k) * 6.283, d = 6.5 + h(c.id, t, 420 + k) * 4;
        trees.push([x + Math.cos(a) * d, y + Math.sin(a) * d * 0.88, 1.1 + h(c.id, t, 430 + k) * 0.9]);
      }
    }
    for (const [tx, ty, tr] of trees) g.ellipse(tx + tr * 0.6, ty + tr * 0.55, tr, tr * 0.7).fill({ color: 0x000000, alpha: 0.2 });
    for (const [tx, ty, tr] of trees) g.circle(tx, ty, tr).fill({ color: 0x46703a });
    for (const [tx, ty, tr] of trees) g.circle(tx - tr * 0.3, ty - tr * 0.35, tr * 0.45).fill({ color: 0x6f9a52, alpha: 0.8 });
    // blocks: rows of buildings in the four quarters between the streets, taller toward the centre
    // and as the city climbs tiers; industry hugs factories, shops ring the centre
    const per = Math.min(4, 1 + Math.floor(c.pop / 40) + tier);
    for (const t of hexes) {
      let ind = false;
      for (let d = 0; d < 6; d++) { const n = v.nb(t, d); const b = n >= 0 ? S.buildingAtTile.get(n) : null; if (b && INDUSTRIAL.has(b.ty)) ind = true; }
      const dist = hexDist(v, c.t, t);
      const type = ind ? 'ind' : dist === 1 && (era >= 1 || tier >= 1) ? 'com' : 'res';
      const x = X(t), y = v.cy[t], a = Math.floor(h(c.id, t, 70) * 3) * (Math.PI / 3), ca = Math.cos(a), sa = Math.sin(a);
      if (era >= 1 && type === 'res' && h(c.id, t, 51) < 0.22) {      // a park with trees
        g.circle(x + ca * 4 + sa * 4, y + sa * 4 - ca * 4, 3.4).fill({ color: 0x4f7a3a, alpha: 0.95 });
        for (let k = 0; k < 3; k++) g.circle(x + ca * 4 + sa * 4 + (h(t, k, 52) - 0.5) * 4, y + sa * 4 - ca * 4 + (h(t, k, 53) - 0.5) * 4, 1.1).fill({ color: 0x2f5a2a });
      }
      for (let qd = 0; qd < 4; qd++) {
        const su = qd & 1 ? 1 : -1, sv = qd & 2 ? 1 : -1;
        const qx = x + ca * su * 4.2 + sa * sv * 3.8, qy = y + sa * su * 4.2 - ca * sv * 3.8;
        for (let k = 0; k < per; k++) {
          const off = (k - (per - 1) / 2) * (6 / per);
          const bx = qx + ca * off, by = qy + sa * off;
          const w = Math.max(1.5, (type === 'ind' ? 4.4 : 5.6) / per + 0.6 + h(t, k, qd) * 0.8), hh2 = type === 'ind' ? 2.8 : 2.2 + h(t, k, qd + 9) * 0.8;
          const ruined = h(c.id, t, k * 4 + qd + 99) < dmg;
          if (ruined) { g.rect(bx - w / 2, by - hh2 / 2, w, hh2).fill({ color: 0x3a3430 }); g.circle(bx + 0.5, by, 0.7).fill({ color: 0x7c7062 }); rec.blocks.push({ x: bx, y: by, w, h: hh2, ruined: true }); continue; }
          // history: not every block is rebuilt when an era turns — older streets keep their brick or
          // timber until they are redeveloped (the centre redevelops first)
          const old = era > 0 && h(c.id, t, k * 4 + qd + 300) < (dist <= 1 ? 0.15 : 0.4) ? 1 + Math.floor(h(c.id, t, k + 301) * Math.min(2, era)) : 0;
          const bs = STYLE[Math.min(4, Math.max(0, era - old))], pal = bs[type];
          const tall = bs.tall * (1 + tier * 0.45) * (type === 'com' ? 1.35 : 1) * (dist <= 1 ? 1.25 : 1) * (0.7 + h(t, k, qd + 5) * 0.6);
          g.rect(bx - w / 2 + tall * 0.7, by - hh2 / 2 + tall * 0.5, w, hh2).fill({ color: 0x000000, alpha: 0.22 });   // shadow: longer for taller blocks
          const col = pal[(k + qd + t) % pal.length];
          void st;
          g.rect(bx - w / 2, by - hh2 / 2, w, hh2).fill({ color: col }).stroke({ width: 0.35, color: 0x1b1b1b, alpha: 0.55 });
          g.rect(bx - w / 2, by - hh2 / 2, w, Math.min(0.8, hh2 * 0.3)).fill({ color: 0xffffff, alpha: 0.16 });     // lit roof edge
          if (tall > 3.2) g.rect(bx - w / 2 + 0.5, by - hh2 / 2 + 0.6, Math.max(0.6, w - 1), 0.5).fill({ color: era >= 3 ? 0x9fd4e8 : 0x2a2a2a, alpha: 0.55 });   // rooftop plant / glazing
          rec.blocks.push({ x: bx, y: by, w, h: hh2, type, tall });
        }
      }
    }
    // ribbon development: houses with yards line the roads out of town, thinning with distance and
    // thickening as the city grows, so neighbouring towns reach toward each other along their roads
    for (const [t, d] of ribbon) {
      if (S.urban?.[t]) continue;
      const k = Math.max(0, 1 - (d - rad - 1) / (reach - rad)) * Math.min(1, 0.25 + (c.pop || 0) / 120 + tier * 0.2);
      const x = X(t), y = v.cy[t];
      const n = Math.round(k * 4);
      if (!n) continue;
      g.ellipse(x, y + 0.5, 8 + n, 6.5 + n * 0.6).fill({ color: GROUND[Math.min(4, era)], alpha: 0.08 + 0.03 * n });
      for (let i = 0; i < n; i++) {
        const a = h(c.id, t, 600 + i) * 6.283, rr = 4.5 + h(c.id, t, 610 + i) * 3.5;
        const hx = x + Math.cos(a) * rr, hy = y + Math.sin(a) * rr * 0.85, w = 2.4 + h(t, i, 620) * 1.2, hh2 = 1.8 + h(t, i, 621) * 0.8;
        const bs = STYLE[Math.min(4, Math.max(0, era - (h(c.id, t, 630 + i) < 0.5 ? 1 : 0)))];
        g.rect(hx - w / 2 + 0.7, hy - hh2 / 2 + 0.6, w, hh2).fill({ color: 0x000000, alpha: 0.2 });
        g.rect(hx - w / 2, hy - hh2 / 2, w, hh2).fill({ color: bs.res[(i + t) % bs.res.length] }).stroke({ width: 0.3, color: 0x1b1b1b, alpha: 0.5 });
        g.rect(hx - w / 2, hy - hh2 / 2, w, Math.min(0.7, hh2 * 0.3)).fill({ color: 0xffffff, alpha: 0.14 });
        if (h(c.id, t, 640 + i) < 0.45) { const gx = hx + (h(t, i, 650) - 0.5) * 4, gy = hy + 2.4; g.circle(gx, gy, 1.1).fill({ color: 0x46703a }); }
      }
    }
    // the countryside the city feeds on: farmsteads and small fields on owned land around it
    if (rural.length) for (const t of rural) {
      if (h(c.id, t, 81) > 0.35 + 0.1 * tier) continue;
      const ter = S.terr[t]; if (![2, 3, 6, 12].includes(ter)) continue;     // open farmland only: grass, plains, tundra, volcanic soil
      const x = X(t) + (h(t, 82) - 0.5) * 8, y = v.cy[t] + (h(t, 83) - 0.5) * 6;
      const fa = h(t, 84) * Math.PI;
      const fc = [0xa9a24f, 0x8fa548, 0xb59a52][Math.floor(h(t, 85) * 3)];
      const cf = Math.cos(fa), sf = Math.sin(fa), fx = x - 3, fy = y + 0.5;
      g.poly([[-4, -2.4], [4, -2.4], [4, 2.4], [-4, 2.4]].flatMap(([px, py]) => [fx + px * cf - py * sf, fy + px * sf + py * cf])).fill({ color: fc, alpha: 0.55 });
      for (let k = -1; k <= 1; k++) g.moveTo(fx - 3.6 * cf - k * 1.4 * sf, fy - 3.6 * sf + k * 1.4 * cf).lineTo(fx + 3.6 * cf - k * 1.4 * sf, fy + 3.6 * sf + k * 1.4 * cf);
      g.stroke({ width: 0.4, color: 0x5a5a2a, alpha: 0.5 });
      g.rect(x + 2, y - 1.5, 2.6, 2).fill({ color: era >= 2 ? 0xb8b0a0 : 0x8a6a48 }).stroke({ width: 0.3, color: 0x1b1b1b, alpha: 0.5 });
      g.rect(x + 2, y - 1.5, 2.6, 0.7).fill({ color: era >= 2 ? 0x6a6a70 : 0x6a3a2a });
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
