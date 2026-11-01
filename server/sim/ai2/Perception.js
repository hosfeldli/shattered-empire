// What a civilization may legitimately know. Every AI decision about other nations goes through
// here instead of the live simulation: hostile units only where this empire sees them right now
// (in its vision, not hidden in smoke, detected if stealthy); cities as last seen; its own assets
// in full. Running on the server is no excuse to look through the fog.
import { UNITS } from '../constants.js';
import { dist } from '../hex.js';

export function visibleHostiles(g, civ, filter = null) {
  const vis = civ.visible, hide = civ.smokeHide, out = [];
  for (const u of g.units.values()) {
    if (u.owner === civ.id || !vis[u.tile] || (hide && hide[u.tile]) || !g.hostile(civ.id, u.owner) || !g.detects(civ.id, u)) continue;
    if (filter && !filter(u)) continue;
    out.push(u);
  }
  return out;
}

// hostile combat units seen within `r` hexes of a tile
export function hostilesNear(g, civ, tile, r, opts = {}) {
  return visibleHostiles(g, civ, (u) => !UNITS[u.type].civilian && dist(u.tile, tile) <= r && (!opts.air || UNITS[u.type].air));
}

export function perceive(g, civ) {
  const own = [], ownCombat = [];
  for (const u of g.units.values()) if (u.owner === civ.id) { own.push(u); if (!UNITS[u.type].civilian) ownCombat.push(u); }
  const hostiles = visibleHostiles(g, civ, (u) => !UNITS[u.type].civilian);
  return { time: g.time, own, ownCombat, hostiles, knownCities: [...(civ.knownCities?.values() || [])] };
}
