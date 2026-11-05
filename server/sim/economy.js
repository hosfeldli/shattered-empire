import { nativeRules, tempo, movementRate, techEnabled } from './rulesets.js';
// Economy & population: jobs, production chains with a power grid, food, taxes, stability,
// growth, unrest & rebellion, migration, territory, and road-connected trade routes.
import { jobSlots, outMul, cityTier, CITY_TIERS } from './levels.js';
import { revoltBlocked, noteRevolt, afterCapture } from './cities.js';
import { ACTIVITY } from './logistics.js';
import { book, ledgerStep } from './ledger.js';
import { N, T, TERRAIN, BUILDINGS, UNITS, TECHS, TAX, RES, GOODS, ROAD_TYPES, PORT_FREIGHT, LOCAL_STORE, isWater, aiProfile, techFx, GOVS, TECH_CAT } from './constants.js';
import { NB, disk, dist } from './hex.js';
import { allocate } from './workforce.js';
import { labor, populationStep, crowdingPenalty, hasServices, migrationStep as migrate } from './population.js';

const BASE_PRIORITY = { town: 120, farm: 100, port: 95, lumber: 70, quarry: 66, salvage: 68, mine: 64, oil_well: 63, power_plant: 80, fusion_plant: 82, steel_mill: 60, munitions_plant: 52, electronics_plant: 54, market: 56, academy: 55, university: 52 };
const FOCUS_BONUS = {
  balanced: {},
  food: { farm: 20, port: 20 },
  industry: { lumber: 30, quarry: 30, salvage: 30, mine: 30, oil_well: 30, steel_mill: 35, electronics_plant: 30 },
  commerce: { market: 45, port: 15 },
  science: { academy: 45, university: 45 },
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
// people eat this much food per second; farms feed several people per farmer
export const FOOD_PER_POP = 0.085;
// freight over our own land without a road (cart tracks): enough to share food and some goods
export const OVERLAND_FREIGHT = 6;
// housing blocks: homes per level grow with the era (taller blocks, then apartment towers)
export const HOUSE_LEVEL = [1, 2.4, 4.2];
export function houseCapacity(civ, b) { return Math.round((6 + 2 * Math.min(4, civ.age)) * HOUSE_LEVEL[Math.max(0, Math.min(2, (b.level || 1) - 1))]); }

// Land around an extraction site: each neighbouring hex of the right kind adds 15% (timber from
// woods, stone from hills and mountains, harvests from open fertile land, catches from open sea).
const SITE_LAND = {
  lumber: (t) => t === T.FOREST,
  quarry: (t) => t === T.HILLS || t === T.MOUNTAIN,
  mine: (t) => t === T.HILLS || t === T.MOUNTAIN,
  farm: (t) => t === T.GRASS || t === T.PLAINS,
  port: (t) => t === T.SHALLOW || t === T.DEEP,
};
export function siteBonus(g, b) {
  const f = SITE_LAND[b.type]; if (!f) return 1;
  let n = 0; for (let d = 0; d < 6; d++) { const k = NB[b.tile * 6 + d]; if (k >= 0 && f(g.world.terr[k])) n++; }
  return 1 + 0.15 * n;
}

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
    // overland link: cities inside one unbroken stretch of our territory reach the capital by cart
    // tracks even without a road (low freight); only enemy land or open water cuts a city off
    const land = new Uint8Array(N); { const q = [cap.tile]; land[cap.tile] = 1; for (let qi = 0; qi < q.length; qi++) { const i = q[qi]; for (let d = 0; d < 6; d++) { const n = NB[i * 6 + d]; if (n >= 0 && !land[n] && g.world.owner[n] === civ.id && !isWater(g.world.terr[n])) { land[n] = 1; q.push(n); } } } }
    for (const c of g.cityOf(civ)) {
      let t = width[c.tile] >= 0 ? c.tile : -1;
      if (t < 0) for (let d = 0; d < 6; d++) { const n = NB[c.tile * 6 + d]; if (n >= 0 && width[n] > (t >= 0 ? width[t] : -1)) t = n; }
      if (t < 0 && land[c.tile]) { width[c.tile] = Math.max(width[c.tile], OVERLAND_FREIGHT); t = c.tile; }
      else if (t >= 0 && land[c.tile] && width[t] < OVERLAND_FREIGHT) width[t] = OVERLAND_FREIGHT;
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
  if ((g.fallout?.get(t) || 0) > g.time) return 0;                     // fallout: nothing can be grown
  const scar = g.intensity?.get(t)?.st || 0; if (scar >= 2) return 0.15;   // fields turned to no man's land
  let y = TERRAIN[w.terr[t]].fert;
  if (w.terr[t] === T.HILLS) y = Math.max(y, 0.55);       // terraced fields
  if (w.terr[t] === T.FOREST) y = Math.max(y, 0.5);       // cleared woodland
  let river = w.river[t];
  for (let d = 0; d < 6 && !river; d++) { const n = NB[t * 6 + d]; if (n >= 0 && w.river[n]) river = 1; }
  if (river) y += 0.35;
  y *= 0.75 + 0.5 * w.moist[t];
  if (w.drought[t] > 0) y *= 0.35;
  if (w.ash[t] > 0) y *= 0.3;
  if (civ.techs.has('agronomy')) y *= 1.25;
  if (civ.techs.has('mechanized_agriculture')) y *= 1.5;
  if (civ.techs.has('climate_engineering')) y *= 1.2;
  y *= 1 + 0.1 * Math.sin((g.time / 600) * Math.PI * 2);   // seasons: a gentle swing, never a disaster
  return y;
}
function farmPer(g, civ, b) {
  const def = BUILDINGS[b.type];
  let v = def.produce.food * outMul(b) * (b.type === 'farm' ? farmYield(g, civ, b) : 1);
  if (!nativeRules(g) && civ.policies.has('rationing')) v *= 1.2;
  return v;
}
export { farmYield };

// pay, spares, fuel and ammunition by unit tier (credits/s, fuel/s)
function upkeepByCiv(g) {
  if (g._upkeepTick === g.tickN) return g._upkeep;
  const m = new Map();
  for (const u of g.units.values()) {
    const d = UNITS[u.type]; if (d.civilian) continue;
    const e = m.get(u.owner) || { credits: 0, fuel: 0 }; m.set(u.owner, e);
    // fixed maintenance (credits) does not depend on activity; operational food and fuel do
    const act = ACTIVITY[u.activity] || ACTIVITY.moving;
    e.credits += (0.02 + 0.012 * d.age + (d.cat === 'artillery' ? 0.008 : 0)) * tempo(g, 'production');
    e.food = (e.food || 0) + 0.05 * (d.air ? 1 : act.food);
    if (d.move !== 'infantry') e.fuel += (0.018 + 0.005 * d.age + (d.air ? 0.01 : 0)) * (d.air ? 1 : act.fuel) * (nativeRules(g) ? movementRate(g, d) : 1);
  }
  g._upkeepTick = g.tickN; g._upkeep = m;
  return m;
}

const SHIP_VALUE = { food: 2, materials: 1, ore: 2.5, steel: 6, fuel: 5, munitions: 5, electronics: 12 };
function shipRank(civ, c, cd, k) {
  const f = cd[k] + (c.stock[k] || 0);
  if (f < 0) return 1000 + (k === 'food' ? 100 : 0);
  if (k === 'food' && (civ.res.food || 0) < 800) return 300;              // feeding the nation comes before industry
  return (civ.saving?.[k] && (civ.res[k] || 0) < civ.saving[k] ? 200 : 0) + ((civ.res[k] || 0) < 50 ? 50 : 0) + (SHIP_VALUE[k] || 1);
}

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
  // limited freight goes first to the city's own shortfalls (food first), then to what the nation
  // is saving for, then by value: steel and fuel before bulk timber and stone
  const order = budget === Infinity ? GOODS : GOODS.filter((k) => k !== 'credits').sort((a, b) => shipRank(civ, c, cd, b) - shipRank(civ, c, cd, a));
  for (const k of order) {
    if (k === 'credits') continue;
    let f = cd[k] + (st[k] || 0);
    st[k] = 0;
    if (f >= 0) {
      const m = Math.min(f, budget); delta[k] += m; budget -= m; shipped += m;
      st[k] = Math.min(LOCAL_STORE, f - m);
    } else {
      // a deficit: import from the nation as far as freight allows, then go short. Food always gets
      // through to a connected city (relief has priority over every other cargo)
      const need = -f;
      const m = Math.min(need, k === 'food' ? Infinity : budget, Math.max(0, civ.res[k] + delta[k]));
      delta[k] -= m; budget -= m; shipped += m;
      if (need - m > 1e-6 && k === 'food') c.localShort = true;
    }
  }
  c.shipped = shipped;
}

