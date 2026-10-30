// Economy & population simulation: jobs, production chains, food, taxes,
// stability, growth, migration, territory and trade routes.
import { N, T, TERRAIN, BUILDINGS, UNITS, TAX, RES, GOODS, isWater } from './constants.js';
import { NB, disk, dist } from './hex.js';

const BASE_PRIORITY = { town: 120, farm: 100, port: 95, lumber: 70, quarry: 66, mine: 62, market: 56, library: 55, workshop: 50, factory: 50, university: 52, seismic: 40 };
const FOCUS_BONUS = {
  balanced: {},
  food: { farm: 20, port: 20 },
  industry: { lumber: 30, quarry: 30, mine: 30, workshop: 30, factory: 30 },
  commerce: { market: 45, port: 15 },
  science: { library: 45, university: 45, seismic: 30 },
  military: { workshop: 45, factory: 45, mine: 35 },
};

export function recomputeTerritory(g) {
  const w = g.world;
  const best = new Float32Array(N).fill(Infinity);
  const owner = new Int8Array(N).fill(-1);
  for (const c of g.cities.values()) {
    const civ = g.civs[c.owner];
    const rad = Math.min(7, 3 + civ.age + (c.pop > 12 ? 1 : 0) + (c.pop > 25 ? 1 : 0));
    c.radius = rad;
    for (const t of disk(c.tile, rad)) {
      const d = dist(c.tile, t) + c.id * 1e-6;
      if (d < best[t]) { best[t] = d; owner[t] = c.owner; }
    }
  }
  for (let i = 0; i < N; i++) {
    const o = isWater(w.terr[i]) && best[i] > 2 ? -1 : owner[i];
    w.owner[i] = o;
  }
}

// Cities connected to their capital by road form trade routes (+gold). Quakes, lava
// and floods that cut roads break routes — the economy feels the terrain.
export function recomputeTradeNetwork(g) {
  const w = g.world;
  for (const civ of g.civs) {
    if (!civ.alive) continue;
    const cap = g.capital(civ); if (!cap) continue;
    const seen = new Uint8Array(N); const q = [cap.tile]; seen[cap.tile] = 1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (let d = 0; d < 6; d++) {
        const n = NB[i * 6 + d]; if (n < 0 || seen[n]) continue;
        const b = g.buildingAtTile(n);
        const portLink = b && b.type === 'port' && b.owner === civ.id;
        if (!w.road[n] && !portLink) continue;
        seen[n] = 1; q.push(n);
      }
      // ports link to every other own port (sea lanes)
      const b = g.buildingAtTile(i);
      if (b && b.type === 'port' && b.owner === civ.id && b.done) {
        for (const o of g.buildings.values()) if (o.type === 'port' && o.owner === civ.id && o.done && !seen[o.tile]) { seen[o.tile] = 1; q.push(o.tile); }
      }
    }
    for (const c of g.cityOf(civ)) c.tradeConnected = !c.capital && seen[c.tile] === 1;
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
  if (civ.techs.has('agriculture')) y *= 1.25;
  if (civ.techs.has('industrial_agriculture')) y *= 1.5;
  return y;
}

function farmPer(g, civ, b) {
  const def = BUILDINGS[b.type];
  let v = def.produce.food * (b.type === 'farm' ? farmYield(g, civ, b) : 1);
  if (civ.policies.has('agrarian')) v *= 1.2;
  return v;
}

