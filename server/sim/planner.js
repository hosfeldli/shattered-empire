// City development planner, shared by human governors and AI empires. Instead of asking "which
// building next?" it asks "what is stopping this city from working or growing?":
//   assess()      food, housing, labor, power, inputs, storage, research, security, transport
//   candidates()  every option incl. doing nothing, scored U = B + R + S - C - D
//                 B benefit (value of output it can actually staff), R urgency of a shortage,
//                 S fit with the city's specialization or goal, C cost, D dependency/risk
// A project wins only if it beats doing nothing; deferrals are explained, not hidden.
import { hostilesNear } from './ai2/Perception.js';
import { BUILDINGS, AGES, RES, TECHS, UNITS, isWater , TECH_GOODS } from './constants.js';
import { disk, dist } from './hex.js';
import { rareAccess } from './economy.js';
import { GROWTH_KINDS } from './governor.js';
import { upgradable, upgradeCost as levelCost, upgradeProblem, jobSlots, LEVEL_OUT, LEVEL_JOBS } from './levels.js';

const VALUE = { food: 1, materials: 1.2, ore: 1.6, steel: 3, fuel: 2.6, electronics: 6, munitions: 2.6, credits: 0.7, research: 2.5 };
export const SPEC_FIT = {
  balanced: {},
  industrial: { mine: 15, steel_mill: 15, power_plant: 12, munitions_plant: 12, oil_well: 12, motor_works: 10, heavy_assembly: 10, electronics_plant: 12 },
  agrarian: { farm: 15, house: 10, port: 12 },
  commercial: { market: 15, port: 12, depot: 10 },
  research: { academy: 15, university: 15, electronics_plant: 6 },
  fortress: { bunker: 15, fort: 15, barracks: 8, depot: 8 },
};
export const GOALS = {
  none: { name: 'No particular goal', fit: {} },
  grow: { name: 'Grow population', fit: { house: 25, farm: 15, market: 8, academy: 5 } },
  steel: { name: 'Increase steel output', fit: { mine: 25, steel_mill: 25, power_plant: 15 } },
  self: { name: 'Become self-sufficient', fit: { farm: 15, lumber: 15, quarry: 12, mine: 10, house: 8 } },
  defense: { name: 'Strengthen defenses', fit: { bunker: 25, fort: 25, barracks: 12, depot: 10 } },
  repair: { name: 'Repair war damage', fit: {} },
  research: { name: 'Become a research centre', fit: { academy: 25, university: 25 } },
};
// buildings whose purpose is national (one copy serves the empire) and so are coordinated
const NATIONAL = new Set(['barracks', 'motor_works', 'heavy_assembly', 'airfield', 'drone_works', 'robotics_complex', 'comms_tower', 'wonder', 'fusion_plant', 'missile_silo']);
const ROUTINE = new Set(['farm', 'house']);
export const isRoutine = (type) => ROUTINE.has(type);

const unlocked = (civ, type) => { const d = BUILDINGS[type]; return d && !d.rebelOnly && type !== 'town' && d.age <= civ.age && (!d.tech || civ.techs.has(d.tech)); };
const cityBlds = (g, c) => [...g.buildings.values()].filter((b) => b.cityId === c.id && b.owner === c.owner);

// how much the empire wants one more unit of a good right now
function demand(g, civ, c, k) {
  const pool = c.isolated && k !== 'credits' ? c.stock?.[k] || 0 : civ.res[k] || 0;
  const cap = c.isolated ? 300 : civ.storage || 1500;
  if (k !== 'credits' && k !== 'research' && pool >= cap * 0.85) return 0;
  let d = 1;
  if (k === 'research') {
    // research is only worth having while there is something to research
    const open = Object.entries(TECHS).some(([t, x]) => !civ.techs.has(t) && x.age <= civ.age);
    if (!open && !civ.researching) return 0;
    return 1 / (1 + (civ.researchRate || 0) / (3 + civ.age * 2));
  }
  if (k === 'credits') d = pool > 5000 ? 0.1 : pool > 1500 ? 0.4 : 1;
  else if (k !== 'research') d = pool < 150 ? 1.6 : pool > cap * 0.6 ? 0.4 : 1;
  if (civ.saving?.[k]) d *= 2;
  if (civ.short?.has(k)) d *= 1.8;
  return Math.min(d, 3);
}

