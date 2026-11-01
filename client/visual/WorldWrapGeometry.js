// Shared geometry for the cylindrical world (east wraps to west; north and south are real edges).
//
// A logical hex has one identity (its tile index) but its artwork can appear at any horizontal
// position x + k·P, where P is one world circumference in rendering units. Everything that draws
// a connected shape (routes, roads, trench lines, formation lines, arrows, tracers) goes through
// these helpers so that each point is placed relative to the previous one, never independently
// relative to the camera: a five-hex route across the seam stays a short five-hex line.

export function wrapX(x, P) { return ((x % P) + P) % P; }

// the image of x (x + k·P) nearest to anchor
export function nearestCopy(x, anchor, P) { return P ? x + Math.round((anchor - x) / P) * P : x; }

// points: [{x, y}] in any copy. The first point is placed near anchor, each following point near
// its predecessor (so the polyline is continuous). A deliberate route longer than half the world
// keeps its direction because consecutive route points are always close together.
export function unwrapPolyline(points, anchor, P) {
  if (!points.length) return [];
  const out = [];
  let prev = nearestCopy(points[0].x, anchor, P);
  out.push({ x: prev, y: points[0].y });
  for (let i = 1; i < points.length; i++) {
    const x = nearestCopy(points[i].x, prev, P);
    out.push({ x, y: points[i].y });
    prev = x;
  }
  return out;
}

// Tiles -> continuous screen-world points. view supplies cx0 (base x), cy and P (0 when the world
// does not wrap). Returns [[x, y], ...].
export function tilePolyline(view, tiles, anchorX) {
  const out = []; if (!tiles || !tiles.length) return out;
  const P = view.wrap ? view.P : 0;
  let prev = anchorX == null ? view.cx[tiles[0]] : nearestCopy(view.cx0[tiles[0]], anchorX, P);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]; if (t == null || t < 0) continue;
    const x = i === 0 ? prev : nearestCopy(view.cx0[t], prev, P);
    out.push([x, view.cy[t]]); prev = x;
  }
  return out;
}

// the copy of tile b's centre that is nearest to the point (ax, *)
export function tileNear(view, b, ax) { return view.wrap ? nearestCopy(view.cx0[b], ax, view.P) : view.cx0[b]; }

// Horizontal extent of a viewport [x0, x1] on a canonical map of width P: one interval, or two
// when the viewport crosses the seam (used by the minimap's viewport indicator).
export function wrappedIntervals(x0, x1, P) {
  if (!P || x1 - x0 >= P) return [[0, P || x1]];
  const a = wrapX(x0, P), b = a + (x1 - x0);
  return b <= P ? [[a, b]] : [[a, P], [0, b - P]];
}
