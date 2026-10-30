// Unit bodies by movement class, oriented to their heading; squads show their soldiers up close.
import { atLeast } from './VisualLOD.js';

function rotPoly(pts, a) { const c = Math.cos(a), s = Math.sin(a); const out = []; for (let i = 0; i < pts.length; i += 2) out.push(pts[i] * c - pts[i + 1] * s, pts[i] * s + pts[i + 1] * c); return out; }

export function drawUnitBody(g, u, def, S, sel, heading) {
  g.clear();
  const col = S.civColor(u.owner);
  const dark = 0x0b1518;
  if (S.lod === 'strategic') {
    g.circle(0, 0, 5).fill({ color: col }).stroke({ width: 1, color: dark });
    if (sel) g.circle(0, 0, 8).stroke({ width: 1.6, color: 0xf1c75b });
    return;
  }
  if (u.flags & 2) g.ellipse(0, 1, 11, 6).fill({ color: 0x5b4127 }).stroke({ width: 1.2, color: col });
  if (def.civilian && def.move !== 'aircraft') {
    g.poly(rotPoly([-6, -5, 6, -5, 7, 0, 6, 5, -6, 5], heading)).fill({ color: col }).stroke({ width: 1.1, color: dark });
  } else if (def.move === 'infantry') {
    g.circle(0, 0, 7).fill({ color: col }).stroke({ width: 1.2, color: dark });
    if (atLeast(S, 'micro') && def.men) {
      // the squad: one dot per represented soldier, in a loose formation behind the marker
      const n = Math.min(12, def.men);
      for (let k = 0; k < n; k++) { const a = heading + Math.PI + (k - n / 2) * 0.35, r = 9 + (k % 3) * 2.2; g.circle(Math.cos(a) * r, Math.sin(a) * r, 1).fill({ color: col, alpha: 0.9 }); }
    }
  } else if (def.move === 'wheeled') {
    g.poly(rotPoly([-8, -4.5, 7, -4.5, 9, 0, 7, 4.5, -8, 4.5], heading)).fill({ color: col }).stroke({ width: 1.1, color: dark });
    for (const [x, y] of [[-5, -5], [4, -5], [-5, 5], [4, 5]]) { const [rx, ry] = rotPoly([x, y], heading); g.circle(rx, ry, 1.4).fill({ color: 0x1a1a1a }); }
    if (def.cat === 'artillery') { const [bx, by] = rotPoly([16, 0], heading); g.moveTo(0, 0).lineTo(bx, by).stroke({ width: 1.6, color: dark }); }
  } else if (def.move === 'tracked') {
    g.poly(rotPoly([-9, -6.5, 9, -6.5, 9, 6.5, -9, 6.5], heading)).fill({ color: 0x2a2a28 });
    g.poly(rotPoly([-8, -4.5, 8, -4.5, 8, 4.5, -8, 4.5], heading)).fill({ color: col }).stroke({ width: 1, color: dark });
    g.circle(0, 0, 3.2).fill({ color: col }).stroke({ width: 1, color: dark });
    const [bx, by] = rotPoly([def.cat === 'artillery' ? 17 : 13, 0], heading); g.moveTo(0, 0).lineTo(bx, by).stroke({ width: 2, color: dark });
  } else if (def.move === 'aircraft') {
    g.ellipse(2, 9, 7, 2.5).fill({ color: 0x000000, alpha: 0.25 });   // ground shadow
    g.poly(rotPoly([10, 0, -7, -8, -4, 0, -7, 8], heading)).fill({ color: col }).stroke({ width: 1.1, color: dark });
    if (def.glyph === 'He') g.circle(0, 0, 9).stroke({ width: 0.8, color: 0xffffff, alpha: 0.35 });
  }
  if (sel) g.circle(0, 0, 11).stroke({ width: 1.6, color: 0xf1c75b });
  if (u.hp < 100) g.rect(-7, 9.5, 14, 2.2).fill({ color: 0x220d09 }).rect(-7, 9.5, (14 * u.hp) / 100, 2.2).fill({ color: u.hp > 40 ? 0x7ccf73 : 0xe0533b });
  if (u.owner === S.civId && u.flags & 4) g.circle(7, -7, 2.6).fill({ color: 0xe0533b }).stroke({ width: 0.8, color: dark });
  if (u.owner === S.civId && u.flags & 8) g.circle(-7, 7, 2.4).fill({ color: 0xf0b54a });
  if (u.owner === S.civId && u.flags & 16) g.moveTo(-4, -4).lineTo(4, 4).moveTo(4, -4).lineTo(-4, 4).stroke({ width: 2, color: 0xe0533b });
  if (u.flags & 1) g.circle(-7, -7, 2.2).fill({ color: 0xffe08a });
}