export function assess(g, civ, c) {
  const blds = cityBlds(g, c);
  const idle = {}, open = { n: 0 }, pending = {};
  for (const b of blds) {
    if (!b.done) { pending[b.type] = (pending[b.type] || 0) + 1; if (BUILDINGS[b.type].jobs) open.n += jobSlots(b); continue; }
    const d = BUILDINGS[b.type]; if (!b.done || !d.jobs) continue;
    if (!b.staffed) idle[b.type] = (idle[b.type] || 0) + 1;
    if (b.why === 'staff' || b.why === 'under' || (b.why || '').startsWith('prio:')) open.n += jobSlots(b) - (b.staffed || 0);
  }
  const foodBal = c.isolated ? c.foodBal ?? 0 : (civ.rates?.food || 0) / Math.max(1, g.cityOf(civ).length);
  return {
    blds, idle, pending,
    pop: c.pop, housing: c.housing, crowd: c.pop / Math.max(1, c.housing),
    foodBal, foodLow: (c.isolated ? c.stock?.food || 0 : civ.res.food) < 200,
    // people who could staff something new soon: unemployed now + expected growth - open positions
    laborFree: (c.unassigned || 0) + Math.max(0, (c.growth || 0) * 90) - open.n,
    openJobs: open.n,
    power: { gen: civ.powerGen || 0, use: civ.powerUse || 0, potential: civ.powerPotential || civ.powerUse || 0, grid: civ.techs.has('electrification') },
    short: civ.short || new Set(),
    sites: blds.filter((b) => !b.done).length,
    damaged: blds.filter((b) => b.done && b.hp < b.maxHp * 0.7).length,
    // only what this nation can see (it does not know where enemies are under the fog)
    enemyNear: hostilesNear(g, civ, c.tile, 6).length > 0,
    enemyAirNear: hostilesNear(g, civ, c.tile, 8, { air: true }).length > 0,
    // a settlement near a rival's known cities is on the frontier
    frontier: [...civ.knownCities.values()].some((k) => k.owner !== civ.id && !g.civs[k.owner]?.isRebel && dist(k.tile, c.tile) <= 14),
    isolated: !!c.isolated,
    // free buildable land around the city: when it runs out, cities grow by upgrading instead
    freeLand: (() => { let n = 0; for (const t of disk(c.tile, Math.max(3, c.radius || 3))) if (g.world.owner[t] === civ.id && g.tileB[t] < 0 && !g.urban?.[t] && !isWater(g.world.terr[t])) n++; return n; })(),
  };
}

function produceValue(g, civ, c, type, workers) {
  const d = BUILDINGS[type]; if (!d.produce) return 0;
  let v = 0;
  for (const [k, amt] of Object.entries(d.produce)) v += amt * workers * (VALUE[k] || 1) * demand(g, civ, c, k);
  return v;
}

function blockedNationally(g, civ, type) {
  for (const b of g.buildings.values()) {
    if (b.owner !== civ.id || b.type !== type || !b.done) continue;
    const w = b.why || '';
    if (w === 'power') return 'lack power';
    if (w.startsWith('input:')) return `lack ${w.slice(6)}`;
    if (w === 'rare') return 'lack rare earths';
    if (w === 'full') return 'have nowhere to store their output';
  }
  return null;
}

