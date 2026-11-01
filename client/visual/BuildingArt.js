// Buildings drawn as structures standing on their hex: walls, roofs, chimneys, piers, runways and
// towers in the owner's era materials, with civ-coloured flags and trim. Everything is vector
// Graphics in hex-local coordinates (the hex is ~21 px across), redrawn only when something that
// affects the look changes (state, era, damage, progress, owner, zoom band).
//
// States: planned sites are survey outlines, construction rises from a foundation (scaffolding
// and crews come from ConstructionVisuals), damaged buildings are scorched with broken roofs.

const ERA = [
  { wall: 0x8a6a48, roof: 0x6d5236, metal: 0x7a6f66, trim: 0x4a3a2a, glass: 0x9fb4b8, ground: 0x7b6a52 },   // Reclamation: salvage timber, rust
  { wall: 0x9b5a3c, roof: 0x55473f, metal: 0x6c6a68, trim: 0x3f2f28, glass: 0xa9c0c6, ground: 0x7a7468 },   // Industrial: brick, slate
  { wall: 0xa4a6a8, roof: 0x7a7e82, metal: 0x5d6266, trim: 0x44484c, glass: 0x9cb8c8, ground: 0x85878a },   // Mechanization: concrete
  { wall: 0x86a2b6, roof: 0x5c6e7c, metal: 0x8c98a2, trim: 0x3c4a56, glass: 0xbfe4f4, ground: 0x7d8890 },   // Networked: glass & steel
  { wall: 0xdfe7ea, roof: 0xb4c6ca, metal: 0xa9b8bd, trim: 0x6f8a90, glass: 0x9ff0e8, ground: 0xc8d2d4 },   // Advanced: white composites
];
const DARK = 0x141a1c;

export const shade = (c, f) => {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f)), g = Math.min(255, Math.round(((c >> 8) & 255) * f)), b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
};

// Drawing context: wraps fills so the same shape code renders solid, ghosted (planned) or partially
// built (construction), and darkened when damaged.
function ctx(g, o) {
  const k = o.damaged ? 0.62 : 1;
  const C = {
    g, o, era: ERA[Math.max(0, Math.min(4, o.era | 0))],
    fill(col, a = 1) {
      if (o.ghost) g.stroke({ width: 0.6, color: 0xf1c75b, alpha: 0.6 });
      else g.fill({ color: shade(col, k), alpha: a * o.alpha });
      return C;
    },
    line(col, w = 0.8, a = 1) { if (o.ghost) g.stroke({ width: 0.5, color: 0xf1c75b, alpha: 0.5 }); else g.stroke({ width: w, color: shade(col, k), alpha: a * o.alpha }); return C; },
    shadow(x, y, w, d, hgt) { if (o.ghost) return; g.rect(x - w / 2 + 0.6, y - d / 2 + 0.6, w + hgt * 0.35, d + hgt * 0.2).fill({ color: 0x000000, alpha: 0.22 * o.alpha }); },
    // a box seen from above and slightly in front: roof raised by its height, front wall below it
    box(x, y, w, d, hgt, roof, wall) {
      C.shadow(x, y, w, d, hgt);
      g.rect(x - w / 2, y + d / 2 - hgt, w, hgt); C.fill(wall ?? shade(roof, 0.72));
      g.rect(x - w / 2, y - d / 2 - hgt, w, d); C.fill(roof);
      if (!o.ghost) g.rect(x - w / 2, y - d / 2 - hgt, w, d).stroke({ width: 0.35, color: DARK, alpha: 0.5 * o.alpha });
    },
    // pitched roof: two slopes with a ridge
    gable(x, y, w, d, hgt, roof, wall) {
      C.shadow(x, y, w, d, hgt);
      g.rect(x - w / 2, y + d / 2 - hgt, w, hgt); C.fill(wall ?? C.era.wall);
      g.rect(x - w / 2, y - d / 2 - hgt, w, d / 2); C.fill(shade(roof, 1.12));
      g.rect(x - w / 2, y - hgt, w, d / 2); C.fill(shade(roof, 0.86));
      if (!o.ghost) g.moveTo(x - w / 2, y - hgt).lineTo(x + w / 2, y - hgt).stroke({ width: 0.4, color: DARK, alpha: 0.6 * o.alpha });
    },
    // vertical cylinder (tank, silo, tower)
    cyl(x, y, r, hgt, col) {
      if (!o.ghost) g.ellipse(x + 0.8, y + 0.5, r + 0.6, r * 0.5).fill({ color: 0, alpha: 0.2 * o.alpha });
      g.rect(x - r, y - hgt, r * 2, hgt); C.fill(shade(col, 0.8));
      g.ellipse(x, y, r, r * 0.45); C.fill(shade(col, 0.8));
      g.ellipse(x, y - hgt, r, r * 0.45); C.fill(shade(col, 1.1));
    },
    windows(x, y, w, hgt, rows = 1, col = 0xffe6a8) {
      if (o.ghost || o.lod !== 'micro') return;
      const n = Math.max(1, Math.floor(w / 1.8));
      for (let r = 0; r < rows; r++) for (let i = 0; i < n; i++) g.rect(x - w / 2 + 0.6 + i * (w - 1.2) / n, y - hgt + 0.8 + r * (hgt - 1) / rows, 0.7, 0.7).fill({ color: col, alpha: 0.8 * o.alpha });
    },
    flag(x, y, hgt, col) {
      g.moveTo(x, y).lineTo(x, y - hgt); C.line(0x2a2a2a, 0.6);
      g.poly([x, y - hgt, x + 4.2, y - hgt + 1.3, x, y - hgt + 2.6]); C.fill(col);
    },
  };
  return C;
}

