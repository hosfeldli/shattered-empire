// Zoom-dependent detail. strategic: territory, roads, armies, disasters.
// city: districts, traffic, factories, construction. micro: pedestrians, squads, fine damage.
export function lodFor(z) { return z < 0.6 ? 'strategic' : z < 1.7 ? 'city' : 'micro'; }
export const LOD_RANK = { strategic: 0, city: 1, micro: 2 };
export const atLeast = (S, lod) => LOD_RANK[S.lod] >= LOD_RANK[lod];
// stable pseudo-random numbers from ids (decor must not jump around between frames or reconnects)
export function h(a, b = 0, c = 0) { let x = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519); x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
export const frac = (x) => x - Math.floor(x);
