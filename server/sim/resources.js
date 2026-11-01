// Resource explanations. For every good: what it is, what makes it, what uses it, which technology
// unlocks its producers, where they can be built, why the stock is rising or falling (from the
// ledger), and what the player can do next. The same analysis feeds the resource panel, the
// production chains and the shortage alerts, so they never disagree.
import { BUILDINGS, UNITS, TECHS, GOODS, GOOD_NAMES, RES, RESOURCE, TERRAIN, T, N, IMPORT_PRICE, isWater } from './constants.js';
import { ledgerFor } from './ledger.js';

export const RESOURCE_INFO = {
  food: { title: 'Food', kind: 'Provisions', what: 'Feeds your population and the army in the field. Cities that run out starve and shrink.' },
  materials: { title: 'Materials', kind: 'General construction materials', what: 'Timber, stone and recovered salvage: the basic input for almost every building, road and fieldwork.' },
  ore: { title: 'Ore', kind: 'Raw industrial minerals', what: 'Iron and coal dug from deposits. Steel mills turn it into steel; power plants burn it.' },
  steel: { title: 'Steel', kind: 'Processed industrial material', what: 'Made from ore in steel mills. Vehicles, advanced buildings and munitions need it.' },
  fuel: { title: 'Fuel', kind: 'Vehicle and aircraft fuel', what: 'Pumped by oil wells. Vehicles and aircraft burn it while they operate.' },
  munitions: { title: 'Munitions', kind: 'Ammunition and military supplies', what: 'Made from steel in munitions plants. Artillery, modern units and air defenses fire it.' },
  electronics: { title: 'Electronics', kind: 'Advanced industrial components', what: 'Made in electronics plants, which need the Computing technology and access to rare earths.' },
  credits: { title: 'Credits', kind: 'Money', what: 'Not mined: earned from taxes, markets and trade, and spent on construction, training, upkeep and imports.' },
};

// where each placement rule lets a building go, in words
export const PLACE_INFO = {
  farm: 'grassland, plains, hills, forest, tundra, marsh, ash, or desert on a river',
  forest: 'forest hexes',
  quarry: 'hills, mountains or a stone deposit',
  mine: 'an iron or coal deposit',
  oil: 'an oil deposit',
  ruins: 'old ruins (salvage sites)',
  coast: 'land next to the open sea',
  flat: 'any land except mountains and marsh',
  any: 'anywhere in or next to your territory',
};
// what the client should highlight for "Find deposits / sites" for a building
export const SITE_HINT = {
  mine: { res: [RES.IRON, RES.COAL] }, oil_well: { res: [RES.OIL] }, quarry: { res: [RES.STONE], terr: [T.HILLS, T.MOUNTAIN] },
  salvage: { res: [RES.RUINS] }, lumber: { terr: [T.FOREST] }, farm: { terr: [T.GRASS, T.PLAINS] }, port: { coast: true },
};

const producersOf = (k) => Object.entries(BUILDINGS).filter(([t, d]) => d.produce && d.produce[k] && !d.rebelOnly).map(([t]) => t);
const consumersOf = (k) => Object.entries(BUILDINGS).filter(([, d]) => d.consume && d.consume[k]).map(([t]) => t);

// placement check without tech, age or cost (is there anywhere to put one?)
function siteOk(g, civ, type, t) {
  const def = BUILDINGS[type], w = g.world, ter = w.terr[t];
  if (g.tileB[t] >= 0 || isWater(ter) || !Number.isFinite(TERRAIN[ter].move) || ter === T.LAVA) return false;
  if (g.urban?.[t] && type !== 'house') { /* districts still host most buildings */ }
  const ruin = g.ruins.get(t); if (ruin && ruin.type !== type) return false;
  if (def.anywhere) { if (w.owner[t] >= 0 && w.owner[t] !== civ.id) return false; if (w.owner[t] !== civ.id && !civ.supply[t]) return false; }
  else if (w.owner[t] !== civ.id) return false;
  return g.terrainOk(def, t);
}