// Rare earths: from a deposit in your territory, from a trade partner who has one, or recycled
// from salvage once Materials Recycling is known. Never a single-route dead end.
// is there anything left to research in reach? (otherwise research jobs are wasted labor)
export function researchOpenFor(civ) {
  if (civ.researching || civ.queue?.length) return true;
  for (const [t, x] of Object.entries(TECHS)) if (techEnabled(civ, t) && !civ.techs.has(t) && x.age <= civ.age) return true;
  return false;
}

export function rareAccess(g, civ) {
  if (g.civHasResource(civ, RES.RARE)) return true;
  if (civ.techs.has('materials_recycling')) return true;
  for (const o of g.civs) if (!nativeRules(g) && o !== civ && o.alive && !o.isRebel && g.diplomacy.rel(civ.id, o.id).trade && g.civHasResource(o, RES.RARE)) return true;
  return false;
}

export function economyStep(g, dt) {
  const w = g.world;
  const unitCount = new Map();
  for (const u of g.units.values()) unitCount.set(u.owner, (unitCount.get(u.owner) || 0) + (UNITS[u.type].civilian ? 0.5 : UNITS[u.type].pop === 0 ? 0.3 : 1));
  const vehicles = new Map();
  for (const u of g.units.values()) { const m = UNITS[u.type].move; if (m === 'wheeled' || m === 'tracked' || m === 'aircraft') vehicles.set(u.owner, (vehicles.get(u.owner) || 0) + 1); }
  const byCity = new Map();
  for (const b of g.buildings.values()) {
    if (!b.done) continue;
    let a = byCity.get(b.cityId); if (!a) byCity.set(b.cityId, a = []); a.push(b);
  }
  for (const civ of g.civs) {
    if (!civ.alive || civ.isRebel) continue;
    const cities = g.cityOf(civ);
    if (!cities.length) { g.eliminate(civ); continue; }
    const P = nativeRules(g) ? new Set() : civ.policies, gov = nativeRules(g) ? null : civ.gov;
    const delta = {}; for (const k of GOODS) delta[k] = 0;
    let research = 0.6 + cities.length * 0.15;
    const atWar = g.civs.some((o) => o.alive && !o.isRebel && g.hostile(civ.id, o.id));
    let totalPop = 0;
    const upkeepShare = (0.05 * (unitCount.get(civ.id) || 0)) / cities.length;
    // power grid: generation from staffed plants vs. demand from staffed industry (last tick's staffing)
    // before Electrification, industry runs on furnaces and steam: no grid, but only 70% output
    const pr = civ.techs.has('electrification') ? civ.powerRatio ?? 1 : 0.7;
    let powerGen = 0, powerUse = 0;
    const grossNext = {}, shortNext = new Set(), grossByType = {};
    const researchOpen = researchOpenFor(civ);
    for (const c of cities) {
      const blds = byCity.get(c.id) || [];
      if (!c.stock) c.stock = {};
      const cd = {}; for (const k of GOODS) cd[k] = 0;
      const pool = (k) => (c.isolated && k !== 'credits' ? c.stock[k] || 0 : civ.res[k] || 0);
      // development tier (Town -> City -> Metropolis -> Megacity): set on the hub building too
      const tier = cityTier(civ, c);
      if (tier !== (c.tier || 0)) {
        if (tier > (c.tier || 0) && !civ.isRebel) g.notify(civ.id, `${c.name} has grown into a ${CITY_TIERS[tier].toLowerCase()}: more homes, jobs and output at its centre.`, { kind: 'city', tile: c.tile, level: 'minor' });
        c.tier = tier;
      }
      { const hub = c.buildingId != null ? g.buildings.get(c.buildingId) : null; if (hub) hub.tier = c.tier || 0; }   // never undefined: saves must restore the same object shape
      // the hub houses more as the city develops; blocks gain storeys (see HOUSE_LEVEL)
      let housing = 10 + 5 * Math.min(3, civ.age) + 6 * (c.tier || 0) + (civ.techs.has('mechanized_agriculture') ? 4 : 0);
      for (const b of blds) if (b.type === 'house' && b.done) housing += houseCapacity(civ, b);
      c.housing = housing;
      // jobs: the shared labor allocator (food first, player locks, crews, priorities, runnable only)
      const prio = nativeRules(g) ? {} : FOCUS_BONUS[civ.focus] || {};
      const jobs = { worker: 0, merchant: 0, specialist: 0 };
      const eff = c.stability < 20 ? 0.5 : 0.7 + 0.3 * Math.min(1, c.stability / 60) + (c.stability > 75 ? 0.1 : 0);
      const govMul = (gov === 'federal' ? 1.1 : 1) * (civ.isAI && !civ.isRebel ? aiProfile(civ).adv.econ : 1);
      const fx = techFx(civ);
      const foodTarget = (FOOD_PER_POP * c.pop + upkeepShare) * (civ.focus === 'food' ? 1.6 : pool('food') > 600 ? 0.75 : pool('food') > 250 ? 1.0 : 1.25) - 0.4;
      const sites = blds.filter((b) => !b.done && b.funded).length;
      const alloc = allocate(c, blds, {
        labor: labor(c), foodTarget, sites, foodLow: pool('food') < 1500,
        perFood: (b) => farmPer(g, civ, b) * eff,
        base: (b) => (BASE_PRIORITY[b.type] || 50) + (prio[b.type] || 0) + (b.prio || 0),
        pool, gross: (k) => civ.gross?.[k] || 0,
        full: (k) => (k === 'research' ? !researchOpen : k !== 'credits' && pool(k) >= (c.isolated ? LOCAL_STORE : civ.storage || 1500) * 0.85),
        want: (k) => (civ.saving?.[k] ? 40 : 0) + (civ.short?.has(k) ? 30 : 0) + (k === 'research' ? 10 : 0) - (k !== 'credits' && k !== 'research' && pool(k) > (c.isolated ? LOCAL_STORE : civ.storage || 1500) * 0.5 ? 35 : 0),
        powerOk: !civ.techs.has('electrification') || pr >= 0.5,
        rareOk: rareAccess(g, civ),
      });
      for (const b of blds) if (BUILDINGS[b.type].jobs) { b.staffed = alloc.plan.get(b.id) || 0; b.why = alloc.why.get(b.id) || ''; if (b.why.startsWith('input:')) shortNext.add(b.why.slice(6)); }
      c.unassigned = alloc.unassigned;
      c.jobsOpen = blds.reduce((s2, b) => s2 + (b.done && BUILDINGS[b.type].jobs ? jobSlots(b) - (b.staffed || 0) : 0), 0);
      for (const b of blds) {
        const def = BUILDINGS[b.type];
        const damaged = b.hp < b.maxHp * 0.5 ? 0.5 : 1;          // damaged buildings work at half capacity
        // what this building made this step (shown on the map; not saved)
        if (!b.out) Object.defineProperty(b, 'out', { value: {}, writable: true, enumerable: false });
        b.out = {};
        const made = (k, v) => { b.out[k] = (b.out[k] || 0) + v / dt; };
        // extraction sites yield from the land itself, staffed or not: one good timber mill in a
        // forest does what a row of small ones used to
        if (def.base && b.done && !b.off) {
          const k0 = damaged * outMul(b) * siteBonus(g, b) * eff * govMul * dt * tempo(g, 'production');
          for (const k in def.base) {
            let v = def.base[k] * k0;
            if (b.type === 'farm') v *= farmYield(g, civ, b);
            if (k === 'materials' && P.has('extraction_quotas')) v *= 1.3;
            if ((k === 'ore' || k === 'fuel') && P.has('extraction_quotas')) v *= 1.3;
            if (b.type === 'quarry' && w.res[b.tile] === RES.STONE) v *= 1.5;
            if (b.type === 'mine' && w.res[b.tile] !== RES.IRON && w.res[b.tile] !== RES.COAL) v *= 0.45;
            v *= 1 + (fx[k] || 0);
            made(k, v);
            cd[k] += v; grossNext[k] = (grossNext[k] || 0) + v / dt;
            book(civ, k === 'credits' ? 'commerce' : 'production', k, v);
            const gt = grossByType[b.type] || (grossByType[b.type] = {}); gt[k] = (gt[k] || 0) + v / dt;
          }
          b.active = true;
        }
        if (!def.jobs) { b.why = def.power < 0 && b.queue.length && civ.techs.has('electrification') && pr < 0.6 ? 'power' : ''; if (def.power < 0) powerUse += -def.power * (b.queue.length ? 1 : 0.3); continue; }
        const [kind] = def.jobs;
        const n = b.staffed; jobs[kind] += n;
        b.active = n > 0 || (!!def.base && b.done && !b.off);
        // the allocator explained idle buildings; production below explains limited ones
        if (!n) continue;
        if (def.power > 0) {
          let ok = 1;
          let short = '';
          const pm = outMul(b);
          if (def.consume) for (const k in def.consume) { const need = def.consume[k] * n * pm * dt * tempo(g, 'production'); if (need > 0) { const r = Math.max(0, (pool(k) + cd[k]) / need); if (r < ok) { ok = r; short = k; } } }
          if (ok < 0.5) b.why = 'input:' + short;
          if (def.consume) for (const k in def.consume) { const v = def.consume[k] * n * pm * dt * tempo(g, 'production') * ok; cd[k] -= v; book(civ, 'operations', k, -v); }
          const generatedPower = def.power * n * outMul(b) * ok * damaged * (gov === 'technocracy' ? 1.1 : 1);
          powerGen += generatedPower;
          made('power', generatedPower * dt); // presentation metadata; no new stockpile or simulation effect
          if (b.type === 'fusion_plant') { research += 0.1 * n; made('research', 0.1 * n); }
          continue;
        }
        let ratio = damaged;
        if (def.power < 0) { powerUse += -def.power * n; ratio *= pr; }
        if (def.power < 0 && civ.techs.has('electrification') && pr < 0.6) b.why = 'power';
        if (def.needs === 'rare' && !rareAccess(g, civ)) { ratio = 0; b.why = 'rare'; }
        const before = ratio;
        let short = '';
        const lm = outMul(b);
        if (def.consume) for (const k in def.consume) { const need = def.consume[k] * n * lm * dt * tempo(g, 'production') * ratio; if (need > 0) { const r = Math.max(0, (pool(k) + cd[k]) / (def.consume[k] * n * lm * dt * tempo(g, 'production'))); if (r < ratio) { ratio = r; short = k; } } }
        if (before > 0 && ratio < before * 0.5) b.why = 'input:' + short;
        if (def.consume) for (const k in def.consume) { const v = def.consume[k] * n * lm * dt * tempo(g, 'production') * ratio; cd[k] -= v; book(civ, 'operations', k, -v); }
        if (!def.produce) continue;
        for (const k in def.produce) {
          let v = def.produce[k] * n * lm * dt * eff * govMul * ratio * (k === 'research' ? 1 : tempo(g, 'production'));
          if (b.type === 'farm') v *= farmYield(g, civ, b);
          if (k === 'food') { if (P.has('rationing')) v *= 1.2; if (P.has('total_war')) v *= 0.8; }
          if (k === 'materials') { if (P.has('rationing')) v *= 0.9; if (P.has('extraction_quotas')) v *= 1.3; }
          if (b.type === 'quarry' && w.res[b.tile] === RES.STONE) v *= 1.5;
          if (b.type === 'mine' && w.res[b.tile] !== RES.IRON && w.res[b.tile] !== RES.COAL) v *= 0.45;   // a shaft into bare hills: poor ore
          if ((k === 'ore' || k === 'fuel') && P.has('extraction_quotas')) v *= 1.3;
          if (k === 'credits') { if (gov === 'corporate') v *= 1.3; if (P.has('research_grants')) v *= 0.9; if (P.has('martial_law')) v *= 0.85; if (b.type === 'market' && P.has('free_markets')) v *= 1.3; }
          if (k === 'munitions') { if (P.has('total_war')) v *= 1.3; if (P.has('free_markets')) v *= 0.9; if (P.has('industrial_planning')) v *= 1.3; }
          if (k === 'steel' && P.has('industrial_planning')) v *= 1.3;
          if (gov === 'corporate' && (k === 'steel' || k === 'munitions' || k === 'electronics')) v *= 1.1;
          v *= 1 + (fx[k] || 0) + (k === 'steel' || k === 'munitions' || k === 'electronics' ? fx.industry || 0 : 0);
          made(k, v);
          if (k === 'research') { research += v; continue; }
          cd[k] += v; grossNext[k] = (grossNext[k] || 0) + v / dt;
          book(civ, k === 'credits' && b.type !== 'town' ? 'commerce' : 'production', k, v);
          const gt = grossByType[b.type] || (grossByType[b.type] = {}); gt[k] = (gt[k] || 0) + v / dt;
        }
      }
      c.jobs = jobs;
      c.unemployed = Math.max(0, c.pop - jobs.worker - jobs.merchant - jobs.specialist);
      // the settlement hub itself always yields a little (scavengers, artisans)
      const economicDt = dt * tempo(g, 'production');
      cd.food += 0.4 * economicDt; cd.materials += 0.4 * economicDt; cd.credits += 0.3 * economicDt;
      book(civ, 'production', 'food', 0.4 * economicDt); book(civ, 'production', 'materials', 0.4 * economicDt); book(civ, 'production', 'credits', 0.3 * economicDt);
      cd.food -= FOOD_PER_POP * c.pop * economicDt; book(civ, 'population', 'food', -FOOD_PER_POP * c.pop * economicDt);
      c.foodBal = cd.food / dt;
      const tax = c.pop * (nativeRules(g) ? .06 : TAX[civ.tax].credits) * economicDt * (gov === 'corporate' ? 1.3 : 1) * (P.has('martial_law') ? 0.85 : 1);
      cd.credits += tax; book(civ, nativeRules(g) ? 'commerce' : 'taxes', 'credits', tax);
      if (!nativeRules(g) && c.tradeConnected) { const tr = (1 + (gov === 'corporate' ? 1 : 0)) * dt; cd.credits += tr; book(civ, 'trade', 'credits', tr); }
      // route this city's surplus and needs through its link to the network; what does not reach
      // the national stockpile (freight limits, cut-off cities) is booked as held in city warehouses
      const before = { ...delta };
      shipGoods(civ, c, cd, delta, dt);
      for (const k of GOODS) if (k !== 'credits') { const held = (delta[k] - before[k]) - cd[k]; if (Math.abs(held) > 1e-9) book(civ, 'warehouses', k, held); }
      totalPop += c.pop;
    }
    civ.powerGen = powerGen; civ.powerUse = powerUse; civ.gross = grossNext; civ.short = shortNext; civ.grossByType = grossByType;
    // what the grid would carry if every consumer were staffed (planners size plants on this)
    let potential = 0; for (const c2 of cities) for (const b of byCity.get(c2.id) || []) { const d = BUILDINGS[b.type]; if (b.done && d.power < 0) potential += -d.power * (d.jobs ? d.jobs[1] : 1); }
    civ.powerPotential = potential;
    civ.powerRatio = powerUse > 0 ? Math.min(1, powerGen / powerUse) : 1;
    let nb = 0; for (const c of cities) nb += (byCity.get(c.id) || []).length;
    { const m = nb * (0.01 + 0.008 * civ.age) * dt * tempo(g, 'production'); delta.credits -= m; book(civ, 'maintenance', 'credits', -m); }
    const uc = unitCount.get(civ.id) || 0;
    { const f = (upkeepByCiv(g).get(civ.id)?.food || 0) * dt * tempo(g, 'production'); delta.food -= f; book(civ, 'army', 'food', -f); }      // field rations by activity
    { const p = (civ.age >= 1 ? 0.03 : 0.01) * uc * dt * tempo(g, 'production'); delta.credits -= p; book(civ, 'army', 'credits', -p); }
    for (const o of g.civs) {
      if (o === civ || !o.alive || o.isRebel) continue;
      const rel = g.diplomacy.rel(civ.id, o.id);
      if (!nativeRules(g) && rel.trade) { const v = (1.5 + 0.5 * Math.min(cities.length, g.cityOf(o).length)) * (P.has('free_markets') ? 1.5 : 1) * dt; delta.credits += v; book(civ, 'trade', 'credits', v); }
    }
    // army maintenance grows faster than the army: pay, spares and fuel (logistics, not a hard cap)
    const tierUpkeep = upkeepByCiv(g);
    const nArmy = unitCount.get(civ.id) || 0;
    // operating cost rises with the technology tier: advanced formations are efficient where they
    // are needed and expensive to keep in unnecessary numbers
    const tierCost = tierUpkeep.get(civ.id) || { credits: 0, fuel: 0 };
    civ.upkeep = { credits: +(tierCost.credits * (1 + nArmy / 60)).toFixed(2), fuel: +tierCost.fuel.toFixed(3) };
    delta.credits -= civ.upkeep.credits * dt; book(civ, 'army', 'credits', -civ.upkeep.credits * dt);
    if (civ.upkeep.fuel) { const f = Math.min(civ.res.fuel || 0, civ.upkeep.fuel * dt); delta.fuel -= f; book(civ, 'army', 'fuel', -f); }
    if (P.has('research_grants')) research *= 1.3;
    if (gov === 'technocracy') research *= 1.2;
    research *= 1 + (techFx(civ).research || 0);
    // the government's favoured branches go faster
    if (!nativeRules(g) && civ.researching && GOVS[civ.gov]?.favors?.includes(TECH_CAT[civ.researching])) research *= 1.3;
    // the deeper a nation's knowledge, the harder the next step: every technology known slows research
    research /= 1 + 0.1 * civ.techs.size;
    if (gov === 'junta') research *= 0.85;
    if (civ.isAI && !civ.isRebel) research *= aiProfile(civ).adv.research;
    civ.researchRate = research * tempo(g, 'research');
    // storage capacity: warehouses in each city plus depots; credits are a treasury and uncapped
    let depots = 0; for (const b of g.buildings.values()) if (b.owner === civ.id && b.type === 'depot' && b.done) depots++;
    civ.storage = 1500 + 800 * cities.length + 500 * depots;
    for (const k of GOODS) {
      const raw = civ.res[k] + delta[k];
      const v = Math.max(0, k === 'credits' ? raw : Math.min(civ.storage, raw));
      if (v < raw) book(civ, 'waste', k, v - raw); else if (v > raw) book(civ, 'unmet', k, v - raw);
      civ.res[k] = v;
    }
    civ.rates = delta;
    ledgerStep(civ, dt);
    const starvingNational = civ.res.food <= 0 && delta.food < 0;
    civ.popTotal = totalPop;
    civ.weariness = Math.max(0, civ.weariness - 0.08 * dt * (atWar ? 0.5 : 1.5));
    for (const c of cities) {
      const starving = c.isolated ? c.localShort : starvingNational || c.localShort;
      if (starving && !c.foodShort && !civ.isRebel) g.notify(civ.id, `${c.name} has run out of food!`, { kind: 'famine', tile: c.tile, level: 'critical' });
      c.foodShort = starving;
      const enemyNear = [...g.units.values()].some((u) => g.hostile(u.owner, civ.id) && !UNITS[u.type].civilian && dist(u.tile, c.tile) <= 4);
      let target = 62 + (nativeRules(g) ? 0 : TAX[civ.tax].stab);
      if (nativeRules(g) && c.isolated) target -= 8;
      if (gov === 'federal') target += 10;
      if (gov === 'council') target += 5;
      if (gov === 'technocracy') target -= 6;
      if (gov === 'junta') target -= 8;
      if (P.has('martial_law')) target += 15;
      if (P.has('conscription')) target -= 6;
      if (P.has('public_works')) target -= 4;
      if (P.has('extraction_quotas')) target -= 4;
      if (P.has('total_war')) target -= 10;
      if (P.has('industrial_planning')) target -= 5;
      if (starving) target -= 30;
      if (c.pop > 0) target -= (c.unemployed / c.pop) * 22;
      target -= crowdingPenalty(c);
      if (civ.powerRatio < 0.6 && civ.powerUse > 0) target -= 6;      // blackouts
      target -= Math.min(30, civ.weariness * 0.4 * (gov === 'federal' ? 2 : 1));
      target -= c.disaster;
      target -= c.occupied * 0.5;
      if (enemyNear) target -= 8;
      if ((c.jobs.merchant || 0) > 0) target += 3;
      target += 3 * (c.tier || 0);                          // developed cities have services, policing, pride
      target += techFx(civ).stability || 0;
      // Sprawl: an empire larger than its era can administer is restless everywhere, and every
      // settlement founded in the last few minutes strains the whole nation while it finds its feet.
      { let n = 0, young = 0; for (const o of g.cities.values()) if (o.owner === civ.id) { n++; if (g.time - (o.founded ?? -1e9) < 240 && !o.capital) young++; }
        target -= Math.max(0, n - (3 + civ.age)) * 5 + young * 4; }
      target = Math.max(0, Math.min(100, target));
      c.stability += (target - c.stability) * 0.06 * dt;
      c.disaster = Math.max(0, c.disaster - 0.35 * dt);
      c.occupied = Math.max(0, c.occupied - 0.4 * dt);
      populationStep(g, civ, c, { starving, enemyNear, foodBalance: c.isolated ? c.foodBal ?? 0 : delta.food / dt, foodStock: c.isolated ? c.stock?.food || 0 : civ.res.food, services: hasServices(g, c) }, dt);
      // post-capture stabilization keeps an occupied city from falling apart at once
      if (c.capturedAt != null && g.time - c.capturedAt < 240) c.stability = Math.max(c.stability, 22);
      if (c.stability < 8 && !c.capital && !revoltBlocked(g, c)) {
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
  noteRevolt(g, c, from.id);          // cooldowns: this city ~300 s, the nation ~120 s
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
  if (c.governor) { c.governor.enabled = !!to.isAI; c.governor.level = to.isAI ? 'autonomous' : 'off'; c.governor.log = []; c.governor.queue = []; c.governor.proposals = []; }
  for (const b of g.buildings.values()) if (b.cityId === c.id && b.owner === fromId) { b.owner = to.id; b.queue = []; b.rally = -1; }
  recomputeTerritory(g);
  afterCapture(g, c, fromId);
  const fromCiv = g.civs[fromId];
  if (fromCiv.isRebel) return;
  if (!g.cityOf(fromCiv).length) g.eliminate(fromCiv);
  else if (!g.cityOf(fromCiv).some((x) => x.capital)) { const nc = g.cityOf(fromCiv)[0]; nc.capital = true; }
}

export function migrationStep(g) { migrate(g); }
void T;

// Run the allocator for one city with (optionally) different settings, without changing anything:
// used for the auto-balance preview and by governors to forecast a reassignment.
export function allocationFor(g, civ, c, wf = c.wf) {
  const blds = [...g.buildings.values()].filter((b) => b.cityId === c.id && b.owner === civ.id);
  const pool = (k) => (c.isolated && k !== 'credits' ? c.stock?.[k] || 0 : civ.res[k] || 0);
  const eff = c.stability < 20 ? 0.5 : 0.7 + 0.3 * Math.min(1, c.stability / 60) + (c.stability > 75 ? 0.1 : 0);
  const prio = nativeRules(g) ? {} : FOCUS_BONUS[civ.focus] || {};
  const pr = civ.techs.has('electrification') ? civ.powerRatio ?? 1 : 0.7;
  const foodTarget = FOOD_PER_POP * c.pop * (civ.focus === 'food' ? 1.6 : pool('food') > 600 ? 0.75 : pool('food') > 250 ? 1.0 : 1.25) - 0.4;
  const saved = c.wf, savedFw = c.foodWorkers; c.wf = wf;
  const res = allocate(c, blds, {
    labor: labor(c), foodTarget, sites: blds.filter((b) => !b.done && b.funded).length, foodLow: pool('food') < 1500,
    perFood: (b) => farmPer(g, civ, b) * eff, base: (b) => (BASE_PRIORITY[b.type] || 50) + (prio[b.type] || 0) + (b.prio || 0),
    pool, gross: (k) => civ.gross?.[k] || 0, full: (k) => (k === 'research' ? !researchOpenFor(civ) : k !== 'credits' && pool(k) >= (c.isolated ? LOCAL_STORE : civ.storage || 1500) * 0.85), want: (k) => (civ.saving?.[k] ? 40 : 0) + (civ.short?.has(k) ? 30 : 0) - (k !== 'credits' && pool(k) > (c.isolated ? LOCAL_STORE : civ.storage || 1500) * 0.5 ? 35 : 0), powerOk: !civ.techs.has('electrification') || pr >= 0.3, rareOk: rareAccess(g, civ),
  });
  c.wf = saved; c.foodWorkers = savedFw;
  // rough effect on output per second: each worker's base production
  const effect = {};
  for (const b of blds) {
    const d = BUILDINGS[b.type]; if (!d.jobs || !d.produce) continue;
    const delta = (res.plan.get(b.id) || 0) - (b.staffed || 0); if (!delta) continue;
    for (const [k, v] of Object.entries(d.produce)) effect[k] = +((effect[k] || 0) + v * delta * eff * (b.type === 'farm' ? farmYield(g, civ, b) : 1)).toFixed(2);
  }
  return { ...res, blds, effect };
}
