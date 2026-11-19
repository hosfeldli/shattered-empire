// AI works (2026-11-18, docs/gameplay-overhaul/AI_WORKS.md): field defenses, trench lines and perimeter upgrades for
// the action-mode AI. Called from actionAI.planActionAI every plan tick (aiWorks) and from its Defending branch
// (aiEmergencyWorks). Every structure goes through the player commands (constructDefense, with a dry run first, and
// trenchLine), so the server's placement rules apply unchanged: own or neutral ground, the road offset (only sandbag
// barricades on roads), the 2-hex snap, the x3 ring-of-influence surcharge.
//
// Plan, per AI base:
//  * Threat axes, cached per base (recomputed every AI_WORKS.recompute s, or when an attack comes from a new
//    direction): bearings to known (or presumed) enemy bases, recorded attack directions, roads leaving the base and
//    hostile territory nearby, clustered into 1-4 axes by difficulty. Along each axis the first chokepoint (a bridge,
//    or a narrow neck of passable ground between water and mountains) within reach moves the anchor forward.
//  * Defenses: a quota per axis (difficulty, phase, recent attacks) filled with a mix by era and by what the enemy
//    fields (watchtowers and bunkers early, anti-armour emplacements against armour, an AA battery against air, a
//    sandbag barricade on a road crossing the axis). Lost structures fall under quota and are rebuilt.
//  * Trenches: a short connected line across the main axis in front of each base, lines at forward outposts, and
//    lines just behind a front that has stopped moving (sooner in the late game).
//  * Upgrades: era levels of the AI's own field defenses, the base perimeter bought, rebuilt and upgraded.
// Budget: a wallet that accrues a share of materials income (difficulty x phase x threat; more when the army is at
// its capacity, when production has nowhere to go). Spending also keeps the stock left after production commitments
// above the reserves buildArmy saves for (a new base, the next era), and stops while the army is below 60% of its floor.
// Deterministic: no randomness, ordered scans only; cost bounded (a works pass every few seconds, a few dry runs).
import { T, W, H, isWater } from './constants.js';
import { disk, dist as hexDist, idx } from './hex.js';
import { ACTION_BUILDINGS, ACTION_UNITS, CITY_DEFENSES, TIERS } from './actionDefinitions.js';
import { armyCapacity, constructDefense, fieldCost, fortifyBase, headquarters, openSlots, settlementCost, trenchLine, upgradeBuilding,
  upgradeDefenses } from './actionBases.js';
import { productionCommitment } from './actionProduction.js';
import { centerOf, distance, dxBetween, tileAt, wrapX } from './actionNavigation.js';

const LEVEL = { easy: 0, normal: 1, hard: 2, expert: 3, brutal: 4 };
export const AI_WORKS = {
  enabled: true,
  share: [.025, .055, .075, .08, .085],        // wallet: share of materials income, by difficulty level
  wallet: [220, 420, 560, 680, 800],        // wallet cap (+120 per base)
  axes: [1, 2, 3, 3, 4],                    // threat axes kept per base
  perAxis: [1, 2, 3, 4, 5],                 // armed structures on the main axis (others one fewer, at least one)
  baseCap: [2, 4, 7, 9, 11],                // armed structures per base, all axes
  trench: [0, 4, 5, 5, 6],                  // hexes in a trench line
  frontStall: [150, 75, 55, 45, 35],        // s a front holds still before it digs in (x .65 from minute 15)
  period: [10, 6, 5, 4, 4],                 // s between works passes
  emergency: [50, 35, 28, 24, 20],          // s between emergency builds when a base is attacked
  emergencyMax: [1, 2, 3, 3, 4],            // armed structures near an attacked base before emergency builds stop
  start: [420, 300, 240, 210, 180],         // s before planned (non-emergency) works begin
  recompute: 120,                           // s between threat-axis recomputations per base
  starve: [.6, .6, .6, .6, .85],            // no planned works below this share of the army floor (balance pass 2026-11-18:
                                            // brutal fortifies on top of a full army, not instead of one)
  keep: [[0, 0], [0, 0], [0, 0], [0, 0], [300, 350]],   // materials / energy left in stock for production (balance pass:
                                            // brutal's works spend from times of plenty, never the stock its facilities draw on)
  tries: 8, builds: 2,                      // dry runs and real orders per works pass
};
const levelOf = (civ) => LEVEL[civ.difficulty] ?? 1;
const armyFloor = (game) => Math.min(40, 8 + Math.floor(game.time / 60));   // as actionAI.armyFloor
const TWO_PI = Math.PI * 2;
const angDiff = (a, b) => { const d = Math.abs(((a - b) % TWO_PI + TWO_PI) % TWO_PI); return Math.min(d, TWO_PI - d); };
const bearing = (from, to) => Math.atan2(dxBetween(from.x, to.x), to.z - from.z);
const along = (o, a, d, side = 0) => ({ x: wrapX(o.x + Math.sin(a) * d + Math.cos(a) * side), z: o.z + Math.cos(a) * d - Math.sin(a) * side });
const isVehicle = (u) => ['wheeled', 'tracked'].includes(ACTION_UNITS[u.type]?.move) && !ACTION_UNITS[u.type]?.air;
const armed = (b) => { const d = ACTION_BUILDINGS[b.type]; return !!d?.field && !!d.attack && !b.perimeterSlot; };
const round2 = (v) => Math.round(v * 100) / 100;

