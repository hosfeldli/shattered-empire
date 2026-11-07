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
import { UNITS, TERRAIN, BUILDINGS, isWater } from './constants.js';
import { disk, dist } from './hex.js';
import { findPath } from './path.js';

const IDLE_BEFORE = { explore: 1, aggressive: 2, defensive: 3, engineer: 6 };
// Failed destinations are transient navigation hints, never serialized or shared between units.
const exploreFailures = new WeakMap();

const ground = (g, t) => { const ter = g.world.terr[t]; return !isWater(ter) && Number.isFinite(TERRAIN[ter].move); };
const idle = (u) => u.order.kind === 'idle' && !u.path.length && !u.field && !(u.formation && !u.detached);

// how good a hex is to fight from
function cover(g, t) {
  let c = TERRAIN[g.world.terr[t]].def || 0;
  const f = g.fieldworks?.get(t); if (f && f.progress >= 1) c += f.type === 'reinforced' ? 0.6 : 0.4;
  const b = g.tileB[t] >= 0 ? g.buildings.get(g.tileB[t]) : null; if (b && b.type === 'town') c += 0.3;
  return c;
}

export function autonomyStep(g) {
  if (g.autonomyOff) return;                                  // tests of the bare rules
  const claims = new Map();                                   // civ -> tiles already chosen this pass
  const claim = (civ, t) => { const s = claims.get(civ.id) || claims.set(civ.id, new Set()).get(civ.id); s.add(t); };
  const claimed = (civ, t) => claims.get(civ.id)?.has(t);
  for (const u of g.units.values()) {
    const def = UNITS[u.type], civ = g.civs[u.owner];
    if (!civ || !civ.human || def.air) continue;
    if (!idle(u)) { u.idleSince = null; continue; }
    if (u.idleSince == null) u.idleSince = g.time;
    const waited = g.time - u.idleSince;
    if (def.engineer) { if (waited >= IDLE_BEFORE.engineer) engineer(g, civ, u, claim, claimed); continue; }
    if (def.civilian) continue;
    if (u.stance === 'explore' && waited >= IDLE_BEFORE.explore) explore(g, civ, u, claim, claimed);
    else if (u.stance === 'aggressive' && waited >= IDLE_BEFORE.aggressive) hunt(g, civ, u, claim, claimed);
    else if (u.stance === 'defensive' && waited >= IDLE_BEFORE.defensive) settle(g, civ, u, claim, claimed);
  }
}

function explore(g, civ, u, claim, claimed) {
  const ex = civ.explored;
  let failures = exploreFailures.get(u);
  if (!failures) exploreFailures.set(u, failures = new Map());
  for (const [tile, until] of failures) if (until <= g.time) failures.delete(tile);
  const options = [];
  for (const t of disk(u.tile, 46)) {
    if (t === u.tile || claimed(civ, t) || failures.has(t) || !ground(g, t)) continue;
    const d = dist(u.tile, t);
    if (!ex[t]) options.push({ t, score: d });
    else if (d >= 4) options.push({ t, score: 100 + (civ.seenAt?.[t] || 0) * .001 + d * .01 });
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
    for (const near of disk(t, 3)) claim(civ, near);
    return;
  }
  u.idleSince = g.time + 4;
}

function hunt(g, civ, u, claim, claimed) {
  const def = UNITS[u.type];
  let foe = null, fd = Infinity, near = Infinity;
  for (const e of g.units.values()) {
    if (!g.hostile(civ.id, e.owner) || !civ.visible[e.tile] || UNITS[e.type].air) continue;
    const d = dist(u.tile, e.tile); if (d < near) near = d;
    if (d <= 8 && d < fd && !UNITS[e.type].civilian) { fd = d; foe = e; }
  }
  if (foe) {
    // artillery keeps its distance: it moves only until the target is in range
    if (def.cat === 'artillery' && fd <= def.range) return;
    g.orderMove(civ, [u.id], foe.tile, true, 'line', { auth: 'auto' });
    return;
  }
  if (near > 14) return;                                      // nothing about: stay put
  // enemies about but out of reach: take the best cover close by
  const here = cover(g, u.tile);
  let best = -1, bc = here + 0.15;
  for (const t of disk(u.tile, 2)) { if (t === u.tile || !ground(g, t) || claimed(civ, t)) continue; const c = cover(g, t); if (c > bc) { bc = c; best = t; } }
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
    else continue;
    s -= d * 3;
    if (s > score) { score = s; target = b; }
  }
  if (!target) return;
  claim(civ, target.tile);
  if (dist(u.tile, target.tile) <= 1) return;                // already beside it: working
  const spot = disk(target.tile, 1).find((t) => t !== target.tile && ground(g, t)) ?? target.tile;
  g.orderMove(civ, [u.id], spot, false, 'line', { auth: 'auto' });
}
