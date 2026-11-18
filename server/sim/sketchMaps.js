// Map-builder sketches (the Unity menu's Map builder, map id 'custom'). A sketch is a coarse paint of the
// battlefield, not the final map: a grid of three classes (ocean, land, mountain) over the whole world
// rectangle plus the bases the player placed. The world generator honours the classes and fills in the
// rest naturally: noisy coastlines and beaches, rolling lowland and knolls, foothills rising into the
// painted ranges with peaks in their hearts, then the normal climate, hydrology (rivers and lakes),
// forests, resources (world.finishTerrain), and cities, outposts and roads around the placed bases
// (actionMap.buildActionMap). Every placed base is a start; with fewer players than bases the spare
// ones stay neutral city ruins (the seating is chooseStarts over sketchMetrics, which the client's lobby
// preview reproduces exactly from the sketch alone).
//
// Wire format (create { map: 'custom', sketch } and the lobby's { t: 'map', map: 'custom', sketch }):
//   { v: 1, name, size: 'small'|'medium'|'large'|'huge', w, h, cells, bases: [[u, v], ...] }
//   cells: run-length rows of the grid, row-major from the north-west corner: a class letter
//          (o ocean, l land, m mountain) followed by its run length, e.g. "o130l60m4o2..." (sum = w * h).
//   bases: 2..8 normalised [u, v] points (u west → east, v north → south), on land or mountain.
// Grid cell (col, row) covers u ∈ [col / w, (col + 1) / w) and v ∈ [row / h, (row + 1) / h), like the
// lobby preview grid (actionMap.mapPreview).
import { W, H, N } from './constants.js';
import { fbm } from './rng.js';
import { pointUV } from './authoredMaps.js';

export const SKETCH_SIZES = { small: 104, medium: 152, large: 208, huge: 232 };   // = matches.js ACTION_SIZES
export const SKETCH_LIMITS = { minGrid: 16, maxGrid: 128, minBases: 2, maxBases: 8, maxCells: 40000, name: 32 };
const CLASS = 'olm';   // 0 ocean, 1 land, 2 mountain

const fail = (why) => { throw new Error(`Map sketch: ${why}`); };

/** Run-length encoding of a class grid (Uint8Array of 0/1/2). */
export function encodeCells(grid) {
  let out = '';
  for (let i = 0; i < grid.length;) {
    let j = i;
    while (j < grid.length && grid[j] === grid[i]) j++;
    out += CLASS[grid[i]] + (j - i);
    i = j;
  }
  return out;
}

/** Decode a run-length cell string into a grid of n cells; throws on anything malformed. */
export function decodeCells(cells, n) {
  if (typeof cells !== 'string' || !cells.length || cells.length > SKETCH_LIMITS.maxCells) fail('cells must be a run-length string');
  const grid = new Uint8Array(n);
  let k = 0;
  const re = /([olm])(\d{1,6})/y;
  let at = 0;
  while (at < cells.length) {
    re.lastIndex = at;
    const m = re.exec(cells);
    if (!m) fail('cells hold an unknown class or run');
    const run = +m[2];
    if (run < 1 || k + run > n) fail('cell runs do not add up to the grid');
    grid.fill(CLASS.indexOf(m[1]), k, k + run);
    k += run; at = re.lastIndex;
  }
  if (k !== n) fail('cell runs do not add up to the grid');
  return grid;
}

const cellOf = (sk, u, v) => Math.min(sk.h - 1, Math.max(0, Math.floor(v * sk.h))) * sk.w + Math.min(sk.w - 1, Math.max(0, Math.floor(u * sk.w)));

/**
 * Validate and canonicalise a sketch from a client (lobby host or New Skirmish). Returns a fresh object
 * holding only the known fields (the grid re-encoded, base points rounded); throws a readable Error.
 */
