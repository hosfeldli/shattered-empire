// No man's land as connected landscape, not dark hexagons. From the server's battlefield intensity
// (1 churned, 2 cratered mud, 3 devastated) and craters it draws:
//   - devastated ground as overlapping soft blobs that spill over hex edges, with extra blobs where
//     neighbouring hexes are also fought over, so a front reads as one continuous scar;
//   - crater fields: shell holes of varied size, the bigger ones with raised rims, overlapping;
//   - water standing in craters and puddled mud where the ground is wet (from the weather);
//   - shattered woodland: forest hexes lose their canopy to mud, leaving broken trunks;
//   - wire and abandoned scrapes running ALONG the front (the line of devastated hexes), not at
//     random angles. Decoration only: none of it blocks or protects anyone.
import { h } from './VisualLOD.js';

const MUD = [0x5a4a36, 0x463828, 0x352a1f];

export function drawBattlefieldTerrain(g, v, S, X, ok, wetAt) {
  const I = new Map((S.bf.i || []).filter(([t]) => ok(t)).map(([t, st]) => [t, st]));
  // 1. the ground itself
  for (const [t, st] of I) {
    const x = X[t], y = v.cy[t];
    const n = 3 + st * 2;
    for (let k = 0; k < n; k++) {
      const ox = (h(t, k, 61) - 0.5) * 18, oy = (h(t, k, 62) - 0.5) * 15, r = 6 + h(t, k, 63) * 5 + st * 1.5;
      g.ellipse(x + ox, y + oy, r * 1.2, r * 0.85).fill({ color: MUD[Math.min(2, st - 1)], alpha: st === 1 ? 0.12 : st === 2 ? 0.2 : 0.26 });
    }
    // joins: where the neighbour is also scarred, bridge the edge so the two read as one
    for (let d = 0; d < 3; d++) {
      const nb = v.nb(t, d); const s2 = nb >= 0 ? I.get(nb) : 0; if (!s2) continue;
      const nx = v.near ? v.near(X[nb], x) : X[nb], ny = v.cy[nb], mx = (x + nx) / 2, my = (y + ny) / 2, s = Math.min(st, s2);
      g.ellipse(mx, my, 9 + s * 2, 6 + s * 1.5).fill({ color: MUD[Math.min(2, s - 1)], alpha: 0.12 + s * 0.05 });
      // fought-over ground joins up into one dug line: a zig-zag scrape from hex to hex with its
      // thrown-up spoil and rubble along it, so the damage reads as continuous trench and wreckage
      if (s >= 2) {
        const dx = nx - x, dy = ny - y, L = Math.hypot(dx, dy) || 1, px = -dy / L, py = dx / L, n = 6;
        g.moveTo(x, y); for (let k = 1; k <= n; k++) { const o = k === n ? 0 : (k % 2 ? 1.6 : -1.6); g.lineTo(x + dx * k / n + px * o, y + dy * k / n + py * o); }
        g.stroke({ width: 3.4, color: 0x6e5c46, alpha: 0.55 });
        g.moveTo(x, y); for (let k = 1; k <= n; k++) { const o = k === n ? 0 : (k % 2 ? 1.6 : -1.6); g.lineTo(x + dx * k / n + px * o, y + dy * k / n + py * o); }
        g.stroke({ width: 1.6, color: 0x231b14, alpha: 0.85 });
        for (let k = 0; k < 3 + s; k++) { const f = h(t, nb, 70 + k), side = h(t, nb, 80 + k) < 0.5 ? -1 : 1; g.rect(x + dx * f + px * side * (2.6 + h(t, nb, 90 + k) * 2) - 0.7, y + dy * f + py * side * (2.6 + h(t, nb, 90 + k) * 2) - 0.5, 1.4 + h(t, k, 95) * 0.8, 1).fill({ color: k % 3 ? 0x6b6258 : 0x8a7e6e, alpha: 0.95 }); }
      }
    }
    // shattered woodland: the canopy is gone under the mud; broken trunks remain
    if (S.terr[t] === 4 && st >= 2) {
      g.ellipse(x, y, 13, 10).fill({ color: MUD[1], alpha: st === 2 ? 0.45 : 0.7 });
      for (let k = 0; k < 4 + st * 2; k++) {
        const ox = (h(t, k, 21) - 0.5) * 16, oy = (h(t, k, 22) - 0.5) * 13, a = h(t, k, 23) * Math.PI * 2, L = 1.2 + h(t, k, 24) * 2.2;
        g.rect(x + ox - 0.5, y + oy - 2, 1.1, 2).fill({ color: 0x2a2219 });
        if (k % 2) g.moveTo(x + ox, y + oy).lineTo(x + ox + Math.cos(a) * L, y + oy + Math.sin(a) * L * 0.5).stroke({ width: 0.9, color: 0x3a2e22, alpha: 0.9 });   // a fallen trunk
      }
    } else if (st >= 2) for (let k = 0; k < st; k++) { const ox = (h(t, k, 21) - 0.5) * 14, oy = (h(t, k, 22) - 0.5) * 11; g.rect(x + ox - 0.5, y + oy - 1.8, 1, 1.8).fill({ color: 0x2a2219, alpha: 0.9 }); }
  }
  // 2. shell holes across the scarred ground (a crater field where it is worst)
  for (const [t, st] of I) {
    const x = X[t], y = v.cy[t], wet = wetAt(x, y);
    for (let k = 0; k < st * 4; k++) {
      const ox = (h(t, k, 11) - 0.5) * 18, oy = (h(t, k, 12) - 0.5) * 14, big = h(t, k, 14) < 0.2 * st, r = (big ? 1.8 : 0.9) + h(t, k, 13) * (st >= 2 ? 1.6 : 0.9);
      hole(g, x + ox, y + oy, r, wet, big);
    }
  }
  // 3. along the front: wire and abandoned scrapes follow the line of devastated hexes
  for (const [t, st] of I) {
    if (st < 3) continue;
    const x = X[t], y = v.cy[t];
    let ax = 0, ay = 0;
    for (let d = 0; d < 6; d++) { const nb = v.nb(t, d); if (nb < 0 || (I.get(nb) || 0) < 3) continue; const dx = (v.near ? v.near(X[nb], x) : X[nb]) - x, dy = v.cy[nb] - y; if (ax * dx + ay * dy < 0) { ax -= dx; ay -= dy; } else { ax += dx; ay += dy; } }
    let ang = Math.atan2(ay, ax);
    if (!ax && !ay) {          // an isolated hex: run across the slope of the fighting instead
      let gx = 0, gy = 0; for (let d = 0; d < 6; d++) { const nb = v.nb(t, d); if (nb < 0) continue; const s = I.get(nb) || 0; gx += ((v.near ? v.near(X[nb], x) : X[nb]) - x) * s; gy += (v.cy[nb] - y) * s; }
      ang = gx || gy ? Math.atan2(gy, gx) + Math.PI / 2 : h(t, 7, 31) * Math.PI;
    }
    const c = Math.cos(ang), sn = Math.sin(ang), L = 9, off = (h(t, 3, 33) - 0.5) * 6;
    const px = -sn * off, py = c * off;
    // wire: a coil on pickets, broken in places
    g.moveTo(x + px - c * L, y + py - sn * L);
    for (let k = 1; k <= 12; k++) { const f = -L + (2 * L * k) / 12, o = k % 2 ? 1 : -1; if (h(t, k, 35) < 0.12) g.moveTo(x + px + c * f, y + py + sn * f); else g.lineTo(x + px + c * f - sn * o, y + py + sn * f + c * o); }
    g.stroke({ width: 0.55, color: 0x8a8378, alpha: 0.8 });
    for (let k = 0; k <= 3; k++) { const f = -L + (2 * L * k) / 3; g.rect(x + px + c * f - 0.5, y + py + sn * f - 1.4, 1, 1.6).fill({ color: 0x3a3029 }); }
    // an abandoned scrape behind the wire (shallow, broken: not a working trench)
    if (h(t, 9, 37) < 0.6) {
      const bx = x - px * 1.6, by = y - py * 1.6;
      g.moveTo(bx - c * 6, by - sn * 6); for (let k = 1; k <= 4; k++) { const f = -6 + 3 * k, o = k % 2 ? 1.2 : -1.2; g.lineTo(bx + c * f - sn * o, by + sn * f + c * o); }
      g.stroke({ width: 1.6, color: 0x2a2219, alpha: 0.55 });
    }
    for (let k = 0; k < 4; k++) g.rect(x + (h(t, k, 41) - 0.5) * 14, y + (h(t, k, 42) - 0.5) * 10, 1.6, 1.1).fill({ color: k % 2 ? 0x6b6258 : 0x4a4038 });
  }
}

// one shell hole: thrown-up rim, bowl, shadowed depth, lit lip; water standing in it when wet
export function hole(g, cx, cy, r, wet, big) {
  if (big) g.ellipse(cx, cy, r * 1.9, r * 1.4).fill({ color: 0x7a6650, alpha: 0.45 });
  g.ellipse(cx, cy, r * 1.15, r * 0.85).fill({ color: 0x3a2f25, alpha: 0.95 });
  if (wet > 0.25) {
    g.ellipse(cx + r * 0.12, cy + r * 0.1, r * 0.82, r * 0.56).fill({ color: 0x2c3b45, alpha: 0.6 + wet * 0.3 });
    g.ellipse(cx - r * 0.2, cy - r * 0.08, r * 0.3, r * 0.12).fill({ color: 0x9fb8c8, alpha: 0.35 * wet });     // a glint on the water
  } else g.ellipse(cx + r * 0.18, cy + r * 0.14, r * 0.8, r * 0.55).fill({ color: 0x1c1712, alpha: 0.9 });
  g.ellipse(cx - r * 0.45, cy - r * 0.35, r * 0.45, r * 0.22).fill({ color: 0x9a8668, alpha: 0.4 });
}
