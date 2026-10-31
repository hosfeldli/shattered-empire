// Labor allocation: one deterministic, explainable allocator shared by players, governors and AI.
//  1. feed the city first (farms and ports up to the food target)
//  2. honour the player's locked assignments and disabled buildings
//  3. keep hands free for construction crews when the city has sites
//  4. staff the rest by the city's category priorities (critical > high > normal > low; off = none)
//  5. never put people in a building that cannot run (no inputs, no power, no rare earths):
//     the labor stays available instead
//  6. leftovers go to food when reserves are low, otherwise stay unemployed (and build)
// It is a pure function of the city, so the client can preview an auto-balance before applying it.
import { BUILDINGS } from './constants.js';

export const CATEGORIES = ['food', 'industry', 'research', 'commerce'];
export const PRIORITY = { critical: 4, high: 3, normal: 2, low: 1, off: 0 };
export const CAT_OF = { agri: 'food', industry: 'industry', power: 'industry', science: 'research', commerce: 'commerce' };
export const catOf = (type) => (type === 'port' ? 'food' : CAT_OF[BUILDINGS[type].cat] || 'industry');
export const MODES = {
  balanced: { food: 'critical', industry: 'normal', research: 'normal', commerce: 'normal' },
  growth: { food: 'critical', industry: 'low', research: 'low', commerce: 'high' },
  industry: { food: 'critical', industry: 'high', research: 'low', commerce: 'low' },
  research: { food: 'critical', industry: 'normal', research: 'high', commerce: 'low' },
  commerce: { food: 'critical', industry: 'normal', research: 'low', commerce: 'high' },
};
export const defaultWorkforce = () => ({ mode: 'balanced', prio: { ...MODES.balanced } });

// ctx: { labor, foodTarget, perFood(b), base(b), pool(k), gross(k), powerOk, rareOk, sites, foodLow }
export function allocate(c, blds, ctx) {
  const wf = c.wf || defaultWorkforce();
  const prio = wf.prio || MODES.balanced;
  const plan = new Map(), why = new Map();
  let avail = Math.max(0, ctx.labor | 0);
  const jobB = blds.filter((b) => b.done && BUILDINGS[b.type].jobs && b.state !== 'ruined');
  for (const b of jobB) plan.set(b.id, 0);
  const slots = (b) => BUILDINGS[b.type].jobs[1];
  const runnable = (b) => {
    const d = BUILDINGS[b.type];
    if (d.needs === 'rare' && !ctx.rareOk) return 'rare';
    if (d.power < 0 && ctx.powerOk === false) return 'power';
    if (d.consume) for (const k in d.consume) if (ctx.pool(k) < d.consume[k] * slots(b) * 3 && !(ctx.gross(k) > 0)) return 'input:' + k;
    // storage full for everything it makes: workers are worth more elsewhere
    if (d.produce && ctx.full && Object.keys(d.produce).every((k) => ctx.full(k))) return 'full';
    return '';
  };
  // demand-aware weight: goods being saved for or that downstream industry lacks come first
  const weight = (b) => { let w = ctx.base(b); const d = BUILDINGS[b.type]; if (d.produce && ctx.want) for (const k in d.produce) w += ctx.want(k); return w; };
  // 1. disabled buildings
  for (const b of jobB) if (b.off) why.set(b.id, 'off');
  const usable = jobB.filter((b) => !b.off);
  // 2. locks are the player's word: honoured first (a lock of 0 keeps it empty)
  for (const b of usable) {
    if (b.lock == null) continue;
    const n = Math.min(slots(b), b.lock, avail);
    plan.set(b.id, n); avail -= n;
    why.set(b.id, n < Math.min(slots(b), b.lock) ? 'staff' : 'locked');
  }
  const free = usable.filter((b) => b.lock == null);
  // 3. essential food: farms and ports, most productive first, up to the target
  const foodB = free.filter((b) => catOf(b.type) === 'food' && prio.food !== 'off').sort((a, b2) => ctx.perFood(b2) - ctx.perFood(a) || a.id - b2.id);
  let planned = 0, foodWorkers = 0;
  for (const b of usable) if (b.lock != null && catOf(b.type) === 'food') planned += ctx.perFood(b) * plan.get(b.id);
  for (const b of foodB) {
    if (planned >= ctx.foodTarget || !avail) break;
    const per = Math.max(0.05, ctx.perFood(b));
    const n = Math.min(slots(b), avail, Math.max(1, Math.ceil((ctx.foodTarget - planned) / per)));
    plan.set(b.id, n); avail -= n; planned += per * n; foodWorkers += n;
  }
  c.foodWorkers = foodWorkers;
  // 4. construction crews: hands kept free while the city has sites
  const crew = Math.min(avail, ctx.sites > 0 ? Math.min(3, ctx.sites) : 0);
  avail -= crew;
  // 5. by category priority, then each building's own weight
  // food beyond the target is not a priority: surplus farms only get leftovers (step 6)
  const order = free.filter((b) => catOf(b.type) !== 'food')
    .sort((a, b2) => (PRIORITY[prio[catOf(b2.type)]] ?? 2) - (PRIORITY[prio[catOf(a.type)]] ?? 2) || weight(b2) - weight(a) || a.id - b2.id);
  let takenBy = null;
  for (const b of order) {
    const cat = catOf(b.type);
    if ((PRIORITY[prio[cat]] ?? 2) === 0) { why.set(b.id, 'prio:off'); continue; }
    const block = runnable(b);
    if (block) { why.set(b.id, block); continue; }
    if (!avail) { why.set(b.id, takenBy && takenBy !== cat ? 'prio:' + takenBy : 'staff'); continue; }
    const n = Math.min(slots(b), avail);
    plan.set(b.id, n); avail -= n; takenBy = cat;
    why.set(b.id, n < slots(b) ? 'under' : '');
  }
  avail += crew;
  // 6. leftovers: top up food when reserves are low
  if (ctx.foodLow) for (const b of foodB) { const n = Math.min(slots(b) - plan.get(b.id), Math.max(0, avail - crew)); if (n > 0) { plan.set(b.id, plan.get(b.id) + n); avail -= n; } }
  for (const b of foodB) if (!why.has(b.id)) why.set(b.id, plan.get(b.id) === 0 ? (planned >= ctx.foodTarget ? 'surplus' : 'staff') : plan.get(b.id) < slots(b) ? 'under' : '');
  return { plan, why, unassigned: Math.max(0, avail), crew };
}