// The scored option list for one city (best first). Each entry explains itself.
export function candidates(g, civ, c, gv, a = assess(g, civ, c)) {
  const out = [{ kind: 'none', u: 6, reason: 'nothing would clearly improve the city right now' }];
  const deferred = [], starved = new Set();
  const fit = { ...(SPEC_FIT[gv.spec] || {}) };
  for (const [k, v] of Object.entries(GOALS[gv.goal || 'none']?.fit || {})) fit[k] = (fit[k] || 0) + v;
  // a player's Guide Growth plan favours its kind of building in this city
  if (c.plan) for (const k of GROWTH_KINDS[c.plan.kind] || []) fit[k] = (fit[k] || 0) + 14;
  const pool = (k) => (c.isolated && k !== 'credits' ? c.stock?.[k] || 0 : civ.res[k] || 0);
  const has = (type) => a.blds.filter((b) => b.type === type).length;
  const nationHas = (type) => { let n = 0; for (const b of g.buildings.values()) if (b.owner === civ.id && b.type === type) n++; return n; };
  for (const type of Object.keys(BUILDINGS)) {
    if (!unlocked(civ, type) || BUILDINGS[type].obsolete) continue;
    const d = BUILDINGS[type];
    if (d.needs === 'rare' && !rareAccess(g, civ)) { if (fit[type]) deferred.push(`${d.name}: no access to rare earths (deposit, trade partner or recycling)`); continue; }
    let B = 0, R = 0, D = 0; const why = [];
    const S = fit[type] || 0;
    const costV = Object.entries(g.buildingCost(civ, type, null)).reduce((s, [k, v]) => s + v * (VALUE[k] || 1), 0);
    const C = costV * 0.12;
    if (a.pending[type]) continue;                                   // one at a time per city
    // anywhere in the nation, copies that cannot run (power, inputs, rare earths, full storage)
    // mean the problem is upstream: fix that instead of duplicating it
    if (d.jobs) { const stuck = blockedNationally(g, civ, type); if (stuck) { deferred.push(`another ${d.name}: existing ones ${stuck}`); continue; } }
    if (d.jobs) {
      if (a.idle[type]) { deferred.push(`another ${d.name}: ${a.idle[type]} already stand${a.idle[type] > 1 ? '' : 's'} idle`); continue; }
      const workers = Math.min(d.jobs[1], Math.max(0, Math.floor(a.laborFree)));
      // a workplace is only worth building when enough hands are free to run it properly
      if (workers < Math.max(1, Math.ceil(d.jobs[1] * 0.4)) && type !== 'farm') { if (S > 0 || (d.produce && Object.keys(d.produce).some((k) => civ.saving?.[k] || a.short.has(k)))) deferred.push(`${d.name}: no workers to staff it (staff existing jobs or grow the city first)`); continue; }
      // diminishing returns: the fifth academy in a city adds less than the first
      B = (produceValue(g, civ, c, type, Math.max(1, workers)) * 25) / (1 + 0.4 * has(type));
      // supply chain: can the nation's input supply carry one more of these?
      let chainOk = true;
      if (d.consume) for (const k of Object.keys(d.consume)) {
        const need = d.consume[k] * d.jobs[1];
        const supply = (civ.gross?.[k] || 0) + pool(k) / 300;
        let used = 0; for (const b of g.buildings.values()) if (b.owner === civ.id && b.done && b.staffed && BUILDINGS[b.type].consume?.[k]) used += BUILDINGS[b.type].consume[k] * b.staffed;   // working consumers only
        if (supply - used < need * 0.5) { starved.add(k); chainOk = false; deferred.push(`another ${d.name}: ${k} supply only carries ${Math.max(0, Math.floor(supply / need))}`); }
      }
      if (!chainOk) continue;
      if (d.power < 0 && a.power.grid && a.power.potential > a.power.gen) { deferred.push(`another ${d.name}: the grid cannot power the ones already built`); continue; }
      if (d.produce && Object.keys(d.produce).every((k) => demand(g, civ, c, k) === 0)) { deferred.push(`${d.name}: storage for its output is already full`); continue; }
    }
    switch (type) {
      case 'house':
        if (has('house') >= g.maxHouses(civ)) { if (a.crowd > 0.85) deferred.push(`more Housing Blocks: the ${has('house')} allowed this era are built (raise their storeys, or advance an era)`); continue; }
        B = a.crowd > 0.85 ? 45 : a.crowd > 0.7 ? 18 : 0; if (a.laborFree < 0) B *= 0.5; why.push(`population ${Math.floor(a.pop)} of housing ${a.housing}`); break;
      case 'farm':
        if (a.idle.farm || a.idle.port) continue;                  // surplus farms already exist
        if (a.foodLow || (a.foodBal < 0 && pool('food') < 600)) { R = 45; why.push(`food balance ${a.foodBal.toFixed(1)}/s, ${Math.floor(pool('food'))} in store`); } else continue;
        break;
      case 'port': {
        if (a.isolated) { R += 25; why.push('cut off: a port opens a sea lane'); break; }
        // a sea lane needs a port at both ends: a connected city builds one when others are cut off
        const cutOff = g.cityOf(civ).some((x) => x.isolated);
        if (cutOff && ![...g.buildings.values()].some((o) => o.type === 'port' && o.owner === civ.id && !g.cities.get(o.cityId)?.isolated)) { R += 30; why.push('cities are cut off overseas: this end of the sea lane'); }
        break;
      }
      case 'power_plant': case 'fusion_plant':
        // demand counts idle consumers too: a mill without power never shows up as load
        if (a.power.grid && a.power.potential > a.power.gen * 0.95) { R = Math.min(160, 50 + 1.2 * (a.power.potential - a.power.gen));   // urgency grows with the industry it would unblock
           why.push(`power demand ${a.power.potential.toFixed(0)} exceeds generation ${a.power.gen.toFixed(0)}`); } else continue;
        if (type === 'power_plant' && pool('ore') < 20 && !(civ.gross?.ore > 0)) { D += 30; why.push('plants burn ore'); }
        break;
      case 'mine': if (civ.saving?.steel || a.short.has('ore') || pool('ore') < 50) { R = 25; why.push('steel industry needs ore'); } break;
      case 'oil_well': if (civ.saving?.fuel || pool('fuel') < 80) { R = 22; why.push('fuel for vehicles and the next era'); } break;
      case 'steel_mill': if (civ.saving?.steel || pool('steel') < 120) R = 22; if (!(civ.gross?.ore > 0) && pool('ore') < 30) { D += 35; why.push('no ore coming in yet'); } break;
      case 'munitions_plant': if (pool('munitions') < 120 && civ.age >= 1) R = 18; break;
      case 'electronics_plant': if (civ.saving?.electronics || pool('electronics') < 80) R = 25; break;
      case 'academy': case 'university': R = civ.researching ? 8 : 0; break;
      case 'market':
        // the world market is the way past a missing deposit: one market comes first when the nation needs imports
        if (civ.needsMarket && !nationHas('market')) { B = 75; why.push(`buy ${civ.needsMarket} on the world market (no deposit to extract it)`); break; }
        if (pool('credits') > 3000) continue; break;
      case 'bunker': case 'fort': if (a.enemyNear) { R = 30; why.push('enemies within reach'); } else if (!S) continue; if (has(type) >= 2 + (type === 'bunker' ? 2 : 0)) continue; B = 10; break;
      case 'guard_post': {
        // cheap early defense for exposed settlements: limited, never the whole starting stockpile
        const exposed = a.enemyNear || a.frontier;
        if (!exposed || has('guard_post') >= (a.enemyNear ? 2 : 1) || nationHas('guard_post') >= g.cityOf(civ).length + 1) continue;
        if (pool('materials') < 90) { deferred.push('Guard Post: keeping materials for the economy first'); continue; }
        R = a.enemyNear ? 28 : 12; why.push(a.enemyNear ? 'enemies within reach of a lightly defended city' : 'an exposed frontier settlement'); break;
      }
      case 'aa_battery': {
        // only against a real aviation threat, around what matters: the capital, airfields, industry
        const air = (civ.seenComp?.air || 0) > 0.05 || a.enemyAirNear;
        if (!air) { if (S) deferred.push('AA Battery: no enemy aircraft seen yet'); continue; }
        const valuable = c.capital || a.blds.some((b) => b.type === 'airfield' || b.type === 'steel_mill' || b.type === 'heavy_assembly' || b.type === 'electronics_plant');
        if (has('aa_battery') >= (valuable ? 2 : 1)) continue;
        R = a.enemyAirNear ? 40 : valuable ? 24 : 10; why.push(a.enemyAirNear ? 'enemy aircraft over the city' : 'protect valuable targets from air attack'); break;
      }
      case 'depot': if (a.isolated || has('depot')) continue; B = c.capital ? 0 : 8; break;
      case 'shield_generator': {
        // a dome over a city that matters, once the enemy is close (or keeps coming back)
        if (has('shield_generator') || !(a.enemyNear || a.damaged >= 2)) continue;
        if (!c.capital && a.blds.length < 8) continue;
        R = a.enemyNear ? 34 : 16; why.push(a.enemyNear ? 'enemy forces close to the city' : 'repeated damage from attacks'); break;
      }
      case 'wonder': if (!civ.isAI || civ.age < 4 || g.cityOf(civ).length < 4) continue; B = 120; break;
      case 'missile_silo': {
        // an endgame project: only for an AI at war (or under threat) with a strong economy, far from the front
        if (!civ.isAI || !c.capital || a.enemyNear) continue;
        const atWar = g.civs.some((o) => o !== civ && o.alive && !o.isRebel && g.hostile(civ.id, o.id));
        if (!atWar || pool('steel') < 900 || pool('credits') < 2500) { if (S) deferred.push('Missile Silo: needs a war and a strong treasury'); continue; }
        B = 40; why.push('strategic deterrent'); break;
      }
      default: break;
    }
    if (NATIONAL.has(type)) {
      const military = BUILDINGS[type].cat === 'military';
      // one city provides it for the nation; the coordinator decides which
      if (nationHas(type) >= (type === 'barracks' ? Math.max(1, Math.ceil(g.cityOf(civ).length / 3)) : 1)) continue;
      if (civ.claims && civ.claims[type] != null && civ.claims[type] !== c.id && g.cities.has(civ.claims[type])) continue;
      // the nation's first vehicle works or airfield is what unlocks a modern army
      B = Math.max(B, military ? 80 + civ.age * 15 + (civ.isAI && civ.personality === 'warlord' ? 20 : 0) : 30); why.push('the nation has none yet');
    }
    const u = B + R + S - C - D;
    out.push({ kind: 'build', type, u, B, R, S, C, D, cost: g.buildingCost(civ, type, null), reason: why.join('; ') || (S ? `fits the city's ${gv.goal && gv.goal !== 'none' ? 'goal' : 'specialization'}` : 'adds useful output') });
  }
  // upstream first: producers of a starved input get the urgency the blocked consumer had
  for (const o of out) {
    const pd = o.type && BUILDINGS[o.type].produce; if (!pd || o.kind !== 'build') continue;
    const k = Object.keys(pd).find((x) => starved.has(x));
    if (k) { o.R += 35; o.u += 35; o.reason = `${k} supply is the bottleneck for existing industry`; }
  }
  // housing upgrades: when the city is crowded, densify the lowest block (needed when no hex is free)
  if (a.crowd > 0.85) {
    const blocks = a.blds.filter((b) => b.type === 'house' && b.done && (b.level || 1) < 3).sort((x, y) => (x.level || 1) - (y.level || 1));
    if (blocks.length) {
      const h = blocks[0], cost = g.upgradeCost(civ, h);
      const costV = Object.entries(cost).reduce((s2, [k, v]) => s2 + v * (VALUE[k] || 1), 0);
      out.push({ kind: 'upgrade', type: 'house', id: h.id, u: 40 + (a.crowd > 1 ? 15 : 0) - costV * 0.12 + (fit.house || 0), cost, reason: `population ${Math.floor(a.pop)} over housing ${a.housing}: add storeys to a housing block` });
    }
  }
  // production upgrades: the same land, more output. Preferred once free land runs short, and for
  // buildings that are fully staffed and whose output is wanted
  {
    const scarce = a.freeLand < 4 ? 1 : a.freeLand < 9 ? 0.5 : 0;
    let best = null;
    for (const b of a.blds) {
      if (!b.done || !upgradable(b.type) || upgradeProblem(civ, b)) continue;
      const L = b.level || 1, slots = jobSlots(b), staffed = b.staffed || 0;
      if (staffed < slots * 0.8 && !scarce) continue;                     // fill it before growing it
      const gain = LEVEL_OUT[L] / LEVEL_OUT[L - 1] - 1;
      const extraJobs = Math.max(0, Math.round(BUILDINGS[b.type].jobs[1] * (LEVEL_JOBS[L] - LEVEL_JOBS[L - 1])));
      const workers = staffed * gain + Math.min(extraJobs, Math.max(0, a.laborFree)) * LEVEL_OUT[L];
      const v = produceValue(g, civ, c, b.type, workers) + (BUILDINGS[b.type].power > 0 && a.power.grid && a.power.gen < a.power.potential ? 10 : 0);
      if (v <= 0) continue;
      const cost = levelCost(b.type, L);
      const costV = Object.entries(cost).reduce((s2, [k, x]) => s2 + x * (VALUE[k] || 1), 0);
      const u = v * 40 + 25 * scarce - costV * 0.06 + (fit[b.type] || 0) * 0.5;
      if (!best || u > best.u) best = { kind: 'upgrade', type: b.type, id: b.id, u, cost, reason: `${scarce ? 'little free land left: ' : ''}expand the ${BUILDINGS[b.type].name} to level ${L + 1} (more jobs, more output per worker)` };
    }
    if (best) out.push(best);
  }
  out.sort((x, y) => y.u - x.u);
  return { list: out, deferred };
}