export function parseSketch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('missing');
  const { minGrid, maxGrid, minBases, maxBases, name: nameMax } = SKETCH_LIMITS;
  const w = raw.w, h = raw.h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < minGrid || h < minGrid || w > maxGrid || h > maxGrid) fail(`the grid must be ${minGrid}..${maxGrid} cells a side`);
  const size = typeof raw.size === 'string' && Object.hasOwn(SKETCH_SIZES, raw.size) ? raw.size : null;
  if (!size) fail('unknown map size');
  const grid = decodeCells(raw.cells, w * h);
  let land = 0;
  for (const c of grid) if (c === 1) land++;
  if (land < grid.length * .08) fail('paint more land (at least a tenth of the map)');
  if (!Array.isArray(raw.bases) || raw.bases.length < minBases || raw.bases.length > maxBases) fail(`place ${minBases} to ${maxBases} bases`);
  const sk = { v: 1, name: '', size, w, h, cells: encodeCells(grid), bases: [] };
  for (const b of raw.bases) {
    const u = Array.isArray(b) ? b[0] : b?.u, v = Array.isArray(b) ? b[1] : b?.v;
    if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) fail('a base is off the map');
    const p = [+Math.min(.98, Math.max(.02, u)).toFixed(4), +Math.min(.98, Math.max(.02, v)).toFixed(4)];
    if (grid[cellOf(sk, p[0], p[1])] === 0) fail('a base stands in the sea');
    sk.bases.push(p);
  }
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, nameMax).trim() : '';
  sk.name = name || 'Custom map';
  // 2026-11-18 (MAP_BUILDER_TEAMS.md): optional team ownership of the bases, one entry per base: a team index
  // (0-based, the lobby's team = seat / team size) or -1 for a base that stays neutral. Absent: automatic seating.
  if (raw.owners != null) {
    if (!Array.isArray(raw.owners) || raw.owners.length !== sk.bases.length) fail('owners must give one team per base');
    if (!raw.owners.every((t) => Number.isInteger(t) && t >= -1 && t < maxBases)) fail(`a base owner must be a team 1..${maxBases} or neutral`);
    if (raw.owners.some((t) => t >= 0)) sk.owners = raw.owners.slice();
  }
  return sk;
}

/** Team n (0-based) as the lobby names it. */
const teamName = (t, ts, ffa) => (ffa ? `Player ${t + 1}` : `Team ${t + 1}`);

/**
 * Why a sketch's base ownership cannot seat these slots (a readable sentence), or null. `slots`: the lobby seats
 * (closed ones are left out), team = seat / teamSize. Every team with an active seat needs at least as many bases
 * assigned to it as it has active seats (each seat keeps at least one base); a base may not name a team the
 * format does not have.
 */
export function baseOwnersProblem(sk, slots, teamSize = 1) {
  if (!sk?.owners) return null;
  const ts = Math.max(1, teamSize | 0), teams = Math.ceil(slots.length / ts), ffa = ts === 1 && teams > 2;
  const seats = new Array(teams).fill(0), bases = new Array(teams).fill(0);
  slots.forEach((s, i) => { if (!s.closed) seats[Math.floor(i / ts)]++; });
  for (const [b, t] of sk.owners.entries()) {
    if (t < 0) continue;
    if (t >= teams) return `Base ${b + 1} belongs to ${teamName(t, ts, ffa)}, which this format does not have: reassign it in the team window.`;
    bases[t]++;
  }
  for (let t = 0; t < teams; t++)
    if (seats[t] > bases[t]) return `${teamName(t, ts, ffa)} has ${seats[t]} player${seats[t] === 1 ? '' : 's'} but ${bases[t] ? 'only ' + bases[t] : 'no'} starting base${bases[t] === 1 ? '' : 's'}: give every player a base in the team window.`;
  return null;
}

/**
 * The sketch the simulation receives: base owners renumbered like the teams when closed seats leave
 * (matches.js dropClosed keeps teams in order); a base of a team with no seat left stays neutral.
 */
export function sketchForTeams(sk, slots, teamSize = 1) {
  if (!sk?.owners) return sk;
  const ts = Math.max(1, teamSize | 0), order = [];
  slots.forEach((s, i) => { const t = Math.floor(i / ts); if (!s.closed && !order.includes(t)) order.push(t); });
  return { ...sk, owners: sk.owners.map((t) => (t < 0 ? -1 : order.indexOf(t))) };
}

