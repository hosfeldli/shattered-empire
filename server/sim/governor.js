// City governors: per-city automation that players delegate to, and that AI empires use for
// every city. Governors obey the same placement checks, costs and research as manual orders,
// respect a resource reserve and explicit permissions, and log why they did everything.
import { T, TERRAIN, BUILDINGS, UNITS, RES, ROAD_TYPES, GOVERNOR_SPECS } from './constants.js';
import { disk, dist } from './hex.js';
import { findRoadRoute } from './path.js';
import { assess, candidates, isRoutine } from './planner.js';
import { allocationFor } from './economy.js';
import { catOf, defaultWorkforce } from './workforce.js';

// Autonomy levels (what the governor may do without asking):
//   off         nothing
//   advisor     analyses and proposes; only permitted emergency repairs run on their own (default)
//   managed     labor priorities, repairs, rubble, farms and housing within budget; asks for the rest
//   autonomous  develops the city within its budget, goal and permissions (AI empires use this)
export const LEVELS = ['off', 'advisor', 'managed', 'autonomous'];
export function defaultGovernor(enabled = false, spec = 'balanced') {
  return { enabled, level: enabled ? 'autonomous' : 'off', spec, goal: 'none', reserve: 0.25, budget: 0.15, emergency: true,
    perms: { build: true, roads: true, repair: true, recruit: false, settle: false }, log: [], queue: [], blocked: [], next: 0,
    proposals: [], deferred: [], rejected: {}, cooldown: 0, nextProposal: 1 };
}
// older saves: an enabled governor without a level was fully automatic
export function migrateGovernor(gv) {
  if (!gv.level) gv.level = gv.enabled ? 'autonomous' : 'off';
  for (const [k, v] of Object.entries({ goal: 'none', budget: 0.15, emergency: true, proposals: [], deferred: [], rejected: {}, cooldown: 0, nextProposal: 1 })) if (gv[k] === undefined) gv[k] = Array.isArray(v) ? [] : typeof v === 'object' ? {} : v;
  gv.enabled = gv.level !== 'off';
  return gv;
}

function log(g, c, text) {
  const gv = c.governor;
  // what the governor is working on right now (shown on the city's banner)
  if (/^(Building|Expanding|Upgrading|Repair|Clearing|Holding off|Raised|Saving|Approved)/.test(text)) gv.now = { text: text.replace(/\.$/, ''), t: g.time };
  // the same decision repeated within a few minutes is noise, not information
  if (gv.log.slice(0, 8).some((l) => l.text === text && g.time - l.t < 240)) return;
  const civ = g.civs[c.owner];
  if (civ && civ.human && !/^Holding off/.test(text)) g.history(civ, 'governor:' + c.name, text);
  gv.log.unshift({ t: Math.round(g.time), text });
  if (gv.log.length > 30) gv.log.length = 30;
}

// Spending rule: draw from the stockpile that will actually pay (local reserves for a cut-off
// city), never dip into the reserved share, and stay within the governor's budget share.
export function governorCanSpend(civ, gv, cost, c = null) {
  const auto = civ.isAI || gv.level === 'autonomous';
  const budget = civ.isAI ? 0.7 : Math.max(gv.budget || 0.15, auto ? 0.35 : 0);
  for (const k in cost) {
    const pool = c && c.isolated && k !== 'credits' ? c.stock?.[k] || 0 : civ.res[k] || 0;
    if (pool * (1 - gv.reserve) < cost[k]) return false;
    if (cost[k] > Math.max(pool * budget, k === 'materials' ? 60 : 0)) return false;
  }
  return true;
}

function count(g, c, type) { let n = 0; for (const b of g.buildings.values()) if (b.cityId === c.id && b.type === type && b.owner === c.owner) n++; return n; }
function civCount(g, civ, type) { let n = 0; for (const b of g.buildings.values()) if (b.type === type && b.owner === civ.id) n++; return n; }
const unlocked = (civ, type) => { const d = BUILDINGS[type]; return d && d.age <= civ.age && (!d.tech || civ.techs.has(d.tech)); };