// Footprint pad: ground the building sits on, edged in the owner's colour so ownership reads at a glance.
// A building on its own sits on a soft natural foundation with a faint owner's edge; inside a merged
// district the district's shared ground replaces it (no hexagonal tokens in a city). The strong
// owner's outline appears when the building is selected or hovered (drawn by the view).
function pad(C, r, civ) {
  const pts = []; for (let k = 0; k < 6; k++) { const a = (Math.PI / 180) * (60 * k - 30); pts.push(Math.cos(a) * r, Math.sin(a) * r); }
  const { g, o } = C;
  if (o.ghost) { g.poly(pts).stroke({ width: 0.8, color: 0xf1c75b, alpha: 0.7 }); return; }
  if (o.merged) return;
  g.ellipse(0, 0.6, r * 0.95, r * 0.8).fill({ color: C.era.ground, alpha: 0.34 * o.alpha });
  g.poly(pts).stroke({ width: 0.8, color: civ, alpha: 0.32 * o.alpha });
}

const ART = {
  town(C, o) {
    const e = C.era, era = o.era;
    // plaza
    C.g.circle(0, 1, 8); C.fill(shade(e.ground, 1.15), 0.8);
    if (era <= 1) {
      C.gable(1.5, 2, 10, 6, 4.5, e.roof, e.wall); C.windows(1.5, 5, 10, 4.5);
      C.box(-5.5, 1, 3.2, 3.2, 9, shade(e.roof, 0.95), e.wall);                 // bell / watch tower
    } else if (era <= 3) {
      C.box(1.5, 3, 10, 6, 6, e.roof, e.wall); C.windows(1.5, 6, 10, 6, 2);
      C.box(-5, 1, 4, 4, era === 3 ? 15 : 11, shade(e.roof, 1.05), e.glass); C.windows(-5, 3, 4, era === 3 ? 15 : 11, 4);
    } else {
      C.cyl(1, 3, 4.2, 17, e.wall); C.box(-6, 4, 4, 3, 6, e.roof, e.wall);
      C.g.circle(1, -14, 1.2); C.fill(e.glass);
    }
    if (o.capital) { C.g.circle(1.5, era <= 1 ? -3 : -4, 2.2); C.fill(0xd9b44a); }
    C.flag(6.5, -1, 12, o.civ);
    // stockpile crates beside the hall (more goods, more crates)
    for (let i = 0; i < Math.min(5, o.stockCrates || 0); i++) { C.g.rect(-8 + (i % 3) * 2.2, 5.2 - Math.floor(i / 3) * 2, 2, 1.8); C.fill(0x9a7448); }
  },
  // density level 1-3: each upgrade adds storeys (and at level 3 a taller block), so raised housing reads at a glance
  house(C, o) {
    const e = C.era, era = o.era, lv = Math.max(1, Math.min(3, o.level || 1)), k = 1 + 0.55 * (lv - 1);
    if (era === 0) {
      if (lv === 1) { C.gable(-4, -1, 5, 4, 2.5, e.roof, e.wall); C.gable(3.5, -3, 5, 4, 2.5, shade(e.roof, 1.1), e.wall); C.gable(0, 4.5, 6, 4, 2.6, e.roof, shade(e.wall, 0.9)); }
      else { C.box(-3.5, 0, 5, 4, 3.2 * k, shade(e.roof, 0.9), e.wall); C.windows(-3.5, 2, 5, 3.2 * k, 2); C.gable(3.5, -3, 5, 4, 2.5 * k, shade(e.roof, 1.1), e.wall); C.box(0, 5, 6, 3.6, 2.6 * k, e.roof, shade(e.wall, 0.9)); }
    } else if (era === 1) { C.gable(0, -2, 12, 4, 3.4 * k, e.roof, e.wall); C.windows(0, 0, 12, 3.4 * k, lv); C.gable(0, 4.5, 12, 4, 3.4 * k, shade(e.roof, 1.08), shade(e.wall, 0.94)); C.windows(0, 6.5, 12, 3.4 * k, lv); }
    else if (era === 2) { C.box(0, 2, 11, 6, 7 * k, e.roof, e.wall); C.windows(0, 5, 11, 7 * k, 2 + lv); }
    // apartment towers: tall, but never taller than about a hex (a forest of bright bars reads as noise)
    else { const t = (era === 3 ? 1 : 1.12) * Math.min(1.5, k); C.box(-3, 3, 5, 5, 8.5 * t, e.roof, shade(e.glass, 0.62)); C.windows(-3, 5.5, 5, 8.5 * t, 3 + lv, 0xfff2c8); C.box(3.5, 4, 5, 4, 6.5 * t, shade(e.roof, 1.1), shade(e.glass, 0.7)); C.windows(3.5, 6, 5, 6.5 * t, 2 + lv, 0xfff2c8); }
    if (lv === 3 && era <= 1) { C.box(5.5, 5.5, 3.2, 3.2, 6, shade(e.roof, 1.15), shade(e.wall, 1.05)); }
  },
  farm(C, o) {
    const crops = [0x6f8f3c, 0x9fae4c, 0x7d9b40, 0xb7a54a];
    for (let i = 0; i < 4; i++) { const x = (i % 2) * 8 - 8, y = Math.floor(i / 2) * 7 - 6; C.g.rect(x, y, 7.4, 6.4); C.fill(crops[(i + o.id) % 4], 0.85); }
    if (o.noBarn) return;                    // one farmstead per estate of joined farms
    C.gable(5, -3, 5, 3.6, 3, 0x7a2f22, 0xa0402c);
    C.cyl(8, -1, 1.4, 6, o.era >= 2 ? 0xb8bcbf : 0x9b8b70);
  },
  lumber(C, o) {
    const e = C.era;
    C.gable(3, -1, 8, 5, 3.4, e.roof, e.wall);
    for (let i = 0; i < 6; i++) { const x = -7 + (i % 3) * 2.3, y = 5 - Math.floor(i / 3) * 2; C.g.circle(x, y, 1.15); C.fill(0xb48a5a); if (!o.ghost) C.g.circle(x, y, 0.45).fill({ color: 0x7a5432, alpha: o.alpha }); }
    C.g.circle(-6, -5, 1); C.fill(0x6a4a2c); C.g.circle(-3, -7, 1); C.fill(0x6a4a2c);
  },
  quarry(C, o) {
    const ring = (r, col) => { const pts = []; for (let k = 0; k < 7; k++) { const a = k * 0.9 + o.id; const rr = r * (0.82 + 0.18 * Math.sin(a * 3)); pts.push(Math.cos(k * 0.898) * rr, Math.sin(k * 0.898) * rr * 0.8); } C.g.poly(pts); C.fill(col); };
    ring(9, 0xa29a8c); ring(6.4, 0x8a8478); ring(3.8, 0x6e6a62);
    for (let i = 0; i < 3; i++) { C.g.rect(4 + i * 1.8, 5, 1.6, 1.4); C.fill(0xd6d0c4); }
    C.g.moveTo(-6, 6).lineTo(-6, -4).lineTo(1, -2); C.line(0xe0b040, 0.7);
  },
  salvage(C, o) {
    const heaps = [[-4, 2, 0x7a4a2e], [3, 4, 0x6b6560], [2, -4, 0x8a5636]];
    for (const [x, y, col] of heaps) { C.g.poly([x - 4, y + 2, x - 1, y - 3, x + 2, y - 2, x + 4, y + 2]); C.fill(col); }
    C.g.moveTo(6, 7).lineTo(6, -7).lineTo(-2, -5); C.line(0xd9a62a, 0.8);
    C.g.circle(-2, -3.5, 1.2); C.fill(0x3a3a3a);
    void o;
  },
  barracks(C, o) {
    const e = C.era;
    C.g.rect(-7, 2.5, 14, 5); C.fill(0xb0a27a, 0.8);                          // parade ground
    C.box(0, -2.5, 13, 5, 4, o.era >= 2 ? 0x5e6650 : 0x56603f, e.wall); C.windows(0, -0.5, 13, 4);
    C.flag(-6.5, 6, 11, o.civ); C.flag(6.5, 6, 11, o.civ);
  },
  market(C, o) {
    const e = C.era;
    if (o.era >= 2) { C.box(0, 0, 13, 7, 5, e.roof, e.wall); C.windows(0, 3, 13, 5); C.g.rect(-5, -7, 10, 2); C.fill(o.civ); return; }
    for (let i = 0; i < 4; i++) {
      const x = (i % 2) * 8 - 4, y = Math.floor(i / 2) * 7 - 3;
      C.g.rect(x - 3, y + 0.5, 6, 3); C.fill(e.wall);
      for (let s = 0; s < 3; s++) { C.g.rect(x - 3 + s * 2, y - 2, 2, 2.5); C.fill(s % 2 ? 0xe9e2d0 : o.civ); }
    }
  },
  academy(C, o) {
    const e = C.era;
    C.box(0, 1, 13, 6, 5, e.roof, o.era <= 1 ? 0xcfc6b0 : e.wall);
    if (!o.ghost) for (let i = 0; i < 6; i++) C.g.rect(-5.6 + i * 2.2, 0.2, 0.7, 4).fill({ color: 0xece6d6, alpha: o.alpha });
    C.g.poly([-7, -4, 0, -8.5, 7, -4]); C.fill(shade(e.roof, 1.1));
    C.g.rect(-4, 4.2, 8, 1.2); C.fill(0xbfb6a2);
  },
  port(C, o) {
    const e = C.era;
    const [dx, dy] = o.water || [1, 0];
    const px = -dy, py = dx;                                                    // perpendicular
    const L0 = 1, L1 = 13, wd = 2;
    C.g.poly([dx * L0 + px * wd, dy * L0 + py * wd, dx * L1 + px * wd, dy * L1 + py * wd, dx * L1 - px * wd, dy * L1 - py * wd, dx * L0 - px * wd, dy * L0 - py * wd]); C.fill(0x7a5a3a);
    C.gable(-dx * 3, -dy * 3 + 1, 8, 5, 3.6, e.roof, e.wall);
    const cx = dx * 7 + px * 4, cy = dy * 7 + py * 4;
    C.g.moveTo(cx, cy).lineTo(cx, cy - 9).lineTo(cx + dx * 5, cy - 9 + dy * 2); C.line(0xe0b040, 0.8);
  },
  bunker(C, o) {
    const hex = (r, y = 0) => { const p = []; for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k; p.push(Math.cos(a) * r, Math.sin(a) * r * 0.75 + y); } return p; };
    if (!o.ghost) C.g.poly(hex(7.5, 1)).fill({ color: 0, alpha: 0.22 * o.alpha });
    C.g.poly(hex(7, 0)); C.fill(o.era >= 2 ? 0x8a8d8f : 0x7f7a6a);
    C.g.poly(hex(4.5, -1.5)); C.fill(o.era >= 2 ? 0x9fa2a4 : 0x938d7a);
    C.g.rect(-3.5, 0.6, 7, 0.9); C.fill(DARK);
    if (o.era === 0) for (let k = 0; k < 8; k++) { const a = k * 0.785; C.g.ellipse(Math.cos(a) * 8.5, Math.sin(a) * 6.5, 1.4, 0.9); C.fill(0xb59f6e); }
  },
  mine(C, o) {
    const e = C.era;
    C.g.ellipse(-4, 4, 5, 3); C.fill(0x4e4a46);                                    // tailings
    C.box(4, 2, 6, 4, 3, e.roof, e.wall);
    C.g.moveTo(-1, 2).lineTo(1.5, -9).lineTo(4, 2); C.line(o.era >= 1 ? 0x4a4a4a : 0x6a4a2c, 1);
    C.g.circle(1.5, -9, 2); C.line(0x2a2a2a, 0.8);
    C.g.moveTo(-9, 7).lineTo(9, 7); C.line(0x5a4a3a, 0.6);
  },
  steel_mill(C, o) {
    const e = C.era;
    C.box(0, 2, 13, 7, 5, shade(e.metal, 0.8), e.wall); C.windows(0, 5.5, 13, 5);
    const stripes = o.era >= 2;
    for (const x of [-4, 1]) { C.box(x, -2, 2.2, 2.2, 13, stripes ? 0xd8d2c8 : 0x6a5a50, stripes ? 0xc0392b : 0x5a4a40); }
    if (o.active && !o.ghost) C.g.circle(4.5, 5, 1.6).fill({ color: 0xffa040, alpha: 0.9 * o.alpha });
  },
  power_plant(C, o) {
    const e = C.era;
    if (o.era <= 1) { C.box(1, 3, 11, 6, 5, e.roof, e.wall); C.box(-4, 0, 2.6, 2.6, 13, 0x6a5a50, 0x5a4a40); C.windows(1, 6, 11, 5); }
    else {
      const tower = (x, y, s) => { const w0 = 4 * s, w1 = 2.8 * s, ht = 11 * s; C.g.poly([x - w0, y, x - w1, y - ht * 0.6, x - w0 * 0.85, y - ht, x + w0 * 0.85, y - ht, x + w1, y - ht * 0.6, x + w0, y]); C.fill(0xc9cccf); C.g.ellipse(x, y - ht, w0 * 0.85, 1.2 * s); C.fill(0x6e7275); };
      tower(-3.5, 6, 1); tower(4, 5, 0.85);
      C.box(2, 7.5, 6, 3, 2.5, e.roof, e.wall);
    }
    C.g.moveTo(-9, -6).lineTo(-7, -9).lineTo(-5, -6); C.line(0x3a3a3a, 0.5);
  },
  oil_well(C, o) {
    C.g.rect(-7, -1, 9, 7); C.fill(0x6e655a, 0.85);
    C.g.moveTo(-5, 5).lineTo(-2.5, -3).lineTo(0, 5); C.line(0x1e1e1e, 1);
    C.g.moveTo(-7.5, -2).lineTo(2.5, -4); C.line(0x1e1e1e, 1.3);
    C.g.rect(1.5, -5.5, 2, 3); C.fill(0x1e1e1e);
    C.cyl(5.5, 5, 3, 5, 0xd8d2c4); if (!o.ghost) C.g.rect(2.5, 2, 6, 0.9).fill({ color: 0xc0392b, alpha: o.alpha });
  },
  munitions_plant(C, o) {
    for (const [x, y] of [[-4, -2], [4, 2]]) {
      C.g.ellipse(x, y, 5.5, 3.6); C.fill(0x5e6a46);
      C.g.rect(x - 1.5, y + 1.5, 3, 1.8); C.fill(0x2e2e2e);
      if (!o.ghost) for (let s = 0; s < 3; s++) C.g.rect(x - 1.5 + s, y + 1.5, 0.5, 1.8).fill({ color: 0xf0c020, alpha: o.alpha });
    }
    if (!o.ghost) for (let k = 0; k < 12; k++) { const a = k * 0.5236; C.g.circle(Math.cos(a) * 9.2, Math.sin(a) * 8, 0.35).fill({ color: 0x9a9a9a, alpha: o.alpha }); }
  },
  motor_works(C, o) {
    const e = C.era;
    C.box(0, -1, 14, 7, 4, shade(e.metal, 0.9), e.wall);
    for (let i = 0; i < 5; i++) { const x = -7 + i * 2.8; C.g.poly([x, -4.5 - 3.5, x + 2.8, -4.5 - 3.5, x + 2.8, -4.5 - 6]); C.fill(shade(e.roof, 1.2)); }
    for (let i = 0; i < 3; i++) { C.g.rect(-6 + i * 4.2, 5, 3.2, 1.8); C.fill(0x5b6440); }
  },
  depot(C, o) {
    const e = C.era;
    C.gable(-2, -2, 9, 5, 3.4, o.era >= 2 ? 0x5e6650 : e.roof, e.wall);
    for (let i = 0; i < 6; i++) { C.g.rect(-8 + (i % 3) * 2.4, 3 + Math.floor(i / 3) * 2.2, 2.1, 2); C.fill(0xa07848); }
    for (let i = 0; i < 4; i++) { C.g.circle(3.5 + (i % 2) * 2, 3.5 + Math.floor(i / 2) * 2.2, 0.95); C.fill(0x3d5a3a); }
    C.flag(7.5, 2, 9, o.civ);
  },
  // timber (later salvaged metal) watchtower, a low barricade and a sandbagged firing position
  guard_post(C, o) {
    const g = C.g, metal = o.era >= 2;
    for (let k = 0; k < 7; k++) { const a = -0.4 + k * 0.45; g.ellipse(Math.cos(a) * 7.5, Math.sin(a) * 5 + 3, 1.6, 1); C.fill(0xb59f6e); }   // sandbags facing out
    g.rect(-7, -3.5, 5, 1.2); C.fill(metal ? 0x6d7275 : 0x7a5a36); g.rect(-6.5, -2.3, 1, 2); C.fill(DARK);                                      // barricade
    for (const x of [-1.8, 1.8]) { g.moveTo(x, 2).lineTo(x * 0.6, -9); C.line(metal ? 0x5b6064 : 0x5e4426, 1); }                             // tower legs
    g.moveTo(-1.8, -2).lineTo(1.8, -5).moveTo(1.8, -2).lineTo(-1.8, -5); C.line(metal ? 0x5b6064 : 0x5e4426, 0.5);
    C.box(0, -9, 5, 4, 2.6, metal ? 0x80868a : 0x8a6a40, metal ? 0x5d6266 : 0x6b4f2c);                                                       // lookout
    if (!o.ghost) g.rect(-1.2, -11.2, 2.4, 0.7).fill({ color: DARK, alpha: 0.7 * o.alpha });
    C.flag(2.6, -12, 5, o.civ);
  },
  // anti-aircraft emplacement: a sandbagged gun pit, an elevated twin barrel, ammunition crates
  aa_battery(C, o) {
    const g = C.g, conc = o.era >= 3 ? 0x8f9294 : 0x7d7866;
    const ring = []; for (let k = 0; k < 12; k++) { const a = (Math.PI / 6) * k; ring.push(Math.cos(a) * 7.2, Math.sin(a) * 5.6); }
    if (!o.ghost) g.poly(ring.map((v, i) => v + (i % 2 ? 1 : 0.8))).fill({ color: 0, alpha: 0.22 * o.alpha });
    g.poly(ring); C.fill(conc);
    const inner = ring.map((v) => v * 0.7); g.poly(inner); C.fill(shade(conc, 0.68));
    C.cyl(0, 0.5, 2.2, 1.6, 0x55605a);                                                    // gun mount
    if (!o.aimed) { g.moveTo(-0.5, -1).lineTo(3.5, -7.5).moveTo(0.6, -0.6).lineTo(4.6, -7.1); C.line(0x2f3632, 1.1); }   // barrels, elevated (re-aimed while firing)
    for (const [x, y] of [[-5, 2.5], [-3.6, 3.6]]) { g.rect(x - 1, y - 0.8, 2, 1.6); C.fill(0x5a6a3a); }                       // ammunition
    if (o.upgraded) { g.circle(-4.5, -3.5, 1.4); C.fill(0xb8c0c4); g.moveTo(-4.5, -3.5).lineTo(-4.5, -6); C.line(0x3a3f42, 0.5); }   // fire-control radar
  },
  missile_silo(C, o) {
    const g = C.g, conc = 0x8e9192;
    C.box(0, 3, 14, 8, 2, shade(conc, 1.05), shade(conc, 0.8));
    g.circle(-2.5, 2, 3); C.fill(shade(conc, 0.6)); g.circle(-2.5, 2, 2.1); C.fill(o.active ? 0xd8b04a : 0x3b4042);   // hatch: gold when a missile is ready
    C.box(4.5, 1.5, 3.5, 3.5, 5, shade(conc, 1.15), shade(conc, 0.85));
    if (!o.ghost) for (let k = 0; k < 6; k++) g.rect(-7 + k * 2.6, 7.2, 1.4, 0.5).fill({ color: 0xd8b04a, alpha: 0.8 * o.alpha });   // hazard striping
  },
  fort(C, o) {
    const stone = o.era >= 2 ? 0x9a9c9c : 0x8c8676;
    const pts = []; for (let k = 0; k < 10; k++) { const a = (Math.PI / 5) * k - Math.PI / 2; const r = k % 2 ? 6 : 10; pts.push(Math.cos(a) * r, Math.sin(a) * r * 0.85); }
    if (!o.ghost) C.g.poly(pts.map((v, i) => v + (i % 2 ? 1 : 0.8))).fill({ color: 0, alpha: 0.25 * o.alpha });
    C.g.poly(pts); C.fill(stone);
    const inner = pts.map((v) => v * 0.62); C.g.poly(inner); C.fill(shade(stone, 0.72));
    C.box(0, 1, 4.5, 4, 5, shade(stone, 1.1), shade(stone, 0.85));
    C.flag(0, -5, 8, o.civ);
  },
  seismic(C, o) {
    const e = C.era;
    C.box(-3, 2, 6, 4, 3.4, e.roof, e.wall);
    C.g.moveTo(4, 6).lineTo(4, -4); C.line(0x4a4a4a, 0.8);
    C.g.ellipse(4, -5, 3.6, 2); C.fill(0xdfe3e4);
    C.g.moveTo(-8, 7).lineTo(-6, 7).lineTo(-5, 5).lineTo(-4, 9).lineTo(-3, 6).lineTo(-1, 7); C.line(0x2fa36b, 0.5);
    void o;
  },
  university(C, o) {
    const e = C.era;
    C.g.rect(-8, 3, 16, 5); C.fill(0x5e8a44, 0.9);
    C.box(0, -1, 14, 5, 5, e.roof, o.era <= 1 ? 0xcfc6b0 : e.wall); C.windows(0, 1.5, 14, 5, 2);
    C.g.circle(0, -8, 3); C.fill(o.era <= 1 ? 0x6f8f7f : e.glass);
  },
  heavy_assembly(C, o) {
    const e = C.era;
    C.shadow(0, 0, 16, 9, 6);
    C.g.rect(-8, -1, 16, 6); C.fill(e.wall);
    C.g.ellipse(0, -2, 8, 5); C.fill(shade(e.metal, 1.05));
    C.g.rect(-8, -2, 16, 2); C.fill(shade(e.metal, 1.05));
    C.g.moveTo(-9, 7).lineTo(-9, -8).lineTo(9, -8).lineTo(9, 7); C.line(0xe0b040, 0.8);
    C.g.rect(-2.5, 6, 5, 2.4); C.fill(0x56603f);
  },
  airfield(C, o) {
    C.g.poly([-10, 6, 8, -6, 10, -3.5, -8, 8.5]); C.fill(0x3a3c3e);
    if (!o.ghost) for (let i = 0; i < 5; i++) { const t = 0.15 + i * 0.17; C.g.rect(-9 + t * 18 - 0.6, 7.2 - t * 12 - 0.3, 1.2, 0.6).fill({ color: 0xf0f0f0, alpha: o.alpha }); }
    C.g.ellipse(-4, -4, 4, 2.6); C.fill(shade(C.era.metal, 1.1));
    C.box(5, 6, 2.4, 2.4, 7, C.era.glass, C.era.wall);
  },
  stabilizer(C, o) {
    C.g.circle(0, 4, 6); C.fill(0x6e7275, 0.8);
    C.box(0, 4, 3, 3, 16, 0xbfc7cc, 0x8c98a2);
    if (!o.ghost) for (let r = 0; r < 3; r++) C.g.ellipse(0, -2 - r * 4, 4.5 - r, 1.2).stroke({ width: 0.8, color: 0x6fe0ff, alpha: (o.active ? 0.9 : 0.4) * o.alpha });
  },
  electronics_plant(C, o) {
    const e = C.era;
    C.box(0, 1, 14, 7, 5, 0xdfe5e8, 0xc8d0d4);
    if (!o.ghost) { for (let i = 0; i < 4; i++) C.g.rect(-6 + i * 3.3, -8.6, 2.6, 1.6).fill({ color: 0x2c4a7a, alpha: o.alpha }); C.g.rect(-7, 2, 14, 0.9).fill({ color: 0x4a90c8, alpha: o.alpha }); }
    void e;
  },
  comms_tower(C, o) {
    C.box(-4, 4, 4, 3, 2.5, C.era.roof, C.era.wall);
    C.g.moveTo(-1, 7).lineTo(2, -14).lineTo(5, 7); C.line(0x9aa4aa, 0.8);
    for (let k = 0; k < 4; k++) { const y = 5 - k * 4.5, w = 3 - k * 0.6; C.g.moveTo(2 - w, y).lineTo(2 + w, y - 4); C.line(0x9aa4aa, 0.4); }
    C.g.ellipse(4, -8, 2, 1.2); C.fill(0xe8eef0);
    if (!o.ghost) C.g.circle(2, -14.5, 0.9).fill({ color: 0xff3a2a, alpha: o.alpha });
  },
  drone_works(C, o) {
    const e = C.era;
    C.box(-2, -2, 11, 6, 4, e.roof, e.wall);
    for (const [x, y] of [[5, 5], [-5, 5]]) { C.g.circle(x, y, 2.6); C.fill(0x3a3c3e); if (!o.ghost) C.g.moveTo(x - 0.8, y - 1).lineTo(x - 0.8, y + 1).moveTo(x + 0.8, y - 1).lineTo(x + 0.8, y + 1).moveTo(x - 0.8, y).lineTo(x + 0.8, y).stroke({ width: 0.4, color: 0xf0f0f0, alpha: o.alpha }); }
  },
  fusion_plant(C, o) {
    C.g.circle(0, 1, 9); C.fill(0xc8d2d4, 0.8);
    C.cyl(0, 3, 5.5, 5, 0xdfe7ea);
    if (!o.ghost) C.g.ellipse(0, -2, 4.2, 1.8).stroke({ width: 1.4, color: 0x6fe0ff, alpha: (o.active ? 1 : 0.4) * o.alpha });
  },
  robotics_complex(C, o) {
    const pts = [-8, 2, -5, -5, 5, -5, 8, 2, 5, 7, -5, 7];
    if (!o.ghost) C.g.poly(pts.map((v) => v + 0.8)).fill({ color: 0, alpha: 0.25 * o.alpha });
    C.g.poly(pts); C.fill(0x3e4a52);
    if (!o.ghost) { C.g.moveTo(-6, 2).lineTo(6, 2).stroke({ width: 0.7, color: 0x6fe0ff, alpha: (o.active ? 0.95 : 0.4) * o.alpha }); C.g.moveTo(-3, -5).lineTo(-3, 7).moveTo(3, -5).lineTo(3, 7).stroke({ width: 0.4, color: 0x6fe0ff, alpha: 0.5 * o.alpha }); }
  },
  camp(C, o) {
    if (!o.ghost) for (let k = 0; k < 14; k++) { const a = k * 0.449; C.g.rect(Math.cos(a) * 9 - 0.4, Math.sin(a) * 8 - 1.2, 0.8, 1.6).fill({ color: 0x6a4a2c, alpha: o.alpha }); }
    for (const [x, y] of [[-4, -2], [3, -3], [-1, 4], [5, 3]]) { C.g.poly([x - 2.6, y + 2, x, y - 2.4, x + 2.6, y + 2]); C.fill(0x8a7a5a); }
    if (!o.ghost) C.g.circle(0, 0, 1.2).fill({ color: 0xff8a2a, alpha: o.alpha });
  },
  wonder(C, o) {
    const steps = [[18, 0xdfe7ea], [13, 0xcfe0d4], [9, 0xdfe7ea], [5, 0xcfe0d4]];
    steps.forEach(([w, col], i) => C.box(0, 4 - i * 0.5, w, w * 0.55, 3 + i * 2.5, col, shade(col, 0.8)));
    C.g.moveTo(0, -12).lineTo(0, -22); C.line(0x9ff0e8, 1);
    void o;
  },
};

