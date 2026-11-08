// Line deployment planner (pure: no game imports, so the browser runs the very same code for its
// live preview and the server re-runs it to validate the committed order).
//
//   planDeployment(env, units, line, opts) -> { slots, perHex, ranks, overflow, invalid, label, ... }
//
// env:   { W, H, wrap, passable(t, unit) -> bool, capacity(t) -> int, occupied(t) -> int (others) }
// units: [{ id, tile, role: 'front'|'support'|'artillery'|'logistics', air, vehicle, slot? }]
// line:  [startTile, endTile]   (the drag; its length sets the frontage, its direction the facing)
// opts:  { mode: 'line'|'compact'|'depth'|'preserve', density: 'auto'|'spread'|'balanced'|'tight',
//          depth: 1|2|3|'auto', reverse: bool, keep: Map(id -> tile) (units that keep their slot),
//          away: tile (face away from it: the nearest own city, so a line faces outward by default) }
//
// Rules: shortening the line concentrates the force up to each hex's legal ground capacity;
// what does not fit spills into rear ranks; units are matched to slots along the line in order
// of where they stand now, so nobody marches across the formation; ties break by unit id.

const SQ3 = Math.sqrt(3);
const ROLE_RANK = { front: 0, support: 1, artillery: 2, logistics: 2 };

export function hexXY(t, W) { const r = (t / W) | 0, q = t % W; return [SQ3 * (q + 0.5 * (r & 1)), 1.5 * r]; }

// tiles on the straight line a -> b (unwrapped around a when the world wraps)
// the hexes along a drawn line: a straight segment, or (with a path of three or more points) the
// player's curve, segment by segment, in drawing order
function lineTiles(env, a, b, path = null) {
  const { W } = env;
  const pts = (path && path.length > 2 ? path : [a, b]).map((t) => hexXY(t, W));
  if (env.wrap) { const P = SQ3 * W; for (let i = 1; i < pts.length; i++) pts[i][0] += Math.round((pts[i - 1][0] - pts[i][0]) / P) * P; }
  const out = [];
  for (let s = 1; s < pts.length; s++) {
    const [x0, y0] = pts[s - 1], [x1, y1] = pts[s];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (SQ3 * 0.5)));
    for (let i = s === 1 ? 0 : 1; i <= n; i++) { const t = snap(env, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n); if (t >= 0 && out[out.length - 1] !== t && !out.includes(t)) out.push(t); }
  }
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  return { tiles: out, ax, ay, bx, by, len: Math.hypot(bx - ax, by - ay) };
}

// nearest hex to a world point
export function snap(env, x, y) {
  const { W, H } = env;
  const r = Math.round(y / 1.5); if (r < 0 || r >= H) return -1;
  let q = Math.round(x / SQ3 - 0.5 * (r & 1));
  if (env.wrap) q = ((q % W) + W) % W; else if (q < 0 || q >= W) return -1;
  return r * W + q;
}

function nearestFree(env, x, y, ok) {
  const { W, H } = env;
  let best = -1, bd = Infinity;
  const r0 = Math.round(y / 1.5);
  for (let r = r0 - 2; r <= r0 + 2; r++) {
    if (r < 0 || r >= H) continue;
    const q0 = Math.round(x / SQ3 - 0.5 * (r & 1));
    for (let q = q0 - 2; q <= q0 + 2; q++) {
      let qq = q; if (env.wrap) qq = ((q % W) + W) % W; else if (q < 0 || q >= W) continue;
      const t = r * W + qq; if (!ok(t)) continue;
      const px = SQ3 * (q + 0.5 * (r & 1)), py = 1.5 * r, d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd - 1e-9) { bd = d; best = t; }
    }
  }
  return best;
}

// Orientation frame for a force at `center` facing `toward` (both tiles), wrap-aware:
// forward = unit vector toward the threat, right = forward turned clockwise on screen (y down).
// A deployment drag from (mid - right) to (mid + right) faces `forward` (the drag turned left).
export function facingFrame(env, center, toward) {
  const { W } = env;
  const [ax, ay] = hexXY(center, W); let [bx, by] = hexXY(toward, W);
  if (env.wrap) { const P = SQ3 * W; bx += Math.round((ax - bx) / P) * P; }
  const l = Math.hypot(bx - ax, by - ay);
  const forward = l > 1e-6 ? [(bx - ax) / l, (by - ay) / l] : [0, -1];
  return { ax, ay, bx, by, len: l, forward, right: [-forward[1], forward[0]] };
}
// A line of about n hexes across the approach, `ahead` hexes out from center toward the threat,
// oriented so that the planner's facing points at the threat. Returns [a, b] tiles or null.
export function lineAcross(env, center, toward, n, ahead = 3) {
  if (toward < 0 || center < 0 || n < 2 || toward === center) return null;
  const f = facingFrame(env, center, toward);
  const step = Math.min(ahead * SQ3, Math.max(0, f.len - SQ3));
  const mx = f.ax + f.forward[0] * step, my = f.ay + f.forward[1] * step;
  const half = ((n - 1) * SQ3) / 2;
  const a = snap(env, mx - f.right[0] * half, my - f.right[1] * half), b = snap(env, mx + f.right[0] * half, my + f.right[1] * half);
  if (a < 0 || b < 0 || a === b) return null;
  return [a, b];
}