/**
 * Which base each civ starts on when the sketch assigns bases to teams: the k-th civ of team T (in civ order)
 * takes T's k-th base (in base order); a team's surplus bases and neutral bases stay neutral city ruins.
 * Returns civ -> base index; throws when a civ has no base left (baseOwnersProblem refuses that earlier).
 */
export function ownedStarts(owners, teams) {
  const next = new Map();
  return teams.map((team, civ) => {
    const from = next.get(team) ?? 0;
    const b = owners.findIndex((t, i) => i >= from && t === team);
    if (b < 0) throw new Error(`This custom map gives no starting base to player ${civ + 1} (team ${team + 1}).`);
    next.set(team, b + 1);
    return b;
  });
}

/** The class grid of a canonical sketch. */
export const sketchGrid = (sk) => decodeCells(sk.cells, sk.w * sk.h);

/**
 * Seating metrics of the placed bases, measured on the sketch grid (so the client's preview seats a
 * lobby exactly as the match will, before any world exists): steps[i][j], 4-neighbour steps over land
 * cells between bases i and j (1e4: no land route), and reach (all 0: no neutral bases are known yet).
 * Ported to the client as MapSketch.Metrics (MapBuilder.cs).
 */
export function sketchMetrics(sk, grid = sketchGrid(sk)) {
  const n = sk.w * sk.h, cells = sk.bases.map(([u, v]) => cellOf(sk, u, v));
  const steps = cells.map((from) => {
    const d = new Int32Array(n).fill(-1), queue = new Int32Array(n);
    let head = 0, tail = 0;
    d[from] = 0; queue[tail++] = from;
    while (head < tail) {
      const c = queue[head++], x = c % sk.w, y = (c / sk.w) | 0;
      const next = [x > 0 ? c - 1 : -1, x < sk.w - 1 ? c + 1 : -1, y > 0 ? c - sk.w : -1, y < sk.h - 1 ? c + sk.w : -1];
      for (const m of next) if (m >= 0 && d[m] < 0 && grid[m] === 1) { d[m] = d[c] + 1; queue[tail++] = m; }
    }
    return cells.map((t) => (d[t] < 0 ? 1e4 : d[t]));
  });
  return { steps, reach: cells.map(() => 0) };
}

/**
 * The lobby preview of a sketch in mapPreview's format (for tools and tests; the Unity client draws the
 * same thing itself from the sketch): coast cells show as shallows, the flanks of a range as hills.
 */
export function sketchPreview(sk) {
  const grid = sketchGrid(sk), cells = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const x = i % sk.w, y = (i / sk.w) | 0;
    let land = false, mountain = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= sk.w || ny >= sk.h) continue;
      const c = grid[ny * sk.w + nx]; if (c) land = true; if (c === 2) mountain = true;
    }
    cells[i] = grid[i] === 0 ? (land ? 1 : 0) : grid[i] === 2 ? 6 : mountain ? 5 : 2;
  }
  const m = sketchMetrics(sk, grid);
  return { w: sk.w, h: sk.h, aspect: +(Math.sqrt(3) / 1.5).toFixed(4),
    classes: ['deep', 'shallow', 'open', 'forest', 'marsh', 'hills', 'mountains', 'peaks', 'river', 'ford', 'road', 'bridge'],
    cells: Buffer.from(cells).toString('base64'), starts: sk.bases.map(([u, v], i) => ({ seat: i, u, v, name: `Base ${i + 1}` })),
    bases: [], outposts: [], startSteps: m.steps, startReach: m.reach, ...(sk.owners && { startOwners: sk.owners }) };
}

// ---------------------------------------------------------------------------------------------------
// Painting. The class grid is blurred into two soft fields (land, mountain) that are sampled per hex at
// a slightly noise-warped point, so a painted edge becomes a natural coastline or mountain front that
// still follows the paint to within about a cell. The world seed drives the noise: one seed, one world.
function blurred(grid, sk, test) {
  let f = Float32Array.from(grid, (c) => (test(c) ? 1 : 0));
  for (let pass = 0; pass < 2; pass++) {
    const g = new Float32Array(f.length);
    for (let y = 0; y < sk.h; y++) for (let x = 0; x < sk.w; x++) {
      let s = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = Math.min(sk.w - 1, Math.max(0, x + dx)), ny = Math.min(sk.h - 1, Math.max(0, y + dy));
        const k = (dx ? 1 : 2) * (dy ? 1 : 2);
        s += f[ny * sk.w + nx] * k; wsum += k;
      }
      g[y * sk.w + x] = s / wsum;
    }
    f = g;
  }
  return f;
}