function state(game, civ, p) {
  const w = p.works ??= { at: game.time, next: 0, wallet: 0, spent: 0, built: 0, dug: 0, armor: 0, attacks: [], bases: {}, front: null, frontAt: 0 };
  return w;
}

/** The enemy bases this civ knows of (or presumes: unscouted rival capitals), as points. */
function enemyBases(game, civ) {
  const out = [];
  for (const s of civ.siteIntel.values()) if (s.hq && s.owner >= 0 && game.hostile(civ.id, s.owner) && game.civs[s.owner]?.alive) out.push(s);
  for (const c of game.civs) {
    const cap = game.sites[c.id];
    if (c.alive && game.hostile(civ.id, c.id) && cap && !civ.siteIntel.has(cap.id)) out.push(cap);
  }
  return out;
}

const passable = (w, t) => t >= 0 && !isWater(w.terr[t]) && !w.lake[t] && w.terr[t] < T.MOUNTAIN && (!w.river[t] || !!w.road[t]);

/** The first chokepoint along a bearing from a base: a bridge, or a hex whose 2-hex neighbourhood is mostly impassable. */
function chokeAlong(game, civ, s, a) {
  const w = game.world;
  for (let d = 4.4; d <= 11; d += 1.1) {
    const p = along(s, a, d), t = tileAt(p.x, p.z);
    if (t < 0) return null;
    if (w.owner[t] >= 0 && w.owner[t] !== civ.id) return null;
    if (w.river[t] && w.road[t]) return { d, t, kind: 'bridge' };
    if (!passable(w, t)) continue;
    let open = 0;
    const around = disk(t, 2);
    for (const n of around) if (passable(w, n)) open++;
    if (open <= around.length * .6) return { d, t, kind: 'pass' };
  }
  return null;
}

/** Threat axes of a base: bearings clustered and weighted (see the header). JSON-friendly (saved with the plan). */
export function threatAxes(game, civ, s, w = civ.aiPlan?.works || { attacks: [] }, level = levelOf(civ)) {
  const cands = [];
  for (const e of enemyBases(game, civ)) {
    const d = distance(s, e);
    if (d > 1) cands.push({ a: bearing(s, e), w: 2.2 * Math.min(1, 24 / Math.max(8, d)), kind: 'enemy' });
  }
  for (const r of w.attacks) if (r.site === s.id) cands.push({ a: r.a, w: 1.7 * Math.exp(-(game.time - r.t) / 300), kind: 'attack' });
  const world = game.world, sectors = new Array(6).fill(0);
  for (const t of disk(s.tile, 8)) {
    const o = world.owner[t], ring = hexDist(s.tile, t);
    if (ring === 4 && world.road[t]) cands.push({ a: bearing(s, centerOf(t)), w: .6, kind: 'road', road: t });
    if (o >= 0 && o !== civ.id && game.hostile(civ.id, o)) sectors[Math.floor(((bearing(s, centerOf(t)) + TWO_PI) % TWO_PI) / (Math.PI / 3)) % 6]++;
  }
  sectors.forEach((n, i) => { if (n) cands.push({ a: (i + .5) * Math.PI / 3, w: Math.min(1.5, n * .12), kind: 'border' }); });
  if (!cands.length) cands.push({ a: bearing(s, centerOf(idx(W >> 1, H >> 1))), w: .5, kind: 'centre' });
  cands.sort((x, y) => y.w - x.w || x.a - y.a);
  const axes = [];
  for (const c of cands) {
    const near = axes.find((x) => angDiff(x.a, c.a) < .62);
    if (near) { near.w += c.w; if (!near.kinds.includes(c.kind)) near.kinds.push(c.kind); if (c.road != null && near.road == null) near.road = c.road; }
    else axes.push({ a: c.a, w: c.w, kinds: [c.kind], road: c.road ?? null });
  }
  axes.sort((x, y) => y.w - x.w || x.a - y.a);
  // a road-only axis is worth defending only when nothing threatens from elsewhere (or for the stronger AIs)
  const kept = axes.filter((x, i) => i === 0 || x.kinds.some((k) => k !== 'road') || level >= 2).slice(0, AI_WORKS.axes[level]);
  const ring = 4.4 + .45 * ((s.tier || 1) - 1);
  for (const x of kept) {
    const choke = chokeAlong(game, civ, s, x.a);
    x.choke = choke ? { d: round2(choke.d), kind: choke.kind } : null;
    x.d = round2(choke && choke.d <= 8.8 ? Math.max(ring, choke.d - .9) : ring);
    x.a = round2(x.a); x.w = round2(x.w);
  }
  return kept;
}

