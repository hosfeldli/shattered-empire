// Terrain as landscape rather than a board of coloured cells. Painted once into the cached chunk
// canvases (only when a hex changes), deterministic per hex so it never flickers:
//   - colours are smoothed toward same-biome neighbours so hex seams disappear
//   - soft edge blends between biomes, beaches and surf along coasts
//   - relief shading lit from the north-west (hills, ranges, valleys)
//   - biome detail: tree canopies, grass tufts, dunes, contours, ridges with snow, reeds, waves
import { h } from './VisualLOD.js';

const T = { DEEP: 0, SHALLOW: 1, GRASS: 2, PLAINS: 3, FOREST: 4, DESERT: 5, TUNDRA: 6, MARSH: 7, HILLS: 8, MOUNTAIN: 9, PEAK: 10, LAVA: 11, ASH: 12 };
const HEIGHT = [-2, -1, 0, 0.1, 0.35, 0.1, 0.15, -0.05, 1, 2, 3, 0.5, 0.3];
const isWater = (t) => t === T.DEEP || t === T.SHALLOW;
const rgb = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const css = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const shade = ([r, g, b], f, a = 1) => css(Math.min(255, r * f), Math.min(255, g * f), Math.min(255, b * f), a);

// Base colour: the server's colour, softened toward same-biome neighbours (no checkerboard).
export function smoothColor(v, S, i) {
  const t = S.terr[i]; let [r, g, b] = rgb(S.color[i]); let n = 1;
  for (let d = 0; d < 6; d++) {
    const k = v.nb(i, d); if (k < 0 || S.terr[k] !== t) continue;
    const c = rgb(S.color[k]); r += c[0] * 0.6; g += c[1] * 0.6; b += c[2] * 0.6; n += 0.6;
  }
  return [r / n, g / n, b / n];
}