// AI national coordinator: city roles earned from geography and needs, kept stable.
export function nationalRoles(g, civ) {
  const cities = g.cityOf(civ); if (!cities.length) return;
  civ.roles = civ.roles || {};
  if (g.time < (civ.rolesAt || 0)) return;
  civ.rolesAt = g.time + 300;
  const w = g.world;
  const score = (c) => {
    const s = { industrial: 0, agrarian: 0, commercial: 0, research: 0, fortress: 0 };
    for (const t of disk(c.tile, c.radius || 3)) {
      const r = w.res[t];
      if (r === RES.IRON || r === RES.COAL) s.industrial += 4; if (r === RES.OIL) s.industrial += 3; if (r === RES.STONE) s.industrial += 1;
      if (r === RES.FISH) s.commercial += 2;
      if (w.terr[t] === 2 || w.terr[t] === 3 || w.terr[t] === 12) s.agrarian += 0.6;
      if (w.terr[t] <= 1) s.commercial += 0.4;
    }
    s.research += c.pop * 0.15 + (c.capital ? 6 : 0);
    let near = Infinity; for (const o of g.cities.values()) if (o.owner !== civ.id) near = Math.min(near, dist(o.tile, c.tile));
    if (near < 12) s.fortress += (12 - near) * 1.5;
    return s;
  };
  const counts = {};
  for (const c of cities.sort((a, b) => a.id - b.id)) {
    const s = score(c);
    // diminishing returns: the second breadbasket is worth less than the first
    for (const k in s) s[k] -= (counts[k] || 0) * 4;
    const best = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
    const cur = civ.roles[c.id];
    // hysteresis: keep the current role unless another is clearly better
    const keep = cur && s[cur] != null && s[cur] >= best[1] * 0.7;
    const role = c.capital && !keep && best[1] < 10 ? 'balanced' : keep ? cur : best[0];
    civ.roles[c.id] = role; counts[role] = (counts[role] || 0) + 1;
  }
}
void AGES;

