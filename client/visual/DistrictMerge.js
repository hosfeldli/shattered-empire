// District merging: neighbouring buildings of compatible kinds and the same owner join into one
// district instead of standing as separate tokens on their hexes. Each building stays its own
// selectable, upgradable, destroyable thing; only the ground and the space between them is shared:
//   housing      -> terraces of row houses across the shared edge, back gardens
//   industry     -> one works yard: paving, pipe runs and rail spurs between plants, stockpiles
//   farms        -> one stretch of fields with aligned rows and hedges; one farmstead per estate
//   commerce     -> a trading street of stalls and awnings between markets and shops
//   civic        -> a paved square joining town hall, schools and universities
//   extraction   -> haul tracks and spoil heaps between mines, quarries, timber mills and wells
// Districts never merge across owners, never over a hostile border, and are computed on the map's
// base positions so they continue seamlessly across the east–west seam. A destroyed building leaves
// a gap (its links disappear); rebuilding it closes the gap again.
import { h } from './VisualLOD.js';

export const GROUP = {
  house: 'res',
  farm: 'farm',
  market: 'com', port: 'com',
  town: 'civ', academy: 'civ', university: 'civ', comms_tower: 'civ',
  steel_mill: 'ind', munitions_plant: 'ind', motor_works: 'ind', heavy_assembly: 'ind', electronics_plant: 'ind', refinery: 'ind', power_plant: 'ind', fusion_plant: 'ind', robotics_complex: 'ind', drone_works: 'ind', salvage: 'ind',
  mine: 'ext', quarry: 'ext', lumber: 'ext', oil_well: 'ext',
};
const GROUND = { res: 0x7d7262, ind: 0x6c6a66, farm: 0x8a8a4a, com: 0x8c7f6a, civ: 0x9a958a, ext: 0x7a6a56 };
const ERA_WALL = [0x8a6a48, 0x9b5a3c, 0xa4a6a8, 0x86a2b6, 0xdfe7ea], ERA_ROOF = [0x6d5236, 0x55473f, 0x7a7e82, 0x5c6e7c, 0xb4c6ca];

export class DistrictMerge {
  constructor(view, S, g) { this.v = view; this.S = S; this.g = g; this.key = ''; this.merged = new Map(); }

  // building id -> { group, leader, n } for buildings that belong to a district of two or more
  info(id) { return this.merged.get(id) || null; }

