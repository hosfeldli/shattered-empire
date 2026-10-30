// Economy & population: jobs, production chains with a power grid, food, taxes, stability,
// growth, unrest & rebellion, migration, territory, and road-connected trade routes.
import { N, T, TERRAIN, BUILDINGS, UNITS, TAX, RES, GOODS, ROAD_TYPES, PORT_FREIGHT, LOCAL_STORE, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';

const BASE_PRIORITY = { town: 120, farm: 100, port: 95, lumber: 70, quarry: 66, salvage: 68, mine: 64, oil_well: 63, power_plant: 80, fusion_plant: 82, steel_mill: 60, munitions_plant: 52, electronics_plant: 54, market: 56, academy: 55, university: 52, seismic: 40 };
const FOCUS_BONUS = {
  balanced: {},
  food: { farm: 20, port: 20 },
  industry: { lumber: 30, quarry: 30, salvage: 30, mine: 30, oil_well: 30, steel_mill: 35, electronics_plant: 30 },
  commerce: { market: 45, port: 15 },
  science: { academy: 45, university: 45, seismic: 30 },
  military: { munitions_plant: 45, steel_mill: 40, mine: 30, oil_well: 30 },
};

export function recomputeTerritory(g) {
  const w = g.world;
  const best = new Float32Array(N).fill(Infinity);
  const owner = new Int8Array(N).fill(-1);
  for (const c of g.cities.values()) {
    const civ = g.civs[c.owner];
    const rad = Math.min(7, 3 + Math.min(3, civ.age) + (c.pop > 14 ? 1 : 0) + (c.pop > 30 ? 1 : 0) - (civ.isRebel ? 1 : 0));
    c.radius = rad;
    for (const t of disk(c.tile, rad)) {
      const d = dist(c.tile, t) + c.id * 1e-6;
      if (d < best[t]) { best[t] = d; owner[t] = c.owner; }
    }
  }
  let changed = false;
  for (let i = 0; i < N; i++) {
    const o = isWater(w.terr[i]) && best[i] > 2 ? -1 : owner[i];
    if (w.owner[i] !== o) { w.owner[i] = o; changed = true; }
  }
  if (changed) g.navVersion++;
}

// The logistics network: cities linked to the capital over intact road/rail edges (or by sea between
// own ports) share the national stockpile, limited by the freight capacity of the weakest link.
// Cities that are cut off live on their own local reserves until a route is restored.
export function recomputeTradeNetwork(g) {
  const roads = g.roads;
  for (const civ of g.civs) {
    if (!civ.alive) continue;
    const cap = g.capital(civ); if (!cap) continue;
    // widest-path search: maximise the bottleneck freight capacity to the capital
    const width = new Float32Array(N).fill(-1);
    const parent = new Int32Array(N).fill(-1);
    width[cap.tile] = Infinity;
    const heap = [[Infinity, cap.tile]];
    const ports = [...g.buildings.values()].filter((o) => o.type === 'port' && o.owner === civ.id && o.done);
    let portsLinked = false;
    while (heap.length) {
      heap.sort((a, b) => a[0] - b[0]);
      const [wd, i] = heap.pop();
      if (wd < width[i]) continue;
      for (let d = 0; d < 6; d++) {
        const n = NB[i * 6 + d]; if (n < 0) continue;
        const e = roads.usable(i, n); if (!e) continue;
        const nw = Math.min(wd, ROAD_TYPES[e.type].freight * (e.cond < 50 ? 0.5 : 1));
        if (nw > width[n]) { width[n] = nw; parent[n] = i; heap.push([nw, n]); }
      }
      const b = g.buildingAtTile(i);
      if (!portsLinked && b && b.type === 'port' && b.owner === civ.id && b.done) {
        portsLinked = true;
        for (const o of ports) { const nw = Math.min(wd, PORT_FREIGHT); if (nw > width[o.tile]) { width[o.tile] = nw; parent[o.tile] = i; heap.push([nw, o.tile]); } }
      }
    }
    for (const c of g.cityOf(civ)) {
      let t = width[c.tile] >= 0 ? c.tile : -1;
      if (t < 0) for (let d = 0; d < 6; d++) { const n = NB[c.tile * 6 + d]; if (n >= 0 && width[n] > (t >= 0 ? width[t] : -1)) t = n; }
      const was = c.isolated;
      c.tradeConnected = !c.capital && t >= 0;
      c.isolated = !c.capital && t < 0;
      c.freight = c.capital ? Infinity : t >= 0 ? width[t] : 0;
      if (was === false && c.isolated && !civ.isRebel) g.notify(civ.id, `${c.name} is cut off from the supply network and must live on local reserves.`, { kind: 'isolated', tile: c.tile, level: 'major' });
      if (was === true && !c.isolated && !civ.isRebel) g.notify(civ.id, `${c.name} is reconnected to the network.`, { kind: 'city', tile: c.tile, level: 'minor' });
      // convoys run along the connecting roads: this is what civilian traffic visuals show
      if (c.tradeConnected) { const amt = 0.5 + Math.min(4, c.pop / 10); let guard = 0; while (t >= 0 && parent[t] >= 0 && guard++ < 600) { roads.noteTraffic(t, parent[t], amt); t = parent[t]; } }
    }
  }
}

function farmYield(g, civ, b) {
  const w = g.world, t = b.tile;
  let y = TERRAIN[w.terr[t]].fert;
  let river = w.river[t];
  for (let d = 0; d < 6 && !river; d++) { const n = NB[t * 6 + d]; if (n >= 0 && w.river[n]) river = 1; }
  if (river) y += 0.35;
  y *= 0.75 + 0.5 * w.moist[t];
  if (w.drought[t] > 0) y *= 0.35;
  if (w.ash[t] > 0) y *= 0.3;
  if (civ.techs.has('agronomy')) y *= 1.25;
  if (civ.techs.has('mechanized_agriculture')) y *= 1.5;
  return y;
}
function farmPer(g, civ, b) {
  const def = BUILDINGS[b.type];
  let v = def.produce.food * (b.type === 'farm' ? farmYield(g, civ, b) : 1);
  if (civ.policies.has('rationing')) v *= 1.2;
  return v;
}
export { farmYield };

// Move a city's net production/consumption between its local warehouse and the national stockpile,
// limited by freight capacity. Isolated cities keep everything (and must cover their needs) locally.
function shipGoods(civ, c, cd, delta, dt) {
  const st = c.stock;
  delta.credits += cd.credits;
  c.localShort = false;
  if (c.isolated) {
    for (const k of GOODS) {
      if (k === 'credits') continue;
      const v = (st[k] || 0) + cd[k];
      if (v < 0 && k === 'food') c.localShort = true;
      st[k] = Math.max(0, Math.min(LOCAL_STORE, v));
    }
    c.shipped = 0;
    return;
  }
  // flows: this tick's net plus any backlog waiting in the local warehouse
  let budget = c.capital || c.freight === Infinity ? Infinity : (c.freight || 0) * dt;
  let shipped = 0;
  for (const k of GOODS) {
    if (k === 'credits') continue;
    let f = cd[k] + (st[k] || 0);
    st[k] = 0;
    if (f >= 0) {
      const m = Math.min(f, budget); delta[k] += m; budget -= m; shipped += m;
      st[k] = Math.min(LOCAL_STORE, f - m);
    } else {
      // a deficit: import from the nation as far as freight allows, then go short
      const need = -f;
      const m = Math.min(need, budget, Math.max(0, civ.res[k] + delta[k]));
      delta[k] -= m; budget -= m; shipped += m;
      if (need - m > 1e-6 && k === 'food') c.localShort = true;
    }
  }
  c.shipped = shipped;
}

export function economyStep(g, dt) {
  const w = g.world;
  const unitCount = new Map();
  for (const u of g.units.values()) unitCount.set(u.owner, (unitCount.get(u.owner) || 0) + (UNITS[u.type].civilian ? 0.5 : UNITS[u.type].pop === 0 ? 0.3 : 1));
  const byCity = new Map();
  for (const b of g.buildings.values()) {
    if (!b.done) continue;
    let a = byCity.get(b.cityId); if (!a) byCity.set(b.cityId, a = []); a.push(b);
  }
  for (const civ of g.civs) {
    if (!civ.alive || civ.isRebel) continue;
    const cities = g.cityOf(civ);
    if (!cities.length) { g.eliminate(civ); continue; }
    const P = civ.policies, gov = civ.gov;
    const delta = {}; for (const k of GOODS) delta[k] = 0;
    let research = 0.6 + cities.length * 0.15;
    const atWar = g.civs.some((o) => o.alive && !o.isRebel && g.hostile(civ.id, o.id));
    let totalPop = 0;
    const upkeepShare = (0.05 * (unitCount.get(civ.id) || 0)) / cities.length;
    // power grid: generation from staffed plants vs. demand from staffed industry (last tick's staffing)
    // before Electrification, industry runs on furnaces and steam: no grid, but only 70% output
    const pr = civ.techs.has('electrification') ? civ.powerRatio ?? 1 : 0.7;
    let powerGen = 0, powerUse = 0;
    for (const c of cities) {
      const blds = byCity.get(c.id) || [];
      if (!c.stock) c.stock = {};
      const cd = {}; for (const k of GOODS) cd[k] = 0;
      const pool = (k) => (c.isolated && k !== 'credits' ? c.stock[k] || 0 : civ.res[k] || 0);
      let housing = 8 + 4 * Math.min(2, civ.age) + (civ.techs.has('mechanized_agriculture') ? 4 : 0);
      for (const b of blds) if (b.type === 'house') housing += 4 + civ.age;
      c.housing = housing;
      // jobs: feed the city first, then staff industry by priority, then surplus to food
      const prio = FOCUS_BONUS[civ.focus] || {};
      const jobBlds = blds.filter((b) => BUILDINGS[b.type].jobs).sort((a, b) => ((BASE_PRIORITY[b.type] || 50) + (prio[b.type] || 0) + (b.prio || 0)) - ((BASE_PRIORITY[a.type] || 50) + (prio[a.type] || 0) + (a.prio || 0)) || a.id - b.id);
      for (const b of jobBlds) b.staffed = 0;
      let avail = Math.floor(c.pop);
      const jobs = { worker: 0, merchant: 0, specialist: 0 };
      const eff = c.stability < 20 ? 0.5 : 0.7 + 0.3 * Math.min(1, c.stability / 60) + (c.stability > 75 ? 0.1 : 0);
      const govMul = gov === 'federal' ? 1.1 : 1;
      const foodB = jobBlds.filter((b) => b.type === 'farm' || b.type === 'port').sort((a, b) => farmPer(g, civ, b) - farmPer(g, civ, a));
      const foodTarget = (0.12 * c.pop + upkeepShare) * (civ.focus === 'food' ? 1.6 : pool('food') > 600 ? 0.75 : pool('food') > 250 ? 1.0 : 1.25) - 0.4;
      let foodPlanned = 0;
      for (const b of foodB) {
        if (foodPlanned >= foodTarget || !avail) break;
        const per = farmPer(g, civ, b) * eff;
        const n = Math.min(BUILDINGS[b.type].jobs[1], avail, Math.max(1, Math.ceil((foodTarget - foodPlanned) / Math.max(0.05, per))));
        b.staffed = n; avail -= n; foodPlanned += per * n;
      }
      for (const b of jobBlds) { if (b.staffed || foodB.includes(b)) continue; const n = Math.min(BUILDINGS[b.type].jobs[1], avail); b.staffed = n; avail -= n; }
      if (civ.res.food < 1500) for (const b of foodB) { const n = Math.min(BUILDINGS[b.type].jobs[1] - b.staffed, avail); b.staffed += n; avail -= n; }
      for (const b of blds) {
        const def = BUILDINGS[b.type];
        const damaged = b.hp < b.maxHp * 0.5 ? 0.5 : 1;          // damaged buildings work at half capacity
        if (!def.jobs) { if (def.power < 0) powerUse += -def.power * (b.queue.length ? 1 : 0.3); continue; }
        const [kind] = def.jobs;
        const n = b.staffed; jobs[kind] += n;
        b.active = n > 0;
        if (!n) continue;
        if (def.power > 0) {
          let ok = 1;
          if (def.consume) for (const k in def.consume) { const need = def.consume[k] * n * dt; if (need > 0) ok = Math.min(ok, Math.max(0, (pool(k) + cd[k]) / need)); }
          if (def.consume) for (const k in def.consume) cd[k] -= def.consume[k] * n * dt * ok;
          powerGen += def.power * n * ok * damaged * (gov === 'technocracy' ? 1.1 : 1);
          if (b.type === 'fusion_plant') research += 0.1 * n;
          continue;
        }
        let ratio = damaged;
        if (def.power < 0) { powerUse += -def.power * n; ratio *= pr; }
        if (def.needs === 'rare' && !g.civHasResource(civ, RES.RARE)) ratio = 0;
        if (def.consume) for (const k in def.consume) { const need = def.consume[k] * n * dt * ratio; if (need > 0) ratio = Math.min(ratio, Math.max(0, (pool(k) + cd[k]) / (def.consume[k] * n * dt))); }
        if (def.consume) for (const k in def.consume) cd[k] -= def.consume[k] * n * dt * ratio;
        if (!def.produce) continue;
        for (const k in def.produce) {
          let v = def.produce[k] * n * dt * eff * govMul * ratio;
          if (b.type === 'farm') v *= farmYield(g, civ, b);
          if (k === 'food') { if (P.has('rationing')) v *= 1.2; if (P.has('total_war')) v *= 0.8; }
          if (k === 'materials') { if (P.has('rationing')) v *= 0.9; if (P.has('extraction_quotas')) v *= 1.3; }
          if (b.type === 'quarry' && w.res[b.tile] === RES.STONE) v *= 1.5;
          if ((k === 'ore' || k === 'fuel') && P.has('extraction_quotas')) v *= 1.3;
          if (k === 'credits') { if (gov === 'corporate') v *= 1.3; if (P.has('research_grants')) v *= 0.9; if (P.has('martial_law')) v *= 0.85; if (b.type === 'market' && P.has('free_markets')) v *= 1.3; }
          if (k === 'munitions') { if (P.has('total_war')) v *= 1.3; if (P.has('free_markets')) v *= 0.9; if (P.has('industrial_planning')) v *= 1.3; }
          if (k === 'steel' && P.has('industrial_planning')) v *= 1.3;
          if (gov === 'corporate' && (k === 'steel' || k === 'munitions' || k === 'electronics')) v *= 1.1;
          if (k === 'research') { research += v; continue; }
          cd[k] += v;
        }
      }
      c.jobs = jobs;
      c.unemployed = Math.max(0, c.pop - jobs.worker - jobs.merchant - jobs.specialist);
      // the settlement hub itself always yields a little (scavengers, artisans)
      cd.food += 0.4 * dt; cd.materials += 0.4 * dt; cd.credits += 0.3 * dt;
      cd.food -= 0.12 * c.pop * dt;
      cd.credits += c.pop * TAX[civ.tax].credits * dt * (gov === 'corporate' ? 1.3 : 1) * (P.has('martial_law') ? 0.85 : 1);
      if (c.tradeConnected) cd.credits += (1 + (gov === 'corporate' ? 1 : 0)) * dt;
      // route this city's surplus and needs through its link to the network
      shipGoods(civ, c, cd, delta, dt);
      totalPop += c.pop;
    }
    civ.powerGen = powerGen; civ.powerUse = powerUse;
    civ.powerRatio = powerUse > 0 ? Math.min(1, powerGen / powerUse) : 1;
    let nb = 0; for (const c of cities) nb += (byCity.get(c.id) || []).length;
    delta.credits -= nb * (0.01 + 0.008 * civ.age) * dt;
    const uc = unitCount.get(civ.id) || 0;
    delta.food -= 0.05 * uc * dt;
    delta.credits -= (civ.age >= 1 ? 0.03 : 0.01) * uc * dt;
    delta.fuel -= 0.01 * [...g.units.values()].filter((u) => u.owner === civ.id && UNITS[u.type].move !== 'infantry').length * dt;
    for (const o of g.civs) {
      if (o === civ || !o.alive || o.isRebel) continue;
      const rel = g.diplomacy.rel(civ.id, o.id);
      if (rel.trade) delta.credits += (1.5 + 0.5 * Math.min(cities.length, g.cityOf(o).length)) * (P.has('free_markets') ? 1.5 : 1) * dt;
    }
    if (P.has('research_grants')) research *= 1.3;
    if (gov === 'technocracy') research *= 1.2;
    if (gov === 'junta') research *= 0.85;
    civ.researchRate = research;
    // storage capacity: warehouses in each city plus depots; credits are a treasury and uncapped
    let depots = 0; for (const b of g.buildings.values()) if (b.owner === civ.id && b.type === 'depot' && b.done) depots++;
    civ.storage = 1500 + 800 * cities.length + 500 * depots;
    for (const k of GOODS) civ.res[k] = Math.max(0, k === 'credits' ? civ.res[k] + delta[k] : Math.min(civ.storage, civ.res[k] + delta[k]));
    civ.rates = delta;
    const starvingNational = civ.res.food <= 0 && delta.food < 0;
    civ.popTotal = totalPop;
    civ.weariness = Math.max(0, civ.weariness - 0.08 * dt * (atWar ? 0.5 : 1.5));
    for (const c of cities) {
      const starving = c.isolated ? c.localShort : starvingNational || c.localShort;
      if (starving && !c.foodShort && !civ.isRebel) g.notify(civ.id, `${c.name} has run out of food!`, { kind: 'famine', tile: c.tile, level: 'critical' });
      c.foodShort = starving;
      const enemyNear = [...g.units.values()].some((u) => g.hostile(u.owner, civ.id) && !UNITS[u.type].civilian && dist(u.tile, c.tile) <= 4);
      let target = 62 + TAX[civ.tax].stab;
      if (gov === 'federal') target += 10;
      if (gov === 'technocracy') target -= 6;
      if (gov === 'junta') target -= 8;
      if (P.has('martial_law')) target += 15;
      if (P.has('conscription')) target -= 6;
      if (P.has('public_works')) target -= 4;
      if (P.has('extraction_quotas')) target -= 4;
      if (P.has('total_war')) target -= 10;
      if (P.has('industrial_planning')) target -= 5;
      if (P.has('conservation')) target += 5;
      if (starving) target -= 30;
      if (c.pop > 0) target -= (c.unemployed / c.pop) * 22;
      if (c.pop > c.housing) target -= 10;
      if (civ.powerRatio < 0.6 && civ.powerUse > 0) target -= 6;      // blackouts
      target -= Math.min(30, civ.weariness * 0.4 * (gov === 'federal' ? 2 : 1));
      target -= c.disaster;
      target -= c.occupied * 0.5;
      if (enemyNear) target -= 8;
      if ((c.jobs.merchant || 0) > 0) target += 3;
      target = Math.max(0, Math.min(100, target));
      c.stability += (target - c.stability) * 0.06 * dt;
      c.disaster = Math.max(0, c.disaster - 0.35 * dt);
      c.occupied = Math.max(0, c.occupied - 0.4 * dt);
      if (starving) c.pop = Math.max(1, c.pop - 0.012 * c.pop * dt);
      else if (c.stability >= 20) {
        let gr = 0.008 * c.pop * (1 - c.pop / c.housing) + (c.pop < c.housing ? 0.02 : 0);
        if (P.has('martial_law')) gr *= 0.75;
        if (P.has('homesteading') && g.time - c.founded < 300) gr *= 1.5;
        if (c.pop < c.housing) c.pop = Math.min(c.housing, c.pop + gr * dt);
        else c.pop = Math.max(c.housing, c.pop - 0.01 * c.pop * dt);
      }
      if (c.stability < 8 && !c.capital) {
        c.unrestT += dt;
        if (c.unrestT > 45) defect(g, c);
      } else c.unrestT = Math.max(0, c.unrestT - dt);
    }
  }
}

// A city in prolonged unrest joins a more stable neighbour — or breaks away to the rebel Free Companies.
function defect(g, c) {
  const from = g.civs[c.owner];
  let best = null, bs = -1;
  for (const o of g.civs) {
    if (o === from || !o.alive || o.isRebel) continue;
    const near = g.cityOf(o).filter((x) => dist(x.tile, c.tile) < 22);
    if (!near.length) continue;
    const avg = near.reduce((s, x) => s + x.stability, 0) / near.length;
    if (avg > bs) { bs = avg; best = o; }
  }
  c.unrestT = 0;
  if (!best || bs < 40) {
    const rebels = g.rebelCiv();
    if (rebels) {
      transferCity(g, c, rebels);
      g.notify(from.id, `${c.name} has risen in revolt and declared for the Free Companies!`, { kind: 'city', tile: c.tile });
      return;
    }
    c.pop *= 0.8; c.stability = 25; g.notify(from.id, `Riots in ${c.name}! The city is in chaos.`, { kind: 'city', tile: c.tile }); return;
  }
  transferCity(g, c, best);
  g.notify(from.id, `${c.name} has rebelled and joined ${best.name}!`, { kind: 'city', tile: c.tile });
  g.notify(best.id, `The people of ${c.name} have revolted and pledged themselves to you.`, { kind: 'city', tile: c.tile });
}

export function transferCity(g, c, to) {
  const fromId = c.owner;
  c.owner = to.id; c.capital = false; c.stability = 30; c.occupied = 30;
  if (c.governor) { c.governor.enabled = !!to.isAI; c.governor.log = []; c.governor.queue = []; }
  for (const b of g.buildings.values()) if (b.cityId === c.id && b.owner === fromId) { b.owner = to.id; b.queue = []; b.rally = -1; }
  recomputeTerritory(g);
  const fromCiv = g.civs[fromId];
  if (fromCiv.isRebel) return;
  if (!g.cityOf(fromCiv).length) g.eliminate(fromCiv);
  else if (!g.cityOf(fromCiv).some((x) => x.capital)) { const nc = g.cityOf(fromCiv)[0]; nc.capital = true; }
}

export function migrationStep(g) {
  const cities = [...g.cities.values()].filter((c) => !g.civs[c.owner].isRebel);
  const appeal = (c) => c.stability + (c.foodShort ? -30 : 0) + Math.min(15, (c.housing - c.pop) * 2) - c.unemployed * 1.5;
  for (const civ of g.civs) {
    const mine = cities.filter((c) => c.owner === civ.id);
    if (mine.length < 2) continue;
    mine.sort((a, b) => appeal(a) - appeal(b));
    const lo = mine[0], hi = mine[mine.length - 1];
    if (appeal(hi) - appeal(lo) > 15 && lo.pop > 8 && hi.pop < hi.housing) { const m = Math.min(1.5, lo.pop * 0.04); lo.pop -= m; hi.pop += m; }
  }
  for (const a of cities) for (const b of cities) {
    if (a.owner === b.owner || dist(a.tile, b.tile) > 14) continue;
    if (appeal(b) - appeal(a) > 28 && a.pop > 8 && b.pop < b.housing) {
      const m = Math.min(1, a.pop * 0.03); a.pop -= m; b.pop += m;
      if (g.rng() < 0.3) g.notify(a.owner, `Citizens of ${a.name} are emigrating to ${b.name} (${g.civs[b.owner].name}).`, { kind: 'city', tile: a.tile, quiet: true });
    }
  }
}
void T;