// Technology readiness: the whole blocker chain to the next era and to each locked unit, in words.
export function readiness(g, civ) {
  const next = AGES[civ.age + 1];
  const have = (k) => civ.res[k] || 0;
  const rate = (k) => civ.gross?.[k] || 0;
  const out = { era: null, units: [] };
  const producers = { food: ['farm', 'port'], materials: ['lumber', 'quarry', 'salvage'], ore: ['mine'], steel: ['steel_mill', 'salvage'], fuel: ['oil_well'], munitions: ['munitions_plant'], electronics: ['electronics_plant'], credits: ['market'] };
  const goodBlockers = (k, need) => {
    const list = [];
    if (have(k) >= need) return list;
    const prod = (producers[k] || []);
    const blds = [...g.buildings.values()].filter((b) => b.owner === civ.id && prod.includes(b.type));
    if (!blds.length) {
      const reachable = prod.find((t) => unlocked(civ, t));
      list.push(reachable ? `no ${BUILDINGS[reachable].name.toLowerCase()} yet` : `${prod.map((t) => BUILDINGS[t]?.name).filter(Boolean).join('/')} not unlocked`);
      if (k !== 'credits' && ![...g.buildings.values()].some((b) => b.owner === civ.id && b.type === 'market')) list.push('or import it: build a market (Realm → World market)');
      if (k === 'fuel' || k === 'ore') { const rk = k === 'fuel' ? RES.OIL : RES.IRON; let dep = false; for (let t = 0; t < g.world.res.length && !dep; t++) if (g.world.owner[t] === civ.id && g.world.res[t] === rk) dep = true; if (!dep) list.push(`no ${k === 'fuel' ? 'oil' : 'ore'} deposit in your territory: expand, trade, or import`); }
    }
    const reasons = {};
    for (const b of blds) if (b.why && b.why !== 'surplus' && b.why !== 'under') reasons[b.why] = (reasons[b.why] || 0) + 1;
    for (const [w, n] of Object.entries(reasons)) list.push(`${n} ${BUILDINGS[blds[0].type].name.toLowerCase()}${n > 1 ? 's' : ''}: ${w === 'staff' ? 'no workers' : w === 'power' ? 'no power' : w.startsWith('input:') ? 'no ' + w.slice(6) : w.startsWith('prio:') ? 'lower labor priority' : w}`);
    if (rate(k) > 0) list.push(`+${rate(k).toFixed(1)}/s → about ${Math.ceil((need - have(k)) / rate(k) / 60)} min`);
    return list;
  };
  if (next) {
    const techs = Object.entries(TECHS).filter(([, t]) => t.age === civ.age);
    const known = techs.filter(([k]) => civ.techs.has(k)).length;
    out.era = { name: next.name, techs: [known, next.techsNeeded], cost: {} };
    for (const [k, v] of Object.entries(TECH_GOODS[civ.age + 1] || {})) out.era.cost[k] = { have: Math.floor(have(k)), need: v, blockers: goodBlockers(k, v) };
    if (known < next.techsNeeded) out.era.research = civ.researchRate > 0 ? `${next.techsNeeded - known} more ${AGES[civ.age].name} technologies at ${civ.researchRate.toFixed(1)} research/s` : 'no research: build academies and staff them';
  }
  for (const [k, u] of Object.entries(UNITS)) {
    if (u.civilian || u.age > civ.age + 1) continue;
    const fac = Object.entries(BUILDINGS).find(([, d]) => (d.trains || []).includes(k));
    const needs = [];
    if (u.age > civ.age) needs.push(`era: ${AGES[u.age].name}`);
    if (u.tech && !civ.techs.has(u.tech)) needs.push(`research ${TECHS[u.tech].name}${TECHS[u.tech].req.filter((r) => !civ.techs.has(r)).length ? ` (after ${TECHS[u.tech].req.filter((r) => !civ.techs.has(r)).map((r) => TECHS[r].name).join(', ')})` : ''}`);
    if (fac && ![...g.buildings.values()].some((b) => b.owner === civ.id && b.type === fac[0] && b.done)) needs.push(`a ${fac[1].name}`);
    for (const [g2, v] of Object.entries(u.cost)) if (have(g2) < v) needs.push(`${v} ${g2} (have ${Math.floor(have(g2))}${rate(g2) > 0 ? `, +${rate(g2).toFixed(1)}/s` : ', not produced'})`);
    if (needs.length) out.units.push({ unit: k, needs });
  }
  return out;
}