  update() {
    const S = this.S, v = this.v;
    const key = S.buildingsVersion + ':' + (S.urbanVersion || 0);
    if (key === this.key) return false;
    this.key = key;
    const at = new Map();
    for (const b of S.buildings.values()) if (GROUP[b.ty] && b.d && b.st !== 'planned') at.set(b.t, b);
    // connected components per group and owner (union–find over hex adjacency)
    const parent = new Map(); const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const b of at.values()) parent.set(b.id, b.id);
    const links = [];
    for (const b of at.values()) for (let d = 0; d < 3; d++) {
      const n = v.nb(b.t, d); const o = n >= 0 ? at.get(n) : null;
      if (!o || o.o !== b.o || GROUP[o.ty] !== GROUP[b.ty]) continue;
      links.push([b, o]); const ra = find(b.id), rb = find(o.id); if (ra !== rb) parent.set(ra, rb);
    }
    const comps = new Map();
    for (const b of at.values()) { const r = find(b.id); (comps.get(r) || comps.set(r, []).get(r)).push(b); }
    this.merged.clear();
    for (const arr of comps.values()) {
      if (arr.length < 2) continue;
      const leader = arr.reduce((a, b) => (a.id < b.id ? a : b));
      for (const b of arr) this.merged.set(b.id, { group: GROUP[b.ty], leader: leader.id === b.id, n: arr.length });
    }
    this.draw(links, comps);
    return true;
  }

  draw(links, comps) {
    const S = this.S, v = this.v, g = this.g, X = v.cx0 || v.cx;
    g.clear();
    const eraOf = (o) => (o === S.civId ? S.econ?.age || 0 : S.civInfo[o]?.age ?? 0);
    // shared ground under every member of a district
    for (const arr of comps.values()) {
      if (arr.length < 2) continue;
      const grp = GROUP[arr[0].ty];
      for (const b of arr) g.ellipse(X[b.t], v.cy[b.t] + 1, 12.5, 11).fill({ color: GROUND[grp], alpha: grp === 'farm' ? 0.28 : 0.42 });
    }
    for (const [a, b] of links) {
      const grp = GROUP[a.ty], x0 = X[a.t], y0 = v.cy[a.t], x1 = v.near ? v.near(X[b.t], x0) : X[b.t], y1 = v.cy[b.t];
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, px = -uy, py = ux;
      const seed = a.id * 31 + b.id;
      // the ground across the shared edge
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 13, color: GROUND[grp], alpha: grp === 'farm' ? 0.3 : 0.45 });
      const era = eraOf(a.o), wall = ERA_WALL[Math.min(4, era)], roof = ERA_ROOF[Math.min(4, era)];
      if (grp === 'res') {
        // a terrace straddling the edge: three joined houses, back gardens behind
        for (let k = -1; k <= 1; k++) {
          const cx = mx + px * k * 3.2, cy = my + py * k * 3.2;
          g.poly(quad(cx, cy, ux, uy, 2.2, 1.6)).fill({ color: wall });
          g.poly(quad(cx - ux * 0.3, cy - uy * 0.3 - 0.8, ux, uy, 2.2, 1.0)).fill({ color: roof });
        }
        for (let k = -1; k <= 1; k += 2) g.ellipse(mx + px * 7 * k + ux * 1.5, my + py * 7 * k + uy * 1.5, 1.6, 1.1).fill({ color: 0x5a7a3a, alpha: 0.9 });
      } else if (grp === 'ind') {
        // a works yard: pipe run and a rail spur across, stockpiles and crates
        g.moveTo(x0 + px * 2.2, y0 + py * 2.2).lineTo(x1 + px * 2.2, y1 + py * 2.2).stroke({ width: 0.9, color: 0x9aa0a4 });
        g.moveTo(x0 + px * 3.2, y0 + py * 3.2).lineTo(x1 + px * 3.2, y1 + py * 3.2).stroke({ width: 0.6, color: 0x7a8084 });
        g.moveTo(x0 - px * 2.5, y0 - py * 2.5).lineTo(x1 - px * 2.5, y1 - py * 2.5).stroke({ width: 1.2, color: 0x2e2c2a });
        for (let s = 0; s < L; s += 2.2) g.moveTo(x0 - px * 3.3 + ux * s, y0 - py * 3.3 + uy * s).lineTo(x0 - px * 1.7 + ux * s, y0 - py * 1.7 + uy * s);
        g.stroke({ width: 0.5, color: 0x5a4a3a });
        g.circle(mx + px * 6, my + py * 6, 1.8).fill({ color: 0x55504a }); g.rect(mx - px * 6 - 1.5, my - py * 6 - 1, 3, 2).fill({ color: 0x8a6a48 });
      } else if (grp === 'farm') {
        // fields run on across the boundary: rows aligned with the estate's, a hedge between plots
        const ang = h(Math.min(a.id, b.id), 5) < 0.5 ? 0 : Math.PI / 2, rx = Math.cos(ang), ry = Math.sin(ang);
        for (let k = -2; k <= 2; k++) g.moveTo(mx - rx * 6 + ry * k * 2, my - ry * 6 - rx * k * 2 * 0.8).lineTo(mx + rx * 6 + ry * k * 2, my + ry * 6 - rx * k * 2 * 0.8);
        g.stroke({ width: 0.8, color: [0x7d9b40, 0x9fae4c, 0xb7a54a][(seed >>> 3) % 3], alpha: 0.9 });
        g.moveTo(mx - px * 6, my - py * 6).lineTo(mx + px * 6, my + py * 6).stroke({ width: 1, color: 0x3f5a2a, alpha: 0.8 });
      } else if (grp === 'com') {
        // a trading street: awnings in a row
        const cols = [0xc0503a, 0xd8b04a, 0x3a7ab0, 0x5a9a5a];
        for (let k = -2; k <= 2; k++) { const cx = mx + ux * k * 2.6 + px * 2.4, cy = my + uy * k * 2.6 + py * 2.4; g.poly(quad(cx, cy, ux, uy, 1.1, 1.3)).fill({ color: cols[(seed + k + 2) % 4] }); }
        g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 2.2, color: 0xb0a080, alpha: 0.7 });
      } else if (grp === 'civ') {
        // a paved square with a few trees
        g.poly(quad(mx, my, ux, uy, 5, 4)).fill({ color: 0xc2baa8, alpha: 0.8 });
        for (let k = -1; k <= 1; k += 2) g.circle(mx + px * 5 * k, my + py * 5 * k, 1.3).fill({ color: 0x4f7a3a });
      } else {
        // a haul track with spoil heaps
        g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 1.6, color: 0x8a7656, alpha: 0.9 });
        g.ellipse(mx + px * 4, my + py * 4, 2.2, 1.4).fill({ color: 0x6e5d48 }); g.ellipse(mx - px * 4.5, my - py * 4.5, 1.6, 1.1).fill({ color: 0x7a6650 });
      }
    }
  }
}

// a small rectangle centred at (cx, cy), long side along (ux, uy)
function quad(cx, cy, ux, uy, a, b) { const px = -uy, py = ux; return [cx - ux * a - px * b, cy - uy * a - py * b, cx + ux * a - px * b, cy + uy * a - py * b, cx + ux * a + px * b, cy + uy * a + py * b, cx - ux * a + px * b, cy - uy * a + py * b]; }
