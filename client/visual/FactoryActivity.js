// Working buildings look busy: chimneys smoke, pumpjacks nod, tractors plough, trucks load,
// barracks drill. Idle buildings (no workers, no inputs, no queue) sit still.
import { h, frac, atLeast } from './VisualLOD.js';

const SMOKE = { steel_mill: 0x3b3b3b, power_plant: 0xd9d9d9, munitions_plant: 0x6a5a4a, motor_works: 0x5a5a5a, heavy_assembly: 0x4a4a4a, electronics_plant: 0xbfc7cc, salvage: 0x6b6158, robotics_complex: 0xc8d0d4 };

export function drawFactories(g, view, S, t) {
  const era = S.econ?.age || 0;
  for (const b of S.buildings.values()) {
    if (!b.d || b.st === 'planned') continue;
    const x = view.cx[b.t], y = view.cy[b.t];
    if (!view.inView(x, y, 40)) continue;
    const active = b.a && b.st !== 'damaged';
    if (SMOKE[b.ty] !== undefined && active) {
      for (let k = 0; k < 5; k++) {
        const age = frac(t * 0.3 + k / 5 + h(b.id, k));
        const sx = x + 4 + age * 8 * (0.6 + h(b.id) * 0.6), sy = y - 7 - age * 18;
        g.circle(sx, sy, 1.4 + age * 3.2).fill({ color: SMOKE[b.ty], alpha: (1 - age) * 0.42 });
      }
    }
    if (!atLeast(S, 'city')) continue;
    if (b.ty === 'farm') {
      // crop rows change colour with the seasons; tractors appear with mechanised agriculture
      const season = frac(S.time / 600);
      const crop = season < 0.25 ? 0x6d8f3a : season < 0.5 ? 0x9bb04a : season < 0.75 ? 0xc9b24a : 0x7a6a4a;
      for (let r = -2; r <= 2; r++) g.moveTo(x - 7, y + r * 2.4).lineTo(x + 7, y + r * 2.4);
      g.stroke({ width: 1, color: crop, alpha: active ? 0.85 : 0.35 });
      if (active && era >= 2) { const p = frac(t * 0.08 + h(b.id)); const row = Math.floor(p * 5), q = frac(p * 5); const px = row % 2 ? x + 7 - q * 14 : x - 7 + q * 14; g.rect(px - 1.5, y + (row - 2) * 2.4 - 1, 3, 2).fill({ color: 0xc8402a }); }
    } else if (b.ty === 'oil_well' && active) {
      const a = Math.sin(t * 2 + b.id) * 0.5; g.moveTo(x - 5, y + 2 + a * 4).lineTo(x + 5, y + 2 - a * 4).stroke({ width: 1.6, color: 0x1a1a1a });
    } else if ((b.ty === 'mine' || b.ty === 'quarry') && active) {
      const p = frac(t * 0.2 + h(b.id)); const q = p < 0.5 ? p * 2 : 2 - p * 2;
      g.rect(x - 6 + q * 12, y + 5, 3, 2).fill({ color: era >= 2 ? 0xd9a62a : 0x7a5a3a });
    } else if (b.ty === 'port' && active) {
      g.ellipse(x + 8 + Math.sin(t + b.id) * 1.2, y + 6, 4, 1.6).fill({ color: 0x5b4127 });
    } else if (['barracks', 'motor_works', 'heavy_assembly'].includes(b.ty) && b.q?.length) {
      for (let k = 0; k < 6; k++) { const a = t * 0.6 + k * 0.4; g.circle(x + Math.cos(a) * 9, y + Math.sin(a) * 6, 0.9).fill({ color: S.civColor(b.o) }); }
    } else if (b.ty === 'airfield') {
      // a plane rolling down the runway drawn by BuildingArt
      if (active || b.q?.length) { const p = frac(t * 0.15 + h(b.id)); g.rect(x - 9 + p * 18 - 1.5, y + 7.2 - p * 12 - 1, 3, 2).fill({ color: 0xe0e0e0 }); }
    } else if (['market', 'steel_mill', 'munitions_plant', 'electronics_plant'].includes(b.ty) && active) {
      // delivery truck shuttling to the nearest road
      const p = frac(t * 0.12 + h(b.id, 4)); const q = p < 0.5 ? p * 2 : 2 - p * 2;
      g.rect(x - 2 + q * 9, y + 6 - q * 3, 2.6, 1.6).fill({ color: era === 0 ? 0x7a5a3a : 0xd8d2c4 });
    }
    if (S.night > 0.2 && active && era >= 1) S.lightsList.push([x, y, 6, 0xffd48a]);
  }
}