// Strategic zoom: a distinct pictogram per building type on a category disc (readable without
// colour), larger and ringed for military production and other key facilities.
export const CAT_COL = { civic: 0xd9b44a, residential: 0xb08a5a, agri: 0x7da04a, industry: 0x8a6a4a, power: 0xe0c040, commerce: 0xd08a3a, science: 0x5a90c8, logistics: 0x4aa0a0, military: 0xb5432f };
export const KEY_FACILITY = new Set(['barracks', 'motor_works', 'heavy_assembly', 'airfield', 'drone_works', 'robotics_complex', 'power_plant', 'fusion_plant', 'steel_mill', 'electronics_plant', 'university', 'fort', 'wonder', 'comms_tower', 'town', 'missile_silo', 'aa_battery']);
const W1 = 0xffffff;
const ICON = {
  guard_post: (g) => { g.moveTo(-1.6, 3).lineTo(-0.8, -1.5).moveTo(1.6, 3).lineTo(0.8, -1.5).stroke({ width: 0.8, color: W1 }).rect(-1.8, -3.2, 3.6, 1.8).fill({ color: W1 }); },
  aa_battery: (g) => { g.circle(0, 1.5, 1.6).fill({ color: W1 }).moveTo(0, 1).lineTo(2.6, -3).moveTo(-1, 1).lineTo(1.6, -3.2).stroke({ width: 0.9, color: W1 }); },
  missile_silo: (g) => { g.poly([0, -3.6, 1.4, -1, 1.4, 2.4, -1.4, 2.4, -1.4, -1]).fill({ color: W1 }); },
  town: (g) => { g.poly([-3.4, 0, 0, -3.4, 3.4, 0, 3.4, 3, -3.4, 3]).fill({ color: W1 }); },
  house: (g) => { g.poly([-2.6, 0, 0, -2.6, 2.6, 0]).fill({ color: W1 }).rect(-2, 0, 4, 2.4).fill({ color: W1 }); },
  farm: (g) => { g.moveTo(0, 3).lineTo(0, -3).stroke({ width: 0.9, color: W1 }); for (let k = 0; k < 3; k++) g.moveTo(0, -1.8 + k * 1.4).lineTo(-1.6, -2.8 + k * 1.4).moveTo(0, -1.8 + k * 1.4).lineTo(1.6, -2.8 + k * 1.4).stroke({ width: 0.8, color: W1 }); },
  lumber: (g) => { g.poly([0, -3.2, 2.6, 1.6, -2.6, 1.6]).fill({ color: W1 }).rect(-0.5, 1.6, 1, 1.6).fill({ color: W1 }); },
  quarry: (g) => { g.poly([-3, 2.5, -1, -1, 1.2, 0.4, 3, 2.5]).fill({ color: W1 }); },
  mine: (g) => { g.moveTo(-2.6, 2.6).lineTo(2.2, -2.2).stroke({ width: 1, color: W1 }).arc(1.6, -1.6, 2.4, Math.PI * 0.75, Math.PI * 1.75).stroke({ width: 1, color: W1 }); },
  salvage: (g) => { g.circle(0, 0, 2).stroke({ width: 1.2, color: W1 }); for (let k = 0; k < 6; k++) { const a = k * 1.047; g.rect(Math.cos(a) * 2.8 - 0.6, Math.sin(a) * 2.8 - 0.6, 1.2, 1.2).fill({ color: W1 }); } },
  barracks: (g) => { g.moveTo(-1.8, 3).lineTo(-1.8, -3).stroke({ width: 0.9, color: W1 }).poly([-1.8, -3, 2.8, -1.8, -1.8, -0.6]).fill({ color: W1 }); },
  market: (g) => { g.circle(0, 0, 2.8).stroke({ width: 1, color: W1 }).moveTo(0, -1.8).lineTo(0, 1.8).stroke({ width: 0.9, color: W1 }); },
  academy: (g) => { g.rect(-2.8, -2, 2.6, 4).fill({ color: W1 }).rect(0.2, -2, 2.6, 4).fill({ color: W1 }); },
  university: (g) => { g.poly([-3.4, -1, 0, -2.8, 3.4, -1, 0, 0.8]).fill({ color: W1 }).rect(-1.8, 0, 3.6, 2).fill({ color: W1 }); },
  port: (g) => { g.circle(0, -2.2, 0.9).stroke({ width: 0.8, color: W1 }).moveTo(0, -1.3).lineTo(0, 2.6).stroke({ width: 0.9, color: W1 }).arc(0, 0.6, 2.4, 0.2, Math.PI - 0.2).stroke({ width: 0.9, color: W1 }); },
  bunker: (g) => { g.poly([0, -3, 2.6, -2, 2.4, 0.8, 0, 3, -2.4, 0.8, -2.6, -2]).fill({ color: W1 }); },
  fort: (g) => { const p = []; for (let k = 0; k < 10; k++) { const a = (k * Math.PI) / 5 - Math.PI / 2, r = k % 2 ? 1.5 : 3.4; p.push(Math.cos(a) * r, Math.sin(a) * r); } g.poly(p).fill({ color: W1 }); },
  steel_mill: (g) => { g.rect(-2.8, -0.5, 5.6, 3).fill({ color: W1 }).rect(-2, -3.2, 1.3, 2.8).fill({ color: W1 }).rect(0.4, -2.6, 1.3, 2.2).fill({ color: W1 }); },
  power_plant: (g) => { g.poly([0.8, -3.2, -2, 0.4, -0.2, 0.4, -0.8, 3.2, 2, -0.6, 0.2, -0.6]).fill({ color: W1 }); },
  fusion_plant: (g) => { g.circle(0, 0, 2.6).stroke({ width: 1.2, color: W1 }).circle(0, 0, 0.9).fill({ color: W1 }); },
  oil_well: (g) => { g.poly([0, -3.2, 2.2, 0.6, 1.3, 2.6, -1.3, 2.6, -2.2, 0.6]).fill({ color: W1 }); },
  munitions_plant: (g) => { g.roundRect(-1.3, -3, 2.6, 6, 1.3).fill({ color: W1 }); },
  motor_works: (g) => { g.circle(0, 0, 2.8).stroke({ width: 1.3, color: W1 }).circle(0, 0, 0.9).fill({ color: W1 }); },
  depot: (g) => { g.rect(-2.6, -2.6, 5.2, 5.2).stroke({ width: 1, color: W1 }).moveTo(-2.6, -2.6).lineTo(2.6, 2.6).moveTo(2.6, -2.6).lineTo(-2.6, 2.6).stroke({ width: 0.8, color: W1 }); },
  seismic: (g) => { g.arc(0, -0.5, 2.8, Math.PI * 0.15, Math.PI * 0.85).stroke({ width: 1, color: W1 }).moveTo(0, 0).lineTo(0, 3).stroke({ width: 0.9, color: W1 }); },
  heavy_assembly: (g) => { g.rect(-3, -0.6, 5, 2.6).fill({ color: W1 }).rect(-1.4, -2, 2.4, 1.6).fill({ color: W1 }).moveTo(1, -1.3).lineTo(3.6, -1.3).stroke({ width: 0.9, color: W1 }); },
  airfield: (g) => { g.poly([0, -3.4, 0.7, -0.8, 3.4, 0.6, 3.4, 1.2, 0.7, 0.6, 0.5, 2.4, 1.4, 3, -1.4, 3, -0.5, 2.4, -0.7, 0.6, -3.4, 1.2, -3.4, 0.6, -0.7, -0.8]).fill({ color: W1 }); },
  stabilizer: (g) => { g.ellipse(0, -1.5, 2.8, 1).stroke({ width: 0.9, color: W1 }).ellipse(0, 1.2, 2.2, 0.8).stroke({ width: 0.9, color: W1 }).moveTo(0, -3).lineTo(0, 3).stroke({ width: 0.8, color: W1 }); },
  electronics_plant: (g) => { g.rect(-2, -2, 4, 4).fill({ color: W1 }); for (let k = -1; k <= 1; k++) g.moveTo(-3, k * 1.3).lineTo(3, k * 1.3).stroke({ width: 0.6, color: W1 }); },
  comms_tower: (g) => { g.poly([0, -3.2, 2, 3, -2, 3]).stroke({ width: 0.9, color: W1 }).arc(0, -3.2, 1.6, Math.PI * 1.2, Math.PI * 1.8).stroke({ width: 0.7, color: W1 }); },
  drone_works: (g) => { g.moveTo(-2.4, -2.4).lineTo(2.4, 2.4).moveTo(2.4, -2.4).lineTo(-2.4, 2.4).stroke({ width: 0.9, color: W1 }); for (const [x, y] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]]) g.circle(x, y, 0.9).fill({ color: W1 }); },
  robotics_complex: (g) => { g.rect(-2.6, -2.2, 5.2, 4.4).fill({ color: W1 }); g.circle(-1.1, -0.4, 0.7).fill({ color: 0x222222 }).circle(1.1, -0.4, 0.7).fill({ color: 0x222222 }); },
  camp: (g) => { g.poly([-3, 2.6, 0, -3, 3, 2.6]).fill({ color: W1 }); },
  wonder: (g) => { g.poly([-1, 3, -0.6, -3.4, 0.6, -3.4, 1, 3]).fill({ color: W1 }).rect(-3, 1.5, 6, 1.5).fill({ color: W1 }); },
};