/** Records where attacks on this civ's bases and outposts came from (bearing from the site). */
function recordAttacks(game, civ, w, sites, enemy) {
  for (const s of sites) {
    const near = enemy.filter((u) => !ACTION_UNITS[u.type].air && distance(u, s) < 7);
    if (near.length < (s.slots ? 1 : 2)) continue;
    const c = { x: s.x + near.reduce((n, u) => n + dxBetween(s.x, u.x), 0) / near.length, z: near.reduce((n, u) => n + u.z, 0) / near.length };
    const a = round2(bearing(s, c));
    const last = w.attacks.find((r) => r.site === s.id && angDiff(r.a, a) < .5);
    if (last) { last.t = game.time; continue; }
    w.attacks.unshift({ site: s.id, a, t: game.time });
    const plan = w.bases[s.id];
    if (plan && !plan.axes.some((x) => angDiff(x.a, a) < .62)) plan.at = -1e9;   // a new direction: recompute the axes
  }
  w.attacks = w.attacks.filter((r) => game.time - r.t < 600).slice(0, 16);
}

// ---- budget ------------------------------------------------------------------------------------------------------

function budget(game, civ, p, w, bases, own) {
  const level = levelOf(civ), dt = Math.max(0, Math.min(30, game.time - w.at));
  w.at = game.time;
  const minute = game.time / 60;
  const phase = minute < 5 ? .3 : minute < 10 ? .6 : minute < 15 ? 1 : minute < 20 ? 1.15 : 1.2;
  const threatened = w.attacks.some((r) => game.time - r.t < 150);
  const cap = armyCapacity(game, civ), full = cap.limit <= cap.used + cap.queued + 6;
  const share = AI_WORKS.share[level] * phase * (threatened ? 1.3 : 1) * (full ? 2.5 : 1);
  const limit = (AI_WORKS.wallet[level] + 120 * bases.length) * (full ? 1.6 : 1);
  w.wallet = Math.min(limit, w.wallet + (civ.rates?.materials || 0) * dt * share);
  // The wallet is income set aside, so it is spent from the stockpile itself: production is paid progressively and
  // loses at most the wallet's share of income. Only the banked surplus is judged after production commitments.
  const owed = productionCommitment(game, civ);
  const stock = { materials: civ.res.materials, energy: civ.res.energy };
  // the reserves buildArmy saves for: works never delay a headquarters at a captured ruin (income is what wins), nor the
  // next era once the army is near its floor (buildArmy itself saves for it from the floor)
  let reserve = 0;
  const target = game.siteById.get(p.target), nearFloor = own.length >= armyFloor(game) * .8;
  if (p.state === 'Expanding' && target?.owner === civ.id && !target.hq) reserve = Math.max(reserve, settlementCost(game, civ, target.claimRoad).materials);
  if (nearFloor && civ.age === 0 && game.time > 135 && bases[0] && !headquarters(game, bases[0])?.project && own.length >= 7) reserve = Math.max(reserve, TIERS[1].cost.materials);
  // the economy build-out comes first: while the main base has an open ring site, keep the price of a facility in hand
  if (bases[0] && openSlots(game, bases[0]).length) reserve = Math.max(reserve, 200);
  // the strategic programme's bank (AI_OPERATIONS.md): the step being saved for is kept in materials and energy, so
  // works never spend the missile's energy down to 0 in a stalemate (balance pass 2026-11-18)
  const nuke = p.nuke?.saving && p.nuke.reserve;
  if (nuke) reserve = Math.max(reserve, nuke.materials || 0);
  const [keepM, keepE] = AI_WORKS.keep[level];
  reserve = Math.max(reserve, keepM);
  const energyReserve = Math.max(keepE, nuke ? nuke.energy || 0 : 0);
  // a stock banked beyond the new-base threshold (developBases: 1350) is idle money: part of it may go to works
  const surplus = Math.max(0, civ.res.materials - owed.materials - 1500) * .5;
  const starving = own.length < armyFloor(game) * AI_WORKS.starve[level] && !full;
  return { stock, reserve, energyReserve, surplus, starving, full, threatened, level };
}

function affordable(b, w, cost, forward = false) {
  const m = cost.materials || 0, e = cost.energy || 0;
  if (b.starving) return false;
  const funded = m <= w.wallet + b.surplus && (!forward || m <= (w.wallet + b.surplus) * .6);
  if (b.stock.materials - m < b.reserve || b.stock.energy - e < (b.energyReserve || 0)) {
    // funded but the stockpile is drawn down by production right now: retry on the next plan tick it can pay
    if (funded) b.want = Math.min(b.want || Infinity, m + b.reserve);
    return false;
  }
  return funded;
}

