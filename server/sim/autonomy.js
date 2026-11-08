// Troops and engineers that look after themselves (players' units; AI empires run their own).
// Every two seconds, for units with nothing to do:
//   Explore stance  — head for the nearest ground nobody has seen; once the whole neighbourhood is
//                     known, go and look again at whatever has gone unseen the longest.
//   Defend stance   — hold the ground: never chase; at most step once onto a clearly better
//                     defensive hex right next to where they were sent
//   Attack stance   — hunt enemies they can see nearby, and with enemies about but out of reach,
//                     move to the best cover close by (trenches, woods, hills, a town's streets).
//   Engineers       — roam the territory: repair the most damaged building first, then help raise
//                     construction sites; they stay put if the player has just sent them somewhere.
// Units in a deployed formation keep their places; a player's direct order always wins (the
// automation only picks up units that have been idle for a few seconds).
import { UNITS, TERRAIN, BUILDINGS, isWater, W, H } from './constants.js';
import { disk, dist, center } from './hex.js';
import { hash2 } from './rng.js';
import { findPath } from './path.js';
import { GARRISON } from './combat.js';
import { timedWorks } from './rulesets.js';

const IDLE_BEFORE = { explore: 1, aggressive: 2, defensive: 3, engineer: 6 };
// Failed destinations are transient navigation hints, never serialized or shared between units.
const exploreFailures = new WeakMap();

const ground = (g, t) => { const ter = g.world.terr[t]; return !isWater(ter) && Number.isFinite(TERRAIN[ter].move); };
const idle = (u) => u.order.kind === 'idle' && !u.path.length && !u.field && !(u.formation && !u.detached);

// how good a hex is to fight from
function cover(g, t, civ = null) {
  let c = TERRAIN[g.world.terr[t]].def || 0;
  const f = g.fieldworks?.get(t); if (f && f.progress >= 1) c += f.type === 'reinforced' ? 0.6 : 0.4;
  const b = g.tileB[t] >= 0 ? g.buildings.get(g.tileB[t]) : null; if (b && b.type === 'town') c += 0.3;
  // an own emplacement with free garrison places is the best cover there is (native-v4)
  if (civ && b && b.owner === civ.id && b.done && GARRISON[b.type] && timedWorks(g)) {
    const inside = (g.tileUnits.get(t) || []).filter((id) => g.units.get(id)?.owner === civ.id).length;
    if (inside < GARRISON[b.type].cap) c += GARRISON[b.type].def - 0.6;
  }
  return c;
}

// Ground units bucketed in coarse cells once per pass, so "who is near me" looks at a few cells
// instead of every unit in the game (large battles: thousands of troops).
const CELL = 8;
function unitGrid(g) {
  const cw = Math.ceil(W / CELL), cells = new Map();
  for (const e of g.units.values()) {
    if (UNITS[e.type].air) continue;
    const c = ((((e.tile / W) | 0) / CELL) | 0) * cw + (((e.tile % W) / CELL) | 0);
    const list = cells.get(c); if (list) list.push(e); else cells.set(c, [e]);
  }
  return { cw, ch: Math.ceil(H / CELL), cells };
}
function* unitsNear(grid, t, radius) {
  const span = Math.ceil(radius / CELL) + 1, cq = ((t % W) / CELL) | 0, cr = (((t / W) | 0) / CELL) | 0;
  const seen = new Set();
  for (let r = cr - span; r <= cr + span; r++) {
    if (r < 0 || r >= grid.ch) continue;
    for (let q = cq - span; q <= cq + span; q++) {
      const qq = ((q % grid.cw) + grid.cw) % grid.cw, c = r * grid.cw + qq;
      if (seen.has(c)) continue; seen.add(c);
      const list = grid.cells.get(c); if (list) yield* list;
    }
  }
}

export function autonomyStep(g, slice = 0, slices = 1) {
  if (g.autonomyOff) return;                                  // tests of the bare rules
  const claims = new Map();                                   // civ -> tiles already chosen this pass
  const claim = (civ, t) => { const s = claims.get(civ.id) || claims.set(civ.id, new Set()).get(civ.id); s.add(t); };
  const claimed = (civ, t) => claims.get(civ.id)?.has(t);
  let grid = null;
  const near = () => grid || (grid = unitGrid(g));
  for (const u of g.units.values()) {
    if (slices > 1 && u.id % slices !== slice) continue;        // a share of the units each pass
    const def = UNITS[u.type], civ = g.civs[u.owner];
    if (!civ || !civ.human || def.air) continue;
    if (!idle(u)) { u.idleSince = null; continue; }
    if (u.idleSince == null) u.idleSince = g.time;
    const waited = g.time - u.idleSince;
    if (def.engineer) { if (waited >= IDLE_BEFORE.engineer) engineer(g, civ, u, claim, claimed); continue; }
    if (def.civilian) continue;
    if (u.stance === 'explore' && waited >= IDLE_BEFORE.explore) explore(g, civ, u, claim, claimed);
    else if (u.stance === 'aggressive' && waited >= IDLE_BEFORE.aggressive) hunt(g, civ, u, claim, claimed, near());
    else if (u.stance === 'defensive' && waited >= IDLE_BEFORE.defensive) settle(g, civ, u, claim, claimed);
  }
}