// counts of usable sites (own territory, free) and known deposits beyond the border (cached 5 s)
export function siteSummary(g, civ, type) {
  const key = type + ':' + Math.floor(g.time / 5);
  const cache = civ._sites || (civ._sites = new Map());
  const hit = cache.get(type); if (hit && hit.key === key) return hit.v;
  let own = 0, beyond = 0;
  const hint = SITE_HINT[type], w = g.world;
  for (let t = 0; t < N; t++) {
    if (!civ.explored[t]) continue;
    if (w.owner[t] === civ.id || (BUILDINGS[type].anywhere && civ.supply[t])) { if (siteOk(g, civ, type, t)) own++; }
    else if (hint?.res && hint.res.includes(w.res[t]) && w.owner[t] < 0 && g.tileB[t] < 0) beyond++;
  }
  const v = { own, beyond };
  cache.set(type, { key, v });
  return v;
}

const WHY = { staff: 'no workers', power: 'no power', full: 'storage full', rare: 'no rare earths', off: 'switched off', locked: 'locked to zero workers' };
export const whyText = (w) => (!w ? '' : w.startsWith('input:') ? 'missing ' + (GOOD_NAMES[w.slice(6)] || w.slice(6)).toLowerCase() : w.startsWith('prio:') ? 'lower labour priority' : WHY[w] || w);

function producerStats(g, civ, type, k) {
  const d = BUILDINGS[type];
  const list = [...g.buildings.values()].filter((b) => b.owner === civ.id && b.type === type);
  const done = list.filter((b) => b.done), working = done.filter((b) => b.staffed > 0);
  const reasons = {};
  for (const b of done) if (!(b.staffed > 0) && b.why && b.why !== 'surplus') { const r = whyText(b.why); reasons[r] = (reasons[r] || 0) + 1; }
  for (const b of working) if (b.why && b.why.startsWith('input:')) { const r = whyText(b.why); reasons[r] = (reasons[r] || 0) + 1; }
  const output = civ.grossByType?.[type]?.[k] || 0;
  const per = (d.produce?.[k] || 0) * (d.jobs ? d.jobs[1] : 1);
  return { type, name: d.name, tech: d.tech || null, techKnown: !d.tech || civ.techs.has(d.tech), age: d.age, ageOk: d.age <= civ.age,
    built: done.length, building: list.length - done.length, working: working.length, idle: done.length - working.length, reasons,
    output: +output.toFixed(2), potential: +(per * done.length).toFixed(2), place: PLACE_INFO[d.place] || '', needsRare: d.needs === 'rare' };
}

// The full report for one good. Actions are things the client can do directly.
export function resourceReport(g, civ, k) {
  const info = RESOURCE_INFO[k] || { title: GOOD_NAMES[k] || k, what: '' };
  const led = ledgerFor(civ, k);
  const stock = civ.res[k] || 0;
  const reserved = (civ.saving?.[k] || 0) + (civ.natReserve?.cost?.[k] || 0);
  let local = 0; for (const c of g.cities.values()) if (c.owner === civ.id && c.isolated) local += c.stock?.[k] || 0;
  const net = led.net;
  const lasts = net < -0.01 ? Math.round(stock / -net) : null;
  const producers = producersOf(k).map((t) => producerStats(g, civ, t, k));
  const consumers = consumersOf(k).map((t) => { const n = [...g.buildings.values()].filter((b) => b.owner === civ.id && b.type === t && b.done).length; return { type: t, name: BUILDINGS[t].name, count: n, rate: +((BUILDINGS[t].consume[k] || 0) * (BUILDINGS[t].jobs ? BUILDINGS[t].jobs[1] : 1) * n).toFixed(2) }; }).filter((c) => c.count);
  const units = Object.entries(UNITS).filter(([, u]) => u.cost[k]).length;
  const r = { good: k, title: info.title, kind: info.kind || '', what: info.what, stock: Math.round(stock), cap: k === 'credits' ? null : civ.storage || 0,
    reserved: Math.round(reserved), available: Math.max(0, Math.round(stock - reserved)), local: Math.round(local),
    net: +net.toFixed(2), inflow: +led.inflow.toFixed(2), outflow: +led.outflow.toFixed(2), cats: Object.fromEntries(Object.entries(led.cats).map(([c, v]) => [c, +v.toFixed(3)])), window: civ.ledger?.window || 0,
    lasts, producers, consumers, unitUses: units, status: 'ok', headline: '', cause: '', actions: [], blocked: [] };
  // who is short of it right now
  for (const b of g.buildings.values()) if (b.owner === civ.id && b.why === 'input:' + k) r.blocked.push(b.type);
  r.blocked = [...new Set(r.blocked)].map((t) => BUILDINGS[t].name);
  diagnose(g, civ, r);
  return r;
}