function spend(b, w, cost) {
  const m = cost.materials || 0;
  w.wallet = Math.max(0, w.wallet - m);
  w.spent += m;
  b.stock.materials -= m; b.stock.energy -= cost.energy || 0;
}

// ---- structures --------------------------------------------------------------------------------------------------

/** Dry-runs then places a field structure near `point` (the server snaps it within 2 hexes). Returns the building id. */
function place(game, civ, w, b, ctx, type, point, yaw, { forward = false } = {}) {
  if (ctx.tries <= 0 || ctx.builds <= 0) return 0;
  const def = ACTION_BUILDINGS[type];
  if (!def || def.tier > civ.age + 1) return 0;
  ctx.tries--;
  const dry = constructDefense(game, civ, type, point, true, yaw);
  const at = dry.reply?.placement;
  if (dry.error || !at) return 0;
  const surcharged = (at.surcharge || 1) > 1;
  if (surcharged && !forward) return 0;
  // never stack on another structure the snap moved it next to
  for (const o of game.buildings.values()) if (o.owner === civ.id && ACTION_BUILDINGS[o.type]?.field && distance(o, at) < def.radius + ACTION_BUILDINGS[o.type].radius + .45) return 0;
  if (!affordable(b, w, at.cost, surcharged)) return 0;
  const done = constructDefense(game, civ, type, { x: at.x, z: at.z }, false, yaw);
  if (done.error || !done.building) return 0;
  ctx.builds--;
  spend(b, w, at.cost);
  w.built++;
  game.tm?.aiBuild(civ, type, at, forward);   // telemetry (read-only, docs/TELEMETRY.md)
  return done.building;
}

/** The armed structures an axis wants, in build order, by era and by what the enemy fields. */
function axisMix(civ, w, p, quota, era, level) {
  const armor = w.armor >= 2, list = [];
  for (let i = 0; i < quota; i++) {
    if (i === 0) list.push(era && level >= 2 ? 'bunker' : 'guard_post');
    else if (era && armor && i % 2 === 1) list.push('turret');
    else list.push(i === 3 && !era ? 'guard_post' : 'bunker');
  }
  if (era && armor && quota >= 2 && !list.includes('turret')) list[quota - 1] = 'turret';
  return list;
}

/** First wanted type not yet covered by the structures present (a turret also covers a missing bunker). */
function shortage(list, present) {
  const have = {};
  for (const b of present) have[b.type] = (have[b.type] || 0) + 1;
  for (const type of list) {
    if (have[type] > 0) { have[type]--; continue; }
    if (type === 'bunker' && have.turret > 0) { have.turret--; continue; }
    return type;
  }
  return null;
}

/** Field structures of this civ within r of a point (done or under construction). */
const fieldNear = (game, civ, point, r, test = armed) => {
  const out = [];
  for (const b of game.buildings.values()) if (b.owner === civ.id && b.hp > 0 && test(b) && distance(b, point) < r) out.push(b);
  return out;
};
const trenchNear = (game, civ, point, r) => { let n = 0; for (const f of game.fieldworks.values()) if (f.owner === civ.id && distance(f, point) < r) n++; return n; };

