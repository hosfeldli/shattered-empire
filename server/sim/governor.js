// City governors: per-city automation that players delegate to, and that AI empires use for
// every city. Governors obey the same placement checks, costs and research as manual orders,
// respect a resource reserve and explicit permissions, and log why they did everything.
import { T, TERRAIN, BUILDINGS, UNITS, RES, ROAD_TYPES, GOVERNOR_SPECS } from './constants.js';
import { disk, dist } from './hex.js';
import { findRoadRoute } from './path.js';

export function defaultGovernor(enabled = false, spec = 'balanced') {
  return { enabled, spec, reserve: 0.25, perms: { build: true, roads: true, repair: true, recruit: false, settle: false }, log: [], queue: [], blocked: [], next: 0 };
}

function log(g, c, text) {
  const gv = c.governor;
  const civ = g.civs[c.owner];
  if (civ && civ.human && !/^Holding off/.test(text)) g.history(civ, 'governor:' + c.name, text);
  gv.log.unshift({ t: Math.round(g.time), text });
  if (gv.log.length > 30) gv.log.length = 30;
}

// Spending rule: never dip into the reserved share of any stockpile.
export function governorCanSpend(civ, gv, cost) {
  for (const k in cost) if ((civ.res[k] || 0) * (1 - gv.reserve) < cost[k]) return false;
  return true;
}

function count(g, c, type) { let n = 0; for (const b of g.buildings.values()) if (b.cityId === c.id && b.type === type && b.owner === c.owner) n++; return n; }
function civCount(g, civ, type) { let n = 0; for (const b of g.buildings.values()) if (b.type === type && b.owner === civ.id) n++; return n; }
const unlocked = (civ, type) => { const d = BUILDINGS[type]; return d && d.age <= civ.age && (!d.tech || civ.techs.has(d.tech)); };