export function planDeployment(env, units, line, opts = {}) {
  const { W } = env;
  const mode = opts.mode || 'line';
  const density = mode === 'compact' ? 'tight' : opts.density || 'auto';
  const ground = units.filter((u) => !u.air), air = units.filter((u) => u.air);
  const L = lineTiles(env, line[0], line[1], opts.path);
  const dirx = L.len > 0.01 ? (L.bx - L.ax) / L.len : 1, diry = L.len > 0.01 ? (L.by - L.ay) / L.len : 0;
  const mx = (L.ax + L.bx) / 2, my = (L.ay + L.by) / 2;
  const unwrap = (t) => { const [x, y] = hexXY(t, W); if (!env.wrap) return [x, y]; const P = SQ3 * W; return [x + Math.round((mx - x) / P) * P, y]; };
  // facing: away from our city when we know which (a line drawn round a town faces outward),
  // otherwise the drag direction turned left; reverse flips it
  let fx = diry, fy = -dirx;
  if (opts.away != null && opts.away >= 0) { const [hx, hy] = unwrap(opts.away); if ((mx - hx) * fx + (my - hy) * fy < 0) { fx = -fx; fy = -fy; } }
  if (opts.reverse) { fx = -fx; fy = -fy; }
  const invalid = [];
  const front = [];
  for (const t of L.tiles) { if (ground.some((u) => env.passable(t, u)) || !ground.length) front.push(t); else invalid.push(t); }
  if (!front.length) return { slots: new Map(), perHex: new Map(), ranks: 0, overflow: units.map((u) => u.id), invalid, label: 'none', facing: [fx, fy], line: L.tiles, reason: 'no passable ground on that line' };
  // depth: how many ranks may be used
  const roles = new Set(ground.map((u) => u.role));
  const autoDepth = mode === 'depth' ? 3 : roles.has('artillery') || roles.has('logistics') ? 2 : 1;
  const maxDepth = opts.depth === 'auto' || opts.depth == null ? autoDepth : Math.max(1, Math.min(3, opts.depth | 0));
  const keep = opts.keep || new Map();
  // per-hex limit by density; 'auto' lets a short line concentrate up to legal capacity
  const limit = (t) => {
    const cap = Math.max(0, env.capacity(t) - (env.occupied ? env.occupied(t) : 0));
    if (density === 'spread') return Math.min(1, cap);
    if (density === 'balanced') return Math.min(3, cap);
    return cap;
  };
  const used = new Map();                 // tile -> units assigned
  for (const [, t] of keep) used.set(t, (used.get(t) || 0) + 1);
  const rankTiles = [front];
  const taken = new Set(front);
  // the rear direction at each front hex: the curve's local normal on the facing side
  const normalAt = (i) => {
    if (front.length < 3) return [fx, fy];
    const [x0, y0] = unwrap(front[Math.max(0, i - 1)]), [x1, y1] = unwrap(front[Math.min(front.length - 1, i + 1)]);
    const l = Math.hypot(x1 - x0, y1 - y0); if (l < 0.01) return [fx, fy];
    let nx = (y1 - y0) / l, ny = -(x1 - x0) / l;
    if (nx * fx + ny * fy < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };
  const buildRank = (k) => {
    const out = [];
    for (let i = 0; i < front.length; i++) {
      const [x, y] = unwrap(front[i]); const [nx, ny] = normalAt(i);
      const s = nearestFree(env, x - nx * 1.6 * k, y - ny * 1.6 * k, (c) => !taken.has(c) && ground.some((u) => env.passable(c, u)));
      if (s >= 0) { taken.add(s); out.push(s); }
    }
    return out;
  };
  // which rank each unit wants: in 'line' mode everyone stands on the line unless depth > 1
  const want = (u) => (maxDepth === 1 || mode === 'line' && u.role === 'support' ? 0 : Math.min(maxDepth - 1, ROLE_RANK[u.role] ?? 0));
  const todo = ground.filter((u) => !keep.has(u.id));
  const groups = new Map();
  for (const u of todo) { const r = want(u); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(u); }
  const slots = new Map(keep);
  const overflow = [];
  // project positions on the line direction so the matching is crossing-free
  const along = (x, y) => (x - mx) * dirx + (y - my) * diry;
  const MAX_RANKS = 6;
  for (const r of [...groups.keys()].sort((a, b) => a - b)) {
    let pending = groups.get(r).map((u) => { const [x, y] = unwrap(u.tile); return { u, p: along(x, y) }; }).sort((a, b) => a.p - b.p || a.u.id - b.u.id);
    let rank = r;
    while (pending.length && rank < MAX_RANKS) {
      while (rankTiles.length <= rank) rankTiles.push(buildRank(rankTiles.length));
      const tiles = rankTiles[rank];
      // spread units evenly over the rank's free capacity, front to back along the line
      const cap = tiles.map((t) => Math.max(0, limit(t) - (used.get(t) || 0)));
      const total = cap.reduce((s, c) => s + c, 0);
      if (!total) { rank++; continue; }
      const n = Math.min(pending.length, total);
      // even share per hex (a long line gives one each, a short line stacks)
      const share = new Array(tiles.length).fill(0);
      let left = n;
      const open = tiles.map((_, i) => i).filter((i) => cap[i] > 0);
      const per = Math.ceil(n / open.length);
      // fewer units than hexes: spaced evenly from one end of the line to the other
      if (n <= open.length) { for (let k = 0; k < n; k++) share[open[Math.floor(((k + 0.5) * open.length) / n)]] = 1; left = 0; }
      for (let pass = 0; pass < 8 && left > 0; pass++) {
        for (let i = 0; i < tiles.length && left > 0; i++) {
          const room = Math.min(cap[i] - share[i], pass === 0 ? per : cap[i]);
          const take = Math.min(room, left); if (take > 0) { share[i] += take; left -= take; }
        }
      }
      // tiles in line order, units in line order: monotone matching
      // ranks are built in drawing order, so the index follows a curve where a projection would not
      const order = opts.path?.length > 2 ? tiles.map((t, i) => ({ t, i, p: i })) : tiles.map((t, i) => ({ t, i, p: along(...unwrap(t)) })).sort((a, b) => a.p - b.p);
      const place = pending.slice(0, n); pending = pending.slice(n);
      let k = 0;
      for (const o of order) for (let s = 0; s < share[o.i]; s++) { const it = place[k++]; slots.set(it.u.id, o.t); used.set(o.t, (used.get(o.t) || 0) + 1); }
      rank++;
    }
    for (const it of pending) overflow.push(it.u.id);
  }
  // aircraft hover over the middle of the line
  const mid = front[Math.floor(front.length / 2)];
  for (const u of air) slots.set(u.id, mid);
  const perHex = new Map(); for (const u of ground) { const t = slots.get(u.id); if (t != null) perHex.set(t, (perHex.get(t) || 0) + 1); }
  let maxStack = 0, shared = 0; for (const n of perHex.values()) { maxStack = Math.max(maxStack, n); if (n > 1) shared += n; }
  const label = !ground.length ? 'none' : maxStack >= 4 || (maxStack >= 3 && shared >= ground.length * 0.6) ? 'dense' : maxStack >= 2 ? 'concentrated' : 'dispersed';
  return { slots, perHex, ranks: rankTiles.length, overflow, invalid, label, maxStack, facing: [fx, fy], line: front };
}

// role of a unit definition in a deployment
export function deployRole(def) {
  if (def.civilian || def.cat === 'support' || def.cat === 'logistics') return 'logistics';
  if (def.cat === 'artillery') return 'artillery';
  if (def.range >= 3 && def.move === 'infantry') return 'support';
  return 'front';
}

// translate (and optionally rotate) an existing formation so it keeps its shape
export function shiftFormation(env, slots, fromLine, toLine) {
  const { W } = env;
  const [a0x, a0y] = hexXY(fromLine[0], W), [b0x, b0y] = hexXY(fromLine[1], W);
  const [a1x, a1y] = hexXY(toLine[0], W); let [b1x, b1y] = hexXY(toLine[1], W);
  const c0x = (a0x + b0x) / 2, c0y = (a0y + b0y) / 2;
  const ang0 = Math.atan2(b0y - a0y, b0x - a0x), ang1 = Math.atan2(b1y - a1y, b1x - a1x);
  const rot = fromLine[0] === fromLine[1] || toLine[0] === toLine[1] ? 0 : ang1 - ang0;
  const c1x = (a1x + b1x) / 2, c1y = (a1y + b1y) / 2;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const out = new Map(); const used = new Map();
  for (const [id, t] of slots) {
    let [x, y] = hexXY(t, W);
    if (env.wrap) { const P = SQ3 * W; x += Math.round((c0x - x) / P) * P; }
    const dx = x - c0x, dy = y - c0y;
    const nx = c1x + dx * cos - dy * sin, ny = c1y + dx * sin + dy * cos;
    const s = nearestFree(env, nx, ny, (c) => env.passable(c, null) && (used.get(c) || 0) < env.capacity(c));
    if (s >= 0) { out.set(id, s); used.set(s, (used.get(s) || 0) + 1); }
  }
  return out;
}