/** A base's defenses along its axes. Returns true when something was wanted but not affordable (save for it). */
function defendBase(game, civ, p, w, b, ctx, s, plan, main) {
  const level = b.level, era = civ.age >= 1 ? 1 : 0, minute = game.time / 60;
  const attacked = w.attacks.some((r) => r.site === s.id && game.time - r.t < 180);
  let cap = AI_WORKS.baseCap[level] + (minute >= 18 && level >= 1 ? 2 : 0) + (attacked ? 1 : 0);
  if (!main && !attacked) cap = Math.max(1, Math.ceil(cap * .6));
  let total = fieldNear(game, civ, s, 11).length, waiting = false;
  for (let i = 0; i < plan.axes.length && total < cap; i++) {
    const x = plan.axes[i];
    let quota = Math.max(level >= 1 ? 1 : 0, AI_WORKS.perAxis[level] - (i ? 1 : 0));
    if (minute < 10) quota = Math.min(quota, 1 + (level >= 3 ? 1 : 0));
    else if (minute < 15) quota = Math.max(1, quota - 1);
    if (minute >= 18 && level >= 2) quota++;
    if (attacked && w.attacks.some((r) => r.site === s.id && angDiff(r.a, x.a) < .62)) quota++;
    if (!quota) continue;
    const anchor = along(s, x.a, x.d), present = fieldNear(game, civ, anchor, 3.2);
    const type = shortage(axisMix(civ, w, p, quota, era, level), present);
    if (type) {
      const before = ctx.builds;
      for (const side of [0, 1.25, -1.25, 2.5, -2.5]) {
        if (ctx.tries <= 0) break;
        const spot = along(s, x.a, x.d, side);
        if (present.some((o) => distance(o, spot) < 1)) continue;
        if (place(game, civ, w, b, ctx, type, spot, x.a, { forward: false })) { total++; break; }
      }
      if (ctx.builds === before && !affordable(b, w, ACTION_BUILDINGS[type].cost)) waiting = true;
    }
    // a forward chokepoint beyond the ring of influence: one strong point at x3, only for a real threat and a rich wallet
    if (x.choke && x.choke.d > x.d + .5 && level >= 2 && x.kinds.some((k) => k === 'enemy' || k === 'attack') && i === 0) {
      const spot = along(s, x.a, x.choke.d - .6);
      if (!fieldNear(game, civ, spot, 2.4).length) place(game, civ, w, b, ctx, era && w.armor >= 2 ? 'turret' : 'bunker', spot, x.a, { forward: true });
    }
    // a sandbag barricade where a road crosses the axis (barricades may stand on roads)
    if (x.road != null && level >= 1 && minute >= 6) {
      const road = centerOf(x.road), bars = fieldNear(game, civ, road, 1.6, (o) => o.type === 'barricade' && !o.perimeterSlot);
      if (bars.length < (level >= 2 ? 2 : 1)) place(game, civ, w, b, ctx, 'barricade', bars.length ? along(road, x.a, 0, 1.05) : road, x.a);
    }
  }
  // one AA battery per base against enemy air, from era II
  if (era && (p.enemyAir || 0) >= 1.5 && (main || attacked) && !fieldNear(game, civ, s, 9, (o) => o.type === 'aa_battery').length && plan.axes[0])
    place(game, civ, w, b, ctx, 'aa_battery', along(s, plan.axes[0].a, plan.axes[0].d - 1.1, 1.2), plan.axes[0].a);
  // the stronger AIs add an artillery emplacement behind the main axis late in the match
  if (era && level >= 3 && main && minute >= 15 && plan.axes[0] && !fieldNear(game, civ, s, 9, (o) => o.type === 'artillery_post').length)
    place(game, civ, w, b, ctx, 'artillery_post', along(s, plan.axes[0].a, Math.max(3.4, plan.axes[0].d - 1.4), -1.4), plan.axes[0].a);
  return waiting;
}

// ---- trenches ----------------------------------------------------------------------------------------------------

/** Digs a straight line of `hexes` across bearing `a` with the player's trench command, centred on the first of
 *  `centres` (a point or a list of fallbacks: rough ground, structures) where most of the line can be dug. */
function dig(game, civ, w, b, ctx, centres, a, hexes, { label } = {}) {
  if (ctx.strokes <= 0 || hexes < 2) return 0;
  ctx.strokes--;
  // the full line, or (when the stockpile is short) a 3-hex stub the next pass extends: trenchRoutes joins a stroke
  // drawn up to an existing trench into one work. At most four dry runs.
  let runs = 4;
  for (const c of Array.isArray(centres) ? centres : [centres]) for (const length of hexes > 3 ? [hexes, 3] : [hexes]) {
    if (runs-- <= 0) return 0;
    const half = (length - 1) * 1.73 / 2;
    const points = [along(c, a, 0, -half), { x: wrapX(c.x), z: c.z }, along(c, a, 0, half)];
    const dry = trenchLine(game, civ, points, false, true);
    const n = dry.reply?.trench?.positions?.length || 0, dug = (dry.reply?.trench?.skipped || []).filter((k) => k.why === 'dug').length;
    // most of the line must be diggable, counting the stretch an earlier stroke already dug (this one extends it)
    if (dry.error || !n || n + dug < Math.max(2, Math.ceil(length * .5))) break;   // next centre
    if (!affordable(b, w, { materials: n * 35 })) { ctx.short = true; continue; }
    const done = trenchLine(game, civ, points, false, false);
    if (done.error || !done.hexes) return 0;
    spend(b, w, { materials: done.hexes * 35 });
    w.dug += done.hexes;
    game.tm?.aiDig(civ, done.hexes, label);   // telemetry (read-only)
    if (label) note(game, civ.aiPlan, label);
    return done.hexes;
  }
  return 0;
}

function note(game, p, text) {
  if (!p?.notes) return;
  p.notes.unshift({ time: Math.round(game.time), text });
  if (p.notes.length > 18) p.notes.pop();
}

