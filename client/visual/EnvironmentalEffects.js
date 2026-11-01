// Fires, smouldering ruins, falling ash and flocks of birds (consistent daylight: no day/night).
import { h, frac, atLeast } from './VisualLOD.js';


export function drawEnvironment(g, view, S, t) {
  for (const b of S.buildings.values()) {
    if (!b.f) continue;
    const x = view.cx[b.t], y = view.cy[b.t]; if (!view.inView(x, y, 40)) continue;
    for (let k = 0; k < 6; k++) { const j = Math.sin(t * 9 + k * 2.1 + b.id) * 1.5; g.circle(x - 5 + k * 2 + j * 0.4, y - 2 - Math.abs(j) * 2, 2.2 + (k % 3)).fill({ color: k % 2 ? 0xffb02e : 0xff6a1a, alpha: 0.85 }); }
    smoke(g, x, y - 6, b.id, t, 0x2a2420, 7);
    S.lightsList.push([x, y, 12, 0xff7a2a]);
  }
  for (const [tile, r] of S.ruins) {
    if (!(r.flags & 2)) continue;
    const x = view.cx[tile], y = view.cy[tile]; if (!view.inView(x, y, 40)) continue;
    smoke(g, x, y - 2, tile, t, 0x4a4440, 4);
  }
  if (!atLeast(S, 'city')) return;
  // ash fall drifts over ash-covered ground in view
  let n = 0;
  const [x0, y0, x1, y1] = view.vr;
  for (let k = 0; k < 120 && n < 160; k++) {
    const x = x0 + h(k, 3) * (x1 - x0), y = y0 + frac(h(k, 5) + t * 0.03) * (y1 - y0);
    const tile = view.tileAt(x, y); if (tile < 0 || !(S.flags[tile] & 32)) continue;
    g.rect(x + Math.sin(t + k) * 2, y, 0.9, 0.9).fill({ color: 0x9a948c, alpha: 0.7 }); n++;
  }
  // birds over the land: flocks live in world space (they drift across the map, not across the screen),
  // so panning and zooming move past them like everything else on the ground
  const P = view.P || (view.cx[S.W - 1] - view.cx[0] + (view.cx[1] - view.cx[0])), WH = view.cy[S.W * (S.H - 1)] || 1;
  const cxm = (x0 + x1) / 2;
  for (let f = 0; f < 24; f++) {
    const sp = 6 + h(f, 4) * 8;                               // world units per second
    let bx = frac(h(f, 1) + (t * sp) / P) * P;
    bx += Math.round((cxm - bx) / P) * P;                     // nearest copy on a wrapping world
    const by = h(f, 2) * WH + Math.sin(t * 0.13 + f) * 30;
    if (bx < x0 - 30 || bx > x1 + 30 || by < y0 - 30 || by > y1 + 30) continue;
    for (let k = 0; k < 5; k++) { const ox = -k * 3, oy = (k % 2 ? 1 : -1) * k * 1.6; const wing = Math.sin(t * 8 + k + f) * 1.2; g.moveTo(bx + ox - 1.5, by + oy).lineTo(bx + ox, by + oy - 0.6 - wing).lineTo(bx + ox + 1.5, by + oy).stroke({ width: 0.7, color: 0x22282a, alpha: 0.7 }); }
  }
}

function smoke(g, x, y, seed, t, color, n) {
  for (let k = 0; k < n; k++) { const age = frac(t * 0.25 + k / n + h(seed, k)); g.circle(x + age * 9 * (h(seed) - 0.3), y - age * 22, 1.8 + age * 4).fill({ color, alpha: (1 - age) * 0.4 }); }
}
