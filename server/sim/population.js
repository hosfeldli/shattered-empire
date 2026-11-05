import { nativeRules, tempo } from './rulesets.js';
// Population ledger. Every city keeps one consistent account of its people:
//   pop        civilians living in the city (they eat, pay tax, can work)
//   reserved   civilians committed to a training queue (not working, not yet soldiers)
//   mil        people from this city now serving in active units
//   labor      pop - reserved: who the workforce allocator can assign
//   recruits   eligible manpower: a share of civilians, never the people that keep the city fed
// Recruiting reserves manpower, completion turns it into soldiers, cancelling returns it,
// demobilising returns most of it, and only casualties are real losses. Nothing is created or
// destroyed except by births, deaths, famine and war.
import { UNITS, BUILDINGS } from './constants.js';
import { dist } from './hex.js';

export const RECRUIT_SHARE = 0.35;      // of civilians eligible for service (policies raise it)
export const DEMOB_RETURN = 0.8;        // share of a disbanded unit's people who go home
const FOOD_PER_PERSON = 0.12;

export function recruitShare(civ) {
  let s = RECRUIT_SHARE;
  if ((!nativeRules(civ) && civ.policies?.has('conscription'))) s += 0.15;
  if ((!nativeRules(civ) && civ.policies?.has('total_war'))) s += 0.1;
  return Math.min(0.6, s);
}

export const labor = (c) => Math.max(0, Math.floor((c.pop || 0) - (c.reserved || 0)));

// Workers the city needs on farms/ports to feed itself (the allocator refines this every tick).
export function essentialWorkers(c) {
  if (c.foodWorkers != null) return c.foodWorkers;
  return Math.max(1, Math.ceil(((c.pop || 0) * FOOD_PER_PERSON) / 0.4));
}

// Manpower available for recruitment without touching the people who keep the city running.
export function recruitable(civ, c) {
  const share = Math.floor((c.pop || 0) * recruitShare(civ)) - (c.reserved || 0);
  const protect = (c.pop || 0) - (c.reserved || 0) - essentialWorkers(c) - 2;   // workforce protection
  return Math.max(0, Math.min(share, Math.floor(protect)));
}

export function recruitBlock(civ, c, men) {
  if (!men || !c) return null;
  const r = recruitable(civ, c);
  if (r >= men) return null;
  return r <= 0 && (c.pop - (c.reserved || 0)) < essentialWorkers(c) + 2 + men ? 'not enough people: the city needs them to stay fed' : 'not enough reserve manpower';
}

export function reserve(c, men) { c.reserved = (c.reserved || 0) + men; }

// training finished: reserved civilians become serving soldiers (or a colonist convoy's settlers)
export function commitTraining(g, c, q, u) {
  const men = q.men ?? 0;
  if (c) { c.reserved = Math.max(0, (c.reserved || 0) - men); c.pop = Math.max(1, c.pop - men); }
  u.home = c ? c.id : -1; u.men = men;
  if (c && !UNITS[u.type].civilian) c.mil = (c.mil || 0) + men;
}

// a queued order cancelled: its manpower goes back to work
export function releaseTraining(c, q) { if (c && q.men) c.reserved = Math.max(0, (c.reserved || 0) - q.men); }

// starting forces and other units that appear without training come from the capital's people
export function enlistExisting(g, civ, u) {
  const c = g.capital(civ); const men = UNITS[u.type].pop || 0;
  u.home = c ? c.id : -1; u.men = men;
  if (c && !UNITS[u.type].civilian) c.mil = (c.mil || 0) + men;
}

function homeOf(g, u) {
  const c = g.cities.get(u.home);
  if (c && c.owner === u.owner) return c;
  let best = null, bd = Infinity;
  for (const x of g.cities.values()) if (x.owner === u.owner) { const d = dist(x.tile, u.tile); if (d < bd) { bd = d; best = x; } }
  return best;
}

// demobilisation: most of the unit's people return to civilian life
export function demobilize(g, u) {
  const men = u.men ?? (UNITS[u.type].pop || 0);
  const home = g.cities.get(u.home);
  if (home && !UNITS[u.type].civilian) home.mil = Math.max(0, (home.mil || 0) - men);
  const dest = homeOf(g, u);
  const back = men * DEMOB_RETURN;
  if (dest) { dest.pop += back; dest.returning = (dest.returning || 0) + back; }
  return { men, back, city: dest };
}

// a unit died: its people are a real loss to the city they came from
export function casualty(g, u) {
  const c = g.cities.get(u.home);
  if (c && !UNITS[u.type].civilian) c.mil = Math.max(0, (c.mil || 0) - (u.men ?? UNITS[u.type].pop ?? 0));
}