// Everything drawn on top of the base fills for one hex (canvas in base world coordinates).
export function paintTerrainDetail(ctx, v, S, i, R, CORNERS) {
  const t = S.terr[i]; if (t === 255) return;
  const x = v.cx0[i], y = v.cy[i];
  const base = smoothColor(v, S, i);
  // ---- relief: slopes facing the north-west light are brighter, the others darker
  const hN = (d) => { const k = v.nb(i, d); return k >= 0 && S.terr[k] !== 255 ? HEIGHT[S.terr[k]] : HEIGHT[t]; };
  const lightSide = (hN(2) + hN(3)) / 2, darkSide = (hN(5) + hN(0)) / 2;
  const slope = (lightSide - darkSide) * 0.5 + (HEIGHT[t] - lightSide) * 0.35;
  if (!isWater(t) && Math.abs(slope) > 0.04) {
    v.hexPath(ctx, i, 0.6);
    ctx.fillStyle = slope > 0 ? `rgba(255,248,225,${Math.min(0.16, slope * 0.12)})` : `rgba(10,14,20,${Math.min(0.22, -slope * 0.14)})`;
    ctx.fill();
  }
  // ---- edge blends: a soft band of each different neighbour's colour; beaches and surf on coasts
  for (let d = 0; d < 6; d++) {
    const k = v.nb(i, d); if (k < 0 || S.terr[k] === 255 || S.terr[k] === t) continue;
    const a = CORNERS[EDGE[d][0]], b = CORNERS[EDGE[d][1]];
    const p1 = [x + a[0] * (R + 0.6), y + a[1] * (R + 0.6)], p2 = [x + b[0] * (R + 0.6), y + b[1] * (R + 0.6)];
    const inset = (p, f) => [p[0] + (x - p[0]) * f, p[1] + (y - p[1]) * f];
    const tk = S.terr[k];
    if (!isWater(t) && isWater(tk)) {
      // beach on the land side
      const q1 = inset(p1, 0.22), q2 = inset(p2, 0.22);
      ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.lineTo(...q2); ctx.lineTo(...q1); ctx.closePath();
      ctx.fillStyle = t === T.MOUNTAIN || t === T.PEAK || t === T.HILLS ? 'rgba(120,112,100,0.45)' : 'rgba(222,204,150,0.55)'; ctx.fill();
    } else if (isWater(t) && !isWater(tk)) {
      // surf on the water side
      const q1 = inset(p1, 0.18), q2 = inset(p2, 0.18);
      ctx.beginPath(); ctx.moveTo(...q1); ctx.lineTo(...q2); ctx.strokeStyle = 'rgba(230,242,245,0.35)'; ctx.lineWidth = 0.9; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.lineTo(...q2); ctx.lineTo(...q1); ctx.closePath();
      ctx.fillStyle = 'rgba(120,175,190,0.35)'; ctx.fill();
    } else {
      const nc = smoothColor(v, S, k);
      const q1 = inset(p1, 0.34), q2 = inset(p2, 0.34);
      const grad = ctx.createLinearGradient((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2);
      grad.addColorStop(0, css(nc[0], nc[1], nc[2], 0.5)); grad.addColorStop(1, css(nc[0], nc[1], nc[2], 0));
      ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.lineTo(...q2); ctx.lineTo(...q1); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
    }
  }
  // ---- biome detail
  const r = (k) => h(i, k, 77), inside = (k, s2 = 0.62) => { const ang = r(k) * 6.283, d = Math.sqrt(r(k + 50)) * R * s2; return [x + Math.cos(ang) * d, y + Math.sin(ang) * d * 0.9]; };
  switch (t) {
    case T.FOREST: {
      const n = 5 + Math.floor(r(1) * 3);
      for (let k = 0; k < n; k++) {
        const [tx, ty] = inside(10 + k), rad = 2.4 + r(30 + k) * 1.3;
        ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(tx + 1.1, ty + 1.2, rad, rad * 0.7, 0, 0, 7); ctx.fill();
        ctx.fillStyle = shade(base, 0.72 + r(40 + k) * 0.18); ctx.beginPath(); ctx.arc(tx, ty, rad, 0, 7); ctx.fill();
        ctx.fillStyle = shade(base, 1.18, 0.75); ctx.beginPath(); ctx.arc(tx - rad * 0.3, ty - rad * 0.35, rad * 0.45, 0, 7); ctx.fill();
      }
      break;
    }
    case T.GRASS: case T.PLAINS: {
      ctx.lineWidth = 0.6;
      for (let k = 0; k < 7; k++) {
        const [tx, ty] = inside(10 + k, 0.78);
        ctx.strokeStyle = shade(base, k % 2 ? 1.18 : 0.82, 0.7);
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx - 0.6, ty - 1.6); ctx.moveTo(tx, ty); ctx.lineTo(tx + 0.7, ty - 1.4); ctx.stroke();
      }
      if (t === T.PLAINS && r(3) < 0.4) { const [tx, ty] = inside(4, 0.4); ctx.fillStyle = shade(base, 0.8, 0.8); ctx.beginPath(); ctx.arc(tx, ty, 1.4, 0, 7); ctx.fill(); }   // a lone shrub
      break;
    }
    case T.HILLS: {
      for (let k = 0; k < 2; k++) {
        const [tx, ty] = inside(10 + k, 0.4), w2 = 5 + r(20 + k) * 3;
        ctx.strokeStyle = shade(base, 1.25, 0.8); ctx.lineWidth = 0.9; ctx.beginPath(); ctx.arc(tx, ty + 1.5, w2, Math.PI * 1.1, Math.PI * 1.6); ctx.stroke();
        ctx.strokeStyle = shade(base, 0.68, 0.8); ctx.beginPath(); ctx.arc(tx, ty + 1.5, w2, Math.PI * 1.6, Math.PI * 1.95); ctx.stroke();
      }
      break;
    }
    case T.MOUNTAIN: case T.PEAK: {
      const n = t === T.PEAK ? 1 : 2;
      const snowy = t === T.PEAK || base[0] + base[1] + base[2] > 420;
      for (let k = 0; k < n; k++) {
        const [tx, ty] = n === 1 ? [x, y + 2] : inside(10 + k, 0.35);
        const hgt = (t === T.PEAK ? 13 : 9) + r(20 + k) * 3, wd = hgt * 0.75;
        ctx.fillStyle = shade(base, 1.22); ctx.beginPath(); ctx.moveTo(tx - wd, ty + 3); ctx.lineTo(tx, ty + 3 - hgt); ctx.lineTo(tx, ty + 3); ctx.closePath(); ctx.fill();
        ctx.fillStyle = shade(base, 0.62); ctx.beginPath(); ctx.moveTo(tx, ty + 3 - hgt); ctx.lineTo(tx + wd, ty + 3); ctx.lineTo(tx, ty + 3); ctx.closePath(); ctx.fill();
        if (snowy) { ctx.fillStyle = 'rgba(245,248,252,0.92)'; ctx.beginPath(); ctx.moveTo(tx - wd * 0.32, ty + 3 - hgt * 0.62); ctx.lineTo(tx, ty + 3 - hgt); ctx.lineTo(tx + wd * 0.3, ty + 3 - hgt * 0.6); ctx.lineTo(tx + wd * 0.1, ty + 3 - hgt * 0.66); ctx.lineTo(tx - wd * 0.08, ty + 3 - hgt * 0.56); ctx.closePath(); ctx.fill(); }
      }
      break;
    }
    case T.DESERT: {
      ctx.lineWidth = 0.9;
      for (let k = 0; k < 3; k++) { const [tx, ty] = inside(10 + k, 0.55); ctx.strokeStyle = shade(base, 1.15, 0.8); ctx.beginPath(); ctx.moveTo(tx - 4, ty); ctx.quadraticCurveTo(tx - 1, ty - 2.2, tx + 4, ty - 0.5); ctx.stroke(); ctx.strokeStyle = shade(base, 0.8, 0.6); ctx.beginPath(); ctx.moveTo(tx - 3, ty + 0.9); ctx.quadraticCurveTo(tx, ty - 0.6, tx + 4, ty + 0.4); ctx.stroke(); }
      break;
    }
    case T.TUNDRA: {
      for (let k = 0; k < 9; k++) { const [tx, ty] = inside(10 + k, 0.8); ctx.fillStyle = k % 3 ? 'rgba(240,244,246,0.55)' : shade(base, 0.7, 0.6); ctx.fillRect(tx, ty, 1, 1); }
      break;
    }
    case T.MARSH: {
      for (let k = 0; k < 2; k++) { const [tx, ty] = inside(10 + k, 0.5); ctx.fillStyle = 'rgba(70,110,120,0.55)'; ctx.beginPath(); ctx.ellipse(tx, ty, 3, 1.3, 0, 0, 7); ctx.fill(); }
      ctx.strokeStyle = shade(base, 0.7, 0.8); ctx.lineWidth = 0.6;
      for (let k = 0; k < 6; k++) { const [tx, ty] = inside(20 + k, 0.75); ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + (r(40 + k) - 0.5), ty - 2.4); ctx.stroke(); }
      break;
    }
    case T.ASH: {
      for (let k = 0; k < 8; k++) { const [tx, ty] = inside(10 + k, 0.8); ctx.fillStyle = 'rgba(30,26,24,0.5)'; ctx.fillRect(tx, ty, 1.2, 1.2); }
      break;
    }
    case T.LAVA: {
      ctx.strokeStyle = 'rgba(255,200,80,0.8)'; ctx.lineWidth = 0.9;
      for (let k = 0; k < 3; k++) { const [tx, ty] = inside(10 + k, 0.5); ctx.beginPath(); ctx.moveTo(tx - 3, ty); ctx.lineTo(tx, ty + 1.5); ctx.lineTo(tx + 3, ty - 1); ctx.stroke(); }
      break;
    }
    case T.SHALLOW: case T.DEEP: {
      // depth: shallow water lightens toward land; gentle wave strokes
      ctx.strokeStyle = t === T.SHALLOW ? 'rgba(200,230,240,0.22)' : 'rgba(150,190,220,0.13)'; ctx.lineWidth = 0.7;
      for (let k = 0; k < (t === T.SHALLOW ? 2 : 1); k++) { const [tx, ty] = inside(10 + k, 0.6); ctx.beginPath(); ctx.moveTo(tx - 3, ty); ctx.quadraticCurveTo(tx - 1.5, ty - 1.2, tx, ty); ctx.quadraticCurveTo(tx + 1.5, ty + 1.2, tx + 3, ty); ctx.stroke(); }
      break;
    }
    default: break;
  }
}
const EDGE = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