export function economyStep(g, dt) {
  const w = g.world;
  const unitCount = new Map();
  for (const u of g.units.values()) unitCount.set(u.owner, (unitCount.get(u.owner) || 0) + (UNITS[u.type].civilian ? 0.5 : 1));
  const byCity = new Map();
  for (const b of g.buildings.values()) {
    if (!b.done) continue;
    let a = byCity.get(b.cityId); if (!a) byCity.set(b.cityId, a = []); a.push(b);
  }
  for (const civ of g.civs) {
    if (!civ.alive) continue;
    const cities = g.cityOf(civ);
    if (!cities.length) { g.eliminate(civ); continue; }
    const P = civ.policies, gov = civ.gov;
    const delta = {}; for (const k of GOODS) delta[k] = 0;
    let research = 0.6 + cities.length * 0.15;
    const atWar = g.civs.some((o) => o.alive && g.hostile(civ.id, o.id));
    let totalPop = 0;
    const upkeepShare = (0.05 * (unitCount.get(civ.id) || 0)) / cities.length;
    for (const c of cities) {
      const blds = byCity.get(c.id) || [];
      // housing
      let housing = 8 + 4 * civ.age + (civ.techs.has('industrial_agriculture') ? 4 : 0);
      for (const b of blds) if (b.type === 'house') housing += 4 + civ.age;
      c.housing = housing;
      // jobs: feed the city first, then staff industry by priority, then surplus to food
      const prio = FOCUS_BONUS[civ.focus] || {};
      const jobBlds = blds.filter((b) => BUILDINGS[b.type].jobs).sort((a, b) => (BASE_PRIORITY[b.type] + (prio[b.type] || 0)) - (BASE_PRIORITY[a.type] + (prio[a.type] || 0)) || a.id - b.id);
      for (const b of jobBlds) b.staffed = 0;
      let avail = Math.floor(c.pop);
      const jobs = { worker: 0, merchant: 0, specialist: 0 };
      const eff = c.stability < 20 ? 0.5 : 0.7 + 0.3 * Math.min(1, c.stability / 60) + (c.stability > 75 ? 0.1 : 0);
      const govMul = gov === 'democracy' ? 1.1 : 1;
      const foodB = jobBlds.filter((b) => b.type === 'farm' || b.type === 'port').sort((a, b) => farmPer(g, civ, b) - farmPer(g, civ, a));
      const foodTarget = (0.12 * c.pop + upkeepShare) * (civ.focus === 'food' ? 1.6 : civ.res.food > 600 ? 0.75 : civ.res.food > 250 ? 1.0 : 1.25) - 0.4 - (jobBlds.includes(blds.find((x) => x.type === 'town')) ? 0 : 0);
      let foodPlanned = 0;
      for (const b of foodB) {
        if (foodPlanned >= foodTarget || !avail) break;
        const per = farmPer(g, civ, b) * eff;
        const n = Math.min(BUILDINGS[b.type].jobs[1], avail, Math.max(1, Math.ceil((foodTarget - foodPlanned) / Math.max(0.05, per))));
        b.staffed = n; avail -= n; foodPlanned += per * n;
      }
      for (const b of jobBlds) {
        if (b.staffed || foodB.includes(b)) continue;
        const n = Math.min(BUILDINGS[b.type].jobs[1], avail); b.staffed = n; avail -= n;
      }
      for (const b of foodB) { const n = Math.min(BUILDINGS[b.type].jobs[1] - b.staffed, avail); b.staffed += n; avail -= n; }
      for (const b of jobBlds) {
        const def = BUILDINGS[b.type];
        const [kind] = def.jobs;
        const n = b.staffed; jobs[kind] += n;
        if (!n) continue;
        // consumption chains (workshop/factory)
        let ratio = 1;
        if (def.consume) for (const k in def.consume) { const need = def.consume[k] * n * dt; if (need > 0) ratio = Math.min(ratio, Math.max(0, (civ.res[k] + delta[k]) / need)); }
        if (def.consume) for (const k in def.consume) delta[k] -= def.consume[k] * n * dt * ratio;
        for (const k in def.produce) {
          let v = def.produce[k] * n * dt * eff * govMul * ratio;
          if (b.type === 'farm') v *= farmYield(g, civ, b);
          if (k === 'food') { if (P.has('agrarian')) v *= 1.2; if (P.has('total_mobilization')) v *= 0.8; }
          if (k === 'wood' || k === 'stone') { if (P.has('agrarian')) v *= 0.9; }
          if (b.type === 'quarry' && w.res[b.tile] === RES.STONE) v *= 1.5;
          if (k === 'gold') { if (gov === 'republic') v *= 1.25; if (P.has('scholarship')) v *= 0.9; if (P.has('martial_law')) v *= 0.85; if (b.type === 'market') { if (P.has('free_trade')) v *= 1.3; if (civ.techs.has('banking')) v *= 1.25; } }
          if (k === 'equip') { if (P.has('total_mobilization')) v *= 1.3; if (P.has('free_trade')) v *= 0.9; if (b.type === 'factory' && P.has('industrial_planning')) v *= 1.3; }
          if (k === 'ore') {
            const r = w.res[b.tile];
            const key = r === RES.IRON ? 'iron' : r === RES.COAL ? 'coal' : 'gold';
            if (key === 'gold') v *= 0.7;
            if (P.has('mining_guilds')) v *= 1.3;
            delta[key] += v; continue;
          }
          if (k === 'stone' && P.has('mining_guilds')) v *= 1.3;
          if (k === 'research') { research += v; continue; }
          delta[k] += v;
        }
      }
      c.jobs = jobs;
      c.unemployed = Math.max(0, c.pop - jobs.worker - jobs.merchant - jobs.specialist);
      // food & taxes
      delta.food -= 0.12 * c.pop * dt;
      delta.gold += c.pop * TAX[civ.tax].gold * dt * (gov === 'republic' ? 1.25 : 1) * (P.has('martial_law') ? 0.85 : 1);
      if (c.tradeConnected) delta.gold += (1 + (gov === 'republic' ? 1 : 0)) * dt;
      totalPop += c.pop;
    }
    // building upkeep
    let nb = 0; for (const c of cities) nb += (byCity.get(c.id) || []).length;
    delta.gold -= nb * (0.01 + 0.01 * civ.age) * dt;
    // unit upkeep
    const uc = unitCount.get(civ.id) || 0;
    delta.food -= 0.05 * uc * dt;
    delta.gold -= (civ.age >= 1 ? 0.03 : 0.01) * uc * dt;
    // trade agreements with other civs
    for (const o of g.civs) {
      if (o === civ || !o.alive) continue;
      const rel = g.diplomacy.rel(civ.id, o.id);
      if (rel.trade) delta.gold += (1.5 + 0.5 * Math.min(cities.length, g.cityOf(o).length)) * (P.has('free_trade') ? 1.5 : 1) * dt;
    }
    // research modifiers
    if (P.has('scholarship')) research *= 1.3;
    if (gov === 'democracy') research *= 1.2;
    if (gov === 'junta') research *= 0.85;
    civ.researchRate = research;
    // apply
    for (const k of GOODS) civ.res[k] = Math.max(0, civ.res[k] + delta[k]);
    civ.rates = delta;
    const starving = civ.res.food <= 0 && delta.food < 0;
    civ.popTotal = totalPop;
    // war weariness decays
    civ.weariness = Math.max(0, civ.weariness - 0.08 * dt * (atWar ? 0.5 : 1.5));
    // population & stability per city
    for (const c of cities) {
      c.foodShort = starving;
      const enemyNear = [...g.units.values()].some((u) => g.hostile(u.owner, civ.id) && !UNITS[u.type].civilian && dist(u.tile, c.tile) <= 4);
      let target = 62 + TAX[civ.tax].stab;
      if (gov === 'monarchy') target += 10;
      if (gov === 'junta') target -= 8;
      if (gov === 'democracy' && !atWar) target += 8;
      if (P.has('martial_law')) target += 15;
      if (P.has('conscription')) target -= 6;
      if (P.has('road_corvee')) target -= 4;
      if (P.has('total_mobilization')) target -= 10;
      if (P.has('industrial_planning')) target -= 5;
      if (P.has('conservation')) target += 5;
      if (starving) target -= 30;
      if (c.pop > 0) target -= (c.unemployed / c.pop) * 22;
      if (c.pop > c.housing) target -= 10;
      target -= Math.min(30, civ.weariness * 0.4 * (gov === 'democracy' ? 2 : 1));
      target -= c.disaster;
      target -= c.occupied * 0.5;
      if (enemyNear) target -= 8;
      if ((c.jobs.merchant || 0) > 0) target += 3;
      target = Math.max(0, Math.min(100, target));
      c.stability += (target - c.stability) * 0.06 * dt;
      c.disaster = Math.max(0, c.disaster - 0.35 * dt);
      c.occupied = Math.max(0, c.occupied - 0.4 * dt);
      // growth
      if (starving) c.pop = Math.max(1, c.pop - 0.012 * c.pop * dt);
      else if (c.stability >= 20) {
        let gr = 0.008 * c.pop * (1 - c.pop / c.housing) + (c.pop < c.housing ? 0.02 : 0);
        if (P.has('martial_law')) gr *= 0.75;
        if (P.has('frontier') && g.time - c.founded < 300) gr *= 1.5;
        if (c.pop < c.housing) c.pop = Math.min(c.housing, c.pop + gr * dt);
        else c.pop = Math.max(c.housing, c.pop - 0.01 * c.pop * dt);
      }
      // unrest & defection
      if (c.stability < 8 && !c.capital) {
        c.unrestT += dt;
        if (c.unrestT > 45) defect(g, c);
      } else c.unrestT = Math.max(0, c.unrestT - dt);
    }
  }
}