// Growth = base x food x stability x housing x development (+ a small-town and post-war recovery).
export function growthRate(g, civ, c, ctx) {
  const pop = Math.max(0.5, c.pop);
  const h = pop / Math.max(1, c.housing);
  // housing is a hard cap: growth slows as homes fill and stops when they are full (people do not
  // move into a city with nowhere to live; build or densify housing to grow)
  const housing = h < 0.85 ? 1 : h < 1 ? (1 - h) / 0.15 : 0;
  // food security: growth needs a surplus; a nation eating into its reserves stops growing before
  // it starves (so population never outruns the farms)
  const food = ctx.starving ? 0 : ctx.foodBalance >= 0 ? (ctx.foodStock > 300 ? 1.25 : 1) : ctx.foodStock > 400 ? 0.4 : 0;
  const stab = c.stability < 15 ? 0.15 : 0.5 + Math.min(1, c.stability / 100);
  let dev = 1 + 0.08 * Math.min(4, civ.age) + (c.tradeConnected ? 0.1 : 0) + (ctx.services ? 0.12 : 0);
  if ((!nativeRules(civ) && civ.policies?.has('martial_law'))) dev *= 0.75;
  if ((!nativeRules(civ) && civ.policies?.has('homesteading')) && g.time - (c.founded || 0) < 300) dev *= 1.5;
  let rate = (0.010 * pop + 0.025) * food * stab * housing * dev;
  // small settlements recover: a town of three with food and room grows steadily
  if (pop < 8 && food > 0 && h < 0.95) rate += 0.05 * Math.min(1, food) * stab;
  // after a war: severely depopulated cities with food, room and peace rebuild faster
  c.peak = Math.max(c.peak || 0, c.pop);
  c.recovering = !ctx.enemyNear && food > 0 && h < 1 && c.pop < c.peak * 0.6 && c.peak > 6;
  if (c.recovering) rate *= 1.8;
  return rate * tempo(g, 'populationGrowth');
}

export function populationStep(g, civ, c, ctx, dt) {
  if (ctx.starving) {
    // famine: people die or leave, but a city never empties completely
    c.pop = Math.max(1, c.pop - 0.012 * c.pop * dt);
    c.growth = -0.012 * c.pop;
  } else {
    const r = growthRate(g, civ, c, ctx);
    c.growth = r;
    c.pop += r * dt;
    // far beyond capacity, overcrowding pushes people out
    if (c.pop > c.housing * 1.25) c.pop = Math.max(c.housing * 1.25, c.pop - 0.01 * c.pop * dt);
  }
  if (c.returning) c.returning = Math.max(0, c.returning - dt * 0.2);
  c.reserved = Math.min(c.reserved || 0, Math.max(0, c.pop - 1));
}

// Overcrowding costs stability in proportion to how far past capacity the city is.
export function crowdingPenalty(c) { const h = c.pop / Math.max(1, c.housing); return h <= 1 ? 0 : Math.min(18, (h - 1) * 60); }

// Migration: people move between connected cities of the same empire towards opportunity, and
// across borders only from misery. Migrants are real people who leave one city for another.
export function migrationStep(g) {
  const cities = [...g.cities.values()].filter((c) => !g.civs[c.owner].isRebel);
  const appeal = (c) => c.stability + (c.foodShort ? -30 : 0) + Math.min(15, (c.housing - c.pop) * 2) - (c.unemployed || 0) * 1.5 + (c.jobsOpen || 0) * 1.5;
  for (const c of cities) c.inMig = 0;
  for (const civ of g.civs) {
    const mine = cities.filter((c) => c.owner === civ.id && (c.tradeConnected || c.capital) && !c.isolated);
    if (mine.length < 2) continue;
    mine.sort((a, b) => appeal(a) - appeal(b));
    const lo = mine[0], hi = mine[mine.length - 1];
    // established cities seed developing ones; nobody leaves a city that needs them to eat
    if (appeal(hi) - appeal(lo) > 12 && lo.pop > 8 && labor(lo) > essentialWorkers(lo) + 3 && hi.pop < hi.housing) {
      const m = Math.min(1.5, lo.pop * 0.04); lo.pop -= m; hi.pop += m; hi.inMig = m;
    }
  }
  for (const a of cities) for (const b of cities) {
    if (a.owner === b.owner || dist(a.tile, b.tile) > 14) continue;
    if (appeal(b) - appeal(a) > 28 && a.pop > 8 && b.pop < b.housing) {
      const m = Math.min(1, a.pop * 0.03); a.pop -= m; b.pop += m; b.inMig = (b.inMig || 0) + m;
      if (g.rng() < 0.3) g.notify(a.owner, `Citizens of ${a.name} are emigrating to ${b.name} (${g.civs[b.owner].name}).`, { kind: 'city', tile: a.tile, quiet: true });
    }
  }
}

// Services that raise a city's growth potential (housing upgrades come through housing itself).
export function hasServices(g, c) {
  for (const b of g.buildings.values()) if (b.cityId === c.id && b.done && b.state !== 'damaged' && (b.type === 'academy' || b.type === 'university' || b.type === 'market')) return true;
  return false;
}
void BUILDINGS;