export function drawStrategicIcon(g, type, cat, civ, o = {}) {
  const key = KEY_FACILITY.has(type);
  const r = type === 'town' ? 7 : key ? 6.2 : 4.6;
  g.circle(0, 0, r).fill({ color: CAT_COL[cat] || 0x888888, alpha: o.ghost ? 0.3 : 0.95 }).stroke({ width: key ? 2 : 1.2, color: civ, alpha: 0.95 });
  if (key && !o.ghost) g.circle(0, 0, r + 1.8).stroke({ width: 0.8, color: 0xf3eedf, alpha: 0.55 });
  const icon = ICON[type]; if (icon) icon(g);
}

export function drawBuildingArt(g, b, def, o) {
  g.clear();
  if (o.lod === 'strategic') {
    // housing and fields read as districts at this zoom; facilities keep a pictogram
    if (b.ty === 'house') return;
    drawStrategicIcon(g, b.ty, def.cat, o.civ, o);
    if (o.damaged) g.moveTo(-5, -5).lineTo(5, 5).stroke({ width: 1.4, color: 0x2a1a14 });
    return;
  }
  const C = ctx(g, o);
  if (b.ty !== 'airfield' && b.ty !== 'farm') pad(C, b.ty === 'town' ? 10.5 : 9.6, o.civ);
  else if (!o.ghost) pad(C, 9.6, o.civ);
  if (o.building && !o.ghost) {
    // foundation slab first, the structure fades in as crews raise it
    const fp = []; for (let k = 0; k < 6; k++) { const a = (Math.PI / 180) * (60 * k - 30); fp.push(Math.cos(a) * 7, Math.sin(a) * 6); }
    g.poly(fp).fill({ color: 0x8a8478, alpha: 0.8 });
  }
  (ART[b.ty] || ART.depot)(C, o);
  if (o.damaged && !o.ghost) {
    // scorch marks, holes in the roof and rubble
    for (let k = 0; k < 5; k++) { const a = (k * 2.39 + b.id) % 6.28, d = 2 + ((k * 31 + b.id) % 6); g.circle(Math.cos(a) * d, Math.sin(a) * d - 2, 1.4 + (k % 2)).fill({ color: 0x1a1210, alpha: 0.55 }); }
    for (let k = 0; k < 6; k++) { const a = (k * 1.7 + b.id) % 6.28, d = 6 + (k % 3); g.rect(Math.cos(a) * d - 0.7, Math.sin(a) * d - 0.5, 1.4, 1).fill({ color: 0x6b6158 }); }
  }
}

// Unit vector from a hex toward its first water neighbour (ports face the sea).
export function waterDir(view, S, t) {
  for (let d = 0; d < 6; d++) { const n = view.nb(t, d); if (n >= 0 && S.terr[n] <= 1) { const dx = view.cx[n] - view.cx[t], dy = view.cy[n] - view.cy[t]; const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; } }
  return [1, 0];
}