function sample(f, sk, gx, gy) {
  gx = Math.min(sk.w - 1, Math.max(0, gx)); gy = Math.min(sk.h - 1, Math.max(0, gy));
  const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(sk.w - 1, x0 + 1), y1 = Math.min(sk.h - 1, y0 + 1);
  const fx = gx - x0, fy = gy - y0;
  const a = f[y0 * sk.w + x0], b = f[y0 * sk.w + x1], c = f[y1 * sk.w + x0], d = f[y1 * sk.w + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

const smooth = (t) => t * t * (3 - 2 * t);
const SQ3 = Math.sqrt(3);

/** Paint the sketch's relief into world `w` (World.generate then runs finishTerrain). */
export function paintSketchWorld(w, raw) {
  const sk = parseSketch(raw), grid = sketchGrid(sk), seed = w.seed | 0;
  const landF = blurred(grid, sk, (c) => c > 0), mountF = blurred(grid, sk, (c) => c === 2);
  // hexes per sketch cell: noise scales follow it, so a coarse sketch on a huge map stays as natural
  const cell = Math.max(1, W / sk.w);
  const warp = .55;   // in cells
  let land = 0;
  for (let i = 0; i < N; i++) {
    const q = i % W, r = (i / W) | 0, x = SQ3 * (q + .5 * (r & 1)), z = 1.5 * r;
    const [u, v] = pointUV({ x, z });
    const wx = (fbm(x / (5 * cell), z / (5 * cell), seed + 101, 3) - .5) * 2 * warp;
    const wz = (fbm(x / (5 * cell), z / (5 * cell), seed + 102, 3) - .5) * 2 * warp;
    const gx = u * sk.w - .5 + wx, gy = v * sk.h - .5 + wz;
    // coastline: the land field's half level, roughened by fine noise
    const coast = sample(landF, sk, gx, gy) - .5 + (fbm(x / 3.2, z / 3.2, seed + 103, 3) - .5) * .32;
    let e;
    if (coast < 0) e = Math.max(-.6, -.02 + coast * 1.5);
    else {
      // lowland: gentle swells, scattered knolls (cover), beaches where it meets the sea
      const swell = (fbm(x / 9, z / 9, seed + 104, 4) - .5) * .16;
      const knoll = Math.min(.26, Math.max(0, fbm(x / 4.5, z / 4.5, seed + 105, 2) - .64) * 2.4);
      const inland = smooth(Math.min(1, coast / .2));
      e = Math.max(.012, .015 + (.13 + swell + knoll - .015) * inland);
    }
    // mountains: foothills climb from about a cell outside the paint; the heart of a range turns to peaks
    const mf = sample(mountF, sk, gx, gy) + (fbm(x / 4, z / 4, seed + 106, 3) - .5) * .28;
    if (mf > .1 && coast > -.08) {
      const t = Math.min(1.45, (mf - .1) / .36);
      const crest = Math.max(0, mf - .84) * (1.1 + fbm(x / 3, z / 3, seed + 107, 2) * 1.2);
      e = Math.max(e, Math.min(.97, .27 + t * .27 + crest));
    }
    w.elev[i] = e;
    if (e >= 0) land++;
    w.stab[i] = 1; w.rate[i] = 0; w.plate[i] = 0;
  }
  w.sketch = sk;
  // the natural river threshold drains a compact battlefield; a broad painted landmass would be a maze of rivers
  w.flowScale = 1 / Math.min(5, Math.max(1, land / 2500));
  w.style = 'continents';
  w.volcanoes = []; w.riftTiles = []; w.faultTiles = [];
  return w;
}