// Ranked wish-list for a city: [type, reason]. Specialization reorders and adds priorities.
export function cityNeeds(g, civ, c, spec) {
  const w = g.world, out = [];
  const has = (t) => count(g, c, t);
  const push = (type, reason) => { if (unlocked(civ, type) && !out.some((x) => x[0] === type)) out.push([type, reason]); };
  const food = civ.rates.food || 0;
  const terrIn = (pred) => disk(c.tile, c.radius || 3).some((t) => w.owner[t] === civ.id && pred(t));
  // survival first
  if (food < 0.8 || (civ.res.food < 80 && food < 2)) push('farm', `food surplus ${food.toFixed(1)}/s is below target`);
  if (c.pop >= c.housing - 1.5) push('house', `population ${Math.floor(c.pop)} has reached housing ${c.housing}`);
  if (civ.powerUse > civ.powerGen * 0.95 && civ.powerUse > 0 && c.pop >= 8) { push('fusion_plant', 'power demand exceeds generation'); push('power_plant', `power demand ${civ.powerUse.toFixed(0)} exceeds generation ${civ.powerGen.toFixed(0)}`); }
  const specList = {
    balanced: [],
    industrial: [['mine', 'industrial specialization: ore'], ['steel_mill', 'industrial specialization: steel'], ['oil_well', 'industrial specialization: fuel'], ['munitions_plant', 'industrial specialization: munitions'], ['electronics_plant', 'industrial specialization: electronics'], ['quarry', 'materials for industry']],
    agrarian: [['farm', 'breadbasket specialization'], ['house', 'breadbasket grows population'], ['port', 'fishing']],
    commercial: [['market', 'trade hub specialization'], ['port', 'trade hub: sea trade'], ['house', 'more merchants need housing']],
    research: [['academy', 'research campus'], ['university', 'research campus'], ['seismic', 'research campus: seismic monitoring']],
    fortress: [['bunker', 'fortress city: defensive line'], ['fort', 'fortress city: stronghold'], ['barracks', 'fortress city: garrison']],
  }[spec] || [];
  for (const [t, r] of specList) if (has(t) < (t === 'farm' || t === 'house' ? 4 : t === 'bunker' ? 3 : 2)) push(t, r);
  if (has('lumber') < 1 && terrIn((t) => w.terr[t] === T.FOREST)) push('lumber', 'no timber mill for materials');
  if (has('farm') < 2) push('farm', 'every city needs two farms');
  if (has('salvage') < 1 && terrIn((t) => w.res[t] === RES.RUINS)) push('salvage', 'old-world ruins in range can be salvaged');
  if (has('quarry') < 1) push('quarry', 'no quarry for materials');
  if (has('mine') < 2 && terrIn((t) => w.res[t] === RES.IRON || w.res[t] === RES.COAL)) push('mine', 'ore deposits in range');
  if (has('oil_well') < 1 && terrIn((t) => w.res[t] === RES.OIL)) push('oil_well', 'oil field in range');
  if (c.capital && civCount(g, civ, 'barracks') < 1) push('barracks', 'the realm has no barracks');
  if (has('market') < 1) push('market', 'no market for merchants');
  if (has('academy') < 1) push('academy', 'no academy for research');
  if (civ.techs.has('metallurgy') && civCount(g, civ, 'steel_mill') < Math.min(3, g.cityOf(civ).length)) push('steel_mill', 'steel output is limited');
  if (civ.techs.has('electrification') && civCount(g, civ, 'power_plant') + civCount(g, civ, 'fusion_plant') < 1) push('power_plant', 'industry needs a power grid');
  if (has('university') < 1 && c.pop > 12) push('university', 'large city without a university');
  if (civ.techs.has('munitions_industry') && civCount(g, civ, 'munitions_plant') < 1) push('munitions_plant', 'armies need munitions');
  if (civ.techs.has('motorization') && civCount(g, civ, 'motor_works') < 1 && c.capital) push('motor_works', 'no vehicle production');
  if (civ.techs.has('mechanization') && civCount(g, civ, 'heavy_assembly') < 1 && c.capital) push('heavy_assembly', 'no armor production');
  if (civ.techs.has('aviation') && civCount(g, civ, 'airfield') < 1 && c.capital) push('airfield', 'no air base');
  if (civ.techs.has('drones') && civCount(g, civ, 'drone_works') < 1 && c.capital) push('drone_works', 'no drone production');
  if (civ.techs.has('robotics') && civCount(g, civ, 'robotics_complex') < 1 && c.capital) push('robotics_complex', 'no robotics production');
  if (civ.techs.has('computing') && civCount(g, civ, 'electronics_plant') < 1 && g.civHasResource(civ, RES.RARE)) push('electronics_plant', 'rare earths available for electronics');
  if (has('seismic') < 1 && w.stab[c.tile] < 0.55) push('seismic', `ground stability ${Math.round(w.stab[c.tile] * 100)}% is low`);
  if (has('stabilizer') < 1 && w.stab[c.tile] < 0.4) push('stabilizer', 'city sits on a fault');
  if (civ.techs.has('networked_command') && civCount(g, civ, 'comms_tower') < g.cityOf(civ).length) push('comms_tower', 'extend command network');
  if (civ.techs.has('seafaring') && has('port') < 1 && c.capital) push('port', 'no harbour');
  if (civ.techs.has('seafaring') && has('port') < 1 && c.isolated && c.noLandRoute) push('port', 'cut off by water: a port opens a sea lane to the network');
  if (c.isolated && c.noLandRoute && c.capital === false && !civ.techs.has('seafaring')) c.wantsSeafaring = true;
  if (civ.techs.has('fortification') && has('bunker') < 1 && (c.capital || spec === 'fortress')) push('bunker', 'city has no defenses');
  if (civ.techs.has('continental_arcology') && civCount(g, civ, 'wonder') < 1 && c.capital && civ.res.credits > 2500) push('wonder', 'the Arcology would secure victory');
  if (c.unemployed > 2) for (const t of ['lumber', 'quarry', 'salvage', 'mine', 'market', 'academy', 'steel_mill', 'munitions_plant', 'university', 'farm']) push(t, `${Math.round(c.unemployed)} citizens unemployed`);
  if (has('farm') < 4 && c.pop > 12 && food < 2) push('farm', 'growing city needs more food');
  if (has('house') < 3) push('house', 'room to grow');
  return out;
}