/** Where our troops are in contact away from home: their centroid and the bearing to the enemy, or null. */
function frontOf(game, civ, p, own, enemy, sites) {
  const ground = enemy.filter((u) => !ACTION_UNITS[u.type].air);
  const engaged = own.filter((u) => !ACTION_UNITS[u.type].air && ACTION_UNITS[u.type].atk > 0 &&
    ground.some((e) => distance(e, u) < 6.5) && !sites.some((s) => distance(s, u) < 6));
  let group = engaged;
  if (group.length < 3) {
    // a stalled operation: the committed troops have made no progress for a while
    if (!['Attacking', 'Final Assault', 'Expanding'].includes(p.state) || game.time - (p.progressAt ?? game.time) < 30) return null;
    const ids = new Set(p.troops || []);
    group = own.filter((u) => ids.has(u.id) && !ACTION_UNITS[u.type].air && !sites.some((s) => distance(s, u) < 6));
    if (group.length < 3) return null;
  }
  const o = group[0];
  const c = { x: wrapX(o.x + group.reduce((n, u) => n + dxBetween(o.x, u.x), 0) / group.length), z: group.reduce((n, u) => n + u.z, 0) / group.length };
  const foes = ground.filter((e) => distance(e, c) < 9);
  let toward = null;
  if (foes.length) toward = { x: wrapX(c.x + foes.reduce((n, e) => n + dxBetween(c.x, e.x), 0) / foes.length), z: foes.reduce((n, e) => n + e.z, 0) / foes.length };
  else { const t = game.siteById.get(p.target); if (t) toward = t; }
  if (!toward || distance(c, toward) < .3) return null;
  return { x: round2(c.x), z: round2(c.z), a: round2(bearing(c, toward)) };
}

function digFront(game, civ, p, w, b, ctx, own, enemy, sites) {
  const level = b.level, f = frontOf(game, civ, p, own, enemy, sites);
  if (!f) { if (w.front && game.time - w.front.seen > 40) w.front = null; return; }
  if (!w.front || distance(w.front, f) > 3) w.front = { ...f, since: game.time, seen: game.time };
  else { w.front.seen = game.time; w.front.a = f.a; }
  const stall = AI_WORKS.frontStall[level] * (game.time >= 900 ? .65 : 1);
  if (game.time - w.front.since < stall || game.time < (w.frontAt || 0) || level === 0 && game.time < 900) return;
  // just behind the troops (toward home), across the line of contact; a front inside enemy territory (a siege) digs in
  // on the nearest own or neutral ground behind it (trenches never go on another player's land)
  const hexes = AI_WORKS.trench[Math.max(1, level)] + (game.time >= 900 ? 1 : 0);
  const centres = [1.1, 2.6, 4.1].map((back) => along(w.front, w.front.a + Math.PI, back));
  if (trenchNear(game, civ, centres[0], 2.6) >= 3) { w.frontAt = game.time + 30; return; }
  if (dig(game, civ, w, b, ctx, centres, w.front.a, hexes, { label: 'Digging in on a stalled front.' })) {
    w.frontAt = game.time + 45; w.frontLines = (w.frontLines || 0) + 1; return;
  }
  w.frontAt = game.time + 12;
}

// ---- upgrades ----------------------------------------------------------------------------------------------------

function wantsAdvance(game, civ, s, main) {
  return s.tier < 3 && game.time >= (s.tier === 1 ? 110 : 420) && (main || !openSlots(game, s).length && civ.res.materials > 780);
}

function upgrade(game, civ, w, b, bases) {
  if (b.level < 1) return;
  // era levels of the AI's own field defenses: the most exposed (fewest levels) first
  const target = [...game.buildings.values()].filter((o) => o.owner === civ.id && o.done && !o.project && !o.perimeterSlot &&
    ACTION_BUILDINGS[o.type].field && ACTION_BUILDINGS[o.type].levels && (o.level || 1) < Math.min(3, civ.age + 1))
    .sort((x, y) => (x.level || 1) - (y.level || 1) || Number(!!ACTION_BUILDINGS[y.type].attack) - Number(!!ACTION_BUILDINGS[x.type].attack) || x.id - y.id)[0];
  if (target) {
    const cost = ACTION_BUILDINGS[target.type].levels.cost[(target.level || 1) - 1];
    if (affordable(b, w, cost) && !upgradeBuilding(game, civ, target.id).error) { spend(b, w, cost); return; }
  }
  // base perimeters: bought (or rebuilt) and upgraded, when the headquarters has no other project to run
  if (game.time < AI_WORKS.start[b.level] + 120) return;
  for (const s of bases) {
    const hq = headquarters(game, s);
    if (!hq?.done || hq.project || wantsAdvance(game, civ, s, s === bases[0])) continue;
    const pieces = [...game.buildings.values()].filter((o) => o.owner === civ.id && o.site === s.id && o.perimeterSlot).length;
    if (pieces < 6 && (b.level >= 2 || !pieces || w.attacks.some((r) => r.site === s.id && game.time - r.t < 300))) {
      const cost = { materials: Math.ceil(CITY_DEFENSES.cost.materials * (6 - pieces) / 6), energy: Math.ceil(CITY_DEFENSES.cost.energy * (6 - pieces) / 6) };
      if (affordable(b, w, cost) && !fortifyBase(game, civ, s).error) { spend(b, w, cost); return; }
      continue;
    }
    const next = (s.defenseLevel || 1) + 1;
    if (pieces && next <= CITY_DEFENSES.upgrade.max && civ.age + 1 >= next && b.level >= 1) {
      const cost = CITY_DEFENSES.upgrade.cost[next - 2];
      if (affordable(b, w, cost) && !upgradeDefenses(game, civ, s).error) { spend(b, w, cost); return; }
    }
  }
}