// Ranked wish-list for a city: [type, reason]. Specialization reorders and adds priorities.
export function pickTile(g, civ, c, type, gv) {
  const w = g.world;
  let best = -1, bs = -Infinity;
  for (const t of disk(c.tile, c.radius || 3)) {
    if (w.owner[t] !== civ.id || (gv && gv.blocked.includes(t)) || !g.canPlace(civ, type, t, true)) continue;
    let s = -dist(c.tile, t);
    if (type === 'farm') { s = TERRAIN[w.terr[t]].fert * 4 + (w.river[t] ? 1 : 0) - dist(c.tile, t) * 0.3; if (w.res[t]) s -= 3; }
    else if (type === 'mine') s = (w.res[t] === RES.IRON ? 3 : w.res[t] === RES.COAL ? 2 : -1) - dist(c.tile, t) * 0.2;
    else if (BUILDINGS[type].place === 'flat' && (w.res[t] || w.terr[t] === T.FOREST || TERRAIN[w.terr[t]].fert > 0.8)) s -= 2;
    // defenses face the threat: toward the nearest known hostile city or army, never behind the town
    if (BUILDINGS[type].attack) { const th = threatTile(g, civ, c.tile); if (th >= 0) s = -dist(t, th) * 1.5 - Math.abs(dist(c.tile, t) - (type === 'aa_battery' ? 1 : 2)) * 2; if (w.terr[t] === T.HILLS) s += 1; }
    if (w.stab[t] < 0.3) s -= 3;
    if (w.ash[t] > 0 || w.lava[t] > 0) s -= 5;
    if (g.ruins.has(t) && g.ruins.get(t).type === type) s += 4;      // rebuilding a ruin is cheaper
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

// where an attack would come from: the nearest known hostile army or city
function threatTile(g, civ, from) {
  let best = -1, bd = Infinity;
  for (const u of g.units.values()) if (g.hostile(civ.id, u.owner) && civ.visible[u.tile]) { const d = dist(u.tile, from); if (d < bd) { bd = d; best = u.tile; } }
  if (best < 0) for (const k of civ.knownCities.values()) if (k.owner !== civ.id) { const d = dist(k.tile, from); if (d < bd) { bd = d; best = k.tile; } }
  return best;
}

export function governorStep(g, dt) {
  for (const c of g.cities.values()) {
    const gv = c.governor; if (!gv) continue;
    migrateGovernor(gv);
    if (gv.level === 'off') continue;
    const civ = g.civs[c.owner]; if (!civ || !civ.alive) continue;
    if (g.time < gv.next) continue;
    gv.next = g.time + (civ.isAI ? 2 : 3) + (c.id % 3) * 0.3;
    gv.queue = gv.queue.filter((id) => { const b = g.buildings.get(id); return b && !b.done; });
    gv.proposals = (gv.proposals || []).filter((p) => p.status === 'proposed' && g.time - p.at < 300);
    const level = civ.isAI ? 'autonomous' : gv.level;
    // each area of responsibility gets its own turn so construction never starves roads or the garrison
    gv.turn = ((gv.turn || 0) + 1) % 4;
    const repairOk = gv.perms.repair && (level !== 'advisor' || gv.emergency);
    const did = (repairOk && repair(g, civ, c, gv, level)) || false;
    if (!did && gv.perms.build && (gv.turn !== 1 || !gv.perms.roads)) develop(g, civ, c, gv, level);
    if (gv.perms.roads && gv.turn === 1) roads(g, civ, c, gv, level);
    if (gv.perms.recruit && gv.turn === 2 && (level === 'autonomous')) recruit(g, civ, c, gv);
    if (gv.perms.settle && gv.turn === 3) settle(g, civ, c, gv, level);
    if (level !== 'advisor' && gv.turn === 0) laborPriorities(g, civ, c, gv);
  }
}

// Managed and autonomous governors may shift flexible labor priorities (never the player's locks)
// toward what the nation is short of, and say what they expect it to achieve.
function laborPriorities(g, civ, c, gv) {
  const wf = c.wf || (c.wf = defaultWorkforce());
  if (gv.wfLocked) return;
  const want = new Set([...(civ.short || []), ...Object.keys(civ.saving || {})]);
  const blds = [...g.buildings.values()].filter((b) => b.cityId === c.id && b.owner === civ.id && b.done && BUILDINGS[b.type].jobs);
  for (const b of blds) {
    if (!(b.why || '').startsWith('prio:') || b.lock != null) continue;
    const d = BUILDINGS[b.type]; if (!d.produce || !Object.keys(d.produce).some((k) => want.has(k))) continue;
    const cat = catOf(b.type); if (wf.prio[cat] === 'high' || wf.prio[cat] === 'critical') continue;
    const before = allocationFor(g, civ, c);
    const next = { ...wf, prio: { ...wf.prio, [cat]: 'high' }, mode: 'custom' };
    const after = allocationFor(g, civ, c, next);
    const gain = Object.entries(after.effect).filter(([k]) => want.has(k)).reduce((s2, [, v]) => s2 + v, 0);
    void before;
    if (gain <= 0) continue;
    c.wf = next;
    log(g, c, `Raised ${cat} labor priority so ${d.name.toLowerCase()}s are staffed: forecast ${Object.entries(after.effect).map(([k, v]) => `${v > 0 ? '+' : ''}${v.toFixed(1)} ${k}/s`).join(', ')}.`);
    return true;
  }
  return false;
}

// Development: score every option, act within authority, propose the rest, explain deferrals.
function develop(g, civ, c, gv, level) {
  const maxProjects = civ.isAI ? 2 : level === 'autonomous' ? 2 : 1;
  if (gv.queue.length >= maxProjects || g.time < (gv.cooldown || 0)) return false;
  const a = assess(g, civ, c);
  const { list, deferred } = candidates(g, civ, c, gv, a);
  gv.deferred = deferred.slice(0, 4);
  const none = list.find((x) => x.kind === 'none').u;
  for (const cand of list) {
    if (cand.kind === 'none' || cand.u <= none) break;
    if (gv.rejected?.[cand.type] && g.time < gv.rejected[cand.type]) continue;
    const routine = isRoutine(cand.type);
    if (cand.kind === 'upgrade') {
      if (!(level === 'autonomous' || level === 'managed')) { propose(g, civ, c, gv, { action: 'upgrade', type: cand.type, id: cand.id, cost: cand.cost, reason: cand.reason, benefit: Math.round(cand.u), confidence: 0.8 }); return false; }
      if (!governorCanSpend(civ, gv, cand.cost, c)) continue;
      const r = g.command(civ.id, { c: 'upgrade', id: cand.id, by: 'governor:' + c.name });
      if (r && r.error) continue;
      gv.cooldown = g.time + (civ.isAI ? 8 : 20);
      log(g, c, `${cand.type === 'house' ? 'Upgrading a housing block' : `Expanding the ${BUILDINGS[cand.type].name}`}: ${cand.reason}.`);
      return true;
    }
    const may = level === 'autonomous' || (level === 'managed' && routine);
    const t = pickTile(g, civ, c, cand.type, gv);
    if (t < 0) { const d = `${BUILDINGS[cand.type].name}: no suitable free hex inside the city's borders`; if (!gv.deferred.includes(d)) gv.deferred.unshift(d); continue; }
    if (!may) { propose(g, civ, c, gv, { action: 'build', type: cand.type, tile: t, cost: cand.cost, reason: cand.reason, benefit: Math.round(cand.u), confidence: Math.min(0.95, 0.5 + cand.u / 200) }); return false; }
    if (!governorCanSpend(civ, gv, cand.cost, c)) {
      // a national project the empire cannot yet afford: reserve for it so other automation waits
      if (civ.isAI && NATIONAL_CLAIM.has(cand.type) && !civ.natReserve) { civ.natReserve = { type: cand.type, cost: cand.cost, city: c.id, since: g.time }; log(g, c, `Saving for the nation's first ${BUILDINGS[cand.type].name}.`); }
      continue;
    }
    const res = g.command(civ.id, { c: 'build', type: cand.type, tile: t, by: 'governor:' + c.name, why: cand.reason, national: NATIONAL_CLAIM.has(cand.type) });
    if (res && res.error) continue;
    const b = g.buildingAtTile(t);
    if (b) { gv.queue.push(b.id); if (civ.claims && BUILDINGS[cand.type] && NATIONAL_CLAIM.has(cand.type)) civ.claims[cand.type] = c.id; if (civ.natReserve?.type === cand.type) civ.natReserve = null; }
    gv.cooldown = g.time + (civ.isAI ? 8 : 20);
    log(g, c, `Building ${BUILDINGS[cand.type].name}: ${cand.reason}.`);
    return true;
  }
  if (deferred.length && level !== 'off') { const d = deferred[0]; if (gv.lastDeferred !== d) { gv.lastDeferred = d; log(g, c, `Holding off on ${d}.`); } }
  return false;
}
const NATIONAL_CLAIM = new Set(['barracks', 'motor_works', 'heavy_assembly', 'airfield', 'drone_works', 'robotics_complex', 'comms_tower', 'fusion_plant', 'wonder']);

// Proposals wait for the player's decision; at most three at a time, no duplicates.
function propose(g, civ, c, gv, p) {
  if (gv.proposals.length >= 3 || gv.proposals.some((x) => x.type === p.type && x.action === p.action)) return;
  gv.proposals.push({ id: gv.nextProposal++, cityId: c.id, status: 'proposed', at: g.time, requiresApproval: true, ...p });
  if (civ.human) g.notify(civ.id, `${c.name}'s governor proposes: ${p.action === 'build' ? BUILDINGS[p.type].name : p.action}${p.reason ? ` (${p.reason})` : ''}.`, { kind: 'proposal', tile: c.tile, level: 'minor', quiet: true });
}

// The player's answer. Approval re-validates everything (placement, cost, permission) now.
export function answerProposal(g, civ, c, id, answer) {
  const gv = migrateGovernor(c.governor || defaultGovernor());
  const p = gv.proposals.find((x) => x.id === id); if (!p) return { error: 'no such proposal' };
  gv.proposals = gv.proposals.filter((x) => x !== p);
  if (answer === 'reject') { gv.rejected[p.type || p.action] = g.time + 300; log(g, c, `Proposal declined: ${p.type ? BUILDINGS[p.type].name : p.action}. Not proposing it again for five minutes.`); return null; }
  if (answer === 'defer') { gv.rejected[p.type || p.action] = g.time + 90; return null; }
  if (p.action === 'build') {
    let t = p.tile;
    if (!g.canPlace(civ, p.type, t, true)) t = pickTile(g, civ, c, p.type, gv);
    if (t < 0) return { error: 'no valid site any more' };
    const res = g.command(civ.id, { c: 'build', type: p.type, tile: t, plan: true, by: 'governor:' + c.name, why: 'approved: ' + p.reason });
    if (res && res.error) return res;
    const b = g.buildingAtTile(t); if (b) gv.queue.push(b.id);
    log(g, c, `Approved and started: ${BUILDINGS[p.type].name}.`);
  } else if (p.action === 'road') { const r = roads(g, civ, c, gv, 'autonomous'); if (!r) return { error: 'the route is no longer buildable' }; }
  else if (p.action === 'upgrade') { const r = g.command(civ.id, { c: 'upgrade', id: p.id, by: 'governor:' + c.name }); if (r && r.error) return r; log(g, c, `Approved: ${p.type === 'house' || !p.type ? 'upgrading a housing block' : `expanding the ${BUILDINGS[p.type].name}`}.`); }
  else if (p.action === 'settle') { const r = settle(g, civ, c, gv, 'autonomous', true); if (!r) return { error: 'cannot train a convoy now' }; }
  return null;
}

function repair(g, civ, c, gv, level = 'autonomous') {
  for (const b of g.buildings.values()) {
    if (b.cityId !== c.id || b.owner !== civ.id || !b.done || b.hp >= b.maxHp * 0.7 || g.time - (b.lastHit || -99) < 8) continue;
    const cost = { materials: Math.ceil(10 + (BUILDINGS[b.type].cost.materials || 40) * 0.2) };
    if (!governorCanSpend(civ, gv, cost, c)) return false;
    g.pay(civ, cost, b.tile, 'maintenance'); b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.4);
    log(g, c, `Repaired ${BUILDINGS[b.type].name} (${Math.round((100 * b.hp) / b.maxHp)}%) for ${cost.materials} materials.`);
    return true;
  }
  // clear rubble that blocks good sites (routine work: not in advisor mode)
  if (level === 'advisor') return false;
  for (const t of disk(c.tile, c.radius || 3)) {
    const r = g.ruins.get(t);
    if (!r || g.world.owner[t] !== civ.id || r.clearing) continue;
    const cost = { materials: 15 };
    if (!governorCanSpend(civ, gv, cost)) return false;
    g.pay(civ, cost); r.clearing = true; r.clearAt = g.time + 8;
    log(g, c, `Clearing ruins of ${r.name || BUILDINGS[r.type]?.name || 'a building'}.`);
    return true;
  }
  return false;
}

function bestRoadType(civ) { for (let t = 3; t >= 1; t--) if (!ROAD_TYPES[t].tech || civ.techs.has(ROAD_TYPES[t].tech)) return t; return 1; }

function roads(g, civ, c, gv, level = 'autonomous') {
  if (g.roads.projects.some((p) => p.owner === civ.id && !p.done && p.by === 'governor:' + c.id)) return false;
  // repair ruined segments inside the city's territory
  const ruined = [];
  for (const t of disk(c.tile, c.radius || 3)) for (const e of g.roads.edgesOf(t)) if (e.cond < 60 && g.world.owner[e.a] === civ.id && g.world.owner[e.b] === civ.id && !ruined.includes(e)) ruined.push(e);
  if (ruined.length) {
    const e = ruined[0];
    const plan = g.roads.plan(g, civ, [e.a, e.b], e.type); plan.by = 'governor:' + c.id;
    plan.segments.forEach((s) => { if (s.reason === 'already built') { s.ok = true; s.skip = false; } });
    if (governorCanSpend(civ, gv, plan.cost) && !g.roads.startProject(g, civ, plan).error) { log(g, c, 'Repairing a damaged road segment.'); return true; }
  }
  if (!c.isolated) return false;
  // connect to whichever already-connected city is closest, not necessarily the capital
  const hubs = g.cityOf(civ).filter((o) => o !== c && !o.isolated).sort((a, b) => dist(a.tile, c.tile) - dist(b.tile, c.tile)).slice(0, 3);
  if (!hubs.length) return false;
  const best = bestRoadType(civ);
  let route = null, type = best, hub = null;
  for (const h of hubs) {
    for (const ty of [best, ...(best !== 2 && civ.techs.has('civil_engineering') ? [2] : [])]) {
      route = findRoadRoute(g, civ, c.tile, h.tile, ty);
      if (route) { type = ty; hub = h; break; }
    }
    if (route) break;
  }
  c.noLandRoute = !route;
  if (!route) { if (!gv.noRouteNoted) { gv.noRouteNoted = true; log(g, c, 'No land route to the network (major river or sea in the way): a port or paved bridges are needed.'); } return false; }
  const plan = g.roads.plan(g, civ, route, type); plan.by = 'governor:' + c.id;
  if (!plan.buildable) return false;
  if (level !== 'autonomous') { propose(g, civ, c, gv, { action: 'road', cost: plan.cost, reason: `${ROAD_TYPES[type].name.toLowerCase()} to ${hub.name} (${plan.length} hexes) would reconnect the city`, benefit: 40, confidence: 0.8 }); return false; }
  if (!governorCanSpend(civ, gv, plan.cost)) return false;
  if (g.roads.startProject(g, civ, plan).error) return false;
  gv.noRouteNoted = false;
  log(g, c, `Building ${ROAD_TYPES[type].name.toLowerCase()} to ${hub.name} (${plan.length} hexes, ${plan.bridges} bridges) to rejoin the supply network.`);
  return true;
}

function recruit(g, civ, c, gv) {
  if (c.pop < 8) return false;
  const military = [...g.units.values()].filter((u) => u.owner === civ.id && !UNITS[u.type].civilian).length;
  // garrisons come out of the national army budget, not on top of it
  if (military >= (civ.armyCap ?? Math.max(4, g.cityOf(civ).length * 3))) return false;
  const threat = [...g.units.values()].filter((u) => g.hostile(civ.id, u.owner) && civ.visible[u.tile] && dist(u.tile, c.tile) < 10 && !UNITS[u.type].civilian).length;
  const garrison = [...g.units.values()].filter((u) => u.owner === civ.id && !UNITS[u.type].civilian && (dist(u.tile, c.tile) <= 3 || u.garrison === c.id)).length;
  const want = (gv.spec === 'fortress' ? 4 : 2) + threat;
  if (garrison >= want) return false;
  for (const b of g.buildings.values()) {
    if (b.owner !== civ.id || !b.done || b.queue.length || BUILDINGS[b.type].cat !== 'military' || dist(b.tile, c.tile) > 12) continue;
    const opts = (BUILDINGS[b.type].trains || []).filter((u) => !UNITS[u].civilian && !UNITS[u].engineer && UNITS[u].cat !== 'air').reverse();
    for (const u of opts) {
      if (g.canTrain(civ, b, u)) continue;
      if (!governorCanSpend(civ, gv, g.unitCost(civ, u))) continue;
      if (g.command(civ.id, { c: 'train', building: b.id, unit: u, by: 'governor:' + c.name })) continue;
      log(g, c, `Recruiting ${UNITS[u].name} for the garrison (${garrison}/${want}${threat ? `, ${threat} hostiles nearby` : ''}).`);
      return true;
    }
  }
  return false;
}

function settle(g, civ, c, gv, level = 'autonomous', approved = false) {
  if (c.pop < 12 || g.cityOf(civ).length >= 8) return false;
  const b = g.buildings.get(c.buildingId); if (!b || b.queue.length) return false;
  if ([...g.units.values()].some((u) => u.owner === civ.id && u.type === 'colonist')) return false;
  if (!governorCanSpend(civ, gv, g.unitCost(civ, 'colonist'), c)) return false;
  // founding a city is a major decision: only AI empires and explicit approval start one
  if (!civ.isAI && !approved) { propose(g, civ, c, gv, { action: 'settle', cost: g.unitCost(civ, 'colonist'), reason: 'the city is large enough to found a new settlement', benefit: 30, confidence: 0.6 }); return false; }
  if (g.command(civ.id, { c: 'train', building: b.id, unit: 'colonist', by: 'governor:' + c.name })) return false;
  log(g, c, 'Training a colonist convoy to found a new settlement.');
  return true;
}

export { GOVERNOR_SPECS };

// ---------------------------------------------------------------- colonists
// Site quality from the civ's own knowledge (explored tiles, last-seen borders).
export function siteScore(g, civ, t) {
  const w = g.world;
  if (g.canFound(civ, t)) return -1;
  const tt = w.terr[t];
  if (tt !== T.GRASS && tt !== T.PLAINS && tt !== T.ASH && tt !== T.HILLS && tt !== T.DESERT) return -1;
  if (w.stab[t] < 0.3 || w.lava[t] > 0) return -1;
  if (w.volcanoes.some((v) => dist(v.tile, t) < 7)) return -1;
  let s = 0;
  for (const n of disk(t, 3)) {
    if (!civ.explored[n]) continue;
    if (civ.lastOwner[n] >= 0 && civ.lastOwner[n] !== civ.id) s -= 1;
    s += TERRAIN[w.terr[n]].fert + (w.terr[n] === T.FOREST ? 0.5 : 0) + (w.res[n] ? 1 : 0) + (w.river[n] ? 0.3 : 0);
  }
  return s;
}

export function steerColonist(g, civ, u, goals) {
  let goal = goals.get(u.id);
  if (goal !== undefined && u.tile === goal) {
    goals.delete(u.id);
    if (!g.command(civ.id, { c: 'found', unit: u.id })) return true;
    goal = undefined;
  }
  if (goal !== undefined && (u.path.length || u.field)) return false;
  // sites already claimed by our other colonists are off limits (and so is the ground around them):
  // several auto-settlers fan out instead of racing to the same spot
  for (const [id] of goals) if (!g.units.has(id)) goals.delete(id);
  const claimed = [...goals.entries()].filter(([id]) => id !== u.id).map(([, t]) => t);
  let best = -1, bs = 3;
  for (const c of g.cityOf(civ)) for (const t of disk(c.tile, 20)) {
    if (dist(c.tile, t) < 6 || !civ.explored[t]) continue;
    if (claimed.some((x) => dist(x, t) < 6)) continue;
    const sc = siteScore(g, civ, t) - dist(u.tile, t) * 0.15; if (sc > bs) { bs = sc; best = t; }
  }
  if (best >= 0) { goals.set(u.id, best); g.command(civ.id, { c: 'move', units: [u.id], tile: best }); }
  return false;
}

export function autoColonists(g) {
  for (const u of g.units.values()) {
    if (u.type !== 'colonist' || !u.auto) continue;
    const civ = g.civs[u.owner];
    civ.colonistGoals = civ.colonistGoals || new Map();
    steerColonist(g, civ, u, civ.colonistGoals);
  }
}