// Summary per category for the workforce panel: staffed / positions and the priority.
export function categorySummary(c, blds, plan) {
  const out = {};
  for (const k of CATEGORIES) out[k] = { staffed: 0, slots: 0, prio: (c.wf?.prio || MODES.balanced)[k] };
  for (const b of blds) {
    const d = BUILDINGS[b.type]; if (!b.done || !d.jobs) continue;
    const s = out[catOf(b.type)]; s.slots += d.jobs[1]; s.staffed += plan ? plan.get(b.id) || 0 : b.staffed || 0;
  }
  return out;
}

// Plain-language state of one building's staffing, as shown in its panel and tooltip.
export function staffingText(b, why, defs = BUILDINGS, goodNames = {}) {
  const d = defs[b.type]; if (!d.jobs) return '';
  const n = b.staffed || 0, s = d.jobs[1];
  const head = `${n}/${s} ${d.jobs[0]}s`;
  const catName = { food: 'agriculture', industry: 'industry', research: 'research', commerce: 'commerce' };
  if (why === 'off') return `${head} — disabled by player`;
  if (why === 'locked') return `${head} — locked by player`;
  if (why === 'rare') return `${head} — needs rare earths`;
  if (why === 'power') return `${head} — not enough power`;
  if (why && why.startsWith('input:')) return `${head} — no incoming ${(goodNames[why.slice(6)] || why.slice(6)).toLowerCase()}`;
  if (why === 'prio:off') return `${head} — its category is switched off`;
  if (why && why.startsWith('prio:')) return `${head} — ${catName[why.slice(5)] || why.slice(5)} has higher priority`;
  if (why === 'surplus') return `${head} — not needed: food target met`;
  if (why === 'staff') return `${head} — no workers available`;
  if (why === 'under') return `${head} — understaffed`;
  return `${head} — operating`;
}