// ---- entry points ------------------------------------------------------------------------------------------------

/**
 * One works pass for an AI civ (called every plan tick; does its real work every AI_WORKS.period s).
 * @param bases the civ's bases (sites with slots), main base first
 * @param own the civ's units, base engineers excluded
 * @param enemy hostile units the civ sees
 */
export function aiWorks(game, civ, bases, own, enemy, p) {
  if (!AI_WORKS.enabled || !p) return;
  const w = state(game, civ, p), level = levelOf(civ);
  const sites = game.sites.filter((s) => s.owner === civ.id && (s.slots ? !!headquarters(game, s)?.done : true));
  w.armor = Math.max(enemy.filter(isVehicle).length, w.armor * Math.pow(.996, Math.max(0, game.time - (w.seenAt ?? game.time))));
  w.seenAt = game.time;
  recordAttacks(game, civ, w, sites, enemy);
  // a funded purchase the stockpile could not cover waits for the next plan tick on which it can (the stockpile peaks
  // briefly between production payments); otherwise one pass every AI_WORKS.period s
  if (game.time < w.next && !(w.want && civ.res.materials >= w.want && game.time >= (w.wantAt || 0))) return;
  if (game.time >= w.next) w.next = game.time + AI_WORKS.period[level];
  w.wantAt = game.time + 1.5;
  const b = budget(game, civ, p, w, bases, own);
  if (game.time < AI_WORKS.start[level] && !b.threatened) return;
  const ctx = { tries: AI_WORKS.tries, builds: AI_WORKS.builds + (level >= 3 ? 1 : 0), strokes: 1 };
  // engineers can only build so much at once: no new orders while several are still unbuilt
  let pending = 0;
  for (const o of game.buildings.values()) if (o.owner === civ.id && !o.done && ACTION_BUILDINGS[o.type]?.field && !o.perimeterSlot && !ACTION_BUILDINGS[o.type].newBase) pending++;
  let undug = 0;
  for (const f of game.fieldworks.values()) if (f.owner === civ.id && f.progress < 1) undug++;
  if (pending >= 2 + bases.length) ctx.builds = 0;
  const digging = undug < 8 + 2 * level;
  if (!digging) ctx.strokes = 0;
  // threat axes per base, cached
  const live = new Set(bases.map((s) => s.id));
  for (const id of Object.keys(w.bases)) if (!live.has(Number(id))) delete w.bases[id];
  let refreshed = 0;
  for (const s of bases) {
    const plan = w.bases[s.id];
    if (plan && game.time - plan.at < AI_WORKS.recompute) continue;
    if (refreshed++ >= 2 && plan) continue;            // at most two recomputations per pass (a new base always gets its axes)
    w.bases[s.id] = { at: game.time, axes: threatAxes(game, civ, s, w, level) };
  }
  // under attack first, then the main base, then the rest
  const order = bases.slice().sort((x, y) => Number(w.attacks.some((r) => r.site === y.id && game.time - r.t < 180)) - Number(w.attacks.some((r) => r.site === x.id && game.time - r.t < 180)) ||
    bases.indexOf(x) - bases.indexOf(y));
  // trenches across the main axes come first once the first defense there is up (or the base was attacked, or late
  // in the match): a line costs about one bunker and would otherwise wait behind every further structure
  if (b.level >= 1) {
    for (const s of order) {
      if (ctx.strokes <= 0) break;
      const plan = w.bases[s.id], attacked = w.attacks.some((r) => r.site === s.id && game.time - r.t < 300);
      const lines = 1 + (b.level >= 3 || game.time >= 900 && b.level >= 2 ? 1 : 0);
      for (const x of plan.axes.slice(0, lines)) {
        const anchor = along(s, x.a, x.d);
        if (!attacked && !fieldNear(game, civ, anchor, 3.2).some((o) => o.done) && game.time < 900) continue;
        const c = along(s, x.a, x.d + 1.3);
        if (trenchNear(game, civ, c, 3) >= 3) continue;
        ctx.short = false;
        dig(game, civ, w, b, ctx, [c, along(s, x.a, x.d + .5), along(s, x.a, x.d + 2.2)], x.a, AI_WORKS.trench[b.level] + (game.time >= 900 ? 1 : 0));
        if (ctx.short && !attacked) ctx.hold = true;   // save for the line: no further planned structures this pass
        if (ctx.strokes <= 0) break;
      }
    }
  }
  // a front that has stopped moving digs in (its own stroke: base lines never crowd it out)
  if (digging) { const base = ctx.strokes; ctx.strokes = 1; digFront(game, civ, p, w, b, ctx, own, enemy, sites); ctx.strokes = Math.min(base, ctx.strokes); }
  let saving = false;
  for (const s of order) {
    if (ctx.builds <= 0 || ctx.tries <= 0) break;
    if (ctx.hold && !w.attacks.some((r) => r.site === s.id && game.time - r.t < 180)) { saving = true; continue; }
    if (defendBase(game, civ, p, w, b, ctx, s, w.bases[s.id], s === bases[0])) saving = true;
  }
  if (b.level >= 1) {
    // forward positions: outposts nearest the enemy get a short line (and, for the stronger AIs, a bunker)
    const foes = enemyBases(game, civ);
    if (foes.length && ctx.strokes + ctx.builds > 0) {
      const nearest = (s) => Math.min(...foes.map((e) => distance(s, e)));
      const forward = sites.filter((s) => !s.slots && nearest(s) < 34).sort((x, y) => nearest(x) - nearest(y) || x.id - y.id).slice(0, b.level >= 3 ? 3 : 2);
      for (const s of forward) {
        const e = foes.slice().sort((x, y) => distance(s, x) - distance(s, y) || x.id - y.id)[0], a = bearing(s, e);
        if (b.level >= 2 && ctx.builds > 0 && !fieldNear(game, civ, s, 3).length) place(game, civ, w, b, ctx, civ.age >= 1 && w.armor >= 2 ? 'turret' : 'bunker', along(s, a, 1.5), a);
        const c = along(s, a, 2.2);
        if (ctx.strokes > 0 && trenchNear(game, civ, c, 2.6) < 2) dig(game, civ, w, b, ctx, c, a, Math.max(3, AI_WORKS.trench[b.level] - 1));
      }
    }
  }
  // upgrades last, and only when no wanted defense is waiting for the wallet
  if (!saving) upgrade(game, civ, w, b, bases);
  w.want = Number.isFinite(b.want) ? Math.round(b.want) : 0;
  w.wallet = round2(w.wallet);
}