function addAction(r, a) { if (!r.actions.some((x) => x.a === a.a && x.type === a.type && x.tech === a.tech && x.good === a.good)) r.actions.push(a); }

// Why is it short, and what can be done? Never recommends something that cannot work.
function diagnose(g, civ, r) {
  const k = r.good;
  const short = r.lasts != null && r.lasts < 240;
  const empty = r.stock < 5 && r.blocked.length;
  r.status = empty ? 'empty' : short ? 'deficit' : r.net < -0.01 ? 'falling' : 'ok';
  const users = r.blocked.length ? r.blocked.join(' and ') : r.consumers.map((c) => c.name).join(' and ') || 'your economy';
  if (k === 'credits') return diagnoseCredits(g, civ, r);
  const prod = r.producers;
  const unlocked = prod.filter((p) => p.techKnown && p.ageOk);
  const built = prod.filter((p) => p.built > 0);
  const idleStaff = built.reduce((s, p) => s + (p.reasons['no workers'] || 0), 0);
  const idleAll = built.reduce((s, p) => s + p.idle, 0);
  const main = prod.filter((p) => p.type !== 'town').sort((a, b) => (b.techKnown - a.techKnown) || (a.age - b.age))[0];
  if (r.status === 'ok' && r.stock < 20 && !r.inflow && !r.blocked.length) r.headline = `No ${r.title.toLowerCase()} is being produced yet.`;
  else if (r.status === 'ok') { r.headline = r.net > 0.01 ? `${r.title} is growing.` : `${r.title} is stable.`; }
  else r.headline = r.status === 'empty' ? `Out of ${r.title.toLowerCase()}: ${users} cannot work.` : `${r.title} production cannot meet demand.`;
  const causes = [];
  const quiet = r.status === 'ok' && r.inflow > 0;   // nothing to fix: no advice needed beyond the chain
  if (quiet) { r.cause = ''; return; }
  if (!unlocked.length || (main && !main.techKnown && !built.length)) {
    const p = main;
    if (p && p.tech) {
      causes.push(`${p.name}s produce ${r.title.toLowerCase()}, and they require ${TECHS[p.tech].name}.`);
      addAction(r, { a: 'research', tech: p.tech, label: `Research ${TECHS[p.tech].name}` });
      if (p.place) addAction(r, { a: 'find', type: p.type, label: `Find ${p.place.includes('deposit') ? 'deposits' : 'sites'}` });
    }
  } else {
    for (const p of unlocked.filter((x) => x.type !== 'town')) {
      if (p.built && p.idle) {
        const rs = Object.entries(p.reasons).map(([w, n]) => `${n} ${w}`).join(', ');
        causes.push(`${p.idle} of ${p.built} ${p.name}${p.built > 1 ? 's' : ''} idle${rs ? ` (${rs})` : ''}.`);
        addAction(r, { a: 'locate', type: p.type, filter: 'idle', label: `Inspect idle ${p.name}s` });
        for (const w of Object.keys(p.reasons)) if (w.startsWith('missing ')) { const g2 = Object.keys(GOOD_NAMES).find((x) => w === 'missing ' + GOOD_NAMES[x].toLowerCase()); if (g2) addAction(r, { a: 'inspect', good: g2, label: `Why is ${GOOD_NAMES[g2].toLowerCase()} short?` }); }
        if (p.reasons['no workers']) addAction(r, { a: 'housing', label: 'More workers: build housing' });
        if (p.reasons['no power']) addAction(r, { a: 'build', type: 'power_plant', label: 'Build a Power Plant' });
      }
    }
    // build more only when the existing ones are all working (or there are none)
    const cand = unlocked.filter((x) => x.type !== 'town' && x.idle === 0).sort((a, b) => b.potential - a.potential || a.age - b.age)[0] || (!built.filter((x) => x.type !== 'town').length ? unlocked.find((x) => x.type !== 'town') : null);
    if (cand && (r.status !== 'ok' || !cand.built) && !(idleStaff && idleStaff >= idleAll && idleAll > 0)) {
      const sites = siteSummary(g, civ, cand.type);
      if (sites.own > 0) { addAction(r, { a: 'build', type: cand.type, label: `Build ${cand.name}`, sites: sites.own }); addAction(r, { a: 'find', type: cand.type, label: `Find ${cand.place.includes('deposit') ? 'deposits' : 'sites'}` }); if (!cand.built) causes.push(`Build a ${cand.name} on ${cand.place}.`); }
      else {
        causes.push(`No free ${cand.place} in your territory${sites.beyond ? `; ${sites.beyond} known beyond your borders` : ''}.`);
        addAction(r, { a: 'find', type: cand.type, label: sites.beyond ? 'Show deposits beyond the border' : 'Find sites', disabled: !sites.beyond, why: sites.beyond ? '' : 'none discovered yet: explore' });
        addAction(r, { a: 'expand', label: 'Expand toward a deposit (found a city)' });
      }
      if (cand.needsRare && !g.civHasResource(civ, RES.RARE) && !civ.techs.has('materials_recycling')) causes.push('Electronics plants also need rare earths: a deposit in your territory, a trade partner with one, or Materials Recycling.');
    }
    if (r.consumers.length && r.status !== 'ok') causes.push(`Used by ${r.consumers.map((c) => `${c.count} ${c.name}${c.count > 1 ? 's' : ''}`).join(', ')}.`);
  }
  if (IMPORT_PRICE[k] && r.status !== 'ok') {
    const market = civ.techs.has('trade_networks') && [...g.buildings.values()].some((b) => b.owner === civ.id && b.type === 'market' && b.done);
    addAction(r, { a: 'import', good: k, label: `Import ${r.title.toLowerCase()}`, disabled: !market, why: market ? '' : civ.techs.has('trade_networks') ? 'needs a market' : 'needs Trade Networks and a market' });
  }
  if (k === 'food' && r.status !== 'ok') addAction(r, { a: 'build', type: 'farm', label: 'Build a Farm' });
  r.cause = causes.join(' ');
}