function explore(g, civ, u, claim, claimed) {
  const ex = civ.explored;
  let failures = exploreFailures.get(u);
  if (!failures) exploreFailures.set(u, failures = new Map());
  for (const [tile, until] of failures) if (until <= g.time) failures.delete(tile);
  // Each explorer favours its own heading (changing every few minutes) and a little randomness per
  // destination, so a group spreads out across the map instead of all walking to the same frontier.
  const epoch = Math.floor(g.time / 180);
  const heading = hash2(u.id, epoch, 911) * Math.PI * 2;
  const [ux, uz] = center(u.tile);
  const options = [];
  for (const t of disk(u.tile, 46)) {
    if (t === u.tile || claimed(civ, t) || failures.has(t) || !ground(g, t)) continue;
    const d = dist(u.tile, t);
    const [tx, tz] = center(t);
    let dx = tx - ux; if (dx > W * 0.866) dx -= W * 1.732; else if (dx < -W * 0.866) dx += W * 1.732;
    const off = Math.abs(((Math.atan2(tz - uz, dx) - heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const jitter = 0.65 + 0.7 * hash2(u.id, t, epoch);
    if (!ex[t]) options.push({ t, score: d * jitter + off * 5 });
    else if (d >= 4) options.push({ t, score: 100 + (civ.seenAt?.[t] || 0) * .001 + d * .01 + off * 2 });
  }
  options.sort((a, b) => a.score - b.score || a.t - b.t);
  // Never issue an impossible or partial order: doing so leaves the unit standing on the
  // same shoreline with a non-idle order forever. Limit work per autonomy pass.
  for (const { t } of options.slice(0, 8)) {
    const path = findPath(g, civ, u.tile, t, u.type, 1200);
    if (!path || path.partial) { failures.set(t, g.time + 45); continue; }
    const r = g.orderMove(civ, [u.id], t, false, 'line', { auth: 'auto' });
    const result = r?.reply?.order || r?.order;
    if (r?.error || result?.unreachable || result?.partial) {
      // Return to idle if the authoritative route changed between checking and ordering.
      u.order = { kind: 'idle' }; u.path = []; u.field = false;
      failures.set(t, g.time + 45);
      continue;
    }
    claim(civ, t);
    for (const near of disk(t, 6)) claim(civ, near);       // explorers keep well apart
    return;
  }
  u.idleSince = g.time + 4;
}

function hunt(g, civ, u, claim, claimed, grid) {
  const def = UNITS[u.type];
  let foe = null, fd = Infinity, near = Infinity;
  for (const e of unitsNear(grid, u.tile, 15)) {
    if (!g.hostile(civ.id, e.owner) || !civ.visible[e.tile] || UNITS[e.type].air) continue;
    const d = dist(u.tile, e.tile); if (d < near) near = d;
    if (d <= 8 && d < fd && !UNITS[e.type].civilian) { fd = d; foe = e; }
  }
  if (foe) {
    // pinned infantry out of cover go to ground in the best cover close by, away from the fire
    if (def.move === 'infantry' && (u.supp || 0) > 55 && cover(g, u.tile, civ) < 0.3) {
      let best = -1, bc = cover(g, u.tile, civ) + 0.1;
      for (const t of disk(u.tile, 1)) { if (t === u.tile || !ground(g, t) || claimed(civ, t) || dist(t, foe.tile) < fd) continue; const c = cover(g, t, civ); if (c > bc) { bc = c; best = t; } }
      if (best >= 0) { claim(civ, best); g.orderMove(civ, [u.id], best, false, 'line', { auth: 'auto' }); return; }
    }
    // artillery threatened at close quarters falls back two to three hexes, away from the threat,
    // to keep firing from behind the line; otherwise it moves only until the target is in range
    if (def.cat === 'artillery' && fd <= 2 && def.range > 2) {
      let best = -1, bd = -1;
      for (const t of disk(u.tile, 3)) { if (!ground(g, t) || claimed(civ, t)) continue; const d = dist(t, foe.tile); if (d > bd && d <= def.range) { bd = d; best = t; } }
      if (best >= 0 && bd > fd) { claim(civ, best); g.orderMove(civ, [u.id], best, false, 'line', { auth: 'auto' }); return; }
    }
    if (def.cat === 'artillery' && fd <= def.range) return;
    g.orderMove(civ, [u.id], foe.tile, true, 'line', { auth: 'auto' });
    return;
  }
  if (near > 14) return;                                      // nothing about: stay put
  // enemies about but out of reach: take the best cover close by
  const here = cover(g, u.tile, civ);
  let best = -1, bc = here + 0.15;
  for (const t of disk(u.tile, 2)) { if (t === u.tile || !ground(g, t) || claimed(civ, t)) continue; const c = cover(g, t, civ); if (c > bc) { bc = c; best = t; } }
  if (best >= 0) { claim(civ, best); g.orderMove(civ, [u.id], best, false, 'line', { auth: 'auto' }); }
}

// Defend: once per place they are sent, take the best defensive hex adjacent (if clearly better)
function settle(g, civ, u, claim, claimed) {
  if (u.settledAt === u.tile || u.settledFrom === u.tile) return;
  const here = cover(g, u.tile);
  let best = -1, bc = here + 0.15;
  for (const t of disk(u.tile, 1)) { if (t === u.tile || !ground(g, t) || claimed(civ, t)) continue; const c = cover(g, t); if (c > bc) { bc = c; best = t; } }
  if (best < 0) { u.settledAt = u.tile; return; }
  claim(civ, best); u.settledFrom = u.tile; u.settledAt = best;
  g.orderMove(civ, [u.id], best, false, 'line', { auth: 'auto' });
}

function engineer(g, civ, u, claim, claimed) {
  // first the most damaged (and burning) buildings, then construction sites, all within reach
  let target = null, score = -Infinity;
  for (const b of g.buildings.values()) {
    if (b.owner !== civ.id || claimed(civ, b.tile)) continue;
    const d = dist(u.tile, b.tile); if (d > 25) continue;
    let s;
    if (b.done && (b.hp < b.maxHp * 0.95 || b.fire > 0)) s = 100 + (1 - b.hp / b.maxHp) * 100 + (b.fire > 0 ? 80 : 0);
    else if (!b.done && b.funded !== false && !b.waiting) s = 40 + (BUILDINGS[b.type].time || 20) * 0.5;
    else if (b.done && b.works && !b.works.paused) s = 60 + Math.min(40, b.works.left * 0.5);      // timed upgrade works (native-v4)
    else continue;
    s -= d * 3;
    if (s > score) { score = s; target = b; }
  }
  if (!target) { spread(g, civ, u, claim, claimed); return; }
  claim(civ, target.tile);
  if (dist(u.tile, target.tile) <= 1) return;                // already beside it: working
  const spot = disk(target.tile, 1).find((t) => t !== target.tile && ground(g, t)) ?? target.tile;
  g.orderMove(civ, [u.id], spot, false, 'line', { auth: 'auto' });
}

// Engineers with nothing to repair or build spread across the nation: every city keeps at least one
// where possible, and spare engineers go to the cities with the most construction and damage.
function spread(g, civ, u, claim, claimed) {
  const cities = [...g.cities.values()].filter((c) => c.owner === civ.id);
  if (cities.length < 2) return;
  const nearest = (t) => { let best = null, bd = Infinity; for (const c of cities) { const d = dist(t, c.tile); if (d < bd) { bd = d; best = c; } } return best; };
  const count = new Map(cities.map((c) => [c.id, 0]));
  for (const e of g.units.values()) if (e.owner === civ.id && UNITS[e.type].engineer) { const c = nearest(e.tile); count.set(c.id, count.get(c.id) + 1); }
  const home = nearest(u.tile);
  if (count.get(home.id) <= 1) return;                       // the only engineer here: stay
  // need: buildings under construction or damaged, per engineer already there
  const need = new Map(cities.map((c) => [c.id, 0.5]));
  for (const b of g.buildings.values()) {
    if (b.owner !== civ.id || (b.done && b.hp >= b.maxHp * 0.95)) continue;
    const c = nearest(b.tile); need.set(c.id, need.get(c.id) + 1);
  }
  let best = null, bs = -Infinity;
  for (const c of cities) {
    if (c === home || claimed(civ, c.tile)) continue;
    const have = count.get(c.id);
    const s = (have === 0 ? 100 : 0) + need.get(c.id) / (have + 1) - dist(u.tile, c.tile) * 0.02;
    if (s > bs) { bs = s; best = c; }
  }
  const homeScore = need.get(home.id) / count.get(home.id);
  if (!best || (count.get(best.id) > 0 && bs <= homeScore + 0.5)) return;
  claim(civ, best.tile);
  const spot = disk(best.tile, 1).find((t) => t !== best.tile && ground(g, t)) ?? best.tile;
  g.orderMove(civ, [u.id], spot, false, 'line', { auth: 'auto' });
}