function defect(g, c) {
  const from = g.civs[c.owner];
  let best = null, bs = -1;
  for (const o of g.civs) {
    if (o === from || !o.alive) continue;
    const near = g.cityOf(o).filter((x) => dist(x.tile, c.tile) < 22);
    if (!near.length) continue;
    const avg = near.reduce((s, x) => s + x.stability, 0) / near.length;
    if (avg > bs) { bs = avg; best = o; }
  }
  c.unrestT = 0;
  if (!best || bs < 40) { c.pop *= 0.8; c.stability = 25; g.notify(from.id, `Riots in ${c.name}! The city is in chaos.`, { kind: 'city', tile: c.tile }); return; }
  transferCity(g, c, best);
  g.notify(from.id, `${c.name} has rebelled and joined ${best.name}!`, { kind: 'city', tile: c.tile });
  g.notify(best.id, `The people of ${c.name} have revolted and pledged themselves to you.`, { kind: 'city', tile: c.tile });
}

export function transferCity(g, c, to) {
  const fromId = c.owner;
  c.owner = to.id; c.capital = false; c.stability = 30; c.occupied = 30;
  for (const b of g.buildings.values()) if (b.cityId === c.id && b.owner === fromId) { b.owner = to.id; b.queue = []; b.rally = -1; }
  recomputeTerritory(g);
  const fromCiv = g.civs[fromId];
  if (!g.cityOf(fromCiv).length) g.eliminate(fromCiv);
  else if (!g.cityOf(fromCiv).some((x) => x.capital)) { const nc = g.cityOf(fromCiv)[0]; nc.capital = true; }
}