export function pickTile(g, civ, c, type, gv) {
  const w = g.world;
  let best = -1, bs = -Infinity;
  for (const t of disk(c.tile, c.radius || 3)) {
    if (w.owner[t] !== civ.id || (gv && gv.blocked.includes(t)) || !g.canPlace(civ, type, t, true)) continue;
    let s = -dist(c.tile, t);
    if (type === 'farm') { s = TERRAIN[w.terr[t]].fert * 4 + (w.river[t] ? 1 : 0) - dist(c.tile, t) * 0.3; if (w.res[t]) s -= 3; }
    else if (type === 'mine') s = (w.res[t] === RES.IRON ? 3 : 2) - dist(c.tile, t) * 0.2;
    else if (BUILDINGS[type].place === 'flat' && (w.res[t] || w.terr[t] === T.FOREST || TERRAIN[w.terr[t]].fert > 0.8)) s -= 2;
    if (w.stab[t] < 0.3) s -= 3;
    if (w.ash[t] > 0 || w.lava[t] > 0) s -= 5;
    if (g.ruins.has(t) && g.ruins.get(t).type === type) s += 4;      // rebuilding a ruin is cheaper
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

export function governorStep(g, dt) {
  for (const c of g.cities.values()) {
    const gv = c.governor; if (!gv || !gv.enabled) continue;
    const civ = g.civs[c.owner]; if (!civ || !civ.alive) continue;
    if (g.time < gv.next) continue;
    gv.next = g.time + (civ.isAI ? 2 : 3) + (c.id % 3) * 0.3;
    gv.queue = gv.queue.filter((id) => { const b = g.buildings.get(id); return b && !b.done; });
    // each area of responsibility gets its own turn so construction never starves roads or the garrison
    gv.turn = ((gv.turn || 0) + 1) % 4;
    const did = (gv.perms.repair && repair(g, civ, c, gv)) || false;
    if (!did && gv.perms.build && (gv.turn !== 1 || !gv.perms.roads)) build(g, civ, c, gv);
    if (gv.perms.roads && gv.turn === 1) roads(g, civ, c, gv);
    if (gv.perms.recruit && gv.turn === 2) recruit(g, civ, c, gv);
    if (gv.perms.settle && gv.turn === 3) settle(g, civ, c, gv);
  }
}

function repair(g, civ, c, gv) {
  for (const b of g.buildings.values()) {
    if (b.cityId !== c.id || b.owner !== civ.id || !b.done || b.hp >= b.maxHp * 0.7 || g.time - (b.lastHit || -99) < 8) continue;
    const cost = { materials: Math.ceil(10 + (BUILDINGS[b.type].cost.materials || 40) * 0.2) };
    if (!governorCanSpend(civ, gv, cost)) return false;
    g.pay(civ, cost); b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.4);
    log(g, c, `Repaired ${BUILDINGS[b.type].name} (${Math.round((100 * b.hp) / b.maxHp)}%) for ${cost.materials} materials.`);
    return true;
  }
  // clear rubble that blocks good sites
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

function build(g, civ, c, gv) {
  const busy = gv.queue.length > (civ.isAI ? 1 : 0);
  for (const [type, reason] of cityNeeds(g, civ, c, gv.spec)) {
    if (busy && type !== 'farm' && type !== 'house' && type !== 'power_plant') continue;
    // don't add more of something whose existing copies stand idle (no workers or no inputs)
    const def = BUILDINGS[type];
    if (def.jobs) {
      const idle = [...g.buildings.values()].some((b) => b.type === type && b.owner === civ.id && (b.cityId === c.id || def.power) && (!b.done || b.staffed === 0 || (def.power > 0 && civ.powerGen === 0 && b.staffed > 0 && type === 'power_plant' && civ.res.ore < 1)));
      if (idle) { if (!gv.idleNoted || gv.idleNoted !== type) { gv.idleNoted = type; log(g, c, `Holding off on another ${def.name}: existing ones are idle or under construction.`); } continue; }
    }
    const cost = g.buildingCost(civ, type, null);
    if (!governorCanSpend(civ, gv, cost)) continue;
    const t = pickTile(g, civ, c, type, gv);
    if (t < 0) continue;
    const res = g.command(civ.id, { c: 'build', type, tile: t, by: 'governor:' + c.name, why: reason });
    if (res && res.error) continue;
    const b = g.buildingAtTile(t);
    if (b) gv.queue.push(b.id);
    log(g, c, `Building ${BUILDINGS[type].name}: ${reason}.`);
    return true;
  }
  return false;
}

function bestRoadType(civ) { for (let t = 3; t >= 1; t--) if (!ROAD_TYPES[t].tech || civ.techs.has(ROAD_TYPES[t].tech)) return t; return 1; }

function roads(g, civ, c, gv) {
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
  if (!governorCanSpend(civ, gv, plan.cost)) return false;
  if (g.roads.startProject(g, civ, plan).error) return false;
  gv.noRouteNoted = false;
  log(g, c, `Building ${ROAD_TYPES[type].name.toLowerCase()} to ${hub.name} (${plan.length} hexes, ${plan.bridges} bridges) to rejoin the supply network.`);
  return true;
}

function recruit(g, civ, c, gv) {
  if (c.pop < 8) return false;
  const military = [...g.units.values()].filter((u) => u.owner === civ.id && !UNITS[u.type].civilian).length;
  if (military >= Math.max(4, civ.popTotal / 4)) return false;
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
      if (g.command(civ.id, { c: 'train', building: b.id, unit: u })) continue;
      log(g, c, `Recruiting ${UNITS[u].name} for the garrison (${garrison}/${want}${threat ? `, ${threat} hostiles nearby` : ''}).`);
      return true;
    }
  }
  return false;
}

function settle(g, civ, c, gv) {
  if (c.pop < 12 || g.cityOf(civ).length >= 8) return false;
  const b = g.buildings.get(c.buildingId); if (!b || b.queue.length) return false;
  if ([...g.units.values()].some((u) => u.owner === civ.id && u.type === 'colonist')) return false;
  if (!governorCanSpend(civ, gv, g.unitCost(civ, 'colonist'))) return false;
  if (g.command(civ.id, { c: 'train', building: b.id, unit: 'colonist' })) return false;
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
  let best = -1, bs = 3;
  for (const c of g.cityOf(civ)) for (const t of disk(c.tile, 20)) {
    if (dist(c.tile, t) < 6 || !civ.explored[t]) continue;
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