function diagnoseCredits(g, civ, r) {
  const c = r.cats;
  const income = ['taxes', 'commerce', 'trade', 'production', 'imports', 'salvage', 'refunds', 'diplomacy'].map((x) => [x, Math.max(0, c[x] || 0)]).filter(([, v]) => v > 0);
  const expense = ['army', 'maintenance', 'construction', 'training', 'research', 'imports', 'diplomacy'].map((x) => [x, Math.max(0, -(c[x] || 0))]).filter(([, v]) => v > 0);
  r.income = Object.fromEntries(income.map(([x, v]) => [x, +v.toFixed(2)])); r.expense = Object.fromEntries(expense.map(([x, v]) => [x, +v.toFixed(2)]));
  if (r.status === 'ok') { r.headline = r.net > 0 ? 'The treasury is growing.' : 'The treasury is stable.'; return; }
  r.headline = 'Spending exceeds income.';
  const top = expense.sort((a, b) => b[1] - a[1])[0];
  const NAMES = { army: 'army upkeep', maintenance: 'building maintenance', construction: 'construction', training: 'training', research: 'the era advance', imports: 'imports', diplomacy: 'diplomatic payments' };
  r.cause = top ? `The largest expense is ${NAMES[top[0]]} (${top[1].toFixed(1)}/s).` : '';
  if (top && top[0] === 'army') r.cause += ' Army upkeep grows faster than the army: disband or refit obsolete units.';
  addAction(r, { a: 'tax', label: 'Review taxes' });
  if (civ.techs.has('trade_networks')) addAction(r, { a: 'build', type: 'market', label: 'Build a Market' });
  else addAction(r, { a: 'research', tech: 'trade_networks', label: 'Research Trade Networks (markets)' });
  addAction(r, { a: 'diplomacy', label: 'Seek trade agreements' });
}

export function resourcesReport(g, civ) { const out = {}; for (const k of GOODS) out[k] = resourceReport(g, civ, k); return out; }

// Shortage alerts: specific, with the cause and the actions (the client renders them).
export function shortageAlerts(g, civ) {
  if (!civ.human || !civ.alive) return;
  const rep = civ._resReport && civ._resReport.at > g.time - 2 ? civ._resReport.v : resourcesReport(g, civ);
  const last = civ.shortAlerted || (civ.shortAlerted = {});
  for (const k of GOODS) {
    const r = rep[k]; if (r.status !== 'deficit' && r.status !== 'empty') continue;
    if (g.time - (last[k] ?? -1e9) < 150) continue;
    if ((civ.ledger?.window || 0) < 10) continue;      // not enough history to judge yet
    last[k] = g.time;
    g.notify(civ.id, `${r.headline} ${r.cause}`.trim(), { kind: 'shortage', good: k, level: r.status === 'empty' || k === 'food' ? 'major' : 'minor' });
  }
}
void RESOURCE;