/**
 * Emergency defense of an attacked base (actionAI Defending branch): an armed structure toward the attackers at list
 * price (never with the ring-of-influence surcharge), up to AI_WORKS.emergencyMax[level] near the base, every
 * AI_WORKS.emergency[level] s. The type answers the attackers: AA against air, anti-armour against vehicles.
 */
export function aiEmergencyWorks(game, civ, defended, vanguard, enemiesNearHome, p) {
  const level = levelOf(civ);
  p.defenseAt = game.time + AI_WORKS.emergency[level];
  if (!defended || !vanguard) return;
  const w = state(game, civ, p);
  const a = bearing(defended, vanguard);
  if (!w.attacks.some((r) => r.site === defended.id && angDiff(r.a, a) < .5)) w.attacks.unshift({ site: defended.id, a: round2(a), t: game.time });
  const standing = fieldNear(game, civ, defended, 4).length;
  if (standing >= AI_WORKS.emergencyMax[level]) return;
  const air = enemiesNearHome.filter((u) => ACTION_UNITS[u.type].air).length;
  const tracked = enemiesNearHome.some((u) => ACTION_UNITS[u.type].move === 'tracked');
  // the first one is the cheap watchtower of old (unless the attackers call for AA or anti-armour); bunkers come as
  // wallet-funded reinforcements for hard and above
  const types = [];
  if (civ.age > 0 && air >= 2 && !fieldNear(game, civ, defended, 6, (o) => o.type === 'aa_battery').length) types.push('aa_battery');
  if (civ.age > 0 && tracked) types.push('turret');
  if (level >= 2 && standing) types.push('bunker');
  types.push('guard_post');
  const length = Math.max(.1, distance(defended, vanguard));
  const forward = game.lerpPoint(defended, vanguard, Math.min(.85, 3.2 / length));
  for (const type of types) {
    if (ACTION_BUILDINGS[type].tier > civ.age + 1) continue;
    // the first structure by an attacked base comes regardless of the wallet (as before AI works); more need its funds
    if (standing && (ACTION_BUILDINGS[type].cost.materials || 0) > w.wallet) continue;
    for (const side of [0, .9, -.9]) {
      const spot = along(forward, a, 0, side), dry = constructDefense(game, civ, type, spot, true, a), at = dry.reply?.placement;
      if (dry.error || !at || (at.surcharge || 1) > 1) continue;   // never pay the ring-of-influence surcharge in an emergency
      if (constructDefense(game, civ, type, { x: at.x, z: at.z }, false, a).error) continue;
      w.wallet = Math.max(0, w.wallet - (at.cost.materials || 0));
      w.spent += at.cost.materials || 0; w.built++;
      w.emergency = (w.emergency || 0) + (at.cost.materials || 0);
      return;
    }
  }
}

export const _test = { angDiff, bearing, along, chokeAlong, frontOf, state };