// People move toward stable, fed, housed cities — within and across borders.
export function migrationStep(g) {
  const cities = [...g.cities.values()];
  const appeal = (c) => c.stability + (c.foodShort ? -30 : 0) + Math.min(15, (c.housing - c.pop) * 2) - c.unemployed * 1.5;
  for (const civ of g.civs) {
    const mine = cities.filter((c) => c.owner === civ.id);
    if (mine.length < 2) continue;
    mine.sort((a, b) => appeal(a) - appeal(b));
    const lo = mine[0], hi = mine[mine.length - 1];
    if (appeal(hi) - appeal(lo) > 15 && lo.pop > 3 && hi.pop < hi.housing) { const m = Math.min(1.5, lo.pop * 0.04); lo.pop -= m; hi.pop += m; }
  }
  for (const a of cities) for (const b of cities) {
    if (a.owner === b.owner || dist(a.tile, b.tile) > 14) continue;
    if (appeal(b) - appeal(a) > 28 && a.pop > 4 && b.pop < b.housing) {
      const m = Math.min(1, a.pop * 0.03); a.pop -= m; b.pop += m;
      if (g.rng() < 0.3) g.notify(a.owner, `Citizens of ${a.name} are emigrating to ${b.name} (${g.civs[b.owner].name}).`, { kind: 'city', tile: a.tile, quiet: true });
    }
  }
}
void T;
