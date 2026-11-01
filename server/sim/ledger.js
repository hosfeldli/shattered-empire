// National accounts. Every movement of a good into or out of an empire's national stockpile is
// booked under one category, so the economy screen can say exactly where a gain or a loss comes
// from (and a transfer into a supply truck is never mistaken for production).
//
// Rates are always per second, averaged over the last LEDGER_WINDOW seconds (four 5-second buckets).
// Inflows are positive, outflows negative; for each good the categories sum to the stock's change.

export const LEDGER_WINDOW = 20;
const BUCKET = 5;

// display order and wording; `in`/`out` say which way the category normally flows
export const LEDGER_CATS = {
  production: { name: 'Production', in: true, desc: 'made by workplaces and settlement hubs' },
  taxes: { name: 'Taxes', in: true, desc: 'paid by your population' },
  commerce: { name: 'Commerce', in: true, desc: 'markets, ports and salvage trade' },
  trade: { name: 'Trade', in: true, desc: 'road and sea links, trade agreements' },
  imports: { name: 'Imports', desc: 'world-market purchases (goods in, credits out)' },
  salvage: { name: 'Salvage', in: true, desc: 'captured or recovered supplies' },
  refunds: { name: 'Refunds', in: true, desc: 'cancelled training or construction' },
  operations: { name: 'Industry inputs', out: true, desc: 'consumed by mills, plants and power stations' },
  population: { name: 'Population', out: true, desc: 'what your people eat' },
  army: { name: 'Army', out: true, desc: 'pay, rations, fuel and ammunition' },
  maintenance: { name: 'Maintenance', out: true, desc: 'building upkeep and repairs' },
  construction: { name: 'Construction', out: true, desc: 'buildings, roads and fieldworks' },
  training: { name: 'Training', out: true, desc: 'new units and refits' },
  research: { name: 'Era advance', out: true, desc: 'the cost of entering a new era' },
  convoys: { name: 'Supply convoys', out: true, desc: 'loaded into supply trucks (still yours, no longer in the stockpile)' },
  warehouses: { name: 'City warehouses', desc: 'held in or released from city warehouses while freight is limited' },
  diplomacy: { name: 'Diplomacy', desc: 'tribute and peace payments' },
  waste: { name: 'Storage full', out: true, desc: 'production lost because storage is full' },
  unmet: { name: 'Unmet demand', in: true, desc: 'demand that went unpaid because the stock ran out' },
  other: { name: 'Other', desc: 'everything else' },
};

export function book(civ, cat, k, amount) {
  if (!amount || !civ) return;
  const acc = civ.ledgerAcc || (civ.ledgerAcc = {});
  const c = acc[cat] || (acc[cat] = {});
  c[k] = (c[k] || 0) + amount;
}
// a cost paid out of the national stockpile (sign -1) or returned to it (sign +1)
export function bookCost(civ, cat, cost, sign = -1) { for (const k in cost) book(civ, cat, k, sign * cost[k]); }

// once a second: close a bucket every BUCKET seconds and recompute the windowed rates
export function ledgerStep(civ, dt = 1) {
  civ.ledgerT = (civ.ledgerT || 0) + dt;
  if (civ.ledgerT < BUCKET) return;
  const hist = civ.ledgerHist || (civ.ledgerHist = []);
  hist.push({ acc: civ.ledgerAcc || {}, dt: civ.ledgerT });
  civ.ledgerAcc = {}; civ.ledgerT = 0;
  while (hist.length > LEDGER_WINDOW / BUCKET) hist.shift();
  const span = hist.reduce((s, h) => s + h.dt, 0) || 1;
  const rates = {};
  for (const h of hist) for (const [cat, goods] of Object.entries(h.acc)) {
    const r = rates[cat] || (rates[cat] = {});
    for (const [k, v] of Object.entries(goods)) r[k] = (r[k] || 0) + v / span;
  }
  civ.ledger = { window: Math.round(span), rates };
}

// rates for one good: { cat: perSecond } plus the totals
export function ledgerFor(civ, k) {
  const out = { cats: {}, inflow: 0, outflow: 0, net: 0 };
  const r = civ.ledger?.rates || {};
  for (const [cat, goods] of Object.entries(r)) {
    const v = goods[k]; if (!v || Math.abs(v) < 1e-4) continue;
    out.cats[cat] = v; out.net += v; if (v > 0) out.inflow += v; else out.outflow -= v;
  }
  return out;
}

export function ledgerSnapshot(civ) {
  const r = civ.ledger?.rates || {}, rates = {};
  for (const [cat, goods] of Object.entries(r)) { const o = {}; for (const [k, v] of Object.entries(goods)) if (Math.abs(v) >= 0.005) o[k] = +v.toFixed(3); if (Object.keys(o).length) rates[cat] = o; }
  return { window: civ.ledger?.window || 0, rates };
}
